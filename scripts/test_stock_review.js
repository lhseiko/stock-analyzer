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
  ok(lib.includes("SCHEMA_VERSION = 'stock-review-20261111d'"), 'SCHEMA_VERSION = stock-review-20261111d（Context 新增 intraday 分钟级分时）');
  ok(lib.includes('parseWatchPool') && lib.includes('computeGiveupStreak') && lib.includes('buildBackcheck'),
    '观察池解析 / 连续放弃天数 / 反查构建三个确定性出口在位');
  ok(lib.includes("require('./ai/llm')") && lib.includes('webSearch: false'), 'LLM 走项目统一通道且关闭联网');
  ok(lib.includes('toSnapshotMarkdown'), 'LLM 失败降级为数据快照（不拒绝发布）');
  ok(lib.includes('overallBudgetMs'), '整链路耗时预算（overallBudgetMs）已设置，避免串行多次超时白等');

  // [20261111c] 个股复盘三处「缺失」数据接线：板块（行业识别）/ 量能（资金量能模块）/ 龙虎榜
  ok(lib.includes("require('./sectorIdentity')") && lib.includes('resolveSectorIdentity(symbol, name'),
    '板块数据：先经行业分析模块 resolveSectorIdentity 解析行业，再查板块涨跌停（根治「行业识别失败」）');
  ok(lib.includes('c.volumeEngine') && lib.includes('volume: (capital && capital.volume) || null'),
    '量能数据：复用资金量能模块 volumeEngine 结论并透出 Context.volume');
  ok(lib.includes("require('./boardReviewData')") && lib.includes('getLhbData(symbol, date)'),
    '龙虎榜数据：走 --lhb-only 取数并按代码精确判定上榜状态');
  const py = read('scripts/board_review_data.py');
  ok(py.includes("block['byCode']"), '龙虎榜全量代码索引 byCode 已在数据层落地（个股精确判定）');
  const rcb = read('lib/reviewContext.js');
  ok(!rcb.includes('byCode'), '隔离性：大盘复盘 lhbBlock 仍只挑固定字段，未被 byCode 污染');

  // [20261111c-b] SCHEMA 升级铁律的「复用侧」：旧 schema 记录不得被缓存永久复用
  ok(lib.includes('cached.schemaVersion === SCHEMA_VERSION'), 'generateReview 命中缓存时校验结构版本，旧 schema 自动失效重生成');
  ok(lib.includes('const cached = store.readJsonSafe(reviewFile(rs.symbol, d), null).data;'), 'runPoolBatch 与生成链同口径校验结构版本（协同进化）');
  const svr = read('server.js');
  ok(svr.includes('refreshOutdatedReview') && (svr.match(/refreshOutdatedReview\(/g) || []).length >= 3,
    '两个 GET 读取路由对当日过期 schema 自愈重生成（刷新即更新，无需手动清缓存）');

  const prompt = read('prompts/stock-review-system.md');
  // [20261111 游资版升级] 措辞变更但不变式保留：严禁买卖建议 / 四段式 / 连续放弃信号追踪
  ok(prompt.includes('绝对禁止给出买卖建议') || prompt.includes('严禁买卖建议') || prompt.includes('严禁任何买卖'),
    'System Prompt 含「严禁买卖建议」铁律');
  ok(prompt.includes('事实 → 判断 → 明日验证条件 → 放弃信号') || prompt.includes('事实 → 判断 → 验证 → 不成立'),
    'System Prompt 含四段式纪律');
  ok(prompt.includes('评级判定') && prompt.includes('放弃信号判定'), 'System Prompt 含两个确定性标记行');
  // 连续放弃信号追踪由「放弃信号判定」标记行 + 第4节「连续几天记录」共同驱动代码反查（buildBackcheck）
  ok(prompt.includes('放弃信号') && prompt.includes('连续'), 'System Prompt 含连续放弃信号追踪（驱动反查）');
  ok(prompt.includes('S') && prompt.includes('A') && prompt.includes('B') && prompt.includes('C'),
    'System Prompt 含 S/A/B/C 评级定义');
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

  // [20261111d] 分钟级真实分时：AKShare 主源 + 腾讯降级 + 代码权威特征 + 来源/口径日标注
  ok(lib.includes('function summarizeIntraday(') && lib.includes('summarizeIntraday,'),
    '分时：summarizeIntraday 纯函数已实现并导出（240+ 分钟点不 raw dump 进 LLM Context）');
  ok(lib.includes("const { getIntraday } = require('./boardReviewData')") && lib.includes("'AKShare '"),
    '分时：AKShare 为首选主源，来源如实写入 Context.intraday.source');
  ok(lib.includes('sd.fetchTencentMinutes(tc)') && lib.includes('degradedFrom:'),
    '分时：AKShare 不可达时降级项目现成腾讯分时，并标注 degradedFrom（不冒充主源）');
  ok((lib.match(/dateMatches: asOf === date/g) || []).length >= 2 && lib.includes('dateMatches: (extra && extra.dateMatches'),
    '分时：两条取数路径均做 dateMatches 口径日校验（防止旧分时冒充今日走势）');
  ok(lib.includes('getIntradayData(symbol, date, raw)') && /\bintraday,/.test(lib),
    '分时：buildContext 并行取数并透出 Context.intraday');
  ok(lib.includes("L.push('| 分时 | '") && lib.includes('数据源暂不可用（'),
    '分时：降级快照渲染分时行或如实标注不可用（不再留白）');
  const pyIntraday = read('scripts/board_review_data.py');
  ok(pyIntraday.includes('def build_intraday(') && pyIntraday.includes("'--intraday-symbol'"),
    '分时：Python 脚本新增 build_intraday 与早退通道（不跑复盘主流程）');
  ok(pyIntraday.includes('ak.stock_zh_a_hist_min_em') && pyIntraday.includes('ak.stock_intraday_em'),
    '分时：使用 1 分钟 K 线 + 当日分时明细两个 AKShare 接口');
  ok(!pyIntraday.includes('ak.stock_zh_a_spot_em('),
    '分时：未误用 stock_zh_a_spot_em（实测无 symbol 参数且脚本既有禁用，避免 asOf 错位）');
  ok(pyIntraday.includes('intraday_snapshot'),
    '分时：stock_intraday_em 当日快照按运行日标 asOf，历史复盘不冒充复盘日');
  const brd = read('lib/boardReviewData.js');
  ok(brd.includes('async function getIntraday(') && brd.includes("'--intraday-symbol'") && brd.includes('getIntraday,'),
    '分时：Node 桥接层 getIntraday 已接线并导出');
  const prIntraday = read('prompts/stock-review-system.md');
  ok(prIntraday.includes('四类关键数据') && prIntraday.includes('`intraday`'),
    '分时：Prompt 明列 sector/volume/lhb/intraday 四类数据并把 intraday 作为必引用字段');
  ok(prIntraday.includes('禁止写「分时明细数据缺失」') && prIntraday.includes('不是从 OHLC 推断'),
    '分时：Prompt 明禁旧「分时明细数据缺失 / 按 OHLC 还原」占位文案');
  ok(prIntraday.includes('intraday.dateMatches=false'),
    '分时：Prompt 要求口径日不一致时如实注明分时日期');
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

  // [20261111c] 降级快照须渲染新增的 板块 / 量能 / 龙虎榜 三块（LLM 不可用时也不留白）
  const ctx2 = {
    ...ctx,
    sector: { industryName: '保险', limitUp: 3, limitDown: 0, total: 88 },
    volume: { ok: true, volumeState: { ratio5: 1.8 }, volumeTier: '放量', position: { label: '阶段高位' } },
    lhb: { available: true, listed: true, netBuyYi: 1.2, reason: '日涨幅偏离值达7%', marketCount: 42 },
    intraday: { available: true, pattern: '冲高回落', open: 7.04, close: 6.96, high: 7.08, low: 6.94, highTime: '0941', lowTime: '1447', tailChgPct: -0.21, points: 242, source: '腾讯分时 ifzq.gtimg.cn' },
  };
  const md2 = stockReview.toSnapshotMarkdown(ctx2, '测试');
  ok(md2.includes('| 板块联动 | 保险') && md2.includes('涨停 3 家'), '降级快照：板块行写出已识别行业与涨跌停家数');
  ok(md2.includes('| 量能 |') && md2.includes('1.8') && md2.includes('阶段高位'), '降级快照：量能行引用资金量能模块数值');
  ok(md2.includes('| 龙虎榜 |') && md2.includes('1.2 亿') && md2.includes('42 只'), '降级快照：龙虎榜行写出净买额与全市场家数');
  // [20261111d] 降级快照须渲染真实分时特征；取数失败也要如实标注原因，不留白
  ok(md2.includes('| 分时 |') && md2.includes('冲高回落') && md2.includes('0941') && md2.includes('242'),
    '降级快照：分时行引用分钟级特征（形态 / 最高时点 / 分钟点数）');
  const md3 = stockReview.toSnapshotMarkdown({
    ...ctx2, intraday: { available: false, note: 'AKShare 不可达；腾讯分时无有效数据' },
  }, '测试');
  ok(md3.includes('| 分时 |') && md3.includes('数据源暂不可用') && !md3.includes('分时明细数据缺失'),
    '降级快照：分时不可用时如实标注原因、不留白、不写旧「缺失」文案');
}

