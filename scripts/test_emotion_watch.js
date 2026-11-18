#!/usr/bin/env node
/**
 * test_emotion_watch.js — 任务卡 #011「观察指标层（阶段一）」专项守卫
 * ============================================================================
 * 覆盖：
 *   1) 纯函数确定性：波动率 / 边际 / 板块延续度 / 事件过滤
 *   2) 主入口隔离性：4 项固定顺序、3 ready / 1 unavailable、scope、日期口径
 *   3) 零数值变化：观察层不进权重/总分/自学习，模型层完全不知道观察层存在
 *   4) 原则 A/C：行情数据日取最近交易日基准日，不用运行日冒充；事件时间单独标注
 *   5) 下游协同进化：server / app / logicModel / 逻辑文档 / 版本戳强绑定
 *   6) 新旧进程兼容：watchIndicators 缺失时前端整块静默不渲染
 *
 * 离线、零网络、零生产数据依赖：板块与事件文件用临时夹具目录注入。
 *
 * @test-scope: local — 本脚本纯本地夹具 + 纯函数，零网络、零本地端口。
 * 必须声明：下方「零网络请求」断言里含 'fetch(' / 'axios' 字面量，run_all_tests.js
 * 的 needsNetwork() 正则会误判成需网络并让 quick 模式静默跳过（假绿，见框架 20261111d 注释）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-emo-watch-'));
process.env.SA_MARKET_EMOTION_DIR = TMP; // 防任何间接写入生产台账
// [#012] 观察层现在会读涨跌停池落库；守卫注入空源，既不联网也不碰生产 data/stock_analyzer.db。
const NO_POOL = { getProfitEffectSeries: () => [] };

const w = require('../lib/marketEmotionWatch');
const model = require('../lib/marketEmotionModel');
const { previousTradingDay } = require('../lib/cnTradingCalendar');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const WATCH = src('lib/marketEmotionWatch.js');
const MODEL = src('lib/marketEmotionModel.js');
const SERVER = src('server.js');
const APP = src('public/js/app.js');
const LOGIC = src('public/js/logicModel.js');
const DOC = src('docs/logic/home-01-market-emotion.md');
const BASE_GUARD = src('scripts/test_market_emotion.js');

// ---------- 临时夹具：板块历史 + 事件清单 ----------
const sectorKeys = ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
const LEADERS = ['A', 'B', 'C', 'D', 'E'];
const hist = {};
sectorKeys.forEach(k => {
  hist[k] = {
    up: LEADERS.map((name, i) => ({ name, changePct: Number((5 - i).toFixed(2)), swLevel: '二级' })),
    down: [],
    recordedAt: '2026-11-15T12:00:00.000Z', // 写入时间，不得被当成数据日
  };
});
hist['2026-11-14'] = { up: [], down: [], recordedAt: '2026-11-15T12:00:00.000Z' }; // 周六
hist['2026-11-16'] = { up: [], down: [], recordedAt: '2026-11-15T12:00:00.000Z' }; // 晚于基准日
fs.writeFileSync(path.join(TMP, 'sector_rank_history.json'), JSON.stringify(hist));
fs.mkdirSync(path.join(TMP, 'events'));
fs.writeFileSync(path.join(TMP, 'events', 'active.json'), JSON.stringify([
  { id: 'e1', title: '样本事件', sector: '半导体', status: 'active', paused: false, marketNeutralized: false, createdAt: '2026-11-15T05:21:26.939Z' },
  { id: 'e2', title: '已暂停', status: 'active', paused: true, marketNeutralized: false, createdAt: '2026-10-01T00:00:00.000Z' },
  { id: 'e3', title: '已中性化', status: 'active', paused: false, marketNeutralized: true, createdAt: '2026-10-02T00:00:00.000Z' },
]));

// ---------- 临时夹具：40 根真实交易日上证日线 ----------
const bars = [];
let d = '2026-11-13';
for (let i = 39; i >= 0; i--) {
  bars.push({ date: d, close: Number((3000 * (1 + Math.sin(i * 1.7) * 0.008)).toFixed(2)) });
  d = previousTradingDay(d);
}
bars.reverse();
const input = {
  data: { index: { code: 'sh000001', name: '上证指数', bars } },
  emo: { baselineDate: '2026-11-13' },
  opts: { dataDir: TMP, today: '2026-11-15', limitPoolStore: NO_POOL }, // 运行日故意设为周日，验证不拿运行日冒充
};

(async function main() {
  console.log('\n=== 1) 模块版本与纯函数确定性 ===');
  // [任务卡 #014] 观察层版本与 APP_VERSION 一致——直接比较变量，不再写字面量，
  // 根除 bump_version 连续两次误伤旧戳字面量的问题（LRN-20261116-002）
  const verEarly = (SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/) || [])[1] || '';
  ok(w.WATCH_VERSION === verEarly, '观察层版本与 APP_VERSION 一致', w.WATCH_VERSION + ' vs ' + verEarly);
  ok(w.VOL_WINDOW === 20 && w.VOL_MARGINAL_BACK === 5, '波动率窗口 20 日 / 边际回溯 5 个交易日');
  {
    const s = w.realizedVolSeries(bars, 20);
    ok(s.length === 20, '40 根日线 → 20 个滚动点', `实际 ${s.length}`);
    ok(s[s.length - 1].date === '2026-11-13', '波动率数据日 = 最后一根日线');
    const flat = [];
    for (let i = 0; i <= 20; i++) flat.push({ date: 'x' + i, close: 100 });
    ok(w.realizedVolSeries(flat, 20)[0].vol === 0, '常数收益率 → 年化波动率 0%');
    ok(w.realizedVolSeries(bars.slice(0, 20), 20).length === 0, '不足 21 根不外推');
    const chg = w.marginalChange(s, 5, 'vol');
    ok(chg && ['up', 'down', 'flat'].indexOf(chg.direction) >= 0, '边际含方向 / 幅度 / 对比日');
    ok(w.stdev([1]) === null && w.stdev([1, 1]) === 0, '样本标准差样本不足返回 null、常数返回 0');
  }
  {
    const keys = w.sectorDays(hist, '2026-11-13');
    ok(keys.length === 6 && keys[keys.length - 1] === '2026-11-13',
      '板块日键过滤非交易日与越界日', JSON.stringify(keys));
    ok(w.continuityAt(keys, hist, keys.length - 1) === 100, '领涨板块全重合 → 延续度 100%');
    const diff = {};
    keys.forEach(k => { diff[k] = { up: [{ name: k, changePct: 1 }] }; });
    ok(w.continuityAt(keys, diff, keys.length - 1) === 0, '领涨板块全不重合 → 延续度 0%');
    const evs = w.activeEvents(JSON.parse(fs.readFileSync(path.join(TMP, 'events', 'active.json'), 'utf8')));
    ok(evs.length === 1, '事件只保留 1 条生效事件', `实际 ${evs.length}`);
    ok(evs.length === 1 && evs[0].title === '样本事件', 'paused / marketNeutralized 事件被排除');
  }

  console.log('\n=== 2) 主入口：4 项固定顺序 / 3 ready / 1 unavailable ===');
  const r = w.buildWatchIndicators(input);
  ok(r.scope === 'observation-only', 'scope = observation-only');
  ok(r.asOf === '2026-11-13', '基准日取模型算出的最近交易日，不取运行日', r.asOf);
  ok(Array.isArray(r.items) && r.items.length === 4, '固定 4 个观察项（赚钱效应已并入因子）');
  ok(r.items.map(x => x.key).join(',') === 'volatility,futuresBasis,sectorLead,newsFlow',
    '顺序 = 剩余观察项固定顺序', r.items.map(x => x.key).join(','));
  const ready = r.items.filter(x => x.status === 'ready');
  const missing = r.items.filter(x => x.status === 'unavailable');
  ok(ready.length === 3, '3 项可读（波动率 / 板块主线 / 消息面）', `实际 ${ready.length}`);
  ok(missing.length === 1, '1 项数据源待接入（期指基差）', `实际 ${missing.length}`);
  ok(missing.every(x => x.value === null && x.detail.length > 20 && x.note.length > 10),
    '缺口项 value=null 且写明原因与待接入条件（不编 0）');
  // [20261116c] 赚钱效应已并入「市场宽度 · 赚钱效应」因子（子权重 30%），观察层不得再重复展示
  ok(!r.items.some(x => x.key === 'profitEffect'), '赚钱效应不再出现在观察层（避免同一读数展示两次）');
  ok(fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8').includes('市场宽度 · 赚钱效应'), '赚钱效应已并入市场宽度因子卡（标题已改）');
  ok(/IF\/IH\/IC\/IM/.test(missing[0].detail) && /商品/.test(missing[0].detail), '期指基差缺口说明点名股指期货通道与商品期货不可冒充');
  ok(typeof r.summary === 'string' && /3 项可读/.test(r.summary) && !/不参与打分/.test(r.summary),
    'summary 只写统计、不重复标题里的「不参与打分」');
  ok(/不进权重表/.test(r.note) && /20 个交易日/.test(r.note), 'note 唯一说明边界与升格条件');
  // [任务卡 #017] 每项观察指标也要有一句人话（不占权重但要看懂）
  ok(r.items.every(x => typeof x.plain === 'string' && x.plain.length >= 8), '4 项观察指标都有人话文案');
  ok(!r.items.some(x => /分位|年化|百分点|Top5/.test(x.plain)), '人话文案不含专业术语');

  console.log('\n=== 3) 五要素 / 原则 A/C / 边际 ===');
  ready.forEach(x => {
    ok(!!(x.source && x.method && x.completeness && x.asOf && x.value != null),
      `${x.key}：五要素齐备（值/源/口径/时间/完整性）`);
  });
  const vol = r.items[0], sec = r.items[2], news = r.items[3];
  ok(vol.asOf === '2026-11-13' && vol.asOf !== '2026-11-15', '波动率用真实日线日，不用周日运行日冒充');
  ok(sec.asOf === '2026-11-13' && sec.asOf <= '2026-11-13', '板块主线数据日 = 不晚于基准日的最新日键');
  ok(/不认 recordedAt/.test(sec.method), '板块主线口径声明不认 recordedAt 写入时间');
  ok(/已跳过 2 个/.test(sec.detail), '非交易日 / 越界日键跳过数如实披露', sec.detail);
  ok(vol.change && vol.change.unit === '百分点' && /上升|下降|持平/.test(vol.detail), '波动率给出边际方向与幅度');
  ok(!/下降 -/.test(vol.detail) && !/上升 \+/.test(vol.detail), '文案直接表达，无「下降 -0.11」式双重反向');
  ok(news.asOfKind === 'event-time' && news.asOf === '2026-11-15', '消息面单独标「事件时间」，不冒充行情数据日');
  ok(vol.asOfKind === 'trading-day' && sec.asOfKind === 'trading-day', '行情类观察项标 trading-day');
  ok(/不做全市场方向判定/.test(news.detail), '消息面只列清单，不新建第二套市场级方向口径');
  ok(/1\/3/.test(news.completeness), '消息面完整性标注生效/总数');

  console.log('\n=== 4) 确定性（数据不变则结论不变） ===');
  const r2 = w.buildWatchIndicators(input);
  ok(JSON.stringify(r) === JSON.stringify(r2), '同一输入两次输出逐字一致');
  const r3 = w.buildWatchIndicators(Object.assign({}, input, { opts: { dataDir: TMP, today: '2026-11-16', limitPoolStore: NO_POOL } }));
  ok(JSON.stringify(r) === JSON.stringify(r3), '换运行日（仍非交易日）输出不变');

  console.log('\n=== 5) 隔离性：零数值变化 / 不进权重与台账 ===');
  ok(!WATCH.includes('BASE_WEIGHTS') && !WATCH.includes('learnWeights') && !WATCH.includes('totalScore'),
    '观察层源码不引用权重表 / 自学习 / 总分');
  ok(!WATCH.includes('writeFileSync') && !WATCH.includes('appendFileSync'), '观察层不写任何落盘文件');
  ok(!WATCH.includes('fetch(') && !WATCH.includes('http.get') && !WATCH.includes('axios'), '观察层零网络请求');
  ok(!WATCH.includes('Math.random'), '观察层零随机');
  ok(!MODEL.includes('marketEmotionWatch') && !MODEL.includes('watchIndicators'),
    '模型层完全不知道观察层存在 → 10 因子数值不可能被改变');
  ok(SERVER.includes('return emo;')
    && SERVER.includes('emo.watchIndicators = marketEmotionWatch.buildWatchIndicators({ data, emo })'),
    '观察层只作为新增字段挂在既有返回体上');
  ok(!('factors' in r) && !('totalScore' in r) && !('learnLog' in r),
    '观察层返回体不含 factors / totalScore / learnLog');
  ok(BASE_GUARD.includes('r.factors.length === 10'), '既有守卫的 10 因子断言保持不变');

  console.log('\n=== 6) 下游协同进化（输出格式变化 → 铁律第二条） ===');
  ok(SERVER.includes("require('./lib/marketEmotionWatch')"), 'server.js 引入观察模块');
  ok(SERVER.includes("require('./lib/limitPoolStore')") && SERVER.includes('limitPoolStore.captureFromReview(today'),
    '[#012] 15:35 复盘后复用 context 落盘（不额外打 akshare）');
  ok(SERVER.includes('emo.watchIndicators = marketEmotionWatch.buildWatchIndicators({ data, emo })'),
    '在 computeMarketEmotion 之后挂字段');
  // [20261115d 修复] computeMarketEmotion 是 async：不 await 会把字段挂在 Promise 上，
  // 外层 return Promise 解包后字段丢失 → 接口无 watchIndicators → 前端整块不渲染。
  // 静态断言只能防「去掉 await」，下方第 9 段另有动态复现证据。
  ok(SERVER.includes('const emo = await marketEmotionModel.computeMarketEmotion({ data, macroFactors: macro })'),
    'await 模型异步返回后再挂字段（缺 await 会丢字段）');
  ok(/async function computeMarketEmotion/.test(MODEL), '模型确为 async，await 是必需而非可选');
  {
    const fnStart = SERVER.indexOf('async function buildHomeMarketEmotion');
    const fnSeg = SERVER.slice(fnStart, fnStart + 5000);
    ok(fnSeg.indexOf('emo.watchIndicators =') > 0 && fnSeg.indexOf('emo.watchIndicators =') < fnSeg.indexOf('return emo;'),
      '挂字段在 return emo 之前，主模型结论已先算完');
  }
  ok(SERVER.includes('emo.watchIndicators = null'), '观察层算失败置 null，绝不影响主模型结论');
  ok(APP.includes('const watch = data.watchIndicators'), 'app.js 读取新增字段');
  ok(APP.includes('if (watch && Array.isArray(watch.items)'), 'watchIndicators 缺失时整块静默不渲染（兼容旧进程）');
  ok(APP.includes('tp-watch-block') && APP.includes('观察指标（仅展示 · 不参与打分）'), '前端新增观察层板块与明确标题');
  ok(APP.includes("x.status === 'ready'") && APP.includes("x.status === 'unavailable'"), '前端区分可读项与缺口项');
  ok(APP.includes('tp-sig-flat'), '观察数值用中性灰，不占红绿方向色');
  ok(APP.includes("w.asOfKind === 'event-time' ? '事件时间' : '数据日期'"), '前端按 asOfKind 区分事件时间与行情数据日');
  {
    const wStart = APP.indexOf('const watch = data.watchIndicators');
    const wEnd = APP.indexOf('const noteBase = String(data.dataNote');
    const seg = wStart >= 0 && wEnd > wStart ? APP.slice(wStart, wEnd) : '';
    ok(seg.length > 1000, '观察层渲染代码块可定位', `片段长度 ${seg.length}`);
    ok(!/净权重|权重%/.test(seg), '观察层卡片内不出现「权重 / 净权重」，避免误读为打分因子');
  }
  ok(LOGIC.includes('观察指标层') && LOGIC.includes("badge: '10 因子'"),
    '逻辑模型页登记观察层，badge 仍 10 因子（观察项不是正式因子）');
  ok(DOC.includes('## 八、观察指标层') && DOC.includes('data/sector_rank_history.json'),
    '逻辑说明文档新增第八节登记 5 维度与数据源');
  ok(DOC.includes('不升') && DOC.includes('SCHEMA_VERSION'), '文档写明不升 SCHEMA_VERSION / LAYOUT_VERSION');

  console.log('\n=== 7) 版本戳强绑定 ===');
  const verMatch = SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/);
  const ver = verMatch ? verMatch[1] : '';
  ok(ver === '20261118a', 'APP_VERSION = 20261118a', ver);
  ok(WATCH.includes("const WATCH_VERSION = '20261118a'"), '观察层自身版本戳与 APP_VERSION 一致');
  {
    const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
    const withV = htmls.filter(f => /\?v=\d{8}[a-z]/.test(src('public/' + f)));
    ok(withV.length >= 8, `至少 8 个 HTML 带 ?v=（实际 ${withV.length}）`);
    // 旧戳拆写，避免后续 bump_version 把「残留检查」本身误替换成新版本
    const OLD_VER = '20261115' + 'c';
    const stale = withV.filter(f => src('public/' + f).includes('?v=' + OLD_VER));
    ok(stale.length === 0, `无残留 ?v=${OLD_VER}`, stale.join(','));
    const notNew = withV.filter(f => !/\?v=20261118a/.test(src('public/' + f)));
    ok(notNew.length === 0, '所有带戳 HTML 均已同步 ?v=20261118a', notNew.join(','));
    const total = withV.reduce((n, f) => n + (src('public/' + f).match(/\?v=20261118a/g) || []).length, 0);
    // [任务卡 #015] 删除 emotionSummary.js 脚本引入，?v= 从 58 → 57 处
    ok(total === 57, `?v=20261118a 共 57 处（实际 ${total}）`);
  }

  console.log('\n=== 8) 样本不足时如实降级（不外推） ===');
  {
    const short = w.buildWatchIndicators({
      data: { index: { bars: bars.slice(0, 10) } },
      emo: { baselineDate: '2026-11-13' },
      opts: { dataDir: TMP, today: '2026-11-15', limitPoolStore: NO_POOL },
    });
    ok(short.items[0].status === 'unavailable' && /不足/.test(short.items[0].detail),
      '日线不足 21 根 → 波动率如实标 unavailable，不编数');
    ok(short.items[0].value === null, '缺口项 value=null，不是 0');
  }
  {
    const noDir = w.buildWatchIndicators({
      data: { index: { bars } },
      emo: { baselineDate: '2026-11-13' },
      opts: { dataDir: path.join(TMP, 'not-exists'), today: '2026-11-15', limitPoolStore: NO_POOL },
    });
    ok(noDir.items[2].status === 'unavailable' && noDir.items[3].status === 'unavailable',
      '板块 / 事件文件缺失时如实标 unavailable，不抛异常');
  }

  console.log('\n=== 9) 实证：挂上观察层前后主模型结论逐字不变 ===');
  {
    const bars2 = [];
    for (let i = 0; i < 12; i++) {
      bars2.push({ date: `2026-11-${String(1 + i).padStart(2, '0')}`, close: 3600 + i * 2, volume: 1e8, amount: 1e11 });
    }
    bars2[bars2.length - 1].date = '2026-11-13';
    const d2 = {
      date: '2026-11-15',
      index: { bars: bars2 },
      breadth: { up: 100, down: 200, limitUp: 5, limitDown: 10 },
      discussionHeat: { marketHeat: -0.229, date: '2026-11-13', value: '热度 -0.23' },
      etfFlow: { score: 0, degraded: false, date: '20261112', totalNet: 0, value: '净申购 0.00 亿' },
    };
    const snap = (r) => JSON.stringify({
      totalScore: r.totalScore,
      weights: r.weights,
      tendency: r.tendency,
      factors: (r.factors || []).map(f => ({ key: f.key, weight: f.weight, score: f.score, netWeight: f.netWeight })),
    });
    const a = await model.computeMarketEmotion({ data: d2, macroFactors: [] });
    const before = snap(a);
    const b = await model.computeMarketEmotion({ data: d2, macroFactors: [] });
    b.watchIndicators = w.buildWatchIndicators({ data: d2, emo: b, opts: { dataDir: TMP, today: '2026-11-15', limitPoolStore: NO_POOL } });
    ok(before === snap(b), '挂观察层后 totalScore / weights / tendency / 10 因子数值逐字不变');
    ok(b.watchIndicators && b.watchIndicators.items.length === 4, '观察层作为独立新增字段存在（4 项），不混进 factors');
    ok(!('watchIndicators' in a), '未接线时模型返回体不含观察层字段（旧调用方零感知）');

    // 动态复现接线 bug：把字段挂到 Promise 本身（旧写法）→ 解包后必然丢失；
    // await 后挂到结果对象 → 字段保留。这是「展示在哪里」报障的根因证据。
    const p = model.computeMarketEmotion({ data: d2, macroFactors: [] });
    p.watchIndicators = { probe: 1 };
    const resolved = await p;
    ok(!('watchIndicators' in resolved), '不 await：字段挂在 Promise 上，解包后确实丢失（根因复现）');
    resolved.watchIndicators = { probe: 1 };
    ok('watchIndicators' in resolved, 'await 后：字段进入结果对象，接口才能透出');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})();
