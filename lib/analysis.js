/**
 * Technical & Fundamental Analysis Module
 * Computes technical indicators (MA, EMA, RSI, MACD, Bollinger, KDJ) 
 * and fundamental scoring from stock data.
 */
const axios = require('axios');
const { detectMarket } = require('./stockData');
const db = require('./db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 规范化股票代码：去 SH/SZ/BJ 前缀，统一以数字代码作主键（与 deepAnalysis.normalizeSymbol 同口径）
function normalizeSym(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
}

// 规则一/二：PEG 落地 data_points（来源 + 90 天 TTL）；失败静默不阻断主流程。
function persistPeg(rawSymbol, peg, pegSource) {
  try {
    const sym = normalizeSym(rawSymbol);
    if (!sym || peg == null) return;
    db.upsertDataPoint({ symbol: sym, key: 'peg', value: peg, asOf: null, source: pegSource || '东方财富基本面', ttlType: 'financial' });
  } catch (e) { /* noop */ }
}

// 规则一/二：行业均值（PE/PB/ROE）落地 data_points（来源 + 90 天 TTL）；失败静默不阻断主流程。
function persistIndustryAvg(rawSymbol, industryAvg) {
  try {
    const sym = normalizeSym(rawSymbol);
    if (!sym || !industryAvg) return;
    const SRC = industryAvg.source || '东方财富行业估值';
    db.upsertDataPoint({ symbol: sym, key: 'industry_pe_avg', value: industryAvg.pe, asOf: null, source: SRC, ttlType: 'financial' });
    db.upsertDataPoint({ symbol: sym, key: 'industry_pb_avg', value: industryAvg.pb, asOf: null, source: SRC, ttlType: 'financial' });
    if (typeof industryAvg.roe === 'number') db.upsertDataPoint({ symbol: sym, key: 'industry_roe_avg', value: industryAvg.roe, asOf: null, source: SRC, ttlType: 'financial' });
  } catch (e) { /* noop */ }
}

// ---- Helper ----
function round(n, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// ---- Simple Moving Average ----
function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      result.push(round(sum / period));
    }
  }
  return result;
}

// ---- Exponential Moving Average ----
function EMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      ema = sum / period;
      result.push(round(ema));
    } else {
      ema = data[i] * k + ema * (1 - k);
      result.push(round(ema));
    }
  }
  return result;
}

// ---- RSI (Relative Strength Index) ----
function RSI(closes, period = 14) {
  const result = [];
  let gains = 0, losses = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      result.push(null);
      continue;
    }
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (i <= period) {
      gains += gain;
      losses += loss;
      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(round(100 - 100 / (1 + rs)));
      } else {
        result.push(null);
      }
    } else {
      // Wilder's smoothing
      const prevAvgGain = (result[i - 1] !== null) ? (gains / period) : 0;
      // Actually, let me use a simpler running approach
    }
  }

  // Redo with proper Wilder's method
  const rsiArr = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      rsiArr.push(null);
      continue;
    }
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiArr.push(round(100 - 100 / (1 + rs)));
      } else {
        rsiArr.push(null);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiArr.push(round(100 - 100 / (1 + rs)));
    }
  }

  return rsiArr;
}

// ---- MACD ----
function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const dif = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return round(emaFast[i] - emaSlow[i]);
  });

  // Signal line = EMA of DIF
  const difValues = dif.map(v => v === null ? 0 : v);
  const firstValid = dif.findIndex(v => v !== null);
  const signalLine = new Array(closes.length).fill(null);
  if (firstValid >= 0 && firstValid < closes.length) {
    const validDif = difValues.slice(firstValid);
    const sig = EMA(validDif, signal);
    for (let i = 0; i < sig.length; i++) {
      signalLine[firstValid + i] = sig[i];
    }
  }

  const histogram = dif.map((d, i) => {
    if (d === null || signalLine[i] === null) return null;
    return round(d - signalLine[i]);
  });

  return { dif, signal: signalLine, histogram };
}

// ---- Bollinger Bands ----
function Bollinger(closes, period = 20, mult = 2) {
  const middle = SMA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += Math.pow(closes[i - j] - middle[i], 2);
    }
    const std = Math.sqrt(sum / period);
    upper[i] = round(middle[i] + mult * std);
    lower[i] = round(middle[i] - mult * std);
  }

  return { upper, middle, lower };
}

// ---- KDJ (Stochastic Oscillator) ----
function KDJ(highs, lows, closes, period = 9) {
  let k = 50, d = 50;
  const kArr = [], dArr = [], jArr = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      kArr.push(null);
      dArr.push(null);
      jArr.push(null);
      continue;
    }

    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, highs[i - j]);
      ll = Math.min(ll, lows[i - j]);
    }

    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    const j = 3 * k - 2 * d;

    kArr.push(round(k));
    dArr.push(round(d));
    jArr.push(round(j));
  }

  return { k: kArr, d: dArr, j: jArr };
}

// ---- Support & Resistance ----
function findSupportResistance(history, lookback = 60) {
  const recent = history.slice(-lookback);
  if (recent.length === 0) return { supports: [], resistances: [] };

  const supports = [];
  const resistances = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
        recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low) {
      supports.push(recent[i].low);
    }
    if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
        recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high) {
      resistances.push(recent[i].high);
    }
  }

  const currentPrice = recent[recent.length - 1].close;
  // 相近价位聚类（阈值1%）：同一区域被多次触及的摆动点合并为一个支撑/阻力位，
  // 代表值取簇内均值，避免 53.15 / 53.03 这类近重复价位逐行展示
  const nearbySupports = clusterLevels(supports.filter(s => s < currentPrice))
    .sort((a, b) => b.level - a.level).slice(0, 3);
  const nearbyResistances = clusterLevels(resistances.filter(r => r > currentPrice))
    .sort((a, b) => a.level - b.level).slice(0, 3);

  return {
    supports: nearbySupports.length > 0 ? nearbySupports.map(c => c.level) : [Math.min(...recent.map(d => d.low))],
    resistances: nearbyResistances.length > 0 ? nearbyResistances.map(c => c.level) : [Math.max(...recent.map(d => d.high))],
    currentPrice
  };
}

// 摆动点聚类：与簇首（anchor）价差 <1% 归入同一簇，锚定簇首防止链式漂移
function clusterLevels(levels) {
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(v - last.anchor) / last.anchor < 0.01) {
      last.values.push(v);
      last.sum += v;
    } else {
      clusters.push({ anchor: v, values: [v], sum: v });
    }
  }
  return clusters.map(c => ({ level: round(c.sum / c.values.length, 2), touches: c.values.length }));
}

// ---- Volume Analysis ----
function analyzeVolume(history) {
  const recent = history.slice(-20);
  if (recent.length === 0) return { trend: 'unknown', ratio: 0 };

  const avgVolume = recent.slice(0, -1).reduce((s, d) => s + d.volume, 0) / (recent.length - 1);
  const lastVolume = recent[recent.length - 1].volume;
  const ratio = avgVolume > 0 ? lastVolume / avgVolume : 0;

  let trend = 'normal';
  if (ratio > 2) trend = '放量';
  else if (ratio > 1.5) trend = '温和放量';
  else if (ratio < 0.5) trend = '缩量';

  return { trend, ratio: round(ratio, 2), avgVolume: Math.round(avgVolume) };
}

