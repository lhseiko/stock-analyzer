/**
 * 数据诚实原则（核心底层逻辑）
 * ================================================================
 * 规则：没有"成功获取"的数据，必须明确告知"获取失败"，绝不能用
 *   ① 其他来源的数据冒充（跨源替代）；
 *   ② 陈旧快照当新数据（除非显式标注 stale / 滞后）；
 *   ③ 零值 / 空值 / 默认值伪装成"已算出"的结果（silent padding）。
 *
 * 所有"数据获取 / 计算"函数应返回以下统一信封之一：
 *   - 成功(实时)： { success:true,  source, fetchedAt, ...data }
 *   - 成功(陈旧)： { success:true,  source, fetchedAt, stale:true, staleReason, ...data }  // 必须显式标注
 *   - 获取失败：   { success:false, source, error, errorType, reason }
 *
 * 调用方/前端据此渲染：fresh=正常 | stale=黄色"滞后/快照" | failed=红色"获取失败"。
 * 本模块不依赖任何外部包，可被任意 lib / 测试 / 前端复用。
 */

function nowISO() {
  return new Date().toISOString();
}

/** 成功（实时/同源）结果 */
function ok(data, meta) {
  meta = meta || {};
  return Object.assign({ success: true, source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() }, data);
}

/** 成功但数据陈旧（必须显式标注，前端以黄色告警呈现，绝不伪装成实时） */
function stale(data, meta) {
  meta = meta || {};
  return Object.assign(
    { success: true, stale: true, staleReason: meta.reason || '数据滞后/快照（非实时）', source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() },
    data
  );
}

/** 获取失败：诚实声明，绝不返回零值聚合伪装成功 */
function fail(error, meta) {
  meta = meta || {};
  const msg = (typeof error === 'string') ? error : (error && error.message) || 'UNKNOWN';
  return {
    success: false,
    source: meta.source || '',
    fetchedAt: nowISO(),
    error: msg,
    errorType: meta.errorType || 'FETCH_FAILED',
    reason: meta.reason || msg,
  };
}

/** 分类：fresh | stale | failed */
function classify(r) {
  if (!r || r.success === false || r.ok === false) return 'failed';
  if (r.stale === true) return 'stale';
  return 'fresh';
}

function isFailure(r) { return classify(r) === 'failed'; }
function isStale(r) { return !!(r && r.success === true && r.stale === true); }
function isFresh(r) { return !!(r && r.success === true && !r.stale); }

/**
 * 反"凑数"检测：识别把失败/无数据伪装成成功结果的典型特征。
 * 命中即视为违反诚实原则，交由 test_data_honesty.js 静态断言。
 *
 * 判定：对象看起来像一个"结果"（含 success 字段且为 true，或无 success 但像数据信封），
 * 同时其 stats/summary 类字段全为 0，且伴有 note/error 说明这是失败/不可用。
 * （纯统计助手如 _calcStats 在"空输入"时返回全 0 是合法行为，但调用方必须据此返回
 *   success:false；因此该函数只检测"结果信封级"的伪装，不检测纯统计助手本身。）
 */
function hasSilentPadding(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false || obj.ok === false) return false; // 已诚实声明失败
  const s = obj.stats;
  if (s && typeof s === 'object') {
    const zeroKeys = ['mean', 'std', 'high', 'low', 'median', 'sum', 'avg'].filter(function (k) { return s[k] === 0; });
    if (zeroKeys.length >= 3 && (obj.note || obj.error || obj.reason)) return true;
  }
  return false;
}

module.exports = { ok, stale, fail, classify, isFailure, isStale, isFresh, hasSilentPadding, nowISO };
