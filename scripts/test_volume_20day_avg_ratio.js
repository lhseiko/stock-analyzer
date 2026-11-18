#!/usr/bin/env node
/**
 * test_volume_20day_avg_ratio.js — 任务卡 #022 专项守卫
 * ================================================================
 * 新增「20日均量比」独立卡片（当日量 ÷ 前20日均量）置于量价四联行最左：
 *   ① 主链路 app.js：ve-cols-4 + r20Tile 居首 + 原三卡内容/顺序逐字不变；
 *   ② 兼容链路 capitalCharts.js：同款新卡 + ratio20Series 回退；
 *   ③ 解读面板 VpRatioInterpret：独立确定性三档（放量/平量/缩量），配对 id 开合；
 *   ④ 事件委托：带 id 走配对查找，无 id 走 nextElementSibling（首卡行为不变）；
 *   ⑤ 阈值与 lib/volumeCaliber.js 单一权威源同值；零 LLM、零数值估算。
 * 纯静态源码断言 + 沙箱执行 VpRatioInterpret 纯函数；零网络、零写盘。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
const app = src('public/js/app.js');
const cc = src('public/js/capitalCharts.js');
const css = src('public/css/style.css');
const cal = src('lib/volumeCaliber.js');

// 沙箱执行 capitalCharts.js 取 VpRatioInterpret（同页 UMD 暴露）
const sandbox = { module: { exports: {} }, window: {}, document: { addEventListener() {}, getElementById() { return null; } } };
new Function('module', 'exports', 'window', 'document', cc + '\n')(
  sandbox.module, sandbox.module.exports, sandbox.window, sandbox.document);
const V = sandbox.module.exports.VpRatioInterpret;

console.log('\n=== 1) 主链路 app.js：四联行 + 新卡居首 ===');
ok(/<div class="ve-tile-row ve-cols-4">\s*\$\{r20Tile\}\s*\$\{vpRatioTile\}/.test(app), '四联行 ve-cols-4，r20Tile 在 vpRatioTile 之前（最左）');
ok(app.includes('const r20Tile = `') && app.includes('20日均量比${r20Trigger}'), '新卡标签「20日均量比」带配对解读触发器');
ok(app.includes('当日量 ÷ 前20日均量'), '新卡 .cm-sub 副行写明分母口径');
{
  // 20261117f：app.js 存在两处 r20Val 取数（主路径 vp.unified / 引擎路径 vpVE.unified），
  // 两处都必须「unified.ratio20 优先 + series 回退」，任一处不得臆造口径。
  const vals = app.match(/const r20Val = [^\n]+/g) || [];
  ok(vals.length === 2, 'app.js 恰有两处 r20Val 取数（主路径 + 引擎路径）', '实际 ' + vals.length + ' 处');
  ok(vals.every(v => v.includes('unified') && v.includes('ratio20')), '两处取数均为 unified.ratio20 优先（判定层同源）');
}
ok(/const r20Cls = [^\n]*r20Val > 1\.3[^\n]*r20Val < 0\.8/.test(app), '新卡着色：>1.3 放量 / <0.8 缩量 / 区间中性');
ok(app.includes('${r20Panel}\n      ${interpretPanel}'), '新卡解读面板 + 首卡解读面板均挂在卡行下方');

console.log('\n=== 2) 原三卡内容零改动 ===');
ok(app.includes('const vpRatioTile = `<div class="cap-metric cm-has-interpret">'), '首卡 tile 结构原样');
ok(app.includes('近20日涨日均量 ÷ 跌日均量'), '首卡副行公式原样（未被新卡口径覆盖）');
ok(app.includes('20日涨跌日</span>') && app.includes('20日净涨跌</span>'), '另两卡标签原样');
ok(/<div class="ve-tile-row ve-cols-4">[\s\S]{0,900}\$\{vpRatioTile\}[\s\S]{0,400}20日涨跌日<\/span>[\s\S]{0,200}20日净涨跌<\/span>/.test(app), '原三卡相对顺序：涨跌日量能比 → 涨跌日 → 净涨跌');

console.log('\n=== 3) 兼容链路 capitalCharts.js 同步 ===');
ok(cc.includes('20日均量比${r20Trigger}') && cc.includes('当日量 ÷ 前20日均量'), '兼容路径新增同款新卡');
ok(/const r20Val = \(un20 && typeof un20\.ratio20 === 'number'\)[\s\S]{0,160}r20FromSeries/.test(cc), '兼容路径取数：unified.ratio20 优先，回退 ratio20Series 末值');
ok(cc.includes('${r20Panel}\n      ${interpretPanel}'), '兼容路径两个面板同挂');
ok(cc.includes('const interpretOpen = !!el.querySelector(\'.cm-interpret-panel[data-cm-interpret]:not([data-interpret-id]):not([hidden])\')'), '首卡展开状态读取排除带 id 的新卡面板（互不串开合）');

console.log('\n=== 4) 事件委托：配对 id + 首卡兼容 ===');
ok(app.includes('const pid = trigger.getAttribute(\'data-interpret-id\')'), '委托读取配对 id');
ok(app.includes('.cm-interpret-panel[data-interpret-id="${pid}"]'), '带 id 走配对面板查找');
ok(app.includes(': (row && row.nextElementSibling)'), '无 id 仍走 nextElementSibling（首卡零改动）');

console.log('\n=== 5) 解读面板纯函数（确定性 + 阈值 + 红涨绿跌） ===');
ok(typeof V.buildRatio20Panel === 'function' && typeof V.ratio20Band === 'function', '新解读函数已导出');
ok(V.R20_AMP === 1.3 && V.R20_SHRINK === 0.8, '阈值 1.3 / 0.8');
ok(cal.includes('const VOL_AMP = 1.3;') && cal.includes('const VOL_SHRINK = 0.8;'), '与 lib/volumeCaliber.js 权威源同值');
ok(V.ratio20Band(1.8).label.includes('放量') && V.ratio20Band(1.0).label.includes('平量') && V.ratio20Band(0.6).label.includes('缩量') && V.ratio20Band(null).label === '数据不足', '三档 + 缺值降级判定正确');
{
  const up = V.buildRatio20Panel(1.8, 2.5, { id: 'r20' });
  const down = V.buildRatio20Panel(1.8, -3.0, { id: 'r20' });
  const shrinkUp = V.buildRatio20Panel(0.6, 1.2, { id: 'r20' });
  const miss = V.buildRatio20Panel(null, null, {});
  ok(up.includes('data-interpret-id="r20"'), '面板带配对 id');
  ok(up.includes('放量上涨') && up.includes('cmi-bull'), '放量+收涨 → 放量上涨（利好红）');
  ok(down.includes('放量下跌') && down.includes('cmi-bear'), '放量+收跌 → 放量下跌（利空绿）');
  ok(shrinkUp.includes('缩量上涨') && shrinkUp.includes('cmi-warn'), '缩量+收涨 → 买盘不足警示（琥珀）');
  ok(miss.includes('数据不足') && miss.includes('无法做量能与价格的结合判断'), '缺值诚实降级、不编结论');
  ok(up === V.buildRatio20Panel(1.8, 2.5, { id: 'r20' }), '同输入逐字一致（确定性 core）');
  ok(/20日均量比 = 当日成交量 ÷ 前20日均量/.test(up), '解读面板写明新卡口径，非照抄首卡');
  ok(!up.includes('近20日上涨日均量 ÷ 下跌日均量'), '新卡解读不混入首卡口径');
}

console.log('\n=== 6) 样式与零 LLM ===');
ok(css.includes('.ve-cols-4 { grid-template-columns: repeat(4, 1fr); }'), '四列栅格样式已存在（复用，未新造布局）');
ok(css.includes('.cm-value .cm-sub') && css.includes('.cm-interpret-panel'), '副行与面板样式复用现有规范（等高宽一致）');
{
  const fi = cc.indexOf('function buildRatio20Panel');
  const fj = cc.indexOf('\n  }', fi);
  const fnBody = cc.slice(fi, fj + 4);
  ok(fi >= 0 && fnBody.length > 0 && !/fetch\(|LLM|gpt|qwen|openai/i.test(fnBody), '新解读函数体内零 LLM / 零外部请求');
}

console.log('\n=== 7) 实跑 renderVolumeEngine（回归 20261117f：vp 未定义导致模块空白） ===');
// 20261117f 教训：纯静态断言抓不到「引用了本函数不存在的变量」这类运行时错误——
// 必须真执行 renderVolumeEngine 才能证明「量能分析」模块不再渲染中断。
{
  const start = app.indexOf('  renderVolumeEngine(data) {');
  const end = app.indexOf('\n  },', start);
  ok(start >= 0 && end > start, '定位到 renderVolumeEngine 方法体');
  const snippet = '({' + app.slice(start, end + 5) + '})';
  const fakeEl = { querySelector: () => null, innerHTML: '' };
  const sandboxDoc = { getElementById: () => fakeEl, addEventListener() {} };
  const veStub = {
    ok: true, position: {}, dimensions: {},
    ratioGrid: { rows: [] }, steps: [], summary: {},
  };
  const payload = {
    volumeEngine: veStub,
    volumeIndicators: {
      volumePrice: { unified: { ratio20: 0.76 }, dayChangePct: 0 },
      series: { ratio20Series: [1.1, 0.9, 0.76] },
    },
  };
  let rendered = null, threw = null;
  try {
    const obj = new Function('VpRatioInterpret', 'document', 'return ' + snippet)(
      V, sandboxDoc);
    obj.renderVolumeEngine.call(
      { _veEsc: (s) => String(s == null ? '' : s).replace(/</g, '&lt;') },
      payload);
    rendered = fakeEl.innerHTML;
  } catch (e) { threw = e; }
  ok(threw === null, 'renderVolumeEngine 以真实 payload 实跑不抛错', threw ? threw.message : '');
  ok(!!rendered && rendered.includes('20日均量比'), '实跑输出含「20日均量比」新卡');
  ok(!!rendered && rendered.includes('0.76'), '实跑输出含 unified.ratio20 真实数值 0.76');
  ok(!!rendered && rendered.includes('data-interpret-id="r20"'), '实跑输出含配对解读面板');
}

try { fs.rmSync(path.join(ROOT, 'data', '.tmp-r20-unused'), { force: true }); } catch (_) { /* noop */ }

console.log('\n' + '='.repeat(56));
console.log(`===== 20日均量比新卡守卫：${pass} 通过 / ${fail} 失败 =====`);
if (fail) process.exit(1);
