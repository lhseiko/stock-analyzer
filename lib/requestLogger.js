/**
 * lib/requestLogger.js — P2-2 可观测性（20261111f）
 * ==============================================================
 * 职责四件事：
 *   1. 结构化请求日志中间件：/api 请求逐条写 logs/requests-YYYYMMDD.jsonl，
 *      每行一个 JSON：{ ts, reqId, method, route, status, durationMs[, degraded, degradedSources] }。
 *      ⚠️ 严禁记录 Request/Response Body 与 query string（防泄露 API Key / 隐私数据）——
 *      route 只取 pathname，不含 ? 后内容；body 从不触碰。
 *   2. 降级埋点 markDegraded(source)：lib/stockData.js 等数据层在「主源失败 → 备源接管」
 *      真实回退发生时调用；用 AsyncLocalStorage 关联到发起本次 HTTP 请求的上下文，
 *      该请求的日志行标记 degraded: true + degradedSources: [...]。
 *      无请求上下文（定时任务 / 启动预热 / E2E 直调）时静默忽略，绝不抛错。
 *   3. 启动清理 cleanupOldLogs(30)：删除 logs/ 下 mtime 超过 30 天的 requests-*.jsonl。
 *   4. 面板聚合 aggregateDashboard(7)：读近 7 天 jsonl 逐行解析（坏行计入 parseErrors
 *      跳过，绝不中断），聚合 总调用数 / 异常率(status>=400) / 平均耗时 / 降级总次数 /
 *      各数据源降级次数。供 GET /api/health/dashboard 消费。
 *
 * 设计约束：
 *   - 日志失败永远不影响业务请求（writeLine 全 try/catch 吞掉，只在 stderr 提示一次）；
 *   - 文件流按天懒创建，跨天自动切换；写失败（磁盘满等）不再重试当前行；
 *   - 日期一律用 lib/localDate.js 的中国自然日口径（00:00–07:59 UTC+8 不写错天）；
 *   - SA_LOGS_DIR 环境变量可重定向日志目录（测试隔离用），不影响生产默认 logs/。
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { localCompact } = require('./localDate');

const LOGS_DIR = process.env.SA_LOGS_DIR || path.join(__dirname, '..', 'logs');
const RETENTION_DAYS = 30;   // 启动清理阈值（天）
const DASHBOARD_DAYS = 7;    // 健康面板聚合窗口（天）
const LOG_PREFIX = 'requests-';

const als = new AsyncLocalStorage();

// ---- [20261111f 收口小补] 写失败计数：/api/health 与 /api/health/dashboard 可见（核查项 4）----
let writeFailures = 0;
function getWriteFailures() { return writeFailures; }

// ---- [20261111f 收口小补] route 归一化（核查项 1）：动态段归一为 :id/:date，聚合不被个体代码稀释 ----
// 规则（保守，防误伤）：
//   - 股票代码段（可选 sh/sz/bj 前缀 + 5~8 位数字）→ :id
//   - 日期段 YYYY-MM-DD → :date
//   - UUID → :id
//   - ≥16 位的 [A-Za-z0-9_-] 长 token/hash → :id
//   - 其余段（健康/analysis/search 等字面词、短版本号）原样保留
function normalizeRoute(pathname) {
  return String(pathname || '')
    .split('/')
    .map(seg => {
      if (!seg) return seg;
      if (/^(sh|sz|bj)?\d{5,8}$/.test(seg)) return ':id';                 // 601318 / sh601318 / 20261111
      if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return ':date';                 // 2026-11-10
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) return ':id';
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg)) return ':id';                  // 长 token / 哈希 / 长文件名
      return seg;
    })
    .join('/');
}

// ---- 按天懒创建的追加写流：同一时刻只保留当天的流 ----
let curDateKey = null;
let curStream = null;
let _warnedWriteFail = false;

function ensureStream(dateKey) {
  if (curStream && curDateKey === dateKey) return curStream;
  if (curStream) {
    try { curStream.end(); } catch (e) { console.error('[RequestLogger] 旧日志流关闭失败（不影响新流）:', e && e.message); }
    curStream = null;
  }
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  curDateKey = dateKey;
  curStream = fs.createWriteStream(path.join(LOGS_DIR, `${LOG_PREFIX}${dateKey}.jsonl`), { flags: 'a' });
  curStream.on('error', () => { /* 写失败静默：日志永远不影响业务 */ });
  return curStream;
}

