## [FEAT-20261103-001] market_log_database_search

**Logged**: 2026-11-03T18:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Requested Capability
用户：「把大盘记录做成一个简单的数据库，添加相应的检索功能，能够按日期、行业和涨跌等关键词进行搜索。」

### Suggested Implementation
（已实现 20261103i）lib/marketLogDb.js 把 notes.json scope=market 派生为结构化 SQLite（data/market-log.db，node:sqlite 零依赖），GET /api/market-log 支持日期范围/行业/涨跌方向/关键词/指数名组合检索；notes 页（market scope）注入检索面板。

### Resolution
- **Resolved**: 2026-11-03T18:35:00+08:00
- **Notes**: 守卫 test_market_log_db.js 40 断言全绿；真机 10 条记录入库并验证三类检索。

---

## [FEAT-20261109-001] etf_monthly_include_unsettled_span

**Logged**: 2026-11-09T12:51:54+08:00
**Resolved**: 2026-11-09（版本戳 20261109a，40/40 守卫全绿 + 真实数据实测）
**Priority**: high
**Status**: resolved
**Area**: backend / frontend

### Requested Capability
用户（截图 `屏幕截图 2026-11-09 124511.png`）：「11月5日和6日的数据为什么缺少，无法区分也可以一并合计入统计表格里面。」
即：ETF 独立页「当月逐日明细」表只到 11-04、合计 3 个交易日；要求把无法拆分的 11-05 / 11-06 数据作为**多日合计**一并纳入表格与当月合计。

### User Context
11-06 残缺快照事故修复后，11-05 收盘份额已不可得，11-05 与 11-06 两天的单日申赎**永远无法拆分**；用户接受「无法区分就合计」，不愿看到数据凭空消失。

### Complexity Estimate
medium

### Suggested Implementation
根因已定位：`lib/etfFlow.js::stockMonthlyFlow()` line 868 只吃 `s.settled && !s.partial` 快照，把 `20261109.json`（盘中未定稿、shareDate 20261106）过滤掉 → 11-04→11-06 的 Δ 有数据却不进表。该函数**已内置** `spanNote` 多日合计机制（line 889-890），前端 `etfFlowPage.js:191` 也已有 `etf-month-tag` 标签样式，属「现成能力被 settled 闸门挡住」。
方案：在已定稿链之外，允许最新一份「可计算、未定稿」快照作为**一条多日合计行**纳入 rows 与 totals，行上必须标注「多日合计（20261104→20261106）· 含未定稿读数」；**累计台账仍只吃定稿值，不得混入**。输出字段不变（rows/totals/spanNote 均为既有字段），下游零改动。

### Resolution（20261109a）
- **改动（2 个文件）**：`lib/etfFlow.js::stockMonthlyFlow()` 把 Δ 计算抽成共用的 `deltaRow(p,s)`，定稿链口径逐字不变；在定稿链之后允许**最新一份**「可计算但未定稿」快照（`!settled && !partial`、披露日严格晚于最后一行、ETF 只数 ≥ 基期 × 0.8）作为一条多日合计行加入 `rows`/`totals`，带 `spanNote = 多日合计（A→B）· 含未定稿读数` 与 `provisional:true`。`public/js/etfFlowPage.js` 同步：该行淡琥珀底 + 虚线标签、合计行文案改为「N 行 · 含 1 行未定稿多日合计」、口径说明③改为明确「无法拆分到单日 / 已一并计入当月合计 / **不进入累计台账**」。`style.css` 加 `.etf-month-provisional`。
- **硬边界**：`stockMonthlyFlow()` 只读快照，不写任何状态；台账入账仍由 `computeFromSnapshots()` 的 `if (settled && !already)` 守着（守卫 §4 验证 `ledger.json` 逐字节不变）。
- **输出格式变化已同步下游**：rows 元素新增 `provisional`、返回新增 `provisionalRows`，故前端按第二条逻辑协同修改；其余字段与 API 结构不变。
- **真实数据实测**：`601318 / 202611` 由 3 行变 4 行，新增 `20261106 buy=1,430,900 / net=+1,430,900` 且带多日合计标签；当月合计 `buy=42,255,700 / sell=1,018,400 / net=41,237,300` 已含该行。
- **守卫** `scripts/test_etf_monthly_provisional.js` **40/40 全绿**：旧行为不回退 / 多日合计行与 totals / 赎回方向 / 同披露日重复 / partial / 名单缩水 / 跨月 / 多份未定稿只取最新 / 台账只读 / 前端静态接线 / **vm 沙箱真实渲染 HTML**。
- **既有回归**：`test_etf_flow.js` 58/0、`test_etf_cash_trend.js` 20/0、`test_etf_card_layout.js` 24/0、`test_etf_universe_integrity.js` 25/0 全绿；`test_etf_flow_holiday_guard.js` 仍为既有 18/1（硬编码旧版本戳），无新增失败。

