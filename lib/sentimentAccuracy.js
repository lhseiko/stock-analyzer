/**
 * 「市场情绪提醒」准确率记录与事后验证（20260914i）
 * --------------------------------------------------------------
 * 用户需求：「市场情绪提醒模块也有涨跌判断，也要进行准确率记录。」
 *
 * 判断来源：lib/sentimentTurningPoint.js 的 detectTurningPoint()
 *   - level     预警等级：无 / 关注 / 预警 / 强烈预警
 *   - impliedDir 隐含方向：看涨 / 看跌 / 看涨(反弹机会) / 看跌(回调风险) / 震荡
 *
 * 验证口径（用户 20260914i 确认：仅对有方向预警的做次日验证）：
 *   - 仅当 level ∈ {预警, 强烈预警} 且 impliedDir 含明确方向（看涨/看跌）时**留档**；
 *     「无」「关注」以及方向为「震荡」的日期不留档 —— 没有明确判断就无从验证。
 *   - 用**次日上证指数**实际涨跌判命中：看涨 → 次日收盘涨为命中；看跌 → 次日收盘跌为命中。
 *   - 容差：次日涨跌幅 |chg| ≤ 0.5% 视为「震荡」，此时明确方向判断记为**未命中**
 *     （方向性预警却没走出方向，属实质误判，不姑息）。
 *
 * 存储：data/sentiment-accuracy/<baseDate>.json（与 data/sentiment-index/ 分离，避免污染 MSI 序列）
 *
 * ★ 与既有模块的关系（重要）：
 *   sentimentTurningPoint.js 内部已有一套 labelAndLearn（仅对「极值日」打标，用于自适应
 *   extremeZ 阈值调优）。本模块**不替代**它，而是新增一层「面向用户的准确率统计」：
 *   覆盖所有有方向预警的日期（不只极值日），口径与 marketTechJudgment / techFaceJudgment 统一。
 */

const fs = require('fs');
const path = require('path');

const { getHistory } = require('./stockData');
const {
  localDate, nextTradingDay, marketClosed,
} = require('./sameDayJudgment');
const { isTradingDay, previousTradingDay } = require('./cnTradingCalendar');

const DIR = path.join(__dirname, '..', 'data', 'sentiment-accuracy');
const BENCH = { code: 'sh000001', name: '上证指数' };
const FLAT_TOLERANCE = 0.5; // 次日涨跌幅 ≤0.5% 视为震荡

const LEVELS_TO_RECORD = new Set(['预警', '强烈预警']);

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch (e) {} }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }

/**
 * 把隐含方向归一化为 涨 / 跌 / 震荡（与 marketTechJudgment.normalizeDir 同口径）。
 */
function normalizeDir(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (t.includes('看涨')) return '涨';
  if (t.includes('看跌')) return '跌';
  if (t.includes('震荡') || t.includes('中性')) return '震荡';
  if (t.includes('涨')) return '涨';
  if (t.includes('跌')) return '跌';
  return null;
}

/**
 * 判断检测结果是否值得留档。
 */
function shouldRecord(detection) {
  if (!detection) return false;
  const lv = detection.level || '';
  if (!LEVELS_TO_RECORD.has(lv)) return false;
  const dir = normalizeDir(detection.impliedDir);
  return dir === '涨' || dir === '跌';
}

/**
 * 留档一条情绪预警判断（按基准日幂等）。
 * @param {object} detection detectTurningPoint 的返回值
 * @param {object} [meta] { baseDate, indexValue }
 * @returns {object|null} 写入的记录，未留档时返回 null
 */
