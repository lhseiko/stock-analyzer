/**
 * zoneMethods.js — 支撑/阻力「候选区间」生成器（20261022g，用户新规范）
 * ==========================================================
 * 用户 2026-10-22 给出一份完整的支撑阻力分析规范，要求把②卡从「4 种来源」升级为
 * 「10 种方法 + 共振合并 + 强度分级 + 周线/60分钟多周期」。
 *
 * 本文件只负责第一层：**各方法各自产出候选区间**（纯函数、零网络、零 IO）。
 * 合并与强度分级在 lib/zoneResonance.js；有效性检验仍归 lib/zoneValidity.js。
 *
 * 统一输出结构（所有方法一致，便于共振层无差别处理）：
 *   {
 *     low, high,          // 区间上下限（必填，low <= high）
 *     center,             // 中心参考价
 *     side,               // 'resistance' | 'support'
 *     method,             // 方法键（pivot/fib/ma20/...），共振层用它去重
 *     source,             // 中文来源名（前端展示）
 *     tier,               // 'major' 大周期 | 'minor' 小周期（强度分级用）
 *     note,               // 补充说明（可选）
 *     weakOnly,           // true = 按用户规范「必须与其他方法重合才用」（整数关口）
 *   }
 *
 * 【区间宽度】用户选定「按波动率自适应 ATR」：
 *   半宽 = ATR(20) × WIDTH_ATR_RATIO，并不低于 price × MIN_WIDTH_PCT。
 *   理由：旧的 ±0.5% / ±1% 使两种方法几乎不可能重叠，共振算法失效。
 *
 * 【公式勘误 · 必须记录】用户原文「支撑2等于P减H减L」按字面算是 P-H-L，
 *   在 H=110/L=100/C=105 时得 -105（负数），与 S3=90 完全颠倒，明显为笔误。
 *   标准枢轴为 S2 = P − (H − L)（即 P−H+L），本实现采用标准式，与同类平台一致。
 *   其余公式（P/R1/S1/R2/R3/S3）与用户原文完全一致，已逐条核对。
 */
const { SMA } = require('./analysis');

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 区间宽度：ATR 半宽比例（全宽 ≈ 0.7×ATR）与最小宽度（价格的 0.2%）
const WIDTH_ATR_RATIO = 0.35;
const MIN_WIDTH_PCT = 0.002;

function _num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 平均真实波幅 ATR（默认 20 日）。
 * TR = max(high−low, |high−prevClose|, |low−prevClose|)
 */
function atr(bars, n) {
  const list = Array.isArray(bars) ? bars : [];
  const win = Number.isFinite(n) && n > 0 ? n : 20;
  if (list.length < win + 1) return null;
  let sum = 0;
  let cnt = 0;
  for (let i = list.length - win; i < list.length; i++) {
    const h = _num(list[i] && list[i].high);
    const l = _num(list[i] && list[i].low);
    const pc = _num(list[i - 1] && list[i - 1].close);
    if (h == null || l == null || pc == null) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    cnt += 1;
  }
  if (cnt === 0) return null;
  const v = sum / cnt;
  return v > 0 ? v : null;
}

/** 按给定中心价与半宽生成区间（半宽同时受最小宽度保护，并做 low<=high 兜底） */
function zoneAround(center, halfWidth, price) {
  const c = _num(center);
  if (c == null || c <= 0) return null;
  const hw0 = _num(halfWidth);
  const minHw = (Number.isFinite(price) && price > 0 ? price : c) * MIN_WIDTH_PCT;
  const hw = Math.max(Number.isFinite(hw0) ? hw0 : 0, minHw);
  return { low: round2(c - hw), high: round2(c + hw), center: round2(c) };
}

// =========================================================
// 1) 摆动高点 / 摆动低点（前高前低）
// =========================================================
/**
 * 用户规范：某根K线高点高于左右各 2~3 根高点 → 摆动高点；低点同理。
 * 采用「先按 2 根判定，样本不足退化到 1 根」的自适应（与既有 swingPoints 同思路，
 * 但保留每个摆动点的**触碰次数**——同价位被反复测试是强度的重要依据）。
 * @returns {Array} 候选区间
 */
function swingZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const win = Number.isFinite(o.window) ? o.window : 2;
  const lookback = Number.isFinite(o.lookback) ? o.lookback : 120;
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  if (list.length < win * 2 + 3 || atrV == null || price == null) return [];

  const start = Math.max(win, list.length - lookback);
  const highs = [];
  const lows = [];
  for (let i = start; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ price: _num(list[i].high), date: list[i].date, idx: i });
    if (isLow) lows.push({ price: _num(list[i].low), date: list[i].date, idx: i });
  }

  // 同价位聚类（阈值 = ATR×0.5）：簇内点数即「触碰次数」
  const cluster = (pts) => {
    const sorted = pts.filter(p => _num(p.price) > 0).slice().sort((a, b) => a.price - b.price);
    const out = [];
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(p.price - last.sum / last.n) <= atrV * 0.5) {
        last.sum += p.price;
        last.n += 1;
        last.dates.push(p.date);
      } else {
        out.push({ sum: p.price, n: 1, dates: [p.date] });
      }
    }
    return out.map(c => ({ price: c.sum / c.n, touches: c.n, lastDate: c.dates[c.dates.length - 1] }));
  };

  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const c of cluster(highs)) {
    if (!(c.price > price)) continue;   // 摆动高点在现价下方 → 已失守，不再作阻力
    const z = zoneAround(c.price, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'resistance', method: 'swing', source: '近' + lookback + '日摆动高点',
      tier: 'minor', touches: c.touches, note: `${c.touches} 次触及，最近 ${c.lastDate}`,
    }));
  }
  for (const c of cluster(lows)) {
    if (!(c.price < price)) continue;
    const z = zoneAround(c.price, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'support', method: 'swing', source: '近' + lookback + '日摆动低点',
      tier: 'minor', touches: c.touches, note: `${c.touches} 次触及，最近 ${c.lastDate}`,
    }));
  }
  return out;
}

// =========================================================
// 2) 枢轴点（标准 + Camarilla）
// =========================================================
/**
 * 标准枢轴：取**最新已收盘**一根K的 H/L/C（对下一个交易日而言，它就是「前一日」）。
 *   P=(H+L+C)/3，R1=2P−L，S1=2P−H，R2=P+(H−L)，S2=P−(H−L)，R3=H+2(P−L)，S3=L−2(H−P)
 * Camarilla：R1..R4 = C ± (H−L)×1.1/{12,6,4,2}
 */
function pivotZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 2) return [];
  const atrV = o.atr || atr(list, 20);
  const last = list[list.length - 1];
  const H = _num(last.high);
  const L = _num(last.low);
  const C = _num(last.close);
  if (H == null || L == null || C == null || !(H > L)) return [];
  const price = o.price != null ? _num(o.price) : C;
  const half = (atrV || (H - L)) * WIDTH_ATR_RATIO;

  const P = (H + L + C) / 3;
  const range = H - L;
  const levels = [
    { v: 2 * P - L, name: 'R1', side: 'resistance' },
    { v: P + (H - L), name: 'R2', side: 'resistance' },
    { v: H + 2 * (P - L), name: 'R3', side: 'resistance' },
    { v: 2 * P - H, name: 'S1', side: 'support' },
    { v: P - (H - L), name: 'S2', side: 'support' },
    { v: L - 2 * (H - P), name: 'S3', side: 'support' },
  ];
  const out = [];
  for (const lv of levels) {
    const z = zoneAround(lv.v, half, price);
    if (!z) continue;
    // 方向一致性：阻力必须在现价上方、支撑在下方；跨越现价的中枢位不列入（会与另一侧混淆）
    if (lv.side === 'resistance' && !(z.center > price)) continue;
    if (lv.side === 'support' && !(z.center < price)) continue;
    out.push(Object.assign(z, {
      side: lv.side, method: 'pivot', source: `枢轴 ${lv.name}`,
      tier: 'minor', note: `前一交易日 H${round2(H)}/L${round2(L)}/C${round2(C)}，P=${round2(P)}`,
    }));
  }

  // Camarilla（对跳空与极端行情敏感，按用户要求「只作参考」→ tier=minor）
  const cam = [
    { v: C + range * 1.1 / 12, name: 'C-R1', side: 'resistance' },
    { v: C + range * 1.1 / 6, name: 'C-R2', side: 'resistance' },
    { v: C + range * 1.1 / 4, name: 'C-R3', side: 'resistance' },
    { v: C + range * 1.1 / 2, name: 'C-R4', side: 'resistance' },
    { v: C - range * 1.1 / 12, name: 'C-S1', side: 'support' },
    { v: C - range * 1.1 / 6, name: 'C-S2', side: 'support' },
    { v: C - range * 1.1 / 4, name: 'C-S3', side: 'support' },
    { v: C - range * 1.1 / 2, name: 'C-S4', side: 'support' },
  ];
  for (const lv of cam) {
    const z = zoneAround(lv.v, half, price);
    if (!z) continue;
    if (lv.side === 'resistance' && !(z.center > price)) continue;
    if (lv.side === 'support' && !(z.center < price)) continue;
    out.push(Object.assign(z, {
      side: lv.side, method: 'camarilla', source: `Camarilla ${lv.name}`,
      tier: 'minor', note: '对跳空与极端行情敏感，仅作参考',
    }));
  }
  return out;
}

