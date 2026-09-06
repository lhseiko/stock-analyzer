/**
 * lib/ai/llm.js —— aiAugment 领域子模块：LLM 调用 / 模型选择 / 搜索通道 / 上下文预算 / JSON 解析
 * ----------------------------------------------------------------
 * 由 lib/aiAugment.js 拆分而来（202609 拆分重构）。
 * guardCtxBudget（原研报块）与 extractJson（原 augmentStock 块）因被 ≥6 个分析器跨块使用，上移至本模块。
 * 可变状态（搜索方式/凭据）唯一持有于 ai/config 的 runtime，本模块在调用时实时读取，禁止顶层解构值快照。
 */
const axios = require('axios');
const { mcpWebSearch, MCP_ENDPOINT, BAIDU_ENDPOINT } = require('../webSearchMcp'); // 阿里百炼(一次性2000次,本地计数保险) / 百度千帆(每日100次)
const { volcWebSearch, DEFAULT_VOLC_MODEL } = require('../volcSearch'); // 20260903n：火山豆包搜索（每月500次免费、每月重置）
const { searchNewsToText } = require('../miaoxiang'); // 20260904a：东方财富妙想资讯检索（东财公告/研报/财经新闻事实源）
const config = require('./config'); // 状态唯一持有者：调用时实时读取 config.runtime.*
const { PROVIDERS } = config;

function buildRequestBody(provider, model, messages, opts) {
  const p = PROVIDERS[provider] || PROVIDERS.qwen;
  const m = model || p.defModel;
  const body = { model: m, messages, stream: false, temperature: 0.3 };
  const webSearch = !opts || opts.webSearch !== false; // 默认 true（联网类），显式 false 则禁用
  // webSearch=false：纯本地推理，绝不附加联网参数（用于分析已上传财报等本地数据）
  if (!webSearch) return body;
  // qwen 部分模型（如数学/代码系列）不支持 enable_search，需按模型名过滤，避免 400
  if (p.search === 'enable_search' && !isNoSearchModel(m)) {
    body.enable_search = true;
  }
  if (p.search === 'tool') {
    body.tools = [{ type: 'web_search', web_search: { search_result: true, search_query: true } }];
  }
  return body;
}

// 已知不支持联网搜索的模型名（qwen 生态）
function isNoSearchModel(modelName) {
  if (!modelName) return false;
  const name = String(modelName).toLowerCase();
  return name.includes('math') || name.includes('coder') || name.includes('vl') || name.includes('audio');
}

function extractSources(text) {
  const urls = (text.match(/https?:\/\/[^\s）)，。、]+/g) || [])
    .map((u) => u.replace(/[。，、）)]+$/, ''));
  return [...new Set(urls)].slice(0, 8);
}

/**
 * 调用大模型。
 * @param {string} provider   服务商（qwen/glm/openai）
 * @param {string} apiKey
 * @param {string} model      模型名
 * @param {Array}  messages
 * @param {Object} [opts]
 * @param {boolean} [opts.webSearch=true]  true=联网类（附加 enable_search/tools），false=本地类（绝不开联网）
 */
// 从 messages 中提取最后一条用户消息文本，作为联网搜索词
function extractUserQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content.trim().slice(0, 200);
      if (Array.isArray(m.content)) {
        return m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ').trim().slice(0, 200);
      }
    }
  }
  return '';
}

// 将联网检索结果作为 system 上下文注入，模型据此纯推理（不再依赖内置 enable_search）
function injectSearchResults(messages, results, sourceLabel) {
  const src = sourceLabel || '外部联网搜索';
  const sys = {
    role: 'system',
    content: `以下是联网检索到的实时资料（来源：${src}，免费额度内获取）。请基于这些资料回答用户问题，引用时注明来源标题与链接：\n\n` + results,
  };
  return [sys, ...messages];
}

/**
 * 外部搜索通道定义（searchMode → 具体实现）。
 * 全部为「先取搜索结果文本 → 注入 prompt → 模型纯推理（不开 enable_search）」的解耦模式，
 * 任一通道失败都回退到模型内置 enable_search，保证功能不中断。
 */
