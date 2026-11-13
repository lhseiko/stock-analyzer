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

- **P1-test-isolation-audit** — 状态：**已解决（P2-1 批次 1 · 20261111d 落地）**。根因已实锤（20261111c 现场快照）：test_stock_log.js:18 裸 `unlinkSync` 删 `data/stock-log/600test.json`（无 try/catch），全量 28+ 测试累计删除跨沙箱守卫阈值 50 → 守卫抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，唯独本测试裸删崩溃（其余 27 个均包 try/catch 存活）。20261111d 已落地：新建 `lib/dataDir.js`（`getDataDir()` 调时读 `SA_DATA_DIR`）+ `lib/stockLog.js` 经其解析 `DIR` + `test_stock_log.js` 顶部设 `SA_DATA_DIR=os.tmpdir/sa-stocklog-test-<pid>`（项目外临时目录，不进守卫统计）且 `clean()` 包 try/catch。验证：test_stock_log 66/0、全量 123/123、无快照。生产零行为变更（SA_DATA_DIR 不设 → 仍真实 data/stock-log）。
- **techFace SCHEMA_VERSION 纳入两段式 factorHash** — 状态：**未覆盖 · 需单独排期（P2-1 批次 2 之后，依用户指令）**。裁决② 已交付通用 `lib/factorHash.js`，但 techFace 仍用手写 `tf-20261111a`，未接入。属 P1-2 范围外的增强，非 P1-2 交付遗漏。
- **bump_version.js 版本断言 token 扫描** — 状态：**未覆盖 · 需单独排期（P2-1 批次 2 之后，依用户指令）**。P1-2 已交付 bump 行级限定替换，但「扫描全站 `/"20\d{6}[a-z]"/` 形态 token 列清单确认」未做。属 P1-2 范围外增强。
- **阶段 3（P2：E2E 固化 / 可观测性 / 因子相关性）**：**未启动**；P1-test-isolation-audit 计划在此阶段 P2-1 一并处理。

## 纪律变更（20261111c · 落实现场快照机制后）

- `run_all_tests.js` 现于任一测试失败时把全量输出 + 环境（时间/git commit/node 版本/模式）快照到 `data/test-scenes/scene-<时间戳>/`（每失败测试一个 .log + index.json），保留 3 天自动清理。
- **新纪律：遇到间歇失败，先查 `data/test-scenes/scene-*/`，不复跑自愈。** 首次实锤：test_stock_log.js 间歇失败根因 = 测试拆卸删 600test.json 触发 safe-delete 守卫（见 P1-test-isolation-audit）。

### 12:15 · 同步前补实跑证据 + 全量冒烟 + backlog 悬浮态消除

- **逐项实跑证据（20261111c，真实跑数非引用历史）**：P1-1 inflight 17/0；P1-3 taxonomy 20/0（含 §4 全站合规词扫描子断言）；P1-2 版本戳缓存破坏同步 54/0（test_volume_caliber_warn，非合规词扫描）；P1-4 store 16/0；P1-2 factorHash 22/0 + bump 缓存破坏 3/0；P0-1 lookahead 26/0；P0-3 dataHonesty 48/0；P0-2/展示 color_semantics 148/0；techFace 专项 tech_accuracy 34/0。全量 run_all_tests --quick = **123/123 通过**（跳过 13 需网络），无快照落盘（绿跑不落盘）。
  - ⚠️ 证据表纠错（12:45）：上轮误将 test_volume_caliber_warn 的 54/0 标为「P1-3 合规词全站扫描」；实测该文件仅做「§6 版本戳与缓存破坏同步」断言，合规词扫描归属于 test_single_source_taxonomy 的 §4 子断言（含于其 20/0）。已更正。
- **启动冒烟**：端口 3005 已在监听（PID 3080，既有实例）；根路径 HTTP 302（正常重定向主面板）、/api/sameday-judgment/601318 HTTP 200（API 正常服务）。冒烟通过。⚠️ 该实例为既有进程，最新代码（techFace 归一化/迁移标记/accuracy 披露条）需三步启动仪式重启才生效。
- **backlog 悬浮态消除**（用户 12:13 裁决）：原「归属 P1-2/P1-4 但未启动」三项改为逐条归类——P1-test-isolation-audit / techFace 纳入 factorHash / bump 版本断言扫描 均为「未覆盖·需单独排期」（P1-2/P1-4 的交付物不含这些增强，非遗漏）。P1-test-isolation-audit 按用户建议改归 **P2-1**（阶段 3 做 E2E 顺手用 SA_DATA_DIR 解决）。无「已归属但未启动」悬浮态残留。

### 14:2x · P2-1 批次 1：测试隔离修复（解决 P1-test-isolation-audit · 已完成）

- **根因复核（20261111c 快照 + 全量删除点扫描）**：`test_stock_log.js:18` `clean()` 裸 `fs.unlinkSync` 删 `data/stock-log/<sym>.json`（如 `sz600test`→`600test.json`），**无 try/catch**；全量 28+ 测试文件累计删除跨沙箱守卫阈值 50，守卫抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，唯独本测试裸删 → 崩溃（其余 27 个均包 try/catch 存活）。间歇因每次跑的删除计数与顺序不同。
- **修复（生产零行为变更）**：
  1. 新建 `lib/dataDir.js`：`getDataDir()` 调用时读 `process.env.SA_DATA_DIR`，设置则重定向，否则默认 `project/data/`（env 在 require 依赖前设置即生效）。
  2. `lib/stockLog.js`：`DIR` 改经 `getDataDir()`（仅改落盘位置，输出 JSON 结构不变 → 不影响任何下游模块，隔离验证通过）。
  3. `scripts/test_stock_log.js`：顶部设 `SA_DATA_DIR=os.tmpdir()/sa-stocklog-test-<pid>`（项目外临时目录，不进守卫统计）→ `DIR` 走 `getDataDir()`；`clean()` 加 `try/catch` 兜底（防御，正常应成功）。
- **范围隔离**：仅改 stockLog + 本测试 + 新增 dataDir；不动 run_all_tests.js（最小爆炸半径）。`SA_DATA_DIR` 生产不设置 → 个股记录仍落真实 `data/stock-log`，行为不变。
- **验证（实跑非自称）**：`node scripts/test_stock_log.js` → **pass=66 fail=0**；全量 `run_all_tests --quick` → **123/123 通过、跳过 13（需网络）、无快照落盘**；`data/test-scenes/` 三处旧快照均为本修复前（03:59/04:09/04:54），本次运行未新增；真实 `data/stock-log/600test.json` 经 stat 确认本运行未写入（mtime 不变，仅清理了修复前残留）。探针确认 stockLog `DIR`：设 `SA_DATA_DIR` 时落 `os.tmpdir` 临时目录，不设则仍 `project/data/stock-log`（生产零行为变更）。
- **未做（如实）**：未升 APP_VERSION（stockLog 生产落盘路径未变，用户无需重启）；未 git 同步（等指令）。

### 14:3x · P2-1 批次 1 追问闭环（A 级确认后三项细节 + WAL 自愈清理 · 已完成）

