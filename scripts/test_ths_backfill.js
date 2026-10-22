/**
 * 同花顺历史段「成交额/换手率」回填（20261022e）回归
 * --------------------------------------------------------------
 * 运行： node scripts/test_ths_backfill.js
 * 覆盖 lib/stockData._backfillThsFields / _mergeThsBars：
 *   [1] 回填：历史段 amount=volume×close、turnover=volume/流通盘；权威行不动
 *   [2] 流通盘跨期离散 >3%（送转）→ 不回填换手率（fail-closed），成交额仍可回填
 *   [3] 权威样本 <20 根 → 不回填换手率（成交额仍可回填）
 *   [4] 合并后 250 日样本数量达到 250+（原 140 的修复目标）
 *   [5] 解码未过闸门 → 只用 last.js，不产生推算标记
 */
const sd = require('../lib/stockData');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

function dstr(i) {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
function bar(i, close, volume, extra) {
  return Object.assign({ date: dstr(i), open: close, high: close * 1.01, low: close * 0.99, close, volume }, extra || {});
}

// 400 根解码历史：前 260 根仅 OHLCV（成交额/换手率缺失），后 140 根与 last.js 重叠
function mkDecoded(volHist, closeHist) {
  const arr = [];
  for (let i = 0; i < 400; i++) arr.push(bar(i, i < 260 ? closeHist : 10, i < 260 ? volHist : 1000));
  return arr;
}
// last.js 权威 140 根：volume 1000 / turnover 10% / amount 10000（隐含流通盘 10000 股）
function mkPlain(turnoverFn) {
  const arr = [];
  for (let i = 260; i < 400; i++) {
    const turnover = turnoverFn ? turnoverFn(i - 260) : 10;
    arr.push(bar(i, 10, 1000, { amount: 10000, turnover }));
  }
  return arr;
}

console.log('\n[1] 回填：历史段成交额/换手率');
{
  const merged = sd._mergeThsBars(mkPlain(), mkDecoded(500, 10), 320);
  eq(merged.length, 320, '合并后 320 根');
  const h = merged[0];
  eq(h.amount, 5000, '历史段 amount = volume×close（500×10）');
  eq(h.amountEstimated, true, '历史段 amount 标记为推算');
  eq(h.turnover, 5, '历史段 turnover = 500/10000×100 = 5%');
  eq(h.turnoverEstimated, true, '历史段 turnover 标记为推算');
  const auth = merged[merged.length - 1];
  eq(auth.amount, 10000, '权威行 amount 原值不动');
  eq(auth.turnover, 10, '权威行 turnover 原值不动');
  ok(!auth.amountEstimated && !auth.turnoverEstimated, '权威行不带推算标记');
}

console.log('\n[2] 流通盘跨期离散 >3% → 不回填换手率');
{
  // 后半段 turnover 减半 → 隐含流通盘翻倍 → 离散 100% > 3%
  const plain = mkPlain((i) => (i < 70 ? 10 : 5));
  const merged = sd._mergeThsBars(plain, mkDecoded(500, 10), 320);
  const h = merged[0];
  eq(h.turnover, 0, '换手率保持 0（不回填，fail-closed）');
  ok(!h.turnoverEstimated, '无换手率推算标记');
  eq(h.amount, 5000, '成交额仍回填（不依赖流通盘）');
}

console.log('\n[3] 权威样本 <20 根 → 不回填换手率');
{
  const plain = mkPlain().slice(0, 10);   // 只有 10 根权威
  const merged = sd._backfillThsFields(
    [{ date: dstr(0), open: 10, high: 10.1, low: 9.9, close: 10, volume: 500, amount: 0, turnover: 0 }],
    plain,
  );
  eq(merged[0].turnover, 0, '样本不足 → 换手率不推算');
  eq(merged[0].amount, 5000, '成交额照常回填');
}

console.log('\n[4] 250 日样本数量达标');
{
  const merged = sd._mergeThsBars(mkPlain(), mkDecoded(500, 10), 320);
  const tw = merged.slice(-250).filter(b => b.turnover > 0).length;
  const aw = merged.slice(-250).filter(b => b.amount > 0).length;
  eq(tw, 250, '换手率 250 日样本 = 250（原仅 140）');
  eq(aw, 250, '成交额 250 日样本 = 250（原仅 140）');
}

console.log('\n[5] 解码未过闸门 → 只用 last.js，不产生推算标记');
{
  const decoded = mkDecoded(500, 10);
  // 把重叠段 close 改掉 → 闸门失败
  for (let i = 260; i < 400; i++) decoded[i].close = 11;
  const merged = sd._mergeThsBars(mkPlain(), decoded, 320);
  eq(merged.length, 140, '闸门失败 → 仅 140 根');
  ok(!merged.some(b => b.amountEstimated || b.turnoverEstimated), '不产生推算标记');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
