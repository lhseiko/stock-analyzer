/**
 * cn-financial-scraper 后台接入适配器（Node 端）
 * --------------------------------------------------------------
 * 通过异步 execFile 调用 scripts/cnscraper_adapter.py，把 cn-financial-scraper
 * v7.2.0 的「全网舆情 / 定期报告解读 / 交易所公告 / 监管政策资讯 / 货币政策」
 * 作为后台数据源接入工作台。
 *
 * 关键约束（见项目记忆）：
 *   * 必须 async execFile + JSON.parse(out.stdout)（不是 JSON.parse(out)）——
 *     promisify(execFile) 的返回值是 {stdout,stderr} 对象，直接 parse 会抛错。
 *   * 禁止同步子进程（execFileSync 会冻结事件循环）。
 *   * 所有函数失败时返回 {ok:false, ...} 而非抛异常，让上层判断逻辑优雅降级，
 *     绝不因外挂数据源不可用而拖垮个股判断。
 *   * 外挂源在本机沙箱/受限网络下常返回空（stub 已由 Python 层过滤），
 *     因此以「ok:true 但 count=0」的方式降级，而非报错。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');
const { industryAnalysis } = require('./industryAnalysis');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cnscraper_adapter.py');
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟内存缓存

let _cache = {};
function _getCache(key) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  return undefined;
}
function _setCache(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

async function _run(args) {
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器，无法调用 cn-financial-scraper 适配器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'cnscraper_adapter.py 不存在: ' + SCRIPT };
  try {
    const out = await execFileAsync(py, [SCRIPT, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 70000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    return parsed || { ok: false, error: '空结果' };
  } catch (e) {
    // 解析失败 / 超时 / 非零退出，一律降级为 ok:false，不让异常上抛
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'cnscraper 调用失败' };
  }
}

/**
 * 全网舆情：按目标名（个股名/机构名/行业词）爬取 60+ 源舆情，聚合情绪。
 * 返回 { ok, count, positive, negative, neutral, avg_score, signal, articles, note }
 */
async function getGlobalSentiment(targets, opts = {}) {
  const t = Array.isArray(targets) ? targets : String(targets || '').split(',');
  const names = t.map(s => String(s).trim()).filter(Boolean);
  if (!names.length) return { ok: false, error: '未提供目标名', count: 0 };
  const days = opts.days || 3;
  const max = opts.maxArticles || 15;
  const budget = opts.budget || 12;
  const key = 'sent:' + names.join('|') + ':' + days;
  const cached = _getCache(key);
  if (cached) return cached;

  const r = await _run(['sentiment', '--targets', names.join(','), '--days', String(days), '--max', String(max), '--budget', String(budget)]);
  _setCache(key, r);
  return r;
}

/**
 * 定期报告解读：拉取东财财务数据并规则引擎解读。
 * 返回 { ok, code, name, revenue, net_profit, revenue_yoy, profit_yoy, gross_margin,
 *         roe, cash_ratio, score, rating, highlights, risks, ... }
 */
async function interpretReport(code) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, error: '未提供股票代码' };
  const key = 'rep:' + c;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['report', '--code', c]);
  _setCache(key, r);
  return r;
}

/**
 * 沪深交易所公告搜索。
 * 返回 { ok, keyword, count, items:[{market,title,stock_code,stock_name,publish_date,url,category}] }
 */
async function searchAnnouncements(keyword, max = 30) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, error: '未提供搜索词', items: [] };
  const key = 'ann:' + kw;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['announcements', '--keyword', kw, '--max', String(max)]);
  _setCache(key, r);
  return r;
}

/**
 * 交易所公告·按股票代码兜底（东方财富 np-anotice）。
 * 深交所公告源（cn-financial-scraper 的 search_announcements）在本机常因接口 500/熔断失效，
 * 导致回购/分红/增持等公告一条都抓不到。此函数直接用东财接口按 6 位代码拉取近一年公告，
 * 作为公告源的可靠兜底。返回 { ok, keyword, count, items:[{title,date,stock_code,stock_name,url}] }
 */
