/**
 * lib/reviewService.js — 每日复盘聚合服务 ReviewService（20261110b · LLM 生成 Markdown）
 * ==================================================================================
 * 用户 2026-11-10 16:03 架构裁决：停止纯代码拼接报告，改为大模型生成。
 *  1. 废弃 lib/reviewOutput.js：不再有 SECTION_DEFS 固定段落、文本拼装、plainify 替换、
 *     后台 qualityOf() 硬门禁。代码不再产出任何报告文字。
 *  2. 代码只负责取数：gatherSources() 采集 + 确定性引擎算数值 →
 *     lib/reviewContext.js 组装成不含文案的干净 JSON Context。
 *  3. lib/reviewLlm.js 加载 prompts/daily-review-system.md（System Prompt），
 *     把 JSON Context 作为用户消息喂给大模型，返回整篇 Markdown。
 *  4. 取消硬性质检报错：数据重复 / 字段为 null / LLM 不可用都不阻断发布；
 *     缺失由提示词指导模型自然说「暂无数据」；LLM 失败降级为原始数据快照。
 *  5. 前端直接渲染 Markdown，不再套卡片 / 表格组件。
 *
 * 保留不变的能力：采集（gatherSources）、幂等 / 修订、交易日历判定、有限分析版判定、
 * formal → complete 龙虎榜异步补录状态机（15:35 / 20:30 / 次日兜底）。
 * 补录时不再「只改第八段」，而是把新龙虎榜并入 Context 重新生成整篇 Markdown。
 *
 * 三条底层规则（工作台铁律）：
 *  - 一致性：每个数据点带「名称/数值/实际时间/来源/获取时间」五要素（source/asOf/fetchedAt）。
 *  - 最新性：交易日感知（必须先查 trade_calendar 表）、按发布时刻分级补录。
 *  - 变化与边际：变化率 + 边际 + 方向 + 幅度；连续对照由 historySeries 提供。
 *
 * 代码权威：所有数值仍由本机代码从真实数据计算；LLM 只做叙事与归因，不得改数、不得估算。
 * 合规：不给买入/卖出/仓位建议；缺失不臆造。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { localDate, localDateTime } = require('./localDate');
const store = require('./store'); // [20261110g P1-4] JSON 读写统一
const tradeCalendar = require('./tradeCalendar');
const engines = require('./reviewEngines');
const topicEngines = require('./topicEngines');
const reviewContext = require('./reviewContext');
const reviewLlm = require('./reviewLlm');
// [20261110f B0-3] 反向联动：读取「上一份大盘复盘观察池」个股的个股复盘信号汇总。
// stockReview 顶层只依赖 fs/path（重依赖均在各函数内惰性 require），不会造成循环依赖。
const stockReview = require('./stockReview');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_DIR = process.env.SA_REVIEW_DIR
  ? path.resolve(process.env.SA_REVIEW_DIR)
  : path.join(DATA_DIR, 'reviews');

// 20261110b：输出契约由「11 段结构化 JSON」变为「整篇 Markdown」，按铁律升版，
// 否则旧落盘文档会被幂等判定永久复用。版本常量由 Context 层单一权威源转出。
const SCHEMA_VERSION = reviewContext.SCHEMA_VERSION;
const CONTEXT_VERSION = reviewContext.CONTEXT_VERSION;
const ENGINE_VERSION = engines.analyze({}).schemaVersion;
const TOPIC_VERSION = topicEngines.SCHEMA_VERSION;
const MISSING = '缺失';
const MAX_ATTEMPTS = 3;
const SOURCE_TIMEOUT_MS = 25000;
const BOARD_TIMEOUT_MS = 90000;   // 多日涨停池序列取数（实测约 15s），单独放宽
const LIMITED_THRESHOLD = 90;     // 核心字段完整率低于此值 → 有限分析版
const HIST_DAYS = 4;              // 前 3-5 个交易日对照，取 4 日

// formal / complete 版本状态：15:35 formal → 20:30 或次日兜底补录后 complete
const STAGE_FORMAL = 'formal';
const STAGE_COMPLETE = 'complete';
const LHB_PENDING = 'pending';
const LHB_FILLED = 'filled';
const LHB_UNAVAILABLE = 'unavailable';

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

// ---------- 20261110b：本文件只做采集 / 组装 JSON Context / 落盘 / 幂等；文字由 LLM 生成 ----------

/**
 * 历史判断基准 → 今日同口径值对照（纯代码比对，不臆造）。
 * 20261110a：旧「次日验证清单」段已删除，基准改存 version.snapshot.baselines；
 * 历史文档仍按旧 nextChecklist 表读取，保证 11 段新文档与 14 段旧文档可互相回溯。
 */
