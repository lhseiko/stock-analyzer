# Stock Analyzer · 完整代码审查包

> 生成时间：2026/11/10 19:56:00
> 项目根目录：`D:\stock analyzer\stock-analyzer`
> 源码统计：共 **470** 个文本文件，约 **185,775** 行（已排除 node_modules / .venv_akshare / data / .git / .workbuddy / package-lock.json）

## 一、如何阅读这份包
- **本文件（README.md）= 导航总览**：含架构说明与完整文件树（每个文件标注行数，便于定位）。
- **code-*.md = 各子系统完整源码分卷**：按子系统分组、按行数切卷；每卷内每个文件以 `## `路径`` 为标题、下接代码块，可直接全文检索。
- 检索建议：在编辑器/预览中按文件名（如 `lib/reviewContext.js`）搜索即可跳到对应分卷。

## 二、架构总览（给非技术审阅者）
Stock Analyzer 是一个 **Node.js + Express 本地 Web 工作台**（固定运行 3005 端口），自研量化分析：
- **数据层**：主行情来自腾讯行情接口（GBK 编码），深度分析依赖东财妙想金融数据；外抓补充来自 akshare（Python 虚拟环境 .venv_akshare）。
- **业务逻辑层（lib/）**：各类确定性引擎（量能、题材归因、估值、深度分析、短期判断等），所有数值由代码计算，LLM 仅负责叙事，不推导公式。
- **服务层（server.js + routes/）**：Express 路由、定时调度（盘前/盘后/补录）、REST API。
- **展示层（public/）**：softDark 暗色主题前端，红涨绿跌；图表用本地随包的 ECharts，复盘 Markdown 用本地随包渲染器。
- **复盘生成（prompts/ + lib/reviewContext.js + lib/reviewLlm.js）**：代码取数 → 组装干净 JSON Context → 大模型按 System Prompt 生成 Markdown 落盘。
- **脚本（scripts/）**：单元/契约守卫、数据抓取与联调工具。

## 三、子系统分卷清单
- `code-entry-1.md` —— 入口与服务层（server.js / routes / prompts / 根配置） 第1卷（16 文件 / 5,247 行）
- `code-lib-1.md` —— 核心业务逻辑（lib/） 第1卷（50 文件 / 17,892 行）
- `code-lib-2.md` —— 核心业务逻辑（lib/） 第2卷（49 文件 / 17,810 行）
- `code-lib-3.md` —— 核心业务逻辑（lib/） 第3卷（39 文件 / 17,999 行）
- `code-lib-4.md` —— 核心业务逻辑（lib/） 第4卷（14 文件 / 7,816 行）
- `code-public-1.md` —— 前端（public/） 第1卷（8 文件 / 17,915 行）
- `code-public-2.md` —— 前端（public/） 第2卷（28 文件 / 13,717 行）
- `code-scripts-1.md` —— 脚本与测试（scripts/） 第1卷（103 文件 / 17,973 行）
- `code-scripts-2.md` —— 脚本与测试（scripts/） 第2卷（67 文件 / 12,170 行）
- `code-docs-1.md` —— 项目文档（docs/） 第1卷（50 文件 / 13,618 行）
- `code-docs-2.md` —— 项目文档（docs/） 第2卷（4 文件 / 16,839 行）
- `code-docs-3.md` —— 项目文档（docs/） 第3卷（5 文件 / 15,109 行）
- `code-docs-4.md` —— 项目文档（docs/） 第4卷（7 文件 / 6,817 行）
- `code-misc-1.md` —— 其余（.learnings / miaoxiang / reports / 根级零散文件） 第1卷（30 文件 / 4,853 行）

