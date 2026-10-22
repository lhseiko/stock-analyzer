/**
 * 阻力 / 支撑区间有效性检验回归（零网络，全合成数据）
 * --------------------------------------------------------------
 * 运行： node scripts/test_zone_validity.js
 * 覆盖：lib/zoneValidity.js
 *   2026-10-22 用户要求彻底删除标准2，仅保留标准1「无放量轻松突破 → 无效」。
 *   [1] 区间未被测试 → 有效（未被触碰不等于无效）
 *   [2] 标准1：无放量突破 1 天即回落 → 无效
 *   [3] 放量突破 1 天即回落 → 有效
 *   [4] 已删标准2：放量突破后连续站上 4 天 → 有效（标准2a 已移除）
 *   [8] 支撑方向：无放量跌破 → 无效；放量跌破后收回 → 有效
 *   [9] 量能缺失 / 脏数据 → 不臆断、不判死
 *   [10] close == 上下沿 → 视为区间内
 *   [11] 方向性回归：价格从上方掉下来穿过"阻力"不算突破（600909 实测场景）
 *   [12] 已删标准2：一直站在"阻力"上方且窗内无穿越 → 标准1 无从判定 → 保留（残留边界，见报告）
 *   [13] 只看最近 60 日：更早的穿越不影响结论
 *   [14] 批量汇总计数
 *   [16] 侵蚀收缩（20261020m）：无放量侵入未打穿 → 近端收紧、远端不变、单调取极值
 *   [17] 接线守卫：priceAction 先检验后侵蚀，顺序不可颠倒
 */
const zv = require('../lib/zoneValidity');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const N = 80;
// 合成日K：closes 决定收盘，vols 决定成交量（默认平量 10000 → 量比 1.0）
function mkBars(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, high: c * 1.005, low: c * 0.995, close: c,
    volume: vols ? vols[i] : 10000,
  }));
}
// 在指定下标处放量（其余平量），用法 {index: 倍数}
function volsAt(map) {
  const v = Array.from({ length: N }, () => 10000);
  Object.keys(map).forEach(k => { v[Number(k)] = 10000 * map[k]; });
  return v;
}
// 构造收盘序列：默认 inside，按 [start, end, value] 覆盖
function closesWith(spans, inside = 7.0) {
  const a = Array.from({ length: N }, () => inside);
  spans.forEach(s => { for (let i = s[0]; i <= s[1]; i++) a[i] = s[2]; });
  return a;
}
const RES = { low: 8.45, high: 8.55, source: '近60日摆动高点' };   // inside=7.0 / outside=8.7
const SUP = { low: 7.25, high: 7.35, source: '近60日摆动低点' };

console.log('\n[1] 区间未被测试（价格始终在阻力下方）');
{
  const r = zv.assessZone(mkBars(closesWith([])), RES, 'resistance');
  ok(r.valid, '未穿越 → 有效');
  eq(r.zoneCheck.breakCount, 0, '突破次数 0');
  eq(r.zoneCheck.lastBreakVr, null, '无突破 → 无量比');
}

console.log('\n[2] 标准1：无放量突破 1 天即回落 → 无效');
{
  const bars = mkBars(closesWith([[79, 79, 8.7]]), volsAt({ 79: 1.05 }));  // 量比 1.05
  const r = zv.assessZone(bars, RES, 'resistance');
  ok(!r.valid, '无放量即穿越 → 无效');
  eq(r.zoneCheck.lastBreakVr, 1.05, '突破日量比 1.05');
  ok(r.invalidReasons.some(s => /无放量/.test(s)), '原因写明「无放量轻松穿越」');
  eq(r.invalidReasons.length, 1, '仅标准1 命中');
}

console.log('\n[3] 放量突破 1 天即回落 → 有效');
{
  const bars = mkBars(closesWith([[79, 79, 8.7]]), volsAt({ 79: 1.8 }));
  const r = zv.assessZone(bars, RES, 'resistance');
  ok(r.valid, '放量突破且当日回落 → 有效（该位确有压力）');
  eq(r.zoneCheck.lastBreakVr, 1.8, '突破日量比 1.8');
}

