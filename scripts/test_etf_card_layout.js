/**
 * 宽基 ETF 因子卡「布局隔离」回归（零网络、零浏览器）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_etf_card_layout.js
 *
 * 背景（20261023b）：20261023a 曾把 ETF 因子卡做成整行宽 + 卡内三页签（个股/ETF 表内嵌），
 * 用户 2026-10-23 截图报障「卡片的布局全部乱了」，要求把口径解释、ETF 数量统计、个股统计
 * 移到**卡片之外**（独立「宽基ETF申赎」页签），卡片只保留一条摘要 + 明细入口。
 *
 * 本文件守住：
 *   [A] etfFlow 卡与其它因子卡完全同构：无 tp-comp-wide、无卡内页签、10 张卡等宽入网格
 *   [B] 卡片 detail 只说一句短摘要（不含长口径「口径：Δ份额…」）
 *   [C] 卡片带「查看宽基ETF明细 →」入口（data-action="goto-etf-tab"），点击切到独立页签
 *   [D] 独立「宽基ETF申赎」页签仍是完整明细：概览 / 家族 / ETF 表 / 逐股 / 口径说明
 *   [E] 源码守卫：点击处理器写 _emoTab='etf'；CSS 有 .tp-comp-more、无 .tp-comp-wide / .etf-inline-*
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
function count(hay, needle) { return (hay.split(needle).length - 1); }

// ---------------- 最小 DOM 桩 ----------------
const elMap = {};
function mkCL() {
  const s = new Set();
  return { add(...c){c.forEach(x=>s.add(x));}, remove(...c){c.forEach(x=>s.delete(x));}, contains(c){return s.has(c);},
    toggle(c,o){ if(o===undefined){s.has(c)?s.delete(c):s.add(c);} else if(o)s.add(c); else s.delete(c);} };
}
function makeEl(id) {
  return { id, textContent:'', innerHTML:'', style:{}, offsetWidth:100, classList:mkCL(),
    querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){} };
}
global.document = {
  getElementById:(id)=>(elMap[id]!==undefined?elMap[id]:null), querySelectorAll:()=>[], querySelector:()=>null,
  addEventListener:()=>{}, createElement:()=>makeEl('tmp'), body:{classList:mkCL(),appendChild(){}}, documentElement:{classList:mkCL()},
};
global.window = global; global.window.addEventListener = ()=>{}; global.window.requestAnimationFrame = (fn)=>setTimeout(fn,0);
global.location = { href:'http://127.0.0.1:3005/', search:'', pathname:'/', hash:'' };
global.localStorage = { _d:{}, getItem(k){return this._d[k]===undefined?null:this._d[k];}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} };
global.CustomEvent = class { constructor(t,o){this.type=t;this.detail=o&&o.detail;} };
global.Event = class { constructor(t){this.type=t;} };
global.fetch = async ()=>({ ok:true, json:async()=>({}) });
global.Storage = { getWatchlist:()=>[], addToHistory(){}, initWatchlist:async()=>{}, getGroups:()=>[] };
global.DocStore = { setStock(){}, onTabSwitch(){} };
global.DeepCharts = { disposeAll(){} };
global.Notes = undefined;
global.echarts = { init:()=>({setOption(){},dispose(){},on(){},getZr:()=>({on(){},off(){}})}), registerTheme(){} };

const src = fs.readFileSync(path.join(__dirname,'..','public','js','app.js'),'utf8');
const css = fs.readFileSync(path.join(__dirname,'..','public','css','style.css'),'utf8');
const App = new Function(`${src}; return App;`)();

// ---------------- 夹具 ----------------
const LONG_DETAIL = '宽基 ETF（沪深300、上证50、中证500、中证1000、科创50，有效 34 只）份额较上一收盘 20261022 合计增加 → 折算净申购 310.36 亿（盘中读数（收盘后定稿））。口径：Δ份额 ÷ 最小申赎单位 = 篮数，再乘每篮成分股数得逐股理论增减量；份额本身是「净」概念，无法拆出申购总量与赎回总量。';
const FACTORS = [
  { key:'volumePrice', name:'量能活跃与量价配合', weight:22, score:0.5, value:'v1', detail:'d1' },
  { key:'breadthExtreme', name:'市场宽度与极端情绪', weight:13, score:0.2, value:'v2', detail:'d2' },
  { key:'indexMomentum', name:'大盘近期涨跌势头', weight:9, score:0.1, value:'v3', detail:'d3' },
  { key:'margin', name:'融资余额（杠杆资金）', weight:9, score:0.1, value:'v4', detail:'d4' },
  { key:'mainCapital', name:'主力资金流向', weight:9, score:-0.2, value:'v5', detail:'d5' },
  { key:'discussionHeat', name:'股吧讨论热度', weight:9, score:0.3, value:'v6', detail:'d6' },
  { key:'riskAversion', name:'避险情绪', weight:9, score:0, value:'v7', detail:'d7' },
  { key:'etfFlow', name:'宽基ETF申购赎回（增量资金）', weight:10, score:1,
    value:'净申购 310.36 亿 · 14 只净申购 / 2 只净赎回', detail:LONG_DETAIL, degraded:false },
  { key:'domesticMacro', name:'国内宏观数据情绪', weight:0, score:0, value:'休眠', detail:'d9' },
  { key:'usMacro', name:'美国宏观事件情绪', weight:3.2, score:0, value:'中性', detail:'d10' },
];
const DATA = { totalScore:0.5, tendency:'偏多', tendencyKey:'bull', volumeState:'放量', coreDriver:'x', advice:'y',
  riskTip:'z', source:'src', baselineDate:'20261023', factors:FACTORS };

const FIXTURE = {
  ok:true, date:'20261023', baseDate:'20261022', settled:false, baselineOnly:false,
  summary:{ totalNet:31036125430, ledgerDays:0, ledgerDate:null,
    groups:[{key:'csi300', label:'沪深300', netAmount:14179346490, etfCount:1}] },
  etfs:[{ code:'510300', name:'华泰柏瑞沪深300ETF', group:'csi300', groupLabel:'沪深300',
    unit:900000, shares:32729887700, dShares:2530800000, baskets:2812, netAmount:10399816440, note:'' }],
  stocks:[{ code:'601398', name:'工商银行', groupLabel:'沪深300 / 上证50', dayBuy:36486500, daySell:-6800, cumBuy:0, cumSell:0 }],
};

// ============================================================================
// [A]/[B]/[C] 因子网格里的 etfFlow 卡
// ============================================================================
console.log('\n[A] etfFlow 卡与其它因子卡同构（不再整行宽 / 不再卡内页签）');
elMap.homeSentimentPanel = makeEl('homeSentimentPanel');
elMap.homeSentimentBody = makeEl('homeSentimentBody');
elMap.homeSentimentUpdated = makeEl('homeSentimentUpdated');
App._emoData = null; App._emoTab = 'factors'; App._etfFlowLoading = true; // 阻止自动取数
App._renderEmotionPanel(DATA);
const html = elMap.homeSentimentBody.innerHTML;

ok(!html.includes('tp-comp-wide'), '卡片不再带 tp-comp-wide（不再整行跨列）');
ok(!html.includes('data-action="etf-inline-tab"'), '不再有卡内页签 etf-inline-tab');
ok(count(html, '<div class="tp-comp"') + count(html, '<div class="tp-comp tp-comp-degraded"') === 10,
  `10 个因子全部是普通网格卡（实际 ${count(html, '<div class="tp-comp"') + count(html, '<div class="tp-comp tp-comp-degraded"')}）`);
ok(html.includes('data-action="goto-etf-tab"'), 'etfFlow 卡带「查看宽基ETF明细」入口');
ok(count(html, 'data-action="goto-etf-tab"') === 1, '明细入口只有 1 个（仅 etfFlow 卡）');
ok(html.includes('净申购 310.36 亿 · 14 只净申购 / 2 只净赎回'), '卡片保留核心数值 f.value');

console.log('\n[B] 卡片 detail 只留短摘要（长口径移出）');
ok(!html.includes('口径：Δ份额'), '卡片不再出现长口径「口径：Δ份额…」');
ok(!html.includes('无法拆出申购总量与赎回总量'), '卡片不再出现长口径尾巴');
ok(html.includes('见「宽基ETF申赎」页签'), '卡片短摘要指向独立页签');
ok(html.includes('折算净申赎额'), '短摘要含「折算净申赎额」');

console.log('\n[C] 顶部仍有独立「宽基ETF申赎」页签');
ok(html.includes('data-tab="etf"'), '页签栏含 data-tab="etf"');
ok(html.includes('宽基ETF申赎'), '页签文案存在');

// ============================================================================
// [D] 独立页签仍是完整明细
// ============================================================================
console.log('\n[D] 独立「宽基ETF申赎」页签：概览 / ETF 表 / 逐股 / 口径说明');
App._emoTab = 'etf'; App._etfFlowData = FIXTURE; App._etfFlowLoading = false;
App._renderEmotionPanel(DATA);
const etfHtml = elMap.homeSentimentBody.innerHTML;
ok(!etfHtml.includes('<div class="tp-comp-grid">'), 'ETF 页签不渲染因子网格（互不干扰）');
ok(etfHtml.includes('各宽基 ETF 申赎'), '含 ETF 明细表标题');
ok(etfHtml.includes('被申购') && etfHtml.includes('被赎回'), '含逐股被申购/被赎回 Top10');
ok(etfHtml.includes('怎么算的'), '含口径解释「怎么算的」');
ok(etfHtml.includes('510300'), 'ETF 行数据已渲染');
ok(etfHtml.includes('601398'), '逐股行数据已渲染');
ok(!/undefined|NaN/.test(etfHtml), '独立页签渲染无 undefined / NaN');

// ============================================================================
// [E] 源码守卫
// ============================================================================
console.log('\n[E] 源码守卫');
ok(src.includes('data-action="goto-etf-tab"'), 'app.js：卡片明细入口 data-action="goto-etf-tab"');
ok(src.includes("App._emoTab = 'etf';"), 'app.js：点击入口切到 etf 页签');
ok(!src.includes('_renderEtfFactorCard'), 'app.js：已删除卡内页签渲染器（无死逻辑）');
ok(!src.includes('_etfInlineTab'), 'app.js：已删除 _etfInlineTab 状态');
ok(css.includes('.tp-comp-more'), 'CSS：新增 .tp-comp-more 明细入口样式');
ok(!css.includes('.tp-comp-wide'), 'CSS：已删除 .tp-comp-wide');
ok(!css.includes('.etf-inline-tab'), 'CSS：已删除 .etf-inline-tab');
ok(src.includes("if (f.key === 'etfFlow')")
  && src.includes("f.key === 'etfFlow'\n          ? '份额较上一收盘增加"), 'app.js：etfFlow 走短摘要分支');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
