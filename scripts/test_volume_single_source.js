'use strict';
/**
 * 量能判定「单一真值源 / 基准可比性」守卫（20261109c）
 * =====================================================================
 * 运行： node scripts/test_volume_single_source.js
 *
 * 背景（用户 2026-11-09 两张截图，威高血净 603014，行情日 2026-11-09）：
 *   同屏「第三步 · 量能 × 涨跌幅」显示「放量 + 下跌 · 当日量/20日均量 1.47」，
 *   「生死位特殊提醒」却显示「判定为无量假突破形态……前高对应量能 265682 手
 *   （2025-05-19，阶段高点 48.44），20 日均量 19382 ×1.5 = 29073 手，量能未有效放大」。
 * 根因：20261106j 的「分母统一 ÷20」漏改异常特例层——规则3 仍用 AMP_CONFIRM=1.5
 *   + 「当日量 > 前高对应量能」第二套判据；且前高取全窗口全局最高价那天，
 *   必然选到上市初期天量 + 远价位（2026-11-09 股价 ~35，却有 ~38 的同价位前高不用）。
 *
 * 本守卫四层：
 *   L1 静态契约（阈值唯一来源 / 无第二套常量 / 版本戳）
 *   L2 _pickRefHigh 基准可比性纯函数（同价位带 / 时间最近 / 上市保护 / 除权断点 / 极端异常量）
 *   L3 端到端复刻 1.47 夹缝：主判放量时规则3 不得命中、不得出现「缩量」措辞
 *   L4 前高量能仅作参照（今日量 < 前高量能也不得命中）+ 全个股统一 + 阈值扫描无互斥
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ve = require('../lib/volumeEngine');
const cal = require('../lib/volumeCaliber');
const { computeVolumeIndicators } = require('../lib/capitalFlow');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function section(s) { console.log('\n' + s); }
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const VEC = read('lib/volumeEngine.js');
const CFS = read('lib/capitalFlow.js');
const APP = read('public/js/app.js');
const SVR = read('server.js');
const SJD = read('lib/sameDayJudgment.js');
const IDX = read('public/index.html');
const ETF = read('public/etf-flow.html');
const DRV = read('public/daily-review.html');

// =====================================================================
section('L1 静态契约：全引擎只有一个量能标准');
// =====================================================================
ok(cal.VOL_AMP === 1.3 && cal.VOL_SHRINK === 0.8, 'volumeCaliber 唯一阈值：放量 >1.3 / 缩量 <0.8');
ok(typeof cal.isAmpRatio === 'function' && typeof cal.isShrinkRatio === 'function' && typeof cal.tierOfRatio === 'function', '导出三个判定入口（isAmpRatio / isShrinkRatio / tierOfRatio）');
ok(cal.isAmpRatio(1.3) === false && cal.isAmpRatio(1.31) === true, '1.30 = 平量、1.31 = 放量（严格 >1.3）');
ok(cal.isShrinkRatio(0.8) === false && cal.isShrinkRatio(0.79) === true, '0.80 = 平量、0.79 = 缩量（严格 <0.8）');
ok(cal.isAmpRatio(null) === false && cal.isAmpRatio(NaN) === false && cal.isShrinkRatio(undefined) === false, '数据不足一律 false（不臆造、fail-open 不判）');
ok(cal.tierOfRatio(1.47) === '放量' && cal.tierOfRatio(1) === '平量' && cal.tierOfRatio(0.75) === '缩量' && cal.tierOfRatio(null) === null, '三态档位与 135 格同源');
ok(Math.abs(cal.ratioOfVol(1470, 1000) - 1.47) < 1e-9 && cal.ratioOfVol(100, 0) === null, 'ratioOfVol 分母为 0 时返回 null');
ok(VEC.includes("require('./volumeCaliber')"), 'volumeEngine 引入唯一真值源模块');
ok(CFS.includes("require('./volumeCaliber')"), 'capitalFlow 引入同一真值源模块');
ok(!/const AMP_CONFIRM\s*=/.test(VEC) && !/const SHRINK_CONFIRM\s*=/.test(VEC), '旧 AMP_CONFIRM=1.5 / SHRINK_CONFIRM=0.7 常量已退役（不再有第二套阈值）');
ok(!/avg20\s*\*\s*1\.5/.test(VEC) && !/avg20\s*\*\s*0\.7/.test(VEC), '引擎内不再有 avg20 ×1.5 / ×0.7 比较点');
ok(!/×1\.5\s*=/.test(VEC) && !/×0\.7\s*=/.test(VEC), '引擎文案不再展示 ×1.5 / ×0.7 阈值');
ok(VEC.includes('const amplified = isAmpRatio(ratio20);') && VEC.includes('const shrunk = isShrinkRatio(ratio20);'), '_volumeTier 接入真值源');
ok(VEC.includes('if (isAmpRatio(ratio20))') && VEC.includes('else if (isShrinkRatio(ratio20))'), '_volTier5 接入真值源（135 格归格同源）');
ok(VEC.includes("name: '假突破量能不确认'"), '规则3 显示名改为中性表述（不再写「缩量假突破」）');
ok(VEC.includes('const ampOk = volumeDataOk && isAmpRatio(ratio20);'), '规则3 唯一判据 = ÷20 量能比是否放量');
ok(!/const ampOk = \(vol, refVol\)/.test(VEC) && !/let pH = -Infinity/.test(VEC) && !/refVol = bars\[pi\]\.volume/.test(VEC),
  '「当日量 > 前高量能」门槛与「全窗口全局最高价」扫描的活动代码已删除（历史注释不计）');
ok(VEC.includes('_pickRefHigh(bars, n, touchPrice)') && VEC.includes('仅作参照、不参与判定'), '前高量能降级为展示参照');
ok(VEC.includes("riskTags.push('假突破量能不确认', 'K线骗线')"), '风险标签与规则名同步');
ok(!/dayVolRatio\s*>=\s*1\.2/.test(CFS) && !/volRatio\s*>=\s*1\.2/.test(CFS) && !/breakoutVolRatio\s*>=\s*1\.2/.test(CFS), 'capitalFlow 的 ÷20 回退阈值不再有 1.2 第二套标准');
ok(APP.includes('异常特例层') && APP.includes('同价位带最近前高') && APP.includes('lib/volumeCaliber.js'), 'app.js 口径说明补全覆盖范围（不再只声明三处）');
ok(VEC.includes("schema: 'volume-engine-20261109c'"), '引擎 schema 已升 20261109c（强制重算旧判断）');
ok(SVR.includes("const APP_VERSION = '20261111d'"), 'APP_VERSION 已升 20261111d（[20261111d] 删除策略回测模块：strategyGenerator/strategyNL/backtestValidator/backtestUI 及 3 测试，「策略」tab 移除）');
ok(SJD.includes("const LAYOUT_VERSION = '20261109c'"), 'LAYOUT_VERSION 保持 20261109c（本轮未改判断结构，不强制重算当日判断记录）');
ok(IDX.includes('js/app.js?v=20261111d') && IDX.includes('js/capitalCharts.js?v=20261111d') && IDX.includes('css/style.css?v=20261111d')
  && ETF.includes('?v=20261111d') && DRV.includes('css/style.css?v=20261111d') && DRV.includes('js/markdown.js?v=20261111d') && DRV.includes('js/dailyReview.js?v=20261111d'), '各 HTML 的 ?v= 缓存戳同步（index 升 20261111d；etf-flow 保持 20261110b；daily-review 差异戳 markdown.js 20261110c / dailyReview.js 20261110d）');
ok(!VEC.includes("'603014'") && !VEC.includes('"603014"'), '引擎内无「威高血净 603014」单只特例（全个股统一）');

// =====================================================================
section('L2 基准可比性：同价位带 + 时间最近 + 上市/除权/异常值剔除');
// =====================================================================
function baseBars(n = 260, price = 35, vol = 19382) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    open: price, high: price + 0.1, low: price - 0.1, close: price,
    volume: vol, amount: price * vol * 100, turnover: 1.2,
  }));
}
function peakAt(bars, i, high, vol, date) {
  bars[i] = Object.assign({}, bars[i], { date: date || bars[i].date, open: 35, high, low: 34.9, close: high - 0.2, volume: vol });
  return bars;
}
{
  const bars = baseBars();
  bars[3] = Object.assign({}, bars[3], { date: '2025-05-19', open: 35, high: 48.44, low: 35, close: 47.9, volume: 265682 });
  peakAt(bars, 150, 38.0, 40000, '2026-06-17');
  const ref = ve._pickRefHigh(bars, bars.length, 36.5);
  ok(!!ref, '同价位带内找到有效局部前高');
  ok(ref && ref.date === '2026-06-17', `取时间最近的同价位带前高 2026-06-17（实际 ${ref && ref.date}）`);
  ok(ref && ref.volume === 40000 && ref.volume !== 265682, '不再取上市首日天量 265682 手');
  ok(ref && Math.abs(ref.price - 48.44) > 1, '不再取全历史全局最高价 48.44（与当前 ~35 价位不可比）');
  ok(ref && Math.abs(ref.price - 36.5) / 36.5 <= cal.REF_PRICE_BAND_PCT, '前高落在触及线 ±10% 价位带内');
}
{
  const bars = baseBars();
  peakAt(bars, 100, 38.0, 22000, '2026-04-10');
  peakAt(bars, 200, 37.2, 23000, '2026-08-20');
  const ref = ve._pickRefHigh(bars, bars.length, 36.5);
  ok(ref && ref.date === '2026-08-20', `多个同价位带前高时取时间最近（实际 ${ref && ref.date}）`);
}
{
  const bars = baseBars();
  peakAt(bars, 100, 38.0, 22000, '2026-04-10');
  bars[220] = Object.assign({}, bars[220], { close: 12, open: 12, high: 12.1, low: 11.9 }); // 除权/股本断点
  const ref = ve._pickRefHigh(bars, bars.length, 36.5);
  ok(ref === null, '除权断点之前的样本被剔除，且不回退到全局最高价（诚实返回 null）');
}
{
  const bars = baseBars();
  peakAt(bars, 150, 38.0, 265682, '2026-06-17'); // 极端异常量（> 同价位带中位数 ×4）
  peakAt(bars, 120, 37.5, 22000, '2026-05-18');
  const ref = ve._pickRefHigh(bars, bars.length, 36.5);
  ok(ref && ref.date === '2026-05-18' && ref.volume !== 265682, '极端异常量样本被剔除，退取次近有效前高');
}
{
  const bars = baseBars();
  ok(ve._pickRefHigh(bars, bars.length, 36.5) === null, '平台无局部高点 → 返回 null（不硬造前高）');
  peakAt(bars, 1, 38.0, 22000, '2025-05-16');
  ok(ve._pickRefHigh(bars, bars.length, 36.5) === null, '上市初期前 5 根被保护线剔除');
}

// =====================================================================
section('L3 端到端复刻：ratio20=1.47 夹缝不再同屏互斥（威高血净 2026-11-09）');
// =====================================================================
function weigao(ratio, extra) {
  const n = 260, base = 19382, price = 35;
  const bars = baseBars(n, price, base);
  bars[3] = Object.assign({}, bars[3], { date: '2025-05-19', open: 35, high: 48.44, low: 35, close: 47.9, volume: 265682 });
  peakAt(bars, 150, 38.0, 40000, '2026-06-17'); // 前高量能 40000 > 当日量 28491，旧门槛会假命中
  bars[n - 1] = Object.assign({}, bars[n - 1], {
    date: '2026-11-09', open: 35.2, high: 36.8, low: 34.7, close: 34.9,
    volume: Math.round(base * ratio),
  });
  const input = Object.assign({
    symbol: '603014', name: '威高血净', bars, minutes: null, blacklistReasons: [],
    levelHints: { resistance: { low: 36.5, high: 37.5, kind: '短期动向·阻力区间' } },
  }, extra || {});
  return ve.computeVolumeEngine(input);
}
{
  const r = weigao(1.47);
  ok(Math.abs(r.volumeState.ratio20 - 1.47) < 0.01, `当日量 ÷ 20 日均量 = 1.47（实际 ${r.volumeState.ratio20}）`);
  ok(r.volumeTier.tier === '放量' && r.volumeTier.amplified === true, '主轴「量能档位」判放量');
  ok(r.posJudgment.volume.tier === '放量', '135 格「第三步 · 量能 × 涨跌幅」判放量（与主轴同源）');
  ok(r.rules[2].matched === false, '★ 生死位特殊提醒不再命中「无量假突破」（旧版此处必命中）');
  ok(!/缩量|量能未有效放大|无量假突破/.test(r.rules[2].conclusion), '★ 同屏结论不再出现「缩量 / 量能未有效放大」互斥措辞');
  ok(r.rules[2].name === '假突破量能不确认', '规则名为中性表述');
  ok(!r.riskTags.includes('缩量假突破') && !r.riskTags.includes('假突破量能不确认') && !r.riskTags.includes('K线骗线'), '放量日不再打假突破/骗线风险标签');
  ok(r.rules[2].dataGaps.some(g => /量能已有效放大/.test(g)), 'dataGaps 正向说明「量能已有效放大」');
  ok(r.schema === 'volume-engine-20261109c', '输出 schema 为 20261109c');
  ok(!/2025-05-19|265682|48\.44/.test(JSON.stringify(r.rules[2])), '规则3 输出中不含跨期跨价位的上市首日基准');
}
{
  // 平量日（1.0）仍应命中，且基准必须是同价位带最近前高，仅展示不参与判定
  const r = weigao(1.0);
  ok(r.volumeTier.tier === '平量', '平量日主轴判平量');
  ok(r.rules[2].matched === true, '平量且冲击阻力回落 → 规则3 照常命中（没有把阈值改松）');
  ok(r.rules[2].name === '假突破量能不确认', '命中时规则名仍为中性表述');
  ok(/同价位带最近前高对应量能/.test(r.rules[2].conclusion) && /2026-06-17/.test(r.rules[2].conclusion), '结论文案给出同价位带最近前高（2026-06-17）');
  ok(/仅作参照、不参与判定/.test(r.rules[2].conclusion), '文案明确「仅作参照、不参与判定」');
  ok(/20 日量能比 1 倍/.test(r.rules[2].conclusion) && /×1\.3 = \d+ 手/.test(r.rules[2].conclusion), '文案给出 ÷20 量能比与 ×1.3 阈值');
  ok(!/2025-05-19|265682|48\.44/.test(r.rules[2].conclusion), '结论文案不再引用上市首日天量与全局最高价');
  ok(!/×1\.5/.test(r.rules[2].conclusion), '结论文案不再出现 ×1.5 第二套阈值');
  ok(r.riskTags.includes('假突破量能不确认') && r.riskTags.includes('K线骗线'), '平量命中时风险标签同步改名');
}
{
  // 盘中停判 + ②卡区间不可得：诚实降级
  const ri = weigao(1.0, { intradayPending: true });
  ok(ri.rules[2].matched === false, '盘中停判不命中');
  ok(ri.rules[2].dataGaps.some(g => /盘中参考（不构成判定）/.test(g) && /同价位带/.test(g)), '盘中参考仍给出同价位带参照数值');
  const rn = ve.computeVolumeEngine({
    symbol: '603014', name: '威高血净', bars: (() => { const b = baseBars(); b[3] = Object.assign({}, b[3], { high: 48.44, volume: 265682 }); return b; })(),
    minutes: null, blacklistReasons: [],
  });
  ok(rn.rules[2].matched === false && rn.rules[2].dataGaps.some(g => /有效阻力区间不可得/.test(g)), '②卡区间不可得 → 诚实停判，不回退全局最高价');
}

// =====================================================================
section('L4 前高量能不参与判定 / 全个股统一 / 阈值扫描无互斥');
// =====================================================================
{
  // 前高量能 40000 手 > 当日 28491 手：旧规则「vol > refVol」必然假命中；新规则只看 ÷20 量能比
  const bars = baseBars();
  peakAt(bars, 150, 38.0, 40000, '2026-06-17');
  const ref = ve._pickRefHigh(bars, bars.length, 36.5);
  ok(ref && ref.volume === 40000 && 40000 > Math.round(19382 * 1.47), '构造：前高量能 40000 手 > 当日量 28491 手');
  const r = weigao(1.47);
  ok(r.rules[2].matched === false, '★ 当日量小于前高量能但已放量 → 仍不得命中（前高量能已不是判定门槛）');
}
{
  const cases = [
    { symbol: '603014', name: '威高血净' },
    { symbol: '600460', name: '士兰微' },
    { symbol: '603288', name: '海天味业' },
    { symbol: '000902', name: '新洋丰' },
  ];
  const rows = cases.map(c => {
    const r = weigao(1.47, { symbol: c.symbol, name: c.name });
    return { tier: r.volumeTier.tier, tier135: r.posJudgment.volume.tier, matched: r.rules[2].matched, name: r.rules[2].name };
  });
  ok(rows.every(x => x.tier === '放量' && x.tier135 === '放量' && x.matched === false && x.name === '假突破量能不确认'),
    '4 只不同个股同一形态结论完全一致（全个股统一、无单只特例）');
}
{
  const ratios = [0.6, 0.79, 0.8, 1.0, 1.25, 1.3, 1.301, 1.4, 1.47, 1.5, 2.0, 2.6];
  let consistent = true, noConflict = true, cfOk = true;
  const detail = [];
  for (const ratio of ratios) {
    const r = weigao(ratio);
    const tier = r.volumeTier.tier, tier135 = r.posJudgment.volume.tier;
    if (tier !== tier135) { consistent = false; detail.push(`${ratio}: ${tier} vs ${tier135}`); }
    if (tier === '放量' && (r.rules[2].matched || /缩量|量能未有效放大/.test(r.rules[2].conclusion))) {
      noConflict = false; detail.push(`${ratio}: 放量却命中假突破`);
    }
    // capitalFlow 降级路径的 trend 也必须与主判同向
    const base = 1000;
    const hist = Array.from({ length: 25 }, (_, i) => ({
      date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
      open: 50 + i * 0.02, high: 50.5 + i * 0.02, low: 49.5 + i * 0.02, close: 50 + i * 0.02,
      volume: i === 24 ? Math.round(base * ratio) : base, amount: (50 + i * 0.02) * base,
    }));
    const trend = computeVolumeIndicators(hist, null, null).indicators.latestVsPriorAvg.trend;
    // 用 capitalFlow 自己的原始量比（与引擎夹具取整基数不同，边界需各自计算）推导期望档位
    const cfRatio = Math.round(1000 * ratio) / 1000;
    const cfTier = cal.tierOfRatio(cfRatio);
    const want = cfTier === '放量' ? (cfRatio > 2 ? '放量' : '温和放量') : (cfTier === '缩量' ? '缩量' : 'normal');
    if (trend !== want) { cfOk = false; detail.push(`${ratio}: capitalFlow trend=${trend} 期望 ${want}`); }
    // 引擎输出 volumeState.ratio20 是「2 位小数展示值」，档位由未取整原值判定；此处按原值核对
    const engRatio = Math.round(19382 * ratio) / 19382;
    if (r.volumeTier.tier !== cal.tierOfRatio(engRatio)) { cfOk = false; detail.push(`${ratio}: 引擎档位与真值源不符`); }
  }
  ok(consistent, `12 个阈值点：量能档位与 135 格归格始终一致（${detail.join('; ') || '全一致'}）`);
  ok(noConflict, '12 个阈值点：判放量时规则3 从不命中、从不写「缩量」');
  ok(cfOk, `12 个阈值点：capitalFlow 降级 trend 与引擎档位均服从同一真值源（1.2~1.3 夹缝已消除）${detail.length ? ' | ' + detail.join('; ') : ''}`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
