/**
 * lib/volumeEngine.js — 个股量能分析引擎（20261017d）
 *
 * 依据《AI 股票量能分析工作台统一业务逻辑说明书》实现的确定性量能分析管线。
 * 纯 IF-THEN 计算，无 LLM：所有数值由代码计算，缺数据如实标注「数据不足/样本不足」，不得臆造；
 * 所有输出仅客观分析标签（看多/看空/信号/预警/观察均为分析标签），不衍生任何交易指令。
 *
 * 链路（spec 第十三章）：
 *   预计算 → 位置判定 → 量价三问 → 背离检测 → 五大生死位规则 →
 *   位置×量能组合 → 连续量能序列 → 打分(0-100) → 流动性/黑名单衰减 →
 *   信号分类 + 风险标签 + 结构化输出（四维度客观描述 + 结论提示 + 免责备注）。
 *
 * 日K采集降级链（20261017d，analyzeVolume 内）：
 *   ① 东财多主机日K（push2his → push2，klt=101 前复权，唯一含成交额 amount 与换手率 turnover 的日K通道）；
 *   ② 腾讯日K（ifzq.gtimg qfqday，仅 OHLCV；成交额/换手率缺失由 _precompute 按 spec 降级并如实标注，不臆造）；
 *   任一级拿到 ≥10 根即采用；全部不可达返回空数组，引擎输出「日线数据不足」。
 *
 * 工作台口径配置（spec 允许「由工作台配置」的参数，未配置时按此处默认并如实标注）：
 * - 均量基准不含当日（与 capitalFlow.js「量比 = 今日量 ÷ 前20日均量」同口径）；
 * - 5/10/20/60 日均量分别取最近 5/10/20/60 个交易日（不含当日）；
 * - 250 日窗口用于成交额百分位与流动性分级；日K 取 320 根 ≈ 13 个月，覆盖 12 个月价格分位；
 * - 量比阈值未配置 → 不单独以量比触发结论，以 5 日均量档位 + 60 日均量×1.5/×0.7 确认为准（spec 第三章）；
 * - 阶段新高低窗口未配置 → 取近 250 个交易日（≈12 个月）高低点；
 * - 大盘环境折扣未配置 → 输出标注「未叠加大盘环境折扣」；
 * - 黑名单「近期」取近 180 天内的解禁/减持公告标题匹配 + ST/退市风险名称识别。
 */

'use strict';

// ===================== 常量（spec 第三/九/十章） =====================

// 量能档位：当前量 ÷ 5 日均量倍数
const LEVEL_RULES = [
  { level: '极度缩量', test: r => r < 0.4 },
  { level: '温和缩量', test: r => r >= 0.4 && r < 0.7 },
  { level: '平量', test: r => r >= 0.7 && r <= 1.3 },
  { level: '温和放量', test: r => r > 1.3 && r <= 2.5 },
  { level: '大量', test: r => r > 2.5 && r <= 4 },
  { level: '天量', test: r => r > 4 },
];

const AMP_CONFIRM = 1.5;   // 放量确认：> 60 日均量 × 1.5
const SHRINK_CONFIRM = 0.7; // 缩量确认：< 60 日均量 × 0.7

// 流动性分级与置信系数（spec 第十章）
const LIQ_TIERS = [
  { level: '流动性严重不足', coef: 0.4, tag: '低流动性', test: p => p < 0.2 },
  { level: '流动性一般', coef: 0.7, tag: '流动性偏弱', test: p => p >= 0.2 && p < 0.4 },
  { level: '流动性充足', coef: 1.0, tag: null, test: p => p >= 0.4 && p <= 0.85 },
  { level: '流动性过热', coef: 0.85, tag: '流动性过热', test: p => p > 0.85 },
];
const FALLBACK_AMOUNT = 5e6;  // 单日成交额低于 500 万 → 兜底 ×0.2
const SAMPLE_MIN_BARS = 60;   // 样本不足判定：可用历史交易日 < 60 根 → ×0.5
const BLACKLIST_COEF = 0.3;   // 黑名单衰减系数

// 打分权重（spec 第九章）
const W_VOLUME_PRICE = 40;
const W_TREND = 30;
const W_LEVEL_FIT = 20;
const DIVERGE_PENALTY = { top: 30, general: 20, bottom: 15 }; // 单次最高扣 30

// 档位适配分（spec：极度缩量不进看多；巨量/天量增风险折扣）
const LEVEL_FIT_SCORE = { '极度缩量': 5, '温和缩量': 12, '平量': 15, '温和放量': 20, '大量': 10, '天量': 8 };

// ===================== 基础工具 =====================

