/**
 * 长期行情判断引擎（长期走势 / 价值取向，非次日涨跌）
 * --------------------------------------------------------------
 * 与「短期行情」不同，本模块回答的是「这只股票中长期（约 3~12 个月）是否值得看多」，
 * 不做次日涨跌预测，也暂不核算准确率。四因子：
 *   1) 公司基本面      (fundamentalAnalysis：估值/盈利/成长/财务健康综合评分)
 *   2) 行业前景        (industryAnalysis.policy：国家政策扶持级别与规划)
 *   3) 对标期货长期走势 (futuresData：期货长期区间涨跌幅 × 与股价相关性)
 *   4) 大盘及行业板块长期走势 (主要指数 60 日趋势 + 个股所属行业板块)
 *
 * 更新机制：每次打开工作台（前端请求本模块）即通过 AI 联网抓取最新基本面/行业/新闻，
 * 即时重算，不落盘历史、不核算准确率。仅做进程内短时缓存（约 5 分钟）避免重复请求。
 *
 * 每个因子同样给出：方向(+1 看多 / -1 看空 / 0 中性)、权重、贡献分、取值、判断依据文字，
 * 保证「判断逻辑」完全可查看。
 */

const { getQuote, getHistory, getHistoryDeep, getMarketOverview } = require('./stockData');
const { fundamentalAnalysis } = require('./analysis');
const { classifyCompanyType } = require('./companyType');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./futuresData');
const { industryAnalysis } = require('./industryAnalysis');
const { resolveSectorIdentity } = require('./sectorIdentity');
const { getSectorTrend } = require('./sectorTrend');
const { getNews } = require('./newsSearch');
const { analyzePriceAction } = require('./priceAction'); // 20260903o：技术面长期趋势因子引用其 longTerm
const { withImpact } = require('./ruleCore');

// ---- 工具 ----
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function normSymbol(s) { return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase(); }

const VERDICT_LABEL = { 涨: '看多', 跌: '看空', 震荡: '中性' };

// ---- 单因子计算 ----

// 1) 公司基本面：复用 fundamentalAnalysis 的综合评分（50 分 → 中性，100 → 强看多，0 → 强看空）
function factorFundamentals(fund) {
  if (fund && typeof fund.score === 'number') {
    const signal = clamp((fund.score - 50) / 50, -1, 1);
    const detail = `基本面综合评分 ${fund.score}/100（${fund.overall || '—'}，评级 ${fund.rating || '—'}）` +
      (fund.description ? `；${fund.description}` : '') +
      (fund.companyTypeName ? `；按「${fund.companyTypeName}」口径加权` : '');
    return { key: 'fundamentals', name: '公司基本面', weight: 0.280, signal, applicable: true,
      value: `${fund.score}/100 · ${fund.overall || '—'}`, detail };
  }
  return { key: 'fundamentals', name: '公司基本面', weight: 0.280, signal: 0, applicable: true,
    value: '—', detail: '基本面数据不足，按中性处理' };
}

// 2) 行业前景：industryAnalysis.policy 的国家政策扶持级别
function factorIndustryPolicy(policy) {
  if (policy && policy.level) {
    let signal = 0;
    const lv = policy.level;
    if (lv.includes('国家战略扶持')) signal = 1;
    else if (lv.includes('战略扶持')) signal = 0.7;
    else if (lv.includes('中性')) signal = 0;
    else if (lv.includes('受限')) signal = -0.7;
    const plans = (Array.isArray(policy.plans) && policy.plans.length) ? policy.plans.slice(0, 3).join('；') : '';
    const detail = `行业政策定位「${lv}」${plans ? '；' + plans : ''}` +
      (policy.summary ? `；${policy.summary}` : '');
    return { key: 'industry', name: '行业前景', weight: 0.200, signal, applicable: true,
      value: lv, detail };
  }
  return { key: 'industry', name: '行业前景', weight: 0.200, signal: 0, applicable: true,
    value: '—', detail: '行业政策信息不足，按中性处理' };
}

