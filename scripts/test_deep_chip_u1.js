// =====================================================================
// test_deep_chip_u1.js —— U1「深度分析筹码分布统一到锚点三」守卫（20261105j 定版）
// 背景：deep/pipeline.js 原有一套 120 日窗口 / 50 档 / 指数衰减的过时筹码算法，
//       与量价判定锚点三（lib/chipDistribution.js 本地 CYQ）并存。U1 将其统一。
// 核实前提：旧 sections.chipDistribution 全项目零下游消费（深度分析页「成交密集区」图
//           用的是 capitalFlow.volumeProfile 的另一套 VPVR），故换输出字段不会破坏下游。
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { computeChipDistribution, CYQ_WINDOW, CYQ_BARS } = require('../lib/chipDistribution');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'deep', 'pipeline.js'), 'utf8');
const veSrc = fs.readFileSync(path.join(ROOT, 'lib', 'volumeEngine.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = (t) => console.log('\n===== ' + t + ' =====');

section('§A 旧 120 日算法已整块移除');
ok(!src.includes('function calculateChipDistribution'), '旧 calculateChipDistribution 函数已删除');
ok(!src.includes('slice(-120)'), '120 日窗口已移除');
ok(!src.includes('binCount = 50'), '50 档分箱已移除');
ok(!src.includes('const decay = 0.995'), '指数衰减权重已移除');
ok(!src.includes('dayWeight'), '旧 dayWeight 已移除');

section('§B 新锚点三模块接线');
ok(src.includes("require('../chipDistribution')"), '静态 require 锚点三模块');
ok(/const \{\s*computeChipDistribution\s*\}/.test(src), '解构 computeChipDistribution');
ok(src.includes('computeChipDistribution(history, fv * 1e8 / px, {})'), '调用入参 = history + 流通股本');
ok(src.includes('quote.circulationValue'), '流通股本来源 = 腾讯行情流通市值(亿)');
ok(src.includes('authoritativePrice > 0 ? authoritativePrice'), '现价优先用入口确立的权威价');

section('§C 与 volumeEngine 锚点三同源（单一权威源）');
ok(veSrc.includes('computeChipDistribution(barsResult.bars, fv * 1e8 / px'), '引擎侧同为 fv*1e8/px 推流通股本');
ok(veSrc.includes("require('./chipDistribution')"), '引擎侧也 require 同一模块');
ok(CYQ_WINDOW === 250 && CYQ_BARS === 150, '250 日窗口 / 150 档为单一知识源参数');

section('§D 诚实降级与不伪造');
ok(src.includes('if (!fv || !px) return null;'), '流通股本或权威价不可得 → 不上报筹码');
ok(src.includes('if (!chip) return null;'), 'CYQ 计算失败 → 不上报筹码');
ok(src.includes('chartData: null, peakPrice: null, minPrice: null, maxPrice: null'), '新模块不产出的旧字段一律置 null，禁止编造');
ok(src.includes('profitRatio: chip.benefitPct'), '兼容别名 profitRatio 取真实 benefitPct（同为百分比量纲）');
ok(src.includes('dataDate:'), '保留数据日五要素之一');
ok(src.includes('...chip'), '输出含新模块原生字段（benefitRatio/avgCost/p90/p70/verdict/note/basis）');

section('§E 新模块行为自洽（合成日K，零网络）');
function mkBars(n) {
  const out = [];
  const d0 = new Date('2025-01-02');
  while (out.length < n) {
    const wd = d0.getDay();
    if (wd !== 0 && wd !== 6) {
      const i = out.length;
      const px = 30 + 6 * Math.sin(i / 18) + i * 0.012;
      out.push({
        date: d0.toISOString().slice(0, 10),
        open: px - 0.12, close: px + 0.08, high: px + 0.5, low: px - 0.5,
        volume: 120000, // 手
      });
    }
    d0.setDate(d0.getDate() + 1);
  }
  return out;
}
const bars = mkBars(260);
const floatShares = 5e9; // 50 亿股 → 日换手约 0.24%
const chip = computeChipDistribution(bars, floatShares, {});
ok(chip !== null, '合成 260 根日K + 有效流通股本 → 筹码计算成功');
if (chip) {
  ok(chip.window === 250, '窗口取 250 日');
  ok(typeof chip.benefitRatio === 'number' && chip.benefitRatio >= 0 && chip.benefitRatio <= 1, 'benefitRatio ∈ [0,1]');
  ok(chip.benefitPct === +((chip.benefitRatio * 100).toFixed(1)), 'benefitPct 与 benefitRatio 同口径');
  ok(typeof chip.avgCost === 'number' && chip.avgCost > 0, 'avgCost 为正数');
  ok(!!chip.p90 && !!chip.p70 && typeof chip.verdict === 'string' && !!chip.basis, 'p90/p70/verdict/basis 齐备');
}
ok(computeChipDistribution([], floatShares, {}) === null, 'bars 不足 → null 降级');
ok(computeChipDistribution(bars, 0, {}) === null, '流通股本缺失 → null 降级');

console.log(`\n===== 汇总：通过 ${pass}/${pass + fail} =====`);
process.exit(fail > 0 ? 1 : 0);
