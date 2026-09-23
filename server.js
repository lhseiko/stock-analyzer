/**
 * Stock Analyzer Server
 * Express server providing REST API and static file serving
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const multer = require('multer');
const { getQuote, getHistory, getHistoryPeriod, getHistoryDeep, searchStocks, detectMarket, getMarketOverview, fetchTencentMinutes } = require('./lib/stockData');
const { technicalAnalysis, fundamentalAnalysis, evaluateSignals, aggregateSentiment, buildFundamentalComparison } = require('./lib/analysis');
const { buildMetricAnalysis } = require('./lib/metricAnalysis');
const { analyzePriceAction } = require('./lib/priceAction');
const { getPriceActionSnapshot } = require('./lib/priceActionHub');
const { getNews, getHotNews } = require('./lib/newsSearch');
const { getMacroNews } = require('./lib/macroNews');
const { getMacroIndicators } = require('./lib/macroData');
const { getCninfoAnnouncements } = require('./lib/cninfoAnnouncements');
const { getUsMacroEvents } = require('./lib/usMacroEvents');
const { getMarketRank } = require('./lib/marketRank');
const { getIndexPETrend } = require('./lib/indexPETrend');
const { getMarketTechnical } = require('./lib/marketTechnical'); // 首页·大盘技术分析（三大指数六步推演）
// 20260914i：两个技术分析模块的「准确率检查」——独立落盘 + 事后结算（不污染个股 judgements 统计）
const marketTechJudgment = require('./lib/marketTechJudgment');
const techFaceJudgment = require('./lib/techFaceJudgment');
const { deepAnalysis, getLocalDocuments, loadDividendSeries, persistDividends, fetchDividends, normalizeSymbol } = require('./lib/deepAnalysis');
const { analyzeCapitalFlow } = require('./lib/capitalFlow');
const { classifyCompanyType } = require('./lib/companyType');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./lib/futuresData');
const { industryAnalysis } = require('./lib/industryAnalysis');
const { getShareholdersData, getCompanyProfile } = require('./lib/shareholderData');
const { getJudgmentWithAccuracy, settleAll, settleSymbol, getAllRecords, filterBySymbol, computeAccuracy, getLearningState, preOpenRecomputeAll, localDate, marketClosed } = require('./lib/sameDayJudgment');
const { getMarketSentiment } = require('./lib/sentiment');
const { getSectorTrend } = require('./lib/sectorTrend');
const { getSectorLimitStats } = require('./lib/sectorLimitStats');
const { getLongTermJudgment } = require('./lib/longTermJudgment');
// Part B：弱关联关联度 / 持续性经验库（调试透明用）
const { getState: getRelevanceLearningState } = require('./lib/relevanceLearning');
const { annotateNewsImpact } = require('./lib/newsSectorImpact');
const { recordImpact, correctImpact, getLearningState: getNewsImpactLearningState, autoReviewImpacts } = require('./lib/newsImpactLearning');
const { recordDailyRanking, getSectorRankReminder, backfillSeed, SEED_DAYS } = require('./lib/sectorRankHistory');
// 20260823t：行业板块拥挤度（板块成交额 ÷ 全市场成交额，当日/本周/本月前五）
const { recordDaily: recordSectorCrowding, getCrowding: getSectorCrowding, backfillHistory: backfillSectorCrowding, needsBackfill: sectorCrowdingNeedsBackfill, hasDate: sectorCrowdingHasDate, latestMarketTotal: sectorCrowdingLatestTotal } = require('./lib/sectorCrowding');
const { getIndustryIndexHistory } = require('./lib/industryIndexHistory');
const { fetchValuationTTM } = require('./lib/eastmoneyValuation');
const { getSectorCapitalFlow, warmup: warmupSectorCapitalFlow } = require('./lib/sectorCapitalFlow'); // 20260827g：行业板块资金流向（主力+散户小单 净流入/流出前五 + 近5日最大）20260909o纯Node化提速
const hotTopics = require('./lib/hotTopics'); // 20260827c：个股近期热点（AI 联网，异动归因/网络热议）
const hotTopicsWeekly = require('./lib/hotTopicsWeekly'); // 20260909m：板块舆情热度周榜（替代旧涨停池逻辑）
const { getGlobalSentiment, interpretReport } = require('./lib/cnscraperAdapter');
// 20260912a：基金行业配置改为「全市场大部分基金 · 前十大重仓股 · 持仓市值加总排名」
const fundMatrix = require('./lib/fundIndustryMatrix');
const mx = require('./lib/miaoxiang');
const { augmentStock, analyzeAspects, analyzeProducts, analyzeCompany, analyzeSupplyChain, analyzeMarketOverview, analyzeIndustryIndex, analyzeResearchReports, analyzeAnnouncements, analyzeEarningsReport, analyzeValuation, readIndustryIndexCache, loadConfig, saveConfig, publicConfig, readCache, readEarningsCache } = require('./lib/aiAugment');
const docStore = require('./lib/docStore');
const reportSync = require('./lib/reportSync'); // 20260821f：财报事件→资料库自动同步
// 20260823p：全市场情绪指数 + 市场情绪拐点检测（启发式检测器 + 自适应学习）
const MSI = require('./lib/marketSentimentIndex');
const { getTurningPointState, labelAndLearn } = require('./lib/sentimentTurningPoint');
// 20260914i：市场情绪提醒的准确率记录与事后验证（仅对有方向预警的日期留档，次日上证判命中）
const sentimentAccuracy = require('./lib/sentimentAccuracy');
// 20260917d：首页「市场情绪提醒」卡片升级为「大盘量能情绪分析模型」（10 因子 · 确定性计算 · 自学习）
const marketEmotionModel = require('./lib/marketEmotionModel');
const { getMarketEmotionData } = require('./lib/marketEmotionData');
const { computeMacroFactors } = require('./lib/macroSentimentFactors');
// 本地 SQLite 数据层（node:sqlite，零额外依赖）：分红时序 / 标量五要素 / 分析快照，支撑三规则落地
const db = require('./lib/db');
// 20260903f 降费：本地事实库（研报/公告/概况/主营预下载，供不联网模型做纯推理）
const factStore = require('./lib/factStore');
// 20260906 路由拆分（第一阶段）：AI/妙想/行业指数 + 资料库路由移至 routes/，server.js 瘦身
const aiRoutes = require('./routes/aiRoutes');
const docsRoutes = require('./routes/docsRoutes');
const eventRoutes = require('./routes/eventRoutes'); // 20260907a：三联动·事件驱动权重引擎
const dedicatedFactorRoutes = require('./routes/dedicatedFactor'); // 20260911：专属因子路由
// Python 解释器探测器移至 lib/pyRuntime.js（AI 行业指数 / 研报下载 / 板块拥挤度回补共用）
const { findPython } = require('./lib/pyRuntime');
// 20260917g：localDate 统一来自 lib/sameDayJudgment（其内部已委托 lib/localDate.js，按北京时区）。
// 不再单独 require 以免重名；此前 server.js 用 new Date().toISOString().slice(0,10) 取日期，
// 在 UTC+8 每天 00:00–07:59 会取到前一天。

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json({ limit: '50mb' }));

// 行情/分析类接口禁用浏览器缓存，确保每次打开/刷新都拿到最新股价与估值
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// 入口 HTML 强制带版本号重定向：旧服务器曾允许缓存 index.html，浏览器可能一直用旧副本。
// 每次访问 / 或 /index.html 都重定向到带 ?v= 的版本，确保一定拉取最新前端（无需用户手动硬刷新）。
const APP_VERSION = '20260923a'; // [20260923a] 个股页新增「官方公告（巨潮资讯·确定性数据）」卡片（GET /api/announcements/:symbol + #cninfoAnnouncements 骨架 + loadCninfoAnnouncements 渲染）；首页宏观卡增补 LPR(直连 axios 取 RPTA_WEB_RATE) 与社融(pbc_social_financing) 两项确定性指标。 | [20260922l] 修复「海天味业行业分析里，多个『行业板块总市值 vs 个股总市值』对比图表消失」：东财 push2 家族 clist/get 全通道被对端重置（socket hang up），使 sectorMarketCapHistory.fetchConstituents 抛错 → 三张图整体 style.display=none。① fetchConstituents 改多主机轮询重试（push2delay/push2/82.push2/16.push2 × 2 轮）；② 新增 readLatestCacheAny + staleFallback：成分股拉取失败/为空/无序列时，回退「最近一次成功快照」并标注 stale；③ 前端 renderSectorMarketCap 增「（快照）」日期角标 + 黄色告警行（.sector-cap-stale），明确「非实时、源恢复后自动更新」。 | [20260922k] 修复「宏观情绪因子写着权重自动归 0、却仍占 5%」：① macroSentimentFactors 的 observedIndex 未持久化导致「走势相悖→归零」判定被永久跳过 → 增加事件日锚定 + 旧快照自愈补锚；② marketEmotionModel.calcMacro 只看 signal 不看 status → 休眠因子回落默认 5% → 改为尊重 dormant（未激活→权重 0，常驻因子按比例吸收）；③ 卡片文案改为「按实际状态」生成（休眠/激活/中性三种措辞）。[20260922j] 因子权重调整：增持减持 +5pp（0.0485→0.0985）、大盘 −5pp（0.3071→0.2571），一增一减 Σ 仍=1.0000；权重变化由 _hashFactorStructure 自动捕获 → 旧判断强制重算。[20260922i] 修复公告漏抓（东财 /ann 端点生效 + detectForcedReduction 正则扩展覆盖真实措辞），同步 LAYOUT_VERSION=20260922c 强制重算当日判断。[20260922h] 「增持减持」因子新增第④子模块「股东被动减持/司法强制执行」(公告/新闻实时检测，确认被动减持 signal=-0.8、司法冻结/拍卖预告 -0.6，父因子叠加 0.2×forcedSignal 困境溢价)；同步升 sameDayJudgment LAYOUT_VERSION=20260922b 强制重算当日判断。 // [20260922g] 长江证券 补丁G 口径修正 + 规则4：① 废弃「历史50%分位=1.33倍」（实为2017年以来约9年长周期均值，跨周期数据混用），下轨铁底正式确认为**近5年日K真实50%分位 0.916 倍（¥6.11）**，防御说明栏改为「已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。」；② 上轨逻辑不变（动态PB锚 1.4057 > 近5年90%分位 1.165 → 估值体系重构警告继续生效）；③ 新增规则4「乐观复苏情景」：长周期均值锚 1.33 倍 × BVPS 6.67 = ¥8.87，仅当【市场日均成交额 ≥ 1.5 万亿 且 公司 ROE 持续上行】双闸门同时满足时，作为**额外情景在备注展示，不参与主模型计算**（实时读本地成交额存盘 data/sector_crowding_history.json 近20交易日日均）；④ 顺手修 nz(x, default) 单参误用（缺省值被静默吞为 0）共 6 处 ｜ [20260922g] 长江证券 补丁G 口径修正 + 规则4 // [20260922g] 长江证券 补丁G 口径修正 + 规则4：① 废弃「历史50%分位=1.33倍」（实为2017年以来约9年长周期均值，跨周期数据混用），下轨铁底正式确认为**近5年日K真实50%分位 0.916 倍（¥6.11）**，防御说明栏改为「已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。」；② 上轨逻辑不变（动态PB锚 1.4057 > 近5年90%分位 1.165 → 估值体系重构警告继续生效）；③ 新增规则4「乐观复苏情景」：长周期均值锚 1.33 倍 × BVPS 6.67 = ¥8.87，仅当【市场日均成交额 ≥ 1.5 万亿 且 公司 ROE 持续上行】双闸门同时满足时，作为**额外情景在备注展示，不参与主模型计算**（实时读本地成交额存盘 data/sector_crowding_history.json 近20交易日日均）；④ 顺手修 nz(x, default) 单参误用（缺省值被静默吞为 0）共 6 处 ｜ [20260922f] 长江证券 补丁F-Plus（单边空间展示 + SOTP偏离深度归因）+ 补丁G（动态锚双轨兜底） ｜ [20260922e] 长江证券 补丁F：估值矩阵逻辑自洽强制校验（排序/空间/基准一致性） ｜ [20260922b] 华安证券专属估值引擎升级 V3.0（指令9：核心参股资产联动监测 + SOTP权重自适应：实时抓取长鑫科技688825总市值、持股价值=长鑫市值×0.4391%×(1-流动性折扣)、参股占比驱动SOTP权重<10%→30% / 10~30%→40% / >30%→影子股模式(50%/40%/10%)+单独列示长鑫持股贡献+60日收益相关系数联动强度）；run 改为 async（实时抓取长鑫/华安总市值与日K相关性，失败回退锁定快照）。 [20260921l] 「原油主连」冲击有效期 3 天→1 天，并修正取数通道（push2delay 不可达→新浪 nf_SC0）；[20260921k] 「股份回购」完成实施/停止实施/被股东大会否决时判定转为中性（signal=0、不再计入增持家数）；[20260921j] 「股份回购」子卡片改走东财结构化回购报表（datacenter-web RPTA_WEB_GETHGLIST_NEW）：按「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素提炼（旧口径只扫公告/新闻标题、把标题原文当详情，用户看不到任何回购数据）；配套升 sameDayJudgment LAYOUT_VERSION 强制重算当日判断。 [20260921i] 「板块涨跌幅前5」也切回东财：新增东财「数据中心」通道（datacenter-web 报表 RPT_INDUSTRY_FUNDFLOW，与 push2 同为东财口径/同源板块分类），取数顺位 push2族(实时tick) → 数据中心报表(稳定可达) → 同花顺；新增 push2 失败 10 分钟静默期（首轮 2.5s → 静默期 0.3s）；面板与资金流卡现在同源同值。指数行情按用户决定保持腾讯并如实标注（无东财可达实时通道）。 [20260921h] 行业资金流改走东财「数据中心」报表源（datacenter-web 可达，push2delay 被对端重置）：恢复「散户(小单)前五」+「近5日主力/散户」，整卡统一东财口径；新增 push2 连续失败静默期（10 分钟）避免每次刷新白等。 [20260921g] 实时大盘「逐行标注数据源」：中国指数/美国指数两行补齐数据源标签，板块榜与资金流延续既有来源标注；同时修复妙想业务错误（如「积分已用完」）被静默当作「无数据」的问题。原注：[20260921c] 量价配合口径修正：大涨+平量由「显著上涨」利好改判中性「大涨平量」；同步升 LAYOUT_VERSION=20260921c 强制重算旧判断。 // [20260921b] 同步升 sameDayJudgment 的 LAYOUT_VERSION→20260921a，强制重算当日判断缓存，修复「清掉事件后个股页事件驱动卡片仍显示旧事件」。 // [20260921a] 事件驱动修正:新闻医药行拆药品/医疗器械二级(药监局药品监管不再误伤医疗器械股);圣湘生物自选归属改挂医疗器械;company_event仅按个股名匹配,停止泛化广播全行业(阳普医疗认证不再误挂圣湘生物) // [20260920a] 行业分析:新增行业景气度卡片(双轴折线,展示行业总营收TTM vs 总市值,数据=东方财富业绩报表+估值明细按申万二级全量汇总);同时移除行业分析总览卡片底部K线图 // 20260919e：修「分产品收入构成趋势」与东方财富完全对不上（用户 2026-09-19 新洋丰 000902 截图）——四处根因：① 末年 TTM 滚动还原在「上年同期无同名分部」时会把该分部静默丢弃，而只要还有任一项算得出就返回残缺清单，主力分部因此凭空显示为 0（新洋丰 磷复肥 2026=0，实际 103.56 亿、占营收 91.8%）；② TTM 本身产出东财从未公布的数值（精细化工 2026 显示 9.49 亿，东财披露 6.19 亿）；③「其中:xxx」子项被当作独立分部进入占比分母，致主营收入合计 115.44 亿（东财 112.85）→ 磷复肥占比 89.71%（东财 91.80%）；④ 图例按「首次出现顺序」截断前 8 项，把 2023/2024 的主力业务（常规复合肥 / 新型复合肥）挤出榜单。 修复：lib/deep/research.js 剔除「其中:」子项 + pageSize=500 改为分页抓全量（东财单页上限 500，新洋丰 709 条、长江证券 1719 条、平安 789 条原被静默截断，2001–2010 年数据整体丢失）；public/js/deepCharts.js 分产品趋势改为逐年原始披露口径（去 TTM）、某年未按该名称披露时留 null 断线（不再填 0 被误读为「营收为零」）、图例改按各年最大收入排序取前 8、说明文案同步更新。 修复后与东财「主营构成」页面逐点一致（新洋丰 41/41 项通过；8 只个股回归无异常），细分产品毛利率卡占比回归 91.80%/5.48%/2.33%/0.38%、合计 112.81 亿；另修一处【下发链路】隐患——public/index.html 里 js/deepCharts.js 的 ?v= 自 2026-09-06 起就停在 20260906e 从未随版本更新，且该文件不在 FRONTEND_BUST_FILES 强制刷新名单内，导致此后对 deepCharts.js 的任何改动都无法下发到浏览器（用户需手动硬刷新才生效，否则看到的仍是旧渲染逻辑）；本次一并将该戳更正为 20260919e 并把 /js/deepCharts.js 纳入强制刷新名单。 20260919d：修复「重大变化 AI 归因」长期显示「大模型请求失败（Request failed with status code 400）」——根因：归因失败/占位结果被当作有效缓存冻结 7 天（重跑深度分析也会直接复用旧失败，用户侧表现为该错误永不消失）；本次改为仅 explanationSource==='ai' 的成功结果才可复用，并重跑圣湘生物 688289 / 士兰微 600460 / 长江证券 000783 的历史失败条目；20260918b：修复「个股最大亮点/雷点无法获取数据」（用户 2026-09-18 18:16 海天味业 603288 截图）——根因：该日 17:42 ai_config.json 的「联网模型」被改为 glm-4.5-air，而阿里百炼上该模型 ① 只接受 stream:true（非流式直接 HTTP 400「This model only support stream mode」）② 不接受 enable_search（流式下以 SSE error 返回、HTTP 仍 200），叠加后所有联网类 AI 调用 5 秒内 400 失败，概览卡恒显「尚未生成」。修复：lib/ai/llm.js 新增「首见即记忆」的模型能力兼容层（STREAM_ONLY_MODELS / NO_SEARCH_PARAM_MODELS + _parseSseContent 流式解析 + _sseError 归一化 + 有界重试），默认路径请求体与历史完全一致（其他分析器零影响）；顺带修好此前被包装丢弃 err.response 而形同虚设的「400 → 去 enable_search 重试」兜底。新增 scripts/test_llm_stream_fallback.js（27 项，含桩服务端握手次数断言）。 20260918a：删除个股「短期行情判断」中「行业板块」因子的「板块成分」子卡片（用户 2026-09-18 截图要求）。该子卡片 signal=0、纯展示且父因子 detail 已含「成分 N 家」，属冗余重复，不直接参与评分，移除不影响方向/权重/得分。属展示布局调整（_hashFactorStructure 仅哈希 FACTOR_KEYS+DEFAULT_WEIGHTS、不含子因子名，不自动捕获），已手动 +1 LAYOUT_VERSION 强制重算旧判断缓存。前端 subFactors 通用循环渲染，无需改 app.js。 20260917l：修「中国平安(601318)个股亮点/雷点**长时间无法获取**」（用户 2026-09-17 20:18 截图：卡片停在「AI 正在联网重新分析…」+ 计数 0/0）。根因（服务端日志实证）：`lib/ai/llm.js` 的 `callLLM` 内部最多会**串行**发起 4 次 `postLLM`（① 妙想事实纯推理 → ② 外部搜索通道纯推理 → ③ 外部通道失败后的纯推理 → ④ 内置 enable_search），每次都用同一个 `timeoutMs` 各自做硬超时；本任务传 240s，单股最坏 ≈4×240s≈16 分钟无响应，用户侧表现就是「长时间拿不到」。601318 恰好踩中该路径（日志 `[search:mcp] 调用失败，本次仅做纯推理…：大模型请求超时（240000ms 无响应）`），而其它的股（600460/600909/000783）同期均秒级命中缓存成功，故只有这一只「永远转圈」。修复（四处，均为隔离修改）：①【核心】`lib/ai/llm.js` 新增**可选**「整链路总耗时预算」`opts.overallBudgetMs`（配套可单测纯函数 `createBudget`）：受预算约束后每次 `postLLM` 只允许用 `min(timeoutMs, 剩余预算)`，剩余不足 5s 即**秒级抛错**（`err.budgetExhausted=true`），不再无限串行等待；**不传该参数时 `enabled=false / leftMs()=Infinity / timeoutFor()=原值`，行为与历史版本完全一致**，故 companyDeep/valuation/earnings/research/announcements 等既有调用方零影响。②【接线】`lib/ai/augmentStock.js` 的 `analyzeAspects` 传 `overallBudgetMs: 300000`（单次仍可跑满 240s，累计超 300s 快速失败）。③【兜底】`analyzeAspects` 失败时若本地已有历史成功结果，直接返回并标记 `stale:true`（新增字段，向后兼容），避免用户看到空白卡片。④【等待体验】`public/js/notes.js` 的 `generateAspects` 补三件事：状态栏每秒刷新「已等待 N 秒」（不再像卡死）、客户端 330s `AbortController` 硬超时（比后端预算多 30s 余量）、超时/失败给出可执行提示；并对 `stale` 回退显示「本次超时/失败，已回退上一次成功结果（时间）」。另修：`lib/macroNews.js` 的 `_localDate` 未定义回归（该文件只导入了 `localDate` 无别名，`localToday()` 却调用 `_localDate()` → 每次调用抛 `ReferenceError: _localDate is not defined`，首页宏观新闻长期取不到）→ 改回 `localDate()`。 20260917k：亮点/雷点「只累积、需手动清理」口径正式落地 + 🤖 AI 徽标修复（用户 2026-09-17 明确选择「只累积、需手动清理」，否决「生成时自动替换旧 AI 条目」方案）——背景：上一条(20260917j)排查中发现 `add()` 漏拷 `ai` 字段，导致 ①🤖 AI 徽标永不显示、②`generateAspects` 里「生成前先清除本股旧 AI 条目」的过滤条件 `n.ai === true` 永远匹配不到（所以实际表现一直是「只追加不清旧」，但属于**意外的**行为）。本次把该行为**显式化并锁定**：①【口径锁定】`generateAspects` **删除**「先清除旧 AI 条目」整段逻辑，改为只统计 `existingAi` 数（不删任何数据），AI 状态提示改为「该股原有 N 条 AI 条目已保留，如需精简可点『🧹 清理重复』」—— 即用户要的「只累积、需手动清理」；代码注释写明「若将来要改回自动替换，必须先征得用户同意」，并新增断言防止回退。②【徽标修复】`renderNoteCard` 的 🤖 判定改为 `note.ai === true || note.type === 'ai'`，使**历史条目也立即恢复显示** 🤖（`data/notes.json` 中 34 条 AI 条目本就有 `type:'ai'`，**无需数据迁移**）。③【字段补全】`add()` 补落 `ai: note.ai === true`，让今后数据自带真实来源标记（**仅用于展示/追溯，不用于自动删除**）。回归测试 `scripts/test_notes_scope_switch.js` 扩展至 **34/34**：新增 §7（历史条目徽标 + 手动录入不误标）、§8（**口径锁定**：生成后原有亮点/雷点一条未删、仅 +1 新增；新条目 `ai` 已落盘）。只改 `public/js/notes.js` 一个文件（隔离修改，服务端 `/api/notes` 契约与 `data/notes.json` 结构均未变）。 20260917j：修「个股亮点/雷点不随个股页面切换」（用户 2026-09-17 截图反馈：页面为华安证券 600909，卡片却全是士兰微 600460 的内容）——根因：`public/js/notes.js` 的 AI 生成 fetch 明确「不随标签页/个股切换取消」（原注释即如此设计），等待期间用户切到别的个股后，回调里的 `this.renderStock(旧symbol)` 会把 `#stockNotesContainer` 刷成上一只股票的亮点/雷点，且此后不会再被纠正（该容器仅在 activeTab==='journal' 时重渲染）。实测吻合：`data/notes.json` 中 600460 恰为 3 亮点 + 5 雷点（= 截图计数），600909 为 0 条，证明容器停留在 600460 的渲染结果。修复（症状级 + 机制级双保险）：①【机制】`notes.js` 新增防串股守卫 `_currentStockCode()/_isCurrentStock()/renderStockIfCurrent()`，凡「目标股票未必等于当前展示股票」的重渲染一律走守卫 —— 覆盖 `generateAspects`（3 处回调 + AI 状态条 + 按钮复位）、`setAsMain`、`confirmDelete`、`saveForm`；非当前股票一律丢弃，不再污染其他个股页面（`renderStock` 本身不加守卫，保持既有契约）。②【症状】`app.js` 的 `analyze()` 在 `window.currentStock` 赋值处（当前个股唯一变更点）立即用新个股重渲染亮点/雷点，不再依赖「恰好停在 journal tab」；③ `generateAspects` 的并发锁由「全局单锁」改为「按股票隔离」（原先 A 股在跑时切到 B 股点生成会被静默 return，按钮看着可用却没反应，同属「不跟随个股切换」）；④ 切股后即使 AI 回调抵达，也只在仍停留该股页面时才刷新 AI 状态条与按钮，避免改到别的股票的界面。新增回归测试 `scripts/test_notes_scope_switch.js`（25/25，用最小 DOM 桩驱动真实 notes.js；含「裸 renderStock 确实会覆盖当前页」的旧行为复现对照，证明守卫是承重的）。注：本次只改前端 2 个文件，`/api/notes` 返回全量由前端按 scope 过滤的既有契约未变（隔离修改）。 20260917i：个股页「短期判断」卡片重组（用户 2026-09-17 要求，5 卡 → 7 因子重构）——①「市场情绪与消息面」改名「大盘」：删除「消息情绪（大盘）」「涨跌停比」两个子因子**及其底层逻辑**，同位置新增「市场情绪提醒」子因子（**直接引用首页判断**：读 data/market-emotion 落盘，同源不重算，非二次计算），并迁入原「大盘及行业板块短期走势」下的「大盘短期走势」；保留「内幕抢跑预警」「全网舆情」。②「板块涨跌停占比」改名「行业板块」（key sectorLimit 不变）：迁入「板块消息」与原「行业板块」因子（**改名为「行业短期走势」**），保留涨停/跌停占比、板块成分。③「大盘及行业板块短期走势」**整卡删除**（原因子 key market 移除）。④「财报解读」「舆情与讨论热度（个股）」两因子迁入「个股短期动向」。⑤ 权重处理：删除 market 后其余 7 因子**等比放大至 Σ=1.0000**；被迁入的子因子**参与评分**（子权重 MARKET_SHORT_SUB_W / SECTOR_TREND_SUB_W / SECTOR_NEWS_SUB_W / LIMIT_SUB_W / EMOTION_SUB_W / STOCK_SENT_SUB_W / EARN_SUB_W / SHORT_DIR_SUB_W），各 factor* 函数一律引用 W_* 常量、不再内嵌字面量。⑥ 缓存失效：LAYOUT_VERSION → 20260917i；因子结构变化（market 移除）由 _hashFactorStructure() **自动捕获**（SCHEMA_VERSION=h1f4df388-20260917i）→ 旧 data/judgments/*.json 判「旧 schema」强制重算，重启即生效。配套改动：lib/marketEmotionModel.js 新增导出 readLatestJudgment() 并补写记录字段 tendencyKey/coreDriver/advice/riskTip（供个股页单源引用首页结论）；public/js/app.js _renderSameDayLogicHtml 的 FACTOR_ORDER 去掉 market 并重排。E2E 实测（603288 海天味业）：7 基础因子 + 事件驱动共 8 因子、权重合计 100.0000%、「大盘」内含「市场情绪提醒=看跌·预警」与首页 /api/sentiment-turning-point 结论一致。回归全绿：test_factor_direction 41/41（新增第 4 节拆分校验）、test_local_date 12/12、test_tz_smoke 23/23、test_market_emotion 31/31、test_news_time 19/19、test_hot_topics_consistency 11/11、test_shareholder_period 10/10、test_sanxi_selling_expense 32/32、test_news_sector_scoring 17/17、test_event_weight_sentiment_acc 31/31；6 个文件 node --check 通过。顺带修掉 scripts/test_factor_direction.js 两处测试基建缺陷：'localDate' 与 require 解构重名导致 SyntaxError（源码里它是委托壳且引用未注入的 _localDate）、FACTOR_NAME 未注入沙箱导致 ReferenceError。 20260917h：修「今日财经热点」卡片数据源与时间口径（2026-09-17 抓真实响应核对后执行）——(1)【数据源已下线、静默失败】旧接口 https://newsapi.eastmoney.com/kuaixun/v1/getlist 实测返回 404，lib/newsSearch.js fetchKuaixunNews() 因 axios 抛错被 try/catch 吞掉、**永远返回 []**，卡片实际长期靠 fetchEastmoneyContentNews 兜底撑着；现改走 https://np-listapi.eastmoney.com/comm/web/getFastNewsList（client=web&biz=web_724&fastColumn=102），响应结构 data.fastNewsList[]。(2)【时间字段口径修正】新接口条目**没有** datetime 字段，实际是 showTime（北京墙钟字符串 "YYYY-MM-DD HH:mm:ss"）＋ realSort（微秒级**真 epoch**，实测 1789642048033848；/1e6 后按 Asia/Shanghai 渲染与 showTime 逐条一致）；旧代码把真 epoch 交给 `new Date(ts).toISOString()` 渲染 → toISOString 输出 UTC，展示时间比北京时间**早 8 小时**；现新增 normalizeNewsTime() 统一归一化（兼容北京墙钟字符串、ISO-T、以及秒/毫秒/微秒三种精度 epoch；脏字符串一律返回空串，避免垃圾字符被当时间展示），一律按北京时间渲染。(3)【原文深链缺失】新接口不含 url，现用 code 合成 https://finance.eastmoney.com/a/{code}.html（实测 200 可访问），卡片条目恢复可点击跳原文。(4)【摘要去重】新接口 summary 常以「【标题】正文」开头重复标题，现自动剥掉该前缀。返回对象字段仍为 { title, summary, source, url, date }，**下游卡片/影响标注模块无需改动**（隔离修改）。新增回归测试 scripts/test_news_time.js（19/19，含「旧 UTC 渲染提前 8 小时」的 bug 复现对照）；scripts/test_local_date.js 12/12、scripts/test_tz_smoke.js 23/23、scripts/test_market_emotion.js 31/31 均通过。 20260917g：全项目统一「中国自然日」日期口径，修掉 UTC 跨日错位（新增 lib/localDate.js + 回归测试 scripts/test_local_date.js 12/12、scripts/test_market_emotion.js 31/31）——根因：`new Date().toISOString().slice(0,10)` 取的是 **UTC 日期**，在 UTC+8 下每天北京时间 00:00–07:59 会比北京日期晚一天，导致交易台账/事件/缓存 的「今天」写成昨天（记录错位、幂等失效），估值基准日、板块快照日期、新闻日期也整体前移一天；白天 08:00 后两者一致，故长期隐蔽。新增 lib/localDate.js（Intl + Asia/Shanghai + formatToParts，hourCycle h23，**不依赖宿主机时区**；提供 localDate / localDateTime / localCompact / localDateFromTs；月/毫秒时间戳自动识别）。已改造 20 个文件：lib/eventEngine.js(4)、lib/factStore.js、lib/hotTopics.js(3，含 ctime 秒级时间戳→北京日)、lib/marketTechnical.js、lib/sectorCapitalFlow.js(2)、lib/stockData.js(4，含东财 beg/end 的 YYYYMMDD 参数)、lib/sentimentTurningPoint.js、lib/deep/conclusion.js、lib/deep/research.js(3，含把原本手写 +8h 的等价写法统一)、lib/cnscraperAdapter.js、lib/ai/valuation.js、server.js、scripts/test_factor_direction.js，以及 3 只个股估值模型的「估值基准日」(海天603288/华安600909/新洋丰000902)。同时把 4 处既有的手写 localDate 实现（sameDayJudgment / marketSentimentIndex / marketEmotionModel / macroNews.localToday）统一委托给 lib/localDate.js——scripts/test_local_date.js 用 2000 个采样点证明委托前后**逐点等价**（UTC+8 宿主机），故不改变既有行为。**刻意未改**：lib/stockData.js:985 的 Yahoo 日线日期（美股日线时间戳按 UTC 表示才是正确交易日）、以及全部 `date: new Date().toISOString()` 形式的绝对时间戳（本就是瞬时值，非日历日）。20260917f：修「股吧讨论热度（散户情绪）」因子三处问题（由用户确认后执行，回归测试 31/31 通过）——(1)【修陈旧值静默使用】server.js readMsiHeat() 会回退到「最后一条含 marketHeat 的记录」，而 marketEmotionModel.calcDiscussionHeat 只取数值、不比对日期，遇到 MSI 当天缺 marketHeat（实测缺 2026-09-10 / 09-16）就把上一天的旧值当"今天"用，且不打 spec §九 的滞后折扣；现新增 tradingLagDays()（以上证 bars 日期为交易日历）：同日=正常、滞后 1~2 个交易日=打 8 折并标「⏱ 数据滞后 N 个交易日」、滞后 ≥3 个交易日（LAG_DEGRADE_DAYS）=降级归零并分摊、日期缺失=按剔除处理（不再静默当今日）；快照 upsertSnapshot 也只在 lagDays===0 时记 heat，避免把旧值挂到新日期污染分位历史。(2)【补回来源标注】lib/marketSentimentIndex.js recordDailySnapshot 原先只持久化 {key,label,signal,weight}，把 value/detail 丢掉，导致任何「读序列」的消费方都拿不到数据源/样本数/更新时间/看多占比；现一并持久化，readMsiHeat() 透传，卡片「股吧讨论热度」明细恢复完整来源标注（兜底实时抓取路径也补齐同样格式）。(3)【分位样本交易日过滤】热度历史里混有非交易日读数（实测 series.json 26 条里 7 条是周末），会稀释历史分位；现用上证 bars 的日期白名单过滤，并在明细标注「已滤除 N 个非交易日样本」。另：marketEmotionModel 新增 SA_MSI_SERIES 环境变量出口，使回归测试不再读取生产 series.json（完全隔离）。20260917e：修复「大盘量能情绪模型」两处权重硬约束漏洞（scripts/test_market_emotion.js 22/22 通过）——(1) computeWeights 原样采用 state.weights 里自学习后的常驻权重，未做 5%~30% 夹紧；(2) 因子降级后的「按比例分摊」（spec §八.4）只做普通归一，会把已顶到 30% 上限的因子再次顶出（实测量能活跃度被摊到 34.47%）。修复：新增有界缩放 scaleBounded（等比缩放 + 溢出量按比例转嫁给仍自由的因子），computeWeights 与降级分摊两处统一走它；非常驻因子激活时若事件残留 {status:'dormant',weight:0} 则回落基准权重（原逻辑会把刚激活的因子压成 0）；可用因子过少导致 5%~30% 区间装不下 100% 时按需平移边界，并在 dataNote 诚实标注「权重被迫越界 · 本日结论置信度偏低」。20260917d：首页「市场情绪提醒」卡片逻辑模型整体升级为「大盘量能情绪分析模型（完整版）」——新增 lib/marketEmotionModel.js（10 因子确定性计算引擎：量能活跃度/市场宽度与极端情绪/量价配合度/大盘涨跌势头/融资余额/主力资金流向/股吧讨论热度(反向)/避险情绪 8 常驻 + 国内宏观/美国宏观 2 非常驻；含动态权重归一化、非常驻 0.8/日衰减、自学习(20次样本门槛·>60%上调<45%下调·常驻权重5%~30%边界)、极端值剔除+双基准(20日均量+1年分位)、市场风格自适应、数据源异常自检与权重分摊、月度健康度报告、极端行情熔断、月末/季末修正、T+1/T+3/T+5 准确率台账）+ lib/marketEmotionData.js（数据采集层：scripts/market_emotion.py 一次取全上证量价/涨跌家数涨跌停/融资余额5日/大盘主力净额/成交额换手率集中度/美元离岸人民币/中债10年）+ 前端 _renderEmotionPanel 按「情绪总分/短期倾向/核心驱动/量能状态/操作建议/风险提示」六行结论渲染；个股页 /api/sentiment-turning-point/:symbol 仍走原拐点检测逻辑不受影响。20260917c：修复「大盘技术分析准确率只停留在 9/15」——根因是 server.js 的 /api/market-technical 路由里调用了 marketClosed() 但**从未从 sameDayJudgment 导入该函数**，命中 ReferenceError 后被外层 catch(e){} 静默吞掉，导致「收盘后落盘当日判断」常年不写文件（data/market-tech/ 仅剩早期手工写入的 2026-09-14.json）；同时原实现只在「用户打开首页」时才落盘、无定时器兜底。修复：(1) 补上 marketClosed 导入；(2) 路由落盘失败改为显式 console.error 不再静默；(3) 新增每交易日 15:30 后自动落盘任务（不依赖用户打开页面），与个股结算调度同源。已实测路由与调度器两条路径均能写入 2026-09-17.json。20260917b：在 20260917a 基础上，进一步修复「个别股亮点/雷点长时间无法获取/卡死」——(1) lib/ai/llm.js postLLM（大模型调用）同样强制 adapter:'http' + 手动 setTimeout 兜底（原无 adapter 导致命中 fetch adapter 静默丢弃 timeout，卡到 60s 才以「timeout of 60000ms exceeded」报错，且被 mxQuery 外层 try/catch 误标为妙想失败）；(2) 亮点/雷点 timeoutMs 由 60s 放宽至 240s（qwen3.5-35b-a3b 实测单股 90~133s），与 companyDeep 一致；(3) 分离「妙想抓取」与「大模型推理」的异常捕获，LLM 超时不再误报为妙想失败。20260917a：修复两处 AI 配置/联网稳定性问题 —— (1) lib/miaoxiang.js 妙想（东财）请求改用 axios 直连 + 强制 adapter:'http' + 手动 setTimeout 竞速兜底 15s（本环境全局 fetch 是 axios 多填实现、自带 60s 内部超时且忽略 AbortSignal，axios 命中 https 会切 fetch adapter 导致 timeout 被静默丢弃、请求卡到 60s 才以「timeout of 60000ms exceeded」绕过 try/catch），妙想慢/不通即 15s 内快速失败并回退阿里百炼 MCP 搜索，根治「AI 生成亮点/雷点」永久卡「分析中…」；(2) 前端 openAISettings 打开前强制重新拉取服务端配置，修复偶发误显示「尚未配置 API Key / 内置联网搜索」（init 时 loadAIConfig 未 await 完成导致 this.aiConfig 为旧值）。20260916h：修复新洋丰（000902）顶部「综合估值评级」卡片口径 —— lib/deep/conclusion.js 原缺 000902 分支（9 个 if(sym===) 里没它），导致掉入通用「PE估值带」逻辑，产出 ¥13.26~¥24.84 / 中枢 ¥19.05，与下方专属卡（16.93 / 13.38~20.43）打架；现补上 xinyangfeng000902 分支（方法 chips 改为 正常化PE(锚)/PB-ROE交叉/DCF参考/磷矿资源期权(独立)/三情景加权），顶部卡与专属卡口径统一。20260916g：新增新洋丰（000902）专属「永久逻辑」估值引擎——正常化盈利为锚（禁单一年份PE）+ 分部估值(A正常化PE75%/B PB-ROE15%/C DCF10%/D磷矿资源期权独立/E磷酸铁期权) + 三情景 + 敏感性 + 四项失效预警，确定性计算无LLM；前端 app.js 增加 xinyangfeng 卡片分支并登记 _isDedicated。20260916e：修复「图表渲染失败」——ECharts 由 CDN(jsdelivr) 改为本地随包加载（public/vendor/echarts.min.js，CDN 仅作回退），根治国内网络下 CDN 被墙/超时导致所有图表报「图表渲染失败」；industryCharts _initChart 增加「图库未就绪时轮询等待 + 缺失时给可诊断提示」；capitalCharts 5 处裸 echarts.init 加 _safeInit 容错（不再因图库缺失中断整页渲染）；/js/capitalCharts.js 纳入缓存破坏。20260916d：个股亮点/雷点 AI 财务数字治理 —— 给 analyzeAspects 注入与「基本面」卡片同源的东方财富 F10 权威财务快照（资产负债率/毛利率/净利率/营收同比/归母净利及同比/流动比率），并新增后置数字校验：AI 输出的资产负债率绝对数值若与权威值偏差 > 1 个百分点，直接修正为权威值，杜绝凭空编造（如新洋丰 000902 资产负债率被写成 48.60%，实际 39.76%）。20260916c：后台计费治理 —— (A) 新增后台 AI 总开关 SA_NO_BG_AI（start.vbs 默认置 1），禁用两个后台 LLM 定时任务（事件驱动扫描 eventEngine + 专属因子月度触发），用户手动点开个股页的 AI 功能不受影响；(B) 封堵 callLLM 静默回退暗道：searchMode 为 mcp/volc/baidu 外部通道且失败/无 Key 时，不再升级 LLM 内置 enable_search（不再绕过免费 MCP 额度自行上网），统一降级纯推理。20260916b：个股亮点/雷点（含投资心得/大盘记录）数据改为服务端持久化（data/notes.json），不再仅存 localStorage —— 硬刷新清缓存 / 代码更新都不会丢失手动录入数据；并移除每次加载时的「内容相似自动去重」，避免误删手动条目（清理重复改由「🧹 清理重复」按钮手动触发）。20260916a：行业分析页「板块总市值走势」统一模板 —— 每只个股分别与所属申万一级/二级/三级行业板块总市值做双坐标走势比对（三张图，无三级板块自动省略）；新增 GET /api/stock-sector-levels/:symbol（东财个股所属板块 slist spt=3 + parseSwSectorName 归类一/二/三级）。20260915d：宏观情绪两因子并入市场情绪统一权重池（国内0.10/美国0.10，原6因子压缩至80%），共同决定短期倾向；移除独立区块；20260915c：每日宏观卡片新增社零/固定资产投资实时抓取（工业增加值无活源→降级占位）+ 国际经济事件卡片（FOMC 9/17 等策划式）+ 市场情绪提醒新增两个非常驻宏观因子小卡片（国内经济/美国经济，等权 0.5，指数相悖则权重归0）；20260915a：公司概况与 sameDay 行业板块因子统一用 sectorIdentity 精确行业（修 688660 电气风电被 F10 CSRC 错配为通用设备）+ companyDeep 长文本卡片截断修复（chart-card max-height 4000px→99999px）+ 信息分析配图禁用 Wikimedia Commons 兜底（避免产品/竞争对手图片全部不相关）；20260914j：事件驱动修行业误配（智能家居补贴不再归食品饮料）+ 权重重设（重大40%/中度12%/轻微3%，封顶40%）+ 删除卡片外重复白字 + 准确率页新增「短期行情判断」「市场情绪提醒」两个 tab；20260914i：大盘技术分析 + 个股技术面新增「准确率检查」（每日留档 + 事后验证 + 卡片内嵌 + 独立核对页 accuracy.html）；20260914h：信息分析（CFA 七段）改为「固定联网模型 + 永久缓存」并补齐本地资料自动加载；20260914g：信息分析卡片改名（「公司深度分析（CFA）」→「信息分析」）+ 联网超时 60s→240s；20260914f：三模块合并为单一 companyDeep.js（七段统一输出）；20260914e：大盘技术分析六步 + 短线结构研判合并为 lib/marketTechnical.js 融合引擎（七步推演，移除 /api/short-term-market）。 ★20260920a：万润股份（002643）专属「永久逻辑」估值引擎上线——data/valuation/002643.json(kind=wanrun)+lib/valuation/wanrun002643.js（三层加权 PB-ROE50%/PE35%/DCF15% + 五业务单元叙事 + 防失真规则）；接线 lib/ai/valuation.js 分发块+hasDedicatedValuation、public/js/app.js _isDedicated 白名单+wanrun 卡片、lib/deep/conclusion.js 顶部综合卡分支（替换旧通用「PE估值带」模型：由 高估/中枢8.71 纠正为 合理/中枢18.55）。
app.use((req, res, next) => {
  if ((req.path === '/' || req.path === '/index.html') && req.query.v !== APP_VERSION) {
    return res.redirect(`/index.html?v=${APP_VERSION}`);
  }
  next();
});

// 关键前端资源：强制 ?v= 与 APP_VERSION 一致，避免浏览器沿用旧版本
// 用户反复反馈「页面像旧版数据」时，多数是因为老 URL 命中 etag 304 后还返回缓存的旧 JS。
// 这里主动 redirect 到带正确版本号的 URL，配合 Cache-Control: no-store 一起兜底。
const FRONTEND_BUST_FILES = new Set(['/js/app.js', '/css/style.css', '/js/industryCharts.js', '/js/notes.js', '/js/capitalCharts.js', '/js/deepCharts.js']);
app.use((req, res, next) => {
  if (FRONTEND_BUST_FILES.has(req.path)) {
    const v = req.query.v;
    if (v !== APP_VERSION) {
      const u = new URL(req.originalUrl, 'http://x');
      u.searchParams.set('v', APP_VERSION);
      return res.redirect(302, u.pathname + '?' + u.searchParams.toString());
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // JS/CSS/HTML 文件禁用缓存，确保前端代码更新后浏览器一定重新获取
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));


// ---- API Routes ----

// Search stocks
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const results = await searchStocks(q);
    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get quote
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const quote = await getQuote(req.params.symbol);
    if (!quote) return res.status(404).json({ error: 'Stock not found' });
    res.json(quote);
  } catch (err) {
    console.error('Quote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get history
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const range = req.query.range || '1y';
    const history = await getHistory(req.params.symbol, range);
    res.json(history);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 60分钟 K线 + 技术指标（东财 klt=60，供中栏「60分钟」周期切换使用）
app.get('/api/history60/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const count = Math.min(parseInt(req.query.count) || 400, 800);
    const history = await getHistoryPeriod(symbol, '60m', count);
    const technical = history.length >= 30 ? technicalAnalysis(history) : null;
    res.json({ success: history.length > 0, symbol, history, technical });
  } catch (err) {
    console.error('History60 error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 价格行为趋势推演（技术面页/短期判断/长期判断共用：10年日K重采样周/月线 + 60分钟K线，本地计算零LLM成本）
// 20260905g：缓存与计算下沉到 lib/priceActionHub 唯一出口，与短期/长期判断共用同一份快照（指标级单源）
app.get('/api/price-action/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const force = req.query.refresh === '1' || req.query.force === '1';
    const data = await getPriceActionSnapshot(symbol, { force });
    if (!data || data.error) {
      return res.json({ success: false, error: (data && data.error) || '价格行为推演失败' });
    }
    // 20260914i：落盘当日技术面方向判断（未来 5 个交易日口径），供准确率检查事后结算。
    // 与「短期行情判断」的 technicalShort 因子互不干扰——本模块只认「技术面自身方向 vs 后续价格」。
    let accuracy = null;
    try {
      const sym = normalizeSymbol ? normalizeSymbol(symbol) : symbol;
      techFaceJudgment.recordDailyJudgment(sym, data, { name: (req.query.name || '') });
      accuracy = techFaceJudgment.computeAccuracy(sym);
    } catch (e) {}
    res.json({ success: true, symbol, accuracy, ...data });
  } catch (err) {
    console.error('PriceAction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20260914i：个股技术面 · 准确率检查
app.get('/api/tech-face/records', async (req, res) => {
  try {
    const symbol = req.query.symbol ? (normalizeSymbol ? normalizeSymbol(req.query.symbol) : req.query.symbol) : null;
    if (symbol) {
      if (req.query.settle === '1') await techFaceJudgment.settleSymbol(symbol);
      const records = techFaceJudgment.readAll(symbol);
      const accuracy = techFaceJudgment.computeAccuracy(symbol, records);
      return res.json({ success: true, mode: 'symbol', symbol, accuracy, records: records.slice().reverse() });
    }
    if (req.query.settle === '1') await techFaceJudgment.settleAll();
    const accuracy = techFaceJudgment.computeGlobalAccuracy();
    // 全局模式返回各股汇总（按已结算样本数降序），逐条明细请带 ?symbol=
    const dirFiles = require('fs').readdirSync(techFaceJudgment.DIR).filter(f => f.endsWith('.json'));
    const bySymbol = dirFiles.map(f => {
      const s = f.replace(/\.json$/, '');
      const a = techFaceJudgment.computeAccuracy(s);
      return { ...a, name: (techFaceJudgment.readAll(s).slice(-1)[0] || {}).name || '' };
    }).sort((a, b) => (b.settledCount || 0) - (a.settledCount || 0));
    res.json({ success: true, mode: 'global', accuracy, bySymbol });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/tech-face/settle', async (req, res) => {
  try {
    const symbol = req.body && req.body.symbol;
    const r = symbol ? await techFaceJudgment.settleSymbol(symbol) : await techFaceJudgment.settleAll();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 市场情绪提醒 · 准确率（20260914i）----
// 情绪拐点预警的历史记录 + 准确率；?settle=1 先结算（拉上证 K 线）
app.get('/api/sentiment-accuracy/records', async (req, res) => {
  try {
    if (req.query.settle === '1') await sentimentAccuracy.settleAll();
    const records = sentimentAccuracy.getAllRecords();
    res.json({ success: true, accuracy: sentimentAccuracy.computeAccuracy(records), records });
  } catch (err) {
    console.error('[SentimentAccuracy] records error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/sentiment-accuracy/settle', async (req, res) => {
  try {
    const r = await sentimentAccuracy.settleAll();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 分时行情（腾讯分钟线，仅 A 股/港股/美股可用，供中栏「分时」周期切换使用）
app.get('/api/minute/:symbol', async (req, res) => {
  try {
    const info = detectMarket(req.params.symbol);
    const { minutes, prevClose } = await fetchTencentMinutes(info.tencentCode);
    res.json({ success: true, symbol: req.params.symbol, minutes, prevClose });
  } catch (err) {
    console.error('Minute error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get news
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const name = req.query.name || '';
    const news = await getNews(req.params.symbol, name);
    res.json(news);
  } catch (err) {
    console.error('News error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 今日财经热点（东方财富 7×24 快讯，首页展示；?refresh=1 强制刷新缓存）
app.get('/api/hot-news', async (req, res) => {
  try {
    const data = await getHotNews(req.query.refresh === '1');
    // 新闻 → 行业板块影响识别（标注受影响的板块 + 热门个股 + 涨跌方向），并记录到自学习库
    if (data && Array.isArray(data.items)) {
      data.items = annotateNewsImpact(data.items);
      for (const n of data.items) {
        if (n.impact && n.impact.sector) {
          recordImpact(n.title, n.impact.sector, n.impact.direction);
        }
      }
      data.impactLearning = getNewsImpactLearningState();
    }
    res.json(data);
  } catch (err) {
    console.error('Hot news error:', err);
    res.status(500).json({ source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], error: err.message });
  }
});

// 首页「板块舆情热度周榜」（20260909m：舆情+社区讨论热度五指标引擎，?refresh=1 强制刷新；不涉及行情主计算）
app.get('/api/home-hot-topics', async (req, res) => {
  try {
    const data = await hotTopicsWeekly.getWeeklyReport(req.query.refresh === '1');
    res.json(data);
  } catch (err) {
    console.error('Home hot topics error:', err);
    res.json({ ok: false, status: 'error', updated: new Date().toISOString(), rows: [], message: '周榜计算失败：' + err.message });
  }
});

// 原油主连冲击 · 诊断接口（突发因子·轻微事件变量，20260911；参考对象由布伦特原油期货改为原油主连）
app.get('/api/event/oil-shock', async (req, res) => {
  try {
    const eventEngine = require('./lib/eventEngine');
    res.json({ ok: true, ...eventEngine.getOilShockStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/event/oil-shock/refresh', async (req, res) => {
  try {
    const eventEngine = require('./lib/eventEngine');
    const force = !!(req.query.force || (req.body && req.body.force));
    await eventEngine.refreshCrudeShock(force);
    res.json({ ok: true, status: eventEngine.getOilShockStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 新闻影响判断 · 人工更正（自学习）：反馈某条判断是否正确，并可纠正板块/方向
app.post('/api/news-impact/correct', async (req, res) => {
  try {
    const { id, correct, correctedSector, correctedDirection } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: '缺少 id' });
    const rec = correctImpact(String(id), !!correct, correctedSector || null, correctedDirection || null);
    if (!rec) return res.status(404).json({ success: false, error: '未找到对应记录' });
    res.json({ success: true, record: rec, learning: getNewsImpactLearningState() });
  } catch (err) {
    console.error('[NewsImpact] correct error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 板块涨跌幅前五 · 近一周滚动统计提醒
app.get('/api/sector-rank-reminder', async (req, res) => {
  try {
    res.json({ success: true, ...getSectorRankReminder() });
  } catch (err) {
    console.error('[SectorRankReminder] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页「每日宏观 & 政策」采集（按自然日缓存，每日自动采集一次）
app.get('/api/macro-news', async (req, res) => {
  try {
    const data = await getMacroNews(req.query.refresh === '1');
    res.json(data);
  } catch (err) {
    console.error('Macro news error:', err);
    res.status(500).json({ source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], byCategory: {}, order: [], total: 0, error: err.message });
  }
});

// 首页「重要经济数据」（结构化指标 + 解读，每日缓存）
app.get('/api/macro-data', async (req, res) => {
  try {
    const data = await getMacroIndicators(req.query.refresh === '1');
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Macro data error:', err);
    res.status(500).json({ success: false, error: err.message, indicators: [], date: localDate(), available: 0, total: 5 });
  }
});

// 个股官方公告（巨潮资讯，确定性数据，非 AI）
app.get('/api/announcements/:symbol', async (req, res) => {
  try {
    const data = await getCninfoAnnouncements(req.params.symbol, 30);
    res.json(data);
  } catch (err) {
    console.error('Cninfo announcements error:', err);
    res.status(500).json({ ok: false, error: err.message, items: [] });
  }
});

// 首页「每日宏观 & 政策」—— 美国经济数据 / 事件（策划式事件卡片）
app.get('/api/us-macro-events', async (req, res) => {
  try {
    const events = getUsMacroEvents();
    res.json({ success: true, events, updated: new Date().toISOString() });
  } catch (err) {
    console.error('US macro events error:', err);
    res.status(500).json({ success: false, error: err.message, events: [] });
  }
});

// 首页「基金重仓行业配置矩阵」（季度行业配置比例，支持用户导入更新）
app.get('/api/market-rank', async (req, res) => {
  try {
    const data = await getMarketRank({ force: req.query.refresh === '1' });
    res.json(data);
  } catch (err) {
    console.error('Market rank error:', err);
    res.status(500).json({ updated: new Date().toISOString(), title: '行业配置矩阵', available: false, reason: err.message, quarters: [], sectors: [], note: '数据获取失败。' });
  }
});
app.post('/api/market-rank', (req, res) => {
  try {
    const { updateMarketRank } = require('./lib/marketRank');
    const input = req.body && (req.body.matrix || req.body.csv || req.body);
    const saved = updateMarketRank(input);
    res.json({ success: true, saved });
  } catch (err) {
    console.error('Market rank update error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});


// ---- 当日个股涨跌判断（透明加权打分 + 准确率统计）----

// 全部判断记录列表（供独立「准确率核对」页使用）
//   ?settle=1 时先触发全量结算（拉取各股 K 线，可能较慢）再返回最新快照
//   必须注册在 /:symbol 路由之前，否则 "records" 会被当作 symbol 参数匹配
app.get('/api/sameday-judgment/records', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim() : '';
    if (symbol) {
      // 个股视图：仅结算该股 + 仅返回该股记录与准确率
      if (req.query.settle === '1') await settleSymbol(symbol);
      const records = filterBySymbol(getAllRecords(), symbol);
      const accuracy = computeAccuracy(records);
      const name = records.length ? (records[0].name || symbol) : symbol;
      res.json({ success: true, records, accuracy, learning: getLearningState(symbol), count: records.length, symbolScope: symbol, symbolName: name });
    } else {
      if (req.query.settle === '1') await settleAll();
      const records = getAllRecords();
      const accuracy = computeAccuracy(records);
      res.json({ success: true, records, accuracy, learning: getLearningState(), count: records.length, symbolScope: null });
    }
  } catch (err) {
    console.error('[SameDayJudgment] records error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 自我进化 / 错误学习状态（因子命中率、权重演进、错误归因）
// 固定路径，必须注册在 /:symbol 之前
// ?symbol=xxx 时只返回该股票的最近错误归因，避免跨股展示。
app.get('/api/sameday-judgment/learning', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim() : '';
    res.json({ success: true, learning: getLearningState(symbol || undefined) });
  } catch (err) {
    console.error('[SameDayJudgment] learning error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Part B：弱关联关联度 / 持续性经验库状态（调试透明用）
app.get('/api/relevance-learning', async (req, res) => {
  try {
    res.json({ success: true, state: getRelevanceLearningState() });
  } catch (err) {
    console.error('[RelevanceLearning] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sameday-judgment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getJudgmentWithAccuracy(symbol, name, industry, force);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SameDayJudgment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 全量结算历史判断并返回准确率（按需触发，可能较慢：需拉取各股K线）
app.post('/api/sameday-judgment/settle', async (req, res) => {
  try {
    const acc = await settleAll();
    res.json({ success: true, accuracy: acc });
  } catch (err) {
    console.error('[SameDayJudgment] settle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 长期行情判断（中长期走势 / 价值取向，不核算准确率，每次打开自动 AI 联网更新）----
app.get('/api/long-term-judgment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getLongTermJudgment(symbol, name, force);
    res.json({ success: true, judgment: result });
  } catch (err) {
    console.error('[LongTermJudgment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comprehensive analysis
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const range = req.query.range || '1y';
    const name = req.query.name || '';

    console.log(`[Analysis] Fetching data for ${symbol}...`);

    // Fetch quote, history, and company profile in parallel
    const [quoteResult, historyResult, profileResult] = await Promise.allSettled([
      getQuote(symbol),
      getHistory(symbol, range),
      getCompanyProfile(symbol)
    ]);

    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const history = historyResult.status === 'fulfilled' ? historyResult.value : [];
    const companyProfile = profileResult.status === 'fulfilled' ? profileResult.value : null;

    if (!quote && history.length === 0) {
      return res.status(404).json({ error: '无法获取该股票的数据，请检查代码是否正确' });
    }

    console.log(`[Analysis] Quote: ${quote ? 'OK' : 'N/A'}, History: ${history.length} bars, Profile: ${companyProfile ? 'OK' : 'N/A'}`);

    // Technical analysis
    const technical = technicalAnalysis(history);

    // Classify company type for differentiated fundamental analysis
    const companyType = quote ? classifyCompanyType(symbol, name || quote?.name, quote, { income: [], balance: [], cashflow: [] }, null, []) : null;
    console.log(`[Analysis] Company type: ${companyType?.typeName || 'N/A'} (${companyType?.type || 'N/A'})`);

    // Market overview
    const info = detectMarket(symbol);

    // 关键财务指标对标：历史百分位 + 行业均值（先算，作为全站统一的「行业均值」基准）
    // 20260909d：基本面评分需以行业均值为基准，故必须先算 comparison，再算 fundamental（单一数据源）。
    let comparison = null;
    if (quote && info.market === 'CN') {
      try {
        comparison = await buildFundamentalComparison(symbol, quote);
      } catch (e) {
        console.error('[Analysis] fundamental comparison failed:', e.message);
      }
    }
    const industryAvgForScore = (comparison && comparison.industryAvg) ? comparison.industryAvg : null;

    // Fundamental analysis (with company type differentiation)
    const fundamental = quote ? fundamentalAnalysis(quote, companyType, { industryAvg: industryAvgForScore }) : { error: 'No fundamental data' };

    // 利好/利空 信号标记：统一复用 comparison.industryAvg 作为「行业均值」基准，
    // 确保概览信号卡与基本面卡的「行业均值」数值完全一致（单一数据源，杜绝两套基准）。
    const industryAvg = (comparison && comparison.industryAvg) ? comparison.industryAvg : null;
    const signals = quote ? evaluateSignals(quote.fundamentals, companyType, industryAvg, { percentiles: (comparison && comparison.percentiles) || null }) : { signals: [], compareBasis: '行业均值' };

    const result = {
      symbol,
      name: quote?.name || name || symbol,
      market: info.market,
      exchange: info.exchange,
      quote,
      history,
      technical,
      fundamental,
      signals,
      comparison,
      // 20260919a：指标分析——对左侧「关键财务指标」做确定性五维对比 + 判定依据（替代原分析师评级）
      metricAnalysis: quote ? buildMetricAnalysis(quote, comparison, companyType, signals.signals, fundamental) : null,
      companyType: companyType ? { type: companyType.type, typeName: companyType.typeName, typeIcon: companyType.typeIcon, description: companyType.description, focusText: companyType.focusText } : null,
      companyProfile,
      timestamp: new Date().toISOString()
    };

    res.json(result);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 股东分析（issue5）：股东户数走势 + 机构持仓变化 + 十大股东 + 基金持股
app.get('/api/shareholders/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    console.log(`[Shareholders] Fetching for ${symbol}...`);
    const data = await getShareholdersData(symbol);
    res.json(data);
  } catch (err) {
    console.error('Shareholders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 公司概况（issue6）：主要产品 / 主要客户 / 企业性质
app.get('/api/company-profile/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    console.log(`[CompanyProfile] Fetching for ${symbol}...`);
    const data = await getCompanyProfile(symbol);
    res.json(data);
  } catch (err) {
    console.error('CompanyProfile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 首页实时大盘概览（issue：大盘指数 / 美国股指 / 热门板块）
app.get('/api/market-overview', async (req, res) => {
  try {
    const data = await getMarketOverview();
    // 按日记录行业板块涨跌幅前五（供近一周滚动统计）
    if (Array.isArray(data.sectorsUp) || Array.isArray(data.sectorsDown)) {
      recordDailyRanking(data.sectorsUp, data.sectorsDown);
      // 首次启用或数据不足时，用当前板块数据回填近 SEED_DAYS 天的种子，
      // 让"出现次数"立即可见；明天起真实数据逐日覆盖种子。
      backfillSeed(data.sectorsUp, data.sectorsDown);
    }
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[MarketOverview] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·大盘估值趋势：上证50 / 沪深300 / 科创50 近5年PE(TTM)趋势
app.get('/api/index-pe-trend', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getIndexPETrend({ force });
    res.json(result);
  } catch (err) {
    console.error('[IndexPETrend] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·大盘技术分析：上证/深证/创业板指 收盘后六步技术面推演（短中期预判）
app.get('/api/market-technical', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getMarketTechnical({ force });
    // 20260914i：落盘当日方向判断（短期=次日 / 中期=20交易日），供准确率检查事后结算。
    // 成交后（marketClosed）才落盘，避免盘中把「未定方向」当成收盘判断记入。
    try {
      if (marketClosed(new Date())) marketTechJudgment.recordDailyJudgment(result);
    } catch (e) { console.error('[MarketTechnical] 落盘判断失败:', e && e.message); }
    res.json(result);
  } catch (err) {
    console.error('[MarketTechnical] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20260914i：大盘技术分析 · 准确率检查（逐条记录 / 统计 / 手动结算）
app.get('/api/market-tech/records', async (req, res) => {
  try {
    if (req.query.settle === '1') await marketTechJudgment.settleAll();
    const records = marketTechJudgment.getAllRecords();
    const accuracy = marketTechJudgment.computeAccuracy(records);
    res.json({ success: true, accuracy, records: records.slice().reverse() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/market-tech/settle', async (req, res) => {
  try {
    const r = await marketTechJudgment.settleAll();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·行业板块拥挤度（当日/本周/本月 前五）：板块成交额 ÷ 全市场成交额 × 100%
app.get('/api/sector-crowding', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const mo = await getMarketOverview();
    // 落盘当日拥挤度（20260909n：交易日感知——上证日K最新日期==今天才落盘；
    // 节假日/盘前的陈旧板块数据不再被误标为「今天」污染周月统计。数据源 date 字段=抓取时刻，非真实数据日期）
    if (Array.isArray(mo.sectorAll) && (await _canRecordToday(mo.sectorAll))) {
      recordSectorCrowding(mo.sectorAll, mo.sectorDate);
    }
    // 历史回填：刷新时同步拉取（前端有 loading 提示）；首跑 store 空时后台静默补，不阻塞首页
    const should = refresh || sectorCrowdingNeedsBackfill();
    if (should) {
      const run = () => backfillSectorCrowding(21, findPython())
        .then(r => console.log('[SectorCrowding] backfill done:', JSON.stringify(r)))
        .catch(e => console.error('[SectorCrowding] backfill failed:', e.message));
      if (refresh) await run(); else run();
    }
    const result = getSectorCrowding(mo.sectorAll, mo.sectorDate);
    res.json({ success: true, ...result, backfilled: Boolean(refresh && should) });
  } catch (err) {
    console.error('[SectorCrowding] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·行业板块资金流向（主力净流入/流出前五 + 近5日最大流入/流出板块）
app.get('/api/sector-capital-flow', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const data = await getSectorCapitalFlow(refresh);
    res.json({ success: data.ok !== false, ...data });
  } catch (err) {
    console.error('[SectorCapitalFlow] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 市场情绪因子原始数据（量化广度 + 杠杆情绪 + 文本舆情；供调试与透明展示）
app.get('/api/sentiment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const data = await getMarketSentiment(symbol, name);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Sentiment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 行业板块走势原始数据（个股所属行业板块整体涨跌；供调试与透明展示）
app.get('/api/sector-trend/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const data = await getSectorTrend(symbol, name, industry);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[SectorTrend] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 基金行业配置名单（全市场权益类基金 · 前十大重仓股 · 按持仓市值加总排名）
// 数据源：东方财富公开接口（基金列表 + 各基金最新报告期前十大重仓股 + 个股行业）
// 说明：全量约 1 万只母基金，首次采集需十几分钟 → 后台增量采集 + 磁盘缓存（按季度）
app.get('/api/fund-industry-matrix', async (req, res) => {
  try {
    const minFunds = Math.max(0, parseInt(req.query.minFunds || '0', 10) || 0);
    const data = fundMatrix.getFundIndustryRanking({ minFunds });
    // 首次访问且尚无缓存 → 自动启动后台采集（不阻塞本次响应）
    if (data.coverage.covered === 0 && !data.progress.running) {
      fundMatrix.startCrawl({}).catch(() => {});
    }
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[FundMatrix] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 触发/继续/重建基金持仓采集（force=1 全量重采）
app.post('/api/fund-industry-matrix/crawl', async (req, res) => {
  try {
    const force = req.query.force === '1' || (req.body && req.body.force === true);
    const r = await fundMatrix.startCrawl({ force });
    res.json({ success: true, ...r });
  } catch (err) {
    console.error('[FundMatrix] crawl error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 采集进度（供前端轮询）
app.get('/api/fund-industry-matrix/progress', (req, res) => {
  res.json({ success: true, ...fundMatrix.getCrawlStatus(), quarter: fundMatrix.getQuarterStatus() });
});

// 自然季度更新状态（目标报告期 / 是否已披露 / 是否已完成 / 上次与下次检查时间）
app.get('/api/fund-industry-matrix/quarter', (req, res) => {
  res.json({ success: true, ...fundMatrix.getQuarterStatus() });
});

// 板块涨跌停占比原始数据（板块内涨停/跌停家数占比；供调试与透明展示）
app.get('/api/sector-limit/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const data = await getSectorLimitStats(symbol, name, industry);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[SectorLimit] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 全市场情绪（20260917d：升级为「大盘量能情绪分析模型」）----
// 首页全局预警条用：全市场级，不依赖个股。10 因子确定性计算，无 LLM。
function readMsiHeat() {
  try {
    const series = MSI.readSeries();
    for (let i = series.length - 1; i >= 0; i--) {
      const c = (series[i].components || []).find(x => x.key === 'marketHeat');
      if (c && typeof c.signal === 'number') {
        // 20260917f：连同 value/detail（数据源、样本数、更新时间、看多占比）一起带出，
        // 并在找不到「今日」热度时如实返回其真实日期，由模型侧判定时效（不再静默当成今天）。
        return { marketHeat: c.signal, date: series[i].date, value: c.value || '', detail: c.detail || '' };
      }
    }
  } catch (e) {}
  return null;
}

async function buildHomeMarketEmotion(refresh) {
  const data = await getMarketEmotionData({ refresh });
  // 股吧讨论热度：优先取 MSI 序列（收盘后由 runAutoReview 落盘，免请求路径上再跑 60s 抓取）
  let heat = readMsiHeat();
  if (!heat) {
    try {
      const sent = await getMarketSentiment('601318', '中国平安');
      const ms = sent && sent.marketSentiment;
      if (ms && ms.ok && typeof ms.marketHeat === 'number') {
        const rd = (x) => Math.round(x * 100) / 100;
        heat = {
          marketHeat: ms.marketHeat,
          date: data.date,
          value: `热度 ${rd(ms.marketHeat)}`,
          detail: `讨论综合得分 ${ms.marketAvgScore != null ? ms.marketAvgScore : '—'}、看多占比 ${ms.marketUpRatio != null ? Math.round(ms.marketUpRatio * 100) + '%' : '—'}（数据源：${ms.coverage || '东财股吧'}${typeof ms.sampleCount === 'number' ? `，样本 ${ms.sampleCount} 只` : ''}${ms.updatedAt ? `，更新于 ${ms.updatedAt}` : ''}）`,
        };
      }
    } catch (e) { /* best-effort */ }
  }
  if (heat) data.discussionHeat = heat;
  let macro = [];
  try {
    const shHistory = ((data.index && data.index.bars) || []).map(b => ({ date: b.date, close: b.close }));
    macro = await computeMacroFactors({ shHistory });
  } catch (e) { console.error('[MarketEmotion] 宏观因子计算失败:', e && e.message); }
  return marketEmotionModel.computeMarketEmotion({ data, macroFactors: macro });
}

