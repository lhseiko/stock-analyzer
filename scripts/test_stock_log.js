// test_stock_log.js — 个股记录 lib/stockLog.js 单元测试（20261025l）
// 覆盖：添加/列表/删除全流程、日期倒序排序、校验（日期格式/空内容/超长）、
//       个股文件隔离、损坏文件按空处理、上限保护。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'stock-log');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const stockLog = require('../lib/stockLog');

// 清场：只用测试专用 symbol，避免污染真实个股记录
const A = 'sh000test', B = 'sz600test';
for (const s of [A, B]) {
  const f = path.join(DIR, s.replace(/^(sh|sz)/, '') + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log('\n===== §1 添加与列表 =====');
let r = stockLog.addLog(A, { date: '2026-10-25', text: '大股东公告减持 2%' });
ok('正常添加', r.ok && r.item && r.item.id, r);
r = stockLog.addLog(A, { date: '2026-10-20', text: '监管问询函' });
ok('第二条添加', r.ok, r);
r = stockLog.addLog(A, { date: '2026-10-25', text: '同日第二条（更晚创建）' });
const lateId = r.item && r.item.id;
let l = stockLog.listLog(A);
ok('列表 3 条', l.items.length === 3, l.items.length);
ok('按日期倒序：2026-10-25 在前', l.items[0].date === '2026-10-25' && l.items[1].date === '2026-10-25' && l.items[2].date === '2026-10-20', l.items.map(x => x.date));
ok('同日按创建时间倒序（新的在前）', l.items[0].id === lateId, l.items[0].id);

console.log('\n===== §2 校验 =====');
ok('空内容拒绝', stockLog.addLog(A, { date: '2026-10-25', text: '  ' }).ok === false);
ok('日期格式错误拒绝', stockLog.addLog(A, { date: '2026/10/25', text: 'x' }).ok === false);
ok('缺日期拒绝', stockLog.addLog(A, { text: 'x' }).ok === false);
ok('超长内容拒绝', stockLog.addLog(A, { date: '2026-10-25', text: '长'.repeat(2001) }).ok === false);

console.log('\n===== §3 个股隔离 =====');
stockLog.addLog(B, { date: '2026-10-24', text: '另一只股票的记录' });
ok('B 股列表独立（1 条）', stockLog.listLog(B).items.length === 1);
ok('A 股不受影响（3 条）', stockLog.listLog(A).items.length === 3);

console.log('\n===== §4 删除 =====');
const delId = stockLog.listLog(A).items[0].id;
r = stockLog.removeLog(A, delId);
ok('删除成功', r.ok, r);
ok('删除后剩 2 条', stockLog.listLog(A).items.length === 2);
ok('删除不存在的 id 报错', stockLog.removeLog(A, 'log_notexist').ok === false);
ok('B 股不受影响', stockLog.listLog(B).items.length === 1);

console.log('\n===== §5 损坏文件按空处理 =====');
const fA = path.join(DIR, A.replace(/^(sh|sz)/, '') + '.json');
fs.writeFileSync(fA, '{broken json');
l = stockLog.listLog(A);
ok('损坏文件返回空列表不崩溃', l.ok === true && l.items.length === 0);
ok('删除接口对损坏文件报错不崩溃', stockLog.removeLog(A, 'x').ok === false);
fs.unlinkSync(fA);

console.log(`\n[test_stock_log] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
