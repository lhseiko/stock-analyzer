/**
 * 三条底层铁律 · 共享内核
 * ============================================================================
 * 把「数据一致性 / 数据最新性 / 变化与边际分析」的通用原语集中在此，
 * 供各业务 Hub（valuationHub / quoteHub / …）复用，避免每个模块各实现一份
 * 而产生口径分叉。本文件不含任何业务取数逻辑。
 *
 * 规则一：makeDatum（五要素身份）、beginSnapshot（分析期锁定）
 * 规则二：TTL、checkFreshness（时效体检）、staleLabel（过期标注）、
 *        validateSane（异常值校验）、countTradingDaysBetween（交易日感知）
 * 规则三：changeRate、classifyDirection（方向性变化）、classifyAccel（边际）、
 *        marginalStreak（连续同向）、analyzeSeries（相邻期）、analyzeWindow（窗口首尾）
 * ============================================================================
 */

// ---------- 规则二①：数据有效期 ----------
const TTL = {
  quote: 5 * 60 * 1000,                  // 实时行情 5 分钟
  daily: 24 * 60 * 60 * 1000,            // 日线 24 小时
  weekly: 7 * 24 * 60 * 60 * 1000,       // 周线 7 天
  financial: 90 * 24 * 60 * 60 * 1000,   // 财务 90 天
  company: 30 * 24 * 60 * 60 * 1000,     // 公司基本信息 30 天
};

const FLAT_PCT = 1.0;      // |变化率| < 1% 视为横盘
const MARGIN_EPS = 0.5;    // 边际变化判定阈值（百分点）
const MAX_DEVIATION = 0.5; // 异常值校验：新旧偏离 > 50% 拒收

// ---------- 通用工具：限幅（被多模块复用，避免各写一份分叉） ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---------- 规则一②：五要素身份 ----------
function makeDatum(name, value, dataTime, source, fetchTime) {
  return {
    name,
    value: (typeof value === 'number' && isFinite(value)) ? Math.round(value * 100) / 100 : value,
    dataTime: dataTime || null,   // 数据对应的实际时间
    source: source || '未知',      // 来源
    fetchTime: fetchTime || new Date().toISOString(), // 获取时间
  };
}

// ---------- 规则一③：分析期数据快照（冻结） ----------
function beginSnapshot(data) {
  return Object.freeze(JSON.parse(JSON.stringify({ ...data, _snapshotAt: new Date().toISOString() })));
}

