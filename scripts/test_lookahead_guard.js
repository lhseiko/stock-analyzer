/**
 * scripts/test_lookahead_guard.js — P0-1 前视偏差结算侧审计 + P0-2 三基准 守卫（20261110g · 零网络）
 * --------------------------------------------------------------
 * 验收口径（docs/整改方案-20261110.md 阶段 1）：
 *  1) 构造「补录数据不可得」夹具 → 结算侧如实标 lookaheadExcluded，计入不可比样本披露，不悄悄剔除；
 *  2) 四条结算链 computeAccuracy 均按可比样本统计并输出基准字段；
 *  3) 基准值可手算复核（固定夹具断言）；
 *  4) 样本 <30 明示「无统计意义」；
 *  5) 市场状态月表（涨/跌/震荡月）生成与读取。
 * 运行：node scripts/test_lookahead_guard.js
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const lookahead = require(path.join(ROOT, 'lib', 'lookahead.js'));
const baselines = require(path.join(ROOT, 'lib', 'baselines.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ══════ §1 lookahead.auditSettlement 夹具 ══════ */
section('§1 L1 财报披露日晚于判断生成日（补录数据不可得夹具）');
{
  const rec = {
    symbol: '000test', date: '2026-11-09', generatedAt: '2026-11-09T07:00:00.000Z',
    reportEvent: { symbol: '000test', type: 'quarterly', date: '2026-11-10' }, // 判断生成后才披露
    settled: true, correct: true, settledAt: '2026-11-11T08:00:00.000Z', targetDate: '2026-11-10',
  };
  const r = lookahead.auditSettlement(rec, { windowDays: 4 });
  ok(r.excluded === true, 'L1 夹具被审计判为违规');
  ok(r.violations.some(v => v.code === 'L1_report_after_asof'), '违规码 L1_report_after_asof');
  ok(lookahead.markSettlement(rec, { windowDays: 4 }) === true, 'markSettlement 打 lookaheadExcluded=true');
  ok(rec.lookaheadViolations.length === 1 && rec.lookaheadAsOf === '2026-11-09', '打标留痕 asOf/违规清单');

  const clean = { symbol: 'x', date: '2026-11-09', generatedAt: '2026-11-09T07:00:00.000Z', reportEvent: { date: '2026-10-29' } };
  ok(lookahead.auditSettlement(clean, { windowDays: 4 }).excluded === false, '正常记录（披露日早于生成日）不违规');
}

section('§2 L2 结算时点早于目标日 / L3 内嵌时间戳越窗');
{
  const rec2 = { date: '2026-11-09', generatedAt: '2026-11-09T07:00:00.000Z', targetDate: '2026-11-10', settledAt: '2026-11-09T12:00:00.000Z' };
  const r2 = lookahead.auditSettlement(rec2, { windowDays: 4 });
  ok(r2.violations.some(v => v.code === 'L2_settled_before_target'), 'L2 夹具：目标日未收盘即「结算」被捕获');

  const rec3 = { date: '2026-11-01', generatedAt: '2026-11-01T07:00:00.000Z', factors: [{ note: 'x', dataTime: '2026-11-20' }] };
  const r3 = lookahead.auditSettlement(rec3, { windowDays: 4 });
  ok(r3.violations.some(v => v.code === 'L3_embedded_ts_beyond_window'), 'L3 夹具：内嵌 dataTime 越过 asOf+窗口被捕获');

  const rec3ok = { date: '2026-11-01', generatedAt: '2026-11-01T07:00:00.000Z', factors: [{ dataTime: '2026-11-01' }] };
  ok(lookahead.auditSettlement(rec3ok, { windowDays: 4 }).excluded === false, '窗口内的 dataTime 不误报');

  // 清除路径：曾打标、修复后审计通过 → 显式清除不静默
  const recMarked = { date: '2026-11-01', generatedAt: '2026-11-01T07:00:00.000Z', lookaheadExcluded: true, lookaheadViolations: [{ code: 'L1_report_after_asof', detail: 'x' }] };
  lookahead.markSettlement(recMarked, { windowDays: 4 });
  ok(recMarked.lookaheadExcluded === false && !!recMarked.lookaheadClearedAt, '修复后重审计 → 显式清除并留痕');
}

/* ══════ §2b 真实记录全量抽审（历史记录无越界时间戳） ══════ */
section('§2b 真实落盘判断记录抽审（不回算，仅审计）');
{
  const dir = path.join(ROOT, 'data', 'judgments');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (e) {}
  let total = 0, flagged = 0;
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const rec of (Array.isArray(arr) ? arr : [])) {
        total++;
        if (lookahead.auditSettlement(rec, { windowDays: 10 }).excluded) flagged++;
      }
    } catch (e) { /* 损坏文件跳过 */ }
  }
  console.log('  （审计范围：' + files.length + ' 个文件 / ' + total + ' 条记录）');
  ok(total > 0, '真实记录样本非空');
  ok(flagged === 0, '历史记录无 L1/L2/L3 越界（' + flagged + ' 条违规）——回算口径与旧口径一致的前提');
}

