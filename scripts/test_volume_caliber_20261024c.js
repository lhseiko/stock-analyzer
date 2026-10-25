/**
 * 量比档位口径统一守卫（20261024c）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_volume_caliber_20261024c.js
 *
 * 背景：20261024b 已把 marketEmotion 三处量比档位对齐到 1.2/0.8。
 * 本测试锁定 audit 后续发现的两处「共用放量/缩量标签、却用 1.5 阈值」的口径，
 * 20261024c 一并对齐到项目「量比」铁律（>1.2 放量 / <0.8 缩量）：
 *   ① capitalFlow.latestVsPriorAvg.trend（个股页 volumeTrend 来源）
 *   ② capitalFlow 个股突破 breakoutVolRatio（与 zoneReversal 箱体突破 1.2 同源）
 * 两处均经迁移守卫 test_volume_root_migration 等价校验，本测试补显式边界断言。
 */
const assert = require('assert');
const { computeVolumeIndicators } = require('../lib/capitalFlow');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// 确定性历史：前 n-1 根均为 baseVol，最后一根可单独改写以精确控制量比
function mkHist(n, baseVol) {
  const h = [];
  for (let i = 0; i < n; i++) {
    const close = 50 + i * 0.02;
    const high = close + 0.5, low = close - 0.5;
    h.push({ date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, open: close, high, low, close, volume: baseVol, amount: close * baseVol });
  }
  return h;
}

console.log('\n[1] latestVsPriorAvg.trend 对齐 1.2/0.8（个股页 volumeTrend）');
{
  const base = 1000;
  const cases = [
    { vol: 2500, expect: '放量', note: '量比 2.5 → 放量' },
    { vol: 1300, expect: '温和放量', note: '量比 1.3 → 温和放量（旧 1.5 会误判 normal）' },
    { vol: 1000, expect: 'normal', note: '量比 1.0 → normal（平量）' },
    { vol: 700, expect: '缩量', note: '量比 0.7 → 缩量（旧 0.5 会误判 normal）' },
  ];
  for (const c of cases) {
    const h = mkHist(25, base);
    h[h.length - 1].volume = c.vol;
    const vi = computeVolumeIndicators(h, null, null);
    const lvp = vi.indicators.latestVsPriorAvg;
    ok(Math.abs(lvp.ratio - c.vol / base) < 0.01, `${c.note}：量比≈${(c.vol / base).toFixed(2)}（实际 ${lvp.ratio}）`);
    ok(lvp.trend === c.expect, `${c.note}：trend=${c.expect}（实际 ${lvp.trend}）`);
  }
}

console.log('\n[2] 个股突破 breakoutVolRatio 对齐 1.2（与箱体突破同源）');
{
  const base = 1000;
  // 放量突破前高：收盘 > 前20日最高，量比 ≥1.2
  const h1 = mkHist(25, base);
  h1[24].volume = 1300; h1[24].close = 60; h1[24].high = 60.5; h1[24].low = 59.5;
  const b1 = computeVolumeIndicators(h1, null, null).indicators.breakout;
  ok(b1.volRatio >= 1.2 && b1.pattern === '放量突破前高', `量比 1.3 突破 → 放量突破前高（实际 ${b1.volRatio}/${b1.pattern}）`);

  // 放量跌破前低
  const h2 = mkHist(25, base);
  h2[24].volume = 1300; h2[24].close = 40; h2[24].high = 40.5; h2[24].low = 39.5;
  const b2 = computeVolumeIndicators(h2, null, null).indicators.breakout;
  ok(b2.volRatio >= 1.2 && b2.pattern === '放量跌破前低', `量比 1.3 跌破 → 放量跌破前低（实际 ${b2.volRatio}/${b2.pattern}）`);

  // 缩量新高：收盘 > 前20日最高，但量比 <0.8
  const h3 = mkHist(25, base);
  h3[24].volume = 700; h3[24].close = 60; h3[24].high = 60.5; h3[24].low = 59.5;
  const b3 = computeVolumeIndicators(h3, null, null).indicators.breakout;
  ok(b3.volRatio < 0.8 && b3.pattern === '缩量新高', `量比 0.7 新高 → 缩量新高（实际 ${b3.volRatio}/${b3.pattern}）`);

  // 量比 1.0（无显著量能）突破前高 → 不再判放量突破
  const h4 = mkHist(25, base);
  h4[24].volume = 1000; h4[24].close = 60; h4[24].high = 60.5; h4[24].low = 59.5;
  const b4 = computeVolumeIndicators(h4, null, null).indicators.breakout;
  ok(b4.volRatio < 1.2 && b4.volRatio >= 0.8 && b4.pattern === '无显著形态', `量比 1.0 突破 → 无显著形态（实际 ${b4.volRatio}/${b4.pattern}）`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
