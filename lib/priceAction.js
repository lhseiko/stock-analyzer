/**
 * 价格行为（Price Action）趋势推演模块
 *
 * 核心原理：价格包容一切 + 人性重复演绎
 * 量化趋势识别：基于历史价格与成交量，客观推演未来短期（日级别）与
 * 长期（周/月级别）价格路径的最大概率场景。
 *
 * 框架：
 *  1. 底层公理：趋势延续性 / 周期嵌套（道氏）/ 量价真实性
 *  2. 长期预判（周/月级别）：MA250-MA120 斜率与位置、月线 MACD 结构、筹码密集区
 *  3. 短期预判（日/60分钟级别）：乖离率、K线组合形态、60分钟 MA60 多空平衡线
 *  4. 长短周期嵌套「趋势一致性」推演矩阵
 *  5. 趋势自我否定的「证伪临界点」
 *
 * 只输出趋势方向与概率，不输出任何操作指令。
 */
const { SMA, MACD, findSupportResistance } = require('./analysis');

const round = (n, d = 2) => {
  if (n === null || n === undefined || isNaN(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const lastOf = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

// ---- 日K线重采样为周线 / 月线 ----
function resample(daily, unit) {
  const bars = [];
  let cur = null;
  let curKey = null;
  const keyOf = (dateStr) => (unit === 'M' ? dateStr.slice(0, 7) : weekKey(dateStr));
  for (const d of daily) {
    const k = keyOf(d.date);
    if (!cur || k !== curKey) {
      if (cur) bars.push(cur);
      curKey = k;
      cur = { date: k, label: k, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, d.high);
      cur.low = Math.min(cur.low, d.low);
      cur.close = d.close;
      cur.volume += d.volume || 0;
    }
  }
  if (cur) bars.push(cur);
  return bars;
}

// ISO 周键（周一日期），用于周线聚合
function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - day + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ---- 摆动点（分形）：window 根K线确认的局部高/低点；单边趋势下 5 根分形稀少时自动降级为 3 根 ----
function swingPoints(bars, w = 2) {
  const find = (win) => {
    const highs = [];
    const lows = [];
    for (let i = win; i < bars.length - win; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= win; j++) {
        if (bars[i].high < bars[i - j].high || bars[i].high < bars[i + j].high) isHigh = false;
        if (bars[i].low > bars[i - j].low || bars[i].low > bars[i + j].low) isLow = false;
      }
      if (isHigh) highs.push({ idx: i, price: bars[i].high, date: bars[i].label || bars[i].date });
      if (isLow) lows.push({ idx: i, price: bars[i].low, date: bars[i].label || bars[i].date });
    }
    return { highs, lows };
  };
  const r = find(w);
  if (r.highs.length < 2 || r.lows.length < 2) {
    const r1 = find(1);
    return {
      highs: r.highs.length < 2 ? r1.highs : r.highs,
      lows: r.lows.length < 2 ? r1.lows : r.lows,
    };
  }
  return r;
}

// ---- MACD 红绿柱波段（连续同符号区间），用于顶/底背离判定 ----
function histWaves(hist) {
  const waves = [];
  let cur = null;
  for (let i = 0; i < hist.length; i++) {
    const v = hist[i];
    if (v === null || v === undefined) continue;
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (!cur || cur.sign !== sign) {
      if (cur) waves.push(cur);
      cur = { sign, start: i, end: i, peak: v, peakIdx: i };
    } else {
      cur.end = i;
      if (Math.abs(v) > Math.abs(cur.peak)) { cur.peak = v; cur.peakIdx = i; }
    }
  }
  if (cur) waves.push(cur);
  return waves;
}

// =========================================================
// 第二部分：长期趋势预判（周线/月线级别）
// =========================================================
function calcLongTerm(daily) {
  const closes = daily.map(d => d.close);
  const t = daily.length - 1;
  const close = closes[t];
  const evidence = [];

  const ma250 = SMA(closes, 250);
  const ma120 = SMA(closes, 120);
  const v250 = ma250[t];
  const v120 = ma120[t];

  // 1) 长期均线系统与趋势年龄
  const slopePct = (() => {
    if (v250 === null || v250 === undefined) return null;
    const ref = t - 20 >= 0 ? ma250[t - 20] : null;
    if (ref === null || ref === undefined || ref === 0) return null;
    return round(((v250 - ref) / ref) * 100, 2);
  })();
  const slopeState = slopePct === null ? null : slopePct > 0.5 ? '上翘' : slopePct < -0.5 ? '下压' : '走平';
  const positionPct = v250 ? round(((close - v250) / v250) * 100, 2) : null;

  // 缠绕判定：近120日价格与 MA250 的有效穿越次数（±1% 以内的贴线忽略）
  const flips = (() => {
    if (!v250) return null;
    let cnt = 0;
    let prevSide = 0;
    for (let i = Math.max(0, t - 119); i <= t; i++) {
      if (ma250[i] === null || ma250[i] === undefined) continue;
      const dev = (closes[i] - ma250[i]) / ma250[i];
      if (Math.abs(dev) < 0.01) continue;
      const side = dev > 0 ? 1 : -1;
      if (prevSide !== 0 && side !== prevSide) cnt++;
      prevSide = side;
    }
    return cnt;
  })();
  const winding = flips !== null && flips >= 4;

  // 2) 月线级别 MACD 与趋势结构
  const monthly = resample(daily, 'M');
  const monthlyCloses = monthly.map(m => m.close);
  const macd = monthlyCloses.length >= 35 ? MACD(monthlyCloses) : null;
  const mT = monthly.length - 1;
  const dif = macd ? macd.dif[mT] : null;
  const dea = macd ? macd.signal[mT] : null;
  const mHist = macd ? macd.histogram : null;

  const monthlyMacd = { available: !!macd, dif, dea, hist: mHist ? mHist[mT] : null, zeroPos: null, lastCross: null, crossBarsAgo: null };
  if (macd) {
    monthlyMacd.zeroPos = dif > 0 && dea > 0 ? '零轴上方' : (dif < 0 && dea < 0 ? '零轴下方' : '跨零轴');
    // 最近一次金叉/死叉
    for (let i = mT; i > 0; i--) {
      if (macd.dif[i] === null || macd.signal[i] === null || macd.dif[i - 1] === null || macd.signal[i - 1] === null) continue;
      if (macd.dif[i - 1] < macd.signal[i - 1] && macd.dif[i] > macd.signal[i]) {
        monthlyMacd.lastCross = macd.signal[i] > 0 ? '零轴上方金叉' : '零轴下方金叉';
        monthlyMacd.crossBarsAgo = mT - i;
        break;
      }
      if (macd.dif[i - 1] > macd.signal[i - 1] && macd.dif[i] < macd.signal[i]) {
        monthlyMacd.lastCross = macd.signal[i] < 0 ? '零轴下方死叉' : '零轴上方死叉';
        monthlyMacd.crossBarsAgo = mT - i;
        break;
      }
    }
  }

  // HH / HL 结构（月线摆动点）
  const monthlyRecent = monthly.slice(-48);
  const offset = monthly.length - monthlyRecent.length;
  const sw = swingPoints(monthlyRecent, 2);
  const sh = sw.highs.slice(-2);
  const sl = sw.lows.slice(-2);
  let structure = null;
  let brokeHL = false;
  if (sh.length === 2 && sl.length === 2) {
    const hh = sh[1].price > sh[0].price;
    const hl = sl[1].price > sl[0].price;
    brokeHL = close < sl[1].price;
    if (hh && hl) structure = 'HH/HL 上行结构';
    else if (!hh && !hl) structure = 'LH/LL 下行结构';
    else structure = '高低点结构紊乱';
  }

  // 月线 MACD 顶/底背离（价格新高但红柱峰值降低）
  let divergence = null;
  let divergenceNote = null;
  if (mHist) {
    const waves = histWaves(mHist).filter(w => w.sign > 0);
    if (waves.length >= 2) {
      const w1 = waves[waves.length - 2];
      const w2 = waves[waves.length - 1];
      const priceHigh1 = Math.max(...monthly.slice(w1.start, w1.end + 1).map(m => m.high));
      const priceHigh2 = Math.max(...monthly.slice(w2.start, w2.end + 1).map(m => m.high));
      if (priceHigh2 > priceHigh1 && w2.peak < w1.peak * 0.9) {
        divergence = '顶背离';
        divergenceNote = '价格创新高但月线MACD红柱峰值低于前一波，长期上行驱动力减弱，未来大概率面临中期回归均线的压力';
      }
    }
    const negWaves = histWaves(mHist).filter(w => w.sign < 0);
    if (!divergence && negWaves.length >= 2) {
      const w1 = negWaves[negWaves.length - 2];
      const w2 = negWaves[negWaves.length - 1];
      const priceLow1 = Math.min(...monthly.slice(w1.start, w1.end + 1).map(m => m.low));
      const priceLow2 = Math.min(...monthly.slice(w2.start, w2.end + 1).map(m => m.low));
      if (priceLow2 < priceLow1 && Math.abs(w2.peak) < Math.abs(w1.peak) * 0.9) {
        divergence = '底背离';
        divergenceNote = '价格创新低但月线MACD绿柱峰值低于前一波，长期下行动能衰竭，存在筑底修复预期';
      }
    }
  }

  // 3) 长期筹码密集区（近3年量价分布）
  const profile = calcVolumeProfile(daily, 750);

  // ---- 长期趋势定性合成 ----
  let verdict = '震荡';
  let score = 0;
  if (v250 !== null && v250 !== undefined) {
    if (slopeState === '上翘') score += 1;
    else if (slopeState === '下压') score -= 1;
    if (positionPct > 1) score += 1;
    else if (positionPct < -1) score -= 1;
  }
  if (monthlyMacd.available) {
    if (monthlyMacd.zeroPos === '零轴上方') score += 1;
    else if (monthlyMacd.zeroPos === '零轴下方') score -= 1;
    if (monthlyMacd.lastCross === '零轴上方金叉') score += 0.5;
    else if (monthlyMacd.lastCross === '零轴下方死叉') score -= 0.5;
  }
  if (structure === 'HH/HL 上行结构') score += 1;
  else if (structure === 'LH/LL 下行结构') score -= 1;
  if (divergence === '顶背离') score -= 0.5;
  else if (divergence === '底背离') score += 0.5;

  if (winding) {
    verdict = '震荡';
    evidence.push(`价格与年线（MA250）近半年反复穿越 ${flips} 次，呈缠绕形态，预判长期宽幅震荡，无单边趋势倾向`);
  } else if (score >= 1.5) verdict = '上行';
  else if (score <= -1.5) verdict = '下行';
  else verdict = '震荡';

  // 依据文本
  if (v250 !== null && v250 !== undefined) {
    evidence.push(`年线MA250=${v250}（${slopeState}，近20日斜率${slopePct >= 0 ? '+' : ''}${slopePct}%），价格${positionPct >= 0 ? '持续运行于年线之上' : '持续运行于年线之下'}（偏离${positionPct >= 0 ? '+' : ''}${positionPct}%）`);
    if (v120 !== null && v120 !== undefined) evidence.push(`半年线MA120=${v120}，价格${close > v120 ? '位于其上' : '位于其下'}，长期成本中枢${close > v120 && close > v250 ? '逐级上移' : close < v120 && close < v250 ? '逐级下移' : '方向不一'}`);
  } else {
    evidence.push('上市时间不足一年，年线数据不足，长期预判以半年线与月线MACD为参考');
  }
  if (monthlyMacd.available) {
    evidence.push(`月线MACD：DIF=${dif}、DEA=${dea}，位于${monthlyMacd.zeroPos}${monthlyMacd.lastCross ? `，近期发生${monthlyMacd.lastCross}（${monthlyMacd.crossBarsAgo}个月前）` : ''}，趋势惯性${monthlyMacd.zeroPos === '零轴上方' ? '偏多' : monthlyMacd.zeroPos === '零轴下方' ? '偏空' : '中性'}`);
  } else {
    evidence.push('月线数据不足35根，月线MACD不具备统计意义，已剔除该维度');
  }
  if (structure) {
    if (brokeHL && structure === 'HH/HL 上行结构') {
      evidence.push(`月线${structure}，但当前价格已跌破前一个更高低点（${sl[1].price}），长期趋势面临转折风险，预期修正为区间震荡或转熊`);
    } else {
      evidence.push(`月线摆动结构：${structure}${divergence ? `，且出现${divergence}` : ''}`);
    }
  }
  if (divergenceNote) evidence.push(divergenceNote);
  if (profile) {
    if (profile.resistance) evidence.push(`上方长期筹码密集区（阻力带）${profile.resistance.low}~${profile.resistance.high}，套牢筹码占近3年成交约${profile.abovePct}%`);
    if (profile.support) evidence.push(`下方长期缩量横盘密集区（支撑带）${profile.support.low}~${profile.support.high}`);
  }

  return {
    verdict,
    score,
    winding,
    ma250: v250 ? { value: v250, slopePct, slopeState, positionPct } : null,
    ma120: v120 ? { value: v120, position: close > v120 ? '上方' : '下方' } : null,
    monthlyMacd,
    structure,
    brokeHL,
    prevHL: sl.length === 2 ? sl[1].price : null,
    divergence,
    profile,
    evidence,
  };
}

// ---- 长期筹码密集区：价格分档成交量分布 ----
function calcVolumeProfile(daily, lookback = 750) {
  const recent = daily.slice(-lookback);
  if (recent.length < 60) return null;
  const close = recent[recent.length - 1].close;
  const lo = Math.min(...recent.map(d => d.low));
  const hi = Math.max(...recent.map(d => d.high));
  if (!(hi > lo)) return null;
  const N = 30;
  const step = (hi - lo) / N;
  const bins = Array.from({ length: N }, (_, i) => ({ low: round(lo + i * step), high: round(lo + (i + 1) * step), vol: 0 }));
  let total = 0;
  for (const d of recent) {
    const tp = (d.high + d.low + d.close) / 3;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((tp - lo) / step)));
    bins[idx].vol += d.volume || 0;
    total += d.volume || 0;
  }
  bins.forEach(b => { b.pct = total > 0 ? round((b.vol / total) * 100, 2) : 0; });

  const aboveVols = bins.filter(b => b.low >= close);
  const abovePct = round(aboveVols.reduce((s, b) => s + b.pct, 0), 2);

  // 上方最大密集区（阻力带）与下方最大密集区（支撑带）
  let resistance = null, support = null;
  for (const b of bins) {
    if (b.low >= close && (!resistance || b.vol > resistance.vol)) resistance = b;
    if (b.high <= close && (!support || b.vol > support.vol)) support = b;
  }
  return {
    bins,
    currentPrice: close,
    abovePct,
    belowPct: round(100 - abovePct, 2),
    resistance: resistance ? { low: resistance.low, high: resistance.high, pct: resistance.pct } : null,
    support: support ? { low: support.low, high: support.high, pct: support.pct } : null,
  };
}

