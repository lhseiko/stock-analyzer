// test_volume_ratio_labels.js —— 量比口径文案纠偏守卫（20261106b 定版）
// 用户报障：同屏「20日量价比 1.19」与「量比(20日) 1.07」被读成同一指标。
// 根因=两个不同公式却共用近似标签；本轮只改文案与口径说明，数值/判定逻辑零改动。
// 运行： node scripts/test_volume_ratio_labels.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n===== ' + t + ' =====');

const app = read('public/js/app.js');
const cc = read('public/js/capitalCharts.js');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

section('§1 卡片标签改名（所有同类渲染路径）');
ok(app.includes('20日涨跌日量能比'), 'app.js 指标卡标签 = 20日涨跌日量能比');
ok(!app.includes('20日量价比'), 'app.js 不再出现易混淆旧标签「20日量价比」');
ok(cc.includes('20日涨跌日量能比'), 'capitalCharts.js 兼容渲染路径同步改名');
ok(!cc.includes('20日量价比'), 'capitalCharts.js 不再出现旧标签');
ok(app.includes('title="近20日上涨日均量 ÷ 下跌日均量'), 'app.js 卡片标签带公式说明');
ok(cc.includes('title="近20日上涨日均量 ÷ 下跌日均量'), 'capitalCharts.js 标签带同一公式说明');

section('§2 第三步文案与底部口径注释');
ok(app.includes('当日量/20日均量 ${esc(vol.ratio20)}'), '第三步 note 改为「当日量/20日均量」');
ok(!app.includes('量比(20日)'), '第三步不再出现「量比(20日)」字样');
ok(app.includes('title="当日成交量 ÷ 前20日均量'), '第三步 note 带公式与盘中提示');
ok(app.includes('近20日上涨日均量 ÷ 下跌日均量'), '底部注释显式写出 20日涨跌日量能比公式');
ok(!app.includes('「5日量能比」= 当日量 ÷ 前5日均量') && app.includes('「5日量能比」「60日量能确认」已退役'), '20261106l：「5日量能比」卡退役，底部口径说明不再列其公式并注明 ÷5 口径去向（顶部「量比」）');
ok(!app.includes('「60日量能确认」= 当日量 ÷ 60日均量'), '20261106k：「60日量能确认」卡退役，底部注释不再列其公式');
ok(app.includes('全量价判定已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源）') && app.includes('「20日涨跌日量能比」= 近20日上涨日均量 ÷ 下跌日均量') && app.includes('数值不应相等'), '20261106k：列出统一 ÷20 主口径 + 原始指标卡并写明数值不应相等');
ok(app.includes('60 日均量口径整体退役') && app.includes('全量价判定与文字分析统一使用 20 日量能比'), '20261106n：口径说明披露 60 日口径整体退役、文字分析统一 ÷20');
ok(!app.includes('量比与量能档位同源，不重复展示'), '移除口径错位的旧注释');
ok(!app.includes('>5日量能比</span>') && !app.includes('>60日量能确认</span>'), '20261106l：「5日量能比」与「60日量能确认」卡均已退役');
ok(!app.includes('>量能档位</span>') && !app.includes('>20日量能比</span>'), '旧卡名与临时 20日量能比零残留');

section('§3 数值与判定逻辑零改动（本次只动文案）');
ok(cf.includes('const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;'), 'capitalFlow 量价比公式原样保留（涨日均量 ÷ 跌日均量）');
ok(ve.includes('const ratio20 = avg20 > 0 ? volToday / avg20 : null;'), 'volumeEngine ratio20 公式原样保留（当日量 ÷ 20日均量）');
ok(ve.includes('const health = (upVols.length && dnVols.length) ? _mean(upVols) / _mean(dnVols) : null;'), '⑤量价健康度公式原样保留');
ok(app.includes('${vp.ratio != null ? vp.ratio') && app.includes('esc(vol.ratio20)'), '前端仍消费原字段 vp.ratio / vol.ratio20，未换数据源');
ok(ve.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
ok(sjd.includes("const LAYOUT_VERSION = '20261109c'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，判断记录强制重算）');

section('§4 版本戳与缓存破坏');
ok(/const APP_VERSION = '20261111d'/.test(server), 'APP_VERSION = 20261111d');
ok(server.includes('[20261106b]'), 'server.js 存在 [20261106b] 独立变更日志条目');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261111d') && !html.includes('?v=20261106l'), `public/${f} 缓存戳全部对齐 20261111d`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
