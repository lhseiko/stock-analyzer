#!/usr/bin/env node
/**
 * test_sentiment_hit_direction.js — 任务卡 #021 方向符号命中守卫
 * ================================================================
 * 用户裁决：判跌遇负涨跌幅命中、判涨遇正涨跌幅命中；即便被标为「震荡」也按符号判。
 * 覆盖：共享纯函数 / 界面准确率台账 / 模块内部诊断与因子学习 / 历史重算幂等 / 接线。
 * 离线、零网络、不写生产数据（两个目录均用环境变量隔离到临时目录）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---- 目录隔离：必须在 require 前设置（模块加载时求值）----
const TMP_ACC = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-hit-acc-'));
const TMP_EMO = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-hit-emo-'));
process.env.SA_SENTIMENT_ACCURACY_DIR = TMP_ACC;
process.env.SA_MARKET_EMOTION_DIR = TMP_EMO;

const dh = require('../lib/directionHit');
const sa = require('../lib/sentimentAccuracy');
const model = require('../lib/marketEmotionModel');
const TAX = require('../lib/taxonomy');

console.log('\n=== 1) 共享纯函数：方向符号命中 ===');
t('signDir：正→up / 负→down / 零→flat / 非法→null', () => {
  assert.strictEqual(dh.signDir(0.06), 'up');
  assert.strictEqual(dh.signDir(-0.39), 'down');
  assert.strictEqual(dh.signDir(0), 'flat');
  assert.strictEqual(dh.signDir('abc'), null);
  assert.strictEqual(dh.signDir(null), null);
});
t('hitBySign：判跌+负 / 判涨+正 命中（含小幅）', () => {
  assert.strictEqual(dh.hitBySign('down', -0.2), true);
  assert.strictEqual(dh.hitBySign('up', 0.2), true);
  assert.strictEqual(dh.hitBySign('down', -3.5), true);
  assert.strictEqual(dh.hitBySign('up', 3.5), true);
});
t('hitBySign：反向 / 恰好 0 / 无预测 / 不可得 均不命中', () => {
  assert.strictEqual(dh.hitBySign('down', 0.2), false);
  assert.strictEqual(dh.hitBySign('up', -0.2), false);
  assert.strictEqual(dh.hitBySign('down', 0), false);
  assert.strictEqual(dh.hitBySign(null, -0.2), false);
  assert.strictEqual(dh.hitBySign('up', null), false);
});
t('中文/模型方向归一化', () => {
  assert.strictEqual(dh.cnDirToSign('跌'), 'down');
  assert.strictEqual(dh.cnDirToSign('涨'), 'up');
  assert.strictEqual(dh.cnDirToSign('震荡'), null);
  assert.strictEqual(dh.modelDirToSign('看跌'), 'down');
  assert.strictEqual(dh.modelDirToSign('中性'), null);
});
t('震荡标签阈值未改（taxonomy 单源 0.5）', () => {
  assert.strictEqual(TAX.FLAT_TOLERANCE_INDEX, 0.5);
  assert.strictEqual(sa.FLAT_TOLERANCE, 0.5);
});

console.log('\n=== 2) 界面准确率台账（lib/sentimentAccuracy.js）===');
function ledRec(dir, pct, extra) {
  return Object.assign({
    baseDate: '2028-01-03', targetDate: '2028-01-04', dir, level: '预警',
    settled: true, correct: false, actualDir: '震荡', actualChgPct: pct,
  }, extra || {});
}
t('withDirectionHit：判跌 −0.2% → 命中，判涨 +0.2% → 命中', () => {
  assert.strictEqual(sa.withDirectionHit(ledRec('跌', -0.2)).correct, true);
  assert.strictEqual(sa.withDirectionHit(ledRec('涨', 0.2)).correct, true);
});
t('withDirectionHit：小幅反向 / 恰 0 → 未命中', () => {
  assert.strictEqual(sa.withDirectionHit(ledRec('跌', 0.2)).correct, false);
  assert.strictEqual(sa.withDirectionHit(ledRec('涨', -0.2)).correct, false);
  assert.strictEqual(sa.withDirectionHit(ledRec('跌', 0)).correct, false);
});
t('withDirectionHit：展示标签仍为「震荡」，原始涨跌幅不被改写', () => {
  const out = sa.withDirectionHit(ledRec('跌', -0.2));
  assert.strictEqual(out.actualDir, '震荡');
  assert.strictEqual(out.actualChgPct, -0.2);
});
t('withDirectionHit：原判定值留痕 correctBefore，且幂等', () => {
  const once = sa.withDirectionHit(ledRec('跌', -0.2));
  assert.strictEqual(once.correctBefore, false);
  assert.strictEqual(once.hitRule, sa.HIT_RULE);
  assert.strictEqual(sa.withDirectionHit(once), once, '已打标记的记录原样返回');
});
t('withDirectionHit：无已存涨跌幅 / 未结算 / 无方向 → 原样返回', () => {
  const noPct = ledRec('跌', undefined);
  assert.strictEqual(sa.withDirectionHit(noPct), noPct);
  const pending = Object.assign(ledRec('跌', -0.2), { settled: false });
  assert.strictEqual(sa.withDirectionHit(pending), pending);
  const noDir = ledRec('震荡', -0.2);
  assert.strictEqual(sa.withDirectionHit(noDir), noDir);
});
t('computeAccuracy：非破坏性归一化，小幅同向计入命中与 smallFlatHitCount', () => {
  const recs = [ledRec('跌', -0.2), ledRec('涨', 0.2), ledRec('跌', 0.2)];
  const a = sa.computeAccuracy(recs);
  assert.strictEqual(a.settledCount, 3);
  assert.strictEqual(a.correct, 2);
  assert.strictEqual(a.accuracy, 66.7);
  assert.strictEqual(a.smallFlatHitCount, 2);
  assert.strictEqual(a.flatMissCount, 1);
  assert.strictEqual(recs[0].correct, false, '传入数组未被改写');
});
t('recomputeHistoricalHits：落盘重算 + 原值留痕 + 二次零改写', () => {
  const file = path.join(TMP_ACC, '2028-01-03.json');
  fs.writeFileSync(file, JSON.stringify(ledRec('跌', -0.2), null, 2));
  const first = sa.recomputeHistoricalHits();
  assert.strictEqual(first.recomputed, 1);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.correct, true);
  assert.strictEqual(after.correctBefore, false);
  const second = sa.recomputeHistoricalHits();
  assert.strictEqual(second.recomputed, 0, '幂等：第二次不再写盘');
  assert.strictEqual(second.skipped, 1);
});

console.log('\n=== 3) 模块内部诊断与因子学习（lib/marketEmotionModel.js）===');
const BARS = [
  { date: '2028-01-03', close: 3000 },
  { date: '2028-01-04', close: 2994 },  // -0.20% → 标签 flat（基准 01-03）
  { date: '2028-01-05', close: 3000 },  // +0.20% → 标签 flat（基准 01-04）
  { date: '2028-01-06', close: 3030 },  // +1.00% → 标签 up（基准 01-05）
  { date: '2028-01-07', close: 2970 },  // -1.00% → 标签 down（基准 01-06）
  { date: '2028-01-10', close: 3000 },
  { date: '2028-01-11', close: 3000 },
  { date: '2028-01-12', close: 3000 },
];
function mdlRec(tendency, over) {
  return Object.assign({ date: '2028-01-03', baselineDate: '2028-01-03', tendency }, over || {});
}
function settleOne(rec) {
  return model.settleRecords([rec], [], BARS);
}
t('settleRecords：判跌 + 次日 −0.2% → correctT1=true，标签仍 flat', () => {
  const out = settleOne(mdlRec('看跌'));
  const r = out.records[0];
  assert.strictEqual(r.resultT1.chgPct, -0.2);
  assert.strictEqual(r.resultT1.dir, 'flat');
  assert.strictEqual(r.resultT1.hitDir, 'down');
  assert.strictEqual(r.correctT1, true);
  assert.strictEqual(r.hitRule, model.HIT_RULE);
});
t('settleRecords：判涨 + 次日 +0.2% → 命中；反向小幅 → 未命中', () => {
  const up = settleOne(mdlRec('看涨', { date: '2028-01-04', baselineDate: '2028-01-04' })).records[0];
  assert.strictEqual(up.resultT1.chgPct, 0.2);
  assert.strictEqual(up.correctT1, true);
  const wrong = settleOne(mdlRec('看涨')).records[0];
  assert.strictEqual(wrong.resultT1.hitDir, 'down');
  assert.strictEqual(wrong.correctT1, false);
});
t('settleRecords：中性倾向仍按「是否震荡」判定（口径不变）', () => {
  const flat = settleOne(mdlRec('中性')).records[0];
  assert.strictEqual(flat.correctT1, true, '小幅 ±0.5% 内 → 中性命中');
  const clear = settleOne(mdlRec('中性', { date: '2028-01-05', baselineDate: '2028-01-05' })).records[0];
  assert.strictEqual(clear.resultT1.dir, 'up');
  assert.strictEqual(clear.correctT1, false, '明确方向 → 中性未命中');
});
t('settledToday 透出 hitDir / chgPct，供因子学习按符号记样本', () => {
  const out = settleOne(mdlRec('看跌', {
    factorDirs: { indexMomentum: -1, margin: 1, breadthExtreme: 0 },
  }));
  assert.strictEqual(out.settledToday.length, 1);
  assert.strictEqual(out.settledToday[0].hitDir, 'down');
  assert.strictEqual(out.settledToday[0].chgPct, -0.2);
  const st = { factorAcc: {} };
  model.applyFactorAccuracy(st, out.settledToday);
  assert.strictEqual(st.factorAcc.indexMomentum.samples[0], true);
  assert.strictEqual(st.factorAcc.margin.samples[0], false);
  assert.ok(!st.factorAcc.breadthExtreme);
});
t('applyFactorAccuracy：实际涨跌幅恰为 0 → 跳过，不制造方向样本', () => {
  const st = { factorAcc: {} };
  model.applyFactorAccuracy(st, [{ record: { factorDirs: { indexMomentum: -1 } }, actualDir: 'flat', chgPct: 0 }]);
  assert.strictEqual(Object.keys(st.factorAcc).length, 0);
});
t('历史重算：按已存 chgPct 改判 + correctT1Before 留痕 + 幂等', () => {
  const legacy = mdlRec('看跌', {
    settledT1: true,
    resultT1: { targetDate: '2028-01-04', chgPct: -0.2, dir: 'flat' },
    correctT1: false,
  });
  const first = model.recomputeHistoricalHits([legacy]);
  assert.strictEqual(first.changed, 1);
  assert.strictEqual(first.records[0].correctT1, true);
  assert.strictEqual(first.records[0].correctT1Before, false);
  assert.strictEqual(first.records[0].resultT1.hitDir, 'down');
  const second = model.recomputeHistoricalHits(first.records);
  assert.strictEqual(second.changed, 0, '二次重算零变化');
});
t('computeAccuracy：非破坏性归一化，历史小幅同向立即计入', () => {
  const legacy = [
    mdlRec('看跌', { settledT1: true, resultT1: { chgPct: -0.2, dir: 'flat' }, correctT1: false }),
    mdlRec('看涨', { settledT1: true, resultT1: { chgPct: 0.2, dir: 'flat' }, correctT1: false }),
    mdlRec('看跌', { settledT1: true, resultT1: { chgPct: 0.2, dir: 'flat' }, correctT1: false }),
  ];
  const a = model.computeAccuracy(legacy);
  assert.strictEqual(a.settledCount, 3);
  assert.strictEqual(a.accuracy, 66.7);
  assert.strictEqual(legacy[0].correctT1, false, '传入数组未被改写');
});

console.log('\n=== 4) 接线与隔离 ===');
t('模型不再「flat 整日跳过」', () => {
  assert.ok(!src('lib/marketEmotionModel.js').includes("if (actualDir === 'flat') continue;"));
  assert.ok(src('lib/marketEmotionModel.js').includes("const FLAT_TOL = FLAT_TOLERANCE_INDEX"));
});
t('重放脚本按已存涨跌幅计入小幅日', () => {
  const s = src('scripts/rebuild_emotion_factor_acc.js');
  assert.ok(s.includes("const hitDir = dir === 'flat' ? signDir(chgPct) : dir"));
  assert.ok(s.includes('smallMoveReplayed'));
});
t('前端拆分展示三态', () => {
  const a = src('public/js/app.js');
  assert.ok(a.includes('smallFlatHitCount') && a.includes('小幅同向命中') && a.includes('小幅反向'));
});
t('未改因子结构与基准权重', () => {
  assert.strictEqual(Object.keys(model.BASE_WEIGHTS).length, 10);
  assert.strictEqual(Object.values(model.BASE_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

try { fs.rmSync(TMP_ACC, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
try { fs.rmSync(TMP_EMO, { recursive: true, force: true }); } catch (_) { /* best-effort */ }

console.log('\n' + '='.repeat(56));
console.log(`===== 方向命中守卫：${pass} 通过 / ${fail} 失败 =====`);
if (fail) process.exit(1);
