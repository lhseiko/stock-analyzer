'use strict';
/**
 * ① E2E · D 组：可观测性（test_analysis_observability_e2e.js）
 * =====================================================================
 * @test-scope: local —— 零外网（桩见 scripts/e2e_boot_analysis.js），仅 127.0.0.1。
 *
 * 复用边界（避免重复计数）：
 *   - lib/requestLogger.js 的 45 条单测/守卫断言（route 归一化、reqId 规则、白名单）
 *     已由 test_health_panel.js 覆盖——本组只做 analysis 路径的**集成断言**，不复制；
 *   - 链路 5（test_fallback_chain_e2e.js）已覆盖 stockData 内部降级链与 markDegraded
 *     语义——本组桩替代了 stockData，真实降级链不在本组触发路径内。
 *
 * D4 降级口径（用户裁决原文）：analysis 路径若走 stockData 埋点，degraded 计数可查；
 * 不走则只写「未观测到降级」。实测结论：analysis 路由的 getQuote/getHistory 来自
 * lib/stockData.js（内含 8 处 markDegraded，AsyncLocalStorage 关联请求行），即生产上
 * analysis 路径**经过降级埋点、计数可查**；但本组测试以桩替代 stockData → 桩环境
 * 内不触发 markDegraded → 断言口径 = 「计数可查（dashboard.degradedBySource 存在）
 * 且本组 jsonl 未观测到 degraded:true」，不写「无降级」。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('./e2e_analysis_harness');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

const LINE_WHITELIST = ['ts', 'reqId', 'method', 'route', 'status', 'durationMs', 'degraded', 'degradedSources'];

function readJsonl(logsDir) {
  const f = fs.readdirSync(logsDir).find(n => /^requests-\d{8}\.jsonl$/.test(n));
  if (!f) return [];
  return fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return { __parseError: l }; }
  });
}

(async () => {
  console.log('\n=== D 组 · analysis 可观测性 E2E ===');
  const tmp = H.makeTmpRoot('d-obs');
  const warmSnap = H.snapshotWarmPersist();
  const restore = H.guardedRestore(warmSnap);
  let h = null;
  try {
    h = H.spawnServer(tmp);
    await h.ready;
    ok(true, `测试服务器就绪 127.0.0.1:${h.port}（SA_LOGS_DIR=临时目录）`);

    // ---- D1 结构化 JSONL：route 只含 pathname、无 req.body、无 query 泄露 ----
    await H.request(h.base, '/api/analysis/601001?range=1y&name=' + encodeURIComponent('测试股甲') + '&secret=SHOULD-NOT-LEAK');
    let lines = readJsonl(h.logsDir);
    const a = lines.find(l => l.route === '/api/analysis/:id');
    ok(!!a, `D1 jsonl 存在 route='/api/analysis/:id' 行（动态段已归一化，共 ${lines.length} 行）`);
    ok(a && ['ts', 'reqId', 'method', 'route', 'status', 'durationMs'].every(k => k in a), 'D1 行含 ts/reqId/method/route/status/durationMs');
    ok(a && !a.route.includes('?') && !a.route.includes('secret'), 'D1 route 只含 pathname（无 query）');
    ok(a && !('body' in a) && !JSON.stringify(a).includes('SHOULD-NOT-LEAK'), 'D1 行无 req.body 且 query 参数值不泄露');
    ok(a && Object.keys(a).every(k => LINE_WHITELIST.includes(k)), `D1 行字段全部在白名单内（${Object.keys(a).join(',')}）`);

    // ---- D2 X-Request-Id：合法回写、非法重生成 ----
    const d2a = await H.request(h.base, '/api/analysis/601002?range=1y', { headers: { 'X-Request-Id': 'e2etestreqid0001' } });
    ok(d2a.status === 200 && d2a.headers['x-request-id'] === 'e2etestreqid0001', `D2 合法入站头回写（x-request-id=${d2a.headers['x-request-id']}）`);
    lines = readJsonl(h.logsDir);
    ok(lines.some(l => l.reqId === 'e2etestreqid0001'), 'D2 jsonl 行 reqId 与入站头一致（跨服务追踪）');
    const d2b = await H.request(h.base, '/api/analysis/601003?range=1y', { headers: { 'X-Request-Id': 'bad!id' } });
    const echoed = d2b.headers['x-request-id'];
    ok(d2b.status === 200 && echoed && echoed !== 'bad!id' && /^[A-Za-z0-9_-]{8,64}$/.test(echoed), `D2 非法入站头不回写，服务端生成合法 reqId（${echoed}）`);

    // ---- D3 aborted 请求：aborted:true、不污染成功率 ----
    const before = lines.length;
    const req = H.rawRequest(h.base, '/api/analysis/601077?range=1y'); // 桩延迟 400ms
    req.on('error', () => { /* 客户端主动断开的 ECONNRESET 属预期，服务端行才是断言对象 */ });
    req.end();
    setTimeout(() => { try { req.destroy(); } catch (e) { console.error('[D3] 断开失败:', e.message); } }, 120);
    await new Promise(r => setTimeout(r, 800));
    lines = readJsonl(h.logsDir);
    const aborted = lines.find(l => l.aborted === true);
    ok(!!aborted, `D3 jsonl 存在 aborted:true 行（close 兜底捕获中途断开）`);
    ok(aborted && aborted.status === 0, `D3 aborted 行 status=0（未发响应头，不进异常率口径）`);
    ok(aborted && aborted.route === '/api/analysis/:id', 'D3 aborted 行 route 归一化正确');

    // ---- D4 降级口径：计数可查 + 桩环境未观测到降级 ----
    lines = readJsonl(h.logsDir);
    const analysisLines = lines.filter(l => l.route === '/api/analysis/:id' && l.aborted !== true);
    ok(analysisLines.length >= 2, `D4 analysis 正常请求行 ${analysisLines.length} 条`);
    ok(analysisLines.every(l => l.degraded !== true), 'D4 桩环境 analysis 行未观测到 degraded:true（口径：未观测到降级，非「无降级」）');
    const dash = await H.request(h.base, '/api/health/dashboard');
    ok(dash.status === 200 && dash.body.ok === true && typeof dash.body.degradedBySource === 'object', `D4 降级计数可查：/api/health/dashboard degradedBySource=${JSON.stringify(dash.body.degradedBySource)}`);
    ok(typeof dash.body.writeFailures === 'number', `D4 dashboard.writeFailures=${dash.body.writeFailures}（计数面完整）`);
    console.log('  ℹ D4 口径注记：analysis 路由 getQuote/getHistory 来自 lib/stockData.js（内含 8 处 markDegraded）→ 生产路径经过降级埋点；本组桩替代 stockData 故未观测到降级——stockData 降级链语义由链路 5 E2E 覆盖，不重复断言。');
  } catch (e) {
    fail++;
    console.log('  ✗ D 组异常中断：' + e.message);
    if (h) console.log('    子进程 stderr 尾部：' + h.stderrTail().slice(-500));
  } finally {
    if (h && h.child) { try { h.child.kill('SIGKILL'); } catch (e) { console.error('[D] 子进程终止失败:', e.message); } }
    restore();
    H.rmrf(tmp);
  }
  console.log(`\n=== D 组汇总：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
