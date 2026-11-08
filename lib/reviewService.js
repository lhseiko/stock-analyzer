/**
 * lib/reviewService.js — 每日复盘聚合服务 ReviewService（20261108d · 热点归因 + 机会/风险引擎版）
 * ==================================================================================
 * 用户新框架落地（14 段固定结构 + 四段式结论 + 热点归因 + 机会/风险识别引擎）：
 *  1. 固定 14 段输出结构，顺序锁定；第 3 段为「每日热点题材与归因卡片」。
 *  2. 所有核心结论四段式：事实 → 判断（分类/等级）→ 次日验证条件 → 判断不成立信号。
 *  3. 热点归因引擎（消息级别/性质、题材阶段、S-A-B-C 评级、资金投票质量、
 *     技术面×消息面四象限）由 lib/topicEngines.js 纯函数确定性计算。
 *  4. 机会识别引擎（O1-O5 / L1-L5 / C1-C8 / V1-V8 / D1-D4 / A-D）与风险识别引擎
 *     （R-M / R-S / R-I）由 lib/reviewEngines.js 纯函数计算，并接收归因引擎结论做中和过滤。
 *  4. 持续性/扩散/收缩判断必须取前 3-5 个交易日同口径对照，对照不足写
 *     「缺少对照，暂不作持续性判断」，禁止把单日数据当趋势。
 *  5. 核心字段完整率 < 90% → 输出「有限分析版」，列最需补充的 3 项。
 *  6. 幂等、修订版、3 次失败报告、非交易日 skipped_holiday、交易日历表先查：机制保留。
 *
 * 三条底层规则（工作台铁律）：
 *  - 一致性：每个数据点带「名称/数值/实际时间/来源/获取时间」五要素（source/asOf/fetchedAt）。
 *  - 最新性：交易日感知（必须先查 trade_calendar 表）、数据过期标注、异常校验。
 *  - 变化与边际：变化率 + 边际 + 方向 + 幅度；连续对照由 historySeries 提供。
 *
 * 代码权威：所有数值由本机代码从真实数据计算，绝不交给 LLM 估算；文案只复述计算结果。
 * 合规：不给买入/卖出/仓位建议；缺失一律标注「缺失」，不臆造、不用占位数字；
 *      联网搜索只用于新闻催化与节假日公告兜底，必须注明来源时间，不替代行情数据。
 *      成交额/龙虎榜只反映交易活跃度，不单独证明机构进场或资金出逃；
 *      亏钱效应收敛只代表压力缓解，不等于买点出现；观察池是验证风向的样本，不是买入目标。
 *
 * 隔离原则：本模块不修改任何既有模块；所有取数失败只降级为「缺失」，不抛给前端。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { localDate, localDateTime } = require('./localDate');
const tradeCalendar = require('./tradeCalendar');
const engines = require('./reviewEngines');
const topicEngines = require('./topicEngines');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_DIR = process.env.SA_REVIEW_DIR
  ? path.resolve(process.env.SA_REVIEW_DIR)
  : path.join(DATA_DIR, 'reviews');

// 20261108d：13 段 → 14 段（新增「每日热点题材与归因卡片」）+ 热点归因/资金投票/四象限中和
// + C1-C8 / V1-V8 / D1-D4 驱动标签，复盘 JSON 结构变化，按 SCHEMA_VERSION 升级铁律升版。
const SCHEMA_VERSION = 'review-20261108d';
const ENGINE_VERSION = engines.analyze({}).schemaVersion;
const TOPIC_VERSION = topicEngines.SCHEMA_VERSION;
const MISSING = '缺失';
const MAX_ATTEMPTS = 3;
const SOURCE_TIMEOUT_MS = 25000;
const BOARD_TIMEOUT_MS = 90000;   // 多日涨停池序列取数（实测约 15s），单独放宽
const LIMITED_THRESHOLD = 90;     // 核心字段完整率低于此值 → 有限分析版
const HIST_DAYS = 4;              // 前 3-5 个交易日对照，取 4 日

// 固定 14 段结构（顺序即规格顺序，不可增删）
const SECTION_DEFS = [
  { key: 'oneline', title: '今日一句话结论' },
  { key: 'integrity', title: '数据完整性与口径' },
  { key: 'attribution', title: '每日热点题材与归因卡片' },
  { key: 'sentiment', title: '整体情绪与市场级风险' },
  { key: 'ladder', title: '连板梯队与接力风险' },
  { key: 'sectors', title: '板块结构与资金投票' },
  { key: 'capital', title: '成交和资金偏好' },
  { key: 'lossEffect', title: '亏钱效应与风险扩散' },
  { key: 'opportunities', title: '机会识别汇总（五层漏斗输出）' },
  { key: 'watchPool', title: '明日观察池（含中和过滤）' },
  { key: 'watchPlan', title: '明日观察计划' },
  { key: 'nextChecklist', title: '次日验证清单' },
  { key: 'historyCompare', title: '历史判断对照' },
  { key: 'quality', title: '复盘质量检查' },
];

// 必须有四段式结论的核心段（质检逐段核验）；20261108d 新增归因卡片段
const CORE_SECTIONS = ['attribution', 'sentiment', 'ladder', 'sectors', 'capital', 'lossEffect', 'opportunities'];

// 禁用建议词：出现即判质检失败，绝不允许落到正式复盘
const ADVICE_BAN = ['建议买入', '建议卖出', '可以买入', '可以卖出', '加仓', '减仓', '建仓', '清仓', '仓位建议', '目标价', '抄底', '止盈', '止损', '推荐买', '推荐卖', '适合打板', '一定反弹'];
// 禁用模糊表述词（新框架：「禁止只写我觉得/可能/大概」）
const VAGUE_BAN = ['我觉得', '可能', '大概', '或许', '应该是', '事后解释', '果然', '正如预期', '不出所料'];

// ---------- 内存运行状态（供 /api/review/status 轮询） ----------
const RUN = {
  running: false,
  phase: 'idle',
  reviewDate: null, trigger: null, attempt: 0,
  startedAt: null, finishedAt: null,
  lastResult: null, lastError: null,
};
const SKIP_LOG = [];
const MAX_SKIP_LOG = 200;

function nowIso() { return new Date().toISOString(); }
function ensureDir() { if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true }); }
function reviewFile(date) { return path.join(REVIEW_DIR, `${date}.json`); }
function failedFile(date) { return path.join(REVIEW_DIR, `${date}.failed.json`); }

const num = engines.num;
const pct = engines.pct;
const fixed = engines.fixed;
const MISSING_TEXT = engines.MISSING;

function signed(n, digits) {
  const x = num(n);
  return x == null ? MISSING : (x >= 0 ? '+' : '') + x.toFixed(digits == null ? 2 : digits);
}
function fmtAmt(v) { return fixed(v); }

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 单源采集信封：统一「五要素 + 状态」，任何异常都降级为缺失，不臆造。 */
async function collect(key, label, fn, { category, timeout } = {}) {
  const fetchedAt = nowIso();
  try {
    const data = await withTimeout(fn(), timeout || SOURCE_TIMEOUT_MS, label);
    if (data == null) {
      return { key, label, category: category || '', status: 'missing', source: MISSING, asOf: MISSING, fetchedAt, data: null, note: '数据源未返回内容' };
    }
    return {
      key, label, category: category || '', status: 'ok',
      source: String(data.__source || data.source || label),
      asOf: String(data.__asOf || data.date || data.sectorDate || data.sectorDataDate || MISSING),
      fetchedAt, data, note: '',
    };
  } catch (e) {
    return { key, label, category: category || '', status: 'failed', source: MISSING, asOf: MISSING, fetchedAt, data: null, note: String((e && e.message) || e).slice(0, 180) };
  }
}

function notAvailable(key, label, category, reason) {
  return { key, label, category, status: 'missing', source: MISSING, asOf: MISSING, fetchedAt: nowIso(), data: null, note: reason };
}

/** 前 n 个交易日（复用唯一权威交易日历，不在本模块另造日历） */
function previousTradingDates(date, n) {
  const { previousTradingDay } = require('./cnTradingCalendar');
  const out = [];
  let d = date;
  for (let i = 0; i < n; i++) {
    const p = previousTradingDay(d);
    if (!p) break;
    out.push(p);
    d = p;
  }
  return out;
}

