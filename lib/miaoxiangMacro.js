'use strict';
/**
 * 妙想「宏观 / 行业经济指标」取数客户端
 * --------------------------------------------------------------
 * 对应东方财富妙想 MCP 的 `mx_macro_data` 工具，服务端 HTTP 路径：
 *   POST https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchMacroData
 * 鉴权与 lib/miaoxiang.js 一致（em_api_key 头，复用同一枚 Key）。
 *
 * 返回结构（服务端）：data.dataTables[].table 为「指标ID → [数据来源, 值...]」，
 * headName[0] 固定为「数据来源」，其余为时间列（如 2026-08）；
 * nameMap 给出「指标ID → 中文指标名」，macroAttributeExcelMap 给出单位/来源/频率。
 *
 * 本模块把这套结构归一化为 { tables: [{ headers, series:[{id,name,unit,source,freq,points}] }] }，
 * 便于上层按「指标名关键词」取数，并对网络/业务错误做防御式处理（失败返回 ok:false 而非抛异常）。
 */
const { loadKey } = require('./miaoxiang');

const URL_MACRO = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchMacroData';
const UA_VENDOR = { 'x-open-id-vendor': 'tencent', 'x-open-id-app': 'workbuddy' };

function authHeaders(key) {
  return { 'Content-Type': 'application/json', em_api_key: key, ...UA_VENDOR };
}

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '--' || s === '—') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// 时间列（'2026-08' / '2026-08-01' / '2026'）→ 原样保留字符串键
function isTimeHeader(h) {
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(h || '').trim());
}

/**
 * 归一化服务端响应。
 * @returns {{ok:boolean, tables:Array, message:?string, error:?string}}
 */
function normalize(apiResult) {
  const data = (apiResult && apiResult.data) || {};
  const raw = Array.isArray(data.dataTables) ? data.dataTables : [];
  const tables = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const table = t.table || {};
    const headName = Array.isArray(table.headName) ? table.headName : [];
    const timeHeaders = headName.filter(isTimeHeader);
    const nameMap = t.nameMap || {};
    const attrMap = t.macroAttributeExcelMap || {};
    const series = [];
    for (const id of Object.keys(table)) {
      if (id === 'headName') continue;
      const row = Array.isArray(table[id]) ? table[id] : [];
      // row[0] 为数据来源，其后与 timeHeaders 对齐
      const vals = row.slice(1);
      const points = [];
      timeHeaders.forEach((h, i) => {
        const v = numOrNull(vals[i]);
        if (v != null) points.push({ date: String(h), value: v });
      });
      if (!points.length) continue;
      const attr = attrMap[id] || {};
      series.push({
        id,
        name: String(nameMap[id] || attr.macroName || id),
        unit: String(attr.unit || ''),
        source: String(attr.dataSource || row[0] || ''),
        freq: String(attr.edbRateEnum || ''),
        points, // 服务端已按时间倒序（最新在前）
      });
    }
    if (series.length) {
      tables.push({ title: String(t.title || ''), entityName: String(t.entityName || ''), headers: timeHeaders, series });
    }
  }
  return { ok: tables.length > 0, tables, message: (data.message || null), error: null };
}

/**
 * 查询宏观/行业指标（单次请求，不含队列与重试）。
 * @param {string} query 自然语言问句（含指标名、口径、时间范围）
 */
async function searchMacroOnce(query) {
  const key = loadKey();
  if (!key) return { ok: false, tables: [], error: 'NO_KEY', needAuth: true };
  try {
    const r = await fetch(URL_MACRO, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({
        query,
        toolContext: { callId: 'call_' + Math.random().toString(36).slice(2, 10), userInfo: { userId: 'stock-analyzer' } },
      }),
    });
    const text = await r.text();
    if (r.status === 401) return { ok: false, tables: [], error: 'UNAUTHORIZED', needAuth: true };
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, tables: [], error: 'BAD_JSON' }; }
    const n = normalize(j);
    if (!n.ok) n.error = 'NO_DATA';
    return n;
  } catch (e) {
    return { ok: false, tables: [], error: 'NETWORK:' + (e && e.message) };
  }
}

// ---------- 调用节流队列 ----------
// 服务端对 searchMacroData 有频率敏感：并发或连续调用会返回「没有找到符合条件的数据」（NO_DATA）。
// 因此所有请求串行化并保证最小间隔，配合一次延迟重试，避免把「限流」误判成「无数据」。
const MIN_GAP_MS = 350;
const RETRY_WAIT_MS = 1200;
let queue = Promise.resolve();
let lastCallAt = 0;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function enqueue(task) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { lastCallAt = Date.now(); }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

/**
 * 查询宏观/行业指标（串行排队 + 一次延迟重试）。
 * @param {string} query 自然语言问句
 * @param {{retries?:number}} [opts] retries 默认 1（首次 NO_DATA 时延迟重试一次）
 */
function searchMacro(query, opts = {}) {
  const retries = opts.retries == null ? 1 : opts.retries;
  return enqueue(async () => {
    let last = null;
    for (let i = 0; i <= retries; i++) {
      last = await searchMacroOnce(query);
      if (last.ok || last.error === 'UNAUTHORIZED' || last.error === 'NO_KEY') return last;
      if (i < retries) await sleep(RETRY_WAIT_MS);
    }
    return last;
  });
}

/** 判断结果集中是否含某 EMM 指标 ID（且至少有一个数据点） */
function hasSeriesId(tables, id) {
  for (const t of (tables || [])) {
    for (const s of (t.series || [])) {
      if (s.id === id && s.points && s.points.length) return true;
    }
  }
  return false;
}

/**
 * 依次尝试多组措辞，返回首个满足 matchFn 的结果（命中措辞记录在 matchedQuery）。
 * 妙想的自然语言检索命中率会随措辞变化，多措辞兜底可显著提升取数成功率。
 * @param {string[]} queries 措辞候选（按优先级）
 * @param {(tables:Array)=>boolean} [matchFn] 命中判定
 */
async function searchMacroFor(queries, matchFn) {
  const list = Array.isArray(queries) ? queries : [queries];
  let lastErr = 'NO_MATCH';
  for (const q of list) {
    // 多措辞兜底本身已提供容错，故单条不再重试，避免调用链过长（服务端频率敏感 + 首屏超时约束）
    const r = await searchMacro(q, { retries: 0 });
    if (r.ok && (!matchFn || matchFn(r.tables))) return { ...r, matchedQuery: q };
    if (!r.ok) lastErr = r.error || lastErr;
  }
  return { ok: false, tables: [], error: 'NO_MATCH:' + lastErr };
}

/**
 * 从查询结果中按指标名关键词挑一条序列（全部关键词命中、且排除 exclude 命中）。
 * @param {Array} tables searchMacro().tables
 * @param {string[]} include 必须包含的关键词
 * @param {string[]} [exclude] 命中即排除的关键词
 */
function pickSeries(tables, include, exclude = []) {
  const inc = include.filter(Boolean);
  const exc = exclude.filter(Boolean);
  let best = null;
  for (const t of (tables || [])) {
    for (const s of t.series) {
      if (!inc.every(k => s.name.includes(k))) continue;
      if (exc.some(k => s.name.includes(k))) continue;
      // 优先取数据点更多的（信息量更大）
      if (!best || s.points.length > best.points.length) best = s;
    }
  }
  return best;
}

module.exports = { searchMacro, searchMacroOnce, searchMacroFor, pickSeries, hasSeriesId, normalize, URL_MACRO };
