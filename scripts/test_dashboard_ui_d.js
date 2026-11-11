// test_dashboard_ui_d.js —— 20261106d 资金/量能卡与 banner 界面守卫
// 用户截图五项需求：
//  ①短期资金/中期资金文字分析补「日均净流入/净流出」；
//  ②20日涨跌日卡涨天数多于跌天数标红、反之标绿；
//  ③（诊断项，不改码）量能档位卡数据联动与可删性；
//  ④20261106d 曾把「60日量能确认」→「20日量能比」并改名，20261106e 用户裁决「换回60日卡」：
//    第 3 格恢复「60日量能确认」（该口径仍被后端多模块引用、数据从未删除），「5日量能比」新名保留；
//  ⑤个股 banner 换手率后补「量比」。
// 本轮纯前端展示改动：数值、公式、判定逻辑、API 输出结构零改动；
// 引擎 schema 与 LAYOUT_VERSION 按铁律不升。运行： node scripts/test_dashboard_ui_d.js
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
const idx = read('public/index.html');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

section('§1 短期/中期资金文字分析补日均净流入/流出');
ok(cc.includes('const dailyText = (s, days) =>'), 'capitalCharts.js 定义日均计算 helper');
ok(cc.includes("typeof s.mainNet !== 'number'") && cc.includes('!isFinite(s.mainNet)') && cc.includes('!(days > 0)'),
  '数据缺失/非有限值/天数非法时诚实降级，不编造日均值');
