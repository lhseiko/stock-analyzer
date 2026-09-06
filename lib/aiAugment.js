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
// 202609 拆分重构：财报解读（含 _extract* 后处理与本地上下文构建）迁至 ai/earnings
const earnings = require('./ai/earnings');
const analyzeEarningsReport = earnings.analyzeEarningsReport;
const buildLocalEarningsContext = earnings.buildLocalEarningsContext;
const _extractEarningsSignal = earnings._extractEarningsSignal; // 门面别名导出 extractEarningsSignal 的原函数
// 202609 拆分重构：AI 估值迁至 ai/valuation
const valuation = require('./ai/valuation');
const analyzeValuation = valuation.analyzeValuation;

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

module.exports = { augmentStock, analyzeAspects, analyzeProducts, analyzeCompany, analyzeSupplyChain, analyzeShareholdersAI, analyzeMarketOverview, analyzeIndustryIndex, analyzeResearchReports, analyzeAnnouncements, analyzeEarningsReport, analyzeValuation, readIndustryIndexCache, loadConfig, saveConfig, publicConfig, readCache, readEarningsCache, readValuationCache, extractEarningsSignal: _extractEarningsSignal, PROVIDERS, callLLM,
  pickModelFor, buildLocalEarningsContext };
