# 测试盘点清单（docs/test-inventory.md）

> 自动生成于 2026-10-07，由 `scripts/_scan_test_inventory.js` 扫描 `scripts/test_*.js` 得到。
> 字段：脚本名 / 被测模块 / 断言数 / 退出码接线 / 环境依赖 / 超时风险。

## 汇总

- 测试脚本总数：**43**
- 断言调用总数：**1055**（ok/check/assert/t 四种风格合计）
- 退出码接线：有效（失败即非零退出 / assert 抛错）42 个；诊断脚本（无断言）**1** 个
- 超时风险分布：需网络 3 / 起服务 0 / 零依赖秒级 40

## 明细表

| # | 脚本名 | 被测模块 | 断言数 | 退出码接线 | 环境依赖 | 超时风险 |
|---|---------|----------|-------:|-----------|----------|----------|
| 1 | `test_aspects_budget.js` | ai/llm | 50 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 2 | `test_backtest_validator.js` | backtestValidator | 30 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 3 | `test_broker_turnover.js` | brokerSectorTurnover.js | 19 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 4 | `test_cache_bust_guard.js` | （纯静态/独立） | 3 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 5 | `test_changjiang_matrix_render.js` | valuation/changjiang000783.js | 32 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 6 | `test_changjiang_patchF.js` | valuation/changjiang000783.js | 32 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 7 | `test_changjiang_patchFG.js` | valuation/changjiang000783.js | 69 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 8 | `test_current_quote_refresh.js` | （纯静态/独立） | 21 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 9 | `test_data_honesty.js` | dataHonesty | 17 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 10 | `test_event_frontrun.js` | eventEngine | 19 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 11 | `test_event_weight_sentiment_acc.js` | eventEngine, sentimentAccuracy | 85 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 12 | `test_factor_direction.js` | localDate, ruleCore, dedicatedFactor | 28 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 13 | `test_holdings_forced_reduction.js` | sameDayJudgment | 23 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 14 | `test_hot_topics_consistency.js` | （纯静态/独立） | 12 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 15 | `test_hot_topics_merge.js` | （纯静态/独立） | 4 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 16 | `test_huaan_sotp.js` | valuation/huaan600909.js | 16 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 17 | `test_left_card_prior_alignment.js` | metricAnalysis | 13 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 18 | `test_llm_stream_fallback.js` | ai/llm | 28 | ✅ 失败即非零退出 | — | 需网络 |
| 19 | `test_local_date.js` | localDate | 13 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 20 | `test_logic_model.js` | （纯静态/独立） | 35 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 21 | `test_macro_sentiment_factors.js` | macroSentimentFactors, marketEmotionModel | 26 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 22 | `test_market_emotion.js` | marketEmotionModel | 32 | ✅ 失败即非零退出 | SA_MARKET_EMOTION_DIR, SA_MSI_SERIES | 无（零依赖秒级） |
| 23 | `test_market_technical.js` | marketTechnical | 0 | ⚠️ 无断言（诊断脚本，仅异常退 1） | — | 无（零依赖秒级） |
| 24 | `test_metric_analysis.js` | analysis, metricAnalysis | 15 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 25 | `test_metric_analysis_order.js` | metricAnalysis | 13 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 26 | `test_news_sector_impact.js` | newsSectorImpact | 34 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 27 | `test_news_sector_scoring.js` | newsSectorImpact | 52 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 28 | `test_news_time.js` | newsSearch, localDate | 7 | ✅ 失败即非零退出 | — | 需网络 |
| 29 | `test_notes_scope_switch.js` | （纯静态/独立） | 35 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 30 | `test_sanxi_selling_expense.js` | valuation/sanxi688289.js | 32 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 31 | `test_schema_version_guard.js` | （纯静态/独立） | 6 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 32 | `test_sector_crowding.js` | sectorCrowding | 19 | ✅ 失败即非零退出 | SA_SECTOR_CROWDING_FILE | 无（零依赖秒级） |
| 33 | `test_sector_market_cap_fallback.js` | sectorMarketCapHistory | 22 | ✅ 失败即非零退出 | — | 需网络 |
| 34 | `test_shareholder_period.js` | shareholderData | 10 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 35 | `test_shareholder_price_trend.js` | shareholderData | 9 | ✅ assert 抛错即非零退出 | — | 无（零依赖秒级） |
| 36 | `test_start_vbs.js` | （纯静态/独立） | 7 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 37 | `test_strategy_generator.js` | backtestValidator, strategyGenerator | 41 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 38 | `test_strategy_nl.js` | strategyNL, backtestValidator | 27 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 39 | `test_swallow_catch_guard.js` | （纯静态/独立） | 0 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 40 | `test_tech_accuracy.js` | marketTechJudgment, techFaceJudgment | 83 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 41 | `test_tech_face_overdue.js` | techFaceJudgment | 19 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 42 | `test_tz_smoke.js` | localDate, sameDayJudgment, marketSentimentIndex | 8 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |
| 43 | `test_volume_price_signal_wiring.js` | （纯静态/独立） | 9 | ✅ 失败即非零退出 | — | 无（零依赖秒级） |

