/**
 * 判断因子「方向语义」回归测试
 * --------------------------------------------------------------
 * 目标（用户 2026-09-01 要求）：短期 / 长期判断的所有因子，方向必须与语义一致
 *   利好 → 正 signal → 红色「利好 +n」；利空 → 负 signal → 绿色「利空 -n」。
 *
 * 覆盖的高危方向语义：
 *   1) 对标期货：corr 为皮尔逊相关系数，可为负。负相关个股必须反向传导
 *      （期货涨 → 该股偏空），旧实现只取 |corr| 作强度，方向判反。
 *   2) 量价口径：放量随价向、缩量反价向（缩量上涨=上涨乏力→偏空；
 *      缩量下跌=抛压衰竭→偏多），与 factorCapital 的 vpSigMap 口径一致。
 *   3) 增持减持 / 板块涨跌停：净减持、跌停潮必须为负。
 *   4) 影响程度评分映射：signal → impactScore 的方向保底（弱信号不得被抹平成 0）。
 *
 * 运行：node scripts/test_factor_direction.js
 */
const fs = require('fs');
const path = require('path');

// 从源码中提取顶层函数（短期判断模块未导出这些内部函数，只能按名字截取后 eval）
function extractFn(src, name) {
  const re = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数: ' + name);
  return m[0];
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
const STOCK_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stockData.js'), 'utf8');
// 20260917i：不再从源码提取 'localDate' —— 源码里它是委托壳（引用未注入沙箱的 _localDate），
// 且与下方 require('../lib/localDate') 的解构 const localDate 重名，会触发
// SyntaxError: Identifier 'localDate' has already been declared。改为统一使用 require 的真实实现。
const NAMES = ['round', 'avg', 'formatWan', 'latestQuarterEnd', // 20260913f：报告期标注依赖
  'factorFuturesShort',
  'shortDirectionToSignal', // 20260905d/20260905e：大盘及行业板块短期走势因子依赖 helper
  // 20260917i：原 factorMarketShort 因子已按用户要求删除，改为两个拆分后的子因子 helper
  'computeMarketShortSub', 'computeSectorTrendSub', 'computeSectorNewsSub',
  'factorHoldings', 'factorSectorLimit', '_computeTurnoverChange'];
const sandbox = {};
// 20260917i：因子/子因子权重常量（W_* / *_SUB_W）随函数一并注入沙箱（源码中因子函数已改为引用常量）
const CONST_DECLS = (SRC.match(/^const (?:W_[A-Z_]+|[A-Z_]+_SUB_W) = [\d.]+;.*$/gm) || []).join('\n');
if (!CONST_DECLS) throw new Error('未提取到 W_* / *_SUB_W 权重常量');
// 20260917i：因子函数返回体引用 FACTOR_NAME（因子展示名映射，如 sectorLimit→'行业板块'），
// 需随函数一并注入沙箱，否则 ReferenceError: FACTOR_NAME is not defined。
const FACTOR_NAME_DECL = (SRC.match(/^const FACTOR_NAME = \{[\s\S]*?\n\};/m) || [])[0];
if (!FACTOR_NAME_DECL) throw new Error('未提取到 FACTOR_NAME 展示名常量');
// eslint-disable-next-line no-eval
eval(CONST_DECLS + '\n' + FACTOR_NAME_DECL + '\n' + NAMES.map(n => extractFn(SRC, n)).concat([extractFn(STOCK_SRC, 'detectMarket')]).join('\n'));

// 20260906：clamp 已收口至 ruleCore 共享内核（源码中不再有本地定义），改为直接 require
const { clamp, toImpactScore, impactLabel } = require('../lib/ruleCore');
const { localDate, localCompact, localDateFromTs } = require('../lib/localDate');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = (expect === 'pos' && actual > 0) || (expect === 'neg' && actual < 0)
    || (expect === 'zero' && Math.abs(actual) < 1e-9) || (typeof expect === 'number' && Math.abs(actual - expect) < 1e-9);
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  const dir = actual > 0 ? '利好(红)' : actual < 0 ? '利空(绿)' : '中性(灰)';
  console.log(`[${tag}] ${name} → signal=${Number(actual).toFixed(3)} (${dir}) 期望=${expect}`);
}

console.log('===== 1) 对标期货：相关性符号必须参与方向传导 =====');
// 期货近 5 日 +5%（futuresClose 5 个点：100 → 105）
const fcUp = [100, 101, 102, 103, 105];
// 期货近 5 日 -5%
const fcDown = [100, 99, 98, 97, 95];
check('正相关 corr=+0.8，期货 +5%', factorFuturesShort({ hasFutures: true, correlation: 0.8, futuresClose: fcUp, futuresName: 'X' }).signal, 'pos');
check('正相关 corr=+0.8，期货 -5%', factorFuturesShort({ hasFutures: true, correlation: 0.8, futuresClose: fcDown, futuresName: 'X' }).signal, 'neg');
check('负相关 corr=-0.8，期货 +5%（反向→偏空）', factorFuturesShort({ hasFutures: true, correlation: -0.8, futuresClose: fcUp, futuresName: 'X' }).signal, 'neg');
check('负相关 corr=-0.8，期货 -5%（反向→偏多）', factorFuturesShort({ hasFutures: true, correlation: -0.8, futuresClose: fcDown, futuresName: 'X' }).signal, 'pos');
check('无期货 → 不适用', factorFuturesShort({ hasFutures: false }).signal, 'zero');

