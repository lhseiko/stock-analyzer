#!/usr/bin/env node
/**
 * scripts/test_growth_caliber.js — 20261105b 守卫：增长口径一键切换（单季 ↔ 累计）
 *
 * 用户指令：利润增长的单季/累计口径切换策略——一键切换，切换后对应指标分析同步切换。
 * 范围：左卡关键财务指标 / 右卡指标分析 / 顶栏 tiles / 信号判定 / 历史百分位 全链路同口径；
 *      sameDayJudgment 短期因子、deep 年度结论、stockData 原始快照保持不变（隔离）。
 */
'use strict';
process.env.SA_SETTINGS_FILE = require('os').tmpdir() + '/sa_test_settings_growth_caliber.json';
const fs = require('fs');
const path = require('path');
try { fs.unlinkSync(process.env.SA_SETTINGS_FILE); } catch (e) { /* 首跑不存在 */ }

const ROOT = path.join(__dirname, '..');
const gc = require(path.join(ROOT, 'lib/growthCaliber.js'));
const { evaluateSignals } = require(path.join(ROOT, 'lib/analysis.js'));
const { buildMetricAnalysis } = require(path.join(ROOT, 'lib/metricAnalysis.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 夹具：单季同比（DJD）与累计同比（TZ）数值刻意拉开，切换后取数必须不同
const ZY = [
  { REPORT_DATE: '2026-09-30', REPORT_DATE_NAME: '2026三季报', DJD_TOI_YOY: 0.12, TOTALOPERATEREVETZ: 4.27, DJD_DPNP_YOY: -5.3, PARENTNETPROFITTZ: 8.1 },
  { REPORT_DATE: '2025-09-30', REPORT_DATE_NAME: '2025三季报', DJD_TOI_YOY: 2.45, TOTALOPERATEREVETZ: 2.0, DJD_DPNP_YOY: 3.2, PARENTNETPROFITTZ: 6.0 },
];

console.log('=== §1 growthCaliber 设置模块 ===');
{
  ok(gc.getGrowthCaliber() === 'sq', `默认口径 = sq（实际 ${gc.getGrowthCaliber()}）`);
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B']).join('|') === 'DJD_A|TZ_B', 'sq：字段组原序（单季优先回退累计）');
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B'], 'cum').join('|') === 'TZ_B|DJD_A', 'cum：字段组反序（累计优先回退单季）');
  gc.setGrowthCaliber('cum');
  ok(gc.getGrowthCaliber() === 'cum', 'setGrowthCaliber("cum") 写入并读回');
  ok(gc.growthCaliberLabel() === '累计口径', 'cum 标签 = 累计口径');
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B']).join('|') === 'TZ_B|DJD_A', 'orderedYoYFields 缺省读当前设置');
  let threw = false;
  try { gc.setGrowthCaliber('bad'); } catch (e) { threw = true; }
  ok(threw, '非法口径值抛错');
  gc.setGrowthCaliber('sq');
  ok(gc.getGrowthCaliber() === 'sq', '恢复 sq');
}

console.log('=== §2 口径切换后：右卡指标分析（buildGrowth 主值 + 同比维度）===');
{
  const quote = { fundamentals: { zyzbHistory: ZY } };
  const mk = () => buildMetricAnalysis(quote, {}, { isFinancial: false }, [], { metrics: {} }, null, null);

  gc.setGrowthCaliber('sq');
  let ma = mk();
  let g = ma.metrics.find(x => x.key === 'growth');
  ok(ma.growthCaliber === 'sq', '返回体携带 growthCaliber=sq');
  ok(g.valueText === '0.12%', `sq 主值取 DJD 单季（实际 ${g.valueText}）`);
  ok(g.dims.yoy.text.indexOf('单季优先口径') >= 0, 'sq 同比文案标注「单季优先口径」');
  ok(g.dims.yoy.text.indexOf('0.12%') >= 0, 'sq 同比维度值 = 0.12%');
  const noteSq = g.note;
  ok(noteSq.indexOf('单季优先口径') >= 0 && noteSq.indexOf('一键切换') >= 0, 'note 说明当前口径与一键切换');

  gc.setGrowthCaliber('cum');
  ma = mk();
  g = ma.metrics.find(x => x.key === 'growth');
  ok(ma.growthCaliber === 'cum', '返回体携带 growthCaliber=cum');
  ok(g.valueText === '4.27%', `cum 主值取 TZ 累计（实际 ${g.valueText}）`);
  ok(g.dims.yoy.text.indexOf('累计口径') >= 0, 'cum 同比文案标注「累计口径」');
  ok(g.dims.yoy.text.indexOf('4.27%') >= 0, 'cum 同比维度值 = 4.27%');
  const pg = ma.metrics.find(x => x.key === 'profitGrowth');
  ok(pg.valueText === '8.10%', `cum 利润增长主值取 PARENTNETPROFITTZ（实际 ${pg.valueText}）`);

  gc.setGrowthCaliber('sq');
  ma = mk();
  g = ma.metrics.find(x => x.key === 'growth');
  ok(g.valueText === '0.12%', '切回 sq 主值复原（无状态残留）');
}

console.log('=== §3 口径切换后：信号判定（evaluateSignals，左卡徽标/顶栏同源）===');
{
  const f = { zyzbHistory: ZY };
  gc.setGrowthCaliber('sq');
  let sigs = evaluateSignals(f, null, null, {}).signals || [];
  let byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.value === '0.1%', `sq 营收信号值取单季（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.signal === 'bear', 'sq：0.12 vs 2.45 放缓 → bear');
  ok(byKey.profitGrowth && byKey.profitGrowth.reason.indexOf('单季优先口径') >= 0, 'sq 利润信号文案标注「单季优先口径」');
  ok(byKey.profitGrowth && byKey.profitGrowth.value === '-5.3%', `sq 利润信号值取单季（实际 ${byKey.profitGrowth && byKey.profitGrowth.value}）`);

  gc.setGrowthCaliber('cum');
  sigs = evaluateSignals(f, null, null, {}).signals || [];
  byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.value === '4.3%', `cum 营收信号值取累计（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.signal === 'bull', 'cum：4.27 vs 2.0 加速 → bull（口径切换改变判定，符合预期）');
  ok(byKey.profitGrowth && byKey.profitGrowth.reason.indexOf('累计口径') >= 0, 'cum 利润信号文案标注「累计口径」');
  ok(byKey.profitGrowth && byKey.profitGrowth.value === '8.1%', `cum 利润信号值取累计（实际 ${byKey.profitGrowth && byKey.profitGrowth.value}）`);

  gc.setGrowthCaliber('sq');
}

console.log('=== §4 全链路接线守卫（源码级）===');
{
  const anSrc = fs.readFileSync(path.join(ROOT, 'lib/analysis.js'), 'utf8');
  ok((anSrc.match(/orderedYoYFields\(\['DJD_/g) || []).length === 5, 'analysis.js 三处增长信号 + 两处百分位序列接入口径重排（共5处）');
  ok(anSrc.indexOf("growthCaliberLabel()") >= 0, 'analysis.js 信号文案口径标签动态化');
  const fsSrc = fs.readFileSync(path.join(ROOT, 'lib/fundamentalScore.js'), 'utf8');
  ok((fsSrc.match(/orderedYoYFields\(\['DJD_/g) || []).length === 3, 'fundamentalScore.js 三项 yoyPair 接入口径重排（左卡同口径）');
  const maSrc = fs.readFileSync(path.join(ROOT, 'lib/metricAnalysis.js'), 'utf8');
  ok(maSrc.indexOf('const of = orderedYoYFields(field);') >= 0, 'metricAnalysis buildGrowth 字段组按口径重排');
  ok(maSrc.indexOf('growthCaliber: getGrowthCaliber()') >= 0, 'metricAnalysis 返回体携带 growthCaliber');
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(svSrc.indexOf("app.get('/api/growth-caliber'") >= 0, 'server.js GET /api/growth-caliber 路由');
  ok(svSrc.indexOf("app.post('/api/growth-caliber'") >= 0, 'server.js POST /api/growth-caliber 路由');
  ok(svSrc.indexOf('analysisWarm.clearAllCache()') >= 0, 'POST 后清空分析 TTL 缓存（切换即时生效）');
  ok(svSrc.indexOf("require('./lib/growthCaliber')") >= 0, 'server.js 引入 growthCaliber');
  const awSrc = fs.readFileSync(path.join(ROOT, 'lib/analysisWarm.js'), 'utf8');
  ok(awSrc.indexOf('function clearAllCache()') >= 0 && awSrc.indexOf('clearAllCache,') >= 0, 'analysisWarm 正式导出 clearAllCache');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  ok(appSrc.indexOf('growthCaliberBtn') >= 0 && appSrc.indexOf("fetch('/api/growth-caliber'") >= 0, 'app.js 口径按钮点击 → POST 切换');
  ok(appSrc.indexOf('setGrowthCaliberBtn(data.metricAnalysis && data.metricAnalysis.growthCaliber)') >= 0, 'renderDashboard 按返回口径同步按钮文案');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idxSrc.indexOf('id="growthCaliberBtn"') >= 0, 'index.html 卡头存在口径切换按钮');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  ok(cssSrc.indexOf('.growth-caliber-btn') >= 0, 'style.css 按钮样式');
}

console.log('=== §5 版本戳 ===');
{
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261111d'/.test(svSrc), "APP_VERSION = '20261111d'");
  ok(svSrc.indexOf('[20261104b] 增长口径一键切换') >= 0, 'server.js 版本注释含 [20261104b] 增长口径一键切换条目');
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.indexOf('?v=20261111d') >= 0, 'index.html 版本戳 ?v=20261111d');
}

// 清理测试设置文件
try { fs.unlinkSync(process.env.SA_SETTINGS_FILE); } catch (e) {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