console.log('\n[4] 已删标准2：放量突破后连续站上 4 天 → 有效（标准2a 已移除，仅标准1）');
{
  const bars = mkBars(closesWith([[76, 79, 8.7]]), volsAt({ 76: 1.8 }));
  const r = zv.assessZone(bars, RES, 'resistance');
  ok(r.valid, '放量突破且站上 4 天 → 标准1 不命中 → 有效（旧标准2a 会判无效，已按用户要求删除）');
  eq(r.zoneCheck.lastBreakVr, 1.8, '突破日量比 1.8（放量 → 标准1 不命中）');
}

console.log('\n[8] 支撑方向');
{
  const bad = zv.assessZone(mkBars(closesWith([[79, 79, 7.0]], 7.6), volsAt({ 79: 1.0 })), SUP, 'support');
  ok(!bad.valid, '无放量跌破 → 无效');
  eq(bad.zoneCheck.side, 'support', '方向标记 support');

  const goodCloses = closesWith([[78, 78, 7.0]], 7.6);   // 跌破后次日收回
  const good = zv.assessZone(mkBars(goodCloses, volsAt({ 78: 1.6 })), SUP, 'support');
  ok(good.valid, '放量跌破后收回 → 有效');
}

console.log('\n[9] 量能缺失 / 脏数据');
{
  const zeros = Array.from({ length: N }, () => 0);
  const r = zv.assessZone(mkBars(closesWith([[79, 79, 8.7]]), zeros), RES, 'resistance');
  ok(r.valid, '量能缺失 → 不因标准1 判无效');
  eq(r.zoneCheck.volUnknown, true, '标记 volUnknown');
  eq(r.zoneCheck.lastBreakVr, null, '量比 null 而非编造');

  const bars = mkBars(closesWith([]));
  ok(zv.assessZone(bars, { low: 9.0, high: 8.0 }, 'resistance').valid, 'low > high → 透传有效');
  ok(zv.assessZone(bars, { low: null, high: 8.0 }, 'resistance').valid, '非数字 → 透传有效');
  ok(zv.assessZone(bars, null, 'resistance').valid, 'zone 缺失 → 透传有效');
  eq(zv.assessZone(bars, null, 'resistance').zoneCheck, null, 'zone 缺失 → 不做检验（不把缺字段当 0 价格）');
  ok(zv.assessZone(null, RES, 'resistance').valid, 'bars 缺失 → 透传有效');
}

console.log('\n[10] close == 上下沿 → 视为区间内');
{
  const r = zv.assessZone(mkBars(closesWith([], 8.55)), RES, 'resistance');
  ok(r.valid, '收在阻力上沿不算突破 → 有效');
  eq(r.zoneCheck.breakCount, 0, '收在上沿不算向上突破');
  const r2 = zv.assessZone(mkBars(closesWith([], 7.25)), SUP, 'support');
  eq(r2.zoneCheck.breakCount, 0, '收在下沿不算向下跌破');
}

console.log('\n[11] 方向性回归：从上方跌下来穿过"阻力"不算突破（600909 实测场景）');
{
  // 前 20 根在阻力上方（9.0 缓降），之后一路跌到 7.03：对「上方阻力」而言是回落到下方，不是向上突破
  const closes = Array.from({ length: N }, (_, i) => (i < 20 ? 9.0 - i * 0.02 : 7.03));
  const r = zv.assessZone(mkBars(closes), RES, 'resistance');
  ok(r.valid, '下跌穿越不算「向上突破」→ 阻力仍然有效');
  eq(r.zoneCheck.breakCount, 0, '无向上突破事件');
  ok(r.zoneCheck.lastBreakVr === null, '不产生突破量比');
}

