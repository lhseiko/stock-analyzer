/**
 * 大盘技术分析融合引擎（lib/marketTechnical.js · 融合版 20260914e）
 * --------------------------------------------------------------
 * 把原「大盘技术分析（六步推演）」与「A股短线结构研判」两个首页模块合并为
 * 单一融合引擎，严格遵循用户投喂的「大盘技术分析融合版逻辑指令」七步推演：
 *   ① 趋势与结构定性  ② 统一量价引擎  ③ 指标共振与趋势过滤(ADX 门控)
 *   ④ 多周期与跨指数共振  ⑤ 短线结构执行层  ⑥ 外部变量可靠度修正
 *   ⑦ 综合决策与仓位（含置信度 + 证据链）
 *
 * 设计原则（与全局一致）：
 * 1. 代码权威：全部确定性 IF-THEN，无 LLM 数值/方向判断。
 * 2. 数据复用：技术面腾讯 K 线；外部变量 lib/macroNews（国际宏观，仅语义方向）。
 * 3. 隔离：本模块为纯重写，不改变对 downstream（sameDayJudgment/longTermJudgment）
 *    的契约——每只指数仍输出 step1..step6，且 step6.midTerm.direction /
 *    step6.shortTerm.direction 取值词汇保持「看多/看空/震荡」不变。
 * 4. 诚实合规：外部变量无精确实时报价，仅语义方向，明确标注。
 *
 * 输出（与前端/下游约定）：
 *   { success, date, updatedAt, indices[], synthesis,
 *     fused:{ state, reliable, anchors, volume, external, signals,
 *             risk, bias, position, confidence, evidenceChain,
 *             fusionSignal, resonance } }
 */

const axios = require('axios');
const { SMA, EMA, RSI, MACD, Bollinger, KDJ, ADX } = require('./analysis');
const { getMacroNews } = require('./macroNews');
const { localDate, localCompact, localDateFromTs } = require('./localDate');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQ_OPTS = { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 10000 };

// 三大指数（腾讯代码）
const INDICES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
];

