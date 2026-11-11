# SESSION-STATE.md（WAL — Write Ahead Log）

> 本文件遵循 `proactive-agent` 技能：用户给出口径决策 / 纠正 / 偏好时，先落盘再实现。
> **行文口径（2026-11-10 19:10 用户裁决 · 归档瘦身，先落盘再执行）**：
> ① 每条只写「决策要点 + 涉及文件 + 状态」，5~10 行内；原话长文 / 完整实施清单写进 `docs/logic/` 或本目录归档后只留一行指针。
> ② 验证按需：小改动只跑直接相关守卫 + `test_cache_bust_guard.js`；全量 `--quick` 只在用户说「同步」前跑一次。
> ③ 技能提炼只在用户明确说「沉淀成技能」时做，不自动提炼。
> ④ `.learnings/` 每月归档一次：主文件保持索引态，全文进 `archive/`。
> 完整历史条目（2026-11-09 ~ 2026-11-10 全部旧口径与实施清单）已归档：`.workbuddy/memory/session-state-archive-20261110.md`。

## 当前状态（2026-11-10 22:05）

- **未同步**：本地约 60 个文件（复盘 20261110b/c/e + 量能口径 + 颜色语义 + 个股复盘新模块 + 本会话归档瘦身）已完成、**未 git commit/push**，等用户「同步」指令。
- **服务**：3005 未运行；`APP_VERSION=20261110f`（阶段 0 已 bump）。重启生效：关旧服 → 双击桌面 Stock Analyzer.lnk → Ctrl+F5。

## 阶段 1（P0）进行中（2026-11-10 22:2x 开工 · WorkBuddy 会话）

- **依据**：`docs/整改方案-20261110.md` v1.1 阶段 1；阶段 0 已由前会话完成（B0-1~9 落盘、601318 端到端 degraded=false、20261110f）。
- **范围**：P0-1 前视偏差 asOf 结算侧审计（4 条结算链：sameDayJudgment / marketTechJudgment / techFaceJudgment / sentimentAccuracy）→ P0-2 准确率三基准对比 → P0-3 代理口径三态角标（展示层，裁决③）。
- **裁决④ 纳入**：P0-1 落地后历史准确率回算 + 新旧对比报告。
- **计划落点**：拟新建 `lib/lookahead.js`（asOf 校验/lookahead_excluded 单一真值源）+ `docs/logic/common-06b-lookahead.md` 审计结论表 + `scripts/accuracy_backtest_report.js`（回算对比）+ dataHonesty 三态扩展。
- **验收口径**（方案原文）：补录数据不可得夹具→结算如实排除断言进各守卫；基准值可手算复核；样本<30 明示；历史已结算不悄悄剔除（lookahead_excluded 计入不可比样本披露）。
- **状态**：WAL 已落盘，审计进行中。未 git 同步。

## 2026-11-10 全面整改（用户裁决 22:0x · 方案 v1.1）

- **背景**：用户要求「全面弥补缺陷」（基于 docs/code-review/ 外部评审 + 本会话核实）；顺序按方案建议；前视偏差只做结算侧；个股复盘与大盘复盘打通联动（WorkBuddy 已落 20261110e 第一版）；先不同步。
- **完整方案**：`docs/整改方案-20261110.md`（v1.1，含现状审查 9 项问题 ①-⑨ 与四阶段计划）。
- **用户四项裁决**：① 观察池加「代码」列（升大盘 SCHEMA，旧落盘兼容不重跑）；② 定时自动跑=仅大盘观察池（不含 watchlist）；③ 代理打标只做展示角标（不进打分，观察一月）；④ 历史准确率按新口径回算 + 新旧对比报告。
- **执行顺序**：阶段 0（个股复盘联动收尾 B0-1~B0-9，修 ①-⑨）→ 阶段 1（P0：asOf 结算侧 / 准确率基准 / 代理角标）→ 阶段 2（P1：inflight 收口 / 版本戳自动化 / taxonomy 常量单源 / store.js 原子写）→ 阶段 3（P2：E2E 固化 / 结构化日志+健康面板 / 因子相关性报告）。

### 阶段 0 实施记录（20261110f · 本会话）

