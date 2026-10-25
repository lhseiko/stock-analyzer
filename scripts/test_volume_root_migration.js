/**
 * 量能根模块收敛等价性守卫（20261017a）
 * ------------------------------------------------------------------
 * 背景：按「个股侧量能唯一出口」规则，原由各消费模块自行计算的 7 项量能指标
 *   收敛迁入 lib/capitalFlow.js computeVolumeIndicators：
 *     latestVsPriorAvg  原 lib/analysis.js:356-369        analyzeVolume
 *     breakout          原 lib/priceAction.js:369-377     （20日高低点突破量比与形态）
 *     vol5Vs20          原 lib/priceAction.js:479-481
 *     shrink3d          原 lib/priceAction.js:596-601     （空心化上涨证伪）
 *     turnoverChange    原 lib/sameDayJudgment.js:184-211 _computeTurnoverChange
 *     volActivity       原 lib/sameDayJudgment.js:352-370 （量能活跃度子信号）
 *     volumeProfile     原 lib/priceAction.js:293-328     calcVolumeProfile
 *   本测试把上述旧实现原样内联，与 capitalFlow 新输出在多个确定性场景下逐一比对，
 *   确保收敛是「纯搬迁」：数据不变则结论不变。
 *
 * 运行：node scripts/test_volume_root_migration.js
 */
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { computeVolumeIndicators } = require(path.join(ROOT, 'lib', 'capitalFlow.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  → ' + e.message); }
};

// ---------- 确定性伪随机（LCG，保证跨次运行可复现） ----------
let _seed = 20261017;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648; };

// ---------- 旧实现（逐行照抄自迁移前源码） ----------
const oRound = (x, n = 2) => { const p = Math.pow(10, n); return Math.round(x * p) / p; };
const oAvg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const oClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// lib/analysis.js:356-369
function oldAnalyzeVolume(history) {
  const recent = history.slice(-20);
  if (recent.length === 0) return { trend: 'unknown', ratio: 0 };
  const avgVolume = recent.slice(0, -1).reduce((s, d) => s + d.volume, 0) / (recent.length - 1);
  const lastVolume = recent[recent.length - 1].volume;
  const ratio = avgVolume > 0 ? lastVolume / avgVolume : 0;
  let trend = 'normal';
  if (ratio > 2) trend = '放量';
  else if (ratio > 1.2) trend = '温和放量'; // [20261024c] 对齐量比铁律 >1.2 放量（旧 1.5）
  else if (ratio < 0.8) trend = '缩量'; // [20261024c] 对齐 <0.8 缩量（旧 0.5）
  return { trend, ratio: oRound(ratio, 2), avgVolume: Math.round(avgVolume) };
}

// lib/priceAction.js:369-377（calcShortTerm 内）
function oldBreakout(daily) {
  const closes = daily.map(d => d.close);
  const t = daily.length - 1;
  const close = closes[t];
  const prior = daily.slice(Math.max(0, t - 20), t);
  const avgVol = prior.length ? prior.reduce((s, d) => s + (d.volume || 0), 0) / prior.length : 0;
  const volRatio = avgVol > 0 ? oRound(daily[t].volume / avgVol, 2) : null;
  const high20 = prior.length ? Math.max(...prior.map(d => d.high)) : null;
  const low20 = prior.length ? Math.min(...prior.map(d => d.low)) : null;
  let pattern = '无显著形态';
  if (high20 && close > high20 && volRatio !== null && volRatio >= 1.2) pattern = '放量突破前高'; // [20261024c] 对齐 1.2
  else if (low20 && close < low20 && volRatio !== null && volRatio >= 1.2) pattern = '放量跌破前低'; // [20261024c] 对齐 1.2
  else if (high20 && close > high20 && volRatio !== null && volRatio < 0.8) pattern = '缩量新高';
  return { volRatio, high20, low20, pattern };
}

// lib/priceAction.js:479-481（classifyShortState 内）
function oldVol5Vs20(daily) {
  const vols = daily.map(d => d.volume || 0);
  const t = daily.length - 1;
  const avg5 = vols.slice(t - 4, t + 1).reduce((s, v) => s + v, 0) / 5;
  const avg20 = vols.slice(Math.max(0, t - 19), t + 1).reduce((s, v) => s + v, 0) / 20;
  return avg20 > 0 ? avg5 / avg20 : 1;
}

