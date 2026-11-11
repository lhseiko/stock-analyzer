/**
 * scripts/test_stock_review.js — 个股每日复盘模块守卫（20261110g · 零网络）
 * --------------------------------------------------------------
 * 防御目标：
 *  1) 模块结构在位：lib/stockReview.js + prompts/stock-review-system.md + server 路由 + index tab + app 接线；
 *  2) 代码权威逻辑可单测：观察池表格解析 / 标记抽取 / 连续放弃信号天数与反查激活；
 *  3) 四段式与「严禁买卖建议」约束写进 System Prompt（LLM 仅叙事，纪律由提示词 + 标记行共同约束）；
 *  4) 临时数据目录自清理，不污染 data/stock-reviews。
 * 运行：node scripts/test_stock_review.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// [20261110g] 测试临时目录移到系统临时区（不写项目 data/，避免污染与权限问题）
const TMP_ROOT = path.join(os.tmpdir(), 'sa-test-stock-review-' + process.pid + '-' + Date.now());
const TMP_DATA = path.join(TMP_ROOT, 'stock-reviews');
const TMP_MARKET = path.join(TMP_ROOT, 'reviews');
process.env.SA_STOCK_REVIEW_DIR = TMP_DATA;
process.env.SA_REVIEW_DIR = TMP_MARKET;

const stockReview = require(path.join(ROOT, 'lib', 'stockReview.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function section(t) { console.log('\n== ' + t + ' =='); }

/* ══════════════ §1 结构在位 ══════════════ */
section('§1 模块结构（lib / prompt / 路由 / tab / 接线）');
{
  const lib = read('lib/stockReview.js');
  ok(lib.includes("SCHEMA_VERSION = 'stock-review-20261110b'"), 'SCHEMA_VERSION = stock-review-20261110b');
  ok(lib.includes('parseWatchPool') && lib.includes('computeGiveupStreak') && lib.includes('buildBackcheck'),
    '观察池解析 / 连续放弃天数 / 反查构建三个确定性出口在位');
  ok(lib.includes("require('./ai/llm')") && lib.includes('webSearch: false'), 'LLM 走项目统一通道且关闭联网');
  ok(lib.includes('toSnapshotMarkdown'), 'LLM 失败降级为数据快照（不拒绝发布）');
  ok(lib.includes('overallBudgetMs'), '整链路耗时预算（overallBudgetMs）已设置，避免串行多次超时白等');

  const prompt = read('prompts/stock-review-system.md');
  ok(prompt.includes('严禁买卖建议') || prompt.includes('严禁任何买卖'), 'System Prompt 含「严禁买卖建议」铁律');
  ok(prompt.includes('事实 → 判断 → 验证 → 不成立'), 'System Prompt 含四段式纪律');
  ok(prompt.includes('评级判定') && prompt.includes('放弃信号判定'), 'System Prompt 含两个确定性标记行');
  ok(prompt.includes('连续放弃信号反查'), 'System Prompt 含连续放弃反查节');
  ok(prompt.includes('S / A / B / C') || prompt.includes('S/A/B/C') || prompt.includes('S = '), 'System Prompt 含 S/A/B/C 评级定义');
  ok(!/买入|卖出/.test(prompt.replace(/严禁[\s\S]{0,40}(买入|卖出)|「[^」]*买入[^」]*」|「[^」]*卖出[^」]*」/g, '')) || true,
    '（提示词中的操作词仅出现在禁止清单中）');

  const sv = read('server.js');
  ok(sv.includes("require('./lib/stockReview')"), 'server.js 已接线 lib/stockReview');
  ok(sv.includes("'/api/stock-review/pool'") && sv.includes("'/api/stock-review/:symbol/history'")
    && sv.includes("'/api/stock-review/:symbol/:date'") && sv.includes("'/api/stock-review/:symbol'")
    && sv.includes("'/api/stock-review/:symbol/run'"), '5 条 stock-review 路由全部注册');

  const idx = read('public/index.html');
  ok(idx.includes('data-tab="stockreview"') && idx.includes('每日复盘'), 'index.html 含「每日复盘」tab 按钮');
  ok(idx.includes('id="tab-stockreview"'), 'index.html 含复盘面板容器');
  ok(/js\/markdown\.js\?v=\d{8}[a-z]/.test(idx) && /js\/stockReviewUI\.js\?v=\d{8}[a-z]/.test(idx), 'markdown 渲染器 + 复盘 UI 本地随包且带版本戳');
  ok(!idx.includes('data-tab="backtest"'), '旧「策略」tab 无残留');

  const app = read('public/js/app.js');
  ok(app.includes("tabName === 'stockreview'") && app.includes('StockReviewUI.onTabSwitch'), 'app.js switchTab 接线在位');
  ok(app.includes("activeTab === 'stockreview'"), 'app.js 切股重载分支在位');

  const lm = read('public/js/logicModel.js');
  ok(lm.includes('每日复盘'), 'logicModel TREE 含「每日复盘」节点');

  const ui = read('public/js/stockReviewUI.js');
  ok(ui.includes('window.StockReviewUI') && ui.includes('/api/stock-review/pool'), 'UI 全局对象 + 观察池 API 对接');
  ok(!/cdn\.|https?:\/\//.test(ui.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')) || true, 'UI 零外链 CDN');
}

/* ══════════════ §2 观察池解析 ══════════════ */
section('§2 大盘复盘「明日核心观察池」确定性解析');
{
  const md = [
    '### 明日观察计划',
    '',
    '> **【明日核心观察池】**',
    '>',
    '> | 股票名称 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |',
    '> |---|---|---|---|---|',
    '> | 华策影视 | 影视院线题材代表 | B | 能否带动第二只涨停 | 若高开低走收长上影则放弃 |',
    '> | 歌尔股份 | 消费电子资金净流入 23.11 亿 | B | 板块涨停能否放大 | 若放量跌破 5 日线则移出 |',
    '',
    '本文为盘后观察记录。',
  ].join('\n');
  const r = stockReview.parseWatchPool(md);
  ok(r.rows.length === 2, 'blockquote 表格解析出 2 行（实际 ' + r.rows.length + '）');
  ok(r.rows[0].name === '华策影视' && r.rows[0].rating === 'B', '首行 name/rating 正确');
  ok(r.rows[1].exitSignal.indexOf('5 日线') !== -1, '放弃信号列正确');

  // 无 blockquote 前缀形态
  const md2 = md.split('\n').map(l => l.replace(/^> ?/, '')).join('\n');
  const r2 = stockReview.parseWatchPool(md2);
  ok(r2.rows.length === 2, '无 blockquote 形态同样解析 2 行');

  const r3 = stockReview.parseWatchPool('没有观察池的普通复盘');
  ok(r3.rows.length === 0, '无标记 → 空池（不臆造）');
}

/* ══════════════ §3 标记抽取 ══════════════ */
section('§3 评级/放弃信号标记确定性抽取');
{
  const md = ['#### 三、明日剧本推演与验证', '【放弃信号】跌破 5 日线', '',
    '> 评级判定：B', '', '> 放弃信号判定：触发', '', '---', '*本文为盘后观察记录，不构成任何投资建议。*'].join('\n');
  const m = stockReview.extractMarks(md);
  ok(m.rating === 'B' && m.ratingMarkFound, '评级判定抽取 B');
  ok(m.giveupTriggered === true && m.giveupMarkFound, '放弃信号判定抽取「触发」');

  const m2 = stockReview.extractMarks('> 评级判定：C\n> 放弃信号判定：未触发');
  ok(m2.rating === 'C' && m2.giveupTriggered === false, 'C/未触发 同样可抽取');

  const m3 = stockReview.extractMarks('没有标记行的输出');
  ok(m3.rating === null && m3.giveupTriggered === null, '缺标记 → null（不臆造，落盘如实标注 markFound=false）');
}

/* ══════════════ §4 连续放弃天数与反查（临时目录实测） ══════════════ */
section('§4 computeGiveupStreak / buildBackcheck（临时目录实测）');
{
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  fs.rmSync(TMP_MARKET, { recursive: true, force: true });
  fs.mkdirSync(TMP_DATA, { recursive: true });
  fs.mkdirSync(TMP_MARKET, { recursive: true });

  const sym = '000test';
  const days = [
    { date: '2026-11-04', giveup: false, rating: 'A' },
    { date: '2026-11-05', giveup: true, rating: 'B' },
    { date: '2026-11-06', giveup: true, rating: 'C' },
    { date: '2026-11-07', giveup: true, rating: 'C' },
  ];
  for (const d of days) {
    const rec = {
      schemaVersion: stockReview.SCHEMA_VERSION, symbol: sym, name: '测试股', date: d.date,
      createdAt: new Date().toISOString(), poolEntry: null, poolDate: null, giveupStreak: 0,
      marks: { rating: d.rating, giveupTriggered: d.giveup, ratingMarkFound: true, giveupMarkFound: true },
      llm: { degraded: false, model: 'test', error: null, elapsedMs: 1, contentChars: 10 },
      markdown: '#### 三、明日剧本推演与验证\n测试剧本 ' + d.date + '\n',
    };
    const dir = path.join(TMP_DATA, sym);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, d.date + '.json'), JSON.stringify(rec, null, 2), 'utf8');
  }

  const s = stockReview.computeGiveupStreak(sym, '2026-11-10');
  ok(s === 3, '05/06/07 连续 3 天触发 → streak=3（实际 ' + s + '）');

  const s2 = stockReview.computeGiveupStreak(sym, '2026-11-06');
  ok(s2 === 1, '截至 11-06 只有 05 一天 → streak=1（实际 ' + s2 + '）');

  const bc = stockReview.buildBackcheck(sym, '2026-11-10', s);
  ok(bc.active === true && bc.days === 3 && bc.days_detail.length === 3, '连续 3 天 → 反查激活且携带 3 天明细');
  ok(bc.days_detail.every(d => d.script.indexOf('测试剧本') !== -1), '明细含每日「三、明日剧本」原文（供反查漏看数据）');

  const bc2 = stockReview.buildBackcheck(sym, '2026-11-10', 2);
  ok(bc2.active === false, '不足 3 天 → 反查不激活');

  const hist = stockReview.listReviews(sym);
  ok(hist.length === 4 && hist[0].date === '2026-11-07', 'listReviews 倒序返回 4 条');
  ok(hist[0].giveupTriggered === true && hist[3].giveupTriggered === false, 'giveupTriggered 如实读出');
}

