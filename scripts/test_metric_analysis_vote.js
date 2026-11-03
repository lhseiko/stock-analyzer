#!/usr/bin/env node
/**
 * scripts/test_metric_analysis_vote.js — 20261103m 守卫
 *
 * 用户指令：①「指标分析获得5项数据，三项绿色利空判定，总体判定就应该是利空」→ 五维多数决；
 *          ②「环比无法从财报直接获得时，用季报数据计算后获得，但要标明本机计算」→ 单季差分环比。
 * 关联修复：analysis.js evaluateSignals 百分数口径契约（移除 A股字段 ×100 启发式）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { evaluateSignals } = require(path.join(ROOT, 'lib/analysis.js'));
const { buildMetricAnalysis, dimsVote, sqSeries, sqQoqDim } = require(path.join(ROOT, 'lib/metricAnalysis.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('=== §1 evaluateSignals 百分数口径契约（×100 放大回归）===');
{
  // 海天味业 Q3'26 实测口径：单季营收同比 0.12%（百分数），去年同期 2.45% → 边际放缓，利空
  const f = {
    zyzbHistory: [
      { REPORT_DATE: '2026-09-30', DJD_TOI_YOY: 0.12, DJD_DPNP_YOY: -5.3, DJD_DEDUCTDPNP_YOY: -6.1 },
      { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, DJD_DPNP_YOY: 3.2, DJD_DEDUCTDPNP_YOY: 1.0 },
    ],
  };
  const res = evaluateSignals(f, null, null, {});
  const sigs = res.signals || [];
  const byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.signal === 'bear', `营收增速 0.12% vs 去年同期 2.45% 判 bear（实际 ${byKey.growth && byKey.growth.signal}）`);
  ok(byKey.growth && byKey.growth.value === '0.1%', `营收增速值不被放大成 12.4%（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.reason.indexOf('放缓') >= 0, `reason 含「放缓」（实际 ${byKey.growth && byKey.growth.reason}）`);
  ok(byKey.profitGrowth && byKey.profitGrowth.signal === 'bear', `利润增速 -5.3% 判 bear`);
  ok(byKey.dedProfitGrowth && byKey.dedProfitGrowth.signal === 'bear', `扣非增速 -6.1% 判 bear`);
  // 兜底字段：revenueYoy 缺失、revenueGrowth 为小数（Yahoo 美股口径）→ 仍应 ×100
  // （负增长分支必然推送信号；正增长 0~15% 区间在无历史序列时不推送信号属既有行为）
  const fUS = { zyzbHistory: [], revenueGrowth: -0.081 };
  const resUS = evaluateSignals(fUS, null, null, {});
  const gUS = (resUS.signals || []).find(s => s.key === 'growth');
  ok(gUS && gUS.value === '-8.1%', `美股兜底 revenueGrowth 小数仍 ×100（实际 ${gUS && gUS.value}）`);
  // 源码级守卫：A股字段启发式已移除
  const src = fs.readFileSync(path.join(ROOT, 'lib/analysis.js'), 'utf8');
  ok(src.indexOf('_revNorm') < 0, 'analysis.js 已无 _revNorm 启发式');
  ok(src.indexOf('Math.abs(rgRaw) < 1') < 0, 'analysis.js 已无 rgRaw <1 即 ×100 启发式');
  ok(src.indexOf('Math.abs(pgRaw) < 1') < 0, 'analysis.js 已无 pgRaw <1 即 ×100 启发式');
}

console.log('=== §2 dimsVote 五维多数决 ===');
{
  const dims3Bear = {
    yoy: { available: true, signal: 'bear', text: 'a' },
    qoq: { available: true, signal: 'bear', text: 'b' },
    industry: { available: true, signal: 'bear', text: 'c' },
    pct: { available: true, signal: 'bull', text: 'd' },
    marginal: { available: false, signal: null, text: '' },
  };
  const v1 = dimsVote(dims3Bear, { signal: 'bull', reason: '信号判定利好' });
  ok(v1.conflict === true, '3 利空 vs 1 利好 → 多数决判利空且标记冲突');
  ok(v1.judgment.signal === 'bear', `多数决 signal=bear（实际 ${v1.judgment.signal}）`);
  ok(v1.judgment.reason.indexOf('已按多数决为准') >= 0, 'reason 显式标注「已按多数决为准」');
  ok(v1.judgment.reason.indexOf('信号判定利好') >= 0, 'reason 保留原判定依据');

  const v2 = dimsVote({ yoy: dims3Bear.yoy }, { signal: 'bull', reason: '仅一维' });
  ok(v2.conflict === false && v2.judgment.signal === 'bull', '可用维度 <2 → 沿用原判定不投票');

  const v3 = dimsVote({
    yoy: { available: true, signal: 'bull', text: 'a' },
    qoq: { available: true, signal: 'bull', text: 'b' },
  }, { signal: 'bull', reason: '一致' });
  ok(v3.conflict === false && v3.judgment.reason === '一致', '多数决与原判定一致 → 原判定原样保留');
}

console.log('=== §3 单季差分（sqSeries / sqQoqDim）===');
{
  // 累计值（元）：海天 2026 真实口径量级
  const zy = [
    { REPORT_DATE: '2026-09-30', TOTALOPERATEREVE: 225.53e8 },
    { REPORT_DATE: '2026-06-30', TOTALOPERATEREVE: 161.46e8 },
    { REPORT_DATE: '2026-03-31', TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-12-31', TOTALOPERATEREVE: 245.36e8 },
    { REPORT_DATE: '2025-09-30', TOTALOPERATEREVE: 200.00e8 },
  ];
  const sq = sqSeries(zy, 'TOTALOPERATEREVE');
  const byDate = {}; sq.forEach(x => { byDate[x.date] = x.sq; });
  ok(Math.abs(byDate['2026-03-31'] - 90.29e8) < 1, 'Q1 单季 = 累计本身');
  ok(Math.abs(byDate['2026-06-30'] - 71.17e8) < 1e6, `Q2 单季 = 161.46 − 90.29 = 71.17亿`);
  ok(Math.abs(byDate['2026-09-30'] - 64.07e8) < 1e6, `Q3 单季 = 225.53 − 161.46 = 64.07亿`);
  ok(Math.abs(byDate['2025-12-31'] - 45.36e8) < 1e6, `Q4 单季 = FY − 9M = 45.36亿（按年分链）`);

  const q1 = sqQoqDim(zy, 'TOTALOPERATEREVE');
  ok(q1.available && q1.signal === 'bear', `Q3 单季 64.07 vs Q2 71.17 环比 ≈ -9.98% 判 bear（实际 ${q1.text}）`);
  ok(q1.text.indexOf('本机计算') >= 0, '环比文案含「本机计算」标注');
  ok(q1.text.indexOf('跨年') < 0, '同一年内相邻季不附跨年季节性提示');

  // 跨年相邻季（Q1 vs 去年 Q4）：仍计算但提示季节性
  const zyQ1 = [
    { REPORT_DATE: '2026-03-31', TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-12-31', TOTALOPERATEREVE: 245.36e8 },
    { REPORT_DATE: '2025-09-30', TOTALOPERATEREVE: 200.00e8 },
  ];
  const q2 = sqQoqDim(zyQ1, 'TOTALOPERATEREVE');
  ok(q2.available && q2.signal === 'bull', `Q1 90.29 vs 去年Q4 45.36 环比 +99% 判 bull`);
  ok(q2.text.indexOf('跨年相邻季含季节性') >= 0, '跨年相邻季附季节性提示');

  // 数据不足：单期 → 不可得
  const q3 = sqQoqDim([{ REPORT_DATE: '2026-09-30', TOTALOPERATEREVE: 1e8 }], 'TOTALOPERATEREVE');
  ok(!q3.available, '累计值不足两期 → 如实标注不可得');
}

console.log('=== §4 buildMetricAnalysis 集成：成长指标环比 + 多数决覆盖 ===');
{
  const zy = [
    { REPORT_DATE: '2026-09-30', DJD_TOI_YOY: 0.12, TOTALOPERATEREVE: 225.53e8 },
    { REPORT_DATE: '2026-06-30', DJD_TOI_YOY: 2.93, TOTALOPERATEREVE: 161.46e8 },
    { REPORT_DATE: '2026-03-31', DJD_TOI_YOY: 8.57, TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, TOTALOPERATEREVE: 200.00e8 },
  ];
  const quote = { fundamentals: { zyzbHistory: zy, revenueYoy: 0.12 } };
  const signals = [
    { key: 'growth', signal: 'bull', reason: '旧信号判定（将被多数决复核）' },
  ];
  const ma = buildMetricAnalysis(quote, {}, { isFinancial: false }, signals, { metrics: {} }, null, null);
  const growth = ma.metrics.find(x => x.key === 'growth');
  ok(!!growth, 'growth 指标构建');
  ok(growth.dims.qoq.available === true, '环比维度不再是「不适用」占位，改为本机计算');
  ok(growth.dims.qoq.text.indexOf('本机计算') >= 0, '环比文案含「本机计算」');
  // 多数决：yoy（0.12 vs 2.45 放缓 bear）+ qoq（-9.98% bear）+ marginal（bear）→ 3 bear → judgment bear
  ok(growth.judgment.signal === 'bear', `五维多数决覆盖 growth judgment → bear（实际 ${growth.judgment.signal}）`);
  ok(growth.judgment.reason.indexOf('已按多数决为准') >= 0, 'judgment.reason 标注多数决冲突说明');
  ok(ma.voteConflicts >= 1, `voteConflicts 计数导出（实际 ${ma.voteConflicts}）`);
  ok(ma.note.indexOf('五维多数决') >= 0 && ma.note.indexOf('本机计算') >= 0, '返回 note 含新口径说明');
}

console.log('=== §5 前端/版本戳守卫 ===');
{
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const cnt = (appJs.match(/metricAnalysis\?\.metrics \|\| \[\]\)\.forEach/g) || []).length;
  ok(cnt === 2, `app.js 左卡 + 顶栏两处消费 metricAnalysis judgment（实际 ${cnt} 处）`);
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261103m'/.test(serverJs), "APP_VERSION = '20261103m'");
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.indexOf('?v=20261103m') >= 0, 'index.html 版本戳 ?v=20261103m');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
