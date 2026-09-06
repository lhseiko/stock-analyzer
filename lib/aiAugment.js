/**
 * AI 双模型调度模块（20260902d 重构：联网 / 本地分离）
 * ----------------------------------------------------------------
 * 工作台本身不能上网，需接入带「联网搜索」能力的大模型 API。
 * 同时支持纯本地推理模型（不联网，用于分析已上传财报等本地数据）。
 *
 * 配置字段（data/ai_config.json）：
 *   provider           服务商（qwen/glm/openai）
 *   apiKey             API Key（仅本机）
 *   modelWeb           联网模型（启用 enable_search）— 用于需联网检索的 AI 任务
 *   modelLocal         本地模型（不联网）— 用于分析本地数据库/财报文本/已抓取数据等纯推理任务
 *   useCustomProtocol  必须 true；让 WorkBuddy 直连阿里云百炼 API，使用免费额度，不消耗 WorkBuddy 积分
 *   searchMode         联网搜索方式（默认 builtin，留作回退）：
 *                        'builtin' 模型内置 enable_search — 无免费额度，≈0.003 元/次
 *                        'mcp'     阿里百炼联网搜索 MCP — 前 2000 次调用免费（一次性总额度、不重置），超出 ≈0.029 元/次
 *                        'volc'    火山引擎豆包搜索 — 每月 500 次免费（每月 1 日重置），超出 0.020 元/次
 *                        'baidu'   百度千帆 AI 搜索 MCP — 每日 100 次免费（每日重置，≈3000 次/月），超出 ≈0.008 元/次
 *                      volc/baidu 属「周期性重置」额度，本工作台当前用量（≈400 次/月）下可长期免费，优先使用。
 *   volcApiKey         火山方舟 Ark API Key（searchMode='volc' 时使用；留空则回退 builtin）
 *   volcModel          火山豆包模型名（默认 doubao-seed-1-6-250615）
 *   baiduApiKey        百度千帆 API Key（searchMode='baidu' 时使用；留空则回退 builtin）
 *
 * 工作台功能按 AI 依赖类型归类（20260903f 降费改造）：
 *   ┌─ 联网类（webSearch=true，使用 modelWeb）：需要模型先上网获取外部公开信息，再进行分析
 *   │    投资亮点/雷点(analyzeAspects)、大盘概览(analyzeMarketOverview)、行业指数(analyzeIndustryIndex)、
 *   │    财务变化归因(changeAnalysis)、首页最热话题(homeHotTopics)、个股近期热点(hotTopics.analyzePriceChange / analyzeTrendingTopics)
 *   ├─ 本地事实类（webSearch=false，使用 modelLocal；20260903f 降费）：事实由 lib/factStore.js 从东财/巨潮
 *   │    免费接口预下载入 SQLite（data_points），AI 只做纯推理总结，不再联网搜索：
 *   │    研报总结(analyzeResearchReports)、公告总结(analyzeAnnouncements)、
 *   │    公司综合介绍(analyzeCompany)、供应链与成本(analyzeSupplyChain)、
 *   │    个股资料补全(augmentStock)、产品与客户(analyzeProducts)；
 *   │    本地事实缺失时自动降级为联网检索（web-fallback），结果标注 mode 字段；
 *   │    缓存按「事实锚点」保鲜——研报/公告列表最新日期、概况+主营构成锚点未变就不重推（省费核心），
 *   │    web-fallback 模式 TTL 放宽至 30 天（半静态内容）。
 *   └─ 本地类（webSearch=false，使用 modelLocal）：只需模型分析本地数据、解读复杂图表、逻辑推导、生成报告
 *        ① 财报解读(analyzeEarningsReport) — 由 buildLocalEarningsContext 注入本地财务数据库
 *           （东财 F10 财报 → financeHub 输出五要素 + 同比 + 边际）作为唯一事实来源；
 *        ② 股东户数(analyzeShareholdersAI) — 由 buildLocalHoldersContext 注入本地 F10 股东户数走势
 *           （shareholderData.getShareholdersData）；本地数据缺失时自动降级为 web-fallback（联网检索）；
 *        已上传财报等本地资料仅在 prompt 中登记文件名，由模型基于本地上下文推导；
 *        本地数据缺失时自动降级为 web-fallback（联网检索），并在结果中标注 mode 字段。
 *
 * API Key 仅保存在本机 data/ai_config.json，不会上传。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getCompanyProfile } = require('./shareholderData');
const factStore = require('./factStore'); // 20260903f 降费：本地事实库（研报/公告/概况/主营预下载）
const { mcpWebSearch, MCP_ENDPOINT, BAIDU_ENDPOINT } = require('./webSearchMcp'); // 阿里百炼(一次性2000次,本地计数保险) / 百度千帆(每日100次)
const { volcWebSearch, DEFAULT_VOLC_MODEL } = require('./volcSearch'); // 20260903n：火山豆包搜索（每月500次免费、每月重置）
const { searchNewsToText } = require('./miaoxiang'); // 20260904a：东方财富妙想资讯检索（东财公告/研报/财经新闻事实源）
// 202609 拆分重构：常量/配置/模块级状态唯一持有者迁至 ai/config（g* 四变量收拢为 config.runtime）。
// 消费方必须调用时实时读取 config.runtime.xxx，禁止模块顶层解构值快照。
const config = require('./ai/config');
const {
  UA, CACHE_DIR, IMG_DIR, CACHE_TTL_MS, SEMI_STATIC_TTL_MS,
  loadPromptFile, PROVIDERS, ensureDirs, loadConfig, saveConfig, publicConfig,
} = config;

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

// 只读接口读取已存缓存（不联网、不限 TTL），供前端打开个股页时自动展示
function readCache(symbol, suffix) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}${suffix || ''}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null;
  }
}

// 财报解读缓存读取（供短期判断因子复用）：不再因 promptVersion 不符直接丢弃——
// summary 文本仍可用，因子侧在缺 earningsSignal 时会按文本启发式兜底，确保旧缓存也能正确判定多空（任务 J）。
function readEarningsCache(symbol) {
  const cached = readCache(symbol, '_earnings');
  if (!cached) return null;
  if (cached.promptVersion !== EARNINGS_PROMPT_VERSION) cached.stale = true;
  return cached;
}

// 20260906：AI 估值 GET 只读缓存（版本+TTL 门控，不校验 factAnchor 以免打开页面拉取东财数据）。
// 供前端打开个股时自动展示已存结果；版本过期/无缓存返回 null——前端保持规则版，
// 用户点「✨ AI 估值」（force=true）才联网重算。此前 GET 走 analyzeValuation(force:false)
// 会在缓存 ver 过期时静默触发 LLM 重算：既违背单按钮口径（打开不消耗额度），失败时前端又无感知。
function readValuationCache(symbol) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_valuation.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!cached || cached.ver !== VALUATION_VER) return null;
    if (Date.now() - new Date(cached.date).getTime() >= SEMI_STATIC_TTL_MS) return null;
    return {
      symbol: cached.symbol, stockName: cached.stockName, industry: cached.industry,
      content: cached.content, date: cached.date, model: cached.model, mode: cached.mode,
      localDataUsed: cached.localDataUsed, factAnchor: cached.factAnchor, ver: cached.ver,
    };
  } catch { return null; }
}

const AUGMENT_WEB_SYSTEM_PROMPT = `你是一名专业的投资分析助手，熟悉中国A股、港股与美股市场。用户会给你一家公司的名称与代码，请你利用联网搜索能力，补全该公司公开资料中本地数据库未覆盖的部分。请重点输出：
1) 最近3个月的重要新闻与公告摘要；
2) 近期重大事件（并购重组、高管/股东变动、监管处罚、重大订单或产能变化等）；
3) 主营业务、主要产品或主要客户的最新变化；
4) 主流券商或研究机构近期的观点与评级（如有）。
要求：用简体中文、分点结构化输出；每条尽量标注信息来源与日期；若某类信息无可靠公开来源，请明确写"暂无可靠公开信息"，不要编造。总长控制在900字以内。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的研报/公告/概况/主营构成做纯推理
const AUGMENT_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析助手，熟悉中国A股、港股与美股市场。你没有联网能力，也不需要联网。下方「本地公开资料」由系统预先从东方财富 F10 / 巨潮资讯网免费下载，是本轮分析唯一允许引用的事实来源，包含四类：
1) 公司概况（名称、行业、省份、企业性质、控股股东、员工人数、主营业务范围、主要产品）；
2) 主营构成（按产品/地区/行业维度的营收占比与毛利率，最新年报期）；
3) 近一年券商研报列表（机构、评级、目标价、预测EPS/PE、发布日期）；
4) 近一年重要公告列表（增持/减持/回购/高管变动/监管处罚/诉讼等自动分类与关键数字）。

请基于以上本地资料补全该公司公开资料，重点输出：
1) 主营业务、主要产品与主要客户概览（取自主营构成与公司概况，附营收占比/毛利率如有）；
2) 近期重大事件（取自公告列表：增持/减持/回购/高管变动/监管处罚/诉讼等，标注日期）；
3) 主流券商或研究机构近期观点与评级（取自研报列表，标注机构/评级/目标价/日期）；
4) 若某类信息本地资料未覆盖，请明确写"本地资料未提供"，不要编造，也不要使用你训练记忆中的任何内容。
要求：用简体中文、分点结构化输出；每条尽量标注信息来源与日期；总长控制在900字以内。`;

// 由 factStore 四类事实组装「个股资料补全」上下文（供不联网模型推理）
async function buildAugmentContext(symbol, stockName) {
  const [research, announcements, profile, segment] = await Promise.all([
    factStore.getResearchFacts(symbol).catch(() => ({ ok: false })),
    factStore.getAnnouncementFacts(symbol, stockName).catch(() => ({ ok: false })),
    factStore.getProfileFacts(symbol).catch(() => ({ ok: false })),
    factStore.getSegmentFacts(symbol).catch(() => ({ ok: false })),
  ]);
  const parts = [];
  const meta = { maxDate: '', count: 0, isFresh: true, staleServed: false, fetchedAt: '' };
  const touch = (f, extraMax) => {
    if (!f || !f.ok) return;
    if (!f.isFresh) meta.isFresh = false;
    if (f.staleServed) meta.staleServed = true;
    if (f.fetchedAt && f.fetchedAt > meta.fetchedAt) meta.fetchedAt = f.fetchedAt;
    if (extraMax && extraMax > meta.maxDate) meta.maxDate = extraMax;
  };
  if (research.ok) {
    const c = factStore.buildResearchContext(research);
    if (c.ok) { parts.push(c.text); meta.count += c.count; }
    touch(research, c.ok ? c.maxDate : '');
  }
  if (announcements.ok) {
    const c = factStore.buildAnnouncementContext(announcements);
    if (c.ok) { parts.push(c.text); meta.count += c.count; }
    touch(announcements, c.ok ? c.maxDate : '');
  }
  if (profile.ok || segment.ok) {
    const c = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
    if (c.ok) parts.push(c.text);
    touch(profile, '');
    touch(segment, '');
  }
  if (!parts.length) return { ok: false, reason: 'NO_DATA' };
  return { ok: true, text: parts.join('\n\n'), maxDate: meta.maxDate, count: meta.count, isFresh: meta.isFresh, staleServed: meta.staleServed, fetchedAt: meta.fetchedAt };
}

async function augmentStock({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在侧边栏「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：研报/公告/概况/主营构成免费预下载，无需联网检索（抓取失败则兜底走联网）
  const localCtx = await buildAugmentContext(symbol, name).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，本地事实最新日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  const factsIsFresh = localCtx.ok ? localCtx.isFresh : true;
  const factsStale = localCtx.ok ? !!localCtx.staleServed : false;
  const factsFetchedAt = localCtx.ok ? localCtx.fetchedAt : null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = AUGMENT_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI资料补全', symbol);
    messages = [
      { role: 'system', content: AUGMENT_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地公开资料补全该公司资料（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI资料补全] ${symbol} 本地事实不可用，降级为联网模型检索`);
    messages = [
      { role: 'system', content: AUGMENT_WEB_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网补全上述资料。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol,
      stockName: name || symbol,
      content,
      sources: extractSources(content),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !factsIsFresh || factsStale, fetchedAt: factsFetchedAt,
    };
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

const ASPECTS_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，熟悉中国A股、港股与美股市场。用户会给你一家公司的名称、代码与部分已知公开资料。请你利用联网搜索能力，对该公司做出客观的"投资亮点"与"投资雷点"分析。

要求：
1) 只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"highlights":["亮点1","亮点2","亮点3"],"risks":["雷点1","雷点2","雷点3"]}
2) highlights 列出 3-6 条主要投资亮点（如行业地位、业绩增长、高分红、技术壁垒、政策利好、估值修复等）；
3) risks 列出 3-6 条主要投资风险（如估值偏高、业绩下滑、行业周期下行、政策监管、负债高、治理或商誉风险等）；
4) 每条要具体、可验证，尽量结合最新公开信息（最近一期年报/半年报/季报、最新公告、权威新闻）；不要编造无来源的数字；
5) **时效性约束（20260904a 加强）**：
   a) 涉及财务数据的亮点/雷点，**只能引用最新一期已披露财报**（最新 REPORT_DATE 对应的年报/半年报/一季报/三季报）。旧期财报（哪怕只早一个季度）只能作为**对比基准**出现（如"较上期+5%"、"同比+10%"），不得作为亮点/雷点本身的论据主体。
   b) 每条涉及财务数字的亮点/雷点，**必须同时给出三组数据**：「最新一期实际值 + 较上期环比变化 + 较去年同期同比变化」。缺一不可。
   c) 不涉及财报数据的条目（如行业地位、政策面、技术壁垒、利率敏感、治理等）不受上述强制约束，但同样禁止使用 1 年前的旧数据作为论证依据，尤其禁止出现"从 2023 年/更早的 X 提升到 2024 年/今年的 Y"这类用旧基期做对比的表述。如果某项改善/恶化主要发生在 1 年前，不应列为当前亮点/雷点。
6) 若确实缺乏某类信息，对应数组返回空数组 []。
7) **估值方法约束**：对金融/保险类公司（如中国平安），估值更适合用"内含价值(EV)"或"股息贴现模型(DDM)"来判断；不应将 DCF（现金流折现）得出的"低估/便宜"结论作为个股亮点——DCF 只能作为参考性说明，不得列入 highlights。如确需提及估值，应优先采用适合该行业的估值口径（如保险用 EV/PEV、银行用 PB、高股息用股息率/DDM），避免用 DCF 作为亮点的论证依据。`;

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

async function analyzeAspects({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_aspects.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  let name = stockName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }

  // 20260904a：注入「最新报告期」上下文给模型 + 后置校验用。
  // 来自本地财务数据库的 hub.reportDate（如 2026-06-30）；拿不到时降级为最近一年。
  const { getFinanceHub } = require('./financeHub');
  const { fetchFinancialData } = require('./deepAnalysis');
  let latestReportLabel = null; // 用于注入 prompt + 后置校验（如「2026年中报」「2026年三季报」）
  try {
    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);
    const finData = await fetchFinancialData(emCode);
    const hub = getFinanceHub(finData);
    if (hub && hub.ok && hub.reportDate) {
      latestReportLabel = hub.reportDateLabel || _reportDateToLabel(hub.reportDate);
    }
  } catch {}

  const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。`
    + (latestReportLabel ? `\n【最新报告期（必须作为亮点/雷点的财务数据基期）】：${latestReportLabel}（报告日 ${latestReportLabel.slice(0, 4)} 年）` : '')
    + `\n请联网搜索该公司最新公开信息（年报、公告、权威新闻等）后，输出其投资亮点与投资雷点。`;
  const messages = [
    { role: 'system', content: ASPECTS_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];

  try {
    // 20260904a：妙想东财资讯事实源优先（公告/新闻覆盖度足够），失败自动回退通用搜索
    const aspectsMxQuery = `${name || symbol}（${symbol}）最新财报 公告 业绩 投资亮点 投资风险 新闻`;
    const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch: true, mxQuery: aspectsMxQuery });
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.highlights) || !Array.isArray(parsed.risks)) {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析亮点/雷点。', raw: content.slice(0, 500) };
    }
    // 去重：AI 可能返回内容重复的亮点/雷点，按归一化内容去重，避免写入磁盘缓存后出现重复
    const dedupeAspect = (arr) => {
      const seen = new Set();
      const out = [];
      for (const s of (arr || [])) {
        const t = String(s).trim();
        if (!t) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
      return out;
    };
    const result = {
      symbol,
      stockName: name || symbol,
      highlights: dedupeAspect(parsed.highlights).slice(0, 6),
      risks: dedupeAspect(parsed.risks).slice(0, 6),
      date: new Date().toISOString(),
      model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
    };

    // 20260904a 后置校验：亮点/雷点若引用了非最新期财报数据，标记 outdated=true；
    // 备注「实际引用年份 = X，最新报告期 = Y」便于前端/审计追溯。不直接删除（避免 AI 输出偶尔合同时损失信息）。
    if (latestReportLabel) {
      const latestYear = parseInt(String(latestReportLabel).slice(0, 4), 10);
      if (latestYear && isFinite(latestYear)) {
        const stamp = (arr) => arr.map(s => {
          const y = _detectCitedYear(s);
          // y 可能是 null（不涉财报）或 === latestYear（合规）；< latestYear → outdated
          if (y && y < latestYear) {
            return { text: s, outdated: true, citedYear: y, latestYear, latestReportLabel };
          }
          return { text: s };
        });
        result.highlights = stamp(result.highlights);
        result.risks = stamp(result.risks);
        result.latestReportLabel = latestReportLabel;
      }
    }
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// 下载产品图片到本地缓存（避免外链失效），失败返回 false
async function downloadImage(url, destPath) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
    });
    const buf = Buffer.from(resp.data);
    const ct = (resp.headers && resp.headers['content-type']) || '';
    const isImageCt = /image\//.test(ct);
    const isMagic = buf.length >= 4 && (
      (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) || // JPEG
      (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) || // PNG
      (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) // WEBP (RIFF)
    );
    if (!isImageCt && !isMagic) return false;
    if (buf.length < 500) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

// 无 Key 兜底：按产品名在 Wikimedia Commons 搜索一张真实图片（仅取图片直链）
async function searchCommonsImage(query) {
  // 生成由"完整→去括号→去括号前→逐级缩写"的查询变体，提升命中率
  const base = (query || '').trim();
  const variants = [];
  if (base) variants.push(base);
  const noParen = base.replace(/[（(][^()]*[)）]/g, '').trim();
  if (noParen && noParen !== base) variants.push(noParen);
  const beforeParen = base.split(/[（(]/)[0].trim();
  if (beforeParen && beforeParen !== base && beforeParen.length >= 2) variants.push(beforeParen);
  const cn = base.replace(/[（(][^()]*[)）]/g, '').replace(/[^一-龥]/g, '');
  for (const len of [4, 3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(0, len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  // 后缀变体：品牌核心常在词尾（如「飞天茅台」→「茅台」）
  for (const len of [3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(-len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  const seen = new Set();
  for (const q of variants) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    try {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
        encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=500&format=json';
      const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA } });
      const pages = resp.data && resp.data.query && resp.data.query.pages;
      if (!pages) continue;
      for (const k of Object.keys(pages)) {
        const ii = pages[k].imageinfo && pages[k].imageinfo[0];
        if (ii && ii.thumburl && /image\//.test(ii.mime || '')) return ii.thumburl;
      }
    } catch {}
  }
  return '';
}

const PRODUCTS_WEB_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，擅长提炼上市公司的"产品力"。用户会给你一家公司的名称、代码、行业与已知的主营产品（可能为空）。请利用联网搜索，补全该公司的主要产品与主要客户分析。

要求：
1) 只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"products":[{"name":"产品名","desc":"一句话描述该产品及市场地位","revenueShare":35.5,"importance":"核心","imageUrl":"https://...","imageQuery":"用于搜图的关键词(品牌+产品,去括号)"},{"name":"...","imageUrl":"","imageQuery":"茅台王子酒"}],"customers":[{"name":"客户名","desc":"客户关系/合作性质","revenueShare":20.0}],"summary":"产品型公司分析摘要（2-4句）"}
2) products：列出 3-6 个主要产品；revenueShare 为该产品占该公司营业收入的大致百分比（无可靠数据填 0，不要编造）；importance 为 核心/重要/次要；imageUrl【重要】为该产品的代表性图片直链，必须是可直接打开的图片地址（以 .jpg/.jpeg/.png/.webp 结尾），优先取自官方网站、Wikimedia Commons 或权威媒体；请尽量联网查找并返回真实图片链接，仅在确实无法找到时才填 ""。imageQuery：用于联网搜索该产品图片的简洁关键词（品牌+产品，去掉括号与修饰语，如「飞天茅台」「茅台王子酒」），即使 imageUrl 为空也应尽量给出，便于后端兜底搜图。
3) customers：列出 2-5 个主要客户/客户类型；revenueShare 为该客户占营收的大致百分比（无则填 0）。
4) 若确无某类信息，对应数组返回空数组 []。不要编造数字。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的主营构成（含营收占比/毛利率）做纯推理
const PRODUCTS_LOCAL_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，擅长提炼上市公司的"产品力"。你没有联网能力，也不需要联网。下方「本地主营构成」由系统从东方财富 F10（MainOperate）预先下载，是本轮分析唯一允许引用的事实来源，包含最新年报期按产品/地区/行业维度的营收占比与毛利率。

要求：
1) 只输出一段严格的 JSON（不要任何额外说明或 Markdown 代码块标记），格式如下：
{"products":[{"name":"产品名","desc":"一句话描述该产品及市场地位","revenueShare":35.5,"importance":"核心","imageUrl":"","imageQuery":"用于搜图的关键词(品牌+产品,去括号,如 飞天茅台)"},{"name":"...","imageUrl":"","imageQuery":"茅台王子酒"}],"customers":[{"name":"客户名","desc":"客户关系/合作性质","revenueShare":20.0}],"summary":"产品型公司分析摘要（2-4句）"}
2) products：基于「本地主营构成」列出 3-6 个主要产品；revenueShare 必须取自主营构成中的营收占比（无对应项填 0，不要编造）；importance 据营收占比判定（核心/重要/次要）；imageUrl 必须填 ""（你无法联网取图）；imageQuery 尽量给出便于后端在 Wikimedia Commons 搜图的简洁关键词（品牌+产品，去掉括号与修饰语）。
3) customers：A股年报通常不逐家披露主要客户明细，若本地资料无客户依据，返回空数组 []；不要编造客户名称与占比。
4) 若确无某类信息，对应数组返回空数组 []。不要编造数字。`;

// 由 factStore 主营构成事实组装产品/客户分析上下文（供不联网模型推理）
function buildProductsContext(segment) {
  const dims = (segment && segment.dims) || {};
  const types = Object.keys(dims);
  if (!types.length) return { ok: false, reason: 'EMPTY' };
  const lines = [];
  for (const type of types) {
    const arr = dims[type] || [];
    if (!arr.length) continue;
    const l = arr.map(it => `- ${it.name}（营收占比 ${it.ratio != null ? it.ratio : '未知'}%${it.incomeYi ? `，营收 ${it.incomeYi} 亿元` : ''}${it.grossMargin != null ? `，毛利率 ${it.grossMargin}%` : ''}${it.costRatio != null ? `，成本占比 ${it.costRatio}%` : ''}）`).join('\n');
    lines.push(`■ 按${type}（${segment.year}年报期${segment.asOf ? '，' + segment.asOf : ''}）：\n${l}`);
  }
  if (!lines.length) return { ok: false, reason: 'EMPTY' };
  const text = [
    `【本地主营构成】来源：东方财富 F10（MainOperate）。以下为该公司最新年报期（${segment.year}${segment.asOf ? '，报告日 ' + segment.asOf : ''}）的分维度营收构成，请据此补全主要产品与营收占比，禁止编造本地数据未提供的数字：`,
    ...lines,
  ].join('\n');
  const count = types.reduce((s, t) => s + (dims[t] || []).length, 0);
  return { ok: true, text, maxDate: segment.asOf || '', year: segment.year, count };
}

async function analyzeProducts({ symbol, stockName, industry, force, companyName, f10Products, companyType }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_products.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：主营构成免费预下载（东财 F10 MainOperate），无需联网检索（抓取失败则兜底走联网）
  const segmentFacts = await factStore.getSegmentFacts(symbol).catch(() => ({ ok: false }));
  const localCtx = segmentFacts.ok ? buildProductsContext(segmentFacts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，主营构成年报期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  const f10 = Array.isArray(f10Products) && f10Products.length ? ('已知主营产品(来自财报)：' + f10Products.join('、') + '。') : '财报未提供主营产品明细。';
  const isProduct = companyType === 'growth' || /科技|医药|生物|医疗|电子|半导体|消费|食品|化工|材料|制造|新能源|汽车/.test(ind || '');

  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  const factsIsFresh = segmentFacts.ok ? segmentFacts.isFresh : true;
  const factsStale = segmentFacts.ok ? !!segmentFacts.staleServed : false;
  const factsFetchedAt = segmentFacts.ok ? segmentFacts.fetchedAt : null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = PRODUCTS_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI产品客户', symbol);
    const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${f10}${isProduct ? ' 该公司为产品型公司，产品分析尤为关键。' : ''}\n\n${localCtx.text}\n\n请严格基于以上本地主营构成输出主要产品与主要客户的结构化分析（不要联网、不要编造数字）。`;
    messages = [
      { role: 'system', content: PRODUCTS_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI产品客户] ${symbol} 本地主营构成不可用（${(segmentFacts && segmentFacts.message) || '未知'}），降级为联网模型检索`);
    const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${f10}${isProduct ? ' 该公司为产品型公司，产品分析尤为关键，请务必联网获取各主要产品的图片与营收占比。' : ''}请联网搜索后输出主要产品与主要客户的结构化分析。`;
    messages = [
      { role: 'system', content: PRODUCTS_WEB_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];
  }

  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.products)) {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析产品/客户。', raw: content.slice(0, 500) };
    }

    // 下载产品图片到本地缓存：本地模式 imageUrl 为空，直接用 Commons 按 imageQuery 搜图（免费，不走 LLM 计费）；
    // 联网降级模式优先用 AI 给的直链，失败再 Commons 兜底。
    const products = [];
    for (let i = 0; i < parsed.products.length; i++) {
      const p = parsed.products[i] || {};
      const pname = String(p.name || '').trim();
      const item = {
        name: pname,
        desc: String(p.desc || '').trim(),
        revenueShare: Number(p.revenueShare) || 0,
        importance: String(p.importance || '重要').trim(),
        imageUrl: String(p.imageUrl || '').trim(),
        imageQuery: String(p.imageQuery || '').trim(),
        imageLocal: '',
      };
      let cand = item.imageUrl;
      if (cand && /^https?:\/\//.test(cand)) {
        const lower = cand.toLowerCase();
        const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
        const fname = `${symbol}_p${i}.${ext}`;
        const fpath = path.join(IMG_DIR, fname);
        const ok = await downloadImage(cand, fpath);
        if (ok) item.imageLocal = `/api/ai/img/${fname}`;
      }
      if (!item.imageLocal && (item.imageQuery || pname)) {
        try { cand = await searchCommonsImage(item.imageQuery || pname); } catch {}
        if (cand && /^https?:\/\//.test(cand)) {
          const lower = cand.toLowerCase();
          const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
          const fname = `${symbol}_p${i}.${ext}`;
          const fpath = path.join(IMG_DIR, fname);
          const ok = await downloadImage(cand, fpath);
          if (ok) item.imageLocal = `/api/ai/img/${fname}`;
        }
      }
      if (item.name) products.push(item);
    }

    const customers = (parsed.customers || []).filter(c => c && c.name).map(c => ({
      name: String(c.name).trim(),
      desc: String(c.desc || '').trim(),
      revenueShare: Number(c.revenueShare) || 0,
    }));

    const result = {
      symbol,
      stockName: name || symbol,
      products,
      customers,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !factsIsFresh || factsStale, fetchedAt: factsFetchedAt,
    };
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// 通用：为某个图片候选(URL + 搜图关键词)解析出本地图片路径（优先 AI 直链，失败则 Commons 兜底）
async function attachImage(symbol, prefix, url, query) {
  const tryUrl = async (u) => {
    if (!u || !/^https?:\/\//.test(u)) return '';
    const lower = u.toLowerCase();
    const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
    const fname = `${symbol}_${prefix}.${ext}`;
    const fpath = path.join(IMG_DIR, fname);
    const ok = await downloadImage(u, fpath);
    return ok ? `/api/ai/img/${fname}` : '';
  };
  let local = await tryUrl(url);
  if (!local && query) {
    try { const c = await searchCommonsImage(query); if (c) local = await tryUrl(c); } catch {}
  }
  return local;
}

const COMPANY_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师。用户给你公司名称、代码、行业。请利用联网搜索，输出公司的综合介绍。
要求：只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"officeLocation":"公司总部/主要办公地点(城市+区或具体地址,如可查到)","productsServices":[{"name":"产品/服务名","desc":"一句话介绍与市场地位","imageUrl":"代表性图片直链(以.jpg/.jpeg/.png/.webp结尾,优先官方/Wikimedia,找不到填\"\")","imageQuery":"搜图关键词(品牌+产品,去括号)"}],"missionCulture":"经营宗旨/企业文化的核心表述(2-4句)","brands":["旗下知名自有品牌1","品牌2"],"patentCount":"专利数量(如发明专利+实用新型,给数字或区间,无可靠数据填\"\")","employeeCount":"员工人数(最新年报数,无则填\"\")","execAvgSalary":"高管平均薪酬(最新年报,如'约320万元'或区间,无则填\"\")","actualController":"实际控制人/实控人姓名,或'国有控股'/'股权分散'/'无实际控制人'等","actualControllerIntro":"对实控人的简要介绍(背景/持股主体/影响力;若不确定或没有填\"\")","majorEvents":[{"year":"YYYY","title":"事件标题","desc":"事件简述","impact":"对公司/行业的重大影响(如'利好:产能翻倍'/'利空:被处罚'/'中性:换帅')"}],"summary":"综合介绍摘要(2-4句)"}
要求：
1) majorEvents 检索该公司与所属行业近10年(财经网站/公司公告)的重大事件(并购重组、监管处罚、产能扩张、技术突破、行业政策、重大订单等),挑 3-8 条对公司或行业影响最大的；impact 必须明确利好/利空/中性。
2) brands 仅列旗下知名自有品牌；productsServices 列 3-6 个核心产品/服务,尽量给图片直链与搜图关键词。
3) 不要编造数字与图片链接；无可靠数据的字段填 "" 或空数组 []。
4) 金融/服务类公司（银行、保险、证券等）的 productsServices 应列其金融产品/服务（如零售金融、对公信贷、理财、承销保荐、资管、承保），而非实体商品；patentCount 等不适用字段填 ""。`;

// 本地模式 prompt：无联网，基于 F10 公司概况 + 主营构成生成综合介绍（未提供字段留空）
const COMPANY_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主要产品、主营构成明细含营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

请基于本地事实输出该公司综合介绍的严格 JSON（不要任何额外说明或 Markdown 代码块标记），格式：
{"officeLocation":"办公地点(本地事实提供省份则填,否则填\"\")","missionCulture":"经营宗旨/企业文化(本地事实未提供填\"\")","brands":["知名自有品牌(仅当本地事实明确提及)"],"productsServices":[{"name":"核心产品/服务名(来自主营构成)","desc":"一句话说明,必须引用真实营收占比/毛利率数字","imageUrl":"","imageQuery":"该产品搜图关键词"}],"majorEvents":[],"patentCount":"","employeeCount":"员工人数(本地事实提供才填,否则\"\")","execAvgSalary":"","actualController":"控股股东(本地事实提供才填)","actualControllerIntro":"","summary":"2-3句公司概况摘要"}

要求：
1) productsServices 从「主营构成明细」中选 3-6 个核心业务，desc 必须引用真实的占比/毛利率数字；
2) 凡本地事实未提供的字段一律填 "" 或 []，严禁用训练记忆编造（尤其 patentCount、majorEvents、execAvgSalary、brands）；
3) 金融/服务类公司 productsServices 列其金融产品/服务；
4) 只输出 JSON。`;

async function analyzeCompany({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_company.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：F10 概况 + 主营构成免费预下载（20260903f 降费）
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，概况+主营构成锚点未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factAnchor === localCtx.anchor) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factAnchor = null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factAnchor = localCtx.anchor;
    const ctxLen = COMPANY_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 300;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公司', symbol);
    messages = [
      { role: 'system', content: COMPANY_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地事实输出公司综合介绍 JSON（不要联网、不要编造）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    messages = [
      { role: 'system', content: COMPANY_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索后按 JSON 输出该公司的综合介绍（办公地点、产品服务与图片、经营宗旨/企业文化、知名品牌、专利数、员工人数、高管平均薪酬、实际控制人及介绍、近10年公司与行业重大事件）。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析公司介绍。', raw: content.slice(0, 500) };
    }
    const productsServices = [];
    const ps = Array.isArray(parsed.productsServices) ? parsed.productsServices : [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] || {};
      const imageLocal = await attachImage(symbol, 'c' + i, p.imageUrl, p.imageQuery || p.name);
      productsServices.push({
        name: String(p.name || '').trim(),
        desc: String(p.desc || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(p.imageQuery || '').trim(),
      });
    }
    const brands = Array.isArray(parsed.brands) ? parsed.brands.map(b => String(b).trim()).filter(Boolean) : [];
    const majorEvents = Array.isArray(parsed.majorEvents) ? parsed.majorEvents.map(e => ({
      year: String((e && e.year) || '').trim(),
      title: String((e && e.title) || '').trim(),
      desc: String((e && e.desc) || '').trim(),
      impact: String((e && e.impact) || '').trim(),
    })) : [];
    const result = {
      symbol,
      stockName: name || symbol,
      officeLocation: String(parsed.officeLocation || '').trim(),
      missionCulture: String(parsed.missionCulture || '').trim(),
      brands,
      patentCount: String(parsed.patentCount || '').trim(),
      employeeCount: String(parsed.employeeCount || '').trim(),
      execAvgSalary: String(parsed.execAvgSalary || '').trim(),
      actualController: String(parsed.actualController || '').trim(),
      actualControllerIntro: String(parsed.actualControllerIntro || '').trim(),
      productsServices,
      majorEvents,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

const SUPPLY_SYSTEM_PROMPT = `你是一名严谨的产业链与成本分析专家。用户给你公司名称、代码、行业。请联网搜索,输出供应链与成本分析。
要求：只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"chainPosition":"上游/中游/下游(三选一,可加括号说明,如'下游(白酒消费终端)'/ '中游(电池制造)')","materials":[{"name":"主要原材料/服务名","desc":"该材料/服务在公司生产/经营中的作用","priceTrend":"近1-3年价格变动趋势(如'上涨约20%'/'震荡下行'/'高位回落',无可靠数据填\"\")","impactOnCost":"该价格变动对公司营业成本的影响(如'成本上升侵蚀毛利'/'成本下降利好毛利',尽量量化)","imageUrl":"该原材料代表性图片直链(以.jpg/.jpeg/.png/.webp结尾,找不到填\"\")","imageQuery":"搜图关键词"}],"suppliers":[{"name":"主要供应商/供应方名","desc":"供应关系/依赖度/是否集中","imageUrl":"供应商相关图片直链(如企业Logo,找不到填\"\")","imageQuery":"搜图关键词"}],"costControl":["公司控制成本的典型方法1","方法2"],"summary":"供应链与成本分析摘要(2-4句)"}
要求：
1) chainPosition 明确公司处于产业链上/中/下游并给出理由。
2) materials 列出 3-6 个对成本影响最大的原材料/服务(如制造业的钢/铜/锂/芯片,消费业的包装/原料,服务业的外包/人力/租金),并说明价格变动与对营业成本的影响。
3) suppliers 列出 2-5 个主要供应商或供应方类型,说明依赖度。
4) costControl 给出 2-5 条真实可行的成本控制手段(如套期保值、长协锁价、规模集采、工艺改进、国产替代、数字化降本)。
5) 不要编造数字与图片链接;无可靠数据的字段填 "" 或空数组 []。
6) 金融/服务类公司（银行、保险、证券、信托等）请勿生硬套用制造业"原材料"框架：materials 改为其关键成本项（如资金成本/付息压力/人力成本/风控合规成本/赔付成本），suppliers 改为业务合作渠道或机构（如央行/同业/再保险/代销渠道/托管行），chainPosition 按"资金端—金融中介—客户端"链条定位（如"中游(金融中介)"）。此类公司高负债属经营常态，不要将其描述为风险。`;

// 本地模式 prompt：无联网，基于 F10 概况 + 主营构成（成本占比/毛利率）做产业链定位与成本结构分析
const SUPPLY_LOCAL_SYSTEM_PROMPT = `你是一名产业链与成本分析专家。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主营构成明细含各业务营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

请基于本地事实输出供应链与成本分析的严格 JSON（不要任何额外说明或 Markdown 代码块标记），格式：
{"chainPosition":"上游/中游/下游(三选一,可加括号说明)","materials":[{"name":"主要成本项/业务名(从主营构成或经营范围推导)","desc":"该项在公司经营中的作用","priceTrend":"本地事实未提供价格数据,固定填\"\")","impactOnCost":"基于成本占比/毛利率数字的定性影响(如'占营业成本大头,其毛利率波动直接决定公司整体盈利')","imageUrl":"","imageQuery":"搜图关键词"}],"suppliers":[],"costControl":["从经营范围/主营业务文本可推导的成本控制方法"],"summary":"供应链与成本分析摘要(2-4句)"}

要求：
1) chainPosition 依据行业与业务性质判断上/中/下游并给出理由；
2) materials 从「主营构成明细」中成本占比最高/毛利率最低的业务推导，impactOnCost 必须引用真实占比数字；priceTrend 一律填 ""，严禁编造价格涨跌数字；
3) suppliers 本地事实不含供应商名单，一律输出 []；
4) costControl 仅从主营业务/经营范围文本可推导时给出，否则空数组；
5) 金融/服务类公司按资金成本/人力成本框架分析，chainPosition 按"资金端—金融中介—客户端"定位；
6) 只输出 JSON。`;

async function analyzeSupplyChain({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_supply.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：F10 概况 + 主营构成（成本结构）免费预下载（20260903f 降费）
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.mode === 'local' && localCtx.ok && cached.factAnchor === localCtx.anchor) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  const isFinancial = /银行|保险|证券|信托|期货|基金|资管|财富|金控|租赁|财务|再保险|寿险|财险|人寿|太保|人保|平安/.test(ind || '') || /金融/.test(ind || '');
  const finNote = isFinancial ? ' 注意：该公司属金融服务类，请严格按金融服务框架分析（资金成本、业务合作渠道、而非制造业原材料供应商）。' : '';
  let messages, modelPick, mode, factAnchor = null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factAnchor = localCtx.anchor;
    const ctxLen = SUPPLY_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 300;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI供应链', symbol);
    messages = [
      { role: 'system', content: SUPPLY_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地事实输出供应链与成本分析 JSON（不要联网、不要编造数字）。${finNote}` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    messages = [
      { role: 'system', content: SUPPLY_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索后按 JSON 输出该公司的供应链与成本分析（产业链上中下游位置、主要原材料/服务及价格变动对成本的影响、主要供应商、成本控制方法）。${finNote}` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析供应链分析。', raw: content.slice(0, 500) };
    }
    const materials = [];
    const ms = Array.isArray(parsed.materials) ? parsed.materials : [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i] || {};
      const imageLocal = await attachImage(symbol, 's' + i, m.imageUrl, m.imageQuery || m.name);
      materials.push({
        name: String(m.name || '').trim(),
        desc: String(m.desc || '').trim(),
        priceTrend: String(m.priceTrend || '').trim(),
        impactOnCost: String(m.impactOnCost || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(m.imageQuery || '').trim(),
      });
    }
    const suppliers = [];
    const sp = Array.isArray(parsed.suppliers) ? parsed.suppliers : [];
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i] || {};
      const imageLocal = await attachImage(symbol, 'sup' + i, s.imageUrl, s.imageQuery || s.name);
      suppliers.push({
        name: String(s.name || '').trim(),
        desc: String(s.desc || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(s.imageQuery || '').trim(),
      });
    }
    const costControl = Array.isArray(parsed.costControl) ? parsed.costControl.map(c => String(c).trim()).filter(Boolean) : [];
    const result = {
      symbol,
      stockName: name || symbol,
      chainPosition: String(parsed.chainPosition || '').trim(),
      materials,
      suppliers,
      costControl,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

const HOLDERS_SYSTEM_PROMPT = `你是金融数据助手。请联网搜索指定 A 股公司最新的"股东户数"（普通股股东总数）及近几年变化趋势，并注明数据来源报告期。
严格只输出 JSON，不要任何额外说明或 Markdown 代码块标记，格式：
{"holderCount":123456,"asOf":"2025-03-31","trend":"近一年股东户数从约 50 万升至 58 万，散户参与度提升","source":"东方财富/公司季报"}
- holderCount 为整数（未知填 0）；asOf 为该数据对应报告期(YYYY-MM-DD)；trend 为 1-2 句变化描述；source 为来源说明。
不要编造数字；无可靠公开数据时 holderCount 填 0、trend 填"暂无可靠公开数据"。`;

// 本地模式 prompt：无联网能力，只能基于本地 F10 股东户数走势数据解读
const HOLDERS_LOCAL_SYSTEM_PROMPT = `你是严谨的金融数据分析师。你没有联网能力，只能基于下方「本地数据库（东方财富 F10）」提供的股东户数走势数据完成解读分析。

要求：
1) 严格只输出 JSON，不要任何额外说明或 Markdown 代码块，格式：
{"holderCount":123456,"asOf":"2025-03-31","trend":"...","source":"本地F10数据库"}
2) holderCount = 本地数据中最新一期的股东户数（整数，未知填 0）；asOf = 该数据对应报告期(YYYY-MM-DD)；
3) trend = 用 1-2 句话描述股东户数变化趋势（趋于集中还是分散、加速度/减速、是否拐点），必须基于所给序列计算，不得编造；
4) source 固定填写「本地F10数据库（东方财富）」；
5) 严禁编造本地数据之外的任何数字或信息。`;

// 本地模式：注入本地 F10 股东户数走势（不联网，使用 modelLocal）
async function buildLocalHoldersContext(symbol) {
  try {
    const sd = require('./shareholderData');
    const data = await sd.getShareholdersData(symbol);
    const trend = (data && Array.isArray(data.holderCountTrend)) ? data.holderCountTrend : [];
    if (!trend.length) return { ok: false, text: '', asOf: '', seriesCount: 0 };
    const recent = trend.slice(-8);
    const lines = recent.map(r => {
      const chg = r.changeRatio != null ? ` 环比 ${r.changeRatio > 0 ? '+' : ''}${r.changeRatio}%` : '';
      const focus = r.focus ? ` 集中度：${r.focus}` : '';
      return `报告期 ${r.date}：股东户数 ${r.holderNum.toLocaleString('zh-CN')} 户${chg}${focus}`;
    });
    return {
      ok: true,
      text: lines.join('\n'),
      asOf: recent[recent.length - 1].date,
      seriesCount: trend.length,
    };
  } catch (e) {
    console.error('[buildLocalHoldersContext] failed:', e.message);
    return { ok: false, text: '', asOf: '', seriesCount: 0 };
  }
}

async function analyzeShareholdersAI({ symbol, stockName, force, mode }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const localCtx = await buildLocalHoldersContext(symbol);
  const wantLocal = mode === 'local' && localCtx.ok;
  const cacheFile = path.join(CACHE_DIR, `${symbol}_holders.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - (cached.cachedAt || 0) < CACHE_TTL_MS) {
        // 模式匹配：请求模式与缓存模式不一致即作废重算（双向对称，避免 web 请求复用 local 缓存导致 source/modelKind 标注错乱）
        if (wantLocal !== (cached.mode === 'local')) { /* fall through to regenerate */ }
        else return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let modelPick, systemPrompt, userMsg, modeLabel;
  if (wantLocal) {
    modelPick = pickModelFor(cfg, 'local');
    systemPrompt = HOLDERS_LOCAL_SYSTEM_PROMPT;
    userMsg = `以下是本地数据库（东方财富 F10）中的股东户数走势数据：\n\n${localCtx.text}\n\n请严格基于以上本地数据完成解读分析（不要联网、不要编造数字），输出 JSON：{holderCount, asOf, trend, source}。`;
    modeLabel = 'local';
  } else {
    modelPick = pickModelFor(cfg, 'web');
    systemPrompt = HOLDERS_SYSTEM_PROMPT;
    userMsg = `请联网搜索 A 股公司「${stockName || symbol}」（代码 ${symbol}）最新的股东户数（普通股股东总数）及近几年变化趋势，并注明数据来源报告期。`;
    modeLabel = 'web-fallback';
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ], { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    const result = {
      symbol,
      stockName: stockName || '',
      holderCount: parsed && Number(parsed.holderCount) ? Number(parsed.holderCount) : 0,
      asOf: parsed ? String(parsed.asOf || '') : '',
      trend: parsed ? String(parsed.trend || '') : '',
      source: parsed ? String(parsed.source || '') : '',
      date: new Date().toISOString().slice(0, 10),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      modelKind: modelPick.isLocal ? 'local' : 'web',
      mode: modeLabel,
      localDataUsed: wantLocal,
      localAsOf: wantLocal ? localCtx.asOf : '',
      localSeriesCount: wantLocal ? localCtx.seriesCount : 0,
      cachedAt: Date.now(),
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---- 大盘/板块 AI 解读（首页滚动条） ----
const MARKET_OVERVIEW_TTL_MS = 4 * 60 * 60 * 1000; // 行情变化快，缓存 4 小时
const MARKET_OVERVIEW_PROMPT = `你是一名 A 股市场分析师。请根据用户提供的今日大盘指数、涨幅前五板块、跌幅前五板块的实时数据，并结合联网搜索到的最新宏观/政策/事件信息，分别生成一段简短的中文市场解读（用于首页滚动字幕，每段 50-100 字）。

必须只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块，格式如下：
{"cn":"对 A 股大盘整体走势的 1 句精炼点评...","gainers":"对涨幅最大板块及其上涨驱动因素的 1 句点评...","losers":"对跌幅最大板块及其下跌原因的 1 句点评..."}

要求：
1) 每段控制在 50-100 个汉字，适合横向滚动展示；
2) 基于用户给出的具体指数/板块名称和涨跌幅，不要编造无来源的数字；
3) 点评要有信息量（驱动逻辑、资金流向、政策/事件），不要仅复述涨跌；
4) 使用简体中文。`;

async function analyzeMarketOverview({ data, force, readOnly }) {
  ensureDirs();
  const cacheFile = path.join(CACHE_DIR, 'market_overview.json');
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const stillFresh = Date.now() - (cached.cachedAt || 0) < MARKET_OVERVIEW_TTL_MS;
      if (stillFresh) {
        return { success: true, ...cached, cached: true };
      }
      if (readOnly) {
        return { success: false, cached: false };
      }
    } catch {}
  }
  if (readOnly) {
    return { success: false, cached: false };
  }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }

  const cn = (data && data.cn) || [];
  const sectorsUp = (data && data.sectorsUp) || [];
  const sectorsDown = (data && data.sectorsDown) || [];

  const summary = {
    cn: cn.map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    gainers: sectorsUp.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? '+' + i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    losers: sectorsDown.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
  };

  const userMsg = `请结合联网搜索，对以下今日 A 股行情给出三段滚动解读：
【大盘指数】${summary.cn || '暂无数据'}
【涨幅前5板块】${summary.gainers || '暂无数据'}
【跌幅前5板块】${summary.losers || '暂无数据'}`;

  try {
    // 20260904a：妙想事实源优先（东财要闻覆盖大盘/板块/宏观），失败自动回退通用搜索
    const marketMxQuery = `今日A股大盘行情解读 宏观政策事件（涨幅居前板块：${(data && data.sectorsUp || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}；跌幅居前：${(data && data.sectorsDown || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}）`;
    const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, [
      { role: 'system', content: MARKET_OVERVIEW_PROMPT },
      { role: 'user', content: userMsg },
    ], { webSearch: true, mxQuery: marketMxQuery });
    const parsed = extractJson(content) || {};
    const result = {
      cn: String(parsed.cn || '').trim(),
      gainers: String(parsed.gainers || '').trim(),
      losers: String(parsed.losers || '').trim(),
      model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      date: new Date().toISOString(),
      cachedAt: Date.now(),
      // 溯源：妙想命中时为 mx-first，回退时为空
      factSource: '东方财富妙想AI',
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---- 行业板块指数（AI 联网搜索） ----
const INDUSTRY_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 指数数据时效性强，缓存 1 天

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}
function industryIndexCacheFile(induCode, industryName) {
  const key = induCode ? String(induCode) : safeName(industryName || 'unknown');
  return path.join(CACHE_DIR, `industry_index_${key}.json`);
}
function readIndustryIndexCache(induCode, industryName) {
  try {
    const f = industryIndexCacheFile(induCode, industryName);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

const INDUSTRY_INDEX_PROMPT = `你是一名专业的行业指数研究员，熟悉 A 股的申万行业指数、中证行业/主题指数、国证行业指数等。用户会给你一个行业名称（可能含申万一级/二级行业、证监会细分行业、东方财富行业分类）。请利用联网搜索，找到代表该行业的板块指数，并给出指数的表现与走势分析。

要求：
1) 只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"indexName":"代表性行业指数名称(如'中证白酒指数')","indexCode":"指数代码(如'399997',不确定填\"\")","currentLevel":"当前点位(如'约 13200 点'或'13245.6',确实查不到填\"\")","asOf":"数据日期(YYYY-MM-DD,尽量用最近交易日)","ytdChangePct":"年初至今涨跌幅(如'+12.3%'或'-5.6%',确实查不到填\"\")","recentTrend":"近3-6个月该行业指数走势描述(2-4句,含关键拐点与驱动)","keyDrivers":["驱动因素1","驱动因素2","驱动因素3"],"outlook":"后市展望与风险(2-4句)","valuationNote":"当前估值/历史分位说明(1-2句,无则填\"\")","source":"数据来源(如'中证指数公司/东方财富/Wind,数据截至 YYYY-MM-DD')"}

2) indexName 应是该行业最具代表性的行业/主题指数；若有多只(如申万行业指数与中证主题指数),优先选流动性与代表性最好的那只。
3) 数字务必基于联网搜索到的公开数据，不要编造；若确实查不到精确点位或涨跌幅，对应字段填 ""，并在 recentTrend 中说明"未能获取精确数据，以下为定性判断"。
4) keyDrivers 列 2-4 条核心驱动（政策/景气/资金/供需/估值修复等）。
5) 使用简体中文。`;

// 进程内去重锁：避免同一行业被并发触发多次后台生成（覆盖写缓存）
const _industryIndexRunning = new Set();

async function analyzeIndustryIndex({ symbol, industryName, induName, induCode, force, background }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = industryIndexCacheFile(induCode, industryName);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - (cached.cachedAt || 0) < INDUSTRY_INDEX_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  const indLabel = [induName, industryName].filter(Boolean).join(' / ') || (symbol || '该行业');
  const userMsg = `请联网搜索并分析以下行业的代表板块指数表现：行业 = ${indLabel}${induCode ? '（东方财富行业代码 ' + induCode + '）' : ''}。请按 JSON 输出该行业板块指数的名称、代码、当前点位、年初至今涨跌幅、近期走势、核心驱动、后市展望与估值分位。`;
  const messages = [
    { role: 'system', content: INDUSTRY_INDEX_PROMPT },
    { role: 'user', content: userMsg },
  ];

  const runJob = async () => {
    try {
      // 20260904a：妙想行业资讯增强（驱动/景气/政策），仍保留通用搜索（识别代表指数代码/点位需要）
      const industryMxQuery = `行业板块「${indLabel}」指数 近期走势 核心驱动 政策 资金`;
      const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch: true, mxInject: true, mxQuery: industryMxQuery });
      const parsed = extractJson(content) || {};
      const result = {
        status: 'done',
        symbol: symbol || '',
        indexName: String(parsed.indexName || '').trim(),
        indexCode: String(parsed.indexCode || '').trim(),
        currentLevel: String(parsed.currentLevel || '').trim(),
        asOf: String(parsed.asOf || '').trim(),
        ytdChangePct: String(parsed.ytdChangePct || '').trim(),
        recentTrend: String(parsed.recentTrend || '').trim(),
        keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.map(d => String(d).trim()).filter(Boolean).slice(0, 5) : [],
        outlook: String(parsed.outlook || '').trim(),
        valuationNote: String(parsed.valuationNote || '').trim(),
        source: String(parsed.source || '').trim(),
        model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
        date: new Date().toISOString(),
        cachedAt: Date.now(),
      };
      try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
      return result;
    } catch (e) {
      const status = e.response && e.response.status;
      const data = e.response && e.response.data;
      let message = e.message;
      if (data) {
        if (typeof data === 'string') message = data.slice(0, 300);
        else if (data.message) message = data.message;
        else if (data.error && data.error.message) message = data.error.message;
      }
      const errObj = { status: 'error', error: 'API_ERROR', statusCode: status, message, symbol: symbol || '', cachedAt: Date.now() };
      try { fs.writeFileSync(cacheFile, JSON.stringify(errObj, null, 2), 'utf8'); } catch {}
      return errObj;
    }
  };

  // 后台模式：立即返回，真正的生成在后台异步完成；前端通过轮询 GET 读取 running / done / error 状态。
  // 即使前端断开（切页面/切股票/刷新），Node 进程仍会继续把结果写入缓存。
  if (background) {
    const lockKey = induCode ? String(induCode) : safeName(industryName);
    if (_industryIndexRunning.has(lockKey)) {
      return { success: true, started: false, running: true, status: 'running', background: true };
    }
    // 写 running 占位，前端可立即感知"进行中"
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ status: 'running', startedAt: Date.now(), symbol: symbol || '' }, null, 2), 'utf8');
    } catch {}
    _industryIndexRunning.add(lockKey);
    runJob().finally(() => { _industryIndexRunning.delete(lockKey); });
    return { success: true, started: true, status: 'running', background: true };
  }

  // 同步模式（保留兼容）：等待生成完成后再返回
  await runJob();
  const final = readIndustryIndexCache(induCode, industryName);
  if (final && final.status === 'done') return { success: true, ...final, cached: false };
  if (final && final.status === 'error') return { success: false, error: final.error, message: final.message };
  return { success: false, error: 'EMPTY', message: '未生成数据' };
}

