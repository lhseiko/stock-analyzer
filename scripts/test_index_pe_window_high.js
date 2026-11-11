/**
 * scripts/test_index_pe_window_high.js — 大盘估值趋势守卫（20261105b）
 *
 * 演进：
 *   20261105b：上证50「近5年百分位 99%」判读（实测 11.72 = 近5年窗口最高，99% 为中位排名法真实值，
 *              东财日频交叉验证），曾加 isWindowHigh「近5年新高」标注。
 *   20261105b（用户指令）：① 停止「近5年新高」标注，改用「历史百分位」（东方财富估值页全部历史口径）——
 *              脚本输出 seriesAll 全历史月度序列，服务端算 quantileAll；② 新增中证1000（乐咕同源同口径），
 *              四指数卡片对称（grid 4 列）+ 四条折线（中证1000 柔和紫 #a48fd8）。
 *
 * 运行： node scripts/test_index_pe_window_high.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { calcQuantile } = require('../lib/indexPETrend');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}

// ---------- §1 calcQuantile 数值断言（中位排名法） ----------
ok(calcQuantile(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 95,
  '窗口最高点百分位应为 95%（(9+0.5)/10，中位排名法永远 <100%）');
ok(calcQuantile(5.5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 50, '中位值百分位应为 50%');
ok(calcQuantile(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 5, '窗口最低点百分位应为 5%');
ok(calcQuantile(null, [{ pe: 1 }]) === null, 'pe=null 应返回 null');
ok(calcQuantile(5, []) === null, '空序列应返回 null');
// 全历史 vs 近5年窗口差异样例：近5年最高点在全历史中可能只处于中高位
// 序列 1..20（全历史），当前 10（近5年窗口内最高但全历史中位）：lower=9 → 47.5 → 48%
ok(calcQuantile(10, Array.from({ length: 20 }, (_, i) => ({ pe: i + 1 }))) === 48,
  '全历史窗口下近5年最高点应得中位百分位（10/20 → 48%）');

// ---------- §2 源码接线断言 ----------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const libSrc = read('lib/indexPETrend.js');
const appSrc = read('public/js/app.js');
const chartsSrc = read('public/js/charts.js');
const cssSrc = read('public/css/style.css');
const pySrc = read('scripts/index_pe_trend.py');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const indexHtml = read('public/index.html');

// 2a. 历史百分位口径（20261105b）
ok(/quantileAll: latest \? \(calcQuantile\(latest\.pe, seriesAll\)/.test(libSrc),
  'lib 应有 quantileAll（最新 PE × 全历史序列 seriesAll）');
ok(/const names = \['上证50', '沪深300', '中证1000', '科创50'\]/.test(libSrc), 'lib names 应含中证1000（四指数）');
ok(/const seriesAll = \(item\.seriesAll \|\| item\.series \|\| \[\]\)/.test(libSrc), 'seriesAll 缺失时应回退近5年序列（旧缓存兼容）');
ok(libSrc.includes('历史百分位基于全部历史数据得出'), 'lib note 应注明历史百分位口径');
ok(libSrc.includes('module.exports = { getIndexPETrend, calcQuantile }'), 'calcQuantile 应导出供守卫直测');

// 2b. 「近5年新高」按用户指令停止使用（生成层零残留；注释解释不受限）
ok(!libSrc.includes('isWindowHigh'), 'lib 不得再输出 isWindowHigh（20261105b 用户指令停止）');
ok(!appSrc.includes('isWindowHigh'), 'app.js 不得再消费 isWindowHigh');
ok(!appSrc.includes('近5年新高（百分位'), 'app.js 不得再生成「近5年新高（百分位 X%）」文案');

// 2c. app.js 历史百分位文案 + 中证1000 颜色类
ok(appSrc.includes('历史百分位 ${it.quantileAll}%'), 'app.js 卡片应显示「历史百分位 X%」');
ok(appSrc.includes('近5年百分位 ${it.quantile}%'), 'quantileAll 缺失时应回退「近5年百分位」标注');
ok(appSrc.includes("it.name === '中证1000' ? 'ipe-ci1000'"), 'app.js 应给中证1000 分配 ipe-ci1000 颜色类');

// 2d. charts.js 四线对称
ok(/const names = \['上证50', '沪深300', '中证1000', '科创50'\]/.test(chartsSrc), 'charts.js 四条折线应含中证1000');
ok(chartsSrc.includes("'#a48fd8'"), '中证1000 折线应使用柔和紫 #a48fd8（与蓝/金/粉红区分且合 softDark）');

// 2e. style.css 四列对称网格
ok(/\.ipe-stats \{ display: grid; grid-template-columns: repeat\(4, 1fr\)/.test(cssSrc), 'ipe-stats 应为 4 列对称网格');
ok(cssSrc.includes('.ipe-stat.ipe-ci1000'), 'style.css 应有中证1000 左边框色');

// 2f. 抓取脚本 seriesAll + 中证1000
ok(pySrc.includes('"seriesAll": legu["seriesAll"]') && pySrc.includes('"seriesAll": kc["seriesAll"]'),
  '脚本四指数均应输出 seriesAll');
ok(pySrc.includes('for name in ["上证50", "沪深300", "中证1000"]'), '脚本乐咕循环应含中证1000');
ok(pySrc.includes('all_start_str = "2019-01-01"'), '科创50 应全历史抓取（2019-01-01 起）');

// ---------- §3 版本戳 ----------
ok(/const APP_VERSION = '20261111b'/.test(serverSrc), 'server.js APP_VERSION 应为 20261111b');
ok(/\[20261105b\]/.test(serverSrc), 'server.js 应有 [20261105b] 独立注释条目');
ok(/20261111b/.test(indexHtml), 'index.html 版本戳/注释应对齐 20261111b');

// ---------- 汇总 ----------
console.log(`\n共 ${pass + fail} 断言：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  process.exit(1);
}
console.log('PASS');
