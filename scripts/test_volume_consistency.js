/**
 * 量能跨卡一致性回归（20261017i）
 * --------------------------------------------------------------
 * 运行： node scripts/test_volume_consistency.js
 *
 * 背景（用户反馈）：个股页「资金量能」内三处量能结论互相矛盾——
 *   A「量价信号 = 缩量回调」（当日量 ÷ 前20日均量）
 *   B「量能热度 = 量能平稳」（近3日均量 ÷ 近20日均量，分子包含在分母内）
 *   C「量能分析·资金行为 = 平量下跌」（当日量 ÷ 5日均量 + 60日确认）
 * 实测 20 只样本 14 只（70%）出现互斥。根因是三套口径各自独立计算、无交叉校验。
 *
 * 修复：建立统一量能档位真值源 lib/volumeEngine.js _volumeTier，
 * capitalFlow 的 volumePriceSignal 与 heatLevel 改引自该档位，三者同源。
 *
 * 覆盖：
 *   [1] _volTriState 边界与 _comboEngine 的 amplified/shrunk 同源（1.3 / 0.7）
 *   [2] _volumeTier：tier 取判定档位 judgedLevel，与 amplified/shrunk 同式
 *   [3] 跨口径分歧如实标注（跨窗口 + 跨基准），不静默取一侧
 *   [4] capitalFlow 五档量能态全覆盖（huge/amp/flat/shrink/dry）→ signal + heatLevel
 *   [5] 未传 unifiedTier 时退回本地 20 日口径，行为与改动前一致（零副作用）
 *   [6] 端到端同源性：同一份 bars 跑引擎 + capitalFlow，A/B/C 三方量能方向一致
 *   [7] 单位换算：东财(股)/腾讯(手) 通道比值一致，绝对量按「手」归一
 *   [8] API 载荷：引擎内部 bars 不随接口下发
 *   [9] 引擎失败降级：unifiedTier 缺失时 computeVolumeIndicators 仍正常输出
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const VE = require(path.join(ROOT, 'lib', 'volumeEngine'));
const { computeVolumeIndicators } = require(path.join(ROOT, 'lib', 'capitalFlow'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
function group(name, fn) { console.log('\n[' + name + ']'); fn(); }

// 构造日K：base 为日常量，today 为当日量，n 为根数
function mkBars(n = 60, base = 1000, today = 1000, todayClose = null) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    arr.push({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 10, high: 10.3, low: 9.7,
      close: isLast && todayClose !== null ? todayClose : 10,
      volume: isLast ? today : base,
    });
  }
  return arr;
}

// 统一档位方向归一化（放量 / 平量 / 缩量）
function dirOf(text) {
  if (/放量|齐升|齐跌/.test(text || '')) return 'amp';
  if (/地量|缩量/.test(text || '')) return 'shrink';
  if (/平稳|平量|温和上涨|温和回调|显著下跌|平衡/.test(text || '')) return 'flat';
  return null;
}
function tierDir(tier) {
  if (/温和放量|大量|天量/.test(tier || '')) return 'amp';
  if (/极度缩量|温和缩量/.test(tier || '')) return 'shrink';
  if (/平量/.test(tier || '')) return 'flat';
  return null;
}

// ============================================================
group('1. _volTriState 边界与 _comboEngine 同源', () => {
  ok(VE._volTriState(1.31) === 'amp', 'ratio 1.31 → amp（>1.3，与 amplified 同式）');
  ok(VE._volTriState(1.3) === 'flat', 'ratio 1.30 → flat（边界取闭区间，与 amplified 一致）');
  ok(VE._volTriState(0.7) === 'flat', 'ratio 0.70 → flat（边界取闭区间，与 shrunk 一致）');
  ok(VE._volTriState(0.69) === 'shrink', 'ratio 0.69 → shrink（<0.7，与 shrunk 同式）');
  ok(VE._volTriState(null) === null, 'ratio 缺失 → null（不臆造）');
  ok(VE._volTriState(NaN) === null, 'ratio NaN → null（不臆造）');
});

// ============================================================
group('2. _volumeTier 与 amplified/shrunk 同式', () => {
  // 按 _precompute 的真实公式手搭 pc（judgedLevel 必须与 amplified/shrunk 同式，
  // 不可写死，否则测的就不是生产链路）
  const pc = (ratio5, ratio20, confirm) => {
    const amp = confirm === '放量' || ratio5 > 1.3;
    const shr = confirm === '缩量' || ratio5 < 0.7;
    let judgedLevel = '平量';
    if (amp) judgedLevel = ratio5 > 4 ? '天量' : (ratio5 > 2.5 ? '大量' : '温和放量');
    else if (shr) judgedLevel = ratio5 < 0.4 ? '极度缩量' : '温和缩量';
    return { level: '平量', judgedLevel, ratio5, ratio20, confirm };
  };

  const t1 = VE._volumeTier(pc(0.66, 0.7, '缩量'));
  ok(t1.shrunk === true && t1.amplified === false, 'ratio5 0.66 + 60日确认缩量 → shrunk=true');
  ok(tierDir(t1.tier) === 'shrink', `tier 取判定档位，方向为缩量（实际 ${t1.tier}）`);

  const t2 = VE._volumeTier(pc(1.6, 1.5, '放量'));
  ok(t2.amplified === true && t2.shrunk === false, 'ratio5 1.6 + 60日确认放量 → amplified=true');
  ok(tierDir(t2.tier) === 'amp', `tier 方向为放量（实际 ${t2.tier}）`);

  const t3 = VE._volumeTier(pc(1.0, 0.95, null));
  ok(t3.amplified === false && t3.shrunk === false, 'ratio5 1.0 且无确认 → 平量');

  // 关键回归：60日确认与 ÷5日均量档位冲突时，tier 必须跟随判定档位（与 combo 同源），
  // 否则会出现「量能档位=平量」却「资金行为=缩量上涨」的自相矛盾（600460/000902 实测触发）
  const t4 = VE._volumeTier({ level: '平量', judgedLevel: '温和缩量', ratio5: 0.88, ratio20: 1.0, confirm: '缩量' });
  ok(t4.tier === '温和缩量', '跨基准冲突：tier 取判定档位 温和缩量（非原始档位 平量）');
  ok(t4.shrunk === true && tierDir(t4.tier) === 'shrink', '跨基准冲突：tier 方向与 shrunk 判定一致');
  ok(t4.ratio5Level === '平量', 'ratio5Level 保留原始 ÷5日均量档位供追溯');
});

// ============================================================
group('3. 跨口径分歧如实标注（不静默取一侧）', () => {
  const okCase = VE._volumeTier({ level: '平量', judgedLevel: '平量', ratio5: 1.0, ratio20: 0.95, confirm: null });
  ok(okCase.consistent === true && okCase.divergenceNote === null, '两口径一致 → consistent=true，无分歧说明');

  const crossWin = VE._volumeTier({ level: '温和缩量', judgedLevel: '温和缩量', ratio5: 0.66, ratio20: 1.4, confirm: '缩量' });
  ok(crossWin.consistent === false, '跨窗口分歧（÷5日缩量 vs ÷20日放量）→ consistent=false');
  ok(/近20日水平明显回落/.test(crossWin.divergenceNote || ''), '跨窗口分歧说明标注了变化方向（回落）');

  const crossBasis = VE._volumeTier({ level: '平量', judgedLevel: '温和缩量', ratio5: 0.88, ratio20: 1.0, confirm: '缩量' });
  ok(crossBasis.consistent === false, '跨基准分歧（原始档位 vs 60日确认）→ consistent=false');
  ok(/对外口径取判定档位/.test(crossBasis.divergenceNote || ''), '跨基准分歧说明标注了取值依据');

  const bothGap = VE._volumeTier({ level: '平量', judgedLevel: '温和缩量', ratio5: 0.66, ratio20: 1.4, confirm: '缩量' });
  ok(/；/.test(bothGap.divergenceNote || ''), '两类分歧同时发生时都列出（不互相覆盖）');
});

// ============================================================
group('4. capitalFlow 五档量能态全覆盖（统一档位驱动）', () => {
  const tier = (ratio5, confirm, judged) => ({
    tier: judged, ratio5Level: judged, ratio5, ratio20: ratio5, confirm, basis: 'b',
    amplified: confirm === '放量' || ratio5 > 1.3,
    shrunk: confirm === '缩量' || ratio5 < 0.7,
    consistent: true, divergenceNote: null,
  });
  // 下跌样本（当日 -5%，触发 bigDown 细分）
  const bars = mkBars(60, 1000, 800, 9.5);
  const cases = [
    [3.0, '放量', '大量', '放量下跌', '显著放量', 'huge'],
    [1.6, '放量', '温和放量', '量价齐跌', '温和放量', 'amp'],
    [1.0, null, '平量', '显著下跌', '量能平稳', 'flat'],
    [0.66, '缩量', '温和缩量', '缩量下跌', '缩量', 'shrink'],
    [0.3, '缩量', '极度缩量', '地量下跌', '地量', 'dry'],
  ];
  for (const [r5, cf, jl, sig, heat, bucket] of cases) {
    const vi = computeVolumeIndicators(bars, null, null, { unifiedTier: tier(r5, cf, jl) });
    const vp = vi.volumePrice;
    ok(vp.signal === sig, `ratio5=${r5} → 量价信号「${sig}」（实际 ${vp.signal}）`);
    ok(vp.heatLevel === heat, `ratio5=${r5} → 量能热度「${heat}」（实际 ${vp.heatLevel}）`);
    ok(vp.unified && vp.unified.bucket === bucket, `ratio5=${r5} → bucket=${bucket}`);
    // 同卡一致性：signal 的量能方向必须与 heatLevel 一致
    ok(dirOf(vp.signal) === dirOf(vp.heatLevel), `ratio5=${r5} → 同卡一致（signal 与 heatLevel 同向）`);
  }

  // 上涨分支
  const upBars = mkBars(60, 1000, 800, 10.5);
  const viUp = computeVolumeIndicators(upBars, null, null, { unifiedTier: tier(0.66, '缩量', '温和缩量') });
  ok(viUp.volumePrice.signal === '缩量上涨', '上涨样本：ratio5=0.66 → 缩量上涨');
  const viUp2 = computeVolumeIndicators(upBars, null, null, { unifiedTier: tier(3.0, '放量', '大量') });
  ok(viUp2.volumePrice.signal === '放量上涨', '上涨样本：ratio5=3.0 → 放量上涨');
});

// ============================================================
group('5. 零副作用：未传 unifiedTier 时退回本地 20 日口径', () => {
  const bars = mkBars(60, 1000, 1500, 9.5); // 当日量 1500 > 20日均量 1000 → 量比 1.5
  const vi = computeVolumeIndicators(bars, null, null);
  const vp = vi.volumePrice;
  ok(vp.unified === null, '未接入引擎 → unified 为 null（前端退回 dayVolRatio 展示）');
  ok(vp.signal === '放量下跌', `本地口径仍生效：量比 1.5 → 放量下跌（实际 ${vp.signal}）`);
  // 注：本地 heatLevel 用「近3日均量 ÷ 近20日均量」= 1166.67/1000 ≈ 1.17 → 量能平稳。
  // 这正是旧口径的典型缺陷：当日量已达 20 日均量的 1.5 倍（显著放量），却因分子取近3日
  // 被前两日正常量稀释、且分子本身包含在分母内，最终判为「量能平稳」，与同卡
  // 「放量下跌」互斥。统一引自引擎档位后此分歧已消除（见第 4/6 组）。
  ok(vp.heatLevel === '量能平稳', `本地口径仍生效：heatLevel = 量能平稳（实际 ${vp.heatLevel}）`);
  ok(/量比1\.5/.test(vp.description), '本地口径描述保持原文案（含「量比x」）');

  // 传空 opts 也不得改变行为
  const vi2 = computeVolumeIndicators(bars, null, null, {});
  ok(vi2.volumePrice.signal === vp.signal && vi2.volumePrice.heatLevel === vp.heatLevel, '传空 opts 时行为不变');
});

// ============================================================
group('6. 端到端同源性：A / B / C 三方量能方向一致', () => {
  // 构造多组「跨口径易冲突」的量能形态，逐一验证三方一致
  const scen = [
    ['当日缩量·前两日放量', 60, 1000, 650, 9.5],
    ['当日放量·前两日缩量', 60, 1000, 2600, 9.5],
    ['全程平量', 60, 1000, 1000, 9.5],
    ['当日地量', 60, 1000, 200, 9.5],
    ['当日天量', 60, 1000, 6000, 9.5],
    ['上涨缩量', 60, 1000, 650, 10.5],
    ['上涨放量', 60, 1000, 2600, 10.5],
  ];
  for (const [name, n, base, today, close] of scen) {
    const bars = mkBars(n, base, today, close);
    const ve = VE.computeVolumeEngine({ bars, barsSource: 'tencent', symbol: '000000' });
    if (!ve.ok) { ok(false, `${name}：引擎应可计算`); continue; }
    const ut = ve.volumeTier;
    const vi = computeVolumeIndicators(bars, null, null, { unifiedTier: ut });
    const vp = vi.volumePrice;

    const a = dirOf(vp.signal);
    const b = dirOf(vp.heatLevel);
    const c = tierDir(ve.volumeState.level);
    ok(a === b, `${name}：A 量价信号 与 B 量能热度 同向（${vp.signal} / ${vp.heatLevel}）`);
    ok(b === c, `${name}：B 量能热度 与 C 引擎档位 同向（${vp.heatLevel} / ${ve.volumeState.level}）`);
    ok(a === c, `${name}：A 与 C 同向（${vp.signal} / ${ve.volumeState.level}）`);
    ok(!!vp.unified && vp.unified.tier === ve.volumeState.level, `${name}：unified.tier 等于引擎展示档位`);
  }
});

// ============================================================
group('7. 单位换算：不同通道比值一致，绝对量归一为「手」', () => {
  // 同一形态，东财通道（股）与腾讯通道（手），量能比值必须完全一致
  const shares = mkBars(60, 1_000_000, 650_000, 9.5);   // 股
  const lots = mkBars(60, 10_000, 6_500, 9.5);          // 手
  const veS = VE.computeVolumeEngine({ bars: shares, barsSource: 'eastmoney', symbol: '000000' });
  const veL = VE.computeVolumeEngine({ bars: lots, barsSource: 'tencent', symbol: '000000' });
  ok(veS.ok && veL.ok, '两通道引擎均可计算');
  ok(Math.abs(veS.volumeState.ratio5 - veL.volumeState.ratio5) < 1e-6,
    `÷5日均量比值与单位无关（${veS.volumeState.ratio5} vs ${veL.volumeState.ratio5}）`);
  ok(veS.volumeState.level === veL.volumeState.level, `判定档位与单位无关（${veS.volumeState.level}）`);

  // capitalFlow 侧：单位归一后，比值与绝对量均与历史同口径
  const VOLUME_TO_LOT = { eastmoney: 100, ths: 100, tencent: 1 };
  const norm = shares.map(b => ({ ...b, volume: b.volume / VOLUME_TO_LOT.eastmoney }));
  const vi = computeVolumeIndicators(norm, null, null, { unifiedTier: veS.volumeTier });
  ok(vi !== null, '单位归一后指标可计算');
  const prior = vi.indicators.latestVsPriorAvg;
  ok(Math.abs(prior.priorAvgVol - 10000) < 1, `20 日均量按「手」归一（≈10000 手，实际 ${Math.round(prior.priorAvgVol)}）`);
});

// ============================================================
group('8. API 载荷：内部 bars 不下发', () => {
  // stripEngineBars 是模块内私有函数，此处以纯函数复刻其契约并验证引擎侧产出完整
  const bars = mkBars(60, 1000, 650, 9.5);
  const ve = VE.computeVolumeEngine({ bars, barsSource: 'tencent', symbol: '000000' });
  ok(ve.bars === undefined, 'computeVolumeEngine 输出不含 bars（bars 只由采集入口 analyzeVolume 追加）');
  ok(!!ve.volumeTier, '引擎输出含 volumeTier（供 capitalFlow 引用）');
  const stripped = Object.assign({}, ve);
  delete stripped.bars;
  ok(!Object.prototype.hasOwnProperty.call(stripped, 'bars'), '剔除后响应不含 bars 字段');
  ok(!!stripped.volumeTier && !!stripped.volumeState, '剔除不影响其余字段');
});

// ============================================================
group('9. 引擎失败降级：unifiedTier 缺失时仍正常输出', () => {
  const bars = mkBars(60, 1000, 1500, 9.5);
  // 引擎失败 → volumeEngine 为 null → unifiedTier 不传
  const vi = computeVolumeIndicators(bars, null, null, undefined);
  ok(vi !== null && !!vi.volumePrice, 'unifiedTier 缺失时指标层正常返回');
  ok(vi.volumePrice.signal === '放量下跌', '降级后按本地 20 日口径输出（放量下跌）');
  ok(vi.volumePrice.unified === null, '降级后 unified 为 null，前端据此退回原展示');
  ok(typeof vi.volumePrice.description === 'string' && vi.volumePrice.description.length > 0, '降级后描述文案完整');

  // 脏数据：unifiedTier 结构不完整时不得崩溃
  const dirty = computeVolumeIndicators(bars, null, null, { unifiedTier: {} });
  ok(dirty !== null && !!dirty.volumePrice, 'unifiedTier 为 {} 时不崩溃');
  // bars 为下跌样本（-5%），amplified=true 且缺 ratio5 时按 amp 档 → 下跌分支为「量价齐跌」
  const dirty2 = computeVolumeIndicators(bars, null, null, { unifiedTier: { amplified: true } });
  ok(dirty2.volumePrice.signal === '量价齐跌', 'unifiedTier 缺 ratio5 时按 amplified 取 amp 档（量价齐跌）');
  const dirty3 = computeVolumeIndicators(bars, null, null, { unifiedTier: { shrunk: true } });
  ok(dirty3.volumePrice.signal === '缩量下跌', 'unifiedTier 缺 ratio5 时按 shrunk 取 shrink 档（缩量下跌）');
});

// ============================================================
group('10. 日K降级链新鲜度判据（20261019a，000783 实测缺陷）', () => {
  // 背景：000783 长江证券——东财被断(0根)、同花顺 140 根但末根止于 10-16（当日K线延迟）、
  // 腾讯 321 根有 10-19。旧判据「≥10 根即采用」直接用同花顺 → 工作台量比 1.26（10-16 口径）
  // vs 东财 App 0.82（10-19 口径），且「当日涨跌」也是三天前的。
  const T = '2026-10-19';
  const mk = (n, lastDate) => Array.from({ length: n }, (_, i) => ({
    date: lastDate, open: 10, high: 10.3, low: 9.7, close: 10, volume: 1000,
  }));
  const bar = (dates) => dates.map(d => ({ date: d, open: 10, high: 10.3, low: 9.7, close: 10, volume: 1000 }));

  // [10.1] 000783 实际场景复现：东财缺位 + 同花顺 stale + 腾讯 fresh → 必须选腾讯
  const r1 = VE._chooseDailyBars([
    { bars: bar(['2026-10-15', '2026-10-16']), source: 'ths', priority: 1 },       // <10 根，不入候选
    { bars: mk(140, '2026-10-16'), source: 'ths', priority: 1 },
    { bars: mk(321, '2026-10-19'), source: 'tencent', priority: 2 },
  ], T);
  ok(r1 && r1.source === 'tencent', `同花顺 stale + 腾讯 fresh → 选腾讯（实际 ${r1 && r1.source}）`);
  ok(r1 && r1.stale === false, '选中通道末根=今天 → stale=false');

  // [10.2] 东财 fresh → 立即采用（快路径语义：fresh 在前优先）
  const r2 = VE._chooseDailyBars([
    { bars: mk(320, T), source: 'eastmoney', priority: 0 },
    { bars: mk(321, T), source: 'tencent', priority: 2 },
  ], T);
  ok(r2 && r2.source === 'eastmoney' && r2.stale === false, '东财 fresh → 直接选东财（不落到低优先级）');

  // [10.3] 全部 stale 且末根并列（停牌/节假日）→ 按通道优先级选东财（字段全优先，与旧行为一致）
  const r3 = VE._chooseDailyBars([
    { bars: mk(140, '2026-10-16'), source: 'ths', priority: 1 },
    { bars: mk(321, '2026-10-16'), source: 'tencent', priority: 2 },
    { bars: mk(320, '2026-10-16'), source: 'eastmoney', priority: 0 },
  ], T);
  ok(r3 && r3.source === 'eastmoney', `全 stale 并列 → 选东财（实际 ${r3 && r3.source}）`);
  ok(r3 && r3.stale === true, '全 stale → stale=true（上层如实标注「未包含今日数据」）');
  ok(r3 && r3.lastDate === '2026-10-16', `stale 通道末根日期回传（实际 ${r3 && r3.lastDate}）`);

  // [10.4] 全 stale 且末根不同 → 选末根最新者
  const r4 = VE._chooseDailyBars([
    { bars: mk(140, '2026-10-15'), source: 'ths', priority: 1 },
    { bars: mk(321, '2026-10-17'), source: 'tencent', priority: 2 },
  ], T);
  ok(r4 && r4.lastDate === '2026-10-17', `末根不同 → 取最新（实际 ${r4 && r4.lastDate}）`);
  ok(r4 && r4.source === 'tencent', '末根最新者优先于通道优先级');

  // [10.5] 全部不足 10 根 → null（外层走「最长可用集」兜底）
  const r5 = VE._chooseDailyBars([
    { bars: bar(['2026-10-15', '2026-10-16']), source: 'ths', priority: 1 },
  ], T);
  ok(r5 === null, '全部候选 <10 根 → null（外层兜底）');

  // [10.6] 空候选 → null
  ok(VE._chooseDailyBars([], T) === null, '空候选 → null');

  // [10.7] 东财 stale 根数多、腾讯 fresh 根数少 → fresh 胜出（新鲜性 > 根数）
  const r7 = VE._chooseDailyBars([
    { bars: mk(320, '2026-10-16'), source: 'eastmoney', priority: 0 },
    { bars: mk(11, T), source: 'tencent', priority: 2 },
  ], T);
  ok(r7 && r7.source === 'tencent' && r7.stale === false, '新鲜性优先于根数与通道优先级（腾讯 11 根 fresh 胜东财 320 根 stale）');

  // [10.8] 外层流程语义（_fetchDailyBars 的三段式编排，20261019a 首版曾在此踩坑：
  // stale 候选非 null 就提前 return，导致腾讯虽有今日数据也轮不到——000783 复现）。
  // 复刻生产编排：每段收集后选取，仅 fresh（stale=false）才终止；走完全部通道后取最终。
  const simulateFetch = (channels) => {
    const collected = [];
    for (const ch of channels) {
      if (Array.isArray(ch.bars) && ch.bars.length) collected.push(ch);
      const got = VE._chooseDailyBars(collected, T);
      if (got && !got.stale) return got;
    }
    return VE._chooseDailyBars(collected, T);
  };
  const sim1 = simulateFetch([
    { bars: mk(140, '2026-10-16'), source: 'ths', priority: 1 },
    { bars: mk(321, T), source: 'tencent', priority: 2 },
  ]);
  ok(sim1 && sim1.source === 'tencent' && sim1.stale === false, '流程编排：同花顺 stale 不终止链，继续取到腾讯 fresh');
  const sim2 = simulateFetch([
    { bars: mk(320, '2026-10-16'), source: 'eastmoney', priority: 0 },
    { bars: mk(140, '2026-10-16'), source: 'ths', priority: 1 },
  ]);
  ok(sim2 && sim2.source === 'eastmoney' && sim2.stale === true, '流程编排：全 stale 走完链后按优先级取东财并标 stale');
});

// ============================================================
console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
