#!/usr/bin/env node
// [20261106a] 趋势段检测 + 新标准三分区位置契约守卫
// 旧四类位置体系已整体退役：position.label 值域 = 高位/中位/低位区间，由价格分位唯一决定。
// _trendSegment 仍保留计算（趋势段审计 + 新 135 格运行状态 _runState 输入），但不再改写位置标签；
// 旧 20261104e「位置阶梯」（趋势段→上涨/下跌中途、拉长长期定论）分支已删除。
// §1 趋势段检测算法断言不变，§2 改写为新三分区契约，§3/§4 同步。
// 本测试全部使用合成夹具（离线、确定性），不含网络调用。
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const ve = require(path.join(ROOT, 'lib', 'volumeEngine'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------- 夹具工厂 ----------
// 合成日K：{date, open, high, low, close, volume}
function bar(date, close, high, low) {
  const h = high != null ? high : close * 1.01;
  const l = low != null ? low : close * 0.99;
  return { date, open: close, high: h, low: l, close, volume: 1e6 };
}
// 上涨段夹具（新洋丰形态）：前段下跌 → 低点 → 温和上涨（中途回撤 ≤ 顺向幅度 60%）→ 现价
function upSegBars() {
  const bars = [];
  let d = new Date(Date.UTC(2026, 0, 5));
  const mkDate = (i) => { const x = new Date(d.getTime() + i * 86400000); return x.toISOString().slice(0, 10); };
  // 0-29：15.5 → 12.0 阴跌
  for (let i = 0; i < 30; i++) bars.push(bar(mkDate(i), 15.5 - (i * 3.5 / 29)));
  // 30：低点 11.56（窗内最低收盘，距今 89 根 ≥ 10）
  bars.push(bar(mkDate(30), 11.56));
  // 31-70：上涨 11.56 → 14.88（低点后峰值）
  for (let i = 31; i <= 70; i++) bars.push(bar(mkDate(i), 11.56 + (i - 30) * (14.88 - 11.56) / 40));
  // 71-90：回撤 14.88 → 13.10（回撤 12.2%，≤ 顺向 26.1% ×60%=15.7%）
  for (let i = 71; i <= 90; i++) bars.push(bar(mkDate(i), 14.88 - (i - 70) * (14.88 - 13.10) / 20));
  // 91-119：回升 13.10 → 14.58
  for (let i = 91; i < 120; i++) bars.push(bar(mkDate(i), 13.10 + (i - 90) * (14.58 - 13.10) / 29));
  return bars;
}
// 横盘夹具（海天形态）：120 日箱体 32.4~38.7 震荡，现价 35.25（自低点 +8.7%、自高点 -8.8% 均不达标）
function sidewaysBars() {
  const bars = [];
  let d = new Date(Date.UTC(2026, 0, 5));
  const mkDate = (i) => { const x = new Date(d.getTime() + i * 86400000); return x.toISOString().slice(0, 10); };
  for (let i = 0; i < 120; i++) {
    const wave = Math.sin(i / 9) * 3.1; // ±3.1 → 箱体 32.4~38.6
    bars.push(bar(mkDate(i), 35.5 + wave));
  }
  bars[119] = bar(mkDate(119), 35.25);
  return bars;
}
// 下跌段夹具（对称）：前段上涨 → 高点 → 下跌（中途反弹 ≤ 顺向跌幅 60%）→ 现价
function downSegBars() {
  const bars = [];
  let d = new Date(Date.UTC(2026, 0, 5));
  const mkDate = (i) => { const x = new Date(d.getTime() + i * 86400000); return x.toISOString().slice(0, 10); };
  // 0-29：40 → 54.66 上涨
  for (let i = 0; i < 30; i++) bars.push(bar(mkDate(i), 40 + i * (54.66 - 40) / 29));
  // 30：高点 54.66（距今 89 根）
  bars.push(bar(mkDate(30), 54.66));
  // 31-80：下跌 54.66 → 21.0
  for (let i = 31; i <= 80; i++) bars.push(bar(mkDate(i), 54.66 - (i - 30) * (54.66 - 21.0) / 50));
  // 81-105：反弹 21.0 → 27.3（反弹 30%，≤ 顺向 55.7% ×60%=33.4%）
  for (let i = 81; i <= 105; i++) bars.push(bar(mkDate(i), 21.0 + (i - 80) * (27.3 - 21.0) / 25));
  // 106-119：回落 27.3 → 24.19
  for (let i = 106; i < 120; i++) bars.push(bar(mkDate(i), 27.3 - (i - 105) * (27.3 - 24.19) / 14));
  return bars;
}

console.log('===== §1 _trendSegment 趋势段检测（确定性规则） =====');
{
  const seg = ve._trendSegment(upSegBars());
  ok(!!seg, '上涨段夹具 → 检出趋势段');
  eq(seg && seg.direction, 'up', '上涨段夹具 → 方向 up');
  ok(seg && Math.abs(seg.movePct - 26.1) < 0.5, `上涨段夹具 → 顺向幅度 ≈+26.1%（实际 ${seg && seg.movePct}）`);
  ok(seg && seg.pullbackPct <= seg.movePct * 0.6, '上涨段夹具 → 期间回撤 ≤ 顺向幅度 ×60%（结构完整）');
  ok(seg && typeof seg.reason === 'string' && seg.reason.includes('趋势段'), '上涨段夹具 → reason 人话依据');
  ok(seg && seg.anchorPrice === 11.56, '上涨段夹具 → 锚点=窗口最低收盘 11.56');

  eq(ve._trendSegment(sidewaysBars()), null, '横盘夹具（自低点+8.7%/自高点-8.8% 均 <20%）→ 无趋势段');

  const dseg = ve._trendSegment(downSegBars());
  ok(!!dseg && dseg.direction === 'down', '下跌段夹具 → 方向 down（对称判定）');
  ok(dseg && dseg.pullbackPct <= -dseg.movePct * 0.6, '下跌段夹具 → 期间反弹 ≤ 顺向跌幅 ×60%');

  eq(ve._trendSegment(upSegBars().slice(0, 100)), null, 'K 线不足 120 根 → null（诚实降级）');

  // 结构破坏：上涨 25% 后回撤 70%（破前低结构）→ 不构成趋势段
  const broken = upSegBars();
  for (let i = 95; i < 120; i++) broken[i].close = 12.2; // 自低点仅剩 +5.5%，且回撤(14.88→12.2)=18%>顺向×60%
  eq(ve._trendSegment(broken), null, '回撤超顺向幅度 ×60%（结构破坏）→ 无趋势段');
}

console.log('===== §2 趋势段不再改写位置，仅作审计（20261106a 新标准三分区） =====');
{
  const segUp = ve._trendSegment(upSegBars());
  const pcXyf = { pricePct12m: 0.415, drawdownFromHigh: -23.1, rallyFromLow: 27.2, ma20: 13.78, ma60: 13.80, closeToday: 14.58, longTerm: { verdict: '震荡', ma250: { value: 14.83, slopeState: '走平', slopePct: -0.13, positionPct: -1.69 } } };
  const r1 = ve._detectPosition(pcXyf, null, segUp);
  eq(r1.label, '中位区间', '新洋丰场景（MA 粘合+中间分位）+ 上涨趋势段 → 仍是中位区间（旧体系会判「上涨中途」）');
  ok(r1.basis.includes('趋势段'), 'basis 含趋势段审计依据（可审计）');
  ok(!!r1.trendSegment, '返回体透出 trendSegment');

  const pcHt = { pricePct12m: 0.55, drawdownFromHigh: -8.8, rallyFromLow: 8.7, ma20: 35.1, ma60: 35.4, closeToday: 35.25, longTerm: { verdict: '下行', ma250: { value: 38.2, slopeState: '下行', slopePct: -0.5, positionPct: -7.7 } } };
  const r2 = ve._detectPosition(pcHt, null, null);
  eq(r2.label, '中位区间', '海天场景（无趋势段）+ 长期 MA250 下行 → 仍是中位区间（旧体系会判「下跌途中」）');
  ok(/MA250/.test(r2.basis) && /下行/.test(r2.basis), 'basis 含长期年线审计依据');

  const r3 = ve._detectPosition({ ...pcHt, longTerm: { verdict: '上行', ma250: { value: 33, slopeState: '上行', slopePct: 0.3, positionPct: 6.8 } } }, null, null);
  eq(r3.label, '中位区间', '长期上行也不改写位置');
  const r4 = ve._detectPosition({ ...pcHt, longTerm: { verdict: '震荡', ma250: { value: 35, slopeState: '走平', slopePct: 0.01, positionPct: 0.7 } } }, null, null);
  eq(r4.label, '中位区间', '长期走平 → 中位区间（不再有旧「震荡整理」兜底标签）');

  const r5 = ve._detectPosition({ pricePct12m: 0.5, drawdownFromHigh: -10, rallyFromLow: 10, ma20: null, ma60: null, closeToday: 10 }, null);
  eq(r5.label, '中位区间', '两参兼容调用（无 trendSeg/longTerm）→ 中位区间');

  const r6 = ve._detectPosition({ ...pcXyf, pricePct12m: 0.2 }, null, segUp);
  eq(r6.label, '低位区间', '低位分位（<30%）优先 → 低位区间保持');
  const r7 = ve._detectPosition({ ...pcXyf, ma20: 13.0, ma60: 12.5 }, null, { direction: 'down', reason: 'x' });
  eq(r7.label, '中位区间', 'MA 多头 / 下跌趋势段参数均不改写成旧定位');
}
console.log('===== §3 端到端 computeVolumeEngine 接线（纯计算入口） =====');
{
  const bars = upSegBars();
  // 现价 14.58 > ma20？构造尾部微涨让 MA 粘合——直接用引擎自身计算，只断言 label 落点
  const out = ve.computeVolumeEngine({ bars, symbol: '000902', name: '新洋丰' });
  ok(out.ok !== false, '端到端：引擎正常输出');
  // 20261106a：新标准三分区，位置标签只可能是 高位/中位/低位区间
  ok(['高位区间', '中位区间', '低位区间'].includes(out.position.label),
    `端到端：位置标签 ∈ 三分区（实际 ${out.position.label}）`);
  // 输出体透出 trendSegment 字段
  ok('trendSegment' in out.position, '端到端：position 输出体含 trendSegment 字段');
}

console.log('===== §4 源码接线守卫 =====');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'volumeEngine.js'), 'utf8');
  ok(src.includes('const trendSeg = _trendSegment(bars);'), 'computeVolumeEngine 计算 trendSeg');
  ok(src.includes('_detectPosition(pc, platform, trendSeg)'), '_detectPosition 接收 trendSeg');
  ok(src.includes('_trendSegment, // 20261104e'), '_trendSegment 已导出（单测可用）');
  ok(typeof ve._trendSegment === 'function', '模块导出 _trendSegment 可调用');
  ok(src.includes('TREND_SEG_WINDOW = 120'), '窗口常量 120 根固化');
  ok(src.includes('TREND_SEG_MOVE = 0.20'), '顺向幅度阈值 20% 固化');
  ok(src.includes('TREND_SEG_MIN_AGE = 10'), '锚点持续期 ≥10 根固化');
  ok(src.includes('TREND_SEG_DD_RATIO = 0.6'), '回撤结构约束 ×0.6 固化');
  // 20261106a：分位两端判定保留；旧「趋势段改写位置」分支已删除
  const idxLow = src.indexOf("pct < 0.3");
  const idxHigh = src.indexOf("pct > 0.7");
  ok(idxLow > 0 && idxHigh > 0, '分位两端判定（<30% / >70%）仍在 _detectPosition 内');
  ok(!src.includes("trendSeg && trendSeg.direction"), '旧「趋势段改写位置」分支已删除');
  ok(!src.includes('function _tenRules('), '旧量价十口诀主判层已删除');
}

console.log('===== §5 版本戳 =====');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(server.includes("const APP_VERSION = '20261111d'"), 'server.js APP_VERSION=20261111d');
  ok(server.includes('[20261104e] 量价判定位置阶梯'), 'server.js 含 20261104e 版本注释条目');
  ok(server.includes('[20261104d] 融资融券 tile 文案歧义修复'), '前版 20261104d 注释条目保留');
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail > 0 ? 1 : 0);
