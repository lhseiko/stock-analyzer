/**
 * 「量能活跃与量价配合」最新日 + 沪深双市 回归（20261023o）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_volume_latest_day.js
 *
 * 用户要求（2026-10-23）：
 *   「量能活跃与量价配合卡片所有口径改成最新日的数据，不再适用5日数据，还要同时分析深市的数据。」
 *
 * 口径：
 *   价格 = 今日涨跌（今收 vs 昨收），不是 5 日；
 *   量能 = 今日量 ÷ 近 20 日均量（不含今日），并用 放量>1.2 / 缩量<0.8 / 平量 分档（20261024b 对齐项目「量比」铁律 _volumeTier；旧值 1.5/0.7 已废弃）；
 *   量价配合 = 今日价格方向 × 今日量能档位（平量单独成「量平价涨/量平价跌」，不再强行算「量升」）；
 *   沪深 = 上证（sh000001）+ 深证成指（sz399001），各自打分后取均值；深市缺失按上证单市降级。
 *
 * 隔离：旧 calcVolumeActivity / calcPriceVolume（5日/3日）保持不变，
 *   供大盘技术分析页与 test_market_volume_root_migration 等价性守卫；本测试只测新函数。
 */
const fs = require('fs');
const path = require('path');
const m = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function bars(ratioPct, chgPct) {
  const arr = [];
  for (let i = 0; i < 20; i++) arr.push({ date: '2026-09-' + String(i + 1).padStart(2, '0'), close: 100, vol: 5.5e8 });
  const close = +(100 * (1 + chgPct / 100)).toFixed(2);
  arr.push({ date: '2026-10-23', close, vol: 5.5e8 * (ratioPct / 100) });
  return arr;
}
function mkD(shRatio, shChg, szRatio, szChg, breadth) {
  return {
    index: { bars: bars(shRatio, shChg) },
    indexSZ: szRatio == null ? null : { bars: bars(szRatio, szChg) },
    breadth: breadth || { up: 3000, down: 2000 },
  };
}

// ============================================================================
// [1] 用户截图场景（20261024b 修复验证）：上证 1.21 必须判「放量」
//     旧 1.5/0.7 阈值会误判「量比 1.21（平量）」，与项目「量比>1.2=放量」铁律自相矛盾。
// ============================================================================
console.log('\n[1] 用户截图场景：量比 1.21 → 放量（20261024b 修复）');
{
  const d = mkD(121, 0.89, 108, 2.79); // 上证 1.21 放量涨 / 深证 1.08 平量涨
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  // 关键断言：1.21 > 1.2 必须判放量（用户 2026-10-24 报障：原显示「量比 1.21（平量）」自相矛盾）
  ok(/上证 1\.21（放量）/.test(va.value), `上证 1.21 现判「放量」（实际 ${va.value}）`);
  ok(/深证 1\.08（平量）/.test(va.value), `深证 1.08 判「平量」（实际 ${va.value}）`);
  ok(va.state === '平量' && Math.abs(va.ratio - 1.145) < 0.01, `综合量比≈1.145 → 平量（实际 ${va.ratio.toFixed(3)}/${va.state}）`);
  ok(pv.shPv && pv.shPv.volState === '放量' && /量价齐升/.test(pv.shPv.label), '上证侧 = 放量上涨（量价齐升）');
  ok(pv.szPv && pv.szPv.volState === '平量' && /量平价涨/.test(pv.szPv.label), '深证侧 = 平量上涨（量平价涨）');
  ok(pv.score === 0.5, `量价配合合成得分=0.5（实际 ${pv.score}）`);
  ok(Math.abs(vp.score - 0.2) < 0.001, `卡片合成得分=0.2（实际 ${vp.score}）`);
  ok(/最新日量价（上证/.test(pv.detail), 'detail 标明双市框架「最新日量价（上证 + 深证）」');
}

// ============================================================================
// [1a] 两市均为「平量价涨」→ 不误判「量升」（基准情景，隔离回归）
// ============================================================================
console.log('\n[1a] 两市平量价涨（基准情景）');
{
  const d = mkD(100, 0.89, 100, 2.79);
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  ok(va.score === 0 && va.state === '平量', `量能活跃度=0/平量（实际 ${va.score}/${va.state}）`);
  ok(pv.score === 0 && /量平价涨/.test(pv.label), `量价配合=0/量平价涨（实际 ${pv.score}/${pv.label}）`);
  ok(m.calcVolumePrice(d).score === 0, '合成得分=0');
}

