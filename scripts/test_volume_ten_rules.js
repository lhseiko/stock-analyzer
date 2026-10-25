/**
 * 量价十口诀（郭睿体系）判定回归（零网络）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_volume_ten_rules.js
 *
 * 用户需求（2026-10-23）：「我这里有一套量能分析的逻辑，你看一下哪些是原来资金量能的
 * 量能分析里面没有的，给补充进去，或者把原来的逻辑作为补充放进这个逻辑里面整合形成
 * 新的逻辑然后放进原来的位置。」
 *
 * 本层（tenRules）作为「主判」，既有 7.4/7.5/11.3 保留为「补充」。
 * 覆盖：10 条口诀各自命中 / primary 优先级 / 与既有逻辑的 6 个互补点 /
 *       平量涨·跌方向对齐 / 字段完整性 / 源码接线守卫。
 */
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

function mkPc(over) {
  const n = 30;
  const lows = new Array(n).fill(9.8);
  const highs = new Array(n).fill(10.2);
  return Object.assign({
    n, level: '大量', ratio5: 1.5, chgPct: 0.5,
    lowToday: 9.8, highToday: 10.2, closeToday: 10.05,
    lows, highs,
  }, over);
}
const CTX = {
  position: { label: '低位区间' },
  levels: { support: { price: 9.5, kind: '测试支撑' }, resistance: { price: 10.8, kind: '测试压力' } },
};
function run(pc, label) {
  return ve._tenRules(pc, { ...CTX, position: { label: label || '低位区间' } });
}
const primaryId = (r) => (r.primary ? r.primary.id : null);

// ============================================================================
// [1] 第 1 条：低位无量先别急（原引擎缺失的「低位+无量」专条）
// ============================================================================
console.log('\n[1] 低位无量先别急');
{
  const r = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: -0.3 }), '低位区间');
  ok(primaryId(r) === 1, `primary=1（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('僵持观望'), '结论含「僵持观望」');
  ok(r.primary.conclusion.includes('不提前抄底埋伏'), '结论明确「不提前抄底埋伏」');
  ok(r.items[0].pattern === '低位无量' && r.items[0].risk === '观望，无机会', '形态/风险等级正确');
}

// ============================================================================
// [2] 第 2 条：高位无量两子型（缩量回调跌不动 / 缩量阴涨）
// ============================================================================
console.log('\n[2] 高位无量看承接（两子型）');
{
  const r = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: -0.5, lowToday: 9.8 }), '高位区间');
  ok(primaryId(r) === 2, `缩量回调 → primary=2（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('筹码锁定性好'), '结论含「筹码锁定性好」');
  ok(r.primary.conclusion.includes('缩量回调跌不动'), '子型=缩量回调跌不动');
}
{
  const r = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: 0.8 }), '高位区间');
  ok(primaryId(r) === 2, `缩量阴涨 → primary=2（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('缩量阴涨'), '子型=缩量阴涨');
  ok(r.primary.conclusion.includes('隐患'), '结论提示「隐患」');
}

// ============================================================================
// [3] 第 3 条：低位放量看吸收（含长下影/收盘收回；放量创新低不算吸收）
// ============================================================================
console.log('\n[3] 低位放量看吸收');
{
  const r = run(mkPc({ level: '大量', ratio5: 1.8, chgPct: -0.5, lowToday: 9.8, highToday: 10.2, closeToday: 10.05 }), '低位区间');
  ok(primaryId(r) === 3, `低位放量跌不动 → primary=3（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('吸收') || r.primary.conclusion.includes('承接'), '结论含「吸收/承接」');
  ok(r.primary.conclusion.includes('长下影'), '识别长下影/收盘收回');
}
{
  // 放量创新低：不是吸收，应由第 7 条（量增价跌、无承接）接管
  const r = run(mkPc({ level: '大量', ratio5: 2.2, chgPct: -3.0, lowToday: 9.0, highToday: 9.6, closeToday: 9.05 }), '低位区间');
  ok(r.items[2].matched === false, '放量创新低 → 第 3 条不命中（不是吸收）');
  ok(primaryId(r) === 7, `转由第 7 条接管（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('没有承接') || r.primary.conclusion.includes('趋势转弱'), '第 7 条判定无承接/转弱');
}

// ============================================================================
// [4] 第 4 条：高位放量二分（滞涨/放量下跌 vs 创新高）
// ============================================================================
console.log('\n[4] 高位放量看结果');
{
  const r = run(mkPc({ chgPct: 0.3, highToday: 10.25, closeToday: 10.18 }), '高位区间');
  ok(primaryId(r) === 4, `高位放量滞涨 → primary=4（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('派发') || r.primary.conclusion.includes('见顶'), '结论含「派发/见顶」');
  ok(r.primary.conclusion.includes('不得输出看多信号'), '明确不得输出看多信号');
}
{
  const highs = new Array(30).fill(10.2);
  const r = run(mkPc({ chgPct: 3.0, highToday: 10.9, closeToday: 10.85, highs }), '高位区间');
  ok(primaryId(r) === 4, `高位放量创新高 → primary=4（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('创新高'), '子型=放量创新高');
  ok(r.primary.conclusion.includes('止损'), '创新高分支提示设好止损');
}
{
  const r = run(mkPc({ chgPct: -3.0, highToday: 10.2, closeToday: 9.8 }), '高位区间');
  ok(primaryId(r) === 4, `高位放量下跌 → primary=4（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('派发'), '高位放量下跌判高危派发');
}

