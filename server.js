/**
 * Stock Analyzer Server
 * Express server providing REST API and static file serving
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const multer = require('multer');
const { getQuote, getHistory, getHistoryPeriod, getHistoryDeep, searchStocks, detectMarket, getMarketOverview, fetchTencentMinutes } = require('./lib/stockData');
const { technicalAnalysis, fundamentalAnalysis, evaluateSignals, aggregateSentiment, buildFundamentalComparison } = require('./lib/analysis');
const { analyzePriceAction } = require('./lib/priceAction');
const { getPriceActionSnapshot } = require('./lib/priceActionHub');
const { getNews, getHotNews } = require('./lib/newsSearch');
const { getMacroNews } = require('./lib/macroNews');
const { getMacroIndicators } = require('./lib/macroData');
const { getMarketRank } = require('./lib/marketRank');
const { getIndexPETrend } = require('./lib/indexPETrend');
const { getMarketTechnical } = require('./lib/marketTechnical'); // 首页·大盘技术分析（三大指数六步推演）
const { deepAnalysis, getLocalDocuments, loadDividendSeries, persistDividends, fetchDividends, normalizeSymbol } = require('./lib/deepAnalysis');
const { analyzeCapitalFlow } = require('./lib/capitalFlow');
const { classifyCompanyType } = require('./lib/companyType');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./lib/futuresData');
const { industryAnalysis } = require('./lib/industryAnalysis');
const { getShareholdersData, getCompanyProfile } = require('./lib/shareholderData');
const { getJudgmentWithAccuracy, settleAll, settleSymbol, getAllRecords, filterBySymbol, computeAccuracy, getLearningState, preOpenRecomputeAll, localDate } = require('./lib/sameDayJudgment');
const { getMarketSentiment } = require('./lib/sentiment');
const { getSectorTrend } = require('./lib/sectorTrend');
const { getSectorLimitStats } = require('./lib/sectorLimitStats');
const { getLongTermJudgment } = require('./lib/longTermJudgment');
// Part B：弱关联关联度 / 持续性经验库（调试透明用）
const { getState: getRelevanceLearningState } = require('./lib/relevanceLearning');
const { annotateNewsImpact } = require('./lib/newsSectorImpact');
const { recordImpact, correctImpact, getLearningState: getNewsImpactLearningState, autoReviewImpacts } = require('./lib/newsImpactLearning');
const { recordDailyRanking, getSectorRankReminder, backfillSeed, SEED_DAYS } = require('./lib/sectorRankHistory');
// 20260823t：行业板块拥挤度（板块成交额 ÷ 全市场成交额，当日/本周/本月前五）
const { recordDaily: recordSectorCrowding, getCrowding: getSectorCrowding, backfillHistory: backfillSectorCrowding, needsBackfill: sectorCrowdingNeedsBackfill } = require('./lib/sectorCrowding');
const { getIndustryIndexHistory } = require('./lib/industryIndexHistory');
const { fetchValuationTTM } = require('./lib/eastmoneyValuation');
const { getSectorCapitalFlow } = require('./lib/sectorCapitalFlow'); // 20260827g：行业板块资金流向（主力净流入/流出前五 + 近5日最大）
const hotTopics = require('./lib/hotTopics'); // 20260827c：个股近期热点（AI 联网，异动归因/网络热议）
const homeHotTopics = require('./lib/homeHotTopics'); // 20260827f：首页最热股票话题（同花顺/雪球/东方财富 AI 联网聚合）
const { getGlobalSentiment, interpretReport, getFundIndustryMatrix } = require('./lib/cnscraperAdapter');
const mx = require('./lib/miaoxiang');
const { augmentStock, analyzeAspects, analyzeProducts, analyzeCompany, analyzeSupplyChain, analyzeShareholdersAI, analyzeMarketOverview, analyzeIndustryIndex, analyzeResearchReports, analyzeAnnouncements, analyzeEarningsReport, analyzeValuation, readIndustryIndexCache, loadConfig, saveConfig, publicConfig, readCache, readEarningsCache } = require('./lib/aiAugment');
const docStore = require('./lib/docStore');
const reportSync = require('./lib/reportSync'); // 20260821f：财报事件→资料库自动同步
// 20260823p：全市场情绪指数 + 市场情绪拐点检测（启发式检测器 + 自适应学习）
const MSI = require('./lib/marketSentimentIndex');
const { getTurningPointState, labelAndLearn } = require('./lib/sentimentTurningPoint');
// 本地 SQLite 数据层（node:sqlite，零额外依赖）：分红时序 / 标量五要素 / 分析快照，支撑三规则落地
const db = require('./lib/db');
// 20260903f 降费：本地事实库（研报/公告/概况/主营预下载，供不联网模型做纯推理）
const factStore = require('./lib/factStore');
// 20260906 路由拆分（第一阶段）：AI/妙想/行业指数 + 资料库路由移至 routes/，server.js 瘦身
const aiRoutes = require('./routes/aiRoutes');
const docsRoutes = require('./routes/docsRoutes');
// Python 解释器探测器移至 lib/pyRuntime.js（AI 行业指数 / 研报下载 / 板块拥挤度回补共用）
const { findPython } = require('./lib/pyRuntime');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json({ limit: '50mb' }));

// 行情/分析类接口禁用浏览器缓存，确保每次打开/刷新都拿到最新股价与估值
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// 入口 HTML 强制带版本号重定向：旧服务器曾允许缓存 index.html，浏览器可能一直用旧副本。
// 每次访问 / 或 /index.html 都重定向到带 ?v= 的版本，确保一定拉取最新前端（无需用户手动硬刷新）。
const APP_VERSION = '20260906a';
app.use((req, res, next) => {
  if ((req.path === '/' || req.path === '/index.html') && req.query.v !== APP_VERSION) {
    return res.redirect(`/index.html?v=${APP_VERSION}`);
  }
  next();
});

// 关键前端资源：强制 ?v= 与 APP_VERSION 一致，避免浏览器沿用旧版本
// 用户反复反馈「页面像旧版数据」时，多数是因为老 URL 命中 etag 304 后还返回缓存的旧 JS。
// 这里主动 redirect 到带正确版本号的 URL，配合 Cache-Control: no-store 一起兜底。
const FRONTEND_BUST_FILES = new Set(['/js/app.js', '/css/style.css']);
app.use((req, res, next) => {
  if (FRONTEND_BUST_FILES.has(req.path)) {
    const v = req.query.v;
    if (v !== APP_VERSION) {
      const u = new URL(req.originalUrl, 'http://x');
      u.searchParams.set('v', APP_VERSION);
      return res.redirect(302, u.pathname + '?' + u.searchParams.toString());
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // JS/CSS/HTML 文件禁用缓存，确保前端代码更新后浏览器一定重新获取
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));


// ---- API Routes ----

// Search stocks
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const results = await searchStocks(q);
    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get quote
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const quote = await getQuote(req.params.symbol);
    if (!quote) return res.status(404).json({ error: 'Stock not found' });
    res.json(quote);
  } catch (err) {
    console.error('Quote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get history
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const range = req.query.range || '1y';
    const history = await getHistory(req.params.symbol, range);
    res.json(history);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 60分钟 K线 + 技术指标（东财 klt=60，供中栏「60分钟」周期切换使用）
app.get('/api/history60/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const count = Math.min(parseInt(req.query.count) || 400, 800);
    const history = await getHistoryPeriod(symbol, '60m', count);
    const technical = history.length >= 30 ? technicalAnalysis(history) : null;
    res.json({ success: history.length > 0, symbol, history, technical });
  } catch (err) {
    console.error('History60 error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 价格行为趋势推演（技术面页/短期判断/长期判断共用：10年日K重采样周/月线 + 60分钟K线，本地计算零LLM成本）
// 20260905g：缓存与计算下沉到 lib/priceActionHub 唯一出口，与短期/长期判断共用同一份快照（指标级单源）
app.get('/api/price-action/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const force = req.query.refresh === '1' || req.query.force === '1';
    const data = await getPriceActionSnapshot(symbol, { force });
    if (!data || data.error) {
      return res.json({ success: false, error: (data && data.error) || '价格行为推演失败' });
    }
    res.json({ success: true, symbol, ...data });
  } catch (err) {
    console.error('PriceAction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 分时行情（腾讯分钟线，仅 A 股/港股/美股可用，供中栏「分时」周期切换使用）
app.get('/api/minute/:symbol', async (req, res) => {
  try {
    const info = detectMarket(req.params.symbol);
    const { minutes, prevClose } = await fetchTencentMinutes(info.tencentCode);
    res.json({ success: true, symbol: req.params.symbol, minutes, prevClose });
  } catch (err) {
    console.error('Minute error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get news
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const name = req.query.name || '';
    const news = await getNews(req.params.symbol, name);
    res.json(news);
  } catch (err) {
    console.error('News error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 今日财经热点（东方财富 7×24 快讯，首页展示；?refresh=1 强制刷新缓存）
app.get('/api/hot-news', async (req, res) => {
  try {
    const data = await getHotNews(req.query.refresh === '1');
    // 新闻 → 行业板块影响识别（标注受影响的板块 + 热门个股 + 涨跌方向），并记录到自学习库
    if (data && Array.isArray(data.items)) {
      data.items = annotateNewsImpact(data.items);
      for (const n of data.items) {
        if (n.impact && n.impact.sector) {
          recordImpact(n.title, n.impact.sector, n.impact.direction);
        }
      }
      data.impactLearning = getNewsImpactLearningState();
    }
    res.json(data);
  } catch (err) {
    console.error('Hot news error:', err);
    res.status(500).json({ source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], error: err.message });
  }
});

// 首页「今日最热股票投资话题」（AI 联网聚合同花顺/雪球/东方财富，?refresh=1 强制刷新缓存）
app.get('/api/home-hot-topics', async (req, res) => {
  try {
    const data = await homeHotTopics.getHomeHotTopics(req.query.refresh === '1');
    res.json(data);
  } catch (err) {
    console.error('Home hot topics error:', err);
    res.status(500).json({ ok: false, updated: new Date().toISOString(), date: new Date().toISOString().slice(0, 10), sources: [], topics: [], summary: '聚合失败：' + err.message, error: err.message });
  }
});

// 新闻影响判断 · 人工更正（自学习）：反馈某条判断是否正确，并可纠正板块/方向
app.post('/api/news-impact/correct', async (req, res) => {
  try {
    const { id, correct, correctedSector, correctedDirection } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: '缺少 id' });
    const rec = correctImpact(String(id), !!correct, correctedSector || null, correctedDirection || null);
    if (!rec) return res.status(404).json({ success: false, error: '未找到对应记录' });
    res.json({ success: true, record: rec, learning: getNewsImpactLearningState() });
  } catch (err) {
    console.error('[NewsImpact] correct error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 板块涨跌幅前五 · 近一周滚动统计提醒
app.get('/api/sector-rank-reminder', async (req, res) => {
  try {
    res.json({ success: true, ...getSectorRankReminder() });
  } catch (err) {
    console.error('[SectorRankReminder] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页「每日宏观 & 政策」采集（按自然日缓存，每日自动采集一次）
app.get('/api/macro-news', async (req, res) => {
  try {
    const data = await getMacroNews(req.query.refresh === '1');
    res.json(data);
  } catch (err) {
    console.error('Macro news error:', err);
    res.status(500).json({ source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], byCategory: {}, order: [], total: 0, error: err.message });
  }
});

// 首页「重要经济数据」（结构化指标 + 解读，每日缓存）
app.get('/api/macro-data', async (req, res) => {
  try {
    const data = await getMacroIndicators(req.query.refresh === '1');
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Macro data error:', err);
    res.status(500).json({ success: false, error: err.message, indicators: [], date: new Date().toISOString().slice(0, 10), available: 0, total: 5 });
  }
});

// 首页「基金重仓行业配置矩阵」（季度行业配置比例，支持用户导入更新）
app.get('/api/market-rank', async (req, res) => {
  try {
    const data = await getMarketRank({ force: req.query.refresh === '1' });
    res.json(data);
  } catch (err) {
    console.error('Market rank error:', err);
    res.status(500).json({ updated: new Date().toISOString(), title: '行业配置矩阵', available: false, reason: err.message, quarters: [], sectors: [], note: '数据获取失败。' });
  }
});
app.post('/api/market-rank', (req, res) => {
  try {
    const { updateMarketRank } = require('./lib/marketRank');
    const input = req.body && (req.body.matrix || req.body.csv || req.body);
    const saved = updateMarketRank(input);
    res.json({ success: true, saved });
  } catch (err) {
    console.error('Market rank update error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});


// ---- 当日个股涨跌判断（透明加权打分 + 准确率统计）----

// 全部判断记录列表（供独立「准确率核对」页使用）
//   ?settle=1 时先触发全量结算（拉取各股 K 线，可能较慢）再返回最新快照
//   必须注册在 /:symbol 路由之前，否则 "records" 会被当作 symbol 参数匹配
app.get('/api/sameday-judgment/records', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim() : '';
    if (symbol) {
      // 个股视图：仅结算该股 + 仅返回该股记录与准确率
      if (req.query.settle === '1') await settleSymbol(symbol);
      const records = filterBySymbol(getAllRecords(), symbol);
      const accuracy = computeAccuracy(records);
      const name = records.length ? (records[0].name || symbol) : symbol;
      res.json({ success: true, records, accuracy, learning: getLearningState(symbol), count: records.length, symbolScope: symbol, symbolName: name });
    } else {
      if (req.query.settle === '1') await settleAll();
      const records = getAllRecords();
      const accuracy = computeAccuracy(records);
      res.json({ success: true, records, accuracy, learning: getLearningState(), count: records.length, symbolScope: null });
    }
  } catch (err) {
    console.error('[SameDayJudgment] records error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 自我进化 / 错误学习状态（因子命中率、权重演进、错误归因）
// 固定路径，必须注册在 /:symbol 之前
// ?symbol=xxx 时只返回该股票的最近错误归因，避免跨股展示。
app.get('/api/sameday-judgment/learning', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim() : '';
    res.json({ success: true, learning: getLearningState(symbol || undefined) });
  } catch (err) {
    console.error('[SameDayJudgment] learning error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Part B：弱关联关联度 / 持续性经验库状态（调试透明用）
app.get('/api/relevance-learning', async (req, res) => {
  try {
    res.json({ success: true, state: getRelevanceLearningState() });
  } catch (err) {
    console.error('[RelevanceLearning] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sameday-judgment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getJudgmentWithAccuracy(symbol, name, industry, force);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SameDayJudgment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 全量结算历史判断并返回准确率（按需触发，可能较慢：需拉取各股K线）
app.post('/api/sameday-judgment/settle', async (req, res) => {
  try {
    const acc = await settleAll();
    res.json({ success: true, accuracy: acc });
  } catch (err) {
    console.error('[SameDayJudgment] settle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 长期行情判断（中长期走势 / 价值取向，不核算准确率，每次打开自动 AI 联网更新）----
app.get('/api/long-term-judgment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getLongTermJudgment(symbol, name, force);
    res.json({ success: true, judgment: result });
  } catch (err) {
    console.error('[LongTermJudgment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comprehensive analysis
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const range = req.query.range || '1y';
    const name = req.query.name || '';

    console.log(`[Analysis] Fetching data for ${symbol}...`);

    // Fetch quote, history, and company profile in parallel
    const [quoteResult, historyResult, profileResult] = await Promise.allSettled([
      getQuote(symbol),
      getHistory(symbol, range),
      getCompanyProfile(symbol)
    ]);

    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const history = historyResult.status === 'fulfilled' ? historyResult.value : [];
    const companyProfile = profileResult.status === 'fulfilled' ? profileResult.value : null;

    if (!quote && history.length === 0) {
      return res.status(404).json({ error: '无法获取该股票的数据，请检查代码是否正确' });
    }

    console.log(`[Analysis] Quote: ${quote ? 'OK' : 'N/A'}, History: ${history.length} bars, Profile: ${companyProfile ? 'OK' : 'N/A'}`);

    // Technical analysis
    const technical = technicalAnalysis(history);

    // Classify company type for differentiated fundamental analysis
    const companyType = quote ? classifyCompanyType(symbol, name || quote?.name, quote, { income: [], balance: [], cashflow: [] }, null, []) : null;
    console.log(`[Analysis] Company type: ${companyType?.typeName || 'N/A'} (${companyType?.type || 'N/A'})`);

    // Fundamental analysis (with company type differentiation)
    const fundamental = quote ? fundamentalAnalysis(quote, companyType) : { error: 'No fundamental data' };

    // Market overview
    const info = detectMarket(symbol);

    // 关键财务指标对标：历史百分位 + 行业均值（先算，作为全站统一的「行业均值」基准）
    let comparison = null;
    if (quote && info.market === 'CN') {
      try {
        comparison = await buildFundamentalComparison(symbol, quote);
      } catch (e) {
        console.error('[Analysis] fundamental comparison failed:', e.message);
      }
    }

    // 利好/利空 信号标记：统一复用 comparison.industryAvg 作为「行业均值」基准，
    // 确保概览信号卡与基本面卡的「行业均值」数值完全一致（单一数据源，杜绝两套基准）。
    const industryAvg = (comparison && comparison.industryAvg) ? comparison.industryAvg : null;
    const signals = quote ? evaluateSignals(quote.fundamentals, companyType, industryAvg) : { signals: [], compareBasis: '行业均值' };

    const result = {
      symbol,
      name: quote?.name || name || symbol,
      market: info.market,
      exchange: info.exchange,
      quote,
      history,
      technical,
      fundamental,
      signals,
      comparison,
      companyType: companyType ? { type: companyType.type, typeName: companyType.typeName, typeIcon: companyType.typeIcon, description: companyType.description, focusText: companyType.focusText } : null,
      companyProfile,
      timestamp: new Date().toISOString()
    };

    res.json(result);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 股东分析（issue5）：股东户数走势 + 十大股东 + 机构持仓数量变化
app.get('/api/shareholders/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    console.log(`[Shareholders] Fetching for ${symbol}...`);
    const data = await getShareholdersData(symbol);
    res.json(data);
  } catch (err) {
    console.error('Shareholders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 公司概况（issue6）：主要产品 / 主要客户 / 企业性质
app.get('/api/company-profile/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    console.log(`[CompanyProfile] Fetching for ${symbol}...`);
    const data = await getCompanyProfile(symbol);
    res.json(data);
  } catch (err) {
    console.error('CompanyProfile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 首页实时大盘概览（issue：大盘指数 / 美国股指 / 热门板块）
app.get('/api/market-overview', async (req, res) => {
  try {
    const data = await getMarketOverview();
    // 按日记录行业板块涨跌幅前五（供近一周滚动统计）
    if (Array.isArray(data.sectorsUp) || Array.isArray(data.sectorsDown)) {
      recordDailyRanking(data.sectorsUp, data.sectorsDown);
      // 首次启用或数据不足时，用当前板块数据回填近 SEED_DAYS 天的种子，
      // 让"出现次数"立即可见；明天起真实数据逐日覆盖种子。
      backfillSeed(data.sectorsUp, data.sectorsDown);
    }
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[MarketOverview] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·大盘估值趋势：上证50 / 沪深300 / 科创50 近5年PE(TTM)趋势
app.get('/api/index-pe-trend', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getIndexPETrend({ force });
    res.json(result);
  } catch (err) {
    console.error('[IndexPETrend] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·大盘技术分析：上证/深证/创业板指 收盘后六步技术面推演（短中期预判）
app.get('/api/market-technical', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const result = await getMarketTechnical({ force });
    res.json(result);
  } catch (err) {
    console.error('[MarketTechnical] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·行业板块拥挤度（当日/本周/本月 前五）：板块成交额 ÷ 全市场成交额 × 100%
app.get('/api/sector-crowding', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const mo = await getMarketOverview();
    // 落盘当日拥挤度（仅在数据日期==今天时写入，避免周末/盘前污染周月统计）
    if (Array.isArray(mo.sectorAll)) {
      recordSectorCrowding(mo.sectorAll, mo.sectorDate);
    }
    // 历史回填：刷新时同步拉取（前端有 loading 提示）；首跑 store 空时后台静默补，不阻塞首页
    const should = refresh || sectorCrowdingNeedsBackfill();
    if (should) {
      const run = () => backfillSectorCrowding(21, findPython())
        .then(r => console.log('[SectorCrowding] backfill done:', JSON.stringify(r)))
        .catch(e => console.error('[SectorCrowding] backfill failed:', e.message));
      if (refresh) await run(); else run();
    }
    const result = getSectorCrowding(mo.sectorAll, mo.sectorDate);
    res.json({ success: true, ...result, backfilled: Boolean(refresh && should) });
  } catch (err) {
    console.error('[SectorCrowding] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 首页·行业板块资金流向（主力净流入/流出前五 + 近5日最大流入/流出板块）
app.get('/api/sector-capital-flow', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const data = await getSectorCapitalFlow(refresh);
    res.json({ success: data.ok !== false, ...data });
  } catch (err) {
    console.error('[SectorCapitalFlow] route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 市场情绪因子原始数据（量化广度 + 杠杆情绪 + 文本舆情；供调试与透明展示）
app.get('/api/sentiment/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const data = await getMarketSentiment(symbol, name);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Sentiment] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 行业板块走势原始数据（个股所属行业板块整体涨跌；供调试与透明展示）
app.get('/api/sector-trend/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const data = await getSectorTrend(symbol, name, industry);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[SectorTrend] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 基金重仓行业配置矩阵（头部基金最新季报前 10 重仓股 → 行业 × 基金 矩阵）
// 数据源：akshare 混合型基金按近 1 年业绩头部 N 只 + industryAnalysis 股票→行业映射
app.get('/api/fund-industry-matrix', async (req, res) => {
  try {
    const topN = Math.max(1, Math.min(parseInt(req.query.topN || '15', 10) || 15, 30));
    const data = await getFundIndustryMatrix({ topN });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[FundMatrix] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 板块涨跌停占比原始数据（板块内涨停/跌停家数占比；供调试与透明展示）
app.get('/api/sector-limit/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const industry = req.query.industry || '';
    const data = await getSectorLimitStats(symbol, name, industry);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[SectorLimit] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 全市场情绪拐点（启发式检测器 + 自适应学习）----
// 首页全局预警条用：全市场级，不依赖个股
app.get('/api/sentiment-turning-point', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.force === '1';
    const state = await getTurningPointState({ refresh: force });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[SentimentTP] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 个股页情绪拐点面板用：额外给出该股对全市场情绪的敏感度（beta）
app.get('/api/sentiment-turning-point/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const force = req.query.refresh === '1' || req.query.force === '1';
    const state = await getTurningPointState({ symbol, name, refresh: force });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[SentimentTP] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 调试/图表用：当前实时指数 + 时间序列（含近似回填）
app.get('/api/sentiment-index', async (req, res) => {
  try {
    const live = await MSI.computeIndex({});
    const { real, full, backfilled } = MSI.getSeries({ allowBackfill: true });
    res.json({ success: true, live, real, full, backfilled });
  } catch (err) {
    console.error('[SentimentIndex] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 自选股：服务端持久化（真源移出浏览器 localStorage，避免更新/重启周期中偶发丢失）----
const WATCHLIST_FILE = path.join(__dirname, 'data', 'watchlist.json');

function readWatchlistFile() {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeWatchlistFile(list) {
  try {
    fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[Watchlist] write failed:', e.message);
    return false;
  }
}

app.get('/api/watchlist', (req, res) => {
  res.json({ success: true, list: readWatchlistFile() });
});

app.put('/api/watchlist', (req, res) => {
  try {
    const body = req.body || {};
    const incoming = Array.isArray(body) ? body : (Array.isArray(body.list) ? body.list : null);
    if (!incoming) return res.status(400).json({ success: false, error: 'body.list 必须是数组' });
    // 仅保留含合法 symbol 的项，并按 symbol 去重
    const seen = new Set();
    const clean = [];
    for (const it of incoming) {
      if (it && typeof it.symbol === 'string' && it.symbol && !seen.has(it.symbol)) {
        seen.add(it.symbol);
        clean.push({
          symbol: it.symbol,
          name: typeof it.name === 'string' ? it.name : '',
          market: typeof it.market === 'string' ? it.market : '',
          addedAt: typeof it.addedAt === 'number' ? it.addedAt : Date.now(),
        });
      }
    }
    if (!writeWatchlistFile(clean)) return res.status(500).json({ success: false, error: '写入失败' });
    res.json({ success: true, list: clean });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 20260906 路由拆分：AI 联网 / 妙想 / 行业指数 / 产品图片等 35 条路由移至 routes/aiRoutes.js
app.use(aiRoutes);

// 个股市值历史走势（亿元，日频），供行业分析页叠加当前股票市值双坐标轴
// 复用 lib/eastmoneyValuation.fetchValuationTTM 的 daily 序列（TOTAL_MARKET_CAP），保证与估值模块同源（规则一）
app.get('/api/stock-market-cap-history/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
    const val = await fetchValuationTTM(symbol);
    if (!val || !Array.isArray(val.daily) || val.daily.length === 0) {
      return res.json({ success: false, error: '无市值历史数据', source: '东方财富TTM', fetchedAt: new Date().toISOString() });
    }
    const data = val.daily
      .filter(d => d.date && d.marketCap > 0)
      .map(d => ({ date: d.date, marketCap: d.marketCap }))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json({
      success: true,
      symbol,
      data,
      unit: '亿元',
      source: '东方财富TTM',
      date: data[data.length - 1].date,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[StockMarketCapHistory] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- 个股近期热点（20260827c 重构：AI 联网，按涨跌幅切异动归因/网络热议） ----------
app.get('/api/hot-topics/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    const name = (req.query && req.query.name) || '';
    const force = !!(req.query && req.query.refresh);
    if (!symbol) return res.status(400).json({ ok: false, error: 'NO_SYMBOL' });
    const state = await hotTopics.getState(symbol, name, force);
    res.json(state);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// Deep analysis (product company analysis - 26 sections)// ---- Deep Analysis 磁盘缓存（避免每次重新抓取/分析）----
function getAnalysisCachePath(symbol) {
  return path.join(__dirname, 'data', 'cache', 'deep-analysis', `${symbol}.json`);
}

function isAnalysisCacheValid(obj) {
  if (!obj || !obj.sections) return false;
  const sec = obj.sections;
  // 核心财务数据为空 = 抓取/分析失败，不应复用缓存（否则图表空白长期冻结）
  if (!Array.isArray(sec.revenueCostData) || sec.revenueCostData.length === 0) return false;
  if (!Array.isArray(sec.marketCapData) || sec.marketCapData.length === 0) return false;
  return true;
}

function readAnalysisCache(symbol) {
  try {
    const p = getAnalysisCachePath(symbol);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 版本门控：缓存由旧版本代码写入（无 appVersion 或版本不符）时视为失效，
      // 强制按新版本重新生成，避免升级后用户仍看到旧结构（如缺失新增字段）。
      if (obj && obj.appVersion === APP_VERSION && isAnalysisCacheValid(obj)) return obj;
      console.log(`[Cache] invalidating ${symbol} (version mismatch or empty core data)`);
    }
  } catch (e) {
    console.error('[Cache] read failed:', e.message);
  }
  return null;
}

function writeAnalysisCache(symbol, result) {
  try {
    if (!isAnalysisCacheValid(result)) {
      console.log(`[Cache] skip writing invalid cache for ${symbol}: core sections empty`);
      return;
    }
    const dir = path.join(__dirname, 'data', 'cache', 'deep-analysis');
    fs.mkdirSync(dir, { recursive: true });
    result.appVersion = APP_VERSION;
    fs.writeFileSync(getAnalysisCachePath(symbol), JSON.stringify(result), 'utf8');
  } catch (e) {
    console.error('[Cache] write failed:', e.message);
  }
}

// 三规则铺开：行情模块「数据一致性 / 数据最新性 / 变化与边际分析」合规数据
app.get('/api/quote-rules/:symbol', async (req, res) => {
  try {
    const { getQuoteHub, beginSnapshot } = require('./lib/quoteHub');
    const hub = await getQuoteHub(req.params.symbol);
    if (!hub || !hub.ok) {
      return res.json({ success: false, error: (hub && hub.error) || '未获取到行情数据', note: (hub && hub.note) || '' });
    }
    // 规则一③：返回即冻结快照，保证本次响应内数据一致
    res.json({ success: true, ...beginSnapshot(hub) });
  } catch (err) {
    console.error('[QuoteRules] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 三规则样板：估值模块「数据一致性 / 数据最新性 / 变化与边际分析」合规数据
// 轻量端点，便于快速核验规则落地情况（不必等待整套深度分析）
app.get('/api/valuation-rules/:symbol', async (req, res) => {
  try {
    const { getValuationHub, beginSnapshot } = require('./lib/valuationHub');
    const hub = await getValuationHub(req.params.symbol);
    if (!hub || !hub.ok) {
      return res.json({ success: false, error: (hub && hub.error) || '未获取到估值数据', note: (hub && hub.note) || '' });
    }
    // 规则一③：返回即冻结快照，保证本次响应内数据一致
    res.json({ success: true, ...beginSnapshot(hub) });
  } catch (err) {
    console.error('[ValuationRules] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- 本地数据库（SQLite）查询接口 ----------------
// 健康检查：库状态 + 各表行数
app.get('/api/db/health', (req, res) => {
  try {
    res.json({ success: true, ...db.getDbInfo() });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 分红时序（近 N 年每次派息）：直接读本地 SQLite，含 变化率 + 边际变化（规则三）。
// 若本地为空则先按当前代码补抓一次（仅当请求带 refresh=1 或库为空时），否则纯读库不联网。
app.get('/api/db/dividend-series/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!symbol) return res.json({ success: false, error: 'invalid symbol' });
    const existing = db.getSeries(symbol, 'dividend_per_share');
    // 库为空且明确要求刷新时，按单一权威源补抓一次（保持规则一·单源）
    if ((!existing.length && req.query.refresh !== '0') || req.query.refresh === '1') {
      try {
        const rows = await fetchDividends(symbol);
        persistDividends(symbol, symbol, rows);
      } catch (e) {
        console.error('[DB] dividend backfill failed:', e.message);
      }
    }
    const series = loadDividendSeries(symbol);
    res.json({
      success: true,
      symbol,
      count: series.length,
      source: series[0]?.source || null,
      note: '数据来自本地 SQLite（eastmoney:RPT_SHAREBONUS_DET）。changePct=当期变化率；marginal=边际变化（变化的变化）；direction=up/down/flat',
      series,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 最近一次分析快照（分析期数据锁定）
app.get('/api/db/snapshot/:symbol', (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const snap = db.getLatestSnapshot(symbol);
    if (!snap) return res.json({ success: true, symbol, found: false });
    // payload 可能很大，仅回传概要 + 关键标量，避免接口臃肿
    const p = snap.payload || {};
    res.json({
      success: true,
      symbol,
      found: true,
      snapshotId: snap.snapshot_id,
      range: snap.range,
      createdAt: snap.created_at,
      symbolInPayload: p.symbol,
      sectionsKeys: p.sections ? Object.keys(p.sections) : [],
      timestamp: p.timestamp,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 某股票全部标量数据点（估值/价格等），附 isFresh 新鲜度（规则二 TTL 判定）
app.get('/api/db/datapoints/:symbol', (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const rows = db.getDataPoints(symbol);
    res.json({
      success: true,
      symbol,
      count: rows.length,
      note: 'isFresh=true 表示在 TTL 有效期内；false 表示已过期需重拉。value 为数值，value_text 为非数值型。',
      points: rows.map((r) => ({
        key: r.key,
        value: r.value,
        valueText: r.value_text,
        asOf: r.as_of,
        source: r.source,
        fetchedAt: r.fetched_at,
        validUntil: r.valid_until,
        isFresh: r.isFresh,
        extra: r.extra,
      })),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ---------------- 深度分析 ----------------
app.get('/api/deep-analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    // 标准化为数字股票代码（如 '601318'），用于严格按股票过滤本地资料库
    let stockCode = symbol;
    try {
      const info = detectMarket(symbol);
      stockCode = info.tencentCode.replace(/^(sh|sz)/, '');
    } catch (e) { /* 保底使用原始 symbol */ }

    console.log(`[DeepAnalysis] Starting for ${symbol} (refresh=${forceRefresh})...`);

    // 命中磁盘缓存且非强制刷新：直接返回，跳过耗时的重新分析
    if (!forceRefresh) {
      const cached = readAnalysisCache(symbol);
      if (cached) {
        console.log(`[DeepAnalysis] Serving cached result for ${symbol}`);
        // 本地资料库每请求实时读取，确保只显示「当前股票」自己的文档且反映最新上传
        cached.localDocuments = getLocalDocuments(stockCode);
        // AI 解读实时覆盖（20260902l）：深度分析缓存里的 earningsReport/researchAI/announcementAI
        // 是生成时的快照；用户点「重新解读」后新结果只写入 ai_cache，此处需同步最新版本，
        // 否则下次打开页面仍显示旧解读。缺 ai_cache 时保留原快照。
        if (cached.sections) {
          try { const v = readCache(symbol, '_earnings'); if (v && v.summary) cached.sections.earningsReport = v; } catch {}
          try { const v = readCache(symbol, '_research'); if (v && v.summary) cached.sections.researchAI = v; } catch {}
          try { const v = readCache(symbol, '_announcements'); if (v && v.summary) cached.sections.announcementAI = v; } catch {}
        }
        return res.json({ ...cached, fromCache: true });
      }
    }

    // Fetch quote and history in parallel
    const [quote, history] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, 'daily').catch(() => []),
    ]);

    if (!quote) {
      return res.status(404).json({ error: '无法获取股票行情数据' });
    }

    // 总超时兜底：避免任何外部接口无响应时前端永久转圈（内部各请求已有 10-15s 超时；可选抓取另有 8s 单独超时）
    const result = await Promise.race([
      deepAnalysis(symbol, name || quote.name, quote, history),
      new Promise((_, reject) => setTimeout(() => reject(new Error('深度分析超时（外部数据接口响应过慢，请稍后重试）')), 55000)),
    ]);

    result.cachedAt = Date.now();
    result.fromCache = false;
    writeAnalysisCache(symbol, result);

    // 本地资料库实时读取，确保只显示「当前股票」自己的文档
    result.localDocuments = getLocalDocuments(stockCode);

    res.json(result);
  } catch (err) {
    console.error('Deep analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Investment Journal Verification API ----
app.post('/api/journal/verify', async (req, res) => {
  try {
    const { title, content, stockCode, stockName, type } = req.body;
    
    console.log(`[Journal] Verifying note: "${title}" for ${stockName || stockCode}`);
    
    // Analyze the note content for verifiable claims
    const claims = extractClaims(content, title);
    const results = [];
    let totalProbability = 50; // Start at neutral
    let verifiedCount = 0;
    let partialCount = 0;
    let unverifiedCount = 0;
    
    // Try to verify each claim against available data
    if (stockCode) {
      try {
        const info = detectMarket(stockCode);
        if (info.market === 'CN') {
          const code = info.tencentCode.replace(/^(sh|sz)/, m => m.toUpperCase());
          const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
          
          // Fetch financial data and current quote for verification
          const { fetchFinancialData, fetchDividends } = require('./lib/deepAnalysis');
          const needDividends = claims.some(c => c.type === 'no_dividend');
          const [finData, quoteData, dividendRows] = await Promise.all([
            fetchFinancialData(emCode),
            getQuote(stockCode).catch(() => null),
            needDividends ? fetchDividends(emCode).catch(() => []) : Promise.resolve(null),
          ]);
          
          if (finData.income && finData.income.length > 0) {
            // Verify each claim
            for (const claim of claims) {
              const result = verifyClaimAgainstData(claim, finData, stockName || stockCode, quoteData, dividendRows);
              results.push(result);
              
              if (result.status === 'verified') {
                verifiedCount++;
                totalProbability += 10;
              } else if (result.status === 'partially_verified') {
                partialCount++;
                totalProbability += 3;
              } else if (result.status === 'unverified') {
                unverifiedCount++;
                totalProbability -= 5;
              }
            }
          }
        }
      } catch (e) {
        console.error('[Journal] Data fetch error:', e.message);
      }
    }
    
    // Analyze claim types for general probability assessment
    const typeBonus = analyzeClaimTypes(claims, type);
    totalProbability += typeBonus;
    
    // Clamp probability
    totalProbability = Math.max(5, Math.min(95, totalProbability));
    
    // Determine overall status
    // 全部判断点均验证通过（≥1个且无部分/未验证）→ 直接判 verified：
    // 事实类声明（如"中报不分红"）经分红数据比对属实，不应因概率公式初始值偏低被压成"部分验证"
    const allVerified = results.length > 0 && verifiedCount === claims.length && partialCount === 0 && unverifiedCount === 0;
    let status;
    if (totalProbability >= 70 || allVerified) status = 'verified';
    else if (totalProbability >= 40) status = 'partially_verified';
    else status = 'unverified';
    
    // Generate result text
    const resultText = generateVerificationText(status, totalProbability, results, claims);
    
    res.json({
      status,
      probability: Math.round(totalProbability),
      result: resultText,
      details: results.length > 0 ? results.map(r => `[${r.status}] ${r.claim}: ${r.evidence}`).join('\n') : null,
      claimsAnalyzed: claims.length,
      verifiedCount,
      partialCount,
      unverifiedCount,
    });
    
  } catch (err) {
    console.error('Journal verify error:', err);
    res.status(500).json({ error: err.message, status: 'error', probability: 0, result: '验证失败' });
  }
});

// Extract verifiable claims from note text
function extractClaims(content, title) {
  const text = `${title} ${content}`;
  const claims = [];

  // PE-related claims (handles 约, 低于, 大约, etc.)
  const peMatches = text.match(/PE[约低于<大约]?\s*([\d.]+)\s*倍?|市盈率[约低于大约]?\s*([\d.]+)\s*倍?|PE[高于>]?\s*([\d.]+)/gi);
  if (peMatches) {
    for (const m of peMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'pe', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // PB-related claims
  const pbMatches = text.match(/PB[约低于<大约]?\s*([\d.]+)\s*倍?|市净率[约低于大约]?\s*([\d.]+)\s*倍?|PB[高于>]?\s*([\d.]+)/gi);
  if (pbMatches) {
    for (const m of pbMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'pb', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Growth rate claims (handles 超过, 达, 约, etc.)
  const growthMatches = text.match(/增长[率]?\s*(?:超过|约|达|大于|约达)?\s*(\d+)%|增速\s*(?:超过|约|达|大于)?\s*(\d+)%|growth\s*(\d+)%/gi);
  if (growthMatches) {
    for (const m of growthMatches) {
      const num = m.match(/\d+/);
      if (num) claims.push({ type: 'growth', text: m, value: parseInt(num[0]), raw: m });
    }
  }
  
  // Price-related claims (handles 约, 左右, etc.)
  const priceMatches = text.match(/价格?\s*约?\s*(\d+\.?\d*)\s*[元块左右]|股价\s*约?\s*(\d+\.?\d*)|价格?\s*(\d+\.?\d*)\s*[元块]/gi);
  if (priceMatches) {
    for (const m of priceMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'price', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Dividend yield claims
  const divMatches = text.match(/股息率\s*[约]?\s*(\d+\.?\d*)%|分红率\s*[约]?\s*(\d+\.?\d*)%|dividend\s*(\d+\.?\d*)%/i);
  if (divMatches) {
    const num = divMatches[0].match(/[\d.]+/);
    if (num) claims.push({ type: 'dividend_yield', text: divMatches[0], value: parseFloat(num[0]), raw: divMatches[0] });
  }
  
  // Net profit margin claims (handles 维持在, 约, etc.)
  const marginMatches = text.match(/净利润率\s*(?:维持在|约|达|超过)?\s*(\d+\.?\d*)%|净利率\s*(?:维持在|约|达)?\s*(\d+\.?\d*)%|利润率\s*(?:维持在|约|达|超过)?\s*(\d+\.?\d*)%/gi);
  if (marginMatches) {
    for (const m of marginMatches) {
      const num = m.match(/[\d.]+/);
      if (num) claims.push({ type: 'margin', text: m, value: parseFloat(num[0]), raw: m });
    }
  }
  
  // Expected return claims
  const returnMatches = text.match(/涨幅\s*[可达约]?\s*(\d+)%|收益\s*[可达约]?\s*(\d+)%|回报\s*[可达约]?\s*(\d+)%/gi);
  if (returnMatches) {
    for (const m of returnMatches) {
      const num = m.match(/\d+/);
      if (num) claims.push({ type: 'expected_return', text: m, value: parseInt(num[0]), raw: m });
    }
  }

  // No-dividend claims (e.g. "2026年中报不分红" / "不派发现金红利" / "无利润分配方案") —
  // 事实性声明，可比对东财分红送配表精确验证
  const noDivMatches = text.match(/(?:不|无|未|没有)[^。，；！\n]{0,12}?(?:分红|派息|派发|股息|红利|利润分配)/g);
  if (noDivMatches) {
    const yearM = text.match(/(20\d{2})\s*年/);
    const stageM = text.match(/中报|中期|半年报|一季报|一季|三季报|三季|年报|年度/);
    claims.push({
      type: 'no_dividend',
      text: noDivMatches[0],
      value: null,
      raw: `${yearM ? yearM[1] + '年' : ''}${stageM ? stageM[0] : ''}${noDivMatches[0]}`,
      year: yearM ? yearM[1] : null,
      stage: stageM ? stageM[0] : null,
    });
  }

  // General qualitative claims (always present if no quantitative claims)
  if (claims.length === 0) {
    claims.push({ type: 'qualitative', text: text.substring(0, 100), value: null, raw: '定性判断' });
  }

  return claims;
}

// Verify a claim against financial data
function verifyClaimAgainstData(claim, finData, stockName, quote, dividends) {
  const { income, balance } = finData;
  const latest = income[income.length - 1];
  if (!latest) return { claim: claim.raw, status: 'unverified', evidence: '无法获取财务数据' };
  
  const revenue = parseFloat(latest.TOTAL_OPERATE_INCOME || latest.YYSR || 0);
  const netProfit = parseFloat(latest.PARENT_NETPROFIT || latest.NETPROFIT || latest.JLR || 0);
  const price = quote?.price || 0;
  const pe = quote?.pe || quote?.fundamentals?.pe || 0;
  const pb = quote?.pb || quote?.fundamentals?.pb || 0;
  const totalValue = quote?.totalValue || 0; // 总市值(亿)
  
  switch (claim.type) {
    case 'pe': {
      if (pe > 0) {
        const diff = Math.abs(pe - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 10) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}接近，验证通过。` };
        } else if (pctDiff < 30) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前PE为${pe}，与判断${claim.value}偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}最新净利润${(netProfit/1e8).toFixed(1)}亿，PE判断需要实时市值数据配合验证。` };
    }
    case 'pb': {
      if (pb > 0) {
        const diff = Math.abs(pb - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 10) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}接近，验证通过。` };
        } else if (pctDiff < 30) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前PB为${pb}，与判断${claim.value}偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      const latestBal = balance[balance.length - 1];
      const netAssets = parseFloat(latestBal?.TOTAL_PARENT_EQUITY || latestBal?.TOTAL_EQUITY || 0);
      return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}最新归母净资产${(netAssets/1e8).toFixed(1)}亿，PB判断需要实时市值数据配合验证。` };
    }
    case 'growth': {
      // Verify growth rate against historical data
      if (income.length >= 2) {
        const prev = income[income.length - 2];
        const prevRevenue = parseFloat(prev.TOTAL_OPERATE_INCOME || prev.YYSR || 0);
        const currRevenue = revenue;
        const actualGrowth = prevRevenue > 0 ? ((currRevenue / prevRevenue - 1) * 100) : 0;
        const claimedGrowth = claim.value;
        const diff = Math.abs(actualGrowth - claimedGrowth);
        
        if (diff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%接近，验证通过。` };
        } else if (diff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%有一定偏差。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}实际营收增速${actualGrowth.toFixed(1)}%，与判断${claimedGrowth}%偏差较大。` };
        }
      }
      return { claim: claim.raw, status: 'unverified', evidence: '历史数据不足' };
    }
    case 'price': {
      if (price > 0) {
        const diff = Math.abs(price - claim.value);
        const pctDiff = (diff / claim.value * 100);
        if (pctDiff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元接近，验证通过。` };
        } else if (pctDiff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元有一定偏差(偏差${pctDiff.toFixed(0)}%)。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}当前股价${price}元，与判断${claim.value}元偏差较大(偏差${pctDiff.toFixed(0)}%)。` };
        }
      }
      return { claim: claim.raw, status: 'partially_verified', evidence: '价格判断需结合实时行情验证，建议查看当前股价。' };
    }
    case 'no_dividend': {
      if (!Array.isArray(dividends)) {
        return { claim: claim.raw, status: 'partially_verified', evidence: '分红数据获取失败，无法验证分红类判断。' };
      }
      // 报告期映射：中报→06-30，一季报→03-31，三季报→09-30，年报→12-31
      const stageDate = { '中报': '-06-30', '中期': '-06-30', '半年报': '-06-30', '半年': '-06-30',
                          '一季报': '-03-31', '一季': '-03-31', '三季报': '-09-30', '三季': '-09-30',
                          '年报': '-12-31', '年度': '-12-31' };
      // 未写年份/期数时：用最新一期财报报告期兜底（该报告期已披露，验证结果即代表当前事实）
      const fallbackDate = (latest.REPORT_DATE || latest.REPORTDATE || '').slice(0, 10);
      let year = claim.year, stage = claim.stage;
      if (!year || !stage) {
        if (!fallbackDate) {
          return { claim: claim.raw, status: 'partially_verified', evidence: '判断未注明报告期，且无法确定最新报告期，需人工核对。' };
        }
        year = fallbackDate.slice(0, 4);
        stage = ({ '03-31': '一季报', '06-30': '中报', '09-30': '三季报', '12-31': '年报' })[fallbackDate.slice(5)] || '年报';
      }
      const targetDate = `${year}${stageDate[stage] || '-12-31'}`;
      const rec = dividends.find(d => String(d.reportDate || '').slice(0, 10) === targetDate);
      if (rec && rec.dividendPerShare > 0) {
        return { claim: claim.raw, status: 'unverified', evidence: `东财分红送配数据显示${year}年${stage}有分红方案（${rec.plan || `每10股派${(rec.dividendPerShare * 10).toFixed(2)}元`}），"不分红"判断与事实不符。` };
      }
      if (rec) {
        // 有分红记录但金额未定（预披露/预案阶段）：公司已明确分红意向，"不分红"与事实不符
        return { claim: claim.raw, status: 'unverified', evidence: `东财分红送配数据显示${year}年${stage}已有分红安排（${rec.plan || '方案'}，进度：${rec.progress || '预案'}），"不分红"判断与事实不符。` };
      }
      const yearHasAnyDiv = dividends.some(d => String(d.reportDate || '').startsWith(year));
      const base = `东财分红送配数据中${year}年${stage}（报告期${targetDate}）无分红记录`;
      if (yearHasAnyDiv || !claim.year) {
        return { claim: claim.raw, status: 'verified', evidence: `${base}，"不分红"判断属实。` };
      }
      return { claim: claim.raw, status: 'verified', evidence: `${base}，且${year}年全年在东财分红表中也无任何分红方案，"不分红"判断属实。` };
    }
    case 'dividend_yield': {
      return { claim: claim.raw, status: 'partially_verified', evidence: '股息率判断需结合分红方案和当前股价验证。' };
    }
    case 'margin': {
      // Verify net profit margin
      if (revenue > 0 && netProfit > 0) {
        const actualMargin = (netProfit / revenue * 100);
        const diff = Math.abs(actualMargin - claim.value);
        if (diff < 5) {
          return { claim: claim.raw, status: 'verified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%接近，验证通过。` };
        } else if (diff < 15) {
          return { claim: claim.raw, status: 'partially_verified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%有一定偏差。` };
        } else {
          return { claim: claim.raw, status: 'unverified', evidence: `${stockName}实际净利率${actualMargin.toFixed(1)}%，与判断${claim.value}%偏差较大。` };
        }
      }
      return { claim: claim.raw, status: 'unverified', evidence: '利润数据不足' };
    }
    case 'expected_return': {
      return { claim: claim.raw, status: 'partially_verified', evidence: '预期收益判断属于预测性观点，无法直接验证。建议持续跟踪。' };
    }
    default: {
      return { claim: claim.raw, status: 'partially_verified', evidence: '定性判断需要结合多维度数据综合评估。建议持续跟踪验证。' };
    }
  }
}

// Analyze claim types for probability adjustment
function analyzeClaimTypes(claims, noteType) {
  let bonus = 0;
  
  // Quantitative claims are more verifiable
  const quantitative = claims.filter(c => c.type !== 'qualitative').length;
  if (quantitative >= 3) bonus += 5;
  if (quantitative >= 5) bonus += 5;
  
  // Strategy-type notes are harder to verify
  if (noteType === 'strategy') bonus -= 5;
  if (noteType === 'observation') bonus += 3;
  
  return bonus;
}

// Generate verification result text
function generateVerificationText(status, probability, results, claims) {
  const parts = [];
  
  if (status === 'verified') {
    parts.push(`✅ 验证结果：你的投资经验/心得有较高可信度（正确概率${probability}%）。`);
  } else if (status === 'partially_verified') {
    parts.push(`⚠️ 验证结果：你的投资经验/心得部分得到验证（正确概率${probability}%）。部分判断与实际数据吻合，但仍有需要持续观察的方面。`);
  } else {
    parts.push(`❌ 验证结果：你的投资经验/心得暂未得到数据支持（正确概率${probability}%）。建议谨慎参考，并持续跟踪验证。`);
  }
  
  if (results.length > 0) {
    parts.push('\n具体验证详情：');
    for (const r of results) {
      const icon = r.status === 'verified' ? '✅' : r.status === 'partially_verified' ? '⚠️' : '❌';
      parts.push(`${icon} ${r.evidence}`);
    }
  }
  
  parts.push(`\n📊 共分析了${claims.length}个判断点。`);
  parts.push('💡 提示：投资经验验证基于历史财务数据，不构成投资建议。市场环境变化可能影响经验的有效性。');
  
  return parts.join('\n');
}

// ---- 期货关联走势分析 API ----
app.get('/api/futures-correlation/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';
    const meta = getFuturesMeta(symbol);
    if (!meta) {
      return res.json({ hasFutures: false });
    }
    const result = await fetchFuturesCorrelation(symbol, name);
    res.json(result);
  } catch (err) {
    console.error('Futures correlation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 行业分析 API ----
app.get('/api/industry-analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';

    // 总超时兜底：避免任何外部接口无响应时前端永久转圈
    const result = await Promise.race([
      industryAnalysis(symbol, name),
      new Promise((_, reject) => setTimeout(() => reject(new Error('行业分析超时（外部数据接口响应过慢，请稍后重试）')), 40000)),
    ]);

    res.json(result);
  } catch (err) {
    console.error('Industry analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 资金量能分析 API ----
app.get('/api/capital-flow/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const name = req.query.name || '';

    const [quote, history] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, 'daily').catch(() => []),
    ]);

    if (!quote) {
      return res.status(404).json({ error: '无法获取股票行情数据' });
    }

    // 整体超时兜底：融资融券抓取已内部降级（最坏 ~8s），此处为最后防线，
    // 一旦超时直接返回错误，避免前端无限 loading。
    const OVERALL_TIMEOUT_MS = 15000;
    const result = await Promise.race([
      analyzeCapitalFlow(symbol, name || quote.name, quote, history),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`资金量能分析超时（>${OVERALL_TIMEOUT_MS / 1000}s）`)), OVERALL_TIMEOUT_MS)),
    ]);
    res.json(result);
  } catch (err) {
    console.error('Capital flow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 文档资料库 API ----



// 20260906 路由拆分：资料库（docs）11 条路由 + 上传辅助移至 routes/docsRoutes.js
app.use(docsRoutes);

// 将 data/reports 下已下载的年报/半年报登记进本地资料库（按 relativePath 去重）
// 20260821f：统一委托 lib/reportSync 实现（含 semi 半年报分类），避免双份逻辑漂移
function registerDownloadedReports() {
  return reportSync.registerDownloadedReports();
}

app.post('/api/reports/download', async (req, res) => {
  try {
    const { codes, years = 5, types = ['annual', 'semi'], channel = 'cninfo' } = req.body || {};
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: '请提供至少一个股票代码' });
    }
    // 通道校验：仅允许已知通道，未知则回退巨潮
    const allowedChannels = ['cninfo', 'eastmoney', 'all'];
    const safeChannel = allowedChannels.includes(channel) ? channel : 'cninfo';
    const py = findPython();
    if (!py) {
      return res.status(500).json({ error: '未找到 Python 解释器，请安装 Python 3 或设置环境变量 PYTHON_BIN 指向 python 可执行文件。' });
    }
    const script = path.join(__dirname, 'scripts', 'download_reports.py');
    if (!fs.existsSync(script)) {
      return res.status(500).json({ error: '下载脚本不存在: ' + script });
    }
    const outDir = path.join(__dirname, 'data', 'reports');
    const args = [
      script,
      '--codes', codes.join(','),
      '--years', String(years),
      '--types', types.join(','),
      '--out', outDir,
      '--channel', safeChannel,
      '--json',
    ];
    console.log(`[Reports] Running: ${py} ${args.join(' ')}`);
    const child = cp.spawn(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      console.error('[Reports] spawn error:', e.message);
      return res.status(500).json({ error: '启动下载脚本失败: ' + e.message });
    });
    child.on('close', (code) => {
      const m = stdout.match(/RESULT_JSON:(\{[\s\S]*\})/);
      if (m) {
        try {
          const summary = JSON.parse(m[1]);
          // 下载完成后，将新文件登记进本地资料库，便于在「资料库」中浏览
          try {
            registerDownloadedReports();
          } catch (regErr) {
            console.error('[Reports] register error:', regErr.message);
          }
          return res.json({ ok: true, summary, log: stderr });
        } catch (e) {
          // 解析失败，回退
        }
      }
      console.error('[Reports] exited code', code, 'stderr:', stderr.slice(0, 500));
      return res.json({ ok: false, code, stdout, stderr });
    });
  } catch (e) {
    console.error('[Reports] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 诊断：探测巨潮接口对指定股票代码、各参数组合能否返回公告（不下载）
app.get('/api/reports/probe', async (req, res) => {
  try {
    const raw = String(req.query.codes || '');
    const codes = raw.split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
    if (codes.length === 0) {
      return res.status(400).json({ error: '请提供股票代码，例如 ?codes=600938' });
    }
    const py = findPython();
    if (!py) {
      return res.status(500).json({ error: '未找到 Python 解释器，请安装 Python 3 或设置环境变量 PYTHON_BIN。' });
    }
    const script = path.join(__dirname, 'scripts', 'download_reports.py');
    if (!fs.existsSync(script)) {
      return res.status(500).json({ error: '下载脚本不存在: ' + script });
    }
    const args = [script, '--codes', codes.join(','), '--years', '5', '--types', 'annual,semi', '--probe'];
    console.log(`[Reports] Probe: ${py} ${args.join(' ')}`);
    const child = cp.spawn(py, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => {
      console.error('[Reports] probe spawn error:', e.message);
      return res.status(500).json({ error: '启动诊断脚本失败: ' + e.message });
    });
    child.on('close', () => {
      const m = stdout.match(/PROBE_JSON:(\[.*\])/);
      let combos = null;
      if (m) {
        try { combos = JSON.parse(m[1]); } catch (e) { combos = null; }
      }
      const lines = stdout.split('\n').map(l => l.trim()).filter(l =>
        l.includes('totalRecordNum') || l.includes('请求失败') || l.includes('参数组合探测'));
      res.json({ ok: true, python: py, combos, lines, stderr: stderr.slice(0, 500) });
    });
  } catch (e) {
    console.error('[Reports] probe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器：端口被占用时自动顺延，并记录实际端口并自动打开浏览器
function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'linux'
      ? `xdg-open "${url}"`
      : `cmd /c start "" "${url}"`;
  cp.exec(cmd, (err) => {
    if (err) console.log(`（自动打开浏览器失败，请手动在浏览器访问 ${url}）`);
  });
}

// 每日 15:30 盘后结算短期判断准确率（工作日；服务运行期间每分钟检查一次，
// 到了 15:30 且当天尚未结算则触发全量结算）。服务未常驻时，启动时的 settleAll() 兜底。
// 结算后自动执行「自学习复核」：归因不准确因子 + 自动复核新闻影响 + 自动更正权重。
let _lastSettleDate = null;
let _lastPreOpenSlot = '';
let _preOpenRunning = false;

// 自学习自动复核：结算判断 → 归因不准确部分 → 自动复核新闻影响 → 自动更正权重。
// 全部在后台自动运行，无需人工干预。
async function runAutoReview() {
  // 0) 全市场情绪指数：盘后落当日快照 + 自适应学习（极值日打标→调 extremeZ）
  let msiNote = null;
  try {
    const snap = await MSI.recordDailySnapshot();
    if (snap) {
      // 拉上证历史用于学习校准（best-effort）
      const shHist = await (require('./lib/stockData').getHistory('sh000001', '1y')).catch(() => []);
      const { full } = await MSI.getSeries({ allowBackfill: true });
      const learn = await labelAndLearn(full, shHist);
      msiNote = `情绪指数 ${snap.index} 已存档；学习样本 ${learn.total} 命中 ${learn.correct}（阈值 ${learn.extremeZ}）`;
    }
  } catch (e) {
    msiNote = '情绪指数快照失败: ' + e.message;
    console.error('  [结算] 情绪指数快照失败:', e.message);
  }
  // 1) 结算全部未结算判断（含因子级命中归因 + 自适应权重重建）
  const acc = await settleAll();
  // 2) 新闻影响自动复核：用当日板块实际涨跌对照方向，自动标记对错
  let impactReview = null;
  try {
    const mo = await getMarketOverview();
    const chgMap = {};
    for (const s of [...(mo.sectorsUp || []), ...(mo.sectorsDown || [])]) {
      if (s && s.name != null && typeof s.changePct === 'number') chgMap[s.name] = s.changePct;
    }
    impactReview = autoReviewImpacts(chgMap);
    // 盘后落当日行业拥挤度（仅数据日期==今天时写入）
    if (Array.isArray(mo.sectorAll)) recordSectorCrowding(mo.sectorAll, mo.sectorDate);
    // 盘后自动回填近 21 个交易日历史，确保本周/本月统计每日收盘后自动更新
    try {
      const bf = await backfillSectorCrowding(21, findPython());
      console.log('  [SectorCrowding] 盘后历史回填:', JSON.stringify(bf));
    } catch (bfErr) {
      console.error('  [SectorCrowding] 盘后历史回填失败:', bfErr.message);
    }
  } catch (e) {
    console.error('  [自动复核] 新闻影响复核失败:', e.message);
  }
  // 3) 学习状态（因子命中率 / 错误归因 / 权重演进）
  const learning = getLearningState();
  // 4) cn-financial-scraper 后台增强复核：对最近误判个股拉取「定期报告解读 + 全网舆情」，
  //    为学习层补充基本面/舆情上下文（best-effort，失败不阻断结算）
  const cnscraper = await enrichAutoReviewWithCnscraper(learning).catch(e => {
    console.error('  [自动复核] cn-financial-scraper 增强复核失败:', e.message);
    return { reviewed: 0, note: '增强复核失败: ' + e.message };
  });
  // 5) 个股近期热点已改为「打开个股页时 AI 联网按涨跌幅自动分析、按交易日缓存」，无需盘后快照。
  return { acc, impactReview, learning, cnscraper, msiNote };
}

// cn-financial-scraper 后台增强复核：对最近误判个股拉取定期报告解读（东财财报规则引擎）
// 与全网舆情（60+ 源），把结构化结论落盘到 data/cnscraper_review.json，供学习层与复盘引用。
async function enrichAutoReviewWithCnscraper(learning) {
  const errs = (learning && learning.recentErrors) || [];
  if (!errs.length) return { reviewed: 0, note: '无最近误判个股，跳过增强复核' };
  // 去重取前 8 只误判个股，避免盘后复核耗时过长
  const seen = new Set();
  const targets = [];
  for (const e of errs) {
    const k = e.symbol;
    if (k && !seen.has(k)) { seen.add(k); targets.push(e); }
    if (targets.length >= 8) break;
  }
  const out = { reviewed: 0, reviewedAt: new Date().toISOString(), items: [] };
  for (const e of targets) {
    const [rep, sent] = await Promise.all([
      interpretReport(e.symbol).catch(() => ({ ok: false })),
      getGlobalSentiment(e.name || '', { days: 3, maxArticles: 10, budget: 10 }).catch(() => ({ ok: false, count: 0 })),
    ]);
    out.items.push({
      symbol: e.symbol, name: e.name, date: e.date, targetDate: e.targetDate,
      verdict: e.verdict, actualDir: e.actualDir, actualChgPct: e.actualChgPct,
      report: rep && rep.ok ? {
        ok: true, score: rep.score, rating: rep.rating,
        revenue_yoy: rep.revenue_yoy, profit_yoy: rep.profit_yoy,
        highlights: (rep.highlights || []).slice(0, 2),
        risks: (rep.risks || []).slice(0, 2),
      } : { ok: false },
      sentiment: sent && sent.ok ? {
        ok: true, count: sent.count, positive: sent.positive, negative: sent.negative,
        signal: sent.signal, avg_score: sent.avg_score,
      } : { ok: false },
    });
  }
  out.reviewed = out.items.length;
  try {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cnscraper_review.json'), JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('  [自动复核] 写入 cnscraper_review.json 失败:', e.message);
  }
  return { reviewed: out.reviewed, note: `对 ${out.reviewed} 只误判个股拉取财报解读+全网舆情` };
}

function logAutoReview(r) {
  const a = r.acc || {};
  console.log(`  [结算] 已结算 ${a.settledCount} 条，准确率 ${a.accuracy == null ? '—' : a.accuracy + '%'}，待结算 ${a.pendingCount} 条${a.overdueCount ? '（其中 ' + a.overdueCount + ' 条过期未结算）' : ''}`);
  if (r.impactReview && r.impactReview.reviewed > 0) {
    console.log(`  [自学习·新闻影响] 自动复核 ${r.impactReview.reviewed} 条：正确 ${r.impactReview.correctN} / 错误 ${r.impactReview.wrongN}，累计准确率 ${r.impactReview.accuracy == null ? '—' : r.impactReview.accuracy + '%'}`);
  }
  const errs = (r.learning && r.learning.recentErrors) || [];
  if (errs.length) {
    console.log(`  [自学习·归因] 最近 ${errs.length} 笔判断错误的误导因子已标记，权重已按命中率自动调整`);
  }
  if (r.cnscraper && r.cnscraper.reviewed > 0) {
    console.log(`  [自学习·cn-scraper] ${r.cnscraper.note}`);
  }
  if (r.msiNote) {
    console.log(`  [自学习·情绪指数] ${r.msiNote}`);
  }
}

function startDailySettlementScheduler() {
  setInterval(() => {
    const now = new Date();
    const dow = now.getDay();
    const isWeekend = (dow === 0 || dow === 6);
    const hh = now.getHours();
    const mm = now.getMinutes();

    // —— 15:30 盘后结算 + 自学习自动复核 ——
    if (!isWeekend && hh >= 15 && (hh > 15 || mm >= 30)) {
      const today = localDate(now);
      if (_lastSettleDate !== today) {
        _lastSettleDate = today;
        console.log(`\n  [结算] 触发每日 15:30 盘后结算 + 自学习自动复核（${today}）...`);
        runAutoReview()
          .then(logAutoReview)
          .catch(e => console.error('  [结算] 每日定时结算失败:', e.message));
      }
    }

    // —— 盘前预重算（方案 C·Part B）：交易日 8:00–9:30，每 10 分钟一次，吸收隔夜美股与早间消息 ——
    if (!isWeekend && hh >= 8 && (hh < 9 || (hh === 9 && mm < 30))) {
      const slot = `${localDate(now)} ${hh}:${Math.floor(mm / 10)}`;
      if (slot !== _lastPreOpenSlot) {
        _lastPreOpenSlot = slot;
        if (!_preOpenRunning) {
          _preOpenRunning = true;
          preOpenRecomputeAll()
            .then(r => console.log(`  [盘前预重算] ${r.targetDate} 重建 ${r.count} 条，跳过 ${r.skipped} 条`))
            .catch(e => console.error('  [盘前预重算] 失败:', (e && e.message) || e))
            .finally(() => { _preOpenRunning = false; });
        }
      }
    }
  }, 60 * 1000);
}

function startServer(port, retries = 5) {
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    // 由启动器(start.vbs)负责打开浏览器时，这里必须跳过，否则会打开两个相同的网页窗口
    const launcherOpens = process.env.SA_NO_AUTO_OPEN === '1';
    console.log(`\n  Stock Analyzer 已启动： ${url}\n  ${launcherOpens ? '（浏览器由启动器打开，此处跳过以避免重复开窗）' : '正在打开浏览器...'}\n`);
    try {
      fs.writeFileSync(path.join(__dirname, 'data', '.server-port'), String(port));
    } catch (e) { /* 忽略端口记录失败 */ }
    if (!launcherOpens) openBrowser(url);
    // 启动时自动结算 + 自学习自动复核（含周末生成的 nextday 预测），确保过期未结算的预测被判对错、准确率真实
    runAutoReview()
      .then(logAutoReview)
      .catch(e => console.error('  [结算] 初始化失败:', e.message));
    // 每日 15:30 盘后定时结算 + 自学习自动复核
    startDailySettlementScheduler();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (retries > 0) {
        console.log(`端口 ${port} 被占用，0.5s 后重试（剩余 ${retries} 次）...`);
        setTimeout(() => startServer(port, retries - 1), 500);
      } else if (port < PORT + 10) {
        console.log(`端口 ${port} 已被占用，尝试 ${port + 1} ...`);
        startServer(port + 1);
      } else {
        console.error('服务器启动失败:', err.message);
        process.exit(1);
      }
    } else {
      console.error('服务器启动失败:', err.message);
      process.exit(1);
    }
  });
}

// 启动前初始化本地 SQLite 数据层（建库 + 建表）。失败仅记录，不影响主服务启动。
try {
  db.initDb();
} catch (e) {
  console.error('[DB] 初始化失败，数据持久化功能暂不可用：', e.message);
}

startServer(PORT);