app.get('/api/sentiment-turning-point', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const emo = await buildHomeMarketEmotion(force);
    // 20260914i 兼容：把新模型的「短期倾向」留档到既有准确率台账（口径=次日上证涨跌，容差 ±0.5%）
    let accuracy = null;
    try {
      const abs = Math.abs(emo.totalScore);
      const level = abs >= 0.5 ? '强烈预警' : abs >= 0.2 ? '预警' : '关注';
      sentimentAccuracy.recordDailyJudgment({
        level,
        impliedDir: emo.tendency,
        zScore: emo.totalScore,
        extremeZ: null,
        reasons: [{ text: `情绪总分 ${emo.totalScore}，${emo.coreDriver}；${emo.volumeState}` }],
      }, { baseDate: emo.baselineDate });
      accuracy = sentimentAccuracy.computeAccuracy();
    } catch (e) { /* best-effort */ }
    res.json({ success: true, ...emo, accuracy });
  } catch (err) {
    console.error('[MarketEmotion] error:', err && err.stack ? err.stack : err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 个股页情绪拐点面板用：额外给出该股对全市场情绪的敏感度（beta）
app.get('/api/sentiment-turning-point/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const state = await getTurningPointState({ symbol, name, refresh: force });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[SentimentTP] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 调试/图表用：当前实时指数 + 时间序列（含近似回填）
app.get('/api/sentiment-index', async (req, res) => {
  try {
    const live = await MSI.computeIndex({});
    const { real, full, backfilled } = MSI.getSeries({ allowBackfill: true });
    res.json({ success: true, live, real, full, backfilled });
  } catch (err) {
    console.error('[SentimentIndex] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 自选股：服务端持久化（真源移出浏览器 localStorage，避免更新/重启周期中偶发丢失）----
const WATCHLIST_FILE = path.join(__dirname, 'data', 'watchlist.json');

function readWatchlistFile() {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeWatchlistFile(list) {
  try {
    fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[Watchlist] write failed:', e.message);
    return false;
  }
}

app.get('/api/watchlist', (req, res) => {
  res.json({ success: true, list: readWatchlistFile() });
});

app.put('/api/watchlist', (req, res) => {
  try {
    const body = req.body || {};
    const incoming = Array.isArray(body) ? body : (Array.isArray(body.list) ? body.list : null);
    if (!incoming) return res.status(400).json({ success: false, error: 'body.list 必须是数组' });
    // 仅保留含合法 symbol 的项，并按 symbol 去重
    const seen = new Set();
    const clean = [];
    for (const it of incoming) {
      if (it && typeof it.symbol === 'string' && it.symbol && !seen.has(it.symbol)) {
        seen.add(it.symbol);
        clean.push({
          symbol: it.symbol,
          name: typeof it.name === 'string' ? it.name : '',
          market: typeof it.market === 'string' ? it.market : '',
          addedAt: typeof it.addedAt === 'number' ? it.addedAt : Date.now(),
        });
      }
    }
    if (!writeWatchlistFile(clean)) return res.status(500).json({ success: false, error: '写入失败' });
    res.json({ success: true, list: clean });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20260906 路由拆分：AI 联网 / 妙想 / 行业指数 / 产品图片等 35 条路由移至 routes/aiRoutes.js
app.use(aiRoutes);
// 20260907a：三联动·事件驱动路由（活跃事件 / 扫描 / 配置 / 暂停 / 改分级 / 重算）
app.use(eventRoutes);
app.use(dedicatedFactorRoutes); // 20260911：专属因子路由

// 个股市值历史走势（亿元，日频），供行业分析页叠加当前股票市值双坐标轴
// 复用 lib/eastmoneyValuation.fetchValuationTTM 的日频序列（TOTAL_MARKET_CAP），保证与估值模块同源（规则一）
app.get('/api/stock-market-cap-history/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
    const val = await fetchValuationTTM(symbol);
    // 20260911：优先用「全量日频序列」dailyAll（不过滤 PE 正负）。此前用 daily 时，PE_TTM 为负的
    // 亏损股（如 688660 电气风电，2023-02-27 起 PE 转负）整段被 pe>0 过滤掉 → 市值线缺失；
    // dailyAll 保留全部交易日。兼容旧缓存对象（无 dailyAll）时回退到 daily。
    const src = (val && Array.isArray(val.dailyAll) && val.dailyAll.length) ? val.dailyAll
      : (val && Array.isArray(val.daily) ? val.daily : null);
    if (!src || src.length === 0) {
      return res.json({ success: false, error: '无市值历史数据', source: '东方财富TTM', fetchedAt: new Date().toISOString() });
    }
    const data = src
      .filter(d => d.date && d.marketCap > 0)
      .map(d => ({ date: d.date, marketCap: d.marketCap }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (data.length === 0) {
      return res.json({ success: false, error: '无市值历史数据', source: '东方财富TTM', fetchedAt: new Date().toISOString() });
    }
    // 20260911：新鲜度闸门（数据最新性铁律）——序列末日距今天过久时不再返回，
    // 避免前端把「最后一次已知市值」一路平移到最新K线上画出误导性直线。
    const lastDate = data[data.length - 1].date;
    const lagDays = Math.floor((Date.now() - new Date(lastDate + 'T00:00:00+08:00').getTime()) / 86400000);
    if (!isFinite(lagDays) || lagDays > 20) {
      return res.json({
        success: false,
        symbol,
        error: 'MARKETCAP_STALE',
        staleDate: lastDate,
        lagDays,
        message: `个股市值历史数据已过期（截至 ${lastDate}，滞后 ${lagDays} 天），已跳过市值线绘制`,
        source: '东方财富TTM',
        fetchedAt: new Date().toISOString(),
      });
    }
    res.json({
      success: true,
      symbol,
      data,
      unit: '亿元',
      source: '东方财富TTM',
      date: lastDate,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[StockMarketCapHistory] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- 个股近期热点（20260827c 重构：AI 联网，按涨跌幅切异动归因/网络热议） ----------
app.get('/api/hot-topics/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    const name = (req.query && req.query.name) || '';
    const force = !!(req.query && req.query.refresh);
    if (!symbol) return res.status(400).json({ ok: false, error: 'NO_SYMBOL' });
    const state = await hotTopics.getState(symbol, name, force);
    res.json(state);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// Deep analysis (product company analysis - 26 sections)// ---- Deep Analysis 磁盘缓存（避免每次重新抓取/分析）----
function getAnalysisCachePath(symbol) {
  return path.join(__dirname, 'data', 'cache', 'deep-analysis', `${symbol}.json`);
}

function isAnalysisCacheValid(obj) {
  if (!obj || !obj.sections) return false;
  const sec = obj.sections;
  // 核心财务数据为空 = 抓取/分析失败，不应复用缓存（否则图表空白长期冻结）
  if (!Array.isArray(sec.revenueCostData) || sec.revenueCostData.length === 0) return false;
  if (!Array.isArray(sec.marketCapData) || sec.marketCapData.length === 0) return false;
  return true;
}

function readAnalysisCache(symbol) {
  try {
    const p = getAnalysisCachePath(symbol);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 版本门控：缓存由旧版本代码写入（无 appVersion 或版本不符）时视为失效，
      // 强制按新版本重新生成，避免升级后用户仍看到旧结构（如缺失新增字段）。
      if (obj && obj.appVersion === APP_VERSION && isAnalysisCacheValid(obj)) return obj;
      console.log(`[Cache] invalidating ${symbol} (version mismatch or empty core data)`);
    }
  } catch (e) {
    console.error('[Cache] read failed:', e.message);
  }
  return null;
}

function writeAnalysisCache(symbol, result) {
  try {
    if (!isAnalysisCacheValid(result)) {
      console.log(`[Cache] skip writing invalid cache for ${symbol}: core sections empty`);
      return;
    }
    const dir = path.join(__dirname, 'data', 'cache', 'deep-analysis');
    fs.mkdirSync(dir, { recursive: true });
    result.appVersion = APP_VERSION;
    fs.writeFileSync(getAnalysisCachePath(symbol), JSON.stringify(result), 'utf8');
  } catch (e) {
    console.error('[Cache] write failed:', e.message);
  }
}

// 三规则铺开：行情模块「数据一致性 / 数据最新性 / 变化与边际分析」合规数据
app.get('/api/quote-rules/:symbol', async (req, res) => {
  try {
    const { getQuoteHub, beginSnapshot } = require('./lib/quoteHub');
    const hub = await getQuoteHub(req.params.symbol);
    if (!hub || !hub.ok) {
      return res.json({ success: false, error: (hub && hub.error) || '未获取到行情数据', note: (hub && hub.note) || '' });
    }
    // 规则一③：返回即冻结快照，保证本次响应内数据一致
    res.json({ success: true, ...beginSnapshot(hub) });
  } catch (err) {
    console.error('[QuoteRules] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 三规则样板：估值模块「数据一致性 / 数据最新性 / 变化与边际分析」合规数据
// 轻量端点，便于快速核验规则落地情况（不必等待整套深度分析）
app.get('/api/valuation-rules/:symbol', async (req, res) => {
  try {
    const { getValuationHub, beginSnapshot } = require('./lib/valuationHub');
    const hub = await getValuationHub(req.params.symbol);
    if (!hub || !hub.ok) {
      return res.json({ success: false, error: (hub && hub.error) || '未获取到估值数据', note: (hub && hub.note) || '' });
    }
    // 规则一③：返回即冻结快照，保证本次响应内数据一致
    res.json({ success: true, ...beginSnapshot(hub) });
  } catch (err) {
    console.error('[ValuationRules] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- 本地数据库（SQLite）查询接口 ----------------
// 健康检查：库状态 + 各表行数
app.get('/api/db/health', (req, res) => {
  try {
    res.json({ success: true, ...db.getDbInfo() });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 分红时序（近 N 年每次派息）：直接读本地 SQLite，含 变化率 + 边际变化（规则三）。
// 若本地为空则先按当前代码补抓一次（仅当请求带 refresh=1 或库为空时），否则纯读库不联网。
app.get('/api/db/dividend-series/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!symbol) return res.json({ success: false, error: 'invalid symbol' });
    const existing = db.getSeries(symbol, 'dividend_per_share');
    // 库为空且明确要求刷新时，按单一权威源补抓一次（保持规则一·单源）
    if ((!existing.length && req.query.refresh !== '0') || req.query.refresh === '1') {
      try {
        const rows = await fetchDividends(symbol);
        persistDividends(symbol, symbol, rows);
      } catch (e) {
        console.error('[DB] dividend backfill failed:', e.message);
      }
    }
    const series = loadDividendSeries(symbol);
    res.json({
      success: true,
      symbol,
      count: series.length,
      source: series[0]?.source || null,
      note: '数据来自本地 SQLite（eastmoney:RPT_SHAREBONUS_DET）。changePct=当期变化率；marginal=边际变化（变化的变化）；direction=up/down/flat',
      series,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 最近一次分析快照（分析期数据锁定）
app.get('/api/db/snapshot/:symbol', (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const snap = db.getLatestSnapshot(symbol);
    if (!snap) return res.json({ success: true, symbol, found: false });
    // payload 可能很大，仅回传概要 + 关键标量，避免接口臃肿
    const p = snap.payload || {};
    res.json({
      success: true,
      symbol,
      found: true,
      snapshotId: snap.snapshot_id,
      range: snap.range,
      createdAt: snap.created_at,
      symbolInPayload: p.symbol,
      sectionsKeys: p.sections ? Object.keys(p.sections) : [],
      timestamp: p.timestamp,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 某股票全部标量数据点（估值/价格等），附 isFresh 新鲜度（规则二 TTL 判定）
app.get('/api/db/datapoints/:symbol', (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const rows = db.getDataPoints(symbol);
    res.json({
      success: true,
      symbol,
      count: rows.length,
      note: 'isFresh=true 表示在 TTL 有效期内；false 表示已过期需重拉。value 为数值，value_text 为非数值型。',
      points: rows.map((r) => ({
        key: r.key,
        value: r.value,
        valueText: r.value_text,
        asOf: r.as_of,
        source: r.source,
        fetchedAt: r.fetched_at,
        validUntil: r.valid_until,
        isFresh: r.isFresh,
        extra: r.extra,
      })),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ---------------- 深度分析 ----------------
app.get('/api/deep-analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    // 标准化为数字股票代码（如 '601318'），用于严格按股票过滤本地资料库
    let stockCode = symbol;
    try {
      const info = detectMarket(symbol);
      stockCode = info.tencentCode.replace(/^(sh|sz)/, '');
    } catch (e) { /* 保底使用原始 symbol */ }

    console.log(`[DeepAnalysis] Starting for ${symbol} (refresh=${forceRefresh})...`);

    // 命中磁盘缓存且非强制刷新：直接返回，跳过耗时的重新分析
    if (!forceRefresh) {
      const cached = readAnalysisCache(symbol);
      if (cached) {
        console.log(`[DeepAnalysis] Serving cached result for ${symbol}`);
        // 本地资料库每请求实时读取，确保只显示「当前股票」自己的文档且反映最新上传
        cached.localDocuments = getLocalDocuments(stockCode);
        // AI 解读实时覆盖（20260902l）：深度分析缓存里的 earningsReport/researchAI/announcementAI
        // 是生成时的快照；用户点「重新解读」后新结果只写入 ai_cache，此处需同步最新版本，
        // 否则下次打开页面仍显示旧解读。缺 ai_cache 时保留原快照。
        if (cached.sections) {
          try { const v = readCache(symbol, '_earnings'); if (v && v.summary) cached.sections.earningsReport = v; } catch {}
          try { const v = readCache(symbol, '_research'); if (v && v.summary) cached.sections.researchAI = v; } catch {}
          try { const v = readCache(symbol, '_announcements'); if (v && v.summary) cached.sections.announcementAI = v; } catch {}
        }
        return res.json({ ...cached, fromCache: true });
      }
    }

    // Fetch quote and history in parallel
    const [quote, history] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, 'daily').catch(() => []),
    ]);

    if (!quote) {
      return res.status(404).json({ error: '无法获取股票行情数据' });
    }

    // 总超时兜底：避免任何外部接口无响应时前端永久转圈（内部各请求已有 10-15s 超时；可选抓取另有 8s 单独超时）
    const result = await Promise.race([
      deepAnalysis(symbol, name || quote.name, quote, history),
      new Promise((_, reject) => setTimeout(() => reject(new Error('深度分析超时（外部数据接口响应过慢，请稍后重试）')), 55000)),
    ]);

    result.cachedAt = Date.now();
    result.fromCache = false;
    writeAnalysisCache(symbol, result);

    // 本地资料库实时读取，确保只显示「当前股票」自己的文档
    result.localDocuments = getLocalDocuments(stockCode);

    res.json(result);
  } catch (err) {
    console.error('Deep analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Investment Journal Verification API ----
app.post('/api/journal/verify', async (req, res) => {
  try {
    const { title, content, stockCode, stockName, type } = req.body;
    
    console.log(`[Journal] Verifying note: "${title}" for ${stockName || stockCode}`);
    
    // Analyze the note content for verifiable claims
    const claims = extractClaims(content, title);
    const results = [];
    let totalProbability = 50; // Start at neutral
    let verifiedCount = 0;
    let partialCount = 0;
    let unverifiedCount = 0;
    
    // Try to verify each claim against available data
    if (stockCode) {
      try {
        const info = detectMarket(stockCode);
        if (info.market === 'CN') {
          const code = info.tencentCode.replace(/^(sh|sz)/, m => m.toUpperCase());
          const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
          
          // Fetch financial data and current quote for verification
          const { fetchFinancialData, fetchDividends } = require('./lib/deepAnalysis');
          const needDividends = claims.some(c => c.type === 'no_dividend');
          const [finData, quoteData, dividendRows] = await Promise.all([
            fetchFinancialData(emCode),
            getQuote(stockCode).catch(() => null),
            needDividends ? fetchDividends(emCode).catch(() => []) : Promise.resolve(null),
          ]);
          
          if (finData.income && finData.income.length > 0) {
            // Verify each claim
            for (const claim of claims) {
              const result = verifyClaimAgainstData(claim, finData, stockName || stockCode, quoteData, dividendRows);
              results.push(result);
              
              if (result.status === 'verified') {
                verifiedCount++;
                totalProbability += 10;
              } else if (result.status === 'partially_verified') {
                partialCount++;
                totalProbability += 3;
              } else if (result.status === 'unverified') {
                unverifiedCount++;
                totalProbability -= 5;
              }
            }
          }
        }
      } catch (e) {
        console.error('[Journal] Data fetch error:', e.message);
      }
    }
    
    // Analyze claim types for general probability assessment
    const typeBonus = analyzeClaimTypes(claims, type);
    totalProbability += typeBonus;
    
    // Clamp probability
    totalProbability = Math.max(5, Math.min(95, totalProbability));
    
    // Determine overall status
    // 全部判断点均验证通过（≥1个且无部分/未验证）→ 直接判 verified：
    // 事实类声明（如"中报不分红"）经分红数据比对属实，不应因概率公式初始值偏低被压成"部分验证"
    const allVerified = results.length > 0 && verifiedCount === claims.length && partialCount === 0 && unverifiedCount === 0;
    let status;
    if (totalProbability >= 70 || allVerified) status = 'verified';
    else if (totalProbability >= 40) status = 'partially_verified';
    else status = 'unverified';
    
    // Generate result text
    const resultText = generateVerificationText(status, totalProbability, results, claims);
    
    res.json({
      status,
      probability: Math.round(totalProbability),
      result: resultText,
      details: results.length > 0 ? results.map(r => `[${r.status}] ${r.claim}: ${r.evidence}`).join('\n') : null,
      claimsAnalyzed: claims.length,
      verifiedCount,
      partialCount,
      unverifiedCount,
    });
    
  } catch (err) {
    console.error('Journal verify error:', err);
    res.status(500).json({ error: err.message, status: 'error', probability: 0, result: '验证失败' });
  }
});

// ---- Notes persistence（服务端单一权威源，20260916b）----
// 投资心得 / 大盘记录 / 个股亮点雷点 全部落盘到 data/notes.json，
// 避免仅存 localStorage 在「硬刷新清缓存 / 代码更新」时被清空导致手动录入数据丢失。
// 前端以服务端为权威源，但会合并本地独有（离线录入未上送）的条目并回写，确保不丢数据。
const NOTES_FILE = path.join(__dirname, 'data', 'notes.json');
function readNotesFile() {
  try {
    if (!fs.existsSync(NOTES_FILE)) return [];
    const raw = fs.readFileSync(NOTES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[Notes] read failed:', e.message);
    return [];
  }
}
function writeNotesFile(arr) {
  const dir = path.dirname(NOTES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(arr, null, 2));
}
// 读取全部笔记（前端初始化时拉取，作为权威源）
app.get('/api/notes', (req, res) => {
  res.json({ success: true, notes: readNotesFile() });
});
// 全量同步（前端本地改动后整体回写；单用户场景下等价于 localStorage 的落盘动作）
app.post('/api/notes/sync', (req, res) => {
  try {
    const body = req.body || {};
    const notes = Array.isArray(body.notes) ? body.notes : [];
    writeNotesFile(notes);
    res.json({ success: true, count: notes.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Extract verifiable claims from note text
function extractClaims(content, title) {
  const text = `${title} ${content}`;
  const claims = [];

  // PE-related claims (handles 约, 低于, 大约, etc.)
  const peMatches = text.match(/PE[约低于<大约]?\s*([\d.]+)\s*倍?|市盈率[约低于大约]?\s*([\d.]+)\s*倍?|PE[高于>]?\s*([\d.]+)/gi);
  if (peMatches) {
    for (const m of peMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'pe', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // PB-related claims
  const pbMatches = text.match(/PB[约低于<大约]?\s*([\d.]+)\s*倍?|市净率[约低于大约]?\s*([\d.]+)\s*倍?|PB[高于>]?\s*([\d.]+)/gi);
  if (pbMatches) {
    for (const m of pbMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'pb', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Growth rate claims (handles 超过, 达, 约, etc.)
  const growthMatches = text.match(/增长[率]?\s*(?:超过|约|达|大于|约达)?\s*(\d+)%|增速\s*(?:超过|约|达|大于)?\s*(\d+)%|growth\s*(\d+)%/gi);
  if (growthMatches) {
    for (const m of growthMatches) {
      const num = m.match(/\d+/);
      if (num) claims.push({ type: 'growth', text: m, value: parseInt(num[0]), raw: m });
    }
  }
  
  // Price-related claims (handles 约, 左右, etc.)
  const priceMatches = text.match(/价格?\s*约?\s*(\d+\.?\d*)\s*[元块左右]|股价\s*约?\s*(\d+\.?\d*)|价格?\s*(\d+\.?\d*)\s*[元块]/gi);
  if (priceMatches) {
    for (const m of priceMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'price', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Dividend yield claims
  const divMatches = text.match(/股息率\s*[约]?\s*(\d+\.?\d*)%|分红率\s*[约]?\s*(\d+\.?\d*)%|dividend\s*(\d+\.?\d*)%/i);
  if (divMatches) {
    const num = divMatches[0].match(/[\d.]+/);
    if (num) claims.push({ type: 'dividend_yield', text: divMatches[0], value: parseFloat(num[0]), raw: divMatches[0] });
  }
  
  // Net profit margin claims (handles 维持在, 约, etc.)
  const marginMatches = text.match(/净利润率\s*(?:维持在|约|达|超过)?\s*(\d+\.?\d*)%|净利率\s*(?:维持在|约|达)?\s*(\d+\.?\d*)%|利润率\s*(?:维持在|约|达|超过)?\s*(\d+\.?\d*)%/gi);
  if (marginMatches) {
    for (const m of marginMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'margin', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Expected return claims
  const returnMatches = text.match(/涨幅\s*[可达约]?\s*(\d+)%|收益\s*[可达约]?\s*(\d+)%|回报\s*[可达约]?\s*(\d+)%/gi);
  if (returnMatches) {
    for (const m of returnMatches) {
      const num = m.match(/\d+/);
      if (num) claims.push({ type: 'expected_return', text: m, value: parseInt(num[0]), raw: m });
    }
  }

  // No-dividend claims (e.g. "2026年中报不分红" / "不派发现金红利" / "无利润分配方案") —
  // 事实性声明，可比对东财分红送配表精确验证
  const noDivMatches = text.match(/(?:不|无|未|没有)[^。，；！\n]{0,12}?(?:分红|派息|派发|股息|红利|利润分配)/g);
  if (noDivMatches) {
    const yearM = text.match(/(20\d{2})\s*年/);
    const stageM = text.match(/中报|中期|半年报|一季报|一季|三季报|三季|年报|年度/);
    claims.push({
      type: 'no_dividend',
      text: noDivMatches[0],
      value: null,
      raw: `${yearM ? yearM[1] + '年' : ''}${stageM ? stageM[0] : ''}${noDivMatches[0]}`,
      year: yearM ? yearM[1] : null,
      stage: stageM ? stageM[0] : null,
    });
  }

  // General qualitative claims (always present if no quantitative claims)
  if (claims.length === 0) {
    claims.push({ type: 'qualitative', text: text.substring(0, 100), value: null, raw: '定性判断' });
  }

  return claims;
}

// Verify a claim against financial data
function verifyClaimAgainstData(claim, finData, stockName, quote, dividends) {
  const { income, balance } = finData;
  const latest = income[income.length - 1];
  if (!latest) return { claim: claim.raw, status: 'unverified', evidence: '无法获取财务数据' };
  
  const revenue = parseFloat(latest.TOTAL_OPERATE_INCOME || latest.YYSR || 0);
  const netProfit = parseFloat(latest.PARENT_NETPROFIT || latest.NETPROFIT || latest.JLR || 0);
  const price = quote?.price || 0;
  const pe = quote?.pe || quote?.fundamentals?.pe || 0;
  const pb = quote?.pb || quote?.fundamentals?.pb || 0;
  const totalValue = quote?.totalValue || 0; // 总市值(亿)
  
  switch (claim.type) {
    case 'pe': {
      if (pe > 0) {
        const diff = Math.abs(pe - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 10) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}接近，验证通过。` };
        } else if (pctDiff < 30) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}最新净利润${(netProfit/1e8).toFixed(1)}亿，PE判断需要实时市值数据配合验证。` };
    }
    case 'pb': {
      if (pb > 0) {
        const diff = Math.abs(pb - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 10) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}接近，验证通过。` };
        } else if (pctDiff < 30) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      const latestBal = balance[balance.length - 1];
      const netAssets = parseFloat(latestBal?.TOTAL_PARENT_EQUITY || latestBal?.TOTAL_EQUITY || 0);
      return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}最新归母净资产${(netAssets/1e8).toFixed(1)}亿，PB判断需要实时市值数据配合验证。` };
    }
    case 'growth': {
      // Verify growth rate against historical data
      if (income.length >= 2) {
        const prev = income[income.length - 2];
        const prevRevenue = parseFloat(prev.TOTAL_OPERATE_INCOME || prev.YYSR || 0);
        const currRevenue = revenue;
        const actualGrowth = prevRevenue > 0 ? ((currRevenue / prevRevenue - 1) * 100) : 0;
        const claimedGrowth = claim.value;
        const diff = Math.abs(actualGrowth - claimedGrowth);
        
        if (diff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%接近，验证通过。` };
        } else if (diff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%有一定偏差。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%偏差较大。` };
        }
      }
      return { claim: claim.raw, status: 'unverified', evidence: '历史数据不足' };
    }
    case 'price': {
      if (price > 0) {
        const diff = Math.abs(price - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元接近，验证通过。` };
        } else if (pctDiff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      return { claim: claim.raw, status: 'partially_verified', evidence: '价格判断需结合实时行情验证，建议查看当前股价。' };
    }
    case 'no_dividend': {
      if (!Array.isArray(dividends)) {
        return { claim: claim.raw, status: 'partially_verified', evidence: '分红数据获取失败，无法验证分红类判断。' };
      }
      // 报告期映射：中报→06-30，一季报→03-31，三季报→09-30，年报→12-31
      const stageDate = { '中报': '-06-30', '中期': '-06-30', '半年报': '-06-30', '半年': '-06-30',
                          '一季报': '-03-31', '一季': '-03-31', '三季报': '-09-30', '三季': '-09-30',
                          '年报': '-12-31', '年度': '-12-31' };
      // 未写年份/期数时：用最新一期财报报告期兜底（该报告期已披露，验证结果即代表当前事实）
      const fallbackDate = (latest.REPORT_DATE || latest.REPORTDATE || '').slice(0, 10);
      let year = claim.year, stage = claim.stage;
      if (!year || !stage) {
        if (!fallbackDate) {
          return { claim: claim.raw, status: 'partially_verified', evidence: '判断未注明报告期，且无法确定最新报告期，需人工核对。' };
        }
        year = fallbackDate.slice(0, 4);
        stage = ({ '03-31': '一季报', '06-30': '中报', '09-30': '三季报', '12-31': '年报' })[fallbackDate.slice(5)] || '年报';
      }
      const targetDate = `${year}${stageDate[stage] || '-12-31'}`;
      const rec = dividends.find(d => String(d.reportDate || '').slice(0, 10) === targetDate);
      if (rec && rec.dividendPerShare > 0) {
        return { claim: claim.raw, status: 'unverified', evidence: `东财分红送配数据显示${year}年${stage}有分红方案（${rec.plan || `每10股派${(rec.dividendPerShare * 10).toFixed(2)}元`}），"不分红"判断与事实不符。` };
      }
      if (rec) {
        // 有分红记录但金额未定（预披露/预案阶段）：公司已明确分红意向，"不分红"与事实不符
        return { claim: claim.raw, status: 'unverified', evidence: `东财分红送配数据显示${year}年${stage}已有分红安排（${rec.plan || '方案'}，进度：${rec.progress || '预案'}），"不分红"判断与事实不符。` };
      }
      const yearHasAnyDiv = dividends.some(d => String(d.reportDate || '').startsWith(year));
      const base = `东财分红送配数据中${year}年${stage}（报告期${targetDate}）无分红记录`;
      if (yearHasAnyDiv || !claim.year) {
        return { claim: claim.raw, status: 'verified', evidence: `${base}，"不分红"判断属实。` };
      }
      return { claim: claim.raw, status: 'verified', evidence: `${base}，且${year}年全年在东财分红表中也无任何分红方案，"不分红"判断属实。` };
    }
    case 'dividend_yield': {
      return { claim: claim.raw, status: 'partially_verified', evidence: '股息率判断需结合分红方案和当前股价验证。' };
    }
    case 'margin': {
      // Verify net profit margin
      if (revenue > 0 && netProfit > 0) {
        const actualMargin = (netProfit / revenue * 100);
        const diff = Math.abs(actualMargin - claim.value);
        if (diff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%接近，验证通过。` };
        } else if (diff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%有一定偏差。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%偏差较大。` };
        }
      }
      return { claim: claim.raw, status: 'unverified', evidence: '利润数据不足' };
    }
    case 'expected_return': {
      return { claim: claim.raw, status: 'partially_verified', evidence: '预期收益判断属于预测性观点，无法直接验证。建议持续跟踪。' };
    }
    default: {
      return { claim: claim.raw, status: 'partially_verified', evidence: '定性判断需要结合多维度数据综合评估。建议持续跟踪验证。' };
    }
  }
}

// Analyze claim types for probability adjustment
function analyzeClaimTypes(claims, noteType) {
  let bonus = 0;
  
  // Quantitative claims are more verifiable
  const quantitative = claims.filter(c => c.type !== 'qualitative').length;
  if (quantitative >= 3) bonus += 5;
  if (quantitative >= 5) bonus += 5;
  
  // Strategy-type notes are harder to verify
  if (noteType === 'strategy') bonus -= 5;
  if (noteType === 'observation') bonus += 3;
  
  return bonus;
}

// Generate verification result text
function generateVerificationText(status, probability, results, claims) {
  const parts = [];
  
  if (status === 'verified') {
    parts.push(`✅ 验证结果：你的投资经验/心得有较高可信度（正确概率${probability}%）。`);
  } else if (status === 'partially_verified') {
    parts.push(`⚠️ 验证结果：你的投资经验/心得部分得到验证（正确概率${probability}%）。部分判断与实际数据吻合，但仍有需要持续观察的方面。`);
  } else {
    parts.push(`❌ 验证结果：你的投资经验/心得暂未得到数据支持（正确概率${probability}%）。建议谨慎参考，并持续跟踪验证。`);
  }
  
  if (results.length > 0) {
    parts.push('\n具体验证详情：');
    for (const r of results) {
      const icon = r.status === 'verified' ? '✅' : r.status === 'partially_verified' ? '⚠️' : '❌';
      parts.push(`${icon} ${r.evidence}`);
    }
  }
  
  parts.push(`\n📊 共分析了${claims.length}个判断点。`);
  parts.push('💡 提示：投资经验验证基于历史财务数据，不构成投资建议。市场环境变化可能影响经验的有效性。');
  
  return parts.join('\n');
}

// ---- 期货关联走势分析 API ----
app.get('/api/futures-correlation/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const meta = getFuturesMeta(symbol);
    if (!meta) {
      return res.json({ hasFutures: false });
    }
    const result = await fetchFuturesCorrelation(symbol, name);
    res.json(result);
  } catch (err) {
    console.error('Futures correlation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 行业分析 API ----
app.get('/api/industry-analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';

    // 总超时兜底：避免任何外部接口无响应时前端永久转圈
    const result = await Promise.race([
      industryAnalysis(symbol, name),
      new Promise((_, reject) => setTimeout(() => reject(new Error('行业分析超时（外部数据接口响应过慢，请稍后重试）')), 40000)),
    ]);

    res.json(result);
  } catch (err) {
    console.error('Industry analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 资金量能分析 API ----
app.get('/api/capital-flow/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';

    const [quote, history] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, 'daily').catch(() => []),
    ]);

    if (!quote) {
      return res.status(404).json({ error: '无法获取股票行情数据' });
    }

    // 整体超时兜底：融资融券抓取已内部降级（最坏 ~8s），此处为最后防线，
    // 一旦超时直接返回错误，避免前端无限 loading。
    const OVERALL_TIMEOUT_MS = 15000;
    const result = await Promise.race([
      analyzeCapitalFlow(symbol, name || quote.name, quote, history),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`资金量能分析超时（>${OVERALL_TIMEOUT_MS / 1000}s）`)), OVERALL_TIMEOUT_MS)),
    ]);
    res.json(result);
  } catch (err) {
    console.error('Capital flow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 文档资料库 API ----



// 20260906 路由拆分：资料库（docs）11 条路由 + 上传辅助移至 routes/docsRoutes.js
app.use(docsRoutes);

// 将 data/reports 下已下载的年报/半年报登记进本地资料库（按 relativePath 去重）
// 20260821f：统一委托 lib/reportSync 实现（含 semi 半年报分类），避免双份逻辑漂移
function registerDownloadedReports() {
  return reportSync.registerDownloadedReports();
}

app.post('/api/reports/download', async (req, res) => {
  try {
    const { codes, years = 5, types = ['annual', 'semi'], channel = 'cninfo' } = req.body || {};
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: '请提供至少一个股票代码' });
    }
    // 通道校验：仅允许已知通道，未知则回退巨潮
    const allowedChannels = ['cninfo', 'eastmoney', 'all'];
    const safeChannel = allowedChannels.includes(channel) ? channel : 'cninfo';
    const py = findPython();
    if (!py) {
      return res.status(500).json({ error: '未找到 Python 解释器，请安装 Python 3 或设置环境变量 PYTHON_BIN 指向 python 可执行文件。' });
    }
    const script = path.join(__dirname, 'scripts', 'download_reports.py');
    if (!fs.existsSync(script)) {
      return res.status(500).json({ error: '下载脚本不存在: ' + script });
    }
    const outDir = path.join(__dirname, 'data', 'reports');
    const args = [
      script,
      '--codes', codes.join(','),
      '--years', String(years),
      '--types', types.join(','),
      '--out', outDir,
      '--channel', safeChannel,
      '--json',
    ];
    console.log(`[Reports] Running: ${py} ${args.join(' ')}`);
    const child = cp.spawn(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      console.error('[Reports] spawn error:', e.message);
      return res.status(500).json({ error: '启动下载脚本失败: ' + e.message });
    });
    child.on('close', (code) => {
      const m = stdout.match(/RESULT_JSON:(\{[\s\S]*\})/);
      if (m) {
        try {
          const summary = JSON.parse(m[1]);
          // 下载完成后，将新文件登记进本地资料库，便于在「资料库」中浏览
          try {
            registerDownloadedReports();
          } catch (regErr) {
            console.error('[Reports] register error:', regErr.message);
          }
          return res.json({ ok: true, summary, log: stderr });
        } catch (e) {
          // 解析失败，回退
        }
      }
      console.error('[Reports] exited code', code, 'stderr:', stderr.slice(0, 500));
      return res.json({ ok: false, code, stdout, stderr });
    });
  } catch (e) {
    console.error('[Reports] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 诊断：探测巨潮接口对指定股票代码、各参数组合能否返回公告（不下载）
app.get('/api/reports/probe', async (req, res) => {
  try {
    const raw = String(req.query.codes || '');
    const codes = raw.split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
    if (codes.length === 0) {
      return res.status(400).json({ error: '请提供股票代码，例如 ?codes=600938' });
    }
    const py = findPython();
    if (!py) {
      return res.status(500).json({ error: '未找到 Python 解释器，请安装 Python 3 或设置环境变量 PYTHON_BIN。' });
    }
    const script = path.join(__dirname, 'scripts', 'download_reports.py');
    if (!fs.existsSync(script)) {
      return res.status(500).json({ error: '下载脚本不存在: ' + script });
    }
    const args = [script, '--codes', codes.join(','), '--years', '5', '--types', 'annual,semi', '--probe'];
    console.log(`[Reports] Probe: ${py} ${args.join(' ')}`);
    const child = cp.spawn(py, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => {
      console.error('[Reports] probe spawn error:', e.message);
      return res.status(500).json({ error: '启动诊断脚本失败: ' + e.message });
    });
    child.on('close', () => {
      const m = stdout.match(/PROBE_JSON:(\[.*\])/);
      let combos = null;
      if (m) {
        try { combos = JSON.parse(m[1]); } catch (e) { combos = null; }
      }
      const lines = stdout.split('\n').map(l => l.trim()).filter(l =>
        l.includes('totalRecordNum') || l.includes('请求失败') || l.includes('参数组合探测'));
      res.json({ ok: true, python: py, combos, lines, stderr: stderr.slice(0, 500) });
    });
  } catch (e) {
    console.error('[Reports] probe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器：端口被占用时自动顺延，并记录实际端口并自动打开浏览器
function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'linux'
      ? `xdg-open "${url}"`
      : `cmd /c start "" "${url}"`;
  cp.exec(cmd, (err) => {
    if (err) console.log(`（自动打开浏览器失败，请手动在浏览器访问 ${url}）`);
  });
}

// 每日 15:30 盘后结算短期判断准确率（工作日；服务运行期间每分钟检查一次，
// 到了 15:30 且当天尚未结算则触发全量结算）。服务未常驻时，启动时的 settleAll() 兜底。
// 结算后自动执行「自学习复核」：归因不准确因子 + 自动复核新闻影响 + 自动更正权重。
let _lastSettleDate = null;
let _lastPreOpenSlot = '';
let _preOpenRunning = false;
// 20260917：大盘技术分析「当日判断」每日落盘守卫（避免同一天重复计算）
let _lastMarketTechRecord = '';
// 20260917d：大盘量能情绪模型「当日判断」每日落盘守卫
let _lastMarketEmotionRecord = '';

// 自学习自动复核：结算判断 → 归因不准确部分 → 自动复核新闻影响 → 自动更正权重。
// 全部在后台自动运行，无需人工干预。
async function runAutoReview() {
  // 0) 全市场情绪指数：盘后落当日快照 + 自适应学习（极值日打标→调 extremeZ）
  let msiNote = null;
  try {
    const snap = await MSI.recordDailySnapshot();
    if (snap) {
      // 拉上证历史用于学习校准（best-effort）
      const shHist = await (require('./lib/stockData').getHistory('sh000001', '1y')).catch(() => []);
      const { full } = await MSI.getSeries({ allowBackfill: true });
      const learn = await labelAndLearn(full, shHist);
      msiNote = `情绪指数 ${snap.index} 已存档；学习样本 ${learn.total} 命中 ${learn.correct}（阈值 ${learn.extremeZ}）`;
    }
  } catch (e) {
    msiNote = '情绪指数快照失败: ' + e.message;
    console.error('  [结算] 情绪指数快照失败:', e.message);
  }
  // 1) 结算全部未结算判断（含因子级命中归因 + 自适应权重重建）
  const acc = await settleAll();
  // 2) 新闻影响自动复核：用当日板块实际涨跌对照方向，自动标记对错
  let impactReview = null;
  try {
    const mo = await getMarketOverview();
    const chgMap = {};
    for (const s of [...(mo.sectorsUp || []), ...(mo.sectorsDown || [])]) {
      if (s && s.name != null && typeof s.changePct === 'number') chgMap[s.name] = s.changePct;
    }
    impactReview = autoReviewImpacts(chgMap);
    // 盘后落当日行业拥挤度（20260909n：交易日感知，节假日不落盘）
    if (Array.isArray(mo.sectorAll) && (await _canRecordToday(mo.sectorAll))) recordSectorCrowding(mo.sectorAll, mo.sectorDate);
    // 盘后自动回填近 21 个交易日历史，确保本周/本月统计每日收盘后自动更新
    try {
      const bf = await backfillSectorCrowding(21, findPython());
      console.log('  [SectorCrowding] 盘后历史回填:', JSON.stringify(bf));
    } catch (bfErr) {
      console.error('  [SectorCrowding] 盘后历史回填失败:', bfErr.message);
    }
  } catch (e) {
    console.error('  [自动复核] 新闻影响复核失败:', e.message);
  }
  // 3) 学习状态（因子命中率 / 错误归因 / 权重演进）
  const learning = getLearningState();
  // 4) cn-financial-scraper 后台增强复核：对最近误判个股拉取「定期报告解读 + 全网舆情」，
  //    为学习层补充基本面/舆情上下文（best-effort，失败不阻断结算）
  const cnscraper = await enrichAutoReviewWithCnscraper(learning).catch(e => {
    console.error('  [自动复核] cn-financial-scraper 增强复核失败:', e.message);
    return { reviewed: 0, note: '增强复核失败: ' + e.message };
  });
  // 5) 个股近期热点已改为「打开个股页时 AI 联网按涨跌幅自动分析、按交易日缓存」，无需盘后快照。
  // 6) 20260914i：两个技术分析模块的准确率结算（大盘技术分析 + 个股技术面），
  //    独立于个股短期判断的 settleAll，互不干扰；失败不阻断主流程。
  let techAcc = null;
  try {
    const mtSettle = await marketTechJudgment.settleAll();
    const tfSettle = await techFaceJudgment.settleAll();
    // 20260914i：市场情绪提醒也纳入准确率结算
    let sentSettle = null;
    try { sentSettle = await sentimentAccuracy.settleAll(); } catch (e2) { sentSettle = null; }
    techAcc = {
      marketTech: { changed: mtSettle.changed, shortRate: mtSettle.accuracy.short.accuracy, shortSettled: mtSettle.accuracy.short.settledCount, midRate: mtSettle.accuracy.mid.accuracy, midSettled: mtSettle.accuracy.mid.settledCount },
      techFace: { changed: tfSettle.changed },
      sentiment: sentSettle ? { changed: sentSettle.settled, rate: sentSettle.accuracy.accuracy, settled: sentSettle.accuracy.settledCount } : null,
    };
    console.log('  [结算·技术分析] 大盘技术分析 短期命中率 ' + (mtSettle.accuracy.short.accuracy == null ? '—' : mtSettle.accuracy.short.accuracy + '%') +
      `（已结算 ${mtSettle.accuracy.short.settledCount} 条）/ 中期 ${(mtSettle.accuracy.mid.accuracy == null ? '—' : mtSettle.accuracy.mid.accuracy + '%')}` +
      `（已结算 ${mtSettle.accuracy.mid.settledCount} 条）；个股技术面 新结算 ${tfSettle.changed} 条` +
      (sentSettle ? `；市场情绪提醒 新结算 ${sentSettle.settled} 条，命中率 ${sentSettle.accuracy.accuracy == null ? '—' : sentSettle.accuracy.accuracy + '%'}` : ''));
  } catch (e) {
    console.error('  [结算·技术分析] 失败:', e.message);
  }
  return { acc, impactReview, learning, cnscraper, msiNote, techAcc };
}

// cn-financial-scraper 后台增强复核：对最近误判个股拉取定期报告解读（东财财报规则引擎）
// 与全网舆情（60+ 源），把结构化结论落盘到 data/cnscraper_review.json，供学习层与复盘引用。
async function enrichAutoReviewWithCnscraper(learning) {
  const errs = (learning && learning.recentErrors) || [];
  if (!errs.length) return { reviewed: 0, note: '无最近误判个股，跳过增强复核' };
  // 去重取前 8 只误判个股，避免盘后复核耗时过长
  const seen = new Set();
  const targets = [];
  for (const e of errs) {
    const k = e.symbol;
    if (k && !seen.has(k)) { seen.add(k); targets.push(e); }
    if (targets.length >= 8) break;
  }
  const out = { reviewed: 0, reviewedAt: new Date().toISOString(), items: [] };
  for (const e of targets) {
    const [rep, sent] = await Promise.all([
      interpretReport(e.symbol).catch(() => ({ ok: false })),
      getGlobalSentiment(e.name || '', { days: 3, maxArticles: 10, budget: 10 }).catch(() => ({ ok: false, count: 0 })),
    ]);
    out.items.push({
      symbol: e.symbol, name: e.name, date: e.date, targetDate: e.targetDate,
      verdict: e.verdict, actualDir: e.actualDir, actualChgPct: e.actualChgPct,
      report: rep && rep.ok ? {
        ok: true, score: rep.score, rating: rep.rating,
        revenue_yoy: rep.revenue_yoy, profit_yoy: rep.profit_yoy,
        highlights: (rep.highlights || []).slice(0, 2),
        risks: (rep.risks || []).slice(0, 2),
      } : { ok: false },
      sentiment: sent && sent.ok ? {
        ok: true, count: sent.count, positive: sent.positive, negative: sent.negative,
        signal: sent.signal, avg_score: sent.avg_score,
      } : { ok: false },
    });
  }
  out.reviewed = out.items.length;
  try {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cnscraper_review.json'), JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('  [自动复核] 写入 cnscraper_review.json 失败:', e.message);
  }
  return { reviewed: out.reviewed, note: `对 ${out.reviewed} 只误判个股拉取财报解读+全网舆情` };
}

function logAutoReview(r) {
  const a = r.acc || {};
  console.log(`  [结算] 已结算 ${a.settledCount} 条，准确率 ${a.accuracy == null ? '—' : a.accuracy + '%'}，待结算 ${a.pendingCount} 条${a.overdueCount ? '（其中 ' + a.overdueCount + ' 条过期未结算）' : ''}`);
  if (r.impactReview && r.impactReview.reviewed > 0) {
    console.log(`  [自学习·新闻影响] 自动复核 ${r.impactReview.reviewed} 条：正确 ${r.impactReview.correctN} / 错误 ${r.impactReview.wrongN}，累计准确率 ${r.impactReview.accuracy == null ? '—' : r.impactReview.accuracy + '%'}`);
  }
  const errs = (r.learning && r.learning.recentErrors) || [];
  if (errs.length) {
    console.log(`  [自学习·归因] 最近 ${errs.length} 笔判断错误的误导因子已标记，权重已按命中率自动调整`);
  }
  if (r.cnscraper && r.cnscraper.reviewed > 0) {
    console.log(`  [自学习·cn-scraper] ${r.cnscraper.note}`);
  }
  if (r.msiNote) {
    console.log(`  [自学习·情绪指数] ${r.msiNote}`);
  }
}

// 20260909n：行业板块拥挤度·交易日感知 + 收盘补写守卫
// 背景：当日拥挤度此前依赖「15:30 定时结算恰好命中运行中的服务」，电脑/服务未开机或结算失败时，
//       当日数据会缺席到深夜（实测 2026-09-09 当日记录 23:00 才由历史回填补上）。
// 交易日判断：上证日 K 最新日期==今天 ⇒ 今天开过盘（节假日/盘前自动为 false）；true 缓存到当日结束，false 缓存 10 分钟。
let _tradeDayCache = { date: '', result: null, at: 0 };
// 20260910 修复：主通道改用 Node 原生 fetch 直连腾讯日 K（不走环境代理）。
// 教训：axios 会读 HTTP_PROXY 走系统代理，代理对腾讯/东财域名转发故障时（实测 09-10 502/断连）
// getHistory 全线失败 → 交易日判断失败 → 当日拥挤度被保守策略整体拦截。
// 原生 fetch（undici）不受 HTTP_PROXY 影响，直连实测 0.15s 稳定。
// 数据新鲜度指纹（20260910）：判断通道全部故障时用它兜底——
// 交易日 15:30 后的板块成交额是新值；节假日/休市时数据源返回的是上一交易日的冻结值（与 store 最新一天完全一致）。
// 因此「合计>0 且与最新一天不等」⇒ 判定为新交易日的活跃数据，允许落盘；冻结/为零 ⇒ 拒收。
function _looksFresh(sectorAll) {
  if (!Array.isArray(sectorAll) || !sectorAll.length) return false;
  const total = sectorAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (total <= 0) return false;                       // 数据源清零/无成交 ⇒ 拒收
  const prev = sectorCrowdingLatestTotal();
  if (prev == null) return true;
  return Math.abs(total - prev) > Math.max(1, Math.abs(prev) * 1e-6);
}
// 是否允许落盘当日：true=确认交易日；false=确认非交易日；null=判断通道故障→退回新鲜度指纹
async function _canRecordToday(sectorAll) {
  const tday = await isTradingDayToday();
  if (tday === true) return true;
  if (tday === false) return false;
  return _looksFresh(sectorAll);
}

async function _lastTradeDateViaFetch() {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const days = j && j.data && j.data.sh000001 && j.data.sh000001.day;
  if (!Array.isArray(days) || !days.length) throw new Error('腾讯日K返回空 day 数组');
  return String(days[days.length - 1][0]);
}
// 返回值：true=今天是交易日 / false=确认非交易日 / null=判断失败（两条通道都不可用）
// 三态语义：判断失败不再等同于「非交易日」——20260910 教训（代理+直连双故障时，
// 判断失败被当成非交易日，导致守卫连尝试补写的机会都没有）。
async function isTradingDayToday() {
  const now = new Date();
  const today = localDate(now);
  if (_tradeDayCache.date === today && _tradeDayCache.result === true) return true;
  if (_tradeDayCache.date === today && _tradeDayCache.result === false && now - _tradeDayCache.at < 10 * 60 * 1000) return false;
  try {
    let lastDate = null;
    try {
      lastDate = await _lastTradeDateViaFetch();            // ① 原生直连主通道
    } catch (e1) {
      const hist = await (require('./lib/stockData').getHistory('sh000001', '1mo')); // ② axios 兜底
      const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
      lastDate = last ? String(last.date) : null;
    }
    if (!lastDate) throw new Error('两条通道均未返回有效交易日期');
    const result = lastDate === today;
    _tradeDayCache = { date: today, result, at: Date.now() };
    return result;
  } catch (e) {
    console.error('  [SectorCrowding] 交易日判断失败（将改用回填接口探测）:', e.message);
    return null; // 判断失败≠非交易日；由调用方决定是否探测（守卫视作可尝试，写入口仍保守不写）
  }
}

// 收盘补写守卫：交易日 15:30 后，凡当日记录缺失 → 立即用实时收盘数据补写（失败再回填兜底）。
// 触发点：启动后 30 秒（覆盖「白天未开机、晚间才启动」）+ 每分钟调度检查（覆盖「15:30 结算失败」）。
let _crowdingGuardMinute = '';
async function ensureSectorCrowdingToday(reason) {
  try {
    const now = new Date();
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return;
    const hh = now.getHours(), mm = now.getMinutes();
    if (hh < 15 || (hh === 15 && mm < 30)) return;
    const today = localDate(now);
    if (sectorCrowdingHasDate(today)) return;          // 本地文件查询，每分钟一次零压力
    const tday = await isTradingDayToday();
    // false=确认非交易日（周末/节假日）→ 不落盘；null=判断失败 → 仍尝试回填探测：
    // 同花顺历史接口只有交易日才会产生当日行，节假日天然无数据，不会污染周/月统计
    if (tday === false) return;
    const minuteKey = `${today} ${hh}:${mm}`;
    if (_crowdingGuardMinute === minuteKey) return;    // 同一分钟防抖
    _crowdingGuardMinute = minuteKey;
    console.log(`  [SectorCrowding] 收盘补写守卫触发（${reason}，${today} 当日记录缺失）...`);
    const mo = await getMarketOverview();
    // true=确认交易日直接写；null=判断通道故障 → 用新鲜度指纹判定（防节假日冻结数据误标为今天）
    if (tday === true || _looksFresh(mo.sectorAll)) {
      if (Array.isArray(mo.sectorAll)) recordSectorCrowding(mo.sectorAll, mo.sectorDate);
    }
    if (sectorCrowdingHasDate(today)) {
      console.log('  [SectorCrowding] 当日数据已补写 ✓');
      return;
    }
    const bf = await backfillSectorCrowding(21, findPython());
    console.log('  [SectorCrowding] 收盘补写·历史回填兜底:', JSON.stringify(bf));
  } catch (e) {
    console.error('  [SectorCrowding] 收盘补写守卫失败:', e.message);
  }
}

function startDailySettlementScheduler() {
  setInterval(() => {
    const now = new Date();
    const dow = now.getDay();
    const isWeekend = (dow === 0 || dow === 6);
    const hh = now.getHours();
    const mm = now.getMinutes();

    // —— 15:30 盘后结算 + 自学习自动复核 ——
    if (!isWeekend && hh >= 15 && (hh > 15 || mm >= 30)) {
      const today = localDate(now);
      if (_lastSettleDate !== today) {
        _lastSettleDate = today;
        console.log(`\n  [结算] 触发每日 15:30 盘后结算 + 自学习自动复核（${today}）...`);
        runAutoReview()
          .then(logAutoReview)
          .catch(e => console.error('  [结算] 每日定时结算失败:', e.message));
      }
      // —— 20260917：每交易日收盘后自动落盘「大盘技术分析」当日判断（不依赖用户打开页面）——
      // 修复：原实现只在「用户打开首页调用 /api/market-technical」时才落盘，若不打开该页就永远缺记录
      //（且 route 内 marketClosed 未导入 → 静默异常 → 长期无任何记录）。此处改为每日 15:30 后自动落盘一次。
      if (_lastMarketTechRecord !== today) {
        _lastMarketTechRecord = today;
        getMarketTechnical({ force: true })
          .then((mt) => {
            if (mt && mt.date === today) {
              const r = marketTechJudgment.recordDailyJudgment(mt);
              console.log(`  [大盘技术] 每日判断已落盘：${r ? r.baseDate : '跳过（数据不足）'}`);
            } else {
              console.log('  [大盘技术] 当日K线未更新（非交易日/数据延迟），跳过落盘');
            }
          })
          .catch((e) => console.error('  [大盘技术] 每日落盘失败:', e && e.message));
      }
      // —— 20260917d：每交易日收盘后自动落盘「大盘量能情绪模型」当日判断（不依赖用户打开页面）——
      if (_lastMarketEmotionRecord !== today) {
        _lastMarketEmotionRecord = today;
        buildHomeMarketEmotion(true)
          .then((emo) => console.log(`  [情绪模型] 每日判断已落盘：${emo.date} 情绪总分 ${emo.totalScore}（${emo.tendency}）`))
          .catch((e) => console.error('  [情绪模型] 每日落盘失败:', e && e.message));
      }
      // —— 15:30 收盘补写守卫：当日拥挤度记录缺失时自动补写（20260909n，幂等，记录已存在时秒回）——
      ensureSectorCrowdingToday('每分钟检查').catch(() => {});
    }

    // —— 盘前预重算（方案 C·Part B）：交易日 8:00–9:30，每 10 分钟一次，吸收隔夜美股与早间消息 ——
    if (!isWeekend && hh >= 8 && (hh < 9 || (hh === 9 && mm < 30))) {
      const slot = `${localDate(now)} ${hh}:${Math.floor(mm / 10)}`;
      if (slot !== _lastPreOpenSlot) {
        _lastPreOpenSlot = slot;
        if (!_preOpenRunning) {
          _preOpenRunning = true;
          preOpenRecomputeAll()
            .then(r => console.log(`  [盘前预重算] ${r.targetDate} 重建 ${r.count} 条，跳过 ${r.skipped} 条`))
            .catch(e => console.error('  [盘前预重算] 失败:', (e && e.message) || e))
            .finally(() => { _preOpenRunning = false; });
        }
      }
    }
  }, 60 * 1000);
}

// 20260907a：三联动·事件驱动定时扫描
// 在 9:00 / 12:30 / 15:30 / 21:00 触发一次新闻扫描，更新活跃事件库并作废受影响个股的短期判断缓存。
function startEventScheduler() {
  if (process.env.SA_NO_BG_AI === '1') {
    console.log('  [事件] 后台 AI 总开关(SA_NO_BG_AI=1)已启用，跳过事件定时扫描（不再自动调用 LLM，停止后台静默计费）');
    return;
  }
  let lastSlot = '';
  setInterval(() => {
    const now = new Date();
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return; // 周末不扫
    const hh = now.getHours();
    const mm = now.getMinutes();
    const slots = [['09', '00'], ['12', '30'], ['15', '30'], ['21', '00']];
    let hit = null;
    for (const [sh, sm] of slots) {
      if (hh === parseInt(sh, 10) && mm === parseInt(sm, 10)) { hit = `${sh}:${sm}`; break; }
    }
    if (!hit) return;
    const slotKey = `${localDate(now)} ${hit}`;
    if (slotKey === lastSlot) return;
    lastSlot = slotKey;
    eventEngineScanOnce()
      .then(r => console.log(`  [事件] 定时扫描完成：${r.activeCount} 活跃 / 变更 ${r.changedSymbols ? r.changedSymbols.length : 0} 股`))
      .catch(e => console.error('  [事件] 定时扫描失败:', e.message));
  }, 60 * 1000);
}

// 封装单次事件扫描（依赖 eventEngine，避免与结算调度耦合）
async function eventEngineScanOnce() {
  const eventEngine = require('./lib/eventEngine');
  const sameDay = require('./lib/sameDayJudgment');
  const result = await eventEngine.scanEvents(false);
  for (const s of (result.changedSymbols || [])) {
    try { sameDay.invalidateJudgmentForSymbol(s); } catch (e) {}
  }
  return result;
}

// 20260911：专属因子月度定时触发（与事件扫描同机制）
// 每小时检查一次；仅在国家统计局 CPI 发布窗口(8~13日)内、且当月未尝试、且配置了 AI Key 时，
// 触发联网检索最新一期 CPI 并落库；窗口外 / 当月已尝试 / 无 Key → 静默跳过，不影响启动与运行。
function startDedicatedFactorScheduler() {
  if (process.env.SA_NO_BG_AI === '1') {
    console.log('  [专属因子] 后台 AI 总开关(SA_NO_BG_AI=1)已启用，跳过专属因子月度定时触发（不再自动调用 LLM，停止后台静默计费）');
    return;
  }
  setInterval(() => {
    const now = new Date();
    const dom = now.getDate();
    if (dom < 8 || dom > 13) return; // 窗口外静默
    let df, sameDay;
    try { df = require('./lib/dedicatedFactor'); sameDay = require('./lib/sameDayJudgment'); } catch (e) { return; }
    df.triggerDedicatedFactors({ force: false })
      .then(r => {
        if (r && r.triggered && r.triggered.length) {
          for (const s of (r.changedSymbols || [])) { try { sameDay.invalidateJudgmentForSymbol(s); } catch (e) {} }
          console.log(`  [专属因子] 月度触发完成：新增 ${r.triggered.length} 个实例（${r.period}）`);
        }
      })
      .catch(e => console.error('  [专属因子] 定时触发失败:', e && e.message));
  }, 60 * 60 * 1000); // 每小时检查
}

function startServer(port, retries = 5) {
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    // 由启动器(start.vbs)负责打开浏览器时，这里必须跳过，否则会打开两个相同的网页窗口
    const launcherOpens = process.env.SA_NO_AUTO_OPEN === '1';
    console.log(`\n  Stock Analyzer 已启动： ${url}\n  ${launcherOpens ? '（浏览器由启动器打开，此处跳过以避免重复开窗）' : '正在打开浏览器...'}\n`);
    try {
      fs.writeFileSync(path.join(__dirname, 'data', '.server-port'), String(port));
    } catch (e) { /* 忽略端口记录失败 */ }
    if (!launcherOpens) openBrowser(url);
    // 启动时自动结算 + 自学习自动复核（含周末生成的 nextday 预测），确保过期未结算的预测被判对错、准确率真实
    runAutoReview()
      .then(logAutoReview)
      .catch(e => console.error('  [结算] 初始化失败:', e.message));
    // 每日 15:30 盘后定时结算 + 自学习自动复核
    startDailySettlementScheduler();
    // 启动后 30 秒：收盘补写守卫——覆盖「交易日 15:30 时电脑未开机、晚间才启动服务」场景（20260909n）
    setTimeout(() => {
      ensureSectorCrowdingToday('启动守卫').catch(e => console.error('  [SectorCrowding] 启动守卫失败:', e.message));
    }, 30000);
    // 启动后 10 秒：板块资金流向预热——提前填充缓存，用户打开首页即命中（20260909o 提速）
    setTimeout(() => {
      try { warmupSectorCapitalFlow(); } catch (e) { console.error('  [SectorCapitalFlow] 预热失败:', e.message); }
    }, 10000);
    // 20260912c：基金行业配置 · **自然季度**更新调度
    //   - 启动后 30 秒：若「今天还没检查过」就补跑一次（电脑关机/重启也能补齐，忽略每日时刻）
    //   - 之后每 30 分钟 tick 一次：到了每日检查时刻(DAILY_HOUR)且今天未跑过 → 跑一次
    //   每次检查：探测东财是否已开始披露当季报告 → 未发布则只花几次请求后结束；
    //   已发布则跑一批（受批次大小/时间预算约束），未全部更新完则次日继续，直到本季度完成。
    setTimeout(() => {
      try {
        fundMatrix.startCrawl({ ignoreHour: true })
          .then((r) => console.log(`  [FundMatrix] 季度检查(启动补偿)：${r.started ? '已启动批次' : '跳过(' + r.reason + ')'}`))
          .catch((e) => console.error('  [FundMatrix] 季度检查失败:', e.message));
      } catch (e) { console.error('  [FundMatrix] 季度检查异常:', e.message); }
    }, 30000);
    setInterval(() => {
      try {
        fundMatrix.startCrawl({})
          .then((r) => { if (r.started) console.log(`  [FundMatrix] 每日检查：启动（${r.reason}）`); })
          .catch((e) => console.error('  [FundMatrix] 每日检查失败:', e.message));
      } catch (e) { console.error('  [FundMatrix] 每日检查异常:', e.message); }
    }, 30 * 60 * 1000);
    // 进程退出前把采集进度强制落盘（把「断点」推到最后一刻，最多丢一次落盘间隔）
    // 覆盖：Ctrl+C / 关闭终端 / 任务管理器结束任务（能捕获到的退出信号）。
    // 注意：Windows 关机不一定会派发这些信号，那种情况下最多丢 60 秒进度。
    (function registerFlushOnExit() {
      let flushed = false;
      const flush = (why) => {
        if (flushed) return; flushed = true;
        try {
          const r = fundMatrix.flushCache();
          console.log(`  [FundMatrix] ${why} 退出前落盘：基金 ${r.funds} 只 / 行业 ${r.industry} 条`
            + (r.ok ? '' : '（失败：' + r.error + '）'));
        } catch (e) { /* 忽略 */ }
      };
      ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((sig) => {
        try { process.on(sig, () => { flush(sig); process.exit(0); }); } catch (e) { /* 平台不支持则忽略 */ }
      });
      process.on('beforeExit', () => flush('beforeExit'));
    })();
    // 20260907a：三联动·事件驱动定时扫描（9:00 / 12:30 / 15:30 / 21:00）
    startEventScheduler();
    // 20260911：专属因子月度定时触发（CPI 发布窗口内自动检索并落库）
    startDedicatedFactorScheduler();
    // 启动后做一次静默首扫（网络受限时返回空，不影响启动）
    eventEngineScanOnce().catch(e => console.error('  [事件] 首扫失败:', e.message));
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (retries > 0) {
        console.log(`端口 ${port} 被占用，0.5s 后重试（剩余 ${retries} 次）...`);
        setTimeout(() => startServer(port, retries - 1), 500);
      } else if (port < PORT + 10) {
        console.log(`端口 ${port} 已被占用，尝试 ${port + 1} ...`);
        startServer(port + 1);
      } else {
        console.error('服务器启动失败:', err.message);
        process.exit(1);
      }
    } else {
      console.error('服务器启动失败:', err.message);
      process.exit(1);
    }
  });
}

// 启动前初始化本地 SQLite 数据层（建库 + 建表）。失败仅记录，不影响主服务启动。
try {
  db.initDb();
} catch (e) {
  console.error('[DB] 初始化失败，数据持久化功能暂不可用：', e.message);
}

startServer(PORT);
