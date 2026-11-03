/**
 * 量价判定卡·长期趋势叠加（方案A，20261103a）回归测试
 * 运行： node scripts/test_position_longterm.js
 *
 * 用户报障（2026-11-03 海天味业 603288）：量价判定卡判「震荡整理」，但海天 2023 年以来
 * 长期总体趋势在下跌。根因：旧 _detectPosition 只看 12 个月分位 + MA20/MA60 + 阶段高低点，
 * 没有长期（MA250 年线）维度。方案A 在保持矩阵键 position.label 不变的前提下，叠加系统既有
 * 长期定论（上行/下行/震荡），仅作展示修正。
 *
 * 本测试直接驱动纯函数 _detectPosition（注入合成 longTerm），验证逻辑而不依赖网络。
 */
'use strict';
const ve = require('../lib/volumeEngine');

// 构造 _detectPosition 所需的最小 pc（真实场景 longTerm 由 analyzeVolume 用 2400 根日K 算 MA250 推演得到）
function mkPc(pricePct, ma20, ma60, close, longTerm) {
  return {
    pricePct12m: pricePct,
    drawdownFromHigh: -12.4,
    rallyFromLow: 11.9,
    ma20, ma60, closeToday: close,
    longTerm,
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('\n[1] 震荡整理 + 长期下行 → 叠加「长期下行通道中的区间震荡」，但矩阵键 label 不变');
{
  const lt = { verdict: '下行', ma250: { value: 38.2, slopeState: '下压', slopePct: -2.1, positionPct: -15.3 } };
  const pc = mkPc(0.43, 34.26, 34.66, 34.4, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '震荡整理', `矩阵键 label 保持 '震荡整理'（不变，24 格矩阵不失效）: ${r.label}`);
  ok(r.displayLabel === '长期下行通道中的区间震荡', `展示叠加 displayLabel = '长期下行通道中的区间震荡': ${r.displayLabel}`);
  ok(r.longTermVerdict === '下行', `longTermVerdict = '下行': ${r.longTermVerdict}`);
  ok(/MA250/.test(r.basis) && /下行/.test(r.basis), 'basis 追加年线长期趋势依据');
  ok(r.longTermContext && /下跌中继/.test(r.longTermContext), `longTermContext 含「下跌中继」提示: ${r.longTermContext}`);
}

console.log('\n[2] 震荡整理 + 长期上行 → 叠加「长期上行中的区间震荡（中继整理）」');
{
  const lt = { verdict: '上行', ma250: { value: 40, slopeState: '上翘', slopePct: 1.5, positionPct: 6 } };
  // 横盘：ma20≈ma60 且 close 介于其间（无明确方向）→ 落入「震荡整理」
  const pc = mkPc(0.5, 39, 39.2, 40, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '震荡整理', `label 不变: ${r.label}`);
  ok(r.displayLabel === '长期上行中的区间震荡（中继整理）', `displayLabel 叠加: ${r.displayLabel}`);
  ok(r.longTermContext && /上涨中继/.test(r.longTermContext), `说明：上涨中继: ${r.longTermContext}`);
}

console.log('\n[3] 低位区间 + 长期下行 → 不覆盖 label，仅加说明（非反转底部）');
{
  const lt = { verdict: '下行', ma250: { value: 9.0, slopeState: '下压', slopePct: -1.5, positionPct: -5 } };
  const pc = mkPc(0.2, 10, 10.5, 9.8, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '低位区间', `label 不变: ${r.label}`);
  ok(r.displayLabel === null, 'displayLabel 不覆盖矩阵位置（低位区不叠加）');
  ok(r.longTermContext && /下跌途中/.test(r.longTermContext), `说明：下跌途中的低位震荡: ${r.longTermContext}`);
  ok(/MA250/.test(r.basis), 'basis 仍含年线依据');
}

console.log('\n[4] 上涨中途 + 长期上行 → 方向一致，longTermContext 为 null（不冗余提示）');
{
  const lt = { verdict: '上行', ma250: { value: 50, slopeState: '上翘', slopePct: 1.2, positionPct: 6 } };
  const pc = mkPc(0.6, 50, 48, 52, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '上涨中途', `label 不变: ${r.label}`);
  ok(r.longTermContext === null, '方向一致时 longTermContext 为 null（不冗余提示）');
}

console.log('\n[5] 长期定论缺失 → 完全降级，行为与改动前一致');
{
  const pc = mkPc(0.43, 34.26, 34.66, 34.4, null);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '震荡整理' && r.longTermVerdict === null && r.displayLabel === null && r.longTermContext === null, 'longTerm 缺失时行为与改动前一致（无叠加、无崩溃）');
}

console.log('\n[6] 低位区间 + 长期震荡（中性）→ 不误写为「上行」，给中性说明');
{
  const lt = { verdict: '震荡', ma250: { value: 9.0, slopeState: '走平', slopePct: 0.1, positionPct: -1 } };
  const pc = mkPc(0.2, 10, 10.5, 9.8, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '低位区间', `label 不变: ${r.label}`);
  ok(r.longTermContext && /震荡（无明确方向）/.test(r.longTermContext), `说明为中性（不误写上行）: ${r.longTermContext}`);
  ok(!/上行/.test(r.longTermContext), '上下文不含误导性的「上行」');
}

console.log('\n[7] 高位区间 + 长期震荡（中性）→ 不误写为「下行」，给中性说明');
{
  const lt = { verdict: '震荡', ma250: { value: 50, slopeState: '走平', slopePct: -0.1, positionPct: 1 } };
  const pc = mkPc(0.8, 50, 49, 51, lt);
  const r = ve._detectPosition(pc, null);
  ok(r.label === '高位区间', `label 不变: ${r.label}`);
  ok(r.longTermContext && /震荡（无明确方向）/.test(r.longTermContext), `说明为中性（不误写下行）: ${r.longTermContext}`);
  ok(!/下行/.test(r.longTermContext), '上下文不含误导性的「下行」');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
