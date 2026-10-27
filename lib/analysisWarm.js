// lib/analysisWarm.js — 个股数据后台预热与缓存（20261027d）
// 用户需求：工作台长时间开着后，切个股页不应再现场拉数（与「提前后台缓存数据」要求一致）。
// 现状根因：/api/analysis 每次请求都现打腾讯/东财取 quote/history/profile（getQuote/getHistory 无缓存），
//   已有后台任务只预热自选股「判定」（复用不刷数据）与板块资金（一次性），个股页面数据无预热。
// 方案：① /api/analysis 加 TTL 缓存（交易日盘中 9:15~15:10 内 2 分钟，其余 30 分钟——数据最新性：
//   按类型 TTL + 交易日感知；失败响应不缓存防毒化；附加 cachedAt/cacheAgeSec 字段，原结构不变）；
//   ② 后台预热循环：自选股 ∪ 最近查看（LRU 持久化 data/analysis-warm.json），逐只经本机 HTTP 走同一路由
//   填充缓存，命中即秒回。预热是普通 GET，不强制刷新，频率跟随 TTL，不超外部源合理负载。
'use strict';
const fs = require('fs');
const path = require('path');

const PERSIST = path.join(__dirname, '..', 'data', 'analysis-warm.json');
const FRESH_TTL_TRADING_MS = 2 * 60 * 1000;    // 交易日盘中：2 分钟
const FRESH_TTL_OTHER_MS = 30 * 60 * 1000;     // 盘前/盘后/周末：30 分钟
const MAX_CACHE = 30;                          // 缓存 LRU 上限（key=symbol|range）
const MAX_RECENTS = 12;                        // 最近查看保留数
const MAX_WARM = 20;                           // 单轮预热上限（自选股优先）
const WARM_GAP_MS = 500;                       // 逐只间隔，避免打爆外部源

const cache = new Map();      // key -> { payload, ts }
let recents = loadRecents();
let lastCycleTs = 0;
let cycleRunning = false;
let timer = null;

