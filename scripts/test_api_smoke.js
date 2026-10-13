/**
 * API 冒烟测试（零依赖，子进程 spawn server.js 于随机端口）
 * --------------------------------------------------------------
 * 运行： node scripts/test_api_smoke.js
 * - 不与常驻 3005 冲突：随机高位端口 + 仅监听 127.0.0.1
 * - 就绪探测：轮询 /api/health 至 200（上限 30s）
 * - 断言：核心本地 API 端点返回 <500（服务存活且未崩）；
 *         FRONTEND_BUST_FILES 静态资源全部 200（前端资源可服务）
 * - 结束 kill 子进程，不引 supertest（零依赖、贴合既有惯例）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT = 30000;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

// 解析 FRONTEND_BUST_FILES（与缓存破坏守卫同源逻辑）
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const bustMatch = serverSrc.match(/FRONTEND_BUST_FILES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
const bustSet = new Set();
if (bustMatch) {
  (bustMatch[1].match(/'([^']+)'/g) || []).forEach(i => bustSet.add(i.slice(1, -1)));
}

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}

function waitReady() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const code = await get('/api/health');
      if (code === 200) return resolve(true);
      if (Date.now() - t0 > READY_TIMEOUT) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

// 核心本地端点（不依赖外网/个股参数，读本地 data/ 即可响应）
const API_PATHS = [
  '/api/health',
  '/',
  '/api/db/health',
  '/api/watchlist',
  '/api/notes',
  '/api/sentiment-accuracy/records',
  '/api/tech-face/records',
  '/api/market-tech/records',
  '/api/sameday-judgment/records',
  '/api/relevance-learning',
];

(async () => {
  console.log(`\n=== API 冒烟测试（端口 ${PORT}，仅 127.0.0.1）===`);
  const child = spawn(NODE, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SA_NO_BG_AI: '1', SA_NO_AUTO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  const ready = await waitReady();
  if (!ready) {
    console.error('服务未在 30s 内就绪。最后日志：\n' + serverLog.slice(-800));
    cleanup();
    process.exit(1);
  }
  ok(true, '服务就绪（/api/health 返回 200）');

  // 校验 health 体
  const health = await new Promise((resolve) => {
    http.get(BASE + '/api/health', (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  ok(health && health.status === 'ok' && !!health.version, `health 含 status+version（version=${health && health.version}）`);

  // 核心 API 端点存活检测
  console.log('\n[API 端点存活]');
  for (const p of API_PATHS) {
    const code = await get(p);
    ok(code >= 200 && code < 500, `${p} → ${code}`);
  }

  // 静态资源（FRONTEND_BUST_FILES）必须 200
  console.log(`\n[静态资源 FRONTEND_BUST_FILES · ${bustSet.size} 项]`);
  let staticFail = 0;
  for (const entry of bustSet) {
    const code = await get('/' + entry);
    if (code !== 200) { staticFail++; fail++; console.log(`  ✗ /${entry} → ${code}`); }
    else pass++;
  }
  ok(staticFail === 0, `BUST 静态资源全部 200（${bustSet.size - staticFail}/${bustSet.size}）`);

  cleanup();
  console.log(`\n===== API 冒烟：通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
