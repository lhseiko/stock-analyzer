/**
 * lib/moduleSync.js —— 模块联动应答机制（20261024h）
 * =====================================================================
 * 用户需求（2026-10-24）：对所有联动模块添加应答机制——源模块发生变动时，
 * 自动向依赖它的联动模块发送「同步/失效」信号，避免各模块缓存各自为政、
 * 出现「首页一个值、个股页另一个值」这类同屏矛盾。
 *
 * 设计原则（不破坏既有口径）：
 *  1) 只做「通知 + 失效」，不改任何模块的计算口径（输出格式铁律①）。
 *  2) 失效句柄可选：有内存缓存的模块注册 onInvalidate 真正清缓存；
 *     无缓存/按需计算的模块不注册——信号照常记录（表示“上游变了，下游下次计算自然取新值”），
 *     绝不臆造一个假的失效动作。
 *  3) 错误隔离：任一处理器抛错只记录，不影响其他联动模块，也不回抛给源模块。
 *  4) 环路安全：BFS + visited，依赖图出现环也不会死循环。
 *  5) 合并去抖：同一 (source, date, symbols) 在 COALESCE_MS 内只发一次，
 *     避免一次刷新里多个入口重复失效（可用 ctx.force 强制重发）。
 *  6) 透明可查：getGraph()/getRecentSignals() 供 /api/module-sync/* 观测，
 *     用户能看到「谁变了、通知了谁、谁真的失效了几条」。
 *
 * 传递示例：manualZones 变动 → priceActionHub（丢快照）→ sameDayJudgment（作废判断）
 *   因为个股判断的 technicalShort/levelHints 消费价格行为快照，手动区间变了必须连带重算。
 */
'use strict';

const COALESCE_MS = 3000;
const MAX_LOG = 200;

// ===================== 依赖图（source -> 直接联动模块） =====================
// 语义：source 变动 → 列出的模块需要同步（再沿它们的 dependents 继续传递）。
// 注意：marketEmotion → sameDayJudgment 由 lib/sameDayJudgment._emotionSubStale 做「按分值变化懒同步」，
// 不走 eager 广播（首页每次加载都会重算情绪，eager 失效会无谓抖动）；此处声明关系供观测。
const DEPENDENTS = {
  quoteBars:       ['priceActionHub', 'volumeEngine', 'zoneValidity', 'capitalFlow', 'sameDayJudgment', 'deepAnalysis', 'valuation'],
  priceActionHub:  ['sameDayJudgment'],
  manualZones:     ['priceActionHub'],       // → 传递到 sameDayJudgment
  marketEmotion:   ['sameDayJudgment'],      // 懒同步（_emotionSubStale 门控）
  eventEngine:     ['sameDayJudgment', 'deepAnalysis'],
  dedicatedFactor: ['sameDayJudgment'],
  capitalFlow:     ['sameDayJudgment'],
  sectorMarket:    ['sameDayJudgment'],
  earnings:        ['sameDayJudgment'],      // 财报解读更新
  volumeEngine:    [],
  zoneValidity:    [],
  sameDayJudgment: [],
  deepAnalysis:    [],
  valuation:       [],
};

const MODULE_INFO = {
  quoteBars:       '行情/K线（根基数据源）',
  priceActionHub:  '价格行为快照（②卡短期动向/阻力支撑）',
  manualZones:     '手动阻力/支撑区间',
  marketEmotion:   '市场情绪提醒（大盘量能情绪模型）',
  eventEngine:     '事件引擎（新闻→事件→权重再平衡）',
  dedicatedFactor: '专属因子（公司特有事件）',
  capitalFlow:     '资金量能（主力资金/换手率）',
  sectorMarket:    '板块/行业短期走势',
  earnings:        '财报解读（深度分析）',
  volumeEngine:    '量能分析引擎',
  zoneValidity:    '箱体/阻力支撑有效性',
  sameDayJudgment: '当日行情判断（多因子聚合）',
  deepAnalysis:    '深度分析',
  valuation:       '估值模型（专属估值协议）',
};

const handlers = new Map();   // module -> (ctx) => info
const log = [];               // 最近信号
const recent = new Map();     // dedupeKey -> ts
let wiringDone = false;

/** 注册某联动模块的失效句柄（有缓存的模块调用；可选） */
function onInvalidate(module, fn) {
  if (!module || typeof fn !== 'function') return;
  handlers.set(module, fn);
}
const registerHandler = onInvalidate;

function _ctxSymbols(ctx) {
  return (ctx && Array.isArray(ctx.symbols)) ? ctx.symbols.map(String) : [];
}
function _dedupeKey(source, ctx) {
  const syms = _ctxSymbols(ctx).slice().sort().join(',');
  return `${source}|${(ctx && ctx.date) || ''}|${syms}`;
}

/**
 * 发送「源模块已变动」信号，自动通知所有（直接 + 间接）联动模块。
 * @param {string} source 源模块名（须在 DEPENDENTS 中）
 * @param {object} ctx { symbols?:string[], date?:string, reason?:string, force?:boolean }
 * @returns {{source:string, skipped:boolean, reason?:string, affected:string[], results:Array}}
 */
