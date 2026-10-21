/**
 * 大盘技术分析 · 准确率检查（lib/marketTechJudgment.js · 20260914i）
 * --------------------------------------------------------------
 * 目的：给「大盘技术分析」模块加入可事后验证的准确率统计，便于持续提升判断质量。
 *
 * 设计原则（与全局铁律一致）：
 *  1. 代码权威：命中判定全部为确定性 IF-THEN，无 LLM 参与。
 *  2. 口径复用：结算口径与 lib/sameDayJudgment.js 保持同源语义
 *     （震荡＝实际涨跌绝对值 ≤ 容差；方向＝预测方向与实际上涨/下跌方向一致）。
 *  3. 完全隔离：本模块独立落盘 data/market-tech/，**不碰** data/judgments/，
 *     避免污染个股准确率统计（sameDayJudgment 的 getAllRecords 硬编码读 judgments 目录）。
 *  4. 诚实合规：数据不足/未到目标日 → 不结算并显式计入 pending，绝不猜算。
 *
 * 结算口径（经用户确认）：
 *  · 短期方向 step6.shortTerm.direction（看多/看空/震荡）
 *      → 次日收盘 vs 基准日收盘，nextday 口径（与个股短期判断一致）
 *  · 中期方向 step6.midTerm.direction（看多/看空/震荡）
 *      → 第 MID_HORIZON 个交易日收盘 vs 基准日收盘（默认 20 个交易日）
 *  · 融合信号 fused.fusionSignal（强多/偏多/震荡/偏空/强空/反弹/回调风险）
 *      → 额外按 nextday 口径结算，并可做「置信度分桶准确率」
 *
 * 存储：data/market-tech/<基准日>.json（每日一条，含全部指数的判断与结算）
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { getKlineJson } = require('./tklineHost');   // 20261021g：腾讯K线主机族降级
const { localDate, nextTradingDay, marketClosed } = require('./sameDayJudgment');
const { isTradingDay } = require('./cnTradingCalendar');

// ---- 常量 ----
const DIR = path.join(__dirname, '..', 'data', 'market-tech');
const MID_HORIZON = 20;          // 中期验证周期（交易日）
const FLAT_TOLERANCE = 0.5;      // 「震荡」命中容差（%）：指数波动比个股小，容差收紧到 0.5%
// 20261021c：目标日无 K 线时的兜底容忍天数（停牌/数据缺口）。超过则不结算并写 settleError，
// 绝不把「20 天后的 K 线」当成「次日」来结算——那会静默改变验证口径。
const TARGET_FALLBACK_MAX_DAYS = 5;
const SETTLE_MIN_INTERVAL_MS = 3 * 60 * 1000;   // 页面自动结算的最小间隔（避免每次刷新都打网络）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQ_OPTS = { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 10000 };

// 基准指数：以「上证指数」作为大盘结算基准（其余指数为佐证，不单独结算，避免样本虚增）
const BENCH = { code: 'sh000001', name: '上证指数' };

// 模块级状态：自动结算节流时间戳 + 测试注入的日K取数函数
let _lastSettleAt = 0;
let _fetchDaily = fetchIndexDaily;   // 测试可替换，生产恒为 fetchIndexDaily

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function daysBetween(a, b) {
  const t1 = new Date(a + 'T00:00:00').getTime();
  const t2 = new Date(b + 'T00:00:00').getTime();
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(dateStr) { return path.join(DIR, dateStr + '.json'); }

/** 拉取指数日K（腾讯 fqkline，与 lib/marketTechnical.js 同源口径） */
async function fetchIndexDaily(code, count = 320) {
  // 20261021g：主机族降级（ifzq 501 → web.ifzq），否则准确率结算会因取不到上证日K而全部挂起
  const body = await getKlineJson(`/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`, REQ_OPTS);
  const node = body && body.data && body.data[code];
  if (!node) return [];
  const arr = node.day || node.qfqday || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(d => ({ date: String(d[0]), open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5] }))
    .filter(b => b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 方向归一化：把各种词汇映射为 涨/跌/震荡 三态（结算唯一口径） */
function normalizeDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/震荡|横盘|整理|观望|中性/.test(s)) return '震荡';
  if (/看多|偏多|强多|上行|向上|上涨|走强|反弹|多头/.test(s)) return '涨';
  if (/看空|偏空|强空|下行|向下|下跌|走弱|回调|空头/.test(s)) return '跌';
  return null;
}
function verdictOf(dir) {
  return dir === '涨' ? '看涨' : dir === '跌' ? '看跌' : dir === '震荡' ? '看震荡' : '';
}

