# 个股每日复盘 · 反向逻辑说明

> 逻辑模型位置：个股页 →「每日复盘」tab（替换原「策略」tab，20261110e 起）
> 实现文件：lib/stockReview.js（服务层）/ prompts/stock-review-system.md（System Prompt）/ public/js/stockReviewUI.js（UI）/ server.js 路由 + 20:35 调度槽 / public/js/dailyReview.js（大盘页直达入口）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断
> 版本：20261110f（B0 联动收尾：双向联动 / 代码列 / 缓存键 / 路径守卫 / 颜色合规）

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 「观察池带入」下拉 | 读**最新一份**大盘复盘 markdown 的【明日核心观察池】表格，按行列出（名称 · 评级）；无池时如实显示「暂无核心观察池」 | lib/stockReview.js:137 getPool → 81 parseWatchPool；stockReviewUI.js loadPool |
| 「或输代码」输入框 | 6 位代码直接进入；名称/带代码文本先经 resolveSymbol 确定性解析 | lib/stockReview.js:519 |
| 「生成今日复盘」按钮 | POST /api/stock-review/:symbol/run；当日已有缓存直接返回（force 才重跑） | server.js:2513 路由；stockReview.js:545 |
| 评级芯片 S/A/B/C | 从 markdown「> 评级判定：X」正则抽取（代码权威，不信 LLM 自由文本）；S/A=红、B=中性灰、C=绿 | stockReview.js:411 extractMarks；stockReviewUI.js renderMeta |
| 放弃信号芯片 触发/未触发 | 从 markdown「> 放弃信号判定：触发/未触发」抽取；触发=绿（利空绿）、未触发=中性灰 | 同上 |
| 连续放弃 N 天 | 读历史落盘 marks（不读叙事），从最近一天往回数连续 giveupTriggered=true | stockReview.js:323 computeGiveupStreak |
| 红色…（本模块无红色警告条） | 连续 ≥3 天放弃信号横幅为**绿色**（利空绿），不是红色 | stockReviewUI.js renderBanner |
| 历史日期按钮 | GET /api/stock-review/:symbol/history 倒序列出，点击回看当日卡片 | stockReview.js:296 listReviews |
| 「来自大盘复盘观察池」芯片 | 当日观察池按**代码精确匹配**（无代码回退名称），命中才有此行 | stockReview.js:359 buildContext（poolEntry） |
| AI 生成信息芯片 | llm.degraded=false 显示模型名；true 显示「AI 暂不可用，已发布数据快照」 | stockReview.js:460 llmGenerate |
| 大盘复盘页观察池表「个股复盘 →」 | 只给带「代码」列的表格行加链接，跳 /index.html?symbol=代码#stockreview，app.js 加载后自动切 tab | public/js/dailyReview.js decorateWatchPool；app.js:164 |

## 二、核心公式 / 判定链

1. **生成链**：`resolveSymbol（代码直取 / 名称 → searchStocks）` → `查缓存 data/stock-reviews/{symbol}/{date}.json`（命中即返回）→ `buildContext` → `llmGenerate（System Prompt + 干净 JSON Context）` → `extractMarks（确定性抽取评级/放弃/连续天数）` → 落盘 JSON。
2. **观察池表解析**（parseWatchPool，lib/stockReview.js:81）：定位「【明日核心观察池】」标记 → 向后逐行剥 blockquote 前缀 → 表头行判定列布局（含「代码」列 = 6 列 code6；否则 5 列 legacy5）→ 数据行按布局取值；分隔行/空行跳过；最多 20 行；无标记 → 空池（不臆造）。
3. **连续放弃信号**（computeGiveupStreak，:323）：listReviews 按日期倒序 → 从最近一条（严格早于复盘日）往回累计 `giveupTriggered===true`；遇 false / 无记录即停。**降级快照无标记行 → giveupTriggered=null → 视为链断**（不把 AI 故障当成「信号解除」）。
4. **连续 ≥3 天反查**（buildBackcheck，:343）：仅在 streak≥3 时激活，取最近 3 条历史记录里的「三、明日剧本推演与验证」原文（≤2200 字符/条）注入 Context.history.backcheck，由 LLM 在卡片末尾输出「AI 漏看了什么 / 环境变了什么」。
5. **评级语义**（System Prompt）：S=板块主线共振+资金+催化三者齐备；A=顺势两项齐备；B=观察；C=逻辑走弱或证伪边缘。代码只抽取字母，不推断档位。

## 三、指标 / 因子口径

