// 测试华安证券 V3.0【指令9】核心逻辑（纯函数 + 公式一致性）
const m = require('../lib/valuation/huaan600909.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

// ---- pickSotpWeights 三档 ----
ok('ratio 0.05 → normal / SOTP 30% / PB 60%', (() => { const w = m.pickSotpWeights(0.05); return w.mode === 'normal' && w.wST === 0.3 && w.wPB === 0.6; })());
ok('ratio 0.20 → elevated / SOTP 40% / PB 50%', (() => { const w = m.pickSotpWeights(0.20); return w.mode === 'elevated' && w.wST === 0.4 && w.wPB === 0.5; })());
ok('ratio 0.35 → shadow / SOTP 50% / PB 40%', (() => { const w = m.pickSotpWeights(0.35); return w.mode === 'shadow' && w.wST === 0.5 && w.wPB === 0.4; })());
ok('边界 0.10 → elevated', (() => { const w = m.pickSotpWeights(0.10); return w.mode === 'elevated' && w.wST === 0.4; })());
ok('边界 0.30 → elevated（非 shadow）', (() => { const w = m.pickSotpWeights(0.30); return w.mode === 'elevated'; })());
ok('边界 0.3001 → shadow', (() => { const w = m.pickSotpWeights(0.3001); return w.mode === 'shadow'; })());

// ---- liquidityDiscount ----
const cfgR = { sotpLayer: { cxmtLockStatus: 'restricted', cxmtLiquidityDiscount: 0.25 } };
const cfgF = { sotpLayer: { cxmtLockStatus: 'free' } };
const cfgU = { sotpLayer: {} };
ok('限售 → 折扣 0.25 / 保留 0.75', (() => { const l = m.liquidityDiscount(cfgR); return Math.abs(l.discount - 0.25) < 1e-9 && Math.abs(l.retain - 0.75) < 1e-9; })());
ok('无限售 → 折扣 0', (() => { const l = m.liquidityDiscount(cfgF); return l.discount === 0 && l.retain === 1; })());
ok('未知 → 折扣 0.30（保守）', (() => { const l = m.liquidityDiscount(cfgU); return Math.abs(l.discount - 0.3) < 1e-9 && Math.abs(l.retain - 0.7) < 1e-9; })());

// ---- pearson ----
ok('完全正相关 → 1', (() => { const r = m.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]); return Math.abs(r - 1) < 1e-9; })());
ok('完全负相关 → -1', (() => { const r = m.pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]); return Math.abs(r + 1) < 1e-9; })());
ok('弱相关 ≈ 0', (() => { const r = m.pearson([1, 2, 3, 4, 5], [1, -1, 1, -1, 1]); return Math.abs(r) < 0.3; })());
ok('样本不足 → null', (() => { return m.pearson([1, 2, 3]) === null; })());

// ---- 持股价值公式 ----
const stake = (mv, pct, disc) => mv * (pct / 100) * (1 - disc);
ok('持股价值 = 35107 × 0.4391% × 0.75 ≈ 115.6亿', Math.abs(stake(35107, 0.4391, 0.25) - 115.6) < 0.5);

// ---- 长鑫总市值推导（fallback 一致性）：2.64亿股 = 0.4391% → 总市值≈35107亿 ----
const derived = 2.64 * 58.39 / (0.4391 / 100);
ok('fallback 长鑫总市值推导 ≈ 35106亿（误差<10亿）', Math.abs(derived - 35106) < 10);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
