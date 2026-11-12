'use strict';
/**
 * ① E2E · A 组：/api/analysis/:symbol 接口契约（test_analysis_api_contract_e2e.js）
 * =====================================================================
 * @test-scope: local —— 零外网：数据层全部桩（scripts/e2e_boot_analysis.js），
 * 仅 127.0.0.1 独立随机高位端口；漏网外呼被死代理 127.0.0.1:9 拒连。
 *
 * 断言口径说明（2026-11-12 对运行中 3005 实测后写死，不臆测）：
 *   - 真实契约顶层字段 = symbol/name/market/exchange/quote/history/technical/
 *     fundamental/signals/comparison/metricAnalysis/opProfit/insuranceNBV/
 *     companyType/companyProfile/timestamp（缓存命中附 cachedAt/cacheAgeSec）；
 *     【不存在】asOf/factors/summary/degraded 字段——按真实契约断言，规格中的
 *     asOf/degraded 假设字段不臆造。
 *   - 非法 range 实测 HTTP 200（getHistory 对未知 range 回退默认，不做 400），
 *     A3 按 200 口径写死。
 *   - 非法标的实测 404 {"error":"无法获取该股票的数据，请检查代码是否正确"}。
 */
const assert = require('assert');
const H = require('./e2e_analysis_harness');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

(async () => {
  console.log('\n=== A 组 · analysis 接口契约 E2E ===');
  const tmp = H.makeTmpRoot('a-contract');
  const warmSnap = H.snapshotWarmPersist();
  const restore = H.guardedRestore(warmSnap);
  let h = null;
  try {
    h = H.spawnServer(tmp);
    await h.ready;
    ok(true, `测试服务器就绪 127.0.0.1:${h.port}（启动副作用已隔离）`);

    // ---- A1 正常请求：字段齐全、归属正确 ----
    const r1 = await H.request(h.base, '/api/analysis/601001?range=1y&name=' + encodeURIComponent('测试股甲'));
    ok(r1.status === 200, `A1 GET 正常标的 → HTTP ${r1.status}（期望 200）`);
    ok(r1.body && r1.body.symbol === '601001', `A1 body.symbol 与请求标的一致（${r1.body && r1.body.symbol}）`);
    ok(r1.body && r1.body.name === '测试股甲', `A1 body.name 与请求 name 一致（${r1.body && r1.body.name}）`);
    ok(r1.body && r1.body.market === 'CN', `A1 body.market === 'CN'（${r1.body && r1.body.market}）`);
    ok(r1.body && typeof r1.body.timestamp === 'string' && !isNaN(Date.parse(r1.body.timestamp)), 'A1 body.timestamp 为合法 ISO 时间');
    ok(r1.body && Array.isArray(r1.body.history) && r1.body.history.length === 320, `A1 body.history 为 320 根 K 线（${r1.body && r1.body.history && r1.body.history.length}）`);
    ok(r1.body && r1.body.technical && r1.body.technical.indicators, 'A1 body.technical.indicators 存在（K 线技术面归属本标的）');
    ok(r1.body && r1.body.fundamental && typeof r1.body.fundamental === 'object', 'A1 body.fundamental 为对象');
    ok(r1.body && r1.body.companyProfile && r1.body.companyProfile.industry === '测试行业', 'A1 body.companyProfile.industry 为桩值（归属正确）');
    ok(r1.body && r1.body.quote && r1.body.quote.code === '601001' && r1.body.quote.price > 0, 'A1 body.quote.code/price 归属本标的');
    ok(r1.body && r1.body.cachedAt === undefined, 'A1 首次请求为现算（无 cachedAt）');

    // ---- A1b 二次请求：缓存命中附加字段 ----
    const r1b = await H.request(h.base, '/api/analysis/601001?range=1y');
    ok(r1b.status === 200 && typeof r1b.body.cachedAt === 'number' && typeof r1b.body.cacheAgeSec === 'number', `A1b 二次请求命中缓存（cachedAt/cacheAgeSec 数字型，age=${r1b.body && r1b.body.cacheAgeSec}s）`);

    // ---- A2 非法 symbol：404 明确、无堆栈/路径泄露 ----
    const r2 = await H.request(h.base, '/api/analysis/ZZZZ99');
    ok(r2.status === 404, `A2 非法标的 → HTTP ${r2.status}（期望 404，实测口径）`);
    ok(r2.body && typeof r2.body.error === 'string' && r2.body.error.length > 0, 'A2 错误体含 error 字符串');
    ok(!/stack/i.test(r2.raw) && !/node_modules/.test(r2.raw) && !/[A-Za-z]:\\\\/.test(r2.raw), 'A2 错误体不含 stack/node_modules/绝对路径泄露');

    // ---- A3 非法 range：实测 200（回退默认），不 500、不空 ----
    const r3 = await H.request(h.base, '/api/analysis/601001?range=bogus_range');
    ok(r3.status === 200, `A3 非法 range → HTTP ${r3.status}（实测口径：回退默认，200）`);
    ok(r3.body && r3.body.symbol === '601001' && Array.isArray(r3.body.history) && r3.body.history.length > 0, 'A3 非法 range 响应数据完整（symbol/history 正常）');

    // ---- A4 上游失败注入：降级如实、不把空数据当成功 ----
    const r4a = await H.request(h.base, '/api/analysis/601008?range=1y');
    ok(r4a.status === 200, `A4-1 quote 持续失败+history 正常 → HTTP ${r4a.status}（部分降级仍返回）`);
    ok(r4a.body && r4a.body.quote === null, 'A4-1 body.quote 如实为 null（不伪造行情）');
    ok(r4a.body && r4a.body.fundamental && /No fundamental data/i.test(r4a.body.fundamental.error || ''), 'A4-1 body.fundamental.error 如实标注（无基本面数据）');
    ok(r4a.body && r4a.body.metricAnalysis === null, 'A4-1 body.metricAnalysis 如实为 null');
    const r4b = await H.request(h.base, '/api/analysis/601009?range=1y');
    ok(r4b.status === 404, `A4-2 quote+history 双失败首次 → HTTP ${r4b.status}（期望 404，明确错误不冒充成功）`);
    ok(r4b.body && typeof r4b.body.error === 'string', 'A4-2 错误体明确');
  } catch (e) {
    fail++;
    console.log('  ✗ A 组异常中断：' + e.message);
    if (h) console.log('    子进程 stderr 尾部：' + h.stderrTail().slice(-500));
  } finally {
    if (h && h.child) { try { h.child.kill('SIGKILL'); } catch (e) { console.error('[A] 子进程终止失败:', e.message); } }
    restore();
    H.rmrf(tmp);
  }
  console.log(`\n=== A 组汇总：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
