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
  analyzeAspects, readCache, analyzeProducts, analyzeCompany, analyzeValuation,
  analyzeSupplyChain, analyzeShareholdersAI, analyzeResearchReports,
  analyzeAnnouncements, analyzeEarningsReport, analyzeIndustryIndex,
  readIndustryIndexCache, readEarningsCache,
} = require('../lib/aiAugment');
const { getCompanyProfile } = require('../lib/shareholderData');
const factStore = require('../lib/factStore');
const mx = require('../lib/miaoxiang');
const { getIndustryIndexHistory } = require('../lib/industryIndexHistory');
const { findPython } = require('../lib/pyRuntime');

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

// 产品·客户：AI 联网结构化获取（含产品图片下载到本地缓存）
router.post('/api/ai/products', async (req, res) => {
  try {
    const { symbol, stockName, industry, force, companyType } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    let f10Products = [];
    try {
      const prof = await getCompanyProfile(symbol);
      f10Products = (prof && prof.mainProducts) || [];
    } catch {}
    const data = await analyzeProducts({ symbol, stockName, industry, force: !!force, f10Products, companyType });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/products/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_products');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 公司综合介绍：AI 联网结构化获取（含产品/服务图片）
router.post('/api/ai/company', async (req, res) => {
  try {
    const { symbol, stockName, industry, force, companyName } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeCompany({ symbol, stockName, industry, force: !!force, companyName });
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
router.get('/api/ai/valuation/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    // 20260906：GET 纯只读——仅返回有效缓存（v4 版本+TTL 匹配），绝不自动联网重算。
    // 打开个股不消耗额度；无有效缓存时前端保持规则版结论，用户点「✨ AI 估值」（force=true）才重算。
    const { readValuationCache } = require('../lib/aiAugment');
    const cached = readValuationCache(symbol);
    if (!cached) return res.json({ success: false, cached: false });
    res.json({ success: true, ...cached, cached: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/company/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_company');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 供应链与成本分析：AI 联网结构化获取（含原材料/供应商图片）
router.post('/api/ai/supply', async (req, res) => {
  try {
    const { symbol, stockName, industry, force, companyName } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeSupplyChain({ symbol, stockName, industry, force: !!force, companyName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/supply/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_supply');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});
// 产品图片本地服务（仅允许白名单扩展名，防目录穿越）
const PRODUCT_IMG_DIR = path.join(__dirname, '..', 'data', 'ai_cache', 'img');

// 股东户数 AI 联网补充（本地 F10 未覆盖时）
router.post('/api/ai/holders', async (req, res) => {
  try {
    const { symbol, stockName, mode } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL', message: '缺少股票代码' });
    const data = await analyzeShareholdersAI({ symbol, stockName, mode: mode || 'web' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/api/ai/holders/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol) return res.status(400).json({ success: false, error: 'NO_SYMBOL' });
  const cached = readCache(symbol, '_holders');
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
});

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
  const cached = readIndustryIndexCache(induCode, industry || induName);
  if (!cached) return res.json({ success: false, cached: false });
  res.json({ success: true, cached: true, ...cached });
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
