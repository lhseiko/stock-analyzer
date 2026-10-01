/**
 * 联网搜索 MCP 通用客户端（20260903m 新增 / 20260903n 支持多端点）
 * ----------------------------------------------------------------
 * 背景：原工作台联网搜索走模型内置 enable_search（sfm_plugin_public），
 * 按次计费、无免费额度（≈0.003 元/次）。多家云厂商另提供「联网搜索 MCP」服务，
 * 均为 Streamable HTTP 协议，本模块用同一套 JSON-RPC 流程适配。
 *
 * 已支持端点（endpoint 参数切换）：
 *   - MCP_ENDPOINT（阿里云百炼 WebSearch）：全部用户前 2000 次调用免费（一次性总额度、不重置），
 *     超出 ≈0.029 元/次。Key = 百炼通用 Key（sk-xxx），与模型调用同一把。
 *     【20260903r 免费额度保险】本地持久化「成功调用」计数（data/cache/ali_mcp_quota.json，重启不丢），
 *     计数达到 2000 后不再发起任何网络请求，直接抛错 → 上层自动回退模型内置 enable_search（见 mcpWebSearch）。
 *   - BAIDU_ENDPOINT（百度千帆 AI 搜索）：每日 100 次免费（周期性重置，≈3000 次/月），
 *     超出智能搜索生成 ≈0.008 元/次（限时折扣价）。Key = 千帆 API Key（bce-v3/... 或 Bearer Key）。
 *
 * 本模块把「搜索」从模型内置参数解耦出来：先调 MCP 拿到搜索结果文本，
 * 再由上层注入 prompt、用 modelWeb 纯推理（不带 enable_search）。
 * 这样搜索部分吃厂商免费额度，模型 token 走免费试用/低价模型。
 *
 * 协议：Streamable HTTP MCP（JSON-RPC 2.0）
 *   1) initialize         -> 取 Mcp-Session-Id
 *   2) notifications/initialized
 *   3) tools/list         -> 发现工具名（首次，之后按端点缓存）
 *   4) tools/call         -> 返回搜索结果文本
 *
 * 20261001a 优化（体检 P3b）：
 *   - 会话复用：Mcp-Session-Id + 工具名按「端点+Key」缓存，命中后直接 tools/call（1 次往返，
 *     原 4 次）；服务端会话过期（400/404/410）时清缓存、完整握手后重试一次。
 *   - 总超时守卫：整链路 overallTimeout（默认 25s）兜底，防止 4 段 × 15s 的极端悬挂
 *     占满上层 LLM 的 60s 预算。
 *   - 百度千帆每日免费 100 次本地计数（data/cache/baidu_mcp_daily.json，中国自然日重置），
 *     达限后本地短路抛错 → 上层降级其他搜索通道。
 *   - 错误归一化：超时/网络错误统一为带厂商标识的中文文案，原始错误挂 err.raw。
 */
'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { localDate } = require('./localDate');

const MCP_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
const BAIDU_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/mcp';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TOOL = 'web_search';

// 工具名发现后缓存（同一进程内复用，省一次 tools/list 往返）
// 不同厂商工具名不同（阿里 web_search / 百度 ai_search 等），必须按 endpoint 隔离
const cachedToolNameByEp = Object.create(null);

// MCP 会话复用缓存（20261001a）：endpoint+apiKey → { sessionId, toolName }。
// initialize/initialized/tools/list 三段握手只在会话缺失时做；服务端把会话回收
// （tools/call 返回 400/404/410）时清缓存重新完整握手。换 Key 也会自然失配重新握手。
const mcpSessionCache = new Map();

