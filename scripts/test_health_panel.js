#!/usr/bin/env node
/**
 * test_health_panel.js — P2-2 可观测性守卫（20261111f）
 * @test-scope: local （显式零网络声明：全真跑本地 express + http，needsNetwork 必须 false）
 * ==============================================================
 * §A 中间件真跑（mini express 真端口）：JSONL 行字段契约 / route 不含 query / 无 body 字段 /
 *    degraded 埋点经 AsyncLocalStorage 关联 + 同请求同源去重 / 异常 status 记录
 * §B markDegraded 无请求上下文（定时任务路径）静默忽略不抛错
 * §C cleanupOldLogs：只删超过 30 天的 requests-*.jsonl，不碰其它命名文件
 * §D aggregateDashboard：窗口过滤（35 天前行不计）/ 坏行 parseErrors / errorRate / avgDurationMs /
 *    degradedBySource 聚合 / 空目录全 0 不伪造
 * §E 接线静态断言：server.js 中间件挂载 + dashboard 路由 + 启动清理 + FRONTEND_BUST_FILES；
 *    stockData.js 埋点四源齐备；index.html 卡片/脚本/脚注；app.js init + 首次默认折叠；
 *    healthPanel.js 脚注兜底；requestLogger 源码防泄露守卫（无 req.body 记录）
 */
// @test-scope: local
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ---- SA_LOGS_DIR 必须在 require requestLogger 之前设置（测试隔离） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-health-test-'));
process.env.SA_LOGS_DIR = TMP;
const rl = require('../lib/requestLogger');

let passed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { console.error(`  ❌ ${name}`); process.exitCode = 1; }
}

function httpGet(port, p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    }).on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = fn(); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

const ALLOWED_KEYS = new Set(['ts', 'reqId', 'method', 'route', 'status', 'durationMs', 'degraded', 'degradedSources', 'aborted']);