// =========================================================
// 第三部分：短期趋势预判（日线/60分钟级别，未来1-5个交易日）
// =========================================================
function calcShortTerm(daily, h60) {
  const closes = daily.map(d => d.close);
  const t = daily.length - 1;
  const close = closes[t];
  const evidence = [];

  const ma5 = SMA(closes, 5);
  const ma60 = SMA(closes, 60);
  const ma20 = SMA(closes, 20);
  const v5 = ma5[t];

  // 1) 短期乖离率（波动率标准化：Z = 乖离 / 近20日日波动）
  const bias5 = v5 ? round(((close - v5) / v5) * 100, 2) : null;
  const rets = [];
  for (let i = Math.max(1, t - 19); i <= t; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rets.length || 1));
  const biasZ = bias5 !== null && std > 0 ? round(bias5 / (std * Math.sqrt(5) * 100), 2) : null;

  // MA5 与 MA60 斜率差（短期动能 vs 中期动能）
  const slopeSpread = (() => {
    if (!v5 || !ma60[t]) return null;
    const r5 = t - 3 >= 0 ? ma5[t - 3] : null;
    const r60 = t - 20 >= 0 ? ma60[t - 20] : null;
    if (r5 === null || r60 === null || !r5 || !r60) return null;
    const s5 = ((v5 - r5) / r5) * 100;
    const s60 = ((ma60[t] - r60) / r60) * 100;
    return round(s5 - s60, 2);
  })();

  const overbought = biasZ !== null && biasZ > 2;
  const oversold = biasZ !== null && biasZ < -2;
  const slopeSpreadWide = slopeSpread !== null && Math.abs(slopeSpread) > 8;

  // 2) 近期K线组合形态
  const prior = daily.slice(Math.max(0, t - 20), t);
  const avgVol = prior.length ? prior.reduce((s, d) => s + (d.volume || 0), 0) / prior.length : 0;
  const volRatio = avgVol > 0 ? round(daily[t].volume / avgVol, 2) : null;
  const high20 = prior.length ? Math.max(...prior.map(d => d.high)) : null;
  const low20 = prior.length ? Math.min(...prior.map(d => d.low)) : null;
  let pattern = '无显著形态';
  if (high20 && close > high20 && volRatio !== null && volRatio >= 1.5) pattern = '放量突破前高';
  else if (low20 && close < low20 && volRatio !== null && volRatio >= 1.5) pattern = '放量跌破前低';
  else if (high20 && close > high20 && volRatio !== null && volRatio < 0.8) pattern = '缩量新高';

  // 3) 60分钟 MA60 多空平衡线
  let h60ma = null;
  if (h60 && h60.length >= 60) {
    const c60 = h60.map(d => d.close);
    const m60 = SMA(c60, 60);
    const v = m60[m60.length - 1];
    if (v !== null && v !== undefined) {
      const last = c60[c60.length - 1];
      let crossings = 0;
      let prevSide = 0;
      for (let i = Math.max(0, c60.length - 16); i < c60.length; i++) {
        if (m60[i] === null || m60[i] === undefined) continue;
        const side = c60[i] > m60[i] ? 1 : -1;
        if (prevSide !== 0 && side !== prevSide) crossings++;
        prevSide = side;
      }
      h60ma = {
        value: v,
        position: crossings >= 3 ? '反复穿越' : last > v ? '上方' : '下方',
        crossings,
      };
    }
  }

  // ---- 短期方向合成 ----
  let dirScore = 0;
  if (pattern === '放量突破前高') dirScore += 2;
  else if (pattern === '放量跌破前低') dirScore -= 2;
  else if (pattern === '缩量新高') dirScore -= 0.5;
  if (h60ma) {
    if (h60ma.position === '上方') dirScore += 1;
    else if (h60ma.position === '下方') dirScore -= 1;
  }
  if (slopeSpreadWide && slopeSpread > 0) dirScore -= 1; // 动能透支
  if (overbought) dirScore -= 1.5;   // 均值回归压力
  if (oversold) dirScore += 1.5;

  let direction = '震荡';
  if (dirScore >= 1.5) direction = '上行';
  else if (dirScore <= -1.5) direction = '下行';
  else if (dirScore > 0) direction = '震荡偏上';
  else if (dirScore < 0) direction = '震荡偏下';
  if (overbought && direction === '上行') direction = '冲高回落';
  if (oversold && direction === '下行') direction = '超跌反弹';

  // ---- 阻力 / 支撑区间（与「支撑与阻力位」卡片同源，保证数据一致性）----
  const sr = findSupportResistance(daily, 60);
  const resistances = [];
  const supports = [];
  sr.resistances.slice(0, 2).forEach(r => resistances.push({ low: round(r * 0.995), high: round(r * 1.005), source: '近60日摆动高点' }));
  sr.supports.slice(0, 2).forEach(s => supports.push({ low: round(s * 0.995), high: round(s * 1.005), source: '近60日摆动低点' }));
  if (ma20[t]) {
    if (close > ma20[t]) supports.push({ low: round(ma20[t] * 0.99), high: round(ma20[t] * 1.01), source: 'MA20' });
    else resistances.push({ low: round(ma20[t] * 0.99), high: round(ma20[t] * 1.01), source: 'MA20' });
  }
  resistances.sort((a, b) => a.low - b.low);
  supports.sort((a, b) => b.low - a.low);

  // 依据文本
  if (bias5 !== null) {
    evidence.push(`价格偏离MA5 ${bias5 >= 0 ? '+' : ''}${bias5}%（标准化乖离Z=${biasZ}），${overbought ? '短期超买压力累积，未来数日向MA5/BOLL中轨靠拢的概率显著增加' : oversold ? '短期超卖，存在向MA5修复的均值回归预期' : '乖离率稳定，短期趋势惯性良好，当前运动方向大概率维持'}`);
  }
  if (slopeSpread !== null) {
    evidence.push(`MA5与MA60斜率差${slopeSpread >= 0 ? '+' : ''}${slopeSpread}%${slopeSpreadWide ? '，短期运行速率过快，回归预期增强' : ''}`);
  }
  if (pattern === '放量突破前高') evidence.push(`放量突破近20日前高（${round(high20)}），量比${volRatio}，短期多头力量占优，价格重心上移`);
  else if (pattern === '放量跌破前低') evidence.push(`放量跌破近20日前低（${round(low20)}），量比${volRatio}，短期空头力量占优，价格重心下移`);
  else if (pattern === '缩量新高') evidence.push(`缩量创出近20日新高（量比${volRatio}），追高意愿不足，存在冲高回落、重回下方支撑区的风险`);
  else evidence.push(`近20日高低点区间${round(low20)}~${round(high20)}内无方向性突破，量比${volRatio || '--'}`);
  if (h60ma) {
    evidence.push(`60分钟MA60（${h60ma.value}）：价格运行于其${h60ma.position}${h60ma.position === '反复穿越' ? '，短期方向不明，无清晰趋势预期' : h60ma.position === '上方' ? '，预判短期偏强震荡' : '，预判短期偏弱震荡'}`);
  }

  return {
    direction,
    dirScore,
    bias5,
    biasZ,
    overbought,
    oversold,
    slopeSpread,
    pattern,
    volRatio,
    high20: round(high20),
    low20: round(low20),
    h60ma,
    resistances,
    supports,
    evidence,
  };
}

