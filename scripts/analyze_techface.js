/**
 * scripts/analyze_techface.js — techFace 25.1% 归因诊断（一次性脚本，不改任何业务逻辑）
 * 用法：node scripts/analyze_techface.js
 * 输出：六张诊断表，用于裁决「暂停 / 降权 / 重做」
 * 口径备注：回算报告里的「方向基准 41.6%」= lib/baselines.js directionBenchmark（永远预测涨，
 *           即 actualDir==='涨' 的占比）；本脚本第 8 节同时给出全部四种朴素基准供对照。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'tech-face');
const FLAT_TOL = 1.0;

function loadAll() {
  const out = { all: [], files: 0, parseErr: [] };
  if (!fs.existsSync(DIR)) { console.error('目录不存在:', DIR); process.exit(1); }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  out.files = files.length;
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!Array.isArray(arr)) continue;
      for (const r of arr) if (r && typeof r === 'object') { r._file = f; out.all.push(r); }
    } catch (e) { out.parseErr.push(f + ': ' + e.message); }
  }
  return out;
}

const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';
const pad = (s, n) => String(s).padEnd(n, ' ');

const { all, files, parseErr } = loadAll();
// [20261111b P0] 前向验证模式：node scripts/analyze_techface.js --forward
//   前向样本 = !migrated && settled（2026-11-12 起的新记录；迁移标记见 migrate_techface_dir_schema.js）。
//   判定三档（docs/logic/stock-08-technical.md 前向验证计划）：<30 条不判定；≥55% 有效；45%~55% 观察；<45% 重归因。
const FORWARD = process.argv.includes('--forward');
const settled = FORWARD
  ? all.filter(r => r.settled === true && r.migrated !== true)
  : all.filter(r => r.settled === true);
const pending = all.filter(r => !r.settled && r.status !== 'error');
const errored = all.filter(r => r.status === 'error');

console.log('\n===== 1. 样本概览 =====' + (FORWARD ? '（前向验证模式：仅 !migrated 记录）' : ''));
console.log(`文件数: ${files}  记录总数: ${all.length}`);
console.log(`已结算: ${settled.length}   待结算: ${pending.length}   error: ${errored.length}`);
if (FORWARD) {
  const migratedN = all.filter(r => r.migrated === true).length;
  const fixtureN = all.filter(r => r.migrated === true && r.migratedFrom && r.migratedFrom.reason === 'test_fixture').length;
  console.log(`迁移标记: ${migratedN} 条已排除（migrated: true，其中 TFA_TEST_ 夹具 ${fixtureN} 条）`);
  if (settled.length < 30) console.log(`⚠ 前向样本 ${settled.length} 条 < 30：样本积累中，暂不判定（不下任何结论，仅看趋势）`);
  else {
    const h = settled.filter(r => r.correct === true).length;
    const rate = h / settled.length * 100;
    const verdict = rate >= 55 ? '✅ 口径有效，转入常规监控' : rate >= 45 ? '👁 观察区：不下结论，继续积累' : '✗ 前向 <45%：触发重新归因（走归因六表 + 裁决树流程）';
    console.log(`前向命中率: ${h}/${settled.length} = ${rate.toFixed(1)}%  → ${verdict}`);
    // [20261111b P1 副指标] 防「命中率虚高但没 alpha」陷阱（本轮 techFace 根因=预测震荡 86.8% vs 实际 0.5%）。
    const predFlat = settled.filter(r => r.shortDir === '震荡').length;
    const flatPredPct = predFlat / settled.length * 100;
    const majorityDown = settled.filter(r => r.actualDir === '跌').length;
    const majorityRate = majorityDown / settled.length * 100;
    console.log(`副指标① 前向震荡预测占比: ${predFlat}/${settled.length} = ${flatPredPct.toFixed(1)}%  ${flatPredPct > 60 ? '⚠ >60%：过度保守，即使命中率≥55% 也需归因' : '（≤60% 正常）'}`);
    console.log(`副指标② 前向多数类基准（永远跌）: ${majorityRate.toFixed(1)}%  与 techFace 命中率差 ${(rate - majorityRate).toFixed(1)}pp  ${(rate - majorityRate) < 5 ? '⚠ <5pp：未跑赢多数类，不构成 alpha 证据' : '（≥5pp，有区分度）'}`);
  }
}
if (settled.length) {
  const dates = settled.map(r => r.baseDate).filter(Boolean).sort();
  const syms = new Set(settled.map(r => r.symbol));
  console.log(`时间跨度: ${dates[0]} ~ ${dates[dates.length - 1]}   涉及股票: ${syms.size} 只`);
}
if (parseErr.length) console.log('解析失败:', parseErr);

const N = settled.length;
if (N === 0) { console.log('\n无已结算记录，无法归因。'); process.exit(0); }

// ===== 2. 预测侧 / 实际侧分布 =====
const cnt = (arr, key) => arr.reduce((m, r) => { const k = r[key] || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});
const predDist = cnt(settled, 'shortDir');
const actDist = cnt(settled, 'actualDir');

console.log('\n===== 2. 预测侧 shortDir 分布 =====');
for (const k of ['涨', '跌', '震荡', '?']) if (predDist[k]) console.log(`  ${pad(k, 4)} ${pad(predDist[k], 4)} (${pct(predDist[k], N)})`);
console.log('\n===== 3. 实际侧 actualDir 分布 =====');
for (const k of ['涨', '跌', '震荡', '?']) if (actDist[k]) console.log(`  ${pad(k, 4)} ${pad(actDist[k], 4)} (${pct(actDist[k], N)})`);

// ===== 4. 混淆矩阵 =====
console.log('\n===== 4. 混淆矩阵（行=预测，列=实际）=====');
const dirs = ['涨', '跌', '震荡'];
const M = {};
for (const p of dirs) { M[p] = {}; for (const a of dirs) M[p][a] = 0; }
let unknown = 0;
for (const r of settled) {
  if (!dirs.includes(r.shortDir) || !dirs.includes(r.actualDir)) { unknown++; continue; }
  M[r.shortDir][r.actualDir]++;
}
console.log(`  ${pad('', 6)}${dirs.map(d => pad('实际' + d, 8)).join('')}`);
for (const p of dirs) {
  console.log(`  ${pad('预测' + p, 6)}${dirs.map(a => pad(M[p][a], 8)).join('')}`);
}
if (unknown) console.log(`  （无法归类 ${unknown} 条：shortDir/actualDir 缺失或非三态）`);

// ===== 5. 分类命中率（precision）=====
console.log('\n===== 5. 分类命中率（预测 X 时，实际也是 X 的比例）=====');
for (const d of dirs) {
  const denom = dirs.reduce((s, a) => s + M[d][a], 0);
  console.log(`  预测${d}: ${M[d][d]} / ${denom} = ${pct(M[d][d], denom)}`);
}
const hitAll = dirs.reduce((s, d) => s + M[d][d], 0);
console.log(`  整体命中率: ${hitAll} / ${N} = ${pct(hitAll, N)}   ← 应等于回算报告的 25.1%`);

// ===== 6. 二分类剥离（剔除震荡）=====
const binPred = M['涨']['涨'] + M['涨']['跌'] + M['跌']['涨'] + M['跌']['跌'];
const binHit = M['涨']['涨'] + M['跌']['跌'];
console.log('\n===== 6. 二分类剥离（只看预测涨/跌，不看震荡）=====');
console.log(`  涨/跌预测总数: ${binPred}，命中: ${binHit}，二分类命中率: ${pct(binHit, binPred)}`);
const actNonFlat = dirs.reduce((s, p) => s + M[p]['涨'] + M[p]['跌'], 0);
const hitNonFlat = M['涨']['涨'] + M['跌']['跌'];
console.log(`  剔除实际震荡后: ${hitNonFlat} / ${actNonFlat} = ${pct(hitNonFlat, actNonFlat)}`);

// ===== 7. 反转测试 =====
const revHit = M['涨']['跌'] + M['跌']['涨'] + M['震荡']['震荡'];
console.log('\n===== 7. 反转测试（涨↔跌对调，震荡不变）=====');
console.log(`  反转后命中率: ${revHit} / ${N} = ${pct(revHit, N)}   （若远高于原 25.1%，说明方向系统性判反）`);

// ===== 8. 基准对比 =====
console.log('\n===== 8. 基准对比 =====');
console.log(`  随机三分类: 33.3%`);
const majority = Math.max(actDist['涨'] || 0, actDist['跌'] || 0, actDist['震荡'] || 0);
console.log(`  多数类基准（永远预测实际最多的那一类）: ${pct(majority, N)}`);
console.log(`  永远涨基准: ${pct(actDist['涨'] || 0, N)}   ← 回算报告的「方向基准 41.6%」= 这一行`);
console.log(`  永远跌基准: ${pct(actDist['跌'] || 0, N)}`);
console.log(`  永远震荡基准（永远预测震荡）: ${pct(actDist['震荡'] || 0, N)}`);

// ===== 9. shortRaw 7 种词分布 =====
console.log('\n===== 9. shortRaw 原始词 → shortDir 映射分布 =====');
const rawMap = {};
for (const r of settled) {
  const k = (r.shortRaw || '?') + ' → ' + (r.shortDir || '?');
  rawMap[k] = (rawMap[k] || 0) + 1;
}
Object.entries(rawMap).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${pad(k, 20)} ${pad(v, 4)} (${pct(v, N)})`));

// ===== 10. actualChgPct 分布 =====
console.log('\n===== 10. actualChgPct 分布（看 ±1.0% 容差带是否合理）=====');
const chgs = settled.map(r => Number(r.actualChgPct)).filter(x => isFinite(x));
if (chgs.length) {
  const buckets = { '|x|<=1%': 0, '1%<|x|<=3%': 0, '3%<|x|<=5%': 0, '|x|>5%': 0 };
  for (const x of chgs) {
    const a = Math.abs(x);
    if (a <= 1) buckets['|x|<=1%']++;
    else if (a <= 3) buckets['1%<|x|<=3%']++;
    else if (a <= 5) buckets['3%<|x|<=5%']++;
    else buckets['|x|>5%']++;
  }
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${pad(k, 14)} ${pad(v, 4)} (${pct(v, chgs.length)})`);
  const sorted = [...chgs].sort((a, b) => a - b);
  const mean = chgs.reduce((s, x) => s + x, 0) / chgs.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`  均值: ${mean.toFixed(2)}%   中位数: ${median.toFixed(2)}%   min: ${sorted[0].toFixed(2)}%   max: ${sorted[sorted.length - 1].toFixed(2)}%`);
}

// ===== 11. 分 symbol 命中率（看是否个别股票拖累）=====
console.log('\n===== 11. 分股票命中率（看是否个别股票系统性错）=====');
const bySym = {};
for (const r of settled) {
  if (!r.symbol) continue;
  bySym[r.symbol] = bySym[r.symbol] || { n: 0, hit: 0 };
  bySym[r.symbol].n++;
  if (r.correct === true) bySym[r.symbol].hit++;
}
Object.entries(bySym).sort((a, b) => b[1].n - a[1].n).forEach(([s, v]) => {
  console.log(`  ${pad(s, 8)} ${pad(v.n + ' 条', 6)} 命中 ${v.hit}  ${pct(v.hit, v.n)}`);
});

// ===== 12. 「震荡偏上/偏下」单独统计（裁决树第 2 关改口径预演，只读不改）=====
console.log('\n===== 12. 改口径预演：震荡偏上→涨 / 震荡偏下→跌（只算不改盘）=====');
let biased = 0, biasedHit = 0, biasedAffected = 0;
for (const r of settled) {
  const raw = String(r.shortRaw || '');
  const hit = r.correct === true;
  if (/震荡偏上/.test(raw)) {
    biasedAffected++;
    biased++;
    if (r.actualDir === '涨' || (r.actualDir === '震荡' && Math.abs(Number(r.actualChgPct) || 0) <= FLAT_TOL)) biasedHit++;
  } else if (/震荡偏下/.test(raw)) {
    biasedAffected++;
    biased++;
    if (r.actualDir === '跌' || (r.actualDir === '震荡' && Math.abs(Number(r.actualChgPct) || 0) <= FLAT_TOL)) biasedHit++;
  } else {
    biased++;
    if (hit) biasedHit++;
  }
}
console.log(`  受影响记录（shortRaw 含震荡偏上/偏下）: ${biasedAffected} 条`);
console.log(`  改口径后模拟命中率: ${biasedHit} / ${N} = ${pct(biasedHit, N)}（原 25.1% 为对照）`);

console.log('\n===== 诊断结束 =====\n');