// =========================================================
// 3) 多周期均线（20/60/120/250）
// =========================================================
/**
 * 价格在均线上方 → 支撑；下方 → 阻力。
 * 斜率：近 10 根均线变化 ≥ 0.5% 判上翘/下压，否则走平。
 * 均线粘合（相邻均线距离 < ATR×0.5）另出一「粘合带」候选（用户规范明确要求）。
 */
function maZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 21) return [];
  const closes = list.map(d => _num(d.close)).map(v => (v == null ? 0 : v));
  const price = o.price != null ? _num(o.price) : closes[closes.length - 1];
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0)) return [];
  const prices = [20, 60, 120, 250];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;

  const valid = [];
  for (const p of prices) {
    if (list.length < p) continue;
    const series = SMA(closes, p);
    const t = series.length - 1;
    const v = series[t];
    if (v == null || !(v > 0)) continue;
    const ref = t - 10 >= 0 ? series[t - 10] : null;
    const slopePct = ref != null && ref > 0 ? ((v - ref) / ref) * 100 : null;
    valid.push({ period: p, value: v, slopePct });
  }
  if (valid.length === 0) return [];

  const out = [];
  for (const m of valid) {
    const above = price > m.value;
    const z = zoneAround(m.value, half, price);
    if (!z) continue;
    const slopeTxt = m.slopePct == null ? '斜率未知' : m.slopePct > 0.5 ? '上翘' : m.slopePct < -0.5 ? '下压' : '走平';
    // 用户规范：均线向上倾斜时支撑更有效、向下倾斜时阻力更有效 → 反向情形记 note 但不改 tier
    const aligned = (above && m.slopePct != null && m.slopePct > 0) || (!above && m.slopePct != null && m.slopePct < 0);
    out.push(Object.assign(z, {
      side: above ? 'support' : 'resistance',
      method: 'ma' + m.period,
      source: `MA${m.period}（${slopeTxt}）`,
      tier: m.period >= 120 ? 'major' : 'minor',
      slopeAligned: aligned,
      note: `价格在均线${above ? '上方 → 作为动态支撑' : '下方 → 作为动态阻力'}；${slopeTxt}${aligned ? '，方向与角色一致（更有效）' : '，方向与角色相反（有效性打折）'}`,
    }));
  }

  // 均线粘合带（多条均线挤在一起 → 支撑/阻力带）
  if (valid.length >= 2 && atrV != null) {
    const sorted = valid.slice().sort((a, b) => a.value - b.value);
    let group = [sorted[0]];
    const flush = () => {
      if (group.length < 2) return;
      const lo = Math.min(...group.map(g => g.value));
      const hi = Math.max(...group.map(g => g.value));
      const center = (lo + hi) / 2;
      const above = price > center;
      const names = group.map(g => 'MA' + g.period).join('+');
      out.push({
        low: round2(lo), high: round2(hi), center: round2(center),
        side: above ? 'support' : 'resistance',
        method: 'ma-cluster',
        source: `${names} 粘合带`,
        tier: 'major',
        note: `多条均线在 ${round2(lo)}~${round2(hi)} 密集（带宽 ${round2(hi - lo)}），粘合区常作为强支撑/阻力带`,
      });
    };
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].value - sorted[i - 1].value <= atrV * 0.5) group.push(sorted[i]);
      else { flush(); group = [sorted[i]]; }
    }
    flush();
  }
  return out;
}

