#!/usr/bin/env node
/**
 * scripts/test_chart_legend.js — [20261114a] 图表图例「颜色 + 形状」双编码守卫
 * ==================================================================
 * 用户裁决（2026-11-14）四条：
 *   ① 禁用红绿的范围 = 图例 + 图表数据系列；文字分析里的涨跌 / 利好 / 利空着色不受影响；
 *   ② 3 处 HTML「legend」经查证均非 ECharts 图例，不在范围；
 *   ③ 分类配色采用方案 A（6 色跨色系 + 钢灰）；
 *   ④ 按涨跌方向上色的主图模块（charts.js：K 线 / MACD / 涨跌家数 / 资金净流入正负柱）
 *      整体排除，图例与配色零变化。
 *
 * 六层检查（全部确定性纯函数 / 静态断言，vm 沙箱加载前端主题，不启浏览器、不联网、不改文件）：
 *   L1 方案 A 色板精确值 + 无红绿 + 相邻色相差 ≥ 60°
 *   L2 legendIconFor 按 series 表达方式返回不同图标
 *   L3 applyLegendSemantics 对截图那张「股东户数走势」逐项生成语义图标
 *   L4 polish 主图豁免：不注入色板、不改图例；非豁免实例正常注入
 *   L5 静态：本次替换过的分类色字面量已全部消失；方向着色 / 主图 / HTML legend 保持原样
 *   L6 静态：APP_VERSION 与全站 ?v= 一致，6 个图表实例全部挂 attach
 *   L7 [20261114b] 「机构持仓变化」卡片颜色回归：无显式色 series 按索引补色、
 *      图例项显式锁定颜色、方向着色豁免；同类 3 处全部收口
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function count(s, sub) { return s.split(sub).length - 1; }

// ---------- vm 沙箱加载 chartTheme.js ----------
const sandbox = { window: { echarts: { registerTheme: function () {} } }, console: console };
vm.createContext(sandbox);
vm.runInContext(read('public/js/chartTheme.js'), sandbox, { filename: 'chartTheme.js' });
const SA = sandbox.window.SA_CHART;

console.log('\n===== L1 方案 A 色板 =====');
const PALETTE_A = ['#3B82F6', '#F5A524', '#A855F7', '#38BDF8', '#E8D44D', '#8B7FE8'];
ok(!!SA && Array.isArray(SA.paletteA), 'chartTheme.js 导出 paletteA');
ok(JSON.stringify(SA.paletteA) === JSON.stringify(PALETTE_A),
  '方案 A 6 色精确值一致（用户裁决 3）', JSON.stringify(SA.paletteA));
ok(SA.neutralA === '#8A9BB0', '辅助钢灰 #8A9BB0（基准 / 均值线）');

function hueOf(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let hh;
  if (mx === r) hh = ((g - b) / d) % 6;
  else if (mx === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  hh *= 60;
  return hh < 0 ? hh + 360 : hh;
}
function hueDist(a, b) { const d = Math.abs(a - b); return Math.min(d, 360 - d); }
const hues = PALETTE_A.map(hueOf);
const isRed = h => h >= 340 || h <= 20;
const isGreen = h => h >= 80 && h <= 160;
ok(hues.every(h => !isRed(h) && !isGreen(h)),
  '分类色板禁用红绿（红 340°–20° / 绿 80°–160°）', '色相=' + hues.map(h => h.toFixed(0)).join(','));
const neighborGaps = hues.slice(1).map((h, i) => hueDist(hues[i], h));
ok(neighborGaps.every(d => d >= 60),
  '相邻序列色相差 ≥ 60°（跨色系最大区分序）', '相邻差=' + neighborGaps.map(d => d.toFixed(0)).join(','));
// 诚实记录：方案 A 第 1 与第 3 色（亮蓝 / 紫罗兰）色相差 < 60°，靠形状与明度辅助区分，符合 WCAG 1.4.1
ok(hueDist(hues[0], hues[2]) < 60,
  '已知边界如实登记：亮蓝 / 紫罗兰色相差 ' + hueDist(hues[0], hues[2]).toFixed(0) + '°，由图标形状承担区分（WCAG 1.4.1 双编码）');

console.log('\n===== L2 图例图标语义映射 =====');
const I = SA.legendIcons;
const cases = [
  [{ type: 'bar' }, I.bar, '柱 → 圆角方块'],
  [{ type: 'custom' }, I.bar, '2.5D 立体柱 custom → 圆角方块'],
  [{ type: 'candlestick' }, I.bar, 'K 线 → 圆角方块'],
  [{ type: 'line' }, I.line, '实线折线 → 实线横线'],
  [{ type: 'line', lineStyle: { type: 'solid' } }, I.line, 'solid 折线 → 实线横线'],
  [{ type: 'line', lineStyle: { type: 'dashed' } }, I.dashed, '虚线 → 虚线横线'],
  [{ type: 'line', lineStyle: { type: 'dotted' } }, I.dotted, '点线 → 点线横线'],
  [{ type: 'line', areaStyle: {} }, I.line, '面积图 → 横线'],
  [{ type: 'pie' }, I.point, '饼 → 圆点'],
  [{ type: 'scatter' }, I.point, '散点 → 圆点'],
  [{ type: 'effectScatter' }, I.point, '特效散点 → 圆点'],
];
cases.forEach(([s, expect, name]) => ok(SA.legendIconFor(s) === expect, name));
const distinct = new Set([I.bar, I.line, I.dashed, I.dotted, I.point]);
ok(distinct.size === 5, '5 类表达方式对应 5 种互不相同的图例图标（不再一律方块）');
ok(I.line.indexOf('path://') === 0 && I.dashed.indexOf('path://') === 0 && I.dotted.indexOf('path://') === 0,
  '线形图标使用 ECharts path:// 自定义形状（实线 / 虚线 / 点线可分辨）');
ok(I.dashed.split(' M').length > I.line.split(' M').length && I.dotted.split(' M').length > I.dashed.split(' M').length,
  '虚线段数 > 实线、点线点数 > 虚线（形状本身承载线型信息）');

console.log('\n===== L3 截图那张「股东户数走势」逐项语义 =====');
const shot = {
  legend: { data: ['股东户数', '环比变化%', '股价'], top: 0 },
  series: [
    { name: '股东户数', type: 'bar', data: [], itemStyle: { color: '#3B82F6' } },
    { name: '环比变化%', type: 'line', data: [], lineStyle: { width: 2, color: '#F5A524' } },
    { name: '股价', type: 'line', data: [], lineStyle: { width: 2, color: '#A855F7', type: 'dashed' } },
  ],
};
SA.applyLegendSemantics(shot);
ok(shot.legend.data[0].icon === I.bar, '股东户数（柱）→ 方块图例');
ok(shot.legend.data[1].icon === I.line, '环比变化%（实线）→ 实线横线图例');
ok(shot.legend.data[2].icon === I.dashed, '股价（虚线）→ 虚线横线图例');
ok(new Set(shot.series.map(s => s.itemStyle ? s.itemStyle.color : s.lineStyle.color)).size === 3,
  '三组分类色两两不同且无红绿', shot.series.map(s => s.itemStyle ? s.itemStyle.color : s.lineStyle.color).join(','));

const noData = { legend: { top: 0 }, series: [{ name: 'A', type: 'bar' }, { name: 'B', type: 'line', lineStyle: { type: 'dotted' } }] };
SA.applyLegendSemantics(noData);
ok(Array.isArray(noData.legend.data) && noData.legend.data.length === 2 && noData.legend.data[1].icon === I.dotted,
  '未显式给 legend.data 的混合图 → 按 series 顺序生成语义项');
const pieOnly = { legend: { type: 'scroll' }, series: [{ type: 'pie', data: [] }] };
SA.applyLegendSemantics(pieOnly);
ok(pieOnly.legend.icon === I.point && !pieOnly.legend.data,
  '单饼图无 legend.data → 只设 legend.icon=圆点，不破坏按扇区名自动生成的图例');
const hidden = { legend: { show: false, data: ['X'] }, series: [{ name: 'X', type: 'bar' }] };
SA.applyLegendSemantics(hidden);
ok(hidden.legend.data[0] === 'X', 'legend.show=false 的图不做图例语义注入');

console.log('\n===== L4 主图豁免（用户裁决 4）=====');
const mainOpt = {
  tooltip: { trigger: 'axis' },
  legend: { data: ['MA5', 'MA10'] },
  series: [{ name: 'MA5', type: 'line', data: [] }, { name: 'MA10', type: 'line', data: [] }],
};
SA.polish(mainOpt, { exempt: true });
ok(mainOpt.color === undefined, '豁免实例不注入方案 A 色板，继续继承 THEME.color 旧柔和色板');
ok(mainOpt.legend.data[0] === 'MA5' && mainOpt.legend.icon === undefined,
  '豁免实例图例保持原样（继续用主题级 roundRect 方块）');
ok(mainOpt.tooltip.backgroundColor === 'rgba(22,27,34,0.97)', '豁免实例 tooltip 外壳修补仍生效（原有行为不变）');
const normalOpt = {
  legend: { data: ['A', 'B'] },
  series: [{ name: 'A', type: 'bar' }, { name: 'B', type: 'line' }],
};
SA.polish(normalOpt);
ok(JSON.stringify(normalOpt.color) === JSON.stringify(PALETTE_A), '非豁免实例注入方案 A 色板');
ok(normalOpt.legend.data[0].icon === I.bar && normalOpt.legend.data[1].icon === I.line,
  '非豁免实例图例逐项语义化');
// attach 豁免开关
const fake = { setOption: function () { return 'ok'; }, __saPolished: false };
SA.attach(fake, { legendSemantics: false });
ok(fake.__saLegendExempt === true, 'attach(chart,{legendSemantics:false}) 打上主图豁免标记');
const fake2 = { setOption: function (o) { this.got = o; } };
SA.attach(fake2);
fake2.setOption({ legend: { data: ['A'] }, series: [{ name: 'A', type: 'bar' }] });
ok(fake2.__saLegendExempt === false && fake2.got.legend.data[0].icon === I.bar,
  'attach(chart) 默认不豁免，setOption 自动过语义注入');
ok(SA.theme.legend.icon === 'roundRect', 'THEME.legend.icon 保持 roundRect（主图继承方块，视觉零变化）');
ok(JSON.stringify(SA.theme.color) === JSON.stringify(SA.colors.palette),
  'THEME.color 仍为旧柔和色板（主图豁免实例继承，未改）');

console.log('\n===== L5 静态：替换落地 / 方向着色与主图保持不动 =====');
const SRC = {
  shareholder: read('public/js/shareholderCharts.js'),
  deep: read('public/js/deepCharts.js'),
  capital: read('public/js/capitalCharts.js'),
  industry: read('public/js/industryCharts.js'),
  etf: read('public/js/etfFlowPage.js'),
  chart3D: read('public/js/chart3D.js'),
  charts: read('public/js/charts.js'),
  theme: read('public/js/chartTheme.js'),
  css: read('public/css/style.css'),
  index: read('public/index.html'),
  server: read('server.js'),
};
// 本次明确替换过的「旧分类色」字面量（长片段，精确、无歧义），应全部归零
const GONE = [
  ['shareholder', "itemStyle: { color: '#5470c6' }, barWidth: '50%',"],
  ['shareholder', "color: '#7fa8c9', type: 'dashed' }"],
  ['shareholder', "lineStyle: { width: 2, color: '#cdab74' }, itemStyle: { color: '#cdab74' }"],
  ['etf', "lineStyle: { width: 2, color: '#7fa8c9' }, itemStyle: { color: '#7fa8c9' }"],
  ['chart3D', "['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c']"],
  ['capital', "name: '超大/大单', kind: 'line', data: largeNet, color: '#cdab74'"],
  ['capital', "color: 'rgba(127,168,201,0.60)'"],
  ['capital', "SA_CHART.grad('#7fa8c9', 0.22, 0)"],
  ['capital', "lineStyle: { width: 1.5, color: '#cf8e8e' }"],
  ['industry', "lineStyle: { width: 1, color: '#22C55E' }"],
  ['industry', "const revColor = '#4ADE80';"],
  ['industry', "const bmColor = '#F0B97B';"],
  ['deep', "revenue: '#7fa8c9',"],
  ['deep', "const palette = ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#f97316', '#94a3b8'];"],
  ['deep', "const palette = ['#7fa8c9', '#cdab74'];"],
  ['deep', "itemStyle: { color: '#f97316' }"],
  ['deep', "const cMean = '#95a5a6', cHigh = '#5cb85c', cLow = '#e74c3c';"],
  ['deep', "itemStyle: { color: '#e6b85c' },"],
  ['deep', "itemStyle: { color: '#5b8fb9' }"],
];
GONE.forEach(([k, s]) => ok(count(SRC[k], s) === 0, `旧分类色已清除：${k} :: ${s.slice(0, 46)}`));
// 新色板确实落地
ok(count(SRC.shareholder, '#3B82F6') >= 4 && count(SRC.shareholder, '#A855F7') >= 2,
  '股东图三组色改为亮蓝 / 琥珀橙 / 紫罗兰虚线');
ok(count(SRC.deep, '#3B82F6') >= 3 && count(SRC.capital, '#F5A524') >= 3, '深度分析 / 资金模块方案 A 色已落地');
// 方向着色保持不动（用户裁决 4 + 任务卡落地口径）
ok(count(SRC.capital, "color: function (v) { return v >= 0 ? '#F6465D' : '#0ECB81'; }") === 1,
  '资金净流入正负柱方向着色（函数色）保持红涨绿跌');
ok(count(SRC.capital, "color: function(p) { return p.value >= 0 ? 'rgba(207,142,142,0.80)' : 'rgba(143,184,154,0.80)'; }") === 1,
  '资金净流入 2D 回退分支方向着色保持不动');
ok(count(SRC.capital, "{ yAxis: 200, lineStyle: { color: '#cf8e8e', type: 'dashed' }") === 1,
  'VR 超买 / 超卖 markLine 辅助线保持不动');
ok(count(SRC.industry, "const upColor = '#F6465D';") === 1 && count(SRC.industry, "const downColor = '#0ECB81';") === 1,
  '行业图 K 线涨跌方向色保持不动');
ok(count(SRC.deep, "data.revenueGrowth >= 0 ? '#cf8e8e' : '#8fb89a'") >= 1,
  '深度分析增长率正负柱方向着色保持不动');
ok(count(SRC.deep, "yv >= 0 ? '#F6465D' : '#0ECB81'") >= 1,
  'NBV 同比增长方向着色保持不动');
ok(count(SRC.deep, "growth: { accent: '#7fa8c9'") === 1,
  '文字分析卡片 accent 着色不在本次范围，保持不动');
// 主图整体排除
ok(count(SRC.charts, 'SA_CHART.attach(chart, { legendSemantics: false })') === 1,
  'charts.js 唯一改动 = 主图豁免接线（1 行）');
ok(count(SRC.charts, "icon: 'roundRect'") === 2, '主图 2 处显式 roundRect 图例保持原样');
ok(count(SRC.charts, 'legendSemantics') === 1,
  '主图豁免接线恰好 1 处，未做图例语义改造');
// #3B82F6 在 charts.js 的 BOLL 下轨色中原本就存在（HEAD 版本 L76），本次未新增、未改动
ok(count(SRC.charts, "bollLower: '#3B82F6'") === 1 && count(SRC.charts, '#3B82F6') === 1,
  '主图配色零改动：#3B82F6 仅 HEAD 已有的 BOLL 下轨一处，本次未新增方案 A 色');
const mainLegendCount = count(SRC.charts, 'legend:');
ok(mainLegendCount === 9, `主图 9 处 legend 数量不变（当前 ${mainLegendCount}）`);
// 3 处 HTML「legend」排除
ok(count(SRC.css, '.sentiment-legend') >= 1 && count(SRC.css, '.dr-risk-legend') >= 1,
  '2 处孤儿 CSS legend 样式保持不动（非 ECharts 图例）');
ok(count(SRC.index, 'class="ai-cat-legend"') === 1 && count(SRC.index, '联网模型') >= 1,
  'AI 模型设置弹窗的 .ai-cat-legend 用途说明块保持不动');

console.log('\n===== L6 版本戳 / attach 覆盖 =====');
const ver = (SRC.server.match(/const APP_VERSION = '([0-9a-z]+)'/) || [])[1];
// 20261114c 根治：原断言把版本号硬编码为 20261114b，每次升版都变成假阳性失败
// （quick 新增失败即由此产生）。改为校验「版本号存在 + 全站戳与 server.js 一致」，
// 版本号唯一权威源仍是 server.js（DESIGN.md §9），且不再随升版需要手改守卫。
ok(/^\d{8}[a-z]$/.test(ver || ''), 'APP_VERSION 存在且格式正确（DESIGN.md §9 唯一权威源）', '当前 ' + ver);
const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
let stale = 0, stamped = 0;
htmls.forEach(f => {
  const s = read('public/' + f);
  const all = s.match(/\?v=\d{8}[a-z]/g) || [];
  stale += all.filter(v => v !== '?v=' + ver).length;
  stamped += count(s, '?v=' + ver);
});
ok(stale === 0, `public/*.html 无其它版本 ?v= 残留（全部对齐 ${ver}，${htmls.length} 个文件）`);
ok(stamped >= 37, `全站 ?v=${ver} 戳已同步（${stamped} 处）`);
const modules = ['capitalCharts', 'charts', 'deepCharts', 'industryCharts', 'shareholderCharts', 'etfFlowPage'];
modules.forEach(m => ok(count(read('public/js/' + m + '.js'), 'SA_CHART.attach(') === 1,
  `${m}.js 已挂 SA_CHART.attach（共 6 个 echarts.init 模块全覆盖）`));
ok(count(SRC.etf, 'SA_CHART.attach(trendChart)') === 1, 'etfFlowPage 原本缺 attach，本次已补齐');

console.log('\n===== L7 机构持仓变化卡片颜色回归（用户 15:41 截图报障，20261114b）=====');
ok(typeof SA.normalizeSeriesColors === 'function', 'chartTheme.js 导出 normalizeSeriesColors 纯函数');
// 复现该卡片：custom 柱（data 项自带色）+ 完全没写颜色的折线
const instOpt = {
  legend: { data: ['机构家数', '占流通股比%'], top: 0 },
  series: [
    { name: '机构家数', type: 'custom', data: [{ value: 11, color: '#3B82F6' }], renderItem: function () {} },
    { name: '占流通股比%', type: 'line', yAxisIndex: 1, data: [58.53], lineStyle: { width: 2 } },
  ],
};
SA.polish(instOpt);
ok(instOpt.series[0].itemStyle.color === '#3B82F6', '柱（custom）补方案 A 第 1 色 #3B82F6');
ok(instOpt.series[1].itemStyle.color === '#F5A524' && instOpt.series[1].lineStyle.color === '#F5A524',
  '折线补方案 A 第 2 色 #F5A524（琥珀橙），不再依赖 ECharts 隐式分色');
ok(instOpt.legend.data[0].itemStyle.color === '#3B82F6', '图例项 1 显式锁定亮蓝');
ok(instOpt.legend.data[1].itemStyle.color === '#F5A524', '图例项 2 显式锁定琥珀橙');
ok(instOpt.legend.data[0].itemStyle.color !== instOpt.legend.data[1].itemStyle.color,
  '机构卡片两项图例颜色不同（本次报障的直接验收点）');
ok(hueDist(hueOf(instOpt.legend.data[0].itemStyle.color), hueOf(instOpt.legend.data[1].itemStyle.color)) >= 60,
  '机构卡片两项图例色相差 ≥ 60°（亮蓝 217° / 琥珀橙 38°）');
ok(instOpt.legend.data[0].icon === I.bar && instOpt.legend.data[1].icon === I.line,
  '机构卡片图例形状仍为「方块 + 实线横线」');
// 方向着色豁免：同比增长（涨红跌绿）数据点颜色不动，图例色不得是红绿
const dirOpt = {
  legend: { data: ['收入(亿)', '同比增长(%)'] },
  series: [
    { name: '收入(亿)', type: 'line', data: [1], itemStyle: { color: '#3B82F6' } },
    { name: '同比增长(%)', type: 'line', yAxisIndex: 1, lineStyle: { type: 'dashed' },
      data: [{ value: 1, itemStyle: { color: '#F6465D' } }, { value: -1, itemStyle: { color: '#0ECB81' } }] },
  ],
};
SA.polish(dirOpt);
ok(dirOpt.series[1].itemStyle === undefined && dirOpt.series[1].lineStyle.color === undefined,
  '方向着色 series 不补分类色（涨红跌绿语义由数据项承担）');
ok(dirOpt.series[1].data[0].itemStyle.color === '#F6465D' && dirOpt.series[1].data[1].itemStyle.color === '#0ECB81',
  '方向着色数据点颜色保持红涨绿跌不变');
ok(dirOpt.legend.data[1].itemStyle.color !== '#F6465D' && dirOpt.legend.data[1].itemStyle.color !== '#0ECB81',
  '方向着色 series 的图例颜色不取红绿，按序号取方案 A');
ok(dirOpt.legend.data[1].icon === I.dashed, '该 series 是虚线 → 图例仍为虚线横线');
// 同类全排查落地：6 模块中原 3 处无显式色，2 处已显式补色，剩 1 处为方向着色豁免
ok(count(SRC.shareholder, "data: ratios, lineStyle: { width: 2 } }") === 0,
  '机构图 3D 分支与回退分支均已显式写色（原 2 处）');
ok(count(SRC.shareholder, "lineStyle: { width: 2, color: '#F5A524' }, itemStyle: { color: '#F5A524' } }") === 2,
  '机构图两处折线均显式使用琥珀橙 #F5A524');
ok(count(SRC.deep, '#5b8fb9') === 0 && count(SRC.deep, 'rgba(59,130,246,0.08)') === 1,
  '深度分析收入线旧蓝改方案 A 亮蓝（含面积渐变）');
ok(count(SRC.deep, "itemStyle: { color: (v === null) ? '#8b939c' : (v >= 0 ? '#F6465D' : '#0ECB81') }") === 1,
  '第 3 处（同比增长方向着色）保持不动，按用户裁决豁免');

console.log(`\n===== 图例双编码守卫：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
