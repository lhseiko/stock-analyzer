/**
 * 模块联动应答机制单测（20261024h）
 * 运行： node scripts/test_module_sync.js
 *
 * 覆盖：依赖图完整性 / 传递失效 / 合并去抖 / 强制重发 / 未知源 / 错误隔离 / 空 symbols / 观测接口 / 源码接线。
 * 为避免污染真实缓存，测试内把 priceActionHub.invalidateSnapshot 与
 * sameDayJudgment.invalidateJudgmentForSymbol 临时替换为记录调用次数的桩函数。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ms = require('../lib/moduleSync');
const pah = require('../lib/priceActionHub');
const sdj = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// ---- 打桩 ----
const origIS = pah.invalidateSnapshot;
const origIJ = sdj.invalidateJudgmentForSymbol;
let isCalls = [], ijCalls = [];
pah.invalidateSnapshot = (s) => { isCalls.push(s); };
sdj.invalidateJudgmentForSymbol = (s) => { ijCalls.push(s); return true; };

// ============================================================================
console.log('\n[1] 依赖图完整性');
{
  const g = ms.getGraph();
  const names = new Set(g.modules.map(m => m.name));
  ok(g.modules.length >= 13, `登记模块 ${g.modules.length} 个`);
  let bad = [];
  for (const e of g.edges) { if (!names.has(e.from) || !names.has(e.to)) bad.push(`${e.from}->${e.to}`); }
  ok(bad.length === 0, '所有依赖边端点均为已登记模块' + (bad.length ? '：' + bad.join(',') : ''));
  ok(g.edges.some(e => e.from === 'manualZones' && e.to === 'priceActionHub'), 'manualZones → priceActionHub');
  ok(g.edges.some(e => e.from === 'priceActionHub' && e.to === 'sameDayJudgment'), 'priceActionHub → sameDayJudgment');
  ok(g.edges.some(e => e.from === 'marketEmotion' && e.to === 'sameDayJudgment'), 'marketEmotion → sameDayJudgment（声明）');
  const pa = g.modules.find(m => m.name === 'priceActionHub');
  const sj = g.modules.find(m => m.name === 'sameDayJudgment');
  ok(pa && pa.hasHandler === true, 'priceActionHub 有失效句柄');
  ok(sj && sj.hasHandler === true, 'sameDayJudgment 有失效句柄');
}

// ============================================================================
console.log('\n[2] 传递失效：manualZones 变动 → 快照 + 判断 都收到信号');
{
  ms._reset(); isCalls = []; ijCalls = [];
  const r = ms.emitChange('manualZones', { symbols: ['600460'], reason: '手动区间新增', force: true });
  ok(r.skipped === false, '信号已发出');
  ok(r.affected.includes('priceActionHub'), '受影响含 priceActionHub（直接）');
  ok(r.affected.includes('sameDayJudgment'), '受影响含 sameDayJudgment（间接传递）');
  ok(isCalls.length === 1 && isCalls[0] === '600460', 'invalidateSnapshot 被调用 1 次（600460）');
  ok(ijCalls.length === 1 && ijCalls[0] === '600460', 'invalidateJudgmentForSymbol 被调用 1 次（600460）');
  const pa = r.results.find(x => x.module === 'priceActionHub');
  const sj = r.results.find(x => x.module === 'sameDayJudgment');
  ok(pa && pa.info && pa.info.invalidated === 1, 'priceActionHub 报告失效 1 条');
  ok(sj && sj.info && sj.info.invalidated === 1, 'sameDayJudgment 报告失效 1 条');
}

// ============================================================================
console.log('\n[3] 多标的批量失效');
{
  ms._reset(); isCalls = []; ijCalls = [];
  const r = ms.emitChange('eventEngine', { symbols: ['601318', '600460', '000902'], reason: '事件扫描', force: true });
  ok(r.affected.includes('sameDayJudgment') && r.affected.includes('deepAnalysis'), 'eventEngine → sameDayJudgment + deepAnalysis');
  ok(ijCalls.length === 3, '3 个标的的判断全部作废');
  ok(ijCalls.includes('601318') && ijCalls.includes('600460') && ijCalls.includes('000902'), '标的集合正确');
}

// ============================================================================
console.log('\n[4] 合并去抖 / 强制重发');
{
  ms._reset(); ijCalls = [];
  const a = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x' });
  const b = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x' });
  ok(a.skipped === false, '首次发送');
  ok(b.skipped === true && b.reason === 'coalesced', '同键短时间内第二次 → coalesced');
  ok(ijCalls.length === 1, '去抖后只实际失效 1 次');
  const c = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x', force: true });
  ok(c.skipped === false, 'force=true 绕过去抖');
  ok(ijCalls.length === 2, '强制重发后实际失效 2 次');
}

// ============================================================================
console.log('\n[5] 未知源 / 空 symbols / 错误隔离');
{
  ms._reset();
  const u = ms.emitChange('不存在的模块', { symbols: ['600460'] });
  ok(u.skipped === true && /未知源模块/.test(u.reason), '未知源 → 跳过并说明');

  const e = ms.emitChange('dedicatedFactor', { symbols: [], force: true });
  ok(e.skipped === false, '空 symbols 仍记录信号（不崩）');
  const sj = e.results.find(x => x.module === 'sameDayJudgment');
  ok(sj && sj.ok === true && sj.info && sj.info.invalidated === 0, '空 symbols → 失效 0 条（不臆造）');

  // 错误隔离：priceActionHub 句柄抛错，不影响 sameDayJudgment
  ms.emitChange('manualZones', { symbols: ['600460'], force: true }); // 触发默认接线
  ms.onInvalidate('priceActionHub', () => { throw new Error('boom'); });
  const er = ms.emitChange('manualZones', { symbols: ['600460'], force: true });
  const pa = er.results.find(x => x.module === 'priceActionHub');
  const sd = er.results.find(x => x.module === 'sameDayJudgment');
  ok(pa && pa.ok === false && /boom/.test(pa.error || ''), '抛错处理器被捕获（ok=false + error）');
  ok(sd && sd.ok === true, '其他联动模块不受影响（错误隔离）');
}

// ============================================================================
console.log('\n[6] 观测接口');
{
  ms._reset();
  ms.emitChange('manualZones', { symbols: ['600460'], reason: 'obs', force: true });
  const sigs = ms.getRecentSignals(5);
  ok(Array.isArray(sigs) && sigs.length >= 1, 'getRecentSignals 返回数组');
  ok(sigs[0].source === 'manualZones' && Array.isArray(sigs[0].affected), '最新信号含 source/affected');
  const st = ms.stats();
  ok(st.handlers >= 2 && st.signals >= 1, 'stats: handlers≥2, signals≥1');
}

// ============================================================================
console.log('\n[7] 源码接线守卫');
{
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ev = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventRoutes.js'), 'utf8');
  const df = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dedicatedFactor.js'), 'utf8');
  ok(srv.includes("moduleSync.emitChange('manualZones'"), 'server.js 手动区间增删 → 发 manualZones 信号');
  ok(srv.includes("moduleSync.emitChange('eventEngine'"), 'server.js 事件扫描 → 发 eventEngine 信号');
  ok(srv.includes("moduleSync.emitChange('dedicatedFactor'"), 'server.js 专属因子 → 发 dedicatedFactor 信号');
  ok(srv.includes('app.use(moduleSyncRoutes)'), 'server.js 挂载 moduleSyncRoutes');
  ok(ev.includes("moduleSync.emitChange('eventEngine'"), 'eventRoutes.js 改用联动机制');
  ok(df.includes("moduleSync.emitChange('dedicatedFactor'"), 'dedicatedFactor.js 改用联动机制');
  ok(!/for \(const s of \(result\.changedSymbols \|\| \[\]\)\) \{\s*try \{ sameDay\.invalidateJudgmentForSymbol/.test(ev), 'eventRoutes 手写 invalidation 循环已移除');
}

// ---- 还原桩 ----
pah.invalidateSnapshot = origIS;
sdj.invalidateJudgmentForSymbol = origIJ;

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