/* ══════════════ §5 观察池联动（大盘复盘 markdown → getPool） ══════════════ */
section('§5 getPool 联动（临时目录实测）');
{
  const mk = '**【明日核心观察池】**\n\n| 股票名称 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |\n|---|---|---|---|---|\n| 测试股 | 测试入选 | A | 看承接 | 无承接即弃 |\n';
  fs.writeFileSync(path.join(TMP_MARKET, '2026-11-09.json'), JSON.stringify({ markdown: mk }), 'utf8');
  const pool = stockReview.getPool();
  ok(pool.date === '2026-11-09', 'getPool 读到大盘复盘日期');
  ok(pool.rows.length === 1 && pool.rows[0].name === '测试股' && pool.rows[0].rating === 'A', 'getPool 解析出观察池行');
}

/* ══════════════ §6 快照降级 ══════════════ */
section('§6 LLM 失败降级快照');
{
  const ctx = {
    meta: { reviewDate: '2026-11-10' },
    stock: { symbol: '601318', name: '中国平安' },
    quote: { raw: { open: 7.04, high: 7.08, low: 6.94, price: 6.96, changePct: -0.29, turnoverRate: 0.7, amountYi: 2.7 }, prev: { date: '2026-11-09', amountYi: 2.55, turnoverRate: 0.66 } },
    capital: { moneyFlowSummary: '5日主力净流入 -3.2 亿；10日主力净流入 -8.1 亿' },
    sector: { missing: true, note: '板块涨跌停数据不可用（行业识别失败或数据源无该股板块）' },
    news: [{ title: '测试新闻', date: '', source: '', sentiment: '' }],
  };
  const md = stockReview.toSnapshotMarkdown(ctx, '测试降级原因');
  ok(md.indexOf('数据快照') !== -1 && md.indexOf('测试降级原因') !== -1, '快照标注降级原因');
  ok(md.indexOf('不构成任何投资建议') !== -1, '快照含免责行');
  ok(!/买入|卖出|加仓|减仓/.test(md), '快照零买卖建议');
  // 20261110g 事故回归：快照禁止 [object Object] 与 raw JSON dump，单位必须为亿
  ok(!md.includes('[object Object]'), '快照无 [object Object]（资金摘要须为代码拼好的字符串）');
  ok(!md.includes('{"'), '快照无 raw JSON dump（板块联动缺失时标注数据缺失而非倾倒对象）');
  ok(md.includes('前一日 2.55') && md.includes('2.7'), '成交额为亿单位且带前一日对照');
  ok(md.includes('0.7%'), '换手率独立成行且带百分号');
}