function emitChange(source, ctx = {}) {
  ensureDefaultWiring();
  if (!DEPENDENTS[source]) {
    return { source, skipped: true, reason: '未知源模块（未在依赖图登记）', affected: [], results: [] };
  }
  const now = Date.now();
  const key = _dedupeKey(source, ctx);
  const last = recent.get(key);
  if (!ctx.force && last && now - last < COALESCE_MS) {
    return { source, skipped: true, reason: 'coalesced', affected: [], results: [] };
  }
  recent.set(key, now);
  if (recent.size > 800) { // 防无限增长
    for (const [k, ts] of recent) if (now - ts > COALESCE_MS * 4) recent.delete(k);
  }

  // BFS 收集全部受影响的联动模块（含间接）
  const affected = [];
  const visited = new Set([source]);
  const queue = [...(DEPENDENTS[source] || [])];
  while (queue.length) {
    const m = queue.shift();
    if (visited.has(m)) continue;
    visited.add(m);
    affected.push(m);
    for (const d of (DEPENDENTS[m] || [])) if (!visited.has(d)) queue.push(d);
  }

  const results = [];
  const symbols = _ctxSymbols(ctx);
  for (const m of affected) {
    const fn = handlers.get(m);
    let info = null, ok = true, error = null;
    if (typeof fn === 'function') {
      try { info = fn({ ...ctx, symbols, source, module: m }); }
      catch (e) { ok = false; error = (e && e.message) ? e.message : String(e); }
    }
    results.push({ module: m, hasHandler: typeof fn === 'function', ok, error, info: info == null ? null : info });
  }

  const entry = {
    at: new Date().toISOString(),
    source,
    ctx: { symbols: symbols.length ? symbols : null, date: ctx.date || null, reason: ctx.reason || null },
    affected,
    results,
  };
  log.push(entry);
  if (log.length > MAX_LOG) log.shift();
  if (process.env.SA_MODULE_SYNC_LOG === '1') {
    const detail = results.map(r => `${r.module}${r.hasHandler ? '=' + (r.info && r.info.invalidated != null ? r.info.invalidated : 'ok') : '(仅记录)'}`).join(', ');
    console.log(`[ModuleSync] ${source}${ctx.reason ? '（' + ctx.reason + '）' : ''} → ${affected.length ? detail : '无联动模块'}`);
  }
  return { source, skipped: false, affected, results };
}

/** 默认接线：为有内存缓存的模块注册真正的失效句柄（懒 require 避免循环依赖） */
function ensureDefaultWiring() {
  if (wiringDone) return;
  wiringDone = true;

  onInvalidate('priceActionHub', (ctx) => {
    const syms = _ctxSymbols(ctx);
    if (!syms.length) return { invalidated: 0, note: '未给出 symbols，无法按标的清快照缓存' };
    const { invalidateSnapshot } = require('./priceActionHub');
    let n = 0;
    for (const s of syms) { try { invalidateSnapshot(s); n++; } catch (e) {} }
    return { invalidated: n };
  });

  onInvalidate('sameDayJudgment', (ctx) => {
    const syms = _ctxSymbols(ctx);
    if (!syms.length) return { invalidated: 0, note: '未给出 symbols，无法按标的作废判断' };
    const sdj = require('./sameDayJudgment');
    if (typeof sdj.invalidateJudgmentForSymbol !== 'function') return { invalidated: 0, note: 'invalidateJudgmentForSymbol 不可用' };
    let n = 0;
    for (const s of syms) { try { if (sdj.invalidateJudgmentForSymbol(s)) n++; } catch (e) {} }
    return { invalidated: n };
  });

  // volumeEngine / zoneValidity / capitalFlow / deepAnalysis / valuation：无进程内缓存或按需计算，
  // 不注册句柄——信号照常进入日志（下游下次计算自然取到上游新值），不臆造失效动作。
}

/** 依赖图（观测/文档） */
function getGraph() {
  ensureDefaultWiring();
  return {
    modules: Object.keys(MODULE_INFO).map(name => ({
      name, desc: MODULE_INFO[name], dependents: DEPENDENTS[name] || [], hasHandler: handlers.has(name),
    })),
    edges: Object.entries(DEPENDENTS).flatMap(([s, ds]) => (ds || []).map(d => ({ from: s, to: d }))),
  };
}
/** 最近信号（新的在前） */
function getRecentSignals(limit = 20) {
  const n = Math.max(1, Math.min(MAX_LOG, Number(limit) || 20));
  return log.slice(-n).reverse();
}
function stats() {
  ensureDefaultWiring();
  return { modules: Object.keys(MODULE_INFO).length, handlers: handlers.size, signals: log.length };
}
/** 单测用：重置内部状态 */
function _reset() {
  handlers.clear(); log.length = 0; recent.clear(); wiringDone = false;
}

module.exports = {
  emitChange, notify: emitChange,
  onInvalidate, registerHandler,
  ensureDefaultWiring,
  getGraph, getRecentSignals, stats,
  DEPENDENTS, MODULE_INFO, COALESCE_MS,
  _reset,
};
