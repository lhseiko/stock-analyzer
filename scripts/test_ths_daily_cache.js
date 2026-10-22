/**
 * 同花顺日K本地缓存（20261022f，用户方案 C）回归
 * --------------------------------------------------------------
 * 运行： node scripts/test_ths_daily_cache.js
 * 覆盖 lib/thsDailyCache.js：
 *   [1] resolveSlot —— 交易日盘中 / 收盘后边界（15:04 vs 15:05）
 *   [2] resolveSlot —— 周末锚定上一个交易日
 *   [3] resolveSlot —— 国庆长假锚定节前最后交易日
 *   [4] isFresh —— 命中 + 各类未命中原因（跨日 / 跨时段 / all.js 缺失 / schema / 过期 / 时钟超前）
 *   [5] 读写往返：写后读命中，跨日不命中
 *   [6] 缓存损坏 / 不存在 → 一律降级为未命中且不抛
 *   [7] 原子写：不残留 .tmp
 *   [8] cacheMeta 只回元信息，不回原始文本
 *
 * 说明：用 999999 / 999998 等虚构代码，避免污染真实个股缓存（603288 等）。
 */
const fs = require('fs');
const path = require('path');
const c = require('../lib/thsDailyCache');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

// 北京时间构造（resolveSlot 内部按 Asia/Shanghai 解析，与宿主机时区无关）
const bj = (s) => new Date(s + '+08:00');

const TEST_SYMS = ['999999', '999998', '999997'];
function cleanup() {
  for (const s of TEST_SYMS) {
    const f = c.fileFor(s);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn('清理失败:', e.message); }
    try { if (fs.existsSync(f + '.tmp')) fs.unlinkSync(f + '.tmp'); } catch (e) { console.warn('清理 tmp 失败:', e.message); }
  }
}
cleanup();

// 合法 JSONP 文本（结构只需能被 writeCache 接受，此处不解析）
const LAST_OK = 'quotebridge123({"data":"20261021,10,11,9,10.5,1000,10500,10.2"})';
const ALL_OK = 'quotebridge123({"price":"1000,50,200,50","volumn":"1000","dates":"1021","sortYear":[[2026,1]],"priceFactor":100})';

console.log('\n[1] resolveSlot：交易日盘中 / 收盘后边界');
{
  const s1 = c.resolveSlot(bj('2026-10-22T10:00:00'));
  eq(s1.tradeDate, '2026-10-22', '盘中锚定当日');
  eq(s1.phase, 'intraday', '盘中 phase=intraday');
  eq(s1.isTradingDay, true, '盘中判定为交易日');

  const s2 = c.resolveSlot(bj('2026-10-22T15:04:00'));
  eq(s2.phase, 'intraday', '15:04 仍属盘中（未收盘）');

  const s3 = c.resolveSlot(bj('2026-10-22T15:05:00'));
  eq(s3.phase, 'closed', '15:05 起切换为收盘后（与 finalizedBars 同口径）');

  const s4 = c.resolveSlot(bj('2026-10-22T23:59:00'));
  eq(s4.phase, 'closed', '深夜仍为收盘后');
  eq(s4.tradeDate, '2026-10-22', '深夜仍锚定当日');
  eq(s4.hhmm, 2359, 'hhmm 计算正确');
}

console.log('\n[2] resolveSlot：周末锚定上一个交易日');
{
  const sat = c.resolveSlot(bj('2026-10-24T10:00:00'));   // 周六
  eq(sat.tradeDate, '2026-10-23', '周六锚定周五');
  eq(sat.phase, 'closed', '周六一律 closed（非交易日无盘中变化）');
  eq(sat.isTradingDay, false, '周六非交易日');

  const sun = c.resolveSlot(bj('2026-10-25T09:00:00'));   // 周日早上
  eq(sun.tradeDate, '2026-10-23', '周日早上仍锚定周五');
  eq(sun.phase, 'closed', '周日早上按 closed（否则会与周五收盘后缓存错位）');
}

console.log('\n[3] resolveSlot：国庆长假锚定节前最后交易日');
{
  const s = c.resolveSlot(bj('2026-10-05T11:00:00'));     // 长假中的周一
  eq(s.tradeDate, '2026-09-30', '长假期间锚定 9/30（节前最后交易日）');
  eq(s.phase, 'closed', '长假期间一律 closed');
  eq(s.isTradingDay, false, '长假期间非交易日');

  const last = c.resolveSlot(bj('2026-09-30T16:00:00'));
  eq(last.tradeDate, '2026-09-30', '节前最后交易日当天锚定当日');
  eq(last.phase, 'closed', '节前最后交易日 16:00 为 closed');
}

console.log('\n[4] isFresh：命中与各类未命中');
{
  const slot = c.resolveSlot(bj('2026-10-22T20:00:00'));
  const nowMs = bj('2026-10-22T20:00:00').getTime();
  const rec = {
    schema: c.SCHEMA, symbol: '999999', tradeDate: '2026-10-22', phase: 'closed',
    fetchedAt: nowMs - 1000, lastRaw: LAST_OK, allRaw: ALL_OK,
  };
  ok(c.isFresh(rec, slot, nowMs).hit, '完全匹配 → 命中');
  eq(c.isFresh(rec, slot, nowMs).why, 'ok', '命中原因 = ok');

  eq(c.isFresh(null, slot, nowMs).why, 'no_cache', '空记录 → no_cache');
  eq(c.isFresh(Object.assign({}, rec, { tradeDate: '2026-10-21' }), slot, nowMs).why, 'trade_date_changed', '跨日 → trade_date_changed');
  eq(c.isFresh(Object.assign({}, rec, { phase: 'intraday' }), slot, nowMs).why, 'phase_changed', '跨时段 → phase_changed');
  eq(c.isFresh(Object.assign({}, rec, { allRaw: '' }), slot, nowMs).why, 'incomplete_all', 'all.js 缺失 → 不算有效缓存（否则一整天卡在 140 根）');
  eq(c.isFresh(Object.assign({}, rec, { lastRaw: '' }), slot, nowMs).why, 'corrupt_last', 'last.js 缺失 → corrupt_last');
  eq(c.isFresh(Object.assign({}, rec, { schema: 999 }), slot, nowMs).why, 'schema_mismatch', 'schema 不符 → schema_mismatch');
  eq(c.isFresh(Object.assign({}, rec, { fetchedAt: nowMs - c.MAX_AGE_MS - 1 }), slot, nowMs).why, 'stale', '超 15 天 → stale');
  eq(c.isFresh(Object.assign({}, rec, { fetchedAt: nowMs + c.MAX_FUTURE_MS + 1 }), slot, nowMs).why, 'clock_ahead', '时间戳在未来 → clock_ahead');
  eq(c.isFresh(Object.assign({}, rec, { fetchedAt: 'x' }), slot, nowMs).why, 'corrupt_fetchedAt', 'fetchedAt 非数字 → corrupt_fetchedAt');
  eq(c.isFresh(rec, null, nowMs).why, 'bad_slot', 'slot 缺失 → bad_slot');
  ok(c.isFresh(Object.assign({}, rec, { fetchedAt: nowMs - c.MAX_AGE_MS + 1000 }), slot, nowMs).hit === false
    || c.isFresh(Object.assign({}, rec, { fetchedAt: nowMs - c.MAX_AGE_MS + 1000 }), slot, nowMs).hit === true,
  '过期边界附近不抛异常');
}

console.log('\n[5] 读写往返：写后读命中，跨日不命中');
{
  const sym = '999999';
  const slot = c.resolveSlot(bj('2026-10-22T20:00:00'));
  const nowMs = bj('2026-10-22T20:00:00').getTime();
  const saved = c.writeCache(sym, slot, LAST_OK, ALL_OK, nowMs);
  ok(!!saved && saved.schema === c.SCHEMA, 'writeCache 返回 payload');
  ok(fs.existsSync(c.fileFor(sym)), '缓存文件已生成: ' + c.fileFor(sym));

  const r1 = c.readCache(sym, slot, nowMs);
  ok(r1.hit, '同日同时段 → 命中');
  eq(r1.rec.lastRaw, LAST_OK, 'lastRaw 原样还原');
  eq(r1.rec.allRaw, ALL_OK, 'allRaw 原样还原');

  const nextDay = c.resolveSlot(bj('2026-10-23T20:00:00'));
  const r2 = c.readCache(sym, nextDay, bj('2026-10-23T20:00:00').getTime());
  ok(!r2.hit, '次日 → 不命中');
  eq(r2.why, 'trade_date_changed', '次日未命中原因 = trade_date_changed');

  const intraday = c.resolveSlot(bj('2026-10-22T10:00:00'));
  const r3 = c.readCache(sym, intraday, bj('2026-10-22T10:00:00').getTime());
  ok(!r3.hit, '同日盘中 vs 收盘后 → 不命中（需补抓收盘K）');
  eq(r3.why, 'phase_changed', '跨时段未命中原因 = phase_changed');
}

console.log('\n[6] 缓存损坏 / 不存在 → 降级为未命中且不抛');
{
  const sym = '999998';
  const slot = c.resolveSlot(bj('2026-10-22T20:00:00'));
  const nowMs = bj('2026-10-22T20:00:00').getTime();

  const miss = c.readCache(sym, slot, nowMs);
  ok(!miss.hit, '文件不存在 → 未命中');
  eq(miss.why, 'missing', '文件不存在原因 = missing');

  c.writeCache(sym, slot, LAST_OK, ALL_OK, nowMs);
  fs.writeFileSync(c.fileFor(sym), '{ 这不是合法 JSON', 'utf8');
  let threw = false;
  let r;
  try { r = c.readCache(sym, slot, nowMs); } catch (e) { threw = true; }
  ok(!threw, '缓存损坏不抛异常');
  ok(r && !r.hit, '缓存损坏 → 未命中');
  eq(r && r.why, 'corrupt', '缓存损坏原因 = corrupt');

  let threw2 = false;
  try { c.writeCache('', slot, LAST_OK, ALL_OK, nowMs); } catch (e) { threw2 = true; }
  ok(threw2, '空代码写入 → 抛错（避免写到 无用文件）');
}

console.log('\n[7] 原子写：不残留 .tmp');
{
  const sym = '999997';
  const slot = c.resolveSlot(bj('2026-10-22T20:00:00'));
  const nowMs = bj('2026-10-22T20:00:00').getTime();
  c.writeCache(sym, slot, LAST_OK, ALL_OK, nowMs);
  ok(!fs.existsSync(c.fileFor(sym) + '.tmp'), '写入完成后无 .tmp 残留');
  ok(fs.existsSync(c.fileFor(sym)), '正式文件存在');

  // 覆盖写：第二次写入应替换内容且仍无 .tmp
  c.writeCache(sym, slot, LAST_OK + 'x', ALL_OK, nowMs);
  ok(!fs.existsSync(c.fileFor(sym) + '.tmp'), '覆盖写后仍无 .tmp 残留');
  eq(c.readCache(sym, slot, nowMs).rec.lastRaw, LAST_OK + 'x', '覆盖写生效（不累积、只保留最新一份）');
}

console.log('\n[8] cacheMeta：只回元信息');
{
  const sym = '999999';
  const m = c.cacheMeta(sym);
  ok(!!m, 'cacheMeta 返回对象');
  eq(m.tradeDate, '2026-10-22', '元信息含锚定交易日');
  eq(m.phase, 'closed', '元信息含时段');
  ok(m.bytes && m.bytes.last === Buffer.byteLength(LAST_OK, 'utf8'), '元信息含 last.js 字节数');
  ok(m.bytes && m.bytes.all === Buffer.byteLength(ALL_OK, 'utf8'), '元信息含 all.js 字节数');
  ok(!Object.prototype.hasOwnProperty.call(m, 'lastRaw'), '元信息不含原始文本 lastRaw');
  ok(!Object.prototype.hasOwnProperty.call(m, 'allRaw'), '元信息不含原始文本 allRaw');
  ok(c.cacheMeta('999990') === null, '无缓存代码 → null');
}

console.log('\n[9] normalizeSymbol / fileFor');
{
  eq(c.normalizeSymbol('sh603288'), '603288', 'sh 前缀剥离');
  eq(c.normalizeSymbol('SZ000001'), '000001', 'SZ 大写剥离');
  eq(c.normalizeSymbol('603288.SS'), '603288', '后缀剥离');
  ok(c.fileFor('603288').endsWith(path.join('data', 'cache', 'ths-daily', '603288.json')), '文件路径落在 data/cache/ths-daily');
}

cleanup();

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
