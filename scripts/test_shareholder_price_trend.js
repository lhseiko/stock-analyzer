/**
 * 确定性单测：股价走势与股东户数报告期对齐（buildPriceTrend）
 * 不依赖网络，验证「精确匹配 / 向前取最近交易日 / 向后取最近交易日 / 超出窗口返回 null」四档逻辑。
 */
const assert = require('assert');
const { _buildPriceTrend: buildPriceTrend } = require('../lib/shareholderData');

// 报告期：2024-03-31 与 2024-06-30 为周末（非交易日），2024-09-30 / 2024-12-31 为交易日
const holderTrend = [
  { date: '2024-03-31' },
  { date: '2024-06-30' },
  { date: '2024-09-30' },
  { date: '2024-12-31' },
];

const kline = [
  { date: '2024-03-29', close: 10.0 }, // 周五，<= 03-31 最近
  { date: '2024-06-28', close: 11.0 }, // 周五，<= 06-30 最近
  { date: '2024-09-30', close: 12.0 }, // 精确
  { date: '2024-12-31', close: 13.0 }, // 精确
];

const out = buildPriceTrend(holderTrend, kline);
assert.strictEqual(out.length, 4, '输出长度应等于报告期数量');
assert.strictEqual(out[0].close, 10.0, '03-31 应取最近交易日 03-29 的收盘价');
assert.strictEqual(out[1].close, 11.0, '06-30 应取最近交易日 06-28 的收盘价');
assert.strictEqual(out[2].close, 12.0, '09-30 应精确匹配');
assert.strictEqual(out[3].close, 13.0, '12-31 应精确匹配');
assert.deepStrictEqual(out.map(o => o.date), ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31'], '日期应原样保留');

// 向后取最近交易日（报告期早于所有 kline 且落在窗口内）
const holderEarly = [{ date: '2024-01-01' }];
const outEarly = buildPriceTrend(holderEarly, [{ date: '2024-01-05', close: 9.5 }]);
assert.strictEqual(outEarly[0].close, 9.5, '01-01 应向后取 01-05 收盘价（窗口内）');

// 超出窗口返回 null
const holderFar = [{ date: '2099-01-01' }];
const outFar = buildPriceTrend(holderFar, kline);
assert.strictEqual(outFar[0].close, null, '无近邻交易日时应返回 null');

// 空 kline 返回空数组
assert.deepStrictEqual(buildPriceTrend(holderTrend, []), [], '空 kline 应返回空数组');

console.log('✅ test_shareholder_price_trend: 5/5 通过');
