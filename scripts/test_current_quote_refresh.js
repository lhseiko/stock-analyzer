/**
 * 详情页「当前个股」实时刷新守卫
 * 验证：详情页头部价格每 60s 跟随实时行情刷新（与左侧自选股同源），消除「同一只股两个价」。
 * 运行：node scripts/test_current_quote_refresh.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : '')); }
};

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const accSrc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');

const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
const APP_V = avm ? avm[1] : '';

console.log('===== §1 实时刷新接线 =====');
ok('server.js 存在 APP_VERSION', !!APP_V, APP_V);
ok('app.js 定义 startCurrentQuoteRefresh', /startCurrentQuoteRefresh\s*\(\)\s*\{/.test(appSrc));
ok('init() 中启动 startCurrentQuoteRefresh', /this\.startCurrentQuoteRefresh\(\);/.test(appSrc));
ok('app.js 定义 refreshCurrentQuoteTick', /refreshCurrentQuoteTick\s*\(\)/.test(appSrc));
ok('app.js 定义 refreshCurrentQuote（异步拉取行情）', /async\s+refreshCurrentQuote\s*\(\)/.test(appSrc));
ok('app.js 定义 refreshCapitalFlowSilent（资金卡静默刷新）', /async\s+refreshCapitalFlowSilent\s*\(\)/.test(appSrc));

console.log('\n===== §2 单一价格渲染口径（避免两套格式）=====');
ok('renderStockHeader 委托 applyLiveQuote', /renderStockHeader\s*\([^)]*\)\s*\{[\s\S]{0,400}this\.applyLiveQuote\(quote, market\)/.test(appSrc));
ok('stockPrice 仅在 applyLiveQuote 取一次（单一渲染点，无第二处直接写价格）',
  (appSrc.match(/getElementById\('stockPrice'\)/g) || []).length === 1);
ok('applyLiveQuote 负责写入头部价格文本', /priceEl\.textContent\s*=/.test(appSrc));

console.log('\n===== §3 刷新覆盖与同源 =====');
ok('refreshCurrentQuote 拉取 /api/quote/（与自选股同源）', /refreshCurrentQuote[\s\S]{0,400}\/api\/quote\//.test(appSrc));
ok('refreshCurrentQuote 复用 applyLiveQuote 更新头部', /refreshCurrentQuote[\s\S]{0,1200}this\.applyLiveQuote\(merged/.test(appSrc));
ok('refreshCurrentQuote 同步刷新关键指标网格 renderKeyMetrics', /refreshCurrentQuote[\s\S]{0,1200}this\.renderKeyMetrics\(this\.currentData\)/.test(appSrc));
ok('refreshCurrentQuote 触发资金量能·量价卡静默刷新', /refreshCurrentQuote[\s\S]{0,1400}this\.refreshCapitalFlowSilent\(\)/.test(appSrc));
ok('刷新对切股做隔离（丢弃过期结果，不串股）', /refreshCurrentQuote[\s\S]{0,600}期间已切股/.test(appSrc));
ok('首页（dashboard 隐藏）不刷新', /refreshCurrentQuoteTick[\s\S]{0,400}dashboard/.test(appSrc));

console.log('\n===== §4 版本戳与缓存破坏（与 APP_VERSION 一致）=====');
ok('index.html app.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/app.js?v=' + APP_V));
ok('index.html style.css?v= 与 APP_VERSION 一致', idxSrc.includes('css/style.css?v=' + APP_V));
ok('index.html backtestUI.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/backtestUI.js?v=' + APP_V));
ok('index.html shareholderCharts.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/shareholderCharts.js?v=' + APP_V));
ok('accuracy.html style.css?v= 与 APP_VERSION 一致', accSrc.includes('css/style.css?v=' + APP_V));
ok('accuracy.html accuracy.js?v= 与 APP_VERSION 一致', accSrc.includes('js/accuracy.js?v=' + APP_V));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