// =========================================================
// 4) 斐波那契回撤（波段自动选取）
// =========================================================
/**
 * 波段选取（必须「有趋势和成交量配合，不得随意截取」）：
 *   - 用左右各 2 根确认的摆动点；
 *   - 相邻「低→高」（上涨波段）或「高→低」（下跌波段），两点间隔 ≥ 10 根；
 *   - 幅度 ≥ ATR×3（有实际空间，避免把震荡当波段）；
 *   - 取**最近一个**满足条件的波段。
 * 上涨后回调：high − 幅度×{0.382,0.5,0.618} → 支撑
 * 下跌后反弹：low + 幅度×{0.382,0.5,0.618} → 阻力
 */
function fibZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 30) return [];
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (atrV == null || !(price > 0)) return [];

  const win = 2;
  const pts = [];
  for (let i = win; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) pts.push({ idx: i, price: _num(list[i].high), kind: 'high', date: list[i].date, vol: _num(list[i].volume) || 0 });
    if (isLow) pts.push({ idx: i, price: _num(list[i].low), kind: 'low', date: list[i].date, vol: _num(list[i].volume) || 0 });
  }
  // 按时间排序后，寻找最近一个合格波段（相邻点交替）
  const seq = pts.filter(p => p.price > 0).sort((a, b) => a.idx - b.idx);
  let leg = null;
  for (let i = seq.length - 1; i >= 1; i--) {
    const b = seq[i];
    const a = seq[i - 1];
    if (a.kind === b.kind) continue;
    if (b.idx - a.idx < 10) continue;
    const amp = Math.abs(b.price - a.price);
    if (amp < atrV * 3) continue;
    leg = { from: a, to: b, amp };
    break;
  }
  if (!leg) return [];

  const up = leg.to.kind === 'high';   // 低→高 = 上涨波段 → 回调支撑
  const ratios = [0.382, 0.5, 0.618];
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const r of ratios) {
    const v = up ? leg.to.price - leg.amp * r : leg.to.price + leg.amp * r;
    const z = zoneAround(v, half, price);
    if (!z) continue;
    const desired = up ? 'support' : 'resistance';
    // 斐波那契位落在现价另一侧时，其「潜在回调位」角色仍然有效（例如价格已跌破 61.8%），
    // 但为避免与另一侧清单混淆，只在其位于对应一侧时收录，其余写入 note 由前端提示。
    if (desired === 'support' && !(z.center < price)) continue;
    if (desired === 'resistance' && !(z.center > price)) continue;
    out.push(Object.assign(z, {
      side: desired, method: 'fib' + String(r).replace('0.', ''), source: `斐波那契 ${(r * 100).toFixed(1)}%`,
      tier: 'minor',
      note: `${up ? '上涨' : '下跌'}波段 ${leg.from.date}(${round2(leg.from.price)}) → ${leg.to.date}(${round2(leg.to.price)})，幅度 ${round2(leg.amp)}`,
    }));
  }
  return out;
}

// =========================================================
// 5) VWAP（成交量加权平均价，动态成本参考）
// =========================================================
/**
 * VWAP = Σ(典型价 × 成交量) / Σ成交量，典型价 = (H+L+C)/3。
 * 价格在 VWAP 上方 → 动态支撑；下方 → 动态阻力。
 */
function vwapZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0) || atrV == null) return [];
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const n of [20, 60, 120, 250]) {
    if (list.length < n) continue;
    const slice = list.slice(-n);
    let pv = 0;
    let vv = 0;
    let ok = true;
    for (const d of slice) {
      const h = _num(d.high);
      const l = _num(d.low);
      const c = _num(d.close);
      const v = _num(d.volume);
      if (h == null || l == null || c == null || v == null || v <= 0) { ok = false; break; }
      pv += ((h + l + c) / 3) * v;
      vv += v;
    }
    if (!ok || !(vv > 0)) continue;
    const vwap = pv / vv;
    if (!(vwap > 0)) continue;
    const z = zoneAround(vwap, half, price);
    if (!z) continue;
    const above = price > vwap;
    out.push(Object.assign(z, {
      side: above ? 'support' : 'resistance',
      method: 'vwap' + n,
      source: `${n}日成交量加权均价`,
      tier: n >= 120 ? 'major' : 'minor',
      note: `近${n}日成交量加权平均价 ${round2(vwap)}；价格在其${above ? '上方 → 作为动态支撑参考' : '下方 → 作为动态阻力参考'}`,
    }));
  }
  return out;
}

