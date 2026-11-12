#!/usr/bin/env node
/**
 * scripts/test_health_metrics_e2e.js — backlog ② 健康面板缓存命中与 LLM 计数守卫
 * @test-scope: local
 * ============================================================================
 * Part A（单元，直接调 lib/healthMetrics.js）：
 *   A1 命中率计算：3 命中 1 未命中 → hitRate=0.75，分子分母同时暴露；
 *   A2 排除项：aborted/错误请求不计入分母（单独计数，仅透明度）；
 *   A3 LLM 四类计数：ok/fail/degraded/timeout 各注入一次 → 分类正确、total=四类之和；
 *      未知 outcome 归 fail（绝不丢计数）；
 *   A4 并发安全：Promise.all 100 次混合注入 → total=100 不丢不重（同步自增）；
 *   A5 接口归一：ifaceOfRoute 分类（analysis/deep-analysis/other/null）；
 *   A6 快照隔离：snapshot 深拷贝，外部改动不污染内部计数。
 * Part B（E2E，桩服务器零网络，复用 e2e_analysis_harness）：
 *   B1 analysis 命中/未命中：601001 两次（miss→hit）+ 404（error）+ aborted（601077）
 *      + 10 并发 601002（全 miss，getCached 同步判定于任何 setCached 之前）→
 *      hits=1 / misses=11 / errors=1 / aborted=1 / hitRate=1/12；
 *   B2 面板与接口同源：/api/health 与 /api/health/dashboard 的 metrics 逐字段相等；
 *   B3 桩环境无 LLM 调用 → llm.total=0、四类结构齐全；
 *   B4 埋点接线源码断言（llm.js 四类/降级旗标、server/deepJobManager/requestLogger 接线存在）。
 * 口径注记：deep-analysis 的 running 轮询计入 miss（口径如实，未做轮询去重）。
 */
'use strict';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const H = require('./e2e_analysis_harness');
const healthMetrics = require(path.join(ROOT, 'lib', 'healthMetrics'));

