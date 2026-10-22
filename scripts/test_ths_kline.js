/**
 * 同花顺日K通道 · 解析/解码/合并回归（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_ths_kline.js
 * 覆盖 lib/stockData.js（20261017e 新增）——
 *   [1] last.js 明文解析（字段顺序 date,open,high,low,close,volume(股),amount(元),turnover(%)）
 *   [2] all.js 压缩解码（每天 4 个 price 值 = (最低价, 开盘−最低, 最高−最低, 收盘−最低) × priceFactor；
 *       volumn=股；dates=MMDD 按 sortYear 逐年展开）
 *   [3] 结构闸门（三列不等长/坏 MMDD/sortYear 欠计或超容忍 → null；末尾多计 1~2 容忍并从最后一年扣掉）
 *   [4] 真实黄金样本（scripts/fixtures/ths_000902_tail.json，2026-10-18 自 d.10jqka 捕获）：
 *       解码 all.js 尾部 30 根 vs last.js 明文尾部 30 根，OHLC/volume 必须逐根一致
 *   [5] 合并闸门（重叠段 close 逐日一致才采信 all.js 向过去延伸；不一致/重叠不足 → 只用 last.js）
 * 说明：网络采集（http→https 兜底、proxy:false 直连）由服务端实测覆盖，本文件只测确定性解析逻辑。
 */
const sd = require('../lib/stockData');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// 合成 all.js 压缩载荷：bars = [{y, mmdd, o, h, l, c, v}]（o/h/l/c 保留两位小数的正价格）
function mkAllPayload(bars, pf = 100) {
  const price = [];
  const volumn = [];
  const dates = [];
  const yearCount = {};
  for (const b of bars) {
    const li = Math.round(b.l * pf);
    price.push(String(li), String(Math.round(b.o * pf) - li), String(Math.round(b.h * pf) - li), String(Math.round(b.c * pf) - li));
    volumn.push(String(b.v));
    dates.push(b.mmdd);
    yearCount[b.y] = (yearCount[b.y] || 0) + 1;
  }
  return {
    priceFactor: pf,
    sortYear: Object.entries(yearCount).map(([y, c]) => [parseInt(y, 10), c]),
    price: price.join(','),
    volumn: volumn.join(','),
    dates: dates.join(','),
  };
}

// ============ [1] last.js 明文解析 ============
console.log('\n[1] last.js 明文解析：字段顺序与边界');
{
  const j = { data: '20261016,13.17,13.55,13.17,13.37,6452996,86263040.00,0.565,,200.00,2674;20261015,13.20,13.28,13.15,13.15,58000,76900000.00,,,0' };
  const bars = sd._parseThsLast(j);
  ok(bars && bars.length === 2, '两行 → 解析出 2 根');
  const b = bars[0];
  ok(b.date === '2026-10-16', 'date 归一为 YYYY-MM-DD');
  ok(b.open === 13.17 && b.high === 13.55 && b.low === 13.17 && b.close === 13.37, '字段顺序 date,open,high,low,close（最高≥最低≥…）');
  ok(b.volume === 6452996, 'volume 为股（与腾讯「手」差 100 倍口径）');
  ok(b.amount === 86263040, 'amount 为元');
  ok(b.turnover === 0.565, 'turnover 取第 8 字段（%）');
  ok(bars[1].turnover === 0, 'turnover 空串 → 0（不臆造）');
  const short = sd._parseThsLast({ data: '20261016,13.17,13.55;bad,1,2,3,4,5,6,7,8;20261015,13.2,13.28,13.4,13.15,58000,76900000,0.507' });
  ok(short && short.length === 1 && short[0].date === '2026-10-15', '字段不足/日期非法的行被跳过');
  ok(sd._parseThsLast({ data: '20261332,13.17,13.55,13.17,13.37,6452996,86263040.00,0.565' }) === null, 'last.js 日期越界（13月32日）→ 跳过该行');
  ok(sd._parseThsLast({ data: '20260232,13.17,13.55,13.17,13.37,6452996,86263040.00,0.565' }) === null, 'last.js 日期越界（2月32日）→ 跳过该行');
  ok(sd._parseThsLast(null) === null && sd._parseThsLast({}) === null && sd._parseThsLast({ data: '' }) === null, '空载荷 → null');
  ok(sd._parseThsLast({ data: 123 }) === null, 'data 非字符串 → null');
}

// ============ [2] all.js 压缩解码 ============
console.log('\n[2] all.js 压缩解码：(最低,开−最低,高−最低,收−最低)×priceFactor');
{
  const bars = [
    { y: 2026, mmdd: '1014', o: 51.61, h: 51.77, l: 50.82, c: 51.23, v: 86708928 },
    { y: 2026, mmdd: '1015', o: 50.91, h: 51.78, l: 50.85, c: 51.78, v: 82917159 },
    { y: 2026, mmdd: '1016', o: 51.43, h: 51.88, l: 51.01, c: 51.88, v: 66453701 },
  ];
  const decoded = sd._decodeThsAll(mkAllPayload(bars));
  ok(decoded && decoded.length === 3, '3 天 → 解码出 3 根');
  ok(decoded[2].date === '2026-10-16' && decoded[2].open === 51.43 && decoded[2].high === 51.88 && decoded[2].low === 51.01 && decoded[2].close === 51.88, '末日 OHLC 与编码值一致（low 为基）');
  ok(decoded[0].volume === 86708928 && decoded[2].volume === 66453701, 'volume 按位对齐（股）');
  ok(decoded.every(b => !('amount' in b) && !('turnover' in b)), 'all.js 不含成交额/换手率字段（由消费方降级标注）');
  // 跨年展开
  const cross = sd._decodeThsAll(mkAllPayload([
    { y: 2025, mmdd: '1230', o: 10, h: 10.5, l: 9.8, c: 10.2, v: 100 },
    { y: 2025, mmdd: '1231', o: 10.2, h: 10.4, l: 10, c: 10.1, v: 110 },
    { y: 2026, mmdd: '0102', o: 10.1, h: 10.3, l: 9.9, c: 10.25, v: 120 },
  ]));
  ok(cross && cross.length === 3 && cross[0].date === '2025-12-30' && cross[2].date === '2026-01-02', 'sortYear 逐年展开：MMDD + 年份 → 完整日期');
  ok(cross[1].close === 10.1 && cross[2].open === 10.1, '跨年边界值正确');
  // priceFactor 非常用值
  const pf1000 = sd._decodeThsAll(mkAllPayload([{ y: 2026, mmdd: '0105', o: 100.25, h: 101, l: 99.5, c: 100.75, v: 5 }], 1000));
  ok(pf1000 && pf1000[0].close === 100.75 && pf1000[0].low === 99.5, 'priceFactor=1000 时按因子缩放');
  // 一字板（开=高=低=收）
  const limitUp = sd._decodeThsAll(mkAllPayload([{ y: 2026, mmdd: '0106', o: 11, h: 11, l: 11, c: 11, v: 999 }]));
  ok(limitUp && limitUp[0].open === 11 && limitUp[0].high === 11 && limitUp[0].low === 11 && limitUp[0].close === 11, '一字板（四价相同）解码正确');
}

// ============ [3] 结构闸门 ============
console.log('\n[3] 结构闸门：不符结构 → null（绝不返回半可信数据）');
{
  const good = mkAllPayload([{ y: 2026, mmdd: '1016', o: 51.43, h: 51.88, l: 51.01, c: 51.88, v: 66453701 }]);
  ok(sd._decodeThsAll({ ...good, price: good.price + ',100' }) === null, 'price 数量非 4 的倍数 → null');
  ok(sd._decodeThsAll({ ...good, volumn: good.volumn + ',1' }) === null, 'volumn 与 dates 不等长 → null');
  ok(sd._decodeThsAll({ ...good, dates: '' }) === null, 'dates 为空 → null');
  ok(sd._decodeThsAll({ ...good, sortYear: undefined }) === null, 'sortYear 缺失 → null');
  ok(sd._decodeThsAll({ price: '1,2,3,4' }) === null, '仅 price 无其余列 → null');
  ok(sd._decodeThsAll(null) === null && sd._decodeThsAll({}) === null, '空载荷 → null');
  ok(sd._decodeThsAll({ ...good, dates: '9999' }) === null, 'MMDD 非法（9999）→ null');
  ok(sd._decodeThsAll({ ...good, dates: '1301' }) === null, 'MMDD 月份越界（13月）→ null');
  ok(sd._decodeThsAll({ ...good, dates: '0232' }) === null, 'MMDD 日期越界（32日）→ null');
  // 20261022e：末尾多计 1（当日条目未落入 dates）→ 容忍并从最后一年扣掉；多计 3 超容忍 → null
  const tolerate = sd._decodeThsAll({ ...good, sortYear: [[2026, 2]] });
  ok(tolerate && tolerate.length === 1, 'sortYear 末尾多计 1（2 vs dates 1）→ 容忍，解码 1 根');
  ok(sd._decodeThsAll({ ...good, sortYear: [[2026, 4]] }) === null, 'sortYear 多计 3（超容忍上限 2）→ null');
  ok(sd._decodeThsAll({ ...good, sortYear: [[2026, 1], [2025, 1]] }) === null, 'sortYear 多一年（计数和 2≠1，最后一年不足扣减）→ null');
  ok(sd._decodeThsAll({ ...good, sortYear: [[2026, 0]] }) === null, 'sortYear 计数为 0 → null');
  ok(sd._decodeThsAll({ ...good, price: good.price.replace('5101', 'x') }) === null, 'price 含非数字 → null（fail-closed：解析出 NaN 直接拒绝）');
}

// ============ [4] 真实黄金样本 ============
console.log('\n[4] 真实黄金样本：000902 实测尾部 30 根（2026-10-18 捕获）');
{
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ths_000902_tail.json'), 'utf8'));
  const decoded = sd._decodeThsAll(fx.all);
  const plain = sd._parseThsLast(fx.last);
  ok(decoded && decoded.length === 30 && plain && plain.length === 30, '两侧各解析出 30 根');
  let ohlc = 0, vol = 0;
  const pMap = new Map(plain.map(b => [b.date, b]));
  for (const d of decoded) {
    const p = pMap.get(d.date);
    if (!p) continue;
    if (Math.abs(d.open - p.open) < 0.005 && Math.abs(d.high - p.high) < 0.005 && Math.abs(d.low - p.low) < 0.005 && Math.abs(d.close - p.close) < 0.005) ohlc++;
    if (d.volume === p.volume) vol++;
  }
  ok(ohlc === 30 && vol === 30, `解码 all.js 与明文 last.js 逐根一致（OHLC ${ohlc}/30，volume ${vol}/30）`);
  const lastD = decoded[decoded.length - 1];
  ok(lastD.date === '2026-10-16' && Math.abs(lastD.close - 13.37) < 0.005 && Math.abs(lastD.low - 13.17) < 0.005, '末根锚定真实值（2026-10-16 close=13.37 low=13.17，防静默漂移）');
  const lastP = plain[plain.length - 1];
  ok(lastP.amount === 86263040 && lastP.turnover === 0.565, '末根成交额 86263040 元、换手率 0.565% 锚定真实值');
  ok(plain.every(b => b.volume > 0 && b.amount > 0 && b.turnover > 0), '30 根成交额/换手率全部有值（同花顺 last.js 全字段）');
}

// ============ [5] 合并闸门 ============
console.log('\n[5] 合并闸门：重叠段 close 一致才采信 all.js 延伸');
{
  // 构造：plain 近 140 根（带 amount/turnover）+ decoded = 同 140 根 + 更早 100 根历史
  // 注意：decoded 侧必须复刻 _decodeThsAll 的真实产物形态——只有 OHLCV，无 amount/turnover（见 [2] 断言）
  const mkPlain = (n, startClose) => Array.from({ length: n }, (_, i) => {
    const c = startClose + i * 0.01;
    return { date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1000 + i, amount: c * (1000 + i) * 100, turnover: 1.5 };
  });
  const plain = mkPlain(140, 10);
  const hist = mkPlain(100, 5).map((b, i) => ({ date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const decodedConsistent = [...hist, ...plain.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))];
  const merged = sd._mergeThsBars(plain, decodedConsistent, 320);
  ok(merged.length === 240, '闸门通过 → 历史 100 + 近期 140 合并为 240 根');
  ok(merged[0].date === hist[0].date && merged[99].date === hist[99].date, '前 100 根来自 all.js 解码延伸');
  ok(merged[140].amount > 0 && merged[140].turnover > 0, '近期 140 根保留 amount/turnover（last.js 权威）');
  // 20261022e：历史延伸段成交额回填（volume×close）；本例 volume 递增而 turnover 恒定 → 流通盘跨期不稳 → 换手率不回填
  ok(merged.slice(0, 100).every(b => b.amount > 0 && b.amountEstimated), '历史延伸段成交额已回填（volume×close，标记推算）');
  ok(merged.slice(0, 100).every(b => !(b.turnover > 0)), '流通盘跨期不稳（volume 递增、turnover 恒定）→ 换手率不回填');
  // 闸门失败：overlap 中有一根 close 不一致
  const decodedBad = decodedConsistent.map((b, i) => i === 200 ? { ...b, close: b.close + 0.5 } : b);
  const mergedBad = sd._mergeThsBars(plain, decodedBad, 320);
  ok(mergedBad.length === 140 && mergedBad.every(b => b.amount > 0), '重叠段 1 根 close 不符 → 弃 all.js 只用 last.js');
  // 重叠不足 30 根
  const decodedFew = hist.slice(0, 10).concat(decodedConsistent.slice(-140).slice(0, 10));
  const mergedFew = sd._mergeThsBars(plain, decodedFew, 320);
  ok(mergedFew.length === 140, '重叠仅 10 根（<30）→ 不采信解码延伸');
  // decoded 不比 plain 长 / 为 null
  ok(sd._mergeThsBars(plain, plain.map(b => ({ ...b })), 320).length === 140, 'decoded 不长于 plain → 只用 plain');
  ok(sd._mergeThsBars(plain, null, 320).length === 140, 'decoded 为 null → 只用 plain');
  // count 截取
  ok(sd._mergeThsBars(plain, null, 50).length === 50 && sd._mergeThsBars(plain, null, 50)[49].date === plain[139].date, 'count=50 → 取末尾 50 根');
  // 历史延伸段含无效根（low≤0）→ 被过滤
  const decodedInv = [...hist.map((b, i) => i === 3 ? { ...b, low: -1, high: -0.5, open: -0.8, close: -0.6 } : b), ...decodedConsistent.slice(-140)];
  const mergedInv = sd._mergeThsBars(plain, decodedInv, 320).filter(b => b.low > 0);
  ok(mergedInv.length === 239, '延伸段无效根（负价）在合并后过滤（240→239）');
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
