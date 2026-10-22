/**
 * 支撑/阻力 10 种方法 + 共振合并 回归（20261022g）
 * --------------------------------------------------------------
 * 运行： node scripts/test_zone_resonance.js
 * 覆盖 lib/zoneMethods.js 与 lib/zoneResonance.js：
 *   [1] ATR 计算 / zoneAround 最小宽度保护
 *   [2] 标准枢轴 7 条公式（逐值核对，含用户原文「S2=P−H−L」笔误的标准式修正）
 *   [3] Camarilla 4 组
 *   [4] 多周期均线：位置 → 支撑/阻力、斜率标注、粘合带
 *   [5] 斐波那契：波段选取 + 38.2/50/61.8 回调位
 *   [6] VWAP 加权正确
 *   [7] 成交量密集区（VPVR）峰识别与结构标注
 *   [8] 整数关口：刻度选择、weakOnly 标记
 *   [9] 缺口：向上/向下识别 + 已回补过滤
 *   [10] 摆动点：触碰次数统计
 *   [11] 周线层：重采样 + 周枢轴
 *   [12] 共振聚类：锚定簇首不链式漂移
 *   [13] 重叠消解：阻力（升序）/支撑（降序）两方向都不得产生 low>high
 *   [14] 强度分级：强/中/弱 三档判定
 *   [15] 60 分钟确认
 *   [16] 端到端：无重叠、排序符合下游约定、每带字段完整
 *   [17] 整数关口单独成簇必须被丢弃
 */