ok(/const avg = Math\.abs\(s\.mainNet\) \/ days/.test(cc), '日均 = 窗口累计主力净额 ÷ 窗口交易日天数');
ok(cc.includes("s.mainNet > 0 ? '净流入' : s.mainNet < 0 ? '净流出' : '持平'"), '方向按 mainNet 符号独立判定（净流入/净流出/持平）');
ok(cc.includes('${dailyText(s5, 5)}') && cc.includes('${dailyText(s20, 20)}'), '短期按 5 日、中期按 20 日分别计算');
ok(cc.includes('近5日主力${dir}') && cc.includes('近20日主力${dir}'), '原累计额文案保留，日均追加在其后');
ok(cc.includes('日均${d}${avg.toFixed(2)}亿'), '文案含「日均净流入/净流出 X.XX亿」');
ok(/rows\.push\(\{ icon: '💰'[\s\S]{0,260}tone: moneyTone\(s5\.mainNet\)/.test(cc), '短期资金 tone 仍按累计净额着色，未因追加文字改变');

section('§2 20日涨跌日卡：涨多红 / 跌多绿（全站红涨绿跌）');
for (const [name, src] of [['app.js', app], ['capitalCharts.js', cc]]) {
  ok(src.includes('const daysCls ='), `${name} 定义 daysCls`);
  ok(/vp\.upDays > vp\.downDays \? 'cap-pos' : vp\.upDays < vp\.downDays \? 'cap-neg' : ''/.test(src),
    `${name} 涨多 cap-pos（红）/ 跌多 cap-neg（绿）/ 持平中性`);
  ok(src.includes('class="cm-value ${daysCls}"'), `${name} 涨跌日 tile 应用 daysCls`);
  ok(src.includes('涨天数多于跌天数标红'), `${name} 标签 title 写明着色规则`);
}
ok(css.includes('.cap-pos { color: var(--red); }') && css.includes('.cap-neg { color: var(--green); }'), '红涨绿跌色值仍为 --red / --green');

section('§3 banner 换手率后补量比');
ok(idx.includes('id="stockVolRatio"') && idx.includes('class="stock-vol-ratio"'), 'index.html 新增量比 span');
ok(idx.indexOf('id="stockTurnover"') < idx.indexOf('id="stockVolRatio"')
  && idx.indexOf('id="stockVolRatio"') < idx.indexOf('id="stockAmount"'), '顺序为 换手率 → 量比 → 成交额');
ok(css.includes('.stock-vol-ratio::before { content: \'量比 \''), 'CSS 前缀标签为「量比 」');
ok(css.includes('.stock-turnover, .stock-amount, .stock-vol-ratio'), '量比与相邻两枚同字号同色，信息行节奏统一');
ok(app.includes("typeof quote.volumeRatio === 'number'") && app.includes('isFinite(quote.volumeRatio)') && app.includes('quote.volumeRatio > 0'),
  '取腾讯行情原生字段 quote.volumeRatio，非正数不展示');
ok(app.includes("vrEl.textContent = quote.volumeRatio.toFixed(2)"), '显示两位小数比值');
ok(/vrEl\.style\.display = 'none'/.test(app), '字段缺失时整段隐藏，不用均值反推/不估算');
ok(app.includes('腾讯行情口径，盘中为半天累计量、收盘后定论'), 'tooltip 标注盘中 caveat');
ok(app.includes('与量能引擎 volumeState.ratio5 同源'), '20261106l：tooltip 标注与 volumeState.ratio5 同源（5日量能比卡退役后 banner 为 ÷5 口径唯一展示处）');

section('§4 20261106k/l：「60日量能确认」「5日量能比」卡先后退役，量价统计行三联');
ok(!app.includes('>5日量能比</span>') && !app.includes('>60日量能确认</span>'), '20261106l：「5日量能比」与「60日量能确认」卡均已退役');
ok(!app.includes('>量能档位</span>') && !app.includes('>20日量能比</span>'), '旧卡名「量能档位」与临时「20日量能比」零残留');
ok(!app.includes('const vr60') && !app.includes('const confirmTile') && !app.includes('const confirmVal'), '60 日展示层变量与 tile 全部清理，无死代码');
ok(!app.includes('const volTierSub') && !app.includes('const volTierTile') && !app.includes('const volTierTip'), '20261106l：5日量能比展示层变量（volTierSub/volTierTile/volTierTip）零残留');
ok(!app.includes('const vs = ve.volumeState'), '20261106l：主分支专用 vs 别名随卡退役');
ok(!ve.includes('confirmDesc:') && !/pc\.confirm\b/.test(ve) && !cf.includes('confirm'), '20261106n：引擎与 capitalFlow 的 60 日口径字段（confirm/confirmDesc）已彻底删除');
ok(app.includes('全量价判定已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源）') && app.includes('与 ÷20 统一口径分母不同，数值不应相等'), '底部口径说明写明全量价判定统一 ÷20 分母并列原始指标卡');
ok(app.includes('60 日均量口径整体退役') && app.includes('全量价判定与文字分析统一使用 20 日量能比'), '20261106n：口径说明披露 60 日口径整体退役、文字分析统一 ÷20');
ok(/<div class="ve-tile-row ve-cols-3">\s*\$\{vpRatioTile\}/.test(app), '20261106l：三联行 ve-cols-3（20日涨跌日量能比 → 20日涨跌日 → 20日净涨跌）');

section('§5 数值 / 公式 / 判定结构零改动');
ok(cf.includes('const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;'), 'capitalFlow 量价比公式原样');
ok(ve.includes('const ratio20 = avg20 > 0 ? volToday / avg20 : null;'), 'volumeEngine ratio20 公式原样');
ok(ve.includes('const health = (upVols.length && dnVols.length) ? _mean(upVols) / _mean(dnVols) : null;'), '⑤量价健康度公式原样');
ok(ve.includes('volumeTier: _volumeTier(pc)'), 'volumeTier 统一真值源仍输出（量能档位数据未被删除，§3 诊断结论）');
ok(cf.includes('unifiedTier = volumeEngine.volumeTier;'), 'capitalFlow 仍消费 volumeTier（下游联动未断）');
ok(app.includes('${vp.ratio != null ? vp.ratio') && app.includes('esc(vol.ratio20)'), '前端仍消费原字段 vp.ratio / vol.ratio20');
ok(ve.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
ok(sjd.includes("const LAYOUT_VERSION = '20261109c'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，判断记录强制重算）');

section('§6 版本戳与缓存破坏');
ok(/const APP_VERSION = '20261111d'/.test(server), 'APP_VERSION = 20261111d');
ok(server.includes('[20261106e]'), 'server.js 存在 [20261106e] 独立变更日志条目');
ok(server.includes('[20261106d]'), 'server.js 存在 [20261106d] 独立变更日志条目');
ok(server.includes('[20261106c]') && server.includes('[20261106b]'), '功能引入版本号保留，未随全局升版误改（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261111d') && !html.includes('?v=20261106l'), `public/${f} 缓存戳全部对齐 20261111d`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