/**
 * 从 getMarketTechnical() 的结果中抽取「可验证判断」并落盘。
 * 每日仅记一条（同一基准日重复调用则覆盖，保证幂等）。
 * @param {object} mt getMarketTechnical() 返回值
 * @returns {object|null} 落盘记录
 */
function recordDailyJudgment(mt) {
  try {
    if (!mt || !mt.success || !Array.isArray(mt.indices) || !mt.indices.length) return null;
    const sh = mt.indices.find(i => i.code === BENCH.code) || mt.indices[0];
    if (!sh || !sh.step6) return null;

    const baseDate = sh.date || mt.date || localDate();
    const baseClose = typeof sh.lastClose === 'number' ? sh.lastClose : null;
    if (baseClose == null) return null;

    const midRaw = sh.step6.midTerm && sh.step6.midTerm.direction;
    const shortRaw = sh.step6.shortTerm && sh.step6.shortTerm.direction;
    const fused = mt.fused || {};

    const rec = {
      baseDate,                                     // 判断所依据的收盘日
      targetDate: nextTradingDay(baseDate),         // 短期验证目标日（次日）
      midTargetIndex: MID_HORIZON,                  // 中期验证周期（交易日）
      generatedAt: new Date().toISOString(),
      benchCode: BENCH.code,
      benchName: BENCH.name,
      baseClose,

      // ---- 待验证判断（短期）----
      shortRaw: String(shortRaw || ''),
      shortDir: normalizeDir(shortRaw),
      shortVerdict: verdictOf(normalizeDir(shortRaw)),
      shortLogic: (sh.step6.shortTerm && sh.step6.shortTerm.logic) || '',

      // ---- 待验证判断（中期）----
      midRaw: String(midRaw || ''),
      midDir: normalizeDir(midRaw),
      midVerdict: verdictOf(normalizeDir(midRaw)),
      midLogic: (sh.step6.midTerm && sh.step6.midTerm.logic) || '',

      // ---- 融合信号 + 置信度（用于分桶准确率）----
      fusionSignal: String(fused.fusionSignal || ''),
      fusionDir: normalizeDir(fused.fusionSignal),
      confidence: String(fused.confidence || ''),
      positionText: (fused.position && fused.position.finalText) || '',

      // ---- 结算位（初始为空）----
      shortSettled: false, shortActualDir: null, shortActualChgPct: null, shortCorrect: null,
      midSettled: false, midActualDir: null, midActualChgPct: null, midCorrect: null,
      settleError: null,
    };

    ensureDir();
    fs.writeFileSync(fileFor(baseDate), JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  } catch (e) {
    console.error('[marketTechJudgment] 落盘失败:', e && e.message);
    return null;
  }
}

function getRecord(dateStr) {
  try { return JSON.parse(fs.readFileSync(fileFor(dateStr), 'utf8')); } catch (e) { return null; }
}

/** 读取全部记录（仅规范日期文件，排除备份残留） */
function getAllRecords() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (rec && rec.baseDate) out.push(rec);
    } catch (e) {}
  }
  return out;
}

/**
 * 结算一条记录。口径与 sameDayJudgment 同源：
 *   短期：targetDate 收盘 vs baseDate 收盘
 *   中期：baseDate 起第 MID_HORIZON 个交易日收盘 vs baseDate 收盘
 * 数据未就绪 / 未收盘 → 保持未结算（不改写），由 overdueCount 暴露。
 */
