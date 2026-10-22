/**
 * 自选股「点一次就切换个股」与切股反馈 · 行为回归（零网络、零浏览器）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_switch_stock.js
 *
 * 用户报障原文（20261022i）：
 *   「图片内的个股需要多次点击后才能切换到个股页面，系统反应缓慢，检查。」
 *
 * 定位到的四个成因，本文件逐条守住：
 *   [A] showLoading(text) 丢弃文字 → 切股 2~4 秒内屏幕毫无提示（用户以为没点上）
 *   [B] 每次点击都重发请求，旧请求被 token 丢弃 → 连点等于不断重置读条，越点越慢
 *   [C] 行默认 draggable="true"，指针轻微移动即进 HTML5 拖拽 → **click 事件被吞**
 *   [D] 60s 定时刷新整体 innerHTML 重建（注释却说只更新价格单元）→ 重置滚动/悬浮、可能吃掉点击
 *
 * 覆盖：加载真实 public/js/app.js（stub 掉浏览器依赖），直接驱动 App 的事件处理器。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---------------- 最小 DOM 桩 ----------------
function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add(...cs) { cs.forEach(c => set.add(c)); },
    remove(...cs) { cs.forEach(c => set.delete(c)); },
    contains(c) { return set.has(c); },
    toggle(c, on) { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
  };
}

// 可按 id 定制的元素表（测试里按需注入）
const elMap = {};
function makeEl(id) {
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    offsetWidth: 100,
    classList: makeClassList(),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  return el;
}

const listenersOnDoc = {};
global.document = {
  getElementById: (id) => (elMap[id] !== undefined ? elMap[id] : null),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: (t, fn) => { (listenersOnDoc[t] = listenersOnDoc[t] || []).push(fn); },
  createElement: () => makeEl('tmp'),
  body: { classList: makeClassList(), appendChild() {} },
  documentElement: { classList: makeClassList() },
};
global.window = global;
global.window.addEventListener = () => {};
global.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.location = { href: 'http://127.0.0.1:3005/?symbol=600519', search: '', pathname: '/', hash: '' };
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
global.Event = class { constructor(t) { this.type = t; } };

// fetch 桩：可控计次 + 手动放行
const fetchState = { calls: [], pending: [] };
global.fetch = (url, opt) => {
  fetchState.calls.push(String(url));
  return new Promise((resolve) => {
    fetchState.pending.push({ url: String(url), resolve });
  });
};
function releaseAll(payload) {
  const q = fetchState.pending.splice(0, fetchState.pending.length);
  q.forEach(p => p.resolve({ ok: true, json: async () => payload, text: async () => JSON.stringify(payload) }));
}

// 被 app.js 直接引用的外部模块（在这里桩掉，避免 ReferenceError）
global.Storage = {
  getWatchlist: () => [],
  addToHistory() {},
  initWatchlist: async () => {},
  getGroups: () => [],
};
global.DocStore = { setStock() {}, onTabSwitch() {} };
global.DeepCharts = { disposeAll() {} };
global.Notes = undefined;
global.echarts = { init: () => ({ setOption() {}, dispose() {}, on() {}, getZr: () => ({ on() {}, off() {} }) }), registerTheme() {} };

// ---------------- 加载真实 app.js ----------------
// 注意：本文件同时用到 require 与顶层 await，Node 22 会因模块格式歧义报错，
// 因此整段测试逻辑包进一个 async IIFE 里执行（等价于 CommonJS + 异步 main）。
(async () => {

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
// 文件末尾的 DOMContentLoaded 注册在上面 document.addEventListener 桩里被记录，不会真正 init
const App = new Function(`${src}; return App;`)();

const tick = () => new Promise(r => setTimeout(r, 0));

// ============================================================================
// [A] showLoading 必须把文字显示出来
// ============================================================================
console.log('\n[A] showLoading 的文字反馈');
elMap.topProgressBar = makeEl('topProgressBar');
elMap.loadingPill = makeEl('loadingPill');
App.showLoading('正在加载 贵州茅台…');
ok(elMap.loadingPill.textContent === '正在加载 贵州茅台…',
  `loadingPill 收到文字（实际 "${elMap.loadingPill.textContent}"）`);
ok(elMap.loadingPill.classList.contains('on'), 'loadingPill 已显示（.on）');
ok(!elMap.loadingPill.classList.contains('hidden'), 'loadingPill 未处于 hidden');
ok(elMap.topProgressBar.classList.contains('active'), '顶部进度条同时在跑（原行为保留）');
App.showLoading('连接中断，正在自动重连（1/2）…');
ok(elMap.loadingPill.textContent.includes('重连'), '再次调用会更新文字（重连提示可复用同一胶囊）');
App.hideLoading();
ok(!elMap.loadingPill.classList.contains('on'), 'hideLoading 后胶囊淡出（移除 .on）');
await new Promise(r => setTimeout(r, 260));
ok(elMap.loadingPill.classList.contains('hidden'), '淡出结束后挂 hidden');
delete elMap.topProgressBar; delete elMap.loadingPill;

// ============================================================================
// [B] analyze 同股在飞去重：连点不再重发请求
// ============================================================================
console.log('\n[B] analyze 同股在飞去重');
fetchState.calls.length = 0;
App.analyze('600519', '贵州茅台');          // 第一次：应发请求
await tick();
ok(fetchState.calls.length === 1, `首次点击发出 1 个请求（实际 ${fetchState.calls.length}）`);
ok(fetchState.calls[0].includes('/api/analysis/600519'), '请求地址指向 600519');

App.analyze('600519', '贵州茅台');          // 连点 1
App.analyze('600519', '贵州茅台');          // 连点 2
await tick();
ok(fetchState.calls.length === 1, `连点两次不再重发（仍为 1 个请求，实际 ${fetchState.calls.length}）——修掉"越点越慢"`);

App.analyze('000001', '平安银行');          // 换一只：必须放行
await tick();
ok(fetchState.calls.length === 2, `切到另一只股票正常发请求（实际 ${fetchState.calls.length}）`);
ok(fetchState.calls[1].includes('/api/analysis/000001'), '第二个请求指向 000001');

App.analyze('600519', '贵州茅台', 0, { force: true });   // force 强刷：必须放行
await tick();
ok(fetchState.calls.length === 3, `force:true（刷新按钮/换范围）能突破去重（实际 ${fetchState.calls.length}）`);

// 放行所有请求（返回 error 让流程干净收尾，不触发 renderDashboard）
releaseAll({ error: '测试桩：不渲染' });
await new Promise(r => setTimeout(r, 30));
ok(App._inflightTokens['600519'] === undefined, '请求结束后在飞标记已清理（600519）');
ok(App._inflightTokens['000001'] === undefined, '请求结束后在飞标记已清理（000001）');

// 清干净后再点同一只：应能重发（证明去重不会永久锁死）
fetchState.calls.length = 0;
App.analyze('600519', '贵州茅台');
await tick();
ok(fetchState.calls.length === 1, `上一笔结束后可再次请求同一只股票（实际 ${fetchState.calls.length}）`);
releaseAll({ error: '测试桩' });
await new Promise(r => setTimeout(r, 30));

// ============================================================================
// [C] 自选股行：click 被拖拽吞掉时，pointerup 兜底导航
// ============================================================================
console.log('\n[C] 自选股行点击（draggable 吞 click 的兜底）');

function makeRow(symbol, name) {
  const row = {
    dataset: { symbol, name },
    _handlers: {},
    classList: makeClassList(),
    getAttribute: (k) => (k === 'draggable' ? 'true' : null),
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    querySelector: () => null,
  };
  return row;
}
function makeContainer(rows) {
  return {
    querySelectorAll(sel) {
      if (sel === '.wl-row') return rows;
      return [];
    },
  };
}
function fire(row, type, ev) {
  (row._handlers[type] || []).forEach(fn => fn({
    target: ev.target || row,
    preventDefault() {},
    stopPropagation() {},
    ...ev,
  }));
}
// 跨用例必须等去重窗口（600ms）过期，否则上一个用例的导航会干扰下一个用例
const waitDedup = () => new Promise(r => setTimeout(r, 700));

let ran = [];
App.analyze = (symbol, name) => { ran.push(symbol); };
App.confirmRemoveWatchlist = (symbol) => { ran.push('REMOVE:' + symbol); };
App.updateWatchlistNavHighlight = () => {};

const rows = [makeRow('600519', '贵州茅台'), makeRow('000001', '平安银行')];
App.bindWatchlistEvents(makeContainer(rows));

// C1：只有 pointerup（模拟浏览器吃掉 click）+ 轻微位移 2px → 应导航
ran = [];
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
fire(rows[0], 'pointerup', { clientX: 102, clientY: 100, button: 0, pointerType: 'mouse' });
ok(ran.length === 1 && ran[0] === '600519', `click 被吞时 pointerup 仍能切换（实际 ${JSON.stringify(ran)}）`);

// C2：pointerup + 紧随的 click（正常浏览器序列）→ 只能导航 1 次
await waitDedup();
ran = [];
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
fire(rows[0], 'pointerup', { clientX: 100, clientY: 101, button: 0, pointerType: 'mouse' });
fire(rows[0], 'click', {});
ok(ran.length === 1, `pointerup 与 click 不重复导航（实际 ${ran.length} 次）`);

// C3：只有 click（无 pointer 事件，如老浏览器/合成点击）→ 仍能导航
ran = [];
await waitDedup();
fire(rows[0], 'click', {});
ok(ran.length === 1 && ran[0] === '600519', `纯 click 路径仍然可用（实际 ${JSON.stringify(ran)}）`);

// C4：位移 20px（拖拽排序意图）→ 不导航
ran = [];
await waitDedup();
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
fire(rows[0], 'pointerup', { clientX: 100, clientY: 120, button: 0, pointerType: 'mouse' });
ok(ran.length === 0, `位移 20px 视为拖拽，不导航（实际 ${ran.length} 次）`);

// C5：长按 1.2s → 不导航
ran = [];
await waitDedup();
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
await new Promise(r => setTimeout(r, 1000));
fire(rows[0], 'pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
ok(ran.length === 0, `长按超过 900ms 不算单击（实际 ${ran.length} 次）`);

// C6：快速点 A 再点 B → 两只都要切（去重必须带 symbol 维度）
ran = [];
await waitDedup();
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
fire(rows[0], 'pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
fire(rows[1], 'pointerdown', { clientX: 100, clientY: 140, button: 0, pointerType: 'mouse' });
fire(rows[1], 'pointerup', { clientX: 100, clientY: 140, button: 0, pointerType: 'mouse' });
ok(ran.length === 2 && ran[0] === '600519' && ran[1] === '000001',
  `连续点两只不同股票都生效（实际 ${JSON.stringify(ran)}）——去重不误伤`);

// C7：点 × 删除 → 只删不加导航
ran = [];
await waitDedup();
fire(rows[0], 'click', { target: { classList: { contains: (c) => c === 'wl-remove' } } });
ok(ran.length === 1 && ran[0] === 'REMOVE:600519', `点 × 只触发删除、不导航（实际 ${JSON.stringify(ran)}）`);

// C8：右键 → 不导航（pointerdown 左键过滤）
ran = [];
await waitDedup();
fire(rows[0], 'pointerdown', { clientX: 100, clientY: 100, button: 2, pointerType: 'mouse' });
fire(rows[0], 'pointerup', { clientX: 100, clientY: 100, button: 2, pointerType: 'mouse' });
ok(ran.length === 0, `右键不导航（实际 ${ran.length} 次）`);

// ============================================================================
// [D] 60s 定时刷新只 patch 单元格，不重建整个列表
// ============================================================================
console.log('\n[D] 定时刷新不重建 DOM');
let renderCalled = 0;
App.renderWatchlist = () => { renderCalled++; };
App.watchlistSortKey = null;                    // 默认未排序态
App.watchlistQuotes = { '600519': { price: 1520.5, changePct: 1.23 } };

const fakePrice = { textContent: '' };
const fakeChg = { className: '', textContent: '' };
const fakeRow = {
  dataset: { symbol: '600519' },
  querySelector(sel) {
    if (sel === '.wl-price') return fakePrice;
    if (sel === '.wl-chg') return fakeChg;
    return null;
  },
};
elMap.watchlist = { querySelectorAll: (sel) => (sel === '.wl-row' ? [fakeRow] : []) };

App.patchWatchlistPrices();
ok(renderCalled === 0, '默认态下不调用 renderWatchlist（不整表重建）');
ok(fakePrice.textContent === '1520.50', `价格单元格就地更新（实际 "${fakePrice.textContent}"）`);
ok(fakeChg.textContent === '+1.23%', `涨跌幅单元格就地更新（实际 "${fakeChg.textContent}"）`);
ok(fakeChg.className.includes('up'), `涨色用 up 类（实际 "${fakeChg.className}"）`);

App.watchlistQuotes = { '600519': { price: 1499, changePct: -0.8 } };
App.patchWatchlistPrices();
ok(fakePrice.textContent === '1499.00', '二次刷新价格更新');
ok(fakeChg.className.includes('down'), `跌色用 down 类（实际 "${fakeChg.className}"）`);

// 排序态下必须重排（价格变化会改变行序）
renderCalled = 0;
App.watchlistSortKey = 'price';
App.patchWatchlistPrices();
ok(renderCalled === 1, '按价格排序时改走 renderWatchlist 重排（顺序语义保住）');
App.watchlistSortKey = null;

// ============================================================================
// [E] 源码级守卫：关键接线不得被回退
// ============================================================================
console.log('\n[E] 源码接线守卫');
ok(/async analyze\(symbol, name = '', _retry = 0, opts = null\)/.test(src), 'analyze 带 opts 参数（force 通道）');
ok(/const force = !!\(opts && opts\.force\);/.test(src), 'force 解析存在');
ok(/this\._inflightTokens\[symbol\] === this\._reqToken\) return;/.test(src), '同股在飞去重判断存在');
ok(/\} finally \{[\s\S]{0,260}delete this\._inflightTokens\[symbol\]/.test(src), 'finally 中清理在飞标记');
ok(/const navigateToRow = \(row, idx\) => \{/.test(src), '行导航收敛为 navigateToRow 单一入口');
ok(/row\.addEventListener\('pointerup'/.test(src), 'pointerup 兜底导航已接线');
ok(/row\.addEventListener\('pointerdown'/.test(src), 'pointerdown 记录起点已接线');
ok(/Math\.abs\(e\.clientX - p\.x\) > 6/.test(src), '位移阈值 6px 存在');
ok(/const navDeduped = \(symbol\) =>/.test(src), '去重带 symbol 维度');
ok(/this\.patchWatchlistPrices\(\);/.test(src), '定时器改调 patchWatchlistPrices');
ok(/patchWatchlistPrices\(\) \{/.test(src), 'patchWatchlistPrices 已定义');
ok(/this\.analyze\(this\.currentSymbol, this\.data\?\.name, 0, \{ force: true \}\)|this\.analyze\(this\.currentSymbol, this\.currentData\?\.name, 0, \{ force: true \}\)/.test(src),
  '刷新/换范围走 force:true');
// 定时刷新块内不应再直接整表重建
ok(!/await Promise\.all\(list\.map\(async s => \{[\s\S]{0,700}?this\.renderWatchlist\(\);\s*\n\s*\}, 60000\)/.test(src),
  '60s 定时刷新块内不再直接 renderWatchlist');

// index.html / css 接线
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
ok(/id="loadingPill"/.test(html), 'index.html 含 #loadingPill');
ok(/\.loading-pill\s*\{[\s\S]{0,400}pointer-events:\s*none/.test(css), '.loading-pill 为 pointer-events:none（不拦截点击）');
ok(/\.loading-pill::before/.test(css), '.loading-pill 带旋转指示');

// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) { console.log('✗ 有失败用例'); process.exit(1); }
console.log('✓ 全部通过：自选股点一次即切换，切股期间有可见反馈');

})().catch(e => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});