/* ══════ §3 四条链 computeAccuracy 统一口径 ══════ */
section('§3 computeAccuracy：不可比样本剔除 + 披露（四链）');
{
  const mk = (i, over) => ({
    symbol: '000test', date: '2026-11-0' + i, generatedAt: '2026-11-0' + i + 'T07:00:00.000Z',
    dir: '涨', target: 'nextday', settled: true, correct: i % 2 === 1,
    actualDir: i % 2 === 1 ? '涨' : '跌', actualChgPct: i % 2 === 1 ? 1.2 : -0.8,
    momentum: { dir: i % 2 === 1 ? '涨' : '跌', chgPct: 0.9 },
    targetDate: '2026-11-1' + i,
    reportEvent: over ? { date: '2026-11-15' } : { date: '2026-11-01' },
    settledAt: '2026-11-11T08:00:00.000Z',
  });
  const recs = [1, 2, 3, 4, 5].map(mk);
  recs[4].lookaheadExcluded = true; // 手工模拟已打标记录（markSettlement 在真实结算时自动打）

  const sjd = require(path.join(ROOT, 'lib', 'sameDayJudgment.js'));
  const a1 = sjd.computeAccuracy(recs);
  ok(a1.settledCount === 4 && a1.correct === 2 && a1.accuracy === 50, 'sameDay：可比样本 4 条 / 命中 2 / 50%（手算复核）');
  ok(a1.accuracyIncludingLookahead === 60, '旧口径（含排除项 5 条 3 中）= 60% 留档对比');
  ok(a1.lookaheadExcludedCount === 1 && a1.incomparableSamples.length === 1, '不可比样本 1 条如实披露');
  ok(a1.baselines && a1.baselines.directionBenchmark.rate === 50, '方向基准（永远涨）= 2/4 = 50%');
  ok(a1.baselines.momentumBenchmark.t === 4 && a1.baselines.momentumBenchmark.rate === 100, '动量基准 = 4/4 = 100%（夹具动量与实际全同向）');
  ok(a1.baselines.randomBenchmark.rate === 50, '随机 50% 参照线在位');
  ok(a1.baselines.sampleSufficient === false && /样本不足/.test(a1.baselines.sampleNote), '样本 <30 明示无统计意义');

  const sa = require(path.join(ROOT, 'lib', 'sentimentAccuracy.js'));
  const a2 = sa.computeAccuracy(recs.map(r => ({ ...r, baseDate: r.date })));
  ok(a2.settledCount === 4 && a2.lookaheadExcludedCount === 1 && a2.baselines.directionBenchmark.rate === 50, 'sentimentAccuracy 同口径');

  const tf = require(path.join(ROOT, 'lib', 'techFaceJudgment.js'));
  const a3 = tf.computeAccuracy('000test', recs.map(r => ({ ...r, shortDir: r.dir })));
  ok(a3.settledCount === 4 && a3.accuracyIncludingLookahead === 60 && a3.baselines.momentumBenchmark.rate === 100, 'techFace 同口径');

  const mt = require(path.join(ROOT, 'lib', 'marketTechJudgment.js'));
  const a4 = mt.computeAccuracy(recs.map(r => ({ ...r, shortSettled: true, shortDir: r.dir, shortCorrect: r.correct, shortActualDir: r.actualDir, shortActualChgPct: r.actualChgPct, confidence: '中' })));
  ok(a4.short.settledCount === 4 && a4.short.accuracyIncludingLookahead === 60 && a4.short.lookaheadExcludedCount === 1, 'marketTech stat 同口径');
  ok(a4.baselines && a4.baselines.directionBenchmark.rate === 50, 'marketTech 三基准输出');
}

/* ══════ §4 市场状态月表 ══════ */
section('§4 市场状态月表（涨/跌/震荡月）');
{
  const bars = [];
  // 1 月：连续上涨（+10%）→ 涨月；2 月：连续下跌 → 跌月；3 月：横盘 → 震荡月
  let p = 100;
  for (let d = 1; d <= 20; d++) { bars.push({ date: '2026-01-' + String(d).padStart(2, '0'), close: p }); p *= 1.005; }
  p = 110;
  for (let d = 1; d <= 20; d++) { bars.push({ date: '2026-02-' + String(d).padStart(2, '0'), close: p }); p *= 0.995; }
  for (let d = 1; d <= 20; d++) { bars.push({ date: '2026-03-' + String(d).padStart(2, '0'), close: 100 + (d % 2 ? 0.2 : -0.2) }); }
  const tmp = baselines.MONTH_STATE_FILE;
  const state = baselines.refreshMonthState(bars);
  ok(state['2026-01'].dir === '涨' && state['2026-02'].dir === '跌' && state['2026-03'].dir === '震荡', '月方向分类：涨/跌/震荡（手算复核）');
  ok(fs.existsSync(tmp), '月表落盘 data/market-month-state.json');
  const readBack = baselines.getMonthState();
  ok(readBack && readBack['2026-01'].dir === '涨', 'getMonthState 读回一致');
  const agg = baselines.aggregateBaselines([
    { date: '2026-01-05', correct: true, actualDir: '涨' },
    { date: '2026-02-05', correct: false, actualDir: '跌' },
    { date: '2026-03-05', correct: true, actualDir: '涨' },
  ]);
  ok(agg.byMonth['2026-01'].marketState === '涨' && agg.byMonth['2026-02'].marketState === '跌' && agg.byMonth['2026-03'].marketState === '震荡', '按市场状态月分组正确');
  // 清理测试月表（避免污染真实缓存）
  try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
}

console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