const SEARCH_CHANNELS = {
  mcp: {
    label: '阿里云百炼「联网搜索 MCP」',
    quota: '前 2000 次调用免费（一次性总额度）',
    // 复用主 Key（百炼通用 Key，与模型调用同一把）
    getKey: (mainKey) => mainKey,
    run: (key, query) => mcpWebSearch(key, query, { endpoint: MCP_ENDPOINT, label: '阿里百炼联网搜索 MCP' }),
  },
  volc: {
    label: '火山引擎「豆包联网搜索」',
    quota: '每月 500 次免费、每月 1 日重置',
    getKey: () => config.runtime.volcKey, // 调用时实时读取（状态唯一持有于 ai/config）
    run: (key, query) => volcWebSearch(key, query, { model: config.runtime.volcModel || DEFAULT_VOLC_MODEL }),
  },
  baidu: {
    label: '百度千帆「AI 搜索 MCP」',
    quota: '每日 100 次免费、每日重置',
    getKey: () => config.runtime.baiduKey, // 调用时实时读取（状态唯一持有于 ai/config）
    run: (key, query) => mcpWebSearch(key, query, { endpoint: BAIDU_ENDPOINT, label: '百度千帆 AI 搜索 MCP' }),
  },
};

async function callLLM(provider, apiKey, model, messages, opts) {
  const p = PROVIDERS[provider] || PROVIDERS.qwen;
  const webSearch = !opts || opts.webSearch !== false;

  // ── 东方财富妙想事实源优先（20260904a）──
  // opts.mxQuery（替换模式）：资讯类任务用。妙想返回足够内容 → 注入并纯推理（关闭 enable_search，省费且事实源为东财公告/研报/财经新闻）；
  //                           妙想无 Key/失败/内容不足 → 自动落回下方通用搜索通道/内置 enable_search，功能不中断。
  // opts.mxInject（增强模式）：妙想内容注入，但仍保留原联网搜索（如行业指数仍需联网识别代表指数代码与点位）。
  const wantMxQuery = !!(opts && opts.mxQuery && String(opts.mxQuery).trim());
  const wantMxInject = !!(opts && opts.mxInject); // 可与 mxQuery 同用：注入妙想事实块但保留通用搜索
  if ((wantMxQuery || wantMxInject) && webSearch) {
    const q = (opts && String(opts.mxQuery || '').trim()) || extractUserQuery(messages);
    if (q) {
      try {
        const mxr = await searchNewsToText(q.slice(0, 200), { maxItems: 8, maxChars: 6000 });
        if (mxr && mxr.ok && mxr.text && mxr.text.length >= 120) {
          messages = injectSearchResults(messages, mxr.text, '东方财富妙想AI（东财公告/研报/财经新闻）');
          if (wantMxQuery) {
            // 替换模式：妙想事实已注入 → 纯推理，不再走 enable_search
            const mxBody = buildRequestBody(provider, model, messages, { webSearch: false });
            return await postLLM(p.url, apiKey, mxBody, opts && opts.timeoutMs);
          }
          // 增强模式：消息已带妙想事实块，继续走下方通用搜索补全
        }
      } catch (mxErr) {
        console.warn(`[mx-first] 妙想资讯获取失败（${wantMxQuery ? 'mxQuery' : 'mxInject'}），回退通用搜索：`, mxErr && mxErr.message);
      }
    }
  }

  // 外部搜索通道（mcp/volc/baidu）：先拿搜索结果，注入 prompt，模型纯推理（不带 enable_search）
  const searchMode = config.runtime.searchMode; // 调用时实时读取（状态唯一持有于 ai/config，禁止顶层解构快照）
  const channel = SEARCH_CHANNELS[searchMode];
  if (channel && webSearch && apiKey) {
    const searchKey = channel.getKey(apiKey);
    if (!searchKey) {
      console.warn(`[search:${searchMode}] 未配置该通道的 API Key，本次回退内置 enable_search`);
    } else {
      try {
        const query = extractUserQuery(messages);
        if (query) {
          const results = await channel.run(searchKey, query);
          if (results && results.trim()) {
            const augmented = injectSearchResults(messages, results, `${channel.label}（${channel.quota}）`);
            const body = buildRequestBody(provider, model, augmented, { webSearch: false });
            return await postLLM(p.url, apiKey, body, opts && opts.timeoutMs);
          }
        }
      } catch (searchErr) {
        console.warn(`[search:${searchMode}] 调用失败，回退内置 enable_search：`, searchErr && searchErr.message);
        // 落入下方内置路径
      }
    }
  }

  const body = buildRequestBody(provider, model, messages, { webSearch });
  try {
    return await postLLM(p.url, apiKey, body, opts && opts.timeoutMs);
  } catch (e) {
    // 部分模型（如 qwen3.7-plus 等多模态/新版模型）不支持联网搜索参数，
    // 400 时自动去掉 enable_search/tools 重试一次，避免「AI 归因失败: 400」。
    // 注意：仅对原本就要联网的调用做此回退；本地类（webSearch=false）不会触发 enable_search，跳过此逻辑
    if (!webSearch) throw e;
    const hasSearchParam = body.enable_search !== undefined || Array.isArray(body.tools);
    if (hasSearchParam && e.response && e.response.status === 400) {
      const retryBody = { ...body };
      delete retryBody.enable_search;
      delete retryBody.tools;
      return await postLLM(p.url, apiKey, retryBody, opts && opts.timeoutMs);
    }
    throw e;
  }
}

