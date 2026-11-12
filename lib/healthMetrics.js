// lib/healthMetrics.js — 健康面板指标注册表（backlog ②，20261112）
// ============================================================================
// 职责：仅内存计数器（无落盘、无新增写盘失败面），供 /api/health 与
// /api/health/dashboard 同源暴露——禁止前端二次计算，两处数字逐字段一致。
//
// 指标口径（用户裁决 2026-11-12）：
//   1. 缓存命中率（按接口维度 analysis / deep-analysis / other）：
//      hitRate = hits / (hits + misses)，aborted 与错误请求**不计入分母**
//      （单独计数暴露，仅作透明度，不参与命中率）；分子分母同时暴露，不只给百分比。
//   2. LLM 调用计数：成功 ok / 失败 fail / 降级 degraded / 超时 timeout 四类互斥，
//      按调用点（caller，取自调用栈文件路径）分桶；总数 = 四类之和（1:1 分区，不重复计）。
//      **与 stockData 数据源降级埋点（requestLogger.markDegraded）完全独立**：
//      LLM 降级 = 成功但走了非首选通道（妙想回退/外部搜索失败纯推理/400 去参重试），
//      不等于数据源降级。
//   3. 接口归一（ifaceOfRoute）：/api/analysis* → analysis；含 deep-analysis → deep-analysis；
//      其余 /api → other；非 /api → null（不计数）。
//
// 并发安全：Node 单线程，全部同步自增，无丢失窗口。
// 埋点接线：
//   - hits/misses：analysis = server.js /api/analysis 处理器（getCached 返回为准）；
//     deep-analysis = lib/deepJobManager.js 磁盘缓存命中分支（fromCache:true 为准）。
//   - aborted/errors：lib/requestLogger.js emit（全 /api 统一单点，避免双计）。
//   - LLM：lib/ai/llm.js callLLM 出口（单点，caller 取自调用栈）。
'use strict';

const counters = {
  interfaces: {}, // iface -> { hits, misses, aborted, errors }
  llm: { ok: 0, fail: 0, degraded: 0, timeout: 0, total: 0, byCaller: {} },
};

function _iface(iface) {
  if (!counters.interfaces[iface]) {
    counters.interfaces[iface] = { hits: 0, misses: 0, aborted: 0, errors: 0 };
  }
  return counters.interfaces[iface];
}

function recordCacheHit(iface) { if (iface) _iface(iface).hits++; }
function recordCacheMiss(iface) { if (iface) _iface(iface).misses++; }
function recordAborted(iface) { if (iface) _iface(iface).aborted++; }
function recordError(iface) { if (iface) _iface(iface).errors++; }

/** LLM 计数：outcome ∈ ok | fail | degraded | timeout（四类互斥，1:1 分区） */
function recordLlm(caller, outcome) {
  if (!caller) caller = 'unknown';
  if (!counters.llm.byCaller[caller]) {
    counters.llm.byCaller[caller] = { ok: 0, fail: 0, degraded: 0, timeout: 0, total: 0 };
  }
  if (!['ok', 'fail', 'degraded', 'timeout'].includes(outcome)) outcome = 'fail'; // 未知 outcome 归 fail，绝不丢计数
  counters.llm[outcome]++;
  counters.llm.total++;
  counters.llm.byCaller[caller][outcome]++;
  counters.llm.byCaller[caller].total++;
}

/** 接口归一：route 为 requestLogger 归一化后的 pathname（如 /api/analysis/:symbol） */
function ifaceOfRoute(route) {
  const r = String(route || '');
  if (!r.startsWith('/api/')) return null;
  if (r.startsWith('/api/analysis')) return 'analysis';
  if (r.includes('deep-analysis')) return 'deep-analysis';
  return 'other';
}

/** 快照（深拷贝）：/api/health 与 /api/health/dashboard 同源取此处，逐字段一致 */
function snapshot() {
  const interfaces = {};
  for (const [iface, c] of Object.entries(counters.interfaces)) {
    const denom = c.hits + c.misses; // aborted/errors 不计入分母
    interfaces[iface] = {
      ...c,
      hitRate: denom > 0 ? +(c.hits / denom).toFixed(4) : null, // 无请求时 null（不捏造 0/1）
      hitRateDenominator: denom,
    };
  }
  const llm = { ...counters.llm, byCaller: {} };
  for (const [k, v] of Object.entries(counters.llm.byCaller)) llm.byCaller[k] = { ...v };
  return {
    meta: {
      window: 'since_process_start', // 统计窗口口径：本进程启动以来（重启清零）
      otherHitRate: 'N/A', // other 接口无缓存语义（仅 aborted/errors 计数，无 hits/misses 埋点）→ hitRate 恒为 null
      excludedFromDenominator: 'aborted/errors', // 排除项：不计入 hitRate 分母
    },
    interfaces,
    llm,
  };
}

/** 仅测试用：清零全部计数器（守卫隔离用，生产禁调） */
function _resetForTests() {
  counters.interfaces = {};
  counters.llm = { ok: 0, fail: 0, degraded: 0, timeout: 0, total: 0, byCaller: {} };
}

module.exports = { recordCacheHit, recordCacheMiss, recordAborted, recordError, recordLlm, ifaceOfRoute, snapshot, _resetForTests };
