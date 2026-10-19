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
 *   [10] 日K降级链新鲜度判据（20261019a，000783 实测缺陷）
 *   [11] 当日 bar 实时行情终值对齐（20261019b，000902 实测缺陷：日期新鲜 ≠ 数值终值）
 *   [12] 量比数据源直采（20261019c，用户指令：量比向腾讯等数据源取值，不在本地重算）
 *   [13] 预期量能规则（20261019d，该放/该缩缺口补充：3 风险 + 3 正向确认）
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
  if (/放量|齐升|巨量/.test(text || '')) return 'amp'; // 20261019e：补「巨量」（huge 档下跌新标签「巨量下跌」）；「齐跌」已随标签废弃移除
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
    [3.0, '放量', '大量', '巨量下跌', '显著放量', 'huge'],   // 20261019e：huge 档下跌标签「放量下跌」→「巨量下跌」
    [1.6, '放量', '温和放量', '放量下跌', '温和放量', 'amp'], // 20261019e：amp 档下跌标签「量价齐跌」（与「下跌放量」解释矛盾）→「放量下跌」
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
  ok(vp.signal === '巨量下跌', `本地口径仍生效：量比 1.5 → 巨量下跌（实际 ${vp.signal}）`); // 20261019e：本地 huge 档标签改名
  // 注：本地 heatLevel 用「近3日均量 ÷ 近20日均量」= 1166.67/1000 ≈ 1.17 → 量能平稳。
  // 这正是旧口径的典型缺陷：当日量已达 20 日均量的 1.5 倍（显著放量），却因分子取近3日
  // 被前两日正常量稀释、且分子本身包含在分母内，最终判为「量能平稳」，与同卡
  // 「巨量下跌」互斥。统一引自引擎档位后此分歧已消除（见第 4/6 组）。
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
  ok(vi.volumePrice.signal === '巨量下跌', '降级后按本地 20 日口径输出（巨量下跌）'); // 20261019e：本地 huge 档标签改名
  ok(vi.volumePrice.unified === null, '降级后 unified 为 null，前端据此退回原展示');
  ok(typeof vi.volumePrice.description === 'string' && vi.volumePrice.description.length > 0, '降级后描述文案完整');

  // 脏数据：unifiedTier 结构不完整时不得崩溃
  const dirty = computeVolumeIndicators(bars, null, null, { unifiedTier: {} });
  ok(dirty !== null && !!dirty.volumePrice, 'unifiedTier 为 {} 时不崩溃');
  // bars 为下跌样本（-5%），amplified=true 且缺 ratio5 时按 amp 档 → 下跌分支为「放量下跌」
  const dirty2 = computeVolumeIndicators(bars, null, null, { unifiedTier: { amplified: true } });
  ok(dirty2.volumePrice.signal === '放量下跌', 'unifiedTier 缺 ratio5 时按 amplified 取 amp 档（放量下跌）'); // 20261019e：amp 档标签「量价齐跌」→「放量下跌」
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
group('11. 当日 bar 实时行情终值对齐（20261019b，000902 实测缺陷）', () => {
  // 背景：000902 新洋丰——东财被断、同花顺当日 bar 带今日日期但数值是盘中快照
  //（close 13.69 / 7,923,196 股，真实终值 close 13.62 / 8,052,800 股 = 80,528 手），
  // 20261019a 新鲜度判据只查「末根日期=今天」→ 日期新鲜 ≠ 数值终值，快路径采用错误快照
  // → 工作台量比 0.97 / 当日 +2.39%，东财 App 0.99 / +1.87%。
  // 修复：腾讯实时 quote（交易所终值）对齐当日 bar（覆写/补齐），单位按通道自适应。
  const T = '2026-10-19';
  const thsBars = [
    { date: '2026-10-15', open: 13.16, high: 13.42, low: 12.99, close: 13.08, volume: 9433600, amount: 124203281 },
    { date: '2026-10-16', open: 13.17, high: 13.55, low: 13.17, close: 13.37, volume: 6452996, amount: 86263040 },
    { date: '2026-10-19', open: 13.29, high: 13.83, low: 13.29, close: 13.69, volume: 7923196, amount: 108592500 }, // 同花顺盘中快照
  ];
  const quote000902 = { price: 13.62, open: 13.29, high: 13.83, low: 13.29, volume: 8052800, amount: 110360000, date: '2026-10-19', prevClose: 13.37 };

  // [11.1] 000902 实际场景复现：同花顺快照 → 覆写为终值
  const b1 = JSON.parse(JSON.stringify(thsBars));
  const r1 = VE._reconcileTodayBar(b1, quote000902, 'ths', T);
  ok(r1 && r1.note === 'overwritten', `同花顺快照偏差 → note=overwritten（实际 ${r1 && r1.note}）`);
  ok(b1[2].close === 13.62, `当日 close 覆写为终值 13.62（实际 ${b1[2].close}）`);
  ok(b1[2].volume === 8052800, `当日量覆写为终值 8,052,800 股（实际 ${b1[2].volume}）`);
  ok(b1[2].amount === 110360000, `当日额覆写为终值（ths 通道含 amount）`);
  ok(b1[0].close === 13.08 && b1[1].close === 13.37, '历史根不动（仅对齐当日）');
  // 覆写后当日涨跌 = (13.62-13.37)/13.37 = +1.87%（东财口径），不再是快照的 +2.39%
  const chg = (b1[2].close - b1[1].close) / b1[1].close * 100;
  ok(Math.abs(chg - 1.87) < 0.01, `覆写后当日涨跌 +1.87%（实际 ${chg.toFixed(2)}%，快照口径曾为 +2.39%）`);

  // [11.2] tencent 通道单位换算：quote.volume 为「股」，bar 为「手」→ ÷100
  const txBars = [
    { date: '2026-10-16', open: 13.17, high: 13.55, low: 13.17, close: 13.37, volume: 64530 },
    { date: '2026-10-19', open: 13.29, high: 13.83, low: 13.29, close: 13.62, volume: 80528 },
  ];
  const r2 = VE._reconcileTodayBar(txBars, quote000902, 'tencent', T);
  ok(r2 && r2.note === null, `腾讯终值 + quote 终值一致 → 幂等无动作（实际 ${r2 && r2.note}）`);
  ok(txBars[1].volume === 80528, `tencent 通道量保持「手」口径不变（实际 ${txBars[1].volume}）`);
  ok(txBars[1].amount === undefined, 'tencent 通道不写入 amount（该通道日K无此字段）');

  // [11.3] quote 比末根新且为今日 → 补齐当日 bar（全通道日K集体延迟场景）
  const staleBars = [
    { date: '2026-10-15', open: 13.16, high: 13.42, low: 12.99, close: 13.08, volume: 9433600 },
    { date: '2026-10-16', open: 13.17, high: 13.55, low: 13.17, close: 13.37, volume: 6452996 },
  ];
  const r3 = VE._reconcileTodayBar(staleBars, quote000902, 'ths', T);
  ok(r3 && r3.note === 'appended', `quote 更新 → 补齐当日 bar（实际 ${r3 && r3.note}）`);
  ok(staleBars.length === 3 && staleBars[2].date === '2026-10-19', '补齐后末根 = 今日');
  ok(staleBars[2].close === 13.62 && staleBars[2].volume === 8052800, '补齐 bar 为 quote 终值');

  // [11.4] quote 陈旧（quote.date < 末根日期）→ 不动（不得用旧 quote 污染新 bar）
  const freshBars = [
    { date: '2026-10-18', open: 13, high: 13.5, low: 12.9, close: 13.4, volume: 7000000 },
    { date: '2026-10-19', open: 13.29, high: 13.83, low: 13.29, close: 13.62, volume: 8052800 },
  ];
  const staleQuote = { ...quote000902, date: '2026-10-16', price: 13.37, volume: 6452996 };
  const r4 = VE._reconcileTodayBar(freshBars, staleQuote, 'ths', T);
  ok(r4 && r4.note === null, 'quote.date 早于末根 → 不动');
  ok(freshBars[1].close === 13.62 && freshBars.length === 2, '末根未被污染');

  // [11.5] 防御：quote 缺失 / price 非正 / volume 非正（停牌）/ date 缺失 → 全部不动
  const base = JSON.parse(JSON.stringify(thsBars));
  ok(VE._reconcileTodayBar(base, null, 'ths', T).note === null, 'quote 缺失 → 不动');
  ok(VE._reconcileTodayBar(base, { ...quote000902, price: 0 }, 'ths', T).note === null, 'price=0 → 不动');
  ok(VE._reconcileTodayBar(base, { ...quote000902, volume: 0 }, 'ths', T).note === null, 'volume=0（停牌）→ 不动');
  ok(VE._reconcileTodayBar(base, { ...quote000902, date: undefined }, 'ths', T).note === null, 'date 缺失 → 不动');
  ok(VE._reconcileTodayBar([], quote000902, 'ths', T).note === null, '空 bars → 不动');

  // [11.6] 幂等：覆写后再次对齐 → 无动作（终值稳定）
  const b6 = JSON.parse(JSON.stringify(thsBars));
  VE._reconcileTodayBar(b6, quote000902, 'ths', T);
  const r6 = VE._reconcileTodayBar(b6, quote000902, 'ths', T);
  ok(r6.note === null, '二次对齐 → 幂等无动作');

  // [11.7] 覆写仅当日实质偏差才留痕：微小偏差（<0.1% close 且 <0.5% 量）→ 静默
  const tinyQuote = { ...quote000902, price: 13.62, volume: Math.round(8052800 * 1.001) };
  const b7 = JSON.parse(JSON.stringify(thsBars));
  b7[2] = { ...b7[2], close: 13.62, volume: 8052800 };
  const r7 = VE._reconcileTodayBar(b7, tinyQuote, 'ths', T);
  ok(r7.note === null, '0.1% 内微小偏差 → 静默（盘中实时对齐不留痕）');

  // [11.8] 科创板单位链（20261019b 新浪裁决：腾讯对 688 的量恒为「股」非「手」）：
  // 688289 当日真实 2,612,565 股（新浪 volume/成交额 41,366,868 与量×均价自洽）。
  // stockData 源头归一后 quote.volume 已是股 → ths 通道覆写不再 ÷100/×100 错配 → 量比回到 0.74。
  const { tencentVolumeUnitIsShares } = require(path.join(ROOT, 'lib', 'stockData'));
  ok(tencentVolumeUnitIsShares('sh688289') === true, '科创板 sh688289 量单位=股');
  ok(tencentVolumeUnitIsShares('sh689009') === true, '科创板 CDR sh689 也属股口径');
  ok(tencentVolumeUnitIsShares('sz000902') === false, '深主板仍为手口径');
  ok(tencentVolumeUnitIsShares('sh601318') === false, '沪主板仍为手口径');
  ok(tencentVolumeUnitIsShares('sh000001') === false, '指数（sh000001）不受影响');
  ok(tencentVolumeUnitIsShares('') === false && tencentVolumeUnitIsShares(null) === false, '空/缺省 → 手口径（防御）');
  // 688 场景：ths 历史（股口径）+ quote（源头已归一为股）→ 覆写后量比 = 2612565/3553050 ≈ 0.735
  const starBars = [
    { date: '2026-10-16', open: 15.7, high: 15.9, low: 15.6, close: 15.76, volume: 3413707, amount: 54226413 },
    { date: '2026-10-19', open: 15.5, high: 15.95, low: 15.46, close: 15.85, volume: 2612565, amount: 41366868 },
  ];
  const starQuote = { price: 15.85, open: 15.56, high: 15.95, low: 15.46, volume: 2612565, amount: 41366868, date: T }; // 源头归一后
  const r8 = VE._reconcileTodayBar(starBars, starQuote, 'ths', T);
  ok(r8.note === null, '科创板（源头归一后）覆写幂等无动作');
  // 若源头未归一（quote.volume 虚增 100 倍 = 旧缺陷），覆写将产生 73 倍假量比——锁死回归
  const badQuote = { ...starQuote, volume: 261256500 };
  const starBarsBad = JSON.parse(JSON.stringify(starBars));
  const rBad = VE._reconcileTodayBar(starBarsBad, badQuote, 'ths', T);
  ok(rBad.note === 'overwritten' && starBarsBad[1].volume === 261256500,
    '（对照）未归一的 quote 会覆写出 100 倍假量——此为已被源头修复拦截的旧缺陷形态');
});

