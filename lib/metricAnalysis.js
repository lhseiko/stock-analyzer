/**
 * lib/metricAnalysis.js — 「指标分析」确定性引擎（20260919a）
 *
 * 替代原「分析师评级」模块。对个股页左侧「关键财务指标」做确定性五维对比：
 *   ① 同比（去年同期同报告期）② 环比（较上一披露期，累计口径标注）
 *   ③ 行业均值对比 ④ 历史百分位对比 ⑤ 边际变化（趋势/加速·减速）
 * 并给出「判定依据」（与左侧 利好/中性/利空 信号同源，由 evaluateSignals 提供）。
 *
 * 设计原则（承接 stock-analyzer 铁律）：
 *   - 全部为确定性代码计算，不做任何 LLM 估算；
 *   - 缺数据的维度如实标注「不可得」，绝不编造数值；
 *   - 五维取数与左侧「关键财务指标」卡、深度分析同数据源（quote.fundamentals / zyzbHistory / comparison）。
 */
'use strict';

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 同比：取最新披露期 vs 去年同期同一报告期（REPORT_DATE 年份-1 精确匹配，避免跨期误比）
function samePeriodPair(zy, field) {
  if (!Array.isArray(zy) || !zy.length) return { cur: null, prev: null };
  const latest = zy[0];
  const ld = String(latest.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return { cur: toNum(latest[field]), prev: null };
  const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
  const prev = zy.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt);
  return { cur: toNum(latest[field]), prev: prev != null ? toNum(prev[field]) : null };
}

// 环比：取最新披露期 vs 上一相邻披露期（zyzbHistory 降序，zy[0] vs zy[1]）
function consecutivePair(zy, field) {
  if (!Array.isArray(zy) || zy.length < 2) return { cur: null, prev: null };
  return { cur: toNum(zy[0][field]), prev: toNum(zy[1][field]) };
}

// 方向信号：delta 在「有利方向」上为 bull，相反为 bear，近零为 neutral
function deltaSignal(delta, higherBetter) {
  if (delta == null) return null;
  if (Math.abs(delta) < 0.05) return 'neutral';
  return (delta > 0) === higherBetter ? 'bull' : 'bear';
}

// 维度：缺失
function na(text) { return { available: false, text: text || '不可得', signal: null }; }
// 维度：可用
function ok(text, signal) { return { available: true, text, signal: signal || null }; }

// 同比维度（水平型指标：ROE/毛利率/净利率/负债率/流动比率/股息率）
function yoyDim(cur, prev, higherBetter, unit) {
  if (cur == null) return na('不可得');
  if (prev == null) return ok(`${cur.toFixed(1)}${unit}（缺去年同期，无法比较）`, null);
  const delta = cur - prev;
  const sig = deltaSignal(delta, higherBetter);
  const dir = delta > 0 ? '+' : '';
  return ok(`同比 ${dir}${delta.toFixed(1)}${unit}（${cur.toFixed(1)}% vs 去年同期 ${prev.toFixed(1)}%）`, sig);
}

// 环比维度（较上一披露期，累计口径标注）
function qoqDim(cur, prev, higherBetter, unit) {
  if (cur == null) return na('不可得');
  if (prev == null) return ok(`${cur.toFixed(1)}${unit}（缺上一披露期，无法比较）`, null);
  const delta = cur - prev;
  const sig = deltaSignal(delta, higherBetter);
  const dir = delta > 0 ? '+' : '';
  return ok(`环比(较上一披露期·累计口径) ${dir}${delta.toFixed(1)}${unit}（${cur.toFixed(1)}% vs ${prev.toFixed(1)}%）`, sig);
}