// ---------- 研报 · AI 联网总结 ----------
const RESEARCH_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股、港股与美股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司近一年（12个月）主流券商/研究机构发布的研报，并总结核心结论。

要求：
1) 综合多家机构的一致预期与分歧；
2) 概括近期评级分布（买入/增持/中性/减持等）以及平均或最高目标价（如有可靠来源）；
3) 提炼 3-5 条核心投资逻辑与主要风险提示；
4) 每条尽量标注信息来源（机构名）与日期；
5) 若某类信息无可靠公开来源，请明确写"暂无可靠公开研报信息"，不要编造数字。
用简体中文分点结构化输出，总长控制在 700 字以内。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的东财研报列表做纯推理汇总
const RESEARCH_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。你没有联网能力，也不需要联网。下方「本地研报列表」由系统从东方财富研报接口预先下载（近一年券商研报的机构、评级、目标价、预测EPS/PE与标题），是本轮分析唯一允许引用的事实来源。

要求：
1) 综合多家机构的一致预期与分歧（结合预测EPS/PE区间）；
2) 概括评级分布（买入/增持/中性/减持等）以及目标价区间（最高/最低/平均，仅当列表提供时）；
3) 从研报标题中提炼 3-5 条核心投资逻辑与主要风险提示；
4) 每条标注机构名与发布日期；
5) 严禁使用你训练记忆中的任何机构观点、目标价或评级；列表未覆盖的信息一律写"本地研报列表未提供"，不要编造数字。
用简体中文分点结构化输出，总长控制在 700 字以内。`;

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

async function analyzeResearchReports({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_research.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：东财研报列表免费预下载，无需联网检索（抓取失败则兜底走联网）
  const facts = await factStore.getResearchFacts(symbol).catch(() => ({ ok: false }));
  const localCtx = facts.ok ? factStore.buildResearchContext(facts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，研报列表最新一篇日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = RESEARCH_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI研报', symbol);
    messages = [
      { role: 'system', content: RESEARCH_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地研报列表完成总结分析（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI研报] ${symbol} 本地研报列表不可用（${(facts && facts.message) || '未知'}），降级为联网模型检索`);
    messages = [
      { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司近一年券商研报，输出总结。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol, stockName: name || symbol, summary: content, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !facts.isFresh || !!facts.staleServed, fetchedAt: facts.fetchedAt,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---------- 公告 · AI 联网总结 ----------
const ANNOUNCEMENT_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司近一年（12个月）的重要公告与事项，并总结结论。

重点覆盖以下类别，逐类说明（无该类信息则写"无"）：
1) 股东增持：增持价格上限、已增持数量/金额、剩余未完成金额；
2) 股东减持：已完成数量/金额、剩余未减持数量/金额、截止日期；
3) 股份回购：完成度（%）、回购均价、回购金额；
4) 高管/董事变动（增聘、离任、被查等）；
5) 证监会立案或行政处罚、监管函、问询函；
6) 重大诉讼或仲裁（含对公司影响）。