// ============================================================
group('12. 量比数据源直采（20261019c：向腾讯取值，不在本地工作台重算）', () => {
  // 构造 12 根日K：前 11 根量=100，当日量=200 → 本地 ratio5 = 200/100 = 2.0
  const bars = [];
  for (let i = 0; i < 11; i++) bars.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, open: 10, high: 10.5, low: 9.5, close: 10, volume: 100, amount: 1000, turnover: 1 });
  bars.push({ date: '2026-02-12', open: 10, high: 10.5, low: 9.5, close: 10, volume: 200, amount: 2000, turnover: 2 });

  // [12.1] 注入数据源量比（腾讯 fields[49]）= 0.99 → 直接采用，不得本地重算为 2.0
  const c1 = VE.computeVolumeEngine({ symbol: '000902', name: '新洋丰', bars, barsSource: 'tencent', quoteVolumeRatio: 0.99 });
  ok(c1.volumeState.ratio5 === 0.99, '注入量比 0.99 → ratio5 取数据源值 0.99（非本地 2.0）');
  ok(c1.volumeState.ratio5Basis === 'tencent_quote', 'ratio5Basis = tencent_quote（直采，非本地计算）');

  // [12.2] 不注入 → 退回本地 volToday/avg5 = 2.0
  const c2 = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent' });
  ok(c2.volumeState.ratio5 === 2 && c2.volumeState.ratio5Basis === 'local_fallback', '不注入 → ratio5 = 本地 2.0，basis = local_fallback');

  // [12.3] 注入无效值（0 / 负数 / null）→ 退回本地
  const c3a = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent', quoteVolumeRatio: 0 });
  const c3b = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent', quoteVolumeRatio: -1 });
  const c3c = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent', quoteVolumeRatio: null });
  ok(c3a.volumeState.ratio5 === 2 && c3a.volumeState.ratio5Basis === 'local_fallback', '注入 0 → 退回本地 2.0');
  ok(c3b.volumeState.ratio5 === 2 && c3b.volumeState.ratio5Basis === 'local_fallback', '注入负数 → 退回本地 2.0');
  ok(c3c.volumeState.ratio5 === 2 && c3c.volumeState.ratio5Basis === 'local_fallback', '注入 null → 退回本地 2.0');

  // [12.4] 注入值参与下游判定与本地同口径：直采 2.0 与本地 2.0 的 amplified 判定一致
  const localPc = VE._precompute(bars);
  const srcPc = VE._precompute(bars, { quoteVolumeRatio: 2.0 });
  ok(srcPc.ratio5 === 2.0 && localPc.ratio5 === 2.0, '直采 2.0 与本地 2.0 数值同源（同一只票两种取值路径一致）');
  ok(srcPc.ratio5Basis === 'tencent_quote' && localPc.ratio5Basis === 'local_fallback', 'basis 正确区分直采/兜底');

  // [12.5] 注入小量比 → 缩量判定一致（下游 shrunk 不依赖是否来自本地）
  const shrinkSrc = VE._precompute(bars, { quoteVolumeRatio: 0.5 });
  const shrinkLoc = (() => {
    const b2 = bars.slice();
    b2[b2.length - 1] = { ...b2[b2.length - 1], volume: 50 }; // 本地 ratio5 = 50/100 = 0.5
    return VE._precompute(b2);
  })();
  ok(shrinkSrc.ratio5 === 0.5 && shrinkLoc.ratio5 === 0.5, '直采 0.5 与本地 0.5 数值一致（下游 shrunk 判定同源）');
  ok(!(shrinkSrc.ratio5 > 1.3) && !(shrinkLoc.ratio5 > 1.3), '两者量比 0.5 均不触发放大（下游同口径）');
});

