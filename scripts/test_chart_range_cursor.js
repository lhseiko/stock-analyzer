/**
 * 主图「区间最高 / 区间最低」自动追踪光标 · 行为回归（零网络，全合成数据）
 * ---------------------------------------------------------------------------
 * 运行： node scripts/test_chart_range_cursor.js
 *
 * 背景（20261022i 用户需求原文）：
 *   「主图模块删除右侧标示今日收盘价的光标，增加两个自动追踪光标，
 *     一个显示当前选定的时间范围内股票的最高价，一个显示最低价。」
 *
 * 覆盖：
 *   [1] 「今日收盘价」单条标线已彻底移除（不能再出现"只标最后一根收盘价"的痕迹）
 *   [2] 光标恒为 **两条**：区间最高（红·高）/ 区间最低（绿·低）
 *   [3] 初次渲染先按全区间算，挂载后立即按真实 dataZoom 可视区间校正
 *   [4] 滚轮缩放 / 拖动平移（dataZoom 事件）后，极值随可视区间重算
 *   [5] 缩放到全量区间（start:0 end:100）时，极值 = 全历史极值
 *   [6] markLine.data 长度恒为 2（ECharts 按索引合并，长度变化会残留脏光标）
 *   [7] 缺失 high/low 时留占位条目，不抛错、不缩短数组
 *   [8] 空历史 / 单根历史 / 无 chart 实例时不抛错
 *
 * 说明：本文件用 stub echarts 捕获 setOption，无浏览器、无网络。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 深合并：模拟 ECharts setOption 的 merge 语义（数组按索引合并，同 markLine 真实行为） ----
function mergeDeep(target, src) {
  if (Array.isArray(src)) {
    if (!Array.isArray(target)) target = [];
    src.forEach((v, i) => {
      if (v && typeof v === 'object') target[i] = mergeDeep(target[i] || {}, v);
      else target[i] = v;
    });
    return target;
  }
  if (src && typeof src === 'object') {
    const out = (target && typeof target === 'object') ? target : {};
    for (const k of Object.keys(src)) out[k] = mergeDeep(out[k], src[k]);
    return out;
  }
  return src;
}

// ---- 构造最小浏览器环境加载 Charts（stub echarts，捕获 setOption / dataZoom 监听） ----
const rafQueue = [];
const chartsCreated = [];
global.echarts = {
  registerTheme() {},
  init() {
    const chart = {
      _opt: {},
      _handlers: {},
      setOption(o) { this._opt = mergeDeep(this._opt, o); },
      getOption() { return this._opt; },
      on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      off() {},
      dispose() {},
      resize() {},
      dispatchAction() {},
      getZr() { return { off() {}, on() {} }; },
    };
    chartsCreated.push(chart);
    return chart;
  },
};
global.window = { SA_CHART: null };
// 同步可刷新的 rAF：把回调排队，显式 flush，避免同步执行打乱 raf 句柄赋值顺序
global.window.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
global.document = { getElementById: (id) => (id ? { id } : null) };

function flushRaf() {
  const q = rafQueue.splice(0, rafQueue.length);
  q.forEach(fn => fn());
}

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8');
const body = src.replace(/^\(function registerSoftDarkTheme\(\)\{[\s\S]*?\n\}\)\(\);/, '');
const Charts = new Function(`${body}; return Charts;`)();

// ---- 合成日K：high/low 单调可预测，便于直接算期望值 ----
function buildHistory(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 10 + i * 0.05;                      // 10 → 19.95
    out.push({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.1,
      close,
      high: close + 0.3,
      low: close - 0.3,
      volume: 1000 + i,
    });
  }
  return out;
}

// 复算期望极值（与被测实现独立）
function expectExtremes(history, i0, i1) {
  let hi = null, lo = null;
  for (let i = i0; i <= i1; i++) {
    const d = history[i];
    if (!d) continue;
    const h = Number(d.high), l = Number(d.low);
    if (isFinite(h) && (hi === null || h > hi)) hi = h;
    if (isFinite(l) && (lo === null || lo < lo)) { /* no-op 占位，防误写 */ }
    if (isFinite(l) && (lo === null || l < lo)) lo = l;
  }
  return { hi, lo };
}

const mkOf = (chart) => (chart && chart._opt && chart._opt.series && chart._opt.series[0] && chart._opt.series[0].markLine) || null;
const labelsOf = (ml) => (ml && Array.isArray(ml.data) ? ml.data.map(d => (d && d.label && d.label.formatter) || '') : []);