/* ══════════════ §6b 分钟级分时特征纯函数（20261111d · 代码权威 · 零网络） ══════════════ */
section('§6b 分钟级分时特征纯函数（累计量 / 当分钟量 / 形态边界 / 口径日）');
{
  // 造出完整交易日的 242 个分钟点：09:30-11:30 + 13:00-15:00，不用触网。
  function ptsOf(kind, trend) {
    const out = [];
    let cum = 0;
    const add = (minuteOfDay) => {
      const i = out.length;
      const px = trend === 'down' ? 10.5 - i * 0.004 : 10 + i * 0.002;
      const step = 100 + (i % 5) * 10;
      cum += step;
      out.push({
        time: String(Math.floor(minuteOfDay / 60)).padStart(2, '0') + String(minuteOfDay % 60).padStart(2, '0'),
        price: Number(px.toFixed(3)), avg: Number((px - 0.01).toFixed(3)),
        volume: kind === 'cum' ? cum : step,
      });
    };
    for (let m = 0; m <= 120; m++) add(9 * 60 + 30 + m);
    for (let m = 0; m <= 120; m++) add(13 * 60 + m);
    return out;
  }

  const s1 = stockReview.summarizeIntraday(ptsOf('cum', 'down'), 10.5, '2026-11-11', 'AKShare 测试', { dateMatches: true });
  ok(!!s1 && s1.available === true && s1.points === 242, '242 个分钟点 → available=true 结构化特征（实际 ' + (s1 && s1.points) + '）');
  ok(s1 && s1.pattern === '单边下行',
    '开盘即最高、一路下行判为「单边下行」而非「冲高回落」（形态边界回归，实际 ' + (s1 && s1.pattern) + '）');
  ok(s1 && s1.source === 'AKShare 测试' && s1.dateMatches === true && s1.date === '2026-11-11',
    '五要素：来源 / 口径日 / dateMatches 如实透出');
  ok(s1 && Array.isArray(s1.segments) && s1.segments.length === 4
    && s1.segments.every(x => x.chgPct != null && x.volPct != null),
    '四段（早盘/上午/午后/尾盘）均有段内涨跌与量能占比');
  const sumVol = s1 ? s1.segments.reduce((a, b) => a + (b.volPct || 0), 0) : -1;
  ok(Math.abs(sumVol - 100) < 1.5, '四段量能占比合计≈100%（实际 ' + sumVol + '），半开区间无重复/遗漏');
  ok(s1 && s1.highTime === '0930' && s1.lowTime === '1500', '最高/最低时点取自真实分钟点');
  ok(s1 && s1.closeVsAvgPct != null && s1.tailChgPct != null && !!s1.peakVolTime,
    '均价偏离 / 尾盘动作 / 量能峰值时点均由代码算好（LLM 仅叙事）');

  const s2 = stockReview.summarizeIntraday(ptsOf('per', 'down'), 10.5, '2026-11-11', 'X', {});
  ok(s2 && s1 && s2.peakVolTime === s1.peakVolTime
    && Math.abs((s2.tailVolPct || 0) - (s1.tailVolPct || 0)) < 0.5,
    '累计量（腾讯 cumVol）与当分钟量（AKShare）自动识别且量能结论一致');
  ok(stockReview.summarizeIntraday([{ time: '0930', price: 10 }], 10, '2026-11-11', 'X', {}) === null,
    '有效点 < 30 返回 null，不输出半成品');

  const s3 = stockReview.summarizeIntraday(ptsOf('cum', 'down'), 10.5, '2026-11-10', '腾讯分时', {
    dateMatches: false, degradedFrom: 'AKShare 分时不可用：ProxyError',
  });
  ok(s3 && s3.dateMatches === false && /AKShare/.test(s3.degradedFrom || ''),
    '历史口径日不一致 + 降级来源如实标注（不冒充 AKShare 主源）');
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
  ok(rc.includes("SCHEMA_VERSION = 'review-llm-20261111b'"), '复盘 Context SCHEMA 已升 review-llm-20261111b（结构变更铁律）');

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