### Metadata
- Frequency: first_time
- Related Features: 宽基ETF申赎独立页 / 当月逐日明细 / LRN-20261109-001、LRN-20261109-002
- Related Files: lib/etfFlow.js, public/js/etfFlowPage.js, public/css/style.css, scripts/test_etf_monthly_provisional.js, server.js, data/etf-flow/

---

## [FEAT-20261109-002] emotion_margin_card_add_short_balance

**Logged**: 2026-11-09T12:51:54+08:00
**Resolved**: 2026-11-09（版本戳 20261109a，63/63 + 15/15 + 64/64 守卫全绿，金十真实数据实测）
**Priority**: high
**Status**: resolved
**Area**: backend / frontend / data-source

### Requested Capability
用户（截图 `屏幕截图 2026-11-09 124522.png`）：「图二卡片修改：添加融券余额数据，余额增加判断为短期利空，余额减少判断为短期利好，融券余额和融资余额共用平分卡片的权重。」
即：首页情绪模型「融资余额（杠杆资金）」因子卡加入融券余额指标，方向与融资相反，两者平分该卡权重。

### User Context
卡片内容集中在上半、下半约 40% 空白（`@skill:ui-new` UI Audit），加第二指标正好可填满并做成上下/左右对称双栏。

### Complexity Estimate
complex