- **B0-1 缓存键**：generateReview 先 resolveSymbol 再查缓存；名称入口不再每次重跑 LLM；落盘新增 resolve{input,resolved,ambiguous} 留痕。
- **B0-2 代码列**：大盘复盘提示词表 2 改 6 列（股票名称|代码|入选原因|评级|明日观察什么|放弃跟踪的信号，代码必须来自 JSON）；parseWatchPool 表头检测兼容 code6/legacy5；stock-review SCHEMA 升 20261110b；复盘 Context SCHEMA 升 review-llm-20261110c（history.stockMarks 结构变更）。
- **B0-3 双向联动**：大盘页观察池表每行「个股复盘 →」直达（dailyReview.js decorateWatchPool，仅带代码列的表）；app.js 识别 #stockreview 自动切 tab；反向注入 history.stockMarks（reviewService→reviewContext，只带计数/枚举）；大盘提示词新增「观察池落地核对」一句话规则。
- **B0-4 定时批量**：server.js 新增 20:35 stock_pool 槽 → stockReview.runPoolBatch(today)：幂等（当日已有即跳过）、串行、单只失败不阻塞、非交易日跳过；范围仅大盘观察池（按裁决）。
- **B0-5 参数守卫**：symbol 限 [0-9A-Za-z.]{1,12}、date 限 YYYY-MM-DD，6 条路由非法即 400。
- **B0-6 超时**：stockReview 单次 300s + 整链路预算 360s（overallBudgetMs），防串行多次超时白等；**真实端到端已成功**：601318 中国平安 2026-11-10 卡片 degraded=false、模型 deepseek-v4.1-flash-1017、29.7s、2096 字，评级 B 抽取正确、快照无对象 dump（data/stock-reviews/601318/2026-11-10.json）。
- **B0-7 快照回归**：test_stock_review §6 断言无 [object Object]/raw JSON、成交额亿单位；新增 §7 联动结构、§8 颜色纪律、§9 缓存键/批量幂等/反向联动异步实测。
- **B0-8 颜色合规**：stockReviewUI 注入样式全部改 var() 令牌；评级 S/A=红、B=中性灰、C=绿；放弃信号=绿；警告横幅=绿（利空绿）。
- **B0-9 文档**：docs/logic/README 清除 stock-16 残行、登记 stock-23-stock-review.md；新建该反向逻辑文档（七节齐备）。
- **版本戳**：APP_VERSION + 全部 HTML ?v= + 相关守卫断言统一 20261110f。
- **验证**：test_stock_review 68/0、test_daily_review 30/0、test_cache_bust_guard 3/0、test_consistency_audit 32/0、test_volume_single_source 64/0 等 20 个关联守卫全绿；node --check 7 个改动文件全过。
- **状态**：阶段 0 完成，**未 git 同步**。下一步阶段 1（P0-1 asOf 结算侧审计）。

## 2026-11-10 三件裁决（按时间倒序）

### 19:10 · 技能瘦身（归档执行记录）

- 用户裁决：保留 proactive-agent / selfimproving 机制，只做一次归档瘦身。
- 已完成：
  - `.learnings/LEARNINGS.md` **307KB → 14.9KB 索引态**（54 条：待办 2 + 已解决 52，每行 ID/日期/状态/摘要首句）；全量逐字在 `.learnings/archive/LEARNINGS-full-20261110.md`（307KB），按 ID grep 找回。
  - `SESSION-STATE.md` 压缩为本要点版；逐字原件在 `.workbuddy/memory/session-state-archive-20261110.md`。
  - 新条目口径与验证降级、技能冻结写入上方「行文口径」。
- 待观察项（非缺陷）：`LRN-20261103-001 pending`（位置驱动展示分支第 3 次同类报障）、`LRN-20261106-005 active`（守卫版本戳负断言需指向上版）。

### 17:39 · 20261110c 复盘排版微调（详见归档）

- `prompts/daily-review-system.md`：`###` 标题骨架 + 两张强制表（题材归因卡 / 明日观察池）= 排版升级，不退回干卡片。
- `dailyReview.js`：旧 `sections` 兼容还原为 Markdown（历史复盘无需重跑）；`loadByDate` 记 `S.date`；`rerun()` 加 `force`；日期输入即自动加载，删除「按日期查看」按钮。
- `reviewService.js`：`runReview` 的「complete 不降级」跳过加 `&& !opts.force`。
- `?v=` / `APP_VERSION` → 20261110c，守卫同步。

### 16:03 · 20261110b 复盘架构反转（详见归档）

- 删除 `lib/reviewOutput.js`；新建 `lib/reviewContext.js`（干净 JSON）、`lib/reviewLlm.js`（System Prompt + Context → callLLM → Markdown）、`public/js/markdown.js`（本地随包渲染）。
- `reviewService.js`：落盘整篇 Markdown + Context + llm 元信息；取消硬质检（柔性「暂无数据」）；龙虎榜补录并入 Context 重新生成整篇；`SCHEMA_VERSION=review-llm-20261110b`。
- 实测（非自称）：Context 88KB 曾致 240s 超时 → 加字段白名单 + 12000 字符预算闸后 11133 字符；`deepseek-v4-pro-0813` 142s 返回 1860 字 Markdown，落盘 `outputFormat=markdown`、`versionHasContext=true`。
- 状态：未 git 同步。

## 归档指针（历史裁决，勿按旧口径实现）

