#!/usr/bin/env node
/**
 * scripts/test_factor_corr_windows.js — backlog ③ 多窗口因子对照守卫（零网络）
 * @test-scope: local
 * 守护点：
 *   1. analyzeWindowsCore 对合成日K三窗口（60/120/250）均能跑通，字段齐全、口径正确
 *      （有效样本 = 各股（窗口−20）根、非空相关对 = 28、样本不足规则生效）；
 *   2. 趋势型合成数据在全部窗口检出高相关簇（簇结构字段完整）；
 *   3. buildWindowsReport 数字与 core 重算严格一致（防手改：md 表格单元格必须逐字段
 *      等于 core 输出——手改 md 会被下次重跑覆盖，本守卫锁「脚本生成」这一来源）；
 *   4. 报告构建确定性：同输入两次构建 → md 逐字节一致（fixed generatedAt）。
 * 边界：不触网、不落盘（buildWindowsReport 传固定 generatedAt，analyzeWindowsCore 纯函数）。
 */
'use strict';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

const { analyzeWindowsCore, buildWindowsReport, WINDOWS_DEF, INSUFFICIENT_SAMPLES } = require('./analyze_factor_corr');

// ---- 合成日K：确定性种子 PRNG（mulberry32），4 只趋势股 × 260 根 ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function synthBars(nBars, base, trend, seed) {
  const rnd = mulberry32(seed);
  const bars = [];
  let close = base;
  for (let i = 0; i < nBars; i++) {
    const drift = 1 + trend / 100 + (rnd() - 0.5) * 0.02;
    close = +(close * drift).toFixed(4);
    const open = +(close * (1 + (rnd() - 0.5) * 0.01)).toFixed(4);
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, // 日期仅占位（core 不用日期）
      open, close,
      high: +(Math.max(open, close) * 1.005).toFixed(4),
      low: +(Math.min(open, close) * 0.995).toFixed(4),
      volume: Math.round(100000 + rnd() * 50000),
    });
  }
  return bars;
}
const SYMBOLS = ['SYA', 'SYB', 'SYC', 'SYD'];
const histories = SYMBOLS.map((sym, i) => ({ symbol: sym, bars: synthBars(260, 10 + i * 5, 0.03 + i * 0.01, 42 + i) }));

console.log('[test_factor_corr_windows] 三窗口跑通与字段齐全');
const results = analyzeWindowsCore({ histories, windows: WINDOWS_DEF, minAbs: 0.7 });
ok(Array.isArray(results) && results.length === 3, '三窗口均返回结果（60/120/250）');
ok(results.map(r => r.days).join(',') === '60,120,250', '窗口序列 = 60,120,250');
for (const r of results) {
  const expValid = (r.days - 20) * SYMBOLS.length; // mom_20d 预热 20 根
  ok(r.validSamples === expValid, `窗口 ${r.days} 有效样本 = ${r.validSamples}（(窗口−20)×${SYMBOLS.length}）`);
  ok(r.pairCount === 28, `窗口 ${r.days} 非空相关对 = 28（8 主因子 C(8,2)）`);
  ok(typeof r.highPairCount === 'number' && r.highPairCount >= 0, `窗口 ${r.days} 高相关对字段存在（=${r.highPairCount}）`);
  ok(r.avgAbsAll != null && Number.isFinite(r.avgAbsAll) && r.avgAbsAll > 0 && r.avgAbsAll <= 1, `窗口 ${r.days} 全对平均|P| 合法（${r.avgAbsAll.toFixed(3)}）`);
  ok(Array.isArray(r.clusters) && r.clusters.length >= 1, `窗口 ${r.days} 检出高相关簇 ≥1（实际 ${r.clusters.length}）`);
  for (const c of r.clusters) {
    ok(Array.isArray(c.members) && c.members.length >= 2 && c.avgAbs != null && c.minAbsW != null, `窗口 ${r.days} 簇字段完整（成员 ${c.members.length}、平均 ${c.avgAbs.toFixed(2)}、最弱边 ${c.minAbsW.toFixed(2)}）`);
  }
  ok(typeof r.insufficient === 'boolean', `窗口 ${r.days} 样本判定字段存在（=${r.insufficient}）`);
}
ok(results.every(r => !r.insufficient), '60/120/250 三窗口均不触发样本不足（阈值 ' + INSUFFICIENT_SAMPLES + '）');

