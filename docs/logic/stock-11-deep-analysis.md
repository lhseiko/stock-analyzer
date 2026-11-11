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
| 前端超时 | 20261021k 起：**脱离请求生命周期的后台任务 + 轮询**（无 AbortController 断连，切页/断连都不中断；后端 `_deepJobs` 任务 300s 安全网，内部 `deepAnalysis` 总超时放大到 280s） | server.js:1437-1480（路由）/ app.js:3420-3507（轮询） |
| APP_VERSION 缓存破坏 | ?v=YYYYMMDDx | server.js:98 |

## 八、版本史（关键变更）

### 20261021k · 深度分析后台任务化（切页不断更、慢分析必落盘）
- **根因**：原 `loadDeepAnalysis`（app.js）用 `AbortController` 65s 阻塞请求，且服务端 `_deepAnalysisInFlight` 在超时时直接 500 且不写缓存 → ①用户一切换个股页/断开就 abort，财报解读进度全丢；②慢分析（财报解读子任务单项即可达 180s）超过旧 55s 后端硬超时 → 永远不落盘、下次仍重跑。
- **改法（服务端 `server.js`）**：
  - 废弃 `_deepAnalysisInFlight` 在途 Promise 去重，改为 `_deepJobs`（symbol→{status,startedAt,finishedAt,result,error,forceRefresh}）任务表。
  - 新增 `_startDeepJob`：**脱离 HTTP 响应**的 detached Promise，跑完 `_runDeepAnalysisOnce` 后写 `writeAnalysisCache` 并置 `status='done'`；300s 安全网超时兜底（仅防外部接口永久挂起，不误杀正常慢分析）。
  - `_runDeepAnalysisOnce` 内部总超时由 55s 放大到 **280s**（远低于 300s 安全网），财报解读子任务单项 180s 不再被误杀。
  - 路由 `/api/deep-analysis/:symbol`：命中磁盘缓存且非强制刷新→秒回 `fromCache`；否则 `_getOrStartDeepJob` 复用/启动任务→`done` 返回结果（带 `background:true`）、`error` 返 500、`running` 秒回 `{status:'running', startedAt}`（绝不阻塞）。
- **改法（前端 `app.js`）**：`loadDeepAnalysis` 改为轮询模型——同股非强制且已有 `deepData` 直接复用渲染；否则显示「📡 后台进行中…（已 Ns）」，每 4s 轮询仅当停留在深度分析 tab（切走则停轮询但**服务端任务继续跑**，回来再查即出结果）；`_deepPollToken` 在切股/重入时作废上一轮，避免串台。
- **验证**：`node --check` 双文件通过；全回归 60/63（仅 3 个历史旧债，零新增）；实启 3099 端口冒烟——缓存命中秒回、强制刷新返回 `fromCache:false/background:true` 完整结果（detached 任务跑完落盘后回传），证明非阻塞且任务存活。
- **用户感知**：财报解读/深度分析切页后**后台继续跑**，回来即显示；慢分析不再卡死、必然落盘。

### 20261023h · 修复「三季报已出仍解读半年报」（报告期窗口晚一个月）

- **现象**：洲明科技 300232，页面头部已显示「财务 2026三季报」，但「财报解读」仍输出「2026年半年报（披露 2026-08-24）」。
- **根因（不是死逻辑，是日历窗口晚一个月）**：`lib/deep/financials.getLatestPartialQuarterDates` 按月份猜报告期——5-7月=一季报 / 8-10月=中报 / 11月+=三季报。三季报法定披露期是 **10 月**（截止 10-31），但整个 10 月仍按中报只请求 03-31/06-30，从不请求 09-30。
- **核实**：直接请求 F10 `lrbAjaxNew?dates=2026-09-30` 返回「2026三季报」（营收 55.60 亿 / 归母 0.22 亿），数据源本就有，只是没问。
- **改法**：`getLatestPartialQuarterDates` 改为**直接请求最近两年全部季末报告期**（03-31/06-30/09-30/12-31），由 F10 返回实际已披露的那些；早于披露日请求返回空，天然无副作用。12-31 仍由 `_stmtStage==='FY'` 过滤。
- **缓存失效**：`EARNINGS_PROMPT_VERSION` 升至 `20261023h`；`lib/deep/pipeline.js` 改用 `readEarningsCache` 并丢弃 `stale` 缓存 → 前端 `renderEarningsReport` 在无 summary 时**自动触发**一次重新解读，无需用户手动点。
- **验证**：`fetchFinancialData('SZ300232')` 最新报告期 = 2026-09-30（2026三季报）；300232 财报缓存 `stale:true`；守卫 `test_latest_report_period` 15 项。