// lib/priceAction.js:596-601（calcFalsification 内）
function oldShrink3d(daily) {
  const t = daily.length - 1;
  if (t < 3) return false;
  const c = daily.map(d => d.close);
  return c[t] > c[t - 1] && c[t - 1] > c[t - 2] && c[t - 2] > c[t - 3]
    && daily[t].volume < daily[t - 1].volume && daily[t - 1].volume < daily[t - 2].volume;
}

// lib/sameDayJudgment.js:184-211
function oldTurnoverChange(series) {
  if (!Array.isArray(series) || series.length < 20) {
    return { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' };
  }
  const base = series.slice(0, -5);
  const baseline = oAvg(base.map(s => s.turnover));
  const tail = series.slice(-5);
  const latest = tail[tail.length - 1].turnover;
  if (!(baseline > 0)) return { ok: false, signal: 0, detail: '换手率基准为0，按中性处理' };
  const ratio = latest / baseline;
  const lastClose = series[series.length - 1].close;
  const prevClose = series[series.length - 2].close;
  const priceDir = (typeof lastClose === 'number' && typeof prevClose === 'number' && prevClose > 0)
    ? (lastClose - prevClose >= 0 ? 1 : -1) : 0;
  const dev = oClamp(Math.abs(ratio - 1) * 1.2, 0, 1.2);
  const volDir = ratio >= 1 ? 1 : -0.5;
  const signal = oClamp(dev * priceDir * volDir, -1, 1);
  const dirTxt = priceDir > 0 ? '价涨' : priceDir < 0 ? '价跌' : '价平';
  const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
  const tone = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  const detail = `最新换手率 ${oRound(latest, 2)}%，近15日均值 ${oRound(baseline, 2)}%（偏离 ${(ratio >= 1 ? '+' : '') + oRound((ratio - 1) * 100, 1)}%），近两日${dirTxt}·${volTxt} → ${tone}`;
  return { ok: true, signal, detail };
}

// lib/sameDayJudgment.js:352-370（factorCapital 内 volActivity）
function oldVolActivity(history) {
  const last = history[history.length - 1];
  const vols = history.slice(-20).map(h => h.volume).filter(v => typeof v === 'number' && v > 0);
  if (vols.length < 5 || last.volume == null) return null;
  const avgVol = oAvg(vols);
  const ratio = avgVol > 0 ? last.volume / avgVol : 1;
  const prevClose = history[history.length - 2].close;
  const priceDir = (prevClose != null && last.close != null) ? (last.close - prevClose) : 0;
  const volDir = ratio >= 1 ? 1 : -0.5;
  const volSignal = oClamp(Math.abs(ratio - 1) * (priceDir >= 0 ? 1 : -1) * volDir, -1, 1);
  const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
  const toneTxt = volSignal > 0.05 ? '偏多' : volSignal < -0.05 ? '偏空' : '中性';
  return { signal: volSignal, ratio, avgVol, lastVol: last.volume, priceDir, volTxt, toneTxt };
}

// lib/priceAction.js:293-328
function oldVolumeProfile(daily, lookback = 750) {
  const oRoundP = (n, d = 2) => { if (n === null || n === undefined || isNaN(n)) return null; const p = Math.pow(10, d); return Math.round(n * p) / p; };
  const recent = daily.slice(-lookback);
  if (recent.length < 60) return null;
  const close = recent[recent.length - 1].close;
  const lo = Math.min(...recent.map(d => d.low));
  const hi = Math.max(...recent.map(d => d.high));
  if (!(hi > lo)) return null;
  const N = 30;
  const step = (hi - lo) / N;
  const bins = Array.from({ length: N }, (_, i) => ({ low: oRoundP(lo + i * step), high: oRoundP(lo + (i + 1) * step), vol: 0 }));
  let total = 0;
  for (const d of recent) {
    const tp = (d.high + d.low + d.close) / 3;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((tp - lo) / step)));
    bins[idx].vol += d.volume || 0;
    total += d.volume || 0;
  }
  bins.forEach(b => { b.pct = total > 0 ? oRoundP((b.vol / total) * 100, 2) : 0; });
  const aboveVols = bins.filter(b => b.low >= close);
  const abovePct = oRoundP(aboveVols.reduce((s, b) => s + b.pct, 0), 2);
  let resistance = null, support = null;
  for (const b of bins) {
    if (b.low >= close && (!resistance || b.vol > resistance.vol)) resistance = b;
    if (b.high <= close && (!support || b.vol > support.vol)) support = b;
  }
  return {
    bins, currentPrice: close, abovePct, belowPct: oRoundP(100 - abovePct, 2),
    resistance: resistance ? { low: resistance.low, high: resistance.high, pct: resistance.pct } : null,
    support: support ? { low: support.low, high: support.high, pct: support.pct } : null,
  };
}

