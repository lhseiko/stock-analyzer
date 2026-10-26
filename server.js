/**
 * Stock Analyzer Server
 * Express server providing REST API and static file serving
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { getQuote, getHistory, getHistoryPeriod, getHistoryDeep, searchStocks, detectMarket, getMarketOverview, fetchTencentMinutes } = require('./lib/stockData');
const { technicalAnalysis, fundamentalAnalysis, evaluateSignals, aggregateSentiment, buildFundamentalComparison } = require('./lib/analysis');
const { buildMetricAnalysis } = require('./lib/metricAnalysis');
const { analyzePriceAction } = require('./lib/priceAction');
const { getPriceActionSnapshot, invalidateSnapshot } = require('./lib/priceActionHub');   // 20261021e：手动区间增删后丢弃快照缓存
const manualZones = require('./lib/manualZones');   // 20261021d 用户手动阻力/支撑区间（②卡「手动添加」页签）
const { getNews, getHotNews } = require('./lib/newsSearch');
const { getMacroNews } = require('./lib/macroNews');
const { getMacroIndicators } = require('./lib/macroData');
const { getCninfoAnnouncements } = require('./lib/cninfoAnnouncements');
const { getUsMacroEvents, refreshUsMacroEvents } = require('./lib/usMacroEvents');
const { getMarketRank } = require('./lib/marketRank');
const { getIndexPETrend } = require('./lib/indexPETrend');
const { getMarketTechnical } = require('./lib/marketTechnical'); // 首页·大盘技术分析（三大指数七步推演·融合版 20260914e）
// 20260914i：两个技术分析模块的「准确率检查」——独立落盘 + 事后结算（不污染个股 judgements 统计）
const marketTechJudgment = require('./lib/marketTechJudgment');
const techFaceJudgment = require('./lib/techFaceJudgment');
const { deepAnalysis, getLocalDocuments, loadDividendSeries, persistDividends, fetchDividends, normalizeSymbol } = require('./lib/deepAnalysis');
const { analyzeCapitalFlow } = require('./lib/capitalFlow');
const { classifyCompanyType } = require('./lib/companyType');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./lib/futuresData');
const { industryAnalysis } = require('./lib/industryAnalysis');
const { getShareholdersData, getCompanyProfile } = require('./lib/shareholderData');
const { getJudgmentWithAccuracy, settleAll, settleSymbol, getAllRecords, filterBySymbol, computeAccuracy, getLearningState, preOpenRecomputeAll, ensureAllTrackedJudgments, localDate, marketClosed, isTradingDay } = require('./lib/sameDayJudgment');
const { getMarketSentiment } = require('./lib/sentiment');
const { getSectorTrend } = require('./lib/sectorTrend');
const { getSectorLimitStats } = require('./lib/sectorLimitStats');
const { getLongTermJudgment } = require('./lib/longTermJudgment');
// Part B：弱关联关联度 / 持续性经验库（调试透明用）
const { getState: getRelevanceLearningState } = require('./lib/relevanceLearning');
const { annotateNewsImpact, NEWS_SECTOR_MAP } = require('./lib/newsSectorImpact');
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
// 20260917d：首页「市场情绪提醒」卡片升级为「大盘量能情绪分析模型」（20261015k 起 9 因子 · 确定性计算 · 自学习）
const marketEmotionModel = require('./lib/marketEmotionModel');
const { getMarketEmotionData } = require('./lib/marketEmotionData');
const etfFlow = require('./lib/etfFlow');
const { computeMacroFactors } = require('./lib/macroSentimentFactors');
// 本地 SQLite 数据层（node:sqlite，零额外依赖）：分红时序 / 标量五要素 / 分析快照，支撑三规则落地
const db = require('./lib/db');
// 20260926a：个股量化策略虚拟盘风控校验模块（纯 JS：DSL 解析 + 虚拟回测 + 统计检验 + 胜率修正）
const { validateStrategy } = require('./lib/backtestValidator');
// 20260926d：自动策略生成器新增「行情判定」派生策略（长期/短期/长短共振，复用 priceAction 技术内核把判定回算成历史买卖信号再回测胜率）；前端绑定当前个股，无需输入代码
const { generateStrategies } = require('./lib/strategyGenerator');
// 20260903f 降费：本地事实库（研报/公告/概况/主营预下载，供不联网模型做纯推理）
const factStore = require('./lib/factStore');
// 20260906 路由拆分（第一阶段）：AI/妙想/行业指数 + 资料库路由移至 routes/，server.js 瘦身
const aiRoutes = require('./routes/aiRoutes');
const docsRoutes = require('./routes/docsRoutes');
const eventRoutes = require('./routes/eventRoutes'); // 20260907a：三联动·事件驱动权重引擎
const dedicatedFactorRoutes = require('./routes/dedicatedFactor'); // 20260911：专属因子路由
const moduleSyncRoutes = require('./routes/moduleSyncRoutes'); // 20261024h：模块联动应答机制观测/触发
const moduleSync = require('./lib/moduleSync'); // 20261024h：源模块变动 → 自动通知联动模块失效
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
// [20261020m] 阻力/支撑区间**侵蚀规则**（用户原话）：无放量侵入区间内部但未打穿 → 近端收紧到该收盘价、远端不变；单调取极值（阻力取区间内最高合规收盘、支撑取最低），量能缺失/放量/打穿远端/单点脏数据一律不侵蚀。lib/zoneValidity.js 新增 erodeZone/erodeZones；lib/priceAction.js 在 assessZones 之后依次调用（先判有效性再收缩几何，侵蚀不回灌计数），短期判断新增 zoneErosion 汇总；②卡区间行右侧加「已收紧」标记，title 给「原区间 → 收紧后 + 触发日/量比」。
// [20261021a] 首页「实时大盘」→ 🇺🇸 美国指数行末尾新增「美债10年期收益率」卡（用户 2026-10-21 要求）。新增 `lib/usTreasury.js`：数据源为**美国财政部官方日度国债收益率曲线**（home.treasury.gov CSV，10 Yr 列），备源美联储 FRED DGS10；本机实测东财 push2/push2delay/datacenter、CNBC、Yahoo ^TNX、TradingView、华尔街见闻 market API 全部不可达或已下线，腾讯 qt / 新浪 hq 也不提供美债收益率代码，故只能取日线并如实标注。卡片口径与三个美股指数区分：主值 `5.15%`（收益率，不是点位）、变动 `+6.0bp`（基点，不是涨跌幅）、右上角「日线·MM-DD」标签 + tooltip 写截至日与来源；行来源标签改为 `usSource`＝「腾讯行情 + 美国财政部（日线）」，不许把日线数据挂在「腾讯行情」名下；过期守门：>10 天不展示、>3 天打 ⚠（周末/美国假日）；全部源失败返回 null 不追加卡片（绝不伪造）。
// [20261021b] 美债卡「链接该指数」（用户 2026-10-21 截图要求）：整卡改为 `<a>`，点击新标签打开东方财富「美国10年期国债收益率(US10Y)」行情页 `https://quote.eastmoney.com/unify/r/171.US10Y`（secid 由东财 suggest 接口实查：QuoteID=171.US10Y，market 171=全球债券；页面 title 实测为该指数）。`lib/usTreasury.js` 条目新增 `linkUrl/linkLabel`（URL 由数据侧下发，前端不硬编码）；前端 yield 分支用 `<a target=_blank rel=noopener noreferrer>` + `↗` 角标，缺 linkUrl 时降级为不可点 div；CSS 补齐 `a.mo-tile-link` 去下划线/继承色（否则整卡文字变蓝）。注意：该页是东财 push2 盘中实时报价，与本卡「美国财政部日度收益率」属两套口径，tooltip 已如实声明「数值可能不一致」，不假装同源。
// [20261021c] 修「老是出现无法结算准确率」（用户 2026-10-21 报障，大盘技术分析卡「过期未结算 2」）。根因两层：① **存储的 targetDate 落在法定节假日**——旧口径的 nextTradingDay 只跳周末，把 2026-09-24 的次日写成中秋 09-25、09-30 的次日写成国庆 10-01；结算时 `bars.find(x=>x.date===targetDate)` 永远找不到该日 → return 不结算，且永久计入 overdueCount。修法：结算侧**不采信存储值**，`isTradingDay(rec.targetDate)` 不成立就按 `nextTradingDay(baseDate)` 重算并就地纠正（留 targetDateFixed）；目标日无 K 线时取其后首个交易日兜底，但仅限 ≤5 自然日（TARGET_FALLBACK_MAX_DAYS），超出则拒绝结算并写 settleError，绝不改口径。② **准确率条只读不算**——`/api/market-tech/records` 原来只有 `?settle=1` 才结算，用户不点就一直是「待验证」；改为读取即 `settleIfDue()`（3 分钟节流）。③ 顺带：settleAll 整批只拉一次指数日K（原来每条记录各拉一次，19 条=19 次请求）；sameDayJudgment 的 nextday 结算同样加固（非交易日目标日不采信，但不改写 rec.targetDate，避免文件语义键错位）。实测自愈：09-24→09-28（-1.67%，命中）、09-30→10-08（-0.79%，命中），过期未结算 2→0。
// [20261021d] ②「短期动向预判」卡新增页签「手动添加」（用户 2026-10-21 要求「自行手动添加上方阻力区间和下方支撑区间」）。新增 `lib/manualZones.js`（服务端落盘 data/manual-zones/<6位代码>.json，换设备/清缓存不丢）+ 三条路由 GET/POST/DELETE `/api/manual-zones/:symbol`。**隔离铁律**：手动区间不进 zoneValidity 有效性检验、不进侵蚀收缩、不参与方向/概率/④卡反转边界/任何准确率统计——前端在 `validOnly(模型摆动点).concat(箱体条目, 手动条目)` 里只作追加项，进 validOnly 就会被模型判「无效」隐藏，等于用户标注被模型否决。②卡顶部两项页签（模型判定/手动添加 + 条数徽标），手动页签含口径说明、方向/价位/上沿/备注表单（只填一个价=单点）、已添加清单与删除；手动条目在模型清单里同屏并列并带蓝紫虚线左边框 + 「手动」小标。校验：方向/价格/下沿≤上沿/同侧去重/每侧 20 条上限/备注 40 字；文件损坏按空处理不崩不编造。测试 scripts/test_manual_zones.js 55 项。
// [20261021e] 手动阻力/支撑区间**同样接受本模块的两条有效性检验**（用户 2026-10-21 要求，覆盖 20261021d 初期「手动区间免疫检验」的做法）。实现：`lib/priceActionHub.js` 新增 `attachManualZones(data, daily, symbol)`，用 `zoneValidity.assessZone`（同一函数/同一份日K/同一 60 日窗口/同一阈值）给每条手动区间打 `valid/invalidReasons/zoneCheck`，append 进 `shortTerm.resistances/supports`（带 `isManual/manualId`），并出 `manualZonesMeta` 汇总；**不参与侵蚀**（`erodeZone` 不作用于手动区间——用户只点名两条检验），**不参与方向/概率/④卡/准确率**（那些在 attach 之前就已算完）。配套：路由在手动区间增删后调用 `invalidateSnapshot(symbol)` 丢弃该股快照（否则非盘中 24h 缓存会让用户加完看不到）；前端删除自建 concat（改由后端并入，避免重复两条），并在「手动添加」页签给每条打「通过检验 / 检验未通过（原因）」徽标。实测 000902 手动支撑 12.82~13.08：往返 4 次 > 3 → 判无效并给出原因。测试 scripts/test_manual_zones.js 74 项。
// [20261021g] 两件事：① 修「量能状态=平量，风险提示却写『量价背离（放量下跌或量价齐跌）』」（用户 2026-10-21 报障）——根因是两个不同窗口的口径被写成一句固定文案：量能状态用**当日**量比，量价形态用**近5日价格 x 近3日量能**，旧文案把「放量下跌」「量价齐跌」并列，于是当日平量也会被提示放量下跌。改法：calcPriceVolume 增 kind 枚举，风险提示改由 pvRiskText(vp) 按形态查表（PV_RISK_TEXT，每条都写明近3日/近5日窗口）；volumeText 后半改用形态原文，不再压成「配合/背离」。② 修「上证日线整段 501 → 量能因子全线降级」：新增 lib/tklineHost.js（ifzq → web.ifzq 主机族降级），接入 5 个 fqkline 调用点（stockData x2 / marketTechnical / marketTechJudgment / deep-yield / server 探活）。实测修后：量比 0.82（平量）+ 量价齐跌（资金退潮），风险提示「近5日量价齐跌（价格下行 + 量能萎缩），资金退潮」，两者不再打架。测试：scripts/test_market_emotion_volume_text.js 33 项 + scripts/test_tkline_host.js 28 项。
// [20261021h] 修「成交量单位错乱」——用户截图报障「60 日均量 113900 ×1.5 = 170850（当日量 7358800）却判未达阈值」。根因：`_reconcileTodayBar` 把「非腾讯通道的日K bar」当成「股」，而**东财日K实测是「手」**（成交额反验：73588×13.87×100=1.02亿=实时成交额），于是实时 quote（股）被原样写进手序列 → 当日量 ×100，与 avg60 差 64 倍，文案自相矛盾。全台排查发现同类错误共 3 处：① 上述覆写（×100）；② volumeEngine 口诀1 开盘量比 `tencent ? 1 : 100`（东财基准被缩 100 倍 → 量比虚高 100 倍）；③ capitalFlow `VOLUME_TO_LOT.eastmoney = 100`（绝对量小 100 倍）。修复：新增 `lib/volUnit.js` 作为日K成交量单位的**唯一来源**（东财 kline f56=手、腾讯归一后=手、同花顺=股、quote=股），三处全部改用它；并在覆写前加「量级守卫」——换算后与当日 bar 相差 >20 倍即判单位异常、**拒绝覆写**、写 `unit_mismatch` 进 dataGaps（序列永不被污染）；文案补「当日量为阈值的 X 倍」，不再只凭档位断言未达。实测 000902：当日量 73588 / 阈值 170850 / 0.43 倍 → 文案与数字一致。测试 scripts/test_volume_unit_contract.js 28 项；另更新 test_volume_engine（295→绿）与 test_volume_consistency（229→绿）里三条「把错误当预期」的旧断言。
// [20261021i] 修「股份回购」子卡片两处口径错误（用户 2026-10-21 截图 000902 新洋丰）：① **陈旧方案当当前状态**——最新一档是 2021-07-23 完成实施（5 年前），卡片却照四要素展示，用户自然认为「它现在没有回购」。修法：`lib/buybackEmDc.js` 增 `HISTORICAL_DAYS=730` 历史闸门（完成/停止/否决 且完结超 2 年 → `historical=true`），sameDayJudgment 把主语改为「当前无进行中的回购（最近一次 2021-07-23 完成实施，已完结 5 年）」，旧方案降为脚注、子卡名标「（历史）」。② **进度自相矛盾**——卡片同时写「完成实施」与「已达承诺上限 24%」，理由却说「承诺买入力量已用尽」；1.44 亿 / 承诺 3~6 亿，钱没花完。修法：`gradeSignal('006')` 按完成率区分——<95% 时 stage=「已结束（未足额）」、理由改「方案已结束但只回购到承诺上限 24%，未足额买完，剩余额度不再兑现」；≥95% 才说「已用尽」。`formatPlan` 同步把「完成实施（已达承诺上限 24%）」改为「完成实施（实际回购为承诺上限的 24%，未达承诺下限 3.00亿元；方案到期结束、未足额买完）」。③ LAYOUT_VERSION 20261019f → 20261021i 强制重算旧判断快照（否则页面仍显示旧文案）。测试 scripts/test_buyback_plan.js 33 项。
// —— [20261022h] 首页情绪模型新增「宽基ETF申购赎回」常驻因子（10%）+ 面板页签：① lib/etfFlow.js 新建：上交所 PCF（申赎清单）抓全篮成分 + 腾讯行情字段 72（基金份额）算净申赎，Δ份额÷最小申赎单位=篮数，篮数×每篮股数=逐股理论增减；份额是净额，只能给净申赎、拆不出申购总量/赎回总量（模块内明确披露）。② 份额源定为腾讯 qt.gtimg.cn（本机 push2 全族常被 reset），东财 f84 降为备链并加 10 分钟熔断。③ 快照基期只认 settled:true（15:05 后定稿），盘中增量不进累计台账，避免半天进度永久计入。④ 情绪模型 BASE_WEIGHTS 8 常驻重排（22/13/9/9/9/9/9/10）总和仍 100；新增 /api/etf-flow。⑤ 面板加页签：情绪因子明细 / 宽基ETF申赎（ETF 表 + 被买被卖 Top10 + 全量成分股累计表）。⑥ 回归 scripts/test_etf_flow.js 55 项；test_market_emotion 因子数 9→10。
const APP_VERSION = '20261026f'; // [20261026f] 个股记录行内编辑表单补样式（用户 2026-10-26 截图「182743/182749」指出修改表单渲染成原生白色控件）：20261026e 只加了 HTML 结构未补 CSS——style.css 新增 .sl-edit(修改按钮,与 .sl-del 同款、hover 琥珀)、.sl-btns、.sl-item.sl-editing(琥珀描边+淡琥珀底标记编辑态)、.sl-edit-form/date/text(与 .sl-add 添加表单同款暗色输入框+color-scheme:dark)、.sl-edit-actions、.sl-save(btn-primary 同款琥珀实底)/.sl-cancel(描边)，全部复用模块既有 token（card-bg #161B22 / accent #F0B97B / text #E6EDF3）。 // [20261026e] 个股记录「修改」按钮（用户 2026-10-26 截图「181737」要求每条记录带「修改」按钮）：lib/stockLog.js 新增 updateLog（按 id 定位、可改日期与内容、校验与 addLog 一致、updatedAt 溯源）；server.js 新增 PUT /api/stock-log/:symbol/:id；public/js/stockLog.js 整体重写渲染「修改」按钮 + 就地内联编辑表单（日期 input + textarea + 保存/取消，Ctrl+Enter 保存 / Esc 取消，事件委托）。 // [20261026d] 红涨绿跌文本着色落地（用户 2026-10-26 截图「164518」指出情绪因子卡里涨跌文字/数据未按要求标色）：app.js 新增 _dirColorize——带符号数值 +0.19%=红/-1.19%=绿、上涨/涨停 N=红、下跌/跌停 N=绿、其余「涨/跌」方向字按语义着色（日期 2026-10-26、时间 14:30-15:00、T+1 不误染）；应用于①首页情绪因子卡 value/detail 与核心驱动/量能状态/操作建议/风险提示四行，②个股市场情绪提醒面板 value/detail，③个股短期判断子因子卡与长短期判断因子 detail/value（同口径统一）。 // [20261026c] 颜色语义对齐红涨绿跌：① 行业政策徽章 战略扶持(利好)→红、受限(利空)→绿（原绿/红颠倒）；② 量比口诀3/5「尾盘放量拉升」由 ve-bear(绿=看空) 改为 ve-block(琥珀=警惕)，因模型明确「不得输出看多信号」，非看空信号。 10-23 真数据回填（用户 2026-10-26 报「还是没有获取到数据」）：经 NeoData 逐日权威份额变动回填——① 双路交叉验证（S21+Δ1022 与 S23−Δ1023 相等）33/33 严丝合缝后，data/etf-flow/20261023.json 还原为「按 10-23 当日采集」口径（shares=S22、shareDate=20261022、含 restored 溯源标记与全部 Δ 数据），运行中服务经 /api/etf-flow 实测「净申购 322.86 亿 · 24 只净申购/1 只净赎回」，台账 10-23 增量由代码幂等入账（lastDate=20261023、days=3）；② 510310（易方达沪深300发起式）NeoData 无逐日份额表（5 次尝试、实体解析正确），今日按「份额缺失」诚实处理、明日自愈；③ lib/marketEmotionModel.js calcEtfFlow 降级分支补透传 etfDate（修卡片「数据日期」回退到模型基准日的错标）；④ LAYOUT_VERSION 20261026b 强制当日判断重算（etfFlow 输入数据实质变化）。备份：data/etf-flow/20261023.backup-20261026.json、ledger.backup-20261026.json。 // [20261026a] 修宽基ETF申赎「净申购 0.00 亿/0 只净申购」假数据（用户 2026-10-26 报障）：[20261026a] 修宽基ETF申赎「净申购 0.00 亿/0 只净申购」假数据（用户 2026-10-26 报障）：根因是快照 shareDate 按 tradeDate 推、而份额 T+1 披露按采集日可见——周六补采的 10-23 快照实际已拿到 10-23 官方份额却标成 10-22，与 10-26 快照（同为 10-23 值）相减得假 Δ=0（510300 真实净申购 +25.13 亿份被吞）。修复：① lib/etfFlow.js collect 的 shareDate 改按采集日推（_prevTd(localCompact())，钳回 ≤tradeDate）；② computeFromSnapshots 加披露未跨日守卫（baseShareDate>=shareDate → 诚实报「无法计算」，禁假 0）；③ 跨多日缺口加 spanNote 标注多日合计；④ 存量纠偏：20261023.json shareDate→20261023、20261022.json 显式补 20261021、ledger.lastDate 回滚 20261022（假 0 消耗的幂等锁）。10-23 当日真实增量因基期值未捕获无法恢复，10-27 起披露跨日自动恢复。 // [20261025p] 三项改动（用户 2026-10-25 要求）：[20261025p] 三项改动（用户 2026-10-25 要求）：① 情绪总分改「权重比合计净值」——前端显示 totalScore×100 = 各因子净权重合计（±100 分制，徽章/详情行/阈值同步 ±20 分），内部 totalScore 语义不变（子卡/落盘兼容）；② 删除首页「情绪因子明细/宽基ETF申赎」页签（_renderEmoTabs/_renderEtfFlowPane/_loadEtfFlow 整体移除），情绪卡片回归单视图；③ ETF 明细改独立网页 /etf-flow.html + public/js/etfFlowPage.js（渲染逻辑整体迁移、全量成分股表默认展开、带刷新按钮），因子卡片「查看宽基ETF明细」按钮改 window.open 新标签直达。排版保持独立页统一外壳（DESIGN §12），因子网格对称布局不受影响。 // [20261025o] 市场情绪数据统一两位小数（用户 2026-10-25 要求「数据保留小数点后两位，百分比也是」）：① 模型 volumeText 量比 round 2（修「量比 1.2390594651481384」16 位浮点外漏）；② 核心驱动「净权重 ±X 分/权重 Y%」round 2；③ 前端情绪面板权重/净权重/情绪总分 toFixed(2)；④ 个股「市场情绪提醒」子卡情绪总分 round 2。另核实：股吧热度 94% 分位判「中性」为模型本意（score=-1 需「分位>90% 且大盘近期大涨」双条件）；用户所见「情绪总分 0.009/旧文案核心驱动」为旧进程未重启覆写的旧口径数据，重启即愈。LAYOUT_VERSION 20261025g。 // [20261025n] 市场情绪模型改「净权重=评分」（用户 2026-10-25 要求「市场情绪提醒 8 因子参考个股短期判断模块同样修改」）：① lib/marketEmotionModel.js 总分由 Σ(score×权重) 改 Σ(满格方向±1×权重)，因子评分=±权重（净权重），强度折扣退场（保留在文案与核心驱动排序）；② 因子下发 contribution（方向×权重，已含降级归零/滞后 8 折）；③ 前首页情绪面板因子明细大字改「净权重 ±X%」（判断模块同款），倾向阈值/仓位档位/自学习机制不变；④ 同日情绪记录每次刷新覆写（existing 路径），个股页「市场情绪提醒」子卡读落盘 score 自动跟随。 // [20261025m] 修「量能信号中性 vs 量价配合放量下跌」同屏矛盾（用户 2026-10-25 报「两个模块合并后出现数据错误和矛盾」）：根因是 volumeEngine._reconcileTodayBar 的追加条件 quote.date===todayStr 在周末/节假日失效——周六访问时最近交易日（10-23 周五）终值 quote 被拒，bars 末根停留 10-22，量能信号与量价配合都把 10-22 的「放量下跌 -4.18%」当成当日（实际 10-23 放量上涨 +2.26%）；同时旧服务进程内存里还跑着 10-23 初稿的口诀文案「放量下跌筑转周」（工作区已是「放量下杀防转弱」，重启即愈）。修复：追加条件放宽为「quote 新于末根 + 不晚于本地今天 + 是交易日」，实测 000902 date 补至 10-23、主判转第 5 条「量增价升看延续」、资金面偏多 0.24，与行情一致；量能三测试 28+295+229 全绿。LAYOUT_VERSION 20261025e 强制重算当日判断。 // [20261025l] 个股页新增最右侧「个股记录」tab（用户 2026-10-25 要求）：按日期排序的手动记录，自由文本添加该个股值得注意的问题——lib/stockLog.js（落盘 data/stock-log/<代码>.json，日期校验/2000字上限/500条上限/损坏按空处理）+ GET/POST/DELETE /api/stock-log/:symbol + public/js/stockLog.js（日期倒序分组、删除确认、Ctrl+Enter 提交、本地时区默认今天）+ index.html tab/面板/脚本 + app.js 切股与切 tab 挂钩（同股已加载跳过）。纯手动记录：不参与任何判断/评分/回测，不触发模块联动（隔离原则）。 // [20261025k] 子卡取值去裸百分比（用户 2026-10-25 问「融资余额为什么有两个权重」）：融资余额 value 加「较前值」前缀、涨停/跌停占比加「涨停/跌停」、行业短期走势加「板块」、期货近5日走势加「期货」——与「权重 ±X%」评分数字区分；-0.95% 实为融资余额较前值变化幅度（市场数据），权重只有子卡头部一个。LAYOUT_VERSION 20261025d 强制重算。 // [20261025j] 「权重=评分」铺满整个短期判断模块（用户 2026-10-25 要求「应用到整个短期判断模块，不是只用在事件驱动」）：① 全部 7 因子子卡下发因子内份额（share），因子信号 = Σ(份额×满格方向±1)，贡献分=净权重——市场情绪/个股短期动向沿用既有子权重归一化，资金量能沿用融合权重比例（主结论槽由量价配合承载）且主力净流入新增 0.05 份额（此前纯展示不计分），增持减持 0.55/0.45/0.20 归一化、被动减持按方向计分，行业板块涨跌停互斥持权 0.45/行业走势 0.35/板块消息 0.20，对标期货以相关性强度作份额、传导方向入子卡，跷跷板死区后满格；② 事件引擎子事件改发份额（effWeight/sumEff，显示数值不变）；③ 前端子卡权重=份额×因子有效权重、因子行净权重=Σ(份额×eff×方向)。LAYOUT_VERSION 20261025c 强制重算。 // [20261025i] 「权重=评分」口径落地 + 布局自适应（用户 2026-10-25 要求）：① lib/eventEngine.js 事件聚合信号由「信号强度加权」改为「方向满格加权」（事件按权重把 ±1 计入，贡献分≈净方向权重：回购+30%、原油-4% → 净+26%≈26 分），内幕抢跑保留原强度微调；② 前端因子行/长期卡片/子卡片全部删除「得分」数字——因子行只留「净权重 X%（最高 Y%，方向色）」或「权重 X%」，子卡片只留「权重 ±X%」；③ CSS 因子行与子卡片头 flex-wrap 自适应（条形弹性收缩、数字不截断，内容增减不再破版）；④ LAYOUT_VERSION 20261025b 强制重算。 // [20261025h] 判断卡片恢复「权重+得分」双显示并新增净权重口径（用户 2026-10-25 要求「所有权重与得分都要显示」）：① lib/eventEngine.js 事件子因子下发 effWeight（恒正、方向由 signal 承载）；② 短期因子行有带权子因子时显示「净权重 X%（最高 Y%）」=Σ(子权重×方向)，其余因子仍「权重 X%」；③ 因子行与长期卡片恢复「得分」（contribution×100），子卡片显示「权重 ±X% + 得分=权重×|signal|」；④ LAYOUT_VERSION 20261023i→20261025a 强制重算。 // [20261025g] 短期/长期判断卡片评分标注统一为「权重」口径（用户 2026-10-25 要求「统一采取权重」）：因子行删「利好/利空 ±档位」徽章与「贡献分」数字，只保留「权重 X%」+ 方向色/箭头；子卡片「利好+1」改纯文字「利好/利空/中性」；综合分与置信度保留。纯前端展示口径、后端判断缓存不重算。 // [20261025f] 工作台布局深度优化与统一（用户 2026-10-25 要求「深度优化布局设计，统一不统一的地方」）：style.css 新增「独立长页统一外壳」段——四独立页（notes/accuracy/judgments/logic-model）统一页宽阶梯（808/1148/1148/1328 居中，accuracy·judgments 与首页 home-card 1100 同宽对齐）、统一 .jd-header 页头（logic-model 独立页头结构废弃对齐，lm-tool-btn/lm-head-actions 死规则删除）、统一 sticky 工具条（np/acc/jd-toolbar 同一套）、统一页面级筛选芯片（np-tab/acc-tab/jd-tag 同一套金令牌着色）、统一大空态虚线空盒（表格内小空态不受影响）；独立页颜色全部令牌化（home-action-btn.active 杂金 rgba(207,174,124,0.14) 修正为 --accent-light、nav-acc-link 硬编码金改令牌、acc-kpi 裸 hex 红绿金改 var()）；jd-filter 圆角对齐 --radius-sm；notes 写按钮与范围 tab 去 emoji（DESIGN.md §6 动作按钮纯文字）；accuracy 页头按钮次序统一（次要在前、主操作在后、返回居末）；DESIGN.md 新增 §12 独立长页统一外壳；[20261025e] 删除归档模块（用户 2026-10-25 要求「把归档的模块删除」）：notes.js 移除 ARCHIVE_DAYS/_isArchived/_pageList 与 SCOPE_META.archive，renderScopePage 恢复 getByScope 全量渲染、hint 文案复原；notes.html 删除「📦 归档」tab 与 archive 初始化分支（scope 白名单复原 global/market、写按钮恢复常显、计数复原「共 X 条」）；20261025d 的单列流式布局与正文折叠摘要（展开全文/收起）保留；[20261025d] notes 独立页改纵向单列流式布局（固定宽度居中、上下留间距）+ 正文折叠摘要（3 行截断，「展开全文/收起」切换）+ 新增归档 Tab（超过 30 天的投资心得/大盘记录自动进入归档，只读视图隐藏写按钮）；[20261025c] 三弹窗改独立页面（用户 2026-10-25 要求「把这三个模块的弹窗改为新建网页页面」）：新增 public/notes.html（投资心得/大盘记录，?scope=global|market，顶部 tab 切换 + grid 多列卡片，Notes.renderScopePage 渲染进 #scopePageList）与 public/logic-model.html（逻辑模型树，LogicModel.buildInto 构建进 #lmPageBody，TREE 与首页同源）；notes.js 删 showScopeModal/renderScopeModalBody/refreshScopeModal/closeScopeModal 四个弹窗函数、新增 SCOPE_META + renderScopePage 并挂入 renderHome 刷新链（验证/设为主/保存/删除后页面列表自动刷新）；logicModel.js 提取 buildInto() + init 页面模式检测 + toggleAll 双容器 + 行点击委托放行页面模式；index.html 三入口按钮改 window.open 新标签跳转、删 lm-modal overlay 骨架与 logicModel.js 引用（该脚本移至 logic-model.html 加载）。 // [20261025b] 记录弹窗金融工作台风格重排（用户 2026-10-25 要求）：note-card 日期居左+状态标签小色块居右（note-head-tags 容器）、正文行高 1.75、动作按钮缩小（11.5px/3px 10px，含 btn-set-main 补基础尺寸）右对齐沉底+细分隔线、journal/scope 弹窗加宽 760px 内边距加大、记录块间距 14px、lm-modal-body 内边距加大；与左侧股票列表深色主题统一。 // [20261025a] 量能数据按档位着色（用户 2026-10-25 要求，放量红/缩量绿/平量白）：app.js 新增 volTierCls 共用助手，接入个股量能分析卡「量能档位」「60日量能确认」、大盘情绪卡「量能状态」两处、四维度客观描述「量能状态」；档位真值源 lib/volumeEngine.js VOLUME_TIERS（极度缩量/温和缩量/平量/温和放量/大量/天量），cap-pos/cap-neg 复用全站红绿语义。 // [20261024m] 修「AI 解读仍不同步到大盘记录」（用户 2026-10-24 16:24 报障）：20261024l 的落盘加了 `cached !== true` 门槛，导致「缓存已存在但从未落盘」被跳过（16:08 旧代码生成缓存，16:24 点按钮命中缓存 → 不落盘）。改为**只要 success 就 upsert**（saveMarketReviewNote 幂等，同一交易日只更新不重复），缓存命中也补齐落盘；并已用现有缓存回填一条「AI 大盘复盘 · 2026-10-23」到大盘记录。守卫 test_market_ai_cache_notes 22 项。 // [20261024l] AI 大盘解读「缓存 + 落盘大盘记录」（用户 2026-10-24 16:09 截图：手动 AI 解读没同步进大盘记录；且每次系统更新都重新解读）：① lib/ai/market.js 缓存由「4 小时 TTL」改为「按 asOfTradingDate 交易日缓存」——同一交易日（含周末/长假沿用最近交易日）复用同一份解读，只有跨交易日或显式 force 才重调 LLM，缓存记录写入 asOfTradingDate；② 手动生成（POST /api/ai/market-overview）成功后自动 upsert 到 data/notes.json（scope=market，标题「AI 大盘复盘 · 交易日」，同日更新不重复），与 15:30 定时复盘共用 lib/dailyMarketReview.saveMarketReviewNote，命中缓存不重复写；③ 首页「AI 解读」按钮改为「确保有解读」（POST force:false，复用缓存、缺失才生成），Alt+点击=强制重新解读；页面刷新 GET 直接读缓存。守卫 test_market_ai_cache_notes 21 项。 // [20261024k] 非交易日数据口径铁律（用户 2026-10-24 要求：非交易日无法获取「当日」数据应判定为正常，沿用最近一个交易日的数据即可，不得因此判「数据不足」）：lib/cnTradingCalendar 新增 asOfTradingDate / isDataCurrent（非交易日 → 最近交易日，沿用即视为最新）；板块拥挤度 recordDaily 落盘门槛由「字面 today」改为「最近交易日」（周末/节假日沿用最近交易日数据，只有严格滞后才拒绝），ensureSectorCrowdingToday 增加周末分支——确保最近交易日记录存在，避免首页板块拥挤度周末显示暂无数据；板块涨幅榜 recordDailyRanking 改为按最近交易日为键（消除周末伪日期污染近 N 日统计）。量能引擎 20261024f 的 _staleBarGapText 已同口径（周末末根=最近交易日 → 中性说明，不进红框）。守卫 test_non_trading_day_policy 19 项。 // [20261024j] 修「60日量能确认」文案歧义（用户 2026-10-24 15:52 截图：指标卡写「未确认」，生死位规则 1 却给出「60 日均量 927010 手 ×1.5」，判为前后矛盾）：confirm=null 实为「当日量落在 0.7~1.5×60日均量之间」→ 60 日口径平量，并非缺数据。app.renderVolumeEngine 不再写「未确认」，改为显示「平量 / 放量 / 缩量（x.xx×60日均量）」+ tooltip（均量 / 当日量 / 阈值）+ 一句窗口说明（÷5日均量与 60日均量是不同窗口，结论可并存）。纯前端展示改动，数据与计算零影响。守卫 test_volume_confirm_label 15 项。 // [20261024i] 量价分析合并进量能分析（用户 2026-10-24 要求，重复展示删除）：删除个股页独立「📊 量价关系分析」卡（#capVolumePrice），量能卡标题改「🔬 量能分析（量价 × 价格位置 × 量能行为）」；量价配合结论 + 量价独有指标（今日涨跌 / 20日涨跌日 / 20日量价比 / 20日净涨跌）并入 renderVolumeEngine，去重「量比 / 量能热度」（与量能档位同源，不重复展示）；量价数据缺失时显示明确原因（不整卡空白）。修复「个别个股量价分析失效」：capitalFlow.volumeIndicators 改双源兜底（引擎 bars ↔ 路由 history，任一 ≥20 根即可计算）；renderVolumePrice 加元素缺失安全退出，renderAll/实时刷新不再单独渲染旧卡。守卫 test_volume_merge 18 项。 // [20261024h] 新增「模块联动应答机制」（用户 2026-10-24 要求：源模块变动时自动给联动模块发同步/失效信号）：lib/moduleSync.js 声明依赖图（14 模块）+ emitChange 传递失效（BFS 含间接依赖、环路 visited 去重、3s 合并去抖、force 重发、处理器错误隔离）+ 为有内存缓存的模块注册失效句柄（priceActionHub 丢快照 → sameDayJudgment 作废判断）；把原本散落在 server.js / routes 的手写 invalidation 循环统一改为 emitChange（manualZones / eventEngine / dedicatedFactor），并新增 manualZones→priceActionHub→sameDayJudgment 的传递失效（手动区间一变连带作废个股判断，此前只丢快照不作废判断）；新增 routes/moduleSyncRoutes（GET /api/module-sync/graph|signals、POST /api/module-sync/emit 排障/验证）并挂载；marketEmotion→sameDayJudgment 仍走 _emotionSubStale 懒同步（避免首页每次重算情绪就 eager 失效抖动），依赖图仅声明关系。守卫 scripts/test_module_sync.js 37 项。 // [20261024g] 两件事：① 修「首页情绪 vs 个股大盘因子」同屏矛盾（用户 2026-10-24 14:00 截图：首页情绪总分 0.009 中性 vs 士兰微「大盘」因子 -0.317 看跌，且都自称引用同一判断）——根因是个股判断生成时把当日情绪总分烘死进 factors[sentiment].subFactors[市场情绪提醒].signal；首页情绪此后重算（数据源恢复 -0.317→0.009）但判断按 targetDate 复用旧快照，未感知情绪已变；修复：lib/sameDayJudgment 新增 _emotionSubStale/_findEmotionSubSignal，复用前比对「烘焙情绪信号 vs readLatestJudgment() 当前最新值」，不一致即强制重算（getJudgmentWithAccuracy + ensureAllTrackedJudgments 两处同源门控），守卫 test_emotion_judgment_consistency 15 项。② 新增「每日收盘后自动 AI 大盘复盘→写入大盘记录」（用户 2026-10-24 要求，截图「实时大盘·AI 解读」）：15:30 每日结算批内执行 runDailyMarketAiReview（getMarketOverview 同源取数 + analyzeMarketOverview force:true），结果作为 scope=market 笔记落 data/notes.json，同日幂等（标题带日期）、SA_NO_DAILY_AI_REVIEW=1 可关、无 API Key 时如实跳过；新增 lib/dailyMarketReview + 守卫 test_daily_market_review 27 项。 // [20261024f] 修「非交易日恒报『未包含今日数据』假缺口」（用户 2026-10-24 周六 13:35 截图）：末根=周五 10-23、今日周六 10-24，却进红色「数据不足」框。新增 lib/volumeEngine._staleBarGapText 交易日感知（走 lib/cnTradingCalendar）——周末/节假日末根≥最近交易日 → 中性说明「数据已更新至最近交易日」（不进红框）；末根<最近交易日 → 真缺口「未包含最近交易日 X」；交易日口径不变。前端 TRUE_GAP_RE 增「未包含最近交易日」；守卫 test_volume_gap_label 37 项。 // [20261024e] 量能分析「数据缺口」文案展示计算结果（用户 2026-10-24 截图要求）：五大生死位规则里「（未连续超过 60 日均量 ×1.5）」「（未超 60 日均量 ×1.5）」等阈值类缺口由纯阈值描述改为带实际计算值——嵌入最近3日成交量（手）/60日均量×1.5阈值、今日量/60日均量×1.5阈值、当日量/近12月历史峰值、换手率/均值×2阈值等；纯文案改动，dataGaps 仍为字符串数组、下游渲染（app.js ve-rule-gaps 仅 esc 后拼接）零格式影响；审计 9 只自选股确认缺口为系统性（东财通道本机网络层阻断→同花顺降级，全样本统一缺「历史段推算值」+「未含今日数据」两条），非个股特有。 // [20261024d] 个股「量能分析」指标卡括号内说明文字缩小一号（用户 2026-10-24 截图要求）：量能档位（1.41×）/价格位置（分位…）/关键支撑（…）/关键压力（…）四类括号内容包 .cm-paren（font-size 12px，主值 15px），关键支撑/压力 kind 内嵌套括号（如「MA250（上翘）」）随外层 span 一并继承小字号；纯展示层改动，数据与结论零影响。改动 public/js/app.js metrics 数组 + public/css/style.css 新增 .cm-paren。 // [20261024c] 量比口径二级一致性审计（用户 2026-10-24「检查其他量比口径不一致」）：主档位四处（volumeEngine/marketEmotion/marketTechnical/zoneValidity）已统一 1.2/0.8；本版本把两处「共用放量/缩量标签却用 1.5」的次级口径对齐到铁律——① capitalFlow.latestVsPriorAvg.trend（个股页 volumeTrend 来源）：>1.5→温和放量 改 >1.2，<0.5→缩量 改 <0.8，消除量比 1.3 时主档位说「放量」、个股页说「normal」的观感冲突；② capitalFlow 个股突破 breakoutVolRatio >=1.5 改 >=1.2，与 zoneReversal/zoneValidity 箱体突破 BREAK_VOL_MIN=1.2 同源（不另立一套）。迁移守卫 test_volume_root_migration 同步更新 oldAnalyzeVolume/oldBreakout 阈值；新增 test_volume_caliber_20261024c 显式边界断言。 // [20261024b] 量能活跃度卡量比阈值对齐项目「量比」铁律：原 1.5/0.7（>1.5放量/<0.7缩量）与 volumeEngine._volumeTier（>1.2放量/<0.8缩量，东方财富 App 量比口径）矛盾，用户 2026-10-24 截图「量比 1.21（平量）」报障。三处量能分档统一改 1.2/0.8：_latestDayMetrics、calcVolumeActivityLatest、calcVolumeActivity（旧 5日/3日函数亦对齐，供大盘技术分析页与守卫）。量比 1.21 现正确判「放量」、1.08 仍「平量」。守卫 scripts/test_volume_latest_day.js 36 项 + test_market_emotion 62 项零回归。 // [20261024a] 主力资金因子（图二 mainFund）数据源重构：原主链 push2delay 实时通道本机常年 TLS 重置、备链数据中心行业资金流求和又因 'fb.date===today' 硬门槛拒收 T-1 → 因子长期「缺失」。改用 fetchMarketMainFund() 稳定源链路（S1 行业资金流求和优先 + S2 板块资金流汇总兜底，同源东财数据中心族、不引异源，满足数据一致性铁律），接受「最新已收盘交易日」并如实标注口径日/T-lag（与融资余额 T+1 同范式）；快照写入加 lagged 护栏，T-1 值不得挂今日污染历史样本。守卫 test_mainfund_stable_source。 // [20261023p] 量能根新浪降级：腾讯 fqkline 全族被 WAF 拦（HTTP 501 + wa.gtimg.com 跳转验证页）→ 指数日线取不到 → 首页「量能活跃与量价配合」「大盘近期涨跌势头」全线降级「上证/深证日线不足 21 根」（用户 2026-10-23 20:37 截图报障）。修法：lib/marketTechnical.fetchIndexDailyBars 加新浪日K降级（money.finance.sina.com.cn getKLineData，仅限指数——指数无复权概念与腾讯 qfq 等价；个股 qfq≠不复权不走此降级）。关键量纲：新浪指数 volume=股、腾讯=手，实测 100.0 倍整 → ÷100 对齐（否则卡片「亿手」错 100 倍）。腾讯恢复后自动回到主通道。守卫 test_index_sina_fallback 15 项；实测 320 根 0.3s。 // [20261023o] 量能活跃与量价配合卡口径升级：所有口径改为「最新日 + 上证+深证双市」，弃用 5日/3日窗口。calcVolumePrice 改调 calcVolumeActivityLatest/calcPriceVolumeLatest（新增，旧 5日/3日函数保留给大盘技术分析页与守卫）；getMarketEmotionData 注入 indexSZ（深证成指，同量能根通道，失败单市降级）；PV_RISK_TEXT 窗口 近5日/近3日→最新日；detail 末尾口径说明改写。 // [20261023n] 量能活跃与量价配合卡补口径说明：用户看到「今日上证 +0.89%」但卡片写「量升价跌」，误以为分析的是今日。实际该卡用「上证指数 5日价格（今收 vs 5根前）+ 3日量能（近3日 vs 前3日）」：5日 -0.69% + 3日量能 +5.4% → 量升价跌，与今日涨跌无关。detail 末尾加「（口径：上证指数 · 5日价格 + 3日量能，非今日涨跌）」。 // [20261023m] 纠正 PCF/份额的措辞混用：上交所《ETF业务实施细则》第三十条——申购赎回清单（PCF）为「每日开市前」提供、网站 8:30 更新（T 日盘前，基于 T-1 收盘持仓）；T+1 的是「基金份额」，不是 PCF。原 UI「T+1 例行披露」易被读成 PCF 也 T+1。现 margin/etfFlow 因子各带 lagNote 明确区分：融资余额 T+1；基金份额 T+1、PCF T 日盘前 8:30。 // [20261023l] 数据日期再补齐：① 「各宽基ETF申赎」区块标题后加「· 数据日 2026-10-22」；② 融资余额是交易所 T+1 例行披露（最新可得=上一交易日），原 calcMargin 硬编码 lagged:true 且卡片用模型基准日 10-23 标注 → 出现「数据日期 10-23 + 滞后1天打8折」的自相矛盾；现 margin 因子输出 dataDate=2026-10-22、lagKind='cadence'（ETF 同标），前端对「例行披露」改用中性说明「T+1 例行披露（最新可得 …）→ 模型规则权重 ×0.8（惯例折扣，非数据异常）」，只有真正异常滞后才用 ⏱ 警告。 // [20261023k] 数据一致性补齐：① 情绪模型 factors.map 透出 etfDate/settleStatus/totalNet（原被剥掉，卡片只能回退模型基准日 → 标 10-23、数据 10-22）；② ETF 滞后判断把紧凑 20261022 归一到 YYYY-MM-DD 再比（原字符串比较误判 lagged=false），lagDays=1；③ ETF 页签「（当日）」/「当日买·当日卖」改为真实数据日（2026-10-22），术语不再用「当日」。守卫 test_market_emotion / test_etf_flow。 // [20261023j] 两处数据日期修复：① 情绪因子卡补「数据日期」（ETF=份额披露日、讨论热度=热度时间、其余=模型基准日；宏观月度已在 detail 写明）；② 宽基 ETF 申赎「数据日」改用份额披露日（T-1）——腾讯 field 72 是上一交易日份额（实测 510300 在 10-23 取到 327.3 亿份 = 东财 2026-10-22 份额），原按 tradeDate 标注导致「标注今日、数据是昨天」；快照新增 shareDate、台账按 shareDate 键并一次性迁移、_computeEtfFlow 返回 calc.date。守卫 test_etf_flow（58 项）。 // [20261023i] 股份回购从「增持减持」卡片迁入「突发事件」（事件驱动因子），权重按进度：回购提议（001 董事会预案 / 002 股东大会通过）10%、回购实施中（004）30%（用户 2026-10-23 截图要求）。新增 lib/eventEngine.buildBuybackEvent（合成事件，跳过内幕抢跑/市场反应核验，detail 保留四要素）；factorHoldings 不再消费 buyback、不再把回购计入利好家数；LAYOUT_VERSION=20261023i 强制重算。守卫 test_buyback_event_weight（29 项）。 // [20261023h] 修复「三季报已出仍解读半年报」：lib/deep/financials.getLatestPartialQuarterDates 原按月份猜报告期（5-7月=一季报 / 8-10月=中报 / 11月+才三季报），而三季报法定披露期是 10 月 → 整个 10 月读不到 09-30（用户 2026-10-23 洲明科技 300232 截图：「三季报已经出了，模块还在默认解读半年报，自动搜索最新财报的机制是死逻辑吗？」）。现改为直接请求最近两年全部季末报告期，由 F10 返回实际已披露的那些（实测 300232 请求 2026-09-30 返回「2026三季报」）；并升 EARNINGS_PROMPT_VERSION=20261023h 强制失效旧中报缓存，深析管线丢弃 stale 缓存后前端自动触发重新解读。守卫 test_latest_report_period（15 项）。 // [20261023g] 准确率台账增加「待结算明细」：`sentimentAccuracy.computeAccuracy` 输出 `pendingList`（baseDate/targetDate），前端在准确率行下方列出「待结算 N 条：10-22（目标 10-23，待今日收盘）· 10-23（目标 10-26，未到目标日）」，解决「20 条为何只结算 18 条」看不出差在哪两天（用户 2026-10-23 提问）。 // [20261023f] 修复「数据不足标注」误读：① 历史段成交额回填改用腾讯「不复权」收盘价（前复权价会系统性低估 2~3.5%，实测 603288 改用后偏差 <1%），turnover 仍按流通盘推算（实测一致），该条从「推算值」降级为「来源与口径说明」；② 前端把 dataGaps 拆成「数据不足（影响结论置信度）」与「数据来源与口径说明（不影响结论）」两个框——日K降级/当日bar覆写/量比直采/分时未收盘不再塞进红色缺口框。lib/stockData 新增 fetchTencentRawCloseMap；守卫 test_volume_gap_label（25 项）+ test_ths_backfill（21 项）。 // [20261023e] 量价十口诀区块标题去掉「（郭睿体系 · 主判）」括号及其中文字，标题改为「量价十口诀」（用户 2026-10-23 截图要求）。 // [20261023d] 资金量能整合「量价十口诀（郭睿体系）」为用户指定框架：新增 lib/volumeEngine `_tenRules` 主判层（10 条口诀 × 位置/量能/价格，输出 primary/items/framework/reminders/summary），个股页「资金量能」卡顶部渲染（主判 + 10 行对照表 + 框架提醒）；既有 7.4 位置量价 / 7.5 量比口诀 / 11.3 矛盾信号保留为「补充交叉验证」。补齐原引擎 6 个缺口：①低位无量 ②高位无量两子型 ③低位放量吸收确认 ④高位放量创新高/滞涨/放量下跌三分 ⑤放量下杀承接判定 ⑥平量涨跌定性；平量涨/跌方向由 neutral 调整为 observe。引擎 schema → volume-engine-20261023d。 // [20261023c] 修正「低位放大量但价格不跌，要跟踪」误判：原条件 `(isStagnant || chgPct > 0)` 把任何上涨（含 +3.41% 大涨）都当「价格不跌」，与结论文案「仅小阴小阳震荡或重心企稳」自相矛盾（用户 2026-10-23 海天味业 603288 截图报障）。现要求当日 |涨跌幅| < 1.2%（小阴小阳硬门槛，与 isStagnant / 低位放量震荡同阈值），重心企稳（近 3 日收盘重心不下移）只作二次确认；大涨/大跌一律不命中，未命中时明说「已属大涨、方向性上涨、不适用本项」。lib/volumeEngine.js 11.3.3.2。 // [20261023b] 回滚 20261023a 的「卡内页签 + 整行宽卡片」：用户 2026-10-23 截图报障「卡片的布局全部乱了」。宽基 ETF 因子卡恢复为普通网格卡（与其余 9 张等宽），卡片只保留核心数值 + 一句短摘要 + 「查看宽基ETF明细 →」入口；口径解释、ETF 数量统计、逐股统计全部移到独立的「宽基ETF申赎」页签承载，不再撑乱首页网格。删除 _renderEtfFactorCard/_renderEtfInlineBody/_renderEtfStockTable/_renderEtfListTable 与 .tp-comp-wide/.etf-inline-* 样式，新增 .tp-comp-more。 // [20261023a] 宽基 ETF 因子卡新增「卡内页签」（概况 / 个股当日净申赎 / ETF 名单）：用户指出卡片内容看不全，要求卡内直接统计每只成分股当日被净申购/赎回的数量 + 当前模块统计的 ETF 名单。因子卡改为整行宽（tp-comp-wide），卡内复用 /api/etf-flow（同源 3 分钟 memo）按需加载；个股表按当日净额降序，ETF 表按净申赎额降序，红涨绿跌。 // [20261022j] 修正②卡「上方/下方关键区间」排序口径：用户指出 20261022h 做错了——当时实现为「阻力 low 升序 / 支撑 low 降序」，两段都是"离现价最近的在最上面"，方向相反、整卡不连续（截图表现：上方 5.48→6.62 递增、下方 4.94→4.59 递减）。用户原话「我要求的是上方和下方区间统一从上到下按照价格的高度排序」。现改为**两段统一按 low 降序**（高价在上、低价在下），整卡自上而下价格单调不增，等价于一根竖直价格轴：6.62…5.48（阻力）→ 4.99…4.59（支撑），与看盘软件纵轴方向一致。`_sortZones` 删除 side 分支、side 参数保留仅为兼容调用点；强度不再影响顺序，只由行首徽标承担。**后端数组顺序不变**（仍为阻力 low 升序 / 支撑 low 降序），④卡 `resistances[0]` 与量能规则4 `zoneLevelsHint` 的依赖不受影响。守卫：scripts/test_zone_sort_order.js（27 项，用截图里 7 阻力+3 支撑的逐条真实数值断言）。 // [20261022i] 两件事（用户连续两条需求）——①**主图删除「今日收盘价」光标，改为「区间最高/最低」两条自动追踪光标**：原右侧 5.77 价签只标末根收盘价、信息量低；改为两条虚线（红·高 / 绿·低）随**当前选定时间范围**实时重算，滚轮缩放/拖动平移/3月·6月·1年·3年按钮四条路径全部收敛到 `Charts._visibleRange`（读 dataZoom 百分比→下标）→ `_rangeExtremes`（区间极值）→ `_rangeMarkLine`（固定两条，防 ECharts 按索引合并残留脏光标），dataZoom 事件用 rAF 节流。②**修「自选股需要点好几次才切得过去、系统反应缓慢」**：实测冷缓存切股 `/api/analysis/:symbol` 要 2.0~4.0 秒，四个成因叠加——(a) `showLoading(text)` 把 text 参数整个丢弃、只走一条 3px 进度条 → 几秒内屏幕仍是上一只股票，用户以为没点上；(b) 连点时每次 `analyze()` 都 `_reqToken++` 并重发请求、前一结果被 token 丢弃 → 越点等于不断重置读条；(c) 自选股行默认 `draggable="true"`，指针按下轻微移动就被判为 HTML5 拖拽、**click 事件直接被吞**；(d) 60s 定时刷新调 `renderWatchlist()` 整体 `innerHTML` 重建（注释却写「只更新价格单元」）→ 重置滚动/悬浮，还可能吃掉按下时有、抬起时没了的点击。修法：新增 `#loadingPill` 胶囊（pointer-events:none，显示「正在加载 XX」）+ 点击后立即高亮目标行；`analyze` 加 `_inflightTokens` 同股在飞去重（force:true 供刷新按钮/换范围突破）；行导航收敛为 `navigateToRow`，由 `pointerup`（位移≤6px、≤900ms）兜底并带 symbol 维度去重；定时刷新改 `patchWatchlistPrices()` 只 patch 价格/涨跌幅单元格（排序态仍重排，保顺序语义）。守卫：scripts/test_chart_range_cursor.js（39 项）、scripts/test_switch_stock.js（47 项）。 // —— 历史： [20261020l] 三处修复（用户连续三条报障）——①**下线「关键位有效性检验」卡与其联动**：用户指出 20261020i **删错了模块**——当时该删的是这张「生死位规则口径」⑤卡，我方却把箱体区块删了。本轮彻底移除：`getLevelValidity`/`_extractLevelValidity`/`_lvCache`/`LV_TIMEOUT_MS`（lib/priceActionHub.js，连 analyzeVolume+getQuote 依赖）、路由层 `levelValidity` 注入（server.js）、`#paLevelValidity` 卡与 `_renderLevelValidity`/复位/错误占位（public/js/app.js）、`.pa-lv-*` 样式（style.css）、`scripts/test_price_action_level_validity.js`；资金量能页自身的规则3/规则4 不受影响。②**修「距失效还需 3 日」误解**：`invalidation.remainDays` 原在未越界时也恒算 3，前端照渲染成倒计时，看上去像「模型三日后自动失效」；实际条件是「连续 3 日收盘在失效线外」，股价在箱体内震荡时根本未触发。改为：未越界时 `remainDays = null`，前端显示「未触发失效」，只有 `currentStreak > 0` 才显示「已连续 N 日在外，再有 M 日失效」；并加源码守卫禁止「距失效还需」文案复活。③**修「来回震荡却不触发检验」**：`lib/zoneValidity.js` 把「越界」拆成两套谓词——`beyondOf`（收盘越过区间**远端**：阻力>high / 支撑<low）用于标准1、breakCount、streakNow；新增 `touchOf`（收盘**到达**区间近端：阻力≥low / 支撑≤high）用于标准2 的往返计数，字段 `transitions` → `touchTransitions`。根因：603288 现价 34.09、阻力区间 34.33~34.67，近 60 日收盘在该位置反复进出 **7 次**却从未收在 34.67 之上，旧口径一次都不计 → 永远判「有效」，正是用户报障「在阻力/支撑区间来回缩量震荡为什么不触发检验」。新口径实测：603288 阻力 1/2、支撑 1/3（34.33~34.67 往返 7 次、MA20 33.56~34.24 往返 9 次、33.29~33.63 往返 4 次均判无效隐藏，保留 34.53~34.87 与 32.25~32.57）；600909 阻力 0/3；601318 阻力 1/3、支撑 1/1。测试：`test_zone_validity.js` 新增 [15] 触及口径 7 项 → 61/61；`test_range_detector.js` 182/182（新增倒计时断言与文案守卫）。 [20261020k] 箱体上下限并入②卡阻力/支撑清单（用户要求「把箱体的上下限合并到上方阻力和下方支撑区间里面」）——①`lib/rangeDetector.js` 新增纯函数 `boxEdges(sr)`（导出供单测），活动箱体在结果里多挂 `edges:{upper,lower,label}`；②**取「实际收盘区间」envU/envL，不取中轴±容差的失效线 bandU/bandL**：失效线是纯判定阈值（600909 为 9.35/6.91），离现价 33%、且从未被价格触碰过，摆进「阻力/支撑」没有交易含义，用户核对形态用的也是实际高低点（8.54/7.03）；失效线仍留在箱体行与 tooltip 明示「越过 X 连续 3 日才判箱体失效」；③**箱体条目 isBox=true，绝不交给 zoneValidity 过滤**（用户第六条：箱体检验与两条区间有效性检验必须独立）——前端写成 `validOnly(摆动点).concat(箱体条目)`，顺序即约束，测试 [16] 用正则守住，任何人把它挪进 validOnly 都会红；④现价已越到某一侧之外时该侧条目自动省略（不把刚破的上沿继续挂在「上方阻力」里误导）；⑤箱体边界是单点价（`low===high`）→ 渲染单值 `8.54` 而非 `8.54 ~ 8.54`，并加 `.pa-zone-row.box-edge` 金色虚线左边框标识结构边界；⑥②卡箱体行**移除「收盘区间」字段**（已并入清单，避免同屏重复），只留「自 X 起 N 个交易日 · 失效线 · 距失效还需 N 日」；⑦实测（日K1500根）：600909 → 阻力 8.54（箱体上沿 56 日）/ 支撑 7.03（箱体下沿 56 日）；603288 42.22/32.44；601318 58.24/47.23；000858 79.92/68.77；600460 无活动箱体 → 清单不加箱体条目。测试 `test_range_detector.js` 新增 [16] 21 项 → 177/177。 [20261020j] 单箱体模型落地（用户口径：自最新日回溯 20 个交易日起、无固定长度、容差随长度放宽、连续 3 日突破即失效、与阻力/支撑两条有效性检验完全独立）——①`lib/rangeDetector.js` 彻底重写为**单箱体状态机**，删除 20261020f/g/h 的固定多窗口版本（WINDOWS/detectRanges/measureRange/measureDrift/scoreStability/annualizedVol/ampGrade/mergeZoneLevels 全部移除，旧 130 项单测同步重写为 156 项）：种子 = 最近 `SEED_DAYS=20` 个交易日（含最新日），中轴 = 段内收盘**中位数**，段内每个收盘须落在「中轴 ± 容差」的**带**内（不是 min/max 包络）即成立；容差 `tolPctFor(len)=min(10%×√(len/20), 15%)`——√ 的依据是随机游走位移 ∝ √t，15% 上限防久箱体带宽失去意义；成立后逐日推进，收盘在带内则延长，在带外累计 `OUT_BREAK_DAYS=3` 日即失效（**与成交量完全无关**，严禁复用 zoneValidity 的放量/反转次数口径），失效后须重新积累 20 个交易日才可能形成下一个箱体；离群/空值（`Number(null)===0` 陷阱）在 `_num` 前置挡掉。②**重新接入但只展示精简一行**：`priceActionHub` 用已拉到的 daily 直接算 `data.singleRange`（纯函数零网络，故不进路由层二次拉取；失败降级 null 只隐藏本行），②卡「短期动向预判」内 `_renderSingleBoxRow` 输出「自 X 起 N 个交易日 · 收盘区间 · 失效线（中轴±容差）· 距失效还需 N 日」，无箱体时输出「上一个箱体何时因何失效 / 新箱体还差几日」，完整口径进 title 悬停；旧多窗口表格与死样式不再复活（有源码级守卫测试）。③与「阻力/支撑区间有效性检验」（`lib/zoneValidity.js`，20261020i）**源码级双向不引用**、不共用常量，唯一共用只有收盘价原始数据，界面同屏声明两套口径不可互相验证。④顺带修复 20261020i 遗留：区间行悬停明细误用已不存在的 `ck.outDays/ck.maxOutDays/ck.breakDate/ck.breakVr`（会显示 undefined），改为 `transitions/crossMax/streakNow/outStreakMax/lastBreakDate/lastBreakVr`。实测（日K 1500 根）：600909 判出「2026-07-27 起 56 个交易日、收盘区间 7.03~8.54」，与用户截图「7月28日至今、最高 8.54、最低 7.03」一致（旧模型因振幅 19.4% > 16.8% 阈值判不构成）；603288 为 235 日大箱体（中轴 37.97、实际 32.44~42.22）、601318 92 日、000858 86 日，600460 上一箱体已于 2026-10-14 连续 3 日向下突破 28.18 失效（现价 25.91，失效判对）。 [20261020i] 箱体模块下线 + 阻力/支撑区间有效性检验（用户两条标准）——①**箱体模块与②卡联动整体删除**：用户实测 600909「7/28 至今 7.03~8.54」区间内收盘占比 **100%**、越界段 **0**、中轴漂移 **4.8%**，却因固定 60 日窗口（振幅阈值被窗口基准×1.4 压到 16.8%）与实际振幅 19.4% 判「不构成箱体」——证明「固定回看窗口 + 窗口基准振幅上限」与市场直觉「箱体一旦形成就一直延续到失效」不符；故移除 `ranges` 快照字段、`zoneLevels` 路由注入、前端「箱体判定」区块与箱体上下沿并入阻力/支撑的联动、以及相关死样式；引擎 `lib/rangeDetector.js` 及其 130 项单测保留待「自适应起点」版本复用，但不再参与任何运行时计算；②**新增 `lib/zoneValidity.js`**：阻力/支撑区间有效性检验（用户原话「不需要放量就轻松突破则无效」「超过三天在区间处来回突破则无效」），口径：近 60 日窗；收盘穿越（close>阻力上沿 / close<支撑下沿，等于端点算区间内）；突破日量比 = 当日量÷前 5 日均量，>1.2 为放量（与 volumeEngine `_volumeTier` 同源）；量比 ≤1.2 即突破 → 无效；近 60 日收盘在区间外 >3 天 → 无效（「超过三天」故 3 天仍有效）；量能缺失 → 标准1 不判定、不臆造量比；窗内从未穿越 → 有效（未被测试不等于无效）；③区间在 `priceAction.js` 内**原地打标**（valid/invalidReasons/zoneCheck）而非删除，保证语义单源——④卡「反转量化边界」改取首个**有效**区间，前端按 `valid!==false` 过滤、无效区间不展示，区段全被过滤时该标题整段隐藏；④悬停可核对检验明细（区间外天数/最近穿越日/量比/阈值）。 [20261020h] 箱体上下沿拆入②卡「上方关键阻力区间 / 下方关键支撑区间」（用户截图要求）——①**归属**：上限 U → 阻力区、下限 L → 支撑区，右侧标注所属窗口（`250日箱体上沿（主判定）`/`（辅助）`/`（未确认）`，主判定窗即使未确认也保留「主判定」字样）；②**排序**：整卡自上而下按价格由高到低（两区各自降序 + 阻力区整体在支撑区之上，等同点用下沿降序作次序键，单点边界排在同顶点波段之前）；③**单点边界**：箱体上下沿是收盘统计得出的单点价（low=high）渲染单值，悬停给该窗口完整计数（振幅阈值/越界段/假突破/中轴漂移/置信度）；④**单一口径**：归属/标注/排序收敛到 `lib/rangeDetector.mergeZoneLevels` 纯映射+排序，经 /api/price-action 的 `zoneLevels` 实时下发（不缓存、不污染 priceActionHub 快照语义，沿用 20261020e 路由层注入模式），前端只渲染不重复实现；⑤**未确认淡显**：未构成箱体的窗口仍出边界，但 `stable=false` → 前端淡显 + 标注「未确认」，避免被当成已验证的强阻力/支撑；⑥②卡原「箱体区间」区块改为「箱体判定」，只留每窗口的振幅/占比/假突破/漂移/结论（价格区间已移入阻力/支撑，不再重复），口径声明改为「箱体上下沿（收盘统计）与摆动点区间（近60日聚类）两套口径，同屏并列不互证」。 [20261020g] 箱体判定阈值体系升级（用户第二轮规范：不要只按窗口缩放，要结合波动率、改中轴漂移、主判定 250 日、置信度分级）：①**振幅阈值三层结构**——窗口基准（60/120/250/500 日 = 12/18/25/35%）→ 波动率自适应（`ampMax = clamp(1.5 × σ250年化, 窗口基准×0.6, min(窗口基准×1.4, 35%))`，低波动股收紧到 15%、高波动股最多放到 35%，用户原话「不应低于年化波动率 1.5–2 倍但不超过上表上限」）→ 无 σ 数据退回窗口基准并标注依据；②**漂移口径改写**——主判据改为「中轴相对漂移」（滚动子窗中轴 vs 全窗中轴的最大偏离，阈值分层 10/12/15/20%），原「上下沿绝对漂移」降为披露字段 edgeDriftPct 不参与判定（用户：不要用上下沿绝对漂移硬阈值）；③**判定分层**——主判定固定 250 日（数据不足降级 120→60 并写入 dataGaps），60/120/500 只做稳健性检验、不一票否决；④**置信度三级**（不再是有/无二值）：主判稳定+≥1 辅助稳定=高、仅主判稳定或最大连续越界>5=中、主判不稳=低（辅证稳定时提示「箱体可能仅为近期形成」）；⑤**振幅宽度分级** 窄幅≤15%/常规≤25%/宽幅>25%，结论文案直接写「250 日·宽幅箱体成立」，避免与窄幅同等宣传（用户：500 日 35% 只能算宽幅箱体）。实测 6 只自选股：σ 年化 22.5%~54.6% → 250 日阈值 33.8%~35%（自适应生效）；中轴漂移口径使平安（沿漂 28.6% 但中轴仅 12.8%）不再被误杀；海天 250 日 25.3% 判「宽幅箱体成立·置信度高」（60 日辅助同稳）。test_range_detector.js 扩到 100 项全绿（新增阈值三层夹取、σ 计算、分级、主判定降级、置信度三级、中轴漂移口径）。 // [20261020f] 技术面②卡新增「箱体区间（多窗口）」（用户 2026-10-20 提供七段式箱体判定规范并选定 B 方案）：新建 lib/rangeDetector.js 纯计算引擎——多窗口 60/120/250/500 各算一组上下沿，三族候选（收盘分位法 5/95 与 10/90 / 滚动20日高低点分位 / 网格搜索多目标惩罚）择优；口径严格按用户规范：收盘价定界（>U 向上突破、<L 向下突破、== 视为区间内）、按「越界段」计数（收回当天不计入连续越界、首次突破后 5 个交易日内收回记 1 次假突破、第 6 日收回或未收回记有效突破、上下分别计数、二次突破=新段、方向翻转未回区间仍属同段、盘中突破单独计数不进主计数）；阈值随窗口缩放（振幅 60日12%/120日18%/250日25%/500日35%，漂移 8%/10%/15%/20%；占比≥90%、假突破≤3、有效突破=0 不随窗口变；最大连续越界>5 只降置信度）；不存在稳定区间时明确写「不存在」并给最接近候选与不满足原因。priceActionHub 快照附加 ranges 字段（纯计算零网络，不改 priceAction.js 内核，sameDayJudgment 因子不读该字段，无副作用）；app.js ②卡内渲染多窗口行（复用 pa-zone-row 样式、金色=稳定/灰淡=不构成箱体、title 悬停展示八项计数与阈值评分、明示与「近60日摆动点区间」为两套口径）。scripts/test_range_detector.js 71 项全绿（含用户给的每条计数边界）；真实数据标定：000902 新洋丰 60 日命中稳定箱体 13.08~14.50（振幅 10.3%/占比 91.7%/假突破 3 次/漂移 2.7%），并已逐日手工对账一致。APP_VERSION 20261020e→20261020f（public 31 处 ?v= 同步）。 // [20261020e] 技术面分析卡新增「⑤ 关键位有效性检验」（用户问「模型对上方关键阻力区间和下方关键支撑区间，有没有关于这些价位的有效性检验」）：价格行为推演只给区间不做历史检验，现把资金量能引擎（生死位规则）既有检验结论联动展示——lib/priceActionHub.js 新增 getLevelValidity（独立 _lvCache 同 TTL 口径、12s 超时、getQuote 兜底、失败返回 null 不阻塞主链路）+ 纯函数 _extractLevelValidity（levels/platform/breakThrough/breakDown/规则3 缩量假突破/规则4 放量破位含 partial 初步破位/突破后回踩缩量正向确认 + schema/date/barsSource，导出供单测）；server.js /api/price-action 路由在 ...data 之后合并 levelValidity；public/index.html pa-grid 后加全宽卡 #paLevelValidity（.pa-lv-card 专用 CSS，.hidden 显式声明——本项目 .hidden 非全局类）；app.js _renderLevelValidity 复用 ve-rule 样式与红涨绿跌配色，meta 行明示与②「近 60 日摆动点区间」为两套口径；scripts/test_price_action_level_validity.js 31 项全绿、test_volume_engine 295/295、test_volume_consistency 227/227、test_volume_price_signal_wiring 13/13。 // [20261020a] 修复情绪准确率台账「周末基准日」永久卡死（用户截图报障「结算的数量比预测的数量少太大，哪里出bug了？」）：2026-10-18（周日）下午首页接口调用时上证日线通道瞬时失败，marketEmotionModel.js:832 的 baselineDate 兜底为 today=周日，留档基准日落非交易日→上证无 10-18 K 线→settleRecord findIndex 恒为 -1→该记录永久 pending（截图 18 条中 15 已结算/3 待结算，其中仅 1 条卡死，另 2 条为目标日在途与未来的正常态；264 条行情判断台账 256 已结算、33 条权重记录 31 条 T+1 已结算，均健康）。修复三处：①结算侧 settleRecord 新增 resolveBaseDate——baseDate 非交易日回滚到上一交易日（与 20261013f targetDate 防呆对称；不变量 nextTradingDay(d)==nextTradingDay(previousTradingDay(d)) 由测试锁定，目标日不受影响）；②留档侧 recordDailyJudgment 同样回滚，且回滚而来的记录不得覆盖目标日既有留档（通道故障日的降级结论不得顶替正常交易日的完整判断）；③删除 data/sentiment-accuracy/2026-10-18.json 重复计数产物（与 10-16 记录同目标日同方向）。scripts/test_event_weight_sentiment_acc.js 新增 9 项防呆用例（44 项全绿）；实测复刻周日基准日记录可正常结算（回滚至 10-16 基准收盘），磁盘台账 overdue=0。 // [20261019f] 缩量判定标准对齐市场（用户新洋丰 000902 截图反馈「缩量的判定标准和市场上的缩量的判定标准出现矛盾」）：量比 0.99 按市场标准（东方财富 App：量比 0.8~1.2 为平量）应判平量，工作台却因「60 日均量口径（当日量<60日均量×0.7）确认缩量」把 ÷5 日均量的平量翻转成「温和缩量」，标签/热度/引擎结论全变缩量。修复：定档标准改为市场标准量比单独定档——LEVEL_RULES/_volTriState/judgedLevel/_comboEngine/_volTraits/_volumeTier 全链路只认 ÷5 日均量，阈值对齐市场（缩量 <0.8 / 平量 [0.8,1.2] / 放量 >1.2 / 极度缩量 <0.5，大量/天量 2.5/4 内部分级保留）；60 日均量确认降级为分歧披露（volumeTier.divergenceNote 如实说明，不再翻转档位）；capitalFlow unifiedVolState dry 边界 0.4→0.5。schema 升至 volume-engine-20261019f；sameDayJudgment LAYOUT_VERSION 升 20261019f 强制重算当日判断；test_volume_engine.js 新增市场标准对齐回归块（233 项全绿）、test_volume_consistency.js 227 项全绿。实测影响：今日 10 只自选股中 600460(0.93)/000902(0.99)/000783(0.82) 标签由缩量回平量。 // [20261019e] 修复量价标签与解释自相矛盾（用户海天味业 603288 截图报障：标签「量价齐跌」vs 解释「下跌放量」）：capitalFlow.js 下跌分支 amp 档标签「量价齐跌」是 20 日窗口时代遗留词（价跌+20日量能萎缩），20260902m 改当日口径时只改解释漏改标签——当日口径 amp 档=价跌且量增，标签暗示量缩与解释语义相反。修复：下跌侧分级对称化，huge「放量下跌」→「巨量下跌」、amp「量价齐跌」→「放量下跌」（desc 本就正确未动）；VP_MAP 与 sameDayJudgment vpSigMap 分值按档位继承（巨量下跌=原放量下跌 -12/-0.6、放量下跌=原量价齐跌 -9/-0.5，零分值变化）；修复历史遗漏——旧 amp 档不在 bearScore/capitalCharts bear 列表（下跌放量竟不得空头分）；sameDayJudgment LAYOUT_VERSION 升 20261019e 强制重算当日判断；scripts/test_volume_consistency.js 新增第 14 组「标签与解释方向一致护栏」20 场景（181→217 项全绿）。 // [20261019d] 量能引擎「该放量/该缩量」判定缺口补齐（用户提供规范性判定清单，要求去重后补入）：lib/volumeEngine.js 新增纯 IF-THEN 函数 _expectedVolumeRules（零 LLM）——风险类 3 条：高位放量下跌（高位+巨量+明显收跌 chgPct≤-1.2%，补 highHugeNotUp/highStagnant 仅覆盖滞涨横盘/冲高回落之漏）、下跌途中放量阳线诱多（补 shouldShrinkHuge「下跌途中」仅抓 chgPct<0 阴跌之漏，放量阳线诱多原完全漏判）、高位缩量横盘（补 shrinkUp 高位阶段仅覆盖 chgPct>0 缩量上涨之漏）；正向确认类 3 条：突破后回踩缩量不破、低位倍量阳线启动、主升浪缩量上涨控盘（补模型偏矛盾/风险信号、缺理想剖面正向确认之缺口）。注入 _classify（风险类→禁看多；下跌途中放量阳线→强制看空；正向类→signal.bullSupport 看多支撑）、riskTags、highlights、_buildSummaries 新增 expectedVolumeSummary 归集；前端 renderVolumeEngine 渲染新卡片。schema 升至 volume-engine-20261019d；scripts/test_volume_consistency.js 新增 [13] 组，test_volume_engine.js 同步断言。 // [20261019b] 当日 bar 实时行情终值对齐（用户 000902 新洋丰实测：东财 App 量比 0.99 / 当日 +1.87%，工作台 0.97 / +2.39%）：20261019a 新鲜度判据只校验「末根日期=今天」，但同花顺当日 bar 虽带今日日期、收盘后数值仍是盘中快照（close 13.69 / 79,232 手，真实终值 close 13.62 / 80,528 手）——日期新鲜 ≠ 数值终值，快路径直接采用错误快照；本机东财通道间歇被断（socket hang up），腾讯日K虽正确但排在同花顺之后永远轮不到。修复（数据一致性铁律：当日数据单一权威源）：lib/volumeEngine.js 新增纯函数 _reconcileTodayBar 并导出——主行情源腾讯实时 quote 即交易所终值，末根日期=quote 日期→覆写末根 OHLC/量/额（一致则幂等静默）；quote 日期更新且为今日→直接以 quote 补齐当日 bar（全通道日K集体延迟场景，与 20261019a「全 stale 选末根最新」互补：历史段用通道、当日段永远以实时行情为准）；单位按通道自适应（quote.volume 为「股」，tencent 通道 bar 为「手」→÷100，其余通道原值）；quote 缺失/停牌（量 0）/价格非正→不动；覆写/补齐动作在 dataGaps 如实留痕。量价卡与量能卡共用引擎同一份 bars（20261017i），两卡同时受益。scripts/test_volume_consistency.js 新增第 [11] 组 21 项（快照覆写/单位换算/补齐/防御/幂等/静默阈值），总量 104→125 项。 // [20261019a] 日K降级链「新鲜度」判据修复（用户 000783 长江证券实测：东财 App 量比 0.82，工作台 1.26）：旧判据「任一级 ≥10 根即采用」只看根数不看新旧——本机东财被断，同花顺返回 140 根但当日K线收盘后延迟更新（末根止于 10-16），链条直接采用、不再看腾讯（腾讯有 10-19），工作台遂用 3 天前的 K 线得出与东财 App 截然不同的量比与涨跌幅（工作台「当日-1.79%」实为 10-16 跌幅，东财当日实际 -0.26%）。新判据：末根日期=今天才视为新鲜；某级新鲜→立即采用（快路径零额外请求）；不新鲜→记为候选继续下一级；全部非新鲜（停牌/节假日/通道集体延迟）→选「末根最新」者，并列时按 东财>同花顺>腾讯 优先级（字段全优先，与旧行为一致）；全部不足10根→保留最长可用集（原兜底）。选中的日K若非新鲜，analyzeVolume 在 dataGaps 如实标注「日K最新一根为 X，未包含今日数据」。选取逻辑抽为纯函数 _chooseDailyBars 并导出，scripts/test_volume_consistency.js 新增第 [10] 组 11 项（含 000783 场景复现），总量 91→102 项。 // [20261017i] 量能跨卡一致性修复（用户 2026-10-19 反馈「所有个股的资金量能里量价分析和量能分析的数据互相矛盾：量价信号=缩量回调 / 量能热度=量能平稳 / 量能分析资金行为=平量下跌」）：根因是三套口径各自独立、无交叉校验——①数据源分裂：量价卡用路由传入的 getHistory() 日K，量能卡用引擎四级降级链自拉，两条通道可能停在不同交易日；②分子不同：量价信号用当日量、量能热度用近3日均量；③分母不同：前20日均量（不含当日）/ 近20日均量（含当日，且分子含在分母内，比值天然压向1，几乎恒为「平稳」）/ 5日均量+60日确认；④阈值不同：1.5-1.2-0.8-0.5 五档 vs 1.3/0.7。实测 20 只样本 14 只（70%）互斥。修复：①建立统一量能档位真值源 lib/volumeEngine.js _volumeTier（当日量÷前5日均量定档 + 60日均量×1.5/×0.7 确认，与 _comboEngine 的 amplified/shrunk 同式），capitalFlow 的 volumePriceSignal 与 heatLevel 改引自该档位，五档文案体系原样保留；②引擎新增判定性档位 judgedLevel，修正「展示用 pc.level（纯÷5日均量）而结论走 amplified/shrunk」的内部自相矛盾（600460/000902/002594/600030 等 4/15 触发），原始档位以 ratio5Level 保留追溯；③两卡共用引擎同一份日K（volume 按通道归一为「手」，与 getHistory 同口径），内部 bars 字段在返回前剔除、不下发前端；④跨口径分歧（跨窗口/跨基准）如实标注 divergenceNote，不静默取一侧；⑤前端两卡均标注口径来源。实测修复后 15/15 三方一致（70%→0%），新增 scripts/test_volume_consistency.js 91 项零网络回归。 // [20261017h] 个股主图新增「分时」视图（用户 2026-10-19 指令「在个股的主图上添加分时图」）：①主图周期按钮新增「分时」（快捷键 0，其余 1日K/2周K/3月K/4=60分钟），分时与 60 分钟下自动隐藏「时间范围」按钮（无此概念）；②public/js/charts.js 新增 Charts.minute()——分时价格线（涨红跌绿）+ 均价线 + 分钟量柱双 grid，Y 轴以昨收为中心对称并带右侧涨跌幅轴，昨收基准虚线，tooltip 显示价格/涨跌幅/均价/分钟量；③诚实性：只画到 15:00，过滤腾讯分时收盘后追加的 15:01+ 盘后条目（15:38 实测已达 267 条），与量能引擎口诀3「尾盘 14:30-15:00」同一窗口口径；④数据源日期标注：lib/stockData.js fetchTencentMinutes 提取腾讯返回的 data.date（YYYYMMDD→YYYY-MM-DD，实测 "20261019"），server.js /api/minute 透传 minuteDate，图上标题显示数据日期且与今日不符时用黄色标注「（最近交易日，非今日）」——休市时接口返回上一交易日分时，不得冒充今日走势；⑤app.js 切股清空 minuteData 缓存（另有 symbol 校验兜底）。数据源与「资金量能」量能分析引擎同源（同一份腾讯分时），保证图上看到的开盘放量/尾盘拉升与量能卡 7.5 口诀判定口径一致。新增 scripts/test_minute_chart.js 零网络回归。 // [20261017g] 量能引擎分时口径修正（用户 2026-10-19 追问「是不是需要分析分时图」后实测发现的两处缺陷）：①「尾盘突然放量拉升」窗口改为按**时间戳**截取真实交易时段 14:30-15:00，取代原先「取数组末尾 30 条」——腾讯分时收盘后会追加盘后条目（15:10 实测 000902 共 247 条，末尾 1500/1506/1507/1508/1509/1510），按末尾取会把盘后非交易时段算进窗口且随时间持续后移；且盘中未收盘时不得把「最近半小时」当尾盘，改为如实标注「分时尚未覆盖到收盘（当日未收盘）」。②开盘量比单位换算按日K通道自适应——分时 cumVol 恒为「手」，东财/同花顺日K为「股」（实测同日均是大几百万）而腾讯日K为「手」（同日 80,528 手，比值≈100），原先写死 ÷100 会在降级到腾讯日K时把基准缩小 100 倍、开盘量比虚高到 ~320 倍必然误判「量比超3」。schema 升 volume-engine-20261017g；scripts/test_volume_engine.js 217 项全绿（新增单位换算三通道一致 + 反向印证虚高、盘中未收盘/尾盘窗口不足 25 分钟两组数据不足、集成层未收盘标注）。 // [20261017f] 量能分析引擎按《AI 股票量能分析工作台统一业务逻辑说明书（最终整合版）》补齐：①7.4 不同位置量价补充规则（高位放量滞涨/低位放量震荡/缩量上涨两种情况[低位启动/高位阶段]/缩量下跌两种情况[低位大跌后/下跌初期]，子阶段不明按数据不足谨慎处理）；②7.5 五句量比实战口诀（开盘量比超3站均价线/量比回落横盘不跌/尾盘放量拉升/连续低成交不再新低/量比大涨不动，分时类条目缺数据时如实标「数据不足」不臆造）；③11.2/11.3/11.4 三个强制归集总结（无论是否命中逐条完整输出：未命中写「未命中」、数据不足写「数据不足，无法判定」，命中多条全部列出）；④信号分类一致性约束（高位放量滞涨/高位缩量上涨/高位放巨量不涨/尾盘放量/量比大涨不动禁看多信号；下跌初期缩量无承接强制看空观察；spec 7.4 例外：规则1 低位吸筹完整命中时低位放量震荡不限制看多）；⑤s40 约束（高位放量滞涨封顶 12 分、低位缩量上涨保底 16 分）；schema 升 volume-engine-20261017f，前端量能卡新增三个归集卡片（复用既有样式），scripts/test_volume_engine.js 205 项全绿（新增 [15]/[16]/[17] 三组）。 // [20261017e] 量能分析日K降级链补同花顺通道（用户 2026-10-18 指令「@skill:cnfinancialscraper 能不能把同花顺的数据源也接入」——东财双主机均不可达时原链只剩腾讯仅-OHLCV，缺成交额/换手率）：①lib/stockData.js 新增同花顺日K通道（纯新增，既有函数零改动）：fetchThsHistory = last.js（d.10jqka.com.cn/v4/line/hs_<code>/01/last.js，明文近140根含 amount/turnover，前复权与腾讯qfq/东财fqt=1同口径）+ all.js（压缩全历史：price每天4值=(最低,开−最低,高−最低,收−最低)×priceFactor、volumn=股、dates=MMDD按sortYear逐年展开，仅OHLCV）；_mergeThsBars 以重叠段 close 逐日±0.05内一致（≥30根）才采信 all.js 向过去延伸；结构闸门 fail-closed（三列不等长/坏MMDD月日越界/sortYear计数和≠dates数/价格非数字 → null 绝不返回半可信数据）；网络按 20260911 教训 http(80)优先 https 兜底 + proxy:false 直连 + transformResponse 保原始串（JSONP 正则解包）。②lib/volumeEngine.js 日K链升四级：东财多主机 → 同花顺（近期含成交额/换手率，历史段仅OHLCV）→ 腾讯（仅OHLCV）→ 全断诚实报「可用N根」；computeVolumeEngine 新增 barsSource=ths，schema 升 volume-engine-20261017e；_precompute 对同花顺部分窗口（成交额/换手率样本<250天）追加 dataGaps 标注，不冒充全窗口分位。③scripts/test_ths_kline.js 48 项零网络回归全绿（含 2026-10-18 真实黄金样本：000902 解码all.js vs 明文last.js 尾部30根逐根一致，末根锚定 close=13.37/amount=86263040/turnover=0.565 防静默漂移）；引擎 135 项单测仍全绿。 // [20261017d] 量能分析卡数据通道修复（用户 2026-10-18 截图反馈「日线数据明显有」但量能分析卡报「日线数据不足（可用 0 根）」——根因：引擎唯一日K通道东财 push2his 在本机网络被切断，而主图走腾讯通道所以有数据）：①lib/stockData.js 新增 fetchEastmoneyHistoryMultiHost（纯新增导出；按 push2his→push2 主机顺序尝试同一 kline 接口，字段与 fetchEastmoneyHistory 完全一致含 amount/turnover；既有 fetchEastmoneyHistory 及其他调用方零改动）+ 导出 fetchTencentHistory；②lib/volumeEngine.js analyzeVolume 改日K三级降级链：东财多主机 → 腾讯日K（仅 OHLCV，缺成交额/换手率由 _precompute 按 spec 降级并如实标注，不臆造）；任一级 ≥10 根即采用，全不可达保留最长可用集并如实报「可用 N 根」；computeVolumeEngine 新增 barsSource 输出与降级来源 dataGap，schema 升 volume-engine-20261017d；③专项脚本验主机轮询/字段解析/降级路径/全阻断诚实报错全 PASS（临时脚本已删），引擎 135 项单测仍全绿。 // [20261017c] 量能分析引擎落地（用户 2026-10-17 指令：工作台量能分析按《AI 股票量能分析工作台统一业务逻辑说明书》升级）：①新建 lib/volumeEngine.js（纯计算引擎+采集入口，零 LLM，确定性 IF-THEN）——预计算（均量不含当日/六档/60日确认/250日分位）→位置判定（低位<30%/高位>70%/上涨中途/下跌途中/横盘并列/分歧标注降置信）→量价三问（真实性/价格认可度/持续性/单日脉冲）→严格背离检测→五大生死位规则（低位吸筹/高位派发/缩量假突破/放量破位含 partial 待确认/分时无量拉升）→位置×量能组合矩阵→连续量能序列→打分 0-100（40/30/20 权重+背离扣分）→流动性四分层与黑名单衰减→信号分类（空头优先级永远高于多头，规则3 多头失效出中性不得看多）→四维度客观描述+结论提示+免责备注；数据不足一律标注不臆造，叙事字段禁交易指令。②lib/stockData.js fetchTencentMinutes 增量 cumVol 字段（规则5 每分钟量=相邻累计量差分，纯增量不影响既有消费方）。③lib/capitalFlow.js analyzeCapitalFlow 并行补抓并新增 volumeEngine 字段（纯新增，既有字段零改动；引擎内部按通道降级，整体失败置 null 不阻塞主链路）。④前端个股页资金量能 tab 新增「量能分析」卡（public/index.html #capVolumeEngine + app.js renderVolumeEngine + style.css ve-* 样式，红涨绿跌，与 renderCapitalScore 并列 try/catch 隔离，实时刷新链路同步挂载）。⑤scripts/test_volume_engine.js 135 项断言全绿（14 组，零网络）。 // [20261017b] 首页侧量能收敛（用户 2026-10-17 架构指令第二步）：首页量能根数据源落在大盘技术分析的量价关系（lib/marketTechnical）——①新增导出 fetchIndexDailyBars（上证日线唯一采集通道，腾讯 fqkline 直采，320 窗口）与 computeMarketVolumeMetrics（首页共用量能指标纯函数：当日量/剔除极端值后近20日均量/250根分位/近5日价格/近3v3量比，trimExtremes 与 rankPercentile 逐行等价副本随迁）；②lib/marketEmotionModel.js 的 calcVolumeActivity/calcPriceVolume 底层指标改引根函数，打分/市场宽度修正/文案保留本地，返回对象逐字不变；③lib/marketEmotionData.js 的 index 块改从根通道采集（原走 market_emotion.py 的 akshare 通道，实测两通道重叠 260 根 date/close/vol 零差异），输出格式 {code,name,bars:[{date,close,vol}]} 不变、窗口统一 320；④scripts/market_emotion.py 移除 index 块与 fetch_index（ok_count 阈值 3 不变）。等价性守卫 scripts/test_market_volume_root_migration.js 98/0：同一份 bars 旧新逐字相等、260→320 结论零变化（尾部窗口样本集相同）、根指标无漂移。 // [20261017a] 个股侧量能收敛为唯一出口 lib/capitalFlow.js（用户 2026-10-17 架构指令）：computeVolumeIndicators 新增 7 项量能根指标——latestVsPriorAvg（含 priorAvgVol）/ breakout / vol5Vs20 / shrink3d / turnoverChange / volActivity，另加 opt-in 的 volumeProfile（opts.includeProfile）；4 个引用方改为引用根模块并删除本地副本：lib/analysis.js analyzeVolume、lib/priceAction.js（calcLongTerm/calcShortTerm/classifyShortState/calcFalsification 四处内部算法，calcVolumeProfile 整函数删除）、lib/sameDayJudgment.js（turnoverChange 改经 volumeIndicators 透传、factorCapital 的 volActivity 改读根结果）；顺带消除 sameDayJudgment 与 analyzeCapitalFlow 对同一换手率序列的重复抓取；新增 scripts/test_volume_root_migration.js 等价性守卫（59 项 deepStrictEqual 全过）。纯计算位置迁移，对外输出格式零变化（仅新增可选字段）；_computeTurnoverChange 的 detail 文案「近15日均值」按实际口径改为「基准均值」。首页侧量价收敛（marketTechnical step3Volume）排在下一步。 // [20261016c] 审计修复收尾 12 项：①L4 前端因子染色阈值 ±0.03 → ±0.05，对齐后端判色口径（lib/sameDayJudgment.js:209/1040、lib/marketEmotionModel.js:526），修「文字显示中性、颜色却染偏多/偏空」的语义错位（app.js 2 处）；②TE2 技术面评分说明补齐 MACD/KDJ 可叠加子项与理论区间 −6.5~+6.5；③J3 短期/长期判断脚注披露「数据缺失因子按 signal=0 占位但仍计入归一化，会摊薄有效因子权重」；④G7 深度分析缓存条披露「事件引擎识别的突发事件未并入本页结论」；⑤F1/G10 删除 lib/deep/conclusion.js 死变量 weights，并在 lib/analysis.js、lib/companyType.js 加注「weights 仅 legacy 兜底分支生效，正常计分固定每维满分 25」；⑥J2 逻辑模型文案如实说明震荡双口径（个股 ≤1.0%、大盘技术 ≤0.5%），阈值本身未动；⑦G5 深度分析缓存新增「估值模型哈希」门控（FNV-1a 覆盖估值链路全部文件，改模型即自动失效重算，不依赖人工记得升版本号），并在 /api/health 暴露 valuationModelHash；⑧K1 资料库注释纠正为实际抓取通道「巨潮资讯网 cninfo」，并标注本地上传文件由用户提供、非抓取来源；⑨ST1 策略回测页披露「趋势跟踪·短期行情判定」为派生策略（复用 priceAction.shortTerm.direction，属工作台内部联动，非外部 AI / 第三方信号源）；⑩H1/H2 概览「亮点/雷点」卡：距生成日超 7 天标注「已过期」，尚未生成时卡内直接给「立即生成」按钮（POST /api/ai/aspects），失败如实回显原因；⑪P1 公司简介补渲染「主营业务 / 经营范围」（后端 shareholderData.js:307-314 早已返回，前端此前从未渲染）；⑫S6 行情日期解析失败时后端新增 dateFallback 标志位（仅加字段、不改原字段），前端标注「⚠️ 日期解析失败，显示为本机日期」，不再静默冒充真实交易日。 // [20261016b] 审计修复六项：①IA1/IA2 行业政策库 + 上游行业名归一化「顺序 includes 第一命中」偏置 → 改「最长（最具体）关键词优先」，两处同改，返回格式零变化；②L1 长期判断 source 去除「AI 联网抓取」虚假归因，如实标注内置静态政策库；③G4/DA6 评级严格三档（去除「偏高」「合理偏低」，conclusion.js 4 处 + insuranceAnalysis.js 1 处）；④CA5 资金量能热度注释「±15」校正为实际 +13~-10；⑤P2 简介卡与事实库标注「企业性质」为按股东结构推断值（非东财F10权威登记口径）；⑥G8 深度分析路由并发去重（在途 Promise 复用，返回结果完全一致）。 // [20261016a] 修复个股页 1-4 项前端口径：S2 总市值去掉 ×10000（totalValue 单位本为亿）、S1 港股货币符号 HK$、T1 技术面"6信号"改"4类信号(MA/RSI/MACD/KDJ)、T2 基本面权重固定25、T3 资金热度 MFI 仅展示不计分、T4 资金卡去除"仅支持A股"虚假归因+T5 失败评分卡显示"加载失败"。纯前端 app.js 文案/口径修正，数据格式与后端逻辑零改动。 // [20261015m] 板块舆情热度周榜数字含义标注（用户反馈：右侧一列白色大数字未标明含义）：①前端 public/js/homeHotTopics.js 综合分大数字上方增加「综合分」小标签（.htw-score-label，muted 色 10px，与下方市场行三段式右对齐）；②后端 lib/hotTopicsWeekly/index.js footnotes 新增口径条——右侧「综合分」（0~100）= A 舆情曝光 / B 社区讨论 / D 舆情情感 / E 社区情感 四指标加权合成，C 韭菜讨论只触发告警不计分，5 日涨跌幅与资金净额占比仅作交叉参考、热度高不代表看涨。纯展示层与脚注文案改动，数据格式与计算逻辑零变化；test_hot_topics_merge 25/25。前版 [20261015l] 实时大盘「行业板块涨幅前5 / 跌幅前5」两组末尾各新增一卡（用户需求：各自添加当日最多涨停/最多跌停的板块）：①采集层 lib/stockData.js 新增 push2ex 涨停/跌停股池取数（getTopicZTPool / getTopicDTPool，与 20261015j 炸板池同域名同族；本机实测稳定：2026-10-16 涨停池 61 行与乐咕涨停 61 互证、跌停池 10 行），新增聚合纯函数 aggregateTopIndustry（按股池 hybk 行业字段计数取 top1，leader=该行业池内首只个股〔涨停池 sort=fbt:asc 即封板最早〕，并列取先出现者〔确定性规则〕，空/脏数据返回 null 不伪造）；getEastmoneySectorRanking 返回注入 topLimitUpBoard/topLimitDownBoard（双池各自容错，失败字段 null），并经 getMarketOverview 独立透传（盘中面板切同花顺时仍保留——池为全市场事实、与榜单渲染源解耦）。②前端 app.js renderMarketOverview：renderGroup 参数化 items，两组榜单各追加 kind:'limitUpTop'/'limitDownTop' 卡片（name+金色「涨停最多/跌停最多」标签、price=封板最早/代表个股、chg=N 家涨停/跌停，涨红跌绿与既有卡一致；数据 null 不渲染该卡）；css 新增 .mo-limit-tag。既有 sectorsUp/sectorsDown 数组格式与 AI 解读/榜单历史记录/提醒卡槽位零改动（隔离修改）。新增 scripts/test_limit_board_top.js 聚合单测 9 项全绿。前版 [20261015k] 大盘量能情绪模型因子结构合并（用户需求：「量能活跃度」与「量价配合度」两个卡片合并、权重也合并）：10 因子 → 9 因子（7 常驻 + 2 非常驻）。①lib/marketEmotionModel.js：BASE_WEIGHTS volumeActivity:15 + priceVolume:10 → volumePrice:25（量能活跃与量价配合），FACTOR_NAMES 同步；新增 calcVolumePrice 合成函数——得分 =（量能活跃度得分 × 15 + 量价配合度得分 × 10）÷ 25，按原权重加权，权重不变时与合并前两因子分别计分对总分的贡献数学等价（数据不变则结论不变）；降级规则：任一半数据缺失 → 整体降级归零并按比例分摊（两半同源于上证日线，实际同生同死；reason 指明是哪一半）；value/detail 合并两边统计并在 detail 尾部写出合成算式（可解释）；返回新增 volRatio/volPct/volState/pvScore 透出字段。②历史兼容：loadState 增加幂等迁移——state.json 旧 volumeActivity+priceVolume 权重合并为 volumePrice（保留自学习成果，超 W_MAX 部分由 scaleBounded 夹紧）；历史 factorAcc 旧 key 记账保留可追溯，新因子学习从零开始（仍需 20 样本）；模型标识 volume-emotion-v1 → v2（结构变更诚实标注）。③前端零逻辑改动：app.js 因子网格自动渲染 9 因子；model 判断同步 v2；「8 常驻」标题 →「7 常驻」；logicModel.js badge「10 因子」→「9 因子」与描述口径同步。④回归 test_market_emotion.js 新增 [6c]（加权合成数值 -0.2 / 0.7 双场景、降级 reason、state.json 迁移幂等），59 项全绿。前版 [20261015j] 大盘量能情绪模型「市场宽度与极端情绪」因子新增炸板率（统计展示 + 封板质量修正）：①采集层 scripts/market_emotion.py fetch_breadth 增加东财炸板股池取数（akshare stock_zt_pool_zbgc_em，底层 push2ex.eastmoney.com 实测本机稳定可达：收盘后 49 行、连续三次 0.2 秒一致；与收盘涨停池互斥，代码交集为 0，口径干净），breadth 新增 zbgcCount/zbgcBreaks/zbgcRate/zbgcNote 四字段（炸板率 = 炸板家数 ÷ (涨停 + 炸板家数)，与涨跌家数同一次采集、同一统计日期；取数失败仅炸板字段为 null 并记 warnings 如实标注，不拖垮涨跌家数、不伪造）。②模型层 lib/marketEmotionModel.js calcBreadthExtreme：value/detail 增加炸板率展示（如「炸板率 44.6%（49/110）」），方向分 >0 时做封板质量修正（炸板率 ≥50% 得分 ×0.7、≥70% ×0.5，防「虚涨停」把普涨判满分；普跌/分化场景不修正、缺失不修正），返回值与 factors 白名单投影同步新增 zbgcRate/zbgcCount/zbgcBreaks，风险提示新增炸板率 ≥70% 条目，来源脚注补充炸板股池口径。前端因子网格直接渲染后端字符串零改动；落盘判断记录仅存得分符号、个股页「大盘」卡片仅读总分倾向，均不受影响；回归 test_market_emotion.js 补 [6b] 炸板率五路断言（展示/字段/40%不修正/60%打7折/80%打5折/缺失不修正/普跌不修正），45 项全绿。前版 [20261015i] 工作台 UI 设计升级（impeccable 精修）：红绿 tint 令牌化、h1 21px 排版步进、按钮 emoji 纯文字化、金色 :focus-visible、hover 瞬时态 AA 修复、搜索历史面板默认折叠、prefers-reduced-motion 无障碍、图表红绿色板集中（chartTheme 单一定义点）、死 CSS 清理、结算完成 num-flash 确定性反馈。前版 [20261015h] 全工作台数据源一致性审计与统一（用户需求：同一数据在不同模块使用不同数据源时，统一为稳定数据源）：实测审计 lib/ + server.js + routes/ + scripts/*.py 共 120+ 处外部调用，修复 4 处真实分裂/失效（全部为后端 lib 函数，前端零改动）。①lib/deep/financials.js fetchShareholders——个股市值/股本/PE 原走 push2.eastmoney.com（本机常年被对端 TLS 重置，服务日志实测 000783/600909 持续 socket hang up，深析估值/DCF/公司分类长期拿不到股本市值），改走东财数据中心 RPT_VALUEANALYSIS_DET 报表（datacenter-web 稳定可达；与基本面卡片的 totalShares/PS_TTM 同源同报表，与腾讯行情实测逐位一致：000783 总市值 431.90 亿/PE 8.38/PB 1.17、600909 总市值 363.25 亿/PE 11.46），返回六字段与原 push2 f84/f85/f116/f117/f162/f163 完全同名同单位，下游 analyzeValuation/calculateDCF/classifyCompanyType 零改动，失败仍返回 null 不伪造。②同文件 fetchFinancialStatement——companyType 回退链 [4,2] 扩展为 [4,2,3,1]（对齐 lib/stockData.js 现金流量表取数的既有全类型循环；接口实测：券商股 000783/600909 的资产负债表/现金流量表仅 companyType=1 返回数据，ct=4/2/3 全空 → 修复前深析 Balance: 0/Cashflow: 0、资产负债与现金流分析及 DCF 全部失真，修复后实测 Balance=5/Cashflow=9 行；普通股 ct=4 首次命中行为不变）。③lib/newsSearch.js fetchEastmoneyAnnouncements——原域名 np-anotice.eastmoney.com 已失效（实测 HTTP 200 恒返回 0 条，个股「新闻与公告」页的公告部分长期静默为空），统一为全站唯一实测可用路径 np-anotice-stock.eastmoney.com/api/security/ann?ann_type=A&client_source=web&f_node=0&s_node=0（与 cnscraperAdapter 20260922i 修正路径完全一致；f_node/s_node 必带否则返回全市场公告；响应字段 title/notice_date/art_code 不变，解析零改动；修复后实测 000783 返回 10 条）。④lib/deep/research.js fetchAnnouncementsEastmoney——原 /api/security/announcement 死端点（20260922i 在 cnscraperAdapter 已确认失效但本处漏改，深析公告的东财兜底形同虚设），统一为同一 /ann 活路径，date 取 notice_date/eiTime、url 用 art_code 合成正文直链（与 newsSearch/cnscraperAdapter 同一格式）。审计排除项（实测确认同源或属正常主备链设计，未改动）：AI 权威财务快照（ai/augmentStock）与基本面卡片（stockData.fetchEastmoneyFundamentals）同走 emweb ZYZBAjaxNew 同参数同解析=同源；深析公告主链（deep/research）与官方公告卡（cninfoAnnouncements→python）同走巨潮 hisAnnouncement/query=同源；前十大股东两处同走 datacenter RPT_F10_EH_HOLDERS=同源；原油主连 20260921l 已把新浪 nf_SC0 设为主力、push2delay 降兜底；日K线 getHistory 腾讯主链+东财/新浪兜底顺序合理；顶栏四卡与基本面关键指标已于 20261015e 统一 fundamental.metrics 单一权威口径。已知遗留（如实报告、本次不改）：download_reports.py 东财 ann_type=2 通道已失效（其依赖 attachments PDF 直链需重新设计获取方式；人工研报下载工具且有巨潮主链兜底，非页面实时链路）；个股资金流 push2his fflow daykline 为东财独占口径、无稳定备源（已有 axios→curl→K线量价估算三级降级并如实标注 estimated，非分裂问题）。 // [20261015e] 顶栏关键指标卡（PE/PB/PS/ROE）联动「基本面·关键财务指标」（用户需求：数据联动基本面关键指标，利好标红、利空标绿）：①public/js/app.js renderKeyMetrics 四卡数值改为优先取 data.fundamental.metrics（与基本面左卡 renderFundamental 的 m.pe/m.pb/m.ps/m.roe 同一权威口径，杜绝顶栏与基本面两处口径分裂；fundamental 缺失时回退 quote.fundamentals 既有值，行为不劣化）；②着色复用同一响应内的 data.signals.signals（lib/analysis.js evaluateSignals 确定性判定，key=pe/pb/ps/roe）：signal=bull→metric-value.red（利好红）、bear→green（利空绿）、neutral→默认白，与基本面左卡 sig-bull/sig-bear 完全同一判定来源，全站涨红 #F6465D/跌绿 #0ECB81 规范色不变；③判定依据（reason）追加进卡片 title，鼠标悬停可见「信号判定（利好/利空/中性）：原因」；ROE 数值优先 roeTtm（与左卡 metrics.roe 实证同值）。隔离修改：仅前端渲染层（app.js 一个函数 + 两处 ?v= 戳），不动任何后端取数/计算/信号逻辑。 // [20261015d] 主力资金流向因子接入稳定备链（实时大盘情绪模型最后一个死因子）：主链 scripts/market_emotion.py fetch_main_fund 走东财 push2delay fflow（本机常年被 TLS 重置，因子自 20260917 模型上线以来长期权重归零）。备链：东财「数据中心」RPT_INDUSTRY_FUNDFLOW 报表全行业求和——128 个申万行业的 SUPERDEAL_NET(超大单)+BIGDEAL_NET(大单) 逐日求和 ≈ 沪深两市主力净额，与 push2 主链完全同一东财口径/同一单位（行业是市场的完整划分；datacenter-web 本机稳定可达，2026-10-15 实测当日 128 板块全齐、合计 -637.35 亿与行情吻合）。实现：lib/marketEmotionData.js 新增 fetchMainFundViaDataCenter（含完整性守卫：当日板块行数 ≥ 前日行数才认定当日已发布完整，否则当日值宁缺毋假）并在 getMarketEmotionData 中于 selfCheck 之前注入 raw.mainFund（顺序关键：保证 issues 反映注入后真实状态），仅当备链交易日=今天才注入当日值，盘中未更新至今日时如实标注「备链最新为 X，收盘后自动回补」。同步更新三处文案：selfCheck 缺失提示、模型 calcMainCapital 降级原因、模型 source 脚注（如实描述双通道）。隔离：主链 python 脚本零改动（通道恢复即自动优先实时值）；mainFund 数据形状不变，无下游格式变化。 // [20261015c] 修复实时大盘「AI 解读」点击无反应：① 根因为联网模型 qwen3.8-max 阿里百炼免费额度耗尽（403 Free quota exhausted，同账号实测 qwen3.5-35b-a3b 也耗尽、qwen-plus 可用、qwen3-vl-plus 可用；阿里免费额度按模型独立计算）——data/ai_config.json 的 modelWeb 已切换 qwen3.8-max → qwen-plus（loadConfig 每次读盘，即时生效；本地模型 qwen3-vl-plus 不动），额度恢复后可在「⚙️ AI 设置」换回。② 前端 loadMarketAI 失败静默缺陷：原只有 NO_KEY 弹窗，API_ERROR 被静默吞掉 → 用户点按钮毫无反应误判「功能失效」；现在所有失败路径（API_ERROR / 无内容 / 网络异常）均 alert 明确原因（诚实合规：失败必须可见）。隔离：仅 app.js loadMarketAI 一个函数，不动任何渲染与数据链路。 // [20261015b] 实时大盘数据源稳定化：① 顶栏日经225（100.N225）主源由东财 push2delay/push2 切换为新浪 hq.sinajs.cn int_nikkei（本机 push2 族常年被 TLS 重置，2026-10-15 全天 socket hang up 实测 ECONNRESET；新浪 38ms 实测稳定，4 字段 名称/点位/涨跌点/涨跌%，昨收=点位-涨跌点 反推），fetchEastmoneyIndex 双 host 降为备胎保留（跨网络环境兜底）。② 新增 lib/stockData.fetchSinaIndicesBatch（新浪 hq 批量指数：s_sh/sz 简版 + rt_hk 详细 + gb_ 美股 + int_ 全球四种格式统一解析，强制 Referer 否则 400），并接入 module.exports。③ 腾讯 qt.gtimg.cn 整批请求失败时整批回退新浪（text 标记 __SINA_FALLBACK__ + JSON Map，parse 命中顺序 东财全球→新浪兜底→腾讯文本），新浪也失败才抛原错（维持 500，绝不伪造数据），消除 qt 单点抖动导致实时大盘整卡 500 的问题。隔离性：输出 JSON 键集合 22 键与改造前完全一致、cn/us 组腾讯路径逐位不变、indexSource 标注不受影响（日经在 topbar 组且顶栏不显示来源标注）；端到端实测 unavailable 项数 0（改造前日经恒为 unavailable）、跨源现值一致（腾讯 3677.01 = 新浪 3677.0092）。妙想 MCP 定位为手动深度查询（按积分计费，不适合秒级轮询），不接入本模块。 // [20261015a] 修复「未找到 Python 解释器」进程级永久缓存 bug：受管 Python 是指向 WorkBuddy 应用资源目录的符号链接（versions/3.13.12 → resources/vendor/python），WorkBuddy 自更新重写该目录的几秒窗口内探测全败（实测 2026-10-15 11:01 服务器启动恰逢更新，日志 "did not find executable"），旧逻辑把失败永久缓存 → 情绪模型 8 因子权重归零、同花顺板块/融资余额/汇率/研报下载等到重启前全部不可自愈。修复：lib/stockData.findPythonForScript、lib/pyRuntime.findPython、lib/pdfText.findPdfPython 三处统一改为「失败仅冷却 60 秒，到期自动重探；成功仍永久缓存」。返回契约（路径|null）不变，成功路径行为逐位不变，无下游格式变化。lib/indexPETrend 本无缓存（每次重探、可自愈）维持不动。——幸存者偏差系数由固定 0.9 升级为证据驱动（曾用名含 *ST/ST 则按次数下调至 0.60~0.90，无 ST 历史则 1.0），取数失败时保底 0.9 并如实标注未获证据；输出新增 survivorship_evidence 与 risk_check_result.f10_status（additive）。② Johansen 协整：新增 jacobiEigen/matInverse/matMul/matT/johansen（VECM 辅助回归 + 矩矩阵 + 特征值分解 + 迹/最大特征值统计量 + Osterwald-Lenum 临界值），pair 策略优先 Johansen 并附 Engle-Granger 交叉验证与一致性标记；样本不足/矩阵奇异自动降级 EG。③ 60 分钟长窗口：腾讯 m60 实测硬上限 800 根且不接受起止日期（分页不可行），改走新浪 scale=60（实测上限 4023 根 ≈4 年，最新收盘价与腾讯逐位一致），新增 lib/stockData.fetchSinaKline60m；count>800 自动切换并挂 .meta 标注来源与切片口径差异（10:30/14:00 两处 ≤0.06 元）。默认 count≤800 仍走腾讯、行为不变。④ 止损/止盈/移动止盈 + 等批建仓：runBacktest 新增 opts.stopLoss/takeProfit/trailing/tranches/trancheGap（触发优先级 止损>止盈/移动>信号平仓，保守口径）；normalizeDSL 解析 stop_loss/take_profit/trailing/tranches；lib/strategyNL.js 新增 parseRiskParams 支持中文「止损8%/止盈20%/回撤5%/分3批建仓/每隔5个交易日」；前端 backtestUI.js 新增风控出场表与 F10 证据块 + style.css .bt-evidence。隔离：默认全关 → 输出字段与历史逐位一致（不再拒绝仓位类中文，金字塔/动态加减仓仍如实拒绝）。[20261014b] 策略回测引擎 P1/P2 升级：① ADF 滞后阶按 AIC 自动定阶（`adfCore`+`adf`；不传 lags 时自动、显式传参保持固定）② `walkForward` 新增 purge/embargo（默认 0 保持旧行为，生成器传 min(20, 3%N) 消除指标回看窗跨折泄漏）③ 新增多重检验校正（Benjamini-Hochberg 单侧二项 vs 50%）：auto-strategy 输出 `multiple_testing` 块，最优若本可 PASS 但未过校正则降级 WARNING ④ 分层成本能力：`runBacktest` 支持非对称 `buyCost`/`sellCost` + `aShareCostModel` 助手（佣金+印花税仅卖出+过户费+滑点），DSL 可传 `cost_model`，默认仍对称 0.55%/边。前端 `backtestUI.js` 新增参数敏感性逐候选条形可视化与多重检验展示；`style.css` 新增 `.bt-ps-bars`（中性蓝/金，避开红绿语义）。隔离：默认路径输出结构不变（新增字段均 additive）。 // [20261014b] 策略回测引擎 P1/P2 升级：① ADF 滞后阶按 AIC 自动定阶（`adfCore`+`adf`；不传 lags 时自动、显式传参保持固定）② `walkForward` 新增 purge/embargo（默认 0 保持旧行为，生成器传 min(20, 3%N) 消除指标回看窗跨折泄漏）③ 新增多重检验校正（Benjamini-Hochberg 单侧二项 vs 50%）：auto-strategy 输出 `multiple_testing` 块，最优若本可 PASS 但未过校正则降级 WARNING ④ 分层成本能力：`runBacktest` 支持非对称 `buyCost`/`sellCost` + `aShareCostModel` 助手（佣金+印花税仅卖出+过户费+滑点），DSL 可传 `cost_model`，默认仍对称 0.55%/边。前端 `backtestUI.js` 新增参数敏感性逐候选条形可视化与多重检验展示；`style.css` 新增 `.bt-ps-bars`（中性蓝/金，避开红绿语义）。隔离：默认路径输出结构不变（新增字段均 additive）。 [20261014a] 策略回测引擎 P0 修复（风控审查四项）：① 交易成本不再双重计入（runBacktest 已在成交价按单边成本计提，applyCorrections 的「交易成本」步改为系数 1、仅作信息展示）② KPSS 重写为 Newey-West(Bartlett) 长程方差 + 正确统计量公式（修复实测 stat=61.97 的量纲失真）③ adjustedReturn 与 adjustedWinRate 统一口径（补乘前视 f1/成本 f2，前视命中时修正收益同步归零）④ 手动校验入口 validateStrategy 新增「样本量闸门」（交易笔数 < 10 → 新裁决 INSUFFICIENT_SAMPLE，不再给 PASS/WARNING/REJECT）；diagnostics 透出 sample_trades/min_trades。下游同步：backtestUI.js verdictBadge/verdictBadgeText 增加 INSUFFICIENT_SAMPLE 映射、style.css 新增 .bt-verdict.INSUFFICIENT_SAMPLE（中性蓝，避开红绿涨跌语义）、strategyGenerator verdictText/rankOrder 补该枚举值。隔离说明：自动生成路径因上游已按笔数过滤，其输出结构与裁决值不变。 [20261013j] 基本面 tab「指标分析」改为按需单卡展示（用户要求：右侧指标分析拆分隐藏，点击关键指标左侧 tab 后才展示对应指标分析卡片，其他隐藏）：renderMetricAnalysis 增加 activeKey 参数——非当前项卡片一律渲染 ma-hidden（display:none），无 activeKey 时面板顶部显示 .ma-empty 引导空态（提示点击左卡「分析 ▸」查看、再次点击同一 tab 收起）；新增 showMetricAnalysis(key) 统一驱动右卡显隐/空态/左卡 tab 激活态（.metric-jump.active），当前选择维护在 this.activeMetricKey——实时刷新（60s）与切股后重渲染均按该键恢复，用户选择不丢失；scrollIntoView 平滑定位 + ma-flash 闪烁保留作为切换确认。style.css 新增 .ma-row.ma-hidden/.ma-empty(+.hidden)/.metric-jump.active（中性金色系，避开红绿涨跌语义）。隔离修改：不动任何取数/计算/图表口径与 METRIC_ORDER 单一权威顺序。 [20261013i] 基本面 tab「关键财务指标」×「指标分析」tab 联动（用户要求：关键指标每个指标右侧加 tab、指标分析按指标拆成独立卡片、点击 tab 自动弹出/定位对应指标分析）：public/js/app.js 的 renderKeyMetrics 为每个指标行新增「分析▸」跳转按钮（data-key 取 keyOf(label)，与右卡 metricAnalysis.metrics[].key 同一套 14 键·单一权威口径），点击后 smooth scrollIntoView 定位右卡同键 .ma-row 并加 ma-flash 闪烁高亮（重复点击重触发动画），右卡数据缺失时 toast「该指标暂无分析数据」不静默失败；renderMetricAnalysis 每张卡片加 data-key 锚点；style.css 新增 .metric-jump（中性金色小胶囊，避开红绿涨跌语义）与 .ma-row.ma-flash/@keyframes maFlash，.metric-row .mr-value 加 margin-left:auto 保证加 tab 后数值仍紧贴右缘。同步修复 test_current_quote_refresh.js §4 六项预存失败（index.html/accuracy.html 的 ?v= 戳从 20261006a 升级到 APP_VERSION）。隔离修改：不动任何取数/计算/图表口径，仅新增导航交互。 [20261013h] 工作台逻辑模型弹层从「总—分四层链路」重构为「按工作台页面布局」展示（用户要求：按整个工作台页面布局，列出每个页面有哪些模块、每个模块的判定逻辑、模块间的数据共享/引用）：public/js/logicModel.js 的 TREE 重组为 4 个页面区域（🏠 首页 9 卡 / 📈 个股页 10 tab+顶部评分区 / 🔗 跨页面公共支撑·数据源+API+AI+事件引擎+估值库+准确率闭环+规则守卫 / 📄 独立页面与全局入口），每个模块新增结构化字段 logic（判定逻辑）、inputs（数据来源）、outputs（输出去向），渲染层新增 renderFields 展示这三项，实现「模块↔模块数据共享/引用」可视化；弹层 intro 与标题文案改为「按页面布局」；style.css 新增 .lm-logic/.lm-io/.lm-k 样式（金/蓝/青三色，避开红绿涨跌语义）；index.html 版本戳同步 ?v=20261013h。隔离修改，仅影响本弹层展示，无下游数据格式变化。[20261013g] 个股近期热点新增振幅触发（用户要求：个股当日震荡幅度超过 3%，联网搜索分析原因）：lib/hotTopics.js 新增 AMPLITUDE_THRESHOLD=3% + resolveTrigger 确定性判定（涨跌幅≥3% 或 振幅>3% → 「当日异动归因」联网归因；振幅字段缺失时用 high/low/prevClose 补算），收盘平盘但盘中深 V/冲高回落也触发归因；归因 prompt 按触发方式区分（振幅触发问「盘中宽幅震荡的最直接原因」）；缓存加 triggeredBy 一致性校验（触发方式/方向变化重算）；CACHE_VER=20261013g 旧缓存作废重算；前端异动归因卡新增「振幅 X%」角标标注触发来源；getState 返回增加 amplitude/triggeredBy 字段（只加不改，无下游破坏）。通用模块改动，自动适用全部个股。[20261013f] 修复首页「越用越准·准确率台账」两处问题（用户质疑 12 条预测为何只结算 9 条、命中率为何 0%）：① 根因=历史留档的验证目标日落在休市日（09-25 中秋/10-01 国庆，留档时交易日历数据缺失），找不到 K 线永久卡「待结算」；sentimentAccuracy.settleRecord 加防呆——存档 targetDate 非交易日时按当前日历重算（isTradingDay 校验），并修复两条脏数据（09-24→09-28、09-30→10-08），补结算后两条均命中，命中率 0%→18.2%（2/11）。② 命中率 0% 的构成=7 条震荡未命中（|chg|≤0.5%，口径经用户 20260914i 确认「不姑息」）+2 条方向真错；computeAccuracy 新增 flatMissCount/dirMissCount 分项（口径不变），app.js 台账展示改为「命中率 X%（其中震荡未命中 N / 方向真错 M）」避免一刀切误读。[20261013e] 美国宏观判定升级为双维度（用户要求：失业率/非农要分别标注「对经济的影响」和「股市的偏好」，避免单一判定误读）：lib/usMacroResults.js 拆分 ecoDirection（经济影响=基本面框架：就业弱=经济偏空）与 mktDirection（股市偏好=宽松/紧缩交易框架：就业弱=宽松预期升温=股市偏多），directionOf 兼容导出=股市口径（情绪因子锚 FOMC 不受影响，FOMC 两维度同向）；事件新增 eco 字段，summary 双判定文案「经济影响：…；股市偏好：…」；homeMacro.js 双徽章（经济/股市，偏多红/偏空绿各自配色，旧数据回退单徽章）；LOGIC_VERSION=20261013e 旧缓存自动失效。修复 20261013c 单一判定的两处硬伤：失业率上升标「偏多」无维度限定易误读为经济改善；文案"失业率上升=缓解压力"事实性矛盾。[20261013c] 美国宏观数据「落地复盘」（用户要求：参考预期值，分析超预期/不及预期影响）：新增 lib/usMacroResults.js 抓华尔街见闻宏观日历（api-one-wscn.awtmt.com，单源三值齐全，forecast=彭博/路透共识口径，接口限7天/次须切片），过滤美国FD importance>=3，按标题分类（CPI/PPI/非农/失业率/FOMC/零售/ISM），三值数值化判定 超预期/符合/不及预期，按类型×偏离给方向影响（通胀超预期偏空/弱就业偏多等）；usMacroEvents 升级三级源（华尔街见闻三值→FedRateCalc排期→内置清单），released 保留7天/upcoming 过期剔除；前端三值行+超预期角标+偏多红卡。修复：transform 未存 type 导致 FOMC 上下限未合并。[20261013b] 美国宏观事件排期改为自动抓取：新增 lib/usMacroCalendar.js 抓 FedRateCalc 汇总表（条目来源 BLS/美联储官方排期；BLS 直爬被 Akamai 403、美联储官网只有 FOMC），美东时间确定性转北京时间（含 DST 规则），类型模板方向框架解读（不编数值），落盘缓存 12h TTL + 失败回退陈旧缓存 + 内置策划清单兜底；getUsMacroEvents 保持同步兼容情绪因子；路由返回数据来源标注。[20261013a] 修复首页「国际经济数据 & 事件」过期事件永久滞留：usMacroEvents 加日期判定自动剔除过期事件（9月FOMC/CPI/非农落地近月仍挂预告、且持续向美国宏观情绪因子输出-1偏空），清单更新至BLS/美联储官网排期（10-14 CPI、10-29 FOMC决议、11-06非农、11-10 CPI、12-10 FOMC）；macroSentimentFactors 去掉写死旧事件id；homeMacro 空清单诚实空态 + 纳入强制刷新名单。：顶栏常驻组（与投资心得/大盘记录/AI 设置同高并列）新增入口，点击弹出「总—分」树状弹层展示整个工作台的逻辑框架（数据层→计算层→API 层→展示层 + AI 叙事层 + 规则守卫层）。新增 public/js/logicModel.js（纯静态结构 + 纯前端渲染，不请求后端、不调用大模型）；?v= 与 FRONTEND_BUST_FILES 同升。零副作用：未改动 app.js 与任何既有模块。[20261003j] 修复 2.5D 柱状图渲染 bug（用户反馈「大量图表出现bug」）：bar25D custom series 的 renderItem 原直接返回元素数组，ECharts 5.4.3 createEl 读取 elOption.type 遇数组 undefined 抛「graphic type 'undefined'」→ 机构持仓变化空白 / 股东户数走势数据压缩 / 成交密集区渲染失败；改为 { type:'group', children:items } 包裹（垂直 + 横向两处）。?v= 与 BUST 同升，强制浏览器放弃修复前缓存的 chart3D.js。[20261003i] 柱状图 2.5D 补齐（用户再次反馈「大量柱状图未修改」）：① 深析「负债结构」横向柱图接入 bar25D horizontal；② 股东页「股东户数趋势」「机构家数趋势」接入 bar25D（dataZoom 手动追加 + 折线透传 + 多 y 轴），解除此前「带 dataZoom 保持 2D」限制；③ 全部保留 2D 兜底。[20261003h] 柱状图 2.5D 补全升级（用户反馈大量柱状图未改）：① bar25D 新增横向模式（类目在Y轴，等轴测向右上挤出；支持 rgba 半透明筹码光带与现价 markLine）→「成交密集区与价格引力」升级；② bar25D 新增折线系列透传 + 双柱分组错位 + 多系列 tooltip + 顶部数值标签 → 「分红分析（每次/每年/每股切换）」「营收/净利润增长率」「当季NBV+累计/TTM」「营运利润+净利润同比」接入 2.5D；③ 全部保留原 2D 兜底渲染；④ K线量柱 / MACD 柱 / 带 dataZoom 的趋势柱图（股东户数/机构家数）读数优先保持 2D。[20261003g] 柱状图/饼状图 2.5D-3D 升级（参照用户参考图等轴测立体柱+3D甜甜圈）：① chart3D.js 新增 SA3D.bar25D()——纯 ECharts custom series 的 2.5D 立体柱（正面玻璃渐变+左侧高光条+右侧深色面+顶面高光+底部贴地投影，保留 2D 坐标轴/grid/dataZoom/折线叠加，无需 echarts-gl，任意环境可用）；② 深析「保费收入趋势」（立体柱+同比折线）、「短期偿债风险」（四色立体柱+数值标签）接入 bar25D；③ 深析「资产结构」「险种结构」「前十大股东」与股东页「前十大股东持股比例」四个饼图升级为 2.5D 厚度圆环（SA3D.donut：厚度底座+扇区悬浮弹出+中心大数字：资产合计/占比最大险种/第一大股东）；④ 全部带数据Zoom/多轴/横向的柱图保持 2D 增强不动（读数优先）；⑤ 无 SA3D 环境全部自动回退原 2D 渲染。[20261003f] 修复「很多图表被压缩」：Charts.get() 初始化实例后未注册进 Charts.instances，导致技术面 tab（display:none 隐藏期）初始化的 paMonthly/paProfile/macd/rsi/kdj/boll 等 6 图退化为 200px 宽后，switchTab 与 window resize 遍历 Charts.instances 永远触达不到 → 切回 tab 仍压缩；现已注册实例（charts.js get()），并在 switchTab 切到 technical 时补一次 120ms resize 兜底。（只改视觉层，数据源与计算逻辑零改动）：① 本地引入 echarts-gl 2.0.9（vendor/echarts-gl.min.js，CDN 兜底）——bar3D 真 3D 柱（光影+SSAO+bevel+自动旋转），加载失败/移动端(pointer:coarse/宽<768)自动静默降级 2D/2.5D；② 新增 public/js/chart3D.js 组件库：SA3D.glb() 环境检测、SA3D.bar3D()（bar3D+line3D 混合、红涨绿跌、生长动画两段式 grow）、SA3D.donut() 2.5D 圆环（厚度底座+扇区弹出+中心文字）、SA3D.lightBar() 2.5D 柱增强；③ 资金流向图（主力净流入 bar3D + 超大/中/小单 line3D）与融资融券图（融资余额 bar3D + 融券余额 line3D）接入 3D，非 3D 环境维持原 2D；④ K线主图 2D 克制增强：蜡烛/均线/成交量柔光晕（shadowBlur 4-6，不遮挡十字光标与价格精度）；⑤ 表格卡片化 CSS：冻结表头(sticky)+斑马纹+涨跌色块+排名徽章；⑥ /js/chart3D.js 纳入 FRONTEND_BUST_FILES。 准确率入口最终定案（经用户确认）：与「首页/已自选/导出HTML/导出JSON/刷新」同组（global-nav-extra 内、排在刷新之后）并列，个股页显示、首页不显示（与该组同步显隐，还原图一布局+新增准确率）。上一版误放常驻组（首页也显示）已回退。[20261003c] 修正准确率入口位置（第二次）：用户所指「首页这些tab」= global-nav-common 常驻组（投资心得/大盘记录/AI设置）。由 global-nav-extra（个股页按钮组，首页隐藏）移入 global-nav-common 内、排在 AI 设置之后——首页与个股页均可见、与三个常驻 tab 同高并列。padding 8px 16px/13px 与 .home-action-btn 一致。[20261003b] 修正准确率入口摆放：由 .global-nav 直接子元素（常驻、首页会单独占位）改为 global-nav-extra 组内成员（排在「刷新」之后），与首页/自选/导出HTML/导出JSON/刷新同组并列、同步显隐——首页不再单独出现（避免看起来像顶替了那组按钮），个股页才显示。[20261003a] 准确率入口从顶栏移入常驻导航行 .global-nav：index.html 删除顶栏 #topbarAccuracyLink，改挂到导航行 global-nav-extra 之后（始终可见——首页无操作按钮组时右对齐显示），与首页/自选/导出/刷新等按钮同高并列；新增 .nav-acc-link 样式（保留金色强调色，padding 对齐 .home-action-btn 8px 16px 以同高），/css/style.css 已在强制刷新名单。[20261002c-2] 个股技术面「待验证」口径统一与显示优化：settleSymbol 对全部未结算记录归一 targetDate=基准日+HORIZON个交易日（含2026法定节假日），并纠正旧版误存的 base+1；isOverdue 无 status 兜底改为实时重算真实目标日，长假期间合法 pending 不再误报「过期未结算」；accuracy.js 待验证记录显示「预计结算日；遇长假顺延」。[20261002b] 新增「数据诚实原则」核心底层逻辑：未成功获取的数据必须明示"获取失败"，绝不拿其他数据/陈旧快照/零值聚合凑数（lib/dataHonesty.js 统一信封 + 前端 public/js/dataStatus.js 标准态 + scripts/test_data_honesty.js 反凑数守卫；标杆改造股息率分析链路 yield.js/pipeline.js/deepCharts.js） [20261002a] 行业板块拥挤度多周期聚合修复：今日/本周/本月的成交额与涨跌幅由「窗口末日值」改为「区间累计」（Σ各日成交额 / 复利累计涨跌幅），彻底修复三列成交额恒等；app.js 口径文案同步 [20261001d] Robinhood 式图表与界面视觉升级（只改视觉，不改任何数据源与计算逻辑）：① 新增 public/js/chartTheme.js 统一图表视觉层——注册升级版 softDark 主题（极简坐标轴：隐藏轴线/刻度仅留柔和网格；悬浮卡片 tooltip：深色玻璃卡圆角+投影+模糊；圆润图例小色块；dataZoom 柔和蓝手柄 #7fa8c9）+ SA_CHART.polish/attach/grad/rgba 助手，echarts.init(el,'softDark') 自动继承，attach 包装 setOption 全模块生效；② charts.js 主 K 线专项打磨——主题降级兜底（chartTheme 加载失败时回退旧版主题注册）、K 线 barMaxWidth=14 + 现价虚线标线（右端涨跌语义色价签）、MA 线 1.5px 细线、成交量半透明圆角柱、tooltip 悬浮卡外壳、面积渐变；③ capitalCharts/industryCharts/shareholderCharts/deepCharts 四模块 init 处 SA_CHART.attach 包装 + 柱图半透明圆角 + 折线渐变面积；④ style.css 字体栈升级（Segoe UI Variable Text 优先）+ 时间范围/周期/分红切换统一 Robinhood 式胶囊分组（.chart-controls 内凹浅底 + .range-btn/.period-btn/.dy-toggle-btn 圆角胶囊 + 选中态品牌金 #F0B97B）；⑤ /js/chartTheme.js 与 /js/charts.js 纳入 FRONTEND_BUST_FILES 强制刷新。 [20261001c] 首页市场情绪模型三处数据异常修复：① 融资余额假读数（-50.47%）——沪深交易所披露节奏不同步（沪已到 09-30、深仅到 09-29），market_emotion.py fetch_margin 原按日期盲加导致最新日只有单边数据被腰斩；改为仅计沪深双边完整日期，单边最新日给出 partialNote 说明，并在 marketEmotionModel.calcMargin 加 ±10%  sanity 闸门（超出即降级归零、标注疑源数据残缺）+ lagDays=1；② 「热度数据滞后」张冠李戴——app.js 滞后提示硬编码「热度数据」，改通用「数据滞后 N 个交易日」；③ 主力资金缺失文案改清楚——东财 push2 行情通道被限流属环境性中断（无大盘级备胎），市场主力净额缺失/主力资金缺失两处提示注明通道不可达、恢复后每日快照自动回补。 [20261001b] 图标更换：工作台图标整体换为用户上传的七彩扇形轨道图（豆包生成图已裁除右下角水印）：① scripts/make_favicon.py 生成 public/icon.png(512) + public/favicon.ico(16/32/48，中心80%裁剪保小尺寸辨识度)；② index/accuracy/judgments 三页 icon 链接改 ICO+PNG 双声明（删除 favicon.svg 死文件）；③ 顶栏品牌「📈 股票分析台」emoji 改为 icon.png 小图（style.css 新增 .brand-logo 20px）；④ /icon.png 纳入 FRONTEND_BUST_FILES。[20261001a] 体检修复包：① aiRoutes quoteService 死引用改 stockData.getQuote（专属估值实时价修复）；② CNINFO orgId 落盘缓存 + 1 次重试；③ app.js 搜索结果 XSS 转义；④ server.js 全局错误中间件 + unhandledRejection 兜底、移除死 multer 引用；⑤ 删死文件 marketOverviewEm.js / cheerio 依赖 / 根目录旧日志与 tk24.json；⑥ webSearchMcp MCP 会话复用 + 总超时守卫 + 百度每日计数 + 错误归一化。 [20260928a] 修复「策略」模块 60 分钟数据取不到（用户华安证券 600909 截图「无法获取60分钟数据」）：strategyGenerator 误传对象 {symbol} 给 getHistoryPeriod → detectMarket 把对象串成 "[OBJECT OBJECT]" → tencentCode 非法 → 60m 全空回退日线；改为传 symbol 字符串。同时 fetchTencentKline60m 的 count 由 2000 改为 800（腾讯 m60 上限 800，>800 会被对端静默回退到默认 320，样本量不升反降），并在取数层强制夹紧 count∈[1,800] 兜底。 // [20260923a] 个股页新增「官方公告（巨潮资讯·确定性数据）」卡片（GET /api/announcements/:symbol + #cninfoAnnouncements 骨架 + loadCninfoAnnouncements 渲染）；首页宏观卡增补 LPR(直连 axios 取 RPTA_WEB_RATE) 与社融(pbc_social_financing) 两项确定性指标。 | [20260922l] 修复「海天味业行业分析里，多个『行业板块总市值 vs 个股总市值』对比图表消失」：东财 push2 家族 clist/get 全通道被对端重置（socket hang up），使 sectorMarketCapHistory.fetchConstituents 抛错 → 三张图整体 style.display=none。① fetchConstituents 改多主机轮询重试（push2delay/push2/82.push2/16.push2 × 2 轮）；② 新增 readLatestCacheAny + staleFallback：成分股拉取失败/为空/无序列时，回退「最近一次成功快照」并标注 stale；③ 前端 renderSectorMarketCap 增「（快照）」日期角标 + 黄色告警行（.sector-cap-stale），明确「非实时、源恢复后自动更新」。 | [20260922k] 修复「宏观情绪因子写着权重自动归 0、却仍占 5%」：① macroSentimentFactors 的 observedIndex 未持久化导致「走势相悖→归零」判定被永久跳过 → 增加事件日锚定 + 旧快照自愈补锚；② marketEmotionModel.calcMacro 只看 signal 不看 status → 休眠因子回落默认 5% → 改为尊重 dormant（未激活→权重 0，常驻因子按比例吸收）；③ 卡片文案改为「按实际状态」生成（休眠/激活/中性三种措辞）。[20260922j] 因子权重调整：增持减持 +5pp（0.0485→0.0985）、大盘 −5pp（0.3071→0.2571），一增一减 Σ 仍=1.0000；权重变化由 _hashFactorStructure 自动捕获 → 旧判断强制重算。[20260922i] 修复公告漏抓（东财 /ann 端点生效 + detectForcedReduction 正则扩展覆盖真实措辞），同步 LAYOUT_VERSION=20260922c 强制重算当日判断。[20260922h] 「增持减持」因子新增第④子模块「股东被动减持/司法强制执行」(公告/新闻实时检测，确认被动减持 signal=-0.8、司法冻结/拍卖预告 -0.6，父因子叠加 0.2×forcedSignal 困境溢价)；同步升 sameDayJudgment LAYOUT_VERSION=20260922b 强制重算当日判断。 // [20260922g] 长江证券 补丁G 口径修正 + 规则4：① 废弃「历史50%分位=1.33倍」（实为2017年以来约9年长周期均值，跨周期数据混用），下轨铁底正式确认为**近5年日K真实50%分位 0.916 倍（¥6.11）**，防御说明栏改为「已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。」；② 上轨逻辑不变（动态PB锚 1.4057 > 近5年90%分位 1.165 → 估值体系重构警告继续生效）；③ 新增规则4「乐观复苏情景」：长周期均值锚 1.33 倍 × BVPS 6.67 = ¥8.87，仅当【市场日均成交额 ≥ 1.5 万亿 且 公司 ROE 持续上行】双闸门同时满足时，作为**额外情景在备注展示，不参与主模型计算**（实时读本地成交额存盘 data/sector_crowding_history.json 近20交易日日均）；④ 顺手修 nz(x, default) 单参误用（缺省值被静默吞为 0）共 6 处 ｜ [20260922g] 长江证券 补丁G 口径修正 + 规则4 // [20260922g] 长江证券 补丁G 口径修正 + 规则4：① 废弃「历史50%分位=1.33倍」（实为2017年以来约9年长周期均值，跨周期数据混用），下轨铁底正式确认为**近5年日K真实50%分位 0.916 倍（¥6.11）**，防御说明栏改为「已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。」；② 上轨逻辑不变（动态PB锚 1.4057 > 近5年90%分位 1.165 → 估值体系重构警告继续生效）；③ 新增规则4「乐观复苏情景」：长周期均值锚 1.33 倍 × BVPS 6.67 = ¥8.87，仅当【市场日均成交额 ≥ 1.5 万亿 且 公司 ROE 持续上行】双闸门同时满足时，作为**额外情景在备注展示，不参与主模型计算**（实时读本地成交额存盘 data/sector_crowding_history.json 近20交易日日均）；④ 顺手修 nz(x, default) 单参误用（缺省值被静默吞为 0）共 6 处 ｜ [20260922f] 长江证券 补丁F-Plus（单边空间展示 + SOTP偏离深度归因）+ 补丁G（动态锚双轨兜底） ｜ [20260922e] 长江证券 补丁F：估值矩阵逻辑自洽强制校验（排序/空间/基准一致性） ｜ [20260922b] 华安证券专属估值引擎升级 V3.0（指令9：核心参股资产联动监测 + SOTP权重自适应：实时抓取长鑫科技688825总市值、持股价值=长鑫市值×0.4391%×(1-流动性折扣)、参股占比驱动SOTP权重<10%→30% / 10~30%→40% / >30%→影子股模式(50%/40%/10%)+单独列示长鑫持股贡献+60日收益相关系数联动强度）；run 改为 async（实时抓取长鑫/华安总市值与日K相关性，失败回退锁定快照）。 [20260921l] 「原油主连」冲击有效期 3 天→1 天，并修正取数通道（push2delay 不可达→新浪 nf_SC0）；[20260921k] 「股份回购」完成实施/停止实施/被股东大会否决时判定转为中性（signal=0、不再计入增持家数）；[20260921j] 「股份回购」子卡片改走东财结构化回购报表（datacenter-web RPTA_WEB_GETHGLIST_NEW）：按「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素提炼（旧口径只扫公告/新闻标题、把标题原文当详情，用户看不到任何回购数据）；配套升 sameDayJudgment LAYOUT_VERSION 强制重算当日判断。 [20260921i] 「板块涨跌幅前5」也切回东财：新增东财「数据中心」通道（datacenter-web 报表 RPT_INDUSTRY_FUNDFLOW，与 push2 同为东财口径/同源板块分类），取数顺位 push2族(实时tick) → 数据中心报表(稳定可达) → 同花顺；新增 push2 失败 10 分钟静默期（首轮 2.5s → 静默期 0.3s）；面板与资金流卡现在同源同值。指数行情按用户决定保持腾讯并如实标注（无东财可达实时通道）。 [20260921h] 行业资金流改走东财「数据中心」报表源（datacenter-web 可达，push2delay 被对端重置）：恢复「散户(小单)前五」+「近5日主力/散户」，整卡统一东财口径；新增 push2 连续失败静默期（10 分钟）避免每次刷新白等。 [20260921g] 实时大盘「逐行标注数据源」：中国指数/美国指数两行补齐数据源标签，板块榜与资金流延续既有来源标注；同时修复妙想业务错误（如「积分已用完」）被静默当作「无数据」的问题。原注：[20260921c] 量价配合口径修正：大涨+平量由「显著上涨」利好改判中性「大涨平量」；同步升 LAYOUT_VERSION=20260921c 强制重算旧判断。 // [20260921b] 同步升 sameDayJudgment 的 LAYOUT_VERSION→20260921a，强制重算当日判断缓存，修复「清掉事件后个股页事件驱动卡片仍显示旧事件」。 // [20260921a] 事件驱动修正:新闻医药行拆药品/医疗器械二级(药监局药品监管不再误伤医疗器械股);圣湘生物自选归属改挂医疗器械;company_event仅按个股名匹配,停止泛化广播全行业(阳普医疗认证不再误挂圣湘生物) // [20260920a] 行业分析:新增行业景气度卡片(双轴折线,展示行业总营收TTM vs 总市值,数据=东方财富业绩报表+估值明细按申万二级全量汇总);同时移除行业分析总览卡片底部K线图 // 20260919e：修「分产品收入构成趋势」与东方财富完全对不上（用户 2026-09-19 新洋丰 000902 截图）——四处根因：① 末年 TTM 滚动还原在「上年同期无同名分部」时会把该分部静默丢弃，而只要还有任一项算得出就返回残缺清单，主力分部因此凭空显示为 0（新洋丰 磷复肥 2026=0，实际 103.56 亿、占营收 91.8%）；② TTM 本身产出东财从未公布的数值（精细化工 2026 显示 9.49 亿，东财披露 6.19 亿）；③「其中:xxx」子项被当作独立分部进入占比分母，致主营收入合计 115.44 亿（东财 112.85）→ 磷复肥占比 89.71%（东财 91.80%）；④ 图例按「首次出现顺序」截断前 8 项，把 2023/2024 的主力业务（常规复合肥 / 新型复合肥）挤出榜单。 修复：lib/deep/research.js 剔除「其中:」子项 + pageSize=500 改为分页抓全量（东财单页上限 500，新洋丰 709 条、长江证券 1719 条、平安 789 条原被静默截断，2001–2010 年数据整体丢失）；public/js/deepCharts.js 分产品趋势改为逐年原始披露口径（去 TTM）、某年未按该名称披露时留 null 断线（不再填 0 被误读为「营收为零」）、图例改按各年最大收入排序取前 8、说明文案同步更新。 修复后与东财「主营构成」页面逐点一致（新洋丰 41/41 项通过；8 只个股回归无异常），细分产品毛利率卡占比回归 91.80%/5.48%/2.33%/0.38%、合计 112.81 亿；另修一处【下发链路】隐患——public/index.html 里 js/deepCharts.js 的 ?v= 自 2026-09-06 起就停在 20260906e 从未随版本更新，且该文件不在 FRONTEND_BUST_FILES 强制刷新名单内，导致此后对 deepCharts.js 的任何改动都无法下发到浏览器（用户需手动硬刷新才生效，否则看到的仍是旧渲染逻辑）；本次一并将该戳更正为 20260919e 并把 /js/deepCharts.js 纳入强制刷新名单。 20260919d：修复「重大变化 AI 归因」长期显示「大模型请求失败（Request failed with status code 400）」——根因：归因失败/占位结果被当作有效缓存冻结 7 天（重跑深度分析也会直接复用旧失败，用户侧表现为该错误永不消失）；本次改为仅 explanationSource==='ai' 的成功结果才可复用，并重跑圣湘生物 688289 / 士兰微 600460 / 长江证券 000783 的历史失败条目；20260918b：修复「个股最大亮点/雷点无法获取数据」（用户 2026-09-18 18:16 海天味业 603288 截图）——根因：该日 17:42 ai_config.json 的「联网模型」被改为 glm-4.5-air，而阿里百炼上该模型 ① 只接受 stream:true（非流式直接 HTTP 400「This model only support stream mode」）② 不接受 enable_search（流式下以 SSE error 返回、HTTP 仍 200），叠加后所有联网类 AI 调用 5 秒内 400 失败，概览卡恒显「尚未生成」。修复：lib/ai/llm.js 新增「首见即记忆」的模型能力兼容层（STREAM_ONLY_MODELS / NO_SEARCH_PARAM_MODELS + _parseSseContent 流式解析 + _sseError 归一化 + 有界重试），默认路径请求体与历史完全一致（其他分析器零影响）；顺带修好此前被包装丢弃 err.response 而形同虚设的「400 → 去 enable_search 重试」兜底。新增 scripts/test_llm_stream_fallback.js（27 项，含桩服务端握手次数断言）。 20260918a：删除个股「短期行情判断」中「行业板块」因子的「板块成分」子卡片（用户 2026-09-18 截图要求）。该子卡片 signal=0、纯展示且父因子 detail 已含「成分 N 家」，属冗余重复，不直接参与评分，移除不影响方向/权重/得分。属展示布局调整（_hashFactorStructure 仅哈希 FACTOR_KEYS+DEFAULT_WEIGHTS、不含子因子名，不自动捕获），已手动 +1 LAYOUT_VERSION 强制重算旧判断缓存。前端 subFactors 通用循环渲染，无需改 app.js。 20260917l：修「中国平安(601318)个股亮点/雷点**长时间无法获取**」（用户 2026-09-17 20:18 截图：卡片停在「AI 正在联网重新分析…」+ 计数 0/0）。根因（服务端日志实证）：`lib/ai/llm.js` 的 `callLLM` 内部最多会**串行**发起 4 次 `postLLM`（① 妙想事实纯推理 → ② 外部搜索通道纯推理 → ③ 外部通道失败后的纯推理 → ④ 内置 enable_search），每次都用同一个 `timeoutMs` 各自做硬超时；本任务传 240s，单股最坏 ≈4×240s≈16 分钟无响应，用户侧表现就是「长时间拿不到」。601318 恰好踩中该路径（日志 `[search:mcp] 调用失败，本次仅做纯推理…：大模型请求超时（240000ms 无响应）`），而其它的股（600460/600909/000783）同期均秒级命中缓存成功，故只有这一只「永远转圈」。修复（四处，均为隔离修改）：①【核心】`lib/ai/llm.js` 新增**可选**「整链路总耗时预算」`opts.overallBudgetMs`（配套可单测纯函数 `createBudget`）：受预算约束后每次 `postLLM` 只允许用 `min(timeoutMs, 剩余预算)`，剩余不足 5s 即**秒级抛错**（`err.budgetExhausted=true`），不再无限串行等待；**不传该参数时 `enabled=false / leftMs()=Infinity / timeoutFor()=原值`，行为与历史版本完全一致**，故 companyDeep/valuation/earnings/research/announcements 等既有调用方零影响。②【接线】`lib/ai/augmentStock.js` 的 `analyzeAspects` 传 `overallBudgetMs: 300000`（单次仍可跑满 240s，累计超 300s 快速失败）。③【兜底】`analyzeAspects` 失败时若本地已有历史成功结果，直接返回并标记 `stale:true`（新增字段，向后兼容），避免用户看到空白卡片。④【等待体验】`public/js/notes.js` 的 `generateAspects` 补三件事：状态栏每秒刷新「已等待 N 秒」（不再像卡死）、客户端 330s `AbortController` 硬超时（比后端预算多 30s 余量）、超时/失败给出可执行提示；并对 `stale` 回退显示「本次超时/失败，已回退上一次成功结果（时间）」。另修：`lib/macroNews.js` 的 `_localDate` 未定义回归（该文件只导入了 `localDate` 无别名，`localToday()` 却调用 `_localDate()` → 每次调用抛 `ReferenceError: _localDate is not defined`，首页宏观新闻长期取不到）→ 改回 `localDate()`。 20260917k：亮点/雷点「只累积、需手动清理」口径正式落地 + 🤖 AI 徽标修复（用户 2026-09-17 明确选择「只累积、需手动清理」，否决「生成时自动替换旧 AI 条目」方案）——背景：上一条(20260917j)排查中发现 `add()` 漏拷 `ai` 字段，导致 ①🤖 AI 徽标永不显示、②`generateAspects` 里「生成前先清除本股旧 AI 条目」的过滤条件 `n.ai === true` 永远匹配不到（所以实际表现一直是「只追加不清旧」，但属于**意外的**行为）。本次把该行为**显式化并锁定**：①【口径锁定】`generateAspects` **删除**「先清除旧 AI 条目」整段逻辑，改为只统计 `existingAi` 数（不删任何数据），AI 状态提示改为「该股原有 N 条 AI 条目已保留，如需精简可点『🧹 清理重复』」—— 即用户要的「只累积、需手动清理」；代码注释写明「若将来要改回自动替换，必须先征得用户同意」，并新增断言防止回退。②【徽标修复】`renderNoteCard` 的 🤖 判定改为 `note.ai === true || note.type === 'ai'`，使**历史条目也立即恢复显示** 🤖（`data/notes.json` 中 34 条 AI 条目本就有 `type:'ai'`，**无需数据迁移**）。③【字段补全】`add()` 补落 `ai: note.ai === true`，让今后数据自带真实来源标记（**仅用于展示/追溯，不用于自动删除**）。回归测试 `scripts/test_notes_scope_switch.js` 扩展至 **34/34**：新增 §7（历史条目徽标 + 手动录入不误标）、§8（**口径锁定**：生成后原有亮点/雷点一条未删、仅 +1 新增；新条目 `ai` 已落盘）。只改 `public/js/notes.js` 一个文件（隔离修改，服务端 `/api/notes` 契约与 `data/notes.json` 结构均未变）。 20260917j：修「个股亮点/雷点不随个股页面切换」（用户 2026-09-17 截图反馈：页面为华安证券 600909，卡片却全是士兰微 600460 的内容）——根因：`public/js/notes.js` 的 AI 生成 fetch 明确「不随标签页/个股切换取消」（原注释即如此设计），等待期间用户切到别的个股后，回调里的 `this.renderStock(旧symbol)` 会把 `#stockNotesContainer` 刷成上一只股票的亮点/雷点，且此后不会再被纠正（该容器仅在 activeTab==='journal' 时重渲染）。实测吻合：`data/notes.json` 中 600460 恰为 3 亮点 + 5 雷点（= 截图计数），600909 为 0 条，证明容器停留在 600460 的渲染结果。修复（症状级 + 机制级双保险）：①【机制】`notes.js` 新增防串股守卫 `_currentStockCode()/_isCurrentStock()/renderStockIfCurrent()`，凡「目标股票未必等于当前展示股票」的重渲染一律走守卫 —— 覆盖 `generateAspects`（3 处回调 + AI 状态条 + 按钮复位）、`setAsMain`、`confirmDelete`、`saveForm`；非当前股票一律丢弃，不再污染其他个股页面（`renderStock` 本身不加守卫，保持既有契约）。②【症状】`app.js` 的 `analyze()` 在 `window.currentStock` 赋值处（当前个股唯一变更点）立即用新个股重渲染亮点/雷点，不再依赖「恰好停在 journal tab」；③ `generateAspects` 的并发锁由「全局单锁」改为「按股票隔离」（原先 A 股在跑时切到 B 股点生成会被静默 return，按钮看着可用却没反应，同属「不跟随个股切换」）；④ 切股后即使 AI 回调抵达，也只在仍停留该股页面时才刷新 AI 状态条与按钮，避免改到别的股票的界面。新增回归测试 `scripts/test_notes_scope_switch.js`（25/25，用最小 DOM 桩驱动真实 notes.js；含「裸 renderStock 确实会覆盖当前页」的旧行为复现对照，证明守卫是承重的）。注：本次只改前端 2 个文件，`/api/notes` 返回全量由前端按 scope 过滤的既有契约未变（隔离修改）。 20260917i：个股页「短期判断」卡片重组（用户 2026-09-17 要求，5 卡 → 7 因子重构）——①「市场情绪与消息面」改名「大盘」：删除「消息情绪（大盘）」「涨跌停比」两个子因子**及其底层逻辑**，同位置新增「市场情绪提醒」子因子（**直接引用首页判断**：读 data/market-emotion 落盘，同源不重算，非二次计算），并迁入原「大盘及行业板块短期走势」下的「大盘短期走势」；保留「内幕抢跑预警」「全网舆情」。②「板块涨跌停占比」改名「行业板块」（key sectorLimit 不变）：迁入「板块消息」与原「行业板块」因子（**改名为「行业短期走势」**），保留涨停/跌停占比、板块成分。③「大盘及行业板块短期走势」**整卡删除**（原因子 key market 移除）。④「财报解读」「舆情与讨论热度（个股）」两因子迁入「个股短期动向」。⑤ 权重处理：删除 market 后其余 7 因子**等比放大至 Σ=1.0000**；被迁入的子因子**参与评分**（子权重 MARKET_SHORT_SUB_W / SECTOR_TREND_SUB_W / SECTOR_NEWS_SUB_W / LIMIT_SUB_W / EMOTION_SUB_W / STOCK_SENT_SUB_W / EARN_SUB_W / SHORT_DIR_SUB_W），各 factor* 函数一律引用 W_* 常量、不再内嵌字面量。⑥ 缓存失效：LAYOUT_VERSION → 20260917i；因子结构变化（market 移除）由 _hashFactorStructure() **自动捕获**（SCHEMA_VERSION=h1f4df388-20260917i）→ 旧 data/judgments/*.json 判「旧 schema」强制重算，重启即生效。配套改动：lib/marketEmotionModel.js 新增导出 readLatestJudgment() 并补写记录字段 tendencyKey/coreDriver/advice/riskTip（供个股页单源引用首页结论）；public/js/app.js _renderSameDayLogicHtml 的 FACTOR_ORDER 去掉 market 并重排。E2E 实测（603288 海天味业）：7 基础因子 + 事件驱动共 8 因子、权重合计 100.0000%、「大盘」内含「市场情绪提醒=看跌·预警」与首页 /api/sentiment-turning-point 结论一致。回归全绿：test_factor_direction 41/41（新增第 4 节拆分校验）、test_local_date 12/12、test_tz_smoke 23/23、test_market_emotion 31/31、test_news_time 19/19、test_hot_topics_consistency 11/11、test_shareholder_period 10/10、test_sanxi_selling_expense 32/32、test_news_sector_scoring 17/17、test_event_weight_sentiment_acc 31/31；6 个文件 node --check 通过。顺带修掉 scripts/test_factor_direction.js 两处测试基建缺陷：'localDate' 与 require 解构重名导致 SyntaxError（源码里它是委托壳且引用未注入的 _localDate）、FACTOR_NAME 未注入沙箱导致 ReferenceError。 20260917h：修「今日财经热点」卡片数据源与时间口径（2026-09-17 抓真实响应核对后执行）——(1)【数据源已下线、静默失败】旧接口 https://newsapi.eastmoney.com/kuaixun/v1/getlist 实测返回 404，lib/newsSearch.js fetchKuaixunNews() 因 axios 抛错被 try/catch 吞掉、**永远返回 []**，卡片实际长期靠 fetchEastmoneyContentNews 兜底撑着；现改走 https://np-listapi.eastmoney.com/comm/web/getFastNewsList（client=web&biz=web_724&fastColumn=102），响应结构 data.fastNewsList[]。(2)【时间字段口径修正】新接口条目**没有** datetime 字段，实际是 showTime（北京墙钟字符串 "YYYY-MM-DD HH:mm:ss"）＋ realSort（微秒级**真 epoch**，实测 1789642048033848；/1e6 后按 Asia/Shanghai 渲染与 showTime 逐条一致）；旧代码把真 epoch 交给 `new Date(ts).toISOString()` 渲染 → toISOString 输出 UTC，展示时间比北京时间**早 8 小时**；现新增 normalizeNewsTime() 统一归一化（兼容北京墙钟字符串、ISO-T、以及秒/毫秒/微秒三种精度 epoch；脏字符串一律返回空串，避免垃圾字符被当时间展示），一律按北京时间渲染。(3)【原文深链缺失】新接口不含 url，现用 code 合成 https://finance.eastmoney.com/a/{code}.html（实测 200 可访问），卡片条目恢复可点击跳原文。(4)【摘要去重】新接口 summary 常以「【标题】正文」开头重复标题，现自动剥掉该前缀。返回对象字段仍为 { title, summary, source, url, date }，**下游卡片/影响标注模块无需改动**（隔离修改）。新增回归测试 scripts/test_news_time.js（19/19，含「旧 UTC 渲染提前 8 小时」的 bug 复现对照）；scripts/test_local_date.js 12/12、scripts/test_tz_smoke.js 23/23、scripts/test_market_emotion.js 31/31 均通过。 20260917g：全项目统一「中国自然日」日期口径，修掉 UTC 跨日错位（新增 lib/localDate.js + 回归测试 scripts/test_local_date.js 12/12、scripts/test_market_emotion.js 31/31）——根因：`new Date().toISOString().slice(0,10)` 取的是 **UTC 日期**，在 UTC+8 下每天北京时间 00:00–07:59 会比北京日期晚一天，导致交易台账/事件/缓存 的「今天」写成昨天（记录错位、幂等失效），估值基准日、板块快照日期、新闻日期也整体前移一天；白天 08:00 后两者一致，故长期隐蔽。新增 lib/localDate.js（Intl + Asia/Shanghai + formatToParts，hourCycle h23，**不依赖宿主机时区**；提供 localDate / localDateTime / localCompact / localDateFromTs；月/毫秒时间戳自动识别）。已改造 20 个文件：lib/eventEngine.js(4)、lib/factStore.js、lib/hotTopics.js(3，含 ctime 秒级时间戳→北京日)、lib/marketTechnical.js、lib/sectorCapitalFlow.js(2)、lib/stockData.js(4，含东财 beg/end 的 YYYYMMDD 参数)、lib/sentimentTurningPoint.js、lib/deep/conclusion.js、lib/deep/research.js(3，含把原本手写 +8h 的等价写法统一)、lib/cnscraperAdapter.js、lib/ai/valuation.js、server.js、scripts/test_factor_direction.js，以及 3 只个股估值模型的「估值基准日」(海天603288/华安600909/新洋丰000902)。同时把 4 处既有的手写 localDate 实现（sameDayJudgment / marketSentimentIndex / marketEmotionModel / macroNews.localToday）统一委托给 lib/localDate.js——scripts/test_local_date.js 用 2000 个采样点证明委托前后**逐点等价**（UTC+8 宿主机），故不改变既有行为。**刻意未改**：lib/stockData.js:985 的 Yahoo 日线日期（美股日线时间戳按 UTC 表示才是正确交易日）、以及全部 `date: new Date().toISOString()` 形式的绝对时间戳（本就是瞬时值，非日历日）。20260917f：修「股吧讨论热度（散户情绪）」因子三处问题（由用户确认后执行，回归测试 31/31 通过）——(1)【修陈旧值静默使用】server.js readMsiHeat() 会回退到「最后一条含 marketHeat 的记录」，而 marketEmotionModel.calcDiscussionHeat 只取数值、不比对日期，遇到 MSI 当天缺 marketHeat（实测缺 2026-09-10 / 09-16）就把上一天的旧值当"今天"用，且不打 spec §九 的滞后折扣；现新增 tradingLagDays()（以上证 bars 日期为交易日历）：同日=正常、滞后 1~2 个交易日=打 8 折并标「⏱ 数据滞后 N 个交易日」、滞后 ≥3 个交易日（LAG_DEGRADE_DAYS）=降级归零并分摊、日期缺失=按剔除处理（不再静默当今日）；快照 upsertSnapshot 也只在 lagDays===0 时记 heat，避免把旧值挂到新日期污染分位历史。(2)【补回来源标注】lib/marketSentimentIndex.js recordDailySnapshot 原先只持久化 {key,label,signal,weight}，把 value/detail 丢掉，导致任何「读序列」的消费方都拿不到数据源/样本数/更新时间/看多占比；现一并持久化，readMsiHeat() 透传，卡片「股吧讨论热度」明细恢复完整来源标注（兜底实时抓取路径也补齐同样格式）。(3)【分位样本交易日过滤】热度历史里混有非交易日读数（实测 series.json 26 条里 7 条是周末），会稀释历史分位；现用上证 bars 的日期白名单过滤，并在明细标注「已滤除 N 个非交易日样本」。另：marketEmotionModel 新增 SA_MSI_SERIES 环境变量出口，使回归测试不再读取生产 series.json（完全隔离）。20260917e：修复「大盘量能情绪模型」两处权重硬约束漏洞（scripts/test_market_emotion.js 22/22 通过）——(1) computeWeights 原样采用 state.weights 里自学习后的常驻权重，未做 5%~30% 夹紧；(2) 因子降级后的「按比例分摊」（spec §八.4）只做普通归一，会把已顶到 30% 上限的因子再次顶出（实测量能活跃度被摊到 34.47%）。修复：新增有界缩放 scaleBounded（等比缩放 + 溢出量按比例转嫁给仍自由的因子），computeWeights 与降级分摊两处统一走它；非常驻因子激活时若事件残留 {status:'dormant',weight:0} 则回落基准权重（原逻辑会把刚激活的因子压成 0）；可用因子过少导致 5%~30% 区间装不下 100% 时按需平移边界，并在 dataNote 诚实标注「权重被迫越界 · 本日结论置信度偏低」。20260917d：首页「市场情绪提醒」卡片逻辑模型整体升级为「大盘量能情绪分析模型（完整版）」——新增 lib/marketEmotionModel.js（10 因子确定性计算引擎：量能活跃度/市场宽度与极端情绪/量价配合度/大盘涨跌势头/融资余额/主力资金流向/股吧讨论热度(反向)/避险情绪 8 常驻 + 国内宏观/美国宏观 2 非常驻；含动态权重归一化、非常驻 0.8/日衰减、自学习(20次样本门槛·>60%上调<45%下调·常驻权重5%~30%边界)、极端值剔除+双基准(20日均量+1年分位)、市场风格自适应、数据源异常自检与权重分摊、月度健康度报告、极端行情熔断、月末/季末修正、T+1/T+3/T+5 准确率台账）+ lib/marketEmotionData.js（数据采集层：scripts/market_emotion.py 一次取全上证量价/涨跌家数涨跌停/融资余额5日/大盘主力净额/成交额换手率集中度/美元离岸人民币/中债10年）+ 前端 _renderEmotionPanel 按「情绪总分/短期倾向/核心驱动/量能状态/操作建议/风险提示」六行结论渲染；个股页 /api/sentiment-turning-point/:symbol 仍走原拐点检测逻辑不受影响。20260917c：修复「大盘技术分析准确率只停留在 9/15」——根因是 server.js 的 /api/market-technical 路由里调用了 marketClosed() 但**从未从 sameDayJudgment 导入该函数**，命中 ReferenceError 后被外层 catch(e){} 静默吞掉，导致「收盘后落盘当日判断」常年不写文件（data/market-tech/ 仅剩早期手工写入的 2026-09-14.json）；同时原实现只在「用户打开首页」时才落盘、无定时器兜底。修复：(1) 补上 marketClosed 导入；(2) 路由落盘失败改为显式 console.error 不再静默；(3) 新增每交易日 15:30 后自动落盘任务（不依赖用户打开页面），与个股结算调度同源。已实测路由与调度器两条路径均能写入 2026-09-17.json。20260917b：在 20260917a 基础上，进一步修复「个别股亮点/雷点长时间无法获取/卡死」——(1) lib/ai/llm.js postLLM（大模型调用）同样强制 adapter:'http' + 手动 setTimeout 兜底（原无 adapter 导致命中 fetch adapter 静默丢弃 timeout，卡到 60s 才以「timeout of 60000ms exceeded」报错，且被 mxQuery 外层 try/catch 误标为妙想失败）；(2) 亮点/雷点 timeoutMs 由 60s 放宽至 240s（qwen3.5-35b-a3b 实测单股 90~133s），与 companyDeep 一致；(3) 分离「妙想抓取」与「大模型推理」的异常捕获，LLM 超时不再误报为妙想失败。20260917a：修复两处 AI 配置/联网稳定性问题 —— (1) lib/miaoxiang.js 妙想（东财）请求改用 axios 直连 + 强制 adapter:'http' + 手动 setTimeout 竞速兜底 15s（本环境全局 fetch 是 axios 多填实现、自带 60s 内部超时且忽略 AbortSignal，axios 命中 https 会切 fetch adapter 导致 timeout 被静默丢弃、请求卡到 60s 才以「timeout of 60000ms exceeded」绕过 try/catch），妙想慢/不通即 15s 内快速失败并回退阿里百炼 MCP 搜索，根治「AI 生成亮点/雷点」永久卡「分析中…」；(2) 前端 openAISettings 打开前强制重新拉取服务端配置，修复偶发误显示「尚未配置 API Key / 内置联网搜索」（init 时 loadAIConfig 未 await 完成导致 this.aiConfig 为旧值）。20260916h：修复新洋丰（000902）顶部「综合估值评级」卡片口径 —— lib/deep/conclusion.js 原缺 000902 分支（9 个 if(sym===) 里没它），导致掉入通用「PE估值带」逻辑，产出 ¥13.26~¥24.84 / 中枢 ¥19.05，与下方专属卡（16.93 / 13.38~20.43）打架；现补上 xinyangfeng000902 分支（方法 chips 改为 正常化PE(锚)/PB-ROE交叉/DCF参考/磷矿资源期权(独立)/三情景加权），顶部卡与专属卡口径统一。20260916g：新增新洋丰（000902）专属「永久逻辑」估值引擎——正常化盈利为锚（禁单一年份PE）+ 分部估值(A正常化PE75%/B PB-ROE15%/C DCF10%/D磷矿资源期权独立/E磷酸铁期权) + 三情景 + 敏感性 + 四项失效预警，确定性计算无LLM；前端 app.js 增加 xinyangfeng 卡片分支并登记 _isDedicated。20260916e：修复「图表渲染失败」——ECharts 由 CDN(jsdelivr) 改为本地随包加载（public/vendor/echarts.min.js，CDN 仅作回退），根治国内网络下 CDN 被墙/超时导致所有图表报「图表渲染失败」；industryCharts _initChart 增加「图库未就绪时轮询等待 + 缺失时给可诊断提示」；capitalCharts 5 处裸 echarts.init 加 _safeInit 容错（不再因图库缺失中断整页渲染）；/js/capitalCharts.js 纳入缓存破坏。20260916d：个股亮点/雷点 AI 财务数字治理 —— 给 analyzeAspects 注入与「基本面」卡片同源的东方财富 F10 权威财务快照（资产负债率/毛利率/净利率/营收同比/归母净利及同比/流动比率），并新增后置数字校验：AI 输出的资产负债率绝对数值若与权威值偏差 > 1 个百分点，直接修正为权威值，杜绝凭空编造（如新洋丰 000902 资产负债率被写成 48.60%，实际 39.76%）。20260916c：后台计费治理 —— (A) 新增后台 AI 总开关 SA_NO_BG_AI（start.vbs 默认置 1），禁用两个后台 LLM 定时任务（事件驱动扫描 eventEngine + 专属因子月度触发），用户手动点开个股页的 AI 功能不受影响；(B) 封堵 callLLM 静默回退暗道：searchMode 为 mcp/volc/baidu 外部通道且失败/无 Key 时，不再升级 LLM 内置 enable_search（不再绕过免费 MCP 额度自行上网），统一降级纯推理。20260916b：个股亮点/雷点（含投资心得/大盘记录）数据改为服务端持久化（data/notes.json），不再仅存 localStorage —— 硬刷新清缓存 / 代码更新都不会丢失手动录入数据；并移除每次加载时的「内容相似自动去重」，避免误删手动条目（清理重复改由「🧹 清理重复」按钮手动触发）。20260916a：行业分析页「板块总市值走势」统一模板 —— 每只个股分别与所属申万一级/二级/三级行业板块总市值做双坐标走势比对（三张图，无三级板块自动省略）；新增 GET /api/stock-sector-levels/:symbol（东财个股所属板块 slist spt=3 + parseSwSectorName 归类一/二/三级）。20260915d：宏观情绪两因子并入市场情绪统一权重池（国内0.10/美国0.10，原6因子压缩至80%），共同决定短期倾向；移除独立区块；20260915c：每日宏观卡片新增社零/固定资产投资实时抓取（工业增加值无活源→降级占位）+ 国际经济事件卡片（FOMC 9/17 等策划式）+ 市场情绪提醒新增两个非常驻宏观因子小卡片（国内经济/美国经济，等权 0.5，指数相悖则权重归0）；20260915a：公司概况与 sameDay 行业板块因子统一用 sectorIdentity 精确行业（修 688660 电气风电被 F10 CSRC 错配为通用设备）+ companyDeep 长文本卡片截断修复（chart-card max-height 4000px→99999px）+ 信息分析配图禁用 Wikimedia Commons 兜底（避免产品/竞争对手图片全部不相关）；20260914j：事件驱动修行业误配（智能家居补贴不再归食品饮料）+ 权重重设（重大40%/中度12%/轻微3%，封顶40%）+ 删除卡片外重复白字 + 准确率页新增「短期行情判断」「市场情绪提醒」两个 tab；20260914i：大盘技术分析 + 个股技术面新增「准确率检查」（每日留档 + 事后验证 + 卡片内嵌 + 独立核对页 accuracy.html）；20260914h：信息分析（CFA 七段）改为「固定联网模型 + 永久缓存」并补齐本地资料自动加载；20260914g：信息分析卡片改名（「公司深度分析（CFA）」→「信息分析」）+ 联网超时 60s→240s；20260914f：三模块合并为单一 companyDeep.js（七段统一输出）；20260914e：大盘技术分析六步 + 短线结构研判合并为 lib/marketTechnical.js 融合引擎（七步推演，移除 /api/short-term-market）。 ★20260920a：万润股份（002643）专属「永久逻辑」估值引擎上线——data/valuation/002643.json(kind=wanrun)+lib/valuation/wanrun002643.js（三层加权 PB-ROE50%/PE35%/DCF15% + 五业务单元叙事 + 防失真规则）；接线 lib/ai/valuation.js 分发块+hasDedicatedValuation、public/js/app.js _isDedicated 白名单+wanrun 卡片、lib/deep/conclusion.js 顶部综合卡分支（替换旧通用「PE估值带」模型：由 高估/中枢8.71 纠正为 合理/中枢18.55）。
app.use((req, res, next) => {
  if ((req.path === '/' || req.path === '/index.html') && req.query.v !== APP_VERSION) {
    return res.redirect(`/index.html?v=${APP_VERSION}`);
  }
  next();
});

// 关键前端资源：强制 ?v= 与 APP_VERSION 一致，避免浏览器沿用旧版本
// 用户反复反馈「页面像旧版数据」时，多数是因为老 URL 命中 etag 304 后还返回缓存的旧 JS。
// 这里主动 redirect 到带正确版本号的 URL，配合 Cache-Control: no-store 一起兜底。
const FRONTEND_BUST_FILES = new Set(['/js/app.js', '/css/style.css', '/js/backtestUI.js', '/js/industryCharts.js', '/js/notes.js', '/js/capitalCharts.js', '/js/deepCharts.js', '/js/accuracy.js', '/js/shareholderCharts.js', '/js/chartTheme.js', '/js/charts.js', '/js/chart3D.js', '/js/logicModel.js', '/js/homeMacro.js', '/icon.png']);
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

// 轻量健康检查（看门狗 / 冒烟测试用）：不探测外呼，避免慢。
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    // 20261016b（审计 G5）：估值模型哈希，深度分析缓存门控键之一；变化即触发旧缓存失效重算
    valuationModelHash: VALUATION_MODEL_HASH,
    uptime: Math.round(process.uptime()),
    mem: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

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
    // 20261020l：⑤「关键位有效性检验」卡与路由注入已下线（用户要求删除该模块及其联动）。
    res.json({ success: true, symbol, accuracy, ...data });
  } catch (err) {
    console.error('PriceAction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20261021d：个股「手动阻力/支撑区间」（②卡「手动添加」页签）
// 口径：用户自填，**不参与**模型的有效性检验/侵蚀，也不影响方向判断与准确率统计（lib/manualZones.js 头注释）。
app.get('/api/manual-zones/:symbol', (req, res) => {
  try {
    res.json({ success: true, ...manualZones.listZones(req.params.symbol) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/manual-zones/:symbol', (req, res) => {
  try {
    const r = manualZones.addZone(req.params.symbol, req.body || {});
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    // 20261021e：手动区间已并入 /api/price-action 的短期清单（并走两条有效性检验），
    // 新增后必须丢缓存，否则快照里还是旧的那一份，用户加完看不到。
    invalidateSnapshot(r.data.symbol);
    // 20261024h：源模块变动 → 自动通知联动模块（priceActionHub 丢快照 → sameDayJudgment 连带作废判断）
    moduleSync.emitChange('manualZones', { symbols: [r.data.symbol], reason: '手动区间新增' });
    res.json({ success: true, zone: r.zone, ...r.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete('/api/manual-zones/:symbol/:id', (req, res) => {
  try {
    const r = manualZones.removeZone(req.params.symbol, req.params.id);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    invalidateSnapshot(r.data.symbol);   // 同上：删完不能还留在快照里
    moduleSync.emitChange('manualZones', { symbols: [r.data.symbol], reason: '手动区间删除' });
    res.json({ success: true, removed: r.removed, ...r.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20261025l：个股记录（个股页「个股记录」tab，用户要求）——按日期排序的手动记录，
// 落盘 data/stock-log/<代码>.json；纯手动记录，不参与任何判断/评分/回测，不触发模块联动。
const stockLog = require('./lib/stockLog');
app.get('/api/stock-log/:symbol', (req, res) => {
  try {
    res.json({ success: true, ...stockLog.listLog(req.params.symbol) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/stock-log/:symbol', (req, res) => {
  try {
    const r = stockLog.addLog(req.params.symbol, req.body || {});
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true, item: r.item });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete('/api/stock-log/:symbol/:id', (req, res) => {
  try {
    const r = stockLog.removeLog(req.params.symbol, req.params.id);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 20261026e：修改记录（用户要求每条记录带「修改」按钮）——可改日期与内容
app.put('/api/stock-log/:symbol/:id', (req, res) => {
  try {
    const r = stockLog.updateLog(req.params.symbol, req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true, item: r.item });
  } catch (err) {
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
      const recs = techFaceJudgment.readAll(s);
      const a = techFaceJudgment.computeAccuracy(s);
      // 20260928c：聚合行补「最新判断日 + 数据区间」（口径与「各股短期判断准确率」一致，展示一致性）
      const dates = recs.map(r => r.baseDate).filter(Boolean).sort();
      return {
        ...a,
        name: (recs.slice(-1)[0] || {}).name || '',
        minDate: dates[0] || '',
        maxDate: dates.slice(-1)[0] || '',
      };
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
    const { minutes, prevClose, date } = await fetchTencentMinutes(info.tencentCode);
    // date = 这份分时所属交易日（休市时是上一交易日），前端据此诚实标注，不冒充今日走势
    res.json({ success: true, symbol: req.params.symbol, minutes, prevClose, minuteDate: date });
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
      // 20261016 D2（用户批准方案②）：板块映射当前只覆盖 N 个行业，表外新闻一律无影响标注。
      // 前端脚注据此明示覆盖范围，避免用户把「无标注」误读为「无影响」。
      data.sectorMapCount = NEWS_SECTOR_MAP.length;
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
    // 20261013c：先触发自动抓取（华尔街见闻三值为主 + FedRateCalc 排期兜底；12h TTL，失败回退缓存/内置清单）
    const cal = await refreshUsMacroEvents({ force: req.query.refresh === '1' });
    const events = getUsMacroEvents();
    // 空清单时给诚实 notice（全部过期或双源失败且无兜底），前端据此显示空态而非静默隐藏
    const notice = events.length
      ? ''
      : '美国宏观数据排期自动抓取失败且内置清单已全部过期，待数据源恢复后自动更新。';
    const calSource = cal && cal.ok
      ? (cal.stale ? '自动抓取（陈旧缓存，源暂不可达）' : (cal.hasResults ? '自动抓取（华尔街见闻·含公布/预期/前值）' : '自动抓取（FedRateCalc 排期）'))
      : '策划式清单兜底（自动抓取不可达）';
    res.json({ success: true, events, notice, source: calSource, updated: new Date().toISOString() });
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

// 个股量化策略虚拟盘风控校验（POST：接收 DSL / 区间 / 标的，返回结构化校验 JSON）
app.post('/api/backtest-validate', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.symbol && !(body.dsl && (body.dsl.symbols || (body.dsl.symbol)))) {
      return res.status(400).json({ error: '缺少标的 symbol 或 DSL.symbols' });
    }
    const result = await validateStrategy({
      symbol: body.symbol,
      name: body.name,
      dsl: body.dsl
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Backtest validate error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 自动策略生成（POST：仅需标的 + 区间，无需用户 DSL；代码确定性生成并校验）
app.post('/api/auto-strategy', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.symbol) return res.status(400).json({ error: '缺少标的 symbol' });
    const result = await generateStrategies({
      symbol: body.symbol,
      name: body.name,
      range: body.range || '3y',
      skipLLM: !!body.skipLLM
    });
    res.json(result);
  } catch (err) {
    console.error('Auto strategy error:', err);
    res.status(500).json({ success: false, error: err.message });
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

// 首页·大盘技术分析：上证/深证/创业板指 收盘后七步技术面推演（融合版：趋势/量价/指标/周期/短线/外部/综合决策）
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
    // 20261021c：读取即结算（3 分钟节流）。此前该接口只读不算，用户看到的「待验证/过期未结算」
    // 必须点进「准确率核对」再手动结算才会推进，观感上就是「老是结算不了」。
    else await marketTechJudgment.settleIfDue();
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
// 首页全局预警条用：全市场级，不依赖个股。9 因子确定性计算，无 LLM。
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
          detail: `讨论综合得分 ${ms.marketAvgScore != null ? ms.marketAvgScore : '—'}、看多占比 ${ms.marketUpRatio != null ? Math.round(ms.marketUpRatio * 100) + '%' : '—'}（数据源：${ms.coverage || '东财股吧'}${typeof ms.sampleCount === 'number' ? `，样本 ${ms.sampleCount} 只` : ''}${ms.updatedAt ? `，更新于 ${ms.updatedAt}` : ''}；⚠️ MSI 序列缺失，本条以「中国平安」单股股吧代理全市场讨论热度，口径偏保守，仅作降级参考）`,
        };
      }
    } catch (e) { /* best-effort */ }
  }
  if (heat) data.discussionHeat = heat;
  // 宽基 ETF 申购赎回（20261022h）：独立异步，超时/失败只让该因子降级，不拖垮情绪模型
  let etfFlowRes = null;
  try {
    etfFlowRes = await Promise.race([
      etfFlow.getEtfFlow({ refresh: !!refresh }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('宽基 ETF 申赎取数超时 20s')), 20000)),
    ]);
    if (etfFlowRes && etfFlowRes.factor) {
      data.etfFlow = Object.assign({}, etfFlowRes.factor, { date: etfFlowRes.date });
    }
  } catch (e) {
    console.error('[MarketEmotion] 宽基 ETF 申赎取数失败:', e && e.message);
    data.etfFlow = { score: 0, degraded: true, reason: `宽基 ETF 申赎取数失败：${e && e.message ? e.message : e}` };
  }
  let macro = [];
  try {
    const shHistory = ((data.index && data.index.bars) || []).map(b => ({ date: b.date, close: b.close }));
    macro = await computeMacroFactors({ shHistory });
  } catch (e) { console.error('[MarketEmotion] 宏观因子计算失败:', e && e.message); }
  return marketEmotionModel.computeMarketEmotion({ data, macroFactors: macro });
}

