# 测试回归报告（docs/test-report.md）

> 生成时间：2026-10-30T11:42:10.113Z
> 模式：quick（跳过需网络测试）
> 命令：`node scripts/run_all_tests.js --quick`

## 结论

**❌ 80/88 通过，失败 8 项**

- 执行测试数：88
- 通过：80　失败：8　跳过（需网络）：11

## 明细

| 状态 | 测试 | 退出码 |
|------|------|--------|
| ✅ | `test_analysis_warm.js` | 0 |
| ❌ | `test_aspects_budget.js` | 1 |
| ✅ | `test_backtest_validator.js` | 0 |
| ✅ | `test_broker_turnover.js` | 0 |
| ✅ | `test_buyback_event_weight.js` | 0 |
| ✅ | `test_buyback_plan.js` | 0 |
| ✅ | `test_cache_bust_guard.js` | 0 |
| ✅ | `test_changjiang_patchJ.js` | 0 |
| ✅ | `test_chart_range_cursor.js` | 0 |
| ❌ | `test_current_quote_refresh.js` | 1 |
| ✅ | `test_daily_market_review.js` | 0 |
| ✅ | `test_data_honesty.js` | 0 |
| ✅ | `test_emotion_judgment_consistency.js` | 0 |
| ✅ | `test_etf_cash_trend.js` | 0 |
| ✅ | `test_etf_flow.js` | 0 |
| ✅ | `test_event_frontrun.js` | 0 |
| ✅ | `test_event_guardrails.js` | 0 |
| ✅ | `test_event_weight_sentiment_acc.js` | 0 |
| ✅ | `test_factor_direction.js` | 0 |
| ✅ | `test_holdings_forced_reduction.js` | 0 |
| ❌ | `test_hot_topics_consistency.js` | 1 |
| ✅ | `test_hot_topics_merge.js` | 0 |
| ✅ | `test_huaan_sotp.js` | 0 |
| ✅ | `test_industry_policy_match.js` | 0 |
| ✅ | `test_latest_report_period.js` | 0 |
| ✅ | `test_left_card_prior_alignment.js` | 0 |
| ✅ | `test_limit_board_top.js` | 0 |
| ✅ | `test_local_date.js` | 0 |
| ❌ | `test_logic_model.js` | 1 |
| ✅ | `test_macro_sentiment_factors.js` | 0 |
| ✅ | `test_mainfund_stable_source.js` | 0 |
| ✅ | `test_manual_zones.js` | 0 |
| ✅ | `test_market_ai_cache_notes.js` | 0 |
| ✅ | `test_market_emotion.js` | 0 |
| ✅ | `test_market_emotion_volume_text.js` | 0 |
| ✅ | `test_market_tech_settle.js` | 0 |
| ✅ | `test_market_technical.js` | 0 |
| ✅ | `test_market_volume_root_migration.js` | 0 |
| ❌ | `test_metric_analysis.js` | 1 |
| ✅ | `test_metric_analysis_order.js` | 0 |
| ✅ | `test_minute_chart.js` | 0 |
| ✅ | `test_module_sync.js` | 0 |
| ✅ | `test_news_sector_impact.js` | 0 |
| ✅ | `test_news_sector_scoring.js` | 0 |
| ✅ | `test_non_trading_day_policy.js` | 0 |
| ✅ | `test_notes_scope_switch.js` | 0 |
| ✅ | `test_range_detector.js` | 0 |
| ❌ | `test_sanxi_selling_expense.js` | 1 |
| ✅ | `test_schema_version_guard.js` | 0 |
| ✅ | `test_sector_crowding.js` | 0 |
| ✅ | `test_shareholder_period.js` | 0 |
| ✅ | `test_shareholder_price_trend.js` | 0 |
| ✅ | `test_start_vbs.js` | 0 |
| ✅ | `test_stock_log.js` | 0 |
| ✅ | `test_strategy_generator.js` | 0 |
| ✅ | `test_strategy_nl.js` | 0 |
| ❌ | `test_swallow_catch_guard.js` | 1 |
| ✅ | `test_tech_accuracy.js` | 0 |
| ❌ | `test_tech_face_overdue.js` | 1 |
| ✅ | `test_ths_backfill.js` | 0 |
| ✅ | `test_ths_daily_cache.js` | 0 |
| ✅ | `test_ths_kline.js` | 0 |
| ✅ | `test_trading_calendar.js` | 0 |
| ✅ | `test_tz_smoke.js` | 0 |
| ✅ | `test_valuation_changjiang.js` | 0 |
| ✅ | `test_valuation_haitian.js` | 0 |
| ✅ | `test_valuation_huaan.js` | 0 |
| ✅ | `test_valuation_pingan.js` | 0 |
| ✅ | `test_valuation_sanxi.js` | 0 |
| ✅ | `test_valuation_silan.js` | 0 |
| ✅ | `test_valuation_wanrun.js` | 0 |
| ✅ | `test_valuation_xinyangfeng.js` | 0 |
| ✅ | `test_volume_caliber_20261024c.js` | 0 |
| ✅ | `test_volume_confirm_label.js` | 0 |
| ✅ | `test_volume_consistency.js` | 0 |
| ✅ | `test_volume_engine.js` | 0 |
| ✅ | `test_volume_gap_label.js` | 0 |
| ✅ | `test_volume_latest_day.js` | 0 |
| ✅ | `test_volume_low_huge_not_down.js` | 0 |
| ✅ | `test_volume_merge.js` | 0 |
| ✅ | `test_volume_price_signal_wiring.js` | 0 |
| ✅ | `test_volume_root_migration.js` | 0 |
| ✅ | `test_volume_ten_rules.js` | 0 |
| ✅ | `test_volume_unit_contract.js` | 0 |
| ✅ | `test_zone_level_hints.js` | 0 |
| ✅ | `test_zone_resonance.js` | 0 |
| ✅ | `test_zone_reversal.js` | 0 |
| ✅ | `test_zone_validity.js` | 0 |

> 以下需网络测试在本模式被跳过（用 `node scripts/run_all_tests.js` 全量执行）：
> - `test_api_smoke.js`
> - `test_etf_card_layout.js`
> - `test_index_sina_fallback.js`
> - `test_llm_stream_fallback.js`
> - `test_metric_analysis_nbv.js`
> - `test_news_time.js`
> - `test_sector_market_cap_fallback.js`
> - `test_switch_stock.js`
> - `test_tkline_host.js`
> - `test_us_treasury.js`
> - `test_zone_sort_order.js`
