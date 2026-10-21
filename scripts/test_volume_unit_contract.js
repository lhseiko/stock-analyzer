/**
 * 成交量「单位契约」回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_volume_unit_contract.js
 * 背景（用户 2026-10-21 截图报障）：
 *   「60 日均量 113900 ×1.5 = 170850（当日量 7358800）」——当日量比阈值大 43 倍，
 *   文案却说「未达阈值」。根因：实时行情覆写当日 K 线时单位换错（把「股」写进「手」序列）。
 *
 * 实测口径（用「成交额 ≈ 收盘价 × 量 × 100」反验，最可靠）：
 *   东财日K = 手　|　腾讯日K = 手（科创板已归一）　|　同花顺日K = 股　|　实时 quote = 股
 *
 * 覆盖（20261021h）：
 *   [1] 单位表：东财/腾讯=手、同花顺=股、未知通道保守按股
 *   [2] 覆写换算：三个通道各自的当日量写进日K后量级正确（不再 ×100 / ÷100）
 *   [3] 量级守卫：差 >20 倍直接拒绝覆写，并回 note='unit_mismatch'
 *   [4] capitalFlow 的 VOLUME_TO_LOT 与单位表同源（东财不再是 100）
 *   [5] 源码守卫：lib 里不再出现「按是否 tencent 二分」的单位换算
 *   [6] 文案守卫：结论中的「当日量」与阈值倍数自洽（不再只凭档位断言"未达"）
 */
const fs = require('fs');
const path = require('path');
const VE = require('../lib/volumeEngine');
const { BAR_VOL_UNIT, barVolumeUnit, sharesToBarUnit, toLotDivisor } = require('../lib/volUnit');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const T = '2026-10-21';

console.log('\n[1] 单位表（单一来源）');
{
  eq(BAR_VOL_UNIT.eastmoney, 'hand', '东财日K = 手');
  eq(BAR_VOL_UNIT.tencent, 'hand', '腾讯日K = 手');
  eq(BAR_VOL_UNIT.ths, 'share', '同花顺日K = 股');
  eq(barVolumeUnit('unknown-channel'), 'share', '未知通道保守按股（宁可少除）');
  eq(sharesToBarUnit(7358800, 'eastmoney'), 73588, '股→手：7,358,800 股 = 73,588 手');
  eq(sharesToBarUnit(7358800, 'tencent'), 73588, '腾讯同为手');
  eq(sharesToBarUnit(7358800, 'ths'), 7358800, '同花顺本身是股，不换算');
  eq(toLotDivisor('eastmoney'), 1, '东财已是手，除数为 1');
  eq(toLotDivisor('ths'), 100, '同花顺需 ÷100');
}

console.log('\n[2] 实时行情覆写当日K线：三个通道量级都正确（用户报障的正是这条）');
{
  const mkBars = (vol) => [
    { date: '2026-10-20', open: 13.8, high: 13.9, low: 13.7, close: 13.8, volume: vol },
    { date: T, open: 13.8, high: 13.9, low: 13.7, close: 13.87, volume: vol },
  ];
  const quote = { price: 13.87, open: 13.8, high: 13.9, low: 13.7, volume: 7358800, date: T }; // 股

  // 东财通道（手）：73588 → 覆写后仍应是 73588
  const emBars = mkBars(73588);
  const rEM = VE._reconcileTodayBar(emBars, quote, 'eastmoney', T);
  eq(emBars[1].volume, 73588, '东财通道：当日量仍为 73,588 手（旧实现会写成 7,358,800，×100）');
  ok(rEM.note !== 'unit_mismatch', '东财通道不被量级守卫误拦');

  // 腾讯通道（手）：同样 73588
  const txBars = mkBars(73588);
  VE._reconcileTodayBar(txBars, quote, 'tencent', T);
  eq(txBars[1].volume, 73588, '腾讯通道：73,588 手');

  // 同花顺通道（股）：7,358,800 原值
  const thsBars = mkBars(7358800);
  VE._reconcileTodayBar(thsBars, quote, 'ths', T);
  eq(thsBars[1].volume, 7358800, '同花顺通道：7,358,800 股（原值）');
}