const zm = require('../lib/zoneMethods');
const zr = require('../lib/zoneResonance');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}（期望≈${b}，实际 ${a}，容差 ${tol}）`);

function dstr(i) {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
const bar = (i, o, h, l, c, v) => ({ date: dstr(i), open: o, high: h, low: l, close: c, volume: v });

// 一个 320 根的确定性序列：先涨后跌再震荡，带跳空与平台
function mkSeries() {
  const out = [];
  let px = 10;
  for (let i = 0; i < 320; i++) {
    let drift;
    if (i < 100) drift = 0.05;          // 上涨
    else if (i < 200) drift = -0.03;    // 下跌
    else drift = 0.002;                 // 震荡
    const prev = px;
    px = Math.max(1, px + drift);
    const hi = Math.max(prev, px) + 0.08;
    const lo = Math.min(prev, px) - 0.08;
    out.push(bar(i, prev, hi, lo, px, 1000 + (i % 7) * 100));
  }
  return out;
}
const series = mkSeries();
const price = series[series.length - 1].close;

console.log('\n[1] ATR 与区间宽度');
{
  const a = zm.atr(series, 20);
  ok(a > 0, 'ATR 为正数: ' + a.toFixed(4));
  const a2 = zm.atr(series, 20);
  eq(a, a2, 'ATR 可复现（无隐藏状态）');
  const one = zm.atr([series[0]], 20);
  eq(one, null, '样本不足 → ATR 返回 null（不臆造）');

  const z1 = zm.zoneAround(100, 0.5, 100);
  ok(z1.low < z1.high, '正常中心价 → 生成区间');
  near(z1.center, 100, 0.01, 'center 保留中心价');

  const z2 = zm.zoneAround(10, 0, 10);   // 半宽 0 → 最小宽度兜底（10×0.2% = 0.02）
  ok(z2.high - z2.low >= 0.039, '半宽为 0 时按最小宽度兜底，不退化为单点: ' + JSON.stringify(z2));
  eq(zm.zoneAround(null, 1, 100), null, '中心价缺失 → null');
}

console.log('\n[2] 标准枢轴 7 条公式');
{
  // 构造 H=110 / L=100 / C=105
  const bars = [bar(0, 100, 101, 99, 100, 1000), bar(1, 105, 110, 100, 105, 1200)];
  const got = zm.pivotZones(bars, { price: 105, atr: 2 });
  const byName = {};
  for (const z of got) byName[z.source] = z;
  const P = 105;
  eq(byName['枢轴 R1'] && byName['枢轴 R1'].center, 2 * P - 100, 'R1 = 2P−L = 110');
  eq(byName['枢轴 R2'] && byName['枢轴 R2'].center, P + (110 - 100), 'R2 = P+(H−L) = 115');
  eq(byName['枢轴 R3'] && byName['枢轴 R3'].center, 110 + 2 * (P - 100), 'R3 = H+2(P−L) = 120');
  eq(byName['枢轴 S1'] && byName['枢轴 S1'].center, 2 * P - 110, 'S1 = 2P−H = 100');
  eq(byName['枢轴 S2'] && byName['枢轴 S2'].center, P - (110 - 100), 'S2 = P−(H−L) = 95（用户原文「P−H−L」为笔误，按标准式）');
  eq(byName['枢轴 S3'] && byName['枢轴 S3'].center, 100 - 2 * (110 - P), 'S3 = L−2(H−P) = 90');
  ok(!byName['枢轴 S2'] || byName['枢轴 S2'].center > 0, 'S2 不得为负数（笔误写法会得 −105）');
  // 方向一致性：阻力全在现价上方、支撑全在下方
  for (const z of got) {
    if (z.source.indexOf('枢轴 R') === 0) ok(z.center > 105, `${z.source} 位于现价上方`);
    if (z.source.indexOf('枢轴 S') === 0) ok(z.center < 105, `${z.source} 位于现价下方`);
  }
}

console.log('\n[3] Camarilla');
{
  const bars = [bar(0, 100, 101, 99, 100, 1000), bar(1, 105, 110, 100, 105, 1200)];
  const got = zm.pivotZones(bars, { price: 105, atr: 2 }).filter(z => z.method === 'camarilla');
  ok(got.length >= 4, 'Camarilla 至少输出 4 条: ' + got.length);
  const r1 = got.find(z => z.source === 'Camarilla C-R1');
  if (r1) near(r1.center, 105 + 10 * 1.1 / 12, 0.02, 'C-R1 = C+(H−L)×1.1/12');
  const s4 = got.find(z => z.source === 'Camarilla C-S4');
  if (s4) near(s4.center, 105 - 10 * 1.1 / 2, 0.02, 'C-S4 = C−(H−L)×1.1/2');
  ok(got.every(z => z.note.indexOf('参考') >= 0), '每条都标注「仅作参考」');
}

console.log('\n[4] 多周期均线');
{
  const got = zm.maZones(series, { price });
  const periods = new Set(got.filter(z => /^ma\d/.test(z.method)).map(z => z.method));
  ok(periods.has('ma20'), '含 MA20');
  ok(periods.has('ma60'), '含 MA60');
  ok(periods.has('ma120') || series.length < 120, '含 MA120（样本不足则跳过）');
  for (const z of got) {
    if (!/^ma\d/.test(z.method)) continue;
    const above = price > z.center;
    eq(z.side, above ? 'support' : 'resistance', `${z.source} 位置判定与 side 一致`);
    ok(typeof z.slopeAligned === 'boolean', `${z.source} 标注了斜率是否与角色一致`);
  }
}

console.log('\n[5] 斐波那契');
{
  const got = zm.fibZones(series, { price });
  for (const z of got) {
    ok(/斐波那契 (38\.2|50\.0|61\.8)%/.test(z.source), '比例属 38.2/50/61.8: ' + z.source);
    ok(z.note.indexOf('波段') >= 0, '注明所选波段');
  }
  ok(got.length === 0 || got.every(z => (z.side === 'support' ? z.center < price : z.center > price)),
    '斐波那契位落在现价对应一侧');
}

console.log('\n[6] VWAP');
{
  const got = zm.vwapZones(series, { price });
  ok(got.length > 0, '至少输出 1 个 VWAP 位');
  const z20 = got.find(z => z.method === 'vwap20');
  if (z20) {
    // 手工重算 20 日 VWAP
    const s = series.slice(-20);
    let pv = 0, vv = 0;
    for (const d of s) { pv += ((d.high + d.low + d.close) / 3) * d.volume; vv += d.volume; }
    near(z20.center, pv / vv, 0.02, '20 日 VWAP 与手算一致');
  }
}

console.log('\n[7] 成交量密集区（VPVR）');
{
  const got = zm.volumeProfileZones(series, { price });
  ok(got.length > 0, '至少输出 1 个密集区');
  ok(got.every(z => z.low <= z.high), '密集区 low <= high');
  ok(got.every(z => z.note.indexOf('占该窗口成交量') >= 0), '注明成交量占比');
  ok(got.some(z => /单峰|多峰/.test(z.note)), '注明单峰/多峰结构');
}

console.log('\n[8] 整数关口');
{
  const got = zm.roundNumberZones([], { price: 33.47, atr: 0.7 });
  ok(got.length > 0, '输出附近整数关口');
  ok(got.every(z => z.weakOnly === true), '全部标记 weakOnly（必须与其他方法重合才用）');
  ok(got.every(z => z.source.indexOf('整数关口') === 0), '来源名正确');
  // 价格 <5 元用 0.5 刻度
  const small = zm.roundNumberZones([], { price: 3.2, atr: 0.1 });
  ok(small.every(z => Math.abs((z.center * 10) % 5) < 1e-6), '低价股按 0.5 刻度取关口');
}

console.log('\n[9] 缺口');
{
  // 第 1 根 100~101，第 2 根直接 105~106 开盘（向上跳空），之后未回补
  const g = [
    bar(0, 100, 101, 99, 100, 1000),
    bar(1, 105, 108, 105, 107, 1200),
    bar(2, 107, 109, 106, 108, 1100),
  ];
  const up = zm.gapZones(g, { price: 108, atr: 1 });
  ok(up.some(z => z.side === 'support' && z.note.indexOf('向上跳空') >= 0), '识别向上跳空 → 作支撑');

  // 回补后应被过滤
  const filled = [
    bar(0, 100, 101, 99, 100, 1000),
    bar(1, 105, 108, 105, 107, 1200),
    bar(2, 107, 107, 100, 101, 1100),   // 回补到 100 < 101
  ];
  const f = zm.gapZones(filled, { price: 101, atr: 1 });
  ok(!f.some(z => z.note.indexOf('向上跳空') >= 0), '已回补的缺口被过滤');

  const down = [
    bar(0, 100, 101, 99, 100, 1000),
    bar(1, 94, 95, 92, 93, 1200),
    bar(2, 93, 94, 91, 92, 1100),
  ];
  const dn = zm.gapZones(down, { price: 92, atr: 1 });
  ok(dn.some(z => z.side === 'resistance' && z.note.indexOf('向下跳空') >= 0), '识别向下跳空 → 作阻力');
}

console.log('\n[10] 摆动点触碰次数');
{
  // 构造在 12.0 附近反复出现的摆动低点
  const bars = [];
  for (let i = 0; i < 80; i++) {
    const base = 12 + (i % 8 === 0 ? -0.5 : 0.3);
    bars.push(bar(i, base, base + 0.3, base - 0.3, base + 0.1, 1000));
  }
  for (let i = 80; i < 100; i++) bars.push(bar(i, 13, 13.2, 12.9, 13.1, 1000));
  const got = zm.swingZones(bars, { price: 13.1, atr: 0.4 });
  ok(Array.isArray(got), 'swingZones 返回数组');
  ok(got.every(z => Number.isFinite(z.touches) && z.touches >= 1), '每个摆动点带触碰次数');
}

console.log('\n[11] 周线层');
{
  const weeks = zm.resampleWeeks(series);
  ok(weeks.length > 0, '周线重采样非空: ' + weeks.length + ' 根');
  ok(weeks.every(w => w.high >= w.low), '周线 high >= low');
  ok(weeks.every(w => /^\d{4}-\d{2}-\d{2}$/.test(w.label)), '周键为周一日期');
  const wz = zm.weeklyZones(series, { price });
  ok(wz.length > 0, '周线层产出候选: ' + wz.length);
  ok(wz.every(z => z.tier === 'major'), '周线层全部 tier=major');
}

console.log('\n[12] 共振聚类：锚定簇首');
{
  const cands = [
    { low: 9.9, high: 10.1, center: 10, side: 'resistance', method: 'a', tier: 'minor', source: 'A' },
    { low: 10.2, high: 10.4, center: 10.3, side: 'resistance', method: 'b', tier: 'minor', source: 'B' },
    { low: 10.4, high: 10.6, center: 10.5, side: 'resistance', method: 'c', tier: 'minor', source: 'C' },
    { low: 10.6, high: 10.8, center: 10.7, side: 'resistance', method: 'd', tier: 'minor', source: 'D' },
  ];
  // atr=0.3 → 容差 0.315；10 与 10.7 相差 0.7 > 0.315 → 必须分簇（不得链式漂移）
  const cl = zr.clusterSide(cands, 0.3, 9);
  ok(cl.length >= 2, '相邻 0.2 的链不得被锚定规则吞成一簇: 实际 ' + cl.length + ' 簇');
  ok(cl[0].anchorCenter === 10, '首簇锚定第一个成员中心');
}

console.log('\n[13] 重叠消解（两方向）');
{
  const mk = (side, specs) => specs.map((s, i) => ({
    low: s[0], high: s[1], center: (s[0] + s[1]) / 2, side,
    method: 'm' + i, tier: i === 0 ? 'major' : 'minor', source: 'S' + i,
  }));
  // 阻力：现价 5，两簇都在上方且重叠
  const rCands = mk('resistance', [[10, 10.6], [10.4, 11.0]]);
  const r = zr.mergeResonance(rCands, { daily: [], h60: [], atr: 0.6, price: 5 });
  const rb = r.resistanceBands;
  ok(rb.length >= 1, '阻力带非空');
  for (let i = 0; i < rb.length - 1; i++) {
    ok(rb[i].high <= rb[i + 1].low + 1e-9, `阻力带 ${i} 与 ${i + 1} 不重叠（${rb[i].high} <= ${rb[i + 1].low}）`);
  }
  ok(rb.every(b => b.low <= b.high), '阻力带 low <= high');
  ok(rb.every(b => b.low > 5), '阻力带全部在现价上方');

  // 支撑：现价 20，两簇都在下方且重叠
  const sCands = mk('support', [[10, 10.6], [10.4, 11.0]]);
  const s = zr.mergeResonance(sCands, { daily: [], h60: [], atr: 0.6, price: 20 });
  const sb = s.supportBands;
  ok(sb.length >= 1, '支撑带非空');
  for (let i = 0; i < sb.length - 1; i++) {
    ok(sb[i].low >= sb[i + 1].high - 1e-9, `支撑带 ${i} 与 ${i + 1} 不重叠（${sb[i].low} >= ${sb[i + 1].high}）`);
  }
  ok(sb.every(b => b.low <= b.high), '支撑带 low <= high（曾因方向写死出现 low>high）');
  ok(sb.every(b => b.high < 20), '支撑带全部在现价下方');
}

console.log('\n[14] 强度分级');
{
  eq(zr.grade({ methodCount: 1, majorCount: 1, touches: 0, volConfirmed: false, shrinkConfirmed: false, hourlyConfirmed: false }).strength, '弱', '单一方法 → 弱');
  eq(zr.grade({ methodCount: 2, majorCount: 1, touches: 1, volConfirmed: false, shrinkConfirmed: false, hourlyConfirmed: false }).strength, '中', '两方法重合但大周期不足 → 中');
  eq(zr.grade({ methodCount: 3, majorCount: 2, touches: 2, volConfirmed: true, shrinkConfirmed: false, hourlyConfirmed: false }).strength, '强', '≥2 大周期 + 放量确认 → 强');
  eq(zr.grade({ methodCount: 3, majorCount: 2, touches: 2, volConfirmed: false, shrinkConfirmed: false, hourlyConfirmed: false }).strength, '中', '≥2 大周期但无量能/收盘确认 → 中（不虚报强）');
  eq(zr.grade({ methodCount: 3, majorCount: 2, touches: 1, volConfirmed: false, shrinkConfirmed: false, hourlyConfirmed: true }).strength, '强', '≥2 大周期 + 60分钟确认 → 强');
  ok(zr.grade({ methodCount: 1, majorCount: 1, touches: 0, volConfirmed: false, shrinkConfirmed: false, hourlyConfirmed: false }).reasons.includes('单一方法'), '弱档给出原因');
}

console.log('\n[15] 60 分钟确认');
{
  const mk60 = (closes) => closes.map((c, i) => ({
    date: `2026-10-${String(1 + Math.floor(i / 4)).padStart(2, '0')} 10:30`, open: c, high: c + 0.1, low: c - 0.1, close: c, volume: 100,
  }));
  const band = { low: 10, high: 11 };
  // 代码要求 ≥10 根才判定（样本不足不臆断），因此给 12 根
  const good = zr.hourlyConfirm(mk60([10.5, 10.6, 10.4, 10.7, 10.5, 10.6, 10.5, 10.4, 10.6, 10.5, 10.7, 10.5]), band, 'support', 0.5);
  ok(good.confirmed, '进入带内且未穿破 → 确认');
  const bad = zr.hourlyConfirm(mk60([10.5, 10.5, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0]), band, 'support', 0.5);
  ok(!bad.confirmed, '收盘穿破带沿+缓冲 → 不确认');
  const few = zr.hourlyConfirm(mk60([10.5, 10.5, 10.5]), band, 'support', 0.5);
  ok(!few.confirmed, '样本不足 10 根 → 不确认（不臆断）');
  const none = zr.hourlyConfirm([], band, 'support', 0.5);
  ok(!none.confirmed, '无 60 分钟数据 → 不确认（不臆断）');
}

console.log('\n[16] 端到端：无重叠 + 排序 + 字段完整');
{
  const built = zm.buildCandidates(series, { price });
  ok(built.candidates.length > 0, '候选非空: ' + built.candidates.length);
  ok(built.skipped.length >= 0, 'skipped 为数组');
  const res = zr.mergeResonance(built.candidates, { daily: series, h60: [], atr: built.atr, price });
  ok(res.resistanceBands.length > 0, '阻力带非空');
  ok(res.supportBands.length > 0, '支撑带非空');
  ok(res.resistanceBands.length <= zr.MAX_PER_SIDE, '阻力带不超过上限 ' + zr.MAX_PER_SIDE);
  ok(res.supportBands.length <= zr.MAX_PER_SIDE, '支撑带不超过上限 ' + zr.MAX_PER_SIDE);

  // 排序：阻力 low 升序、支撑 low 降序（下游④卡与量能规则4 依赖）
  let rOk = true;
  for (let i = 0; i < res.resistanceBands.length - 1; i++) {
    if (res.resistanceBands[i].low > res.resistanceBands[i + 1].low) rOk = false;
  }
  ok(rOk, '阻力带按 low 升序（下游取 [0] 作为最近阻力）');
  let sOk = true;
  for (let i = 0; i < res.supportBands.length - 1; i++) {
    if (res.supportBands[i].low < res.supportBands[i + 1].low) sOk = false;
  }
  ok(sOk, '支撑带按 low 降序（下游取 [0] 作为最近支撑）');

  // 每带字段完整（用户规范第五部分要求的输出要素）
  const need = ['low', 'high', 'center', 'source', 'strength', 'sources', 'confirmSignals', 'invalidationLevel', 'invalidationText', 'methodCount', 'touches'];
  for (const b of res.resistanceBands.concat(res.supportBands)) {
    const missing = need.filter(k => !(k in b));
    if (missing.length) { ok(false, `带 ${b.low}~${b.high} 缺字段: ${missing.join(',')}`); break; }
  }
  const allBands = res.resistanceBands.concat(res.supportBands);
  ok(allBands.every(b => need.every(k => k in b)), '每带含「下限/上限/中心/来源/强度/确认信号/失效位」');
  ok(allBands.every(b => ['强', '中', '弱'].includes(b.strength)), '强度只取 强/中/弱 三档');
  ok(allBands.every(b => Array.isArray(b.confirmSignals) && b.confirmSignals.length > 0), '每带都有确认信号说明');
  ok(allBands.every(b => Number.isFinite(b.invalidationLevel)), '每带都有数值失效位');
  ok(allBands.every(b => b.invalidationText.indexOf('放量收盘') >= 0), '失效条件明确写「放量收盘」');
}

console.log('\n[17] 整数关口单独成簇必须丢弃');
{
  const cands = [
    { low: 99.9, high: 100.1, center: 100, side: 'resistance', method: 'round', tier: 'minor', source: '整数关口 100', weakOnly: true },
  ];
  const r = zr.mergeResonance(cands, { daily: [], h60: [], atr: 0.5, price: 90 });
  eq(r.resistanceBands.length, 0, '只有整数关口、无其他方法印证 → 不成带');
  eq(r.stats.droppedWeakOnly, 1, '统计中记录被丢弃的 weakOnly 数量');

  // 有普通方法在同位置 → 收入并保留来源
  const withPeer = cands.concat([
    { low: 99.8, high: 100.2, center: 100, side: 'resistance', method: 'swing', tier: 'minor', source: '摆动高点' },
  ]);
  const r2 = zr.mergeResonance(withPeer, { daily: [], h60: [], atr: 0.5, price: 90 });
  ok(r2.resistanceBands.length >= 1, '有其他方法印证 → 成带');
  ok(r2.resistanceBands.some(b => b.sources.some(s => s.weakOnly)), '整数关口作为「印证来源」保留在 sources 中');
}

console.log('\n[18] buildCandidates 容错');
{
  const empty = zm.buildCandidates([], {});
  ok(Array.isArray(empty.candidates) && empty.candidates.length === 0, '空数据 → 空候选且不抛');
  ok(empty.skipped.length > 0, '空数据 → 说明原因');
  const dirty = [bar(0, 10, 10, 10, 10, 0), { date: '2025-01-02' }];
  let threw = false;
  try { zm.buildCandidates(dirty, {}); } catch (e) { threw = true; }
  ok(!threw, '脏数据不抛异常');
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
