# 🎯 策略（虚拟盘风控闸门）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「🎯 策略（虚拟盘风控闸门）」Tab（tabName=`backtest` → `BacktestUI.open`）
> 实现文件：`public/js/app.js:589, 2908-2913`（`BacktestUI.open` 触发）、`public/js/backtestUI.js`、`lib/strategyGenerator.js`（`generateStrategies`）、`lib/backtestValidator.js`
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| Tab 触发 | 切到 `backtest` tab 且 `currentSymbol` 存在 → `BacktestUI.open(symbol, name)` | app.js:2908-2913 |
| 每套策略卡 | 原始胜率 / 修正胜率 / 交易笔数 / walk-forward / `verdict`（PASS/WARNING/REJECT/INSUFFICIENT_SAMPLE） | backtestUI.js:382-390 |
| 最优策略徽章 | `best.verdict` | backtestUI.js:355 |
| 建议徽章 | `adv.verdict` | backtestUI.js:421 |
| 结论口径 | 前端 `verdictBadge(v)` 按字符串显示（无 default 兜底） | backtestUI.js:29-31 |
| 加载触发 | `POST /api/backtest-validate`（backtestUI.js:102, server.js:637）、`POST /api/auto-strategy`（backtestUI.js:274, server.js:656-660） | — |

## 二、核心公式 / 判定链

- **独立引擎**：`strategyGenerator.generateStrategies`（strategyGenerator.js:265 汇总，server.js:660 调用）→ `backtestValidator` 出 `verdict`。**不是** sameDay/longTerm 的汇总。
- **候选策略库**（strategyGenerator.js:71-99）：双均线 / MACD / RSI / 布林 / 收益率 z-score 等。
- **回测校验**：`backtestValidator` 对每套候选在个股历史 K 线（60m/日 K，回退日线）上做 walk-forward 验证，产出 `verdict ∈ {PASS, WARNING, REJECT, INSUFFICIENT_SAMPLE}`（strategyGenerator.js:244,527）。
- **半联动 longTerm**：`strategyGenerator.js:199-214` 读取 `pa.longTerm.verdict`（来自 `longTermJudgment`/价格行为）做多/空偏置——属半联动，非完全独立。
- **sameDay/longTerm 另在概览卡展示**：`_loadSameDayJudgment`（app.js:779-814）、`_loadLongTermJudgment`（app.js:1470），与策略 tab 是**不同控件**。

## 三、指标 / 因子口径

| 项 | 口径 | 是否确定性 | 出处 |
|---|---|---|---|
| 策略 verdict | PASS / WARNING / REJECT / INSUFFICIENT_SAMPLE | 是（回测引擎） | strategyGenerator.js:244,527 |
| 原始胜率 / 修正胜率 | walk-forward 统计 | 是 | backtestUI.js:382-390 |
| 交易笔数 / walk-forward | 回测样本 | 是 | 同上 |
| longTerm 偏置输入 | `pa.longTerm.verdict`（看多/看空/中性） | 是（但属外部模块输入） | strategyGenerator.js:199-214 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 当前个股 60m/日 K 线（回退日线）；`pa.longTerm.verdict`（由 longTermJudgment 计算） |
| 采集/落盘 | 实时回测计算，无独立落盘（⚠️ 待核实是否有结果缓存） |
| 调度 | 切到 backtest tab 触发 `BacktestUI.open`；可手动点「自动策略」触发 `POST /api/auto-strategy` |
| 前端取数 | `POST /api/backtest-validate`、`POST /api/auto-strategy` |

## 五、降级 / 容错 / 诚实性设计

- **样本不足**：`verdict=INSUFFICIENT_SAMPLE`（strategyGenerator.js:527），前端显示对应徽章（backtestUI.js:29-31）。
- **诚实性声明**：tab 文案「全部由代码确定性计算，不构成投资建议」（index.html:982）—— 但**未说明** `pa.longTerm.verdict` 这一外部输入（见第六节 #8）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1【透明度】策略「独立」归因不透明**：`strategyGenerator.js:199-214` 读 `pa.longTerm.verdict` 做多空偏置，但 tab 文案「全部由代码确定性计算」（index.html:982）未说明该输入来自 `longTermJudgment`，用户易误判为完全独立。
- [ ] **#2 verdict 前端无兜底映射**：`backtestUI.js:29-31` `verdictBadge(v)` 直接按字符串显示，后端若新增 `verdict` 值前端无 default，可能显示空白/原始字符串。
- [ ] **#3 两条 API 结论口径可能不同**：`auto-strategy`（server.js:656）与 `backtest-validate`（server.js:637）由不同入口生成，最优策略/建议可能不一致，用户易混淆"手动校验"vs"自动策略"结果。
- [ ] **#4 longTerm 偏置可能污染"纯技术回测"语义**：若 longTerm 判"看多"，策略引擎整体偏多，可能让本应 REJECT 的空头策略被抬升——偏置权重未在前端披露。
- [ ] **#5 回测过拟合风险未提示**：walk-forward 验证强度、样本外比例未在前端披露，用户可能高估"修正胜率"可靠性。
- [ ] **#6 候选库固定、未随个股类型调整**：策略候选（双均线/MACD/RSI/布林/z-score，strategyGenerator.js:71-99）对所有个股统一，未针对行业/市值过滤，部分策略对小盘/停牌股无意义却仍参与。
- [ ] **#7 与长期判断同区但分工不明**：策略 tab 与长期判断卡片（stock-05）都涉及"未来方向"，但一个是回测胜率、一个是五因子加权，用户可能混淆两者结论来源。
- [ ] **#8 实时回测性能/超时**：回测在多候选×多周期上跑，前端 15s 超时（参考资金量能 app.js:3181）是否覆盖本 tab 未知（⚠️ 待核实 backtestUI 超时处理）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 候选策略库 | 双均线 / MACD / RSI / 布林 / 收益率 z-score 等 | strategyGenerator.js:71-99 |
| longTerm 偏置 | 读取 pa.longTerm.verdict 做多空 | strategyGenerator.js:199-214 |
| verdict 取值 | PASS / WARNING / REJECT / INSUFFICIENT_SAMPLE | strategyGenerator.js:244,527 |
| 回测周期 | 60m / 日 K（回退日线） | strategyGenerator.js（⚠️ 待核实具体参数） |