要求：用简体中文分点结构化输出；每条尽量标注日期与来源（巨潮/交易所/东方财富等）；不要编造无来源的数字；若确无公开信息写"暂无相关公开公告"。总长控制在 800 字以内。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的公告列表（巨潮优先/东财兜底）做纯推理总结
const ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。你没有联网能力，也不需要联网。下方「本地公告列表」由系统从巨潮资讯网/东方财富预先下载（近一年公告标题、日期、系统自动分类、正文关键数字提取），是本轮分析唯一允许引用的事实来源。

重点覆盖以下类别，逐类说明（无该类信息则写"无"）：
1) 股东增持：增持价格上限、已增持数量/金额、剩余未完成金额；
2) 股东减持：已完成数量/金额、剩余未减持数量/金额、截止日期；
3) 股份回购：完成度（%）、回购均价、回购金额；
4) 高管/董事变动（增聘、离任等，按公告标题归纳）；
5) 立案/处罚/监管（如有）；
6) 重大诉讼或仲裁（如有）。

要求：
- 只做归纳、计数与时间线整理，数字一律取自列表括号内的系统提取值；提取值为空的不要自行补充数字；
- 严禁使用你训练记忆中的任何公告内容；列表未覆盖的信息写"本地公告列表未提供"；
- 用简体中文分点结构化输出，总长控制在 800 字以内。`;

async function analyzeAnnouncements({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_announcements.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：公告列表免费预下载（巨潮优先/东财兜底），无需联网检索
  const facts = await factStore.getAnnouncementFacts(symbol, name).catch(() => ({ ok: false }));
  const localCtx = facts.ok ? factStore.buildAnnouncementContext(facts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，公告列表最新一条日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公告', symbol);
    messages = [
      { role: 'system', content: ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地公告列表完成总结分析（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI公告] ${symbol} 本地公告列表不可用（${(facts && facts.message) || '未知'}），降级为联网模型检索`);
    messages = [
      { role: 'system', content: ANNOUNCEMENT_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司近一年重要公告与事项，输出总结。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol, stockName: name || symbol, summary: content, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !facts.isFresh || !!facts.staleServed, fetchedAt: facts.fetchedAt,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---------- 最新财报解读 · AI 联网分析（最新一季度财报） ----------
// prompt 有变时递增此版本号，使旧缓存自动失效重拉（避免 7 天 TTL 内继续展示旧解读口径）
const EARNINGS_PROMPT_VERSION = '20260904c'; // 20260904c：修正 reportPeriod 提取（/m 全行匹配，AI 把「标的」行置于「报告期」行之前时仍能取到）+ summary 无条件剥离「报告期/标的」行；联网 AI 主路径 + 身份确认（防串公司）保持不变

// 本地上下文长度预算（字符）：qwen-math-turbo 输入上限仅 3072 tokens（约 3000 汉字），
// 装不下「system prompt + 近8期结构化表 + 同期 PDF 节选」；超预算时升级为 modelWeb（不开联网）。
const LOCAL_CTX_CHAR_BUDGET = { 'qwen-math-turbo': 3000, 'qwen-math-plus': 3000 };
const DEFAULT_LOCAL_CTX_CHAR_BUDGET = 6000;

const EARNINGS_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。

【身份确认（最高优先级）】你正在分析的是用户在消息中明确指定的公司（名称 + 6 位代码）。以下所有营业收入、归母净利润、扣非净利润、报告期等数据，必须严格对应该标的；严禁混入其他任何公司（例如中国平安 601318、贵州茅台 600519 等）的财务数据。若联网检索结果指向了错误的公司，必须立即纠正标的，或明确声明「未找到该公司最新财报」，绝不可张冠李戴。

输出格式（严格）：
第 1 行：标的：{公司名}（{代码}）（例如「标的：士兰微（600460）」，必须与用户给出的公司完全一致）
第 2 行：报告期：YYYY年X季报（例如「报告期：2026年中报」）
第 3 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 4 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（无该信息则写"暂无公开信息"）：
1) 最新报告期：明确是哪一期（如 2026 年中报 / 2025 年年报），披露日期；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润、扣非净利润，以及各自同比（YoY）与环比（QoQ/较上季）变化，单位统一为「亿元」。
   - 必须同时计算并说明「较去年同期的变化是加速还是放缓」。例如：营收 2025 年上半年同比 +7.59%，2026 年上半年同比 +6.01%，虽然仍为正增长，但同比增速放缓 1.58 个百分点，属于边际走弱，不能简单判为利好。
   - 必须同时计算并说明「较上一季度（QoQ）的趋势」，并给出变化率。
   - 若核心指标同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：营收/利润增长或下滑的主要业务线、产品、区域或成本费用原因；
4) 亮点：超预期项、毛利率/净利率改善、订单/合同负债等前瞻信号；
5) 风险与隐忧：减值、商誉、现金流恶化、负债率上升、监管或诉讼等；
6) 与一致预期/历史同期对比：是否超预期或不及预期；
7) 管理层展望/指引（如有）；
8) 再次总结：用一句话重复综合结论，确保结论清晰。

