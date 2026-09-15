/**
 * 个股技术面分析 · 准确率检查（lib/techFaceJudgment.js · 20260914i）
 * --------------------------------------------------------------
 * 目的：给个股页「技术面分析」（价格行为推演）加入独立的事后验证与准确率统计。
 *
 * 与既有机制的关系（关键，避免重复计数）：
 *  · lib/sameDayJudgment.js 的 technicalShort 因子已把「短期方向」间接结算，
 *    但那是用「个股次日涨跌」验证的，属于**短期行情判断模块**的因子命中率。
 *  · 本模块是**技术面模块自身**的准确率：用「未来 5 个交易日累计涨跌」
 *    直接验证 priceAction.shortTerm.direction，口径与「技术面＝短线择时」的定位一致。
 *  · 两者**互不干扰**：本模块独立落盘 data/tech-face/，不读写 data/judgments/。
 *
 * 结算口径（经用户确认）：
 *  · shortTerm.direction ∈ 上行/下行/震荡偏上/震荡偏下/冲高回落/超跌反弹/震荡
 *      → 归一化为 涨/跌/震荡 三态
 *      → 第 HORIZON 个交易日收盘 vs 基准日收盘（默认 5 个交易日）
 *  · 命中判定复用 sameDayJudgment 同源语义：震荡＝实际涨跌绝对值 ≤ 容差；否则方向一致。
 *
 * 存储：data/tech-face/<symbol>.json —— 按**个股**聚合成一个数组文件，
 *       便于「该股技术面历史准确率」快速读取（个股样本天然稀疏，按日分文件会碎片化）。
 */

const fs = require('fs');
const path = require('path');

const { localDate, nextTradingDay, marketClosed } = require('./sameDayJudgment');
const { getHistoryDeep } = require('./stockData');

const DIR = path.join(__dirname, '..', 'data', 'tech-face');
const HORIZON = 5;              // 验证周期（交易日）
const FLAT_TOLERANCE = 1.0;     // 「震荡」命中容差（%），与个股短期判断口径一致
const MAX_KEEP = 500;           // 单股最多保留记录数（防止文件无限增长）

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(symbol) { return path.join(DIR, String(symbol).replace(/[^0-9A-Za-z]/g, '') + '.json'); }

/** 方向归一化：技术面 7 种方向词 → 涨/跌/震荡 三态 */
function normalizeDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/震荡偏上|震荡偏下|震荡|横盘|整理/.test(s)) return '震荡';   // 「震荡偏X」归入震荡（择时上不构成明确方向）
  if (/上行|向上|上涨|走强|反弹|突破/.test(s)) return '涨';
  if (/下行|向下|下跌|走弱|回落|跌破/.test(s)) return '跌';
  return null;
}
function verdictOf(dir) { return dir === '涨' ? '看涨' : dir === '跌' ? '看跌' : dir === '震荡' ? '看震荡' : ''; }

