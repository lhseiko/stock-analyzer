#!/usr/bin/env node
/**
 * scripts/test_emotion_margin_render.js — [20261109a] 两融双栏「端到端渲染」冒烟守卫
 *
 * 存在理由：本轮实测发现 computeMarketEmotion 返回 factors 时有一层**字段白名单**，
 * 新加的 subs 若漏透出，模型层单测全绿、静态断言全绿，但前端 isDual 判否 → 双栏根本不渲染。
 * 本守卫从「真实模型输出 → app.js 真实渲染函数 → 最终 HTML」整条链验证，专门守住这个接缝。
 *
 * 夹具用金十 2026-11-05 实测值（融资 22709.8 亿 / -3.33%，融券 288.11 亿 / +2.08%），
 * 无网络请求；app.js 在 vm 沙箱中加载，DOM 用最小 stub，不启动浏览器。
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-margin-render-'));
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');
fs.writeFileSync(process.env.SA_MSI_SERIES, '[]');
const { computeMarketEmotion, plainTextOf } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

function mkBars(n) {
  const bars = []; let close = 3800;
  const endT = Date.parse('2026-11-09T00:00:00');
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dates = [];
  for (let t = endT; dates.length < n; t -= 86400000) {
    const d = new Date(t);
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.unshift(fmt(d));
  }
  for (let i = 0; i < n; i++) {
    close *= 1.0005;
    bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(5e8 * (1 + Math.sin(i / 7) * 0.1)) });
  }
  return bars;
}

const bundle = {
  ok: true, date: '2026-11-09',
  index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
  breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
  // 金十 fs_1/fs_2 2026-11-05 实测：融资 22709.8 亿(5日 -3.33%)、融券 288.11 亿(5日 +2.08%)
  margin: {
    latest: 22709.8, changePct: 0.3, change5Pct: -3.33, date: '2026-11-05',
    rqLatest: 288.11, rqChange5Pct: 2.08, rqDate: '2026-11-05',
  },
  mainFund: { mainNetToday: 150, history: [] },
  capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
  fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
  bond: { cn10y: 2.0, chgBp5: 5 },
  discussionHeat: { marketHeat: 0.2, date: '2026-11-09', value: '热度 0.2', detail: '数据源：东财股吧，样本 1200 只' },
  issues: [], warnings: [],
};

const mkEl = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  appendChild() {}, insertAdjacentHTML() {},
});

(async () => {
  const data = await computeMarketEmotion({ data: bundle, macroFactors: [] });
  const mg = data.factors.find(f => f.key === 'margin');
  console.log(`\n模型输出：${mg.name} score=${mg.score} weight=${mg.weight} contribution=${mg.contribution}`);
  ok(Array.isArray(mg.subs) && mg.subs.length === 2, '模型输出白名单透出 subs（本守卫的核心接缝）');
  ok(mg.score === -1, '融资撤离(-1) + 融券增加(-1) → 满格利空 -1');
  ok(mg.subs[0].tone === 'bear' && mg.subs[1].tone === 'bear', '两子项均为利空 tone');

  const els = {};
  const sandbox = {
    console, URL, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ json: () => ({}) }),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', search: '' },
    document: {
      addEventListener() {},
      getElementById(id) { return els[id] || (els[id] = mkEl()); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mkEl(); }, body: mkEl(),
    },
    Chart: function () { return {}; },
    echarts: { init() { return { setOption() {}, resize() {} }; } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8') + '\n;globalThis.__App = App;';
  vm.runInContext(src, sandbox, { timeout: 10000 });
  const App = sandbox.__App;
  ok(!!(App && typeof App._renderEmotionPanel === 'function'), 'vm 成功加载 App._renderEmotionPanel');
  App._renderEmotionPanel(data);
  const html = els.homeSentimentBody.innerHTML;
  ok(html.length > 1000, `渲染出非空 HTML（${html.length} 字符）`);

  console.log('\n最终 HTML 断言：');
  ok(/两融余额/.test(html), '卡片标题为「两融余额」');
  ok(/tp-comp-dual/.test(html), '渲染双栏容器');
  ok(/融资余额/.test(html) && /融券余额/.test(html), '两个子项名称都在卡片里');
  ok((html.match(/tp-comp-sub-hd/g) || []).length === 2, '恰为 2 个子栏');
  ok(/50%/.test(html), '显示各占 50% 权重');
  ok(/tp-comp-sub-val tp-sig-bear/.test(html), '融券增加=利空 → 绿色（tp-sig-bear）');
  ok(!/<span class="up">\+2\.08%/.test(html), '融券「+2.08%」未被按数值符号误染成红色');
  ok(/两融双栏各按半格/.test(html), '因子区标题同步说明半格口径');
  ok(/融资 \/ 融券各占本卡 50% 权重/.test(html), '卡内显示 splitNote 平分权重说明');
  ok(/tp-emo-info/.test(html), '保留 T+1 例行披露 / 口径信息条');
  ok(/因子归纳/.test(html), '[#015] 结论区渲染「因子归纳」一行');
  // [20261116b 补] 卡片文案去歧义：权重/计入总分分开写，指数势头改「收盘」并补 MA20 与近 5/20 日涨跌
  ok(/本卡权重/.test(html) && !/净权重/.test(html), '因子卡用「本卡权重 + 计入总分」，不再出现「净权重」');
  const imF = data.factors.find(f => f.key === 'indexMomentum');
  ok(!!imF && /^收盘/.test(imF.value) && !/现价/.test(imF.value), '指数势头卡用「收盘」，不再用「现价」');
  ok(!!imF && /MA20/.test(imF.detail) && /近 5 日/.test(imF.detail) && /近 20 日/.test(imF.detail),
    '详情含 MA5/MA20/MA60 排序与近 5/20 日涨跌');
  // [任务卡 #017] 人话层：每因子一句、原始数据收起但仍可展开
  ok(data.factors.every(f => typeof f.plain === 'string' && f.plain.length >= 8), '10 个因子都有人话文案');
  ok(!data.factors.some(f => /分位|净权重|贡献度|百分点|Top5/.test(f.plain)), '人话文案不含专业术语');
  ok((html.match(/tp-comp-plain/g) || []).length === data.factors.length, '每张因子卡都渲染人话行');
  ok((html.match(/<details class="tp-comp-raw">/g) || []).length === data.factors.length, '每张卡原始数据默认收起');
  ok(/上证收盘/.test(html) && /近 20 日/.test(html), '原始数据仍保留在 HTML 内（可展开）');
  ok(/净赎回 85\.9 亿/.test(plainTextOf({ key: 'etfFlow', score: -1, totalNet: -8585495010 })),
    'ETF 金额元→亿元换算正确（不出现 8585495010 亿）');
  ok(/净流出 646\.8 亿/.test(plainTextOf({ key: 'mainCapital', score: -1, todayNet: -646.8 })),
    '主力金额本身是亿元口径，不重复换算');

  // [任务卡 #015] 因子归纳：纯函数直测（10 打分因子 + 4 观察项，含避险未触发与总分方向对齐）
  console.log('\n[任务卡 #015] 因子归纳（纯函数）：');
  const SF = {
    totalScore: 0.12,
    factors: [
      { key: 'mainCapital', contribution: -9.2 },
      { key: 'breadthExtreme', contribution: -7.4 },
      { key: 'volumePrice', contribution: 3.1 },
      { key: 'indexMomentum', contribution: 0 },
      { key: 'margin', contribution: 0, degraded: true },
      { key: 'riskAversion', contribution: 0, conditional: true, triggered: false },
      { key: 'discussionHeat', contribution: 0 },
      { key: 'etfFlow', contribution: 0 },
      { key: 'domesticMacro', contribution: 0 },
      { key: 'usMacro', contribution: 0 },
    ],
    watchIndicators: {
      items: [
        { key: 'volatility', name: '波动率（20 日年化）', status: 'ready', value: 18.32, unit: '%', change: { direction: 'up', delta: 0.61 } },
        { key: 'sectorLead', name: '板块主线', status: 'ready', value: 40, unit: '%' },
        { key: 'newsFlow', name: '消息面', status: 'ready', value: 3, unit: '条' },
        { key: 'futuresBasis', name: '期指基差', status: 'unavailable', value: null },
      ],
    },
  };
  const sum = App._emoPlainSummary(SF);
  ok(typeof sum === 'string' && sum.length > 40, '归纳输出非空一段话');
  ok(/打分因子共 10 项/.test(sum), '覆盖全部 10 个打分因子计数');
  ok(/避险未触发、不计分/.test(sum), '「避险未触发」写入归纳');
  ok(/主力资金流向/.test(sum) && /市场宽度（赚钱效应）/.test(sum), '点出当日影响最大的两个因子');
  ok(/但其余因子的加分更多/.test(sum), '两项都在减分但总分为正 → 方向与总分一致');
  ok(/另有 4 项观察指标只看不计分/.test(sum), '观察因子不占权重也一并总结');
  ok(/期指基差暂无数据/.test(sum), '观察层缺口如实标注');
  ok(!/净权重|贡献度/.test(sum), '不出现专业术语（净权重 / 贡献度）');
  // [任务卡 #015] 输出白名单必须透出 conditional / triggered，否则真实接口下永远写不出「避险未触发」
  const quiet = await computeMarketEmotion({
    data: Object.assign({}, bundle, {
      fx: { usdcnh: 7.0, usdcnhChgPct: 0, usdcny: 7.0, usdcnyChgPct: 0 },
      bond: { cn10y: 2.0, chgBp5: 0 },
    }),
    macroFactors: [],
  });
  const raQ = quiet.factors.find(f => f.key === 'riskAversion');
  ok(!!raQ && raQ.conditional === true && raQ.triggered === false, '输出白名单透出 conditional / triggered（真实模型 → 接口）');
  ok(/避险未触发/.test(App._emoPlainSummary(quiet)), '中性避险日 → 归纳写入「避险未触发」');
  const LIVE = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(!/homeEmotionSummary|_renderEmotionSummary|EmotionSummary\.build/.test(LIVE), '速览模块已彻底下线（无残留容器/渲染/调用）');

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SA_MARKET_EMOTION_DIR;
  delete process.env.SA_MSI_SERIES;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e && e.stack || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