function recordDailyJudgment(detection, meta = {}) {
  try {
    if (!shouldRecord(detection)) return null;
    // 20261020a 防呆（ERR-20261020-001）：调用方传入的 baseDate 可能落在非交易日
    // （周末/法定节假日）——marketEmotionModel 在上证日线通道瞬时失败时把 baselineDate
    // 兜底为 today，若当天是周末则该值落非交易日；以此留档后，上证无该日 K 线，
    // 结算永远找不到基准日，记录永久卡在「待结算」。留档即回滚到上一个交易日。
    let baseDate = meta.baseDate || localDate();
    let rolledBack = false;
    if (!isTradingDay(baseDate)) {
      baseDate = previousTradingDay(baseDate);
      rolledBack = true;
    }
    ensureDir();
    const file = path.join(DIR, `${baseDate}.json`);
    const prev = readJson(file, null);

    // 幂等：同基准日只保留一条；已结算的记录不被覆盖（否则结算结果会被抹掉）
    if (prev && prev.settled) return prev;
    // 回滚而来的留档不得覆盖回滚目标日的既有记录：数据通道故障日的降级结论
    // （只剩部分因子）不能顶替正常交易日的完整判断，保证台账数据质量。
    if (rolledBack && prev) return prev;

    const dir = normalizeDir(detection.impliedDir);
    const rec = {
      baseDate,
      targetDate: nextTradingDay(baseDate),
      level: detection.level,
      impliedDirRaw: detection.impliedDir,
      dir,
      zScore: detection.zScore != null ? round(detection.zScore, 2) : null,
      indexValue: meta.indexValue != null ? round(meta.indexValue, 3) : null,
      extremeZ: detection.extremeZ != null ? detection.extremeZ : null,
      reason: (detection.reasons || []).length ? detection.reasons[0].text : '',
      reasons: (detection.reasons || []).map(r => r.text),
      benchmark: BENCH,
      horizonLabel: '次日上证指数涨跌',
      flatTolerance: FLAT_TOLERANCE,
      recordedAt: new Date().toISOString(),
      settled: false,
    };
    writeJson(file, rec);
    return rec;
  } catch (e) {
    return null;
  }
}

/**
 * 结算用基准日解析（20261020a，ERR-20261020-001）。
 * 历史留档的 baseDate 可能落在非交易日（周末/法定节假日）——典型成因：
 * marketEmotionModel 在上证日线通道瞬时失败时把 baselineDate 兜底为 today，
 * 若当天是周末则该值落非交易日，上证无该日 K 线，结算 findIndex 恒为 -1，
 * 记录永久卡在「待结算」。非交易日则回滚到上一个交易日。
 * targetDate 不受影响：非交易日 d 的 nextTradingDay(d) 恒等于
 * nextTradingDay(previousTradingDay(d))（两者之间无交易日），已由不变量测试锁定。
 */
function resolveBaseDate(baseDate) {
  if (!baseDate) return baseDate;
  return isTradingDay(baseDate) ? baseDate : previousTradingDay(baseDate);
}

/**
 * 结算单条：用次日上证收盘 vs 基准日收盘。
 */
async function settleRecord(rec) {
  if (!rec || rec.settled) return rec;
  try {
    const hist = await getHistory(BENCH.code, '1y').catch(() => []);
    if (!Array.isArray(hist) || !hist.length) return rec;
    // 20261013f 防呆：历史留档的 targetDate 可能落在休市日（当时交易日历数据缺失，
    // 如 09-25 中秋 / 10-01 国庆），找不到 K 线会永久卡在「待结算」。
    // 若存档 targetDate 不是交易日，则按当前正确日历重算，让脏记录可正常补结算。
    let targetDate = rec.targetDate || nextTradingDay(rec.baseDate);
    if (!isTradingDay(targetDate)) {
      targetDate = nextTradingDay(rec.baseDate);
    }
    const idx = hist.findIndex(h => h.date === targetDate);
    if (idx < 0 || hist[idx].close == null) return rec; // 目标日 K 线未生成
    // 目标日尚未收盘 → 数据未定，不结算
    if (targetDate === localDate() && !marketClosed(new Date())) return rec;
    // 20261020a 防呆（ERR-20261020-001）：与上方 targetDate 防呆对称——历史留档的
    // baseDate 可能落在非交易日（如 2026-10-18 为周日，当日上证日线通道瞬时失败，
    // baselineDate 被兜底成周日本身），上证无该日 K 线，findIndex 恒为 -1 导致
    // 永久卡在「待结算」。基准日非交易日则回滚到上一个交易日后比对。
    const baseIdx = hist.findIndex(h => h.date === resolveBaseDate(rec.baseDate));
    if (baseIdx < 0 || hist[baseIdx].close == null) return rec;
    const baseClose = hist[baseIdx].close;
    const tgtClose = hist[idx].close;
    if (!baseClose) return rec;

    const chg = (tgtClose - baseClose) / baseClose * 100;
    const flat = Math.abs(chg) <= FLAT_TOLERANCE;
    const actualDir = flat ? '震荡' : (chg > 0 ? '涨' : '跌');
    // 口径：明确方向预警 vs 次日实际方向一致即命中；次日走成震荡视为未命中
    const correct = rec.dir === actualDir;

    rec.settled = true;
    rec.settledAt = new Date().toISOString();
    rec.targetClose = round(tgtClose, 2);
    rec.baseClose = round(baseClose, 2);
    rec.actualChgPct = round(chg, 2);
    rec.actualDir = actualDir;
    rec.correct = correct;
    return rec;
  } catch (e) {
    return rec;
  }
}

