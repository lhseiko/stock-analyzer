'use strict';
/**
 * 东方财富「妙想」数据客户端（纯 Node 实现，无需 Python）。
 *
 * 复刻 mx-finance-data / mx-finance-search 两个 Skill 的调用方式：
 *  - 鉴权：POST /api/auth/token/create 拿到 token+authUrl → 用户扫码授权 →
 *          POST /api/auth/token/result 拿到 apiKey，落盘 ~/.mx-skills/em_api_key
 *  - 取数：POST /proxy/b/mcp/tool/searchData  （结构化表格：股东户数/评级/业绩预告/龙虎榜…）
 *          POST /proxy/b/mcp/tool/searchNews   （资讯/研报/公告聚合）
 *  鉴权头统一为 em_api_key + x-open-id-vendor/tenant。
 *
 * 所有函数都对网络/业务错误做防御式处理，失败时返回结构化错误而非抛异常。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

const AUTH_BASE = (process.env.EM_AUTH_BASE || 'https://ai-saas.eastmoney.com').replace(/\/+$/, '');
const SEARCH_API_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchData';
const NEWS_API_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchNews';
const CLIENT_ID = 'mx-finance-data';
const MX_DIR = path.join(os.homedir(), '.mx-skills');
const KEY_PATH = path.join(MX_DIR, 'em_api_key');
const PENDING_PATH = path.join(MX_DIR, 'pending_auth.json');

function loadKey() {
  const env = (process.env.EM_API_KEY || '').trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(KEY_PATH, 'utf8').trim();
    return t || null;
  } catch { return null; }
}

function saveKey(key) {
  fs.mkdirSync(MX_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_PATH, key.trim() + '\n', { mode: 0o600 });
}

function readPending() {
  try {
    const d = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    if (d && d.token && d.expiresAt > Math.floor(Date.now() / 1000)) return d;
  } catch {}
  return null;
}

function writePending(p) {
  fs.mkdirSync(MX_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(p), { mode: 0o600 });
}

function clearPending() {
  try { fs.unlinkSync(PENDING_PATH); } catch {}
}

// 20260917：所有妙想请求统一带超时（默认 15s）。此前 postJson 用全局 fetch 且无限等待，
// 一旦 ai-saas.eastmoney.com 不可达/握手卡住（如工作台更新后网络出口或 MCP 鉴权状态变化），
// callLLM 里的 searchNewsToText 会无限挂起 → 个股「AI 生成亮点/雷点」永久卡在「AI 分析中…」。
// 本环境全局 fetch 是 axios 多填（follow-redirects）实现，自带 60s 内部超时且忽略 AbortSignal，
// Promise.race/AbortController 均无法截断，故改用 axios 直连并显式 timeout，妙想慢/不通会快速失败，
// callLLM 自动回退到阿里百炼 MCP 搜索，功能不中断。
const MIAOXIANG_TIMEOUT_MS = 15000;

async function postJson(url, body, headers, timeoutMs = MIAOXIANG_TIMEOUT_MS) {
  // 关键：本环境全局 fetch 是 axios 多填（follow-redirects）实现，自带 60s 内部超时且
  // 忽略 timeout/AbortSignal。axios 命中 https 时会切到 fetch adapter，导致 timeout:15000 被静默丢弃，
  // 请求会卡到 60s 才以「timeout of 60000ms exceeded」拒绝（且绕过本函数 try/catch）。
  // 因此：① 强制 adapter:'http'（http 适配器原生尊重 timeout）；② 再叠加一个真·Node 计时器兜底，
  // 无论适配器内部如何，到 timeoutMs 必 reject，保证妙想慢/不通时快速失败并回退 MCP 搜索。
  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      const err = new Error('妙想请求超时（' + timeoutMs + 'ms 无响应），已回退其他搜索通道');
      err.timeout = true;
      reject(err);
    }, timeoutMs);
  });
  try {
    const resp = await Promise.race([
      axios({
        method: 'post',
        url,
        data: body,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        timeout: timeoutMs,
        validateStatus: () => true, // 自己处理 401 等状态码，不让 axios 抛错
        maxRedirects: 5,
        adapter: 'http', // 强制 http 适配器，原生尊重 timeout（避免被 fetch 多填的 60s 覆盖）
      }),
      hardTimeout,
    ]);
    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = { raw: data }; }
    }
    return { status: resp.status, data };
  } catch (e) {
    if (e && e.timeout) throw e; // 我方硬超时（已含明确语义），原样抛出
    // 网络层错误（DNS/连接/超时）→ 包装成超时语义，交由上层回退其他搜索通道
    const err = new Error('妙想请求失败（' + (e && e.message || 'unknown') + '），已回退其他搜索通道');
    err.timeout = true;
    err.cause = e;
    throw err;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

async function createAuth() {
  const { data } = await postJson(`${AUTH_BASE}/api/auth/token/create`, { clientId: CLIENT_ID });
  // 响应结构：{ code, status, message, data: { token, authUrl, apiKeyUrl, expiresIn } }
  return (data && data.data) || {};
}

async function pollAuth(token) {
  const { data } = await postJson(`${AUTH_BASE}/api/auth/token/result`, { token });
  // 响应结构：{ code, status, message, data: { state, apiKey } }
  return (data && data.data) || {};
}

function authHeaders(key) {
  return {
    'em_api_key': key,
    'x-open-id-vendor': 'tencent',
    'x-open-id-app': 'workbuddy',
  };
}

function buildBody(query) {
  return {
    query,
    toolContext: {
      callId: 'call_' + crypto.randomBytes(4).toString('hex'),
      userInfo: { userId: 'user_' + crypto.randomBytes(4).toString('hex') },
    },
  };
}

// ---- 鉴权流程 ----

// 开始授权：已有 key 直接返回 authed；否则创建 pending 并返回 authUrl
async function startAuth() {
  const existing = loadKey();
  if (existing) return { authed: true };
  // 复用尚未过期的 pending token，避免每次调用都换新链接导致旧链接失效
  const pending = readPending();
  if (pending && pending.token && pending.authUrl) {
    return { authed: false, authUrl: pending.authUrl, apiKeyUrl: pending.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw', pending: true };
  }
  const created = await createAuth();
  if (!created.token || !created.authUrl) {
    return { authed: false, error: '授权创建失败: ' + JSON.stringify(created).slice(0, 200) };
  }
  const expiresIn = Number(created.expiresIn) || 30 * 24 * 60 * 60;
  writePending({
    token: created.token,
    authUrl: created.authUrl,
    apiKeyUrl: created.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw',
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn - 5,
  });
  return { authed: false, authUrl: created.authUrl, apiKeyUrl: created.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw' };
}

// 查询授权状态：若 pending 已完成则落盘 key
async function getAuthStatus() {
  const existing = loadKey();
  if (existing) { clearPending(); return { authed: true }; }
  const pending = readPending();
  if (!pending) return { authed: false, needStart: true };
  const r = await pollAuth(pending.token);
  if (r.state === 'done' && r.apiKey) {
    saveKey(r.apiKey);
    clearPending();
    return { authed: true };
  }
  if (r.state === 'pending') return { authed: false, authUrl: pending.authUrl, apiKeyUrl: pending.apiKeyUrl };
  clearPending();
  return { authed: false, invalid: true };
}

// ---- 取数 ----

async function searchData(query) {
  const key = loadKey();
  if (!key) {
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const { status, data } = await postJson(SEARCH_API_URL, buildBody(query), authHeaders(key));
  if (status === 401) {
    clearPending();
    try { fs.unlinkSync(KEY_PATH); } catch {}
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const tables = parseTables(data);
  const message = extractMessage(data);
  const bizError = extractBusinessError(data);
  return { tables, message: message || null, error: bizError || null, bizError: !!bizError };
}

async function searchNews(query) {
  const key = loadKey();
  if (!key) {
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const { status, data } = await postJson(NEWS_API_URL, buildBody(query), authHeaders(key));
  if (status === 401) {
    clearPending();
    try { fs.unlinkSync(KEY_PATH); } catch {}
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const content = data?.data?.llmSearchResponse
    || data?.llmSearchResponse
    || data?.data?.content
    || data?.content
    || '';
  const bizError = extractBusinessError(data);
  return { content: typeof content === 'string' ? content : JSON.stringify(content), error: bizError || null, bizError: !!bizError };
}

// ---- 资讯检索 → 干净文本（20260904a：供 aiAugment 注入作东财事实源）----

// 尝试把 searchNews 返回的字符串解析成条目列表（title/content/date）
// 妙想返回的 content 通常是一个 JSON 字符串：{"data":[{code,title,content,date,informationType,jumpUrl,...}]}
function parseNewsItems(content) {
  if (!content || typeof content !== 'string') return [];
  const raw = content.trim();
  // 剥离可能的围栏/前缀，直接尝试 JSON 解析
  try {
    const parsed = JSON.parse(raw);
    const arr = (parsed && (Array.isArray(parsed) ? parsed : (parsed.data || parsed.list || parsed.result || [])));
    if (Array.isArray(arr)) return arr.filter(it => it && typeof it === 'object');
    return [];
  } catch {
    return [];
  }
}

/**
 * 把妙想 searchNews 结果转成可注入模型的可读文本块。
 * @param {string} query 自然语言查询
 * @param {{maxItems?:number, maxChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, text:string, count:number, rawLen:number, source:string}>}
 */