// ============================================================
group('13. 预期量能规则（20261019d：该放/该缩缺口补充，3 风险 + 3 正向确认）', () => {
  // 手搭 pc（与 test_volume_engine.js [15] 同款手法，确定性口径）
  const mkPc = (over = {}) => {
    const n = over.n || 60;
    return {
      n, level: '平量', ratio5: 1, ratio5Prev: 1, ratio10: 1, ratio20: 1,
      avg5: 1000, avg10: 1000, avg20: 1000, avg60: 1000,
      confirm: null, chgPct: 0, closePrev: 10, closeToday: 10, highToday: 10.02,
      volToday: 1000, vols: Array.from({ length: n }, () => 1000), lows: Array.from({ length: n }, () => 9.5), lowToday: 9.95,
      highs: Array.from({ length: n }, () => 10.1), highToday: 10.02,
      drawdownFromHigh: -5, pricePct12m: 0.5,
      ...over,
    };
  };
  const call = (label, pcOver, extra = {}) => VE._expectedVolumeRules(mkPc(pcOver), {
    position: { label },
    levels: { resistance: { price: 10 }, support: { price: 9 } },
    breakThrough: !!extra.breakThrough,
    rules: extra.rules || [],
  });

  // ---- ①高位放量下跌（风险）：高位 + 巨量 + 明显收跌 ----
  const d1 = call('高位区间', { level: '天量', ratio5: 5, confirm: '放量', chgPct: -4 });
  ok(d1.highVolumeDrop.matched === true && d1.highVolumeDrop.status === '命中', '高位+天量+大跌(-4%) → 高位放量下跌命中');
  ok(d1.highVolumeDrop.tone === 've-bear' && /派发/.test(d1.highVolumeDrop.conclusion), '结论为高位派发口径，tone=ve-bear');
  const d2 = call('高位区间', { level: '天量', ratio5: 5, confirm: '放量', chgPct: 0.5 });
  ok(d2.highVolumeDrop.matched === false && /高位放量滞涨/.test(d2.highVolumeDrop.conclusion), '高位+天量+滞涨(0.5%) → 本规则未命中（交由高位放量滞涨，不重复）');
  const d3 = call('低位区间', { level: '天量', ratio5: 5, chgPct: -4 });
  ok(d3.highVolumeDrop.matched === false, '低位天量下跌 → 未命中（位置不满足）');
  const d4 = call('高位区间', { level: '平量', ratio5: 1, chgPct: -4 });
  ok(d4.highVolumeDrop.matched === false, '高位无量下跌 → 未命中（量能不达）');
  const d5 = call('高位区间', { level: '天量', ratio5: 5, chgPct: null });
  ok(d5.highVolumeDrop.status === '数据不足' && /无法判定/.test(d5.highVolumeDrop.conclusion), '涨跌幅缺失 → 数据不足，不臆造');

  // ---- ②下跌途中放量阳线诱多（风险）：下跌途中 + 巨量 + 收阳 ----
  const u1 = call('下跌途中', { level: '大量', ratio5: 2.6, confirm: '放量', chgPct: 2 });
  ok(u1.downtrendVolUpTrap.matched === true && u1.downtrendVolUpTrap.tone === 've-bear', '下跌途中+大量+阳线(+2%) → 放量阳线诱多命中');
  ok(/诱多|对倒出货/.test(u1.downtrendVolUpTrap.conclusion), '结论为诱多陷阱口径');
  const u2 = call('下跌途中', { level: '大量', ratio5: 2.6, chgPct: -2 });
  ok(u2.downtrendVolUpTrap.matched === false && /该缩量反放巨量/.test(u2.downtrendVolUpTrap.conclusion), '下跌途中+放量+阴跌 → 本规则未命中（交由该缩量反放巨量，不重复）');
  const u3 = call('下跌途中', { level: '大量', ratio5: 2.6, chgPct: 2 }, { rules: [{ id: 1, matched: true }] });
  ok(u3.downtrendVolUpTrap.matched === false, '规则1 低位吸筹完整命中 → 不误判为诱多（spec 7.4 例外）');
  const u4 = call('高位区间', { level: '大量', ratio5: 2.6, chgPct: 2 });
  ok(u4.downtrendVolUpTrap.matched === false, '高位放量阳线 → 未命中（位置不满足）');

  // ---- ③高位缩量横盘（风险）：高位 + 缩量 + 横盘 ----
  const s1 = call('高位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 0.3 });
  ok(s1.highShrinkSideways.matched === true && s1.highShrinkSideways.tone === 've-bear', '高位+缩量+横盘(0.3%) → 高位缩量横盘命中');
  ok(/动能衰竭|温水煮青蛙|补跌/.test(s1.highShrinkSideways.conclusion), '结论为动能衰竭口径');
  const s2 = call('高位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 1.5 });
  ok(s2.highShrinkSideways.matched === false && /高位缩量上涨/.test(s2.highShrinkSideways.conclusion), '高位缩量上涨(+1.5%) → 本规则未命中（交由高位缩量上涨，不重复）');
  const s3 = call('低位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 0.3 });
  ok(s3.highShrinkSideways.matched === false, '低位缩量横盘 → 未命中（位置不满足）');

  // ---- ④突破后回踩缩量不破（正向确认）----
  const p1 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -0.5, closeToday: 10.2 }, { breakThrough: true });
  ok(p1.breakoutPullbackShrink.matched === true && p1.breakoutPullbackShrink.tone === 've-bull', '有效突破后缩量回踩不破 → 命中（正向确认）');
  ok(/突破确认|健康回踩/.test(p1.breakoutPullbackShrink.conclusion), '结论为突破确认口径');
  const p2 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 1.5, closeToday: 10.2 }, { breakThrough: true });
  ok(p2.breakoutPullbackShrink.matched === false, '突破后仍上涨（非回踩）→ 未命中');
  const p3 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -0.5, closeToday: 9.9 }, { breakThrough: true });
  ok(p3.breakoutPullbackShrink.matched === false, '突破后回踩跌破原压力位 → 未命中（确认度一般）');
  const p4 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -0.5, closeToday: 10.2 }, { breakThrough: false });
  ok(p4.breakoutPullbackShrink.matched === false && p4.breakoutPullbackShrink.status === '未触发', '无有效突破前提 → 未触发');

  // ---- ⑤低位倍量阳线启动（正向确认）----
  const b1 = call('低位区间', { level: '大量', ratio5: 2.5, chgPct: 2 });
  ok(b1.bottomVolUpStart.matched === true && b1.bottomVolUpStart.tone === 've-bull', '低位+倍量(2.5×)+阳线 → 低位倍量阳线命中');
  ok(/底部启动信号/.test(b1.bottomVolUpStart.conclusion) && /需后续连续放量/.test(b1.bottomVolUpStart.conclusion), '结论为底部启动信号且要求后续确认（不单日下定论）');
  const b2 = call('低位区间', { level: '温和放量', ratio5: 1.2, chgPct: 2 });
  ok(b2.bottomVolUpStart.matched === false, '低位收阳但未达倍量(<2×) → 未命中');
  const b3 = call('低位区间', { level: '天量', ratio5: 5, chgPct: -2 });
  ok(b3.bottomVolUpStart.matched === false, '低位放量阴线 → 未命中（非阳线启动）');

  // ---- ⑥主升浪缩量上涨（正向确认）----
  const m1 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 2 });
  ok(m1.mainRiseShrinkControl.matched === true && m1.mainRiseShrinkControl.tone === 've-bull', '上涨中途+缩量+上涨 → 主升浪缩量上涨命中（控盘）');
  ok(/筹码锁定良好|控盘/.test(m1.mainRiseShrinkControl.conclusion), '结论为筹码锁定良好口径');
  const m2 = call('上涨中途', { level: '大量', ratio5: 2, confirm: '放量', chgPct: 2 });
  ok(m2.mainRiseShrinkControl.matched === false, '上涨中途放量上涨 → 未命中（非缩量）');
  const m3 = call('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -2 });
  ok(m3.mainRiseShrinkControl.matched === false, '上涨中途缩量下跌 → 未命中（非上涨）');

  // ---- 归集总结：6 项逐条完整输出 ----
  const sm = VE._buildSummaries({
    pv: VE._positionVolumeRules(mkPc(), { position: { label: '高位区间' }, rules: [] }),
    ratio: { items: [] },
    contra: VE._contradictionRules(mkPc(), { position: { label: '高位区间' }, rules: [], levels: { resistance: { price: 10 }, support: { price: 9 } } }),
    position: { label: '高位区间' },
    exp: call('高位区间', { level: '天量', ratio5: 5, confirm: '放量', chgPct: -4 }),
  });
  ok(sm.expectedVolumeSummary && Array.isArray(sm.expectedVolumeSummary.items) && sm.expectedVolumeSummary.items.length === 6, 'expectedVolumeSummary 输出 6 项（无论命中逐条完整）');
  ok(sm.expectedVolumeSummary.items.every(i => i.form && i.status && typeof i.matched === 'boolean' && i.conclusion), '每项含 form/status/matched/conclusion');
  ok(sm.expectedVolumeSummary.items.filter(i => i.matched).length === 1, '高位天量大跌场景仅高位放量下跌命中（其余未命中）');
  ok(/空头类命中/.test(sm.expectedVolumeSummary.summary) && /正向量能确认/.test(sm.expectedVolumeSummary.summary), '归集总结含空头类/正向量能确认分项');

  // ---- 端到端：上行至高位后放量大跌 → 命中 + 风险标签 + 不得看多 + schema ----
  const bars = [];
  for (let i = 0; i < 250; i++) {
    const isLast = i === 249;
    const base = 8 + (7 * i) / 249; // 8 → 15 单调上行至高位
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base, high: isLast ? base * 1.005 : base * 1.01, low: isLast ? base * 0.94 : base * 0.99,
      close: isLast ? base * 0.96 : base, // 末根大跌约 -4%
      volume: isLast ? 6000 : 1000, // 末根巨量
    });
  }
  const e2e = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent' });
  const e2eHvd = e2e.expectedVolumeSummary.items.find(i => i.form === '高位放量下跌');
  ok(e2e.schema === 'volume-engine-20261019d', `schema 已升 20261019d（实际 ${e2e.schema}）`);
  ok(e2eHvd.matched === true && e2eHvd.status === '命中', `端到端高位放量大跌命中（位置 ${e2e.position.label}）`);
  ok(e2e.riskTags.includes('高位放量大阴线派发风险'), '命中 → 风险标签「高位放量大阴线派发风险」同步输出');
  ok(!/看多信号/.test(e2e.signal.category), `高位放量大跌不得输出看多信号（实际 ${e2e.signal.category}）`);

  // ---- 端到端：下行至低位后倍量阳线 → 正向量能确认进入 signal.bullSupport ----
  const bars2 = [];
  for (let i = 0; i < 250; i++) {
    const isLast = i === 249;
    const base = 15 - (7 * i) / 249; // 15 → 8 单调下行至低位
    bars2.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base, high: isLast ? base * 1.04 : base * 1.01, low: isLast ? base * 0.99 : base * 0.99,
      close: isLast ? base * 1.03 : base, // 末根阳线
      volume: isLast ? 5000 : 1000, // 末根倍量
    });
  }
  const e2e2 = VE.computeVolumeEngine({ symbol: 'X', name: 'X', bars: bars2, barsSource: 'tencent' });
  const hit = e2e2.expectedVolumeSummary.items.find(i => i.form === '低位倍量阳线');
  ok(hit.matched === true && hit.status === '命中', `端到端低位倍量阳线命中（位置 ${e2e2.position.label}）`);
  ok(e2e2.signal.bullSupport.includes('低位倍量阳线启动，底部启动信号'), '正向量能确认进入 signal.bullSupport');
});

