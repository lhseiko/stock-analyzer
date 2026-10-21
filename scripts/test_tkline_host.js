/**
 * 腾讯 K 线「主机族」降级 · 回归测试（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_tkline_host.js
 * 背景（2026-10-21 实测）：`ifzq.gtimg.cn/appstock/app/fqkline/get` 对**所有代码**整段返回 501
 * （sh000001 / sz399001 / sh600519 / sz000902 全 501），而同一路径在 `web.ifzq.gtimg.cn` 返回 200。
 * 写死单主机时，个股日K、大盘技术分析、市场情绪量价因子、准确率结算会同时降级，
 * 日志里只有一条 `Request failed with status code 501`，极易被误当成业务 bug。
 *
 * 覆盖（20261021g）：
 *   [1] 第一台主机 5xx → 自动切第二台并返回其响应体
 *   [2] 第一台正常 → 不触碰第二台（省一次请求）
 *   [3] 两台都失败 → 抛最后一台的错误（不吞）
 *   [4] 4xx（参数错误）→ 不换主机（换也没用，避免无谓重试）
 *   [5] 主机顺序可解释：先 ifzq 后 web.ifzq
 *   [6] 接线守卫：所有 fqkline 调用点都走 getKlineJson，源码里不再有裸 ifzq fqkline URL
 */
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { getKlineJson, KLINE_HOSTS } = require('../lib/tklineHost');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const origGet = axios.get;
function stubGet(handler) { axios.get = handler; }
function restore() { axios.get = origGet; }

const errWith = (status) => Object.assign(new Error('Request failed with status code ' + status), { response: { status } });

(async () => {
  console.log('\n[1] 第一台 501 → 自动切第二台');
  {
    const calls = [];
    stubGet(async (url) => {
      calls.push(url);
      if (url.includes('//ifzq.')) throw errWith(501);
      return { data: { data: { sh000001: { day: [['2026-10-21', 1, 2]] } }, via: 'web' } };
    });
    const d = await getKlineJson('/appstock/app/fqkline/get?param=sh000001,day,,,320,qfq', { timeout: 1000 });
    restore();
    eq(calls.length, 2, '共请求 2 次（第一台失败后切第二台）');
    ok(calls[0].startsWith('https://ifzq.gtimg.cn'), '先打 ifzq');
    ok(calls[1].startsWith('https://web.ifzq.gtimg.cn'), '再打 web.ifzq');
    eq(d.via, 'web', '返回的是第二台的响应体（未被改写）');
    ok(calls.every(u => u.includes('/appstock/app/fqkline/get?param=sh000001,day,,,320,qfq')), '两台的路径与参数完全一致（只换主机）');
  }

  console.log('\n[2] 第一台正常 → 不请求第二台');
  {
    const calls = [];
    stubGet(async (url) => { calls.push(url); return { data: { via: 'ifzq' } }; });
    const d = await getKlineJson('/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq', {});
    restore();
    eq(calls.length, 1, '只请求 1 次');
    eq(d.via, 'ifzq', '用第一台的数据');
  }

  console.log('\n[3] 两台都失败 → 抛错（不吞、不返回空）');
  {
    stubGet(async () => { throw errWith(502); });
    let err = null;
    try { await getKlineJson('/x', {}); } catch (e) { err = e; }
    restore();
    ok(err && /502/.test(err.message), '抛出最后一台的错误（含状态码）');
  }

  console.log('\n[4] 4xx（参数错）→ 不换主机');
  {
    const calls = [];
    stubGet(async (url) => { calls.push(url); throw errWith(400); });
    let err = null;
    try { await getKlineJson('/x', {}); } catch (e) { err = e; }
    restore();
    eq(calls.length, 1, '4xx 不重试第二台（换主机也救不了参数错误）');
    ok(err && /400/.test(err.message), '原样抛出 400');
  }

  console.log('\n[5] 主机顺序');
  {
    eq(KLINE_HOSTS[0], 'https://ifzq.gtimg.cn', '第一台 ifzq');
    eq(KLINE_HOSTS[1], 'https://web.ifzq.gtimg.cn', '第二台 web.ifzq');
    eq(KLINE_HOSTS.length, 2, '只有两台，不做无意义扩列');
  }

  console.log('\n[6] 接线守卫：fqkline 调用点全部走主机降级');
  {
    const files = ['lib/stockData.js', 'lib/marketTechnical.js', 'lib/marketTechJudgment.js', 'lib/deep/yield.js', 'server.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const bareHits = (src.match(/https:\/\/ifzq\.gtimg\.cn\/appstock\/app\/fqkline/g) || []).length;
      eq(bareHits, 0, `${f} 无裸 ifzq fqkline URL`);
    }
    for (const f of ['lib/stockData.js', 'lib/marketTechnical.js', 'lib/marketTechJudgment.js', 'lib/deep/yield.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      ok(/require\(['"]\.{1,2}\/tklineHost['"]\)/.test(src), `${f} 引入 tklineHost`);
      ok(src.includes('getKlineJson('), `${f} 调用了 getKlineJson`);
    }
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(/web\.ifzq\.gtimg\.cn/.test(srv), 'server.js 的内置探活同样带第二台主机');
    ok(/mkline/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechnical.js'), 'utf8')),
      'mkline/minute 等未受影响的分支保持原样（只改 fqkline）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
