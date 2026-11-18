#!/usr/bin/env node
/**
 * test_goodwill_metric.js — 任务卡 #018「全部个股新增商誉指标」专项守卫
 * ============================================================================
 * 覆盖：
 *   1) 阈值纯函数：<5% 利好 5 分 / 5%、10% 含边界中性 3 分 / >10% 利空 0 分 / 无商誉 0% 利好 5 分
 *   2) 最新一期资产负债表取数：季报优先于年报、未来报告期过滤、归母净资产分母、无商誉、缺失降级
 *   3) 财务健康评分：五项各 5 分、商誉进入扣分明细；未注入商誉时旧四项口径行为不变
 *   4) 信号 / 指标分析：商誉信号三态、右卡专项说明含来源/成因/占总资产与净资产/减值风险/健康影响
 *   5) 接线：server 三处共用同一 goodwill 快照、左卡最下方新增行、单一权威顺序末尾对齐
 *
 * 离线、零网络、零生产数据依赖。
 * @test-scope: local
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const gw = require('../lib/goodwill');
const { computeFundamentalScore } = require('../lib/fundamentalScore');
const { evaluateSignals } = require('../lib/analysis');
const { buildMetricAnalysis, METRIC_ORDER } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; const msg = name + (detail ? ' → ' + detail : ''); failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(a, b, name) { ok(a === b, name, `实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}`); }

console.log('\n=== #018 商誉指标专项守卫 ===\n');

// ---------- 1) 阈值纯函数（确定性、边界锁死） ----------
eq(gw.classifyRatio(0).signal, 'bull', '无商誉 0% → 利好');
eq(gw.classifyRatio(0).score, 5, '无商誉 0% → 5 分');
eq(gw.classifyRatio(4.99).score, 5, '4.99% → 5 分');
eq(gw.classifyRatio(5).signal, 'neutral', '5% 边界 → 中性');
eq(gw.classifyRatio(5).score, 3, '5% 边界 → 3 分');
eq(gw.classifyRatio(7.5).signal, 'neutral', '7.5% → 中性');
eq(gw.classifyRatio(10).signal, 'neutral', '10% 边界 → 中性');
eq(gw.classifyRatio(10).score, 3, '10% 边界 → 3 分');
eq(gw.classifyRatio(10.01).signal, 'bear', '10.01% → 利空');
eq(gw.classifyRatio(10.01).score, 0, '10.01% → 0 分');
eq(gw.classifyRatio(null).signal, null, '缺失 → 不判定');
eq(gw.classifyRatio(-1).score, null, '归母净资产为负导致的负比例 → 不参与评分');

// ---------- 2) 最新一期资产负债表（季报优先 / 未来过滤 / 分母 / 无商誉 / 缺失） ----------
const TODAY = '2026-11-17';
const yCases = [
  { REPORT_DATE: '2025-06-30', REPORT_DATE_NAME: '2025中报', GOODWILL: 6e8, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 200e8 },
  { REPORT_DATE: '2025-12-31', REPORT_DATE_NAME: '2025年报', GOODWILL: 8e8, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 210e8 },
  { REPORT_DATE: '2026-06-30', REPORT_DATE_NAME: '2026中报', GOODWILL: 12e8, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 250e8 },
  { REPORT_DATE: '2026-09-30', REPORT_DATE_NAME: '2026三季报', GOODWILL: 15e8, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 260e8 },
  { REPORT_DATE: '2026-12-31', REPORT_DATE_NAME: '2026年报(未披露)', GOODWILL: 999e8, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 999e8 },
];
const snap = gw.fromBalanceRows(yCases, { today: TODAY });
ok(snap.available && snap.date === '2026-09-30', '选最新已披露季报（不是年报，也不是未来日期）', snap.date);
eq(snap.goodwillYi, 15, '商誉 15 亿（元→亿）');
eq(snap.ratio, 15, '占归母净资产 15%（100 亿分母）');
eq(snap.assetRatio, 5.77, '占总资产 5.77%（260 亿分母，2 位小数）');
eq(snap.score, 0, '15% → 财务健康商誉项 0 分');
eq(snap.signal, 'bear', '15% → 利空信号');
ok(snap.prevPeriodRatio === 12, '上一披露期占比 12% 可供环比维度（实际 ' + snap.prevPeriodRatio + '）');

const zeroSnap = gw.fromBalanceRows([
  { REPORT_DATE: '2026-09-30', REPORT_DATE_NAME: '2026三季报', GOODWILL: 0, TOTAL_PARENT_EQUITY: 100e8, TOTAL_ASSETS: 260e8 },
], { today: TODAY });
ok(zeroSnap.available && zeroSnap.noGoodwill, '无商誉 → available=true 且 noGoodwill=true（不是缺失）');
eq(zeroSnap.goodwillYi, 0, '无商誉 → 数值 0');
eq(zeroSnap.ratio, 0, '无商誉 → 占比 0%');
eq(zeroSnap.score, 5, '无商誉 → 5 分');
eq(zeroSnap.signal, 'bull', '无商誉 → 利好');

const badSnap = gw.fromBalanceRows([
  { REPORT_DATE: '2026-09-30', GOODWILL: 10e8, TOTAL_PARENT_EQUITY: 0, TOTAL_ASSETS: 100e8 },
], { today: TODAY });
ok(!badSnap.available && badSnap.score === null, '归母净资产非正 → 不可用、不评分');

// ---------- 3) 财务健康评分：五项各 5 分 + 未注入时旧行为不变 ----------
const quote = {
  fundamentals: {
    pe: 20, pb: 2, ps: 3,
    roeTtm: 15, netMarginTtm: 20, grossMarginTtm: 40,
    revenueGrowth: 10, profitGrowth: 12, deductedProfitGrowth: 11,
    debtToEquity: 40, debtMetricPct: true,
    currentRatio: 2, operatingCashFlowPerShare: 1,
    dividendYield: 2, dividendYieldIsPct: true,
    valuationHistory: [], zyzbHistory: [],
  },
};
const ct = { type: 'balanced', typeName: '均衡型' };
const withGw = computeFundamentalScore({ quote, companyType: ct, industryAvg: {}, goodwill: snap });
const withoutGw = computeFundamentalScore({ quote, companyType: ct, industryAvg: {} });
ok(withGw.dimensionLogic.health.metrics.some(x => x[0] === '商誉' && /0\.0 分/.test(x[1])),
  '商誉 15% 进入扣分明细且为 0.0 分',
  JSON.stringify(withGw.dimensionLogic.health.metrics));
ok(!withoutGw.dimensionLogic.health.metrics.some(x => x[0] === '商誉'),
  '未注入 goodwill 的旧调用方仍按四项口径，行为不变');
ok(/商誉/.test(withGw.dimensionLogic.health.rule) && /5 分/.test(withGw.dimensionLogic.health.summary),
  '健康维度规则与摘要同步反映商誉五项各 5 分');
eq(withGw.scores.health.max, 25, '财务健康维度满分仍为 25');
ok(withGw.scores.health.score <= withoutGw.scores.health.score,
  '高商誉占比不应提高财务健康总分');
const zeroGwScore = computeFundamentalScore({ quote, companyType: ct, industryAvg: {}, goodwill: zeroSnap });
ok(zeroGwScore.dimensionLogic.health.metrics.some(x => x[0] === '商誉' && /无商誉/.test(x[1]) && /5\.0 分/.test(x[1])),
  '无商誉 → 扣分明细显示无商誉且 5.0 分');
const badGwScore = computeFundamentalScore({ quote, companyType: ct, industryAvg: {}, goodwill: badSnap });
ok(!badGwScore.dimensionLogic.health.metrics.some(x => x[0] === '商誉' && /分/.test(x[1])),
  '商誉不可得 → 不参与评分（沿用现有缺失规则）');
ok(badGwScore.unavailable.some(u => u.dimension === '财务健康' && u.metric === '商誉'),
  '商誉不可得 → 进入 unavailable 提示清单');

// ---------- 4) 信号与指标分析专项说明 ----------
const sigRes = evaluateSignals(quote.fundamentals, ct, null, { goodwill: snap });
const gwSig = sigRes.signals.find(s => s.key === 'goodwill');
ok(gwSig && gwSig.signal === 'bear' && /15\.00亿/.test(gwSig.value), 'evaluateSignals 输出商誉利空信号', JSON.stringify(gwSig));
const zeroSig = evaluateSignals(quote.fundamentals, ct, null, { goodwill: zeroSnap }).signals.find(s => s.key === 'goodwill');
ok(zeroSig && zeroSig.signal === 'bull', '无商誉 → 利好信号');
const noSig = evaluateSignals(quote.fundamentals, ct, null, {}).signals.find(s => s.key === 'goodwill');
ok(!noSig, '未传商誉时不产生信号（缺失规则）');

const ma = buildMetricAnalysis({ fundamentals: quote.fundamentals }, {}, ct, sigRes.signals, withGw, null, null, snap);
const gwM = ma.metrics.find(m => m.key === 'goodwill');
ok(gwM && ma.metrics[ma.metrics.length - 1].key === 'goodwill', '右卡商誉项存在且排在最后（与左卡最下方同序）');
eq(ma.metrics.map(m => m.key).join(','), METRIC_ORDER.filter(k => k !== 'opProfit' && k !== 'nbv').join(','), '传入商誉时右卡顺序严格等于 METRIC_ORDER（去掉未提供的条件指标）');
eq(gwM.valueText, '15.00亿 · 15.00%', '右卡商誉数值格式与左卡一致（亿元 + 占比）');
eq(gwM.judgment.signal, 'bear', '右卡商誉判定与阈值一致');
for (const phrase of ['主要来源', '形成原因', '占总资产', '占归母净资产', '减值', '财务健康']) {
  ok(gwM.note.includes(phrase), `商誉专项说明包含「${phrase}」`);
}
ok(!/本工具编造|具体收购对象为/.test(gwM.note) && /不编造/.test(gwM.note), '说明如实声明不编造收购对象');

// 商誉阈值是硬规则：即使占比同比/环比上升，低商誉档也不得被五维多数决改判
const risingLow = Object.assign({}, zeroSnap, {
  noGoodwill: false, goodwillYi: 2, ratio: 2, ratioRaw: 2,
  priorRatio: 1, prevPeriodRatio: 1, signal: 'bull', score: 5,
  reason: '2% < 5%，利好',
});
const maRising = buildMetricAnalysis({ fundamentals: {} }, {}, ct, [], {}, null, null, risingLow);
const risingM = maRising.metrics.find(m => m.key === 'goodwill');
eq(risingM.judgment.signal, 'bull', '低商誉占比同比/环比上升 → 仍按 <5% 阈值判利好（不参与多数决）');
ok(risingM.dims.yoy.signal === 'bear' && risingM.dims.qoq.signal === 'bear', '五维对比仍如实展示占比上升趋势');

const maMiss = buildMetricAnalysis({ fundamentals: {} }, {}, ct, [], {}, null, null, gw.unavailable('测试缺失'));
const gwMiss = maMiss.metrics.find(m => m.key === 'goodwill');
ok(gwMiss && gwMiss.valueText === '--' && gwMiss.dims.yoy.available === false, '商誉缺失 → 右卡显示 -- 且维度标不可得');
ok(/不参与财务健康评分/.test(gwMiss.note), '商誉缺失 → 专项说明明示不参与评分');

// ---------- 5) 接线：单一权威快照贯通三处 + 左卡最下方 ----------
const SERVER = src('server.js');
ok(/fetchGoodwillSnippet/.test(SERVER) && /const goodwillMath = require\('\.\/lib\/goodwill'\)/.test(SERVER),
  'server.js 引入商誉取数与不可用出口');
ok(/industryAvg: industryAvgForScore, goodwill/.test(SERVER), 'server.js 把 goodwill 注入财务健康评分');
ok(/percentiles: \(comparison && comparison\.percentiles\) \|\| null, goodwill/.test(SERVER),
  'server.js 把 goodwill 注入信号判定');
ok(/fundamental, opProfit, insuranceNBV, goodwill\)/.test(SERVER), 'server.js 把 goodwill 注入指标分析');
ok(/^\s+goodwill, \/\/ 20261117a/m.test(SERVER), 'server.js 响应下发 goodwill 字段');
const FIN = src('lib/deep/financials.js');
ok(/fetchGoodwillSnippet/.test(FIN) && /zcfzbAjaxNew/.test(FIN) && /getLatestPartialQuarterDates/.test(FIN),
  '取数层走最新一期资产负债表（含季末报告期）');
const APP = src('public/js/app.js');
ok(/\['商誉', gwValue/.test(APP), '左卡新增「商誉」行且数值由统一快照拼装');
ok(/'商誉': 'goodwill'/.test(APP), '左卡 keyOf 映射商誉 → 右卡同键');
ok(APP.indexOf("['商誉', gwValue") > APP.indexOf("['每股经营现金流'"), '商誉行位于「每股经营现金流」之后（最下方）');
const GW_SRC = src('lib/goodwill.js');
ok(!/Math\.random/.test(GW_SRC) && !/require\(/.test(GW_SRC), '商誉判定为无外部依赖的纯确定性代码');

console.log(`\nPASS ${pass}/${pass}`);
if (fail) { console.log(`FAIL ${fail}`); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