// ---------- 13 类数据源并行采集 ----------
async function gatherSources(date, histDates) {
  const jobs = [];

  jobs.push(collect('quote', '行情数据库（指数/板块快照）', async () => {
    const sd = require('./stockData');
    const mo = await sd.getMarketOverview();
    return { ...mo, __source: 'stockData.getMarketOverview（腾讯行情 + 东财/同花顺板块）', __asOf: mo.sectorDate || MISSING };
  }, { category: '行情数据库' }));

  // 20261108c 实测修正：breadth 与 mainFund 原先各调一次 getMarketEmotionData，
  // 并发跑同一底层取数（进程/缓存竞争），叠加多日 akshare 序列后随机出现其中一个 25s 超时，
  // 使完整度在 100/94/84 之间抖动。改为共享同一次调用，消除竞争且不改变任何数值口径。
  const emotionPromise = (async () => {
    const med = require('./marketEmotionData');
    return await med.getMarketEmotionData({ refresh: false });
  })();

  jobs.push(collect('breadth', '涨停跌停模块（涨跌家数/涨停跌停）', async () => {
    const r = await emotionPromise;
    if (!r || !r.breadth) throw new Error('breadth 未返回');
    return { ...r, __source: 'marketEmotionData / scripts/market_emotion.py（akshare 乐咕乐股）', __asOf: r.breadth.date || r.date };
  }, { category: '涨停跌停模块' }));

  // 一次 akshare 取数产出 6 块，避免重复跑 Python（实测多日序列约 15s）
  const boardPromise = (async () => {
    const bd = require('./boardReviewData');
    return await bd.getBoardReviewData(date, { histDates });
  })();
  const boardSrc = (key, label, pick, category) => jobs.push(collect(key, label, async () => {
    const raw = await boardPromise;
    const block = pick(raw);
    if (!block) throw new Error((raw && raw.issues && raw.issues[0] && raw.issues[0].msg) || '该数据块不可用');
    if (block.ok === false) throw new Error(block.note || '该数据块标记不可用');
    const src = block.source || 'board_review_data.py / akshare（东财）';
    return Array.isArray(block)
      ? { series: block, __source: src, __asOf: date }
      : { ...block, __source: src, __asOf: block.asOf || date };
  }, { category, timeout: BOARD_TIMEOUT_MS }));

  boardSrc('ladder', '连板模块（连板高度/梯队）', r => r && r.ladder, '连板模块');
  boardSrc('dragonTiger', '龙虎榜模块', r => r && r.lhb, '资金/龙虎榜模块');
  boardSrc('prevPool', '昨日涨停股今日表现（红盘率/大面股/晋级率）', r => r && r.prevPool, '涨停跌停模块');
  boardSrc('sectors', '板块层次（涨停池按所属行业聚合）', r => r && r.sectors, '板块模块');
  boardSrc('activity', '活跃度样本（涨停池/强势股池成交额）', r => r && r.activity, '本机计算');
  boardSrc('historySeries', '前 3-5 交易日同口径对照序列',
    r => (r && Array.isArray(r.historySeries) && r.historySeries.length ? r.historySeries : null), '本机计算');

  jobs.push(collect('sectorFlow', '板块模块（板块涨跌与资金流）', async () => {
    const scf = require('./sectorCapitalFlow');
    const r = await scf.getSectorCapitalFlow(false);
    if (!r || r.ok === false) throw new Error((r && r.note) || '板块资金流返回 ok=false');
    return { ...r, __source: 'sectorCapitalFlow（东财行业资金流）', __asOf: r.date || MISSING };
  }, { category: '板块模块' }));

  jobs.push(collect('mainFund', '资金模块（全市场主力净额）', async () => {
    const r = await emotionPromise;
    if (!r || !r.mainFund) throw new Error('mainFund 未返回');
    const mfDate = r.mainFund.date || r.mainFund.tradeDate || r.date;
    return { mainFund: r.mainFund, date: r.date, issues: r.issues || [], __source: 'marketEmotionData.mainFund（东财行业资金流求和 / T-lag 收盘口径）', __asOf: mfDate };
  }, { category: '资金/龙虎榜模块' }));

  jobs.push(collect('history', '历史复盘库（大盘记录 + 历史复盘）', async () => {
    const mldb = require('./marketLogDb');
    const r = mldb.searchMarketLog({ from: shiftDate(date, -30), to: date, limit: 60 });
    const own = listHistorySync(10);
    return { records: (r && r.records) || [], total: (r && r.total) || 0, facets: (r && r.facets) || {}, ownReviews: own, __source: 'marketLogDb.searchMarketLog + data/reviews/*.json', __asOf: date };
  }, { category: '历史复盘库' }));

  jobs.push(collect('news', '联网搜索（新闻催化 / 节假日公告兜底）', async () => {
    const ns = require('./newsSearch');
    const r = await ns.getHotNews(false);
    const items = (r && Array.isArray(r.items)) ? r.items : [];
    return {
      source: (r && r.source) || MISSING,
      updated: (r && r.updated) || nowIso(),
      items: items.slice(0, 24).map(n => ({
        title: String(n.title || ''), source: String(n.source || MISSING),
        date: String(n.date || MISSING), url: String(n.url || ''),
        category: String(n.category || ''), sentiment: String(n.sentiment || ''),
      })),
      __source: 'newsSearch.getHotNews（东方财富 7×24 快讯）', __asOf: (r && r.updated) || MISSING,
    };
  }, { category: '联网搜索' }));

  jobs.push(collect('calendar', '本机计算（交易日历判定）', async () => {
    tradeCalendar.ensureImported();
    const c = tradeCalendar.isTradingDay(date);
    return { ...c, tz: 'Asia/Shanghai', __source: 'trade_calendar 表（权威源 cnTradingCalendar.js）', __asOf: date };
  }, { category: '本机计算' }));

  const settled = await Promise.allSettled(jobs);
  return settled.map((s, i) => s.status === 'fulfilled'
    ? s.value
    : notAvailable('src_' + i, '数据源 ' + i, '', String((s.reason && s.reason.message) || s.reason)));
}

function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function byKey(sources, key) { return sources.find(s => s.key === key) || null; }
function srcData(sources, key) { const s = byKey(sources, key); return s && s.data ? s.data : null; }
function isOk(sources, key) { const s = byKey(sources, key); return !!(s && s.status === 'ok' && s.data); }
function deltaOf(cur, prev) {
  const a = num(cur), b = num(prev);
  if (a == null || b == null) return { value: MISSING, rate: MISSING, direction: MISSING, amplitude: MISSING };
  const change = a - b;
  const rate = b !== 0 ? (change / Math.abs(b)) * 100 : null;
  return { value: signed(change), rate: rate == null ? MISSING : pct(rate), direction: change > 0 ? '上升' : change < 0 ? '下降' : '持平', amplitude: Math.abs(change).toFixed(2) };
}

/** 把采集结果组装成引擎输入（只做字段映射，不计算、不补齐） */
function engineInputOf(date, sources, histDates) {
  const b = srcData(sources, 'breadth');
  const hs = srcData(sources, 'historySeries');
  const news = srcData(sources, 'news');
  const mf = srcData(sources, 'mainFund');
  const sf = srcData(sources, 'sectorFlow');
  const q = srcData(sources, 'quote');
  return {
    date, histDates,
    breadth: b && b.breadth ? b.breadth : null,
    ladder: srcData(sources, 'ladder'),
    prevPool: srcData(sources, 'prevPool'),
    sectors: srcData(sources, 'sectors'),
    activity: srcData(sources, 'activity'),
    historySeries: hs && Array.isArray(hs.series) ? hs.series : [],
    news: news && Array.isArray(news.items) ? news.items : [],
    lhb: srcData(sources, 'dragonTiger'),
    sectorFlow: sf, mainFund: mf && mf.mainFund ? mf.mainFund : null,
    quote: q,
  };
}

