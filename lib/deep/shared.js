/**
 * lib/deep/shared.js —— deepAnalysis 领域子模块：跨块复用的纯工具函数与常量（零依赖叶子）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 注意：本模块的 _calcStats 与 statements.js 中 analyzeValuation 内部局部函数 calcStats
 * 是两个独立实现（历史并存），严禁合并（设计差异点 D5）。
 */

// 全工作台统一数字规范：价格保留两位小数，防止浮点尾数（如 32.879999999999995）泄漏到文案。
// 百分比统一用文件下方已有的 fmtPct（toFixed(1)+'%'，与距离等口径一致）。
function fmtPrice(v) {
  return (v != null && v !== '' && !isNaN(v) && isFinite(v)) ? Number(v).toFixed(2) : '--';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};
// ---- Analysis Functions ----

// Format number to Yi (亿)
function toYi(n) {
  if (!n || n === 0) return 0;
  return Math.round(n / 1e8 * 100) / 100;
}

// 通用统计：均值 / 总体标准差 / 均值±1σ（与 analyzeValuation.calcStats 一致）
function _calcStats(arr) {
  const valid = (arr || []).filter(v => v > 0);
  if (valid.length === 0) return { mean: 0, std: 0, high: 0, low: 0 };
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
  const std = Math.sqrt(variance);
  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(std * 100) / 100,
    high: Math.round((mean + std) * 100) / 100,
    low: Math.round((mean - std) * 100) / 100,
  };
}

// Compute revenue & cost trend (Section 4, 14)
// 报告期阶段判定（与保险模块一致）
function _stmtStage(reportName) {
  if (!reportName) return null;
  if (reportName.includes('年报')) return 'FY';
  if (reportName.includes('一季报')) return 'Q1';
  if (reportName.includes('中报')) return 'H1';
  if (reportName.includes('三季报')) return 'Q3';
  return null;
}
function fmtPct(n) {
  return (typeof n === 'number' && !isNaN(n)) ? n.toFixed(1) + '%' : '--';
}
// ---- 通用工具：给任意 Promise 加超时保护（不抛拒绝，返回 fallback）----
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(res => setTimeout(() => res(fallback), ms)),
  ]);
}


module.exports = { fmtPrice, fmtPct, toYi, _calcStats, _stmtStage, UA, HEADERS, withTimeout };
