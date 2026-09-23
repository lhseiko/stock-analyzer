/**
 * scripts/test_metric_analysis_order.js — 「指标分析」(右卡) 与「关键财务指标」(左卡) 对齐回归
 * 对应 20260923l 四项修复：
 *   ① 顺序对齐左卡（估值前置，METRIC_ORDER 单一权威顺序）
 *   ② 补 PEG（两卡 14 项一一对应）
 *   ③ 修「扣非净利润增长」死代码（双源取值、无条件构建）
 *   ④ 统一 0 与 `--` 口径（兜底 0 = 缺失哨兵）
 *
 * 运行： node scripts/test_metric_analysis_order.js
 * 断言全部通过时打印 "PASS N/N"，并 exit 0；任一失败打印 FAIL 明细并 exit 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { buildMetricAnalysis, METRIC_ORDER, ZERO_AS_MISSING } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${msg}\n    实际: ${a}\n    期望: ${e}`);
}

// ---------- 构造：只把「扣非」放在 fundamental.metrics（m），quote.fundamentals 里没有 ----------
// 复现生产端的双源陷阱：老代码读 f.deductedProfitGrowth → undefined → 整项不渲染。
const quote = {
  fundamentals: {
    pe: 9.08, pb: 1.27, ps: 3.52,
    roeTtm: 14.0, grossMarginTtm: 0, netMarginTtm: 38.8,   // grossMarginTtm=0 → 哨兵（券商/缺失）
    revenueYoy: 58.6, profitYoy: 83.8,
    debtToEquity: 0, debtMetricPct: true,                  // 哨兵
    currentRatio: 0,                                       // 哨兵
    dividendYield: 1.84,
    operatingCashFlowPerShare: 0,                          // 哨兵
    roeTtmPrev: 12.0,
    psSource: 'PS_TTM',
    // 「去年同期」同期对齐用（2026-06-30 vs 2025-06-30）：使 dedProfitGrowth 命中 prev 分支，
    // 从而覆盖「维度文案里的数字也必须是 2 位小数」这条断言（20260923n）。
    zyzbHistory: [
      { REPORT_DATE: '2026-06-30', KCFJCXSYJLRTZ: '84.92880198442' },
      { REPORT_DATE: '2025-06-30', KCFJCXSYJLRTZ: '123.277436528755' },
    ],
  },
};
const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = {
  metrics: {
    deductedProfitGrowth: 84.93,   // ← 唯一生产点（fundamentalScore.js:290）
    pe: 9.08, pb: 1.27, ps: 3.52,
    roe: 14.0, netMargin: 38.8,
    revenueGrowth: 58.6, profitGrowth: 83.8,
    dividendYield: 1.84,
  },
};

const out = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental);

// ---------- 1. 项数与顺序 ----------
ok(Array.isArray(out.metrics), 'out.metrics 应为数组');
eq(METRIC_ORDER.length, 14, 'METRIC_ORDER 长度应为 14');
eq(out.metrics.length, 14, '右卡输出项数应为 14');
eq(out.metrics.map(m => m.key), METRIC_ORDER, '右卡 key 顺序必须严格等于 METRIC_ORDER');
eq(out.order, METRIC_ORDER, 'out.order 应回显 METRIC_ORDER');

// ---------- 2. 扣非 / PEG 必然出现 ----------
ok(out.metrics.some(m => m.key === 'dedProfitGrowth'), '右卡必须包含「扣非净利润增长」(原为死代码，永不渲染)');
ok(out.metrics.some(m => m.key === 'peg'), '右卡必须包含 PEG（补上后与左卡一一对应）');

const ded = out.metrics.find(m => m.key === 'dedProfitGrowth');
eq(ded.label, '扣非净利润增长', '扣非标签应与左卡一字不差');
ok(/84\.93/.test(ded.valueText), `扣非应从 fundamental.metrics 取到 84.93 → 显示 84.93%（实际 ${ded.valueText}）`);

const peg = out.metrics.find(m => m.key === 'peg');
eq(peg.valueText, '--', 'PEG 无数据源 → 必须显示 --（不做估算）');
ok(peg.dims.yoy.available === false, 'PEG 同比维度应标「不可得」');

// ---------- 3. 哨兵 0 → `--`（与左卡 `m.x ? : '--'` 一致） ----------
const gm = out.metrics.find(m => m.key === 'grossMargin');
eq(gm.valueText, '--', '哨兵 0 的毛利率应显示 --（旧版显示 0.0%，与左卡 -- 自相矛盾）');
eq(gm.dims.yoy.available, false, '哨兵 0 的毛利率同比维度应标不可得');

for (const k of ['debt', 'currentRatio', 'ocf']) {
  const mm = out.metrics.find(x => x.key === k);
  eq(mm.valueText, '--', `哨兵 0 的 ${k} 应显示 --`);
}

// 真实值不得被误归零
const div = out.metrics.find(m => m.key === 'div');
eq(div.valueText, '1.84%', '真实股息率 1.84% 不得被误判为哨兵');
const roe = out.metrics.find(m => m.key === 'roe');
eq(roe.valueText, '14.00%', '真实 ROE 14.00% 应正常显示');

// ---------- 3.5 小数位统一（20260923n）：右卡百分比/倍数一律 2 位，与左卡逐项一致 ----------
for (const k of ['roe', 'grossMargin', 'netMargin', 'growth', 'profitGrowth', 'dedProfitGrowth', 'div']) {
  const mm = out.metrics.find(x => x.key === k);
  if (mm && mm.valueText !== '--') {
    ok(/^-?\d+\.\d{2}%$/.test(mm.valueText), `${k} 的 valueText 应为 2 位小数百分比，实际 ${mm.valueText}`);
  }
}
for (const k of ['pe', 'pb', 'ps']) {
  const mm = out.metrics.find(x => x.key === k);
  ok(/^-?\d+\.\d{2}$/.test(mm.valueText), `${k} 的 valueText 应为 2 位小数，实际 ${mm.valueText}`);
}
// 维度文案里的数字也必须是 2 位（否则卡头 84.93%、维度里 84.9%，同一卡片自相矛盾）
{
  const txt = ded.dims.yoy.text;
  ok(!/\d\.\d(?!\d)/.test(txt), `维度文案不应残留 1 位小数：${txt}`);
  ok(/123\.28/.test(txt), `维度文案去年同期应为 2 位（123.28%），实际：${txt}`);
}

// ---------- 4. 双源穿透：f 里是哨兵 0 时，应穿透到 m 取真实值 ----------
const q2 = { fundamentals: { roeTtm: 0, zyzbHistory: [], psSource: 'x' } };
const f2 = { metrics: { roe: 16.6, deductedProfitGrowth: 12.3, grossMargin: 22.2 } };
const out2 = buildMetricAnalysis(q2, comparison, companyType, signals, f2);
const roe2 = out2.metrics.find(m => m.key === 'roe');
eq(roe2.valueText, '16.60%', 'f.roeTtm=0（哨兵）应穿透到 m.roe=16.60');

// ---------- 5. 左卡 rows 与右卡：项数一致 + 顺序单调（= 两卡逐项对齐） ----------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const anchor = appSrc.indexOf('ocflowPeriod');
const start = appSrc.indexOf('const rows = [', anchor);
const end = appSrc.indexOf('\n    ];', start);
ok(start > 0 && end > start, `应能定位左卡 rows 数组（start=${start}, end=${end}）`);
const block = appSrc.slice(start, end);
const leftRowCount = (block.match(/\n\s*\[/g) || []).length;
eq(leftRowCount, 14, '左卡 rows 数组行数应为 14');

// 右卡 14 个 label 依次在左卡块中出现的位置必须严格递增 → 证明两卡同序
let lastPos = -1, monotonic = true, firstBad = '';
for (const m of out.metrics) {
  const pos = block.indexOf(`'${m.label}'`);
  if (pos < 0) { monotonic = false; firstBad = `左卡缺标签「${m.label}」`; break; }
  if (pos <= lastPos) { monotonic = false; firstBad = `标签「${m.label}」在左卡中的位置未递增`; break; }
  lastPos = pos;
}
ok(monotonic, `左右两卡标签顺序必须一致：${firstBad}`);

// ---------- 6. 加载即运行 ----------
console.log(`\n指标顺序 = ${out.metrics.map(m => m.key).join(', ')}`);
console.log(`项数 = ${out.metrics.length} | METRIC_ORDER = ${METRIC_ORDER.length} | 左卡 rows = ${leftRowCount}`);
out.metrics.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.label.padEnd(12)} = ${m.valueText}`));

if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}
