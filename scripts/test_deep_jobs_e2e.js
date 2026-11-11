/**
 * scripts/test_deep_jobs_e2e.js — P2-1 链路 3：深度分析后台任务状态机 E2E（20261111d · 零网络）
 * ------------------------------------------------------------------------------
 * @test-scope: local —— 零网络，仅 127.0.0.1 独立端口；数据层全部 require.cache 受控桩。
 * 打接口方式：原生 http + Express 独立端口（listen(0) 由 OS 分配），不启动 3005 主服务。
 * 受控数据层：require.cache 把 lib/deep/pipeline.js 换成受控 Promise，
 *             经 lib/deepAnalysis.js 门面取出 deepAnalysis 注入 lib/deepJobManager.js。
 * 重点：
 *   §B  并发去重 —— 3 个同 symbol 并发请求，底层 pipeline 只跑 1 次，所有轮询最终拿到 done。
 *   §E  安全网超时 —— 300s 常量注入为 50ms，验证转 error / 返回 500。
 *   §B2/§E2/§E3/§F/§G —— 先按「期望的正确行为」写断言跑红灯（27 通过 / 5 失败），
 *        坐实 6 个 B2 级缺陷：终态不清理、迟到结果丢弃、内层 timer 泄漏、
 *        error 后永久 500、覆盖旧 job 的并发竞态、落盘异常反向改状态。
 *   §C  服务重启后的状态恢复 —— 丢弃内存 manager 后靠磁盘缓存秒回。
 * 测试桩自身缺陷 B2-T1：§F 曾误用 controlled.reset() 清空 calls，导致「新增次数」基准丢失
 *        出现 -1；已改为只切 mode，不断言被放宽。
 * 运行：node scripts/test_deep_jobs_e2e.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// ── ① 受控 pipeline mock（字面替换 lib/deep/pipeline.js）──
const pipelinePath = require.resolve(path.join(ROOT, 'lib', 'deep', 'pipeline.js'));
const controlled = {
  calls: [], mode: 'resolve', delayMs: 20, resolveHang: null, hangResolvers: [],
  reset(mode, delayMs) {
    this.calls = []; this.mode = mode; this.delayMs = delayMs == null ? 20 : delayMs;
    this.resolveHang = null; this.hangResolvers = [];
  },
};
function mockPipelineDeepAnalysis(symbol, name, quote, history) {
  controlled.calls.push({ symbol, name, at: Date.now() });
  return new Promise((resolve, reject) => {
    if (controlled.mode === 'resolve') {
      setTimeout(() => resolve({ sections: { ok: true }, mock: true, symbol }), controlled.delayMs);
    } else if (controlled.mode === 'hang') {
      // 永不主动完成；按启动顺序保留 resolver，供「超时后底层迟到完成」与「旧 job 污染」验证
      const resolver = (val) => resolve(val || { sections: { ok: true }, late: true, mock: true, symbol });
      controlled.hangResolvers.push(resolver);
      controlled.resolveHang = resolver; // §E2 兼容：指向最新一个
    } else if (controlled.mode === 'reject') {
      setTimeout(() => reject(new Error('底层 pipeline 失败（测试桩）')), controlled.delayMs);
    }
  });
}
require.cache[pipelinePath] = {
  id: pipelinePath, filename: pipelinePath, loaded: true,
  exports: { deepAnalysis: mockPipelineDeepAnalysis },
};
const facade = require(path.join(ROOT, 'lib', 'deepAnalysis.js'));
const { createDeepJobManager } = require(path.join(ROOT, 'lib', 'deepJobManager.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeDeps(overrides) {
  const state = { cacheWrites: [], cached: null, docsCalls: 0 };
  const deps = {
    deepAnalysis: facade.deepAnalysis,
    getQuote: async () => ({ name: '测试股', price: 10 }),
    getHistory: async () => ([]),
    detectMarket: () => ({ tencentCode: 'sh600001' }),
    readAnalysisCache: () => null,
    writeAnalysisCache: (symbol, result) => { state.cacheWrites.push({ symbol, result }); state.cached = result; },
    getLocalDocuments: () => { state.docsCalls++; return []; },
    attachDeepAICache: () => {},
    logger: { log() {}, error() {} },
  };
  return { state, deps: Object.assign(deps, overrides || {}) };
}

async function startServer(manager) {
  const app = express();
  app.get('/api/deep-analysis/:symbol', manager.handler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
const closeServer = s => new Promise(resolve => s.close(resolve));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch (e) { body = buf; }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}
async function pollUntilSettled(port, symbol, maxMs = 1500) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    last = await get(port, '/api/deep-analysis/' + symbol);
    if (last.status === 500 || (last.body && (last.body.background === true || last.body.fromCache === true))) return last;
    await sleep(12);
  }
  return last;
}

(async () => {
  const opened = [];
  try {
    section('§0 受控接线自检');
    ok(facade.deepAnalysis === mockPipelineDeepAnalysis, 'lib/deep/pipeline.js 已被受控 Promise 替换（经门面透出）');
    ok(typeof createDeepJobManager === 'function', 'lib/deepJobManager.js 可独立挂载');
    // 守卫假绿：quick 模式曾把本 E2E 误判为「需网络」跳过，125/125 里根本没跑它
    {
      const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run_all_tests.js'), 'utf8');
      const selfSrc = fs.readFileSync(__filename, 'utf8');
      const m = runnerSrc.match(/function needsNetwork\(src\) \{[\s\S]*?\n\}/);
      let classified = null;
      try {
        const box = {};
        vm.createContext(box);
        vm.runInContext((m ? m[0] : '') + '\nthis.result = needsNetwork(' + JSON.stringify(selfSrc) + ');', box);
        classified = box.result;
      } catch (e) { classified = 'ERR: ' + (e && e.message); }
      ok(classified === false,
        'run_all_tests 分类器对本 E2E 判定 net=false（quick 模式真跑，不是假绿），实际 ' + classified);
    }

    /* ══════════════ §A 基本流转 ══════════════ */
    section('§A running → done（单次请求）');
    {
      controlled.reset('resolve', 20);
      const { deps, state } = makeDeps();
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 1000, innerTimeoutMs: 900 }));
      const s = await startServer(mgr); opened.push(s.server);
      const r1 = await get(s.port, '/api/deep-analysis/600001');
      ok(r1.status === 200 && r1.body && r1.body.status === 'running', '首请求秒回 status=running（不阻塞等待）');
      ok(controlled.calls.length === 1, '后台任务已启动，pipeline 调用 1 次');
      const fin = await pollUntilSettled(s.port, '600001');
      ok(fin && fin.status === 200 && fin.body.background === true && fin.body.mock === true,
        '轮询最终拿到 done 结果体（background=true）');
      ok(mgr.jobs.get('600001').status === 'done', '内部 job.status=done');
      ok(state.cacheWrites.length === 1, '结果写磁盘缓存 1 次');
      await closeServer(s.server); opened.pop();
    }

    /* ══════════════ §B 并发去重（用户重点） ══════════════ */
    section('§B 并发去重：3 个同 symbol 并发 + 3 路轮询');
    {
      controlled.reset('resolve', 60);
      const { deps, state } = makeDeps();
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 1000, innerTimeoutMs: 900 }));
      const s = await startServer(mgr); opened.push(s.server);
      const U = '/api/deep-analysis/600002';
      const rs = await Promise.all([get(s.port, U), get(s.port, U), get(s.port, U)]);
      ok(rs.length === 3 && rs.every(r => r.status === 200 && r.body && r.body.status === 'running'),
        '3 个并发请求全部秒回 running');
      ok(controlled.calls.length === 1, '底层 pipeline 只跑 1 次（实际 ' + controlled.calls.length + '）');
      ok(mgr.jobs.size === 1, '_deepJobs 中只有 1 个任务对象');
      const finals = await Promise.all([
        pollUntilSettled(s.port, '600002'), pollUntilSettled(s.port, '600002'), pollUntilSettled(s.port, '600002'),
      ]);
      ok(finals.every(r => r && r.status === 200 && r.body.background === true && r.body.mock === true),
        '3 路轮询最后都拿到 done 结果（无一路卡在 running / 拿到 500）');
      ok(controlled.calls.length === 1, '并发 + 全程轮询期间 pipeline 仍只跑 1 次（实际 ' + controlled.calls.length + '）');
      ok(state.cacheWrites.length === 1, '结果只落盘 1 次');
      await closeServer(s.server); opened.pop();
    }

    /* ══════════════ §B2 B2-1：状态清理遗漏 ══════════════ */
    section('§B2 状态清理：终态过期后应能重新计算（B2-1）');
    {
      controlled.reset('resolve', 10);
      const { deps } = makeDeps();
      // 注入 doneTtlMs=0 精确表达「磁盘缓存被判失效 + 内存结果已过保鲜期」的场景；
      // 默认 5min 的去重窗口由 §A/§B 覆盖。断言语义未放宽，仍要求重算 1 次。
      const mgr = createDeepJobManager(Object.assign({}, deps, {
        timeoutMs: 1000, innerTimeoutMs: 900, doneTtlMs: 0,
      }));
      const s = await startServer(mgr); opened.push(s.server);
      const r0 = await get(s.port, '/api/deep-analysis/600003');
      await sleep(40);
      const firstJob = mgr.jobs.get('600003');
      ok(controlled.calls.length === 1 && firstJob && firstJob.status === 'done', '第一轮完成');
      // 不用 pollUntilSettled：TTL=0 下轮询自身会不断触发重建，改用 sleep 精确控制请求次数
      const r = await get(s.port, '/api/deep-analysis/600003');
      await sleep(40);
      ok(controlled.calls.length === 2,
        '终态过期后同参数请求应重新计算（实际 pipeline 累计 ' + controlled.calls.length + ' 次，1 次=内存 done job 被永久复用）');
      ok(r0.status === 200 && r.status === 200, '两轮请求均不应报错');
      ok(mgr.jobs.get('600003') !== firstJob, 'Map 中旧终态对象已被清理并换成新 job（状态清理实证）');
      await closeServer(s.server); opened.pop();
    }

    /* ══════════════ §C 服务重启后的状态恢复 ══════════════ */
    section('§C 重启恢复：内存任务表清空后靠磁盘缓存秒回');
    {
      controlled.reset('resolve', 10);
      const { deps, state } = makeDeps();
      const mgr1 = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 1000, innerTimeoutMs: 900 }));
      const s1 = await startServer(mgr1); opened.push(s1.server);
      await get(s1.port, '/api/deep-analysis/600004');
      await pollUntilSettled(s1.port, '600004');
      ok(state.cached && state.cached.mock === true, '重启前结果已落盘');
      await closeServer(s1.server); opened.pop();

      const d2 = makeDeps({ readAnalysisCache: () => state.cached });
      const mgr2 = createDeepJobManager(Object.assign({}, d2.deps, { timeoutMs: 1000, innerTimeoutMs: 900 }));
      const s2 = await startServer(mgr2); opened.push(s2.server);
      const callsBefore = controlled.calls.length;
      const r = await get(s2.port, '/api/deep-analysis/600004');
      ok(mgr2.jobs.size === 0, '新进程内存任务表为空（Map 不跨重启）');
      ok(r.status === 200 && r.body.fromCache === true, '重启后靠磁盘缓存秒回（fromCache=true）');
      ok(controlled.calls.length === callsBefore, '重启后未无谓重跑 pipeline（实际新增 ' + (controlled.calls.length - callsBefore) + ' 次）');
      await closeServer(s2.server); opened.pop();
    }

    /* ══════════════ §E 安全网超时（用户重点） ══════════════ */
    section('§E 300s 安全网注入 50ms → error');
    let hangCtx = null;
    {
      controlled.reset('hang');
      const { deps, state } = makeDeps();
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 50, innerTimeoutMs: 5000 }));
      const s = await startServer(mgr); opened.push(s.server);
      hangCtx = { mgr, s, state };
      const r1 = await get(s.port, '/api/deep-analysis/600005');
      ok(r1.status === 200 && r1.body.status === 'running', '超时前返回 running');
      await sleep(110);
      const r2 = await get(s.port, '/api/deep-analysis/600005');
      ok(r2.status === 500 && /超时/.test(String(r2.body && r2.body.error || '')),
        '50ms 后转 error、HTTP 500 且错误文案含「超时」（实际 ' + r2.status + ' ' + JSON.stringify(r2.body) + '）');
      ok(mgr.jobs.get('600005').status === 'error', '内部 job.status=error');
      ok(controlled.calls.length === 1, '超时期间未重复启动底层任务');
    }

    /* ══════════════ §E2 B2 已修复：超时后任务泄漏 / 结果被丢弃 ══════════════ */
    section('§E2 超时后底层仍在跑 → 迟到结果不应被静默丢弃（B2 已修复）');
    {
      const { mgr, s, state } = hangCtx;
      ok(typeof controlled.resolveHang === 'function', '底层受控 Promise 仍可完成（证明超时未取消底层任务）');
      controlled.resolveHang();
      await sleep(40);
      ok(state.cacheWrites.length === 1,
        '超时后底层算完的结果仍写入磁盘缓存（实际 ' + state.cacheWrites.length + ' 次，0=已算完的计算被丢弃）');
      ok(mgr.jobs.get('600005').status === 'error', '迟到结果不得把已终态的 job 反向改回 done');
      await closeServer(s.server); opened.pop();
    }

    /* ══════════════ §E3 B2 已修复：内层 race timer 从不 clear ══════════════ */
    section('§E3 定时器清理（B2 已修复：Promise.race 内层 timer 泄漏）');
    {
      controlled.reset('resolve', 10);
      const { deps } = makeDeps();
      const stats = { created: 0, cleared: 0 };
      const tracked = new Set();
      const realST = global.setTimeout, realCT = global.clearTimeout;
      global.setTimeout = function (fn, ms, ...a) {
        const t = realST(fn, ms, ...a);
        if (ms === 1000 || ms === 900) { stats.created++; tracked.add(t); }
        return t;
      };
      global.clearTimeout = function (t) {
        if (t && tracked.has(t)) { stats.cleared++; tracked.delete(t); }
        return realCT(t);
      };
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 1000, innerTimeoutMs: 900 }));
      const s = await startServer(mgr);
      await get(s.port, '/api/deep-analysis/600006');
      await new Promise(r => realST(r, 80));
      await closeServer(s.server);
      global.setTimeout = realST; global.clearTimeout = realCT;
      ok(stats.created === 2, '正常完成路径创建 2 个超时定时器（外层安全网 + 内层 race，实际 ' + stats.created + '）');
      ok(stats.cleared === 2, '2 个定时器都被 clear（实际 ' + stats.cleared + '，1=内层 race timer 泄漏）');
    }

    /* ══════════════ §F B2 已修复：error 后同参数永久 500 ══════════════ */
    section('§F error 后同参数请求应可重试（B2 已修复）');
    {
      controlled.reset('resolve', 10);
      const { deps } = makeDeps();
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 50, innerTimeoutMs: 5000 }));
      const s = await startServer(mgr); opened.push(s.server);
      controlled.mode = 'hang'; // 先制造超时
      await get(s.port, '/api/deep-analysis/600007');
      await sleep(90);
      const errResp = await get(s.port, '/api/deep-analysis/600007');
      ok(errResp.status === 500, '前置：第一次确已超时为 500');
      const callsBefore = controlled.calls.length;
      // B2-T1（测试桩自身缺陷）：原用 controlled.reset() 切回 resolve，会清空 calls 导致
      // 「新增次数」基准丢失出现 -1。只切 mode/delayMs、保留计数，断言语义不放宽。
      controlled.mode = 'resolve'; controlled.delayMs = 10;
      const retry = await pollUntilSettled(s.port, '600007', 600);
      ok(retry && retry.status === 200 && (retry.body.background === true || retry.body.status === 'running'),
        'error 后同参数请求应能重新启动任务，不永久 500（实际 ' + (retry && retry.status) + '）');
      ok(controlled.calls.length === callsBefore + 1,
        '重试确实触发了一次新的底层计算（实际新增 ' + (controlled.calls.length - callsBefore) + ' 次）');
      await closeServer(s.server); opened.pop();
    }

    /* ══════════════ §G B2-5：并发竞态（旧 job 迟到结果污染新 job） ══════════════ */
    section('§G 并发竞态：旧 job 迟到结果不得污染新 job（B2-5）');
    {
      controlled.reset('hang');
      const { deps, state } = makeDeps();
      const mgr = createDeepJobManager(Object.assign({}, deps, { timeoutMs: 300, innerTimeoutMs: 5000 }));
      const s = await startServer(mgr); opened.push(s.server);
      const r1 = await get(s.port, '/api/deep-analysis/600008');
      ok(r1.status === 200 && r1.body.status === 'running', '前置：第一个任务 running');
      await sleep(340);
      const errResp = await get(s.port, '/api/deep-analysis/600008');
      ok(errResp.status === 500 && mgr.jobs.get('600008').status === 'error', '第一个任务超时并投递 500');
      const retry = await get(s.port, '/api/deep-analysis/600008');
      await sleep(15);
      ok(retry.status === 200 && retry.body.status === 'running' && controlled.hangResolvers.length === 2,
        '错误投递后重建第二个任务（实际底层启动 ' + controlled.hangResolvers.length + ' 次）');
      // 第一个 job 的迟到结果到达（此时它已被第二个 job 覆盖、标记 superseded）
      controlled.hangResolvers[0]({ sections: { ok: true }, stale: true, mock: true, symbol: '600008' });
      await sleep(40);
      ok(state.cacheWrites.length === 0,
        '旧 job 迟到结果未落盘（0=不覆盖新结果，实际 ' + state.cacheWrites.length + ' 次）');
      ok(mgr.jobs.get('600008').status === 'running', '旧 job 迟到结果未把新 job 改成 done/error');
      // 第二个 job 正常完成，验证新结果仍可落盘
      controlled.hangResolvers[1]({ sections: { ok: true }, fresh: true, mock: true, symbol: '600008' });
      await sleep(40);
      ok(state.cacheWrites.length === 1 && state.cacheWrites[0].result.fresh === true,
        '新 job 结果正常落盘且为最新结果');
      await closeServer(s.server); opened.pop();
    }
  } catch (e) {
    ok(false, '主流程异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    for (const s of opened) { try { s.close(); } catch (e) { /* 已关闭 */ } }
    console.log('\n===== 链路 3 状态机 E2E：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
  }
})();
