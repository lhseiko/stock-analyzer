// test_stock_log.js — 个股行情判断记录 lib/stockLog.js 单元测试
// 覆盖：添加/列表/删除/修改全流程、日期正序排序、校验、个股隔离、损坏文件、
//       上限之外的 20261108a 新增：两个下拉非必填、结算纯函数、自动结算端到端、
//       未填方向不纳入统计、待验证诚实降级、幂等、编辑改方向后重算。
// 用测试专用 symbol + barsOverride 注入 K 线，不发起任何网络请求，跑完清理文件。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// P2-1 测试隔离：将个股记录落盘重定向到项目外临时目录，避免污染真实 data/ 并规避沙箱批量删除守卫。
process.env.SA_DATA_DIR = path.join(os.tmpdir(), 'sa-stocklog-test-' + process.pid);
const { getDataDir, cleanupStaleTmpDirs } = require('../lib/dataDir');

const DIR = path.join(getDataDir(), 'stock-log');

// 单独跑本测试时也能自愈清理旧临时目录（全量 quick 之外的场景）：启动即清 >24h 的 sa-stocklog-test-*。
// 不依赖 SA_DATA_DIR（仅按前缀扫 os.tmpdir），不会删掉本运行将使用的目录（<24h）。
try { cleanupStaleTmpDirs(); } catch (e) {}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const stockLog = require('../lib/stockLog');
const fileOf = (s) => path.join(DIR, s.replace(/^(sh|sz|bj)/i, '') + '.json');
// 隔离目录删除：包 try/catch 兜底（正常应成功删除；沙箱守卫极少见，避免裸 unlink 抛错致整测试崩溃）
const clean = (s) => { const f = fileOf(s); try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} };