要求：用简体中文分点结构化输出；不要孤立解读当期数字（如「营收增长 6.01%」不能直接判定为利好），必须结合同比、环比与边际变化给出定性；尽量标注数据来源（公司公告/巨潮/交易所/东方财富/同花顺等）与报告期；不要编造无来源的数字；若确无最新财报公开信息写"暂无相关公开财报"。总长控制在 800 字以内。`;

// ---------- 本地模式：分析本地数据库财报数据（不联网，使用 modelLocal） ----------
// 用途归类：财报解读只需要「分析已存在于本地财务数据库 / 已上传财报清单」的数据，
// 不需要模型去联网检索，因此切到本地模型（webSearch=false），并以本地数据作为唯一事实来源。
const EARNINGS_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。

【重要】你没有联网能力，也不需要联网。下方「本地财报数据」由系统从本地读取，是本轮分析唯一允许引用的事实来源，包含两部分：
①「近 8 期核心指标」结构化表（本地财务数据库，东方财富F10财报）——所有数字类结论的唯一事实来源；
②「同期财报原文节选」（本地资料库 PDF，如有）——公司披露的原文，用于业务构成、经营讨论、驱动因素、风险提示等定性背景。
严禁使用你训练记忆中的任何财务数字，严禁推测、估算或编造数据。PDF 节选中的数字仅当与结构化表一致（或结构化表未覆盖且明确标注来源）时方可引用；两者冲突时一律以结构化表为准。凡本地数据未提供的指标，一律写"本地数据未提供"，不得凭印象补充。

输出格式（严格）：
第 1 行：报告期：YYYY年X季报（例如「报告期：2026年中报」，以本地数据的最新报告期为准）
第 2 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 3 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（本地数据未提供则写"本地数据未提供"）：
1) 最新报告期：明确是哪一期，并标注数据时间与数据来源；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润，各自的同比（YoY）与环比（较上一期）变化，单位统一为「亿元」。
   - 必须基于本地数据计算并说明「较去年同期的变化是加速还是放缓」，给出具体百分点。
   - 例如：营收本期同比 +6.01%、上期同比 +7.59%，仍为正增长但增速放缓 1.58 个百分点，属边际走弱，不能简单判为利好。
   - 若同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：优先引用 PDF 节选中「管理层讨论与分析/经营情况」披露的业务线、产品、区域、成本费用等真实原因（标注为公司披露）；结构化表能推断的原因须明确标注是推断；
4) 亮点：增速回升、降幅收窄等可从数据中直接验证的项；PDF 节选中披露的积极经营信号（如新品、渠道、订单）可一并说明；
5) 风险与隐忧：增速放缓、降幅扩大、边际走弱等可从数据中直接验证的项；PDF 节选「风险因素/可能面对的风险」章节披露的风险须逐条转述（这是数据完整性的重点）；
6) 数据可信度自查：仅一句概括，点明**实际已覆盖的字段**（如"覆盖：营收、归母净利、近 8 期核心指标"）与**实际未覆盖的具体字段名**（如"未覆盖：扣非净利、经营现金流、资产负债、一致预期"）。严禁对每个未列出的字段单独写一行同样的"数据不可验证"等套话；若有同期 PDF 原文支撑则注明。
7) 再次总结：用一句话重复综合结论，确保结论清晰。

要求：用简体中文分点结构化输出；不要孤立解读当期数字，必须结合同比、环比与边际变化给出定性；
结构化表数字后标注「（本地财报数据，报告期 XXXX-XX-XX，来源：东方财富F10财报）」，PDF 节选取材的定性内容标注「（资料库PDF：{PDF 报告期}）」；总长严格控制在 800 字以内（超出会被截断，且重复行会被折叠）。`;

/**
 * 构建「本地财报上下文」——供本地模型分析，不联网。
 * 数据来源（规则一 · 指标级单源）：东方财富 F10 财报（lrbAjaxNew），经 lib/financeHub 输出五要素 + 同比 + 边际。
 * @param {string} symbol 6 位股票代码（或 sh600000 形式）
 * @returns {{ok:boolean, text?:string, reportDate?:string, series?:Array, docs?:Array, reason?:string}}
 */
// 从资料库文档中挑选与最新报告期最匹配的财报 PDF（20260902j）。
// 匹配优先级：同期完整报告 > 同期摘要 > 最近一期同类型完整报告 > 最近一期同类型摘要。
// 报告期从文件名/标题解析（如 603288_2026-08-27_海天味业2026年半年度报告.pdf → 2026年中报）。
// 注意：doc.year 是披露年份（年报比报告期晚一年），因此一律以文件名中的报告期年份为准。
function pickReportDoc(docs, reportDate) {
  if (!Array.isArray(docs) || !docs.length || !reportDate) return null;
  const rd = String(reportDate).slice(0, 10);
  const md = rd.slice(5); // MM-DD
  const targetYear = rd.slice(0, 4);
  const targetStage = md === '12-31' ? 'annual' : md === '06-30' ? 'semi'
    : md === '03-31' ? 'q1' : md === '09-30' ? 'q3' : '';
  if (!targetStage) return null;

  const STAGE_PAT = {
    semi: /(\d{4})年(?:半年度|中期)报告/,
    annual: /(\d{4})年年度报告/,
    q1: /(\d{4})年第?一季/,
    q3: /(\d{4})年第?三季/,
  };
  const STAGE_LABEL = { annual: '年报', semi: '中报', q1: '一季报', q3: '三季报' };

  const parsed = docs.map(d => {
    const fn = `${d.fileName || ''} ${d.title || ''}`;
    let stage = null, year = '';
    for (const [st, pat] of Object.entries(STAGE_PAT)) {
      const m = fn.match(pat);
      if (m) { stage = st; year = m[1]; break; }
    }
    return { doc: d, stage, year, isAbstract: /摘要/.test(fn) };
  }).filter(p => p.stage && p.year && /\.pdf$/i.test(String(p.doc.fileName || '')));

  const sameStage = parsed.filter(p => p.stage === targetStage);
  if (!sameStage.length) return null;

  const exact = sameStage.filter(p => p.year === targetYear);
  const pool = exact.length ? exact : sameStage.filter(p => p.year < targetYear);
  if (!pool.length) return null;
  // 报告期年份最新优先；完整报告优先于摘要
  pool.sort((a, b) => (Number(b.year) - Number(a.year)) || (a.isAbstract - b.isAbstract));
  const best = pool[0];
  return {
    doc: best.doc,
    periodLabel: `${best.year}年${STAGE_LABEL[best.stage]}`,
    exactMatch: best.year === targetYear,
  };
}

