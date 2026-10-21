/**
 * 日K成交量「单位」单一来源（20261021h）
 * ==========================================================
 * 背景（用户 2026-10-21 截图报障）：
 *   文案「60 日均量 113900 ×1.5 = 170850（当日量 7358800）」——当日量比阈值大 43 倍，
 *   却判「未达阈值」。根因是当日 bar 被实时行情覆写时单位换错：把「股」写进了「手」序列。
 *
 * 实测（2026-10-21，用「成交额 = 收盘价 × 量 × 100」反验，最可靠）：
 *   | 通道 | 日K volume 单位 | 证据 |
 *   |---|---|---|
 *   | eastmoney（东财 kline f56） | **手** | 000902: 73588 手 ×13.87×100 = 1.02 亿 = quote.amount；600519: 33514×1309.69×100 = 43.89 亿 ≈ 44.04 亿 |
 *   | tencent（fetchTencentHistory 已归一） | **手** | 科创板 688/689 的「股」已在取数时 ÷100 |
 *   | ths（同花顺 last.js） | **股** | 同花顺日K量级为东财的 ~100 倍 |
 *   | quote（腾讯实时快照 fields[36]） | **股** | 与日K手数恒差 100 倍 |
 *
 * 教训：这段"哪个通道是什么单位"的知识此前散落在至少三处（volumeEngine 的覆写函数、
 * volumeEngine 的开盘量比、capitalFlow 的 VOLUME_TO_LOT），其中两处把东财当成「股」，
 * 于是同一个文件里同时存在 ×100 与 ÷100 两种错误方向。现在收敛到本文件，任何新调用点只许调这里。
 */

// 日K通道 → volume 单位（'hand' 手 / 'share' 股）
const BAR_VOL_UNIT = { eastmoney: 'hand', tencent: 'hand', ths: 'share' };

/** 该通道日K的成交量单位；未知通道按「股」保守处理（宁可少除，也不凭空 ÷100 把量做小） */
function barVolumeUnit(source) {
  return BAR_VOL_UNIT[source] || 'share';
}

/** 把「股」换算成该通道日K的单位（实时 quote 恒为股，写进日K前必须过这一步） */
function sharesToBarUnit(shares, source) {
  if (!isFinite(shares)) return null;
  return barVolumeUnit(source) === 'share' ? shares : shares / 100;
}

/** 该通道日K → 「手」的换算除数（东财/腾讯=1，同花顺=100） */
function toLotDivisor(source) {
  return barVolumeUnit(source) === 'share' ? 100 : 1;
}

module.exports = { BAR_VOL_UNIT, barVolumeUnit, sharesToBarUnit, toLotDivisor };
