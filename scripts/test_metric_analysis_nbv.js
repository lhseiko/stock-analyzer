/**
 * scripts/test_metric_analysis_nbv.js — 20261029a「营运利润 + NBV(新业务价值)」回归
 *
 * 覆盖：
 *   A. lib/insuranceAnalysis.latestNbvSnapshot（备查库真实数据 + 前缀剥离 + 非保险/无数据 null）
 *   B. lib/metricAnalysis.buildMetricAnalysis 两个新 builder（渲染位置/数值/判定符号/note 口径说明）
 *   C. lib/deep/financials.fetchOpProfitSnippet（axios mock：companyType 回退、负基数同比、缺科目降级）
 *   D. 左卡对齐（app.js 条件插入块 / keyOf / METRIC_HELP 源码级断言）
 *
 * 运行： node scripts/test_metric_analysis_nbv.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

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

// ═══════════ A. latestNbvSnapshot（真实备查库，无网络） ═══════════
const { latestNbvSnapshot, isInsuranceCompany } = require('../lib/insuranceAnalysis');

const snap = latestNbvSnapshot('601318');
ok(snap != null, '601318 应能取到 NBV 快照（备查库有数据）');
eq(snap.valueYi, 248.5, '601318 最新 NBV 应为 2026H1 248.5 亿');
eq(snap.period, '2026H1', '最新报告期应为 2026H1');
eq(snap.periodText, '2026年中报', 'periodText 应为「2026年中报」');
eq(snap.prevValueYi, 223.4, '去年同期同阶段应为 2025H1 223.4 亿');
eq(snap.prevLabel, '2025H1', '去年同期 label 应为 2025H1');
// (248.5-223.4)/223.4*100 = 11.2354... → 11.24
eq(snap.yoyPct, 11.24, 'NBV 同比应为 +11.24%');
ok(typeof snap.source === 'string' && snap.source.length > 0, '应带来源标注');

// 前缀剥离
const snapPfx = latestNbvSnapshot('SH601318');
ok(snapPfx != null && snapPfx.valueYi === 248.5, '带 SH 前缀的 601318 应命中同一快照');

// 非保险股 / 保险但无备查库数据 → null（绝不把平安数据泄漏到其它公司）
eq(latestNbvSnapshot('000902'), null, '非保险股 000902 应返回 null');
eq(latestNbvSnapshot('601628'), null, '保险股 601628 但备查库无 NBV 数据 → null（诚实不可得）');
eq(latestNbvSnapshot(''), null, '空代码应返回 null');

// 交叉：isInsuranceCompany 应认 601318（供 server.js 门控用）
ok(isInsuranceCompany('601318', '中国平安', null) === true, 'isInsuranceCompany(601318) 应为 true');

// ═══════════ B. buildMetricAnalysis 两个新 builder ═══════════
const { buildMetricAnalysis, METRIC_ORDER } = require('../lib/metricAnalysis');

// METRIC_ORDER：16 项，opProfit 在 dedProfitGrowth 之后、nbv 在其后、debt 之前
eq(METRIC_ORDER.length, 16, 'METRIC_ORDER 应为 16 项');
const iOp = METRIC_ORDER.indexOf('opProfit'), iNbv = METRIC_ORDER.indexOf('nbv'), iDed = METRIC_ORDER.indexOf('dedProfitGrowth'), iDebt = METRIC_ORDER.indexOf('debt');
ok(iDed < iOp && iOp < iNbv && iNbv < iDebt, `顺序应为 …dedProfitGrowth → opProfit → nbv → debt…（实际 ${iDed},${iOp},${iNbv},${iDebt}）`);

const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = { metrics: { pe: 8, pb: 1, roe: 12, deductedProfitGrowth: 10 } };
const quote = { fundamentals: { pe: 8, pb: 1, roeTtm: 12, zyzbHistory: [] } };

// B1. 两项齐全：位置/标签/数值/同比/判定/note
const opData = {
  cur: { date: '2026-06-30', opProfitYi: 234.56 },
  prev: { date: '2025-06-30', opProfitYi: 200.00 },
  yoyPct: 17.28,
};
const nbvData = {
  symbol: '601318', valueYi: 248.5, period: '2026H1', label: '2026H1', periodText: '2026年中报',
  yoyPct: 11.24, prevValueYi: 223.4, prevLabel: '2025H1',
  source: '妙想金融数据 + 中国平安年报',
  assumptionNote: '长期投资回报率假设由 5% 调低到 4%，历史口径不可直接对比。',
};
const outFull = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, opData, nbvData);
const keysFull = outFull.metrics.map(m => m.key);
ok(keysFull.includes('opProfit') && keysFull.includes('nbv'), '两项齐全时应渲染 opProfit 与 nbv');
ok(keysFull.indexOf('opProfit') < keysFull.indexOf('debt') && keysFull.indexOf('nbv') < keysFull.indexOf('debt'),
  '两个新指标应排在 debt 之前（与左卡阅读顺序一致）');

const opM = outFull.metrics.find(m => m.key === 'opProfit');
eq(opM.label, '营运利润', 'opProfit 标签应为「营运利润」');
eq(opM.valueText, '234.56亿', '营运利润数值应为 234.56亿');
// 20261029i 格式统一（图二三段式）：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）；同比%移入边际维度
ok(opM.dims.yoy.available && /本报告期 234\.56亿/.test(opM.dims.yoy.text) && /去年同期 200\.00亿/.test(opM.dims.yoy.text) && /边际 \+34\.56亿/.test(opM.dims.yoy.text),
  `营运利润同比维度应为图二三段式（实际：${opM.dims.yoy.text}）`);
ok(/17\.28/.test(opM.dims.marginal.text), `营运利润边际维度应含同比 +17.28%（实际：${opM.dims.marginal.text}）`);
eq(opM.judgment.signal, 'bull', '同比 +17.28% → 判定 bull');
ok(/扣非/.test(opM.note) && /所得税/.test(opM.note) && /非经常/.test(opM.note),
  '营运利润 note 必须说明与扣非净利润的区别（所得税/非经常性损益）');
ok(/不采用/.test(opM.note), 'note 应声明平安财报非通用口径「营运利润」不采用');

const nbvM = outFull.metrics.find(m => m.key === 'nbv');
eq(nbvM.label, 'NBV(新业务价值)', 'nbv 标签应为「NBV(新业务价值)」');
eq(nbvM.valueText, '248.50亿', 'NBV 数值应为 248.50亿');
eq(nbvM.judgment.signal, 'bull', 'NBV 同比 +11.24% → 判定 bull');
// 20261029i 格式统一：本报告期 248.50亿（去年同期 223.40亿，边际 +25.10亿）；同比%移入边际维度
ok(nbvM.dims.yoy.available && /本报告期 248\.50亿/.test(nbvM.dims.yoy.text) && /去年同期 223\.40亿/.test(nbvM.dims.yoy.text) && /边际 \+25\.10亿/.test(nbvM.dims.yoy.text),
  `NBV 同比维度应为图二三段式（实际：${nbvM.dims.yoy.text}）`);
ok(/11\.24/.test(nbvM.dims.marginal.text), `NBV 边际维度应含同比 +11.24%（实际：${nbvM.dims.marginal.text}）`);
ok(/新业务价值/.test(nbvM.note) && /保险/.test(nbvM.note), 'NBV note 必须解释 NBV 概念与保险专属属性');
ok(/假设/.test(nbvM.note), 'NBV note 应含精算假设调整提醒（assumptionNote 透传）');

// B2. 判定符号三态（确定性代码，非 LLM）
const mkOut = (yoyPct) => buildMetricAnalysis(
  quote, comparison, companyType, signals, fundamental,
  { cur: { date: '2026-06-30', opProfitYi: 100 }, prev: { date: '2025-06-30', opProfitYi: 100 }, yoyPct },
  null
).metrics.find(m => m.key === 'opProfit');
eq(mkOut(-5).judgment.signal, 'bear', '同比 -5% → bear');
eq(mkOut(0.3).judgment.signal, 'neutral', '同比 +0.3%（近零）→ neutral');

// B3. 缺同比基数：prev 为负 → yoy 不可得，判定 neutral（不编方向）
const outNeg = buildMetricAnalysis(
  quote, comparison, companyType, signals, fundamental,
  { cur: { date: '2026-06-30', opProfitYi: 50 }, prev: { date: '2025-06-30', opProfitYi: -20 }, yoyPct: null },
  null
);
const opNeg = outNeg.metrics.find(m => m.key === 'opProfit');
ok(opNeg.valueText === '50.00亿', '亏损基数下当期值仍应正常显示（负值有效）');
eq(opNeg.judgment.signal, 'neutral', '缺同比基数 → 判定 neutral（不编造方向）');
eq(opNeg.dims.yoy.available, false, '缺同比基数 → yoy 维度如实标不可得');

// B4. opProfit / insuranceNBV 为 null → 整行不渲染（左右两卡一致）
const outNone = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, null, null);
ok(!outNone.metrics.some(m => m.key === 'opProfit' || m.key === 'nbv'), '两入参均 null → 两行均不渲染');

// B5. 非保险股：只给 opProfit、不给 NBV（server 门控后典型场景）
const outOpOnly = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, opData, null);
ok(outOpOnly.metrics.some(m => m.key === 'opProfit') && !outOpOnly.metrics.some(m => m.key === 'nbv'),
  '000902 场景：有营运利润、无 NBV 行');

// ═══════════ C. fetchOpProfitSnippet（axios mock，不联网） ═══════════
const axios = require('axios');
const realGet = axios.get;
const LRB_ROWS = [
  { REPORT_DATE: '2025-06-30 00:00:00', REPORT_DATE_NAME: '2025中报', OPERATE_PROFIT: 20000000000 },
  { REPORT_DATE: '2026-06-30 00:00:00', REPORT_DATE_NAME: '2026中报', OPERATE_PROFIT: 23456000000 },
];
// mock：companyType=4 返回空（触发回退），companyType=3 返回真实数据（模拟保险股回退链命中）
axios.get = async (url) => {
  if (/lrbAjaxNew/.test(String(url))) {
    const ct = /companyType=(\d)/.exec(String(url))[1];
    if (ct === '3') return { data: { data: JSON.parse(JSON.stringify(LRB_ROWS)) } };
    return { data: { data: [] } };
  }
  throw new Error('unexpected url: ' + url);
};

const { fetchOpProfitSnippet } = require('../lib/deep/financials');

(async () => {
  const snip = await fetchOpProfitSnippet('SH601318', ['2026-06-30', '2025-06-30']);
  ok(snip != null, 'fetchOpProfitSnippet 应取到两期数据（含 companyType 4→3 回退）');
  eq(snip.cur.opProfitYi, 234.56, '当期营业利润应为 234.56 亿（元→亿换算）');
  eq(snip.prev.opProfitYi, 200.00, '去年同期应为 200.00 亿');
  eq(snip.cur.date, '2026-06-30', '当期日期应为 2026-06-30');
  // (234.56-200)/200*100 = 17.28
  eq(snip.yoyPct, 17.28, '营业利润同比应为 +17.28%');

  // 负基数：|prev| 同比（代码权威，避免符号翻转）
  axios.get = async (url) => ({ data: { data: [
    { REPORT_DATE: '2025-06-30 00:00:00', OPERATE_PROFIT: -20000000000 },
    { REPORT_DATE: '2026-06-30 00:00:00', OPERATE_PROFIT: 10000000000 },
  ] } });
  const snipNeg = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipNeg.yoyPct, 150, '负基数同比应用 |prev|：(100-(-200))/200 = 150%');

  // 缺当期 → null（整行不渲染，绝不编造）
  axios.get = async () => ({ data: { data: [LRB_ROWS[0]] } });
  const snipMiss = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipMiss, null, '当期报告期缺数据 → 返回 null');

  // 全空 → null
  axios.get = async () => ({ data: { data: [] } });
  const snipEmpty = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipEmpty, null, '利润表全空 → 返回 null');

  axios.get = realGet;

  // ═══════════ D. 左卡对齐（app.js 源码级断言） ═══════════
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

  // D1. rows 字面量仍为 14 行（新两行经 splice 条件插入，不破坏既有顺序断言）
  const anchor = appSrc.indexOf('ocflowPeriod');
  const start = appSrc.indexOf('const rows = [', anchor);
  const end = appSrc.indexOf('\n    ];', start);
  ok(start > 0 && end > start, '应能定位左卡 rows 数组字面量');
  const literalBlock = appSrc.slice(start, end);
  const literalRowCount = (literalBlock.match(/\n\s*\[/g) || []).length;
  eq(literalRowCount, 14, 'rows 字面量应仍为 14 行（营运利润/NBV 由 splice 插入）');

  // D2. 条件插入块：在 rows 字面量之后、含两行、插在「扣非净利润增长」之后
  const insBlock = appSrc.slice(end, appSrc.indexOf('const periodNote', end));
  ok(insBlock.indexOf('20261029a') >= 0, '应有 20261029a 注释标记');
  ok(insBlock.indexOf("'营运利润'") >= 0, '插入块应含「营运利润」行');
  ok(insBlock.indexOf("'NBV(新业务价值)'") >= 0, '插入块应含「NBV(新业务价值)」行');
  ok(insBlock.indexOf("_dedIdx + 1") >= 0, '应插在「扣非净利润增长」之后（_dedIdx + 1）');
  ok(insBlock.indexOf('data.opProfit') >= 0 && insBlock.indexOf('data.insuranceNBV') >= 0,
    '插入块应从 /api/analysis 的 opProfit / insuranceNBV 取数');

  // D3. keyOf 映射
  ok(/'营运利润':\s*'opProfit'/.test(appSrc), 'keyOf 应含 营运利润→opProfit');
  ok(/'NBV\(新业务价值\)':\s*'nbv'/.test(appSrc), 'keyOf 应含 NBV(新业务价值)→nbv');

  // D4. METRIC_HELP 两条释义
  ok(/'营运利润':\s*\{ title:/.test(appSrc), 'METRIC_HELP 应含「营运利润」释义');
  ok(/'NBV\(新业务价值\)':\s*\{ title:/.test(appSrc), 'METRIC_HELP 应含「NBV(新业务价值)」释义');

  // D5. 右卡 note 渲染
  ok(appSrc.indexOf('ma-metric-note') > appSrc.indexOf('renderMetricAnalysis(data, activeKey)'),
    'renderMetricAnalysis 应支持 note 渲染（.ma-metric-note）');
  ok(/m\.note \? `<div class="ma-metric-note">/.test(appSrc), 'note 渲染应使用 .ma-metric-note 类');

  // D6. 右卡输出顺序与左卡（含插入块）单调一致——用「逻辑顺序」断言：
  // 左卡逻辑顺序 = 字面量 14 行 + 扣非后插两行；右卡 = METRIC_ORDER。两者应同序。
  const leftLogical = [
    '市盈率(PE·TTM)', '市净率(PB)', 'PEG', 'ROE', '毛利率', '净利率',
    '营收增长', '利润增长', '扣非净利润增长', '营运利润', 'NBV(新业务价值)',
    '资产负债率', '流动比率', '股息率(TTM)', '每股经营现金流',
  ];
  // 字面量顺序（从源码提取）
  const literalLabels = [];
  const re = /\['([^']+)'/g; let mm;
  while ((mm = re.exec(literalBlock)) !== null) literalLabels.push(mm[1]);
  const dedIdxL = literalLabels.indexOf('扣非净利润增长');
  literalLabels.splice(dedIdxL + 1, 0, '营运利润', 'NBV(新业务价值)');
  eq(literalLabels.join('|'), leftLogical.join('|'), '左卡逻辑顺序应为 16 项且与设计一致');
  // 右卡：PS 标签动态（PS/PS·TTM），此处仅对齐「键序列」
  eq(keysFull.join('|'), ['pe','pb','ps','peg','roe','grossMargin','netMargin','growth','profitGrowth','dedProfitGrowth','opProfit','nbv','debt','currentRatio','div','ocf'].join('|'),
    '右卡 key 顺序（两项齐全时）应为 16 项同序');

  // ═══════════ 加载即运行 ═══════════
  console.log(`\nMETRIC_ORDER = ${METRIC_ORDER.join(', ')}`);
  console.log(`NBV 快照(601318) = ${snap.period} ${snap.valueYi}亿, 同比 +${snap.yoyPct}%`);
  console.log(`营运利润样例 = ${opM.valueText}（同比 +17.28% → ${opM.judgment.signal}）`);

  if (fail) {
    console.log(`\nFAIL ${pass}/${pass + fail}`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  } else {
    console.log(`\nPASS ${pass}/${pass}`);
  }
})().catch(e => { console.error('测试执行异常:', e); process.exit(1); });
