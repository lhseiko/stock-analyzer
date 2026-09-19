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
 * @param {number}  [opts.timeoutMs]      单次 postLLM 的硬超时（不传默认 180000）
 * @param {number}  [opts.overallBudgetMs] 整条链路（含多次串行重试）的总耗时预算。
 *                                        20260917l 新增，**可选**：不传则行为与历史版本完全一致；
 *                                        传入后每次 postLLM 只用 min(timeoutMs, 剩余预算)，
 *                                        预算耗尽即秒级抛错（err.budgetExhausted=true），
 *                                        避免「串行多次 240s 超时 → 用户长时间拿不到结果」。
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

/**
 * 「总耗时预算」工具（20260917l 新增；纯计算、无副作用、可单测）。
 *
 * 背景：callLLM 内部最多会**串行**发起 4 次 postLLM（① 妙想事实纯推理 → ② 外部搜索通道纯推理 →
 * ③ 外部通道失败后的纯推理 → ④ 内置 enable_search），每次都用同一个 timeoutMs 做硬超时。
 * 单股最坏可累积到 4×240s ≈ 16 分钟，用户侧表现就是「亮点/雷点长时间无法获取」（本次投诉场景）。
 *
 * 给整条链路设一个总预算（opts.overallBudgetMs）后：每次 postLLM 只允许使用
 * min(调用方 timeoutMs, 剩余预算)；剩余预算不足 MIN_MS 时不再发起新请求，直接快速失败。
 *
 * ⚠️ 未传 overallBudgetMs 时 enabled=false、leftMs()=Infinity、expired()=false、
 *    timeoutFor() 原样返回调用方 timeoutMs —— 与历史版本**完全一致**，
 *    因此 companyDeep / valuation / earnings / research / announcements 等既有调用方行为不变。
 */
function createBudget(overallBudgetMs, opts) {
  const budget = Number(overallBudgetMs) > 0 ? Number(overallBudgetMs) : 0;
  const perCall = (opts && Number(opts.timeoutMs)) || 0;
  const startedAt = Date.now();
  const MIN_MS = 5000; // 剩余不足 5s：再试一轮也几乎必定超时，直接失败，避免用户白等
  return {
    enabled: budget > 0,
    minMs: MIN_MS,
    elapsedMs: () => Date.now() - startedAt,
    leftMs: () => (budget > 0 ? budget - (Date.now() - startedAt) : Infinity),
    expired: function () { return budget > 0 && this.leftMs() <= MIN_MS; },
    timeoutFor: function () {
      if (budget <= 0) return perCall || undefined;
      const left = this.leftMs();
      return perCall > 0 ? Math.min(perCall, left) : left;
    },
  };
}

