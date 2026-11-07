// =====================================================================
// test_position_unified.js —— 位置标签「新标准三分区」全链路统一守卫（20261106a 定版）
// 背景：旧四类位置体系（趋势方向混入位置标签）整体退役；position.label 值域收敛为
//       高位区间 / 中位区间 / 低位区间，资金流向卡与当日行情判断同步改用三分区，
//       旧量价十口诀主判层（tenRules）删除，判定统一由 135 格 _posVolumeMatrix / volCell 承担。
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ve = require('../lib/volumeEngine');
const cf = require('../lib/capitalFlow');
const pm = require('../lib/posModel135');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const srcVE = read('lib/volumeEngine.js');
const srcCF = read('lib/capitalFlow.js');
const srcSDJ = read('lib/sameDayJudgment.js');
const ZONES = ['高位区间', '中位区间', '低位区间'];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = (t) => console.log('\n===== ' + t + ' =====');

function mkPc(pct) {
  return {
    pricePct12m: pct, drawdownFromHigh: -12.4, rallyFromLow: 11.9,
    ma20: 34.26, ma60: 34.66, closeToday: 34.4, longTerm: null,
  };
}

section('§1 _detectPosition 值域严格三分区');
{
  const got = [0.05, 0.2, 0.3, 0.5, 0.7, 0.8, 0.95, null].map(p => ve._detectPosition(mkPc(p), null, null).label);
  ok(got.every(z => ZONES.includes(z)), `所有分位（含边界与数据不足）均落在三分区：${got.join('/')}`);
  ok(got[0] === '低位区间' && got[1] === '低位区间', '分位 <30% → 低位区间');
  ok(got[5] === '高位区间' && got[6] === '高位区间', '分位 >70% → 高位区间');
  ok(got[2] === '中位区间' && got[3] === '中位区间' && got[4] === '中位区间', '30%~70% → 中位区间');
  ok(got[7] === '中位区间', '分位缺失 → 中位区间（诚实降级，不臆造旧定位）');
  const r = ve._detectPosition(mkPc(0.5), null, { direction: 'up', reason: '趋势段 x' });
  ok(r.label === '中位区间' && !!r.trendSegment, '趋势段不再改写位置，仅作审计透出');
}

section('§2 引擎输出与新判定链同源');
{
  const bars = [];
  const d = new Date('2025-01-02');
  while (bars.length < 260) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      const i = bars.length, p = 30 + 6 * Math.sin(i / 18) + i * 0.012;
      bars.push({ date: d.toISOString().slice(0, 10), open: p - 0.1, close: p + 0.1, high: p + 0.5, low: p - 0.5, volume: 120000 });
    }
    d.setDate(d.getDate() + 1);
  }
  const r = ve.computeVolumeEngine({ bars, symbol: '600000', name: '测试' });
  const a = r.position && r.position.label;
  const b = r.posJudgment && r.posJudgment.position && r.posJudgment.position.label;
  ok(ZONES.includes(a), `computeVolumeEngine.position.label ∈ 三分区（实际 ${a}）`);
  ok(a === b, `旧链路 position 与新 135 格 pj.position 标签已统一（${a} / ${b}）`);
  ok(!('tenRules' in r), '旧量价十口诀主判层 tenRules 已从输出体移除');
  ok(r.posJudgment && r.posJudgment.cell, '135 格主判仍正常归格（判定唯一出口）');
}

section('§3 资金流向 / 当日行情判断消费三分区');
{
  const base = cf.vpPositionSignal('缩量上涨', null);
  ok(cf.vpPositionSignal('缩量上涨', '高位区间') !== base, '高位区间仍命中位置覆盖（方向修正保留）');
  ok(cf.vpPositionSignal('缩量上涨', '中位区间') === base, '中位区间不设方向覆盖 → 走基础分');
  ok(cf.vpPositionSignal('缩量上涨', '低位区间') === base, '低位区间缩量上涨无专项覆盖 → 走基础分');
  ok(cf.vpPositionSignal('放量下跌', '中位区间') === cf.vpPositionSignal('放量下跌', null), '中位区间放量下跌同样走基础分');
  ok(!srcCF.includes("'上涨中途':") && !srcCF.includes("'下跌途中':"), 'capitalFlow 旧方向键已删除');
  ok(srcSDJ.includes('volumeEngine.position.label'), 'sameDayJudgment 仍从同一 position.label 透传（自动跟随三分区）');
}

section('§4 旧体系源码零残留');
{
  const fnBody = srcVE.slice(srcVE.indexOf('function _detectPosition('), srcVE.indexOf('function _threeChecks('));
  ok(!/label\s*=\s*'(上涨中途|下跌途中|震荡整理)'/.test(fnBody), '_detectPosition 内无旧四类标签赋值');
  ok(!/displayLabel|longTermContext/.test(fnBody), '_detectPosition 内无旧展示叠加逻辑');
  ok(!srcVE.includes('function _tenRules('), '旧量价十口诀主判层已整块删除');
  ok(!srcVE.includes('const tenRules = _tenRules('), '引擎不再调用旧十口诀');
  ok(!/^\s*tenRules,\s*$/m.test(srcVE), '引擎输出体不再含 tenRules 字段');
  ok(!srcVE.includes('  _tenRules,'), '模块不再导出 _tenRules');
  ok(typeof pm.volCell === 'function' && pm.ZONES.length === 3, '135 格知识表仍是唯一判定真值源（三分区）');
}

console.log(`\n===== 汇总：通过 ${pass}/${pass + fail} =====`);
process.exit(fail > 0 ? 1 : 0);
