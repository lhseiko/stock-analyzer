/**
 * lib/deep/yield.js —— deepAnalysis 领域子模块：股息率趋势（近10年序列 + 均值±σ统计 + 保险同业对比）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 统一算法：历史年度股息率 = 全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日收盘价×当年总股本)。
 */
const axios = require('axios');
const { getQuote, detectMarket } = require('../stockData');
const { isInsuranceCompany } = require('../insuranceAnalysis');
const { UA, _calcStats } = require('./shared');
const { fetchDividends, aggregateAnnualDPS } = require('./dividends');

// ---- Dividend Yield Analysis (Section: 股息率趋势) ----
// 取原始不复权日线（bfq）：返回 [{date, close}]。腾讯该接口单笔最多约 2000 根，
// 超过会被截断/返回空，故用 end 参数把窗口向前平移以拼接更早的数据。
// 腾讯 K 线 param 格式：CODE,period,start,end,count,adj（start/end 缺省留空）
async function fetchBfqBars(tencentCode, count, endDate) {
  const endParam = endDate || '';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,${endParam},${count},bfq`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 12000,
    });
    const node = resp.data?.data?.[tencentCode];
    const dayData = node?.day || [];
    if (!Array.isArray(dayData) || dayData.length === 0) return [];
    return dayData.map(d => ({ date: d[0], close: parseFloat(d[2]) })).filter(b => b.close > 0);
  } catch (e) {
    console.error('[DeepAnalysis] fetchBfqBars failed:', e.message);
    return [];
  }
}

// 取某股票近 N 年「全部不复权日线」并排序返回 [{date, close}]（供「年报发布日收盘价」与「年末收盘价」两种口径共用）
async function fetchAllBfqBars(tencentCode, years = 11) {
  const curYear = new Date().getFullYear();
  const targetStartYear = curYear - years + 1;
  try {
    const all = [];
    const recent = await fetchBfqBars(tencentCode, 2000, null);
    all.push(...recent);
    // 循环向前平移补数据，直到覆盖目标起始年或无法继续（最多 6 次，防死循环）
    let attempts = 0;
    while (attempts < 6 && all.length) {
      const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
      const minYear = parseInt(sorted[0].date.slice(0, 4), 10);
      if (minYear <= targetStartYear) break;
      const older = await fetchBfqBars(tencentCode, 1000, sorted[0].date);
      if (!older || older.length === 0) break;
      const olderMinYear = parseInt(older[0].date.slice(0, 4), 10);
      if (olderMinYear >= minYear) break;
      all.push(...older);
      attempts++;
    }
    if (all.length === 0) return [];
    const seen = new Set();
    const uniq = [];
    for (const b of all) { if (!seen.has(b.date)) { seen.add(b.date); uniq.push(b); } }
    uniq.sort((a, b) => a.date.localeCompare(b.date));
    return uniq;
  } catch (e) {
    console.error('[DeepAnalysis] fetchAllBfqBars failed:', e.message);
    return [];
  }
}

// 取不晚于 dateStr 的最近一根日线收盘价（发布日若恰为非交易日，取前一交易日）
function closeOnOrBefore(bars, dateStr) {
  if (!bars || bars.length === 0) return 0;
  let best = null;
  for (const b of bars) { if (b.date <= dateStr) best = b; else break; }
  return best ? best.close : bars[0].close;
}

// 取某自然年最后一根日线收盘价（年末收盘价，兜底口径）
function yearEndCloseFromBars(bars, y) {
  if (!bars || bars.length === 0) return 0;
  let best = null;
  for (const b of bars) { if (b.date.startsWith(y)) best = b; }
  return best ? best.close : 0;
}

// 取各年报的「发布日」(NOTICE_DATE)：东方财富业绩报表 RPT_LICO_FN_CPD，年报(REPORTDATE 以 -12-31 结尾)
async function fetchReportPublishDates(code) {
  const stockCode = String(code || '').replace(/^(SH|SZ)/i, '').toUpperCase();
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=80&pageNumber=1&reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE,REPORTDATE,NOTICE_DATE&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000,
    });
    const arr = resp.data?.result?.data || [];
    const map = {};
    for (const d of arr) {
      const rd = d.REPORTDATE;
      if (!rd || rd.length < 10) continue;
      const y = rd.slice(0, 4);
      if (!rd.startsWith(y + '-12-31')) continue; // 仅取年报（报告期 12-31）
      const notice = (d.NOTICE_DATE || '').slice(0, 10);
      if (!notice) continue;
      map[y] = notice;
    }
    return map; // { '2024': '2025-03-20', ... }
  } catch (e) {
    console.error('[DeepAnalysis] fetchReportPublishDates failed:', e.message);
    return {};
  }
}

// 当前股息率（快照，TTM 口径）= 最近 12 个月实际除息的每股分红之和 ÷ 当前股价
// 比「最近一个完整年度分红」更稳健：当最新财年期末分红尚未实施时，不会漏算已实施的期初分红，避免低估。
function computeCurrentYield(dividends, price) {
  if (!price || price <= 0) return 0;
  const today = new Date();
  const oneYearAgo = new Date(today.getTime() - 365 * 24 * 3600 * 1000);
  let ttm = 0;
  for (const d of (dividends || [])) {
    if (!d.exDate) continue;
    const ex = new Date(d.exDate);
    if (isNaN(ex.getTime())) continue;
    if (ex >= oneYearAgo && ex <= today) ttm += parseFloat(d.dividendPerShare) || 0;
  }
  if (ttm <= 0) {
    // 兜底：最近一个完整年度累计分红
    const map = aggregateAnnualDPS(dividends);
    const curYear = today.getFullYear();
    const years = Object.keys(map).filter(y => map[y] > 0 && parseInt(y, 10) < curYear).sort();
    if (years.length) ttm = map[years[years.length - 1]];
  }
  if (ttm <= 0) return 0;
  return Math.round(ttm / price * 10000) / 100;
}

// 保险行业主要同业当前股息率对比（中国人寿/太保/新华/人保）
async function buildInsuranceIndustryYield(symbol, dividends, quote, companyCurrentYield) {
  const peers = [
    { code: 'SH601628', name: '中国人寿' },
    { code: 'SH601601', name: '中国太保' },
    { code: 'SH601336', name: '新华保险' },
    { code: 'SH601319', name: '中国人保' },
  ];
  const results = [{ code: symbol, name: (quote && quote.name) || '本公司', yield: companyCurrentYield, isSelf: true }];
  const fetchPeer = async (p) => {
    const [q, div] = await Promise.all([
      getQuote(p.code).catch(() => null),
      fetchDividends(p.code).catch(() => []),
    ]);
    if (!q || !q.price) return null;
    return { code: p.code, name: p.name || q.name, yield: computeCurrentYield(div, q.price), isSelf: false };
  };
  const settled = await Promise.allSettled(peers.map(fetchPeer));
  for (const s of settled) if (s.status === 'fulfilled' && s.value) results.push(s.value);
  const valid = results.filter(r => r.yield > 0);
  if (valid.length === 0) return null;
  const avg = Math.round(valid.reduce((a, r) => a + r.yield, 0) / valid.length * 100) / 100;
  const sorted = [...valid].sort((a, b) => b.yield - a.yield);
  const rank = sorted.findIndex(r => r.isSelf) + 1;
  return { name: '保险行业', avg, peers: sorted, companyRank: rank, total: valid.length };
}

// 主函数：构建 10 年股息率序列 + 统计量 + 行业对比
// 统一算法：历史年度股息率 = 全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日收盘价×当年总股本)
async function analyzeDividendYield(dividends, quote, symbol, name) {
  try {
    // 1. 全年分红金额(元)：按报告年份汇总 Σ(每股分红 × 总股本)；校准特别股息(股本=0)用当年最大股本兜底
    const amountByYear = {};
    const sharesByYear = {};
    for (const d of (dividends || [])) {
      if (!d.year) continue;
      const y = d.year;
      const dps = parseFloat(d.dividendPerShare) || 0;
      const shares = parseFloat(d.totalShares) || 0;
      if (shares > 0) sharesByYear[y] = Math.max(sharesByYear[y] || 0, shares);
      const usedShares = shares > 0 ? shares : (sharesByYear[y] || 0);
      amountByYear[y] = (amountByYear[y] || 0) + dps * usedShares;
    }

    // 2. 年报发布日（NOTICE_DATE）
    const publishDates = await fetchReportPublishDates(symbol);

    // 3. 不复权日线（取收盘价）
    const info = detectMarket(symbol);
    const bars = info && info.tencentCode ? await fetchAllBfqBars(info.tencentCode, 11) : [];

    const curYear = new Date().getFullYear();
    // 已完成年度：有分红金额、且报告年 < 当前年
    const years = Object.keys(amountByYear)
      .filter(y => amountByYear[y] > 0 && parseInt(y, 10) < curYear)
      .sort();
    const series = [];
    for (const y of years) {
      const sharesY = sharesByYear[y] || 0;
      const publishDate = publishDates[y];
      let close = 0, marketCap = 0, basis = 'notice';
      if (publishDate && sharesY > 0 && bars.length) {
        close = closeOnOrBefore(bars, publishDate);
        marketCap = close * sharesY;
      } else {
        // 兜底：无发布日时用年末收盘价（分母口径变化，note 中标注）
        close = yearEndCloseFromBars(bars, y);
        marketCap = close * sharesY;
        basis = 'yearend';
      }
      if (marketCap > 0) {
        series.push({
          year: y,
          yield: Math.round(amountByYear[y] / marketCap * 10000) / 100,
          dividendAmount: Math.round(amountByYear[y] / 1e8 * 100) / 100, // 亿元
          marketCap: Math.round(marketCap / 1e8 * 100) / 100,            // 亿元
          publishDate: publishDate || '',
          close: Math.round(close * 100) / 100,
          basis,
        });
      }
    }
    if (series.length === 0) {
      return { series: [], stats: { mean: 0, std: 0, high: 0, low: 0 }, latest: null, current: null, industry: null, note: '暂无可用的分红或价格数据' };
    }
    // 近10年：取最近的 10 个已完成年度
    const capped = series.slice(-10);
    const stats = _calcStats(capped.map(s => s.yield));
    const current = computeCurrentYield(dividends, quote && quote.price);
    // 当前市值(元)：当前价 × 最新股本
    const latestShares = (() => {
      const sorted = [...(dividends || [])].filter(d => parseFloat(d.totalShares) > 0)
        .sort((a, b) => String(a.exDate || '').localeCompare(String(b.exDate || '')));
      return sorted.length ? parseFloat(sorted[sorted.length - 1].totalShares) : 0;
    })();
    const currentMarketCap = (quote && quote.price && latestShares) ? quote.price * latestShares : 0;
    let industry = null;
    if (isInsuranceCompany(symbol, name, quote)) {
      industry = await buildInsuranceIndustryYield(symbol, dividends, quote, current);
    }
    const fallbackCount = capped.filter(s => s.basis === 'yearend').length;
    return {
      series: capped,
      stats,
      latest: capped[capped.length - 1],
      current: { yield: current, marketCap: Math.round(currentMarketCap / 1e8 * 100) / 100 },
      industry,
      note: `历史年度股息率统一算法：全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日不复权收盘价 × 当年总股本)。当前股息率 = 最近12个月实际除息分红(TTM) ÷ 当前公司市值。分红/股本源自东方财富分红明细并对中国平安 2018 特别股息做校准；年报发布日源自东方财富业绩报表(NOTICE_DATE)；收盘价源自腾讯行情(不复权)。${fallbackCount ? `其中 ${fallbackCount} 个年度缺发布日，已用年末收盘价兜底。` : ''}`,
    };
  } catch (e) {
    console.error('[DeepAnalysis] analyzeDividendYield failed:', e.message);
    return { series: [], stats: { mean: 0, std: 0, high: 0, low: 0 }, latest: null, current: null, industry: null, note: '股息率分析暂不可用：' + e.message };
  }
}

module.exports = { analyzeDividendYield };