- **2026-11-10 12:07「11 段规格」+ 15:40 实施记录** → 已被 16:03 架构取代；规格原文唯一权威副本仍在 `docs/logic/daily-review-spec-20261110.md`，旧口径全文在归档文件。
- **2026-11-09 量比图 ÷20（`ratio20Series`）** → 已完成验证（图表 26/0、量能 64/0、一致性 228/0），待同步；旧实施清单在归档文件。
- **2026-11-09 颜色铁律细分（验证/核对类字段默认字体）** → 已完成验证（颜色语义 153/0），待同步；旧实施清单在归档文件。

### 22:50 · 20261110g 阶段 1（P0）实施完毕（整改方案 v1.1，Claude 接手 DeepSeek 阶段 0 之后）

- **P0-1 前视偏差 asOf 结算侧审计**：
  - 新建 `lib/lookahead.js`（单一真值源）：`auditSettlement` L1（财报披露日>asOf）/L2（settledAt 早于目标日）/L3（内嵌时间戳超窗，`ROLLBACK_GRACE_DAYS=1` 跨时区宽限）；`markSettlement` 结算挂钩（违规打 `lookaheadExcluded` 不悄悄剔除，修复后显式清除留痕）；`splitComparable` + `incomparableDisclosure`。
  - 四链挂钩：sameDayJudgment（window=4）/sentimentAccuracy（3）/techFaceJudgment（HORIZON×2+2）/marketTechJudgment（MID_HORIZON×2+2）settleRecord/settleSymbol 均已接入。
  - 审计结论（实查代码 + 399 条历史记录全量抽审）：四链**结算计算本体无前视**（只消费 K 线收盘价+交易日历）；风险在记录内容侧因子快照无逐项可得时间戳（实测 8 因子 0 ts），本轮如实披露、不补造时间戳。结论表 `docs/logic/common-06b-lookahead.md`。
- **P0-2 准确率加基准对比**：
  - 新建 `lib/baselines.js`：方向基准（样本内永远涨命中率）/随机 50%/5 日动量基准（`momentumSignal`，震荡容差 0.5%）；样本<30 明示；月分组 `refreshMonthState`（上证日 K 月度聚合 >±1% 分类，落盘 `data/market-month-state.json`，权威刷新点=marketTechJudgment.settleAll）。
  - 四链 computeAccuracy 统一输出 `baselines` + 前视披露 + `accuracyIncludingLookahead` 旧口径留档。
  - 前端：accuracy.html 四面板加 `renderBaselines`（三基准并列 chips + 跑赢/跑输语义 + 前视披露行 + 月分组 `<details>` 表）。
  - **裁决④回算报告**：`scripts/accuracy_backtest_report.js`（只读，不改落盘）→ `docs/accuracy-backtest-report-20261110.md`。结果：sameDay 51.7%（方向基准 41.7%/动量 43.4% n=369）；marketTech 42.4%（0%/48.5%）；techFace **25.1%，大幅跑输方向基准 41.6%**（动量 51.1% n=219，已修目录路径 `data/tech-face`）；sentiment 35.5%（16.1%/29%）；四链新旧口径差异 0pp、排除 0 条。
- **P0-3 代理口径分级打标（裁决③：只做展示角标，不进打分）**：
  - `lib/dataHonesty.js` 扩展 `PROXY_REGISTRY` 六项 + `observedTag/proxyTag/missingTag`（proxyTag 未知 key throw 防漂移）。
  - 产出侧接线六处：reviewEngines（big-drop-def C5 / liquidity-line V6）、topicEngines（sector-core-proxy midCapOf / zt-pool-market 题材卡）、reviewContext（lhb-keyword lhbBlock）、server.js buildHomeMarketEmotion 降级路径（single-stock-heat 完整 proxyTag）。零 require 模块用轻量 `proxyKeys` 契约（铁律保持）。
  - 前端：新建 `public/js/honestyBadge.js`（PROXY_LABELS 前后端一致 + 中性色角标），app.js 情绪卡接入（marketEmotionModel.calcDiscussionHeat 透传 honesty），`style.css` `.honesty-badge` 中性灰蓝（禁红涨绿跌语义色）；加入 FRONTEND_BUST_FILES。
- **版本戳**：APP_VERSION + 全部 HTML ?v= + 22 守卫断言 → 20261110g（威高守卫历史落盘版本 20261104i 断言保持不动，测试名修正为明确表述）。
- **守卫实跑**：test_lookahead_guard 26/26、test_data_honesty 17→48/48、test_cache_bust_guard 3/0、+26 个 bump 关联守卫全绿（见 docs/test-inventory.md 20261110g 更新段）。
- **未做（如实）**：服务端改动需重启 3005 端口才生效（待用户三步启动仪式）；月表 `data/market-month-state.json` 待重启后首次 settleAll 刷新；techFace 25.1% 跑输基准的处置待用户裁决；**未 git 同步**。

