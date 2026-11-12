/**
 * scripts/test_deep_degraded_guard.js — B2 修复「前端闭环」守卫（20261111d · 零网络 / 零浏览器）
 * ------------------------------------------------------------------------------
 * 背景：pipeline.js 透出了 sections.currentPrice / sections.dataGaps，但前端不读就等于「修了寂寞」，
 *      且 conclusion.currentPrice 另立口径会在降级时显示旧价 / 「--」。
 * 防御目标：
 *   §1 真实函数级：用 vm + DOM 桩加载 public/js/deepCharts.js，实测 renderDataGapsWarning：
 *      degraded → 插琥珀警告条（bl-warn）；非 degraded → 移除旧条（降级非粘性）；note 做 HTML 转义。
 *   §2 真实函数级：renderConclusion 的价格只认 sections.currentPrice，不被 conclusion 自带旧价覆盖。
 *   §3 静态接线：pipeline 单一权威源 / 前端 renderAll 接线 / CSS / APP_VERSION 与 ?v= 全站同步。
 * 运行：node scripts/test_deep_degraded_guard.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ── 最小 DOM 桩：只实现本守卫用到的接口，不引入 jsdom / 浏览器 ──
function makeDom() {
  const state = { inserted: [], removed: [], existing: null };
  const anchor = {
    firstChild: null,
    insertBefore(node) { state.inserted.push(node); state.existing = node; },
  };
  const conclusionEl = { innerHTML: '', style: {} };
  const documentStub = {
    getElementById(id) {
      if (id === 'deepContent') return anchor;
      if (id === 'deepConclusion') return conclusionEl;
      if (id === 'deepDegradedBar') return state.existing;
      return null;
    },
    createElement() {
      return {
        id: '', className: '', innerHTML: '', attrs: {},
        parentNode: { removeChild(n) { state.removed.push(n); state.existing = null; } },
        setAttribute(k, v) { this.attrs[k] = v; },
      };
    },
  };
  return { documentStub, state, conclusionEl };
}

const dcSrc = read('public/js/deepCharts.js');
let DC = null, dom = null;
try {
  dom = makeDom();
  const ctx = vm.createContext({ document: dom.documentStub, console, window: {} });
  // const 声明不自动挂到 global，显式导出到 globalThis 供断言取用
  vm.runInContext(dcSrc + '\n;globalThis.__DC = DeepCharts;', ctx, { filename: 'deepCharts.js' });
  DC = ctx.__DC;
} catch (e) {
  console.log('  [加载失败] ' + (e && e.message));
}

/* ══════════════ §1 降级警告条真实渲染 ══════════════ */
section('§1 dataGaps.degraded → 琥珀警告条（DOM 桩实测）');
{
  ok(!!DC && typeof DC.renderDataGapsWarning === 'function', 'vm 成功加载 DeepCharts 且 renderDataGapsWarning 在位');
  const gaps = [{ field: 'currentPrice', level: 'degraded', note: '日线末日收盘价（行情接口不可用，降级）' }];
  const priceRef = { value: 9.5, dataTime: '2026-11-09', source: '日线末日收盘价（行情接口不可用，降级）', degraded: true };
  if (DC) DC.renderDataGapsWarning(gaps, priceRef);
  ok(dom && dom.state.inserted.length === 1, 'degraded 时插入且仅插入 1 条警告条（实际 ' + (dom && dom.state.inserted.length) + '）');
  const bar = dom && dom.state.inserted[0];
  ok(!!bar && bar.id === 'deepDegradedBar', '警告条 id=deepDegradedBar（重复渲染可定位移除）');
  ok(!!bar && bar.className.includes('bl-warn') && bar.className.includes('deep-degraded-bar'),
    '复用 bl-warn 琥珀样式 + 专用警告条类');
  ok(!!bar && bar.innerHTML.includes('⚠️ 行情接口不可用，当前价格回退为日线收盘价'),
    '文案为用户指定的降级提示');
  ok(!!bar && bar.innerHTML.includes('9.50') && bar.innerHTML.includes('2026-11-09'),
    '带出权威价与口径日（来自 sections.currentPrice，不是 conclusion）');
  ok(!!bar && String(bar.attrs.title || '').includes('日线末日收盘价'), 'title 带出降级来源，数据诚实可追溯');
  ok(!!bar && bar.innerHTML.includes('deep-degraded-src'), '来源说明单独成行');

  // XSS：note 来自后端来源文案，进入 innerHTML 前必须转义
  if (DC) DC.renderDataGapsWarning([{ level: 'degraded', note: '<img src=x onerror=alert(1)>' }], priceRef);
  const bar2 = dom && dom.state.inserted[dom.state.inserted.length - 1];
  ok(!!bar2 && !bar2.innerHTML.includes('<img') && bar2.innerHTML.includes('&lt;img'),
    '来源文案经 escapeHtml 转义，不注入裸 HTML');
  ok(dom && dom.state.removed.length >= 1, '重复渲染先移除旧条，不累积（实际移除 ' + (dom && dom.state.removed.length) + '）');

  // 降级非粘性：数据源恢复后警告条必须消失
  const before = dom && dom.state.inserted.length;
  if (DC) DC.renderDataGapsWarning([], priceRef);
  ok(dom && dom.state.existing === null && dom.state.inserted.length === before,
    '非 degraded / 数据恢复 → 移除警告条且不再插入（与 §D 降级非粘性同口径）');
}

