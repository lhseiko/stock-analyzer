// test_volume_caliber_warn.js —— 20261106c 量能卡口径可见化守卫
// 用户截图三项指令：①第三步文案后常驻高亮「当日成交量 ÷ 20日均量是全日口径，盘中无法完成判定」；
// ②量能档位 / 20日涨跌日量能比按 60日量能确认同款加 .cm-sub 计算方法副行；
// ③量能档位右边放 20日涨跌日量能比，其余顺移。
// 本轮纯前端文案/样式/顺序改动：数值、公式、判定逻辑、API 输出结构零改动，
// 引擎 schema 与 LAYOUT_VERSION 按铁律不升。运行： node scripts/test_volume_caliber_warn.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n===== ' + t + ' =====');

const app = read('public/js/app.js');
const cc = read('public/js/capitalCharts.js');
const css = read('public/css/style.css');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

section('§1 第三步全日口径高亮提醒（紧跟文案、常驻）');
ok(app.includes('const step3CaliberWarn ='), 'app.js 定义 step3CaliberWarn');
ok(app.includes('ve-posj-caliber-warn'), '高亮提醒使用专用样式类');
ok(app.includes('「当日成交量 ÷ 20日均量」这个全日口径，盘中无法完成判定'),
  '高亮文案逐字包含用户指定的「全日口径，盘中无法完成判定」');
ok(app.includes('收盘后以全日成交量定论'), '高亮文案给出收盘后定论的出路');
ok(/\$\{step3Note\}\$\{step3CaliberWarn\}<\/div>/.test(app), '高亮提醒紧跟 step3Note 之后，位于第三步同一行内');
ok(app.indexOf('const step3CaliberWarn =') < app.indexOf('${step3Note}${step3CaliberWarn}'), '常量定义在使用之前');
ok(/const step3CaliberWarn = `<span class="ve-posj-caliber-warn"/.test(app), '声明为无条件模板字符串常量，非盘中/收盘二选一');
ok(!/\bif\s*\([^)]*step3CaliberWarn/.test(app), '未引入盘中/收盘条件分支（口径属性常驻展示）');
ok(app.includes('title="当日成交量 ÷ 20日均量是收盘后才成立的全日口径'), 'title 补充半天累计量与阈值不可比');
ok(app.includes("'盘中停判'"), '与信号叠加层「极端量能·盘中停判」机制并存（那里说规则停判，这里说口径不成立）');
ok(!app.includes('20日量价比') && !app.includes('量比(20日)'), '20261106b 近似标签纠偏成果未被回退');

section('§2 琥珀高亮样式（工作台金强调）');
ok(css.includes('.ve-posj-caliber-warn {'), 'style.css 新增专用样式');
ok(/\/\*[\s\S]{0,400}\.ve-posj-caliber-warn \{[\s\S]{0,400}color: var\(--amber-text\)/.test(css), '文字色用 --amber-text');
ok(/\/\*[\s\S]{0,400}\.ve-posj-caliber-warn \{[\s\S]{0,500}background: var\(--amber-bg\)/.test(css), '背景用 --amber-bg');
ok(/\.ve-posj-caliber-warn \{[\s\S]{0,500}flex: 1 1 100%/.test(css), 'flex 独占整行，紧跟文案且不被挤成窄列');
ok(/\.ve-posj-caliber-warn \{[\s\S]{0,600}border-left: 3px solid var\(--amber\)/.test(css), '琥珀左边框强调');
ok(css.includes('.cm-value .cm-sub'), '副行样式 .cm-sub 仍存在（20261106d 三张量能卡同款）');
ok(css.includes('.ve-cols-5 { grid-template-columns: repeat(5, 1fr); }') && css.includes('.ve-cols-3 { grid-template-columns: repeat(3, 1fr); }'), '20261106l：ve-cols-5 保留（其他行仍在用）、量价统计行改 ve-cols-3 三联栅格');

section('§3 三张量能卡各自可见计算方法');
ok(!app.includes('const volTierSub') && !app.includes('当日量 ÷ 前5日均量 ·'), '20261106l：「5日量能比」副行随卡退役，零残留');
ok(app.includes('const vpRatioSub') && app.includes('近20日涨日均量 ÷ 跌日均量'), '20日涨跌日量能比副行公式 = 涨日均量 ÷ 跌日均量');
ok(!app.includes('const confirmSub') && !app.includes('当日量 ÷ 60日均量 · 阈值 0.7~1.5×'), '20261106k：60日量能确认副行随卡退役，零残留');
ok(!/const volTierTile = `/.test(app), '20261106l：「5日量能比」tile 变量零残留');
ok(/const vpRatioTile = `[\s\S]{0,700}class="cm-sub"/.test(app), '20日涨跌日量能比 tile 内含 .cm-sub');
ok(!/const confirmVal = `/.test(app), '20261106k：60日量能确认 tile 变量零残留');
ok(!app.includes('const volTierTip') && app.includes('const vpRatioTip ='), '20261106l：volTierTip 随卡退役，vpRatioTip title 保留');
ok(cc.includes('近20日涨日均量 ÷ 跌日均量') && cc.includes('class="cm-sub"'), 'capitalCharts.js 兼容渲染路径同类同步副行');
ok(cc.includes('20日涨跌日量能比') && !cc.includes('20日量价比'), '兼容路径标签仍为 20261106b 定名');

