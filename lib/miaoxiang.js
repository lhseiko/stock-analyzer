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

async function postJson(url, body, headers) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: resp.status, data };
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
  return { tables, message: message || null };
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
  return { content: typeof content === 'string' ? content : JSON.stringify(content) };
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
    return { ok: false, text: '', count: 0, rawLen: 0, source: '东方财富妙想AI' };
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
  const data = apiResult && apiResult.data;
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  return null;
}

module.exports = { startAuth, getAuthStatus, searchData, searchNews, searchNewsToText, loadKey, saveKey, clearPending };