console.log('\n[3] 量级守卫：单位再写错也不会污染序列');
{
  const bars = [
    { date: '2026-10-20', open: 13.8, high: 13.9, low: 13.7, close: 13.8, volume: 73588 },
    { date: T, open: 13.8, high: 13.9, low: 13.7, close: 13.87, volume: 73588 },
  ];
  const badQuote = { price: 13.87, open: 13.8, high: 13.9, low: 13.7, volume: 3588000000, date: T }; // 离谱的 ×1000
  const r = VE._reconcileTodayBar(bars, badQuote, 'eastmoney', T);
  eq(r.note, 'unit_mismatch', '量级差过大 → 拒绝覆写并回 unit_mismatch');
  eq(bars[1].volume, 73588, '日K原值未被污染');
  ok(r.mag > 20 || r.mag < 0.05, `上报量级差 ${r.mag} 倍`);
}

console.log('\n[4] capitalFlow 换算表与单位表同源');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'capitalFlow.js'), 'utf8');
  ok(/const \{ toLotDivisor \} = require\('\.\/volUnit'\)/.test(src), 'capitalFlow 引用 lib/volUnit');
  ok(src.includes("eastmoney: toLotDivisor('eastmoney')"), '东财除数取自单一来源（不再是写死的 100）');
  const m = src.match(/const VOLUME_TO_LOT = \{([^}]+)\}/);
  ok(!!m, 'VOLUME_TO_LOT 仍存在（消费方无需改动）');
  if (m) ok(!/eastmoney:\s*100/.test(m[1]), '东财不再被硬写成 100');
}

console.log('\n[5] 源码守卫：禁止再按「是否 tencent」二分做单位换算');
{
  const files = ['lib/volumeEngine.js', 'lib/capitalFlow.js', 'lib/stockData.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const bad = /barsSource\s*===\s*'tencent'\s*\?\s*1\s*:\s*100/.test(src)
      || /barsSource\s*===\s*'tencent'\s*\?\s*quote\.volume\s*\/\s*100/.test(src);
    ok(!bad, `${f} 无「tencent ? … : 100」式单位换算`);
  }
  const vu = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volUnit.js'), 'utf8');
  ok(/东财/.test(vu) && /成交额/.test(vu), 'volUnit 头注释记录了实测依据（成交额反验）');
}

console.log('\n[6] 文案自洽：结论里的当日量与阈值倍数必须同源');
{
  // 构造：60 日均量 1000、当日 800 → 阈值 1500、当日/阈值 = 0.53 → 应说「未达」
  const bars = [];
  for (let i = 0; i < 70; i++) {
    bars.push({ date: `2026-0${i < 30 ? 8 : 9}-${String((i % 28) + 1).padStart(2, '0')}`, open: 10, high: 10.2, low: 9.9, close: 10, volume: 1000 });
  }
  bars.push({ date: T, open: 10, high: 10.6, low: 9.9, close: 10.5, volume: 800 });
  const r = VE.computeVolumeEngine({
    bars, symbol: 'TEST', name: '测试', barsSource: 'eastmoney',
    position: { label: '高位区间' },
    minutes: null,
  });
  const item = (r.contradictionSummary.items || []).find(x => /该放量未放量/.test(x.signal || ''));
  ok(!!item, '拿到「该放量未放量」条目');
  if (item) {
    ok(/60 日均量 1000 ×1\.5 = 1500（当日量 800）/.test(item.conclusion), '同屏展示 均值×1.5=阈值（当日量）');
    ok(/当日量为阈值的 0\.53 倍/.test(item.conclusion), '同时给出「当日量 ÷ 阈值」倍数，用户可自行核对');
    ok(/未达/.test(item.conclusion), '0.53 倍确实未达 → 文案说「未达」');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
