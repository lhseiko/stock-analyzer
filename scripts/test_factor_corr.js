#!/usr/bin/env node
/**
 * scripts/test_factor_corr.js — P2-3 因子相关性：统计原语与聚类单元测试（零网络）
 * @test-scope: local
 * 守护点：
 *   - spearman 平均秩处理并列（三值并列 / 两值并列）结果确定可复现；
 *   - pearson 边界（完全正/负相关 = ±1）；
 *   - cluster 连通分量能识别「链式大簇」（A-B、B-C 高相关但 A-C 低 → 仍成簇）。
 */
'use strict';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
function approx(a, b, eps = 1e-3) { return Math.abs(a - b) < eps; }

const { spearman, pearson, rankAverageTies, cluster } = require('./analyze_factor_corr');

console.log('[test_factor_corr] Spearman 平均秩并列');

// 三值并列：X=[1,2,2,2,5] → 秩 [1,3,3,3,5]；Y 单调 → 秩 [1,2,3,4,5]
// 手算 Pearson([1,3,3,3,5],[1,2,3,4,5]) = 8/√(8·10) ≈ 0.8944
{
  const x = [1, 2, 2, 2, 5], y = [10, 20, 30, 40, 50];
  const r = spearman(x, y);
  ok(approx(r, 0.8944), `三值并列 spearman ≈ 0.8944（实际 ${r == null ? 'null' : r.toFixed(4)}）`);
  // 等价定义：spearman(X,Y) == pearson(rank(X), rank(Y))
  const rx = rankAverageTies(x), ry = rankAverageTies(y);
  ok(approx(r, pearson(rx, ry)), 'spearman == pearson(rank(X), rank(Y))（平均秩口径）');
  ok(JSON.stringify(rankAverageTies(x)) === JSON.stringify([1, 3, 3, 3, 5]), 'rankAverageTies 三并列取平均秩 [1,3,3,3,5]');
}

// 两值并列：X=[1,1,3,4,5] → 秩 [1.5,1.5,3,4,5]
// 手算 Pearson([1.5,1.5,3,4,5],[1,2,3,4,5]) = 9.5/√(9.5·10) ≈ 0.9747
{
  const x = [1, 1, 3, 4, 5], y = [2, 3, 4, 5, 6];
  const r = spearman(x, y);
  ok(approx(r, 0.9747), `两值并列 spearman ≈ 0.9747（实际 ${r == null ? 'null' : r.toFixed(4)}）`);
  ok(JSON.stringify(rankAverageTies(x)) === JSON.stringify([1.5, 1.5, 3, 4, 5]), 'rankAverageTies 两并列取平均秩 [1.5,1.5,3,4,5]');
}

console.log('[test_factor_corr] Pearson 边界');
ok(approx(pearson([1, 2, 3], [1, 2, 3]), 1), 'pearson 完全正相关 = 1');
ok(approx(pearson([1, 2, 3], [3, 2, 1]), -1), 'pearson 完全负相关 = -1');
ok(pearson([1], [1]) === null, '样本 <3 返回 null（不捏造）');

console.log('[test_factor_corr] 聚类：链式大簇识别');
// 3 因子：A-B=0.9, B-C=0.1, A-C=0.1 → 簇 {A,B}（非链式）
{
  const keys = ['A', 'B', 'C'];
  const M = [[1, 0.9, 0.1], [0.9, 1, 0.1], [0.1, 0.1, 1]];
  const cl = cluster(keys, M, 0.7);
  ok(cl.length === 1 && cl[0].members.length === 2 && cl[0].members.includes('A') && cl[0].members.includes('B'), 'A-B 高相关成簇，C 独立');
}
// 链式：A-B=0.9, B-C=0.9, A-C=0.1 → 簇 {A,B,C}（链式大簇）
{
  const keys = ['A', 'B', 'C'];
  const M = [[1, 0.9, 0.1], [0.9, 1, 0.9], [0.1, 0.9, 1]];
  const cl = cluster(keys, M, 0.7);
  ok(cl.length === 1 && cl[0].members.length === 3, '链式 A-B-C 高相关仍成单簇（链式大簇）');
  ok(approx(cl[0].minAbsW, 0.1), '簇内最小 |corr| = 0.1（最弱边暴露，不被平均掩盖）');
}

console.log(`\n===== test_factor_corr：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