// 3) 对标期货长期走势：期货长期区间涨跌幅（整个统计区间）× 相关性强度
function factorFuturesLong(futures) {
  if (futures && futures.hasFutures && typeof futures.futuresChg === 'number') {
    const corr = typeof futures.correlation === 'number' ? futures.correlation : 0;
    // 方向语义修正（20260901a，与短期同源）：corr 为皮尔逊相关系数，可为负。
    // 原实现只取 |corr| 作强度，负相关个股方向被判反（期货涨却判该股看多）。
    const corrStrength = Math.abs(corr) >= 0.6 ? 1 : (Math.abs(corr) >= 0.35 ? 0.7 : (Math.abs(corr) >= 0.15 ? 0.4 : 0.2));
    const corrSigned = corrStrength * (corr >= 0 ? 1 : -1);
    const chg = futures.futuresChg;
    // 长期阈值更大（期货长期 ±15% 视为满格）
    const signal = clamp(chg / 15, -1, 1) * corrSigned;
    const detail = `对标 ${futures.futuresName || '期货'} 统计区间 ${chg >= 0 ? '+' : ''}${round(chg)}%（相关性 ${round(corr, 2)}，${futures.level || '—'}${futures.direction || ''}相关）→ ${signal > 0.05 ? '该股偏多' : signal < -0.05 ? '该股偏空' : '该股中性'}`;
    const value = `${chg >= 0 ? '+' : ''}${round(chg)}%`;
    return { key: 'futures', name: '对标期货长期走势', weight: 0.120, signal, applicable: true, value, detail };
  }
  return { key: 'futures', name: '对标期货长期走势', weight: 0.120, signal: 0, applicable: false,
    value: '不适用', detail: '该公司无直接对标期货，本因子不参与打分' };
}

// 4) 大盘及行业板块长期走势：主要指数 60 日趋势 + 所属行业板块
function factorMarketLong(marketLong, sector) {
  const idxs = (marketLong && Array.isArray(marketLong.indices)) ? marketLong.indices : [];
  const haveIdx = idxs.filter(i => typeof i.chg60d === 'number');
  let detail = '';
  let value = '';
  if (haveIdx.length) {
    const avg60 = avg(haveIdx.map(i => i.chg60d));
    // 指数部分信号
    const idxSignal = clamp(avg60 / 12, -1, 1);
    // 行业板块部分（当日板块涨跌，作为行业长期的最新状态）
    const secOk = sector && sector.ok && typeof sector.boardChange === 'number';
    const secChg = secOk ? sector.boardChange : 0;
    const secSignal = secOk ? clamp(secChg / 5, -1, 1) : 0;
    const signal = clamp(0.6 * idxSignal + 0.4 * secSignal, -1, 1);
    detail = `主要指数 60 日平均 ${avg60 >= 0 ? '+' : ''}${round(avg60)}%（${haveIdx.map(i => `${i.name}${i.chg60d >= 0 ? '+' : ''}${round(i.chg60d)}%`).join('、')}）` +
      (secOk ? `；所属「${sector.boardName || sector.industryName}」板块 ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${sector.upCount}/跌 ${sector.downCount}）` : '；行业板块数据暂缺');
    value = `指数60日 ${avg60 >= 0 ? '+' : ''}${round(avg60)}%`;
    return { key: 'market', name: '大盘及行业板块长期走势', weight: 0.200, signal, applicable: true, value, detail };
  }
  return { key: 'market', name: '大盘及行业板块长期走势', weight: 0.200, signal: 0, applicable: true,
    value: '—', detail: '指数长期数据不可用，按中性处理' };
}

// 5) 技术面长期趋势：引用价格行为趋势推演（lib/priceAction.analyzePriceAction）的 longTerm 输出，
// 与「技术面分析」页同源，保证数据一致性（规则一·指标级单源）。
// 权重暂定 0.200（与其他 4 因子等比缩放后合计=1.000），长期模块当前无准确率结算/自学习层（与既有设计一致）。
function factorTechnicalLong(pa) {
  const ltx = pa && pa.longTerm ? pa.longTerm : null;
  if (!ltx || typeof ltx.score !== 'number') {
    return {
      key: 'technicalLong', name: '技术面长期趋势', weight: 0.200,
      signal: 0, applicable: true, value: '—',
      detail: '技术面长期数据不足（K线<250 或价格行为推演未返回长期趋势），按中性处理。来源：价格行为趋势推演（周/月级别）',
    };
  }
  const signal = clamp(round(ltx.score, 3) / 4, -1, 1); // 趋势评分量级约 ±4.5，/4 限幅到 ±1
  const ma250 = ltx.ma250;
  const detail =
    `技术面长期趋势：${ltx.verdict}（趋势评分 ${ltx.score}）。` +
    (ma250 ? `年线MA250=${ma250.value}（${ma250.slopeState}，斜率${ma250.slopePct != null ? (ma250.slopePct >= 0 ? '+' : '') + ma250.slopePct : '—'}%，价格偏离${ma250.positionPct != null ? (ma250.positionPct >= 0 ? '+' : '') + ma250.positionPct : '—'}%）` : '年线数据不足') +
    (ltx.ma120 ? `；MA120=${ltx.ma120.value}` : '') +
    `；月线MACD=${ltx.monthlyMacd && ltx.monthlyMacd.zeroPos ? ltx.monthlyMacd.zeroPos : '—'}${ltx.monthlyMacd && ltx.monthlyMacd.lastCross ? `（${ltx.monthlyMacd.lastCross}）` : ''}` +
    `；月线结构=${ltx.structure || '—'}。来源：价格行为趋势推演（周/月级别），与「技术面分析」页同源。`;
  return {
    key: 'technicalLong', name: '技术面长期趋势', weight: 0.200,
    signal: round(signal, 3), applicable: true,
    value: ltx.verdict,
    detail,
  };
}

