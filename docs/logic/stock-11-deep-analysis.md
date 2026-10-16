# 🔬 深度分析（管线）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「🔬 深度分析」Tab（综合估值评级 + 营收/盈利/现金流/ROE/估值/分红/DCF 确定性分析 + AI 叙事卡）
> 实现文件：`public/js/app.js:2917-2996`（`loadDeepAnalysis`）、`public/js/deepCharts.js`（`DeepCharts.renderAll`）、`lib/deep/pipeline.js`（主流程）、`lib/deep/conclusions.js`、`lib/deep/conclusion.js`、`lib/deep/financials.js`
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 综合估值评级 | `sections.conclusion.overallRating`（低估/合理/偏高/高估）+ `fairValueRange` + `conclusionText` | conclusion.js:13；app.js:2982 DeepCharts.renderAll |
| 营收/盈利趋势 | `sections.revenueCostData[*]`（revenue/netProfit/revenueYoy/profitYoy/grossMargin/netMargin） | conclusions.js:12-28 |
| 现金流质量 | `sections.cashFlowData[*]`（operatingCashFlow/netProfit） | conclusions.js:30-58 |
| ROE/毛利率走势 | `sections.roeMarginTrend` | conclusions.js:90-172 |
| 估值 PE/PB/PS | `sections.valuation`（peStats/pbStats/psStats） | conclusions.js:317-347 |
| 分红 | `sections.dividendData/dividendPayouts/dividendYieldData` | pipeline.js:342-397 |
| DCF | `sections.dcf` | conclusions.js:222-234 |
| 财报解读/研报/公告（AI 叙事） | `sections.earningsReport/researchAI/announcementAI`（readCache `_earnings/_research/_announcements`） | pipeline.js:411-415 |
| 重大财务变化 AI 归因 | `sections.changeAnalysis` | pipeline.js:513-519 |
| 加载触发 | `GET /api/deep-analysis/:symbol`（server.js）→ `deepAnalysis()` | app.js:2940 |

## 二、核心公式 / 判定链

主流程 `deepAnalysis()`（pipeline.js:159）：

1. **市场校验**：仅 A 股（pipeline.js:163-165）。
2. **当前价权威源**：行情网关 `wrapQuote`，不可用则降级日线末日收盘价并打 `degraded`（:175-196），落地 `data_points`（:200-210）。
3. **财报抓取**：`fetchFinancialData`（financials.js:88-126，`ANALYSIS_YEARS=5` 行 50）→ 三表 `fetchFinancialStatement`（financials.js:31-47，companyType 回退 `[4,2,3,1]`）。
4. **各环节确定性分析**：
   - 营收/盈利 `analyzeRevenueCost`→`buildRevenueConclusion`（pipeline.js:249；conclusions.js:12-28）
   - 资产负债 `analyzeBalanceSheet`→`buildBalanceConclusion`（:250；conclusions.js:174-205）
   - 现金流 `analyzeCashFlow`→`buildCashFlowConclusion`（:251；conclusions.js:30-58）
   - 估值 `analyzeValuation`（含东财 TTM 估值回退，:253-259）→`buildValuationConclusion`（conclusions.js:317-347）
   - 增长 `analyzeGrowth`→`buildGrowthConclusion`（:288；conclusions.js:60-69）
   - DCF `calculateDCF`→`buildDCFConclusion`（:289；conclusions.js:222-234）
   - 分红率/股息率 `buildDividendConclusion`/`buildDivYieldConclusion`（conclusions.js:207-220, 349-360）
   - ROE/毛利率 `analyzeRoeMarginTrend`（conclusions.js:90-172）
5. **综合估值结论（确定性）**：`generateConclusion`（conclusion.js:13）→ PE 估值带评级（:77-101，阈值 `peStats.low/high/mean*1.5` 行 83-86）→ 加权平均 `scoreMap`（:134-144）→ `overallRating ∈ {低估,合理,偏高,高估}`。
6. **AI 叙事接入点**：仅 `earningsReport/researchAI/announcementAI`（缓存，非管线生成）与 `changeAnalysis`（AI 归因，pipeline.js:513-519）。**确定性逻辑全在代码，AI 只做叙事/归因展示。**
7. **专属估值模型**：约 11 个（601318/000783/600909/688289/603288/600460/300319/688660/000902/002643/新洋丰 等）整体覆盖 `overallRating/fairValueRange`（conclusion.js:155-403）；与通用 PE 估值带可能口径打架（代码注释承认 000902/002643 曾发生）。

## 三、指标 / 因子口径

| 项 | 口径 | 是否确定性 | 出处 |
|---|---|---|---|
| overallRating | 低估/合理/偏高/高估（scoreMap 加权） | 是 | conclusion.js:134-144 |
| 营收/盈利趋势 | TTM 同比 | 是 | conclusions.js:12-28 |
| 现金流质量 | 经营现金流/净利润 | 是 | conclusions.js:30-58 |
| ROE/毛利率 | zyzbHistory(ROEJQ)+TTM | 是 | conclusions.js:90-172 |
| 估值带 | PE/PB/PS 历史分位 | 是 | conclusions.js:317-347 |
| DCF | 现金流贴现 | 是（部分假设项标注） | conclusions.js:222-234 |
| 财报解读/研报/公告 | AI 文本 | **否（叙事）** | pipeline.js:411-415 |
| 重大变化归因 | AI 文本 | **否（归因）** | pipeline.js:513-519 |

