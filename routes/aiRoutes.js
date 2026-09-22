/**
 * AI / 妙想 / 行业指数 / 产品图片 路由（20260906 自 server.js 拆出·第一阶段）
 * ----------------------------------------------------------------------------
 * 仅做路由搬运：处理器主体与 server.js 原实现逐字一致，输出格式零变化。
 * 挂载方式：server.js 中 app.use(aiRoutes)（路由内部保留完整 /api 前缀路径）。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  analyzeMarketOverview, publicConfig, loadConfig, saveConfig, augmentStock,
  analyzeAspects, readCache, analyzeCompanyDeep, analyzeValuation,
  analyzeResearchReports,
  analyzeAnnouncements, analyzeEarningsReport, analyzeIndustryIndex,
  readIndustryIndexCache, readEarningsCache,
} = require('../lib/aiAugment');
const factStore = require('../lib/factStore');
const mx = require('../lib/miaoxiang');
const { getIndustryIndexHistory } = require('../lib/industryIndexHistory');
const { getSectorMarketCapHistory } = require('../lib/sectorMarketCapHistory');
const { resolveStockSectorLevels } = require('../lib/stockSectorLevels');
const { getIndustryProsperity } = require('../lib/industryProsperity');
const { findPython } = require('../lib/pyRuntime');
// 20260913d：行业指数运行状态侧车（running/error）与僵死阈值。
// 直接 require 子模块，不经 aiAugment 门面 —— 门面导出基线（24 键）受 scripts/export-snapshot.js 守卫，不得增删。
const { readIndustryIndexState, STALE_RUNNING_MS } = require('../lib/ai/market');

const router = express.Router();

// 首页大盘/板块 AI 解读（滚动字幕）
router.get('/api/ai/market-overview', async (req, res) => {
  try {
    const cached = await analyzeMarketOverview({ data: null, force: false, readOnly: true });
    res.json(cached || { success: false, cached: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/ai/market-overview', async (req, res) => {
  try {
    const { data, force } = req.body || {};
    const result = await analyzeMarketOverview({ data, force: !!force });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI 联网资料补全（需用户自行配置带联网搜索的大模型 API Key）
router.get('/api/ai/config', (req, res) => {
  res.json(publicConfig(loadConfig()));
});

router.post('/api/ai/config', (req, res) => {
  try {
    // 20260902d：双模型配置。旧前端只传 model，视为「联网模型」以保持兼容。
    // 20260903n：新增 volc/baidu 搜索通道凭据（searchMode = builtin|mcp|volc|baidu）。
    const {
      provider, apiKey, model, modelWeb, modelLocal, useCustomProtocol, searchMode,
      volcApiKey, volcModel, baiduApiKey,
    } = req.body || {};
    const cfg = saveConfig({
      provider,
      apiKey,
      model,
      modelWeb: modelWeb || model,
      modelLocal,
      useCustomProtocol,
      searchMode,
      volcApiKey,
      volcModel,
      baiduApiKey,
    });
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/ai/augment', async (req, res) => {
  try {
    const { symbol, stockName, industry, force } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await augmentStock({ symbol, stockName, industry, force: !!force });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI 联网分析个股亮点 / 雷点（结构化，可自动写入个股笔记）
router.post('/api/ai/aspects', async (req, res) => {
  try {
    const { symbol, stockName, industry, force } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeAspects({ symbol, stockName, industry, force: !!force });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 只读缓存接口：打开个股页时自动拉取已存的 AI 补全 / 亮点雷点（不联网、不限 TTL）
router.get('/api/ai/augment/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});

router.get('/api/ai/aspects/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_aspects');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});

// 公司深度分析（CFA 统一框架 · 20260914f）：合并原「公司综合介绍/供应链与成本/主要产品&客户」三模块为单一分析
// 输出七段：①一句话定位与投资摘要 ②基本面画像 ③供应链与成本 ④客户与竞争 ⑤跨模块联动 ⑥风险提示 ⑦来源/缺失说明
router.post('/api/ai/company-deep', async (req, res) => {
  try {
    const { symbol, stockName, industry, force, companyName, companyType } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeCompanyDeep({ symbol, stockName, industry, force: !!force, companyName, companyType });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 估值大模型（提示词驱动，读取 prompts/valuation-system.md）：AI 联网估值
router.post('/api/ai/valuation', async (req, res) => {
  try {
    const { symbol, stockName, industry, force, companyName } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeValuation({ symbol, stockName, industry, force: !!force, companyName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 20260908：个股专属估值模型（确定性计算，无 LLM 参与）。
// 20260909l：闸门从硬编码 601318 改为 hasDedicatedValuation 动态判定（平安/圣湘/海天/士兰/华安/长江/麦捷/电气风电/券商）；
// 本端点同步计算实现仍仅 601318 平安——其余专属股结果统一走 /api/ai/valuation/:symbol 的 analyzeValuation 专属分支。
router.get('/api/valuation/model/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim().replace(/^(sh|sz|bj)/i, '');
    const { hasDedicatedValuation } = require('../lib/ai/valuation');
    if (!hasDedicatedValuation(symbol)) {
      return res.json({ ok: false, error: 'NO_MODEL', message: `该标的暂无专属估值模型` });
    }
    if (symbol !== '601318') {
      return res.json({ ok: true, dedicated: true, message: '该标的拥有专属确定性估值模型，结果请走 /api/ai/valuation/:symbol 获取' });
    }
    const paModel = require('../lib/valuation/pingAn601318.js');
    const cfg = paModel.loadInputs();
    if (!cfg) return res.json({ ok: false, error: 'NO_INPUTS', message: '缺少输入配置 data/valuation/601318.json' });
    // 现价跟随实时行情（唯一随时间变化的输入；其余为财报锁死值）
    try {
      const qt = require('../lib/quoteService');
      if (qt && typeof qt.getQuote === 'function') {
        const q = qt.getQuote('sh601318');
        const px = q && (q.price != null ? q.price : (q.latest && q.latest.price));
        if (px) cfg.inputs.P = Object.assign({}, cfg.inputs.P, { value: px, source: '实时行情' });
      }
    } catch (e) { /* 取不到实时价则用配置文件中的收盘价 */ }
    res.json(paModel.compute(cfg));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 券商分类 + 估值（确定性：分类见 lib/brokerClassification，估值见 lib/brokerValuation）
