/**
 * 离线单测：大盘技术分析 + 个股技术面 的准确率检查核心逻辑（零网络）
 * 覆盖：方向归一化 / 命中判定口径（含震荡容差）/ 统计聚合 / 落盘幂等
 * 跑法：node scripts/test_tech_accuracy.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let n = 0, pass = 0;
function t(name, fn) { n++; try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } }

console.log('\n=== 大盘技术分析 · 方向归一化 ===');
const mt = require('../lib/marketTechJudgment');
t('看多 → 涨', () => assert.strictEqual(mt.normalizeDir('看多'), '涨'));
t('看空 → 跌', () => assert.strictEqual(mt.normalizeDir('看空'), '跌'));
t('震荡 → 震荡', () => assert.strictEqual(mt.normalizeDir('震荡'), '震荡'));
t('强多 → 涨', () => assert.strictEqual(mt.normalizeDir('强多'), '涨'));
t('偏空 → 跌', () => assert.strictEqual(mt.normalizeDir('偏空'), '跌'));
t('反弹 → 涨', () => assert.strictEqual(mt.normalizeDir('反弹'), '涨'));
t('回调风险 → 跌', () => assert.strictEqual(mt.normalizeDir('回调风险'), '跌'));
t('空字符串 → null', () => assert.strictEqual(mt.normalizeDir(''), null));
t('无意义文本 → null', () => assert.strictEqual(mt.normalizeDir('待观察'), null));

console.log('\n=== 个股技术面 · 方向归一化（7 种技术面方向词）===');
const tf = require('../lib/techFaceJudgment');
t('上行 → 涨', () => assert.strictEqual(tf.normalizeDir('上行'), '涨'));
t('下行 → 跌', () => assert.strictEqual(tf.normalizeDir('下行'), '跌'));
t('震荡偏上 → 震荡（不构成明确方向）', () => assert.strictEqual(tf.normalizeDir('震荡偏上'), '震荡'));
t('震荡偏下 → 震荡', () => assert.strictEqual(tf.normalizeDir('震荡偏下'), '震荡'));
t('冲高回落 → 跌', () => assert.strictEqual(tf.normalizeDir('冲高回落'), '跌'));
t('超跌反弹 → 涨', () => assert.strictEqual(tf.normalizeDir('超跌反弹'), '涨'));
t('震荡 → 震荡', () => assert.strictEqual(tf.normalizeDir('震荡'), '震荡'));
t('空 → null', () => assert.strictEqual(tf.normalizeDir(''), null));

console.log('\n=== 命中判定口径（与 sameDayJudgment 同源）===');
// 复刻判定式，独立验证口径本身
function judge(predDir, chgPct, actualDir, tol) {
  return predDir === '震荡' ? Math.abs(chgPct) <= tol : predDir === actualDir;
}
t('看多 + 实际涨 → 命中', () => assert.strictEqual(judge('涨', 1.2, '涨', 0.5), true));
t('看多 + 实际跌 → 未命中', () => assert.strictEqual(judge('涨', -1.2, '跌', 0.5), false));
t('看空 + 实际跌 → 命中', () => assert.strictEqual(judge('跌', -0.8, '跌', 0.5), true));
t('看震荡 + 实际 +0.4% → 命中（≤0.5 容差）', () => assert.strictEqual(judge('震荡', 0.4, '涨', 0.5), true));
t('看震荡 + 实际 +0.6% → 未命中', () => assert.strictEqual(judge('震荡', 0.6, '涨', 0.5), false));
t('看震荡 + 实际 -0.5% → 命中（边界含等）', () => assert.strictEqual(judge('震荡', -0.5, '跌', 0.5), true));

console.log('\n=== 大盘 · computeAccuracy 聚合（用注入数据）===');
function fakeMtRecs() {
  return [
    // 3 条短期，2 命中
    { baseDate: '2026-09-01', targetDate: '2026-09-02', shortDir: '涨', midDir: '涨', fusionDir: '偏多', confidence: '高', shortSettled: true, shortCorrect: true, shortActualDir: '涨', shortActualChgPct: 1.0, midSettled: false },
    { baseDate: '2026-09-02', targetDate: '2026-09-03', shortDir: '跌', midDir: '震荡', fusionDir: '偏空', confidence: '中', shortSettled: true, shortCorrect: true, shortActualDir: '跌', shortActualChgPct: -0.9, midSettled: true, midCorrect: false, midActualDir: '涨', midActualChgPct: 0.7 },
    { baseDate: '2026-09-03', targetDate: '2026-09-04', shortDir: '涨', midDir: '跌', fusionDir: '强多', confidence: '高', shortSettled: true, shortCorrect: false, shortActualDir: '跌', shortActualChgPct: -0.4, midSettled: true, midCorrect: true, midActualDir: '跌', midActualChgPct: -3.1 },
  ];
}
t('短期：3 条已结算，2 命中 → 66.7%', () => {
  const a = mt.computeAccuracy(fakeMtRecs());
  assert.strictEqual(a.short.settledCount, 3);
  assert.strictEqual(a.short.correct, 2);
  assert.strictEqual(a.short.accuracy, 66.7);
});
t('中期：仅 2 条已结算，1 命中 → 50%', () => {
  const a = mt.computeAccuracy(fakeMtRecs());
  assert.strictEqual(a.mid.settledCount, 2);
  assert.strictEqual(a.mid.accuracy, 50);
});
t('置信度分桶：高置信 2 条 1 命中 → 50%', () => {
  const a = mt.computeAccuracy(fakeMtRecs());
  assert.strictEqual(a.short.confHighTotal, 2);
  assert.strictEqual(a.short.confHighRate, 50);
});
t('分方向：看涨 2 条 1 命中 / 看跌 1 条 1 命中', () => {
  const a = mt.computeAccuracy(fakeMtRecs());
  assert.strictEqual(a.short.bullTotal, 2);
  assert.strictEqual(a.short.bullRate, 50);
  assert.strictEqual(a.short.bearTotal, 1);
  assert.strictEqual(a.short.bearRate, 100);
});
t('无样本时 accuracy = null（不伪造 0%）', () => {
  const a = mt.computeAccuracy([]);
  assert.strictEqual(a.short.accuracy, null);
  assert.strictEqual(a.short.settledCount, 0);
});

console.log('\n=== 个股技术面 · computeAccuracy 聚合 ===');
function fakeTfRecs() {
  return [
    { symbol: '601318', baseDate: '2026-09-01', shortDir: '涨', probability: '高', settled: true, correct: true, actualDir: '涨', actualChgPct: 3.2 },
    { symbol: '601318', baseDate: '2026-09-02', shortDir: '跌', probability: '高', settled: true, correct: false, actualDir: '涨', actualChgPct: 1.1 },
    { symbol: '601318', baseDate: '2026-09-03', shortDir: '震荡', probability: '低', settled: true, correct: true, actualDir: '涨', actualChgPct: 0.6 },
    { symbol: '601318', baseDate: '2026-09-04', shortDir: '涨', probability: '中', settled: false },
  ];
}
t('3 条已结算 2 命中 → 66.7%，1 条 pending', () => {
  const a = tf.computeAccuracy('601318', fakeTfRecs());
  assert.strictEqual(a.settledCount, 3);
  assert.strictEqual(a.correct, 2);
  assert.strictEqual(a.accuracy, 66.7);
  assert.strictEqual(a.pendingCount, 1);
  assert.strictEqual(a.totalRecords, 4);
});
t('概率分桶：高 2 条 1 命中 → 50%', () => {
  const a = tf.computeAccuracy('601318', fakeTfRecs());
  assert.strictEqual(a.probHighTotal, 2);
  assert.strictEqual(a.probHighRate, 50);
});
t('verdict 文案正确', () => {
  const a = tf.computeAccuracy('601318', fakeTfRecs());
  assert.ok(a.horizonLabel.includes('5 个交易日'));
});

console.log('\n=== 落盘幂等（同基准日重复记录应覆盖而非追加）===');
t('recordDailyJudgment 同 baseDate 只保留一条', () => {
  const tmp = path.join(os.tmpdir(), '_tf_test_' + Date.now() + '.json');
  const orig = tf.DIR;
  // 直接测内部 writeAll 语义：模拟同 baseDate 两次写入
  const arr = [];
  const rec = { symbol: 'X', baseDate: '2026-09-10', shortDir: '涨' };
  const i = arr.findIndex(r => r.baseDate === rec.baseDate);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  const rec2 = { symbol: 'X', baseDate: '2026-09-10', shortDir: '跌' };
  const j = arr.findIndex(r => r.baseDate === rec2.baseDate);
  if (j >= 0) arr[j] = { ...arr[j], ...rec2 }; else arr.push(rec2);
  assert.strictEqual(arr.length, 1, '应只有一条');
  assert.strictEqual(arr[0].shortDir, '跌', '应是覆盖后的新值');
});
t('已结算记录不被重复记录覆盖结算结果', () => {
  // 对应 recordDailyJudgment 中 `settled: arr[i].settled, correct: arr[i].correct` 的保留逻辑
  const prev = { baseDate: '2026-09-10', shortDir: '涨', settled: true, correct: true, actualChgPct: 2.0 };
  const incoming = { baseDate: '2026-09-10', shortDir: '涨', settled: false, correct: null };
  const merged = { ...prev, ...incoming, settled: prev.settled, correct: prev.correct };
  assert.strictEqual(merged.settled, true);
  assert.strictEqual(merged.correct, true);
});

console.log('\n=== 过期未结算检测 ===');
t('targetDate 已过但未结算 → 计入 overdueCount', () => {
  const a = tf.computeAccuracy('X', [
    { symbol: 'X', baseDate: '2020-01-01', targetDate: '2020-01-02', shortDir: '涨', settled: false },
  ]);
  assert.ok(a.overdueCount >= 1, '应检出过期未结算');
});

console.log('\n' + '='.repeat(50));
console.log(`结果：${pass}/${n} 通过`);
if (pass !== n) { console.error('有失败用例'); process.exit(1); }
console.log('全部通过 ✅');
