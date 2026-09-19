/**
 * scripts/test_metric_analysis.js — 指标分析引擎 + evaluateSignals 升级通道 离线确定性测试
 * 仅依赖本地模块与合成数据，不触网。
 */
'use strict';
const path = require('path');
const { evaluateSignals } = require('../lib/analysis');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const zyzb = [
  { REPORT_DATE: '2026-06-30', ROEJQ: 11.6, XSMLL: 35.2, XSJLL: 18.4, ZCFZL: 62.0, LD: 1.8, TOTALOPERATEREVETZ: 12.0, PARENTNETPROFITTZ: 15.0, KCFJCXSYJLRTZ: 14.0 },
  { REPORT_DATE: '2025-12-31', ROEJQ: 11.0, XSMLL: 34.0, XSJLL: 17.0, ZCFZL: 63.0, LD: 1.7, TOTALOPERATEREVETZ: 9.0, PARENTNETPROFITTZ: 10.0, KCFJCXSYJLRTZ: 9.5 },
  { REPORT_DATE: '2025-06-30', ROEJQ: 10.5, XSMLL: 33.5, XSJLL: 16.5, ZCFZL: 64.0, LD: 1.6, TOTALOPERATEREVETZ: 8.0, PARENTNETPROFITTZ: 8.0, KCFJCXSYJLRTZ: 7.5 },
];

const f = {
  roeTtm: 11.6, roeTtmPrev: 9.0, grossMarginTtm: 35.2, netMarginTtm: 18.4,
  revenueYoy: 12.0, profitYoy: 15.0, deductedProfitGrowth: 14.0,
  debtToEquity: 62.0, debtMetricPct: true, currentRatio: 1.8, dividendYield: 2.1, dividendYoyPct: 5.0,
  pe: 18, pb: 1.3, ps: 4, operatingCashFlowPerShare: 1.2,
  zyzbHistory: zyzb,
};
const comparison = {
  percentiles: { roe: 75, grossMargin: 70, netMargin: 68, revenueGrowth: 60, profitGrowth: 55, debtToEquity: 40, currentRatio: 50, pe: 30, pb: 25, ps: 20 },
  industryAvg: { pe: 15, pb: 1.2, ps: 3, roe: 10, source: 'test' },
};
const finType = { isFinancial: true, type: 'balanced' };

console.log('【1】evaluateSignals ROE 相对优势升级通道（金融业 ROE 11.6%，显著优于行业均值 10% → 应升利好）');
const sigs = evaluateSignals(f, finType, comparison.industryAvg, { percentiles: comparison.percentiles });
const roeSig = sigs.signals.find(s => s.key === 'roe');
assert('ROE 信号为 bull', roeSig && roeSig.signal === 'bull', roeSig && roeSig.signal);
assert('ROE 判定依据含「显著优于行业均值」', roeSig && /显著优于行业均值/.test(roeSig.reason), roeSig && roeSig.reason);

console.log('【2】回归守卫：无相对优势证据时金融业 ROE 11.6% 仍判中性（复现旧行为，避免误升）');
const sigsNeu = evaluateSignals(
  Object.assign({}, f, { roeTtmPrev: null }),
  finType,
  { roe: 12 }, // 行业均值 12，11.6 < 12*1.1，不显著优于
  { percentiles: { roe: null } } // 无历史百分位
);
const roeNeu = sigsNeu.signals.find(s => s.key === 'roe');
assert('ROE 无证据时仍为 neutral', roeNeu && roeNeu.signal === 'neutral', roeNeu && roeNeu.signal);

console.log('【3】buildMetricAnalysis 五维结构完整性（华安样例）');
const ma = buildMetricAnalysis({ fundamentals: f }, comparison, finType, sigs.signals);
assert('返回指标数组非空', Array.isArray(ma.metrics) && ma.metrics.length > 0, 'len=' + (ma.metrics || []).length);
const dimKeys = ['yoy', 'qoq', 'industry', 'pct', 'marginal'];
let allFive = true, anyNaAll = false;
ma.metrics.forEach(m => {
  dimKeys.forEach(k => {
    const d = (m.dims || {})[k];
    if (!d || typeof d.text !== 'string') allFive = false;
  });
  if (m.key === 'roe') {
    assert('ROE 判定与 evaluateSignals 一致(bull)', m.judgment && m.judgment.signal === 'bull', m.judgment && m.judgment.signal);
    assert('ROE 同比维度可用且有文本', m.dims.yoy.available && /同比/.test(m.dims.yoy.text), m.dims.yoy.text);
    assert('ROE 环比维度标注「累计口径」', /累计口径/.test(m.dims.qoq.text), m.dims.qoq.text);
    assert('ROE 行业均值维度可用', m.dims.industry.available, m.dims.industry.text);
    assert('ROE 历史百分位维度可用', m.dims.pct.available, m.dims.pct.text);
  }
});
assert('每个指标均含五维且有文本', allFive);

console.log('【4】缺数据如实标注「不可得」');
const maEmpty = buildMetricAnalysis({ fundamentals: {} }, { percentiles: {}, industryAvg: {} }, { isFinancial: false }, []);
const roeEmpty = maEmpty.metrics.find(m => m.key === 'roe');
assert('ROE 当前值缺 → 行业均值维度不可得', roeEmpty && roeEmpty.dims.industry.available === false && /不可得/.test(roeEmpty.dims.industry.text), roeEmpty && roeEmpty.dims.industry.text);
assert('空数据不崩溃且判定为 neutral 兜底', roeEmpty && roeEmpty.judgment.signal === 'neutral', roeEmpty && roeEmpty.judgment.signal);

console.log('【5】毛利率/净利率 升级通道（历史高分位 ≥80 或 同比改善 >1.5pp → 中性升利好）');
const gmSigs = evaluateSignals(
  { grossMarginTtm: 22, netMarginTtm: 12, zyzbHistory: zyzb },
  { isFinancial: false },
  null,
  { percentiles: { grossMargin: 85, netMargin: 80 } } // 历史高分位触发升级
);
const gm = gmSigs.signals.find(s => s.key === 'grossMargin');
const nm = gmSigs.signals.find(s => s.key === 'netMargin');
assert('毛利率 22%（中性带）处历史85分位 → bull', gm && gm.signal === 'bull', gm && gm.signal);
assert('净利率 12%（中性带）处历史80分位 → bull', nm && nm.signal === 'bull', nm && nm.signal);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
