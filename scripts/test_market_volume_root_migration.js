/**
 * 首页侧量能收敛等价性守卫（20261018）
 * --------------------------------------------------------------
 * 背景（用户 2026-10-17 架构指令）：首页侧量能根数据源设置在「大盘技术分析的量价关系」
 * （lib/marketTechnical）里，市场情绪模型需要的量能分析在根里创建再引用。
 *   旧：marketEmotionModel.calcVolumeActivity / calcPriceVolume 用 260 窗口 bars 自算指标
 *       （数据走 scripts/market_emotion.py·akshare 通道）
 *   新：两函数的底层指标改引 lib/marketTechnical.computeMarketVolumeMetrics
 *       （数据走根通道 fetchIndexDailyBars，320 窗口）
 *
 * 断言（三重）：
 *   ① 同一份 bars：旧函数 vs 新函数返回对象 deepStrictEqual（score/value/detail 逐字）
 *   ② 窗口不变性：260 根 vs「60 根更老数据 + 同样 260 根」（=320 窗口），
 *      新函数(320) 必须与旧函数(260) 完全相等 —— 证明 260→320 不改变任何结论
 *      （所有尾部窗口 -250/-21,-1/-20/-5/-3 样本集相同；实测两通道重叠 260 根零差异）
 *   ③ 边界：24 根 / 9 根时旧新降级行为一致
 *
 * 旧实现来源：git show HEAD:lib/marketEmotionModel.js（收敛前的权威版本，非手抄）
 * 运行：node scripts/test_market_volume_root_migration.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { computeMarketVolumeMetrics } = require('../lib/marketTechnical');

function extractFn(src, name) {
  const re = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数: ' + name);
  return m[0];
}
function extractConst(src, name) {
  const m = src.match(new RegExp('^const ' + name + ' = [^\\n]+$', 'm'));
  if (!m) throw new Error('未找到常量: ' + name);
  return m[0];
}

// 旧实现 = git HEAD（收敛前）；新实现 = 工作区（收敛后）
const OLD_SRC = execSync('git show HEAD:lib/marketEmotionModel.js', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const NEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');

//  rigor：新旧两版的 round / VOL_PCTL_* 必须逐字相同（否则等价比对失去意义）
for (const name of ['round']) {
  const o = extractFn(OLD_SRC, name), n = extractFn(NEW_SRC, name);
  if (o !== n) throw new Error(name + ' 实现在收敛前后不一致，等价性前提不成立');
}
for (const name of ['VOL_PCTL_LOW', 'VOL_PCTL_HIGH']) {
  const o = extractConst(OLD_SRC, name), n = extractConst(NEW_SRC, name);
  if (o !== n) throw new Error(name + ' 常量在收敛前后不一致，等价性前提不成立');
}

// eslint-disable-next-line no-eval
eval([
  extractConst(OLD_SRC, 'VOL_PCTL_LOW'),
  extractConst(OLD_SRC, 'VOL_PCTL_HIGH'),
  extractFn(OLD_SRC, 'round'),
  extractFn(OLD_SRC, 'mean'),
  extractFn(OLD_SRC, 'std'),
  extractFn(OLD_SRC, 'trimExtremes'),
  extractFn(OLD_SRC, 'rankPercentile'),
  extractFn(OLD_SRC, 'calcVolumeActivity').replace('function calcVolumeActivity(d)', 'function oldCalcVolumeActivity(d)'),
  extractFn(OLD_SRC, 'calcPriceVolume').replace('function calcPriceVolume(d)', 'function oldCalcPriceVolume(d)'),
  extractFn(NEW_SRC, 'calcVolumeActivity'),
  extractFn(NEW_SRC, 'calcPriceVolume'),
].join('\n'));

// ---- 场景数据 ----
// 真实上证日线 120 根（2026-04-20 ~ 2026-10-16，腾讯 fqkline 实测抓取后固化，保证测试离线可复现）
const REAL_120 = [
  ["2026-04-20", 4082.13, 589841379],
  ["2026-04-21", 4085.08, 576689450],
  ["2026-04-22", 4106.26, 582466346],
  ["2026-04-23", 4093.25, 671166092],
  ["2026-04-24", 4079.9, 605031798],
  ["2026-04-27", 4086.34, 589950867],
  ["2026-04-28", 4078.64, 600507498],
  ["2026-04-29", 4107.51, 614221451],
  ["2026-04-30", 4112.16, 656912728],
  ["2026-05-06", 4160.17, 701177480],
  ["2026-05-07", 4180.09, 685574249],
  ["2026-05-08", 4179.95, 697019094],
  ["2026-05-11", 4225.02, 762736287],
  ["2026-05-12", 4214.49, 718984002],
  ["2026-05-13", 4242.57, 705018739],
  ["2026-05-14", 4177.92, 764235004],
  ["2026-05-15", 4135.39, 733162357],
  ["2026-05-18", 4131.53, 627233137],
  ["2026-05-19", 4169.54, 617611067],
  ["2026-05-20", 4162.18, 624152035],
  ["2026-05-21", 4077.28, 727218701],
  ["2026-05-22", 4112.9, 589459644],
  ["2026-05-25", 4152.57, 615930861],
  ["2026-05-26", 4145.37, 654777756],
  ["2026-05-27", 4093.73, 660467399],
  ["2026-05-28", 4098.64, 621179950],
  ["2026-05-29", 4068.57, 731597710],
  ["2026-06-01", 4057.74, 676025806],
  ["2026-06-02", 4075.1, 642244656],
  ["2026-06-03", 4083.97, 668452583],
  ["2026-06-04", 4057.78, 621194774],
  ["2026-06-05", 4027.74, 662918577],
  ["2026-06-08", 3959.34, 659293555],
  ["2026-06-09", 4010.03, 576570090],
  ["2026-06-10", 3993.23, 598694739],
  ["2026-06-11", 3987.01, 568545244],
  ["2026-06-12", 4031.51, 743131092],
  ["2026-06-15", 4096.47, 678907811],
  ["2026-06-16", 4091.89, 615668296],
  ["2026-06-17", 4108.08, 608077413],
  ["2026-06-18", 4090.48, 658116068],
  ["2026-06-22", 4163.1, 743699355],
  ["2026-06-23", 4106.25, 709003913],
  ["2026-06-24", 4110.81, 644527518],
  ["2026-06-25", 4120.28, 670459917],
  ["2026-06-26", 4027.26, 660108666],
  ["2026-06-29", 4073.9, 659199936],
  ["2026-06-30", 4094.4, 598412203],
  ["2026-07-01", 4112.45, 672331791],
  ["2026-07-02", 4028.9, 656233612],
  ["2026-07-03", 4043.64, 602009738],
  ["2026-07-06", 4041.24, 590364903],
  ["2026-07-07", 3990.24, 514453091],
  ["2026-07-08", 3970.88, 496229374],
  ["2026-07-09", 4036.59, 553063980],
  ["2026-07-10", 3996.16, 627450065],
  ["2026-07-13", 3913.79, 590907356],
  ["2026-07-14", 3967.13, 579982052],
  ["2026-07-15", 3955.58, 576209492],
  ["2026-07-16", 3882.41, 535281873],
  ["2026-07-17", 3764.15, 650450984],
  ["2026-07-20", 3796.28, 709234069],
  ["2026-07-21", 3864.37, 735021925],
  ["2026-07-22", 3867.03, 614255215],
  ["2026-07-23", 3876.78, 562122601],
  ["2026-07-24", 3814.2, 508203905],
  ["2026-07-27", 3858.25, 504879454],
  ["2026-07-28", 3813.31, 494829126],
  ["2026-07-29", 3828.47, 571226391],
  ["2026-07-30", 3804.69, 592298923],
  ["2026-07-31", 3832.26, 597529427],
  ["2026-08-03", 3809.66, 524516960],
  ["2026-08-04", 3822.28, 540324922],
  ["2026-08-05", 3878.43, 592155124],
  ["2026-08-06", 3900.35, 588555280],
  ["2026-08-07", 3940.04, 564988582],
  ["2026-08-10", 3966.59, 542118110],
  ["2026-08-11", 3934.09, 529490944],
  ["2026-08-12", 3946.68, 503257011],
  ["2026-08-13", 3926.96, 572793677],
  ["2026-08-14", 3927.18, 499525613],
  ["2026-08-17", 3982.65, 489834027],
  ["2026-08-18", 3990.3, 511234287],
  ["2026-08-19", 3894.42, 572191213],
  ["2026-08-20", 3903.72, 506633954],
  ["2026-08-21", 3905.2, 446895868],
  ["2026-08-24", 3882.01, 486931412],
  ["2026-08-25", 3889.44, 464117264],
  ["2026-08-26", 3912.52, 489553021],
  ["2026-08-27", 3956.57, 516777549],
  ["2026-08-28", 3952.18, 510581645],
  ["2026-08-31", 3986.3, 576656606],
  ["2026-09-01", 3979.89, 573538949],
  ["2026-09-02", 3941.39, 516472775],
  ["2026-09-03", 3942.09, 496990189],
  ["2026-09-04", 3930.12, 537286161],
  ["2026-09-07", 3932.7, 477375261],
  ["2026-09-08", 3940.55, 529992688],
  ["2026-09-09", 3951.51, 517504311],
  ["2026-09-10", 3934.4, 484675114],
  ["2026-09-11", 3888.11, 579123145],
  ["2026-09-14", 3885.33, 458888916],
  ["2026-09-15", 3864.28, 440907766],
  ["2026-09-16", 3891.6, 459125108],
  ["2026-09-17", 3875.6, 452886464],
  ["2026-09-18", 3911.87, 485712507],
  ["2026-09-21", 3949.91, 502354877],
  ["2026-09-22", 3952.13, 506148369],
  ["2026-09-23", 3936.52, 466913933],
  ["2026-09-24", 3888.37, 438530412],
  ["2026-09-28", 3823.62, 452350675],
  ["2026-09-29", 3830.45, 399473391],
  ["2026-09-30", 3842.19, 414560247],
  ["2026-10-08", 3811.9, 482201685],
  ["2026-10-09", 3813.79, 535149921],
  ["2026-10-12", 3797.24, 461448981],
  ["2026-10-13", 3800.86, 483305909],
  ["2026-10-14", 3767.23, 445962554],
  ["2026-10-15", 3707.48, 510163189],
  ["2026-10-16", 3716.28, 472632158],
].map(([date, close, vol]) => ({ date, close, vol }));

// 确定性伪随机（LCG）合成序列：放量/缩量/脉冲/长窗口
function lcgBars(n, seed, opts = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const bars = [];
  let close = 3000;
  const base = Date.UTC(2015, 0, 1);
  for (let i = 0; i < n; i++) {
    close *= 1 + (rnd() - 0.5) * 0.02;
    let vol = 5e8 * (0.7 + rnd() * 0.6);
    if (opts.spikeLast && i === n - 1) vol *= opts.spikeLast;   // 末日放量/缩量
    if (opts.pulseAt && i === n - 10) vol *= opts.pulseAt;      // 窗口内脉冲（触发极端值剔除）
    const d = new Date(base + i * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), close: Math.round(close * 100) / 100, vol: Math.round(vol) });
  }
  return bars;
}

const BREADTHS = {
  '无宽度数据': null,
  '普涨(up>55%)': { up: 3800, down: 1200, limitUp: 80, limitDown: 2 },
  '普跌(up<45%)': { up: 800, down: 4200, limitUp: 3, limitDown: 60 },
  '涨跌互现': { up: 2400, down: 2600, limitUp: 40, limitDown: 20 },
};

const SCENARIOS = [
  ['真实数据120根', REAL_120],
  ['真实数据·末25根(活跃度边界)', REAL_120.slice(-25)],
  ['真实数据·末24根(活跃度降级)', REAL_120.slice(-24)],
  ['真实数据·末10根(配合度边界)', REAL_120.slice(-10)],
  ['真实数据·末9根(全部降级)', REAL_120.slice(-9)],
  ['合成·随机游走260根', lcgBars(260, 20261018)],
  ['合成·末日放量3倍', lcgBars(260, 42, { spikeLast: 3 })],
  ['合成·末日缩量至0.3', lcgBars(260, 43, { spikeLast: 0.3 })],
  ['合成·窗口内脉冲(触发剔除)', lcgBars(120, 44, { pulseAt: 12 })],
  ['合成·恰好25根', lcgBars(25, 45)],
];

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    console.log('  旧:', JSON.stringify(expect));
    console.log('  新:', JSON.stringify(actual));
  }
}
// 20261021f：calcPriceVolume 新增 label / kind（附加字段，供风险提示按形态取词）。
// 本测试比较的是「同一份 bars 的得分与文案是否零变化」——附加字段不属于语义差异，
// 若继续整对象逐字比较，任何"加字段"都会被误判成回归。
function semantic(pv) {
  if (!pv) return pv;
  return { score: pv.score, degraded: pv.degraded, value: pv.value, detail: pv.detail };
}
function deepEq(a, b) {
  try { require('assert').deepStrictEqual(a, b); return true; } catch (e) { return false; }
}

console.log('===== 1) 同一份 bars：旧实现 vs 新实现（全返回对象逐字相等）=====');
for (const [label, bars] of SCENARIOS) {
  for (const [bLabel, breadth] of Object.entries(BREADTHS)) {
    const d = { index: { bars }, breadth };
    const vaOld = oldCalcVolumeActivity(d), vaNew = calcVolumeActivity(d);
    const pvOld = oldCalcPriceVolume(d), pvNew = calcPriceVolume(d);
    check(`量能活跃度 · ${label} · ${bLabel}`, vaNew, vaOld);
    check(`量价配合度 · ${label} · ${bLabel}`, semantic(pvNew), semantic(pvOld));
  }
}

console.log('\n===== 2) 窗口不变性：新实现(320) vs 旧实现(260) —— 260→320 结论零变化 =====');
{
  const base = lcgBars(260, 777);
  const older = lcgBars(60, 778).map((b, i) => ({ ...b, date: '2000-01-' + String(i + 1).padStart(2, '0') }));
  const bars320 = older.concat(base);       // 60 根更老 + 同样 260 根
  if (bars320.length !== 320) throw new Error('窗口构造失败');
  for (const [bLabel, breadth] of Object.entries(BREADTHS)) {
    const vaOld260 = oldCalcVolumeActivity({ index: { bars: base }, breadth });
    const vaNew320 = calcVolumeActivity({ index: { bars: bars320 }, breadth });
    const pvOld260 = oldCalcPriceVolume({ index: { bars: base }, breadth });
    const pvNew320 = calcPriceVolume({ index: { bars: bars320 }, breadth });
    check(`量能活跃度 · 旧260 vs 新320 · ${bLabel}`, vaNew320, vaOld260);
    check(`量价配合度 · 旧260 vs 新320 · ${bLabel}`, semantic(pvNew320), semantic(pvOld260));
  }
  // 反向 sanity：320 窗口里 win20 / year(250) 样本集必须与 260 窗口完全相同
  const vols260 = base.map(b => b.vol), vols320 = bars320.map(b => b.vol);
  const sameWin20 = JSON.stringify(vols260.slice(-21, -1)) === JSON.stringify(vols320.slice(-21, -1));
  const sameYear = JSON.stringify(vols260.slice(-250)) === JSON.stringify(vols320.slice(-250));
  check('320 与 260 的 20 日窗口（不含今日）样本集相同', sameWin20, true);
  check('320 与 260 的 250 根（≈1年）分位样本集相同', sameYear, true);
}

console.log('\n===== 2b) 附加字段自洽（20261021f：label 必须等于 detail 的前缀，kind 必须在枚举内）=====');
{
  const ALLOWED = ['bothRise', 'bothFall', 'volUpPriceDown', 'priceUpVolDown', 'flat'];
  const bars = lcgBars(260, 4242, { spikeLast: 1.6 });
  const pv = calcPriceVolume({ index: { bars }, breadth: { up: 2000, down: 3000, limitUp: 30, limitDown: 5 } });
  check('label 是 detail 的前缀', String(pv.detail).startsWith(pv.label), true);
  check('kind 在枚举内', ALLOWED.includes(pv.kind), true);
  // 合成层透传：这里不做 eval 执行（calcVolumePrice 未纳入新旧对比），改断言源码透传
  check('合成因子透传 pvKind', NEW_SRC.indexOf('pvKind: pv.kind') >= 0, true);
  check('合成因子透传 pvLabel', NEW_SRC.indexOf('pvLabel: pv.label') >= 0, true);
}

console.log('\n===== 3) 根函数直出指标 vs 旧实现手算（防止指标本身漂移）=====');
{
  const bars = lcgBars(320, 909, { pulseAt: 8, spikeLast: 1.8 });
  const vols = bars.map(b => b.vol);
  const win20 = vols.slice(-21, -1);
  const { kept, removed } = trimExtremes(win20);
  const avg20 = mean(kept) || 1;
  const m = computeMarketVolumeMetrics(bars);
  check('根指标 ratio = 当日量/剔除后近20日均量', m.ratio, vols[vols.length - 1] / avg20);
  check('根指标 removed = 20 日窗口剔除数', m.removed, removed);
  check('根指标 volPct = 250 根分位', m.volPct, rankPercentile(vols.slice(-250), vols[vols.length - 1]));
  const n = bars.length;
  check('根指标 priceUp5', m.priceUp5, bars[n - 1].close > bars[n - 6].close);
  check('根指标 vRecent3', m.vRecent3, mean(vols.slice(n - 3)));
  check('根指标 vPrev3', m.vPrev3, mean(vols.slice(n - 6, n - 3)));
  check('根指标 volUp3', m.volUp3, mean(vols.slice(n - 3)) > mean(vols.slice(n - 6, n - 3)));
  check('根函数 <10 根返回 null', computeMarketVolumeMetrics(bars.slice(0, 9)), null);
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