// ── 阿里百炼 MCP 免费额度保险（20260903r 新增，仅对 MCP_ENDPOINT 生效）──────────
// 免费额度为一次性总额度（前 2000 次成功调用免费、不重置），本模块本地持久化计数：
//   - 每次【成功】取回搜索结果计数 +1（失败调用不计，落盘 data/cache/ali_mcp_quota.json，重启不丢）；
//   - 计数达到 ALI_QUOTA_LIMIT 后不再发起任何网络请求，直接抛特定错误 →
//     上层 callLLM 的现有 catch 自动回退模型内置 enable_search，功能不中断、不再产生费用；
//   - 计数达 ALI_QUOTA_WARN_AT 起每次成功调用都打日志提醒；
//   - 若服务端明确返回「额度用尽/欠费」类错误（本地计数可能少于真实用量，例如用户在
//     阿里云控制台手动测试过），把计数锁定为上限兜底，后续调用全部本地短路。
//   - 手动把 JSON 里 count 改小或删除该文件即可重新计数。
const ALI_QUOTA_LIMIT = 2000;
const ALI_QUOTA_WARN_AT = 1800;
const ALI_QUOTA_FILE = path.join(__dirname, '..', 'data', 'cache', 'ali_mcp_quota.json');
// 服务端「额度用尽/欠费」信号特征（同时排除限流类误报——限流是暂时的，不能永久锁死通道）
const ALI_QUOTA_EXHAUSTED_RE = /(free\s*quota[^a-z]{0,40}(exhaust|used\s*up|deplet)|额度[^。]{0,10}(用尽|耗尽|已用完)|欠费|arrearage)/i;
const ALI_QUOTA_RATE_RE = /(throttl|rate\s*limit|too\s*many|频率|429)/i;

let gAliQuotaCache = null;  // 进程内缓存，避免每次成功调用都读盘
let gAliQuotaMtime = 0;     // 文件 mtime，外部手改文件后自动重载

function loadAliQuotaState() {
  try {
    const st = fs.statSync(ALI_QUOTA_FILE);
    if (gAliQuotaCache && st.mtimeMs === gAliQuotaMtime) return gAliQuotaCache;
    const j = JSON.parse(fs.readFileSync(ALI_QUOTA_FILE, 'utf8'));
    gAliQuotaCache = {
      count: Math.max(0, parseInt(j.count, 10) || 0),
      updatedAt: j.updatedAt || '',
    };
    gAliQuotaMtime = st.mtimeMs;
  } catch (_) {
    if (!gAliQuotaCache) gAliQuotaCache = { count: 0, updatedAt: '' };
  }
  return gAliQuotaCache;
}