function _round(n, d = 2) {
  if (n === null || n === undefined || !isFinite(n)) return 0;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function _mean(a) {
  if (!a || !a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function _median(a) {
  if (!a || !a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 历史百分位（0-1）：口径 = 窗口内 ≤ v 的样本占比（与 marketEmotionModel.rankPercentile 同口径）
function _pctRank(values, v) {
  if (!values || !values.length || v === null || v === undefined || !isFinite(v)) return null;
  let cnt = 0;
  for (const x of values) if (x <= v) cnt++;
  return cnt / values.length;
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _fmtPct(n, d = 1) {
  if (n === null || n === undefined || !isFinite(n)) return '数据不足';
  return `${_round(n, d)}%`;
}

// ===================== 1. 预计算（spec 第二章） =====================

function _precompute(bars) {
  const n = bars.length;
  const vols = bars.map(b => b.volume);
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const opens = bars.map(b => b.open);
  const amounts = bars.map(b => (typeof b.amount === 'number' ? b.amount : 0));
  const turnovers = bars.map(b => (typeof b.turnover === 'number' ? b.turnover : 0));
  const hasAmount = amounts.some(a => a > 0);
  const hasTurnover = turnovers.some(t => t > 0);
  const dataGaps = [];

  const volToday = vols[n - 1];
  const volPrev = n >= 2 ? vols[n - 2] : null;
  const closeToday = closes[n - 1];
  const closePrev = n >= 2 ? closes[n - 2] : null;
  const highToday = highs[n - 1];
  const lowToday = lows[n - 1];
  const openToday = opens[n - 1];
  const amountToday = amounts[n - 1];
  const turnoverToday = turnovers[n - 1];
  const chgPct = closePrev ? (closeToday - closePrev) / closePrev * 100 : null;

  // 均量：基准不含当日（工作台既有口径）
  const avgOf = (k) => {
    const w = vols.slice(Math.max(0, n - 1 - k), n - 1);
    return w.length >= Math.min(k, n - 1) ? _mean(w) : (w.length ? _mean(w) : 0);
  };
  const avg5 = avgOf(5);
  const avg10 = avgOf(10);
  const avg20 = avgOf(20);
  const avg60 = avgOf(60);
  if (n - 1 < 5) dataGaps.push('历史K线不足，均量按可用样本计算，可靠性下降');
  if (n - 1 < 60) dataGaps.push(`历史K线仅 ${n} 根（不足60），60 日均量按可用样本计算`);

  const ratio5 = avg5 > 0 ? volToday / avg5 : null;
  const ratio10 = avg10 > 0 ? volToday / avg10 : null;
  const ratio20 = avg20 > 0 ? volToday / avg20 : null;
  // 前一日的 5 日均量口径（背离检测「量能水平持续回落」用）。
  // 20261017c：修正窗口——prev 日是 n-2，其 5 日均量（不含自身，与 avg5「基准不含当日」同口径）
  // 应为 mean(vols[n-7..n-3])。原窗口 slice(n-6, n-1) 把前一日自身也包了进去，
  // 导致 ratio5Prev 与 ratio5 同分母，「量能水平回落」退化为「今日量<前日量」的重复判断。
  const avg5Prev = n >= 7 ? _mean(vols.slice(n - 7, n - 2)) : 0;
  const ratio5Prev = avg5Prev > 0 && volPrev ? volPrev / avg5Prev : null;

  // 量能档位（当前量 ÷ 5 日均量）
  let level = '数据不足';
  if (ratio5 !== null) {
    const hit = LEVEL_RULES.find(r => r.test(ratio5));
    level = hit ? hit.level : '平量';
  }

  // 放量/缩量确认（60 日均量口径，spec 第三章）
  let confirm = null;
  if (avg60 > 0) {
    if (volToday > avg60 * AMP_CONFIRM) confirm = '放量';
    else if (volToday < avg60 * SHRINK_CONFIRM) confirm = '缩量';
  }

  // 250 日成交额百分位与中位数（spec 第十章；窗口不足 250 根时按可用样本并标注）
  const amtWin = amounts.slice(-250).filter(a => a > 0);
  const amountPct250 = amtWin.length ? _pctRank(amtWin, amountToday) : null;
  const amountMedian250 = amtWin.length ? _median(amtWin) : null;

  // 近 12 个月价格分位与阶段高低点（250 根窗口；不足按可用样本）
  const closeWin = closes.slice(-250);
  const highWin = highs.slice(-250);
  const lowWin = lows.slice(-250);
  const winMaxClose = Math.max(...closeWin);
  const winMinClose = Math.min(...closeWin);
  const pricePct12m = winMaxClose > winMinClose ? (closeToday - winMinClose) / (winMaxClose - winMinClose) : null;
  const stageHigh = Math.max(...highWin);
  const stageLow = Math.min(...lowWin);
  const stageHighClose = winMaxClose;
  const stageLowClose = winMinClose;
  const drawdownFromHigh = stageHighClose > 0 ? (closeToday - stageHighClose) / stageHighClose * 100 : null;
  const rallyFromLow = stageLowClose > 0 ? (closeToday - stageLowClose) / stageLowClose * 100 : null;
  if (n < 250) dataGaps.push(`价格分位/阶段高低点窗口仅 ${n} 根（不足250），按可用样本计算`);

  // 换手率及历史均值（东财日K f61；腾讯/新浪通道无此字段）
  const turnoverWin = turnovers.slice(-250).filter(t => t > 0);
  const turnoverMean = turnoverWin.length ? _mean(turnoverWin) : null;
  if (!hasTurnover) dataGaps.push('换手率数据不足（当前日K通道无换手率字段），天量确认降级');
  if (!hasAmount) dataGaps.push('成交额数据不足（当前日K通道无成交额字段），流动性校验降级');

  // 均线（含当日，标准口径）
  const ma20 = n >= 20 ? _mean(closes.slice(-20)) : null;
  const ma60 = n >= 60 ? _mean(closes.slice(-60)) : null;

  // 单根脉冲爆量：只有最新一根巨量（>5 日均量 2.5 倍），前后 K 线均为缩量（< 60 日均量 ×0.7，spec 第三章缩量口径）。
  // 三问/连续序列/打分共用此判定（spec 第四/八/九章）。
  const pulse = ratio5 !== null && ratio5 > 2.5
    && avg60 > 0 && n >= 3
    && vols[n - 2] < avg60 * SHRINK_CONFIRM
    && vols[n - 3] < avg60 * SHRINK_CONFIRM;

  return {
    n, vols, closes, highs, lows, opens, amounts, turnovers,
    hasAmount, hasTurnover, dataGaps,
    volToday, volPrev, closeToday, closePrev, highToday, lowToday, openToday,
    amountToday, turnoverToday, chgPct,
    avg5, avg10, avg20, avg60, ratio5, ratio10, ratio20, ratio5Prev,
    level, confirm,
    amountPct250, amountMedian250,
    pricePct12m, stageHigh, stageLow, stageHighClose, stageLowClose,
    drawdownFromHigh, rallyFromLow,
    turnoverMean, ma20, ma60,
    pulse,
  };
}

// ===================== 2. 位置判定与关键位（spec 第三章） =====================

function _sidewaysAndPlatform(bars) {
  const n = bars.length;
  const band = (i, j) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = i; k <= j; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    return lo > 0 ? (hi - lo) / lo : Infinity;
  };
  // 横盘形态：连续 ≥20 个交易日，区间涨跌幅在 ±15% 以内（形态标签，可与四态并列）
  let currentSideways = false;
  if (n >= 20 && band(n - 20, n - 1) <= 0.15) currentSideways = true;
  // 前期平台：从倒数第 4 根往前找最近的、长度 ≥20 且带宽 ≤15% 的窗口
  // （规则1「前期已完成不少于20个交易日横盘整理」与规则3「平台上沿」用；
  //   endIdx ≤ n-4 保证平台结束于最近 3 根放量 K 线之前）
  let platform = null;
  for (let e = n - 4; e >= 19; e--) {
    if (band(e - 19, e) <= 0.15) {
      let hi = -Infinity, lo = Infinity;
      for (let k = e - 19; k <= e; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      platform = { high: hi, low: lo, startIdx: e - 19, endIdx: e, days: 20 };
      break;
    }
  }
  return { currentSideways, platform };
}

function _keyLevels(pc, platform) {
  const cands = [];
  if (platform) {
    cands.push({ price: platform.high, kind: '震荡平台上沿' });
    cands.push({ price: platform.low, kind: '震荡平台下沿' });
  }
  cands.push({ price: pc.stageHigh, kind: '阶段高点' });
  cands.push({ price: pc.stageLow, kind: '阶段低点' });
  if (pc.ma60) cands.push({ price: pc.ma60, kind: '60日均线' });
  if (pc.ma20) cands.push({ price: pc.ma20, kind: '20日均线' });
  // 关键压力位：平台上沿正处于测试（收盘价在其下方 10% 以内）时优先，否则取上方最近候选
  let resistance;
  if (platform && platform.high >= pc.closeToday * 0.90) {
    resistance = { price: platform.high, kind: '震荡平台上沿' };
  } else {
    const above = cands.filter(c => c.price > pc.closeToday * 1.001).sort((a, b) => a.price - b.price);
    resistance = above.length ? above[0] : { price: pc.stageHigh, kind: '阶段高点（上方无其他候选）' };
  }
  // 关键支撑位：平台下沿正处于测试（收盘价在其上方 10% 以内，含刚跌破）时优先，否则取下方最近候选
  let support;
  if (platform && platform.low <= pc.closeToday * 1.10) {
    support = { price: platform.low, kind: '震荡平台下沿' };
  } else {
    const below = cands.filter(c => c.price < pc.closeToday * 0.999).sort((a, b) => b.price - a.price);
    support = below.length ? below[0] : { price: pc.stageLow, kind: '阶段低点（下方无其他候选）' };
  }
  return { support, resistance };
}

function _detectPosition(pc, platform) {
  const pct = pc.pricePct12m;
  const dd = pc.drawdownFromHigh;   // 负值 = 低于阶段高点
  const rally = pc.rallyFromLow;
  const trendUp = pc.ma20 && pc.ma60 ? (pc.closeToday > pc.ma20 && pc.ma20 >= pc.ma60) : (pc.ma20 ? pc.closeToday > pc.ma20 : null);
  const trendDown = pc.ma20 && pc.ma60 ? (pc.closeToday < pc.ma20 && pc.ma20 <= pc.ma60) : (pc.ma20 ? pc.closeToday < pc.ma20 : null);

  let label = '震荡整理';
  let divergence = null;

  if (pct !== null && pct < 0.3) {
    label = '低位区间';
    // 双条件参考：分位低但距阶段高点不远 → 刚脱离底部，位置判定存在分歧
    if (dd !== null && dd > -15) {
      divergence = `位置判定存在分歧：12个月价格分位 ${_fmtPct(pct * 100)} 属低位，但现价距阶段高点仅 ${_fmtPct(-dd)}，近期自底部反弹 ${_fmtPct(rally)}，低位结论置信度下调`;
    }
  } else if (pct !== null && pct > 0.7) {
    label = '高位区间';
    if (rally !== null && rally < 30) {
      divergence = `位置判定存在分歧：12个月价格分位 ${_fmtPct(pct * 100)} 属高位，但现价距阶段低点仅 ${_fmtPct(rally)}，未经过大幅上涨，高位结论置信度下调`;
    }
  } else if (trendUp === true) {
    label = '上涨中途';
  } else if (trendDown === true) {
    label = '下跌途中';
  } else {
    label = '震荡整理';
    if (pct === null) divergence = '位置判定存在分歧：价格分位数据不足，按趋势不明处理';
  }

  const basis = pc.pricePct12m !== null
    ? `12个月价格分位 ${_fmtPct(pc.pricePct12m * 100)}；距阶段高点 ${_fmtPct(dd)}；距阶段低点 ${_fmtPct(rally)}；MA20 ${pc.ma20 ? _round(pc.ma20) : '数据不足'} / MA60 ${pc.ma60 ? _round(pc.ma60) : '数据不足'}`
    : '价格分位数据不足';
  return { label, divergence, basis, trendUp, trendDown };
}

// ===================== 3. 量价三问（spec 第四章） =====================

function _threeChecks(pc) {
  const failed = [];
  // ① 量能真实性：当前量能显著偏离日常水平（相对 20 日均量偏离 ≥50%）
  const dev = pc.ratio20 !== null ? Math.abs(pc.ratio20 - 1) : null;
  const authenticity = {
    pass: dev !== null && dev >= 0.5,
    note: dev === null ? '20 日均量数据不足，真实性无法校验'
      : (dev >= 0.5 ? `当前量相对 20 日均量 ${_round(pc.ratio20)} 倍，显著偏离日常水平，可确认为主动资金行为`
        : `当前量相对 20 日均量 ${_round(pc.ratio20)} 倍，与日常水平接近，偏向散户零散交易随机波动`),
  };
  if (!authenticity.pass) failed.push('量能真实性不足');

  // ② 价格认可度：放量应对应价格企稳/突破；缩量应对应价格回落/无力
  let priceAcceptance;
  if (pc.chgPct === null) {
    priceAcceptance = { pass: false, note: '前一日收盘数据不足，价格认可度无法校验' };
  } else if (pc.confirm === '放量') {
    const ok = pc.chgPct > 0;
    priceAcceptance = {
      pass: ok,
      note: ok ? `放量且当日收涨 ${_fmtPct(pc.chgPct, 2)}，价格与量能同向反馈`
        : `放量但当日收跌 ${_fmtPct(pc.chgPct, 2)}，量价不匹配，标记矛盾`,
    };
  } else if (pc.confirm === '缩量') {
    const ok = pc.chgPct <= 0;
    priceAcceptance = {
      pass: ok,
      note: ok ? `缩量且当日收跌 ${_fmtPct(pc.chgPct, 2)}，抛压萎缩与价格回落匹配`
        : `缩量但当日收涨 ${_fmtPct(pc.chgPct, 2)}，上涨无量能确认，标记矛盾`,
    };
  } else {
    priceAcceptance = { pass: true, note: '当前量能未达放量/缩量确认阈值，按常态处理' };
  }
  if (!priceAcceptance.pass) failed.push('价格认可度不足');

  // ③ 持续性：放量/缩量状态连续 ≥2 个交易日
  const n = pc.n;
  let persistence;
  if (pc.avg60 <= 0 || n < 3) {
    persistence = { pass: false, note: '60 日均量数据不足，持续性无法校验' };
  } else {
    const v1 = pc.vols[n - 1], v2 = pc.vols[n - 2];
    const amp2 = v1 > pc.avg60 * AMP_CONFIRM && v2 > pc.avg60 * AMP_CONFIRM;
    const shrink2 = v1 < pc.avg60 * SHRINK_CONFIRM && v2 < pc.avg60 * SHRINK_CONFIRM;
    if (amp2) persistence = { pass: true, note: '最近 2 个交易日成交量均超过 60 日均量 ×1.5，放量具备持续性' };
    else if (shrink2) persistence = { pass: true, note: '最近 2 个交易日成交量均低于 60 日均量 ×0.7，缩量具备持续性' };
    else {
      persistence = { pass: false, note: '量能状态仅最新一日偏离，未连续不少于 2 个交易日，排除单日异动前持续性不足' };
      failed.push('持续性不足');
    }
  }

  // 单根脉冲爆量：只有最新一根巨量（>5 日均量 2.5 倍），前后 K 线均为缩量（< 60 日均量 ×0.7，spec 第三章缩量口径）
  // 口径与 _precompute.pulse 一致（三问/连续序列/打分共用同一判定）
  const pulse = pc.pulse;
  if (pulse) failed.push('单日脉冲');

  return { authenticity, priceAcceptance, persistence, pulse, failed };
}

// ===================== 4. 背离检测（spec 第五章） =====================

function _detectDivergence(pc) {
  if (pc.n < 2 || pc.ratio5Prev === null) {
    return { type: null, note: '数据不足，无法判定量价背离' };
  }
  const prevCloses = pc.closes.slice(-250, -1);
  // 严格创新高/新低：收盘必须超过/跌破此前极值（持平不算「创出」）
  const newHigh = pc.closeToday > Math.max(...prevCloses);
  const newLow = pc.closeToday < Math.min(...prevCloses);
  const volDown = pc.volPrev !== null && pc.volToday < pc.volPrev;
  const ratioFalling = pc.ratio5 < pc.ratio5Prev; // 相对 5 日均量的量能水平回落

  if (newHigh && volDown && ratioFalling) {
    return { type: '顶背离', note: '价格创阶段新高，但成交量低于前一日且相对 5 日均量的量能水平持续回落：多头量能衰竭，作为风险标签输出' };
  }
  if (newLow && volDown && !ratioFalling) {
    return { type: '底背离', note: '价格创阶段新低，成交量低于前一日但萎缩程度不再继续创新低：空头量能衰竭，潜在底部观察点' };
  }
  if (newHigh || newLow) {
    const volUp = pc.volPrev !== null && pc.volToday > pc.volPrev;
    if ((newHigh && !volUp) || (newLow && !volUp)) {
      return { type: '一般量价背离', note: `价格创阶段${newHigh ? '新高' : '新低'}但量能未同步放大，标记量价背离风险` };
    }
  }
  return { type: null, note: '未检测到量价背离' };
}

// ===================== 5. 五大生死位规则（spec 第六章） =====================

function _limitPct(symbol, name) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '');
  if (/\*?ST|退/i.test(name || '')) return 0.05;
  if (/^(688|30)/.test(code)) return 0.2;
  if (/^[48]/.test(code)) return 0.3;
  return 0.1;
}

function _lifeRules(pc, ctx) {
  const { position, platform, minutes, symbol, name } = ctx;
  const bars = ctx.bars;
  const n = pc.n;
  const rules = [];

  // ---- 规则 1：低位吸筹（多头信号） ----
  {
    const dataGaps = [];
    let matched = false;
    const priorSideways = !!(platform && platform.endIdx <= n - 4 && platform.days >= 20);
    if (!priorSideways) dataGaps.push('前期未识别到不少于 20 个交易日的横盘整理');
    const last3 = pc.vols.slice(-3);
    const amp3 = pc.avg60 > 0 && last3.length === 3 && last3.every(v => v > pc.avg60 * AMP_CONFIRM);
    const steady = pc.closes[n - 1] >= pc.closes[n - 3];
    if (!steady) dataGaps.push('价格随放量下跌，重心未企稳或小幅抬升');
    if (!amp3) dataGaps.push('最近 3 个交易日未连续放量（未连续超过 60 日均量 ×1.5）');
    matched = position.label === '低位区间' && priorSideways && amp3 && steady && !ctx.checks.pulse;
    rules.push({
      id: 1, name: '低位吸筹', direction: 'bull', priority: 'normal', matched,
      conclusion: matched
        ? '判定为低位资金承接吸筹行为：价格处于低位区间，前期完成横盘整理后连续 3 日放量，价格重心企稳未随放量下跌，量能放大具备连续性。筹码呈现由散户向主力集中的转移趋势，量价配合处于健康多头初期状态'
        : '不满足低位吸筹触发条件（需同时满足：低位区间 + 前期≥20日横盘 + 连续3日放量 + 价格重心企稳 + 非单日脉冲）',
      dataGaps,
    });
  }

  // ---- 规则 2：高位派发（空头预警，最高优先级） ----
  {
    const dataGaps = [];
    let matched = false;
    const isYearMaxVol = pc.volToday >= Math.max(...pc.vols.slice(-250, -1)); // 近 12 个月（250 根）历史新高
    if (!pc.hasTurnover) dataGaps.push('换手率数据不足，天量确认降级');
    const turnoverExtreme = pc.hasTurnover && pc.turnoverMean !== null && pc.turnoverToday >= pc.turnoverMean * 2;
    if (!minutes || !minutes.minutes || !minutes.minutes.length) {
      dataGaps.push('分时数据不足，本规则不匹配（日内分时震荡与涨停开板无法核验，不得臆造）');
    }
    let intradayOk = false;
    if (minutes && minutes.minutes && minutes.minutes.length) {
      const prices = minutes.minutes.map(m => m.price).filter(p => isFinite(p) && p > 0);
      if (prices.length) {
        const mx = Math.max(...prices), mn = Math.min(...prices);
        const swing = mn > 0 ? (mx - mn) / mn : 0;
        intradayOk = swing >= 0.03; // 日内分时线大幅上下震荡（≥3%）
      }
    }
    // 涨停封死核验：北交所/科创/创业板 20%、ST 5%、其余 10%（前复权口径下为近似值）
    const limitPct = _limitPct(symbol, name);
    const limitPrice = pc.closePrev ? pc.closePrev * (1 + limitPct) : null;
    const touchedLimit = limitPrice !== null && pc.highToday >= limitPrice * 0.995;
    const notSealed = limitPrice !== null && pc.closeToday < limitPrice * 0.995;
    const atHigh = pc.closeToday >= pc.highToday * 0.995;
    if (!touchedLimit) dataGaps.push('当日未触及涨停价，「无法封死涨停/反复开板」条件不适用，按分时大幅震荡 + 历史天量 + 换手率阶段极高判定');
    if (position.label === '高位区间' && isYearMaxVol && turnoverExtreme && intradayOk && !atHigh && (touchedLimit ? notSealed : true)) {
      matched = true;
    }
    if (position.label !== '高位区间') dataGaps.push('价格未处于高位区间');
    if (!isYearMaxVol) dataGaps.push('当日成交量未创近 12 个月历史新高（天量条件不满足）');
    if (pc.hasTurnover && !turnoverExtreme) dataGaps.push('换手率未达历史均值 2 倍的阶段极高水平');
    rules.push({
      id: 2, name: '高位派发', direction: 'bear', priority: 'top', matched,
      conclusion: matched
        ? '判定为高位资金派发行为：价格处于高位区间，单日放出历史天量且换手率处于阶段极高值，日内分时大幅震荡且未能收在高点，主力筹码向散户转移，抛压集中释放，量价结构呈现明确空头预警状态'
        : '不满足高位派发触发条件（需同时满足：高位区间 + 历史天量 + 换手率阶段极高 + 分时大幅震荡 + 无法封死涨停/反复开板）',
      dataGaps,
    });
  }

  // ---- 规则 3：缩量假突破（多头失效信号） ----
  {
    const dataGaps = [];
    let matched = false;
    let detail = '';
    const n = pc.n;
    // 有效放大 = 既超过前高对应量能，又达到 60 日均量 ×1.5（spec：未超过前高对应量能，或未达到 1.5 倍均算未有效放大）
    const ampOk = (vol, refVol) => pc.avg60 > 0 && vol > refVol && vol > pc.avg60 * AMP_CONFIRM;
    // 候选压力位（均为攻击日之前形成的历史位）：
    //   a) 阶段高点——取「最近一个交易日之前」的全局最高（攻击日新高不算前高，避免趴在窗口高点时每日误触发）
    //   b) 震荡平台上沿——平台窗口 endIdx ≤ n-4，必早于攻击日
    const cands = [];
    {
      let pH = -Infinity, pi = 0;
      for (let i = 0; i < n - 1; i++) if (bars[i].high > pH) { pH = bars[i].high; pi = i; }
      cands.push({ price: pH, kind: '阶段高点', attackDay: n - 1, levelVol: bars[pi].volume, levelDate: bars[pi].date });
    }
    if (platform) {
      let bi = platform.startIdx, bv = -Infinity;
      for (let i = platform.startIdx; i <= platform.endIdx; i++) if (bars[i].high > bv) { bv = bars[i].high; bi = i; }
      cands.push({ price: platform.high, kind: '震荡平台上沿', attackDay: null, levelVol: bars[bi].volume, levelDate: bars[bi].date });
    }
    for (const c of cands) {
      // 攻击日：候选自带（阶段高点取最新一日）或平台上沿取最新一日
      const ad = c.attackDay !== null ? c.attackDay : n - 1;
      const touched = bars[ad].high >= c.price * 0.995;
      const fellBack = pc.closeToday < c.price;
      if (!touched) continue;
      if (!fellBack) {
        dataGaps.push(`价格站稳${c.kind} ${_round(c.price)} 上方，不属于短暂突破后快速回落`);
        continue;
      }
      if (!ampOk(bars[ad].volume, c.levelVol)) {
        matched = true;
        detail = `价格冲击${c.kind} ${_round(c.price)} 后快速回落，攻击日成交量未超过前高对应量能（${c.levelDate} ${_round(c.levelVol)} 手）也未达 60 日均量 ×1.5，无新增增量资金承接，主力无真实推高意愿。标记 K 线骗线、假突破、量能不确认，不得给出看多信号`;
        break;
      }
    }
    if (!matched && !dataGaps.length) dataGaps.push('近期未冲击前期高点或震荡平台上沿，或突破日量能已有效放大');
    rules.push({
      id: 3, name: '缩量假突破', direction: 'bear-block', priority: 'normal', matched,
      conclusion: matched ? `判定为无量假突破形态：${detail}` : '不满足缩量假突破触发条件（需同时满足：冲击前高/平台上沿 + 快速回落 + 突破日量能未有效放大）',
      dataGaps,
    });
  }

  // ---- 规则 4：放量破位（空头确认，最高优先级） ----
  {
    const dataGaps = [];
    let matched = false;
    const s = ctx.levels.support.price;
    const touchedS = pc.lowToday <= s * 1.01;
    const amplified = pc.avg60 > 0 && pc.volToday > pc.avg60 * AMP_CONFIRM;
    const effBreak = pc.closeToday < s * 0.97; // 收盘跌破支撑 ≥3%
    const twoDays = n >= 2 && pc.closes[n - 1] < s * 0.97 && pc.closes[n - 2] < s * 0.97;
    matched = touchedS && amplified && effBreak;
    if (!touchedS) dataGaps.push('价格未触及关键支撑位');
    if (touchedS && !amplified) dataGaps.push('跌破未伴随放量（未超 60 日均量 ×1.5）');
    if (touchedS && amplified && !effBreak) dataGaps.push('收盘价未有效跌破支撑位（未跌破 3%）');
    rules.push({
      id: 4, name: '放量破位', direction: 'bear', priority: 'top',
      matched: matched && twoDays,
      partial: matched && !twoDays,
      conclusion: matched && twoDays
        ? `判定为支撑位资金集中离场行为：价格触及关键支撑位 ${_round(s)}（${ctx.levels.support.kind}），放量且收盘有效跌破并连续 2 日站不回，关键支撑位的筹码承接彻底失效，抛压主导市场，量价结构确认空头破位状态`
        : (matched && !twoDays
          ? `价格已放量触及关键支撑位 ${_round(s)} 并单日跌破 3%，但尚未满足「连续 2 个交易日站不回」的有效破位定义，按初步破位处理，有效破位待确认`
          : '不满足放量破位触发条件（需同时满足：触及关键支撑位 + 跌破当日放量 + 收盘有效跌破）'),
      dataGaps,
    });
  }

  // ---- 规则 5：分时无量拉升（日内空头信号） ----
  {
    const dataGaps = [];
    let matched = false;
    if (!minutes || !minutes.minutes || minutes.minutes.length < 30) {
      dataGaps.push('分时数据不足，本规则不匹配');
    } else {
      const ms = minutes.minutes;
      const prices = ms.map(m => m.price).filter(p => isFinite(p) && p > 0);
      const hasCum = ms.every(m => typeof m.cumVol === 'number');
      if (!hasCum) {
        dataGaps.push('分时累计成交量字段缺失，无法计算每分钟成交量，本规则不匹配');
      } else {
        const priceAtHigh = prices.length && prices[prices.length - 1] >= Math.max(...prices) * 0.998;
        // 每分钟成交量 = 相邻累计量差分
        const mv = [];
        for (let i = 1; i < ms.length; i++) mv.push(Math.max(0, ms[i].cumVol - ms[i - 1].cumVol));
        // 逐级萎缩：最后 40 分钟分 4 桶（每桶 10 分钟），桶和递减且末桶不足首桶 60%
        let shrink = false;
        if (mv.length >= 40) {
          const b1 = mv.slice(-40, -30).reduce((a, b) => a + b, 0);
          const b2 = mv.slice(-30, -20).reduce((a, b) => a + b, 0);
          const b3 = mv.slice(-20, -10).reduce((a, b) => a + b, 0);
          const b4 = mv.slice(-10).reduce((a, b) => a + b, 0);
          shrink = b1 > b2 && b2 >= b3 && b3 > b4 && b4 < b1 * 0.6;
        }
        // 无新增量能接力：最后 20 分钟无脉冲（最大分钟量 ≤ 此前均量 ×1.2）
        let noRelay = false;
        if (mv.length >= 40) {
          const prevMean = _mean(mv.slice(0, -20));
          noRelay = prevMean > 0 && Math.max(...mv.slice(-20)) <= prevMean * 1.2;
        }
        matched = !!priceAtHigh && shrink && noRelay;
        if (!priceAtHigh) dataGaps.push('分时价格未持续走高至日内新高附近');
        if (!shrink) dataGaps.push('分时成交量未呈逐级萎缩');
        if (!noRelay) dataGaps.push('尾盘出现新增量能脉冲，存在接力');
      }
    }
    rules.push({
      id: 5, name: '分时无量拉升', direction: 'bear', priority: 'normal', matched,
      conclusion: matched
        ? '判定为日内无量空涨形态：分时价格持续走高创出日内新高，但分时成交量逐级萎缩且无新增量能接力，属于无承接的被动拉升，量价形成日内背离'
        : '不满足分时无量拉升触发条件（需分时数据 + 价格创日内新高 + 成交量逐级萎缩 + 无新增接力）',
      dataGaps,
    });
  }

  return rules;
}

// ===================== 6. 位置×量能组合引擎（spec 第七章） =====================

function _longUpperShadow(pc) {
  const body = Math.abs(pc.closeToday - pc.openToday);
  const upper = pc.highToday - Math.max(pc.openToday, pc.closeToday);
  return upper >= pc.closeToday * 0.03 && upper >= 2 * body;
}

function _comboEngine(pc, ctx) {
  const { position } = ctx;
  const up = pc.chgPct !== null && pc.chgPct > 0;
  const down = pc.chgPct !== null && pc.chgPct < 0;
  const flat = pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2;
  const amplified = pc.confirm === '放量' || (pc.ratio5 !== null && pc.ratio5 > 1.3);
  const shrunk = pc.confirm === '缩量' || (pc.ratio5 !== null && pc.ratio5 < 0.7);
  const huge = pc.level === '大量' || pc.level === '天量';
  const tags = [];
  let direction = 'neutral';
  let scenario = '常态运行';
  let conclusion = '当前量价无显著异常信号，处于常态运行';

  if (flat) {
    // 横盘震荡场景（spec 第五章4）
    if (pc.level === '极度缩量') {
      scenario = '横盘极度缩量';
      direction = 'observe';
      conclusion = '横盘叠加极度缩量：判定筹码沉淀，浮动筹码减少，等待放量突破信号，仅入观察池不生成看多信号';
    } else if (huge && ctx.persistentHuge) {
      scenario = '横盘持续巨量';
      direction = 'caution';
      conclusion = '横盘持续巨量：判定筹码剧烈交换，多空分歧巨大，方向不明，作为风险结论输出';
      tags.push('单日脉冲假信号');
    } else {
      scenario = '横盘常态';
      direction = 'neutral';
      conclusion = '横盘震荡，量价无显著异常';
    }
    return { scenario, direction, conclusion, tags };
  }

  const pos = position.label;
  if (up) {
    if (amplified) {
      // 位置优先（spec 第五章矩阵按位置×量能组织）；巨量折扣由打分层 s40 巨量−5 承担，不覆盖矩阵格
      if (pos === '高位区间') {
        scenario = '高位放量收阳';
        direction = 'caution';
        conclusion = '高位区间放量收阳：重点识别诱多和 K 线造假，阳线好看但放量代表主力大规模派发筹码，量能暴露逃顶事实';
        tags.push('K线骗线');
      } else if (pos === '下跌途中') {
        scenario = '下跌途中放量反弹';
        direction = 'bear';
        conclusion = '下跌途中放量反弹：无论阴阳，判定抛压释放、下跌动能强化，反弹大概率是诱多';
      } else if (pos === '低位区间') {
        scenario = '低位放量收阳';
        direction = 'bull';
        conclusion = '低位区间放量收阳：判定资金进场信号，真实买盘介入，K 线阳线可信度高';
      } else if (_longUpperShadow(pc)) {
        scenario = '上涨中途放量长上影';
        direction = 'caution';
        conclusion = '上涨中途放量长上影：判定分歧加大，短期有回调风险，警惕假突破';
      } else if (huge) {
        scenario = '放量上涨（巨量）';
        direction = 'caution';
        conclusion = `上涨叠加巨量（当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍）：加分下调，警惕冲高兑现`;
      } else {
        scenario = '上涨中途放量收阳';
        direction = 'bull';
        conclusion = '上涨中途放量收阳：判定健康换手，资金接力，趋势延续概率高';
      }
    } else if (shrunk) {
      scenario = '缩量上涨';
      direction = 'caution';
      conclusion = '缩量上涨：上涨动能不足，量能不确认，保持谨慎；若为突破形态，标记 K 线骗线、假突破嫌疑';
      tags.push('K线骗线', '量能不确认');
    } else {
      scenario = '平量上涨';
      direction = 'neutral';
      conclusion = '平量上涨，量价无显著方向';
    }
  } else if (down) {
    if (amplified) {
      // 位置优先：低位放量收阴即底部洗盘（出逃判定只属于高位，由规则2 高位派发兜底）
      if (pos === '低位区间') {
        scenario = '低位放量收阴';
        direction = 'observe';
        conclusion = '低位区间放量收阴：判定恐慌抛盘释放，筹码交换，属于底部洗盘特征，不是新主力出逃';
      } else if (huge) {
        scenario = '放量杀跌（巨量）';
        direction = 'bear';
        conclusion = '下跌叠加巨量：判定恐慌抛盘，强空头趋势，扣分并增加放量杀跌风险标签';
        tags.push('放量杀跌');
      } else {
        scenario = '放量下跌';
        direction = 'bear';
        conclusion = '下跌放量：判定抛压释放，下跌动能强化';
      }
    } else if (shrunk) {
      if (pos === '高位区间') {
        scenario = '高位缩量';
        direction = 'caution';
        conclusion = '高位区间缩量：判定买盘枯竭，缺少新增资金，行情即将见顶';
      } else if (pos === '下跌途中') {
        scenario = '下跌途中缩量';
        direction = 'bear';
        conclusion = '下跌途中缩量：判定阴跌延续，没有承接资金，不言底';
      } else {
        scenario = '缩量下跌';
        direction = 'observe';
        conclusion = '下跌叠加缩量：抛压衰减，标记为观察止跌机会';
      }
    } else {
      scenario = '平量下跌';
      direction = 'neutral';
      conclusion = '平量下跌，量价无显著方向';
    }
  }

  return { scenario, direction, conclusion, tags };
}

// ===================== 7. 连续量能序列（spec 第八章） =====================

function _sequenceRule(pc) {
  const n = pc.n;
  if (n < 3) return { type: '无显著序列', bullConfirm: false, note: 'K 线不足 3 根，无法判定连续量能序列' };
  const v = [pc.vols[n - 3], pc.vols[n - 2], pc.vols[n - 1]];
  const c = [pc.closes[n - 3], pc.closes[n - 2], pc.closes[n - 1]];
  if (v[0] < v[1] && v[1] < v[2] && c[0] < c[1] && c[1] < c[2]) {
    return { type: '连续递增', bullConfirm: true, note: '成交量依次放大且价格同步抬升：判定多头趋势量能确认，额外加分' };
  }
  if (v[0] > v[1] && v[1] > v[2] && c[0] > c[1] && c[1] > c[2]) {
    return { type: '连续递减', bullConfirm: false, note: '成交量依次缩小且价格同步下行：判定空头衰竭，仅作为观察信号，不作为强多头依据' };
  }
  if (pc.pulse) {
    return { type: '单根脉冲', bullConfirm: false, note: '仅最新一根 K 线巨量、前后均缩量：判定为一次性资金动作，信号可靠性打折，输出单日脉冲巨量风险标签' };
  }
  return { type: '无显著序列', bullConfirm: false, note: '最近 3 根 K 线量能无序，价格无量能配合特征' };
}

// ===================== 8. 量化打分（spec 第九章） =====================

function _scoreEngine(pc, ctx) {
  // ① 量价匹配度 40
  let s40 = 20;
  let n40 = '量价无显著方向，按基准中性计分';
  if (ctx.combo.direction === 'bull') { s40 = 40; n40 = '量价同向匹配健康（放量上涨/资金进场/健康换手）'; }
  else if (ctx.combo.direction === 'observe') { s40 = 16; n40 = '量价匹配偏向观察（抛压衰减/底部洗盘/筹码沉淀）'; }
  else if (ctx.combo.direction === 'caution') { s40 = 12; n40 = '量价存在矛盾或诱多特征，匹配度打折'; }
  else if (ctx.combo.direction === 'bear') { s40 = 8; n40 = '量价指向空头（放量下跌/派发/破位），匹配度低分'; }
  if (pc.level === '大量' || pc.level === '天量') { s40 -= 5; n40 += '；巨量/天量增风险折扣 -5'; }
  if (ctx.checks.pulse) { s40 -= 10; n40 += '；单日脉冲爆量 -10'; }
  s40 = _clamp(s40, 0, W_VOLUME_PRICE);

  // ② 连续量能趋势 30
  let s30 = 15;
  let n30 = '连续量能无序';
  if (ctx.sequence.type === '连续递增' && ctx.sequence.bullConfirm) { s30 = 30; n30 = '连续 3 根量能递增且价格抬升，多头趋势量能确认'; }
  else if (ctx.sequence.type === '连续递减') { s30 = 12; n30 = '连续 3 根量能递减且价格下行，空头衰竭仅观察'; }
  else if (ctx.sequence.type === '单根脉冲') { s30 = 8; n30 = '单根脉冲爆量，一次性资金动作，总分打折'; }
  s30 = _clamp(s30, 0, W_TREND);

  // ③ 档位适配 20
  const s20 = LEVEL_FIT_SCORE[pc.level] !== undefined ? LEVEL_FIT_SCORE[pc.level] : 10;
  const n20 = pc.level === '极度缩量' ? '极度缩量不生成看多信号，仅入观察池'
    : (pc.level === '天量' || pc.level === '大量' ? `${pc.level}增风险折扣` : `${pc.level}档位适配`);

  // ④ 背离扣分（单次最高 30）
  let divPen = 0;
  if (ctx.divergence.type === '顶背离') divPen = DIVERGE_PENALTY.top;
  else if (ctx.divergence.type === '一般量价背离') divPen = DIVERGE_PENALTY.general;
  else if (ctx.divergence.type === '底背离') divPen = DIVERGE_PENALTY.bottom;

  const base = _clamp(s40 + s30 + s20 - divPen, 0, 100);
  return {
    base,
    components: {
      volumePrice: { score: s40, max: W_VOLUME_PRICE, note: n40 },
      trend: { score: s30, max: W_TREND, note: n30 },
      levelFit: { score: s20, max: W_LEVEL_FIT, note: n20 },
    },
    divergencePenalty: divPen,
  };
}

// ===================== 9. 流动性与黑名单衰减（spec 第十章） =====================

function _liquidityCheck(pc) {
  const out = { amountPct250: pc.amountPct250, amountMedian250: pc.amountMedian250, level: null, coef: 1, tag: null, note: '' };
  if (!pc.hasAmount) {
    out.note = '成交额数据不足（日K通道无成交额字段），流动性校验降级：不做衰减，仅标注';
    return out;
  }
  if (pc.n < SAMPLE_MIN_BARS) {
    out.level = '样本不足';
    out.coef = 0.5;
    out.tag = '流动性样本不足';
    out.note = `可用历史交易日仅 ${pc.n} 根（不足 ${SAMPLE_MIN_BARS}），无法计算可靠历史百分位，量能综合得分强制乘以 0.5`;
    return out;
  }
  if (pc.amountToday < FALLBACK_AMOUNT) {
    out.level = '流动性严重不足（兜底）';
    out.coef = 0.2;
    out.tag = '低流动性';
    out.note = `单日成交额 ${_round(pc.amountToday / 1e4, 2)} 万元低于 500 万兜底线，直接判定流动性严重不足，乘以 0.2（仅过滤几乎无成交的僵尸个股）`;
    return out;
  }
  const tier = LIQ_TIERS.find(t => t.test(pc.amountPct250));
  out.level = tier.level;
  out.coef = tier.coef;
  out.tag = tier.tag;
  out.note = `当前成交额处于近 250 个交易日 ${_round(pc.amountPct250 * 100)}% 分位（中位数 ${_round(pc.amountMedian250 / 1e8, 2)} 亿元），${tier.level}`;
  return out;
}

// ===================== 10. 信号分类与汇总（spec 第十一/十二章） =====================

function _classify(ctx, score) {
  const { rules, combo, divergence, sequence, checks, position } = ctx;
  const bearTop = rules.find(r => r.matched && r.priority === 'top' && r.direction === 'bear');
  const bearPartial = rules.find(r => r.partial && r.priority === 'top');
  const bearRule = rules.find(r => r.matched && r.direction === 'bear');
  const bullRule = rules.find(r => r.matched && r.direction === 'bull');
  const blockBull = rules.find(r => r.matched && r.direction === 'bear-block');
  const bearish = !!(bearTop || bearRule || bearPartial || divergence.type === '顶背离'
    || combo.direction === 'bear' || ctx.riskTags.includes('放量杀跌'));

  let category = '中性';
  let ruleBased = false;
  let note = '';

  if (bearTop) {
    category = '看空预警';
    ruleBased = true;
    note = `命中最高优先级空头规则「${bearTop.name}」，空头结论优先级高于多头`;
  } else if (bearPartial) {
    category = '看空观察';
    ruleBased = true;
    note = `「${bearPartial.name}」初步触发，有效破位待确认，按看空观察输出`;
  } else if (bearish) {
    category = '看空观察';
    ruleBased = !!bearRule;
    note = bearRule ? `命中空头规则「${bearRule.name}」` : (divergence.type === '顶背离' ? '顶背离：多头量能衰竭' : '量价组合指向空头');
  } else if (blockBull) {
    category = '中性';
    ruleBased = true;
    note = `命中「${blockBull.name}」（多头失效信号），不得给出看多信号`;
  } else if (bullRule) {
    category = '看多信号';
    ruleBased = true;
    note = `命中多头规则「${bullRule.name}」且无空头冲突`;
  } else if (pc_level_extreme(ctx)) {
    category = '中性';
    note = '极度缩量状态不生成看多信号，仅放入观察池';
  } else if (combo.direction === 'bull' || sequence.bullConfirm) {
    category = '看多观察';
    note = '量价组合偏多但未达规则级确认，按看多观察输出';
  } else if (score.base >= 75) {
    category = '看多信号';
    note = '无规则命中，按量能基础综合得分分档（≥75）';
  } else if (score.base >= 55) {
    category = '看多观察';
    note = '无规则命中，按量能基础综合得分分档（55-75）';
  } else if (score.base >= 40) {
    category = '中性';
    note = '无规则命中，按量能基础综合得分分档（40-55）';
  } else if (score.base >= 25) {
    category = '看空观察';
    note = '无规则命中，按量能基础综合得分分档（25-40）';
  } else {
    category = '看空预警';
    note = '无规则命中，按量能基础综合得分分档（<25）';
  }
  return { category, ruleBased, note };
}

function pc_level_extreme(ctx) {
  return ctx.pc.level === '极度缩量';
}

// ===================== 主入口：纯计算 =====================

/**
 * 量能引擎纯计算入口（无网络）。
 * @param {Object} input
 * @param {Array}  input.bars      日线序列（旧→新）：{date,open,high,low,close,volume,amount?,turnover?}
 * @param {Object} [input.minutes] 分时数据 {minutes:[{time,price,avg,cumVol?}],prevClose}
 * @param {Array}  [input.blacklistReasons] 黑名单原因列表（解禁/减持/ST）
 * @param {string} [input.symbol] 代码（推断涨跌停幅度用）
 * @param {string} [input.name]   名称（ST 识别已在采集层，此处备用）
 * @param {Object} [input.marketEnv] 大盘环境 {label,discount?}，未配置则仅标注
 * @returns {Object} 结构化量能分析结果
 */
function computeVolumeEngine(input) {
  const bars = (input && Array.isArray(input.bars)) ? input.bars.filter(b => b && isFinite(b.close) && isFinite(b.volume)) : [];
  const barsSource = (input && input.barsSource) || null;
  if (bars.length < 10) {
    return {
      ok: false,
      error: `日线数据不足（可用 ${bars.length} 根，少于 10 根下限），无法进行量能分析`,
      barsSource,
      dataGaps: ['日线样本不足'],
    };
  }

  const pc = _precompute(bars);
  const { currentSideways, platform } = _sidewaysAndPlatform(bars);
  const levels = _keyLevels(pc, platform);
  const position = _detectPosition(pc, platform);
  const checks = _threeChecks(pc);
  const divergence = _detectDivergence(pc);
  const ctxBase = { bars, pc, platform, levels, position, checks, divergence, minutes: input.minutes || null, symbol: input.symbol || '', name: input.name || '' };
  const rules = _lifeRules(pc, ctxBase);

  // 持续巨量：最近 3 根中 ≥2 根为巨量/天量（每根按「量 ÷ 前 5 日均量 > 2.5」判定；spec 第五章4）
  const n = pc.n;
  const hugeFlags = pc.vols.slice(-3).map((v, i) => {
    const j = n - 3 + i;
    if (j < 5) return false;
    const a = _mean(pc.vols.slice(j - 5, j));
    return a > 0 ? v / a > 2.5 : false;
  });
  const persistentHuge = hugeFlags.filter(Boolean).length >= 2;

  const combo = _comboEngine(pc, { ...ctxBase, persistentHuge });
  const sequence = _sequenceRule(pc);

  // 有效突破/破位标记（spec 第三章3：站稳 3% 且连续 2 日）
  const breakThrough = n >= 2 && pc.closes[n - 1] > levels.resistance.price * 1.03 && pc.closes[n - 2] > levels.resistance.price * 1.03;
  const breakDown = n >= 2 && pc.closes[n - 1] < levels.support.price * 0.97 && pc.closes[n - 2] < levels.support.price * 0.97;

  const score = _scoreEngine(pc, { combo, sequence, checks, divergence });
  const liquidity = _liquidityCheck(pc);
  const blacklistReasons = Array.isArray(input.blacklistReasons) ? input.blacklistReasons.slice(0, 5) : [];
  const blacklist = {
    triggered: blacklistReasons.length > 0,
    reasons: blacklistReasons,
    coef: blacklistReasons.length > 0 ? BLACKLIST_COEF : 1,
  };

  // 大盘环境（未配置折扣 → 仅标注，不臆造数值）
  let marketCoef = 1;
  const marketNote = input.marketEnv && input.marketEnv.discount
    ? `叠加大盘环境标签「${input.marketEnv.label || '外部环境'}」，可信度按配置折扣 ×${input.marketEnv.discount}`
    : '未叠加大盘环境折扣（工作台未配置）';
  if (input.marketEnv && input.marketEnv.discount) marketCoef = input.marketEnv.discount;

  const final = _round(score.base * liquidity.coef * blacklist.coef * marketCoef, 1);

  // 风险标签集合
  const riskTags = [];
  if (divergence.type === '顶背离') riskTags.push('顶量价背离');
  if (divergence.type === '底背离') riskTags.push('底量价背离');
  if (divergence.type === '一般量价背离') riskTags.push('一般量价背离');
  if (checks.pulse) riskTags.push('单日脉冲巨量');
  if (sequence.type === '连续递减' && pc.confirm === '缩量') riskTags.push('持续缩量无动能');
  if (combo.tags.includes('放量杀跌')) riskTags.push('放量杀跌');
  rules.forEach(r => {
    if (!r.matched) return;
    if (r.id === 2) riskTags.push('高位派发');
    if (r.id === 3) { riskTags.push('缩量假突破', 'K线骗线'); }
    if (r.id === 4) riskTags.push('放量破位');
    if (r.id === 5) riskTags.push('日内无量拉升');
  });
  if (combo.tags.includes('K线骗线')) riskTags.push('K线骗线');
  if (liquidity.tag) riskTags.push(liquidity.tag);
  if (blacklist.triggered) riskTags.push('黑名单衰减');
  if (position.divergence) riskTags.push('位置判定分歧');
  checks.failed.forEach(f => { if (f !== '单日脉冲') riskTags.push(f); });
  const riskTagSet = [...new Set(riskTags)];

  const ctxFull = { ...ctxBase, rules, combo, sequence, riskTags: riskTagSet, persistentHuge, pc };
  const signal = _classify(ctxFull, score);

  // 四维度客观描述（spec 第十一章）
  const dimensions = {
    volumeState: `量能档位${pc.level}（当前量 ÷ 5 日均量 = ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍，60 日均量口径${pc.confirm || '未确认'}）`,
    position: `价格位置${position.label}${currentSideways ? '（叠加横盘形态）' : ''}：12个月价格分位 ${pc.pricePct12m !== null ? _round(pc.pricePct12m * 100) + '%' : '数据不足'}；关键支撑 ${_round(levels.support.price)}（${levels.support.kind}）/ 关键压力 ${_round(levels.resistance.price)}（${levels.resistance.kind}）`,
    capitalBehavior: combo.conclusion,
    chipTransfer: _chipTransfer(rules, combo, pc),
  };

  // 结论提示（自然语言，不含交易指令）
  const ruleHit = rules.find(r => r.matched);
  let conclusion;
  if (ruleHit) {
    conclusion = `${ruleHit.conclusion}。${signal.note}`;
  } else if (combo.direction !== 'neutral') {
    conclusion = `${combo.conclusion}。${checks.failed.length ? '注意：' + checks.failed.join('、') + '，结论置信度受限。' : ''}`;
  } else {
    conclusion = '当前量价无显著异常信号，处于常态运行';
  }
  if (blacklist.triggered) conclusion += `；触发黑名单衰减（${blacklist.reasons.join('；')}），最终有效得分 ×${blacklist.coef}`;
  if (liquidity.coef !== 1) conclusion += `；${liquidity.note}`;

  // 数据不足标注汇总（只收录真正的数据缺口；规则未命中的条件解释留在各规则 dataGaps 内）
  const dataGaps = [...pc.dataGaps];
  const GAP_KEY = /数据不足|样本不足|不匹配|缺失|降级/;
  rules.forEach(r => r.dataGaps.forEach(g => { if (GAP_KEY.test(g) && !dataGaps.includes(g)) dataGaps.push(g); }));
  if (!pc.hasTurnover) { /* 已在 pc.dataGaps */ }
  if (divergence.type === null && divergence.note && divergence.note.includes('数据不足') && !dataGaps.includes(divergence.note)) dataGaps.push(divergence.note);
  // 日K通道降级来源标注（20261017d）：腾讯通道仅 OHLCV，成交额/换手率字段缺失，
  // 具体字段后果已由 pc.dataGaps 两条说明，此处补充「哪条通道、为何降级」便于溯源
  if (barsSource && barsSource !== 'eastmoney') {
    const srcLabel = barsSource === 'tencent' ? '腾讯日K（仅 OHLCV）' : barsSource;
    dataGaps.push(`日K数据源：${srcLabel}（东财通道不可达，已自动降级）`);
  }

  return {
    ok: true,
    schema: 'volume-engine-20261017d',
    symbol: input.symbol || '',
    name: input.name || '',
    date: bars[bars.length - 1].date,
    barsSource,
    volumeState: {
      level: pc.level,
      ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
      ratio10: pc.ratio10 !== null ? _round(pc.ratio10) : null,
      ratio20: pc.ratio20 !== null ? _round(pc.ratio20) : null,
      avg5: _round(pc.avg5), avg10: _round(pc.avg10), avg20: _round(pc.avg20), avg60: _round(pc.avg60),
      confirm: pc.confirm,
      volToday: pc.volToday,
      amountToday: pc.hasAmount ? pc.amountToday : null,
      turnoverToday: pc.hasTurnover ? pc.turnoverToday : null,
    },
    position: {
      label: position.label,
      sideways: currentSideways,
      pricePct12m: pc.pricePct12m !== null ? _round(pc.pricePct12m * 100) : null,
      drawdownFromHigh: pc.drawdownFromHigh !== null ? _round(pc.drawdownFromHigh) : null,
      support: { price: _round(levels.support.price), kind: levels.support.kind },
      resistance: { price: _round(levels.resistance.price), kind: levels.resistance.kind },
      platform: platform ? { high: _round(platform.high), low: _round(platform.low), days: platform.days } : null,
      ma20: pc.ma20 ? _round(pc.ma20) : null,
      ma60: pc.ma60 ? _round(pc.ma60) : null,
      breakThrough, breakDown,
      basis: position.basis,
      divergence: position.divergence,
    },
    checks: {
      authenticity: checks.authenticity,
      priceAcceptance: checks.priceAcceptance,
      persistence: checks.persistence,
      pulse: checks.pulse,
      failed: checks.failed,
    },
    divergence,
    rules: rules.map(r => ({ id: r.id, name: r.name, direction: r.direction, priority: r.priority, matched: r.matched, partial: !!r.partial, conclusion: r.conclusion, dataGaps: r.dataGaps })),
    combo: { scenario: combo.scenario, direction: combo.direction, conclusion: combo.conclusion, tags: combo.tags },
    sequence,
    score: {
      base: score.base,
      components: score.components,
      divergencePenalty: score.divergencePenalty,
      liquidityCoef: liquidity.coef,
      blacklistCoef: blacklist.coef,
      marketCoef,
      final,
    },
    liquidity: {
      amountPct250: liquidity.amountPct250 !== null ? _round(liquidity.amountPct250 * 100) : null,
      amountMedian250: liquidity.amountMedian250,
      level: liquidity.level,
      coef: liquidity.coef,
      note: liquidity.note,
    },
    blacklist,
    signal,
    riskTags: riskTagSet,
    dimensions,
    conclusion,
    marketEnvNote: marketNote,
    disclaimer: '仅量能维度分析，不构成投资建议，需要叠加估值、K 线生死位交叉验证；不涉及交易执行。',
    dataGaps,
  };
}

function _chipTransfer(rules, combo, pc) {
  const r1 = rules.find(r => r.id === 1 && r.matched);
  const r2 = rules.find(r => r.id === 2 && r.matched);
  const r4 = rules.find(r => r.id === 4 && r.matched);
  if (r2) return '主力筹码向散户转移（高位派发）';
  if (r4) return '筹码承接失效，持仓筹码集中离场（放量破位）';
  if (r1) return '筹码呈现由散户向主力集中的转移趋势（低位吸筹）';
  if (combo.scenario === '横盘持续巨量') return '筹码剧烈交换，方向不明';
  if (pc.level === '极度缩量') return '筹码沉淀，浮动筹码减少';
  if (combo.direction === 'bull') return '筹码向积极买方转移，量价配合健康';
  if (combo.direction === 'bear') return '筹码向卖方转移，抛压主导';
  return '筹码交换平稳，无显著单向转移';
}

// ===================== 采集入口：数据组装后调纯计算 =====================

/**
 * 采集 + 分析入口（供 server 路由 / 资金量能卡调用）。
 * 日K三级降级链（20261017d）：东财多主机日K（push2his→push2，唯一含成交额 amount 与
 * 换手率 turnover 的日K通道）→ 腾讯日K（仅 OHLCV，缺字段由引擎按 spec 降级并如实标注）。
 * 任一级拿到 ≥10 根即采用；全部不可达则保留最长可用集，引擎如实输出「日线数据不足（可用 N 根）」。
 * 其余通道：腾讯分时（规则 2/5）+ 东财公告（黑名单解禁/减持）+ ST 名称识别。
 * 任一通道失败只降级对应字段并如实标注，不阻塞其他维度。
 */
async function analyzeVolume(symbol, name, quote, opts = {}) {
  const { detectMarket, fetchTencentMinutes } = require('./stockData');
  const { searchAnnouncementsByCode } = require('./cnscraperAdapter');

  let info = {};
  try { info = detectMarket(symbol) || {}; } catch (e) { console.warn('[VolumeEngine] detectMarket failed:', e.message); /* 市场识别失败仅影响分时/腾讯日K兜底通道，东财日K与公告不受影响，下游按「分时数据不足」降级 */ }

  const [barsResult, minuteData, ann] = await Promise.all([
    _fetchDailyBars(symbol, info),
    info.tencentCode ? fetchTencentMinutes(info.tencentCode).catch(() => null) : Promise.resolve(null),
    searchAnnouncementsByCode(symbol, 30).catch(() => null),
  ]);

  // 黑名单：近 180 天内标题含「解禁/减持」的公告 + ST/退市风险
  const blacklistReasons = [];
  const stockName = name || (quote && quote.name) || '';
  if (ann && ann.ok && Array.isArray(ann.items)) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    for (const it of ann.items) {
      const title = String(it.title || '');
      if (it.date && it.date >= cutoffStr && /解禁|减持/.test(title)) {
        blacklistReasons.push(`近期公告：${it.date} ${title.slice(0, 40)}`);
      }
    }
  }
  if (/\*?ST|退市/i.test(stockName)) {
    blacklistReasons.push(`ST/退市风险警示：${stockName}`);
  }

  return computeVolumeEngine({
    symbol,
    name: stockName,
    bars: barsResult.bars,
    barsSource: barsResult.source,
    minutes: minuteData,
    blacklistReasons,
    marketEnv: opts.marketEnv || null,
    config: opts.config || null,
  });
}

/**
 * 日K三级降级链（20261017d）。
 * ① 东财多主机日K（push2his → push2，klt=101 前复权）：唯一含成交额 amount + 换手率 turnover 的日K通道；
 * ② 腾讯日K（ifzq.gtimg qfqday）：仅 OHLCV，缺字段由 _precompute 按 spec 降级并如实标注，不臆造；
 * 任一级 ≥10 根（引擎分析下限）即采用；均不足时保留最长可用集（含真实来源标注），
 * 全部不可达返回空数组，引擎输出「日线数据不足（可用 0 根）」。
 */
async function _fetchDailyBars(symbol, info, count = 320) {
  const { fetchEastmoneyHistoryMultiHost, fetchTencentHistory } = require('./stockData');
  let best = { bars: [], source: 'none' };
  try {
    const bars = await fetchEastmoneyHistoryMultiHost(symbol, count);
    if (bars.length >= 10) return { bars, source: 'eastmoney' };
    if (bars.length > best.bars.length) best = { bars, source: 'eastmoney' };
    if (bars.length > 0) console.warn(`[VolumeEngine] eastmoney daily bars insufficient (${bars.length}), trying tencent fallback`);
  } catch (e) {
    console.warn('[VolumeEngine] fetchEastmoneyHistoryMultiHost failed:', e.message);
  }
  if (info && info.tencentCode) {
    try {
      const bars = await fetchTencentHistory(info.tencentCode, count);
      if (bars.length >= 10) return { bars, source: 'tencent' };
      if (bars.length > best.bars.length) best = { bars, source: 'tencent' };
    } catch (e) {
      console.warn('[VolumeEngine] fetchTencentHistory failed:', e.message);
    }
  }
  return best;
}

module.exports = {
  computeVolumeEngine,
  analyzeVolume,
  // 导出纯函数供单测（20261017d）
  _precompute,
  _detectPosition,
  _keyLevels,
  _threeChecks,
  _detectDivergence,
  _lifeRules,
  _comboEngine,
  _sequenceRule,
  _scoreEngine,
  _liquidityCheck,
  _sidewaysAndPlatform,
  _classify,
};