console.log('\n===== 2) 量价口径：放量随价向 / 缩量反价向 =====');
const mkSeries = (turnoverSeq, closes) => turnoverSeq.map((t, i) => ({ turnover: t, close: closes[i] }));
// 价格序列：仅最后一根 K 线变价（函数取最后两根收盘价比较方向）
const closesUp = new Array(21).fill(10); closesUp[20] = 11;    // 10 → 11 上涨
const closesDown = new Array(21).fill(10); closesDown[20] = 9; // 10 → 9  下跌
const trVol = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4];      // 放量（2 → 4）
const trShrink = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1.5, 1]; // 缩量（2 → 1）
check('放量上涨', _computeTurnoverChange(mkSeries(trVol, closesUp)).signal, 'pos');
check('放量下跌', _computeTurnoverChange(mkSeries(trVol, closesDown)).signal, 'neg');
check('缩量上涨（上涨乏力→偏空）', _computeTurnoverChange(mkSeries(trShrink, closesUp)).signal, 'neg');
check('缩量下跌（抛压衰竭→偏多）', _computeTurnoverChange(mkSeries(trShrink, closesDown)).signal, 'pos');

console.log('\n===== 3) 增持减持 / 板块涨跌停 =====');
const holders = (n, amt) => new Array(n).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: amt }));
check('十大股东净减持', factorHoldings({ topShareholders: holders(10, -5e6) }, { ok: false, count: 0 }).signal, 'neg');
check('十大股东净增持', factorHoldings({ topShareholders: holders(10, 5e6) }, { ok: false, count: 0 }).signal, 'pos');
check('无股东数据但有回购', factorHoldings({ topShareholders: [] }, { ok: true, count: 2 }).signal, 'pos');
check('板块跌停潮', factorSectorLimit({ ok: true, limitUpRatio: 0, limitDownRatio: 0.2, limitUp: 0, limitDown: 1, total: 5, boardName: 'X' }, null, null).signal, 'neg');
check('板块涨停潮', factorSectorLimit({ ok: true, limitUpRatio: 0.2, limitDownRatio: 0, limitUp: 1, limitDown: 0, total: 5, boardName: 'X' }, null, null).signal, 'pos');

// 20260913f：数据报告期标注（用户反馈「小卡片没有标注日期」）——因子 caption 与两个子卡片都必须带报告期
const holdersDated = (endDate) => new Array(10).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: i < 6 ? 5e6 : -5e6, endDate }));
const hLast = factorHoldings({ topShareholders: holdersDated('2026-06-30') }, { ok: false, count: 0 });
const subCount = (hLast.subFactors || []).find(s => s.name === '增减持家数') || {};
const subNet = (hLast.subFactors || []).find(s => s.name === '十大股东净变动') || {};
const qExpect = latestQuarterEnd();
const isQ = /^\d{4}-\d{2}-\d{2}$/.test(qExpect) && /-(03-31|06-30|09-30|12-31)$/.test(qExpect) && qExpect <= localDate();
if (isQ) pass++; else fail++;
console.log(`[${isQ ? 'PASS' : 'FAIL'}] latestQuarterEnd() = ${qExpect}（必须是 ≤ 今天的季度末）`);
const capOk = /数据报告期/.test(hLast.caption || '') && /2026-06-30/.test(hLast.caption || '') && /东方财富 F10/.test(hLast.caption || '');
if (capOk) pass++; else fail++;
console.log(`[${capOk ? 'PASS' : 'FAIL'}] 因子 caption 含报告期+来源：${hLast.caption}`);
const subOk = /数据报告期\s*2026-06-30/.test(subCount.detail || '') && /数据报告期\s*2026-06-30/.test(subNet.detail || '');
if (subOk) pass++; else fail++;
console.log(`[${subOk ? 'PASS' : 'FAIL'}] 「增减持家数」「十大股东净变动」子卡片均带报告期`);
// 非最新季报期必须显式标注（数据最新性规则：过期必须标注）
const hOld = factorHoldings({ topShareholders: holdersDated('2026-03-31') }, { ok: false, count: 0 });
const oldFlag = /非最新季报期/.test(hOld.caption || '');
if (oldFlag) pass++; else fail++;
console.log(`[${oldFlag ? 'PASS' : 'FAIL'}] 旧报告期显式标注「非最新季报期」：${hOld.caption}`);