function baselinesOf(sources, L, P) {
  const bb = srcData(sources, 'breadth');
  const b = bb && bb.breadth ? bb.breadth : null;
  const p1 = P && Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
  return [
    { item: '涨停家数是否延续', baseline: b ? (b.limitUp == null ? null : String(b.limitUp)) : null },
    { item: '昨日涨停股红盘率是否回升', baseline: P ? (P.redRate == null ? null : fixed(P.redRate) + '%') : null },
    { item: '1进2晋级率是否止跌', baseline: p1 ? fixed(p1.rate) + '%' : null },
    { item: '最高板是否继续晋级', baseline: L ? (L.maxBoards == null ? null : L.maxBoards + ' 板') : null },
    { item: '大面股数量是否减少', baseline: P ? (P.bigDropCount == null ? null : String(P.bigDropCount) + ' 只') : null },
  ];
}

function readHistoryVerdicts(date, sources) {
  const out = [];
  const bb = srcData(sources, 'breadth');
  const b = bb && bb.breadth ? bb.breadth : null;
  const P = srcData(sources, 'prevPool');
  const p1 = P && Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
  const dates = listHistorySync(4).map(r => r.date).filter(d => d && d !== date).slice(0, 3);
  for (const d of dates) {
    const doc = readReviewSync(d);
    if (!doc) continue;
    const v = (doc.versions || []).find(x => x.version === doc.currentVersion) || (doc.versions || []).slice(-1)[0];
    let rows = [];
    if (v && v.snapshot && Array.isArray(v.snapshot.baselines)) {
      rows = v.snapshot.baselines.map(x => ({ item: x.item, baseline: x.baseline == null ? MISSING : String(x.baseline) }));
    } else {
      const sec = v && Array.isArray(v.sections) ? v.sections.find(s => s.key === 'nextChecklist') : null;
      rows = sec && Array.isArray(sec.table) ? sec.table : [];
    }
    for (const r of rows.slice(0, 5)) {
      const base = String(r.baseline == null ? MISSING : r.baseline);
      const item = String(r.item || MISSING);
      let today = MISSING;
      if (/涨停家数/.test(item) && b) today = b.limitUp == null ? MISSING : String(b.limitUp);
      else if (/红盘率/.test(item) && P) today = P.redRate == null ? MISSING : fixed(P.redRate) + '%';
      else if (/晋级率/.test(item) && p1) today = fixed(p1.rate) + '%';
      else if (/最高板/.test(item) && srcData(sources, 'ladder')) {
        const L = srcData(sources, 'ladder');
        today = L.maxBoards == null ? MISSING : L.maxBoards + ' 板';
      } else if (/大面股/.test(item) && P) today = P.bigDropCount == null ? MISSING : String(P.bigDropCount) + ' 只';
      const a = parseFloat(base.replace(/[^\d.+-]/g, ''));
      const c = parseFloat(String(today).replace(/[^\d.+-]/g, ''));
      const verdict = (base === MISSING || today === MISSING || !isFinite(a) || !isFinite(c))
        ? '待验证' : (a >= 0) === (c >= 0) ? '已验证' : '未验证';
      out.push({ date: d, item, baseline: base, today, verdict });
    }
  }
  return out.slice(0, 12);
}

// ---------- 完整性评分（幂等/修订/有限分析版判定依据） ----------
function completenessOf(sources) {
  // 20261110b：不再有 sections，完整度只由外部数据源决定（结果自反馈项 history 仍排除）。
  // 该分数现在只用于幂等 / 修订 / 有限分析版判定，**不再用于任何质检拦截**。
  // 反例（20261107 单测抓到）：第一次生成后历史复盘库会读到本次刚写的文件 →
  // 完整度虚高 → 每次补跑误生成修订版，幂等失效，故 history 必须排除。
  const RESULT_DEPENDENT_SOURCES = new Set(['history']);
  const scoredSources = (sources || []).filter(s => !RESULT_DEPENDENT_SOURCES.has(s.key));
  const ok = scoredSources.filter(s => s.status === 'ok').length;
  const total = scoredSources.length || 1;
  const score = Math.round((ok / total) * 100);
  return {
    score, sourcesOk: ok, sourcesTotal: total, sectionsOk: 0, sectionsTotal: 0,
    excluded: ['history 源（结果自反馈）', '20261110b 起不再计分段落状态'],
    missing: (sources || []).filter(s => s.status !== 'ok').map(s => ({ key: s.key, label: s.label, reason: s.note || MISSING })),
  };
}

