/**
 * 离线单测：个股技术面「过期未结算」误报修复（20261002c）
 * 覆盖：
 *  1. recordDailyJudgment 的 targetDate = 基准日 + HORIZON 个交易日（不再误用 base+1）
 *  2. settleSymbol 对“验证窗口未到/数据未出”的记录打 status='pending'，computeAccuracy.overdueCount 不误报
 *  3. 已可结算的记录正常结算（status='settled'）
 *  4. 基准日 K 线缺失（真实异常）→ status='error' → 计入 overdueCount
 *  5. 历史无 status 记录（如 09-23~09-29 旧记录）：实时重算真实目标日（含法定节假日），
 *     不再信任陈旧 targetDate，长假期间合法 pending 不再误报“过期未结算”
 * 注：fileFor() 会剥离非字母数字，故测试用 symbol 不含下划线。
 * 跑法：node scripts/test_tech_face_overdue.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day; // 本地日期，避免 toISOString 的 UTC 偏移把日期往前推一天
}
function makeBars(start, end, base) {
  const out = [];
  const d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  let i = 0;
  while (d <= e) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      out.push({ date: fmtDate(d), close: +(base + (i % 3) * 0.1).toFixed(2) });
      i++;
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}
const MY_BARS = {
  TFATESTWAIT: makeBars('2026-08-25', '2026-09-30', 10.0),  // 末根 09-30，验证窗口未到
  TFATESTDONE: makeBars('2026-08-25', '2026-09-30', 10.0),  // 含可结算基准日 09-01
  TFATESTERR:  makeBars('2026-09-20', '2026-09-30', 10.0),  // 不含基准日 09-15
};
for (const b of MY_BARS.TFATESTDONE) {
  if (b.date >= '2026-09-08' && b.date <= '2026-09-14') b.close = 12.0; // 09-01 后 5 交易日上行
}

const tf = require('../lib/techFaceJudgment');

function clean(sym) { try { fs.unlinkSync(path.join(tf.DIR, sym + '.json')); } catch (e) {} }
function seed(sym, rec) {
  fs.writeFileSync(path.join(tf.DIR, sym + '.json'), JSON.stringify([rec], null, 2));
}

let n = 0, pass = 0;
function syncCase(name, fn) {
  n++;
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; }
}
async function asyncCase(name, fn) {
  n++;
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

console.log('\n=== 20261002c：targetDate = 基准日 + HORIZON（修复 base+1 误报）===');
syncCase('recordDailyJudgment 写入 targetDate = baseDate+HORIZON(5)，而非 base+1', () => {
  clean('TFATESTREC');
  const pa = { shortTerm: { direction: '上行', dirScore: 3, probability: '高', pattern: '无' }, longTerm: { verdict: '上行' }, meta: { range: '2026-09-01 ~ 2026-09-30' } };
  const rec = tf.recordDailyJudgment('TFATESTREC', pa, { name: '测试' });
  assert.ok(rec, '应返回记录');
  assert.strictEqual(rec.baseDate, '2026-09-30');
  assert.strictEqual(rec.targetDate, '2026-10-14', 'targetDate 应为 base+HORIZON(5,含国庆休市)=2026-10-14');
  assert.notStrictEqual(rec.targetDate, '2026-10-01', '不应再是 base+1=2026-10-01（旧 bug）');
  assert.strictEqual(rec.status, 'pending', '初始 status 应为 pending');
  clean('TFATESTREC');
});

console.log('\n=== 无 status 历史记录：实时重算真实目标日（20261002c-2 补强）===');
syncCase('2020 年真过期（无 status）→ 仍计入 overdueCount（真实异常不漏检）', () => {
  const a = tf.computeAccuracy('X', [{ symbol: 'X', baseDate: '2020-01-01', targetDate: '2020-01-02', shortDir: '涨', settled: false }]);
  assert.ok(a.overdueCount >= 1, '久远未结算记录（base+HORIZON 仍远早于 today）应仍判过期');
});

syncCase('2026-09-23 旧记录：stale targetDate=base+1 但真实目标日=10-08 → 不计过期', () => {
  // 复现用户截图场景：4 条 09-23~09-29 旧记录无 status、存储 targetDate 为 base+1（已过期日），
  // 但真实验证目标日 = 基准日 + 5 交易日（10-08 附近，长假尚未到）→ 合法 pending，误报应消除。
  const recs = [
    { symbol: 'TFAOLD1', baseDate: '2026-09-23', targetDate: '2026-09-24', shortDir: '涨', settled: false }, // stale base+1
    { symbol: 'TFAOLD2', baseDate: '2026-09-24', targetDate: '2026-09-25', shortDir: '跌', settled: false },
    { symbol: 'TFAOLD3', baseDate: '2026-09-28', targetDate: '2026-09-29', shortDir: '涨', settled: false },
    { symbol: 'TFAOLD4', baseDate: '2026-09-29', targetDate: '2026-09-30', shortDir: '震荡', settled: false },
  ];
  const a = tf.computeAccuracy('X', recs);
  assert.strictEqual(a.overdueCount, 0, '真实目标日(10-08 附近) 尚未到 → 0 过期，实际=' + a.overdueCount);
  assert.strictEqual(a.pendingCount, 4, '4 条均应为合法待验证（pending），实际=' + a.pendingCount);
});

console.log('\n=== 20261002c：结算引擎打 status（核心修复，barsOverride 离线可测）===');
(async () => {
  await asyncCase('验证窗口未到 → status=pending，overdueCount=0（核心修复）', async () => {
    clean('TFATESTWAIT');
    seed('TFATESTWAIT', { symbol: 'TFATESTWAIT', baseDate: '2026-09-30', horizon: tf.HORIZON, shortDir: '涨', probability: '高', settled: false, status: 'pending' });
    await tf.settleSymbol('TFATESTWAIT', MY_BARS.TFATESTWAIT);
    const a = tf.computeAccuracy('TFATESTWAIT');
    assert.strictEqual(a.overdueCount, 0, '验证窗口未到（末根即基准日）应 0 过期，实际=' + a.overdueCount);
    assert.strictEqual(a.pendingCount, 1, '应为 1 条待验证');
    assert.strictEqual(tf.readAll('TFATESTWAIT')[0].status, 'pending', '应标记为 pending（正常等待），而非误报过期');
    clean('TFATESTWAIT');
  });

  await asyncCase('窗口已到且数据齐备 → 正常结算（status=settled）', async () => {
    clean('TFATESTDONE');
    seed('TFATESTDONE', { symbol: 'TFATESTDONE', baseDate: '2026-09-01', horizon: tf.HORIZON, shortRaw: '上行', shortDir: '涨', probability: '高', settled: false, status: 'pending' });
    const r = await tf.settleSymbol('TFATESTDONE', MY_BARS.TFATESTDONE);
    assert.ok(r.changed >= 1, '应至少结算 1 条');
    const a = tf.computeAccuracy('TFATESTDONE');
    assert.strictEqual(a.settledCount, 1, '应已结算 1 条');
    assert.strictEqual(a.overdueCount, 0, '已结算不应计入过期');
    const rec = tf.readAll('TFATESTDONE')[0];
    assert.strictEqual(rec.status, 'settled', '应标记为 settled');
    assert.strictEqual(rec.correct, true, '09-01 后上行 → 看涨应命中');
    clean('TFATESTDONE');
  });

  await asyncCase('基准日 K 线缺失（真实异常）→ status=error → 计入 overdueCount', async () => {
    clean('TFATESTERR');
    seed('TFATESTERR', { symbol: 'TFATESTERR', baseDate: '2026-09-15', horizon: tf.HORIZON, shortDir: '涨', probability: '中', settled: false, status: 'pending' });
    await tf.settleSymbol('TFATESTERR', MY_BARS.TFATESTERR);
    const a = tf.computeAccuracy('TFATESTERR');
    assert.strictEqual(a.overdueCount, 1, '基准日缺失应为真实异常，计入过期');
    assert.strictEqual(tf.readAll('TFATESTERR')[0].status, 'error', '应标记为 error');
    assert.strictEqual(tf.readAll('TFATESTERR')[0].settleError, '基准日K线缺失');
    clean('TFATESTERR');
  });

  console.log('\n' + '='.repeat(50));
  console.log(`结果：${pass}/${n} 通过`);
  if (pass !== n) { console.error('有失败用例'); process.exit(1); }
  console.log('全部通过 ✅');
  process.exit(0);
})();
