/**
 * lib/inflight.js — 通用 singleflight 并发合并（20261110g · 整改方案 P1-1）
 * ==========================================================================
 * 问题：项目内 6 处散装 in-flight 实现（etfFlow / stockData._thsRawInFlight /
 *   reportSync / sectorCapitalFlow / usTreasury / hotTopicsWeekly），语义各自为政
 *   （单值 / Map / Set、释放时机不一），新增接入点继续复制粘贴会持续膨胀。
 *
 * 本模块提供唯一实现：
 *   inflight(key, fn, {maxMs}) → Promise
 *     - 同 key 在途调用共享同一个 Promise（后到者直接复用，fn 只执行一次）；
 *     - fn 的结果与异常对所有等待者透传（reject 不吞）；
 *     - promise settle（成功或失败）后自动释放 key；
 *     - maxMs：**软超时释放**——超时后仅把 key 从表中移除（后续新调用重新执行 fn），
 *       已发出的 promise 继续存活（原等待者仍拿到原结果），绝不中断进行中的 I/O。
 *   has(key)      → 是否有在途调用（替代 isCollecting() 类查询）
 *   clear(key)    → 强制释放 key（不 settle 已有 promise；替代 __resetCache 类钩子）
 *   activeCount() → 当前在途 key 数（可观测性）
 *
 * 迁移铁律（P1-1 验收）：6 处收编必须**等价改造**——模块对外语义零变化，原测试全绿。
 * 零依赖、零 I/O，可被任意 lib / 测试复用。
 */
'use strict';

const _map = new Map(); // key → { promise, startedAt, timer }

function inflight(key, fn, opts = {}) {
  const k = String(key);
  const existing = _map.get(k);
  if (existing) return existing.promise;

  const entry = { promise: null, startedAt: Date.now(), timer: null };
  const release = () => {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (_map.get(k) === entry) _map.delete(k);
  };

  // Promise.resolve().then(fn)：把执行推迟到微任务，确保 _map.set 先于 fn 首次
  // await 点执行——否则 fn 同步完成/抛错时 finally 会在 set 之前跑，造成脏 entry。
  entry.promise = Promise.resolve().then(fn);
  entry.promise.then(release, release); // 成功/失败都释放（异常照常向等待者透传）
  _map.set(k, entry);

  if (opts.maxMs > 0) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // 软超时：仅释放 key，后续新调用重新执行；原 promise 不受影响
      if (_map.get(k) === entry) _map.delete(k);
    }, opts.maxMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref(); // 不阻止进程退出
  }
  return entry.promise;
}

function has(key) { return _map.has(String(key)); }

/** 取在途 promise（无则返回 null）——用于「复用但不重发」的调用方 */
function get(key) {
  const e = _map.get(String(key));
  return e ? e.promise : null;
}

/** 强制释放 key（不 settle 已有 promise，原等待者仍拿到原结果） */
function clear(key) {
  const k = String(key);
  const e = _map.get(k);
  if (e && e.timer) { clearTimeout(e.timer); e.timer = null; }
  _map.delete(k);
}

function activeCount() { return _map.size; }

/** 测试钩子：清空全部状态（不 settle 任何 promise） */
function __resetAll() {
  for (const e of _map.values()) if (e.timer) clearTimeout(e.timer);
  _map.clear();
}

module.exports = { inflight, has, get, clear, activeCount, __resetAll };