// =========================================================
// 短期状态分类（用于趋势一致性矩阵）
// =========================================================
function classifyShortState(daily, longTerm, shortTerm) {
  const t = daily.length - 1;
  const closes = daily.map(d => d.close);
  const vols = daily.map(d => d.volume || 0);
  const chg5 = closes[t - 4] ? ((closes[t] - closes[t - 4]) / closes[t - 4]) * 100 : 0;
  const avg5 = vols.slice(t - 4, t + 1).reduce((s, v) => s + v, 0) / 5;
  const avg20 = vols.slice(Math.max(0, t - 19), t + 1).reduce((s, v) => s + v, 0) / 20;
  const vol5Ratio = avg20 > 0 ? avg5 / avg20 : 1;
  const close = closes[t];
  const ma120 = SMA(closes, 120)[t];
  const ma250 = SMA(closes, 250)[t];
  const nearLongMA = (ma120 && Math.abs(close - ma120) / ma120 < 0.03) || (ma250 && Math.abs(close - ma250) / ma250 < 0.05);

  if (longTerm.verdict === '上行' && chg5 < -3 && nearLongMA && vol5Ratio < 0.9) return 'pullback_shrink';
  if (chg5 > 10 && shortTerm.volRatio >= 2) return 'surge_heavy';
  if (longTerm.verdict === '下行' && chg5 > 5 && (shortTerm.volRatio || 0) >= 1.3) return 'rebound_heavy';
  if (Math.abs(chg5) < 3 && vol5Ratio < 0.8) return 'sideways_shrink';
  if (longTerm.verdict === '震荡' && shortTerm.pattern === '放量突破前高') return 'breakout_heavy';
  if (shortTerm.pattern === '放量突破前高') return 'breakout_heavy';
  if (Math.abs(chg5) < 3) return 'sideways';
  return chg5 > 0 ? 'up' : 'down';
}

