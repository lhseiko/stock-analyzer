/**
 * 20261106f：「20日涨跌日量能比」数值解读逻辑下拉面板守卫
 * 运行：node scripts/test_vp_ratio_interpret.js
 *
 * 用户指令：卡片加下拉窗口，显示＞1 / ≈1 / ＜1 三档数值解读逻辑；
 * 并结合这套逻辑分析今日量价关系判定（如放量上涨）输出结论：
 *   A 票 1.7 + 放量上涨 → 契合多头习惯，可信度高
 *   B 票 0.6 + 放量上涨 → 与固有结构相反，警惕诱多
 *
 * 覆盖：① 规则表纯函数实测（代码权威，不调 LLM）② 参考表着色铁律
 * ③ 两条渲染路径同口径接线 ④ 轮询重建展开状态恢复 ⑤ 零后端改动 ⑥ 版本戳。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { VpRatioInterpret: V } = require('../public/js/capitalCharts.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = t => console.log('\n===== ' + t + ' =====');

const app = read('public/js/app.js');
const cc = read('public/js/capitalCharts.js');
const css = read('public/css/style.css');
const idx = read('public/index.html');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

const combine = (ratio, signal) => V.combine(V.ratioBand(ratio), V.signalBias(signal), ratio, signal);
const panel = (ratio, signal, open) => V.buildPanel({ ratio, signal }, { open: !!open });

section('§1 单一真值源与加载顺序');
ok(typeof V === 'object' && typeof V.buildPanel === 'function', 'capitalCharts.js 导出 VpRatioInterpret 规则模块');
ok(cc.includes('module.exports = { CapitalCharts, VpRatioInterpret }'), 'UMD 导出供 Node 守卫纯函数实测');
ok(idx.indexOf('js/capitalCharts.js') > 0 && idx.indexOf('js/app.js') > idx.indexOf('js/capitalCharts.js'),
  'index.html 中 capitalCharts.js 先于 app.js 加载（app.js 可直接访问全局词法绑定）');
ok(!idx.includes('vpRatioInterpret.js'), '复用既有脚本文件，未新增 script 标签（零缓存戳额外负担）');
ok(app.includes('VpRatioInterpret.buildPanel(vp') && app.includes('VpRatioInterpret.buildTrigger('), 'app.js 消费共享规则模块');
ok(cc.includes('VpRatioInterpret.buildPanel(vp') && cc.includes('VpRatioInterpret.buildTrigger('), 'capitalCharts.js 消费同一规则模块');
ok(!cc.includes('avgUpVol') && !cc.includes('avgDownVol'), '前端不重算涨跌日均量，只读 vp.ratio（单一权威源）');
ok(cf.includes('signal: volumePriceSignal') && cf.includes('ratio: Math.round(volumePriceRatio * 100) / 100'),
  '后端 volumePrice.signal / ratio 输出结构原样（零后端改动）');

section('§2 三档分档与 ≈1 容差（代码权威）');
ok(V.ratioBand(1.70).key === 'gt' && V.ratioBand(1.70).bias === 'bull', '1.70 → ＞1 多头结构');
ok(V.ratioBand(0.60).key === 'lt' && V.ratioBand(0.60).bias === 'bear', '0.60 → ＜1 空头结构');
ok(V.ratioBand(1.00).key === 'eq' && V.ratioBand(0.95).key === 'eq' && V.ratioBand(1.05).key === 'eq', '0.95~1.05 → ≈1 均衡');
ok(V.ratioBand(1.06).key === 'gt' && V.ratioBand(0.94).key === 'lt', '容差边界外正确归档');
ok(V.ratioBand(null).key === 'na' && V.ratioBand(NaN).key === 'na', '数据不足/非有限值诚实降级');
ok(V.EQ_LO === 0.95 && V.EQ_HI === 1.05, '容差常量单一真值源');

section('§3 今日量价信号 → 结构倾向解析');
ok(V.signalBias('放量上涨').bias === 'bull' && V.signalBias('量价齐升').bias === 'bull', '放量上涨/量价齐升 → 上涨日更活跃');
ok(V.signalBias('缩量上涨').bias === 'bear' && V.signalBias('地量上涨').bias === 'bear', '缩量/地量上涨 → 上涨惜量');
ok(V.signalBias('放量下跌').bias === 'bear' && V.signalBias('巨量下跌').bias === 'bear', '放量/巨量下跌 → 下跌日更活跃');
ok(V.signalBias('缩量回调').bias === 'bull' && V.signalBias('地量下跌').bias === 'bull', '缩量/地量回调 → 抛压有限');
ok(V.signalBias('温和上涨').bias === 'flat' && V.signalBias('显著下跌').bias === 'flat', '平量/温和/显著 → 无放量印证');
ok(V.signalBias('量价平衡').bias === 'flat' && V.signalBias(null).bias === 'na', '量价平衡/信号缺失 → 诚实降级');

section('§4 用户两个示例：结构比对结论（确定性规则）');
{
  const a = combine(1.7, '放量上涨');
  ok(a.alignment === 'match' && a.tone === 'bull', 'A 票 1.7 + 放量上涨 → 结构契合、红（多头可信）');
  ok(a.verdict.includes('涨放量、跌缩量') && a.verdict.includes('可信度高'), 'A 票文案含「涨放量跌缩量」与「可信度高」');
  const b = combine(0.6, '放量上涨');
  ok(b.alignment === 'diverge' && b.tone === 'warn', 'B 票 0.6 + 放量上涨 → 结构相反、琥珀警惕');
  ok(b.verdict.includes('涨缩量、跌放量') && b.verdict.includes('警惕诱多'), 'B 票文案含「涨缩量跌放量」与「警惕诱多」');
  ok(combine(1.7, '放量下跌').tone === 'warn' && combine(1.7, '放量下跌').verdict.includes('结构转弱'),
    '历史多头 + 今日下跌放量 → 警惕结构转弱（不是诱多）');
  ok(combine(0.6, '缩量上涨').alignment === 'match' && combine(0.6, '缩量上涨').tone === 'bear',
    '历史空头 + 上涨惜量 → 弱势延续（绿）');
  ok(combine(1.00, '放量上涨').tone === 'neutral' && combine(1.00, '放量上涨').verdict.includes('印证有限'),
    '≈1 均衡 → 中性，历史结构印证有限');
  ok(combine(1.7, '温和上涨').tone === 'neutral' && combine(1.7, '温和上涨').verdict.includes('印证有限'),
    '平量信号 → 中性，不下强结论');
  ok(combine(null, null).alignment === 'na' && combine(null, null).verdict.includes('数据不足'),
    '数据不足 → 诚实报无法比对，不编造结论');
}

section('§4b 真实数据组合：结论措辞不得与今日信号矛盾（20261106f 实测修正）');
{
  // 士兰微 600460 实时 API 组合：ratio=1.20、vp.signal=缩量回调。契合判定正确，
  // 但初版结论写死「放量上涨的可信度高」与今日实际信号矛盾 → 措辞改为中性并动态代入信号。
  const real = combine(1.2, '缩量回调');
  ok(real.alignment === 'match' && real.tone === 'bull', '1.20 + 缩量回调 → 下跌缩量与「跌缩量」习惯同侧，判契合');
  ok(real.verdict.includes('缩量回调') && !real.verdict.includes('放量上涨'), '契合结论代入真实信号，不写死「放量上涨」');
  ok(real.verdict.includes('本次量价信号的可信度高'), '契合措辞中性，可适配任意今日信号');
  const weak = combine(0.6, '缩量上涨');
  ok(!weak.verdict.includes('放量上涨当成反转') && weak.verdict.includes('别把单次放量当成反转'), '契合空头结论不写死「放量上涨」');
  const div = combine(0.6, '缩量回调');
  ok(!div.verdict.includes('今日却放量拉') && div.verdict.includes('偏向多头一侧'), '反向结论不写死「今日放量拉」');
  const div2 = combine(1.7, '缩量上涨');
  ok(!div2.verdict.includes('今日却下跌放量／上涨惜量') && div2.verdict.includes('偏向空头一侧'), '反向结论不写死下跌放量');
  const sigs = ['放量上涨', '量价齐升', '大涨平量', '温和上涨', '缩量上涨', '地量上涨', '巨量下跌',
    '放量下跌', '显著下跌', '温和回调', '缩量下跌', '缩量回调', '地量下跌', '地量回调', '量价平衡'];
  const bad = sigs.filter(s => !s.includes('放量上涨') && combine(1.7, s).verdict.includes('放量上涨'));
  ok(bad.length === 0, `全部 ${sigs.length} 种当日信号下结论均无「放量上涨」硬编码`);
}

section('§5 三档解读文案原样 + 参考表着色铁律（20261101f）');
{
  const p = panel(1.7, '放量上涨');
  ok(p.includes(V.esc('上涨日均量 > 下跌日均量')) && p.includes('上涨时花钱更多、放量拉；下跌时舍不得砸、缩量跌。'),
    '＞1 档文案原样（比较符按 HTML 转义输出）');
  ok(p.includes('典型多头偏好结构：放量上涨、缩量回调，是趋势票健康的量价特征。') && p.includes('1.8 倍'), '＞1 档含健康结构描述与 1.8 倍示例');
  ok(p.includes('多空出手体量差不多，涨也放量、跌也放量，震荡拉锯、分歧均衡，没有明显倾向性。'), '≈1 档文案原样');
  ok(p.includes(V.esc('上涨日均量 < 下跌日均量')) && p.includes('上涨惜量、拉不动；一旦下跌就放量出逃。') && p.includes('反弹容易是诱多'),
    '＜1 档文案原样（比较符按 HTML 转义输出）');
  ok((p.match(/cmi-hit-bull/g) || []).length === 1 && (p.match(/cmi-ref/g) || []).length === 2,
    '命中 ＞1 时仅该行方向色徽标，其余两行中性灰');
  ok(!p.includes('cmi-hit-bear') && !p.includes('cmi-hit-neutral'), '非命中档不带方向色');
  ok(p.includes('仅高亮行是当前命中判定'), '表下附「仅高亮行是当前命中判定」对照说明（铁律）');
  const pl = panel(0.6, '放量上涨');
  ok((pl.match(/cmi-hit-bear/g) || []).length === 1 && (pl.match(/cmi-ref/g) || []).length === 2, '命中 ＜1 时仅该行绿色徽标');
  const pe = panel(1.00, '放量上涨');
  ok((pe.match(/cmi-hit-neutral/g) || []).length === 1 && (pe.match(/cmi-ref/g) || []).length === 2, '命中 ≈1 时仅该行琥珀徽标');
}

section('§6 今日结合结论区与口径标注');
{
  const p = panel(1.7, '放量上涨');
  ok(p.includes('区分同是放量，结构好不好 · 结合今日量价关系判定'), '含用户「区分同是放量，结构好不好」小节');
  ok(p.includes('结构契合') && p.includes('可信度高'), '结论区含契合徽标与判定');
  ok(p.includes('近20日比值') && p.includes('今日量价信号') && p.includes('放量上涨'), '两枚事实卡显示比值与当日信号');
  ok(p.includes('A 票比值 1.7') && p.includes('B 票比值 0.6') && p.includes('要警惕诱多'), '对照示例完整（用户 A/B 票）');
  ok(p.includes('0.95~1.05 容差仅用于解读分档，不改变指标算法'), '≈1 容差仅解读分档、不改算法（诚实标注）');
  ok(p.includes('与「量价判定」⑤量价健康度同源') && p.includes('数值不应相等'), '标注同源口径与四套分母不应相等');
  ok(p.includes('成交量（手）比值'), '标注量能口径为成交量而非资金金额');
  ok(!panel(1.7, '<script>alert(1)</script>').includes('<script>'), '动态信号经 esc 转义，防注入');
}

section('§7 两条渲染路径 + 下拉交互 + 轮询状态恢复');
{
  const rowEnd = '</div>\n      ${interpretPanel}';
  ok(app.includes('cm-has-interpret') && app.includes('20日涨跌日量能比${interpretTrigger}'), 'app.js 卡片标签行内嵌触发器（不额外占高度）');
  ok(app.includes(rowEnd) || /\$\{volTierTile\}[\s\S]{0,900}\}\s*\$\{interpretPanel\}/.test(app), 'app.js 面板插在五联行下方、普通流跨整行');
  ok(app.indexOf('${interpretPanel}') < app.indexOf('class="cap-date-note"'), 'app.js 面板位于日期口径注释之前');
  ok(cc.includes('cm-has-interpret') && cc.includes('20日涨跌日量能比${interpretTrigger}'), 'capitalCharts.js 兼容路径同款触发器');
  ok(/\$\{interpretPanel\}\s*<div class="cap-date-note">/.test(cc), 'capitalCharts.js 面板位于指标行下方（同口径）');
  ok(app.includes("document.addEventListener('click'") && app.includes(".closest('.cm-interpret-trigger')"), 'document 级事件委托（兼容轮询重建）');
  ok(app.includes('row.nextElementSibling') && app.includes("removeAttribute('hidden')") && app.includes("setAttribute('hidden', '')"),
    '委托精确定位相邻面板并切换 hidden');
  ok(app.includes("trigger.setAttribute('aria-expanded'") && app.includes("trigger.classList.toggle('is-open'"), '同步 aria-expanded 与箭头状态（无障碍）');
  ok((app.match(/\.cm-interpret-panel:not\(\[hidden\]\)/g) || []).length >= 1
    && (cc.match(/\.cm-interpret-panel:not\(\[hidden\]\)/g) || []).length >= 1,
    '两条路径都在重建前读取展开状态（静默轮询不自动收起）');
  ok(panel(1.7, '放量上涨').includes(' hidden') && !panel(1.7, '放量上涨', true).includes(' hidden'),
    '面板默认收起、open:true 时展开');
  ok(app.includes('${interpretTrigger}') && !app.includes('vpRatioTile = `<details'), '未使用 details 浮层（避免撑破 ve-cols-5）');
}

section('§8 CSS 样式完整性（softDark + 红涨绿跌）');
for (const sel of ['.cm-interpret-trigger', '.cm-interpret-panel[hidden]', '.cm-interpret-panel {',
  '.cmi-badge', '.cmi-ref', '.cmi-hit-bull', '.cmi-hit-bear', '.cmi-hit-neutral',
  '.cmi-verdict', '.cmi-bull', '.cmi-bear', '.cmi-warn', '.cmi-neutral', '.cmi-caliber']) {
  ok(css.includes(sel), '样式存在：' + sel);
}
ok(css.includes('.cm-interpret-trigger:hover') && css.includes('.cm-interpret-trigger:active')
  && css.includes('.cm-interpret-trigger:focus-visible'), '交互状态齐全（hover / active / focus-visible）');
ok(css.includes('.cm-interpret-trigger::before') && css.includes('inset: -10px -4px'), '移动端透明扩展点击区，不改变布局');
ok(css.includes('@media (max-width: 768px)') && css.includes('.cmi-fact { flex-basis: 100%; }'), '窄屏响应式换行');
ok(!/\.cm-interpret-panel \{[^}]*position: absolute/.test(css), '面板为普通流，不受 .main-content 滚动容器裁剪');
ok(css.includes('color: var(--red)') && css.includes('color: var(--green)'), '方向色沿用全站 --red / --green（红涨绿跌）');
ok(app.includes('ve-cols-5') && css.includes('.ve-cols-5 { grid-template-columns: repeat(5, 1fr); }'), '五列等宽栅格未改动');

section('§9 零后端改动 / 版本戳 / 缓存破坏');
ok(ve.includes("schema: 'volume-engine-20261106p'"), '引擎 schema 未升（输出结构零变化）');
ok(sjd.includes("const LAYOUT_VERSION = '20261106o'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化，判断记录强制重算）');
ok(/const APP_VERSION = '20261106p'/.test(server), 'APP_VERSION = 20261106p');
ok(server.includes('[20261106f]'), 'server.js 存在 [20261106f] 独立变更日志条目');
ok(server.includes('[20261106e]') && server.includes('[20261106d]'), '功能引入版本号保留，未随全局升版误改（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261106p') && !html.includes('?v=20261106h'), `public/${f} 缓存戳全部对齐 20261106p`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