function loadRecents() {
  try {
    const j = JSON.parse(fs.readFileSync(PERSIST, 'utf8'));
    return Array.isArray(j.recents) ? j.recents.filter(s => typeof s === 'string' && s.trim()).slice(0, MAX_RECENTS) : [];
  } catch (e) { return []; }
}
function saveRecents() {
  try {
    ensureDataDir();
    fs.writeFileSync(PERSIST, JSON.stringify({ recents, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { /* 持久化失败不影响主流程 */ }
}
function ensureDataDir() {
  const dir = path.dirname(PERSIST);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 条目归一化：自选股文件存的是对象 {symbol,name,...}（裸 6 位代码），最近查看存字符串
function normSym(s) {
  if (!s) return '';
  if (typeof s === 'string') return s.trim();
  if (typeof s === 'object') return String(s.symbol || s.code || '').trim();
  return '';
}
// 盘中窗口（本地时刻）：9:15 ~ 15:10
function isTradingSessionNow(d) {
  const t = d.getHours() * 60 + d.getMinutes();
  return t >= 9 * 60 + 15 && t <= 15 * 60 + 10;
}
// TTL：交易日盘中 2 分钟，其余 30 分钟（isTradingDayFn 由 server 传入，法定节假日感知）
function ttlMs(now, isTradingDayFn) {
  const d = now || new Date();
  const tradingDay = isTradingDayFn ? !!isTradingDayFn(localDateStr(d)) : (d.getDay() !== 0 && d.getDay() !== 6);
  return (tradingDay && isTradingSessionNow(d)) ? FRESH_TTL_TRADING_MS : FRESH_TTL_OTHER_MS;
}

/** 读缓存：TTL 内返回带 cachedAt/cacheAgeSec 的 payload（原结构 + 附加字段），过期/缺失返回 null */
function getCached(symbol, range, isTradingDayFn) {
  const key = String(symbol || '') + '|' + (range || '1y');
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.ts;
  if (age > ttlMs(new Date(), isTradingDayFn)) return null;
  cache.delete(key); cache.set(key, hit); // LRU touch
  return Object.assign({}, hit.payload, { cachedAt: hit.ts, cacheAgeSec: Math.round(age / 1000) });
}

/** 写缓存：失败/错误响应不缓存（避免毒化）；LRU 超限淘汰最旧 */
function setCached(symbol, range, payload) {
  if (!payload || payload.error) return false;
  const key = String(symbol || '') + '|' + (range || '1y');
  cache.delete(key); cache.set(key, { payload, ts: Date.now() });
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return true;
}

/** 记录「最近查看」个股（LRU + 持久化），供预热循环覆盖用户实际在看的股票 */
function noteAnalysisRequest(symbol) {
  const s = normSym(symbol);
  if (!s || s === '[object Object]') return;
  recents = [s].concat(recents.filter(x => x !== s)).slice(0, MAX_RECENTS);
  saveRecents();
}

/** 预热一轮：自选股 ∪ 最近查看（去重、自选优先、上限 MAX_WARM），逐只经本机 HTTP 走 /api/analysis 填缓存 */
async function warmCycle({ port, getWatchlist }) {
  if (cycleRunning) return { skipped: true, reason: '上一轮未结束' };
  cycleRunning = true;
  const started = Date.now();
  try {
    let wl = [];
    try { wl = getWatchlist ? (getWatchlist() || []) : []; } catch (e) { wl = []; }
    if (!Array.isArray(wl)) wl = [];
    const list = [];
    for (const s of wl.concat(recents)) {
      const v = normSym(s);
      if (v && v !== '[object Object]' && !list.includes(v)) list.push(v);
    }
    const targets = list.slice(0, MAX_WARM);
    let ok = 0, miss = 0;
    for (const sym of targets) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/analysis/${encodeURIComponent(sym)}?range=1y`);
        if (r.ok) ok++; else miss++;
      } catch (e) { miss++; }
      await new Promise(res => setTimeout(res, WARM_GAP_MS));
    }
    lastCycleTs = Date.now();
    const line = `  [分析预热] ${targets.length} 只（自选 ${wl.length} + 最近 ${recents.length}，去重后）：成功 ${ok} · 失败 ${miss} · 耗时 ${((lastCycleTs - started) / 1000).toFixed(1)}s`;
    console.log(line);
    return { ok, miss, total: targets.length };
  } finally {
    cycleRunning = false;
    if (!lastCycleTs) lastCycleTs = Date.now();
  }
}

/** 预热调度：每分钟 tick，盘中按 2 分钟间隔、其余按 30 分钟间隔触发一轮（首泡延迟 20 秒） */
function startAnalysisWarmScheduler({ port, getWatchlist, isTradingDayFn, intervalMs, firstDelayMs }) {
  if (timer) return;
  const due = () => {
    const d = new Date();
    const tradingDay = isTradingDayFn ? !!isTradingDayFn(localDateStr(d)) : (d.getDay() !== 0 && d.getDay() !== 6);
    const gap = (tradingDay && isTradingSessionNow(d)) ? FRESH_TTL_TRADING_MS : FRESH_TTL_OTHER_MS;
    return Date.now() - lastCycleTs >= gap;
  };
  timer = setInterval(() => {
    if (due()) warmCycle({ port, getWatchlist }).catch(() => {});
  }, intervalMs || 60 * 1000);
  if (timer.unref) try { timer.unref(); } catch (e) { /* 保持进程行为不变 */ }
  setTimeout(() => { warmCycle({ port, getWatchlist }).catch(() => {}); }, firstDelayMs || 20000);
}

function stopAnalysisWarmScheduler() { if (timer) { clearInterval(timer); timer = null; } }
function warmListSnapshot() { return { recents: recents.slice(), cacheKeys: Array.from(cache.keys()), lastCycleTs }; }

module.exports = {
  getCached, setCached, noteAnalysisRequest,
  startAnalysisWarmScheduler, stopAnalysisWarmScheduler, warmCycle, warmListSnapshot,
  // 单测钩子（不对外承诺）
  __test: { ttlMs, isTradingSessionNow, cache, clearAll: () => { cache.clear(); }, PERSIST, FRESH_TTL_TRADING_MS, FRESH_TTL_OTHER_MS },
};