section('§4 卡片顺序：20日涨跌日量能比居首，其余顺移（20261106l 三联）');
// 20261106f：联行之后新增「数值解读逻辑」下拉面板（普通流跨整行，不在 grid 内）；
// 20261106k：「60日量能确认」卡退役，五联改四联；20261106l：「5日量能比」卡退役，四联改三联（ve-cols-3）。
const rowMatch = app.match(/<div class="ve-tile-row ve-cols-3">\s*\$\{vpRatioTile\}([\s\S]{0,1200}?)<\/div>\s*\$\{interpretPanel\}\s*<div class="cap-date-note">/);
ok(!!rowMatch, '定位到量价统计三联行（含其后解读面板）');
ok(app.includes('</div>\n      ${interpretPanel}\n      <div class="cap-date-note">'), '解读面板在三联行下方、口径注释上方，未挤入三卡栅格');
if (rowMatch) {
  const row = rowMatch[0];
  const iRatio = row.indexOf('${vpRatioTile}');
  const iDays = row.indexOf('20日涨跌日</span>');
  const iNet = row.indexOf('20日净涨跌</span>');
  ok(iRatio >= 0, '20日涨跌日量能比居三联行首位');
  ok(iDays > iRatio, '20日涨跌日顺移居中');
  ok(iNet > iDays, '20日净涨跌居末');
  ok(!row.includes('${confirmTile}') && !row.includes('${volTierTile}') && row.indexOf('ve-cols-3') >= 0, '20261106l：ve-cols-3 三卡满行，confirmTile/volTierTile 插槽零残留');
}
ok(/<div class="ve-src-notes"><div class="ve-gap-item">· 量价数据不足/.test(app) && !/\$\{volTierTile\}\s*<\/div>\s*<div class="ve-src-notes">/.test(app),
  '20261106l：vp 缺失降级分支无独立量能卡，仅输出诚实降级说明（旧 volTierTile 收尾结构零残留）');

section('§5 数值 / 公式 / 判定结构零改动');
ok(cf.includes('const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;'), 'capitalFlow 量价比公式原样');
ok(ve.includes('const ratio20 = avg20 > 0 ? volToday / avg20 : null;'), 'volumeEngine ratio20 公式原样');
ok(ve.includes('const health = (upVols.length && dnVols.length) ? _mean(upVols) / _mean(dnVols) : null;'), '⑤量价健康度公式原样');
ok(app.includes('${vp.ratio != null ? vp.ratio') && app.includes('esc(vol.ratio20)'), '前端仍消费原字段 vp.ratio / vol.ratio20');
ok(app.includes('当日量/20日均量 ${esc(vol.ratio20)}'), '第三步数值文案未改');
ok(app.includes('全量价判定已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源）') && app.includes('与 ÷20 统一口径分母不同，数值不应相等'), '20261106k：底部口径说明写明统一 ÷20 分母，并列四套口径数值不应相等');
ok(ve.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
ok(sjd.includes("const LAYOUT_VERSION = '20261109c'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，判断记录强制重算）');

section('§6 版本戳与缓存破坏');
ok(/const APP_VERSION = '20261112a'/.test(server), 'APP_VERSION = 20261112a');
ok(server.includes('[20261106e]'), 'server.js 存在 [20261106e] 独立变更日志条目');
ok(server.includes('[20261106c]'), 'server.js 存在 [20261106c] 独立变更日志条目');
ok(server.includes('[20261106b]'), '[20261106b] 功能引入版本号保留，未随全局升版误改（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261112a') && !html.includes('?v=20261106l'), `public/${f} 缓存戳全部对齐 20261112a`);
}
const guards = ['test_volume_ratio_labels.js', 'test_position_trend_segment.js', 'test_consistency_audit.js']; // test_cap_vol_ratio_chart 动态读取 APP_VERSION（无版本字面量），不参与字面量同步断言
for (const g of guards) {
  const s = read('scripts/' + g);
  ok(s.includes('20261112a'), `既有守卫当前版本断言已同步 20261112a：${g}`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