async function settleRecord(rec, sharedBars) {
  if (!rec || !rec.baseDate) return rec;
  const now = new Date();
  const today = localDate(now);
  try {
    const bars = Array.isArray(sharedBars) && sharedBars.length ? sharedBars : await _fetchDaily(BENCH.code);
    if (!bars.length) return rec;
    const idxOf = (d) => bars.findIndex(b => b.date === d);
    const baseIdx = idxOf(rec.baseDate);
    if (baseIdx < 0) { rec.settleError = '基准日K线缺失'; return rec; }
    const baseClose = rec.baseClose != null ? rec.baseClose : bars[baseIdx].close;

    // ---------- 短期（次日）----------
    if (!rec.shortSettled) {
      // 20261021c：**不信存储的 targetDate**。历史记录可能由旧口径写入（只跳周末、未跳法定节假日），
      // 于是 targetDate 落在节假日（例：09-24 的次日被记成中秋 09-25、09-30 的次日被记成国庆 10-01）。
      // K 线里永远没有这一天 → 既不结算、又永久计入「过期未结算」——这正是用户报障「老是无法结算」的根因。
      // 口径：短期就是「基准日之后的第一个交易日」，该值只由日历决定，存储值仅在它是交易日时才被采信。
      const authoritative = nextTradingDay(rec.baseDate);
      let targetDate = rec.targetDate && isTradingDay(rec.targetDate) ? rec.targetDate : authoritative;
      if (rec.targetDate !== targetDate) {
        rec.targetDateFixed = { from: rec.targetDate || null, to: targetDate, reason: '原目标日非交易日，按交易日历重算', at: new Date().toISOString() };
        rec.targetDate = targetDate;
      }
      let tIdx = idxOf(targetDate);
      let usedDate = targetDate;
      if (tIdx < 0) {
        // 目标日是交易日但没有 K 线（数据缺口/临时休市）→ 取其后首个有 K 线的交易日，
        // 但只在容忍天数内（TARGET_FALLBACK_MAX_DAYS），否则宁可挂着并写明原因，也不改口径。
        const fIdx = bars.findIndex(b => b.date > targetDate);
        if (fIdx >= 0) {
          const gap = daysBetween(targetDate, bars[fIdx].date);
          if (gap != null && gap <= TARGET_FALLBACK_MAX_DAYS) {
            tIdx = fIdx;
            usedDate = bars[fIdx].date;
            rec.shortTargetFallback = { want: targetDate, used: usedDate, gapDays: gap };
          } else {
            rec.settleError = `目标日 ${targetDate} 无K线，其后首个K线 ${bars[fIdx].date} 相隔 ${gap} 天，超出容忍 ${TARGET_FALLBACK_MAX_DAYS} 天`;
          }
        }
      }
      if (tIdx >= 0) {
        const tBar = bars[tIdx];
        // 目标日尚未收盘则不结算
        if (!(usedDate === today && !marketClosed(now))) {
          const chg = (tBar.close - baseClose) / baseClose * 100;
          const actDir = tBar.close > baseClose ? '涨' : (tBar.close < baseClose ? '跌' : '震荡');
          const correct = rec.shortDir === '震荡'
            ? Math.abs(chg) <= FLAT_TOLERANCE
            : rec.shortDir === actDir;
          rec.shortActualDir = actDir;
          rec.shortActualChgPct = round(chg, 2);
          rec.shortActualDate = usedDate;   // 实际用于结算的交易日（与 targetDate 不同时即走了兜底）
          rec.shortCorrect = !!correct;
          rec.shortSettled = true;
        }
      }
    }

    // ---------- 中期（MID_HORIZON 个交易日后）----------
    if (!rec.midSettled) {
      const midIdx = baseIdx + MID_HORIZON;
      if (midIdx < bars.length) {
        const mBar = bars[midIdx];
        const mDate = mBar.date;
        if (!(mDate === today && !marketClosed(now))) {
          const chg = (mBar.close - baseClose) / baseClose * 100;
          const actDir = mBar.close > baseClose ? '涨' : (mBar.close < baseClose ? '跌' : '震荡');
          const correct = rec.midDir === '震荡'
            ? Math.abs(chg) <= FLAT_TOLERANCE
            : rec.midDir === actDir;
          rec.midActualDir = actDir;
          rec.midActualChgPct = round(chg, 2);
          rec.midCorrect = !!correct;
          rec.midSettled = true;
          rec.midActualDate = mDate;
        }
      }
    }

    if (rec.shortSettled || rec.midSettled) {
      rec.settleError = null;
      ensureDir();
      fs.writeFileSync(fileFor(rec.baseDate), JSON.stringify(rec, null, 2), 'utf8');
    }
    return rec;
  } catch (e) {
    rec.settleError = e && e.message;
    return rec;
  }
}

/** 全量结算，返回最新准确率 */
async function settleAll() {
  const records = getAllRecords();
  let changed = 0;
  // 20261021c：整批只拉一次指数日K（原来每条记录各拉一次，19 条就 19 次网络请求）。
  let sharedBars = null;
  try { sharedBars = await _fetchDaily(BENCH.code); } catch (e) { sharedBars = null; }
  for (const rec of records) {
    const before = (rec.shortSettled ? 1 : 0) + (rec.midSettled ? 1 : 0);
    const after = await settleRecord(rec, sharedBars);
    const nowS = (after.shortSettled ? 1 : 0) + (after.midSettled ? 1 : 0);
    if (nowS > before) changed++;
  }
  return { changed, accuracy: computeAccuracy(getAllRecords()) };
}

/**
 * 20261021c：带节流的自动结算（页面/接口读取前调用）。
 * 用户报障「老是出现无法结算」的直接观感来源之一是：准确率条只**读**不**算**，
 * 只有点开「准确率核对」再手动结算才会推进。这里让读取路径顺带结算，但 3 分钟内不重复打网络。
 */
