/**
 * 火山引擎 豆包联网搜索客户端（20260903n 新增）
 * ----------------------------------------------------------------
 * 免费额度（官方口径，2026-06-22 联网搜索能力升级后）：
 *   主账号维度 **每月 500 次免费，每月 1 日重置**（周期性额度，不是一次性总额度）；
 *   超出后 0.020 元/次。单次最多返回 50 条结果。
 * 相比阿里百炼 MCP（前 2000 次一次性、超出 0.029 元/次）与模型内置 enable_search
 * （无免费额度、≈0.003 元/次），本方案在本工作台当前用量（≈400 次/月）下可长期免费。
 *
 * ⚠️ API 形态说明（与阿里/百度 MCP 不同）：
 * 火山的联网搜索不是独立的「搜索 REST 接口」，而是 **Ark Responses API 的原生工具**
 * （tools: [{ type: 'web_search' }]），搜索结果由模型消费后写进回答文本，
 * 引用来源以 `url_citation` 注解形式挂在 content 上。因此：
 *   1) 本模块拿到的是「模型基于搜索结果整理的文本 + 引用列表」，而非原始 SERP；
 *   2) 上层把它当成「搜索证据」注入 prompt 即可，语义与 MCP 返回的文本一致；
 *   3) 响应结构随版本可能变化，全部解析都做防御性处理，缺字段不抛异常、只跳过。
 *
 * 端点：POST https://ark.cn-beijing.volces.com/api/v3/responses
 * 鉴权：Authorization: Bearer <Ark API Key>（火山方舟通用 Key，不是 Agent Plan 专用 Key）
 */
'use strict';

const axios = require('axios');

const VOLC_RESPONSES_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';
// 支持 web_search 内置工具的豆包模型（可在 AI 设置里覆盖）
const DEFAULT_VOLC_MODEL = 'doubao-seed-1-6-250615';

/** 递归收集对象里的文本片段（防御性：结构变化也能兜到） */
function collectTexts(node, out, depth) {
  if (!node || depth > 6) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(node)) {
    for (const it of node) collectTexts(it, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.text === 'string' && node.text.trim()) out.push(node.text.trim());
    if (Array.isArray(node.content)) collectTexts(node.content, out, depth + 1);
  }
}

/** 提取 url_citation 引用（防御性遍历 annotations） */
function collectCitations(node, out, depth) {
  if (!node || depth > 8 || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const it of node) collectCitations(it, out, depth + 1);
    return;
  }
  if (Array.isArray(node.annotations)) {
    for (const a of node.annotations) {
      if (!a || typeof a !== 'object') continue;
      const url = a.url || (a.url_citation && a.url_citation.url);
      if (!url) continue;
      const title = a.title || (a.url_citation && a.url_citation.title) || '';
      out.push({ title: String(title).slice(0, 120), url: String(url).slice(0, 300) });
    }
  }
  if (Array.isArray(node.content)) collectCitations(node.content, out, depth + 1);
  if (Array.isArray(node.output)) collectCitations(node.output, out, depth + 1);
}

/**
 * 调用火山豆包联网搜索，返回「搜索证据文本（含来源列表）」。
 * @param {string} apiKey 火山方舟 Ark API Key
 * @param {string} query 搜索词
 * @param {Object} [opts]
 * @param {string} [opts.model] 豆包模型（默认 doubao-seed-1-6-250615）
 * @param {number} [opts.maxResults=8] 单次返回条数上限（火山上限 50）
 * @param {number} [opts.timeout=30000]
 * @returns {Promise<string>}
 */
async function volcWebSearch(apiKey, query, { model, maxResults = 8, timeout = 30000 } = {}) {
  if (!apiKey) throw new Error('缺少 API Key（火山豆包搜索需要火山方舟 Ark API Key）');
  const q = (query || '').toString().trim();
  if (!q) throw new Error('搜索词为空');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const mdl = (model && String(model).trim()) || DEFAULT_VOLC_MODEL;
  const limit = Math.max(1, Math.min(50, Number(maxResults) || 8));

  const buildBody = (withLimit) => ({
    model: mdl,
    input: [{
      role: 'user',
      content: `请联网检索并汇总以下问题的最新公开信息，逐条给出要点与来源日期，不要加入你的主观判断：\n${q.slice(0, 500)}`,
    }],
    tools: [withLimit ? { type: 'web_search', limit } : { type: 'web_search' }],
    stream: false,
  });

  let resp;
  try {
    resp = await axios.post(VOLC_RESPONSES_ENDPOINT, buildBody(true), { headers, timeout });
  } catch (e) {
    // 部分模型/版本不接受 limit 字段，去掉后重试一次
    const status = e && e.response && e.response.status;
    if (status === 400 || status === 422) {
      resp = await axios.post(VOLC_RESPONSES_ENDPOINT, buildBody(false), { headers, timeout });
    } else {
      const detail = (e && e.response && e.response.data)
        ? JSON.stringify(e.response.data).slice(0, 200)
        : (e && e.message) || String(e);
      throw new Error('火山豆包搜索调用失败：' + detail);
    }
  }

  const data = resp && resp.data;
  if (!data || typeof data !== 'object') throw new Error('火山豆包搜索返回空响应');

  // 文本：优先 output_text（SDK 便捷字段），否则从 output[] 递归收集
  const texts = [];
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    texts.push(data.output_text.trim());
  } else {
    collectTexts(data.output, texts, 0);
  }
  const body = texts.join('\n').trim();

  // 来源：url_citation 注解
  const cites = [];
  collectCitations(data, cites, 0);
  const seen = new Set();
  const uniq = cites.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, limit);

  if (!body && !uniq.length) {
    throw new Error('火山豆包搜索未返回有效内容：' + JSON.stringify(data).slice(0, 200));
  }

  let out = body;
  if (uniq.length) {
    out += '\n\n【引用来源】\n' + uniq.map((c, i) => `${i + 1}. ${c.title || '(无标题)'} - ${c.url}`).join('\n');
  }
  return out.slice(0, 8000);
}

module.exports = { volcWebSearch, VOLC_RESPONSES_ENDPOINT, DEFAULT_VOLC_MODEL };
