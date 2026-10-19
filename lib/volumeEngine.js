/**
 * lib/volumeEngine.js — 个股量能分析引擎（20261017g）
 *
 * 依据《AI 股票量能分析工作台统一业务逻辑说明书（最终整合版）》实现的确定性量能分析管线。
 * 纯 IF-THEN 计算，无 LLM：所有数值由代码计算，缺数据如实标注「数据不足/样本不足」，不得臆造；
 * 所有输出仅客观分析标签（看多/看空/信号/预警/观察均为分析标签），不衍生任何交易指令。
 * 20261017g 修正两项分时口径缺陷：
 *   ① 尾盘窗口按「时间戳」截取 14:30-15:00，不再取数组末尾 30 条——腾讯分时收盘后追加盘后条目
 *      （实测 2026-10-19 15:10 共 247 条，末尾 1500/1506…1510），按末尾取会把盘后算进窗口且随时间后移；
 *      且盘中未收盘时不得把「最近半小时」当尾盘，须标「分时尚未覆盖到收盘」。
 *   ② 开盘量比单位换算按日K通道自适应——分时 cumVol 恒为「手」，东财/同花顺日K为「股」、
 *      腾讯日K为「手」（实测 000902 同日 7,923,196 股 vs 80,528 手），写死 ÷100 会在腾讯降级时
 *      把基准缩小 100 倍导致开盘量比虚高、必然误判「量比超3」。
 *
 * 链路（spec 第十三章）：
 *   预计算 → 位置判定 → 量价三问 → 背离检测 → 五大生死位规则 →
 *   位置×量能组合 → 不同位置量价补充规则（7.4）→ 量比实战口诀（7.5）→
 *   常见矛盾信号（11.3）→ 连续量能序列 → 打分(0-100) → 流动性/黑名单衰减 →
 *   信号分类（含 11.2/11.3/11.4 一致性约束）+ 风险标签 + 结构化输出
 *   （四维度客观描述 + 结论提示 + 三个强制归集总结 + 免责备注）。
 *
 * 三个强制归集总结（spec 11.2/11.3/11.4，无论是否命中都必须逐条完整输出）：
 *   positionVolumeSummary  不同位置量价分析归集总结（高位放量滞涨/低位放量震荡/缩量上涨两种情况/缩量下跌两种情况）
 *   contradictionSummary   常见矛盾信号归集总结（该放量未放量/该缩量反放巨量/高位放巨量价格不涨/低位放大量价格不跌）
 *   ratioSummary           量比实战口诀归集总结（五句口诀）
 *   未命中必须写「未命中」、数据不足必须写「数据不足，无法判定」，不得留空、不得臆造。
 *
 * 日K采集降级链（20261017e，analyzeVolume 内；本机实测东财双主机被断、同花顺可达）：
 *   ① 东财多主机日K（push2his → push2，klt=101 前复权，含成交额 amount 与换手率 turnover 全字段）；
 *   ② 同花顺日K（d.10jqka all.js 压缩解码全历史 + last.js 近 140 根含成交额/换手率，重叠段闸门校验，前复权同口径）；
 *   ③ 腾讯日K（ifzq.gtimg qfqday，仅 OHLCV；成交额/换手率缺失由 _precompute 按 spec 降级并如实标注，不臆造）；
 *   任一级拿到 ≥10 根即采用；全部不可达返回空数组，引擎输出「日线数据不足」。
 *
 * 当日 bar 终值对齐（20261019b，用户 000902 新洋丰实测：东财 App 量比 0.99 / 当日 +1.87%，
 * 工作台 0.97 / +2.39%）：同花顺当日 bar 虽带今日日期，但收盘后数值仍是盘中快照
 * （close 13.69 / 79,232 手，真实终值 close 13.62 / 80,528 手）——20261019a 新鲜度判据
 * 只校验「末根日期 = 今天」，日期新鲜 ≠ 数值终值，快路径直接采用了错误快照。
 * 修复（数据一致性铁律：当日数据单一权威源）：主行情源腾讯实时 quote 为交易所终值，
 * 末根日期 = quote 日期 → 用 quote 的 OHLC/量/额覆写末根；quote 日期更新且为今日 →
 * 直接以 quote 补齐当日 bar（全通道日K集体延迟场景）。单位按通道自适应：
 * quote.volume 为「股」，tencent 通道 bar 为「手」→ ÷100，其余通道为「股」→ 原值。
 *
 * 工作台口径配置（spec 允许「由工作台配置」的参数，未配置时按此处默认并如实标注）：
 * - 均量基准不含当日（与 capitalFlow.js「量比 = 今日量 ÷ 前20日均量」同口径）；
 * - 5/10/20/60 日均量分别取最近 5/10/20/60 个交易日（不含当日）；
 * - 250 日窗口用于成交额百分位与流动性分级；日K 取 320 根 ≈ 13 个月，覆盖 12 个月价格分位；
 * - 量比阈值未配置 → 不单独以量比触发结论，以 5 日均量档位 + 60 日均量×1.5/×0.7 确认为准（spec 第三章）；
 * - 阶段新高低窗口未配置 → 取近 250 个交易日（≈12 个月）高低点；
 * - 大盘环境折扣未配置 → 输出标注「未叠加大盘环境折扣」；
 * - 黑名单「近期」取近 180 天内的解禁/减持公告标题匹配 + ST/退市风险名称识别；
 * - 7.4/7.5 子阶段阈值（低位大跌后距高点 -15%、下跌初期距高点 -10%、开盘/尾盘 30 分钟窗口等）
 *   为工作台默认口径，未配置时按此处默认并在输出中如实呈现计算依据；
 * - 20261017g 分时口径：尾盘 = 时间戳 14:30-15:00（需分时已收盘且窗口 ≥25 分钟，否则「数据不足」）；
 *   开盘量比分母单位随 barsSource 自适应（tencent 日K为「手」→ 不除 100，其余通道为「股」→ 除 100）。
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

/**
 * 量能三态：把任意窗口量比折算为 放量 / 平量 / 缩量。
 * 20261017i：跨卡一致性修复——边界必须与 _comboEngine 的 amplified/shrunk 完全同源
 * （放大 >1.3、缩量 <0.7），任何一处改动都必须两处同步，否则「量价分析」与
 * 「量能分析」会重新出现结论互斥。
 */
function _volTriState(r) {
  if (r === null || r === undefined || !isFinite(r)) return null;
  if (r > 1.3) return 'amp';
  if (r < 0.7) return 'shrink';
  return 'flat';
}

/**
 * 统一量能档位（20261017i 新增，全工作台「放量/缩量」唯一真值源）。
 * 定档依据：当日量 ÷ 前 5 日均量（基准不含当日），叠加 60 日均量 ×1.5/×0.7 二次确认；
 * 与 _comboEngine 的 amplified / shrunk 同式，保证「量价信号」「量能热度」
 * 「引擎资金行为」三处结论同源，杜绝同屏互斥。
 */
