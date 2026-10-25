/**
 * 「数据不足」与「来源/口径说明」分类回归（20261023f）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_volume_gap_label.js
 *
 * 用户报障（2026-10-23 截图）：「数据不足标注，修复。」
 * 截图里 5 条全部塞在红色「数据不足（结论置信度受限）」框，但其中只有 1 条是真缺口：
 *   ① 历史段成交额/换手率推算值（真缺口）
 *   ② 分时尚未覆盖收盘（时间说明）
 *   ③ 日K数据源降级同花顺（来源说明）
 *   ④ 当日 bar 按腾讯覆写（口径说明）
 *   ⑤ 量比取自腾讯直采（口径说明）
 *
 * 本次两件事：
 *   A. 成交额回填改用腾讯「不复权」收盘价（与交易所同口径，实测偏差 <1%），
 *      对应条目从「推算值」降级为「来源与口径说明」；
 *   B. 前端按 TRUE_GAP_RE 把「真缺口」与「来源说明」分成两个框，红框只留真缺口。
 */
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');
const sd = require('../lib/stockData');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function dstr(i) {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
function mkBars(n, basis) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      date: dstr(i), open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000,
      amount: i < 100 ? 0 : 10000, turnover: 1,
      ...(i < 100 ? { amountEstimated: true, amountBasis: basis } : {}),
    });
  }
  return arr;
}

// ============================================================================
// [1] 引擎：raw_close → 来源说明，不再出现「推算值」
// ============================================================================
console.log('\n[1] 引擎 gap 文案：raw_close vs qfq_close');
{
  const pcRaw = ve._precompute(mkBars(260, 'raw_close'));
  const gapsRaw = pcRaw.dataGaps || [];
  ok(gapsRaw.some(g => /不复权收盘价/.test(g)), 'raw_close → 出现「不复权收盘价还原」说明');
  ok(!gapsRaw.some(g => /推算值/.test(g)), 'raw_close → 不再出现「推算值」字样');
  ok(gapsRaw.some(g => /不影响结论/.test(g)), 'raw_close → 明示「不影响结论」');

  const pcQfq = ve._precompute(mkBars(260, 'qfq_close'));
  const gapsQfq = pcQfq.dataGaps || [];
  ok(gapsQfq.some(g => /推算值/.test(g)), 'qfq_close（回退）→ 保留「推算值」提示');
}

// ============================================================================
// [2] 前端分类正则：红框只留真缺口
// ============================================================================
console.log('\n[2] TRUE_GAP_RE 分类（与 app.js 同式）');
{
  const TRUE_GAP_RE = /数据不足|样本仅|不足 ?250|推算值|未包含今日|未包含最近交易日|窗口仅/;
  const samples = [
    ['历史段成交额按「不复权收盘价 × 成交量」还原（实测与交易所成交额偏差通常 <1%）；换手率按流通盘推算（实测与交易所口径一致）——属来源与口径说明，不影响结论', false],
    ['历史段成交额/换手率为推算值（按近 140 根反推流通盘 + 收盘价估算），跨除权日可能有数%偏差', true],
    ['分时尚未覆盖收盘，「尾盘突然放量拉升」无法判定', false],
    ['日K数据源：同花顺日K（近期含成交额/换手率，历史段仅OHLCV）（东财通道不可达，已自动降级）', false],
    ['当日 bar 原为「ths」通道快照（close 34.64 / 量 15099340），已按腾讯实时行情终值覆写（close 34.46 / 量 21057200）', false],
    ['量比 1.82 取自腾讯实时行情直采（fields[49]），非本地工作台重算', false],
    ['换手率数据不足（当前日K通道无换手率字段），天量确认降级', true],
    ['成交额样本仅 160 天（不足250），250日分位按可用样本计算', true],
    ['日K最新一根为 2026-10-22，未包含今日数据', true],
    ['日K最新一根为 2026-10-22，未包含最近交易日 2026-10-23 的数据（该股可能停牌，或当日K线通道延迟更新）——量能结论基于 2026-10-22', true],
    ['今日 2026-10-24 为非交易日（周末/节假日），量能结论基于最近交易日 2026-10-23 收盘数据（数据已更新至最新交易日）', false],
  ];
  samples.forEach(([msg, expectGap], i) => {
    ok(TRUE_GAP_RE.test(msg) === expectGap, `样本 ${i + 1} → ${expectGap ? '真缺口(红框)' : '来源说明(中性框)'}：${msg.slice(0, 26)}…`);
  });
}