/**
 * 结算全部未结算记录。
 */
async function settleAll() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let changed = 0;
  for (const f of files) {
    const fp = path.join(DIR, f);
    const rec = readJson(fp, null);
    if (!rec || rec.settled) continue;
    const done = await settleRecord(rec);
    if (done && done.settled) { writeJson(fp, done); changed++; }
  }
  return { settled: changed, accuracy: computeAccuracy() };
}

/**
 * 读取全部记录（按基准日升序）。
 */
function getAllRecords() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const r = readJson(path.join(DIR, f), null);
    if (r) out.push(r);
  }
  return out;
}

/**
 * 聚合统计（口径与 marketTechJudgment.computeAccuracy 一致）。
 */
function computeAccuracy(records) {
  const all = Array.isArray(records) ? records : getAllRecords();
  const settled = all.filter(r => r.settled);
  const correct = settled.filter(r => r.correct).length;
  const today = localDate();
  const pending = all.filter(r => !r.settled);
  const overdue = pending.filter(r => r.targetDate && r.targetDate < today);

  const bucket = () => ({ t: 0, c: 0 });
  const byDir = { 涨: bucket(), 跌: bucket(), 震荡: bucket() };
  const byLevel = { 预警: bucket(), 强烈预警: bucket() };
  for (const r of settled) {
    if (byDir[r.dir]) { byDir[r.dir].t++; if (r.correct) byDir[r.dir].c++; }
    if (byLevel[r.level]) { byLevel[r.level].t++; if (r.correct) byLevel[r.level].c++; }
  }
  const rate = p => (p.t ? round(p.c / p.t * 100) : null);
  // 20261013f：未命中拆分——「震荡未命中」（次日 |chg|≤0.5% 走成震荡）与「方向真错」（次日走出明确方向但相反），
  // 展示层拆开避免 0% 一刀切被误读；结算口径本身不变（震荡仍记未命中）。
  const flatMiss = settled.filter(r => !r.correct && r.actualDir === '震荡').length;
  const dirMiss = settled.filter(r => !r.correct && r.actualDir !== '震荡').length;
  return {
    totalRecords: all.length,
    settledCount: settled.length,
    pendingCount: pending.length,
    overdueCount: overdue.length,
    correct,
    flatMissCount: flatMiss,
    dirMissCount: dirMiss,
    accuracy: settled.length ? round(correct / settled.length * 100) : null,
    bullRate: rate(byDir['涨']),
    bullTotal: byDir['涨'].t,
    bearRate: rate(byDir['跌']),
    bearTotal: byDir['跌'].t,
    flatRate: rate(byDir['震荡']),
    flatTotal: byDir['震荡'].t,
    warnRate: rate(byLevel['预警']),
    warnTotal: byLevel['预警'].t,
    strongRate: rate(byLevel['强烈预警']),
    strongTotal: byLevel['强烈预警'].t,
    horizonLabel: '次日上证指数涨跌',
    flatTolerance: FLAT_TOLERANCE,
    benchmark: BENCH,
    source: '市场情绪提醒（情绪拐点检测）',
  };
}

module.exports = {
  recordDailyJudgment, shouldRecord, normalizeDir,
  settleRecord, settleAll, getAllRecords, computeAccuracy, resolveBaseDate,
  FLAT_TOLERANCE, BENCH, DIR, LEVELS_TO_RECORD,
};
