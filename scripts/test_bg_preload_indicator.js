// 验证全局后台预加载指示器 bgPreload（从 app.js 抽取真实源码，用最小 DOM stub 跑逻辑）
// 覆盖：start 显示并列出分页；多分页并发；finish 全部完成后隐藏。
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
// 抽取 const bgPreload = { ... };（紧跟 // 关键指标释义 注释之前）
const startIdx = app.indexOf('const bgPreload = {');
const endMarker = app.indexOf('// 关键指标释义');
const block = app.slice(startIdx, endMarker).trim();
if (!block.endsWith('};')) throw new Error('抽取失败：未以 }; 结尾');
const src = block.replace(/^const\s+bgPreload\s*=\s*/, '').replace(/;\s*$/, '');

// 最小 DOM stub
let appended = [];
const navEl = { appendChild: (el) => appended.push(el) };
const doc = {
  querySelector: (sel) => (sel === '.global-nav' ? navEl : null),
  createElement: () => ({ id: '', style: {}, _text: '' , set textContent(v){this._text=v;}, get textContent(){return this._text;} }),
  body: { contains: () => true },
};
global.document = doc;

const bgPreload = eval('(' + src + ')');
if (typeof bgPreload !== 'object' || !bgPreload.start) throw new Error('bgPreload 解析失败');

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log('✅ ' + l); } else { fail++; console.log('❌ ' + l); } };

// 1) 单分页 start → 显示 + 文案
bgPreload.start('深度分析/财报解读');
const pill = appended[0];
ok('start 后指示器可见', pill.style.display === 'inline-block');
ok('文案包含预加载标签', /后台预加载/.test(pill.textContent));
ok('文案包含分页名', pill.textContent.includes('深度分析/财报解读'));

// 2) 多分页并发 → 文案列出全部
bgPreload.start('资金量能');
bgPreload.start('行业分析');
ok('并发多分页全部列出', pill.textContent.includes('资金量能') && pill.textContent.includes('行业分析'));

// 3) finish 部分 → 仍可见、剩余列出
bgPreload.finish('深度分析/财报解读');
ok('部分完成后仍可见', pill.style.display === 'inline-block');
ok('文案已移除已完成项', !pill.textContent.includes('深度分析/财报解读') && pill.textContent.includes('资金量能'));

// 4) 全部完成 → 隐藏
bgPreload.finish('资金量能');
bgPreload.finish('行业分析');
ok('全部完成后隐藏', pill.style.display === 'none');

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