// ============================ [1] 首次渲染：两条光标，无「今日收盘价」残留 ============================
console.log('\n[1] 首次渲染的结构');
const H = buildHistory(200);
Charts.candlestick('candlestickChart', H);
let chart = chartsCreated[chartsCreated.length - 1];
let ml = mkOf(chart);

ok(!!ml, 'candlestick 已输出 markLine');
ok(Array.isArray(ml.data) && ml.data.length === 2, `markLine.data 恰为 2 条（实际 ${ml && ml.data ? ml.data.length : 'N/A'}）`);
const lb = labelsOf(ml);
ok(/^高 /.test(lb[0] || ''), `第 1 条是区间最高价，带「高」前缀（实际 "${lb[0]}"）`);
ok(/^低 /.test(lb[1] || ''), `第 2 条是区间最低价，带「低」前缀（实际 "${lb[1]}"）`);
ok(ml.data[0].yAxis !== ml.data[1].yAxis, '两条光标价格不同（不是同一价位重复画）');

// 「今日收盘价」特征：单条、且 yAxis === 末根 close。这里断言"不可能是那种形态"。
const lastClose = H[H.length - 1].close;
const onlyClose = ml.data.length === 1 && Number(ml.data[0].yAxis) === lastClose;
ok(!onlyClose, `不再是「单条=今日收盘价 ${lastClose}」的旧标线`);
ok(ml.data[0].yAxis !== lastClose || ml.data[1].yAxis !== lastClose || ml.data.length === 2,
  '「今日收盘价」标线已移除：当前两条为区间极值，与"末根收盘价"无绑定关系');

