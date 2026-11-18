/**
 * lib/directionHit.js — 方向命中判定单源（任务卡 #021，2026-11-17）
 * ==========================================================================
 * 用户裁决：判跌遇负涨跌幅命中、判涨遇正涨跌幅命中；即便涨跌幅小到被标为
 * 「震荡」（指数 ±0.5% 以内），也按符号判命中。反向或恰好 0 不命中。
 *
 * 本模块只判定「方向符号」，不定义震荡标签、不碰阈值：
 *   - 震荡标签仍由 taxonomy.FLAT_TOLERANCE_INDEX 决定（展示口径，不变）；
 *   - 本模块的 flat 仅表示「实际涨跌幅恰为 0 或不可判定」——没有符号可判，不能命中。
 *
 * 零依赖、零 I/O，供 sentimentAccuracy（界面准确率台账）与 marketEmotionModel
 * （模块内部诊断 / 因子学习）共用，避免两处口径再次分叉。
 */
'use strict';

/**
 * 由涨跌幅（百分数）取实际方向符号。
 * @param {number|string|null|undefined} chgPct 例：0.06 / -0.39
 * @returns {'up'|'down'|'flat'|null} 正→up，负→down，恰 0→flat，不可判定→null
 */
function signDir(chgPct) {
  if (chgPct === null || chgPct === undefined || chgPct === '') return null;
  if (typeof chgPct === 'string' && !chgPct.trim()) return null;
  const v = Number(chgPct);
  if (!Number.isFinite(v)) return null;
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

/**
 * 方向符号一致即命中。
 * @param {'up'|'down'|null} pred 预测方向的符号表示
 * @param {number|string|null|undefined} chgPct 实际涨跌幅（百分数）
 * @returns {boolean} 同号命中；0 / 不可得 / 无预测方向均不命中
 */
function hitBySign(pred, chgPct) {
  if (pred !== 'up' && pred !== 'down') return false;
  const sign = signDir(chgPct);
  return (sign === 'up' || sign === 'down') && pred === sign;
}

/** 界面台账的中文方向（涨/跌）→ 符号；其余（震荡等）返回 null */
function cnDirToSign(dir) {
  if (dir === '涨') return 'up';
  if (dir === '跌') return 'down';
  return null;
}

/** 模型内部方向（看涨/看跌）→ 符号；中性等返回 null */
function modelDirToSign(tendency) {
  if (tendency === '看涨') return 'up';
  if (tendency === '看跌') return 'down';
  return null;
}

module.exports = { signDir, hitBySign, cnDirToSign, modelDirToSign };
