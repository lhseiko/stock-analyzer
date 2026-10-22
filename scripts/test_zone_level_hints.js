/**
 * 量能引擎「放量破位」支撑位来源统一（20261022d）回归
 * --------------------------------------------------------------
 * 运行： node scripts/test_zone_level_hints.js
 * 覆盖：
 *   [1] deriveLevelHints：就近取有效支撑/阻力区间（过滤无效、按距离）
 *   [2] deriveLevelHints：无区间 / 价格非法 → null（回退引擎自算）
 *   [3] _keyLevels：优先采用 hint，支撑 price=下沿/触及线=上沿；阻力 price=上沿/触及线=下沿
 *   [4] _keyLevels：无 hint → 单点价位（low=high=price），行为与旧版一致
 *   [5] _keyLevels：非法 hint 被忽略
 *   [6] 接线守卫：规则4 用区间触及/跌破线；引擎支持 levelHints；capitalFlow 注入短期区间
 */
const fs = require('fs');
const path = require('path');
const { deriveLevelHints } = require('../lib/zoneLevelsHint');
const { _keyLevels } = require('../lib/volumeEngine');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

console.log('\n[1] deriveLevelHints：就近取有效区间');
{
  const st = {
    supports: [
      { low: 32, high: 32.4, source: '近60日摆动低点', valid: true },
      { low: 33, high: 33.5, source: 'MA20', valid: true },        // 离现价最近（上沿 33.5 ≤ 34×1.02）
      { low: 34, high: 34.5, source: 'x', valid: false },          // 无效，排除
    ],
    resistances: [
      { low: 36, high: 36.5, source: '近60日摆动高点', valid: true },
      { low: 35, high: 35.4, source: 'MA20', valid: true },        // 离现价最近（下沿 35 ≥ 34×0.98）
    ],
  };
  const h = deriveLevelHints(st, 34);
  ok(!!h, '返回 hints');
  eq(h.support.low, 33, '支撑就近取 33~33.5（下沿）');
  eq(h.support.high, 33.5, '支撑就近取 33~33.5（上沿）');
  ok(/支撑区间/.test(h.support.kind), '支撑 kind 标注区间');
  eq(h.resistance.low, 35, '阻力就近取 35~35.4（下沿）');
  eq(h.resistance.high, 35.4, '阻力就近取 35~35.4（上沿）');
  ok(/阻力区间/.test(h.resistance.kind), '阻力 kind 标注区间');
}

console.log('\n[2] deriveLevelHints：无区间 / 非法价格 → null');
{
  eq(deriveLevelHints({ supports: [], resistances: [] }, 34), null, '无区间 → null');
  eq(deriveLevelHints({ supports: [{ low: 33, high: 33.5, valid: false }], resistances: [] }, 34), null, '全无效 → null');
  eq(deriveLevelHints({ supports: [{ low: 33, high: 33.5, valid: true }], resistances: [] }, null), null, '价格非法 → null');
  eq(deriveLevelHints(null, 34), null, 'shortTerm 缺失 → null');
}

console.log('\n[3] _keyLevels：优先采用短期区间');
{
  const pc = { closeToday: 34, stageHigh: 40, stageLow: 30, ma20: 33, ma60: 35 };
  const lv = _keyLevels(pc, null, {
    support: { low: 33, high: 33.5, kind: 'MA20·支撑区间' },
    resistance: { low: 35, high: 35.4, kind: 'MA20·阻力区间' },
  });
  eq(lv.support.price, 33, '支撑 price=区间下沿（跌破线）');
  eq(lv.support.low, 33, '支撑 low=下沿');
  eq(lv.support.high, 33.5, '支撑 high=上沿（触及线）');
  eq(lv.support.kind, 'MA20·支撑区间', '支撑 kind 透传');
  eq(lv.resistance.price, 35.4, '阻力 price=区间上沿（突破线）');
  eq(lv.resistance.low, 35, '阻力 low=下沿（触及线）');
  eq(lv.resistance.high, 35.4, '阻力 high=上沿');
}

console.log('\n[4] _keyLevels：无 hint → 单点（行为与旧版一致）');
{
  const pc = { closeToday: 34, stageHigh: 40, stageLow: 30, ma20: 33, ma60: 35 };
  const lv = _keyLevels(pc, null);
  eq(lv.support.low, lv.support.price, '支撑 low=price');
  eq(lv.support.high, lv.support.price, '支撑 high=price');
  eq(lv.resistance.low, lv.resistance.price, '阻力 low=price');
  eq(lv.resistance.high, lv.resistance.price, '阻力 high=price');
  ok(lv.support.price > 0 && lv.resistance.price > 0, '仍给出有效单点价位');
}

console.log('\n[5] _keyLevels：非法 hint 被忽略');
{
  const pc = { closeToday: 34, stageHigh: 40, stageLow: 30, ma20: 33, ma60: 35 };
  const lv = _keyLevels(pc, null, { support: { low: -1, high: 33 }, resistance: { low: 40, high: 39 } });
  eq(lv.support.low, lv.support.price, '负数/非法支撑 hint 被忽略（回退单点）');
  eq(lv.resistance.high, lv.resistance.price, '倒挂阻力 hint 被忽略（回退单点）');
}

console.log('\n[6] 接线守卫');
{
  const ve = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
  ok(/touchLine/.test(ve) && /breakLine/.test(ve), '规则4 使用区间触及线/跌破线');
  ok(/levelHints/.test(ve), '引擎支持 levelHints');
  ok(/_keyLevels\(pc, platform, input && input\.levelHints\)/.test(ve), 'computeVolumeEngine 传入 levelHints');
  const cf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'capitalFlow.js'), 'utf8');
  ok(/deriveLevelHints/.test(cf), 'capitalFlow 注入短期动向区间');
  ok(/levelHints/.test(cf), 'capitalFlow 传 levelHints 给引擎');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