async function searchAnnouncementsByCode(symbol, max = 30) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').replace(/\.(SS|SZ|BJ)$/i, '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '非A股代码', items: [] };
  const key = 'anncode:' + code;
  const cached = _getCache(key);
  if (cached) return cached;
  const url = `https://np-anotice-stock.eastmoney.com/api/security/announcement?sr=-1&page_size=${Math.min(Math.max(max, 10), 60)}&page_index=1&stock_list=${code}`;
  let r;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000,
    });
    const list = resp.data?.announcements || resp.data?.list || resp.data?.data || [];
    if (!Array.isArray(list) || !list.length) {
      r = { ok: true, keyword: code, count: 0, items: [] };
    } else {
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      const cutoff = start.toISOString().slice(0, 10);
      const items = list
        .map(a => ({
          title: a.title || a.notice_title || '',
          date: String(a.ei_time || a.notice_date || a.datetime || '').slice(0, 10),
          stock_code: code,
          stock_name: a.stock_name || '',
          url: a.url || a.notice_url || '',
          category: a.columns || '',
        }))
        .filter(a => a.title && a.date >= cutoff);
      r = { ok: true, keyword: code, count: items.length, items };
    }
  } catch (e) {
    r = { ok: false, error: (e && e.message ? String(e.message) : '东财公告请求失败').slice(0, 200), items: [] };
  }
  _setCache(key, r);
  return r;
}

/**
 * 监管/政策资讯（宏观政策 + 财经要闻 + 公告）。
 * 返回 { ok, agency, count, items:[{title,url,source,date}] }
 */
async function getRegulatoryNews(agency = 'all', limit = 15) {
  const key = 'reg:' + agency + ':' + limit;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['regulatory', '--agency', agency, '--limit', String(limit)]);
  _setCache(key, r);
  return r;
}

/**
 * 货币政策/财经要闻摘要（LPR、公开市场、宏观资讯）。
 */
async function getMonetaryPolicy() {
  const key = 'mon';
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['monetary']);
  _setCache(key, r);
  return r;
}

/**
 * 财政部《财政收支情况》公告解析（一般公共预算收入/支出）。
 * 经 cn-financial-scraper 检索最新公告 → 抓正文 → 正则解析。
 * 返回 { ok, date, source, title, url, revenue:{acc,yoy}, expenditure:{acc,yoy} }。
 * 任一外挂源失败返回 {ok:false}，绝不抛异常。
 */
async function getFiscalData() {
  const key = 'fiscal';
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['fiscal', '--limit', '40']);
  _setCache(key, r);
  return r;
}

// 股票→行业 映射的内存缓存（行业归属变动极少，缓存 24 小时）
const _indCache = new Map();
const _IND_CACHE_TTL = 24 * 60 * 60 * 1000;
async function _lookupIndustry(code, name) {
  const k = code || ('n:' + name);
  const hit = _indCache.get(k);
  if (hit && Date.now() - hit.ts < _IND_CACHE_TTL) return hit.v;
  try {
    const ind = await industryAnalysis(code, name || '');
    // 优先级：indvInduName（东方财富行业研报分类）> sshy（申万行业）> industry.industry.name
    let v = '未分类';
    if (ind) {
      if (ind.induName) v = ind.induName;
      else if (ind.industry && ind.industry.name) v = ind.industry.name;
      else if (ind.name && ind.name !== '未知') v = ind.name;
    }
    _indCache.set(k, { ts: Date.now(), v });
    return v;
  } catch (e) {
    _indCache.set(k, { ts: Date.now(), v: '未分类' });
    return '未分类';
  }
}

/**
 * 基金重仓行业配置矩阵
 * --------------------------------------------------------------
 * 拉取头部基金（按近 1 年业绩，混合型）最新季报的前 10 重仓股，对每只重仓股
 * 映射所属行业，聚合为「行业 × 基金」矩阵（含每只基金的重仓股详情）。
 *
 * 返回：
 *   {
 *     ok, quarter, fundCount, skipped, topN, note,
 *     industries: [
 *       {
 *         name,                                  // 行业名
 *         totalWeight,                           // 行业内总权重（%）
 *         fundCount,                             // 持有该行业的基金数
 *         funds: { [fundCode]: { fundName, yearReturn, totalWeight, stocks: [{code,name,weight}] } },
 *         topStocks: [{name, code, totalWeight, fundCount}]   // 行业内 Top 重仓股
 *       },
 *       ...
 *     ],
 *     funds: [{code, name, yearReturn, quarter, holdings: [...]}],  // 原始基金列表
 *   }
 *
 * 失败/降级时返回 { ok:false, error, ... }，绝不抛异常。
 */
