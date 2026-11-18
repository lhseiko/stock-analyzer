/**
 * scripts/test_fundamental_conclusion.js — 20261117c 任务卡 #020 守卫
 *
 * 覆盖：
 *   1. 卡片顺序：index.html 中 #fundConclusion 在基本面评分明细卡片之前
 *   2. 结论生成确定性（同输入逐字一致）、评级代号保留、大白话直白
 *   3. 评分明细 4 项默认展开，分数与 fund.scores 逐项同源，分档文案正确
 *   4. 关键财务指标固定 6 条，数值复用左卡 rows，解读复用现有判定信号
 *   5. 缺数据如实降级，不编造
 *   6. 原「查看论证过程」推导链保留
 *   7. 接线：调用处传 data/rows；CSS 内部布局类存在
 *
 * 运行： node scripts/test_fundamental_conclusion.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n    实际: ${JSON.stringify(a)}\n    期望: ${JSON.stringify(b)}`); }

// ── A. 从 app.js 提取 buildFundamentalConclusion 纯逻辑执行（不开浏览器）──
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const startMark = 'buildFundamentalConclusion(fund, data, rows) {';
const start = appSrc.indexOf(startMark);
const end = appSrc.indexOf('// ---- Tab switching ----', start);
ok(start > 0 && end > start, '应能定位 buildFundamentalConclusion 函数体');
let fnSrc = appSrc.slice(start, end).trim();
if (fnSrc.endsWith(',')) fnSrc = fnSrc.slice(0, -1);
const build = new Function('return ({ ' + fnSrc + ' }).buildFundamentalConclusion')();

const fund = {
  overall: '较弱', rating: 'C', score: 48, companyTypeName: '均衡型',
  scores: {
    valuation:     { label: '估值',     score: 11, max: 25 },
    profitability: { label: '盈利能力', score: 18, max: 25 },
    growth:        { label: '成长性',   score: 0,  max: 25 },
    health:        { label: '财务健康', score: 19, max: 25 },
  },
  dimensionLogic: {
    valuation: { rule: 'PE 高于行业均值，落入低分档' },
    growth:    { rule: '营收/归母净利增速≤0，无加分' },
  },
};
const data = {
  metricAnalysis: { metrics: [
    { key: 'pe', judgment: { signal: 'bull' } },
    { key: 'pb', judgment: { signal: 'neutral' } },
    { key: 'roe', judgment: { signal: 'bull' } },
    { key: 'growth', judgment: { signal: 'bull' } },
    { key: 'profitGrowth', judgment: { signal: 'bull' } },
    { key: 'debt', judgment: { signal: null } },
  ] },
  signals: { signals: [] },
};
const rows = [
  ['市盈率(PE·TTM)', '9.08', 'PE'],
  ['市净率(PB)', '1.27', 'PB'],
  ['ROE', '14.00%', 'ROE'],
  ['营收增长', '58.60%', '营收'],
  ['归母净利润', '83.80%', '净利'],
  ['资产负债率', '--', '负债'],
  ['商誉', '0.71亿', '商誉'],
];

const out = build(fund, data, rows);
ok(out != null, '应返回结论对象');
ok(JSON.stringify(out) === JSON.stringify(build(fund, data, rows)), '确定性：同输入两次输出逐字一致');

// ① 结论：保留评级代号 + 白话
ok(/均衡型综合评级「较弱」\(C，48\/100\)/.test(out.conclusion), '保留「较弱」(C) 评级代号与总分（关键问题 3A）');
ok(/说白了/.test(out.conclusion) && /财务健康/.test(out.conclusion) && /成长性/.test(out.conclusion),
  `结论应含大白话且点出最强/最弱维度（实际：${out.conclusion}）`);
ok(!/最强维度|最弱维度/.test(out.conclusion), '不再使用「最强维度/最弱维度」书面语');

// ② 评分明细：默认返回、四项同源、分档文案
eq(out.scoreRows.length, 4, '评分明细应固定 4 项（默认展开数据已生成）');
eq(out.scoreRows.map(r => [r.label, r.score, r.max]), [
  ['估值', 11, 25], ['盈利能力', 18, 25], ['成长性', 0, 25], ['财务健康', 19, 25],
], '评分明细数值与 fund.scores 逐项同源');
eq(out.scoreRows[0].word, '估值偏贵', '估值 11/25=44% → 低档 → 估值偏贵');
eq(out.scoreRows[0].tone, 'bear', '低档 tone=bear（绿=差）');
eq(out.scoreRows[1].word, '赚钱能力强', '盈利能力 18/25=72% → 高档');
eq(out.scoreRows[1].tone, 'bull', '高档 tone=bull（红=好）');
eq(out.scoreRows[2].word, '成长乏力', '成长性 0/25 → 低档');
eq(out.scoreRows[3].word, '财务稳健', '财务健康 19/25=76% → 高档');

// ③ 关键财务指标：6 条、数值同源、解读复用信号
eq(out.metricRows.length, 6, '关键财务指标固定 6 条（关键问题 1A）');
eq(out.metricRows.map(r => r.key), ['pe', 'pb', 'roe', 'growth', 'profitGrowth', 'debt'], '6 条顺序固定');
eq(out.metricRows.map(r => r.value), ['9.08', '1.27', '14.00%', '58.60%', '83.80%', '--'],
  '指标数值直接复用左卡 rows，缺值保持 --');
eq(out.metricRows[0].word, '估值不贵', 'PE bull → 估值不贵');
eq(out.metricRows[1].word, '股价与净资产比例正常', 'PB neutral → 中性解读');
eq(out.metricRows[2].word, '赚钱效率不错', 'ROE bull → 赚钱效率不错');
eq(out.metricRows[3].word, '营收扩张快', '营收增长 bull → 营收扩张快');
eq(out.metricRows[4].word, '利润增长明显', '归母净利 bull → 利润增长明显');
eq(out.metricRows[5].word, '数据不足，无法解读', '资产负债率缺值 → 如实不可得，不编造');
ok(/市盈率/.test(out.metricRows[0].label) && /PE/.test(out.metricRows[0].label),
  '指标标签沿用左卡原始标签（含 PE 标注）');

// ④ 大白话收尾
ok(/^一句话：/.test(out.plain) && /成长性/.test(out.plain) && /一般|偏弱|不错/.test(out.plain),
  `大白话收尾应点出短板与整体水平（实际：${out.plain}）`);

// ⑤ 缺数据降级
const fundNoScores = Object.assign({}, fund, { scores: {} });
const outEmpty = build(fundNoScores, {}, []);
eq(outEmpty.metricRows.length, 6, 'rows 为空时仍输出 6 条骨架');
ok(outEmpty.metricRows.every(r => r.value === '--' && r.word === '数据不足，无法解读' && r.tone === 'na'),
  'rows 为空时全部指标如实不可得，不编数值');
eq(outEmpty.scoreRows.length, 0, 'scores 缺失时评分明细为空（不编造分数）');
ok(/数据不完整/.test(outEmpty.plain), '数据不完整时白话收尾如实说明');

// ⑥ 原论证过程保留
ok(Array.isArray(out.reasoning) && out.reasoning.length === 4, '原「查看论证过程」4 条推导保留');
ok(out.reasoning.some(r => /PE 高于行业均值，落入低分档/.test(r)), 'dimensionLogic.rule 原文保留在论证区');
ok(out.reasoning.some(r => /营收\/归母净利增速≤0，无加分/.test(r)), '成长性推导原文保留');

// ── B. 接线与样式静态守卫 ──
const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const pConc = idx.indexOf('id="fundConclusion"');
const pBreak = idx.indexOf('id="fundScoreBreakdown"');
ok(pConc > 0 && pBreak > pConc, 'index.html：结论卡片必须位于评分明细卡片上方');
ok(/buildFundamentalConclusion\(fundamental, data, rows\)/.test(appSrc),
  '调用处必须传入 data 与 rows（数字单一权威来源）');
ok(/fc-score-grid/.test(appSrc) && /fc-metric-grid/.test(appSrc) && /fc-plain/.test(appSrc),
  '渲染必须输出评分明细、指标概况、白话收尾三块');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
ok(/\.fc-score-grid\s*,\s*\.fc-metric-grid/.test(css) && /\.fc-plain\s*\{/.test(css),
  'style.css 必须含结论卡内部布局类');
ok(/\.fc-score-word\.bull, \.fc-metric-word\.bull \{ color: var\(--red\)/.test(css)
  && /\.fc-score-word\.bear, \.fc-metric-word\.bear \{ color: var\(--green\)/.test(css),
  '方向着色必须是红=好、绿=差（中国习惯）');

console.log(`\n结论样例：${out.conclusion}`);
console.log(`评分明细：${out.scoreRows.map(r => r.label + ' ' + r.score + '/' + r.max + ' ' + r.word).join(' | ')}`);
console.log(`关键指标：${out.metricRows.map(r => r.label + ' ' + r.value + ' ' + r.word).join(' | ')}`);
console.log(`白话收尾：${out.plain}`);

if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}