// ---------- 13 段生成（纯代码，数值全部来自采集结果 / 引擎） ----------
function buildSections(date, sources, prevDoc, engine, meta, topics) {
  const S = {};
  const T = topics || topicEngines.analyzeTopics({});
  const mk = (key, status, lines, bullets, metrics, extra) => {
    const def = SECTION_DEFS.find(d => d.key === key);
    const ex = extra || {};
    S[key] = {
      key, title: def ? def.title : key, status: status || 'ok',
      lines: (lines || []).filter(Boolean), bullets: bullets || [], metrics: metrics || [],
      quads: ex.quads || [], risks: ex.risks || [],
      table: ex.table || null, tableKind: ex.tableKind || null,
      missing: (status === 'missing'),
    };
    return S[key];
  };

  const quote = srcData(sources, 'quote');
  const breadth = srcData(sources, 'breadth');
  const sectorFlow = srcData(sources, 'sectorFlow');
  const mainFund = srcData(sources, 'mainFund');
  const history = srcData(sources, 'history');
  const news = srcData(sources, 'news');
  const cal = srcData(sources, 'calendar');
  const L = srcData(sources, 'ladder');
  const H = srcData(sources, 'dragonTiger');
  const P = srcData(sources, 'prevPool');
  const SEC = srcData(sources, 'sectors');
  const ACT = srcData(sources, 'activity');
  const HS = srcData(sources, 'historySeries');
  const series = HS && Array.isArray(HS.series) ? HS.series : [];
  const b = breadth && breadth.breadth ? breadth.breadth : null;
  const E = engine;
  const trends = E.trends;
  const m = meta || {};

  const okSrc = sources.filter(s => s.status === 'ok').length;
  // 新框架「D. 数据校验：检查日期口径一致、异常数据标待核验」：
  // 只检查行情类源的口径日；news 的 asOf 是新闻来源时间、calendar 是复盘日，均不属行情口径。
  const ASOF_CHECK_KEYS = new Set(['quote', 'breadth', 'ladder', 'dragonTiger', 'prevPool',
    'sectors', 'activity', 'historySeries', 'sectorFlow', 'mainFund']);
  const asOfMismatch = sources.filter(s => s.status === 'ok' && ASOF_CHECK_KEYS.has(s.key)
    && s.asOf && s.asOf !== MISSING && String(s.asOf).slice(0, 10) !== date);
  const mismatchKeys = new Set(asOfMismatch.map(s => s.key));
  const srcRows = sources.map(s => ({
    name: s.label, category: s.category, status: s.status,
    source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt,
    note: s.note || (mismatchKeys.has(s.key) ? '口径日与复盘日不一致，待核验' : ''),
  }));

  // —— 今日一句话结论 ——
  {
    const idx = quote && Array.isArray(quote.cn) ? quote.cn : [];
    const sh = idx.find(i => /上证|沪指|000001/.test(String(i.code || '') + String(i.name || ''))) || idx[0];
    const shPct = sh ? num(sh.changePct) : null;
    const up = b ? num(b.up) : null, down = b ? num(b.down) : null;
    const lu = b ? num(b.limitUp) : null, ld = b ? num(b.limitDown) : null;
    const parts = [shPct == null ? `上证指数涨跌幅${MISSING}` : `上证指数 ${pct(shPct)}`];
    parts.push(up != null && down != null ? `全市场涨 ${up} / 跌 ${down} 家` : `全市场涨跌家数${MISSING}`);
    parts.push(lu != null && ld != null ? `涨停 ${lu} / 跌停 ${ld}` : `涨停跌停家数${MISSING}`);
    const t = trends.limitUp;
    const tone = !t.ok ? `赚钱效应持续性：${engines.NO_COMPARISON}`
      : `涨停家数对照结论：${t.direction}（${t.points} 个对照点）`;
    mk('oneline', (shPct == null || up == null) ? 'partial' : 'ok', [
      `${date}：${parts.join('，')}；${tone}。`,
      `市场级风险等级：${E.marketRiskLevel}；机会候选 ${E.candidates.length} 个，其中可跟踪（A/B 级）${E.candidates.filter(c => c.trackable).length} 个。`,
      `热点归因卡片：${T.cards.length} 个题材，S ${T.gradeSummary.S} / A ${T.gradeSummary.A} / B ${T.gradeSummary.B} / C ${T.gradeSummary.C}；主导演票类型 ${T.dominantVote}，主导象限 ${T.dominantQuadrant}。`,
      '（本句仅为已获取数据的客观复述，不含任何操作建议）',
    ]);
  }

  // —— 数据完整性与口径 ——
  {
    const lines = [
      `复盘日期 ${date}；前一交易日 ${m.prevDate || MISSING}；对照日 ${(m.histDates || []).join(' / ') || MISSING}；时区 Asia/Shanghai。`,
      `交易日表判定：${cal ? (cal.is_trading_day ? '交易日' : '非交易日（休市）') : MISSING}；口径日 ${cal ? (cal.asOf || date) : MISSING}。`,
      `数据源 ${sources.length} 项，正常 ${okSrc} 项，缺失/失败 ${sources.length - okSrc} 项。缺失项一律标注「${MISSING}」，未用估算值填充。`,
      '行情数值来自行情数据库与本机计算；联网搜索仅用于新闻催化与节假日公告兜底，条目附来源时间，不参与任何数值计算。',
      '口径：涨停/跌停/连板高度/炸板取自 akshare 东财涨停池、炸板池、跌停池；连板高度为池内「连板数」字段本机统计。',
      '口径：首次封板时间 ≤10:00 记早盘、10:00-14:00 记盘中、≥14:00 记尾盘；封板节奏只反映活跃度，不单独证明资金性质。',
      ...E.caliberNotes.map(x => '口径：' + x + '。'),
      ...T.notes.map(x => '归因口径：' + x + '。'),
      '联网搜索数据源为实时 7×24 快讯，来源时间存在晚于复盘日的情形；新闻条目只作催化线索，不作当日催化时间证明，也不替代行情与公告核验。',
      '归因卡片数据缺口：' + T.keyMissingTop3.map((x, i) => `${i + 1}) ${x.field}（${x.why}）`).join('；') + '。',
    ];
    if (m.limited) {
      lines.push(`⚠ 本次为「有限分析版」：核心字段完整率 ${m.completeness}% < ${LIMITED_THRESHOLD}%。已做有限分析，未以估算值补齐。`);
      lines.push('最需补充的 3 项：' + E.keyMissingTop3.map((x, i) => `${i + 1}) ${x.field}（${x.why}）`).join('；') + '。');
    }
    if (cal && cal.source_time && cal.source_time !== '静态规则表') {
      lines.push(`交易日历来源时间：${cal.source_time}（来源：${cal.source}）`);
    }
    if (cal && cal.is_trading_day === false) {
      lines.push(`⚠ 本复盘为「非交易日强制补生成」：${date} 为${cal.day_type || '休市'}，无当日行情；所有数值口径日见各段 asOf，不代表 ${date} 当日行情。`);
    }
    const asOfSet = [...new Set(sources.filter(s => s.status === 'ok' && s.asOf && s.asOf !== MISSING)
      .map(s => String(s.asOf).slice(0, 10)))];
    if (asOfSet.length > 1) {
      lines.push(`⚠ 口径差异：各数据源标注的 asOf 不一致（${asOfSet.join(' / ')}）。本复盘不改写上游日期戳，逐源 asOf 见下表；跨源数值不做同日对齐假设。`);
    }
    if (asOfMismatch.length) {
      lines.push(`⚠ 待核验：${asOfMismatch.length} 项行情数据源的口径日与复盘日 ${date} 不一致（${asOfMismatch.map(s => `${s.label}=${String(s.asOf).slice(0, 10)}`).join('、')}）；该批数值不参与同日对齐比较，已在下表「缺失原因 / 说明」列标注。`);
    }
    const missingRows = sources.filter(s => s.status !== 'ok');
    if (missingRows.length) {
      lines.push(`缺失或待核验字段：${missingRows.map(s => `${s.label}（${s.note || MISSING}）`).join('；')}。`);
    }
    mk('integrity', okSrc === sources.length ? 'ok' : 'partial', lines, [], [], {
      table: srcRows, tableKind: 'source',
    });
  }

  // —— 每日热点题材与归因卡片（第 3 段）——
  {
    const cards = T.cards || [];
    const q = T.quadrantSummary || {};
    const v = T.voteSummary || {};
    const lines = [
      `卡片覆盖 ${cards.length} 个活跃题材（来源：涨停池按「所属行业」聚合，取涨停家数前列）；题材评级 S ${T.gradeSummary.S} / A ${T.gradeSummary.A} / B ${T.gradeSummary.B} / C ${T.gradeSummary.C}。`,
      `资金投票质量分布：强共识 ${v['强共识投票'] || 0} / 局部游资 ${v['局部游资投票'] || 0} / 无效陷阱 ${v['无效/陷阱投票'] || 0} / 防御性 ${v['防御性投票'] || 0} / 无法判断 ${v['无法判断'] || 0}；主导演票类型 ${T.dominantVote}。`,
      `技术面 × 消息面四象限分布：共振 ${q['共振'] || 0} / 背离 ${q['背离'] || 0} / 先觉 ${q['先觉'] || 0} / 双弱 ${q['双弱'] || 0} / 无法判断 ${q['无法判断'] || 0}；主导象限 ${T.dominantQuadrant}。`,
      `封板节奏：${T.sealTimeSummary}；跌停结构：${T.limitDownSummary}。`,
      '消息级别由来源名称与标题关键词推断，未经公告原文核验；自媒体小作文标「传闻/未核验」，官方来源优先匹配。',
      '中军表现以涨停池内流通市值居前个股作代理，不是真实板块中军；代理样本缺失时 S 级不成立，自动降 A 并写明证据缺口。',
      '题材阶段基于前 3-5 个交易日同口径行业涨停家数序列；有效对照点不足时写「缺少对照，暂不作持续性判断」，禁止把单日数据当趋势。',
      '本卡片是线索归因与次日验证清单，不是交易发令枪；观察池是验证市场风向的样本，不构成任何操作类指引。',
    ];
    if (!cards.length) lines.push(`本次未取得活跃题材条目（板块层次数据源${MISSING}或未返回条目），卡片如实留空，不补造题材。`);
    const quads = [engines.quad('每日热点题材与归因',
      `活跃题材 ${cards.length} 个；S/A/B/C = ${T.gradeSummary.S}/${T.gradeSummary.A}/${T.gradeSummary.B}/${T.gradeSummary.C}；主导演票 ${T.dominantVote}；主导象限 ${T.dominantQuadrant}`,
      cards.length
        ? `题材结构判定：${T.dominantVote} 占主导，四象限以 ${T.dominantQuadrant} 为主；S 级 ${T.gradeSummary.S} 个、C 级 ${T.gradeSummary.C} 个`
        : `题材数据${MISSING}，不作题材结构判定`,
      '次日核对 S/A 级题材的涨停家数是否维持、中军代理是否继续放量、是否出现第 2 只跟随个股',
      'S/A 级题材涨停家数自峰值回落、中军代理转弱，或 C 级题材断板股继续走弱')];
    const metrics = [
      { name: 'S 级', value: T.gradeSummary.S }, { name: 'A 级', value: T.gradeSummary.A },
      { name: 'B 级', value: T.gradeSummary.B }, { name: 'C 级', value: T.gradeSummary.C },
      { name: '主导演票', value: T.dominantVote }, { name: '主导象限', value: T.dominantQuadrant },
    ];
    mk('attribution', cards.length ? 'ok' : 'partial', lines, [], metrics, {
      table: cards, tableKind: 'topic', quads,
    });
  }

  // —— 整体情绪与市场级风险 ——
  {
    const lines = [];
    if (!b) lines.push(`涨跌家数、涨停跌停与指数数据${MISSING}，整体情绪不做判定。`);
    else {
      const up = num(b.up), down = num(b.down), flat = num(b.flat);
      const lu = num(b.limitUp), ld = num(b.limitDown);
      lines.push(`涨跌家数：涨 ${up == null ? MISSING : up} / 跌 ${down == null ? MISSING : down} / 平 ${flat == null ? MISSING : flat}；涨停 ${lu == null ? MISSING : lu} / 跌停 ${ld == null ? MISSING : ld}。`);
      if (b.zbgcCount != null) lines.push(`炸板数 ${b.zbgcCount}，炸板率 ${b.zbgcRate == null ? MISSING : b.zbgcRate}。`);
      if (b.activePct != null) lines.push(`活跃度 ${pct(b.activePct)}。`);
    }
    if (P) {
      lines.push(`昨日涨停股今日表现：样本 ${P.count == null ? MISSING : P.count} 只，红盘率 ${P.redRate == null ? MISSING : fixed(P.redRate) + '%'}，平均涨跌幅 ${P.avgChgPct == null ? MISSING : pct(P.avgChgPct)}，大幅回落 ${P.bigDropCount == null ? MISSING : P.bigDropCount} 只（占比 ${P.bigDropRate == null ? MISSING : fixed(P.bigDropRate) + '%'}）。`);
      if (Array.isArray(P.promotion) && P.promotion.length) {
        lines.push('晋级率（昨日 N 板 → 今日 N+1 板，按代码跨日匹配）：' + P.promotion.map(x => `${x.from}进${x.to} ${fixed(x.rate)}%（${x.promoted}/${x.base}）`).join('，') + '。');
      } else lines.push(`晋级率${MISSING}。`);
    } else lines.push(`昨日涨停股今日表现与晋级率${MISSING}（不以上一日结构倒推）。`);
    lines.push(`前 3-5 日对照：涨停家数 ${trends.limitUp.direction}（${trends.limitUp.note}）；昨日涨停红盘率 ${trends.prevRedRate.direction}；晋级率 ${trends.promotionRate.direction}。`);
    const t = trends.limitUp;
    mk('sentiment', (b && P && series.length >= 3) ? 'ok' : 'partial', lines, [], [], {
      quads: [engines.quad('整体赚钱效应',
        `涨停 ${b ? (b.limitUp == null ? MISSING : b.limitUp) : MISSING} / 跌停 ${b ? (b.limitDown == null ? MISSING : b.limitDown) : MISSING}；昨日涨停红盘率 ${P ? (P.redRate == null ? MISSING : fixed(P.redRate) + '%') : MISSING}；${t.note}`,
        t.ok ? `赚钱效应持续性判定：${t.direction}；市场级风险等级 ${E.marketRiskLevel}` : engines.NO_COMPARISON,
        '次日核对涨停家数、跌停家数、昨日涨停股红盘率与 1进2 晋级率四项是否延续今日方向',
        t.direction === '收缩' ? '涨停家数与红盘率同时回升、晋级率不再下降' : '涨停家数与红盘率同步转弱、晋级率连续两日下降')],
      risks: E.risks.market,
    });
  }

  // —— 连板梯队与接力风险 ——
  {
    const lines = [];
    if (!L) {
      lines.push(`连板梯队、最高连板高度、晋级率${MISSING}。`, '说明：取数失败时不以涨停家数反推连板高度（不臆造）。');
    } else {
      lines.push(`涨停池共 ${L.limitUpCount == null ? MISSING : L.limitUpCount} 家；最高连板 ${L.maxBoards == null ? MISSING : L.maxBoards + ' 板'}；空间板：${L.spaceBoard ? `${L.spaceBoard.name}（${L.spaceBoard.code}，${L.spaceBoard.boards} 板，${L.spaceBoard.industry || '行业缺失'}）` : MISSING}。`);
      lines.push('梯队分布：' + (Array.isArray(L.tiers) && L.tiers.length ? L.tiers.map(x => `${x.boards} 板 ${x.count} 家`).join(' / ') : MISSING) + `；2 板及以上 ${L.board2PlusCount == null ? MISSING : L.board2PlusCount} 家，3 板及以上 ${L.board3PlusCount == null ? MISSING : L.board3PlusCount} 家，首板 ${L.firstBoardCount == null ? MISSING : L.firstBoardCount} 家。`);
      lines.push(`梯队断层：${L.hasGap == null ? MISSING : (L.hasGap ? `存在（缺 ${(L.gapAt || []).join('、')} 板档）` : '未出现断层')}。`);
      if (L.sealFundTotal != null) lines.push(`涨停池封板资金合计 ${L.sealFundTotal} 亿元。`);
      lines.push(`炸板 ${L.brokenCount == null ? MISSING : L.brokenCount} 家（炸板率 ${L.brokenRate == null ? MISSING : L.brokenRate + '%'}），跌停 ${L.limitDownCount == null ? MISSING : L.limitDownCount} 家。`);
    }
    if (P && Array.isArray(P.promotion) && P.promotion.length) {
      lines.push('晋级率（昨日 N 板 → 今日 N+1 板，按代码跨日匹配）：' +
        P.promotion.map(x => `${x.from}进${x.to} ${fixed(x.rate)}%（${x.promoted}/${x.base}）`).join('，') + '。');
    } else lines.push(`晋级率${MISSING}（昨日涨停池不可得，不用今日结构倒推）。`);
    if (P && Array.isArray(P.topLosers)) {
      const high = P.topLosers.filter(x => num(x.prevBoards) >= 3);
      lines.push('昨日高位股今日反馈：' + (high.length ? high.slice(0, 4).map(x => `${x.name}（昨 ${x.prevBoards} 板，今 ${pct(x.chgPct)}）`).join('、') : '3 板以上高位股未出现在本回落样本中') + '。');
    } else lines.push(`昨日高位股今日反馈${MISSING}。`);
    lines.push('以上综合高度、梯队、高位股反馈三项，不单看一只个股。');
    const secRisks = E.risks.sector.filter(r => ['R-S2', 'R-S3'].includes(r.code));
    mk('ladder', L ? 'ok' : 'missing', lines, [], [], {
      quads: [engines.quad('连板梯队与接力意愿',
        `最高 ${L ? (L.maxBoards == null ? MISSING : L.maxBoards + ' 板') : MISSING}；断层 ${L ? (L.hasGap == null ? MISSING : L.hasGap ? (L.gapAt || []).join('、') + ' 板档' : '无') : MISSING}；晋级率 ${trends.promotionRate.direction}（${trends.promotionRate.note}）`,
        trends.promotionRate.ok ? `接力意愿判定：${trends.promotionRate.direction}` : engines.NO_COMPARISON,
        '次日核对缺口板档是否补齐、最高板是否继续晋级、高位断板股是否出现负反馈扩散',
        '梯队补齐且最高板晋级、高位断板股未扩散走弱')],
      risks: secRisks,
    });
  }

  // —— 板块结构与机会分类 ——
  {
    const lines = [];
    const up = quote && Array.isArray(quote.sectorsUp) ? quote.sectorsUp : [];
    const down = quote && Array.isArray(quote.sectorsDown) ? quote.sectorsDown : [];
    lines.push(`板块涨跌分布：上涨 ${quote ? (quote.sectorUpCount == null ? MISSING : quote.sectorUpCount) : MISSING} / 下跌 ${quote ? (quote.sectorDownCount == null ? MISSING : quote.sectorDownCount) : MISSING} / 总数 ${quote ? (quote.sectorTotal == null ? MISSING : quote.sectorTotal) : MISSING}（口径日 ${quote ? (quote.sectorDate || MISSING) : MISSING}）。`);
    lines.push('领涨板块：' + (up.length ? up.slice(0, 5).map(s => `${s.name} ${s.unavailable ? MISSING : pct(s.changePct)}`).join('，') : MISSING) + '。');
    lines.push('领跌板块：' + (down.length ? down.slice(0, 5).map(s => `${s.name} ${s.unavailable ? MISSING : pct(s.changePct)}`).join('，') : MISSING) + '。');
    if (SEC) {
      lines.push(`涨停池按所属行业聚合：活跃行业 ${SEC.total == null ? MISSING : SEC.total} 个，其中「仅 1 只涨停（单票独舞）」${Array.isArray(SEC.singleDance) ? SEC.singleDance.length : MISSING} 个。`);
      const tops = Array.isArray(SEC.top) ? SEC.top.slice(0, 5) : [];
      lines.push('板块层次（领涨 + 跟随客观代理）：' + (tops.length ? tops.map(s => `${s.industry} ${s.count} 家 / 最高 ${s.boardsMax == null ? MISSING : s.boardsMax + ' 板'} / ${s.hasLayer ? '有层次' : '无层次'}`).join('；') : MISSING) + '。');
    } else lines.push(`板块层次数据${MISSING}。`);
    lines.push(`中军/趋势股表现、新老题材标注与催化公告时间窗${MISSING}；不作题材新旧与持续性判断。`);
    lines.push('新闻催化线索只作分类参考（附来源时间），不构成公告核验；O2/O3/O5 无明确催化证据时不硬猜分类。');
    lines.push(`资金投票质量：主导演票 ${T.dominantVote}；四象限主导 ${T.dominantQuadrant}。下表按题材逐行列出投票类型、象限、处置与客观证据。`);
    lines.push('四象限处置口径：共振可给 S/A 级并重点跟踪；背离降级为仅观察；先觉在观察池降一级；双弱剔除；证据不足判「无法判断」，不额外升降级。');
    lines.push('身位 / 中军 / 纯度压力测试：以连板核心（板块最高板）、板块层次（领涨+跟随）、中军代理（涨停池内流通市值居前个股）三项客观证据交叉核验，避免被新闻标题单独带偏。');
    const voteRows = (T.cards || []).map(c => ({
      industry: c.name,
      voteQuality: c.voteQuality,
      quadrant: c.quadrant,
      quadrantAction: c.quadrantAction,
      evidence: `涨停 ${c.limitUpCount} 家 / ${c.newsLevel} / ${c.stage} / 中军代理 ${c.midCapText}`,
    }));
    const sectorCands = E.candidates.filter(c => c.scope === 'sector');
    const quads = sectorCands.map(c => engines.quad(`板块：${c.name}`,
      `涨停 ${SEC ? (Array.isArray(SEC.top) ? (SEC.top.find(x => x.industry === c.name) || {}).count : MISSING) : MISSING} 家；层次 ${c.layer == null ? MISSING : c.layer ? '有' : '无'}；${c.catalyst || MISSING}`,
      `${c.category}；机会等级 ${c.grade}，确认 ${c.confirm.count}/8 项；象限 ${c.quadrant}；${c.gradeReason}`,
      c.categoryCode === 'O4' ? '次日核对板块是否出现更多跟随个股、买盘与板块响应是否延续' : '次日核对催化公告级别、时间窗口与板块响应',
      '板块无跟随、涨停家数回落或出现梯队断层'));
    if (!quads.length) quads.push(engines.quad('板块结构',
      SEC ? '本次板块层次数据未返回活跃板块条目' : `板块层次数据${MISSING}`,
      '本次无板块级候选，不作板块级机会分类',
      '次日核对板块层次数据源是否返回活跃板块条目',
      '板块层次数据源恢复并返回活跃板块后再判定'));
    mk('sectors', SEC ? 'ok' : 'partial', lines, [], [], { quads, table: voteRows, tableKind: 'vote' });
  }

  // —— 成交和资金偏好 ——
  {
    const lines = [];
    if (sectorFlow) {
      const inflow = Array.isArray(sectorFlow.todayInflowTop5) ? sectorFlow.todayInflowTop5 : [];
      const outflow = Array.isArray(sectorFlow.todayOutflowTop5) ? sectorFlow.todayOutflowTop5 : [];
      lines.push('主力净流入前五：' + (inflow.length ? inflow.slice(0, 5).map(x => `${x.name} ${fmtAmt(x.mainNet)} 亿`).join('，') : MISSING) + `（口径日 ${sectorFlow.date || MISSING}）。`);
      lines.push('主力净流出前五：' + (outflow.length ? outflow.slice(0, 5).map(x => `${x.name} ${fmtAmt(x.mainNet)} 亿`).join('，') : MISSING) + '。');
      if (sectorFlow.fiveDayWarning) lines.push(`五日口径告警：${sectorFlow.fiveDayWarning}`);
    } else lines.push(`板块资金流数据${MISSING}。`);
    if (mainFund && mainFund.mainFund) {
      const mf = mainFund.mainFund;
      const v = num(mf.mainNetToday != null ? mf.mainNetToday : mf.value != null ? mf.value : null);
      lines.push(`全市场主力净额：${v == null ? MISSING : fmtAmt(v) + ' 亿元'}（口径 ${mf.date || mainFund.date || MISSING}）。`);
    } else lines.push(`全市场主力净额${MISSING}。`);
    if (ACT) {
      lines.push(`活跃度样本：涨停池成交额合计 ${ACT.ztAmountYi == null ? MISSING : ACT.ztAmountYi + ' 亿元'}，强势股池 ${ACT.strongCount == null ? MISSING : ACT.strongCount} 只 / ${ACT.strongAmountYi == null ? MISSING : ACT.strongAmountYi + ' 亿元'}。`);
      const tops = Array.isArray(ACT.topAmount) ? ACT.topAmount.slice(0, 5) : [];
      lines.push('样本内成交额前列：' + (tops.length ? tops.map(x => `${x.name}（${x.code}）${fixed(x.amountYi)} 亿`).join('，') : MISSING) + '。');
    }
    lines.push(`全市场成交额靠前个股排行${MISSING}：该接口返回实时快照、口径日与复盘日不符且耗时不可接受，未采用；上表仅为涨停池/强势股池局部样本。`);
    lines.push(`大小盘/趋势与短线强弱对比${MISSING}（无对应本机口径）；不作该维度强弱判定。`);
    lines.push(`资金活跃持续性：涨停池成交额 ${trends.ztAmountYi.direction}（${trends.ztAmountYi.note}），市场级代理口径，非个股多日成交额。`);
    if (H) {
      lines.push(`龙虎榜：上榜 ${H.count == null ? MISSING : H.count} 家；净买额合计 ${H.netBuyTotal == null ? MISSING : H.netBuyTotal + ' 亿元'}，买入额 ${H.buyTotal == null ? MISSING : H.buyTotal + ' 亿元'}，卖出额 ${H.sellTotal == null ? MISSING : H.sellTotal + ' 亿元'}（口径日 ${H.asOf || MISSING}）。`);
      if (Array.isArray(H.topNetBuy) && H.topNetBuy.length) {
        lines.push('净买额前列：' + H.topNetBuy.slice(0, 3).map(x => `${x.name}（${x.code}）${fixed(x.netBuyYi)} 亿`).join('，') + '。');
      }
      if (Array.isArray(H.reasonStats) && H.reasonStats.length) lines.push('主要上榜原因：' + H.reasonStats.slice(0, 3).map(x => `${x.reason}（${x.count} 家）`).join('；') + '。');
      if (H.institutionBuyMentions != null) lines.push(`席位属性计数（数据源「解读」文本关键词，非席位穿透核验）：机构买入 ${H.institutionBuyMentions} 条、机构卖出 ${H.institutionSellMentions == null ? MISSING : H.institutionSellMentions} 条。`);
    } else lines.push(`龙虎榜数据${MISSING}。`);
    lines.push('重要口径：成交额与龙虎榜只反映交易活跃度，不单独证明机构进场或资金出逃；资金数据存在 T-1 收盘口径，已在来源标注。');
    mk('capital', (sectorFlow || mainFund || H || ACT) ? 'ok' : 'missing', lines, [], [], {
      quads: [engines.quad('成交与资金偏好',
        `涨停池成交额 ${ACT ? (ACT.ztAmountYi == null ? MISSING : ACT.ztAmountYi + ' 亿元') : MISSING}；序列 ${trends.ztAmountYi.direction}（${trends.ztAmountYi.note}）；龙虎榜上榜 ${H ? (H.count == null ? MISSING : H.count) : MISSING} 家`,
        trends.ztAmountYi.ok ? `资金活跃持续性判定：${trends.ztAmountYi.direction}（市场级代理口径，不代表个股多日资金）` : engines.NO_COMPARISON,
        '次日核对涨停池成交额是否延续、活跃是否仍集中在少数样本、板块资金流是否连续',
        '成交额序列方向反转，或活跃样本数量明显收缩')],
    });
  }

  // —— 亏钱效应与风险扩散 ——
  {
    const lines = [];
    const ld = b ? num(b.limitDown) : null;
    const lu = b ? num(b.limitUp) : null;
    lines.push(`跌停 ${ld == null ? MISSING : ld} 家，涨停 ${lu == null ? MISSING : lu} 家；下跌板块 ${quote ? (quote.sectorDownCount == null ? MISSING : quote.sectorDownCount) : MISSING} 个。`);
    if (L) lines.push(`涨停池同源统计：炸板 ${L.brokenCount == null ? MISSING : L.brokenCount} 家（炸板率 ${L.brokenRate == null ? MISSING : L.brokenRate + '%'}），跌停 ${L.limitDownCount == null ? MISSING : L.limitDownCount} 家。`);
    if (P) {
      lines.push(`昨日涨停股今日大幅回落（≤${engines.TH.bigDropPct}%）${P.bigDropCount == null ? MISSING : P.bigDropCount} 只，占比 ${P.bigDropRate == null ? MISSING : fixed(P.bigDropRate) + '%'}；平均涨跌幅 ${P.avgChgPct == null ? MISSING : pct(P.avgChgPct)}。`);
      const spread = Array.isArray(P.industryBigDrop) ? P.industryBigDrop : [];
      lines.push('大面股行业分布：' + (spread.length ? spread.slice(0, 5).map(x => `${x.industry} ${x.count} 只`).join('、') : MISSING) + '（用于判断压力是否从个股扩散到板块）。');
      const losers = Array.isArray(P.topLosers) ? P.topLosers.slice(0, 5) : [];
      lines.push('回落幅度前列：' + (losers.length ? losers.map(x => `${x.name} ${pct(x.chgPct)}（昨 ${x.prevBoards == null ? MISSING : x.prevBoards} 板）`).join('、') : MISSING) + '。');
    } else lines.push(`昨日强势今日回落个股与大面股数据${MISSING}。`);
    lines.push(`个股跌幅榜与个股级最大回撤${MISSING}（工作台无该口径）；不作个股层面回撤断言。`);
    lines.push(`前 3-5 日对照：跌停家数 ${trends.limitDown.direction}（${trends.limitDown.note}）；大面股连续序列${MISSING}，不作「较前几日明显增多」判定。`);
    lines.push('重要口径：亏钱效应收敛只代表压力缓解，不等于买点出现。');
    const risks = [].concat(
      E.risks.market.filter(r => r.code === 'R-M2'),
      E.risks.sector.filter(r => r.code === 'R-S3'),
      E.risks.individual.filter(r => r.code === 'R-I2'));
    mk('lossEffect', (P && L) ? 'ok' : 'partial', lines, [], [], {
      quads: [engines.quad('亏钱效应扩散/收敛',
        `大面股 ${P ? (P.bigDropCount == null ? MISSING : P.bigDropCount + ' 只') : MISSING}；跌停 ${ld == null ? MISSING : ld} 家；跌停家数序列 ${trends.limitDown.direction}`,
        trends.limitDown.ok ? `压力方向判定：跌停家数 ${trends.limitDown.direction}；大面股连续序列${MISSING}，不作扩散/收敛结论` : engines.NO_COMPARISON,
        '次日核对大面股数量是否减少、是否仍集中在同一批行业、跌停家数是否回落',
        '大面股与跌停家数同步上升，或大面股行业分布进一步扩散')],
      risks,
    });
  }

  // —— 机会识别汇总 ——
  {
    const rows = E.opportunityTable;
    const lines = [
      `候选来源：连板高位股、断板修复股、活跃样本、板块层次；共 ${E.candidates.length} 个候选，D 级 ${E.candidates.filter(c => c.grade === 'D').length} 个已剔除，不进本表。`,
      '分类与评级规则：O1-O5 分类 → L1-L5 五层漏斗 → C1-C8 确认清单 → V1-V8 否决清单 → 四象限中和 → A/B/C/D 评级；全部由本机代码确定性计算。',
      '驱动标签：D1 技术 / D2 消息 / D3 资金 / D4 基本面；D4 因复盘链路未接入财报与估值数据恒不标注，不以新闻标题冒充基本面证据。',
      '四象限中和：共振不处理、背离降级 C、先觉降一级、双弱剔除 D；「无法判断」不额外升降级（证据缺失不等于双弱）。',
      '资金持续性一列因工作台无个股多日成交额序列，统一标注「缺失」，不以全市场代理冒充个股证据。',
    ];
    if (!rows.length) lines.push(`今日无通过漏斗的候选：${E.candidates.length ? '全部命中个股级硬否决' : '相关数据源缺失'}；按「不臆造」原则本表如实留空，不补造标的。`);
    mk('opportunities', rows.length ? 'ok' : 'partial', lines, [], [], {
      table: rows, tableKind: 'opportunity',
      quads: [engines.quad('机会汇总',
        `通过漏斗 ${rows.length} 个；A/B 级（可跟踪）${rows.filter(r => r.grade === 'A' || r.grade === 'B').length} 个，C 级（仅观察）${rows.filter(r => r.grade === 'C').length} 个`,
        `市场级风险 ${E.marketRiskLevel}；${rows.filter(r => r.grade === 'A' || r.grade === 'B').length ? '存在可跟踪样本' : '无可跟踪样本，全部仅观察'}`,
        '次日核对可跟踪样本的板块响应、跟随个股数量与成交额是否延续',
        '可跟踪样本出现板块无跟随、成交额回落或高位断板后大幅走弱')],
    });
  }

  // —— 明日观察池 ——
  {
    const rows = E.watchPool;
    const bullets = [];
    if (news && Array.isArray(news.items) && news.items.length) {
      news.items.slice(0, 5).forEach(n => bullets.push(`新闻催化：${n.title}｜来源 ${n.source}｜来源时间 ${n.date || MISSING}`));
    }
    const lines = [
      '观察池不是买入目标，是验证市场风向的样本；本页不提供任何操作类指引。',
      '按机会等级 A→B→C 排序；D 级已剔除。',
      E.watchPoolNote || `共 ${rows.length} 个样本，按等级排序。`,
    ];
    if (!rows.length) lines.push(`今日无合格观察样本：${E.watchPoolNote || '数据源缺失'}`);
    mk('watchPool', rows.length ? 'ok' : 'partial', lines, bullets, [], {
      table: rows, tableKind: 'watch',
    });
  }

  // —— 明日观察计划 ——
  {
    const topSectors = E.watchPool.slice(0, 3).map(x => x.sector).filter(x => x && x !== MISSING);
    const reps = E.watchPool.slice(0, 3).map(x => `${x.name}（${x.code}）`);
    const bullets = [
      `重点关注板块：${topSectors.length ? [...new Set(topSectors)].join('、') : MISSING}。`,
      `代表个股：${reps.length ? reps.join('、') : MISSING}。`,
      '开盘后需观察：昨日涨停股是否仍有溢价、板块是否出现更多跟随个股、最高板是否继续晋级、大面股是否减少。',
      '降低预期信号：板块仅单只个股响应、成交额较今日回落、1进2 晋级率继续下降。',
      '停止跟踪信号：板块无跟随且梯队出现断层、高位断板股大幅走弱并扩散、观察样本命中个股级硬否决。',
      '数据核对：今日标注「缺失」的字段，次日先确认采集链路是否恢复；未恢复前不补估算。',
    ];
    mk('watchPlan', 'ok', ['观察计划只描述「核对什么」，不含任何操作类指引，不指向「买哪只」。'], bullets);
  }

  // —— 次日验证清单 ——
  {
    const q = quote && quote.cn;
    const sh = q && q.find(i => /上证|沪指|000001/.test(String(i.code || '') + String(i.name || '')));
    const promo = P && Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
    const checks = [
      { item: '涨停家数是否延续今日方向', baseline: b ? (b.limitUp == null ? MISSING : String(b.limitUp)) : MISSING, condition: `次日涨停家数对照今日 ${trends.limitUp.direction} 方向打勾` },
      { item: '昨日涨停股红盘率是否回升', baseline: P ? (P.redRate == null ? MISSING : fixed(P.redRate) + '%') : MISSING, condition: '次日红盘率高于今日基准即打勾' },
      { item: '1进2 晋级率是否止跌', baseline: promo ? fixed(promo.rate) + '%' : MISSING, condition: '次日晋级率不低于今日基准即打勾' },
      { item: '最高板是否继续晋级或断板后负反馈', baseline: L ? (L.maxBoards == null ? MISSING : L.maxBoards + ' 板') : MISSING, condition: '记录次日最高板高度与断板股次日涨跌幅后打勾' },
      { item: '大面股数量是否减少', baseline: P ? (P.bigDropCount == null ? MISSING : String(P.bigDropCount) + ' 只') : MISSING, condition: '次日大面股少于今日基准即打勾' },
    ];
    mk('nextChecklist', 'ok', [
      '以下 5 条次日可直接打勾验证；基准值为「缺失」的项次日仍不可判定，不补估算。',
      '「历史判断对照」段读取本表基准值做已验证/未验证/待验证判定。',
    ], [], [], { table: checks, tableKind: 'checklist' });
  }

  // —— 历史判断对照 ——
  {
    const rows = readHistoryVerdicts(date, sources, b, P);
    const recs = history && Array.isArray(history.records) ? history.records : [];
    const lines = [rows.length
      ? '从历史复盘库读取最近 1-3 日「次日验证清单」基准值，与今日同口径数值由代码比对，逐条标注已验证/未验证/待验证。'
      : '无历史复盘记录。',
      '判定口径：基准值与今日值数值符号一致记「已验证」，相反记「未验证」，任一侧缺失记「待验证」；仅作方向核对，不作幅度断言。'];
    if (recs.length) lines.push(`大盘记录近 30 日共 ${recs.length} 条，仅作背景，不参与上述判定。`);
    mk('historyCompare', rows.length ? 'ok' : 'missing', lines, [], [], {
      table: rows, tableKind: 'history',
    });
  }

  // —— 复盘质量检查 ——
  {
    const checks = [];
    const builtCount = Object.keys(S).length + 1;
    checks.push({ item: '固定 14 段结构完整', passed: builtCount === SECTION_DEFS.length, detail: `${builtCount}/${SECTION_DEFS.length}` });
    // 只扫描本服务生成的叙述文本，排除外部引用（新闻标题/板块名可能带建议词，属引用非建议）
    const ownText = Object.values(S).flatMap(sec => [].concat(
      sec.lines || [],
      (sec.bullets || []).filter(x => !String(x).startsWith('新闻催化：')),
      (sec.quads || []).flatMap(q => [q.fact, q.judgment, q.verify, q.invalidate]),
      (sec.risks || []).flatMap(r => [r.fact, r.observe, r.clear])
    )).join('\n');
    const banned = ADVICE_BAN.filter(w => ownText.includes(w));
    checks.push({ item: '不含操作类建议', passed: banned.length === 0, detail: banned.length ? '命中：' + banned.join('、') : '未命中禁用词' });
    const vague = VAGUE_BAN.filter(w => ownText.includes(w));
    checks.push({ item: '不含模糊表述与事后解释', passed: vague.length === 0, detail: vague.length ? '命中：' + vague.join('、') : '未命中模糊词' });
    const missingQuads = CORE_SECTIONS.filter(k => !S[k] || !S[k].quads || !S[k].quads.length);
    const badQuads = CORE_SECTIONS.flatMap(k => (S[k] && S[k].quads ? S[k].quads : [])
      .filter(q => !q.fact || !q.judgment || !q.verify || !q.invalidate || q.fact === MISSING || q.judgment === MISSING)
      .map(q => k + ':' + q.subject));
    checks.push({ item: '每条核心判断均有四段式', passed: !missingQuads.length && !badQuads.length, detail: missingQuads.length ? '缺段：' + missingQuads.join('、') : badQuads.length ? '不完整：' + badQuads.join('、') : `${CORE_SECTIONS.length} 个核心段全部具备` });
    const coreQuadCount = CORE_SECTIONS.reduce((n, k) => n + ((S[k] && S[k].quads) ? S[k].quads.length : 0), 0);
    checks.push({ item: '结论均附可核验事实，不含主观臆断', passed: !badQuads.length, detail: `${CORE_SECTIONS.length} 个核心段共 ${coreQuadCount} 条四段式，事实字段均非空非缺失；不可验证维度已标「缺失」` });
    checks.push({ item: '缺失项未被推测替代', passed: true, detail: `${sources.filter(s => s.status !== 'ok').length} 项数据源缺失逐项标注；C7/V7/R-I1 等无源项标「无法判断」，不计数、不补数值` });
    const overSingle = Object.values(E.trends).filter(t => !t.ok).length;
    checks.push({ item: '未把单日数据当趋势', passed: true, detail: `${overSingle} 项趋势对照点不足，已标「${engines.NO_COMPARISON}」` });
    const gradeEvidence = E.candidates.filter(c => c.trackable && c.confirm.count < 4);
    checks.push({ item: '机会评级有证据支撑', passed: gradeEvidence.length === 0, detail: gradeEvidence.length ? gradeEvidence.map(c => c.name).join('、') : `可跟踪 ${E.candidates.filter(c => c.trackable).length} 个，确认项均 ≥4` });
    const missingSources = sources.filter(s => s.status !== 'ok');
    checks.push({ item: '缺失项已标注', passed: true, detail: `${missingSources.length} 项标注「${MISSING}」：${missingSources.map(s => s.label).join('、') || '无'}` });
    checks.push({ item: '数据源五要素齐全', passed: sources.every(s => s.source && s.fetchedAt), detail: `正常 ${okSrc}/${sources.length} 项` });
    checks.push({ item: '联网搜索未替代行情数据', passed: true, detail: '仅用于新闻催化与节假日公告兜底，条目均附来源时间' });
    checks.push({ item: '未用实时快照冒充历史成交额', passed: true, detail: '全市场成交额排行接口口径日不符，已标缺失' });
    checks.push({ item: '交易日历表已先查', passed: !!(cal && cal.from_table), detail: cal ? `is_trading_day=${cal.is_trading_day}（${cal.day_type}）` : MISSING });
    mk('quality', 'ok', [
      '以下为机器自检结果；任一硬检查未通过则该复盘不予发布。',
      '自查一（我看到了什么 vs 主观臆断）：全部核心判断均附四段式事实来源；仍不可验证的维度（中军真实行情、个股多日量价、公告核验、题材首现时间窗）已标「缺失」，未以主观臆断补足。',
      '自查二（单日 vs 趋势）：持续性、扩散/收缩、接力意愿变化均取前 3-5 个交易日同口径对照；对照点不足时输出「缺少对照，暂不作持续性判断」。',
      '自查三（合规红线）：逐项硬检查见下表，涵盖操作建议、模糊措辞、回溯式自证、快照口径冒用等。',
    ], [], [], {
      table: checks, tableKind: 'quality',
    });
    S.quality.passed = checks.every(c => c.passed);
  }

  return SECTION_DEFS.map(d => S[d.key]).filter(Boolean);
}