/* ══════════════ §2 前端价格单一权威源 ══════════════ */
section('§2 renderConclusion 价格只认 sections.currentPrice');
{
  let captured = null;
  if (DC) DC.renderValuationCardHTML = (sum) => { captured = sum; return '<div>card</div>'; };
  // 模拟「旧响应」：conclusion 自带 0（降级时 quote 无价），权威价 9.5
  if (DC) DC.renderConclusion({ overallRating: '合理', currentPrice: 0, conclusionText: '测试结论' }, { value: 9.5, degraded: true });
  ok(captured && captured.currentPrice === 9.5,
    'conclusion 自带 0 被权威价 9.5 覆盖（实际 ' + (captured && captured.currentPrice) + '）');
  ok(dom && dom.conclusionEl.innerHTML.includes('card') && dom.conclusionEl.innerHTML.includes('测试结论'),
    '估值卡与结论文本照常渲染，无回归');

  // 兼容旧响应：无 priceRef 时回退 conclusion.currentPrice，不把页面打空
  captured = null;
  if (DC) DC.renderConclusion({ currentPrice: 12.3, conclusionText: '' }, null);
  ok(captured && captured.currentPrice === 12.3, '无 priceRef（旧缓存响应）时安全回退原值，不崩溃');
}

/* ══════════════ §3 全链路静态接线 ══════════════ */
section('§3 后端单一权威源 / renderAll 接线 / 样式 / 版本戳');
{
  const pipeline = read('lib/deep/pipeline.js');
  ok(pipeline.includes('const conclusionQuote = Object.assign({}, quote || {}, { price: authoritativePrice })')
    && pipeline.includes('conclusionQuote, insuranceAnalysis'),
    'generateConclusion 入参注入权威价（EPS / 专属模型 / 股息率同源）');
  ok(pipeline.includes('currentPrice: authoritativePrice, methodsUsed'),
    'generateConclusion 异常兜底分支也用权威价，不留第二套口径');
  ok(pipeline.includes('currentPrice: priceRef') && pipeline.includes("level: 'degraded'"),
    'sections.currentPrice = priceRef + dataGaps.degraded 仍在位');
  ok(pipeline.includes('sections.conclusion.currentPrice 仅作兼容镜像'),
    '代码内明确前端契约：conclusion.currentPrice 只是兼容镜像');

  const dc = dcSrc;
  ok(dc.includes("safe('dataGaps', () => this.renderDataGapsWarning(sections.dataGaps, sections.currentPrice))"),
    'renderAll 最先渲染警告条，且读 sections.dataGaps / sections.currentPrice');
  ok(dc.includes('this.renderConclusion(sections.conclusion, sections.currentPrice)'),
    'renderAll 把唯一权威价对象传给 renderConclusion');
  ok(dc.includes("const cardData = authoritative != null ? Object.assign({}, data, { currentPrice: authoritative }) : data"),
    'renderConclusion 用 priceRef.value 覆盖卡片价');
  ok(dc.includes('this.renderValuationCardHTML(cardData)'), '估值卡接收统一后的价格对象');

  const css = read('public/css/style.css');
  ok(css.includes('.deep-degraded-bar') && css.includes('var(--accent)'),
    'style.css 含琥珀警告条样式且用主题变量（无裸色值漂移）');

  const server = read('server.js');
  const idx = read('public/index.html');
  const av = (server.match(/const APP_VERSION = '(\d{8}[a-z])'/) || [])[1];
  ok(av === '20261112a', 'APP_VERSION = 20261112a（后端结构 + 前端 UI 均变更，版本戳已升）');
  ok(idx.includes('js/deepCharts.js?v=' + av) && idx.includes('css/style.css?v=' + av),
    'index.html 的 deepCharts.js / style.css 缓存戳与 APP_VERSION 一致');
  ok(!/\?v=20261111b/.test(idx), 'index.html 无残留旧版本戳 20261111b');
}

console.log('\n===== B2 前端闭环守卫：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