// ---- 汇总 ----
function combineFactors(factors) {
  const used = factors.filter(f => f.applicable);
  const wsum = used.reduce((a, f) => a + f.weight, 0) || 1;
  let total = 0;
  const out = factors.map(f => {
    const eff = f.applicable ? f.weight / wsum : 0;
    const contribution = round(eff * f.signal, 3);
    total += contribution;
    // 影响程度评分：与短期判断共用 ruleCore.withImpact 同一映射（规则一·指标级单源）
    return withImpact({ ...f, effectiveWeight: round(eff, 3), contribution });
  });
  total = round(total, 3);
  let dir = '震荡';
  if (total > 0.12) dir = '涨';
  else if (total < -0.12) dir = '跌';
  const agree = used.filter(f => f.signal !== 0 && Math.sign(f.signal) === Math.sign(total)).length;
  const mag = Math.abs(total);
  let confidence = '低';
  if (mag >= 0.35 && used.length && agree >= Math.ceil(used.length * 0.6)) confidence = '高';
  else if (mag >= 0.2) confidence = '中';
  return { factors: out, totalScore: total, dir, verdict: VERDICT_LABEL[dir], confidence };
}

// ---- 指数 60 日长期趋势 ----
// 拉取主要指数的日线，计算最近 60 个交易日的区间涨跌幅（约 3 个月长期趋势）。
const LONG_INDEX_CODES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000300', name: '沪深300' },
];
async function fetchIndexLongTerm() {
  const indices = await Promise.all(LONG_INDEX_CODES.map(async (idx) => {
    try {
      const hist = await getHistory(idx.code, '1y').catch(() => []);
      if (!hist || hist.length < 60) return { name: idx.name, chg60d: null };
      const last = hist[hist.length - 1];
      const base = hist[hist.length - 60];
      const chg60d = (last.close - base.close) / base.close * 100;
      return { name: idx.name, chg60d: round(chg60d, 2) };
    } catch (e) {
      return { name: idx.name, chg60d: null };
    }
  }));
  return { indices };
}

// ---- 进程内短时缓存（约 5 分钟），避免同一次打开重复联网抓取 ----
let _cache = {}; // key: symbol -> { ts, data }
const CACHE_TTL = 5 * 60 * 1000;

/**
 * 生成长期行情判断。
 * 每次调用都联网抓取最新数据（基本面/行业/新闻/期货/指数），即时重算，不落盘。
 */
async function buildLongTermJudgment(symbol, name) {
  const [quoteR, industryR, sectorIdR, futuresR, marketLongR, sectorR, newsR, dailyR] = await Promise.allSettled([
    getQuote(symbol),
    industryAnalysis(symbol, name || '').catch(() => null),
    resolveSectorIdentity(symbol, name || '').catch(() => null),
    Promise.resolve(getFuturesMeta(symbol) ? fetchFuturesCorrelation(symbol, name || '').catch(() => ({ hasFutures: false })) : { hasFutures: false }),
    fetchIndexLongTerm(),
    getSectorTrend(symbol, name || '', '').catch(() => null),
    getNews(symbol, name || '').catch(() => []),
    getHistoryDeep(symbol, 2400).catch(() => []), // 20260903o：技术面长期趋势因子（与「技术面分析」页同源，需≥250日K）
  ]);

  const quote = quoteR.status === 'fulfilled' ? quoteR.value : null;
  const ind = industryR.status === 'fulfilled' ? industryR.value : null;
  const sectorId = sectorIdR.status === 'fulfilled' ? sectorIdR.value : null;
  const futures = futuresR.status === 'fulfilled' ? futuresR.value : { hasFutures: false };
  const marketLong = marketLongR.status === 'fulfilled' ? marketLongR.value : { indices: [] };
  const sector = sectorR.status === 'fulfilled' ? sectorR.value : null;
  const news = newsR.status === 'fulfilled' ? newsR.value : [];
  const daily = dailyR && dailyR.status === 'fulfilled' ? dailyR.value : [];

  // 公司类型 + 基本面
  const companyType = quote
    ? classifyCompanyType(symbol, name || (quote.name || ''), quote, { income: [], balance: [], cashflow: [] }, null, [])
    : null;
  const fund = quote ? fundamentalAnalysis(quote, companyType) : null;

  // 行业名称：20260821c 统一走 sectorIdentity 单一可信源，industryAnalysis 仅用于政策/研报
  // 20260821e 修复：sectorIdentity 返回的 symbol 已 normalize，必须用 normSymbol 比较，
  // 避免带前缀 symbol 时丢弃正确行业、回退到可能错误的 industryAnalysis 结果。
  const sectorIdMatch = sectorId && normSymbol(sectorId.symbol) === normSymbol(symbol);
  let industryName = sectorIdMatch ? (sectorId.industry || '') : '';
  if (!industryName) {
    industryName = (ind && ind.industry && (ind.industry.name || ind.industry.induName)) || '';
  }

  // 若 sector 未定位板块（industry 为空时），用行业名再试一次
  let sectorData = sector;
  if ((!sectorData || !sectorData.ok) && industryName) {
    sectorData = await getSectorTrend(symbol, name || '', industryName).catch(() => null);
  }

  // 20260903o：技术面长期趋势因子——与「技术面分析」页同源（analyzePriceAction.longTerm，需≥250日K算MA250）
  const priceActionLong = (daily && daily.length >= 250)
    ? (() => { try { return analyzePriceAction(daily); } catch (e) { return null; } })()
    : null;
  const factors = [
    factorFundamentals(fund),
    factorIndustryPolicy(ind && ind.policy),
    factorFuturesLong(futures),
    factorMarketLong(marketLong, sectorData),
    factorTechnicalLong(priceActionLong),
  ];
  const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(factors);

  return {
    symbol,
    name: (quote && quote.name) || name || symbol,
    industry: industryName,
    date: localDate(),
    generatedAt: new Date().toISOString(),
    horizon: 'long',          // 长期
    horizonLabel: '中长期（约 3~12 个月）',
    verdict,
    dir,
    score: Math.round(totalScore * 100),
    confidence,
    factors: scored,
    autoUpdated: true,        // 每次打开自动联网更新
    newsCount: Array.isArray(news) ? news.length : 0,
    marketLong: marketLong.indices,
    source: 'AI 联网抓取 · 东方财富/同花顺/新浪期货/腾讯行情',
    // 三规则铺开：时效（日频）+ 当日涨跌与判断方向的一致性
    // ★ 20260902a：传入 dir，使 consistency 文字方向词与 verdict/dir 同源（修复口径冲突）
    rules: buildLongTermRules(quote, totalScore, localDate(), dir),
  };
}

