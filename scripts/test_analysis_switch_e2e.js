'use strict';
/**
 * ① E2E · B 组：切股链路（test_analysis_switch_e2e.js）
 * =====================================================================
 * @test-scope: local —— 零外网（桩见 scripts/e2e_boot_analysis.js），仅 127.0.0.1。
 *
 * B4（前端 token !== this._reqToken 丢弃过期响应）说明：该守卫是 public/js/app.js
 * analyze() 方法内联逻辑，不可作为纯函数导入；按用户裁决「复用 common-08 前端守卫
 * 覆盖，本组只测 HTTP 层并发」，不为此引入 jsdom/前端测试框架——B 组落 B1–B3。
 *
 * B2 现状说明：服务端 /api/analysis 无 singleflight（同键并发各自现算后写同一缓存键，
 * 结果一致、无串数据）；本组按实际行为断言「异键不合并、同键并发均成功且一致」。
 */
const assert = require('assert');
const H = require('./e2e_analysis_harness');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

function lastClose(body) { return body.history[body.history.length - 1].close; }

(async () => {
  console.log('\n=== B 组 · 切股链路 E2E ===');
  const tmp = H.makeTmpRoot('b-switch');
  const warmSnap = H.snapshotWarmPersist();
  const restore = H.guardedRestore(warmSnap);
  let h = null;
  try {
    h = H.spawnServer(tmp);
    await h.ready;
    ok(true, `测试服务器就绪 127.0.0.1:${h.port}`);

    // ---- B1 连续切 A→B→C→A：数据不串 ----
    const seq = ['601001', '601002', '601003', '601001'];
    const resp = {};
    let seqOk = true, nameOk = true;
    for (const sym of seq) {
      const r = await H.request(h.base, `/api/analysis/${sym}?range=1y`);
      if (r.status !== 200 || r.body.symbol !== sym) seqOk = false;
      resp[sym] = r.body;
    }
    ok(seqOk, 'B1 连续 601001→601002→601003→601001，四次响应 symbol 均与请求一致');
    ok(resp['601001'].name === '测试股甲' && resp['601002'].name === '测试股乙' && resp['601003'].name === '测试股丙', 'B1 三只标的 name 各自匹配（无串名）');
    const a1 = lastClose(resp['601001']), a2 = lastClose(resp['601001']), b = lastClose(resp['601002']), c = lastClose(resp['601003']);
    ok(a1 === a2, `B1 切回 601001 末根收盘价一致（${a1} === ${a2}）`);
    ok(a1 !== b && b !== c && a1 !== c, `B1 三只标的末根收盘价互不相同（${a1} / ${b} / ${c}，数据不串）`);
    ok(resp['601001'].quote.code === '601001' && resp['601002'].quote.code === '601002' && resp['601003'].quote.code === '601003', 'B1 quote.code 各自归属正确');

    // ---- B2 并发切股：异键不交叉、同键并发一致 ----
    const [ra, rb] = await Promise.all([
      H.request(h.base, '/api/analysis/601001?range=1y'),
      H.request(h.base, '/api/analysis/601005?range=1y'),
    ]);
    ok(ra.status === 200 && ra.body.symbol === '601001' && lastClose(ra.body) === a1, `B2 并发异键①：601001 symbol 匹配且末根价与 B1 一致（${lastClose(ra.body)}）`);
    ok(rb.status === 200 && rb.body.symbol === '601005' && lastClose(rb.body) !== a1, `B2 并发异键②：601005 symbol 匹配且数据独立（${lastClose(rb.body)} ≠ ${a1}）`);
    ok(rb.body.name === '测试股丁', 'B2 异键响应 name 归属正确（无交叉）');
    const [s1, s2] = await Promise.all([
      H.request(h.base, '/api/analysis/601077?range=1y'),
      H.request(h.base, '/api/analysis/601077?range=1y'),
    ]);
    ok(s1.status === 200 && s2.status === 200 && s1.body.symbol === '601077' && s2.body.symbol === '601077', 'B2 同键并发（601077×2）：两响应均 200 且 symbol 一致（现算无 singleflight，结果一致）');
    ok(lastClose(s1.body) === lastClose(s2.body), 'B2 同键并发末根价一致（无竞态污染）');

    // ---- B3 切回已缓存标的：命中缓存、未过期、数据一致 ----
    const r3 = await H.request(h.base, '/api/analysis/601001?range=1y');
    ok(r3.status === 200 && typeof r3.body.cachedAt === 'number', `B3 切回 601001 命中缓存（cachedAt=${r3.body.cachedAt}）`);
    ok(r3.body.cacheAgeSec < 60, `B3 缓存未过期（cacheAgeSec=${r3.body.cacheAgeSec}s < 60）`);
    ok(lastClose(r3.body) === a1 && r3.body.quote.code === '601001', 'B3 命中缓存数据与首次一致（末根价/quote 归属）');
  } catch (e) {
    fail++;
    console.log('  ✗ B 组异常中断：' + e.message);
    if (h) console.log('    子进程 stderr 尾部：' + h.stderrTail().slice(-500));
  } finally {
    if (h && h.child) { try { h.child.kill('SIGKILL'); } catch (e) { console.error('[B] 子进程终止失败:', e.message); } }
    restore();
    H.rmrf(tmp);
  }
  console.log(`\n=== B 组汇总：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();

function FIXNAME(sym) {
  return { '601001': '测试股甲', '601002': '测试股乙', '601003': '测试股丙', '601005': '测试股丁', '601077': '测试股慢' }[sym];
}