console.log('\n[12] 已删标准2：一直站在"阻力"上方且窗内无穿越 → 标准1 无从判定 → 保留');
{
  // 旧标准2a 会把「连续站上>3天」判无效；该标准已按用户要求删除，此行为随之改变。
  // 注意：这是删除标准2 后的残留边界——swing 生成的区间通常不会出现在现价下方，
  // 真实数据中较少触发；放量突破的场景由 zoneReversal 反转规则接管。
  const r = zv.assessZone(mkBars(closesWith([], 9.0)), RES, 'resistance');
  ok(r.valid, '价格一直在区间上方、窗内无穿越 → 标准1 不命中 → 保留（标准2a 已删）');
  eq(r.zoneCheck.breakCount, 0, '窗内无「从内到外」的穿越事件');
  eq(r.zoneCheck.lastBreakVr, null, '无穿越 → 无量比');
}

console.log('\n[13] 只看最近 60 日');
{
  const closes = Array.from({ length: 100 }, () => 7.0);
  for (let i = 0; i < 20; i++) closes[i] = 9.0;   // 第 60 日之前的历史穿越
  const r = zv.assessZone(mkBars(closes), RES, 'resistance');
  ok(r.valid, '窗外的历史穿越不计入 → 有效');
  eq(r.zoneCheck.lookbackDays, 60, '检验窗 60 日');
}

// [15] 触及口径 / 标准2b 已随标准2 一并删除（2026-10-22 用户要求），不再测试。

console.log('\n[14] 批量汇总计数');
{
  const bars = mkBars(closesWith([[79, 79, 8.7]]), volsAt({ 79: 1.0 }));
  const st = {
    resistances: [
      { low: 8.45, high: 8.55, source: '近60日摆动高点' },   // 无放量突破 → 无效
      { low: 9.4, high: 9.6, source: '近60日摆动高点' },     // 未触及 → 有效
    ],
    supports: [{ low: 6.7, high: 6.8, source: '近60日摆动低点' }], // 未跌破 → 有效
  };
  const out = zv.assessZones(bars, st);
  eq(out.summary.total, 3, '总数 3');
  eq(out.summary.valid, 2, '有效 2');
  eq(out.summary.invalid, 1, '无效 1');
  eq(out.resistances[0].valid, false, '阻力①无效（原地打标，不删条目）');
  ok(typeof out.resistances[0].invalidReasons[0] === 'string', '无效原因随区间返回');
  ok(zv.assessZones(bars, null).summary.total === 0, '入参缺失 → 空结果不崩');
}