// ==================== Part A：单元 ====================
(async () => {
console.log('[test_health_metrics] A1 命中率计算（分子分母同暴露）');
healthMetrics._resetForTests();
healthMetrics.recordCacheHit('analysis');
healthMetrics.recordCacheHit('analysis');
healthMetrics.recordCacheHit('analysis');
healthMetrics.recordCacheMiss('analysis');
{
  const s = healthMetrics.snapshot();
  ok(s.interfaces.analysis.hits === 3 && s.interfaces.analysis.misses === 1, `分子分母暴露：hits=3 misses=1`);
  ok(s.interfaces.analysis.hitRate === 0.75, `hitRate = 3/4 = 0.75（实际 ${s.interfaces.analysis.hitRate}）`);
  ok(s.interfaces.analysis.hitRateDenominator === 4, '分母字段 hitRateDenominator=4 单独暴露');
}

console.log('[test_health_metrics] A2 排除项：aborted/error 不计入分母');
healthMetrics.recordAborted('analysis');
healthMetrics.recordAborted('analysis');
healthMetrics.recordError('analysis');
{
  const s = healthMetrics.snapshot();
  ok(s.interfaces.analysis.aborted === 2 && s.interfaces.analysis.errors === 1, 'aborted/errors 单独计数暴露（2/1）');
  ok(s.interfaces.analysis.hitRateDenominator === 4, '分母仍 = hits+misses = 4（aborted/error 不计入）');
  ok(s.interfaces.analysis.hitRate === 0.75, 'hitRate 不受 aborted/error 影响（仍 0.75）');
}

console.log('[test_health_metrics] A3 LLM 四类计数');
healthMetrics.recordLlm('lib/aiAugment.js', 'ok');
healthMetrics.recordLlm('lib/aiAugment.js', 'fail');
healthMetrics.recordLlm('lib/reviewLlm.js', 'degraded');
healthMetrics.recordLlm('lib/stockReview.js', 'timeout');
{
  const s = healthMetrics.snapshot();
  const l = s.llm;
  ok(l.ok === 1 && l.fail === 1 && l.degraded === 1 && l.timeout === 1, '四类各 1（按类正确）');
  ok(l.total === 4, `total=4 = 四类之和`);
  ok(l.byCaller['lib/aiAugment.js'].total === 2 && l.byCaller['lib/reviewLlm.js'].degraded === 1, '按调用点分桶正确');
  healthMetrics.recordLlm('lib/x.js', 'weird-outcome'); // 未知 outcome
  ok(healthMetrics.snapshot().llm.fail === 2, '未知 outcome 归 fail（绝不丢计数）');
}

console.log('[test_health_metrics] A4 并发安全（Promise.all 100 混合注入）');
{
  const outcomes = ['ok', 'fail', 'degraded', 'timeout'];
  const before = healthMetrics.snapshot().llm.total;
  await Promise.all(Array.from({ length: 100 }, (_, i) =>
    Promise.resolve(healthMetrics.recordLlm('lib/conc.js', outcomes[i % 4]))
  ));
  const after = healthMetrics.snapshot().llm.total;
  ok(after - before === 100, `并发 100 次后 total 增量 = 100（实际 ${after - before}，不丢不重）`);
  const bc = healthMetrics.snapshot().llm.byCaller['lib/conc.js'];
  ok(bc.ok + bc.fail + bc.degraded + bc.timeout === 100, '调用点分桶四类之和 = 100');
}

console.log('[test_health_metrics] A5 接口归一');
ok(healthMetrics.ifaceOfRoute('/api/analysis/601318') === 'analysis', '/api/analysis* → analysis');
ok(healthMetrics.ifaceOfRoute('/api/deep-analysis/601318') === 'deep-analysis', '含 deep-analysis → deep-analysis');
ok(healthMetrics.ifaceOfRoute('/api/quote/601318') === 'other', '其余 /api → other');
ok(healthMetrics.ifaceOfRoute('/index.html') === null, '非 /api → null（不计数）');

console.log('[test_health_metrics] A6 快照隔离');
{
  const s1 = healthMetrics.snapshot();
  const hitsBefore = s1.interfaces.analysis.hits, okBefore = s1.llm.ok;
  s1.interfaces.analysis.hits = 99999; s1.llm.ok = 99999;
  const s2 = healthMetrics.snapshot();
  ok(s2.interfaces.analysis.hits === hitsBefore && s2.llm.ok === okBefore, 'snapshot 深拷贝：外部改动不污染内部计数');
}

console.log('[test_health_metrics] A7 文案口径（meta）');
{
  const s = healthMetrics.snapshot();
  ok(s.meta && s.meta.window === 'since_process_start', 'meta.window = since_process_start（本进程启动以来，重启清零）');
  ok(s.meta && s.meta.otherHitRate === 'N/A', 'meta.otherHitRate = N/A（other 接口无缓存语义，hitRate 恒 null）');
  ok(s.meta && s.meta.excludedFromDenominator === 'aborted/errors', 'meta.excludedFromDenominator = aborted/errors（排除项口径）');
  const other = s.interfaces.other;
  ok(!other || other.hitRate === null, 'other 接口 hitRate 为 null（无 hits/misses 埋点，不捏造 0/1）');
}

console.log('[test_health_metrics] B4 埋点接线源码断言');
{
  const llmSrc = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'llm.js'), 'utf8');
  ok(/healthMetrics\.recordLlm\(caller, outcome\)/.test(llmSrc), 'llm.js callLLM 出口接线 recordLlm');
  ok((llmSrc.match(/__mctx\.fallback = true/g) || []).length === 3, 'llm.js 三个降级点旗标（妙想回退/外部搜索纯推理/400 去参重试）');
  ok(/e\.timeout \|\| e\.budgetExhausted/.test(llmSrc), '超时判定接线（err.timeout/budgetExhausted → timeout）');
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/recordCacheHit\('analysis'\)/.test(svSrc) && /recordCacheMiss\('analysis'\)/.test(svSrc), 'server.js analysis hit/miss 接线');
  ok(/metrics: healthMetrics\.snapshot\(\)/.test(svSrc), '/api/health 与 dashboard 均暴露 metrics（同源）');
  const rlSrc = fs.readFileSync(path.join(ROOT, 'lib', 'requestLogger.js'), 'utf8');
  ok(/recordAborted\(_hmIface\)/.test(rlSrc) && /recordError\(_hmIface\)/.test(rlSrc), 'requestLogger aborted/error 单点接线');
  const djSrc = fs.readFileSync(path.join(ROOT, 'lib', 'deepJobManager.js'), 'utf8');
  ok(/recordCacheHit\('deep-analysis'\)/.test(djSrc), 'deepJobManager 磁盘缓存命中接线');
}

})();