// 按当前任务类型获取模型与联网开关：联网类用 modelWeb（启用 enable_search），本地类用 modelLocal（禁用）
// webSearch=false 时若未配置 modelLocal，自动降级到 modelWeb（保持功能可用，但会回退到联网）
function pickModelFor(cfg, kind) {
  if (kind === 'local') {
    return {
      model: cfg.modelLocal || cfg.modelWeb || '',
      webSearch: false,
      isLocal: !!cfg.modelLocal,
    };
  }
  // 默认/联网类
  return {
    model: cfg.modelWeb || '',
    webSearch: true,
    isLocal: false,
  };
}

// 本地文本摘要模型（20260903g）：研报/公告/公司介绍/供应链这四类「文本总结」任务专用。
// qwen-math-turbo 等数学特化模型做中文摘要质量极差（复读同一句、中英混杂），
// 检测到 math 特化模型时自动改用通用轻量模型 qwen-turbo（仍不联网，价格约为联网搜索的百分之一）。
// 财报解读/股东户数等数字推理任务继续用 modelLocal（数学模型的本职）。
function pickLocalSummaryModel(cfg) {
  const base = pickModelFor(cfg, 'local');
  if (/math/i.test(base.model || '')) {
    return { model: 'qwen-turbo', webSearch: false, isLocal: true };
  }
  return base;
}

async function postLLM(url, apiKey, body, timeoutMs) {
  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs || 60000,
  });
  const msg = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message;
  let content = msg && msg.content ? msg.content : '';
  if (!content && msg && msg.tool_calls) {
    content = msg.tool_calls.map((t) => JSON.stringify(t)).join('\n');
  }
  if (!content) content = JSON.stringify(resp.data).slice(0, 2000);
  return content;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 本地上下文长度预算（字符）：qwen-math-turbo 输入上限仅 3072 tokens（约 3000 汉字），
// 装不下「system prompt + 近8期结构化表 + 同期 PDF 节选」；超预算时升级为 modelWeb（不开联网）。
const LOCAL_CTX_CHAR_BUDGET = { 'qwen-math-turbo': 3000, 'qwen-math-plus': 3000 };
const DEFAULT_LOCAL_CTX_CHAR_BUDGET = 6000;

// 小上下文防御（与财报解读同规则）：本地上下文超出 modelLocal 输入预算时，
// 升级为 modelWeb（仍不开联网，属于本地数据推理）；无 modelWeb 可升级则原样继续。
function guardCtxBudget(cfg, modelPick, ctxLen, tag, symbol) {
  const budget = LOCAL_CTX_CHAR_BUDGET[String(modelPick.model || '').toLowerCase()] || DEFAULT_LOCAL_CTX_CHAR_BUDGET;
  if (ctxLen <= budget) return modelPick;
  if (cfg.modelWeb && cfg.modelWeb !== modelPick.model) {
    console.log(`[${tag}] ${symbol} 本地上下文约 ${ctxLen} 字超出 ${budget} 预算，升级为 modelWeb（不联网）：${cfg.modelWeb}`);
    return { model: cfg.modelWeb, webSearch: false, isLocal: false };
  }
  console.warn(`[${tag}] ${symbol} 本地上下文约 ${ctxLen} 字超预算且无 modelWeb 可升级，仍用本地模型继续`);
  return modelPick;
}

module.exports = {
  buildRequestBody,
  isNoSearchModel,
  extractSources,
  extractUserQuery,
  injectSearchResults,
  SEARCH_CHANNELS,
  callLLM,
  pickModelFor,
  pickLocalSummaryModel,
  postLLM,
  extractJson,
  guardCtxBudget,
  LOCAL_CTX_CHAR_BUDGET,
  DEFAULT_LOCAL_CTX_CHAR_BUDGET,
};
