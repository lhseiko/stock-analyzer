/**
 * lib/factorHash.js — 因子结构哈希通用工具（20261110g · 整改方案 P1-2 裁决②）
 * ==========================================================================
 * 两段式版本戳：schemaVersion = 'h' + factorHash(数值口径集合) + '-' + LAYOUT_VERSION
 *   - factorHash 覆盖**所有可序列化数值口径**（因子名/权重/子权重/阈值/事件封顶/评级档位）；
 *     任何一项变化 → 哈希变 → schemaVersion 不等 → 旧落盘记录强制重算（无需回滚逻辑）；
 *   - LAYOUT_VERSION 只兜「计算逻辑变更」（哈希捕获不了的：显示名、纯展示布局、代码算法分支）。
 *
 * _normalize 处理三个坑（用户裁决明确）：
 *   1. 排序：对象键统一按字典序序列化——同一份数据在不同模块的组装键序不同不该产生不同哈希；
 *      **数组不排序**（因子/子因子顺序本身是口径，顺序变化应当被捕获）。
 *   2. 浮点精度：number 统一舍入到 1e-6——0.1+0.2 类浮点噪声不改变哈希；NaN/±Infinity 稳定字符串化。
 *   3. undefined：undefined → null（JSON.stringify 会直接丢掉 undefined 字段，
 *      导致「字段从有值改为 undefined」与「字段删除」混淆）；对象键中 undefined/null 值
 *      **整键删除**——「口径显式为空」「口径缺失」「口径曾 undefined」三者归一为「未参与」。
 *
 * 哈希算法：FNV-1a 32-bit（与 sameDayJudgment 既有实现同域，输出 8 位 hex）。
 * 零依赖。
 */
'use strict';

function _normalize(v) {
  if (v === undefined || v === null) return null;                    // 坑3（标量位置）
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);                       // 坑2（NaN/Infinity）
    return Math.round(v * 1e6) / 1e6;                                // 坑2
  }
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (typeof v === 'function') return '[fn]';                        // 函数不可序列化，稳定占位
  if (Array.isArray(v)) return v.map(_normalize);                    // 坑1：数组保序
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const val = _normalize(v[k]);
      if (val === null) continue; // 坑3：undefined / null / 字段缺失 三者归一（口径未参与=键不存在）
      out[k] = val;
    }
    return out;
  }
  return v;
}

/**
 * 计算因子结构哈希（8 位 hex）。
 * @param {Array} parts 参与哈希的数值口径集合（数组各元素依次归一化后拼接）
 * @returns {string}
 */
function factorHash(parts) {
  const payload = JSON.stringify((Array.isArray(parts) ? parts : [parts]).map(_normalize));
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

module.exports = { factorHash, _normalize };