// ---- 工具函数 ----
function last(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}
function mean(a) {
  const v = a.filter(x => typeof x === 'number' && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function round(x, d = 0) {
  if (x === null || x === undefined || isNaN(x)) return null;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}
function num(x) { return (typeof x === 'number' && !isNaN(x)) ? x : null; }
function pct(x) { return (x == null) ? '—' : (x > 0 ? '+' : '') + x.toFixed(2) + '%'; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---- 数据拉取（腾讯 fqkline / mkline，绕开被墙的东财 push2his）----
async function fetchKline(code, period, count) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`;
  const resp = await axios.get(url, REQ_OPTS);
  const node = resp.data && resp.data.data && resp.data.data[code];
  if (!node) return [];
  const arr = node[period] || node['qfq' + period] || [];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(d => ({
    date: String(d[0]),
    open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5],
  })).filter(b => b.close > 0);
}
async function fetchM30(code, count) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m30,,${count}`;
  const resp = await axios.get(url, REQ_OPTS);
  const node = resp.data && resp.data.data && resp.data.data[code];
  const arr = (node && node.m30) || [];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(d => ({
    date: String(d[0]),
    open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5],
  })).filter(b => b.close > 0);
}
async function fetchAllPeriods(code) {
  const [day, week, month, m30] = await Promise.all([
    fetchKline(code, 'day', 320),
    fetchKline(code, 'week', 160),
    fetchKline(code, 'month', 90),
    fetchM30(code, 160),
  ]);
  return { day, week, month, m30 };
}

// ---- 指标打包 ----
function computeIndicators(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const vols = bars.map(b => b.volume);
  const ma = {};
  [5, 10, 20, 60, 120, 250].forEach(p => { ma[p] = SMA(closes, Math.min(p, closes.length)); });
  return {
    closes, highs, lows, vols, ma,
    adx: ADX(highs, lows, closes, 14),
    macd: MACD(closes),
    kdj: KDJ(highs, lows, closes, 9),
    rsi: RSI(closes, 14),
    boll: Bollinger(closes, 20, 2),
  };
}

// 方向判定（用于周/月/日/30分周期）：last 收盘 vs MA(maP) 且 vs 前一根
function trendDirOf(bars, maP = 6) {
  if (!bars || bars.length < maP + 2) return '平';
  const closes = bars.map(b => b.close);
  const ma = SMA(closes, Math.min(maP, closes.length));
  const lastMa = last(ma);
  if (lastMa === null) return '平';
  const lastClose = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (lastClose > lastMa && lastClose >= prev) return '向上';
  if (lastClose < lastMa && lastClose <= prev) return '向下';
  if (lastClose > lastMa) return '向上';
  if (lastClose < lastMa) return '向下';
  return '平';
}
function barsFromInd(ind) {
  const bars = [];
  for (let i = 0; i < ind.closes.length; i++) {
    bars.push({ close: ind.closes[i], high: ind.highs[i], low: ind.lows[i] });
  }
  return bars;
}
// 摆动点法找最近下支撑 / 上压力
function nearestLevels(bars, current, count = 40) {
  const recent = bars.slice(-count);
  let sup = null, res = null;
  for (let i = 2; i < recent.length - 2; i++) {
    const lo = recent[i].low, hi = recent[i].high;
    if (lo < recent[i - 1].low && lo < recent[i - 2].low && lo < recent[i + 1].low && lo < recent[i + 2].low) {
      if (lo < current && (sup === null || lo > sup)) sup = lo;
    }
    if (hi > recent[i - 1].high && hi > recent[i - 2].high && hi > recent[i + 1].high && hi > recent[i + 2].high) {
      if (hi > current && (res === null || hi < res)) res = hi;
    }
  }
  return { sup, res };
}

// ---- 第一步：趋势与结构定性 ----
function step1Trend(ind) {
  const closes = ind.closes;
  const i = closes.length - 1;
  const maVals = {};
  [5, 10, 20, 60, 120, 250].forEach(p => { maVals[p] = ind.ma[p][i]; });
  const ordered = [5, 10, 20, 60, 120, 250].filter(p => maVals[p] != null);
  const vals = ordered.map(p => maVals[p]);
  let bullish = true, bearish = true;
  for (let k = 1; k < vals.length; k++) {
    if (vals[k] >= vals[k - 1]) bearish = false;
    if (vals[k] <= vals[k - 1]) bullish = false;
  }
  const arrangement = bullish ? '多头排列' : (bearish ? '空头排列' : '均线粘合/纠缠');
  const adxLast = last(ind.adx.adx);
  const plusDI = last(ind.adx.plusDI), minusDI = last(ind.adx.minusDI);
  let adxState, trendLabel;
  if (adxLast === null) { adxState = '无法判定'; trendLabel = '无法判定'; }
  else if (adxLast < 25) { adxState = '震荡市'; trendLabel = '区间震荡'; }
  else if (adxLast > 30) {
    adxState = '趋势市';
    trendLabel = bullish ? '趋势性上涨' : (bearish ? '趋势性下跌' : '区间震荡(方向不明)');
  } else { adxState = '临界(25-30)'; trendLabel = bullish ? '偏强震荡' : (bearish ? '偏弱震荡' : '区间震荡'); }
  return { maVals, arrangement, adx: adxLast, adxState, trendLabel, plusDI, minusDI };
}

// ---- 形态识别 ----
function detectPatterns(bars) {
  if (!bars || bars.length < 30) return { name: null, bias: '中性', note: '数据不足，无法判定形态' };
  const look = bars.slice(-60);
  const highs = look.map(b => b.high), lows = look.map(b => b.low), closes = look.map(b => b.close);
  const peaks = [], troughs = [];
  for (let i = 2; i < look.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) peaks.push({ i, v: highs[i] });
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) troughs.push({ i, v: lows[i] });
  }
  const lastClose = closes[closes.length - 1];
  if (peaks.length >= 2) {
    const a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
    if (Math.abs(a.v - b.v) / a.v < 0.03 && b.i - a.i > 5) {
      const neck = Math.min(...look.slice(a.i, b.i + 1).map(x => x.low));
      if (lastClose < neck) return { name: '双顶', bias: '偏空', note: `右顶 ${round(b.v)} 与左顶 ${round(a.v)} 等高，跌破颈线 ${round(neck)}` };
    }
  }
  if (troughs.length >= 2) {
    const a = troughs[troughs.length - 2], b = troughs[troughs.length - 1];
    if (Math.abs(a.v - b.v) / a.v < 0.03 && b.i - a.i > 5) {
      const neck = Math.max(...look.slice(a.i, b.i + 1).map(x => x.high));
      if (lastClose > neck) return { name: '双底', bias: '偏多', note: `右底 ${round(b.v)} 与左底 ${round(a.v)} 等高，突破颈线 ${round(neck)}` };
    }
  }
  const win = look.slice(-40);
  let hiDesc = true, loAsc = true;
  for (let i = 1; i < win.length; i++) {
    if (win[i].high > win[i - 1].high) hiDesc = false;
    if (win[i].low < win[i - 1].low) loAsc = false;
  }
  if (hiDesc && loAsc) return { name: '三角形收敛', bias: '中性', note: '高点下移、低点上移，方向待突破' };
  return { name: null, bias: '中性', note: '未识别到显著形态（无法判定）' };
}
function step2Structure(dayInd, weekInd, monthBars) {
  const monthDir = trendDirOf(monthBars, 6);
  const weekDir = trendDirOf(barsFromInd(weekInd), 6);
  const dayAboveMA60 = dayInd.ma[60][dayInd.closes.length - 1] !== null && dayInd.closes[dayInd.closes.length - 1] > dayInd.ma[60][dayInd.closes.length - 1];
  const dayAboveMA250 = dayInd.ma[250][dayInd.closes.length - 1] !== null && dayInd.closes[dayInd.closes.length - 1] > dayInd.ma[250][dayInd.closes.length - 1];
  const rsiWeek = last(weekInd.rsi);
  let structure;
  if (monthDir === '向上' && weekDir === '向上') {
    if (rsiWeek && rsiWeek > 80) structure = '主升浪末期(需防盛极而衰)';
    else if (dayAboveMA250) structure = '主升浪中期';
    else structure = '主升浪初期';
  } else if (monthDir === '向下' && weekDir === '向下') {
    structure = '下跌趋势·调整浪';
  } else if (monthDir === '向上' && weekDir === '向下') {
    structure = '中期调整(月线向上/周线向下)';
  } else if (monthDir === '向下' && weekDir === '向上') {
    structure = '下跌途中的反弹';
  } else if (dayAboveMA250) {
    structure = '底部盘整(站上长期均线)';
  } else {
    structure = '区间盘整';
  }
  const pattern = detectPatterns(dayInd._bars);
  return { monthDir, weekDir, dayAboveMA60, dayAboveMA250, rsiWeek, structure, pattern };
}

