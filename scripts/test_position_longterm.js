/**
 * 量价判定·位置标签「新标准三分区」回归守卫（20261106a 定版）
 * 运行： node scripts/test_position_longterm.js
 *
 * 旧四类位置体系（原「上涨中途 / 下跌途中 / 震荡整理」等旧定位）已整体退役：
 *   - position.label 值域 = 高位区间 / 中位区间 / 低位区间，由价格分位唯一决定；
 *   - 趋势段 / 长期年线（MA250）不再改写位置，仅作为审计信息留在 basis / trendSegment；
 *   - 方向语义交由新 135 格的运行状态 _runState（趋势向上 / 趋势向下 / 区间震荡）承担。
 * 原 20261103a「长期趋势叠加展示」与 20261104e「位置判定阶梯」均随旧体系退役，
 * 本守卫改为验证新三分区契约 + 旧体系字段零残留。
 *
 * 直接驱动纯函数 _detectPosition（注入合成 longTerm / trendSeg），零网络。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'volumeEngine.js'), 'utf8');

function mkPc(pricePct, longTerm, extra) {
  return {
    pricePct12m: pricePct,
    drawdownFromHigh: -12.4,
    rallyFromLow: 11.9,
    ma20: 34.26, ma60: 34.66, closeToday: 34.4,
    longTerm: longTerm || null,
    ...(extra || {}),
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const ZONES = ['高位区间', '中位区间', '低位区间'];

console.log('\n===== §1 位置标签只由价格分位决定（三分区） =====');
{
  const lt = { verdict: '下行', ma250: { value: 38.2, slopeState: '下压', slopePct: -2.1, positionPct: -15.3 } };
  const low = ve._detectPosition(mkPc(0.2, lt), null, null);
  const mid = ve._detectPosition(mkPc(0.5, lt), null, null);
  const high = ve._detectPosition(mkPc(0.8, lt), null, null);
  ok(low.label === '低位区间', `分位 20% → 低位区间（实际 ${low.label}）`);
  ok(mid.label === '中位区间', `分位 50% → 中位区间（实际 ${mid.label}）`);
  ok(high.label === '高位区间', `分位 80% → 高位区间（实际 ${high.label}）`);
  ok(ZONES.includes(low.label) && ZONES.includes(mid.label) && ZONES.includes(high.label), 'label 值域严格限于三分区');
  ok(ve._detectPosition(mkPc(0.3, null), null, null).label === '中位区间', '边界 30% 归中位（≤30% 才低位）');
  ok(ve._detectPosition(mkPc(0.7, null), null, null).label === '中位区间', '边界 70% 归中位（≥70% 才高位）');
}

console.log('\n===== §2 趋势段 / 长期年线不改写位置，仅作审计 =====');
{
  const ltDown = { verdict: '下行', ma250: { value: 38.2, slopeState: '下压', slopePct: -2.1, positionPct: -15.3 } };
  const ltUp = { verdict: '上行', ma250: { value: 40, slopeState: '上翘', slopePct: 1.5, positionPct: 6 } };
  const r1 = ve._detectPosition(mkPc(0.43, ltDown), null, null);
  const r2 = ve._detectPosition(mkPc(0.5, ltUp), null, null);
  ok(r1.label === '中位区间', `短期横盘 + 长期下行 → 仍是中位区间（旧体系会定论「下跌途中」）: ${r1.label}`);
  ok(r2.label === '中位区间', `短期横盘 + 长期上行 → 仍是中位区间（旧体系会定论「上涨途中」）: ${r2.label}`);
  ok(/MA250/.test(r1.basis) && /下行/.test(r1.basis), 'basis 保留长期年线「下行」审计依据');
  ok(/MA250/.test(r2.basis) && /上行/.test(r2.basis), 'basis 保留长期年线「上行」审计依据');
  ok(r1.longTermVerdict === '下行' && r2.longTermVerdict === '上行', 'longTermVerdict 原样透出（仅参考）');
  ok(/仅审计/.test(r1.basis), 'basis 明确标注长期信息「仅审计，不改写位置」');
}
{
  const seg = { direction: 'up', reason: '近 120 日自低点 11.56 涨 +26.1%' };
  const r = ve._detectPosition(mkPc(0.43, null), null, seg);
  ok(r.label === '中位区间', `上涨趋势段不再把位置改写成「上涨中途」: ${r.label}`);
  ok(r.trendSegment === seg, 'trendSegment 原样透出供审计');
  ok(/趋势段/.test(r.basis) && /\+26\.1%/.test(r.basis), 'basis 含趋势段审计依据');
}

console.log('\n===== §3 分歧标注与降级 =====');
{
  const lowDiv = ve._detectPosition(mkPc(0.2, null, { drawdownFromHigh: -5, rallyFromLow: 30 }), null, null);
  const highDiv = ve._detectPosition(mkPc(0.8, null, { rallyFromLow: 10 }), null, null);
  ok(lowDiv.label === '低位区间' && /分歧/.test(lowDiv.divergence || ''), '低位但距高点近 → 分歧标注保留');
  ok(highDiv.label === '高位区间' && /分歧/.test(highDiv.divergence || ''), '高位但涨幅不足 → 分歧标注保留');
  const noData = ve._detectPosition(mkPc(null, null), null, null);
  ok(noData.label === '中位区间' && /数据不足/.test(noData.divergence || ''), '分位数据不足 → 中位区间 + 诚实标注');
  const noLt = ve._detectPosition(mkPc(0.43, null), null, null);
  ok(noLt.label === '中位区间' && noLt.longTermVerdict === null, 'longTerm 缺失 → 不崩溃、不臆造方向');
}

console.log('\n===== §4 旧体系字段与源码零残留 =====');
{
  const r = ve._detectPosition(mkPc(0.5, null), null, null);
  ok(r.displayLabel === undefined, 'displayLabel（旧展示叠加）已删除');
  ok(r.longTermContext === undefined, 'longTermContext（旧中继提示）已删除');
  ok(!Object.prototype.hasOwnProperty.call(r, 'trendUp') && !Object.prototype.hasOwnProperty.call(r, 'trendDown'), '旧趋势方向字段 trendUp/trendDown 已删除');
  const fnBody = SRC.slice(SRC.indexOf('function _detectPosition('), SRC.indexOf('function _threeChecks('));
  ok(!/label\s*=\s*'上涨中途'|label\s*=\s*'下跌途中'|label\s*=\s*'震荡整理'/.test(fnBody), '_detectPosition 内无旧四类标签赋值');
  ok(!/displayLabel|longTermContext/.test(fnBody), '_detectPosition 内无旧展示叠加逻辑');
  ok(!SRC.includes('function _tenRules('), '旧量价十口诀主判层 _tenRules 已整块删除');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