// ============================================================================
// [3] stockData：raw close 回填 + 回退标注
// ============================================================================
console.log('\n[3] _backfillThsFields：raw_close / qfq_close');
{
  const plain = [];
  for (let i = 260; i < 400; i++) plain.push({ date: dstr(i), open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000, amount: 10000, turnover: 10 });
  const bars = [{ date: dstr(0), open: 10, high: 10.1, low: 9.9, close: 10, volume: 500, amount: 0, turnover: 0 }];
  const raw = new Map([[dstr(0), 10.3]]);
  const withRaw = sd._backfillThsFields([{ ...bars[0] }], plain, raw);
  ok(withRaw[0].amount === 5150, `有 rawClose → amount=5150（实际 ${withRaw[0].amount}）`);
  ok(withRaw[0].amountBasis === 'raw_close', 'amountBasis=raw_close');
  const noRaw = sd._backfillThsFields([{ ...bars[0] }], plain, null);
  ok(noRaw[0].amount === 5000, `无 rawClose → 回退 5000（实际 ${noRaw[0].amount}）`);
  ok(noRaw[0].amountBasis === 'qfq_close', 'amountBasis=qfq_close');
  ok(typeof sd.fetchTencentRawCloseMap === 'function', 'fetchTencentRawCloseMap 已导出');
}

// ============================================================================
// [4] 源码守卫
// ============================================================================
console.log('\n[4] 源码守卫');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const sdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stockData.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
ok(appSrc.includes('TRUE_GAP_RE'), 'app.js 使用 TRUE_GAP_RE 分类');
ok(appSrc.includes('数据不足（影响结论置信度）'), '红框标题改为「数据不足（影响结论置信度）」');
ok(appSrc.includes('ve-src-notes'), 'app.js 渲染来源说明框 ve-src-notes');
ok(cssSrc.includes('.ve-src-notes'), 'CSS 有 .ve-src-notes');
ok(sdSrc.includes('fetchTencentRawCloseMap'), 'stockData 定义腾讯不复权映射');
ok(sdSrc.includes("amountBasis = useRaw ? 'raw_close' : 'qfq_close'"), '回填按 raw/qfq 标注');
ok(sdSrc.includes('day,,,${count},'), '腾讯不复权请求不带 qfq');

// ============================================================================
// [5] _staleBarGapText 交易日感知（20261024f 用户周六截图假缺口）
// ============================================================================
console.log('\n[5] _staleBarGapText 交易日感知（周末/节假日不误报真缺口）');
{
  const TRUE_GAP_RE = /数据不足|样本仅|不足 ?250|推算值|未包含今日|未包含最近交易日|窗口仅/;
  const saturday = '2026-10-24'; // 周六（非交易日）
  const friday = '2026-10-23';   // 星期五（最近交易日）
  const thursday = '2026-10-22'; // 星期四

  ok(ve._staleBarGapText(friday, saturday) !== null, '_staleBarGapText 已导出可调用');

  const t1 = ve._staleBarGapText(friday, saturday);
  ok(/非交易日/.test(t1) && /最近交易日 2026-10-23/.test(t1), '周六 + 末根=周五 → 中性「非交易日，基于最近交易日收盘」说明');
  ok(!TRUE_GAP_RE.test(t1), '周六 + 末根=周五 → 不算真缺口（不进红框）');

  const t2 = ve._staleBarGapText(thursday, saturday);
  ok(/未包含最近交易日 2026-10-23/.test(t2), '周六 + 末根=周四 → 真缺口「未包含最近交易日 10-23」');
  ok(TRUE_GAP_RE.test(t2), '周六 + 末根=周四 → 属真缺口（进红框）');

  const t3 = ve._staleBarGapText(thursday, friday);
  ok(/未包含今日数据/.test(t3), '交易日（周五）+ 末根=周四 → 原「未包含今日数据」口径不变');
  ok(TRUE_GAP_RE.test(t3), '交易日缺今日 → 真缺口');

  ok(ve._staleBarGapText('', saturday) === null, '空 lastD → null（不 push 缺口）');
  // 非交易日边界：长假后首日（2026-10-08 周四，前一交易日 2026-09-30 周三）
  const t4 = ve._staleBarGapText('2026-09-30', '2026-10-08');
  ok(/未包含今日数据/.test(t4), '节后交易日（10-08）+ 末根=节前 → 「未包含今日数据」');
  const t5 = ve._staleBarGapText('2026-09-30', '2026-10-03');
  ok(/非交易日/.test(t5) && /最近交易日 2026-09-30/.test(t5), '国庆假期（10-03 周六）+ 末根=节前最近交易日 09-30 → 中性说明');
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
