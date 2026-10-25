/**
 * 市场情绪·量能状态 vs 量价风险文案 自洽性回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_market_emotion_volume_text.js
 * 背景（用户 2026-10-21 报障）：「量能状态是平量，风险提示却写 量价背离（放量下跌或量价齐跌）」
 *
 * 20261023o 改口径：卡片所有口径改为「最新日 + 上证+深证双市」，不再用 5日/3日。
 * 本测试相应改为驱动最新函数 calcVolumeActivityLatest / calcPriceVolumeLatest / calcVolumePrice，
 * 并新增沪深双市合并场景。
 *
 * 核心不变量（与 20261021f 同源）：当日量能状态=平量 时，风险提示不得凭空写"放量"。
 *   最新日模型下，平量 + 价格方向 = score 0（不触发负风险文案），结构性杜绝该矛盾。
 *
 * 覆盖：
 *   [1] 平量 + 下跌 → 不提示风险（核心不变量：平量不会被判"放量"）
 *   [2] 缩量 + 下跌 = 量价齐跌 → 风险文案「最新日量价齐跌…」，不含"放量"
 *   [3] 放量 + 下跌 = 量升价跌 → 风险文案「最新日放量下跌」
 *   [4] 量缩 + 价升 = 量缩价升 → 风险文案「最新日量缩价升（警惕诱多）」
 *   [5] 放量 + 价升 = 量价齐升 → 不产生风险提示（pvRiskText 返回 null）
 *   [6] 降级 / 缺字段 → 不提示、不崩
 *   [7] 沪深双市合并：上证放量涨 + 深证缩量跌 → 沪深分化；单市缺失降级
 *   [8] 文案不变量：每条都带「最新日」窗口；非放量形态不含"放量"
 *   [9] 接线守卫：旧固定文案已删除；pvLabel/pvKind 在投影白名单与落盘记录；按形态枚举查表
 */
const m = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/**
 * 造指数日线：closes 数组 + 成交量数组（单位：手，量级 1e8）。
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

console.log('\n[1] 平量 + 下跌 → 不提示风险（核心不变量：平量不会被提示"放量"）');
{
  // 今日量能≈20日均量（平量），今日收盘 < 昨日（价跌）
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);

  eq(va.state, '平量', '当日量比落在平量档（用户原报障场景）');
  eq(pv.kind, 'flatVolPriceDown', '形态 = 量平价跌（平量 + 价跌）');
  ok(pv.score === 0, '平量 + 价跌 → 量价分 = 0（不触发负风险）');
  eq(vp.score, 0, '合成因子 score = 0');
  eq(m.pvRiskText(vp), null, '平量不提示任何量价风险（无"放量"矛盾）');
  ok(/口径：最新日 · 上证\+深证/.test(vp.detail), 'detail 标明口径：最新日 · 上证+深证');
}

console.log('\n[2] 缩量 + 下跌 = 量价齐跌 → 风险文案「最新日量价齐跌」，且不含"放量"');
{
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, 0.5 * FLAT], // 缩量（<0.7）
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'bothFall', '形态 = 量价齐跌（缩量下跌）');
  ok(pv.score < 0, '量价得分为负');
  const risk = m.pvRiskText(vp);
  ok(/量价齐跌/.test(risk || ''), '风险文案指向「量价齐跌」');
  ok(!/放量/.test(risk || ''), '风险文案**不含"放量"**（这正是用户报障的矛盾点）');
  ok(/最新日/.test(risk || ''), '文案写明窗口（最新日）');
}

console.log('\n[3] 放量 + 下跌 = 量升价跌 → 风险文案「最新日放量下跌」');
{
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2985],
    last4Vols: [FLAT, FLAT, FLAT, 2.2 * FLAT], // 放量（>1.5）
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'volUpPriceDown', '形态 = 量升价跌');
  const risk = m.pvRiskText(vp);
  ok(/放量下跌/.test(risk || ''), '文案点明放量下跌');
  ok(/最新日/.test(risk || ''), '文案写明「最新日」窗口');
}

console.log('\n[4] 量缩 + 价升 = 量缩价升 → 风险文案「最新日量缩价升（警惕诱多）」');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 0.6 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'priceUpVolDown', '形态 = 量缩价升');
  ok(pv.score < 0, '量缩价升给负分（动能不足）');
  const risk = m.pvRiskText(vp);
  ok(/量缩价升/.test(risk || ''), '文案指向量缩价升');
  ok(!/放量/.test(risk || ''), '不含"放量"');
}

console.log('\n[5] 放量 + 价升 = 量价齐升 → 不产生风险提示');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 1.8 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'bothRise', '形态 = 量价齐升');
  eq(m.pvRiskText(vp), null, '齐升不提示量价风险');
}

console.log('\n[6] 降级 / 缺字段 → 不提示、不崩');
{
  eq(m.pvRiskText(null), null, 'null 入参');
  eq(m.pvRiskText({}), null, '空对象');
  eq(m.pvRiskText({ pvScore: null }), null, '分值缺失');
  eq(m.pvRiskText({ pvScore: 0.5 }), null, '正分不提示');
  const fallback = m.pvRiskText({ pvScore: -0.5, pvKind: null, pvLabel: '量缩价升（动能不足，警惕诱多）' });
  ok(/量缩价升/.test(fallback || ''), 'kind 缺失时用原形态文案兜底，不臆造方向');
  eq(m.calcPriceVolumeLatest({ index: { bars: [] } }).degraded, true, '日线不足 → 降级（不抛错）');
}

console.log('\n[7] 沪深双市合并（20261023o 新需求）');
{
  // 上证：放量涨；深证：缩量跌
  const sh = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 1.8 * FLAT],
  });
  const sz = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, 0.5 * FLAT],
  });
  const d = { index: { bars: sh }, indexSZ: { bars: sz }, breadth: null };
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'mixed', '沪深形态相反 → 沪深分化（期望 "mixed"，实际 "' + pv.kind + '"）');
  ok(/上证/.test(vp.value) && /深证/.test(vp.value), 'value 分别列出上证/深证');
  ok(/沪深分化/.test(vp.detail), 'detail 说明沪深分化');
  ok(va.sh && va.sz, '量能活跃度同时拿到两市');

  // 单市缺失 → 仍给出上证结果，深证标缺失
  const d1 = { index: { bars: sh }, indexSZ: null, breadth: null };
  const vp1 = m.calcVolumePrice(d1);
  ok(vp1.score === 1, '仅上证（放量涨）→ 合成满分');
  ok(/深证 缺失/.test(vp1.value), 'value 明示「深证 缺失」');
}

console.log('\n[8] 文案不变量（防回归）');
{
  const keys = Object.keys(m.PV_RISK_TEXT);
  eq(keys.length, 3, '三种负分形态各一条文案');
  ok(keys.every(k => /最新日/.test(m.PV_RISK_TEXT[k])), '每条都写明窗口（最新日）');
  ok(!/放量/.test(m.PV_RISK_TEXT.bothFall), '「量价齐跌」文案不含"放量"');
  ok(!/放量/.test(m.PV_RISK_TEXT.priceUpVolDown), '「量缩价升」文案不含"放量"');
  ok(/放量/.test(m.PV_RISK_TEXT.volUpPriceDown), '只有「量升价跌」才允许出现"放量"');
}

console.log('\n[9] 接线守卫');
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