- **① 脏数据污染断言风险**：`clean()` 包 try/catch 后若遇守卫拦截未真正删除，文件中途残留会污染后续断言。修复：`test_stock_log.js` 运行起点对 `DIR` 做**前置清洁+断言**——`fs.rmSync(DIR,{recursive,force})` 强制清空后 `mkdirSync`，再断言目录无 `.json` 残留（有残留即 `process.exit(1)` 显式失败）。杜绝「上一运行残留 / clean 被拦未删」两类脏数据。
- **② dataDir 登记为基础设施**：`lib/dataDir.js` 头部加 INFRA 标识 + 迁移策略（新代码统一用、存量按改动迁移、不强制统一、仅改落盘位置不动输出契约）。`test_stock_log.js` 在 `scripts/` 范围（不在 swallow-catch 扫描域），其 best-effort 清理用空 catch 合规。
- **③ 求值时机 + 设置顺序（排除巧合）**：双探针实测——`env 在 require 前设` → stockLog 落 **temp**（= 测试实际顺序，隔离生效）；`env 在 require 后设` → 落 **真实 project/data/**（即用户担心的「巧合」场景会失败）。证明本次实跑能过是「前设顺序」所致，非巧合。`stockLog.js` 的 `DIR` 加载期求值处加不变式注释。
- **WAL 自愈清理（用户建议）**：`dataDir.cleanupStaleTmpDirs()` 扫 `os.tmpdir()` 仅匹配 `sa-stocklog-test-*` 前缀、删 >24h 旧目录（绝不碰 /tmp 其他文件）；`run_all_tests.js` 启动即调用。回归：该 catch 初版为空 catch 触发 `test_swallow_catch_guard` +1 → 改为 `failed++` 计数（非静默吞），回归消除（138=基线）。
- **验证（实跑）**：`test_swallow_catch_guard` 138=基线通过；`run_all_tests --quick` **123/123**、无快照；`test_stock_log` 66/0。
- **批次 2 排序（用户指令）**：同步后第一件事 = P2-1 批次 2「E2E 固化（5 条链路，复用本轮 dataDir 机制）」；两悬浮 backlog（techFace 纳入 factorHash / bump 版本断言 token 扫描）**放批次 2 之后**。本次未同步（等指令）。

### P2-1 批次 2 开工（E2E 固化 5 条链路 · 2026-11-11 · 链路 1 落地）
- **依据**：整改方案 v1.1 阶段 3（P2）；用户指令「先继续 P2-1 批次 2，GitHub 推送暂缓」。
- **目标**：把 5 条核心链路固化为独立、可重复、零网络的 E2E 测试，统一复用 P2-1 批次 1 的 dataDir 隔离机制（env 在 require 前设到项目外临时目录 + 收尾清理）。
- **优先级（用户指定）**：① 个股复盘 run 幂等（B0-1/B0-2/B0-4）> ② deep-analysis 降级链 > ③ analysis > ④ 复盘生成 > ⑤ 数据源降级链。
- **实现手法**：对需触网链路用 `require.cache` 合成桩替换数据层（stockData/quoteHub/capitalFlow/sectorLimitStats/newsSearch）+ `ai/llm`+`ai/config`，做到真实 `generateReview` 双调用实测而不触网；降级链通过桩注入「无 AI 配置」验证 `degraded` 如实披露、快照照常落盘、不抛、无 `[object Object]`。
- **落点文件**：新建 `scripts/test_e2e_chains.js`（逐链追加，每链独立 section，全量 runner 自动纳入）；本 WAL 条目。
- **本轮（链路 1）**：实现并验证 个股复盘 run 幂等 + 降级链（§A 批量幂等 / §B generateReview 双调用幂等 callLLM 仅 1 次 / §C 降级快照落盘不抛 / §D 降级缓存可幂等读）。
- **范围隔离**：仅新增 test 文件 + 本 WAL；不动业务 lib（生产零行为变更）。
- **验证（实跑）**：`node scripts/test_e2e_chains.js` → 全绿；`run_all_tests --quick` 纳入后由原 123 → **124/124**。
- **未做（如实）**：链路 3-5 待后续回合逐条追加；未升 APP_VERSION；未 git 同步（等指令）。

### P2-1 批次 2 · 链路 2 落地（deep-analysis 当前价降级 E2E · 2026-11-11）
- **依据**：整改方案 v1.1 P0-1「价格来自降级口径须可见」；用户批准范围表（B2：先改 pipeline 透出 degraded 再测；批准链路 2 范围）。
- **范围（已批）**：只测「当前价降级」一条（pipeline.js:188-209）；直调 `deepAnalysis`（不混路由 `_deepJobs` 状态机，属链路 3）；4 段 §A-§D。
- **三前置确认结论**：① 降级点唯一 E2E 价值点 = `wrapQuote` 取不到有效价 → 真实降级分支回退 `history[末].close` 并打 `degraded`；② 直调 pipeline（非 HTTP），用 `require.cache` 桩替换全部网络数据层；③ 桩边界——可桩：stockData/quoteHub/eastmoneyValuation/valuationHub/financeHub/financials/dividends/research/changeAnalysis/db/ai(config+llm+cache)；不可桩（保持真实执行）：pipeline/statements/conclusions/conclusion/companyType/chipDistribution/insuranceAnalysis。
- **pipeline.js 改动（最小隔离，P0-1 透出）**：`sections` 新增 `currentPrice: priceRef` 与 `dataGaps` 数组（degraded 时含 `{field:'currentPrice', level:'degraded', note: source}`）。此前 `degraded` 只留在内部 `priceRef` 与 DB `data_points.extra`，前端/下游拿不到 → 违反价格口径可见性。
- **链路 2 测试（test_e2e_chains.js 追加）**：
  - §A 降级触发：传「无 .price 的 quote 对象」（行情网关不可用但非 null，规避 pipeline:300 在 null 上挂属性抛错）→ 真实 wrapQuote 返回 null → 回退 9.5，degraded=true，source 含「降级」，不抛。
  - §B 降级标记透出：sections.currentPrice.degraded===true 且 sections.dataGaps 含 currentPrice 降级项。
  - §C 双重降级不崩溃：quote 无价 + history 空 → 不抛，price 兜底 0 仍标记 degraded。
  - §D 缓存与降级共存：§D-1 同降级口径复现 degraded（确定性，不静默修复）；§D-2 恢复有效 quote → 非降级（degraded 不为 true、price=12.3、dataGaps 清空）→ 证明降级非粘性、不永久缓存。
- **实测发现（如实）**：有效 quote 时 `priceRef.degraded` 为 `undefined`（仅在降级分支显式置 true；缺省即正常）。前端以 `priceRef.degraded ?` 判降级，undefined 视为正常——语义正确，无需改代码；测试断言用 `!== true` 表述。
- **范围隔离**：仅改 pipeline.js 返回对象 + test 文件 + 本 WAL；未升 APP_VERSION、未改其他模块、未 git 同步。
- **验证（实跑）**：`node scripts/test_e2e_chains.js` → **29/0 全绿**；`run_all_tests --quick` → 维持 **124/124**（链路 1+2 同文件 test_e2e_chains.js，自动纳入）。

### 个股每日复盘模块「游资升级」（user intent C · 2026-11-11 · 已完成）
- **用户意图**：复盘卡片 System Prompt 换成「10 年 A 股短线游资」人格 + 四段式推演 + 新增第 4 节「🧠 历史规律与自省纠错」；并明确「只改 Prompt 不够——底层 Node 代码必须捞出该股过去 1-3 日复盘喂给大模型」。
- **隔离决策（铁律·模块修改）**：历史记录注入属「通用模板」改动，须对所有同类复用；但底层 giveup-streak / 反查 / 前端角标依赖 `> 评级判定` / `> 放弃信号判定` 两行确定性标记（extractMarks→computeGiveupStreak→buildBackcheck→前端），**保留两行标记原样**以零爆炸半径保护整条管道；同时把模板里嵌示例文字的标记行改为单行干净格式，避免模型照抄示例导致评级恒为 S。
- **代码改动（lib/stockReview.js，生产行为变更：新增历史注入）**：
  1. 新增 `getPastReviews(symbol, beforeDate, limit)`：用 `listReviews` 取 beforeDate 前最近 limit(默认3) 条，逐条 `store.readJsonSafe` 读落盘 JSON（损坏/缺失→留痕 warn+回退，杜绝静默空 catch），抽 `extractScriptSection`（彼时「明日剧本」预判）+ rating + giveupTriggered。
  2. `buildContext` 在 `backcheck` 后算 `const pastReviews = getPastReviews(symbol, date, 3)`，并加入返回 `history: { giveupStreak, backcheck, pastReviews }`。
  3. `module.exports` 补 `getPastReviews`；`llmGenerate` 经 `JSON.stringify(context)` 自动把 pastReviews 透传给模型（无需改 prompt 拼装）。
  4. **去静默吞错**：原 getPastReviews 的 `try{ JSON.parse }catch(e){}` 空 catch 违反 R17 纪律守卫 → 改用 `store.readJsonSafe(...).data`（项目「不静默、不臆造」惯例，损坏即 warn 留痕），空 catch 归零，swallow 守卫回到 138=基线。
- **Prompt 改动（prompts/stock-review-system.md）**：游资人格 + 6 铁律（说人话/资金投票/四段式/禁荐股/数值权威/防诱多）+ 四段式输出模板（第 4 节历史自省：往日判断核查[已验证/被打脸/待验证]+错误归因4选项+股性规律）；文末「历史记录注入说明」告知模型过去1-3日记录由代码注入；标记行改为 `> 评级判定：S` / `> 放弃信号判定：触发` 单行格式 + 输出格式节明确「只填实际判定、不得保留示例文字」。
- **测试（实跑非自称）**：test_stock_review 65/3 失败 → 因断言照搬旧 prompt 字面（严禁买卖建议/四段式/连续放弃反查节）→ 按「守卫不变式、不守字面」更新 3 条断言匹配游资版措辞 → **68/0 全绿**；test_e2e_chains 29/0；test_swallow_catch_guard **138=基线通过**；run_all_tests --quick **124/124**（跳过13需网络）。
- **未做（如实）**：服务端改动需重启 3005 生效（pastReviews 才真正进 Context）；未升 APP_VERSION（prompt 内容变更未强制版本戳，但 promptSha1 已进落盘元信息可追溯）；未 git 同步（等指令）。

### 首页「大盘每日复盘」历史预判核查补丁（user intent C 反向应用 · 2026-11-11 · 已完成）
- **用户意图**：把刚完成的【个股复盘】历史自省机制反向应用到【大盘每日复盘】。要求①代码层取数（读过去 1-3 个交易日大盘复盘 JSON，抽【情绪周期判断】/【题材评级 S/A/B/C】/【明日验证信号】）；② Context 注入（精简防超时）；③ Prompt 新增「🧠 历史预判核查与规律提取」节；④ 防幻觉与隔离（确定性字段/质检规则不变，大模型只做文字推演归因）。
- **隔离决策（铁律·模块修改 + SCHEMA 升级铁律）**：本补丁改的是大盘复盘 Context 结构（新增 history.dailyReviews）→ 必须升 SCHEMA_VERSION 以打破旧落盘 JSON 的 idempotency 复用；确定性字段（表格列/标题/质检）原样保留，只让 LLM 负责文字归因，不新增任何确定性标记。
- **代码改动（lib/reviewService.js，生产行为变更：新增历史注入）**：
  1. 新增 `extractSection(md,keyword)`：定位 `### 标题` 含 keyword 的段落，截断 400 字。
  2. 新增 `extractTableRows(md,marker,limit)`：定位 `**【…】**` marker，跳过非 `|` 行直到表头，跳过 `|---|` 分隔，返回 `[header, ...rows]`（列名驱动，兼容旧表列数漂移）。
  3. 新增 `extractDailyReviewSummary(markdown)`：用 `colOf(header,'阶段评级')`/`colOf(header,'明日观察什么')` 按列名抽情绪 prose + S/A/B/C 题材评级 + 明日验证信号，过滤「暂无」与非 [SABC] 评级。
  4. 新增 `getPastDailyReviews(date,limit)`：`previousTradingDates(date,HIST_DAYS).slice(0,limit||3)` 取过去交易日，逐日 `readReviewSync` 读 `data/reviews/{d}.json` 当前版本 markdown，返回 `[{date,emotion,topicRatings,verifySignals}]`。
  5. `runReview` 内 attempt 循环、stockMarks 之后接 `let dailyReviews=[]; try{dailyReviews=getPastDailyReviews(date,3)}catch(e){dailyReviews=[]}`，并 `reviewContext.build({...stockMarks, dailyReviews})`。
  6. `module.exports` 补 `getPastDailyReviews, extractDailyReviewSummary, extractTableRows, extractSection`。
- **Context 改动（lib/reviewContext.js）**：SCHEMA_VERSION `review-llm-20261110c`→`review-llm-20261111a`；CONTEXT_VERSION `review-context-20261110c`→`review-context-20261111a`；build() 的 history 块注入 `dailyReviews`（每条约束 date/emotion≤300/topicRatings≤6/verifySignals≤6）；trimToBudget 末步再压到 dailyReviews≤2、emotion≤200、各表≤4，确保 <12000 预算防超时。
- **Prompt 改动（prompts/daily-review-system.md）**：骨架新增第 8 项 `### 🧠 历史预判核查与规律提取`（对照 history.dailyReviews，模板见第八节）；文末新增 `## 八、历史预判核查与规律提取（必须严格输出）`，含 3 子节——① 往日大盘预判核查[已验证/被打脸/待验证]；② 大盘错误归因分析（4 强制选项：宏观与突发事件/周期误判/资金错位/数据缺失）；③ 市场环境与规律总结；明确引用 history.dailyReviews、禁止臆造、保留合规红线。
- **测试守卫更新**：test_daily_review.js 中 `review-llm-20261110c`→`20261111a`（109/340/439）与 `review-context-20261110c`→`review-context-20261111a`（120/296/342/362）全部替换（第 102 行 `js/markdown.js?v=20261111b` 为缓存破坏令牌非 schema，不动）；test_stock_review.js:219 同改。
- **测试（实跑非自称）**：`node --check reviewService.js && reviewContext.js` → CHECK_OK；`test_daily_review.js` → **30/0**；`test_swallow_catch_guard.js` → **138=基线通过**（空 catch 未增）；`run_all_tests --quick` → **124/124**（跳 13 网络）。跨格式实测：11-10→6 评级+2 信号、11-09→6+3、11-06→4+3 均正确（兼容旧表列漂移）。
- **未做（如实）**：服务端需重启 3005 才会真正把 dailyReviews 注入大盘 Context；未升 APP_VERSION；未 git 同步（等指令）。

### 个股观察池评级按板块地位保底（user intent · 2026-11-11 · 已完成）
- **用户意图**：个股观察池（每日复盘 `【明日核心观察池】`）评级列在整体大盘退潮期被 LLM 留空显示「—」，要求改为「即使在退潮期也按个股在板块内的地位（逆势活口/最高标/首板试错）给出评级，确定性不足给 B级（试错）/C级（观察），绝不空白」。
- **根因定位**：引擎 `reviewEngines.js` `gradeOf` 恒产出 A/B/C/D（不会空白）；`computed.engine.candidates[].grade` 喂给 Prompt（原第 60 行要求「沿用引擎字母」），最终 LLM 生成表格「评级」列——「—」是 LLM 在退潮期对评级列留空。
- **代码改动（lib/reviewEngines.js，生产行为变更：评级逻辑）**：
  1. 新增 `sectorPositionOf(cand,ctx,maxBoardsByIndustry)`：按各行业最高连板判定 `最高标`（板块空间板）/ `逆势活口`（板块处高潮·退潮期但个股仍连板）/ `梯队中位` / `首板试错` / `跟风/独立`。
  2. 新增 `applySectorFloor(cand)`：仅当 grade==='C' 且**无硬否决、无软否决、无漏斗明确未通过**（即 C 仅因确认项不足）时，若 `sectorPosition` 为 最高标/逆势活口 → 升为 **B（试错）** 并置 `trialGrade=true`；首板/跟风维持 C（观察）。
  3. 新增 `gradeLabelOf(cand)`：产出语义标注 `A` / `B（试错）` / `B` / `C（观察）` / `D（剔除）`。
  4. `analyze()` 内、gradeOf 之后做跨候选二次覆盖：先算各行业最高连板，再逐候选标注 `sectorPosition`、应用保底、重算 `trackable`、写入 `gradeLabel`；`opportunityTable`/`watchPool` 输出补 `gradeLabel`/`sectorPosition`。
  5. **铁律保护**：硬否决→D、软否决→C 永不 A/B、漏斗明确未通过→C 三条均不动摇（新增测试 [5b] 复核）。
- **Context 改动（lib/reviewContext.js，SCHEMA 升级铁律）**：`CANDIDATE_KEYS` 补 `gradeLabel`/`sectorPosition`/`trialGrade`；`SCHEMA_VERSION` `review-llm-20261111a`→`review-llm-20261111b`、`CONTEXT_VERSION` `review-context-20261111a`→`review-context-20261111b`（候选对象结构变更，强制重算）。
- **Prompt 改动（prompts/daily-review-system.md）**：第 60 行「沿用引擎 S/A/B/C」改为「沿用引擎 A/B/C（D 剔除不进池）+ gradeLabel 语义标注（B（试错）/C（观察）），退潮期也必须给评级、严禁留空或写「—」」；第 63 行兜底改为优先取 `computed.engine.candidates[].gradeLabel`，无则按板块地位给 B（试错）/C（观察）。
- **测试（实跑非自称）**：`test_review_engines.js` 43/0（新增 [5b] 板块地位保底 + 铁律不破坏两用例，放宽 [5] 允许试错级 B 确认项<4）；`test_daily_review.js` 30/0（schema 令牌同步 20261111b）；`test_swallow_catch_guard.js` 138=基线；`run_all_tests --quick` 124/124。
- **未做（如实）**：服务端需重启 3005 才会真正按新评级逻辑生成；未升 APP_VERSION；未 git 同步（等指令）。

### 个股复盘三处「数据缺失」补齐（user intent · 2026-11-11 · 已完成）
- **用户意图**：截图（中国平安 601318 复盘卡片）显示三处红字缺失——「分时明细数据缺失（按 OHLC 还原）」「板块数据缺失（行业识别失败，无该股板块涨跌停/中军数据）」「龙虎榜数据缺失」；明确建议「量能数据引用资金量能模块，板块数据引用行业分析模块或者通过 mcp 获得」。
- **根因定位**：全库检索确认这些「缺失」字符串**不在源码里**，是 LLM 因 Context JSON 无对应字段、按 `prompts/stock-review-system.md` 铁律5「Context 没有的数据写数据缺失」自行补的占位文字。三个缺口分别对应：`getSectorData` 把行业参数传成 `''`（行业识别失败）、`buildContext` 未采集量能引擎结论、未采集龙虎榜。属「数据源未接线」，非「数据源不可用」。
- **隔离性（两条铁律第一条）**：`buildContext`/`generateReview` 仅被个股复盘（server.js:2534）+ 自身测试消费，`sectorLimitStats`/`capitalFlow`/`boardReviewData` 原有输出字段与语义零变化；新增 `byCode` 为纯新增字段，大盘复盘 `reviewContext.lhbBlock` 只挑固定字段、不读取它（已加断言固化）。大盘复盘不受影响。
- **代码改动（lib/stockReview.js）**：
  1. `SCHEMA_VERSION` `stock-review-20261110b`→`stock-review-20261111c`（Context 结构新增三块，升级铁律）。
  2. `getSectorData`：先 `require('./sectorIdentity').resolveSectorIdentity(symbol,name)` 拿真实行业，再带 industry 入参调 `getSectorLimitStats`；即便涨跌停统计不可用，只要行业识别成功也透出 `industryName`（不再「行业识别失败」空白）。行业解析失败的 catch 改为 `console.warn` 显式告警（避免新增静默吞错）。
  3. `getCapitalData`：复用 `analyzeCapitalFlow` 已算好的 `c.volumeEngine`（`volumeState`/`volumeTier`/`position`/`dataGaps`），透出 `capital.volume`；`buildContext` 加顶层 `volume`。**不重复跑引擎**。
  4. 新增 `getLhbData(symbol,date)`：走 `boardReviewData.getLhbOnly(date)`（`--lhb-only` 轻量通道，5 分钟进程内缓存），按代码精确匹配 `lhb.byCode`；`listed=true/false` 真实判定，兼容旧数据层无 byCode 时退回 top5 并如实标 `coverage:'top5-only'`、`listed:null`（不臆断）。
  5. `buildContext` 三路 `Promise.all` 并行取 sector/news/lhb，返回对象加 `volume`、`lhb`；`volume: (capital && capital.volume) || null` 防 capital 为 null 抛错。
  6. `toSnapshotMarkdown` 新增「板块联动 / 龙虎榜 / 量能」三行；`volumeTier` 是对象，只取 `.tier` 文本——修掉实测中出现的 `[object Object]` 回归。
- **数据层改动（scripts/board_review_data.py `build_lhb`）**：新增 `byCode`（全量上榜明细按代码索引：netBuyYi/buyYi/sellYi/reason/changePct），解决原本只保留 topNetBuy/topNetSell 前5 无法判定个股是否上榜的问题；block 默认 `{}`。既有字段/语义/顺序不变。
- **Prompt 改动（prompts/stock-review-system.md）**：开头明列 `sector`/`volume`/`lhb` 三类字段；铁律5 改为「已包含三类数据，严禁写『缺失』『数据缺失』『按 OHLC 还原』等占位，`available=false` 按 note 写状态」；第1节量价表现改引用 `volume`（量比/档位/位置）、板块地位改引用 `sector`、资金与催化改引用 `lhb`（分 listed true/false/null/available=false 四种写法）。
- **测试（实跑非自称）**：`test_stock_review.js` 76/0（SCHEMA 断言升级 + §1 新增 6 条接线断言含隔离性 + §6 新增 3 条快照渲染断言）；`test_e2e_chains.js` 35/0（补 `sectorIdentity`/`boardReviewData` 桩、callLLM 捕获完整 Context，§B 端到端断言三块数据注入、§C 断言降级快照两行渲染）；`test_swallow_catch_guard.js` 138=基线；`run_all_tests --quick` 124/124（跳过 13 需网络）。
- **真实数据链路实测（非桩，2026-11-11 当日）**：`resolveSectorIdentity(601318)` → 保险 / code-override / conf=1；`getSectorLimitStats(...,'保险')` → ok:true、涨停 0 / 跌停 0 / 总数 5；`getLhbOnly` → ok:true、85 条上榜记录 / 75 只个股 / byCode 生效；强制降级快照真实输出：「板块联动｜保险 · 涨停 0 家 · 跌停 0 家」「龙虎榜｜今日未上龙虎榜（当日全市场共 85 只上榜，按代码精确核对）」「量能｜量比(÷5日) 0.88；量能档位 缩量；位置 低位区间」。三处「缺失」全部消失。
- **文档**：`docs/logic/stock-23-stock-review.md` 结构版本同步 20261111c，补三块数据源接线说明与 volumeTier `[object Object]` 回归警示。
- **未做（如实）**：服务端需重启 3005 才会加载新代码；未升 APP_VERSION（本次只改后端/提示词/python，前端资源未变）；未 git 同步（等指令）。东财 push2his 资金流接口 socket hang up（既有沙箱现状），资金流降级为「按K线估算」，与本次改动无关、量能引擎仍正常出结论。

### 用户截图反馈「还是原样？」→ SCHEMA 复用侧漏洞修复（2026-11-11 19:16 · 已完成）
- **现象**：用户 19:16 截图，中国平安复盘卡三处「缺失」一字未变；且是有完整资金流数据（主力净流出 4.59 亿）的 LLM 正式稿，非降级快照。
- **诊断（先摆事实，不猜）**：
  - 服务 PID 17108 启动 19:14:39 > 代码改完 18:35 / 提示词 18:32 → **用户已重启，新代码已加载**，排除「没重启」。
  - `data/stock-reviews/601318/2026-11-11.json` 存在，`schemaVersion=stock-review-20261110b`（旧）、`createdAt=18:13`（早于改码）、`llm.degraded=false`，markdown 内三处「缺失」全在。
  - 打开复盘页走 `GET /api/stock-review/:symbol` → `getLatestReview` **直接读旧文件渲染**，不经生成链；即便点「生成今日复盘」，`forceNext` 仅在 `llm.degraded===true` 时置位 → `force:false` → `generateReview` 命中缓存原样返回。**所以刷新和点按钮都还是原样**。
- **根因**：`generateReview` 命中缓存只判断「文件存在」，**完全不比对 schemaVersion**——这是「SCHEMA_VERSION 升级铁律」的复用侧漏洞：只升版本、不让旧记录失效，旧卡片会被永久复用（用户记忆里反复强调的旧记录复用问题，这次是反向变体）。
- **立即见效动作**：把当日旧卡片重命名备份为 `data/stock-reviews/601318/2026-11-11.json.bak-20261110b`（保留可还原，未删除）。`listReviews` 只认 `^\d{4}-\d{2}-\d{2}\.json$`，`.bak` 不污染历史列表。当前已加载新代码的服务在点「生成今日复盘」时缓存 miss → 用含 sector/volume/lhb 的新 Context 重生成。
- **根因修复（下次重启后生效）**：
  1. `lib/stockReview.js generateReview`：命中缓存时 `cached.schemaVersion === SCHEMA_VERSION` 才复用，否则 `console.warn` 并自动重生成（无需手动清缓存 / force）。
  2. `lib/stockReview.js runPoolBatch`：同口径校验，旧 schema 当日记录不算「已有」（协同进化，20:35 批量槽同步覆盖）。
  3. `server.js`：新增 `refreshOutdatedReview(r,symbol)`，两个 GET 读取路由对**当日**且 schema 过期的记录自愈重生成；历史日期一律原样保留、不篡改；传 `force=false` 由 generateReview 判定以保留 LLM 在途合并，避免并发重复调用；自愈失败 catch 降级返回原记录。
- **为什么不让 AI 直接代跑一次生成**：本机沙箱访问东财 push2his 报 socket hang up，资金流会降级为「按K线估算」，卡片质量低于服务进程（用户截图里 4.59 亿是真实接口值）。故由 3005 服务进程生成，用户点一次按钮即可。
- **测试（实跑非自称）**：`test_stock_review.js` 79/0（§1 新增 3 条：generateReview 校验 / runPoolBatch 同口径 / server 两 GET 自愈）；`test_e2e_chains.js` 40/0（新增 §E：写入旧 schema 正式稿 → 非 force 生成触发 1 次 LLM 并返回新 schema、旧「缺失」文案消失、二次读取幂等、结果按新 schema 落盘）；`test_swallow_catch_guard.js` 138=基线；`run_all_tests --quick` 124/124。
- **用户操作口径**：**现在不必重启**——点「生成今日复盘」等约 40 秒即可看到新卡片；上述根因修复需下次方便时重启一次 3005 才加载（重启后新卡片 schema 已是 20261111c，不会被再次重生成）。
- **未做（如实）**：未升 APP_VERSION（本次零前端改动）；未 git 同步（等指令）。

#### 实际执行结果补充（19:27，代跑成功，用户无需点按钮）
- 确认 `lib/ai/config.js loadPromptFile` 按文件 mtime 热加载 → 服务**不重启也能用上 18:32 改过的新提示词**；服务 19:14 启动已加载 18:35 的新 Context 代码。
- 由 AI 直接调 `POST http://127.0.0.1:3005/api/stock-review/601318/run`（`{"name":"中国平安","force":true}`），让 **3005 服务进程**（非本地沙箱）跑 LLM 生成，绕开本机沙箱东财不通的问题。
- 结果：`success:true`、`schemaVersion=stock-review-20261111c`、`model=deepseek-v4.1-flash-1017`、`degraded=false`、`elapsedMs=33619`、`markdown 2713 字`；**三处旧「缺失」占位全部消失**（板块/龙虎榜/分时均 false），新数据全部出现。
- 新卡片写实内容抽样：量价表现引用量能引擎「量比(5日) 0.88 平量 / 20日主基准 0.68 倍缩量 / 12个月分位 28.26% 低位区间 + divergenceNote」；板块地位「保险，涨停 0 / 跌停 0 / 样本 5 只，绝对权重中军，无共振护盘」；资金与催化「今日未上龙虎榜」+ 全市场口径。**不再有「行业识别失败」**。
- 如实记录：本次生成 `moneyFlowSource=estimated`（东财逐笔资金流当时未入库），卡片已按「估算口径，量能＋两融合成」如实标注，未冒充真实值；旧 18:13 卡片里的「主力净流出 4.59 亿」是接口可用时的真实值。属数据源瞬时状态，非本次改动引入。
- 用户操作简化为：**Ctrl+F5 硬刷新即可看到新卡片**（无需点按钮、无需重启）。根因修复（GET 自愈 / 缓存 schema 校验 / runPoolBatch 同口径）仍建议方便时重启一次 3005 加载；新卡片 schema 已是 20261111c，重启后不会被重复重生成。

### 分时仍非真实分钟数据 → AKShare 主源 + 腾讯降级（`stock-review-20261111d` · 2026-11-11 完成）
- **用户意图**：指出 20261111c 只补了日K/量能引擎结论，不是分钟级分时；要求「继续深度使用 AKShare」，示例 `stock_zh_a_spot_em(symbol="601318")` / `stock_intraday_em`，强调改动最小、集成最快。
- **接口事实实测（不照抄示例）**：项目 Python 为 `C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe`，AKShare 1.18.94。默认 Python 3.13 的 pandas DLL 被「应用程序控制策略」阻止，不可用。实测 `stock_zh_a_spot_em()` **不接受 symbol 参数**、返回全市场实时快照，且 `scripts/board_review_data.py` 头部既有规定禁用（asOf 错位、耗时不可接受）→ 未按示例接线。改用 `stock_zh_a_hist_min_em(symbol, start_date, end_date, period='1', adjust='')` 与 `stock_intraday_em(symbol)`。
- **网络现状如实**：AKShare 两个分时接口均 `ProxyError`（`push2his.eastmoney.com` / `70.push2.eastmoney.com` 被代理拦截，约 2.8s 快速失败），当日无法取到东财分钟数据。故保留 AKShare 为**首选主源**，并降级到项目现成的 `stockData.fetchTencentMinutes()`；网络恢复后自动回到 AKShare，无需改码。
- **代码落地（隔离：仅个股复盘链路，其他模块输出格式零变化）**：
  1. `scripts/board_review_data.py`：新增 `build_intraday(symbol,date_str)` + `--intraday-symbol` / `--intraday-date` 早退通道（与 `--lhb-only` 同范式，不跑复盘主流程）；只做客观数值整理，过滤非连续竞价时段；`stock_intraday_em` 当日快照把 `asOf` 标为脚本运行日，防止历史复盘冒充复盘日。
  2. `lib/boardReviewData.js`：新增并导出 `getIntraday(symbol,dateStr)`（90s 超时、UTF-8、16MB buffer）。
  3. `lib/stockReview.js`：`SCHEMA_VERSION` c→**d**；新增纯函数 `summarizeIntraday()`（导出供单测）与 `getIntradayData()`（5min 缓存、AKShare→腾讯降级、全失败 `available=false`+`note`）；`buildContext` 并行取数并透出 `Context.intraday`；`toSnapshotMarkdown` 加「分时」行/不可用原因行。
  4. `prompts/stock-review-system.md`：三类数据→**四类**（sector/volume/lhb/intraday）；量价表现强制引用 pattern / segments / highTime+lowTime / tailChgPct / closeVsAvgPct / peakVolTime / source；铁律5 禁「分时明细数据缺失」「按 OHLC 还原」；`dateMatches=false` 必须注明口径日不一致。
  5. 空 catch 修复：腾讯降级失败原为静默吞错，改 `console.warn`（守卫基线 138 不涨）。分段改半开区间 `[from,to)`，四段量能占比合计=100%；腾讯 15:01-15:30 盘后条目在降级侧过滤（267→242 点）；形态边界加 `roseFromOpen`，开在最高一路下行判「单边下行」而非「冲高回落」。
- **真实链路实测（非桩，601318 / 2026-11-11）**：AKShare `ok:false / points:0 / note=东财 push2 不可达`；腾讯 `date=2026-11-11 / prevClose=54.1 / 267 点→过滤 242 点`；特征 `pattern=冲高回落`、`open=54.1 / close=53.41 / high=54.3@0943 / low=53.41@1500`、`changePctFromPrev=-1.28%`、`tailChgPct=-0.22%`、`closeVsAvgPct=-0.77%`、四段量能占比 15.12/27.13/37.33/20.42（合计 100）、`source=腾讯分时 ifzq.gtimg.cn`、`dateMatches=true`、`degradedFrom=AKShare 分时不可用`。
- **测试（实跑非自称）**：`node --check` 四文件 + 项目 Python `py_compile` 全通过；`test_stock_review.js` **105/0**（§1 新增 14 条接线/隔离断言、§6 新增 2 条快照分时行、新 §6b 10 条纯函数单测：累计量/当分钟量、形态边界、四段占比、点不足、口径日）；`test_e2e_chains.js` **51/0**（新增 `getIntraday` 与 `fetchTencentMinutes` 桩，§B 断言 AKShare 主源特征注入且不含 raw minutes，新增 §F 主源失败→腾讯降级 7 条断言）；`test_swallow_catch_guard.js` 138=基线；`run_all_tests.js --quick` **124/124**（跳过 13 需网络）。
- **文档**：`docs/logic/stock-23-stock-review.md` 结构版本→20261111d，补数据源 / 降级链 / 代码权威 / 五要素说明与 3 条自查项。
- **生效口径（重要，避免再次「还是原样」）**：本次改的是 **JS 代码**，提示词虽按 mtime 热加载，但 `SCHEMA_VERSION=d` 与新的 Context 代码必须**重启 3005 服务**才生效；重启后 GET 自愈会把当日 `20261111c` 的中国平安卡片自动重生成（历史日期不动）。用户操作：双击桌面「Stock Analyzer」→ 打开页面 → **Ctrl+F5 硬刷新** → 进入「每日复盘」，若未自动更新再点一次「生成今日复盘」。未重启前页面仍是 20261111c 卡片，属预期。
- **未做（如实）**：未升 APP_VERSION（本次零前端资源改动）；未替用户重启 3005（服务由桌面入口启动，需用户点一下）；**未 git 同步**（等用户明确说「同步」）；AKShare 主源当前确实取不到数，实际卡片分时来自腾讯降级，已在 Context / 卡片中如实标注，不可声称 AKShare 已成功。
- **代跑重启尝试记录**：曾尝试由 AI 直接执行项目既有 `start.vbs`（等价于双击桌面图标，会 kill 3005 旧进程再起新进程），命令被本机安全策略以「Windows LOLBin 可执行任意代码」为由拒绝，按纪律不重试、不换等价手段绕过 → **保留用户双击桌面「Stock Analyzer」这一步**，不擅自重启用户正在使用的服务。已提前把当日 `20261111c` 卡片备份为 `data/stock-reviews/601318/2026-11-11.json.bak-20261111c`（可还原，`.bak` 不进历史列表）；py_compile 产生的 `scripts/__pycache__` 已清理干净。
- **最终状态**：本地代码 / 提示词 / 测试 / 文档 / WAL 全部完成且实跑通过；3005 服务仍在跑旧代码（PID 29168，当日卡片 c），这是预期状态。用户重启后 GET 自愈会把当日 c 卡片自动重生成到 d；若首屏等待较久，点一次「生成今日复盘」即可。

### 整改任务：B2 前端闭环 + 版本戳（2026-11-11 20:04 · 用户三条尾巴，完成）
- **用户指令**：进入链路 3 前必须收口三条尾巴——① 前端没渲染 `dataGaps.degraded` 警告条，B2 修复「修了寂寞」；② `sections.currentPrice` 与 `sections.conclusion.currentPrice` 两套价格口径漂移；③ 后端 JSON 结构 + 前端 UI 都改了却没升 `APP_VERSION`。
- **前置确认（先摆事实，三条全属实，第②条比用户判断更严重）**：
  - `public/js/deepCharts.js` 全文件**零处**读 `sections.dataGaps` / `sections.currentPrice`；`renderAll` 只把 `sections.conclusion` 传给 `renderConclusion`，`dataGaps` 在前端唯一出现是 `app.js:2716` 的估值模块（无关）。
  - `conclusion.currentPrice` 来自 `lib/deep/conclusion.js:20` 的 `quote?.price || dcf?.currentPrice || 0`，且该函数内部还用它算 EPS、六只专属估值模型、股息率 → **降级时前端不只是缺警告，价格本身会显示 0 / 旧 DCF 价 / `--`**。
  - `server.js:160 APP_VERSION = '20261111b'`，`index.html` 26 处 `?v=20261111b` 未动。
  - 远端 `git@github.com:lhseiko/stock-analyzer.git` SSH 实测连通（`ls-remote` 返回 master `611683e`）。
- **修复① 口径统一（从入参下手，非返回处盖值）**：`lib/deep/pipeline.js` 新增 `conclusionQuote = Object.assign({}, quote || {}, { price: authoritativePrice })` 传给 `generateConclusion`，异常兜底分支也改用 `authoritativePrice`。`sections.currentPrice = priceRef` 保持唯一权威对象；`conclusion.currentPrice` 降为**兼容镜像**，恒等于 `priceRef.value`，前端不得另立口径（代码内写明契约）。浅拷贝不污染上游 quote。
- **修复② 前端闭环**：`public/js/deepCharts.js` 新增 `renderDataGapsWarning(dataGaps, priceRef)`，`renderAll` 最先调用；`level === 'degraded'` 时在 `#deepContent` 顶部插入 `class="bl-warn deep-degraded-bar"` 琥珀警告条「⚠️ 行情接口不可用，当前价格回退为日线收盘价（¥9.50 · 口径日 2026-11-09）」+ 来源行；重复渲染先移除旧条，`dataGaps` 清空时警告条消失（与 §D 降级非粘性同口径）；note 经 `escapeHtml` 转义。`renderConclusion(data, priceRef)` 用 `priceRef.value` 覆盖估值卡价格，无 priceRef（旧缓存响应）时安全回退。`public/css/style.css` 加 `.deep-degraded-bar`（`var(--accent)` 琥珀 + 主题变量，无裸色值）。
- **修复③ 版本戳**：`node scripts/bump_version.js 20261111d --note "..."`，31 处文件变更：`APP_VERSION` b→d、8 个 HTML 共 56 处 `?v=`、23 个测试脚本的 `APP_VERSION`/`?v=` 断言行；SCHEMA 名（`review-llm-20261111b`）未被误伤。`test_cache_bust_guard.js` 3/0/0 全绿。`test_daily_review.js` 两处自相矛盾的历史描述（「保持差异戳 d/c」）顺手改自洽，断言逻辑未动。
- **连带根因修复（历史 backlog「bump_version version-assertion token scan」）**：首次全量回归红灯——`test_index_pe_window_high` / `test_pos_vm_strong` / `test_volume_caliber_warn` / `test_etf_flow_holiday_guard` 有 5 行「跨文件版本断言扫描」硬编码 `20261111b`，这些行既不含 `APP_VERSION` 也不含 `?v=`，被 bump 的行级限定替换漏掉。已同步这 5 行到 d，并给 `scripts/bump_version.js` 的 `inCtx` 增加 `版本断言|版本戳|版本标识|版本注释|缓存破坏` 语境；d→e dry-run 验证这些行现在会被覆盖，而 `test_daily_review.js` / `test_stock_review.js` 的 SCHEMA 断言行仍保持 b 不被误伤。
- **新增守卫 `scripts/test_deep_degraded_guard.js`（26/0）**：用 `vm` + 最小 DOM 桩**加载真实 `deepCharts.js`**，实测 `renderDataGapsWarning`（插入/移除/文案/价格/口径日/来源/XSS 转义）与 `renderConclusion`（权威价覆盖、旧响应兼容），另加后端单一权威源 / renderAll 接线 / CSS / 版本戳静态断言。非静态字符串自欺，是真实函数级验证。
- **测试（实跑非自称）**：`test_e2e_chains.js` **54/0**（链路2 §A/§B/§D 新增 3 条：降级态 `conclusion.currentPrice === 9.5`、恢复态 `=== 12.3`、`dataGaps.note` 带降级来源）；`test_cache_bust_guard.js` 3/0/0；`test_swallow_catch_guard.js` 138=基线；`run_all_tests.js --quick` **125/125**（新增守卫自动纳入，跳过 13 需网络）。`node --check` 全部通过。
- **提交口径**：用户本轮明确要求「git commit 并立即 push（或本地 tag/bundle 备份）」，故本轮执行 commit + push（不违反「任务完成后不自动同步」——那是**无指令时**的默认纪律；三端同步仪式 / 工作空间克隆 fetch+ff / md5 校验仍等用户明确说「同步」）。提交范围为工作区累积的全部改动（分时 AKShare、观察池评级、个股复盘三处缺失与缓存自愈、B2 前端闭环、版本戳、守卫、WAL），避免把改动拆散悬在本地。
- **执行补充（20:30，均已实跑）**：
  - **git**：`620bd14 20261111d B2 前端闭环 + 分时 AKShare + 版本戳收口`，50 文件 / +1908 −226；`git push origin master` 成功（`611683e..620bd14`），本地与远端 HEAD 一致，工作树干净。首次提交链因命令被重复执行导致第二次 `git commit` 报 nothing to commit、`&&` 后的 push 未跑，已单独补推并核对，非提交失败。push 成功，故无需 tag / bundle 兜底。
  - **服务重启（用户明确授权）**：PowerShell `Start-Process` 首次因环境变量 `HTTP_PROXY` / `http_proxy` 大小写重复触发「已添加项」异常，且旧进程已被关闭（服务短暂中断）；立即清理重复键后重启成功，新 PID `29584`，3005 监听就绪。`GET /` 返回 `302 Location: /index.html?v=20261111d`（APP_VERSION 生效）；`/js/deepCharts.js?v=20261111d` 与 `/css/style.css?v=20261111d` 均 200，且返回内容含 `renderDataGapsWarning`。`SA_NO_AUTO_OPEN=1` / `SA_NO_BG_AI=1` 已按既有约定设置。
  - **肉眼确认的可交付替代**：生成 `data/preview/deep-degraded-preview.html`（365KB，自包含），内联项目真实 `style.css`，并把真实 `deepCharts.js` 的 `escapeHtml` / `renderDataGapsWarning` 方法源码原样嵌入，两个容器对照展示「degraded → 琥珀警告条」与「正常 → 无警告条」。生成脚本用后即删，`data/` 被 .gitignore 排除，仓库仍干净。
- **未做 / 待用户（如实）**：**未在真实深度分析页肉眼确认**警告条——当前行情接口正常，`dataGaps` 为空，按设计本就不该出现；AI 侧无 GUI 浏览器，故以「DOM 桩函数级实测 + 真实代码隔离预览」替代，不冒充真实页面验证。用户现在**只需 Ctrl+F5 硬刷新**（服务已由 AI 重启，无需再双击图标）。链路 3（路由后台状态机：并发请求 / running|done|error 轮询 / 服务重启后状态恢复）**未开**，按用户要求等本轮收口后再启动。

## 2026-11-11 21:2x · P2-1 批次 2 链路 3：deep-analysis 后台任务状态机（红灯实证 → B2 修复 → 全绿）

- **用户指令**：批准链路 3；先前置检查再写测试；用 supertest/原生 HTTP 独立端口 + mock `lib/deep/pipeline.js` 为受控 Promise；重点 §B 并发去重（3 个同 symbol 并发，底层只跑 1 次、所有轮询最后拿 done）与 §E 安全网超时（300s→50ms 转 error）；发现并发竞态 / 状态清理遗漏 / 超时后任务泄漏直接标 B2 并修复；全绿后测三端同步仪式，没问题再开链路 4。
- **前置检查结论**：`server.js` 顶层 `app.listen` 且无 `module.exports`，不能直接 supertest；`/api/deep-analysis/:symbol` 仅一个 GET 路由；`_deepJobs` 是内存 Map（running/done/error），磁盘缓存另有 `APP_VERSION` + `VALUATION_MODEL_HASH` 门控；服务重启后 Map 清空、靠磁盘缓存秒回。修复后的完整流转图已落到 `docs/logic/stock-11-deep-analysis.md`。
- **等价迁移（为可测，零行为变化）**：新建 `lib/deepJobManager.js`，8 个外部依赖 + 超时常量构造参数注入；`server.js` 只保留生产注入与 `app.get(..., _deepJobManager.handler)` 挂载，`_deepJobs` 变量名保留供守卫 / 排障引用。生产默认值仍 300s 安全网 / 280s 内层 race。
- **先红灯实证（避免先改后测自证）**：`scripts/test_deep_jobs_e2e.js` 用 `express + listen(0) + 原生 http`，`require.cache` 把 `lib/deep/pipeline.js` 换成受控 Promise（经 `lib/deepAnalysis.js` 门面透出）；首跑 **27 通过 / 5 失败**，坐实 6 个 B2 级缺陷 + 1 个测试桩缺陷：

| 编号 | B2 缺陷（原实现） | 修复 |
|---|---|---|
| B2-1 | done/error 终态永不清理；缓存失效仍被复用，Map 无上界 | `doneTtlMs`(5min) 惰性过期 + `maxJobs`(2000) 淘汰最旧终态，running 绝不误删 |
| B2-2 | 超时后 `settled` 分支 `return`，已算完的 5 分钟计算被静默丢弃 | 迟到结果照样落盘 + 日志，绝不回滚已终态 job |
| B2-3 | `Promise.race` 的 280s 内层 timer 从不 clear，每次分析泄漏一个定时器 | `finally { clearTimeout(innerTimer) }` |
| B2-4 | 终态 error 被无限复用，不重启服务就永远 500 | 错误投递一次后（`errorDelivered`）允许同参数重建任务 |
| B2-5 | 重试 / 语义变化覆盖旧 job 后，旧 job 迟到结果污染新结果 | 旧 job 标 `superseded`，迟到结果不落盘、不改状态 |
| B2-6 | `writeAnalysisCache` 抛错掉进 `.catch`，把已 done 的 job 反向打成 error | 落盘 try/catch 隔离，只告警不改状态 |
| B2-T1 | 测试桩自身：§F 误用 `controlled.reset()` 清空 calls，致「新增次数」出现 -1 | 只切 `mode/delayMs` 保留计数，断言未放宽 |

- **新增 §G 并发竞态场景**：第一个 job 超时→投递 500→重建第二个 job→旧 job 迟到结果到达，断言「不落盘、不把新 job 改成 done/error」，再让新 job 完成断言「最新结果正常落盘」。
- **分类器假绿根修（额外实锤）**：全量首跑 `125/125` 但跳过数 13→14 —— `run_all_tests.js` 的 `needsNetwork()` 把 `const http = require('http')` 判成需网络，新增 E2E 在 quick 模式**根本没跑却仍报全绿**。根修：支持脚本头 `@test-scope: local` 显式声明零网络（数据层全 mock、仅 127.0.0.1 独立端口）；E2E §0 用 `vm` 抽出真实 `needsNetwork` 函数对自身源码求值为 `false`，防止未来被改回去。修后跳过数回落到 13。
- **APP_VERSION 判定（按铁律不 bump）**：响应 JSON 结构（running / done 结果体 / 500 error）零变化、前端零改动 → 不满足 bump 条件；且 bump 会让 `readAnalysisCache` 的 `appVersion` 门控把全部深度分析磁盘缓存判失效，触发无谓的昂贵重算。`server.js` 已改，故**必须重启 3005 才生效**。
- **验证（全部实跑）**：`node --check` 全通过；`test_deep_jobs_e2e.js` **40/0**（§0/§A/§B/§B2/§C/§E/§E2/§E3/§F/§G）；`test_e2e_chains.js` 54/0；`test_cache_bust_guard.js` 3/0/0；`test_swallow_catch_guard.js` 空 catch 137≤138、路由内 5≤6（净减少）；`run_all_tests.js --quick` **126/126**（跳过 13 需网络，链路 3 E2E 已真跑）。`docs/test-report.md` / `docs/swallow-catch-manifest.md` 自动更新。
- **服务重启（曲折，如实）**：PowerShell `Start-Process` 每次新会话都会重新注入 `HTTP_PROXY` 与 `http_proxy` 大小写重复键，直接抛「已添加项」；同会话 `Remove-Item Env:http_proxy,Env:https_proxy` 后可启动（PID 7624、端口就绪），但该子进程随 PowerShell 会话结束被回收，两次 HTTP 冒烟均失败。最终改用**受管后台任务** `SA_NO_AUTO_OPEN=1 SA_NO_BG_AI=1 PORT=3005 node server.js`，PID 2208 持续监听。前台 `node server.js` 亦验证过启动链正常（SQLite ready / APP_VERSION=20261111d / 调度启动）。临时启动日志 `data/_boot_*.log` 在确认无进程依赖后已删。
- **线上冒烟（实跑）**：`GET /` → 302 `/index.html?v=20261111d`；`GET /api/deep-analysis/601318` → `{status:'running'}`（迁移后 handler 正常接管、后台任务已启动，非 500）；`/js/deepCharts.js?v=20261111d` → 200。
- **git 纪律说明**：用户本轮明确要求「全绿后测三端同步仪式（clone fetch+ff、md5 校验）」，故本轮执行 commit + push + 克隆端同步；这属于有明确指令的例外，不违反「无指令不自动同步」的默认纪律。
- **未做 / 待用户**：链路 4（复盘生成）**未开**，按用户要求等三端同步确认后再启动。

### 21:3x · 三端同步仪式实跑（用户本轮明确指令，非自动同步）

- **commit / push**：`8cee751 20261111d 链路3...`（8 文件 +673/−115）；首次命令因工具重跑出现 `nothing to commit` + `ahead 1`，核对后确认 commit 已建、push 未执行，单独补推 `d2ae219..8cee751` 成功。本地 = `origin/master` = GitHub 远端 = `8cee75143af9abfef079e4b694182f71d3011650`，工作树干净。
- **克隆端 ff**：`git -C "D:/ai agent/2026-09-05-13-22-15" fetch origin` + `merge --ff-only origin/master`，从 `611683e` 快进（57 files changed, +2700/−335，含新建 `lib/deepJobManager.js`、`scripts/test_deep_jobs_e2e.js`）；`refs/remotes/origin/master` 与 `HEAD` 均为 `8cee751`，本次**未复现 workspace loose ref 静默失败**。克隆端仅遗留历史未跟踪文件 `?? bal_all.txt`，未动。
- **md5 双口径（如实，不把差异含糊带过）**：原始字节 md5 对全部 531 个跟踪文件比对**报大量差异**；根因不是内容漂移——两端 `core.autocrlf=true`，本地工作区文件为 LF（`public/js/homeMacro.js` 前 20KB 含 0 个 CR，AI 编辑器写出），克隆端为 git 检出转换的 CRLF（同段 222 个 CR）。权威校验：两端 `git rev-parse HEAD^{tree}` 同为 `51d06dc91b810d23d0cc9cac6188f872b7d28080`；**去 CR 规范化后 531/531 文件 md5 零差异**。故三端代码内容一致，同步仪式通过。
- **未改动换行符口径**：两端 `core.autocrlf=true` 的配置与工作区字节保持原状；批量重写 531 个文件会引入超出链路 3 范围的副作用，故不做。三端内容一致性以 tree hash 与去 CR 规范化 md5 作为判定依据。
- **同步通道故障与根治（实跑）**：WAL 补记提交后，克隆端 `fetch origin` 两次失败——先 `CONNECT tunnel failed, response 502`，再 `Failed to connect to github.com:443 (21158ms)`；`merge --ff-only` 因 remote ref 未更新而误报 `Already up to date`（**不是** workspace loose ref 静默失败）。用 `git fetch git@github.com:lhseiko/stock-analyzer.git master:refs/remotes/origin/master` 经 SSH 通道补齐并 ff 成功；随后把克隆端 `origin` 从 HTTPS 统一为 SSH（与本地一致），复跑 `fetch origin` 正常。后续「同步」指令不再依赖不稳定 HTTPS 代理。

## 2026-11-11 21:5x · P2-1 批次 2 链路 4：复盘生成（mock LLM）E2E 落地

- **触发**：用户「全绿 + 三端同步没问题就开始链路 4（复盘生成）」；三端同步已通过（HEAD `55aed54` / tree `2fbacec` / 规范化 md5 531 文件 0 差异），开工条件成立，本轮直接落地，未再反问授权。
- **范围界定（如实）**：链路 4 = `reviewContext.build → reviewLlm.generate → degraded 数据快照 → reviewService 落盘守卫`。不重复链路 1（个股复盘 run 幂等）与 `test_daily_review.js`（schema 守卫）已覆盖的路由层；不拉起 `runReview` 的完整 `gatherSources`（需桩替换十余个网络数据层，与「mock LLM 验证生成层」目标无关），改以静态断言守住 `runReview` 的 `schemaOutdated` 复用侧。
- **实现**：新建 `scripts/test_review_gen_e2e.js`（45/0）。`require.cache` 只替换 `lib/ai/config.js` 的 `loadConfig`、`lib/ai/llm.js` 的 `callLLM` / `pickModelFor`（其它导出用 `Object.assign` 保留真实，避免下游拿不到函数）；真实执行 `build` / `generate` / `degraded` 与真实提示词文件。
  - §0 接线与 SCHEMA/CONTEXT 同源（`review-llm-20261111b` / `review-context-20261111b`；`reviewService.SCHEMA_VERSION` 同源）。
  - §A Context：五要素随每个源进 Context、失败源如实列 `missing`、观察池 `gradeLabel`/`sectorPosition`/`trialGrade` 三字段在位、龙虎榜不被 `byCode` 污染、12000 字符预算、数值不被改写。
  - §B 正常生成：markdown 只去围栏不改写（LLM 仅叙事、代码权威）、`contentChars`/`promptSha1`/`model`/`promptFile` 元信息、system 用真实提示词、user 原样注入完整 JSON Context、`webSearch:false`、`force` 双向透传。
  - §C 五态降级：未配置密钥 / 配置抛错 / 无可用模型 / LLM 抛 HTTP 429 / 空返回，一律 `ok=false + degraded=true` 且照常出数据快照、原因如实写 `error`；另验证 `pick.model || cfg.modelLocal` 既有兜底不回归。
  - §D 提示词 `gradeLabel` 与「退潮期严禁留空」约束、`runReview` 的 SCHEMA 复用侧守卫。
  - §E `@test-scope: local` + `vm` 抽真实分类器求值，确保进 quick 集（防链路 3 那种假绿）。
- **首跑红灯 41/2（测试桩场景错误，非产品缺陷）**：「无可用模型」只让 `pickModelFor` 返回空时，代码按既有兜底回退 `cfg.modelLocal`，属正确行为。修正为两者同空才触发降级，并补一条兜底回归断言；断言语义未放宽。修后 45/0。
- **验证（实跑）**：`node --check` 通过；`test_review_gen_e2e.js 45/0`；`run_all_tests --quick 127/127`（跳过 13 需网络，链路 3 与链路 4 E2E 均真跑）；`test_swallow_catch_guard` 空 catch 137≤138 / 路由内 5≤6，基线未增。`docs/test-report.md` 自动更新。
- **版本戳 / 服务**：本轮只新增测试文件，业务代码、服务端返回 JSON 结构、前端 UI 零改动 → APP_VERSION 不 bump、3005 服务无需重启（PID 2208 持续监听）。
- **同步状态**：链路 4 属本轮新增工作；按「任务完成后不自动同步、等用户明确说同步」的默认纪律，本地改动已完成、尚未 commit / push / 三端同步。

## 2026-11-11 22:1x · P2-1 批次 2 链路 5：数据源降级链（Fallback Chain）E2E + 新浪日K量纲 B2 修复 —— 批次 2 收官

- **触发**：用户验收链路 3/4 后明确指令「直接推进链路 5」，给定完整规格：桩 `axios.get`（不桩 `getQuote` 本身）、验证切源 / `source` 如实标注 / 降级数据单位口径对齐 / 全挂必须明确空态不伪造 0 价格；完成后全量回归并标记 P2-1 批次 2 全部完成。
- **真实探针实证（先查现状摆问题）**：`_probe_fallback.js` 实测腾讯 quote `volume=49,827,400`（股）、腾讯日K末根 `498,274`（手），ratio 恰 100 → 主链口径正确；`_probe_sina_unit.js` 实测新浪日K末根 `49,827,393`（**股**）→ **实锤新浪兜底 100 倍量纲错位**（B2 级：降级数据静默错位）。同时确认四个日K抓取通道均无来源标注。
- **修复（lib/stockData.js，最小隔离）**：① `fetchSinaHistory` volume `/100` 归一手（注释含 2026-11-11 实测依据）；② 腾讯/腾讯按结束日期/东财 push2his/东财 multiHost/新浪 共 5 处返回数组附 `.meta = { source, volumeUnit: '手' }`（沿用 `getHistoryPeriod` 数组级 `.meta` 先例，不影响遍历/序列化消费方）。
- **E2E**：新建 `scripts/test_fallback_chain_e2e.js`，require.cache 桩 axios（wrapped 函数 + Object.assign 保留真实 API），真实跑 `getQuote` / `getHistory` / `getQuoteHub`。§A 腾讯超时→东财接管+meta 标注+不浪费新浪兜底；§B 腾讯+东财全挂→新浪接管 + 49,827,400÷100=498,274 手断言；§B2 跨源同股数同手数；§C 三源全挂→getHistory 空数组 + getQuoteHub `ok:false` 明确空态不伪造价格；§D 静态守卫（÷100 固化、科创板归一保留、4 处 meta.source、三级顺序）；§E `@test-scope: local` 分类器自检。
- **首跑红灯如实**：4/8（mock 只 2-3 根，低于 `length>5` 有效性门槛被正确拒绝——门槛逻辑在工作，补至 8 根）；21/2（`mkRes({data:{data:{klines}}})` 响应体多包一层致东财每次「成功返回 0 根」——mock 核心修正后 23/0）。
- **修复后探针复验**：主链无回归（quote/日K ratio 仍 100）；两探针确认无进程依赖后删除。
- **APP_VERSION bump 至 20261111e（32 处变更，有据 bump）**：生产日志实证腾讯 501 + 东财 hang up 频发、新浪兜底在生产真实命中过 → 按 APP_VERSION 门控的深度分析磁盘缓存可能存有量纲污染结论，bump 是清除污染缓存可靠手段。`test_cache_bust_guard.js` 3/0/0。
- **最终回归**：`run_all_tests --quick` **128/128 通过，跳过 13 需网络**；`docs/整改方案-20261110.md` P2-1 行标记「✅ 批次 2 收官（2026-11-11）」（逐链 40/0、45/0、23/0；如实注明「analysis 接口」「切股链路」两条未单独固化及覆盖理由）。
- **服务重启 + 线上冒烟（实跑）**：旧实例（后台任务 PYaWKe，PID 2208，d 版代码）taskkill 后端口释放，旧任务 failed 属良性；受管后台任务重启 `20261111e`：`GET /` → 302 `?v=20261111e`；`/api/deep-analysis/601318` → `{status:'running'}`（appVersion 门控生效，量纲污染缓存已被清除并重算）；quote 主链 volume 49,827,400 股 / 53.41 无回归。
- **同步状态**：链路 4 + 链路 5 本地改动已完成、**尚未 commit / push / 三端同步**，等用户「同步」指令（用户原话「跑完汇报，我们准备封板」未含同步授权）。

## 2026-11-11 23:0x · P2-2 可观测性落地：结构化请求日志 + 数据健康面板（版本 20261111f）

- **触发**：用户验收链路 5 后明确指令启动 P2-2，六项规格：① 结构化日志中间件（logs/requests-YYYYMMDD.jsonl，ts/ReqId/路由/状态码/耗时，严禁 Response Body）；② 降级埋点 degraded:true；③ 启动清理 30 天旧日志；④ 首页「数据健康」卡片 + GET /api/health/dashboard 近 7 日聚合（总调用/异常率/各源降级次数/平均耗时）+ 固定脚注；⑤ 单测/实跑验证；⑥ 升版 20261111f。
- **新建 lib/requestLogger.js**（唯一出口）：express 中间件（AsyncLocalStorage 请求上下文 + res finish 写 JSONL）+ `markDegraded(source)`（无请求上下文静默忽略，定时任务安全）+ `cleanupOldLogs(30)`（只匹配 requests-*.jsonl 命名，不碰 server.log 等）+ `aggregateDashboard(7)`（坏行计入 parseErrors 跳过不中断；窗口外行过滤；空态全 0 不伪造）。防泄露三道硬闸：route 只取 pathname（split('?')[0]）、零 req.body 引用、行字段白名单测试固化。
- **新建 public/js/healthPanel.js**：KPI 四格（近7日调用/异常率/平均耗时/降级总数）+ 降级源表（腾讯/东财/新浪/Yahoo 中文名映射）+ 统计窗口元信息行 + 脚注（服务端 effectiveFrom 下发，前端静态兜底）。异常率 >5% 琥珀警示（健康面板无涨跌语义，不用红绿方向色）。
- **stockData.js 埋点 7 处（真实回退语义）**：getHistory CN/HK 东财/新浪兜底、getHistory US 腾讯/Yahoo 兜底、getQuote Yahoo 兜底、getHistoryPeriod 60m 腾讯失败走东财（day 周期东财是主路径不算降级）、市场概览新浪整批兜底、getHistoryDeep 腾讯兜底。**口径裁决**：长窗口设计性主路径（>800 根 60m 走新浪，腾讯无该能力）不算降级不埋点，面板统计的是「主源失败→备源接管」的真实回退。
- **接线**：server.js 挂载 `app.use('/api', requestLogger.middleware)`（静态资源不记）+ /api/health/dashboard 路由（days 参数 1-30 夹紧）+ 启动清理（失败不阻断）；index.html healthCard（rankCard 之后、可折叠、首次默认收起）+ healthPanel.js script；app.js init 接线 + defaultCollapsed 加 healthCard；style.css hp-* 系列。
- **守卫 scripts/test_health_panel.js 34/34**（@test-scope: local）：§A mini express 真端口真跑（字段白名单/query 零落盘/同请求同源去重/500 记录）；§B 无上下文静默；§C 清理只删超期 requests-*；§D 聚合（窗口过滤/坏行/errorRate 40%/avgDurationMs/按源计数）；§E 接线静态断言 + requestLogger 源码防泄露硬守卫（零 req.body、query 剥离固化）。
- **红灯如实 2 轮**：① Windows `utimesSync` 数字时间戳 EINVAL → 传 Date 对象（测试桩问题）；② 测试引用 healthPanel 闭包常量 ReferenceError → 改字面量断言；③ **吞错守卫红灯（空 catch +5）→ 根修不放宽**：requestLogger 五处静默空 catch 全部改为带 console.error 可观测或消除（markDegraded 去 try/catch），复跑 137≤138 基线恢复。
- **升版**：`bump_version.js 20261111f`（32 处变更，8 个 HTML 共 57 处 ?v= + 22 个测试文件版本语境行）；FRONTEND_BUST_FILES 手动加 healthPanel.js；`test_cache_bust_guard.js` 3/0/0、白名单 27 js 无差集。
- **全量回归：129/129 通过，跳过 13 需网络**（新增 test_health_panel 计入）。
- **服务重启 + 线上冒烟（实跑）**：旧实例（S5HFAA，PID 18508，e 版）taskkill 后受管后台任务（q9LCbD）重启 f 版：`GET /` → 302 `?v=20261111f`；`/api/health/dashboard` → ok:true 真实聚合（totalCalls 13 / avgDurationMs 936，自选股自动判定链请求已入日志）；`logs/requests-20261111.jsonl` 落盘格式正确、零 query/body 泄露。
- **同步状态**：P2-2 本地改动已完成、**尚未 commit / push / 三端同步**（链路 4+5+P2-2 三批改动累积待同步），等用户「同步」指令。

## 2026-11-12 0x:xx · P2-3 因子相关性离线报告（只读）+ 健康面板 writeFailures 元信息行 —— 版本 20261112a（方案 A→B 纠偏）

- **触发**：用户三轮计划——① P2-2 收口验收 7 项核查（已落实，4 硬缺口小补：route 未归一化 / X-Request-Id 零回写 / 客户端断开丢行 / 写失败不可见，均修不 bump）；② P2-3b 补 DESIGN.md 工程约束章节（第 13 章 5 条款 + 变更记录，已完成）；③ P2-3 开写前 dry-run 验明数据可得性，定稿后因方案 A 实测失败改方案 B。
- **dry-run 实证数据口径**：`getHistory(sym,'1y')` 返回 `{date,open,close,high,low,volume}` —— **不含 turnover**（腾讯主源不回传换手率）；`getQuote` 的 `pe/pb/turnover/circulationValue/totalValue` 均**单值快照无历史序列**；`lib/lookahead.js` **无截断函数**（仅 dateOf/addDays/auditSettlement）。
- **因子集定稿（8 项，同源 getHistory 日K OHLCV）**：mom_20d / vol_20d / vol_ratio / ma_bias / rsi_14 / macd_hist / gap_20d / drawdown_20d。删 ret_1d / turnover；pe_ttm / pb 无历史不参与；不加 log_market_cap（市值不可得）；默认追加 gap_20d / drawdown_20d。**均注明「因子集临时定义，待收编至 taxonomy」**（lib/taxonomy.js 不导出因子清单）。
- **新建 scripts/analyze_factor_corr.js（只读离线报告，不改权重）**：`rankAverageTies`（并列取平均秩，与 pearson(rank,rank) 等价）、`pearson`、`spearman`、`truncateToAsOf`（b.date<=asOf 过滤，口径与 lookahead.dateOf 一致）、`computeFactors`（macd_hist 需 35 根预热）、`cluster`（BFS 连通分量，输出 avgAbs/minAbsW 暴露最弱边）；`main()` 读 `data/watchlist.json` 8 只 × getHistory 250 交易日 → 截断 → 取最后 250 根 → 计算 → Pearson + Spearman 矩阵 → 聚类 → `buildReport` 写 `docs/logic/factor-corr-20261112.md`。脚本头注 APP_VERSION 与命令，`module.exports` 暴露统计原语供单测。
- **新建 scripts/test_factor_corr.js（11/11 全过，@test-scope: local 自动注册）**：Spearman 三值并列 X=[1,2,2,2,5]→spearman≈0.8944/rank=[1,3,3,3,5]、两值并列 X=[1,1,3,4,5]→≈0.9747/rank=[1.5,1.5,3,4,5]；pearson 完全±1、样本<3 返 null；簇 A-B 与链式 A-B-C 识别、minAbsW=0.1 暴露最弱边。
- **healthPanel.js 小改 + 测试断言**：元信息行 hp-meta 追加 `日志写失败 N`（读 d.writeFailures）；`test_health_panel.js` 加 DOM 断言 → **现 46/0**。
- **主脚本参数解析 bug（如实）**：初版 `argv.find(...)` 误取旗标本身致 `--days`→NaN→250、`--asOf` 取到旗标产出游离文件 `factor-corr-asOf.md`。修复用 indexOf + 检查下一元素取值，重跑产出正确 `factor-corr-20261112.md`（1840 有效样本，已删游离文件）。
- **产出 docs/logic/factor-corr-20261112.md（8 节齐全）**：① 因子清单（8 项+排除说明）② 缺失率表（macd_hist 14% 最高，均<30% 参与，旁注初始化窗口损耗 250→约 215）③ 相关矩阵 Top20 ④ 高相关聚类（簇1：mom_20d·ma_bias·drawdown_20d，avg|Pearson| 0.725，min 0.601，业务解读人工占位）⑤ 结论与局限（窗口敏感 / 同源不外推 / 市值缺失 / 预热损耗）⑥ Backlog（收编 taxonomy + 多窗口 + amplitude + 人工解读）。首页固定「⚠️ 不改权重，仅供裁决」。
- **⚠️ 方案 A 实测失败（关键纠偏，用户已知会）**：用户指令 Q1 按方案 A（APP_VERSION 保持 20261111f、?v= 单升 20261112a、DESIGN.md 记解耦说明）。冒烟 `curl js/healthPanel.js?v=20261112a` 返回 `Found. Redirecting to /js/healthPanel.js?v=20261111f` —— `server.js` L174–188 对 FRONTEND_BUST_FILES（含 healthPanel.js）强制 `?v!=APP_VERSION → 302 重定向回 APP_VERSION`，缓存破坏目的未达成。**改方案 B**：`node scripts/bump_version.js 20261112a`（32 处文件变更，白名单 29 项无差集），APP_VERSION 与所有 ?v= 同升 20261112a（代价：深度分析缓存一次性失效重算，此前 e 版已接受同质代价）。DESIGN.md 13.6 节已补「方案 A→B 纠偏」注记。
- **最终回归**：`run_all_tests --quick` **130/130 通过，跳过 13 需网络**（新增 test_factor_corr 计入；test_health_panel 46/0）；`test_cache_bust_guard.js` 3/0/0。
- **服务重启 + 线上冒烟（实跑，方案 B 生效）**：旧实例（PID 19000，f 版）taskkill → 受管后台任务（kFTrhA）重启 20261112a（PID 11852）：`/js/healthPanel.js?v=20261112a` → **HTTP 200 不重定向**；`?v=20261111f` 旧戳 → 302 重定向到 20261112a（缓存破坏正确）；`/api/health/dashboard` 含 `writeFailures`；`GET /` → 302 `?v=20261112a`。
- **同步状态**：P2-3 本地改动已完成、**尚未 commit / push / 三端同步**。本轮累积待同步 = 链路4 + 链路5 + P2-2 + 收口小补 + P2-3 共五批改动，等用户「同步」指令后一次性三端同步（用户原话「四批改动一次性同步」，实际含收口小补共五批）。

## 2026-11-12 1x:xx · P2-3 收尾 4 项修正（验收通过后，同步前）

- **触发**：用户验收 P2-3 通过、方案 B 合理，但指出「1840 有效样本」与「250→约215」对不上，要求 4 项修正后再回、待「同步」指令。
- **① 1840 口径自洽（实测算清）**：`rowsTotal=2000=8×250`（缺失率表 160/2000=8.0% 反推）；`validSamples=panel[mom_20d].length=230/只×8=1840`（mom_20d 预热 20 根，非 MAX_WARMUP 35）。**结论：1840 = 8 只 × 230 交易日**，原 §2 用 35 估 215 系误用 macd_hist 预热、已改「250→约230」并注明 macd_hist 缺口经 pairwise-complete 单独处理。**截断后最后日期 ≠ asOf**：lastDate=2026-11-11 < asOf=2026-11-12（强制 asOf 取今日、当日数据未定稿，滞后 1 交易日；脚本已 `if(lastDate!==asOf)` 告警并写入报告，非截断逻辑错误）。报告头与 §2 现已一致标注「1840 = 8 × 230」。
- **② 报告补两处 + drawdown 中性句**：§4 加「最弱边 0.601<0.7 系经 ma_bias 链式连通纳入，非两两直接高相关」（附 0.837/0.735 佐证）；§5 加「仅检出 1 个高相关簇，未发现第二个高相关簇」；簇内加中性事实（三者同属价格趋势维度：区间收益/均线偏离/区间回撤，同向则天然高相关），业务解读仍留「待补充」。
- **③ DESIGN.md 13.6 补强绑定条款**：新增「前端缓存戳(?v=)与 APP_VERSION 强绑定，前端任何改动均触发全量升版，不存在只升 ?v= 的路径（方案 A 已证伪）」。
- **④ 补实测三项**：空 catch 基线当前值 **137 处（路由内 5 处）**，历史基线 138/6 未增加，守卫通过 2/0（新增两脚本后净变化可控）；`test_health_panel.js` L203 经读 healthPanel.js **源码字符串**断言 `writeFailures`+`hp-meta` → 确认是**渲染逻辑断言（DOM 元信息行注入）**，与 L173 的 API 字段断言（`agg.writeFailures===0`）分属两层；D8 表述改为「无业务运行时确定性代码改动」。
- **验证**：`node --check` 通过；`test_factor_corr 11/0`、`test_health_panel 46/0`、`test_swallow_catch_guard 2/0` 全绿。报告 `docs/logic/factor-corr-20261112.md` 与脚本 `analyze_factor_corr.js buildReport` 文本同步修正（未来重跑口径一致）。
- **同步状态**：上述 4 项修正本地已完成、**尚未 commit / push / 三端同步**，等用户「同步」指令（累积待同步 = 链路4+链路5+P2-2+收口小补+P2-3+本轮收尾共六批）。

## 2026-11-12 1x:xx · P2-3 报告表述精度补强（同步前最后确认）

- **触发**：用户验收 4 项修正后，要求同步前确认报告是否写明「1840 为基准有效样本（20 根预热口径），macd_hist 对相关对经 pairwise-complete 约 1720，rsi_14 约 236/只」，避免读者误把 1840 当所有因子对统一样本量；并建议（可选）局限节加自相关/不做显著性检验一句。
- **核查口径数学**：`rowsTotal=2000=8×250`；基准 `validSamples=panel[mom_20d].length=230/只×8=1840`（warmup 20）；全因子齐备（含 macd_hist warmup 35）=215/只×8=1720；rsi_14 齐备=236/只（250−14）。三项与缺失率表自洽（mom_20d 160/8%、macd_hist 280/14%、rsi_14 112/5.6%）。
- **报告 §2 补「样本量口径警示」**：明示 1840 为基准（20 根预热）、macd_hist 对约 1720（8×215）、rsi_14 约 236/只，并写「请勿将 1840 视为所有因子对统一样本量——每对独立 pairwise-complete」。脚本 `buildReport` §2 同步补动态版（$(DAYS-MAX_WARMUP)*symbols.length=1720 等）。
- **报告 §5 加 局限 5（自相关/有效样本）**：因子基于重叠滑动窗口、时间序列自相关、名义样本高于有效样本，仅做描述性聚类不做显著性检验。脚本同步加。
- **核验**：脚本 `node --check` 通过；报告 §2 警示句、§5 局限5 均已落盘（行 38 / 行 84）。
- **同步状态**：本轮精度补强本地已完成、**尚未 commit/push/三端同步**；等用户「同步」指令（累积待同步 = 链路4+链路5+P2-2+收口小补+P2-3+两轮收尾，共六批）。

## 2026-11-12 16:xx · 三端同步（六批一次性）完成 + P2-3 落地复测

- **触发**：用户验收通过、明确「六批可同步」，授予「同步」指令；要求执行三端同步 + 同步前 3 检查点 + 同步后 4 复测。
- **同步前 3 检查点（全过）**：① 版本三处一致——`APP_VERSION=20261112a`（server.js L166）、57 处 HTML `?v=20261112a` 全一致、DESIGN.md 13.6 记录 20261112a；`test_cache_bust_guard.js 3/0/0`。② 测试注册齐全——`test_factor_corr.js` 带 `@test-scope: local`（quick 集）、`test_health_panel 46/0`、`test_swallow_catch 2/0`、全量 `run_all_tests --quick 130/130`（跳过 13）。③ 六批 git status 逐批核对——无 `_probe_/_tmp_/_diag_` 临时文件、无 `.log`、`.workbuddy/memory` 被正确 gitignore（不在 status）；密钥扫描 0 命中。
- **三端同步执行**：本地 `git add -A` → commit `1bfb932`（47 文件 / 1843 插入 / 149 删除，多节中文提交含六批）；`git push origin master` → `55aed54..1bfb932`；克隆端 `git fetch "D:/stock analyzer/stock-analyzer" master && git reset --hard FETCH_HEAD`（HTTPS 沙箱被拦，走本地 fetch 路径）。
- **三端 hash 终裁**：`LOCAL=REMOTE=CLONE=1bfb93253c6a8dc22be94cf4975279148688dac4`，三方全等 ✅。
- **同步后 4 复测（全过，P2-3 真正落地）**：① `js/healthPanel.js?v=20261112a` → HTTP 200 不重定向；② `?v=20261111f` 旧戳 → 302 重定向到 20261112a；③ `/api/health/dashboard` 返回含 `writeFailures`；④ 首页 → 302 `?v=20261112a`。服务 PID 11852 持续监听（运行代码与提交代码一致，无需重启）。
- **收官状态**：整改方案正文（P0/P2-1 批次1+2/P2-2/P2-3）全线收官；本地改动已 commit/push/三端同步完成（与用户铁律「任务完成不自动同步」——本轮用户已明确授予同步指令，故执行）。剩余仅 Backlog：analysis 接口/切股链路补测、健康面板缓存命中与 LLM 计数、多窗口因子对照、因子集收编 taxonomy、簇业务解读人工补。

## 2026-11-12 16:1x · 收官确认（用户确认关闭，无返工）

- **用户确认**：本轮无返工点，可以关闭。整改方案正文收官证据链完整——三端 hash 全等（1bfb932）、2 检查点全过、同步后 4 复测全过（4/4）、测试线全绿（130/130）、服务 PID 11852 运行代码与提交代码一致（同步仅 git 操作未动工作区，无需重启，判断正确）。
- **Backlog 建议优先级（用户给定）**：④ 因子集收编 taxonomy（文档债，半自动，先做成本最低，摘掉“临时定义”标签）→ ⑤ 簇业务解读人工补（人工判断不可自动化，脚本留占位正确，不要自动生成）→ ① analysis 接口/切股链路补测（E2E 完整性，中优先非紧急）→ ③ 多窗口因子对照（60/120/250，低优先等裁决需求）→ ② 健康面板缓存命中与 LLM 计数（可观测性增强，低优先当前已够用）。④+⑤ 做完即清掉“临时定义/待补充”两尾巴，报告从“可裁决”变“可归档”。
- **开工纪律（用户提醒，后续轮次遵守）**：① 任何 backlog 项开工前先 `git status` 确认工作区干净，避免多轮改动叠在一起同步；② 若 ④ 收编改了 lib/taxonomy.js，记得跑 `test_single_source_taxonomy.js` + 全量回归；③ ⑤ 人工补解读只改报告 md，不触发版本 bump。

## 2026-11-12 17:xx · ④⑤ 执行完成（本地改动落地，待「同步」指令）

- **④ 因子集收编 taxonomy（行为不变）**：
  - `lib/taxonomy.js` 新增 `FACTOR_LIST`（12 项 = 8 主因子 `inCluster:true` + 4 快照因子 `inCluster:false`；`Object.freeze` 数组+元素）；warmup 取 `computeFactors` 实际阈值（20/20/19/20/14/35/1/20），保证数值不变。
  - `scripts/analyze_factor_corr.js` 改 `require('../lib/taxonomy')` 引用；聚类集 = `FACTOR_LIST.filter(f=>f.inCluster)`（仅 8 项，不进相关性矩阵）；`computeFactors` 阈值保持硬编码不动；`buildReport` 补「最弱边注记（链式连通）」+「结构结论：未发现第二个高相关簇」并标记为可复现（此前仅手改 md，首次重跑被静默擦除，本次 bake 进 buildReport 修复）。
  - 新增守卫 `test_single_source_taxonomy.js §五`（该文件 P1-3 已建，本次追加段落）：校验 `FACTOR_LIST` 冻结/脚本引用/集合 → 27/0。
  - 重跑数值验证：`1840` 精确一致，`1720`/`236` 一致；簇成员一致；簇小数因实时数据较首跑滑 1 交易日略移（avg 0.724→0.725、min 0.601→0.602、ma_bias·drawdown 0.735→0.737、mom_20d·ma_bias 0.837 不变）——属数据重取非代码改动。
  - `test_factor_corr.js 11/0`、`run_all_tests --quick 130/130`（跳过 13）。**不升 APP_VERSION**（纯 lib 常量单源化）。
- **⑤ 簇业务解读补录（只改 md 不 bump）**：再生报告 §4 簇下 `【业务解读：待补充】` 按模板补录（相关性事实/事实描述/可检验假设 H1 H2/待验证/局限/补录人日期），标注「AI 草稿，待领域人复核」；未改任何数值。
- **DESIGN.md 13.7** 补「20261112a 补：taxonomy 因子清单收编，行为不变」+ 报告可复现性教训。
- **同步状态**：本地 7 文件已改（`DESIGN.md`/`SESSION-STATE.md`/`docs/logic/factor-corr-20261112.md`/`docs/test-report.md`/`lib/taxonomy.js`/`scripts/analyze_factor_corr.js`/`scripts/test_single_source_taxonomy.js`），**尚未 commit/push/三端同步**。运行 server (PID 11852) 未重启——④ 无运行时模块消费 `FACTOR_LIST`，行为零变化，服役中服务不受影响；重启沿用用户 .lnk 仪式。等用户「同步」指令后一次性三端同步（按 ④ 计划：taxonomy 守卫 + factor_corr 测试 + 全量 --quick；前端不复测）。

## 2026-11-12 17:2x · 同步前 3 件钉死（用户裁决：先确认再同步）

- **① 数值微移归因（已查清，纠正自我矛盾）**：
  - 首跑（已提交 1bfb932）报告头部：`⚠️ 最后一根 2026-11-11 < asOf 2026-11-12（数据滞后）` → **首跑 lastDate = 2026-11-11**。
  - 重跑（当前工作区）报告头部：`截断后最后一根日期 = asOf，数据新鲜` → **重跑 lastDate = 2026-11-12**。
  - 结论：两次 lastDate 相差 1 交易日 → **窗口后移 1 天**（重跑时 11-12 当日数据已出炉，250 日窗口整体前移），**非「数据滞后滑 1 天」**。簇小数 0.724→0.725 / 0.601→0.602 / 0.735→0.737 系窗口后移所致，确定性计算未变 → 良性、数据驱动，无需查腾讯修订或缓存差异。汇报措辞已改为「窗口后移 1 天」。
- **② buildReport 无手写数字（已验证）**：`analyze_factor_corr.js` L299-302/310 仅用动态变量 `${fmt(c.avgAbs)}`/`${fmt(c.minAbsW)}`/`${clusters.length}`/`${MIN_ABS_CORR}`，**无硬编码 0.601/0.724/0.837/0.735**；「最弱边 0.601」旧手写注记已随 bake-into-buildReport 改为 `${fmt(c.minAbsW)}`（报告文字与簇表 0.602 同源生成、完全一致）。
- **③ ⑤ 补录 §4 数字（已改为不重复列数）**：⑤ `相关性事实` 段改为「数值见上方 §4 簇表（mom_20d·ma_bias 最强、ma_bias·drawdown_20d 次之、mom_20d·drawdown_20d 最弱边经链式连通）…具体小数随数据窗口漂移，以簇表为准，此处不重复列数」→ 今后重跑报告不再与新数矛盾。
- **taxonomy warmup 与 computeFactors 阈值对应关系（已注明）**：`FACTOR_LIST.warmup`（20/20/19/20/14/35/1/20）**仅用于报告披露**（§1 预热列 / §2 样本量口径），**不参与计算**；实际计算口径是 `computeFactors` 内 `if (i>=N)` 阈值，与 warmup 严格一一对应但独立硬编码。已在 `computeFactors` 注释写明「改阈值须同步改 taxonomy warmup」，避免披露与计算口径漂移。
- **grep 佐证（运行时零消费，未重启判断成立）**：`grep -rn "FACTOR_LIST" --include=*.js . | grep -v taxonomy.js | grep -v analyze_factor_corr.js | grep -v test_` 输出**为空** → 无任何运行时模块消费 `FACTOR_LIST`，④ 行为零变化、未重启合理。

## 2026-11-12 17:3x · 新需求：个股每日复盘 15:30 自动（@skill:proactive-agent）

- **探查结论**：项目已有每日复盘调度（`server.js:2503 startDailyReviewScheduler`，`setInterval` 每分钟查槽）：15:35 主跑+15:40/45/50 补跑+20:30 龙虎榜补录+**20:45 观察池个股批量**+次日兜底；且**已查 trade_calendar 跳过非交易日**（L2517-2528）。即「开盘日自动、跳过非交易日」已具备。
- **缺口**：个股复盘自动仅覆盖**观察池**（`stockReview.runPoolBatch` 解析【明日核心观察池】表，≤12 行，L964），非全自选股池；且触发在 **20:45** 非 15:30。
- **依赖澄清**：`getPool()` 取的是 **D-1 大盘复盘**的观察池（B0-3：D-1 池即 D 日观察名单），故 15:30 跑个股复盘时 D-1 池已就绪 → 观察池联动无碍，时间可行。
- **LLM 计费**：每日 AI 复盘本就调 LLM（15:35 大盘复盘有独立总开关 `SA_NO_DAILY_AI_REVIEW=1`，L2894；`SA_NO_BG_AI=1` 仅关事件扫描+专属因子月度，不关每日复盘）→ 新增 15:30 全池个股批量（8 只×各 1 次 LLM）与现有模式一致，且受同一总开关管控。
- **拟定方案（待用户确认范围后再实现，不阻塞 ④+⑤ 同步）**：① `server.js` `REVIEW_SLOTS` 增 `{h:15,m:30,kind:'stock_watchlist'}`；② `stockReview` 新增 `runWatchlistBatch(date)`（遍历 `data/watchlist.json` 8 只，复用 generateReview/buildContext，幂等跳过当日已有）；③ 调度器加 handler 调 `runWatchlistBatch`；④ 需重启（server.js 改动）→ 用户 .lnk 仪式。
- **待确认（AskUserQuestion）**：① 15:30 覆盖范围=全自选股池 8 只 / 仅观察池 / 并集；② 与现有 20:45 观察池批量关系=保留并存 / 合并为 15:30 单次。

## 2026-11-12 17:5x · 15:30 自选股池自动复盘 已实现（独立 changeset，不阻塞 ④+⑤）

- **范围确认（AskUserQuestion 已答）**：① 覆盖 = 全自选股池 8 只（`data/watchlist.json`：601318/600909/000783/600460/688289/603288/000902/603014）；② 与 20:45 观察池批量 **并存保留**（二者来源不同：自选股池 vs 大盘观察池），互不覆盖。
- **改动文件（与 ④+⑤ 零重叠）**：`lib/stockReview.js`（新增 `runWatchlistBatch`，导出已加）、`server.js`（`REVIEW_SLOTS` 增 `{h:15,m:30,kind:'stock_watchlist'}` + handler + 启动日志）。
- **实现要点**：`runWatchlistBatch` 与已稳定运行的 `runPoolBatch`（20:45）严格同构——遍历 watchlist、串行、`resolveSymbol` 标准化键、幂等跳过（当日已有且 `schemaVersion` 未过期则不调 LLM）、单只失败不阻塞、LLM 降级计入 `degraded`、错误进 `errors`。
- **正确性核查**：`buildContext` 对大盘观察池联动走 `getPool()`（取最新已有大盘复盘，缺当日则回退上一交易日），**无对当日 15:35 大盘复盘的硬依赖** → 15:30 先于 15:35 主跑安全；自选股未必在观察池，`poolEntry` 为 null 属正常。
- **验证**：`node -c` 两文件语法 OK；`require('./lib/stockReview').runWatchlistBatch` 为 function；watchlist.json 解析 8 只正常。
- **生效条件（关键）**：`server.js` 改动需**重启服务**（用户 .lnk 仪式）后，新 15:30 槽才激活；下个开盘日 15:30 自动跑全自选股池 8 只。
- **状态**：本需求为**独立于 ④+⑤ 的新 changeset**，本地改动已完成、未 commit/push，**不自动同步**，等用户「同步」指令（届时 ④+⑤ 与本需求可一并或分两次提交）。

## 2026-11-12 18:0x · 幂等 skip 加 date 校验（防旧记录误跳）— 修复 + 负向测试

- **背景（用户第 4 轮 5 问质疑）**：复盘 15:30 首跑「跳过 4 只 / 生成 4 只」归因我曾口述为「跳过 4 只 = 今日 20:45 观察池批量生成」——该归因**错误**（当时时间 17:31，20:45 未到；且这 4 只文件 `trigger`/`source` 字段均为空、无来源标记）。**纠正**：这 4 只（601318/688289/603288/603014，mtime 16:09–16:44，均早于我的 17:40 跑批）是**有效的今日记录（date=2026-11-12、正文含「今日盘面事实/今日涨幅」、数据截止 11-12）**，非旧记录误跳；其真实触发源不明（非 15:30/20:45 cron，疑似更早手动或他处生成）。
- **隐患坐实**：原 `runPoolBatch`(L983) 与 `runWatchlistBatch`(L1026) 的 skip 仅判 `fs.existsSync(...)` + `schemaVersion` 匹配，**未校验 `cached.date === d`**。一旦存在「文件名是当日 `YYYY-MM-DD.json` 但内部 `date` 字段是更早日期」的陈旧/错位记录，会被误判为「当日已有」而跳过 → **幂等不成立**。本例 4 只恰为有效今日记录故未触发误跳，但隐患真实存在。
- **修复（本 changeset 唯一改动）**：两处 skip 均加 `&& cached.date === d` 校验（标注 `[20261112h]`），现跳过条件 = 文件存在 + 结构版本未过期 + **记录内 date 与本次目标日一致**。`.git diff` 仅 `lib/stockReview.js` 两行（L981-983、L1024-1026）。
- **负向测试（PASS，临时脚本 `_negtest.js` 跑完即删）**：
  - 谓词层：构造「文件名 2026-11-12.json、内部 `date=2026-11-11`」伪记录——旧逻辑 `skip=true`（误跳 BUG），新逻辑 `skip=false`（触发重生成）。对比真实今日记录两逻辑均 `skip=true`（date 匹配，正确）。
  - 实证层：备份 `603014` 真实记录 → 注入上述伪旧记录 → 跑真实 `runWatchlistBatch('2026-11-12')` → 返回 `{"total":8,"generated":1,"skipped":7,"degraded":0,"failed":0}`。其余 7 只真实今日记录正确跳过（skipped=7），被篡改的 `603014` 落入 `generated`（重生成），**证明旧记录不再被误跳**；随后从备份还原真实记录（`_tampered:false`，未被污染）。
- **结论**：幂等 skip 旧记录误跳隐患已消除并通过负向测试；15:30 自选股池复盘七项闭环（代码 / 三端 / 加载 / 注册 / 日历 / 时区 / 实际触发）中**六项已验证**，「三端一致」待本修复随「同步」指令提交后复测 hash 全等确认。
- **状态**：本地改动 `lib/stockReview.js` 为 `M`（未 commit/push），**不自动同步**，等用户「同步」指令（届时与 ④+⑤ 一并或单独提交；提交后需复测三端 hash 全等）。**〔已被下节取代〕**

## 2026-11-12 18:3x · 三端同步完成（07325d2）+ 重启验证 + 新增 backlog N1–N4

- **三端同步**：H_local = H_remote = H_clone = `07325d21763c6122e8d0e93781eb130b34db1e0f`（commit 2026-11-12 18:11:46 +0800，3 文件 +22/-2）。上节「未 commit/push」状态行**已被本同步取代**。插曲：预检出现第 4 个 M 文件 `docs/test-report.md`（run_all_tests 重写时间戳副作用）→ 按铁律停止 → 用户裁决「还原后同步 3 文件」→ 还原后提交；复测再次重写、再次还原，最终两端工作区干净。
- **复测口径（收紧版，防「三端全绿」误报）**：本地 run_all_tests --quick **130/130** ✅、taxonomy **27/0** ✅、factor_corr **11/0** ✅、/api/health `ok/20261112a/logWriteFailures:0` ✅。克隆端 taxonomy 27/0 ✅、factor_corr 11/0 ✅，但 run_all_tests --quick 中**数据依赖型估值测试**（`test_valuation_weigao.js` 603014 / `test_valuation_xinyangfeng.js` 000902）失败 → 归因：克隆端 `data/` 为空壳（无 data/companies，gitignore 不随 git 同步），**环境差异非代码回归，不作代码门禁**；代码验证以「本地复测 + 三端 hash 全等」为准。D1 口径 =「本地干净；克隆端仅剩预存 untracked bal_all.txt」，禁写「三端全干净」。
- **重启验证（等价 .lnk 仪式）**：新实例 **PID 12808** 启动 **18:24:46** > commit 18:11:46 > 修复落盘 17:54 → 加载含 [20261112h] 修复的代码；新日志（18:24 重建）含注册行「15:30 自选股池批量 + 15:35 主跑 + …」；health ok。15:30 口径不变：**六项做实，第 6 项「实际触发」待 2026-11-13 15:30 handler 结果行**（生成X/跳过Y/降级Z/失败W，且被 skip symbol 的 JSON `date === 2026-11-13`），届时方可改 ✅ 宣布七项闭环。
- **新增 backlog N1–N4（新编号，不覆盖原 backlog ①③②；①③② 状态不变：① 未开工 / ③ 未开工 / ② 未开工；④ 完成、⑤ 待领域人复核）**：
  - **N1** 跳过 4 只复盘记录的真实触发源不明（mtime 16:09–16:44、date=2026-11-12 有效今日记录，非 20:45 观察池）——已记录，不阻塞。
  - **N2** swallow-catch-manifest 陈旧疑虑——**实测已解决**：HEAD 版 manifest 即现码口径（137/5），本地重生成零 diff；克隆端曾现 M 为行尾伪差，checkout 后消失，无需 commit。
  - **N3** 克隆端 `data/` 不随 git 同步 → 克隆端全量复测不可作代码门禁——已归因环境差异，待数据桩/同步方案。
  - **N4** `docs/test-report.md` 每次跑 run_all_tests 自动重写弄脏工作区——建议 .gitignore 或改可选输出。
- **克隆端 untracked `bal_all.txt`**：mtime 2026-09-09 15:31，sh688660 资产负债表指标 markdown 转储（22 行）——**9 月预存临时文件**，非本次产生，不影响 hash 全等；删除与否待用户裁决。
- **总口径（结论）**：backlog 未做完；同步完成 ≠ backlog 完成 ≠ 15:30 七项闭环。

## 2026-11-12 18:4x · 口径修正 + bal_all.txt 处置 + 明日 15:30 核验清单

- **commit 绑定口径（WAL 固定句）**：15:30 六项中「三端一致」= **eb682d9**；**运行时修复 commit = 07325d2**；两者代码文件一致（eb682d9 仅 docs 补记），docs 差异不影响运行时。PID 12808（启动 18:24:46）晚于 07325d2（18:11:46）→ 加载修复后代码，成立。
- **D1 修正并升级**：此前口径「本地干净 + 克隆端仅剩预存 untracked bal_all.txt（🟡）」→ **已处置**：bal_all.txt 移入克隆端 `tmp/bal_all.txt`（未删、原样保留），`tmp/` 经克隆端 `.git/info/exclude` 排除（本地排除不入库，reset --hard 不影响）→ 克隆端 status 全净，**D1 = ✅**。
- **D4 口径固定**：以「**本地 130/130 + 三端 hash 全等**」为准；克隆端数据依赖型估值测试失败（data/companies/ 缺失）属环境差异，不作代码门禁；**禁写「三端回归全绿」**。
- **D10 / D12 = 🟡**：D10 逻辑层 PASS（负向测试 + 原始态 8/0 幂等空操作）、**cron 触发验证待 11-13**；D12 三端 hash 证据齐、**15:30 cron 结果行待 11-13**。
- **N4 修订建议（用户裁决）**：将 run_all_tests 报告输出改到 `.git/test-report.md`（不进版本库、证据仍留存）或从报告内容移除「生成时间戳」行（重跑零 diff）；**直接 .gitignore docs/test-report.md 会丢 D4 证据留存，不推荐**。实施穿插处理，不阻塞主线。
- **bal_all.txt 处置记录**：2026-09-09 预存临时文件（sh688660 资产负债表 md 转储）→ 移入克隆端 tmp/ 并本地排除；未删除（保留数据），不动 tracked 文件。
- **明日（2026-11-13）15:30 第 6 项核验清单（4 条同时满足才改 ✅、宣布七项闭环）**：
  1. `logs/server.log` 出现「15:30 自选股池批量」**结果行**（生成X/跳过Y/降级Z/失败W）；
  2. 被 skip 的每只 symbol 其 `data/stock-reviews/<symbol>/2026-11-13.json` 内 `date === "2026-11-13"`；
  3. `tradeCalendar.isTradingDay('2026-11-13') === true`——否则本就不该触发，第 6 项**顺延下一交易日**；
  4. degraded 数需说明复盘路径是否走 stockData 降级埋点；不走则只能写「未观测到降级」，不得写「无降级」。
- **待办清单修正（"你无待办"说法作废，AI 侧待办）**：① 明日 15:30 后按上表核验第 6 项（已建一次性自动化 15:40 触发）；② bal_all.txt 处置（本轮完成）；③ ⑤ 领域人复核推进（复核通过后删「AI 草稿」标注、报告转「可归档」）；④ 开 ①（analysis 接口/切股链路 E2E 补测）前先确认 git status 干净（当前 ✅），③② 按 WAL 顺序跟进，N3/N4 穿插。

## 2026-11-12 19:2x · N4 落地 + backlog ① analysis 接口/切股链路 E2E 四组全绿（本地 commit，未同步）

- **N4 落地（f2f4a11）**：run_all_tests 报告输出 docs/test-report.md → tmp/test-report.md（.gitignore 加 tmp/），跑测试不再弄脏工作区；D4 证据留存本地 tmp/。选 tmp/ 而非 .git/（按用户当日首选方案）。实测：--quick 130/130 后 git status 干净。
- **backlog ① 落地（a271180，6 文件 +651 行）**：四组 E2E 全绿——A 契约 test_analysis_api_contract_e2e.js **24/0**、B 切股 test_analysis_switch_e2e.js **14/0**、C 缓存 test_analysis_cache_e2e.js **18/0**、D 可观测 test_analysis_observability_e2e.js **16/0**；全量 **--quick 134/134（基线变更：新增 4 文件，130→134）**；空 catch 基线未增（守卫在全量内通过）；无前端改动不 bump（APP_VERSION 保持 20261112a）。
- **零运行时改动实现（测试脚手架）**：e2e_boot_analysis.js 吞 app.listen 启动回调（runAutoReview/自动判定/调度器/预热/.server-ready 全部不执行——它们全挂 listen 回调）+ require 缓存原地桩 stockData.getQuote/getHistory、shareholderData.getCompanyProfile（确定性 7 标的 + 失败注入 601008 持续失败/601009 首次失败/601077 延迟 400ms）；e2e_analysis_harness.js 环境隔离（SA_LOGS_DIR/SA_SETTINGS_FILE 重定向 + 死代理 127.0.0.1:9 拒连漏网外呼）+ data/analysis-warm.json 快照恢复（finally + process exit 双兜底）。
- **实测口径修正（对运行中 3005 实测，断言不臆测）**：① 真实契约顶层字段 = symbol/name/market/exchange/quote/history/technical/fundamental/signals/comparison/metricAnalysis/opProfit/insuranceNBV/companyType/companyProfile/timestamp（缓存命中附 cachedAt/cacheAgeSec），**无 asOf/factors/summary/degraded 字段**——A1 按真实契约断言；② 非法 range → **200**（getHistory 回退默认，无 400 路径）；③ 非法标的 → 404 无堆栈/路径泄露。
- **C2 现状记录（规格中最易写错条）**：analysis 缓存键 = symbol|range（lib/analysisWarm.js 源码核验无 APP_VERSION），「升版使 analysis 缓存失效」**当前不存在该路径**——断言只记现状；与前端 ?v=302 强制对齐（FRONTEND_BUST_FILES）是两套机制，cache_bust_guard 已覆盖不重复断言。
- **C5 注入成功**：SA_LOGS_DIR 指向已存在文件 → requestLogger.ensureStream mkdir ENOTDIR → logWriteFailures 如实 +1（业务请求仍 200）——纯环境变量注入，零运行时改动。
- **D4 降级口径（按用户裁决原文执行）**：analysis 路由 getQuote/getHistory 来自 lib/stockData.js（内含 8 处 markDegraded，AsyncLocalStorage 关联）→ 生产路径**经过降级埋点、计数可查**（dashboard.degradedBySource 断言存在）；本组桩替代 stockData 故 jsonl **「未观测到降级」**（不写「无降级」）；stockData 降级链语义由链路 5 E2E 覆盖，不重复断言。
- **B4 按用户裁决落法**：前端 _reqToken 为 app.js 内联逻辑不可导入 → 「复用 common-08 前端守卫覆盖，本组只测 HTTP 层并发」，不引入 jsdom。
- **插曲与加固**：首跑 D 组客户端未挂 error 监听 → ECONNRESET 未捕获崩溃 → finally 跳过 → 桩写入凝固在 data/analysis-warm.json（savedAt 19:14:27 实证）；已修 req.on('error') + harness 增 process exit 兜底恢复（guardedRestore），并清理残留（recents 移除 601001/601002/601003/601005/601077/ZZZZ99，保留真实浏览记录）。全量复跑后 grep 零残留。
- **生产探针痕迹（如实）**：核验期间对 3005 的只读 GET 探针（601318/ZZZZ99/600000）计入生产 requests jsonl 与 recents（ZZZZ99 404 计入当日 errorCount 1 次）——属真实请求流量，未回滚。
- **commit 绑定**：f2f4a11（N4）+ a271180（① 四组 E2E），本地未同步；D3 口径 = 按用户指示暂停同步。
- **状态**：**① 完成** / ③ 进行中（未开工，复用 analyze_factor_corr.js 计划窗口 60/120/250）/ ② 未开工 / ⑤ 待领域人复核；N1 挂起、N2 已结案、N3 待方案、N4 完成。

## 2026-11-12 19:3x · ① 收尾口径修正（用户裁决）+ N5 落地

- **① 完成口径修正（按用户裁决）**：① 完成成立（附两条件）——(a) **B4 由 common-08 前端守卫覆盖（_reqToken 内联逻辑不可导入），B 组不重复断言**，此前交付清单漏列现补注，非漏测；(b) **基线口径：134 = 测试文件数（130→134，+4 文件），断言总数 = 24+14+18+16 = 72**，勿与旧「130/130 断言」口径混淆。
- **口径统一（用户裁决，长期执行）**：③ 状态 = **未开工**（此前「进行中（未开工）」自相矛盾）；两套 D1–D12 编号冲突——工程闸门保持 D1–D12，技能闸门改记 **S1–S12**，同一汇报不得混用；A1 字段偏差记「规格假设被实测纠正」（责任在上轮规格，非实现），后续测试规格一律先读路由实际返回再落断言。
- **N5 落地（analysis-warm.json 隔离根治）**：lib/analysisWarm.js 的 PERSIST 加 `SA_WARM_PERSIST_FILE` 环境变量开关（测试钩子，运行时默认关闭、行为不变）；e2e_analysis_harness.js spawnServer 注入该变量指向临时目录 → 测试写入与 logs/settings 同级隔离，真实 data/ 不被触碰；快照恢复（guardedRestore）保留为第二道保险。e2e_boot_analysis.js 固化前提注释：吞 listen 回调依赖「副作用全挂回调」结构，重构启动序列须同步检查，否则先停用 E2E。

## 2026-11-12 19:4x · backlog ③ 多窗口对照落地 + N5 根治完成（本地 commit 37fc56e，未同步）

- **③ 落地**：analyze_factor_corr.js 加 `--windows 60,120,250` 与 `--out`（单窗口 main() 零改动，factor_corr 11/0 守卫复跑通过）。新增 analyzeWindowsCore/buildWindowsReport 纯函数 + mainWindows（取数一次三窗口共用）。对照表逐窗口：有效样本/非空相关对/簇数/簇成员/平均|P|/最强对/簇内最弱边/第二簇/样本判定（<100 标样本不足不结论）。报告 docs/logic/factor-corr-windows-20261112.md（**用户指定文件名 20261113 与今晚实际 asOf=2026-11-12 不符，按实际数据日期落盘；明晚重跑自动生成 20261113 版**）。
- **③ 实测结果（asOf=2026-11-12，8 只自选股）**：三窗口簇结构稳健——簇数 1→1→1，簇成员均为 mom_20d·ma_bias·drawdown_20d；平均|P| 0.193→0.167→0.173；簇内最弱边 0.846→0.576→0.611；无第二簇；三窗口均「可用」无样本不足。**降级如实标注：主源腾讯 501、东财拒连，8 只全部走新浪日K兜底**（两次实跑数值一致；数据源逐股计数由脚本动态写入报告，非手改）。60 窗口高相关对 3 对 > 120/250 的 2 对，如实记录未删。
- **新守卫 test_factor_corr_windows.js**（@test-scope: local，43 断言）：三窗口跑通/字段齐全/有效样本口径（(窗口−20)×N）/样本不足规则/防手改（md 表格逐单元格 = core 重算 + 篡改反证）/报告构建确定性/降级源标注渲染。run_all_tests --quick **基线 134→135（+1 文件，新增 43 断言）**，全部通过。
- **N5 根治完成**：lib/analysisWarm.js PERSIST 加 SA_WARM_PERSIST_FILE 环境变量开关（测试钩子，运行时默认关闭）；harness spawnServer 注入 + **C5 手工 spawn 子进程补注入**（N5 验证插曲：C 组 child2 漏注入导致写真实文件，靠第二道快照恢复救回——md5 相同 mtime 变化的判别实证了第二道保险有效，随后根治）；恢复逻辑优化为「内容与快照一致则跳过写回」（mtime 不再无谓更新）；四组 E2E 复跑后真实 data/analysis-warm.json mtime+md5 零触碰实证。boot 包装器固化前提警告：吞 listen 回调依赖「副作用全挂回调」结构，重构启动序列须同步检查否则先停用 E2E。
- **副作用如实**：docs/swallow-catch-manifest.md 行号平移（analysisWarm.js 加 4 行注释所致，137 处总数与 analysisWarm 4 处均不变，无新增空 catch），随本节一并提交。
- **commit 绑定**：37fc56e（③+N5）。状态：**① 完成 / ③ 完成 / ② 未开工 / ⑤ 待领域人复核**（⑤ 复核=用户动作，复核后删「AI 草稿」）；N1 挂起、N2 结案、N3 待方案、N4 完成、N5 完成。D3 = 按用户指示暂停同步。明日 15:30 后查第 6 项（stock_watchlist cron 实际触发），不占主线。

## 2026-11-12 19:5x · ③ 四点口径补齐（用户验收意见落地，报告重生成）+ N5 边界句补记

- **N5 边界补记（用户要求）**：lib/analysisWarm.js 的 SA_WARM_PERSIST_FILE 为默认关闭的环境变量分支——**生产未设置该变量时行为与改前逐字节一致**（PERSIST 回退原路径 path.join(__dirname,'..','data','analysis-warm.json')），不升版成立。
- **口径 1（防混读）**：对照表拆两列并列——「全对平均|P|（全部非空对）」vs「簇内平均|P|（与历史 §4 同口径）」，表头加口径警示行（0.725 是簇内平均、0.173 是 28 对全对平均，非同一口径，不可互比）；§2 序列行同步标注口径。本轮簇内平均：60=0.865 / 120=0.706 / **250=0.730（vs 历史 0.725，差 0.005 与最弱边漂移同量级同向）**。
- **口径 2（归因核实修正）**：**核实发现历史 factor-corr-20261112.md 的 asOf = 2026-11-12（非 11-11），与本轮相同**——「0.611 vs 0.602 归因窗口后移 1 天」的假设被文件核实否定；归因脚注改为按 asOf 是否一致动态分支：同 asOf → 「差异不能归因窗口后移，归因数据源/取数时点差异（历史报告未标注源），主源恢复后需同源复核」；异 asOf → 「窗口后移+源差异并存、不单独归因」。守卫两条分支均断言。
- **口径 3（短窗口不可直比）**：局限新增「短窗口样本口径与不可直比」条：320 = 8 只 × 40 有效点（窗口 60 根 − 20 根预热，损耗 20 根/只）；重叠窗口自相关更强，高相关对数与最弱边不可与 250 窗口直接比较，结论不外推。
- **口径 4（降级源影响）**：局限新增「降级源影响（不写『无影响』）」条：降级源量纲/缺失模式可能影响 vol_ratio、mom_20d 等因子相关强度（引用 P2-1 新浪 100 倍量纲错位修复前科）；跨日对照需固定数据源或标注源差异。
- **实现口径**：四点全部由 buildWindowsReport 动态插入（parseHistoricalSingleWindow 解析历史单窗口报告的簇内平均/最弱边作基线），非手改 md；报告重跑两次数值稳定。守卫 43→57 断言（新增四点口径 + 归因两分支 + 反证），test_factor_corr 11/0 不受影响；quick **135/135 维持**。

## 2026-11-12 20:1x · backlog ② 健康面板缓存命中与 LLM 计数落地（本地 commit a62d875，未同步）

- **指标定义（按用户裁决落死）**：缓存命中率按接口维度（analysis / deep-analysis / other）= hits/(hits+misses)，**分子分母同时暴露**（hitRate + hitRateDenominator 字段），aborted/错误请求单独计数、**不计入分母**；analysis 命中判定以 analysisWarm.getCached 实际返回为准；LLM 四类（ok/fail/degraded/timeout）互斥 1:1 分区、按调用点分桶，total=四类之和，与 stockData 数据源降级埋点完全独立。
- **实现边界**：计数器仅内存（lib/healthMetrics.js，零落盘、零新增写盘失败面）；Node 单线程同步自增（100 并发注入实测不丢不重）；/api/health 与 /api/health/dashboard 同源暴露 snapshot()（逐字段相等，禁前端二次计算）。
- **埋点接线**：LLM = lib/ai/llm.js callLLM 单点出口（caller 取自调用栈首帧，零侵入调用方；超时=err.timeout|budgetExhausted；degraded=三个降级点旗标——妙想回退/外部搜索失败纯推理/400 去参重试；singleflight 合并等待不计，未实际发起上游调用）；analysis = server.js 处理器（hit 即记，miss 经 finish 钩子 200-399 记，aborted 不触发 finish）；deep-analysis = deepJobManager 磁盘缓存命中分支（fromCache:true 为准；**running 轮询计入 miss，口径如实未做轮询去重**）；aborted/error = requestLogger emit 全 /api 单点归类。
- **首跑实证修正（防双计）**：finish 钩子最初同时记 error → 与 requestLogger 双计（errors=2 实测）→ 修正为 error 归 requestLogger 单点、finish 只记 miss → errors=1 复跑通过。
- **空 catch 铁律**：新增 2 处注释型 catch（server.js L772/requestLogger L137）触发空 catch 守卫失败（+1）→ 已改实质 console.error 处理 → 守卫复跑通过（137 ≤ 138 基线）。
- **守卫**：scripts/test_health_metrics_e2e.js（39 断言，@test-scope: local）：0.75 命中率计算/排除项/LLM 四类注入/未知 outcome 归 fail 不丢计数/100 并发/接口归一/快照深拷贝隔离/源码接线断言/桩服务器 E2E（miss→hit→404→aborted→10 并发 → hits=1/misses=11/errors=1/aborted=1/hitRate=1/12；dashboard 与 health metrics 逐字段相等；桩环境 llm.total=0 结构齐全）。run_all_tests --quick **基线 135→136（+1 文件）全部通过**。
- **前端决策（按用户要求确认）**：本轮**不动前端**——dashboard JSON 已含 metrics 供核对，前端健康卡片展示属 UI 改动需全量 bump+?v= 同步，留待下次前端改版一并上线；无前端改动不 bump（APP_VERSION 保持 20261112a）。
- **生效提醒**：运行实例（PID 12808，18:24 启动）仍是旧代码，**新指标需重启 Stock Analyzer 后生效**（桌面快捷方式 + Ctrl+F5）。
- **状态**：**① 完成 / ③ 完成 / ② 完成 / ⑤ 待领域人复核**；N4/N5 完成、N1 挂起、N3 待方案；断言总数 72+43+39=154。D3 = 按用户指示暂停同步。明日 15:30 后核验第 6 项。

## 2026-11-12 20:5x · ③ 簇内平均同因脚注 + ② 三处风险确认与 meta 文案 + 重启通道（本地 commit 9f15d47/1f7a49d，未同步）

- **③ 脚注（9f15d47）**：§1.1 补「簇内平均 0.730 vs 历史 0.725（差 0.005）与最弱边漂移（0.611 vs 0.602）同因——同 asOf 同窗口下归因数据源/取数时点差异；两数口径一致（均为簇内平均），非口径变化、非相关性衰减」，两分支（同/异 asOf）动态生成；报告重生成，守卫断言零改动（57/0 复跑通过）。
- **② 三处风险确认（实证）**：① 旗标互斥/优先级——llm.js callLLM 单变量单赋值：成功路径 `mctx.fallback ? 'degraded' : 'ok'`（降级优先于成功）、异常路径 `(e.timeout||e.budgetExhausted) ? 'timeout' : 'fail'`（超时优先于失败）、finally 单点单次记录、未知 outcome 归 fail 防丢计数；② 异常隔离——四处埋点（llm.js:220/requestLogger:131-137/server.js finish 钩子/deepJobManager:196）全部 try-catch 包裹，计数失败仅 console.error 不影响主流程；③ 10 并发构造——守卫构造本身正确但**时序敏感**：runner 负载下 601002 首请求同步算完 setCached 后续并发变 hit（实跑实证 hits=2/misses=10 间歇失败）→ 根治：601002 桩加 400ms 延迟保证 10 请求全部先进入处理器再完成，连跑 3 次稳定全绿。
- **② meta 文案口径（9f15d47）**：snapshot() 增 meta——`window=since_process_start`（统计窗口=本进程启动以来，重启清零）、`otherHitRate=N/A`（other 接口无缓存语义，仅 aborted/errors 计数，hitRate 恒 null 不捏造 0/1）、`excludedFromDenominator=aborted/errors`；守卫 39→43 断言（A7 文案口径节）；quick **136/136 全部通过**；断言总数 72+43+43=**158**。
- **重启（部分完成，等用户双击）**：agent 侧重启通道实测不可靠——启动器 launch_hidden.js（1f7a49d，start.vbs 的 Node 等价物：PORT=3005/SA_NO_AUTO_OPEN=1/SA_NO_BG_AI=1/日志追加/detached 存活）两次启动均成功（PID 26348、HTTP 200、调度注册行落 server.log），但服务自身启动行情预热外呼（q.10jqka.com.cn）触发代理权限询问、用户拒绝后进程树被回收（两次实证；沙箱 Job Object 连带回收 + 权限拒绝杀请求方）。**最终重启交用户双击桌面快捷方式（18:24 实例的启动路径，不受代理权限限制）**。重启后验证清单：① 新 PID 启动时间晚于 1f7a49d；② logs/server.log 有「[每日复盘] 定时调度已启动…」注册行；③ /api/health 含 metrics.meta（window=since_process_start）；④ Ctrl+F5 硬刷新。
- **⑤（推进半步）**：已出专家推荐卡（两位量化领域专家，卡片超时未选择）→ 待用户从卡片或左侧「专家中心」选择后复核 factor-corr-20261112.md §4 业务解读；复核通过后删「AI 草稿」标注、报告转「可归档」。
- **状态**：**① 完成 / ② 完成（附三处确认）/ ③ 完成 / ⑤ 待领域人复核**；N4/N5 完成、N1 挂起、N3 待方案；重启验证挂起（等双击）；明日 15:30 后核验第 6 项。D3 = 按用户指示暂停同步。

## 2026-11-12 21:0x · 用户验收 ③/② + 两句留痕 + 重启五点清单线上核验通过（本地 commit，未同步）

- **③ 脚注验收：接受**（0.730 vs 0.725 与 0.611 vs 0.602 同因归入一条脚注；两数均为簇内平均、非口径变化、非相关性衰减；两分支动态生成 + 57 断言零改动复跑）——口径闭合。
- **② 三处确认验收：接受，附两句留痕（用户要求）**：
  1. **LLM 分类互斥优先级（防未来加旗标破坏互斥）**：「一次调用只计一类，优先级 **timeout > fail > degraded > ok**」。实现现状如实：异常路径只出 timeout/fail、成功路径只出 degraded/ok，两路径互斥不会同时命中；该顺序是未来新增旗标时的兜底裁决顺序，禁止一次调用写两类。
  2. **launch_hidden.js 权限边界（防未来误用）**：「agent 侧启动会触发行情预热外呼（同花顺 q.10jqka.com.cn）网络权限询问，拒绝则进程树被回收；**生产重启仍以桌面 Stock Analyzer.lnk 为准**，agent 通道仅作已批准网络权限场景的备用」。
- **10 并发 400ms 经验值留痕**：注释已写入 scripts/e2e_boot_analysis.js（桩延迟行）与 scripts/test_health_metrics_e2e.js（B1 段）——「依赖桩延迟保证并发窗口，机器极慢时可能仍抖动；若未来复现，优先加大延迟（如 800ms）而非放宽断言（禁止改 hits/misses 精确断言）」。纯注释，断言零改动。
- **meta 严格 schema 小提醒（如实记录）**：metrics.meta 为纯增字段，若未来 /api/health 消费方做严格 schema 校验会受影响；当前无前端消费、不阻塞；重启后已确认旧字段未变（见下）。
- **重启五点验证清单（固定，用户裁决）**：① 新 PID 启动时间晚于最新 commit；② logs/server.log 有「[每日复盘] 定时调度已启动…」注册行且含「15:30 自选股池批量」；③ /api/health 返回 metrics.meta.window=since_process_start 且 logWriteFailures:0；④ 前端 Ctrl+F5 硬刷新；⑤ /api/health/dashboard 与 /api/health 的 metrics 逐字段相等，且 otherHitRate 为 N/A 而非 0。
- **线上核验结果（2026-11-12 21:04，核验时 HEAD=8d06c81，用户已双击 .lnk）**：**五点中四点服务端项全部通过**——① 新 PID **14552** 启动 **21:02:40** > 最新 commit 8d06c81（20:56:35）；② server.log:10 注册行含「15:30 自选股池批量」；③ metrics.meta.window=**since_process_start**、logWriteFailures=**0**；⑤ dashboard.metrics 与 health.metrics **逐字段相等**、otherHitRate=**"N/A" 字符串**（非 0/null）。④ Ctrl+F5 为用户侧动作，已在汇报提示。
- **旧字段未变 + ② 线上生效硬证据**：/api/health 顶层 7 键 status/version/valuationModelHash/uptime/mem/logWriteFailures/metrics 与 server.js handler 源码一致，meta 仅增在 metrics 内；生产实例已有真实计数 analysis **hits=8 / misses=13 / hitRate=0.381 / 分母=21 / aborted=0 / errors=0**（分子分母同时暴露、排除项不进分母），证明 ② 埋点在真实流量下工作。
- **时间线口径（防误读）**：五点核验在 HEAD=8d06c81 时完成；本节 WAL/注释 commit 为纯文档、不改运行时代码，PID 时序结论以运行时代码最新（9f15d47 + 1f7a49d）为准，文档 commit 不参与运行时比对。
- **⑤ 状态 🟡 不变**：专家推荐卡已出、超时未选择，属流程推进半步、非复核完成；复核对象 factor-corr-20261112.md §4 价格趋势簇（mom_20d·ma_bias·drawdown_20d）相关事实与 H1/H2；验收标准 = 领域人书面复核通过 → 删「AI 草稿」→ 报告转「可归档」。
- **状态**：原 backlog ④①③② **均完成**（② 本轮线上生效已实证）/ ⑤ 🟡 待复核；N1 挂起、N3 待方案、N4/N5 完成；15:30 第 6 项 ⏳ 待 2026-11-13 15:30。工程闸门 D12：重启验证部分完成，剩 15:30 cron 实证，仍 🟡。D3 = 按用户指示暂停同步。
- **结论口径**：主线 backlog **4/5 完成**；不宣布 backlog 完成、不宣布 15:30 七项闭环；同步暂停不变。

## 2026-11-12 21:1x · 五点核验第 ① 项比对对象订正 + 真实计数口径收窄（用户裁决；纯文档，断言零改动）

> 本节订正 21:0x 条目第 ① 项与「真实流量」两处表述，**以本节为准**；历史条目按 WAL 语义保留原貌不回改。

- **① 比对对象 = 运行时最后代码 commit，不是 HEAD 最新 commit**：用「PID 14552 启动 21:02:40 > 最新 commit 8d06c81（20:56:35）」证明加载了新运行时代码，逻辑不严——8d06c81 是纯 WAL/文档 commit，不参与运行时加载；且 6f2dbb9（21:12:33）提交时间**晚于** PID 启动，更反证「晚于最新 commit」不成立。
- **逐笔核实（`git show --stat`）**：② 主体落地 = **a62d875（20:13:47）** → `server.js` / `lib/healthMetrics.js` / `lib/ai/llm.js` / `lib/requestLogger.js` / `lib/deepJobManager.js`；**运行时服务代码最后一次改动 = 9f15d47（20:41:50）** → 该 commit 除 ③ 脚注与离线脚本外**还改了 `lib/healthMetrics.js`（+10/-1）**，即 `meta.window` / `otherHitRate` / `excludedFromDenominator` 的落地来源，也正是第 ③ 项核验点 `meta.window=since_process_start` 能读到的原因，**不能归为「不改运行时服务代码」**。PID 21:02:40 同时晚于 a62d875 与 9f15d47。
- **不参与运行时比对（逐笔核实）**：`1f7a49d`（`scripts/launch_hidden.js`，备用启动通道，服务进程不 require）、`9e44e34` / `8d06c81`（`SESSION-STATE.md` 纯文档）、`6f2dbb9`（`SESSION-STATE.md` + 两个测试脚手架注释）均不改运行时服务代码。D11「核验在 8d06c81 为 HEAD 时完成、文档 commit 不参与运行时比对」方向成立。
- **真实计数口径收窄**：`analysis hits=8 / misses=13 / hitRate=0.381 / 分母=21 / aborted=0 / errors=0` 一律记为「**生产实例计数（含本轮核验请求）**」，不写「纯用户流量」。逐项核实「是否包含」：本轮 agent 的 `curl /api/health` 与 `curl /api/health/dashboard` **打到 3005 生产实例**，但两路由只调 `healthMetrics.snapshot()`，归 `other` 接口且 200 成功不记 aborted/errors，**不贡献 `analysis` 的 hits/misses**（埋点仅在 `server.js:764/771` 的 `/api/analysis/:symbol` 处理器）；E2E 四组桩服务器为 `39200 + 随机(0~599)` 独立端口 + 独立 logs/settings/warm 路径 + 死代理，**不打到 3005**。故计数窗口 `since_process_start`（21:02:40 起）覆盖核验时段、请求进入过生产实例，但 21 次分母无法逐条归因到用户浏览器 → 按用户裁决不收窄为「纯用户流量」。② 线上生效结论只依赖「埋点在真实 HTTP 请求下被触发」，不依赖流量来源纯净性 → **结论不变**。
- **范围与状态**：仅本 WAL + 工作日志两个文档，断言零改动、运行时代码零改动；旧字段 7 键未变、`meta` 只增在 `metrics` 内不变；⑤ 🟡、N1/N3 挂起、15:30 第 6 项 ⏳ 待 2026-11-13 15:30、D3 暂停同步，均不变；主线 backlog **4/5**，不宣布 backlog 完成、不宣布 15:30 七项闭环。

## 2026-11-12 21:4x · S12 流程固化 + 同步指令归属（用户裁决；纯文档，不单独 commit）

- **S12 流程固化**：21:1x 轮「开头 stamp 加载 + 结尾补加载」形态已如实自我披露、用户接受且本轮不返工；此后固化为「实质工作开始前不加载交付闸门技能、交付前一次性加载并对整条待发消息逐项过闸」，不重复该形态。
- **同步指令归属**：同步默认继续暂停（用户此前「之后的任务先不同步」），agent 不主动发起、不催促、不以「等待您的同步指令」收尾；一旦出现明确的「同步」指令，由 agent 执行 `commit → push → 克隆端 fetch+reset → 三端 hash 全等` 整套仪式；在此之前本地 commit 累积、D3 ⏸。

## 2026-11-12 23:1x · D1 裁决：选项 A（单文件本地 commit 恢复干净工作区）

- **裁决 + 实证**：采纳选项 A——21:4x 节 5 行追加单独本地 commit（纯文档、不改运行时、不 bump APP_VERSION）。实跑 `git status --short` 原文仅 ` M SESSION-STATE.md`，`git diff --stat` 为 `SESSION-STATE.md | 5 +++++`；提交后 status 无输出 → 工作区干净、**D1 回 ✅**；同步仪式启动后直接 push 现有本地 commit 链，不夹带未提交改动，仪式内不再多一步 git add/commit，避免与「三端 hash 全等」比对对象混淆；选项 B（D1 标 🟡 + 同步时先补 commit）不采纳。`.workbuddy/memory/2026-11-12.md` 经 `git check-ignore -v` 命中 `.gitignore:27:.workbuddy/`、`git ls-files --error-unmatch` 报 not tracked → 未被 git 跟踪，工作日志不计入工作区，「仅一个未提交文件」成立。
- **范围与状态**：本轮仅 WAL + 工作日志（后者被忽略）+ 一次单文件本地 commit，代码/断言/运行时零改动；D4 沿用 21:1x 轮实测 136/136 文件 / 158 断言，下次跑全量时刷新；同步归属按 21:4x 节不变，本轮不 push / 不 fetch / 不做三端校验，D3 ⏸；⑤ 🟡、N1/N3 挂起、15:30 第 6 项 ⏳、主线 backlog **4/5**，均不变；不宣布 backlog 完成、不宣布 15:30 七项闭环。

## 2026-11-12 23:4x · ⑤ 专家书面复核（结论：不放行）｜用户选定「凌霄渡」

- **复核发起与产出**：用户在专家中心选定「凌霄渡」（AI 应用架构师）后下达复核指令；按该专家 `reality-check` 质量门（默认不放行、逐条 VERDICT + EVIDENCE、只核事实不产方案）对 `docs/logic/factor-corr-20261112.md` §4 出具书面意见，独立落 `docs/logic/factor-corr-20261112-review.md`；**被复核报告原文一字未改**。意见内已声明能力边界（工程/事实一致性复核，不替代量化领域人书面签字、不代签）与 IF_RISK 契约不适用。
- **结论：不放行**：8 项 = 成立 2（§4 数值与 `cluster()` 口径一致、待验证②③与 §5 局限如实）、不成立 2（H1 方向、待验证①状态过时）、存疑 4（「不构成独立信息增益」等断言、H2 无量化门槛、数据源标注缺失、重跑覆盖风险）；按「存疑/未确认维持不放行，不擅自降级」纪律不降级。
- **硬证据（可复算）**：`analyze_factor_corr.js:153-156` 定义 `drawdown_20d = (close − 20日最高)/20日最高 ≤ 0`，上涨时指标数值趋近 0、回撤幅度收窄；§3 `mom_20d·drawdown_20d = +0.602`、`ma_bias·drawdown_20d = +0.737` 同向印证；§4 H1「回撤随上涨放大」与因子定义及本报告实证符号**相反**。③ 多窗口报告 §2 已证簇结构跨窗口稳健，而本报告 §4/§5/Backlog 仍写「待验证 / 本轮未实现 / [ ]」，带此状态归档即状态失真。另 `:244-247` 整文件覆盖写 + `:295-305` 不生成【业务解读】块 → 重跑会静默丢失该段。
- **按用户通过条件执行**：**不删「AI 草稿」、不转「可归档」、⑤ 保持 🟡、主线 backlog 仍 4/5**；6 项必改与建议改法写入复核档案，整改后需再次书面复核；领域人书面签字仍由用户侧完成，agent 不代选、不代签，「专家已出意见」不算验收。
- **验证与范围**：新增 `docs/logic/` 文档后实跑 `run_all_tests.js --quick` 验证守卫不受影响 → **136/136 通过、跳过 13（需网络）**（其中一条外呼 `www.eeo.com.cn` 的网络权限请求被拒绝，属跳过用例、退出码 0，按工具规则未重试）；D4 按用户规则刷新为 **23:4x 轮实测 136/136 文件**，断言数 158 沿用（零测试改动、本轮输出未单独采集断言数，不虚报为当轮采集）。本轮仅新增复核档案 + 本 WAL + 工作日志（后者被忽略），代码/断言/运行时零改动、不 bump；单独本地 commit（纯文档）后工作区干净、D1 ✅；D3 ⏸ 不 push / 不 fetch / 不做三端校验；N1/N3 与 15:30 第 6 项状态不变；不宣布 backlog 完成、不宣布 15:30 七项闭环。

## 2026-11-13 00:1x · ⑤ 整改归属裁决：agent 改 1–4 / 领域人裁决 5–6

- **时间事实先行订正**：用户提示「今天 2026-11-13，15:30 第 6 项窗口已到」。实跑 `date` = **2026-11-13 00:15:54（周五凌晨）**，**时刻未到 15:30**，按用户自己给的分支「若未到 15:30，继续等」处理：本轮**不执行四步清单核验**（grep 结果行 → 校验 `2026-11-13.json` 的 date → 核对交易日 → degraded 只写「未观测到降级」），**不写任何降级结论**；不是被 ⑤ 挤掉，是时刻未到。该项仍 ⏳ 待今日 15:30 之后。
- **裁决**：采纳用户建议方案——**agent 改 1–4（事实 / 状态 / 工程），领域人裁决 5–6（业务断言）**；不采纳「6 项全等领域人」。「不代签」= 不代替领域人签署通过结论，**不等于连事实错误都不改**；改事实错误不产生签字效力。报告整改后仍标「AI 草稿，待领域人复核」，**未删标记、未转「可归档」**、⑤ 仍 🟡、agent 不代选不代签。
- **谁改、改了什么、依据哪条复核意见**（逐项留痕）：
  - **1 H1 方向订正（ITEM 2，事实错误，agent 改）**：§4「可检验假设」H1 由「drawdown_20d 通常同步走阔（回撤随上涨放大）」改为「**数值趋近 0（回撤幅度收窄，因价格接近 20 日高点），与 §3 的 +0.602 / +0.737 正相关一致；需样本外分组统计验证**」。H2 原文逐字保留。
  - **2 ① 状态同步（ITEM 5，既成事实，agent 改）**：§4 待验证 ① 改「**已验证**」并引用 `factor-corr-windows-20261112.md` §2（簇数 1→1→1、最短与最长窗口成员一致）；§5 局限 1「本轮未实现」改「**已完成**」；Backlog 多窗口条 `[ ]` → `[x]`。**同时改脚本模板**，否则重跑会把三处状态写回旧值（本轮核实出的关键联动）。
  - **3 数据源标注（ITEM 7，事实补充，agent 核实后补）**：**核实结论 = 本轮实际源无法追溯**——单窗口报告生成于 2026-11-12 16:50:03，`main()` 的 `truncateToAsOf` 用 `Array.filter` 丢弃挂在数组上的 `.meta.source`（多窗口 `mainWindows()` 专门有补救注释），脚本未采集、日志无记录；多窗口报告生成于 20:20:49、其 §0「新浪日K ×8（腾讯主源 501）」属**另一轮独立取数**，相隔约 3.5 小时，**不可等同于本报告源**。故按用户给的兜底口径写「**取数源未记录，待补**」+ 交叉引用多窗口 §1.1 同因脚注 + 「不可等同」说明，**不编造「8 只全走新浪日K兜底」**；模板同步生成同一句（重跑不丢）。
  - **4 业务解读块防覆盖（ITEM 8，工程修复，agent 改脚本）**：`scripts/analyze_factor_corr.js` 新增纯函数 `extractBusinessBlocks()` / `preserveBusinessBlocks()` 与 `BIZ_PLACEHOLDER` 常量；`buildReport()` 的 §4 占位符改用常量；`main()` 写盘前读既有报告、按簇序回填【业务解读】整块（`fs.writeFileSync` 仍整文件覆盖，但业务文字原样保留）。**业务解读文字不固化进代码**——业务断言归领域人裁决，脚本只负责「重跑不擦除」。模板另同步数据源标注 / 局限 1 / Backlog 三处状态。
  - **5 / 6 业务断言（ITEM 3 / ITEM 4，领域人裁决）**：「不构成独立信息增益」「可压缩为单一潜因子」**原文逐字保留、未擅自收敛**；仅加旁注「**复核存疑（待领域人裁决）**」附依据（最强边 0.837 → R²≈0.70、剩约 30% 方差、未做偏相关 / 增量 R² / 共线性检验；H2 未做 PCA、无方差解释率门槛、与 §5 局限 5 冲突），及 **agent 建议门槛「第一主成分方差解释率 ≥ 70% 才称可压缩为单一潜因子」——明确标注仅供领域人定夺、未采纳前不改原文**。
- **整改不覆盖复核记录**：`docs/logic/factor-corr-20261112-review.md` **一字未改**，md5 前后均为 `9631f759114758ad214d34fc44b25a5f`；仍为「不放行」结论、8 项判定完整。报告内另加「整改留痕」条目，写明谁改、改了什么、依据哪条 ITEM、非领域人签字。
- **整改后重跑（离线，不联网、正式报告零触碰）**：`tmp/verify_05_rerun.js` 模拟 `main()` 写盘两步（`buildReport` 重算 + `preserveBusinessBlocks` 回填），输出隔离到 `tmp/factor-corr-rerun.md`，**11/11 全通过**：业务解读块数量 1→1 与 md5 全等（`f0afef3f…`）、§3 数字区与脚本重算逐字一致、无占位符残留、局限 1/Backlog/数据源标注三行模板与报告逐字一致、正式报告 md5 未被触碰。**未真跑 `main()` 到正式路径**：脚本会联网重算并整文件覆盖，当前源若与 16:50 不同会使 §3 的 0.837/0.737/0.602 漂移（多窗口 250 日已是 0.838/0.611），破坏复核意见引用的证据链。
- **新增守卫**：`scripts/test_factor_corr_preserve.js`（零网络、`@test-scope: local`）36/36 通过，覆盖模板状态同步、重跑逐字保留、数字区不受污染、幂等、占位符不当业务结论、块不足/多簇按序、报告 1–3 已改 / 5–6 原文保留、AI 草稿标记仍在、复核档案 md5 钉死。`run_all_tests.js --quick` **137/137 通过、跳过 13（需网络）**（较上轮 +1 文件 = 新增守卫；输出末尾一条 `www.eeo.com.cn` 外呼权限被拒属跳过用例、退出码 0，按工具规则未重试）；D4 按用户规则刷新为 **00:1x 轮实测 137/137 文件**。断言数口径如实说明：既有「158」是 ①E2E 72 + ②健康 43 + ③多窗口 43 的**重点增量组合计**，本轮未改这三组故沿用；**本轮新增守卫 36 断言为当轮实跑（36/36）**，按同口径累加 194。另尝试用 `tmp/collect_assertions.js` 全量重采，仅 43/137 个文件带标准「通过 N/失败 M」汇总行（合计 1958），其余 94 个输出格式不一；该批量命令末尾再次触发 `www.eeo.com.cn` 外呼权限拒绝，**按工具规则未重试**，故 1958 只是子集统计，**不冒充全量断言总数、不虚报为当轮重采结果**。
- **范围与隔离**：仅改 `docs/logic/factor-corr-20261112.md`（报告）、`scripts/analyze_factor_corr.js`（离线脚本）、新增 `scripts/test_factor_corr_preserve.js`（守卫）、本 WAL + 工作日志（后者被忽略）；`tmp/` 下补丁与验证脚本被 `.gitignore:9` 忽略、不入工作区。核实 `analyze_factor_corr.js` **仅被 3 个测试脚本 require，`server.js`/`lib/` 仅注释提及 → 离线脚本，不参与运行时服务加载**，故**不重启生产、不 bump `APP_VERSION`**；PID 14552 运行时基线不受影响。
- **状态与闸门**：④①③② ✅、⑤ 🟡（1–4 已整改可核，5–6 待领域人裁决 → 再次书面复核 → 领域人书面签字 → 删「AI 草稿」→ 转「可归档」，主线才 5/5）、N4/N5 ✅、N1 挂起 / N3 待方案、15:30 第 6 项 ⏳ 待今日 15:30 后、同步 ⏸ 暂停（ahead 15 起、链末端待本轮 commit）。D1 待 commit 后复验 ✅；D2 ✅、D3 ⏸、D4 ✅ 00:1x 实测、D5 ✅、D6 ✅、D7 ✅、D8 N/A、D9 ✅、D10 ✅、D11 ✅、D12 🟡（仅剩 15:30 cron 实证）。**不宣布 backlog 完成、不宣布 15:30 七项闭环**；同步指令出现后先 `git fetch` 重列 ahead 清单（以 fetch 后为准）再执行整套仪式。

## 2026-11-13 10:4x · ⑤ 旁注归属裁决 + N6 + 断言数口径写死 + 送审清单

- **时间事实（用户已认领上一轮「窗口已到」判断错误）**：实跑 `date` = 2026-11-13 10:34:11（周五上午），**日期已到、15:30 时刻未到**；按用户分支「若未到 15:30，继续等」，本轮**不核验第 6 项、不写任何降级结论**，四步清单仍待 15:30 之后。
- **旁注位置确认（用户二节）**：实读 `docs/logic/factor-corr-20261112.md` 第 84–86 行确认——复核存疑旁注、H2 建议门槛、整改留痕三条**都在 §4【业务解读】块内、紧邻两处业务断言**，属「报告正文旁」，用户「领域人阅读会被 agent 批注影响判断独立性」的担忧成立。按用户给的第二个选项整改：**报告正文一字不改**，三条批注**移到报告末尾 `## 附：复核意见摘要（非报告原文）` 独立区块**（第 103 行起），区块内显式标注「非报告原文 / 来源 `factor-corr-20261112-review.md` / 待领域人裁决 / 待书面签字」及复核档案 md5。
- **为何不移入复核档案**：用户给的另一个选项是「旁注移入复核档案对应条目」，但 00:1x 节已定「整改不覆盖复核记录、`factor-corr-20261112-review.md` 一字未改」；改它会使「不放行」历史记录被覆盖、md5 失锚。故取第二个选项，复核档案 md5 仍 `9631f759114758ad214d34fc44b25a5f`（本轮实跑复验）。§4 业务解读块现仅含相关性事实 / 事实描述 / 可检验假设（含 H1 订正）/ 待验证（含 ① 已验证）/ 局限 / 补录，**业务断言原文逐字未动**。
- **工程配套（防重跑擦除）**：新区块若只在 md 里、脚本模板不认，重跑 `buildReport()` 整文件覆盖会静默丢失（ITEM 8 同源风险）。故 `scripts/analyze_factor_corr.js` 新增 `REVIEW_SECTION_HEAD` / `REVIEW_PLACEHOLDER` / 纯函数 `extractReviewNotesBlock()`，把 `preserveBusinessBlocks()` 扩展为**双区块回填**（业务解读块按簇序 + 末尾复核意见区块整段），`buildReport()` 末尾输出占位符；两类区块文字均**不固化进代码**，数字段仍全由脚本重算。
- **N6（新记 backlog，本轮不实现、不阻塞 ⑤）**：单窗口 `truncateToAsOf`（`:116` 定义、`:206` 调用）用 `Array.filter` 丢掉挂在数组上的 `.meta.source`；多窗口侧 `:563` 有 `trunc.meta = hist.meta; // Array.filter 会丢掉挂在数组对象上的 .meta（数据源标注），手动补挂` 补救、单窗口侧没有 → 这是「取数源未记录，待补」的根因。**N6 = 单窗口侧补挂 `.meta` 并在报告写出实际取数源，使未来报告可追溯**，为「待补」提供落地路径。本轮只记入 WAL / 长期笔记，**未改该处代码**；⑤ 的「待补」标注维持现状，是否可带此标注归档由领域人在签字条件里一并定。
- **断言数口径写死（用户三节）+ 当轮刷新**：固定口径 —— `158` = ①E2E 72 + ②健康 43 + ③多窗口 43 的**重点增量组合计**；`158 + ⑤ 防覆盖守卫当轮断言数` = 重点增量组累计；上述数字**均为重点增量组断言数、非全量断言总数**；**全量断言数当前无法准确采集**（仅 43/137 文件带标准汇总行，其余 94 个输出格式不一），曾试子集统计 1958 **不得冒充全量**。本轮守卫由 36 → **48 断言（48/48 实跑）**（业务块断言改纯原文 +1、独立区块与双区块防覆盖 +11），按同口径累计 **206**——用户给的「194」是 00:1x 轮值，本轮改了守卫，按 D4「有 commit 改测试不得继续挂旧轮次」刷新为当轮实测，不沿用 194。`run_all_tests.js --quick` **137/137 通过、跳过 13（需网络）**（文件数不变，未新增测试文件）。
- **离线重跑实证**：`tmp/verify_05_rerun.js` 由 11 → **16/16 全通过**：业务解读块 md5 全等（`bb5fef60…`）、块内无 agent 旁注、**复核意见独立区块 md5 全等（`0f3c5003…`）**、两类占位符均无残留、独立区块位于 §4 之后、§3 数字区与脚本重算逐字一致、正式报告 md5 零触碰。守卫 `test_factor_corr_preserve.js` 单跑 48/48；复核档案 md5 复验不变。
- **送领域人的三件事（用户五节，固化）**：① **第 1–4 项已修请核** —— H1 方向（`7cc27e8`）、① 状态同步（同上）、数据源标注「取数源未记录，待补」（同上）、模板防覆盖（`f852dba` + 本轮双区块 commit），附验证结果 137/137 + 守卫 48/48 + 离线重跑 16/16；② **第 5–6 项请裁决** —— 报告 §4 原文 + 末尾独立区块的存疑旁注与理由（R²≈0.70 / 剩 30% 方差 / 未做偏相关与增量 R² / 未做 PCA）+ agent 建议门槛「第一主成分方差解释率 ≥70%」，请给方向「改 / 不改 / 改阈值」，agent 按指示执行或领域人直接改；③ **签字条件** —— 业务断言裁决完成 + 报告无事实错误 + 取数源标注可接受（「未记录待补」是否可归档请一并定）。三项齐备后：再次书面复核 → 领域人书面签字 → 删「AI 草稿」→ 转「可归档」，⑤ 完成、主线才 5/5；agent 不代选、不代签、不擅自收敛。
- **范围与状态**：改 `docs/logic/factor-corr-20261112.md`、`scripts/analyze_factor_corr.js`、`scripts/test_factor_corr_preserve.js`，本 WAL + 工作日志 + 长期笔记（后两者被 `.gitignore:27` 忽略），`tmp/` 补丁与验证脚本被 `.gitignore:9` 忽略；复核档案零触碰。离线脚本不进运行时服务 → **不重启生产、不 bump `APP_VERSION`**。④①③② ✅、⑤ 🟡（1–4 整改可核 + 旁注已移出、5–6 待裁决）、N4/N5 ✅、N1 挂起、N3 待方案、**N6 新记**、15:30 第 6 项 ⏳、同步 ⏸（ahead 18 起、本轮 commit 后递增）。D1 待本轮 commit 后复验 ✅；D4 ✅ 10:4x 轮实测 137/137、断言数 206 为重点增量组；其余闸门不变；D12 🟡（仅剩 15:30 cron 实证）。**不宣布 backlog 完成、不宣布 15:30 七项闭环**；同步指令出现后先 `git fetch` 重列 ahead 清单（以 fetch 后为准）再执行整套仪式。

## 2026-11-13 11:1x · 复核区块逐字化 + 口径精确化 + N6 两分支 + N7

- **时间**：实跑 `date` = 2026-11-13 11:18:49（周五上午），**15:30 时刻仍未到**；本轮不核验第 6 项、不写任何降级结论。用户 194→206 订正已接受，责任归属按用户认领不变。
- **复核区块是否逐字摘录（用户二节 3）**：实跑对照核实 —— 报告末尾区块中 `VERDICT:` / `EVIDENCE:` / `NOTE:` / `结论：不放行` / `## 二、汇总结论` / `ITEM 3 ·` **全部缺失**，复核档案中**全部存在**，证明 10:4x 版区块是 agent 的概括转述、非逐字摘录，用户「会引入二次解读、削弱领域人判断独立性」的判断成立。已改为：报告末尾区块 **A 段 = 复核档案全文逐字摘录**（`fs.readFileSync` 机器复制、非手抄，`<!-- REVIEW_VERBATIM_BEGIN/END -->` 起止标记 + `~~~markdown` 围栏隔离，含「不放行」结论原文、8 项判定、能力边界 / 不代签声明）；**B 段 = agent 整改留痕与建议（非复核意见）** 单独标注，含复核存疑指向（只指 A 段 ITEM 3/4，不再概括）、H2 建议门槛、整改留痕、送审三件事、N6 两分支。守卫新增「A 段与复核档案全文逐字相等」机器可验断言，防止未来二次概括回潮。复核档案 md5 仍 `9631f759114758ad214d34fc44b25a5f`。
- **「正文一字不改」基准限定（用户二节 2）**：本轮补丁实跑输出「报告 §1–Backlog 正文 md5 未变 `175ce25c97d8fc7b78e39f56bd2e0584`」+ 前缀逐字校验 → 准确表述为 **「本轮旁注移出后，报告正文相对于上一轮整改版一字不改；相对于原始版，1–4 整改已改 H1 方向与 ① 状态两处事实错误」**。此前「正文一字不改」未限定基准，与「含 H1 订正、含 ① 已验证」并列会自相矛盾，按用户口径订正；已写入报告 B 段整改留痕。
- **206 口径写死（用户二节 1）+ 本轮再刷新**：写死 —— **`206` = `158`（① E2E 72 + ② 健康 43 + ③ 多窗口 43）+ `48`（preserve 守卫 10:4x 当轮）；preserve 守卫 36→48，净增 12，不是新增 48；206 为重点增量组累计，非全量断言总数**。全量断言数当前无法准确采集（仅 43/137 文件带标准汇总行，其余 94 个格式不一），子集统计 1958 不得冒充全量。**本轮又改了守卫**：48 → **55/55 实跑**（+7 = 5 条逐字摘录断言 + 2 条扫描范围隔离断言），按用户自己定的 D4「有新 commit 改测试即停用重跑标当轮」刷新重点增量组累计为 **158 + 55 = 213**；206 保留为 10:4x 轮历史值，不作本轮口径。`run_all_tests.js --quick` **137/137 通过、跳过 13**（文件数不变）。
- **扫描范围语义隔离（本轮发现并修复）**：A 段逐字摘录含复核档案引用的历史错误原文「回撤随上涨放大」「本轮未实现」，全报告扫描会把引用误判为正文现行状态 → 首跑 2 条断言失败（51/53）。已把**正文状态类**断言收窄到 `BODY`（§1–Backlog、独立区块之前），**送审材料 / 留痕存在类**仍扫全文，并新增 2 条断言钉死隔离。过程中 `BODY` 定义落在 require 解构前触发暂时性死区（TDZ）报错，已移到解构之后并 `node --check` 复验，未带入提交。守卫 55/55、离线重跑 **17/17**（复核意见区块 md5 全等 `0222fd7b…`、A 段逐字摘录重跑不丢、业务解读块 md5 全等、正式报告零触碰）。
- **N6 送审两分支（用户三节，已写入报告 B 段 + 本 WAL + 长期笔记）**：**路径 A（领域人接受「待补」可归档）** → ⑤ 可完成，N6 转**归档后补项**：补 `.meta.source` 并重生成报告，另开小任务，不占 ⑤ 主线；**路径 B（不接受，要求先补）** → N6 升级为 **⑤ 阻塞项**：agent 先改 `truncateToAsOf` 保留 `.meta.source`、重跑单窗口报告、刷新数字；重跑为整文件覆盖，【业务解读】块与复核意见区块靠双区块回填保留，数字可能因取数时点漂移，须在报告如实标注「补源后重算，数值与 11-12 版差异归因取数时点」。送审时一次裁决即可，避免二次往返。
- **N7（新记，本轮不实现）**：第二次书面复核后，末尾独立区块如何更新（**替换旧「不放行」区块 vs 追加新结论**）需在 `extractReviewNotesBlock()` 里定规则，避免旧「不放行」区块残留、与新的复核结论并存造成状态失真。用户明确「现在不用改，记入 N 项即可」→ 只记 backlog，未改脚本。
- **送审三件事（已随 B 段落盘）**：① 1–4 已修请核（`7cc27e8` / `f852dba` / `7a6516a` + 本轮逐字化 commit，附 quick 137/137、守卫 55/55、离线重跑 17/17）；② 5–6 请裁决（§4 原文 + A 段 ITEM 3/4 逐字依据 + B 段建议门槛，给方向改 / 不改 / 改阈值）；③ 签字条件（业务断言裁决 + 无事实错误 +「未记录待补」是否可归档，按 N6 两分支一次裁决）。之后再次书面复核 → 领域人书面签字 → 删「AI 草稿」→ 转「可归档」，⑤ 完成、主线才 5/5；agent 不代选、不代签、不擅自收敛。
- **范围与状态**：仅改 `docs/logic/factor-corr-20261112.md`（末尾区块，正文零改动）、`scripts/test_factor_corr_preserve.js`（守卫）、本 WAL + 工作日志 + 长期笔记（被忽略）、`tmp/` 补丁与验证脚本（被忽略）；**离线脚本 `analyze_factor_corr.js` 本轮未改**（`extractReviewNotesBlock` 按 N7 留待第二次复核时定规则）；复核档案零触碰。离线脚本不进运行时 → **不重启生产、不 bump `APP_VERSION`**。④①③② ✅、⑤ 🟡（1–4 可核 + 旁注移出 + 复核意见逐字摘录、5–6 待裁决）、N4/N5 ✅、N1 挂起、N3 待方案、**N6 新记（含两分支）、N7 新记**、15:30 第 6 项 ⏳、同步 ⏸（ahead 20 起、本轮 commit 后递增）。D1 待本轮 commit 后复验 ✅；D4 ✅ **11:1x 轮实测 137/137、213 为重点增量组（非全量）**；其余闸门不变；D12 🟡（仅剩 15:30 cron 实证）。**不宣布 backlog 完成、不宣布 15:30 七项闭环**；同步指令出现后先 `git fetch` 重列 ahead 清单（以 fetch 后为准）再执行整套仪式。

## 2026-11-13 11:3x · A 段隔离说明 + N7 规则定案 + 213 口径精确 + 送审阅读提示

- **时间**：实跑 `date` = 2026-11-13 11:31:48（周五上午），**15:30 时刻仍未到**；本轮不核验第 6 项、不写任何降级结论。用户接受逐字化整改与 213 刷新、认可两处过程问题披露。
- **① A 段历史错误引用隔离说明（用户二节 1）**：按用户给的固定句**逐字照录**（不概括、不改写）置于 `<!-- REVIEW_VERBATIM_BEGIN -->` **之后第一行**：「以下为复核档案全文逐字摘录，含被复核报告的历史错误原文引用与"不放行"结论，非报告正文现行状态；正文以 §1–Backlog 为准。」逐字区仍由 `~~~markdown` 围栏界定，说明句在围栏之外。为此把守卫的逐字提取定位由「按 BEGIN 拼接」改为**按 `~~~markdown` 围栏定位**（`vbRaw` 一行），**断言条数不变（55）**、A 段与档案全文逐字相等断言继续成立；离线重跑新增 2 条验证「说明位于逐字区之前 / 逐字区未被污染」。报告 §1–Backlog 正文零改动。
- **② N7 规则现在定案（用户二节 2，不再等第二次复核）**：写入 `scripts/analyze_factor_corr.js` 的 `extractReviewNotesBlock()` **JSDoc 规则注释（纯注释、不改函数逻辑）** —— **采用「替换」，不采用「追加」**：A 段每次只放最新一次复核档案全文，报告只承载最终结论链；历史复核按日期另存 `docs/logic/factor-corr-20261112-review-<date>.md` 归档为审计材料，报告只链最新一次。不采用追加的理由：A 段累积多次复核会让报告越滚越长，且「放行」与「不放行」并存、读者需自行判断哪条有效，属状态失真。执行时须同步更新区块来源标注、md5 与「A 段逐字相等」守卫的比对基准，勿留旧「不放行」区块。第二次书面复核按此执行；**N7 状态由「新记待定」升级为「规则已定、实现待第二次复核」**。
- **③ 213 精确口径写死（用户二节 3）**：**`213` = `158`（①②③重点增量组）+ `55`（preserve + 逐字化守卫当前总数，含 10:4x 轮 48，本轮 48→55 净增 7）；`206` 为 10:4x 轮历史值，保留备查**。上述数字均为重点增量组断言数、**非全量断言总数**（全量当前无法准确采集，43/137 文件带标准汇总行）；防「206→213」被误读成「本轮新增 213 条断言」。本轮守卫断言数**未增删**（仅改 1 行提取定位），故 213 保持不变。
- **④ 送审材料加 A 段阅读提示（用户二节 4）**：报告 B 段新增子项「**A 段阅读提示（送审必附）**」：「报告末尾 A 段为复核档案逐字摘录，含历史错误原文引用，非正文现行状态；请裁决 §4 正文两处业务断言与 H2 门槛，A 段仅作复核记录参考。」避免领域人把 A 段引用的历史错误原文当成需裁决对象；已同步写入本 WAL 与长期笔记。
- **验证**：守卫 **55/55**（断言数不变）、离线重跑 **19/19**（新增隔离说明位置 2 条，复核区块 md5 全等 `5aff60ef…`、逐字区未污染、正式报告零触碰）、`run_all_tests.js --quick` **137/137 通过、跳过 13** —— 本轮改了守卫文件（1 行定位逻辑），按 D4「有 commit 改测试不得挂旧轮次」重跑并标 **11:3x 轮实测**；断言数 213 不变。三个 `node --check` 语法复验通过；复核档案 md5 仍 `9631f759114758ad214d34fc44b25a5f`。
- **范围与状态**：改 `docs/logic/factor-corr-20261112.md`（仅末尾区块）、`scripts/test_factor_corr_preserve.js`（1 行定位 + 注释）、`scripts/analyze_factor_corr.js`（**仅 JSDoc 注释，函数逻辑零改动**）、本 WAL + 工作日志 + 长期笔记（被忽略）、`tmp/` 补丁与验证脚本（被忽略）；复核档案零触碰；离线脚本不进运行时 → **不重启生产、不 bump `APP_VERSION`**。④①③② ✅、⑤ 🟡（1–4 可核 + 旁注移出 + 逐字摘录 + 隔离说明、5–6 待裁决）、N4/N5 ✅、N1 挂起、N3 待方案、N6 两分支、**N7 规则已定**、15:30 第 6 项 ⏳、同步 ⏸（ahead 22 起、本轮 commit 后递增）。D1 待本轮 commit 后复验 ✅；D4 ✅ **11:3x 轮实测 137/137、213 为重点增量组（非全量）**；其余闸门不变；D12 🟡（仅剩 15:30 cron 实证）。**不宣布 backlog 完成、不宣布 15:30 七项闭环**；同步指令出现后先 `git fetch` 重列 ahead 清单（以 fetch 后为准）再执行整套仪式。
