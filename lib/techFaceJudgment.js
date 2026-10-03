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

const { localDate, marketClosed } = require('./sameDayJudgment');
const { getHistoryDeep } = require('./stockData');

/**
 * 2026 年 A 股休市日（含法定节假日连休；周末另算）。
 * 来源：上交所《2026 年部分节假日休市安排》（元旦/春节/清明/劳动/端午/中秋/国庆）。
 * 仅覆盖 2026；其它年份该集合为空、退化为周末判断。此表只服务于 targetDate 显示
 * 与 overdue 启发式的口径统一——真实结算用腾讯前复权日 K 实跑（已自然排除节假日），
 * 不受此表影响。引入目的是避免长假（中秋+国庆）把“合法 pending（第 5 交易日=10-08
 * 尚未到）”误报为“过期未结算”（20261002c-2 补强）。
 */
const MARKET_CLOSED_2026 = (function () {
  const s = new Set();
  const add = (a, b) => {
    for (let d = new Date(a + 'T00:00:00'); d <= new Date(b + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
      s.add(localDate(d));
    }
  };
  add('2026-01-01', '2026-01-03'); // 元旦
  add('2026-02-15', '2026-02-23'); // 春节
  add('2026-04-04', '2026-04-06'); // 清明
  add('2026-05-01', '2026-05-05'); // 劳动节
  add('2026-06-19', '2026-06-21'); // 端午
  add('2026-09-25', '2026-09-27'); // 中秋
  add('2026-10-01', '2026-10-07'); // 国庆
  return s;
})();

/** 下一个交易日（跳过周末 + 2026 法定节假日；非 2026 年退化为仅跳过周末） */
function nextTradingDayHL(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = MARKET_CLOSED_2026.has(localDate(d));
    if (!isWeekend && !isHoliday) return localDate(d);
  }
  return dateStr;
}

/**
 * 向前推进 n 个交易日（跳过周末与 2026 法定节假日；与结算引擎“按真实 K 线计数”口径一致）。
 * 用于计算「真实验证目标日」= 基准日 + HORIZON 个交易日（20261002c 修复：此前 overdue 误用
 * base+1；20261002c-2 补强：此前仅跳过周末、未跳过法定节假日，导致长假期间误报过期）。
 */
function addTradingDays(startDate, n) {
  let d = startDate;
  for (let i = 0; i < n; i++) d = nextTradingDayHL(d);
  return d;
}

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
      // 真实验证目标日 = 基准日 + HORIZON 个交易日（此前误用 nextTradingDay(baseDate)=base+1，
      // 验证窗口（5 个交易日）远未到即被误报“过期未结算”；20261002c 修复）
      targetDate: addTradingDays(baseDate, HORIZON),
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
      status: 'pending',          // 结算引擎填充：pending(等待数据) / settled(已结算) / error(基准日K线缺失)
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
 * @param {string} symbol
 * @param {Array} [barsOverride] 测试注入用：跳过网络拉取直接给定 K 线（生产调用不传，走 getHistoryDeep）
 */