function _volumeTier(pc) {
  const amplified = pc.confirm === '放量' || (pc.ratio5 !== null && pc.ratio5 > 1.3);
  const shrunk = pc.confirm === '缩量' || (pc.ratio5 !== null && pc.ratio5 < 0.7);
  // 两类跨口径分歧，任一发生都如实标注（工作台「诚实合规」原则：不静默取一侧）
  // ① 跨窗口：近5日量能与近20日常规水平分处不同档位（近期量能突变）
  // ② 跨基准：÷5日均量档位与 60 日均量确认结论不一致（对外取判定档位，此处说明）
  const t5 = _volTriState(pc.ratio5);
  const t20 = _volTriState(pc.ratio20);
  const crossWindowOk = (t5 === null || t20 === null) ? true : t5 === t20;
  const crossBasisOk = (pc.judgedLevel === undefined || pc.judgedLevel === null) ? true : pc.judgedLevel === pc.level;
  const consistent = crossWindowOk && crossBasisOk;
  const notes = [];
  if (!crossWindowOk) {
    const r5 = pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足';
    const r20 = pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足';
    const trend = (t5 === 'amp') ? '抬升' : (t5 === 'shrink') ? '回落' : '回归';
    notes.push(`近5日量能（÷5日均量 ${r5} 倍）与近20日常规水平（÷20日均量 ${r20} 倍）分处不同档位，近期量能较近20日水平明显${trend}`);
  }
  if (!crossBasisOk) {
    notes.push(`÷5日均量原始档位为${pc.level}，但 60 日均量口径确认为「${pc.confirm}」，对外口径取判定档位${pc.judgedLevel}`);
  }
  const divergenceNote = notes.length ? notes.join('；') : null;
  return {
    tier: (pc.judgedLevel !== undefined && pc.judgedLevel !== null) ? pc.judgedLevel : pc.level,
    ratio5Level: pc.level,
    basis: '当日量 ÷ 前5日均量（基准不含当日），叠加 60 日均量 ×1.5/×0.7 确认',
    ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
    ratio20: pc.ratio20 !== null ? _round(pc.ratio20) : null,
    confirm: pc.confirm,
    amplified,
    shrunk,
    consistent,
    divergenceNote,
  };
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

  // 20261017i：判定性档位 judgedLevel —— 综合「5 日均量档位」与「60 日均量确认」，
  // 与 _comboEngine 的 amplified / shrunk 完全同式（放大：confirm==='放量' 或 ratio5>1.3；
  // 缩量：confirm==='缩量' 或 ratio5<0.7）。
  // 背景：pc.level 是纯描述性档位（只看 ÷5日均量），而 combo 判定时取「档位 or 60日确认」
  // 的并集，两者不同源 → 同一只票会出现「量能档位=平量」却「资金行为=缩量上涨」的自相
  // 矛盾（实测 600460 / 000902 / 002594 / 600030 等 4/15 触发，正是用户反馈的现象）。
  // 处理：展示层统一改用 judgedLevel（与结论同源），pc.level 以 ratio5Level 保留供追溯；
  // 引擎内部规则与打分仍照旧使用 pc.level，本次为纯新增字段，零副作用。
  let judgedLevel = '数据不足';
  if (ratio5 !== null) {
    const ampNow = confirm === '放量' || ratio5 > 1.3;
    const shrNow = confirm === '缩量' || ratio5 < 0.7;
    if (ampNow) judgedLevel = ratio5 > 4 ? '天量' : (ratio5 > 2.5 ? '大量' : '温和放量');
    else if (shrNow) judgedLevel = ratio5 < 0.4 ? '极度缩量' : '温和缩量';
    else judgedLevel = '平量';
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
  // 20261017e：部分通道（同花顺 last.js）仅近期区间带成交额/换手率字段——
  // 250 日窗口样本不足时如实标注，不冒充全窗口分位/均值
  if (hasAmount && amtWin.length < 250) dataGaps.push(`成交额样本仅 ${amtWin.length} 天（不足250），250日分位按可用样本计算`);
  if (hasTurnover && turnoverWin.length < 250) dataGaps.push(`换手率样本仅 ${turnoverWin.length} 天（不足250），阶段均值按可用样本计算`);

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
    level, confirm, judgedLevel,
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

// ===================== 6.5 不同位置量价补充规则（spec 7.4，20261017f 新增） =====================

// 量能性状（spec 7.1/7.2 的放量/缩量定义；7.4/7.5/11.3 共用同一判定，保证口径一致）
function _volTraits(pc) {
  const r5 = pc.ratio5;
  return {
    // 明显放量：巨量/天量档，或 60 日均量口径放量确认，或 5 日量比 >1.3（量比阈值未配置时的默认档位口径）
    isHugeVol: pc.level === '大量' || pc.level === '天量' || pc.confirm === '放量' || (r5 !== null && r5 > 1.3),
    // 缩量：60 日均量口径缩量确认，或 5 日量比 <0.7
    isShrink: pc.confirm === '缩量' || (r5 !== null && r5 < 0.7),
    // 滞涨/横盘：收盘涨跌幅绝对值 <1.2%
    isStagnant: pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2,
    // 冲高回落：最高价高于收盘价 2% 以上
    fellFromHigh: pc.closeToday > 0 && (pc.highToday - pc.closeToday) / pc.closeToday >= 0.02,
  };
}

// 子阶段/状态归一：命中 → '命中'；基础条件不满足 → '未命中'；子阶段无法判定 → '数据不足'
function _subStageStatus(base, subStage) {
  if (subStage === '数据不足') return '数据不足';
  if (!base) return '未命中';
  return subStage === '位置子阶段不明' ? '数据不足' : '命中';
}

/**
 * 不同位置量价补充规则（spec 7.4）——同一成交量在不同位置含义完全相反，先判位置子阶段再判放量/缩量。
 * 返回四类形态；每类带 status（命中/未命中/数据不足）、detail 与展示结论，供 11.2 归集总结与信号分类约束消费。
 */
function _positionVolumeRules(pc, ctx) {
  const { position, rules } = ctx;
  const t = _volTraits(pc);
  const n = pc.n;
  const pos = position.label;
  const rule1 = (rules || []).find(r => r.id === 1);
  const rule2 = (rules || []).find(r => r.id === 2);
  const dd = pc.drawdownFromHigh;
  const recentLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
  const minRecentLow = recentLows.length ? Math.min(...recentLows) : null;
  // 未创新低：当日低点不低于近 20 日最低（触及前低不算「继续下跌」）
  const notNewLow = minRecentLow !== null && pc.lowToday >= minRecentLow;

  // ---- 7.4.1 高位放量滞涨（风险；与规则2 高位派发同时满足时按最高优先级空头规则处理） ----
  const hsBase = pos === '高位区间' && t.isHugeVol;
  const hsMatched = hsBase && (t.isStagnant || t.fellFromHigh);
  const highStagnant = {
    form: '高位放量滞涨',
    status: hsMatched ? '命中' : '未命中',
    matched: hsMatched,
    conclusion: hsMatched
      ? `高位放量滞涨：量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）但价格无法继续冲高（${t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，滞涨/横盘` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：筹码正在大规模交换，市场分歧极大，价格上方抛压很强。风险提示：高位派发风险；降低量价匹配得分，不得因为收阳而给健康多头满分`
      : '未命中高位放量滞涨（需同时满足：高位区间 + 巨量/天量/明显放量 + 价格滞涨/横盘/冲高回落）',
    detail: {
      positionHigh: pos === '高位区间',
      volume: t.isHugeVol ? `量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍；60 日均量口径${pc.confirm || '未确认'}）` : `量能未达明显放量标准（档位${pc.level}）`,
      priceBehavior: hsMatched
        ? (t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，价格无法继续冲高，呈滞涨/横盘状态` : `冲高回落：最高 ${_round(pc.highToday)}、收盘 ${_round(pc.closeToday)}`)
        : '价格未呈滞涨、横盘或冲高回落状态',
      interpretation: hsMatched ? '筹码正在大规模交换，市场分歧极大，价格上方抛压很强' : '未命中高位放量滞涨',
      riskHint: hsMatched ? '高位派发风险；降低量价匹配得分，不得因为收阳而给健康多头满分' : '',
      withRule2: !!(rule2 && rule2.matched),
    },
  };

  // ---- 7.4.2 低位放量震荡（观察池；与规则1 低位吸筹同时满足时以规则1 为准） ----
  const loMatched = pos === '低位区间' && t.isHugeVol && t.isStagnant && notNewLow;
  const lowOscillate = {
    form: '低位放量震荡',
    status: loMatched ? '命中' : '未命中',
    matched: loMatched,
    conclusion: loMatched
      ? `低位放量震荡：低位区间出现大成交量（档位${pc.level}），价格未继续下跌，收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，小阴小阳来回震荡且未创近 20 日新低：大量筹码正在重新分配，值得跟踪，但不直接生成看多信号，仅放入观察池。跟踪提示：等待更强上涨信号（连续递增放量、重心抬升、有效突破或低位吸筹规则确认）`
      : '未命中低位放量震荡（需同时满足：低位区间 + 大成交量 + 小阴小阳震荡 + 未创新低）',
    detail: {
      positionLow: pos === '低位区间',
      volume: t.isHugeVol ? `出现大成交量（档位${pc.level}，当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）` : `量能未达大成交量标准（档位${pc.level}）`,
      priceBehavior: loMatched
        ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，价格未继续下跌，小阴小阳来回震荡且未创近 20 日新低`
        : (notNewLow ? '价格未满足小阴小阳震荡条件' : '价格仍在创近 20 日新低，不属于震荡企稳'),
      interpretation: loMatched ? '大量筹码正在重新分配，值得跟踪，但不直接生成看多信号，仅放入观察池' : '未命中低位放量震荡',
      trackHint: loMatched ? '等待更强上涨信号：连续递增放量、重心抬升、有效突破或低位吸筹规则确认' : '',
      withRule1: !!(rule1 && rule1.matched),
    },
  };

  // ---- 7.4.3 缩量上涨的两种情况（低位启动阶段 / 高位阶段） ----
  const upBase = pc.chgPct !== null && pc.chgPct > 0 && t.isShrink && pc.ratio5 !== null;
  let upSub = '不属于缩量上涨';
  if (pc.ratio5 === null || pc.chgPct === null) upSub = '数据不足';
  else if (upBase) {
    if (pos === '低位区间') upSub = '低位启动阶段';
    else if (pos === '高位区间') upSub = '高位阶段';
    else upSub = '位置子阶段不明';
  }
  const shrinkUp = {
    form: '缩量上涨',
    status: _subStageStatus(upBase, upSub),
    matched: upBase,
    subStage: upSub,
    conclusion: upSub === '低位启动阶段'
      ? `低位缩量上涨：价格自低位启动且缩量上行（档位${pc.level}），市场卖盘少、筹码相对稳定，不需要大量成交量也能推动价格；不按「上涨缩量动能不足」强扣分，标记「低位缩量上涨、筹码稳定、待放量确认」，不直接给强看多信号`
      : upSub === '高位阶段'
        ? `高位缩量上涨：价格已连续上涨到高位，后续反弹越来越缩量（档位${pc.level}），价格仍在涨但成交量跟不上：买盘持续性存疑，量价不匹配，存在顶背离或买盘枯竭风险，纳入风险观察`
        : upSub === '位置子阶段不明'
          ? '缩量上涨，位置子阶段不明，按谨慎观察处理，数据不足'
          : upSub === '数据不足'
            ? '缩量上涨：涨跌幅或量比数据不足，无法判定'
            : '未命中缩量上涨（当前非缩量上涨形态）',
    detail: {
      volume: t.isShrink ? `缩量（档位${pc.level}，60 日均量口径${pc.confirm || '未确认'}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: `收盘涨跌幅 ${pc.chgPct !== null ? _fmtPct(pc.chgPct, 2) : '数据不足'}`,
      hint: upSub === '低位启动阶段' ? '低位缩量上涨、筹码稳定、待放量确认；不直接给强看多信号'
        : upSub === '高位阶段' ? '高位缩量上涨、买盘存疑、关注买盘能否持续；纳入风险观察'
          : upSub === '位置子阶段不明' ? '按谨慎观察处理，数据不足' : '',
    },
  };

  // ---- 7.4.4 缩量下跌的两种情况（低位大跌后 / 下跌初期） ----
  const downBase = pc.chgPct !== null && pc.chgPct < 0 && t.isShrink && pc.ratio5 !== null;
  let downSub = '不属于缩量下跌';
  if (pc.ratio5 === null || pc.chgPct === null) downSub = '数据不足';
  else if (downBase) {
    if (pos === '低位区间' && dd !== null && dd <= -15) downSub = '低位大跌后';
    else if (pos === '下跌途中' && dd !== null && dd > -10) downSub = '下跌初期';
    else downSub = '位置子阶段不明';
  }
  const shrinkDown = {
    form: '缩量下跌',
    status: _subStageStatus(downBase, downSub),
    matched: downBase,
    subStage: downSub,
    bearish: downSub === '下跌初期',
    conclusion: downSub === '低位大跌后'
      ? `低位大跌后缩量出清：连续大跌后处于低位（距阶段高点 ${_fmtPct(dd)}）且成交缩到极低（档位${pc.level}）：卖盘已基本出清，浮动筹码减少，可能接近底部；不按「阴跌无承接」强扣分，仅作观察，不直接看多`
      : downSub === '下跌初期'
        ? `下跌初期缩量无承接：刚开始下跌（距阶段高点 ${_fmtPct(dd)}）就出现缩量（档位${pc.level}）：承接盘不足，下方无人愿意接盘，后续可能继续下跌；按看空观察或看空预警处理`
        : downSub === '位置子阶段不明'
          ? '缩量下跌，位置子阶段不明，按谨慎处理，数据不足'
          : downSub === '数据不足'
            ? '缩量下跌：涨跌幅或量比数据不足，无法判定'
            : '未命中缩量下跌（当前非缩量下跌形态）',
    detail: {
      volume: t.isShrink ? `缩量（档位${pc.level}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: `收盘涨跌幅 ${pc.chgPct !== null ? _fmtPct(pc.chgPct, 2) : '数据不足'}；距阶段高点 ${_fmtPct(dd)}`,
      hint: downSub === '低位大跌后' ? '低位大跌后缩量出清、潜在底部观察；仅作观察，不直接看多'
        : downSub === '下跌初期' ? '下跌初期缩量无承接、谨防延续下跌；按看空观察或看空预警处理'
          : downSub === '位置子阶段不明' ? '按谨慎处理，数据不足' : '',
    },
  };

  return { highStagnant, lowOscillate, shrinkUp, shrinkDown, traits: t };
}

// ===================== 6.6 量比实战口诀（spec 7.5，20261017f 新增） =====================

/**
 * 五句量比实战口诀。量比为辅助规则，不替代档位/三问/生死位/位置量价规则；
 * 涉及开盘、均价线、尾盘、分时持续买单的条目仅在提供分时数据时启用，
 * 仅有日线数据时标注「分时数据不足，本条无法判定」，不得臆造。
 */
function _ratioRules(pc, ctx) {
  const t = _volTraits(pc);
  const n = pc.n;
  const ms = (ctx.minutes && Array.isArray(ctx.minutes.minutes)) ? ctx.minutes.minutes : [];
  const items = [];
  const dataGaps = [];

  // ---- 口诀 1：开盘量比超 3 且股价站在均价线上方（分时） ----
  {
    const hasMin = ms.length >= 30;
    const item = { id: 1, name: '开盘量比超3且股价站在均价线上方', matched: false, status: '未命中', dataOk: hasMin, tag: null, steady: null, conclusion: '', hint: '', detail: {} };
    if (!hasMin) {
      item.status = '数据不足';
      item.conclusion = '分时数据不足，本条无法判定';
      dataGaps.push('分时数据不足，「开盘量比超3且股价站在均价线上方」无法判定');
    } else {
      // 开盘阶段 = 前 30 分钟；开盘量比按标准口径：开盘每分钟均量 ÷ 过去 5 日每日每分钟均量
      // （分时 cumVol 为「手」、日线 volume 为「股」，换算 ÷100；开盘 30 分钟占全日 240 分钟的 1/8）
      const openEnd = Math.min(30, ms.length);
      const openCum = typeof ms[openEnd - 1].cumVol === 'number' ? ms[openEnd - 1].cumVol : 0;
      // 20261017g：单位换算按日K通道自适应——分时 cumVol 恒为「手」，但日K成交量单位随通道不同：
      // 东财/同花顺日K为「股」（实测 000902 同花顺 7,923,196 股），腾讯日K为「手」（同日 80,528 手，比值≈100）。
      // 写死 ÷100 会在腾讯日K降级时把基准缩小 100 倍，导致开盘量比虚高必然误判「量比超3」。
      const unitDivisor = ctx.barsSource === 'tencent' ? 1 : 100;
      const prevAvgPerMin = pc.avg5 > 0 ? pc.avg5 / unitDivisor / 240 : 0;
      const openRatio = prevAvgPerMin > 0 ? (openCum / openEnd) / prevAvgPerMin : null;
      const lastPrice = ms[ms.length - 1].price;
      const lastAvg = ms[ms.length - 1].avg;
      const aboveAvg = isFinite(lastPrice) && isFinite(lastAvg) && lastAvg > 0 && lastPrice >= lastAvg;
      item.detail = { openRatio: openRatio !== null ? _round(openRatio) : null, aboveAvg };
      if (openRatio !== null && openRatio > 3 && aboveAvg) {
        item.matched = true;
        item.status = '命中';
        item.steady = aboveAvg; // 分时末端仍在均价线上方 → 放量后价格稳住；跌破 → 承接失败
        item.conclusion = item.steady
          ? `开盘量比 ${_round(openRatio)} 倍且股价站在均价线上方，放量后价格稳住：抛压被承接，该放量有实际意义，按观察/确认处理，不直接输出看多信号`
          : `开盘量比 ${_round(openRatio)} 倍但价格回落跌破均价线：放量承接失败，转为风险观察`;
        item.hint = item.steady
          ? '资金持续沉淀、抛压被承接、放量有意义；只输出观察/确认，不直接输出看多信号'
          : '放量承接失败，转为风险观察；不得输出看多信号';
        item.tag = item.steady ? '开盘量比超3放量待确认' : '开盘放量承接失败';
      } else {
        item.conclusion = `未命中（开盘量比 ${openRatio !== null ? _round(openRatio) : '数据不足'}，${aboveAvg ? '股价在均价线上方' : '股价未站上均价线'}，需开盘量比 >3 且站上均价线）`;
      }
    }
    items.push(item);
  }

  // ---- 口诀 2：量比从高位回落至 1 附近且股价横盘不跌（日线可判定） ----
  {
    const r5 = pc.ratio5, r5p = pc.ratio5Prev;
    const matched = r5 !== null && r5p !== null && r5p > 1.3 && r5 >= 0.8 && r5 <= 1.2
      && pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2 && pc.closePrev > 0 && pc.closeToday >= pc.closePrev * 0.995;
    items.push({
      id: 2, name: '量比从高位回落至1附近且股价横盘不跌', matched, status: matched ? '命中' : '未命中', dataOk: true, tag: matched ? '量比回落横盘卖盘变轻观察' : null,
      conclusion: matched
        ? `量比自 ${_round(r5p)} 倍回落至 ${_round(r5)} 倍（≈1 附近）且股价横盘不跌（收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}）：不要急于判断走弱，先观察卖盘是否变轻，按强势整理观察处理，不得因量比回落直接输出看空结论`
        : '未命中（需昨日量比 >1.3 回落至 0.8-1.2 且股价横盘不跌）',
      hint: matched ? '强势整理观察、成交量减少但价格不下跌；不得因量比回落直接输出看空结论' : '',
      detail: { ratio5: r5 !== null ? _round(r5) : null, ratio5Prev: r5p !== null ? _round(r5p) : null },
    });
  }

  // ---- 口诀 3：尾盘突然放量拉升（分时） ----
  {
    // 20261017g：尾盘窗口按「时间戳」截取真实交易时段最后 30 分钟（14:30-15:00），
    // 不再按数组末尾位置 m-30 截取。原因（实测 2026-10-19 15:10 取 000902 共 247 条）：
    // ①腾讯分时收盘后会追加盘后条目（末尾 6 条为 1500/1506/1507/1508/1509/1510），取末尾 30 条
    //   会把盘后非交易时段算进窗口，且窗口随追加条目持续后移（14:36 而非 14:30）；
    // ②盘中尚未收盘时取末尾 30 条会把「最近半小时」误当作尾盘（如 11:10 时判 10:40-11:10）。
    const timeOf = (x) => (/^\d{4}$/.test(String(x.time || '')) ? String(x.time) : null);
    const clockTimes = ms.map((x, i) => ({ i, t: timeOf(x) })).filter(x => x.t);
    const closed = clockTimes.some(x => x.t >= '1500');
    const tailWindow = clockTimes.filter(x => x.t >= '1430' && x.t <= '1500');
    const hasMin = closed && tailWindow.length >= 25;
    const item = { id: 3, name: '尾盘突然放量拉升', matched: false, status: '未命中', dataOk: hasMin, tag: null, conclusion: '', hint: '', detail: {} };
    if (!hasMin) {
      item.status = '数据不足';
      item.conclusion = closed
        ? '分时数据不足（尾盘 14:30-15:00 窗口不足 25 分钟），本条无法判定'
        : '分时尚未覆盖到收盘（当日未收盘），尾盘突然放量拉升需收盘后判定';
      dataGaps.push(closed
        ? '分时数据不足，「尾盘突然放量拉升」无法判定'
        : '分时尚未覆盖收盘，「尾盘突然放量拉升」无法判定');
    } else {
      // 尾盘 = 14:30-15:00 窗口；尾盘每分钟均量 vs 此前每分钟均量（≥2 倍判为突然放量）
      const first = tailWindow[0].i;
      const last = tailWindow[tailWindow.length - 1].i;
      const cumAt = (i) => (i >= 0 && typeof ms[i].cumVol === 'number' ? ms[i].cumVol : 0);
      const tailVol = cumAt(last) - (first > 0 ? cumAt(first - 1) : 0);
      const priorVol = first > 0 ? cumAt(first - 1) : 0;
      const tailPerMin = tailVol / (last - first + 1);
      const priorPerMin = first > 0 ? priorVol / first : 0;
      const priceTail = ms[last].price;
      const priceBefore = ms[first].price;
      const rally = isFinite(priceTail) && isFinite(priceBefore) && priceBefore > 0 && priceTail >= priceBefore * 1.005;
      item.detail = { tailPerMin: _round(tailPerMin), priorPerMin: _round(priorPerMin), rally };
      if (priorPerMin > 0 && tailPerMin >= 2 * priorPerMin && rally) {
        item.matched = true;
        item.status = '命中';
        item.tag = '尾盘放量拉升真实性待确认';
        item.conclusion = `尾盘突然放量拉升（尾盘每分钟均量为此前 ${_round(tailPerMin / priorPerMin)} 倍且价格走高）：不能仅因红盘判断为抢筹，需确认是否有持续买单；尾盘放量可能是资金制造价格假象，仅看量比无法区分`;
        item.hint = '尾盘放量拉升真实性待确认、警惕价格假象；不得输出看多信号';
      } else {
        item.conclusion = `未命中（尾盘每分钟均量 ${_round(tailPerMin)} vs 此前 ${_round(priorPerMin)}，${rally ? '价格走高' : '价格未走高'}，需尾盘放量 ≥2 倍且拉升）`;
      }
    }
    items.push(item);
  }

  // ---- 口诀 4：连续低成交且股价不再创新低（日线可判定） ----
  {
    const low3 = n >= 3 && pc.avg60 > 0
      && pc.vols[n - 1] < pc.avg60 * SHRINK_CONFIRM
      && pc.vols[n - 2] < pc.avg60 * SHRINK_CONFIRM
      && pc.vols[n - 3] < pc.avg60 * SHRINK_CONFIRM;
    const winLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
    const notNewLow = winLows.length > 0 && pc.lowToday > Math.min(...winLows);
    const matched = low3 && notNewLow;
    // 有效放量阳线是否已出现（出现后本条不再限制信号升级）
    const confirmed = pc.chgPct !== null && pc.chgPct > 0 && pc.confirm === '放量';
    items.push({
      id: 4, name: '连续低成交且股价不再创新低', matched, status: matched ? '命中' : '未命中', dataOk: true, confirmed,
      tag: matched && !confirmed ? '连续低成交不再新低待放量阳线' : null,
      conclusion: matched
        ? `连续低成交（近 3 日均低于 60 日均量 ×0.7）且股价不再创新低：缩量仅说明卖盘减少，放量上涨才代表新买盘真正进入${confirmed ? '；当日已出现有效放量阳线，跟踪确认成立' : '；等待后续第一根有效放量阳线确认'}`
        : '未命中（需近 3 日连续低成交且股价不再创近 20 日新低）',
      hint: matched && !confirmed ? '低成交止跌观察、等待有效放量阳线确认；在有效放量阳线出现前不得直接输出看多信号' : '',
      detail: { low3, notNewLow, confirmed },
    });
  }

  // ---- 口诀 5：量比大但股价涨不动（日线可判定） ----
  {
    const bigVol = pc.ratio5 !== null && pc.ratio5 > 2;
    const cantUp = t.isStagnant || t.fellFromHigh;
    const matched = bigVol && cantUp;
    const inHigh = ctx.position && ctx.position.label === '高位区间';
    items.push({
      id: 5, name: '量比大但股价涨不动', matched, status: matched ? '命中' : '未命中', dataOk: true,
      tag: matched ? '量比大价格滞涨警惕对倒' : null, inHigh: !!inHigh,
      conclusion: matched
        ? `量比大（当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍）但股价涨不动（${t.isStagnant ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，滞涨` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：不能直接视为资金抢筹，大量成交却推不动价格，说明上方卖压极重，需警惕是否为对倒出货；仅靠量比无法下结论，但必须提高警惕`
        : '未命中（需量比 >2 且股价涨不动/滞涨/冲高回落）',
      hint: matched
        ? (inHigh ? '按高位派发风险处理；不得输出看多信号，必须降低置信度' : '不得输出看多信号，必须降低置信度并警惕对倒风险')
        : '',
      detail: { ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null, inHigh: !!inHigh },
    });
  }

  return { items, dataGaps };
}