async function buildLocalEarningsContext(symbol, opts = {}) {
  const { pdfCharCap = 28000 } = opts; // 0 = 不注入 PDF（本地模型上下文装不下且无 modelWeb 可升级时）
  try {
    // 延迟 require：deepAnalysis 顶层依赖 aiAugment（readCache），此处顶层 require 会形成循环依赖
    const { fetchFinancialData } = require('./deepAnalysis');
    const { getFinanceHub } = require('./financeHub');
    const docStore = require('./docStore');

    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);

    const finData = await fetchFinancialData(emCode);
    const hub = getFinanceHub(finData);
    if (!hub || !hub.ok) {
      return { ok: false, reason: (hub && hub.error) || '本地财务数据不可用' };
    }

    // 近 8 期营收 / 归母净利润明细（供本地模型自行计算同比与环比）
    const rows = (finData.income || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        revenue: Number(r.TOTAL_OPERATE_INCOME),
        netProfit: Number(r.PARENT_NETPROFIT),
        deduct: (r.DEDUCT_PARENT_NETPROFIT != null && r.DEDUCT_PARENT_NETPROFIT !== '')
          ? Number(r.DEDUCT_PARENT_NETPROFIT) : null,
      }))
      .filter(r => r.reportDate && (isFinite(r.revenue) || isFinite(r.netProfit)));
    if (!rows.length) return { ok: false, reason: '本地财报无可用明细行' };

    const yi = v => (isFinite(v) ? (v / 1e8).toFixed(2) : '--');
    const table = rows.map(r =>
      `- ${r.reportDate}（${r.periodName || '—'}）：营业收入 ${yi(r.revenue)} 亿元；归母净利润 ${yi(r.netProfit)} 亿元` +
      (r.deduct != null && isFinite(r.deduct) ? `；扣非归母净利润 ${yi(r.deduct)} 亿元` : '')
    ).join('\n');

    // 20260906（v4）：现金流量表 + 资产负债表关键科目注入（修复 AI 自搜旧年份/错误数据违反数据一致性，
    // 如圣湘生物曾被 AI 误引"2025 年报经营现金流 18.7 亿/商誉 0"，实际本地三表齐全且新）
    const cfRows = (finData.cashflow || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        operating: Number(r.NETCASH_OPERATE),
        salesCash: Number(r.SALES_SERVICES),
      }))
      .filter(r => r.reportDate && (isFinite(r.operating) || isFinite(r.salesCash)));
    const cfTable = cfRows.length
      ? cfRows.map(r =>
          `- ${r.reportDate}（${r.periodName || '—'}）：经营现金流净额 ${yi(r.operating)} 亿元` +
          (isFinite(r.salesCash) ? `；销售商品收现 ${yi(r.salesCash)} 亿元` : '')
        ).join('\n')
      : '（现金流量表暂无可用明细行）';

    const latestBal = (finData.balance || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .pop();
    let balBlock = '';
    if (latestBal) {
      const balItems = [
        ['总资产', latestBal.TOTAL_ASSETS], ['总负债', latestBal.TOTAL_LIABILITIES], ['归母净资产', latestBal.TOTAL_PARENT_EQUITY],
        ['货币资金', latestBal.MONETARYFUNDS], ['应收账款', latestBal.ACCOUNTS_RECE], ['存货', latestBal.INVENTORY],
        ['商誉', latestBal.GOODWILL], ['固定资产', latestBal.FIXED_ASSET], ['短期借款', latestBal.SHORT_LOAN],
      ];
      const balDate = String(latestBal.REPORT_DATE || '').slice(0, 10);
      const balName = latestBal.REPORT_DATE_NAME || balDate;
      const balLines = balItems
        .filter(([, v]) => v != null && v !== '' && isFinite(Number(v)))
        .map(([k, v]) => `${k} ${yi(Number(v))} 亿元`).join('；');
      balBlock = `■ 资产负债表关键科目（最新报告期 ${balDate}（${balName}），单位：亿元）\n- ${balLines || '（无可用科目）'}`;
    }

    // 已上传财报清单（资料库）——文档库 stockCode 为裸码（如 688289），带前缀 symbol 须归一化
    // （20260906 修复：此前带前缀查询精确匹配永远落空，PDF 节选从未注入成功）
    let docs = [];
    try { docs = docStore.listCompanyDocuments(String(symbol).replace(/^(sh|sz|bj)/i, '')) || []; } catch (e) { docs = []; }
    const docLine = docs.length
      ? docs.slice(0, 12).map(d => `${d.typeName || d.type}｜${d.title || d.fileName}${d.year ? `（${d.year}年）` : ''}`).join('；')
      : '本地资料库暂无已上传财报文件';

    // ---- 同期财报 PDF 正文节选（20260902j）：提取与最新报告期匹配的 PDF 前 N 页，
    // 用于补充业务构成/经营讨论/风险提示等定性背景；数字事实源仍以结构化表为准 ----
    let docInfo = null;
    let pdfExcerpt = null;
    const picked = pdfCharCap > 0 ? pickReportDoc(docs, hub.reportDate) : null;
    if (picked && picked.doc) {
      try {
        const { getDocumentPath } = docStore;
        const resolved = getDocumentPath(picked.doc.id);
        const pdfPath = resolved && resolved.fullPath;
        if (pdfPath) {
          const pdf = require('./pdfText');
          const ext = await pdf.extractPdfText(pdfPath, { maxPages: 40, charCap: pdfCharCap });
          // 正文过短视为无效（扫描件无文本层），跳过注入不阻塞主流程
          if (ext.ok && ext.text && ext.text.replace(/\s/g, '').length >= 300) {
            docInfo = {
              fileName: picked.doc.fileName,
              periodLabel: picked.periodLabel,
              exactMatch: picked.exactMatch,
              pages: ext.pages,
              totalPages: ext.total_pages,
              truncated: !!ext.truncated,
              cached: !!ext.cached,
            };
            pdfExcerpt = [
              `■ 同期财报原文节选（本地资料库：${picked.doc.fileName}，覆盖报告期 ${picked.periodLabel}${picked.exactMatch ? '' : '（非最新一期，为最近可得同期报告）'}）`,
              `（节选前 ${ext.pages} 页${ext.truncated ? '，已截断' : ''}；本节用于业务构成、经营讨论、风险提示等定性背景；其中数字仅当与结构化表一致时方可引用，冲突时以结构化表为准）`,
              ext.text,
            ].join('\n');
          } else if (!ext.ok) {
            console.warn(`[财报解读PDF] ${symbol} 提取失败: ${ext.error}`);
          }
        }
      } catch (e) {
        console.warn(`[财报解读PDF] ${symbol} 注入异常（不影响解读主流程）: ${e.message}`);
      }
    }

    const gm = hub.growthMarginal || {};
    const labelOf = k => (k === 'TOTAL_OPERATE_INCOME' ? '营业收入' : '归母净利润');
    const marginalLines = ['TOTAL_OPERATE_INCOME', 'PARENT_NETPROFIT']
      .map(k => (gm[k] && gm[k].available
        ? `  · ${gm[k].text}`
        : `  · ${labelOf(k)}：${(gm[k] && gm[k].reason) || '不足三期，无法计算增速的边际'}`))
      .join('\n');

    const text = [
      `【本地财报数据｜公司代码 ${symbol}】`,
      `数据来源：${hub.source}；最新报告期（数据时间）：${hub.reportDate}；获取时间：${hub.fetchedAt}`,
      hub.staleNote ? `⚠️ ${hub.staleNote}` : '',
      '',
      '■ 近 8 期核心指标（单位：亿元）',
      table,
      '',
      '■ 系统已计算的同比与边际（规则三：变化率 = 同比增速；边际 = 本期同比 − 上期同比）',
      marginalLines,
      '',
      '■ 近 8 期现金流量表（单位：亿元）',
      cfTable,
      '',
      balBlock || '■ 资产负债表暂无可用数据',
      '',
      pdfExcerpt || '■ 本地资料库已上传财报文件（未匹配到本期 PDF，仅登记文件名）',
      pdfExcerpt ? '' : docLine,
    ].filter(Boolean).join('\n');

    return { ok: true, text, reportDate: hub.reportDate, series: rows, docs, fetchedAt: hub.fetchedAt, docInfo };
  } catch (e) {
    return { ok: false, reason: e.message || '本地财报上下文构建失败' };
  }
}