console.log('[test_factor_corr_windows] 样本不足规则');
{
  const tiny = analyzeWindowsCore({ histories, windows: [30, 60], minAbs: 0.7 });
  ok(tiny[0].insufficient === true && tiny[0].validSamples < INSUFFICIENT_SAMPLES, `30 日窗口有效样本 ${tiny[0].validSamples} < ${INSUFFICIENT_SAMPLES} → 标样本不足`);
  ok(tiny[1].insufficient === false, '60 日窗口同输入不受 30 日窗口影响');
}

console.log('[test_factor_corr_windows] 报告数字与重算一致（防手改）');
{
  const fixedAt = '2026-11-12T00:00:00.000Z'; // 固定生成时间 → 可复现
  const fetchNotes = SYMBOLS.map(sym => ({ symbol: sym, source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' }));
  const md1 = buildWindowsReport({ asOf: '2026-11-12', symbols: SYMBOLS, results, minAbs: 0.7, generatedAt: fixedAt, fetchNotes });
  const md2 = buildWindowsReport({ asOf: '2026-11-12', symbols: SYMBOLS, results, minAbs: 0.7, generatedAt: fixedAt, fetchNotes });
  ok(md1 === md2, '同输入两次构建 md 逐字节一致（确定性，无隐藏时间戳）');
  ok(md1.includes('AI 生成，待人工复核'), '报告含「AI 生成，待人工复核」标注');
  ok(md1.includes('禁止手改'), '报告含「禁止手改」声明');
  ok(md1.includes('不做显著性检验') && md1.includes('同源不外推') && md1.includes('窗口敏感'), '局限声明齐全（窗口敏感/同源不外推/显著性）');
  ok(md1.includes('新浪日K(quotes.sina.cn) ×4'), '降级口径：实际数据源逐股计数动态标注（新浪 ×4）');
  ok(md1.includes('若非主源腾讯日K'), '降级口径：非主源时注明数值基于降级源（不写「无降级」）');
  ok(md1.includes('无滞后'), '截断末根核验：全齐时写「无滞后」');
  for (const r of results) {
    // 逐字段锁：md 表格行的前四个单元格必须与 core 重算完全一致
    const expectRow = `| ${r.days} | ${r.validSamples} | ${r.pairCount} | ${r.highPairCount} | ${r.clusters.length} |`;
    ok(md1.includes(expectRow), `窗口 ${r.days} 表格行与重算一致：${expectRow.trim()}`);
    const expectAvg = r.avgAbsAll.toFixed(3);
    ok(md1.includes(expectAvg), `窗口 ${r.days} 平均|P| ${expectAvg} 动态插入（非手写）`);
    if (r.minClusterEdge != null) ok(md1.includes(r.minClusterEdge.toFixed(3)), `窗口 ${r.days} 最弱边 ${r.minClusterEdge.toFixed(3)} 动态插入`);
  }
  // 防手改反证：篡改一个数字后 md 与重算不一致（守卫逻辑本身对得上）
  const tampered = md1.replace(`| 60 | ${results[0].validSamples} |`, `| 60 | ${results[0].validSamples + 1} |`);
  ok(tampered !== md1 && !md1.includes(`| 60 | ${results[0].validSamples + 1} |`), '反证：表格数字被手改 +1 后即偏离重算值（重跑会擦除）');
}

console.log(`\n=== 因子多窗口守卫汇总：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
