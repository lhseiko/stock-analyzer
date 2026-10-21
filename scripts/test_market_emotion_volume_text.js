/**
 * 市场情绪·量能状态 vs 量价风险文案 自洽性回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_market_emotion_volume_text.js
 * 背景（用户 2026-10-21 报障）：「量能状态是平量，风险提示却写 量价背离（放量下跌或量价齐跌）」
 *
 * 根因：两个口径不同窗口被写成同一句话——
 *   · 量能状态 = **当日**成交量 ÷ 近20日均量 → 平量/放量/缩量
 *   · 量价形态 = **近5日**价格趋势 × **近3日**量能趋势 → 齐升/齐跌/量升价跌/量缩价升
 *   旧风险文案把「放量下跌」与「量价齐跌」并列成一句固定话，于是「今日平量」也会被提示「放量下跌」。
 *
 * 覆盖（20261021f）：
 *   [1] 价跌+量缩 = 量价齐跌，当日平量 → 风险文案只说齐跌，**不得出现"放量"**
 *   [2] 价跌+放量 = 量升价跌 → 风险文案写「近3日放量下跌」
 *   [3] 价升+量缩 = 量缩价升 → 风险文案写「近5日量缩价升」
 *   [4] 价升+量升 = 齐升 → 不产生风险提示（pvRiskText 返回 null）
 *   [5] 降级/缺字段 → 不提示、不崩
 *   [6] 文案不变量：每条都带窗口（近3日/近5日）；非放量形态文案不含"放量"
 *   [7] 接线守卫：模型里不再出现旧固定文案；pvLabel/pvKind 在因子投影白名单与落盘记录里
 */
const m = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/**
 * 造上证日线：closes 数组 + 成交量数组（单位：手，量级 1e8）。
 * computeMarketVolumeMetrics 读 b.vol（不是 b.volume）。
 */
function mkBars(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, close: c, high: c * 1.001, low: c * 0.999, vol: vols[i],
  }));
}
const FLAT = 1e8;
/** 30 根：前 26 根常数，最后 4 根按需变化 */
function scenario(opts) {
  const n = 30;
  const closes = Array.from({ length: n }, () => 3000);
  const vols = Array.from({ length: n }, () => FLAT);
  const { last4Closes, last4Vols } = opts;
  for (let i = 0; i < 4; i++) {
    if (last4Closes[i] != null) closes[n - 4 + i] = last4Closes[i];
    if (last4Vols[i] != null) vols[n - 4 + i] = last4Vols[i];
  }
  return mkBars(closes, vols);
}

console.log('\n[1] 价跌 + 量缩（当日平量）→ 只说「量价齐跌」，不得提"放量"');
{
  // 5 日价格下行 + 近3日量能小于前3日 + 今日量能≈20日均量（平量）
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [1.0 * FLAT, 0.9 * FLAT, 0.6 * FLAT, 1.0 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const va = m.calcVolumeActivity(d);
  const pv = m.calcPriceVolume(d);
  const vp = m.calcVolumePrice(d);

  eq(pv.kind, 'bothFall', '形态 = 量价齐跌');
  ok(pv.score < 0, '量价得分为负');
  eq(va.state, '平量', '当日量比落在平量档（用户截图场景）');
  eq(vp.pvKind, 'bothFall', '合成因子透传 kind');
  eq(vp.volState, '平量', '合成因子透传 量能状态');

  const risk = m.pvRiskText(vp);
  ok(/量价齐跌/.test(risk || ''), '风险文案指向「量价齐跌」');
  ok(!/放量/.test(risk || ''), '风险文案**不含"放量"**（这正是用户报障的矛盾点）');
  ok(/近5日/.test(risk || ''), '文案写明窗口（近5日）');
}

console.log('\n[2] 价跌 + 近3日放量 → 「近3日放量下跌」');
{
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2985],
    last4Vols: [0.8 * FLAT, 0.8 * FLAT, 2.2 * FLAT, 1.0 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolume(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'volUpPriceDown', '形态 = 量升价跌');
  const risk = m.pvRiskText(vp);
  ok(/放量下跌/.test(risk || ''), '文案点明放量下跌');
  ok(/近3日/.test(risk || ''), '文案写明「近3日」窗口（避免与当日量能状态混淆）');
}

console.log('\n[3] 价升 + 量缩 → 「量缩价升（警惕诱多）」');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, 0.6 * FLAT, 0.6 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolume(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'priceUpVolDown', '形态 = 量缩价升');
  ok(pv.score < 0, '量缩价升给负分（动能不足）');
  const risk = m.pvRiskText(vp);
  ok(/量缩价升/.test(risk || ''), '文案指向量缩价升');
  ok(!/放量/.test(risk || ''), '不含"放量"');
}

console.log('\n[4] 价升 + 量升 → 不产生风险提示');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, 1.8 * FLAT, 1.5 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolume(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'bothRise', '形态 = 量价齐升');
  eq(m.pvRiskText(vp), null, '齐升不提示量价风险');
}

console.log('\n[5] 降级 / 缺字段 → 不提示、不崩');
{
  eq(m.pvRiskText(null), null, 'null 入参');
  eq(m.pvRiskText({}), null, '空对象');
  eq(m.pvRiskText({ pvScore: null }), null, '分值缺失');
  eq(m.pvRiskText({ pvScore: 0.5 }), null, '正分不提示');
  const fallback = m.pvRiskText({ pvScore: -0.5, pvKind: null, pvLabel: '量缩价升（动能不足，警惕诱多）' });
  ok(/量缩价升/.test(fallback || ''), 'kind 缺失时用原形态文案兜底，不臆造方向');
  eq(m.calcPriceVolume({ index: { bars: [] } }).degraded, true, '日线不足 → 降级（不抛错）');
}

console.log('\n[6] 文案不变量（防回归）');
{
  const keys = Object.keys(m.PV_RISK_TEXT);
  eq(keys.length, 3, '三种负分形态各一条文案');
  ok(keys.every(k => /近[35]日/.test(m.PV_RISK_TEXT[k])), '每条都写明窗口（近3日/近5日）');
  ok(!/放量/.test(m.PV_RISK_TEXT.bothFall), '「量价齐跌」文案不含"放量"');
  ok(!/放量/.test(m.PV_RISK_TEXT.priceUpVolDown), '「量缩价升」文案不含"放量"');
  ok(/放量/.test(m.PV_RISK_TEXT.volUpPriceDown), '只有「量升价跌」才允许出现"放量"');
}

console.log('\n[7] 接线守卫');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');
  // 只判代码本体：注释里保留旧文案作为「为什么改」的说明是允许的（同 20261020l 教训）
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/量价背离（放量下跌或量价齐跌）/.test(codeOnly), '旧固定文案已从代码中删除（注释除外，不许复活）');
  ok(/const pvRisk = pvRiskText\(vp\)/.test(src), '风险提示改用 pvRiskText(vp) 单源取词');
  ok(/pvLabel: f\.pvLabel/.test(src) && /pvKind: f\.pvKind/.test(src), '因子投影白名单含 pvLabel/pvKind');
  ok(/rec\.pvKind = vp\.pvKind/.test(src), '落盘记录带 pvKind（个股页「市场情绪提醒」可直接引用形态）');
  ok(/PV_RISK_TEXT\[vp\.pvKind\]/.test(src), '文案按形态枚举查表，而非按分值符号猜');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