(async () => {
  // ===== §A 中间件真跑 =====
  console.log('§A 中间件真跑（express + 真端口 + AsyncLocalStorage 埋点）');
  const express = require('express');
  const app = express();
  app.use('/api', rl.middleware);
  app.get('/api/ok', (req, res) => res.json({ ok: true }));
  app.get('/api/ok2', (req, res) => res.json({ ok: true })); // 入站 X-Request-Id 复用验证用
  app.get('/api/thing/:code', (req, res) => res.json({ ok: true })); // route 归一化验证用（动态代码段）
  app.get('/api/thing/:code/:date', (req, res) => res.json({ ok: true })); // 日期段归一化验证用
  app.get('/api/slow', (req, res) => setTimeout(() => res.json({ ok: 1 }), 800)); // aborted 验证用
  app.get('/api/degraded', (req, res) => {
    rl.markDegraded('sina');
    rl.markDegraded('eastmoney');
    rl.markDegraded('sina'); // 同请求同源 → 去重为一次
    res.json({ ok: true });
  });
  app.get('/api/boom', (req, res) => res.status(500).json({ error: 'x' }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;

  const r1 = await httpGet(port, '/api/ok?secret=SHOULD_NOT_LOG');
  await httpGet(port, '/api/thing/601318?token=abc');
  await httpGet(port, '/api/thing/601318/2026-11-10');
  const r4 = await httpGet(port, '/api/ok2', { 'X-Request-Id': 'custom-reqid-12345678' }); // 入站合法 reqId 复用验证
  await httpGet(port, '/api/degraded?token=abc');
  await httpGet(port, '/api/boom');
  // aborted：客户端在 800ms 慢任务中途(100ms)主动断开（受控实验已证 finish 不触发、close 触发）
  await new Promise(resolve => {
    const req2 = http.get({ host: '127.0.0.1', port, path: '/api/slow' }, r => r.resume());
    req2.on('error', () => {});
    setTimeout(() => { req2.destroy(); resolve(); }, 100);
  });

  const todayFile = path.join(TMP, `requests-${require('../lib/localDate').localCompact()}.jsonl`);
  const raw = await waitFor(() => {
    try {
      const lines = fs.readFileSync(todayFile, 'utf8').split('\n').filter(s => s.trim());
      return lines.length >= 7 ? lines : null; // 6 条完成 + 1 条 aborted 兜底行
    } catch { return null; }
  });
  ok(Array.isArray(raw) && raw.length === 7, `jsonl 恰好 7 行（6 完成 + 1 断开兜底；实际 ${raw ? raw.length : 0}）`);
  const recs = raw.map(s => JSON.parse(s));

  ok(recs.every(r => Object.keys(r).every(k => ALLOWED_KEYS.has(k))),
    '每行字段全部落在白名单 {ts,reqId,method,route,status,durationMs,degraded,degradedSources,aborted}（无 body/query 泄露）');
  ok(recs.every(r => !JSON.stringify(r).includes('SHOULD_NOT_LOG') && !JSON.stringify(r).includes('token=abc')),
    'query 字符串（secret/token）零落盘');
  ok(recs.every(r => r.reqId && r.ts && typeof r.durationMs === 'number'), 'ts/reqId/durationMs 齐备');
  const byRoute = Object.fromEntries(recs.map(r => [r.route, r]));
  ok(byRoute['/api/ok'] && byRoute['/api/ok'].status === 200, 'route 不含 query（?secret 未并入 route）');
  ok(!!byRoute['/api/thing/:id'], `动态代码段已归一化：/api/thing/601318 → '/api/thing/:id'`);
  ok(!!byRoute['/api/thing/:id/:date'], `日期段已归一化：/api/thing/601318/2026-11-10 → '/api/thing/:id/:date'`);
  ok(!!byRoute['/api/ok2'] && byRoute['/api/ok2'].reqId === 'custom-reqid-12345678',
    '入站合法 X-Request-Id 被复用为行内 reqId');
  ok(typeof r4.headers['x-request-id'] === 'string' && r4.headers['x-request-id'] === 'custom-reqid-12345678',
    '响应头回写 X-Request-Id（与入站一致）');
  ok(typeof r1.headers['x-request-id'] === 'string' && r1.headers['x-request-id'].length >= 8 && r1.headers['x-request-id'] === byRoute['/api/ok'].reqId,
    '无入站头时生成 reqId 且响应头回写 = 行内 reqId');
  const abortedLine = recs.find(r => r.route === '/api/slow');
  ok(abortedLine && abortedLine.aborted === true && abortedLine.status === 0,
    `客户端中途断开不再丢行：aborted=true / status=0 / durationMs=${abortedLine ? abortedLine.durationMs : '?'}ms（口径局限：aborted 不计入异常率 status≥400）`);
  ok(byRoute['/api/degraded'] && byRoute['/api/degraded'].degraded === true
    && JSON.stringify(byRoute['/api/degraded'].degradedSources) === '["sina","eastmoney"]',
    '降级行 degraded=true + degradedSources 同请求同源去重并保序');
  ok(byRoute['/api/ok'].degraded === undefined, '正常请求无 degraded 标记位（不冗余）');
  ok(byRoute['/api/boom'] && byRoute['/api/boom'].status === 500, '500 异常 status 如实记录');
  srv.close();

  // ===== §B 无请求上下文静默 =====
  console.log('§B markDegraded 无请求上下文（定时任务/预热路径）');
  let threw = false;
  try { rl.markDegraded('sina'); rl.markDegraded(null); } catch { threw = true; }
  ok(!threw, '无 ALS 上下文直接调用不抛错、静默忽略');

  // ===== §C 启动清理 =====
  console.log('§C cleanupOldLogs（30 天阈值）');
  const oldTs = Date.now() - 31 * 86400 * 1000;
  const olderTs = Date.now() - 40 * 86400 * 1000;
  const mk = (name, mtime) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '{}\n');
    fs.utimesSync(p, new Date(mtime), new Date(mtime)); // Windows 下 utimesSync 数字时间戳会 EINVAL，必须传 Date
    return p;
  };
  mk('requests-20260901.jsonl', oldTs);      // 31 天前 → 删
  mk('requests-20260801.jsonl', olderTs);    // 40 天前 → 删
  mk('requests-20990101.jsonl', Date.now()); // 未来命名（mtime 今天）→ 留
  mk('server.log', oldTs);                   // 非 requests- 前缀 → 不碰
  const removed = rl.cleanupOldLogs(30);
  ok(removed.length === 2 && removed.includes('requests-20260901.jsonl') && removed.includes('requests-20260801.jsonl'),
    `恰删除 2 个超期 requests-*.jsonl（实际 ${removed.join(', ')}）`);
  ok(fs.existsSync(path.join(TMP, 'requests-20990101.jsonl')), '当日/未来文件保留');
  ok(fs.existsSync(path.join(TMP, 'server.log')), '非 requests- 命名的文件一律不碰');

  // ===== §D 聚合 =====
  console.log('§D aggregateDashboard（近 7 天窗口 / 坏行 / 降级聚合）');
  // 基线：§A 已写入 7 行（6 完成：5×200 + 1×500 含 1 条 sina+eastmoney 降级；1 断开 aborted status 0 不计入异常）。
  // 追加：2 天前 2 行（1×200 耗时 100ms、1×503 含 yahoo 降级）+ 1 坏行 + 1 行 35 天前（超窗，文件名当期但 ts 超窗）。
  const d2 = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
  const d35 = new Date(Date.now() - 35 * 86400 * 1000).toISOString();
  fs.appendFileSync(todayFile, [
    JSON.stringify({ ts: d2, reqId: 'a2', method: 'GET', route: '/api/x', status: 200, durationMs: 100 }),
    JSON.stringify({ ts: d2, reqId: 'a3', method: 'GET', route: '/api/y', status: 503, durationMs: 300, degraded: true, degradedSources: ['yahoo'] }),
    '{broken json',
    JSON.stringify({ ts: d35, reqId: 'a4', method: 'GET', route: '/api/old', status: 500, durationMs: 999 }),
  ].join('\n') + '\n');

  const sumA = recs.reduce((s, r) => s + r.durationMs, 0);
  const agg = rl.aggregateDashboard(7);
  ok(agg.totalCalls === 9, `总调用数 = 9（7 实跑 + 2 追加；实际 ${agg.totalCalls}）`);
  ok(agg.parseErrors === 1, `坏行 parseErrors = 1（实际 ${agg.parseErrors}）`);
  ok(agg.errorCount === 2 && agg.errorRate === 22.22, `异常 2 次 / 22.22%（boom 500 + 503；aborted status 0 不计——口径局限如实固化；实际 ${agg.errorCount} / ${agg.errorRate}%）`);
  ok(agg.avgDurationMs === Math.round((sumA + 400) / 9),
    `平均耗时含全部窗口内行（实际 ${agg.avgDurationMs}）`);
  ok(agg.degradedCount === 2 && agg.degradedBySource.sina === 1 && agg.degradedBySource.eastmoney === 1 && agg.degradedBySource.yahoo === 1,
    `降级 2 次请求、按源计数 sina/eastmoney/yahoo 各 1（实际 ${JSON.stringify(agg.degradedBySource)}）`);
  ok(agg.writeFailures === 0 && typeof agg.writeFailures === 'number', `dashboard 输出 writeFailures 计数字段（实际 ${agg.writeFailures}）`);
  ok(agg.effectiveFrom === '2026-11-11', 'effectiveFrom=2026-11-11（脚注口径下发）');
  ok(agg.files >= 1, `扫描文件数如实（${agg.files} 个）`);

  // ===== §E 接线静态断言 =====
  console.log('§E 接线静态断言');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/app\.use\('\/api', requestLogger\.middleware\)/.test(serverSrc), 'server.js：requestLogger 中间件挂载于 /api');
  ok(/app\.get\('\/api\/health\/dashboard'/.test(serverSrc), 'server.js：GET /api/health/dashboard 路由');
  ok(/requestLogger\.cleanupOldLogs\(\)/.test(serverSrc), 'server.js：启动清理 cleanupOldLogs 已接线');
  ok(/'\/js\/healthPanel\.js'/.test(serverSrc), 'server.js：healthPanel.js 已入 FRONTEND_BUST_FILES 白名单');

  const sdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stockData.js'), 'utf8');
  ok(sdSrc.includes("require('./requestLogger')"), 'stockData.js：requestLogger 已接入');
  ok(/markDegraded\('eastmoney'\)/.test(sdSrc) && /markDegraded\('sina'\)/.test(sdSrc)
    && /markDegraded\('yahoo'\)/.test(sdSrc) && /markDegraded\('tencent'\)/.test(sdSrc),
    'stockData.js：四源降级埋点齐备（eastmoney/sina/yahoo/tencent）');
  ok((sdSrc.match(/markDegraded\(/g) || []).length >= 8, `埋点调用点 ≥8（实际 ${(sdSrc.match(/markDegraded\(/g) || []).length}，含 require 解构）`);

  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(idxSrc.includes('id="healthCard"') && idxSrc.includes('data-collapsible="true"'), 'index.html：healthCard 卡片（可折叠）');
  ok(idxSrc.includes('js/healthPanel.js?v='), 'index.html：healthPanel.js script 已引入（带 ?v=）');
  ok(idxSrc.includes('自 2026-11-11 起生效，更早日志为纯文本未纳入统计'), 'index.html：脚注文案在位');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(appSrc.includes('HealthPanel.bind()') && appSrc.includes('HealthPanel.load()'), 'app.js：HealthPanel init 接线');
  ok(/defaultCollapsed = \[[^\]]*'healthCard'/.test(appSrc), 'app.js：healthCard 首次默认收起');

  const hpSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'healthPanel.js'), 'utf8');
  ok(hpSrc.includes('自 2026-11-11 起生效，更早日志为纯文本未纳入统计'), 'healthPanel.js：脚注兜底文案在位');
  ok(/writeFailures/.test(hpSrc) && /hp-meta/.test(hpSrc), 'healthPanel.js：writeFailures 在 DOM 渲染逻辑中（元信息行 hp-meta 注入）');

  const rlSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'requestLogger.js'), 'utf8');
  ok(!/req\.body/.test(rlSrc), 'requestLogger 源码零 req.body 引用（防泄露硬守卫）');
  ok(/split\('\?'\)\[0\]/.test(rlSrc), 'route 只取 pathname（query 剥离固化）');
  ok(/function normalizeRoute/.test(rlSrc) && /':id'/.test(rlSrc) && /':date'/.test(rlSrc), 'route 动态段归一化固化（:id/:date）');
  ok(/res\.setHeader\('X-Request-Id', reqId\)/.test(rlSrc) && /x-request-id/i.test(rlSrc), 'X-Request-Id 回写 + 入站校验复用固化');
  ok(/res\.on\('close'/.test(rlSrc) && /aborted/.test(rlSrc), 'close 兜底 aborted 记录固化（不再丢行）');
  ok(/getWriteFailures/.test(rlSrc), '写失败计数导出固化');

  // ---- 清理临时目录 ----
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n===== 汇总：通过 ${passed} 项 ${process.exitCode ? '（存在失败）' : '，全部通过 ✅'} =====`);
})();