### 20261111d · 链路 3：后台任务状态机可测试化 + 6 个 B2 级缺陷修复

- **可测试化**：`server.js` 顶层 `app.listen` 且无 `module.exports`，无法用 supertest 直接打接口。把 `_deepJobs` 状态机按「等价迁移」抽到 `lib/deepJobManager.js`，8 个外部依赖 + 超时常量全部构造参数注入；`server.js` 只保留生产注入与 `app.get(..., _deepJobManager.handler)` 挂载，`_deepJobs` 变量名保留供守卫/排障引用。E2E 用 `express + listen(0) + 原生 http` 独立端口，`require.cache` 把 `lib/deep/pipeline.js` 换成受控 Promise（经 `lib/deepAnalysis.js` 门面透出），零网络、零 3005 依赖。
- **状态机流转图（修复后）**：

```
GET /api/deep-analysis/:symbol
  │
  ├─ 磁盘缓存命中 && !refresh ──────────────→ 200 { ...cached, fromCache:true }（秒回，不进后台）
  │
  └─ 未命中 → getOrStartJob(symbol, name, forceRefresh)
        │
        ├─ 已有 running ───────────────────→ 复用同一 job（并发/轮询去重，底层只跑 1 次）→ 200 running
        ├─ 终态过期(>=doneTtlMs) ─────────→ 惰性清理 + 旧 job 作废 → 重建
        ├─ error 且未投递过 ───────────────→ 复用 → 500（errorDelivered=true）
        ├─ error 且已投递过 ───────────────→ 重建（可重试，不永久 500）
        ├─ done 且 TTL 内 && 语义一致 ─────→ 复用内存结果 → 200 { ...result, background:true }
        └─ 其余 ──────────────────────────→ startJob → running → 200 running
                                                  │
                    ┌─────────────────────────────┼──────────────────────────────┐
                    ▼                             ▼                              ▼
          底层完成 → done（落盘）      内层 280s / 外层 300s / 抛错 → error      迟到结果（超时后算完）
                                                                         │
                                                        仅落盘 + 日志；不改已终态 job
                                                        若 job 已 superseded → 直接丢弃
```

- **B2 缺陷清单（先红灯 `27 通过 / 5 失败` 实证，再统一修复，避免先改后测自证）**：

| 编号 | 缺陷 | 修复 |
|---|---|---|
| B2-1 | `done/error` 终态 job 永久驻留 Map，缓存失效仍被复用，且 Map 无上界 | `doneTtlMs`（默认 5min）惰性过期 + `maxJobs`（默认 2000）淘汰最旧终态；running 绝不误删 |
| B2-2 | 超时后 `settled` 分支 `return`，把已算完的 5 分钟计算静默丢弃 | 迟到结果照样落盘并打日志，不回滚 job 状态 |
| B2-3 | `Promise.race` 的 280s 内层 timer 从不 clear，每次分析泄漏一个定时器 | `finally { clearTimeout(innerTimer) }` |
| B2-4 | 终态 `error` 被无限复用，不重启服务就永远 500 | 错误投递一次后（`errorDelivered`）允许同参数重建任务 |
| B2-5 | 重试/语义变化覆盖旧 job 后，旧 job 迟到结果会污染新结果 | 旧 job 标记 `superseded`，迟到结果不落盘、不改状态 |
| B2-6 | `writeAnalysisCache` 抛错掉进 `.catch`，把已 done 的 job 反向打成 error | 落盘 `try/catch` 隔离，只告警不改状态 |

- **测试桩自身缺陷 B2-T1**：§F 曾用 `controlled.reset()` 切回 `resolve`，清空 `calls` 导致「新增次数」基准丢失出现 `-1`；改为只切 `mode/delayMs` 保留计数，断言未放宽。
- **验证**：`scripts/test_deep_jobs_e2e.js` **39/0**（§0 接线 / §A 基本流转 / §B 3 路并发去重+3 路轮询 / §B2 状态清理 / §C 重启恢复 / §E 50ms 安全网 / §E2 迟到结果 / §E3 定时器清理 / §F error 重试 / §G 并发竞态）；`test_e2e_chains.js`、`test_cache_bust_guard.js`、`test_swallow_catch_guard.js`、`run_all_tests.js --quick` 全绿。
- **版本戳判定**：响应 JSON 结构零变化、前端零改动 → 按 APP_VERSION 铁律**不 bump**（若 bump，`readAnalysisCache` 的 `appVersion` 门控会把全部深度分析磁盘缓存判失效，触发无谓的昂贵重算）。但 `server.js` 已改，**必须重启 3005 服务**才生效。
