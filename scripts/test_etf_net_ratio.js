#!/usr/bin/env node
/**
 * test_etf_net_ratio.js — 任务卡 #023 专项守卫
 * ================================================================
 * 「全部成分股累计」表末列「买/卖天数」原位替换为「净申赎占比」：
 *   占比 = 累计净申赎股数 ÷ 该股流通股数 × 100（腾讯行情字段72）；
 *   带符号两位百分比、净申购红 / 净赎回绿、缺分母显示「—」不臆造；
 *   末列带 ▲▼ 排序（netRatio，与 cumNet 同带符号语义）。
 * 后端 lib/etfFlow.js：fetchStockNames 同批缓存流通股（零新增请求），
 *   computeFromSnapshots 同步注入 stocks[].floatShares（缺值 null）。
 * 静态断言 + vm 沙箱实跑 render()（防 20261117f「量能分析空白」类运行时错误）。
 * 零网络、零写盘（生产目录）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fl = src('lib/etfFlow.js');
const page = src('public/js/etfFlowPage.js');

console.log('\n=== 1) 后端：流通股缓存与注入 ===');
ok(fl.includes("FLOAT_CACHE = path.join(DIR, 'stock-float-shares.json')"), '流通股缓存路径常量已定义');
ok(/missing = Array\.from\(new Set\(codes\)\)\.filter\(c => c && \(!cache\[c\] \|\| !\(fcache\[c\] > 0\)\)\)/.test(fl), 'missing = 名称缺失 ∪ 流通股缺失（同批请求两用）');
ok(/got\[c\]\.shares > 0 && !\(fcache\[c\] > 0\)\) \{ fcache\[c\] = got\[c\]\.shares/.test(fl), '仅缓存 >0 有效流通股，避免污染分母');
ok(/if \(f\) writeJson\(FLOAT_CACHE, fcache\)/.test(fl), '流通股落盘缓存（累积，之后零请求）');
ok(fl.includes('const floats = readJson(FLOAT_CACHE, {}) || {}'), 'computeFromSnapshots 同步读流通股缓存');
ok(/floatShares: \(floats\[code\] > 0\) \? floats\[code\] : null/.test(fl), 'stocks[].floatShares 注入，缺值 null 不臆造');

console.log('\n=== 2) 前端：末列接线与口径 ===');
ok(!page.includes('<th class="num">买/卖天数</th>'), '旧「买/卖天数」表头已移除');
ok(page.includes('>净申赎占比<') && page.includes("_sortBtn('netRatio', 1") && page.includes("_sortBtn('netRatio', -1"), '新列「净申赎占比」带 ▲▼ 排序');
ok(/function _netRatio\(s\)[\s\S]{0,240}_cumNet\(s\) \/ f\) \* 100/.test(page), '占比公式 = 累计净申赎 ÷ 流通股 × 100');
ok(/function _fmtPct[\s\S]{0,160}toFixed\(2\) \+ '%'/.test(page), '占比显示两位百分比、带符号');
ok(page.includes('${_fmtPct(_netRatio(s))}') && page.includes('${_netCls(_netRatio(s))}'), '单元格占比着色与净申赎同源（红涨绿跌）');
ok(/k === 'netRatio' \? _netRatio\(s\)/.test(page), '排序按带符号占比原值（升序=净赎回在前）');
ok(page.includes('腾讯行情字段72') && page.includes('分母缺失时显示「—」不臆造'), '口径说明写明分母来源与缺值降级');

console.log('\n=== 3) vm 沙箱实跑 render()（防运行时错误） ===');
{
  const mkEl = () => ({
    innerHTML: '', textContent: '', style: {}, dataset: {},
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  });
  const els = {};
  const sb = {
    console, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error, Set,
    isNaN, parseInt, parseFloat, encodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => new Promise(() => {}),
    document: {
      addEventListener() {}, getElementById(id) { return els[id] || (els[id] = mkEl()); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mkEl(); }, body: mkEl(),
    },
    echarts: { init() { return { setOption() {}, resize() {}, dispose() {} }; } },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  let code = page;
  const cut = code.lastIndexOf('})();');
  code = code.slice(0, cut)
    + 'globalThis.__ef = { render, setData: d => { DATA = d; }, setSort: (k,dir) => { stockSort = {key:k,dir:dir}; } };\n'
    + code.slice(cut);
  let loadErr = null;
  try { vm.runInContext(code, sb, { timeout: 8000 }); } catch (e) { loadErr = e; }
  ok(loadErr === null, 'vm 加载 etfFlowPage.js 不抛错', loadErr && loadErr.message);
  const api = sb.__ef;
  ok(!!(api && typeof api.render === 'function'), 'render() 可调用');
  if (api) {
    // 三只样本：净申购有分母 / 净赎回有分母 / 分母缺失
    const DATA = {
      ok: true, date: '20261117', settled: true,
      summary: { groups: [{ key: 'csi300', label: '沪深300', netAmount: 1.8e9 }], totalNet: 1.8e9, ledgerDays: 16, ledgerDate: '20261117' },
      etfs: [{ code: '510300', name: '沪深300ETF', groupLabel: '沪深300', netAmount: 1.8e9 }],
      stocks: [
        { code: '601398', name: '工商银行', cumBuy: 200203800, cumSell: -25983200, floatShares: 35640600000, buyDays: 13, sellDays: 10 },
        { code: '600036', name: '招商银行', cumBuy: 10000000, cumSell: -50000000, floatShares: 20629000000, buyDays: 5, sellDays: 12 },
        { code: '000001', name: '平安银行', cumBuy: 80000000, cumSell: -10000000, floatShares: null, buyDays: 9, sellDays: 3 },
      ],
      gaps: [],
    };
    let runErr = null;
    try { api.render(DATA); } catch (e) { runErr = e; }
    ok(runErr === null, 'render() 以真实结构实跑不抛错', runErr && runErr.message);
    const html = els.efBody ? els.efBody.innerHTML : '';
    ok(html.includes('净申赎占比'), '实跑输出含新列标题');
    ok(!html.includes('13 / 10'), '实跑输出不再展示「买/卖天数」数值');
    // 工行：(200203800 - 25983200) / 35640600000 * 100 = 0.4888...% → +0.49%
    ok(html.includes('+0.49%'), '实跑净申购占比 = +0.49%（带符号两位）');
    // 招行：(10000000 - 50000000) / 20629000000 * 100 = -0.1937...% → −0.19%
    ok(html.includes('−0.19%'), '实跑净赎回占比 = −0.19%（Unicode 减号）');
    ok(html.includes('data-sort-key="netRatio"'), '实跑输出含 netRatio 排序按钮');
    ok(html.includes('腾讯行情字段72'), '实跑输出口径说明含分母来源');
    // 平安银行 floatShares=null → 该行占比显示「—」（非 0.00%）
    ok(/平安银行[\s\S]{0,700}—</.test(html), '分母缺失行显示「—」不臆造为 0.00%');
  }
}

console.log('\n' + '='.repeat(56));
console.log(`===== 净申赎占比列守卫：${pass} 通过 / ${fail} 失败 =====`);
if (fail) process.exit(1);