// 行业均值维度
function industryDim(cur, indVal, higherBetter, unit) {
  if (indVal == null || cur == null) return na('不可得（无行业均值）');
  const ratio = cur / indVal;
  let sig;
  if (higherBetter) sig = ratio >= 1.1 ? 'bull' : ratio <= 0.9 ? 'bear' : 'neutral';
  else sig = ratio <= 0.9 ? 'bull' : ratio >= 1.1 ? 'bear' : 'neutral';
  const relTxt = ratio >= 1 ? `高 ${ratio.toFixed(2)}×` : `低 ${(1 / ratio).toFixed(2)}×`;
  return ok(`行业均值 ${indVal.toFixed(1)}${unit}，相对${relTxt}`, sig);
}

// 历史百分位维度
function pctDim(p, higherBetter) {
  if (p == null) return na('不可得');
  let sig;
  if (higherBetter) sig = p >= 80 ? 'bull' : p <= 20 ? 'bear' : 'neutral';
  else sig = p <= 20 ? 'bull' : p >= 80 ? 'bear' : 'neutral';
  return ok(`处自身历史 ${p}% 分位`, sig);
}

// 边际变化维度（水平型：综合同比+环比方向）
function marginalLevelDim(yoy, qoq) {
  const ys = yoy.signal, qs = qoq.signal;
  if (ys == null && qs == null) return na('不可得');
  if (ys === 'bull' && qs === 'bull') return ok('同比/环比同步改善，趋势向上', 'bull');
  if (ys === 'bear' && qs === 'bear') return ok('同比/环比同步走弱，趋势向下', 'bear');
  if (ys === 'bull' && qs !== 'bull') return ok('同比改善，但近期环比未同步走强，持续性待观察', 'neutral');
  if (ys === 'bear' && qs === 'bull') return ok('同比仍弱，但环比已转正，边际企稳', 'neutral');
  if (ys === 'neutral' && qs === 'bull') return ok('同比持平、环比改善', 'neutral');
  if (ys === 'neutral' && qs === 'bear') return ok('同比持平、环比走弱', 'neutral');
  return ok('趋势平稳', 'neutral');
}

/**
 * 构建指标分析
 * @param {object} quote 行情对象（含 .fundamentals）
 * @param {object} comparison buildFundamentalComparison 结果（含 .percentiles / .industryAvg）
 * @param {object} companyType 公司类型（含 .isFinancial）
 * @param {Array} signals evaluateSignals 输出 signal 数组（提供权威判定依据）
 */