// ============================================================================
// [2] 两市放量齐升 → 量价齐升 +1
// ============================================================================
console.log('\n[2] 两市放量齐升');
{
  const d = mkD(160, 0.89, 160, 2.79);
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  ok(va.score === 1 && va.state === '放量', '量能活跃度=+1/放量');
  ok(pv.score === 1 && /量价齐升/.test(pv.label), '量价配合=+1/量价齐升');
  ok(m.calcVolumePrice(d).score === 1, '合成得分=+1');
}

// ============================================================================
// [3] 两市放量齐跌（宽度也是普跌）→ 量升价跌 -1
// ============================================================================
console.log('\n[3] 两市放量齐跌');
{
  const d = mkD(160, -0.5, 160, -0.5, { up: 2000, down: 3000 });
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  ok(pv.score === -1 && /量升价跌/.test(pv.label), `量价配合=-1/量升价跌（实际 ${pv.score}/${pv.label}）`);
  ok(va.score === -1, '量能活跃度=-1（放量+普跌）');
  ok(m.calcVolumePrice(d).score < 0, '合成得分为负');
}

// ============================================================================
// [4] 沪深分化：上证放量涨 / 深证放量跌 → 配合度 0 + 明确「沪深分化」
// ============================================================================
console.log('\n[4] 沪深分化');
{
  const d = mkD(160, 0.5, 160, -0.5);
  const pv = m.calcPriceVolumeLatest(d);
  ok(pv.score === 0, `配合度=0（实际 ${pv.score}）`);
  ok(pv.label === '沪深分化', `label=沪深分化（实际 ${pv.label}）`);
  ok(/上证 今日 \+0\.5%/.test(pv.value) && /深证 今日 -0\.5%/.test(pv.value), 'value 分别列出上证/深证');
}

// ============================================================================
// [5] 深市缺失 → 上证单市降级，不伪造深市（上证用平量 100，不因深市缺失误判）
// ============================================================================
console.log('\n[5] 深市缺失');
{
  const d = mkD(100, 0.5, null, null);
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  ok(/深证 缺失/.test(va.value), 'va.value 明示「深证 缺失」');
  ok(/仅单市/.test(pv.label), `label 标「仅单市」（实际 ${pv.label}）`);
  ok(va.score === 0 && pv.score === 0, '单市平量仍能给出 0 分（不因深市缺失而误判）');
}
{
  const d = mkD(100, 0.5, 0, 0); // 深市 0 成交量 → 视为不可用
  const va = m.calcVolumeActivityLatest(d);
  ok(/深证 缺失/.test(va.value), '深市 0 成交量 → 按缺失处理');
}

// ============================================================================
// [6] 源码守卫
// ============================================================================
console.log('\n[6] 源码守卫');
const ms = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');
const md = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionData.js'), 'utf8');
const mt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechnical.js'), 'utf8');
ok(/function calcVolumeActivityLatest/.test(ms), '定义了 calcVolumeActivityLatest');
ok(/function calcPriceVolumeLatest/.test(ms), '定义了 calcPriceVolumeLatest');
ok(/calcVolumeActivityLatest\(d\)/.test(ms) && /calcPriceVolumeLatest\(d\)/.test(ms), 'calcVolumePrice 已切到最新日函数');
ok(/最新日 · 上证\+深证/.test(ms), 'detail 口径标「最新日 · 上证+深证」');
// [20261024b] 阈值对齐守卫：三处量能分档均使用 1.2/0.8（非旧 1.5/0.7）
ok(/ratio > 1\.2 \? '放量'/.test(ms), '量能分档统一 >1.2 放量（_latestDayMetrics）');
ok(/ratio > 1\.2 \? '放量'/.test(ms), '量能分档统一 >1.2 放量（calcVolumeActivityLatest）');
ok(/ratio > 1\.2\) \{ score = 1; state = '放量'/.test(ms), '量能分档统一 >1.2 放量（calcVolumeActivity 旧函数亦对齐）');
ok(/ratio < 0\.8 \? '缩量'/.test(ms), '量能分档统一 <0.8 缩量（与 _volumeTier 铁律一致）');
// 注：line 566-567 的 ratio > 1.5 属主力资金净流入比率（另一指标），非量比，不在此守卫范围。
ok(/indexSZ/.test(md), 'getMarketEmotionData 注入 indexSZ（深证成指）');
ok(/fetchIndexDailyBars\(320, 'sz399001'\)/.test(md), '深证走同一量能根通道');
ok(/async function fetchIndexDailyBars\(count = 320, code = 'sh000001'\)/.test(mt), 'fetchIndexDailyBars 支持 code');
// 旧函数仍在（技术页/根迁移守卫）
ok(/function calcVolumeActivity\(d\)/.test(ms) && /function calcPriceVolume\(d\)/.test(ms), '旧 5日/3日函数保留（隔离）');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