// ============================================================================
// [5] 第 5/6/7/8/9/10 条：通用量价组合
// ============================================================================
console.log('\n[5-10] 通用量价组合');
{
  const r = run(mkPc({ chgPct: 2.0 }), '上涨中途');
  ok(primaryId(r) === 5, `量增价升 → primary=5（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('健康的多头结构'), '结论含「健康的多头结构」');
}
{
  const up = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: -1.5 }), '上涨中途');
  ok(primaryId(up) === 6, `上涨中缩量回调 → primary=6（实际 ${primaryId(up)}）`);
  ok(up.primary.conclusion.includes('良性回调'), '上涨趋势回调=良性');
  const dn = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: -1.5 }), '下跌途中');
  ok(primaryId(dn) === 6, `下跌中缩量阴跌 → primary=6（实际 ${primaryId(dn)}）`);
  ok(dn.primary.conclusion.includes('阴跌'), '下跌趋势缩量=阴跌、不急于抄底');
}
{
  const hold = run(mkPc({ chgPct: -1.5, lowToday: 9.8, highToday: 10.1, closeToday: 10.0 }), '下跌途中');
  ok(primaryId(hold) === 7, `放量下杀强承接 → primary=7（实际 ${primaryId(hold)}）`);
  ok(hold.primary.conclusion.includes('洗盘'), '强承接=洗盘特征');
  const noHold = run(mkPc({ chgPct: -3.0, lowToday: 9.2, highToday: 10.0, closeToday: 9.25 }), '下跌途中');
  ok(primaryId(noHold) === 7, `放量下杀无承接 → primary=7（实际 ${primaryId(noHold)}）`);
  ok(noHold.primary.conclusion.includes('趋势转弱'), '无承接=趋势转弱');
}
{
  const r = run(mkPc({ level: '缩量', ratio5: 0.6, chgPct: 1.5 }), '上涨中途');
  ok(primaryId(r) === 8, `量缩价升 → primary=8（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('买盘后劲不足') || r.primary.conclusion.includes('偏虚'), '结论提示买盘乏力/偏虚');
}
{
  const r = run(mkPc({ level: '平量', ratio5: 1.0, chgPct: -1.5 }), '震荡整理');
  ok(primaryId(r) === 9, `量平价跌 → primary=9（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('弱势'), '结论判「弱势」');
  ok(r.primary.conclusion.includes('不逆势抄底'), '明确不逆势抄底');
}
{
  const r = run(mkPc({ level: '平量', ratio5: 1.0, chgPct: 1.5 }), '震荡整理');
  ok(primaryId(r) === 10, `量平价升 → primary=10（实际 ${primaryId(r)}）`);
  ok(r.primary.conclusion.includes('弱需求') || r.primary.conclusion.includes('等确认') || r.primary.conclusion.includes('持续性存疑'), '结论提示弱需求/等确认');
  ok(r.primary.conclusion.includes('不主动追高'), '明确不主动追高');
}

// ============================================================================
// [6] 不落在十口诀标准形态内 → primary=null，如实说明
// ============================================================================
console.log('\n[6] 非标准形态');
{
  const r = run(mkPc({ chgPct: 0, highToday: 10.2, lowToday: 9.8, closeToday: 10.0 }), '震荡整理');
  ok(r.primary === null, '横盘放量 → 不硬套口诀（primary=null）');
  ok(r.summary.includes('不落在十口诀'), 'summary 如实说明不落在标准形态');
  ok(r.items.every(it => it.matched === false), '10 条均未命中');
}

// ============================================================================
// [7] 字段完整性与框架提醒
// ============================================================================
console.log('\n[7] 字段完整性');
{
  const r = run(mkPc({ chgPct: 2.0 }), '上涨中途');
  ok(r.items.length === 10, '10 条口诀齐全');
  ok(r.items.every(it => it.id && it.name && it.pattern && it.essence && it.risk && it.status && it.conclusion), '每项含 id/name/pattern/essence/risk/status/conclusion');
  ok(r.framework && r.framework.position && r.framework.volume && r.framework.price && r.framework.keyLevels && r.framework.matchNote, 'framework 五件套齐全');
  ok(r.reminders.length === 2 && /观察工具/.test(r.reminders[0]) && /日线/.test(r.reminders[1]), '两条重要提醒（观察工具 / 日线优先）');
  ok(r.schema === 'ten-rules-1', 'schema=ten-rules-1');
}

// ============================================================================
// [8] 平量涨/跌方向与主判对齐（既有 combo 由 neutral → observe）
// ============================================================================
console.log('\n[8] 平量涨/跌方向对齐');
{
  const base = { level: '平量', ratio5: 1.0, highToday: 10.0, closeToday: 10.0, lowToday: 9.8, chgPct: 2.0 };
  const up = ve._comboEngine(base, { position: { label: '上涨中途' }, persistentHuge: false });
  ok(up.direction === 'observe' && up.scenario === '平量上涨', `平量上涨 → observe（实际 ${up.direction}/${up.scenario}）`);
  const dn = ve._comboEngine({ ...base, chgPct: -2.0 }, { position: { label: '上涨中途' }, persistentHuge: false });
  ok(dn.direction === 'observe' && dn.scenario === '平量下跌', `平量下跌 → observe（实际 ${dn.direction}/${dn.scenario}）`);
}

// ============================================================================
// [9] 源码守卫：接线到 computeVolumeEngine + 导出 + schema
// ============================================================================
console.log('\n[9] 源码守卫');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
ok(src.includes('function _tenRules(pc, ctx)'), '_tenRules 已定义');
ok(src.includes('const tenRules = _tenRules(pc,'), 'computeVolumeEngine 已调用 _tenRules');
ok(src.includes('tenRules,\n  };') || /tenRules,\s*\n\s*};/.test(src), '输出对象含 tenRules 字段');
ok(src.includes("schema: 'volume-engine-20261023d'"), '引擎 schema 升至 20261023d');
ok(src.includes('_tenRules,'), '_tenRules 已导出（可单测）');
ok(!src.includes('量价十口诀（郭睿体系，20261023d 新增）') === false, '十口诀注释存在');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