// ---------- 规则二：交易日感知 ----------
// 仅按周一至周五计（未含法定节假日，属可接受简化——节假日会保守判为过期，
// 不会把陈旧数据误判为新鲜）。
function countTradingDaysBetween(startDateStr, now = new Date()) {
  const start = new Date(startDateStr);
  if (isNaN(start.getTime())) return null;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const n = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let count = 0;
  const cur = new Date(s);
  cur.setDate(cur.getDate() + 1);
  while (cur <= n) {
    const wd = cur.getDay();
    if (wd !== 0 && wd !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * 日期格式归一化：兼容 YYYYMMDD（如 Python 侧 strftime('%Y%m%d') 输出）与 YYYY-MM-DD。
 * 不归一化的话 `new Date('20260830')` 会解析失败，导致时效体检误判为「缺少数据时间」
 * 进而错误标记过期——这是跨 Node/Python 边界的高频坑。
 */
function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

// ---------- 规则二②：时效体检 ----------
function checkFreshness(dataTime, kind, now = Date.now(), opts = {}) {
  const ttl = TTL[kind] || TTL.daily;
  const normalized = normalizeDate(dataTime);
  const t = normalized ? new Date(normalized).getTime() : 0;
  if (!t) {
    return { fresh: false, expired: true, ageMs: null, ttlMs: ttl, reason: '缺少数据时间' };
  }
  const ageMs = now - t;
  let expired = ageMs > ttl;
  let reason = expired ? '超过该类型有效期' : '在有效期内';

  // 交易日感知：行情/日频类数据按交易日更新。若数据日之后尚未出现新交易日
  // （如周五数据在周六/周日读取），该数据仍是最新可得，不应标记为过期。
  if (expired && opts.tradingDayAware) {
    const newDays = countTradingDaysBetween(normalized, new Date(now));
    if (newDays === 0) {
      expired = false;
      reason = '数据日之后尚无新交易日，该数据仍为最新可得';
    } else if (newDays != null) {
      reason = `数据日之后已过 ${newDays} 个交易日，超过该类型有效期`;
    }
  }
  return { fresh: !expired, expired, ageMs, ttlMs: ttl, dataTime: normalized, reason };
}

// ---------- 规则二④：过期标注 ----------
function staleLabel(dataTime) {
  const norm = normalizeDate(dataTime);
  const d = norm ? String(norm).slice(0, 10) : '未知';
  return `数据已过期，最后更新时间是 ${d}`;
}

// ---------- 规则二③：异常值校验 ----------
function validateSane(prev, next, maxDeviation = MAX_DEVIATION) {
  const p = Number(prev), n = Number(next);
  if (!isFinite(p) || !isFinite(n) || p <= 0) {
    return { ok: true, skipped: true, note: '无有效前值，跳过异常校验' };
  }
  const deviation = Math.abs(n - p) / p;
  if (deviation > maxDeviation) {
    return {
      ok: false,
      deviation: Math.round(deviation * 10000) / 100,
      note: `新旧值偏离 ${(deviation * 100).toFixed(1)}%，超过阈值 ${(maxDeviation * 100)}%，已拒收并保留原值`,
    };
  }
  return { ok: true, deviation: Math.round(deviation * 10000) / 100 };
}

// ---------- 规则三③：变化率 ----------
function changeRate(cur, prev) {
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p)) return null;
  // 基期为 0 或负时，(cur-prev)/prev 的符号会翻转、结果无意义
  // （例：-2 → 3 明明是改善，公式却给出 -250%）。此时返回 null，
  // 由调用方改用「绝对变化」描述，避免输出方向相反的错误结论。
  if (p <= 0) return null;
  return Math.round((c - p) / p * 10000) / 100;
}

// ---------- 规则三①：方向性变化 ----------
function classifyDirection(rates) {
  if (!Array.isArray(rates) || rates.length < 2) return '数据不足';
  const last = rates[rates.length - 1];
  const prev = rates[rates.length - 2];
  if (last == null || prev == null) return '数据不足';
  const isUp = r => r > FLAT_PCT;
  const isDown = r => r < -FLAT_PCT;
  const isFlat = r => !isUp(r) && !isDown(r);

  if (rates.length >= 3) {
    const earlier = rates.slice(Math.max(0, rates.length - 4), rates.length - 1);
    if (earlier.length >= 2 && earlier.every(isFlat) && isUp(last)) return '横盘突破';
  }
  if (isUp(prev) && isDown(last)) return '涨转跌';
  if (isDown(prev) && isUp(last)) return '跌转涨';
  if (isUp(last)) return '持续上涨';
  if (isDown(last)) return '持续下跌';
  return '横盘整理';
}

// ---------- 规则三②：边际（加速/减速） ----------
function classifyAccel(rate, prevRate) {
  if (rate == null || prevRate == null) return '数据不足';
  const marginal = Math.round((rate - prevRate) * 100) / 100;
  if (rate > 0) {
    if (marginal > MARGIN_EPS) return '上涨加速';
    if (marginal < -MARGIN_EPS) return '上涨减速';
    return '上涨平稳';
  }
  if (rate < 0) {
    if (marginal < -MARGIN_EPS) return '下跌加速';
    if (marginal > MARGIN_EPS) return '下跌减速';
    return '下跌平稳';
  }
  return '无变化';
}

// ---------- 规则三⑤：连续同向边际期数 ----------
function marginalStreak(marginals) {
  if (!Array.isArray(marginals) || !marginals.length) return 0;
  const sign = m => (m > MARGIN_EPS ? 1 : (m < -MARGIN_EPS ? -1 : 0));
  const lastSign = sign(marginals[marginals.length - 1]);
  if (lastSign === 0) return 0;
  let n = 0;
  for (let i = marginals.length - 1; i >= 0; i--) {
    if (sign(marginals[i]) === lastSign) n++;
    else break;
  }
  return n;
}

/**
 * 规则三核心：对 {date,value} 升序序列做完整变化与边际分析（相邻期口径）
 */
function analyzeSeries(points, name, opts = {}) {
  // 默认只保留正值（PE/PB/PS 等估值指标，≤0 无意义）；
  // 但资金净流入、利润增速等指标可以为负，负值被丢弃会导致变化率算错，
  // 故允许调用方通过 allowNegative 显式放开（规则：不得静默丢弃有效数据）。
  const allowNegative = opts.allowNegative === true;
  const valid = (points || []).filter(p => {
    if (!p || !p.date) return false;
    const v = Number(p.value);
    if (!isFinite(v)) return false;
    return allowNegative ? true : v > 0;
  });
  if (valid.length < 2) {
    return { name, available: false, reason: '序列不足两期，无法做变化与边际分析' };
  }
  const cur = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  const prev2 = valid.length >= 3 ? valid[valid.length - 3] : null;

  const rate = changeRate(cur.value, prev.value);
  const prevRate = prev2 ? changeRate(prev.value, prev2.value) : (prev ? changeRate(prev.value, valid[0].value) : null);
  const marginal = (rate != null && prevRate != null) ? Math.round((rate - prevRate) * 100) / 100 : null;

  const rates = valid.map((p, i) => (i === 0 ? null : changeRate(p.value, valid[i - 1].value))).filter(r => r != null);
  // 规则三①：最新一期基期为非正（如资金由净流出转净流入）时，百分比变化率无意义（已返回 null），
  // 但「方向性变化」仍须识别——据 prev/cur 符号判断是否「由负转正」(改善)。
  // 说明：由正转负时基期为正、rate 可正常计算，classifyDirection 已覆盖；仅「由负转正」会令 rate 为
  // null 且被漏判，此处补上，避免方向性变化识别缺口（规则一/三硬要求）。
  let direction = classifyDirection(rates);
  const baseFlip = (allowNegative && prev && cur && prev.value <= 0 && cur.value > 0) ? 'negToPos' : null;
  if (baseFlip === 'negToPos') direction = '由负转正';
  const accel = classifyAccel(rate, prevRate);

  const marginals = [];
  for (let i = 2; i < rates.length; i++) marginals.push(Math.round((rates[i] - rates[i - 1]) * 100) / 100);
  const streak = marginalStreak(marginals);

  // 规则三④：方向 + 幅度 + 边际
  let text = `${name}从 ${prev.value} `;
  if (rate == null) {
    // 基期非正（如资金由净流出转为净流入），百分比变化无意义 → 改用绝对变化描述
    const delta = Math.round((cur.value - prev.value) * 100) / 100;
    text += `变动到 ${cur.value}（绝对变动 ${delta > 0 ? '+' : ''}${delta}）；前期值为 ${prev.value <= 0 ? '零或负值' : '缺失'}，变化率不适用，此处以绝对变动衡量`;
    if (baseFlip === 'negToPos') text += `，属「由负转正」的方向性改善`;
  } else {
    const dirWord = rate > 0 ? '上升' : (rate < 0 ? '下降' : '持平');
    text += `${dirWord}到 ${cur.value}，${rate > 0 ? '涨幅' : '跌幅'} ${Math.abs(rate).toFixed(2)}%`;
    if (marginal != null && prevRate != null) {
      const sameSign = (rate > 0 && prevRate > 0) || (rate < 0 && prevRate < 0);
      if (sameSign) {
        const cmp = Math.abs(marginal) < MARGIN_EPS ? '基本持平'
          : (marginal > 0 ? `较上一期变化幅度扩大 ${Math.abs(marginal).toFixed(2)} 个百分点`
                          : `较上一期变化幅度收窄 ${Math.abs(marginal).toFixed(2)} 个百分点`);
        text += `，${cmp}`;
      } else {
        text += `，较上一期（${prevRate > 0 ? '上涨' : prevRate < 0 ? '下跌' : '持平'} ${Math.abs(prevRate).toFixed(2)}%）转为${rate > 0 ? '上涨' : '下跌'}，边际变动 ${Math.abs(marginal).toFixed(2)} 个百分点`;
      }
    }
    text += `，呈${accel}态势`;
  }

  // 规则三⑤：特殊信号
  const turning = (direction === '涨转跌' || direction === '跌转涨' || direction === '横盘突破' || direction === '由负转正');
  const marginalStrong = marginal != null && Math.abs(marginal) > MARGIN_EPS;
  const special = (turning && marginalStrong) || streak >= 3 || baseFlip === 'negToPos';
  let specialNote = '';
  if (baseFlip === 'negToPos') {
    specialNote = '⚠️ 重点信号：最新一期由负值转正（如资金由净流出转为净流入），方向性改善；因基期为负，变化率不适用，此处以绝对变动衡量。';
  } else if (turning && marginalStrong) {
    specialNote = `⚠️ 重点信号：出现「${direction}」的同时变化力度${accel}，方向与边际同向共振。`;
  } else if (streak >= 3) {
    specialNote = `⚠️ 趋势强化信号：边际变化已连续 ${streak} 期同向，趋势力度持续${marginal > 0 ? '增强' : '减弱'}。`;
  }

  return {
    name,
    available: true,
    current: makeDatum(name, cur.value, cur.date, cur.source, cur.fetchTime),
    previous: { value: prev.value, date: prev.date },
    changeRate: rate,
    prevChangeRate: prevRate,
    marginal,
    direction,
    accel,
    marginalStreak: streak,
    text,
    special,
    specialNote,
  };
}

/**
 * 窗口期分析：比较窗口【首尾】两点（用于“近 N 个交易日”这类区间口径），
 * 与 analyzeSeries（相邻期）区分，避免把“近20日”误算成“最后两天”。
 */
function analyzeWindow(points, name, opts = {}) {
  const allowNegative = opts.allowNegative === true;
  const valid = (points || []).filter(p => {
    if (!p || !p.date) return false;
    const v = Number(p.value);
    if (!isFinite(v)) return false;
    return allowNegative ? true : v > 0;
  });
  if (valid.length < 2) return { name, available: false, reason: '窗口内有效点不足两个' };
  const first = valid[0];
  const last = valid[valid.length - 1];
  const rate = changeRate(last.value, first.value);
  const up = rate != null && rate > FLAT_PCT;
  const down = rate != null && rate < -FLAT_PCT;
  const direction = up ? '区间上涨' : (down ? '区间下跌' : '区间横盘');

  const mid = Math.floor(valid.length / 2);
  const firstHalf = changeRate(valid[mid].value, first.value);
  const secondHalf = changeRate(last.value, valid[mid].value);
  const marginal = (firstHalf != null && secondHalf != null)
    ? Math.round((secondHalf - firstHalf) * 100) / 100 : null;
  const accel = classifyAccel(secondHalf, firstHalf);

  let text = `${name}：${first.date} 的 ${first.value} → ${last.date} 的 ${last.value}`;
  if (rate != null) text += `，区间${rate > 0 ? '上涨' : '下跌'} ${Math.abs(rate).toFixed(2)}%`;
  if (marginal != null) text += `，后半段较前半段${marginal > 0 ? '走强' : '走弱'} ${Math.abs(marginal).toFixed(2)} 个百分点，呈${accel}态势`;

  return {
    name, available: true,
    from: { value: first.value, date: first.date },
    to: { value: last.value, date: last.date },
    changeRate: rate, marginal, direction, accel, text,
    windowDays: valid.length,
  };
}

/**
 * 通用规则装饰器：给任意模块的数据一次性补上三规则信息，
 * 让轻量模块（资金/宏观/首页卡片等）无需各写一套 Hub 即可合规。
 * @param {Object} opts
 *   dataTime   数据对应时间（必填，用于时效体检）
 *   source     数据来源
 *   kind       TTL 类型：quote|daily|weekly|financial|company（默认 daily）
 *   series     [{date,value}] 升序序列（可选，用于变化与边际分析）
 *   name       指标名（用于文案）
 * @returns {{freshness, staleNote, analysis, source, fetchedAt}}
 */
function decorateRules(opts = {}) {
  const {
    dataTime: rawDataTime, source = '未知', kind = 'daily',
    series = [], name = '指标', tradingDayAware = true, allowNegative = false,
  } = opts;
  const fetchTime = new Date().toISOString();
  const dataTime = normalizeDate(rawDataTime);
  const freshness = checkFreshness(dataTime, kind, Date.now(), { tradingDayAware });
  const analysis = (series && series.length >= 2)
    ? analyzeSeries(series, name, { allowNegative })
    : { name, available: false, reason: '序列不足两期，无法做变化与边际分析' };
  return {
    freshness,
    staleNote: freshness.expired ? staleLabel(dataTime) : '',
    analysis,
    source,
    dataTime: dataTime || null,   // 已归一化为 YYYY-MM-DD，避免下游再解析失败
    fetchedAt: fetchTime,
  };
}

// ===== 影响程度评分（利好/利空方向语义）——全站唯一出口 =====
// 口径：signal ∈ [-1,1]（正=利好/偏多，负=利空/偏空）→ impactScore ∈ [-3,3]。
// 展示约定（A 股习惯：红=利好/涨，绿=利空/跌）：
//   impactScore > 0 → 「利好 +n」红色；< 0 → 「利空 -n」绿色；= 0 → 「中性 0」灰色。
// 方向保底：|signal| ≥ IMPACT_DIR_EPS 但四舍五入为 0 时，强制保留 ±1，
//   避免「指数 60 日 -7.1% → 信号 -0.10 → 评分 0」这类"明明偏空却标中性"的方向丢失。
const IMPACT_DIR_EPS = 0.02;
function toImpactScore(signal) {
  const s = (typeof signal === 'number' && isFinite(signal)) ? signal : 0;
  // 对称舍入（远离零）：JS 原生 Math.round(-1.5) = -1，会导致 +0.5→+2 而 -0.5→-1 的正负不对称，
  // 使同等强度的利好与利空显示不同的评分档位。
  const raw = Math.max(-3, Math.min(3, s * 3));
  let score = raw >= 0 ? Math.round(raw) : -Math.round(-raw);
  if (score === 0 && Math.abs(s) >= IMPACT_DIR_EPS) score = s > 0 ? 1 : -1;
  return score;
}
function impactLabel(score) {
  return score > 0 ? '利好' : score < 0 ? '利空' : '中性';
}
// 把 impactScore + impactLabel 一次性打到因子/子因子对象上（因子与子因子同口径）
function withImpact(obj) {
  const score = toImpactScore(obj && obj.signal);
  return { ...(obj || {}), impactScore: score, impactLabel: impactLabel(score) };
}

// ===== 三规则集中硬闸门 =====
// 任何 Hub 在把 analyzeSeries / decorateRules 的结果包装成对外"方向性结论"之前，
// 必须先调用 assertAnalysis：分析不可用时抛 RuleNotSatisfied，由调用方捕获后
// 改为"数据不满足，暂不输出结论"，把「三规则不满足不得输出结论」从自觉变强制。
class RuleNotSatisfied extends Error {
  constructor(reason) {
    super(reason || '分析数据不满足三规则，禁止输出结论');
    this.name = 'RuleNotSatisfied';
  }
}
function assertAnalysis(analysis, context = '') {
  if (!analysis || analysis.available !== true) {
    const why = (analysis && analysis.reason) ? analysis.reason : '分析数据不可用（序列不足或校验未通过）';
    throw new RuleNotSatisfied(`${context ? context + '：' : ''}${why}`);
  }
  return analysis;
}

module.exports = {
  TTL, FLAT_PCT, MARGIN_EPS, MAX_DEVIATION, clamp,
  makeDatum, beginSnapshot, decorateRules, normalizeDate,
  countTradingDaysBetween, checkFreshness, staleLabel, validateSane,
  changeRate, classifyDirection, classifyAccel, marginalStreak,
  analyzeSeries, analyzeWindow,
  IMPACT_DIR_EPS, toImpactScore, impactLabel, withImpact,
  RuleNotSatisfied, assertAnalysis,
};
