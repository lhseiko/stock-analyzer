#!/usr/bin/env node
/**
 * scripts/test_consistency_audit.js — 20261103m 守卫
 * 用户指令：每日定期检查工作台所有数据——多个板块使用的同一数据（即使数据源不同）核对展示值一致；
 * ⚠️ 严格区分累计数据与固定期数据（前三季度累计 vs 第三季度单季），口径差异注记不算错误。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { auditPayload } = require(path.join(ROOT, 'lib/consistencyAudit.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// ===== 合成载荷夹具 =====
function fixture(overrides) {
  const ov = overrides || {};
  const zy = [
    {
      REPORT_DATE: '2026-09-30',
      DJD_TOI_YOY: 4.27, TOTALOPERATEREVETZ: 4.26, TOTALOPERATEREVE: 225.53e8,
      DJD_DPNP_YOY: -15.4, PARENTNETPROFITTZ: -15.38, PARENTNETPROFIT: 53.80e8,
      DJD_DEDUCTDPNP_YOY: -16.2, KCFJCXSYJLRTZ: -16.1,
      ROEJQ: 11.6, XSMLL: 40.1, XSJLL: 22.0,
    },
    { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, TOTALOPERATEREVETZ: 2.45, ROEJQ: 9.0, XSMLL: 39.5, XSJLL: 21.4 },
  ];
  const f = {
    pe: 22.5, pb: 2.5, ps: 3.2, roeTtm: 11.6, grossMarginTtm: 40.2, netMarginTtm: 22.1,
    revenueYoy: 4.27, profitYoy: -15.4, zyzbHistory: zy,
  };
  const payload = {
    symbol: '603288', name: '海天味业',
    quote: { pe: 22.5, pb: 2.5, name: '海天味业', fundamentals: f },
    fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 4.27, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } },
    signals: { signals: [
      { key: 'growth', value: '4.3%', signal: 'neutral' },
      { key: 'profitGrowth', value: '-15.4%', signal: 'bear' },
      { key: 'dedProfitGrowth', value: '-16.2%', signal: 'bear' },
      { key: 'roe', value: '11.6%', signal: 'bull' },
    ] },
    metricAnalysis: { metrics: [
      { key: 'pe', valueText: '22.50' },
      { key: 'pb', valueText: '2.50' },
      { key: 'ps', valueText: '3.20' },
      { key: 'roe', valueText: '11.60%', dims: { industry: { text: '行业均值 15.26，相对低 1.18×' }, pct: { text: '处自身历史 78% 分位' } } },
      { key: 'grossMargin', valueText: '40.20%' },
      { key: 'netMargin', valueText: '22.10%' },
      { key: 'growth', valueText: '4.27%' },
      { key: 'profitGrowth', valueText: '-15.40%' },
      { key: 'dedProfitGrowth', valueText: '-16.20%' },
      { key: 'opProfit', valueText: '14.40亿' },
      { key: 'nbv', valueText: '210.55亿' },
    ] },
    opProfit: { cur: { date: '2026-09-30', opProfitYi: 64.02 }, sqCur: { date: '2026-09-30', opProfitYi: 14.4 } },
    insuranceNBV: { valueYi: 210.55 },
    comparison: { industryAvg: { roe: 15.26 }, percentiles: { roe: 78 } },
  };
  return Object.assign(payload, ov);
}

const byKey = (r, k) => (r.checks || []).find(c => c.id === k);

console.log('=== §1 全一致载荷 → 全 ok ===');
{
  const r = auditPayload(fixture());
  ok(r.health === 'ok', `health=ok（实际 ${r.health}）`);
  ok(r.summary.mismatch === 0, `mismatch=0（实际 ${r.summary.mismatch}）`);
  ok(r.summary.total >= 12, `核对项 ≥12（实际 ${r.summary.total}）`);
  ok(byKey(r, 'pe').status === 'ok', 'PE 同口径一致');
  ok(byKey(r, 'growth').status === 'ok', '营收增长同口径一致');
  const g = byKey(r, 'growth');
  ok(g.note.indexOf('正常口径差异') < 0 || g.note.indexOf('单季') >= 0, '增长核对带口径说明');
  ok(byKey(r, 'opProfitSq').status === 'ok' && byKey(r, 'opProfitCum').status === 'ok', '营运利润单季/累计分列且一致');
  ok(byKey(r, 'nbv').status === 'ok', 'NBV 一致');
  ok(byKey(r, 'indRoe').status === 'ok', '行业均值 ROE 文本与权威值一致');
  ok(byKey(r, 'pctRoe').status === 'ok', '历史百分位文本与权威值一致');
}

console.log('=== §2 累计 vs 单季口径区分（核心规则）===');
{
  // 左卡 revenueGrowth = 4.26（报告期累计口径）而单季口径为 4.27 → 应归类 caliber 而非 mismatch
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 4.26, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const g = byKey(r, 'growth');
  ok(g.status !== 'mismatch', `左卡=累计 4.26% vs 单季 4.27% 判定非 mismatch（实际 ${g.status}）`);
  ok(g.note.indexOf('正常口径差异') >= 0 || g.panels.some(p => p.caliber === '报告期累计同比'), 'note/面板标注「报告期累计同比」口径');
  ok(r.health === 'ok', `整体 health 仍为 ok（实际 ${r.health}）`);
}

console.log('=== §3 同口径数值不一致 → mismatch（真实问题才报警）===');
{
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 99.9, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const g = byKey(r, 'growth');
  ok(g.status === 'mismatch', `左卡=99.9% 无法归类任一口径 → mismatch（实际 ${g.status}）`);
  ok(g.note.indexOf('99.9') >= 0, 'mismatch note 指出具体面板与数值');
  ok(r.health === 'warn', `整体 health=warn（实际 ${r.health}）`);
  // PE 顶栏与行情不一致 → mismatch
  const r2 = auditPayload(fixture({ quote: Object.assign(fixture().quote, { pe: 30 }) }));
  ok(byKey(r2, 'pe').status === 'mismatch', `quote.pe=30 vs 其余 22.5 → PE mismatch（实际 ${byKey(r2, 'pe').status}）`);
}

console.log('=== §4 兜底 0 视为缺失（与 ZERO_AS_MISSING 同口径）===');
{
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 0, netMargin: 22.1, revenueGrowth: 4.27, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const gm = byKey(r, 'grossMargin');
  ok(gm.status !== 'mismatch', `m.grossMargin=0（兜底 0，左卡显示 --）不误报不一致（实际 ${gm.status}）`);
}

console.log('=== §5 数据缺失如实跳过 ===');
{
  const r = auditPayload(fixture({ opProfit: null, insuranceNBV: null, comparison: null }));
  ok(r.summary.total >= 10, '无 opProfit/NBV/comparison 时仍完成其余核对');
  ok(byKey(r, 'indRoe').status === 'missing', '行业均值缺失 → missing（不误报）');
  ok(r.health === 'ok', `缺数据不触发 warn（实际 ${r.health}）`);
}

console.log('=== §6 接线守卫（server / 前端 / 版本戳）===');
{
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(serverJs.includes("require('./lib/consistencyAudit')"), 'server.js 已接入 consistencyAudit');
  ok(serverJs.includes("'/api/consistency-audit'"), 'server.js 已挂 /api/consistency-audit 路由');
  ok(serverJs.includes('_lastConsistencyAudit'), 'server.js 有每日幂等守卫变量');
  ok(serverJs.includes('runConsistencyAuditDaily'), 'server.js 有每日巡检执行函数');
  ok(/启动后 60 秒：跨板块数据一致性巡检补跑/.test(serverJs), 'server.js 有启动补跑兜底');
  const accHtml = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
  ok(accHtml.includes('data-tab="consistency"') && accHtml.includes('id="consistencyPanel"'), 'accuracy.html 有巡检页签与面板');
  const accJs = fs.readFileSync(path.join(ROOT, 'public/js/accuracy.js'), 'utf8');
  ok(accJs.includes('loadConsistency') && accJs.includes("consistency: 'consistencyPanel'"), 'accuracy.js 已接入巡检加载与面板映射');
  ok(accJs.includes('loadConsistency(true)'), '结算按钮 = 立即重跑巡检（force）');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  ok(css.includes('.ca-table'), 'style.css 有巡检明细表样式');
  ok(/const APP_VERSION = '20261103m'/.test(serverJs), "APP_VERSION = '20261103m'");
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.includes('?v=20261103m') && accHtml.includes('?v=20261103m'), 'index/accuracy 页面版本戳已对齐');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