// ---------- 读写 ----------
function readReviewSync(date) {
  const f = reviewFile(date);
  if (!fs.existsSync(f)) return null;
  return store.readJsonSafe(f, null).data;
}
function writeReviewSync(doc) {
  ensureDir();
  // 20261110g P1-4：等价迁移到 writeJsonAtomic（原 tmp+rename 手写实现）
  store.writeJsonAtomic(reviewFile(doc.reviewDate), doc);
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
        stage: d.stage || (cur && cur.stage) || null,
        dragonTigerStatus: d.dragonTigerStatus || (cur && cur.dragonTigerStatus) || null,
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
  try { store.writeJsonAtomic(failedFile(date), report); } catch (e) { /* ignore */ }
  return report;
}

// ---------- 主入口 ----------
/**
 * @param {{date?:string, trigger?:'cron'|'manual'|'api', force?:boolean, taskType?:string, task_type?:string}} opts
 * @returns {Promise<object>} {ok, action:'created'|'revision'|'skipped'|'skipped_holiday'|'failed'|'completed'|'pending', ...}
 */
async function runReview(opts = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : localDate();
  const trigger = opts.trigger || 'api';
  // 规格第三部分：收到 task_type="dragon_tiger_update" 的晚间补跑任务时，
  // 不重新生成整份复盘，直接走龙虎榜补录状态机（幂等 + 完整版唯一）。
  const taskType = opts.taskType || opts.task_type;
  if (taskType === 'dragon_tiger_update') {
    return backfillDragonTiger(date, { trigger });
  }
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
      // 20261110b：确定性引擎只负责产出数值，不再产出任何报告文字。
      // 采集结果 + 数值 → reviewContext.build() 干净 JSON → reviewLlm.generate() Markdown。
      const baseInput = engineInputOf(date, sources, histDates);
      const topics = topicEngines.analyzeTopics(baseInput);
      const engine = engines.analyze({ ...baseInput, topics });
      const prevDoc = readReviewSync(date);
      const prevVersion = prevDoc && (prevDoc.versions || []).find(v => v.version === prevDoc.currentVersion);
      // SCHEMA_VERSION 升级铁律：旧结构文档即使完整度持平，也必须能生成新版修订，
      // 否则旧文档会被幂等判定永久锁死，LLM 版报告永远进不来。
      const schemaOutdated = !!(prevDoc && prevDoc.schemaVersion && prevDoc.schemaVersion !== SCHEMA_VERSION);
      const lhbOk = isOk(sources, 'dragonTiger') && !!(srcData(sources, 'dragonTiger') || {}).ok;
      // 状态机保护：已升级为完整版的复盘，若本次又拿不到龙虎榜，绝不降级回 formal。
      // 例外（SCHEMA 升级铁律）：旧 schema 文档不受此保护，必须允许生成新结构修订版，
      // 否则一份 11 段时代的 complete 文档会在龙虎榜取不到的日子把 LLM 版报告永久锁死。
      // 例外（手动重跑）：opts.force 为 true 时用户明确要求重生成，不跳过。
      if (prevDoc && prevDoc.stage === STAGE_COMPLETE && !lhbOk && !schemaOutdated && !opts.force) {
        RUN.phase = 'done'; RUN.finishedAt = nowIso();
        RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '完整版已存在，本次未取到龙虎榜，不降级' };
        RUN.running = false;
        return {
          ok: true, action: 'skipped', reviewDate: date, version: prevVersion ? prevVersion.version : null,
          reason: '该日期已存在完整版（龙虎榜已补录），本次未取到龙虎榜，保留完整版不降级'
            + (schemaOutdated ? `；当前文档结构 ${prevDoc.schemaVersion} 待升级，待取数恢复后再升级` : ''),
        };
      }
      const stage = lhbOk ? STAGE_COMPLETE : STAGE_FORMAL;
      const dragonTigerStatus = lhbOk ? LHB_FILLED : LHB_PENDING;
      const P = srcData(sources, 'prevPool');
      const L = srcData(sources, 'ladder');
      const verdictRows = readHistoryVerdicts(date, sources);
      const baselines = baselinesOf(sources, L, P);
      const realCompleteness = completenessOf(sources);
      const limited = realCompleteness.score < LIMITED_THRESHOLD;
      // [20261110f B0-3] 反向联动：上一份大盘复盘（prevDate）的【明日核心观察池】，
      // 读取其中个股的「个股每日复盘」评级/放弃信号，供报告「昨日判断对照」用一句话带出。
      let stockMarks = null;
      try { stockMarks = stockReview.poolMarksSummary(prevDate); } catch (e) { stockMarks = null; }
      const context = reviewContext.build({
        date, sources, engine, topics,
        meta: { prevDate, histDates },
        stage, dragonTigerStatus,
        completeness: realCompleteness,
        baselines, verdictRows,
        stockMarks,
      });
      // 取消硬性质检：LLM 失败 / 字段为 null / 数据重复都不阻断发布，降级为数据快照照常落盘。
      RUN.phase = 'llm';
      const gen = await reviewLlm.generate(context, { stage, date, force: !!opts.force }); // [P1-1 裁决①] force 绕过 LLM 在途合并
      const markdown = gen.markdown;

      // 需求「数据更完整时生成修订版」的硬保护：偶发取数超时让本次完整度反而更低时，
      // 绝不用更差的数据覆盖当前版本（force 手动重跑也不例外）；否则一次网络抖动
      // 就会把已落盘的 100% 正式版降级成有限分析版。
      if (prevDoc && prevVersion) {
        const prevScore = prevVersion.completeness ? prevVersion.completeness.score : 0;
        // 20261110b：完整度计分口径已从「70% 源 + 30% 段状态」改为纯数据源，
        // 新旧分数不可直接比大小。结构升级必须优先，否则旧 schema 文档会永久锁死新报告。
        if (!schemaOutdated && realCompleteness.score < prevScore) {
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
        // 20261110b：历史判断基准作为纯数据注入 Context，由 LLM 自行做对照，
        // 代码不再生成「历史判断对照」段落文案。旧文档仍可经 nextChecklist 兼容读取。
        baselines,
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
        stage, dragonTigerStatus,
        trigger, generatedAt: nowIso(), localTime: localDateTime(),
        completeness: realCompleteness,
        limited: realCompleteness.score < LIMITED_THRESHOLD,
        limitedReason: realCompleteness.score < LIMITED_THRESHOLD
          ? `数据源完整率 ${realCompleteness.score}% < ${LIMITED_THRESHOLD}%，报告中已如实说明暂无数据的维度`
          : null,
        engineVersion: engine.schemaVersion,
        topicVersion: topics.schemaVersion,
        histDates, prevDate,
        sources: sources.map(s => ({
          key: s.key, label: s.label, category: s.category, status: s.status,
          source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt, note: s.note,
        })),
        // 20261110b 新输出契约：整篇 Markdown + 它所依据的干净 JSON Context。不再有 sections / quality。
        outputFormat: 'markdown',
        markdown, context,
        llm: {
          ok: gen.ok, degraded: gen.degraded, model: gen.model,
          promptFile: gen.promptFile, error: gen.error,
          elapsedMs: gen.elapsedMs, contentChars: gen.contentChars,
        },
        snapshot,
      };
      const doc = {
        schemaVersion: SCHEMA_VERSION, reviewDate: date, tradingDay: cal,
        status: 'ok', limited: version.limited,
        stage, dragonTigerStatus,
        outputFormat: 'markdown', markdown,
        llm: version.llm,
        currentVersion: version.version,
        versions: (prevDoc && Array.isArray(prevDoc.versions) ? prevDoc.versions : []).concat([version]),
        updatedAt: nowIso(),
      };
      writeReviewSync(doc);
      RUN.phase = 'done'; RUN.finishedAt = nowIso();
      RUN.lastResult = { action: version.kind === 'official' ? 'created' : 'revision', reviewDate: date, version: version.version, completeness: realCompleteness.score, limited: version.limited, stage, llmOk: gen.ok };
      RUN.running = false;
      const prevScoreText = prevVersion && prevVersion.completeness ? prevVersion.completeness.score : MISSING;
      const revisionReason = schemaOutdated
        ? `复盘结构升级（${prevDoc.schemaVersion} → ${SCHEMA_VERSION}，完整度 ${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`
        : `数据更完整（${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`;
      return {
        ok: true, action: version.kind === 'official' ? 'created' : 'revision',
        reviewDate: date, version: version.version, completeness: realCompleteness,
        limited: version.limited, stage, dragonTigerStatus,
        outputFormat: 'markdown', llm: version.llm,
        message: (version.kind === 'official' ? '正式版已生成' : revisionReason)
          + (stage === STAGE_FORMAL ? '（龙虎榜待晚间补录）' : '（龙虎榜已发布，完整版）')
          + (gen.ok ? ` · AI 生成（${gen.model || '模型'}，${gen.contentChars} 字）` : ' · AI 暂不可用，已发布数据快照'),
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

/**
 * 龙虎榜异步补录：formal → complete（规格第三部分）。
 * 触发点：20:30 定时槽 / task_type="dragon_tiger_update" / 次日 15:35 兜底。
 * 设计约束（20261110b 更新）：
 *  - 只重新抓「当日龙虎榜」这一项，不重跑全部数据源；
 *  - 不再「只改第八段」：把新龙虎榜并入干净 JSON Context，重新调用 LLM 生成整篇 Markdown，
 *    让盘后资金数据自然融入归因（不是硬贴一段代码拼装的文案）；
 *  - 同一日期 complete 只允许一份，已存在则静默跳过；非交易日静默跳过；
 *  - 仍未发布时保持 formal（不写 failed 快照、不标「接口故障」），等下一次补录；
 *  - LLM 失败不阻断补录，降级为数据快照照常发布。
 */
async function backfillDragonTiger(date, opts = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : localDate();
  const trigger = opts.trigger || 'cron';
  const doc = readReviewSync(d);
  if (!doc || doc.status !== 'ok') {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '该日期尚无正式版，先生成正式版再补录' };
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '该日期为旧结构文档，待结构升级后再补录龙虎榜' };
  }
  if ((doc.versions || []).some(v => v && v.stage === STAGE_COMPLETE)) {
    return { ok: true, action: 'skipped', reviewDate: d, version: doc.currentVersion, stage: STAGE_COMPLETE, reason: '完整版已存在，静默跳过（同一日期 complete 只允许一份）' };
  }
  let cal;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(d); }
  catch (e) { cal = { is_trading_day: null, reason: '交易日历表查询失败：' + e.message }; }
  if (cal.is_trading_day === false) {
    return { ok: true, action: 'skipped_holiday', reviewDate: d, reason: `非交易日（${cal.day_type || '休市'}），静默跳过补录` };
  }
  const cur = (doc.versions || []).find(v => v.version === doc.currentVersion) || (doc.versions || []).slice(-1)[0];
  if (!cur || !cur.context || typeof cur.markdown !== 'string') {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '当前版本无可用 JSON Context / Markdown，跳过补录' };
  }

  // 只抓龙虎榜：清缓存后走 --lhb-only，避免命中 15:35 那次「尚未发布」的空结果。
  let H = null, fetchErr = '';
  try {
    const bd = require('./boardReviewData');
    bd.clearCache();
    const raw = await withTimeout(bd.getLhbOnly(d), 60000, '龙虎榜补录取数');
    H = raw && raw.lhb;
  } catch (e) { fetchErr = String((e && e.message) || e).slice(0, 160); }
  const usable = !!(H && H.ok !== false && num(H.count) != null);
  if (!usable) {
    doc.lastBackfillAttempt = { at: nowIso(), localTime: localDateTime(), result: 'pending', reason: fetchErr || (H && H.note) || '盘后数据尚未发布' };
    writeReviewSync(doc);
    return {
      ok: true, action: 'pending', reviewDate: d, stage: STAGE_FORMAL,
      reason: `龙虎榜盘后数据尚未发布${fetchErr ? '（本次取数：' + fetchErr + '）' : ''}，保持正式版「待晚间补录」，不落失败快照`,
    };
  }

  const backfillAt = localDateTime();
  // 20261110b：把新龙虎榜并入干净 Context，重新交给 LLM 生成整篇 Markdown。
  const newSources = (cur.sources || []).map(s => s.key === 'dragonTiger'
    ? { ...s, status: 'ok', source: H.source || s.source, asOf: H.asOf || d, fetchedAt: nowIso(), note: '' }
    : s);
  const base = cur.context || {};
  const context = {
    ...base,
    meta: { ...(base.meta || {}), reviewDate: d, stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED },
    dragonTiger: reviewContext.lhbBlock(H, d, H.source || null, true),
    sources: (base.sources || newSources).map(s => s.key === 'dragonTiger'
      ? { ...s, status: 'ok', source: H.source || s.source, asOf: H.asOf || d, fetchedAt: nowIso(), note: null }
      : s),
    missing: (base.missing || []).filter(m => m.key !== 'dragonTiger'),
  };
  const completeness = completenessOf(newSources);
  const gen = await reviewLlm.generate(context, { stage: STAGE_COMPLETE, date: d });
  const markdown = gen.markdown;
  const nextVersion = (doc.currentVersion || 0) + 1;
  const version = {
    ...cur,
    version: nextVersion, kind: 'revision',
    stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED,
    trigger, generatedAt: nowIso(), localTime: backfillAt,
    completeness, sources: newSources,
    outputFormat: 'markdown', markdown, context,
    llm: {
      ok: gen.ok, degraded: gen.degraded, model: gen.model,
      promptFile: gen.promptFile, error: gen.error,
      elapsedMs: gen.elapsedMs, contentChars: gen.contentChars,
    },
    snapshot: { ...(cur.snapshot || {}), lhb: { count: H.count, asOf: H.asOf || d, netBuyTotal: H.netBuyTotal } },
  };
  delete version.sections;   // 旧结构字段不残留，避免前端误判
  delete version.quality;
  const doc2 = {
    ...doc,
    stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED,
    outputFormat: 'markdown', markdown, llm: version.llm,
    currentVersion: nextVersion,
    versions: (doc.versions || []).concat([version]),
    updatedAt: nowIso(),
    lastBackfillAt: { at: nowIso(), localTime: backfillAt, result: gen.ok ? 'completed' : 'completed_degraded', count: H.count },
  };
  writeReviewSync(doc2);
  return {
    ok: true, action: 'completed', reviewDate: d, version: nextVersion,
    stage: STAGE_COMPLETE, completeness: completeness.score, lhbCount: H.count, llmOk: gen.ok,
    reason: `已补录当日龙虎榜（上榜 ${H.count} 家），` +
      (gen.ok ? '大模型已重新生成完整版 Markdown' : 'LLM 不可用，已降级为数据快照并照常发布'),
  };
}

