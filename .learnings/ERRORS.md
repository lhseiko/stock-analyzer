# ERRORS.md — 命令/操作/集成失败记录（self-improving skill）

> 格式见 self-improving skill：ERR-YYYYMMDD-XXX + Summary/Error/Context/Suggested Fix/Metadata。
> 修复后把 Status 改 resolved 并补 Resolution 块。

## [ERR-20261020-001] sentiment_accuracy_weekend_basedate_stuck

**Logged**: 2026-10-20T03:50:00Z
**Priority**: high
**Status**: resolved（20261020a 三处修复完成，用户 2026-10-20 确认「按完整三步修复」）
**Area**: backend

### Summary
市场情绪提醒准确率台账（data/sentiment-accuracy/）出现「基准日落非交易日 → 记录永久卡在待结算」：2026-10-18（周日）留档的预测 baseDate=2026-10-18，上证指数日 K 无此日线，settleRecord 找不到基准日 K 线（baseIdx=-1）直接 return，任何重启/定时结算都无法结算，台账「已结算数」永久少于「已记录数」。用户 2026-10-20 截图报障「结算的数量比预测的数量少太大」。

### Error
```
rec: 2026-10-18 -> 2026-10-19 dir: 跌
hist bars: 321 | last 3 dates: 2026-10-16, 2026-10-19, 2026-10-20
has 10-18 bar: false | has 10-19 bar: true
after settleRecord: settled = false | actualDir = undefined
```

### Context
- 触发链：周日下午首页调 /api/sentiment-turning-point → buildHomeMarketEmotion → computeMarketEmotion 内 `rec.baselineDate = bars.length ? bars[bars.length-1].date : today`（marketEmotionModel.js:832）——本机东财/网络瞬时失败（logs 满屏 socket hang up）致 index bars 为空 → baselineDate 兜底为 today=2026-10-18（周日）→ server.js:942 以 `{ baseDate: emo.baselineDate }` 留档 → sentimentAccuracy 写 baseDate=2026-10-18、targetDate=nextTradingDay=2026-10-19。
- settleRecord（sentimentAccuracy.js:131）只有 targetDate 防呆（20261013f：目标日撞休市日则重算），**baseDate 侧无防呆**；`hist.findIndex(h => h.date === rec.baseDate)` 找不到周日线 → -1 → return rec，永久 pending。
- 佐证：marketEmotionModel 自己的 records.json 同日记录 baselineDate=2026-10-16（后一次成功调用 upsert 修正），证明周日数据基准确是上一个交易日 10-16；且 10-16 留档（已结算）与 10-18 留档预测目标同为 10-19、方向同为跌——10-18 记录是纯 bug 产物，无独立信息。
- 影响面：每个周末只要发生「页面访问 + 日线通道瞬时失败」就会复造一条卡死记录；当前台账 18 记录/15 结算/3 待结算，其中 10-18 为卡死，10-19（目标 10-20 今日交易中）与 10-20（目标 10-21 未来）为正常待结算。

### Suggested Fix（待用户确认后实施）
1. **结算侧防呆**（lib/sentimentAccuracy.js settleRecord）：baseDate 非交易日时回滚上一个交易日（`previousTradingDay`，cnTradingCalendar 已导出，sameDayJudgment:211 有 wrapper），与 targetDate 防呆对称；修后 settleAll 可自愈旧卡死记录。
2. **留档侧防呆**（lib/sentimentAccuracy.js recordDailyJudgment）：`meta.baseDate || localDate()` 之后，非交易日回滚 previousTradingDay——周末调用的数据基准本就是上个交易日，回滚后与既有留档幂等去重（prev.settled 早退），不再产生卡死记录。
3. **存量卡死记录**：建议删除 data/sentiment-accuracy/2026-10-18.json（与 10-16 记录同数据基准、同预测目标、同方向，属重复计数）；或保留待修复 1 自动补结算（会重复计一次未命中）。

### Resolution（20261020a 已实施）
1. 结算侧：`settleRecord` 基准日比对改走新增纯函数 `resolveBaseDate`（非交易日→previousTradingDay 回滚，空值透传）；不变量 `nextTradingDay(d)==nextTradingDay(previousTradingDay(d))` 由测试锁定，目标日不受影响。
2. 留档侧：`recordDailyJudgment` 同样回滚，并追加保护——**回滚而来的记录不得覆盖回滚目标日的既有留档**（实证 10-18 周日降级结论只剩融资余额单因子、indexValue 为 null，若允许覆盖会顶替 10-16 正常记录；原 Suggested Fix 的「幂等去重」仅防 settled 覆盖，此处加固）。
3. 存量：`data/sentiment-accuracy/2026-10-18.json` 已删除，台账回到 17 条。
- 验证：test_event_weight_sentiment_acc.js 新增 9 项防呆用例（resolveBaseDate 4 项 + 不变量 1 项 + 接线断言 1 项 + 留档功能实测 3 项，44/44 全绿）；全量回归 50/53（3 个在档旧失败零新增）；node 直调 settleRecord 复刻周日记录 `settled=true`（回滚 10-16 基准 3716.28 vs 10-19 目标 3730.92，+0.39% 震荡未命中）；磁盘台账 overdue=0。版本戳 APP_VERSION 20261020a + public 31 处。
- 附带发现（未修，用户批准另开一轮）：权重自学习「当前样本不足」文案与实际不符——priceVolume 旧 key 28 样本不参与学习（不在 BASE_WEIGHTS）、volumePrice 新 key 仅 3 样本、indexMomentum/margin 已到 W_MAX=30 → learnLog 恒空。

### Metadata
- Reproducible: yes（node -e 调 settleRecord 实证，见上；零网络可复现路径：构造 baseDate=周日的 rec）
- Related Files: lib/sentimentAccuracy.js, lib/marketEmotionModel.js, server.js, data/sentiment-accuracy/2026-10-18.json
- Tags: sentiment-accuracy, weekend-baseline, stuck-settlement, degrade-fallback
- Pattern-Key: backend.accuracy_ledger_nontrading_basedate
- Recurrence-Count: 1
- First-Seen: 2026-10-18
- Last-Seen: 2026-10-20
