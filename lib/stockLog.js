// lib/stockLog.js — 个股行情判断记录（20261025l 起为「个股记录」tab；20261107 升级为行情判断记录）
// 每只个股手动添加「行情判断」：日期 + 涨跌方向(上涨/震荡/下跌) + 判断依据(技术面/消息面/其他) + 备注，
// 落盘 data/stock-log/<6位代码>.json。
//
// 20261108a：新增「涨跌幅判断正确率」自动结算（用户选定「系统按实际涨跌自动判」）。
//   · 口径复用工作台既有 lib/techFaceJudgment.js：FLAT_TOLERANCE=1.0%，腾讯/新浪前复权日K。
//   · 验证日 = 记录日之后的第一个交易日；涨跌幅 = 该日收盘 vs 其前一交易日收盘。
//   · 命中：方向为「震荡」时 |涨跌幅| ≤ 1% 记对；否则用户方向与实际方向一致记对。
//   · 数据未到 / 取数失败 → 诚实标 pending（待验证），不臆造、不进分母。
//   · 未填涨跌方向的记录不纳入正确率统计（用户明确要求）。
//
// 隔离边界（不变）：本模块只做「手动记录 + 模块内自统计」，准确率不写入任何判定记录/
// 因子/评分/回测，不触发任何模块联动；两个下拉允许留空。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'stock-log');
const MAX_TEXT = 2000;
const MAX_PER_STOCK = 500;   // 单股条数上限，防无限膨胀
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 20261107：行情判断结构化枚举（与前端显示名同源）
const DIRECTIONS = ['up', 'sideways', 'down'];          // 上涨 / 震荡 / 下跌
const BASES = ['technical', 'news', 'other'];          // 技术面 / 消息面 / 其他
const VERDICTS = ['correct', 'wrong', 'pending'];      // 对 / 错 / 待验证

// 20261108a：与 lib/techFaceJudgment.js 同源的「震荡」命中容差（%），不另造口径
const FLAT_TOLERANCE = 1.0;
const KLINE_TIMEOUT_MS = 8000;
const KLINE_CACHE_TTL = 10 * 60 * 1000;
const _barsCache = new Map();

// 20261108a：两个下拉非必填——留空/非法值一律存 null，不再强行归一成 震荡/其他
function normDir(v) { return DIRECTIONS.includes(v) ? v : null; }
function normBasis(v) { return BASES.includes(v) ? v : null; }

function fileFor(symbol) {
  const pure = String(symbol || '').replace(/^(sh|sz|bj)/i, '').replace(/\.HK$/i, '').trim();
  return path.join(DIR, `${pure || 'unknown'}.json`);
}
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }

/** 结算字段整体清除（编辑改了日期/方向时调用，避免旧结论挂在新判断上） */
function clearVerdict(it) {
  if (!it) return;
  delete it.verdict; delete it.actualChgPct; delete it.actualDate;
  delete it.baseDate; delete it.actualDirection; delete it.settledAt;
}

// 旧记录兼容：早期只有 text 字段，无 direction/basis；统一归一成新结构（note = text）
function normalizeItem(it) {
  if (!it) return it;
  const direction = DIRECTIONS.includes(it.direction) ? it.direction : null;
  return {
    ...it,
    direction,
    basis: BASES.includes(it.basis) ? it.basis : null,
    note: (it.note != null && it.note !== '') ? it.note : (it.text || ''),
    // 有方向但尚未结算 → pending；无方向 → null（不参与统计、不显示图标）
    verdict: VERDICTS.includes(it.verdict) ? it.verdict : (direction ? 'pending' : null),
  };
}

// ---------- 20261108a：确定性结算纯函数（代码权威，LLM 不参与；可单测直接测） ----------

/** 实际方向（严格按收盘价差符号），与 techFaceJudgment 的 actDir 同源 */
function actualDirection(chgPct) {
  if (typeof chgPct !== 'number' || !isFinite(chgPct)) return null;
  return chgPct > 0 ? 'up' : (chgPct < 0 ? 'down' : 'sideways');
}

/** 单条命中判定；无方向 / 无有效涨跌幅返回 null（不判对错） */
function judge(direction, chgPct) {
  if (!DIRECTIONS.includes(direction)) return null;
  if (typeof chgPct !== 'number' || !isFinite(chgPct)) return null;
  const act = actualDirection(chgPct);
  return direction === 'sideways' ? Math.abs(chgPct) <= FLAT_TOLERANCE : direction === act;
}

