/**
 * 大盘技术分析引擎（lib/marketTechnical.js）
 * --------------------------------------------------
 * 站在 A 股大盘技术面首席分析师角度，对上证指数 / 深证成指 / 创业板指
 * 执行每日收盘后的六步递进技术面推演，输出短中期预判。
 *
 * 核心原则：先大后小、先长后短、先定性后定量、多维度交叉验证。
 * 六步逻辑：趋势定性 → 形态识别 → 量价验证 → 指标共振 → 周期共振 → 综合预判。
 *
 * 所有点位均基于腾讯 fqkline 真实 K 线计算；信号矛盾或数据不足时明确标注「无法判定」。
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQ_OPTS = { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 10000 };

const { SMA, EMA, RSI, MACD, Bollinger, KDJ, ADX } = require('./analysis');

// 三大指数（腾讯代码，与 stockData.MARKET_INDEX_GROUPS.cn 一致）
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

// ---- 数据拉取（腾讯 fqkline / mkline，绕开被墙的东财 push2his）----
async function fetchKline(code, period, count) {
  // period: day | week | month
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

// 一次性拉取某指数四个周期 K 线
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

// 由指标反推 bars（供 trendDirOf 复用）
function barsFromInd(ind) {
  const bars = [];
  for (let i = 0; i < ind.closes.length; i++) {
    bars.push({ close: ind.closes[i], high: ind.highs[i], low: ind.lows[i] });
  }
  return bars;
}

// 从 bars 中找距离 current 最近的下支撑 / 上压力（摆动点法）
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

// ---- 第一步：趋势定性 ----
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

// ---- 第二步：形态识别 ----
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

// ---- 第三步：量价验证 ----
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

// ---- 第四步：指标共振 ----
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
  const r = rsi[i];
  let rsiBull = false, rsiBear = false;
  if (r != null) {
    if (r > 70) rsiBear = true;
    else if (r < 30) rsiBull = true;
    else if (r > 50) rsiBull = true;
    else rsiBear = true;
  }
  const bMid = boll.middle[i], bUp = boll.upper[i], bLo = boll.lower[i];
  let bollBull = false, bollBear = false;
  if (bMid != null) {
    if (bUp != null && close > bUp) bollBull = true;
    else if (bLo != null && close < bLo) bollBear = true;
    else if (close > bMid) bollBull = true;
    else bollBear = true;
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

// ---- 第五步：周期共振 ----
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

// ---- 第六步：综合预判 ----
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

  return {
    code: idx.code,
    name: idx.name,
    lastClose: round(lastClose, 2),
    date: periods.day[dayN - 1].date,
    changePct: round(changePct, 2),
    step1: s1,
    step2: s2,
    step3: s3,
    step4: s4,
    step5: s5,
    step6: s6,
    issues: issues.length ? issues : null,
  };
}

// ---- 跨指数综合 ----
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

// ---- 缓存 ----
let _cache = { ts: 0, date: '', data: null };
const TTL = 30 * 60 * 1000; // 30 分钟

async function getMarketTechnical({ force } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  if (!force && _cache.data && _cache.date === today && now - _cache.ts < TTL) {
    return _cache.data;
  }
  const indices = await Promise.all(INDICES.map(analyzeIndex));
  const result = {
    success: true,
    date: indices[0] && indices[0].date ? indices[0].date : today,
    updatedAt: new Date().toISOString(),
    indices,
    synthesis: synthesize(indices),
  };
  _cache = { ts: now, date: today, data: result };
  return result;
}

module.exports = { getMarketTechnical, analyzeIndex, INDICES };
