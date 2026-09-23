/**
 * scripts/test_left_card_prior_alignment.js — 「去年同期」口径一致性回归（20260923m）
 *
 * 用户投诉：长江证券（000783）「关键财务指标」（左卡）的「扣非净利润增长·去年同期」
 *           与「指标分析」（右卡）/「判定依据」的去年同期数不一样。
 *
 * 根因：左卡 `public/js/app.js` 的 `priorDedYoy` 取 `zyzb[zyzb.length - 2]` ——
 *       `zyzbHistory` 是**降序**多期序列，倒数第二项 ≈ 接近最早的一期，根本不是去年同期
 *       （同文件 20260909j 注释已把营收/归母改掉，唯独扣非漏改）。
 *       其余三处（lib/metricAnalysis.js `samePeriodPair`、lib/analysis.js `samePeriodYoY`、
 *       lib/fundamentalScore.js `yoyPair`）都做「去年同期·同报告期」对齐。
 *
 * 运行： node scripts/test_left_card_prior_alignment.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(msg); }
}

// ===== 真实序列（000783 长江证券，2026-09-23 实测，降序 9 期）=====
const ROWS = [
  { REPORT_DATE: '2026-06-30', KCFJCXSYJLRTZ: 84.92880198442 },
  { REPORT_DATE: '2026-03-31', KCFJCXSYJLRTZ: 51.966600687618 },
  { REPORT_DATE: '2025-12-31', KCFJCXSYJLRTZ: 108.694913404962 },
  { REPORT_DATE: '2025-09-30', KCFJCXSYJLRTZ: 142.037364781149 },
  { REPORT_DATE: '2025-06-30', KCFJCXSYJLRTZ: 123.277436528755 },
  { REPORT_DATE: '2025-03-31', KCFJCXSYJLRTZ: 150.359223884632 },
  { REPORT_DATE: '2024-12-31', KCFJCXSYJLRTZ: 20.41752129621 },
  { REPORT_DATE: '2024-09-30', KCFJCXSYJLRTZ: 21.060046502895 },
  { REPORT_DATE: '2024-06-30', KCFJCXSYJLRTZ: -27.372690077594 },
];

// ---------- 1. 静态守卫：左卡的 prior* 赋值语句不得再用「倒序序列尾部索引」当去年同期 ----------
// 注意：只检查**赋值语句本身**（而非整份文件），否则本文件/源码里解释该 bug 的注释会误命中。
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const appLines = appSrc.split('\n');
const priorAssign = appLines.filter(l => /const\s+(priorRevenueYoy|priorProfitYoy|priorDedYoy|priorRoeTxt)\s*=/.test(l));
ok(priorAssign.length === 4, `应找到 4 条 prior* 赋值语句，实际 ${priorAssign.length}`);
for (const l of priorAssign) {
  ok(!/zyzb\s*\[\s*zyzb\.length\s*-\s*2\s*\]/.test(l), `prior* 赋值不得用 zyzb[zyzb.length - 2]（那是接近最早的一期，不是去年同期）：${l.trim()}`);
}

// 扣非去年同期必须由 priorYoy（同期对齐对象）派生
const dedLine = (priorAssign.find(l => /priorDedYoy\s*=/.test(l)) || '').trim();
ok(/priorDedYoy\s*=\s*priorYoy\s*\?/.test(dedLine), `priorDedYoy 必须由 priorYoy（同期对齐）派生，实际：${dedLine}`);
ok(dedLine.includes('KCFJCXSYJLRTZ'), 'priorDedYoy 必须取 KCFJCXSYJLRTZ 字段');

// 营收/归母/扣非 三项去年同期必须同源（都取 priorYoy）
for (const [name, re] of [
  ['priorRevenueYoy', /priorRevenueYoy\s*=\s*priorYoy\s*&&/],
  ['priorProfitYoy', /priorProfitYoy\s*=\s*priorYoy\s*&&/],
  ['priorDedYoy', /priorDedYoy\s*=\s*priorYoy\s*\?/],
]) {
  ok(re.test(appSrc), `${name} 必须与其余两项同源（从 priorYoy 取数）`);
}

// ---------- 2. 新旧写法差异对照（证明旧写法确实是 bug） ----------
const parsePct = (v) => { const n = parseFloat(v); return (v == null || isNaN(n)) ? null : n; };
const latest = ROWS[0];
const ld = latest.REPORT_DATE;
const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
const prior = ROWS.find(x => x.REPORT_DATE === tgt) || null;
const correctPrior = prior ? parsePct(prior.KCFJCXSYJLRTZ) : null;   // 同期对齐（新写法）
const oldPrior = parsePct(ROWS[ROWS.length - 2].KCFJCXSYJLRTZ);       // 倒数第二期（旧写法）

ok(tgt === '2025-06-30', `去年同期目标应为 2025-06-30，实际 ${tgt}`);
ok(Math.abs(correctPrior - 123.277436528755) < 1e-6, `同期对齐去年同期应为 123.28%，实际 ${correctPrior}`);
ok(Math.abs(oldPrior - 21.060046502895) < 1e-6, `旧写法（length-2）应取到 2024-09-30 的 21.06%，实际 ${oldPrior}`);
ok(Math.abs(correctPrior - oldPrior) > 1, '新写法与旧写法结果必须显著不同（否则本用例失去意义）');

// ---------- 3. 右卡（真实代码）必须是同期对齐 —— 与左卡修复后同口径 ----------
const out = buildMetricAnalysis(
  { fundamentals: { zyzbHistory: ROWS } },
  { percentiles: {}, industryAvg: {} },
  { isFinancial: true },
  { signals: [] },
  { metrics: { deductedProfitGrowth: 84.92880198442 } },
);
const ded = (out.metrics || []).find(m => m.key === 'dedProfitGrowth');
ok(!!ded, '右卡必须包含 dedProfitGrowth（否则无法比对）');
const yoyText = (ded && ded.dims && ded.dims.yoy && ded.dims.yoy.text) || '';
ok(/123\.28/.test(yoyText), `右卡扣非去年同期应为 123.28%（同期对齐 + 2 位小数），实际文本：${yoyText}`);
ok(!/21\.1/.test(yoyText), `右卡扣非去年同期不得出现旧写法的 21.1%，实际文本：${yoyText}`);

// ---------- 输出 ----------
console.log(`\n最新期 ${ld} → 去年同期(同期对齐) = ${correctPrior}%（正确，2025-06-30）`);
console.log(`                旧写法(length-2) = ${oldPrior}%（错误，2024-09-30）`);
console.log(`右卡 yoy 文本 = ${yoyText}`);

if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}
