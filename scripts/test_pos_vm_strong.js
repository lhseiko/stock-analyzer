#!/usr/bin/env node
/**
 * 20261103m 守卫：量价判定第三步「大涨 / 大跌」强形态
 * §1 模型层单元（_posVolumeMatrix 强形态分支 / 优先级链互斥 / extRef.strong 透出）
 * §2 思维导图同源（volume-map.html 4 位置趋势运行组各插入 6 强形态叶子，文案逐字一致）
 * §3 前端接线（app.js TREND_FORM_ORDER 17 形态 / 分组标题 / 表尾注）
 * §4 版本断言（server.js APP_VERSION 与 5 个既有测试 / 3 个 html 戳同步至 20261103m）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const ve = require(path.join(ROOT, 'lib', 'volumeEngine.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(t) { console.log(`\n${t}`); }

// ---- 夹具：_posVolumeMatrix(pc, ctx)——_volTraits 仅用 ratio5/level/chgPct/closeToday/highToday ----
function mkPc(chgPct, ratio5, level) {
  return { chgPct, ratio5, level: level || '活跃', closeToday: 10, highToday: 10.2, n: 60 };
}
function mkCtx(label, extra) {
  return Object.assign({
    position: { label, displayLabel: label },
    band20: 0.30, trend20: 0.05, intradayPending: false,
  }, extra || {});
}

// ============================== §1 模型层单元 ==============================
section('§1 模型层：强形态判定（_posVolumeMatrix）');

// 1.1 低位区间 + 放量 + 大涨 → 强形态生效
{
  const r = ve._posVolumeMatrix(mkPc(6.5, 2.0), mkCtx('低位区间'));
  ok(r.extJudgment && r.extJudgment.key === '放量大涨', '低位放量大涨（+6.5% 量比 2.0）→ extJudgment.key=放量大涨');
  ok(r.extJudgment && r.extJudgment.branch === '趋势运行', '强形态归属分支=趋势运行');
  ok(r.extJudgment && r.extJudgment.direction === 'bull', '低位放量大涨方向=bull');
  ok(r.extJudgment && r.extJudgment.reason.includes('≥ 5'), '生效原因标注 ≥5% 阈值口径');
}

// 1.2 高位区间 + 放量 + 大跌 → bear
{
  const r = ve._posVolumeMatrix(mkPc(-6.0, 2.0), mkCtx('高位区间'));
  ok(r.extJudgment && r.extJudgment.key === '放量大跌' && r.extJudgment.direction === 'bear', '高位放量大跌（-6.0%）→ 看空');
}

// 1.3 边界：|chg| 恰为 5 → 命中（平量大涨）
{
  const r = ve._posVolumeMatrix(mkPc(5.0, 1.0), mkCtx('上涨中途'));
  ok(r.extJudgment && r.extJudgment.key === '平量大涨', '上涨中途平量 +5.0%（边界）→ 平量大涨');
}
// 1.4 边界：|chg|=4.9 → 不命中强形态，回主矩阵普通归格
{
  const r = ve._posVolumeMatrix(mkPc(4.9, 2.0), mkCtx('低位区间'));
  ok(r.extJudgment === null, '低位放量 +4.9%（<5%）→ 不触发强形态，extJudgment=null');
  ok(r.cell && r.cell.key === '放量上涨', '4.9% 仍归主矩阵「放量上涨」格（普通涨跌归格保留）');
}

// 1.5 互斥：弱方向（|chg|<1.2）滞涨分支不受影响
{
  const r = ve._posVolumeMatrix(mkPc(0.8, 2.0), mkCtx('低位区间'));
  ok(r.extJudgment && r.extJudgment.key === '放量滞涨', '低位放量 +0.8%（弱方向）→ 仍归滞涨分支（与强形态互斥）');
}

// 1.6 优先级：极端量能（天量）> 强形态
{
  const r = ve._posVolumeMatrix(mkPc(6.0, 5.0, '天量'), mkCtx('低位区间'));
  ok(r.extJudgment && r.extJudgment.branch === '极端量能' && r.extJudgment.key === '天量', '天量 + 大涨 → 极端量能分支仍最高优先');
}

// 1.7 缩量大跌（下跌途中）
{
  const r = ve._posVolumeMatrix(mkPc(-5.5, 0.6), mkCtx('下跌途中'));
  ok(r.extJudgment && r.extJudgment.key === '缩量大跌' && r.extJudgment.direction === 'bear', '下跌途中缩量大跌（-5.5% 量比 0.6）→ 看空');
}

// 1.8 横盘位置：强形态不适用（箱体分支归格行为零变化）
{
  const r = ve._posVolumeMatrix(mkPc(7.0, 2.0), mkCtx('震荡整理', { currentSideways: true, band20: 0.08, trend20: 0.01 }));
  ok(r.extJudgment && r.extJudgment.branch === '区间横盘震荡' && r.extJudgment.key === '放量大涨', '横盘位置大涨（+7.0%）→ 箱体强形态「放量大涨」优先于箱体普通格（20261103m）');
  ok(r.extJudgment && r.extJudgment.direction === 'observe', '横盘（震荡整理）箱体强形态方向=中性 observe（不绑定牛熊）');
  ok(!(r.extRef && r.extRef.strong && r.extRef.strong.length), '横盘位置 extRef 无 strong 数组（不渲染趋势运行组）');
}

// 1.9 extRef.strong 透出（4 位置 × 6 形态，与知识表同源）
{
  const ORDER = ['放量大涨', '放量大跌', '缩量大涨', '缩量大跌', '平量大涨', '平量大跌'];
  for (const pos of ['低位区间', '高位区间', '上涨中途', '下跌途中']) {
    const r = ve._posVolumeMatrix(mkPc(1.5, 1.0), mkCtx(pos));
    const s = r.extRef && r.extRef.strong;
    ok(Array.isArray(s) && s.length === 6 && s.map(x => x.k).join(',') === ORDER.join(','),
      `${pos} extRef.strong 6 形态齐全且顺序正确`);
    ok(s && s.every(x => typeof x.d === 'string' && x.d.length > 10), `${pos} 强形态均带定性结论文案`);
  }
  // 主矩阵 6 主格零变化（不新增 key）
  const r = ve._posVolumeMatrix(mkPc(6.5, 2.0), mkCtx('低位区间'));
  ok(r.cells.length === 6 && !r.cells.some(c => c.key.includes('大涨') || c.key.includes('大跌')),
    '主矩阵 cells 仍为 6 格（强形态不侵入主矩阵，铁律：只新增不改既有）');
  ok(r.schema === 'pos-volume-matrix-1', 'schema 标识零变化');

  // 1.10 键集合一致性（LRN-20261103-003）：强形态表键必须与主矩阵完全一致（含「上涨中途」非「上涨途中」）
  {
    const mk = Object.keys(ve.POS_VM_MATRIX);
    ok(mk.length === 4 && mk.includes('上涨中途') && !mk.includes('上涨途中'), '主矩阵 4 位置键含「上涨中途」（键≠显示名约定固化）');
    const ks = Object.keys(ve.POS_VM_STRONG || {});
    ok(ks.length === 4 && ks.join(',') === mk.join(','), 'POS_VM_STRONG 键集合与主矩阵完全一致');
    // 20261103m：箱体强形态表键集合（4 位置 + 震荡整理）
    const kb = Object.keys(ve.POS_VM_BOX_STRONG || {});
    ok(kb.length === 5 && kb.join(',') === [...mk, '震荡整理'].join(','), 'POS_VM_BOX_STRONG 键集合 = 4 位置 + 震荡整理');
  }

  // 1.11 箱体强形态判定（20261103m）：横盘箱体内 |chg|≥5% 优先归箱体强形态
  {
    // 低位区间横盘 + 放量大跌 → 箱体强形态「放量大跌」、方向沿用强形态表 bear
    const r1 = ve._posVolumeMatrix(mkPc(-7.0, 2.0), mkCtx('低位区间', { currentSideways: true, band20: 0.08, trend20: 0.01 }));
    ok(r1.extJudgment && r1.extJudgment.branch === '区间横盘震荡' && r1.extJudgment.key === '放量大跌' && r1.extJudgment.direction === 'observe', '低位区间横盘放量大跌（-7.0%）→ 箱体强形态「放量大跌」（低位挖坑语境=观察档，方向沿用强形态表）');
    // 边界：横盘 +4.9% → 不触发箱体强形态，归箱体普通格
    const r2 = ve._posVolumeMatrix(mkPc(4.9, 2.0), mkCtx('低位区间', { currentSideways: true, band20: 0.08, trend20: 0.01 }));
    ok(r2.extJudgment && r2.extJudgment.key === '放量上涨' && !r2.extJudgment.key.includes('大涨'), '横盘 +4.9%（<5%）→ 仍归箱体普通格「放量上涨」');
    // 震荡整理位置 box 参考 14 条（8 基础 + 6 强形态）
    const r3 = ve._posVolumeMatrix(mkPc(1.5, 1.0), mkCtx('震荡整理', { currentSideways: true, band20: 0.08, trend20: 0.01 }));
    ok(r3.extRef && r3.extRef.box && r3.extRef.box.length === 14, '震荡整理箱体参考 14 形态（8 基础 + 6 强形态）');
  }
}

// ============================== §2 思维导图同源 ==============================
section('§2 思维导图同源（volume-map.html）');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'volume-map.html'), 'utf8');
  const ORDER = ['放量大涨', '放量大跌', '缩量大涨', '缩量大跌', '平量大涨', '平量大跌'];
  // 2.1 每个强形态名在导图中出现 8 次（4 位置的趋势运行组 + 4 位置的箱体组，20261103m）
  for (const k of ORDER) {
    const cnt = (html.match(new RegExp(`\\{ l: '${k}', d:`, 'g')) || []).length;
    ok(cnt === 8, `导图「${k}」叶子出现 8 次（趋势运行 4 + 箱体 4）`);
  }
  // 2.2 文案逐字同源：趋势运行组 extRef.strong 24 条 + 箱体组 box 内强形态 24 条
  let sameCnt = 0, diff = [];
  for (const pos of ['低位区间', '高位区间', '上涨中途', '下跌途中']) {
    const r = ve._posVolumeMatrix(mkPc(1.5, 1.0), mkCtx(pos));
    for (const x of r.extRef.strong) {
      if (html.includes(`d: '${x.d}'`)) sameCnt++;
      else diff.push(`${pos}/趋势/${x.k}`);
    }
    for (const x of r.extRef.box.filter(b => b.k.includes('大涨') || b.k.includes('大跌'))) {
      if (html.includes(`d: '${x.d}'`)) sameCnt++;
      else diff.push(`${pos}/箱体/${x.k}`);
    }
  }
  ok(sameCnt === 48 && diff.length === 0, `48 条强形态文案（趋势运行 24 + 箱体 24）导图与知识表逐字一致（${diff.length ? '不一致: ' + diff.join('、') : '全部一致'}）`);
  // 2.3 同序：低位趋势运行组叶子顺序与 app.js TREND_FORM_ORDER 一致
  const m = html.match(/一、低位区[\s\S]*?\{ t: '趋势运行', children: \[([\s\S]*?)\] \}/);
  ok(!!m, '低位趋势运行组块可定位');
  if (m) {
    const leaves = [...m[1].matchAll(/\{ l: '([^']+)', d:/g)].map(x => x[1]);
    const expected = ['放量上涨', '放量大涨', '放量震荡', '放量下跌', '放量大跌', '缩量上涨', '缩量大涨', '缩量震荡', '缩量下跌', '缩量大跌', '平量上涨', '平量大涨', '平量震荡', '平量下跌', '平量大跌', '放量滞涨', '放量滞跌'];
    ok(leaves.join(',') === expected.join(','), `低位趋势运行 17 叶子按「强形态跟同量能涨跌之后」同序插入（实际 ${leaves.length} 叶）`);
  }
}

// ============================== §3 前端接线 ==============================
section('§3 前端接线（app.js）');
{
  const appjs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const m = appjs.match(/const TREND_FORM_ORDER = \[([^\]]+)\]/);
  ok(!!m, 'TREND_FORM_ORDER 定义可定位');
  if (m) {
    const items = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    ok(items.length === 17, `TREND_FORM_ORDER 扩为 17 形态（实际 ${items.length}）`);
    const strong = ['放量大涨', '放量大跌', '缩量大涨', '缩量大跌', '平量大涨', '平量大跌'];
    ok(strong.every(k => items.includes(k)), '6 强形态全部入列');
    const idx = k => items.indexOf(k);
    ok(idx('放量大涨') > idx('放量上涨') && idx('放量大跌') > idx('放量下跌') && idx('缩量大涨') > idx('缩量上涨') && idx('缩量大跌') > idx('缩量下跌') && idx('平量大涨') > idx('平量上涨') && idx('平量大跌') > idx('平量下跌'), '强形态位于同量能涨/跌之后（导图同序）');
    ok(appjs.includes("(extRef.strong || []).find(x => x.k === k)"), '行渲染查找链含强形态分支');
    ok(appjs.includes('6 种量价形态 + 大涨 / 大跌强形态 + 震荡 / 滞涨 / 滞跌'), '分组标题同步');
    ok(appjs.includes('【|涨跌幅| ≥ 5%】'), '表尾注含 5% 阈值口径');
  }
}

// ============================== §4 版本断言 ==============================
section('§4 版本断言（20261103m）');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261103m'/.test(server), 'server.js APP_VERSION=20261103m');
  ok(server.includes('[20261103k] 量价判定第三步补「大涨 / 大跌」强形态') && server.includes('[20261103m] 判定列表按生效分支显示'), 'server.js 版本注释含 [20261103k]/[20261103m] 条目');
  for (const f of ['test_metric_analysis_vote', 'test_consistency_audit', 'test_etf_flow_holiday_guard', 'test_manual_zone_reversal', 'test_market_log_db']) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', `${f}.js`), 'utf8');
    ok(src.includes('20261103m') && !src.includes('20261103j'), `${f}.js 版本断言同步至 k`);
  }
  for (const f of ['index.html', 'accuracy.html', 'notes.html']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    ok(src.includes('20261103m') && !src.includes('20261103j'), `public/${f} 版本戳=k`);
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