function writeLine(obj) {
  try {
    const line = JSON.stringify(obj) + '\n';
    ensureStream(localCompact()).write(line);
  } catch (e) {
    writeFailures++; // [收口小补] 计数进入 /api/health 与 /api/health/dashboard，不再只 console 提示
    if (!_warnedWriteFail) {
      _warnedWriteFail = true;
      console.error('[RequestLogger] 日志写入失败（仅提示一次，不影响业务）:', e.message);
    }
  }
}

// [收口小补] reqId 来源：入站 X-Request-Id 合法（8~64 位字母数字_-）则复用（跨服务追踪），否则生成
function resolveReqId(inbound) {
  const s = String(inbound || '');
  if (/^[A-Za-z0-9_-]{8,64}$/.test(s)) return s;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * API 请求日志中间件。挂载：app.use('/api', requestLogger.middleware)
 * 只记录 /api 路径（静态资源不记，避免噪音与隐私面扩大）。
 * [收口小补] ① 响应头回写 X-Request-Id；② 客户端中途断开（finish 不触发）经 close 兜底
 * 记录 aborted:true / status 0，不再丢行；③ route 经 normalizeRoute 归一化。
 */
function middleware(req, res, next) {
  const start = Date.now();
  const reqId = resolveReqId(req.headers['x-request-id']);
  const ctx = { reqId, degraded: false, degradedSources: [] };
  res.setHeader('X-Request-Id', reqId); // 回写给调用方（curl -i 可见，便于对账单行日志）
  let written = false;

  const emit = (aborted) => {
    if (written) return; // finish 与 close 只写一行
    written = true;
    try {
      const line = {
        ts: new Date().toISOString(),
        reqId,
        method: req.method,
        route: normalizeRoute((req.originalUrl || req.url || '').split('?')[0]), // 仅 pathname 归一化，不含 query
        // aborted 且响应头未发出时 statusCode 只是 Node 默认值 200，不代表真实响应 → 记 0（无状态码）
        status: aborted ? (res.headersSent ? res.statusCode : 0) : res.statusCode,
        durationMs: Date.now() - start,
      };
      if (aborted) line.aborted = true; // 客户端中途断开：未等到响应完成
      if (ctx.degraded) {
        line.degraded = true;
        line.degradedSources = [...new Set(ctx.degradedSources)]; // 同请求同源只记一次
      }
      writeLine(line);
    } catch (e) { console.error('[RequestLogger] finish 记录异常（不影响响应）:', e && e.message); }
  };

  res.on('finish', () => emit(false));
  // 受控实验实证：客户端在任务中途断开时 finish 不触发（false）、close 触发（true）→ 必须挂 close 兜底
  res.on('close', () => { if (!res.writableEnded) emit(true); });

  als.run(ctx, next);
}

/**
 * 降级埋点：数据层真实发生「主源失败 → 备源接管」回退时调用。
 * source 使用规范化键：'tencent' | 'eastmoney' | 'sina' | 'yahoo'（面板按此聚合）。
 * 长窗口设计性主路径（如 >800 根 60m 走新浪，腾讯无该能力）不算降级，不埋点。
 */
function markDegraded(source) {
  const ctx = als.getStore();
  if (!ctx || !source) return; // 无请求上下文（定时任务/启动预热/E2E 直调）→ 静默忽略
  ctx.degraded = true;
  ctx.degradedSources.push(String(source));
}

/**
 * 启动清理：删除 logs/ 下 mtime 超过 days 天的 requests-*.jsonl。
 * 只匹配 requests-YYYYMMDD.jsonl 命名，不碰目录里其它文件（server.log 等）。
 * 返回被删除的文件名数组（供启动日志输出）。
 */
function cleanupOldLogs(days = RETENTION_DAYS) {
  const removed = [];
  try {
    if (!fs.existsSync(LOGS_DIR)) return removed;
    const cutoff = Date.now() - days * 86400 * 1000;
    for (const f of fs.readdirSync(LOGS_DIR)) {
      if (!new RegExp(`^${LOG_PREFIX}\\d{8}\\.jsonl$`).test(f)) continue;
      const p = path.join(LOGS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed.push(f);
        }
      } catch (e) { console.error(`[RequestLogger] 清理单个文件失败（跳过）: ${f}`, e && e.message); }
    }
  } catch (e) { console.error('[RequestLogger] 日志目录不可读，清理中止:', e && e.message); }
  return removed;
}