function buildMetricAnalysis(quote, comparison, companyType, signals, fundamental) {
  const f = (quote && quote.fundamentals) || {};
  const m = (fundamental && fundamental.metrics) || {};
  const comp = comparison || {};
  const pct = comp.percentiles || {};
  const ind = comp.industryAvg || {};
  const zyzb = Array.isArray(f.zyzbHistory) ? f.zyzbHistory : [];
  const isFinancial = !!(companyType && companyType.isFinancial);

  // 当前值取数优先级：quote.fundamentals（TTM 优先）→ fundamental.metrics（与左侧「关键财务指标」卡同源，保证两卡一致）
  const val = (fk, mk) => (f[fk] != null ? f[fk] : (m[mk] != null ? m[mk] : null));

  const sigMap = {};
  (Array.isArray(signals) ? signals : []).forEach(s => { sigMap[s.key] = s; });

  const metrics = [];

  // —— 水平型盈利能力/质量指标（higherBetter = true）——
  // ROE
  {
    const cur = val('roeTtm', 'roe');
    const curText = cur != null ? cur.toFixed(1) + '%' : '--';
    const yoy = f.roeTtmPrev != null
      ? (() => { const d = cur - f.roeTtmPrev; return ok(`同比 ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp（TTM 同口径）`, deltaSignal(d, true)); })()
      : yoyDim(samePeriodPair(zyzb, 'ROEJQ').cur, samePeriodPair(zyzb, 'ROEJQ').prev, true, '%');
    const qoq = qoqDim(consecutivePair(zyzb, 'ROEJQ').cur, consecutivePair(zyzb, 'ROEJQ').prev, true, '%');
    metrics.push({
      key: 'roe', label: 'ROE', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: industryDim(cur, ind.roe, true, '%'), pct: pctDim(pct.roe, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.roe || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 毛利率
  {
    const cur = val('grossMarginTtm', 'grossMargin');
    const curText = cur != null ? cur.toFixed(1) + '%' : '--';
    const yoy = yoyDim(samePeriodPair(zyzb, 'XSMLL').cur, samePeriodPair(zyzb, 'XSMLL').prev, true, '%');
    const qoq = qoqDim(consecutivePair(zyzb, 'XSMLL').cur, consecutivePair(zyzb, 'XSMLL').prev, true, '%');
    metrics.push({
      key: 'grossMargin', label: '毛利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业毛利率均值）'), pct: pctDim(pct.grossMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.grossMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 净利率
  {
    const cur = val('netMarginTtm', 'netMargin');
    const curText = cur != null ? cur.toFixed(1) + '%' : '--';
    const yoy = yoyDim(samePeriodPair(zyzb, 'XSJLL').cur, samePeriodPair(zyzb, 'XSJLL').prev, true, '%');
    const qoq = qoqDim(consecutivePair(zyzb, 'XSJLL').cur, consecutivePair(zyzb, 'XSJLL').prev, true, '%');
    metrics.push({
      key: 'netMargin', label: '净利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业净利率均值）'), pct: pctDim(pct.netMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.netMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }

  // —— 成长指标（值本身为同比 %）——
  const buildGrowth = (key, label, cur, pctKey, field) => {
    const curText = cur != null ? cur.toFixed(1) + '%' : '--';
    const pair = samePeriodPair(zyzb, field);
    let yoy, marginal;
    if (cur == null) { yoy = na('不可得'); marginal = na('不可得'); }
    else if (pair.prev == null) {
      yoy = ok(`本报告期 ${cur.toFixed(1)}%（缺去年同期对比）`, cur > 0 ? 'bull' : cur < 0 ? 'bear' : 'neutral');
      marginal = ok(cur > 0 ? '正增长' : '负增长', cur > 0 ? 'bull' : 'bear');
    } else {
      const dpp = cur - pair.prev;
      const sig = dpp > 0.5 ? 'bull' : dpp < -0.5 ? 'bear' : 'neutral';
      yoy = ok(`本报告期 ${cur.toFixed(1)}%（去年同期 ${pair.prev.toFixed(1)}%，边际 ${dpp >= 0 ? '+' : ''}${dpp.toFixed(1)}pp）`, sig);
      marginal = ok(`增速同比${dpp > 0 ? '加速' : '放缓'} ${Math.abs(dpp).toFixed(1)}pp`, sig);
    }
    metrics.push({
      key, label, valueText: curText, unit: '%',
      dims: { yoy, qoq: na('—（增长率本身为同比口径，环比不适用）'), industry: na('不可得（无行业增速均值）'), pct: pctDim(pct[pctKey], true), marginal },
      judgment: sigMap[key] || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  };
  buildGrowth('growth', '营收增长', f.revenueYoy != null ? f.revenueYoy : (f.revenueGrowth || null), 'revenueGrowth', 'TOTALOPERATEREVETZ');
  buildGrowth('profitGrowth', '利润增长', f.profitYoy != null ? f.profitYoy : (f.profitGrowth || null), 'profitGrowth', 'PARENTNETPROFITTZ');
  if (f.deductedProfitGrowth != null) buildGrowth('dedProfitGrowth', '扣非净利润增长', f.deductedProfitGrowth, null, 'KCFJCXSYJLRTZ');

  // —— 偿债/质量指标 ——
  // 资产负债率（lowerBetter = false；金融业高负债为常态，判定由 signals 层处理）
  {
    const cur = f.debtToEquity != null ? f.debtToEquity : null;
    const unit = f.debtMetricPct ? '%' : '';
    const curText = cur != null ? cur.toFixed(2) + unit : '--';
    const yoy = yoyDim(cur, samePeriodPair(zyzb, 'ZCFZL').prev, false, unit);
    const qoq = qoqDim(consecutivePair(zyzb, 'ZCFZL').cur, consecutivePair(zyzb, 'ZCFZL').prev, false, unit);
    metrics.push({
      key: 'debt', label: '资产负债率', valueText: curText, unit,
      dims: { yoy, qoq, industry: na('不可得（无行业负债率均值）'), pct: pctDim(pct.debtToEquity, false), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.debt || { signal: 'neutral', reason: isFinancial ? '金融业高负债为经营常态，不视为利空' : '数据不足，无法判定' },
    });
  }
  // 流动比率（higherBetter = true）
  {
    const cur = f.currentRatio != null ? f.currentRatio : null;
    const curText = cur != null ? cur.toFixed(2) : '--';
    const yoy = yoyDim(cur, samePeriodPair(zyzb, 'LD').prev, true, '');
    const qoq = qoqDim(consecutivePair(zyzb, 'LD').cur, consecutivePair(zyzb, 'LD').prev, true, '');
    metrics.push({
      key: 'currentRatio', label: '流动比率', valueText: curText, unit: '',
      dims: { yoy, qoq, industry: na('不可得（无行业流动比率均值）'), pct: pctDim(pct.currentRatio, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.currentRatio || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 股息率（higherBetter = true；同比用每股股息同比）
  {
    const cur = f.dividendYield != null ? f.dividendYield : null;
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const dyYoy = typeof f.dividendYoyPct === 'number' ? f.dividendYoyPct : null;
    const yoy = dyYoy != null
      ? ok(`每股股息同比 ${dyYoy >= 0 ? '+' : ''}${dyYoy.toFixed(1)}%`, deltaSignal(dyYoy, true))
      : na('不可得（无分红同比）');
    metrics.push({
      key: 'div', label: '股息率(TTM)', valueText: curText, unit: '%',
      dims: { yoy, qoq: na('—（分红为离散事件，环比不适用）'), industry: na('不可得（无行业股息率均值）'), pct: na('不可得（无股息率历史序列）'), marginal: yoy.available ? ok(dyYoy > 0 ? '分红加码' : '分红缩减', yoy.signal) : na('不可得') },
      judgment: sigMap.div || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 每股经营现金流（higherBetter = true；无同比/行业序列时多标注不可得）
  {
    const cur = val('operatingCashFlowPerShare', 'operatingCashFlowPerShare');
    const curText = cur != null ? cur.toFixed(2) : '--';
    metrics.push({
      key: 'ocf', label: '每股经营现金流', valueText: curText, unit: '',
      dims: { yoy: na('不可得（无历史序列）'), qoq: na('不可得（无历史序列）'), industry: na('不可得（无行业均值）'), pct: na('不可得'), marginal: na('不可得') },
      judgment: sigMap.ocf || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }

  // —— 估值指标（PE/PB/PS，lowerBetter = false：估值越低越好）——
  const buildVal = (key, label, cur, indKey, pctKey) => {
    const curText = cur != null ? cur.toFixed(2) : '--';
    metrics.push({
      key, label, valueText: curText, unit: '×',
      dims: {
        yoy: na('—（估值随行情每日变动，无同比口径）'),
        qoq: na('—（随行情实时变动）'),
        industry: industryDim(cur, ind[indKey], false, '×'),
        pct: pctDim(pct[pctKey], false),
        marginal: na('—（随行情实时变动）'),
      },
      judgment: sigMap[key] || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  };
  buildVal('pe', '市盈率(PE·TTM)', f.pe, 'pe', 'pe');
  buildVal('pb', '市净率(PB)', f.pb, 'pb', 'pb');
  buildVal('ps', '市销率(PS)', f.ps, 'ps', 'ps');

  return {
    metrics,
    isFinancial,
    note: '指标分析为确定性代码计算，覆盖同比/环比(较上一披露期·累计口径)/行业均值/历史百分位/边际变化五维；「判定依据」与左侧利好·中性·利空信号同源。缺数据维度如实标注「不可得」。',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMetricAnalysis };
