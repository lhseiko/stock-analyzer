/**
 * ②卡「上方关键阻力区间 / 下方关键支撑区间」排序口径守卫
 * ------------------------------------------------------------
 * 运行： node scripts/test_zone_sort_order.js
 *
 * 用户需求（20261022i 原文）：
 *   「做错了，我要求的是上方和下方区间统一从上到下按照价格的高度排序。」
 *
 * 历史教训：
 *   20261022h 曾实现为「阻力 low 升序 / 支撑 low 降序」——两段都是"离现价最近的在最上面"，
 *   方向相反、整卡不连续。表现为上方 5.48→6.62、下方 4.94→4.59，用户判定为做错了。
 *
 * 现行口径（本文件守住）：
 *   两段**统一按 low 从高到低**（高价在上、低价在下），整卡自上而下价格单调不增，
 *   等价于一根竖直价格轴：6.62 … 5.48（阻力） → 4.99 … 4.59（支撑）。
 *
 * 数据来源：用户截图（屏幕截图 2026-10-22 201701.png）中的 7 条阻力 + 3 条支撑，数值逐条照抄。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---------------- 最小 DOM 桩（只为让 app.js 能加载） ----------------
function makeClassList() {
  const s = new Set();
  return { add(...c) { c.forEach(x => s.add(x)); }, remove(...c) { c.forEach(x => s.delete(x)); }, contains(c) { return s.has(c); }, toggle() {} };
}
global.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  createElement: () => ({ classList: makeClassList(), style: {}, appendChild() {}, addEventListener() {} }),
  body: { classList: makeClassList(), appendChild() {} },
  documentElement: { classList: makeClassList() },
};
global.window = global;
global.window.addEventListener = () => {};
global.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.location = { href: 'http://127.0.0.1:3005/', search: '', pathname: '/', hash: '' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
global.Event = class { constructor(t) { this.type = t; } };
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.Storage = { getWatchlist: () => [], addToHistory() {}, initWatchlist: async () => {}, getGroups: () => [], formatNumber: (v) => String(v) };
global.DocStore = { setStock() {}, onTabSwitch() {} };
global.DeepCharts = { disposeAll() {} };
global.echarts = { init: () => ({ setOption() {}, dispose() {}, on() {}, getZr: () => ({ on() {}, off() {} }) }), registerTheme() {} };

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const App = new Function(`${src}; return App;`)();

// ---------------- 截图里的真实数据（7 阻力 + 3 支撑） ----------------
const RESISTANCES = [
  { low: 5.48, high: 5.53, strength: '中', source: '周线摆动高点 + 20日成交量加权均价 + Camarilla C-R1 等 8 项' },
  { low: 5.68, high: 5.73, strength: '强', source: 'MA120（下压） + 近120日成交密集区 + 120日成交量加权均价 等 8 项' },
  { low: 5.68, high: 5.68, isBox: true, theme: '箱体上沿（73 日）' },   // 单点价（low===high）
  { low: 5.76, high: 5.94, strength: '中', source: '周P-R1 + 周线摆动高点 + 近120日摆动高点' },
  { low: 6.07, high: 6.25, strength: '中', source: '周线摆动高点 + 周P-R2 + 整数关口 6 等 4 项' },
  { low: 6.34, high: 6.48, strength: '中', source: '近120日成交密集区 + 周线摆动高点' },
  { low: 6.48, high: 6.62, strength: '中', source: 'MA250（下压） + 近120日摆动高点' },
];
const SUPPORTS = [
  { low: 4.94, high: 4.99, strength: '强', source: '周线摆动低点 + 周P-S1 + 近120日摆动低点 等 5 项' },
  { low: 4.76, high: 4.76, isBox: true, theme: '箱体下沿（73 日）' },
  { low: 4.59, high: 4.76, strength: '中', source: '周线摆动低点 + 周P-S2 + 近120日摆动低点' },
];

const lows = (arr) => arr.map(z => Number(z.low));

// ============================================================
console.log('\n[1] 上方关键阻力区间：高价在上、低价在下');
const resSorted = App._sortZones(RESISTANCES, 'resistance');
const resLows = lows(resSorted);
console.log('     实际顺序 low =', resLows.join(' → '));
ok(resLows.join(',') === [6.48, 6.34, 6.07, 5.76, 5.68, 5.68, 5.48].join(','),
  `low 序列正确（期望 6.48→6.34→6.07→5.76→5.68→5.68→5.48，实际 ${resLows.join('→')}）`);
ok(resSorted[0].high === 6.62, `最上面是最高的一条（6.48~6.62，实际 high=${resSorted[0].high}）`);
ok(resSorted[resSorted.length - 1].low === 5.48, `最下面是最近的一条（5.48~5.53，实际 low=${resSorted[resSorted.length - 1].low}）`);
ok(resLows.every((v, i) => i === 0 || resLows[i - 1] >= v), '整段单调不增（自上而下价格越来越低）');

console.log('\n[2] 下方关键支撑区间：同一方向（高价在上、低价在下）');
const supSorted = App._sortZones(SUPPORTS, 'support');
const supLows = lows(supSorted);
console.log('     实际顺序 low =', supLows.join(' → '));
ok(supLows.join(',') === [4.94, 4.76, 4.59].join(','), `low 序列正确（期望 4.94→4.76→4.59，实际 ${supLows.join('→')}）`);
ok(supLows.every((v, i) => i === 0 || supLows[i - 1] >= v), '整段单调不增');

console.log('\n[3] 两段口径必须**一致**（这正是 20261022h 做错的地方）');
const resAsc = resLows.every((v, i) => i === 0 || resLows[i - 1] <= v);
const supDesc = supLows.every((v, i) => i === 0 || supLows[i - 1] >= v);
ok(!(resAsc && supDesc), '不再出现「阻力升序 + 支撑降序」的相反方向组合（旧口径特征）');
ok(resLows[0] === Math.max(...resLows) && supLows[0] === Math.max(...supLows),
  '两段的第一条都是该段最高价 → 方向统一');
ok(resLows[resLows.length - 1] === Math.min(...resLows) && supLows[supLows.length - 1] === Math.min(...supLows),
  '两段的最后一条都是该段最低价 → 方向统一');

console.log('\n[4] 整卡连成一根价格轴（上方最低价 仍高于 下方最高价，自上而下单调下降）');
const wholeCard = lows(resSorted).concat(lows(supSorted));
console.log('     整卡 low =', wholeCard.join(' → '));
ok(wholeCard.every((v, i) => i === 0 || wholeCard[i - 1] >= v),
  '自上而下（阻力段 → 支撑段）价格单调不增，读起来与看盘软件纵轴一致');
ok(resLows[resLows.length - 1] > supLows[0], `阻力段最低(${resLows[resLows.length - 1]}) > 支撑段最高(${supLows[0]})，两段不交叉`);

console.log('\n[5] 单点价条目（箱体上沿/下沿，low===high）参与统一排序');
const boxInRes = resSorted.filter(z => z.isBox);
const boxInSup = supSorted.filter(z => z.isBox);
ok(boxInRes.length === 1 && Number(boxInRes[0].low) === 5.68, '箱体上沿 5.68 仍在阻力段内');
ok(boxInSup.length === 1 && Number(boxInSup[0].low) === 4.76, '箱体下沿 4.76 仍在支撑段内');
const idx568 = resLows.indexOf(5.68);
ok(idx568 > 0 && resLows[idx568 - 1] === 5.76, '5.68 落在 5.76 之下（按价格插入，未被打到队首/队尾）');

console.log('\n[6] 接口数据不得被改写（④卡取 [0]、量能规则4 取就近位依赖后端顺序）');
const origResLows = lows(RESISTANCES);
const origSupLows = lows(SUPPORTS);
ok(origResLows.join(',') === '5.48,5.68,5.68,5.76,6.07,6.34,6.48', '阻力原数组顺序未被修改（仍为 low 升序）');
ok(origSupLows.join(',') === '4.94,4.76,4.59', '支撑原数组顺序未被修改（仍为 low 降序）');
ok(resSorted !== RESISTANCES && supSorted !== SUPPORTS, '返回的是副本，不是原数组引用');

console.log('\n[7] 边界');
ok(App._sortZones([], 'resistance').length === 0, '空数组不抛错');
ok(App._sortZones(null, 'support').length === 0, 'null 不抛错');
ok(App._sortZones(undefined, 'support').length === 0, 'undefined 不抛错');
const one = App._sortZones([{ low: 3.3, high: 3.3 }], 'resistance');
ok(one.length === 1 && one[0].low === 3.3, '单条不抛错');
const noLow = App._sortZones([{ high: 1 }, { low: 2, high: 3 }], 'resistance');
ok(noLow.length === 2 && Number(noLow[0].low) === 2, '缺 low 的条目（按 0 处理）排在最后，不抛错');
const same = App._sortZones([{ low: 5 }, { low: 5 }], 'resistance');
ok(same.length === 2, '同价条目保留两条（不被去重）');

console.log('\n[8] 源码守卫：不得退回 side 分支排序');
ok(/_sortZones\(arr, side\)/.test(src), '_sortZones 签名保留（兼容既有调用点）');
ok(!/if \(sd === 'support'\) list\.sort/.test(src), '已删除「支撑降序 / 阻力升序」的 side 分支');
ok(!/else list\.sort\(\(a, b\) => lo\(a\) - lo\(b\)\)/.test(src), '已删除阻力升序分支');
ok(/list\.sort\(\(a, b\) => lo\(b\) - lo\(a\)\);/.test(src), '统一按 low 降序排序');

// ============================================================
console.log('\n' + '='.repeat(60));
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) { console.log('✗ 有失败用例'); process.exit(1); }
console.log('✓ 全部通过：上下两段统一按价格高度自上而下排列（高价在上）');
