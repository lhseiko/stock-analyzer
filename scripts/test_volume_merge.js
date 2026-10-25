/**
 * 量价分析 → 量能分析 合并 + 去重 守卫（20261024i）
 * 运行： node scripts/test_volume_merge.js
 *
 * 用户 2026-10-24 要求：把量价分析合并到量能分析里，重复展示删除；
 * 并修复「个别个股量价分析失效、无法读取最新数据」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const idx = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const cc = fs.readFileSync(path.join(root, 'public', 'js', 'capitalCharts.js'), 'utf8');
const cap = fs.readFileSync(path.join(root, 'lib', 'capitalFlow.js'), 'utf8');

console.log('\n[1] 独立「量价关系分析」卡已删除，量能卡标题体现合并');
ok(!idx.includes('id="capVolumePrice"'), 'index.html 无独立 #capVolumePrice 容器');
ok(idx.includes('id="capVolumeEngine"'), '保留 #capVolumeEngine 容器');
ok(idx.includes('量价 × 价格位置 × 量能行为'), '量能卡标题改为「量价 × 价格位置 × 量能行为」');

console.log('\n[2] 量价内容并入 renderVolumeEngine，且去重');
ok(app.includes('量价配合（当日）'), 'renderVolumeEngine 内含「量价配合（当日）」区块');
ok(app.includes('20日涨跌日') && app.includes('20日量价比') && app.includes('20日净涨跌'), '保留量价独有指标（20日涨跌日/量价比/净涨跌）');
ok(app.includes('量比与量能档位同源，不重复展示'), '明确声明量比/量能档位不重复展示');
ok(!app.includes('量比(÷5日均量)'), '不再重复渲染「量比(÷5日均量)」标签（去重）');
ok(app.includes('量价数据不足（可用日K不足 20 根或数据源暂不可用）'), '量价缺失时给出明确原因（不整卡空白）');

console.log('\n[3] 前端接线：不再单独渲染旧卡，且安全退出');
ok(!cc.includes('this.renderVolumePrice('), 'capitalCharts.renderAll 不再调用 renderVolumePrice');
ok(cc.includes('if (!el) return; // 20261024i'), 'renderVolumePrice 在元素缺失时安全退出');
ok(cc.includes('量价关系分析已合并进「量能分析」卡'), 'capitalCharts 注释说明合并');
ok(!app.includes('CapitalCharts.renderVolumePrice(data.volumeIndicators)'), '实时刷新不再单独渲染旧量价卡');

console.log('\n[4] 后端双源兜底：个别个股量价不整块空白');
ok(cap.includes('量价指标双源兜底'), 'capitalFlow 有「量价指标双源兜底」说明');
ok(cap.includes('let volumeIndicators = computeVolumeIndicators('), 'volumeIndicators 改为可回退赋值');
ok(cap.includes('if (!volumeIndicators)') && cap.includes('alt = history'), '首选来源算不出 → 回退另一来源');

console.log('\n[5] 运行时：computeVolumeIndicators 仍产出 volumePrice（合并未破坏计算）');
{
  let computeVolumeIndicators = null;
  try {
    const Module = require('module');
    const src = cap + '\nmodule.exports.__t = { computeVolumeIndicators };\n';
    const m = new Module(path.join(root, 'lib', 'capitalFlow.js'));
    m.filename = path.join(root, 'lib', 'capitalFlow.js');
    m.paths = Module._nodeModulePaths(path.join(root, 'lib'));
    m._compile(src, path.join(root, 'lib', 'capitalFlow.js'));
    computeVolumeIndicators = m.exports.__t.computeVolumeIndicators;
  } catch (e) { console.log('     装载失败:', e.message); }
  if (computeVolumeIndicators) {
    const bars = [];
    for (let i = 0; i < 25; i++) bars.push({ date: '2026-09-' + String(i + 1).padStart(2, '0'), open: 10, high: 10.2, low: 9.8, close: 10, volume: 1000000 });
    bars.push({ date: '2026-10-23', open: 10, high: 10.3, low: 10, close: 10.2, volume: 1600000 });
    const vi = computeVolumeIndicators(bars, null, null);
    ok(vi && vi.volumePrice && typeof vi.volumePrice.signal === 'string', '25+ 根 → 正常产出 volumePrice.signal');
    ok(vi && vi.volumePrice && typeof vi.volumePrice.dayChangePct === 'number', '含今日涨跌 dayChangePct');
    const short = computeVolumeIndicators(bars.slice(0, 15), null, null);
    ok(short === null, '不足 20 根 → 返回 null（前端显示「量价数据不足」原因）');
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