### 23:06 · 阶段 2（P1）开始（WAL 先行）
- 依据：用户指令「继续下一阶段的整改」；方案阶段 2 = P1-1 singleflight 收口 / P1-2 版本戳自动化 / P1-3 常量单源 / P1-4 store.js。
- 计划：P1-1 新建 lib/inflight.js + 收编 6 处散装 + 单测；P1-2 bump_version.js 幂等 + 因子结构哈希；P1-3 lib/taxonomy.js + 新守卫 + 合规词扫描；P1-4 lib/store.js + 四类核心迁移。
- 风险控制：收编必须等价改造（原测试不回归）；LLM 在途合并仅合并「完全相同请求」，force 重跑路径必须绕过。
- 状态：进行中。

### 23:45 · 20261110g 阶段 2（P1 工程降本）实施完毕

- **P1-1 singleflight 收口**：新建 `lib/inflight.js`（inflight/has/get/clear/activeCount；settle 自动释放；maxMs 软超时只释放 key 不中断在途 I/O；异常透传）。6 处散装实现全部等价收编：stockData._thsRawInFlight（Map→key 合并）/ etfFlow（单值）/ reportSync（Set 互斥→has 拒绝 + singleflight 任务体）/ sectorCapitalFlow / usTreasury（refresh 覆盖=clear 后重发；race 返回即释放=finally clear，保语义）/ hotTopicsWeekly（isCollecting→has）。**新增接入（LLM 哈希合并 / 深度分析同 symbol / 板块回补）本轮未做**——LLM 在途合并需先确认 force 重跑绕过语义，等用户裁决后下轮接。守卫 test_inflight 17/17。
- **P1-2 版本戳自动化**：新建 `scripts/bump_version.js`（幂等 + --dry-run；**行级限定替换**——仅 APP_VERSION/?v= 语境行内替换，杜绝上轮裸 token 误伤历史条目类问题）；reviewLlm.js + stockReview.js 落盘元信息新增 promptSha1（System Prompt sha1 前 8 位，提示词变更可追溯）；server.js 启动自检（扫描落盘记录中早于当前版本日期的文件计数，只打印不阻断）。**因子结构哈希替代手写 LAYOUT_VERSION 未做**——涉及 SCHEMA 复用语义（rec.schemaVersion===SCHEMA_VERSION 复用条件），需与用户确认口径后动。
- **P1-3 常量单源**：新建 `lib/taxonomy.js`（震荡容差显式两常量 FLAT_TOLERANCE_STOCK=1.0 / INDEX=0.5，禁止第三种取值；LEARN_MIN_SAMPLE 三处分立登记 5/20/15——语义不同绝不硬并；评级三档 + 合规禁用词表 + 目标价估值语境豁免清单）。迁移：四链容差定义 + sameDayJudgment 两处内联 1.0 魔数 + 三处 LEARN_MIN_SAMPLE 全部改引 taxonomy。**合规词扫描真修复两处**：deep/conclusion.js「建议减仓或观望」→中性表述；marketEmotionModel.js「建议仓位 X」→「模型测算仓位参考 X（非操作建议）」。守卫 test_single_source_taxonomy 20/20（含全站扫描，否定语境+研报转述+估值计算豁免）。
- **P1-4 store.js**：新建 `lib/store.js`（readJsonSafe 损坏留痕回退不臆造 / writeJsonAtomic tmp+rename 原子写失败不 throw）。四类核心迁移：sameDayJudgment 五处读+五处写（ judgments 历史损坏故障根源已堵住（损坏留痕+原子写））、stockReview、reviewService（手写 tmp+rename 收编）、manualZones。守卫 test_store 16/16。
- **回归**：15 守卫全绿合计 438 断言（cache_bust/inflight/store/taxonomy/us_treasury/hot_topics×3/etf_flow/stock_review/daily_review/market_emotion/emotion_consistency/lookahead/data_honesty）。
- **未做（如实）**：P1-1 新增接入三项、P1-2 因子结构哈希；服务端改动需重启生效；**未 git 同步**。

