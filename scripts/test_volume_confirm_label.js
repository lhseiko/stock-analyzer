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
  ok(app.includes("['60日量能确认', confirmVal]"), '指标值改用 confirmVal（含 60 日口径比值）');
  ok(app.includes('当日量÷60日均量'), 'tooltip 含「当日量÷60日均量」计算口径');
  ok(app.includes('并非缺少 60 日数据'), 'tooltip 明确「并非缺少 60 日数据」');
  ok(app.includes('confirmNote'), '引入 confirmNote 窗口说明');
  ok(app.includes('${confirmNote}'), 'confirmNote 注入渲染模板');
  ok(app.includes('两者口径不同，结论可并存'), '说明「÷5日均量」与「60日均量」是不同窗口');
  ok(app.includes('判为「平量」'), 'null 时明确判为平量');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