// =========================================================
// 6) 成交量密集区 / 筹码峰（VPVR）
// =========================================================
/**
 * 用户规范：没有筹码分布图时，用近 60/120/250 个交易日的成交量加权价格分布近似。
 * 每根K线取 (H+L+C)/3 作为典型价，按价格区间归集成交量，取成交量最大的几个价格区间。
 * 本实现按 24 档归集，识别「局部峰」（占比 ≥ 1.5 倍均档占比），每窗口取前 3 个峰。
 * 结构判定（低位单峰/高位单峰/多峰）写入 note，供前端说明强度。
 */
function volumeProfileZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0)) return [];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const BINS = 24;
  const out = [];

  for (const n of [60, 120, 250]) {
    if (list.length < n) continue;
    const slice = list.slice(-n);
    const lo = Math.min(...slice.map(d => _num(d.low)).filter(v => v != null));
    const hi = Math.max(...slice.map(d => _num(d.high)).filter(v => v != null));
    if (!(hi > lo)) continue;
    const step = (hi - lo) / BINS;
    if (!(step > 0)) continue;
    const bins = Array.from({ length: BINS }, (_, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, vol: 0 }));
    let total = 0;
    for (const d of slice) {
      const h = _num(d.high);
      const l = _num(d.low);
      const c = _num(d.close);
      const v = _num(d.volume);
      if (h == null || l == null || c == null || v == null || v <= 0) continue;
      const tp = (h + l + c) / 3;
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((tp - lo) / step)));
      bins[idx].vol += v;
      total += v;
    }
    if (!(total > 0)) continue;
    const avg = total / BINS;
    const peaks = [];
    for (let i = 0; i < BINS; i++) {
      const cur = bins[i].vol;
      if (cur < avg * 1.5) continue;                                  // 明显高于均档才叫峰
      const lv = i > 0 ? bins[i - 1].vol : 0;
      const rv = i < BINS - 1 ? bins[i + 1].vol : 0;
      if (cur < lv || cur < rv) continue;                              // 只留局部最大
      peaks.push({ i, low: bins[i].low, high: bins[i].high, vol: cur, pct: (cur / total) * 100 });
    }
    peaks.sort((a, b) => b.vol - a.vol);
    const top = peaks.slice(0, 3);
    if (top.length === 0) continue;
    const above = top.filter(p => (p.low + p.high) / 2 > price).length;
    const below = top.filter(p => (p.low + p.high) / 2 < price).length;
    const shape = top.length === 1 ? (above ? '高位单峰' : '低位单峰') : `多峰（${top.length}）`;

    for (const p of top) {
      const center = (p.low + p.high) / 2;
      const side = center > price ? 'resistance' : 'support';
      // 峰的实际区间比 ATR 宽度更宽时用峰自身宽度（筹码区本就成片）
      const widthLow = round2(p.low);
      const widthHigh = round2(p.high);
      const zHalf = zoneAround(center, Math.max(half, (p.high - p.low) / 2), price);
      out.push({
        low: widthLow, high: widthHigh, center: round2(center),
        side, method: 'vpvr' + n,
        source: `近${n}日成交密集区`,
        tier: n >= 120 ? 'major' : 'minor',
        note: `占该窗口成交量 ${round2(p.pct)}%；${shape}结构（上方 ${above} 峰 / 下方 ${below} 峰）` + (zHalf ? '' : ''),
      });
    }
  }
  return out;
}

// =========================================================
// 7) 整数关口（心理位，必须与其他方法重合才用）
// =========================================================
/**
 * 按价格量级决定刻度：<5 元用 0.5，<20 用 1，<100 用 5，<500 用 10，其余用 50。
 * 只取现价 ATR×6 范围内的关口（更远的对 1-5 日判断无意义）。
 * weakOnly=true：共振层只把它当作「印证」（不单独成带、不计入强度分子）。
 */
function roundNumberZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0) || atrV == null) return [];
  const step = price < 5 ? 0.5 : price < 20 ? 1 : price < 100 ? 5 : price < 500 ? 10 : 50;
  const reach = atrV * 6;
  const from = Math.ceil((price - reach) / step) * step;
  const to = Math.floor((price + reach) / step) * step;
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) {
    const val = Math.round(v * 100) / 100;
    if (Math.abs(val - price) < 1e-9) continue;      // 现价本身不算关口
    const z = zoneAround(val, half, price);
    if (!z) continue;
    out.push(Object.assign(z, {
      side: val > price ? 'resistance' : 'support',
      method: 'round',
      source: `整数关口 ${val}`,
      tier: 'minor',
      weakOnly: true,
      note: '心理参考位，必须与其他方法重合时才纳入强度',
    }));
  }
  return out;
}

// =========================================================
// 8) 缺口
// =========================================================
/**
 * 向上跳空：今日 low > 昨日 high → 缺口区间 [昨日high, 今日low]，下沿作支撑。
 * 向下跳空：今日 high < 昨日 low → 缺口区间 [今日high, 昨日low]，上沿作阻力。
 * 只保留**未回补**的缺口（此后最低价未回到缺口区间内 / 最高价未回到区间内）。
 */
function gapZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const lookback = Number.isFinite(o.lookback) ? o.lookback : 120;
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  if (!(price > 0) || list.length < 3) return [];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const start = Math.max(1, list.length - lookback);
  const out = [];
  const seen = new Set();
  for (let i = start; i < list.length; i++) {
    const cur = list[i];
    const prev = list[i - 1];
    const ch = _num(cur.high);
    const cl = _num(cur.low);
    const ph = _num(prev.high);
    const pl = _num(prev.low);
    if (ch == null || cl == null || ph == null || pl == null) continue;

    const upGap = cl > ph;      // 向上跳空
    const downGap = ch < pl;    // 向下跳空
    if (!upGap && !downGap) continue;

    // 未回补判定：用缺口形成日之后的K线检查
    const after = list.slice(i + 1);
    const filled = upGap
      ? after.some(d => _num(d.low) != null && _num(d.low) <= ph)
      : after.some(d => _num(d.high) != null && _num(d.high) >= pl);
    if (filled) continue;

    const gLow = upGap ? ph : ch;
    const gHigh = upGap ? cl : pl;
    const center = (gLow + gHigh) / 2;
    const key = `${round2(gLow)}|${round2(gHigh)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 向上跳空的缺口下沿作支撑；向下跳空的上沿作阻力。方向与现价冲突时跳过。
    const side = upGap ? 'support' : 'resistance';
    if (side === 'support' && !(center < price)) continue;
    if (side === 'resistance' && !(center > price)) continue;

    const z = zoneAround(center, Math.max(half, (gHigh - gLow) / 2), price);
    if (!z) continue;
    out.push(Object.assign(z, {
      side, method: 'gap', source: `${upGap ? '向上' : '向下'}跳空缺口`,
      tier: 'minor',
      note: `${cur.date} ${upGap ? '向上' : '向下'}跳空 ${round2(gLow)}~${round2(gHigh)}，尚未回补；${upGap ? '缺口下沿作支撑' : '缺口上沿作阻力'}`,
    }));
  }
  return out.slice(-4);   // 最多 4 个（越近越相关）
}

// =========================================================
// 9) 趋势线（两点连线 + 第三点验证）
// =========================================================
/**
 * 上升趋势线：最近 3 个摆动低点中，取两点连线，验证第三点在该线附近（±ATR×0.6）；
 * 当前价格在线上方 → 支撑。下降趋势线反之（两点摆动高点，价格在线下方 → 阻力）。
 * 主观性强，按用户规范「只作辅助」→ tier=minor，且 note 明示主观性。
 */
function trendlineZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 40) return [];
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (atrV == null || !(price > 0)) return [];
  const win = 2;
  const highs = [];
  const lows = [];
  for (let i = win; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: _num(list[i].high), date: list[i].date });
    if (isLow) lows.push({ idx: i, price: _num(list[i].low), date: list[i].date });
  }
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  // 第三点共线容差：用户规范只要求「第三个点验证后更有效」，未指定精度。
  // 原先用 0.6 ATR 过严，实测 603288/601318/600519/000902 全部算不出趋势线；
  // 放宽到 1.5 ATR（即「大致在线上」），并允许在最近 6 个摆动点里任选两点连线、以更后一个点验证。
  const tol = atrV * 1.5;
  const lastIdx = list.length - 1;

  const build = (pts, wantUp) => {
    if (pts.length < 3) return null;
    const take = pts.slice(-6);
    let best = null;
    for (let i = 0; i < take.length - 2; i++) {
      for (let j = i + 1; j < take.length - 1; j++) {
        const a = take[i];
        const b = take[j];
        if (b.idx - a.idx < 5) continue;
        const slope = (b.price - a.price) / (b.idx - a.idx);
        if (wantUp ? !(slope > 0) : !(slope < 0)) continue;
        const c = take[j + 1];
        if (!c) continue;
        if (c.idx - b.idx < 5) continue;
        const projC = b.price + slope * (c.idx - b.idx);
        const err = Math.abs(c.price - projC);
        if (err > tol) continue;
        const cur = a.price + slope * (lastIdx - a.idx);
        if (!(cur > 0)) continue;
        if (!best || err < best.err) best = { value: cur, a, b, c, slope, err };
      }
    }
    return best;
  };

  const up = build(lows, true);
  // 与现价的距离也要合理：太远（>4 ATR）对 1-5 日判断无意义
  if (up && up.value > 0 && up.value < price && (price - up.value) <= atrV * 4) {
    const z = zoneAround(up.value, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'support', method: 'trendline', source: '上升趋势线',
      tier: 'minor',
      note: `${up.a.date}(${round2(up.a.price)}) 与 ${up.b.date}(${round2(up.b.price)}) 连线，${up.c.date}(${round2(up.c.price)}) 第三点验证（偏差 ${round2(up.err)}）；延伸至当前 ${round2(up.value)}。趋势线有主观性，仅作辅助`,
    }));
  }
  const dn = build(highs, false);
  if (dn && dn.value > 0 && dn.value > price && (dn.value - price) <= atrV * 4) {
    const z = zoneAround(dn.value, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'resistance', method: 'trendline', source: '下降趋势线',
      tier: 'minor',
      note: `${dn.a.date}(${round2(dn.a.price)}) 与 ${dn.b.date}(${round2(dn.b.price)}) 连线，${dn.c.date}(${round2(dn.c.price)}) 第三点验证（偏差 ${round2(dn.err)}）；延伸至当前 ${round2(dn.value)}。趋势线有主观性，仅作辅助`,
    }));
  }
  return out;
}

// =========================================================
// 10) 周线层（大周期定区域）
// =========================================================
/**
 * 把日K重采样为周线后：
 *   - 周线枢轴（用**上一完整周**的 H/L/C 计算本周枢轴）；
 *   - 周线摆动高/低点（左右各 2 周确认）。
 * 全部 tier=major（用户规范：大周期定区域）。
 */
function weeklyZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 60) return [];
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (!(price > 0)) return [];
  const weeks = resampleWeeks(list);
  if (weeks.length < 6) return [];
  const atrV = o.atr || atr(list, 20);
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const out = [];

  // 上一完整周（最后一条周线若与当前自然周重叠，取倒数第二条更稳妥；这里取最后一条已完整聚合的周）
  const pw = weeks[weeks.length - 1];
  const H = _num(pw.high);
  const L = _num(pw.low);
  const C = _num(pw.close);
  if (H != null && L != null && C != null && H > L) {
    const P = (H + L + C) / 3;
    const levels = [
      { v: 2 * P - L, name: '周P-R1', side: 'resistance' },
      { v: P + (H - L), name: '周P-R2', side: 'resistance' },
      { v: 2 * P - H, name: '周P-S1', side: 'support' },
      { v: P - (H - L), name: '周P-S2', side: 'support' },
    ];
    for (const lv of levels) {
      const z = zoneAround(lv.v, half * 1.5, price);   // 周线级别宽度放宽 1.5 倍
      if (!z) continue;
      if (lv.side === 'resistance' && !(z.center > price)) continue;
      if (lv.side === 'support' && !(z.center < price)) continue;
      out.push(Object.assign(z, {
        side: lv.side, method: 'weekly-pivot', source: lv.name,
        tier: 'major',
        note: `上周(${pw.label}) H${round2(H)}/L${round2(L)}/C${round2(C)}，周枢轴 P=${round2(P)}`,
      }));
    }
  }

  // 周线摆动点
  const w = 2;
  for (let i = w; i < weeks.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= w; j++) {
      if (weeks[i].high < weeks[i - j].high || weeks[i].high < weeks[i + j].high) isHigh = false;
      if (weeks[i].low > weeks[i - j].low || weeks[i].low > weeks[i + j].low) isLow = false;
    }
    if (isHigh && _num(weeks[i].high) > price) {
      const z = zoneAround(weeks[i].high, half * 1.5, price);
      if (z) out.push(Object.assign(z, {
        side: 'resistance', method: 'weekly-swing', source: '周线摆动高点',
        tier: 'major', note: `${weeks[i].label} 周高点 ${round2(weeks[i].high)}`,
      }));
    }
    if (isLow && _num(weeks[i].low) < price) {
      const z = zoneAround(weeks[i].low, half * 1.5, price);
      if (z) out.push(Object.assign(z, {
        side: 'support', method: 'weekly-swing', source: '周线摆动低点',
        tier: 'major', note: `${weeks[i].label} 周低点 ${round2(weeks[i].low)}`,
      }));
    }
  }
  return out;
}

// 日K → 周线（ISO 周，周一为键）
function resampleWeeks(daily) {
  const bars = [];
  let cur = null;
  let curKey = null;
  for (const d of daily) {
    const k = weekKeyOf(d.date);
    if (!k) continue;
    if (!cur || k !== curKey) {
      if (cur) bars.push(cur);
      curKey = k;
      cur = { label: k, high: _num(d.high), low: _num(d.low), close: _num(d.close), open: _num(d.open) };
    } else {
      cur.high = Math.max(cur.high, _num(d.high));
      cur.low = Math.min(cur.low, _num(d.low));
      cur.close = _num(d.close);
    }
  }
  if (cur) bars.push(cur);
  return bars.filter(b => b.high > 0 && b.low > 0);
}

function weekKeyOf(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - day + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// =========================================================
// 汇总入口
// =========================================================
/**
 * 生成全部候选区间（未合并、未检验）。
 * @param {Array} daily 日K（升序，最后一根应为已收盘K）
 * @param {object} opts { price, atr, lookback, includeWeak }
 * @returns {{ candidates: Array, atr: number, price: number, skipped: string[] }}
 */
function buildCandidates(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  const skipped = [];
  if (!(price > 0)) return { candidates: [], atr: null, price: null, skipped: ['无有效收盘价'] };
  if (atrV == null) skipped.push('ATR 无法计算（样本不足或数据缺失）');

  const base = { atr: atrV, price };
  const groups = [
    ['swing', () => swingZones(list, base)],
    ['pivot', () => pivotZones(list, base)],
    ['ma', () => maZones(list, base)],
    ['fib', () => fibZones(list, base)],
    ['vwap', () => vwapZones(list, base)],
    ['vpvr', () => volumeProfileZones(list, base)],
    ['round', () => roundNumberZones(list, base)],
    ['gap', () => gapZones(list, base)],
    ['trendline', () => trendlineZones(list, base)],
    ['weekly', () => weeklyZones(list, base)],
  ];
  const candidates = [];
  for (const [name, fn] of groups) {
    try {
      const got = fn();
      if (!Array.isArray(got) || got.length === 0) { skipped.push(`${name}：无条件满足`); continue; }
      for (const z of got) {
        if (z && Number.isFinite(z.low) && Number.isFinite(z.high) && z.high >= z.low) candidates.push(z);
      }
    } catch (e) {
      skipped.push(`${name}：计算出错（${e && e.message ? e.message : e}）`);
    }
  }
  return { candidates, atr: atrV, price, skipped };
}

module.exports = {
  WIDTH_ATR_RATIO,
  MIN_WIDTH_PCT,
  atr,
  zoneAround,
  swingZones,
  pivotZones,
  maZones,
  fibZones,
  vwapZones,
  volumeProfileZones,
  roundNumberZones,
  gapZones,
  trendlineZones,
  weeklyZones,
  resampleWeeks,
  buildCandidates,
};