### 23:39 · 用户裁决到达（P1-1 LLM 合并口径 + P1-2 因子哈希口径）+ 执行注意事项清单
- 裁决①：LLM 在途合并——force=true 走 bypass（不进表不查表直接执行）；非 force 走原表；流式不做 inflight；前端 disable 防连点。
- 裁决②：因子哈希两段式 h{factorHash}-{LAYOUT_VERSION} 并存；factorHash 覆盖所有可序列化数值口径（阈值/权重/子权重/事件封顶/评级档位）；LAYOUT_VERSION 只兜计算逻辑变更；_normalize 处理排序/浮点精度/undefined 三坑；schemaVersion 不等即重算。
- 清单落地点（本轮顺路实施低成本项）：store tmp 随机后缀；bump 脚本 FRONTEND_BUST_FILES 差集提示；taxonomy 扫描排除注释行/禁用-审查两级；dataHonesty proxy 加 since + observed 判定注释；两个预留开关（DATA_HONESTY_PROXY_IN_SCORE / ACCURACY_CALIBER）；P0-2 前端补「基准对比仅作方向参考」文案；20:30/20:35 定时撞车检查。
- 顺序：WAL → ①LLM inflight（LLM 通道→深度分析→板块回补→前端 disable）实跑 → ②因子哈希实跑 → 清单补强项实跑 → 汇报。一次一个变量。

### 23:55 · 两项裁决实施 + 执行清单补强完毕（进行中汇总，等 run_all_tests --quick 收尾）

- **裁决① LLM 在途合并（已落地）**：lib/ai/llm.js callLLM 通道层合并（哈希=provider+model+messages+webSearch/mxQuery/mxInject；timeout/budget 不进 key）；bypass 口径=opts.force=true 或 STREAM_ONLY_MODELS；软超时 6min。force 透传链：reviewService.generate({force})→reviewLlm→callLLM；stockReview.run({force})→llmGenerate→callLLM。深度分析同 symbol：deep/pipeline.deepAnalysis 加 inflight（force 绕过）。板块拥挤度回补：sectorCrowding.backfillHistory 由布尔互斥收编为 inflight（等待者共享结果，3 处调用方均只消费结果对象，行为兼容）。前端防连点：实测 dailyReview.js rerun 与 stockReviewUI.js setBtnBusy 已有 disabled，无需新增。守卫：inflight 17 + stock_review 68 + daily_review 30 + hot_topics_stale_fix 6 全绿。
- **裁决② 因子哈希两段式（已落地）**：新建 lib/factorHash.js（_normalize 三坑：对象键排序/浮点 1e-6/undefined+null+缺失三者归一删键；数组保序）。sameDayJudgment._hashFactorStructure 扩展 payload：因子名/权重/子权重（8 项 SUB_W）/跷跷板阈值/事件封顶（eventEngine.defaultConfig gradeRanges+severity+原油三系数）/评级档位/震荡容差。SCHEMA_VERSION=h{8hex}-{LAYOUT_VERSION}（机制原已存在，本次扩覆盖面）；复用条件 rec.schemaVersion===SCHEMA_VERSION 不变（不等即重算）。⚠️ 预期行为：重启后当日判断按新哈希全量重算一次。守卫 test_factor_hash 22/22（新建）。
- **执行清单补强（全部落地）**：① store tmp 后缀 pid+时间戳（防并发踩踏）；② bump_version.js 白名单差集检查（发现并补齐 9 个缺失文件：dataStatus/docStore/etfFlowPage/export/homeHotTopics/homeNews/homeRank/judgments/storage → 26/26 无差集）；③ taxonomy 守卫扫描排除注释行 + 禁用/需审查两级（需审查只告警）；④ dataHonesty PROXY_REGISTRY 六项加 since + observed 判定基准写死注释 + 预留开关 DATA_HONESTY_PROXY_IN_SCORE=false；⑤ lookahead 预留开关 ACCURACY_CALIBER='asOf'；⑥ accuracy.js 基准对比条补「仅作方向参考，不构成统计显著性」文案；⑦ 定时撞车修正：20:35 个股复盘批量 → 20:45（与 20:30 龙虎榜补录 LLM 重生成间隔 15 分钟）。

### 2026-11-11 · run_all_tests --quick 收尾：123/123 全绿（阶段 1 + 阶段 2 + 两项裁决全部完成）

- **第 5 个失败分诊（颜色语义守卫）**：归属=守卫过时（非本轮引入）。dailyReview.js 已按用户 2026-11-10 裁决重写为「Markdown 直出版」（20261110b），旧 colorize/semanticText/colorizePrice/renderCell/quads 逐字段着色体系整体删除，test_color_semantics.js L3/L4b 断言指向已不存在的结构 → ReferenceError。处置：守卫更新（非收编）——L3 删旧接线断言，改为「方向着色不回潮」三守卫（无着色函数/无 dr-up|dr-down/无红绿硬编码）+「Markdown 来源不可信走 esc 转义兜底」；L4b vm 沙箱改验 markdownHtml（HTML 注入转义/空正文 dr-empty）+ legacySectionsToMarkdown 兼容还原。更新后 148/148 全绿。
- **前 4 个失败**（前次已修）：manualZones 参数遮蔽 ×2（代码修复）、swallow 启动自检兜底（收编基线 137→138）、volume_migration 守卫正则脆弱性（守卫改单行精确比对）。
- **全量 quick**：123/123 通过，跳过 13（需网络）。docs/test-inventory.md 补记 color_semantics 更新条目。
- **阶段 1（P0）+ 阶段 2（P1）+ 两项裁决 + 执行清单 7 项补强：全部落地。**
- **未做（如实）**：服务端改动需重启 3005 才生效（待用户三步启动仪式；重启后当日判断按新哈希全量重算一次属预期）；techFace 25.1% 跑输基准待用户裁决；**未 git 同步（等指令）**；阶段 3（P2：E2E 固化/可观测性/因子相关性）未开始。

