// ============ 价格行为推演快照·唯一出口（20260905g） ============
// 数据一致性规则一·指标级单源：「技术面分析」页(/api/price-action)、
// 短期行情判断(technicalShort 因子)、长期行情判断(technicalLong 因子)
// 统一从本模块取同一份价格行为快照，消除三处各自拉K线、各自缓存导致的跨页不一致。
//
// 缓存策略（沿用原 /api/price-action 语义）：
//   盘中（交易日 09:15–15:05）10 分钟；非盘中至当日结束（24h）。
//   拉取失败但存在旧快照时回退旧快照（陈旧快照优于空值，保证各页面不脱钩）。
//
// 20261020l：「关键位有效性检验」联动已整体下线（用户指出 20261020i 删错了模块——当时该删的是这张
// 「生死位规则口径」卡，却把箱体区块删了）。随之下线：getLevelValidity / _extractLevelValidity /
// _lvCache / LV_TIMEOUT_MS / analyzeVolume+getQuote 依赖，以及前端 ⑤ 卡、路由注入、样式与单测。
// 本模块回归「单箱体快照」单一职责：唯一出口 getPriceActionSnapshot（含 data.singleRange）。
const { getHistoryDeep, getHistoryPeriod } = require('./stockData');
const { analyzePriceAction } = require('./priceAction');
const { detectSingleRange } = require('./rangeDetector');   // 20261020j：单箱体模型（纯计算，零网络）
const { assessZone } = require('./zoneValidity');           // 20261021e：手动区间同样过两条有效性检验
const manualZones = require('./manualZones');               // 20261021d：用户手动阻力/支撑

const _cache = new Map(); // symbol -> { ts, data }

function _inTradingHours(now) {
  const hk = now.getHours() * 100 + now.getMinutes();
  const wd = now.getDay();
  return wd >= 1 && wd <= 5 && hk >= 915 && hk <= 1505;
}

/**
 * 20261021e：把手动区间接进短期清单，并**同样跑本模块的两条有效性检验**（用户 2026-10-21 要求）。
 * ----------------------------------------------------------
 * 用 `assessZone`（与模型区间同一个函数、同一份日K、同一窗口、同一阈值），因此「无放量轻松突破」
 * 与「三天来回穿越」这两条对用户自填的位同样生效——无效的会被前端按 valid!==false 过滤掉，
 * 但在「手动添加」页签里仍会显示并注明无效原因（那是用户自己录的，不能悄悄消失）。
 *
 * 三条边界：
 *   ① **不参与侵蚀**：用户只要求「两个有效性检验」，侵蚀是另一套规则；这里 append 在
 *      `erodeZones` 之后，所以手动区间不会被收缩。
 *   ② **不参与方向/概率/④卡反转边界/准确率**：这些在 `analyzePriceAction` 内部、本函数之前就
 *      算完了（`calcFalsification` 用它自己的区间），append 只影响展示层，不回头改结论。
 *   ③ 单点区间（low===high）照常过检验；脏数据由 assessZone 自身兜底（透传有效、不判死）。
 */
function attachManualZones(data, daily, symbol) {
  if (!data || !data.shortTerm || !Array.isArray(daily) || daily.length < 2) return data;
  let store;
  try {
    store = manualZones.listZones(symbol);
  } catch (e) {
    console.warn('[PriceAction] 手动区间读取失败（本次不并入）:', e && e.message ? e.message : e);
    return data;
  }
  const mk = (z, side) => {
    const r = assessZone(daily, { low: z.low, high: z.high }, side);
    return {
      low: z.low,
      high: z.high,
      source: z.note || '手动添加',
      isManual: true,
      manualId: z.id,
      valid: r.valid,
      invalidReasons: r.invalidReasons,
      zoneCheck: r.zoneCheck,
    };
  };
  const res = (store.resistances || []).map(z => mk(z, 'resistance'));
  const sup = (store.supports || []).map(z => mk(z, 'support'));
  data.shortTerm.resistances = (data.shortTerm.resistances || []).concat(res);
  data.shortTerm.supports = (data.shortTerm.supports || []).concat(sup);
  data.manualZonesMeta = {
    total: res.length + sup.length,
    valid: res.concat(sup).filter(z => z.valid !== false).length,
    invalid: res.concat(sup).filter(z => z.valid === false).length,
    note: '手动区间与模型区间走同一条有效性检验；但不参与侵蚀收缩，也不影响方向与概率。',
  };
  return data;
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
    // 20261020j：单箱体模型重新接入（20261020i 曾整体下线固定多窗口版本）。
    // 计算位置说明（LRN-20261020-006 三问）：
    //   ① 本快照被 sameDayJudgment 的 technicalShort/Long 消费 → 不得让展示需求拖入新依赖；
    //      而单箱体是**纯函数、零网络**，输入就是本函数已拉到的 daily，新增字段对既有消费者惰性，
    //      故放在快照内（与旧 ranges 位置一致），而非路由层二次拉取。
    //   ② 与「阻力/支撑区间有效性检验」（lib/zoneValidity.js）是两套完全独立的口径，前端须同屏声明。
    //   ③ 失败只降级本区块（singleRange=null），不阻塞价格行为主链路。
    try {
      data.singleRange = detectSingleRange(daily);
    } catch (e) {
      data.singleRange = null;
      console.warn('[PriceAction] 单箱体检测失败（该区块降级隐藏）:', e && e.message ? e.message : e);
    }
    // 20261021e：手动区间并入短期清单（含两条有效性检验）。放在缓存之前——
    // 增删手动区间时会 invalidateSnapshot(symbol) 让本快照重算，否则用户加完要等缓存过期才看见。
    try {
      attachManualZones(data, daily, symbol);
    } catch (e) {
      console.warn('[PriceAction] 手动区间并入失败（该部分降级为空）:', e && e.message ? e.message : e);
    }
    _cache.set(symbol, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;
    return { error: '价格行为推演失败：' + (e && e.message ? e.message : e) };
  }
}

// 20261020l：getLevelValidity / _extractLevelValidity 已整体删除（用户要求下线「关键位有效性检验」卡与其联动）
/**
 * 20261021e：丢弃某只股票的快照缓存。
 * 手动区间增删后必须调用——否则快照里的 `shortTerm.resistances` 还是旧的那一份，
 * 用户加完看不到、删完还在（他要等 24h 缓存过期）。只丢这一只，不影响其他标的。
 */
function invalidateSnapshot(symbol) {
  try { _cache.delete(symbol); } catch (e) {}
}

module.exports = { getPriceActionSnapshot, invalidateSnapshot, attachManualZones };