// ---- 第二步：统一量价引擎 ----
function step3Volume(ind, bars) {
  const vols = ind.vols, closes = ind.closes;
  const n = vols.length;
  const lastVol = vols[n - 1];
  const avg5 = mean(vols.slice(-5));
  const avg20 = mean(vols.slice(-20));
  const avg60 = mean(vols.slice(-60));
  let volState;
  if (avg20 && lastVol > avg20 * 2) volState = '异常放量';
  else if (avg20 && lastVol < avg20 * 0.6) volState = '地量';
  else if (avg20 && lastVol > avg20 * 1.2) volState = '温和放量';
  else if (avg20 && lastVol < avg20 * 0.8) volState = '缩量';
  else volState = '常态';
  let upVol = 0, downVol = 0, upCnt = 0, downCnt = 0;
  for (let i = 1; i < Math.min(20, n); i++) {
    const r = closes[n - i] - closes[n - i - 1];
    if (r > 0) { upVol += vols[n - i]; upCnt++; }
    else if (r < 0) { downVol += vols[n - i]; downCnt++; }
  }
  const avgUp = upCnt ? upVol / upCnt : 0, avgDown = downCnt ? downVol / downCnt : 0;
  const health = avgUp >= avgDown ? '健康' : '不健康';
  const recent = bars.slice(-60);
  const maxClose60 = Math.max(...recent.map(b => b.close));
  const lastClose = closes[n - 1];
  const isNewHigh = lastClose >= maxClose60 * 0.998;
  const divergence = isNewHigh && avg20 ? (lastVol < avg20) : false;
  const fakeBreakout = isNewHigh && avg20 ? (lastVol < avg20 * 0.9) : false;
  return { lastVol: round(lastVol), avg5: round(avg5), avg20: round(avg20), avg60: round(avg60), volState, health, divergence, fakeBreakout, isNewHigh, newHighLevel: round(maxClose60) };
}

// ---- 第三步：指标共振与趋势过滤（RSI/BOLL 加 ADX 门控）----
function step4Resonance(ind) {
  const n = ind.closes.length, i = n - 1;
  const macd = ind.macd, kdj = ind.kdj, rsi = ind.rsi, boll = ind.boll;
  const close = ind.closes[i];
  const dif = macd.dif[i], sig = macd.signal[i], hist = macd.histogram[i], histPrev = macd.histogram[i - 1];
  let macdBull = false, macdBear = false;
  if (dif != null && sig != null) {
    if (dif > sig && hist > 0 && (histPrev == null || hist >= histPrev)) macdBull = true;
    else if (dif < sig && hist < 0 && (histPrev == null || hist <= histPrev)) macdBear = true;
  }
  const k = kdj.k[i], d = kdj.d[i], kPrev = kdj.k[i - 1];
  let kdjBull = false, kdjBear = false;
  if (k != null && d != null) {
    if (k < 20 && k > kPrev && k > d) kdjBull = true;
    else if (k > 80 && k < kPrev && k < d) kdjBear = true;
    else if (k > 50 && k > d) kdjBull = true;
    else if (k < 50 && k < d) kdjBear = true;
  }
  const adxLast = last(ind.adx.adx);
  const trendMarket = (adxLast != null && adxLast > 30); // ADX>30 趋势市
  const r = rsi[i];
  let rsiBull = false, rsiBear = false;
  if (r != null) {
    if (trendMarket) {
      // 趋势市：RSI 极值只降权，不参与方向投票（中性）
      rsiBull = false; rsiBear = false;
    } else {
      if (r > 70) rsiBear = true;
      else if (r < 30) rsiBull = true;
      else if (r > 50) rsiBull = true;
      else rsiBear = true;
    }
  }
  const bMid = boll.middle[i], bUp = boll.upper[i], bLo = boll.lower[i];
  let bollBull = false, bollBear = false;
  if (bMid != null) {
    if (trendMarket) {
      // 趋势市：破上轨强势多，破下轨强势空；否则中性（不强行给方向）
      if (bUp != null && close > bUp) bollBull = true;
      else if (bLo != null && close < bLo) bollBear = true;
    } else {
      // 震荡市：破上轨超买空，破下轨超卖多；否则看中轨
      if (bUp != null && close > bUp) bollBear = true;
      else if (bLo != null && close < bLo) bollBull = true;
      else if (close > bMid) bollBull = true;
      else bollBear = true;
    }
  }
  const bull = [macdBull, kdjBull, rsiBull, bollBull].filter(Boolean).length;
  const bear = [macdBear, kdjBear, rsiBear, bollBear].filter(Boolean).length;
  const resonance = bull >= 3 ? '共振看多' : (bear >= 3 ? '共振看空' : '分歧震荡');
  return {
    bull, bear, resonance,
    detail: {
      MACD: macdBull ? '多' : (macdBear ? '空' : '中性'),
      KDJ: kdjBull ? '多' : (kdjBear ? '空' : '中性'),
      RSI: rsiBull ? '多' : (rsiBear ? '空' : '中性'),
      BOLL: bollBull ? '多' : (bollBear ? '空' : '中性'),
    },
    values: { dif: round(dif, 1), hist: round(hist, 1), k: round(k, 1), d: round(d, 1), rsi: round(r, 1), close: round(close, 1), bMid: round(bMid, 1), bUp: round(bUp, 1), bLo: round(bLo, 1) },
  };
}

// ---- 第四步：多周期共振 ----
function step5Cycle(dayBars, weekBars, monthBars, m30Bars) {
  const monthDir = trendDirOf(monthBars, 6);
  const weekDir = trendDirOf(weekBars, 6);
  const dayDir = trendDirOf(dayBars, 6);
  const m30Dir = trendDirOf(m30Bars, 20);
  let conclusion, strategy;
  if (monthDir === '向上' && weekDir === '向上' && dayDir === '向上') { conclusion = '共振主升'; strategy = '顺势持有/逢回调加仓'; }
  else if (monthDir === '向上' && weekDir === '向下' && dayDir === '向下') { conclusion = '中期调整'; strategy = '控仓观望/等周线企稳'; }
  else if (monthDir === '向下' && weekDir === '向下' && dayDir === '向上') { conclusion = '反弹行情'; strategy = '反弹减仓/快进快出'; }
  else if (monthDir === '向上' && weekDir === '向上' && dayDir === '向下') { conclusion = '回调买入机会'; strategy = '逢低分批布局'; }
  else if (monthDir === '向下' && weekDir === '向下' && dayDir === '向下') { conclusion = '共振下跌'; strategy = '避险/降低仓位'; }
  else { conclusion = '多周期分歧震荡'; strategy = '轻仓等待方向选择'; }
  return { monthDir, weekDir, dayDir, m30Dir, conclusion, strategy };
}