### 00:39 · techFace 25.1% 归因诊断开始（WAL 先行，用户长文清单驱动）
- 输入：用户长文「归因脚本与处置裁决」——先钉 41.6% 口径 → 跑 scripts/analyze_techface.js（只读不改业务逻辑）→ 按裁决树判（样本量→基准口径→震荡占比→反转→二分类）→ 临时处置（accuracy 页实验组角标；影子模式视消费方而定）→ 文档留痕。
- 口径已钉死（查证非猜测）：41.6% = lib/baselines.js directionBenchmark note='永远预测涨'（alwaysUp，实际涨占比），回算报告列名「方向基准（永远涨）」。非「永远震荡」/「多数类」/「同期指数」。
- sameDayJudgment 不消费 techFace 数据（grep 确认仅共用日历注释）→ 影子模式不适用，临时处置只剩 accuracy 页角标。
- 纪律：脚本只读；一次一个变量；结果出来前不改 normalizeDir/FLAT_TOLERANCE/SCHEMA_VERSION。

### 01:20 · techFace 25.1% 归因裁决落地（用户长文裁决树第 2 关命中 → 改口径重测，全部完成）

- **口径钉死**：41.6% = baselines.directionBenchmark「永远预测涨」（实际涨占比）；多数类（永远跌）58.0%；永远震荡 0.5%。
- **归因**（scripts/analyze_techface.js 只读诊断，n=219）：根因 = normalizeDir 把「震荡偏上(dirScore>0)/偏下(dirScore<0)」归震荡 → 预测震荡 86.8% vs 实际震荡 0.5%；反转测试 5.0%（非判反）；二分类 65.5%（方向判断有效）。
- **处置**：normalizeDir 新口径（偏上→涨/偏下→跌）+ techFace 首次引入 schemaVersion='tf-20261111a' + scripts/migrate_techface_dir_schema.js 历史迁移（备份 data/tech-face-backup-20261111a/；186 条重映射、218 条重判、94 条翻转、幂等 0 改动）。迁移后实测 57.1%（125/219），跑赢永远涨 41.6% 与动量基准 51.1%。
- **配套**：test_tech_accuracy 断言同步（34/34）；accuracy 页 techFace 面板加口径变更诚实披露条（后视偏差 + 多数类 58.0% 仍略高，不宣称真实优势）；bump 20261111a（31 文件 + 4 个版本断言守卫同步）。
- **实跑**：quick 123/123 全绿；回算报告刷新（techFace 57.1%，其他三链不变=隔离验证通过）；文档 docs/logic/stock-08-technical.md 加「准确率归因记录」节。
- **未做（如实）**：服务端改动需重启 3005 生效（normalizeDir 新口径 + schemaVersion 落盘）；影子模式不适用（sameDayJudgment 不消费 techFace）；前向验证需样本积累；**未 git 同步**。

### 11:40 · 用户执行确认（A 级）+ 三件事落地完毕（版本 20261111b）

- **精准表述修正（立即做项）**：accuracy 页 techFace 披露条追加多数类基准对照——「57.1% 与多数类基准（永远跌 58.0%）持平，未跑赢；跑赢方向基准 41.6% 主要来自不再系统性预测震荡，不构成预测力证据」。bump 20261111b（31 文件 + 4 版本断言守卫 sed 同步）；cache_bust 3/0、color_semantics 148/0、quick 123/123（safe-delete 偶发拦截重跑自愈，与本轮无关）。
- **前向验证计划细化（本周项，本轮完成）**：stock-08-technical.md 复核条款细化为起点 2026-11-12 / ≥30 条门槛 / 55%~45% 双阈值三档判定；techFaceJudgment.js verdictOf 旁加同口径注释。
- **横向审计四条链（本周项，本轮完成）**：marketTech（上游只产三态词，强空/偏空→跌方向保留，无缺陷）、sentimentAccuracy（level 强度与 impliedDir 方向分离，无缺陷）、sentimentTurningPoint（方向走布尔+动量 sign，无归一化丢弃）、sameDayJudgment 参照（±0.5 加权保留方向）。结论：仅 techFace 有过丢向问题（已修），证据表写入 common-07-guards.md。
- **归一化审计规则新增**：common-07-guards.md——任何 normalize*/classify*/toTier*/map* 必须回答「输入方向/强度/来源信息是否被丢弃」，保留或注释声明，禁止无注释静默丢弃；对新审计与改动生效，不追溯。
- **backlog（本轮不做，按用户指示归 P1-2）**：techFace SCHEMA_VERSION 纳入两段式 factorHash；bump_version.js 版本断言 token 扫描（列清单确认制）。
- **未做（如实）**：服务端注释改动需重启生效；**未 git 同步**。