// ---------- 场景构造 ----------
function genBase(n, startClose = 50) {
  const bars = [];
  let close = startClose;
  for (let i = 0; i < n; i++) {
    const chg = (rnd() - 0.5) * 0.04;
    const open = close;
    close = Math.max(1, close * (1 + chg));
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    const volume = Math.round(1e6 * (0.6 + rnd() * 0.8));
    bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open, high, low, close, volume, amount: close * volume });
  }
  return bars;
}
// 近 3 日连续收涨 + 成交量连续 2 日递减（触发空心化上涨）
function genShrink3d(n = 120) {
  const bars = genBase(n);
  for (let k = 0; k < 3; k++) {
    const i = bars.length - 1 - k;
    bars[i].close = bars[i].close * 1.02;
    bars[i].high = Math.max(bars[i].high, bars[i].close);
  }
  bars[bars.length - 1].volume = Math.round(bars[bars.length - 2].volume * 0.7);
  bars[bars.length - 2].volume = Math.round(bars[bars.length - 3].volume * 0.8);
  return bars;
}
// 放量突破前高：末日收盘 > 前20日最高，且量比 ≥1.2（[20261024c] 对齐量比铁律，旧 1.5）
function genBreakoutUp(n = 120) {
  const bars = genBase(n);
  const prior = bars.slice(-21, -1);
  const hi = Math.max(...prior.map(b => b.high));
  const last = bars[bars.length - 1];
  last.close = hi * 1.05;
  last.high = Math.max(last.high, last.close * 1.005);
  last.volume = Math.round(2.2 * prior.reduce((s, b) => s + b.volume, 0) / prior.length);
  return bars;
}
// 缩量新高：末日收盘 > 前20日最高，但量比 <0.8
function genNewHighShrink(n = 120) {
  const bars = genBase(n);
  const prior = bars.slice(-21, -1);
  const hi = Math.max(...prior.map(b => b.high));
  const last = bars[bars.length - 1];
  last.close = hi * 1.02;
  last.high = Math.max(last.high, last.close * 1.005);
  last.volume = Math.round(0.5 * prior.reduce((s, b) => s + b.volume, 0) / prior.length);
  return bars;
}
// 放量跌破前低
function genBreakoutDown(n = 120) {
  const bars = genBase(n);
  const prior = bars.slice(-21, -1);
  const lo = Math.min(...prior.map(b => b.low));
  const last = bars[bars.length - 1];
  last.close = lo * 0.95;
  last.low = Math.min(last.low, last.close * 0.995);
  last.volume = Math.round(2.2 * prior.reduce((s, b) => s + b.volume, 0) / prior.length);
  return bars;
}
// 换手率序列（{date,turnover,close}，长度 60）
function genTurnoverSeries(n = 60) {
  const s = [];
  let close = 30;
  for (let i = 0; i < n; i++) {
    close = Math.max(1, close * (1 + (rnd() - 0.5) * 0.03));
    s.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, turnover: +(1 + rnd() * 4).toFixed(2), close: +close.toFixed(2) });
  }
  return s;
}

const SCENARIOS = [
  { name: '基础随机游走（120 根）', hist: genBase(120) },
  { name: '空心化上涨（近3日涨+缩量）', hist: genShrink3d() },
  { name: '放量突破前高', hist: genBreakoutUp() },
  { name: '缩量新高', hist: genNewHighShrink() },
  { name: '放量跌破前低', hist: genBreakoutDown() },
  { name: '边界：恰好 20 根', hist: genBase(20) },
  { name: '长窗口：800 根（筹码分布）', hist: genBase(800) },
];