async function searchNewsToText(query, opts = {}) {
  const { maxItems = 8, maxChars = 6000 } = opts;
  const r = await searchNews(query);
  if (r.needAuth || !r.content) {
    // 20260921g：把业务错误（如「积分已用完」）透出给调用方，避免静默降级成「无数据」
    return { ok: false, text: '', count: 0, rawLen: 0, source: '东方财富妙想AI', error: r.error || null, bizError: !!r.bizError };
  }
  const raw = String(r.content);
  const items = parseNewsItems(raw);
  if (items.length) {
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const title = String(it.title || '').trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const date = String(it.date || it.showTime || '').trim().slice(0, 10);
      const body = String(it.content || '').trim();
      const type = String(it.informationType || '资讯').trim();
      const head = body.length > 300 ? body.slice(0, 300) + '…' : body;
      out.push(`- [${date || '日期未知'}]（${type}）${title}\n  ${head}`);
      if (out.length >= maxItems) break;
    }
    if (out.length) {
      let text = `东方财富资讯（查询：${query}）：\n` + out.join('\n\n');
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（更多内容省略）';
      return { ok: true, text, count: out.length, rawLen: raw.length, source: '东方财富妙想AI' };
    }
  }
  // 非结构化：原样截断返回（只要不是空壳）
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length >= 80) {
    const text = trimmed.slice(0, maxChars);
    return { ok: true, text, count: 1, rawLen: raw.length, source: '东方财富妙想AI' };
  }
  return { ok: false, text: '', count: 0, rawLen: raw.length, source: '东方财富妙想AI' };
}

