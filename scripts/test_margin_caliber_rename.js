/**
 * scripts/test_margin_caliber_rename.js — 20261104k~m 口径统一+改名+行内展开守卫
 *
 * 覆盖用户三项指令：
 *   ① 毛利率数据不一致修复——左卡 TTM 主值 vs 右卡同比/环比维度口径统一（TTM 同口径优先，回退累计并标注）
 *      同口径排查覆盖：毛利率、净利率、ROE（环比维度）；数据源 lib/stockData.js computeTtmMetrics
 *      新增 grossMarginTtmPrev / netMarginTtmPrev（去年同期 TTM）与 *PrevQ（上一报告期 TTM）、roeTtmPrevQ。
 *   ② 「利润增长」改名「归母净利润」——左卡 tile / METRIC_HELP / keyOf / analysis.js 信号 label /
 *      metricAnalysis buildGrowth / consistencyAudit / export.js 全链路改名；LAYOUT_VERSION 升级 20261104k。
 *   ③ 右卡「指标分析」与左卡 14 项全量一致展示——去按需单卡 ma-hidden 模式，tab 点击改滚动定位 + 高亮。
 *
 * 运行： node scripts/test_margin_caliber_rename.js
 * 断言全部通过时打印 "PASS N/N"，exit 0；任一失败打印 FAIL 明细并 exit 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { computeTtmMetrics } = require('../lib/stockData');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function approx(actual, expected, eps, msg) {
  ok(actual != null && Math.abs(actual - expected) <= (eps || 1e-6),
    `${msg}\n    实际: ${actual}\n    期望(±${eps || 1e-6}): ${expected}`);
}

// ---------- §1 computeTtmMetrics：TTM prev / prevQ 数值断言（独立复算） ----------
// 期数设计（rev=营收, mlr=毛利额, np=归母净利, gm/nm=比率%，bps=每股净资产）：
//   2025Q3: 300/120/30   2025H1: 200/80/20   2025Q1: 100/40/10
//   2024年报: 400/160/40  2024Q3: 280/112/28  2024H1: 190/76/19  2024Q1: 95/38/9.5
//   2023年报: 360/150/36  2023Q3: 270/(null mlr, gm 40%)/27  2023H1: 180/72/18
// 当前 TTM（2025-09-30 锚）: rev=300+400-280=420  mlr=120+160-112=168  np=30+40-28=42
// prev TTM（2024-09-30 锚）: rev=280+360-270=370  mlr=112+150-(0.40*270)=154  np=28+36-27=37
// prevQ TTM（2025-06-30 锚）: rev=200+400-190=410  mlr=80+160-76=164  np=20+40-19=41
// 2023Q3 的 mlr 置 null 且给 XSMLL=40 → 同时覆盖「MLR 缺失按比率×营收重构」回退分支。
const R = (date, name, np, rev, mlr, gm, nm, bps) => ({
  REPORT_DATE: date, REPORT_DATE_NAME: name,
  PARENTNETPROFIT: String(np), TOTALOPERATEREVE: String(rev),
  MLR: mlr == null ? null : String(mlr),
  XSMLL: gm == null ? null : String(gm), XSJLL: String(nm), BPS: String(bps),
});
const rows = [
  R('2025-09-30', '2025三季报', 30, 300, 120, 40, (30 / 300 * 100), 5.00),
  R('2025-06-30', '2025中报', 20, 200, 80, 40, (20 / 200 * 100), 4.80),
  R('2025-03-31', '2025一季报', 10, 100, 40, 40, 10, 4.60),
  R('2024-12-31', '2024年报', 40, 400, 160, 40, 10, 4.70),
  R('2024-09-30', '2024三季报', 28, 280, 112, 40, 10, 4.50),
  R('2024-06-30', '2024中报', 19, 190, 76, 40, 10, 4.40),
  R('2024-03-31', '2024一季报', 9.5, 95, 38, 40, 10, 4.30),
  R('2023-12-31', '2023年报', 36, 360, 150, (150 / 360 * 100), 10, 4.20),
  R('2023-09-30', '2023三季报', 27, 270, null, 40, 10, 4.10),
  R('2023-06-30', '2023中报', 18, 180, 72, 40, 10, 4.00),
];
const ttm = computeTtmMetrics(rows, 10);
ok(ttm != null, 'computeTtmMetrics 应返回结果');
approx(ttm.grossMargin, (120 + 160 - 112) / (300 + 400 - 280) * 100, 1e-6, '当前 TTM 毛利率');
approx(ttm.netMargin, (30 + 40 - 28) / (300 + 400 - 280) * 100, 1e-6, '当前 TTM 净利率');
approx(ttm.grossMarginTtmPrev, (112 + 150 - 108) / (280 + 360 - 270) * 100, 1e-6, '去年同期 TTM 毛利率（含 MLR 缺失重构回退）');
approx(ttm.netMarginTtmPrev, (28 + 36 - 27) / (280 + 360 - 270) * 100, 1e-6, '去年同期 TTM 净利率');
approx(ttm.grossMarginTtmPrevQ, (80 + 160 - 76) / (200 + 400 - 190) * 100, 1e-6, '上一报告期 TTM 毛利率');
approx(ttm.netMarginTtmPrevQ, (20 + 40 - 19) / (200 + 400 - 190) * 100, 1e-6, '上一报告期 TTM 净利率');
approx(ttm.roePrev, (28 + 36 - 27) / (4.50 * 10) * 100, 1e-6, '去年同期 TTM ROE（既有字段回归）');
approx(ttm.roeTtmPrevQ, (20 + 40 - 19) / (4.80 * 10) * 100, 1e-6, '上一报告期 TTM ROE（20261104k 新增）');
// 锚点为年报（直取分支）时 prevQ 窗口 = 上一年报直取
const rowsYr = rows.filter(r => r.REPORT_DATE !== '2025-09-30' && r.REPORT_DATE !== '2025-06-30' && r.REPORT_DATE !== '2025-03-31');
const ttmYr = computeTtmMetrics(rowsYr, 10);
approx(ttmYr.grossMargin, 40, 1e-6, '年报直取分支毛利率（回归）');
// prevQ 锚点 = 最近一个更早披露期（2024-09-30 三季报，非年报）：窗口 = 2024Q3+2023年报−2023Q3
approx(ttmYr.grossMarginTtmPrevQ, (112 + 150 - 108) / (280 + 360 - 270) * 100, 1e-6, '年报直取时 prevQ = 上一披露期（2024Q3）TTM 毛利率');

// ---------- §2 buildMetricAnalysis 端到端：右卡同比/环比 TTM 同口径 ----------
function mkQuote(f) {
  return { fundamentals: Object.assign({
    pe: 20, pb: 2, ps: 5,
    roeTtm: 14.0, grossMarginTtm: 37.78, netMarginTtm: 22.5,
    revenueYoy: 10, profitYoy: 8,
    dividendYield: 2,
    roeTtmPrev: 12.0,
    zyzbHistory: [
      { REPORT_DATE: '2025-09-30', XSMLL: '41.47', XSJLL: '20.1', ROEJQ: '13.0' },
      { REPORT_DATE: '2024-09-30', XSMLL: '43.89', XSJLL: '21.0', ROEJQ: '12.5' },
    ],
  }, f) };
}
const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = { metrics: { pe: 20, pb: 2, ps: 5, roe: 14, grossMargin: 37.78, netMargin: 22.5, revenueGrowth: 10, profitGrowth: 8, dividendYield: 2 } };

// 2a. 有 TTM prev → 同比/环比均为 TTM 同口径文案
const outA = buildMetricAnalysis(mkQuote({
  grossMarginTtmPrev: 43.89, grossMarginTtmPrevQ: 37.0,
  netMarginTtmPrev: 24.0, netMarginTtmPrevQ: 21.5,
  roeTtmPrevQ: 13.2,
}), comparison, companyType, signals, fundamental);
const gmA = outA.metrics.find(m => m.key === 'grossMargin');
ok(gmA && /去年同期TTM 43\.89%/.test(gmA.dims.yoy.text), `毛利率同比应含「去年同期TTM 43.89%」（实际 ${gmA && gmA.dims.yoy.text}）`);
ok(gmA && /TTM 同口径/.test(gmA.dims.yoy.text), '毛利率同比应标注「TTM 同口径」');
ok(gmA && /TTM 同口径/.test(gmA.dims.qoq.text), `毛利率环比应为 TTM 同口径文案（实际 ${gmA && gmA.dims.qoq.text}）`);
ok(gmA && /37\.78% vs 上一报告期TTM 37\.00%/.test(gmA.dims.qoq.text), '毛利率环比应含主值与上一报告期 TTM 对比值');
ok(gmA && /TTM 滚动口径.*与左卡数值完全一致/.test(gmA.note), '毛利率 note 应改为「与左卡数值完全一致」口径说明');
const nmA = outA.metrics.find(m => m.key === 'netMargin');
ok(nmA && /TTM 同口径/.test(nmA.dims.yoy.text) && /TTM 同口径/.test(nmA.dims.qoq.text), '净利率同比/环比应均为 TTM 同口径');
const roeA = outA.metrics.find(m => m.key === 'roe');
ok(roeA && /TTM 同口径/.test(roeA.dims.qoq.text), `ROE 环比应为 TTM 同口径（20261104k 同口径排查）（实际 ${roeA && roeA.dims.qoq.text}）`);

// 2b. 无 TTM prev → 回退累计口径（原 yoyDim/qoqDim 文案，不含 TTM 标注）
const outB = buildMetricAnalysis(mkQuote({}), comparison, companyType, signals, fundamental);
const gmB = outB.metrics.find(m => m.key === 'grossMargin');
ok(gmB && !/TTM 同口径/.test(gmB.dims.yoy.text), `缺 TTM prev 时毛利率同比应回退累计口径（实际 ${gmB && gmB.dims.yoy.text}）`);
ok(gmB && /41\.47/.test(gmB.dims.yoy.text), '回退文案应使用累计口径值 41.47');
const roeB = outB.metrics.find(m => m.key === 'roe');
ok(roeB && !/TTM 同口径/.test(roeB.dims.qoq.text), '缺 roeTtmPrevQ 时 ROE 环比应回退累计口径');

// 2c. 哨兵 0 不作 TTM prev 使用（grossMarginTtmPrev=0 → 视为缺失回退）
const outC = buildMetricAnalysis(mkQuote({ grossMarginTtmPrev: 0 }), comparison, companyType, signals, fundamental);
const gmC = outC.metrics.find(m => m.key === 'grossMargin');
ok(gmC && !/TTM 同口径/.test(gmC.dims.yoy.text), 'grossMarginTtmPrev=0（哨兵）应回退累计口径，不得输出假同口径');

// 2d. 改名联动：右卡 profitGrowth 标签应为「归母净利润」
const pgA = outA.metrics.find(m => m.key === 'profitGrowth');
ok(pgA && pgA.label === '归母净利润', `profitGrowth 右卡标签应为「归母净利润」（实际 ${pgA && pgA.label}）`);

// ---------- §3 改名全链路源码断言 ----------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const analysisSrc = read('lib/analysis.js');
const metricSrc = read('lib/metricAnalysis.js');
const appSrc = read('public/js/app.js');
const auditSrc = read('lib/consistencyAudit.js');
const exportSrc = read('public/js/export.js');
const sjdSrc = read('lib/sameDayJudgment.js');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

ok(!analysisSrc.includes("label: '利润增长'"), 'analysis.js 不得再出现 label: 利润增长');
ok((analysisSrc.match(/label: '归母净利润'/g) || []).length >= 7, 'analysis.js 归母净利润 label 应≥7 处（原 7 处信号）');
ok(!metricSrc.includes("'利润增长'"), 'metricAnalysis.js 不得再出现 利润增长 字面量');
ok(/buildGrowth\('profitGrowth', '归母净利润'/.test(metricSrc), 'metricAnalysis buildGrowth 标签应为 归母净利润');
ok(!appSrc.includes("['利润增长'"), 'app.js 左卡 tile 不得再出现 利润增长');
ok(appSrc.includes("['归母净利润', m.profitGrowth"), 'app.js 左卡 tile 应为 归母净利润');
ok(/'归母净利润':\s*'profitGrowth'/.test(appSrc), 'app.js keyOf 应含 归母净利润→profitGrowth');
ok(/'归母净利润':\s*\{\s*title:\s*'归母净利润'/.test(appSrc), 'app.js METRIC_HELP 应含 归母净利润 释义');
ok(!appSrc.includes("'利润增长':"), 'app.js keyOf/METRIC_HELP 不得残留 利润增长 键');
ok(auditSrc.includes("label: '归母净利润'"), 'consistencyAudit.js label 应为 归母净利润');
ok(exportSrc.includes("['归母净利润', fmtPct(m.profitGrowth)]"), 'export.js 导出表头应为 归母净利润');

// ---------- §4 LAYOUT_VERSION（20261104k 改名升版；l 轮展示回退不涉及因子名，不再升版） ----------
ok(/const LAYOUT_VERSION = '20261106o'/.test(sjdSrc), 'LAYOUT_VERSION 应为 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，哈希不捕获）');
ok(/\[20261028c 前注\]/.test(sjdSrc), '历史前注 20261028c 应保留为前注');

// ---------- §5 指标分析行内展开（20261104m：用户澄清第二轮——分析内容与所点指标行同一水平） ----------
const rmaStart = appSrc.indexOf('renderMetricAnalysis(data, activeKey) {');
const smaStart = appSrc.indexOf('showMetricAnalysis(key, rowEl) {');
const smaEnd = appSrc.indexOf('showMetricHelp(', smaStart);
ok(rmaStart > 0 && smaStart > rmaStart, 'app.js 应含 renderMetricAnalysis(data, activeKey) / showMetricAnalysis(key, rowEl) 且顺序正确');
const rmaBody = appSrc.slice(rmaStart, smaStart);
const smaBody = smaEnd > smaStart ? appSrc.slice(smaStart, smaEnd) : appSrc.slice(smaStart);
ok(/this\.renderMetricAnalysisCard\(m\)/.test(rmaBody), 'renderMetricAnalysis 应复用 renderMetricAnalysisCard（单一数据源）');
ok(appSrc.indexOf('renderMetricAnalysisCard(m) {') > 0, 'app.js 应有 renderMetricAnalysisCard 单卡生成器');
ok(/class="ma-row\$\{isActive \? '' : ' ma-hidden'\}"/.test(rmaBody), '右卡仍为按需单卡（非激活项 ma-hidden）');
ok(rmaBody.includes('ma-empty'), 'renderMetricAnalysis 应保留 ma-empty 空态引导');
ok(smaBody.includes("'ma-inline-panel'"), 'showMetricAnalysis 应创建行内展开面板（手风琴）');
ok(smaBody.includes('cloneNode(true)'), '行内面板应克隆右卡单卡节点（同一 HTML 结构）');
ok(smaBody.includes("insertAdjacentElement('afterend'"), '面板应插入选中指标行正下方（afterend）');
ok(smaBody.includes("block: 'nearest'"), '行内面板滚动应为 block:nearest（紧邻点击行，不回弹）');
ok(!smaBody.includes("block: 'center'"), 'showMetricAnalysis 不得再把页面滚动到上方右卡（l 版回弹根除）');
ok(smaBody.includes("querySelectorAll('.ma-inline-panel')"), '展开新面板前应移除旧面板（同时只展开一项）');
ok(smaBody.includes("classList.toggle('ma-hidden', !isTarget)"), '右卡单卡切换逻辑保留');
ok(appSrc.includes("this.showMetricAnalysis(next, next ? btn.closest('.metric-row') : null)"), 'tab 点击应传指标行锚点');
ok(appSrc.includes("kEl.closest('.metric-row')"), '重渲染后应按 activeMetricKey 恢复行内展开');
ok(/20261104m/.test(appSrc.slice(rmaStart - 500, smaEnd)), '指标分析相关函数应带 20261104m 注释标记（功能引入版本不随全局升版）');

// ---------- §6 版本戳 ----------
ok(/const APP_VERSION = '20261106p'/.test(serverSrc), 'server.js APP_VERSION 应为 20261106p');
ok(/\[20261104k\]/.test(serverSrc), 'server.js 应有 [20261104k] 独立注释条目（本功能引入版本，历史条目不随全局版本升级）');
ok(/\[20261104m\]/.test(serverSrc), 'server.js 应有 [20261104m] 行内展开条目（功能引入版本，历史条目不随全局升版）');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public/css/style.css'), 'utf8');
ok(cssSrc.includes('.ma-inline-panel'), 'style.css 应有行内展开面板样式（.ma-inline-panel）');
ok(cssSrc.includes('.ma-inline-panel.ma-flash'), '行内面板应复用 ma-flash 高亮动画');

// ---------- 汇总 ----------
console.log(`\n共 ${pass + fail} 断言：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  process.exit(1);
}
console.log('PASS');