console.log('===== §1 七项量能根指标 新旧实现逐一等价 =====');
for (const sc of SCENARIOS) {
  const vi = computeVolumeIndicators(sc.hist, null, null);
  ok(`[${sc.name}] computeVolumeIndicators 返回非空`, () => assert.ok(vi && vi.indicators));

  ok(`[${sc.name}] latestVsPriorAvg ≡ analysis.js analyzeVolume`, () => {
    const oldV = oldAnalyzeVolume(sc.hist);
    assert.strictEqual(vi.indicators.latestVsPriorAvg.ratio, oldV.ratio);
    assert.strictEqual(vi.indicators.latestVsPriorAvg.trend, oldV.trend);
    assert.strictEqual(Math.round(vi.indicators.latestVsPriorAvg.priorAvgVol), oldV.avgVolume);
  });

  ok(`[${sc.name}] breakout ≡ priceAction.js 突破量比与形态`, () => {
    const oldV = oldBreakout(sc.hist);
    assert.deepStrictEqual(vi.indicators.breakout, oldV);
  });

  ok(`[${sc.name}] vol5Vs20 ≡ priceAction.js classifyShortState`, () => {
    assert.strictEqual(vi.indicators.vol5Vs20, oldVol5Vs20(sc.hist));
  });

  ok(`[${sc.name}] shrink3d ≡ priceAction.js 空心化证伪`, () => {
    assert.strictEqual(vi.indicators.shrink3d, oldShrink3d(sc.hist));
  });

  ok(`[${sc.name}] volActivity ≡ sameDayJudgment.js 量能活跃度`, () => {
    assert.deepStrictEqual(vi.indicators.volActivity, oldVolActivity(sc.hist));
  });
}

console.log('\n===== §2 筹码分布（opt-in）等价 =====');
for (const sc of SCENARIOS) {
  const vi = computeVolumeIndicators(sc.hist, null, null, { includeProfile: true });
  ok(`[${sc.name}] volumeProfile ≡ priceAction.js calcVolumeProfile`, () => {
    assert.deepStrictEqual(vi.volumeProfile, oldVolumeProfile(sc.hist, 750));
  });
}
ok('不传 includeProfile 时 volumeProfile 为 undefined（不膨胀接口载荷）', () => {
  const vi = computeVolumeIndicators(genBase(120), null, null);
  assert.strictEqual(vi.volumeProfile, undefined);
});

console.log('\n===== §3 换手率变化等价 =====');
{
  const series = genTurnoverSeries(60);
  const vi = computeVolumeIndicators(genBase(120), null, series);
  const oldV = oldTurnoverChange(series);
  ok('turnoverChange.ok / signal 与旧实现一致', () => {
    assert.strictEqual(vi.indicators.turnoverChange.ok, oldV.ok);
    assert.strictEqual(vi.indicators.turnoverChange.signal, oldV.signal);
  });
  ok('turnoverChange.detail 口径由「近15日均值」修正为「基准均值」（20261017a 文案对齐）', () => {
    assert.ok(/基准均值/.test(vi.indicators.turnoverChange.detail), vi.indicators.turnoverChange.detail);
    assert.ok(!/近15日均值/.test(vi.indicators.turnoverChange.detail));
  });
  ok('turnoverChange 计算逻辑未被文案修正改变（信号值完全相同）', () => {
    assert.strictEqual(vi.indicators.turnoverChange.signal, oldTurnoverChange(series).signal);
  });
}
ok('换手率序列 <20 日时 ok:false 按中性（与旧实现同文案）', () => {
  const vi = computeVolumeIndicators(genBase(120), null, genTurnoverSeries(10));
  assert.deepStrictEqual(vi.indicators.turnoverChange, { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' });
});
ok('turnoverSeries 传 null 时不抛错，同样按中性处理', () => {
  const vi = computeVolumeIndicators(genBase(120), null, null);
  assert.strictEqual(vi.indicators.turnoverChange.ok, false);
});

console.log('\n===== §4 原有指标未被破坏（回归） =====');
{
  const hist = genBase(200);
  const vi = computeVolumeIndicators(hist, { turnover: 3.2 }, null);
  ok('indicators 仍含 obv/vr/mfi/volMA/volRatio/turnover 等原字段', () => {
    for (const k of ['obv', 'obvTrend', 'vr', 'vrSignal', 'mfi', 'mfiSignal', 'volMA5', 'volMA10', 'volMA20', 'volRatio', 'turnover', 'turnoverLevel', 'turnoverAvg', 'turnoverRatio']) {
      assert.ok(k in vi.indicators, '缺失字段 ' + k);
    }
  });
  ok('volumePrice 主信号仍是当日口径（signal/description/dayVolRatio/heatLevel）', () => {
    for (const k of ['signal', 'description', 'dayChangePct', 'dayVolRatio', 'heatLevel']) {
      assert.ok(k in vi.volumePrice, '缺失字段 ' + k);
    }
  });
  ok('series 仍为最近 60 根', () => {
    assert.strictEqual(vi.series.dates.length, 60);
    assert.strictEqual(vi.series.volumes.length, 60);
  });
  ok('history <20 根仍返回 null（原守门不变）', () => {
    assert.strictEqual(computeVolumeIndicators(genBase(10), null, null), null);
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