// ==================== Part B：E2E（桩服务器） ====================
console.log('[test_health_metrics] B1–B3 桩服务器 E2E');
(async () => {
  const tmp = H.makeTmpRoot('hmetrics');
  let h = null;
  let bPass = 0, bFail = 0;
  const bok = (c, m) => { if (c) { bPass++; pass++; console.log('  ✓', m); } else { bFail++; fail++; console.log('  ✗', m); } };
  const warmSnap = H.snapshotWarmPersist();
  const restore = H.guardedRestore(warmSnap);
  try {
    h = H.spawnServer(tmp);
    await h.ready;

    // B1 请求序列
    const r1 = await H.request(h.base, '/api/analysis/601001?range=1y');
    bok(r1.status === 200 && r1.body.cachedAt === undefined, '① 601001 首次 → 200 现算（未命中）');
    const r2 = await H.request(h.base, '/api/analysis/601001?range=1y');
    bok(r2.status === 200 && typeof r2.body.cachedAt === 'number', '② 601001 二次 → 200 命中（cachedAt 存在）');
    const r3 = await H.request(h.base, '/api/analysis/ZZZZ99');
    bok(r3.status === 404, '③ ZZZZ99 → 404（错误请求）');
    // aborted（601077 桩延迟 400ms；req 必须挂 error 监听防 ECONNRESET 崩溃——D 组首跑教训）
    await new Promise((resolve) => {
      const req = H.rawRequest(h.base, '/api/analysis/601077?range=1y');
      req.on('error', () => resolve()); req.on('close', () => resolve());
      setTimeout(() => { try { req.destroy(); } catch (e) { /* 已断开 */ } resolve(); }, 60);
      req.end();
    });
    await new Promise(r => setTimeout(r, 100)); // 等 requestLogger close 落行
    const conc = await Promise.all(Array.from({ length: 10 }, () =>
      H.request(h.base, '/api/analysis/601002?range=1y')
    ));
    bok(conc.every(r => r.status === 200), `④ 10 并发 601002 全部 200（getCached 同步判定于 setCached 前 → 全 miss）`);

    // B1 指标核对
    const health = await H.request(h.base, '/api/health');
    bok(health.status === 200 && health.body.metrics, '/api/health 返回 metrics 字段');
    const a = health.body.metrics.interfaces.analysis;
    bok(a.hits === 1, `hits=1（② 一次命中；实际 ${a.hits}）`);
    bok(a.misses === 11, `misses=11（① 一次 + ④ 十次并发；实际 ${a.misses}）`);
    bok(a.errors === 1, `errors=1（③ 404；实际 ${a.errors}）`);
    bok(a.aborted === 1, `aborted=1（中途断开；实际 ${a.aborted}）`);
    bok(a.hitRateDenominator === 12, `分母 = hits+misses = 12（aborted/error 不计入；实际 ${a.hitRateDenominator}）`);
    bok(approx(a.hitRate, 1 / 12), `hitRate = 1/12 ≈ 0.0833（实际 ${a.hitRate}）`);

    // B2 面板与接口同源：dashboard metrics 与 health metrics 逐字段相等
    const dash = await H.request(h.base, '/api/health/dashboard');
    bok(dash.status === 200 && dash.body.metrics, '/api/health/dashboard 返回 metrics 字段');
    bok(JSON.stringify(dash.body.metrics) === JSON.stringify(health.body.metrics), 'dashboard.metrics 与 health.metrics 逐字段相等（同源快照）');

    // B3 桩环境无 LLM 调用
    const l = health.body.metrics.llm;
    bok(l.total === 0 && l.ok === 0 && l.fail === 0 && l.degraded === 0 && l.timeout === 0, '桩环境零 LLM 调用（total=0，四类结构齐全）');
    bok(typeof l.byCaller === 'object', 'byCaller 分桶结构存在');
  } catch (e) {
    bFail++; fail++;
    console.log('  ✗ B 组异常中断：' + e.message);
    if (h) console.log('    子进程 stderr 尾部：' + h.stderrTail().slice(-500));
  } finally {
    if (h && h.child) { try { h.child.kill('SIGKILL'); } catch (e) { console.error('[B] 子进程终止失败:', e.message); } }
    restore();
    H.rmrf(tmp);
  }
  console.log(`\n=== 健康指标守卫汇总：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