function _extractReportPeriod(content) {
  if (!content) return null;
  const m = String(content).match(/^\s*报告期[：:]\s*(.+?)\s*(?:\n|\r|$)/m);
  if (!m) return null;
  return m[1].replace(/[\s\u3000]+/g, ' ').trim();
}

// 20260904b：解析 AI 在首行声明的「标的：公司名（代码）」，用于前端展示 + 串公司检测。
// 若 AI 返回的代码与当前 symbol 不一致，即为疑似串公司（如 600460 误读为 601318）。
function _extractEarningsTarget(content) {
  if (!content) return null;
  const m = String(content).match(/标的[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (!m) return null;
  const raw = m[1].replace(/[\s\u3000]+/g, ' ').trim();
  if (!raw) return null;
  const codeM = raw.match(/\(?\s*(\d{6})\s*\)?/);
  const code = codeM ? codeM[1] : null;
  const name = raw.replace(/[（(]\s*\d{6}\s*[)）]/, '').replace(/[（）()]/g, '').trim();
  return { raw, name, code };
}

// 20260904a：把「2026-06-30」转成人类可读报告期标签「2026年中报」/「2025年年报」等
function _reportDateToLabel(reportDate) {
  if (!reportDate) return null;
  const s = String(reportDate).slice(0, 10);
  const md = s.slice(5);
  const y = s.slice(0, 4);
  if (md === '12-31') return `${y}年年报`;
  if (md === '06-30') return `${y}年中报`;
  if (md === '03-31') return `${y}年一季报`;
  if (md === '09-30') return `${y}年三季报`;
  return `${y}年（${md}）`;
}

// 20260904a：从 AI 返回的亮点/雷点文本里检测它**作为论据**引用的财报年份。
// 返回该条目实际引用的最新年份（数字），用于与 latestReportYear 比对；若条目不含年报年份则返回 null（不涉财报，放行）。
function _detectCitedYear(text) {
  if (!text) return null;
  const m = String(text).match(/(20\d{2})\s*年(?:[半一三]|度)?报?/);
  return m ? parseInt(m[1], 10) : null;
}

// 从 AI 财报解读文本提取结构化信号（[-1,1]）：
// 优先解析「综合信号：N」整数行（N∈[-3,+3] 归一化）；缺失时按综合结论关键词启发式兜底。
function _extractEarningsSignal(content) {
  if (!content) return 0;
  const m = content.match(/综合信号[：:]\s*([+-]?\d+)/);
  if (m) {
    const n = Math.max(-3, Math.min(3, parseInt(m[1], 10)));
    return Math.max(-1, Math.min(1, n / 3));
  }
  // 兜底：优先用「综合结论」定性行做关键词启发式（避免全文亮点/风险段相互抵消，导致方向误判）
  const concl = (content.match(/综合结论[：:]\s*(.+?)(?:\n|\r|$)/) || [])[1] || '';
  const scope = concl.trim().length ? concl : content.slice(0, 240);
  const negRe = /放缓|下滑|恶化|承压|向下|走弱|不及|收窄|负增长|转负|亏损|隐忧|压力加大|拐点向下|边际向下|低于预期|不及预期/;
  const posRe = /超预期|改善|加速|向好|转正|回升|拐点向上|边际向上|高于预期|超预期改善/;
  const negCnt = (scope.match(negRe) || []).length;
  const posCnt = (scope.match(posRe) || []).length;
  if (posCnt > negCnt) return 0.5;
  if (negCnt > posCnt) return -0.5;
  return 0;
}

// 提取「综合结论」定性短句，供因子卡片展示（如「表观稳、实质弱」）
function _extractEarningsVerdict(content) {
  if (!content) return null;
  const m = content.match(/综合结论[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (m) return m[1].replace(/[\s\u3000]+/g, ' ').trim();
  return null;
}

// 后置清理财报解读正文（20260904a，修士兰微 8 行重复 bug）。
// 1) 折叠连续 2+ 行完全重复的相邻行（保留一行 + 计数提示，例如「（同上×7」），
//    防模型机械地把每个缺数据指标都写成同一句话刷屏。
// 2) 总长硬上限 800 字；超长截断到最后一个完整句号并加省略号 + 截断标记。
function _postProcessEarningsSummary(text, maxChars = 800) {
  if (!text) return text;
  // 步骤1：按"连续重复行组"收集（避免把上一行标记成对象后再去 trim 的递归坑）
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) {
      groups.push({ kind: 'blank', raw: ln });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.kind === 'dup' && last.text === t) {
      last.count++;
      continue;
    }
    groups.push({ kind: 'dup', text: t, count: 1, raw: ln });
  }
  // 步骤2：把 dup 组展开为「首行 + (同上×N)」
  const merged = [];
  for (const g of groups) {
    if (g.kind == 'blank') { merged.push(g.raw); continue; }
    merged.push(g.raw);
    if (g.count > 1) {
      merged.push(`（同上×${g.count}，已折叠以避免重复占用篇幅）`);
    }
  }
  let out = merged.join('\n').trim();

  // 步骤3：总长硬上限（保留「综合信号/结论」与「最新报告期/数据可信度自查」两句完整性，截中间正文）
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastStop = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('）'),
    );
    const safeCut = lastStop >= maxChars * 0.7 ? cut.slice(0, lastStop + 1) : cut;
    out = safeCut + '\n\n（…正文已截断，超出 800 字限制。如需更深入分析，请点击「✨ AI 联网获取」或调整上下文预算。）';
  }
  return out;
}

