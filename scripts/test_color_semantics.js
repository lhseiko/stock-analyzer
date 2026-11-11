#!/usr/bin/env node
/**
 * scripts/test_color_semantics.js — [20261109b] 全工作台颜色语义回归守卫
 * ==================================================================
 * 用户铁律（2026-11-09）：**只有「利好 / 正面」才能用红色，只有「利空 / 负面」才能用绿色。**
 *   - 中性 / 无方向 → 中性灰；警告 / 风险 / 数据缺口 / 口径提示 → 琥珀橙。
 *   - ⚠️ 数值符号 ≠ 方向：融券余额 +2.08%、亏损扩大 +30%、CPI 上行等「正数但语义负面」
 *     禁止按 `v > 0 → 红` 着色。
 *   - 适用范围含 CSS、JS 动态 class、文案着色、ECharts 序列、内联样式、后端语义字段。
 *
 * 本守卫四层：
 *   L1 CSS 红绿用法基线：任何新增/删除「使用红绿的规则」都必须人工复核（哈希锁定）。
 *   L2 CSS 语义映射：状态/风险/中性类禁用红绿；好=红、坏=绿、bull=红、bear=绿。
 *   L3 JS 静态接线：禁止机械按数值符号给自由文本着色；中性图表序列禁用方向色。
 *   L4 vm 沙箱行为：真实调用 app.js::_dirColorize / dailyReview.js::semanticText 验证输出 HTML。
 *
 * 不启动浏览器、不联网、不改任何文件。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const RED = /var\(--red\)|#F6465D|rgba\(\s*246,\s*70,\s*93|--red-soft|--red-light|--tint-red/i;
const GREEN = /var\(--green\)|#0ECB81|rgba\(\s*14,\s*203,\s*129|--green-soft|--green-light|--tint-green/i;
const isRed = d => RED.test(d);
const isGreen = d => GREEN.test(d);

// ---------- 解析 CSS 为「选择器 → 声明」表 ----------
const css = read('public/css/style.css');
const rules = {};
const cssRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = cssRe.exec(css))) {
  const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
  (rules[sel] = rules[sel] || []).push(m[2]);
}
const declOf = sel => (rules[sel] || []).join(' ');

console.log('\n===== L1 CSS 红绿用法基线 =====');
const rgSels = Object.keys(rules).filter(s => isRed(declOf(s)) || isGreen(declOf(s)));
const hash = crypto.createHash('sha256').update(rgSels.slice().sort().join('\n')).digest('hex');
const BASELINE_HASH = '55b10d93892be6d31f79e8268ce86251298fe643a681c12645aa98220f04dcfb';
ok(rgSels.length === 231, `使用红绿的 CSS 规则数锁定为 231（当前 ${rgSels.length}）`);
ok(hash === BASELINE_HASH, '红绿规则集合哈希与基线一致（新增红绿用法必须走人工语义复核）',
  hash === BASELINE_HASH ? '' : '当前 ' + hash);
ok((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'CSS 大括号平衡');
ok(!/__[A-Z]+__/.test(css), 'CSS 无迁移残留占位符');

console.log('\n===== L2 CSS 语义映射 =====');
// ① 状态 / 风险 / 警告 / 缺口 / 中性信息 / 排名热度 → 禁用红绿
const DENY = [
  '.toast.success .toast-icon', '.toast.error .toast-icon', '.toast.success', '.toast.error',
  '.pa-mz-err', '.pa-mz-del:hover', '.pa-mz-badge.ok', '.pa-mz-badge.invalid',
  '.pa-mz-row.invalid .pa-mz-range', '.ui-error .ui-icon, .ui-error .ui-title', '.error-banner',
  '.er-mismatch', '.learn-err-item', '.jd-rec.jd-rec-mismatch', '.sn-block.sn-highlight',
  '.tp-warning-card.tp-level-strong .tp-warning-level', '.dr-level-high', '.dr-level-mid', '.dr-level-low',
  '.dr-sec-ok .dr-sec-badge', '.dr-pass', '.dr-chip-trading', '.doc-company-badge',
  '.fmr-chip b', '.learn-up', '.learn-down', '.macro-ind .mi-trend.up', '.macro-ind .mi-trend.down',
  '.macro-ind .mi-trend.neutral', '.htw-item:nth-child(1) .htw-rank', '.htw-item:nth-child(2) .htw-rank',
  '.htw-item:nth-child(3) .htw-rank', '.fm-industry.wt-hot::before', '.fm-industry.wt-warm::before',
  '.fm-industry.wt-light::before', '.fm-stat-tag.wt-hot', '.fm-stat-tag.wt-warm', '.fm-stat-tag.wt-light',
  '.ipe-stale-warn', '.cd-topwarn', '.cd-concl-high', '.cd-concl-low', '.cd-pos-up', '.cd-pos-down',
  '.psc-value.neutral', '.asp-rk', '.btn-delete:hover', '.ctx-item.danger:hover', '.wl-remove:hover',
  '.annc-title-link:hover', '.annc-item.annc-flag', '.research-meta .research-rating, .research-meta .research-target',
  '.note-stock', '.docs-upload-filename', '.htw-tag2.tag-run', '.htw-tag2.tag-panic',
  '.htw-tag2.tag-crowd', '.htw-tag2.tag-kol', '.dr-quadrant-divergence', '.dr-stage-peak',
  '.cd-flag-danger', '.cd-flag-warn', '.sl-verdict-pending', '.dr-fail',
];
DENY.forEach(sel => {
  const d = declOf(sel);
  ok(!!d && !isRed(d) && !isGreen(d), `非方向语义不得用红绿：${sel}`, d.slice(0, 90));
});

// ② 明确的「好 / 坏 / 多 / 空 / 涨 / 跌」必须方向正确
const REQUIRED = {
  '.up, .bullish': 'R', '.down, .bearish': 'G',
  '.pa-metric-item.good': 'R', '.pa-metric-item.bad': 'G',
  '.acc-verify.ok': 'R', '.acc-verify.bad': 'G',
  '.jd-match.jd-ok': 'R', '.jd-match.jd-bad': 'G',
  '.jd-concl.jd-hit': 'R', '.jd-concl.jd-miss': 'G',
  '.bt-verdict.PASS': 'R', '.bt-verdict.REJECT': 'G',
  '.sl-verdict-ok': 'R', '.sl-verdict-bad': 'G',
  '.dcf-item.undervalued': 'R', '.dcf-item.overvalued': 'G',
  '.vd-rating-low': 'R', '.vd-rating-high': 'G',
  '.mt-short-foot .up': 'R', '.mt-short-foot .down': 'G',
  '.cd-flag-good': 'R', '.tp-sig-bull': 'R', '.tp-sig-bear': 'G',
  '.cap-pos': 'R', '.cap-neg': 'G', '.etf-pos': 'R', '.etf-neg': 'G',
  '.fu-ext-hawk': 'G', '.fu-ext-dove': 'R', '.fu-bull-strong': 'R', '.fu-bear-strong': 'G',
  '.bt-best-row': 'R', '.acc-kpi.good .k-value': 'R', '.acc-kpi.bad .k-value': 'G',
  '.mt-acc-chip.good .mac-value': 'R', '.mt-acc-chip.bad .mac-value': 'G',
  '.learn-bar-good': 'R', '.learn-bar-bad': 'G',
  '.policy-support': 'R', '.policy-restrict': 'G',
  '.hot-topic-sent.利好': 'R', '.hot-topic-sent.利空': 'G',
  '.tp-vol-active': 'N', '.tp-vol-quiet': 'N', // 量能档位用暖/冷中性色
};
Object.entries(REQUIRED).forEach(([sel, want]) => {
  const d = declOf(sel);
  const good = !!d && (want === 'R' ? isRed(d) : want === 'G' ? isGreen(d) : (!isRed(d) && !isGreen(d)));
  ok(good, `语义映射 ${want === 'R' ? '利好→红' : want === 'G' ? '利空→绿' : '中性→非红绿'}：${sel}`, d.slice(0, 90));
});

// ③ 风险/警告类必须真的用琥珀橙（不能只是把红绿删掉变成无色）
const AMBER_REQUIRED = ['.toast.error .toast-icon', '.ipe-stale-warn', '.cd-topwarn', '.er-mismatch',
  '.tp-warning-card.tp-level-strong .tp-warning-level', '.cd-concl-high', '.asp-rk'];
const AMBER = /var\(--accent|var\(--orange|#F0B97B|rgba\(\s*240,\s*185,\s*123/i;
AMBER_REQUIRED.forEach(sel => ok(AMBER.test(declOf(sel)), `风险/警告改用琥珀橙：${sel}`));

console.log('\n===== L3 JS 静态接线 =====');
const app = read('public/js/app.js');
const dr = read('public/js/dailyReview.js');
const hm = read('public/js/homeMacro.js');
const cc = read('public/js/capitalCharts.js');
const ch = read('public/js/charts.js');
const sh = read('public/js/shareholderCharts.js');
const ef = read('public/js/etfFlowPage.js');

ok(/o\.numeric === true/.test(app) && /o\.tone === 'bull'/.test(app),
  '_dirColorize 具备 tone / numeric 显式语义契约');
ok(/const NEUTRAL = '涨跌幅\|涨跌家数/.test(app), '_dirColorize 有中性组合词守卫（涨跌幅不拆色）');
const guardIdx = app.indexOf('if (o.numeric === true)');
const signIdx = app.indexOf('<span class="down">${num}</span>');
ok(guardIdx > 0 && signIdx > guardIdx && signIdx - guardIdx < 300,
  '按数值符号着色的代码只存在于 numeric 显式 opt-in 分支内，默认分支无机械着色');
ok(/line\('操作建议', esc\(data\.advice/.test(app) && /line\('风险提示', esc\(data\.riskTip/.test(app),
  '操作建议 / 风险提示改为纯转义，琥珀警示色不被方向色覆盖');
ok(!/color:#F6465D/.test(app) && !/rgba\(246,70,93/.test(app) && !/color:#5FD38D/.test(app),
  'app.js 估值警告/机会条不再用红绿内联样式');
// [20261110g] 守卫随 20261110b「Markdown 直出版」重构更新：
//   dailyReview.js 的旧 sections/quads/colorize/renderCell 逐字段着色体系已按用户裁决整体删除，
//   正文改为后端 Markdown 直出 + 本地渲染器。守卫改为盯两件事：
//   ① 方向着色不得回潮（无 colorize 类函数、无方向 class、无红绿硬编码）；
//   ② Markdown 来源不可信，渲染必须走转义兜底。
ok(!/function (colorize|colorizePrice|semanticText|renderCell)\(/.test(dr) && !/dr-up|dr-down/.test(dr),
  'dailyReview 已升级 Markdown 直出版：逐字段方向着色函数（colorize/semanticText/renderCell）整体移除，未回潮');
ok(!/#F6465D|#0ECB81/.test(dr),
  'dailyReview 无红绿硬编码（正文着色交由后端 Markdown 与全站 CSS）');
ok(/mi-trend neutral/.test(hm) && !/mi-trend \$\{ind\.trend\}/.test(hm),
  '宏观趋势徽标改中性灰（数值回升/回落 ≠ 利好/利空）');
ok(/rqChange > 0 \? 'cap-neg' : 'cap-pos'/.test(cc), '融券余额增加 = 利空绿（口径不回退）');
ok(!/rgba\(246,70,93,0\.55\)/.test(cc) && !/rgba\(14,203,129,0\.55\)/.test(cc),
  '放量/缩量阈值线不再占用方向色');
ok(/rsiOverbought: '#F0B97B'/.test(ch) && /rsiOversold: '#D9A566'/.test(ch),
  'RSI 超买/超卖阈值线改琥珀橙');
ok(!/#F6465D/.test(sh) && !/#F6465D/.test(ef) && !/#0ECB81/.test(ef),
  '股价叠加线 / ETF 持仓·现金比例序列改中性色');
ok(/psc-value neutral/.test(app) && !/coordination\.dominant\.includes\('长期'\) \? 'up' : 'down'/.test(app),
  '「主导力量 长期/短期」不再按上/下染红绿');
ok(/return 'tp-vol-active'/.test(app) && /return 'tp-vol-quiet'/.test(app),
  '量能档位改用暖/冷中性色，不再 cap-pos/cap-neg');

// ④ [20261110g] Markdown 直出版接线：转义优先 + 正文统一经 markdownHtml，不再逐字段拼 HTML
ok(/function markdownHtml\(md\)/.test(dr) &&
  /'<pre class="dr-markdown-fallback">' \+ esc\(md\)/.test(dr),
  'Markdown 来源不可信：无渲染库时走 esc 转义兜底（dr-markdown-fallback）');
ok(/markdownHtml\(md\)/.test(dr) && /decorateWatchPool\(main\)/.test(dr),
  'renderVersion 正文统一经 markdownHtml 渲染（不再逐字段拼 HTML 着色）');

console.log('\n===== L4 vm 沙箱：真实渲染行为 =====');
const mkEl = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  appendChild() {}, insertAdjacentHTML() {},
});
function sandbox() {
  const els = {};
  const s = {
    console, URL, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ json: () => ({}) }),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', search: '' },
    document: {
      addEventListener() {}, getElementById(id) { return els[id] || (els[id] = mkEl()); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mkEl(); }, body: mkEl(),
    },
    Chart: function () { return {}; },
    echarts: { init() { return { setOption() {}, resize() {} }; } },
    alert() {},
  };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  return s;
}

// 4a. app.js::_dirColorize
const sa = sandbox();
vm.runInContext(read('public/js/app.js') + '\n;globalThis.__App = App;', sa, { timeout: 10000 });
const App = sa.__App;
ok(!!(App && typeof App._dirColorize === 'function'), 'vm 成功加载 App._dirColorize');
const c = t => App._dirColorize(t);
ok(!/class="up"/.test(c('融券余额 +2.08%')) && !/class="down"/.test(c('融券余额 +2.08%')),
  '「融券余额 +2.08%」正数值不再被机械染红（数值符号 ≠ 方向）');
ok(!/dr-up|dr-down/.test(c('风险敞口 +3%')), '自由文本里 +3% 不着方向色');
ok(/tp-sig-bull/.test(c('上涨')) && /tp-sig-bear/.test(c('下跌')), '显式语义词「上涨→红 / 下跌→绿」仍正确');
ok(!/tp-sig-(bull|bear)/.test(c('涨跌幅分布')), '中性组合词「涨跌幅分布」不拆成红涨绿跌');
ok(/class="up">\+1\.23%/.test(App._dirColorize('+1.23%', { numeric: true })),
  '已确认语义的涨跌幅字段 numeric:true 仍按 +红 着色');
ok(/class="down">-1\.23%/.test(App._dirColorize('-1.23%', { numeric: true })),
  '已确认语义的涨跌幅字段 numeric:true 仍按 -绿 着色');
ok(/tp-sig-bear/.test(App._dirColorize('融券余额 +2.08%', { tone: 'bear' })),
  '调用方给定 tone=bear 时整段按语义着绿，忽略数值符号');
ok(/class="up"/.test(c('2026-10-26 14:30-15:00')) === false, '日期/时间连字符不受影响');

// 4b. dailyReview.js::markdownHtml（[20261110g] 随 Markdown 直出版重构更新）
const sd = sandbox();
let drSrc = read('public/js/dailyReview.js');
const cut = drSrc.lastIndexOf('})();');
drSrc = drSrc.slice(0, cut) + 'globalThis.__DR = { markdownHtml, legacySectionsToMarkdown };\n' + drSrc.slice(cut);
vm.runInContext(drSrc, sd, { timeout: 10000 });
const DR = sd.__DR;
ok(!!(DR && typeof DR.markdownHtml === 'function'), 'vm 成功加载 dailyReview 的 Markdown 渲染函数');
const inj = DR.markdownHtml('<script>alert(1)</script>');
ok(!/<script/i.test(inj) && /&lt;script&gt;/.test(inj),
  'Markdown 直出版：HTML 注入经 esc 转义，不产生可执行片段（沙箱无 Markdown 库 → fallback 分支）');
ok(/dr-empty/.test(DR.markdownHtml('')), '空正文返回 dr-empty 占位（不渲染空 article）');
const legacyMd = DR.legacySectionsToMarkdown([{ title: '测试段', metrics: [{ label: '指标', value: '数值' }] }]);
ok(legacyMd.indexOf('### 测试段') === 0 && /\| 指标 \| 数值 \|/.test(legacyMd),
  '旧结构化复盘 legacySectionsToMarkdown 兼容还原仍可用');

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