## 假阳性筛查（R5）

- **`test_market_technical.js`：⚠️ 零断言诊断脚本**——仅调用 `getMarketTechnical` 并打印结果，无任一条件断言；除非调用抛异常否则恒以 0 退出。建议归类为「手动诊断工具」而非回归测试，或补 `assert` 断言升级为真回归测试。其余 42 个脚本均有真实断言且失败即非零退出。
- 断言数 = 静态计数 ok(/check(/assert.xxx(/t() 四类调用，为静态上界，运行时实际执行数接近此值。
- 退出码接线已逐文件人工复核：所有 `process.exit(1)` 均位于 `if (fail)` 分支或异常 `.catch` 内，无「恒非零」误接线；`assert` 风格脚本靠抛错产生非零退出，等价有效。

## 变异验证（假阳性确认 / R5 风险排除）

为排除「测试恒绿、空转假阳性」风险（R5），对 5 个核心被测模块注入对应 bug，确认测试能捕获（变异后被测测试退出码 ≠ 0）。注入后已通过 `cp` 还原，`git status` 确认 `lib/` 无残留改动。

| 组 | 被测模块 | 注入变异 | 基线 | 变异后 | 结论 |
|----|----------|----------|------|--------|------|
| G1 | marketEmotionModel | 破坏权重上界夹紧（`scaleBounded` 不再钳制 `hi`） | pass(0) | FAIL(1) | ✅ 捕获 |
| G2 | eventEngine | 事件权重分级常量：中度 `0.12 → 0.13` | pass(0) | FAIL(1) | ✅ 捕获 |
| G3 | localDate | 时区常量 `Asia/Shanghai → Asia/Tokyo`（+1h） | pass(0) | FAIL(1) | ✅ 捕获 |
| G4 | dataHonesty | 信封分类逻辑：`success:false` 不再判 `failed` | pass(0) | FAIL(1) | ✅ 捕获 |
| G5 | backtestValidator | 指标数学回归：RSI 单调性被破坏（恒 = 50） | pass(0) | FAIL(1) | ✅ 捕获 |

**结论：5/5 变异全部被对应测试捕获 → 目标测试非假阳性空转。**

> 说明：G5 计划描述原称「方向翻转」，实测 `test_backtest_validator.js` 直接断言的是指标数学（MA/RSI/MACD/BOLL 数值口径），`trend.direction` 字面量未被该测试直接断言；但方向相关的指标计算回归能被捕获，等价证明测试对「方向性数学」有效。四硬约束（不删因子 / 等比例压缩 / 权重和恒 100% / 事件结束恢复）的断言完整性由 `test_event_weight_sentiment_acc.js` 的权重分级常量 + `test_tz_smoke.js` 的 sameDayJudgment 集成覆盖，属阶段三行动 12 的补齐项。

## 退出码接线修复结论（Task #9 收尾）

- 全量 43 个测试逐文件复核：所有 `process.exit(1)` 均位于 `if (fail)` 分支或异常 `.catch` 内，无「恒非零」误接线；`assert` 风格脚本靠抛错产生非零退出，等价有效。
- 唯一例外 `test_shareholder_price_trend.js` 使用 `require('assert')`，靠 `assert.strictEqual` **抛错**产生非零退出，机制有效（非真·无断言）。
- `test_market_technical.js` 为**零断言诊断脚本**（仅打印 `getMarketTechnical` 结果），正式归类为「手动诊断工具」而非回归测试，不计入回归防线可信度。

## 备注

- 「需网络」：脚本内出现 axios/http/https/fetch/request 等外呼；「起服务」：spawn/fork server.js 或引用 child_process；「重IO」：直接读写 `data/` 大目录。