// ---- Technical Analysis Summary ----
function technicalAnalysis(history) {
  if (!history || history.length < 30) {
    return { error: 'Insufficient data for technical analysis' };
  }

  const closes = history.map(d => d.close);
  const highs = history.map(d => d.high);
  const lows = history.map(d => d.low);
  const volumes = history.map(d => d.volume);

  const lastIdx = closes.length - 1;
  const lastClose = closes[lastIdx];

  // Moving averages
  const ma5 = SMA(closes, 5);
  const ma10 = SMA(closes, 10);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);
  const ma120 = SMA(closes, Math.min(120, closes.length));

  // RSI
  const rsi = RSI(closes, 14);
  const lastRsi = rsi[lastIdx];

  // MACD
  const macd = MACD(closes);
  const lastMacd = {
    dif: macd.dif[lastIdx],
    signal: macd.signal[lastIdx],
    histogram: macd.histogram[lastIdx]
  };

  // Bollinger
  const boll = Bollinger(closes, 20, 2);

  // KDJ
  const kdj = KDJ(highs, lows, closes, 9);
  const lastKdj = {
    k: kdj.k[lastIdx],
    d: kdj.d[lastIdx],
    j: kdj.j[lastIdx]
  };

  // Support/Resistance
  const sr = findSupportResistance(history);

  // Volume analysis
  const volAnalysis = analyzeVolume(history);

  // Trend determination
  let trend = '震荡';
  let trendScore = 0;

  if (ma5[lastIdx] !== null && ma20[lastIdx] !== null) {
    if (lastClose > ma5[lastIdx] && ma5[lastIdx] > ma20[lastIdx]) {
      trend = '上升趋势';
      trendScore += 2;
    } else if (lastClose < ma5[lastIdx] && ma5[lastIdx] < ma20[lastIdx]) {
      trend = '下降趋势';
      trendScore -= 2;
    }
  }

  // RSI signals
  let rsiSignal = '中性';
  if (lastRsi !== null) {
    if (lastRsi > 70) { rsiSignal = '超买'; trendScore -= 1; }
    else if (lastRsi < 30) { rsiSignal = '超卖'; trendScore += 1; }
    else if (lastRsi > 50) { rsiSignal = '偏强'; trendScore += 0.5; }
    else { rsiSignal = '偏弱'; trendScore -= 0.5; }
  }

  // MACD signals
  let macdSignal = '中性';
  if (lastMacd.dif !== null && lastMacd.signal !== null) {
    if (lastMacd.dif > lastMacd.signal && lastMacd.histogram > 0) {
      macdSignal = '多头'; trendScore += 1;
    } else if (lastMacd.dif < lastMacd.signal && lastMacd.histogram < 0) {
      macdSignal = '空头'; trendScore -= 1;
    }
    // Cross detection
    if (lastIdx > 0 && macd.dif[lastIdx - 1] !== null && macd.signal[lastIdx - 1] !== null) {
      if (macd.dif[lastIdx - 1] < macd.signal[lastIdx - 1] && lastMacd.dif > lastMacd.signal) {
        macdSignal = '金叉'; trendScore += 1.5;
      } else if (macd.dif[lastIdx - 1] > macd.signal[lastIdx - 1] && lastMacd.dif < lastMacd.signal) {
        macdSignal = '死叉'; trendScore -= 1.5;
      }
    }
  }

  // KDJ signals
  let kdjSignal = '中性';
  if (lastKdj.k !== null && lastKdj.d !== null) {
    if (lastKdj.j > 100 || lastKdj.k > 80) { kdjSignal = '超买'; trendScore -= 0.5; }
    else if (lastKdj.j < 0 || lastKdj.k < 20) { kdjSignal = '超卖'; trendScore += 0.5; }
    if (lastKdj.k > lastKdj.d) { kdjSignal = kdjSignal === '中性' ? '偏多' : kdjSignal; trendScore += 0.5; }
    else { kdjSignal = kdjSignal === '中性' ? '偏空' : kdjSignal; trendScore -= 0.5; }
  }

  // Bollinger position
  let bollPosition = '中轨';
  if (boll.upper[lastIdx] !== null && boll.lower[lastIdx] !== null) {
    const range = boll.upper[lastIdx] - boll.lower[lastIdx];
    if (range > 0) {
      const pos = (lastClose - boll.lower[lastIdx]) / range;
      if (pos > 0.8) bollPosition = '上轨附近';
      else if (pos > 0.5) bollPosition = '中上轨';
      else if (pos > 0.2) bollPosition = '中下轨';
      else bollPosition = '下轨附近';
    }
  }

  // Overall technical score
  let techScore = '中性';
  if (trendScore >= 3) techScore = '强烈看多';
  else if (trendScore >= 1.5) techScore = '偏多';
  else if (trendScore <= -3) techScore = '强烈看空';
  else if (trendScore <= -1.5) techScore = '偏空';

  return {
    indicators: {
      ma5: ma5[lastIdx],
      ma10: ma10[lastIdx],
      ma20: ma20[lastIdx],
      ma60: ma60[lastIdx],
      ma120: ma120[lastIdx],
      rsi: lastRsi,
      macd: lastMacd,
      boll: { upper: boll.upper[lastIdx], middle: boll.middle[lastIdx], lower: boll.lower[lastIdx] },
      kdj: lastKdj,
    },
    series: {
      ma5, ma10, ma20, ma60, ma120,
      rsi,
      macdDif: macd.dif,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      bollUpper: boll.upper,
      bollMiddle: boll.middle,
      bollLower: boll.lower,
      kdjK: kdj.k,
      kdjD: kdj.d,
      kdjJ: kdj.j,
    },
    signals: {
      trend,
      rsiSignal,
      macdSignal,
      kdjSignal,
      bollPosition,
      volumeTrend: volAnalysis.trend,
      volumeRatio: volAnalysis.ratio,
    },
    supportResistance: sr,
    techScore,
    trendScore: round(trendScore, 1),
  };
}

