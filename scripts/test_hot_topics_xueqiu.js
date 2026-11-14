#!/usr/bin/env node
/* 板块舆情热度周榜 · 雪球热度通道回归测试（20261114c）
 * 离线纯函数测试：直接调 lib/hotTopicsWeekly/engine.js 的 computeWeekly，零网络零 Python。
 *
 * 口径（20261114c，写死在守卫里防漂移）：
 *   - 雪球公开 A 股关注榜按板块代表性成分股归集 → xueqiu.boards[code].score（0~100）
 *   - 只参与 crossCheck 修正：共振 +3 / 单源虚热 −3，受 maxAdjust 上限约束
 *   - 不进 A/B/C/D/E 加权、不进 Min-Max 归一化池 → 五项指标与归一化结果逐位不变
 *   - 雪球热门话题帖需登录，本项目不抓取（静态断言禁止接入需登录接口）
 *
 * 锁定：
 *   §1 无雪球数据时输出与旧版等价（xq=null, xqAvailable=false）
 *   §2 雪球共振 +3 / 关闭开关后分数还原
 *   §3 雪球单源虚热 −3 且 soloHot=true
 *   §4 五项指标 A/B/C/D/E 逐位不变（隔离性，最关键）
 *   §5 修正受 maxAdjust 上限约束、crossCheck 总开关仍生效
 *   §6 下游协同进化：采集器/默认配置/来源状态/前端/脚注/版本戳全部落地
 *   §7 合规：只消费公开筛选接口，不接需登录的热帖/话题接口
 * 跑法：node scripts/test_hot_topics_xueqiu.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { computeWeekly } = require(path.join(ROOT, 'lib', 'hotTopicsWeekly', 'engine'));
const { DEFAULTS } = require(path.join(ROOT, 'lib', 'hotTopicsWeekly', 'config'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra != null ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function board(code, name) { return { code, name, aliases: [], keywords: [] }; }
function cfg(over) {
  const c = JSON.parse(JSON.stringify(DEFAULTS));
  // 关闭与雪球无关的其它交叉验证项，让断言只观察 xqConfirm 的净效果
  c.crossCheck = Object.assign({}, c.crossCheck, {
    fundConfirm: { scoreMin: 999 }, fundDiverge: { scoreMin: 999 },
    chaseOverheat: { scoreMin: 999 }, resonance: { aMin: 999, bMin: 999, gapMin: 999 },
  }, (over && over.crossCheck) || {});
  if (over && over.crossCheck === null) c.crossCheck = { enabled: false };
  return c;
}
const B = 'BK0001';
function P(id, title, clicks, comments) { return { id, title, clicks: clicks || 0, comments: comments || 0, pinned: 0 }; }
function xqBoards(score) {
  return {
    status: 'ok', rows: 1000, count: 1,
    boards: { [B]: { score, topStock: '甲股份', topRank: 8, hits: 2, stocks: [] } },
    note: '雪球公开关注榜（前 1000 名）按板块代表性成分股归集',
  };
}
function daily(xq) {
  const data = {
    news: { status: 'ok', items: [{ title: '甲板块迎来利好 大涨', text: '甲板块迎来利好 大涨' }] },
    guba: { status: 'ok', boards: { [B]: { bar_name: '甲板块', count: 20, posts: [P('t1', '甲板块 看多 大涨 涨停', 3, 1)] } } },
    gubaEm: { status: 'ok', boards: {} },
    market: { status: 'ok', rows: [] },
  };
  if (xq) data.xueqiu = xq;
  return { date: '2026-11-14', data };
}
const BOARDS = [board(B, '甲板块')];
function run(xq, over) { return computeWeekly(BOARDS, [daily(xq)], cfg(over)); }
function rowOf(res) { return (res.rows || []).find(r => r.code === B); }

// ============ §1 无雪球数据：与旧版等价 ============
console.log('\n§1 无雪球数据时输出与旧版等价');
{
  const res = run(null);
  const r = rowOf(res);
  ok('榜单仍可算出', !!r, res.rows);
  eq('基准综合分（单板块：An=Bn=50, D=E=100 → 60）', r.score, 60);
  eq('xq 字段为 null', r.xq, null);
  eq('meta.xqAvailable = false', res.meta.xqAvailable, false);
  eq('meta.xqBoards = 0', res.meta.xqBoards, 0);
  eq('meta.xqRows = 0', res.meta.xqRows, 0);
  eq('degradeMode 未被引擎误判', res.meta.degradeMode, false);
}

// ============ §2 共振 +3 与开关 ============
console.log('\n§2 雪球热度共振 +3；关闭开关后分数还原');
{
  const res = run(xqBoards(90));
  const r = rowOf(res);
  eq('雪球分 90 ≥ xqMin 70 且 An=50 ≥ aMin 30 → 共振 +3', r.score, 63);
  eq('meta.xqAvailable = true', res.meta.xqAvailable, true);
  eq('meta.xqBoards = 1', res.meta.xqBoards, 1);
  eq('meta.xqRows = 1000', res.meta.xqRows, 1000);
  eq('行内回传雪球分', r.xq.score, 90);
  eq('行内回传最热成分股（板块热度可落到个股）', r.xq.topStock, '甲股份');
  eq('行内回传榜内排名', r.xq.topRank, 8);
  eq('共振不算单源虚热', r.xq.soloHot, false);

  const off = run(xqBoards(90), { crossCheck: { xqConfirm: { enabled: false } } });
  eq('xqConfirm.enabled=false → 分数还原为 60', rowOf(off).score, 60);
  ok('关闭后 xq 数据仍回传（只是不参与计分）', rowOf(off).xq != null);

  const low = run(xqBoards(40));
  eq('雪球分 40 < xqMin 70 → 不加分', rowOf(low).score, 60);
}

// ============ §3 单源虚热 −3 ============
console.log('\n§3 雪球单源热：默认只标记不扣分，扣分能力留作可配开关');
{
  const mark = { crossCheck: { xqConfirm: { xqMin: 70, aMin: 999, adj: 0, soloMaxA: 60, gapAdj: 0 } } };
  const res = run(xqBoards(90), mark);
  const r = rowOf(res);
  eq('An=50 ≤ soloMaxA=60 → 标记 soloHot', r.xq.soloHot, true);
  eq('gapAdj=0 默认不扣分（分数仍 60）', r.score, 60);
  const punish = { crossCheck: { xqConfirm: { xqMin: 70, aMin: 999, adj: 0, soloMaxA: 60, gapAdj: -3 } } };
  eq('把 gapAdj 设为 -3 才真的扣 3 分', rowOf(run(xqBoards(90), punish)).score, 57);
  const noGap = { crossCheck: { xqConfirm: { xqMin: 70, aMin: 30, adj: 0, soloMaxA: 10, gapAdj: 0 } } };
  eq('An=50 > soloMaxA=10 → 不标记也不加分', rowOf(run(xqBoards(90), noGap)).score, 60);
  eq('soloHot 保持 false', rowOf(run(xqBoards(90), noGap)).xq.soloHot, false);
  eq('默认配置的 gapAdj 必须为 0（防大范围单向压制回归）', DEFAULTS.crossCheck.xqConfirm.gapAdj, 0);
}

// ============ §4 五项指标逐位不变（隔离性，最关键） ============
console.log('\n§4 A/B/C/D/E 与归一化基数逐位不变');
{
  const a = rowOf(run(null)), b = rowOf(run(xqBoards(90)));
  ['A', 'B', 'C', 'D', 'E'].forEach(k => eq(`${k} 指标不变`, b[k], a[k]));
  eq('newsItemsTotal 不变（雪球未抬高 A 的条数基数）',
    run(xqBoards(90)).meta.newsItemsTotal, run(null).meta.newsItemsTotal);
  eq('weightsUsed 不变', run(xqBoards(90)).meta.weightsUsed, run(null).meta.weightsUsed);
  eq('communitySrcOkDays 不变',
    run(xqBoards(90)).meta.communitySrcOkDays, run(null).meta.communitySrcOkDays);
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'hotTopicsWeekly', 'engine.js'), 'utf8');
  ok('引擎中雪球数据只出现在 crossCheck 分支（未进加权公式）',
    /const xqc = cc\.xqConfirm \|\| \{\}/.test(src) &&
    !/base \+=.*xq/i.test(src));
  ok('共振与单源热互斥（不叠加加减、不重复触发）',
    /else if \(An != null && An >= \(xqc\.aMin/.test(src) && /xqSoloHot = true/.test(src));
}

// ============ §5 上限与总开关 ============
console.log('\n§5 修正受 maxAdjust 约束，crossCheck 总开关仍生效');
{
  const res = run(xqBoards(100), { crossCheck: { maxAdjust: 1, xqConfirm: { adj: 9, xqMin: 0, aMin: 0, soloMaxA: -1, gapAdj: 0 } } });
  eq('adj=9 但 maxAdjust=1 → 净修正只 +1', rowOf(res).score, 61);
  const off = run(xqBoards(100), { crossCheck: null });
  eq('crossCheck.enabled=false → 分数还原 60', rowOf(off).score, 60);
  eq('总开关关闭时 soloHot 为 false', rowOf(off).xq.soloHot, false);
}

// ============ §6 下游协同进化（输出格式变化的相邻模块清单） ============
console.log('\n§6 下游相邻模块一次性同步');
{
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const py = read('scripts/hot_topics_collect.py');
  ok('采集器含雪球公开榜通道 collect_xueqiu', /def collect_xueqiu\(/.test(py));
  ok('采集器含板块成分股归集 _xq_symbol', /def _xq_symbol\(/.test(py));
  ok('采集器含东财当日熔断记忆', /def em_blocked_today\(/.test(py) && /def mark_em_blocked\(/.test(py));
  ok('采集器 summary 透出 xq / xqBoards / xqRows',
    /'xq': result\['xueqiu'\]\.get\('status'\)/.test(py) &&
    /'xqBoards': result\['xueqiu'\]\.get\('count', 0\)/.test(py) &&
    /'xqRows': result\['xueqiu'\]\.get\('rows', 0\)/.test(py));
  ok('行情通道双轮重试（两 host × 2）与 20s 超时',
    /push2\.eastmoney\.com'\) \* 2/.test(py) && /timeout=20/.test(py));
  ok('采集器对雪球分做板块间 Min-Max 归一化（防大票普遍高分、避免误判）',
    /Min-Max 归一化/.test(py) && /item\['score'\] = 50\.0 if hi == lo else/.test(py));

  const cfgJs = read('lib/hotTopicsWeekly/config.js');
  ok('默认配置含 xueqiu 节与 xqConfirm 阈值', /xueqiu: \{ enabled: true/.test(cfgJs) && /xqConfirm:/.test(cfgJs));
  ok('东财连续失败阈值收紧为 3 且新增 emDailyBlock',
    /emFailStreakMax: 3, emDailyBlock: true/.test(cfgJs));
  const cfgJson = JSON.parse(read('data/hotTopics/config.json'));
  eq('用户可配 config.json 含 xueqiu 开关', cfgJson.xueqiu.enabled, true);
  eq('用户可配 config.json emFailStreakMax=3', cfgJson.community.emFailStreakMax, 3);
  ok('用户可配 config.json 含 crossCheck.xqConfirm', !!cfgJson.crossCheck.xqConfirm);

  const idx = read('lib/hotTopicsWeekly/index.js');
  ok('后端 sources 新增 xq / xqBoards / xqRows / gubaEmBlocked',
    /xq: summary\.xq/.test(idx) && /xqBoards:/.test(idx) && /xqRows:/.test(idx) && /gubaEmBlocked:/.test(idx));
  ok('脚注含雪球合规声明（非权威行情、不作数字类结论）',
    /非权威行情，不作数字类结论或买卖依据/.test(idx));
  ok('脚注含东财熔断 / 雪球不可用 / 行情不可用的诚实标注',
    /gubaEmBlocked/.test(idx) && /sources\.xq && sources\.xq !== 'ok'/.test(idx) && /sources\.market && sources\.market !== 'ok'/.test(idx));

  const ui = read('public/js/homeHotTopics.js');
  ok('前端 srcChips 显示雪球热度状态', /雪球热度: \$\{escapeHtml\(src\.xq/.test(ui));
  ok('前端行内显示雪球分与最热成分股', /r\.xq\.topStock/.test(ui) && /r\.xq\.soloHot/.test(ui));

  const server = read('server.js');
  ok('APP_VERSION 升至 20261114c', /const APP_VERSION = '20261114c';/.test(server));
  const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
  const stale = htmls.filter(f => /\?v=20261114b/.test(read('public/' + f)));
  eq('8 个 HTML 无 20261114b 旧戳残留', stale, []);
  const hits = htmls.reduce((n, f) => n + (read('public/' + f).match(/\?v=20261114c/g) || []).length, 0);
  eq('全站 ?v=20261114c 缓存戳总数', hits, 57);
}

// ============ §7 合规边界 ============
console.log('\n§7 合规：只消费公开榜，不接需登录接口');
{
  const py = fs.readFileSync(path.join(ROOT, 'scripts', 'hot_topics_collect.py'), 'utf8');
  ok('唯一雪球端点是公开筛选接口 www.xueqiu.com/service/v5/stock/screener/screen',
    /XQ_SCREEN_URL = 'https:\/\/www\.xueqiu\.com\/service\/v5\/stock\/screener\/screen'/.test(py));
  ok('未接入需登录的热帖 / 话题接口',
    !/statuses\/hots\.json/.test(py.replace(/#.*$/gm, '')) &&
    !/hots\/topic\/list\.json/.test(py.replace(/#.*$/gm, '')) &&
    !/query\/v1\/search\/status/.test(py.replace(/#.*$/gm, '')));
  ok('采集器注释明确「社区热度代理、非权威行情」边界',
    /只消费「公开个股关注榜数值」/.test(py) && /非权威行情/.test(py));
  const news = fs.readFileSync(path.join(ROOT, 'lib', 'newsSearch.js'), 'utf8');
  ok('今日财经热点四路互备接线存在（卡 #002 联动）',
    /fetchSinaFlashNews/.test(news) && /fetchClsTelegraph/.test(news) && /fetchWscnLives/.test(news));
}

console.log('\n──────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