/**
 * 健康面板聚合：扫描 logs/ 全部 requests-*.jsonl，逐行 JSON 解析，
 * 只统计 ts 落在近 days 天窗口内的行。坏行计入 parseErrors 后跳过（不中断）。
 * 返回：
 *   { days, windowStart, totalCalls, errorCount, errorRate, avgDurationMs,
 *     degradedCount, degradedBySource: {eastmoney,sina,yahoo,tencent,...},
 *     parseErrors, files, effectiveFrom }
 * SA_LOGS_DIR 可重定向（测试）；目录不存在时返回全 0 空态（不伪造数据）。
 */
function aggregateDashboard(days = DASHBOARD_DAYS) {
  const now = Date.now();
  const windowStart = now - days * 86400 * 1000;
  const agg = {
    days,
    windowStart: new Date(windowStart).toISOString(),
    totalCalls: 0,
    errorCount: 0,
    errorRate: 0,
    avgDurationMs: 0,
    degradedCount: 0,
    degradedBySource: {},
    writeFailures: getWriteFailures(), // [收口小补] 日志写失败累计次数（进程生命周期内），可观测
    parseErrors: 0,
    files: 0,
    effectiveFrom: '2026-11-11',
  };
  try {
    if (!fs.existsSync(LOGS_DIR)) return agg;
    const names = fs.readdirSync(LOGS_DIR)
      .filter(f => new RegExp(`^${LOG_PREFIX}\\d{8}\\.jsonl$`).test(f))
      .sort();
    let durationSum = 0;
    for (const f of names) {
      const p = path.join(LOGS_DIR, f);
      let raw = '';
      try { raw = fs.readFileSync(p, 'utf8'); agg.files++; } catch { continue; }
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try { rec = JSON.parse(s); } catch { agg.parseErrors++; continue; }
        const ts = Date.parse(rec.ts);
        if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue;
        agg.totalCalls++;
        if (typeof rec.durationMs === 'number' && rec.durationMs >= 0) durationSum += rec.durationMs;
        if (typeof rec.status === 'number' && rec.status >= 400) agg.errorCount++;
        if (rec.degraded) {
          agg.degradedCount++;
          const srcs = Array.isArray(rec.degradedSources) ? rec.degradedSources : [];
          for (const s2 of srcs) {
            if (!s2) continue;
            agg.degradedBySource[s2] = (agg.degradedBySource[s2] || 0) + 1;
          }
        }
      }
    }
    if (agg.totalCalls > 0) {
      agg.errorRate = Math.round((agg.errorCount / agg.totalCalls) * 10000) / 100; // 百分数保留 2 位
      agg.avgDurationMs = Math.round(durationSum / agg.totalCalls);
    }
  } catch (e) { console.error('[RequestLogger] 聚合异常（返回部分结果）:', e && e.message); }
  return agg;
}

module.exports = { middleware, markDegraded, cleanupOldLogs, aggregateDashboard, normalizeRoute, getWriteFailures, LOGS_DIR, RETENTION_DAYS, DASHBOARD_DAYS };
