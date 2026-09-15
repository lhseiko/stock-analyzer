#!/usr/bin/env node
/* 板块舆情热度周榜 · 双社区源合并回归测试（20260913h）
 * 离线纯函数测试：直接调 lib/hotTopicsWeekly/engine.js 的 computeWeekly，零网络零 Python。
 *
 * 口径（20260913h）：
 *   - 社区讨论双源：东财股吧板块吧(gubaEm) + 同花顺讨论 API(guba)，跨日跨源按 post_id 去重。
 *   - 东财**只参与 C/E**（帖子级情绪/韭菜统计）；**B 的量级项（帖数增量 + 互动量）统一取同花顺**
 *     —— 因为东财 post_click_count 是真·浏览量（十万级）、同花顺 clicks 是点赞+转发（十位级），混算会让 B 被压垮。
 *   - 任一社区源「有板块数据」即不降级（含 status='challenge' 的部分成功）。
 *
 * 锁定：
 *   §1 东财数据不参与 B（B 量级项单源化），但参与 E/C
 *   §2 只用东财帖时 E/C 仍能算出（B 走单日种子）
 *   §3 challenge（熔断部分成功）已抓到的数据不丢弃；两源皆空才降级
 *   §4 跨源/跨日按 post_id 去重
 *   §5 两源任一有数据即不降级
 *   §6 两源皆无数据 → 降级权重（A×0.8 + D×0.2），B/E 不参与
 *   §7 meta 口径透明字段（communitySrcOkDays / gubaAvailable 兼容字段）
 * 跑法：node scripts/test_hot_topics_merge.js
 */