/**
 * 宽基 ETF 申购赎回明细（20261022h）—— 首页情绪面板「ETF 申赎」页签数据源。
 * 与情绪模型的因子同源（lib/etfFlow 内有 3 分钟内存 memo + in-flight 去重），
 * 因此面板刷新与页签展开不会重复打上交所接口。
 */
app.get('/api/etf-flow', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.force === '1';
    const r = await etfFlow.getEtfFlow({ refresh });
    res.json({
      ok: !!r.ok,
      date: r.date || null,
      baseDate: r.baseDate || null,
      settled: r.settled != null ? r.settled : null,
      baselineOnly: !!r.baselineOnly,
      reason: r.reason || null,
      factor: r.factor || null,
      gaps: r.gaps || [],
      fromMemo: !!r.fromMemo,
      summary: r.detail ? {
        totalNet: r.detail.totalNet,
        pricedCount: r.detail.pricedCount,
        ledgerDays: r.detail.ledgerDays,
        ledgerDate: r.detail.ledgerDate,
        groups: r.detail.groups || [],
        etfCount: (r.detail.etfs || []).length,
        stockCount: (r.detail.stocks || []).length,
      } : null,
      etfs: (r.detail && r.detail.etfs) || [],
      stocks: (r.detail && r.detail.stocks) || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

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
app.use(moduleSyncRoutes); // 20261024h：模块联动应答机制（依赖图 / 同步信号 / 手动触发）

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

// ---- 估值模型版本哈希（20261016b 审计 G5）----
// 问题：深度分析磁盘缓存此前只按 APP_VERSION 门控。若只改了估值模型逻辑（评级阈值、方法增删、
// 专属模型口径）而忘了升 APP_VERSION，旧估值结论会被缓存长期复用，用户看到的是过期结论。
// 方案：对估值链路相关文件内容做 FNV-1a 哈希并参与门控——任一估值文件变动即自动失效重算，
// 不依赖人工记得升版本号。文件缺失/读取失败降级计入哈希，绝不阻断服务。
const VALUATION_MODEL_FILES = [
  'lib/ai/valuation.js', 'lib/ai/cache.js', 'lib/valuationHub.js',
  'lib/deep/conclusion.js', 'lib/insuranceAnalysis.js', 'lib/analysis.js',
];
function computeValuationModelHash() {
  const files = VALUATION_MODEL_FILES.slice();
  try {
    // 专属估值模型目录：新增/修改任一模型自动纳入
    const dir = path.join(__dirname, 'lib', 'valuation');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) files.push('lib/valuation/' + f);
    }
  } catch (e) {
    // 不静默吞错：目录读不到说明专属估值模型缺失，属异常情况，必须留痕
    console.warn('[估值哈希] 读取 lib/valuation 目录失败，该目录未纳入哈希：', e.message);
  }
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  };
  for (const rel of files.sort()) {
    try {
      feed(rel);
      feed(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    } catch (e) {
      feed(rel + ':UNREADABLE');
    }
  }
  return 'vmh' + h.toString(16);
}
const VALUATION_MODEL_HASH = computeValuationModelHash();

function readAnalysisCache(symbol) {
  try {
    const p = getAnalysisCachePath(symbol);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 版本门控：缓存由旧版本代码写入（无 appVersion 或版本不符）时视为失效，
      // 强制按新版本重新生成，避免升级后用户仍看到旧结构（如缺失新增字段）。
      // 估值模型哈希门控（G5）：估值链路任一文件变动即失效，防止「改了模型但没升版本号」导致旧估值结论被复用。
      if (obj && obj.appVersion === APP_VERSION
        && obj.valuationModelHash === VALUATION_MODEL_HASH
        && isAnalysisCacheValid(obj)) return obj;
      const why = (!obj || obj.appVersion !== APP_VERSION) ? 'version mismatch'
        : obj.valuationModelHash !== VALUATION_MODEL_HASH ? 'valuation model changed' : 'empty core data';
      console.log(`[Cache] invalidating ${symbol} (${why})`);
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
    // 20261016b（审计 G5）：随缓存写入估值模型哈希，供 readAnalysisCache 门控比对
    result.valuationModelHash = VALUATION_MODEL_HASH;
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
// 20261021k 重构为「服务端后台常驻任务」模型（用户诉求：① 切页/断连不中断；② 跑完落盘缓存；③ 前端轮询秒回状态）：
// - 磁盘缓存命中且非强制刷新 → 立即返回（秒回，不进后台）。
// - 无缓存 → 启动一个**脱离 HTTP 请求生命周期**的后台任务（detached Promise），客户端断开也不影响；
//   完成时写磁盘缓存并标记 status=done。同一 symbol 并发/轮询复用同一任务对象，绝不重复计算。
// - 内部总超时放宽到 280s（财报解读子任务单项即可达 180s，旧 55s 硬超时会让慢分析永远不落盘）。
// 与旧「在途 Promise 去重」同目标但更彻底：旧版在客户端断开后若 >55s 超时则直接 500 且不写缓存，本版保证跑完必落盘。
const _deepJobs = new Map(); // symbol -> { status, startedAt, finishedAt, result, error, forceRefresh }

async function _runDeepAnalysisOnce(symbol, name) {
  // Fetch quote and history in parallel
  const [quote, history] = await Promise.all([
    getQuote(symbol),
    getHistory(symbol, 'daily').catch(() => []),
  ]);
  if (!quote) return { __notFound: true };
  // 内部总超时兜底（仅防外部接口永久挂起；放宽到 280s，远低于 _deepJobs 的 300s 安全网）
  const result = await Promise.race([
    deepAnalysis(symbol, name || quote.name, quote, history),
    new Promise((_, reject) => setTimeout(() => reject(new Error('深度分析超时（外部数据接口响应过慢，请稍后重试）')), 280000)),
  ]);
  result.cachedAt = Date.now();
  result.fromCache = false;
  return result;
}

// 把 AI 联网总结的最新版本同步进深度分析缓存结果（与旧路由同逻辑）
function _attachDeepAICache(symbol, cached) {
  if (!cached || !cached.sections) return;
  try { const v = readCache(symbol, '_earnings'); if (v && v.summary) cached.sections.earningsReport = v; } catch {}
  try { const v = readCache(symbol, '_research'); if (v && v.summary) cached.sections.researchAI = v; } catch {}
  try { const v = readCache(symbol, '_announcements'); if (v && v.summary) cached.sections.announcementAI = v; } catch {}
}

// 启动后台任务（detached）：不把 Promise 交回 HTTP 响应，任务在 Node 进程内持续跑，完成时写缓存
function _startDeepJob(symbol, name, forceRefresh) {
  const job = { status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null, forceRefresh };
  _deepJobs.set(symbol, job);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    job.status = 'error';
    job.error = '深度分析超时（外部数据接口响应过慢，请稍后重试或点刷新）';
    job.finishedAt = Date.now();
  }, 300000); // 5min 安全网
  _runDeepAnalysisOnce(symbol, name).then((result) => {
    if (settled) return; // 已被超时兜底接管
    settled = true; clearTimeout(timer);
    if (result && result.__notFound) { job.status = 'error'; job.error = '无法获取股票行情数据'; }
    else { job.result = result; job.status = 'done'; writeAnalysisCache(symbol, result); }
    job.finishedAt = Date.now();
  }).catch((e) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    job.status = 'error'; job.error = (e && e.message) || String(e);
    job.finishedAt = Date.now();
  });
  return job;
}

