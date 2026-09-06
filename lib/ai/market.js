/**
 * lib/ai/market.js —— aiAugment 领域子模块：大盘解读 + 行业指数（拆分重构 202609）
 * ----------------------------------------------------------------
 * _industryIndexRunning（行业指数后台任务去重锁）在本文件唯一持有。
 */
const fs = require('fs');
const path = require('path');
const { CACHE_DIR, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, extractJson } = require('./llm');

// ---- 大盘/板块 AI 解读（首页滚动条） ----
const MARKET_OVERVIEW_TTL_MS = 4 * 60 * 60 * 1000; // 行情变化快，缓存 4 小时
const MARKET_OVERVIEW_PROMPT = `你是一名 A 股市场分析师。请根据用户提供的今日大盘指数、涨幅前五板块、跌幅前五板块的实时数据，并结合联网搜索到的最新宏观/政策/事件信息，分别生成一段简短的中文市场解读（用于首页滚动字幕，每段 50-100 字）。

必须只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块，格式如下：
{"cn":"对 A 股大盘整体走势的 1 句精炼点评...","gainers":"对涨幅最大板块及其上涨驱动因素的 1 句点评...","losers":"对跌幅最大板块及其下跌原因的 1 句点评..."}

要求：
1) 每段控制在 50-100 个汉字，适合横向滚动展示；
2) 基于用户给出的具体指数/板块名称和涨跌幅，不要编造无来源的数字；
3) 点评要有信息量（驱动逻辑、资金流向、政策/事件），不要仅复述涨跌；
4) 使用简体中文。`;