console.log('\n[16] 侵蚀收缩（20261020m，用户原话口径）');
{
  // —— 用户原例① 阻力 34.53~34.87，无放量收在 34.7 → 34.7~34.87
  const RES_USER = { low: 34.53, high: 34.87, source: '近60日摆动高点' };
  const c1 = Array.from({ length: N }, () => 33.0); c1[79] = 34.7;
  const e1 = zv.erodeZone(mkBars(c1, volsAt({})), RES_USER, 'resistance');
  eq(e1.low, 34.7, '阻力：无放量侵入至 34.7 → 近端收紧到 34.7');
  eq(e1.high, 34.87, '阻力：远端 34.87 不变');
  ok(e1.eroded, '标记已侵蚀');
  eq(e1.erosion.rangeFrom, '34.53 ~ 34.87', '侵蚀记录原区间');
  eq(e1.erosion.rangeTo, '34.7 ~ 34.87', '侵蚀记录新区间');
  eq(e1.erosion.close, 34.7, '侵蚀记录触发收盘价');
  eq(e1.erosion.vr, 1, '侵蚀记录当日量比（平量 1.0 ≤ 1.2）');

  // —— 用户原例② 支撑 32.25~32.57，无放量收在 32.5 → 32.25~32.5（上沿=近端）
  const SUP_USER = { low: 32.25, high: 32.57, source: '近60日摆动低点' };
  const c2 = Array.from({ length: N }, () => 33.5); c2[79] = 32.5;
  const e2 = zv.erodeZone(mkBars(c2, volsAt({})), SUP_USER, 'support');
  eq(e2.low, 32.25, '支撑：远端 32.25 不变');
  eq(e2.high, 32.5, '支撑：无放量侵入至 32.5 → 近端（上沿）收紧到 32.5');
  eq(e2.erosion.rangeTo, '32.25 ~ 32.5', '支撑侵蚀后区间文本');

  // —— 放量侵入 → 不侵蚀（放量入侵说明该位正在被真实攻击，几何不能动）
  const e3 = zv.erodeZone(mkBars(c1, volsAt({ 79: 1.6 })), RES_USER, 'resistance');
  ok(!e3.eroded, '放量（量比 1.6 > 1.2）侵入 → 不侵蚀');
  eq(e3.low, 34.53, '区间原样返回');
  eq(e3.high, 34.87, '区间原样返回');

  // —— 量能缺失 → 不侵蚀（无法确认"无放量"就不动，绝不臆造）
  const c4 = Array.from({ length: N }, () => 33.0); c4[79] = 34.7;
  const e4 = zv.erodeZone(mkBars(c4, volsAt({ 79: 0 })), RES_USER, 'resistance');
  ok(!e4.eroded, '当日量为 0（量比不可算）→ 不侵蚀');

  // —— 完整打穿远端 → 不是侵蚀，几何不动（有效性由标准1/2 判）
  const c5 = Array.from({ length: N }, () => 33.0); c5[79] = 35.0;
  const e5 = zv.erodeZone(mkBars(c5, volsAt({})), RES_USER, 'resistance');
  ok(!e5.eroded, '收盘越过远端 34.87 → 属突破而非侵蚀，不动几何');

  // —— 只到近端（恰等于 low）不算侵入 → 不侵蚀
  const c6 = Array.from({ length: N }, () => 33.0); c6[79] = 34.53;
  ok(!zv.erodeZone(mkBars(c6, volsAt({})), RES_USER, 'resistance').eroded, '收盘恰等于近端 34.53 → 未进入内部，不侵蚀');

  // —— 单点价 / 脏数据 → 无可侵蚀空间
  ok(!zv.erodeZone(mkBars(c1, volsAt({})), { low: 8.54, high: 8.54 }, 'resistance').eroded, '单点区间（low===high）→ 不侵蚀');
  ok(!zv.erodeZone(mkBars(c1, volsAt({})), { low: 9, high: 8 }, 'resistance').eroded, 'high<low 脏数据 → 不侵蚀');
  ok(!zv.erodeZone(mkBars(c1, volsAt({})), null, 'resistance').eroded, 'zone 缺失 → 不崩、不侵蚀');

  // —— 单调侵蚀：多日都合法侵入时取极值，不取"最后一次"
  const c7 = Array.from({ length: N }, () => 33.0);
  c7[70] = 8.48; c7[75] = 8.52; c7[79] = 8.50;   // 区间 8.45~8.55
  const e7 = zv.erodeZone(mkBars(c7, volsAt({})), { low: 8.45, high: 8.55 }, 'resistance');
  eq(e7.low, 8.52, '多次侵入取最高收盘 8.52（若取最后一次会得到 8.50 = 让区间长回去）');
  const c8 = Array.from({ length: N }, () => 33.0);
  c8[70] = 7.32; c8[75] = 7.28; c8[79] = 7.30;   // 支撑区间 7.25~7.35
  const e8 = zv.erodeZone(mkBars(c8, volsAt({})), { low: 7.25, high: 7.35 }, 'support');
  eq(e8.high, 7.28, '支撑多次侵入取最低收盘 7.28');

  // —— 批量：无效区间不侵蚀（不展示也就无需收缩），有效区间照常收缩
  const c9 = Array.from({ length: N }, () => 33.0); c9[79] = 34.7;
  const bars9 = mkBars(c9, volsAt({}));
  const checked = {
    resistances: [
      Object.assign({}, RES_USER, { valid: true, zoneCheck: { lookbackDays: 60 } }),
      { low: 40.0, high: 40.2, source: '近60日摆动高点', valid: false, zoneCheck: { lookbackDays: 60 } },
    ],
    supports: [],
  };
  const out = zv.erodeZones(bars9, checked);
  eq(out.resistances[0].low, 34.7, '有效区间被收紧');
  eq(out.resistances[1].low, 40.0, '无效区间原样返回（不收缩）');
  ok(!out.resistances[1].eroded, '无效区间不带侵蚀标记');
  eq(out.summary.total, 1, '汇总只统计有效区间（1）');
  eq(out.summary.eroded, 1, '汇总侵蚀数 1');

  // —— 侵蚀结果不回灌 zoneCheck（否则「越侵蚀越有效」的自我强化）
  eq(JSON.stringify(out.resistances[0].zoneCheck), JSON.stringify(checked.resistances[0].zoneCheck), '侵蚀不重算有效性计数');
  ok(zv.erodeZones(bars9, null).summary.total === 0, '入参缺失 → 空结果不崩');
}