// =========================================================
// 第四部分：长短周期嵌套「趋势一致性」推演矩阵
// =========================================================
const MATRIX = {
  '上行+pullback_shrink': {
    scenario: '趋势共振向上',
    text: '短期回调大概率结束，价格未来重拾长期升势的预期强烈，短期目标指向近期前高',
    consistent: true, dominant: '长期',
  },
  '上行+surge_heavy': {
    scenario: '短期透支预期',
    text: '长期虽看多，但短期能量消耗过快，预判未来数日价格将进入横盘或回吐修正以修复超买指标，但不会扭转长期方向',
    consistent: false, dominant: '长期',
  },
  '下行+rebound_heavy': {
    scenario: '短期反弹，长期承压',
    text: '此为短期技术性修复，长期下行结构未变，价格反弹至上方长期均线或筹码密集区时将面临强大压制，恐重回跌势',
    consistent: false, dominant: '长期',
  },
  '下行+sideways_shrink': {
    scenario: '趋势延续预期',
    text: '当前缩量横盘为下跌中继，长期重心继续下移的概率较高',
    consistent: true, dominant: '长期',
  },
  '震荡+breakout_heavy': {
    scenario: '趋势尝试启动',
    text: '短期突破为有效尝试，但持续性有待观察：若后续成交量能维持，长期震荡格局有望转为上行；若快速缩量回归，则预判为假突破，重归震荡',
    consistent: false, dominant: '短期（观察期）',
  },
};