// ---- 量能性质辨析（§2/§5）：有效放量 vs 弱/无效放量 ----
function classifyVolume(idx) {
  const s3 = idx.step3 || {};
  const ld = idx.lastDay;
  const volUp = s3.volState === '温和放量' || s3.volState === '异常放量';
  if (!volUp) return { nature: s3.volState || '常态', effective: false };
  const upDay = ld && ld.close >= ld.open; // 收阳 = 进攻属性
  if (s3.health === '健康' && upDay) return { nature: '有效放量', effective: true };
  const why = upDay ? '放量但量价不健康' : '放量收阴';
  return { nature: '弱/无效放量', effective: false };
}

// ---- 盘中结构：跌破防守锚 + 探底回升（§5）----
function intraday(idx) {
  const ld = idx.lastDay;
  const prevLow = idx.prevLow;
  if (!ld || prevLow == null) return { breachedShort: false, recovered: false };
  const breachedShort = ld.low < prevLow - 1e-6; // 当日最低 < 前低 = 触及/跌破短期防守锚
  const midHL = (ld.high + ld.low) / 2;
  const recovered = ld.close > midHL; // 收盘回到日内上半区 = 探底回升
  return { breachedShort, recovered };
}

// ---- 第五步：短线结构执行层（每指数）----
function buildShortStruct(idx) {
  const s1 = idx.step1 || {};
  const s3 = idx.step3 || {};
  const ld = idx.lastDay;
  const prevLow = idx.prevLow;
  const ma5 = num((s1.maVals && s1.maVals[5]) || null);
  const aboveMA5 = (ma5 != null && idx.lastClose != null) ? idx.lastClose > ma5 : null;
  // 进攻确认：前一日收盘 < MA5 且当日收盘 >= MA5 才算“重新站上”
  const prevClose = idx.prevClose != null ? idx.prevClose : null;
  const reCrossMA5 = (ma5 != null && prevClose != null && idx.lastClose != null)
    ? (prevClose < ma5 && idx.lastClose >= ma5) : false;
  const v = classifyVolume(idx);
  const ic = intraday(idx);
  const dayBars = idx._bars || [];
  const lastClose = idx.lastClose;
  const swing = dayBars.length ? nearestLevels(dayBars, lastClose, 60) : { sup: null, res: null };
  const downDay = ld && ld.close < ld.open;
  const structuralDefensive = swing.sup != null ? round(swing.sup) : null;
  const breachedStructural = (structuralDefensive != null && ld && ld.low < structuralDefensive - 1e-6);
  // 短线方向（保持下游契约：看多/看空/震荡）
  let direction;
  if (aboveMA5 && v.effective && ic.recovered) direction = '看多';
  else if (downDay && ic.breachedShort && !ic.recovered) direction = '看空';
  else direction = '震荡';
  return {
    direction,
    aboveMA5: aboveMA5 === true,
    reCrossMA5,
    volumeNature: v.nature,
    volumeEffective: v.effective,
    breachedShort: ic.breachedShort,
    breachedStructural,
    recovered: ic.recovered,
    downDay: downDay === true,
    shortDefensive: prevLow != null ? round(prevLow) : null,     // 短期防守锚 = 前一日最低
    structuralDefensive,                                          // 结构防守锚 = 20-60 日摆动低点
    offensiveConfirm: reCrossMA5,                                 // 进攻确认 = 重新站上 MA5
  };
}