## 四、数据来源与采集链

| 字段 | 取数函数 | 上游数据源 |
|---|---|---|
| 财报三表 | fetchFinancialStatement（financials.js:31-47） | 东方财富 `emweb PC_HSF10/NewFinanceAnalysis`（:11） |
| 股本/市值/PE(TTM) | fetchShareholders（financials.js:138-161） | 东财 `RPT_VALUEANALYSIS_DET`（:140） |
| 前十大股东 | fetchTopShareholders（:214-262） | 东财 `RPT_F10_EH_HOLDERS`（:216） |
| 估值 TTM 序列 | fetchValuationTTM（pipeline.js:255） | 东方财富 TTM 估值（eastmoneyValuation.js） |
| 研报/公告/财报 AI 叙事 | readCache('_earnings'/'_research'/'_announcements') | lib/ai/earnings.js 等 AI 联网/本地总结 |

## 五、降级 / 容错 / 诚实性设计

- **无财报**：`pipeline.js:244-246` 返回 `{error:'无法获取财务数据'}`；前端显示「⚠️ 深度分析目前仅支持A股…」（app.js:2946-2951）。
- **股息率未计算**：`pipeline.js:386` 默认 `{success:false, errorType:'NOT_COMPUTED'}`（诚实不上零值）。
- **价格降级不透明**：后端打 `degraded`（pipeline.js:194）但前端 `updateDeepCacheBar`（app.js:3014-3027）文案只写「东方财富财报/分红/股东数据·本地规则计算」，**不披露价格来自降级口径**——诚实性缺口（见第六节 #10）。
- **AI 叙事失败降级**：研报/公告/财报占位"正在后台联网生成…"/"尚未配置 AI API Key…"，失败触发 `_triggerAi`（deepCharts.js:1485-1539）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1【高优·AI 越权做确定性判断】财报解读因子**：`earningsSignal` 由 AI 文本解析（`lib/ai/earnings.js:_extractEarningsSignal`）→ 被 `sameDayJudgment.js:710-712` 直接作为量化信号 `earnSub.signal` 并入短期打分（权重 `EARN_SUB_W=0.10`）。同一份 AI 输出既做深析「财报解读」叙事，又做确定性数值输入，首选路径即 AI（虽有三档回退），存在不可复现/越权风险（详见 stock-04 审计表，因子名 `财报解读`）。
- [ ] **#2 专属估值模型与通用 PE 带口径打架**：11 个专属模型整体覆盖 rating/区间（conclusion.js:155-403），普通 PE 带与专属模型口径可能冲突（代码注释承认 000902/002643 曾发生）；前端展示以哪个为准未固化。
- [ ] **#3 DCF/PS/PB 被排除综合区间却仍展示**：非保险企业 DCF/PS/PB 不进综合评级（conclusion.js:43,103,105-107,117-118），但 DCF 参数文本仍展示（:466-468）。
- [ ] **#4 价格降级不透明**：见第五节——`pipeline.js:187-196` 降级价已打 `degraded`，前端 `updateDeepCacheBar`（app.js:3014-3027）不披露。
- [ ] **#5 财报解读缓存时序不一致**：深度分析 `earningsReport` 卡按需触发 AI 联网（deepCharts.js:1511-1539），而 sameDay 读 `readEarningsCache`（sameDayJudgment.js:705）无 Key 时为 null 走回退；`stale` 判定仅在 sameDay 侧显式处理（:706-707），深析侧未同等约束 → 两处可能看到不同结论。
- [ ] **#6 综合评级"低估/合理/偏高/高估"四档与项目评级规范冲突**：项目级规范（见用户记忆）要求评级严格三档「低估/合理/高估」、禁用"偏高/偏高"等词；深度分析却用四档含"偏高"（conclusion.js:83-86, 134-144），与全局规范不一致（⚠️ 待核实是否需统一）。
- [ ] **#7 TTM 窗口不全回退最新披露期**：`computeTtmMetrics`（fundamentalScore.js:42-46）窗口不全时回退最新披露期，可能与展示"TTM"语义不符。
- [ ] **#8 专属模型假设项未全量标注**：DCF/各专属模型含假设项，部分已在 `vd-foot` 标"假设项已标注"，但需逐模型核对是否全覆盖（⚠️ 待核实）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 分析年数 | ANALYSIS_YEARS=5 | financials.js:50 |
| companyType 回退 | [4,2,3,1] | financials.js:32 |
| PE 估值带阈值 | peStats.low/high/mean*1.5 | conclusion.js:83-86 |
| 综合 scoreMap | 低估-1/合理0/偏高1/高估2 | conclusion.js:134-144 |
| 专属估值模型列表 | 11 只（601318 等） | conclusion.js:155-403 |
| 前端超时 | 65s AbortController（后端 55s 总超时） | app.js:2932-2943 |
| APP_VERSION 缓存破坏 | ?v=YYYYMMDDx | server.js:98 |
