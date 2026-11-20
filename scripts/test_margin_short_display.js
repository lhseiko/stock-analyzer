#!/usr/bin/env node
/**
 * test_margin_short_display.js — 任务卡 #024 专项守卫
 * ================================================================
 * 个股「融资融券」摘要卡补齐融券侧（融资一行 + 融券一行）：
 *   ① 融资行原文逐字不变（20261104d 歧义修复口径）；
 *   ② 融券行 = 融券余额 + 占流通市值比（同分母确定性计算）+ 余额变化 + 趋势；
 *   ③ 方向色语义：融资增=红/减=绿；融券增=绿/减=红（两者相反，不用 moneyTone）；
 *   ④ 融券字段缺失 → 如实显示「融券数据缺失」，不臆造 0；
 *   ⑤ 整卡 tone 仍按融资侧（计票口径零改动）。
 * 静态断言 + 真调用 buildConclusionParts()（防 20261117f 静态漏检类问题）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
const cc = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const { CapitalCharts } = require(path.join(ROOT, 'public/js/capitalCharts.js'));

console.log('\n=== 1) 静态接线 ===');
ok(cc.includes('ve-margin-line') && cc.includes('融券数据缺失'), '融资融券卡含双行 span 与缺失降级文案');
ok(cc.includes('rqBalance / l.rzBalance) * l.rzRatio'), '融券占比 = 融券余额÷融资余额×融资占比（同分母）');
ok(/rqChg > 0 \? 'bear' : rqChg < 0 \? 'bull' : 'neutral'/.test(cc), '融券方向色：增加=利空绿、减少=利好红');
ok(css.includes('.ve-margin-line'), '两行样式已定义');

console.log('\n=== 2) 实跑 buildConclusionParts：融资+融券齐全 ===');
function mkData(margin, extra) {
  return Object.assign({
    volumeIndicators: { volumePrice: { signal: '地量震荡', description: 'test', dayVolRatio: 0.47 } },
    moneyFlow: { summary: { summary: {} } },
    marginTrading: margin,
  }, extra || {});
}
// 基线：601318 实测值缩略（融资 336.85亿 占比5.78% 净买入-1.54亿 融资减少；融券 3.01亿 变化+33.87万）
const mNormal = {
  hasData: true,
  latest: { rzBalance: 33684948957, rzRatio: 5.7810458, rzNetBuy: -153518616, rzChange: -153518617,
    rqBalance: 301081546.26, rqChange: 338707.86, rqVolume: 5508261 },
  trend: '融资减少',
};
let parts, runErr = null;
try { parts = CapitalCharts.buildConclusionParts(mkData(mNormal)); } catch (e) { runErr = e; }
ok(runErr === null, 'buildConclusionParts 实跑不抛错', runErr && runErr.message);
const row = parts && parts.rows.find(r => r.label === '融资融券');
ok(!!row, '输出含「融资融券」行');
if (row) {
  // 融资行原文逐字不变
  ok(row.text.includes('融资余额336.8亿（占流通市值5.78%），净买入-1.54亿，融资减少'),
    '融资行原文逐字不变（含占比紧贴融资余额、净买入）', row.text.slice(0, 120));
  // 融券行：余额 3.01 亿、占比 = 3.01/336.85*5.78 ≈ 0.05%、变化增加0.00亿（33.87万 < 0.01亿 显示为0.00，属正常舍入）
  ok(row.text.includes('融券余额3.01亿'), '融券行显示融券余额', row.text.slice(0, 200));
  ok(row.text.includes('占流通市值'), '融券行显示占流通市值比（同分母计算）');
  ok(row.text.includes('<br>'), '卡内两行（融资/融券以 <br> 分行）');
  ok(row.text.includes('ve-margin-line'), '两行均带 ve-margin-line 样式类');
  // 方向色：融资减少=利空绿（bear）、融券增加=利空绿（bear）
  ok(row.text.includes('ve-tone-bear'), '方向色 class 已应用（融资减少/融券增加均 bear=绿）');
  ok(row.tone === 'bear', '整卡 tone 按融资侧（计票口径零改动）', row.tone);
}

console.log('\n=== 3) 实跑：融券方向语义独立 ===');
// 融券减少 → 利好红（bull），融资增加 → 利好红（bull）
const mRqDown = {
  hasData: true,
  latest: { rzBalance: 1000000000, rzRatio: 3, rzNetBuy: 10000000, rzChange: 10000000,
    rqBalance: 50000000, rqChange: -2000000 },
  trend: '融资增加',
};
const r2 = CapitalCharts.buildConclusionParts(mkData(mRqDown)).rows.find(r => r.label === '融资融券');
ok(!!r2 && r2.text.includes('融券余额0.50亿') && r2.text.includes('减少200万'),
  '融券减少行显示数值与「减少」（小额用万，不显示成 0.00亿）');
ok(!!r2 && /ve-tone-bull">融券余额/.test(r2.text), '融券减少 → 利好红（bull），与融资侧语义相反且独立');
ok(!!r2 && r2.tone === 'bull', '整卡 tone 仍随融资侧（融资增加=红）');

console.log('\n=== 4) 实跑：融券缺失降级 ===');
const mMissing = {
  hasData: true,
  latest: { rzBalance: 1000000000, rzRatio: 3, rzNetBuy: 0, rzChange: 10000000, trend: '融资增加' },
  trend: '融资增加',
};
const r3 = CapitalCharts.buildConclusionParts(mkData(mMissing)).rows.find(r => r.label === '融资融券');
ok(!!r3 && r3.text.includes('融券数据缺失'), '融券字段缺失 → 如实显示「融券数据缺失」');
ok(!!r3 && !/融券余额NaN|融券余额undefined|融券余额0\.00亿/.test(r3.text), '缺失时未臆造 0 / NaN / undefined');

console.log('\n=== 5) 实跑：融券余额为 0 是有效数据 ===');
const mZero = {
  hasData: true,
  latest: { rzBalance: 1000000000, rzRatio: 3, rzNetBuy: 0, rzChange: 0, rqBalance: 0, rqChange: 0 },
  trend: '持平',
};
const r4 = CapitalCharts.buildConclusionParts(mkData(mZero)).rows.find(r => r.label === '融资融券');
ok(!!r4 && r4.text.includes('融券余额0.00亿'), '融券余额 0 → 如实显示 0.00亿（非缺失）');

console.log('\n' + '='.repeat(56));
console.log(`===== 融资融券融券补齐守卫：${pass} 通过 / ${fail} 失败 =====`);
if (fail) process.exit(1);
