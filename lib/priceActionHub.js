// ============ 价格行为推演快照·唯一出口（20260905g） ============
// 数据一致性规则一·指标级单源：「技术面分析」页(/api/price-action)、
// 短期行情判断(technicalShort 因子)、长期行情判断(technicalLong 因子)
// 统一从本模块取同一份价格行为快照，消除三处各自拉K线、各自缓存导致的跨页不一致。
//
// 缓存策略（沿用原 /api/price-action 语义）：
//   盘中（交易日 09:15–15:05）10 分钟；非盘中至当日结束（24h）。
//   拉取失败但存在旧快照时回退旧快照（陈旧快照优于空值，保证各页面不脱钩）。
const { getHistoryDeep, getHistoryPeriod } = require('./stockData');
const { analyzePriceAction } = require('./priceAction');

const _cache = new Map(); // symbol -> { ts, data }

function _inTradingHours(now) {
  const hk = now.getHours() * 100 + now.getMinutes();
  const wd = now.getDay();
  return wd >= 1 && wd <= 5 && hk >= 915 && hk <= 1505;
}

/**
 * 取个股价格行为推演快照（analyzePriceAction 完整结果：longTerm/shortTerm/coordination/falsification）。
 * @param {string} symbol 六位股票代码
 * @param {object} opts { force: 强制刷新（忽略缓存重拉） }
 * @returns {object} analyzePriceAction 结果；失败时 { error: '...' }（或回退旧快照）
 */
async function getPriceActionSnapshot(symbol, opts = {}) {
  const force = !!(opts.force || opts.forceRefresh);
  const now = new Date();
  const ttl = _inTradingHours(now) ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const cached = _cache.get(symbol);
  if (!force && cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  try {
    const [dailyRes, h60Res] = await Promise.allSettled([
      getHistoryDeep(symbol, 2400),
      getHistoryPeriod(symbol, '60m', 400),
    ]);
    const daily = dailyRes.status === 'fulfilled' ? dailyRes.value : [];
    const h60 = h60Res.status === 'fulfilled' ? h60Res.value : [];
    if (!daily || daily.length < 60) {
      // 拉取失败但有旧快照：沿用以保证各页面不脱钩
      if (cached) return cached.data;
      return { error: 'K线数据不足，无法进行价格行为推演' };
    }
    const data = analyzePriceAction(daily, h60 && h60.length ? h60 : null);
    _cache.set(symbol, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;
    return { error: '价格行为推演失败：' + (e && e.message ? e.message : e) };
  }
}

module.exports = { getPriceActionSnapshot };
