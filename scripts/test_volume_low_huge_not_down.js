/**
 * 「低位放大量但价格不跌，要跟踪」判定口径回归（零网络）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_volume_low_huge_not_down.js
 *
 * 用户报障原文（2026-10-23，海天味业 603288 截图）：
 *   「判定有误，低位放大量但价格不跌，要跟踪，成立的条件是仅小阴小阳震荡或重心企稳，
 *     但是今天海天味业是大涨的。」
 *
 * 根因：_contradictionRules 里 11.3.3.2 的条件写成
 *   (t.isStagnant || (pc.chgPct !== null && pc.chgPct > 0))
 * 第二个分支把「任何上涨」都当成「价格不跌」，于是 +3.41% 的大涨也命中，
 * 与结论文案「仅小阴小阳震荡或重心企稳」自相矛盾。
 *
 * 现口径：当日 |涨跌幅| < 1.2%（小阴小阳）是硬门槛；重心企稳只作二次确认；
 * 大涨/大跌（|涨跌幅| ≥ 1.2%）一律不属「价格不跌」。
 */
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---------------- 构造 pc（_contradictionRules 所需字段） ----------------
function mkPc(over) {
  const n = 30;
  const closes = new Array(n).fill(10);
  const pc = Object.assign({
    n, level: '大量', ratio5: 1.5, chgPct: 0.5,
    closes, lows: new Array(n).fill(9.8), highs: new Array(n).fill(10.2), vols: new Array(n).fill(100000),
    lowToday: 9.8, highToday: 10.2, closeToday: 10.05, openToday: 10,
    avg5: 100000, avg60: 100000, volToday: 200000,
    ma20: 10, ma60: 10, pulse: false,
    hasTurnover: false, turnoverMean: null, turnoverToday: null,
  }, over);
  return pc;
}
function ruleAt(pc, label) {
  return ve._contradictionRules(pc, {
    position: { label: label || '低位区间' }, levels: {}, sequence: {}, rules: [], platform: null, pv: {},
  }).lowHugeNotDown;
}

// ============================================================================
// [1] 用户报障场景：低位 + 大量 + 当日 +3.41% → 必须不命中
// ============================================================================
console.log('\n[1] 海天味业当日 +3.41%（大涨）→ 不命中');
let r = ruleAt(mkPc({ chgPct: 3.41 }));
ok(r.matched === false, 'matched=false（不再把大涨当「价格不跌」）');
ok(r.status === '未命中', 'status=未命中');
ok(r.conclusion.includes('已属大涨'), `结论明说「已属大涨」（实际：${r.conclusion.slice(0, 60)}…）`);
ok(r.conclusion.includes('方向性上涨'), '结论明说「方向性上涨、不是价格不跌」');
ok(!r.conclusion.includes('仅小阴小阳震荡或重心企稳：大量筹码'), '不再出现「仅小阴小阳震荡或重心企稳」的命中语');
ok(r.trackHint === '', '未命中时不输出跟踪提示');

// ============================================================================
// [2] 真正的「不跌」：小阴小阳（含微涨/微跌）→ 命中
// ============================================================================
console.log('\n[2] 小阴小阳震荡 → 命中');
[
  [0.6, '+0.60% 微涨'],
  [-0.5, '−0.50% 微跌'],
  [1.0, '+1.00% 小阳'],
  [-1.1, '−1.10% 小阴'],
  [0, '0.00% 平盘'],
].forEach(([chg, label]) => {
  const x = ruleAt(mkPc({ chgPct: chg }));
  ok(x.matched === true, `${label} 命中（|涨跌幅| < 1.2%）`);
});

// ============================================================================
// [3] 超过 1.2% 的方向性动作（大涨/大跌）→ 不命中
// ============================================================================
console.log('\n[3] 方向性动作（|涨跌幅| ≥ 1.2%）→ 不命中');
[
  [1.2, '+1.20% 临界大涨'],
  [1.5, '+1.50% 大涨'],
  [-1.5, '−1.50% 大跌'],
  [-3.2, '−3.20% 大跌'],
].forEach(([chg, label]) => {
  const x = ruleAt(mkPc({ chgPct: chg }));
  ok(x.matched === false, `${label} 不命中`);
});

// ============================================================================
// [4] 「重心企稳」不能豁免当日大涨（关键回归）
// ============================================================================
console.log('\n[4] 近 3 日重心上移 + 当日大涨 → 仍不命中');
{
  const closes = new Array(30).fill(10); closes[29] = 10.5; closes[27] = 10; // 重心上移
  const x = ruleAt(mkPc({ chgPct: 3.41, closes }));
  ok(x.matched === false, '重心上移也不把 +3.41% 判成「不跌」（大涨就是大涨）');
}
{
  const closes = new Array(30).fill(10); closes[29] = 10.05; closes[27] = 10; // 重心企稳 + 微涨
  const x = ruleAt(mkPc({ chgPct: 0.5, closes }));
  ok(x.matched === true, '重心企稳 + 微涨 仍正常命中');
  ok(x.conclusion.includes('重心企稳') || x.conclusion.includes('小阴小阳'), '命中文案写明「重心企稳」或「小阴小阳」');
}

// ============================================================================
// [5] 其它边界：新低 / 非低位 / 未放量 → 不命中
// ============================================================================
console.log('\n[5] 边界');
ok(ruleAt(mkPc({ chgPct: 0.5, lowToday: 9.7 })).matched === false, '创近 20 日新低 → 不命中');
ok(ruleAt(mkPc({ chgPct: 0.5 }), '上涨中途').matched === false, '非低位区间 → 不命中');
ok(ruleAt(mkPc({ chgPct: 0.5, level: '平量', ratio5: 0.9 })).matched === false, '未放量（平量、量比 0.9）→ 不命中');

// ============================================================================
// [6] 源码守卫：旧豁免已删、阈值与 isStagnant 对齐
// ============================================================================
console.log('\n[6] 源码守卫');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
ok(!src.includes('(t.isStagnant || (pc.chgPct !== null && pc.chgPct > 0))'), '旧的 `chgPct > 0` 豁免已删除');
ok(src.includes('const lhSmallOsc'), '新条件使用 lhSmallOsc（|涨跌幅| < 1.2%）');
ok(src.includes('LH_FLAT_PCT = 1.2'), '阈值常量 LH_FLAT_PCT = 1.2');
ok(src.includes('已属大涨'), '大涨时给出明确未命中原因');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