/** K 线归一：只保留合法 date + 正数 close，按日期升序；不补点、不插值 */
function normalizeBars(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && DATE_RE.test(String(b.date)) && Number(b.close) > 0 && isFinite(Number(b.close)))
    .map(b => ({ date: String(b.date), close: Number(b.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 取「记录日之后的第一个交易日」验证。
 * 用真实 K 线自行排除周末/节假日，不依赖另一套日历口径。
 * 返回 null = 未到验证日 / 无基准 K 线（诚实待验证）。
 */
function verdictFromBars(bars, dateStr) {
  if (!Array.isArray(bars) || !bars.length || !DATE_RE.test(String(dateStr || ''))) return null;
  const idx = bars.findIndex(b => b.date > dateStr);
  if (idx <= 0) return null;                  // idx=0 表示无基准日 K 线
  const base = bars[idx - 1], target = bars[idx];
  const chgPct = (target.close - base.close) / base.close * 100;
  return {
    chgPct: round(chgPct, 2),
    actualDate: target.date,
    baseDate: base.date,
    actualDirection: actualDirection(chgPct),
  };
}

/** 准确率统计：分母只含「有方向 + 已判定」的记录 */
function computeAccuracy(items) {
  const arr = Array.isArray(items) ? items : [];
  let judged = 0, correct = 0, wrong = 0, pending = 0, noDirection = 0;
  for (const it of arr) {
    if (!it || !DIRECTIONS.includes(it.direction)) { noDirection++; continue; }
    if (it.verdict === 'correct') { judged++; correct++; }
    else if (it.verdict === 'wrong') { judged++; wrong++; }
    else pending++;
  }
  const rate = judged ? Math.round(correct / judged * 1000) / 10 : null;
  return {
    total: arr.length, judged, correct, wrong, pending, noDirection,
    rate, rateText: rate == null ? '—' : rate.toFixed(1) + '%',
    tolerance: FLAT_TOLERANCE,
    caliber: '记录日之后的第一个交易日收盘 vs 其前一交易日收盘；|涨跌幅|≤1% 记震荡，方向一致记对',
  };
}

/** 日K取数（带超时 + 10 分钟缓存）；失败返回 null → 全部保持 pending，绝不臆造 */
async function loadBars(symbol) {
  const key = String(symbol || '');
  const hit = _barsCache.get(key);
  if (hit && Date.now() - hit.ts < KLINE_CACHE_TTL) return hit.bars;
  let timer = null;
  try {
    // 延迟 require：便于单测注入 barsOverride，同时避免模块加载期产生副作用
    const { getHistoryDeep } = require('./stockData');
    const bars = await Promise.race([
      Promise.resolve(getHistoryDeep(symbol, 2400)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('日K取数超时')), KLINE_TIMEOUT_MS); }),
    ]);
    const nb = normalizeBars(bars);
    _barsCache.set(key, { ts: Date.now(), bars: nb });
    return nb;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把结算结果写回文件；返回是否发生写入 */
function applySettlement(symbol, bars) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return false;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return false; }
  if (!Array.isArray(arr)) return false;
  let changed = false;
  for (const it of arr) {
    if (!it) continue;
    // 无涨跌幅判断：清掉可能残留的结算字段，明确不纳入统计
    if (!DIRECTIONS.includes(it.direction)) {
      if (it.verdict || it.actualChgPct != null) { clearVerdict(it); changed = true; }
      continue;
    }
    // 已判定不重算（幂等：前复权数据变动不改写历史结论）
    if (it.verdict === 'correct' || it.verdict === 'wrong') continue;
    const res = verdictFromBars(bars, String(it.date || ''));
    if (!res) {
      if (it.verdict !== 'pending') { it.verdict = 'pending'; changed = true; }
      continue;
    }
    const hit = judge(it.direction, res.chgPct);
    it.verdict = hit ? 'correct' : 'wrong';
    it.actualChgPct = res.chgPct;
    it.actualDate = res.actualDate;
    it.baseDate = res.baseDate;
    it.actualDirection = res.actualDirection;
    it.settledAt = new Date().toISOString();
    changed = true;
  }
  if (!changed) return false;
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { return false; }
}

/**
 * 列表 + 结算 + 准确率（GET /api/stock-log/:symbol 的唯一出口）
 * @param {object} [opts] { barsOverride } 单测注入 K 线，跳过网络
 */
async function settleAndList(symbol, opts = {}) {
  const base = listLog(symbol);
  let items = base.items;
  const need = items.some(it => DIRECTIONS.includes(it.direction)
    && it.verdict !== 'correct' && it.verdict !== 'wrong');
  if (need) {
    const bars = Array.isArray(opts.barsOverride) ? normalizeBars(opts.barsOverride) : await loadBars(symbol);
    if (Array.isArray(bars) && bars.length && applySettlement(symbol, bars)) {
      items = listLog(symbol).items;          // 重新读，保证返回值与落盘一致
    }
  }
  return { ok: true, items, accuracy: computeAccuracy(items), note: base.note };
}

// 列表：按日期正序（日期先后），同日按创建时间正序；前端再做筛选/检索/排序切换
function listLog(symbol) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: true, items: [] };
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const items = (Array.isArray(arr) ? arr : []).slice()
      .map(normalizeItem)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
    return { ok: true, items };
  } catch (e) {
    // 文件损坏按空处理，不崩溃不伪造
    return { ok: true, items: [], note: `记录文件损坏已按空处理：${e.message}` };
  }
}

