# 专属估值模型库 · 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 🎯 专属估值模型库（10 只+基座）（badge：公共支撑）
> 实现文件：lib/ai/valuation.js（真实唯一出口）、lib/valuation/*.js（各股专属模型）、lib/valuationHub.js（TTM 指标网关·样板）、lib/ruleCore.js、lib/deep/conclusion.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 个股页「AI 估值摘要框」（利好红/利空绿/重点黄） | 专属模型确定性计算 + AI 纯叙事着色；注脚「全部由确定性代码计算（输入锁死⇒结果锁死）」 | public/js/app.js:4155,4238,4348,4434,4512,4600,4709,4817,4917,5028 |
| 估值结论「低估/合理/高估」三档 | 现价 vs 合成区间确定性计算，无主观词 | 各 lib/valuation/*.js rating 段 |
| 估值卡「数据时效条带 freshnessRows」 | 各模型构造 `{label,asOf,ageDays,maxAge,stale}`，是数据最新性守门可见载体 | 各模型 freshnessRows 段 |
| 估值卡「财报可能过期」告警 | detectLatestReportMonths 引擎判定 MDetected 与配置 M 比对不符 | pingAn601318.js:39,76-81；dcavm688660.js:42,82；maijie300319.js:40 |
| 守门员终止「需人工复核/无法评级」 | 财报超龄/市场环境突变/核心资产质变任一触发 terminated | changjiang000783.js:205-217；huaan600909.js:188-198 |

## 二、核心公式 / 判定链（重要：真实唯一出口纠正）

> ⚠️ **纠正既有认知**：`lib/valuationHub.js` **不是**各股专属模型的路由器，它是「TTM 估值指标（PE/PB/PS）的统一数据网关 / 三条铁律样板实现」。各股专属模型的**真实唯一出口**是：

- `lib/ai/valuation.js:19` `async function analyzeValuation({symbol,...})`：按 `601318→broker→688289→603288→600460→600909→000783→300319→688660→000902→002643` 顺序逐个闸门试跑，**首个命中即返回 `dedicated:true, ver:'DEDICATED'`**（不依赖 apiKey，数据锁死⇒结果唯一）。
- `lib/ai/valuation.js:402` `hasDedicatedValuation` 判断是否走专属路径。
- `lib/deep/conclusion.js:150-184`：深度分析综合估值结论卡也独立调用同一批 `lib/valuation/*.js`。

**判定链**：symbol → analyzeValuation 逐股 `isXxxModel()` 闸门 → 命中模型 `compute()/run()` → 返回 `{rating, fairValueRange, freshnessRows, guardRows, alerts, decisionNote, version}`。

## 三、指标 / 因子口径（已落地模型清单，共 10 专属 + 1 券商通用）

| 标的 | 模型文件｜核心方法 | 守卫函数 | 三档评级 | version | 方法构成 |
|---|---|---|---|---|---|
| 中国平安 601318 | pingAn601318.js:51 compute() | valuation.js:24 直判 bare==='601318' | :147-152 P<low→低估/>high→高估 | :209 '滚动估值协议_v2.0' | P/EV 核心锚 + DDM 双参 + SOTP 四分部 |
| 券商通用 | brokerModel.js run() | isBrokerModel(:23) | :83-100 现价 vs 区间/压力 | 无显式 | 分类+估值 |
| 圣湘 688289 | sanxi688289.js run() | isSanxiModel(:23) | :383-386 | :487 cfg.modelVersion | 六模型交叉 |
| 海天 603288 | haitian603288.js:67 run()→compute():82 | isHaitianModel(:27) | :247-253 | :319 'V2.0_修复版' | DCF50%+动态PE50%+三情景 |
| 士兰微 600460 | silan600460.js run() | isSilanModel(:20) | :125-129 | 无显式 | PE加权+PB+PS+DCF+敏感度 |
| 华安 600909 | huaan600909.js run() | isHuaanModel(:31) | :263-268 | :328 'V3.0' | 守门员+PB60%+SOTP30%+PE10% |
| 长江 000783 | changjiang000783.js run() | isChangjiangModel(:47) | :386-403 折溢价±10% | :526 'V2-patched-FG' | PB-ROE主+SOTP四分部 |
| 麦捷 300319 | maijie300319.js run() | isMaijieModel(:24) | :206-213 上行>20%→低估 | 无显式 | 四路+三情景 |
| 电气风电 688660 | dcavm688660.js:59 run() | isDcavmModel(:25) | :329-335 | 无显式 | 周期：景气+DCF+相对+SOTP+订单 |
| 新洋丰 000902 | xinyangfeng000902.js run() | isXinyangfengModel(:23) | :142-146 | :318 cfg.version | A正常化PE/B PB-ROE/C DCF/D磷矿期权/E磷酸铁 |
| 万润 002643 | wanrun002643.js run() | isWanrunModel(:22) | :117-122 | :288 cfg.version | 三层加权 PB-ROE50%/PE35%/DCF15% |

> 配置点：`data/valuation/{symbol}.json`（kind 闸门、modelVersion、inputs 锁死输入、freshness、reportPeriod）。磁盘已确认 11 个 json。

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 单一权威源 | 估值 TTM 指标只从 eastmoneyValuation 取（valuationHub.js:5 注释）；emDataCenter.js:7 保证口径属东财不退化到同花顺异源 | valuationHub.js:5；emDataCenter.js:7 |
| 财报期比对 | detectLatestReportMonths 引擎判定最新报告月，与配置比对 | pingAn601318.js:39；dcavm688660.js:42；maijie300319.js:40；haitian603288.js:36 |
| 时效条带 | freshnessRows 各模型构造 | 各模型 freshnessRows 段 |
| 异常值拒收 | validateSane 新旧偏离 >MAX_DEVIATION(0.5) 拒收 | ruleCore.js:114；valuationHub.js:88-96 |
| 前端取数 | 个股页 fetch /api/ai/valuation/:symbol 或 /api/valuation/model/:symbol | routes/aiRoutes.js:195,147 |

## 五、降级 / 容错 / 诚实性设计

- **规则不满足即不输出结论**（硬终止）：长江 `terminated=true→rating:'需人工复核'`、`decisionNote:'⛔ 守门员自检未通过…历史结论不再外推'`；华安同理（changjiang000783.js:205-217；huaan600909.js:188-198）。
- **取数失败不编造**：valuationHub.js:67-74 抓取失败返回 `ok:false, note:'⚠️ 未能获取估值数据，本次不输出估值结论'`（规则：无有效数据不得分析）。
- **诚实断言闸门**：`assertAnalysis`（ruleCore.js:393）抛 `RuleNotSatisfied` 时，valuationHub.js:44-49 捕获后只回退纯数值 `base`，不输出方向/幅度/边际结论。
- **确定性自证**：路由层打 `dedicated:true, ver:'DEDICATED'`（valuation.js 多处），前端注脚统一口径。

## 六、逻辑漏洞自查清单（审计用）

- [x] ~~**估值出口两层结构（已澄清，非记忆错误）**：`valuationHub.js:2-6` 明确定位为「TTM 估值指标统一数据网关 + 三条铁律样板实现，本模块是该指标唯一出口」——用户记忆「valuationHub.js 跑通三规则」指的就是这一层，准确；各股专属模型路由为 `lib/ai/valuation.js:19 analyzeValuation`（common/agent 实证）。两层并存，文档已正确区分，无需纠错~~ → 属 scope 澄清
- [ ] **⚠️ 评级档位冲突（DA6）**：深度分析通用卡 `lib/deep/conclusion.js:134-144` 用**四档** `{低估:-1,合理:0,偏高:1,高估:2}`，而专属模型输出**三档**（无「偏高」）。专属结果回写 `overallRating` 时「偏高」档在专属路径下永远不会被触发——与全局「严格三档（低估/合理/高估），禁用主观词」规范冲突（stock-11 DA6 同记）。
- [ ] **⚠️ 估值无 SCHEMA_VERSION 守卫（可补强点）**：SCHEMA_VERSION/LAYOUT_VERSION 仅存于 `lib/sameDayJudgment.js:1196-1197`，估值模块用各自 `version` 串 + `ver:'DEDICATED'` 标记，**无自动哈希失效旧缓存的守卫**。改模型逻辑后若忘改 version 串/重算，旧结论可能被复用（对比 sameDayJudgment 的因子结构哈希自动守卫）。
- [ ] 部分模型缺显式 version 字段（士兰/麦捷/电气风电/长江标注在注释或 cfg，但圣湘/新洋丰/万润走 cfg.version）——version 来源不统一，升版易漏。
- [ ] 券商通用模型 `brokerModel.js` 无显式 version，是否与其他专属模型同口径审计？
- [ ] 各模型 freshnessRows 的 maxAge 阈值是否一致（不同资产类别财报频率不同）？

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 各股模型 version 串 | 见第三节表（硬编码或 cfg.version） | 各 lib/valuation/*.js |
| 模型输入锁死 inputs | data/valuation/{symbol}.json | 各模型读 cfg.inputs |
| 财报期 M（报告月） | data/valuation/{symbol}.json reportPeriod | pingAn601318.js:76-81 比对 |
| MAX_DEVIATION（异常拒收） | 0.5 | ruleCore.js:27 |
| SCHEMA_VERSION/LAYOUT_VERSION | 仅 sameDayJudgment 用，估值未用 | sameDayJudgment.js:1196-1197 |