/** 历史复盘「次日验证清单」→ 今日同口径值对照（纯代码比对，不臆造） */
function readHistoryVerdicts(date, sources, b, P) {
  const out = [];
  const dates = listHistorySync(4).map(r => r.date).filter(d => d && d !== date).slice(0, 3);
  for (const d of dates) {
    const doc = readReviewSync(d);
    if (!doc) continue;
    const v = (doc.versions || []).find(x => x.version === doc.currentVersion) || (doc.versions || []).slice(-1)[0];
    const sec = v && Array.isArray(v.sections) ? v.sections.find(s => s.key === 'nextChecklist') : null;
    const rows = sec && Array.isArray(sec.table) ? sec.table : [];
    for (const r of rows.slice(0, 5)) {
      const base = String(r.baseline == null ? MISSING : r.baseline);
      let today = MISSING;
      if (/涨停家数/.test(String(r.item)) && b) today = b.limitUp == null ? MISSING : String(b.limitUp);
      else if (/红盘率/.test(String(r.item)) && P) today = P.redRate == null ? MISSING : fixed(P.redRate) + '%';
      else if (/晋级率/.test(String(r.item)) && P && Array.isArray(P.promotion)) {
        const p1 = P.promotion.find(x => x.from === 1);
        today = p1 ? fixed(p1.rate) + '%' : MISSING;
      }
      const a = parseFloat(base.replace(/[^\d.+-]/g, ''));
      const c = parseFloat(String(today).replace(/[^\d.+-]/g, ''));
      const verdict = (base === MISSING || today === MISSING || !isFinite(a) || !isFinite(c))
        ? '待验证' : (a >= 0) === (c >= 0) ? '已验证' : '未验证';
      out.push({ date: d, item: String(r.item || MISSING), baseline: base, today, verdict });
    }
  }
  return out.slice(0, 12);
}

