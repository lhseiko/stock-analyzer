/**
 * 阻力/支撑「放量有效突破 → 角色反转」回归（20261022b，用户新增规则）
 * --------------------------------------------------------------
 * 运行： node scripts/test_zone_reversal.js
 * 覆盖 lib/zoneReversal.js：
 *   [1] oppositeSide / rangesIntersect 基础
 *   [2] createRecordFromZone：放量且突破站住 → 反转记录（阻力→支撑）
 *   [3] createRecordFromZone：无放量 / 未站住 / 数据不足 → 不创建
 *   [4] replayRecord：放量突破 → 翻转（反向）
 *   [5] replayRecord：无放量突破 → 标准1 判无效（active=false）
 *   [6] replayRecord：量能缺失 → 不翻转不删除
 *   [7] replayRecord：多次放量突破 → 多次翻转（flipCount 累加）
 *   [8] attachReversedZones 集成：注入反转区间 + 抑制原区间 + 幂等
 *   [9] attachReversedZones 集成：记录被无放量穿越 → 移除
 */
const path = require('path');
const fs = require('fs');
const zr = require('../lib/zoneReversal');
const { BREAK_VOL_MIN } = require('../lib/zoneValidity');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

function mkBars(closes, vols) {
  return closes.map((c, i) => {
    const month = Math.floor(i / 28) + 1;
    const day = (i % 28) + 1;
    return {
      date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      open: c, high: c * 1.005, low: c * 0.995, close: c,
      volume: vols ? vols[i] : 10000,
    };
  });
}
function volsAt(n, map) {
  const v = Array.from({ length: n }, () => 10000);
  Object.keys(map).forEach(k => { v[Number(k)] = 10000 * map[k]; });
  return v;
}
function dateAt(i) {
  const month = Math.floor(i / 28) + 1;
  const day = (i % 28) + 1;
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

console.log('\n[1] 基础函数');
{
  eq(zr.oppositeSide('resistance'), 'support', '阻力 → 支撑');
  eq(zr.oppositeSide('support'), 'resistance', '支撑 → 阻力');
  ok(zr.rangesIntersect({ low: 8, high: 9 }, { low: 8.5, high: 9.5 }), '相交区间');
  ok(!zr.rangesIntersect({ low: 8, high: 8.5 }, { low: 9, high: 9.5 }), '不相交区间');
}

console.log('\n[2] createRecordFromZone：放量且突破站住 → 阻力→支撑');
{
  const bars = mkBars([8.4, 8.5, 8.45, 8.55, 8.5, 8.8], volsAt(6, { 5: 1.9 }));  // 末日 8.8 > high 8.55 放量
  const zone = { low: 8.45, high: 8.55, zoneCheck: { breakCount: 1, lastBreakVr: 1.9, lastBreakDate: dateAt(5) } };
  const rec = zr.createRecordFromZone(zone, 'resistance', bars);
  ok(!!rec, '创建反转记录');
  eq(rec.originSide, 'resistance', 'originSide=resistance');
  eq(rec.side, 'support', '反转为 support');
  eq(rec.flipCount, 1, 'flipCount=1');
  eq(rec.low, 8.45, '区间几何沿用（low）');
  eq(rec.high, 8.55, '区间几何沿用（high）');
  eq(rec.history.length, 1, 'history 1 条');
  eq(rec.history[0].vr, 1.9, 'history 记录量比');
  eq(rec.wasBeyond, false, '反转后当前不在新方向外侧（价在上方）');
}

console.log('\n[3] createRecordFromZone：不满足条件 → null');
{
  const bars = mkBars([8.4, 8.5, 8.45, 8.55, 8.5, 8.8], volsAt(6, {}));
  const noVol = zr.createRecordFromZone({ low: 8.45, high: 8.55, zoneCheck: { breakCount: 1, lastBreakVr: 1.0, lastBreakDate: dateAt(5) } }, 'resistance', bars);
  eq(noVol, null, '无放量 → 不创建');

  const backInside = mkBars([8.4, 8.5, 8.45, 8.55, 8.5, 8.5], volsAt(6, { 5: 1.9 }));
  const notHeld = zr.createRecordFromZone({ low: 8.45, high: 8.55, zoneCheck: { breakCount: 1, lastBreakVr: 1.9, lastBreakDate: dateAt(5) } }, 'resistance', backInside);
  eq(notHeld, null, '放量但已收回区间 → 不算有效突破 → 不创建');

  const noCk = zr.createRecordFromZone({ low: 8.45, high: 8.55 }, 'resistance', bars);
  eq(noCk, null, '无 zoneCheck → 不创建');
}

console.log('\n[4] replayRecord：放量突破 → 翻转');
{
  // 支撑 8.45~8.55；20 根 8.5（区间内），第 20 根（index 20）跌破 8.2 且放量
  const closes = Array.from({ length: 21 }, () => 8.5); closes[20] = 8.2;
  const bars = mkBars(closes, volsAt(21, { 20: 1.9 }));
  const rec = {
    id: 'r1', low: 8.45, high: 8.55, side: 'support', originSide: 'support', flipCount: 1,
    history: [], lastEvalDate: dateAt(19), wasBeyond: false, active: true,
  };
  const out = zr.replayRecord(rec, bars);
  eq(out.side, 'resistance', '支撑被放量下破 → 反转为阻力');
  eq(out.flipCount, 2, 'flipCount 1→2');
  eq(out.history.length, 1, 'history 追加一条');
  ok(out.active !== false, '仍有效');
  eq(rec.side, 'support', '不改入参（纯函数）');
}

console.log('\n[5] replayRecord：无放量突破 → 标准1 判无效');
{
  const closes = Array.from({ length: 21 }, () => 8.5); closes[20] = 8.2;
  const bars = mkBars(closes, volsAt(21, { 20: 1.0 }));   // 量比 1.0 ≤ 1.2
  const rec = {
    id: 'r2', low: 8.45, high: 8.55, side: 'support', originSide: 'support', flipCount: 1,
    history: [], lastEvalDate: dateAt(19), wasBeyond: false, active: true,
  };
  const out = zr.replayRecord(rec, bars);
  eq(out.active, false, '无放量穿越 → active=false（删除）');
  ok(/无放量/.test(out.invalidReason || ''), '给出失效原因');
  eq(out.side, 'support', '未翻转');
}

console.log('\n[6] replayRecord：量能缺失 → 不翻转不删除');
{
  const closes = Array.from({ length: 21 }, () => 8.5); closes[20] = 8.2;
  const vols = Array.from({ length: 21 }, () => 10000); vols[20] = 0;   // 0 → 量比 null
  const bars = mkBars(closes, vols);
  const rec = {
    id: 'r3', low: 8.45, high: 8.55, side: 'support', originSide: 'support', flipCount: 1,
    history: [], lastEvalDate: dateAt(19), wasBeyond: false, active: true,
  };
  const out = zr.replayRecord(rec, bars);
  eq(out.side, 'support', '量能缺失 → 不翻转');
  ok(out.active !== false, '量能缺失 → 不删除');
  eq(out.flipCount, 1, 'flipCount 不变');
}

console.log('\n[7] replayRecord：多次放量突破 → 多次翻转');
{
  // index19 之前都是 8.5；20 跌破 8.2（放量）→ 变阻力；21 冲上 8.8（放量）→ 变回支撑
  const closes = Array.from({ length: 22 }, () => 8.5); closes[20] = 8.2; closes[21] = 8.8;
  const bars = mkBars(closes, volsAt(22, { 20: 1.9, 21: 1.9 }));
  const rec = {
    id: 'r4', low: 8.45, high: 8.55, side: 'support', originSide: 'support', flipCount: 1,
    history: [], lastEvalDate: dateAt(19), wasBeyond: false, active: true,
  };
  const out = zr.replayRecord(rec, bars);
  eq(out.flipCount, 3, '两次放量突破 → flipCount 1→3');
  eq(out.side, 'support', '翻两次回到支撑');
  eq(out.history.length, 2, 'history 2 条');
}

// ---- 集成测试（临时股票代码，跑完清理落盘文件）----
const TMP = '900001';
const tmpFile = path.join(__dirname, '..', 'data', 'zone-reversals', TMP + '.json');

console.log('\n[8] attachReversedZones 集成：注入 + 抑制原区间 + 幂等');
{
  try { fs.unlinkSync(tmpFile); } catch (e) { /* 不存在 */ }
  const daily = mkBars([8.4, 8.5, 8.45, 8.55, 8.5, 8.8], volsAt(6, { 5: 1.9 }));
  const mkData = () => ({
    shortTerm: {
      resistances: [{ low: 8.45, high: 8.55, source: '近60日摆动高点', valid: true, zoneCheck: { breakCount: 1, lastBreakVr: 1.9, lastBreakDate: dateAt(5) } }],
      supports: [],
    },
  });
  const d1 = mkData();
  zr.attachReversedZones(d1, daily, TMP);
  eq(d1.shortTerm.resistances.length, 0, '原始阻力被反转取代 → 移出阻力清单');
  const rev = (d1.shortTerm.supports || []).find(z => z.isReversed);
  ok(!!rev, '反转后的支撑被注入');
  eq(rev && rev.low, 8.45, '反转区间 low 沿用');
  eq(rev && rev.high, 8.55, '反转区间 high 沿用');
  eq(rev && rev.reversedFrom, 'resistance', '标记来自阻力');
  eq(rev && rev.flipCount, 1, 'flipCount=1');

  const d2 = mkData();
  zr.attachReversedZones(d2, daily, TMP);
  eq(d2.shortTerm.supports.filter(z => z.isReversed).length, 1, '重复调用不产生重复记录（幂等）');
  eq(zr.loadRecords(TMP).records.length, 1, '落盘只有 1 条记录');
}

console.log('\n[9] attachReversedZones 集成：记录被无放量穿越 → 移除');
{
  // 在 [8] 的基础上追加一日：收盘 8.2（< low 8.45）但无放量 → 标准1 失效
  const closes = [8.4, 8.5, 8.45, 8.55, 8.5, 8.8, 8.2];
  const vols = Array.from({ length: 7 }, () => 10000); vols[5] = 19000; vols[6] = 10000; // 末日无放量
  const daily2 = mkBars(closes, vols);
  const d3 = { shortTerm: { resistances: [], supports: [] } };
  zr.attachReversedZones(d3, daily2, TMP);
  eq(zr.loadRecords(TMP).records.length, 0, '无放量穿越 → 反转记录被删除');
  eq((d3.shortTerm.supports || []).filter(z => z.isReversed).length, 0, '不再注入');
}

// 清理临时文件
try { fs.unlinkSync(tmpFile); } catch (e) { /* 忽略 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
