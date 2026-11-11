/**
 * 20261106h：量价判定卡布局回滚守卫（功能引入戳，不随全局版本升级）
 * 运行：node scripts/test_posj_symmetry.js
 *
 * 背景：20261106g 纯 CSS「对称化」把 .ve-posj-chain-item 改成 28px 双列栅格，
 * 但 .ve-rule-badge 里装的是「① 道氏结构 / ⑤ 量价健康度」等中文标签，被压到 28px 后
 * 逐字竖排，用户截图判定「界面优化完全失败」。本轮整块撤销覆盖规则、恢复 flex 基线，
 * 只保留三处零风险修正。本守卫把「真实 DOM 徽标是中文标签」固化为断言，防止复发。
 *
 * 本轮纯样式改动：文案 / 数值 / 数据来源标注 / 方向色语义 / 后端 / API 输出结构零改动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = t => console.log('\n===== ' + t + ' =====');

const css = read('public/css/style.css');
const app = read('public/js/app.js');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

section('§1 g 版失败覆盖块已整块撤销');
ok(css.includes('20261106h：20261106g 对称化覆盖块已整块撤销'), 'style.css 保留事故留档说明（功能引入戳，不随全局版本升级）');
ok(!css.includes('grid-template-columns: 132px 120px minmax(0, 1fr)'), '三步骤三列栅格覆盖已移除');
ok(!css.includes('.ve-posj-chain-item { display: grid; grid-template-columns: 28px'), '28px 中文徽标栅格已移除（事故根因）');
ok(!css.includes('position: absolute; left: 12px; top: 10px; width: 112px'), '绝对定位左栏标题已移除');
ok(!css.includes('.ve-posj-table { table-layout: fixed;'), '参考表固定列宽覆盖已移除');
ok(!css.includes('.ve-posj-chain::before'), '判定链竖分隔线伪元素已移除');
ok((css.match(/{/g) || []).length === (css.match(/}/g) || []).length, 'CSS 大括号配平（无语法断裂）');
ok(/\.ve-posj-chain-item \{ display: flex;/.test(css), '判定链恢复 20261105f-b 的 flex 基线');

section('§2 真实 DOM：徽标装的是中文标签，宽度不得被压窄（事故根因固化）');
for (const label of ['① 道氏结构', '② ADX 强度', '③ 均线排列', '④ 箱体量化', '⑤ 量价健康度']) {
  ok(ve.includes(`k: '${label}'`), `_runState.steps.k 含中文标签 ${label}`);
}
ok(app.includes('class="ve-rule-badge ${s.hit'), 'app.js 把 steps.k 渲染进 .ve-rule-badge');
ok(app.includes('${esc(s.k)}'), '徽标内容取自 steps.k（不是硬编码数字）');
const badgeRule = (css.match(/\.ve-posj-chain-item > \.ve-rule-badge \{([^}]*)\}/) || [])[1] || '';
ok(/flex:\s*0 0 96px/.test(badgeRule), '徽标固定 96px，足够容纳「⑤ 量价健康度」');
ok(/white-space:\s*nowrap/.test(badgeRule), '徽标强制不换行，永久防止中文逐字竖排');
const itemRules = (css.match(/\.ve-posj-chain-item \{[^}]*\}/g) || []).join('');
ok(!/grid-template-columns:\s*28px/.test(itemRules), '判定链 item 不再使用 28px 栅格');
ok(css.includes('flex: 1; }') && css.includes('.ve-posj-chain-text'), '内容区占满剩余宽度，5 行文本左边界统一');

section('§3 只保留零风险对齐修正');
const chainRule = (css.match(/\.ve-posj-chain \{([^}]*)\}/) || [])[1] || '';
ok(/margin:\s*6px 0 2px 0/.test(chainRule) && !chainRule.includes('140px'),
  '判定链 margin 左右对称，单侧 140px 缩进已取消');
ok(!css.includes('margin: 6px 0 2px 140px'), '旧的「左凹右满」margin 声明已不存在');
const narrowMedia = (css.match(/@media \(max-width: 768px\) \{[\s\S]{0,420}?\.ve-posj-chain-item > \.ve-rule-badge \{ flex: 0 0 auto; \}[\s\S]{0,300}?\}/) || [])[0] || '';
ok(narrowMedia.includes('flex: 1 1 100%'), '窄屏说明文字独占整行，避免右侧裁切');
ok(css.includes('@media (max-width: 768px) {\n  .ve-posj-chain-item > .ve-rule-badge { flex: 0 0 auto; }'),
  '窄屏徽标回落自然宽度');

section('§4 内容 / 数值 / 后端零改动（样式与内容解耦铁律）');
// 20261106i 轮确实改了 app.js / capitalCharts.js / posModel135.js 的文案（方案 C 统一结论展示），
// 故「JS 文件不含本轮版本号」的旧断言已不适用；改为断言 h 轮 CSS 修复成果未被文案改造误伤。
ok(css.includes('flex: 0 0 96px; white-space: nowrap') && !css.includes('margin: 6px 0 2px 140px'),
  'h 轮回滚成果在 i 轮文案改造后仍完整保留（样式零回退）');
ok(app.includes('<div class="ve-posj-step"><span class="ve-posj-step-label">第一步 · 位置定位</span>'),
  '三步骤 DOM 结构原样');
ok(app.includes('注意：「当日成交量 ÷ 20日均量」这个全日口径，盘中无法完成判定，收盘后以全日成交量定论'),
  '第三步口径警示文案原样');
ok(app.includes('<div class="ve-posj-chain">') && app.includes('运行状态 · 五步判定链'),
  '五步判定链 DOM 与标题原样');
ok(app.includes('<th>参考锚点</th><th>状态</th><th>说明</th>'), '参考锚点表三列表头原样');
ok(css.includes('.ve-posj-main.bull { border-left-color: var(--red); }')
  && css.includes('.ve-posj-main.bear { border-left-color: var(--green); }'), '主判方向色仍为红涨绿跌');
ok(ve.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
ok(sjd.includes("const LAYOUT_VERSION = '20261109c'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化，判断记录强制重算）');

section('§5 版本戳 / 缓存破坏');
ok(/const APP_VERSION = '20261111d'/.test(server), 'APP_VERSION = 20261111d');
ok(server.includes('[20261106i]'), 'server.js 存在 [20261106i] 独立变更日志条目');
ok(server.includes('[20261106g]') && server.includes('[20261106f]'),
  '功能引入版本号保留，未随全局升版误改（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261111d') && !html.includes('?v=20261106h'), `public/${f} 缓存戳全部对齐 20261111d`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
