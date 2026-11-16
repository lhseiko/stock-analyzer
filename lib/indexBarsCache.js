/**
 * indexBarsCache.js — 任务卡 #014「行情日线本地缓存回退」
 * ============================================================================
 * 背景（ERR-20261116-001）：2026-11-16 10:59 服务重启后行情接口瞬断，
 * 上证/深证日线拉不到 → 10 个情绪因子全部「降级归零并按比例分摊」。
 * 模型对原始行情日线没有本地回退路径，实时拉不到只能归零。
 *
 * 本模块只做一件事：把「最近一次成功拉取的日线」落盘，实时失败/不足门槛时
 * 回退到缓存，并让调用方拿到「如实标注」（缓存时间 / 最新 K 线日 / 根数）。
 *
 * 口径铁律：
 *   - 缓存语义 = 最近一次成功拉取的结果（盘中时最后一根是当日未收盘半根 K 线，
 *     属正常——比「没有」强，且标注了缓存时间）；
 *   - 回退必须如实标注，不得冒充实时；缓存不可用时保持原样，不编数据；
 *   - 纯函数 + 显式规则 + 可单测（resolveIndexBlock）；写盘失败只 warn 不阻断。
 *
 * 隔离：缓存目录默认 data/market-emotion/cache/；SA_EMO_BARS_CACHE_DIR 仅用于
 * 离线守卫注入临时目录（仿 lib/db.js 的 SA_DB_PATH 模式），生产默认路径不变。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = process.env.SA_EMO_BARS_CACHE_DIR
  ? path.resolve(process.env.SA_EMO_BARS_CACHE_DIR)
  : path.join(__dirname, '..', 'data', 'market-emotion', 'cache');

/** 实时结果视为「可用」的最小根数门槛（量价因子最小需求，模型内同口径） */
const MIN_BARS = 21;

function cacheFile(code) { return path.join(CACHE_DIR, 'index-bars-' + code + '.json'); }

/** 保存最近一次成功拉取的日线；写盘失败只 warn，不抛出（不阻断主流程） */
function saveBars(code, bars, name) {
  try {
    if (!code || !Array.isArray(bars) || bars.length < MIN_BARS) return false;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(code), JSON.stringify({
      code,
      name: name || '',
      savedAt: new Date().toISOString(),
      count: bars.length,
      bars,
    }));
    return true;
  } catch (e) {
    console.error('[IndexBarsCache] 写缓存失败（不阻断）:', e && e.message ? e.message : e);
    return false;
  }
}

/** 读取缓存；损坏/缺失按无缓存处理（返回 null），不抛出 */
function loadBars(code) {
  try {
    if (!fs.existsSync(cacheFile(code))) return null;
    const j = JSON.parse(fs.readFileSync(cacheFile(code), 'utf8'));
    if (!j || j.code !== code || !Array.isArray(j.bars) || !j.bars.length) return null;
    return j;
  } catch (e) {
    console.error('[IndexBarsCache] 读缓存失败（按无缓存处理）:', e && e.message ? e.message : e);
    return null;
  }
}

/**
 * 回退判定纯函数（显式规则，可单测）：
 *   1) 实时成功且 ≥ MIN_BARS          → 用实时，不回退；
 *   2) 实时失败/为空/不足门槛，缓存 ≥ 实时根数且缓存 ≥ MIN_BARS → 用缓存 + 如实标注；
 *   3) 缓存也不可用                    → 保持原样（block=null，err 如实透出），不编数据。
 * @param {object} p { live: object|null, liveErr: Error|null, cache: object|null }
 * @returns {object} { block, fromCache, cacheSavedAt, note }
 */
function resolveIndexBlock(p) {
  const o = p || {};
  const live = o.live && Array.isArray(o.live.bars) && o.live.bars.length ? o.live : null;
  const liveOk = !!live && live.bars.length >= MIN_BARS;
  if (liveOk) {
    return { block: live, fromCache: false, cacheSavedAt: null, note: null };
  }
  const cache = o.cache && Array.isArray(o.cache.bars) ? o.cache : null;
  const cacheOk = !!cache && cache.bars.length >= MIN_BARS &&
    (!live || cache.bars.length > live.bars.length);
  if (cacheOk) {
    const last = cache.bars[cache.bars.length - 1];
    const reasonTxt = o.liveErr ? ('实时采集失败：' + String(o.liveErr.message || o.liveErr))
      : live ? ('实时返回仅 ' + live.bars.length + ' 根（不足 ' + MIN_BARS + '）')
        : '实时未返回数据';
    const note = reasonTxt + '；已按原则 A 沿用本地缓存日线（' + cache.bars.length +
      ' 根，最新 ' + (last && last.date ? last.date : '未知') +
      '，缓存时间 ' + String(cache.savedAt || '未知') + '），非实时数据';
    return {
      block: { code: cache.code, name: (live && live.name) || cache.name || '', bars: cache.bars },
      fromCache: true,
      cacheSavedAt: cache.savedAt || null,
      note,
    };  }
  return { block: live, fromCache: false, cacheSavedAt: null, note: null };
}

module.exports = { saveBars, loadBars, resolveIndexBlock, MIN_BARS, CACHE_DIR };
