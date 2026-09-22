// 测试长江证券（000783）专属估值卡片【前端渲染接线】（20260922e 补丁F）
// 手法：从真实 public/js/app.js 中切出「长江证券卡片」渲染块源码，注入 stub 后实际执行，
//       断言补丁F 的两个前端可见结果：① 顶部「🔴 估值体系重构警告」行醒目渲染 ② 区间标签不再硬编码。
const fs = require('fs');
const path = require('path');
const model = require('../lib/valuation/changjiang000783.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const MARK = '// ===== 20260908r：长江证券（000783）专属 PB-ROE 动态估值引擎卡片 =====';
const s = SRC.indexOf(MARK);
ok('已定位长江卡片渲染块', s !== -1);

const ifIdx = SRC.indexOf('if (j && j.dedicated && j.changjiang)', s);
const openIdx = SRC.indexOf('{', ifIdx);
let depth = 0, endIdx = -1;
for (let i = openIdx; i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
}
ok('已切出完整渲染块（括号闭合）', endIdx > openIdx);
const block = SRC.slice(openIdx + 1, endIdx);

// —— stub ——
const body = { innerHTML: '', classList: { add() { } } };
const dateEl = { textContent: '' };
const btn = { textContent: '' };
const doc = { getElementById: (id) => (id === 'valuationAiBtn' ? btn : null) };
const ctx = { escapeHtml: (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };

let html = '';
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function('j', 'body', 'dateEl', 'document', block);
  fn.call(ctx, model.run('000783', { price: 8.51 }), body, dateEl, doc);
  html = body.innerHTML;
} catch (e) {
  ok('渲染块执行无异常（' + e.message + '）', false);
}
ok('渲染块执行成功且产出 HTML', html.length > 500);

// —— 补丁F 前端可见结果 ——
ok('顶部输出「🔴 估值体系重构警告」行', html.indexOf('🔴 估值体系重构警告') !== -1);
ok('警告行带醒目样式 hook（vd-mat-warn / 淡红底）', html.indexOf('vd-mat-warn') !== -1 && html.indexOf('rgba(246,70,93,0.10)') !== -1);
ok('警告文案「历史分位失去参考意义」已渲染到页面', html.indexOf('历史分位失去参考意义') !== -1);
ok('警告行排在极端悲观行之前', html.indexOf('估值体系重构警告') < html.indexOf('极端悲观'));
ok('区间标签已动态化（补丁F 强制外扩）', html.indexOf('补丁F 强制外扩') !== -1);
ok('区间标签不再硬编码 1.33/1.40/1.50（仅注释残留）', html.indexOf('1.33/1.40/1.50') === -1);
ok('三档区间显示为 7.04 ~ 11.26', html.indexOf('¥7.04') !== -1 && html.indexOf('¥11.26') !== -1);
ok('卡片标题带版本戳 V2-patched-FG', html.indexOf('V2-patched-FG') !== -1);
ok('矩阵说明含负数下行空间 -17.27%', html.indexOf('-17.27%') !== -1);
ok('矩阵说明不含被截断的「下行空间 0%」', html.indexOf('下行空间 0%') === -1);

// —— 补丁F-Plus / 补丁G 前端可见结果（20260922f）——
ok('F-Plus①：极端悲观行仅下行空间、乐观行仅上行空间', html.indexOf('下行空间 -17.27%，未触及40%熔断线') !== -1 && html.indexOf('上行空间 +32.31%') !== -1);
ok('F-Plus①：基准行标注「本档不计空间」', html.indexOf('本档不计空间') !== -1);
ok('F-Plus②：SOTP 重归因「分部倍数穿透」已渲染', html.indexOf('【分部倍数穿透】') !== -1);
ok('F-Plus②：三类归因（泡沫/集团折价/残差）已渲染', html.indexOf('【① 分部估值泡沫】') !== -1 && html.indexOf('【② 集团折价】') !== -1 && html.indexOf('【③ 残差】') !== -1);
ok('F-Plus②：剔除泡沫后中枢 ¥11.25 已渲染', html.indexOf('SOTP 中枢将回落至 ¥11.25') !== -1);
ok('补丁G：常态（未触发下轨）不渲染防御提示条', html.indexOf('周期底部估值体系防御') === -1);
ok('补丁G：风险看板双轨行已渲染', html.indexOf('补丁G·动态锚双轨保护') !== -1);
// —— 补丁G 规则4：乐观复苏情景提示条（20260922g，双闸门满足时渲染）——
ok('补丁G·规则4：乐观复苏情景提示条已渲染', html.indexOf('🌟 乐观复苏情景（仅备注，不参与主模型）') !== -1);
ok('补丁G·规则4：提示条含长周期均值锚 1.33 倍 → ¥8.87', html.indexOf('长周期均值锚 1.33 倍') !== -1 && html.indexOf('¥8.87') !== -1);
ok('补丁G·规则4：提示条含双闸门说明（日均成交额 / ROE 持续上行）', html.indexOf('市场日均成交额') !== -1 && html.indexOf('ROE 持续上行') !== -1);
ok('补丁G·规则4：提示条声明不参与主模型', html.indexOf('不参与动态 PB 锚、三档区间与评级计算') !== -1);
ok('补丁G：风险看板新增乐观复苏情景闸门行', html.indexOf('补丁G·乐观复苏情景闸门') !== -1);

// —— 补丁G 触发态：手工构造 anchorFloorActive=true 的载荷再渲染 ——
const jG = model.run('000783', { price: 6.5 });
jG.patchG.anchorFloorActive = true;
const bodyG = { innerHTML: '', classList: { add() { } } };
let htmlG = '';
try {
  // eslint-disable-next-line no-new-func
  const fnG = new Function('j', 'body', 'dateEl', 'document', block);
  fnG.call(ctx, jG, bodyG, { textContent: '' }, doc);
  htmlG = bodyG.innerHTML;
} catch (e) { ok('补丁G 触发态渲染无异常（' + e.message + '）', false); }
ok('补丁G：触发态渲染出「周期底部估值体系防御」提示条', htmlG.indexOf('周期底部估值体系防御') !== -1);
ok('补丁G：提示条含规定文案「已触及近5年真实估值铁底（0.916倍）…静待均值回归」', htmlG.indexOf('已触及近5年真实估值铁底（0.916倍）') !== -1 && htmlG.indexOf('静待均值回归') !== -1);
ok('补丁G：提示条含估值底线价（近5年真实50%分位 0.916 → ¥6.11）', htmlG.indexOf('0.916') !== -1 && htmlG.indexOf('¥6.11') !== -1 && htmlG.indexOf('近5年真实50%分位') !== -1);
ok('补丁G：旧文案「不宜过度悲观」已彻底移除', htmlG.indexOf('不宜过度悲观') === -1 && html.indexOf('不宜过度悲观') === -1);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