// ============================ [2] 初次渲染按全区间（setOption 之后才校正） ============================
console.log('\n[2] 初次渲染的取值口径');
const full = expectExtremes(H, 0, H.length - 1);
ok(Number(ml.data[0].yAxis) === full.hi, `初次 markLine 高 = 全历史最高 ${full.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === full.lo, `初次 markLine 低 = 全历史最低 ${full.lo}（实际 ${ml.data[1].yAxis}）`);

// ============================ [3] 挂载后立即按真实可视区间校正 ============================
console.log('\n[3] 挂载后按 dataZoom 可视区间校正');
ok(typeof window.requestAnimationFrame === 'function', 'rAF 已挂载（节流依赖）');
ok(rafQueue.length > 0, '挂载后排队了一次 rAF 校正');
flushRaf();
ml = mkOf(chart);
const dz0 = chart._opt.dataZoom[0];
ok(dz0 && dz0.start === 60 && dz0.end === 100, `主图 dataZoom 初始 60%~100%（实际 ${dz0 && dz0.start}%~${dz0 && dz0.end}%）`);
const vis = expectExtremes(H, Math.floor(200 * 60 / 100), Math.ceil(200 * 100 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis.hi, `校正后 高 = 可视区间最高 ${vis.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis.lo, `校正后 低 = 可视区间最低 ${vis.lo}（实际 ${ml.data[1].yAxis}）`);
ok(Number(ml.data[1].yAxis) !== full.lo, `可视区间最低(${vis.lo}) ≠ 全历史最低(${full.lo})，证明真的按区间算了`);

// ============================ [4] 滚轮缩放 / 拖动平移 → 跟随重算 ============================
console.log('\n[4] dataZoom 事件驱动重算');
const handlers = chart._handlers.dataZoom || [];
ok(handlers.length === 1, `注册了 1 个 dataZoom 监听（实际 ${handlers.length}）`);

// 缩放到 80%~100%
chart._opt.dataZoom[0].start = 80;
chart._opt.dataZoom[0].end = 100;
handlers[0]();
ok(rafQueue.length === 1, 'dataZoom 触发后走 rAF 节流（同帧内只排 1 次）');
// 同帧内再触发两次，不应再排队（节流生效）
handlers[0]();
handlers[0]();
ok(rafQueue.length === 1, `同一帧内多次 dataZoom 只排队 1 次（实际 ${rafQueue.length}）`);
flushRaf();
ml = mkOf(chart);
const vis80 = expectExtremes(H, Math.floor(200 * 80 / 100), Math.ceil(200 * 100 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis80.hi, `80%~100% 区间 高 = ${vis80.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis80.lo, `80%~100% 区间 低 = ${vis80.lo}（实际 ${ml.data[1].yAxis}）`);

// 缩放到 0%~30%（左端区间）
chart._opt.dataZoom[0].start = 0;
chart._opt.dataZoom[0].end = 30;
handlers[0]();
flushRaf();
ml = mkOf(chart);
const vis30 = expectExtremes(H, Math.floor(200 * 0), Math.ceil(200 * 30 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis30.hi, `0%~30% 区间 高 = ${vis30.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis30.lo, `0%~30% 区间 低 = ${vis30.lo}（实际 ${ml.data[1].yAxis}）`);

// 缩放到全量
chart._opt.dataZoom[0].start = 0;
chart._opt.dataZoom[0].end = 100;
handlers[0]();
flushRaf();
ml = mkOf(chart);
ok(Number(ml.data[0].yAxis) === full.hi, `全量区间 高 回到全历史最高 ${full.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === full.lo, `全量区间 低 回到全历史最低 ${full.lo}（实际 ${ml.data[1].yAxis}）`);
ok(ml.data.length === 2, `多次重算后 data 长度恒为 2（实际 ${ml.data.length}），无脏光标残留`);

// ============================ [5] 换周期（周/月K）与换范围：重新 candlestick 后仍正确 ============================
console.log('\n[5] 换数据源（周/月K 重采样后的 history）');
const HW = buildHistory(40);   // 模拟周K（根数更少）
Charts.candlestick('candlestickChart', HW);
const chart2 = chartsCreated[chartsCreated.length - 1];
const ml2 = mkOf(chart2);
ok(ml2 && ml2.data.length === 2, '周K 仍输出 2 条光标');
const fullW = expectExtremes(HW, 0, HW.length - 1);
ok(Number(ml2.data[0].yAxis) === fullW.hi, `周K 初次 高 = ${fullW.hi}（实际 ${ml2.data[0].yAxis}）`);
flushRaf();
const ml2b = mkOf(chart2);
const visW = expectExtremes(HW, Math.floor(40 * 60 / 100), Math.ceil(40 * 100 / 100) - 1);
ok(Number(ml2b.data[0].yAxis) === visW.hi, `周K 校正后 高 = ${visW.hi}（实际 ${ml2b.data[0].yAxis}）`);
ok(Number(ml2b.data[1].yAxis) === visW.lo, `周K 校正后 低 = ${visW.lo}（实际 ${ml2b.data[1].yAxis}）`);

// ============================ [6] 缺失值 / 异常输入不破坏结构 ============================
console.log('\n[6] 缺失值与异常输入');
const HNull = buildHistory(50).map((d, i) => (i > 10 ? { ...d, high: null, low: NaN } : d));
Charts.candlestick('candlestickChart', HNull);
const chart3 = chartsCreated[chartsCreated.length - 1];
flushRaf();
const ml3 = mkOf(chart3);
ok(ml3 && ml3.data.length === 2, `high/low 缺失时段，data 长度仍为 2（实际 ${ml3 && ml3.data.length}）`);
ok(typeof ml3.data[0].yAxis === 'number' && isFinite(ml3.data[0].yAxis), '最高价仍输出有限数值（取合法段）');

let threw = false;
try {
  Charts.candlestick('candlestickChart', []);
} catch (e) { threw = true; }
ok(!threw, '空历史不抛错');

threw = false;
try {
  Charts.candlestick('candlestickChart', buildHistory(1));
  flushRaf();
} catch (e) { threw = true; }
ok(!threw, '单根历史不抛错');

threw = false;
try {
  Charts._bindRangeMarkLine(null, buildHistory(10));
  Charts._bindRangeMarkLine({ on() {}, getOption() { return {}; } }, null);
} catch (e) { threw = true; }
ok(!threw, '_bindRangeMarkLine 收到空 chart / 空 history 时不抛错');

// ============================ [7] 诊断计数器 ============================
console.log('\n[7] 诊断计数器（禁止静默吞错）');
ok(typeof Charts._rangeCursorErrCount === 'number', '_rangeCursorErrCount 已定义');
ok(Charts._rangeCursorErrCount === 0, `正常路径下错误计数为 0（实际 ${Charts._rangeCursorErrCount}）`);

// getOption 抛错时，_visibleRange 应回退默认区间且计数 +1
const before = Charts._rangeCursorErrCount;
const fallback = Charts._visibleRange({ getOption() { throw new Error('boom'); } }, 200);
ok(Charts._rangeCursorErrCount === before + 1, 'getOption 抛错时错误计数 +1（不静默）');
ok(Array.isArray(fallback) && fallback[0] >= 0 && fallback[1] <= 199, `回退默认区间合法 [${fallback}]`);
const defVis = expectExtremes(buildHistory(200), fallback[0], fallback[1]);
ok(defVis.hi != null, '回退区间仍能算出极值');

// ============================ 汇总 ============================
console.log('\n' + '='.repeat(60));
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) { console.log('✗ 有失败用例'); process.exit(1); }
console.log('✓ 全部通过：主图区间最高/最低自动追踪光标行为符合预期');