console.log('\n===== 4) 大盘短期走势 / 行业短期走势（20260917i 因子重组拆分自「大盘及行业板块短期走势」）=====');
const ctxOf = (chg, dir) => ({
  selectedIndices: [{ name: '上证指数', changePct: chg }],
  techIndices: [{ name: '上证指数', step6: { shortTerm: { direction: dir } } }],
  scopeLabel: '上证指数',
});
check('大盘短期走势（首页研判看空）', computeMarketShortSub(ctxOf(-2, '看空')).signal, 'neg');
check('大盘短期走势（首页研判看多）', computeMarketShortSub(ctxOf(2, '看多')).signal, 'pos');
check('大盘短期走势（首页研判震荡）', computeMarketShortSub(ctxOf(0, '震荡')).signal, 'zero');
check('行业短期走势（板块 -2%）', computeSectorTrendSub({ ok: true, boardChange: -2, upCount: 1, downCount: 9, boardName: 'X' }).signal, 'neg');
check('行业短期走势（板块 +2%）', computeSectorTrendSub({ ok: true, boardChange: 2, upCount: 9, downCount: 1, boardName: 'X' }).signal, 'pos');
check('板块消息（利空）', computeSectorNewsSub({ ok: true, signal: -0.8, count: 5, positive: 1, negative: 4, keywords: ['X'], avgScore: -0.5 }).signal, 'neg');
const snNull = computeSectorNewsSub(null);
if (snNull === null) pass++; else fail++;
console.log(`[${snNull === null ? 'PASS' : 'FAIL'}] 板块消息（数据缺失→返回 null 不展示子卡）`);
// 「行业板块」因子：涨跌停占比 + 行业短期走势 + 板块消息 三路加权，方向必须由三方共同决定
check('行业板块（跌停潮+行业跌+板块利空）', factorSectorLimit({ ok: true, limitUpRatio: 0, limitDownRatio: 0.2, limitUp: 0, limitDown: 1, total: 5, boardName: 'X' }, { ok: true, boardChange: -2, upCount: 1, downCount: 9, boardName: 'X' }, { name: '板块消息', signal: -0.8 }).signal, 'neg');
check('行业板块（涨停潮+行业涨+板块利好）', factorSectorLimit({ ok: true, limitUpRatio: 0.2, limitDownRatio: 0, limitUp: 1, limitDown: 0, total: 5, boardName: 'X' }, { ok: true, boardChange: 2, upCount: 9, downCount: 1, boardName: 'X' }, { name: '板块消息', signal: 0.8 }).signal, 'pos');

console.log('\n===== 5) 影响程度评分映射（signal → impactScore）=====');
const mapCases = [
  [0, 0, '零信号 → 中性 0'],
  [0.01, 0, '极弱 +0.01 → 中性 0'],
  [0.02, 1, '弱 +0.02 → 方向保底 利好 +1'],
  [-0.10, -1, '弱 -0.10（如指数60日 -7.1%）→ 方向保底 利空 -1'],
  [0.36, 1, '+0.36 → 利好 +1'],
  [0.5, 2, '+0.5 → 利好 +2'],
  [-0.5, -2, '-0.5 → 利空 -2'],
  [1, 3, '满格 +1 → 利好 +3'],
  [-1, -3, '满格 -1 → 利空 -3'],
];
for (const [sig, exp, desc] of mapCases) {
  const got = toImpactScore(sig);
  const ok = got === exp;
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${desc} → impactScore=${got}（${impactLabel(got)}）`);
}

console.log('\n===== 6) 专属因子子维度方向（20260913f）=====');
// 海天「CPI·食品烟酒及在外餐饮」：子维度必须各按自身数值定方向，
// 不得沿用因子总信号（否则环比 +0.3% 上行=利好 会被总信号带成「利空」）。
const dFactor = require('../lib/dedicatedFactor');
const cpiSubs = dFactor.computeSubSignals('food_cpi_haitian', { yoy: -0.7, mom: 0.3 });
check('CPI 同比 -0.7%（下行）子信号', cpiSubs.yoy, 'neg');
check('CPI 环比 +0.3%（上行）子信号', cpiSubs.mom, 'pos');
check('CPI 因子总信号仍为加权合成 -0.1', dFactor.computeSignal('food_cpi_haitian', { yoy: -0.7, mom: 0.3 }), -0.1);
const cpiMapYoy = toImpactScore(cpiSubs.yoy), cpiMapMom = toImpactScore(cpiSubs.mom);
check('CPI 同比显示为「利空」', cpiMapYoy, 'neg');
check('CPI 环比显示为「利好」', cpiMapMom, 'pos');
const cpiCard = dFactor.getDedicatedFactorsForSymbol('603288', 'short')[0];
if (cpiCard) {
  const momCard = (cpiCard.subFactors || []).find(s => s.key === 'mom') || {};
  const ok2 = momCard.signal > 0 && /上行\s*→\s*利好/.test(momCard.detail || '');
  if (ok2) pass++; else fail++;
  console.log(`[${ok2 ? 'PASS' : 'FAIL'}] 因子卡片环比子维度方向正确（signal=${momCard.signal}）：${momCard.detail}`);
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