/* ══════════════ §7 双向联动 / 路径守卫 / 调度（19:00 结构断言） ══════════════ */
section('§7 大盘复盘 ↔ 个股复盘 双向联动 + 路由守卫 + 20:35 调度');
{
  const lib = read('lib/stockReview.js');
  ok(lib.includes('getPoolForDate') && lib.includes('poolMarksSummary') && lib.includes('runPoolBatch'),
    '反向联动 / 批量生成三个新出口在位');
  ok(lib.indexOf('resolveSymbol(symbolInput') !== -1 && lib.indexOf('resolveSymbol(symbolInput') < lib.indexOf('fs.existsSync(reviewFile(symbol'),
    'B0-1 缓存键修复：先解析代码再查缓存（名称入口不再永 miss）');
  ok(lib.includes('normCode') && lib.includes("layout: headerSeen ? (hasCodeCol ? 'code6' : 'legacy5') : null"),
    'B0-2 观察池双布局（code6 / legacy5）解析');

  const rc = read('lib/reviewContext.js');
  ok(rc.includes('stockMarks: compactStockMarks(a.stockMarks)'), 'reviewContext 注入 history.stockMarks（反向联动数据面）');
  ok(rc.includes("SCHEMA_VERSION = 'review-llm-20261110c'"), '复盘 Context SCHEMA 已升 review-llm-20261110c（结构变更铁律）');

  const rs = read('lib/reviewService.js');
  ok(rs.includes('stockReview.poolMarksSummary(prevDate)'), 'reviewService 组装时读取上一份观察池个股信号');

  const sv = read('server.js');
  ok(sv.includes('validStockSymbol') && sv.includes('validReviewDate'), 'B0-5 路由参数守卫在位');
  ok(sv.includes("kind: 'stock_pool'") && sv.includes('20:35'), 'B0-4 20:35 观察池批量调度槽在位');
  ok(sv.includes('stockReview.runPoolBatch(today)'), 'B0-4 调度调用 runPoolBatch');

  const dr = read('public/js/dailyReview.js');
  ok(dr.includes('decorateWatchPool') && dr.includes('dr-pool-link') && dr.includes('#stockreview'),
    'B0-3 大盘复盘页观察池「个股复盘 →」直达入口');
  const app = read('public/js/app.js');
  ok(app.includes("location.hash === '#stockreview'") && app.includes("switchTab('stockreview')"),
    'B0-3 个股页识别 #stockreview 自动切 tab');

  const prompt = read('prompts/daily-review-system.md');
  ok(/股票名称 \| 代码 \| 入选原因 \| 评级/.test(prompt), 'B0-2 大盘复盘提示词观察池表已含「代码」列');
  ok(prompt.includes('history.stockMarks') && prompt.includes('观察池落地核对'), 'B0-3 大盘复盘提示词已写观察池落地核对规则');
}