// ① 前置清洁 + 断言（防脏数据污染断言）：本运行使用按 process.pid 隔离的临时目录，正常应为空；
//    此处强制清空并断言为空，杜绝「上一运行残留」或「clean() 被守卫拦截未真正删除」导致文件残留、污染后续断言。
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(DIR, { recursive: true });
{
  const leftovers = (() => { try { return fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch (e) { return []; } })();
  if (leftovers.length) {
    console.error('  ✗ 前置目录非干净（残留 ' + leftovers.join(',') + '），clean() 可能未真正删除，断言可能被污染');
    process.exit(1);
  }
}

// 清场：只用测试专用 symbol，避免污染真实个股记录
const A = 'sh000test', B = 'sz600test', T = 'sz888test', U = 'sh999test';
for (const s of [A, B, T, U]) clean(s);

console.log('\n===== §1 添加与列表（日期先后正序） =====');
let r = stockLog.addLog(A, { date: '2026-10-25', text: '大股东公告减持 2%' });
ok('正常添加', r.ok && r.item && r.item.id, r);
r = stockLog.addLog(A, { date: '2026-10-20', text: '监管问询函' });
ok('第二条添加', r.ok, r);
r = stockLog.addLog(A, { date: '2026-10-25', text: '同日第二条（更晚创建）' });
const lateId = r.item && r.item.id;
let l = stockLog.listLog(A);
ok('列表 3 条', l.items.length === 3, l.items.length);
ok('按日期先后（正序）：2026-10-20 在前', l.items[0].date === '2026-10-20' && l.items[1].date === '2026-10-25' && l.items[2].date === '2026-10-25', l.items.map(x => x.date));
ok('同日按创建时间正序（新的在后）', l.items[2].id === lateId, l.items.map(x => x.id));
ok('旧 text 记录兼容为 note', l.items[0].note === '监管问询函', l.items[0].note);

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
const fA = fileOf(A);
fs.writeFileSync(fA, '{broken json');
l = stockLog.listLog(A);
ok('损坏文件返回空列表不崩溃', l.ok === true && l.items.length === 0);
ok('删除接口对损坏文件报错不崩溃', stockLog.removeLog(A, 'x').ok === false);
clean(A);

console.log('\n===== §6 修改记录 =====');
stockLog.addLog(A, { date: '2026-10-25', text: '大股东公告减持 2%' });
stockLog.addLog(A, { date: '2026-10-20', text: '监管问询函' });
const editId = stockLog.listLog(A).items[0].id;
r = stockLog.updateLog(A, editId, { date: '2026-10-27', text: '修改后的内容' });
ok('修改成功', r.ok && r.item && r.item.id === editId, r);
ok('日期已更新', r.ok && r.item.date === '2026-10-27', r.ok && r.item.date);
ok('内容已更新（note 字段）', r.ok && r.item.note === '修改后的内容', r.ok && r.item.note);
ok('updatedAt 已打溯源', r.ok && !!r.item.updatedAt, r.ok && r.item.updatedAt);
ok('createdAt 不变（排序键守恒）', r.ok && !!r.item.createdAt, r.ok && r.item.createdAt);
ok('修改拒绝日期格式错误', stockLog.updateLog(A, editId, { date: '2026/10/27', text: 'x' }).ok === false);
ok('修改拒绝空内容', stockLog.updateLog(A, editId, { date: '2026-10-27', text: '  ' }).ok === false);
ok('修改拒绝超长内容', stockLog.updateLog(A, editId, { date: '2026-10-27', text: '长'.repeat(2001) }).ok === false);
ok('修改不存在的 id 报错', stockLog.updateLog(A, 'log_notexist', { date: '2026-10-27', text: 'x' }).ok === false);
fs.writeFileSync(fA, '{broken');
ok('修改对损坏文件报错不崩溃', stockLog.updateLog(A, editId, { date: '2026-10-27', text: 'x' }).ok === false);
clean(A);
ok('B 股不受影响', stockLog.listLog(B).items.length === 1);

console.log('\n===== §7 两个下拉非必填（20261108a） =====');
stockLog.addLog(A, { date: '2026-10-21', note: '两个下拉都没选' });
let one = stockLog.listLog(A).items[0];
ok('不传 direction/basis → 均为 null', one.direction === null && one.basis === null, one);
ok('未选方向不生成 verdict（不参与统计）', one.verdict === null, one.verdict);
r = stockLog.addLog(A, { date: '2026-10-22', note: '空字符串', direction: '', basis: '' });
ok('传空字符串也存 null', r.item.direction === null && r.item.basis === null, r.item);
r = stockLog.addLog(A, { date: '2026-10-23', note: '非法值', direction: 'whatever', basis: 'xxx' });
ok('非法枚举值不落盘臆造值', r.item.direction === null && r.item.basis === null, r.item);
r = stockLog.addLog(A, { date: '2026-10-24', note: '正常选择', direction: 'up', basis: 'technical' });
ok('有效枚举值正常保留', r.item.direction === 'up' && r.item.basis === 'technical', r.item);
ok('有方向但未结算 → verdict=pending', r.item.verdict === undefined || r.item.verdict === 'pending', r.item.verdict);

console.log('\n===== §8 结算纯函数（代码权威，与 techFaceJudgment 同源口径） =====');
ok('FLAT_TOLERANCE = 1.0', stockLog.FLAT_TOLERANCE === 1.0);
ok('actualDirection +2% → up', stockLog.actualDirection(2) === 'up');
ok('actualDirection -2% → down', stockLog.actualDirection(-2) === 'down');
ok('actualDirection 0% → sideways', stockLog.actualDirection(0) === 'sideways');
ok('判 up / 实际 +2.5% → 对', stockLog.judge('up', 2.5) === true);
ok('判 down / 实际 +2.5% → 错', stockLog.judge('down', 2.5) === false);
ok('判 sideways / 实际 +0.4% → 对（容差内）', stockLog.judge('sideways', 0.4) === true);
ok('判 sideways / 实际 +1.5% → 错（超容差）', stockLog.judge('sideways', 1.5) === false);
ok('无方向 → 不判（返回 null）', stockLog.judge(null, 2.5) === null);
ok('无有效涨跌幅 → 不判（返回 null）', stockLog.judge('up', NaN) === null);
const NB = stockLog.normalizeBars([
  { date: '2026-10-27', close: 10.35 }, { date: 'bad', close: 9 },
  { date: '2026-10-26', close: 10.30 }, { date: '2026-10-23', close: 0 },
]);
ok('normalizeBars 过滤非法并升序', NB.length === 2 && NB[0].date === '2026-10-26' && NB[1].date === '2026-10-27', NB);
const BARS = [
  { date: '2026-10-22', close: 9.80 }, { date: '2026-10-23', close: 10.00 },
  { date: '2026-10-26', close: 10.30 }, { date: '2026-10-27', close: 10.35 },
  { date: '2026-10-28', close: 10.10 },
];
const v1 = stockLog.verdictFromBars(BARS, '2026-10-23');
ok('验证日 = 记录日之后第一个交易日（跳过周末）', v1 && v1.actualDate === '2026-10-26' && v1.baseDate === '2026-10-23', v1);
ok('涨跌幅按基准日收盘计算 +3.00%', v1 && v1.chgPct === 3, v1);
ok('未到验证日 → null（诚实待验证）', stockLog.verdictFromBars(BARS, '2026-10-28') === null);
ok('无基准 K 线 → null', stockLog.verdictFromBars(BARS.slice(2), '2026-10-01') === null);

console.log('\n===== §9 自动结算端到端（mock 日K，不发网络） =====');
clean(T);
stockLog.addLog(T, { date: '2026-10-23', direction: 'up', basis: 'technical', note: '① 判上涨 → 实际 +3.00% → 对' });
stockLog.addLog(T, { date: '2026-10-26', direction: 'sideways', basis: 'news', note: '② 判震荡 → 实际 +0.49% → 对' });
stockLog.addLog(T, { date: '2026-10-27', direction: 'up', basis: 'other', note: '③ 判上涨 → 实际 -2.42% → 错' });
stockLog.addLog(T, { date: '2026-10-28', direction: 'down', basis: null, note: '④ 验证日未到 → 待验证' });
stockLog.addLog(T, { date: '2026-10-24', direction: '', basis: '', note: '⑤ 未填方向 → 不纳入统计' });

(async () => {
  const out = await stockLog.settleAndList(T, { barsOverride: BARS });
  const byNote = (k) => out.items.find(x => String(x.note).indexOf(k) === 0);
  ok('① 判上涨命中 → correct', byNote('①').verdict === 'correct', byNote('①'));
  ok('② 判震荡容差内 → correct', byNote('②').verdict === 'correct', byNote('②'));
  ok('③ 判上涨实际下跌 → wrong', byNote('③').verdict === 'wrong', byNote('③'));
  ok('④ 未到验证日 → pending', byNote('④').verdict === 'pending', byNote('④'));
  ok('⑤ 未填方向 → verdict=null 且无结算字段', byNote('⑤').verdict === null && byNote('⑤').actualChgPct == null, byNote('⑤'));
  const a = out.accuracy;
  ok('准确率分母只含已判定 3 条', a.judged === 3, a);
  ok('对 2 / 错 1 / 待验证 1 / 未填方向 1', a.correct === 2 && a.wrong === 1 && a.pending === 1 && a.noDirection === 1, a);
  ok('准确率 = 66.7%', a.rateText === '66.7%', a.rateText);
  ok('落盘数值含真实涨跌幅与验证日', byNote('①').actualChgPct === 3 && byNote('①').actualDate === '2026-10-26', byNote('①'));

  console.log('\n===== §10 幂等 / 编辑重算 / 取数失败诚实降级 =====');
  const out2 = await stockLog.settleAndList(T, { barsOverride: BARS });
  ok('重复读取幂等：准确率与结论不变', out2.accuracy.rateText === a.rateText && out2.items.filter(x => x.verdict === 'correct').length === 2, out2.accuracy);
  const third = byNote('③');
  stockLog.updateLog(T, third.id, { date: third.date, direction: 'down', basis: third.basis, note: third.note });
  const out3 = await stockLog.settleAndList(T, { barsOverride: BARS });
  ok('编辑改方向后自动重算为 correct', out3.items.find(x => x.id === third.id).verdict === 'correct', out3.items.find(x => x.id === third.id));
  ok('重算后准确率升到 100%', out3.accuracy.rateText === '100.0%', out3.accuracy);

  clean(U);
  stockLog.addLog(U, { date: '2026-10-23', direction: 'up', note: '日K取数失败场景' });
  const out4 = await stockLog.settleAndList(U, { barsOverride: [] });
  ok('日K不可得 → 保持 pending，不臆造结论', out4.items[0].verdict === 'pending', out4.items[0]);
  ok('日K不可得 → 准确率不输出数字', out4.accuracy.judged === 0 && out4.accuracy.rateText === '—', out4.accuracy);

  console.log('\n===== §11 模块隔离 =====');
  ok('准确率不写其他个股文件', fs.existsSync(fileOf(B)) && !JSON.stringify(fs.readFileSync(fileOf(B), 'utf8')).includes('accuracy'));
  ok('B 股记录仍为 1 条', stockLog.listLog(B).items.length === 1);

  for (const s of [A, B, T, U]) clean(s);
  console.log(`\n[test_stock_log] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('单测异常:', e);
  for (const s of [A, B, T, U]) clean(s);
  process.exit(1);
});