function calcCoordination(longTerm, shortTerm, shortState) {
  const key = `${longTerm.verdict}+${shortState}`;
  const m = MATRIX[key] || {
    scenario: key.startsWith('上行') ? '长期多头框架下的顺势延续' : key.startsWith('下行') ? '长期空头框架下的顺势延续' : '箱体震荡延续',
    text: key.startsWith('上行')
      ? '短期波动未破坏长期上行结构，预判价格在长期趋势框架内延续偏强运行'
      : key.startsWith('下行')
        ? '短期波动未改变长期下行结构，预判价格在长期趋势框架内延续偏弱运行'
        : '长期无单边倾向，短期亦无突破确认，预判价格延续箱体震荡，等待方向选择',
    consistent: true,
    dominant: '长期',
  };
  return {
    key,
    shortState,
    scenario: m.scenario,
    text: m.text,
    consistent: m.consistent,
    dominant: m.dominant,
  };
}

// =========================================================
// 第五部分：趋势自我否定的「证伪临界点」
// =========================================================
function calcFalsification(daily, longTerm, shortTerm) {
  const monthly = resample(daily, 'M');
  const recent = monthly.slice(-36); // 近3年
  const offset = monthly.length - recent.length;
  const t = daily.length - 1;
  const close = daily[t].close;

  // 长期上升趋势线：近3年月线上「低点抬升」的最近两个摆动低点连线
  const sw = swingPoints(recent, 2);
  const lows = sw.lows;
  let upLine = null;
  for (let i = lows.length - 1; i > 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      if (lows[i].price > lows[j].price && lows[i].idx - lows[j].idx >= 6) {
        upLine = { p1: lows[j], p2: lows[i] };
        break;
      }
    }
    if (upLine) break;
  }
  let trendline = null;
  if (upLine) {
    const gIdx = offset + upLine.p2.idx;
    const monthsFromP2 = monthly.length - 1 - gIdx;
    const slopePerMonth = (upLine.p2.price - upLine.p1.price) / (upLine.p2.idx - upLine.p1.idx);
    const value = round(upLine.p2.price + slopePerMonth * monthsFromP2);
    trendline = {
      value,
      broken: close < value * 0.99,
      p1: { date: upLine.p1.date, price: upLine.p1.price },
      p2: { date: upLine.p2.date, price: upLine.p2.price },
    };
  }

  // 短期动能证伪：当日K线运行于前一日实体范围内且无方向性突破
  let insideDay = false;
  let prevBody = null;
  if (t >= 1) {
    const p = daily[t - 1];
    prevBody = { low: round(Math.min(p.open, p.close)), high: round(Math.max(p.open, p.close)) };
    insideDay = daily[t].high <= prevBody.high && daily[t].low >= prevBody.low;
  }

  // 量价背离证伪：上涨但成交量连续3日递减
  let hollowRally = false;
  if (t >= 3) {
    const c = closesOf(daily);
    hollowRally = c[t] > c[t - 1] && c[t - 1] > c[t - 2] && c[t - 2] > c[t - 3]
      && daily[t].volume < daily[t - 1].volume && daily[t - 1].volume < daily[t - 2].volume;
  }

  // ---- 量化边界（含证伪条件）----
  const edges = [];
  const firstRes = shortTerm.resistances[0];
  const firstSup = shortTerm.supports[0];
  if (longTerm.verdict !== '下行' && firstRes) {
    edges.push({ condition: `若未来3日收盘价站稳 ${firstRes.high} 元（${firstRes.source}）`, effect: '强化上行预期，趋势共振确认' });
  }
  if (longTerm.verdict !== '上行' && firstSup) {
    edges.push({ condition: `若跌破 ${firstSup.low} 元（${firstSup.source}）`, effect: '修正为下行预期' });
  } else if (firstSup && longTerm.verdict === '上行') {
    edges.push({ condition: `若有效跌破 ${firstSup.low} 元（${firstSup.source}）`, effect: '短期调整升级，需回检长期结构' });
  }
  if (trendline && longTerm.verdict !== '下行') {
    edges.push({ condition: `若月线级别收盘有效跌破 ${trendline.value} 元（近3年上升趋势线：${trendline.p1.date} 低点 ${trendline.p1.price} 与 ${trendline.p2.date} 低点 ${trendline.p2.price} 连线）`, effect: '推翻"长期多头"预判，修正为长期转空或大级别调整预期' });
  }
  if (trendline && trendline.broken) {
    edges.push({ condition: `当前收盘 ${round(close)} 已跌破趋势线值 ${trendline.value}`, effect: '长期多头预判已触发证伪条件，应按"长期转空或大级别调整"预期重估' });
  }
  if (prevBody) {
    edges.push({ condition: `若次日价格始终运行于前一日实体 ${prevBody.low}~${prevBody.high} 内且无方向性突破`, effect: '维持"短期无明确方向"预判，不强行给出多空倾向' });
  }
  if (hollowRally) {
    edges.push({ condition: '近3日上涨但成交量逐日递减', effect: '当前上涨为"空心化上涨"，主动下调短期上行目标预期' });
  } else {
    edges.push({ condition: '若上涨伴随成交量连续3日递减', effect: '判定为"空心化上涨"，下调短期上行目标预期' });
  }

  return { trendline, insideDay, prevBody, hollowRally, edges };
}

