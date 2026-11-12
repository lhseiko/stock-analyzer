'use strict';
/**
 * ① E2E · C 组：缓存与版本（test_analysis_cache_e2e.js）
 * =====================================================================
 * @test-scope: local —— 零外网（桩见 scripts/e2e_boot_analysis.js），仅 127.0.0.1。
 *
 * C2 口径说明（现状记录，非期望失效——本次最容易写错的一条）：
 *   analysis 数据缓存键 = `symbol|range`（lib/analysisWarm.js），**不含 APP_VERSION**；
 *   「升版后 analysis 缓存失效」在当前代码中**不存在该路径**，因此断言只做现状记录：
 *   ① 行为层——同 symbol 换 range 即独立缓存（键含 range）、重复命中（键稳定）；
 *   ② 源码层——lib/analysisWarm.js 缓存键拼接不含 APP_VERSION。
 *   与前端静态资源 ?v= 302 强制对齐（FRONTEND_BUST_FILES）是**两套机制**：
 *   test_cache_bust_guard.js 已覆盖，本组不重复断言。
 *
 * C5 注入方式（无运行时改动）：独立子进程将 SA_LOGS_DIR 指向一个已存在的「文件」
 * （非目录）→ requestLogger.ensureStream 的 mkdirSync 抛 ENOTDIR → writeFailures++
 * → /api/health 的 logWriteFailures 如实增加、业务响应不受影响。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('./e2e_analysis_harness');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

function lastClose(body) { return body.history[body.history.length - 1].close; }

(async () => {
  console.log('\n=== C 组 · 缓存与版本 E2E ===');
  const tmp = H.makeTmpRoot('c-cache');
  const warmSnap = H.snapshotWarmPersist();
  const restore = H.guardedRestore(warmSnap);
  let h = null;
  try {
    h = H.spawnServer(tmp);
    await h.ready;
    ok(true, `测试服务器就绪 127.0.0.1:${h.port}`);

    // ---- C1 同 symbol 重复请求：命中缓存、数据一致（不做耗时断言） ----
    const c1a = await H.request(h.base, '/api/analysis/601003?range=1y');
    ok(c1a.status === 200 && c1a.body.cachedAt === undefined, 'C1 首次请求为现算（无 cachedAt）');
    const c1b = await H.request(h.base, '/api/analysis/601003?range=1y');
    ok(c1b.status === 200 && typeof c1b.body.cachedAt === 'number', 'C1 第二次请求命中缓存（cachedAt 存在）');
    ok(lastClose(c1a.body) === lastClose(c1b.body) && c1a.body.quote.price === c1b.body.quote.price, `C1 两次数据一致（末根价 ${lastClose(c1a.body)} / quote 价 ${c1a.body.quote.price}）`);

    // ---- C2 版本口径（现状记录 + 与前端 302 机制区分） ----
    const c2a = await H.request(h.base, '/api/analysis/601001?range=3y');
    ok(c2a.status === 200 && c2a.body.cachedAt === undefined, 'C2 同 symbol 换 range → 独立现算（键含 range，无 cachedAt）');
    const c2b = await H.request(h.base, '/api/analysis/601001?range=3y');
    ok(c2b.status === 200 && typeof c2b.body.cachedAt === 'number', 'C2 同键重复请求命中（键稳定 symbol|range）');
    const warmSrc = fs.readFileSync(path.join(H.ROOT, 'lib', 'analysisWarm.js'), 'utf8');
    ok(/const key = String\(symbol \|\| ''\) \+ '\|' \+ \(range \|\| '1y'\)/.test(warmSrc), 'C2 源码核验：缓存键 = symbol|range（lib/analysisWarm.js）');
    ok(!/APP_VERSION/.test(warmSrc), 'C2 源码核验：analysisWarm 缓存逻辑不含 APP_VERSION（升版不使 analysis 数据缓存失效——现状记录，无该失效路径）');
    console.log('  ℹ C2 口径注记：与前端静态资源 ?v=302 强制对齐（FRONTEND_BUST_FILES 中间件）是两套机制；后者由 test_cache_bust_guard.js 覆盖，本组不重复断言。');

    // ---- C3 错误 payload 不缓存：先失败后成功 ----
    const c3a = await H.request(h.base, '/api/analysis/601009?range=1y');
    ok(c3a.status === 404, `C3 首次（上游双失败）→ HTTP ${c3a.status}（404）`);
    const c3b = await H.request(h.base, '/api/analysis/601009?range=1y');
    ok(c3b.status === 200 && c3b.body.symbol === '601009' && Array.isArray(c3b.body.history) && c3b.body.history.length === 320, `C3 第二次（上游恢复）→ HTTP ${c3b.status} 完整数据（错误未被缓存毒化）`);
    ok(c3b.body.cachedAt === undefined, 'C3 恢复后为现算（404 期间缓存从未写入错误 payload）');

    // ---- C4 growth-caliber → clearAllCache 生效 ----
    const pre = await H.request(h.base, '/api/analysis/601002?range=1y');
    const preHit = await H.request(h.base, '/api/analysis/601002?range=1y');
    ok(typeof preHit.body.cachedAt === 'number', 'C4 前置：601002 已入缓存（二次命中）');
    const post = await H.request(h.base, '/api/growth-caliber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caliber: 'sq' }) });
    ok(post.status === 200 && post.body && post.body.ok === true && post.body.caliber === 'sq', `C4 POST /api/growth-caliber → 200 ok（caliber=${post.body && post.body.caliber}）`);
    ok(fs.existsSync(path.join(tmp, 'settings.json')), 'C4 设置写入 SA_SETTINGS_FILE 临时文件（生产 data/settings.json 不被测试触碰）');
    const after = await H.request(h.base, '/api/analysis/601002?range=1y');
    ok(after.status === 200 && after.body.cachedAt === undefined, 'C4 清缓存后同 symbol 重新现算（无 cachedAt，clearAllCache 生效）');
    ok(lastClose(after.body) === lastClose(pre.body), 'C4 重算数据与清缓存前一致（桩数据确定性）');

    // ---- C5 缓存/日志写失败可观测（独立子进程注入 SA_LOGS_DIR=文件路径） ----
    const blocker = path.join(tmp, 'not-a-dir'); // 已存在的「文件」，作为 SA_LOGS_DIR → mkdir 抛 ENOTDIR
    fs.writeFileSync(blocker, 'block', 'utf8');
    const tmp2 = H.makeTmpRoot('c-cache5');
    let h2 = null;
    try {
      h2 = H.spawnServer(tmp2);
      // 覆写 logsDir 为文件路径：spawnServer 已建了目录，这里改为直接改环境重开一个子进程
      h2.child.kill('SIGKILL');
      const port2 = 39200 + Math.floor(Math.random() * 600);
      const { spawn } = require('child_process');
      const child2 = spawn(process.execPath, [path.join(H.ROOT, 'scripts', 'e2e_boot_analysis.js')], {
        cwd: H.ROOT,
        env: Object.assign({}, process.env, {
          PORT: String(port2), SA_NO_BG_AI: '1', SA_NO_DAILY_AI_REVIEW: '1', SA_NO_AUTO_OPEN: '1',
          SA_LOGS_DIR: blocker, // ← 注入点：日志目录是一个已存在的文件
          SA_SETTINGS_FILE: path.join(tmp2, 'settings.json'),
          HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child2.stdout.on('data', () => {});
      child2.stderr.on('data', () => {});
      h2 = { child: child2, base: `http://127.0.0.1:${port2}`, stderrTail: () => '' };
      await H.waitReady(h2);
      const biz = await H.request(h2.base, '/api/analysis/601001?range=1y');
      ok(biz.status === 200, `C5 日志目录不可写时业务请求仍 200（日志失败不影响业务）`);
      const health = await H.request(h2.base, '/api/health');
      ok(health.status === 200 && typeof health.body.logWriteFailures === 'number' && health.body.logWriteFailures >= 1, `C5 /api/health logWriteFailures=${health.body && health.body.logWriteFailures}（≥1，写失败如实计数）`);
    } finally {
      if (h2 && h2.child) { try { h2.child.kill('SIGKILL'); } catch (e) { console.error('[C5] 子进程终止失败:', e.message); } }
      H.rmrf(tmp2);
    }
  } catch (e) {
    fail++;
    console.log('  ✗ C 组异常中断：' + e.message);
    if (h) console.log('    子进程 stderr 尾部：' + h.stderrTail().slice(-500));
  } finally {
    if (h && h.child) { try { h.child.kill('SIGKILL'); } catch (e) { console.error('[C] 子进程终止失败:', e.message); } }
    restore();
    H.rmrf(tmp);
  }
  console.log(`\n=== C 组汇总：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
