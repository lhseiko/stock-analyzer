/**
 * 量能口径一致性回归（20261106n 定版；原名「60日量能确认」文案守卫）
 * 运行： node scripts/test_volume_confirm_label.js
 *
 * 演进史：
 * - 20261024j：confirm=null 不是「缺数据」而是「平量」（0.7~1.5×60日均量中间地带）修复。
 * - 20261106k/l：「60日量能确认」「5日量能比」卡先后退役（展示层）。
 * - 20261106n（用户裁决「60日量能比仅用于放量/缩量判定 → 彻底删除，文字分析统一÷20」）：
 *   60 日口径（avg60/confirm/confirmDesc）从引擎整体退役——审计确认全部消费点均为
 *   放量/缩量判定性质，multi-day 规则基准统一 avg60 → avg20（阈值 ×1.5/×0.7 不变），
 *   放量/缩量判定唯一真值源 = ÷20 日均量三态（放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

function mk(n, lastVol) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1)); d.setUTCDate(d.getUTCDate() + i);
    arr.push({ date: d.toISOString().slice(0, 10), open: 10, high: 10.1, low: 9.9, close: 10, volume: i === n - 1 ? lastVol : 1000 });
  }
  return arr;
}

console.log('\n[1] 20261106n 引擎语义：60 日口径彻底退役，÷20 统一三态为唯一放量/缩量真值源');
{
  const mid = ve._precompute(mk(80, 1000));
  ok(mid.avg60 === undefined, '预计算输出无 avg60 字段（彻底删除，非置 null）');
  ok(mid.confirm === undefined, '预计算输出无 confirm 字段（确认机制整体退役）');
  ok(typeof mid.avg20 === 'number' && mid.avg20 > 0, `avg20 有值（${mid.avg20}）→ ÷20 主基准存在`);
  ok(mid.ratio20 > 0.7 && mid.ratio20 < 1.5, `当日量/20日均量 = ${mid.ratio20.toFixed(2)}×（平量区样本）`);

  const tier = (lastVol) => ve._volumeTier(ve._precompute(mk(80, lastVol))).tier;
  ok(tier(2630) === '放量', '当日量 2.63×20日均量 → tier=放量（>1.3，与 135 格同源）');
  ok(tier(1000) === '平量', '当日量 ≈20日均量 → tier=平量');
  ok(tier(400) === '缩量', '当日量 0.4×20日均量 → tier=缩量（<0.8）');

  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
  ok(!eng.includes('_confirmDesc') && !/pc\.confirm\b/.test(eng), 'volumeEngine 无 _confirmDesc 函数与 pc.confirm 引用（彻底删除）');
}

console.log('\n[2] 前端契约：「60日量能确认」「5日量能比」卡先后退役 + 口径说明披露 60 日整体退役');
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(!app.includes("esc(vs.confirm || '未确认')"), '历史旧写法「vs.confirm || 未确认」零残留');
  ok(!app.includes('>60日量能确认</span>') && !app.includes('const confirmTile'), '「60日量能确认」卡与 tile 变量已整卡退役');
  ok(!app.includes('const vr60') && !app.includes('const confirmVal') && !app.includes('const confirmSub') && !app.includes('const confirmTip'), '60 日展示层死变量（vr60/confirmVal/confirmSub/confirmTip）零残留');
  ok(!app.includes('>5日量能比</span>') && !app.includes('>20日量能比</span>') && !app.includes('const vr20'), '20261106l：「5日量能比」卡退役，「20日量能比」历史临时卡零残留');
  ok(app.includes('ve-cols-3') && !/\$\{volTierTile\}/.test(app), '20261106l：量价统计行改 ve-cols-3 三联，volTierTile 插槽零残留');
  ok(app.includes('60 日均量口径整体退役') && app.includes('全量价判定与文字分析统一使用 20 日量能比'), '20261106n：口径说明披露 60 日口径整体退役、文字分析统一 ÷20');
  ok(!app.includes('const confirmNote') && !app.includes('${confirmNote}'), '独立说明行 confirmNote 仍整体删除');
  ok(app.includes('cm-sub'), '20日涨跌日量能比口径句保留 tile 副行（cm-sub）');
}

console.log('\n[3] 20261106n：四维度量能状态统一 ÷20 文本 + capitalFlow 60 日片段/字段删除');
{
  // 端到端：平量样本 → 四维度量能状态写 ÷20 统一三态（平量），含 ÷5 原始指标披露
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: mk(80, 1000), minutes: null, blacklistReasons: [] });
  ok(r.dimensions.volumeState.includes('÷ 20 日均量') && r.dimensions.volumeState.includes('平量'), `四维度·量能状态统一 ÷20 三态（实际：${r.dimensions.volumeState.slice(0, 60)}…）`);
  ok(!r.dimensions.volumeState.includes('60 日均量口径') && !r.dimensions.volumeState.includes('未确认'), '四维度不再出现 60 日口径片段');
  ok(r.volumeTier.confirm === undefined && r.volumeTier.confirmDesc === undefined, 'volumeTier 无 confirm/confirmDesc 字段');
  ok(r.dimensions.volumeState.includes('数值不应相等'), '÷5 原始指标与 ÷20 口径差异披露（数值不应相等）');
  const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: mk(80, 3000), minutes: null, blacklistReasons: [] });
  ok(r2.dimensions.volumeState.includes('放量'), '放量样本 → 四维度量能状态判「放量」（÷20 统一口径）');

  // 源码接线：capitalFlow 60 日片段与 confirm 字段删除
  const cap = fs.readFileSync(path.join(__dirname, '..', 'lib', 'capitalFlow.js'), 'utf8');
  ok(!cap.includes('confirmDesc') && !cap.includes('60日均量口径：'), 'capitalFlow 无 confirmDesc 引用与 60日均量口径文案');
  ok(!cap.includes('confirm: ut.confirm'), 'capitalFlow unified 对象无 confirm 字段');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
