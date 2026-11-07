/**
 * 20261106i：量价关系判定结论统一守卫（用户裁决「只统一结论展示」方案 C）
 * 运行：node scripts/test_vp_conclusion_unified.js
 *
 * 背景：同一天同一标的同屏出现三处互相矛盾的量价关系结论——
 *   「资金量能综合判断·量价关系」(ratio5 ÷前5日均量 → 平量上涨)、
 *   「资金行为」(ratio5 → 量平价升，没有增量资金大举进场)、
 *   「135 格主判」(_volTier5 用 ratio20 ÷20日均量 → 放量上涨，增量资金进场)。
 * 方案 C：数值 / 公式 / 评分 / 判定记录 / API 结构全不动，只把同屏收敛为一个
 * 「今日量价关系判定」结论，135 格改称「综合判定」并去掉互斥措辞，显式标注两套分母。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = t => console.log('\n===== ' + t + ' =====');

const app = read('public/js/app.js');
const charts = read('public/js/capitalCharts.js');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const pmSrc = read('lib/posModel135.js');
const mapHtml = read('public/volume-map.html');
const server = read('server.js');
const pm = require('../lib/posModel135');
const { CapitalCharts } = require('../public/js/capitalCharts');

section('§1 唯一结论出口：今日量价关系判定');
ok(charts.includes("label: '今日量价关系判定（唯一结论）'"), '量价关系行标签明确标为唯一结论');
ok(charts.includes('text: `${vp.signal} — ${vp.description}`'), '结论文本仍是 vp.signal — vp.description（数值零改动）');
ok(!charts.includes("label: '量价关系'"), '旧的含糊标签「量价关系」已退役');
ok(app.includes('已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源') && app.includes('同屏结论不再互斥'), '20261106k：量价判定卡写明统一 ÷20 分母后同屏结论不再互斥（唯一结论由同源分母保证）');

// 20 种 signal 值域遍历实测（不能只跑用户给的例子；20261106o 新增 5 种震荡档中性信号）
// 注意：部分赋值是三元表达式（如 bigUp ? '大涨平量' : '温和上涨'），
// 必须对整个赋值表达式取全部单引号字面量，不能只匹配 `= 'xxx'` 直赋，否则会漏掉一半值域。
const sigAssignments = [...cf.matchAll(/volumePriceSignal\s*=\s*([^;]+);/g)].map(m => m[1]);
const sigSet = new Set();
for (const expr of sigAssignments) {
  for (const m of expr.matchAll(/'([^']+)'/g)) sigSet.add(m[1]);
}
const signals = [...sigSet];
ok(signals.length === 20, `量价信号值域共 ${signals.length} 种（含默认值、三元分支与 20261106o 震荡档 5 种）`);
ok(['缩量震荡','平量震荡','放量震荡','地量震荡','巨量震荡'].every(s => signals.includes(s)), '20261106o 震荡档 5 种信号全部在值域内');
let renderOk = true, renderFail = '';
for (const sig of signals) {
  const parts = CapitalCharts.buildConclusionParts({
    volumeIndicators: {
      volumePrice: { signal: sig, description: '口径遍历测试描述' },
      indicators: { obvTrend: '中性', vrSignal: '中性', mfiSignal: '中性' },
    },
    moneyFlow: {}, marginTrading: {}, conclusion: null,
  });
  const row = (parts.rows || []).find(r => r.wide && r.label === '今日量价关系判定（唯一结论）');
  if (!row || !String(row.text).startsWith(sig + ' — ')) { renderOk = false; renderFail = sig; }
}
ok(renderOk, `全 ${signals.length} 种 signal 真实调用 buildConclusionParts：唯一结论行均正确渲染${renderFail ? '（失败：' + renderFail + '）' : ''}`);
ok(signals.includes('温和上涨') && signals.includes('量价平衡'), '值域含本轮报障信号「温和上涨」与默认值');

section('§2 互斥措辞移除 + 135 格全遍历 + 引擎-推演图同源');
ok(!pmSrc.includes('增量资金进场'), 'posModel135.js 已无「增量资金进场」措辞');
ok(!mapHtml.includes('增量资金进场'), '推演图已无「增量资金进场」措辞');
ok(ve.includes('没有增量资金大举进场'), '资金行为维度原文案保留（不删数据、不改口径）');
ok(!(pmSrc.includes('增量资金进场') && ve.includes('没有增量资金大举进场')),
  '同屏不再出现「增量资金进场」与「没有增量资金大举进场」互斥结论');

const zones = ['① 高位区间', '② 中位区间', '③ 低位区间'];
const states = ['趋势向上', '趋势向下', '区间震荡'];
const vols = ['放量', '平量', '缩量'];
const tiers = ['大涨', '上涨', '震荡', '下跌', '大跌'];
let cells = 0, nulls = 0;
const offenders = [], keyMismatch = [];
for (const z of zones) for (const s of states) for (const v of vols) for (const t of tiers) {
  const c = pm.volCell(z, s, v, t);
  if (!c) { nulls++; continue; }
  cells++;
  if (String(c.conclusion || '').includes('增量资金进场')) offenders.push(`${z}/${s}/${v}/${t}`);
  if (c.key !== `${z}|${s}|${v}|${t}`) keyMismatch.push(`${z}/${s}/${v}/${t}`);
}
ok(cells + nulls === 135, `135 格组合全覆盖（命中 ${cells} 格 / 知识表未定义 ${nulls} 格）`);
ok(offenders.length === 0, `全部 ${cells} 格 conclusion 均不含「增量资金进场」（漏网 ${offenders.length} 格）`);
ok(keyMismatch.length === 0, `全部归格 key 结构未变（改动 ${keyMismatch.length} 格）→ 判定逻辑零改动`);

const cMid = pm.volCell('② 中位区间', '趋势向上', '放量', '上涨');
const cLow = pm.volCell('③ 低位区间', '趋势向上', '放量', '上涨');
ok(cMid && cMid.conclusion === '健康主升，量价配合，趋势延续性较好', '中位格新文案 = 健康主升，量价配合，趋势延续性较好');
ok(cLow && cLow.conclusion === '底部启动信号；放量级别越大，启动可靠性越高', '低位格新文案 = 底部启动信号…');
ok(mapHtml.includes(cMid.conclusion) && mapHtml.includes(cLow.conclusion),
  '两条新文案在推演图逐字同源（20261105f 契约）');
ok(cMid.key === '② 中位区间|趋势向上|放量|上涨' && cLow.key === '③ 低位区间|趋势向上|放量|上涨',
  '报障两格归格 key 与方向未变（只改文案）');

section('§3 135 格主判改称「综合判定」');
ok(!app.includes('主判 · '), '用户可见的「主判 · 」标签已退役');
ok(app.includes('135 格综合判定 · '), '主判横幅改称「135 格综合判定 ·」');
ok(app.includes("'均未改变综合判定'") && app.includes('有特例命中（综合判定已挂起）'), '生效路径文案同步');
ok(app.includes('本卡为当日唯一的 135 格综合判定'), '表下注释明确本卡性质');
ok(app.includes('${caliberHtml}') && app.includes('const caliberHtml ='), '口径说明节点已接线且变量已定义');

section('§4 两套分母口径说明 / 其它卡片零改动');
ok(app.includes('已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源'), '20261106k：注明 135 格 ÷20 日均量（统一分母）');
ok(!app.includes('「5日量能比」（÷前5日均量）') && app.includes('「5日量能比」「60日量能确认」已退役'), '20261106l：「5日量能比」卡退役，口径说明注明 ÷5 口径去向（顶部「量比」）');
ok(app.includes('数值不应相等'), '20261106k：显式写明统一口径与原始指标卡数值不应相等');
ok(app.includes('不承担量价判定结论'), '20261106k：明确原始指标卡不是量价关系判定');
ok(app.includes('<span class="cm-label">资金行为</span>') && app.includes('dim.capitalBehavior'),
  '资金行为卡标签与数据源零改动（不与唯一结论冲突）');

section('§5 判定逻辑 / 数值 / 判断记录零改动');
ok(ve.includes('const ratio20 = pc.ratio20;') && ve.includes('if (ratio20 > 1.3)') && ve.includes('else if (ratio20 < 0.8)'),
  '_volTier5 仍用 ratio20 且阈值 1.3 / 0.8 未变');
ok(cf.includes('const dayVolRatio = priorAvgVol > 0') && cf.includes('const volumePriceRatio = avgDownVol > 0'),
  'capitalFlow 量价信号公式未变');
ok(cf.includes("const ut = (opts && opts.unifiedTier) || null;"), 'unifiedTier 同源链路未变');
ok(ve.includes("schema: 'volume-engine-20261106p'"), '引擎 schema 未升（输出结构未变）');
ok(sjd.includes("const LAYOUT_VERSION = '20261106o'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，判断记录强制重算）');
ok(!sjd.includes('cell.conclusion') && !sjd.includes('pj.cell'), 'sameDayJudgment 不消费 135 格 conclusion（改动无下游影响）');
ok(pmSrc.includes('module.exports = { ZONES, STRONG, DERIVED_KEYS, TIER5, volCell }'), 'posModel135 导出结构未变');

section('§7 20261106n：m 轮「全模块综合总结（代码聚合）」行已删除（用户裁决：总结输出不理想，票型罗列冗长、与横幅信息重复、中性信息计票）');
// 退役负断言：聚合行代码与相关文案不得残留
ok(!charts.includes("rows.unshift({ icon: '🧭'"), '聚合行 unshift 代码已删除');
const chartsCode = charts.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // 剥离行注释（20261106n 留档注释合法保留）
ok(!chartsCode.includes('全模块综合总结（代码聚合）'), '聚合行标签文案已删除（留档注释除外）');
ok(!chartsCode.includes('20261106m（用户裁决'), 'm 轮聚合块注释已清理（留档注释除外）');

section('§8 版本戳 / 缓存破坏');
ok(/const APP_VERSION = '20261106p'/.test(server), 'APP_VERSION = 20261106p');
ok(server.includes('[20261106i]'), 'server.js 存在 [20261106i] 独立变更日志');
ok(server.includes('[20261106h]') && server.includes('[20261106g]'), '功能引入版本号保留（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261106p') && !html.includes('?v=20261106l'), `public/${f} 缓存戳全部对齐 20261106p`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