async function callLLM(provider, apiKey, model, messages, opts) {
  const p = PROVIDERS[provider] || PROVIDERS.qwen;
  const webSearch = !opts || opts.webSearch !== false;
  // 20260917l：整条链路的总耗时预算（**仅当调用方传入 opts.overallBudgetMs 时生效**；
  // 不传则与历史行为完全一致，其他分析器零影响 —— 符合「隔离修改」铁律）。
  const budget = createBudget(opts && opts.overallBudgetMs, opts);
  // 受预算约束的 postLLM：预算已耗尽 → 立刻抛错（不再发起任何新请求，秒级返回）；
  // 否则用「min(单次超时, 剩余预算)」发起，保证整条链路不会超出总预算。
  const callBudgeted = (body) => {
    if (budget.expired()) {
      const err = new Error('AI 总耗时预算已用尽（已等待约 ' + Math.round(budget.elapsedMs() / 1000) + 's），为避免长时间无响应已中止');
      err.timeout = true;
      err.budgetExhausted = true;
      return Promise.reject(err);
    }
    return postLLM(p.url, apiKey, body, budget.timeoutFor());
  };

  // ── 东方财富妙想事实源优先（20260904a）──
  // opts.mxQuery（替换模式）：资讯类任务用。妙想返回足够内容 → 注入并纯推理（关闭 enable_search，省费且事实源为东财公告/研报/财经新闻）；
  //                           妙想无 Key/失败/内容不足 → 自动落回下方通用搜索通道/内置 enable_search，功能不中断。
  // opts.mxInject（增强模式）：妙想内容注入，但仍保留原联网搜索（如行业指数仍需联网识别代表指数代码与点位）。
  const wantMxQuery = !!(opts && opts.mxQuery && String(opts.mxQuery).trim());
  const wantMxInject = !!(opts && opts.mxInject); // 可与 mxQuery 同用：注入妙想事实块但保留通用搜索
  if ((wantMxQuery || wantMxInject) && webSearch) {
    const q = (opts && String(opts.mxQuery || '').trim()) || extractUserQuery(messages);
    if (q) {
      let mxInjected = false;
      try {
        const mxr = await searchNewsToText(q.slice(0, 200), { maxItems: 8, maxChars: 6000 });
        if (mxr && mxr.ok && mxr.text && mxr.text.length >= 120) {
          messages = injectSearchResults(messages, mxr.text, '东方财富妙想AI（东财公告/研报/财经新闻）');
          mxInjected = true;
        }
      } catch (mxErr) {
        console.warn(`[mx-first] 妙想资讯获取失败（${wantMxQuery ? 'mxQuery' : 'mxInject'}），回退通用搜索：`, mxErr && mxErr.message);
      }
      // 妙想「抓取」与大模型「推理」是两个独立环节，必须分别捕获，
      // 否则 LLM 超时会被外层 mxErr 误报成「妙想资讯获取失败」，误导排查。
      if (mxInjected && wantMxQuery) {
        try {
          // 替换模式：妙想事实已注入 → 纯推理，不再走 enable_search
          const mxBody = buildRequestBody(provider, model, messages, { webSearch: false });
          return await callBudgeted(mxBody);
        } catch (llmErr) {
          console.warn(`[mx-first] 妙想资讯已注入，但大模型推理超时/失败，回退通用搜索：`, llmErr && llmErr.message);
          // 保留已注入的妙想事实，继续走下方通用搜索补全（不重复注入妙想）
        }
      }
      // 增强模式（wantMxInject）或 mxQuery 推理失败时，消息已带妙想事实块，继续走下方通用搜索补全
    }
  }

  // 外部搜索通道（mcp/volc/baidu）：先拿搜索结果，注入 prompt，模型纯推理（不带 enable_search）
  const searchMode = config.runtime.searchMode; // 调用时实时读取（状态唯一持有于 ai/config，禁止顶层解构快照）
  const channel = SEARCH_CHANNELS[searchMode];
  // 20260916c：外部通道集合。命中其中之一时，「搜索失败/无 Key」一律降级为纯推理，
  // 绝不静默升级到 LLM 内置 enable_search（即不绕过免费 MCP 额度自行上网，杜绝阿里云静默扣费）。
  const EXTERNAL_SEARCH_MODES = ['mcp', 'volc', 'baidu'];
  let externalSearchFailed = false;
  if (channel && webSearch && apiKey) {
    const searchKey = channel.getKey(apiKey);
    const usesExternal = EXTERNAL_SEARCH_MODES.includes(searchMode);
    if (!searchKey) {
      if (usesExternal) {
        console.warn(`[search:${searchMode}] 未配置该通道的 API Key，本次仅做纯推理（不开启联网搜索，避免绕过 MCP 自行上网）`);
        externalSearchFailed = true;
      } else {
        console.warn(`[search:${searchMode}] 未配置该通道的 API Key，本次回退内置 enable_search`);
      }
    } else {
      try {
        const query = extractUserQuery(messages);
        if (query) {
          const results = await channel.run(searchKey, query);
          if (results && results.trim()) {
            const augmented = injectSearchResults(messages, results, `${channel.label}（${channel.quota}）`);
            const body = buildRequestBody(provider, model, augmented, { webSearch: false });
            return await callBudgeted(body);
          }
        }
        // 要搜但没拿到结果：外部通道 → 降级纯推理；其余 → 保持原内置路径
        if (usesExternal) externalSearchFailed = true;
      } catch (searchErr) {
        console.warn(`[search:${searchMode}] 调用失败，本次仅做纯推理（不回退内置 enable_search，避免绕过 MCP 自行上网）：`, searchErr && searchErr.message);
        if (usesExternal) externalSearchFailed = true;
      }
    }
  }

  // 20260916c：外部通道失败/无 Key → 直接纯推理，绝不带 enable_search 自行上网
  if (externalSearchFailed) {
    const body = buildRequestBody(provider, model, messages, { webSearch: false });
    return await callBudgeted(body);
  }

  const body = buildRequestBody(provider, model, messages, { webSearch });
  try {
    return await callBudgeted(body);
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
      return await callBudgeted(retryBody);
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

/**
 * 模型能力自学习（20260918b）
 * ----------------------------------------------------------------
 * 根因（2026-09-18 用户反馈「海天味业最大亮点/雷点无法获取数据」）：
 * 阿里百炼（DashScope 兼容模式）上部分模型与「非流式 + enable_search」不兼容，会让联网类 AI 功能瞬间失败：
 *   ① 仅支持流式：非流式请求直接 HTTP 400，message 形如
 *      "This model only support stream mode, please enable the stream parameter to access the model."
 *      （glm-4.5-air 实测；用户当日把「联网模型」改成该模型后即触发）；
 *   ② 不支持联网参数：带 enable_search 时以 SSE error 事件返回（HTTP 仍 200），message 形如
 *      "The parameters `enable_search` is not supported"；非流式下同样是 400。
 * 二者叠加时用户侧表现为「点 AI 生成亮点/雷点 → 5 秒内失败 → 概览卡片一直『尚未生成』」。
 * 兼容层策略：首见即记忆（进程内 Set）+ 当次立刻按正确姿势重发；下次调用一次成功，不再浪费请求。
 * 记忆仅存内存、不落盘（避免新增状态文件），重启后最多多花 1~2 次失败请求。
 * 隔离性：默认路径（非 stream-only 模型）请求体与历史完全一致，其他分析器零影响。
 */
const STREAM_ONLY_MODELS = new Set();     // 只接受 stream:true 的模型
const NO_SEARCH_PARAM_MODELS = new Set(); // 不接受 enable_search / tools 的模型

// 去掉联网参数（用于「模型不支持 enable_search」的降级重发）
function _stripSearchParams(body) {
  const b = Object.assign({}, body);
  delete b.enable_search;
  delete b.tools;
  return b;
}

// 取「可读的响应体文本」，用于识别模型能力类错误
function _errText(e) {
  const d = e && e.response && e.response.data;
  if (d == null) return String((e && e.message) || '');
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (err) { return String((e && e.message) || ''); }
}

// 把 SSE 里的 error 归一化成「带 response(status=400) 的错误」，
// 让上游既有的「400 → 去掉 enable_search 重试」兜底逻辑可直接复用。
function _sseError(errorObj) {
  const msg = (errorObj && (errorObj.message || errorObj.code)) || '模型返回错误';
  const err = new Error(msg);
  err.isSseError = true;
  err.response = { status: 400, data: { error: errorObj } };
  return err;
}

// 解析 SSE（text/event-stream）响应体，按 OpenAI 兼容格式把 delta.content 拼回完整文本。
// ⚠️ 流式下模型的报错也走 SSE（HTTP 200 + data:{"error":{...}}），必须识别并抛错，
//    否则会被当成「正常但空」的回复而静默丢结果（比 400 更难排查）。
function _parseSseContent(raw) {
  const text = String(raw == null ? '' : raw);
  if (!/^\s*data:/m.test(text)) {
    // 个别网关即使 stream:true 仍返回整段 JSON：按非流式结构解析
    let j = null;
    try { j = JSON.parse(text.trim()); } catch (err) { /* 非 JSON，交由下方返回空串 */ }
    if (j && j.error) throw _sseError(j.error);
    const ch = j && j.choices && j.choices[0];
    const d = ch && (ch.message || ch.delta);
    return (d && d.content) || '';
  }
  let out = '';
  let errObj = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j = null;
    try { j = JSON.parse(payload); } catch (err) { continue; }
    if (j && j.error) { errObj = j.error; continue; }
    const ch = j && j.choices && j.choices[0];
    const d = ch && (ch.delta || ch.message);
    if (d && typeof d.content === 'string') out += d.content;
  }
  if (!out && errObj) throw _sseError(errObj);
  return out;
}

// 单次请求（内部使用）：useStream=true 时以流式发送并解析 SSE。
async function _postOnce(url, apiKey, body, effTimeout, useStream) {
  // 全局 fetch 是 axios 多填的 polyfill（follow-redirects），其内部 60s 默认超时忽略 AbortSignal / signal，
  // 且 axios 对 https:// 链接会自动选用 fetch 适配器从而丢弃 timeout 选项 → 请求会挂到 polyfill 的 60s 内部超时，
  // 且错误常被外层 try/catch 误判。因此：① 强制 adapter:'http'（http 适配器原生尊重 timeout）；
  // ② 再叠加一个真·Node 计时器兜底，无论适配器内部如何，到 effTimeout 必 reject，保证大模型慢/不通时快速失败。
  const reqBody = useStream ? Object.assign({}, body, { stream: true }) : body;
  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      const err = new Error('大模型请求超时（' + effTimeout + 'ms 无响应），请稍后重试');
      err.timeout = true;
      reject(err);
    }, effTimeout);
  });
  try {
    const resp = await Promise.race([
      axios.post(url, reqBody, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: effTimeout,
        adapter: 'http',
        // 流式必须显式 responseType:'text'：默认 'json' 会对 SSE 文本做 JSON.parse 失败而报错
        ...(useStream ? { responseType: 'text' } : {}),
      }),
      hardTimeout,
    ]);
    if (useStream) return _parseSseContent(resp.data);
    const msg = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message;
    let content = msg && msg.content ? msg.content : '';
    if (!content && msg && msg.tool_calls) {
      content = msg.tool_calls.map((t) => JSON.stringify(t)).join('\n');
    }
    if (!content) content = JSON.stringify(resp.data).slice(0, 2000);
    return content;
  } catch (e) {
    if (e && e.timeout) throw e; // 我方硬超时（已含明确语义），原样抛出
    if (e && e.isSseError) throw e; // 流式错误已带 response(status 400)，原样抛出供能力学习识别
    const err = new Error('大模型请求失败（' + (e && e.message || 'unknown') + '）');
    err.timeout = (e && e.timeout) || (/timeout/i.test(String(e && e.message || '')));
    // 20260918b：保留响应体/状态码 —— 上游「400 → 去掉 enable_search 重试」的兜底依赖 e.response.status，
    // 此前被此处包装丢弃（response 未透传），导致该兜底形同虚设；同时让 UI 能展示服务端返回的真实原因
    //（而非只有一句「status code 400」）。
    err.response = (e && e.response) || undefined;
    err.status = (e && e.response && e.response.status) || undefined;
    err.cause = e;
    throw err;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

/**
 * 调用大模型（能力自学习包装层）。对外契约不变：返回模型输出的纯文本。
 * 默认超时由 60000 放宽至 180000：本环境联网推理实测单股约 90s（偶发更慢），
 * 60s 会误杀正常请求（用户反馈的「个别股亮点/雷点长时间无法获取」即此因）。
 * @param {string} url
 * @param {string} apiKey
 * @param {Object} body      已由 buildRequestBody 组装好的请求体
 * @param {number} timeoutMs 单次请求硬超时（不传默认 180000）
 */
async function postLLM(url, apiKey, body, timeoutMs) {
  const effTimeout = timeoutMs || 180000;
  const model = String((body && body.model) || '');
  let curBody = body;
  let useStream = STREAM_ONLY_MODELS.has(model);
  // 已记忆「不支持联网参数」的模型：先去掉 enable_search/tools，省掉一次必然失败的 400
  if (NO_SEARCH_PARAM_MODELS.has(model) && curBody && (curBody.enable_search !== undefined || curBody.tools)) {
    curBody = _stripSearchParams(curBody);
  }
  // 最多 4 次尝试，每次「学到一个能力缺陷」就修正姿势后重试一次；无缺陷可学则立即抛出。
  // 用计数上限而非无限循环：即使服务端反复变更报错文案，也绝不会死循环/反复烧额度。
  let guard = 0;
  while (guard++ < 4) {
    try {
      return await _postOnce(url, apiKey, curBody, effTimeout, useStream);
    } catch (e) {
      const status = e && e.response && e.response.status;
      const text = _errText(e);
      // ① 仅支持流式（非流式 → 400）：记忆并改用流式重发
      if (!useStream && status === 400 && /only support stream mode/i.test(text)) {
        STREAM_ONLY_MODELS.add(model);
        console.warn(`[llm] 模型 ${model} 仅支持流式响应，已自动切换为 stream 模式（本次已重发，后续直接走流式）`);
        useStream = true;
        continue;
      }
      // ② 不支持 enable_search/tools（流式下以 SSE error 归一化为 400）：记忆并去掉联网参数重发
      if (curBody && (curBody.enable_search !== undefined || curBody.tools) && status === 400 && /enable_search|not support/i.test(text)) {
        NO_SEARCH_PARAM_MODELS.add(model);
        console.warn(`[llm] 模型 ${model} 不支持联网搜索参数，已自动降级为「纯推理 + 外部资讯注入」（本次已重发，后续直接降级）`);
        curBody = _stripSearchParams(curBody);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`模型 ${model} 的能力兼容重试次数超限（已尝试 4 次）`);
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
  createBudget,
  extractJson,
  guardCtxBudget,
  LOCAL_CTX_CHAR_BUDGET,
  DEFAULT_LOCAL_CTX_CHAR_BUDGET,
};
