'use strict';

/**
 * 全工作台「量能判定」单一真值源（20261109c）
 * ============================================================
 * 用户 2026-11-09 明确纠正：「工作台已经统一使用 20 日量能比来作为量能标准，
 * 为什么现在会出现其他的标准选择？」——工作台不允许存在第二套量能标准。
 *
 * 唯一权威口径：
 *   ratio20 = 当日成交量 ÷ 前 20 日均量
 *   放量  > VOL_AMP(1.3) / 平量 0.8~1.3 / 缩量 < VOL_SHRINK(0.8)
 *
 * 适用范围（全部算「判定层」，禁止自行保留阈值）：
 *   lib/volumeEngine.js 的 _volumeTier / _volTier5 / 生死位五规则（规则1/3/4）/
 *   三问持续性 / 单根脉冲 / 口诀4 / 11.3.1 该放量未放量 / 缩量止跌观察 / 风险标签；
 *   lib/capitalFlow.js 的 ÷20 五档回退、量能热度、最新量比趋势、突破量比形态；
 *   public/js/app.js 的口径说明文案。
 *
 * 明确不适用（显式标注分母的「原始指标」，不承担量价判定结论）：
 *   顶部「量比」（腾讯行情直采，÷前5日均量）、lib/zoneValidity.js 的放量穿越线
 *   （÷前5日均量，箱体有效性专用判据）。这些卡片的标题/口径说明必须写明分母。
 *   注：public/js/capitalCharts.js 的「每日20日量能比趋势」图已由 [20261109d] 改为 ÷20 同源口径
 *   （数据取 volumeIndicators.series.ratio20Series），故它属于「适用」分组、与判定层同源，
 *   不再是独立原始指标（原 ÷前5日均量口径已于该次一并退役）。
 *
 * ⚠️ 同屏互斥 = 结论无效：同一交易日不得同时出现「放量」与「缩量 / 量能未有效放大」。
 * ⚠️ 基准可比性：前高量能基准必须与分析期、价位带可比，禁止用全历史全局最高价
 *    （常为上市首日天量）当突破承接量基准；且前高量能只作展示参照，不参与判定。
 *
 * 纯函数、零网络、零依赖，供引擎 / 资金流 / 守卫共同 require，避免循环依赖。
 */

const VOL_AMP = 1.3;     // 放量阈值：ratio20 > 1.3
const VOL_SHRINK = 0.8;  // 缩量阈值：ratio20 < 0.8
const VOL_HUGE = 2.5;    // 显著放量（capitalFlow 五档回退与 unifiedVolState 同源）
const VOL_DRY = 0.5;     // 地量（同上）
const VOL_BASIS = '放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8';

// —— 基准可比性常量（规则3「同价位带最近前高」专用）——
const REF_PRICE_BAND_PCT = 0.10;      // 与阻力区间触及线的价位带容差 ±10%
const REF_LISTING_GUARD_BARS = 5;     // 剔除上市首日 / 上市初期前 5 根
const REF_EXTREME_VOL_MULT = 4;       // 超过同价位带成交量中位数 4 倍 → 极端异常量，剔除
const REF_EXRIGHT_GAP = 0.22;         // 单日收盘跳变 >22% 视为除权/股本断点，只用断点之后的样本

function _finite(v) { return typeof v === 'number' && isFinite(v); }

/** 任意 ÷20 均量比值 → 是否放量（唯一判定入口） */
function isAmpRatio(r) { return _finite(r) && r > VOL_AMP; }

/** 任意 ÷20 均量比值 → 是否缩量（唯一判定入口） */
function isShrinkRatio(r) { return _finite(r) && r < VOL_SHRINK; }

/** 任意 ÷20 均量比值 → 三态档位；数据不足返回 null（不臆造） */
function tierOfRatio(r) {
  if (!_finite(r)) return null;
  if (r > VOL_AMP) return '放量';
  if (r < VOL_SHRINK) return '缩量';
  return '平量';
}

/** 单日成交量 + 20 日均量 → 比值；均量不可得返回 null */
function ratioOfVol(vol, avg20) {
  return (_finite(vol) && _finite(avg20) && avg20 > 0) ? vol / avg20 : null;
}

module.exports = {
  VOL_AMP, VOL_SHRINK, VOL_HUGE, VOL_DRY, VOL_BASIS,
  REF_PRICE_BAND_PCT, REF_LISTING_GUARD_BARS, REF_EXTREME_VOL_MULT, REF_EXRIGHT_GAP,
  isAmpRatio, isShrinkRatio, tierOfRatio, ratioOfVol,
};