function saveAliQuotaState(state) {
  try {
    fs.mkdirSync(path.dirname(ALI_QUOTA_FILE), { recursive: true });
    const payload = {
      _note: '阿里百炼联网搜索MCP免费额度本地计数：每次成功调用+1，达到2000自动回退内置enable_search。手动改小count或删除本文件即重新计数。',
      count: state.count,
      limit: ALI_QUOTA_LIMIT,
      updatedAt: state.updatedAt,
    };
    fs.writeFileSync(ALI_QUOTA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    try { gAliQuotaMtime = fs.statSync(ALI_QUOTA_FILE).mtimeMs; } catch (_) {}
  } catch (e) {
    console.warn('[ali-mcp-quota] 计数落盘失败（不影响本次搜索）：', e && e.message);
  }
}

// 检查错误信息是否为服务端「额度用尽/欠费」信号 → 本地计数锁定为上限
function latchAliQuotaIfExhausted(err) {
  try {
    // 20261001a：错误经 normalizeMcpError 包装后 response 挂在 err.raw 上，两边都检查
    let msg = (err && err.message) || '';
    const orig = (err && err.raw) || err;
    const rd = (orig && orig.response && orig.response.data) || (err && err.response && err.response.data);
    if (rd) msg += ' ' + (typeof rd === 'string' ? rd : JSON.stringify(rd));
    if (ALI_QUOTA_EXHAUSTED_RE.test(msg) && !ALI_QUOTA_RATE_RE.test(msg)) {
      const st = loadAliQuotaState();
      if (st.count < ALI_QUOTA_LIMIT) {
        st.count = ALI_QUOTA_LIMIT;
        st.updatedAt = new Date().toISOString();
        saveAliQuotaState(st);
        console.warn('[ali-mcp-quota] 服务端返回额度用尽/欠费信号，本地计数锁定为上限，后续自动回退内置联网搜索');
      }
    }
  } catch (_) { /* 保险逻辑自身异常绝不影响主流程 */ }
}

// 对外暴露额度状态（/api/ai/config 展示用），不泄露文件路径
function getAliMcpQuotaState() {
  const st = loadAliQuotaState();
  return { count: st.count, limit: ALI_QUOTA_LIMIT, warnAt: ALI_QUOTA_WARN_AT, updatedAt: st.updatedAt };
}

// ── 百度千帆 MCP 每日免费额度计数（20261001a，仅对 BAIDU_ENDPOINT 生效）──────────
// 百度 AI 搜索每日 100 次免费、周期性重置（区别于阿里的一次性总额度）。
// 用中国自然日（localDate）做重置边界，避免 UTC 跨日错位；达到上限后本地短路抛错 →
// 上层降级其他搜索通道，不产生计费调用。手动改小 JSON 里的 count 或删除文件即可重置。
const BAIDU_DAILY_LIMIT = 100;
const BAIDU_DAILY_FILE = path.join(__dirname, '..', 'data', 'cache', 'baidu_mcp_daily.json');
let _baiduDaily = null;

function loadBaiduDaily() {
  const today = localDate();
  if (_baiduDaily && _baiduDaily.date === today) return _baiduDaily;
  try {
    const j = JSON.parse(fs.readFileSync(BAIDU_DAILY_FILE, 'utf8'));
    _baiduDaily = (j && j.date === today)
      ? { date: today, count: Math.max(0, parseInt(j.count, 10) || 0) }
      : { date: today, count: 0 };
  } catch (_) {
    _baiduDaily = { date: today, count: 0 };
  }
  return _baiduDaily;
}

function saveBaiduDaily(st) {
  try {
    fs.mkdirSync(path.dirname(BAIDU_DAILY_FILE), { recursive: true });
    fs.writeFileSync(BAIDU_DAILY_FILE, JSON.stringify({
      _note: '百度千帆 AI 搜索 MCP 每日免费额度本地计数：成功调用+1，每日(中国自然日)自动重置，上限 100 次/天。手动改小 count 或删除本文件即可重置。',
      date: st.date,
      count: st.count,
      limit: BAIDU_DAILY_LIMIT,
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[baidu-mcp-daily] 计数落盘失败（不影响本次搜索）：', e && e.message);
  }
}

// 对外暴露额度状态（与 getAliMcpQuotaState 同级的只读视图），不泄露文件路径
function getBaiduMcpDailyState() {
  const st = loadBaiduDaily();
  return { count: st.count, limit: BAIDU_DAILY_LIMIT, date: st.date };
}

function parseSSE(raw) {
  if (typeof raw !== 'string') return [raw];
  const out = [];
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const json = t.slice(5).trim();
        if (!json) continue;
        try { out.push(JSON.parse(json)); } catch (_) { /* 跳过非 JSON 行 */ }
      }
    }
  }
  return out;
}

function extractText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n\n');
}

// 从 JSON-RPC 响应集合中按 id 取出对应事件
function pickEvent(events, id) {
  const arr = Array.isArray(events) ? events : [events];
  return arr.find((e) => e && e.id === id) || arr[arr.length - 1] || null;
}

/** 错误归一化（20261001a）：超时/网络错误统一为带厂商标识的中文文案，原始错误挂 err.raw */
function normalizeMcpError(e, label) {
  const rawMsg = String((e && e.message) || e);
  if (e && e.mcpInternal) return e;        // 本模块自产文案（总超时等），不再二次包装
  if (rawMsg.startsWith(label)) return e;  // 已带厂商标识的内部错误（返回异常/未返回文本）
  let msg;
  if (e && (e.code === 'ECONNABORTED' || /timeout/i.test(rawMsg))) {
    msg = `${label} 请求超时，请稍后重试`;
  } else {
    msg = `${label} 调用失败：` + rawMsg.slice(0, 200);
  }
  const err = new Error(msg);
  err.mcpInternal = true;
  err.raw = e;
  return err;
}

