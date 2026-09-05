/**
 * 行情 · 统一数据网关（三条底层铁律铺开：行情模块）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：当前价/昨收/涨跌幅只从 stockData.getQuote（腾讯 qt.gtimg.cn）取。
 *     此前 deepAnalysis 内 currentPrice 存在「quote.price」与「history末日close」两套取法，
 *     同一指标两个值——本网关收口为唯一出口，消除该违规。
 *   - 五要素身份 + 分析期快照锁定（beginSnapshot）。
 * 规则二 数据最新性：实时行情 5 分钟有效期 + 交易日感知；过期必带标注；异常值拒收。
 * 规则三 变化与边际分析：
 *   - 变化率 = 当日涨跌幅（相对昨收）；
 *   - 边际 = 当日涨跌幅 − 上一交易日涨跌幅（加速/减速）；
 *   - 方向性变化（涨转跌/跌转涨/横盘突破）+ 连续同向边际的趋势强化信号。
 * 通用原语全部复用 ./ruleCore，本文件只做行情取数与序列组装。
 * ============================================================================
 */
const { getQuote, getHistory } = require('./stockData');
const core = require('./ruleCore');

const {
  TTL, makeDatum, beginSnapshot, changeRate,
  checkFreshness, staleLabel, validateSane,
  analyzeSeries, analyzeWindow,
} = core;

const SOURCE = '腾讯行情(qt.gtimg.cn)';

/**
 * 把「已获取」的 quote / history 包装为规则合规结构——**不发起任何网络请求**。
 * 规则一要求同一指标只取一次：deepAnalysis 等模块已持有 quote/history，
 * 若再调 getQuoteHub 会二次请求，两次之间价格可能变动而自相矛盾。故提供本函数收口。
 * @param {Object} q        getQuote 返回的行情对象
 * @param {Array}  history  日线数组（可选，用于边际分析）
 * @param {Object} opts     { prevPrice }
 */
function wrapQuote(q, history, opts = {}) {
  if (!q || !q.price) return null;

  const fetchTime = new Date().toISOString();
  const dataTime = q.date + (q.time ? ' ' + q.time : '');

  // 规则一②：五要素
  const latest = {
    price: makeDatum('当前价', q.price, dataTime, SOURCE, fetchTime),
    prevClose: makeDatum('昨收', q.prevClose, dataTime, SOURCE, fetchTime),
    changePct: makeDatum('当日涨跌幅(%)', q.changePct, dataTime, SOURCE, fetchTime),
  };

  // 规则二③：异常值校验
  const sanity = {};
  if (opts.prevPrice) {
    const r = validateSane(opts.prevPrice, q.price);
    sanity.price = r;
    if (!r.ok) latest.price.rejected = true;
  }

  // 规则二②：实时行情 5 分钟有效期 + 交易日感知
  const freshness = checkFreshness(dataTime, 'quote', Date.now(), { tradingDayAware: true });
  const staleNote = freshness.expired ? staleLabel(dataTime) : '';

  // 规则三：日线 + 当日行情 → 连续收盘序列（复用内核，不重写规则逻辑）
  const series = (history || [])
    .filter(d => d && d.date && d.close > 0)
    .map(d => ({ date: d.date, value: Number(d.close), source: SOURCE, fetchTime }));

  // 行情日尚未进入日线（盘中/当日未收盘）时，把当日价追加为最后一个点
  if (series.length && series[series.length - 1].date !== q.date && q.price > 0) {
    series.push({ date: q.date, value: q.price, source: SOURCE, fetchTime });
  }

  const analysis = analyzeSeries(series, '收盘价');
  const shortTerm = analyzeWindow(series.slice(-20), '收盘价·近20交易日');

  return {
    ok: true,
    symbol: q.code || null,
    name: q.name,
    latest, sanity, freshness, staleNote,
    analysis, shortTerm,
    dayChange: {
      today: q.changePct != null ? q.changePct : null,
      prevDay: (series.length >= 3)
        ? changeRate(series[series.length - 2].value, series[series.length - 3].value)
        : null,
    },
    dataTime, source: SOURCE, fetchedAt: fetchTime, ttl: TTL,
  };
}

/**
 * 独立使用入口（如 API 端点）：内部取数后转交 wrapQuote，保证只有一条取数路径。
 */
async function getQuoteHub(symbol, opts = {}) {
  const fetchTime = new Date().toISOString();
  let q = null, fetchError = null;
  try {
    q = await getQuote(symbol);
  } catch (e) {
    fetchError = e.message;
  }
  if (!q || !q.price) {
    return {
      ok: false,
      error: fetchError || '未获取到行情数据',
      note: '⚠️ 未能获取行情数据，本次不输出行情结论（规则：无有效数据不得分析）。',
      fetchedAt: fetchTime,
    };
  }
  let hist = [];
  if (opts.withHistory !== false) {
    try {
      hist = (await getHistory(symbol, '3m')) || [];
    } catch (e) {
      hist = []; // 日线取不到不影响行情主数据，仅降级边际分析
    }
  }
  return wrapQuote(q, hist, opts);
}

/**
 * 生成「规则合规」的行情描述片段（数值 + 来源 + 数据时间 + 方向/幅度/边际）
 */
function formatQuoteLine(hub, field = 'price') {
  if (!hub || !hub.latest) return null;
  const d = hub.latest[field];
  if (!d || d.value == null) return null;
  const stale = (hub.freshness && hub.freshness.expired && hub.staleNote) ? `；⚠️ ${hub.staleNote}` : '';
  const base = `${d.name} ${d.value}（来源：${d.source}，数据时间 ${d.dataTime}${stale}）`;
  const a = hub.analysis;
  if (!a || !a.available) return base;
  return `${base}；${a.text}`;
}

module.exports = {
  getQuoteHub,
  wrapQuote,
  formatQuoteLine,
  beginSnapshot,
  TTL,
};