// ============================================================
group('14. 量价标签与解释方向一致护栏（20261019e 用户报障：海天味业标签「量价齐跌」vs 解释「下跌放量」自相矛盾）', () => {
  // 不变量：标签的量能方向词与解释的量能方向词必须同向——
  //   标签放量向（放量/巨量/齐升）→ 解释不得出现缩量向词；
  //   标签缩量向（缩量/地量/齐跌）→ 解释不得出现放量向词。
  // 「齐跌」按缩量向校验（20 日窗口遗留词，义为价跌量缩）：旧代码把当日口径 amp 档下跌误标
  // 「量价齐跌」而解释写「下跌放量」，正是本断言要防回归的矛盾类。
  // 覆盖 5 档 × 涨跌两向 × 统一/本地两口径 = 20 个场景。
  const ut = (r5) => ({
    tier: 'x', ratio5Level: 'x', ratio5: r5, ratio20: r5, confirm: null,
    amplified: r5 > 1.3, shrunk: r5 < 0.7, consistent: true, divergenceNote: null,
  });
  const check = (sig, desc, tag) => {
    const sigAmp = /放量|巨量|齐升/.test(sig || '');
    const sigShrink = /缩量|地量|齐跌/.test(sig || '');
    const descAmp = /放量|巨量|齐升/.test(desc || '');
    const descShrink = /缩量|地量|齐跌/.test(desc || '');
    if (sigAmp) ok(!descShrink, `${tag}：标签「${sig}」放量向，解释不得缩量向（实际解释：${desc}）`);
    if (sigShrink) ok(!descAmp, `${tag}：标签「${sig}」缩量向，解释不得放量向（实际解释：${desc}）`);
    ok(!!sig, `${tag}：signal 非空`);
  };
  for (const r5 of [3.0, 1.6, 1.0, 0.66, 0.3]) {
    for (const [close, dirName] of [[10.5, '上涨'], [9.5, '下跌']]) {
      const bars = mkBars(60, 1000, 800, close);
      const vp = computeVolumeIndicators(bars, null, null, { unifiedTier: ut(r5) }).volumePrice;
      check(vp.signal, vp.description, `统一档位 ratio5=${r5} ${dirName}`);
    }
  }
  for (const [today, dirName] of [[3000, '上涨'], [3000, '下跌'], [1300, '上涨'], [1300, '下跌'], [1000, '上涨'], [1000, '下跌'], [600, '上涨'], [600, '下跌'], [300, '上涨'], [300, '下跌']]) {
    const bars = mkBars(60, 1000, today, dirName === '上涨' ? 10.5 : 9.5);
    const vp = computeVolumeIndicators(bars, null, null).volumePrice;
    check(vp.signal, vp.description, `本地口径 量比≈${(today / 1000).toFixed(2)} ${dirName}`);
  }
});

// ============================================================
console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