### Suggested Implementation
**数据源已实证可用、无需新增外呼**：`scripts/market_emotion.py::fetch_margin()` 用的 akshare `macro_china_market_margin_sh/sz()` 来自金十 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json`，返回列本来就含「融券余额」（akshare 源码 `macro_china.py:900-907 / 931-939`），现有 `_to_map()` 只挑了「融资余额」列。Node 直连实证 2026-11-05：沪融资 11807.98 亿 + 深 10901.80 亿 = 22709.78 亿（与卡片 22710 亿吻合），沪融券 184.46 亿 + 深 103.65 亿 = 288.11 亿。
只需扩展 `fetch_margin()` 多解析一列并同样按「沪深双边完整日期」求和 → `out["margin"]` 增 `rqLatest/rqChange5Pct/rqDate/rqSeries`，`marketEmotionData.js` 自检同步。
**架构约束（必须让用户选型）**：`lib/marketEmotionModel.js:101` `dirOf(s)` 只认 ±1/0，`contribution = dirOf(score) × weight`（:953），总分亦按 `dirOf` 累加（:970）——把 `score` 改成 ±0.5 会被压回满格，**「平分权重」不能靠改 score 数值实现**。两条路线：① 一张卡两个子项、卡片总权重不变、净权重允许半格（需为 margin 特判 contribution/totalScore）；② 拆成两个常驻因子各占原 9% 的一半（4.5+4.5），权重总和恒 100、其它因子不动，但因子数 8→9，需同步前端标题、`FACTOR_NAMES`、自学习 `state.weights` 旧 key 兼容。

### Resolution（20261109a，用户选型：一张卡内双栏 + 沿用融资同口径）
- **数据源（零新增外呼）**：`scripts/market_emotion.py::fetch_margin()` 把 `_to_map(df)` 改成 `_to_map(df, val_name)` 并**精确匹配列名**——「融资融券余额」含子串「融券余额」，旧的 `in` 模糊匹配会误取合计列（实测误取值 11992.4 亿 vs 真实融券 288.11 亿）。新增 `_series()` 复用同一套「沪深双边完整日」口径，融资字段 `latest/prev/changePct/change5Pct/date/base5Date/partialNote/source` 名称与数值**逐字不变**，另出 `rqLatest/rqChange5Pct/rqDate/rqBase5Date/rqPartialNote/rqSource`；融券缺失只写 `rqMissingNote`，不拖累整卡。
- **模型**：`calcMargin()` 返回 `subs`（融资/融券两子项，各 50%，方向按用户口径：融券增加=-1 利空 / 减少=+1 利好）、`score = (dirRz + dirRq)/2`（0.5 步长）、`subScore:true`、`splitNote`。`FACTOR_NAMES.margin` 由「融资余额（杠杆资金）」缩为「两融余额」消除标题折行。`dirWeight(f)` 特判：该卡的净权重与总分用**原始 score**，其它 9 因子仍走 `dirOf`，因子数与权重总和 100 不变、margin key 不变（自学习旧权重兼容）。
- **输出白名单（关键接缝）**：`computeMarketEmotion` 返回 factors 时是字段白名单，必须同步透出 `subScore/subs/splitNote`——端到端渲染探针实测抓到「模型层全绿但前端双栏不渲染」，已补齐并在两个守卫里加断言。
- **前端**：`public/js/app.js` 在 `f.key==='margin' && subs.length===2` 时渲染 `.tp-comp-dual` 双栏；方向色按**语义**给（利好=红 `tp-sig-bull` / 利空=绿 `tp-sig-bear`），双栏数值与 detail 走 `esc()` 而非 `_dirColorize`——融券「+2.08%」是增加=利空，按数值符号染红会造成方向与颜色语义错位。`style.css` 新增整套双栏样式 + 520px 窄屏单列回退。
- **颜色语义实证**：金十 2026-11-05 融资 22709.8 亿 / 5日 −3.33%（撤离=利空），融券 288.11 亿 / 5日 +2.08%（增加=利空）→ 双栏同为绿色、卡片 score=-1 满格利空；渲染守卫断言 `<span class="up">+2.08%` 不出现。
- **阈值安全性**：实测近 35 个双边完整日融券 5 日变动 −4.32%~+2.63%、中位 |1.52%|、超 ±10% **0 天** → 沿用融资的 ±10% 异常闸门不会误伤。
- **守卫**：`scripts/test_emotion_margin_dual.js` **63/63**（9 种方向组合 / subs 契约 / 缺失 / 异常 / 月末阈值 / 端到端半格总分 / 其它 9 因子零改动 / Python 列匹配 / 前端接线）；`scripts/test_emotion_margin_render.js` **15/15**（真实模型输出 → vm 加载 app.js → 最终 HTML）；既有 `test_market_emotion.js` **64/64**（[14] 断言同步为 `dirVal`，夹具补 rq* 保持等价）。
- **Python 真实数据实测**：用纯标准库 `ast` 提取 `_to_map/_series` + `urllib` 直连金十 + stub DataFrame（绕过沙箱 pandas DLL 拦截），得融资 22709.8 亿 / −3.33% / 2026-11-05、融券 288.11 亿 / +2.08% / 2026-11-05，与卡片既有 22710 亿吻合。

### Metadata
- Frequency: first_time
- Related Features: 首页情绪模型 8 常驻因子 / 个股资金量能模块（已有「融券增加=做空=负面」同口径，capitalFlow.js:1160-1170）
- Related Files: scripts/market_emotion.py, lib/marketEmotionData.js, lib/marketEmotionModel.js, public/js/app.js, public/css/style.css, scripts/test_emotion_margin_dual.js, scripts/test_emotion_margin_render.js, scripts/test_market_emotion.js

---

## [FEAT-20261109-003] workbench_unify_color_semantics

**Logged**: 2026-11-09（用户指令后立即落 WAL）
**Resolved**: 2026-11-09（版本戳 20261109b，新增守卫 147/147，全量 132 套单测无新增失败）
**Priority**: high
**Status**: resolved
**Area**: frontend / css / charts / data-display

### Requested Capability
用户：`@skill:ui-new @skill:proactive-agent 统一工作台的颜色使用规则，只有利好或正面消息才能使用红色，利空或者负面消息才能使用绿色，全工作台检查一遍颜色的使用情况然后修改。`

### User Context
- WAL 已落 `D:\ai agent\2026-11-07-11-10-36\.workbuddy\memory\MEMORY.md`：红=利好/正面、绿=利空/负面、中性灰、警告/风险/数据缺口=琥珀橙；**数值符号 ≠ 方向**；适用范围含 CSS / JS 动态 class / 文案着色 / ECharts / 内联样式 / 后端 tone。
- `AskUserQuestion` 三项均选推荐：**全量统一** / **状态中性，好坏分红绿** / **符号着色本轮一起修**。
- 子代理 very thorough 只读审计覆盖 `public/css/style.css`、全部 `public/js/*.js`、8 个 HTML、`lib/*.js`、`server.js`、ECharts 色板。

### Complexity Estimate
complex（跨 CSS 100+ 规则 + 7 个前端 JS + 图表序列 + 版本戳 + 守卫）

### Resolution（20261109b）
- **CSS 三轮迁移**：① 按规则块精确迁移 109 个选择器 / 111 个规则块（AMBER 风险警告、NEUTRAL 流程状态、SWAP 好坏反转、SPECIAL 等级/旗标）；② 修复 `toSwap()` 的 rgba 二次替换缺陷（`.good`/`.bad` 曾双红）并补齐 11 个未命中；③ 收尾 47 条精确替换（删除/错误/缺口/排名热度/宏观趋势/流程状态/语义反转）。最终使用红绿的规则由 274 → **231**，方向色工具类 `.up/.down`、K 线红涨绿跌、资金流柱、融券增加=绿等**合规项零改动**。
- **语义反转修正**：`good/ok/hit/PASS/低估/鸽派/站上5日/最佳行` → 红；`bad/miss/REJECT/高估/鹰派/未站上5日` → 绿；`sl-verdict-ok/bad`（对/错）、`mt-short-foot .up/.down`（站上/未站上 5 日）原本整组反了，已互换。
- **风险/状态退出方向色**：toast 成功/失败、错误条、数据缺口、校验无效、URL 警告、成本/竞争风险等级、复盘段落状态、交易日徽标、文档徽标、上传文件名、研究评级、删除按钮、RSI 70/30 阈值、放量/缩量参考线 → 中性灰或琥珀橙。
- **文字着色器根修（本轮核心）**：`public/js/app.js::_dirColorize()` 与 `public/js/dailyReview.js::colorize()` 旧版对任意 `+X%/-X%` 机械染红绿，会把「融券余额 +2.08%」「风险敞口 +3%」「亏损扩大 +30%」误判成利好红。改为三级显式契约：自由文本只按**显式语义词**着色（含「涨跌幅」中性组合词守卫）；`{numeric:true}` 仅限已确认语义=涨跌幅的字段（`changePct`）；`{tone:'bull'|'bear'|'flat'}` 由调用方给定确定性语义方向。操作建议 / 风险提示改纯 `esc()`，不再被 `.up/.down` 的 `!important` 覆盖琥珀警示色。
- **中性内容退出方向色**：宏观趋势徽标（CPI/失业率回升≠利好）→ 中性灰；量能档位（放量≠利好）→ 暖/冷中性色 `tp-vol-active/tp-vol-quiet`；产业链上/下游、主导力量长期/短期 → 中性；股价叠加线、ETF 持仓/现金比例、两融存量柱序列 → 中性蓝/琥珀；估值警告内联红字与「重大机会」绿字 → 琥珀。
- **守卫** `scripts/test_color_semantics.js` **147/147**：L1 CSS 红绿规则集合 sha256 基线（新增用法强制人工复核）；L2 62 个禁用类 + 37 个语义映射 + 8 个琥珀必用；L3 15 条 JS 静态接线；L4 vm 沙箱真实调用 `_dirColorize` / `semanticText` 验证最终 HTML（含「+2.08% 不染红」「tone=bear 忽略符号」「changePct 仍 +红/-绿」）。
- **版本戳** `20261109a → 20261109b`：`index.html` 6 处、`etf-flow.html` 2 处、`daily-review.html` 2 处 `?v=` 同步；`etfFlowPage.js` 不在 `FRONTEND_BUST_FILES` 白名单，必须手动改。
- **回归**：全量 132 套单测 105 PASS / 27 FAIL，**27 个失败逐项核对全部为既有硬编码旧版本戳（`APP_VERSION='20261106p'` / `LAYOUT_VERSION='20261106o'`）、`logic-model.html` 入口、manual_zones 数据基线、safe-delete 阈值、空 catch 基线 +7，无一项由本轮颜色改动引入**；直接相关 10 套守卫全绿（147/63/15/64/40/25/35/42/3/27）。
- **未擅自修**：上述既有硬编码断言，按用户铁律「修既有代码前先确认」保持原状。

### Metadata
- Frequency: first_time
- Related Features: 全工作台 softDark 主题 / 两融双栏语义着色 / 复盘全文着色 / 图表色板
- Related Files: public/css/style.css, public/js/app.js, public/js/dailyReview.js, public/js/homeMacro.js, public/js/charts.js, public/js/capitalCharts.js, public/js/shareholderCharts.js, public/js/etfFlowPage.js, public/index.html, public/etf-flow.html, public/daily-review.html, server.js, scripts/test_color_semantics.js

---

## [FEAT-20261109-004] volume_rule3_align_single_source_and_fix_baseline_comparability

**Logged**: 2026-11-09T16:34:00+08:00
**Priority**: critical
**Status**: resolved（2026-11-09 全部四项裁决已落地：全引擎统一 1.3 / 同价位带最近前高 / 全个股统一 / AMP_CONFIRM 统一 1.3）
**Area**: backend / frontend / tests

### Resolution（20261109c）
用户裁决链：① 反问「工作台已经统一使用 20 日量能比来作为量能标准，为什么现在会出现其他的标准选择？」→ 明确「不应把保留第二套标准列为可选项」，属行为纠正；② 前高基准 = **同价位带最近前高**；③ 修复范围 = **全个股统一**；④ 残留 `AMP_CONFIRM = 1.5`（7 处）→ **全引擎统一到 1.3**。
落地：
- 新建 `lib/volumeCaliber.js` 作为全工作台「÷20 日均量」量能判定唯一真值源（VOL_AMP=1.3 / VOL_SHRINK=0.8 + isAmpRatio/isShrinkRatio/tierOfRatio/ratioOfVol + 基准可比性常量）。
- `lib/volumeEngine.js`：7 处 AMP_CONFIRM 与全部 SHRINK_CONFIRM 比较点接入真值源；规则3 唯一判据改为 `isAmpRatio(ratio20)`，`vol > refVol` 门槛与全窗口 argmax 删除；新增 `_pickRefHigh()`（同价位带 ±10% + 时间最近局部前高 + 上市前 5 根保护 + 除权断点 + 4×中位数异常量剔除）；前高量能降级为展示参照、无合格样本诚实披露；规则名「缩量假突破」→「假突破量能不确认」，风险标签/结论/相关字段同步；schema → `volume-engine-20261109c`。
- `lib/capitalFlow.js`：÷20 回退五档、量能热度、latestVsPriorAvg、breakout 全部接入真值源；判定改用未取整原始量比（修复 1.301 被 2 位小数取整判平量的边界互斥）。
- `lib/zoneValidity.js` / `public/js/capitalCharts.js`：÷前5日均量的原始指标保留 1.2 独立口径（页面显式标注分母、不承担判定结论），更正误导性「与 _volumeTier 同源」注释。
- `public/js/app.js` 口径说明补全覆盖范围（异常特例层 / 11.3.1 / 口诀4 / 缩量止跌 / 资金卡回退），不再只声明三处。
- 版本戳：APP_VERSION / LAYOUT_VERSION / 引擎 schema / 三个 HTML ?v= 全升 20261109c。
- 新增守卫 `scripts/test_volume_single_source.js` **63/0**：静态契约、基准可比性纯函数、威高血净 `ratio20=1.47` 端到端复刻（主轴放量 + 135 格放量 + 规则3 不命中 + 无「缩量」措辞）、前高量能不参与判定、4 只个股一致性、12 个阈值点全扫描。
- 同步更新 14 个既有守卫的 schema / ×1.5 / ×0.7 / 规则名 / 降级契约基线。量能专项 23 个守卫中 16 个全绿，其余 7 个仅因写死旧版本号（20261106p / 20261106o）失败，属历史遗留，与本轮逻辑无关。

### Requested Capability
用户（威高血净 603014 截图）：「还是出现了矛盾的结论，(第三步 · 量能 × 涨跌幅 放量 + 下跌 当日 -2.29% · 当日量/20日均量 1.47) VS (判定为无量假突破形态……量能未有效放大……命中「缩量假突破」……不得给出看多信号)。还有一个问题，2026年11月的量能用2025年5月的量能作为判断量能是否放量的标准是否合适？当时对应的股价是48左右，现在股价只是35左右，在2026年6月17日左右明明就有一个对应的前高股价38左右和量能，为什么不使用作为标准对比？」

隐含三项诉求：①同屏不得出现互斥量能结论；②「前高对应量能」基准必须与当前价位、当前分析期可比；③规则名/徽标不得把 1.47 倍放量叫成「缩量」。

### User Context
- 这是**同屏互斥第 3 次复发**（2026-10-17 三处量能结论 70% 互斥 → 2026-11-06 统一口径漏改 combo → 2026-11-09 异常特例层漏网），用户已多次明确「整个模块不应该出现不一样的量价关系判定结论」。
- 用户三条底层规则：数据一致性（单一权威源 + 五要素 + **分析期锁定**）、数据最新性、变化与边际分析；**任何规则不满足时不得输出分析结论，必须先停下来把问题解决**。当前规则3 的输出违反第一条，应视为无效结论。
- 用户铁律：修既有代码前必须先核实、修改前必须列共用清单确认、「类型 vs 个体」默认全个股统一。

### Complexity Estimate
complex（跨引擎/135格/前端口径说明/多个守卫，且涉及判定语义变更需升 LAYOUT_VERSION / SCHEMA_VERSION）

### Suggested Implementation
见 `LRN-20261109-006` 的 Details 与 Suggested Action。核心两处：
1. `lib/volumeEngine.js:761` `ampOk` 与 `:81 AMP_CONFIRM=1.5` → 接入 `pc.ratio20` / `_volumeTier` 单一真值源（阈值 >1.3），或至少让 1.3~1.5 区间不再被文案称「缩量」。
2. `lib/volumeEngine.js:764-770` `refVol` 全窗口 argmax → 改为「与当前阻力区间同价位带 + 时间最近的有效局部前高」的量能，剔除上市首日 / 极端异常值 / 跨除权断点；或整体删除 `vol > refVol` 条件。
3. 共用清单（9 类，需用户确认）：`lib/volumeEngine.js`、`lib/posModel135.js`、`lib/capitalFlow.js`、`public/js/app.js`（口径说明）、`public/js/capitalCharts.js`、`public/volume-map.html`、`lib/sameDayJudgment.js`、`lib/priceAction.js`、`scripts/test_volume_*.js`。
4. 新守卫：阈值夹缝断言（任意 ratio20∈(1.3,1.5) 不得同屏出现「放量」与「缩量」）、基准可比性断言（基准日与判定日同价位带 / 同分析期 / 非上市首日）、异常特例层纳入统一口径全量比较点扫描。

### Metadata
- Frequency: recurring（第 3 次）
- Related Features: 135 格综合判定 / 异常特例层规则3 缩量假突破 / 量能口径统一 ÷20 / 量价判定唯一结论
- See Also: LRN-20261109-006, LRN-20261106-004, LRN-20261106-001, LRN-20261020-002, docs/logic/stock-13-capital.md #12

## FEAT-20261109-005 · 每日量比趋势图改为每日20日量能比趋势

- **状态**：resolved
- **用户指令**（2026-11-09 截图，`@skill:ui-new` + `@skill:proactive-agent`）：「每日量比趋势（近60日）图表的数据由每日的量比改为每日的20日量能比，图表名字也一起改。」
- **根因/设计**：图表 `series.volumes` 仅取最后 60 根日K，若前端直接算 ÷20 前 20 天必然 null（图左 1/3 空白）。采用「后端用完整历史（~320 根）预计算 `ratio20Series` 再 `slice(-60)`」方案，与判定层 `ratio20` 同源且无空窗。
- **改动文件**：`lib/capitalFlow.js`（新增 `series.ratio20Series` 纯字段）、`public/js/capitalCharts.js`（`renderVolRatio` 消费后端序列 + 全口径 ÷20/1.3/0.8）、`public/index.html`（标题改为「每日20日量能比趋势（近60日）」）、`lib/volumeCaliber.js`（注释同步）、`scripts/test_cap_vol_ratio_chart.js`（守卫全量同步）、版本戳 `20261109c → 20261109d`。
- **验证**：`test_cap_vol_ratio_chart.js` 26/0；运行时实跑 `computeVolumeIndicators` 确认 `ratio20Series` 60 个无空窗、与 dates 等长；量能核心守卫 64/0、306/0、228/0、缓存破坏 3/0 全绿。
- **隔离**：引擎 schema 与 `LAYOUT_VERSION` 未变（本轮未改判断结构），保持 20261109c。
- **记录**：见 `SESSION-STATE.md`、工作日志 `2026-11-09.md` 同日章节。
