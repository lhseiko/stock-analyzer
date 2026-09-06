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
// 202609 拆分重构：个股资料补全与投资亮点/雷点迁至 ai/augmentStock
const augment = require('./ai/augmentStock');
const augmentStock = augment.augmentStock;
const analyzeAspects = augment.analyzeAspects;

module.exports = { augmentStock, analyzeAspects, analyzeProducts, analyzeCompany, analyzeSupplyChain, analyzeShareholdersAI, analyzeMarketOverview, analyzeIndustryIndex, analyzeResearchReports, analyzeAnnouncements, analyzeEarningsReport, analyzeValuation, readIndustryIndexCache, loadConfig, saveConfig, publicConfig, readCache, readEarningsCache, readValuationCache, extractEarningsSignal: _extractEarningsSignal, PROVIDERS, callLLM,
  pickModelFor, buildLocalEarningsContext };