// ---- 第六步：综合预判（mid/short 合成，保留下游契约字段）----
function computeMA(bars, p) { return SMA(bars.map(b => b.close), Math.min(p, bars.length)); }
function step6Synthesis(s1, s2, s3, s4, s5, dayBars, weekBars) {
  const lastClose = dayBars[dayBars.length - 1].close;
  let midDir;
  if (s5.monthDir === '向上' && s5.weekDir === '向上') midDir = '看多';
  else if (s5.monthDir === '向下' && s5.weekDir === '向下') midDir = '看空';
  else if (s4.resonance === '共振看多' && s1.trendLabel.includes('上涨')) midDir = '看多';
  else if (s4.resonance === '共振看空' && s1.trendLabel.includes('下跌')) midDir = '看空';
  else midDir = '震荡';

  let shortDir;
  if (s5.dayDir === '向上' && s5.m30Dir === '向上') shortDir = '看多';
  else if (s5.dayDir === '向下' && s5.m30Dir === '向下') shortDir = '看空';
  else if (s4.resonance === '共振看多') shortDir = '看多';
  else if (s4.resonance === '共振看空') shortDir = '看空';
  else shortDir = '震荡';

  const wk = nearestLevels(weekBars, lastClose, 26 * 5);
  const ma120 = last(computeMA(dayBars, 120));
  const ma250 = last(computeMA(dayBars, 250));
  const ma60 = last(computeMA(dayBars, 60));
  const midSupport = wk.sup != null ? round(wk.sup) : (ma250 != null ? round(ma250) : null);
  const midResistance = wk.res != null ? round(wk.res) : (ma60 != null ? round(ma60) : null);
  const dy = nearestLevels(dayBars, lastClose, 40);
  const bollLo = round(s4.values.bLo), bollUp = round(s4.values.bUp);
  const shortSupport = dy.sup != null ? round(dy.sup) : (bollLo != null ? bollLo : null);
  const shortResistance = dy.res != null ? round(dy.res) : (bollUp != null ? bollUp : null);

  const logicFrags = [];
  logicFrags.push(`${s1.arrangement}、ADX=${s1.adx == null ? 'NA' : round(s1.adx)}（${s1.adxState}），判定「${s1.trendLabel}」`);
  logicFrags.push(`指标${s4.resonance}（MACD${s4.detail.MACD}/KDJ${s4.detail.KDJ}/RSI${s4.detail.RSI}/BOLL${s4.detail.BOLL}）`);
  if (s3.divergence) logicFrags.push(`量价${s3.health}，${s3.fakeBreakout ? '出现缩量新高顶背离预警' : '未见明显背离'}`);
  else logicFrags.push(`量价${s3.health}（${s3.volState}）`);
  const midLogic = logicFrags.slice(0, 3).join('；');
  const shortLogic = `${s5.dayDir === '向上' ? '日线向上' : s5.dayDir === '向下' ? '日线向下' : '日线横盘'}、30分${s5.m30Dir === '向上' ? '向上' : s5.m30Dir === '向下' ? '向下' : '横盘'}，指标${s4.resonance}`;

  let position, action;
  if (midDir === '看多' && s5.conclusion === '共振主升') { position = '维持 7-8 成仓'; action = '顺势持有，逢回调（不破关键支撑）加仓'; }
  else if (midDir === '看多') { position = '6 成仓'; action = s5.conclusion === '回调买入机会' ? '逢低分批布局' : '逢低布局'; }
  else if (midDir === '看空') { position = s5.conclusion === '共振下跌' ? '降至 3 成以下' : '降至 3-4 成'; action = s5.conclusion === '反弹行情' ? '反弹减仓、快进快出' : '控仓观望'; }
  else { position = '5 成仓均衡'; action = '轻仓等待方向选择，突破跟进/破位减仓'; }

  const watch = `未来 3-5 个交易日：若放量突破 ${shortResistance} 点则短期转多；若缩量跌破 ${shortSupport} 点则转空，需减仓。`;

  let risk;
  if (s3.divergence) risk = '缩量新高形成的量价顶背离尚未消化，若后续补量失败需防快速回踩。';
  else if (s4.resonance === '共振看空') risk = '指标已共振看空但 ADX 仍偏低，市场易把下跌误判为震荡，需防阴跌后反弹诱多。';
  else if (s1.adx != null && s1.adx < 25) risk = '当前 ADX 偏低属震荡市，警惕假突破与频繁的上下影线洗盘。';
  else if (s2.pattern && s2.pattern.name === '双顶') risk = '日线疑似双顶结构，颈线一旦放量跌破，调整空间或被放大。';
  else risk = '政策空窗期与外围波动（汇率/美债/大宗商品）可能放大短线波动，留意流动性边际变化。';

  return {
    midTerm: { direction: midDir, logic: midLogic, support: midSupport, pressure: midResistance },
    shortTerm: { direction: shortDir, logic: shortLogic, support: shortSupport, pressure: shortResistance },
    strategy: { position, action, watch },
    risk,
  };
}

// ---- 外部变量语义研判（§6）----
function gaugeExternal(macro) {
  const intl = (macro && macro.byCategory && macro.byCategory['国际宏观']) || [];
  let score = 0;
  const signals = [];
  const hawk = /(加息|美债.*上行|美债.*攀升|美债.*走高|收益率.*上行|收益率.*走高|收益率.*抬升|油价.*上涨|油价.*上行|原油.*上涨|原油.*上行|美元.*走强|美元.*上行|偏鹰|鹰派|收紧|紧缩)/;
  const dove = /(降息|美债.*回落|美债.*下行|美债.*走低|收益率.*回落|收益率.*下行|收益率.*走低|油价.*回落|油价.*下跌|原油.*下跌|原油.*下行|美元.*走弱|美元.*回落|偏鸽|鸽派|宽松|放水|释放流动性)/;
  for (const it of intl) {
    const t = (it.title || '') + ' ' + (it.summary || '');
    if (hawk.test(t)) { score += 1; signals.push({ dir: 'hawk', text: it.title || '' }); }
    else if (dove.test(t)) { score -= 1; signals.push({ dir: 'dove', text: it.title || '' }); }
  }
  const bias = score > 0 ? '偏鹰' : (score < 0 ? '偏鸽' : '中性');
  return { bias, score, signals: signals.slice(0, 6) };
}

// ---- 单指数完整推演 ----
async function analyzeIndex(idx) {
  const periods = await fetchAllPeriods(idx.code);
  const issues = [];
  if (!periods.day || periods.day.length < 60) issues.push('日线数据不足');
  if (!periods.week || periods.week.length < 10) issues.push('周线数据不足');
  if (!periods.month || periods.month.length < 6) issues.push('月线数据不足');
  if (!periods.m30 || periods.m30.length < 10) issues.push('30分数据不足');
  if (periods.day.length < 60) return { code: idx.code, name: idx.name, error: '数据不足，无法判定', issues };

  const dayInd = computeIndicators(periods.day);
  dayInd._bars = periods.day;
  const weekInd = computeIndicators(periods.week);
  const monthInd = computeIndicators(periods.month);
  const m30Ind = computeIndicators(periods.m30);

  const s1 = step1Trend(dayInd);
  const s2 = step2Structure(dayInd, weekInd, periods.month);
  const s3 = step3Volume(dayInd, periods.day);
  const s4 = step4Resonance(dayInd);
  const s5 = step5Cycle(periods.day, periods.week, periods.month, periods.m30);
  const s6 = step6Synthesis(s1, s2, s3, s4, s5, periods.day, periods.week);

  const dayN = periods.day.length;
  const lastClose = periods.day[dayN - 1].close;
  const prevClose = periods.day[dayN - 2] ? periods.day[dayN - 2].close : lastClose;
  const changePct = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

  const out = {
    code: idx.code,
    name: idx.name,
    lastClose: round(lastClose, 2),
    prevClose: round(prevClose, 2),
    date: periods.day[dayN - 1].date,
    changePct: round(changePct, 2),
    step1: s1,
    step2: s2,
    step3: s3,
    step4: s4,
    step5: s5,
    step6: s6,
    lastDay: periods.day[dayN - 1] ? {
      date: periods.day[dayN - 1].date,
      open: round(periods.day[dayN - 1].open, 2),
      close: round(periods.day[dayN - 1].close, 2),
      high: round(periods.day[dayN - 1].high, 2),
      low: round(periods.day[dayN - 1].low, 2),
      volume: periods.day[dayN - 1].volume,
    } : null,
    prevLow: periods.day[dayN - 2] ? round(periods.day[dayN - 2].low, 2) : null,
    issues: issues.length ? issues : null,
  };
  out._bars = periods.day;          // 供 buildShortStruct 用
  out.shortStruct = buildShortStruct(out);
  out._bars = undefined;            // 不序列化大数组
  return out;
}

