/**
 * 「60日量能确认」文案一致性回归（20261024j）
 * 运行： node scripts/test_volume_confirm_label.js
 *
 * 用户报障（2026-10-24 15:52 两张截图）：
 *   指标卡写「60日量能确认：未确认」，但生死位规则 1 明确给出
 *   「60 日均量（927010 手）×1.5 = 1390515 手」——用户认为前后矛盾。
 * 真相：confirm=null 不是「缺数据」，而是「当日量落在 0.7~1.5×60日均量之间」→ 60 日口径为平量。
 * 修复：指标卡改显示「平量/放量/缩量（x.xx×）」，并在 tooltip + 说明里给出均量/当日量/阈值。
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

console.log('\n[1] 引擎语义：confirm 三态（null = 0.7~1.5× 之间，并非缺数据）');
{
  const mid = ve._precompute(mk(80, 1000));
  ok(typeof mid.avg60 === 'number' && mid.avg60 > 0, `avg60 有值（${mid.avg60}）→ 60 日数据存在`);
  ok(typeof mid.volToday === 'number', `volToday 有值（${mid.volToday}）`);
  ok(mid.confirm === null, '当日量≈60日均量（中间地带）→ confirm=null（前端应显示「平量」，不是「未确认」）');
  const r = mid.volToday / mid.avg60;
  ok(r > 0.7 && r < 1.5, `比值 ${r.toFixed(2)}× 落在 0.7~1.5 之间（平量）`);

  ok(ve._precompute(mk(80, 3000)).confirm === '放量', '当日量 3× → confirm=放量');
  ok(ve._precompute(mk(80, 400)).confirm === '缩量', '当日量 0.4× → confirm=缩量');
}

console.log('\n[2] 前端文案：不再硬写「未确认」，改为展示实际比值 + 说明');
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(!app.includes("esc(vs.confirm || '未确认')"), '已移除「vs.confirm || 未确认」的旧写法');
  ok(app.includes('confirmState'), '引入 confirmState（平量/放量/缩量/数据不足）');
  ok(app.includes('60日量能确认') && app.includes('confirmVal'), '「60日量能确认」tile 用 confirmVal 渲染（含 60 日口径比值）');
  ok(app.includes('当日量÷60日均量'), 'tooltip 含「当日量÷60日均量」计算口径');
  ok(app.includes('并非缺少 60 日数据'), 'tooltip 明确「并非缺少 60 日数据」');
  // 20261101i：用户指令——60 日口径数值句并入「60日量能确认」tile 副行，独立说明行整体删除
  ok(!app.includes('const confirmNote') && !app.includes('${confirmNote}'), '独立说明行 confirmNote 已整体删除');
  ok(!app.includes('两者口径不同，结论可并存'), '「另一个窗口/可并存」独立说明文字已删除（说明保留在 tooltip）');
  ok(app.includes('cm-sub'), '60 日口径数值句并入 tile 副行（cm-sub）');
  ok(app.includes('阈值 0.7~1.5×') && app.includes('介于之间为平量'), '中间地带判平量：副行标阈值 0.7~1.5×、tooltip 说明判平量');
  ok(app.includes('放量确认需 >1.5×') && app.includes('缩量确认需 <0.7×'), '确认态（放量/缩量）阈值措辞齐全（tooltip）');
}

console.log('\n[3] 20261101g：后端 60 日口径诚实描述（修「图二写未确认、图一却有 60 日数据」矛盾）');
{
  // 用户 2026-11-01 士兰微 600460 报障：四维度·量能状态写「60 日均量口径未确认」，
  // 同卡 60 日均量注释却给出 1.34 倍（均量 868586 / 当日量 1163319）——confirm=null
  // 是中间地带判「平量」，不是缺数据。引擎层 _confirmDesc 单一真值源修复。
  ok(ve._confirmDesc({ avg60: 868586, volToday: 1163319 }).includes('判「平量」'), '士兰微实测口径 1.34× → 判「平量」');
  ok(ve._confirmDesc({ avg60: 868586, volToday: 1163319 }).includes('1.34'), '文案含实际比值 1.34 倍');
  ok(ve._confirmDesc({ avg60: 1000, volToday: 1800 }).includes('确认为「放量」'), '>×1.5 → 确认为「放量」');
  ok(ve._confirmDesc({ avg60: 1000, volToday: 500 }).includes('确认为「缩量」'), '<×0.7 → 确认为「缩量」');
  ok(ve._confirmDesc({ avg60: 0, volToday: 1000 }).includes('数据不足') && ve._confirmDesc({ avg60: null, volToday: null }).includes('数据不足'), '真缺 60 日数据 → 才写「数据不足」');

  // 端到端：中间地带 → 四维度·量能状态判「平量」且不出现「未确认」
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: mk(80, 1000), minutes: null, blacklistReasons: [] });
  ok(r.dimensions.volumeState.includes('判「平量」'), `四维度·量能状态判「平量」（实际：${r.dimensions.volumeState.slice(20, 90)}…）`);
  ok(!r.dimensions.volumeState.includes('未确认'), '中间地带四维度不再出现「未确认」');
  ok(r.volumeTier.confirmDesc && r.volumeTier.confirmDesc.includes('判「平量」'), 'volumeTier.confirmDesc 单一真值源输出（capitalFlow 同源引用）');
  const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: mk(80, 3000), minutes: null, blacklistReasons: [] });
  ok(r2.dimensions.volumeState.includes('确认为「放量」'), 'confirm=放量 → 文案「确认为「放量」」（确认态措辞不变）');

  // 源码接线：四处旧写法全部替换；capitalFlow 改引 confirmDesc
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
  ok(!/pc\.confirm \|\| '未确认'/.test(eng), 'volumeEngine 内「pc.confirm || 未确认」旧写法已全部移除');
  ok(eng.includes('confirmDesc: _confirmDesc(pc)'), 'volumeTier 挂 confirmDesc（单一真值源）');
  const cap = fs.readFileSync(path.join(__dirname, '..', 'lib', 'capitalFlow.js'), 'utf8');
  ok(cap.includes('ut.confirmDesc || (ut.confirm || '), 'capitalFlow 资金行为文案改引 confirmDesc（无 ut 时回退原口径）');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