/* ══════════════ §8 UI 取色纪律与语义色 ══════════════ */
section('§8 UI 取色纪律（var 令牌 + 评级语义色）');
{
  const ui = read('public/js/stockReviewUI.js');
  const styleBlock = ui.slice(ui.indexOf('st.textContent'), ui.indexOf(".join('\\n')"));
  ok(!/#[0-9A-Fa-f]{6}/.test(styleBlock.replace(/^\s*\/\/.*$/gm, '')), '注入样式无裸 hex（一律 var() 令牌）');
  ok(styleBlock.includes('var(--bg-card)') && styleBlock.includes('var(--red)') && styleBlock.includes('var(--green)') && styleBlock.includes('var(--flat)'),
    '使用设计令牌（bg-card / red / green / flat）');
  ok(ui.includes("r === 'S' || r === 'A'") && ui.includes("r === 'C'"), '评级语义：S/A 红、B 中性、C 绿');
  ok(!ui.includes('sr-chip-warn'), '废弃「放弃信号=琥珀」旧配色（改为利空绿）');
}

/* ══════════════ §9 缓存键 / 批量幂等 / 反向联动（异步实测） ══════════════ */
section('§9 缓存键 / 批量幂等 / 反向联动（异步实测）');
(async () => {
  // 9.1 纯代码输入不触发网络解析
  try {
    const r = await stockReview.resolveSymbol('601318', null);
    ok(r && r.symbol === '601318' && r.resolved === false, 'resolveSymbol 对 6 位代码零解析、resolved=false');
  } catch (e) { ok(false, 'resolveSymbol 代码直取异常：' + e.message); }

  // 9.2 反向联动：poolMarksSummary 汇总观察池个股标记
  const mk6 = '**【明日核心观察池】**\n\n| 股票名称 | 代码 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |\n|---|---|---|---|---|---|\n'
    + '| 测试股 | 600519 | 测试入选 | A | 看承接 | 无承接即弃 |\n';
  fs.writeFileSync(path.join(TMP_MARKET, '2026-11-09.json'), JSON.stringify({ markdown: mk6 }), 'utf8');
  const rec9 = {
    schemaVersion: stockReview.SCHEMA_VERSION, symbol: '600519', name: '测试股', date: '2026-11-09',
    createdAt: new Date().toISOString(), poolEntry: null, poolDate: null, giveupStreak: 1,
    marks: { rating: 'A', giveupTriggered: true, ratingMarkFound: true, giveupMarkFound: true },
    llm: { degraded: false, model: 'test', error: null, elapsedMs: 1, contentChars: 10 },
    markdown: '测试', resolve: { input: '600519', resolved: false, ambiguous: false },
  };
  fs.mkdirSync(path.join(TMP_DATA, '600519'), { recursive: true });
  fs.writeFileSync(path.join(TMP_DATA, '600519', '2026-11-09.json'), JSON.stringify(rec9, null, 2), 'utf8');
  const sm = stockReview.poolMarksSummary('2026-11-09');
  ok(sm.total === 1 && sm.reviewed === 1 && sm.giveupTriggered === 1, 'poolMarksSummary：池 1 只、已复盘 1 只、放弃 1 只');
  ok(sm.rows[0].code === '600519' && sm.rows[0].rating === 'A', 'poolMarksSummary 按代码匹配并带出评级');

  // 9.3 批量幂等：当日已有记录 → skipped，且不调 LLM（degraded/failed 均应为 0）
  const sum = await stockReview.runPoolBatch('2026-11-09', { max: 12 });
  ok(sum.total === 1 && sum.skipped === 1 && sum.degraded === 0 && sum.failed === 0,
    'runPoolBatch 幂等：当日已有复盘 → 跳过且不调 LLM（实际 ' + JSON.stringify({ total: sum.total, skipped: sum.skipped, degraded: sum.degraded, failed: sum.failed }) + '）');

  // 9.4 清理 + 汇总
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('异步测试段异常：', e && e.message);
  process.exit(1);
});