async function analyzeEarningsReport({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_earnings.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const promptOk = cached.promptVersion === EARNINGS_PROMPT_VERSION;
      if (promptOk) {
        // 20260904b：财报解读统一为「联网 AI 分析」主路径（mode 恒为 'web'），
        // 全部按 7 天 TTL 保鲜；旧 'local' 模式缓存因 promptVersion 变更已自动失效，不会继续展示本地口径。
        if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
          return { success: true, ...cached, cached: true };
        }
        console.log(`[AI 财报解读] ${symbol} 缓存已超 7 天 TTL，重新联网解读`);
      }
    } catch {}
  }
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // ── 用途归类（20260904b）─────────────────────────────────────────────────
  // 财报解读 = 联网 AI 分析主路径：本地财务数据库取数链路存在跨公司串号污染
  // （如 600460 士兰微误读为 601318 中国平安），故不再以本地数据为事实源，
  // 统一走 modelWeb + 联网检索（webSearch=true），由系统层「身份确认」句强约束 AI 声明标的。
  // 不再调用 buildLocalEarningsContext，彻底绕过本地取数污染源。
  let modelPick, mode;
  modelPick = pickModelFor(cfg, 'web');
  mode = 'web';
  console.log(`[AI 财报解读] ${symbol} 走联网 AI 分析主路径（webSearch=${!!modelPick.webSearch}）`);
  const messages = [
    { role: 'system', content: EARNINGS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。`,
    },
  ];
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const reportPeriod = _extractReportPeriod(content);
    const earningsTarget = _extractEarningsTarget(content);
    // 20260904b：串公司检测——AI 首行声明的代码若与当前 symbol 不一致，即为疑似张冠李戴
    let targetMismatch = false, targetWarn = '';
    if (earningsTarget && earningsTarget.code && earningsTarget.code !== symbol) {
      targetMismatch = true;
      targetWarn = `解读标的疑似串公司：AI 返回代码 ${earningsTarget.code}，当前股票为 ${symbol}。请点击「重新解读」重试。`;
      console.warn(`[AI 财报解读] ${symbol} 检测到标的代码不符：AI=${earningsTarget.code}`);
    }
    // summary 去掉「报告期：...」行（标题已展示）与「标的：...」行（前端以徽标展示），避免重复。
    // 注意：AI 可能把「标的」行放在「报告期」行之前，故 reportPeriod 提取改用 /m 全行匹配，
    // 此处 strip 也独立于 reportPeriod 是否取到，始终剥离「报告期」行。
    let rawSummary = String(content).trim();
    rawSummary = rawSummary.replace(/^[^\r\n]*报告期[：:][^\r\n]*\r?\n?/m, '').trim();
    if (earningsTarget) rawSummary = rawSummary.replace(/^[^\r\n]*标的[：:][^\r\n]*\r?\n?/m, '').trim();
    // 20260904a：后置清理（折叠连续重复行 + 总长 800 字上限），修士兰微 8 行重复 bug
    const summary = _postProcessEarningsSummary(rawSummary);
    // 结构化信号：优先解析「综合信号：N」行；缺失时按综合结论关键词启发式兜底（确保实质弱/边际向下被正确判为利空）
    const earningsSignal = _extractEarningsSignal(content);
    const verdict = _extractEarningsVerdict(content);
    const result = {
      symbol, stockName: name || symbol, summary, reportPeriod, earningsSignal, verdict, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      // 归类溯源（20260904b）：统一为联网 AI 分析主路径
      mode,
      modelKind: modelPick.webSearch ? 'web' : 'web-noSearch',
      localDataUsed: false,
      // 20260904b：标的身份（供前端展示 + 串公司检测）
      earningsTarget,
      targetMismatch,
      targetWarn,
      promptVersion: EARNINGS_PROMPT_VERSION,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// 估值大模型（提示词驱动）：读取 prompts/valuation-system.md 作为系统提示词。
// 20260905k：历史财务优先走本地财报数据库（buildLocalEarningsContext：近8期结构化财务+年报PDF节选，
// 与财报解读同源），实时行情/可比公司/宏观保留联网搜索；数据库未覆盖该标的时自动纯联网并标注"补抓"。
const VALUATION_VER = 'v4'; // 缓存版本：v4=三表全注入+财报解读复用（旧缓存含 AI 自搜错误数据，强制失效重算）；v3=本地事实+规则模型交叉验证
async function analyzeValuation({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_valuation.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地财报数据库上下文（与财报解读模块同源；PDF 节选 12000 字，控制上下文体积）
  const localFin = await buildLocalEarningsContext(symbol, { pdfCharCap: 12000 }).catch(() => ({ ok: false }));
  const factAnchor = localFin.ok ? String(localFin.reportDate || '') : '';
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ttlOk = Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS;
      // v2 锚点联动：本地财报期变化（新一期财报入库）即视为过期，避免缓存里历史财务长期不更新
      const anchorOk = !localFin.ok || (cached.ver === VALUATION_VER && cached.factAnchor === factAnchor);
      if (ttlOk && anchorOk && cached.ver === VALUATION_VER) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  const systemPrompt = loadPromptFile('valuation-system.md');
  const modelPick = pickModelFor(cfg, 'web');
  const localBlock = localFin.ok
    ? `\n\n————【本地财报数据 · 来自工作台年报数据库】————\n${localFin.text}\n————（以上为本地年报数据库注入，历史财务必须优先引用本块，来源标注"年报数据库"）————`
    : `\n\n（注：本地年报数据库暂未覆盖该标的，历史财务请用上网搜索补抓，来源标注"补抓（上网搜索）+日期"。）`;
  // 20260905l：融合模式——读取工作台规则估值模型结论（深度分析磁盘缓存），注入给 AI 交叉验证
  // 20260906（v4）：同一缓存复用【最新财报解读】——该模块已联网检索过一次财务数据，直接注入供引用，免同批数据重复上网（省 token）
  let ruleBlock = '';
  let earningsBlock = '';
  try {
    const dir = path.join(__dirname, '..', 'data', 'cache', 'deep-analysis');
    const bare = String(symbol).replace(/^(sh|sz|bj)/i, '');
    const candidates = [path.join(dir, `${symbol}.json`), path.join(dir, `${bare}.json`)];
    let cachedDeep = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) { cachedDeep = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    }
    const er = cachedDeep && cachedDeep.sections && cachedDeep.sections.earningsReport;
    if (er && er.summary) {
      earningsBlock = `\n\n————【最新财报解读 · 来自工作台财报解读模块（已联网检索，同批数据直接引用，勿重复上网搜索）】————\n${String(er.summary).slice(0, 2500)}`;
      console.log(`[AI 估值] ${symbol} 已注入财报解读摘要（复用已检索数据，免重复上网）`);
    }
    const cc = cachedDeep && cachedDeep.sections && cachedDeep.sections.conclusion;
    if (cc && cc.overallRating && cc.overallRating !== '数据不足') {
      const ruleDate = cachedDeep.cachedAt ? new Date(cachedDeep.cachedAt).toISOString().slice(0, 10) : '未知';
      const fmtV = v => (v != null && isFinite(Number(v))) ? Number(v).toFixed(2) : '--';
      const lines = [];
      lines.push(`综合估值评级：${cc.overallRating}${cc.companyTypeName ? `（${cc.companyTypeName}）` : ''}`);
      if (Array.isArray(cc.ratings) && cc.ratings.length) {
        lines.push('各方法明细（确定性规则计算）：');
        cc.ratings.forEach(r => {
          let l = `- ${r.method}（权重 ${r.weight != null ? Math.round(r.weight * 100) + '%' : '--'}）：评级 ${r.rating}`;
          if (r.fairValue != null && isFinite(Number(r.fairValue))) l += `，合理估值 ¥${fmtV(r.fairValue)}`;
          if (Array.isArray(r.fairValueRange) && r.fairValueRange.length === 2) l += `，合理区间 ¥${fmtV(r.fairValueRange[0])} ~ ¥${fmtV(r.fairValueRange[1])}`;
          if (r.detail) l += `；${String(r.detail).slice(0, 200)}`;
          lines.push(l);
        });
      }
      if (Array.isArray(cc.fairValueRange) && cc.fairValueRange.length === 2) {
        lines.push(`综合合理估值区间：¥${fmtV(cc.fairValueRange[0])} ~ ¥${fmtV(cc.fairValueRange[1])}${cc.fairValueCenter != null ? `（中枢 ¥${fmtV(cc.fairValueCenter)}）` : ''}`);
      }
      if (cc.currentPrice != null && isFinite(Number(cc.currentPrice))) lines.push(`规则模型所用当前股价：¥${fmtV(cc.currentPrice)}`);
      if (cc.conclusionText) lines.push('规则模型结论文本（节选）：\n' + String(cc.conclusionText).slice(0, 1500));
      ruleBlock = `\n\n————【工作台规则估值模型计算结果】（内置确定性规则引擎，生成于 ${ruleDate}）————\n${lines.join('\n')}\n————（请对你的估值结果与上述规则模型结果交叉验证：方向与区间基本一致时在【当前判断】中明确说明"与工作台规则模型结论一致"以增强置信度；存在矛盾时必须解释差异原因（方法选择/参数假设/数据口径），给出你更认可的一方及理由；不得直接照抄规则模型数字，也不得无视矛盾）————`;
      console.log(`[AI 估值] ${symbol} 已注入规则估值模型结论（缓存 ${ruleDate}）`);
    } else {
      console.log(`[AI 估值] ${symbol} 深度分析缓存无规则估值结论，AI 独立估值`);
    }
  } catch (e) {
    console.warn('[AI 估值] 规则模型结论读取失败（不影响估值主流程）:', e.message);
  }
  const mode = localFin.ok ? 'local+web' : 'web';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请对以下 A 股上市公司做估值分析：\n公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${localBlock}${earningsBlock}${ruleBlock}\n\n请用【上网搜索】仅补足上述注入块未覆盖的实时数据（最新行情、可比公司估值与宏观利率），严格按你的系统提示词中的"输出模板"给出结构化结论（内在价值区间 / 当前判断 / 安全边际 / 主要风险），并在每条数据后标注来源与日期。` },
  ];
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: true, timeoutMs: 180000 }); // 估值任务联网+长上下文+长输出，放宽至 3 分钟
    const result = {
      symbol,
      stockName: name || symbol,
      industry: ind || '',
      content: String(content || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.webSearch ? 'web' : 'web-noSearch',
      localDataUsed: localFin.ok,
      factAnchor,
      ver: VALUATION_VER,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    let message = e.message;
    if (status === 400) message = '模型不支持该请求（400），请检查 AI 设置中的模型是否支持联网搜索。';
    else if (status === 401 || status === 403) message = 'API Key 无效或未授权（' + status + '），请检查 AI 设置。';
    return { success: false, error: 'LLM_ERROR', status, message, raw: (e.response && e.response.data ? JSON.stringify(e.response.data) : '').slice(0, 400) };
  }
}

module.exports = { augmentStock, analyzeAspects, analyzeProducts, analyzeCompany, analyzeSupplyChain, analyzeShareholdersAI, analyzeMarketOverview, analyzeIndustryIndex, analyzeResearchReports, analyzeAnnouncements, analyzeEarningsReport, analyzeValuation, readIndustryIndexCache, loadConfig, saveConfig, publicConfig, readCache, readEarningsCache, readValuationCache, extractEarningsSignal: _extractEarningsSignal, PROVIDERS, callLLM,
  pickModelFor, buildLocalEarningsContext };