| 指标/因子 | 口径 | 是否进分数 | 出处 |
|---|---|---|---|
| 行情快照 | getQuote → open/high/low/price/prevClose/changePct/turnover(%)/amount（元→亿 = /1e8） | 不进分（只叙事） | lib/stockReview.js:200 |
| 前一交易日成交额/换手 | 东财历史 bar（含 amount/turnover），取早于当日最近一条 | 不进分 | :200（out.prev） |
| 资金摘要 | analyzeCapitalFlow.moneyFlow.summary（5d/10d/20d 主力净额，单位亿，双层嵌套兼容） | 不进分 | :232 |
| 板块联动 | sectorLimitStats：industryName/limitUp/limitDown/total/date；ok:false → missing=true + note | 不进分 | :263 |
| 消息面 | getNews 前 10 条标题/日期/来源/情绪 | 不进分 | :280 |
| 大盘观察池个股信号汇总 | 反向联动块：total/reviewed/giveupTriggered/rows(rating,hasReview) | 不进分（只进报告对照） | :172 poolMarksSummary |

> 本模块**不参与任何打分/权重/综合评级**，只做盘后观察记录（与「严禁买卖建议」一致）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 腾讯行情（getQuote）/ 东财历史 bar / 东方财富资金流（analyzeCapitalFlow）/ 全市场涨跌停池（sectorLimitStats）/ 东方财富新闻（newsSearch）/ **AKShare 分钟分时（主源）→ 腾讯分时 ifzq.gtimg.cn（降级）** / AKShare 龙虎榜（boardReviewData --lhb-only） |
| 采集/落盘 | 每只股票生成一次：`data/stock-reviews/{symbol}/{date}.json`（含 markdown + marks + llm 元信息 + resolve 留痕） |
| 调度 | 20:35 定时槽（REVIEW_SLOTS，server.js）对**当日大盘复盘观察池**逐只批量生成；幂等（当日已有即跳过）；串行，单只失败不阻塞；非交易日先查 trade_calendar 跳过 |
| 前端取数 | GET /api/stock-review/pool、/:symbol、/:symbol/:date、/:symbol/history；POST /:symbol/run（参数经 validStockSymbol/validReviewDate 守卫，非法 400） |

## 五、降级 / 容错 / 诚实性设计

- **LLM 未配置 / 超时 / 报错 / 空返回** → 降级为**数据快照**照常落盘（:434 toSnapshotMarkdown），顶栏明示降级原因；不拒绝发布、不编造结论。
- 快照只输出纯文本数值（成交额=亿、换手率独立成行、资金摘要为代码拼好的字符串、板块缺失标「数据缺失」），**禁止 `[object Object]` 与 raw JSON dump**（20261110e 事故回归，守卫 test_stock_review.js §6）。
- 20261111c：快照新增「板块联动 / 龙虎榜 / 量能」三行。`volumeTier` 是对象，只取 `.tier` 文本（直接拼对象会复现 `[object Object]`，已由 test_e2e_chains.js §C 固化回归）。
- 名称解析失败 / 歧义：resolveSymbol 返回 null 或 ambiguous=true，落盘 `resolve.ambiguous` 如实标注，不假装确定。
- 数据缺失（板块 ok:false / 新闻失败 / 前日成交额缺失）→ 逐项标「数据缺失/不可用」，主流程不中断。
- 20261111c 三块数据源接线：`sector` 先经 `sectorIdentity.resolveSectorIdentity` 解析行业再传 `getSectorLimitStats`（根治「行业识别失败」）；`volume` 复用 `analyzeCapitalFlow` 内部的 `volumeEngine` 结论；`lhb` 走 `boardReviewData.getLhbOnly(--lhb-only)` + `byCode` 全量代码索引按代码精确判定上榜状态。`lhb.available=false`（盘后未发布）按 note 写「待晚间补录」，不写「数据缺失」。
- **20261111d 分钟级真实分时（Context.intraday）**：取数链 `scripts/board_review_data.py build_intraday()`（`--intraday-symbol` 早退通道）→ `lib/boardReviewData.js getIntraday()` → `lib/stockReview.js getIntradayData()`。AKShare 首选 `stock_zh_a_hist_min_em(period='1')`，失败退回 `stock_intraday_em(symbol)`；两者皆不可达（当前沙箱东财 `push2his` / `70.push2` 被代理拦截）时降级到项目现成 `stockData.fetchTencentMinutes()`，来源写 `腾讯分时 ifzq.gtimg.cn` 并用 `degradedFrom` 记录主源失败原因，**不冒充 AKShare**。
- **不使用 `stock_zh_a_spot_em`**：实测该接口无 `symbol` 参数、返回全市场实时快照，且本脚本既有规定禁用（asOf 错位、耗时不可接受）；它只给单只股票的实时价，不是分时数据。
- **代码权威 / Context 体积**：240+ 条分钟点不进 LLM Context，由 `summarizeIntraday()` 压成结构化特征（`pattern` / 四段 `segments.chgPct`+`volPct` / `highTime`+`lowTime` / `tailChgPct` / `closeVsAvgPct` / `peakVolTime` / `points`）。走势形态由代码判定，LLM 只叙事。累计量（腾讯 cumVol）与当分钟量（AKShare）按单调性自动识别；分段用半开区间 `[from,to)`，四段量能占比合计 = 100%。腾讯 15:01-15:30 盘后零量条目在降级侧先行过滤（否则稀释量能占比、错把 15:30 当末点）。
- **五要素 / 口径日**：`intraday.source` + `date` + `dateMatches` 必带。`stock_intraday_em` 只给当日快照，Python 侧把 `asOf` 标为脚本运行日，历史复盘会得到 `dateMatches=false`，提示词要求明写「分时口径日与复盘日不一致」，禁止把旧分时当今日走势。两条取数路径都不可用时 `available=false` + `note` 如实说明，快照渲染「数据源暂不可用（原因）」，不写「分时明细数据缺失 / 按 OHLC 还原」。
- 连续放弃链在降级日断开：**AI 故障 ≠ 信号解除**，页面与落盘均如实呈现。