const closesOf = (daily) => daily.map(d => d.close);

// =========================================================
// 主入口：价格行为趋势推演
// =========================================================
function analyzePriceAction(daily, h60) {
  if (!daily || daily.length < 60) {
    return { error: 'K线数据不足（需至少60根），无法进行价格行为推演' };
  }
  const longTerm = calcLongTerm(daily);
  const shortTerm = calcShortTerm(daily, h60);
  const shortState = classifyShortState(daily, longTerm, shortTerm);
  const coordination = calcCoordination(longTerm, shortTerm, shortState);
  const falsification = calcFalsification(daily, longTerm, shortTerm);

  // 短期概率：依据信号一致性（方向分值绝对值 + 矩阵匹配度）
  const absScore = Math.abs(shortTerm.dirScore || 0);
  const probability = coordination.consistent && absScore >= 2 ? '高' : absScore >= 1 ? '中' : '低';

  // 图表数据：月线K线 + 均线 + MACD
  const monthly = resample(daily, 'M');
  const monthlyCloses = monthly.map(m => m.close);
  const macd = monthlyCloses.length >= 35 ? MACD(monthlyCloses) : null;
  const charts = {
    monthly: {
      labels: monthly.map(m => m.label),
      ohlc: monthly.map(m => [m.open, m.close, m.low, m.high]),
      volumes: monthly.map(m => m.volume),
      ma5: SMA(monthlyCloses, 5),
      ma10: SMA(monthlyCloses, 10),
      ma30: SMA(monthlyCloses, 30),
      macd: macd ? { dif: macd.dif, dea: macd.signal, hist: macd.histogram } : null,
    },
    profile: longTerm.profile,
    trendline: falsification.trendline,
  };

  return {
    longTerm,
    shortTerm: { ...shortTerm, probability },
    coordination,
    falsification,
    charts,
    meta: {
      dailyBars: daily.length,
      monthlyBars: monthly.length,
      range: `${daily[0].date} ~ ${daily[daily.length - 1].date}`,
      source: '本地计算（日K/60分钟K线 + 价格行为框架）',
    },
  };
}

module.exports = { analyzePriceAction, resample };