/** 次日兜底用：判断某日期是否仍停留在「待补录」状态。 */
function needsBackfill(date) {
  const doc = readReviewSync(date);
  if (!doc || doc.status !== 'ok') return false;
  if (doc.schemaVersion !== SCHEMA_VERSION) return false;
  if ((doc.versions || []).some(v => v && v.stage === STAGE_COMPLETE)) return false;
  return (doc.dragonTigerStatus || LHB_PENDING) === LHB_PENDING;
}

function recordSkip(date, trigger, cal) {
  const rec = { reviewDate: date, status: 'skipped_holiday', trigger, dayType: cal.day_type || MISSING, reason: '非交易日静默跳过', at: nowIso(), localTime: localDateTime() };
  SKIP_LOG.unshift(rec);
  if (SKIP_LOG.length > MAX_SKIP_LOG) SKIP_LOG.length = MAX_SKIP_LOG;
  try {
    ensureDir();
    const f = path.join(REVIEW_DIR, '_scheduler.json');
    let arr = store.readJsonSafe(f, []).data;
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(rec);
    store.writeJsonAtomic(f, arr.slice(0, MAX_SKIP_LOG));
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
  try { if (fs.existsSync(failedFile(date))) failed = store.readJsonSafe(failedFile(date), null).data; } catch (e) { /* ignore */ }
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
      eveningSlot: '20:30', nextDayFallback: '15:35 先检查昨日是否补录',
      backfillTaskType: 'dragon_tiger_update',
      stages: [STAGE_FORMAL, STAGE_COMPLETE],
      onHoliday: 'skipped_holiday', calendarTable: 'trade_calendar',
      limitedThreshold: LIMITED_THRESHOLD, histDays: HIST_DAYS,
      outputFormat: 'markdown',
      llm: {
        enabled: true, configured: reviewLlm.isConfigured(),
        promptFile: reviewLlm.PROMPT_FILE, timeoutMs: reviewLlm.TIMEOUT_MS,
        onFailure: '降级为数据快照，照常发布，不阻断',
      },
    },
    skipLog: SKIP_LOG.slice(0, 20), reviewDir: REVIEW_DIR,
  };
}

module.exports = {
  runReview, backfillDragonTiger, needsBackfill,
  getToday, getByDate, getHistory, getStatus,
  recordSkip, listHistorySync, readReviewSync,
  SCHEMA_VERSION, CONTEXT_VERSION, ENGINE_VERSION, TOPIC_VERSION, MISSING,
  LIMITED_THRESHOLD,
  STAGE_FORMAL, STAGE_COMPLETE, LHB_PENDING, LHB_FILLED, LHB_UNAVAILABLE,
  previousTradingDates, engineInputOf, completenessOf, baselinesOf, readHistoryVerdicts,
};
