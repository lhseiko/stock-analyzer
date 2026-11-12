'use strict';
/**
 * E2E 共用测试架（scripts/test_analysis_*_e2e.js 四组共用 · 测试脚手架）
 * =====================================================================
 * 职责：临时目录、data/analysis-warm.json 快照恢复（测试请求会经
 * analysisWarm.noteAnalysisRequest 写该文件——收尾恢复原字节，零残留）、
 * 子进程拉起 e2e_boot_analysis.js（吞启动副作用 + 零网络桩）、就绪探测、
 * HTTP 客户端、收尾清理。
 *
 * 环境隔离（第一道：路径重定向——测试写入全部落在临时目录，真实 data/ 不被触碰）：
 *   - SA_LOGS_DIR → 临时 logs 目录（requests jsonl 不写生产 logs/，D 组直接读它）；
 *   - SA_SETTINGS_FILE → 临时 settings.json（C4 growth-caliber 不写生产设置）；
 *   - SA_WARM_PERSIST_FILE → 临时 analysis-warm.json（N5，lib/analysisWarm.js 的
 *     环境变量测试钩子；在此之前的实现只靠快照恢复兜底，2026-11-12 首跑 D 组
 *     未捕获崩溃实证 finally 被跳过 → 桩数据凝固进真实 data/，故补此根治）；
 *   - HTTP(S)_PROXY=127.0.0.1:9 死代理 → 漏网外呼立即本机拒连（零外网兜底）；
 *   - SQLite（lib/db）仍打开生产库，但本组全部只读（GET /api/analysis 不落库）。
 *
 * 第二道保险：下方 snapshot/guardedRestore 快照恢复保留——若未来有人移除
 * analysisWarm 的 SA_WARM_PERSIST_FILE 接线，快照恢复仍能兜住，测试不会静默污染。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WARM_PERSIST = path.join(ROOT, 'data', 'analysis-warm.json');

function makeTmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sa-analysis-e2e-${tag}-`));
}

function snapshotWarmPersist() {
  try { return fs.readFileSync(WARM_PERSIST, 'utf8'); } catch (e) { return null; }
}

let _exitGuardInstalled = false;
let _activeRestore = null;
/**
 * 带崩溃兜底的恢复：正常路径由测试 finally 调返回的 restore()；若测试进程因未捕获
 * 异常崩溃（2026-11-12 首跑 D 组实证：finally 被跳过 → 桩写入凝固在 data/），
 * process 'exit' 钩子兜底执行同一恢复，保证测试对 data/analysis-warm.json 零残留。
 */
function guardedRestore(warmSnap) {
  let restored = false;
  const doRestore = () => { if (!restored) { restored = true; restoreWarmPersist(warmSnap); } };
  if (!_exitGuardInstalled) {
    _exitGuardInstalled = true;
    process.on('exit', () => { try { if (_activeRestore) _activeRestore(); } catch (e) { /* 退出期兜底失败仅提示 */ console.error('[e2e-harness] exit 兜底恢复失败:', e.message); } });
  }
  _activeRestore = doRestore;
  return doRestore;
}

function restoreWarmPersist(snap) {
  try {
    let current = null;
    try { current = fs.readFileSync(WARM_PERSIST, 'utf8'); } catch (e) { /* 文件不存在 */ }
    if (snap === current) return; // 内容已与快照一致（N5 后测试本就不写真实路径）→ 跳过写回，不无谓更新 mtime
    if (snap === null) {
      if (current !== null) { try { fs.unlinkSync(WARM_PERSIST); } catch (e) { console.error('[e2e-harness] 删除测试期 warm 文件失败（无残留风险低）:', e.message); } }
    } else {
      fs.writeFileSync(WARM_PERSIST, snap, 'utf8');
    }
  } catch (e) {
    console.error('[e2e-harness] analysis-warm.json 恢复失败:', e.message);
  }
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('[e2e-harness] 临时目录清理失败（os.tmpdir 下，不影响项目）:', dir, e.message); }
}

/** 拉起被测服务器（吞启动副作用 + 桩）。返回句柄；调用方收尾必须 kill。 */
function spawnServer(tmpRoot) {
  const port = 39200 + Math.floor(Math.random() * 600);
  const logsDir = path.join(tmpRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(__dirname, 'e2e_boot_analysis.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      SA_NO_BG_AI: '1',
      SA_NO_DAILY_AI_REVIEW: '1',
      SA_NO_AUTO_OPEN: '1',
      SA_LOGS_DIR: logsDir,
      SA_SETTINGS_FILE: path.join(tmpRoot, 'settings.json'),
      SA_WARM_PERSIST_FILE: path.join(tmpRoot, 'analysis-warm.json'), // N5：warm 持久化与日志/设置同级隔离
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errBuf = [];
  child.stdout.on('data', () => { /* 防背压 */ });
  child.stderr.on('data', d => { errBuf.push(String(d)); if (errBuf.length > 50) errBuf.shift(); });
  const handle = { child, port, logsDir, base: `http://127.0.0.1:${port}`, stderrTail: () => errBuf.join('') };
  handle.ready = waitReady(handle);
  return handle;
}

function waitReady(h, timeoutMs) {
  const limit = timeoutMs || 30000;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (h.child.exitCode !== null) return reject(new Error('服务器进程提前退出（exit=' + h.child.exitCode + '）：' + h.stderrTail().slice(-800)));
      try {
        const r = await request(h.base, '/api/health');
        if (r.status === 200) return resolve(true);
      } catch (e) { /* 未就绪，继续轮询 */ }
      if (Date.now() - t0 > limit) return reject(new Error('就绪探测超时（' + limit + 'ms）：' + h.stderrTail().slice(-800)));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function request(base, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request(u, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch (e) { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** C5/D3 专用：拿到原始 req 对象，调用方自行 destroy/收尾 */
function rawRequest(base, p, headers) {
  const u = new URL(p, base);
  return http.request(u, { method: 'GET', headers: headers || {} });
}

module.exports = { ROOT, WARM_PERSIST, makeTmpRoot, snapshotWarmPersist, restoreWarmPersist, guardedRestore, rmrf, spawnServer, waitReady, request, rawRequest };
