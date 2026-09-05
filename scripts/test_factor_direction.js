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
const NAMES = ['clamp', 'round', 'avg', 'formatWan', 'factorFuturesShort',
  'shortDirectionToSignal', // 20260905d/20260905e：大盘及行业板块短期走势因子依赖 helper
  'factorMarketShort', 'factorHoldings', 'factorSectorLimit', '_computeTurnoverChange'];
const sandbox = {};
// eslint-disable-next-line no-eval
eval(NAMES.map(n => extractFn(SRC, n)).concat([extractFn(STOCK_SRC, 'detectMarket')]).join('\n'));

const { toImpactScore, impactLabel } = require('../lib/ruleCore');

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
check('板块跌停潮', factorSectorLimit({ ok: true, limitUpRatio: 0, limitDownRatio: 0.2, limitUp: 0, limitDown: 1, total: 5, boardName: 'X' }).signal, 'neg');
check('板块涨停潮', factorSectorLimit({ ok: true, limitUpRatio: 0.2, limitDownRatio: 0, limitUp: 1, limitDown: 0, total: 5, boardName: 'X' }).signal, 'pos');

console.log('\n===== 4) 大盘及行业板块 =====');
check('大盘与行业齐跌', factorMarketShort({ cn: [{ changePct: -2 }, { changePct: -2 }] }, { ok: true, boardChange: -2, upCount: 1, downCount: 9 }).signal, 'neg');
check('大盘与行业齐涨', factorMarketShort({ cn: [{ changePct: 2 }, { changePct: 2 }] }, { ok: true, boardChange: 2, upCount: 9, downCount: 1 }).signal, 'pos');

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

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