async function analyzeMarketOverview({ data, force, readOnly }) {
  ensureDirs();
  const cacheFile = path.join(CACHE_DIR, 'market_overview.json');
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const stillFresh = Date.now() - (cached.cachedAt || 0) < MARKET_OVERVIEW_TTL_MS;
      if (stillFresh) {
        return { success: true, ...cached, cached: true };
      }
      if (readOnly) {
        return { success: false, cached: false };
      }
    } catch {}
  }
  if (readOnly) {
    return { success: false, cached: false };
  }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }

  const cn = (data && data.cn) || [];
  const sectorsUp = (data && data.sectorsUp) || [];
  const sectorsDown = (data && data.sectorsDown) || [];

  const summary = {
    cn: cn.map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    gainers: sectorsUp.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? '+' + i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    losers: sectorsDown.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
  };

  const userMsg = `请结合联网搜索，对以下今日 A 股行情给出三段滚动解读：
【大盘指数】${summary.cn || '暂无数据'}
【涨幅前5板块】${summary.gainers || '暂无数据'}
【跌幅前5板块】${summary.losers || '暂无数据'}`;

  try {
    // 20260904a：妙想事实源优先（东财要闻覆盖大盘/板块/宏观），失败自动回退通用搜索
    const marketMxQuery = `今日A股大盘行情解读 宏观政策事件（涨幅居前板块：${(data && data.sectorsUp || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}；跌幅居前：${(data && data.sectorsDown || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}）`;
    const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, [
      { role: 'system', content: MARKET_OVERVIEW_PROMPT },
      { role: 'user', content: userMsg },
    ], { webSearch: true, mxQuery: marketMxQuery });
    const parsed = extractJson(content) || {};
    const result = {
      cn: String(parsed.cn || '').trim(),
      gainers: String(parsed.gainers || '').trim(),
      losers: String(parsed.losers || '').trim(),
      model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      date: new Date().toISOString(),
      cachedAt: Date.now(),
      // 溯源：妙想命中时为 mx-first，回退时为空
      factSource: '东方财富妙想AI',
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---- 行业板块指数（AI 联网搜索） ----
const INDUSTRY_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 指数数据时效性强，缓存 1 天

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}
function industryIndexCacheFile(induCode, industryName) {
  const key = induCode ? String(induCode) : safeName(industryName || 'unknown');
  return path.join(CACHE_DIR, `industry_index_${key}.json`);
}
function readIndustryIndexCache(induCode, industryName) {
  try {
    const f = industryIndexCacheFile(induCode, industryName);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

const INDUSTRY_INDEX_PROMPT = `你是一名专业的行业指数研究员，熟悉 A 股的申万行业指数、中证行业/主题指数、国证行业指数等。用户会给你一个行业名称（可能含申万一级/二级行业、证监会细分行业、东方财富行业分类）。请利用联网搜索，找到代表该行业的板块指数，并给出指数的表现与走势分析。

要求：
1) 只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"indexName":"代表性行业指数名称(如'中证白酒指数')","indexCode":"指数代码(如'399997',不确定填\"\")","currentLevel":"当前点位(如'约 13200 点'或'13245.6',确实查不到填\"\")","asOf":"数据日期(YYYY-MM-DD,尽量用最近交易日)","ytdChangePct":"年初至今涨跌幅(如'+12.3%'或'-5.6%',确实查不到填\"\")","recentTrend":"近3-6个月该行业指数走势描述(2-4句,含关键拐点与驱动)","keyDrivers":["驱动因素1","驱动因素2","驱动因素3"],"outlook":"后市展望与风险(2-4句)","valuationNote":"当前估值/历史分位说明(1-2句,无则填\"\")","source":"数据来源(如'中证指数公司/东方财富/Wind,数据截至 YYYY-MM-DD')"}

2) indexName 应是该行业最具代表性的行业/主题指数；若有多只(如申万行业指数与中证主题指数),优先选流动性与代表性最好的那只。
3) 数字务必基于联网搜索到的公开数据，不要编造；若确实查不到精确点位或涨跌幅，对应字段填 ""，并在 recentTrend 中说明"未能获取精确数据，以下为定性判断"。
4) keyDrivers 列 2-4 条核心驱动（政策/景气/资金/供需/估值修复等）。
5) 使用简体中文。`;

// 进程内去重锁：避免同一行业被并发触发多次后台生成（覆盖写缓存）。本文件唯一持有。
const _industryIndexRunning = new Set();

async function analyzeIndustryIndex({ symbol, industryName, induName, induCode, force, background }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = industryIndexCacheFile(induCode, industryName);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - (cached.cachedAt || 0) < INDUSTRY_INDEX_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  const indLabel = [induName, industryName].filter(Boolean).join(' / ') || (symbol || '该行业');
  const userMsg = `请联网搜索并分析以下行业的代表板块指数表现：行业 = ${indLabel}${induCode ? '（东方财富行业代码 ' + induCode + '）' : ''}。请按 JSON 输出该行业板块指数的名称、代码、当前点位、年初至今涨跌幅、近期走势、核心驱动、后市展望与估值分位。`;
  const messages = [
    { role: 'system', content: INDUSTRY_INDEX_PROMPT },
    { role: 'user', content: userMsg },
  ];

  const runJob = async () => {
    try {
      // 20260904a：妙想行业资讯增强（驱动/景气/政策），仍保留通用搜索（识别代表指数代码/点位需要）
      const industryMxQuery = `行业板块「${indLabel}」指数 近期走势 核心驱动 政策 资金`;
      const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch: true, mxInject: true, mxQuery: industryMxQuery });
      const parsed = extractJson(content) || {};
      const result = {
        status: 'done',
        symbol: symbol || '',
        indexName: String(parsed.indexName || '').trim(),
        indexCode: String(parsed.indexCode || '').trim(),
        currentLevel: String(parsed.currentLevel || '').trim(),
        asOf: String(parsed.asOf || '').trim(),
        ytdChangePct: String(parsed.ytdChangePct || '').trim(),
        recentTrend: String(parsed.recentTrend || '').trim(),
        keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.map(d => String(d).trim()).filter(Boolean).slice(0, 5) : [],
        outlook: String(parsed.outlook || '').trim(),
        valuationNote: String(parsed.valuationNote || '').trim(),
        source: String(parsed.source || '').trim(),
        model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
        date: new Date().toISOString(),
        cachedAt: Date.now(),
      };
      try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
      return result;
    } catch (e) {
      const status = e.response && e.response.status;
      const data = e.response && e.response.data;
      let message = e.message;
      if (data) {
        if (typeof data === 'string') message = data.slice(0, 300);
        else if (data.message) message = data.message;
        else if (data.error && data.error.message) message = data.error.message;
      }
      const errObj = { status: 'error', error: 'API_ERROR', statusCode: status, message, symbol: symbol || '', cachedAt: Date.now() };
      try { fs.writeFileSync(cacheFile, JSON.stringify(errObj, null, 2), 'utf8'); } catch {}
      return errObj;
    }
  };

  // 后台模式：立即返回，真正的生成在后台异步完成；前端通过轮询 GET 读取 running / done / error 状态。
  // 即使前端断开（切页面/切股票/刷新），Node 进程仍会继续把结果写入缓存。
  if (background) {
    const lockKey = induCode ? String(induCode) : safeName(industryName);
    if (_industryIndexRunning.has(lockKey)) {
      return { success: true, started: false, running: true, status: 'running', background: true };
    }
    // 写 running 占位，前端可立即感知"进行中"
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ status: 'running', startedAt: Date.now(), symbol: symbol || '' }, null, 2), 'utf8');
    } catch {}
    _industryIndexRunning.add(lockKey);
    runJob().finally(() => { _industryIndexRunning.delete(lockKey); });
    return { success: true, started: true, status: 'running', background: true };
  }

  // 同步模式（保留兼容）：等待生成完成后再返回
  await runJob();
  const final = readIndustryIndexCache(induCode, industryName);
  if (final && final.status === 'done') return { success: true, ...final, cached: false };
  if (final && final.status === 'error') return { success: false, error: final.error, message: final.message };
  return { success: false, error: 'EMPTY', message: '未生成数据' };
}

module.exports = { analyzeMarketOverview, analyzeIndustryIndex, readIndustryIndexCache };