## 六、逻辑漏洞自查清单（审计用）

- [ ] 缓存键与落盘键是否一致？generateReview 先 resolveSymbol 再查 `reviewFile(symbol)`（:545），名称入口不得每次重跑 LLM。
- [ ] 观察池 6 列/5 列两种表头是否都能正确解析？表头是否含「代码」决定布局（:81）；旧落盘复盘不得因无代码列而解析错列。
- [ ] 评级/放弃标记抽取是否只认固定格式行？`> 评级判定：X`、`> 放弃信号判定：触发/未触发`（:411）；缺标记 → null。
- [ ] 连续放弃是否按「日期严格早于复盘日」累计？beforeDate 过滤（:323）；同日重跑不得把自己算进 streak。
- [ ] 降级快照是否零买卖建议词？守卫断言（test_stock_review.js §6）。
- [ ] 路由参数是否校验？symbol ≤12 位 `[0-9A-Za-z.]`、date `YYYY-MM-DD`（server.js validStockSymbol/validReviewDate）——防止路径拼接被畸形参数穿透。
- [ ] 20:35 批量是否幂等？当日已有文件即 skipped 不调 LLM（:608 runPoolBatch）；非交易日跳过；失败逐只记录不阻塞。
- [ ] 反向联动是否只注入计数与枚举？history.stockMarks 不带个股复盘正文（reviewContext.js compactStockMarks），不超 12000 字符预算。
- [ ] 大盘页入口是否只给「带代码列」的表加链接？无代码列旧复盘不加（dailyReview.js decorateWatchPool），不猜股票代码。
- [ ] 分时是否真实分钟级、且来源与口径日如实？`Context.intraday` 必带 source/date/dateMatches，降级必带 degradedFrom；快照不出现「分时明细数据缺失 / 按 OHLC 还原」（test_stock_review.js §1/§6/§6b、test_e2e_chains.js §B/§F）。
- [ ] 分钟点是否被压缩进 Context？只允许结构化特征，禁止 raw points 数组注入 LLM（test_e2e_chains.js §B）。
- [ ] 结构版本升级后，复用侧是否比对 schemaVersion？generateReview / runPoolBatch / 两个 GET 读取路由三处同口径（20261111c 缓存漏洞回归）。
- [ ] 颜色纪律：评级 S/A=红、B=中性灰、C=绿；放弃信号=绿；警告横幅=绿（利空绿）；注入样式一律 var() 令牌（stockReviewUI.js ensureStyles）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 复盘落盘目录 | data/stock-reviews/（可用 SA_STOCK_REVIEW_DIR 覆盖） | lib/stockReview.js:34 |
| 大盘复盘目录 | data/reviews/（可用 SA_REVIEW_DIR 覆盖，与 reviewService 同源） | lib/stockReview.js:38 |
| LLM 单次超时 | 300000ms | TIMEOUT_MS |
| 整链路预算 | 360000ms（超时 + 60s 重试余量） | OVERALL_BUDGET_MS |
| 消息面条数 | 10 | NEWS_LIMIT |
| 观察池最大行数 | 20（解析）/ 12（批量生成） | parseWatchPool / runPoolBatch |
| 定时槽 | 20:35（Asia/Shanghai） | server.js REVIEW_SLOTS |
| 结构版本 | stock-review-20261111d（Context 新增 intraday 分钟级分时） | SCHEMA_VERSION |