## 四、完整文件树（含行数）
```
📁 .learnings/
  ERRORS.md  _(355 行)_
  FEATURE_REQUESTS.md  _(187 行)_
  LEARNINGS.md  _(69 行)_
  📁 archive/
    LEARNINGS-full-20261110.md  _(3248 行)_
DESIGN.md  _(126 行)_
SESSION-STATE.md  _(46 行)_
📁 docs/
  📁 logic/
    README.md  _(254 行)_
    _template.md  _(43 行)_
    common-01-data-source.md  _(190 行)_
    common-02-api.md  _(96 行)_
    common-03-ai.md  _(82 行)_
    common-04-event-engine.md  _(111 行)_
    common-05-valuation.md  _(80 行)_
    common-06-accuracy.md  _(80 行)_
    common-07-guards.md  _(88 行)_
    common-08-switch-stock.md  _(136 行)_
    daily-review-code-dump-20261110.md  _(1864 行)_
    daily-review-spec-20261110.md  _(112 行)_
    home-01-market-emotion.md  _(122 行)_
    home-02-realtime-market.md  _(120 行)_
    home-03-market-technical.md  _(214 行)_
    home-04-index-pe-trend.md  _(81 行)_
    home-05-sector-crowding.md  _(92 行)_
    home-06-daily-hot-topics.md  _(167 行)_
    home-07-weekly-sentiment.md  _(135 行)_
    home-08-daily-macro.md  _(160 行)_
    home-09-fund-industry.md  _(102 行)_
    home-10-etf-flow.md  _(196 行)_
    page-01-02-accuracy-judgments.md  _(75 行)_
    page-03-global.md  _(81 行)_
    stock-01-header.md  _(151 行)_
    stock-02-scores.md  _(170 行)_
    stock-03-industry-outlook.md  _(138 行)_
    stock-04-short-term.md  _(174 行)_
    stock-05-long-term.md  _(115 行)_
    stock-06-highlights.md  _(77 行)_
    stock-07-profile.md  _(70 行)_
    stock-08-technical.md  _(90 行)_
    stock-09-fundamental.md  _(89 行)_
    stock-10-shareholder.md  _(73 行)_
    stock-11-deep-analysis.md  _(116 行)_
    stock-12-industry-analysis.md  _(88 行)_
    stock-13-capital.md  _(539 行)_
    stock-13b-volume-ten-rules.md  _(96 行)_
    stock-14-highlights-tab.md  _(67 行)_
    stock-15-f10.md  _(69 行)_
    stock-16-strategy.md  _(68 行)_
    stock-17-range.md  _(377 行)_
    stock-18-zone-validity.md  _(196 行)_
    stock-19-manual-zones.md  _(93 行)_
    stock-20-zone-reversal.md  _(92 行)_
    stock-21-zone-methods.md  _(215 行)_
    stock-22-chart-range-cursor.md  _(106 行)_
  📁 reports/
    accuracy-pending-list-preview-20261023.html  _(21 行)_
    buyback-to-event-preview-20261023.html  _(43 行)_
    data-consistency-fix-preview-20261023.html  _(5604 行)_
    data-date-lag-fix-preview-20261023.html  _(5605 行)_
    date-labeling-fix-preview-20261023.html  _(5608 行)_
    earnings-period-fix-preview-20261023.html  _(34 行)_
    etf-card-layout-fixed-20261023.html  _(5592 行)_
    etf-flow-tab-preview.html  _(5555 行)_
    etf-pcf-csi300-20261022.html  _(3885 行)_
    volume-gap-label-fix-20261023.html  _(25 行)_
    volume-low-huge-not-down-fix-20261023.html  _(29 行)_
    volume-price-dual-market-preview-20261023.html  _(5615 行)_
    volume-price-window-preview-20261023.html  _(5605 行)_
    volume-ten-rules-preview-20261023.html  _(30 行)_
  swallow-catch-baseline.json  _(6 行)_
  swallow-catch-manifest.md  _(243 行)_
  system_design.md  _(688 行)_
  test-inventory.md  _(92 行)_
  test-report.md  _(153 行)_
generate_icon.py  _(161 行)_
kill_port_3005.bat  _(5 行)_
📁 lib/
  📁 ai/
    augmentStock.js  _(432 行)_
    cache.js  _(63 行)_
    companyDeep.js  _(461 行)_
    config.js  _(210 行)_
    earnings.js  _(622 行)_
    images.js  _(151 行)_
    llm.js  _(546 行)_
    market.js  _(264 行)_
    research.js  _(200 行)_
    valuation.js  _(455 行)_
  aiAugment.js  _(35 行)_
  analysis.js  _(1384 行)_
  analysisWarm.js  _(158 行)_
  backtestValidator.js  _(1460 行)_
  boardReviewData.js  _(137 行)_
  brokerClassification.js  _(135 行)_
  brokerSectorTurnover.js  _(134 行)_
  brokerValuation.js  _(189 行)_
  buybackEmDc.js  _(312 行)_
  capitalFlow.js  _(1320 行)_
  changeAnalysis.js  _(307 行)_
  chipDistribution.js  _(100 行)_
  cnTradingCalendar.js  _(104 行)_
  cninfoAnnouncements.js  _(56 行)_
  cnscraperAdapter.js  _(211 行)_
  companyType.js  _(262 行)_
  consistencyAudit.js  _(364 行)_
  crossMarket.js  _(122 行)_
  dailyMarketReview.js  _(121 行)_
  dataHonesty.js  _(83 行)_
  db.js  _(238 行)_
  dedicatedFactor.js  _(327 行)_
  📁 deep/
    conclusion.js  _(662 行)_
    conclusions.js  _(494 行)_
    dividends.js  _(196 行)_
    financials.js  _(301 行)_
    pipeline.js  _(580 行)_
    research.js  _(500 行)_
    shared.js  _(67 行)_
    statements.js  _(460 行)_
    yield.js  _(234 行)_
  deepAnalysis.js  _(22 行)_
  docStore.js  _(273 行)_
  eastmoneyValuation.js  _(132 行)_
  emDataCenter.js  _(124 行)_
  etfFlow.js  _(1017 行)_
  eventEngine.js  _(1149 行)_
  f10Status.js  _(218 行)_
  factStore.js  _(349 行)_
  financeHub.js  _(151 行)_
  fundIndustryMatrix.js  _(1010 行)_
  fundamentalScore.js  _(411 行)_
  futuresData.js  _(212 行)_
  growthCaliber.js  _(78 行)_
  hotTopics.js  _(739 行)_
  📁 hotTopicsWeekly/
    config.js  _(66 行)_
    engine.js  _(311 行)_
    index.js  _(208 行)_
    nlp.js  _(149 行)_
  indexConstituents.js  _(198 行)_
  indexPETrend.js  _(209 行)_
  industryAnalysis.js  _(198 行)_
  industryIndexHistory.js  _(138 行)_
  industryProsperity.js  _(459 行)_
  insuranceAnalysis.js  _(1168 行)_
  localDate.js  _(94 行)_
  longTermJudgment.js  _(467 行)_
  macroData.js  _(773 行)_
  macroNews.js  _(140 行)_
  macroSentimentFactors.js  _(206 行)_
  manualZones.js  _(144 行)_
  marketEmotionData.js  _(348 行)_
  marketEmotionModel.js  _(1414 行)_
  marketLogDb.js  _(319 行)_
  marketRank.js  _(200 行)_
  marketSentimentIndex.js  _(319 行)_
  marketTechJudgment.js  _(380 行)_
  marketTechnical.js  _(920 行)_
  metricAnalysis.js  _(626 行)_
  miaoxiang.js  _(382 行)_
  miaoxiangMacro.js  _(198 行)_
  miaoxiangSearch.js  _(81 行)_
  moduleSync.js  _(208 行)_
  newsImpactLearning.js  _(131 行)_
  newsSearch.js  _(475 行)_
  newsSectorImpact.js  _(306 行)_
  pbcMacro.js  _(48 行)_
  pdfText.js  _(107 行)_
  posModel135.js  _(691 行)_
  priceAction.js  _(773 行)_
  priceActionHub.js  _(160 行)_
  pyRuntime.js  _(42 行)_
  quoteHub.js  _(141 行)_
  rangeDetector.js  _(311 行)_
  relevanceLearning.js  _(227 行)_
  reportSync.js  _(354 行)_
  reviewContext.js  _(318 行)_
  reviewEngines.js  _(831 行)_
  reviewLlm.js  _(122 行)_
  reviewService.js  _(793 行)_
  ruleCore.js  _(410 行)_
  sameDayJudgment.js  _(2435 行)_
  sectorCapitalFlow.js  _(323 行)_
  sectorCrowding.js  _(318 行)_
  sectorFundFlowEmDc.js  _(142 行)_
  sectorIdentity.js  _(431 行)_
  sectorLimitStats.js  _(50 行)_
  sectorMarketCapHistory.js  _(383 行)_
  sectorRankHistory.js  _(187 行)_
  sectorTrend.js  _(83 行)_
  sentiment.js  _(70 行)_
  sentimentAccuracy.js  _(276 行)_
  sentimentTurningPoint.js  _(417 行)_
  shareholderData.js  _(486 行)_
  stockData.js  _(2617 行)_
  stockLog.js  _(300 行)_
  stockSectorLevels.js  _(119 行)_
  stockSentiment.js  _(312 行)_
  strategyGenerator.js  _(565 行)_
  strategyNL.js  _(329 行)_
  techFaceJudgment.js  _(329 行)_
  thsDailyCache.js  _(226 行)_
  tklineHost.js  _(39 行)_
  topicEngines.js  _(494 行)_
  tradeCalendar.js  _(240 行)_
  usMacroCalendar.js  _(158 行)_
  usMacroEvents.js  _(107 行)_
  usMacroResults.js  _(326 行)_
  usTreasury.js  _(271 行)_
  📁 valuation/
    brokerModel.js  _(178 行)_
    changjiang000783.js  _(685 行)_
    dcavm688660.js  _(418 行)_
    haitian603288.js  _(700 行)_
    huaan600909.js  _(745 行)_
    maijie300319.js  _(299 行)_
    pingAn601318.js  _(473 行)_
    sanxi688289.js  _(790 行)_
    silan600460.js  _(475 行)_
    wanrun002643.js  _(758 行)_
    weigao603014.js  _(355 行)_
    xinyangfeng000902.js  _(511 行)_
  valuationHub.js  _(156 行)_
  volUnit.js  _(41 行)_
  volcSearch.js  _(145 行)_
  volumeCaliber.js  _(71 行)_
  volumeEngine.js  _(3504 行)_
  webSearchMcp.js  _(415 行)_
  zoneLevelsHint.js  _(50 行)_
  zoneMethods.js  _(840 行)_
  zoneResonance.js  _(362 行)_
  zoneReversal.js  _(339 行)_
  zoneValidity.js  _(269 行)_
📁 logs/
  server.log  _(120 行)_
make_shortcut.bat  _(9 行)_
📁 miaoxiang/
  📁 mx_finance_data/
    mx_finance_data_025ac324.md  _(5 行)_
    mx_finance_data_07ae0db8.md  _(5 行)_
    mx_finance_data_238c37ee.md  _(5 行)_
    mx_finance_data_2b74088e.md  _(5 行)_
    mx_finance_data_3d468810.md  _(5 行)_
    mx_finance_data_3fc5381d.md  _(117 行)_
    mx_finance_data_401f2761.md  _(5 行)_
    mx_finance_data_4b873186.md  _(5 行)_
    mx_finance_data_4f9d72e5.md  _(5 行)_
    mx_finance_data_6f3cad96.md  _(29 行)_
    mx_finance_data_7783f10f.md  _(29 行)_
    mx_finance_data_8ccd89e0.md  _(29 行)_
    mx_finance_data_8e2e0372.md  _(5 行)_
    mx_finance_data_a8693cee.md  _(5 行)_
    mx_finance_data_b07db832.md  _(5 行)_
    mx_finance_data_b27c63ae.md  _(5 行)_
    mx_finance_data_b3893c72.md  _(128 行)_
    mx_finance_data_e6778ca1.md  _(25 行)_
    mx_finance_data_f1f724e3.md  _(17 行)_
    mx_finance_data_fabb0453.md  _(5 行)_
package.json  _(19 行)_
📁 prompts/
  broker-valuation-data.md  _(46 行)_
  broker-valuation-models.md  _(68 行)_
  daily-review-system.md  _(79 行)_
  event-triage-system.md  _(52 行)_
  valuation-system.md  _(81 行)_
📁 public/
  accuracy.html  _(140 行)_
  📁 css/
    style.css  _(6707 行)_
  daily-review.html  _(64 行)_
  etf-flow.html  _(41 行)_
  index.html  _(1225 行)_
  📁 js/
    accuracy.js  _(469 行)_
    app.js  _(8800 行)_
    backtestUI.js  _(469 行)_
    capitalCharts.js  _(984 行)_
    chart3D.js  _(616 行)_
    chartTheme.js  _(184 行)_
    charts.js  _(1119 行)_
    dailyReview.js  _(374 行)_
    dataStatus.js  _(62 行)_
    deepCharts.js  _(2494 行)_
    docStore.js  _(1077 行)_
    etfFlowPage.js  _(357 行)_
    export.js  _(151 行)_
    homeHotTopics.js  _(159 行)_
    homeMacro.js  _(223 行)_
    homeNews.js  _(115 行)_
    homeRank.js  _(353 行)_
    industryCharts.js  _(851 行)_
    judgments.js  _(640 行)_
    logicModel.js  _(538 行)_
    markdown.js  _(195 行)_
    notes.js  _(1125 行)_
    shareholderCharts.js  _(458 行)_
    stockLog.js  _(353 行)_
    storage.js  _(166 行)_
  judgments.html  _(73 行)_
  logic-model.html  _(37 行)_
  notes.html  _(81 行)_
  📁 vendor/
    echarts-gl.min.js  _(1 行)_
    echarts.min.js  _(46 行)_
  volume-map.html  _(885 行)_
📁 reports/
  财政支出多渠道分析_2026-08-24.html  _(285 行)_
📁 routes/
  aiRoutes.js  _(506 行)_
  dedicatedFactor.js  _(65 行)_
  docsRoutes.js  _(336 行)_
  eventRoutes.js  _(154 行)_
  moduleSyncRoutes.js  _(40 行)_
📁 scripts/
  _chip_verify.js  _(112 行)_
  backup-data.ps1  _(24 行)_
  backup-github.ps1  _(42 行)_
  board_review_data.py  _(723 行)_
  check_report_gap.js  _(63 行)_
  cninfo_announcements.py  _(146 行)_
  cnscraper_adapter.py  _(535 行)_
  download_reports.py  _(1077 行)_
  em_sector_capital_flow.py  _(274 行)_
  etf_pcf_report.js  _(488 行)_
  export-baseline.json  _(143 行)_
  export-snapshot.js  _(132 行)_
  📁 fixtures/
    ths_000902_tail.json  _(1 行)_
  hot_topics_collect.py  _(747 行)_
  index_pe_trend.py  _(160 行)_
  make_favicon.py  _(53 行)_
  market_emotion.py  _(403 行)_
  migrateDividends.js  _(69 行)_
  pbc_social_financing.py  _(107 行)_
  pdf_extract_text.py  _(75 行)_
  register_watchdog.bat  _(17 行)_
  restore_drill.js  _(91 行)_
  restore_etf_20261028.js  _(117 行)_
  restore_etf_20261030.js  _(98 行)_
  restore_etf_20261106.js  _(157 行)_
  run_all_tests.js  _(144 行)_
  sa_lt_603288.json  _(1 行)_
  sa_sd.json  _(1 行)_
  sa_sd_601318b.json  _(1 行)_
  sa_sd_603288.json  _(1 行)_
  sector_limit_stats.py  _(294 行)_
  sector_trend.py  _(394 行)_
  sentiment.py  _(1393 行)_
  test_analysis_warm.js  _(88 行)_
  test_api_smoke.js  _(124 行)_
  test_aspects_budget.js  _(149 行)_
  test_backtest_validator.js  _(120 行)_
  test_bg_preload_indicator.js  _(54 行)_
  test_broker_turnover.js  _(61 行)_
  test_buyback_event_weight.js  _(121 行)_
  test_buyback_plan.js  _(127 行)_
  test_cache_bust_guard.js  _(75 行)_
  test_cap_vol_ratio_chart.js  _(103 行)_
  test_changjiang_patchJ.js  _(101 行)_
  test_chart_range_cursor.js  _(262 行)_
  test_color_semantics.js  _(242 行)_
  test_consistency_audit.js  _(143 行)_
  test_current_quote_refresh.js  _(56 行)_
  test_daily_market_review.js  _(72 行)_
  test_daily_review.js  _(448 行)_
  test_dashboard_ui_d.js  _(96 行)_
  test_data_honesty.js  _(88 行)_
  test_deep_chip_u1.js  _(82 行)_
  test_emotion_judgment_consistency.js  _(139 行)_
  test_emotion_margin_dual.js  _(203 行)_
  test_emotion_margin_render.js  _(128 行)_
  test_etf_card_layout.js  _(133 行)_
  test_etf_cash_trend.js  _(119 行)_
  test_etf_flow.js  _(190 行)_
  test_etf_flow_holiday_guard.js  _(132 行)_
  test_etf_monthly_provisional.js  _(275 行)_
  test_etf_universe_integrity.js  _(141 行)_
  test_event_frontrun.js  _(85 行)_
  test_event_guardrails.js  _(161 行)_
  test_event_weight_sentiment_acc.js  _(199 行)_
  test_factor_direction.js  _(193 行)_
  test_growth_caliber.js  _(141 行)_
  test_holdings_forced_reduction.js  _(107 行)_
  test_home_rank_scroll.js  _(83 行)_
  test_hot_topics_consistency.js  _(137 行)_
  test_hot_topics_merge.js  _(158 行)_
  test_hot_topics_stale_fix.js  _(74 行)_
  test_huaan_sotp.js  _(42 行)_
  test_index_pe_window_high.js  _(92 行)_
  test_index_sina_fallback.js  _(88 行)_
  test_industry_policy_match.js  _(69 行)_
  test_latest_report_period.js  _(88 行)_
  test_left_card_prior_alignment.js  _(104 行)_
  test_limit_board_top.js  _(57 行)_
  test_llm_stream_fallback.js  _(187 行)_
  test_local_date.js  _(73 行)_
  test_logic_model.js  _(162 行)_
  test_macro_sentiment_factors.js  _(87 行)_
  test_mainfund_stable_source.js  _(147 行)_
  test_manual_zone_reversal.js  _(208 行)_
  test_manual_zones.js  _(210 行)_
  test_margin_caliber_rename.js  _(194 行)_
  test_market_ai_cache_notes.js  _(84 行)_
  test_market_emotion.js  _(293 行)_
  test_market_emotion_volume_text.js  _(203 行)_
  test_market_log_db.js  _(185 行)_
  test_market_tech_settle.js  _(209 行)_
  test_market_technical.js  _(41 行)_
  test_market_volume_root_migration.js  _(322 行)_
  test_metric_analysis.js  _(91 行)_
  test_metric_analysis_nbv.js  _(252 行)_
  test_metric_analysis_order.js  _(159 行)_
  test_metric_analysis_vote.js  _(204 行)_
  test_minute_chart.js  _(173 行)_
  test_module_sync.js  _(139 行)_
  test_news_sector_impact.js  _(91 行)_
  test_news_sector_scoring.js  _(157 行)_
  test_news_time.js  _(69 行)_
  test_non_trading_day_policy.js  _(92 行)_
  test_note_attachments_tags.js  _(125 行)_
  test_notes_scope_switch.js  _(202 行)_
  test_pos_vm_strong.js  _(109 行)_
  test_pos_volume_matrix.js  _(225 行)_
  test_position_longterm.js  _(98 行)_
  test_position_trend_segment.js  _(168 行)_
  test_position_unified.js  _(89 行)_
  test_posj_symmetry.js  _(91 行)_
  test_range_detector.js  _(376 行)_
  test_review_engines.js  _(422 行)_
  test_sanxi_selling_expense.js  _(96 行)_
  test_schema_version_guard.js  _(52 行)_
  test_sector_crowding.js  _(101 行)_
  test_sector_market_cap_fallback.js  _(146 行)_
  test_shareholder_period.js  _(63 行)_
  test_shareholder_price_trend.js  _(45 行)_
  test_start_vbs.js  _(113 行)_
  test_stock_log.js  _(172 行)_
  test_strategy_generator.js  _(134 行)_
  test_strategy_nl.js  _(127 行)_
  test_swallow_catch_guard.js  _(103 行)_
  test_switch_stock.js  _(350 行)_
  test_tech_accuracy.js  _(150 行)_
  test_tech_face_overdue.js  _(160 行)_
  test_ths_backfill.js  _(115 行)_
  test_ths_daily_cache.js  _(201 行)_
  test_ths_kline.js  _(182 行)_
  test_tkline_host.js  _(113 行)_
  test_topic_engines.js  _(217 行)_
  test_trading_calendar.js  _(35 行)_
  test_tz_smoke.js  _(49 行)_
  test_us_treasury.js  _(175 行)_
  test_valuation_changjiang.js  _(187 行)_
  test_valuation_haitian.js  _(170 行)_
  test_valuation_huaan.js  _(159 行)_
  test_valuation_pingan.js  _(476 行)_
  test_valuation_sanxi.js  _(104 行)_
  test_valuation_silan.js  _(98 行)_
  test_valuation_wanrun.js  _(168 行)_
  test_valuation_weigao.js  _(158 行)_
  test_valuation_xinyangfeng.js  _(99 行)_
  test_volume_caliber_20261024c.js  _(80 行)_
  test_volume_caliber_warn.js  _(104 行)_
  test_volume_confirm_label.js  _(79 行)_
  test_volume_consistency.js  _(699 行)_
  test_volume_engine.js  _(1401 行)_
  test_volume_gap_label.js  _(152 行)_
  test_volume_latest_day.js  _(156 行)_
  test_volume_low_huge_not_down.js  _(126 行)_
  test_volume_merge.js  _(76 行)_
  test_volume_price_signal_wiring.js  _(92 行)_
  test_volume_ratio_labels.js  _(60 行)_
  test_volume_root_migration.js  _(339 行)_
  test_volume_single_source.js  _(244 行)_
  test_volume_unit_contract.js  _(137 行)_
  test_vp_conclusion_unified.js  _(142 行)_
  test_vp_ratio_interpret.js  _(183 行)_
  test_zone_level_hints.js  _(101 行)_
  test_zone_resonance.js  _(363 行)_
  test_zone_reversal.js  _(196 行)_
  test_zone_sort_order.js  _(147 行)_
  test_zone_validity.js  _(293 行)_
  ths_industry_index_history.py  _(266 行)_
  ths_sector_history.py  _(130 行)_
  ths_sector_summary.py  _(78 行)_
  unregister_watchdog.bat  _(11 行)_
server.js  _(3284 行)_
start.bat  _(67 行)_
启动诊断.bat  _(69 行)_
需求汇总.md  _(184 行)_
```
