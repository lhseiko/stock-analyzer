# 规则与守卫·铁律 · 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 🛡️ 规则与守卫·铁律（badge：公共支撑）
> 实现文件：lib/ruleCore.js（三规则共享内核）、lib/dataHonesty.js（诚实信封）、lib/valuationHub.js、lib/companyType.js、public/js/logicModel.js、prompts/*.md
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 各模块「数据已过期」「最后更新 X」标注 | `staleLabel` / `classify` 在 checkFreshness 过期为 true 时生成 | ruleCore.js:107；dataHonesty.js:29,52 |
| 估值卡「⚠️ 未能获取估值数据，本次不输出估值结论」 | 取数失败返回 ok:false，不编造 | valuationHub.js:67-74 |
| 守门员终止「需人工复核 / 无法评级」 | terminated 时 rating 改为需人工复核，历史结论不再外推 | changjiang000783.js:205-217；huaan600909.js:188-198 |
| 逻辑模型弹层「确定性数值一律由代码计算，大模型只负责叙事」 | 设计原则与项目铁律一致 | public/js/logicModel.js:28,251-255 |
| AI 估值注脚「全部由确定性代码计算（输入锁死⇒结果锁死）」 | 代码权威性约束前端可见证据 | public/js/app.js:4155,4238（等各 vd-foot） |

## 二、核心公式 / 判定链（三条底层规则落点）

**规则一·数据一致性（五要素 + 分析期锁定 + 财报期比对 + freshnessRows）**
- 五要素身份 `makeDatum`（ruleCore.js:33）：`{name,value,dataTime,source,fetchTime}`。
- 分析期锁定 `beginSnapshot`（ruleCore.js:44，`Object.freeze`，中途源更新不影响本次）。
- 单一权威源：估值 TTM 只从 eastmoneyValuation（valuationHub.js:5）；emDataCenter.js:7 防止异源退化。
- 财报期比对：detectLatestReportMonths 引擎判定 vs 配置 M（pingAn601318.js:39,76-81；dcavm688660.js:42,82；maijie300319.js:40）。
- freshnessRows 时效条带：各模型构造 `{label,asOf,ageDays,maxAge,stale}`。

**规则二·数据最新性（TTL + 交易日感知 + 过期标注 + 异常校验）**
- TTL（ruleCore.js:17）：quote 5m/daily 24h/weekly 7d/financial 90d/company 30d。
- checkFreshness（ruleCore.js:81）；交易日感知 `countTradingDaysBetween` 为 0 时保守判「仍为最新可得」不误标过期（:94）。
- staleLabel（ruleCore.js:107）过期显式标注；validateSane（:114，MAX_DEVIATION=0.5）异常值拒收。

**规则三·变化与边际分析（变化率+边际+方向+幅度+加速减速+同向共振）**
- changeRate（ruleCore.js:131，FLAT_PCT=1% 横盘阈值）；classifyDirection（:142）；classifyAccel（:163，MARGIN_EPS=0.5pp）；marginalStreak（:180）；analyzeSeries（:196）；analyzeWindow（:290）。

## 三、指标 / 因子口径（铁律内核速查）

| 规则/守卫 | 函数 | 出处 |
|---|---|---|
| 五要素身份 | makeDatum | ruleCore.js:33 |
| 分析期锁定 | beginSnapshot | ruleCore.js:44 |
| TTL | TTL | ruleCore.js:17 |
| 时效体检 | checkFreshness | ruleCore.js:81 |
| 交易日感知 | countTradingDaysBetween / tradingDayAware | ruleCore.js:51 / :94 |
| 过期标注 | staleLabel | ruleCore.js:107 |
| 异常值校验 | validateSane（MAX_DEVIATION=0.5） | ruleCore.js:114 / :27 |
| 变化率 | changeRate（FLAT_PCT=1%） | ruleCore.js:131 / :25 |
| 方向 | classifyDirection | ruleCore.js:142 |
| 加速减速 | classifyAccel（MARGIN_EPS=0.5pp） | ruleCore.js:163 / :26 |
| 同向共振 | marginalStreak | ruleCore.js:180 |
| 相邻期/窗口分析 | analyzeSeries / analyzeWindow | ruleCore.js:196 / :290 |
| 诚实信封 | ok/stale/fail/classify/hasSilentPadding | dataHonesty.js:23,29,38,52,71 |
| 硬闸门 | assertAnalysis / RuleNotSatisfied | ruleCore.js:393 / :387 |

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 内核 | ruleCore.js 为全站唯一出口，被 valuationHub / financeHub / db 挂载 | valuationHub.js:2；financeHub.js:2；db.js:3 |
| 诚实信封 | dataHonesty.js 反「凑数」检测（stats 全 0 却带 note 即违规） | dataHonesty.js:71 |
| 提示词层 | prompts/valuation-system.md「禁止用旧年份数据冒充最新」「给结论低估/合理/高估」 | prompts/valuation-system.md:17,40 |
| 前端 | logicModel.js 弹层明示铁律；app.js 各 vd-foot 注脚 | logicModel.js:28,251-255；app.js:4155 等 |

## 五、降级 / 容错 / 诚实性设计

- **硬闸门 assertAnalysis**：任何 Hub 把 analyzeSeries/analyzeWindow 包装成方向性结论前必须先调它，分析不可用即抛 `RuleNotSatisfied`（ruleCore.js:393）；估值侧捕获后只回退纯数值 `base`，不输出方向/幅度/边际结论（valuationHub.js:44-49）。
- **取数失败不编造**：valuationHub.js:67-74 返回 `ok:false, note:'⚠️ 未能获取估值数据，本次不输出估值结论（规则：无有效数据不得分析）'`。
- **守门员终止**：财报超龄/突变时 `terminated=true` → `rating:'需人工复核'`，`riskNote:'守门员终止期间不得引用旧目标价'`（changjiang000783.js:205-217）。
- **诚实信封**：stale 必须显式标注不伪装实时（dataHonesty.js:29）；fail 诚实声明失败绝不零值聚合（:38）；hasSilentPadding 反凑数（:71）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **断言是否真拦截**：`assertAnalysis`（ruleCore.js:393）抛 `RuleNotSatisfied` 后，调用方是否都 try/catch 并降级（如 valuationHub.js:44-49）？是否存在未捕获导致整段分析失败的调用点？
- [ ] **规则不满足的「禁止输出结论」是否贯彻全模块**：除估值/大盘技术/情绪外，资金量能（stock-13）、深度分析（stock-11）是否也接 assertAnalysis？还是有模块绕过铁律直接出结论？
- [ ] **MAX_DEVIATION=0.5 异常拒收**：阈值是否对所有资产类别合理（如高波动小盘股 50% 偏离被拒可能误杀真实跳变）？
- [ ] **类型 vs 个体原则落地**：`companyType.js`（:4,18,86）按类型给权重，但 stock-09 F1 记「companyType.weights 从未被使用」——类型框架与个体专属协议是否真并存还是类型权重已失效？需核实（stock-09 F1 同记）。
- [ ] **代码权威性约束是否在所有 AI 入口强制**：augmentStock.js:88「禁止自行估算、推算、四舍五入改写或编造任何一位」是否覆盖研报/公告/事件叙事等全部入口？
- [ ] **数据诚实信封 hasSilentPadding 是否被实际调用**：是否存在模块构造 stats 全 0 带 note 却未被检测的情况？

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| TTL 各档 | 5m/24h/7d/90d/30d | ruleCore.js:17 |
| FLAT_PCT（横盘阈值） | 1% | ruleCore.js:25 |
| MARGIN_EPS（边际阈值） | 0.5pp | ruleCore.js:26 |
| MAX_DEVIATION（异常拒收） | 0.5 | ruleCore.js:27 |
| SCHEMA_VERSION/LAYOUT_VERSION | 仅 sameDayJudgment | sameDayJudgment.js:1196-1197 |
| 评级三档 | 低估/合理/高估（禁用主观词） | prompts/valuation-system.md:40 |

## 归一化审计规则（2026-11-11 新增，源自 techFace 归因教训）

**规则**：任何 `normalize*` / `classify*` / `toTier*` / `map*` 函数，必须回答一句：
**「输入里有没有方向 / 强度 / 来源信息被丢弃？」** 如果有，要么保留（如 techFace 20261111a 修法：
震荡偏上→涨 / 偏下→跌），要么在函数注释里写明「刻意丢弃 X，因为 Y」并链接设计依据。
**禁止「无注释的静默丢弃」。** 本规则对后续所有新审计与改动生效，不追溯改历史代码。

**执行机制（20261111b 补）**：本规则通过 **code review 执行，不设自动化守卫**（「丢弃是否合理」
无法静态判断，源码扫描会误报）。具体检查项：
1. 新模块审计清单必含一项：「所有 normalize/classify/toTier/map 函数，逐个人工确认是否丢方向/强度/来源信息」；
2. 改动上述函数时，汇报/提交描述必须写一句「本次改动是否影响方向/强度保留」；
3. 标准动作（techFace 归因固化为惯例）：审计用「代码级 + 样本级」双证据——既读归一化实现与上游产词，也实测落盘记录的原始词分布。

### 2026-11-11 横向审计四条链记录（techFace 归因后的横向排查）

| 结算链 | 归一化实现 | 审计结论 |
|---|---|---|
| techFaceJudgment | normalizeDir（7 词→3 态） | **曾有缺陷**（震荡偏上/偏下归震荡丢 dirScore 方向符号），20261111a 已修（57.1% 回算） |
| marketTechJudgment | normalizeDir（:77） | 无缺陷：上游 shortDir 只产三态硬编码词（marketTechnical.js:526-530）；落盘实测 shortRaw/midRaw/fusionSignal 无「偏X震荡」类词进结算；「强空/偏空→跌、反弹→涨」方向保留。**trendLabel 角色（20261111b 已确认）**：判定层辅助——midDir 判定消费其「上涨/下跌」子串（marketTechnical.js:521-522）；「偏强/偏弱震荡」不含该两子串，在 midDir 消费点不参与方向（保守设计：ADX 临界带不确认趋势）；midRaw 落盘词与 normalizeDir 词表一一对应，无归一化层信息损失，与 techFace 丢弃不同构。样本 n=33 不足，纳入前向观察 |
| sentimentAccuracy | normalizeDir（:50） | 无缺陷：词表 看涨/看跌/震荡/中性 + includes 兜底，无「偏X」丢向；level 分档（强烈预警/预警/关注）是强度档位，方向由 impliedDir 独立携带，不参与方向归一 |
| sentimentTurningPoint | 无归一化函数 | 无缺陷：方向由 overbought 布尔 + 动量 sign 独立计算；analysis.js rsiSignal「偏强/偏弱」以 ±0.5 分值进 trendScore（方向进分数不进词），无静默丢弃 |
| sameDayJudgment（参照） | 方向加权映射（:1028） | 无缺陷：「震荡偏上:0.5 / 震荡偏下:-0.5」保留方向语义，未聚合为三档 |

**结论**：仅 techFace 存在归一化丢方向问题（已修），其余三条链 + sameDayJudgment 参照链均无类似缺陷。