router.post('/api/broker/classify', (req, res) => {
  try {
    const { classify } = require('../lib/brokerClassification');
    const { metrics } = req.body || {};
    if (!metrics) return res.status(400).json({ ok: false, error: 'NO_METRICS', message: '缺少 metrics（6 核心指标）' });
    res.json(classify(metrics));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/broker/valuation', (req, res) => {
  try {
    const { classifyAndValue } = require('../lib/brokerValuation');
    const { metrics, valuationInputs } = req.body || {};
    if (!metrics) return res.status(400).json({ ok: false, error: 'NO_METRICS', message: '缺少 metrics（6 核心指标）' });
    res.json(classifyAndValue(metrics, valuationInputs || {}));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/ai/valuation/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const bare = symbol.replace(/^(sh|sz|bj)/i, '');
    // 20260909l：专属确定性估值标的（601318/圣湘/海天/士兰/华安/长江/麦捷/电气风电/券商）一律优先实时计算——
    // 根因修复：旧顺序「先缓存后专属」会让专属模型上线前遗留的 AI 自由发挥旧缓存被命中
    // （电气风电 688660：20260909h 上线 DCAVM 时未删 2026-09-06 旧缓存，打开页面下卡显示旧 AI 文本
    // 区间 3.00~5.20，与上卡 DCAVM 确定性 5.39~9.62 不一致）。专属股打开页面即确定性计算
    // （无 LLM、不消耗额度），模型失败时也不回落旧 AI 文本——返回 cached:false，前端保持规则版结论。
    const { hasDedicatedValuation } = require('../lib/ai/valuation');
    if (hasDedicatedValuation(bare)) {
      try {
        const r = await analyzeValuation({ symbol: bare });
        if (r && r.dedicated) return res.json(r);
      } catch (e) { /* 失败 → 下方 cached:false，绝不回落旧 AI 文本缓存 */ }
      return res.json({ success: false, cached: false, dedicated: true });
    }
    // 20260906：非专属股 GET 纯只读——仅返回有效缓存（v4 版本+TTL 匹配），绝不自动联网重算。
    // 打开个股不消耗额度；无有效缓存时前端保持规则版结论，用户点「✨ AI 估值」（force=true）才重算。
    const { readValuationCache } = require('../lib/aiAugment');
    const cached = readValuationCache(symbol);
    if (cached) return res.json({ success: true, ...cached, cached: true });
    res.json({ success: false, cached: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 公司深度分析：GET 纯只读（仅返回有效缓存，不自动联网）；用户点「✨ AI 联网获取」才 POST 重算
router.get('/api/ai/company-deep/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_companyDeep');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 产品图片本地服务（仅允许白名单扩展名，防目录穿越）
const PRODUCT_IMG_DIR = path.join(__dirname, '..', 'data', 'ai_cache', 'img');

// 研报 · AI 联网总结（近一年券商研报观点与评级）
router.post('/api/ai/research', async (req, res) => {
  try {
    const { symbol, stockName, industry, force } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeResearchReports({ symbol, stockName, industry, force: !!force });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/research/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_research');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 公告 · AI 联网总结（近一年增持/减持/回购/高管/立案/诉讼）
router.post('/api/ai/announcements', async (req, res) => {
  try {
    const { symbol, stockName, industry, force } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeAnnouncements({ symbol, stockName, industry, force: !!force });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/announcements/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_announcements');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 本地事实库预热（20260903f 降费）：自选股打开时静默预下载研报/公告/概况/主营到 SQLite，
// 后续 AI 分析走不联网模型纯推理，不产生联网搜索费用
router.post('/api/ai/prefetch-facts', async (req, res) => {
  try {
    const { symbol, stockName } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await factStore.prefetchFacts({ symbol, stockName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 最新财报解读 · AI 本地/联网双模型（优先本地模型分析本地财报数据；本地数据缺失时联网检索）
router.post('/api/ai/earnings', async (req, res) => {
  try {
    const { symbol, stockName, industry, force } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeEarningsReport({ symbol, stockName, industry, force: !!force });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/earnings/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readEarningsCache(symbol);
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});

// ========== 东方财富「妙想」数据（股东户数 / 机构评级 / 业绩预告 / 龙虎榜 / 资讯）==========
// 开始授权：返回 authUrl 供用户扫码/打开授权；已授权则直接 authed
router.get('/api/miaoxiang/auth', async (req, res) => {
  try {
    const r = await mx.startAuth();
    res.json(r);
  } catch (e) {
    res.status(500).json({ authed: false, error: e.message });
  }
});
// 查询授权状态：pending 已完成则落盘 key
router.get('/api/miaoxiang/auth/status', async (req, res) => {
  try {
    const r = await mx.getAuthStatus();
    res.json(r);
  } catch (e) {
    res.status(500).json({ authed: false, error: e.message });
  }
});
// 结构化取数（股东户数 / 评级 / 业绩预告 / 龙虎榜 等）
router.post('/api/miaoxiang/data', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: 'NO_QUERY', message: '缺少查询语句' });
    const r = await mx.searchData(query.trim());
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 资讯 / 研报 / 公告聚合
router.post('/api/miaoxiang/news', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: 'NO_QUERY', message: '缺少查询语句' });
    const r = await mx.searchNews(query.trim());
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 手动保存 apiKey（桌面用户无法扫码时，到 mxClaw 复制后粘贴）
router.post('/api/miaoxiang/apikey', async (req, res) => {
  try {
    const key = (req.body && req.body.apiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'apiKey 为空' });
    mx.saveKey(key);
    mx.clearPending();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 行业板块指数：AI 联网结构化获取（按行业代码缓存，跨个股共享）
router.post('/api/ai/industry-index', async (req, res) => {
  try {
    const { symbol, industry, induName, induCode } = req.body || {};
    if (!symbol && !industry && !induCode) {
      return res.status(400).json({ success: false, error: 'NO_INPUT', message: '缺少行业信息' });
    }
    const data = await analyzeIndustryIndex({ symbol, industryName: industry, induName, induCode, force: true, background: true });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/industry-index/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const { induCode, induName, industry } = req.query;
  // 优先用东方财富行业代码定位缓存，否则退回行业名
  const cacheName = industry || induName;
  const cached = readIndustryIndexCache(induCode, cacheName);   // 主缓存 = 最近一次成功结果（永不被 running/error 覆盖）
  const state = readIndustryIndexState(induCode, cacheName);    // 侧车 = running / error
  const running = !!(state && state.status === 'running' && (Date.now() - (Number(state.startedAt) || 0)) < STALE_RUNNING_MS);
  const lastError = (state && state.status === 'error') ? String(state.message || '') : '';

  // ① 只要有成功内容就优先返回（即使后台正在刷新、或上次刷新失败）——彻底消除"打开页面内容消失"
  if (cached && cached.status === 'done') {
    return res.json({ success: true, cached: true, hasContent: true, status: 'done', refreshing: running, lastError, ...cached });
  }
  // ② 无内容 + 正在后台生成
  if (running) {
    return res.json({ success: true, cached: false, hasContent: false, status: 'running', startedAt: state.startedAt });
  }
  // ③ 无内容 + 上次失败
  if (state && state.status === 'error') {
    return res.json({ success: true, cached: false, hasContent: false, status: 'error', message: lastError || 'AI 获取失败', at: state.at });
  }
  // ④ 从未生成过
  return res.json({ success: false, cached: false, hasContent: false });
});

// 行业指数历史行情（同花顺行业指数日线 OHLC，供行业分析页 K 线走势）
router.get('/api/industry-index-history/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    const { industry, induName, days } = req.query;
    const industryName = (industry || induName || '').trim();
    if (!industryName) {
      return res.status(400).json({ success: false, error: 'NO_INDUSTRY', message: '缺少行业名称' });
    }
    const data = await getIndustryIndexHistory(industryName, {
      days: Math.min(Math.max(parseInt(days, 10) || 250, 30), 500),
      pythonPath: findPython(),
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 板块成分股总市值「合计」日频走势（20260913d 新增）
// 供行业分析页「板块总市值走势」卡片：BK 板块全部成分股总市值合计 + 当前个股自身市值对比。
// 与 /api/stock-market-cap-history 同源（东方财富TTM），口径一致。
router.get('/api/sector-market-cap-history/:sectorCode', async (req, res) => {
  try {
    const sectorCode = String(req.params.sectorCode || '').trim();
    if (!sectorCode) return res.status(400).json({ success: false, error: 'NO_SECTOR' });
    const { name, benchmark, benchmarkName, days, force } = req.query;
    const data = await getSectorMarketCapHistory(sectorCode, {
      sectorName: (name || '').trim(),
      benchmark: (benchmark || '603288').trim(),
      benchmarkName: (benchmarkName || '').trim(),
      days: Math.min(Math.max(parseInt(days, 10) || 250, 30), 1000),
      force: force === '1' || force === 'true',
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 个股所属「申万一级/二级/三级」行业板块解析（20260916 新增）
// 供行业分析页「板块总市值走势」统一模板：每只个股分别与所属一级/二级/三级行业板块做市值走势比对（三张图）。
router.get('/api/stock-sector-levels/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
    const { name, force } = req.query;
    const data = await resolveStockSectorLevels(symbol, {
      name: (name || '').trim(),
      force: force === '1' || force === 'true',
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 行业景气度（20260920a 新增）
// 供个股页「行业分析」tab 下方独立卡片：个股所属**申万二级行业**内全部公司的
// 「总营收（TTM 滚动12个月合计）」vs「总市值（报告期末合计）」双坐标走势对比。
// 数据源：东方财富业绩报表 RPT_LICO_FN_CPD（按 PUBLISHNAME=申万二级行业名 全量汇总）
//        + 东方财富估值明细 RPT_VALUEANALYSIS_DET（按 BOARD_NAME 同行业口径）
//        + 板块成分股（行业公司总数）。口径已在 lib/industryProsperity.js 内逐项标注。
router.get('/api/industry-prosperity/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
    const { name, force, periods } = req.query;
    const data = await getIndustryProsperity(symbol, {
      name: (name || '').trim(),
      force: force === '1' || force === 'true',
      periods: parseInt(periods, 10) || undefined,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 产品图片本地服务（仅允许白名单扩展名，防目录穿越）
router.get('/api/ai/img/:file', (req, res) => {
  try {
    const file = String(req.params.file || '');
    if (!/^[\w\-]+\.(jpg|jpeg|png|webp)$/i.test(file)) return res.status(400).end();
    const fpath = path.join(PRODUCT_IMG_DIR, file);
    if (!fs.existsSync(fpath)) return res.status(404).end();
    const ext = file.split('.').pop().toLowerCase();
    const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.sendFile(fpath);
  } catch (e) {
    res.status(500).end();
  }
});

module.exports = router;