// ---- Fundamental Analysis (with company type differentiation) ----
function fundamentalAnalysis(quote, companyType) {
  const f = quote.fundamentals || {};
  // 金融业（银行/保险/证券等）高负债是经营常态，健康评分中不应因高「资债比」被扣分
  const isFinancial = !!(companyType && companyType.isFinancial);
  const isPct = !!(f.debtMetricPct); // A股取资产负债率%（>3 量级），港股/美股取带息债÷权益比值
  const result = {
    metrics: {},
    scores: {},
    overall: '未知',
    score: 0,
    rating: '',
    description: '',
    companyType: companyType?.type || 'balanced',
    companyTypeName: companyType?.typeName || '均衡型',
  };

  // Scoring weights based on company type
  const weights = companyType?.weights || { valuation: 25, profitability: 25, growth: 25, health: 25 };
  const ct = companyType?.type || 'balanced';

  let score = 0;
  const maxScore = 100;

  // Valuation (base: 25 points, then rescaled)
  const pe = f.pe || f.peTtm || 0;
  const pb = f.pb || 0;
  result.metrics.pe = pe;
  result.metrics.pb = pb;
  result.metrics.ps = f.ps || 0;
  result.metrics.peg = f.peg || 0;
  persistPeg(quote && (quote.symbol || quote.code), result.metrics.peg, f.pegSource);
  result.metrics.evEbitda = f.evEbitda || 0;

  let valScore = 0;
  let valRule = '';
  if (ct === 'growth') {
    // Growth: focus on PS, less on PE
    const ps = f.ps || 0;
    if (ps > 0 && ps < 3) { valScore = 25; valRule = `市销率 PS=${ps.toFixed(1)} 处于低位(<3)，估值吸引力强`; }
    else if (ps >= 3 && ps < 8) { valScore = 18; valRule = `PS=${ps.toFixed(1)} 属合理区间(3~8)`; }
    else if (ps >= 8 && ps < 15) { valScore = 10; valRule = `PS=${ps.toFixed(1)} 偏高(8~15)`; }
    else if (ps >= 15 && ps < 30) { valScore = 5; valRule = `PS=${ps.toFixed(1)} 过高(15~30)`; }
    else if (pe > 0 && pe < 30) { valScore = 15; valRule = `PS 缺失，按 PE=${pe.toFixed(1)}<30 兜底`; }
    else { valScore = 8; valRule = `PS 与 PE 均偏高或缺失`; }
  } else if (ct === 'value') {
    // Value: focus on PE
    if (pe > 0 && pe < 10) { valScore = 25; valRule = `PE=${pe.toFixed(1)} 极低(<10)，价值凸显`; }
    else if (pe >= 10 && pe < 15) { valScore = 22; valRule = `PE=${pe.toFixed(1)} 偏低(10~15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 18; valRule = `PE=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25 && pe < 40) { valScore = 8; valRule = `PE=${pe.toFixed(1)} 偏高(25~40)`; }
    else if (pe >= 40) { valScore = 4; valRule = `PE=${pe.toFixed(1)} 过高(≥40)`; }
    else { valScore = 8; valRule = `PE 为负或缺失`; }
  } else if (ct === 'dividend') {
    // Dividend: PE moderate, PB matters
    if (pe > 0 && pe < 8) { valScore = 25; valRule = `PE=${pe.toFixed(1)} 极低(<8)，高股息蓝筹`; }
    else if (pe >= 8 && pe < 15) { valScore = 20; valRule = `PE=${pe.toFixed(1)} 偏低(8~15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 15; valRule = `PE=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25) { valScore = 8; valRule = `PE=${pe.toFixed(1)} 偏高(≥25)`; }
    else { valScore = 10; valRule = `PE 为负或缺失`; }
    if (pb > 0 && pb < 0.8) { valScore = Math.min(25, valScore + 5); valRule += '；PB 破净(<0.8) 额外+5'; }
    else if (pb > 0 && pb < 1.2) { valScore = Math.min(25, valScore + 3); valRule += '；PB 偏低(<1.2) 额外+3'; }
  } else {
    // Balanced: original logic
    if (pe > 0 && pe < 15) { valScore = 25; valRule = `PE=${pe.toFixed(1)} 低(<15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 18; valRule = `PE=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25 && pe < 40) { valScore = 10; valRule = `PE=${pe.toFixed(1)} 偏高(25~40)`; }
    else if (pe >= 40 && pe < 60) { valScore = 5; valRule = `PE=${pe.toFixed(1)} 过高(40~60)`; }
    else if (pe <= 0) { valScore = 8; valRule = `PE 为负或缺失`; }
  }
  // Rescale to actual weight
  const valActual = Math.round(valScore / 25 * weights.valuation);
  score += valActual;
  result.scores.valuation = { score: valActual, max: weights.valuation, label: '估值' };
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.valuation = {
    label: '估值', score: valActual, max: weights.valuation,
    metrics: [['市盈率 PE', pe ? pe.toFixed(1) + ' 倍' : '—'], ['市净率 PB', pb ? pb.toFixed(1) + ' 倍' : '—'], ['市销率 PS', f.ps ? f.ps.toFixed(1) : '—']],
    rule: valRule || '—',
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」估值权重 ${weights.valuation} 分；依据 PE/PB/PS 落入对应区间判定，得 ${valActual}/${weights.valuation} 分。`
  };

  // Profitability (base: 25 points, then rescaled)
  let profScore = 0;
  const roe = f.roe || f.returnOnEquity || 0;
  const grossMargin = f.grossMargin || f.grossMargins || 0;
  const netMargin = f.netMargin || f.profitMargins || 0;
  result.metrics.roe = typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  result.metrics.grossMargin = typeof grossMargin === 'number' && grossMargin < 1 ? grossMargin * 100 : grossMargin;
  result.metrics.netMargin = typeof netMargin === 'number' && netMargin < 1 ? netMargin * 100 : netMargin;
  result.metrics.roa = f.returnOnAssets || 0;

  if (ct === 'dividend') {
    // Dividend: ROE stability is key
    if (result.metrics.roe > 15) profScore += 14;
    else if (result.metrics.roe > 10) profScore += 10;
    else if (result.metrics.roe > 5) profScore += 6;
    else profScore += 2;
  } else {
    if (result.metrics.roe > 20) profScore += 12;
    else if (result.metrics.roe > 15) profScore += 9;
    else if (result.metrics.roe > 10) profScore += 6;
    else if (result.metrics.roe > 5) profScore += 3;
  }

  if (result.metrics.netMargin > 25) profScore += 8;
  else if (result.metrics.netMargin > 15) profScore += 6;
  else if (result.metrics.netMargin > 8) profScore += 4;
  else if (result.metrics.netMargin > 0) profScore += 2;

  if (result.metrics.grossMargin > 50) profScore += 5;
  else if (result.metrics.grossMargin > 30) profScore += 3;
  else if (result.metrics.grossMargin > 15) profScore += 1;

  const profActual = Math.round(Math.min(profScore, 25) / 25 * weights.profitability);
  score += profActual;
  result.scores.profitability = { score: profActual, max: weights.profitability, label: '盈利能力' };
  const _roe = result.metrics.roe, _nm = result.metrics.netMargin, _gm = result.metrics.grossMargin;
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.profitability = {
    label: '盈利能力', score: profActual, max: weights.profitability,
    metrics: [['ROE', _roe ? _roe.toFixed(1) + '%' : '—'], ['净利率', _nm ? _nm.toFixed(1) + '%' : '—'], ['毛利率', _gm ? _gm.toFixed(1) + '%' : '—']],
    rule: `ROE ${_roe ? _roe.toFixed(1) : '—'}%、净利率 ${_nm ? _nm.toFixed(1) : '—'}%、毛利率 ${_gm ? _gm.toFixed(1) : '—'}${ct === 'dividend' ? '（红利型更看重 ROE 稳定性）' : ''}，综合分档累加得 ${profActual}/${weights.profitability} 分`,
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」盈利能力权重 ${weights.profitability} 分；综合 ROE/净利率/毛利率分档累加，得 ${profActual}/${weights.profitability} 分。`
  };

  // Growth (base: 25 points, then rescaled)
  let growthScore = 0;
  let growthRule = '';
  const revGrowth = f.revenueYoy || f.revenueGrowth || 0;
  const profitGrowth = f.profitYoy || f.earningsGrowth || 0;
  result.metrics.revenueGrowth = typeof revGrowth === 'number' && Math.abs(revGrowth) < 1 ? revGrowth * 100 : revGrowth;
  result.metrics.profitGrowth = typeof profitGrowth === 'number' && Math.abs(profitGrowth) < 1 ? profitGrowth * 100 : profitGrowth;
  const rg = result.metrics.revenueGrowth, pg = result.metrics.profitGrowth;

  if (ct === 'growth') {
    // Growth: revenue growth is the most important metric
    if (rg > 50) { growthScore += 15; growthRule = `营收增速 ${rg.toFixed(1)}% (>50) +15`; }
    else if (rg > 30) { growthScore += 12; growthRule = `营收增速 ${rg.toFixed(1)}% (30~50) +12`; }
    else if (rg > 20) { growthScore += 9; growthRule = `营收增速 ${rg.toFixed(1)}% (20~30) +9`; }
    else if (rg > 10) { growthScore += 5; growthRule = `营收增速 ${rg.toFixed(1)}% (10~20) +5`; }
    else if (rg > 0) { growthScore += 2; growthRule = `营收增速 ${rg.toFixed(1)}% (0~10) +2`; }
    else { growthRule = `营收增速 ${rg.toFixed(1)}% (≤0，无增长加分)`; }

    if (pg > 50) { growthScore += 10; growthRule += `；净利增速 ${pg.toFixed(1)}% (>50) +10`; }
    else if (pg > 30) { growthScore += 8; growthRule += `；净利增速 ${pg.toFixed(1)}% (30~50) +8`; }
    else if (pg > 15) { growthScore += 5; growthRule += `；净利增速 ${pg.toFixed(1)}% (15~30) +5`; }
    else if (pg > 0) { growthScore += 3; growthRule += `；净利增速 ${pg.toFixed(1)}% (0~15) +3`; }
    else { growthRule += `；净利增速 ${pg.toFixed(1)}% (≤0)`; }
  } else {
    if (rg > 30) { growthScore += 12; growthRule = `营收增速 ${rg.toFixed(1)}% (>30) +12`; }
    else if (rg > 15) { growthScore += 9; growthRule = `营收增速 ${rg.toFixed(1)}% (15~30) +9`; }
    else if (rg > 5) { growthScore += 6; growthRule = `营收增速 ${rg.toFixed(1)}% (5~15) +6`; }
    else if (rg > 0) { growthScore += 3; growthRule = `营收增速 ${rg.toFixed(1)}% (0~5) +3`; }
    else { growthRule = `营收增速 ${rg.toFixed(1)}% (≤0，无增长加分)`; }

    if (pg > 30) { growthScore += 13; growthRule += `；净利增速 ${pg.toFixed(1)}% (>30) +13`; }
    else if (pg > 15) { growthScore += 10; growthRule += `；净利增速 ${pg.toFixed(1)}% (15~30) +10`; }
    else if (pg > 5) { growthScore += 6; growthRule += `；净利增速 ${pg.toFixed(1)}% (5~15) +6`; }
    else if (pg > 0) { growthScore += 3; growthRule += `；净利增速 ${pg.toFixed(1)}% (0~5) +3`; }
    else { growthRule += `；净利增速 ${pg.toFixed(1)}% (≤0)`; }
  }

  const growthActual = Math.round(Math.min(growthScore, 25) / 25 * weights.growth);
  score += growthActual;
  result.scores.growth = { score: growthActual, max: weights.growth, label: '成长性' };
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.growth = {
    label: '成长性', score: growthActual, max: weights.growth,
    metrics: [['营收增速', (rg != null ? rg.toFixed(1) : '—') + '%'], ['净利增速', (pg != null ? pg.toFixed(1) : '—') + '%']],
    rule: growthRule || '—',
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」成长性权重 ${weights.growth} 分；营收与净利增速落入对应档位累加，得 ${growthActual}/${weights.growth} 分。`
  };

  // Financial health (base: 25 points, then rescaled)
  let healthScore = 0;
  const debtToEquity = f.debtToEquity || 0;
  const currentRatio = f.currentRatio || 0;
  result.metrics.debtToEquity = debtToEquity;
  result.metrics.debtMetricPct = isPct;
  result.metrics.currentRatio = currentRatio;
  result.metrics.quickRatio = f.quickRatio || 0;
  result.metrics.operatingCashFlowPerShare = f.operatingCashFlowPerShare || 0;

  if (ct === 'dividend') {
    // Dividend: financial health and dividend sustainability are key
    if (isFinancial) {
      // 金融业资产负债率天然高（A 股上市银行/保险约 85%-96% 为正常区间），不因其高杠杆扣分
      if (debtToEquity >= 80 && debtToEquity <= 96) healthScore += 10;
      else if (debtToEquity > 96) healthScore += 6;
      else healthScore += 8;
    } else if (isPct) {
      // A股口径：资产负债率%（40% 以下稳健，70% 以上偏高）
      if (debtToEquity > 0 && debtToEquity < 40) healthScore += 12;
      else if (debtToEquity >= 40 && debtToEquity <= 70) healthScore += 9;
      else if (debtToEquity > 70 && debtToEquity <= 90) healthScore += 5;
      else if (debtToEquity === 0) healthScore += 10;
      // >90% 高杠杆风险，不加分
    } else if (debtToEquity > 0 && debtToEquity < 0.5) healthScore += 12;
    else if (debtToEquity >= 0.5 && debtToEquity < 1) healthScore += 9;
    else if (debtToEquity >= 1 && debtToEquity < 2) healthScore += 5;
    else if (debtToEquity === 0) healthScore += 10;

    if (currentRatio > 2) healthScore += 6;
    else if (currentRatio > 1.5) healthScore += 5;
    else if (currentRatio > 1) healthScore += 3;

    // Dividend yield is critical for dividend stocks
    const divYield = f.dividendYield || 0;
    result.metrics.dividendYield = typeof divYield === 'number' && divYield < 1 && !f.dividendYieldIsPct ? divYield * 100 : divYield;
    if (result.metrics.dividendYield > 5) healthScore += 7;
    else if (result.metrics.dividendYield > 3) healthScore += 5;
    else if (result.metrics.dividendYield > 1) healthScore += 2;
  } else {
    if (isFinancial) {
      // 金融业资产负债率天然高（A 股上市银行/保险约 85%-96% 为正常区间），不因其高杠杆扣分
      if (debtToEquity >= 80 && debtToEquity <= 96) healthScore += 10;
      else if (debtToEquity > 96) healthScore += 6;
      else healthScore += 8;
    } else if (isPct) {
      // A股口径：资产负债率%（40% 以下稳健，70% 以上偏高）
      if (debtToEquity > 0 && debtToEquity < 40) healthScore += 12;
      else if (debtToEquity >= 40 && debtToEquity <= 70) healthScore += 9;
      else if (debtToEquity > 70 && debtToEquity <= 90) healthScore += 5;
      else if (debtToEquity === 0) healthScore += 10;
      // >90% 高杠杆风险，不加分
    } else if (debtToEquity > 0 && debtToEquity < 0.5) healthScore += 12;
    else if (debtToEquity >= 0.5 && debtToEquity < 1) healthScore += 9;
    else if (debtToEquity >= 1 && debtToEquity < 2) healthScore += 5;
    else if (debtToEquity === 0) healthScore += 10;

    if (currentRatio > 2) healthScore += 8;
    else if (currentRatio > 1.5) healthScore += 6;
    else if (currentRatio > 1) healthScore += 4;
    else if (currentRatio > 0.5) healthScore += 2;

    const divYield = f.dividendYield || 0;
    result.metrics.dividendYield = typeof divYield === 'number' && divYield < 1 && !f.dividendYieldIsPct ? divYield * 100 : divYield;
    if (result.metrics.dividendYield > 0) healthScore += Math.min(5, result.metrics.dividendYield);
  }

  const healthActual = Math.round(Math.min(healthScore, 25) / 25 * weights.health);
  score += healthActual;
  result.scores.health = { score: healthActual, max: weights.health, label: '财务健康' };
  const _d2e = result.metrics.debtToEquity, _cr = result.metrics.currentRatio, _dy = result.metrics.dividendYield, _isPct = result.metrics.debtMetricPct;
  const _d2eTxt = _d2e != null ? (_isPct ? _d2e.toFixed(2) + '%' : _d2e.toFixed(2)) : '—';
  const _d2eLabel = _isPct ? '资产负债率' : '带息债/权益';
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.health = {
    label: '财务健康', score: healthActual, max: weights.health,
    metrics: [[_d2eLabel, _d2eTxt], ['流动比率', _cr != null ? _cr.toFixed(2) : '—'], ['股息率', _dy != null ? _dy.toFixed(1) + '%' : '—']],
    rule: `${_d2eLabel} ${_d2eTxt}、流动比率 ${_cr != null ? _cr.toFixed(2) : '—'}${ct === 'dividend' ? `、股息率 ${_dy != null ? _dy.toFixed(1) : '—'}%（红利型看重分红持续性）` : ''}，综合分档累加得 ${healthActual}/${weights.health} 分`,
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」财务健康权重 ${weights.health} 分；综合偿债能力/流动性${ct === 'dividend' ? '/股息率' : ''}分档累加，得 ${healthActual}/${weights.health} 分。`
  };

  result.score = Math.round(score);

  if (score >= 80) { result.overall = '优秀'; result.rating = 'A+'; }
  else if (score >= 65) { result.overall = '良好'; result.rating = 'A'; }
  else if (score >= 50) { result.overall = '一般'; result.rating = 'B'; }
  else if (score >= 35) { result.overall = '较弱'; result.rating = 'C'; }
  else { result.overall = '较差'; result.rating = 'D'; }

  // Analyst targets
  if (f.targetMeanPrice) {
    result.analystTarget = {
      mean: f.targetMeanPrice,
      high: f.targetHighPrice || 0,
      low: f.targetLowPrice || 0,
      median: f.targetMedianPrice || 0,
      recommendation: f.recommendationKey || '',
      recommendationScore: f.recommendationMean || 0,
      analystCount: f.numberOfAnalystOpinions || 0
    };
  }

  // Description
  const parts = [];
  if (result.metrics.pe > 0) parts.push(`市盈率${result.metrics.pe.toFixed(1)}倍`);
  if (result.metrics.pb > 0) parts.push(`市净率${result.metrics.pb.toFixed(1)}倍`);
  if (result.metrics.roe > 0) parts.push(`ROE ${result.metrics.roe.toFixed(1)}%`);
  if (result.metrics.netMargin > 0) parts.push(`净利率${result.metrics.netMargin.toFixed(1)}%`);
  result.description = parts.join('，');

  return result;
}

