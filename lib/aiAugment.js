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
const { getCompanyProfile } = require('./shareholderData');
const factStore = require('./factStore'); // 20260903f 降费：本地事实库（研报/公告/概况/主营预下载）
// 202609 拆分重构：常量/配置/模块级状态唯一持有者迁至 ai/config（g* 四变量收拢为 config.runtime）。
// 消费方必须调用时实时读取 config.runtime.xxx，禁止模块顶层解构值快照。
const config = require('./ai/config');
const {
  CACHE_DIR, IMG_DIR, CACHE_TTL_MS, SEMI_STATIC_TTL_MS,
  loadPromptFile, PROVIDERS, ensureDirs, loadConfig, saveConfig, publicConfig,
} = config;
// 202609 拆分重构：只读缓存层与版本常量迁至 ai/cache（deepAnalysis 主流程改为直接 require ai/cache，循环依赖切割点）
const cache = require('./ai/cache');
const { readCache, readEarningsCache, readValuationCache, EARNINGS_PROMPT_VERSION, VALUATION_VER } = cache;
// 202609 拆分重构：LLM 调用/模型选择/搜索通道/上下文预算/JSON 解析迁至 ai/llm
// （guardCtxBudget、extractJson 因被 ≥6 个分析器跨块使用一并上移）
const llm = require('./ai/llm');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson, extractSources } = llm;
// 202609 拆分重构：图片下载与兜底搜图迁至 ai/images（downloadImage/searchCommonsImage 供 products 用，attachImage 供 company 用）
const images = require('./ai/images');
const { downloadImage, searchCommonsImage, attachImage } = images;
// 202609 拆分重构：大盘解读与行业指数迁至 ai/market（_industryIndexRunning 唯一持有于此）
const market = require('./ai/market');
const analyzeMarketOverview = market.analyzeMarketOverview;
const analyzeIndustryIndex = market.analyzeIndustryIndex;
const readIndustryIndexCache = market.readIndustryIndexCache;
// 202609 拆分重构：研报/公告总结迁至 ai/research
const research = require('./ai/research');
const analyzeResearchReports = research.analyzeResearchReports;
const analyzeAnnouncements = research.analyzeAnnouncements;
// 202609 拆分重构：产品与客户分析迁至 ai/products
const products = require('./ai/products');
const analyzeProducts = products.analyzeProducts;
// 202609 拆分重构：公司介绍/供应链/股东户数迁至 ai/company
const company = require('./ai/company');
const analyzeCompany = company.analyzeCompany;
const analyzeSupplyChain = company.analyzeSupplyChain;
const analyzeShareholdersAI = company.analyzeShareholdersAI;

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

// ---------- 最新财报解读 · AI 联网分析（最新一季度财报） ----------

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