// ---- 响应解析 ----

function extractDtoList(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  const data = apiResult.data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.dataTableDTOList)) return data.dataTableDTOList;
    const sdr = data.searchDataResultDTO;
    if (sdr && Array.isArray(sdr.dataTableDTOList)) return sdr.dataTableDTOList;
    if (Array.isArray(data.tableList)) return data.tableList;
  }
  if (Array.isArray(apiResult.dataTableDTOList)) return apiResult.dataTableDTOList;
  return null;
}

function tableToRows(block) {
  const table = block.table || {};
  const entityName = String(block.entityName || '指标');
  if (!table || typeof table !== 'object') return { columns: [], rows: [] };
  const headers = Array.isArray(table.headName) ? table.headName : [];
  const keys = Object.keys(table).filter(k => k !== 'headName');
  const flatten = (v) => (v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));

  if (headers.length > 1 && keys.length >= 1) {
    const columns = [entityName, ...headers.map(h => String(h))];
    const rows = keys.map(k => {
      let vals = table[k];
      if (!Array.isArray(vals)) vals = [vals];
      return Object.fromEntries(columns.map((c, i) => [c, i === 0 ? String(k) : flatten(vals[i - 1])]));
    });
    return { columns, rows };
  }
  if (headers.length === 1 && keys.length >= 1) {
    const columns = [entityName, String(headers[0])];
    const rows = keys.map(k => {
      let v = table[k];
      if (Array.isArray(v)) v = v[0];
      return { [columns[0]]: String(k), [columns[1]]: flatten(v) };
    });
    return { columns, rows };
  }
  if (Array.isArray(table.rows)) {
    const cols = Array.isArray(table.columns) ? table.columns : Object.keys(table.rows[0] || {});
    return { columns: cols, rows: table.rows };
  }
  return { columns: [], rows: [] };
}

function parseTables(apiResult) {
  const dtoList = extractDtoList(apiResult);
  if (!dtoList || !dtoList.length) return [];
  const tables = [];
  for (const dto of dtoList) {
    if (!dto || typeof dto !== 'object') continue;
    const title = dto.title || dto.inputTitle || dto.entityName || '表';
    const condition = dto.condition || '';
    const { columns, rows } = tableToRows(dto);
    if (rows.length) tables.push({ title, entityName: dto.entityName || '', condition, columns, rows });
  }
  return tables;
}

function extractMessage(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  // 20260921g：业务失败时 message 位于**根级**、data 为 null；成功时 message 位于 data 内。
  // 旧实现只看 data.message，导致根级错误信息被丢弃。
  if (typeof apiResult.message === 'string' && apiResult.message.trim()) return apiResult.message.trim();
  const data = apiResult.data;
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  return null;
}

/**
 * 识别妙想「业务级失败」：HTTP 200 但 code/status 为负或 data 为空、且带 message。
 * 典型：积分耗尽 —— {"message":"你的积分已用完～请前往 …购买套餐包补充积分","status":-1,"code":-1,"data":null}
 * 此前上层只看到「tables 为空」，把「积分用完 / 未授权 / 参数错误」统统误判为「没有数据」，
 * 静默降级、无从排查（股东户数、评级、龙虎榜、宏观等所有走妙想的功能都受影响）。
 * @returns {string|null} 业务错误文案；正常响应返回 null
 */
function extractBusinessError(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  const msg = typeof apiResult.message === 'string' ? apiResult.message.trim() : '';
  if (!msg) return null;
  const code = Number(apiResult.code);
  const st = Number(apiResult.status);
  const negative = (Number.isFinite(code) && code < 0) || (Number.isFinite(st) && st < 0);
  if (negative || apiResult.data == null) return msg;
  return null;
}

module.exports = { startAuth, getAuthStatus, searchData, searchNews, searchNewsToText, loadKey, saveKey, clearPending };