### 11:55 · 用户二次确认 + P0 迁移标记落地（版本不变，schema 补丁）

- **P0 migrated 标记（方案 A）**：migrate_techface_dir_schema.js 给迁移历史记录打 migrated: true + migratedAt + migratedFrom{normalizeDir, shortRaw}（幂等复跑 0 改动；261 条覆盖，另 2 条为 TFA_TEST_ 测试夹具无 shortRaw 不参与）。前向样本口径 = filter(!r.migrated && r.settled)；analyze_techface.js 新增 --forward 模式（前向命中率 + 30 条门槛 + 三档自动判定），当前 0 条前向样本正确提示「样本积累中」。stock-08-technical.md 前向计划补「前向样本界定」行。
- **尾巴 1 trendLabel 确认完毕**：判定层辅助——midDir 消费「上涨/下跌」子串（marketTechnical.js:521-522）；「偏强/偏弱震荡」不含子串不参与方向（保守设计 ADX 临界不确认趋势）；midRaw 落盘词与 normalizeDir 词表一一对应无信息损失，与 techFace 丢弃不同构。结论写入 common-07-guards.md 审计表，n=33 不足纳入前向观察。
- **归一化审计规则补执行机制**：code review 执行、不设自动化守卫（丢弃合理性无法静态判断）；新模块审计清单必含逐函数人工确认项；改动归一化函数必须声明「是否影响方向/强度保留」；标准动作=代码级+样本级双证据。
- **[backlog] P1-test-isolation-audit**（合并自「600test.json safe-delete」+「test_stock_log 间歇失败」两条；**现归类「未覆盖·需单独排期」，建议归属 P2-1**，见文末 Backlog 段）：**根因已用现场快照实锤**——test_stock_log.js:18 clean() 在拆卸时直接 unlink/trash `data/stock-log/600test.json`，触发 WorkBuddy `node-safe-delete-shim` 批量删除守卫 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（count:50/threshold:50/scope:"turn"）；间歇因整轮测试累计删除跨阈值才抛。修复方向：测试改用 SA_DATA_DIR 临时目录（P1-4 的 store.js 原子写 ≠ 测试隔离修复）。下次出现不再「复跑自愈」，先看 `data/test-scenes/scene-*/` 快照。
- **下一步**：11-12 起积累前向样本；周日/周一首次前向检查（node scripts/analyze_techface.js --forward，样本可能不足 30，看趋势不判定）。
- **未做（如实）**：未 git 同步。

### 12:05 · 用户二次补丁点落地（P0 两处 + P1 副指标，schema 补丁，版本保持 20261111b）

- **补丁 1（TFA_TEST_ 夹具污染前向）**：migrate_techface_dir_schema.js 新增 fixture 分支——无 shortRaw 且 symbol/name 以 TFA_TEST_ 开头的 2 条夹具打 migrated:true + migratedFrom:{reason:'test_fixture'}（方案 A，语义统一，前向 filter 保持单一条件）。复跑 2 条打标、幂等 0 改动；--forward 现正确显示「263 条已排除（含 TFA_TEST_ 夹具 2 条）」、0 条前向样本。
- **补丁 2（42 条待结算口径）**：grep 确认 techFaceJudgment.js:239 settle 判 correct 时**不读 migrated**，全部按新 normalizeDir 口径——261 条（218 已结算+42 待结算）内部口径一致，migrated:true 仅作前向排除。stock-08-technical.md 前向计划表补「42 条待结算迁移记录口径」行 + 「前向副指标」行。
- **P1 前向副指标**：analyze_techface.js --forward 新增两行——① 前向震荡预测占比（>60% 预警过度保守）；② 前向多数类基准（永远跌）差（<5pp 预警未跑赢多数类）。防「命中率虚高但没 alpha」陷阱（本轮 techFace 原病=预测震荡 86.8% vs 实际 0.5%）。
- **提醒落实**：techFaceJudgment.js 无 cache/memo（无内存缓存，per-request 读磁盘）→ 打标后无需重启；data/tech-face 在 .gitignore（git status 0 条 data diff）→ 同步不巨型 diff，他端 re-run 幂等迁移脚本即可。
- **实跑**：quick 123/123（首次 test_stock_log 间歇失败，隔离跑 66/0、复跑 123/123 自愈，与本套已知 safe-delete 竞态同性质，非回归）。
- **未做（如实）**：未 git 同步（data 入 ignore，仅脚本+文档入仓）；无 lib 业务改动、版本戳保持 20261111b、无需重启。

