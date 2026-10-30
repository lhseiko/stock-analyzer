// test_etf_cash_trend.js — 20261028a 全部宽基 ETF「持仓比例 vs 现金比例」趋势 单元测试
// 运行：node scripts/test_etf_cash_trend.js
// 用 SA_ETF_FLOW_DIR 指到临时目录，构造快照夹具，验证：加权口径、异常守卫、
// settled 标记、历史持久化幂等合并（磁盘快照优先 / 历史补已清理日期）、空目录诚实报错。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-trend-'));
process.env.SA_ETF_FLOW_DIR = tmp;
const etfFlow = require('../lib/etfFlow');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function snap(date, etfs, settled) {
  fs.writeFileSync(path.join(tmp, date + '.json'),
    JSON.stringify({ date, shareDate: date, settled: !!settled, savedAt: new Date().toISOString(), etfs }));
}
const mkEtf = (code, navPerCu, cash, nav, shares, unit) =>
  ({ code, name: 'X' + code, group: 'g', groupLabel: 'G', nav, unit, navPerCu, cash, compCount: 1, shares, comps: [['000001', 100]] });

console.log('== 1. 空目录 → 诚实报 ok:false ==');
{
  const r = etfFlow.cashPositionTrend();
  t('ok=false', r.ok === false);
  t('points 为空数组', Array.isArray(r.points) && r.points.length === 0);
  t('note 说明原因', typeof r.note === 'string' && r.note.length > 0);
}

console.log('== 2. 市值加权的比例口径 ==');
{
  // A：市值 900（nav=0.9×1000 份/单位×1000 单位 → nav*shares=900），现金比例 1%
  // B：市值 100，现金比例 10% → 加权现金 = (0.01*900 + 0.10*100)/1000 = 1.9%
  snap('20261022', [
    mkEtf('510300', 1000, 10, 0.9, 1000, 1000),
    mkEtf('510500', 1000, 100, 0.1, 1000, 1000),
  ], true);
  fs.writeFileSync(path.join(tmp, 'ratio-history.json'), 'RESET_NOT_JSON'); // 坏历史文件按空处理
  const r = etfFlow.cashPositionTrend();
  t('ok=true 且 1 个点', r.ok === true && r.points.length === 1);
  const p = r.points[0];
  t('现金比例=1.9%（加权）', Math.abs(p.cashRatioPct - 1.9) < 1e-9, 'got ' + p.cashRatioPct);
  t('持仓比例=98.1%（1−现金）', Math.abs(p.stockRatioPct - 98.1) < 1e-9, 'got ' + p.stockRatioPct);
  t('etfCount=2', p.etfCount === 2);
  t('settled=true', p.settled === true);
}

console.log('== 3. 异常守卫：±50% 之外的现金比例被剔除 ==');
{
  snap('20261023', [
    mkEtf('510300', 1000, 10, 0.9, 1000, 1000),      // 1%  正常
    mkEtf('510500', 1000, 600, 0.9, 1000, 1000),     // 60% 异常 → 剔除
  ], true);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261023');
  t('etfCount=1（异常被剔除）', p && p.etfCount === 1, 'got ' + (p && p.etfCount));
  t('现金比例=1%', Math.abs(p.cashRatioPct - 1) < 1e-9, 'got ' + p.cashRatioPct);
}

console.log('== 4. 盘中未定稿：settled=false，进入 unsettledDates ==');
{
  snap('20261024', [mkEtf('510300', 1000, 20, 0.9, 1000, 1000)], false);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261024');
  t('settled=false', p && p.settled === false);
  t('unsettledDates 含该日', Array.isArray(r.unsettledDates) && r.unsettledDates.includes('20261024'));
}

console.log('== 5. 历史持久化：磁盘删除后，历史文件补上该日期（跨越 KEEP_DAYS 清理窗口）==');
{
  fs.unlinkSync(path.join(tmp, '20261023.json')); // 模拟快照被滚动清理
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261023');
  t('被清理日期仍在趋势里', !!p);
  t('值与清理前一致(1%)', p && Math.abs(p.cashRatioPct - 1) < 1e-9);
  t('磁盘现存日期+历史日期 = 3 个点', r.points.length === 3, 'got ' + r.points.length);
  t('points 按日期升序', r.points.every((x, i, a) => i === 0 || String(a[i - 1].date) <= String(x.date)));
}

console.log('== 6. 磁盘快照永远优先于历史（同日重采覆盖）==');
{
  const hist = JSON.parse(fs.readFileSync(path.join(tmp, 'ratio-history.json'), 'utf8'));
  const stale = hist.points.find(x => x.date === '20261024');
  stale.cashRatioPct = 99; stale.stockRatioPct = 1; // 篡改历史为旧值
  fs.writeFileSync(path.join(tmp, 'ratio-history.json'), JSON.stringify(hist));
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261024');
  t('以磁盘快照为准（2%）', p && Math.abs(p.cashRatioPct - 2) < 1e-9, 'got ' + (p && p.cashRatioPct));
}

console.log('== 7. 幂等：连调两次历史文件不变 ==');
{
  const f = path.join(tmp, 'ratio-history.json');
  const before = fs.readFileSync(f, 'utf8');
  etfFlow.cashPositionTrend();
  etfFlow.cashPositionTrend();
  const after = fs.readFileSync(f, 'utf8');
  t('文件内容未变（无冗余写盘）', before === after);
}

console.log('== 8. 缺字段 ETF 被跳过（不崩、不计入）==');
{
  snap('20261025', [
    { code: '510300', name: 'x' },                                  // 缺 navPerCu/cash
    mkEtf('510500', 1000, 30, 0.9, 1000, 1000),                     // 3% 正常
  ], true);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261025');
  t('etfCount=1', p && p.etfCount === 1);
  t('现金比例=3%', p && Math.abs(p.cashRatioPct - 3) < 1e-9);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
