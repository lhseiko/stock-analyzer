/**
 * 个股主图「分时」视图 · 行为回归（零网络，全合成数据）
 * --------------------------------------------------------------
 * 运行： node scripts/test_minute_chart.js
 * 覆盖：public/js/charts.js 的 Charts.minute()（20261017h 新增）——
 *   [1] 交易时段过滤：只画到 15:00，剔除腾讯收盘后追加的盘后条目
 *   [2] 涨跌幅与 Y 轴对称性（以昨收为中心）
 *   [3] 分钟量柱 = 相邻累计量差分（与量能引擎规则5 同口径）
 *   [4] 数据日期诚实标注（非今日时标「最近交易日，非今日」）
 *   [5] 边界：空数据 / 缺 cumVol / prevClose 缺失
 * 说明：真实网络取数（fetchTencentMinutes 的 date 字段）由服务端实测覆盖，本文件用构造数据测渲染逻辑。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 构造最小浏览器环境加载 Charts（stub echarts，捕获 setOption） ----
const captured = {};
global.echarts = {
  registerTheme() {},
  init() {
    return {
      setOption(o) { captured.opt = o; },
      dispose() {},
      getZr() { return { off() {}, on() {} }; },
    };
  },
};
global.window = { SA_CHART: null };
global.document = { getElementById: () => ({}) };
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8');
// 去掉依赖真实 echarts.registerTheme 的兜底主题注册 IIFE
const body = src.replace(/^\(function registerSoftDarkTheme\(\)\{[\s\S]*?\n\}\)\(\);/, '');
const Charts = new Function(`${body}; return Charts;`)();

// 腾讯分时形态：time 'HHMM'，含交易时段 242 条 + 收盘后追加的盘后条目
const TRADE_MIN = (() => {
  const t = [];
  for (let i = 0; i <= 120; i++) { const k = 9 * 60 + 30 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  for (let i = 0; i <= 120; i++) { const k = 13 * 60 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  return t;
})();
// 盘后追加条目（实测 15:01 之后仍会返回，最多观察到 15:31）
const AFTER = ['1506', '1507', '1508', '1509', '1510'];

function buildMinutes(opts = {}) {
  const priceAt = opts.price || (() => 10);
  const volPerMin = opts.volPerMin == null ? 4 : opts.volPerMin;
  const times = [...TRADE_MIN, ...AFTER];
  let cum = 0;
  const minutes = times.map((time, i) => {
    cum += volPerMin;
    return { time, price: priceAt(i), avg: 10, cumVol: cum };
  });
  return { minutes, prevClose: opts.prevClose == null ? 10 : opts.prevClose };
}
function render(data) {
  captured.opt = null;
  Charts.minute('candlestickChart', data);
  return captured.opt;
}

// ============ [1] 交易时段过滤 ============
console.log('\n[1] 交易时段过滤：只画到 15:00，剔除腾讯收盘后追加的盘后条目');
{
  const raw = buildMinutes();
  ok(raw.minutes.length === 247, `构造数据共 247 条（242 交易时段 + 5 条盘后，实际 ${raw.minutes.length}）`);
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const n = o.series[0].data.length;
  ok(n === 242, `渲染只保留交易时段 242 点（实际 ${n}）`);
  ok(o.xAxis[0].data[0] === '09:30' && o.xAxis[0].data[n - 1] === '15:00', `首末时间 09:30 → 15:00（实际 ${o.xAxis[0].data[0]} → ${o.xAxis[0].data[n - 1]}）`);
  ok(!o.xAxis[0].data.some(t => t > '15:00'), 'X 轴不含 15:00 之后的盘后时点');
  ok(o.series[0].data.length === o.series[1].data.length && o.series[1].data.length === o.series[2].data.length, '价格/均价/量柱三条系列点数一致');
}

// ============ [2] 涨跌幅与 Y 轴对称性 ============
console.log('\n[2] Y 轴以昨收为中心对称，涨跌幅口径正确');
{
  // 全天单边上行 +1%（10 → 10.1），昨收 10
  const raw = buildMinutes({ price: i => 10 + (i / 241) * 0.1, prevClose: 10 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const pctAxis = o.yAxis[1];
  ok(Math.abs(pctAxis.min + pctAxis.max) < 0.01, `涨跌幅轴严格对称（${pctAxis.min} / ${pctAxis.max}）`);
  ok(pctAxis.max > 1 && pctAxis.max < 1.2, `上行 1% 时上沿留 5% 余量（实际 ${pctAxis.max}）`);
  const lastPct = o.tooltip.formatter([{ dataIndex: 241 }]);
  ok(/\+1\.00%/.test(lastPct), `末点涨跌幅 +1.00%（实际匹配 ${/\+1\.00%/.test(lastPct)}）`);
  // 价格轴上下界以昨收为中心
  const mid = (o.yAxis[0].min + o.yAxis[0].max) / 2;
  ok(Math.abs(mid - 10) < 0.005, `价格轴以昨收 10 为中心（实际中点 ${mid.toFixed(3)}）`);
}
{
  // 下跌场景：收盘 9.8（-2%）
  const raw = buildMinutes({ price: i => 10 - (i / 241) * 0.2, prevClose: 10 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  ok(Math.abs(o.yAxis[1].min + o.yAxis[1].max) < 0.01, '下跌场景涨跌幅轴仍对称');
  ok(/-2\.00%/.test(o.tooltip.formatter([{ dataIndex: 241 }])), '末点涨跌幅 -2.00%');
}
{
  // 红涨绿跌：末值为涨 → 价格线取红色；跌 → 绿色
  const up = render({ ...buildMinutes({ price: i => 10 + (i / 241) * 0.1 }), minuteDate: '2026-10-19' });
  const down = render({ ...buildMinutes({ price: i => 10 - (i / 241) * 0.1 }), minuteDate: '2026-10-19' });
  ok(up.series[0].lineStyle.color === Charts.colors.up, '上涨 → 价格线红色（#F6465D）');
  ok(down.series[0].lineStyle.color === Charts.colors.down, '下跌 → 价格线绿色（#0ECB81）');
}

// ============ [3] 分钟量柱 ============
console.log('\n[3] 分钟量柱 = 相邻累计量差分（与量能引擎规则5 同口径）');
{
  const raw = buildMinutes({ volPerMin: 5 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const bars = o.series[2].data;
  ok(bars[0].value === 5 && bars[241].value === 5, `每分钟量 = 5 手（首 ${bars[0].value} / 末 ${bars[241].value}）`);
}
{
  // 尾盘放量：最后 30 分钟每分钟 20 手
  const raw = buildMinutes({ volPerMin: 4 });
  raw.minutes.forEach((m, i) => { if (i >= 211) m.cumVol = raw.minutes[210].cumVol + (i - 210) * 20; });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const bars = o.series[2].data;
  ok(bars[241].value === 20, `尾盘每分钟量 20 手（实际 ${bars[241].value}）`);
  ok(bars[210].value === 4, `尾盘前每分钟量仍为 4 手（实际 ${bars[210].value}）`);
}

// ============ [4] 数据日期诚实标注 ============
console.log('\n[4] 数据日期标注：休市时不得把上一交易日冒充今日');
{
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const raw = buildMinutes();
  const o1 = render({ ...raw, minuteDate: today });
  ok(o1.title.text === `${today} 分时走势 `, `今日数据：标题为日期无附加说明（实际「${o1.title.text}」）`);
  const o2 = render({ ...raw, minuteDate: '2026-10-17' });
  ok(/最近交易日，非今日/.test(o2.title.text), `非今日数据：显式标注「最近交易日，非今日」（实际「${o2.title.text}」）`);
  ok(o2.title.textStyle.color === Charts.colors.ma10, '非今日时用黄色（强调色）标注日期');
  const o3 = render({ ...raw, minuteDate: null });
  ok(/日期未知/.test(o3.title.text), '日期缺失时写「日期未知」，不臆造');
}

// ============ [5] 边界与容错 ============
console.log('\n[5] 边界：空数据 / 缺字段 / 脏数据不崩溃');
{
  captured.opt = null;
  Charts.minute('candlestickChart', { minutes: [], prevClose: 10, minuteDate: '2026-10-19' });
  ok(captured.opt === null, '空分时数组 → 不渲染、不抛错');
  Charts.minute('candlestickChart', null);
  ok(true, 'data 为 null → 不抛错');
  Charts.minute('candlestickChart', { minutes: [{ time: '0930', price: 10 }], prevClose: 10, minuteDate: '2026-10-19' });
  ok(captured.opt !== null && captured.opt.series[0].data.length === 1, '单条数据可渲染（不崩溃）');
}
{
  // 缺 cumVol（部分通道无累计量）→ 分钟量退化为 0，不产生 NaN
  const raw = buildMinutes();
  raw.minutes.forEach(m => { delete m.cumVol; });
  captured.opt = null;
  Charts.minute('candlestickChart', { ...raw, minuteDate: '2026-10-19' });
  const bars = captured.opt.series[2].data;
  ok(bars.every(b => b.value === 0), '缺 cumVol → 分钟量全为 0（不产生 NaN）');
}
{
  // 时间字段脏（带冒号，非腾讯格式）→ 被过滤，不误画
  const dirty = { minutes: [{ time: '09:30', price: 10, avg: 10, cumVol: 10 }, { time: '0930', price: 10, avg: 10, cumVol: 20 }], prevClose: 10, minuteDate: '2026-10-19' };
  captured.opt = null;
  Charts.minute('candlestickChart', dirty);
  ok(captured.opt.series[0].data.length === 1, `脏时间格式被过滤，仅保留 1 条合规数据（实际 ${captured.opt.series[0].data.length}）`);
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