// ---- Signal evaluation (利好 / 利空 提醒) ----
// 依据估值、盈利、成长、分红、负债等指标的多空方向，给出对股价的利好(红)/利空(绿)标记。
// industryAvg 可选：{ pe, pb } 为行业均值（缺失时用分类基准估算）。
function evaluateSignals(fundamentals, companyType, industryAvg) {
  const f = fundamentals || {};
  const ct = (companyType && companyType.type) || 'balanced';
  // 金融业（银行/保险/证券/信托/基金等）高负债是经营常态，不视为利空
  const isFinancial = !!(companyType && companyType.isFinancial);
  // 行业均值（缺失时用分类基准估算）
  const bench = {
    growth: { pe: 40, pb: 4, ps: 8 }, value: { pe: 12, pb: 1.2, ps: 1.5 },
    dividend: { pe: 10, pb: 1.0, ps: 1.5 }, balanced: { pe: 25, pb: 2.5, ps: 4 }
  }[ct] || { pe: 25, pb: 2.5, ps: 4 };
  const peAvg = (industryAvg && industryAvg.pe) ? industryAvg.pe : bench.pe;
  const pbAvg = (industryAvg && industryAvg.pb) ? industryAvg.pb : bench.pb;

  const signals = [];
  const pe = f.pe || f.peTtm || 0;
  const pb = f.pb || 0;

  if (pe > 0) {
    if (pe < peAvg * 0.8) signals.push({ key: 'pe', label: '市盈率 PE', value: pe.toFixed(1) + ' 倍', signal: 'bull', reason: `PE ${pe.toFixed(1)} 低于行业均值 ${peAvg.toFixed(2)}（约 ${(pe / peAvg * 100).toFixed(0)}%），估值偏低，利好` });
    else if (pe > peAvg * 1.2) signals.push({ key: 'pe', label: '市盈率 PE', value: pe.toFixed(1) + ' 倍', signal: 'bear', reason: `PE ${pe.toFixed(1)} 高于行业均值 ${peAvg.toFixed(2)}（约 ${(pe / peAvg * 100).toFixed(0)}%），估值偏贵，利空` });
    else signals.push({ key: 'pe', label: '市盈率 PE', value: pe.toFixed(1) + ' 倍', signal: 'neutral', reason: `PE ${pe.toFixed(1)} 接近行业均值 ${peAvg.toFixed(2)}` });
  }
  if (pb > 0) {
    if (pb < pbAvg * 0.8) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bull', reason: `PB ${pb.toFixed(1)} 低于行业均值 ${pbAvg.toFixed(2)}，破净/低估，利好` });
    else if (pb > pbAvg * 1.2) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bear', reason: `PB ${pb.toFixed(1)} 高于行业均值 ${pbAvg.toFixed(2)}，利空` });
    else signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'neutral', reason: `PB ${pb.toFixed(1)} 接近行业均值 ${pbAvg.toFixed(2)}` });
  }

  // 市销率 PS：优先用历史百分位（数据可靠，不依赖行业均值），无历史序列则不误判
  const ps = f.ps || 0;
  const psSeries = (f.valuationHistory || []).map(d => d.ps).filter(v => v > 0);
  const psPct = psSeries.length >= 2 ? percentileRank(psSeries, ps) : null;
  if (ps > 0 && psPct != null) {
    if (psPct >= 80) signals.push({ key: 'ps', label: '市销率 PS', value: ps.toFixed(1) + ' 倍', signal: 'bear', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位（偏高），估值偏贵，利空` });
    else if (psPct <= 20) signals.push({ key: 'ps', label: '市销率 PS', value: ps.toFixed(1) + ' 倍', signal: 'bull', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位（偏低），估值偏低，利好` });
    else signals.push({ key: 'ps', label: '市销率 PS', value: ps.toFixed(1) + ' 倍', signal: 'neutral', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位` });
  }

  // === 营收增速：必须用「边际趋势」判断（同比加速/放缓），不能只看当期绝对值 ===
  // 数据源：东财 ZYZBAjaxNew 多期财务指标（zyzbHistory.TOTALOPERATEREVETZ = 营收同比 %），与 buildFundamentalComparison / ROE 走势同源
  const revSeries = (f.zyzbHistory || []).map(d => toNum(d.TOTALOPERATEREVETZ)).filter(v => v !== null);
  const rgRaw = f.revenueYoy || f.revenueGrowth || 0;
  const rg = Math.abs(rgRaw) < 1 ? rgRaw * 100 : rgRaw;
  const rgPrior = revSeries.length >= 2 ? revSeries[revSeries.length - 2] : null;
  if (revSeries.length >= 2 && rgPrior !== null) {
    if (rg < 0) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收同比 ${rg.toFixed(1)}% 为负增长，利空` });
    else {
      const dpp = rg - rgPrior; // 边际变化（百分点）
      if (dpp > 0.5) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bull', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），同比加速 +${dpp.toFixed(1)}pp，成长动能增强，利好` });
      else if (dpp < -0.5) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），边际放缓 ${dpp.toFixed(1)}pp，成长动能减弱，利空` });
      else signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'neutral', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），基本持平，动能平稳` });
    }
  } else {
    // 无历史可比序列时退化为绝对阈值（保留原逻辑，避免无结论）
    if (rg > 15) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bull', reason: `营收增速 ${rg.toFixed(1)}% 较高，成长性强，利好` });
    else if (rg < 0) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收负增长 ${rg.toFixed(1)}%，利空` });
    else if (rg === 0) signals.push({ key: 'growth', label: '营收增速', value: '0%', signal: 'bear', reason: `营收零增长，成长乏力，利空` });
  }

  // === ROE：① 绝对分档（金融业/一般企业）；② 必须叠加「行业均值」相对判断，低于行业则给出利空结论 ===
  const roeRaw = f.roe || 0;
  const roe = Math.abs(roeRaw) < 1 ? roeRaw * 100 : roeRaw;
  const indRoe = (industryAvg && typeof industryAvg.roe === 'number' && industryAvg.roe > 0) ? industryAvg.roe : null;
  const roeTier = (r) => {
    if (isFinancial) return r >= 12 ? 'bull' : r >= 8 ? 'neutral' : 'bear';
    return r >= 15 ? 'bull' : r >= 10 ? 'neutral' : r >= 5 ? 'neutral' : 'bear';
  };
  if (roe > 0) {
    let tier = roeTier(roe);
    // 行业相对修正：低于行业均值 → 至少利空；略低于 → 至多中性（不盲目判利好）
    if (indRoe != null) {
      if (roe < indRoe * 0.9) tier = 'bear';
      else if (roe < indRoe && tier === 'bull') tier = 'neutral';
    }
    const indTxt = indRoe != null ? `（行业均值 ROE ${indRoe.toFixed(1)}%）` : '';
    const relTxt = indRoe != null
      ? (roe >= indRoe * 1.1 ? '，显著优于行业均值' : roe >= indRoe ? '，略优于行业均值' : roe >= indRoe * 0.9 ? '，略低于行业均值' : '，显著低于行业均值')
      : '';
    const base = {
      bull: `ROE ${roe.toFixed(1)}% 优秀，盈利能力强，利好`,
      neutral: `ROE ${roe.toFixed(1)}% 良好，盈利能力稳健`,
      bear: `ROE ${roe.toFixed(1)}% 偏弱，盈利能力弱，利空`,
    }[tier];
    signals.push({ key: 'roe', label: 'ROE', value: roe.toFixed(1) + '%', signal: tier, reason: base + indTxt + relTxt });
  } else if (roe <= 0) signals.push({ key: 'roe', label: 'ROE', value: roe.toFixed(1) + '%', signal: 'bear', reason: `ROE 非正，盈利能力弱，利空` });

  // === 股息率：用「每股股息同比高低变化」判断（分红加码=利好，缩减=利空）===
  // 股息率 = 每股股息 / 股价，历史股价不可得，故以「每股股息同比」衡量分红力度的高低变化（同源：东财分红接口）
  const dyRaw = f.dividendYield || 0;
  const dy = Math.abs(dyRaw) < 1 ? dyRaw * 100 : dyRaw;
  const dyYoy = (typeof f.dividendYoyPct === 'number') ? f.dividendYoyPct : null;
  if (dyYoy != null) {
    if (dyYoy > 0) signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'bull', reason: `每股股息同比 +${dyYoy.toFixed(1)}%（分红加码），股息率走高，红利属性增强，利好` });
    else if (dyYoy < 0) signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'bear', reason: `每股股息同比 ${dyYoy.toFixed(1)}%（分红缩减），股息率走低，红利属性减弱，利空` });
    else signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'neutral', reason: `每股股息同比持平，分红力度稳定` });
  } else if (dy >= 3) signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'bull', reason: `股息率 ${dy.toFixed(1)}% 较高，红利属性强，利好` });
  else if (ct === 'dividend' && dy > 0 && dy < 1) signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'bear', reason: `股息率仅 ${dy.toFixed(1)}%，红利吸引力弱，利空` });
  else if (dy > 0) signals.push({ key: 'div', label: '股息率', value: dy.toFixed(1) + '%', signal: 'neutral', reason: `股息率 ${dy.toFixed(1)}% 处于常规区间` });

  // PEG（<1 成长性估值偏低利好，>2 透支利空）
  const peg = f.peg || 0;
  if (peg > 0) {
    if (peg < 1) signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'bull', reason: `PEG ${peg.toFixed(2)} < 1，成长性估值合理/偏低，利好` });
    else if (peg > 2) signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'bear', reason: `PEG ${peg.toFixed(2)} > 2，成长性透支，利空` });
    else signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'neutral', reason: `PEG ${peg.toFixed(2)} 处于 1~2 合理区间` });
  }

  // 毛利率（>30% 盈利质量强，<15% 弱）
  const gm = f.grossMargin || 0;
  if (gm > 0) {
    if (gm >= 30) signals.push({ key: 'grossMargin', label: '毛利率', value: gm.toFixed(1) + '%', signal: 'bull', reason: `毛利率 ${gm.toFixed(1)}% 较高，产品竞争力强，利好` });
    else if (gm < 15) signals.push({ key: 'grossMargin', label: '毛利率', value: gm.toFixed(1) + '%', signal: 'bear', reason: `毛利率 ${gm.toFixed(1)}% 偏低，盈利空间有限，利空` });
    else signals.push({ key: 'grossMargin', label: '毛利率', value: gm.toFixed(1) + '%', signal: 'neutral', reason: `毛利率 ${gm.toFixed(1)}% 处于行业常规区间` });
  }

  // 净利率（>20% 强，<5% 弱）
  const nm = f.netMargin || 0;
  if (nm > 0) {
    if (nm >= 20) signals.push({ key: 'netMargin', label: '净利率', value: nm.toFixed(1) + '%', signal: 'bull', reason: `净利率 ${nm.toFixed(1)}% 较高，盈利质量好，利好` });
    else if (nm < 5) signals.push({ key: 'netMargin', label: '净利率', value: nm.toFixed(1) + '%', signal: 'bear', reason: `净利率 ${nm.toFixed(1)}% 偏低，盈利能力弱，利空` });
    else signals.push({ key: 'netMargin', label: '净利率', value: nm.toFixed(1) + '%', signal: 'neutral', reason: `净利率 ${nm.toFixed(1)}% 处于常规区间` });
  }

  // 利润增长（归母净利润同比）：与营收增速一致，必须用「边际趋势」判断（同源：zyzbHistory.PARENTNETPROFITTZ）
  const profitSeries = (f.zyzbHistory || []).map(d => toNum(d.PARENTNETPROFITTZ)).filter(v => v !== null);
  const pgRaw = f.profitYoy || f.earningsGrowth || f.profitGrowth || 0;
  const pg = Math.abs(pgRaw) < 1 ? pgRaw * 100 : pgRaw;
  const pgPrior = profitSeries.length >= 2 ? profitSeries[profitSeries.length - 2] : null;
  if (profitSeries.length >= 2 && pgPrior !== null) {
    if (pg < 0) signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润同比 ${pg.toFixed(1)}% 为负增长，利空` });
    else {
      const dpp = pg - pgPrior;
      if (dpp > 0.5) signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'bull', reason: `利润增速 ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），同比加速 +${dpp.toFixed(1)}pp，盈利动能增强，利好` });
      else if (dpp < -0.5) signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润增速 ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），边际放缓 ${dpp.toFixed(1)}pp，盈利动能减弱，利空` });
      else signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'neutral', reason: `利润增速 ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），基本持平，动能平稳` });
    }
  } else {
    if (pg > 15) signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'bull', reason: `利润增速 ${pg.toFixed(1)}% 较高，盈利高成长，利好` });
    else if (pg < 0) signals.push({ key: 'profitGrowth', label: '利润增长', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润负增长 ${pg.toFixed(1)}%，利空` });
    else if (pg === 0) signals.push({ key: 'profitGrowth', label: '利润增长', value: '0%', signal: 'bear', reason: `利润零增长，成长乏力，利空` });
  }

  // 流动比率（>1.5 短期偿债稳健，<1 紧张）
  const cr = f.currentRatio || 0;
  if (cr > 0) {
    if (cr >= 1.5) signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'bull', reason: `流动比率 ${cr.toFixed(2)} 较高，短期偿债能力强，利好` });
    else if (cr < 1) signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'bear', reason: `流动比率 ${cr.toFixed(2)} < 1，短期偿债压力大，利空` });
    else signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'neutral', reason: `流动比率 ${cr.toFixed(2)} 处于合理区间` });
  }

  // 每股经营现金流（为正=造血，为负=失血）
  const ocf = f.operatingCashFlowPerShare || 0;
  if (ocf > 0) signals.push({ key: 'ocf', label: '每股经营现金流', value: ocf.toFixed(2), signal: 'bull', reason: `每股经营现金流 ${ocf.toFixed(2)} 为正，造血能力强，利好` });
  else if (ocf < 0) signals.push({ key: 'ocf', label: '每股经营现金流', value: ocf.toFixed(2), signal: 'bear', reason: `每股经营现金流 ${ocf.toFixed(2)} 为负，经营失血，利空` });

  const d2e = f.debtToEquity || 0;
  const isPct = !!(f.debtMetricPct); // A股取的是资产负债率%，港股/美股取的是带息债÷权益比值
  if (isFinancial) {
    // 金融业（银行/保险等）资债比天然偏高（存贷/承保业务依赖负债），属经营常态，不判利空/利好
    signals.push({ key: 'debt', label: '资产负债率', value: isPct ? d2e.toFixed(2) + '%' : d2e.toFixed(2), signal: 'neutral', reason: `金融业${isPct ? '资产负债率 ' + d2e.toFixed(2) + '%' : '带息债/权益 ' + d2e.toFixed(2)} 属经营常态（存贷/承保业务天然依赖负债），不视为利空` });
  } else if (isPct) {
    // A股口径：数值为资产负债率（百分比）
    if (d2e > 70) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2) + '%', signal: 'bear', reason: `资产负债率 ${d2e.toFixed(2)}% 偏高（>70%），财务杠杆风险较大，利空` });
    else if (d2e > 0 && d2e < 40) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2) + '%', signal: 'bull', reason: `资产负债率 ${d2e.toFixed(2)}% 较低（<40%），财务稳健，利好` });
    // 40%~70% 为合理区间，不单独提示
  } else {
    // 港股/美股口径：带息债 ÷ 所有者权益（比值）
    if (d2e > 2) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2), signal: 'bear', reason: `带息债/权益 ${d2e.toFixed(2)} 偏高，偿债压力大，利空` });
    else if (d2e > 0 && d2e < 0.5) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2), signal: 'bull', reason: `带息债/权益 ${d2e.toFixed(2)} 很低，财务稳健，利好` });
  }

  return {
    signals,
    peAvg, pbAvg,
    compareBasis: '行业均值'
  };
}