async function settleIfDue(opts = {}) {
  const now = Date.now();
  if (!opts.force && now - _lastSettleAt < SETTLE_MIN_INTERVAL_MS) {
    return { skipped: true, changed: 0, accuracy: computeAccuracy() };
  }
  _lastSettleAt = now;
  try {
    const r = await settleAll();
    return { skipped: false, ...r };
  } catch (e) {
    console.warn('[marketTechJudgment] 自动结算失败:', e && e.message);
    return { skipped: true, error: e && e.message, changed: 0, accuracy: computeAccuracy() };
  }
}

/**
 * 准确率统计：短期 / 中期 / 融合信号 三套，各自含总体与分方向、分置信度。
 */
function computeAccuracy(records) {
  const recs = (records || getAllRecords());
  const today = localDate();

  function stat(list, getPred, getActual, isSettled, isCorrect) {
    const settled = list.filter(isSettled);
    const t = settled.length;
    const c = settled.filter(isCorrect).length;
    const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
    const byConf = { 高: { t: 0, c: 0 }, 中: { t: 0, c: 0 }, 低: { t: 0, c: 0 } };
    for (const r of settled) {
      const p = getPred(r);
      if (byDir[p]) { byDir[p].t++; if (isCorrect(r)) byDir[p].c++; }
      const cf = r.confidence;
      if (byConf[cf]) { byConf[cf].t++; if (isCorrect(r)) byConf[cf].c++; }
    }
    const rate = (p) => (p.t ? round(p.c / p.t * 100, 1) : null);
    return {
      settledCount: t,
      correct: c,
      accuracy: t ? round(c / t * 100, 1) : null,
      bullRate: rate(byDir['涨']), bullTotal: byDir['涨'].t,
      bearRate: rate(byDir['跌']), bearTotal: byDir['跌'].t,
      flatRate: rate(byDir['震荡']), flatTotal: byDir['震荡'].t,
      confHighRate: rate(byConf['高']), confHighTotal: byConf['高'].t,
      confMidRate: rate(byConf['中']), confMidTotal: byConf['中'].t,
      confLowRate: rate(byConf['低']), confLowTotal: byConf['低'].t,
    };
  }

  // 短期：仅统计有明确方向的判断（无方向则不参与）
  const shortRecs = recs.filter(r => r.shortDir);
  const midRecs = recs.filter(r => r.midDir);
  const fusionRecs = recs.filter(r => r.fusionDir);

  const short = stat(shortRecs, r => r.shortDir, r => r.shortActualDir, r => r.shortSettled, r => r.shortCorrect);
  const mid = stat(midRecs, r => r.midDir, r => r.midActualDir, r => r.midSettled, r => r.midCorrect);
  const fusion = stat(fusionRecs, r => r.fusionDir, r => r.shortActualDir, r => r.shortSettled, r => r.shortCorrect);

  const shortPending = shortRecs.filter(r => !r.shortSettled).length;
  const midPending = midRecs.filter(r => !r.midSettled).length;
  // 20261021c：过期判定用**权威目标日**（存储值非交易日时按日历重算），
  // 否则旧记录里的节假日目标日会一直显示「过期未结算」，看起来永远修不好。
  const effTarget = (r) => (r.targetDate && isTradingDay(r.targetDate)) ? r.targetDate : nextTradingDay(r.baseDate);
  const overdueShort = shortRecs.filter(r => !r.shortSettled && effTarget(r) < today).length;

  return {
    totalRecords: recs.length,
    horizonLabel: `短期=次日 / 中期=${MID_HORIZON}交易日`,
    flatTolerance: FLAT_TOLERANCE,
    short: { ...short, pendingCount: shortPending, overdueCount: overdueShort },
    mid: { ...mid, pendingCount: midPending },
    fusion,
    benchmark: BENCH.name,
    source: '基准：上证指数（腾讯 fqkline 日K，前复权）；命中＝方向一致，震荡以涨跌绝对值 ≤ ' + FLAT_TOLERANCE + '% 计。',
  };
}

module.exports = {
  recordDailyJudgment,
  getAllRecords,
  getRecord,
  settleRecord,
  settleAll,
  computeAccuracy,
  normalizeDir,
  fetchIndexDaily,
  MID_HORIZON,
  FLAT_TOLERANCE,
  TARGET_FALLBACK_MAX_DAYS,
  SETTLE_MIN_INTERVAL_MS,
  settleIfDue,
  DIR,
  // 测试注入：替换指数日K取数（生产不得调用）
  __setFetchDaily: (fn) => { _fetchDaily = typeof fn === 'function' ? fn : fetchIndexDaily; _lastSettleAt = 0; },
};