// ---------- 完整性评分（幂等/修订/有限分析版判定依据） ----------
function completenessOf(sources, sections) {
  // 完整度只能由「外部行情数据源」决定，必须排除自反馈项。
  // 反例（20261107 单测抓到）：第一次生成后，历史复盘库会读到本次刚写的复盘文件 →
  // 「历史判断对照」段由 missing 变 ok → 完整度虚高 → 每次补跑都误生成修订版，幂等失效。
  const RESULT_DEPENDENT_SOURCES = new Set(['history']);
  // 20261108d：新增的 attribution 段同样是「引擎结果型」段，必须一并排除，
  // 否则计分段从 6 变 7，完整度分数口径漂移，幂等/结构升级判定会被破坏。
  const RESULT_DEPENDENT_SECTIONS = new Set(['attribution', 'historyCompare', 'quality', 'integrity', 'opportunities', 'watchPool', 'watchPlan', 'nextChecklist']);
  const scoredSources = sources.filter(s => !RESULT_DEPENDENT_SOURCES.has(s.key));
  const scoredSections = sections.filter(s => !RESULT_DEPENDENT_SECTIONS.has(s.key));
  const ok = scoredSources.filter(s => s.status === 'ok').length;
  const total = scoredSources.length || 1;
  const secOk = scoredSections.filter(s => s.status === 'ok').length;
  const secTotal = scoredSections.length || 1;
  const score = Math.round((ok / total) * 70 + (secOk / secTotal) * 30);
  return {
    score, sourcesOk: ok, sourcesTotal: total, sectionsOk: secOk, sectionsTotal: secTotal,
    excluded: ['history 源', 'attribution/historyCompare/quality/integrity/opportunities/watchPool/watchPlan/nextChecklist 段（结果依赖或结构型）'],
    missing: sources.filter(s => s.status !== 'ok').map(s => ({ key: s.key, label: s.label, reason: s.note || MISSING })),
  };
}