// ---- 跨指数综合（文本投票，保留旧契约）----
function synthesize(indices) {
  const ok = indices.filter(x => !x.error);
  if (!ok.length) return '三大指数数据均不可用，无法判定。';
  const mid = ok.map(x => x.step6.midTerm.direction);
  const bull = mid.filter(d => d === '看多').length;
  const bear = mid.filter(d => d === '看空').length;
  if (bull >= 2 && bear === 0) return `三大指数技术面高度共振偏多（${bull}/3 看多），中期趋势同向向上，以逢低布局为主。`;
  if (bear >= 2 && bull === 0) return `三大指数技术面共振偏空（${bear}/3 看空），中期趋势同向向下，以控仓避险为主。`;
  if (bull >= 1 && bear >= 1) return `三大指数技术面出现分化（看多 ${bull}/看空 ${bear}），结构性机会与风险并存，宜轻仓区别对待。`;
  return `三大指数技术面以震荡为主（看多 ${bull}/看空 ${bear}/震荡 ${ok.length - bull - bear}），等待方向选择。`;
}

// ---- 第七步：融合决策与仓位（含置信度 + 证据链）----
function synthesizeFused(indices, ext) {
  const ok = indices.filter(x => !x.error);
  const n = ok.length || 1;
  // 短线结构计数
  let aboveMA5 = 0, effVol = 0, recovered = 0, breached = 0, down = 0;
  ok.forEach(x => {
    const r = x.shortStruct;
    if (r.aboveMA5) aboveMA5++;
    if (r.volumeEffective) effVol++;
    if (r.recovered) recovered++;
    if (r.breachedShort) breached++;
    if (r.downDay) down++;
  });
  // 中期方向投票
  let midBull = 0, midBear = 0;
  ok.forEach(x => {
    const d = x.step6.midTerm.direction;
    if (d === '看多') midBull++;
    else if (d === '看空') midBear++;
  });
  // 周期共振结论（取上证，或多数）
  const cycle = ok[0] ? ok[0].step5.conclusion : '多周期分歧震荡';

  // —— §5 三态（三态互斥）——
  let state;
  if (aboveMA5 >= 2 && effVol >= 2 && recovered >= 2) state = '止跌转强';
  else if (down >= 2 && breached >= 2 && recovered <= 1) state = '破位风险';
  else state = '弱势震荡';

  // —— §7 融合信号（七类）——
  const midUp = midBull >= 2, midDown = midBear >= 2, midFlat = !midUp && !midDown;
  let fusionSignal;
  if (midUp && cycle === '共振主升' && state === '止跌转强') fusionSignal = '强多';
  else if (midDown && cycle === '共振下跌' && state === '破位风险') fusionSignal = '强空';
  else if (midDown && state === '止跌转强') fusionSignal = '反弹';
  else if (midUp && state === '破位风险') fusionSignal = '回调风险';
  else if (midUp && (state === '止跌转强' || state === '弱势震荡')) fusionSignal = '偏多';
  else if ((midFlat || midDown) && state === '破位风险') fusionSignal = '偏空';
  else if (midFlat && state === '弱势震荡') fusionSignal = '震荡';
  else fusionSignal = '震荡';

  // —— §6 外部可靠度修正 ——
  let reliable = true;
  let extNote;
  if (state === '止跌转强') {
    if (ext.bias === '偏鹰') { reliable = false; extNote = '外部偏鹰（油价/美债/美元上行或美联储收紧预期），技术止跌信号易受压制，可靠性下降，需更多确认'; }
    else if (ext.bias === '偏鸽') extNote = '外部偏鸽（油价/美债回落或美联储宽松预期），技术止跌信号可靠性提升';
    else extNote = '外部环境中性，技术信号按自身量价与均线确认';
  } else if (state === '破位风险') {
    if (ext.bias === '偏鸽') extNote = '外部偏鸽略有缓和，但破位风险已现，仍以防守为主';
    else if (ext.bias === '偏鹰') extNote = '外部偏鹰叠加破位，风险进一步放大';
    else extNote = '外部环境中性，破位风险按自身技术结构判定';
  } else {
    if (ext.bias === '偏鹰') extNote = '弱势震荡叠加外部偏鹰，反弹空间受限';
    else if (ext.bias === '偏鸽') extNote = '弱势震荡但外部偏鸽，下行空间有限，等待企稳';
    else extNote = '弱势震荡，等待更明确的方向选择';
  }

  // —— §2/§5 锚点（上证为代表，其余在 indices[].shortStruct）——
  const sh = ok[0];
  const structuralDef = sh && sh.shortStruct ? sh.shortStruct.structuralDefensive : null;
  const anchors = {
    shortDefensive: sh ? sh.shortStruct.shortDefensive : null,             // 短期防守锚 = 前低
    structuralDefensive: structuralDef,                                     // 结构防守锚 = 摆动低点
    offensiveConfirm: sh ? sh.shortStruct.offensiveConfirm : false,        // 进攻确认 = 重新站上 MA5
    midSupport: sh ? sh.step6.midTerm.support : null,
    midPressure: sh ? sh.step6.midTerm.pressure : null,
  };

  // —— §2 量能 ——
  const volNature = effVol >= 2 ? '有效放量' : (ok.some(x => x.shortStruct.volumeNature === '弱/无效放量') ? '弱/无效放量' : '缩量/常态');
  const anyDivergence = ok.some(x => x.step3 && x.step3.divergence);
  const anyFake = ok.some(x => x.step3 && x.step3.fakeBreakout);
  const volume = {
    nature: volNature, effective: effVol >= 2,
    health: ok.every(x => x.step3 && x.step3.health === '健康') ? '健康' : '分化/不健康',
    divergence: anyDivergence, fakeBreakout: anyFake,
    detail: `${effVol}/${n} 指数呈有效放量；放量性质=${volNature}${anyDivergence ? '；⚠️存在缩量新高顶背离' : ''}${anyFake ? '；⚠️存在缩量假突破' : ''}`,
  };

  // —— §7 仓位（区间，非确定值）——
  let midCenter;
  if (midDown && cycle === '共振下跌') midCenter = [2, 3];
  else if (midDown) midCenter = [3, 4];
  else if (midUp && cycle === '共振主升') midCenter = [7, 8];
  else if (midUp) midCenter = [6, 6];
  else midCenter = [5, 5];
  let shortCoef;
  if (state === '止跌转强') shortCoef = [1.0, 1.2];
  else if (state === '弱势震荡') shortCoef = [0.7, 0.9];
  else shortCoef = [0.3, 0.6];
  let extCoef;
  if (ext.bias === '偏鹰') extCoef = [0.8, 0.9];
  else if (ext.bias === '偏鸽') extCoef = [1.0, 1.1];
  else extCoef = [1.0, 1.0];
  const midMid = (midCenter[0] + midCenter[1]) / 2;
  const shortMid = (shortCoef[0] + shortCoef[1]) / 2;
  const extMid = (extCoef[0] + extCoef[1]) / 2;
  const finalMid = midMid * shortMid * extMid;
  let cap = Math.min(10, midCenter[1] + 2); // 上限=中期中枢上一档
  if (ext.bias === '偏鹰') cap = Math.round(cap * 0.85); // 偏鹰下调 10-20%
  let lo = Math.max(0, Math.round(finalMid * 0.9));
  let hi = Math.min(cap, Math.round(finalMid * 1.1));
  lo = Math.min(lo, hi);
  const noAdd = (state === '破位风险' && breached >= 1 && recovered <= 1); // 硬规则：禁止加仓
  const position = {
    midCenter: `${midCenter[0]}–${midCenter[1]} 成`,
    shortCoef: `${shortCoef[0]}–${shortCoef[1]}`,
    extCoef: `${extCoef[0]}–${extCoef[1]}`,
    finalRange: [lo, hi],
    finalText: `${lo}–${hi} 成`,
    cap, noAdd,
    note: noAdd ? '风控否决：破位未收回防守锚，禁止加仓' : '未见硬否决项，按区间执行',
  };

  // —— §7 动作倾向 ——
  let bias;
  switch (fusionSignal) {
    case '强多': bias = '顺势持有，回踩 MA5 且有效放量可低吸，确认延续则持有。'; break;
    case '偏多': bias = '逢低分批，不追高；以回踩均线且量能承接时介入为主。'; break;
    case '震荡': bias = '均衡观望，等方向选择；不盲目押注突破或破位。'; break;
    case '偏空': bias = '控仓防守，降低风险暴露，等待企稳信号。'; break;
    case '强空': bias = '避险降仓，优先保护本金，反弹视为减仓机会。'; break;
    case '反弹': bias = '轻仓快进快出，不视为反转；反弹至压力位附近减仓。'; break;
    case '回调风险': bias = '暂停加仓，减仓防守，等收回防守锚并重新站上 MA5 再评估。'; break;
    default: bias = '均衡观望，等方向选择。';
  }

  // —— §4 关键信号 ——
  const panicRecover = ok.some(x => {
    const r = x.shortStruct, s3 = x.step3;
    const volUp = s3 && (s3.volState === '温和放量' || s3.volState === '异常放量');
    return r.breachedShort && r.recovered && volUp && r.downDay;
  });
  const signals = [];
  signals.push(`5日线位置：${aboveMA5}/${n} 指数收盘站上 5 日线（进攻确认=${ok.filter(x => x.shortStruct.offensiveConfirm).length}/${n} 重新站上）`);
  signals.push(`量能性质：${volNature}（有效放量 ${effVol}/${n}）${volume.divergence ? '；⚠️量价顶背离' : ''}${volume.fakeBreakout ? '；⚠️缩量假突破' : ''}`);
  if (sh && sh.prevLow != null) {
    signals.push(`防守锚（前低）：上证 ${sh.prevLow}，今日盘中 ${breached >= 1 ? '已触及/跌破' : '未破'}（${recovered}/${n} 指数探底回升至日内上半区）`);
  }
  signals.push(`探底回升：${recovered}/${n} 指数收盘回到日内上半区（${panicRecover ? '恐慌释放与承接并存' : '下方有承接'}）`);
  if (ext.bias !== '中性') signals.push(`外部变量：${ext.bias}（${ext.score > 0 ? '偏压制' : '偏支撑'}技术信号）`);

  // —— §6/§4 风险（按优先级）——
  const risk = [];
  if (breached >= 1 && recovered <= 1) risk.push(`${breached}/${n} 指数盘中跌破防守锚且未收回，失望情绪易放大，延续弱势`);
  if (aboveMA5 < 2 && effVol >= 1) risk.push('放量但多数指数未站上 5 日线，信号偏弱，警惕假突破');
  if (ext.bias === '偏鹰') risk.push('外部偏鹰（油价/美债/美元上行或美联储收紧），技术信号可靠性下降，易失效');
  if (state === '弱势震荡') risk.push('未见「站上5日线 + 有效放量」确认，不见确认不追，等待更明确企稳信号');
  if (!risk.length) risk.push('未见明确破位或强压制信号，按结构信号应对即可');

  // —— §4 置信度 ——
  let confidence;
  if (cycle === '共振主升' || cycle === '共振下跌') confidence = '高';
  else if (ok.every(x => x.step4.resonance === '分歧震荡') && ext.bias !== '偏鸽') confidence = '低';
  else confidence = '中';
  if (confidence === '高' && ext.bias === '偏鹰' && state === '止跌转强') confidence = '中';

  // —— §4 证据链 ——
  const evidenceChain = [];
  evidenceChain.push(`命中：中期看多 ${midBull}/3、看空 ${midBear}/3；周期共振「${cycle}」；短线状态「${state}」`);
  evidenceChain.push(`计数：站上MA5 ${aboveMA5}/3、有效放量 ${effVol}/3、探底回升 ${recovered}/3、破锚 ${breached}/3、收阴 ${down}/3`);
  if (state === '止跌转强' && ext.bias === '偏鹰') evidenceChain.push('冲突：技术止跌但外部偏鹰压制，可靠度下调（reliable=false）');
  if (noAdd) evidenceChain.push('风控否决：破位未收回防守锚 → 禁止加仓（硬规则优先）');
  if (confidence === '低') evidenceChain.push('分歧：指标未形成 3 票共振，且外部未明确支撑，结论置信度低');
  evidenceChain.push(`融合信号：${fusionSignal}（冲突优先级：风控 > 中期 > 短线 > 外部）`);

  return {
    state, reliable, anchors, volume,
    external: {
      bias: ext.bias, score: ext.score, reliable, note: extNote,
      signals: ext.signals,
      disclaimer: ext.bias === '中性'
        ? '外部未捕获到明确偏鹰/偏鸽信号；外部不确定性出清前 A 股技术信号仍易受压制。'
        : '外部变量基于宏观快讯语义研判（美联储/油价/美债/美元方向），非精确实时报价；精确油价与美债收益率需后续接入数据源。',
    },
    signals, risk, bias, position, confidence, evidenceChain,
    fusionSignal,
    resonance: {
      indicator: ok.map(x => `${x.name} ${x.step4.resonance}`).join('、'),
      cycle,
      cross: synthesize(indices),
    },
  };
}