function readAll(symbol) {
  try {
    const arr = JSON.parse(fs.readFileSync(fileFor(symbol), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeAll(symbol, arr) {
  ensureDir();
  const trimmed = arr.slice(-MAX_KEEP);
  fs.writeFileSync(fileFor(symbol), JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

/**
 * 记录一条技术面判断（同一基准日幂等覆盖）。
 * @param {string} symbol
 * @param {object} pa getPriceActionSnapshot() 返回值
 * @param {object} meta { name }
 */
function recordDailyJudgment(symbol, pa, meta = {}) {
  try {
    if (!symbol || !pa || pa.error) return null;
    const st = pa.shortTerm || {};
    const lt = pa.longTerm || {};
    if (!st.direction && !lt.verdict) return null;

    // 基准日：取 K 线最后一根日期（analyzePriceAction 的 meta.range 末段）
    let baseDate = null;
    const range = (pa.meta && pa.meta.range) || '';
    const m = range.match(/(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) baseDate = m[1];
    if (!baseDate) baseDate = localDate();

    const shortDir = normalizeDir(st.direction);
    const rec = {
      symbol: String(symbol),
      name: meta.name || '',
      baseDate,
      targetDate: nextTradingDay(baseDate),   // 便于「过期未结算」检测
      horizon: HORIZON,
      generatedAt: new Date().toISOString(),

      // ---- 待验证：短期方向（技术面核心输出）----
      shortRaw: String(st.direction || ''),
      shortDir,
      shortVerdict: verdictOf(shortDir),
      dirScore: typeof st.dirScore === 'number' ? round(st.dirScore, 2) : null,
      probability: String(st.probability || ''),
      pattern: String(st.pattern || ''),

      // ---- 附带记录：长期定性（不参与本模块结算，供参考）----
      longVerdict: String(lt.verdict || ''),

      // ---- 结算位 ----
      settled: false, actualDir: null, actualChgPct: null, correct: null,
      actualBaseClose: null, actualTargetClose: null, actualTargetDate: null,
      settleError: null,
    };

    const arr = readAll(symbol);
    const i = arr.findIndex(r => r.baseDate === baseDate);
    if (i >= 0) arr[i] = { ...arr[i], ...rec, settled: arr[i].settled, correct: arr[i].correct };
    else arr.push(rec);
    // 已存在的记录若已结算，保留其结算结果，不被覆盖
    writeAll(symbol, arr);
    return rec;
  } catch (e) {
    console.error('[techFaceJudgment] 落盘失败:', e && e.message);
    return null;
  }
}

/**
 * 结算某只股票的全部未结算记录：第 HORIZON 个交易日收盘 vs 基准日收盘。
 */
async function settleSymbol(symbol) {
  const arr = readAll(symbol);
  if (!arr.length) return { changed: 0 };
  let daily = [];
  try { daily = await getHistoryDeep(symbol, 2400); } catch (e) { daily = []; }
  if (!daily || !daily.length) return { changed: 0 };
  const bars = daily.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const idxOf = (d) => bars.findIndex(b => b.date === d);
  const now = new Date();
  const today = localDate(now);
  let changed = 0;

  for (const rec of arr) {
    if (rec.settled || !rec.shortDir) continue;
    const bIdx = idxOf(rec.baseDate);
    if (bIdx < 0) { rec.settleError = '基准日K线缺失'; continue; }
    const tIdx = bIdx + (rec.horizon || HORIZON);
    if (tIdx >= bars.length) continue;                     // 未来数据尚未生成
    const tBar = bars[tIdx];
    if (tBar.date === today && !marketClosed(now)) continue; // 目标日未收盘
    const baseClose = bars[bIdx].close;
    if (baseClose == null || tBar.close == null) continue;
    const chg = (tBar.close - baseClose) / baseClose * 100;
    const actDir = tBar.close > baseClose ? '涨' : (tBar.close < baseClose ? '跌' : '震荡');
    rec.actualDir = actDir;
    rec.actualChgPct = round(chg, 2);
    rec.actualBaseClose = baseClose;
    rec.actualTargetClose = tBar.close;
    rec.actualTargetDate = tBar.date;
    rec.correct = rec.shortDir === '震荡' ? Math.abs(chg) <= FLAT_TOLERANCE : rec.shortDir === actDir;
    rec.settled = true;
    rec.settleError = null;
    changed++;
  }
  if (changed) writeAll(symbol, arr);
  return { changed };
}

/** 结算给定全部股票（symbols 为空则结算目录下所有） */
async function settleAll(symbols) {
  ensureDir();
  let list = symbols;
  if (!list || !list.length) {
    list = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  }
  let changed = 0;
  for (const s of list) {
    try { const r = await settleSymbol(s); changed += r.changed || 0; } catch (e) {}
  }
  return { changed };
}

/** 单只股票的准确率统计 */
function computeAccuracy(symbol, arr) {
  const records = arr || readAll(symbol);
  const withDir = records.filter(r => r.shortDir);
  const settled = withDir.filter(r => r.settled);
  const t = settled.length;
  const c = settled.filter(r => r.correct).length;
  const today = localDate();
  const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
  const byProb = { 高: { t: 0, c: 0 }, 中: { t: 0, c: 0 }, 低: { t: 0, c: 0 } };
  for (const r of settled) {
    if (byDir[r.shortDir]) { byDir[r.shortDir].t++; if (r.correct) byDir[r.shortDir].c++; }
    if (byProb[r.probability]) { byProb[r.probability].t++; if (r.correct) byProb[r.probability].c++; }
  }
  const rate = (p) => (p.t ? round(p.c / p.t * 100, 1) : null);
  return {
    symbol: String(symbol || ''),
    totalRecords: withDir.length,
    settledCount: t,
    correct: c,
    accuracy: t ? round(c / t * 100, 1) : null,
    pendingCount: withDir.filter(r => !r.settled).length,
    overdueCount: withDir.filter(r => !r.settled && r.targetDate && r.targetDate < today).length,
    bullRate: rate(byDir['涨']), bullTotal: byDir['涨'].t,
    bearRate: rate(byDir['跌']), bearTotal: byDir['跌'].t,
    flatRate: rate(byDir['震荡']), flatTotal: byDir['震荡'].t,
    probHighRate: rate(byProb['高']), probHighTotal: byProb['高'].t,
    probMidRate: rate(byProb['中']), probMidTotal: byProb['中'].t,
    probLowRate: rate(byProb['低']), probLowTotal: byProb['低'].t,
    horizonLabel: `未来 ${HORIZON} 个交易日累计涨跌`,
    flatTolerance: FLAT_TOLERANCE,
    source: '本地计算（价格行为推演 shortTerm.direction）+ 腾讯前复权日K验证；命中＝方向一致，「震荡偏上/偏下」归入震荡，震荡以涨跌绝对值 ≤ ' + FLAT_TOLERANCE + '% 计。',
  };
}

/** 全站汇总（所有个股合并） */
function computeGlobalAccuracy() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  let all = [];
  for (const f of files) {
    try { const a = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (Array.isArray(a)) all.push(...a); } catch (e) {}
  }
  const agg = computeAccuracy('__ALL__', all);
  agg.symbolCount = files.length;
  return agg;
}

module.exports = {
  recordDailyJudgment,
  settleSymbol,
  settleAll,
  computeAccuracy,
  computeGlobalAccuracy,
  normalizeDir,
  readAll,
  HORIZON,
  FLAT_TOLERANCE,
  DIR,
};