function addLog(symbol, body) {
  const b = body || {};
  const d = String(b.date || '').trim();
  const note = String(b.note != null ? b.note : b.text || '').trim();
  if (!DATE_RE.test(d)) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!note) return { ok: false, error: '备注不能为空' };
  if (note.length > MAX_TEXT) return { ok: false, error: `备注超长（最多 ${MAX_TEXT} 字）` };
  ensureDir();
  const f = fileFor(symbol);
  let arr = [];
  try { if (fs.existsSync(f)) arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  if (arr.length >= MAX_PER_STOCK) return { ok: false, error: `该个股记录已达上限（${MAX_PER_STOCK} 条），请先清理旧记录` };
  const item = {
    id: 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date: d,
    direction: normDir(b.direction),
    basis: normBasis(b.basis),
    note,
    createdAt: new Date().toISOString(),
  };
  arr.push(item);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  return { ok: true, item };
}

function removeLog(symbol, id) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: false, error: '该个股暂无记录' };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { return { ok: false, error: '记录文件损坏' }; }
  if (!Array.isArray(arr)) return { ok: false, error: '记录文件损坏' };
  const next = arr.filter(x => x && x.id !== id);
  if (next.length === arr.length) return { ok: false, error: '记录不存在或已删除' };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return { ok: true };
}

// 修改记录：按 id 定位，可改日期/方向/依据/备注；
// 20261108a：日期或方向变化时清除旧结算结论，下次读取自动重算（不改则不重算，保持幂等）。
function updateLog(symbol, id, body) {
  const b = body || {};
  const d = String(b.date || '').trim();
  const note = String(b.note != null ? b.note : b.text || '').trim();
  if (!DATE_RE.test(d)) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!note) return { ok: false, error: '备注不能为空' };
  if (note.length > MAX_TEXT) return { ok: false, error: `备注超长（最多 ${MAX_TEXT} 字）` };
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: false, error: '该个股暂无记录' };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { return { ok: false, error: '记录文件损坏' }; }
  if (!Array.isArray(arr)) return { ok: false, error: '记录文件损坏' };
  const it = arr.find(x => x && x.id === id);
  if (!it) return { ok: false, error: '记录不存在或已删除' };
  const newDir = normDir(b.direction);
  const recalc = (it.date !== d || it.direction !== newDir);
  it.date = d;
  it.direction = newDir;
  it.basis = normBasis(b.basis);
  it.note = note;
  if (recalc) clearVerdict(it);
  it.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  return { ok: true, item: normalizeItem(it) };
}

function clearBarsCache() { _barsCache.clear(); }

module.exports = {
  listLog, addLog, removeLog, updateLog, settleAndList,
  DIRECTIONS, BASES, VERDICTS, FLAT_TOLERANCE,
  normalizeItem, normDir, normBasis,
  actualDirection, judge, normalizeBars, verdictFromBars, computeAccuracy, clearBarsCache,
};
