/**
 * 估值分析 · 统一数据网关（三条底层铁律的样板实现）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：估值指标只从 eastmoneyValuation（东财 RPT_VALUEANALYSIS_DET）取，
 *     本模块是该指标在工作台内的唯一出口，其他模块禁止自行取数。
 *   - 五要素身份：每个指标携带 { name, value, dataTime, source, fetchTime }。
 *   - 分析期锁定：beginSnapshot() 冻结一次分析所用数据，中途源更新不影响本次分析。
 * 规则二 数据最新性：按类型有效期；体检；过期必带「数据已过期，最后更新时间是 X」；异常值拒收。
 * 规则三 变化与边际分析：变化率、边际变化、方向 + 幅度 + 边际三维度、特殊信号标注。
 *
 * 注：通用原语全部复用 ./ruleCore，本文件只保留估值业务特有的取数与组装，
 *     避免同一套规则逻辑在多个 Hub 里各实现一份而产生口径分叉。
 * ============================================================================
 */
const { fetchValuationTTM } = require('./eastmoneyValuation');
const core = require('./ruleCore');

const {
  TTL, makeDatum, beginSnapshot,
  checkFreshness, staleLabel, validateSane,
  analyzeSeries, analyzeWindow, assertAnalysis,
} = core;

// 估值口径归类：最新 TTM 随交易日更新 → 日线；历史年度序列属财务属性 → 财务
const KIND = { latest: 'daily', series: 'financial' };

/**
 * 生成「规则合规」的估值描述片段，供 deepAnalysis 等模块直接拼接。
 * 内容 = 数值 + 来源 + 数据时间（规则一②/二）+ 方向·幅度·边际（规则三④）
 * @returns {string|null} 规则不可用（无快照）时返回 null，调用方应回退原逻辑
 */
function formatValuationLine(rules, metric) {
  const m = String(metric || '').toUpperCase();
  if (!rules || !rules.latest || !rules.analysis) return null;
  const d = rules.latest[m.toLowerCase()];
  const a = rules.analysis[m];
  if (!d || d.value == null) return null;

  const fresh = rules.freshness && rules.freshness.latest;
  const stale = (fresh && fresh.expired && rules.staleNote) ? `；⚠️ ${rules.staleNote}` : '';
  const base = `${d.name} ${d.value}（来源：${d.source}，数据时间 ${d.dataTime}${stale}）`;
  // 三规则集中硬闸门：分析不可用（序列不足/校验未过）→ 不输出方向性结论，仅给数值
  try {
    assertAnalysis(a, `估值${m}`);
  } catch (e) {
    if (e.name === 'RuleNotSatisfied') return base;
    throw e;
  }
  return `${base}；${a.text}`;
}

/**
 * 主入口：获取「三规则合规」的估值分析数据
 * @param {string} symbol 形如 sh601318 / 601318
 * @param {Object} opts { prevLatest } prevLatest 用于异常值校验的前值
 */
async function getValuationHub(symbol, opts = {}) {
  const nowIso = new Date().toISOString();
  let raw = null, fetchError = null;
  try {
    raw = await fetchValuationTTM(symbol);
  } catch (e) {
    fetchError = e.message;
  }

  // 规则二④：抓取失败 → 无有效数据，明确标注且不编造、不推测
  if (!raw) {
    return {
      ok: false,
      error: fetchError || '未获取到估值数据',
      note: '⚠️ 未能获取估值数据，本次不输出估值结论（规则：无有效数据不得分析）。',
      fetchedAt: nowIso,
    };
  }

  const src = raw.source || '东方财富TTM';
  const fetchTime = raw.fetchedAt || nowIso;
  const latestDate = (raw.latest && raw.latest.date) || null;

  // 规则一②：五要素化最新估值
  const latest = {
    pe: makeDatum('PE(TTM)', raw.latest.pe, latestDate, src, fetchTime),
    pb: makeDatum('PB(MRQ)', raw.latest.pb, latestDate, src, fetchTime),
    ps: makeDatum('PS(TTM)', raw.latest.ps, latestDate, src, fetchTime),
  };

  // 规则二③：异常值校验（与上一次已知值比对）
  const sanity = {};
  if (opts.prevLatest) {
    ['pe', 'pb', 'ps'].forEach(k => {
      const r = validateSane(opts.prevLatest[k], latest[k].value);
      sanity[k] = r;
      if (!r.ok) latest[k].rejected = true; // 标记但不静默替换
    });
  }

  // 规则二②：时效体检（最新值按日频口径且开启交易日感知）
  const freshness = {
    latest: checkFreshness(latestDate, KIND.latest, Date.now(), { tradingDayAware: true }),
    series: checkFreshness(latestDate, KIND.series, Date.now(), { tradingDayAware: true }),
  };
  const staleNote = freshness.latest.expired ? staleLabel(latestDate) : '';

  // 规则三：年度序列（相邻期）+ 日频近 20 交易日（窗口首尾）
  const mk = (arr, key) => arr.map(s => ({ date: s.date, value: s[key], source: src, fetchTime }));
  const analysis = {
    PE: analyzeSeries(mk(raw.series || [], 'pe'), 'PE(TTM)'),
    PB: analyzeSeries(mk(raw.series || [], 'pb'), 'PB(MRQ)'),
    PS: analyzeSeries(mk(raw.series || [], 'ps'), 'PS(TTM)'),
  };

  const daily = raw.daily || [];
  const recent20 = daily.slice(-20);
  const shortTerm = {
    PE: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.pe })), 'PE(TTM)·近20交易日'),
    PB: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.pb })), 'PB(MRQ)·近20交易日'),
    PS: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.ps })), 'PS(TTM)·近20交易日'),
  };

  return {
    ok: true,
    symbol,
    latest,
    sanity,
    freshness,
    staleNote,
    analysis,
    shortTerm,
    dailyPoints: daily.length,
    source: src,
    fetchedAt: fetchTime,
    ttl: TTL,
  };
}

module.exports = {
  getValuationHub,
  formatValuationLine,
  beginSnapshot,
  // 透传内核能力，便于其它模块直接复用（保持原导出兼容）
  analyzeSeries,
  analyzeWindow,
  checkFreshness,
  validateSane,
  staleLabel,
  TTL,
  _internal: {
    changeRate: core.changeRate,
    classifyDirection: core.classifyDirection,
    classifyAccel: core.classifyAccel,
    marginalStreak: core.marginalStreak,
    makeDatum: core.makeDatum,
  },
};