// ===================== 6.7 常见矛盾信号（spec 11.3，20261017f 新增） =====================

/**
 * 常见矛盾信号归集（spec 11.3）——重点识别「K 线形态好看但量能不匹配」的虚假信号。
 * 四个信号项（第三项拆「高位放巨量价格不涨 / 低位放大量价格不跌」两个子项），
 * 每项带 status/判定依据/客观结论/风险或跟踪提示，供归集总结与信号分类约束消费。
 */
function _contradictionRules(pc, ctx) {
  const t = _volTraits(pc);
  const n = pc.n;
  const pos = (ctx.position && ctx.position.label) || '';
  const levels = ctx.levels || {};
  const sequence = ctx.sequence || {};
  const rule1 = (ctx.rules || []).find(r => r.id === 1);
  const rule2 = (ctx.rules || []).find(r => r.id === 2);
  const rule3 = (ctx.rules || []).find(r => r.id === 3);
  const support = levels.support ? levels.support.price : null;
  const resistance = levels.resistance ? levels.resistance.price : null;
  // 规则1 低位吸筹完整命中 = 连续3日放量+重心企稳（spec 7.4 例外：吸筹场景放量是预期行为，不构成「该缩量反放巨量」矛盾）
  const rule1Matched = !!(rule1 && rule1.matched);

  // ---- 11.3.1 该放量的时候没有放量，资金没有跟上 ----
  const scenarios = [];
  // 攻击关键压力位：当日高点触及压力位，且须创新近 60 日新高（排除平盘股「压力位即当日自身高点」的每日误触发）
  const recent60High = n >= 2 ? Math.max(...pc.highs.slice(Math.max(0, n - 61), n - 1)) : null;
  const attackResistance = resistance !== null && recent60High !== null
    && pc.highToday >= resistance * 0.995 && pc.highToday > recent60High;
  if (attackResistance) scenarios.push('突破关键压力位');
  if (ctx.breakThrough) scenarios.push('有效突破确认');
  if (pc.chgPct !== null && pc.chgPct >= 1.2) scenarios.push('上涨确认');
  if (pos === '低位区间' && ctx.platform) scenarios.push('低位吸筹确认场景（低位+前期平台整理）');
  if (sequence.type === '连续递增') scenarios.push('连续递增量能确认');
  if (support !== null && pc.lowToday <= support * 1.01 && pc.chgPct !== null && pc.chgPct > 0 && pc.closeToday > support) scenarios.push('关键支撑反弹确认');
  const ampNotMatched = scenarios.length > 0 && !t.isHugeVol;
  const shouldAmpNot = {
    signal: '该放量未放量，资金没有跟上',
    status: ampNotMatched ? '命中' : '未命中',
    matched: ampNotMatched,
    scenario: scenarios.join('、') || '无',
    volume: `当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍（档位${pc.level}），60 日均量口径${pc.confirm || '未确认'}`,
    priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
    conclusion: ampNotMatched
      ? `该放量未放量：处于「${scenarios.join('、')}」本应放量确认的场景，但成交量未达 60 日均量 ×1.5 也未进入温和放量区（档位${pc.level}）：资金未跟上，量能不确认，K 线形态可信度下降`
      : '未命中「该放量未放量、资金未跟上」（当前无本应放量场景，或量能已有效放大）',
    riskHint: ampNotMatched ? '谨防假突破、K 线骗线、上涨动能不足；不得输出看多信号，看多观察也必须降级并注明量能不确认' : '',
    related: [rule3 && rule3.matched ? '缩量假突破' : null, pc.chgPct !== null && pc.chgPct > 0 && t.isShrink ? '上涨缩量' : null].filter(Boolean),
  };

  // ---- 11.3.2 该缩量的时候反而放巨量，市场分歧还没有结束 ----
  const shrinkScenes = [];
  if (ctx.currentSideways || t.isStagnant) shrinkScenes.push('横盘整理');
  if (pos === '上涨中途' && pc.chgPct !== null && pc.chgPct < 0) shrinkScenes.push('上涨中途缩量回调');
  if (pos === '下跌途中' && pc.chgPct !== null && pc.chgPct < 0) shrinkScenes.push('下跌途中缩量阴跌');
  if (pos === '低位区间' && pc.chgPct !== null && pc.chgPct < 0) shrinkScenes.push('低位洗盘');
  const hugeVol = pc.level === '大量' || pc.level === '天量' || pc.confirm === '放量';
  const shrinkHugeMatched = shrinkScenes.length > 0 && hugeVol && !rule1Matched;
  const shouldShrinkHuge = {
    signal: '该缩量反放巨量，分歧未结束',
    status: shrinkHugeMatched ? '命中' : '未命中',
    matched: shrinkHugeMatched,
    scenario: shrinkScenes.join('、') || '无',
    volume: `当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍（档位${pc.level}）`,
    priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
    conclusion: shrinkHugeMatched
      ? `该缩量反放巨量：处于「${shrinkScenes.join('、')}」本应缩量或量能收敛的场景，但当前量能处于${pc.level}区（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）：市场分歧未结束，筹码剧烈交换，方向尚未明朗或风险仍在释放`
      : '未命中「该缩量反放巨量、分歧未结束」（当前无本应缩量场景，或量能未达巨量/明显放量）',
    riskHint: shrinkHugeMatched
      ? `降低置信度，规避方向不明阶段，等待分歧收敛；不得输出高置信度看多信号${(pos === '高位区间' || pos === '下跌途中') ? '；同时处于高位/下跌途中，应同步输出看空观察或看空预警' : ''}`
      : '',
  };

  // ---- 11.3.3.1 高位放巨量但价格不涨，要小心 ----
  const hhMatched = pos === '高位区间' && t.isHugeVol && (t.isStagnant || t.fellFromHigh);
  const highHugeNotUp = {
    signal: '高位放巨量但价格不涨，要小心',
    status: hhMatched ? '命中' : '未命中',
    matched: hhMatched,
    conclusion: hhMatched
      ? `高位放巨量但价格不涨：高位区间量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍），价格无法继续冲高（${t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：筹码大规模交换，市场分歧极大，上方抛压强，需小心高位派发`
      : '未命中「高位放巨量但价格不涨」（需高位区间 + 巨量/明显放量 + 价格滞涨/冲高回落）',
    riskHint: hhMatched ? '高位派发风险、诱多风险、量能暴露派发事实；不得输出看多信号，必须同步输出「高位放量滞涨」或「高位派发风险」风险标签' : '',
    withRule2: !!(rule2 && rule2.matched),
    withHighStagnant: !!(ctx.pv && ctx.pv.highStagnant && ctx.pv.highStagnant.matched),
  };

  // ---- 11.3.3.2 低位放大量但价格不跌，要跟踪 ----
  const lhRecentLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
  const lhNotNewLow = lhRecentLows.length > 0 && pc.lowToday >= Math.min(...lhRecentLows);
  const lhMatched = pos === '低位区间' && t.isHugeVol && (t.isStagnant || (pc.chgPct !== null && pc.chgPct > 0)) && lhNotNewLow;
  const lowHugeNotDown = {
    signal: '低位放大量但价格不跌，要跟踪',
    status: lhMatched ? '命中' : '未命中',
    matched: lhMatched,
    conclusion: lhMatched
      ? `低位放大量但价格不跌：低位区间出现大成交量（档位${pc.level}），价格没有继续下跌（收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}），仅小阴小阳震荡或重心企稳：大量筹码正在重新分配，值得跟踪但不直接看多`
      : '未命中「低位放大量但价格不跌」（需低位区间 + 大成交量 + 价格未继续下跌）',
    trackHint: lhMatched ? '等待更强上涨信号：连续递增放量、重心抬升、有效突破或低位吸筹规则确认；只能输出观察，不得直接输出看多信号' : '',
    withRule1: !!(rule1 && rule1.matched),
    withLowOscillate: !!(ctx.pv && ctx.pv.lowOscillate && ctx.pv.lowOscillate.matched),
  };

  return { shouldAmpNot, shouldShrinkHuge, highHugeNotUp, lowHugeNotDown, traits: t };
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
  // 20261017f（spec 7.4 一致性约束）：高位放量滞涨 → 降低量价匹配得分，不得因为收阳给健康多头满分；
  // 低位缩量上涨（低位启动阶段）→ 不按「上涨缩量动能不足」强扣分
  const pv = ctx.pv || {};
  if (pv.highStagnant && pv.highStagnant.matched && s40 > 12) { s40 = 12; n40 += '；高位放量滞涨，量价匹配得分下调'; }
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段' && s40 < 16) { s40 = 16; n40 += '；低位缩量上涨，不按上涨动能不足强扣分'; }
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

/**
 * 信号分类（spec 第九章/第十一章 + 20261017f 新增 11.2/11.3/11.4 一致性约束）：
 *  - 空头类结论优先级永远高于多头类；高位派发、放量破位为最高优先级空头规则；
 *  - 命中「该放量未放量」不得输出看多信号（看多观察降级并注明量能不确认）；
 *  - 命中「高位放量滞涨 / 高位缩量上涨买盘存疑 / 高位放巨量价格不涨 / 口诀3 / 口诀5 / 口诀1」不得输出看多信号；
 *  - 命中「低位放量震荡 / 低位缩量上涨待确认 / 低位大跌后缩量出清 / 低位放大量价格不跌 / 该缩量反放巨量 / 口诀4(未确认)」
 *    只能输出观察，不得直接输出看多信号（规则1 低位吸筹完整命中时按 spec 7.4 例外处理）；
 *  - 命中「下跌初期缩量无承接」按看空观察处理；「该缩量反放巨量」且处于高位/下跌途中 → 看空观察。
 */
function _classify(ctx, score) {
  const { rules, combo, divergence, sequence, checks } = ctx;
  const position = ctx.position || {};
  const pv = ctx.pv || {};
  const ratio = ctx.ratio || {};
  const contra = ctx.contra || {};
  const rtItems = Array.isArray(ratio.items) ? ratio.items : [];
  const rt1 = rtItems[0] || {}, rt3 = rtItems[2] || {}, rt4 = rtItems[3] || {}, rt5 = rtItems[4] || {};
  const bearTop = rules.find(r => r.matched && r.priority === 'top' && r.direction === 'bear');
  const bearPartial = rules.find(r => r.partial && r.priority === 'top');
  const bearRule = rules.find(r => r.matched && r.direction === 'bear');
  const bullRule = rules.find(r => r.matched && r.direction === 'bull');
  const blockBull = rules.find(r => r.matched && r.direction === 'bear-block');
  const bearish = !!(bearTop || bearRule || bearPartial || divergence.type === '顶背离'
    || combo.direction === 'bear' || ctx.riskTags.includes('放量杀跌'));

  // ---- 20261017f：一致性约束（spec 11.2/11.3/11.4 与信号分类的关系） ----
  const rule1Matched = !!(bullRule && bullRule.id === 1); // 低位吸筹完整命中 = 连续3日放量+重心企稳（spec 7.4 例外条件）
  const noBullReasons = [];   // 命中即不得输出看多信号（连观察都需谨慎的场景由文案体现）
  const observeOnlyReasons = []; // 命中即只能输出观察（看多信号降级为看多观察）
  if (contra.shouldAmpNot && contra.shouldAmpNot.matched) noBullReasons.push('该放量未放量，量能不确认');
  if (pv.highStagnant && pv.highStagnant.matched) noBullReasons.push('高位放量滞涨');
  if (pv.shrinkUp && pv.shrinkUp.subStage === '高位阶段') noBullReasons.push('高位缩量上涨，买盘持续性存疑');
  if (contra.highHugeNotUp && contra.highHugeNotUp.matched) noBullReasons.push('高位放巨量但价格不涨');
  if (rt5.matched) noBullReasons.push('量比大但价格涨不动，警惕对倒出货');
  if (rt3.matched) noBullReasons.push('尾盘放量拉升，真实性待确认');
  if (rt1.matched) noBullReasons.push('开盘放量承接待确认');
  if (rt4.matched && !rt4.confirmed) noBullReasons.push('连续低成交不再新低，等待有效放量阳线');
  if (!rule1Matched) {
    // spec 7.4 例外：低位吸筹（规则1）完整命中时，低位放量震荡/低位放大量价格不跌不限制看多信号
    if (pv.lowOscillate && pv.lowOscillate.matched) observeOnlyReasons.push('低位放量震荡，仅跟踪观察');
    if (contra.lowHugeNotDown && contra.lowHugeNotDown.matched) observeOnlyReasons.push('低位放大量但价格不跌，仅跟踪');
  }
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段') observeOnlyReasons.push('低位缩量上涨，待放量确认');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '低位大跌后') observeOnlyReasons.push('低位大跌后缩量出清，仅观察');
  if (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched) observeOnlyReasons.push('该缩量反放巨量，分歧未结束');
  const noBullSignal = noBullReasons.length > 0 || observeOnlyReasons.length > 0;
  const capReasons = noBullReasons.concat(observeOnlyReasons);
  // 强制看空：下跌初期缩量无承接；该缩量反放巨量且处于高位/下跌途中
  const forceBear = (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期')
    || (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched && (position.label === '高位区间' || position.label === '下跌途中'));

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
  } else if (forceBear) {
    category = '看空观察';
    ruleBased = true;
    note = (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期')
      ? '缩量下跌处于下跌初期：承接盘不足，下方无人愿意接盘，按看空观察处理'
      : '该缩量场景反而放巨量且处于高位/下跌途中：市场分歧未结束，按看空观察处理';
  } else if (bearish) {
    category = '看空观察';
    ruleBased = !!bearRule;
    note = bearRule ? `命中空头规则「${bearRule.name}」` : (divergence.type === '顶背离' ? '顶背离：多头量能衰竭' : '量价组合指向空头');
  } else if (blockBull) {
    category = '中性';
    ruleBased = true;
    note = `命中「${blockBull.name}」（多头失效信号），不得给出看多信号`;
  } else if (bullRule) {
    if (noBullSignal) {
      category = '看多观察';
      ruleBased = true;
      note = `命中多头规则「${bullRule.name}」，但${capReasons.join('；')}，按看多观察输出`;
    } else {
      category = '看多信号';
      ruleBased = true;
      note = `命中多头规则「${bullRule.name}」且无空头冲突`;
    }
  } else if (pc_level_extreme(ctx)) {
    category = '中性';
    note = '极度缩量状态不生成看多信号，仅放入观察池';
  } else if (combo.direction === 'bull' || sequence.bullConfirm) {
    category = '看多观察';
    note = noBullSignal
      ? `量价组合偏多，但${capReasons.join('；')}，看多观察降级${contra.shouldAmpNot && contra.shouldAmpNot.matched ? '并注明量能不确认' : ''}`
      : '量价组合偏多但未达规则级确认，按看多观察输出';
  } else if (score.base >= 75) {
    if (noBullSignal) {
      category = '看多观察';
      note = `量能基础综合得分 ${score.base} 达看多信号档，但${capReasons.join('；')}，降级为看多观察`;
    } else {
      category = '看多信号';
      note = '无规则命中，按量能基础综合得分分档（≥75）';
    }
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

// ===================== 10.5 三个强制归集总结（spec 11.2/11.3/11.4，20261017f 新增） =====================

/**
 * 无论是否命中都必须逐条完整输出三个归集总结：
 *  - 未命中必须写「未命中」、数据不足必须写「数据不足，无法判定」，不得留空、不得臆造；
 *  - 命中多条时全部列出，不得只保留最高优先级一条而隐藏其他；
 *  - 总结性判定按「空头类优先于多头类」给出主结论，但明细必须完整。
 */
function _buildSummaries(ctx) {
  const pv = ctx.pv || {};
  const ratio = ctx.ratio || { items: [] };
  const contra = ctx.contra || {};
  const rtItems = Array.isArray(ratio.items) ? ratio.items : [];

  // ---- 11.2 不同位置量价分析归集总结 ----
  const pvItems = [
    {
      form: pv.highStagnant ? pv.highStagnant.form : '高位放量滞涨',
      status: pv.highStagnant ? pv.highStagnant.status : '数据不足',
      matched: !!(pv.highStagnant && pv.highStagnant.matched),
      conclusion: pv.highStagnant ? pv.highStagnant.conclusion : '高位放量滞涨：数据不足，无法判定',
      detail: pv.highStagnant ? pv.highStagnant.detail : {},
    },
    {
      form: pv.lowOscillate ? pv.lowOscillate.form : '低位放量震荡',
      status: pv.lowOscillate ? pv.lowOscillate.status : '数据不足',
      matched: !!(pv.lowOscillate && pv.lowOscillate.matched),
      conclusion: pv.lowOscillate ? pv.lowOscillate.conclusion : '低位放量震荡：数据不足，无法判定',
      detail: pv.lowOscillate ? pv.lowOscillate.detail : {},
    },
    {
      form: '缩量上涨',
      status: pv.shrinkUp ? pv.shrinkUp.status : '数据不足',
      matched: !!(pv.shrinkUp && pv.shrinkUp.matched),
      subStage: pv.shrinkUp ? pv.shrinkUp.subStage : '数据不足',
      conclusion: pv.shrinkUp ? pv.shrinkUp.conclusion : '缩量上涨：数据不足，无法判定',
      detail: pv.shrinkUp ? pv.shrinkUp.detail : {},
    },
    {
      form: '缩量下跌',
      status: pv.shrinkDown ? pv.shrinkDown.status : '数据不足',
      matched: !!(pv.shrinkDown && pv.shrinkDown.matched),
      subStage: pv.shrinkDown ? pv.shrinkDown.subStage : '数据不足',
      conclusion: pv.shrinkDown ? pv.shrinkDown.conclusion : '缩量下跌：数据不足，无法判定',
      detail: pv.shrinkDown ? pv.shrinkDown.detail : {},
    },
  ];
  const hitPv = pvItems.filter(i => i.status === '命中').map(i => i.form + (i.subStage ? `（${i.subStage}）` : ''));
  const gapPv = pvItems.filter(i => i.status === '数据不足').map(i => `${i.form}（${i.subStage || '数据不足'}）`);
  const missPv = pvItems.filter(i => i.status === '未命中').map(i => i.form);
  const bearPv = [];
  if (pv.highStagnant && pv.highStagnant.matched) bearPv.push('高位放量滞涨（高位派发风险）');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期') bearPv.push('下跌初期缩量无承接（谨防延续下跌）');
  const observePv = [];
  if (pv.lowOscillate && pv.lowOscillate.matched) observePv.push('低位放量震荡（等待更强上涨信号）');
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段') observePv.push('低位缩量上涨待确认');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '低位大跌后') observePv.push('低位大跌后缩量出清（潜在底部观察）');
  const positionVolumeSummary = {
    items: pvItems,
    summary: hitPv.length === 0 && gapPv.length === 0
      ? '当前未命中高位放量滞涨、低位放量震荡、缩量上涨两种情况、缩量下跌两种情况，量价形态处于常态运行'
      : `当前不同位置量价分析主要命中【${hitPv[0] || '无'}】；次要命中【${hitPv.slice(1).join('、') || '无'}】；空头优先结论为【${bearPv.length ? '有：' + bearPv.join('；') : '无'}】；观察项为【${observePv.join('；') || '无'}】；未命中项为【${missPv.join('、') || '无'}】；数据不足项为【${gapPv.join('；') || '无'}】`,
  };

  // ---- 11.3 常见矛盾信号归集总结 ----
  const contraDefs = [
    { key: 'shouldAmpNot', label: '该放量未放量，资金没有跟上' },
    { key: 'shouldShrinkHuge', label: '该缩量反放巨量，分歧未结束' },
    { key: 'highHugeNotUp', label: '高位放巨量但价格不涨，要小心' },
    { key: 'lowHugeNotDown', label: '低位放大量但价格不跌，要跟踪' },
  ];
  const contraItems = contraDefs.map(d => {
    const it = contra[d.key] || {};
    return {
      signal: d.label,
      status: it.status || '数据不足',
      matched: !!it.matched,
      scenario: it.scenario || '',
      volume: it.volume || '',
      priceBehavior: it.priceBehavior || '',
      conclusion: it.conclusion || `${d.label}：数据不足，无法判定`,
      riskHint: it.riskHint || it.trackHint || '',
    };
  });
  const hitCt = contraItems.filter(i => i.matched).map(i => i.signal);
  const gapCt = contraItems.filter(i => i.status === '数据不足').map(i => i.signal);
  const missCt = contraItems.filter(i => !i.matched && i.status !== '数据不足').map(i => i.signal);
  const bearCt = [];
  if (contra.highHugeNotUp && contra.highHugeNotUp.matched) bearCt.push('高位放巨量但价格不涨（高位派发风险）');
  if (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched && (ctx.position && (ctx.position.label === '高位区间' || ctx.position.label === '下跌途中'))) bearCt.push('该缩量反放巨量且处于高位/下跌途中（分歧未结束）');
  const watchCt = [];
  if (contra.lowHugeNotDown && contra.lowHugeNotDown.matched) watchCt.push('低位放大量但价格不跌（等待更强上涨信号）');
  if (contra.shouldAmpNot && contra.shouldAmpNot.matched) watchCt.push('该放量未放量（谨防假突破、K 线骗线）');
  const contradictionSummary = {
    items: contraItems,
    summary: hitCt.length === 0 && gapCt.length === 0
      ? '当前未命中该放量未放量、该缩量反放巨量、高位放巨量价格不涨、低位放大量价格不跌，常见矛盾信号不显著'
      : `当前常见矛盾信号主要命中【${hitCt[0] || '无'}】；次要命中【${hitCt.slice(1).join('、') || '无'}】；空头优先结论为【${bearCt.length ? '有：' + bearCt.join('；') : '无'}】；需小心的项为【${hitCt.filter(s => /高位/.test(s)).join('；') || '无'}】；需跟踪的项为【${watchCt.join('；') || '无'}】；未命中项为【${missCt.join('、') || '无'}】；数据不足项为【${gapCt.join('；') || '无'}】`,
  };

  // ---- 11.4 量比实战口诀归集总结 ----
  const rtSummaryItems = rtItems.map(it => ({
    id: it.id,
    name: it.name,
    status: it.status || '数据不足',
    matched: !!it.matched,
    dataOk: it.dataOk !== false,
    conclusion: it.conclusion || `${it.name}：数据不足，无法判定`,
    hint: it.hint || '',
    tag: it.tag || null,
    detail: it.detail || {},
  }));
  const hitRt = rtSummaryItems.filter(i => i.matched).map(i => i.name);
  const gapRt = rtSummaryItems.filter(i => i.status === '数据不足').map(i => `${i.name}（分时数据不足）`);
  const missRt = rtSummaryItems.filter(i => !i.matched && i.status !== '数据不足').map(i => i.name);
  const watchRt = rtSummaryItems.filter(i => i.matched && (i.id === 1 || i.id === 2 || i.id === 4)).map(i => i.name);
  const alertRt = rtSummaryItems.filter(i => i.matched && (i.id === 3 || i.id === 5)).map(i => i.name);
  const ratioSummary = {
    items: rtSummaryItems,
    summary: hitRt.length === 0 && gapRt.length === 0
      ? '当前未命中五句量比实战口诀，量比维度无显著异常，处于常态运行'
      : `当前量比实战口诀主要命中【${hitRt[0] || '无'}】；次要命中【${hitRt.slice(1).join('、') || '无'}】；需观察项为【${watchRt.join('；') || '无'}】；需警惕项为【${alertRt.join('；') || '无'}】；未命中项为【${missRt.join('、') || '无'}】；数据不足项为【${gapRt.join('；') || '无'}】`,
  };

  return { positionVolumeSummary, contradictionSummary, ratioSummary };
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
  const ctxBase = { bars, pc, platform, levels, position, checks, divergence, minutes: input.minutes || null, symbol: input.symbol || '', name: input.name || '', barsSource };
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

  // 20261017f：7.4 不同位置量价补充规则 / 7.5 量比实战口诀 / 11.3 常见矛盾信号
  const pv = _positionVolumeRules(pc, { ...ctxBase, rules });
  const ratio = _ratioRules(pc, ctxBase);
  const contra = _contradictionRules(pc, { ...ctxBase, rules, sequence, pv, platform, levels, currentSideways, breakThrough });

  const score = _scoreEngine(pc, { combo, sequence, checks, divergence, pv });
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
  // 20261017f：spec 11.2/11.3/11.4 风险标签同步（命中即输出对应标签，未命中不输出）
  if (pv.highStagnant.matched) riskTags.push('高位放量滞涨');
  if (pv.lowOscillate.matched) riskTags.push('低位放量震荡');
  if (pv.shrinkUp.subStage === '低位启动阶段') riskTags.push('低位缩量上涨待确认');
  if (pv.shrinkUp.subStage === '高位阶段') riskTags.push('高位缩量上涨买盘存疑');
  if (pv.shrinkDown.subStage === '低位大跌后') riskTags.push('低位大跌后缩量出清');
  if (pv.shrinkDown.subStage === '下跌初期') riskTags.push('下跌初期缩量无承接');
  if (contra.shouldAmpNot.matched) riskTags.push('该放量未放量资金未跟上');
  if (contra.shouldShrinkHuge.matched) riskTags.push('该缩量反放巨量分歧未结束');
  if (contra.highHugeNotUp.matched) riskTags.push('高位放巨量价格不涨');
  if (contra.lowHugeNotDown.matched) riskTags.push('低位放大量价格不跌');
  ratio.items.forEach(it => { if (it.tag) riskTags.push(it.tag); });
  const riskTagSet = [...new Set(riskTags)];

  const ctxFull = { ...ctxBase, rules, combo, sequence, riskTags: riskTagSet, persistentHuge, pc, pv, ratio, contra, currentSideways, breakThrough, breakDown };
  const signal = _classify(ctxFull, score);

  // 20261017f：三个强制归集总结（spec 11.2/11.3/11.4，无论是否命中都必须完整输出）
  const summaries = _buildSummaries({ pv, ratio, contra, position });

  // 四维度客观描述（spec 第十一章）
  const dimensions = {
    volumeState: `量能档位${pc.judgedLevel !== undefined ? pc.judgedLevel : pc.level}（当前量 ÷ 5 日均量 = ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍，60 日均量口径${pc.confirm || '未确认'}${(pc.judgedLevel !== undefined && pc.judgedLevel !== pc.level) ? `；÷5日均量原始档位为${pc.level}，因 60 日均量口径确认为「${pc.confirm}」，对外口径取判定档位` : ''}）`,
    position: `价格位置${position.label}${currentSideways ? '（叠加横盘形态）' : ''}：12个月价格分位 ${pc.pricePct12m !== null ? _round(pc.pricePct12m * 100) + '%' : '数据不足'}；关键支撑 ${_round(levels.support.price)}（${levels.support.kind}）/ 关键压力 ${_round(levels.resistance.price)}（${levels.resistance.kind}）`,
    capitalBehavior: combo.conclusion,
    chipTransfer: _chipTransfer(rules, combo, pc, pv),
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
  // 20261017f：7.4/7.5/11.3 命中要点并入结论提示（三个归集总结另有完整逐条输出）
  const highlights = [];
  if (pv.highStagnant.matched) highlights.push('高位放量滞涨：筹码大规模交换，上方抛压强（高位派发风险）');
  if (pv.lowOscillate.matched) highlights.push('低位放量震荡：筹码重新分配，仅跟踪观察');
  if (pv.shrinkUp.subStage === '高位阶段') highlights.push('高位缩量上涨：买盘持续性存疑');
  if (pv.shrinkUp.subStage === '低位启动阶段') highlights.push('低位缩量上涨：筹码稳定，待放量确认');
  if (pv.shrinkDown.subStage === '下跌初期') highlights.push('下跌初期缩量无承接：谨防延续下跌');
  if (pv.shrinkDown.subStage === '低位大跌后') highlights.push('低位大跌后缩量出清：潜在底部观察');
  if (contra.shouldAmpNot.matched) highlights.push('该放量未放量：资金未跟上，量能不确认');
  if (contra.shouldShrinkHuge.matched) highlights.push('该缩量反放巨量：市场分歧未结束');
  const rt5 = ratio.items.find(i => i.id === 5 && i.matched);
  if (rt5) highlights.push('量比大但价格涨不动：警惕对倒出货');
  if (highlights.length) conclusion += '；' + highlights.join('；');

  // 数据不足标注汇总（只收录真正的数据缺口；规则未命中的条件解释留在各规则 dataGaps 内）
  const dataGaps = [...pc.dataGaps];
  const GAP_KEY = /数据不足|样本不足|不匹配|缺失|降级/;
  rules.forEach(r => r.dataGaps.forEach(g => { if (GAP_KEY.test(g) && !dataGaps.includes(g)) dataGaps.push(g); }));
  // 20261017f：量比口诀中因分时数据不足而无法判定的条目，同步收录（spec：不得臆造）
  ratio.dataGaps.forEach(g => { if (!dataGaps.includes(g)) dataGaps.push(g); });
  if (!pc.hasTurnover) { /* 已在 pc.dataGaps */ }
  if (divergence.type === null && divergence.note && divergence.note.includes('数据不足') && !dataGaps.includes(divergence.note)) dataGaps.push(divergence.note);
  // 日K通道降级来源标注（20261017e）：腾讯通道仅 OHLCV；同花顺通道成交额/换手率仅覆盖近 140 根
  // （窗口样本不足由 _precompute 单独标注），具体字段后果已由 pc.dataGaps 说明，
  // 此处补充「哪条通道、为何降级」便于溯源
  if (barsSource && barsSource !== 'eastmoney') {
    const srcLabel = barsSource === 'tencent' ? '腾讯日K（仅 OHLCV）'
      : barsSource === 'ths' ? '同花顺日K（近期含成交额/换手率，历史段仅OHLCV）'
        : barsSource;
    dataGaps.push(`日K数据源：${srcLabel}（东财通道不可达，已自动降级）`);
  }

  return {
    ok: true,
    // 20261017i：输出结构新增 volumeTier（统一量能档位真值源）与 volumeState.ratio5Level
    // （原始 ÷5日均量档位），volumeState.level 语义改为判定性档位 → 升 schema 版本。
    schema: 'volume-engine-20261017i',
    symbol: input.symbol || '',
    name: input.name || '',
    date: bars[bars.length - 1].date,
    barsSource,
    volumeState: {
      // 20261017i：level 改为判定性档位 judgedLevel（与 combo 结论同源），
      // 原始 ÷5日均量档位以 ratio5Level 保留，两者不一致时由 volumeTier.divergenceNote 说明。
      level: pc.judgedLevel !== undefined ? pc.judgedLevel : pc.level,
      ratio5Level: pc.level,
      ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
      ratio10: pc.ratio10 !== null ? _round(pc.ratio10) : null,
      ratio20: pc.ratio20 !== null ? _round(pc.ratio20) : null,
      avg5: _round(pc.avg5), avg10: _round(pc.avg10), avg20: _round(pc.avg20), avg60: _round(pc.avg60),
      confirm: pc.confirm,
      volToday: pc.volToday,
      amountToday: pc.hasAmount ? pc.amountToday : null,
      turnoverToday: pc.hasTurnover ? pc.turnoverToday : null,
    },
    // 20261017i：统一量能档位真值源。capitalFlow 的「量价信号」与「量能热度」
    // 改引自此处，与下方 combo（资金行为）同源，消除三处各算一套导致的同屏互斥。
    volumeTier: _volumeTier(pc),
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
    // 20261017f：三个强制归集总结（spec 11.2/11.3/11.4，无论是否命中都必须完整输出）
    positionVolumeSummary: summaries.positionVolumeSummary,
    contradictionSummary: summaries.contradictionSummary,
    ratioSummary: summaries.ratioSummary,
  };
}

function _chipTransfer(rules, combo, pc, pv) {
  const r1 = rules.find(r => r.id === 1 && r.matched);
  const r2 = rules.find(r => r.id === 2 && r.matched);
  const r4 = rules.find(r => r.id === 4 && r.matched);
  if (r2) return '主力筹码向散户转移（高位派发）';
  if (r4) return '筹码承接失效，持仓筹码集中离场（放量破位）';
  if (r1) return '筹码呈现由散户向主力集中的转移趋势（低位吸筹）';
  // 20261017f：7.4 低位放量震荡——规则1 未完整命中时按观察口径描述
  if (pv && pv.lowOscillate && pv.lowOscillate.matched) return '大量筹码正在重新分配（低位放量震荡），值得跟踪但不直接看多';
  if (combo.scenario === '横盘持续巨量') return '筹码剧烈交换，方向不明';
  if (pc.level === '极度缩量') return '筹码沉淀，浮动筹码减少';
  if (combo.direction === 'bull') return '筹码向积极买方转移，量价配合健康';
  if (combo.direction === 'bear') return '筹码向卖方转移，抛压主导';
  return '筹码交换平稳，无显著单向转移';
}

// ===================== 采集入口：数据组装后调纯计算 =====================

/**
 * 采集 + 分析入口（供 server 路由 / 资金量能卡调用）。
 * 日K四级降级链（20261017e）：东财多主机日K（push2his→push2，含成交额 amount 与
 * 换手率 turnover 全字段）→ 同花顺日K（all.js 解码全历史 + last.js 近 140 根含成交额/换手率，
 * 重叠段闸门校验）→ 腾讯日K（仅 OHLCV，缺字段由引擎按 spec 降级并如实标注）。
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

  // 20261019b：当日 bar 实时行情终值对齐（详见 _reconcileTodayBar 注释）。
  // 日期新鲜 ≠ 数值终值——同花顺当日 bar 收盘后可能是盘中快照（000902 实测 close 13.69 vs 终值 13.62），
  // 统一以腾讯实时 quote（交易所终值）覆写/补齐当日 bar，量比与当日涨跌随之回到东财口径。
  const _now = new Date();
  const _todayStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const recon = _reconcileTodayBar(barsResult.bars, quote, barsResult.source, _todayStr);
  if (recon.appended) barsResult.stale = false; // 当日已由实时行情补齐，不再是「未包含今日数据」

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

  const result = computeVolumeEngine({
    symbol,
    name: stockName,
    bars: barsResult.bars,
    barsSource: barsResult.source,
    minutes: minuteData,
    blacklistReasons,
    marketEnv: opts.marketEnv || null,
    config: opts.config || null,
  });

  // 20261019a：降级链选中的日K若末根不是今天（停牌 / 当日K线通道延迟），
  // 如实标注——所有量能结论基于末根日期，不得让用户误以为是今日盘面。
  if (result.ok && barsResult.stale && Array.isArray(barsResult.bars) && barsResult.bars.length) {
    const lastD = barsResult.bars[barsResult.bars.length - 1].date;
    result.dataGaps.push(`日K最新一根为 ${lastD}，未包含今日数据（该股可能停牌，或当日K线通道延迟更新）——量能结论基于 ${lastD}，非今日盘面`);
  }
  // 20261019b：当日 bar 对齐动作如实留痕（通道快照滞后 / 实时行情补齐）
  if (result.ok && recon.note === 'overwritten') {
    result.dataGaps.push(`当日 bar 原为「${barsResult.source}」通道快照（close ${recon.prev.close} / 量 ${recon.prev.volume}），已按腾讯实时行情终值覆写（close ${recon.next.close} / 量 ${recon.next.volume}）`);
  } else if (result.ok && recon.note === 'appended') {
    result.dataGaps.push(`各日K通道均未提供今日数据，当日 bar 已由腾讯实时行情补齐（${quote.date}，close ${recon.next.close} / 量 ${recon.next.volume}）`);
  }

  // 20261017i：内部字段 bars —— 引擎已拉到的日K原样透出，供 capitalFlow 的「量价分析」复用
  // 同一份数据（消除「两卡各拉一份日K、连『今日』定格在哪根都可能不同」的隐患）。
  // 仅在服务端模块间传递：capitalFlow 组装完指标后即剔除，不下发前端、不进 API 响应。
  return { ...result, bars: barsResult.bars };
}

/**
 * 日K四级降级链（20261017e 建立；20261019a 采用判据升级：根数够 → 根数够且新鲜）。
 * ① 东财多主机日K（push2his → push2，klt=101 前复权）：含成交额 amount + 换手率 turnover 全字段；
 * ② 同花顺日K（all.js 压缩解码全历史 + last.js 近 140 根含成交额/换手率，重叠段 close 闸门校验；前复权同口径）；
 * ③ 腾讯日K（ifzq.gtimg qfqday）：仅 OHLCV，缺字段由 _precompute 按 spec 降级并如实标注，不臆造。
 *
 * 20261019a 缺陷修复（用户 000783 长江证券实测：东财 App 量比 0.82，工作台 1.26）：
 * 旧判据「任一级 ≥10 根即采用」只看根数不看新旧——本机东财被断，同花顺返回 140 根
 * 但当日 K 线收盘后延迟更新（末根止于 10-16），链条直接采用、不再看腾讯（腾讯有 10-19），
 * 工作台遂用 3 天前的 K 线得出与东财 App 截然不同的量比与涨跌幅。
 * 新判据：末根日期 = 今天才视为「新鲜」。某级新鲜 → 立即采用（快路径，零额外请求）；
 * 不新鲜 → 记为候选继续尝试下一级；全部候选均非新鲜（停牌 / 节假日 / 各通道集体延迟）
 * → 选「末根最新」者，并列（各通道末根一致）时按 东财>同花顺>腾讯 优先级（字段全者优先，
 * 与旧行为一致）；全部不足 10 根 → 保留最长可用集（原兜底不变）。
 * 选中的候选若非新鲜，由 analyzeVolume 在 dataGaps 如实标注「未包含今日数据」。
 */
function _chooseDailyBars(candidates, todayStr) {
  const ok = (candidates || []).filter(c => c && Array.isArray(c.bars) && c.bars.length >= 10);
  if (!ok.length) return null;
  const meta = ok.map(c => ({
    bars: c.bars, source: c.source, priority: c.priority || 0,
    lastDate: c.bars[c.bars.length - 1] && c.bars[c.bars.length - 1].date,
  }));
  const fresh = meta.find(c => c.lastDate === todayStr);
  if (fresh) return { bars: fresh.bars, source: fresh.source, lastDate: fresh.lastDate, stale: false };
  const maxDate = meta.map(c => c.lastDate).sort().pop();
  const winners = meta.filter(c => c.lastDate === maxDate).sort((a, b) => a.priority - b.priority);
  return { bars: winners[0].bars, source: winners[0].source, lastDate: winners[0].lastDate, stale: true };
}

async function _fetchDailyBars(symbol, info, count = 320) {
  const { fetchEastmoneyHistoryMultiHost, fetchThsHistory, fetchTencentHistory } = require('./stockData');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const collected = [];
  let longest = { bars: [], source: 'none' };
  const collect = (bars, source, priority) => {
    if (!Array.isArray(bars) || !bars.length) return;
    if (bars.length > longest.bars.length) longest = { bars, source };
    if (bars.length >= 10) collected.push({ bars, source, priority });
  };

  try {
    collect(await fetchEastmoneyHistoryMultiHost(symbol, count), 'eastmoney', 0);
  } catch (e) {
    console.warn('[VolumeEngine] fetchEastmoneyHistoryMultiHost failed:', e.message);
  }
  // 注意：_chooseDailyBars 对「全部候选均非新鲜」也会返回最优 stale 候选（stale:true）。
  // stale 时不得提前 return——必须继续尝试下一级（这正是 000783 缺陷的修复点：
  // 同花顺 stale 若在此返回，腾讯虽有今日数据也轮不到）。
  let chosen = _chooseDailyBars(collected, todayStr);
  if (chosen && !chosen.stale) return chosen;

  try {
    collect(await fetchThsHistory(symbol, count), 'ths', 1);
  } catch (e) {
    console.warn('[VolumeEngine] fetchThsHistory failed:', e.message);
  }
  chosen = _chooseDailyBars(collected, todayStr);
  if (chosen && !chosen.stale) return chosen;

  if (info && info.tencentCode) {
    try {
      collect(await fetchTencentHistory(info.tencentCode, count), 'tencent', 2);
    } catch (e) {
      console.warn('[VolumeEngine] fetchTencentHistory failed:', e.message);
    }
  }
  // 走完全部通道后的最终选取：有 fresh 取 fresh；全 stale 取「末根最新+通道优先」；
  // 无任何 ≥10 根候选 → 最长可用集兜底。
  chosen = _chooseDailyBars(collected, todayStr);
  if (chosen) return chosen;
  return longest;
}

/**
 * 当日 bar 实时行情终值对齐（20261019b，纯函数，导出供单测）。
 *
 * 缺陷（用户 000902 新洋丰实测：东财 App 量比 0.99 / 当日 +1.87%，工作台 0.97 / +2.39%）：
 * 本机东财通道被断，降级链采用同花顺；同花顺当日 bar 带今日日期但数值是盘中快照
 * （close 13.69 / 7,923,196 股），收盘后未固化为终值（真实 close 13.62 / 8,052,800 股）。
 * 20261019a 新鲜度判据只校验「末根日期 = 今天」——日期新鲜 ≠ 数值终值。
 *
 * 修复原则（数据一致性铁律 · 当日数据单一权威源）：主行情源腾讯实时 quote 即交易所终值
 * （qt.gtimg 实时快照，收盘后 = 收盘终值，盘中 = 实时累计），以其对齐当日 bar：
 *   ① 末根日期 = quote 日期 → 覆写末根 OHLC/量/额（数值一致时幂等不动）；
 *   ② quote 日期 > 末根日期且 = 今天 → 直接以 quote 补齐当日 bar（全通道日K集体延迟场景，
 *      与 20261019a「全 stale 选末根最新」互补：历史段用通道，当日段永远以实时行情为准）。
 *
 * 防御与单位：
 * - quote 缺失 / price 非正 / volume 非正（停牌、盘前）/ date 缺失 → 不动，返回 { note: null }；
 * - 仅当 quote.date === 末根日期才覆写（quote 陈旧时不得污染更新的 bar）；
 * - 单位按通道自适应：quote.volume 为「股」，tencent 通道 bar 为「手」→ ÷100，其余通道为「股」→ 原值；
 * - amount 仅覆写非 tencent 通道（腾讯日K仅 OHLCV，无 amount 字段）；
 * - 覆写仅在数值实质变化时返回 note='overwritten'（close 差 >0.1% 或量差 >0.5%），一致则静默幂等。
 *
 * @returns {{note: null|'overwritten'|'appended', prev?:object, next?:object}}
 */
function _reconcileTodayBar(bars, quote, barsSource, todayStr) {
  if (!Array.isArray(bars) || !bars.length) return { note: null };
  if (!quote || !isFinite(quote.price) || quote.price <= 0) return { note: null };
  if (!isFinite(quote.volume) || quote.volume <= 0) return { note: null };
  if (!quote.date) return { note: null };

  // 单位对齐：quote.volume 恒为「股」；tencent 通道 bar 为「手」→ ÷100，其余通道为「股」→ 原值
  const qVol = barsSource === 'tencent' ? quote.volume / 100 : quote.volume;
  const qBar = {
    date: quote.date,
    open: isFinite(quote.open) && quote.open > 0 ? quote.open : quote.price,
    high: isFinite(quote.high) && quote.high > 0 ? quote.high : quote.price,
    low: isFinite(quote.low) && quote.low > 0 ? quote.low : quote.price,
    close: quote.price,
    volume: qVol,
  };
  if (barsSource !== 'tencent' && isFinite(quote.amount) && quote.amount > 0) qBar.amount = quote.amount;

  const last = bars[bars.length - 1];
  if (last && last.date === quote.date) {
    const closeDiff = last.close > 0 ? Math.abs(qBar.close - last.close) / last.close : 1;
    const volDiff = last.volume > 0 ? Math.abs(qBar.volume - last.volume) / last.volume : 1;
    const material = closeDiff > 0.001 || volDiff > 0.005;
    const prev = { close: last.close, volume: last.volume };
    Object.assign(last, qBar);
    return material ? { note: 'overwritten', prev, next: { close: qBar.close, volume: qBar.volume } } : { note: null };
  }
  if (quote.date > (last ? last.date : '') && quote.date === todayStr) {
    bars.push(qBar);
    return { note: 'appended', next: { close: qBar.close, volume: qBar.volume } };
  }
  return { note: null };
}

module.exports = {
  computeVolumeEngine,
  analyzeVolume,
  // 导出纯函数供单测（20261017e）
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
  // 导出纯函数供单测（20261017f：7.4/7.5/11.3 规则与三个强制归集总结）
  _volTraits,
  _positionVolumeRules,
  _ratioRules,
  _contradictionRules,
  _buildSummaries,
  // 导出纯函数供单测（20261017i：跨卡一致性统一量能档位）
  _volTriState,
  _volumeTier,
  // 导出纯函数供单测（20261019a：日K降级链「新鲜度」选取判据）
  _chooseDailyBars,
  // 导出纯函数供单测（20261019b：当日 bar 实时行情终值对齐）
  _reconcileTodayBar,
};