console.log('\n[17] 接线守卫：priceAction 必须先检验后侵蚀，且顺序不可颠倒');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceAction.js'), 'utf8');
  const iAssess = src.indexOf('assessZones(zoneBars');
  const iErode = src.indexOf('erodeZones(zoneBars');
  ok(iAssess >= 0, 'priceAction 用已收盘日K（zoneBars）调 assessZones');
  ok(iErode >= 0, 'priceAction 用已收盘日K（zoneBars）调 erodeZones');
  ok(iErode > iAssess, '侵蚀在有效性检验之后（顺序铁律）');
  ok(/zoneErosion:\s*zoneErosionSummary/.test(src), '侵蚀汇总随短期判断一起返回');
  ok(/finalizedBars\(daily\)/.test(src), '突破判定只用已收盘日K（20261022c 收盘价口径）');
}

console.log('\n[18] 收盘价口径（20261022c）：未收盘的当日K线不参与判定');
{
  const past = mkBars([7, 7.1, 7.2]);   // 2026-01-01 ~ 01-03
  eq(zv.finalizedBars(past, new Date(2026, 9, 22, 10, 0)).length, 3, '末根为过去日期 → 全部保留');

  const withToday = past.concat([{ date: '2026-10-22', open: 9, high: 9.3, low: 8.8, close: 9.1, volume: 10000 }]);
  eq(zv.finalizedBars(withToday, new Date(2026, 9, 22, 10, 0)).length, 3, '盘中 10:00 → 丢弃当日未收盘K线');
  eq(zv.finalizedBars(withToday, new Date(2026, 9, 22, 14, 59)).length, 3, '14:59 仍未收盘 → 丢弃');
  eq(zv.finalizedBars(withToday, new Date(2026, 9, 22, 15, 30)).length, 4, '收盘后 15:30 → 当日收盘价可用');
  eq(zv.finalizedBars([], new Date(2026, 9, 22, 10, 0)).length, 0, '空数组 → 空');

  // 盘中价格冲破阻力（8.55）但未收盘 → 不按分时价判突破
  const intradayBreak = mkBars(closesWith([])).concat([{ date: '2026-10-22', open: 8.4, high: 8.8, low: 8.4, close: 8.7, volume: 30000 }]);
  const r = zv.assessZone(zv.finalizedBars(intradayBreak, new Date(2026, 9, 22, 10, 0)), RES, 'resistance');
  ok(r.valid, '盘中冲破阻力但未收盘 → 不计入突破 → 仍有效');
  eq(r.zoneCheck.breakCount, 0, '已收盘K线中无突破事件');

  // 同一根K线在收盘后计入 → 收盘 8.7 越过阻力 high 8.55，量比 3.0 为放量 → 标准1 不命中 → 有效
  const afterClose = zv.assessZone(zv.finalizedBars(intradayBreak, new Date(2026, 9, 22, 15, 30)), RES, 'resistance');
  eq(afterClose.zoneCheck.breakCount, 1, '收盘后该根计入 → 突破 1 次');
  ok(afterClose.valid, '量比 3.0 为放量 → 标准1 不命中 → 有效（放量突破交反转模块）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