// ---- Sentiment Analysis (basic keyword-based) ----
const positiveKeywords = [
  '利好', '增长', '盈利', '突破', '创新高', '超预期', '回购', '分红', '增持', '买入',
  '上涨', '强势', '看好', '机遇', '合作', '签约', '订单', '获批', '认证', ' award',
  '涨停', '大涨', '暴涨', '走高', '拉升', '走强', '反弹', '涨停潮', '净流入',
  '预增', '扭亏', '中标', '加仓', '回暖', '扩张', '景气', '里程碑', '成功', '达成',
  '涨超', '领涨', '放量', '封板',
  'profit', 'growth', 'beat', 'surge', 'rally', 'upgrade', 'buy', 'bullish', 'gain', 'rise',
  'positive', 'outperform', 'strong', 'record', 'breakthrough'
];

const negativeKeywords = [
  '利空', '亏损', '下降', '下跌', '减持', '卖出', '风险', '警告', '违规', '处罚',
  '诉讼', '退市', '暴跌', '破发', '破净', '停牌', '问询', '监管', '警示', '下调',
  '跌停', '大跌', '跌停潮', '下挫', '回落', '走弱', '杀跌', '跳水', '重挫', '净流出',
  '预减', '爆雷', '承压', '低迷', '套现', '立案', '失败', '跌超', '领跌', '缩量',
  'loss', 'decline', 'drop', 'fall', 'sell', 'bearish', 'downgrade', 'risk', 'lawsuit',
  'warning', 'negative', 'miss', 'plunge', 'crash', 'halt', 'investigation'
];

