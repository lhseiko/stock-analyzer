/**
 * lib/baselines.js — 准确率三基准计算（20261110g · 整改方案阶段 1 P0-2，代码权威非 LLM）
 * ==================================================================================
 * 三个基准（方案 P0-2 口径）：
 *   ① 同期标的方向基准：样本期内「永远预测涨」的命中率 = 样本 actualDir 为涨的占比
 *      （A股不可做空，永远看涨是最朴素的可比基准；样本内可手算复核）
 *   ② 随机 50% 参照线：常数 50（三分向口径下随机基线按样本实际涨/跌/震荡分布期望另给，
 *      但方案口径为「随机 50% 参照线」，此处固定 50 并附注）
 *   ③ 简单 5 日动量基准：baseDate 收盘 vs 5 个交易日前收盘，同向为正确（震荡容差与各链判定一致）
 *
 * 另提供：市场状态月表（涨/跌/震荡月）——由上证日 K 月度聚合生成，落盘
 *   data/market-month-state.json；两条指数结算链（marketTech/sentiment）结算时顺带刷新，
 *   个股链只读缓存。computeAccuracy 按月分组时用该表打「涨月/跌月/震荡月」标。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FLAT_TOLERANCE = require('./taxonomy').FLAT_TOLERANCE_INDEX; // 与 marketTechJudgment/sentimentAccuracy 的震荡容差一致（P1-3 单源）
const MONTH_STATE_FILE = path.join(__dirname, '..', 'data', 'market-month-state.json');

function round(x, n) { const p = Math.pow(10, n == null ? 2 : n); return Math.round(x * p) / p; }
function monthOf(dateStr) { return dateStr ? String(dateStr).slice(0, 7) : null; }

/**
 * 5 日动量方向（bars 须按日期升序）。
 * @param {Array} bars   [{date, close, ...}]
 * @param {number} idx   基准日在 bars 中的下标
 * @param {number} lookback 回看交易日数（默认 5）
 * @returns {{dir:'涨'|'跌'|'震荡', chgPct:number}|null} 数据不足返回 null（如实缺省）
 */
function momentumSignal(bars, idx, lookback) {
  const lb = lookback || 5;
  if (!Array.isArray(bars) || idx == null || idx < lb || idx >= bars.length) return null;
  const base = bars[idx].close;
  const prev = bars[idx - lb].close;
  if (base == null || prev == null || !prev) return null;
  const chgPct = (base - prev) / prev * 100;
  const dir = Math.abs(chgPct) <= FLAT_TOLERANCE ? '震荡' : (chgPct > 0 ? '涨' : '跌');
  return { dir, chgPct: round(chgPct, 2) };
}

/** 动量基准是否命中（与各链判定同构：预测震荡 → |chg|≤容差；否则方向一致）。 */
function momentumCorrect(momentum, actualDir, actualChgPct) {
  if (!momentum || !momentum.dir || !actualDir) return null;
  if (momentum.dir === '震荡') return Math.abs(Number(actualChgPct) || 0) <= FLAT_TOLERANCE;
  return momentum.dir === actualDir;
}

/**
 * 由指数日 K 刷新市场状态月表（月内累计涨跌幅：>1% 涨月 / <-1% 跌月 / 其余震荡月）。
 * @param {Array} indexBars [{date, close}] 升序
 */
function refreshMonthState(indexBars) {
  if (!Array.isArray(indexBars) || !indexBars.length) return null;
  const byMonth = {};
  for (const b of indexBars) {
    if (!b || !b.date || b.close == null) continue;
    const m = monthOf(b.date);
    if (!m) continue;
    if (!byMonth[m]) byMonth[m] = { first: b.close, last: b.close, days: 0 };
    byMonth[m].last = b.close;
    byMonth[m].days++;
  }
  const state = {};
  for (const [m, v] of Object.entries(byMonth)) {
    if (!v.first) continue;
    const chg = (v.last - v.first) / v.first * 100;
    state[m] = { dir: chg > 1 ? '涨' : (chg < -1 ? '跌' : '震荡'), monthChgPct: round(chg, 2), days: v.days };
  }
  try {
    fs.writeFileSync(MONTH_STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), source: 'index-daily', months: state }, null, 2), 'utf8');
  } catch (e) { /* 写失败不影响结算主流程 */ }
  return state;
}

/** 读取市场状态月表（个股链只读缓存；缺失返回 null，分组时如实标注无市场状态）。 */
function getMonthState() {
  try {
    const j = JSON.parse(fs.readFileSync(MONTH_STATE_FILE, 'utf8'));
    return (j && j.months) || null;
  } catch (e) { return null; }
}

/** 单条记录的月度分组键。 */
function monthKeyOf(rec) { return monthOf((rec && (rec.date || rec.baseDate)) || null); }

/**
 * 基准聚合（computeAccuracy 复用，四链口径一致）。
 * @param {Array} valid   可比（未排除）已结算记录：须含 actualDir；可含 momentum
 * @param {object} opts   { monthState?: object|null }
 */
function aggregateBaselines(valid, opts) {
  const o = opts || {};
  const t = valid.length;
  const alwaysUp = { t, c: valid.filter(r => r.actualDir === '涨').length };
  const momentum = { t: 0, c: 0 };
  for (const r of valid) {
    if (r && r.momentum && r.momentum.dir) {
      momentum.t++;
      if (momentumCorrect(r.momentum, r.actualDir, r.actualChgPct)) momentum.c++;
    }
  }
  const rate = p => (p.t ? round(p.c / p.t * 100, 1) : null);
  // 市场状态月分组
  const monthState = o.monthState !== undefined ? o.monthState : getMonthState();
  const byMonth = {};
  for (const r of valid) {
    const m = monthKeyOf(r);
    if (!m) continue;
    if (!byMonth[m]) byMonth[m] = { t: 0, c: 0, marketState: null };
    byMonth[m].t++;
    if (r.correct) byMonth[m].c++;
    const ms = monthState && monthState[m];
    byMonth[m].marketState = ms ? ms.dir : null;
  }
  return {
    directionBenchmark: { t: alwaysUp.t, c: alwaysUp.c, rate: rate(alwaysUp), note: '永远预测涨' },
    randomBenchmark: { rate: 50, note: '随机 50% 参照线' },
    momentumBenchmark: { t: momentum.t, c: momentum.c, rate: rate(momentum), note: '5 日动量同向（震荡容差 0.5%）' },
    sampleSufficient: t >= 30,
    sampleNote: t < 30 ? '样本不足 30 条，无统计意义' : null,
    byMonth,
  };
}

module.exports = {
  momentumSignal, momentumCorrect, refreshMonthState, getMonthState,
  aggregateBaselines, monthKeyOf, FLAT_TOLERANCE, MONTH_STATE_FILE,
};