/** 完整三段握手：initialize → initialized 通知 → tools/list（工具名沿用端点级缓存） */
async function _mcpHandshake(endpoint, headers, timeout) {
  // 1) initialize
  const initResp = await axios.post(
    endpoint,
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'stock-analyzer', version: '1.0.0' },
      },
    },
    { headers, timeout }
  );
  const h = initResp.headers || {};
  const sessionId = h['mcp-session-id'] || h['Mcp-Session-Id'];
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  // 2) initialized 通知（无 id，服务端返回 202）
  await axios.post(
    endpoint,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { headers, timeout }
  );

  // 3) tools/list（发现真实工具名，按端点缓存复用）
  let toolName = cachedToolNameByEp[endpoint] || DEFAULT_TOOL;
  if (!cachedToolNameByEp[endpoint]) {
    try {
      const listResp = await axios.post(
        endpoint,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { headers, timeout }
      );
      const listPayload = listResp.data;
      const listEvents = typeof listPayload === 'string' ? parseSSE(listPayload) : listPayload;
      const listEvent = pickEvent(listEvents, 2);
      const tools = (listEvent && listEvent.result && Array.isArray(listEvent.result.tools))
        ? listEvent.result.tools : [];
      const found = tools.find((t) => t && /search|web/i.test(t.name || ''));
      if (found) { toolName = found.name; cachedToolNameByEp[endpoint] = toolName; }
    } catch (_) {
      // 发现失败则回退默认名
      toolName = DEFAULT_TOOL;
    }
  }
  return { sessionId: sessionId || null, toolName };
}

/** 单次 tools/call 并解析出结果文本 */
async function _mcpToolsCall(endpoint, headers, timeout, toolName, q, maxResults, label) {
  const callResp = await axios.post(
    endpoint,
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: toolName, arguments: { query: q.slice(0, 500), max_results: maxResults } },
    },
    { headers, timeout }
  );

  const callPayload = callResp.data;
  const callEvents = typeof callPayload === 'string' ? parseSSE(callPayload) : callPayload;
  const callEvent = pickEvent(callEvents, 3);
  if (!callEvent || !callEvent.result) {
    throw new Error(`${label} 返回异常：` + JSON.stringify(callEvent || callPayload).slice(0, 200));
  }
  const text = extractText(callEvent.result);
  if (!text.trim()) throw new Error(`${label} 未返回有效文本`);
  return text.slice(0, 8000);
}

/**
 * 调用联网搜索 MCP（阿里百炼 / 百度千帆通用），返回拼接后的搜索结果文本。
 * 20261001a：会话复用（缓存 sessionId+toolName，命中时 1 次往返）+ 总超时守卫 + 错误归一化。
 * @param {string} apiKey 对应厂商的 API Key（阿里=百炼通用 Key sk-xxx；百度=千帆 Key）
 * @param {string} query 搜索词
 * @param {Object} [opts]
 * @param {number} [opts.maxResults=8]
 * @param {number} [opts.timeout=15000] 单次 HTTP 请求超时
 * @param {number} [opts.overallTimeout=25000] 整链路总超时（含完整握手的最坏情况）
 * @param {string} [opts.endpoint=MCP_ENDPOINT] MCP 端点，默认阿里百炼；百度传 BAIDU_ENDPOINT
 * @param {string} [opts.label='联网搜索 MCP'] 报错文案里的厂商标识
 * @returns {Promise<string>}
 */