'use strict';
const path = require('path');
const { computeWeekly } = require(path.join(__dirname, '..', 'lib', 'hotTopicsWeekly', 'engine'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra != null ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function board(code, name) { return { code, name, aliases: [], keywords: [] }; }
function cfg(over) {
  return Object.assign({
    weights: { A: 0.4, B: 0.4, D: 0.1, E: 0.1 },
    degradeWeights: { A: 0.8, D: 0.2 },
    levels: { hot: 72, warm: 60 },
    alarm: { cNorm: 90, score: 70 },
    crossCheck: { enabled: false },
    sentimentTags: {},
    topN: 10,
  }, over || {});
}
const B = 'BK0001';
function wrap(key, status, boardsMap) { const d = {}; d[key] = { status, boards: boardsMap }; return d; }
function bm(count, posts) { const o = {}; o[B] = { bar_name: '甲板块', count, posts: posts || [] }; return o; }
function day(date, data) { return { date, data }; }
function rowOf(res, code) { return (res.rows || []).find(r => r.code === (code || B)); }
function P(id, title, clicks, comments) { return { id, title, clicks: clicks || 0, comments: comments || 0, pinned: 0 }; }

// ============ §1 东财数据不参与 B（量级项单源化），但参与 E ============
console.log('\n§1 东财不参与 B 的量级项（避免真·浏览量 与 点赞+转发 混算）');
{
  const boards = [board(B, '甲板块')];
  const thsDays = [
    day('2026-09-08', wrap('guba', 'ok', bm(20, [P('t1', '看多 大涨 涨停', 3, 1)]))),
    day('2026-09-09', wrap('guba', 'ok', bm(26, [P('t2', '看空 大跌 破位', 2, 0)]))),
  ];
  // 东财数据：板块总帖数巨大、单帖浏览量十万级 —— 若混算会把 B 直接压垮
  const emD1 = wrap('gubaEm', 'ok', bm(72561, [P('e1', '资金流入 板块利好 大涨', 77314, 383)]));
  const emD2 = wrap('gubaEm', 'ok', bm(73000, [P('e2', '下周回调 科技大涨', 6387, 4)]));
  const resThsOnly = computeWeekly(boards, thsDays, cfg());
  const merged = [day('2026-09-08', Object.assign({}, thsDays[0].data, emD1)),
                  day('2026-09-09', Object.assign({}, thsDays[1].data, emD2))];
  const resBoth = computeWeekly(boards, merged, cfg());
  const bThs = rowOf(resThsOnly).B.raw, bBoth = rowOf(resBoth).B.raw;
  eq('B 在同花顺单独跑 与 双源跑 完全一致（东财不进 B）', bBoth, bThs);
  // B = THS delta (26-20=6) + clicks(3+2) + comments(1+0) = 12
  eq('B_raw = 6(同花顺增量)+5(点击)+1(评论)', bBoth, 12);
  // E：合并采样帖 4 条（t1 看多 / t2 看空 / e1 看多 / e2 看多）→ 3/4 = 75%
  eq('E 采用合并采样帖（含东财帖）', rowOf(resBoth).E, 75);
  ok('东财帖确实并入了采样（E 由 50 变为 75）', rowOf(resThsOnly).E === 50 && rowOf(resBoth).E === 75,
     { thsOnly: rowOf(resThsOnly).E, both: rowOf(resBoth).E });
}

// ============ §2 只用东财帖也能算出 E/C（B 走单日种子） ============
console.log('\n§2 仅东财帖时 E/C 仍可算（B 走单日种子）');
{
  const boards = [board(B, '甲板块')];
  const dailies = [day('2026-09-08', wrap('gubaEm', 'ok', bm(1000, [
    P('e1', '看好 大涨 涨停', 0, 0),
    P('e2', '买入机会 稳了', 0, 0),
    P('e3', '新手求教 该买什么', 0, 0),
  ])))];
  const res = computeWeekly(boards, dailies, cfg());
  const r = rowOf(res);
  eq('E（3 帖中 2 看多）', r.E, 67);
  eq('C_raw（韭菜帖 1 条）', r.C.raw, 1);
  eq('B_raw（无同花顺数据 → B 的量级项为 0）', r.B.raw, 0);
  eq('communitySrcOkDays.em', res.meta.communitySrcOkDays.em, 1);
  eq('communitySrcOkDays.ths', res.meta.communitySrcOkDays.ths, 0);
  eq('degradeMode（东财有数据 → 不降级）', res.meta.degradeMode, false);
}

// ============ §3 challenge（熔断部分成功）已抓数据不丢弃 ============
console.log('\n§3 东财 challenge（熔断）→ 已抓到的板块数据不丢弃');
{
  const boards = [board(B, '甲板块')];
  const dailies = [
    day('2026-09-08', wrap('gubaEm', 'challenge', bm(500, [P('e1', '看好 大涨 涨停', 0, 0)]))),
    day('2026-09-09', wrap('gubaEm', 'challenge', bm(560, [P('e2', '看空 大跌 破位', 0, 0)]))),
  ];
  const res = computeWeekly(boards, dailies, cfg());
  eq('communitySrcOkDays.em（challenge 计入）', res.meta.communitySrcOkDays.em, 2);
  eq('E（challenge 帖仍参与情绪统计）', rowOf(res).E, 50);
  eq('communityAvailable', res.meta.communityAvailable, true);
  eq('degradeMode', res.meta.degradeMode, false);
}

// ============ §4 跨源/跨日去重 ============
console.log('\n§4 跨源去重（同 id 只计一次）');
{
  const dup = P('dup1', '看多 机会 稳了', 100, 9);
  const boards = [board(B, '甲板块')];
  const d1 = Object.assign({}, wrap('guba', 'ok', bm(10, [dup, P('x', '看空 大跌 破位', 0, 0)])), wrap('gubaEm', 'ok', bm(500, [dup])));
  const res = computeWeekly(boards, [day('2026-09-08', d1)], cfg());
  const r = rowOf(res);
  // 唯一非垃圾帖 2 条（dup1 看多 / x 看空）→ E = 50%
  eq('E（dup 只计一次）', r.E, 50);
  // B：同花顺 clicks 只算一次 → 100 + 9 = 109；单日种子 = 合并采样帖数 2 → 111
  eq('B_raw = 2(种子) + 100(点击) + 9(评论)', r.B.raw, 111);
}

// ============ §5 两源任一有数据即不降级 ============
console.log('\n§5 两源任一有数据即不降级');
{
  const boards = [board(B, '甲板块')];
  const dailies = [
    day('2026-09-08', Object.assign({}, wrap('guba', 'error', {}), wrap('gubaEm', 'ok', bm(100, [P('e1', '看多 大涨', 0, 0)])))),
    day('2026-09-09', Object.assign({}, wrap('guba', 'error', {}), wrap('gubaEm', 'ok', bm(140, [])))),
  ];
  const res = computeWeekly(boards, dailies, cfg());
  eq('communityAvailable', res.meta.communityAvailable, true);
  eq('gubaAvailable（兼容字段）', res.meta.gubaAvailable, true);
  eq('degradeMode', res.meta.degradeMode, false);
  eq('weightsUsed = 正常权重', res.meta.weightsUsed, { A: 0.4, B: 0.4, D: 0.1, E: 0.1 });
}

// ============ §6 两源皆无数据 → 降级 ============
console.log('\n§6 两源皆无数据 → 降级权重');
{
  const boards = [board(B, '甲板块')];
  const dailies = [day('2026-09-08', Object.assign(
    {}, wrap('guba', 'challenge', {}), wrap('gubaEm', 'error', {}),
    { news: { status: 'ok', items: [{ title: '甲板块迎来利好', text: '甲板块迎来利好' }] } }
  ))];
  const res = computeWeekly(boards, dailies, cfg());
  eq('degradeMode', res.meta.degradeMode, true);
  eq('communitySrcOkDays 全 0', res.meta.communitySrcOkDays, { em: 0, ths: 0 });
  eq('weightsUsed = 降级权重', res.meta.weightsUsed, { A: 0.8, D: 0.2 });
  const r = rowOf(res);
  ok('降级下仍有榜单行（舆情 A 支撑）', !!r, res.rows);
  if (r) eq('A_raw（归属快讯 1 条）', r.A.raw, 1);
}

console.log('\n──────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