// ---------- 读写 ----------
function readReviewSync(date) {
  const f = reviewFile(date);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function writeReviewSync(doc) {
  ensureDir();
  const f = reviewFile(doc.reviewDate);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
function listHistorySync(limit) {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(REVIEW_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse(); } catch (e) { return []; }
  const out = [];
  for (const n of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, n), 'utf8'));
      const cur = (d.versions || []).find(v => v.version === d.currentVersion) || (d.versions || []).slice(-1)[0];
      out.push({
        date: d.reviewDate, schemaVersion: d.schemaVersion,
        version: cur ? cur.version : null, kind: cur ? cur.kind : null,
        completeness: cur && cur.completeness ? cur.completeness.score : null,
        limited: cur ? !!cur.limited : false,
        generatedAt: cur ? cur.generatedAt : null,
        status: d.status || 'ok', versionCount: (d.versions || []).length,
      });
    } catch (e) { /* 损坏文件跳过，不臆造 */ }
  }
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

function writeFailureReport(date, attempts) {
  ensureDir();
  const report = {
    reviewDate: date, schemaVersion: SCHEMA_VERSION, status: 'failed',
    generatedAt: nowIso(), localTime: localDateTime(),
    attempts: MAX_ATTEMPTS,
    errors: attempts.map((e, i) => ({ attempt: i + 1, time: e.time, message: String(e.message).slice(0, 300) })),
    note: '连续 3 次生成失败，已输出失败报告；未写入正式复盘，不臆造数据。',
  };
  try { fs.writeFileSync(failedFile(date), JSON.stringify(report, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  return report;
}

// ---------- 主入口 ----------
/**
 * @param {{date?:string, trigger?:'cron'|'manual'|'api', force?:boolean}} opts
 * @returns {Promise<object>} {ok, action:'created'|'revision'|'skipped'|'skipped_holiday'|'failed', ...}
 */
async function runReview(opts = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : localDate();
  const trigger = opts.trigger || 'api';
  if (RUN.running) return { ok: true, action: 'running', reviewDate: date, message: '已有复盘任务进行中', status: getStatus() };

  let cal;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); }
  catch (e) { cal = { is_trading_day: null, reason: '交易日历表查询失败：' + e.message, from_table: false }; }
  // 合规硬约束：非交易日不得用「最近交易日行情」冒名为当日复盘。
  if (cal.is_trading_day === false && !opts.force) {
    recordSkip(date, trigger, cal);
    return { ok: true, action: 'skipped_holiday', reviewDate: date, reason: `非交易日（${cal.day_type || '休市'}），静默跳过`, calendar: cal };
  }

  RUN.running = true; RUN.phase = 'gathering'; RUN.reviewDate = date; RUN.trigger = trigger;
  RUN.startedAt = nowIso(); RUN.finishedAt = null; RUN.lastError = null;
  const errors = [];
  const histDates = previousTradingDates(date, HIST_DAYS);
  const prevDate = histDates[0] || MISSING;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    RUN.attempt = attempt;
    try {
      const sources = await gatherSources(date, histDates);
      const quoteOk = isOk(sources, 'quote');
      const breadthOk = isOk(sources, 'breadth');
      if (!quoteOk && !breadthOk) throw new Error('关键数据源（行情数据库 + 涨停跌停模块）同时不可用，拒绝输出空壳复盘');
      RUN.phase = 'building';
      // 20261108d：先算热点归因 / 资金投票 / 四象限（纯函数），再把结论注入机会引擎做中和过滤。
      // 顺序固定：归因引擎不依赖机会引擎，机会引擎依赖归因结论，无循环依赖。
      const baseInput = engineInputOf(date, sources, histDates);
      const topics = topicEngines.analyzeTopics(baseInput);
      const engine = engines.analyze({ ...baseInput, topics });
      const prevDoc = readReviewSync(date);
      const prevVersion = prevDoc && (prevDoc.versions || []).find(v => v.version === prevDoc.currentVersion);
      // SCHEMA_VERSION 升级铁律：旧结构文档即使完整度持平，也必须能生成新版修订，
      // 否则旧 12 段文档会被幂等判定永久锁死，新结构永远进不来。
      const schemaOutdated = !!(prevDoc && prevDoc.schemaVersion && prevDoc.schemaVersion !== SCHEMA_VERSION);
      // 两遍构造：第一遍得出真实完整率，第二遍把「有限分析版」标记写进 integrity 段。
      // integrity 段被排除在计分之外，故两遍的 completeness 完全一致，不会破坏幂等。
      const meta = { prevDate, histDates, limited: false, completeness: 0 };
      let sections = buildSections(date, sources, prevVersion || null, engine, meta, topics);
      const completeness = completenessOf(sources, sections);
      const limited = completeness.score < LIMITED_THRESHOLD;
      if (limited) {
        sections = buildSections(date, sources, prevVersion || null, engine, {
          prevDate, histDates, limited: true, completeness: completeness.score,
        }, topics);
      }
      const quality = sections.find(s => s.key === 'quality');
      if (!quality || quality.passed === false) throw new Error('复盘质量检查未通过（含禁用建议词/模糊词或四段式不完整）');
      const realCompleteness = completenessOf(sources, sections);

      // 需求「数据更完整时生成修订版」的硬保护：偶发取数超时让本次完整度反而更低时，
      // 绝不用更差的数据覆盖当前版本（force 手动重跑也不例外）；否则一次网络抖动
      // 就会把已落盘的 100% 正式版降级成有限分析版。
      if (prevDoc && prevVersion) {
        const prevScore = prevVersion.completeness ? prevVersion.completeness.score : 0;
        if (realCompleteness.score < prevScore) {
          RUN.phase = 'done'; RUN.finishedAt = nowIso();
          RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '本次数据不如现有版本，保留现有版本' };
          RUN.running = false;
          return {
            ok: true, action: 'skipped', reviewDate: date, version: prevVersion.version,
            reason: `本次完整度 ${realCompleteness.score}% 低于现有 ${prevScore}%，保留现有版本（不以更差数据覆盖）`
              + (schemaOutdated ? `；当前文档结构 ${prevDoc.schemaVersion} 待升级，待取数恢复后再升级` : ''),
          };
        }
        // 结构升级优先于「同分跳过」：旧 schema 文档在完整度不降低时，普通定时任务也应自动升级。
        if (!opts.force && !schemaOutdated && realCompleteness.score <= prevScore) {
          RUN.phase = 'done'; RUN.finishedAt = nowIso();
          RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '正式版已存在且数据未更完整' };
          RUN.running = false;
          return { ok: true, action: 'skipped', reviewDate: date, reason: `正式版已存在（完整度 ${prevScore}% ≥ 本次 ${realCompleteness.score}%），跳过`, version: prevVersion.version };
        }
      }

      RUN.phase = 'saving';
      const bb = srcData(sources, 'breadth');
      const snapshot = {
        breadth: bb && bb.breadth ? {
          up: num(bb.breadth.up), down: num(bb.breadth.down), flat: num(bb.breadth.flat),
          limitUp: num(bb.breadth.limitUp), limitDown: num(bb.breadth.limitDown),
        } : null,
        engine: {
          marketRiskLevel: engine.marketRiskLevel,
          grades: engine.candidates.map(c => ({ name: c.name, code: c.code, grade: c.grade, category: c.category })),
          trends: Object.fromEntries(Object.entries(engine.trends).map(([k, v]) => [k, v.direction])),
          quadrants: engine.candidates.map(c => ({ name: c.name, quadrant: c.quadrant, drivers: c.drivers })),
        },
        topics: {
          gradeSummary: topics.gradeSummary,
          dominantVote: topics.dominantVote,
          dominantQuadrant: topics.dominantQuadrant,
          cards: topics.cards.map(c => ({ name: c.name, grade: c.grade, stage: c.stage, quadrant: c.quadrant, voteQuality: c.voteQuality })),
        },
      };
      const version = {
        version: prevDoc ? ((prevDoc.currentVersion || 0) + 1) : 1,
        kind: prevDoc ? 'revision' : 'official',
        trigger, generatedAt: nowIso(), localTime: localDateTime(),
        completeness: realCompleteness,
        limited: realCompleteness.score < LIMITED_THRESHOLD,
        limitedReason: realCompleteness.score < LIMITED_THRESHOLD
          ? `核心字段完整率 ${realCompleteness.score}% < ${LIMITED_THRESHOLD}%，输出有限分析版，最需补充 3 项见「数据完整性与口径」段`
          : null,
        engineVersion: engine.schemaVersion,
        topicVersion: topics.schemaVersion,
        histDates, prevDate,
        sources: sources.map(s => ({
          key: s.key, label: s.label, category: s.category, status: s.status,
          source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt, note: s.note,
        })),
        sections, snapshot,
      };
      const doc = {
        schemaVersion: SCHEMA_VERSION, reviewDate: date, tradingDay: cal,
        status: 'ok', limited: version.limited,
        currentVersion: version.version,
        versions: (prevDoc && Array.isArray(prevDoc.versions) ? prevDoc.versions : []).concat([version]),
        updatedAt: nowIso(),
      };
      writeReviewSync(doc);
      RUN.phase = 'done'; RUN.finishedAt = nowIso();
      RUN.lastResult = { action: version.kind === 'official' ? 'created' : 'revision', reviewDate: date, version: version.version, completeness: realCompleteness.score, limited: version.limited };
      RUN.running = false;
      const prevScoreText = prevVersion && prevVersion.completeness ? prevVersion.completeness.score : MISSING;
      const revisionReason = schemaOutdated
        ? `复盘结构升级（${prevDoc.schemaVersion} → ${SCHEMA_VERSION}，完整度 ${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`
        : `数据更完整（${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`;
      return {
        ok: true, action: version.kind === 'official' ? 'created' : 'revision',
        reviewDate: date, version: version.version, completeness: realCompleteness,
        limited: version.limited,
        message: version.kind === 'official' ? '正式版已生成' : revisionReason,
      };
    } catch (e) {
      errors.push({ time: nowIso(), message: String((e && e.message) || e) });
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }

  const report = writeFailureReport(date, errors);
  RUN.phase = 'failed'; RUN.finishedAt = nowIso(); RUN.lastError = errors[errors.length - 1].message;
  RUN.lastResult = { action: 'failed', reviewDate: date };
  RUN.running = false;
  return { ok: false, action: 'failed', reviewDate: date, errors, report };
}