async function settleSymbol(symbol, barsOverride) {
  const arr = readAll(symbol);
  if (!arr.length) return { changed: 0 };
  // 目标日归一：未结算记录的 targetDate 始终取「基准日 + HORIZON 个交易日」（含法定节假日，
  // 20261002c-2），纠正旧代码误存的 base+1；返回是否发生变更。
  const normTarget = (rec) => {
    if (!rec.baseDate) return false;
    const want = addTradingDays(rec.baseDate, rec.horizon || HORIZON);
    if (rec.targetDate !== want) { rec.targetDate = want; return true; }
    return false;
  };
  // 标记为 pending（等待数据 / 目标日未到）并同步纠正 targetDate
  const markPending = (rec) => {
    let ch = false;
    if (rec.status !== 'pending') { rec.status = 'pending'; ch = true; }
    if (normTarget(rec)) ch = true;
    return ch;
  };

  let daily = [];
  try { daily = Array.isArray(barsOverride) ? barsOverride : await getHistoryDeep(symbol, 2400); } catch (e) { daily = []; }
  if (!daily || !daily.length) {
    // 数据未拉取成功：无法结算，但仍应把未结算记录显式标为 pending（无 status 时）并纠正陈旧
    // targetDate——即使此前已由旧代码标过 pending（旧版不纠 targetDate）。不动已结算/已标 error
    // 的记录（error 属真实异常，不覆盖）。
    let statusChanged = false;
    for (const rec of arr) {
      if (rec.settled || rec.status === 'error') continue;
      let ch = false;
      if (!rec.status) { rec.status = 'pending'; ch = true; }
      if (normTarget(rec)) ch = true;
      if (ch) statusChanged = true;
    }
    if (statusChanged) writeAll(symbol, arr);
    return { changed: 0, statusChanged };
  }
  const bars = daily.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const idxOf = (d) => bars.findIndex(b => b.date === d);
  const now = new Date();
  const today = localDate(now);
  let changed = 0, statusChanged = false;

  for (const rec of arr) {
    if (rec.settled || !rec.shortDir) {
      if (rec.settled && rec.status !== 'settled') { rec.status = 'settled'; statusChanged = true; }
      continue;
    }
    const bIdx = idxOf(rec.baseDate);
    if (bIdx < 0) {                                            // 基准日 K 线缺失：真实异常，需核查
      if (rec.status !== 'error') { rec.status = 'error'; rec.settleError = '基准日K线缺失'; statusChanged = true; }
      continue;
    }
    const tIdx = bIdx + (rec.horizon || HORIZON);
    if (tIdx >= bars.length) {                                 // 未来数据尚未生成 → 正常等待，非“过期”
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const tBar = bars[tIdx];
    if (tBar.date === today && !marketClosed(now)) {           // 目标日尚未收盘 → 正常等待
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const baseClose = bars[bIdx].close;
    if (baseClose == null || tBar.close == null) {             // 价格缺失 → 继续等待（不属异常）
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const chg = (tBar.close - baseClose) / baseClose * 100;
    const actDir = tBar.close > baseClose ? '涨' : (tBar.close < baseClose ? '跌' : '震荡');
    rec.actualDir = actDir;
    rec.actualChgPct = round(chg, 2);
    rec.actualBaseClose = baseClose;
    rec.actualTargetClose = tBar.close;
    rec.actualTargetDate = tBar.date;
    rec.correct = rec.shortDir === '震荡' ? Math.abs(chg) <= FLAT_TOLERANCE : rec.shortDir === actDir;
    rec.settled = true;
    rec.status = 'settled';
    rec.settleError = null;
    changed++;
    statusChanged = true;
  }
  if (changed || statusChanged) writeAll(symbol, arr);
  return { changed, statusChanged };
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

/**
 * 是否“过期未结算”（需核查的真实异常），20261002c 修复口径（20261002c-2 补强）：
 *  · 已结算 → 否
 *  · status==='settled'/'pending' → 否（pending＝验证窗口未到/数据未出，属正常等待，不再误报“过期”）
 *  · status==='error'/'overdue'   → 是（基准日K线缺失等真实异常）
 *  · 无 status（历史记录/未跑结算）→ 用 baseDate + HORIZON 实时重算真实目标日，
 *        不信任陈旧存储的 targetDate（旧代码曾误存 base+1，导致 09-23~09-29 这类
 *        “第 5 交易日=10-08 尚未到”的合法 pending 记录被误报“过期未结算”）。
 *        重算后真实目标日仍 < today 才判过期（用于 2020 等早就该结算却未结算的真异常）。
 */
function isOverdue(r, today) {
  if (r.settled) return false;
  if (r.status === 'error' || r.status === 'overdue') return true;
  if (r.status === 'pending' || r.status === 'settled') return false;
  // 无 status：实时重算真实目标日（baseDate 缺失时再退化为存储 targetDate）
  if (r.baseDate) {
    const realTarget = addTradingDays(r.baseDate, r.horizon || HORIZON);
    return !!(realTarget && realTarget < today);
  }
  return !!(r.targetDate && r.targetDate < today);
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
    overdueCount: withDir.filter(r => isOverdue(r, today)).length,
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