## Backlog（待办 · 已消除悬浮态，逐条归类）

> 2026-11-11 12:13 用户裁决：禁止「已归属已完成阶段但未启动」的悬浮态。P1-2/P1-4 虽标记完成，但其交付物**未覆盖**下列增强项，故统一归类为「未覆盖 · 需单独排期」，不挂回已完成阶段。

- **P1-test-isolation-audit** — 状态：**未覆盖 · 需单独排期（建议归属 P2-1）**。根因已实锤（20261111c 现场快照）：test_stock_log.js:18 拆卸时直接 unlink/trash `data/stock-log/600test.json`，触发 WorkBuddy `node-safe-delete-shim` 批量删除守卫（count:50/threshold:50/scope:turn），间歇因整轮累计删除跨阈值。**P1-4 的 store.js 原子写 ≠ 测试隔离修复**（store.js 是产品代码 IO，不解决测试写真实 data/）。修复：测试改用 SA_DATA_DIR 临时目录。用户建议：阶段 3 启动时改归 **P2-1**（做 E2E 顺手用 SA_DATA_DIR 解决，比单独立项成本低）。当前仍为悬浮→已落地为明确排期项。
- **techFace SCHEMA_VERSION 纳入两段式 factorHash** — 状态：**未覆盖 · 需单独排期**。裁决② 已交付通用 `lib/factorHash.js`，但 techFace 仍用手写 `tf-20261111a`，未接入。属 P1-2 范围外的增强，非 P1-2 交付遗漏。
- **bump_version.js 版本断言 token 扫描** — 状态：**未覆盖 · 需单独排期**。P1-2 已交付 bump 行级限定替换，但「扫描全站 `/"20\d{6}[a-z]"/` 形态 token 列清单确认」未做。属 P1-2 范围外增强。
- **阶段 3（P2：E2E 固化 / 可观测性 / 因子相关性）**：**未启动**；P1-test-isolation-audit 计划在此阶段 P2-1 一并处理。

## 纪律变更（20261111c · 落实现场快照机制后）

- `run_all_tests.js` 现于任一测试失败时把全量输出 + 环境（时间/git commit/node 版本/模式）快照到 `data/test-scenes/scene-<时间戳>/`（每失败测试一个 .log + index.json），保留 3 天自动清理。
- **新纪律：遇到间歇失败，先查 `data/test-scenes/scene-*/`，不复跑自愈。** 首次实锤：test_stock_log.js 间歇失败根因 = 测试拆卸删 600test.json 触发 safe-delete 守卫（见 P1-test-isolation-audit）。

### 12:15 · 同步前补实跑证据 + 全量冒烟 + backlog 悬浮态消除

- **逐项实跑证据（20261111c，真实跑数非引用历史）**：P1-1 inflight 17/0；P1-3 taxonomy 20/0（含 §4 全站合规词扫描子断言）；P1-2 版本戳缓存破坏同步 54/0（test_volume_caliber_warn，非合规词扫描）；P1-4 store 16/0；P1-2 factorHash 22/0 + bump 缓存破坏 3/0；P0-1 lookahead 26/0；P0-3 dataHonesty 48/0；P0-2/展示 color_semantics 148/0；techFace 专项 tech_accuracy 34/0。全量 run_all_tests --quick = **123/123 通过**（跳过 13 需网络），无快照落盘（绿跑不落盘）。
  - ⚠️ 证据表纠错（12:45）：上轮误将 test_volume_caliber_warn 的 54/0 标为「P1-3 合规词全站扫描」；实测该文件仅做「§6 版本戳与缓存破坏同步」断言，合规词扫描归属于 test_single_source_taxonomy 的 §4 子断言（含于其 20/0）。已更正。
- **启动冒烟**：端口 3005 已在监听（PID 3080，既有实例）；根路径 HTTP 302（正常重定向主面板）、/api/sameday-judgment/601318 HTTP 200（API 正常服务）。冒烟通过。⚠️ 该实例为既有进程，最新代码（techFace 归一化/迁移标记/accuracy 披露条）需三步启动仪式重启才生效。
- **backlog 悬浮态消除**（用户 12:13 裁决）：原「归属 P1-2/P1-4 但未启动」三项改为逐条归类——P1-test-isolation-audit / techFace 纳入 factorHash / bump 版本断言扫描 均为「未覆盖·需单独排期」（P1-2/P1-4 的交付物不含这些增强，非遗漏）。P1-test-isolation-audit 按用户建议改归 **P2-1**（阶段 3 做 E2E 顺手用 SA_DATA_DIR 解决）。无「已归属但未启动」悬浮态残留。
