# 前视偏差结算侧审计结论（common-06b-lookahead · 20261110g · 整改方案阶段 1 P0-1）

> 用户裁决：前视偏差**只做结算侧**。范围 = 四条结算链。
> 实现单一真值源：`lib/lookahead.js`（auditSettlement / markSettlement / splitComparable / incomparableDisclosure）。
> 守卫：`scripts/test_lookahead_guard.js`（26 断言，含「补录数据不可得」夹具）。

## 一、四条结算链逐链结论

| 结算链 | 结算本体消费的数据 | 数据可得时点 | 前视风险 | 处理 |
|---|---|---|---|---|
| `sameDayJudgment.settleRecord`（个股 6 因子，nextday/intraday） | 个股日 K 收盘价（`getHistory`）+ 交易日历（targetDate 防呆） | K 线在目标日收盘后可得；结算函数已有「目标日未收盘不结算」守卫 | 结算计算本体**无前视**；风险在记录内嵌的因子快照（融资余额 T+1 披露/财报期等）无逐项可得时间戳 | 结算时挂 `lookahead.markSettlement`（窗口 4 天）；可比口径=未打标记录 |
| `marketTechJudgment.settleRecord`（上证短/中期） | 上证日 K 收盘（腾讯 fqkline）+ 交易日历 | 同上；短期/中期目标日均有收盘守卫 | 同上；记录含 `settledAt` 后补（本版起写入） | 挂钩（窗口覆盖 MID_HORIZON=20）；`stat()` 排除打标记录并披露数量 |
| `techFaceJudgment.settleSymbol`（技术面形态 HORIZON=5 窗口） | 个股前复权日 K（`getHistoryDeep`） | 窗口第 H 个交易日收盘后 | 结算计算本体无前视（基准/目标 K 线缺失显式 pending/error，不臆造） | 挂钩（窗口 = horizon×2+2）；computeAccuracy 同口径 |
| `sentimentAccuracy.settleRecord`（情绪预警 vs 次日上证） | 上证日 K 收盘 + 交易日历 | 同上 | 结算计算本体无前视 | 挂钩（窗口 3 天）；computeAccuracy 同口径 |

## 二、审计发现（实查 2026-11-10）

1. **结算计算本体干净**：四条链结算只消费 K 线收盘价与交易日历，不触碰龙虎榜补录 / ETF 份额 / 融资余额 / 财报期等带披露时滞的数据源（grep 实证：这四类数据只出现在**判断生成侧**的因子采集，不进结算计算）。
2. **真正的风险在记录内容侧**：判断记录的因子快照大多**没有逐项可得时间戳**（实查 2026-11-10 记录：8 个因子 0 个带 ts），历史记录无法逐项复核「判断时点该数据是否已披露」。可强校验的时间戳只有三类：`generatedAt`（asOf 权威口径）、`reportEvent.date`（财报披露日）、记录内嵌 `dataTime`/`fetchedAt` 散点。
3. **历史记录全量抽审（§2b）**：data/judgments 53 个文件 / 399 条记录，L1/L2/L3 违规 **0 条** → 历史准确率与新旧口径**数字一致**（回算对比报告见 `docs/accuracy-backtest-report-20261110.md`）。

## 三、落地机制（对方案验收项逐条）

| 方案验收 | 落地 |
|---|---|
| 结算取数入口统一强制 `asOf = 判定生成日` | `auditSettlement` 以 `rec.generatedAt`（缺省回退 `rec.date`/`baseDate`）为 asOf 唯一口径 |
| 数据可得时间 ≤ asOf+结算窗口校验 | L1 财报披露日 ≤ asOf；L2 settledAt ≥ 目标日；L3 内嵌时间戳 ≤ asOf+窗口+1 天跨时区宽限 |
| 不满足 → 标 `lookahead_excluded` 计入不可比样本如实披露 | 结算挂钩 `markSettlement` 打 `rec.lookaheadExcluded`+`lookaheadViolations`（**记录本体与事实结果保留**）；四链 `computeAccuracy` 用 `splitComparable` 拆分，输出 `lookaheadExcludedCount`+`incomparableSamples`（含逐条原因），旧口径数字留档 `accuracyIncludingLookahead` |
| 补录字段（formal→complete）不进当日结算 | 四条链结算从不读复盘补录数据（结论一）；大盘复盘 complete 升级只改复盘 Markdown 本体，不改已结算判断记录 |
| 守卫断言（补录数据不可得夹具→结算如实排除） | `test_lookahead_guard.js` §1/§2/§3 |
| 历史已结算记录不悄悄回算（裁决④要求回算+对比报告） | `scripts/accuracy_backtest_report.js` 只读回算出报告，不改任何落盘记录 |

## 四、已知边界（如实声明）

- 因子快照缺逐项可得时间戳 → 对「判断生成侧」使用了披露时滞数据的历史记录**无法事后证明或证伪**；本审计只能保证（a）结算计算本体无前视、（b）可校验时间戳全部合规、（c）未来新结算记录自动挂审计。逐项时间戳补全属判断生成侧改造，超出「只做结算侧」裁决范围，留待后续版本。
- `dataTime`（本地日期）与 `generatedAt`（UTC 日期）跨时区边界宽限 1 天（`ROLLBACK_GRACE_DAYS`），宁可少报不误报。