function analyzeSentiment(text) {
  if (!text) return { score: 0, label: '中性' };
  const lower = text.toLowerCase();
  let pos = 0, neg = 0;

  for (const kw of positiveKeywords) {
    if (lower.includes(kw.toLowerCase())) pos++;
  }
  for (const kw of negativeKeywords) {
    if (lower.includes(kw.toLowerCase())) neg++;
  }

  const total = pos + neg;
  if (total === 0) return { score: 0, label: '中性', positive: 0, negative: 0 };

  const score = Math.round(((pos - neg) / total) * 100);
  let label = '中性';
  if (score > 30) label = '积极';
  else if (score > 10) label = '偏多';
  else if (score < -30) label = '消极';
  else if (score < -10) label = '偏空';

  return { score, label, positive: pos, negative: neg };
}

function aggregateSentiment(newsList) {
  if (!newsList || newsList.length === 0) {
    return { overall: '中性', score: 0, positive: 0, negative: 0, neutral: 0, distribution: { pos: 33, neu: 34, neg: 33 } };
  }

  let totalScore = 0;
  let pos = 0, neg = 0, neu = 0;

  for (const news of newsList) {
    const sentiment = news.sentiment || analyzeSentiment(news.title + ' ' + (news.summary || ''));
    totalScore += sentiment.score;
    if (sentiment.label === '积极' || sentiment.label === '偏多') pos++;
    else if (sentiment.label === '消极' || sentiment.label === '偏空') neg++;
    else neu++;
  }

  const avgScore = Math.round(totalScore / newsList.length);
  let overall = '中性';
  if (avgScore > 15) overall = '积极';
  else if (avgScore > 5) overall = '偏多';
  else if (avgScore < -15) overall = '消极';
  else if (avgScore < -5) overall = '偏空';

  const total = newsList.length;
  return {
    overall,
    score: avgScore,
    positive: pos,
    negative: neg,
    neutral: neu,
    distribution: {
      pos: Math.round((pos / total) * 100),
      neu: Math.round((neu / total) * 100),
      neg: Math.round((neg / total) * 100)
    }
  };
}