// ---- 缓存（内存 + 磁盘持久化；休息日/抓取失败回退到最近可用交易日）----
let _cache = { ts: 0, date: '', data: null };
const TTL = 30 * 60 * 1000; // 30 分钟（盘后）
const _PERSIST_DIR = path.join(__dirname, '..', 'data', 'ai_cache');
const _PERSIST_FILE = path.join(_PERSIST_DIR, 'market_technical_last.json');

function _loadPersisted() {
  try {
    if (!fs.existsSync(_PERSIST_FILE)) return null;
    const obj = JSON.parse(fs.readFileSync(_PERSIST_FILE, 'utf8'));
    if (obj && obj.success && Array.isArray(obj.indices) && obj.indices.length > 0) return obj;
  } catch (_e) { /* 忽略损坏文件 */ }
  return null;
}
function _savePersisted(result) {
  try {
    if (!fs.existsSync(_PERSIST_DIR)) fs.mkdirSync(_PERSIST_DIR, { recursive: true });
    fs.writeFileSync(_PERSIST_FILE, JSON.stringify(result), 'utf8');
  } catch (_e) { /* 忽略写入失败，不影响主流程 */ }
}

async function getMarketTechnical({ force } = {}) {
  const today = localDate();
  const now = Date.now();
  if (!force && _cache.data && _cache.date === today && now - _cache.ts < TTL) {
    return _cache.data;
  }
  const [idxRes, macroRes] = await Promise.allSettled([
    Promise.all(INDICES.map(analyzeIndex)),
    getMacroNews(false),
  ]);
  const indices = idxRes.status === 'fulfilled' ? idxRes.value : [];
  const macro = macroRes.status === 'fulfilled' ? macroRes.value : null;
  const ext = gaugeExternal(macro);
  const fused = synthesizeFused(indices, ext);
  const result = {
    success: indices.some(x => !x.error),
    date: indices[0] && indices[0].date ? indices[0].date : today,
    updatedAt: new Date().toISOString(),
    indices,
    synthesis: synthesize(indices),
    fused,
    source: '技术面：腾讯行情 K 线（日/周/月/30分，前复权）；外部变量：东方财富 7×24 宏观快讯（lib/macroNews 国际宏观）。',
  };
  // 有效结果：写内存缓存 + 持久化到磁盘（休息日/抓取失败时的回退底座）
  if (indices.some(x => !x.error)) {
    _cache = { ts: now, date: today, data: result };
    _savePersisted(result);
    return result;
  }
  // 抓取为空（数据不足/瞬时失败/休市）：回退到磁盘持久化的最近交易日结果
  const persisted = _loadPersisted();
  if (persisted) {
    const fb = Object.assign({}, persisted, {
      fallback: true,
      fallbackNote: '实时行情抓取为空，已回退至最近一个有效交易日（' + persisted.date + '）的缓存数据。',
    });
    _cache = { ts: now, date: today, data: fb };
    return fb;
  }
  // 无任何可用数据：如实返回「不可用」，但绝不写入内存缓存（避免空白污染）
  return result;
}

module.exports = { getMarketTechnical, analyzeIndex, INDICES };
