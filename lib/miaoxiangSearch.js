// 东方财富妙想（Miaoxiang）金融资讯检索客户端
// 复用 mx-finance-search skill 的 searchNews 接口（自然语言查询公告/研报/新闻）。
// 仅在 EM_API_KEY 可用时返回数据；未授权时返回 null，调用方回退到既有爬虫数据源。
'use strict';

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MCP_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchNews';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// EM_API_KEY 优先级：环境变量 > ~/.mx-skills/em_api_key 落盘文件
function loadApiKey() {
  const envKey = (process.env.EM_API_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const p = path.join(os.homedir(), '.mx-skills', 'em_api_key');
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf-8').trim();
      if (v) return v;
    }
  } catch (e) { /* ignore */ }
  return '';
}

// 从妙想返回体中提取可读正文（优先 llmSearchResponse），兼容 data/result 包裹
function extractContent(raw) {
  if (!raw || typeof raw !== 'object') return '';
  for (const k of ['data', 'result']) {
    const w = raw[k];
    if (w && typeof w === 'object') {
      const x = extractContent(w);
      if (x) return x;
    } else if (typeof w === 'string' && w.trim()) {
      return w.trim();
    }
  }
  for (const k of ['llmSearchResponse', 'searchResponse', 'content', 'answer', 'summary']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  }
  return '';
}

async function searchFinancial(query, timeoutMs = 15000) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.log('[Miaoxiang] 未配置 EM_API_KEY，跳过妙想检索（回退到既有数据源）。');
    return null;
  }
  const q = (query || '').trim();
  if (!q) return null;
  try {
    const resp = await axios.post(MCP_URL, { query: q, toolContext: { callId: 'call_' + Date.now() } }, {
      headers: {
        'Content-Type': 'application/json',
        'em_api_key': apiKey,
        'x-open-id-vendor': 'tencent',
        'x-open-id-app': 'workbuddy',
        'User-Agent': UA,
      },
      timeout: timeoutMs,
    });
    const raw = resp.data;
    if (raw && (raw.code === 401 || raw.status === 401)) {
      console.warn('[Miaoxiang] EM_API_KEY 失效（401），请重新授权。');
      return null;
    }
    const content = extractContent(raw);
    return content || null;
  } catch (e) {
    console.error('[Miaoxiang] search failed:', e.message);
    return null;
  }
}

module.exports = { searchFinancial, loadApiKey };