/**
 * 长期判断三规则装饰器：时效 + 当日涨跌与判断方向是否同向
 *
 * ★ 20260902a 修复口径冲突（用户反馈"偏空却显示红色"根因）：
 *   原实现 `bullish = Math.round(totalScore*100) > 50` 与 dir 判定阈值（|total|>0.12，
 *   即 score>12 才"涨"）严重不一致。当 score 落在 (12,50] 时 dir="涨"→verdict 红色
 *   "看多"，但 consistency 文字却因 score<50 硬判"偏空"，形成"偏空配红字"的视觉矛盾。
 *   现直接用 dir 字段（与 combineFactors 同源）决定方向词，杜绝二次阈值分叉。
 */
function buildLongTermRules(quote, totalScore, fallbackDate, dir) {
  const core = require('./ruleCore');
  const dayChange = (quote && quote.prevClose > 0 && quote.price > 0)
    ? core.changeRate(quote.price, quote.prevClose) : null;
  let consistency = '无价格数据';
  if (dayChange != null) {
    // 与 dir 同源：dir='涨'→偏多 / dir='跌'→偏空 / dir='震荡'→中性，不再二次开阈值
    const bullish = dir === '涨';
    const bearish = dir === '跌';
    const dirWord = bullish ? '偏多' : bearish ? '偏空' : '中性';
    const up = dayChange > 0;
    if (bullish || bearish) {
      const sameDir = (bullish && up) || (bearish && !up);
      consistency = sameDir
        ? `判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）同向`
        : `⚠️ 判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）背离`;
    } else {
      // 中性区间不再被硬判"偏空"，避免 verdict 灰色却文字说偏空的口径错位
      consistency = `判断方向为中性，当日${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%`;
    }
  }
  return {
    ...core.decorateRules({
      dataTime: (quote && quote.date) ? quote.date : fallbackDate,
      source: 'AI 联网抓取 · 东方财富/同花顺/新浪期货/腾讯行情',
      kind: 'daily',
      series: (quote && quote.prevClose > 0 && quote.price > 0)
        ? [{ date: '昨收', value: quote.prevClose }, { date: '当前', value: quote.price }]
        : [],
      name: '价格',
    }),
    dayChange,
    consistency,
  };
}

/**
 * 对外入口：带 5 分钟进程内缓存，避免同一次打开重复联网。
 */
async function getLongTermJudgment(symbol, name, force = false) {
  const now = Date.now();
  const hit = _cache[symbol];
  if (!force && hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const data = await buildLongTermJudgment(symbol, name);
  _cache[symbol] = { ts: now, data };
  return data;
}

module.exports = { getLongTermJudgment, buildLongTermJudgment, VERDICT_LABEL, factorTechnicalLong };
