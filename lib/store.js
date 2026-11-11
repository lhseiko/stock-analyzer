/**
 * lib/store.js — JSON 落盘读写统一（20261110g · 整改方案 P1-4）
 * ==========================================================================
 * 问题：JSON 读写散在各模块、行为不一——损坏文件有的返回 null、有的 throw、
 *   有的静默臆造回退；写入多为直接 writeFileSync（进程中途被杀会留下半截 JSON，
 *   下次读取即损坏——历史上反复出现「judgments 文件损坏→某股判断全空」类故障）。
 *
 * 本模块提供唯一实现：
 *   readJsonSafe(p, fallback) → JSON | fallback
 *     - 损坏/不存在 → 返回 fallback（默认 null），**留痕** dataGaps（控制台 warn，含文件名与错误）；
 *     - 不做静默臆造：绝不从半截 JSON 猜数据。
 *   writeJsonAtomic(p, obj) → boolean
 *     - tmp + rename 原子写：进程被杀最多留下 .tmp 残片，目标文件永远是完整 JSON；
 *     - 自动建父目录；写失败返回 false（调用方决定是否降级），不 throw。
 *
 * 迁移顺序（方案 P1-4）：reviews / stock-reviews / manual-zones / judgments 四类核心先行，
 *   其余模块按改动顺路迁移（readJsonSafe/writeJsonAtomic 行为向后兼容时可直接替换）。
 * 零依赖。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 安全读 JSON：损坏/缺失返回 fallback 并留痕（不静默、不臆造）。
 * @param {string} p 文件绝对路径
 * @param {*} fallback 默认 null
 * @returns {{data:*, corrupted:boolean}} data=解析结果或 fallback；corrupted=文件存在但解析失败
 */
function readJsonSafe(p, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { data: fallback, corrupted: false }; } // 不存在/不可读 → 正常缺失，不算损坏
  try { return { data: JSON.parse(raw), corrupted: false }; }
  catch (e) {
    console.warn(`[store] JSON 损坏留痕：${p}（${e.message}）→ 返回 fallback`);
    return { data: fallback, corrupted: true };
  }
}

/**
 * 原子写 JSON：tmp + rename，进程中途被杀不产生半截目标文件。
 * @returns {boolean} 是否成功（失败不 throw，调用方自行降级）
 */
function writeJsonAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // [P1-4 清单] tmp 带进程号+时间戳随机后缀：并发写同名文件时固定名 file.json.tmp 会互相踩踏
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error(`[store] 原子写失败：${p}（${e.message}）`);
    return false;
  }
}

module.exports = { readJsonSafe, writeJsonAtomic };