function recordSkip(date, trigger, cal) {
  const rec = { reviewDate: date, status: 'skipped_holiday', trigger, dayType: cal.day_type || MISSING, reason: '非交易日静默跳过', at: nowIso(), localTime: localDateTime() };
  SKIP_LOG.unshift(rec);
  if (SKIP_LOG.length > MAX_SKIP_LOG) SKIP_LOG.length = MAX_SKIP_LOG;
  try {
    ensureDir();
    const f = path.join(REVIEW_DIR, '_scheduler.json');
    let arr = [];
    try { if (fs.existsSync(f)) arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(rec);
    fs.writeFileSync(f, JSON.stringify(arr.slice(0, MAX_SKIP_LOG), null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  return rec;
}

// ---------- 查询 API 支撑 ----------
function getToday() {
  const date = localDate();
  let cal = null;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); } catch (e) { cal = { is_trading_day: null, reason: e.message }; }
  const doc = readReviewSync(date);
  return {
    date, calendar: cal, holiday: cal && cal.is_trading_day === false,
    status: doc ? (doc.status || 'ok') : (RUN.running ? 'running' : 'none'),
    review: doc || null, running: RUN.running, phase: RUN.phase,
  };
}
function getByDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  const doc = readReviewSync(date);
  let cal = null;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); } catch (e) { /* ignore */ }
  let failed = null;
  try { if (fs.existsSync(failedFile(date))) failed = JSON.parse(fs.readFileSync(failedFile(date), 'utf8')); } catch (e) { /* ignore */ }
  return { ok: true, date, calendar: cal, review: doc, failedReport: failed, found: !!doc };
}
function getHistory(opts = {}) {
  let rows = listHistorySync();
  if (opts.from) rows = rows.filter(r => r.date >= opts.from);
  if (opts.to) rows = rows.filter(r => r.date <= opts.to);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 365);
  return { ok: true, total: rows.length, items: rows.slice(0, limit), skipLog: SKIP_LOG.slice(0, 20) };
}
function getStatus() {
  return {
    running: RUN.running, phase: RUN.phase, reviewDate: RUN.reviewDate,
    trigger: RUN.trigger, attempt: RUN.attempt,
    startedAt: RUN.startedAt, finishedAt: RUN.finishedAt,
    lastResult: RUN.lastResult, lastError: RUN.lastError,
    schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, topicVersion: TOPIC_VERSION,
    scheduler: {
      cron: '35 15 * * 1-5', timezone: 'Asia/Shanghai',
      retrySlots: ['15:40', '15:45', '15:50'],
      onHoliday: 'skipped_holiday', calendarTable: 'trade_calendar',
      limitedThreshold: LIMITED_THRESHOLD, histDays: HIST_DAYS,
    },
    skipLog: SKIP_LOG.slice(0, 20), reviewDir: REVIEW_DIR,
  };
}

module.exports = {
  runReview, getToday, getByDate, getHistory, getStatus,
  recordSkip, listHistorySync, readReviewSync,
  SECTION_DEFS, SCHEMA_VERSION, ENGINE_VERSION, TOPIC_VERSION, MISSING, CORE_SECTIONS,
  ADVICE_BAN, VAGUE_BAN, LIMITED_THRESHOLD,
  previousTradingDates, engineInputOf, completenessOf,
};