async function mcpWebSearchRaw(apiKey, query, {
  maxResults = 8,
  timeout = 15000,
  overallTimeout = 25000,
  endpoint = MCP_ENDPOINT,
  label = '联网搜索 MCP',
} = {}) {
  if (!apiKey) throw new Error(`缺少 API Key（${label} 需要对应厂商的 API Key）`);
  const q = (query || '').toString().trim();
  if (!q) throw new Error('搜索词为空');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };

  const run = async () => {
    const cacheKey = endpoint + '|' + apiKey;
    const cached = mcpSessionCache.get(cacheKey);
    if (cached && cached.sessionId) {
      // 会话复用：直接 tools/call（1 次往返）
      headers['Mcp-Session-Id'] = cached.sessionId;
      try {
        return await _mcpToolsCall(endpoint, headers, timeout, cached.toolName, q, maxResults, label);
      } catch (e) {
        // 任何失败都先让会话缓存失效（换 Key/会话被回收均覆盖）；仅对「会话失效类」
        // 状态码（400/404/410）走完整握手重试一次，网络/超时类错误直接上抛。
        mcpSessionCache.delete(cacheKey);
        delete headers['Mcp-Session-Id'];
        const status = e && e.response && e.response.status;
        if (!(status === 400 || status === 404 || status === 410)) throw e;
      }
    }
    const hs = await _mcpHandshake(endpoint, headers, timeout);
    const text = await _mcpToolsCall(endpoint, headers, timeout, hs.toolName, q, maxResults, label);
    if (hs.sessionId) mcpSessionCache.set(cacheKey, { sessionId: hs.sessionId, toolName: hs.toolName });
    return text;
  };

  // 总超时守卫：握手 3 段 + 调用整体不超 overallTimeout，防止 4 段 × timeout 的极端悬挂
  let timer = null;
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} 总超时（${overallTimeout}ms），放弃本次搜索`);
          err.mcpInternal = true;
          reject(err);
        }, overallTimeout);
      }),
    ]);
  } catch (e) {
    throw normalizeMcpError(e, label);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 带免费额度保险的搜索入口（20260903r 阿里总额度保险 / 20261001a 百度每日计数）。
 * 阿里：调用前查本地计数（≥2000 直接短路抛错，不发任何请求）→ 成功计数 +1 落盘 →
 *       失败检查是否服务端「额度用尽/欠费」信号并兜底锁定。
 * 百度：每日 100 次免费（中国自然日重置），达限短路抛错；成功计数 +1 落盘。
 * 短路抛出的错误由上层 callLLM 的现有 catch 捕获，自动降级纯推理 / 回退其他通道。
 */
async function mcpWebSearch(apiKey, query, opts = {}) {
  const endpoint = opts.endpoint || MCP_ENDPOINT;
  if (endpoint === MCP_ENDPOINT) {
    const st = loadAliQuotaState();
    if (st.count >= ALI_QUOTA_LIMIT) {
      // 免费额度已用尽：本地直接短路，不花一分钱、不发任何请求
      throw new Error(`阿里百炼 MCP 免费额度已用尽（本地成功调用计数 ${st.count}/${ALI_QUOTA_LIMIT}），自动回退内置联网搜索`);
    }
  } else if (endpoint === BAIDU_ENDPOINT) {
    const st = loadBaiduDaily();
    if (st.count >= BAIDU_DAILY_LIMIT) {
      // 今日免费次数已用完：本地直接短路，不产生计费调用
      throw new Error(`百度千帆 MCP 今日免费 ${BAIDU_DAILY_LIMIT} 次已用完（本地计数 ${st.count}），自动降级其他搜索通道`);
    }
  }
  try {
    const text = await mcpWebSearchRaw(apiKey, query, opts);
    if (endpoint === MCP_ENDPOINT) {
      const st = loadAliQuotaState();
      st.count += 1;
      st.updatedAt = new Date().toISOString();
      saveAliQuotaState(st);
      if (st.count >= ALI_QUOTA_WARN_AT || st.count % 50 === 0) {
        console.log(`[ali-mcp-quota] 阿里 MCP 免费额度累计成功调用 ${st.count}/${ALI_QUOTA_LIMIT} 次`);
      }
    } else if (endpoint === BAIDU_ENDPOINT) {
      const st = loadBaiduDaily();
      st.count += 1;
      saveBaiduDaily(st);
      if (st.count >= BAIDU_DAILY_LIMIT - 10 || st.count % 20 === 0) {
        console.log(`[baidu-mcp-daily] 百度 MCP 今日成功调用 ${st.count}/${BAIDU_DAILY_LIMIT} 次`);
      }
    }
    return text;
  } catch (e) {
    if (endpoint === MCP_ENDPOINT) latchAliQuotaIfExhausted(e);
    throw e;
  }
}

module.exports = { mcpWebSearch, getAliMcpQuotaState, getBaiduMcpDailyState, MCP_ENDPOINT, BAIDU_ENDPOINT };