async function getFundIndustryMatrix(opts = {}) {
  const topN = Math.max(1, Math.min(opts.topN || 15, 30));
  const key = 'fund-matrix:' + topN;
  const cached = _getCache(key);
  if (cached) return cached;

  const raw = await _run(['fund-matrix', '--top-n', String(topN)]);
  if (!raw || !raw.ok) {
    const out = { ok: false, error: (raw && raw.error) || '基金矩阵数据获取失败',
                  topN, industries: [], funds: [] };
    _setCache(key, out);
    return out;
  }

  // 1) 收集所有唯一股票
  const stockMap = new Map(); // code -> name
  for (const f of raw.funds || []) {
    for (const h of (f.holdings || [])) {
      if (h.code && !stockMap.has(h.code)) stockMap.set(h.code, h.name);
    }
  }
  // 2) 并发映射每只股票到行业
  const industryEntries = await Promise.all(
    Array.from(stockMap.entries()).map(([c, n]) => _lookupIndustry(c, n).then(ind => [c, ind]))
  );
  const stockToIndustry = Object.fromEntries(industryEntries);

  // 3) 聚合：行业 × 基金 矩阵
  const industryMap = new Map();
  for (const fund of raw.funds || []) {
    for (const h of (fund.holdings || [])) {
      const ind = stockToIndustry[h.code] || '未分类';
      if (!industryMap.has(ind)) {
        industryMap.set(ind, { name: ind, totalWeight: 0, fundCount: 0,
                               fundSet: new Set(), stocks: new Map(), fundDetails: new Map() });
      }
      const row = industryMap.get(ind);
      row.totalWeight += h.weight || 0;
      row.fundSet.add(fund.code);
      if (!row.stocks.has(h.code)) {
        row.stocks.set(h.code, { code: h.code, name: h.name, totalWeight: 0, fundCount: 0 });
      }
      const s = row.stocks.get(h.code);
      s.totalWeight += h.weight || 0;
      s.fundCount += 1;
      if (!row.fundDetails.has(fund.code)) {
        row.fundDetails.set(fund.code, { code: fund.code, name: fund.name,
                                          yearReturn: fund.yearReturn, totalWeight: 0, stocks: [] });
      }
      const fd = row.fundDetails.get(fund.code);
      fd.totalWeight += h.weight || 0;
      fd.stocks.push({ code: h.code, name: h.name, weight: h.weight });
    }
  }

  // 4) 排序：行业按 totalWeight 降序
  const industries = Array.from(industryMap.values())
    .map(r => ({
      name: r.name,
      totalWeight: Math.round(r.totalWeight * 10) / 10,
      fundCount: r.fundSet.size,
      topStocks: Array.from(r.stocks.values())
        .sort((a, b) => b.totalWeight - a.totalWeight)
        .slice(0, 5)
        .map(s => ({ code: s.code, name: s.name,
                    totalWeight: Math.round(s.totalWeight * 10) / 10, fundCount: s.fundCount })),
      funds: Array.from(r.fundDetails.values())
        .sort((a, b) => b.totalWeight - a.totalWeight)
        .map(fd => ({ code: fd.code, name: fd.name, yearReturn: fd.yearReturn,
                      totalWeight: Math.round(fd.totalWeight * 10) / 10,
                      stocks: fd.stocks.sort((a, b) => b.weight - a.weight) })),
    }))
    .sort((a, b) => b.totalWeight - a.totalWeight);

  const out = {
    ok: true,
    quarter: raw.quarter || '',
    fundCount: raw.funds ? raw.funds.length : 0,
    skipped: raw.skipped || 0,
    topN,
    industries,
    funds: (raw.funds || []).map(f => ({
      code: f.code, name: f.name, yearReturn: f.yearReturn, quarter: f.quarter,
      holdings: f.holdings,
    })),
    note: raw.note || '',
  };
  _setCache(key, out);
  return out;
}

module.exports = {
  getGlobalSentiment,
  interpretReport,
  searchAnnouncements,
  searchAnnouncementsByCode,
  getRegulatoryNews,
  getMonetaryPolicy,
  getFiscalData,
  getFundIndustryMatrix,
};