// 取/启后台任务：同语义复用；语义不同但正在跑则复用当前的（避免重复跑）；否则启动新任务
function _getOrStartDeepJob(symbol, name, forceRefresh) {
  const existing = _deepJobs.get(symbol);
  if (existing && existing.forceRefresh === forceRefresh) return existing;
  if (existing && existing.status === 'running') return existing;
  return _startDeepJob(symbol, name, forceRefresh);
}

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

    console.log(`[DeepAnalysis] Request for ${symbol} (refresh=${forceRefresh})...`);

    // 1) 命中磁盘缓存且非强制刷新 → 立即返回（秒回，不进后台）
    if (!forceRefresh) {
      const cached = readAnalysisCache(symbol);
      if (cached) {
        console.log(`[DeepAnalysis] Serving cached result for ${symbol}`);
        cached.localDocuments = getLocalDocuments(stockCode);
        _attachDeepAICache(symbol, cached);
        return res.json({ ...cached, fromCache: true });
      }
    }

    // 2) 启动/复用后台任务，立即返回状态（绝不阻塞等待）
    const job = _getOrStartDeepJob(symbol, name, forceRefresh);
    if (job.status === 'done' && job.result) {
      const out = { ...job.result, fromCache: false, background: true };
      out.localDocuments = getLocalDocuments(stockCode);
      _attachDeepAICache(symbol, out);
      return res.json(out);
    }
    if (job.status === 'error') {
      return res.status(500).json({ error: job.error || '深度分析失败' });
    }
    // running → 秒回状态，前端轮询
    return res.json({ status: 'running', startedAt: job.startedAt, finishedAt: null });
  } catch (err) {
    console.error('Deep analysis route error:', err);
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
// 20260928d：自选股自动判定·防抖槽（每 15 分钟至多跑一次，非周末）
let _lastEnsureSlot = '';
// 20260917：大盘技术分析「当日判断」每日落盘守卫（避免同一天重复计算）
let _lastMarketTechRecord = '';
// 20260917d：大盘量能情绪模型「当日判断」每日落盘守卫
let _lastMarketEmotionRecord = '';
// 20261024g：实时大盘 AI 复盘「当日写入大盘记录」守卫（用户要求每天收盘后自动解读一次）
let _lastMarketAiReview = '';

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
  // 20261021g：主机族降级——ifzq 的 fqkline 会整段 501，同一路径 web.ifzq 正常
  const hosts = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const r = await fetch(host + '/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const days = j && j.data && j.data.sh000001 && j.data.sh000001.day;
      if (!Array.isArray(days) || !days.length) throw new Error('腾讯日K返回空 day 数组');
      return String(days[days.length - 1][0]);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('腾讯日K接口不可用');
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
    const today = localDate(now);
    const { asOfTradingDate } = require('./lib/cnTradingCalendar');
    const asOf = asOfTradingDate(today);
    // 20261024k：非交易日（周末/节假日）不要求「当日」数据，只确保最近交易日记录存在（沿用其数据），
    // 否则首页「板块拥挤度」周末会因今日无记录而显示暂无数据（假缺口）。
    if (dow === 0 || dow === 6) {
      if (sectorCrowdingHasDate(asOf)) return;
      const mo = await getMarketOverview();
      if (Array.isArray(mo.sectorAll) && mo.sectorDate === asOf) {
        recordSectorCrowding(mo.sectorAll, mo.sectorDate);
      }
      return;
    }
    const hh = now.getHours(), mm = now.getMinutes();
    if (hh < 15 || (hh === 15 && mm < 30)) return;
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

// 20261024g：每交易日收盘后自动执行一次「实时大盘 AI 解读」并写入「大盘记录」（notes scope=market）。
// 用户 2026-10-24 要求：下午 3 点收盘后自动解读一次，保存到大盘记录里面。
// 复用首页「AI 解读」同一套能力（lib/aiAugment.analyzeMarketOverview + 同源 getMarketOverview 数据），
// 结果作为一条 scope=market 的笔记累积到 data/notes.json；同日幂等（标题带日期，重启不重复写）。
// 说明：这是用户明确要求的定时任务，不受 SA_NO_BG_AI（事件/专属因子后台 AI 总开关）影响；
// 如需停用，设置环境变量 SA_NO_DAILY_AI_REVIEW=1 即可（不再每天调用大模型）。
async function runDailyMarketAiReview(today) {
  if (process.env.SA_NO_DAILY_AI_REVIEW === '1') {
    return { saved: false, reason: 'SA_NO_DAILY_AI_REVIEW=1 已关闭每日大盘 AI 复盘' };
  }
  const dailyReview = require('./lib/dailyMarketReview');
  const { asOfTradingDate } = require('./lib/cnTradingCalendar');
  const asOf = asOfTradingDate(today);
  // 幂等：该交易日已有复盘记录则跳过（防重启/多次触发重复调 LLM 与刷记录）
  if (dailyReview.alreadyReviewed(readNotesFile(), asOf)) {
    return { saved: false, reason: `${asOf} 已有 AI 大盘复盘记录` };
  }
  // 与首页 /api/market-overview 同源：指数 + 涨跌幅板块
  const data = await getMarketOverview().catch(() => null);
  if (!data) return { saved: false, reason: '大盘数据获取失败' };
  const { analyzeMarketOverview } = require('./lib/aiAugment');
  // force:true → 定时任务取收盘后最新数据（并写缓存，供当天手动/刷新复用）
  const ai = await analyzeMarketOverview({ data, force: true });
  if (!ai || ai.success === false) {
    return { saved: false, reason: (ai && (ai.message || ai.error)) || 'AI 解读未返回有效内容' };
  }
  const r = dailyReview.saveMarketReviewNote({ date: asOf, data, ai });
  return r.saved ? { saved: true, date: asOf } : { saved: false, reason: r.reason };
}

function startDailySettlementScheduler() {
  setInterval(() => {
    const now = new Date();
    const dow = now.getDay();
    const isWeekend = (dow === 0 || dow === 6);
    const hh = now.getHours();
    const mm = now.getMinutes();

    // —— 15:30 盘后结算 + 自学习自动复核 ——
    if (!isWeekend && isTradingDay(localDate(now)) && hh >= 15 && (hh > 15 || mm >= 30)) {
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
      // —— 20261024g：每交易日收盘后自动「实时大盘 AI 复盘」并写入大盘记录（notes scope=market）——
      if (_lastMarketAiReview !== today) {
        _lastMarketAiReview = today;
        runDailyMarketAiReview(today)
          .then(r => console.log(r && r.saved
            ? `  [大盘AI复盘] 已写入大盘记录：${today}`
            : `  [大盘AI复盘] 跳过：${(r && r.reason) || '未知原因'}`))
          .catch(e => console.error('  [大盘AI复盘] 失败:', (e && e.message) || e));
      }
      // —— 15:30 收盘补写守卫：当日拥挤度记录缺失时自动补写（20260909n，幂等，记录已存在时秒回）——
      ensureSectorCrowdingToday('每分钟检查').catch(() => {});
    }

      // —— 盘前预重算（方案 C·Part B）：交易日 8:00–9:30，每 10 分钟一次，吸收隔夜美股与早间消息 ——
      if (!isWeekend && isTradingDay(localDate(now)) && hh >= 8 && (hh < 9 || (hh === 9 && mm < 30))) {
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

      // —— 20260928d：自选股自动判定（每 15 分钟一次，仅交易日）：补齐新增自选股的判定记录，无需用户手动打开页面 ——
      if (!isWeekend && isTradingDay(localDate(now))) {
        const ensureSlot = `${localDate(now)} ${Math.floor((hh * 60 + mm) / 15)}`;
        if (ensureSlot !== _lastEnsureSlot) {
          _lastEnsureSlot = ensureSlot;
          ensureAllTrackedJudgments({ symbols: readWatchlistFile() })
            .then(r => console.log(`  [自动判定·自选股] 新建 ${r.created} · 已存在 ${r.reused} · 跳过 ${r.skipped}（共 ${r.total} 只）`))
            .catch(e => console.error('  [自动判定·自选股] 失败:', (e && e.message) || e));
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
  const result = await eventEngine.scanEvents(false);
  // 20261024h：事件变化 → 联动应答机制通知受影响个股判断作废（替代手写 invalidation 循环）
  const syms = result.changedSymbols || [];
  if (syms.length) moduleSync.emitChange('eventEngine', { symbols: syms, reason: '事件定时扫描' });
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
    let df;
    try { df = require('./lib/dedicatedFactor'); } catch (e) { return; }
    df.triggerDedicatedFactors({ force: false })
      .then(r => {
        if (r && r.triggered && r.triggered.length) {
          // 20261024h：专属因子变化 → 联动应答机制作废变更个股判断
          const syms = r.changedSymbols || [];
          if (syms.length) moduleSync.emitChange('dedicatedFactor', { symbols: syms, reason: '专属因子月度触发' });
          console.log(`  [专属因子] 月度触发完成：新增 ${r.triggered.length} 个实例（${r.period}）`);
        }
      })
      .catch(e => console.error('  [专属因子] 定时触发失败:', e && e.message));
  }, 60 * 60 * 1000); // 每小时检查
}

// ── 全局错误兜底（20261001a 体检 P2b）────────────────────────────────────────
// ---- 集中错误落盘（看门狗 / 排障用） ----
// 全局错误中间件与 unhandledRejection 在 console.error 之外，额外追加写入 logs/error.log，
// 含时间戳 + 路由 + 堆栈首行，便于事后排查；按 >5MB 自动轮转，保留最近 14 份。
const ERROR_LOG_DIR = path.join(__dirname, 'logs');
const ERROR_LOG_FILE = path.join(ERROR_LOG_DIR, 'error.log');
function rotateLogIfLarge(file, keep) {
  keep = keep || 14;
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= 5 * 1024 * 1024) return;
    if (!fs.existsSync(ERROR_LOG_DIR)) fs.mkdirSync(ERROR_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const arch = file.replace(/\.log$/, '.' + ts + '.log');
    try { fs.renameSync(file, arch); } catch (e) { /* 归档失败不阻塞 */ }
    // 清理超过 keep 份的旧归档（按修改时间留新删旧）
    try {
      const base = path.basename(file).replace(/\.log$/, '');
      const old = fs.readdirSync(ERROR_LOG_DIR)
        .filter(function (f) { return f !== path.basename(file) && f.indexOf(base + '.') === 0 && f.endsWith('.log'); })
        .map(function (f) { return { f: f, t: fs.statSync(path.join(ERROR_LOG_DIR, f)).mtimeMs }; })
        .sort(function (a, b) { return b.t - a.t; });
      old.slice(keep).forEach(function (o) { try { fs.unlinkSync(path.join(ERROR_LOG_DIR, o.f)); } catch (e) {} });
    } catch (e) {}
  } catch (e) {}
}
function logErrorToFile(tag, info, err) {
  try {
    if (!fs.existsSync(ERROR_LOG_DIR)) fs.mkdirSync(ERROR_LOG_DIR, { recursive: true });
    rotateLogIfLarge(ERROR_LOG_FILE);
    const t = new Date().toISOString();
    const msg = err && err.message ? String(err.message) : '';
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : '';
    const line = '[' + t + '] ' + tag + ' ' + (info || '') + ' ' + msg + ' ' + stack + '\n';
    fs.appendFileSync(ERROR_LOG_FILE, line);
  } catch (e) { /* 落盘失败绝不影响主流程 */ }
}

// 1) Express 错误中间件：注册在全部路由之后（含 1904 行 app.get('*') 兜底路由），捕获同步抛错 /
//    next(err)，统一返回 JSON——既避免 Express 默认 HTML 错误页，也避免前端把 HTML 当 JSON 解析报错。
//    注意：Express 4 不会自动捕获 async 路由的 rejection，各 async 路由自带 try/catch 的既有约定不变。
// 2) unhandledRejection：Node 15+ 默认「未处理拒绝 = 进程直接崩溃」，长驻本地服务不因
//    单个后台 Promise 失败整站退出，这里记录后继续运行。
app.use((err, req, res, next) => {
  logErrorToFile('[global-error]', (req && req.method || '') + ' ' + (req && req.originalUrl || ''), err);
  console.error('[global-error]', req.method, req.originalUrl, (err && err.message) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err && err.message ? String(err.message).slice(0, 300) : '服务器内部错误' });
});

process.on('unhandledRejection', (reason) => {
  logErrorToFile('[unhandledRejection]', '', reason);
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

function startServer(port, retries = 5) {
  // 20261007a Security fix: bind loopback only. Previously app.listen(port) listened on
  // 0.0.0.0 (all NICs), so ANY device on the LAN could reach the workbench with no auth
  // (including file upload and AI config APIs). Binding '127.0.0.1' keeps localhost
  // browsing identical while making the server unreachable from other devices.
  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    // 由启动器(start.vbs)负责打开浏览器时，这里必须跳过，否则会打开两个相同的网页窗口
    const launcherOpens = process.env.SA_NO_AUTO_OPEN === '1';
    console.log(`\n  Stock Analyzer 已启动： ${url}\n  ${launcherOpens ? '（浏览器由启动器打开，此处跳过以避免重复开窗）' : '正在打开浏览器...'}\n`);
    try {
      fs.writeFileSync(path.join(__dirname, 'data', '.server-port'), String(port));
      // 20261004 启动提速配套：写入「就绪标记」，供启动器 start.vbs 轮询以立刻开浏览器。
      // 原先启动器固定盲等 3500ms，而服务约 0.9 秒就监听完成 → 用户干等 2.5 秒以上。
      // 标记用文件而非 HTTP 探测：纯文件系统判断，不受本机 HTTP_PROXY 代理影响。
      // 启动器在拉起新实例前会先删掉它，故一定对应本次新起的实例（不会读到上轮的残留）。
      fs.writeFileSync(path.join(__dirname, 'data', '.server-ready'), String(Date.now()));
    } catch (e) { /* 忽略端口/就绪标记写入失败 */ }
    if (!launcherOpens) openBrowser(url);
    // 启动时自动结算 + 自学习自动复核（含周末生成的 nextday 预测），确保过期未结算的预测被判对错、准确率真实
    runAutoReview()
      .then(logAutoReview)
      .catch(e => console.error('  [结算] 初始化失败:', e.message));
    // 20260928d：自选股自动判定——服务启动即补齐所有自选股（含从未打开过的）的当前目标日短期判断，
    // 落实「打开工作台后自动进行数据分析判定、无需切到对应页面」的核心原则；后台静默执行，失败不阻断启动。
    ensureAllTrackedJudgments({ symbols: readWatchlistFile() })
      .then(r => console.log(`  [自动判定·自选股] 新建 ${r.created} · 已存在 ${r.reused} · 跳过 ${r.skipped}（共 ${r.total} 只）`))
      .catch(e => console.error('  [自动判定·自选股] 初始化失败:', (e && e.message) || e));
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