// ---- 历史百分位 helpers ----
function percentileRank(arr, value) {
  if (!Array.isArray(arr) || arr.length === 0 || value == null || !isFinite(value)) return null;
  const sorted = arr.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let count = 0;
  for (const v of sorted) if (v <= value) count++;
  return Math.round((count / sorted.length) * 100);
}

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 构建「关键财务指标对标」数据：历史百分位 + 行业均值
async function buildFundamentalComparison(symbol, quote) {
  const result = {
    perShareOCF: quote?.fundamentals?.operatingCashFlowPerShare || 0,
    perShareOCFPeriod: quote?.fundamentals?.operatingCashFlowPeriodName || '',
    percentiles: {},
    industryAvg: null,
    industryName: quote?.fundamentals?.industryName || '',
    source: '东方财富估值分析/财报',
  };

  const info = detectMarket(symbol);
  const stockCode = info.tencentCode.replace(/^(sh|sz|hk|us)/, '');

  // 1) 历史百分位：基于 ZYZBAjaxNew 返回的多期财务指标
  const hist = quote?.fundamentals?.zyzbHistory;
  if (Array.isArray(hist) && hist.length >= 2) {
    const series = {
      roe: hist.map(d => toNum(d.ROEJQ)).filter(v => v !== null),
      grossMargin: hist.map(d => toNum(d.XSMLL)).filter(v => v !== null),
      netMargin: hist.map(d => toNum(d.XSJLL)).filter(v => v !== null),
      revenueGrowth: hist.map(d => toNum(d.TOTALOPERATEREVETZ)).filter(v => v !== null),
      profitGrowth: hist.map(d => toNum(d.PARENTNETPROFITTZ)).filter(v => v !== null),
      debtToEquity: hist.map(d => toNum(d.ZCFZL)).filter(v => v !== null),
      currentRatio: hist.map(d => toNum(d.LD)).filter(v => v !== null),
    };
    const current = {
      roe: toNum(quote?.fundamentals?.roe),
      grossMargin: toNum(quote?.fundamentals?.grossMargin),
      netMargin: toNum(quote?.fundamentals?.netMargin),
      revenueGrowth: toNum(quote?.fundamentals?.revenueYoy),
      profitGrowth: toNum(quote?.fundamentals?.profitYoy),
      debtToEquity: toNum(quote?.fundamentals?.debtToEquity),
      currentRatio: toNum(quote?.fundamentals?.currentRatio),
    };
    for (const [k, arr] of Object.entries(series)) {
      result.percentiles[k] = percentileRank(arr, current[k]);
    }
  }

  // 1b) 估值指标（PE/PB）历史百分位：基于估值分析日频序列
  const vh = quote?.fundamentals?.valuationHistory;
  if (Array.isArray(vh) && vh.length >= 2) {
    const peSeries = vh.map(d => d.pe).filter(v => v > 0);
    const pbSeries = vh.map(d => d.pb).filter(v => v > 0);
    const psSeries = vh.map(d => d.ps).filter(v => v > 0);
    result.percentiles.pe = percentileRank(peSeries, toNum(quote?.fundamentals?.pe));
    result.percentiles.pb = percentileRank(pbSeries, toNum(quote?.fundamentals?.pb));
    if (psSeries.length >= 2) result.percentiles.ps = percentileRank(psSeries, toNum(quote?.fundamentals?.ps));
  }

  // 2) 行业均值：使用 datacenter-web（push2 被 TLS 指纹封锁，不可用）
  // 2a) 若 backend 已在 fetchEastmoneyFundamentals 中拿到行业名称，直接查行业估值
  try {
    const industryName = result.industryName;
    if (industryName) {
      try {
        const indUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEINDUSTRY_DET&columns=ALL&source=WEB&client=WEB&filter=(BOARD_NAME=%22${encodeURIComponent(industryName)}%22)`;
        const indResp = await axios.get(indUrl, {
          headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const list = indResp.data?.result?.data || [];
        if (list.length > 0) {
          const latest = list[0];
          const pe = toNum(latest.PE_TTM);
          const pb = toNum(latest.PB_MRQ);
          // 行业 ROE 未直接给出，用 PB/PE 近似估算（ROE = PB/PE）
          const roe = (pb > 0 && pe > 0) ? round((pb / pe) * 100, 2) : null;
          result.industryAvg = { pe, pb, roe, source: '东方财富行业估值' };
        }
      } catch (e2) {
        console.error('[Comparison] industry valuation failed:', e2.message);
      }
    }

    // 2b) 兜底：通过个股估值分析接口再次确认行业/总股本，并尝试行业匹配
    if (!result.industryAvg) {
      try {
        const valUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
        const valResp = await axios.get(valUrl, {
          headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const latest = (valResp.data?.result?.data || [])[0];
        if (latest && latest.BOARD_NAME) {
          result.industryName = latest.BOARD_NAME;
          const indUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEINDUSTRY_DET&columns=ALL&source=WEB&client=WEB&filter=(BOARD_NAME=%22${encodeURIComponent(latest.BOARD_NAME)}%22)`;
          const indResp = await axios.get(indUrl, {
            headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
            timeout: 10000
          });
          const list = indResp.data?.result?.data || [];
          if (list.length > 0) {
            const latestInd = list[0];
            const pe = toNum(latestInd.PE_TTM);
            const pb = toNum(latestInd.PB_MRQ);
            const roe = (pb > 0 && pe > 0) ? round((pb / pe) * 100, 2) : null;
            result.industryAvg = { pe, pb, roe, source: '东方财富行业估值' };
          }
        }
      } catch (e3) {
        console.error('[Comparison] fallback valuation failed:', e3.message);
      }
    }
  } catch (e) {
    console.error('[Comparison] industry fetch failed:', e.message);
  }

  persistIndustryAvg(result.symbol || stockCode, result.industryAvg);

  return result;
}

module.exports = {
  SMA, EMA, RSI, MACD, Bollinger, KDJ,
  technicalAnalysis, fundamentalAnalysis, evaluateSignals,
  analyzeSentiment, aggregateSentiment,
  findSupportResistance, analyzeVolume,
  buildFundamentalComparison,
  persistPeg, persistIndustryAvg, normalizeSym,
};
