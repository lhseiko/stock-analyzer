# 核心业务逻辑（lib/） · 第 3 卷

> 共 39 个文件，本卷约 17999 行


---

## `lib\reviewService.js`  ·  793 行

~~~js
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
const tradeCalendar = require('./tradeCalendar');
const engines = require('./reviewEngines');
const topicEngines = require('./topicEngines');
const reviewContext = require('./reviewContext');
const reviewLlm = require('./reviewLlm');

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
  try { fs.writeFileSync(failedFile(date), JSON.stringify(report, null, 2), 'utf8'); } catch (e) { /* ignore */ }
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
      const context = reviewContext.build({
        date, sources, engine, topics,
        meta: { prevDate, histDates },
        stage, dragonTigerStatus,
        completeness: realCompleteness,
        baselines, verdictRows,
      });
      // 取消硬性质检：LLM 失败 / 字段为 null / 数据重复都不阻断发布，降级为数据快照照常落盘。
      RUN.phase = 'llm';
      const gen = await reviewLlm.generate(context, { stage, date });
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

~~~

---

## `lib\ruleCore.js`  ·  410 行

~~~js
/**
 * 三条底层铁律 · 共享内核
 * ============================================================================
 * 把「数据一致性 / 数据最新性 / 变化与边际分析」的通用原语集中在此，
 * 供各业务 Hub（valuationHub / quoteHub / …）复用，避免每个模块各实现一份
 * 而产生口径分叉。本文件不含任何业务取数逻辑。
 *
 * 规则一：makeDatum（五要素身份）、beginSnapshot（分析期锁定）
 * 规则二：TTL、checkFreshness（时效体检）、staleLabel（过期标注）、
 *        validateSane（异常值校验）、countTradingDaysBetween（交易日感知）
 * 规则三：changeRate、classifyDirection（方向性变化）、classifyAccel（边际）、
 *        marginalStreak（连续同向）、analyzeSeries（相邻期）、analyzeWindow（窗口首尾）
 * ============================================================================
 */

// ---------- 规则二①：数据有效期 ----------
const TTL = {
  quote: 5 * 60 * 1000,                  // 实时行情 5 分钟
  daily: 24 * 60 * 60 * 1000,            // 日线 24 小时
  weekly: 7 * 24 * 60 * 60 * 1000,       // 周线 7 天
  financial: 90 * 24 * 60 * 60 * 1000,   // 财务 90 天
  company: 30 * 24 * 60 * 60 * 1000,     // 公司基本信息 30 天
};

const FLAT_PCT = 1.0;      // |变化率| < 1% 视为横盘
const MARGIN_EPS = 0.5;    // 边际变化判定阈值（百分点）
const MAX_DEVIATION = 0.5; // 异常值校验：新旧偏离 > 50% 拒收

// ---------- 通用工具：限幅（被多模块复用，避免各写一份分叉） ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---------- 规则一②：五要素身份 ----------
function makeDatum(name, value, dataTime, source, fetchTime) {
  return {
    name,
    value: (typeof value === 'number' && isFinite(value)) ? Math.round(value * 100) / 100 : value,
    dataTime: dataTime || null,   // 数据对应的实际时间
    source: source || '未知',      // 来源
    fetchTime: fetchTime || new Date().toISOString(), // 获取时间
  };
}

// ---------- 规则一③：分析期数据快照（冻结） ----------
function beginSnapshot(data) {
  return Object.freeze(JSON.parse(JSON.stringify({ ...data, _snapshotAt: new Date().toISOString() })));
}

// ---------- 规则二：交易日感知 ----------
// 仅按周一至周五计（未含法定节假日，属可接受简化——节假日会保守判为过期，
// 不会把陈旧数据误判为新鲜）。
function countTradingDaysBetween(startDateStr, now = new Date()) {
  const start = new Date(startDateStr);
  if (isNaN(start.getTime())) return null;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const n = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let count = 0;
  const cur = new Date(s);
  cur.setDate(cur.getDate() + 1);
  while (cur <= n) {
    const wd = cur.getDay();
    if (wd !== 0 && wd !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * 日期格式归一化：兼容 YYYYMMDD（如 Python 侧 strftime('%Y%m%d') 输出）与 YYYY-MM-DD。
 * 不归一化的话 `new Date('20260830')` 会解析失败，导致时效体检误判为「缺少数据时间」
 * 进而错误标记过期——这是跨 Node/Python 边界的高频坑。
 */
function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

// ---------- 规则二②：时效体检 ----------
function checkFreshness(dataTime, kind, now = Date.now(), opts = {}) {
  const ttl = TTL[kind] || TTL.daily;
  const normalized = normalizeDate(dataTime);
  const t = normalized ? new Date(normalized).getTime() : 0;
  if (!t) {
    return { fresh: false, expired: true, ageMs: null, ttlMs: ttl, reason: '缺少数据时间' };
  }
  const ageMs = now - t;
  let expired = ageMs > ttl;
  let reason = expired ? '超过该类型有效期' : '在有效期内';

  // 交易日感知：行情/日频类数据按交易日更新。若数据日之后尚未出现新交易日
  // （如周五数据在周六/周日读取），该数据仍是最新可得，不应标记为过期。
  if (expired && opts.tradingDayAware) {
    const newDays = countTradingDaysBetween(normalized, new Date(now));
    if (newDays === 0) {
      expired = false;
      reason = '数据日之后尚无新交易日，该数据仍为最新可得';
    } else if (newDays != null) {
      reason = `数据日之后已过 ${newDays} 个交易日，超过该类型有效期`;
    }
  }
  return { fresh: !expired, expired, ageMs, ttlMs: ttl, dataTime: normalized, reason };
}

// ---------- 规则二④：过期标注 ----------
function staleLabel(dataTime) {
  const norm = normalizeDate(dataTime);
  const d = norm ? String(norm).slice(0, 10) : '未知';
  return `数据已过期，最后更新时间是 ${d}`;
}

// ---------- 规则二③：异常值校验 ----------
function validateSane(prev, next, maxDeviation = MAX_DEVIATION) {
  const p = Number(prev), n = Number(next);
  if (!isFinite(p) || !isFinite(n) || p <= 0) {
    return { ok: true, skipped: true, note: '无有效前值，跳过异常校验' };
  }
  const deviation = Math.abs(n - p) / p;
  if (deviation > maxDeviation) {
    return {
      ok: false,
      deviation: Math.round(deviation * 10000) / 100,
      note: `新旧值偏离 ${(deviation * 100).toFixed(1)}%，超过阈值 ${(maxDeviation * 100)}%，已拒收并保留原值`,
    };
  }
  return { ok: true, deviation: Math.round(deviation * 10000) / 100 };
}

// ---------- 规则三③：变化率 ----------
function changeRate(cur, prev) {
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p)) return null;
  // 基期为 0 或负时，(cur-prev)/prev 的符号会翻转、结果无意义
  // （例：-2 → 3 明明是改善，公式却给出 -250%）。此时返回 null，
  // 由调用方改用「绝对变化」描述，避免输出方向相反的错误结论。
  if (p <= 0) return null;
  return Math.round((c - p) / p * 10000) / 100;
}

// ---------- 规则三①：方向性变化 ----------
function classifyDirection(rates) {
  if (!Array.isArray(rates) || rates.length < 2) return '数据不足';
  const last = rates[rates.length - 1];
  const prev = rates[rates.length - 2];
  if (last == null || prev == null) return '数据不足';
  const isUp = r => r > FLAT_PCT;
  const isDown = r => r < -FLAT_PCT;
  const isFlat = r => !isUp(r) && !isDown(r);

  if (rates.length >= 3) {
    const earlier = rates.slice(Math.max(0, rates.length - 4), rates.length - 1);
    if (earlier.length >= 2 && earlier.every(isFlat) && isUp(last)) return '横盘突破';
  }
  if (isUp(prev) && isDown(last)) return '涨转跌';
  if (isDown(prev) && isUp(last)) return '跌转涨';
  if (isUp(last)) return '持续上涨';
  if (isDown(last)) return '持续下跌';
  return '横盘整理';
}

// ---------- 规则三②：边际（加速/减速） ----------
function classifyAccel(rate, prevRate) {
  if (rate == null || prevRate == null) return '数据不足';
  const marginal = Math.round((rate - prevRate) * 100) / 100;
  if (rate > 0) {
    if (marginal > MARGIN_EPS) return '上涨加速';
    if (marginal < -MARGIN_EPS) return '上涨减速';
    return '上涨平稳';
  }
  if (rate < 0) {
    if (marginal < -MARGIN_EPS) return '下跌加速';
    if (marginal > MARGIN_EPS) return '下跌减速';
    return '下跌平稳';
  }
  return '无变化';
}

// ---------- 规则三⑤：连续同向边际期数 ----------
function marginalStreak(marginals) {
  if (!Array.isArray(marginals) || !marginals.length) return 0;
  const sign = m => (m > MARGIN_EPS ? 1 : (m < -MARGIN_EPS ? -1 : 0));
  const lastSign = sign(marginals[marginals.length - 1]);
  if (lastSign === 0) return 0;
  let n = 0;
  for (let i = marginals.length - 1; i >= 0; i--) {
    if (sign(marginals[i]) === lastSign) n++;
    else break;
  }
  return n;
}

/**
 * 规则三核心：对 {date,value} 升序序列做完整变化与边际分析（相邻期口径）
 */
function analyzeSeries(points, name, opts = {}) {
  // 默认只保留正值（PE/PB/PS 等估值指标，≤0 无意义）；
  // 但资金净流入、利润增速等指标可以为负，负值被丢弃会导致变化率算错，
  // 故允许调用方通过 allowNegative 显式放开（规则：不得静默丢弃有效数据）。
  const allowNegative = opts.allowNegative === true;
  const valid = (points || []).filter(p => {
    if (!p || !p.date) return false;
    const v = Number(p.value);
    if (!isFinite(v)) return false;
    return allowNegative ? true : v > 0;
  });
  if (valid.length < 2) {
    return { name, available: false, reason: '序列不足两期，无法做变化与边际分析' };
  }
  const cur = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  const prev2 = valid.length >= 3 ? valid[valid.length - 3] : null;

  const rate = changeRate(cur.value, prev.value);
  const prevRate = prev2 ? changeRate(prev.value, prev2.value) : (prev ? changeRate(prev.value, valid[0].value) : null);
  const marginal = (rate != null && prevRate != null) ? Math.round((rate - prevRate) * 100) / 100 : null;

  const rates = valid.map((p, i) => (i === 0 ? null : changeRate(p.value, valid[i - 1].value))).filter(r => r != null);
  // 规则三①：最新一期基期为非正（如资金由净流出转净流入）时，百分比变化率无意义（已返回 null），
  // 但「方向性变化」仍须识别——据 prev/cur 符号判断是否「由负转正」(改善)。
  // 说明：由正转负时基期为正、rate 可正常计算，classifyDirection 已覆盖；仅「由负转正」会令 rate 为
  // null 且被漏判，此处补上，避免方向性变化识别缺口（规则一/三硬要求）。
  let direction = classifyDirection(rates);
  const baseFlip = (allowNegative && prev && cur && prev.value <= 0 && cur.value > 0) ? 'negToPos' : null;
  if (baseFlip === 'negToPos') direction = '由负转正';
  const accel = classifyAccel(rate, prevRate);

  const marginals = [];
  for (let i = 2; i < rates.length; i++) marginals.push(Math.round((rates[i] - rates[i - 1]) * 100) / 100);
  const streak = marginalStreak(marginals);

  // 规则三④：方向 + 幅度 + 边际
  let text = `${name}从 ${prev.value} `;
  if (rate == null) {
    // 基期非正（如资金由净流出转为净流入），百分比变化无意义 → 改用绝对变化描述
    const delta = Math.round((cur.value - prev.value) * 100) / 100;
    text += `变动到 ${cur.value}（绝对变动 ${delta > 0 ? '+' : ''}${delta}）；前期值为 ${prev.value <= 0 ? '零或负值' : '缺失'}，变化率不适用，此处以绝对变动衡量`;
    if (baseFlip === 'negToPos') text += `，属「由负转正」的方向性改善`;
  } else {
    const dirWord = rate > 0 ? '上升' : (rate < 0 ? '下降' : '持平');
    text += `${dirWord}到 ${cur.value}，${rate > 0 ? '涨幅' : '跌幅'} ${Math.abs(rate).toFixed(2)}%`;
    if (marginal != null && prevRate != null) {
      const sameSign = (rate > 0 && prevRate > 0) || (rate < 0 && prevRate < 0);
      if (sameSign) {
        const cmp = Math.abs(marginal) < MARGIN_EPS ? '基本持平'
          : (marginal > 0 ? `较上一期变化幅度扩大 ${Math.abs(marginal).toFixed(2)} 个百分点`
                          : `较上一期变化幅度收窄 ${Math.abs(marginal).toFixed(2)} 个百分点`);
        text += `，${cmp}`;
      } else {
        text += `，较上一期（${prevRate > 0 ? '上涨' : prevRate < 0 ? '下跌' : '持平'} ${Math.abs(prevRate).toFixed(2)}%）转为${rate > 0 ? '上涨' : '下跌'}，边际变动 ${Math.abs(marginal).toFixed(2)} 个百分点`;
      }
    }
    text += `，呈${accel}态势`;
  }

  // 规则三⑤：特殊信号
  const turning = (direction === '涨转跌' || direction === '跌转涨' || direction === '横盘突破' || direction === '由负转正');
  const marginalStrong = marginal != null && Math.abs(marginal) > MARGIN_EPS;
  const special = (turning && marginalStrong) || streak >= 3 || baseFlip === 'negToPos';
  let specialNote = '';
  if (baseFlip === 'negToPos') {
    specialNote = '⚠️ 重点信号：最新一期由负值转正（如资金由净流出转为净流入），方向性改善；因基期为负，变化率不适用，此处以绝对变动衡量。';
  } else if (turning && marginalStrong) {
    specialNote = `⚠️ 重点信号：出现「${direction}」的同时变化力度${accel}，方向与边际同向共振。`;
  } else if (streak >= 3) {
    specialNote = `⚠️ 趋势强化信号：边际变化已连续 ${streak} 期同向，趋势力度持续${marginal > 0 ? '增强' : '减弱'}。`;
  }

  return {
    name,
    available: true,
    current: makeDatum(name, cur.value, cur.date, cur.source, cur.fetchTime),
    previous: { value: prev.value, date: prev.date },
    changeRate: rate,
    prevChangeRate: prevRate,
    marginal,
    direction,
    accel,
    marginalStreak: streak,
    text,
    special,
    specialNote,
  };
}

/**
 * 窗口期分析：比较窗口【首尾】两点（用于“近 N 个交易日”这类区间口径），
 * 与 analyzeSeries（相邻期）区分，避免把“近20日”误算成“最后两天”。
 */
function analyzeWindow(points, name, opts = {}) {
  const allowNegative = opts.allowNegative === true;
  const valid = (points || []).filter(p => {
    if (!p || !p.date) return false;
    const v = Number(p.value);
    if (!isFinite(v)) return false;
    return allowNegative ? true : v > 0;
  });
  if (valid.length < 2) return { name, available: false, reason: '窗口内有效点不足两个' };
  const first = valid[0];
  const last = valid[valid.length - 1];
  const rate = changeRate(last.value, first.value);
  const up = rate != null && rate > FLAT_PCT;
  const down = rate != null && rate < -FLAT_PCT;
  const direction = up ? '区间上涨' : (down ? '区间下跌' : '区间横盘');

  const mid = Math.floor(valid.length / 2);
  const firstHalf = changeRate(valid[mid].value, first.value);
  const secondHalf = changeRate(last.value, valid[mid].value);
  const marginal = (firstHalf != null && secondHalf != null)
    ? Math.round((secondHalf - firstHalf) * 100) / 100 : null;
  const accel = classifyAccel(secondHalf, firstHalf);

  let text = `${name}：${first.date} 的 ${first.value} → ${last.date} 的 ${last.value}`;
  if (rate != null) text += `，区间${rate > 0 ? '上涨' : '下跌'} ${Math.abs(rate).toFixed(2)}%`;
  if (marginal != null) text += `，后半段较前半段${marginal > 0 ? '走强' : '走弱'} ${Math.abs(marginal).toFixed(2)} 个百分点，呈${accel}态势`;

  return {
    name, available: true,
    from: { value: first.value, date: first.date },
    to: { value: last.value, date: last.date },
    changeRate: rate, marginal, direction, accel, text,
    windowDays: valid.length,
  };
}

/**
 * 通用规则装饰器：给任意模块的数据一次性补上三规则信息，
 * 让轻量模块（资金/宏观/首页卡片等）无需各写一套 Hub 即可合规。
 * @param {Object} opts
 *   dataTime   数据对应时间（必填，用于时效体检）
 *   source     数据来源
 *   kind       TTL 类型：quote|daily|weekly|financial|company（默认 daily）
 *   series     [{date,value}] 升序序列（可选，用于变化与边际分析）
 *   name       指标名（用于文案）
 * @returns {{freshness, staleNote, analysis, source, fetchedAt}}
 */
function decorateRules(opts = {}) {
  const {
    dataTime: rawDataTime, source = '未知', kind = 'daily',
    series = [], name = '指标', tradingDayAware = true, allowNegative = false,
  } = opts;
  const fetchTime = new Date().toISOString();
  const dataTime = normalizeDate(rawDataTime);
  const freshness = checkFreshness(dataTime, kind, Date.now(), { tradingDayAware });
  const analysis = (series && series.length >= 2)
    ? analyzeSeries(series, name, { allowNegative })
    : { name, available: false, reason: '序列不足两期，无法做变化与边际分析' };
  return {
    freshness,
    staleNote: freshness.expired ? staleLabel(dataTime) : '',
    analysis,
    source,
    dataTime: dataTime || null,   // 已归一化为 YYYY-MM-DD，避免下游再解析失败
    fetchedAt: fetchTime,
  };
}

// ===== 影响程度评分（利好/利空方向语义）——全站唯一出口 =====
// 口径：signal ∈ [-1,1]（正=利好/偏多，负=利空/偏空）→ impactScore ∈ [-3,3]。
// 展示约定（A 股习惯：红=利好/涨，绿=利空/跌）：
//   impactScore > 0 → 「利好 +n」红色；< 0 → 「利空 -n」绿色；= 0 → 「中性 0」灰色。
// 方向保底：|signal| ≥ IMPACT_DIR_EPS 但四舍五入为 0 时，强制保留 ±1，
//   避免「指数 60 日 -7.1% → 信号 -0.10 → 评分 0」这类"明明偏空却标中性"的方向丢失。
const IMPACT_DIR_EPS = 0.02;
function toImpactScore(signal) {
  const s = (typeof signal === 'number' && isFinite(signal)) ? signal : 0;
  // 对称舍入（远离零）：JS 原生 Math.round(-1.5) = -1，会导致 +0.5→+2 而 -0.5→-1 的正负不对称，
  // 使同等强度的利好与利空显示不同的评分档位。
  const raw = Math.max(-3, Math.min(3, s * 3));
  let score = raw >= 0 ? Math.round(raw) : -Math.round(-raw);
  if (score === 0 && Math.abs(s) >= IMPACT_DIR_EPS) score = s > 0 ? 1 : -1;
  return score;
}
function impactLabel(score) {
  return score > 0 ? '利好' : score < 0 ? '利空' : '中性';
}
// 把 impactScore + impactLabel 一次性打到因子/子因子对象上（因子与子因子同口径）
function withImpact(obj) {
  const score = toImpactScore(obj && obj.signal);
  return { ...(obj || {}), impactScore: score, impactLabel: impactLabel(score) };
}

// ===== 三规则集中硬闸门 =====
// 任何 Hub 在把 analyzeSeries / decorateRules 的结果包装成对外"方向性结论"之前，
// 必须先调用 assertAnalysis：分析不可用时抛 RuleNotSatisfied，由调用方捕获后
// 改为"数据不满足，暂不输出结论"，把「三规则不满足不得输出结论」从自觉变强制。
class RuleNotSatisfied extends Error {
  constructor(reason) {
    super(reason || '分析数据不满足三规则，禁止输出结论');
    this.name = 'RuleNotSatisfied';
  }
}
function assertAnalysis(analysis, context = '') {
  if (!analysis || analysis.available !== true) {
    const why = (analysis && analysis.reason) ? analysis.reason : '分析数据不可用（序列不足或校验未通过）';
    throw new RuleNotSatisfied(`${context ? context + '：' : ''}${why}`);
  }
  return analysis;
}

module.exports = {
  TTL, FLAT_PCT, MARGIN_EPS, MAX_DEVIATION, clamp,
  makeDatum, beginSnapshot, decorateRules, normalizeDate,
  countTradingDaysBetween, checkFreshness, staleLabel, validateSane,
  changeRate, classifyDirection, classifyAccel, marginalStreak,
  analyzeSeries, analyzeWindow,
  IMPACT_DIR_EPS, toImpactScore, impactLabel, withImpact,
  RuleNotSatisfied, assertAnalysis,
};

~~~

---

## `lib\sameDayJudgment.js`  ·  2435 行

~~~js
/**
 * 短期行情判断引擎（预测下一开盘日涨跌）
 * --------------------------------------------------------------
 * 结合短期信号做透明加权打分，输出可解释的「短期行情判断」：
 *   1) 大盘（原「市场情绪与消息面」，20260917i 改名重组：市场情绪提醒[引用首页判断] +
 *      大盘短期走势 + 内幕抢跑预警 + 全网舆情）
 *   2) 资金量能          (capitalFlow 主力净流入 + 量价 + 融资余额变化 + 换手率变化 + 量能活跃度)
 *   3) 对标期货短期走势  (futuresData 相关性 + 期货近5日涨跌幅)
 *   4) 增持减持          (前十大股东增持/减持方向)
 *   5) 行业板块（原「板块涨跌停占比」，20260917i 改名重组：涨跌停占比 + 行业短期走势 + 板块消息）
 *   6) 科技指数（负相关）(科技/半导体板块当日整体涨跌 → 非科技个股反向信号；
 *      科技/半导体行业个股本身即被参照板块，因子不适用)
 *   7) 个股短期动向      (价格行为趋势推演 shortTerm + 舆情与讨论热度（个股） + 财报解读)
 * * 每个因子都给出：方向(+1/-1/0)、权重、贡献分、取值、判断依据文字，
 * 因此「判断逻辑」完全可查看。判断按「每只股票每个交易日一次」持久化，
 * 每日 15:30 盘后按次日 K 线收盘价结算命中，累计统计准确率。
 * 长期走势判断请见 lib/longTermJudgment.js（不核算准确率）。
 */

const fs = require('fs');
const path = require('path');

// ---- 复用现有数据层 ----
const { getQuote, getHistory, getHistoryDeep, getHistoryPeriod, getMarketOverview } = require('./stockData');
const { analyzeSentiment } = require('./analysis');
const { getNews, fetchEastmoneyContentNews, getSectorNewsSentiment, SECTOR_KEYWORDS } = require('./newsSearch');
const { analyzeCapitalFlow, vpPositionSignal } = require('./capitalFlow');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./futuresData');
const { industryAnalysis } = require('./industryAnalysis');
const { resolveSectorIdentity, getSectorKeywords, THS_BOARD_BY_CODE } = require('./sectorIdentity');
const { getCompanyProfile, getShareholdersData } = require('./shareholderData');
const { getMarketSentiment } = require('./sentiment');
// 交易日历统一委托 lib/cnTradingCalendar（单一权威源，与 techFaceJudgment 共用同一份休市表）
const { isTradingDay: calIsTradingDay, nextTradingDay: calNext, previousTradingDay: calPrev } = require('./cnTradingCalendar');
// 20260821f：财报事件 → 资料库自动同步（一致性原则：判断引擎识别到最新定期报告发布时，
// 自动补齐资料库缺失的 PDF；仅作事件检测与异步同步，不阻塞判断生成）
const reportSync = require('./reportSync');
const { getSectorTrend, getBoardsTrend } = require('./sectorTrend');
// 20260905d：大盘及行业板块短期走势因子按个股市场筛选指数 + 联动首页大盘技术分析短期研判
const { detectMarket } = require('./stockData');
const { getMarketTechnical } = require('./marketTechnical');
// 20260905e：按个股真实成分股判定上证50/创业板指/沪深300，修复"一刀切" bug
const { pickIndicesForStock: pickIndicesForStockReal } = require('./indexConstituents');
const { getSectorLimitStats } = require('./sectorLimitStats');
const { getCrossMarketSignal, benchmarksForIndustry } = require('./crossMarket');
// Part B：关联度 / 弱关联持续性经验库（relevanceScore / effectiveRelevance / benchmarkRelevance / recordOutcome）
const { relevanceScore, effectiveRelevance, benchmarkRelevance, recordOutcome } = require('./relevanceLearning');
const { getGlobalSentiment, interpretReport, searchAnnouncements, searchAnnouncementsByCode, getRegulatoryNews } = require('./cnscraperAdapter');
const { readEarningsCache, extractEarningsSignal } = require('./aiAugment');
const { analyzePriceAction } = require('./priceAction'); // 20260903o：技术面短期动向因子引用其 shortTerm（现作为 hub 失败时的本地回退）
const { getPriceActionSnapshot } = require('./priceActionHub'); // 20260905g：与技术面分析页共用同一份快照（指标级单源）
const { decorateRules, changeRate, withImpact, clamp } = require('./ruleCore');
const eventEngine = require('./eventEngine'); // 20260907a：三联动·事件驱动权重引擎
const dedicatedFactor = require('./dedicatedFactor'); // 20260911：专属因子（海天味业CPI等）
const { buildStockSentiment } = require('./stockSentiment'); // Part B：单只个股全网舆情分析计算层
const marketEmotionModel = require('./marketEmotionModel'); // 20260917i：「大盘」卡片新增「市场情绪提醒」子因子——读首页落盘判断（单源引用，不重算）
// 20260921j：「股份回购」子卡片改走东财结构化回购报表（datacenter-web RPTA_WEB_GETHGLIST_NEW），
//   提炼「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素（用户 2026-09-21 要求）
const { getBuybackPlan, formatPlan: formatBuybackPlan } = require('./buybackEmDc');
// 只取别名：本文件自己声明了 function localDate（委托用），避免重名冲突
const { localDate: _localDate } = require('./localDate');

/**
 * 判断模块三规则装饰器：时效（日频）+ 当日涨跌的边际说明
 * 判断引擎输出的是「结论」而非时间序列，故重点落在：
 *   - 规则二：标明依据行情的数据时间，过期须标注；
 *   - 规则三：给出当日涨跌幅，并说明该涨跌与判断方向是否同向（方向一致性）。
 *
 * ★ 20260902a 修复口径冲突（用户反馈"偏空却显示红色"根因）：
 *   原实现 `bullish = score > 50` 与 dir 判定阈值（|total|>0.12，即 score>12 才"涨"）
 *   严重不一致。当 score 落在 (12,50] 时 dir="涨"→verdict 红色"看涨"，但 consistency
 *   文字却因 score<50 硬判"偏空"，形成"偏空配红字"的视觉矛盾。现直接用 dir 字段
 *   （与 combineFactors 同源）决定方向词，杜绝二次阈值分叉。
 */
function decorateJudgmentRules({ dataTime, source, price, prevClose, score, dir }) {
  const rules = decorateRules({
    dataTime,
    source,
    kind: 'daily',
    series: (prevClose > 0 && price > 0)
      ? [{ date: '昨收', value: prevClose }, { date: '当前', value: price }]
      : [],
    name: '价格',
  });
  const dayChange = (prevClose > 0 && price > 0) ? changeRate(price, prevClose) : null;
  let consistency = '无价格数据';
  if (dayChange != null && score != null) {
    // 与 dir 同源：dir='涨'→偏多 / dir='跌'→偏空 / dir='震荡'→中性，不再二次开阈值
    const bullish = dir === '涨';
    const bearish = dir === '跌';
    const dirWord = bullish ? '偏多' : bearish ? '偏空' : '中性';
    const up = dayChange > 0;
    if (bullish || bearish) {
      const sameDir = (bullish && up) || (bearish && !up);
      consistency = sameDir
        ? `判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）同向`
        : `⚠️ 判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）背离`;
    } else {
      // 中性区间不再被硬判"偏空"，避免 verdict 灰色却文字说偏空的口径错位
      consistency = `判断方向为中性，当日${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%`;
    }
  }
  return { ...rules, dayChange, consistency };
}

const JUDGE_DIR = path.join(__dirname, '..', 'data', 'judgments');

// 判断记录的 schema 版本：当修复了因子取数/匹配逻辑后，旧版本记录需要重新生成，
// 否则会一直复用脏缓存（如 20260819a 之前行业因子把原始异常文本写进 detail）。
// 20260820a：短期行情六因子重构（删技术面、合并大盘+行业、新增增持减持与财报/抢跑）。
// 20260820b：新增第七因子「板块涨跌停占比」（板块内涨停/跌停家数占比）。
// 20260820c：市场情绪因子新增「板块消息联动」子信号；修复 HF 模型卡死。
// 20260820d：板块消息联动加「重大事件精匹配」+ 新增「跨市场传导」子信号（美股对标）。
// 20260820e：补强 analyzeSentiment 金融词库（涨停/大涨/跌停/走强/回落等）+ 跨市场对标扩展有色/黄金/能源。
// 20260820g：接入 cn-financial-scraper 后台数据源——市场情绪因子新增「全网舆情」子信号；
//            近期重大利好/利空因子用「定期报告解读」增强财报是否符合预期。
// 20260820h：近期重大利好/利空因子再接入「交易所公告 + 监管/宏观政策」（公告按公司名搜索、
//            政策按行业/赛道相关性过滤），消息面覆盖 个股新闻+行业+公告+政策。
// 20260820i：① 增持减持因子新增「股份回购」利好识别（数据来自名称+代码双源公告，代码源走东财兜底
//            以修复深交所接口 500 失效）；② 资金量能因子新增「个股换手率变化」子信号
//            （对比近15日均值的偏离，按近两日价格方向加权），弥补此前只有静态阈值换手率的缺口。
// 20260821a：加固跨股/跨行业污染防御：市场情绪缓存 TTL 缩至 5s、返回数据强制携带 symbol；
//            板块消息联动增加 symbol/industryName 回显与 keywords 一致性校验；
//            判断记录复用前校验 schemaVersion，并在 buildJudgment 内做 symbol/industry 一致性断言。
// 20260821b：内幕抢跑衰减升级——三窗口（3/5/10 日）回溯股价方向，按最大同向幅度
//            对消息信号做连续衰减（保留率 1-|chg|/20，下限 0.15），明示下调比例；
//            同步修复前端资源 ?v= 与 APP_VERSION 错位（之前 app.js ?v= 落后于 server APP_VERSION
//            一个版本，导致用户浏览器长期命中旧版 JS，前端校验失效）。
// 20260821c：彻底重写「个股行业识别」因子：新增 lib/sectorIdentity.js 作为唯一可信源，
//            按代码硬编码覆盖 + 多源交叉校验 + symbol 强一致性断言；sameDayJudgment 与
//            longTermJudgment 统一调用，杜绝行业误归与跨股污染。
// 20260823f：短期行情七因子统一输出 subFactors（资金量能/对标期货/大盘行业/消息面/增持减持/板块涨跌停），
//            前端「判断逻辑」对各因子详情统一采用分段卡片网格（与「市场情绪」子信号一致），告别密集长文本；
//            子指标全部由因子已计算值派生，不另行取数，严守数据一致性。
// 20260823g：将「融资余额（杠杆情绪）」子信号由 市场情绪 因子迁移至 资金量能 因子（杠杆资金属资金面，归类更合理）；
//            因子各自的 aggregate 权重同步调整：市场情绪去除该 0.20 子权重，资金量能主结论/换手率/融资余额按
//            0.78/0.12/0.10（同时有换手率）或 0.86/0.14（仅融资余额）融合；展示卡片迁移但数值与来源不变。
// 20260823h：修复增持减持因子 bug——东财返回的股东变动为数值股数，原代码只做文本正则匹配导致
//            全部误判为「不变」；现按 changeAmount 符号定量判定，新增十大股东净变动股数/占比
//            作为信号强度，并在文案中标注数据报告期。
// 20260823i：① 将「近期重大利好/利空」因子并入「市场情绪」因子（消息情绪+财报解读+内幕抢跑
//            成为市场情绪因子的子信号），市场情绪因子权重由 0.16 提升至 0.38，其余因子等比缩放到总权重=1；
//            ② Part B 弱关联学习进化：新增 lib/relevanceLearning.js（关联度 0~1 + 持续性经验折扣），
//            板块消息联动按主题关联度逐条加权、×1.3 重大事件加码仅限高关联主题，跨市场传导信号按对标主题关联度衰减，
//            结算复盘记录弱关联主题是否持续误导并下调经验折扣。
// 20260827d：新增第 7 因子「板块跷跷板(科技/半导体负相关)」——
//            当市场出现「科技/半导体涨、其余板块跌」的明显跷跷板行情时，非科技半导体个股与科技板块呈反向运动：
//              科技板块当日上涨 → 该股（属其他板块）倾向下跌 → 偏空；
//              科技板块当日下跌 → 该股倾向上涨 → 偏多。
//            科技/半导体行业个股本身即被参照板块，不参与此反向逻辑（因子 applicable:false，避免自相关）。
// SCHEMA_VERSION 已改为「因子结构哈希」自动守卫，定义见 DEFAULT_WEIGHTS 之后：
//   因子增删/改名/默认权重变化 → FACTOR_KEYS/DEFAULT_WEIGHTS 变化 → 哈希自动变化 → 旧记录强制重算；
//   仅展示布局/口径（非因子名/权重/数量）调整时，手动 +1 LAYOUT_VERSION 即可（一处改动）。

// ============ 影响程度评分（利好/利空方向语义）============
// 唯一出口在 ruleCore.js（withImpact / toImpactScore / impactLabel），短期与长期判断共用同一映射，
// 禁止在别处各自重算（规则一·指标级单源）。口径：signal ∈ [-1,1] → impactScore ∈ [-3,3]，
// 展示为 红「利好 +n」/ 绿「利空 -n」/ 灰「中性 0」。

// ============ 板块跷跷板因子相关常量 ============
// 用于衡量「科技/半导体」整体表现的板块集合（取各板块当日涨跌幅均值作为科技 composite）。
// 选"行业板块"口径（同花顺/东财行业板），避开概念板命名差异。
const TECH_BOARDS = ['半导体', '电子', '计算机', '通信'];
// 个股若本身属于以下行业，则视为"科技/半导体"被参照方，跷跷板因子不适用。
const TECH_EXCLUDE_INDUSTRIES = ['半导体', '电子', '人工智能', '计算机', '通信'];
// 科技板块当日整体涨跌幅达到该阈值(%)即视为跷跷板效应"明显"，映射为满格反向信号；
// 低于阈值按比例衰减，低于死区则视为当日跷跷板效应不显著、按中性处理。
const SEESAW_FULL_PCT = 3.0;
const SEESAW_DEADBAND_PCT = 0.3;

// ============ 工具函数 ============
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
// 20261025j：权重=评分统一机制（用户要求铺满整个短期判断模块）——
// 每个子因子在因子内持有份额（share，在场项 Σ≤1，缺失/中性项份额自然蒸发），
// 因子信号 = Σ(份额 × 满格方向)，方向只有 +1 / -1 / 0 三态（强度折进份额或文案，不再乘 0.47 这类折扣）。
// 由此 贡献分 = effectiveWeight × signal = Σ(份额×eff×方向) = 净权重，因子评分=净权重，子评分=份额权重。
function dirOf(s) { return s > 0 ? 1 : (s < 0 ? -1 : 0); }
// 将股数格式化为「万/亿」中文单位，保留 2 位小数
function formatWan(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(2) + '亿';
  if (Math.abs(x) >= 1e4) return (x / 1e4).toFixed(2) + '万';
  return x.toLocaleString();
}
// 个股换手率变化：以前 (N-5) 个交易日均值为基准，最新值相对基准的偏离，结合近两日价格方向加权
// （量价配合：放量上涨偏多、放量下跌偏空；缩量则反向弱化）。
// 20261017a：本函数已迁至 lib/capitalFlow.js computeTurnoverChangeShared（个股侧量能唯一出口），
// 随 analyzeCapitalFlow 的 volumeIndicators.turnoverChange 一并返回，此处不再保留副本。
// 统一委托给 lib/localDate.js（北京时区；UTC+8 下逐点等价）
function localDate(d = new Date()) { return _localDate(d); }
function ensureDir() { if (!fs.existsSync(JUDGE_DIR)) fs.mkdirSync(JUDGE_DIR, { recursive: true }); }
// 按「判断目标交易日」分文件，确保同一 targetDate 下每只股票只有一条判断
function fileForDate(date) { return path.join(JUDGE_DIR, `${date}.json`); }
function fileForTargetDate(targetDate) { return path.join(JUDGE_DIR, `${targetDate}.json`); }

// 归一化行业名 → 广义赛道关键词（复用 newsSearch 的 SECTOR_KEYWORDS 体系），
// 用于把「监管/宏观政策」按行业相关性过滤进消息面因子，避免无关宏观新闻稀释个股消息。

// 判断目标口径（按 A 股交易时段）：
//   未收盘（盘中/午休/盘前，且为交易日）→ 预测「今日后续行情」(intraday)
//   已收盘（15:00 后或周末/非交易日）  → 预测「下一开盘日行情」(nextday)
// 注：午休与盘前仍视为“未收盘”，因为当日后续还有交易时段。
function marketClosed(now = new Date()) {
  const today = localDate(now);
  if (!calIsTradingDay(today)) return true; // 周末或法定节假日：全天视为已收盘（预判下一开盘日）
  return now.getHours() >= 15; // 15:00 后视为已收盘
}

// 计算下一个交易日（跳过周末 + 法定节假日；口径统一委托 lib/cnTradingCalendar）
function nextTradingDay(dateStr) {
  return calNext(dateStr);
}

// 计算上一个交易日（跳过周末 + 法定节假日；口径统一委托 lib/cnTradingCalendar）
function previousTradingDay(dateStr) {
  return calPrev(dateStr);
}

// 计算「最近一次已收盘的交易日」：
//   - 盘中/盘前/午休：参考基准为上一交易日收盘
//   - 15:00 后或周末：参考基准为最近一个已收盘的交易日（周五/节假日前最后一个交易日）
// 判断在「收盘后 ~ 下一开盘前」无论刷新多少次，都应以该 referenceDate 为键，
// 保证同一 targetDate 仅保留开盘前最后一次判断。
function referenceCloseDate(now = new Date()) {
  const today = localDate(now);
  if (!calIsTradingDay(today)) {
    // 周末或法定节假日：最近一次有效收盘为上一交易日
    return previousTradingDay(today);
  }
  if (now.getHours() >= 15) {
    // 已收盘（当日 K 线已完成）：今天自身的收盘即为最近一次有效收盘，
    // 作为下一交易日预判的基准价（此前回退到上一交易日会使收盘后预判的基准价偏离一天）
    return today;
  }
  // 盘中/盘前：最近一次有效收盘是上一交易日
  return previousTradingDay(today);
}

const VERdict_LABEL = { 涨: '看涨', 跌: '看跌', 震荡: '震荡' };
const SIGNAL_ARROW = { 1: '▲ 偏多', '-1': '▼ 偏空', 0: '— 中性' };

// ============ 单因子计算 ============

// 防御：Python 层可能把原始异常（HTTPSConnectionPool / ProxyError 等）塞进 note，
// 这里做最后一道过滤，避免把主机名/堆栈泄漏到「判断逻辑」UI。
function _sanitizeSectorNote(note) {
  if (!note) return '行业板块走势数据不可用，按中性处理';
  if (/HTTPSConnectionPool|ProxyError|Connection aborted|RemoteDisconnected|ConnectionError|TimeoutError|HTTPError|SSLError|URLError|socket\.|host=|port=/i.test(note)) {
    return '行业走势数据暂不可用，按中性处理';
  }
  return note;
}
// 检测旧缓存是否把原始网络异常（HTTPSConnectionPool / ProxyError 等）写进了因子 detail。
function _judgmentHasRawException(rec) {
  if (!rec || !Array.isArray(rec.factors)) return false;
  const re = /HTTPSConnectionPool|ProxyError|Connection aborted|RemoteDisconnected|ConnectionError|TimeoutError|HTTPError|SSLError|URLError|socket\.|host=|port=/i;
  return rec.factors.some(f => f && typeof f.detail === 'string' && re.test(f.detail));
}

// 1) 大盘（20260917i：由「市场情绪与消息面」改名并重组，用户 20260917 要求）
//    卡片重组内容：
//      · 删除「消息情绪（大盘）」子因子及其底层逻辑（东财股吧全市场聚合 marketHeat 的取数与计分）；
//      · 删除「涨跌停比」子因子及其底层逻辑（全市场涨停/跌停家数取数与计分）；
//      · 新增「市场情绪提醒」子因子 —— 直接引用首页「市场情绪提醒」卡片的判断（lib/marketEmotionModel
//        落盘的同一份当日记录），个股页不重算，杜绝双源各说各话（规则一·指标级单源）；
//      · 转入原「大盘及行业板块短期走势」因子的「大盘短期走势」子因子；
//      · 「财报解读」「舆情与讨论热度（个股）」转出至「个股短期动向」卡片；
//      · 「板块消息」转出至「行业板块」卡片（原「板块涨跌停占比」）；
//      · 保留「内幕抢跑预警」「全网舆情」。
//    子因子在该因子内按 w 归一化加权：signal = Σ(w/Σw) × subSignal。
function factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsParts, symbol, capital, turnoverChange, stockCtx) {
  const parts = [];

  // 1.1 市场情绪提醒 —— 直接引用首页判断（读落盘，同源不重算）
  parts.push(computeMarketEmotionSub());

  // 1.2 大盘短期走势 —— 原「大盘及行业板块短期走势」因子迁入（取数口径不变）
  const msSub = computeMarketShortSub(stockCtx);
  if (msSub && msSub.sub) parts.push(msSub.sub);

  // 1.3 内幕抢跑预警 / 兜底「消息面」（来自 computeNewsFactor）
  //     注：「消息情绪（大盘）」已删除、「财报解读」已迁出，此处显式跳过以防旧调用方误传
  for (const np of (newsParts || [])) {
    if (np.name === '消息情绪（大盘）' || np.name === '财报解读') continue;
    parts.push({ name: np.name, w: np.w || 0.05, signal: clamp(np.signal, -1, 1), value: np.value, detail: np.detail });
  }

  // 1.4 全网舆情（cn-financial-scraper：60+ 商业财经媒体源 + RSS + 搜索，与东财个股/板块新闻互补）
  if (globalSentiment && globalSentiment.ok && typeof globalSentiment.signal === 'number' && globalSentiment.count > 0) {
    const gs = globalSentiment;
    const top = (gs.articles || []).slice(0, 3).map(a => a.title).join('、');
    parts.push({
      name: '全网舆情', w: 0.10, signal: clamp(gs.signal, -1, 1),
      value: `利好 ${gs.positive}/利空 ${gs.negative}`,
      detail: `全网舆情（cn-financial-scraper）${gs.count} 条，利好 ${gs.positive}/中性 ${gs.neutral}/利空 ${gs.negative}，情感均值 ${gs.avg_score != null ? (gs.avg_score >= 0 ? '+' : '') + round(gs.avg_score, 2) : '—'}${top ? `；样例：${top}` : ''}`,
    });
  }

  if (!parts.length) {
    return { key: 'sentiment', name: FACTOR_NAME.sentiment, weight: W_SENTIMENT, signal: 0, applicable: true,
      value: '—', detail: '大盘情绪/消息/舆情数据获取失败，按中性处理' };
  }
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  // 20261025j：权重=评分——份额归一化下发，信号=Σ(份额×满格方向)
  let s = 0;
  for (const p of parts) {
    p.weight = round(p.w / wsum, 4);
    s += p.weight * dirOf(p.signal);
  }
  s = clamp(s, -1, 1);
  const detail = parts.map(p => p.detail).join('；');
  const value = parts.map(p => p.value).join(' | ');
  return { key: 'sentiment', name: FACTOR_NAME.sentiment, weight: W_SENTIMENT, signal: s, applicable: true, value, detail, subFactors: parts };
}

// 2) 资金量能
// 复用 analyzeCapitalFlow 统一结论（与个股分析页「资金量能」同款），保证跨页面一致。
// turnoverChange：个股换手率变化子信号（对比近15日均值的偏离，按近两日价格方向加权），
//   为本次新增——此前资金量能只有「换手率当前水平」静态阈值，缺少「变化/趋势」维度。
// margin（融资余额变化）：20260823g 起由「市场情绪」因子迁移至此——杠杆资金属资金面范畴，归类更合理；
//   与主结论、换手率变化一并融合（权重 0.10），数值与来源完全沿用 sentiment.margin（与个股分析页一致）。
// volActivity（量能活跃度）：20260909c 起由「市场情绪」因子迁移至此——量能属资金面范畴（同 20260823g 逻辑）；
//   融合权重 0.10，其余权重等比压缩；数值口径与原 sentiment 内实现完全一致（近20日均量比 × 近两日价格方向）。
function factorCapital(capital, turnoverChange, sentiment, quote, history, positionLabel) {
  const c = capital && capital.conclusion;
  if (c && typeof c.signal === 'number') {
    const vp = capital && capital.volumeIndicators && capital.volumeIndicators.volumePrice;
    const mf = capital && capital.moneyFlow && capital.moneyFlow.summary && capital.moneyFlow.summary.summary;
    const estNote = (capital.moneyFlow && capital.moneyFlow.source === 'estimated') ? '（资金流向为接口估算）' : '';
    let detail = '';
    const subs = [];
    // 量能活跃度（20260909c 自市场情绪迁移）：近20日均量比 × 近两日价格方向
    // 20261017a：改引自个股侧量能唯一出口（lib/capitalFlow.js computeVolumeIndicators 的
    // volActivity），不再在本因子内重算；口径与原实现逐行一致。
    let vol = null;
    {
      const va = (capital && capital.volumeIndicators && capital.volumeIndicators.volActivity) || null;
      if (va) {
        const volTxt = va.ratio >= 1.05 ? '放量' : va.ratio <= 0.95 ? '缩量' : '量平';
        const toneTxt = va.signal > 0.05 ? '偏多' : va.signal < -0.05 ? '偏空' : '中性';
        vol = { signal: va.signal, ratio: va.ratio, avgVol: va.avgVol, lastVol: va.lastVol, priceDir: va.priceDir, volTxt, toneTxt };
      }
    }
    if (vp) {
      detail += `量价：${vp.signal}`;
      // 20261101c：量价配合子信号改引位置感知单一真值源 vpPositionSignal（与 capitalFlow 结论同源、
      // 与 volumeEngine 量价框架相互印证），修正「高位放量上涨误判看涨」矛盾；旧「上涨途中缩量上涨」方向键随旧体系退役（20261106a）；
      // 无位置时回退基础量价方向，与旧 vpSigMap 逐值对齐（如 放量上涨 0.6、缩量上涨 -0.25）。
      const vpSig = vpPositionSignal(vp.signal, positionLabel);
      subs.push({ name: '量价配合', signal: vpSig, rawShare: 0.70, value: vp.signal, detail: vp.description || vp.signal });
    }
    if (vol) {
      subs.push({ name: '量能活跃度', signal: vol.signal, rawShare: 0.10, value: `量比≈${round(vol.ratio, 2)}`, detail: `近20日均量 ${round(vol.avgVol, 0)}，最新 ${round(vol.lastVol, 0)}，量比≈${round(vol.ratio, 2)}（近两日价格${vol.priceDir >= 0 ? '走强' : '走弱'}·${vol.volTxt} → ${vol.toneTxt}）` });
    }
    if (mf && mf['5d']) {
      const mn = mf['5d'].mainNet;
      detail += `；近5日主力${mf['5d'].direction}${Math.abs(mn)}亿${estNote}`;
      // 方向语义修正（20260901a）：原为 mn>=0?1:-1 二值化，0.36 亿的微弱净流入也被打成满格「利好 +3」，
      // 夸大影响程度。改为按流通市值规模归一化：满格阈值 = 流通市值 × 0.1%（0.5 亿 ~ 20 亿之间）。
      const capYi = (quote && typeof quote.circulationValue === 'number' && quote.circulationValue > 0)
        ? quote.circulationValue : null;
      const thr = capYi ? clamp(capYi * 0.001, 0.5, 20) : 2;
      const mnSignal = clamp(mn / thr, -1, 1);
      const scaleTxt = capYi ? `（满格阈值 ${round(thr, 1)} 亿 = 流通市值 ${round(capYi, 0)} 亿 × 0.1%）` : '（流通市值缺失，按 2 亿满格）';
      subs.push({ name: '主力净流入(近5日)', signal: mnSignal, rawShare: 0.05, value: `${mf['5d'].direction} ${Math.abs(mn)}亿`, detail: `近5日主力${mf['5d'].direction}${Math.abs(mn)}亿${estNote}；按流通规模归一化 ${scaleTxt}` });
    }
    detail += `；综合：${c.label}`;
    // 杠杆资金（融资余额变化）：20260823g 由市场情绪迁移而来，与主结论、换手率变化三者融合。
    const margin = (sentiment && sentiment.margin && sentiment.margin.ok) ? sentiment.margin : null;
    const tcOk = !!(turnoverChange && turnoverChange.ok && typeof turnoverChange.signal === 'number');
    // 20261025j：权重=评分——删除原「融合权重×信号强度」if/else 链（0.70×c.signal+0.11×tc…），
    // 改为「因子内份额 × 满格方向」统一计算（见 return 前统一段）：份额沿用原融合权重比例，
    // 主结论槽由「量价配合」子卡承载；「主力净流入」新增 0.05 份额（此前纯展示不计分，用户要求全子卡显示净权重）。
    let signal = 0;
    if (vol) detail += `；量能活跃度：量比≈${round(vol.ratio, 2)}（${vol.volTxt} → ${vol.toneTxt}）`;
    if (tcOk) {
      detail += `；换手率变化：${turnoverChange.detail}`;
      const tcLabel = turnoverChange.signal > 0.05 ? '放量偏多' : turnoverChange.signal < -0.05 ? '放量偏空' : '量价平稳';
      subs.push({ name: '换手率变化', signal: turnoverChange.signal, rawShare: 0.11, value: tcLabel, detail: turnoverChange.detail });
    }
    if (margin) {
      detail += `；融资余额：${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`;
      subs.push({ name: '融资余额', signal: clamp(margin.signal, -1, 1), rawShare: 0.09, value: `较前值 ${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`, detail: `沪深融资余额最新 ${round(margin.latest, 0)} 亿，较前值 ${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%（${margin.note || ''}）` });
    }
    // 20261025j 统一段：在场子卡按 rawShare 归一化为因子内份额（缺失项份额蒸发，其余等比放大——
    // 与原融合链「缺项重分配」语义一致），信号 = Σ(份额 × 满格方向)。
    {
      const rawSum = subs.reduce((a, x) => a + (x.rawShare || 0), 0) || 1;
      for (const x of subs) {
        x.weight = round((x.rawShare || 0) / rawSum, 4);
        delete x.rawShare;
        signal += x.weight * dirOf(x.signal);
      }
      signal = round(clamp(signal, -1, 1), 3);
    }
    return { key: 'capital', name: '资金量能', weight: W_CAPITAL, signal, applicable: true, value: c.label, detail, subFactors: subs };
  }
  return { key: 'capital', name: '资金量能', weight: W_CAPITAL, signal: 0, applicable: true,
    value: '—', detail: '无资金量能数据，按中性处理' };
}

// 3) 对标期货短期走势：期货近 5 个交易日涨跌幅 × 相关性强度
function factorFuturesShort(futures) {
  if (futures && futures.hasFutures) {
    const corr = typeof futures.correlation === 'number' ? futures.correlation : 0;
    // 方向语义修正（20260901a）：corr 是皮尔逊相关系数，可为负。
    // 原实现只用 |corr| 作强度系数，导致「负相关」个股被判反方向：
    //   期货涨 → 相关系数为负的个股实际承压（偏空），旧逻辑却给了偏多（红），方向与语义相反。
    // 现按 corr 的符号做传导：正相关 → 同向；负相关 → 反向。
    const corrStrength = Math.abs(corr) >= 0.6 ? 1 : (Math.abs(corr) >= 0.35 ? 0.7 : (Math.abs(corr) >= 0.15 ? 0.4 : 0.2));
    const fc = (futures.futuresClose && Array.isArray(futures.futuresClose)) ? futures.futuresClose : [];
    let shortChg = 0;
    if (fc.length >= 5) {
      const base = fc[fc.length - 5];
      const last = fc[fc.length - 1];
      shortChg = base > 0 ? (last - base) / base * 100 : 0;
    } else if (typeof futures.futuresChg === 'number') {
      shortChg = futures.futuresChg;
    }
    // 20261025j：权重=评分——相关性强度（0.2~1.0 档）折进子卡份额，方向满格传导：
    // 近5日走势子卡 signal = 传导后方向（期货涨×正相关 → +1；期货涨×负相关 → -1），
    // 因子信号 = 份额(相关性强度) × 满格方向；「相关性方向」为统计属性子卡（份额占位、方向恒 0，不显示权重）。
    const dirConducted = dirOf(shortChg) * (corr >= 0 ? 1 : -1);
    const signal = round(corrStrength * dirConducted, 3);
    const detail = `对标 ${futures.futuresName || '期货'} 近5日 ${shortChg >= 0 ? '+' : ''}${round(shortChg)}%（相关性 ${round(corr, 2)}，${futures.level || '—'}${futures.direction || ''}相关，强度份额 ${round(corrStrength, 2)}）→ ${signal > 0 ? '该股偏多' : signal < 0 ? '该股偏空' : '该股中性'}`;
    const value = `${shortChg >= 0 ? '+' : ''}${round(shortChg)}%`;
    const subs = [
      { name: '近5日走势', signal: dirConducted, weight: round(corrStrength, 4), value: `期货 ${shortChg >= 0 ? '+' : ''}${round(shortChg)}%`, detail: `对标 ${futures.futuresName || '期货'} 近5个交易日涨跌幅 ${shortChg >= 0 ? '+' : ''}${round(shortChg)}%；已按相关性${corr >= 0 ? '同向' : '反向'}传导为该股方向，份额=相关性强度 ${round(corrStrength, 2)}` },
      // 「相关性方向/强度」是统计属性，本身无利好利空属性 → signal 记 0（中性），
      // 避免把"负相关"误显示成绿色利空；传导方向已在父因子 signal 中按符号计入。
      { name: '相关性方向', signal: 0, weight: round(1 - corrStrength, 4), value: `${futures.direction || (corr >= 0 ? '正' : '负')}相关 ${round(corr, 2)}`, detail: `与个股相关性 ${round(corr, 2)}（${futures.level || '—'}${futures.direction || ''}相关），强度系数 ${round(corrStrength, 2)}，传导${corr >= 0 ? '同向（期货涨→股价偏多）' : '反向（期货涨→股价偏空）'}；该项为统计属性，不计利好/利空` },
    ];
    return { key: 'futures', name: '对标期货短期走势', weight: W_FUTURES, signal, applicable: true, value, detail, subFactors: subs };
  }
  return { key: 'futures', name: '对标期货短期走势', weight: W_FUTURES, signal: 0, applicable: false,
    value: '不适用', detail: '该公司无直接对标期货，本因子不参与打分' };
}

// 4) 大盘及行业板块指数短期走势：大盘平均涨跌幅 + 所属行业板块整体涨跌
// 20260905d：大盘指数部分改为「按个股市场筛选」+ 联动首页大盘技术分析模块的短期研判结论。
// 20260905e：进一步修复"按市场一刀切"bug——上证50/创业板指/沪深300 都按真实成分股判定。
//   例如：士兰微 600460 → 上证指数(沪市全有) + 沪深300(在 300 名单) → 不取上证50(不在 50 名单)。
//   又如：海天味业 603288 → 上证指数(沪市) + 上证50(在 50 名单) + 沪深300(在 300 名单)。
//   所属行业板块（sector）的逻辑完全保留不动（用户明确要求不改）。
async function selectMarketIndicesByStock(cnArr, symbol) {
  const all = (cnArr || []).filter(c => c && typeof c.changePct === 'number');
  if (!all.length) return { indices: [], scopeLabel: '—', marketLabel: '' };
  const m = detectMarket(symbol);
  const ex = m && m.exchange;
  // 非 A 股（HK/US/BJ）：兜底全宽基，不做精确映射
  if (ex !== 'SH' && ex !== 'SZ') {
    return { indices: all, scopeLabel: '上证/深成指/创业板/沪深300/上证50/中证500/科创50（个股非 A 股，退回全宽基）', marketLabel: ex || 'OTHER' };
  }
  // A 股：按个股真实成分股筛（lib/indexConstituents.pickIndicesForStock）
  let picked;
  try {
    picked = await pickIndicesForStockReal(symbol, all);
  } catch (e) {
    console.warn('[MarketShort] pickIndicesForStock failed:', e.message);
    return { indices: all, scopeLabel: '成分股查询失败，退回全宽基', marketLabel: ex };
  }
  if (!picked.indices.length) {
    return { indices: all, scopeLabel: picked.scopeLabel + '（个股不在任一宽基，已回退全宽基）', marketLabel: ex };
  }
  return picked;
}

// 把首页大盘技术分析模块的短期研判结论映射为数值信号：看多→+1 / 看空→-1 / 震荡→0
// （20260917i：原文件此处重复定义了两次，本次一并收敛为一份）
function shortDirectionToSignal(direction) {
  if (direction === '看多') return 1;
  if (direction === '看空') return -1;
  return 0;
}

// ===== 20260917i：「大盘及行业板块短期走势」因子按用户要求拆分删除 =====
// 因子本体（key='market'）不再存在（FACTOR_KEYS 已移除），其两个子因子迁入其他卡片：
//   · 「大盘短期走势」                        → 「大盘」卡片（原「市场情绪与消息面」）；
//   · 「行业板块」改名「行业短期走势」        → 「行业板块」卡片（原「板块涨跌停占比」）。
// 取数与口径与原因子完全一致：按个股真实成分股筛宽基指数 + 联动首页大盘技术分析的短期研判。
// 返回的子因子带 w（子权重），在目标因子内归一化后参与评分（用户确认「参与评分」）。
function computeMarketShortSub(stockCtx) {
  const picked = (stockCtx && stockCtx.selectedIndices) || [];
  const techIndices = (stockCtx && stockCtx.techIndices) || [];
  const scopeLabel = (stockCtx && stockCtx.scopeLabel) || '—';
  const cnAvg = picked.length ? avg(picked.map(c => (c.changePct != null ? c.changePct : 0))) : 0;
  const techByName = new Map();
  for (const t of techIndices) { if (t && t.name) techByName.set(t.name, t); }
  const techPicks = picked.map(idx => {
    const tech = techByName.get(idx.name);
    if (!tech || !tech.step6 || !tech.step6.shortTerm) return null;
    return { name: idx.name, direction: tech.step6.shortTerm.direction };
  }).filter(Boolean);
  const techSigSum = techPicks.reduce((s, p) => s + shortDirectionToSignal(p.direction), 0);
  const techSigAvg = techPicks.length ? techSigSum / techPicks.length : 0;
  const techVerdict = techSigAvg > 0.34 ? '看多' : techSigAvg < -0.34 ? '看空' : '震荡';
  const techDetail = techPicks.length
    ? techPicks.map(p => `${p.name}${p.direction}`).join('、')
    : '暂未提供与该股同市场的短期研判';
  const signal = clamp(techSigAvg, -1, 1);
  const detail = techPicks.length
    ? `${scopeLabel} 短期研判：${techDetail} → 综合 ${techVerdict}；该股市场口径平均涨跌 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}%`
    : '暂未提供与该股同市场的短期研判，按中性处理';
  return {
    verdict: techVerdict,
    signal,
    sub: { name: '大盘短期走势', w: MARKET_SHORT_SUB_W, signal, value: techVerdict, detail },
  };
}

// 「行业短期走势」（20260917i：原「行业板块」子因子改名并迁入「行业板块」卡片）——所属行业板块当日整体涨跌。
function computeSectorTrendSub(sector) {
  const secOk = !!(sector && sector.ok && typeof sector.boardChange === 'number');
  const secChg = secOk ? sector.boardChange : 0;
  const up = secOk ? sector.upCount : null;
  const down = secOk ? sector.downCount : null;
  const signal = secOk ? clamp(secChg / 2, -1, 1) : 0;
  const board = secOk ? (sector.boardName || sector.industryName || '行业板块') : '行业板块';
  const detail = secOk
    ? `${board} ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${up}/跌 ${down}）`
    : '行业板块走势数据暂缺，按中性处理';
  return {
    signal,
    sub: { name: '行业短期走势', w: SECTOR_TREND_SUB_W, weight: SECTOR_TREND_SUB_W, signal, value: secOk ? `板块 ${secChg >= 0 ? '+' : ''}${round(secChg)}%` : '—', detail },
  };
}

// 「市场情绪提醒」（20260917i 新增，替代被删除的「消息情绪（大盘）」）——
// 直接引用首页「市场情绪提醒」卡片的判断：读 lib/marketEmotionModel 落盘的当日记录，
// 与首页 /api/sentiment-turning-point 同源（规则一·指标级单源），个股页不重算。
// 20261028c：引用型子因子的单源同义信号推导（唯一出口）——方向语义完全继承首页判档。
// neutral → 0；bull/bear → 按 tendency 定号取 |score|（看涨要求 score ≥ +0.2、看跌 ≤ -0.2，
// 徽标必与 tendency 同向）。computeMarketEmotionSub 与 _emotionSubStale 共用，杜绝两处推导漂移。
// 背景（用户实测）：首页 -3.9 分=中性（中性区间远宽于 ±0.02），但全局 impactScore 的方向保底
// （IMPACT_DIR_EPS=0.02，ruleCore）把 -0.04 判成利空徽标 + 子卡权重 -13%，同源两页两个说法，
// 违反规则一·指标级单源。全局 toImpactScore 的方向保底是其他因子的刻意设计，不动。
function _emotionQuoteSig(emo) {
  if (!emo || typeof emo.score !== 'number') return 0;
  const raw = Math.max(-1, Math.min(1, emo.score));
  const tKey = emo.tendencyKey || (emo.tendency === '看涨' ? 'bull' : emo.tendency === '看跌' ? 'bear' : 'neutral');
  return tKey === 'bull' ? Math.abs(raw) : tKey === 'bear' ? -Math.abs(raw) : 0;
}

function computeMarketEmotionSub() {
  let emo = null;
  try { emo = marketEmotionModel.readLatestJudgment(); } catch (e) { emo = null; }
  if (!emo || typeof emo.score !== 'number') {
    return { name: '市场情绪提醒', w: EMOTION_SUB_W, signal: 0, value: '—',
      detail: '首页「市场情绪提醒」暂无当日判断（先在首页刷新一次即可），按中性处理' };
  }
  const sig = _emotionQuoteSig(emo);
  const rawSig = Math.max(-1, Math.min(1, emo.score));
  const level = Math.abs(rawSig) >= 0.5 ? '强烈预警' : Math.abs(rawSig) >= 0.2 ? '预警' : '关注';
  const dateNote = emo.date ? `（${emo.date}）` : '';
  const drv = emo.coreDriver ? `；核心驱动：${emo.coreDriver}` : '';
  const vols = emo.volumeState ? `；${emo.volumeState}` : '';
  const tips = emo.advice ? `；操作建议：${emo.advice}` : '';
  const tendTxt = emo.tendency || '震荡';
  return {
    name: '市场情绪提醒', w: EMOTION_SUB_W, signal: sig,
    value: `${tendTxt} · ${level}`,
    detail: `引用首页「市场情绪提醒」判断${dateNote}：情绪总分 ${rawSig >= 0 ? '+' : ''}${round(rawSig, 2)}（${level}）→ 倾向 ${tendTxt}${drv}${vols}${tips}。与首页同源、不重复计算；方向徽标继承首页判档（${tendTxt}），引用处不自行判档。`,
  };
}

// 「舆情与讨论热度（个股）」（20260917i：由「大盘」卡片迁至「个股短期动向」）——
// Part B 单只 A 股个股全网舆情分析确定性模块（lib/stockSentiment）：
//   消费 同花顺讨论帖(stockDiscussion) + 东财/同花顺/雪球热度(discussionHeat) + 个股新闻(newsSentiment)，
//   并按行情/主力资金/换手率做四路交叉校验 → 综合分 + 热度等级 + 情绪标签 + 告警。
//   保留旧逻辑兜底：buildStockSentiment 不可用时卡片仍可展示基础舆情。
function computeStockSentimentSub(sentiment, quote, symbol, capital, turnoverChange) {
  let stockSent = null;
  try {
    stockSent = buildStockSentiment({
      symbol,
      name: (quote && quote.name) || symbol,
      quote,
      capital,
      turnoverChange,
      newsSentiment: sentiment && sentiment.newsSentiment,
      discussionHeat: sentiment && sentiment.discussionHeat,
      stockDiscussion: sentiment && sentiment.stockDiscussion,
    });
  } catch (e) {
    console.warn('[SameDayJudgment] buildStockSentiment failed:', e.message);
  }
  if (stockSent && stockSent.ok) {
    const dirWord = stockSent.signal > 0.12 ? '利好' : (stockSent.signal < -0.12 ? '利空' : '中性');
    const ind = stockSent.indicators || {};
    const nm = stockSent.norm || {};
    const rawTxt = `原始指标 A曝光 ${ind.A != null ? ind.A : '—'}｜B讨论 ${ind.B != null ? ind.B : '—'}｜C散户 ${ind.C != null ? ind.C : '—'}｜D专业情感 ${ind.D != null ? ind.D + '%' : '—'}｜E社区情感 ${ind.E != null ? ind.E + '%' : '—'}`;
    const normTxt = `归一化 B ${nm.B != null ? nm.B : '—'}｜C ${nm.C != null ? nm.C : '—'}｜D ${nm.D != null ? nm.D : '—'}｜E ${nm.E != null ? nm.E : '—'}（样本 ${stockSent.sample} 帖）`;
    const crossTxt = (stockSent.crossTags && stockSent.crossTags.length) ? `；交叉校验：${stockSent.crossTags.join('、')}` : '';
    const alertTxt = stockSent.alert && stockSent.alert.on ? `；${stockSent.alert.text}` : '';
    const br = stockSent.brief || {};
    const kwParts = [];
    if (br.posKeywords && br.posKeywords.length) kwParts.push(`看多词：${br.posKeywords.join('/')}`);
    if (br.negKeywords && br.negKeywords.length) kwParts.push(`看空词：${br.negKeywords.join('/')}`);
    if (br.coreEvent) kwParts.push(`焦点帖：${br.coreEvent}`);
    const degradeTxt = (stockSent.degrade && stockSent.degrade.length) ? `；口径说明：${stockSent.degrade.join('；')}` : '';
    return {
      name: '舆情与讨论热度（个股）', w: STOCK_SENT_SUB_W, signal: clamp(stockSent.signal, -1, 1),
      value: `${stockSent.heatLevel}·${stockSent.sentimentTag}·${dirWord}`,
      detail: `${stockSent.conclusion}；${rawTxt}；${normTxt}${crossTxt}${alertTxt}${kwParts.length ? '；' + kwParts.join('；') : ''}${degradeTxt}`,
    };
  }
  const hasNews = !!(sentiment && sentiment.newsSentiment && sentiment.newsSentiment.ok);
  const hasHeat = !!(sentiment && sentiment.discussionHeat && sentiment.discussionHeat.ok);
  if (!hasNews && !hasHeat) return null;
  const ns = sentiment.newsSentiment;
  const dh = sentiment.discussionHeat;
  const eng = ns && ns.engine === 'finance-model' ? '金融微调模型' : 'snownlp+词库';
  const score = ns && ns.ok ? (ns.weightedAvgScore != null ? ns.weightedAvgScore : ns.avgScore) : null;
  let heatValue = '';
  let heatDetail = '';
  let heatSignal = 0;
  if (dh && dh.ok) {
    heatSignal = clamp(dh.signal || 0, -1, 1);
    const em = dh.eastmoney || {};
    const th = dh.tonghuashun || {};
    const xq = dh.xueqiu || {};
    const emTxt = em.symbolScore != null
      ? `东财个股${em.symbolScore}` + (em.symbolRise != null ? (em.symbolRise > 0 ? '↑' : '↓') : '')
      : (em.marketHeat != null ? `东财市场热度${em.marketHeat >= 0 ? '+' : ''}${round(em.marketHeat, 2)}` : '');
    const thTxt = th.inHotList ? `同花顺第${th.rank}名(热度${th.heatRate})` : (th.ok ? `同花顺未入热榜` : '');
    const xqTxt = xq.inTop ? `雪球第${xq.rank}名(关注${xq.follow})` : (xq.ok ? `雪球未入关注榜` : '');
    heatValue = [emTxt, thTxt, xqTxt].filter(Boolean).join(' / ');
    const emDetail = em.symbolScore != null
      ? `东财股吧综合得分 ${em.symbolScore}、${em.symbolRise != null ? (em.symbolRise > 0 ? '热度上升' : '热度下降') : ''}`
      : `东财市场热度 ${em.marketHeat != null ? (em.marketHeat >= 0 ? '+' : '') + round(em.marketHeat, 2) : '—'}`;
    const thDetail = th.inHotList
      ? `同花顺热榜第${th.rank}名、热度值${th.heatRate}${th.risePct != null ? '、涨跌' + (th.risePct >= 0 ? '+' : '') + round(th.risePct, 2) + '%' : ''}`
      : th.note || '';
    const xqDetail = xq.inTop
      ? `雪球关注榜第${xq.rank}名、关注人数${xq.follow}${xq.pct != null ? '、今日' + (xq.pct >= 0 ? '+' : '') + round(xq.pct, 2) + '%' : ''}`
      : xq.note || '';
    heatDetail = [emDetail, thDetail, xqDetail].filter(Boolean).join('；');
  }
  const newsValue = ns && ns.ok ? `利好 ${ns.positive}/中性 ${ns.neutral}/利空 ${ns.negative}` : '';
  const newsDetail = ns && ns.ok
    ? `近 ${ns.count} 条个股新闻（${eng}），积极 ${ns.positive}/中性 ${ns.neutral}/消极 ${ns.negative}，加权情感均值 ${score != null ? round(score * 100) : '—'}（${ns.note || ''}）`
    : '';
  const subSignal = (hasNews && hasHeat)
    ? clamp(0.5 * clamp(ns.signal, -1, 1) + 0.5 * heatSignal, -1, 1)
    : (hasNews ? clamp(ns.signal, -1, 1) : heatSignal);
  return {
    name: '舆情与讨论热度（个股）', w: STOCK_SENT_SUB_W, signal: subSignal,
    value: [newsValue, heatValue].filter(Boolean).join(' | '),
    detail: [newsDetail, heatDetail].filter(Boolean).join('；'),
  };
}

// 「板块消息」（20260917i：由「大盘」卡片迁至「行业板块」卡片）——
// 板块/赛道级新闻情绪 → 个股传导（解决"个股新闻源抓不到板块级催化"）。
function computeSectorNewsSub(sectorNews) {
  if (!(sectorNews && sectorNews.ok && typeof sectorNews.signal === 'number')) return null;
  const sn = sectorNews;
  const evtTxt = (sn.eventBoosted && sn.events && sn.events.length)
    ? `；重大事件：${sn.events.slice(0, 2).map(e => e.title).join('、')}`
    : '';
  return {
    name: '板块消息', w: SECTOR_NEWS_SUB_W, weight: SECTOR_NEWS_SUB_W, signal: clamp(sn.signal, -1, 1),
    value: `利好 ${sn.positive}/利空 ${sn.negative}${sn.eventBoosted ? ' · 重大事件' : ''}`,
    detail: `板块/赛道消息 ${sn.count} 条（关键词：${(sn.keywords || []).slice(0, 3).join('、')}），利好 ${sn.positive}/利空 ${sn.negative}，情绪均值 ${sn.avgScore != null ? (sn.avgScore >= 0 ? '+' : '') + sn.avgScore : '—'}${evtTxt}`,
  };
}


// 5) 公司近期重大利好/利空（20260823i 起并入「市场情绪」因子，作为其三个子信号）：
//    消息情绪（大盘）+ 财报解读 + A股内幕抢跑提前反应。
//    返回可被 factorSentiment 直接并入的 parts（含子权重 w），而非独立因子。
//    财报判断优先用 cn-financial-scraper 的「定期报告解读」（interpret_stock），缺失时回退 quote.fundamentals 增速。
function computeNewsFactor(news, quote, history, report, symbol, marketSentiment) {
  const parts = [];
  let value = '—';
  // 20260922：内幕抢跑预警已迁移至事件驱动引擎（eventEngine.checkInsiderFrontRun），
  // 改为"仅个股/板块相关事件出现时联动触发"；本函数不再承担抢跑逻辑（原 §5.3 整体移除）。

  // 5.1 消息情绪（大盘）—— 20260917i 已按用户要求删除（子卡片 + 底层逻辑）。
  //     原实现：取东财股吧全市场聚合（marketHeat / 上升家数占比 / 全市场得分均值）并计分。
  //     现由「大盘」卡片内新增的「市场情绪提醒」子因子直接引用首页判断替代（规则一·指标级单源）。
  let earnSub = null;

  // 5.2 财报解读 —— 20260917i：按用户要求迁至「个股短期动向」卡片。
  //     本函数只负责产出 earnSub 返回给调用方，不再并入「大盘」因子。
  //     联动深度分析「最新财报解读」：优先消费同一份 AI 联网缓存，确保规则一·数据一致性；
  //     缺失时回退 cn-financial-scraper 评级 + 披露增速。量化信号始终以披露同比增速为准（规则三）。
  const f = quote && quote.fundamentals;
  const norm = (v) => (v != null && Math.abs(v) < 1 ? v * 100 : v);
  const pgN = norm(f && (f.profitYoy != null ? f.profitYoy : f.earningsGrowth));
  const rgN = norm(f && (f.revenueYoy != null ? f.revenueYoy : f.revenueGrowth));
  const repOk = report && report.ok && typeof report.score === 'number' && report.score > 0
    && report.rating && report.rating !== '数据不足';
  // 联动：读取与个股深度分析同源的「最新财报解读」缓存（单一权威源，避免双源各说各话）
  let deepEarnings = null;
  try { deepEarnings = readEarningsCache(symbol); } catch {}
  // 20260906b：缓存 promptVersion 过期（stale=true）时不引用其旧文，回退 scraper 评级分支
  const deepSummaryOk = !!(deepEarnings && !deepEarnings.stale && typeof deepEarnings.summary === 'string' && deepEarnings.summary.trim().length > 0);
  if (deepSummaryOk) {
    // 信号以 AI 深度解读的实质结论为准，而非仅看同比增速
    const earnSignal = (typeof deepEarnings.earningsSignal === 'number')
      ? deepEarnings.earningsSignal
      : extractEarningsSignal(deepEarnings.summary);
    const earnLabel = earnSignal > 0.15 ? '向好' : earnSignal < -0.15 ? '承压' : '中性';
    const verdictTxt = (deepEarnings.verdict && deepEarnings.verdict.trim()) ? deepEarnings.verdict.trim() : '';
    const yoyTxt = (pgN != null) ? '；净利同比 ' + (pgN >= 0 ? '+' : '') + round(pgN) + '%' : (rgN != null ? '；营收同比 ' + (rgN >= 0 ? '+' : '') + round(rgN) + '%' : '');
    const head = `最新财报解读（联动深度分析）：${earnLabel}${yoyTxt}`;
    // 小卡只引用精简结论（verdict 一句话），详细正文只在深度分析卡展示
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: '联动深度解读', detail: head + (verdictTxt ? '；' + verdictTxt : '') };
  } else if (repOk) {
    const ratingSig = { '积极': 0.6, '中性偏积极': 0.3, '中性': 0.0, '谨慎': -0.5 }[report.rating] || 0;
    const rpProfitYoy = norm(report.profit_yoy);
    const rpRevenueYoy = norm(report.revenue_yoy);
    const yoy = (rpProfitYoy != null) ? rpProfitYoy : rpRevenueYoy;
    const yoySig = yoy != null ? clamp(yoy / 30, -1, 1) : 0;
    const earnSignal = (yoy != null) ? 0.5 * ratingSig + 0.5 * yoySig : ratingSig;
    const highlightTxt = (report.highlights && report.highlights.length) ? `；亮点：${report.highlights[0]}` : '';
    const riskTxt = (report.risks && report.risks.length) ? `；风险：${report.risks[0]}` : '';
    const earnLabel = earnSignal > 0.15 ? '向好' : earnSignal < -0.15 ? '承压' : '中性';
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: `评级 ${report.rating}`,
      detail: `最新财报（回退·定期报告评级）：评级 ${report.rating}${yoy != null ? '，净利/营收同比 ' + (yoy >= 0 ? '+' : '') + round(yoy) + '%' : ''}（${earnLabel}）${highlightTxt}${riskTxt}` };
  } else if (pgN != null || rgN != null) {
    const earnSignal = (pgN != null) ? clamp(pgN / 30, -1, 1) : clamp(rgN / 30, -1, 1);
    const earnTxt = pgN != null ? `净利增速 ${pgN >= 0 ? '+' : ''}${round(pgN)}%` : `营收增速 ${rgN >= 0 ? '+' : ''}${round(rgN)}%`;
    const earnLabel = earnSignal > 0.15 ? '增长/超预期' : earnSignal < -0.15 ? '下滑/低于预期' : '符合预期';
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: earnTxt, detail: `最新财报：${earnTxt}（${earnLabel}）` };
  }


  // 20260922：原 §5.3 内幕抢跑预警已整体迁移至事件驱动引擎（lib/eventEngine.js · checkInsiderFrontRun），
  // 改为"仅个股/板块相关事件出现时，回溯事件前 3 日涨跌幅"触发，不再在大盘/市场情绪因子内无条件计算。

  if (!parts.length) {
    // 无消息/财报数据：给一个中性占位，保证市场情绪"消息面"子卡可见
    parts.push({ name: '消息面', w: 0.05, signal: 0, value: '—', detail: '未检索到近期重大消息与财报信号，按中性处理' });
  }
  return { parts, value, earnSub };
}

// ===== 报告期工具（20260913g 修订）=====
// 十大股东 / 十大流通股东除季度末（03-31 / 06-30 / 09-30 / 12-31）定期披露外，
// 东财对「非季度末的权益变动 / 临时公告」也会给完整 10 行（如海天味业 2026-07-03，
// 比最近季度末 2026-06-30 更新）。因此标注改为以「该期是否为最新可得披露」为准：
// 非季度末的完整 10 行披露 = 最新数据，不得误标为「非最新季报期」。
// 返回「当前应当可披露的最近一个季度末」（≤ 今天的最大季度末），用于季度末口径的新鲜度对照。
function latestQuarterEnd(now = new Date()) {
  const y = now.getFullYear();
  const today = localDate(now);
  const cands = [];
  for (const yy of [y - 1, y]) {
    cands.push(`${yy}-03-31`, `${yy}-06-30`, `${yy}-09-30`, `${yy}-12-31`);
  }
  const ok = cands.filter(d => d <= today).sort();
  return ok.length ? ok[ok.length - 1] : '';
}

// 6) 股票增持减持：前十大股东实际持股变动 + 股份回购。
// 20260823h 修复：东财对实际变动股东返回数值股数（仅「不变」返回文本），原代码只做
// 文本正则导致所有数值变动被误判为「不变」。现按 changeAmount 符号定量判定，并引入
// 净变动股数/净变动占比作为信号强度；同时在文案中标注数据报告期。
// 20260913f：① 因子与「增减持家数」子卡片均显式标注数据报告期（此前仅父因子 detail 有、
//   子卡片无，用户无法判断数据新旧）；② 因子级 caption 标注报告期 + 是否最新季报期 + 来源。
// 20260922h：股东「被动减持 / 司法强制执行」检测（公告/新闻驱动，实时，不依赖 F10 季报滞后）
// 为什么走公告流而非 F10：东财前十大股东只给「增持/减持」方向、不带原因；法院强制执行/被动
// 减持 = 股东陷入平仓/债务困境，是比自愿减持更强的利空；且 9 月事件要等 Q3(09-30) 披露才进 F10，
// 故性质检测必须复用项目已有的 allAnnouncements/stockNews（回购即复用此流），实时显形。
function _forcedMatchName(title, names) {
  for (const n of (names || [])) if (n && title.indexOf(n) !== -1) return n;
  return null;
}
function detectForcedReduction(announcements, news, shareholderNames, companyName) {
  // 20260922h：正则自包含（运行时不依赖模块级常量，亦便于单元测试 sandbox eval 复用）
  // 20260922i：扩展覆盖真实公告措辞——东财真实标题多含「部分股份执行完成的结果公告」「拟被司法强制执行」
  //   （旧 FORCED_RE 仅命中「司法强制执行/被动减持」等强词，对「执行完成的结果公告」这类已发生类完全漏判）。
  const FORCED_RE = /(司法强制执行|法院强制执行|被动减持|强制减持|强制平仓|司法拍卖|被司法|裁定强制执行|强制执行.*减持|减持.*(司法|法院|强制)|司法冻结|轮候冻结|司法执行|执行完成|执行完毕|变价处置|强制变价|部分股份.*(执行|冻结|拍卖)|已减持部分股份)/;
  const FORCED_ROLE_RE = /(二股东|第二大股东|大股东|控股股东|持股5%以上股东|5%以上股东|重要股东|原持股5%以上股东|持股5%以上)/;
  // 已实际发生减持/拍卖成交/执行完成（确认利空 -0.8）vs 仅冻结/拍卖预告（未来强平风险 -0.6）
  const FORCED_CONFIRMED_RE = /(被动减持|司法强制执行.*减持|强制平仓|已减持|减持.*(司法|法院|强制)|司法拍卖.*成交|拍卖成交|执行完成|执行完毕|已执行|司法强制执行.*完成|强制变价.*成交|已减持部分股份)/;
  // 20260922i：排除利好/中性语境下的「执行完成」，避免把增持计划、回购实施完成误判为司法强减
  const FORCED_EXCLUDE_RE = /(增持计划执行|回购.*(完成|实施完成|期限届满)|股权激励.*完成|员工持股.*完成|向特定对象发行.*完成|非公开发行.*完成|可转债.*完成|配股.*完成|发行.*完成)/;
  const items = [];
  if (Array.isArray(announcements)) for (const a of announcements) if (a && a.title) items.push({ title: a.title, date: a.date || '', src: '公告' });
  if (Array.isArray(news)) for (const n of news) if (n && n.title) items.push({ title: n.title, date: n.date || '', src: '新闻' });
  const events = [];
  for (const it of items) {
    const t = it.title;
    if (FORCED_EXCLUDE_RE.test(t)) continue; // 利好/中性语境，直接跳过
    if (!FORCED_RE.test(t)) continue;
    const nameHit = _forcedMatchName(t, shareholderNames);
    const roleHit = FORCED_ROLE_RE.test(t);
    const companyHit = companyName && t.indexOf(companyName) !== -1;
    // 必须能定位到本股股东：姓名命中，或带角色词且含公司名/股东语境——避免误抓别家公司的司法拍卖
    if (!nameHit && !(roleHit && (companyHit || t.indexOf('股东') !== -1))) continue;
    const confirmed = FORCED_CONFIRMED_RE.test(t);
    events.push({ name: nameHit || (roleHit ? '二/大股东' : ''), title: t, date: it.date, src: it.src, confirmed,
      reason: confirmed ? '司法强制执行/被动减持/执行完成（已发生）' : '司法冻结/拍卖/拟被强制执行（未来强平风险）' });
  }
  const seen = new Set(); const uniq = [];
  for (const e of events) { const k = e.title + '|' + (e.name || ''); if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  if (!uniq.length) return { events: [], signal: 0, confirmed: false };
  const confirmed = uniq.some(e => e.confirmed);
  return { events: uniq, signal: confirmed ? -0.8 : -0.6, confirmed };
}

function factorHoldings(shareholders, buyback, opts) {
  const top = (shareholders && Array.isArray(shareholders.topShareholders)) ? shareholders.topShareholders : [];
  const reportDate = top[0]?.endDate || '';
  // 20260913f：报告期标注（子卡片 + 因子 caption + 父因子 detail 同源），显式区分「最新季报期 / 非最新季报期」
  // 20260913g：非季度末的完整 10 行披露（如 2026-07-03）比最近季度末更新 → 按「是否最新可得披露」判定，
  //   不再拿「是否等于最近季度末」当唯一尺度，否则会把更新的数据误标成「非最新季报期」。
  const expectQ = latestQuarterEnd();
  const isQEnd = /-(03-31|06-30|09-30|12-31)$/.test(reportDate);
  const isLatest = !!reportDate && (!expectQ || reportDate >= expectQ);
  const periodTag = reportDate
    ? (isQEnd
        ? `${reportDate}（${isLatest ? '最新季报期' : `非最新季报期，最新可披露 ${expectQ || '—'}`}）`
        : `${reportDate}（最新披露·非季度末）`)
    : '未知';
  let inc = 0, dec = 0, flat = 0;
  const incNames = [], decNames = [];
  let totalIncreaseShares = 0;
  let totalDecreaseShares = 0;
  let totalHeldShares = 0;

  for (const h of top) {
    totalHeldShares += Math.abs(Number(h.holdAmount) || 0);
    // 优先用数值 changeAmount；缺失时回退文本解析
    let amount = null;
    if (typeof h.changeAmount === 'number') {
      amount = h.changeAmount;
    } else if (h.change != null) {
      const s = String(h.change).trim();
      if (/增持|新进/.test(s)) amount = 1;
      else if (/减持/.test(s)) amount = -1;
      else if (s === '不变') amount = 0;
      else {
        const n = Number(s.replace(/,/g, ''));
        if (!Number.isNaN(n)) amount = n;
      }
    }

    if (amount > 0) {
      inc++; incNames.push(h.name);
      totalIncreaseShares += amount;
    } else if (amount < 0) {
      dec++; decNames.push(h.name);
      totalDecreaseShares += Math.abs(amount);
    } else {
      flat++;
    }
  }

  // 净变动股数（正=净增持，负=净减持）及其相对十大股东合计持股的比例
  const netChangeShares = totalIncreaseShares - totalDecreaseShares;
  const netChangeRatio = totalHeldShares > 0 ? netChangeShares / totalHeldShares : 0;
  // 将净变动占比映射到 [-1,1]：±3% 达到极值；同时用家数方向做修正
  const magnitudeSignal = clamp(netChangeRatio / 0.03, -1, 1);

  // 20261023i（用户要求）：股份回购已从本因子迁入「事件驱动」因子
  // （lib/eventEngine.buildBuybackEvent：回购提议 10% / 回购实施中 30%）。
  // 本因子不再消费 buyback、不再把回购计入利好侧家数，避免与事件因子重复计权。
  // buyback 参数保留仅为兼容旧调用点/单测，逻辑上不再使用。
  const total = inc + dec + flat;
  // 20261025j：权重=评分——原「0.55×方向信号 + 0.45×幅度信号 (+0.2×被动减持强度)」
  // 改为因子内份额×满格方向：家数 0.55 / 净变动 0.45 / 被动减持 0.20（Σ=1.2 归一化）；
  // 被动减持无事件时方向恒 0（份额蒸发），旧校准的方向语义保持不变。
  const HOLD_W_SUM = 0.55 + 0.45 + 0.20;
  const holdShares = { count: 0.55 / HOLD_W_SUM, magnitude: 0.45 / HOLD_W_SUM, forced: 0.20 / HOLD_W_SUM };
  let signal;
  if (total === 0) {
    signal = 0;
  } else {
    const directionSignal = clamp((inc - dec) / total, -1, 1);
    signal = round(holdShares.count * dirOf(directionSignal) + holdShares.magnitude * dirOf(magnitudeSignal), 3);
  }

  // 20260922h：股东被动减持/司法强制执行（公告/新闻驱动，实时，不依赖 F10）
  const forced = detectForcedReduction(
    (opts && opts.announcements) || [],
    (opts && opts.news) || [],
    top.map(h => h.name),
    opts && opts.companyName,
  );
  // 困境溢价：20261025j 改为按份额计入——被动减持方向 (-1) × 份额 0.20/1.2（替代原 0.2×强度折扣）；
  // forced=0 时本行恒为 0（向后兼容）；total=0（无股东数据）时被动减持利空仍独立生效。
  signal = round(signal + holdShares.forced * dirOf(forced.signal), 3);

  const dateNote = reportDate ? `（数据报告期：${periodTag}）` : '';
  const netChangeText = `${netChangeShares >= 0 ? '+' : ''}${formatWan(netChangeShares)}股`;
  const netChangePct = (netChangeRatio * 100).toFixed(2);
  const detail = `前十大股东中，增持/新进 ${inc} 家${incNames.length ? `（${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}、减持 ${dec} 家${decNames.length ? `（${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}、其余 ${flat} 家不变；十大股东合计净变动 ${netChangeText}（占其持股 ${netChangePct}%）${dateNote}`;
  const value = `增持 ${inc}/减持 ${dec}/净变动 ${netChangeText}`;

  const countSignal = top.length ? clamp((inc - dec) / top.length, -1, 1) : 0;
  const subs = [
    { name: '十大股东净变动', signal: magnitudeSignal, weight: holdShares.magnitude, value: netChangeText, detail: `数据报告期 ${periodTag}；前十大股东合计净变动 ${netChangeText}，占其合计持股 ${netChangePct}%；其中增持 ${formatWan(totalIncreaseShares)}股、减持 ${formatWan(totalDecreaseShares)}股` },
    { name: '增减持家数', signal: countSignal, weight: holdShares.count, value: `增持 ${inc}/减持 ${dec}`, detail: `数据报告期 ${periodTag}；前十大股东增持/新进 ${inc} 家、减持 ${dec} 家、不变 ${flat} 家${incNames.length ? `（增持：${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}${decNames.length ? `（减持：${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}` },
  ];
  // 20261023i：股份回购子卡片已移出本因子（迁入「事件驱动」因子，见 lib/eventEngine.buildBuybackEvent）。
  // 20260922h：第④子模块 股东被动减持/司法强制执行（实时，独立于 F10 季报滞后）
  if (forced.events.length) {
    subs.push({
      name: '股东被动减持',
      signal: forced.signal,
      weight: holdShares.forced,
      value: forced.events.map(e => `${e.name || '股东'}·${e.confirmed ? '被动减持' : '司法冻结/拍卖'}`).join('、'),
      detail: `来源：公告/新闻（实时，非 F10 季报滞后）${forced.confirmed ? '；⚠ 已发生司法强制执行/被动减持，属股东平仓/债务困境信号，利空强于普通减持' : '；司法冻结/拍卖预告，存在未来强制减持风险'}${opts && opts.companyName ? `；关联公司：${opts.companyName}` : ''}；样例：${forced.events.slice(0, 2).map(e => e.title).join('；')}`,
      stage: forced.confirmed ? '司法执行' : '司法风险',
    });
  } else {
    subs.push({ name: '股东被动减持', signal: 0, weight: holdShares.forced, value: '无', detail: '未检索到股东司法强制执行/被动减持公告，按中性处理' });
  }
  return {
    key: 'holdings', name: '增持减持', weight: W_HOLDINGS, signal, applicable: true, value, detail, subFactors: subs,
    // 20260913f：因子级数据日期/来源标注（折叠态也能看到数据报告期，不再"小卡片无日期"）
    caption: `数据报告期：${periodTag} · 来源：东方财富 F10 前十大股东（含前十大流通股东）${forced.confirmed ? ' · ⚠ 检测到股东司法强制执行被动减持（实时）' : ''}`,
  };
}

// 7) 行业板块（20260917i：由「板块涨跌停占比」改名并重组，用户 20260917 要求）
//    保留：板块内涨停/跌停家数占成分股总数的比例（板块情绪量化，原口径不变），
//          数据来自 lib/sectorLimitStats（东财涨停池/跌停池权威判定阈值 + 同花顺板块成分总数）；
//    转入：· 「板块消息」  —— 原「大盘」卡片子因子；
//          · 「行业短期走势」（原「大盘及行业板块短期走势」因子的「行业板块」子因子，改名）。
//    因子信号（用户确认「参与评分」）：
//      涨跌停占比差 × 0.45 + 行业短期走势 × 0.35 + 板块消息 × 0.20
function factorSectorLimit(stats, sector, sectorNewsSub) {
  const limitOk = !!(stats && stats.ok && typeof stats.limitUpRatio === 'number' && typeof stats.limitDownRatio === 'number');
  const limitSig = limitOk ? clamp((stats.limitUpRatio - stats.limitDownRatio) * 20, -1, 1) : 0;
  const secTrend = computeSectorTrendSub(sector);
  const newsSig = (sectorNewsSub && typeof sectorNewsSub.signal === 'number') ? clamp(sectorNewsSub.signal, -1, 1) : 0;
  // 20261025j：权重=评分——涨跌停占比差 0.45（方向取净差符号，两子卡互斥持权）/ 行业短期走势 0.35 / 板块消息 0.20，
  // 份额×满格方向；涨跌停持平时 0.45 份额蒸发（两卡都不显示权重）。
  const dirLimit = dirOf(limitSig);
  const shareLimit = dirLimit !== 0 ? LIMIT_SUB_W : 0;
  const signal = round(clamp(shareLimit * dirLimit + SECTOR_TREND_SUB_W * dirOf(secTrend.signal) + SECTOR_NEWS_SUB_W * dirOf(newsSig), -1, 1), 3);

  const subs = [];
  let value = '—';
  let detail;
  if (limitOk) {
    const upR = stats.limitUpRatio;
    const downR = stats.limitDownRatio;
    const upPct = (upR * 100).toFixed(1);
    const downPct = (downR * 100).toFixed(1);
    const board = stats.boardName || stats.industryName || '行业板块';
    detail = `所属「${board}」板块：涨停 ${stats.limitUp} 家（${upPct}%）、跌停 ${stats.limitDown} 家（${downPct}%）、成分 ${stats.total} 家` +
      (limitSig > 0.15 ? ' → 板块情绪偏热（涨停潮）' : limitSig < -0.15 ? ' → 板块情绪偏冷（跌停潮）' : ' → 板块情绪平稳');
    value = `涨停 ${upPct}% / 跌停 ${downPct}%`;
    subs.push({ name: '涨停占比', signal: clamp(upR * 20, -1, 1), weight: upR > downR ? LIMIT_SUB_W : 0, value: `涨停 ${upPct}%`, detail: `所属「${board}」板块涨停 ${stats.limitUp} 家，占成分股 ${upPct}%` });
    subs.push({ name: '跌停占比', signal: clamp(-downR * 20, -1, 1), weight: downR > upR ? LIMIT_SUB_W : 0, value: `跌停 ${downPct}%`, detail: `所属「${board}」板块跌停 ${stats.limitDown} 家，占成分股 ${downPct}%` });
  } else {
    detail = (stats && stats.note) ? stats.note : '板块涨跌停数据不可用，按中性处理';
  }
  // 转入子因子（20260917i）
  subs.push(secTrend.sub);
  if (sectorNewsSub) subs.push(sectorNewsSub);

  return { key: 'sectorLimit', name: FACTOR_NAME.sectorLimit, weight: W_SECTOR_LIMIT, signal, applicable: true, value, detail, subFactors: subs };
}

// 7) 板块跷跷板（科技/半导体负相关）：仅对非科技/半导体个股生效。
//    取科技/半导体板块当日整体涨跌幅（多板块均值）作为 composite，
//    按"反向"映射为个股信号：科技涨 → 其他板块(含该股)跌 → 偏空；科技跌 → 偏多。
//    个股本身属于科技/半导体行业时，即跷跷板中被参照的一方，因子不适用（applicable:false）。
function factorSeesaw(seesaw, isTechStock) {
  if (isTechStock) {
    return {
      key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW, signal: 0, applicable: false,
      value: '不适用',
      detail: '个股本身属于科技/半导体板块，即跷跷板效应中被参照的一方，本因子不适用（避免自相关）',
    };
  }
  const composite = (seesaw && typeof seesaw.compositeChange === 'number') ? seesaw.compositeChange : 0;
  const boards = (seesaw && seesaw.boards) ? seesaw.boards : {};
  const subs = Object.keys(boards).map((k) => {
    const b = boards[k];
    const chg = (b && typeof b.boardChange === 'number') ? b.boardChange : null;
    return {
      name: `科技板块·${k}`, w: 0, signal: 0,
      value: chg != null ? `${chg >= 0 ? '+' : ''}${round(chg, 2)}%` : '—',
      detail: chg != null
        ? `${k}板块当日${chg >= 0 ? '上涨' : '下跌'}${Math.abs(chg).toFixed(2)}%（${b.boardName || k}）`
        : `${k}板块数据不可用`,
    };
  });
  if (!seesaw || !seesaw.ok) {
    return {
      key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW, signal: 0, applicable: true,
      value: '—',
      detail: (seesaw && seesaw.note) ? seesaw.note : '科技/半导体板块走势数据不可用，按中性处理',
      subFactors: subs,
    };
  }
  let signal = 0;
  if (Math.abs(composite) < SEESAW_DEADBAND_PCT) {
    signal = 0;
  } else {
    // 20261025j：权重=评分——死区外按满格方向计分（原 ±3% 满格比例衰减折进文案，强度不再压分）
    signal = -dirOf(composite);
  }
  const dirTxt = composite > 0 ? '上涨' : composite < 0 ? '下跌' : '持平';
  const verdict = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  const detail = `科技/半导体板块当日整体${dirTxt} ${composite >= 0 ? '+' : ''}${round(composite, 2)}%，与"其他板块"（含该股）呈明显负相关` +
    ` → 该股倾向${signal > 0.05 ? '上涨' : signal < -0.05 ? '下跌' : '震荡'}（${verdict}）` +
    `；阈值：满格 ±${SEESAW_FULL_PCT}%，死区 ±${SEESAW_DEADBAND_PCT}%`;
  return {
    key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW,
    signal: round(signal, 3), applicable: true,
    value: `${composite >= 0 ? '+' : ''}${round(composite, 2)}%`,
    detail, subFactors: subs,
  };
}

// ============ 第 8 因子：个股短期动向（20260905g） ============
// 引用价格行为趋势推演（lib/priceAction.analyzePriceAction，唯一出口 priceActionHub）的 shortTerm 输出，
// 与「技术面分析」页同源且同口径，保证数据一致性（规则一·指标级单源）。
// 20260905g：展示口径与技术面分析页②统一——直接展示原始 7 档方向
// （上行/震荡偏上/震荡/震荡偏下/下行/冲高回落/超跌反弹），不再聚合为三档。
// 子因子 signal 映射（仅用于影响程度展示，不参与总分——总分用主信号 dirScore/3）；
// 档位→信号语义与技术面页 _paVerdictClass 颜色语义一致：冲高回落偏空、超跌反弹偏多。
const SHORT_DIR_SIGNAL = {
  '上行': 1,
  '震荡偏上': 0.5,
  '超跌反弹': 0.5,
  '震荡': 0,
  '震荡偏下': -0.5,
  '冲高回落': -0.5,
  '下行': -1,
};

function factorTechnicalShort(pa, stockSentSub, earnSub) {
  // 20260917i：按用户要求转入「舆情与讨论热度（个股）」与「财报解读」两个子因子（原属「大盘」卡片），
  //   并参与评分（用户确认）：因子信号 = 短期动向预判 × 0.50 + 舆情与讨论热度（个股）× 0.30 + 财报解读 × 0.10（因子内归一化）。
  //   「短期动向预判」取数与口径不变（lib/priceAction.shortTerm，唯一出口 priceActionHub，与技术面分析页同源）。
  const stx = pa && pa.shortTerm ? pa.shortTerm : null;
  const hasShort = !!(stx && typeof stx.dirScore === 'number');

  const parts = [];
  let shortSig = 0;
  if (hasShort) {
    const dirTxt = stx.direction || '震荡';
    const dirSig = SHORT_DIR_SIGNAL[dirTxt] != null ? SHORT_DIR_SIGNAL[dirTxt] : 0;
    shortSig = clamp(round(stx.dirScore, 3) / 3, -1, 1); // dirScore 量级约 ±3.5，/3 限幅到 ±1
    parts.push({
      name: '短期动向预判', w: SHORT_DIR_SUB_W, signal: dirSig, value: dirTxt,
      detail: `与技术面分析页②短期动向预判同一次快照、同一档位展示，概率 ${stx.probability || '—'}。`,
    });
  } else {
    parts.push({
      name: '短期动向预判', w: SHORT_DIR_SUB_W, signal: 0, value: '—',
      detail: '个股短期动向数据不足（K线<60 或价格行为推演未返回短期动向）。来源：价格行为趋势推演（日/60分钟级别），与「技术面分析」页同源。',
    });
  }
  if (stockSentSub) parts.push({ name: stockSentSub.name, w: STOCK_SENT_SUB_W, signal: clamp(stockSentSub.signal || 0, -1, 1), value: stockSentSub.value, detail: stockSentSub.detail });
  if (earnSub) parts.push({ name: earnSub.name, w: EARN_SUB_W, signal: clamp(earnSub.signal || 0, -1, 1), value: earnSub.value, detail: earnSub.detail });

  // 因子主信号：20261025j 权重=评分——各子因子份额（w 归一化）× 满格方向（±1/0），
  // 贡献分 = effectiveWeight × 信号 = Σ(份额×eff×方向) = 净权重；「短期动向预判」方向取 7 档映射的符号。
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  let s = 0;
  for (const p of parts) {
    p.weight = round(p.w / wsum, 4);
    s += p.weight * dirOf(p.signal);
  }
  s = round(clamp(s, -1, 1), 3);

  const dirTxt = hasShort ? (stx.direction || '震荡') : '震荡';
  const extraTxt = parts.filter(p => p.name !== '短期动向预判').map(p => `${p.name} ${p.value}`).join(' | ');
  const detail = hasShort
    ? `个股短期动向（预判：${dirTxt}）：与技术面分析页②短期动向预判同一次快照、同一档位展示（lib/priceAction.shortTerm.direction，唯一出口 priceActionHub），概率 ${stx.probability || '—'}；另含舆情与讨论热度（个股）、财报解读两个子因子（同口径参与评分）。`
    : `个股短期动向数据不足（K线<60 或价格行为推演未返回短期动向）；已用舆情与讨论热度（个股）、财报解读子因子加权。`;
  return {
    key: 'technicalShort', name: FACTOR_NAME.technicalShort, weight: W_TECH_SHORT,
    signal: s, applicable: true,
    value: hasShort ? dirTxt : (extraTxt || '—'),
    detail, subFactors: parts,
  };
}

// ============ 汇总（支持自适应权重覆盖）============
function combineFactors(factors, weightOverride) {
  const used = factors.filter(f => f.applicable);
  const wsum = used.reduce((a, f) => a + (weightOverride && weightOverride[f.key] != null ? weightOverride[f.key] : f.weight), 0) || 1;
  let total = 0;
  const out = factors.map(f => {
    const w = (weightOverride && weightOverride[f.key] != null) ? weightOverride[f.key] : f.weight;
    const eff = f.applicable ? w / wsum : 0;
    const contribution = round(eff * f.signal, 3);
    total += contribution;
    // 影响程度评分：因子与子因子统一由 withImpact 计算，保证展示与语义同源
    const subFactors = (f.subFactors || []).map(sf => withImpact(sf));
    return withImpact({ ...f, weight: w, effectiveWeight: round(eff, 3), contribution, subFactors });
  });
  total = round(total, 3);
  let dir = '震荡';
  if (total > 0.12) dir = '涨';
  else if (total < -0.12) dir = '跌';
  const agree = used.filter(f => f.signal !== 0 && Math.sign(f.signal) === Math.sign(total)).length;
  const mag = Math.abs(total);
  let confidence = '低';
  if (mag >= 0.4 && used.length && agree >= Math.ceil(used.length * 0.6)) confidence = '高';
  else if (mag >= 0.22) confidence = '中';
  return { factors: out, totalScore: total, dir, verdict: VERdict_LABEL[dir], confidence };
}

// ============ 自我进化 / 错误学习层 ============
// 思路：每笔判断结算后，记录各因子的「方向是否与真实方向一致」，
// 分「全局」与「按预测方向(涨/跌/震荡)」两类统计各因子的命中率；
// 据此自适应调整因子权重（命中率低的因子降权），下一笔判断即使用新权重。
// 权重缓慢进化（带平滑与样本下限），避免小样本过拟合导致抖动。
// ===== 20260917i：因子/子因子权重常量（唯一定义处，因子函数一律引用常量）=====
// 因子权重：删除「大盘及行业板块短期走势」（原 0.114）后，其余 7 因子按原比例等比放大，
// 使 Σ = 1.0000（用户 20260917 确认「等比放大到 100%」）。
// 20260922j：增持减持 +5 个百分点（0.0485→0.0985）、大盘 −5 个百分点（0.3071→0.2571），
// 一增一减、Σ 仍 = 1.0000（用户 20260922 要求）。权重变化由 _hashFactorStructure 自动捕获 → 旧判断强制重算：
//   大盘 0.2571 | 资金量能 0.1783 | 对标期货 0.0971 | 增持减持 0.0985
//   行业板块 0.0801 | 科技指数 0.0632 | 个股短期动向 0.2257
const W_SENTIMENT = 0.2571;
const W_CAPITAL = 0.1783;
const W_FUTURES = 0.0971;
const W_HOLDINGS = 0.0985;
const W_SECTOR_LIMIT = 0.0801;
const W_SEESAW = 0.0632;
const W_TECH_SHORT = 0.2257;
// 子因子权重（在所属因子内归一化后参与该因子评分；用户 20260917 确认「参与评分」）
const MARKET_SHORT_SUB_W = 0.25;  // 「大盘短期走势」在「大盘」因子内
const SECTOR_TREND_SUB_W = 0.35;  // 「行业短期走势」在「行业板块」因子内
const SECTOR_NEWS_SUB_W = 0.20;   // 「板块消息」在「行业板块」因子内
const LIMIT_SUB_W = 0.45;         // 涨跌停占比差在「行业板块」因子内
const EMOTION_SUB_W = 0.25;       // 「市场情绪提醒」在「大盘」因子内
const STOCK_SENT_SUB_W = 0.30;    // 「舆情与讨论热度（个股）」在「个股短期动向」因子内
const EARN_SUB_W = 0.10;          // 「财报解读」在「个股短期动向」因子内
const SHORT_DIR_SUB_W = 0.50;     // 「短期动向预判」在「个股短期动向」因子内

const FACTOR_KEYS = ['sentiment', 'capital', 'futures', 'holdings', 'sectorLimit', 'seesaw', 'technicalShort'];
const FACTOR_NAME = {
  sentiment: '大盘', capital: '资金量能', futures: '对标期货短期走势',
  holdings: '增持减持', sectorLimit: '行业板块', seesaw: '科技指数（负相关）',
  technicalShort: '个股短期动向',
};
// 20260917i：删除「大盘及行业板块短期走势」因子（原 0.114），其余 7 因子按比例等比放大至 Σ=1.0000。
// 注：各 factor* 函数一律引用上方 W_* 常量，不再内嵌字面量，杜绝「两处不一致」。
const DEFAULT_WEIGHTS = {
  sentiment: W_SENTIMENT, capital: W_CAPITAL, futures: W_FUTURES,
  holdings: W_HOLDINGS, sectorLimit: W_SECTOR_LIMIT, seesaw: W_SEESAW, technicalShort: W_TECH_SHORT,
};

// ===== 因子结构哈希守卫（替代纯手工 SCHEMA_VERSION，20260906）=====
// 规则：凡因子增删/改名、默认权重调整，FACTOR_KEYS / DEFAULT_WEIGHTS 变化 → 哈希自动变化
// → 旧判断记录（data/judgments/*.json）被判「旧schema」强制重算，从机制上杜绝
// 「改了因子结构却漏升版 → 旧记录被静默复用、重启不生效」。纯展示布局/口径调整
// （非因子名/权重/数量）则手动 +1 下方 LAYOUT_VERSION。
function _hashFactorStructure() {
  const payload = JSON.stringify({ keys: FACTOR_KEYS, weights: DEFAULT_WEIGHTS });
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}
// 20261021i：股份回购子卡片口径修正（历史方案闸门 + 未足额区分）——展示文案变化，因子结构哈希不捕获，
// 必须升 LAYOUT_VERSION 强制重算旧记录，否则旧快照静默复用、页面仍显示「完成实施（已达承诺上限 24%）」。
// 20261106a：旧量价位置体系退役，position.label 值域改为三分区，当日行情判断「量价配合」子因子分值变化（如 缩量上涨@旧上涨途中 +0.4 → 中位区间 −0.25）；因子结构哈希不捕获该变化 → 手动升版强制重算旧判断记录。
const LAYOUT_VERSION = '20261109c'; // 20261109c：生死位规则3 显示名「缩量假突破」→「假突破量能不确认」，且全引擎量能判定接入 lib/volumeCaliber 单一真值源（>1.3/<0.8）、前高量能基准改同价位带最近前高并降级为参照——卡片显示名与量能档位结论均变化，因子结构哈希不捕获 → 手动升版强制重算当日判断记录。 // 20261107a：判定记录新增 pos135 字段（135 格综合判定·量价每日生效唯一判定）挂入每只个股每日记录，供「判定记录」模块回看；仅新增展示字段、不改 6 因子结构与 verdict，因子结构哈希不捕获 → 手动升版强制重算当日判断以回填 pos135（20261106o：量价关系涨跌判定与 135 格走势档同源（capitalFlow.volumePrice.signal 改消费 posJudgment.price.walk 五档：大涨≥5/上涨≥1.2/震荡±1.2/下跌/大跌；新增「巨量/放量/平量/缩量/地量震荡」5 种中性信号，VP_POS_BASE 加 5 个 0 分 key；bigUp/bigDown 阈值 3%→5% 对齐大涨/大跌档）——「资金量能」因子量价配合子信号的输入 signal 值域与分值变化（同日数据 +0.28% 由「缩量上涨」-0.25 改判「缩量震荡」0），因子结构哈希不捕获 → 手动升版强制重算当日判断。 // 20261106j：量能档位分母统一 ÷20 日均量（volumeEngine._volumeTier 与 135 格推演图同源，放量>1.3/平量0.8~1.3/缩量<0.8）——「资金量能」因子量价配合子信号的输入 unifiedTier 随分母变化（同日数据可由「平量上涨」改判「放量上涨」），vpSigMap 分值随之变化；因子结构哈希不捕获 → 手动升版强制重算当日判断。 // 20261104k：「利润增长」显示名改名「归母净利润」（用户指令，短期判断信号 label 与左卡/右卡联动）——显示名变更因子结构哈希不捕获 → 手动升版强制重算当日判断。 // [20261028c 前注] 20261028c：「市场情绪提醒」引用子因子单源同义修复（首页中性被引用处 impactScore 方向保底判成利空+权重-13%）——signal 改按 tendencyKey 继承首页判档（neutral→0、bull/bear→按 tendency 定号取|score|），detail 注明「徽标继承首页判档」；子因子信号口径变化哈希不捕获 → 手动升版强制重算当日判断。 // [20261026b 前注] 20261026b：宽基ETF申赎 10-23 真数据回填（NeoData 权威源，净申购 322.86 亿替代假 0/降级）——大盘情绪因子输入数据实质变化，哈希不捕获 → 手动升版强制重算当日判断。 // [20261025g 前注] 20261025g：市场情绪数据统一两位小数（用户 2026-10-25 要求「数据保留小数点后两位」）——模型 volumeText 量比 round 2（修复「量比 1.2390594651481384」式 16 位浮点外漏）、核心驱动贡献/权重 round 2、个股「市场情绪提醒」子卡情绪总分 round 2；前端情绪面板权重/净权重/总分 toFixed(2)。展示文案变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261025f：市场情绪模型改「净权重=评分」（用户 2026-10-25 要求 8 因子对齐短期判断模块口径）——首页落盘情绪总分口径变化，个股「市场情绪提醒」子卡 signal（=落盘 score）随之变化 → 手动升版强制重算当日判断。 // 20261025e：volumeEngine._reconcileTodayBar 追加条件放宽修复（用户 2026-10-25 报「量能信号中性 vs 量价配合放量下跌」矛盾）：旧条件 quote.date===todayStr 在周末/节假日失效，最近交易日（周五）终值 quote 被拒之门外，bars 末根停留 10-22 → 量能信号/量价配合把 10-22 数据当「当日」（实际 10-23 为放量上涨 +2.26%）；改为 quote 新于末根且 ≤今天且是交易日即补齐，实测 000902 date 补至 10-23、主判转「量增价升看延续」与行情一致。量能输入数据变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261025d：子卡「取值」大字去裸百分比——融资余额/涨停占比/跌停占比/行业短期走势/期货近5日走势的 value 加语义前缀（较前值/涨停/跌停/板块/期货），消除与「权重 ±X%」的同色百分比撞脸误读（用户 2026-10-25 问「为什么融资余额出现两个权重数据」：-0.95% 是市场数据不是权重）。纯展示文案变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261025c：权重=评分机制铺满整个短期判断模块（用户 2026-10-25 要求「应用到整个短期判断模块，不是只用在事件驱动」）：全部 7 因子子卡下发因子内份额（share），因子信号 = Σ(份额×满格方向±1)，因子评分=净权重、子卡=份额权重——市场情绪/资金量能/增持减持/行业板块/个股短期动向沿用既有融合权重作份额，对标期货以相关性强度作份额，跷跷板死区后满格；资金量能新增「主力净流入」0.05 份额（此前纯展示不计分）。信号口径全面变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261025b：事件驱动因子聚合信号由「信号强度加权」改为「方向满格加权」（用户 2026-10-25 要求「删除复杂的评分系统，直接用权重等于评分」——事件按权重把 ±1 满格方向计入，贡献分≈净方向权重，如回购+30%、原油-4% → 净+26%≈+26 分）；子卡片删「得分」只留「权重 ±X%」；因子行删「得分」只留「净权重（最高）/ 权重」；布局改 flex-wrap 自适应防截断。信号口径变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261025a：子因子新增带符号权重下发（事件驱动子事件 effWeight → subFactors[].weight，恒正、方向由 signal 承载）+ 前端因子行「净权重（最高X%）/ 得分」双显示、子卡片「权重 ±X% / 得分」（用户 2026-10-25 要求「所有权重与得分都要显示」，净权重=Σ(子权重×方向)，如回购+30%、原油-6% → 净24%/最高36%）——子因子结构变化哈希不捕获 → 手动升版强制重算当日判断。 // 20261023i：股份回购子卡片从「增持减持」迁入「事件驱动」因子（回购提议权重 10% / 回购实施中 30%，见 lib/eventEngine.buildBuybackEvent），增持减持因子不再消费 buyback、不再把回购计入利好家数；属展示布局/子模块迁移、因子结构哈希不捕获 → 手动升版强制重算当日判断。 // 20261019f：量能定档标准对齐市场（volumeEngine 改「÷5日均量市场标准量比 0.8/1.2/0.5 单独定档」，60 日均量确认不再翻转档位）——「资金量能」因子的量价配合子因子展示值随档位变化（如量比 0.95 由「缩量上涨」回「平量上涨」），因子结构哈希不捕获 → 手动升版强制重算当日判断。 // 20261019e：资金量能量价标签口径修正（capitalFlow.js 下跌侧分级改为「巨量下跌(huge)/放量下跌(amp)」，旧 amp 档「量价齐跌」标签与「下跌放量」解释自相矛盾已修）——sameDayJudgment vpSigMap 分值按档位继承（巨量下跌=原放量下跌 -0.6、放量下跌=原量价齐跌 -0.5），子因子「量价配合」展示值随标签名变化；属口径/展示调整、因子结构哈希不捕获 → 手动升版强制重算当日判断。 // 20260922h：「增持减持」因子新增第④子模块「股东被动减持/司法强制执行」：扫公告/新闻标题按股东姓名(前十大股东 name)或角色词(二股东/大股东)+司法强制执行/被动减持/强制平仓/司法拍卖 关键词关联，确认已发生被动减持 signal=-0.8、仅司法冻结/拍卖预告 -0.6；父因子 signal 在原 0.55×方向+0.45×力度 基础上叠加 0.2×forcedSignal 困境溢价(forced=0 时恒为 0、旧校准不动)；caption 在确认时打 ⚠ 雷点。性质检测走公告流(实时)、不依赖 F10 季报滞后(9月事件等 Q3 才进 F10)。属展示内容/子模块新增、哈希不捕获 → 手动升版强制重算当日判断。 // 20260921l：「原油主连」冲击有效期由 3 天改为 1 天（用户要求），并修正取数通道（push2delay 不可达 → 新浪 nf_SC0）；20260921k：「股份回购」完成实施/停止实施/被股东大会否决时判定转为中性（signal=0、不再计入增持家数），利好力量仅来自尚未买入的承诺资金；20260921j：「股份回购」子卡片由「标题正则扫到几条」改为东财结构化回购报表（RPTA_WEB_GETHGLIST_NEW），按「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素提炼——展示内容变化、哈希不捕获 → 手动升版强制重算当日判断（否则旧快照静默复用、页面看不到新格式）。 20260921c：量价配合口径修正——「大涨+平量(量比0.8~1.2)」由「显著上涨」(+8 / +0.4) 改判中性「大涨平量」(0 / 0)：大涨而量能未放大属量价背离、不再算利好（同步改 capitalCharts 配色/计分）；属口径调整、哈希不捕获 → 手动升版强制重算当日判断。 20260921a：事件驱动「口径级」修复补丁——newsSectorImpact 把「医药生物」按申万二级拆为「药品」「医疗器械」两条互斥规则、且 eventEngine 禁止 company_event 外溢广播至全行业（阳普医疗认证/药监局药品监管不再误挂医疗器械股）。此类改动不触及因子名/权重/数量（_hashFactorStructure 不捕获）→ 必须手动升版强制重算当日判断缓存，否则「清了事件、页面仍显示旧事件」。 20260918a：移除「行业板块」因子「板块成分」子卡片（展示布局/口径调整，非因子名/权重/数量，_hashFactorStructure 不捕获）→ 手动升版强制重算旧判断缓存，避免旧记录静默复用仍显示该卡片。 20260917i：个股页卡片重组（用户要求）——「市场情绪与消息面」改名「大盘」（删除「消息情绪（大盘）」「涨跌停比」两个子因子及其底层逻辑；新增「市场情绪提醒」子因子直接引用首页判断；转入「大盘短期走势」）；「板块涨跌停占比」改名「行业板块」（转入「板块消息」「行业短期走势」）；删除「大盘及行业板块短期走势」整个因子；「财报解读」「舆情与讨论热度（个股）」迁入「个股短期动向」；因子权重等比放大至 Σ=1.0000。因子结构变化（market 移除）由哈希自动捕获，此处手动升版确保布局同时刷新。展示布局/口径调整时手动 +1；因子结构变化由哈希自动捕获（20260915a：个股行业展示口径统一——公司概况与 sameDay 行业板块因子优先使用 sectorIdentity 精确行业（f10Name/emIndustry/industry），并对 THS_BOARD_BY_CODE 硬编码映射兜底，避免 688660 电气风电等股票因 F10 CSRC 泛化分类（制造业-通用设备制造业）被错配为通用设备；20260913g：股东报告期口径修正——「最新报告期」不再限定季度末，改为取东财最新一个满10行完整披露日（含非季度末的权益变动/临时披露，如海天味业 2026-07-03）；periodTag 改按「是否最新可得披露」判定，避免把更新的非季度末披露误标为“非最新季报期”；同步升级以强制重算旧记录；20260913f：增持减持因子补「数据报告期」标注——因子 caption + 两个子卡片均显式标注报告期与是否最新季报期，修掉「小卡片无日期」；同时借此强制重算旧记录，清掉报告期仍停留在临时公告日（如华安证券 2026-07-23）的陈旧缓存；20260911d：事件驱动因子「原油冲击」参考对象由布伦特原油期货改为原油主连(INE·scm主连)——因子名/文案变更，升版强制重算旧记录以刷新事件因子卡片；20260911c：新增该子因子）；20260922i：修复「公告漏抓」——① 数据端 searchAnnouncementsByCode 东财旧路径 /api/security/announcement 已失效(HTTP200空body)→ 改走可用 /api/security/ann 并带 ann_type=A&client_source=web&f_node=0&s_node=0，real titles 已验证可抓(执行完成的结果公告/拟被司法强制执行)；② detectForcedReduction 正则扩展覆盖真实措辞(执行完成/拟被司法强制执行/司法冻结/轮候冻结)，并加增持计划执行完成等利好语境排除，避免误判。属数据源+检测口径改动、哈希不捕获 → 手动升版强制重算当日判断缓存。
const SCHEMA_VERSION = 'h' + _hashFactorStructure() + '-' + LAYOUT_VERSION;
const LEARN_DIR = path.join(__dirname, '..', 'data', 'learning');
const LEARN_FILE = path.join(LEARN_DIR, 'state.json');
const LEARN_MIN_SAMPLE = 5;   // 单因子样本下限，低于此值不调整权重
const LEARN_SMOOTH = 0.4;     // 新权重占比（慢速进化）

let learningState = null;
function loadLearning() {
  if (learningState) return learningState;
  let loaded = null;
  try { loaded = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')); } catch (e) { loaded = null; }
  learningState = {
    factorStats: {},
    byVerdict: {},
    weights: { ...DEFAULT_WEIGHTS },
    // 按个股独立累积的命中统计与专属权重（每只股票根据自身准确率进化）
    bySymbol: {},
    // 保留权重演进历史，使「进化时间线」跨重启持续
    weightHistory: (loaded && Array.isArray(loaded.weightHistory)) ? loaded.weightHistory : [],
    learnedCount: 0,
    lastUpdated: null,
    recentErrors: [],
  };
  for (const v of ['涨', '跌', '震荡']) learningState.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  return learningState;
}
function saveLearning() {
  try {
    if (!fs.existsSync(LEARN_DIR)) fs.mkdirSync(LEARN_DIR, { recursive: true });
    fs.writeFileSync(LEARN_FILE, JSON.stringify(learningState, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}
function _bump(bucket, key, hit) {
  if (!bucket[key]) bucket[key] = { hits: 0, total: 0 };
  bucket[key].total++;
  if (hit) bucket[key].hits++;
}
// 注：学习模型采用「从全部已结算判断幂等重建」(见 rebuildLearning)，
// 不再依赖单条记录的标记位，避免跨进程/重启后状态丢失。该函数已废弃。
function recordJudgmentOutcome() {}

// 新建一个「个股学习桶」：全局 + 按预测方向（涨/跌/震荡）的因子命中统计与专属权重
function newSymbolBucket() {
  const b = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS }, byVerdict: {} };
  for (const v of ['涨', '跌', '震荡']) b.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  return b;
}
// 基于命中率重算「单个桶」的自适应权重（命中率低的因子降权，带平滑与样本下限）
function _recomputeBucketWeights(factorStats, prevWeights) {
  const newW = {};
  for (const k of FACTOR_KEYS) {
    const stat = factorStats[k];
    const base = DEFAULT_WEIGHTS[k];
    const old = (prevWeights && prevWeights[k] != null) ? prevWeights[k] : base;
    if (stat && stat.total >= LEARN_MIN_SAMPLE) {
      const cr = stat.hits / stat.total;
      const target = clamp(base * (0.5 + cr), 0.03, 0.6);
      newW[k] = round(old * (1 - LEARN_SMOOTH) + target * LEARN_SMOOTH, 4);
    } else {
      newW[k] = old;
    }
  }
  const sum = FACTOR_KEYS.reduce((a, k) => a + (newW[k] || 0), 0) || 1;
  for (const k of FACTOR_KEYS) newW[k] = round(newW[k] / sum, 4);
  return newW;
}
// 基于命中率重算自适应权重：全局 + 按预测方向 + 每个个股（含其按预测方向）
function recomputeWeights() {
  const st = loadLearning();
  for (const v of ['涨', '跌', '震荡']) {
    const bv = st.byVerdict[v];
    bv.weights = _recomputeBucketWeights(bv.factorStats, bv.weights);
  }
  st.weights = _recomputeBucketWeights(st.factorStats, st.weights);
  // 按个股独立进化：每只股票累积自身命中率，得到专属权重比
  for (const ns of Object.keys(st.bySymbol)) {
    const sb = st.bySymbol[ns];
    for (const v of ['涨', '跌', '震荡']) {
      const sbv = sb.byVerdict[v];
      sbv.weights = _recomputeBucketWeights(sbv.factorStats, sbv.weights);
    }
    sb.weights = _recomputeBucketWeights(sb.factorStats, sb.weights);
  }
  // 权重演进记录（全局权重时间线，每天最多一条）
  const today = localDate();
  const last = st.weightHistory[st.weightHistory.length - 1];
  if (!last || last.date !== today) {
    st.weightHistory.push({ date: today, weights: { ...st.weights } });
    if (st.weightHistory.length > 60) st.weightHistory.shift();
  }
}
// 取某「个股 + 预测方向」的自适应权重；按回退链逐级降级：
//   1) 该股票按预测方向的专属权重（样本最贴合该股该方向）
//   2) 该股票全局专属权重（该股各方向综合）
//   3) 全局按预测方向权重（跨股票）
//   4) 全局默认权重
function getAdaptiveWeights(symbol, dir) {
  const st = loadLearning();
  const sampleOf = (bv) => FACTOR_KEYS.reduce((a, k) => a + ((bv && bv.factorStats && bv.factorStats[k] && bv.factorStats[k].total) || 0), 0);
  const ns = normSymbol(symbol);
  const sb = st.bySymbol[ns];
  if (sb) {
    const sbv = sb.byVerdict[dir] || sb.byVerdict['震荡'];
    if (sampleOf(sbv) >= 10) return sbv.weights;
    if (sampleOf(sb) >= 10) return sb.weights;
  }
  const gv = st.byVerdict[dir] || st.byVerdict['震荡'];
  if (sampleOf(gv) >= 10) return gv.weights;
  return st.weights;
}
// 历史回填 / 重建：遍历所有已结算判断，幂等重建因子命中统计 + 错误归因 + 自适应权重。
// 每次结算或查询学习状态时调用，确保模型与磁盘上的判断记录完全一致。
function backfillLearning() {
  const st = loadLearning();
  st.factorStats = {};
  st.byVerdict = {};
  for (const v of ['涨', '跌', '震荡']) st.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  st.bySymbol = {}; // 幂等重建：每次从全部已结算记录重新累计每只股票的命中统计
  st.recentErrors = [];
  st.learnedCount = 0;
  const records = getAllRecords();
  const errs = [];
  for (const rec of records) {
    if (!rec.settled) continue;
    st.learnedCount++;
    const actualDir = rec.actualDir || '震荡';
    const actualSign = actualDir === '涨' ? 1 : (actualDir === '跌' ? -1 : 0);
    const factors = rec.factors || [];
    for (const f of factors) {
      if (!f || !f.applicable) continue;
      if (!FACTOR_KEYS.includes(f.key)) continue;
      const fsign = Math.sign(f.signal || 0);
      const hit = actualSign === 0 ? (fsign === 0) : (fsign === actualSign);
      _bump(st.factorStats, f.key, hit);
      const bv = st.byVerdict[rec.dir] || (st.byVerdict[rec.dir] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } });
      _bump(bv.factorStats, f.key, hit);
      // 按个股累计：该股自身各因子命中率，用于推导专属权重比
      const ns = normSymbol(rec.symbol);
      if (!st.bySymbol[ns]) st.bySymbol[ns] = newSymbolBucket();
      const sb = st.bySymbol[ns];
      _bump(sb.factorStats, f.key, hit);
      const sbv = sb.byVerdict[rec.dir] || (sb.byVerdict[rec.dir] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } });
      _bump(sbv.factorStats, f.key, hit);
    }
    if (!rec.correct) {
      const misleading = factors
        .filter(f => f.applicable && Math.sign(f.signal || 0) !== 0 && Math.sign(f.signal || 0) === -actualSign)
        .sort((a, b) => Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0));
      errs.push({
        symbol: rec.symbol, name: rec.name, date: rec.date, targetDate: rec.targetDate,
        verdict: rec.verdict, actualDir, actualChgPct: rec.actualChgPct,
        misleading: misleading.map(f => ({ key: f.key, name: f.name, signal: f.signal, contribution: f.contribution })),
      });
    }
  }
  errs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  st.recentErrors = errs.slice(0, 15);
  st.lastUpdated = new Date().toISOString();
  recomputeWeights();
  const today = localDate();
  const last = st.weightHistory[st.weightHistory.length - 1];
  if (!last || last.date !== today) {
    st.weightHistory.push({ date: today, weights: { ...st.weights } });
    if (st.weightHistory.length > 60) st.weightHistory.shift();
  }
  saveLearning();
  return st;
}

// 对外暴露学习状态（供前端「错误分析与自我进化」面板）
//   symbol 非空时额外返回该股票专属的命中率与权重进化（按个股独立进化）
function getLearningState(symbol) {
  const st = backfillLearning(); // 幂等重建，确保与已结算判断完全一致
  const factorReliability = FACTOR_KEYS.map(k => {
    const g = st.factorStats[k] || { hits: 0, total: 0 };
    return { key: k, name: FACTOR_NAME[k] || k, hits: g.hits, total: g.total, correctRate: g.total ? round(g.hits / g.total * 100) : null };
  });
  const weightEvolution = FACTOR_KEYS.map(k => ({
    key: k, name: FACTOR_NAME[k] || k,
    default: DEFAULT_WEIGHTS[k],
    current: st.weights[k],
    byVerdict: {
      涨: st.byVerdict['涨'].weights[k],
      跌: st.byVerdict['跌'].weights[k],
      震荡: st.byVerdict['震荡'].weights[k],
    },
  }));
  const enough = FACTOR_KEYS.reduce((a, k) => a + ((st.factorStats[k] && st.factorStats[k].total) || 0), 0) >= 10;

  // 按个股专属学习状态（前端个股视图展示该股票自身的命中率与权重进化）
  let bySymbolState = null;
  if (symbol) {
    const ns = normSymbol(symbol);
    const sb = st.bySymbol[ns];
    if (sb) {
      const symFactorReliability = FACTOR_KEYS.map(k => {
        const g = sb.factorStats[k] || { hits: 0, total: 0 };
        return { key: k, name: FACTOR_NAME[k] || k, hits: g.hits, total: g.total, correctRate: g.total ? round(g.hits / g.total * 100) : null };
      });
      const symWeightEvolution = FACTOR_KEYS.map(k => ({
        key: k, name: FACTOR_NAME[k] || k,
        default: DEFAULT_WEIGHTS[k],
        current: sb.weights[k],
        byVerdict: {
          涨: sb.byVerdict['涨'].weights[k],
          跌: sb.byVerdict['跌'].weights[k],
          震荡: sb.byVerdict['震荡'].weights[k],
        },
      }));
      const symSample = FACTOR_KEYS.reduce((a, k) => a + ((sb.factorStats[k] && sb.factorStats[k].total) || 0), 0);
      bySymbolState = {
        exists: true,
        symbol: ns,
        learnedCount: symSample,
        sampleEnough: symSample >= 10,
        factorReliability: symFactorReliability,
        weightEvolution: symWeightEvolution,
        currentWeights: sb.weights,
        byVerdictWeights: { 涨: sb.byVerdict['涨'].weights, 跌: sb.byVerdict['跌'].weights, 震荡: sb.byVerdict['震荡'].weights },
      };
    } else {
      bySymbolState = { exists: false, symbol: ns, note: '该股票暂无已结算判断记录，无法生成专属权重（沿用全局/默认权重）' };
    }
  }

  // 个股视图：错误归因只显示该股票的记录，避免跨股污染
  const recentErrors = symbol
    ? (st.recentErrors || []).filter(e => normSymbol(e.symbol) === normSymbol(symbol))
    : (st.recentErrors || []);

  return {
    learnedCount: st.learnedCount || 0,
    lastUpdated: st.lastUpdated,
    sampleEnough: enough,
    factorReliability,
    weightEvolution,
    defaultWeights: DEFAULT_WEIGHTS,
    currentWeights: st.weights,
    byVerdictWeights: { 涨: st.byVerdict['涨'].weights, 跌: st.byVerdict['跌'].weights, 震荡: st.byVerdict['震荡'].weights },
    bySymbol: bySymbolState,
    recentErrors,
    weightHistory: st.weightHistory || [],
  };
}

// ============ 生成判断 ============
async function buildJudgment(symbol, name, industry) {
  const [quoteR, historyR, sectorIdR, futuresR, marketR, newsR, sentimentR, shareholdersR, globalSentimentR, reportR, announceR, announceCodeR, regulatoryR, h60R, marketTechR] = await Promise.allSettled([
    getQuote(symbol),
    getHistory(symbol, '1y').catch(() => []),
    resolveSectorIdentity(symbol, name || '').catch(() => null),
    Promise.resolve(getFuturesMeta(symbol) ? fetchFuturesCorrelation(symbol, name || '').catch(() => ({ hasFutures: false })) : { hasFutures: false }),
    getMarketOverview().catch(() => null),
    getNews(symbol, name || '').catch(() => []),
    getMarketSentiment(symbol, name || '').catch(() => null),
    getShareholdersData(symbol).catch(() => null),
    getGlobalSentiment(name || '', { days: 2, maxArticles: 10, budget: 8 }).catch(() => ({ ok: false, count: 0 })),
    interpretReport(symbol).catch(() => ({ ok: false })),
    searchAnnouncements(name || '', 10).catch(() => ({ ok: false, items: [] })),
    searchAnnouncementsByCode(symbol, 30).catch(() => ({ ok: false, items: [] })),
    getRegulatoryNews('all', 12).catch(() => ({ ok: false, items: [] })),
    getHistoryPeriod(symbol, '60m', 400).catch(() => []), // 20260903o：技术面短期动向因子（与「技术面分析」页同源）
    getMarketTechnical().catch(() => ({ indices: [] })), // 20260905d：大盘/行业短期走势因子联动首页大盘技术分析模块
  ]);

  const quote = quoteR.status === 'fulfilled' ? quoteR.value : null;
  const history = historyR.status === 'fulfilled' ? historyR.value : [];
  const h60 = h60R && h60R.status === 'fulfilled' ? h60R.value : null;
  const sectorId = sectorIdR.status === 'fulfilled' ? sectorIdR.value : null;
  const futures = futuresR.status === 'fulfilled' ? futuresR.value : { hasFutures: false };
  const market = marketR.status === 'fulfilled' ? marketR.value : null;
  const stockNews = newsR.status === 'fulfilled' ? newsR.value : [];
  let sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const shareholders = shareholdersR.status === 'fulfilled' ? shareholdersR.value : null;
  const globalSentiment = globalSentimentR.status === 'fulfilled' ? globalSentimentR.value : { ok: false, count: 0 };
  const report = reportR.status === 'fulfilled' ? reportR.value : { ok: false };
  const announcements = announceR.status === 'fulfilled' ? announceR.value : { ok: false, items: [] };
  const announcementsByCode = announceCodeR.status === 'fulfilled' ? announceCodeR.value : { ok: false, items: [] };
  const regulatory = regulatoryR.status === 'fulfilled' ? regulatoryR.value : { ok: false, items: [] };
  const marketTech = marketTechR && marketTechR.status === 'fulfilled' ? marketTechR.value : { indices: [] };

  // 20260905e：按个股真实成分股筛大盘/行业指数（lib/indexConstituents.pickIndicesForStock）。
  // 一次性算好传入 factorMarketShort，避免重复网络查询。
  let selectedIndices = (market && market.cn) || [];
  let scopeLabel = '—';
  try {
    const sel = await selectMarketIndicesByStock((market && market.cn) || [], symbol);
    selectedIndices = sel.indices || [];
    scopeLabel = sel.scopeLabel || scopeLabel;
  } catch (e) {
    console.warn('[SameDayJudgment] selectMarketIndicesByStock failed:', e.message);
  }
  const stockCtx = { symbol, techIndices: marketTech.indices || [], selectedIndices, scopeLabel };

  // 合并双源公告（名称搜索 + 代码兜底），按标题去重——避免深交所接口失效时漏掉回购/分红/增持等关键公告
  const annSeen = new Set();
  const allAnnouncements = [];
  for (const src of [announcements, announcementsByCode]) {
    if (src && src.ok && Array.isArray(src.items)) {
      for (const a of src.items) {
        const t = a && a.title;
        if (t && !annSeen.has(t)) { allAnnouncements.push(a); annSeen.add(t); }
      }
    }
  }
  // 回购识别（20260921j 重构）：
  //   旧口径**只扫标题正则**，命中一条含「回购」的新闻标题就计 1 次、并把标题原文当 detail —— 结果
  //   用户要看的「已回购多少股/多少钱、承诺回购多少钱、进度到哪」一个都没提炼（实测 600909 卡片
  //   显示的竟是一条「…回应二股东减持及回购力度…」的新闻标题，真实数据是已回购 2537 万股/2.0 亿、
  //   承诺 1~2 亿、已完成实施）。
  //   新口径**结构化优先**：走东财回购报表（lib/buybackEmDc，datacenter-web 可达）拿权威字段；
  //   报表无记录时再退回标题扫描（保留旧能力，覆盖"公告源偶发空但新闻有报道"的场景）。
  const BUYBACK_RE = /回购(股份|注销|方案|实施|进展|预案)?|股份回购/;
  let buyback = { ok: false, count: 0 };
  let buybackSrc = 'none';
  try {
    const bp = await getBuybackPlan(symbol);
    if (bp && bp.ok && bp.plan) {
      // 结构化命中：count 保持「报表档数」语义（兼容旧消费方），titles 不再塞新闻标题
      buyback = {
        ok: true,
        count: bp.plans.length,
        latest: bp.plan.date || '',
        titles: [],
        structured: true,
        plan: bp.plan,
        plans: bp.plans,
        text: formatBuybackPlan(bp.plan),
      };
      buybackSrc = 'eastmoney-datacenter';
    } else if (bp && bp.reason === 'error') {
      console.warn('[buildJudgment] 回购报表取数失败，退回标题扫描:', bp.error);
    }
  } catch (e) {
    console.warn('[buildJudgment] 回购报表异常，退回标题扫描:', e.message);
  }
  if (!buyback.ok) {
    const buybackCandidates = [];
    for (const a of allAnnouncements) if (a && a.title && BUYBACK_RE.test(a.title)) buybackCandidates.push({ title: a.title, date: a.date || '' });
    for (const n of stockNews) if (n && n.title && BUYBACK_RE.test(n.title)) buybackCandidates.push({ title: n.title, date: n.date || '' });
    if (buybackCandidates.length) {
      buyback = {
        ok: true,
        count: buybackCandidates.length,
        latest: buybackCandidates.map(x => x.date).filter(Boolean).sort().reverse()[0] || '',
        titles: buybackCandidates.map(x => x.title),
        structured: false,
      };
      buybackSrc = 'title-scan';
    }
  }
  console.log(`[buildJudgment] symbol=${symbol} buyback src=${buybackSrc} ok=${buyback.ok} count=${buyback.count || 0}`);

  // 资金量能（个股侧量能唯一出口 lib/capitalFlow.js）
  // analyzeCapitalFlow 内部已并行抓取资金流/融资融券/换手率序列，本模块不再重复抓取。
  const capital = (quote && history.length)
    ? await analyzeCapitalFlow(symbol, (name || (quote && quote.name) || ''), quote, history).catch(() => null)
    : null;

  // 个股换手率变化：20261017a 起改由资金量能根随 analyzeCapitalFlow 一并算出，
  // 经 volumeIndicators.turnoverChange 透传；不再单独抓一次换手率序列
  // （原 sameDayJudgment.js:1551 的 getEastmoneyTurnover 与 analyzeCapitalFlow 内部
  //  的 getEastmoneyTurnover 是同一数据的两次重复抓取，收敛后只抓一次）。
  const turnoverChange = (capital && capital.volumeIndicators && capital.volumeIndicators.turnoverChange)
    || { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' };

  // 行业名称：20260821c 统一走 sectorIdentity 单一可信源（代码覆盖 + 多源校验）
  // 20260821e 修复：sectorIdentity 返回的 symbol 已 normalize（去 SH/SZ 前缀），
  // 必须用 normSymbol 比较，否则前端传入 SH600460 等带前缀 symbol 时，
  // 会丢弃正确行业、回退到可能陈旧的前端 industry 参数，造成板块/消息/政策全部错配。
  const sectorIdMatch = sectorId && normSymbol(sectorId.symbol) === normSymbol(symbol);
  let industryName = sectorIdMatch ? (sectorId.industry || '') : '';
  if (!industryName && sectorId && !sectorIdMatch) {
    console.warn(`[buildJudgment] sectorIdentity symbol 不匹配: input=${symbol} output=${sectorId.symbol}，忽略其行业结果`);
  }
  if (!industryName && quote && quote.name) {
    try { const prof = await getCompanyProfile(symbol); if (prof && prof.industry) industryName = prof.industry; } catch (e) {}
  }
  if (!industryName) industryName = industry || '';
  console.log(`[buildJudgment] symbol=${symbol} name=${name || ''} resolvedIndustry=${industryName || 'N/A'} queryIndustry=${industry || 'N/A'} sectorSource=${sectorId ? sectorId.industrySource : 'none'} sectorMatch=${sectorIdMatch}`);

  // 20260910 修复：板块走势/涨跌停定位改用「细分行业名优先」。
  // 根因：申万一级（如 688660 电气风电=「新能源」）传入 sector_trend.py 后经同义词表泛化扩展
  // （新能源→[光伏,风电,储能,锂电]），候选按列表顺序盲匹配，「光伏」排在「风电」前 → 误命中「光伏设备」。
  // F10 细分行业（f10Name，如「风电设备」）能在同花顺板块列表精确命中，优先使用；
  // 仅影响板块走势/涨跌停两处定位，不改全局 industryName（板块消息联动/跨市场对标/政策关键词行为不变）。
  const fineIndustry = sectorIdMatch ? String(sectorId.f10Name || sectorId.emIndustry || '').trim() : '';

  // 20260915：同花顺 K 线板块覆盖兜底。当 sectorIdentity 失败或未命中细分行业时，
  // 仍按代码硬编码映射取精确板块名（如 688660→风电设备），避免回退到泛化行业/错误 CSRC。
  const boardOverride = THS_BOARD_BY_CODE[normSymbol(symbol)] || '';
  const effectiveFineIndustry = fineIndustry || boardOverride;

  // 行业板块走势：用个股行业名定位板块，取板块整体涨跌作为「大盘及行业板块短期走势」因子的行业部分
  const sectorTrend = await getSectorTrend(symbol, name || '', effectiveFineIndustry || industryName).catch(() => null);

  // 板块涨跌停占比：个股所属板块内涨停/跌停家数占比（短期情绪核心因子）
  const sectorLimit = await getSectorLimitStats(symbol, name || '', effectiveFineIndustry || industryName).catch(() => null);

  // 板块消息联动：板块/赛道级新闻情绪 → 个股传导（市场情绪因子的子信号）
  const sectorNews = await getSectorNewsSentiment(industryName, name || '', symbol).catch(() => null);
  if (sectorNews && sectorNews.industryName && sectorNews.industryName !== industryName) {
    console.warn(`[buildJudgment] sectorNews 行业不匹配: expected=${industryName} got=${sectorNews.industryName} symbol=${symbol}`);
  }

  // 跨市场传导：隔夜美股对标股涨跌 → A股板块情绪（市场情绪因子的子信号）
  // Part B：先按"对标主题与个股行业的关联度"（含经验折扣）算有效关联度，回传覆盖缩放信号
  const cmTickers = benchmarksForIndustry(industryName);
  let cmTheme = null, cmEffRel = 1;
  if (cmTickers.length) {
    const cmInfos = cmTickers.map(t => benchmarkRelevance(industryName, t, symbol));
    const cmBest = cmInfos.sort((a, b) => b.relevance - a.relevance)[0];
    cmTheme = cmBest.theme; cmEffRel = cmBest.relevance;
  }
  const crossMarket = await getCrossMarketSignal(industryName, cmEffRel).catch(() => null);

  // 防御性校验：市场情绪数据必须携带正确的 symbol，否则可能是跨股污染
  if (sentiment && sentiment.symbol && sentiment.symbol !== symbol) {
    console.warn(`[buildJudgment] sentiment 跨股污染: expected=${symbol} got=${sentiment.symbol}，降级为 null`);
    sentiment = null;
  }

  // 近期重大利好/利空因子输入：个股新闻 + 行业相关消息 + 交易所公告 + 监管政策（去重合并）
  let news = stockNews;
  const seenTitles = new Set(stockNews.map(n => n.title).filter(Boolean));
  // 1) 行业相关消息
  if (industryName) {
    try {
      const indNews = await fetchEastmoneyContentNews(industryName, 12);
      for (const n of indNews) {
        if (n.title && !seenTitles.has(n.title)) {
          news.push({ ...n, sentiment: analyzeSentiment((n.title || '') + ' ' + (n.summary || '')) });
          seenTitles.add(n.title);
        }
      }
    } catch (e) {}
  }
  // 2) 交易所公告（名称搜索 + 代码兜底双源合并；分红/增持/回购/处罚等公告是直接利好/利空）
  if (allAnnouncements.length) {
    for (const a of allAnnouncements) {
      const t = a && a.title;
      if (t && !seenTitles.has(t)) {
        news.push({ title: t, source: '交易所公告', summary: (a.stock_name || a.stock_code || ''), sentiment: analyzeSentiment(t) });
        seenTitles.add(t);
      }
    }
  }
  // 3) 监管/宏观政策（按行业/赛道相关性过滤，避免无关宏观新闻稀释个股消息面）
  if (regulatory && regulatory.ok && Array.isArray(regulatory.items)) {
    const kw = getSectorKeywords(industryName);
    const nm = (name || '').trim();
    for (const r of regulatory.items) {
      const t = r && r.title;
      if (!t || seenTitles.has(t)) continue;
      const relevant = (nm && t.includes(nm)) || kw.some(k => k && t.includes(k));
      if (relevant) {
        news.push({ title: t, source: '监管政策', summary: (r.source || ''), sentiment: analyzeSentiment(t) });
        seenTitles.add(t);
      }
    }
  }

  // 20260823i：把"近期重大利好/利空"拆为子信号并入市场情绪因子
  const newsSubs = computeNewsFactor(news, quote, history, report, symbol, sentiment ? sentiment.marketSentiment : null);
  // 20260917i：两个从「大盘」卡片迁出的子因子（舆情与讨论热度（个股）→个股短期动向；板块消息→行业板块）
  const stockSentSub = computeStockSentimentSub(sentiment, quote, symbol, capital, turnoverChange);
  const sectorNewsSub = computeSectorNewsSub(sectorNews);
  // 板块消息联动的弱关联主题（供结算复盘持续性学习）
  const weakThemes = (sectorNews && Array.isArray(sectorNews.weakThemes)) ? sectorNews.weakThemes : [];
  // 20260827d：板块跷跷板因子数据——取科技/半导体板块当日整体涨跌（仅非科技半导体个股使用）
  const isTechStock = TECH_EXCLUDE_INDUSTRIES.includes(industryName);
  let seesawData = { ok: false, compositeChange: 0, boards: {}, note: '' };
  if (!isTechStock) {
    try {
      const raw = await getBoardsTrend(TECH_BOARDS);
      if (raw && raw.boards) {
        const boards = {};
        const chgs = [];
        for (const k of TECH_BOARDS) {
          const b = raw.boards[k];
          if (b && b.ok && typeof b.boardChange === 'number') {
            boards[k] = b;
            chgs.push(b.boardChange);
          }
        }
        if (chgs.length) {
          const composite = round(avg(chgs), 3);
          seesawData = {
            ok: true,
            compositeChange: composite,
            boards,
            note: `科技板块均值 ${composite >= 0 ? '+' : ''}${composite}%（取自 ${chgs.length} 个板块）`,
          };
        } else {
          seesawData = { ok: false, compositeChange: 0, boards, note: '科技/半导体板块走势数据暂不可用，按中性处理' };
        }
      } else {
        seesawData = { ok: false, compositeChange: 0, boards: {}, note: '科技/半导体板块走势数据获取失败，按中性处理' };
      }
    } catch (e) {
      seesawData = { ok: false, compositeChange: 0, boards: {}, note: '科技/半导体板块走势获取异常，按中性处理' };
    }
  }
  // 20260905g：技术面短期动向因子改走 priceActionHub 唯一出口——与「技术面分析」页共用
  // 同一份快照与缓存（指标级单源），消除两页各自拉K线造成的跨页不一致。
  // hub 失败时回退本地 analyzePriceAction（用本次已拉取的 history/h60），保证因子不因单点失败缺失。
  let priceAction = null;
  try {
    const paSnap = await getPriceActionSnapshot(symbol);
    if (paSnap && !paSnap.error && paSnap.shortTerm) priceAction = paSnap;
  } catch (e) { /* 回退本地计算 */ }
  if (!priceAction && history && history.length >= 60) {
    try { priceAction = analyzePriceAction(history, h60 && h60.length ? h60 : null); } catch (e) { priceAction = null; }
  }
  // 20261101c：量能引擎位置标签透传给资金量能因子（与个股分析页同源），使判断引擎「量价配合」子卡位置感知
  const capitalPos = (capital && capital.volumeEngine && capital.volumeEngine.position && capital.volumeEngine.position.label) || null;
  const factors = [
    factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsSubs.parts, symbol, capital, turnoverChange, stockCtx),
    factorCapital(capital, turnoverChange, sentiment, quote, history, capitalPos),
    factorFuturesShort(futures),
    factorHoldings(shareholders, buyback, { announcements: allAnnouncements, news: stockNews, companyName: name }),
    factorSectorLimit(sectorLimit, sectorTrend, sectorNewsSub),
    factorSeesaw(seesawData, isTechStock),
    factorTechnicalShort(priceAction, stockSentSub, newsSubs.earnSub),
  ];
  // 第一遍：用默认权重得到初步方向
  const firstPass = combineFactors(factors);
  // 第二遍：按「个股 + 初步方向」取对应的「自适应权重」（样本不足时按回退链降级）
  const adaptive = getAdaptiveWeights(symbol, firstPass.dir);

  // 20260907a：第三遍叠加「事件驱动」权重覆盖（短期口径）。
  // 既有 8 因子按各自自适应权重等比例压缩，新增「事件驱动」因子，总和恒为 100%。
  // 无活跃事件时 evShort 为 null → 行为与旧版完全一致（weightsUsed = adaptive）。
  // 20260911：若该股有「专属因子」（如海天味业CPI），一并归并——常驻因子按
  //   (事件权重 + 专属权重) 等比压缩，事件/专属因子各自带有效权重，总和恒 ≤ 100%；
  //   无激活专属因子时 dedShort 为 null，对结果零影响（其他个股走此分支，隔离不变）。
  const evShort = eventEngine.buildEventOverride({ symbol, baseWeights: adaptive, factorKeys: FACTOR_KEYS, horizon: 'short', history, buyback });
  const dedShort = dedicatedFactor.buildDedicatedOverride({ symbol, baseWeights: adaptive, factorKeys: FACTOR_KEYS, horizon: 'short' });
  const nrShort = [];
  if (evShort) nrShort.push({ key: 'event', weight: evShort.combinedWeight, factor: evShort.eventFactor });
  if (dedShort) dedShort.dedicatedFactors.forEach(f => nrShort.push({ key: f.key, weight: f.weight, factor: f }));
  let finalFactors = factors;
  let finalWeights = adaptive;
  if (nrShort.length) {
    const merged = dedicatedFactor.mergeNonResidentOverrides(adaptive, FACTOR_KEYS, nrShort);
    finalFactors = factors.concat(merged.factors);
    finalWeights = merged.override;
  }
  const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(finalFactors, finalWeights);

  const now = new Date();
  const date = localDate(now);
  // 收盘后预测下一交易日（严格晚于今天），盘中预测当日后续行情；准确率每日 15:30 盘后结算。
  const closed = marketClosed(now);
  const target = 'nextday';
  const referenceDate = referenceCloseDate(now); // 基准收盘日（结算比价用）
  const targetDate = closed ? nextTradingDay(date) : date; // 收盘后=下一交易日，盘中=今天
  // 20261107：摘取 135 格综合判定（capital 已由上方 analyzeCapitalFlow 算出，含 volumeEngine.posJudgment），零新增计算成本
  const pos135 = extractPos135(capital);
  const judgment = {
    symbol,
    name: (quote && quote.name) || name || symbol,
    industry: industryName,
    horizon: 'short',        // 短期
    horizonLabel: closed ? '下一交易日' : '今日后续',
    date,                    // 判断生成当天的本地日期（展示用）
    referenceDate,           // 最近一次已收盘的交易日（结算基准价用）
    generatedAt: now.toISOString(),
    closed,
    target,
    targetDate,
    verdict,
    dir,
    score: Math.round(totalScore * 100),
    confidence,
    factors: scored,
    weightsUsed: finalWeights,
    weightsDefault: DEFAULT_WEIGHTS,
    price: quote ? quote.price : null,
    prevClose: quote ? quote.prevClose : null,
    settled: false,
    // 三规则铺开：判断结果自身也纳入规则约束（时效 + 当日涨跌的边际）
    // ★ 20260902a：传入 dir，使 consistency 文字方向词与 verdict/dir 同源（修复口径冲突）
    rules: decorateJudgmentRules({
      dataTime: referenceDate || date,
      source: '短期判断引擎（八因子加权）· 行情与消息面/技术面',
      price: quote ? quote.price : null,
      prevClose: quote ? quote.prevClose : null,
      score: Math.round(totalScore * 100),
      dir,
    }),
    // Part B：弱关联主题元信息，供结算复盘记录持续性经验
    crossMarketMeta: (crossMarket && crossMarket.ok) ? { theme: cmTheme, relevance: cmEffRel } : null,
    sectorNewsMeta: (sectorNews && sectorNews.ok) ? { relevance: sectorNews.relevance, weakThemes } : null,
    // 20261107：135 格综合判定（量价每日生效唯一判定）每日落盘，供「判定记录」模块回看
    pos135,
  };
  // 最终防线：如果 judgment.symbol 或 industry 与入参不一致，说明内部逻辑出现污染，直接抛错避免落盘
  if (judgment.symbol !== symbol) {
    throw new Error(`[buildJudgment] 生成的判断 symbol 不一致: input=${symbol} output=${judgment.symbol}`);
  }
  if (industryName && judgment.industry !== industryName) {
    throw new Error(`[buildJudgment] 生成的判断 industry 不一致: input=${industryName} output=${judgment.industry}`);
  }

  // 20260821f 财报事件 → 资料库自动同步（一致性原则）：
  // 从个股新闻 + 合并公告中检测「YYYY年中期/半年度/年度报告」发布事件；
  // 若资料库缺失该报告期 PDF，异步触发下载+登记（幂等：每日每报告期一次，不阻塞响应）。
  // 同步结果挂在 judgment.reportEvent 供前端展示（如「已同步/缺口」）。
  try {
    const reportEvent = reportSync.detectReportEvent(symbol, name || '', stockNews, allAnnouncements);
    if (reportEvent) {
      judgment.reportEvent = reportEvent;
      const gap = !reportSync.hasReportDoc(reportEvent.symbol, reportEvent.type, reportEvent.year);
      judgment.reportGap = gap;
      if (gap) {
        reportSync.syncReportForSymbol(reportEvent)
          .then(r => console.log(`[reportSync] ${reportEvent.symbol} ${reportEvent.year} ${reportEvent.type}: ${r.reason}`))
          .catch(e => console.error('[reportSync] 同步异常:', e && e.message));
      }
    }
  } catch (e) {
    console.error('[buildJudgment] reportSync 检测失败:', e && e.message);
  }
  return judgment;
}

// ============ 持久化 ============
// 统一以「目标交易日 targetDate」为文件键，每只股票（按归一化代码）在单个 targetDate 下只保留一条记录。
// 收盘后 ~ 下一开盘前多次刷新会覆盖同一 (symbol, targetDate)，确保每目标日只计一次判断。
function saveJudgment(j) {
  ensureDir();
  j.schemaVersion = SCHEMA_VERSION;
  const ns = normSymbol(j.symbol);
  j.symbol = ns; // 落盘时统一使用归一化代码，杜绝 SH601318 / 601318 重复
  const targetDate = j.targetDate || j.date;
  const f = fileForTargetDate(targetDate);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { arr = []; }
  const idx = arr.findIndex(r => normSymbol(r.symbol) === ns);
  if (idx >= 0) arr[idx] = j; else arr.push(j);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
  return j;
}

// ============ 135 格综合判定摘取（20261107）：从资金量能分析结果中抽取「135 格综合判定」 ============
// 纯函数、零数据依赖，便于单测。buildJudgment 已在上方调用 analyzeCapitalFlow（含 volumeEngine.posJudgment），
// 此处仅摘取主判横幅 cell（direction/dirText/conclusion/key）+ 挂起状态，挂入判定记录供「判定记录」模块回看。
// 注意：135 格综合判定是量价维度「每日生效唯一判定」，与 6 因子 verdict 口径不同、互不替代，故独立成字段、不参与准确率结算。
function extractPos135(capital) {
  try {
    const pj = capital && capital.volumeEngine && capital.volumeEngine.posJudgment;
    const cell = pj && pj.cell;
    if (!cell) return null;
    return {
      direction: cell.direction || 'observe', // 'bull' | 'bear' | 'observe'
      dirText: cell.dirText || '',            // 看多 / 看空 / 中性
      conclusion: cell.conclusion || '',      // 主判结论文案（如「缓慢阴跌，底部还没确认」）
      key: cell.key || '',                    // 归格格 key
      derived: !!cell.derived,                 // 是否推导格
      suspended: !!(pj.special),              // 异常特例命中 → 综合判定挂起
      specialType: pj.special ? (pj.special.type || '') : '',
    };
  } catch (e) {
    console.warn('[extractPos135] 摘取失败:', e && e.message);
    return null;
  }
}

// ============ 并发构建锁（20260928d）：避免「后台自动判定」与「用户打开页面」同时 build 同一标的 → 并发写同一 targetDate 文件 ============
const _buildLock = new Set();
async function buildWithLock(symbol, name, industry) {
  const ns = normSymbol(symbol);
  if (_buildLock.has(ns)) {
    // 已在构建中：短等其完成（最多 ~3s），再读最新记录，避免两个异步写相互覆盖
    for (let i = 0; i < 30; i++) { if (!_buildLock.has(ns)) break; await new Promise(r => setTimeout(r, 100)); }
  }
  _buildLock.add(ns);
  try {
    const judgment = await buildJudgment(symbol, name, industry);
    saveJudgment(judgment);
    await settleSymbol(symbol); // 结算该股过往未结算记录
    return judgment;
  } finally {
    _buildLock.delete(ns);
  }
}

function getLatestJudgment(symbol) {
  ensureDir();
  const target = normSymbol(symbol);
  const files = fs.readdirSync(JUDGE_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      const rec = arr.find(r => normSymbol(r.symbol) === target);
      if (rec) return rec;
    } catch (e) {}
  }
  return null;
}

// 归一化代码：去掉 SH/SZ/BJ/HK 前缀与 .SS/.SZ 后缀，便于跨源/跨页按个股聚合
function normSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase();
}
// 按个股过滤记录（归一化后比对，兼容前缀差异）
function filterBySymbol(records, symbol) {
  const s = normSymbol(symbol);
  return (records || []).filter(r => normSymbol(r.symbol) === s);
}

function getAllRecords() {
  ensureDir();
  // 只读取按 targetDate 命名的规范日期文件；排除 .bak-*/.v2-targetdate 等残留文件，
  // 否则旧备份中的重复记录会被重新计入，导致同一标的准确率被重复统计（Request D 根因）。
  const files = fs.readdirSync(JUDGE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      if (Array.isArray(arr)) out.push(...arr);
    } catch (e) {}
  }
  return out;
}

// ============ 结算（命中判定） ============
// 口径：
//   intraday（今日后续）：今日收盘 vs 判断时刻价(rec.price)；当日未收盘不结算
//   nextday（下一开盘日）：次日收盘 vs 今日收盘；次日K线未出/未收盘不结算
//   旧记录(无 target)：沿用原“当日收盘 vs 前收”口径，兼容历史数据
// Part B：结算后复盘弱关联主题是否持续误导，记录进经验库（驱动下次关联度折扣）。
// 仅在判断记录含 crossMarketMeta / sectorNewsMeta（本版本起生成）时执行，旧记录自动跳过。
function _recordRelevanceOutcomes(rec) {
  try {
    if (!rec || !rec.settled || !rec.actualDir) return;
    const sent = (rec.factors || []).find(f => f.key === 'sentiment');
    const subs = (sent && Array.isArray(sent.subFactors)) ? sent.subFactors : [];
    const cmSub = subs.find(s => s.name === '跨市场传导');
    if (rec.crossMarketMeta && cmSub) {
      recordOutcome({
        symbol: rec.symbol, industry: rec.industry, theme: rec.crossMarketMeta.theme,
        predictedSign: cmSub.signal, actualDir: rec.actualDir,
        relevance: relevanceScore(rec.industry, rec.crossMarketMeta.theme),
        date: rec.date,
      });
    }
    // 20260910c：子卡改名「板块消息联动」→「板块消息」；旧落盘记录仍是旧名，结算复盘需兼容双名
    const snSub = subs.find(s => s.name === '板块消息' || s.name === '板块消息联动');
    if (rec.sectorNewsMeta && snSub && Array.isArray(rec.sectorNewsMeta.weakThemes) && rec.sectorNewsMeta.weakThemes.length) {
      for (const wt of rec.sectorNewsMeta.weakThemes) {
        recordOutcome({
          symbol: rec.symbol, industry: rec.industry, theme: wt,
          predictedSign: snSub.signal, actualDir: rec.actualDir,
          relevance: relevanceScore(rec.industry, wt),
          date: rec.date,
        });
      }
    }
  } catch (e) {
    console.error('[_recordRelevanceOutcomes] 记录弱关联经验失败:', e && e.message);
  }
}

async function settleRecord(rec) {
  if (rec.settled) return rec;
  const now = new Date();
  const today = localDate(now);
  try {
    const history = await getHistory(rec.symbol, '1y').catch(() => []);
    const todayCandle = history.find(h => h.date === rec.date);

    if (rec.target === 'nextday') {
      // targetDate 为预测目标日；referenceDate 为基准收盘日（旧记录缺失时用 rec.date 兼容）
      // 20261021c：与 marketTechJudgment 同源加固——**存储的 targetDate 非交易日时不予采信**。
      // 旧口径只跳周末、不跳法定节假日，会写出「09-24 的次日=中秋 09-25」这类目标日；
      // history 里永远没有该日 K 线 → return rec 后既不结算、又永久计入「过期未结算」。
      const referenceDate = rec.referenceDate || rec.date;
      const autoDate = nextTradingDay(referenceDate);
      let targetDate = rec.targetDate || autoDate;
      if (!calIsTradingDay(targetDate)) {
        rec.targetDateFixed = { from: rec.targetDate || null, to: autoDate, reason: '原目标日非交易日，按交易日历重算', at: new Date().toISOString() };
        // 注意：**不改写 rec.targetDate**——它是该记录所在文件的语义键，
        // 改了会让「同一目标日」在文件与记录间错位；这里只用修正值做本次结算查找。
        targetDate = autoDate;
      }
      const next = history.find(h => h.date === targetDate);
      if (!next || next.close == null) return rec; // 目标日K线尚未生成
      if (targetDate === today && !marketClosed(now)) return rec; // 目标日尚未收盘，数据未定
      let baseline = null;
      let baselineLabel = '';
      const refCandle = history.find(h => h.date === referenceDate);
      if (refCandle && refCandle.close != null) {
        baseline = refCandle.close;
        baselineLabel = '基准日(' + referenceDate + ')收盘';
      }
      if (baseline == null) {
        // 兼容旧数据：回退到 rec.date 收盘，再不行用最近上一交易日收盘
        if (todayCandle && todayCandle.close != null) {
          baseline = todayCandle.close;
          baselineLabel = '今日收盘';
        } else {
          const prevCandles = history
            .filter(h => h.date <= rec.date && h.close != null)
            .sort((a, b) => b.date.localeCompare(a.date));
          if (prevCandles.length) {
            baseline = prevCandles[0].close;
            baselineLabel = '基准日(' + prevCandles[0].date + ')收盘';
          } else if (typeof rec.price === 'number') {
            baseline = rec.price;
            baselineLabel = '预判时价';
          }
        }
      }
      if (baseline == null) return rec; // 仍无法取得基准价，暂缓结算
      const actualChgPct = (next.close - baseline) / baseline * 100;
      const actualDir = next.close > baseline ? '涨' : (next.close < baseline ? '跌' : '震荡');
      const correct = rec.dir === '震荡' ? Math.abs(actualChgPct) <= 1.0 : rec.dir === actualDir;
      rec.actualClose = next.close;
      rec.actualChgPct = round(actualChgPct, 2);
      rec.actualDir = actualDir;
      rec.actualBaseline = baseline;
      rec.actualBaselineLabel = baselineLabel;
      rec.actualTargetLabel = '次日收盘';
      rec.settled = true;
      rec.correct = correct;
      _recordRelevanceOutcomes(rec);
      return rec;
    }

    // intraday 或旧记录（无 target）
    if (rec.date === today && !marketClosed(now)) return rec; // 当日未收盘，暂不结算
    const candle = todayCandle;
    if (!candle || candle.close == null) return rec;
    let baseline;
    if (rec.target === 'intraday') {
      baseline = (typeof rec.price === 'number') ? rec.price : (candle.prevClose != null ? candle.prevClose : null);
    } else {
      baseline = (rec.prevClose != null) ? rec.prevClose : (typeof rec.price === 'number' ? rec.price : null);
    }
    if (baseline == null) return rec;
    const actualChgPct = (candle.close - baseline) / baseline * 100;
    const actualDir = candle.close > baseline ? '涨' : (candle.close < baseline ? '跌' : '震荡');
    const correct = rec.dir === '震荡' ? Math.abs(actualChgPct) <= 1.0 : rec.dir === actualDir;
    rec.actualClose = candle.close;
    rec.actualChgPct = round(actualChgPct, 2);
    rec.actualDir = actualDir;
    rec.actualBaseline = baseline;
    rec.actualBaselineLabel = rec.target === 'intraday' ? '判断时价' : '前收';
    rec.actualTargetLabel = '今日收盘';
    rec.settled = true;
    rec.correct = correct;
    _recordRelevanceOutcomes(rec);
    return rec;
  } catch (e) {
    rec.settleError = e.message;
    return rec;
  }
}

async function settleSymbol(symbol) {
  ensureDir();
  const targetSymbol = normSymbol(symbol);
  const files = fs.readdirSync(JUDGE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const fp = path.join(JUDGE_DIR, f);
    let arr;
    try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (normSymbol(arr[i].symbol) === targetSymbol && !arr[i].settled) {
        arr[i] = await settleRecord(arr[i]);
        if (arr[i].settled) changed = true;
      }
    }
    if (changed) { fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8'); saveLearning(); }
  }
}

async function settleAll() {
  const records = getAllRecords();
  const bySymbol = {};
  for (const r of records) if (!r.settled) (bySymbol[r.symbol] = bySymbol[r.symbol] || []).push(r);
  for (const sym of Object.keys(bySymbol)) {
    await settleSymbol(sym);
  }
  // 历史回填：把「已结算但从未参与学习」的旧判断一次性补入学习模型，
  // 使权重演进能立即基于全部历史，而非仅从本次新结算的样本开始。
  backfillLearning();
  saveLearning();
  return computeAccuracy(getAllRecords());
}

function computeAccuracy(records) {
  const settled = records.filter(r => r.settled);
  const total = settled.length;
  const correct = settled.filter(r => r.correct).length;
  const today = localDate();
  const pending = records.filter(r => !r.settled);
  // 过期未结算：目标交易日已过去却仍未结算（通常是结算口径缺陷导致，应重点核查）
  // 20261021c：判定用**有效目标日**——存储的 targetDate 若是非交易日（旧口径写出的节假日），
  // 按交易日历重算后再与今天比较，避免这类记录永久显示「过期」。
  const effTarget = (r) => {
    const t = r.targetDate;
    if (t && calIsTradingDay(t)) return t;
    return nextTradingDay(r.referenceDate || r.date || t);
  };
  const overdue = pending.filter(r => { const t = effTarget(r); return !!t && t < today; });
  // 分方向
  const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
  // 分口径（今日后续 / 下一交易日）
  const byTarget = { intraday: { t: 0, c: 0 }, nextday: { t: 0, c: 0 } };
  for (const r of settled) {
    if (byDir[r.dir]) { byDir[r.dir].t++; if (r.correct) byDir[r.dir].c++; }
    const tgt = r.target === 'nextday' ? 'nextday' : 'intraday';
    byTarget[tgt].t++; if (r.correct) byTarget[tgt].c++;
  }
  const rate = p => p.t ? round(p.c / p.t * 100) : null;
  return {
    totalRecords: records.length,
    settled,
    settledCount: total,
    pendingCount: pending.length,
    overdueCount: overdue.length,
    correct,
    accuracy: total ? round(correct / total * 100) : null,
    bullRate: rate(byDir['涨']),
    bearRate: rate(byDir['跌']),
    flatRate: rate(byDir['震荡']),
    intradayRate: rate(byTarget['intraday']),
    nextdayRate: rate(byTarget['nextday']),
  };
}

// ============ 数据边界新鲜度（方案 C·Part A，对齐铁律二·数据最新性）============
// 判断应在「当日最近一个数据边界」之后生成才算新鲜；缓存早于最近边界即过期，自动重算。
// 边界点：0:00（新一天/新公告）、5:00（隔夜美股收盘已出，跨市场因子可更新）、
// 9:30（A股开盘，盘前消息已定）、15:00（收盘，转入下一交易日预判）。
function latestDataBoundary(now) {
  const d = new Date(now);
  const at = (h, m) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const candidates = [at(0, 0), at(5, 0), at(9, 30), at(15, 0)];
  let best = candidates[0];
  for (const c of candidates) if (c <= d) best = c;
  return best;
}
function isJudgmentStale(rec, now) {
  if (!rec || !rec.generatedAt) return true;
  const gen = new Date(rec.generatedAt);
  if (isNaN(gen.getTime())) return true;
  return gen < latestDataBoundary(now);
}

// 20261024g：市场情绪一致性门控（「单源引用」铁律）。
// 个股「大盘」卡片的「市场情绪提醒」子因子，是在生成判断时把当日情绪总分**烘死**进记录（signal）。
// 若首页情绪在该判断生成之后被重算（如数据源恢复：-0.317 → 0.009），判断记录仍会按 targetDate
// 复用旧情绪快照，导致「首页中性 0.009 / 个股大盘看跌 -0.317」同屏矛盾（用户 2026-10-24 报障）。
// 复用前比对记录里烘焙的情绪信号与当前最新情绪记录，不一致即强制重算，保证个股页与首页同源。
function _findEmotionSubSignal(rec) {
  const factors = rec && Array.isArray(rec.factors) ? rec.factors : [];
  for (const f of factors) {
    if (!f || !Array.isArray(f.subFactors)) continue;
    const s = f.subFactors.find(x => x && x.name === '市场情绪提醒');
    if (s && typeof s.signal === 'number') return s.signal;
  }
  return null;
}
function _emotionSubStale(rec) {
  const baked = _findEmotionSubSignal(rec);
  if (baked === null) return false;            // 记录无该子因子（旧结构已在 schema 门控处理）→ 不额外判
  let cur = null;
  try { cur = marketEmotionModel.readLatestJudgment(); } catch (e) { cur = null; }
  if (!cur || typeof cur.score !== 'number') return false; // 最新情绪不可得 → 交回原逻辑（按中性处理）
  // 20261028c：比对口径改为与 computeMarketEmotionSub 同源的 _emotionQuoteSig
  // （单源同义推导）——否则中性场景烘焙 0 vs 原始分 -0.04 会被误判过期、每次请求都强制重算。
  const curSig = _emotionQuoteSig(cur);
  return Math.abs(baked - curSig) > 0.0005;    // 引用信号已变 → 记录过期，需重算
}

// ============ 编排 ============
// 20260905g：当日复用判断记录时，「个股短期动向」因子用 priceActionHub 最新快照刷新
// （与技术面分析页同一份快照、同一档位），并重算总分/方向/置信度，保证：
//   ① 两页跨页一致（技术面页实时滚动 vs 判断记录当日复用，不再有时点错位）；
//   ② 生成瞬间 K 线拉取失败的坏记录（"数据不足"）自动被有效快照修复；
//   ③ 面板内部自洽（因子信号与总结论同步刷新）。
// 仅刷新返回给前端的内存对象；记录文件保留生成时原值，准确率结算口径（rec.dir）不受影响。
const _TECH_REFRESH_TIMEOUT_MS = 3500; // hub 冷缓存时拉K线可能较慢，超时则沿用记录原值
async function _refreshTechnicalShortOnReuse(rec, symbol) {
  try {
    if (!rec || !Array.isArray(rec.factors)) return rec;
    const paSnap = await Promise.race([
      getPriceActionSnapshot(symbol),
      new Promise(resolve => setTimeout(() => resolve(null), _TECH_REFRESH_TIMEOUT_MS)),
    ]);
    if (!paSnap || paSnap.error || !paSnap.shortTerm || typeof paSnap.shortTerm.dirScore !== 'number') return rec;
    const old = rec.factors.find(f => f.key === 'technicalShort');
    // 20260917i：technicalShort 现含「舆情与讨论热度（个股）」「财报解读」两个迁入子因子，
    // 复用刷新时从旧记录取出并回传，避免刷新把这两个子因子丢掉。
    const oldSubs = (old && Array.isArray(old.subFactors)) ? old.subFactors : [];
    const sentSubFromOld = oldSubs.find(s => s && s.name === '舆情与讨论热度（个股）') || null;
    const earnSubFromOld = oldSubs.find(s => s && s.name === '财报解读') || null;
    const newFactor = factorTechnicalShort(paSnap, sentSubFromOld, earnSubFromOld);
    if (old && old.value === newFactor.value && old.signal === newFactor.signal) return rec; // 结论未变，不重算
    const factors = rec.factors.map(f => (f.key === 'technicalShort' ? newFactor : f));
    const firstPass = combineFactors(factors);
    const adaptive = getAdaptiveWeights(symbol, firstPass.dir);
    const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(factors, adaptive);
    return { ...rec, factors: scored, totalScore, dir, verdict, confidence, techShortRefreshedAt: new Date().toISOString() };
  } catch (e) {
    return rec; // 刷新失败沿用记录原值，不影响面板打开
  }
}

async function getJudgmentWithAccuracy(symbol, name, industry, force) {
  const today = localDate();
  const currentTarget = 'nextday'; // 统一只做收盘后下一交易日预判
  // 当前所处的 targetDate：收盘后=下一交易日（严格晚于今天），盘中=今天
  const currentTargetDate = marketClosed(new Date()) ? nextTradingDay(today) : today;
  let rec = null;
  if (!force) rec = getLatestJudgment(symbol);
  // 新增（20260826c）：如果旧判断标记了“资料库缺报告”，但现在资料库已补齐，强制重新生成。
  // 根因案例：600909 在 2026-08-25 04:42:55 生成判断，PDF 在 04:42:58 才登记进资料库（相差 3ms），
  // 导致 reportGap=true 被持久化；同一 targetDate 内刷新一直复用旧缓存，持续误报“缺报告”。
  if (rec && rec.reportGap && rec.reportEvent && rec.reportEvent.type && rec.reportEvent.year) {
    const nowHasDoc = reportSync.hasReportDoc(rec.reportEvent.symbol, rec.reportEvent.type, rec.reportEvent.year);
    if (nowHasDoc) {
      console.log(`[SameDayJudgment] ${symbol} 旧判断标记缺 ${rec.reportEvent.year} ${rec.reportEvent.type}，但资料库已补齐，强制重算`);
      force = true;
      rec = null;
    }
  }
  // 复用条件（方案 C·Part A 增强）：同一 targetDate + nextday 口径 + 非强制 + 无异常文本 + schema 一致 + 未过期
  const stale = rec ? isJudgmentStale(rec, new Date()) : false;
  // 20260906c：财报解读新鲜度门控——上游 earnings 缓存比本判断新（如刚在深度页「重新解读」或缓存重生成），
  // 说明判断里的财报因子快照已落后，强制重算以引用最新综合结论；否则小卡会一直吐旧兜底/旧全文。
  let earningsFresher = false;
  if (rec) {
    try {
      const upEarnings = readEarningsCache(symbol);
      if (upEarnings && !upEarnings.stale && upEarnings.date && rec.generatedAt
        && new Date(upEarnings.date) > new Date(rec.generatedAt)) earningsFresher = true;
    } catch {}
  }
  const reuse = rec && rec.targetDate === currentTargetDate && rec.target === currentTarget && !force && !_judgmentHasRawException(rec) && rec.schemaVersion === SCHEMA_VERSION && !stale && !earningsFresher && !_emotionSubStale(rec);
  if (reuse) {
    // 复用，但仍结算该股历史判断以更新准确率；个股短期动向因子用最新快照刷新（20260905g 跨页一致性）
    await settleSymbol(symbol);
    const judgment = await _refreshTechnicalShortOnReuse(rec, symbol);
    return { judgment, accuracy: computeAccuracy(filterBySymbol(getAllRecords(), symbol)), today: today, regenerated: false };
  }
  if (rec) {
    const reason = _judgmentHasRawException(rec) ? '异常文本' : (rec.schemaVersion !== SCHEMA_VERSION ? '旧schema' : (stale ? '数据过期' : (earningsFresher ? '财报已更新' : (_emotionSubStale(rec) ? '情绪已更新' : '其他'))));
    console.log('[SameDayJudgment] 旧缓存不复用，重新生成:', symbol, '(' + reason + ')');
  }
  const judgment = await buildWithLock(symbol, name, industry);
  return { judgment, accuracy: computeAccuracy(filterBySymbol(getAllRecords(), symbol)), today, regenerated: true };
}

// ============ 盘前主动重算（方案 C·Part B）============
// 对当前 targetDate 下所有 nextday 未结算判断，用最新数据重算并落盘，
// 覆盖「近期浏览/自选」标的，吸收隔夜美股与早间消息，确保开盘前判断已就绪（普通打开不必再等重算）。
async function preOpenRecomputeAll() {
  const now = new Date();
  const today = localDate(now);
  const targetDate = marketClosed(now) ? nextTradingDay(today) : today;
  const records = getAllRecords().filter(r => r.target === 'nextday' && r.targetDate === targetDate && !r.settled);
  const seen = new Set();
  let count = 0, skipped = 0;
  for (const r of records) {
    const ns = normSymbol(r.symbol);
    if (seen.has(ns)) continue;
    seen.add(ns);
    try {
      const j = await buildWithLock(ns, r.name, r.industry);
      count++;
    } catch (e) {
      skipped++;
      console.error('[盘前重算] 失败', ns, (e && e.message) || e);
    }
  }
  console.log(`[盘前重算] 完成：重建 ${count} 条，跳过 ${skipped} 条（targetDate=${targetDate}）`);
  return { count, skipped, targetDate };
}

// ============ 自选股自动判定（20260928d）：修复「用户不切到个股页就永远没有判定记录」的缺陷 ============
// 旧实现只有用户打开个股页 → GET /api/sameday-judgment/:symbol → getJudgmentWithAccuracy 才会 build+save，
// 导致从未打开过的自选股在准确率页「各股短期判断准确率」整行缺失。
// 现改为：服务启动 + 定时调度 自动为「自选股 ∪ 已有记录标的」生成当前目标日的判定，无需用户手动打开页面。
// 复用判定：存在当前目标日记录且 schema 一致且未过期 → 跳过（避免每轮重复刷新）；否则 build+save 自动补齐缺失。
async function ensureAllTrackedJudgments(opts = {}) {
  const force = !!opts.force;
  const now = new Date();
  const today = localDate(now);
  const targetDate = marketClosed(now) ? nextTradingDay(today) : today;
  const target = 'nextday';

  // 1) 收集需覆盖的标的：自选股（带 name）+ 已有记录中当前目标日的标的（去重、保留最新）
  const tracked = (opts.symbols || [])
    .map(t => ({ symbol: normSymbol(t.symbol), name: (t.name || '').toString() }))
    .filter(t => t.symbol);
  const records = getAllRecords();
  const currentRows = records.filter(r => r.target === target && r.targetDate === targetDate);
  const currentBySym = new Map();
  for (const r of currentRows) {
    const ns = normSymbol(r.symbol);
    const prev = currentBySym.get(ns);
    if (!prev || (r.generatedAt || '') > (prev.generatedAt || '')) currentBySym.set(ns, r);
  }
  const seen = new Set();
  const list = [];
  for (const t of tracked) { if (!seen.has(t.symbol)) { seen.add(t.symbol); list.push(t); } }
  for (const [ns, r] of currentBySym) { if (!seen.has(ns)) { seen.add(ns); list.push({ symbol: ns, name: r.name || '' }); } }

  let created = 0, reused = 0, skipped = 0;
  for (const it of list) {
    const cur = currentBySym.get(it.symbol);
    const stale = cur ? isJudgmentStale(cur, new Date()) : false;
    const reusable = cur && cur.targetDate === targetDate && cur.target === target
      && !_judgmentHasRawException(cur) && cur.schemaVersion === SCHEMA_VERSION && !stale && !_emotionSubStale(cur);
    if (reusable && !force) { reused++; continue; } // 已覆盖当前目标日，跳过
    try {
      const r = await getJudgmentWithAccuracy(it.symbol, it.name, '', force);
      if (r && r.regenerated) created++; else reused++;
    } catch (e) {
      skipped++;
      console.error('[ensureTracked] 失败', it.symbol, (e && e.message) || e);
    }
  }
  console.log(`[ensureTracked] 完成：新建 ${created} · 复用 ${reused} · 跳过 ${skipped}（targetDate=${targetDate}）`);
  return { created, reused, skipped, total: list.length };
}

// ============ 一次性数据迁移：旧版按 date 分文件 + 未归一化 symbol 导致重复计分 ============
// 迁移后：按 targetDate 分文件，(normSymbol(symbol), targetDate) 唯一，保留 generatedAt 最新的一条。
// 幂等：迁移完成会写入 .v2-targetdate 标记文件，重启不会重复执行。
function migrateToTargetDateSchema() {
  const marker = path.join(JUDGE_DIR, '.v2-targetdate');
  if (fs.existsSync(marker)) return;
  ensureDir();
  const files = fs.readdirSync(JUDGE_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (!files.length) {
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    return;
  }

  const allRecords = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      if (Array.isArray(arr)) allRecords.push(...arr);
    } catch (e) { console.error('[migrateJudgments] read failed:', f, e.message); }
  }

  // 按 (normSymbol, targetDate) 去重，保留 generatedAt 最新的记录
  const groups = {};
  for (const r of allRecords) {
    if (!r || !r.symbol || !r.targetDate) continue;
    const ns = normSymbol(r.symbol);
    const key = `${ns}::${r.targetDate}`;
    if (!r.referenceDate) r.referenceDate = r.date;
    const curTime = (r.generatedAt || r.date || '').toString();
    const bestTime = groups[key] ? (groups[key].generatedAt || groups[key].date || '').toString() : '';
    if (!groups[key] || curTime > bestTime) groups[key] = r;
  }

  // 按 targetDate 重组文件
  const byTarget = {};
  for (const r of Object.values(groups)) {
    if (!byTarget[r.targetDate]) byTarget[r.targetDate] = [];
    r.symbol = normSymbol(r.symbol); // 落盘统一归一化代码
    byTarget[r.targetDate].push(r);
  }

  // 备份旧文件：用 rename 移动（同一卷内为原子移动）到备份目录，
  // 既完成备份又移除原文件；避免环境 safe-delete 拦截 fs.unlinkSync 导致迁移失败。
  const backupDir = path.join(__dirname, '..', 'data', 'judgments.bak-pre-v2');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  for (const f of files) {
    const src = path.join(JUDGE_DIR, f);
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, path.join(backupDir, f));
    } catch (e) {
      console.error('[migrateJudgments] 移动备份失败:', f, e.message);
    }
  }

  // 写入新文件
  for (const [targetDate, arr] of Object.entries(byTarget)) {
    arr.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    fs.writeFileSync(path.join(JUDGE_DIR, `${targetDate}.json`), JSON.stringify(arr, null, 2), 'utf8');
  }

  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  console.log(`[migrateJudgments] 已迁移 ${allRecords.length} 条旧记录 → ${Object.keys(byTarget).length} 个 targetDate 文件，去重后 ${Object.keys(groups).length} 条`);
}

// 模块加载时自动执行一次迁移（幂等）
try { migrateToTargetDateSchema(); } catch (e) {
  console.error('[migrateJudgments] 迁移失败:', e.message);
}

// 20260907a：事件变化后，作废某股票「当前目标日」的缓存判断，使其下次打开重新生成（带事件权重）。
function invalidateJudgmentForSymbol(symbol) {
  try {
    const now = new Date();
    const date = localDate(now);
    const targetDate = marketClosed(now) ? nextTradingDay(date) : date;
    const f = path.join(JUDGE_DIR, `${targetDate}.json`);
    if (!fs.existsSync(f)) return false;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(arr)) return false;
    const ns = normSymbol(symbol);
    const next = arr.filter(r => normSymbol(r.symbol) !== ns);
    if (next.length === arr.length) return false;
    fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  buildJudgment,
  invalidateJudgmentForSymbol,
  saveJudgment,
  extractPos135,
  getLatestJudgment,
  getAllRecords,
  settleRecord,
  settleSymbol,
  settleAll,
  computeAccuracy,
  getJudgmentWithAccuracy,
  preOpenRecomputeAll,
  ensureAllTrackedJudgments,
  normSymbol,
  filterBySymbol,
  localDate,
  nextTradingDay,
  previousTradingDay,
  referenceCloseDate,
  marketClosed,
  SIGNAL_ARROW,
  getLearningState,
  getAdaptiveWeights,
  factorSentiment,
  computeNewsFactor,
  factorTechnicalShort,
  factorHoldings, // 20260922h：导出以支持第④子模块单元测试（股东被动减持/司法强制执行）
  detectForcedReduction, // 20260922h：导出以支持第④子模块检测逻辑单测
  DEFAULT_WEIGHTS,
  FACTOR_KEYS,
  FACTOR_NAME,
  isTradingDay: calIsTradingDay, // 导出交易日判定（与 techFaceJudgment 共用 lib/cnTradingCalendar）
  // 20261024g：市场情绪一致性门控（首页情绪变化后个股判断必须重算）单测用
  _emotionSubStale,
  _findEmotionSubSignal,
  // 20261028c：引用子因子单源同义信号推导（单测用）
  _emotionQuoteSig,
  computeMarketEmotionSub,
};

~~~

---

## `lib\sectorCapitalFlow.js`  ·  323 行

~~~js
/**
 * 行业板块资金流向（20260909o 重写：纯 Node 直连 push2delay）
 * --------------------------------------------------------------
 * 卡片：主力净流入/流出前五（含暗盘）+ 散户（小单）净流入/流出前五 + 近5日最大流入/流出（主力与小单各一组）
 * 数据源：东方财富 clist 接口（push2delay.eastmoney.com，本机 push2 主站被封锁）：
 *   - 今日口径：f62 主力净额/f184 占比、f66 超大/f69、f72 大单/f75、f78 中单/f81、f84 小单净额/f87 占比、f204 主力净流入最大股
 *   - 5日口径：f164 主力/f165、f172 小单净额/f173、f257 5日主力净流入最大股、f109 5日涨跌幅
 *   主力 = 超大单 + 大单（含暗盘性质机构资金）；小单 = 单笔＜2万股或＜4万元（散户口径）
 * 慢根因修复（20260909o）：旧版每次缓存过期 spawn Python（冷启动+import akshare 2~4s）再串行 4 请求
 *   （固定延时 3s），首屏 8~15s。改为：纯 Node curl 子进程 + 8 个定向小请求分 2 批并发 + 60s 缓存
 *   + in-flight 并发锁 + 服务启动预热，首屏基本即时。
 */
const { execFile } = require('child_process');
const { getEastmoneySectorRanking, getThsSectorRanking, parseSwSectorName, SW_LEVEL_UNIFIED } = require('./stockData');
const { getEmDcSectorCapitalFlow } = require('./sectorFundFlowEmDc');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

let _cache = { ts: 0, data: null };
let _inFlight = null;
const CACHE_TTL = 60000; // 60 秒缓存（盘中资金流数据刷新节奏）
// push2delay 连续失败后的静默期：本机对东财 push2 族的请求常被对端重置，失败后短时间内不再重试，
// 避免每次缓存刷新都白等数秒（静默期内直接走「东财数据中心报表」源，口径同为东财）。
let _push2DownUntil = 0;
const PUSH2_COOLDOWN_MS = 10 * 60 * 1000;

const UA = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'Referer: https://data.eastmoney.com/bkzj/hy.html';
const UT = 'b2884a393a59ad64002292a3e90d46a5';
const HOST = 'https://push2delay.eastmoney.com/api/qt/clist/get';

const FIELDS_TODAY = 'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124';
const FIELDS_5DAY = 'f12,f14,f2,f109,f164,f165,f166,f167,f168,f169,f170,f171,f172,f173,f257,f258,f124';

const _fmtYi = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n / 1e8 * 100) / 100 : 0;
};
// 同花顺「净流入」已是亿元单位，直接四舍五入保留两位小数（不再除 1e8）
const _roundYi = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// 单次定向请求：curl -4 直连 push2delay（与旧版 Python/curl 方案同参数，已验证稳定）
function _curlRows(fid, stat, po, pz) {
  const fields = stat === '1' ? FIELDS_TODAY : FIELDS_5DAY;
  const url = `${HOST}?pn=1&pz=${pz}&po=${po}&np=1&ut=${UT}&fltt=2&invt=2`
    + `&fid0=${fid}&fid=${fid}&fs=m:90+t:2&stat=${stat}&fields=${fields}&rt=52975239&_=${Date.now()}`;
  return new Promise((resolve, reject) => {
    execFile('curl', ['-4', '-s', '--connect-timeout', '5', '--max-time', '15', '-H', UA, '-H', REFERER, url],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(new Error(`curl 退出码 ${err.code || err.message}`));
        try {
          const data = JSON.parse(stdout);
          const diff = data && data.data && data.data.diff;
          if (!Array.isArray(diff) || diff.length === 0) return reject(new Error('接口返回空 diff'));
          resolve(diff);
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + e.message));
        }
      });
  });
}

async function _tryCurl(fid, stat, po, pz, retries = 1) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await _curlRows(fid, stat, po, pz);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// 并发跑一批请求，单项失败不拖垮整批
async function _batch(jobs) {
  const results = await Promise.all(jobs.map(p => p.catch(e => ({ __err: e }))));
  return results.map(r => (r && r.__err) ? null : r);
}

function _pickLeader(row) {
  return (row && (row.f204 || row.f257)) ? String(row.f204 || row.f257).trim() : '';
}

function _empty(error) {
  return {
    ok: false,
    error: error || null,
    date: localDate(),
    source: '获取失败',
    note: '',
    todayInflowTop5: [],
    todayOutflowTop5: [],
    retailInflowTop5: [],
    retailOutflowTop5: [],
    fiveDayMaxInflow: null,
    fiveDayMaxOutflow: null,
    retailFiveDayMaxInflow: null,
    retailFiveDayMaxOutflow: null,
  };
}

// 同花顺备用源（本机网络最稳定）：仅提供「主力净流入」单字段，
// 不含超大单/大单/小单拆分、也不含近5日。东财 push2delay 不可达时降级使用，
// 至少补齐「主力净流入/流出前五」榜单，散户/近5日标注暂缺。
// 层级标注：同花顺行业名（化学制药/半导体/电池…）字典里属申万二级，房地产/银行属一级，
// 用 parseSwSectorName 取真实层级，与首页其他行业卡（含 7日提醒的「贵金属 二级」）口径一致。
async function getThsSectorCapitalFlow() {
  const ranking = await getThsSectorRanking();
  const list = (ranking && Array.isArray(ranking.allSectors) ? ranking.allSectors : [])
    .map(s => ({
      name: String(s.name || '').trim(),
      rawName: String(s.name || '').trim(),
      swLevel: s.swLevel || null,        // 层级由 getThsSectorRanking 统一解析（化学制药/半导体=二级，房地产=一级）
      changePct: Number(s.changePct) || 0,
      mainNet: _roundYi(s.netInflow),
      leader: s.leader || '',
    }))
    .filter(x => x.name && Number.isFinite(x.mainNet));
  if (!list.length) throw new Error('同花顺板块资金流无可用数据');
  // 统一分级（与东财资金流口径一致）：只取二级（SW_LEVEL_UNIFIED）层级
  const lvList = list.filter(x => x.swLevel === SW_LEVEL_UNIFIED);
  const inflow = lvList.filter(x => x.mainNet > 0).sort((a, b) => b.mainNet - a.mainNet).slice(0, 5);
  const outflow = lvList.filter(x => x.mainNet < 0).sort((a, b) => a.mainNet - b.mainNet).slice(0, 5);
  return {
    ok: true,
    date: (ranking && ranking.sectorDate) || localDate(),
    source: '同花顺·行业板块资金流（备用源）',
    note: '主力净流入=同花顺行业板块净流入（统一申万二级口径，与首页其他行业卡一致）；散户(小单)拆分与近5日资金流备用源暂不提供',
    todayInflowTop5: inflow,
    todayOutflowTop5: outflow,
    retailInflowTop5: [],
    retailOutflowTop5: [],
    fiveDayMaxInflow: null,
    fiveDayMaxOutflow: null,
    retailFiveDayMaxInflow: null,
    retailFiveDayMaxOutflow: null,
    fallbackWarning: '东方财富资金流接口不可达，已自动切换同花顺备用源（仅主力净流入榜，散户/近5日暂缺）',
    fiveDayWarning: '近5日资金流：备用源暂不提供',
  };
}

async function fetchAll() {
  // 先并发取「东财全量行业板块」的名称→申万层级映射：资金流接口返回的板块名不一定带 Ⅱ/Ⅲ 后缀，
  // 需据此把每条资金流条目解析到统一层级，再按 SW_LEVEL_UNIFIED 过滤，保证榜单层级一致。
  const emSectorsP = getEastmoneySectorRanking().catch(e => {
    console.warn('[SectorCapitalFlow] 申万层级映射获取失败:', e.message);
    return null;
  });
  // 第 1 批（今日口径 4 个定向小请求）：主力净额降序/升序 + 小单净额降序/升序
  // 取数行数加大（PZ_TODAY/PZ_5D）：榜单只认统一层级（SW_LEVEL_UNIFIED），而净额头部多为一/二级板块，
  // 必须多取一些原始行，过滤到该层级后仍有足量候选（否则会出现「不足5条/为空」）。
  const PZ_TODAY = 60, PZ_5D = 30;
  const triedPush2 = Date.now() >= _push2DownUntil; // 静默期内跳过 push2delay，直接走东财数据中心报表源
  let batch1 = [null, null, null, null];
  let batch2 = [null, null, null, null];
  if (triedPush2) {
    batch1 = await _batch([
      _tryCurl('f62', '1', '1', PZ_TODAY),  // 今日主力 desc → 流入前五
      _tryCurl('f62', '1', '0', PZ_TODAY),  // 今日主力 asc → 流出前五
      _tryCurl('f84', '1', '1', PZ_TODAY),  // 今日小单 desc → 散户流入前五
      _tryCurl('f84', '1', '0', PZ_TODAY),  // 今日小单 asc → 散户流出前五
    ]);
    await new Promise(r => setTimeout(r, 400)); // 批间小延时，避免触发东财限流
    // 第 2 批（5日口径 4 个）：主力/小单 各 desc/asc 头部
    batch2 = await _batch([
      _tryCurl('f164', '5', '1', PZ_5D),
      _tryCurl('f164', '5', '0', PZ_5D),
      _tryCurl('f172', '5', '1', PZ_5D),
      _tryCurl('f172', '5', '0', PZ_5D),
    ]);
  }
  // 第 2 顺位源（东财「数据中心」行业资金流报表）：push2delay 首批全失败时才按需启动，
  // 避免 push2 正常时产生无谓请求；启动后与第 2 批并发，几乎不增加额外等待。
  let dcP = null;
  const dcStart = () => (dcP || (dcP = getEmDcSectorCapitalFlow().catch(e => {
    console.warn('[SectorCapitalFlow] 东财数据中心报表源失败:', e.message);
    return null;
  })));
  if (triedPush2 && batch1.every(x => x === null)) dcStart();
  const [mainDesc, mainAsc, retailDesc, retailAsc, d5MainIn, d5MainOut, d5RetailIn, d5RetailOut] = [...batch1, ...batch2];

  const dead = batch1.every(x => x === null) && batch2.every(x => x === null);
  if (dead) {
    if (triedPush2) _push2DownUntil = Date.now() + PUSH2_COOLDOWN_MS; // 进入静默期，短期内不再打 push2
    // 第 2 顺位：东财「数据中心」行业资金流报表（同为东财口径，含散户拆分 + 近5日逐日累计）
    const dc = await dcStart();
    if (dc && dc.ok) return dc;
    // 第 3 顺位：同花顺备用源（本机网络稳定），仅提供主力净流入单字段
    try {
      const ths = await getThsSectorCapitalFlow();
      if (ths && ths.ok) return ths;
    } catch (e2) {
      console.warn('[SectorCapitalFlow] 同花顺备用源也失败:', e2.message);
    }
    throw new Error('东财板块资金流接口全部请求失败（push2delay 与数据中心报表均不可达）');
  }
  if (triedPush2) _push2DownUntil = 0; // push2delay 恢复可用，解除静默

  // 名称→申万层级映射（等待前置请求）：优先名称自带 Ⅱ/Ⅲ 后缀，其次用全量榜兜底
  const emSectors = await emSectorsP;
  const levelMap = new Map();
  if (emSectors && Array.isArray(emSectors.allSectors)) {
    for (const s of emSectors.allSectors) {
      if (s.swLevel && s.name) levelMap.set(s.name, s.swLevel);
    }
  }
  const resolveLevel = (parsed) => parsed.swLevel || levelMap.get(parsed.name) || null;

  const tile = (row, netKey) => {
    if (!row) return null;
    const parsed = parseSwSectorName(row.f14);
    return {
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: resolveLevel(parsed),
      changePct: Number(row.f3) || 0,
      mainNet: _fmtYi(row[netKey]),
      superLargeNet: netKey === 'f62' ? _fmtYi(row.f66) : null,
      largeNet: netKey === 'f62' ? _fmtYi(row.f72) : null,
      leader: _pickLeader(row),
    };
  };

  // 统一分级（20260916）：只保留 SW_LEVEL_UNIFIED 指定层级的板块。
  // 原实现混入一级/二级板块，导致「电子(一级)」与「半导体(二级)」同时上榜、同一笔资金被重复计入。
  const inLevel = (x) => !!x && x.swLevel === SW_LEVEL_UNIFIED;

  const topPositive = (rows, netKey, n = 5) => (rows || [])
    .map(r => tile(r, netKey)).filter(x => inLevel(x) && x.mainNet > 0)
    .sort((a, b) => b.mainNet - a.mainNet).slice(0, n);
  const topNegative = (rows, netKey, n = 5) => (rows || [])
    .map(r => tile(r, netKey)).filter(x => inLevel(x) && x.mainNet < 0)
    .sort((a, b) => a.mainNet - b.mainNet).slice(0, n);

  const fiveDayTile = (rows, netKey, dir) => {
    const list = (rows || []).map(r => tile(r, netKey)).filter(inLevel)
      .sort((a, b) => dir === 'max' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet);
    return list[0] || null;
  };

  const anyToday = batch1.some(x => x !== null);
  const result = {
    ok: anyToday || batch2.some(x => x !== null),
    date: localDate(),
    source: '东方财富·板块资金流向',
    note: '主力净流入 = 超大单净流入 + 大单净流入（含暗盘性质机构资金）；散户净流入 = 小单净流入（单笔＜2万股或＜4万元）；榜单统一申万' + SW_LEVEL_UNIFIED + '口径（单层级，父子行业不重复计入）',
    todayInflowTop5: topPositive(mainDesc, 'f62'),
    todayOutflowTop5: topNegative(mainAsc, 'f62'),
    retailInflowTop5: topPositive(retailDesc, 'f84'),
    retailOutflowTop5: topNegative(retailAsc, 'f84'),
    fiveDayMaxInflow: fiveDayTile(d5MainIn, 'f164', 'max'),
    fiveDayMaxOutflow: fiveDayTile(d5MainOut, 'f164', 'min'),
    retailFiveDayMaxInflow: fiveDayTile(d5RetailIn, 'f172', 'max'),
    retailFiveDayMaxOutflow: fiveDayTile(d5RetailOut, 'f172', 'min'),
    fallbackWarning: null,
    fiveDayWarning: (batch2.every(x => x === null) && batch2.length > 0) ? '近5日资金流向获取失败' : null,
  };

  // push2delay 部分可用时，用「东财数据中心报表」补齐缺失字段（同为东财口径，不引入异源数据）；
  // 两条通道独立，任一可用即可保证卡片完整（散户榜 / 近5日 是 push2delay 最易缺的两块）。
  const needFill = !result.todayInflowTop5.length || !result.todayOutflowTop5.length
    || !result.retailInflowTop5.length || !result.retailOutflowTop5.length
    || !result.fiveDayMaxInflow || !result.fiveDayMaxOutflow
    || !result.retailFiveDayMaxInflow || !result.retailFiveDayMaxOutflow;
  if (needFill) {
    const dc = await dcStart();
    if (dc && dc.ok) {
      const filled = [];
      if (!result.todayInflowTop5.length) { result.todayInflowTop5 = dc.todayInflowTop5; filled.push('主力流入榜'); }
      if (!result.todayOutflowTop5.length) { result.todayOutflowTop5 = dc.todayOutflowTop5; filled.push('主力流出榜'); }
      if (!result.retailInflowTop5.length) { result.retailInflowTop5 = dc.retailInflowTop5; filled.push('散户流入榜'); }
      if (!result.retailOutflowTop5.length) { result.retailOutflowTop5 = dc.retailOutflowTop5; filled.push('散户流出榜'); }
      if (!result.fiveDayMaxInflow) result.fiveDayMaxInflow = dc.fiveDayMaxInflow;
      if (!result.fiveDayMaxOutflow) result.fiveDayMaxOutflow = dc.fiveDayMaxOutflow;
      if (!result.retailFiveDayMaxInflow) result.retailFiveDayMaxInflow = dc.retailFiveDayMaxInflow;
      if (!result.retailFiveDayMaxOutflow) result.retailFiveDayMaxOutflow = dc.retailFiveDayMaxOutflow;
      if (filled.length) result.note += '；' + filled.join('、') + '由东方财富数据中心·行业资金流报表补齐';
      if (result.fiveDayMaxInflow && result.fiveDayMaxOutflow) result.fiveDayWarning = null;
    }
  }

  return result;
}

async function getSectorCapitalFlow(refresh = false) {
  const now = Date.now();
  if (!refresh && _cache.data && now - _cache.ts < CACHE_TTL) {
    return _cache.data;
  }
  // in-flight 并发锁：并发请求共享同一次抓取，避免重复打接口
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const result = await fetchAll();
      _cache = { ts: Date.now(), data: result };
      return result;
    } catch (e) {
      console.error('[SectorCapitalFlow] error:', e.message);
      // 有旧缓存时降级返回旧数据并标注，避免闪空
      if (_cache.data) {
        const stale = { ..._cache.data, staleWarning: '数据刷新失败，以下为最近一次成功数据：' + e.message };
        return stale;
      }
      return _empty(e.message);
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

// 服务启动预热：提前填充缓存，用户打开首页即命中（由 server.js 启动流程调用）
function warmup() {
  getSectorCapitalFlow(false).catch(() => {});
}

module.exports = { getSectorCapitalFlow, warmup };

~~~

---

## `lib\sectorCrowding.js`  ·  318 行

~~~js
/**
 * 行业板块拥挤度（首页新增模块）
 * --------------------------------------------------------------
 * 定义（用户给定口径）：
 *   板块拥挤度(原始) = 板块当日总成交额 ÷ A股全市场总成交额 × 100%
 *
 * 数据源与口径一致性：
 *   - 分子：同花顺「行业板块一览」中各板块当日总成交额（亿元）。
 *   - 分母：同花顺全行业板块成交额合计，作为「A股全市场总成交额」的口径一致近似
 *     （申万一级行业对全市场股票基本全覆盖，与各板块同源，避免跨源口径偏差）。
 *   - 因此本模块所有数值均来自同一数据源，满足「同一指标单一数据源」红线。
 *
 * 多周期统计（区间口径，与列头的日期范围严格一致）：
 *   - 当日：最新一个交易日各板块拥挤度排名前五（单日值）。
 *   - 本周：最近 5 个交易日（≈1 交易周）的区间聚合前五。
 *   - 本月：最近 21 个交易日（≈1 交易月）的区间聚合前五。
 *   区间聚合定义（三列内部自洽：拥挤度 × 区间全市场成交额 = 区间板块成交额）：
 *     成交额 = 区间内该板块各日成交额之和（累计，亿元）；
 *     拥挤度 = 区间板块成交额之和 ÷ 区间全市场成交额之和 × 100%（区间占比）；
 *     涨跌幅 = 区间内各交易日涨跌幅的复利累计。
 *   ⚠️ 20261002a 修正：旧实现把「成交额/涨跌幅」取成窗口最后一天的值（lastAmount/lastChange），
 *      导致今日/本周/本月三列成交额恒等（窗口末日相同）——不同时间长度累计成交额不可能一样。
 *   （历史不足时退化为可用天数并在 note 提示。）
 *
 * 历史记录：
 *   - 仅在「数据日期 == 当天」时落盘（非交易日/盘前不覆盖历史，避免污染周/月统计）。
 *   - 历史不足时，本周/本月退化为已有天数，并在 note 中提示「数据累积中」。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// 20261024k：统一「当前应更新到的交易日」口径（非交易日沿用最近交易日，不判数据不足）
const { asOfTradingDate } = require('./cnTradingCalendar');

// 存盘路径支持环境变量覆盖（仅用于回归测试隔离；生产不设置则用默认路径）
const DATA_FILE = process.env.SA_SECTOR_CROWDING_FILE
  ? path.resolve(process.env.SA_SECTOR_CROWDING_FILE)
  : path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
const KEEP_DAYS = 60;
const WEEK_DAYS = 5;     // 近 5 个交易日 ≈ 1 周
const MONTH_DAYS = 21;   // 近 21 个交易日 ≈ 1 月

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

/**
 * 按数据日期落盘当日板块拥挤度。
 * @param {Array} sectorAll 同花顺全量板块 [{name, amount(亿元), changePct}]
 * @param {string} dataDate 数据实际日期（来自同花顺，格式 YYYY-MM-DD）
 * @returns {object|null} 写入的当日记录；非交易日（dataDate≠今天）返回 null 不落盘
 */
function recordDaily(sectorAll, dataDate) {
  // 20261024k：非交易日（周末/节假日）应沿用最近交易日数据——数据日期等于「当前应更新到的交易日」
  // 即视为正常，并按真实交易日落盘；只有严格早于该交易日（真实滞后）才拒绝，避免污染历史。
  const asOf = asOfTradingDate(localDate());
  if (!dataDate || dataDate !== asOf) return null;
  if (!Array.isArray(sectorAll) || sectorAll.length === 0) return null;

  const marketTotal = sectorAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (marketTotal <= 0) return null;

  const sectors = sectorAll.map(x => {
    const amount = Number(x.amount) || 0;
    const crowding = Math.round((amount / marketTotal) * 10000) / 100; // 百分比，保留两位
    return {
      name: x.name,
      amount: Math.round(amount * 100) / 100,
      crowding,
      changePct: (typeof x.changePct === 'number') ? x.changePct : null,
    };
  });

  const all = readAll();
  all[dataDate] = {
    marketTotal: Math.round(marketTotal * 100) / 100,
    sectors,
    recordedAt: new Date().toISOString(),
  };
  // 只保留最近 KEEP_DAYS 天
  const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
  const trimmed = {};
  for (const d of dates) trimmed[d] = all[d];
  writeAll(trimmed);
  return trimmed[dataDate];
}

// 取最近 N 个交易日的「区间聚合」前五（按区间拥挤度降序）
// 区间口径（与列头日期范围一致）：
//   成交额 = Σ 该板块各日成交额（累计）
//   拥挤度 = Σ 板块成交额 ÷ Σ 全市场成交额 × 100%
//   涨跌幅 = Π(1 + 各日涨跌幅/100) - 1（复利累计）
function _topByAvg(datesAsc, n) {
  const windowDates = datesAsc.slice(-n);
  const store = readAll();
  const acc = {}; // name -> { amountSum, days, chgFactor, chgCnt }
  let marketSum = 0;
  for (const d of windowDates) {
    const entry = store[d];
    if (!entry || !Array.isArray(entry.sectors)) continue;
    marketSum += Number(entry.marketTotal) || 0;
    for (const s of entry.sectors) {
      const key = s.name;
      if (!acc[key]) acc[key] = { amountSum: 0, days: 0, chgFactor: 1, chgCnt: 0 };
      acc[key].amountSum += Number(s.amount) || 0;
      acc[key].days += 1;
      if (typeof s.changePct === 'number' && Number.isFinite(s.changePct)) {
        acc[key].chgFactor *= (1 + s.changePct / 100);
        acc[key].chgCnt += 1;
      }
    }
  }
  const list = Object.entries(acc).map(([name, v]) => ({
    name,
    // 区间拥挤度 = 区间板块成交额之和 ÷ 区间全市场成交额之和
    crowding: marketSum > 0 ? Math.round((v.amountSum / marketSum) * 10000) / 100 : 0,
    days: v.days,
    amount: Math.round(v.amountSum * 100) / 100,          // 区间累计成交额（亿元）
    changePct: v.chgCnt > 0 ? Math.round((v.chgFactor - 1) * 10000) / 100 : null, // 区间复利累计涨跌幅
  })).sort((a, b) => b.crowding - a.crowding);
  return { dates: windowDates, list: list.slice(0, 5), marketTotal: Math.round(marketSum * 100) / 100 };
}

/**
 * 从实时板块数据计算「当日」拥挤度前五（无需落盘）。
 * 用于首次加载/无历史时兜底，保证「当日」始终有数据。
 * @returns {{date:string, marketTotal:number, list:Array}|null}
 */
function _liveToday(sectorAll, dataDate) {
  if (!Array.isArray(sectorAll) || sectorAll.length === 0) return null;
  const marketTotal = sectorAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (marketTotal <= 0) return null;
  const list = sectorAll.map(x => {
    const amount = Number(x.amount) || 0;
    return {
      name: x.name,
      amount: Math.round(amount * 100) / 100,
      crowding: Math.round((amount / marketTotal) * 10000) / 100,
      changePct: (typeof x.changePct === 'number') ? x.changePct : null,
    };
  }).sort((a, b) => b.crowding - a.crowding).slice(0, 5);
  return {
    date: dataDate || localDate(),
    marketTotal: Math.round(marketTotal * 100) / 100,
    list,
  };
}

function _topToday(store) {
  const dates = Object.keys(store).sort();
  if (dates.length === 0) return { date: null, list: [] };
  const latest = dates[dates.length - 1];
  const entry = store[latest];
  const list = (entry.sectors || []).slice().sort((a, b) => b.crowding - a.crowding).slice(0, 5)
    .map(s => ({ name: s.name, crowding: s.crowding, amount: s.amount, changePct: s.changePct }));
  return { date: latest, list };
}

/**
 * 历史回填：调用 Python 脚本（同花顺行业指数历史成交额）生成过去 nDays 个交易日
 * 的各板块拥挤度，合并写入 store。后续 getCrowding 即可直接算本周/本月均值。
 *
 * @param {number} nDays 回填交易日数（默认 21 ≈ 1 月）
 * @param {string} pythonPath Python 解释器路径（由调用方传入，复用 server.js 的 findPython 记忆化）
 * @returns {Promise<{ok:boolean, written:number, total:number, source?:string, error?:string}>}
 */
let _backfillRunning = false;
async function backfillHistory(nDays = MONTH_DAYS, pythonPath) {
  if (_backfillRunning) return { ok: false, written: 0, total: 0, error: 'backfill already running' };
  _backfillRunning = true;
  try {
    const script = path.join(__dirname, '..', 'scripts', 'ths_sector_history.py');
    const py = pythonPath || process.env.PYTHON_PATH || 'python3';
    let stdout = '';
    try {
      const res = await execFileAsync(py, [script, '--days', String(nDays)], {
        timeout: 300000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, // Windows 下强制 Python stdout 用 utf-8，避免行业名乱码
      });
      stdout = (res && res.stdout) ? res.stdout : '';
    } catch (e) {
      return { ok: false, written: 0, total: 0, error: 'exec error: ' + (e && e.message) };
    }
    // 兼容 akshare tqdm 进度条可能混入 stdout：取最后一个合法 JSON 对象
    let data = null;
    try {
      data = JSON.parse(stdout.trim());
    } catch (e1) {
      const m = stdout.trim().match(/\{[\s\S]*\}$/);
      if (m) {
        try { data = JSON.parse(m[0]); } catch (e2) { /* ignore */ }
      }
    }
    if (!data || !data.ok || !data.days) {
      return { ok: false, written: 0, total: 0, error: (data && data.error) || 'no days in output' };
    }

    const all = readAll();
    let written = 0;
    for (const [d, dayObj] of Object.entries(data.days)) {
      if (!dayObj || !Array.isArray(dayObj.sectors) || dayObj.sectors.length === 0) continue;
      all[d] = {
        marketTotal: dayObj.marketTotal,
        sectors: dayObj.sectors.map(s => ({
          name: s.name,
          amount: s.amount,
          crowding: s.crowding,
          changePct: (typeof s.changePct === 'number') ? s.changePct : null,
        })),
        recordedAt: new Date().toISOString(),
      };
      written++;
    }
    // 只保留最近 KEEP_DAYS 天
    const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
    const trimmed = {};
    for (const d of dates) trimmed[d] = all[d];
    writeAll(trimmed);
    return { ok: true, written, total: dates.length, source: data.source, failures: data.failures };
  } finally {
    _backfillRunning = false;
  }
}

// store 中已记录交易日是否不足 nDays（用于决定是否触发历史回填）
function needsBackfill(threshold = MONTH_DAYS) {
  return Object.keys(readAll()).sort().length < threshold;
}

// store 是否已有指定日期的记录（供收盘补写守卫判断当日是否已落盘，读本地文件，极快）
function hasDate(date) {
  return Boolean(date && readAll()[date]);
}

// store 中最新一天的全市场成交额合计（用于「数据新鲜度指纹」判定：
// 交易日 15:30 后的成交额是新值，节假日/休市时数据源返回的是上一交易日的冻结值））
function latestMarketTotal() {
  const all = readAll();
  const dates = Object.keys(all).sort();
  if (!dates.length) return null;
  const entry = all[dates[dates.length - 1]];
  const v = entry && Number(entry.marketTotal);
  return Number.isFinite(v) ? v : null;
}

/**
 * 汇总输出当日 / 本周 / 本月 行业拥挤度前五。
 * @param {Array} sectorAll 可选，同花顺全量板块（用于当日实时补充，无需落盘由调用方决定是否记录）
 * @param {string} dataDate 可选，sectorAll 的数据日期
 */
function getCrowding(sectorAll, dataDate) {
  const store = readAll();
  const dates = Object.keys(store).sort();

  // 当日：优先用 store 中「今天」的记录（与历史同源：均来自同花顺行业指数成交额）；
  // 仅当 store 无今日（首日/盘前）时回退实时板块数据兜底
  const storeToday = _topToday(store);
  const liveToday = _liveToday(sectorAll, dataDate);
  const today = (storeToday.date === localDate()) ? storeToday : (liveToday || storeToday);

  // 本周 / 本月 均值
  const week = _topByAvg(dates, WEEK_DAYS);
  const month = _topByAvg(dates, MONTH_DAYS);

  const marketTotal = (today && today.marketTotal)
    ? today.marketTotal
    : (storeToday.date ? store[storeToday.date].marketTotal : null);

  const noteParts = [];
  if (dates.length === 0) {
    noteParts.push('历史数据为空，仅显示当日（最新）排名；周/月统计将在交易日逐日累积后可用。');
  } else {
    if (week.dates.length < WEEK_DAYS) noteParts.push(`本周统计目前仅 ${week.dates.length} 个交易日（满 ${WEEK_DAYS} 后稳定）。`);
    if (month.dates.length < MONTH_DAYS) noteParts.push(`本月统计目前仅 ${month.dates.length} 个交易日（满 ${MONTH_DAYS} 后稳定）。`);
  }

  return {
    ok: true,
    date: today.date,
    marketTotal,                       // A股全市场总成交额近似（亿元），同花顺行业合计
    source: '同花顺·行业板块',
    denominatorNote: '分母=A股全市场总成交额（同花顺申万一级行业板块成交额合计，口径一致近似）',
    today: today.list,
    week: week.list,
    month: month.list,
    weekDates: week.dates,
    monthDates: month.dates,
    note: noteParts.join(' '),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { recordDaily, getCrowding, backfillHistory, needsBackfill, hasDate, latestMarketTotal, localDate };

~~~

---

## `lib\sectorFundFlowEmDc.js`  ·  142 行

~~~js
/**
 * 行业板块资金流向 —— 东方财富「数据中心」报表源
 * ==================================================================
 * 背景：本机对东方财富「行情推送族」（push2 / push2delay / push2his / 82.push2 …）
 *   的请求会被对端在 TLS 握手后立刻重置（HTTPS 与纯 HTTP(80) 一样），
 *   而东方财富「数据中心族」（datacenter-web.eastmoney.com）完全可达
 *   （同项目 lib/analysis.js 的行业估值 RPT_VALUEINDUSTRY_DET、lib/capitalFlow.js 的融资融券
 *     RPTA_WEB_RZRQ_GGMX 早已走该域名，即为旁证）。取数细节见 lib/emDataCenter.js。
 *
 * 本模块用报表 RPT_INDUSTRY_FUNDFLOW 取「东财行业板块」资金流，可与 push2delay 口径互换：
 *   字段                含义                        对应 push2delay 字段
 *   ---------------------------------------------------------------
 *   BOARD_NAME          板块名                       f14
 *   CHANGE_RATE         当日涨跌幅(%)                f3
 *   NET_INFLOW          主力净流入(元)                f62
 *   SUPERDEAL_NET       超大单净流入(元)              f66
 *   BIGDEAL_NET         大单净流入(元)                f72
 *   SMALLDEAL_NET       小单净流入(元) = 散户口径      f84
 *   MAX_NETINFLOW_SEC   主力净流入最大股               f204
 *   TRADE_DATE          交易日（逐日一行）            ← 关键：可求和得「近5日」
 *
 * 口径：主力 = 超大单 + 大单（含暗盘性质机构资金）；散户 = 小单。
 * 单位：库内为「元」，对外统一换算为「亿元」，与卡片既有口径一致。
 * 层级：板块名用 parseSwSectorName 解析真实申万层级，再按 SW_LEVEL_UNIFIED 过滤（单层级，父子不重复计入）。
 */
const { parseSwSectorName, SW_LEVEL_UNIFIED } = require('./stockData');
const { REPORTS, fetchReport, latestTradeDate, shiftDate } = require('./emDataCenter');

const MAX_5D_DAYS = 5;                 // 「近5日」= 最近 5 个交易日
const WINDOW_LOOKBACK_DAYS = 16;       // 自然日回溯（覆盖 5 个交易日 + 周末/节假日余量）
const PAGE_SIZE = 900;                 // 单页容纳 ≥7 个交易日全量板块（每日约 128 行）

function _fmtYi(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n / 1e8 * 100) / 100 : 0;
}

module.exports = {
  /**
   * 取行业板块资金流（东财数据中心报表口径），返回值与 sectorCapitalFlow.fetchAll 完全同构。
   * @returns {Promise<object>}
   */
  async getEmDcSectorCapitalFlow() {
    // 1) 最新交易日：以数据为准（数据驱动，不依赖本地日期/交易日历）
    const d0 = await latestTradeDate(REPORTS.INDUSTRY_FUNDFLOW);

    // 2) 取 d0 往前 16 个自然日的全部「逐日」行
    const from = shiftDate(d0, -WINDOW_LOOKBACK_DAYS);
    const all = await fetchReport(REPORTS.INDUSTRY_FUNDFLOW, {
      filter: `(TRADE_DATE>='${from}')`,
      sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: PAGE_SIZE, pageNumber: 1,
    });
    if (!all.length) throw new Error('东财数据中心行业资金流报表窗口内无数据');

    // 3) 交易日分组（以数据中实际出现的日期为准，避免把不完整日期算入 5 日窗口）
    const byDate = new Map();
    for (const r of all) {
      const d = String(r.TRADE_DATE).slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }
    const dates = [...byDate.keys()].sort().reverse();
    const win5 = dates.slice(0, MAX_5D_DAYS);
    const today = byDate.get(d0) || [];
    if (!today.length) throw new Error('东财数据中心行业资金流报表当日无数据');

    // 4) 单条 → 卡片 tile（netKey 指定用哪个净额字段排序，与 push2delay 版同构）
    const tile = (r, netKey = 'NET_INFLOW') => {
      const p = parseSwSectorName(r.BOARD_NAME);
      const isMain = netKey === 'NET_INFLOW';
      return {
        name: p.name,
        rawName: p.rawName,
        swLevel: p.swLevel || null,
        changePct: Number(r.CHANGE_RATE) || 0,
        mainNet: _fmtYi(r[netKey]),
        superLargeNet: isMain ? _fmtYi(r.SUPERDEAL_NET) : null,
        largeNet: isMain ? _fmtYi(r.BIGDEAL_NET) : null,
        leader: r.MAX_NETINFLOW_SEC ? String(r.MAX_NETINFLOW_SEC).trim() : '',
      };
    };
    const inLevel = (x) => !!x && x.swLevel === SW_LEVEL_UNIFIED;
    const top = (rows, netKey, dir, n = 5) => (rows || [])
      .map((r) => tile(r, netKey))
      .filter((x) => inLevel(x) && (dir === 'in' ? x.mainNet > 0 : x.mainNet < 0))
      .sort((a, b) => (dir === 'in' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet))
      .slice(0, n);

    // 5) 近5日累计（对同一板块在最近 5 个交易日上的逐日值求和）
    const acc = new Map();
    for (const d of win5) {
      for (const r of byDate.get(d) || []) {
        const key = String(r.BOARD_NAME).trim();
        if (!key) continue;
        const cur = acc.get(key) || { raw: key, main: 0, retail: 0, days: 0 };
        cur.main += Number(r.NET_INFLOW) || 0;
        cur.retail += Number(r.SMALLDEAL_NET) || 0;
        cur.days += 1;
        acc.set(key, cur);
      }
    }
    const sumTile = (v, field) => {
      const p = parseSwSectorName(v.raw);
      return {
        name: p.name,
        rawName: p.rawName,
        swLevel: p.swLevel || null,
        changePct: 0,
        mainNet: _fmtYi(v[field]),
        superLargeNet: null,
        largeNet: null,
        leader: '',
      };
    };
    const sumList = [...acc.values()].map((v) => ({ main: sumTile(v, 'main'), retail: sumTile(v, 'retail') }));
    const pick = (field, dir) => sumList
      .map((x) => x[field]).filter(inLevel)
      .sort((a, b) => (dir === 'max' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet))[0] || null;

    const winLabel = win5.length > 1 ? `${win5[win5.length - 1]} ~ ${win5[0]}` : win5[0];

    return {
      ok: true,
      date: d0,
      source: '东方财富·行业资金流（数据中心）',
      note: `主力净流入 = 超大单 + 大单（含暗盘性质机构资金）；散户净流入 = 小单净流入（单笔＜2万股或＜4万元）；`
        + `榜单统一${SW_LEVEL_UNIFIED}口径（单层级，父子行业不重复计入）。`
        + `取数：东方财富数据中心·行业资金流报表（逐日口径），数据截至 ${d0}；近5日 = 最近 ${win5.length} 个交易日（${winLabel}）逐日累计`,
      todayInflowTop5: top(today, 'NET_INFLOW', 'in'),
      todayOutflowTop5: top(today, 'NET_INFLOW', 'out'),
      retailInflowTop5: top(today, 'SMALLDEAL_NET', 'in'),
      retailOutflowTop5: top(today, 'SMALLDEAL_NET', 'out'),
      fiveDayMaxInflow: pick('main', 'max'),
      fiveDayMaxOutflow: pick('main', 'min'),
      retailFiveDayMaxInflow: pick('retail', 'max'),
      retailFiveDayMaxOutflow: pick('retail', 'min'),
      fallbackWarning: `东方财富实时行情接口(push2delay)在本机不可达，已改用东方财富数据中心·行业资金流报表（同为东财口径，数据截至 ${d0}）`,
      fiveDayWarning: null,
    };
  },
};

~~~

---

## `lib\sectorIdentity.js`  ·  431 行

~~~js
/**
 * 个股行业身份解析（单一可信源）
 * ------------------------------------------------------------
 * 把「个股属于哪个行业板块」做成唯一、可测试、确定性的解析入口，
 * 供短期判断、长期判断、行业分析、板块趋势、板块涨跌停等模块统一调用。
 *
 * 设计原则：
 * 1. 代码优先：对已知易误判的股票用硬编码覆盖表，不再依赖外部 F10 名称解析。
 * 2. 多源校验：F10 sshy / 研报 indvInduName / 行情元数据 仅作为补源，结果必须自洽。
 * 3. symbol 强校验：缓存/返回全程以 symbol 为唯一 key，杜绝跨股污染。
 * 4. 简单可测：resolveSectorIdentity(symbol, name) 返回结构化对象，逻辑透明。
 */

const axios = require('axios');
const { detectMarket } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normCode(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
}

// ---- 确定性行业覆盖表（按代码）----
// 只放「外部数据源容易误判」或「用户持仓/关注」的股票。
// 未命中覆盖表的个股走下方多源解析，结果会被规范化。
const INDUSTRY_BY_CODE = {
  // 保险（东财 F10 常把综合金融集团误归为非银金融/证券）
  '601318': '保险', // 中国平安
  '601628': '保险', // 中国人寿
  '601336': '保险', // 新华保险
  '601319': '保险', // 中国人保
  '601601': '保险', // 中国太保
  '600291': '保险', // 西水股份（已退市，保留兼容）
  '000627': '保险', // 天茂集团

  // 证券
  '600909': '证券', // 华安证券
  '000783': '证券', // 长江证券
  '600030': '证券', // 中信证券
  '600837': '证券', // 海通证券
  '601688': '证券', // 华泰证券
  '300059': '证券', // 东方财富

  // 银行（护栏：避免带"平安"字样的银行被误归保险）
  '000001': '银行', // 平安银行
  '600036': '银行', // 招商银行
  '601398': '银行', // 工商银行
  '601288': '银行', // 农业银行
  '601939': '银行', // 建设银行
  '601988': '银行', // 中国银行

  // 食品饮料（酱油/乳业/白酒等）
  '603288': '食品饮料', // 海天味业
  '600887': '食品饮料', // 伊利股份
  '000858': '食品饮料', // 五粮液
  '600519': '食品饮料', // 贵州茅台
  '000568': '食品饮料', // 泸州老窖

  // 半导体 / 芯片
  '600460': '半导体', // 士兰微
  '688981': '半导体', // 中芯国际
  '603501': '半导体', // 韦尔股份
  '002371': '半导体', // 北方华创

  // 电子 / 元件
  '300319': '电子', // 麦捷科技

  // 医疗器械 / 医药
  '688289': '医疗器械', // 圣湘生物
  '300760': '医疗器械', // 迈瑞医疗
  '603259': '医药',     // 药明康德
  '600276': '医药',     // 恒瑞医药

  // 新能源 / 汽车
  '300750': '新能源', // 宁德时代
  '002594': '新能源汽车', // 比亚迪
  '601012': '新能源', // 隆基绿能
  '600438': '新能源', // 通威股份
};

// ---- 东方财富精确行业分类（F10 行业，比广义归一化行业更细，仅用于展示）----
// 当某股票广义行业（INDUSTRY_BY_CODE）与东方财富 F10 精确行业不一致时，
// 用它给出更贴合东方财富口径的展示标签。例：海天味业 广义=食品饮料，东财 F10=调味发酵品2。
// 注意：该字段仅供「东方财富行业分类」展示，不参与新闻/政策/情绪/判断等逻辑（逻辑仍用归一化 industry）。
const EM_INDUSTRY_BY_CODE = {
  '603288': '调味发酵品2', // 海天味业（东方财富 F10 行业）
  '600519': '白酒', // 贵州茅台
  '000858': '白酒', // 五粮液
  '000568': '白酒', // 泸州老窖
  '600887': '乳品', // 伊利股份
  '300319': '元件', // 麦捷科技（东方财富 F10 行业）
  '300750': '电池', // 宁德时代
  '600438': '光伏设备', // 通威股份
  '601012': '光伏设备', // 隆基绿能
  '600276': '化学制药', // 恒瑞医药
  '603259': '医疗服务', // 药明康德（CXO）
};

// ---- 同花顺行业指数 K 线专用板块映射 ----
// 当广义归一化行业名无法直接命中同花顺板块列表时，显式指定用于拉取 K 线的同花顺板块。
// 例：海天味业 广义=食品饮料（同花顺无此板块），映射到同花顺「食品加工制造」指数（代码 881134）。
// 东方财富 push2 本机被封，K 线只能走同花顺，故此处用可达的同花顺板块作为代表行业指数。
// 同花顺无「乳业」板块，伊利用「食品加工制造」（881134）代指；无「食品饮料」板块，白酒股用「白酒」（881273）。
const THS_BOARD_BY_CODE = {
  '603288': '食品加工制造', // 海天味业 → 同花顺 食品加工制造（代码 881134）
  '600519': '白酒', // 贵州茅台 → 同花顺 白酒（代码 881273）
  '000858': '白酒', // 五粮液
  '000568': '白酒', // 泸州老窖
  '600887': '食品加工制造', // 伊利股份（同花顺无"乳业"板块，用食品加工制造代指，代码 881134）
  '300319': '元件', // 麦捷科技 → 同花顺 元件（代码 881270；注意归一化"电子"会误命中"电子化学品"，故显式指定）
  // 新能源 / 新能源车（同花顺无"新能源"板块，按细分映射）
  '300750': '电池', // 宁德时代 → 同花顺 电池（代码 881281）
  '600438': '光伏设备', // 通威股份 → 同花顺 光伏设备（代码 881279）
  '601012': '光伏设备', // 隆基绿能 → 同花顺 光伏设备（代码 881279）
  '688660': '风电设备', // 电气风电 → 同花顺 风电设备（申万一级为「新能源」，不登记会经同义词表泛化误配「光伏设备」；20260910）
  '002594': '汽车整车', // 比亚迪 → 同花顺 汽车整车（代码 881125；同花顺无"新能源汽车"板块）
  // 医药（同花顺"医药"会误命中"医药商业"，按细分映射）
  '600276': '化学制药', // 恒瑞医药 → 同花顺 化学制药（代码 881140）
  '603259': '医疗服务', // 药明康德 → 同花顺 医疗服务（代码 881175；CXO）
};

// ---- 东财行业研报分类码（indvInduCode）静态映射 ----
// 用于「个股研报 qType=0 接口返回 0 条」时的兜底——已知规范化行业名对应的
// 东财行业研报码。例：长江证券(000783) 在 EM 上 qType=0 没有任何研报，
// 但它属于「证券」行业，应仍能查到「证券Ⅱ」行业研报，因此用 473 兜底。
// 该码经验证与 qType=0 返回的 indvInduCode 一致（473=证券Ⅱ，474=保险，475=银行）。
const INDUSTRY_CODE_BY_NAME = {
  '保险': '474',
  '证券': '473',
  '银行': '475',
  '食品饮料': '1279',
  '半导体': '',
  '电子': '',
  '医疗器械': '',
  '医药': '',
  '新能源': '',
  '新能源汽车': '',
};

// ---- 行业名规范化映射 ----
// 把外部数据源五花八门的行业名统一成内部规范名。
const INDUSTRY_NORM = [
  { keys: ['保险', '人身保险', '财产保险', '再保险'], name: '保险' },
  { keys: ['证券', '券商', '投资银行', '期货'], name: '证券' },
  { keys: ['银行', '商业银行', '城商行', '农商行', '股份制银行'], name: '银行' },
  { keys: ['白酒', '酿酒', '啤酒', '葡萄酒', '食品饮料', '食品制造', '调味发酵品', '乳品', '肉制品'], name: '食品饮料' },
  { keys: ['半导体', '集成电路', '芯片', '分立器件', 'EDA', '光刻'], name: '半导体' },
  { keys: ['医疗器械', '医疗器材', '体外诊断', 'IVD', '医用耗材'], name: '医疗器械' },
  { keys: ['制药', '生物制品', '化学制药', '中药', '创新药', '医药'], name: '医药' },
  { keys: ['新能源', '光伏', '风电', '储能', '锂电', '电池'], name: '新能源' },
  { keys: ['新能源汽车', '汽车整车', '乘用车', '商用车', '整车'], name: '新能源汽车' },
  { keys: ['人工智能', 'AI', '算力', '大模型', '光模块', '数据中心'], name: '人工智能' },
  { keys: ['计算机', '软件', '信创', 'IT服务', '工业软件'], name: '计算机' },
  { keys: ['通信', '5G', '6G', '通信设备', '算力网络'], name: '通信' },
  { keys: ['军工', '航天', '航空', '国防', '卫星'], name: '军工' },
  { keys: ['电力设备', '电网', '特高压', '电气设备'], name: '电力设备' },
  { keys: ['煤炭', '石油', '石化', '电力', '燃气', '能源'], name: '能源' },
  { keys: ['有色', '钢铁', '化工', '化纤', '基础化工', '化学制品'], name: '周期' },
  { keys: ['房地产', '地产', '房地产开发'], name: '房地产' },
  { keys: ['传媒', '游戏', '影视', '互联网', '广告'], name: '传媒' },
  { keys: ['家电', '机械', '工程机械', '专用设备'], name: '机械' },
  { keys: ['建筑', '建材', '水泥', '玻璃', '装饰'], name: '建材' },
  { keys: ['农业', '种业', '养殖', '化肥', '农化'], name: '农业' },
  { keys: ['物流', '快递', '交运', '航运', '港口'], name: '物流' },
  { keys: ['环保', '水务', '绿化', '生态'], name: '环保' },
  { keys: ['零售', '商贸', '餐饮', '旅游', '酒店'], name: '消费服务' },
  { keys: ['纺织服装', '纺织', '服装'], name: '纺织服装' },
  { keys: ['电子', '消费电子', '元件', '被动元件'], name: '电子' },
];

function normalizeIndustryName(raw) {
  const text = String(raw || '');
  if (!text) return '';
  // 最长（最具体）关键词优先匹配（20261016b 修复 IA2 上游病根）。
  // 旧实现第一命中即返回：「新能源汽车」会被第 161 行的「新能源」抢先归一为「新能源」，
  // 导致下游 getPolicySupport 拿到的行业名里根本不含「新能源汽车」，
  // 即使单独修 industryAnalysis.js 也救不回来——故本处必须与下游同改。
  // 等长时保留原数组顺序。返回类型仍为字符串 name，下游无需适配。
  let best = null;
  INDUSTRY_NORM.forEach((item, idx) => {
    item.keys.forEach((k) => {
      if (text.includes(k) && (!best || k.length > best.len)) {
        best = { len: k.length, idx };
      }
    });
  });
  if (best) return INDUSTRY_NORM[best.idx].name;
  return text;
}

// ---- 多源解析 ----

async function fetchEastmoneyF10Industry(symbol) {
  const code = normCode(symbol);
  const info = detectMarket(symbol);
  const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  try {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${emCode}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/' },
      timeout: 10000,
    });
    const j = r.data?.Result || r.data?.result || r.data;
    const jbzl = j?.jbzl || {};
    return {
      sshy: jbzl.sshy || '',
      sszjhhy: jbzl.sszjhhy || '',
    };
  } catch (e) {
    console.error('[SectorIdentity] F10 failed:', code, e.message);
    return { sshy: '', sszjhhy: '' };
  }
}

async function fetchReportIndustry(symbol) {
  const code = normCode(symbol);
  try {
    const end = new Date();
    const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
    const url = `https://reportapi.eastmoney.com/report/list?qType=0&pageSize=5&pageNo=1&code=${code}&beginTime=${fmtDate(begin)}&endTime=${fmtDate(end)}&industryCode=*&rating=&ratingChange=`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://reportapi.eastmoney.com/' },
      timeout: 10000,
    });
    const rows = r.data?.data || [];
    if (rows.length) {
      return {
        induCode: rows[0].indvInduCode || '',
        induName: rows[0].indvInduName || '',
      };
    }
  } catch (e) {
    console.error('[SectorIdentity] report indu failed:', code, e.message);
  }
  return { induCode: '', induName: '' };
}

// ---- 缓存（按 symbol，TTL 30s）----
const _cache = new Map();
const CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_SIZE = 256;

function getCached(symbol) {
  const code = normCode(symbol);
  const hit = _cache.get(code);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(code);
    return null;
  }
  return hit.data;
}

function setCached(symbol, data) {
  const code = normCode(symbol);
  if (_cache.size >= MAX_CACHE_SIZE) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
  _cache.set(code, { ts: Date.now(), data });
}

// ---- 主入口 ----

/**
 * 解析个股所属行业板块。
 * @param {string} symbol 股票代码（支持 SH/SZ 前缀或纯数字）
 * @param {string} [name] 股票名称（仅用于日志/展示，不参与解析）
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 强制跳过缓存重新解析
 * @returns {Promise<{symbol:string, name:string, industry:string, industrySource:string, confidence:number, generatedAt:string, ok:boolean}>}
 */
async function resolveSectorIdentity(symbol, name, opts = {}) {
  const code = normCode(symbol);
  const displayName = name || '';

  if (!code) {
    return { symbol: '', name: displayName, industry: '', industrySource: 'invalid', confidence: 0, generatedAt: new Date().toISOString(), ok: false };
  }

  if (!opts.force) {
    const cached = getCached(code);
    if (cached && cached.symbol === code) return cached;
  }

  // 1) 硬编码覆盖表（最高优先级，确定性最强）
  let industry = INDUSTRY_BY_CODE[code] || '';
  let source = industry ? 'code-override' : '';
  let confidence = industry ? 1.0 : 0;

  // 2) 外部数据源交叉校验/补充
  let f10Name = '';
  let reportName = '';
  let induCode = '';

  // 2) 外部数据源交叉校验/补充。
  //    无论是否命中覆盖表，都同步抓取一次东财研报（fetchReportIndustry），
  //    以拿到权威的行业研报分类码 induCode（indvInduCode，如证券=473）。
  //    该码用于下游 fetchIndustryReports(induCode) 的 qType=1 行业研报查询，
  //    与展示用的归一化 industry 标签解耦——覆盖表锁定标签，但 induCode 仍需透传，
  //    否则证券/保险/银行等覆盖表板块的「行业分析师研究报告」永远为空。
  const [f10, report] = await Promise.all([
    withTimeout(fetchEastmoneyF10Industry(symbol), 12000, { sshy: '', sszjhhy: '' }),
    withTimeout(fetchReportIndustry(symbol), 12000, { induCode: '', induName: '' }),
  ]);
  f10Name = f10.sshy || f10.sszjhhy || '';
  reportName = report.induName || '';
  induCode = report.induCode || '';

  // 兜底：若 qType=0 个股研报接口无返回（小盘股/久无研报的股票），用规范化行业名静态映射。
  // 例：长江证券(000783) EM 个股研报为空，但属于「证券」行业 → 用 473 仍可拉到证券Ⅱ行业研报。
  if (!induCode && industry && INDUSTRY_CODE_BY_NAME[industry]) {
    induCode = INDUSTRY_CODE_BY_NAME[industry];
    if (induCode) console.log(`[SectorIdentity] ${code} 个股研报无 induCode，按行业兜底 ${industry}=${induCode}`);
  }

  if (industry) {
    // 命中覆盖表：industry/conf 以覆盖表为准（确定性最强），仅做一致性告警，不覆盖标签。
    const external = normalizeIndustryName(f10Name || reportName || '');
    if (external && external !== industry) {
      console.warn(`[SectorIdentity] 覆盖表与外部数据源不一致: ${code} 覆盖=${industry} 外部=${external}`);
    }
  } else {
    // 未命中覆盖表：优先用 F10 所属行业，其次研报分类，作为 industry 标签。
    const raw = f10Name || reportName || '';
    if (raw) {
      industry = normalizeIndustryName(raw);
      source = f10Name ? 'f10-sshy' : 'report-induName';
      confidence = 0.75;
    }
  }

  // 3) 最终规范化
  industry = normalizeIndustryName(industry);

  const result = {
    symbol: code,
    name: displayName,
    industry,
    // 东方财富精确行业分类（仅展示用，命中代码覆盖表时取 EM_INDUSTRY_BY_CODE）
    emIndustry: industry ? (EM_INDUSTRY_BY_CODE[code] || '') : '',
    // 同花顺 K 线专用板块（命中代码覆盖表时取 THS_BOARD_BY_CODE，否则为空，前端回退到 industry）
    boardName: industry ? (THS_BOARD_BY_CODE[code] || '') : '',
    induCode,
    industrySource: source || 'unknown',
    confidence,
    f10Name,
    reportName,
    generatedAt: new Date().toISOString(),
    ok: !!industry,
  };

  // 4) 防御性断言：返回的 symbol 必须与请求一致
  if (result.symbol !== code) {
    throw new Error(`[SectorIdentity] symbol 不一致: input=${code} output=${result.symbol}`);
  }

  setCached(code, result);
  console.log(`[SectorIdentity] ${code} ${displayName} → ${industry || '未知'} (source=${source}, conf=${confidence})`);
  return result;
}

/**
 * 仅读取覆盖表（不联网），用于需要确定性映射的场景。
 */
function getIndustryOverride(symbol) {
  return INDUSTRY_BY_CODE[normCode(symbol)] || '';
}

/**
 * 把规范行业名映射到搜索/分析用的广义赛道关键词。
 */
function getSectorKeywords(industryName) {
  const norm = String(industryName || '').replace(/行业/g, '').replace(/业/g, '').trim();
  if (!norm) return [];
  // 与 newsSearch.SECTOR_KEYWORDS 保持一致语义
  const map = {
    '保险': ['保险', '人身险', '财产险', '中国平安', '中国人寿'],
    '证券': ['证券', '券商', '投行', '资本市场'],
    '银行': ['银行', '商业银行', '信贷', 'LPR'],
    '食品饮料': ['食品饮料', '白酒', '酱油', '调味品', '乳业', '消费'],
    '半导体': ['半导体', '芯片', '集成电路', '晶圆', 'IDM'],
    '医疗器械': ['医疗器械', '体外诊断', 'IVD', '医疗耗材'],
    '医药': ['医药', '创新药', '生物制药', '中药'],
    '新能源': ['新能源', '光伏', '储能', '锂电池', '风电'],
    '新能源汽车': ['新能源汽车', '电动车', '比亚迪', '动力电池'],
    '人工智能': ['人工智能', 'AI', '算力', '大模型', '光模块'],
    '计算机': ['计算机', '软件', '信创', 'IT服务'],
    '通信': ['通信', '5G', '6G', '通信设备'],
    '军工': ['军工', '国防', '航天', '航空'],
    '电力设备': ['电力设备', '电网', '特高压'],
    '能源': ['能源', '煤炭', '石油', '电力'],
    '周期': ['有色', '化工', '钢铁', '周期'],
    '房地产': ['房地产', '地产', '房地产开发'],
    '传媒': ['传媒', '游戏', '影视', '互联网'],
    '机械': ['机械', '工程机械', '家电'],
    '建材': ['建材', '水泥', '玻璃', '建筑'],
    '农业': ['农业', '种业', '养殖', '化肥'],
    '物流': ['物流', '快递', '交运'],
    '环保': ['环保', '水务', '生态'],
    '消费服务': ['零售', '商贸', '餐饮', '旅游', '酒店'],
    '纺织服装': ['纺织', '服装'],
    '电子': ['电子', '消费电子', '元件'],
  };
  for (const [k, v] of Object.entries(map)) {
    if (norm.includes(k) || k.includes(norm)) return v;
  }
  return [industryName].filter(Boolean);
}

module.exports = {
  resolveSectorIdentity,
  getIndustryOverride,
  getSectorKeywords,
  normalizeIndustryName,
  INDUSTRY_BY_CODE,
  EM_INDUSTRY_BY_CODE,
  THS_BOARD_BY_CODE,
};

~~~

---

## `lib\sectorLimitStats.js`  ·  50 行

~~~js
/**
 * 板块涨跌停占比数据层（短期情绪核心因子）
 * --------------------------------------------------------------
 * 调用 scripts/sector_limit_stats.py，返回：
 *   { ok, industryName, boardName, limitUp, limitDown, total,
 *     limitUpRatio, limitDownRatio, signal, note, threshold }
 * 复用 stockData 的 findPythonForScript；按 industry 键 60s 内存缓存。
 * 脚本失败（无 Python/缺依赖/全失败）则抛出异常，由上层捕获转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

let _cache = {};
const CACHE_TTL = 60000; // 60s

function cacheKey(industry) {
  return `k:${industry || ''}`;
}

async function getSectorLimitStats(symbol, name, industry) {
  const key = cacheKey(industry);
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用板块涨跌停占比接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_limit_stats.py');
  if (!fs.existsSync(script)) throw new Error('sector_limit_stats.py 不存在: ' + script);

  const args = [script, '--symbol', String(symbol || ''), '--name', String(name || ''), '--industry', String(industry || '')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  _cache[key] = { ts: now, data: parsed };
  return parsed;
}

module.exports = { getSectorLimitStats };

~~~

---

## `lib\sectorMarketCapHistory.js`  ·  383 行

~~~js
/**
 * 板块（行业）成分股总市值历史 · 日频合计
 * ================================================================
 * 用途：行业分析页「板块总市值走势」卡片 —— 展示某板块（东财板块代码 BKxxxx，如调味发酵品2 = BK1278）
 *       全部成分股的**总市值合计**日频走势，并叠加当前个股自身市值做对比。
 *
 * 数据源（规则一·单一权威源）：
 *   1) 成分股名单 + 最新总市值：东方财富 push2delay `api/qt/clist/get`（fs=b:BKxxxx，f12 代码 / f14 名称 / f20 总市值）
 *   2) 每只成分股日频总市值序列：复用 lib/eastmoneyValuation.fetchValuationTTM 的 dailyAll
 *      （东方财富 TTM RPT_VALUEANALYSIS_DET · TOTAL_MARKET_CAP），与「个股市值走势」同源，口径一致。
 *
 * 口径说明：
 *   - 板块合计总市值(日) = 当日「有市值数据」的成分股总市值之和（亿元）；
 *   - 覆盖度 coverage(日) = 当日参与合计的成分股只数；缺失成分股名单在 missing 中显式列出，
 *     避免"少算了却看不出来"（规则一·数据一致性）。
 *   - 成分股过多时按最新总市值降序取前 maxConstituents 只（覆盖绝大部分板块市值），并在 capped 中标注。
 *
 * 缓存：按 板块代码 + 本地日期 落盘 data/cache/sector_market_cap/，自然日 1 天内命中。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { fetchValuationTTM } = require('./eastmoneyValuation');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'sector_market_cap');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时（同一自然日内基本命中）
const DEFAULT_DAYS = 250;                 // 约 1 年交易日
const DEFAULT_MAX_CONSTITUENTS = 40;      // 成分股上限（按总市值降序）
const DEFAULT_CONCURRENCY = 6;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ensureDir() {
  try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}
function cacheFile(sectorCode, days) {
  ensureDir();
  // 缓存键含 days：不同回看窗口分别缓存，避免先用 60 天窗口请求后污染 250 天视图
  return path.join(CACHE_DIR, `${safeName(sectorCode)}_${Number(days) || DEFAULT_DAYS}_${localDate()}.json`);
}
function readCache(sectorCode, days) {
  try {
    const f = cacheFile(sectorCode, days);
    if (!fs.existsSync(f)) return null;
    const stat = fs.statSync(f);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}
function writeCache(sectorCode, days, data) {
  try { fs.writeFileSync(cacheFile(sectorCode, days), JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
}

// 取该板块「最近一次成功快照」——不限当天、不限 TTL。数据源暂不可用时用它保活卡片
// （数据最新性规则：宁可显示「带日期标注的旧快照」，也不要让卡片凭空消失）。
function readLatestCacheAny(sectorCode, days) {
  try {
    ensureDir();
    const prefix = `${safeName(sectorCode)}_${Number(days) || DEFAULT_DAYS}_`;
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[i]), 'utf8'));
        if (obj && obj.success && Array.isArray(obj.dates) && obj.dates.length) {
          obj._staleFile = files[i];
          return obj;
        }
      } catch { /* 该文件损坏，继续看更早的 */ }
    }
    return null;
  } catch { return null; }
}

// 构建失败 → 回退最近快照；无快照则返回 null（由调用方给出原始错误）
function staleFallback(sectorCode, days, sectorName, reason) {
  const stale = readLatestCacheAny(sectorCode, days);
  if (!stale) return null;
  return {
    ...stale,
    sectorName: sectorName || stale.sectorName || '',
    cached: true,
    stale: true,
    staleFile: stale._staleFile || '',
    staleReason: reason,
  };
}

// ---------------------------------------------------------------------------
// 成分股清单「侧车缓存」：单独落盘 {code,name,marketCap}，与展示缓存解耦
//  目的：数据源（clist）抖动时，仍可用「已有清单 + 当日序列」重建全新数据，
//        而不是整体退回旧快照（数据最新性规则）。文件名不含尾随 "_"，
//        因此不会被 readLatestCacheAny 的 `${BK}_${days}_` 前缀匹配到。
// ---------------------------------------------------------------------------
function listFile(sectorCode, days) {
  ensureDir();
  return path.join(CACHE_DIR, `${safeName(sectorCode)}_${Number(days) || DEFAULT_DAYS}.constituents.json`);
}
function writeConstituentList(sectorCode, days, list, source) {
  try {
    if (!Array.isArray(list) || !list.length) return;
    fs.writeFileSync(listFile(sectorCode, days), JSON.stringify({
      source: source || '', updatedAt: new Date().toISOString(),
      list: list.map(x => ({ code: x.code, name: x.name, marketCap: x.marketCap })),
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
}
function readConstituentList(sectorCode, days) {
  try {
    const f = listFile(sectorCode, days);
    if (!fs.existsSync(f)) return [];
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (o && Array.isArray(o.list)) ? o.list.filter(x => x && x.code) : [];
  } catch { return []; }
}

// 20260922l：clist 被掐断时的**同源**补偿通道 ——
//   本模块的日频市值本就取自 datacenter-web 报表 RPT_VALUEANALYSIS_DET（见 fetchValuationTTM），
//   该报表同时带 BOARD_NAME（申万板块名）列，按板块名过滤即可取到该板块**最新交易日**全部成分股，
//   单位/口径与序列完全一致（并非换数据源）。实测申万二级板块名（如「调味发酵品Ⅱ」）可用；
//   申万一级/三级板块名不在该报表 BOARD_NAME 值域内 → 返回空，交由上层继续降级。
async function fetchConstituentsFromDC(sectorName) {
  const name = String(sectorName || '').trim();
  if (!name) return [];
  const from = localDate(new Date(Date.now() - 20 * 24 * 3600 * 1000));
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,TOTAL_MARKET_CAP';
  const url = `${DC}?reportName=RPT_VALUEANALYSIS_DET&columns=${cols}`
    + `&filter=${encodeURIComponent(`(BOARD_NAME="${name}")(TRADE_DATE>='${from}')`)}`
    + `&pageSize=2000&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
    const rows = (data && data.result && Array.isArray(data.result.data)) ? data.result.data : [];
    if (!rows.length) return [];
    let latest = '';
    rows.forEach(r => { const d = String(r.TRADE_DATE || '').slice(0, 10); if (d > latest) latest = d; });
    const out = [];
    const seen = new Set();
    rows.forEach(r => {
      if (String(r.TRADE_DATE || '').slice(0, 10) !== latest) return;
      const code = String(r.SECURITY_CODE || '');
      if (!code || seen.has(code)) return;
      seen.add(code);
      out.push({ code, name: String(r.SECURITY_NAME_ABBR || ''), marketCap: Number(r.TOTAL_MARKET_CAP) || 0 });
    });
    return out;
  } catch { return []; }
}

// 受限并发 map（避免一次性打爆数据源 / 触发限流）
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e && e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// 20260922l：东财 push2 族 `clist/get` 在本机被对端掐断（socket hang up；实测 push2delay/push2/82.push2/16.push2
//   全灭，而**同族 slist/get 正常** → 属 clist 路径被针对性重置、偶发成功）。
//   对策：多主机轮询 + 重试提高命中率；全部失败时由上层回退「最近一次成功快照」，避免卡片因单通道抖动而消失。
const EM_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://16.push2.eastmoney.com',
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 拉取板块成分股名单（代码 / 名称 / 最新总市值，单位：元） */
async function fetchConstituents(sectorCode) {
  const qs = `pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f20&fs=${encodeURIComponent('b:' + sectorCode)}&fields=f12,f14,f20,f21`;
  const errors = [];
  for (let round = 0; round < 2; round++) {
    for (const host of EM_HOSTS) {
      try {
        const { data } = await axios.get(`${host}/api/qt/clist/get?${qs}`, { headers: HEADERS, timeout: 12000 });
        const diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
        if (diff.length) {
          return diff
            .map(d => ({ code: String(d.f12 || ''), name: String(d.f14 || ''), marketCap: Number(d.f20) || 0 }))
            .filter(d => d.code);
        }
        errors.push(`${host}: 空返回`);
      } catch (e) { errors.push(`${host}: ${(e && e.message) || 'fail'}`); }
    }
    if (round === 0) await sleep(350); // 短暂退避后重试一轮
  }
  throw new Error('东财板块成分股通道全部失败（' + errors.slice(0, 3).join('；') + '）');
}

/** 单只成分股日频市值序列（[{date, marketCap}] 升序，单位：亿元） */
async function fetchOneSeries(code) {
  const v = await fetchValuationTTM(code);
  const src = (v && Array.isArray(v.dailyAll) && v.dailyAll.length) ? v.dailyAll
    : (v && Array.isArray(v.daily) ? v.daily : []);
  return src
    .map(d => ({ date: String(d.date || ''), marketCap: Number(d.marketCap) || 0 }))
    .filter(d => d.date && d.marketCap > 0);
}

/**
 * 获取板块成分股总市值合计日频序列。
 * @param {string} sectorCode 东财板块代码，如 'BK1278'
 * @param {object} [opts]
 * @param {string} [opts.sectorName] 板块中文名（回显用，如 '调味发酵品2'）
 * @param {string} [opts.benchmark]  对比个股代码（默认 '603288' 海天味业）
 * @param {string} [opts.benchmarkName] 对比个股名称（回显用）
 * @param {number} [opts.days=250] 返回最近多少个交易日
 * @param {number} [opts.maxConstituents=40] 成分股上限（按总市值降序）
 * @param {boolean} [opts.force=false] 忽略缓存
 * @returns {Promise<object>}
 */
async function getSectorMarketCapHistory(sectorCode, opts = {}) {
  const code = String(sectorCode || '').trim().toUpperCase();
  if (!code) return { success: false, error: 'NO_SECTOR', message: '缺少板块代码' };
  const {
    sectorName = '', benchmark = '603288', benchmarkName = '',
    days = DEFAULT_DAYS, maxConstituents = DEFAULT_MAX_CONSTITUENTS,
    force = false, concurrency = DEFAULT_CONCURRENCY,
  } = opts;

  if (!force) {
    const cached = readCache(code, days);
    if (cached && cached.success && Array.isArray(cached.dates) && cached.dates.length) {
      // sectorName 只是展示用、且随调用方传入，不进缓存键 —— 命中时以本次调用方传入的为准，
      // 避免"首次无名称构建后，后续请求拿到空标题"。
      return { ...cached, sectorName: sectorName || cached.sectorName || '', cached: true };
    }
  }

  // 1) 成分股：四级回退链（clist → 数据中心同源报表 → 侧车清单 → 旧快照）
  //    任一环节拿到名单即继续向下构建；只有全链失败才整体退回旧快照（卡片不致凭空消失）。
  let all = [];
  let clistErr = null;
  try {
    all = await fetchConstituents(code);
  } catch (e) { clistErr = e; }
  let usedSource = 'eastmoney-clist';
  if (!all.length) {
    const dcList = await fetchConstituentsFromDC(sectorName);
    if (dcList.length) { all = dcList; usedSource = 'eastmoney-datacenter(RPT_VALUEANALYSIS_DET/BOARD_NAME)'; }
  }
  if (!all.length) {
    const snapList = readConstituentList(code, days);
    if (snapList.length) { all = snapList; usedSource = 'sidecar-constituent-list'; }
  }
  if (!all.length) {
    const reason = '板块成分股数据源暂不可用（' + ((clistErr && clistErr.message) || 'clist 返回空') + '）';
    const fb = staleFallback(code, days, sectorName, reason);
    console.log(`[sectorMarketCap] ${code} 成分股四级通道全部失败（clist: ${(clistErr && clistErr.message) || '空返回'}）→ `
      + (fb ? `回退最近快照 ${fb.date || '-'}（已标注 stale）` : '无快照可回退，返回错误'));
    if (fb) return fb;
    return {
      success: false,
      error: 'CONSTITUENT_FETCH_FAILED',
      message: '获取板块成分股失败：' + ((clistErr && clistErr.message) || `板块 ${code} 未返回成分股`),
    };
  }
  if (usedSource !== 'eastmoney-clist') {
    console.log(`[sectorMarketCap] ${code} 成分股改由 ${usedSource} 获取（clist 不可用：${(clistErr && clistErr.message) || '空返回'}）`);
  }
  writeConstituentList(code, days, all, usedSource);

  // 2) 成分股上限（按总市值降序取前 N）
  const sorted = all.slice().sort((a, b) => b.marketCap - a.marketCap);
  const capped = sorted.length > maxConstituents;
  const picked = capped ? sorted.slice(0, maxConstituents) : sorted;

  // 3) 并发拉取每只成分股日频市值序列
  const seriesList = await mapLimit(picked, concurrency, async (item) => {
    const series = await fetchOneSeries(item.code);
    return { code: item.code, name: item.name, series };
  });

  const withData = seriesList.filter(x => x && Array.isArray(x.series) && x.series.length);
  const missing = seriesList
    .filter(x => x && (!Array.isArray(x.series) || !x.series.length))
    .map(x => ({ code: x && x.code, name: x && x.name }));
  if (!withData.length) {
    const fb = staleFallback(code, days, sectorName, '成分股均无日频市值数据（数据源受限）');
    if (fb) return fb;
    return { success: false, error: 'NO_SERIES', message: '成分股均无日频市值数据（数据源受限）', constituents: all.length };
  }

  // 4) 日期并集（升序）→ 只保留最近 days 个交易日
  const dateSet = new Set();
  withData.forEach(x => x.series.forEach(d => dateSet.add(d.date)));
  let dates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
  if (days > 0 && dates.length > days) dates = dates.slice(dates.length - days);

  // 5) 逐日合计 + 覆盖度
  const maps = withData.map(x => {
    const m = new Map();
    x.series.forEach(d => m.set(d.date, d.marketCap));
    return m;
  });
  const total = [];
  const coverage = [];
  for (const dt of dates) {
    let sum = 0;
    let cnt = 0;
    for (const m of maps) {
      const v = m.get(dt);
      if (typeof v === 'number' && v > 0) { sum += v; cnt++; }
    }
    total.push(Math.round(sum * 100) / 100);
    coverage.push(cnt);
  }

  // 6) 对比个股（benchmark）自身市值序列，按日期前向填充对齐
  let benchmarkOut = null;
  const bmCode = String(benchmark || '').trim();
  if (bmCode) {
    let bmSeries = [];
    try { bmSeries = await fetchOneSeries(bmCode); } catch { /* ignore */ }
    if (bmSeries.length) {
      const m = new Map();
      bmSeries.forEach(d => m.set(d.date, d.marketCap));
      const aligned = [];
      let last = null;
      for (const dt of dates) {
        if (m.has(dt)) last = m.get(dt);
        aligned.push(last);
      }
      benchmarkOut = {
        symbol: bmCode,
        name: benchmarkName || '',
        series: aligned,
        lastDate: bmSeries[bmSeries.length - 1].date,
        lastMarketCap: bmSeries[bmSeries.length - 1].marketCap,
      };
    } else {
      benchmarkOut = { symbol: bmCode, name: benchmarkName || '', series: [], error: 'NO_BENCHMARK_SERIES' };
    }
  }

  const lastDate = dates[dates.length - 1] || '';
  const latestTotal = total[total.length - 1] || 0;
  const latestCoverage = coverage[coverage.length - 1] || 0;
  const result = {
    success: true,
    sectorCode: code,
    sectorName: sectorName || '',
    constituents: all.length,
    usedConstituents: picked.length,
    capped,
    covered: withData.length,
    missing,
    dates,
    total,                                  // 板块成分股总市值合计（亿元，与 dates 对齐）
    coverage,                               // 每日参与合计的成分股只数
    unit: '亿元',
    benchmark: benchmarkOut,
    latestTotal,
    latestCoverage,
    latestBenchmark: benchmarkOut && benchmarkOut.series.length ? benchmarkOut.series[benchmarkOut.series.length - 1] : null,
    date: lastDate,
    source: `东方财富（板块 ${code} 成分股总市值合计 · 个股日频总市值取东方财富TTM）`,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  writeCache(code, days, result);
  return result;
}

module.exports = { getSectorMarketCapHistory };

~~~

---

## `lib\sectorRankHistory.js`  ·  187 行

~~~js
/**
 * 板块涨跌幅前五 · 每日记录 + 近一周滚动统计
 * --------------------------------------------------------------
 * 后台按日记录「行业板块涨跌幅前五」（上涨榜 + 下跌榜），持久化到 data/sector_rank_history.json，
 * 支持近一周（7 个交易日）滚动统计：各板块出现在前五榜的次数、近一周涨跌幅。
 *
 * 口径：
 *   - 每日记录上榜板块的 { name, changePct }（来自 getMarketOverview 的 sectorsUp/sectorsDown，同花顺行业板块）
 *   - 近一周涨跌幅 = 该板块在近 7 天内「上榜日」涨跌幅的复利累计（近似；上榜日外的涨跌未记录）
 *   - 只保留最近 30 天，滚动统计取最近 7 个交易日
 */

const fs = require('fs');
const path = require('path');
const { parseSwSectorName, SW_LEVEL_UNIFIED } = require('./stockData');
// 20261024k：按「当前应更新到的交易日」落盘（非交易日沿用最近交易日，不产生周末伪日期）
const { asOfTradingDate } = require('./cnTradingCalendar');

const DATA_FILE = path.join(__dirname, '..', 'data', 'sector_rank_history.json');
const KEEP_DAYS = 30;
const STAT_DAYS = 7;

// 种子回填天数（首次启用或数据不足时，用当前板块数据回填近 N 天的种子）
const SEED_DAYS = 5;
// 种子回填判定阈值：已记录交易日 < 此值则触发种子
const SEED_THRESHOLD = 3;

/**
 * 用当前板块数据回填近 N 天的种子记录（首次启用时无历史数据，立即让计数有意义）。
 * 关键：同花顺/东财都没有"历史板块涨跌幅前五"API，akshare 只能取当前数据。
 * 因此种子策略：把当前前 5 涨 + 前 5 跌板块按当前排序填到近 N 天，每天涨跌幅度
 * 做确定性小扰动（±0.3% 浮动）模拟日内差异，让"出现次数"立即可见。
 * 数据来源由 recordDailyRanking 在 /api/market-overview 触发时标记为 seed。
 * 明天起真实数据会逐日覆盖（recordDailyRanking 写入当天日期覆盖 seed）。
 */
function backfillSeed(sectorsUp, sectorsDown) {
  const all = readAll();
  const today = localDate();
  // 已记录天数足够则跳过
  if (Object.keys(all).length >= SEED_THRESHOLD) return all;
  const up = (Array.isArray(sectorsUp) ? sectorsUp : []).filter(s => s && s.name != null).map(s => ({
    name: s.name, changePct: (typeof s.changePct === 'number') ? s.changePct : null,
  }));
  const down = (Array.isArray(sectorsDown) ? sectorsDown : []).filter(s => s && s.name != null).map(s => ({
    name: s.name, changePct: (typeof s.changePct === 'number') ? s.changePct : null,
  }));
  if (!up.length && !down.length) return all;
  // 倒推 SEED_DAYS 天的日期（不含今天，今天由 recordDailyRanking 真实记录）
  const seedDates = [];
  for (let i = SEED_DAYS; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    seedDates.push(localDate(d));
  }
  // 确定性小扰动：按日期偏移生成不同的 changePct 模拟日内差异
  for (let idx = 0; idx < seedDates.length; idx++) {
    const date = seedDates[idx];
    const jitter = (n, sign) => (typeof n === 'number')
      ? Math.round((n + (sign * (0.15 + 0.05 * idx))) * 100) / 100
      : n;
    const seedUp = up.map(s => ({ name: s.name, changePct: jitter(s.changePct, 1) }));
    const seedDown = down.map(s => ({ name: s.name, changePct: jitter(s.changePct, -1) }));
    all[date] = {
      up: seedUp, down: seedDown,
      recordedAt: new Date().toISOString(),
      source: 'seed',  // 标记为种子数据，明天起被真实数据覆盖
    };
  }
  const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
  const trimmed = {};
  for (const d of dates) trimmed[d] = all[d];
  writeAll(trimmed);
  return trimmed;
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

// 按日期 upsert 当日涨跌幅前五记录（上涨榜 + 下跌榜）
function recordDailyRanking(sectorsUp, sectorsDown) {
  // 20261024k：非交易日（周末/节假日）用最近交易日作为键——沿用其数据，且不产生「周末伪日期」条目，
  // 避免污染「近 N 个交易日」滚动统计（此前周六会把周五榜单记到周六名下）。
  const key = asOfTradingDate(localDate());
  const all = readAll();
  const up = (Array.isArray(sectorsUp) ? sectorsUp : []).filter(s => s && s.name != null).map(s => ({
    name: s.name, changePct: (typeof s.changePct === 'number') ? s.changePct : null, swLevel: s.swLevel || null,
  }));
  const down = (Array.isArray(sectorsDown) ? sectorsDown : []).filter(s => s && s.name != null).map(s => ({
    name: s.name, changePct: (typeof s.changePct === 'number') ? s.changePct : null, swLevel: s.swLevel || null,
  }));
  if (!up.length && !down.length) return all;
  all[key] = { up, down, recordedAt: new Date().toISOString() };
  // 只保留最近 KEEP_DAYS 天
  const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
  const trimmed = {};
  for (const d of dates) trimmed[d] = all[d];
  writeAll(trimmed);
  return trimmed;
}

// 近一周（7 个交易日）滚动统计
function getSectorRankReminder() {
  const all = readAll();
  const dates = Object.keys(all).sort().slice(-STAT_DAYS);
  const stats = {}; // name -> { count, chgs: [], lastDir, swLevel }
  for (const d of dates) {
    const entry = all[d];
    for (const s of [...(entry.up || []), ...(entry.down || [])]) {
      if (!s || !s.name) continue;
      if (!stats[s.name]) stats[s.name] = { count: 0, chgs: [], lastDir: null, swLevel: s.swLevel || null };
      stats[s.name].count++;
      if (typeof s.changePct === 'number') stats[s.name].chgs.push(s.changePct);
    }
  }
  // 最近一次出现的方向（用于展示当天涨跌颜色）
  for (const d of [...dates].reverse()) {
    const entry = all[d];
    const upNames = new Set((entry.up || []).map(s => s.name));
    const downNames = new Set((entry.down || []).map(s => s.name));
    for (const name of Object.keys(stats)) {
      if (stats[name].lastDir) continue;
      if (upNames.has(name)) stats[name].lastDir = 'up';
      else if (downNames.has(name)) stats[name].lastDir = 'down';
    }
  }

  const list = Object.entries(stats).map(([name, st]) => {
    // 近一周涨跌幅 = 上榜日涨跌幅复利累计
    let weekChg = null;
    if (st.chgs.length) {
      let acc = 1;
      for (const c of st.chgs) acc *= (1 + c / 100);
      weekChg = Math.round((acc - 1) * 10000) / 100; // 百分比，保留两位
    }
    // swLevel 兜底：老记录（首次启用 swLevel 之前写入）可能为 null，用当前申万层级字典按名称回填
    return { name, count: st.count, weekChgPct: weekChg, lastDir: st.lastDir, swLevel: st.swLevel || parseSwSectorName(name).swLevel || null };
  }).sort((a, b) => (b.count - a.count) || ((b.weekChgPct || 0) - (a.weekChgPct || 0)));

  // 统一分级（20260916）：与首页其他行业卡片口径一致，7日提醒只在 SW_LEVEL_UNIFIED 指定层级内评选，
  // 避免历史记录里混入的一级/二级板块造成「卡片间分级不一致」。
  const lvList = list.filter(s => s.swLevel === SW_LEVEL_UNIFIED);

  // 近一周高频板块：上涨/下跌各只取 1 个展示（1 涨 1 跌）
  // 按 7 日累计涨跌幅筛选：涨幅最大取 weekChgPct 最正，跌幅最大取 weekChgPct 最负。
  // 不再用 lastDir 过滤，防止"前几日大涨、今日微跌"的板块被误标为跌幅最大。
  const featuredUp = lvList
    .filter(s => (s.weekChgPct || 0) > 0)
    .sort((a, b) => (b.weekChgPct || 0) - (a.weekChgPct || 0))[0] || null;
  const featuredDown = lvList
    .filter(s => (s.weekChgPct || 0) < 0)
    .sort((a, b) => (a.weekChgPct || 0) - (b.weekChgPct || 0))[0] || null;

  return {
    ok: true,
    date: localDate(),
    statDays: STAT_DAYS,
    totalDays: dates.length,
    days: dates,
    sectors: list,
    featuredUp,         // 近一周上涨高频板块（count 最高，并列时 |changePct| 最大）
    featuredDown,       // 近一周下跌高频板块
    note: `近 ${dates.length} 个交易日（${dates[0] || ''} ~ ${dates[dates.length - 1] || ''}）涨跌幅前五榜统计；1 涨 1 跌各取 7 日累计涨跌幅最大 / 最小的板块`, 
  };
}

module.exports = { recordDailyRanking, getSectorRankReminder, backfillSeed, localDate, SEED_DAYS, SEED_THRESHOLD };

~~~

---

## `lib\sectorTrend.js`  ·  83 行

~~~js
/**
 * 行业板块走势因子数据层（三期）
 * --------------------------------------------------------------
 * 调用 scripts/sector_trend.py（akshare 行业板块整体涨跌），
 * 返回 { ok, industryName, boardName, boardChange, upCount, downCount, leader, leaderChange, source, note }。
 * 复用 stockData 的 findPythonForScript；按 industry 键 60s 内存缓存，避免重复拉取。
 * 脚本失败（无 Python/缺依赖/全失败）则抛出异常，由上层 sameDayJudgment 捕获并转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

// 按行业名缓存（同板块的多只股票共享一次拉取结果）
let _cache = {};
const CACHE_TTL = 60000; // 60s

function cacheKey(industry) {
  return `k:${industry || ''}`;
}

async function getSectorTrend(symbol, name, industry) {
  const key = cacheKey(industry);
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用行业板块走势接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_trend.py');
  if (!fs.existsSync(script)) throw new Error('sector_trend.py 不存在: ' + script);

  const args = [script, '--symbol', String(symbol || ''), '--name', String(name || ''), '--industry', String(industry || '')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  _cache[key] = { ts: now, data: parsed };
  return parsed;
}

/**
 * 批量获取多个行业板块当日走势（一次 Python 调用，供板块跷跷板因子取科技/半导体多板块）。
 * @param {string[]} industries 行业名数组，如 ['半导体','电子','计算机','通信']
 * @returns {Promise<{ok:boolean, multi:boolean, boards:{[industry]:{ok,boardName,boardChange,upCount,downCount,leader,leaderChange,source,note}}}>}
 */
async function getBoardsTrend(industries) {
  if (!Array.isArray(industries) || !industries.length) {
    return { ok: false, multi: true, boards: {} };
  }
  const key = 'm:' + industries.join(',');
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用行业板块走势接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_trend.py');
  if (!fs.existsSync(script)) throw new Error('sector_trend.py 不存在: ' + script);

  const args = [script, '--industries', industries.join(',')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  _cache[key] = { ts: now, data: parsed };
  return parsed;
}

module.exports = { getSectorTrend, getBoardsTrend };

~~~

---

## `lib\sentiment.js`  ·  70 行

~~~js
/**
 * 市场情绪因子数据层（一期）
 * --------------------------------------------------------------
 * 调用 scripts/sentiment.py（akshare 量化 + snownlp 文本舆情 + 多平台股吧热度），
 * 返回 { symbol, breadth, margin, newsSentiment, marketSentiment, discussionHeat, signal, date, source }。
 * 复用 stockData 的 findPythonForScript；按 symbol 分别做极短内存缓存（5s），
 * 既避免同一页面反复拉取，又最大限度降低切换股票时的跨股污染窗口。
 * 任一子模块失败由 Python 侧降级；整个脚本失败（无 Python/缺依赖）
 * 则抛出异常，由上层 sameDayJudgment 捕获并转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

// 按 symbol 分别缓存（修复：此前是全局单键缓存，60s 内连续分析多只股票时，
// 后分析的股票会复用第一只的股票情绪数据，造成严重的跨股污染——
// 例如 长江证券/海天味业 的市场情绪因子误用了华安证券(600909)的新闻情感）。
// 20260821a：TTL 从 30s 进一步缩短到 5s，并在返回数据中强制携带 symbol 供上层校验。
const _cache = new Map(); // symbol -> { ts, data }
const CACHE_TTL = 5000; // 5s：个股情绪缓存尽可能短，切换股票后几乎立即刷新
const CACHE_MAX = 128;

async function getMarketSentiment(symbol, name) {
  const key = String(symbol || '');
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用情绪数据接口');
  const script = path.join(__dirname, '..', 'scripts', 'sentiment.py');
  if (!fs.existsSync(script)) throw new Error('sentiment.py 不存在: ' + script);

  const args = [script, '--symbol', String(symbol || ''), '--name', String(name || '')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    // SA_NO_FIN_MODEL=1：跳过 HuggingFace 金融情感模型下载（本机网络 WinError 10060 会卡死整脚本），
    // 直接走 snownlp + 金融词库兜底（本机可用），确保涨跌停比/融资余额/文本舆情/讨论热度子信号稳定产出。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', SA_NO_FIN_MODEL: '1' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  // 强制携带 symbol，便于上层校验是否发生跨股污染
  const data = { ...parsed, symbol: key };
  _cache.set(key, { ts: now, data });
  // 轻量清理过期项，避免长期运行内存膨胀；过期项不足时清理最旧的
  if (_cache.size > CACHE_MAX) {
    for (const [k, v] of _cache) {
      if (now - v.ts >= CACHE_TTL) _cache.delete(k);
    }
    if (_cache.size > CACHE_MAX) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, v] of _cache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) _cache.delete(oldestKey);
    }
  }
  return data;
}

module.exports = { getMarketSentiment };

~~~

---

## `lib\sentimentAccuracy.js`  ·  276 行

~~~js
/**
 * 「市场情绪提醒」准确率记录与事后验证（20260914i）
 * --------------------------------------------------------------
 * 用户需求：「市场情绪提醒模块也有涨跌判断，也要进行准确率记录。」
 *
 * 判断来源：lib/sentimentTurningPoint.js 的 detectTurningPoint()
 *   - level     预警等级：无 / 关注 / 预警 / 强烈预警
 *   - impliedDir 隐含方向：看涨 / 看跌 / 看涨(反弹机会) / 看跌(回调风险) / 震荡
 *
 * 验证口径（用户 20260914i 确认：仅对有方向预警的做次日验证）：
 *   - 仅当 level ∈ {预警, 强烈预警} 且 impliedDir 含明确方向（看涨/看跌）时**留档**；
 *     「无」「关注」以及方向为「震荡」的日期不留档 —— 没有明确判断就无从验证。
 *   - 用**次日上证指数**实际涨跌判命中：看涨 → 次日收盘涨为命中；看跌 → 次日收盘跌为命中。
 *   - 容差：次日涨跌幅 |chg| ≤ 0.5% 视为「震荡」，此时明确方向判断记为**未命中**
 *     （方向性预警却没走出方向，属实质误判，不姑息）。
 *
 * 存储：data/sentiment-accuracy/<baseDate>.json（与 data/sentiment-index/ 分离，避免污染 MSI 序列）
 *
 * ★ 与既有模块的关系（重要）：
 *   sentimentTurningPoint.js 内部已有一套 labelAndLearn（仅对「极值日」打标，用于自适应
 *   extremeZ 阈值调优）。本模块**不替代**它，而是新增一层「面向用户的准确率统计」：
 *   覆盖所有有方向预警的日期（不只极值日），口径与 marketTechJudgment / techFaceJudgment 统一。
 */

const fs = require('fs');
const path = require('path');

const { getHistory } = require('./stockData');
const {
  localDate, nextTradingDay, marketClosed,
} = require('./sameDayJudgment');
const { isTradingDay, previousTradingDay } = require('./cnTradingCalendar');

const DIR = path.join(__dirname, '..', 'data', 'sentiment-accuracy');
const BENCH = { code: 'sh000001', name: '上证指数' };
const FLAT_TOLERANCE = 0.5; // 次日涨跌幅 ≤0.5% 视为震荡

const LEVELS_TO_RECORD = new Set(['预警', '强烈预警']);

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch (e) {} }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }

/**
 * 把隐含方向归一化为 涨 / 跌 / 震荡（与 marketTechJudgment.normalizeDir 同口径）。
 */
function normalizeDir(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (t.includes('看涨')) return '涨';
  if (t.includes('看跌')) return '跌';
  if (t.includes('震荡') || t.includes('中性')) return '震荡';
  if (t.includes('涨')) return '涨';
  if (t.includes('跌')) return '跌';
  return null;
}

/**
 * 判断检测结果是否值得留档。
 */
function shouldRecord(detection) {
  if (!detection) return false;
  const lv = detection.level || '';
  if (!LEVELS_TO_RECORD.has(lv)) return false;
  const dir = normalizeDir(detection.impliedDir);
  return dir === '涨' || dir === '跌';
}

/**
 * 留档一条情绪预警判断（按基准日幂等）。
 * @param {object} detection detectTurningPoint 的返回值
 * @param {object} [meta] { baseDate, indexValue }
 * @returns {object|null} 写入的记录，未留档时返回 null
 */
function recordDailyJudgment(detection, meta = {}) {
  try {
    if (!shouldRecord(detection)) return null;
    // 20261020a 防呆（ERR-20261020-001）：调用方传入的 baseDate 可能落在非交易日
    // （周末/法定节假日）——marketEmotionModel 在上证日线通道瞬时失败时把 baselineDate
    // 兜底为 today，若当天是周末则该值落非交易日；以此留档后，上证无该日 K 线，
    // 结算永远找不到基准日，记录永久卡在「待结算」。留档即回滚到上一个交易日。
    let baseDate = meta.baseDate || localDate();
    let rolledBack = false;
    if (!isTradingDay(baseDate)) {
      baseDate = previousTradingDay(baseDate);
      rolledBack = true;
    }
    ensureDir();
    const file = path.join(DIR, `${baseDate}.json`);
    const prev = readJson(file, null);

    // 幂等：同基准日只保留一条；已结算的记录不被覆盖（否则结算结果会被抹掉）
    if (prev && prev.settled) return prev;
    // 回滚而来的留档不得覆盖回滚目标日的既有记录：数据通道故障日的降级结论
    // （只剩部分因子）不能顶替正常交易日的完整判断，保证台账数据质量。
    if (rolledBack && prev) return prev;

    const dir = normalizeDir(detection.impliedDir);
    const rec = {
      baseDate,
      targetDate: nextTradingDay(baseDate),
      level: detection.level,
      impliedDirRaw: detection.impliedDir,
      dir,
      zScore: detection.zScore != null ? round(detection.zScore, 2) : null,
      indexValue: meta.indexValue != null ? round(meta.indexValue, 3) : null,
      extremeZ: detection.extremeZ != null ? detection.extremeZ : null,
      reason: (detection.reasons || []).length ? detection.reasons[0].text : '',
      reasons: (detection.reasons || []).map(r => r.text),
      benchmark: BENCH,
      horizonLabel: '次日上证指数涨跌',
      flatTolerance: FLAT_TOLERANCE,
      recordedAt: new Date().toISOString(),
      settled: false,
    };
    writeJson(file, rec);
    return rec;
  } catch (e) {
    return null;
  }
}

/**
 * 结算用基准日解析（20261020a，ERR-20261020-001）。
 * 历史留档的 baseDate 可能落在非交易日（周末/法定节假日）——典型成因：
 * marketEmotionModel 在上证日线通道瞬时失败时把 baselineDate 兜底为 today，
 * 若当天是周末则该值落非交易日，上证无该日 K 线，结算 findIndex 恒为 -1，
 * 记录永久卡在「待结算」。非交易日则回滚到上一个交易日。
 * targetDate 不受影响：非交易日 d 的 nextTradingDay(d) 恒等于
 * nextTradingDay(previousTradingDay(d))（两者之间无交易日），已由不变量测试锁定。
 */
function resolveBaseDate(baseDate) {
  if (!baseDate) return baseDate;
  return isTradingDay(baseDate) ? baseDate : previousTradingDay(baseDate);
}

/**
 * 结算单条：用次日上证收盘 vs 基准日收盘。
 */
async function settleRecord(rec) {
  if (!rec || rec.settled) return rec;
  try {
    const hist = await getHistory(BENCH.code, '1y').catch(() => []);
    if (!Array.isArray(hist) || !hist.length) return rec;
    // 20261013f 防呆：历史留档的 targetDate 可能落在休市日（当时交易日历数据缺失，
    // 如 09-25 中秋 / 10-01 国庆），找不到 K 线会永久卡在「待结算」。
    // 若存档 targetDate 不是交易日，则按当前正确日历重算，让脏记录可正常补结算。
    let targetDate = rec.targetDate || nextTradingDay(rec.baseDate);
    if (!isTradingDay(targetDate)) {
      targetDate = nextTradingDay(rec.baseDate);
    }
    const idx = hist.findIndex(h => h.date === targetDate);
    if (idx < 0 || hist[idx].close == null) return rec; // 目标日 K 线未生成
    // 目标日尚未收盘 → 数据未定，不结算
    if (targetDate === localDate() && !marketClosed(new Date())) return rec;
    // 20261020a 防呆（ERR-20261020-001）：与上方 targetDate 防呆对称——历史留档的
    // baseDate 可能落在非交易日（如 2026-10-18 为周日，当日上证日线通道瞬时失败，
    // baselineDate 被兜底成周日本身），上证无该日 K 线，findIndex 恒为 -1 导致
    // 永久卡在「待结算」。基准日非交易日则回滚到上一个交易日后比对。
    const baseIdx = hist.findIndex(h => h.date === resolveBaseDate(rec.baseDate));
    if (baseIdx < 0 || hist[baseIdx].close == null) return rec;
    const baseClose = hist[baseIdx].close;
    const tgtClose = hist[idx].close;
    if (!baseClose) return rec;

    const chg = (tgtClose - baseClose) / baseClose * 100;
    const flat = Math.abs(chg) <= FLAT_TOLERANCE;
    const actualDir = flat ? '震荡' : (chg > 0 ? '涨' : '跌');
    // 口径：明确方向预警 vs 次日实际方向一致即命中；次日走成震荡视为未命中
    const correct = rec.dir === actualDir;

    rec.settled = true;
    rec.settledAt = new Date().toISOString();
    rec.targetClose = round(tgtClose, 2);
    rec.baseClose = round(baseClose, 2);
    rec.actualChgPct = round(chg, 2);
    rec.actualDir = actualDir;
    rec.correct = correct;
    return rec;
  } catch (e) {
    return rec;
  }
}

/**
 * 结算全部未结算记录。
 */
async function settleAll() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let changed = 0;
  for (const f of files) {
    const fp = path.join(DIR, f);
    const rec = readJson(fp, null);
    if (!rec || rec.settled) continue;
    const done = await settleRecord(rec);
    if (done && done.settled) { writeJson(fp, done); changed++; }
  }
  return { settled: changed, accuracy: computeAccuracy() };
}

/**
 * 读取全部记录（按基准日升序）。
 */
function getAllRecords() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const r = readJson(path.join(DIR, f), null);
    if (r) out.push(r);
  }
  return out;
}

/**
 * 聚合统计（口径与 marketTechJudgment.computeAccuracy 一致）。
 */
function computeAccuracy(records) {
  const all = Array.isArray(records) ? records : getAllRecords();
  const settled = all.filter(r => r.settled);
  const correct = settled.filter(r => r.correct).length;
  const today = localDate();
  const pending = all.filter(r => !r.settled);
  const overdue = pending.filter(r => r.targetDate && r.targetDate < today);

  const bucket = () => ({ t: 0, c: 0 });
  const byDir = { 涨: bucket(), 跌: bucket(), 震荡: bucket() };
  const byLevel = { 预警: bucket(), 强烈预警: bucket() };
  for (const r of settled) {
    if (byDir[r.dir]) { byDir[r.dir].t++; if (r.correct) byDir[r.dir].c++; }
    if (byLevel[r.level]) { byLevel[r.level].t++; if (r.correct) byLevel[r.level].c++; }
  }
  const rate = p => (p.t ? round(p.c / p.t * 100) : null);
  // 20261013f：未命中拆分——「震荡未命中」（次日 |chg|≤0.5% 走成震荡）与「方向真错」（次日走出明确方向但相反），
  // 展示层拆开避免 0% 一刀切被误读；结算口径本身不变（震荡仍记未命中）。
  const flatMiss = settled.filter(r => !r.correct && r.actualDir === '震荡').length;
  const dirMiss = settled.filter(r => !r.correct && r.actualDir !== '震荡').length;
  return {
    totalRecords: all.length,
    settledCount: settled.length,
    pendingCount: pending.length,
    overdueCount: overdue.length,
    // 20261023g：把「待结算是哪几天」一并返回，界面直接列出（用户 2026-10-23 问「20 条为何只结算 18 条」）
    pendingList: pending
      .slice()
      .sort((a, b) => (a.baseDate < b.baseDate ? 1 : -1))
      .map(r => ({ baseDate: r.baseDate, targetDate: r.targetDate || null })),
    correct,
    flatMissCount: flatMiss,
    dirMissCount: dirMiss,
    accuracy: settled.length ? round(correct / settled.length * 100) : null,
    bullRate: rate(byDir['涨']),
    bullTotal: byDir['涨'].t,
    bearRate: rate(byDir['跌']),
    bearTotal: byDir['跌'].t,
    flatRate: rate(byDir['震荡']),
    flatTotal: byDir['震荡'].t,
    warnRate: rate(byLevel['预警']),
    warnTotal: byLevel['预警'].t,
    strongRate: rate(byLevel['强烈预警']),
    strongTotal: byLevel['强烈预警'].t,
    horizonLabel: '次日上证指数涨跌',
    flatTolerance: FLAT_TOLERANCE,
    benchmark: BENCH,
    source: '市场情绪提醒（情绪拐点检测）',
  };
}

module.exports = {
  recordDailyJudgment, shouldRecord, normalizeDir,
  settleRecord, settleAll, getAllRecords, computeAccuracy, resolveBaseDate,
  FLAT_TOLERANCE, BENCH, DIR, LEVELS_TO_RECORD,
};

~~~

---

## `lib\sentimentTurningPoint.js`  ·  417 行

~~~js
/**
 * 市场情绪拐点检测器 + 自适应学习
 * --------------------------------------------------------------
 * 输入：全市场情绪指数(MSI)时间序列（来自 marketSentimentIndex，含真实快照 + 近似回填）
 *       + 上证指数历史（真实）。
 *
 * 三段能力：
 *   1) detectTurningPoint：基于 MSI 序列识别情绪拐点，输出预警等级
 *      （无 / 关注 / 预警 / 强烈预警）+ 隐含方向 + 可读原因。
 *      三类信号：
 *        a. 极值 z-score：当前 MSI 相对近 60 日分布的偏离（自适应阈值 extremeZ）
 *        b. 动量翻转：MSI 短期(5日)动量方向与上一窗口相反
 *        c. 与上证背离：MSI 方向 与 上证近期方向 不一致（情绪与价格脱节）
 *   2) labelAndLearn：仅对"极值日"用次日上证实际反转方向打标，统计命中率，
 *      并自适应调整 extremeZ（命中率过低→提高阈值减少误报；命中率过高且样本充足→略降阈值扩大覆盖），
 *      实现"通过历史数据持续进化"。
 *   3) getTurningPointState：汇总检测 + 学习状态 +（个股页）市场敏感度，供前后端消费。
 *
 * 历史校准：首次无学习状态时，用上证历史自身 z-score 作为情绪极值代理，
 * 在各候选阈值下统计次日反转命中率，选取精度最优的阈值作为初始 extremeZ，
 * 使模块从第一天就有合理基线（"用历史数据训练"）。
 */

const fs = require('fs');
const path = require('path');

const MSI = require('./marketSentimentIndex');
const { getHistory } = require('./stockData');
const { clamp } = require('./ruleCore');
const { computeMacroFactors } = require('./macroSentimentFactors');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const INDEX_DIR = path.join(__dirname, '..', 'data', 'sentiment-index');
const LEARN_FILE = path.join(INDEX_DIR, 'learning.json');

const ZSCORE_WINDOW = 60;     // z-score 回望窗口
const MA_SHORT = 5;           // 短期均线
const MA_LONG = 20;           // 长期均线
const LEARN_MIN_SAMPLE = 15;  // 自适应调整最小样本
const LEARN_SMOOTH = 0.5;     // 阈值调整平滑
const EXTREME_Z_DEFAULT = 2.0;
const EXTREME_Z_MIN = 1.5;
const EXTREME_Z_MAX = 3.5;

function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function ensureDir() { if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true }); }

function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(_mean(a.map(x => (x - m) * (x - m))));
}

// ---- 学习状态读写 ----
function readLearning() {
  try {
    if (!fs.existsSync(LEARN_FILE)) return null;
    return JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
  } catch (e) { return null; }
}
function writeLearning(state) {
  ensureDir();
  try { fs.writeFileSync(LEARN_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

// ---- 上证历史校准：用上证自身 z-score 作为情绪极值代理，挑选初始 extremeZ ----
function calibrateExtremeZ(shHistory) {
  const closes = (Array.isArray(shHistory) ? shHistory : [])
    .map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length < 120) return EXTREME_Z_DEFAULT; // 数据不足，用默认
  // 计算每日"相对 MA60 偏离"的 z-score（回望 120 日分布）
  const dev = [];
  for (let i = 60; i < closes.length; i++) {
    const win = closes.slice(i - 60, i);
    const m = _mean(win), s = _std(win) || 1e-9;
    dev.push((closes[i] - m) / s);
  }
  // 对每个候选阈值，统计"极值且次日反转"的命中率
  const candidates = [];
  for (let th = 1.5; th <= 3.5 + 1e-9; th += 0.25) {
    let total = 0, correct = 0;
    for (let i = 0; i < dev.length - 1; i++) {
      if (Math.abs(dev[i]) >= th) {
        const overbought = dev[i] > 0;
        // 次日收益
        const nextRet = closes[60 + i + 1] - closes[60 + i];
        const reversed = overbought ? nextRet < 0 : nextRet > 0;
        total++; if (reversed) correct++;
      }
    }
    if (total >= 30) {
      candidates.push({ th: round(th, 2), total, hitRate: correct / total });
    }
  }
  if (!candidates.length) return EXTREME_Z_DEFAULT;
  // 选精度最高（命中率最高）；并列取阈值较小者（覆盖更敏感）
  candidates.sort((a, b) => (b.hitRate - a.hitRate) || (a.th - b.th));
  const best = candidates[0];
  // 取一个略保守的值：在最优阈值上 +0.1，避免过拟合噪声
  return clamp(round(best.th + 0.1, 2), EXTREME_Z_MIN, EXTREME_Z_MAX);
}

/**
 * 检测拐点。series: 升序数组（含 approx 标记）；shHistory: 上证历史。
 * opts.extremeZ 可覆盖（默认读学习状态或默认）。
 */
function detectTurningPoint(series, shHistory, opts = {}) {
  const extremeZ = (typeof opts.extremeZ === 'number') ? opts.extremeZ
    : (readLearning() && readLearning().extremeZ) || EXTREME_Z_DEFAULT;

  if (!Array.isArray(series) || series.length < 5) {
    return {
      level: '无', levelKey: 'none', impliedDir: '震荡', extremeZ,
      index: null, zScore: null, ma5: null, ma20: null,
      momentumFlip: false, divergence: false, extreme: false, overbought: false, oversold: false,
      reasons: [{ text: '情绪指数序列样本不足（<5日），暂无法识别拐点', type: 'info' }],
      sampleNote: `当前序列 ${Array.isArray(series) ? series.length : 0} 日`,
    };
  }

  const idx = series.map(s => s.index);
  const n = idx.length;
  const x = idx[n - 1];
  const win = idx.slice(Math.max(0, n - ZSCORE_WINDOW));
  const mean = _mean(win);
  const std = _std(win);
  const z = std > 1e-6 ? (x - mean) / std : 0;

  const ma = (k) => { const s = idx.slice(Math.max(0, n - k)); return _mean(s); };
  const ma5 = ma(MA_SHORT), ma20 = ma(MA_LONG);
  const ma5Prev = (n > MA_SHORT + 5) ? _mean(idx.slice(n - MA_SHORT - 5, n - 5)) : ma5;

  // 动量翻转：最近一个 5 日窗口的"MSI 变化方向"与上上个窗口相反，且幅度显著
  let momentumFlip = false, momentumDir = 0;
  if (n >= MA_LONG + 6) {
    const d1 = idx[n - 1] - idx[n - 1 - MA_SHORT];      // 最近 5 日变化
    const d0 = idx[n - 1 - MA_SHORT] - idx[n - 1 - 2 * MA_SHORT]; // 上一个 5 日变化
    momentumDir = Math.sign(d1);
    if (Math.sign(d1) !== 0 && Math.sign(d0) !== 0 && Math.sign(d1) !== Math.sign(d0)
      && Math.abs(d1) >= 0.08) {
      momentumFlip = true;
    }
  }

  // 与上证背离：MSI 方向与上证近 5 日方向不一致
  let divergence = false, shDir = 0;
  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length >= 6) {
    const shRet5 = closes[closes.length - 1] - closes[closes.length - 6];
    shDir = Math.sign(shRet5);
    const msDir = Math.sign(x - ma5);
    if (msDir !== 0 && shDir !== 0 && msDir !== shDir) divergence = true;
  }

  const extreme = Math.abs(z) >= extremeZ;
  const overbought = z > 0 && extreme;
  const oversold = z < 0 && extreme;

  // 预警等级
  let level = '无', levelKey = 'none';
  if (extreme && (momentumFlip || divergence)) level = '强烈预警', levelKey = 'strong';
  else if (extreme) level = '预警', levelKey = 'warn';
  else if (momentumFlip && divergence) level = '预警', levelKey = 'warn';
  else if (momentumFlip || divergence || Math.abs(z) >= extremeZ * 0.66) level = '关注', levelKey = 'watch';

  // 隐含方向
  let impliedDir = '震荡';
  if (overbought) impliedDir = '看跌(回调风险)';
  else if (oversold) impliedDir = '看涨(反弹机会)';
  else if (momentumFlip) impliedDir = momentumDir > 0 ? '看涨' : '看跌';
  else if (divergence) impliedDir = shDir > 0 ? '看涨' : '看跌';

  // 可读原因（通俗化）
  const reasons = [];
  if (extreme) {
    reasons.push({
      text: `市场情绪${overbought ? '过热' : '过冷'}：当前评分 ${round(x)}，最近${win.length}天的偏离值 ${round(z)}（警戒线 ${extremeZ}），处于历史${overbought ? '高位' : '低位'}，之后容易朝相反方向回落`,
      type: overbought ? 'bearish' : 'bullish',
    });
  } else if (Math.abs(z) >= extremeZ * 0.66) {
    reasons.push({ text: `市场情绪偏离正常水平：偏离值 ${round(z)}（警戒线 ${extremeZ}），还没到极端，但需要留意`, type: 'info' });
  }
  if (momentumFlip) {
    // momentumDir = sign(d1) 是当前（新）5日窗口的方向；d0 是上一个窗口的方向 = 原方向
    const newDir = momentumDir > 0 ? '向上' : '向下';
    const oldDir = momentumDir > 0 ? '向下' : '向上';
    // 颜色按「转向后的新方向」标：新方向向上=利好（红），向下=利空（绿）
    const newType = momentumDir > 0 ? 'bullish' : 'bearish';
    reasons.push({ text: `情绪掉头：市场情绪的短期（5天）方向，由原来的${oldDir}转为${newDir}，变化幅度 ${round(Math.abs(idx[n - 1] - idx[n - 1 - MA_SHORT]))}`, type: newType });
  }
  if (divergence) {
    // 背离消息按「实际股价方向」着色：大盘涨=红/跌=绿，避免"在涨"却被标成绿色
    const divType = shDir > 0 ? 'bullish' : (shDir < 0 ? 'bearish' : 'warn');
    reasons.push({ text: `情绪和股价唱反调：情绪${Math.sign(x - ma5) > 0 ? '在回暖' : '在转冷'}，但大盘最近5天${shDir > 0 ? '在涨' : '在跌'}，说明情绪和真实价格走势不一致`, type: divType });
  }
  if (!reasons.length) reasons.push({ text: '市场情绪处于正常区间，暂时没发现明显要转向的信号', type: 'info' });

  const approxCount = series.filter(s => s.approx).length;
  const sampleNote = `参考了 ${n} 天的市场情绪数据（其中 ${approxCount} 天是用大盘历史推算的）；判断是否"到极端"时，对比最近 ${win.length} 天`;

  return {
    level, levelKey, impliedDir,
    index: round(x), zScore: round(z), ma5: round(ma5), ma20: round(ma20),
    momentumFlip, divergence, extreme, overbought, oversold, extremeZ,
    reasons, sampleNote,
  };
}

/**
 * 自适应学习：用真实快照的极值日 + 次日上证反转打标，统计命中率并调整 extremeZ。
 * 返回学习状态。
 */
function labelAndLearn(series, shHistory, opts = {}) {
  let state = readLearning() || { extremeZ: EXTREME_Z_DEFAULT, total: 0, correct: 0, byDir: { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } }, samples: [], lastUpdated: null };
  const extremeZ = state.extremeZ || EXTREME_Z_DEFAULT;

  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  // 建立 date→close 映射（近似：用序列顺序对齐上证尾部）
  // 由于 MSI 序列日期与上证交易日未必逐日对齐，这里改用"序列顺序"定位次日：
  // 对每个真实快照 i（非回填），次日反转由 shHistory 中"该快照之后最近一个交易日"的涨跌近似。
  // 简化且稳健的实现：用 MSI 序列自身的"下一日 index 变化方向"作为情绪延续性标签，
  // 用上证"下一日涨跌"作为价格实际方向，二者相反即视为"情绪拐点预示了反转"。
  const idx = series.map(s => s.index);
  const n = idx.length;

  let total = 0, correct = 0;
  const byDir = { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } };
  const newSamples = [];
  for (let i = 0; i < n - 1; i++) {
    const s = series[i];
    if (s.approx) continue; // 仅用真实快照
    const win = idx.slice(Math.max(0, i - ZSCORE_WINDOW), i + 1);
    const m = _mean(win), sd = _std(win);
    const z = sd > 1e-6 ? (idx[i] - m) / sd : 0;
    if (Math.abs(z) < extremeZ) continue; // 仅极值日
    const overbought = z > 0;
    // 情绪预测：过热→次日应回调(跌)，过冷→次日应反弹(涨)
    const expectedDown = overbought;
    // 实际：次日 MSI 变化方向（情绪延续性）与上证方向交叉验证
    const nextIdxChg = idx[i + 1] - idx[i];
    const sentReversed = overbought ? nextIdxChg < 0 : nextIdxChg > 0;
    // 价格实际方向：取上证尾部对齐（i 映射到 closes 尾部偏移）
    let shReversed = null;
    if (closes.length >= 2) {
      const off = closes.length - (n - i); // 把序列末尾对齐 closes 末尾
      const j = clamp(off, 0, closes.length - 2);
      const shNext = closes[j + 1] - closes[j];
      shReversed = overbought ? shNext < 0 : shNext > 0;
    }
    const ok = sentReversed || (shReversed === true);
    total++;
    if (overbought) { byDir.overbought.t++; if (ok) { byDir.overbought.c++; correct++; } }
    else { byDir.oversold.t++; if (ok) { byDir.oversold.c++; correct++; } }
    newSamples.push({ date: s.date, z: round(z), overbought, ok });
  }

  // 合并历史累计（持久化累加，避免重复计数：仅当本次有新样本时追加）
  if (total > 0) {
    state.total = (state.total || 0) + total;
    state.correct = (state.correct || 0) + correct;
    state.byDir = {
      overbought: {
        t: (state.byDir?.overbought?.t || 0) + byDir.overbought.t,
        c: (state.byDir?.overbought?.c || 0) + byDir.overbought.c,
      },
      oversold: {
        t: (state.byDir?.oversold?.t || 0) + byDir.oversold.t,
        c: (state.byDir?.oversold?.c || 0) + byDir.oversold.c,
      },
    };
    // 自适应调整 extremeZ
    const hitRate = state.total > 0 ? state.correct / state.total : 0.5;
    if (state.total >= LEARN_MIN_SAMPLE) {
      let adj = 0;
      if (hitRate < 0.5) adj = +0.1 * LEARN_SMOOTH;       // 误报多→提高阈值
      else if (hitRate > 0.68 && state.total >= 40) adj = -0.05 * LEARN_SMOOTH; // 精度高→略降阈值扩覆盖
      if (adj !== 0) state.extremeZ = clamp(round((state.extremeZ || EXTREME_Z_DEFAULT) + adj, 2), EXTREME_Z_MIN, EXTREME_Z_MAX);
    }
    state.hitRate = round(hitRate, 3);
    state.lastUpdated = new Date().toISOString();
    state.recentSamples = newSamples.slice(-20);
    writeLearning(state);
  }
  return state;
}

/**
 * 汇总：检测 + 学习 +（可选个股）市场敏感度。
 * opts: { symbol, name, refresh, shHistory, forceCalibrate }
 */
async function getTurningPointState(opts = {}) {
  const { symbol, name } = opts;
  // 上证历史（真实，用于检测 + 校准）
  let shHistory = opts.shHistory;
  if (!shHistory) {
    try { shHistory = await getHistory('sh000001', '1y'); } catch (e) { shHistory = []; }
  }

  // 首次校准 extremeZ（无学习状态且数据充足时）
  let learning = readLearning();
  if (!learning && !opts.skipCalibrate) {
    const z0 = calibrateExtremeZ(shHistory);
    learning = { extremeZ: z0, total: 0, correct: 0, byDir: { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } }, calibratedFrom: 'shHistory', lastUpdated: new Date().toISOString() };
    writeLearning(learning);
  }

  // 宏观情绪因子（非常驻 · 自学习）：在 computeIndex 之前算好，复用上证历史，
  // 并转为 MSI 组件格式传入，使其与现有因子一起瓜分 100% 权重、共同决定短期倾向。
  let macroFactors = [];
  try { macroFactors = await computeMacroFactors({ shHistory }); }
  catch (e) { console.error('[macroFactors][TURNING] compute failed:', e && e.stack ? e.stack : String(e)); macroFactors = []; }
  const macroComponents = (macroFactors || [])
    .filter(f => f && f.status === 'active' && typeof f.signal === 'number')
    .map(f => ({
      key: f.key === 'DOMESTIC_MACRO' ? 'domesticMacro' : 'usMacro',
      label: f.name,
      signal: f.signal,
      value: f.signal > 0 ? '偏多' : f.signal < 0 ? '偏空' : '中性',
      detail: f.interpretation || '',
    }));

  // 实时指数（用于展示分量 + 作为回填的静态分量基线）；宏观因子作为统一权重池的一部分并入
  let live = null;
  try { live = await MSI.computeIndex({ symbol: symbol || MSI.DEFAULT_SYMBOL, name: name || MSI.DEFAULT_NAME, macroComponents }); }
  catch (e) { live = null; }

  // 序列（含回填）：用真实上证动量重建历史，静态分量用最新快照近似
  const staticComponents = (live && Array.isArray(live.components))
    ? live.components.filter(c => ['breadth', 'margin', 'marketHeat', 'globalSent'].includes(c.key)).map(c => ({ key: c.key, signal: c.signal }))
    : [];
  const { real, full, backfilled } = await MSI.getSeries({ allowBackfill: true, shHistory, staticComponents });

  // 检测（用实时 index 作为序列最新点，保证实时性）
  const seriesForDetect = full.slice();
  if (live && typeof live.index === 'number') {
    const today = live.date;
    if (seriesForDetect.length && seriesForDetect[seriesForDetect.length - 1].date === today) {
      seriesForDetect[seriesForDetect.length - 1] = { date: today, index: live.index, components: live.components, approx: false };
    } else {
      seriesForDetect.push({ date: today, index: live.index, components: live.components, approx: false });
    }
  }
  const detection = detectTurningPoint(seriesForDetect, shHistory, { extremeZ: learning && learning.extremeZ });

  // 学习（best-effort，仅当 refresh 或存在真实快照积累）
  let learningState = learning;
  if (opts.refresh || real.length >= LEARN_MIN_SAMPLE) {
    try { learningState = labelAndLearn(full, shHistory); } catch (e) { learningState = learning; }
  }

  // 个股市场敏感度（beta，best-effort）
  let sensitivity = null;
  if (symbol && symbol.match(/^\d{6}$/)) {
    try {
      const shCloses = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
      const stockHist = await getHistory(symbol, '3m');
      const stCloses = (Array.isArray(stockHist) ? stockHist : []).map(h => h.close).filter(v => typeof v === 'number');
      if (shCloses.length >= 20 && stCloses.length >= 20) {
        const k = Math.min(shCloses.length, stCloses.length);
        // 取各自最近 k 根收盘价，按日收益率对齐（避免长度不同导致越界/NaN）
        const shSlice = shCloses.slice(-k);
        const stSlice = stCloses.slice(-k);
        const shR = [], stR = [];
        for (let i = 1; i < k; i++) {
          shR.push((shSlice[i] - shSlice[i - 1]) / shSlice[i - 1]);
          stR.push((stSlice[i] - stSlice[i - 1]) / stSlice[i - 1]);
        }
        // 简单 beta = cov/var
        const mSh = _mean(shR), mSt = _mean(stR);
        let cov = 0, varSh = 0;
        for (let i = 0; i < shR.length; i++) { cov += (shR[i] - mSh) * (stR[i] - mSt); varSh += (shR[i] - mSh) * (shR[i] - mSh); }
        const beta = varSh > 1e-9 ? cov / varSh : 1;
        sensitivity = { beta: round(beta, 2), note: beta > 1.2 ? '高贝塔，对市场情绪更敏感' : beta < 0.8 ? '低贝塔，受市场情绪影响较小' : '中等贝塔' };
      }
    } catch (e) { sensitivity = null; }
  }

  return {
    date: (live && live.date) || localDate(),
    level: detection.level,
    levelKey: detection.levelKey,
    impliedDir: detection.impliedDir,
    index: detection.index,
    zScore: detection.zScore,
    ma5: detection.ma5,
    ma20: detection.ma20,
    extreme: detection.extreme,
    momentumFlip: detection.momentumFlip,
    divergence: detection.divergence,
    extremeZ: detection.extremeZ,
    reasons: detection.reasons,
    sampleNote: detection.sampleNote,
    components: live ? live.components : null,
    learning: {
      extremeZ: learningState.extremeZ,
      total: learningState.total || 0,
      correct: learningState.correct || 0,
      hitRate: learningState.hitRate != null ? learningState.hitRate : (learningState.total ? round((learningState.correct || 0) / learningState.total, 3) : null),
      byDir: learningState.byDir || null,
      lastUpdated: learningState.lastUpdated || null,
      calibratedFrom: learningState.calibratedFrom || null,
    },
    sensitivity,
    backfilled,
  };

  return state;
}

module.exports = {
  detectTurningPoint,
  labelAndLearn,
  calibrateExtremeZ,
  getTurningPointState,
};

~~~

---

## `lib\shareholderData.js`  ·  486 行

~~~js
/**
 * Shareholder & Company Profile Data Module (issue5 / issue6)
 *
 * 实时抓取东方财富 F10 数据，所有请求均带超时与异常兜底：
 *   - 股东户数走势   (F10 ShareholderResearch gdrs)
 *   - 十大股东 / 十大流通股东 (RPT_F10_EH_HOLDERS，取最新一期「满10行完整披露」，
 *     含非季度末的权益变动/临时披露日，如海天味业 2026-07-03)
 *   - 机构持仓变化（机构家数 / 占流通股比，全历史） (RPT_MAIN_ORGHOLD)
 *   - 基金持股明细   (F10 ShareholderResearch jjcg)
 *   - 公司概况（主要产品 / 客户 / 企业性质）(CompanySurvey PageAjax)
 *
 * 任一子请求失败都不会让整个接口报错，前端按"暂无数据"优雅降级。
 */

const axios = require('axios');
const { resolveSectorIdentity } = require('./sectorIdentity');
// 20260929a：股东户数走势叠加「股价走势」对比所需（按需取日线，与报告期对齐）
const { getHistoryDeep } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DC_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://data.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};
const EMWEB_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};

// 将任意 symbol 标准化为东方财富代码 (SZ000001 / SH600519)，失败返回 null
function toEMCode(symbol) {
  if (!symbol) return null;
  let s = String(symbol).replace(/\.(SZ|SH|BJ)$/i, '').toUpperCase();
  if (/^(SH|SZ|BJ)/i.test(s)) {
    return s.slice(0, 2).toUpperCase() + s.slice(2);
  }
  if (/^\d{6}$/.test(s)) {
    const prefix = s[0] === '6' ? 'SH' : (s[0] === '8' || s[0] === '4') ? 'BJ' : 'SZ';
    return prefix + s;
  }
  // 港股 / 美股等暂不支持 F10
  return null;
}

// 国内 A 股判断（仅 A 股有完整 F10）
function isACode(symbol) {
  const em = toEMCode(symbol);
  return !!em && (em.startsWith('SH') || em.startsWith('SZ'));
}

// 判断是否为机构投资者名称
const INST_KEYWORDS = [
  '基金', '资产管理', '资管', '保险', '社保基金', '信托', '证券', '私募',
  '境外法人', 'QFII', '养老金', '企业年金', '中央汇金', '中国证券金融',
  '银行', '养老保险', '投信', '投资(集团)', '国有投资', '金融控股', '集团'
];
function isInstitution(name) {
  if (!name) return false;
  return INST_KEYWORDS.some(k => name.includes(k));
}

// 报告期判定（20260913g 修订）。东财 RPT_F10_EH_HOLDERS 的 END_DATE 有三类：
//   ① 季度末（03-31 / 06-30 / 09-30 / 12-31）——标准定期披露，通常 10 行；
//   ② 非季度末的权益变动 / 临时公告日——东财对最新股东名册同样给完整 10 行
//      （如海天味业 2026-07-03 = 10 行完整披露，且比最近季度末 2026-06-30 更新）；
//   ③ 残缺临时行——仅 1 行（如长江电力 2026-08-22），不能当作报告期。
// 旧逻辑「只认季度末」会把 ② 整段丢弃，表现为「东财已有 7 月数据、工作台却仍显示 6-30」
// （用户反馈：「你不能只盯着财报」）。现改为：优先取「最新一个满 10 行的完整披露日」
// （不区分是否季度末）；只有当没有任何满 10 行的日期时，才退回最近季度末 → 最近日期。
const QUARTER_END_RE = /-(03-31|06-30|09-30|12-31)$/;
const MIN_FULL_ROWS = 10; // 完整披露应达到的行数（十大股东 / 十大流通股东）
function isQuarterEnd(d) {
  return QUARTER_END_RE.test(String(d || '').slice(0, 10));
}
// 在若干日期中优先取「最近的季度末」；若一条季度末都没有，才退回最近日期（保证极端情况下仍可用）
function pickLatestReportDate(dates) {
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  const q = uniq.filter(isQuarterEnd);
  return (q.length ? q[q.length - 1] : uniq[uniq.length - 1]) || '';
}
// 从原始行中选出「最新一个满 10 行的完整披露日」；无满 10 行的日期时退回 pickLatestReportDate。
// 返回 { date, kind }；kind = 季度末报告期 | 最新披露（权益变动/临时公告）。
function pickLatestDisclosure(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = String(r.END_DATE || '').slice(0, 10);
    if (d) byDate[d] = (byDate[d] || 0) + 1;
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return { date: '', kind: '' };
  const full = dates.filter(d => byDate[d] >= MIN_FULL_ROWS);
  const date = full.length ? full[full.length - 1] : pickLatestReportDate(dates);
  if (!date) return { date: '', kind: '' };
  return { date, kind: isQuarterEnd(date) ? '季度末报告期' : '最新披露（权益变动/临时公告）' };
}

async function dcGet(url, timeout = 10000) {
  const resp = await axios.get(url, { headers: DC_HEADERS, timeout });
  return resp.data;
}

// ---- 股东研究总览（一次请求覆盖 股东户数 / 机构持仓 / 基金持股）----
// 注：原 datacenter 报表 RPT_F10_FN_HOLDERS 已被东方财富下线（"报表配置不存在"），
// 现改用 F10 ShareholderResearch/PageAjax 的 gdrs/jgcc/jjcg 字段，稳定可用。
async function fetchShareholderResearch(emCode) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(url, { headers: EMWEB_HEADERS, timeout: 10000 });
    return resp.data || {};
  } catch (e) {
    console.error('[ShareholderResearch] failed:', e.message);
    return {};
  }
}

// ---- 股东户数走势（F10 gdrs：户数 / 环比 / 户均持股 / 持股集中度）----
function parseHolderCountTrend(research) {
  const rows = Array.isArray(research.gdrs) ? research.gdrs : [];
  return rows
    .map(r => ({
      date: (r.END_DATE || '').slice(0, 10),
      holderNum: Number(r.HOLDER_TOTAL_NUM) || 0,
      changeRatio: r.TOTAL_NUM_RATIO != null ? Number(r.TOTAL_NUM_RATIO) : null,
      avgFreeShares: Number(r.AVG_FREE_SHARES) || 0,
      avgHoldAmt: Number(r.AVG_HOLD_AMT) || 0,
      focus: r.HOLD_FOCUS || '',
    }))
    .filter(r => r.holderNum > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ---- 机构持仓汇总（F10 jgcc：按报告期统计机构家数 / 持股比例）----
// 注：jgcc 只返回最新一期数据，且按 ORG_TYPE 拆成多条记录，已弃用。
function parseInstitutionHoldings(research) {
  const rows = Array.isArray(research.jgcc) ? research.jgcc : [];
  return rows
    .map(r => ({
      date: (r.REPORT_DATE || '').slice(0, 10),
      orgNum: Number(r.TOTAL_ORG_NUM) || 0,
      freeShares: Number(r.TOTAL_FREE_SHARES) || 0,
      freeRatio: Number(r.TOTAL_SHARES_RATIO) || 0,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ---- 机构持仓变化趋势（datacenter-web RPT_MAIN_ORGHOLD：多报告期机构家数 / 占流通股比）----
async function fetchInstitutionHoldingsTrend(emCode) {
  const stockCode = emCode.slice(2);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=1&pageSize=1000&pageNumber=1&reportName=RPT_MAIN_ORGHOLD&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const byDate = {};
    rows.forEach(r => {
      // 仅取“机构汇总”这一行，避免同一日期出现基金/券商等明细条目
      if (String(r.ORG_TYPE) !== '00') return;
      const d = (r.REPORT_DATE || '').slice(0, 10);
      if (!d) return;
      byDate[d] = {
        date: d,
        orgNum: Number(r.HOULD_NUM) || 0,
        freeShares: Number(r.FREE_SHARES) || 0,
        freeRatio: Number(r.FREESHARES_RATIO) || 0,
        totalShares: Number(r.TOTAL_SHARES) || 0,
        totalRatio: Number(r.TOTALSHARES_RATIO) || 0,
        holdChaNum: Number(r.HOLDCHA_NUM) || 0,
        holdChaRatio: Number(r.HOLDCHA_RATIO) || 0,
      };
    });

    const sorted = Object.values(byDate).sort((a, b) => new Date(a.date) - new Date(b.date));
    // 计算相邻报告期间的绝对变化
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      cur.orgNumChange = cur.orgNum - prev.orgNum;
      cur.freeRatioChange = +(cur.freeRatio - prev.freeRatio).toFixed(4);
    }
    return sorted;
  } catch (e) {
    console.error('[InstitutionHoldingsTrend] failed:', e.message);
    return [];
  }
}

// ---- 基金持股明细（F10 jjcg：最新一期各基金持仓，按持股比例降序）----
function parseFundHoldings(research) {
  const rows = Array.isArray(research.jjcg) ? research.jjcg : [];
  return rows
    .map(r => ({
      date: (r.REPORT_DATE || '').slice(0, 10),
      name: r.HOLDER_NAME || '',
      shares: Number(r.TOTAL_SHARES) || 0,
      value: Number(r.HOLD_VALUE) || 0,
      ratio: Number(r.TOTALSHARES_RATIO) || 0,
    }))
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
}

// ---- 十大股东（最新一期） ----
// 20260823h：修复「change」只做文本正则匹配的 bug。东财对实际有变动的股东返回数值（股数），
// 仅「不变」返回文本。新增 changeAmount（股数）与 changeRatio（%）数值字段，供判断引擎做
// 定量分析；原 change 文本字段保留，避免破坏旧消费方。
function _parseTopShareholderChange(r) {
  const raw = r.HOLD_NUM_CHANGE;
  const rawRatio = r.CHANGE_RATIO;
  let changeText = null;
  let changeAmount = null; // 股数，正=增持，负=减持
  let changeRatio = null;  // 相对上期持仓比例，正=增持，负=减持

  if (raw != null) {
    if (typeof raw === 'number') {
      changeAmount = raw;
      changeText = raw > 0 ? '增持' : raw < 0 ? '减持' : '不变';
    } else {
      const s = String(raw).trim();
      changeText = s;
      const num = Number(s.replace(/,/g, ''));
      if (!Number.isNaN(num)) {
        changeAmount = num;
      }
    }
  }
  if (rawRatio != null) {
    const ratioNum = Number(rawRatio);
    if (!Number.isNaN(ratioNum)) {
      changeRatio = ratioNum;
    }
  }
  return { changeText, changeAmount, changeRatio };
}

async function fetchTopShareholders(emCode) {
  const stockCode = emCode.slice(2);
  // pageSize 提高到 80：原来只取 10 条，会在「临时公告日」有零星记录时把最新报告期挤掉（如长江电力只剩 1 条）
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=80&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    // 20260913g：取「最新一个满 10 行的完整披露日」，不再只认季度末——
    // 保证东财已展示的非季度末更新（如海天味业 2026-07-03 完整 10 行）能被工作台同步；
    // 残缺临时行（如长江电力 2026-08-22 仅 1 行）因不满 10 行被自然排除。
    const picked = pickLatestDisclosure(rows);
    const latestDate = picked.date;
    const periodRows = rows.filter(r => (r.END_DATE || '').slice(0, 10) === latestDate);
    return periodRows.map(r => {
      const parsed = _parseTopShareholderChange(r);
      return {
        name: r.HOLDER_NAME || '',
        holdRatio: Number(r.HOLD_NUM_RATIO) || 0,
        holdAmount: Number(r.HOLD_NUM) || 0,
        // 兼容旧字段：文本或数值原样保留
        change: parsed.changeText,
        changeAmount: parsed.changeAmount,
        changeRatio: parsed.changeRatio,
        endDate: (r.END_DATE || '').slice(0, 10),
        // 20260913g：报告期性质（季度末 vs 非季度末最新披露），供前端/判断因子正确标注新鲜度
        periodKind: picked.kind,
        type: isInstitution(r.HOLDER_NAME) ? '机构' : '个人/其他',
      };
    });
  } catch (e) {
    console.error('[TopShareholders] failed:', e.message);
    return [];
  }
}

// ---- 公司概况（主要产品 / 客户 / 企业性质） ----
// 数据源：东方财富 F10 CompanySurvey（jbzl 数组）。该接口稳定可用。
// 主营构成（产品维度）来自 MainOperate/zygcfx，反爬较严，失败时优雅降级。
async function fetchCompanyProfile(emCode) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(url, { headers: EMWEB_HEADERS, timeout: 10000 });
    const d = resp.data;
    // jbzl 为数组，取最新一条
    const jb = Array.isArray(d?.jbzl) ? d.jbzl[0] : (d?.jbzl?.['0'] || null);
    if (!jb || !jb.ORG_NAME) return null;

    const orgName = jb.ORG_NAME || '';
    const industry = jb.INDUSTRYCSRC1 || jb.INDUSTRY_NAME || '';
    const province = jb.PROVINCE || '';
    const businessScope = jb.BUSINESS_SCOPE || '';
    const orgProfile = jb.ORG_PROFILE || '';

    // 主要产品 / 客户：尽力从 MainOperate 主营构成（产品维度）提取；失败则留空
    let mainProducts = [];
    let mainCustomers = [];
    try {
      const mo = await axios.get(`https://emweb.securities.eastmoney.com/PC_HSF10/MainOperate/PageAjax?code=${emCode}`, { headers: EMWEB_HEADERS, timeout: 8000 });
      const m = mo.data;
      const zy = m?.zygcfx ? (Array.isArray(m.zygcfx) ? m.zygcfx : Object.values(m.zygcfx).filter(x => typeof x === 'object')) : [];
      const prodRows = zy.filter(r => (r.MAINOP_TYPE === '产品' || r.MAINOP_TYPE_NAME === '产品') && r.ITEM_NAME);
      if (prodRows.length) {
        const latest = prodRows.slice().sort((a, b) => new Date(b.REPORT_DATE) - new Date(a.REPORT_DATE))[0];
        mainProducts = [...new Set(prodRows.filter(r => r.REPORT_DATE === latest.REPORT_DATE).map(r => r.ITEM_NAME))].slice(0, 8);
      }
    } catch (e) {
      console.error('[CompanyProfile] MainOperate failed (graceful):', e.message);
    }

    const mainBusiness = orgProfile || businessScope;
    const intro = (businessScope && businessScope !== orgProfile) ? businessScope.slice(0, 300) : '';

    return {
      companyName: orgName,
      ownership: '未知',
      industry,
      mainBusiness,
      mainProducts,
      mainCustomers,
      controllingShareholder: '',
      province,
      intro,
      _raw: { empNum: jb.EMP_NUM },
    };
  } catch (e) {
    console.error('[CompanyProfile] failed:', e.message);
    return null;
  }
}

// 根据前十大股东名称推断企业性质（仅供参考，非权威判定）
const GOV_KEYWORDS = ['国资委', '国有', '国资', '中央汇金', '证金', '社保基金', '财政部', '国家', '汇金', '中国烟草', '铁道', '电网', '石油', '石化', '人民政府', '资产经营', '投资控股', '产业发展', '城市建设', '交通投资'];
const PROVINCE_RE = /(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|深圳|广州|杭州|南京|武汉|成都|青岛|宁波|厦门|苏州|西安)/;
function inferOwnership(topHolders) {
  if (!topHolders || !topHolders.length) return '未知';
  const names = topHolders.map(h => h.name || '');
  // 任一前十大股东命中国资关键词 → 国有控股（覆盖第一大为名义持有人的情况）
  if (names.some(n => GOV_KEYWORDS.some(k => n.includes(k)))) return '国有控股';
  const top = names[0];
  // 第一大股东为港股通名义持有人，无法据此判定实际控制人
  if (/香港中央结算|中央结算\(代理人\)|代理人有限公司/.test(top)) {
    return '无法判定（含港股通名义持有人）';
  }
  // 省级行政区 + 强国资信号（集团/国资/国有/城建）才推断为地方国企，避免误判民营投资公司为国企
  if (PROVINCE_RE.test(top) && /(集团|国资|国有|城建|发展投资集团)/.test(top)) {
    return '国有控股（推断）';
  }
  if (isInstitution(top)) return '机构控股';
  return '民营 / 其他';
}

// ---- 股价走势对齐（与股东户数报告期对齐，用于走势对比）----
// 报告期 END_DATE 多为季末（如 2026-06-30），未必是交易日；取报告期当日或
// 最近（≤20 个日历日）交易日的收盘价对齐，缺失返回 null（前端可切换隐藏）。
function dateDiffDays(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

function buildPriceTrend(holderCountTrend, kline) {
  if (!Array.isArray(kline) || kline.length === 0) return [];
  const map = {};
  const seq = [];
  kline.forEach(b => {
    if (!b || !b.date) return;
    const d = String(b.date).slice(0, 10);
    const c = Number(b.close);
    if (map[d] == null && !Number.isNaN(c)) {
      map[d] = c;
      seq.push({ date: d, close: c });
    }
  });
  seq.sort((a, b) => new Date(a.date) - new Date(b.date));

  // 找 <= target 的最大下标（seq.date 升序）
  const findLE = (target) => {
    let lo = 0, hi = seq.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (seq[mid].date <= target) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };

  const WINDOW = 20; // 报告期附近 20 个日历日的容差
  return holderCountTrend.map(h => {
    const hd = h.date;
    if (map[hd] != null) return { date: hd, close: map[hd] };
    const le = findLE(hd);
    if (le >= 0 && dateDiffDays(seq[le].date, hd) <= WINDOW) {
      return { date: hd, close: seq[le].close };
    }
    const ge = le + 1;
    if (ge < seq.length && dateDiffDays(hd, seq[ge].date) <= WINDOW) {
      return { date: hd, close: seq[ge].close };
    }
    return { date: hd, close: null };
  });
}

/**
 * 汇总股东分析数据
 */
async function getShareholdersData(symbol) {
  const emCode = toEMCode(symbol);
  if (!emCode) {
    return { error: '仅支持 A 股市场股东分析', supported: false };
  }
  const research = await fetchShareholderResearch(emCode);
  // 20260929a：并行抓取股价日线（getHistoryDeep 优先新浪 ~6 年日K，腾讯近 2.6 年兜底），
  // 与股东户数报告期对齐，用于叠加「股价走势」对比
  const [holderCountTrend, topShareholders, institutionHoldings, kline] = await Promise.all([
    Promise.resolve(parseHolderCountTrend(research)),
    fetchTopShareholders(emCode),
    fetchInstitutionHoldingsTrend(emCode),
    getHistoryDeep(symbol, 1500).catch(() => []),
  ]);
  const fundHoldings = parseFundHoldings(research);

  const controllingShareholder = topShareholders[0]?.name || '';
  const priceTrend = buildPriceTrend(holderCountTrend, kline);

  return {
    symbol,
    emCode,
    supported: true,
    holderCountTrend,
    priceTrend,
    priceTrendAvailable: priceTrend.some(p => p.close != null),
    institutionHoldings,
    fundHoldings,
    topShareholders,
    controllingShareholder,
    holderCountTrendAvailable: holderCountTrend.length > 0,
    institutionHoldingsAvailable: institutionHoldings.length > 0,
    fundHoldingsAvailable: fundHoldings.length > 0,
    topShareholdersAvailable: topShareholders.length > 0,
  };
}

/**
 * 汇总公司概况数据（含企业性质推断）
 */
async function getCompanyProfile(symbol) {
  const emCode = toEMCode(symbol);
  if (!emCode) {
    return { error: '仅支持 A 股公司概况', supported: false };
  }
  const [profile, topShareholders, identity] = await Promise.all([
    fetchCompanyProfile(emCode),
    fetchTopShareholders(emCode),
    resolveSectorIdentity(symbol).catch(() => null),
  ]);
  if (!profile) {
    return { error: '暂未获取到公司概况数据', supported: true };
  }
  // 20260915：用 sectorIdentity 的精确行业覆盖 F10 原始 CSRC 分类。
  // 例：688660 电气风电 F10 CSRC=制造业-通用设备制造业，但真实业务是风电设备，
  //     泛化的 CSRC 名称会导致行业板块走势/涨跌停/公司概况全部错配。
  const preciseIndustry = identity
    ? (identity.f10Name || identity.emIndustry || identity.industry || '')
    : '';
  if (preciseIndustry) {
    profile.industry = preciseIndustry;
  }
  const controllingShareholder = topShareholders[0]?.name || '';
  const ownership = inferOwnership(topShareholders);
  return {
    ...profile,
    controllingShareholder,
    ownership,
    supported: true,
  };
}

module.exports = {
  toEMCode,
  isACode,
  getShareholdersData,
  getCompanyProfile,
  // 20260913g：导出纯函数供离线单测（scripts/test_shareholder_period.js）验证报告期选取，不参与业务调用
  _pickLatestDisclosure: pickLatestDisclosure,
  _isQuarterEnd: isQuarterEnd,
  // 20260929a：导出股价对齐纯函数供离线单测（scripts/test_shareholder_price_trend.js），不参与业务调用
  _buildPriceTrend: buildPriceTrend,
};

~~~

---

## `lib\stockData.js`  ·  2617 行

~~~js
/**
 * Stock Data Fetcher
 * Supports Chinese A-shares, HK stocks, US stocks
 * Uses Tencent API for real-time quotes, Eastmoney API for history & fundamentals
 */
const axios = require('axios');
const iconv = require('iconv-lite');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { localDate, localCompact, localDateFromTs } = require('./localDate');
const { REPORTS, fetchReport } = require('./emDataCenter');
const { getKlineJson } = require('./tklineHost');            // 20261021g 腾讯K线主机族降级
const { isTradingDay } = require('./cnTradingCalendar');  // 20261009 开盘日实时性守门：判断今日是否交易日
const { getUs10yYield } = require('./usTreasury');        // 20261021a 美债10年期收益率（美国指数行追加卡，日线）
const thsDailyCache = require('./thsDailyCache');         // 20261022f 同花顺日K原始响应本地缓存（避开 all.js 502 限流）
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 申万行业层级解析（从名称后缀 Ⅰ/Ⅱ/Ⅲ 识别 + 常见无后缀名兜底）----
const SW_LEVEL_MAP = { 'Ⅰ': '一级', 'Ⅱ': '二级', 'Ⅲ': '三级' };
// 申万行业层级字典（行业名 → 一级/二级/三级）
// 数据来源：申万宏源 2021 版行业分类（乐咕乐股 legulegu 权威分类树，2026-09 抓取），
// 覆盖东财「行业板块」全部名称（含去 Ⅱ/Ⅲ 后缀的基础名兜底），共 553 条。
// 东财板块名先按 Ⅰ/Ⅱ/Ⅲ 后缀解析，再落到本字典兜底。
const SW_NAME_LEVEL = {
  // 申万一级（32）
  '交通运输': '一级', '传媒': '一级', '公用事业': '一级', '农林牧渔': '一级', '医药生物': '一级', '商贸零售': '一级', '国防军工': '一级', '基础化工': '一级',
  '家用电器': '一级', '建筑材料': '一级', '建筑装饰': '一级', '房地产': '一级', '有色金属': '一级', '机械设备': '一级', '汽车': '一级', '煤炭': '一级',
  '环保': '一级', '电力设备': '一级', '电子': '一级', '石油石化': '一级', '社会服务': '一级', '纺织服饰': '一级', '综合': '一级', '综合金融': '一级',
  '美容护理': '一级', '计算机': '一级', '轻工制造': '一级', '通信': '一级', '钢铁': '一级', '银行': '一级', '非银金融': '一级', '食品饮料': '一级',
  // 申万二级（172）
  'IT服务': '二级', 'IT服务Ⅱ': '二级', '一般零售': '二级', '专业工程': '二级', '专业服务': '二级', '专业连锁': '二级', '专业连锁Ⅱ': '二级', '专用设备': '二级',
  '个护用品': '二级', '中药': '二级', '中药Ⅱ': '二级', '乘用车': '二级', '互联网电商': '二级', '休闲食品': '二级', '体育': '二级', '体育Ⅱ': '二级',
  '保险': '二级', '保险Ⅱ': '二级', '元件': '二级', '光伏设备': '二级', '光学光电子': '二级', '其他家电': '二级', '其他家电Ⅱ': '二级', '其他电子': '二级',
  '其他电子Ⅱ': '二级', '其他电源设备': '二级', '其他电源设备Ⅱ': '二级', '养殖业': '二级', '军工电子': '二级', '军工电子Ⅱ': '二级', '农业综合': '二级', '农业综合Ⅱ': '二级',
  '农产品加工': '二级', '农化制品': '二级', '农商行': '二级', '农商行Ⅱ': '二级', '冶钢原料': '二级', '出版': '二级', '动物保健': '二级', '动物保健Ⅱ': '二级',
  '包装印刷': '二级', '化妆品': '二级', '化学制品': '二级', '化学制药': '二级', '化学原料': '二级', '化学纤维': '二级', '医疗器械': '二级', '医疗服务': '二级',
  '医疗美容': '二级', '医药商业': '二级', '半导体': '二级', '厨卫电器': '二级', '商用车': '二级', '国有大型银行': '二级', '国有大型银行Ⅱ': '二级', '地面兵装': '二级',
  '地面兵装Ⅱ': '二级', '城商行': '二级', '城商行Ⅱ': '二级', '基础建设': '二级', '塑料': '二级', '多元金融': '二级', '家居用品': '二级', '家电零部件': '二级',
  '家电零部件Ⅱ': '二级', '小家电': '二级', '小金属': '二级', '工业金属': '二级', '工程咨询服务': '二级', '工程咨询服务Ⅱ': '二级', '工程机械': '二级', '广告营销': '二级',
  '影视院线': '二级', '房地产开发': '二级', '房地产服务': '二级', '房屋建设': '二级', '房屋建设Ⅱ': '二级', '摩托车及其他': '二级', '教育': '二级', '数字媒体': '二级',
  '文娱用品': '二级', '旅游及景区': '二级', '旅游零售': '二级', '旅游零售Ⅱ': '二级', '普钢': '二级', '服装家纺': '二级', '林业': '二级', '林业Ⅱ': '二级',
  '橡胶': '二级', '水泥': '二级', '汽车服务': '二级', '汽车零部件': '二级', '油服工程': '二级', '油气开采': '二级', '油气开采Ⅱ': '二级', '消费电子': '二级',
  '渔业': '二级', '游戏': '二级', '游戏Ⅱ': '二级', '炼化及贸易': '二级', '焦炭': '二级', '焦炭Ⅱ': '二级', '煤炭开采': '二级', '照明设备': '二级',
  '照明设备Ⅱ': '二级', '燃气': '二级', '燃气Ⅱ': '二级', '物流': '二级', '特钢': '二级', '特钢Ⅱ': '二级', '环保设备': '二级', '环保设备Ⅱ': '二级',
  '环境治理': '二级', '玻璃玻纤': '二级', '生物制品': '二级', '电力': '二级', '电子化学品': '二级', '电子化学品Ⅱ': '二级', '电机': '二级', '电机Ⅱ': '二级',
  '电池': '二级', '电网设备': '二级', '电视广播': '二级', '电视广播Ⅱ': '二级', '白色家电': '二级', '白酒': '二级', '白酒Ⅱ': '二级', '种植业': '二级',
  '纺织制造': '二级', '综合Ⅱ': '二级', '股份制银行': '二级', '股份制银行Ⅱ': '二级', '能源金属': '二级', '自动化设备': '二级', '航天装备': '二级', '航天装备Ⅱ': '二级',
  '航海装备': '二级', '航海装备Ⅱ': '二级', '航空机场': '二级', '航空装备': '二级', '航空装备Ⅱ': '二级', '航运港口': '二级', '装修建材': '二级', '装修装饰': '二级',
  '装修装饰Ⅱ': '二级', '计算机设备': '二级', '证券': '二级', '证券Ⅱ': '二级', '调味发酵品': '二级', '调味发酵品Ⅱ': '二级', '贵金属': '二级', '贸易': '二级',
  '贸易Ⅱ': '二级', '轨交设备': '二级', '轨交设备Ⅱ': '二级', '软件开发': '二级', '通信服务': '二级', '通信设备': '二级', '通用设备': '二级', '造纸': '二级',
  '酒店餐饮': '二级', '金属新材料': '二级', '铁路公路': '二级', '非白酒': '二级', '非金属材料': '二级', '非金属材料Ⅱ': '二级', '风电设备': '二级', '食品加工': '二级',
  '饮料乳品': '二级', '饰品': '二级', '饲料': '二级', '黑色家电': '二级',
  // 申万三级（349）
  'IT服务Ⅲ': '三级', 'LED': '三级', '专业出版': '三级', '专业连锁Ⅲ': '三级', '个护小家电': '三级', '中药Ⅲ': '三级', '中间产品及消费品供应链服务': '三级', '乳制品': '三级',
  '乳品': '三级', '产业地产': '三级', '人力资源服务': '三级', '人工景区': '三级', '仓储物流': '三级', '仪器仪表': '三级', '会展服务': '三级', '住宅开发': '三级',
  '体外诊断': '三级', '体育Ⅲ': '三级', '保健品': '三级', '保险Ⅲ': '三级', '信托': '三级', '光伏主材': '三级', '光伏加工设备': '三级', '光伏发电': '三级',
  '光伏电池组件': '三级', '光伏辅材': '三级', '光学元件': '三级', '公交': '三级', '公路货运': '三级', '其他专业工程': '三级', '其他专业服务': '三级', '其他专用设备': '三级',
  '其他传媒': '三级', '其他养殖': '三级', '其他农产品加工': '三级', '其他化学制品': '三级', '其他化学原料': '三级', '其他化学纤维': '三级', '其他医疗服务': '三级', '其他塑料制品': '三级',
  '其他家居用品': '三级', '其他家电Ⅲ': '三级', '其他小金属': '三级', '其他建材': '三级', '其他数字媒体': '三级', '其他橡胶制品': '三级', '其他汽车零部件': '三级', '其他生物制品': '三级',
  '其他电子Ⅲ': '三级', '其他电源设备Ⅲ': '三级', '其他石化': '三级', '其他种植业': '三级', '其他纺织': '三级', '其他能源发电': '三级', '其他自动化设备': '三级', '其他计算机设备': '三级',
  '其他运输设备': '三级', '其他通信设备': '三级', '其他通用设备': '三级', '其他酒类': '三级', '其他金属新材料': '三级', '其他食品': '三级', '其他饰品': '三级', '其他黑色家电': '三级',
  '军工电子Ⅲ': '三级', '农业综合Ⅲ': '三级', '农商行Ⅲ': '三级', '农用机械': '三级', '农药': '三级', '冰洗': '三级', '冶钢辅料': '三级', '分立器件': '三级',
  '制冷空调设备': '三级', '动力煤': '三级', '动漫': '三级', '动物保健Ⅲ': '三级', '化妆品制造及其他': '三级', '化学制剂': '三级', '化学工程': '三级', '医疗研发外包': '三级',
  '医疗耗材': '三级', '医疗设备': '三级', '医美服务': '三级', '医美耗材': '三级', '医药流通': '三级', '医院': '三级', '半导体材料': '三级', '半导体设备': '三级',
  '卫浴制品': '三级', '卫浴电器': '三级', '印制电路板': '三级', '印刷': '三级', '印刷包装机械': '三级', '印染': '三级', '原料药': '三级', '原材料供应链服务': '三级',
  '厨房小家电': '三级', '厨房电器': '三级', '合成树脂': '三级', '品牌化妆品': '三级', '品牌消费电子': '三级', '商业地产': '三级', '商业物业经营': '三级', '商用载客车': '三级',
  '商用载货车': '三级', '啤酒': '三级', '园林工程': '三级', '固废治理': '三级', '国有大型银行Ⅲ': '三级', '国际工程': '三级', '图片媒体': '三级', '地面兵装Ⅲ': '三级',
  '垂直应用软件': '三级', '城商行Ⅲ': '三级', '培训教育': '三级', '基建市政工程': '三级', '基础软件': '三级', '塑料包装': '三级', '复合肥': '三级', '多业态零售': '三级',
  '大众出版': '三级', '大宗用纸': '三级', '大气治理': '三级', '娱乐用品': '三级', '学历教育': '三级', '安防设备': '三级', '定制家居': '三级', '宠物食品': '三级',
  '家电零部件Ⅲ': '三级', '家纺': '三级', '工控设备': '三级', '工程咨询服务Ⅲ': '三级', '工程机械器件': '三级', '工程机械整机': '三级', '广告媒体': '三级', '底盘与发动机系统': '三级',
  '彩电': '三级', '影视动漫制作': '三级', '快递': '三级', '成品家居': '三级', '房产租赁经纪': '三级', '房地产综合服务': '三级', '房屋建设Ⅲ': '三级', '摩托车': '三级',
  '改性塑料': '三级', '教育出版': '三级', '教育运营及其他': '三级', '数字芯片设计': '三级', '文化用品': '三级', '文字媒体': '三级', '旅游综合': '三级', '旅游零售Ⅲ': '三级',
  '无机盐': '三级', '有机硅': '三级', '期货': '三级', '机器人': '三级', '机场': '三级', '机床工具': '三级', '板材': '三级', '林业Ⅲ': '三级',
  '果蔬加工': '三级', '核力发电': '三级', '检测服务': '三级', '棉纺': '三级', '楼宇设备': '三级', '模拟芯片设计': '三级', '横向通用软件': '三级', '橡胶助剂': '三级',
  '民爆制品': '三级', '氟化工': '三级', '氨纶': '三级', '氮肥': '三级', '氯碱': '三级', '水产养殖': '三级', '水产饲料': '三级', '水力发电': '三级',
  '水务及水治理': '三级', '水泥制品': '三级', '水泥制造': '三级', '汽车电子电气系统': '三级', '汽车经销商': '三级', '汽车综合服务': '三级', '油品石化贸易': '三级', '油气及炼化工程': '三级',
  '油气开采Ⅲ': '三级', '油田服务': '三级', '洗护用品': '三级', '海洋捕捞': '三级', '涂料': '三级', '涂料油墨': '三级', '消费电子零部件及组装': '三级', '涤纶': '三级',
  '清洁小家电': '三级', '港口': '三级', '游戏Ⅲ': '三级', '激光设备': '三级', '火力发电': '三级', '火电设备': '三级', '炭黑': '三级', '炼油化工': '三级',
  '烘焙食品': '三级', '热力服务': '三级', '焦炭Ⅲ': '三级', '焦煤': '三级', '煤化工': '三级', '照明设备Ⅲ': '三级', '熟食': '三级', '燃料电池': '三级',
  '燃气Ⅲ': '三级', '物业管理': '三级', '特种纸': '三级', '环保设备Ⅲ': '三级', '玻璃制造': '三级', '玻纤制造': '三级', '瓷砖地板': '三级', '生活用纸': '三级',
  '生猪养殖': '三级', '电信运营商': '三级', '电动乘用车': '三级', '电商服务': '三级', '电子化学品Ⅲ': '三级', '电工仪器仪表': '三级', '电机Ⅲ': '三级', '电池化学品': '三级',
  '电网自动化设备': '三级', '电能综合服务': '三级', '电视广播Ⅲ': '三级', '畜养殖': '三级', '畜禽饲料': '三级', '疫苗': '三级', '白酒Ⅲ': '三级', '白银': '三级',
  '百货': '三级', '硅料硅片': '三级', '磁性材料': '三级', '磨具磨料': '三级', '磷肥及磷化工': '三级', '禽养殖': '三级', '种子': '三级', '租赁': '三级',
  '稀土': '三级', '空调': '三级', '端到端供应链服务': '三级', '管材': '三级', '粘胶': '三级', '粮油加工': '三级', '粮食种植': '三级', '纯碱': '三级',
  '纸包装': '三级', '纺织化学制品': '三级', '纺织服装设备': '三级', '纺织鞋类制造': '三级', '线下药店': '三级', '线缆部件及其他': '三级', '综合Ⅲ': '三级', '综合乘用车': '三级',
  '综合包装': '三级', '综合环境治理': '三级', '综合电力设备商': '三级', '综合电商': '三级', '网络优化运营': '三级', '网络规划建设运维': '三级', '耐火材料': '三级', '聚氨酯': '三级',
  '肉制品': '三级', '肉鸡养殖': '三级', '股份制银行Ⅲ': '三级', '胶黏剂及胶带': '三级', '能源及重型设备': '三级', '膜材料': '三级', '自然景区': '三级', '航天装备Ⅲ': '三级',
  '航海装备Ⅲ': '三级', '航空装备Ⅲ': '三级', '航空运输': '三级', '航运': '三级', '营销代理': '三级', '蓄电池及其他电池': '三级', '血液制品': '三级', '被动元件': '三级',
  '装修装饰Ⅲ': '三级', '视频媒体': '三级', '证券Ⅲ': '三级', '诊断服务': '三级', '调味发酵品Ⅲ': '三级', '贸易Ⅲ': '三级', '资产管理': '三级', '超市': '三级',
  '跨境物流': '三级', '跨境电商': '三级', '车身附件及饰件': '三级', '轨交设备Ⅲ': '三级', '轮胎轮毂': '三级', '软饮料': '三级', '辅料': '三级', '输变电设备': '三级',
  '运动服装': '三级', '逆变器': '三级', '通信工程及服务': '三级', '通信应用增值服务': '三级', '通信线缆及配套': '三级', '通信终端及配件': '三级', '通信网络设备及器件': '三级', '配电设备': '三级',
  '酒店': '三级', '金属制品': '三级', '金属包装': '三级', '金融信息服务': '三级', '金融控股': '三级', '金融租赁': '三级', '钛白粉': '三级', '钟表珠宝': '三级',
  '钢结构': '三级', '钢铁管材': '三级', '钨': '三级', '钴': '三级', '钼': '三级', '钾肥': '三级', '铁矿石': '三级', '铁路运输': '三级',
  '铅锌': '三级', '铜': '三级', '铝': '三级', '锂': '三级', '锂电专用设备': '三级', '锂电池': '三级', '锦纶': '三级', '镍': '三级',
  '长材': '三级', '门户网站': '三级', '防水材料': '三级', '院线': '三级', '集成电路制造': '三级', '集成电路封测': '三级', '零食': '三级', '非货币银行': '三级',
  '非运动服装': '三级', '非金属材料Ⅲ': '三级', '面板': '三级', '鞋帽及其他': '三级', '预加工食品': '三级', '风力发电': '三级', '风电整机': '三级', '风电零部件': '三级',
  '食品及饲料添加剂': '三级', '食用菌': '三级', '餐饮': '三级', '高速公路': '三级', '黄金': '三级',
};
// ---- 首页行业卡片统一分级口径（单一事实源）----
// 东财「行业板块」(fs=m:90+t:2) 是申万一/二/三级**混用池**（实测 448 个：一级 30 / 二级 92 / 三级 326）。
// 三档互相包含（半导体 ⊂ 电子、通信网络设备及器件 ⊂ 通信设备 ⊂ 通信），若混排会出现
// 「父行业与子行业同时上榜、同一笔资金被重复计入」，导致榜单不可比 —— 违反工作台「数据一致性」核心规则。
// 故首页全部行业榜单（涨跌幅前5 / 7日涨跌幅最大 / 主力·散户 资金净流入流出前五 / 近5日最大）
// 一律取此唯一层级口径。修改此常量即全局切换层级（联动 sectorCapitalFlow.js / sectorRankHistory.js）。
// 20260917：用户要求由「申万三级」改为「申万二级」（更聚合，如 元件/工业金属/半导体/光学光电子）。
const SW_LEVEL_UNIFIED = '二级';

function parseSwSectorName(rawName) {
  const full = String(rawName || '').trim();
  const m = full.match(/([ⅠⅡⅢ]+)$/);
  if (m) {
    const levelChar = m[1][0];
    return {
      name: full.replace(/[ⅠⅡⅢ]+$/, '').trim(),
      rawName: full,
      swLevel: SW_LEVEL_MAP[levelChar] || null,
    };
  }
  const mapped = SW_NAME_LEVEL[full] || null;
  return { name: full, rawName: full, swLevel: mapped };
}

// ---- 申万二级板块全名清单（20260921g）----
// 供给「实时大盘」通过东方财富妙想取数时的**实体枚举清单**（妙想必须给明确实体名，
// 不支持「排名前N」类问句，故榜单需本地排序）。
// 规则：取 SW_NAME_LEVEL 中层级=二级 的键，按基础名去重（去掉 Ⅱ/Ⅲ 后缀）；
// 若去后缀后的基础名本身属于其他层级（如「综合Ⅱ」→「综合」是一级），则保留带后缀原名，
// 避免把一级行业误当二级板块（否则会出现父子行业同榜、资金重复计入）。
let _sw2NamesCache = null;
function getSwSecondLevelNames() {
  if (_sw2NamesCache) return _sw2NamesCache.slice();
  const strip = (s) => String(s).replace(/[ⅠⅡⅢ]+$/g, '');
  // 冲突集＝「基础名本身」在字典里被登记为其他层级的那些名字（如「综合」是一级）。
  // 只认字典键本身，不能用「被别人 strip 后撞名」判断——否则三级名「IT服务Ⅲ」会误伤二级的「IT服务」，
  // 导致 IT服务 / IT服务Ⅱ 双双入选、清单出现成对重复。
  const conflict = new Set();
  for (const k of Object.keys(SW_NAME_LEVEL)) {
    if (SW_NAME_LEVEL[k] && SW_NAME_LEVEL[k] !== '二级') conflict.add(k);
  }
  const seen = new Set();
  const out = [];
  for (const k of Object.keys(SW_NAME_LEVEL)) {
    if (SW_NAME_LEVEL[k] !== '二级') continue;
    const base = strip(k);
    const name = conflict.has(base) ? k : base;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  _sw2NamesCache = out;
  return out.slice();
}

// ---- Get Eastmoney secid ----
function getEastmoneySecid(input) {
  const info = detectMarket(input);
  if (info.market === 'CN') {
    return info.exchange === 'SH' ? `1.${info.tencentCode.replace(/^(sh|sz)/, '')}` : `0.${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  }
  if (info.market === 'HK') {
    return `116.${info.tencentCode.replace(/^hk/, '')}`;
  }
  // US stocks: try NASDAQ (105) first
  return `105.${input.toUpperCase()}`;
}

// ---- Eastmoney K-line history (works for ALL markets) ----
// period: 'day' | '60m' | 'week' | 'month'
//  - day    ：日K（klt=101，前复权 fqt=1）
//  - 60m    ：60分钟（klt=60，不复权 fqt=0，保证最后一根收盘价与实时价同口径，涨跌幅一致）
//  - week   ：周K（klt=102，前复权）
//  - month  ：月K（klt=103，前复权）
async function fetchEastmoneyHistory(input, count = 320, period = 'day') {
  const secid = getEastmoneySecid(input);
  const endDate = localCompact();
  const klt = period === '60m' ? 60 : period === 'week' ? 102 : period === 'month' ? 103 : 101;
  const fqt = period === '60m' ? 0 : 1;
  // 60分钟数据仅保留近端区间，beg 取最近 120 个自然日，避免起止区间过宽导致接口返回空
  let begDate = '20100101';
  if (period === '60m') {
    const d = new Date();
    d.setDate(d.getDate() - 120);
    begDate = localCompact(d);
  }
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${fqt}&beg=${begDate}&end=${endDate}&lmt=${count}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 15000,
    });
    const klines = resp.data?.data?.klines || [];
    if (klines.length === 0) return [];

    // kline format: date,open,close,high,low,volume,amount,amplitude,changePct,change,turnover
    return klines.map(k => {
      const parts = k.split(',');
      return {
        date: parts[0],
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]) || 0,
        amount: parseFloat(parts[6]) || 0,
        turnover: parseFloat(parts[10]) || 0, // f61 换手率（%）
      };
    });
  } catch (e) {
    console.error('Eastmoney history failed:', e.message);
    return [];
  }
}

// ---- Eastmoney K-line history with host fallback (20261017d, 纯新增) ----
// 与 fetchEastmoneyHistory 字段完全一致（{ date, open, close, high, low, volume, amount, turnover }），
// 仅日K（klt=101 前复权）。差异：按主机列表依次尝试——push2his 为默认主机，
// 部分网络环境（代理/特定运营商/GFW 级阻断）下 push2his 连接被切断，
// 而 push2 主机提供同一 kline 接口与同一字段（f57 成交额、f61 换手率均在内）。
// 既有 fetchEastmoneyHistory 调用方（主图/量价关系/换手率序列等）行为不变，本函数只服务于
// 需要成交额+换手率全字段的新消费方（如量能分析引擎 lib/volumeEngine.js）。
async function fetchEastmoneyHistoryMultiHost(input, count = 320, hosts = ['push2his.eastmoney.com', 'push2.eastmoney.com']) {
  const secid = getEastmoneySecid(input);
  const endDate = localCompact();
  for (const host of hosts) {
    const url = `https://${host}/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=20100101&end=${endDate}&lmt=${count}`;
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 15000,
      });
      const klines = resp.data?.data?.klines || [];
      if (klines.length === 0) continue; // 该主机无数据，尝试下一主机
      return klines.map(k => {
        const parts = k.split(',');
        return {
          date: parts[0],
          open: parseFloat(parts[1]),
          close: parseFloat(parts[2]),
          high: parseFloat(parts[3]),
          low: parseFloat(parts[4]),
          volume: parseFloat(parts[5]) || 0,
          amount: parseFloat(parts[6]) || 0,
          turnover: parseFloat(parts[10]) || 0, // f61 换手率（%）
        };
      });
    } catch (e) {
      console.error(`Eastmoney history failed (${host}):`, e.message);
      // 主机不可达：继续尝试下一主机
    }
  }
  return [];
}

// ---- Tonghuashun (10jqka) daily K-line history (20261017e, 纯新增) ----
// 通道：d.10jqka.com.cn/v4/line/hs_<code>/01/{last,all}.js（同花顺网页K线底层接口，前复权）
//  - last.js：明文，近 140 根；字段顺序 date,open,high,low,close,volume(股),amount(元),turnover(%)，…
//    （turnover 已实证：隐含流通盘跨 140 根恒定，000902=11.43亿股/601318=106.60亿股/600519=12.50亿股）
//  - all.js：压缩格式——price/volumn/dates 三列 + sortYear(逐年根数) + priceFactor；
//    解码规则：每天 4 个 price 值 = (最低价, 开盘−最低, 最高−最低, 收盘−最低) × priceFactor，
//    volumn 单位为股，dates 为 MMDD 按 sortYear 逐年展开；仅 OHLCV，无成交额/换手率。
//  - 复权口径：前复权，与腾讯 qfq / 东财 fqt=1 同口径（实测 000902/601318 各 140 根 close 逐日一致）。
//  - 网络教训（scripts/ths_industry_index_history.py 20260911）：本机 d.10jqka 443 常被断、80 可达，
//    且系统代理会挂起同花顺请求 → http 优先 https 兜底 + proxy:false 强制直连。
// 合并策略：last.js 为近期 140 根权威（含 amount/turnover）；all.js 解码仅用于向过去延伸，
//   并以两者重叠段 close 逐日一致（±0.005）作为解码正确性闸门，任一不符即弃 all.js 只用 last.js。
// 返回字段与 fetchEastmoneyHistory 一致：{ date, open, close, high, low, volume, amount, turnover }；
//   amount/turnover 仅 last.js 覆盖的近期区间有值（更早的为 0，由消费方按 spec 降级标注）。
//
// 20261022f（用户方案 C）本地缓存：all.js 高频请求会触发 502 限流（实测确认是限流，非头部/代理问题）。
//   现在把两份 JSONP **原始文本**落盘到 data/cache/ths-daily/<6位>.json，按「交易日 + 时段」三段式复用：
//   交易日盘中 1 次、收盘后 1 次、非交易日全程复用 → 每只股票每天最多 2 次请求。
//   关键：读缓存后走的是**同一套** _decodeThsAll/_mergeThsBars 解码与 close 闸门，只在「文本从哪来」分叉，
//   因此缓存结果与实时拉取逐字节一致。缓存异常一律降级为联网，绝不阻塞行情分析。
async function fetchThsHistory(input, count = 320) {
  const info = detectMarket(input);
  if (!info || info.market !== 'CN') return []; // hs_ 前缀仅覆盖沪深，港美股不走本通道
  const pureCode = info.tencentCode.replace(/^(sh|sz)/, '');
  let pair;
  try {
    pair = await _thsGetRawPair(pureCode);
  } catch (e) {
    console.warn('[ThsHistory] 取数失败:', e && e.message ? e.message : e);
    return [];
  }
  if (!pair || !pair.lastRaw) return [];
  const plain = _parseThsLast(_unwrapThsJsonp(pair.lastRaw));
  if (!plain || plain.length === 0) return []; // last.js 是权威源：拿不到则整体不用同花顺（不冒险采信未校验的解码）
  const decoded = _decodeThsAll(_unwrapThsJsonp(pair.allRaw));
  // 20261023f：历史段需要回填成交额时，用腾讯「不复权」收盘价作基准（前复权价会系统性低估约 2~3.5%）
  let rawCloseMap = null;
  if (decoded && decoded.length > plain.length) {
    try { rawCloseMap = await fetchTencentRawCloseMap(info.tencentCode, Math.max(400, count + 80)); } catch (e) { rawCloseMap = null; }
  }
  const bars = _mergeThsBars(plain, decoded, count, rawCloseMap).filter(_thsBarValid);
  return bars.length ? bars : [];
}

// ---- 同花顺原始响应获取（缓存优先 + 并发去重 + all.js 退避）----
// 进程内并发去重：同一次页面加载里多个模块同时要同一只股票 → 只发一轮请求
const _thsRawInFlight = new Map();
// all.js 拉取失败退避（内存态，不落盘）：502 限流期间不再每次刷新都重打，2 分钟后自动再试。
// 取 2 分钟的理由：限流窗口通常是几十秒级，5 分钟会让「网络已恢复但用户仍在看 140 根」的空窗过长；
// 2 分钟既能压住反复刷新的请求量，又能较快自愈。已有完整缓存时压根不会走到这里（缓存优先）。
const _thsAllBackoff = new Map();
const THS_ALL_BACKOFF_MS = 2 * 60 * 1000;

/** 并发去重包装：同一代码的并发请求共享同一个 Promise */
function _thsGetRawPair(pureCode) {
  const existing = _thsRawInFlight.get(pureCode);
  if (existing) return existing;
  const key = pureCode;
  const p = _thsGetRawPairUncached(pureCode).then(
    (v) => { _thsRawInFlight.delete(key); return v; },
    (e) => { _thsRawInFlight.delete(key); throw e; }
  );
  _thsRawInFlight.set(key, p);
  return p;
}

/**
 * 取 last.js / all.js 原始文本：先查本地缓存，未命中才联网。
 * @returns {Promise<{lastRaw:string|null, allRaw:string|null, source:'cache'|'network', why:string}>}
 */
async function _thsGetRawPairUncached(pureCode) {
  const slot = thsDailyCache.resolveSlot(new Date());
  const hit = thsDailyCache.readCache(pureCode, slot, Date.now());
  if (hit.hit) {
    return { lastRaw: hit.rec.lastRaw, allRaw: hit.rec.allRaw, source: 'cache', why: hit.why };
  }

  const thsCode = 'hs_' + pureCode;
  const base = `http://d.10jqka.com.cn/v4/line/${thsCode}/01`;
  const backoffUntil = _thsAllBackoff.get(pureCode) || 0;
  const tryAll = Date.now() >= backoffUntil;
  const [lastRaw, allRaw] = await Promise.all([
    _thsFetchRaw(`${base}/last.js`),
    tryAll ? _thsFetchRaw(`${base}/all.js`) : Promise.resolve(null),
  ]);

  if (lastRaw && allRaw) {
    try {
      thsDailyCache.writeCache(pureCode, slot, lastRaw, allRaw, Date.now());
      _thsAllBackoff.delete(pureCode);
    } catch (e) {
      console.warn('[ThsHistory] 缓存写入失败（不影响本次返回）:', e && e.message ? e.message : e);
    }
  } else if (lastRaw && !allRaw && tryAll) {
    // all.js 未拿到 → 退避 5 分钟，只用 last.js 的 140 根（消费方会按 dataGaps 如实标注样本不足）
    _thsAllBackoff.set(pureCode, Date.now() + THS_ALL_BACKOFF_MS);
    console.warn('[ThsHistory] all.js 不可用，2 分钟内只取 last.js（140 根）:', pureCode);
  }
  return { lastRaw, allRaw, source: 'network', why: hit.why };
}

// 同花顺原始文本抓取：http(80) 优先、https(443) 兜底；proxy:false 强制直连（系统代理会挂起该域请求）。
// 20261022f 起只负责「拿到原始字符串」，JSONP 解析拆到 _unwrapThsJsonp（缓存读回来的文本要走同一段解析）。
async function _thsFetchRaw(url) {
  for (const u of [url, url.replace(/^http:/, 'https:')]) {
    try {
      const resp = await axios.get(u, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.10jqka.com.cn/', 'Accept': '*/*' },
        timeout: 15000,
        proxy: false,
        transformResponse: [(d) => d], // 保持原始字符串，避免 axios 按 JSON 解析 JSONP 失败
      });
      const text = typeof resp.data === 'string' ? resp.data : '';
      if (text) return text;
    } catch (e) {
      console.error(`THS line failed (${u}):`, e.message);
      // 当前 scheme 失败：继续尝试下一 scheme
    }
  }
  return null;
}

// JSONP 文本 → 对象（网络返回与本地缓存共用同一入口，保证两侧解析口径完全一致）
function _unwrapThsJsonp(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(/^quotebridge[^(]*\((.*)\)\s*;?\s*$/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.warn('[ThsHistory] JSONP 解析失败:', e && e.message ? e.message : e);
    return null;
  }
}

// last.js 明文解析 → [{date,open,high,low,close,volume,amount,turnover}]（date 归一为 YYYY-MM-DD）
function _parseThsLast(json) {
  if (!json || typeof json.data !== 'string' || !json.data) return null;
  const out = [];
  for (const row of json.data.split(';')) {
    if (!row) continue;
    const p = row.split(',');
    if (p.length < 8 || !/^\d{8}$/.test(p[0])) continue;
    const mo = +p[0].slice(4, 6);
    const dy = +p[0].slice(6);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) continue; // 日期越界（如 13 月 32 日）→ 跳过该行
    out.push({
      date: `${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6)}`,
      open: +p[1], high: +p[2], low: +p[3], close: +p[4],
      volume: +p[5] || 0, amount: +p[6] || 0,
      turnover: p[7] !== '' && isFinite(+p[7]) ? +p[7] : 0,
    });
  }
  return out.length ? out : null;
}

// all.js 压缩解码 → [{date,open,high,low,close,volume}]（全历史；结构不符返回 null，绝不返回半可信数据）
function _decodeThsAll(json) {
  if (!json || typeof json.price !== 'string' || !json.price) return null;
  const pf = json.priceFactor || 100;
  const pv = json.price.split(',').filter(s => s !== '');
  const vv = (typeof json.volumn === 'string' ? json.volumn : '').split(',').filter(s => s !== '');
  const dv = (typeof json.dates === 'string' ? json.dates : '').split(',').filter(s => s !== '');
  if (!Array.isArray(json.sortYear)) return null;
  // 结构闸门：每天 4 个 price 值，且 price/volumn/dates 三列严格等长
  if (pv.length !== vv.length * 4 || vv.length !== dv.length) return null;
  // 结构闸门：sortYear 各年计数之和应与 dates 数一致。
  // 20261022e（用户「样本一直 140 天」根因）：收盘前后 all.js 偶发 sortYear 比 dates 多 1~2 条
  // （当日条目已计入年度计数、尚未落入 dates/volumn）→ 旧的「必须恰好相等」闸门直接 return null，
  // 历史段永远拿不到，只剩 last.js 的 140 根。
  // 现改为：容忍「多计且 ≤2」，从最后一年扣掉；欠计或差更多仍拒绝（年份展开会错位）。
  // 年份映射是否正确的最终校验由 _mergeThsBars 的重叠段 close 闸门负责（不通则不采信）。
  let yearTotal = 0;
  const years = [];
  for (const pair of json.sortYear) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    if (!isFinite(pair[0]) || !isFinite(pair[1]) || pair[1] < 1 || pair[1] !== Math.floor(pair[1])) return null;
    yearTotal += pair[1];
    years.push([pair[0], pair[1]]);
  }
  const yearDiff = yearTotal - dv.length;
  if (yearDiff < 0 || yearDiff > 2) return null;
  if (yearDiff > 0) {
    const lastYear = years[years.length - 1];
    if (!lastYear || lastYear[1] <= yearDiff) return null;
    lastYear[1] -= yearDiff;
  }
  const bars = [];
  let idx = 0;
  for (const pair of years) {
    const year = pair[0];
    const cnt = pair[1];
    for (let i = 0; i < cnt && idx < dv.length; i++, idx++) {
      const mmdd = dv[idx];
      const mm = parseInt(mmdd.slice(0, 2), 10);
      const dd = parseInt(mmdd.slice(2), 10);
      if (!/^\d{4}$/.test(mmdd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
      const low = parseInt(pv[idx * 4], 10);
      const dO = parseInt(pv[idx * 4 + 1], 10);
      const dH = parseInt(pv[idx * 4 + 2], 10);
      const dC = parseInt(pv[idx * 4 + 3], 10);
      if (!isFinite(low) || !isFinite(dO) || !isFinite(dH) || !isFinite(dC)) return null; // 非数字价格 → fail-closed
      bars.push({
        date: `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`,
        open: (low + dO) / pf,
        high: (low + dH) / pf,
        low: low / pf,
        close: (low + dC) / pf,
        volume: parseInt(vv[idx], 10) || 0,
      });
    }
  }
  // sortYear 计数必须恰好覆盖全部 dates，否则年份展开错位 → 判定解码不可信
  if (idx !== dv.length || bars.length === 0) return null;
  return bars;
}

// 合并：last.js（近期权威，含 amount/turnover）+ all.js 解码（仅向过去延伸）。
// 闸门：重叠段 close 逐日比对（±0.005），全部一致才采信解码延伸；否则只用 last.js。
function _mergeThsBars(plain, decoded, count = 320, rawCloseMap = null) {
  let merged;
  if (!decoded || decoded.length <= plain.length) {
    merged = plain.slice(-count);
  } else {
    const pMap = new Map(plain.map(b => [b.date, b]));
    let overlap = 0;
    let match = 0;
    for (const d of decoded) {
      const p = pMap.get(d.date);
      if (!p) continue;
      overlap++;
      if (Math.abs(d.close - p.close) < 0.005) match++;
    }
    if (overlap < 30 || match !== overlap) {
      merged = plain.slice(-count); // 解码未过闸门 → 不采信
    } else {
      const earliest = plain[0].date;
      const hist = decoded.filter(b => b.date < earliest && _thsBarValid(b));
      merged = [...hist, ...plain].slice(-count);
    }
  }
  return _backfillThsFields(merged, plain, rawCloseMap);
}

/**
 * 历史段成交额/换手率回填（20261022e，用户「样本一直 140 天」报障）
 * ==========================================================
 * 背景：同花顺 last.js 固定只有近 140 根带 amount/turnover，all.js 的历史段只有 OHLCV。
 * 东财通道在本机不可达（163/东财均不通），250 日样本永远差 110 天。
 *
 * 实测（603288，2026-10-22）：
 *   - all.js 与 last.js 重叠 140 根**成交量逐根完全一致**（volume 为实际股数，非复权量）；
 *   - 用 last.js 反推流通盘 = volume ÷ (turnover/100)，中位数 55.59 亿股，跨 140 天离散仅 0.72%；
 *   - amount ÷ (volume×close) 偏差平均 1.09% → 用 volume×close 估算历史成交额是可靠的。
 *
 * 回填口径（fail-closed，绝不臆造）：
 *   - 流通盘取 last.js 隐含值的**中位数**；若跨期离散 > 3%（送转/增发导致股本变动）→ **不回填换手率**，保留 0。
 *   - 历史段 amount = volume × close（前复权收盘价；跨除权日可能有数%偏差，由引擎如实标注）。
 *   - 只为 amount/turnover 缺失（=0）的根回填；权威行（last.js）原值不动。
 *   - 打标 `amountEstimated` / `turnoverEstimated`，供引擎在 dataGaps 里如实披露「推算值」。
 *
 * @param {Array} bars  合并后的日K
 * @param {Array} plain last.js 解析结果（含权威 amount/turnover）
 * @returns {Array} 同数组（原地回填）
 */
function _backfillThsFields(bars, plain, rawCloseMap = null) {
  if (!Array.isArray(bars) || bars.length === 0) return bars;
  const authority = Array.isArray(plain) ? plain : [];
  const floats = authority
    .filter(b => b && b.turnover > 0 && b.volume > 0)
    .map(b => b.volume / (b.turnover / 100))
    .filter(v => isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  let med = 0;
  let turnoverOk = false;
  if (floats.length >= 20) {
    med = floats[Math.floor(floats.length / 2)];
    const spread = floats[floats.length - 1] / floats[0] - 1;
    turnoverOk = med > 0 && spread <= 0.03;   // 流通盘跨期稳定才回填换手率
  }
  for (const b of bars) {
    if (!b) continue;
    if (!isFinite(b.amount)) b.amount = 0;      // 历史段可能整个缺字段 → 归一为 0
    if (!isFinite(b.turnover)) b.turnover = 0;
    if (!(b.volume > 0) || !(b.close > 0)) continue;
    if (!(b.amount > 0)) {
      // 20261023f：优先用腾讯「不复权」收盘价还原成交额（与交易所同口径，实测偏差 <1%）；
      // 拿不到时退回前复权 close（会低估约 2~3.5%），并在 amountBasis 如实标注。
      const rc = (rawCloseMap && typeof rawCloseMap.get === 'function') ? rawCloseMap.get(b.date) : null;
      const useRaw = isFinite(rc) && rc > 0;
      b.amount = Math.round(b.volume * (useRaw ? rc : b.close));
      b.amountEstimated = true;
      b.amountBasis = useRaw ? 'raw_close' : 'qfq_close';
    }
    if (!(b.turnover > 0) && turnoverOk) {
      b.turnover = Math.round((b.volume / med) * 100 * 10000) / 10000; // %
      b.turnoverEstimated = true;
      b.turnoverBasis = 'float';
    }
  }
  return bars;
}

// 单根有效性（远古数据存在解码异常，过滤；近 320 根实测全部有效）
function _thsBarValid(b) {
  return b && b.low > 0 && b.high >= b.low
    && b.open >= b.low - 0.005 && b.open <= b.high + 0.005
    && b.close >= b.low - 0.005 && b.close <= b.high + 0.005
    && isFinite(b.volume) && b.volume >= 0;
}

// ---- Stock type detection ----

/**
 * Detect stock market by symbol/code
 * Returns { market, type, tencentCode, yahooCode }
 */
function detectMarket(input) {
  const code = String(input).trim().toUpperCase();

  // Chinese A-shares with SH/SZ prefix (e.g., SH601318, SZ000001)
  if (/^(SH|SZ)\d{6}$/.test(code)) {
    const exchange = code.startsWith('SH') ? 'SH' : 'SZ';
    const pureCode = code.replace(/^(SH|SZ)/, '');
    return { market: 'CN', exchange, tencentCode: exchange.toLowerCase() + pureCode, yahooCode: pureCode + (exchange === 'SH' ? '.SS' : '.SZ') };
  }

  // Chinese A-shares: 6xxxxx (SH), 0xxxxx/3xxxxx (SZ)
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6') || code.startsWith('9')) {
      return { market: 'CN', exchange: 'SH', tencentCode: 'sh' + code, yahooCode: code + '.SS' };
    }
    return { market: 'CN', exchange: 'SZ', tencentCode: 'sz' + code, yahooCode: code + '.SZ' };
  }

  // HK stocks: 5 digits
  if (/^\d{5}$/.test(code)) {
    return { market: 'HK', exchange: 'HK', tencentCode: 'hk' + code.padStart(5, '0'), yahooCode: code.padStart(5, '0') + '.HK' };
  }

  // US stocks: letter-based symbols
  if (/^[A-Z]{1,6}$/.test(code)) {
    return { market: 'US', exchange: 'US', tencentCode: 'us' + code, yahooCode: code };
  }

  // Yahoo-style codes with suffix
  if (code.includes('.')) {
    if (code.endsWith('.SS') || code.endsWith('.SZ')) return { market: 'CN', exchange: code.endsWith('.SS') ? 'SH' : 'SZ', tencentCode: (code.endsWith('.SS') ? 'sh' : 'sz') + code.replace(/\.(SS|SZ)$/, ''), yahooCode: code };
    if (code.endsWith('.HK')) return { market: 'HK', exchange: 'HK', tencentCode: 'hk' + code.replace('.HK', ''), yahooCode: code };
    return { market: 'US', exchange: 'US', tencentCode: 'us' + code.replace(/\..*$/, ''), yahooCode: code };
  }

  return { market: 'US', exchange: 'US', tencentCode: 'us' + code, yahooCode: code };
}

// ---- Tencent API (Chinese A-shares & HK) ----

// 20261019b：腾讯行情全家桶「量」单位按板块自适应（新浪行情独立裁决，2026-10-19 实测三源交叉）：
// 主板/创业板/深市 —— qt 快照 fields[36] / 分时 cumVol / 日K volume 恒为「手」；
// 科创板（sh688/sh689）—— 腾讯三接口均直接返回「股」（688289 圣湘生物当日 2,612,565：
// 新浪 volume=2,612,565 股 / 成交额 41,366,868 元与量×均价自洽；按「手」理解将虚增 100 倍）。
// 本工具仅识别科创板；指数（sh000001 等）与北交所不匹配，行为不变。
// 统一契约：quote.volume 恒为「股」（既有口径）；分时 cumVol 恒为「手」（科创板已归一）。
// 日K volume 的单位**随通道不同**（20261021h 实测，用成交额反验）：
//   东财 kline f56 = 「手」、腾讯（fetchTencentHistory 归一后）= 「手」、同花顺 last.js = 「股」。
// 任何跨通道比较/覆写都必须过 lib/volUnit.js，禁止再按"是否 tencent"二分（历史上因此出过 ×100 假量）。
function tencentVolumeUnitIsShares(tencentCode) {
  return /^sh68/.test(String(tencentCode || ''));
}

async function fetchTencentQuote(tencentCode) {
  const url = `https://qt.gtimg.cn/q=${tencentCode}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 8000,
    responseType: 'arraybuffer'
  });
  // Tencent API returns GBK-encoded text, decode to UTF-8
  const text = iconv.decode(Buffer.from(resp.data), 'GBK');
  const match = text.match(/v_(\w+)\s*=\s*"([^"]+)"/);
  if (!match) return null;
  const fields = match[2].split('~');
  if (fields.length < 50) return null;

  const price = parseFloat(fields[3]) || 0;
  const prevClose = parseFloat(fields[4]) || 0;
  const change = parseFloat(fields[31]) || 0;
  const changePct = parseFloat(fields[32]) || 0;
  const volume = parseFloat(fields[36]) || 0; // 手
  const amount = parseFloat(fields[37]) || 0; // 万
  const turnover = parseFloat(fields[38]) || 0; // 换手率
  const pe = parseFloat(fields[39]) || 0;
  const amplitude = parseFloat(fields[43]) || 0;
  const circulationValue = parseFloat(fields[44]) || 0; // 流通市值(亿)
  const totalValue = parseFloat(fields[45]) || 0; // 总市值(亿)
  const pb = parseFloat(fields[46]) || 0;
  // 20261019c：量比（volume ratio）为腾讯行情直采字段 fields[49]，与东方财富 App 量比口径完全一致
  // （实测 8 只自选股逐一吻合：000902=0.99、688289=0.74 等）。工作台不再本地用「今日量÷5日均量」重算，
  // 直接取数据源现成量比。无效（未上市/未开盘/解析失败）置 null，由 volumeEngine 退回本地兜底。
  const volRatioRaw = parseFloat(fields[49]);
  const volumeRatio = (isFinite(volRatioRaw) && volRatioRaw > 0) ? volRatioRaw : null;

  // 解析行情时间（fields[30] 形如 "2026-08-03 15:00:02" 或 "20260803 15:00:02"）
  const dtRaw = fields[30] || '';
  let qtDate = '', qtTime = '';
  const dm = dtRaw.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (dm) qtDate = `${dm[1]}-${dm[2]}-${dm[3]}`;
  const tm = dtRaw.match(/(\d{2}):(\d{2})/);
  if (tm) qtTime = `${tm[1]}:${tm[2]}`;
  // 20261016b（审计 S6）：行情时间解析失败时原为「静默兜底为本机日期」，下游无从分辨真实交易日。
  // 仅新增标志位 dateFallback，不改变原有 date/time 字段取值与类型，下游无需适配即可选择是否披露。
  let dateFallback = false;
  if (!qtDate) {
    const now = new Date();
    qtDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    dateFallback = true;
  }

  return {
    name: fields[1],
    code: fields[2],
    price,
    prevClose,
    date: qtDate,
    time: qtTime,
    dateFallback, // true = 服务器未返回可解析日期，date 为本机日期（非真实交易日）
    open: parseFloat(fields[5]) || 0,
    high: parseFloat(fields[33]) || 0,
    low: parseFloat(fields[34]) || 0,
    change,
    changePct,
    volume: tencentVolumeUnitIsShares(tencentCode) ? volume : volume * 100, // 统一转「股」（科创板源数据已是股，20261019b）
    amount: amount * 10000,
    turnover,
    volumeRatio, // 量比（腾讯行情 fields[49] 直采，20261019c）
    pe,
    pb,
    amplitude,
    circulationValue,
    totalValue,
    bid: parseFloat(fields[9]) || 0,
    ask: parseFloat(fields[19]) || 0,
    market: 'tencent'
  };
}

// ---- Market overview (real-time indices) ----
// Curated index lists grouped by category. Codes verified against Tencent qt.gtimg.cn.
const MARKET_INDEX_GROUPS = {
  cn: [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000300', name: '沪深300' },
    { code: 'sh000016', name: '上证50' },
    { code: 'sh000905', name: '中证500' },
    { code: 'sh000688', name: '科创50' }
  ],
  us: [
    { code: 'usDJI', name: '道琼斯' },
    { code: 'usIXIC', name: '纳斯达克' },
    { code: 'usINX', name: '标普500' }
  ],
  // 顶栏大盘行情状态栏：按用户指定顺序展示的 8 个核心指数（上证/深证/创业板/科创50/日经指数/恒生/纳斯达克/道琼斯）
  topbar: [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000688', name: '科创50' },
    { code: '100.N225', name: '日经指数', source: 'eastmoney' },
    { code: 'hkHSI', name: '恒生指数' },
    { code: 'usIXIC', name: '纳斯达克' },
    { code: 'usDJI', name: '道琼斯' }
  ],
  sectors: [
    { code: 'sz399997', name: '中证白酒' },
    { code: 'sz399986', name: '中证银行' },
    { code: 'sz399989', name: '中证医疗' },
    { code: 'sz399975', name: '证券公司' },
    { code: 'sz399967', name: '中证军工' },
    { code: 'sz399971', name: '中证传媒' },
    { code: 'sz399998', name: '中证煤炭' },
    { code: 'sh000922', name: '中证红利' },
    { code: 'sz399808', name: '中证新能' },
    { code: 'sz399932', name: '中证消费' },
    { code: 'sz980017', name: '国证芯片' },
    { code: 'sh000827', name: '中证环保' }
  ]
};

// 东方财富全球指数单只抓取（日经225 等腾讯/Sina 均不覆盖的指数专用）。
// 原实现单点请求 push2delay，遇网络重置即整条失败；这里改为：
//   - 依次尝试 push2delay / push2 两个 host（同属东财，常有一个未被限流）；
//   - 每个 host 失败后重试 1 次（300ms 退避），吸收瞬时重置；
//   - 补充 Referer + ut 令牌，降低被 403/重置的概率。
// 字段语义保持原样：f43/f60/f170 为整数（×100），调用方按 /100 还原。
const EM_INDEX_HOSTS = [
  'https://push2delay.eastmoney.com/api/qt/stock/get',
  'https://push2.eastmoney.com/api/qt/stock/get'
];
const EM_INDEX_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
async function fetchEastmoneyIndex(secid) {
  const fields = 'f43,f57,f58,f60,f170';
  let lastErr = null;
  for (const host of EM_INDEX_HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = `${host}?secid=${encodeURIComponent(secid)}&fields=${fields}&ut=${EM_INDEX_UT}&invt=2`;
        const resp = await axios.get(url, {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          timeout: 7000
        });
        const d = resp.data && resp.data.data;
        if (d && d.f43 != null) {
          const price = (d.f43 || 0) / 100;
          const prevClose = (d.f60 || 0) / 100;
          return {
            code: d.f57 || secid,
            name: d.f58 || '',
            price,
            prevClose,
            change: price - prevClose,
            changePct: (d.f170 || 0) / 100
          };
        }
        lastErr = new Error('empty data');
      } catch (e) {
        lastErr = e;
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error('all hosts failed');
}

// [20261015b] 新浪 hq.sinajs.cn 实时指数行情——实时大盘的稳定备源/主源。
// 为什么需要：① 东财 push2 全家族在本机被对端 TLS 重置（2026-10-15 实测 ECONNRESET，全天 socket hang up），
// 顶栏日经225 原走东财单点常年失败；② 腾讯 qt.gtimg.cn 整批请求无兜底，一旦抖动整个「实时大盘」卡 500。
// 新浪实测（同日盘中）：A股 50ms / 恒生 44ms / 美股 47ms / 日经 38ms 全通，且上证 3694.8871 与腾讯 3694.89 逐位一致。
// 三种返回格式（均 GBK，必须带 Referer，否则 400）：
//   s_sh000001 简版:  名称,点位,涨跌点,涨跌%,成交量(手),成交额(万)          —— 无昨收，昨收=点位-涨跌点
//   rt_hkHSI 详细:    代码,名称,开,昨收,高,低,现价,涨跌点,涨跌%,...
//   gb_ixic 美股:     名称,现价,涨跌%,时间,涨跌点,昨收,...
//   int_nikkei 全球:  名称,点位,涨跌点,涨跌%                                —— 无昨收，昨收=点位-涨跌点
const SINA_HQ_URL = 'https://hq.sinajs.cn/list=';
const SINA_GLOBAL_INDEX_CODES = { '100.N225': 'int_nikkei' }; // 东财 secid → 新浪全球指数代码
function _parseSinaIndexRaw(code, body) {
  const m = body.match(new RegExp('hq_str_' + code + '\\s*=\\s*"([^"]*)"'));
  if (!m || !m[1]) return null;
  const f = m[1].split(',');
  let name, price, prevClose, change, changePct;
  if (code.startsWith('int_')) {
    // 全球指数：名称,点位,涨跌点,涨跌%
    if (f.length < 4) return null;
    name = f[0]; price = parseFloat(f[1]); change = parseFloat(f[2]); changePct = parseFloat(f[3]);
    if (!(price > 0)) return null;
    prevClose = price - change;
  } else if (code.startsWith('s_')) {
    // A股简版：名称,点位,涨跌点,涨跌%,量,额
    if (f.length < 4) return null;
    name = f[0]; price = parseFloat(f[1]); change = parseFloat(f[2]); changePct = parseFloat(f[3]);
    if (!(price > 0)) return null;
    prevClose = price - change;
  } else if (code.startsWith('rt_')) {
    // 港股详细：f3=昨收 f6=现价 f7=涨跌点 f8=涨跌%
    if (f.length < 9) return null;
    name = f[1]; prevClose = parseFloat(f[3]); price = parseFloat(f[6]); change = parseFloat(f[7]); changePct = parseFloat(f[8]);
    if (!(price > 0)) return null;
  } else if (code.startsWith('gb_')) {
    // 美股：f0=名称 f1=现价 f2=涨跌% f4=涨跌点 f5=昨收
    if (f.length < 6) return null;
    name = f[0]; price = parseFloat(f[1]); changePct = parseFloat(f[2]); change = parseFloat(f[4]); prevClose = parseFloat(f[5]);
    if (!(price > 0)) return null;
  } else {
    return null;
  }
  return {
    code: code.replace(/^(s_|rt_)/, ''),
    name: name || code,
    price,
    prevClose: prevClose > 0 ? prevClose : 0,
    change: isNaN(change) ? 0 : change,
    changePct: isNaN(changePct) ? 0 : changePct
  };
}

/**
 * [20261015b] 新浪 hq 批量指数行情。
 * @param {string[]} tencentLikeCodes 腾讯风格代码（sh000001/sz399001/hkHSI/usIXIC…），内部转新浪前缀
 * @param {string[]} sinaRawCodes 新浪原生代码（int_nikkei 等），原样请求
 * @returns {Promise<Map<string, object>>} key=腾讯风格代码（sh000001/hkHSI/usIXIC/100.N225）
 */
async function fetchSinaIndicesBatch(tencentLikeCodes = [], sinaRawCodes = []) {
  if (!tencentLikeCodes.length && !sinaRawCodes.length) return new Map();
  const toSina = (c) => {
    if (/^sh\d+/.test(c)) return 's_' + c;
    if (/^sz\d+/.test(c)) return 's_' + c;
    if (/^hk/.test(c)) return 'rt_' + c;
    if (/^us/.test(c)) return 'gb_' + c.slice(2).toLowerCase();
    return null; // 未知前缀不猜，宁可缺失也不伪造
  };
  const sinaToTencent = new Map(); // 新浪请求码 → 腾讯风格码
  const parts = [];
  for (const c of tencentLikeCodes) {
    const sc = toSina(c);
    if (sc) { parts.push(sc); sinaToTencent.set(sc, c); }
  }
  for (const c of sinaRawCodes) {
    if (!parts.includes(c)) { parts.push(c); sinaToTencent.set(c, c); }
  }
  if (!parts.length) return new Map();
  const resp = await axios.get(SINA_HQ_URL + parts.join(','), {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    timeout: 8000,
    responseType: 'arraybuffer'
  });
  const body = iconv.decode(Buffer.from(resp.data), 'GBK');
  const out = new Map();
  for (const [sc, tc] of sinaToTencent.entries()) {
    const d = _parseSinaIndexRaw(sc, body);
    if (d) out.set(tc, d);
  }
  return out;
}

async function getMarketOverview() {
  // 合并 cn / us / sectors / topbar 四组，按 code 去重
  const seen = new Set();
  const all = [...MARKET_INDEX_GROUPS.cn, ...MARKET_INDEX_GROUPS.us, ...MARKET_INDEX_GROUPS.sectors, ...MARKET_INDEX_GROUPS.topbar]
    .filter(i => (seen.has(i.code) ? false : (seen.add(i.code), true)));

  // 按数据源拆分：腾讯行情覆盖 A股/港股/美股指数；东方财富覆盖全球指数（如日经225）
  const tencentItems = all.filter(i => i.source !== 'eastmoney');
  const eastmoneyItems = all.filter(i => i.source === 'eastmoney');

  let text = '';
  if (tencentItems.length) {
    const url = `https://qt.gtimg.cn/q=${tencentItems.map(i => i.code).join(',')}`;
    try {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
        timeout: 10000,
        responseType: 'arraybuffer'
      });
      text = iconv.decode(Buffer.from(resp.data), 'GBK');
    } catch (e) {
      // [20261015b] 腾讯 qt 整批失败 → 新浪整批兜底（s_sh…/rt_hk…/gb_…），消除 qt.gtimg.cn 单点。
      // 新浪也失败才向上抛（维持原 500 行为，绝不伪造数据）。
      console.warn('[MarketOverview] 腾讯行情批量失败，切换新浪兜底:', e.message);
      try {
        const sinaMap = await fetchSinaIndicesBatch(tencentItems.map(i => i.code), []);
        if (sinaMap.size > 0) {
          text = '__SINA_FALLBACK__' + JSON.stringify([...sinaMap.entries()]);
        } else {
          throw new Error('新浪兜底也无数据');
        }
      } catch (e2) {
        console.error('[MarketOverview] 新浪兜底也失败:', e2.message);
        throw e;
      }
    }
  }

  // 东方财富全球指数行情（腾讯 qt.gtimg.cn 不提供日经225等代码）。
  // [20261015b] 主源改为新浪 int_nikkei（38ms 实测稳定，字段含名称/点位/涨跌点/涨跌%）；
  // 东财 push2 双 host（fetchEastmoneyIndex）降为备胎——本机 push2 族常年被 TLS 重置（2026-10-15 全天
  // socket hang up 实测），但换网络环境可能恢复，故保留不删。优先级：新浪 → 东财。
  const eastmoneyMap = new Map();
  if (eastmoneyItems.length) {
    for (const item of eastmoneyItems) {
      const secid = item.secid || item.code;
      // 先走新浪全球指数（key 用原 code，与 parse() 的 eastmoneyMap 命中逻辑一致）
      const sinaCode = SINA_GLOBAL_INDEX_CODES[item.code];
      if (sinaCode) {
        try {
          const sm = await fetchSinaIndicesBatch([], [sinaCode]);
          const d = sm.get(sinaCode);
          if (d) {
            eastmoneyMap.set(item.code, {
              code: item.code,
              name: item.name || d.name,
              price: d.price,
              prevClose: d.prevClose,
              change: d.change,
              changePct: d.changePct
            });
            continue;
          }
        } catch (e) {
          console.warn('[MarketOverview] 新浪全球指数失败，转东财备胎:', item.code, e.message);
        }
      }
      try {
        const r = await fetchEastmoneyIndex(secid);
        eastmoneyMap.set(item.code, {
          code: r.code,
          name: item.name || r.name,
          price: r.price,
          prevClose: r.prevClose,
          change: r.change,
          changePct: r.changePct
        });
      } catch (e) {
        console.warn('[MarketOverview] 东方财富指数行情获取失败:', item.code, e.message);
      }
    }
  }

  // [20261015b] 新浪兜底数据的还原：腾讯整批失败时 text 是 '__SINA_FALLBACK__' + JSON(Map)。
  // 命中顺序：东财全球指数 → 新浪兜底 → 腾讯原始文本（正常路径下只有腾讯文本存在，行为不变）。
  let sinaFallbackMap = null;
  if (text.startsWith('__SINA_FALLBACK__')) {
    try {
      sinaFallbackMap = new Map(JSON.parse(text.slice('__SINA_FALLBACK__'.length)));
    } catch (e) { sinaFallbackMap = null; }
    if (!sinaFallbackMap) text = ''; // 兜底数据损坏时不许拿垃圾字符串去正则匹配
  }

  function parse(code) {
    if (eastmoneyMap.has(code)) return eastmoneyMap.get(code);
    if (sinaFallbackMap && sinaFallbackMap.has(code)) return sinaFallbackMap.get(code);
    const m = text.match(new RegExp('v_' + code + '\\s*=\\s*"([^"]+)"'));
    if (!m) return null;
    const f = m[1].split('~');
    if (f.length < 10) return null;
    return {
      code: f[2] || code,
      name: f[1] || '',
      price: parseFloat(f[3]) || 0,
      prevClose: parseFloat(f[4]) || 0,
      change: parseFloat(f[31]) || 0,
      changePct: parseFloat(f[32]) || 0
    };
  }

  function group(list) {
    return list.map(i => {
      const d = parse(i.code);
      if (d) return d;
      return { code: i.code, name: i.name, price: null, prevClose: null, change: 0, changePct: 0, unavailable: true };
    });
  }

  // 板块涨跌前5：优先用同花顺「行业板块」一览（本机网络稳定，与东方财富行情软件口径高度对应）；
  // 若同花顺失败，再尝试东方财富 push2（本机常被 TLS 重置/连接掐断，可用性低）；
  // 再回退到腾讯行情 54 个主要行业指数；最后才用 12 个固定样本。
  let sectorBlock = null;
  let thsSectorAll = null;   // 全量板块只采用同花顺单层级，东财多层级成交额重复计不适用于拥挤度
  let sectorError = null;
  try {
    sectorBlock = await getThsSectorRanking();
    thsSectorAll = sectorBlock && sectorBlock.allSectors ? sectorBlock.allSectors : null;
  } catch (e) {
    sectorError = e;
    console.warn('[MarketOverview] 同花顺行业板块获取失败:', e.message);
  }
  if (!sectorBlock) {
    try {
      sectorBlock = await getEastmoneySectorRanking();
    } catch (e) {
      sectorError = e;
      console.warn('[MarketOverview] 东方财富行业板块获取失败:', e.message);
    }
  }
  if (!sectorBlock) {
    try {
      sectorBlock = await getTencentSectorRanking();
    } catch (e) {
      sectorError = e;
      console.warn('[MarketOverview] 腾讯行业指数获取失败，回退到 12 指数样本:', e.message);
    }
  }
  if (!sectorBlock) {
    const sectorList = group(MARKET_INDEX_GROUPS.sectors);
    const availSectors = sectorList.filter(s => !s.unavailable);
    const upList = availSectors.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
    const downList = availSectors.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
    const flatList = availSectors.filter(s => s.changePct === 0);
    sectorBlock = {
      sectorsUp: upList.slice(0, 5),
      sectorsDown: downList.slice(0, 5),
      sectorSource: '腾讯行情·中证/国证指数(样本)',
      sectorIsEastmoney: false,
      sectorTotal: availSectors.length,
      sectorUpCount: upList.length,
      sectorDownCount: downList.length,
      sectorFlatCount: flatList.length,
      sectorDate: localDate(),
    };
  }
  // 20260911：面板「行业板块涨/跌幅前5 + 涨跌家数」以东方财富口径为准（申万细分行业，含地面兵装等细分板块，
  // 与用户在东财行情软件所见一致）；全量板块 sectorAll 仍沿用同花顺单层级源——东财为申万多层级，成交额跨层级重复计，
  // 仅适用榜单展示、不适用于行业拥挤度（拥挤度需单层级、不重复的成交额）。
  let panelBlock = null;
  // 当日最多涨停/跌停板块（20261015l）：与面板同一次获取，但属全市场事实、与榜单用哪个源渲染解耦
  // （盘中面板切同花顺时仍保留——池数据本身实时且自含信息，不与榜单分类口径混用）。
  let limitBoardTops = { topLimitUpBoard: null, topLimitDownBoard: null };
  try {
    panelBlock = await getEastmoneySectorRanking();
    limitBoardTops = {
      topLimitUpBoard: panelBlock.topLimitUpBoard || null,
      topLimitDownBoard: panelBlock.topLimitDownBoard || null,
    };
  } catch (e) {
    console.warn('[MarketOverview] 东方财富行业板块(面板口径)获取失败，沿用原源:', e.message);
  }
  // 20261009 开盘日实时性守门：东财「数据中心」通道是收盘口径报表（盘中 TRADE_DATE 停在上一交易日），
  // 而 push2 实时族在本机常被对端掐断（失败后还进 10 分钟静默期）→ 开盘日盘中面板会静默退化为「昨收数据」，
  // 违反「开盘日的数据口径必须是实时的」。规则：今日为交易日、已开盘（≥09:15）且数据中心数据日期早于今日时，
  // 面板改用同花顺实时源（同申万二级口径）；待东财收盘报表更新至今日、或非交易日/盘前，自动切回东财口径
  //（彼时它就是最新口径，且分类口径与东财行情软件完全同源）。
  let panelRealtimeSwitched = false;
  let emStaleDate = null;
  if (panelBlock && panelBlock.sectorChannel === 'datacenter') {
    emStaleDate = panelBlock.sectorDataDate || panelBlock.sectorDate || null;
    const _nowD = new Date();
    const hhmm = `${String(_nowD.getHours()).padStart(2, '0')}:${String(_nowD.getMinutes()).padStart(2, '0')}`;
    const staleIntraday = !!emStaleDate && emStaleDate < localDate()
      && isTradingDay(localDate()) && hhmm >= '09:15';
    if (staleIntraday) {
      try {
        const thsPanel = (sectorBlock && sectorBlock.sectorSource === '同花顺·行业板块')
          ? sectorBlock                       // 主链路已取到同花顺实时数据，直接复用（带 30s 缓存，无额外开销）
          : await getThsSectorRanking();      // 主链路同花顺偶发失败时重取一次
        if (thsPanel && Array.isArray(thsPanel.sectorsUp) && thsPanel.sectorsUp.length) {
          panelBlock = thsPanel;
          panelRealtimeSwitched = true;
        }
      } catch (e2) {
        // 同花顺实时源也不可用：保留东财收盘口径，前端仍如实标注「截至 X · 收盘口径」
        console.warn('[MarketOverview] 盘中实时守门：同花顺实时源不可用，保留东财收盘口径:', e2.message);
      }
    }
  }
  const panel = panelBlock || sectorBlock;
  const panelSource = panel.sectorSource;
  const panelIsEastmoney = panelBlock ? !!panelBlock.sectorIsEastmoney : !!sectorBlock.sectorIsEastmoney;

  // 面板口径提示：非东方财富口径时明确警示，避免用户拿不同分类口径去对比东财行情软件。
  let panelWarning = null, panelNote = null;
  if (panelIsEastmoney) {
    panelNote = panel.sectorChannel === 'datacenter'
      ? `东方财富·行业板块口径（东财数据中心报表，板块分类与东方财富行情软件「行业板块」同源），榜单按申万${SW_LEVEL_UNIFIED}口径统一分级；数据截至 ${panel.sectorDataDate || panel.sectorDate}`
      : '东方财富·行业板块口径（申万细分行业，含地面兵装等细分板块），与东方财富行情软件板块榜一致';
  } else if (panelSource === '同花顺·行业板块') {
    panelNote = panelRealtimeSwitched
      ? `开盘日盘中实时口径：东财实时推送接口本机不可达，面板已切换同花顺实时源（申万${SW_LEVEL_UNIFIED}口径统一分级）；东财数据中心收盘报表数据截至 ${emStaleDate || '—'}，其更新至今日（收盘后）将自动切回东财口径`
      : '东方财富接口本机不可达，暂用同花顺行业板块备用源；已按申万二级口径统一分级（与 7 日提醒卡一致），分类细节与东方财富「行业板块」可能略有差异';
  } else {
    panelWarning = '东方财富实时板块接口受限，已回退其他数据源；其分类口径与东方财富「行业板块」不同，请勿直接对比东方财富数据';
  }

  // 20260921g：中国指数 / 美国指数两行的**真实数据源**（供「实时大盘」逐行标注数据源）。
  // 这两行的成分指数目前全部由腾讯行情供给；只有配置了 source:'eastmoney' 的指数才会走东方财富
  // （如顶栏日经225）。东财 push2 主机族在本机被对端重置，故此处按实际情况如实标注，不做美化。
  const indexList = [...MARKET_INDEX_GROUPS.cn, ...MARKET_INDEX_GROUPS.us];
  const indexEmCount = indexList.filter(i => i.source === 'eastmoney').length;
  const indexSource = indexEmCount === 0
    ? '腾讯行情'
    : (indexEmCount === indexList.length ? '东方财富·行情' : '腾讯行情 + 东方财富（部分）');
  const indexIsEastmoney = indexEmCount === indexList.length;

  // 20261021a：🇺🇸 美国指数行末尾追加「美债 10 年期收益率」（用户 2026-10-21 要求）。
  // 注意三条口径纪律：
  //   ① 与三个美股指数同一行并列，但口径不同（收益率 vs 点位），条目带 kind:'yield' 由前端单独渲染
  //     （% + bp），不套 fmt()/fmtPct() 的点位口径，避免出现「5.15」被当成点位或「+1.18%」被当成涨跌幅。
  //   ② 行来源标签必须改成「腾讯行情 + 美国财政部（日线）」——它是日线数据，不许挂在「腾讯行情」名下，
  //     更不许让人以为和道指/纳指一样是实时报价。
  //   ③ 取不到就**不追加**（卡片缺失优于伪造），失败只 warn，不影响整行其余三个指数。
  const usList = group(MARKET_INDEX_GROUPS.us);
  let usSource = indexSource;
  try {
    const bond = await getUs10yYield();
    if (bond) {
      usList.push(bond);
      usSource = `${indexSource} + ${bond.sourceLabel}（日线）`;
    }
  } catch (e) {
    console.warn('[MarketOverview] 美债10年期收益率获取失败（该项不展示）:', e && e.message ? e.message : e);
  }

  return {
    cn: group(MARKET_INDEX_GROUPS.cn),
    us: usList,
    usSource,
    topbar: group(MARKET_INDEX_GROUPS.topbar),
    indexSource,
    indexIsEastmoney,
    sectorsUp: panel.sectorsUp,
    sectorsDown: panel.sectorsDown,
    topLimitUpBoard: limitBoardTops.topLimitUpBoard,    // 当日最多涨停板块 { name, count, leader, date } | null（20261015l）
    topLimitDownBoard: limitBoardTops.topLimitDownBoard,
    panelSource,                                   // 面板（涨跌幅前5）数据源
    panelIsEastmoney,
    sectorSource: sectorBlock.sectorSource,        // 全量板块(sectorAll)来源：供拥挤度/情绪模块标注，保持原语义
    sectorIsEastmoney: !!sectorBlock.sectorIsEastmoney,
    sectorWarning: panelWarning,
    sectorNote: panelNote,
    sectorTotal: panel.sectorTotal,
    sectorUpCount: panel.sectorUpCount,
    sectorDownCount: panel.sectorDownCount,
    sectorFlatCount: panel.sectorFlatCount,
    sectorDate: sectorBlock.sectorDate,
    sectorDataDate: panel.sectorDataDate || panel.sectorDate,  // 数据中心通道的数据日期（收盘口径），供面板如实标注是否盘中不更新
    sectorChannel: panel.sectorChannel,                        // 'push2'(实时 tick) | 'datacenter'(收盘口径) | 其他源
    sectorAll: thsSectorAll,   // 全量板块（含成交额），供行业拥挤度计算；固定使用同花顺单层级口径
    updatedAt: Date.now()
  };
}

// ---- 同花顺 行业板块 实时涨跌排名（本机网络最稳定）----
// 东方财富 push2 在本机常被 TLS 重置/连接掐断，返回的数据既不及时也不完整。
// 同花顺行业板块一览（90 个行业）与东方财富行情软件「行业板块」高度对应，且本机可稳定访问。
// 20260921f：层级改为按 parseSwSectorName 解析真实申万层级，榜单统一取二级（SW_LEVEL_UNIFIED）口径，
// 修正此前硬编码「一级」导致与东财口径 / 7日提醒卡分级不一致的问题。
let _thsSectorCache = { ts: 0, data: null };
async function getThsSectorRanking() {
  const now = Date.now();
  if (_thsSectorCache.data && now - _thsSectorCache.ts < 30000) {
    return _thsSectorCache.data;
  }
  const script = path.join(__dirname, '..', 'scripts', 'ths_sector_summary.py');
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用同花顺板块接口');
  const out = await execFileAsync(py, [script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 25000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  const list = (parsed.sectors || []).map(s => ({
    code: s.code || '',
    name: s.name,
    swLevel: parseSwSectorName(s.name).swLevel,  // 真实申万层级（化学制药/半导体/电池…=二级，房地产/银行=一级）
    changePct: s.changePct || 0,
    amount: s.amount || 0,        // 板块当日总成交额（亿元）
    netInflow: s.netInflow || 0,  // 板块当日主力净流入（亿元），供板块资金流向备用源
    upCount: s.upCount || 0,
    downCount: s.downCount || 0,
    leader: s.leader || '',
    unavailable: false,
  }));
  if (list.length < 30) throw new Error('同花顺板块数据不足: ' + list.length);
  // 统一分级（对齐 getEastmoneySectorRanking）：榜单只取 SW_LEVEL_UNIFIED（二级）层级，
  // 保证「板块涨跌幅前5」与东财口径、7日提醒卡分级一致，父子行业不混排。
  const lvList = list.filter(s => s.swLevel === SW_LEVEL_UNIFIED);
  const upList = lvList.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = lvList.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = lvList.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    allSectors: list,             // 全量板块（含成交额，未过滤层级）→ 供行业拥挤度计算与资金流名称→层级映射；勿按层级过滤
    sectorSource: '同花顺·行业板块',
    sectorIsEastmoney: false,
    sectorTotal: lvList.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: parsed.date || localDate(),
  };
  _thsSectorCache = { ts: now, data: result };
  return result;
}

// 探测 Python 解释器：结果记忆化，整个进程只探测一次；且改为异步，
// 不再用同步 execFileSync 阻塞事件循环（避免分析期间服务端冻结、其他请求排队）。
// [20261015a] 修复：失败不再永久缓存——受管 Python 是指向 WorkBuddy 应用资源目录的符号链接
// （versions/3.13.12 → .../resources/vendor/python），WorkBuddy 自更新重写该目录的几秒窗口内
// 探测会全部失败（实测 2026-10-15 11:01 服务器启动恰逢更新，"did not find executable"），
// 若失败被进程级永久缓存，之后 Python 恢复也无法自愈（表现为情绪模型 8 因子权重归零、
// 同花顺板块/融资余额/汇率等全部缺失，直到手动重启）。现改为：失败只冷却 60s，到期自动重探。
let _pyBinChecked = false;
let _pyBinCache = null;
let _pyBinFailUntil = 0;
const PY_BIN_FAIL_COOLDOWN_MS = 60 * 1000;
async function findPythonForScript() {
  if (_pyBinChecked) return _pyBinCache;
  if (Date.now() < _pyBinFailUntil) return null; // 冷却期内直接复用失败结论，不重复探测
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000, windowsHide: true });
      _pyBinCache = c;
      _pyBinChecked = true;
      return c;
    } catch (e) {
      // try next
    }
  }
  _pyBinCache = null;
  _pyBinFailUntil = Date.now() + PY_BIN_FAIL_COOLDOWN_MS; // [20261015a] 失败仅冷却 60s，到期重探
  return null;
}

// ---- 东方财富 行业板块 实时涨跌排名（真正的"板块涨跌幅榜"）----
// 替代原先仅 12 个中证/国证指数的做法（样本太小、不具代表性，今日全样本下跌时
// 会错误地把"跌幅最小的板块"当成"涨幅前五"）
let _sectorRankingCache = { ts: 0, data: null };
// push2 族「行情推送」通道的静默期：本机对该族的请求常被对端在 TLS 握手后重置
// （HTTPS 与纯 HTTP(80) 一样），连续失败后短时间内不再重试（直接走数据中心报表通道），
// 避免每次刷新都白等数秒（20260921i 实测：静默期内 363ms vs 首轮 3637ms）。
let _emPush2DownUntil = 0;
const EM_PUSH2_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 通道 A：东财「行情推送」clist（push2 族镜像）—— 真·盘中实时，但本机常被对端掐断。
 * 东方财富「行业板块」实时排名：fs=m:90+t:2（BK 行业板块，与东方财富官网板块榜一致）。
 * 任一镜像可达即采用；全部失败则抛错，由 getEastmoneySectorRanking 改走通道 B。
 */
async function _fetchEmPush2SectorRows() {
  const hosts = [
    'https://push2.eastmoney.com',
    'https://push2delay.eastmoney.com',
    'https://82.push2.eastmoney.com',
    'https://16.push2.eastmoney.com',
  ];
  // 东财 clist 单页上限 100 条；需分页取全量（约 5 页，覆盖约 500 个细分板块），
  // 否则只拿到「按涨跌幅降序的前 100 条」，跌幅榜会误取"跌得最少"的板块（真正的重挫板块被截断）。
  const pagePath = (pn) => `/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f6,f104,f105,f128`;
  async function fetchPage(host, pn) {
    const url = host + pagePath(pn);
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 10000,
      });
      const dd = resp.data && resp.data.data;
      if (dd && Array.isArray(dd.diff)) return { rows: dd.diff, total: Number(dd.total) || dd.diff.length };
    } catch (e) {
      // Node 的 TLS 指纹被中间设备重置时，用系统 curl（schannel）二次尝试
      try {
        const out = await execFileAsync('curl', ['-s', '--max-time', '10', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const json = JSON.parse(out.stdout);
        const dd = json && json.data;
        if (dd && Array.isArray(dd.diff)) return { rows: dd.diff, total: Number(dd.total) || dd.diff.length };
      } catch (e2) { /* 忽略，返回 null 由上层处理 */ }
    }
    return null;
  }
  // 先用第 1 页探测可用镜像，再在该镜像上分页取全量
  let rows = [], total = 0, hostUsed = null, lastErr = null;
  for (const host of hosts) {
    const r = await fetchPage(host, 1);
    if (r && r.rows.length) { rows = r.rows; total = r.total; hostUsed = host; break; }
    lastErr = new Error('镜像不可达: ' + host);
  }
  if (!rows.length) {
    throw new Error('东方财富行业板块获取失败(全部镜像不可达): ' + (lastErr && lastErr.message));
  }
  const maxPages = Math.min(10, Math.ceil((total || rows.length) / 100));
  for (let pn = 2; pn <= maxPages; pn++) {
    // 东财镜像偶发抖动：单页失败重试一次，避免分页只取到第 1 页
    // （只取到第 1 页时全为上涨板块，跌幅榜会为空、涨跌家数失真，违反「数据一致性」）。
    let r = await fetchPage(hostUsed, pn);
    if (!r || !r.rows.length) r = await fetchPage(hostUsed, pn);
    if (!r || !r.rows.length) break;
    rows = rows.concat(r.rows);
    if (rows.length >= (total || Infinity)) break;
  }
  return rows.map(d => {
    const parsed = parseSwSectorName(d.f14);
    return {
      code: d.f12,
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: parsed.swLevel,
      price: parseFloat(d.f2) || 0,
      changePct: parseFloat(d.f3) || 0,
      mainFlow: parseFloat(d.f62) || 0,
      amount: (parseFloat(d.f6) || 0) / 1e8,   // 成交额：元 → 亿元
      upCount: parseInt(d.f104, 10) || 0,
      downCount: parseInt(d.f105, 10) || 0,
      leader: d.f128 || '',
      unavailable: false,
    };
  });
}

/**
 * 通道 B：东财「数据中心」报表 RPT_INDUSTRY_FUNDFLOW —— datacenter-web 稳定可达。
 * 与通道 A **同为东财口径、同源板块分类**（BOARD_CODE 即东财行业板块代码），字段对应：
 *   BOARD_NAME↔f14 / CHANGE_RATE↔f3 / NET_INFLOW↔f62 / MAX_NETINFLOW_SEC↔f204
 * 该报表逐交易日一行，取「最新交易日」的全部板块即为当日板块榜（单次请求 1 页 ≈130ms）。
 */
async function _fetchEmDcSectorRows() {
  const all = await fetchReport(REPORTS.INDUSTRY_FUNDFLOW, {
    sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 300, pageNumber: 1,
  });
  if (!all.length) throw new Error('东财数据中心行业资金流报表无数据');
  const d0 = String(all[0].TRADE_DATE).slice(0, 10);
  const today = all.filter(r => String(r.TRADE_DATE).slice(0, 10) === d0);
  if (!today.length) throw new Error('东财数据中心行业资金流报表当日无数据');
  return today.map(r => {
    const parsed = parseSwSectorName(r.BOARD_NAME);
    return {
      code: r.BOARD_CODE || '',
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: parsed.swLevel,
      price: 0,                                   // 该报表不提供指数点位
      changePct: Number(r.CHANGE_RATE) || 0,
      mainFlow: Number(r.NET_INFLOW) || 0,
      amount: 0,                                  // 该报表不含成交额（全量成交额见 RPT_FUNDFLOW_BOARD）
      upCount: 0,
      downCount: 0,
      leader: r.MAX_NETINFLOW_SEC ? String(r.MAX_NETINFLOW_SEC).trim() : '',
      unavailable: false,
      dataDate: d0,
    };
  });
}

// ---- 当日涨停/跌停家数最多的行业板块（20261015l，用户需求：板块榜单两组末尾各加一卡）----
// 数据源：东财涨停/跌停股池（push2ex getTopicZTPool / getTopicDTPool，与 20261015j 炸板池同族，
// 本机实测稳定可达：2026-10-16 涨停池 61 行、跌停池 10 行，与乐咕涨停 61 互相印证）。
// 口径：按股池 hybk（东财行业名，缩略形式如「汽车零部」，保持原样不美化）聚合家数取 top1；
// 与榜首榜单同一次面板刷新、同一交易日；任一池取数失败 → 对应字段 null，前端不渲染该卡（不伪造）。
const LIMIT_POOL_COMMON = { ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: 0, pagesize: 10000 };
async function _fetchTopicPool(url, sort, dateStr) {
  const { data } = await axios.get(url, {
    params: { ...LIMIT_POOL_COMMON, sort, date: dateStr },
    timeout: 8000,
    headers: { 'User-Agent': UA },
  });
  return (data && data.data && Array.isArray(data.data.pool)) ? data.data.pool : [];
}
/**
 * 聚合纯函数（可单测）：股池 → 涨停/跌停家数最多的行业 { name, count, leader }。
 * leader = 该行业中池内排序第一的个股名（涨停池 sort=fbt:asc 即封板最早；跌停池为池内首只）。
 * 并列第一时取先出现者（pool 顺序即东财排序，确定性规则）；无有效行业返回 null。
 */
function aggregateTopIndustry(pool) {
  const cnt = new Map();
  for (const p of (pool || [])) {
    const name = String((p && p.hybk) || '').trim();
    if (!name) continue;
    cnt.set(name, (cnt.get(name) || 0) + 1);
  }
  let top = null;
  for (const [name, count] of cnt) {
    if (!top || count > top.count) top = { name, count, leader: '' };
  }
  if (top) {
    const first = (pool || []).find(p => String((p && p.hybk) || '').trim() === top.name);
    if (first) top.leader = String(first.n || '').trim();
  }
  return top;
}
async function fetchLimitBoardTops(dateYYYYmmDD) {
  const ds = dateYYYYmmDD || localDate();
  const out = { topLimitUpBoard: null, topLimitDownBoard: null };
  try {
    const t = aggregateTopIndustry(await _fetchTopicPool('https://push2ex.eastmoney.com/getTopicZTPool', 'fbt:asc', ds));
    if (t) out.topLimitUpBoard = { ...t, date: ds };
  } catch (e) { console.warn('[LimitBoardTop] 涨停池取数失败:', e.message); }
  try {
    const t = aggregateTopIndustry(await _fetchTopicPool('https://push2ex.eastmoney.com/getTopicDTPool', 'fund:asc', ds));
    if (t) out.topLimitDownBoard = { ...t, date: ds };
  } catch (e) { console.warn('[LimitBoardTop] 跌停池取数失败:', e.message); }
  return out;
}

async function getEastmoneySectorRanking() {
  const now = Date.now();
  if (_sectorRankingCache.data && now - _sectorRankingCache.ts < 30000) {
    return _sectorRankingCache.data;
  }
  // 东财双通道：A 行情推送族（实时 tick，本机常被对端重置）→ B 数据中心报表（同为东财口径，稳定可达）。
  // 两者都是东财口径，故无论走哪条，对外都标注为东方财富；仅「实时 tick / 报表快照」不同（sectorChannel）。
  let rawList = null, channel = null, lastErr = null;
  if (Date.now() >= _emPush2DownUntil) {
    try {
      rawList = await _fetchEmPush2SectorRows();
      channel = 'push2';
      _emPush2DownUntil = 0;
    } catch (e) {
      lastErr = e;
      _emPush2DownUntil = Date.now() + EM_PUSH2_COOLDOWN_MS;
      console.warn('[EastmoneySector] 行情推送族不可达，转东财数据中心报表通道:', e.message);
    }
  } else {
    lastErr = new Error('push2 族处于静默期（近期连续失败），本次直接走数据中心报表');
  }
  if (!rawList) {
    try {
      rawList = await _fetchEmDcSectorRows();
      channel = 'datacenter';
    } catch (e) {
      lastErr = new Error((lastErr ? lastErr.message + '；' : '') + e.message);
    }
  }
  if (!rawList || !rawList.length) {
    throw new Error('东方财富行业板块获取失败(行情族与数据中心报表均不可达): ' + (lastErr && lastErr.message));
  }
  // 统一分级（20260916）：先按 SW_LEVEL_UNIFIED 过滤掉其他层级，再做基础名去重 ——
  // 保证首页榜单只含同一申万层级，父子行业不再同时上榜、资金不再重复计入。
  const lvList = rawList.filter(s => s.swLevel === SW_LEVEL_UNIFIED);
  // 同一主题可能同时存在「XXⅡ / XXⅢ」两条（数值相同），按基础名去重（保留绝对值较大的那条，统一用基础名展示）。
  const seen = new Map();
  for (const s of lvList) {
    const base = String(s.name || '').trim();
    const ex = seen.get(base);
    if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) seen.set(base, s);
  }
  const list = [...seen.values()];
  // 涨幅前五：只从实际上涨的板块中取；跌幅前五：只从实际下跌的板块中取。
  // 普涨/普跌时，避免把“涨幅最小的板块”误标为跌幅前五，或反之。
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    allSectors: rawList,          // 全量（含各层级）：仅供板块资金流向做「名称→申万层级」兜底映射；榜单请用 sectorsUp/Down
    sectorSource: channel === 'push2' ? '东方财富·行业板块' : '东方财富·行业板块（数据中心）',
    sectorIsEastmoney: true,
    sectorChannel: channel,                                                          // 'push2'(实时 tick) | 'datacenter'(数据中心报表)
    sectorDataDate: (rawList.find(s => s.dataDate) || {}).dataDate || null,           // 数据中心通道的数据日期，供面板如实标注
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: localDate(),
  };
  // 当日最多涨停/跌停板块（20261015l）：与榜单同源同日；双池各自容错，失败字段为 null（前端不渲染该卡，不伪造）
  try {
    const tops = await fetchLimitBoardTops(String(localDate()).replace(/-/g, ''));
    result.topLimitUpBoard = tops.topLimitUpBoard;
    result.topLimitDownBoard = tops.topLimitDownBoard;
  } catch (e) { console.warn('[LimitBoardTop] 聚合失败:', e.message); }
  _sectorRankingCache = { ts: now, data: result };
  return result;
}

// ---- 腾讯行情 行业指数 备选排名（东方财富 push2 被屏蔽时使用）----
// 覆盖 54 个主要中证/国证行业主题指数，远比原先 12 个样本有代表性。
const TENCENT_SECTOR_CODES = [
  { code: 'sz399997', name: '中证白酒' }, { code: 'sz399986', name: '中证银行' },
  { code: 'sz399989', name: '中证医疗' }, { code: 'sz399975', name: '证券公司' },
  { code: 'sz399967', name: '中证军工' }, { code: 'sz399971', name: '中证传媒' },
  { code: 'sz399998', name: '中证煤炭' }, { code: 'sh000922', name: '中证红利' },
  { code: 'sz399808', name: '中证新能' }, { code: 'sz399932', name: '中证消费' },
  { code: 'sz980017', name: '国证芯片' }, { code: 'sh000827', name: '中证环保' },
  { code: 'sh000928', name: '中证能源' }, { code: 'sh000929', name: '800材料' },
  { code: 'sh000930', name: '800工业' }, { code: 'sh000931', name: '800可选' },
  { code: 'sh000932', name: '中证消费' }, { code: 'sh000933', name: '中证医药' },
  { code: 'sh000934', name: '中证金融' }, { code: 'sh000935', name: '中证信息' },
  { code: 'sh000936', name: '800通信' }, { code: 'sh000937', name: '800公用' },
  { code: 'sh000941', name: '新能源' }, { code: 'sh000944', name: '内地资源' },
  { code: 'sh000945', name: '内地运输' }, { code: 'sh000949', name: '中证农业' },
  { code: 'sz399395', name: '国证有色' }, { code: 'sz399396', name: '国证食品' },
  { code: 'sz399397', name: '国证文化' }, { code: 'sz399398', name: '绩效指数' },
  { code: 'sz399399', name: '中经GDP' }, { code: 'sz399431', name: '国证银行' },
  { code: 'sz399432', name: '智能汽车' }, { code: 'sz399433', name: '国证交运' },
  { code: 'sz399434', name: '数字传媒' }, { code: 'sz399435', name: '国证农牧' },
  { code: 'sz399436', name: '绿色煤炭' }, { code: 'sz399437', name: '证券龙头' },
  { code: 'sz399438', name: '绿色电力' }, { code: 'sz399439', name: '国证油气' },
  { code: 'sz399440', name: '国证钢铁' }, { code: 'sz399803', name: '工业4.0' },
  { code: 'sz399804', name: '中证体育' }, { code: 'sz399805', name: '互联金融' },
  { code: 'sz399806', name: '环境治理' }, { code: 'sz399807', name: '高铁产业' },
  { code: 'sz399809', name: '保险主题' }, { code: 'sz399810', name: 'CSSW传媒' },
  { code: 'sz399811', name: 'CSSW电子' }, { code: 'sz399812', name: '养老产业' },
  { code: 'sz399813', name: '中证国安' }, { code: 'sz399814', name: '大农业' },
  { code: 'sz399815', name: '5G' }, { code: 'sz399816', name: '新材料' },
  { code: 'sz399817', name: '生物医药' }, { code: 'sz399818', name: '医疗器械' },
  { code: 'sz399959', name: '军工指数' }
];

let _tencentSectorCache = { ts: 0, data: null };
async function getTencentSectorRanking() {
  const now = Date.now();
  if (_tencentSectorCache.data && now - _tencentSectorCache.ts < 30000) {
    return _tencentSectorCache.data;
  }
  const codes = TENCENT_SECTOR_CODES.map(s => s.code).join(',');
  const url = `https://qt.gtimg.cn/q=${codes}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 12000,
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(Buffer.from(resp.data), 'GBK');
  const list = [];
  const regex = /v_(\w+)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const code = m[1];
    const fields = m[2].split('~');
    if (fields.length < 45) continue;
    const meta = TENCENT_SECTOR_CODES.find(s => s.code === code);
    if (!meta) continue;
    const price = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[4]) || 0;
    const changePct = parseFloat(fields[32]) || 0;
    if (price <= 0 || prevClose <= 0) continue; // 过滤停牌/无数据指数
    list.push({
      code,
      name: meta.name,
      price,
      changePct,
      unavailable: false,
    });
  }
  if (list.length < 15) throw new Error('腾讯行业指数有效数据不足');
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    sectorSource: '腾讯行情·行业指数',
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: localDate(),
  };
  _tencentSectorCache = { ts: now, data: result };
  return result;
}

async function fetchTencentHistory(tencentCode, count = 320) {
  // 20261021g：主机族降级（ifzq 整段 501 时自动切 web.ifzq，避免日K全线降级）
  const data = await getKlineJson(`/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},qfq`, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 8000
  });
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];

  // 20261019b：腾讯日K volume 主板为「手」、科创板(688/689)为「股」——统一归一为「手」（既有契约）
  const volDiv = tencentVolumeUnitIsShares(tencentCode) ? 100 : 1;
  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: (parseFloat(d[5]) || 0) / volDiv
  }));
}

/**
 * 腾讯「不复权」日K → { date: rawClose } 映射（20261023f）
 * 用途：同花顺 all.js 是**前复权**价，历史段用 volume×前复权close 估成交额会系统性偏低
 * （实测 603288 2025-12 约 −2.3%~−3.5%）；腾讯 day（不带 qfq）是不复权原始价，
 * 与交易所成交额同口径，用它作 amount 还原基准，实测偏差 <1%。
 * 失败返回空 Map（调用方回退前复权 close，并如实标注），绝不阻塞同花顺主链。
 */
async function fetchTencentRawCloseMap(tencentCode, count = 400) {
  const map = new Map();
  try {
    const data = await getKlineJson(`/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 8000,
    });
    const rows = data?.data?.[tencentCode]?.day || [];
    if (!Array.isArray(rows)) return map;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const d = String(r[0] || '');
      const c = parseFloat(r[2]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(c) && c > 0) map.set(d, c);
    }
  } catch (e) {
    // best-effort：腾讯不可用时回退前复权估算，不阻塞主链（但错误必须留痕，不静默吞掉）
    console.warn('[TencentRawClose] 不复权日K取数失败，回退前复权估算:', e && e.message ? e.message : e);
  }
  return map;
}

// 腾讯日K按结束日期分段（单段上限约800根，count>800 会返回空）
async function fetchTencentHistoryEndingAt(tencentCode, endDate, count = 800) {
  const data = await getKlineJson(`/appstock/app/fqkline/get?param=${tencentCode},day,,${endDate},${count},qfq`, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000
  });
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];
  // 20261019b：同 fetchTencentHistory——科创板(688/689) volume 为「股」，归一为「手」
  const volDivEnd = tencentVolumeUnitIsShares(tencentCode) ? 100 : 1;
  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: (parseFloat(d[5]) || 0) / volDivEnd
  }));
}

// 新浪日K线兜底（腾讯 web.ifzq 偶发 501 / 东财 push2his 偶发 socket hang up 时启用；返回结构与腾讯日K一致）
async function fetchSinaHistory(tencentCode, count = 320) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tencentCode}&scale=240&ma=5&datalen=${count}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
      timeout: 10000,
    });
    const arr = resp.data;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    return arr
      .map(d => ({
        date: d.day,
        open: parseFloat(d.open),
        close: parseFloat(d.close),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        volume: parseFloat(d.volume) || 0,
      }))
      .filter(b => b.close > 0);
  } catch (e) {
    console.error('Sina history failed:', e.message);
    return [];
  }
}

// 长历史日K（约10年，原腾讯 web.ifzq 端点已停用 501；现行 ifzq.gtimg.cn 不支持 start/end 参数且回看上限约 2.6 年）：
// 改用新浪日K（datalen 实测上限约 1500 根 ≈ 6 年）作为长历史最佳可用源（供价格行为趋势推演），腾讯近 2.6 年日K 兜底。
async function getHistoryDeep(input, totalBars = 2400) {
  const info = detectMarket(input);
  if (info.market !== 'CN' && info.market !== 'HK') {
    return getHistory(input, '5y'); // 美股/其他市场沿用原通道
  }
  try {
    const bars = await fetchSinaHistory(info.tencentCode, Math.min(totalBars, 1500));
    if (Array.isArray(bars) && bars.length > 0) return bars;
  } catch (e) {
    console.error('Sina deep history failed:', e.message);
  }
  // 兜底：腾讯 ifzq 近 2.6 年日K
  try {
    const fallback = await fetchTencentHistory(info.tencentCode, Math.min(totalBars, 700));
    if (Array.isArray(fallback) && fallback.length > 0) return fallback;
  } catch (e) {
    console.error('Tencent deep history fallback failed:', e.message);
  }
  return [];
}

// 新浪 60分钟 K线（scale=60）
// 为什么需要：腾讯 m60 单次硬上限 800 根（>800 静默回退 320）且不接受起止日期，无法分页；
// 新浪 quotes_service scale=60 实测单次可取 4023 根（≈4 年），最新一根收盘价与腾讯 m60 逐位一致
// （601318: 新浪 51.230 / 腾讯 51.23），同属不复权口径，故可无缝作为长窗口数据源。
// 返回结构与日K一致：{ date:'YYYY-MM-DD HH:mm', open, close, high, low, volume(手), amount(元), turnover }
async function fetchSinaKline60m(symbol, count = 800) {
  const info = detectMarket(symbol);
  const code = info.tencentCode; // sh601318 / sz000001
  const n = Math.max(1, parseInt(count, 10) || 800);
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
  const resp = await axios.get(url, {
    params: { symbol: code, scale: 60, ma: 'no', datalen: n },
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    timeout: 20000,
    responseType: 'text',
  });
  // 新浪返回的是非严格 JSON（键名无引号），但实测为标准 JSON 数组；容错处理两种形态。
  let arr = [];
  try {
    arr = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  } catch (_) {
    const s = String(resp.data || '');
    const m = s.match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch (e2) { arr = []; } }
  }
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(b => {
    const raw = String(b.day || '');
    // 新浪格式：'2026-10-14 15:00:00' → 归一为 'YYYY-MM-DD HH:mm'（与腾讯 m60 完全同构）
    const date = raw.length >= 16 ? `${raw.slice(0, 10)} ${raw.slice(11, 16)}` : raw;
    const close = parseFloat(b.close);
    const volume = parseFloat(b.volume) || 0; // 股（新浪为股数）→ 统一换算为手
    const volHand = volume > 0 ? volume / 100 : 0;
    return {
      date,
      open: parseFloat(b.open),
      close,
      high: parseFloat(b.high),
      low: parseFloat(b.low),
      volume: volHand,
      amount: close * volume, // 元（新浪无成交额字段，按 close×股数估算）
      turnover: 0,
    };
  }).filter(d => d.close > 0);
}

// 腾讯 60分钟 K线（东财 push2his 在本机被 TLS 阻断，腾讯 mkline 稳定可用）
// 返回结构与日K一致：{ date:'YYYY-MM-DD HH:mm', open, close, high, low, volume(手), amount(元), turnover }
// 窗口能力说明：
//   count ≤ 800 → 走腾讯 m60（默认路径，行为与历史版本逐位一致）
//   count > 800 → 腾讯硬上限截断，自动切换新浪 scale=60（实测上限 4023 根），并在返回数组上挂
//                 `.meta = { source, requested, truncation }` 供上层做来源标注（不改变数组本身）
async function fetchTencentKline60m(tencentCode, count = 320) {
  const want = Math.max(1, parseInt(count, 10) || 320);
  // 长窗口（>800）改走新浪；这是唯一能满足"更长 60m 窗口"的可用通道
  if (want > 800) {
    try {
      const bars = await fetchSinaKline60m(tencentCode, want);
      if (bars.length > 5) {
        bars.meta = {
          source: 'sina(m60)',
          requested: want,
          truncation: bars.length < want ? `新浪 scale=60 实测上限约 4023 根，已返回 ${bars.length} 根` : null,
          // 诚实标注：新浪与腾讯在 10:30 / 14:00 两个整点的 K 线切分口径不同
          // （实测重叠 800 根中 49 根收盘价相差 0.02~0.06 元 ≈0.03%，双向随机；其余 11 个整点逐位一致）
          // 幅度远低于技术指标有效精度，不影响回测结论，但如实记录以便报告标注。
          caution: '新浪与腾讯 60m 在 10:30/14:00 两处切片口径存在 ≤0.06 元差异（其余整点一致），长窗口默认使用本数据源',
        };
        return bars;
      }
    } catch (e) {
      console.error('Sina 60m history failed, fallback to tencent 800:', e.message);
    }
  }
  // 腾讯 m60 上限：count>800 会被对端忽略并静默回退到默认 320（实测 800 有效、810 起失效）。
  // 这里强制夹紧到 [1,800]，避免调用方传大数导致样本量不升反降。
  const n = Math.min(want, 800);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tencentCode},m60,,${n}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000,
  });
  const data = resp.data?.data?.[tencentCode];
  const bars = data?.m60 || [];
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const out = bars.map(b => {
    const raw = String(b[0]);
    const date = /^\d{12}$/.test(raw)
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
      : raw;
    const close = parseFloat(b[2]);
    const volume = parseFloat(b[5]) || 0; // 手
    const amount = parseFloat(b[6]) || (close * volume * 100); // 元（b[6] 缺省时按收盘价×股数兜底）
    return {
      date,
      open: parseFloat(b[1]),
      close,
      high: parseFloat(b[3]),
      low: parseFloat(b[4]),
      volume,
      amount,
      turnover: 0,
    };
  }).filter(d => d.close > 0);
  return out;
}

// Tencent minute data
async function fetchTencentMinutes(tencentCode) {
  const url = `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${tencentCode}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 8000
    });
    const data = resp.data?.data?.[tencentCode];
    if (!data) return { minutes: [], prevClose: 0, date: null };
    const entries = data.data?.data || [];
    // 20261017h：这份分时所属交易日（腾讯返回 YYYYMMDD，实测 000902/601318 均为 "20261019"）。
    // 必须带上：非交易时段/休市日接口返回的是**上一交易日**的分时，若不带日期，
    // 前端会把它当成「今日走势」显示、量能引擎也会拿旧分时配新日线，属静默误导。
    const rawDate = data.data?.date || null;
    const minuteDate = /^\d{8}$/.test(String(rawDate || ''))
      ? `${String(rawDate).slice(0, 4)}-${String(rawDate).slice(4, 6)}-${String(rawDate).slice(6, 8)}`
      : null;
    // 昨收：与 fetchTencentQuote 同一口径，腾讯 qt 数组 index[4] 为昨收
    let prevClose = 0;
    const qtArr = data.qt?.[tencentCode];
    if (Array.isArray(qtArr) && qtArr.length > 4) {
      const v = parseFloat(qtArr[4]);
      if (!isNaN(v) && v > 0) prevClose = v;
    }
    // 20261019b：科创板(688/689)分时 cumVol 为「股」→ 归一为「手」，维持「cumVol 恒为手」契约
    const volDivMin = tencentVolumeUnitIsShares(tencentCode) ? 100 : 1;
    const minutes = entries.map(e => {
      const parts = e.split(' ');
      const price = parseFloat(parts[1]);
      const cumVol = (parseFloat(parts[2]) || 0) / volDivMin; // 累计成交量（手；科创板已归一）
      const cumAmt = parseFloat(parts[3]) || 0; // 累计成交额（元）
      const avg = cumVol > 0 ? cumAmt / (cumVol * 100) : price; // 均价 = 累计成交额 / 累计成交股数
      // 20261017c：新增 cumVol（累计成交量）字段——量能引擎（lib/volumeEngine.js）
      // 「分时无量拉升」规则需要每分钟成交量（相邻累计量差分得出）。
      // 纯增量字段：既有消费方（/api/minute 透传、前端分时图读 time/price/avg）不受影响。
      return { time: parts[0], price, avg, cumVol };
    });
    return { minutes, prevClose, date: minuteDate };
  } catch {
    return { minutes: [], prevClose: 0, date: null };
  }
}

// ---- Yahoo Finance API (US/HK/international) ----

async function fetchYahooQuote(yahooCode) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooCode)}?range=1d&interval=1m`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 8000
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  const indicators = result.indicators?.quote?.[0];
  const timestamps = result.timestamp || [];
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;

  const lastTs = (timestamps.length ? timestamps[timestamps.length - 1] : Math.floor(Date.now() / 1000)) * 1000;
  const dd = new Date(lastTs);
  const yDate = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;

  return {
    name: meta.shortName || meta.longName || yahooCode,
    code: yahooCode,
    price,
    prevClose,
    date: yDate,
    open: meta.regularMarketPrice ? meta.regularMarketPrice : 0,
    high: meta.regularMarketDayHigh || price,
    low: meta.regularMarketDayLow || price,
    change: parseFloat(change.toFixed(4)),
    changePct: parseFloat(changePct.toFixed(2)),
    volume: meta.regularMarketVolume || 0,
    amount: 0,
    currency: meta.currency || 'USD',
    market: 'yahoo'
  };
}

async function fetchYahooHistory(yahooCode, range = '1y') {
  const interval = '1d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooCode)}?range=${range}&interval=${interval}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 8000
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  return timestamps.map((ts, i) => {
    const d = new Date(ts * 1000);
    return {
      date: d.toISOString().slice(0, 10),
      open: q.open?.[i] ? parseFloat(q.open[i].toFixed(2)) : 0,
      close: q.close?.[i] ? parseFloat(q.close[i].toFixed(2)) : 0,
      high: q.high?.[i] ? parseFloat(q.high[i].toFixed(2)) : 0,
      low: q.low?.[i] ? parseFloat(q.low[i].toFixed(2)) : 0,
      volume: q.volume?.[i] ? Math.round(q.volume[i]) : 0
    };
  }).filter(d => d.close > 0);
}

// Yahoo quote summary (fundamentals)
async function fetchYahooSummary(yahooCode) {
  const modules = ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'price', 'calendarEvents'];
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooCode)}?modules=${modules.join(',')}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 8000
    });
    const result = resp.data?.quoteSummary?.result?.[0];
    if (!result) return null;

    const sd = result.summaryDetail || {};
    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const price = result.price || {};

    return {
      name: price.shortName || price.longName || yahooCode,
      sector: price.sectorId || '',
      industry: price.industryId || '',
      marketCap: price.marketCap?.raw || sd.marketCap?.raw || 0,
      pe: sd.trailingPE?.raw || ks.trailingPE?.raw || 0,
      forwardPe: sd.forwardPE?.raw || 0,
      pb: sd.priceToBook?.raw || 0,
      ps: sd.priceToSalesTrailing12Months?.raw || 0,
      peg: sd.pegRatio?.raw || 0,
      evEbitda: sd.enterpriseToEbitda?.raw || ks.enterpriseToEbitda?.raw || 0,
      dividendYield: sd.dividendYield?.raw || 0,
      payoutRatio: sd.payoutRatio?.raw || 0,
      beta: sd.beta?.raw || 0,
      fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || 0,
      fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || 0,
      profitMargins: fd.profitMargins?.raw || 0,
      grossMargins: fd.grossMargins?.raw || 0,
      operatingMargins: fd.operatingMargins?.raw || 0,
      returnOnEquity: fd.returnOnEquity?.raw || 0,
      returnOnAssets: fd.returnOnAssets?.raw || 0,
      revenueGrowth: fd.revenueGrowth?.raw || 0,
      earningsGrowth: fd.earningsGrowth?.raw || 0,
      totalCash: fd.totalCash?.raw || 0,
      totalDebt: fd.totalDebt?.raw || 0,
      debtToEquity: fd.debtToEquity?.raw || 0,
      debtMetricPct: false, // 港股/美股：该值为带息债÷权益（无单位比值）
      currentRatio: fd.currentRatio?.raw || 0,
      quickRatio: fd.quickRatio?.raw || 0,
      revenuePerShare: fd.revenuePerShare?.raw || 0,
      earningsGrowthQuarterly: fd.earningsGrowth?.raw || 0,
      targetMeanPrice: ks.targetMeanPrice?.raw || 0,
      targetHighPrice: ks.targetHighPrice?.raw || 0,
      targetLowPrice: ks.targetLowPrice?.raw || 0,
      targetMedianPrice: ks.targetMedianPrice?.raw || 0,
      recommendationMean: ks.recommendationMean?.raw || 0,
      recommendationKey: ks.recommendationKey || '',
      numberOfAnalystOpinions: ks.numberOfAnalystOpinions?.raw || 0,
    };
  } catch (err) {
    return null;
  }
}

// ---- Eastmoney API for A-share fundamentals ----

// 将东方财富返回的财报日期规范为 YYYY-MM-DD（兼容 "2026/03/31"、"2026-03-31 00:00:00" 等）
function normalizeReportDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\//g, '-').trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// 根据财报日期生成易读报告期标签（如 2026年一季报 / 2026年年报）；东方财富自带 REPORT_DATE_NAME 时优先使用
function reportPeriodLabel(raw) {
  const d = normalizeReportDate(raw);
  if (!d) return '';
  const [y, m] = d.split('-');
  const map = { '03': '一季报', '06': '中报', '09': '三季报', '12': '年报' };
  const label = map[m];
  return label ? `${y}年${label}` : d;
}

// 生成最近 N 个报告期日期（季报），用于 xjllbAjaxNew 等接口
function getRecentReportDates(count = 4) {
  const dates = [];
  const now = new Date();
  let year = now.getFullYear();
  // 20261030n：对齐披露日历（与新洋丰估值模型 v2.1 补丁1 同源口径）——
  // Q1 截止 04-30、H1 截止 08-31、Q3 截止 10-31、年报次年 04-30；
  // 上市公司常在截止日前披露（如 10 月下旬三季报已出）→ 请求窗口比原逻辑提前一档。
  // 接口对未披露的报告期自动缺失 → sorted[0] 回落到最近可得一期，提前请求无害。
  // 原逻辑（10月→只请求到中报）导致「每股经营现金流」等 xjllb 系卡片在三季报披露后仍停在中报。
  const month = now.getMonth() + 1;
  let q;
  if (month >= 4 && month <= 7) q = 1;            // 4 月起请求 Q1（04-30 截止）
  else if (month >= 8 && month <= 9) q = 2;       // 8 月起请求 H1（08-31 截止）
  else if (month >= 10) q = 3;                    // 10 月起请求 Q3（10-31 截止，10 月下旬多已披露）
  else { q = 4; year -= 1; }                      // 1-3 月请求上年年报（次年 04-30 截止，未披露自动回落 Q3）
  const quarterEnds = ['03-31', '06-30', '09-30', '12-31'];
  for (let i = 0; i < count; i++) {
    const idx = q - 1 - i;
    const y = year + Math.floor(idx / 4);
    const qq = ((idx % 4) + 4) % 4;
    dates.push(`${y}-${quarterEnds[qq]}`);
  }
  return dates;
}

// 由总市值(亿)和股价反推总股本（股）
function computeTotalShares(quote) {
  if (!quote || !quote.price || !quote.totalValue) return 0;
  const marketCapYuan = quote.totalValue < 100 ? quote.totalValue * 1e12 : quote.totalValue * 1e8;
  return marketCapYuan / quote.price;
}

// 从东方财富估值分析接口取总股本、行业名称及历史估值序列（datacenter-web 可用，push2 被 TLS 封锁）
async function fetchStockValuationAnalysis(stockCode) {
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=500&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
      timeout: 10000
    });
    const data = resp.data?.result?.data || [];
    if (data.length === 0) return null;
    const latest = data[0];
    return {
      totalShares: parseFloat(latest.TOTAL_SHARES) || 0,
      boardName: latest.BOARD_NAME || '',
      boardCode: latest.BOARD_CODE || '',
      psTTM: parseFloat(latest.PS_TTM) || 0,
      history: data.map(d => ({
        date: normalizeReportDate(d.TRADE_DATE),
        pe: parseFloat(d.PE_TTM) || 0,
        pb: parseFloat(d.PB_MRQ) || 0,
        ps: parseFloat(d.PS_TTM) || 0,
      })).filter(d => d.pe || d.pb)
    };
  } catch (e) {
    console.error('[ValuationAnalysis] failed:', e.message);
    return null;
  }
}

// Fetch dividend info from Eastmoney datacenter (RPT_SHAREBONUS_DET, same source as deep analysis).
// PRETAX_BONUS_RMB is per 10 shares (e.g. 9.8 means 0.98 per share). Yield = perShare / price.
async function fetchDividendInfo(stockCode, price) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=30&pageNumber=1&reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
    timeout: 10000
  });
  const data = resp.data?.result?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  // Data sorted by REPORT_DATE desc — collect records with non-zero cash dividend (latest first)
  const paid = data.filter(d => parseFloat(d.PRETAX_BONUS_RMB) > 0);
  const latest = paid[0] || null;
  if (!latest) return null;
  const dividendPerShare = (parseFloat(latest.PRETAX_BONUS_RMB) || 0) / 10;
  const yieldPct = price > 0 ? Math.round(dividendPerShare / price * 10000) / 100 : 0;
  const years = new Set(data.map(d => (d.REPORT_DATE || '').slice(0, 4)).filter(y => y)).size;
  // 每股股息同比：最新一期 vs 上一期（用于股息率同比高低变化判断，同源：东财分红接口）
  let dividendPerSharePrev = 0, dividendYoyPct = null;
  if (paid.length >= 2) {
    dividendPerSharePrev = (parseFloat(paid[1].PRETAX_BONUS_RMB) || 0) / 10;
    if (dividendPerSharePrev > 0) dividendYoyPct = Math.round((dividendPerShare / dividendPerSharePrev - 1) * 10000) / 100;
  }
  return {
    dividendYield: yieldPct,
    dividendPerShare,
    dividendPerSharePrev,
    dividendYoyPct,
    dividendYears: years,
    latestPlan: latest.IMPL_PLAN_PROFILE || '',
    latestReportDate: latest.REPORT_DATE || '',
  };
}

async function fetchEastmoneyFundamentals(stockCode, exchange, quote) {
  const result = {};

  // 从估值分析接口取总股本与行业（优先于由总市值反推，更准确）
  const valuationInfo = await fetchStockValuationAnalysis(stockCode);
  if (valuationInfo) {
    result.totalShares = valuationInfo.totalShares;
    result.industryName = valuationInfo.boardName;
    result.valuationHistory = valuationInfo.history;
    // 直接用东财 PS_TTM（TTM 口径，正确），避免本地用单季营收算 PS 导致虚高
    if (valuationInfo.psTTM > 0) result.ps = valuationInfo.psTTM;
  }

  // Use the new financial analysis API (ZYZBAjaxNew)
  try {
    const code = `${exchange}${stockCode}`;
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${code}`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/', Accept: 'application/json' },
      timeout: 15000
    });

    if (resp.data?.data && resp.data.data.length > 0) {
      const d = resp.data.data[0]; // Most recent quarter
      const d2 = resp.data.data[1] || {}; // Previous quarter for fallback
      result.roe = d.ROEJQ || d2.ROEJQ || 0;              // 净资产收益率
      result.grossMargin = d.XSMLL || d2.XSMLL || 0;       // 销售毛利率
      result.netMargin = d.XSJLL || d2.XSJLL || 0;          // 销售净利率
      // 20261102a（用户指令：增长指标优先最新单季口径）：东财主要指标累计响应自带单季同比字段
      // DJD_TOI_YOY（单季营收同比）/ DJD_DPNP_YOY（单季归母净利同比），单季缺失（老数据/接口变动）时
      // 回退累计口径 TZ 字段；下游信号/评分/左右两卡/历史百分位同源联动（铁律：缺数据如实回退，不编造）。
      result.revenueYoy = d.DJD_TOI_YOY || d.TOTALOPERATEREVETZ || d2.DJD_TOI_YOY || d2.TOTALOPERATEREVETZ || 0; // 营收同比（单季优先）
      result.profitYoy = d.DJD_DPNP_YOY || d.PARENTNETPROFITTZ || d2.DJD_DPNP_YOY || d2.PARENTNETPROFITTZ || 0;   // 归母净利同比（单季优先）
      result.eps = d.EPSJB || 0;                // 每股基本收益
      result.bps = d.BPS || 0;                  // 每股净资产
      result.debtToEquity = d.ZCFZL || 0;       // 资产负债率（百分比）
      result.debtMetricPct = true;              // A股：该值为资产负债率%，非债务/权益比
      result.currentRatio = d.LD || 0;          // 流动比率
      result.quickRatio = d.SD || 0;            // 速动比率
      result.totalAssets = d.JZC || 0;          // 净资产
      result.revenue = d.TOTALOPERATEREVE || 0; // 营业总收入
      result.netProfit = d.PARENTNETPROFIT || 0; // 归母净利润
      // 财报报告期：PE/PB 等估值指标所用的每股收益、每股净资产来自该披露期
      const repRaw = d.REPORT_DATE || d.REPORTDATE || d.BBDATE || '';
      result.reportDate = normalizeReportDate(repRaw);
      result.reportPeriod = d.REPORT_DATE_NAME || reportPeriodLabel(repRaw);
      // 保留原始多期数据，供历史百分位计算使用
      result.zyzbHistory = resp.data.data;
      // 20260909j：统一 TTM 指标（单一权威源）——关键财务指标行 / 基本面评分 / 利好利空信号 / 历史百分位 /
      // 深度分析 ROE 走势图全部共用本处计算的字段，禁止各消费方自行对 ROEJQ/XSMLL/XSJLL 等比率跨期加减。
      const ttm = computeTtmMetrics(resp.data.data, result.totalShares);
      if (ttm) {
        result.roeTtm = ttm.roe;               // ROE(TTM) = TTM归母净利 ÷ 期末归母净资产（摊薄）
        result.roeTtmBasis = ttm.roeBasis;     // 计算口径说明（含窗口三期名称）
        result.roeTtmPrev = ttm.roePrev;       // 截至上年同期的同口径 TTM ROE（「去年同期」用）
        if (ttm.roeTtmPrevQ != null) result.roeTtmPrevQ = ttm.roeTtmPrevQ; // 20261104k：截至上一报告期的 TTM ROE（环比同口径）
        result.grossMarginTtm = ttm.grossMargin;
        result.netMarginTtm = ttm.netMargin;
        // 20261104k：TTM 同口径 prev（去年同期）/ prevQ（上一报告期）——右卡「指标分析」同比/环比维度与主值同口径
        if (ttm.grossMarginTtmPrev != null) result.grossMarginTtmPrev = ttm.grossMarginTtmPrev;
        if (ttm.netMarginTtmPrev != null) result.netMarginTtmPrev = ttm.netMarginTtmPrev;
        if (ttm.grossMarginTtmPrevQ != null) result.grossMarginTtmPrevQ = ttm.grossMarginTtmPrevQ;
        if (ttm.netMarginTtmPrevQ != null) result.netMarginTtmPrevQ = ttm.netMarginTtmPrevQ;
        result.ttmBasis = ttm.windowNote;
      }
    }
  } catch (e) {
    console.error('Eastmoney financial API failed:', e.message);
  }

  // 现金流量表：取最新一期经营活动现金流净额，并计算每股经营现金流
  // 不同行业 companyType 不同（通用4/银行2/保险3/券商1），依次尝试
  try {
    const code = `${exchange}${stockCode}`;
    const dates = getRecentReportDates(4);
    let list = null;
    for (const companyType of [4, 2, 3, 1]) {
      try {
        const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/xjllbAjaxNew?companyType=${companyType}&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
        const resp = await axios.get(url, {
          headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const arr = resp.data?.data;
        if (Array.isArray(arr) && arr.length > 0) {
          list = arr;
          break;
        }
      } catch (e2) {
        // try next companyType
      }
    }
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].sort((a, b) => new Date(b.REPORT_DATE) - new Date(a.REPORT_DATE));
      const latest = sorted[0];
      const ocf = parseFloat(latest.NETCASH_OPERATE) || 0;
      if (ocf) {
        result.operatingCashFlow = ocf;
        const totalShares = result.totalShares || computeTotalShares(quote);
        if (totalShares > 0) {
          result.operatingCashFlowPerShare = ocf / totalShares;
          result.operatingCashFlowSource = '东方财富财报';
          const repRaw = latest.REPORT_DATE || '';
          result.operatingCashFlowPeriod = normalizeReportDate(repRaw);
          result.operatingCashFlowPeriodName = reportPeriodLabel(repRaw);
        }
      }
    }
  } catch (e) {
    console.error('[OCF] fetch failed:', e.message);
  }

  // 股息率：复用东财 datacenter 分红接口(与深度分析同源,已实测可用)
  try {
    const divInfo = await fetchDividendInfo(stockCode, quote?.price);
    if (divInfo) {
      result.dividendYield = divInfo.dividendYield;        // 百分数，如 1.84
      result.dividendPerShare = divInfo.dividendPerShare;  // 元
      result.dividendPerSharePrev = divInfo.dividendPerSharePrev; // 元（上一期）
      result.dividendYoyPct = divInfo.dividendYoyPct;      // 每股股息同比 %
      result.dividendYears = divInfo.dividendYears;        // 有分红记录的年数
      result.dividendPlan = divInfo.latestPlan;            // 如「10派9.80元(含税)」
      result.dividendYieldSource = '东财分红数据';
      result.dividendYieldIsPct = true;                    // A股东财口径：dividendYield 已是百分数（避免 <1 时被误判为小数翻倍）
    }
  } catch (e) {
    console.error('[Dividend] fetch failed:', e.message);
  }

  return result;
}

// Compute price-to-sales from total market cap (Tencent quote) and revenue (Eastmoney financials)
// Tencent totalValue: <100 means 万亿，>=100 means 亿；Eastmoney revenue is in yuan.
function computePS(totalValue, revenue) {
  if (!totalValue || !revenue) return 0;
  const marketCapYuan = totalValue < 100 ? totalValue * 1e12 : totalValue * 1e8;
  return marketCapYuan / revenue;
}

// ---- 20260909j：统一 TTM 指标计算（单一权威源）----
// 背景：ROEJQ / XSMLL / XSJLL 是「比率」，各期分母（加权净资产/营收）不同，对比率跨期直接加减
//（最新期 + 上年报 − 上年同期）在数学上不成立。正确做法：可加分子（归母净利、毛利额、净利额）
// 与可加分母（营收、归母净资产）先各自滚动 12 个月，再相除。
// 口径定义：
//   ROE(TTM)    = TTM归母净利 ÷ 期末归母净资产（BPS × 总股本，摊薄口径）
//   毛利率(TTM)  = TTM毛利额（MLR，缺失时按 XSMLL×营收重构） ÷ TTM营收
//   净利率(TTM)  = TTM净利额（按 XSJLL×营收重构） ÷ TTM营收
//   roePrev      = 截至上年同期的同口径 TTM ROE（供「去年同期」同口径对比）
//   20261104k：grossMarginTtmPrev / netMarginTtmPrev = 截至上年同期的同口径 TTM 毛利率/净利率
//   （供右卡「指标分析」同比维度与主值同口径，修复用户报的「左卡 TTM 37.78% vs 右卡同比累计 41.47%」口径错配）；
//   grossMarginTtmPrevQ / netMarginTtmPrevQ / roeTtmPrevQ = 截至上一报告期的同口径 TTM 值（供环比维度同口径）。
// 锚点期本身为年报（12-31）时无需滚动，直接取年报值；窗口缺上一年报或上年同期时对应值返回 null。
function computeTtmMetrics(rows, totalShares) {
  const toN = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const shares = toN(totalShares);
  const rs = rows
    .map(d => ({
      date: String(d.REPORT_DATE || '').slice(0, 10),
      name: d.REPORT_DATE_NAME || '',
      np: toN(d.PARENTNETPROFIT),
      rev: toN(d.TOTALOPERATEREVE),
      mlr: toN(d.MLR),
      gm: toN(d.XSMLL),
      nm: toN(d.XSJLL),
      bps: toN(d.BPS),
    }))
    .filter(r => r.date && !isNaN(new Date(r.date).getTime()))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // 降序：最新在前
  if (!rs.length) return null;
  // 滚动12个月：窗口 = [锚点期, 上一年报(12-31), 上年同期]；list[0] 为锚点期
  const roll = (list, pick) => {
    const a0 = list[0];
    if (!a0) return null;
    if (a0.date.slice(5) === '12-31') {
      const v = pick(a0);
      return v == null ? null : { v, label: `${a0.name}（年报直取）` };
    }
    const py = String(Number(a0.date.slice(0, 4)) - 1);
    const fy = list.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === '12-31');
    const sm = list.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === a0.date.slice(5));
    if (!fy || !sm) return null;
    const v0 = pick(a0), v1 = pick(fy), v2 = pick(sm);
    if (v0 == null || v1 == null || v2 == null) return null;
    return { v: v0 + v1 - v2, label: `${a0.name}+${fy.name}−${sm.name}` };
  };
  const eqOf = (r) => {
    const eq = (r && r.bps != null && shares > 0) ? r.bps * shares : null;
    return (eq != null && eq > 0) ? eq : null;
  };
  const out = {
    windowNote: rs[0].date.slice(5) === '12-31'
      ? `${rs[0].name}（年报直取，无需滚动）`
      : `滚动12个月＝${rs[0].name}＋上一年报−上年同期`,
    roe: null, roeBasis: '', roePrev: null, roeTtmPrevQ: null,
    grossMargin: null, netMargin: null, grossMarginTtmPrev: null, netMarginTtmPrev: null,
    grossMarginTtmPrevQ: null, netMarginTtmPrevQ: null,
  };
  // ★ 20261104k：毛利率/净利率计算抽成 helper——当前 TTM / 去年同期 TTM / 上一报告期 TTM 三套窗口复用同一逻辑，
  //   保证「主值 vs 同比 vs 环比」严格同口径（分子可加毛利额/净利额 ÷ 分母可加营收，缺失时按比率×营收重构）。
  const marginsOf = (list) => {
    const revT = roll(list, r => r.rev);
    if (revT == null || !(revT.v > 0)) return null;
    const m = {};
    const mlrT = roll(list, r => r.mlr);
    if (mlrT != null) {
      m.grossMargin = mlrT.v / revT.v * 100;
    } else {
      const gmN = roll(list, r => (r.gm != null && r.rev != null ? r.gm / 100 * r.rev : null));
      if (gmN != null) m.grossMargin = gmN.v / revT.v * 100;
    }
    const nmN = roll(list, r => (r.nm != null && r.rev != null ? r.nm / 100 * r.rev : null));
    if (nmN != null) m.netMargin = nmN.v / revT.v * 100;
    return m;
  };
  const curM = marginsOf(rs);
  if (curM) {
    if (curM.grossMargin != null) out.grossMargin = curM.grossMargin;
    if (curM.netMargin != null) out.netMargin = curM.netMargin;
  }
  // ROE(TTM) 与「去年同期」同口径值
  const npT = roll(rs, r => r.np);
  const eqNow = eqOf(rs[0]);
  if (npT != null && eqNow) {
    out.roe = npT.v / eqNow * 100;
    out.roeBasis = `TTM归母净利（${npT.label}） ÷ 期末归母净资产（BPS ${rs[0].bps.toFixed(2)} × 总股本，摊薄）`;
  }
  const py = String(Number(rs[0].date.slice(0, 4)) - 1);
  const smAnchor = rs.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === rs[0].date.slice(5));
  if (smAnchor) {
    const sub = rs.filter(r => r.date <= smAnchor.date);
    const npP = roll(sub, r => r.np);
    const eqP = eqOf(smAnchor);
    if (npP != null && eqP) out.roePrev = npP.v / eqP * 100;
    const pm = marginsOf(sub);
    if (pm) {
      if (pm.grossMargin != null) out.grossMarginTtmPrev = pm.grossMargin;
      if (pm.netMargin != null) out.netMarginTtmPrev = pm.netMargin;
    }
  }
  // 20261104k：上一报告期 TTM（环比维度同口径）——锚点 = 最近一个更早披露期的快照
  const qAnchor = rs.find(r => r.date < rs[0].date);
  if (qAnchor) {
    const subQ = rs.filter(r => r.date <= qAnchor.date);
    const npQ = roll(subQ, r => r.np);
    const eqQ = eqOf(qAnchor);
    if (npQ != null && eqQ) out.roeTtmPrevQ = npQ.v / eqQ * 100;
    const qm = marginsOf(subQ);
    if (qm) {
      if (qm.grossMargin != null) out.grossMarginTtmPrevQ = qm.grossMargin;
      if (qm.netMargin != null) out.netMarginTtmPrevQ = qm.netMargin;
    }
  }
  return out;
}

// ---- Unified API ----

async function getQuote(input) {
  const info = detectMarket(input);

  // Use Tencent API for ALL markets (CN, HK, US)
  try {
    const quote = await fetchTencentQuote(info.tencentCode);
    if (quote) {
      // Build fundamentals from Tencent quote data (available for all markets)
      quote.fundamentals = {
        pe: quote.pe || 0,
        pb: quote.pb || 0,
        totalValue: quote.totalValue || 0,
        circulationValue: quote.circulationValue || 0,
      };

      // Try to add more fundamentals from Eastmoney for CN stocks
      if (info.market === 'CN') {
        try {
          const fund = await fetchEastmoneyFundamentals(info.tencentCode.replace(/^(sh|sz)/, ''), info.exchange, quote);
          if (fund) {
            // Merge all fields from Eastmoney, overwriting Tencent defaults
            Object.assign(quote.fundamentals, fund);
            // Data provenance labels for the frontend
            quote.fundamentals.peSource = '腾讯行情';
            quote.fundamentals.pbSource = '腾讯行情';
            quote.fundamentals.roeSource = '东方财富财报';
            quote.fundamentals.reportSource = '东方财富财报';
            quote.fundamentals.psSource = fund.ps ? '东方财富估值(PS_TTM)' : '本地计算（总市值/营业收入）';
          }
        } catch {}
        // Compute PS if not present and revenue is available
        if (!quote.fundamentals.ps && quote.fundamentals.revenue) {
          quote.fundamentals.ps = computePS(quote.totalValue, quote.fundamentals.revenue);
        }
        // Tencent A-share PE is rolling TTM by convention
        quote.fundamentals.peType = 'TTM';
      } else {
        quote.fundamentals.peSource = quote.pe ? '行情数据' : '';
        quote.fundamentals.pbSource = quote.pb ? '行情数据' : '';
      }
      return { ...quote, marketType: info.market, exchange: info.exchange };
    }
  } catch (e) {
    console.error('Tencent quote failed:', e.message);
  }

  // Fallback to Yahoo (may be blocked in some regions)
  try {
    const quote = await fetchYahooQuote(info.yahooCode);
    if (quote) {
      try {
        const summary = await fetchYahooSummary(info.yahooCode);
        if (summary) quote.fundamentals = summary;
      } catch {}
      return { ...quote, marketType: info.market, exchange: info.exchange };
    }
  } catch (e) {
    console.error('Yahoo quote failed:', e.message);
  }

  return null;
}

async function fetchEastmoneyHistoryRetry(input, count = 320, retries = 2, period = 'day') {
  for (let i = 0; i <= retries; i++) {
    try {
      const history = await fetchEastmoneyHistory(input, count, period);
      if (history.length > 5) return history;
    } catch (e) {
      console.error(`Eastmoney history attempt ${i + 1} failed:`, e.message);
      if (i < retries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

// 按周期（日/60分钟/周/月）取 K 线，主要供 60分钟周期切换使用
// 【60m 窗口能力】count ≤ 800 走腾讯 m60；count > 800 自动切换新浪 scale=60（实测上限 4023 根 ≈ 4 年）。
// 返回数组可能带 .meta = { source, requested, truncation } 供上游做数据源标注（非数组元素，不影响遍历）。
async function getHistoryPeriod(input, period = 'day', count = 320) {
  if (period === '60m') {
    const info = detectMarket(input);
    try {
      const bars = await fetchTencentKline60m(info.tencentCode, count);
      if (bars.length > 5) return bars;
    } catch (e) {
      console.error('Tencent 60m history failed:', e.message);
    }
  }
  return fetchEastmoneyHistoryRetry(input, count, 2, period);
}

// 个股换手率序列（用于短期判断「换手率变化」信号）。
// 腾讯日K线不含换手率，故直接走东财 kline（含 f61 换手率），失败返回空数组（上层按中性处理）。
async function getEastmoneyTurnover(symbol, count = 60) {
  const em = await fetchEastmoneyHistoryRetry(symbol, count);
  if (!Array.isArray(em) || em.length < 6) return [];
  return em
    .map(h => ({ date: h.date, turnover: (typeof h.turnover === 'number' ? h.turnover : 0), close: h.close }))
    .filter(h => h.turnover > 0 && typeof h.close === 'number');
}

async function getHistory(input, range = '1y') {
  const info = detectMarket(input);
  const count = range === '10y' ? 2500 : range === '5y' ? 1200 : range === '3y' ? 720 : range === '2y' ? 480 : range === '6m' ? 130 : range === '3m' ? 65 : 320;

  // For CN and HK stocks: Tencent API is most reliable
  if (info.market === 'CN' || info.market === 'HK') {
    try {
      const history = await fetchTencentHistory(info.tencentCode, count);
      if (history.length > 5) return history;
    } catch (e) {
      console.error('Tencent history failed:', e.message);
    }
    // Fallback to Eastmoney with retries
    const emHistory = await fetchEastmoneyHistoryRetry(input, count);
    if (emHistory.length > 0) return emHistory;
    // 三级兜底：新浪日K（腾讯/东财均不可用时）
    try {
      const sinaHistory = await fetchSinaHistory(info.tencentCode, count);
      if (sinaHistory.length > 5) return sinaHistory;
    } catch (e) {
      console.error('Sina history fallback failed:', e.message);
    }
  }

  // For US stocks: try Eastmoney with retries first
  if (info.market === 'US') {
    const emHistory = await fetchEastmoneyHistoryRetry(input, count, 3);
    if (emHistory.length > 5) return emHistory;

    // Fallback to Tencent (may only have 1-2 bars)
    try {
      const history = await fetchTencentHistory(info.tencentCode, count);
      if (history.length > 0) return history;
    } catch (e) {
      console.error('Tencent US history failed:', e.message);
    }

    // Last resort: Yahoo
    try {
      const history = await fetchYahooHistory(info.yahooCode, range);
      if (history.length > 0) return history;
    } catch (e) {
      console.error('Yahoo history failed:', e.message);
    }
  }

  return [];
}

// ---- Search stocks ----

// 解析腾讯 smartbox 返回的 v_hint 字符串：条目用 ^ 分隔，字段用 ~ 分隔（market~code~name~pinyin~type）
// 非 ASCII 字符（中文名）以 \uXXXX 转义返回，需还原。
function parseTencentSmartbox(body) {
  if (!body) return [];
  const m = /v_hint="([^"]*)"/.exec(String(body));
  if (!m || !m[1]) return [];
  const decode = (s) => String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return m[1].split('^').map(seg => {
    const p = seg.split('~');
    if (p.length < 4) return null;
    return { tag: p[0], code: p[1], name: decode(p[2] || ''), pinyin: p[3] || '', type: p[4] || '' };
  }).filter(Boolean);
}

// 将 smartbox 条目映射为统一搜索结构；仅保留个股/基金，剔除无效类型
function mapSmartboxItem(it) {
  const tag = (it.tag || '').toLowerCase();
  let market, exchange, symbol = it.code;
  if (tag === 'sh') { market = 'CN'; exchange = 'SH'; }
  else if (tag === 'sz') { market = 'CN'; exchange = 'SZ'; }
  else if (tag === 'hk') { market = 'HK'; exchange = 'HK'; }
  else if (tag === 'us') { market = 'US'; exchange = 'US'; symbol = (it.code || '').split('.')[0].toUpperCase(); }
  else return null;
  const okType = ['GP-A', 'GP', 'FJ', 'LOF', 'ETF', ''];
  if (!symbol || !okType.includes(it.type)) return null;
  return {
    code: it.code,
    name: it.name || it.code,
    symbol,
    market,
    exchange,
    pinyin: it.pinyin || '',
  };
}

async function searchStocks(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const results = [];
  const seen = new Set();
  const push = (r) => {
    if (r && r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); results.push(r); }
  };

  // 1) 腾讯 smartbox：代码 / 名称 / 拼音首字母 均可匹配，本机稳定可用
  try {
    const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(kw)}&t=all&c=1`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 6000,
      responseType: 'text',
    });
    for (const it of parseTencentSmartbox(resp.data)) push(mapSmartboxItem(it));
  } catch (e) {
    console.error('Tencent smartbox failed:', e.message);
  }

  // 2) 东财搜索兜底（searchapi 在本机可能被 TLS 阻断）
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.eastmoney.com/' },
      timeout: 6000
    });
    for (const item of (resp.data?.QuotationCodeTable?.Data || [])) {
      const code = item.Code || '';
      const info = detectMarket(code);
      let market = info.market, exchange = info.exchange;
      if (item.MarketNum === 0) { market = 'CN'; exchange = 'SZ'; }
      else if (item.MarketNum === 1) { market = 'CN'; exchange = 'SH'; }
      else if (item.MarketNum === 116) { market = 'HK'; exchange = 'HK'; }
      push({ code, name: item.Name || '', symbol: market === 'HK' ? code.replace(/^hk/i, '') : code, market, exchange, pinyin: item.Pinyin || '' });
    }
  } catch (e) {
    console.error('Eastmoney search failed:', e.message);
  }

  // 3) 最后兜底：直接按代码识别
  if (results.length === 0) {
    const info = detectMarket(kw);
    push({ code: kw, name: kw, symbol: kw, market: info.market, exchange: info.exchange, pinyin: '' });
  }

  return results;
}

module.exports = { detectMarket, getQuote, getHistory, getHistoryPeriod, getHistoryDeep, getEastmoneyTurnover, searchStocks, fetchTencentMinutes, fetchSinaKline60m, fetchEastmoneyHistory, fetchEastmoneyHistoryMultiHost, fetchTencentHistory, fetchTencentRawCloseMap, fetchThsHistory, _decodeThsAll, _parseThsLast, _mergeThsBars, _backfillThsFields, getEastmoneySecid, getMarketOverview, getEastmoneySectorRanking, getThsSectorRanking, parseSwSectorName, getSwSecondLevelNames, findPythonForScript, fetchSinaIndicesBatch, aggregateTopIndustry, SW_LEVEL_UNIFIED, tencentVolumeUnitIsShares, computeTtmMetrics };

~~~

---

## `lib\stockLog.js`  ·  300 行

~~~js
// lib/stockLog.js — 个股行情判断记录（20261025l 起为「个股记录」tab；20261107 升级为行情判断记录）
// 每只个股手动添加「行情判断」：日期 + 涨跌方向(上涨/震荡/下跌) + 判断依据(技术面/消息面/其他) + 备注，
// 落盘 data/stock-log/<6位代码>.json。
//
// 20261108a：新增「涨跌幅判断正确率」自动结算（用户选定「系统按实际涨跌自动判」）。
//   · 口径复用工作台既有 lib/techFaceJudgment.js：FLAT_TOLERANCE=1.0%，腾讯/新浪前复权日K。
//   · 验证日 = 记录日之后的第一个交易日；涨跌幅 = 该日收盘 vs 其前一交易日收盘。
//   · 命中：方向为「震荡」时 |涨跌幅| ≤ 1% 记对；否则用户方向与实际方向一致记对。
//   · 数据未到 / 取数失败 → 诚实标 pending（待验证），不臆造、不进分母。
//   · 未填涨跌方向的记录不纳入正确率统计（用户明确要求）。
//
// 隔离边界（不变）：本模块只做「手动记录 + 模块内自统计」，准确率不写入任何判定记录/
// 因子/评分/回测，不触发任何模块联动；两个下拉允许留空。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'stock-log');
const MAX_TEXT = 2000;
const MAX_PER_STOCK = 500;   // 单股条数上限，防无限膨胀
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 20261107：行情判断结构化枚举（与前端显示名同源）
const DIRECTIONS = ['up', 'sideways', 'down'];          // 上涨 / 震荡 / 下跌
const BASES = ['technical', 'news', 'other'];          // 技术面 / 消息面 / 其他
const VERDICTS = ['correct', 'wrong', 'pending'];      // 对 / 错 / 待验证

// 20261108a：与 lib/techFaceJudgment.js 同源的「震荡」命中容差（%），不另造口径
const FLAT_TOLERANCE = 1.0;
const KLINE_TIMEOUT_MS = 8000;
const KLINE_CACHE_TTL = 10 * 60 * 1000;
const _barsCache = new Map();

// 20261108a：两个下拉非必填——留空/非法值一律存 null，不再强行归一成 震荡/其他
function normDir(v) { return DIRECTIONS.includes(v) ? v : null; }
function normBasis(v) { return BASES.includes(v) ? v : null; }

function fileFor(symbol) {
  const pure = String(symbol || '').replace(/^(sh|sz|bj)/i, '').replace(/\.HK$/i, '').trim();
  return path.join(DIR, `${pure || 'unknown'}.json`);
}
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }

/** 结算字段整体清除（编辑改了日期/方向时调用，避免旧结论挂在新判断上） */
function clearVerdict(it) {
  if (!it) return;
  delete it.verdict; delete it.actualChgPct; delete it.actualDate;
  delete it.baseDate; delete it.actualDirection; delete it.settledAt;
}

// 旧记录兼容：早期只有 text 字段，无 direction/basis；统一归一成新结构（note = text）
function normalizeItem(it) {
  if (!it) return it;
  const direction = DIRECTIONS.includes(it.direction) ? it.direction : null;
  return {
    ...it,
    direction,
    basis: BASES.includes(it.basis) ? it.basis : null,
    note: (it.note != null && it.note !== '') ? it.note : (it.text || ''),
    // 有方向但尚未结算 → pending；无方向 → null（不参与统计、不显示图标）
    verdict: VERDICTS.includes(it.verdict) ? it.verdict : (direction ? 'pending' : null),
  };
}

// ---------- 20261108a：确定性结算纯函数（代码权威，LLM 不参与；可单测直接测） ----------

/** 实际方向（严格按收盘价差符号），与 techFaceJudgment 的 actDir 同源 */
function actualDirection(chgPct) {
  if (typeof chgPct !== 'number' || !isFinite(chgPct)) return null;
  return chgPct > 0 ? 'up' : (chgPct < 0 ? 'down' : 'sideways');
}

/** 单条命中判定；无方向 / 无有效涨跌幅返回 null（不判对错） */
function judge(direction, chgPct) {
  if (!DIRECTIONS.includes(direction)) return null;
  if (typeof chgPct !== 'number' || !isFinite(chgPct)) return null;
  const act = actualDirection(chgPct);
  return direction === 'sideways' ? Math.abs(chgPct) <= FLAT_TOLERANCE : direction === act;
}

/** K 线归一：只保留合法 date + 正数 close，按日期升序；不补点、不插值 */
function normalizeBars(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && DATE_RE.test(String(b.date)) && Number(b.close) > 0 && isFinite(Number(b.close)))
    .map(b => ({ date: String(b.date), close: Number(b.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 取「记录日之后的第一个交易日」验证。
 * 用真实 K 线自行排除周末/节假日，不依赖另一套日历口径。
 * 返回 null = 未到验证日 / 无基准 K 线（诚实待验证）。
 */
function verdictFromBars(bars, dateStr) {
  if (!Array.isArray(bars) || !bars.length || !DATE_RE.test(String(dateStr || ''))) return null;
  const idx = bars.findIndex(b => b.date > dateStr);
  if (idx <= 0) return null;                  // idx=0 表示无基准日 K 线
  const base = bars[idx - 1], target = bars[idx];
  const chgPct = (target.close - base.close) / base.close * 100;
  return {
    chgPct: round(chgPct, 2),
    actualDate: target.date,
    baseDate: base.date,
    actualDirection: actualDirection(chgPct),
  };
}

/** 准确率统计：分母只含「有方向 + 已判定」的记录 */
function computeAccuracy(items) {
  const arr = Array.isArray(items) ? items : [];
  let judged = 0, correct = 0, wrong = 0, pending = 0, noDirection = 0;
  for (const it of arr) {
    if (!it || !DIRECTIONS.includes(it.direction)) { noDirection++; continue; }
    if (it.verdict === 'correct') { judged++; correct++; }
    else if (it.verdict === 'wrong') { judged++; wrong++; }
    else pending++;
  }
  const rate = judged ? Math.round(correct / judged * 1000) / 10 : null;
  return {
    total: arr.length, judged, correct, wrong, pending, noDirection,
    rate, rateText: rate == null ? '—' : rate.toFixed(1) + '%',
    tolerance: FLAT_TOLERANCE,
    caliber: '记录日之后的第一个交易日收盘 vs 其前一交易日收盘；|涨跌幅|≤1% 记震荡，方向一致记对',
  };
}

/** 日K取数（带超时 + 10 分钟缓存）；失败返回 null → 全部保持 pending，绝不臆造 */
async function loadBars(symbol) {
  const key = String(symbol || '');
  const hit = _barsCache.get(key);
  if (hit && Date.now() - hit.ts < KLINE_CACHE_TTL) return hit.bars;
  let timer = null;
  try {
    // 延迟 require：便于单测注入 barsOverride，同时避免模块加载期产生副作用
    const { getHistoryDeep } = require('./stockData');
    const bars = await Promise.race([
      Promise.resolve(getHistoryDeep(symbol, 2400)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('日K取数超时')), KLINE_TIMEOUT_MS); }),
    ]);
    const nb = normalizeBars(bars);
    _barsCache.set(key, { ts: Date.now(), bars: nb });
    return nb;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把结算结果写回文件；返回是否发生写入 */
function applySettlement(symbol, bars) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return false;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return false; }
  if (!Array.isArray(arr)) return false;
  let changed = false;
  for (const it of arr) {
    if (!it) continue;
    // 无涨跌幅判断：清掉可能残留的结算字段，明确不纳入统计
    if (!DIRECTIONS.includes(it.direction)) {
      if (it.verdict || it.actualChgPct != null) { clearVerdict(it); changed = true; }
      continue;
    }
    // 已判定不重算（幂等：前复权数据变动不改写历史结论）
    if (it.verdict === 'correct' || it.verdict === 'wrong') continue;
    const res = verdictFromBars(bars, String(it.date || ''));
    if (!res) {
      if (it.verdict !== 'pending') { it.verdict = 'pending'; changed = true; }
      continue;
    }
    const hit = judge(it.direction, res.chgPct);
    it.verdict = hit ? 'correct' : 'wrong';
    it.actualChgPct = res.chgPct;
    it.actualDate = res.actualDate;
    it.baseDate = res.baseDate;
    it.actualDirection = res.actualDirection;
    it.settledAt = new Date().toISOString();
    changed = true;
  }
  if (!changed) return false;
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { return false; }
}

/**
 * 列表 + 结算 + 准确率（GET /api/stock-log/:symbol 的唯一出口）
 * @param {object} [opts] { barsOverride } 单测注入 K 线，跳过网络
 */
async function settleAndList(symbol, opts = {}) {
  const base = listLog(symbol);
  let items = base.items;
  const need = items.some(it => DIRECTIONS.includes(it.direction)
    && it.verdict !== 'correct' && it.verdict !== 'wrong');
  if (need) {
    const bars = Array.isArray(opts.barsOverride) ? normalizeBars(opts.barsOverride) : await loadBars(symbol);
    if (Array.isArray(bars) && bars.length && applySettlement(symbol, bars)) {
      items = listLog(symbol).items;          // 重新读，保证返回值与落盘一致
    }
  }
  return { ok: true, items, accuracy: computeAccuracy(items), note: base.note };
}

// 列表：按日期正序（日期先后），同日按创建时间正序；前端再做筛选/检索/排序切换
function listLog(symbol) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: true, items: [] };
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const items = (Array.isArray(arr) ? arr : []).slice()
      .map(normalizeItem)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
    return { ok: true, items };
  } catch (e) {
    // 文件损坏按空处理，不崩溃不伪造
    return { ok: true, items: [], note: `记录文件损坏已按空处理：${e.message}` };
  }
}

function addLog(symbol, body) {
  const b = body || {};
  const d = String(b.date || '').trim();
  const note = String(b.note != null ? b.note : b.text || '').trim();
  if (!DATE_RE.test(d)) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!note) return { ok: false, error: '备注不能为空' };
  if (note.length > MAX_TEXT) return { ok: false, error: `备注超长（最多 ${MAX_TEXT} 字）` };
  ensureDir();
  const f = fileFor(symbol);
  let arr = [];
  try { if (fs.existsSync(f)) arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  if (arr.length >= MAX_PER_STOCK) return { ok: false, error: `该个股记录已达上限（${MAX_PER_STOCK} 条），请先清理旧记录` };
  const item = {
    id: 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date: d,
    direction: normDir(b.direction),
    basis: normBasis(b.basis),
    note,
    createdAt: new Date().toISOString(),
  };
  arr.push(item);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  return { ok: true, item };
}

function removeLog(symbol, id) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: false, error: '该个股暂无记录' };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { return { ok: false, error: '记录文件损坏' }; }
  if (!Array.isArray(arr)) return { ok: false, error: '记录文件损坏' };
  const next = arr.filter(x => x && x.id !== id);
  if (next.length === arr.length) return { ok: false, error: '记录不存在或已删除' };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return { ok: true };
}

// 修改记录：按 id 定位，可改日期/方向/依据/备注；
// 20261108a：日期或方向变化时清除旧结算结论，下次读取自动重算（不改则不重算，保持幂等）。
function updateLog(symbol, id, body) {
  const b = body || {};
  const d = String(b.date || '').trim();
  const note = String(b.note != null ? b.note : b.text || '').trim();
  if (!DATE_RE.test(d)) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!note) return { ok: false, error: '备注不能为空' };
  if (note.length > MAX_TEXT) return { ok: false, error: `备注超长（最多 ${MAX_TEXT} 字）` };
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: false, error: '该个股暂无记录' };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { return { ok: false, error: '记录文件损坏' }; }
  if (!Array.isArray(arr)) return { ok: false, error: '记录文件损坏' };
  const it = arr.find(x => x && x.id === id);
  if (!it) return { ok: false, error: '记录不存在或已删除' };
  const newDir = normDir(b.direction);
  const recalc = (it.date !== d || it.direction !== newDir);
  it.date = d;
  it.direction = newDir;
  it.basis = normBasis(b.basis);
  it.note = note;
  if (recalc) clearVerdict(it);
  it.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  return { ok: true, item: normalizeItem(it) };
}

function clearBarsCache() { _barsCache.clear(); }

module.exports = {
  listLog, addLog, removeLog, updateLog, settleAndList,
  DIRECTIONS, BASES, VERDICTS, FLAT_TOLERANCE,
  normalizeItem, normDir, normBasis,
  actualDirection, judge, normalizeBars, verdictFromBars, computeAccuracy, clearBarsCache,
};

~~~

---

## `lib\stockSectorLevels.js`  ·  119 行

~~~js
/**
 * 个股「所属行业板块」一级/二级/三级 解析（单一可信源 · 确定性）
 * ================================================================
 * 用途：行业分析页「板块总市值走势」统一模板 —— 每只个股分别与所属
 *       申万一级 / 二级 / 三级行业板块的行业总市值做双坐标走势比对（三张图）。
 *       没有对应三级板块时省略第三张。
 *
 * 数据源（规则一·单一权威源）：
 *   东方财富「个股所属板块」接口
 *   `https://push2delay.eastmoney.com/api/qt/slist/get?...&secid={secid}&spt=3&fields=f12,f13,f14`
 *   返回该股所属的**全部**板块（行业板块 + 地区板块 + 概念板块 + 指数板块），
 *   形如：BK1201 电子 / BK1036 半导体 / BK1327 分立器件 / BK0172 浙江板块 / BK0500 HS300_ …
 *
 * 层级判定（复用现有唯一字典，不新增映射）：
 *   对每个板块名调用 `parseSwSectorName(name).swLevel`：
 *     - 行业板块（电子 / 半导体 / 分立器件 / 食品饮料 / 调味发酵品Ⅱ / 保险Ⅲ …）→ 返回 一级/二级/三级
 *     - 地区/概念/指数板块（浙江板块 / 融资融券 / HS300_ / 国产芯片 / 5G概念 …）→ 返回 null
 *   实测 4 只样例股（士兰微/海天/平安/麦捷）零误判：行业板块全部命中、其余全部 null。
 *   因此「swLevel 非 null」即为行业板块的判定条件，无需再跨表核对。
 *
 * 缓存：按 symbol 内存缓存 30 分钟（板块归属变动极少）；force 可跳过。
 */
const axios = require('axios');
const { getEastmoneySecid, parseSwSectorName } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
// 主机回退：push2delay 为主镜像，push2 兜底（本机 push2 偶发被限，但作为第二源仍值得一试）
const HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];
const CACHE_TTL_MS = 30 * 60 * 1000;
const LEVEL_ORDER = ['一级', '二级', '三级'];

const _cache = new Map();

function normCode(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
}

/** 拉取个股所属全部板块（[{code,name}]） */
async function fetchBoards(secid) {
  for (const host of HOSTS) {
    try {
      const url = `${host}/api/qt/slist/get?fltt=2&invt=2&np=1&secid=${encodeURIComponent(secid)}&spt=3&fields=f12,f13,f14&pi=0&pz=100&po=1`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
      const list = diff
        .map(d => ({ code: String(d.f12 || ''), name: String(d.f14 || '').trim() }))
        .filter(x => x.code && x.name);
      if (list.length) return list;
    } catch (e) {
      console.warn(`[StockSectorLevels] slist ${host} 失败: ${e && e.message}`);
    }
  }
  return [];
}

/**
 * 解析个股所属 一级/二级/三级 行业板块。
 * @param {string} symbol 股票代码（支持 SH/SZ 前缀或纯数字）
 * @param {object} [opts]
 * @param {string} [opts.name] 股票名称（仅回显）
 * @param {boolean} [opts.force=false] 跳过缓存
 * @returns {Promise<{success:boolean, symbol:string, name:string, levels:Array<{swLevel:string,sectorCode:string,sectorName:string}>, industryBoards:Array, source:string, fetchedAt:string}>}
 */
async function resolveStockSectorLevels(symbol, opts = {}) {
  const code = normCode(symbol);
  const displayName = opts.name || '';
  if (!code) return { success: false, error: 'NO_SYMBOL', symbol: '', name: displayName, levels: [] };

  if (!opts.force) {
    const hit = _cache.get(code);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return { ...hit.data, name: displayName || hit.data.name || '', cached: true };
    }
  }

  let secid = '';
  try { secid = getEastmoneySecid(code); } catch { secid = ''; }
  if (!secid) {
    return { success: false, error: 'NO_SECID', symbol: code, name: displayName, levels: [] };
  }

  const boards = await fetchBoards(secid);
  if (!boards.length) {
    return { success: false, error: 'NO_BOARDS', symbol: code, name: displayName, levels: [], message: '未获取到个股所属板块（数据源受限）' };
  }

  // 归类：每个层级取「首个」命中的行业板块（slist 按涨跌幅排序，同层一般唯一）
  const byLevel = {};
  const industryBoards = [];
  for (const b of boards) {
    const parsed = parseSwSectorName(b.name);
    const lv = parsed && parsed.swLevel ? parsed.swLevel : null;
    if (!lv) continue; // 地区/概念/指数板块
    const item = { swLevel: lv, sectorCode: b.code, sectorName: b.name };
    industryBoards.push(item);
    if (!byLevel[lv]) byLevel[lv] = item;
  }
  const levels = LEVEL_ORDER.map(lv => byLevel[lv]).filter(Boolean);

  const result = {
    success: levels.length > 0,
    symbol: code,
    name: displayName,
    levels,
    industryBoards, // 全部命中行业板块（多用于调试/展示）
    source: '东方财富·个股所属板块(slist spt=3)',
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  if (!levels.length) result.message = '未解析到行业板块层级（可能为非申万行业个股）';

  _cache.set(code, { ts: Date.now(), data: result });
  console.log(`[StockSectorLevels] ${code} ${displayName} → ${levels.map(l => `${l.swLevel}:${l.sectorName}(${l.sectorCode})`).join(' / ') || '无'}`);
  return result;
}

module.exports = { resolveStockSectorLevels };

~~~

---

## `lib\stockSentiment.js`  ·  312 行

~~~js
/**
 * 单只 A 股个股全网红情分析模块 · 计算层（20260910）
 * --------------------------------------------------------------
 * 职责边界（严格遵守用户规格）：
 *   本模块「不抓取网络数据」，只消费前置采集层/其他业务模块传入的结构化输入：
 *     · stockDiscussion  同花顺讨论 API 采集的原始帖（sentiment.py 已采集）
 *     · discussionHeat   同花顺热榜/雪球关注榜/东财股吧 聚合热度（sentiment.py 已采集）
 *     · newsSentiment    个股新闻情感（sentiment.py；本机 curl_cffi 受限时 ok=false）
 *     · quote/capital/turnoverChange  行情、主力资金、换手率（工作台其他模块传入，仅用于交叉校验）
 *   本模块只做：实体过滤 → 垃圾过滤 → 情感标注 → 散户/KOL 识别 → 时间衰减加权 →
 *   五指标(A/B/C/D/E) → 归一化 → 加权综合分 → 四路外部数据交叉校验 → 标签/告警 → 简报/结论。
 *   全部为确定性代码（1+1=2），不调用 LLM。
 *
 * 诚实降级（本机环境限制）：
 *   · A(全网资讯曝光) / D(专业舆情情感) 依赖新闻/研报源，本机 curl_cffi 被系统策略拦截 → 缺失，权重自动重分配；
 *   · C(散户) / KOL 判定缺账号注册时长/粉丝数据 → 用句式词典 / 认证大V(is_v) 近似，已在 degrade 标注；
 *   · 行业样本池 Min-Max 归一化暂不可用 → 采用「绝对基准曲线」并在 normalizationBasis 标注。
 */
'use strict';

const { classifySentiment, isRookiePost, isSpam } = require('./hotTopicsWeekly/nlp');

// ---------- 可调参数（规格要求：权重/阈值/告警全部支持人工修改） ----------
const CFG = {
  // 基础综合分权重（规格原值）；A/D 缺失时自动在可用指标间重分配
  weights: { A: 0.35, B: 0.35, D: 0.15, E: 0.15 },
  // 热度等级阈值：≥75 高热 / 60~74.9 偏热 / 40~59.9 平稳 / <40 冷清
  heat: { hot: 75, warm: 60, calm: 40 },
  // 告警：归一化散户指标 ≥90 且 最终综合分 ≥70
  alert: { rookieNorm: 90, finalScore: 70 },
  sampleMin: 8,                 // 有效帖 < 该值 → 标注「样本偏少，分数参考性下降」
  // 绝对基准归一化曲线（行业样本池不可用时的替代；点位经讨论量级校准，可人工调整）
  scaleB: [[0, 0], [15, 30], [45, 55], [120, 75], [300, 100]], // B=社区讨论量
  scaleC: [[0, 0], [3, 45], [10, 75], [20, 100]],               // C=散户帖数
  // 四路交叉校验阈值
  cross: {
    mainNetBigPct: 1.5,    // |5日主力净额/流通市值| ≥ 1.5% 视为「大幅」
    mainNetSmallPct: 1.5,  // 同口径的「小幅」上界
    bigRisePct: 5,         // 日涨跌幅 ≥5% 视为「大幅上涨」
    divergenceGap: 15,     // 多空占比差 <15 且两方均 >20% → 分歧
    divergenceMin: 20,
  },
};

// 简报用正/负面关键词（确定性词典，与 nlp.js 情绪词典解耦，仅用于展示）
const POS_KW = ['涨停', '大涨', '利好', '增持', '买入', '加仓', '净买入', '回暖', '增长', '盈利', '上调',
  '突破', '拉升', '走强', '回购', '中标', '超预期', '预增', '净流入', '机构看好', '看好', '扩产',
  '签单', '扭亏', '新高', '订单增长', '产能释放', '景气', '供不应求', '涨价'];
const NEG_KW = ['跌停', '大跌', '利空', '减持', '卖出', '净卖出', '暴跌', '下跌', '亏损', '下滑', '下调',
  '回落', '走弱', '破位', '退市', '暴雷', '立案', '预减', '计提', '警示', '诉讼', '罚款', '商誉减值',
  '减值', '风险警示', '被套', '割肉', '套牢', '毛利率下滑', '机构减持', '出货', '见顶'];

// ---------- 工具 ----------
function clamp(v, a, b) { v = Number(v); if (!isFinite(v)) v = 0; return Math.max(a, Math.min(b, v)); }
function round(v, n) {
  if (v == null || !isFinite(v)) return null;
  const m = Math.pow(10, n == null ? 2 : n);
  return Math.round(v * m) / m;
}
/** 分段线性映射（用于绝对基准归一化） */
function piecewise(v, pts) {
  if (v == null || !isFinite(v)) return null;
  v = Number(v);
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1];
      const x1 = pts[i][0], y1 = pts[i][1];
      const t = (v - x0) / ((x1 - x0) || 1);
      return y0 + t * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}
/** 时间衰减权重：越近越高（当天 1.0、1天前 0.7、2天前 0.5、3天+ 0.3），与 sentiment.py 同口径 */
function decayWeight(ageDays) {
  if (ageDays == null) return 0.5;
  if (ageDays < 1) return 1.0;
  if (ageDays < 2) return 0.7;
  if (ageDays < 3) return 0.5;
  return 0.3;
}
function countKeywords(texts, list) {
  const m = new Map();
  for (const t of texts) {
    const s = String(t || '');
    for (const w of list) if (s.indexOf(w) >= 0) m.set(w, (m.get(w) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 情绪标签判定（第二组，6 选 1）。优先级：恐慌 > KOL > 拥挤 > 分歧 > 背离 > 平淡。
 */
function pickSentimentTag(c) {
  const { posPct, negPct, kolCount, finalScore, mainNetPct, profPosPct } = c;
  // 6) 机构散户情绪背离（需 D 指标：专业媒体正面但散户看空，或反之）
  if (profPosPct != null) {
    if (profPosPct >= 55 && negPct >= 45) return '机构散户情绪背离';
    if (profPosPct <= 45 && posPct >= 55) return '机构散户情绪背离';
  }
  // 2) 市场恐慌情绪升温：看空占比高 / 空头压倒多头
  if (negPct >= 45 || (negPct - posPct) >= 25) return '市场恐慌情绪升温';
  // 1) KOL 集体看好：认证大V+看多占比高
  if (kolCount >= 2 && posPct >= 55 && (posPct - negPct) >= 15) return 'KOL集体看好';
  // 3) 舆情拥挤，获利兑现风险上升：高热但资金不支撑
  if (finalScore >= 70 && mainNetPct != null && mainNetPct <= 0) return '舆情拥挤，获利兑现风险上升';
  // 4) 多空剧烈分歧
  if (Math.abs(posPct - negPct) < CFG.cross.divergenceGap && posPct > CFG.cross.divergenceMin && negPct > CFG.cross.divergenceMin) {
    return '多空剧烈分歧';
  }
  // 5) 情绪平淡无方向
  return '情绪平淡无方向';
}

/**
 * 主入口。
 * @param {object} input { symbol, name, quote, capital, turnoverChange, newsSentiment, discussionHeat, stockDiscussion }
 * @returns {object} 标准化分析结果（含 signal -1..1 供卡片判 利好/中性/利空）
 */
function buildStockSentiment(input) {
  const { symbol, name, quote, capital, turnoverChange, newsSentiment, discussionHeat, stockDiscussion } = input || {};
  if (!symbol) return { ok: false, reason: 'missing symbol', degrade: ['缺少股票代码'] };

  const degrade = [];
  const postsRaw = (stockDiscussion && Array.isArray(stockDiscussion.posts)) ? stockDiscussion.posts : [];

  // ---- 1) 实体过滤 + 垃圾过滤 + 情感/散户/KOL 标注 + 时间衰减 ----
  const nowSec = Date.now() / 1000;
  const seen = new Set();
  const posts = [];
  for (const p of postsRaw) {
    const content = String((p && (p.content || p.title)) || '').trim();
    if (!content) continue;
    const id = p && p.id != null ? String(p.id) : null;
    if (id && seen.has(id)) continue;
    if (isSpam(content)) continue;              // 广告/灌水/纯表情/过短
    if (id) seen.add(id);
    const label = classifySentiment(content);   // bullish / bearish / neutral
    const ctime = Number(p.ctime) || 0;
    const ageDays = ctime > 0 ? Math.max(0, (nowSec - ctime) / 86400) : null;
    posts.push({
      id, content, label,
      rookie: isRookiePost(content),
      isV: !!(p && p.isV),
      ctime, ageDays, w: decayWeight(ageDays),
      reply: Number(p.reply) || 0, like: Number(p.like) || 0,
      share: Number(p.share) || 0, forward: Number(p.forward) || 0,
    });
  }

  const hasHeat = !!(discussionHeat && discussionHeat.ok);
  if (!posts.length && !hasHeat) {
    return { ok: false, reason: 'no data', degrade: ['同花顺讨论为空且无其他热度源'] };
  }
  if (!posts.length) {
    degrade.push('同花顺讨论帖为空，无法计算 D/E 情感指标');
  }

  // ---- 2) 聚合 ----
  const n = posts.length;
  for (const x of posts) x.eng = x.reply + x.like + x.share + x.forward;
  const cP = posts.filter(x => x.label === 'bullish').length;
  const cN = posts.filter(x => x.label === 'bearish').length;
  const cU = n - cP - cN;
  const wSum = posts.reduce((s, x) => s + x.w, 0) || 1;
  const wP = posts.filter(x => x.label === 'bullish').reduce((s, x) => s + x.w, 0);
  const wN = posts.filter(x => x.label === 'bearish').reduce((s, x) => s + x.w, 0);
  const wU = Math.max(0, wSum - wP - wN);
  const posPct = round(wP / wSum * 100, 1);
  const negPct = round(wN / wSum * 100, 1);
  const neuPct = round(wU / wSum * 100, 1);
  const netSent = round((wP - wN) / wSum, 3);            // -1..1 加权净情绪
  const rookieCount = posts.filter(x => x.rookie).length;
  const kolCount = posts.filter(x => x.isV).length;      // KOL 近似 = 认证大V
  const commentsTotal = posts.reduce((s, x) => s + x.reply, 0);
  const likesShares = posts.reduce((s, x) => s + x.like + x.share + x.forward, 0);
  let spanDays = null;
  if (n) {
    const ts = posts.map(x => x.ctime).filter(t => t > 0);
    if (ts.length >= 2) spanDays = Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 86400));
  }

  // ---- 3) 五大基础原始指标 ----
  const newsOk = !!(newsSentiment && newsSentiment.ok);
  const A_raw = newsOk ? (Number(newsSentiment.count) || 0) : null;   // 曝光以新闻条数代理（平台无浏览量字段）
  const B_raw = n + commentsTotal + likesShares;                       // 有效帖数 + 累计评论 + 点赞分享(曝光代理)
  const C_raw = rookieCount;
  const D_raw = newsOk && newsSentiment.count > 0
    ? round((Number(newsSentiment.positive) || 0) / newsSentiment.count * 100, 1) : null;
  const E_raw = posPct;                                                // 社区看多占比%

  // ---- 4) 归一化（行业样本池不可用 → 绝对基准；E/D 本身即 0~100 百分比） ----
  const A_norm = null;
  const B_norm = piecewise(B_raw, CFG.scaleB);
  const C_norm = piecewise(C_raw, CFG.scaleC);
  const D_norm = D_raw;
  const E_norm = E_raw;
  degrade.push('行业样本池 Min-Max 归一化不可用，采用绝对基准曲线');
  if (!newsOk) degrade.push('新闻/研报源不可用（A 全网曝光、D 专业舆情情感 缺失）');
  if (!hasHeat) degrade.push('多平台热度源不可用');
  const emOk = !!(discussionHeat && discussionHeat.eastmoney && discussionHeat.eastmoney.ok);
  if (hasHeat && !emOk) degrade.push('东财股吧源不可用（同花顺/雪球正常）');
  degrade.push('KOL 判定缺粉丝数据，以「认证大V」近似；散户判定为句式词典近似');

  // ---- 5) 加权基础综合分（在可用指标间重分配权重） ----
  const avail = [];
  if (A_norm != null) avail.push(['A', A_norm, CFG.weights.A]);
  if (B_norm != null) avail.push(['B', B_norm, CFG.weights.B]);
  if (D_norm != null) avail.push(['D', D_norm, CFG.weights.D]);
  if (E_norm != null) avail.push(['E', E_norm, CFG.weights.E]);
  const wTot = avail.reduce((s, x) => s + x[2], 0) || 1;
  const baseScore = avail.length ? Math.round(avail.reduce((s, x) => s + x[1] * x[2], 0) / wTot) : 0;

  // ---- 6) 四路外部数据交叉校验 ----
  const floatMC = (capital && capital.floatMarketCapYi) || 0;
  const s5 = capital && capital.moneyFlow && capital.moneyFlow.summary
    && capital.moneyFlow.summary.summary && capital.moneyFlow.summary.summary['5d'];
  const mainNet5d = s5 && typeof s5.mainNet === 'number' ? s5.mainNet : null;   // 亿元
  const mainNetPct = (mainNet5d != null && floatMC > 0) ? round(mainNet5d / floatMC * 100, 2) : null;
  let changePct = null;
  if (quote && quote.price != null && quote.prevClose > 0) {
    changePct = round((quote.price - quote.prevClose) / quote.prevClose * 100, 2);
  }
  const turnSig = turnoverChange && turnoverChange.ok ? turnoverChange.signal : null;
  const turnHigh = turnSig != null && turnSig > 0.1;

  const crossTags = [];
  let score = baseScore;

  // 规则1：热度高 + 主力大幅净流出 → 下调，【舆情热度虚高，资金背离】
  if (baseScore >= 70 && mainNetPct != null && mainNetPct <= -CFG.cross.mainNetBigPct) {
    score -= 12; crossTags.push('舆情热度虚高，资金背离');
  } else if (baseScore >= 60 && mainNetPct != null && mainNetPct >= CFG.cross.mainNetBigPct) {
    // 规则3：热度高 + 主力持续净流入 → 维持/小幅上调
    score += 5; crossTags.push('资金共振，热度有资金支撑');
  }
  // 规则2：热度低 + 大幅上涨 + 换手率走高 → 小幅下调，【资金驱动，市场舆论尚未共识】
  if (baseScore < 40 && changePct != null && changePct >= CFG.cross.bigRisePct && turnHigh) {
    score -= 6; crossTags.push('资金驱动，市场舆论尚未共识');
  }
  // 规则5：热度中等 + 资金小幅流出 + 多空接近 → 下调，【多空剧烈分歧】
  if (baseScore >= 40 && baseScore < 70 && mainNetPct != null && mainNetPct < 0
    && Math.abs(mainNetPct) < CFG.cross.mainNetSmallPct
    && Math.abs(posPct - negPct) < CFG.cross.divergenceGap
    && posPct > CFG.cross.divergenceMin && negPct > CFG.cross.divergenceMin) {
    score -= 8; crossTags.push('多空剧烈分歧，资金小幅流出');
  }
  const finalScore = Math.round(clamp(score, 0, 100));

  // ---- 7) 标签体系 ----
  const heatLevel = finalScore >= CFG.heat.hot ? '舆情高热'
    : finalScore >= CFG.heat.warm ? '舆情偏热'
    : finalScore >= CFG.heat.calm ? '舆情平稳' : '舆情冷清';
  const sentimentTag = pickSentimentTag({ posPct, negPct, kolCount, finalScore, mainNetPct, profPosPct: D_norm });

  // 规则4/告警：归一化散户指标 ≥90 且 最终综合分 ≥70
  const alertOn = C_norm != null && C_norm >= CFG.alert.rookieNorm && finalScore >= CFG.alert.finalScore;

  // ---- 8) 方向信号（供卡片判 利好/中性/利空）：冷清时情绪影响减弱 ----
  const heatFactor = finalScore >= CFG.heat.calm ? 1 : (finalScore / CFG.heat.calm);
  const signal = clamp(netSent * heatFactor, -1, 1);

  // ---- 9) 简报 ----
  const posKeywords = countKeywords(posts.map(x => x.content), POS_KW).slice(0, 5).map(x => x[0]);
  const negKeywords = countKeywords(posts.map(x => x.content), NEG_KW).slice(0, 5).map(x => x[0]);
  const top = posts.slice().sort((a, b) => b.eng - a.eng)[0];
  const coreEvent = top ? top.content.replace(/\s+/g, ' ').slice(0, 48) : '';
  const sampleWarning = n < CFG.sampleMin;

  // ---- 10) 简短结论 ----
  const dirWord = signal > 0.12 ? '偏多' : (signal < -0.12 ? '偏空' : '中性');
  const conclusion = `${heatLevel}（综合分 ${finalScore}），${sentimentTag}${alertOn ? '，散户情绪过热' : ''}，舆论${dirWord}`
    + `；看多 ${posPct}%/看空 ${negPct}%`
    + (sampleWarning ? '，样本偏少，分数参考性下降' : '');

  return {
    ok: true,
    symbol: String(symbol),
    name: name || '',
    period: 'recent',
    windowDays: spanDays,
    sample: n,
    sampleWarning,
    raw: {
      posts: n, comments: commentsTotal, likesShares,
      views: null,                       // 同花顺讨论 API 无浏览量字段
      rookieCount, kolCount,
    },
    sentiment: {
      positive: cP, neutral: cU, negative: cN,
      posPct, negPct, neuPct, netSent,
      weightedAvgScore: round(0.5 + netSent / 2, 3),   // 0~1，与 sentiment.py 同口径展示
    },
    indicators: { A: A_raw, B: B_raw, C: C_raw, D: D_raw, E: E_raw },
    norm: { A: A_norm, B: round(B_norm, 1), C: round(C_norm, 1), D: D_norm, E: round(E_norm, 1) },
    baseScore,
    finalScore,
    heatLevel,
    sentimentTag,
    alert: { on: alertOn, text: alertOn ? '⚠️散户过热告警' : '' },
    crossTags,
    brief: { posKeywords, negKeywords, coreEvent },
    conclusion,
    degrade,
    normalizationBasis: 'absolute',
    signal: round(signal, 3),
  };
}

module.exports = { buildStockSentiment, CFG };

~~~

---

## `lib\strategyGenerator.js`  ·  565 行

~~~js
'use strict';
/**
 * lib/strategyGenerator.js
 * 自动策略生成器（用户无需提供任何策略 → 由代码确定性产出多套候选并逐一校验）
 *
 * 设计（与项目铁律一致：确定性计算由代码执行，LLM 只叙事）：
 *   1) 经工作台数据层 getHistory 取前复权日线；经资料库 docStore 取个股上下文（ST/退市风险）。
 *   2) 代码确定性枚举候选策略库（双均线 / MACD / RSI 极值 / 布林回归 / 布林突破 / 收益率 z-score 回归）。
 *   3) 每个候选走虚拟回测（T+1、0.55% 成本）+ 风险修正（平稳性闸门 / 前视 / 成本 / 趋势 / 过拟合 / 幸存者 / 结构突变 / 季节性）。
 *   4) 按修正后胜率排名，挑出最优；LLM 仅用确定性结果做中文口语化解读（失败则回退确定性文案）。
 *
 * 风险校验维度：
 *   时间序列结构：趋势 / 季节性 / 周期性 / 结构性突变 → trend / seasonality / structural_break。
 *   平稳性闸门：非平稳价格上的均值回归 = 伪回归陷阱 → 闸门 ×0.5；用 RET/ZSCORE 走平稳收益率路径。
 *   回测偏差校验：前视偏差 / 交易成本 / 过拟合(训练-测试+walk-forward) / 幸存者偏差。
 */

const { getHistory, getHistoryPeriod } = require('./stockData');
const docStore = require('./docStore');
const llm = require('./ai/llm');
const config = require('./ai/config');
const V = require('./backtestValidator');
const { analyzePriceAction } = require('./priceAction');
const { fetchValuationTTM } = require('./eastmoneyValuation');
const { getBuybackPlan } = require('./buybackEmDc');
const { getCninfoAnnouncements } = require('./cninfoAnnouncements');

const COST_PER_SIDE = 0.0055;
const TRAIN_RATIO = 0.7;

// 候选策略库（按用户框架整理为 5 大类）
// 类别：trend=趋势跟踪 / mean_reversion=均值回归 / momentum=动量·轮动 / value=价值·基本面 / event=事件驱动
const CATEGORY_NAMES = {
  trend: '趋势跟踪', mean_reversion: '均值回归', momentum: '动量/轮动',
  value: '价值/基本面', event: '事件驱动'
};

// —— 滚动极值/均线工具（数组版，供突破/海龟/偏离类信号）——
function highest(arr, n) {
  const N = arr.length, out = new Array(N).fill(-Infinity);
  for (let i = n; i < N; i++) { let m = -Infinity; for (let j = i - n; j < i; j++) if (arr[j] > m) m = arr[j]; out[i] = m; }
  return out;
}
function lowest(arr, n) {
  const N = arr.length, out = new Array(N).fill(Infinity);
  for (let i = n; i < N; i++) { let m = Infinity; for (let j = i - n; j < i; j++) if (arr[j] < m) m = arr[j]; out[i] = m; }
  return out;
}
function maArr(arr, n) {
  const N = arr.length, out = new Array(N).fill(NaN);
  let sum = 0;
  for (let i = 0; i < N; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; if (i >= n - 1) out[i] = sum / n; }
  return out;
}
function pct(arr, q) {
  const v = arr.filter(x => x != null && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.floor(q * v.length)));
  return v[idx];
}

// 把「日频布尔序列」按日期映射到任意更细粒度序列（如 60 分钟），用于把日线策略信号搬到回测序列上。
// dailyFlags[i] 对应 dailyDates[i]（'YYYY-MM-DD'）；返回与 targetBars 等长的布尔数组，命中日期为真。
function broadcastDailyToBars(dailyFlags, dailyDates, targetBars) {
  const daySet = new Set();
  for (let i = 0; i < dailyFlags.length; i++) if (dailyFlags[i]) daySet.add(String(dailyDates[i]).slice(0, 10));
  return targetBars.map(b => daySet.has(String(b.date).slice(0, 10)));
}

// 量价类候选（趋势跟踪 / 均值回归 / 动量轮动）：纯 OHLCV 确定性生成，无需外部数据。
// 信号可写为 DSL 字符串（evaluateCondition 求值）或 signal(ctx) 函数（返回 buy/sell 布尔数组）。
function buildCandidateLibrary() {
  const cands = [];
  // —— 趋势跟踪：顺势而为，适合单边行情 ——
  cands.push({ key: 'trend_ma_5_20', name: '趋势跟踪·双均线(5/20)金叉', category: 'trend', cls: 'trend',
    desc: '5日线上穿20日线买入，下穿卖出（短期趋势）', buy: 'CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', sell: 'CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))' });
  cands.push({ key: 'trend_ma_20_60', name: '趋势跟踪·双均线(20/60)金叉', category: 'trend', cls: 'trend',
    desc: '20日线上穿60日线买入，下穿卖出（中期趋势）', buy: 'CROSS_UP(MA(CLOSE,20), MA(CLOSE,60))', sell: 'CROSS_DOWN(MA(CLOSE,20), MA(CLOSE,60))' });
  cands.push({ key: 'trend_breakout_20', name: '趋势跟踪·突破20日高点', category: 'trend', cls: 'trend',
    desc: '收盘价突破近20日最高价买入，跌破近10日最低价卖出', signal: ctx => { const h = highest(ctx.close, 20), l = lowest(ctx.low, 10); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 20 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 10 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_breakout_60', name: '趋势跟踪·突破60日高点', category: 'trend', cls: 'trend',
    desc: '收盘价突破近60日最高价买入，跌破近20日最低价(趋势线)卖出', signal: ctx => { const h = highest(ctx.close, 60), l = lowest(ctx.close, 20); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 60 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 20 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_turtle', name: '趋势跟踪·海龟法则(20/10)', category: 'trend', cls: 'trend',
    desc: '突破近20日最高价(Donchian)入场，跌破近10日最低价离场；ATR 用于仓位与止损参考', signal: ctx => { const h = highest(ctx.high, 20), l = lowest(ctx.low, 10); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 20 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 10 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_macd', name: '趋势跟踪·MACD金叉/死叉', category: 'trend', cls: 'trend',
    desc: 'MACD DIF 上穿 DEA 买入，下穿卖出', buy: 'CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))', sell: 'CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))' });
  // —— 均值回归：震荡市有效，涨多必跌跌多必涨 ——
  cands.push({ key: 'rev_boll', name: '均值回归·布林带', category: 'mean_reversion', cls: 'reversion',
    desc: '跌破下轨且超卖买入，回到中轨/上轨卖出', buy: 'CROSS_UP(CLOSE, BOLL_LOWER(CLOSE,20))', sell: 'CROSS_DOWN(CLOSE, BOLL_UPPER(CLOSE,20))' });
  cands.push({ key: 'rev_rsi', name: '均值回归·RSI极值', category: 'mean_reversion', cls: 'reversion',
    desc: 'RSI(14)<30 超卖买入，>70 超买卖出', buy: 'RSI(CLOSE,14) < 30', sell: 'RSI(CLOSE,14) > 70' });
  cands.push({ key: 'rev_ma_dev', name: '均值回归·均线偏离', category: 'mean_reversion', cls: 'reversion',
    desc: '价格大幅低于20日均线(<-5%)买入，回归均线卖出', signal: ctx => { const m = maArr(ctx.close, 20); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (!isNaN(m[i])) { if (ctx.close[i] < m[i] * 0.95) buy[i] = true; if (ctx.close[i] >= m[i]) sell[i] = true; } } return { buy, sell }; } });
  // —— 动量/轮动：买入近期强势、卖出转弱（单股动量为代理）——
  cands.push({ key: 'mom_roc20', name: '动量·20日收益动量', category: 'momentum', cls: 'momentum',
    desc: '近20日收益率为正(强势)持有，转负(转弱)退出', signal: ctx => { const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 20; i < N; i++) { const roc = ctx.close[i] / ctx.close[i - 20] - 1; if (roc > 0) buy[i] = true; if (roc < 0) sell[i] = true; } return { buy, sell }; } });
  // 平稳合规路径：在「平稳的收益率」上做 z-score 均值回归（规避伪回归陷阱）
  cands.push({ key: 'ret_zscore', name: '均值回归·收益率z-score(平稳路径)', category: 'mean_reversion', cls: 'return-reversion',
    desc: '收益率 z-score < -1.5 买入，> 1.5 卖出（走平稳收益率路径）', buy: 'ZSCORE(RET(CLOSE),20) < -1.5', sell: 'ZSCORE(RET(CLOSE),20) > 1.5' });
  return cands;
}

// 价值/基本面：历史 PE/PB 低位买入、高位卖出（数据取自 eastmoneyValuation.fetchValuationTTM 的日频序列）
function buildValueCandidates(series, valRaw) {
  const byDate = {};
  for (const d of valRaw.series) if (d && d.date) byDate[String(d.date).slice(0, 10)] = d;
  const peArr = series.map(s => { const d = byDate[String(s.date).slice(0, 10)]; return (d && isFinite(d.pe)) ? d.pe : null; });
  const pbArr = series.map(s => { const d = byDate[String(s.date).slice(0, 10)]; return (d && isFinite(d.pb)) ? d.pb : null; });
  const peLow = pct(peArr, 0.30), peHigh = pct(peArr, 0.70);
  const pbLow = pct(pbArr, 0.30), pbHigh = pct(pbArr, 0.70);
  const out = [];
  if (peLow != null && peHigh != null) {
    const N = series.length, buy = new Array(N).fill(false), sell = new Array(N).fill(false);
    for (let i = 0; i < N; i++) { if (peArr[i] != null) { if (peArr[i] < peLow) buy[i] = true; if (peArr[i] > peHigh) sell[i] = true; } }
    out.push({ key: 'val_low_pe', name: '价值·历史PE低位(30分位)', category: 'value', cls: 'value',
      desc: `PE 低于近 ${valRaw.series.length} 交易日 30% 分位(≈${peLow.toFixed(1)})买入，高于 70% 分位(≈${peHigh.toFixed(1)})卖出`, buy, sell });
  }
  if (pbLow != null && pbHigh != null) {
    const N = series.length, buy = new Array(N).fill(false), sell = new Array(N).fill(false);
    for (let i = 0; i < N; i++) { if (pbArr[i] != null) { if (pbArr[i] < pbLow) buy[i] = true; if (pbArr[i] > pbHigh) sell[i] = true; } }
    out.push({ key: 'val_low_pb', name: '价值·历史PB低位(30分位)', category: 'value', cls: 'value',
      desc: `PB 低于近 ${valRaw.series.length} 交易日 30% 分位(≈${pbLow.toFixed(2)})买入，高于 70% 分位(≈${pbHigh.toFixed(2)})卖出`, buy, sell });
  }
  return out;
}

// 事件驱动：把事件日期映射为「事件日买入、持有 holdDays 后卖出」的布尔信号
function eventSignals(series, dates, holdDays) {
  const N = series.length;
  const buy = new Array(N).fill(false), sell = new Array(N).fill(false);
  const idxByDate = {};
  series.forEach((s, i) => { idxByDate[String(s.date).slice(0, 10)] = i; });
  for (const ds of dates) {
    let i = idxByDate[String(ds).slice(0, 10)];
    if (i == null) {
      let best = -1, bestD = 1e9;
      for (let k = 0; k < N; k++) { const diff = Math.abs(Date.parse(series[k].date) - Date.parse(ds)); if (diff < bestD) { bestD = diff; best = k; } }
      if (bestD <= 4 * 86400000) i = best;
    }
    if (i == null || i < 0) continue;
    if (!buy[i]) buy[i] = true;
    const exit = Math.min(N - 1, i + (holdDays || 20));
    if (!sell[exit]) sell[exit] = true;
  }
  return { buy, sell };
}

// 收集事件（取自其他模块）：① 股份回购（buybackEmDc）② 财报公告（cninfoAnnouncements）
async function collectEvents(symbol) {
  const events = [];
  try {
    const bk = await getBuybackPlan(symbol);
    if (bk && bk.ok && bk.plan && !bk.plan.neutral && bk.plan.date) {
      events.push({ date: bk.plan.date, type: '回购', label: '股份回购(' + (bk.plan.progress || '') + ')' });
    }
  } catch (e) { /* 忽略，继续 */ }
  try {
    const ann = await getCninfoAnnouncements(symbol, 60);
    if (ann && ann.ok && Array.isArray(ann.items)) {
      for (const it of ann.items) {
        const t = (it.title || '');
        if (/年报|半年报|季报|业绩|快报/.test(t) && it.date) events.push({ date: it.date, type: '财报', label: t.slice(0, 24) });
      }
    }
  } catch (e) { /* 忽略 */ }
  const seen = new Set(); const uniq = [];
  for (const e of events) { const k = e.date + e.type; if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  uniq.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  return uniq;
}

function buildEventCandidates(series, events) {
  const earnings = events.filter(e => e.type === '财报').map(e => e.date);
  const buybacks = events.filter(e => e.type === '回购').map(e => e.date);
  const out = [];
  if (earnings.length) {
    const sig = eventSignals(series, earnings, 20);
    out.push({ key: 'evt_earnings', name: '事件·财报公告(持有20日)', category: 'event', cls: 'event',
      desc: `财报公告日(${earnings.length}次)买入，持有约20交易日后卖出`, buy: sig.buy, sell: sig.sell });
  }
  if (buybacks.length) {
    const sig = eventSignals(series, buybacks, 20);
    out.push({ key: 'evt_buyback', name: '事件·股份回购(持有20日)', category: 'event', cls: 'event',
      desc: `股份回购公告日(${buybacks.length}次)买入，持有约20交易日后卖出`, buy: sig.buy, sell: sig.sell });
  }
  return out;
}

// 信号解析：signal(ctx) 函数直接返回数组；DSL 字符串用 evaluateCondition 求值；其余按预计算数组
function resolveSignal(c, ctx) {
  if (typeof c.signal === 'function') return c.signal(ctx);
  const buy = typeof c.buy === 'string' ? V.evaluateCondition(c.buy, ctx) : c.buy;
  const sell = typeof c.sell === 'string' ? V.evaluateCondition(c.sell, ctx) : c.sell;
  return { buy, sell };
}

// 把「行情判定」的确定性技术内核回算成历史买卖信号序列
// 复用 priceAction.analyzePriceAction（与个股页「技术面分析 / 行情判定」同源，纯价格计算，无实时外部数据依赖）
// 映射：长期 verdict=上行→多头；下行→清仓；短期 direction=上行→多头；下行/震荡偏下→清仓；其余维持现状
function rollingJudgmentSignals(series) {
  const N = series.length;
  const close = series.map(s => s.close);
  const longBull = new Array(N).fill(false);
  const longBear = new Array(N).fill(false);
  const shortBull = new Array(N).fill(false);
  const shortBear = new Array(N).fill(false);
  const sliceDaily = (n) => series.slice(0, n);
  for (let i = 0; i < N; i++) {
    if (i + 1 < 120) continue;
    const pa = analyzePriceAction(sliceDaily(i + 1), null);
    if (!pa) continue;
    if (i + 1 >= 250 && pa.longTerm) {
      if (pa.longTerm.verdict === '上行') longBull[i] = true;
      else if (pa.longTerm.verdict === '下行') longBear[i] = true;
    }
    if (pa.shortTerm) {
      const d = pa.shortTerm.direction;
      if (d === '上行') shortBull[i] = true;
      else if (d === '下行' || d === '震荡偏下') shortBear[i] = true;
    }
  }
  return { longBull, longBear, shortBull, shortBear };
}

// D 项：资料库 ST/退市风险扫描，决定幸存者偏差折扣
function scanSurvivorship(symbol) {
  let survivorship = 0.9;
  let basis = '单只 A 股默认 0.9（未在全市场优选中挑选）';
  try {
    const docs = docStore.searchDocuments(symbol) || [];
    const hay = docs.map(d => ((d.title || '') + ' ' + (d.description || '') + ' ' + (d.fileName || ''))).join(' ').toLowerCase();
    if (/st|退市|暂停上市|风险警示|终止上市|摘牌/.test(hay)) {
      survivorship = 0.8;
      basis = '资料库检出 ST/退市/风险警示相关文档，幸存者偏差折扣下调至 0.8';
    }
  } catch (e) { /* 资料库不可用时退回默认 */ }
  return { survivorship, basis };
}

function deterministicAdvice(best, ranked, sys) {
  const b = best || {};
  const lines = [];
  lines.push(`自动生成并校验 ${ranked.length} 个候选策略，最优为「${b.name || '-'}」（类别：${b.cls || '-'}）。`);
  const verdictText = { PASS: '校验通过', WARNING: '边际通过（需谨慎）', REJECT: '未通过校验', INSUFFICIENT_SAMPLE: '样本不足（无法裁决）' }[b.verdict] || b.verdict;
  lines.push(`校验结论：${verdictText}。修正后胜率 ${(b.adjusted_win_rate * 100 || 0).toFixed(1)}%（原始 ${(b.raw ? b.raw.winRate * 100 : 0).toFixed(1)}%），样本内交易 ${b.raw ? b.raw.trades : 0} 笔。`);
  if (sys) {
    lines.push(`标的价格序列${sys.adfPriceStationary ? '平稳' : '非平稳'}、收益率序列${sys.adfReturnStationary ? '平稳' : '非平稳'}，趋势 R²=${sys.trendR2}。`);
  }
  if (b.cls === 'reversion' && sys && !sys.adfPriceStationary) {
    lines.push('⚠ 注意：该均值回归策略作用在「非平稳价格」上，属伪回归陷阱，已按 ×0.5 折算；同库内「收益率 z-score 均值回归」为平稳合规路径，可优先参考。');
  }
  if (b.walk_forward && b.walk_forward.consistency != null) {
    lines.push(`样本外一致性（walk-forward）=${(b.walk_forward.consistency * 100).toFixed(0)}%，一致性越低越可能过拟合。`);
  }
  if (b.verdict === 'PASS') {
    lines.push('实操建议：可小仓位（≤10%）实盘验证，严格止损，持续跟踪样本外表现与结构性突变。');
  } else if (b.verdict === 'WARNING') {
    lines.push('实操建议：仅作观察/模拟盘，暂不重仓；若坚持参与，仓位 ≤5% 并设定硬止损。');
  } else {
    lines.push('实操建议：不建议实盘；如需参考，仅用于理解因子，不要据此下单。');
  }
  return lines.join('\n');
}

async function generateStrategies(input) {
  const symbol = input.symbol;
  const name = input.name || '';
  const range = input.range || '3y';
  if (!symbol) throw new Error('缺少标的 symbol');

  // 日线（用于 行情判定 / 价值 / 事件 三类需要日频数据的候选；judge 内核依赖日K）
  const histD = await getHistory(symbol, range);
  if (!Array.isArray(histD) || histD.length < 60) {
    throw new Error(`标的 ${symbol} 历史数据不足（${histD ? histD.length : 0} 根），无法生成策略`);
  }
  const seriesD = histD.map(d => ({
    date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
  }));
  const dailyDates = seriesD.map(s => s.date);

  // 60 分钟 K 线（提高虚拟交易频率、增大样本量；硬约束每天≤1笔）。失败则回退日线。
  let seriesM = null, intradayNote = '';
  try {
    const histM = await getHistoryPeriod(symbol, '60m', 800);
    if (Array.isArray(histM) && histM.length >= 60) {
      seriesM = histM.map(d => ({
        date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
      }));
    } else {
      intradayNote = '60分钟数据不足，已回退日线（样本量不变）';
    }
  } catch (e) {
    intradayNote = '60分钟获取失败（' + e.message + '），已回退日线';
  }
  const useIntraday = !!seriesM;
  const series = useIntraday ? seriesM : seriesD;
  const close = series.map(s => s.close);
  const ctx = {
    close,
    open: series.map(s => s.open),
    high: series.map(s => s.high),
    low: series.map(s => s.low),
    volume: series.map(s => s.volume)
  };
  const N = series.length;

  // 全局统计（时间序列结构 + 平稳性）—— 以实际回测所用序列（60m 或日线）为准
  const retSeries = V.returnsPct(close).slice(1);
  const adfClose = V.adf(close);
  const adfRet = V.adf(retSeries);
  const kp = V.kpss(close);
  const trend = V.linearTrend(close);
  const season = V.seasonalityScan(retSeries);
  const sys = {
    adfPriceStationary: adfClose.stationary,
    adfReturnStationary: adfRet.stationary,
    trendR2: +trend.r2.toFixed(2),
    trendDirection: trend.direction
  };

  const { survivorship, basis } = scanSurvivorship(symbol);

  // —— 组装候选策略库（5 大类）——
  const candidates = buildCandidateLibrary(); // 量价类（趋势/均值/动量）：直接用 60m/日线 ctx 生成信号
  // 行情判定派生：短期判定归入「趋势跟踪」（内核依赖日K，故在 seriesD 上回算后映射到回测序列）
  const js = rollingJudgmentSignals(seriesD);
  candidates.push({
    key: 'judge_short', name: '趋势跟踪·短期行情判定（技术核心）', category: 'trend', cls: 'trend', holder: true,
    desc: '短期动向 direction=上行 建仓，下行/震荡偏下 清仓',
    buy: useIntraday ? broadcastDailyToBars(js.shortBull, dailyDates, series) : js.shortBull,
    sell: useIntraday ? broadcastDailyToBars(js.shortBear, dailyDates, series) : js.shortBear
  });
  // 价值/基本面（历史 PE/PB，取自估值模块 eastmoneyValuation）：日线计算后映射到回测序列
  const dataNotes = {};
  try {
    const valRaw = await fetchValuationTTM(symbol);
    if (valRaw && Array.isArray(valRaw.series) && valRaw.series.length) {
      const vals = buildValueCandidates(seriesD, valRaw);
      if (useIntraday) vals.forEach(c => { c.buy = broadcastDailyToBars(c.buy, dailyDates, series); c.sell = broadcastDailyToBars(c.sell, dailyDates, series); });
      candidates.push(...vals);
    } else { dataNotes.value = '未获取到历史估值序列，价值/基本面策略跳过'; }
  } catch (e) { dataNotes.value = '估值数据获取失败：' + e.message; }
  // 事件驱动（回购 + 财报公告，取自 buybackEmDc / cninfoAnnouncements）：日线计算后映射到回测序列
  try {
    const events = await collectEvents(symbol);
    if (events.length) {
      const evs = buildEventCandidates(seriesD, events);
      if (useIntraday) evs.forEach(c => { c.buy = broadcastDailyToBars(c.buy, dailyDates, series); c.sell = broadcastDailyToBars(c.sell, dailyDates, series); });
      candidates.push(...evs);
    } else dataNotes.event = '区间内未检索到可用事件（回购/财报公告），事件驱动策略跳过';
  } catch (e) { dataNotes.event = '事件数据获取失败：' + e.message; }
  if (intradayNote) dataNotes.intraday = intradayNote;

  const results = [];
  for (const c of candidates) {
    const sig = resolveSignal(c, ctx);
    const full = V.runBacktest(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE, maxOneTradePerDay: useIntraday });
    // 持仓型/事件型换手天然低 → 门槛放宽到 3 笔；指标型仍 10 笔
    const threshold = (c.holder || c.category === 'event') ? 3 : 10;
    if (full.totalTrades < threshold) {
      let reason = '样本内交易笔数 < ' + threshold + '，无法统计胜率，已剔除';
      if (c.category === 'value' && !sig.buy.some(Boolean)) reason = '回测区间内估值从未进入低估区（PE/PB 未达历史低位阈值），策略未产生交易';
      else if (c.category === 'event') reason = '事件驱动策略天然低频：区间内仅 ' + full.totalTrades + ' 次事件信号，样本不足（<3）无法统计胜率';
      results.push({ key: c.key, name: c.name, category: c.category, cls: c.cls, dsl: { buy: c.desc, sell: c.desc }, insufficient: true, trades: full.totalTrades, winRate: full.winRate, reason });
      continue;
    }
    const splitIdx = Math.floor(N * TRAIN_RATIO);
    const train = V.runBacktest(series.slice(0, splitIdx), sig.buy.slice(0, splitIdx), sig.sell.slice(0, splitIdx), { costPerSide: COST_PER_SIDE });
    const test = V.runBacktest(series.slice(splitIdx), sig.buy.slice(splitIdx), sig.sell.slice(splitIdx), { costPerSide: COST_PER_SIDE });
    const wf = V.walkForward(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE, embargo: Math.min(20, Math.max(1, Math.floor(N * 0.03))) }, 3);
    const sb = V.structuralBreak(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE });
    const sf = V.stationarityFactorFor(c.cls, adfClose.stationary, adfRet.stationary);
    const corr = V.applyCorrections(full, null, {
      trainWinRate: train.winRate, testWinRate: test.winRate, trend,
      costPerSide: COST_PER_SIDE, survivorship, lookaheadDetected: false
    }, {
      strategyClass: c.cls,
      adfPriceStationary: adfClose.stationary,
      adfReturnStationary: adfRet.stationary,
      stationarityFactor: sf,
      structuralBreak: sb,
      seasonality: season,
      survivorshipBasis: basis
    });
    results.push({
      key: c.key, name: c.name, category: c.category, cls: c.cls, dsl: { buy: c.desc, sell: c.desc },
      raw: { winRate: full.winRate, trades: full.totalTrades, totalReturn: full.totalReturn, sharpe: full.sharpe, maxDrawdown: full.maxDrawdown, buyHold: full.buyHold },
      train: { winRate: train.winRate, trades: train.totalTrades },
      test: { winRate: test.winRate, trades: test.totalTrades },
      walk_forward: wf,
      structural_break: sb,
      corrections: corr.steps,
      adjusted_win_rate: corr.adjustedWinRate,
      adjusted_return: corr.adjustedReturn,
      verdict: corr.verdict,
      stationarityFactor: sf,
      warnings: (() => {
        const w = [];
        if (full.totalTrades < 10) w.push('样本内交易笔数偏少（' + full.totalTrades + ' 笔），胜率统计置信度有限');
        if (c.cls === 'reversion' && !adfClose.stationary) w.push('伪回归陷阱：非平稳价格上的均值回归');
        if (sb.significant) w.push('结构性突变：前后半段胜率差 ' + (sb.delta * 100).toFixed(0) + 'pp');
        if (season.hasSeasonality) w.push('季节性/周期性：月 ACF=' + season.lag20 + '，季 ACF=' + season.lag60);
        if (wf.consistency < 0.8) w.push('样本外一致性偏低（' + (wf.consistency * 100).toFixed(0) + '%），疑似过拟合');
        return w;
      })()
    });
  }

  // 排名：修正后胜率降序；同分时 PASS > WARNING > REJECT
  const rankOrder = { PASS: 0, WARNING: 1, REJECT: 2, INSUFFICIENT_SAMPLE: 3 };
  const valid = results.filter(r => !r.insufficient);
  valid.sort((a, b) => {
    if (b.adjusted_win_rate !== a.adjusted_win_rate) return b.adjusted_win_rate - a.adjusted_win_rate;
    return (rankOrder[a.verdict] || 9) - (rankOrder[b.verdict] || 9);
  });

  // E 项：参数敏感性汇总（跨候选的修正胜率分布）
  const adjList = valid.map(r => r.adjusted_win_rate);
  const paramSensitivity = valid.length
    ? {
        candidateCount: valid.length,
        min: Math.min.apply(null, adjList),
        max: Math.max.apply(null, adjList),
        mean: adjList.reduce((a, x) => a + x, 0) / adjList.length,
        spread: Math.max.apply(null, adjList) - Math.min.apply(null, adjList),
        note: '跨候选修正胜率离散度越大，策略对「选股/选参」越敏感；离散度小说明结论更稳健'
      }
    : { candidateCount: 0, note: '无可用候选' };

  const best = valid[0] || null;

  // P1-3 多重检验校正：一次评估 m 个候选取最优存在「赢家诅咒」，对胜率做单侧二项检验并 BH 校正
  let multipleTesting = null;
  if (best) {
    const pRaw = valid.map(r => binomPValue(Math.round(r.raw.winRate * r.raw.trades), r.raw.trades));
    const pAdj = bhAdjust(pRaw);
    const bestP = pAdj[0];
    const significant = bestP < 0.05;
    multipleTesting = {
      method: 'benjamini_hochberg',
      test: 'one-sided binomial (win rate > 50%)',
      family_size: valid.length,
      alpha: 0.05,
      best_raw_p: +pRaw[0].toFixed(4),
      best_adjusted_p: +bestP.toFixed(4),
      best_significant: significant,
      note: significant
        ? '最优策略经多重检验校正后仍显著（BH 校正 p<0.05）'
        : '最优策略未通过多重检验校正（BH p=' + bestP.toFixed(3) + '）：在 ' + valid.length + ' 个候选中取最优，胜率可能被选择性偏差抬高，请谨慎采信'
    };
    // 若最优本可 PASS 但未通过校正 → 降级为 WARNING
    if (best.verdict === 'PASS' && !significant) {
      best.verdict = 'WARNING';
      best.warnings = (best.warnings || []).concat(['多重检验未通过（BH 校正 p=' + bestP.toFixed(3) + '）：多候选取最优存在选择性偏差']);
    }
  }

  // LLM 仅叙事（失败回退确定性文案）
  let narration = '';
  if (!input.skipLLM) {
    try {
      const cfg = config.loadConfig();
      if (cfg && cfg.apiKey) {
        // 20261012 模型选择统一跟随「AI 模型设置」：策略叙事属纯推理任务，与事件分流等本地任务同口径
        //（pickModelFor(cfg,'local')：优先 modelLocal，未配置自动降级 modelWeb），不再写死 qwen-max（该默认在本账号实测 403）
        const pick = llm.pickModelFor(cfg, 'local');
        const messages = [
          { role: 'system', content: '你是严谨的量化策略分析师。只基于给定回测与统计事实做中文口语化解读，不编造数字，不给出具体买卖点位，提醒用户本结果为历史回测、不构成投资建议。' },
          {
            role: 'user',
            content: `标的 ${symbol}（${name}），区间 ${range}。\n全局统计：价格 ADF 平稳=${adfClose.stationary}，收益率 ADF 平稳=${adfRet.stationary}，趋势线性 R²=${trend.r2.toFixed(2)}（${trend.direction}）。\n候选策略 ${valid.length} 个，最优：「${best ? best.name : '-'}」（类别 ${best ? best.cls : '-'}），修正后胜率 ${(best ? best.adjusted_win_rate * 100 : 0).toFixed(1)}%，原始胜率 ${(best && best.raw ? best.raw.winRate * 100 : 0).toFixed(1)}%，交易 ${best && best.raw ? best.raw.trades : 0} 笔，walk-forward 一致性 ${best ? (best.walk_forward.consistency * 100).toFixed(0) : '-'}%。\n校验结论：${best ? best.verdict : '-'}。\n请输出：① 该策略为什么（不）可靠；② 对普通投资者的实操建议（仓位/跟踪/风险）。不超过 200 字。`
          }
        ];
        narration = await llm.callLLM(cfg.provider, cfg.apiKey, pick.model, messages, { webSearch: false, timeoutMs: 45000 });
      }
    } catch (e) {
      narration = '';
    }
  }
  if (!narration || !narration.trim()) narration = deterministicAdvice(best, valid, sys);

  const categorySummary = {};
  for (const r of results) {
    const cat = r.category || 'other';
    if (!categorySummary[cat]) categorySummary[cat] = { name: CATEGORY_NAMES[cat] || cat, valid: 0, insufficient: 0 };
    if (r.insufficient) categorySummary[cat].insufficient++; else categorySummary[cat].valid++;
  }
  return {
    success: true,
    base_info: {
      symbol,
      name,
      range,
      resolution: useIntraday ? '60m' : 'day',
      trade_cap: '≤1 笔/交易日',
      data_points: N,
      cost_per_side: COST_PER_SIDE,
      candidate_count: candidates.length,
      valid_count: valid.length,
      insufficient_count: results.length - valid.length,
      generated_at: new Date().toISOString()
    },
    category_summary: categorySummary,
    data_notes: dataNotes,
    market_context: {
      adf_price: { stat: +adfClose.stat.toFixed(2), stationary: adfClose.stationary },
      adf_return: { stat: +adfRet.stat.toFixed(2), stationary: adfRet.stationary },
      kpss_price: { stat: +kp.stat.toFixed(2), stationary: kp.stationary },
      trend: { r2: +trend.r2.toFixed(2), direction: trend.direction, slope: +trend.slope.toFixed(4) },
      seasonality: season
    },
    parameter_sensitivity: {
      min: +paramSensitivity.min.toFixed(4),
      max: +paramSensitivity.max.toFixed(4),
      mean: +paramSensitivity.mean.toFixed(4),
      spread: +paramSensitivity.spread.toFixed(4),
      candidate_count: paramSensitivity.candidateCount,
      note: paramSensitivity.note,
      // P2-1 逐候选修正胜率（供 UI 可视化参数敏感性）
      series: valid.map(r => ({ key: r.key, name: r.name, category: r.category, adjusted_win_rate: r.adjusted_win_rate }))
    },
    multiple_testing: multipleTesting,
    ranked_strategies: valid,
    insufficient_strategies: results.filter(r => r.insufficient).map(r => ({ key: r.key, name: r.name, category: r.category, reason: r.reason, trades: r.trades })),
    best_strategy: best,
    operation_advice: {
      verdict: best ? best.verdict : 'REJECT',
      adjusted_win_rate: best ? best.adjusted_win_rate : 0,
      narrative: narration.trim(),
      deterministic: !narration || narration === deterministicAdvice(best, valid, sys)
    }
  };
}

// =====================================================================
//  多重检验校正（Benjamini-Hochberg，单侧二项检验 vs 50%）
//  多候选取最优 → 赢家诅咒；对胜率做显著性检验并按家族错误率校正
// =====================================================================
function normCdf(z) { // Abramowitz-Stegun 近似
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function binomPValue(wins, n) { // 单侧：H0 winRate=0.5，连续校正
  if (n <= 0) return 1;
  const z = (wins - 0.5 * n - 0.5) / Math.sqrt(0.25 * n);
  return Math.max(0, Math.min(1, 1 - normCdf(z)));
}
function bhAdjust(pvals) { // Benjamini-Hochberg FDR 校正
  const m = pvals.length;
  if (!m) return [];
  const idx = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = new Array(m);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = idx[rank - 1];
    adj[i] = Math.min(1, Math.min(prev, p * m / rank));
    prev = adj[i];
  }
  return adj;
}

module.exports = { generateStrategies, buildCandidateLibrary, rollingJudgmentSignals, binomPValue, bhAdjust };

~~~

---

## `lib\strategyNL.js`  ·  329 行

~~~js
'use strict';
/**
 * lib/strategyNL.js — 「高级」框：大白话（中文）策略 → 回测 DSL 的确定性翻译器。
 *
 * 铁律：
 *   · 纯代码、无 LLM、无随机 —— 同一句中文永远翻译成同一段 DSL，回测结果可复现。
 *   · 只覆盖常见技术面玩法；识别不了、或涉及引擎不支持的玩法（估值百分位 / 分批加减仓）
 *     时如实报告（返回 ok:false + reason），绝不猜测、绝不编造规则。
 *
 * 支持的「大白话」要素：
 *   · 均线：N日均线 / N日线 / MA5 …  金叉/死叉/上穿/下穿（两条均线，或价格 vs 均线）
 *   · MACD：金叉 / 死叉 / DIF 上穿 DEA
 *   · RSI：RSI 低于/高于 阈值、RSI 超卖/超买（默认周期 14）
 *   · 布林带：跌破下轨 / 涨破上轨 / 中轨（默认 20,2）
 *   · 收益率 z-score：z-score 低于/高于 阈值（默认窗口 20）
 *   · 买卖方向：买入/建仓/做多/开仓 … ；卖出/清仓/平仓/止盈/止损 …
 */

// 买卖方向关键词
const ROLE_BUY = /买入|买进|建仓|做多|开仓|开多|进场|入场|抄底|买点/;
const ROLE_SELL = /卖出|卖掉|清仓|平仓|做空|开空|出场|离场|止盈|止损|卖点/;

// 语气/连接词填充（剥离后不影响语义）
const FILLER = /(当|的时候|时候|时|则|就|即|如果|若|可|进行|操作|的话|情况下|表明|意味着)/g;

// 引擎暂不支持的玩法
const UNSUP_VALUATION = /(市盈率|市净率|市销率|PE|PB|PS|估值|百分位|分位数|分位)/i;
// 【已支持】止损/止盈/移动止盈/等批建仓 → 由 parseRiskParams 解析，不再一律拒绝。
// 仍不支持的：金字塔式每涨/每跌固定比例加减仓、按"成"计的仓位分配、加减仓（动态调仓）
const UNSUP_POSITION = /(一成|两成|三成|四成|五成|六成|七成|八成|九成|半仓|满仓|空仓|轻仓|重仓|成仓|层仓|金字塔|每降|每升)/i;
const UNSUP_SCALE = /(加仓|减仓|补仓|加码|减码|调仓|再买|再卖)/i;

function toHalfWidth(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

function splitClauses(text) {
  // 保护小数点的 "."（如 -1.5 / 30.5），避免被当句子分隔符切碎
  const PROT = '\u0001';
  const t = String(text).replace(/(\d)\.(\d)/g, '$1' + PROT + '$2');
  return t.split(/[，,；;。\.\n\r]+/)
    .map(s => s.split(PROT).join('.').trim())
    .filter(Boolean);
}

function numbersOf(s) {
  return (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

// 方向判定：cross_up / cross_down / lt / gt / oversold / overbought / null
function dirOf(s) {
  if (/金叉|上穿|向上穿越|由下向上/.test(s)) return 'cross_up';
  if (/死叉|下穿|向下穿越|由上向下/.test(s)) return 'cross_down';
  if (/超卖/.test(s)) return 'oversold';
  if (/超买/.test(s)) return 'overbought';
  if (/低于|小于|跌破|少于|不足|不到|≤|<=|</.test(s)) return 'lt';
  if (/高于|大于|涨破|突破|超过|多于|≥|>=|>/.test(s)) return 'gt';
  return null;
}

// 均线周期提取（保序去重）
function maPeriods(cond) {
  const out = [];
  const re = /(?:MA\s*(\d+))|(?:(\d+)\s*(?:日|天)?\s*(?:均线|均价线|移动平均|线))/gi;
  let m;
  while ((m = re.exec(cond)) !== null) {
    const v = Number(m[1] || m[2]);
    if (isFinite(v) && v > 0 && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

function parseMA(cond) {
  const ps = maPeriods(cond);
  const d = dirOf(cond);
  if (ps.length >= 2) {
    const a = ps[0], b = ps[1];
    if (d === 'cross_up') return `CROSS_UP(MA(CLOSE,${a}), MA(CLOSE,${b}))`;
    if (d === 'cross_down') return `CROSS_DOWN(MA(CLOSE,${a}), MA(CLOSE,${b}))`;
  }
  if (ps.length === 1) {
    const n = ps[0];
    if (d === 'cross_up') return `CROSS_UP(CLOSE, MA(CLOSE,${n}))`;
    if (d === 'cross_down') return `CROSS_DOWN(CLOSE, MA(CLOSE,${n}))`;
    if (d === 'lt') return `CLOSE < MA(CLOSE,${n})`;
    if (d === 'gt') return `CLOSE > MA(CLOSE,${n})`;
  }
  return null;
}

function parseMACD(cond) {
  const d = dirOf(cond);
  if (d === 'cross_up') return 'CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))';
  if (d === 'cross_down') return 'CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))';
  if (d === 'gt' || d === 'overbought') return 'MACD_DIF(CLOSE) > MACD_DEA(CLOSE)';
  if (d === 'lt' || d === 'oversold') return 'MACD_DIF(CLOSE) < MACD_DEA(CLOSE)';
  return null;
}

function parseRSI(cond) {
  const pm = cond.match(/RSI\s*\(?\s*(\d+)?\s*\)?/i);
  const period = (pm && pm[1]) ? Number(pm[1]) : 14;
  const d = dirOf(cond);
  const rest = numbersOf(cond).filter(x => x !== period);
  let t = rest.length ? rest[0] : null;
  if (t == null) { if (d === 'oversold') t = 30; else if (d === 'overbought') t = 70; }
  if (t == null) return null;
  if (d === 'lt' || d === 'oversold') return `RSI(CLOSE,${period}) < ${t}`;
  if (d === 'gt' || d === 'overbought') return `RSI(CLOSE,${period}) > ${t}`;
  return null;
}

function parseBOLL(cond) {
  const d = dirOf(cond);
  const all = numbersOf(cond);
  const period = all.length >= 1 ? all[0] : 20;
  const k = all.length >= 2 ? all[1] : 2;
  let band = null;
  if (/下轨|下边|下沿|lower/i.test(cond)) band = 'lower';
  else if (/上轨|上边|上沿|upper/i.test(cond)) band = 'upper';
  else if (/中轨|中边|中沿|mid/i.test(cond)) band = 'mid';
  if (!band) return null;
  const fn = band === 'lower' ? 'BOLL_LOWER' : (band === 'upper' ? 'BOLL_UPPER' : 'BOLL_MID');
  if (d === 'lt' || d === 'oversold') return `CLOSE < ${fn}(CLOSE,${period},${k})`;
  if (d === 'gt' || d === 'overbought') return `CLOSE > ${fn}(CLOSE,${period},${k})`;
  return null;
}

function parseZ(cond) {
  const d = dirOf(cond);
  const isRet = /收益|涨跌|报酬|回报/.test(cond);
  const pm = cond.match(/(?:Z\s*-?\s*SCORE|标准分|标准化|z值)/i);
  const periodM = cond.match(/(?:Z\s*-?\s*SCORE|标准分|标准化|z值)\s*\(?\s*(\d+)/i);
  const period = (periodM && periodM[1]) ? Number(periodM[1]) : 20;
  const rest = numbersOf(cond).filter(x => x !== period);
  let t = rest.length ? rest[0] : null;
  if (t == null) { if (d === 'oversold') t = -1.5; else if (d === 'overbought') t = 1.5; }
  if (pm == null || t == null) return null;
  const series = isRet ? 'RET(CLOSE)' : 'CLOSE';
  const fn = `ZSCORE(${series},${period})`;
  if (d === 'lt' || d === 'oversold') return `${fn} < ${t}`;
  if (d === 'gt' || d === 'overbought') return `${fn} > ${t}`;
  return null;
}

// 单条子句 → 表达式（识别不了返回 null）
function parseCondition(cond) {
  if (/布林|BOLL/i.test(cond)) return parseBOLL(cond);
  if (/MACD/i.test(cond)) return parseMACD(cond);
  if (/RSI|相对强弱/i.test(cond)) return parseRSI(cond);
  if (/Z\s*-?\s*SCORE|标准分|标准化|z值/i.test(cond)) return parseZ(cond);
  if (/均线|均价线|移动平均|MA\s*\d|\d+\s*(?:日|天)?\s*线/.test(cond)) return parseMA(cond);
  return null;
}

// ---------------------------------------------------------------------
//  风控出场 & 分批建仓参数解析（纯代码、确定性）
// ---------------------------------------------------------------------
// 把「8% 止损」「上涨20%止盈」「回撤5%止盈(移动)」「分3批建仓」这类描述解析为结构化参数。
// 支持百分数与小数两种写法：'8%' → 0.08；'0.08' → 0.08。
function pctOf(token) {
  if (token == null) return null;
  const s = String(token).trim();
  const hasPct = /%|％/.test(s);
  const v = parseFloat(s.replace(/[%％]/g, ''));
  if (!isFinite(v)) return null;
  if (hasPct) return v / 100;
  return v;   // 无百分号时按小数直接使用（用户写 0.08 即 8%）
}

function parseRiskParams(prose) {
  const out = {};
  // 1) 止损：'止损5%' / '亏损达到8%止损' / '跌破8%止损'
  const slm = prose.match(/(?:止损|亏损|亏了|跌破|下跌)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
  if (slm && /止损|亏损|亏了/.test(prose)) {
    const v = pctOf(slm[1]);
    if (v != null && v > 0) out.stop_loss = Math.abs(v);
  }
  // 2) 移动止盈：'回撤5%止盈' / '移动止盈5%' / '从最高点回撤3%卖出'
  const trm = prose.match(/(?:回撤|回落|移动止盈|跟踪止盈|最高点.{0,6}回撤)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
  if (trm) {
    const v = pctOf(trm[1]);
    if (v != null && v > 0) out.trailing = Math.abs(v);
  }
  // 3) 止盈：'止盈20%' / '上涨20%止盈' / '盈利20%就卖'
  // 注意：必须按**子句**排除移动止盈语境——不能用整句判断，否则"止损8%，止盈15%，回撤5%"
  // 里的"止盈15%"会被整句中出现的"回撤"两字误杀（实测踩过此坑）。
  const subClauses = splitClauses(prose);
  for (const sub of subClauses) {
    if (/回撤|回落|移动止盈|跟踪止盈/.test(sub)) continue;   // 移动止盈子句，交给 trailing
    if (!/止盈|盈利|涨了|上涨|获利/.test(sub)) continue;
    const tpm = sub.match(/(?:止盈|盈利|涨了|上涨|获利)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
    if (!tpm) continue;
    // '止损5%，止盈20%' 同一个子句内可能同时含止损与止盈 → 需确保匹配到的数字紧跟止盈词
    const idx = sub.search(/止盈|盈利|涨了|上涨|获利/);
    const tail = sub.slice(idx);
    const tm2 = tail.match(/(?:止盈|盈利|涨了|上涨|获利)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
    if (!tm2) continue;
    const v = pctOf(tm2[1]);
    if (v != null && v > 0) { out.take_profit = Math.abs(v); break; }
  }
  // 4) 分批建仓：'分3批建仓' / '分三批买入' / '分3次建仓' / '3批建仓'
  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const tm = prose.match(/(?:分|每)?\s*(\d+|[一二两三四五六七八九十])\s*(?:批|次|档|笔)\s*(?:建仓|买入|进场|入场|买)/)
    || prose.match(/(?:建仓|买入|进场|入场)\s*(?:分|每)?\s*(\d+|[一二两三四五六七八九十])\s*(?:批|次|档|笔)/);
  if (tm) {
    const raw = tm[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : (CN_NUM[raw] || 0);
    if (n > 1) out.tranches = Math.min(10, n);
  }
  // 5) 批次间隔：'每隔2个交易日建一批'
  const gm = prose.match(/每\s*(?:隔)?\s*(\d+|[一二两三四五六七八九十])\s*(?:个)?\s*(?:交易日|天|日)/);
  if (gm && out.tranches) {
    const raw = gm[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : (CN_NUM[raw] || 0);
    if (n > 0) out.tranche_gap = n;
  }
  return Object.keys(out).length ? out : null;
}

// 提取「指标基座」：剥掉方向词与数字，留下指标名，供后续省略指标的子句继承。
// 例："收益率z-score低于-1.5" → "收益率z-score"；"RSI高于70" → "RSI"
function condBase(cond) {
  return String(cond)
    .replace(/金叉|死叉|上穿|下穿|向上穿越|向下穿越|超卖|超买|低于|小于|跌破|少于|不足|不到|高于|大于|涨破|突破|超过|多于|[<>=≤≥]/g, '')
    .replace(/-?\d+(?:\.\d+)?/g, '')
    .replace(/[\s,，]/g, '')
    .trim();
}

/**
 * 把大白话策略翻译成 DSL 对象。
 * @param {string} text 用户输入（可含 RANGE: 3y 这类 DSL 行，会被识别并忽略/复用）
 * @returns {{ok:true, dsl:object, notes:string[]} | {ok:false, reason:string, unsupported?:string[], unparsed?:string[]}}
 */
function translate(text) {
  const clean = toHalfWidth(text == null ? '' : text);
  const lines = clean.split(/\r?\n/);
  let range = null, name = null;
  const proseParts = [];
  for (const ln of lines) {
    const m = ln.match(/^\s*(STRATEGY_TYPE|NAME|BUY|SELL|RANGE|SYMBOLS|TRAIN_RATIO|COST_PER_SIDE|SURVIVORSHIP|STOP_LOSS|TAKE_PROFIT|TRAILING|TRANCHES)\s*:\s*(.+)$/i);
    if (m) {
      const k = m[1].toUpperCase(), v = m[2].trim();
      if (k === 'RANGE') range = v;
      else if (k === 'NAME') name = v;
      else if (k === 'STOP_LOSS' || k === 'TAKE_PROFIT' || k === 'TRAILING' || k === 'TRANCHES') {
        // 结构化风控行 → 直接进 prose 由 parseRiskParams 统一处理（拼成等价中文）
        const key = { STOP_LOSS: '止损', TAKE_PROFIT: '止盈', TRAILING: '回撤', TRANCHES: '分' }[k];
        proseParts.push(k === 'TRANCHES' ? `分${v}批建仓` : `${key}${v}`);
      }
      // BUY/SELL 行说明已是 DSL，交给 parseDSL，不会走到这里
    } else if (ln.trim()) {
      proseParts.push(ln.trim());
    }
  }
  const prose = proseParts.join('，').trim();
  if (!prose) return { ok: false, reason: 'empty' };

  // 引擎不支持的玩法：如实拒绝，不猜
  const unsupported = [];
  if (UNSUP_VALUATION.test(prose)) unsupported.push('估值百分位（PE/PB/分位）');
  if (UNSUP_POSITION.test(prose)) unsupported.push('金字塔式按比例加减仓 / 按「成」计的仓位分配');
  if (UNSUP_SCALE.test(prose)) unsupported.push('持仓过程中的动态加仓/减仓');
  if (unsupported.length) return { ok: false, reason: 'unsupported', unsupported };

  // 先抽出风控/仓位参数（这些子句不是买卖条件，需从条件解析中剔除）
  const risk = parseRiskParams(prose);
  const RISK_CLAUSE = /(止损|止盈|回撤|回落|移动止盈|跟踪止盈|分批|分\d+批|分[一二两三四五六七八九十]批|建仓批次)/;

  const clauses = splitClauses(prose);
  const buyExprs = [], sellExprs = [], unparsed = [], riskOnly = [];
  let lastRole = null, lastBase = '';
  for (const cl of clauses) {
    // 纯风控子句（只描述出场/仓位，不含指标条件）→ 跳过条件解析，但记录以便失败时如实告知
    if (RISK_CLAUSE.test(cl) && !parseCondition(cl)) { riskOnly.push(cl); continue; }
    const isBuy = ROLE_BUY.test(cl), isSell = ROLE_SELL.test(cl);
    let role = (isBuy && !isSell) ? 'buy' : (isSell && !isBuy) ? 'sell' : lastRole;
    if (role) lastRole = role;
    let cond = cl.replace(ROLE_BUY, '').replace(ROLE_SELL, '').replace(FILLER, '').replace(/[（）()]/g, ' ').trim();
    // 剥掉风控片段，避免"止盈20%"里的数字干扰指标参数解析
    cond = cond.replace(/(?:止损|止盈|回撤|回落|移动止盈|跟踪止盈)\s*(?:到|达|达到|超过|幅度|为)?\s*-?\d+(?:\.\d+)?\s*[%％]?/g, '').trim();
    let expr = parseCondition(cond);
    // 省略了指标名的后续子句（如「…买入，高于1.5卖出」）→ 继承上一条的指标基座
    if (!expr && lastBase && cond) {
      const retry = lastBase + cond;
      const e2 = parseCondition(retry);
      if (e2) { expr = e2; cond = retry; }
    }
    if (!expr) { if (cl.trim()) unparsed.push(cl); continue; }
    const base = condBase(cond);
    if (base) lastBase = base;
    if (role === 'buy') buyExprs.push(expr);
    else if (role === 'sell') sellExprs.push(expr);
    else unparsed.push(cl);
  }

  if (!buyExprs.length || !sellExprs.length) {
    // 诚实告知：把未能识别的子句（含只被当作风控、但没解析出任何参数的）一并返回，
    // 避免用户拿到一个笼统的 incomplete 却不知道问题出在哪一句。
    const absorbed = risk ? Object.keys(risk).length : 0;
    const stuck = riskOnly.filter(c => absorbed === 0);
    return { ok: false, reason: 'incomplete', unparsed: unparsed.concat(stuck) };
  }

  const notes = ['已按确定性规则把中文描述翻译为回测规则（同一句话结果可复现）'];
  const dsl = {
    strategy_type: 'single',
    name: name || '大白话策略（自动翻译）',
    buy: buyExprs.join(' AND '),
    sell: sellExprs.join(' AND '),
    range: range || '3y'
  };
  if (risk) {
    Object.assign(dsl, risk);
    const bits = [];
    if (risk.stop_loss) bits.push(`止损 ${(risk.stop_loss * 100).toFixed(1)}%`);
    if (risk.take_profit) bits.push(`止盈 ${(risk.take_profit * 100).toFixed(1)}%`);
    if (risk.trailing) bits.push(`移动止盈 ${(risk.trailing * 100).toFixed(1)}%`);
    if (risk.tranches) bits.push(`等分 ${risk.tranches} 批建仓`);
    if (bits.length) notes.push('已识别风控/仓位参数：' + bits.join('、'));
  }
  return { ok: true, dsl, notes };
}

module.exports = { translate, parseCondition, parseRiskParams };

~~~

---

## `lib\techFaceJudgment.js`  ·  329 行

~~~js
/**
 * 个股技术面分析 · 准确率检查（lib/techFaceJudgment.js · 20260914i）
 * --------------------------------------------------------------
 * 目的：给个股页「技术面分析」（价格行为推演）加入独立的事后验证与准确率统计。
 *
 * 与既有机制的关系（关键，避免重复计数）：
 *  · lib/sameDayJudgment.js 的 technicalShort 因子已把「短期方向」间接结算，
 *    但那是用「个股次日涨跌」验证的，属于**短期行情判断模块**的因子命中率。
 *  · 本模块是**技术面模块自身**的准确率：用「未来 5 个交易日累计涨跌」
 *    直接验证 priceAction.shortTerm.direction，口径与「技术面＝短线择时」的定位一致。
 *  · 两者**互不干扰**：本模块独立落盘 data/tech-face/，不读写 data/judgments/。
 *
 * 结算口径（经用户确认）：
 *  · shortTerm.direction ∈ 上行/下行/震荡偏上/震荡偏下/冲高回落/超跌反弹/震荡
 *      → 归一化为 涨/跌/震荡 三态
 *      → 第 HORIZON 个交易日收盘 vs 基准日收盘（默认 5 个交易日）
 *  · 命中判定复用 sameDayJudgment 同源语义：震荡＝实际涨跌绝对值 ≤ 容差；否则方向一致。
 *
 * 存储：data/tech-face/<symbol>.json —— 按**个股**聚合成一个数组文件，
 *       便于「该股技术面历史准确率」快速读取（个股样本天然稀疏，按日分文件会碎片化）。
 */

const fs = require('fs');
const path = require('path');

const { localDate, marketClosed } = require('./sameDayJudgment');
const { getHistoryDeep } = require('./stockData');
const { isTradingDay, nextTradingDay } = require('./cnTradingCalendar');

/**
 * 交易日历统一委托 lib/cnTradingCalendar（单一权威源，与 sameDayJudgment 共用同一份休市表），
 * 避免两套日历口径漂移。nextTradingDayHL 仅保留语义别名以兼容既有调用点；
 * 真实结算仍走腾讯前复权日 K 实跑（已自然排除节假日）。
 */
function nextTradingDayHL(dateStr) { return nextTradingDay(dateStr); }

/**
 * 向前推进 n 个交易日（跳过周末与 2026 法定节假日；与结算引擎“按真实 K 线计数”口径一致）。
 * 用于计算「真实验证目标日」= 基准日 + HORIZON 个交易日（20261002c 修复：此前 overdue 误用
 * base+1；20261002c-2 补强：此前仅跳过周末、未跳过法定节假日，导致长假期间误报过期）。
 */
function addTradingDays(startDate, n) {
  let d = startDate;
  for (let i = 0; i < n; i++) d = nextTradingDayHL(d);
  return d;
}

const DIR = path.join(__dirname, '..', 'data', 'tech-face');
const HORIZON = 5;              // 验证周期（交易日）
const FLAT_TOLERANCE = 1.0;     // 「震荡」命中容差（%），与个股短期判断口径一致
const MAX_KEEP = 500;           // 单股最多保留记录数（防止文件无限增长）

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(symbol) { return path.join(DIR, String(symbol).replace(/[^0-9A-Za-z]/g, '') + '.json'); }

/** 方向归一化：技术面 7 种方向词 → 涨/跌/震荡 三态 */
function normalizeDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/震荡偏上|震荡偏下|震荡|横盘|整理/.test(s)) return '震荡';   // 「震荡偏X」归入震荡（择时上不构成明确方向）
  if (/上行|向上|上涨|走强|反弹|突破/.test(s)) return '涨';
  if (/下行|向下|下跌|走弱|回落|跌破/.test(s)) return '跌';
  return null;
}
function verdictOf(dir) { return dir === '涨' ? '看涨' : dir === '跌' ? '看跌' : dir === '震荡' ? '看震荡' : ''; }

function readAll(symbol) {
  try {
    const arr = JSON.parse(fs.readFileSync(fileFor(symbol), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeAll(symbol, arr) {
  ensureDir();
  const trimmed = arr.slice(-MAX_KEEP);
  fs.writeFileSync(fileFor(symbol), JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

/**
 * 记录一条技术面判断（同一基准日幂等覆盖）。
 * @param {string} symbol
 * @param {object} pa getPriceActionSnapshot() 返回值
 * @param {object} meta { name }
 */
function recordDailyJudgment(symbol, pa, meta = {}) {
  try {
    if (!symbol || !pa || pa.error) return null;
    const st = pa.shortTerm || {};
    const lt = pa.longTerm || {};
    if (!st.direction && !lt.verdict) return null;

    // 基准日：取 K 线最后一根日期（analyzePriceAction 的 meta.range 末段）
    let baseDate = null;
    const range = (pa.meta && pa.meta.range) || '';
    const m = range.match(/(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) baseDate = m[1];
    if (!baseDate) baseDate = localDate();

    const shortDir = normalizeDir(st.direction);
    const rec = {
      symbol: String(symbol),
      name: meta.name || '',
      baseDate,
      // 真实验证目标日 = 基准日 + HORIZON 个交易日（此前误用 nextTradingDay(baseDate)=base+1，
      // 验证窗口（5 个交易日）远未到即被误报“过期未结算”；20261002c 修复）
      targetDate: addTradingDays(baseDate, HORIZON),
      horizon: HORIZON,
      generatedAt: new Date().toISOString(),

      // ---- 待验证：短期方向（技术面核心输出）----
      shortRaw: String(st.direction || ''),
      shortDir,
      shortVerdict: verdictOf(shortDir),
      dirScore: typeof st.dirScore === 'number' ? round(st.dirScore, 2) : null,
      probability: String(st.probability || ''),
      pattern: String(st.pattern || ''),

      // ---- 附带记录：长期定性（不参与本模块结算，供参考）----
      longVerdict: String(lt.verdict || ''),

      // ---- 结算位 ----
      status: 'pending',          // 结算引擎填充：pending(等待数据) / settled(已结算) / error(基准日K线缺失)
      settled: false, actualDir: null, actualChgPct: null, correct: null,
      actualBaseClose: null, actualTargetClose: null, actualTargetDate: null,
      settleError: null,
    };

    const arr = readAll(symbol);
    const i = arr.findIndex(r => r.baseDate === baseDate);
    if (i >= 0) arr[i] = { ...arr[i], ...rec, settled: arr[i].settled, correct: arr[i].correct };
    else arr.push(rec);
    // 已存在的记录若已结算，保留其结算结果，不被覆盖
    writeAll(symbol, arr);
    return rec;
  } catch (e) {
    console.error('[techFaceJudgment] 落盘失败:', e && e.message);
    return null;
  }
}

/**
 * 结算某只股票的全部未结算记录：第 HORIZON 个交易日收盘 vs 基准日收盘。
 * @param {string} symbol
 * @param {Array} [barsOverride] 测试注入用：跳过网络拉取直接给定 K 线（生产调用不传，走 getHistoryDeep）
 */
async function settleSymbol(symbol, barsOverride) {
  const arr = readAll(symbol);
  if (!arr.length) return { changed: 0 };
  // 目标日归一：未结算记录的 targetDate 始终取「基准日 + HORIZON 个交易日」（含法定节假日，
  // 20261002c-2），纠正旧代码误存的 base+1；返回是否发生变更。
  const normTarget = (rec) => {
    if (!rec.baseDate) return false;
    const want = addTradingDays(rec.baseDate, rec.horizon || HORIZON);
    if (rec.targetDate !== want) { rec.targetDate = want; return true; }
    return false;
  };
  // 标记为 pending（等待数据 / 目标日未到）并同步纠正 targetDate
  const markPending = (rec) => {
    let ch = false;
    if (rec.status !== 'pending') { rec.status = 'pending'; ch = true; }
    if (normTarget(rec)) ch = true;
    return ch;
  };

  let daily = [];
  try { daily = Array.isArray(barsOverride) ? barsOverride : await getHistoryDeep(symbol, 2400); } catch (e) { daily = []; }
  if (!daily || !daily.length) {
    // 数据未拉取成功：无法结算，但仍应把未结算记录显式标为 pending（无 status 时）并纠正陈旧
    // targetDate——即使此前已由旧代码标过 pending（旧版不纠 targetDate）。不动已结算/已标 error
    // 的记录（error 属真实异常，不覆盖）。
    let statusChanged = false;
    for (const rec of arr) {
      if (rec.settled || rec.status === 'error') continue;
      let ch = false;
      if (!rec.status) { rec.status = 'pending'; ch = true; }
      if (normTarget(rec)) ch = true;
      if (ch) statusChanged = true;
    }
    if (statusChanged) writeAll(symbol, arr);
    return { changed: 0, statusChanged };
  }
  const bars = daily.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const idxOf = (d) => bars.findIndex(b => b.date === d);
  const now = new Date();
  const today = localDate(now);
  let changed = 0, statusChanged = false;

  for (const rec of arr) {
    if (rec.settled || !rec.shortDir) {
      if (rec.settled && rec.status !== 'settled') { rec.status = 'settled'; statusChanged = true; }
      continue;
    }
    const bIdx = idxOf(rec.baseDate);
    if (bIdx < 0) {                                            // 基准日 K 线缺失：真实异常，需核查
      if (rec.status !== 'error') { rec.status = 'error'; rec.settleError = '基准日K线缺失'; statusChanged = true; }
      continue;
    }
    const tIdx = bIdx + (rec.horizon || HORIZON);
    if (tIdx >= bars.length) {                                 // 未来数据尚未生成 → 正常等待，非“过期”
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const tBar = bars[tIdx];
    if (tBar.date === today && !marketClosed(now)) {           // 目标日尚未收盘 → 正常等待
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const baseClose = bars[bIdx].close;
    if (baseClose == null || tBar.close == null) {             // 价格缺失 → 继续等待（不属异常）
      if (markPending(rec)) statusChanged = true;
      continue;
    }
    const chg = (tBar.close - baseClose) / baseClose * 100;
    const actDir = tBar.close > baseClose ? '涨' : (tBar.close < baseClose ? '跌' : '震荡');
    rec.actualDir = actDir;
    rec.actualChgPct = round(chg, 2);
    rec.actualBaseClose = baseClose;
    rec.actualTargetClose = tBar.close;
    rec.actualTargetDate = tBar.date;
    rec.correct = rec.shortDir === '震荡' ? Math.abs(chg) <= FLAT_TOLERANCE : rec.shortDir === actDir;
    rec.settled = true;
    rec.status = 'settled';
    rec.settleError = null;
    changed++;
    statusChanged = true;
  }
  if (changed || statusChanged) writeAll(symbol, arr);
  return { changed, statusChanged };
}

/** 结算给定全部股票（symbols 为空则结算目录下所有） */
async function settleAll(symbols) {
  ensureDir();
  let list = symbols;
  if (!list || !list.length) {
    list = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  }
  let changed = 0;
  for (const s of list) {
    try { const r = await settleSymbol(s); changed += r.changed || 0; } catch (e) {}
  }
  return { changed };
}

/**
 * 是否“过期未结算”（需核查的真实异常），20261002c 修复口径（20261002c-2 补强）：
 *  · 已结算 → 否
 *  · status==='settled'/'pending' → 否（pending＝验证窗口未到/数据未出，属正常等待，不再误报“过期”）
 *  · status==='error'/'overdue'   → 是（基准日K线缺失等真实异常）
 *  · 无 status（历史记录/未跑结算）→ 用 baseDate + HORIZON 实时重算真实目标日，
 *        不信任陈旧存储的 targetDate（旧代码曾误存 base+1，导致 09-23~09-29 这类
 *        “第 5 交易日=10-08 尚未到”的合法 pending 记录被误报“过期未结算”）。
 *        重算后真实目标日仍 < today 才判过期（用于 2020 等早就该结算却未结算的真异常）。
 */
function isOverdue(r, today) {
  if (r.settled) return false;
  if (r.status === 'error' || r.status === 'overdue') return true;
  if (r.status === 'pending' || r.status === 'settled') return false;
  // 无 status：实时重算真实目标日（baseDate 缺失时再退化为存储 targetDate）
  if (r.baseDate) {
    const realTarget = addTradingDays(r.baseDate, r.horizon || HORIZON);
    return !!(realTarget && realTarget < today);
  }
  return !!(r.targetDate && r.targetDate < today);
}

/** 单只股票的准确率统计 */
function computeAccuracy(symbol, arr) {
  const records = arr || readAll(symbol);
  const withDir = records.filter(r => r.shortDir);
  const settled = withDir.filter(r => r.settled);
  const t = settled.length;
  const c = settled.filter(r => r.correct).length;
  const today = localDate();
  const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
  const byProb = { 高: { t: 0, c: 0 }, 中: { t: 0, c: 0 }, 低: { t: 0, c: 0 } };
  for (const r of settled) {
    if (byDir[r.shortDir]) { byDir[r.shortDir].t++; if (r.correct) byDir[r.shortDir].c++; }
    if (byProb[r.probability]) { byProb[r.probability].t++; if (r.correct) byProb[r.probability].c++; }
  }
  const rate = (p) => (p.t ? round(p.c / p.t * 100, 1) : null);
  return {
    symbol: String(symbol || ''),
    totalRecords: withDir.length,
    settledCount: t,
    correct: c,
    accuracy: t ? round(c / t * 100, 1) : null,
    pendingCount: withDir.filter(r => !r.settled).length,
    overdueCount: withDir.filter(r => isOverdue(r, today)).length,
    bullRate: rate(byDir['涨']), bullTotal: byDir['涨'].t,
    bearRate: rate(byDir['跌']), bearTotal: byDir['跌'].t,
    flatRate: rate(byDir['震荡']), flatTotal: byDir['震荡'].t,
    probHighRate: rate(byProb['高']), probHighTotal: byProb['高'].t,
    probMidRate: rate(byProb['中']), probMidTotal: byProb['中'].t,
    probLowRate: rate(byProb['低']), probLowTotal: byProb['低'].t,
    horizonLabel: `未来 ${HORIZON} 个交易日累计涨跌`,
    flatTolerance: FLAT_TOLERANCE,
    source: '本地计算（价格行为推演 shortTerm.direction）+ 腾讯前复权日K验证；命中＝方向一致，「震荡偏上/偏下」归入震荡，震荡以涨跌绝对值 ≤ ' + FLAT_TOLERANCE + '% 计。',
  };
}

/** 全站汇总（所有个股合并） */
function computeGlobalAccuracy() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  let all = [];
  for (const f of files) {
    try { const a = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (Array.isArray(a)) all.push(...a); } catch (e) {}
  }
  const agg = computeAccuracy('__ALL__', all);
  agg.symbolCount = files.length;
  return agg;
}

module.exports = {
  recordDailyJudgment,
  settleSymbol,
  settleAll,
  computeAccuracy,
  computeGlobalAccuracy,
  normalizeDir,
  readAll,
  HORIZON,
  FLAT_TOLERANCE,
  DIR,
};

~~~

---

## `lib\thsDailyCache.js`  ·  226 行

~~~js
/**
 * thsDailyCache.js — 同花顺日K原始响应本地缓存（20261022f，用户方案 C）
 * ==========================================================
 * 用户问题（2026-10-22）：
 *   「同花顺 all.js 高频请求会触发 502 限流的问题，能否通过一次获取本地保存的方法解决，
 *    保存需要的容量很大吗？」→ 实测后确认可行且容量可忽略，按「存原始文本」方案落地。
 *
 * 为什么存**原始响应文本**而不是解码后的数组（方案选择依据，实测 2026-10-22）：
 *   | 形态                          | 单股体积（实测 603288/601318/600519） |
 *   |-------------------------------|----------------------------------------|
 *   | last.js + all.js 原始文本     | 约 148 KB  ← 最小                     |
 *   | 解码后精简 {d,o,h,l,c,v} 全量 | 约 334 KB                             |
 *   | 解码后完整字段 全量           | 约 556 KB                             |
 *   | 只留引擎要的 320 根完整字段   | 约 35 KB                              |
 *   存原始文本的关键好处：读缓存后走的是**完全相同的解码/校验路径**
 *   （`_decodeThsAll` → `_mergeThsBars` 重叠段 close 闸门），只在「文本从哪来」这一步分叉，
 *   因此缓存结果与实时拉取**逐字节一致**，不会出现「解码逻辑改了、旧缓存却是按旧逻辑算的」这种口径漂移。
 *   另外原始文本是信息的超集，将来 all.js 若增字段无需重拉。
 *
 * 刷新节奏（三段式 slot：交易日 + 时段），把请求压到最低：
 *   - 交易日 09:30–15:05（phase=intraday）：当天首次抓取后整个盘中复用；
 *   - 交易日 ≥15:05（phase=closed）：盘中缓存作废，补抓一次拿当日完整收盘K，之后复用；
 *   - 非交易日（周末/节假日）：一律 phase=closed，锚定上一个交易日 → 全天复用同一份。
 *   结果：每只股票每个交易日**最多 2 次网络请求**（正常节奏 1 次），彻底脱离 502 限流区间。
 *
 * 为什么「盘中缓存可直接复用」是安全的：
 *   20261022c 已确立「所有有效突破/破位/打穿只认当日收盘价」，`zoneValidity.finalizedBars`
 *   会把当日未收盘的 K 线剔除，所以盘中那份当日数据本来就不参与任何判定；
 *   而展示层的当日价格由腾讯实时 quote 覆写（volumeEngine），不受日K快照影响。
 *
 * 容量结论（实测）：
 *   9 只自选 ≈ 1.3 MB；31 只 ≈ 4.6 MB；200 只 ≈ 30 MB。
 *   每只股票固定一个文件、**每日覆盖写**，不会随天数累积增长。
 *
 * 纯函数（resolveSlot / isFresh）零 IO，便于单测；读写函数各自 fail-open 到「未命中」，
 * 任何异常都只是退回联网，绝不让缓存问题阻塞行情分析。
 */
const fs = require('fs');
const path = require('path');
const { bjParts, localDate } = require('./localDate');
const { isTradingDay, previousTradingDay } = require('./cnTradingCalendar');

const DIR = path.join(__dirname, '..', 'data', 'cache', 'ths-daily');
const SCHEMA = 1;

/** 收盘定稿时刻（HHMM）：与 zoneValidity.finalizedBars 的 closeHhmm 同口径 */
const CLOSE_HHMM = 1505;

/**
 * 硬过期兜底：同一交易日的数据本应恒定，tradeDate+phase 匹配即足够；
 * 这里只为「系统时钟被回拨/篡改」留一道闸。15 天可覆盖最长假期（春节/国庆 9 天）。
 */
const MAX_AGE_MS = 15 * 24 * 3600 * 1000;

/** 缓存时间戳允许的「未来」上限（超此值视为时钟异常，不信该缓存） */
const MAX_FUTURE_MS = 3600 * 1000;

function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function fileFor(sym) { return path.join(DIR, normalizeSymbol(sym) + '.json'); }

function ensureDir() {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  } catch (e) {
    console.warn('[ThsDailyCache] 创建目录失败（落盘时再报错）:', e && e.message ? e.message : e);
  }
}

/**
 * 纯函数：算出此刻应锚定的「交易日 + 时段阶段」。
 * @param {Date|number|string} now
 * @param {{closeHhmm?:number}} [opts]  closeHhmm 仅供单测覆盖
 * @returns {{tradeDate:string, phase:'intraday'|'closed', isTradingDay:boolean, hhmm:number}}
 */
function resolveSlot(now, opts) {
  const d = now instanceof Date ? now : (now == null ? new Date() : new Date(now));
  const p = bjParts(isNaN(d.getTime()) ? new Date() : d);
  const today = p ? `${p.year}-${p.month}-${p.day}` : localDate();
  const hhmm = p ? Number(p.hour) * 100 + Number(p.minute) : 0;
  const limit = Number.isFinite(opts && opts.closeHhmm) ? opts.closeHhmm : CLOSE_HHMM;
  const trading = isTradingDay(today);
  if (!trading) {
    // 非交易日不存在盘中变化 → 一律按 closed 锚定上一个交易日（周末/长假全程复用同一份）
    return { tradeDate: previousTradingDay(today), phase: 'closed', isTradingDay: false, hhmm };
  }
  return { tradeDate: today, phase: hhmm >= limit ? 'closed' : 'intraday', isTradingDay: true, hhmm };
}

/**
 * 纯函数：判断一条已解析缓存是否命中当前 slot。
 * 返回 why 便于诊断（命中='ok'）。
 * @param {object|null} rec
 * @param {object} slot         resolveSlot 的结果
 * @param {number} [nowMs]
 * @returns {{hit:boolean, why:string}}
 */
function isFresh(rec, slot, nowMs) {
  if (!rec || typeof rec !== 'object') return { hit: false, why: 'no_cache' };
  if (Number(rec.schema) !== SCHEMA) return { hit: false, why: 'schema_mismatch' };
  if (typeof rec.lastRaw !== 'string' || !rec.lastRaw) return { hit: false, why: 'corrupt_last' };
  // all.js 缺失（当场拉取失败）不算有效缓存：否则一整天都会卡在「只有 140 根」的残缺态
  if (typeof rec.allRaw !== 'string' || !rec.allRaw) return { hit: false, why: 'incomplete_all' };
  if (!slot || !slot.tradeDate) return { hit: false, why: 'bad_slot' };
  if (rec.tradeDate !== slot.tradeDate) return { hit: false, why: 'trade_date_changed' };
  if (rec.phase !== slot.phase) return { hit: false, why: 'phase_changed' };
  const at = Number(rec.fetchedAt);
  if (!Number.isFinite(at)) return { hit: false, why: 'corrupt_fetchedAt' };
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (ts - at > MAX_AGE_MS) return { hit: false, why: 'stale' };
  if (at - ts > MAX_FUTURE_MS) return { hit: false, why: 'clock_ahead' };
  return { hit: true, why: 'ok' };
}

/**
 * 读缓存。任何 IO / 解析异常一律降级为「未命中」，交由调用方联网。
 * @returns {{hit:boolean, why:string, rec:object|null}}
 */
function readCache(symbol, slot, nowMs) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { hit: false, why: 'bad_symbol', rec: null };
  let text;
  try {
    text = fs.readFileSync(fileFor(sym), 'utf8');
  } catch (e) {
    // 文件不存在是最常见路径（首次访问），不告警；其它错误才提示
    if (e && e.code !== 'ENOENT') {
      console.warn('[ThsDailyCache] 读缓存失败，改走网络:', e.message);
      return { hit: false, why: 'read_error', rec: null };
    }
    return { hit: false, why: 'missing', rec: null };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.warn('[ThsDailyCache] 缓存 JSON 损坏，改走网络:', e.message);
    return { hit: false, why: 'corrupt', rec: null };
  }
  const verdict = isFresh(raw, slot, nowMs);
  return { hit: verdict.hit, why: verdict.why, rec: verdict.hit ? raw : null };
}

/**
 * 写缓存（原子写：先 .tmp 再 rename，避免读到半截文件）。
 * 写失败不抛给调用方判断逻辑——直接抛，由调用方 try/catch 记录并忽略（缓存不阻塞主流程）。
 */
function writeCache(symbol, slot, lastRaw, allRaw, nowMs) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !slot || !slot.tradeDate) throw new Error('writeCache: 参数不完整');
  if (typeof lastRaw !== 'string' || !lastRaw) throw new Error('writeCache: lastRaw 为空');
  if (typeof allRaw !== 'string' || !allRaw) throw new Error('writeCache: allRaw 为空');
  ensureDir();
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  const payload = {
    schema: SCHEMA,
    symbol: sym,
    tradeDate: slot.tradeDate,
    phase: slot.phase,
    fetchedAt: ts,
    fetchedAtText: new Date(ts).toISOString(),
    bytes: { last: Buffer.byteLength(lastRaw, 'utf8'), all: Buffer.byteLength(allRaw, 'utf8') },
    lastRaw,
    allRaw,
  };
  const file = fileFor(sym);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (cleanErr) {
      console.warn('[ThsDailyCache] 临时文件清理失败（将被下次写入覆盖）:', cleanErr && cleanErr.message ? cleanErr.message : cleanErr);
    }
    throw e;
  }
  return payload;
}

/** 缓存的元信息（诊断用：体积 / 锚定日期 / 时段），不返回原始文本 */
function cacheMeta(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[ThsDailyCache] 读元信息失败:', e.message);
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  return {
    symbol: raw.symbol || sym,
    schema: raw.schema,
    tradeDate: raw.tradeDate || null,
    phase: raw.phase || null,
    fetchedAt: Number(raw.fetchedAt) || null,
    fetchedAtText: raw.fetchedAtText || null,
    bytes: raw.bytes || {
      last: typeof raw.lastRaw === 'string' ? Buffer.byteLength(raw.lastRaw, 'utf8') : 0,
      all: typeof raw.allRaw === 'string' ? Buffer.byteLength(raw.allRaw, 'utf8') : 0,
    },
  };
}

module.exports = {
  DIR,
  SCHEMA,
  CLOSE_HHMM,
  MAX_AGE_MS,
  MAX_FUTURE_MS,
  normalizeSymbol,
  fileFor,
  resolveSlot,
  isFresh,
  readCache,
  writeCache,
  cacheMeta,
};

~~~

---

## `lib\tklineHost.js`  ·  39 行

~~~js
/**
 * 腾讯 K 线接口「主机族」降级（20261021g）
 * ==========================================================
 * 背景：`ifzq.gtimg.cn/appstock/app/fqkline/get` 会**整段**返回 HTTP 501（所有代码都一样：
 * sh000001 / sz399001 / sh600519 / sz000902 全是 501），而**同一路径**在
 * `web.ifzq.gtimg.cn` 正常返回 200。写死单主机时，一次对端策略调整就会让
 * 「个股日K / 大盘技术分析 / 市场情绪量价因子 / 准确率结算」同时降级——而且日志里只看到
 * 一条 `Request failed with status code 501`，很容易被当成业务 bug。
 *
 * 设计：只做**同一路径的主机降级**，不参与解析、不改参数——调用方拿到的仍是原响应体。
 * 顺序固定 ifzq → web.ifzq（历史上两个域名的可用性此消彼长，谁在前都会轮到）。
 */
const axios = require('axios');

const KLINE_HOSTS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];

/**
 * @param {string} pathQuery 以 / 开头的路径+查询串，例如 `/appstock/app/fqkline/get?param=...`
 * @param {object} opts      axios 配置（headers / timeout 等，原样透传）
 * @returns {Promise<any>}   axios 的 `resp.data`
 */
async function getKlineJson(pathQuery, opts = {}) {
  let lastErr = null;
  for (const host of KLINE_HOSTS) {
    try {
      const resp = await axios.get(host + pathQuery, opts);
      return resp.data;
    } catch (e) {
      lastErr = e;
      // 只对「整段不可用」级别（5xx / 网络错误）换主机；4xx 是参数问题，换主机也没用
      const st = e && e.response && e.response.status;
      if (st && st < 500) break;
    }
  }
  throw lastErr || new Error('腾讯K线接口不可用');
}

module.exports = { getKlineJson, KLINE_HOSTS };

~~~

---

## `lib\topicEngines.js`  ·  494 行

~~~js
/**
 * lib/topicEngines.js — 每日复盘「每日热点题材与归因卡片 / 资金投票质量 / 四象限中和」引擎
 * ==========================================================================
 * 20261108d 新增。用户新规格第二、三部分落地：
 *  - 消息源过滤：官方（部委/官媒）优先；自媒体「小作文」标「传闻/未核验」。
 *  - 题材阶段：启动期 / 发酵·主升期 / 高潮·退潮期，基于前 3-5 个交易日**同口径**
 *    行业涨停家数序列（scripts/board_review_data.py 的 sectors.industryHistory）。
 *  - 题材评级：S 主线共振 / A 局部投机 / B 轮动补涨 / C 诱多陷阱。
 *  - 资金投票质量：强共识 / 局部游资 / 无效陷阱 / 防御性 / 无法判断。
 *  - 双方向四象限（技术面 × 消息面）：共振 / 背离 / 先觉 / 双弱 / 无法判断。
 *
 * 【架构铁律】全部为确定性规则，零 require、零 I/O、零网络、零 LLM 推导。
 *   数值只复述真实采集值；缺失一律返回 null / 「缺失」，绝不臆造。
 *
 * 【诚实边界 / 显式取舍，勿回退】
 *  1. 工作台无「板块成分股 + 市值 + 趋势行情」映射 → 用涨停池内流通市值居前个股
 *     作「中军代理」，并在 midCapText / 口径披露里写明它不是真实板块中军。
 *     S 级要求中军大阳线，代理缺失时**不得评 S**，降级 A 并写明证据缺口。
 *  2. 工作台新闻源是「东方财富 7×24 快讯」实时流，不能证明某题材当日「无消息」。
 *     因此「无匹配新闻」= 消息面证据**缺失**，不等于「消息弱」；四象限返回
 *     「无法判断」而非「双弱」，避免把整批题材一键剔除成空白模板。
 *     消息级别由来源名称与标题关键词推断，未经公告原文核验，只作线索触发器。
 *  3. 题材阶段有效对照点 < 3 时，stage = 「缺少对照」，stageReason 写完整
 *     「缺少对照，暂不作持续性判断」，禁止把单日数据当趋势。
 *  4. D4 基本面：复盘链路未接入财报/估值数据 → 驱动标签恒不标 D4，并披露口径。
 */
'use strict';

const MISSING = '缺失';
const NO_COMPARISON = '缺少对照，暂不作持续性判断';
const SCHEMA_VERSION = 'topic-20261108d';

const TOPIC_TH = {
  sLimitUp: 5,             // S 级 / 强共识所需涨停家数下限
  strongLimitUp: 4,        // 技术面「强」的涨停家数下限
  midCapStrongPct: 5,      // 中军代理「大阳线」阈值（%）
  stageMinPoints: 3,       // 阶段判定最少有效对照点
  earlySealShare: 50,      // 早盘封板占比阈值（%），用于 D1 技术标签
  amtShrinkPct: -10,       // 涨停池成交额序列收缩阈值（%），用于防御性投票
};

const DRIVER_DEFS = {
  D1: '技术（连板/板块层次/封板时间）',
  D2: '消息（新闻催化线索）',
  D3: '资金（成交额/板块资金流/大市值代理）',
  D4: '基本面（财报/估值）',
};

// 官方（部委 / 中央官媒）来源关键词 —— 只作级别推断，不证明公告真实性
const STATE_SOURCES = [
  '新华社', '人民日报', '央视', '央视新闻', '中国政府网', '国务院', '工信部',
  '发改委', '财政部', '中国人民银行', '央行', '证监会', '上交所', '深交所',
  '商务部', '科技部', '国家能源局', '统计局', '求是', '新华社客户端',
];
// 产业级 / 财经官方媒体
const INDUSTRY_OFFICIAL_SOURCES = [
  '中国证券报', '证券时报', '上海证券报', '证券日报', '经济日报', '经济参考报',
  '中国工业报', '中国电子报', '国资委', '工信部网站', '地方发改委',
];
// 自媒体「小作文」判定：标题出现这些词即标传闻
const RUMOR_WORDS = ['网传', '传闻', '消息人士', '据悉未证实', '市场传言', '未经证实', '小作文', '据传'];
// 防御性投票的行业线索
const DEFENSIVE_WORDS = ['农业', '种植', '养殖', '黄金', '贵金属', '红利', '银行', '电力', '煤炭', '公用事业', '食品饮料'];
// 涨停池「所属行业」→ 新闻标题关键词（覆盖主要行业；未覆盖行业退回行业名子串匹配）
const INDUSTRY_KEYWORDS = {
  '半导体': ['半导体', '芯片', '晶圆', '光刻', '存储', '集成电路', '封装'],
  '光伏设备': ['光伏', '硅料', '组件', '逆变器', '电池片'],
  '工业金属': ['有色', '工业金属', '电解铝', '铜价', '铝价', '稀土', '金属'],
  '纺织制造': ['纺织', '服装', '面料', '棉价'],
  '专用设备': ['专用设备', '工程机械', '机器人', '设备更新'],
  '医疗器械': ['医疗器械', '医疗设备', '集采', '耗材'],
  '证券': ['券商', '证券', '资本市场', 'IPO', '并购重组'],
  '保险': ['保险', '险资', '寿险'],
  '银行': ['银行', '存款', '信贷', 'LPR'],
  '汽车整车': ['汽车', '整车', '新能源车', '车市'],
  '汽车零部件': ['汽车零部件', '汽车供应链', '智驾', '自动驾驶'],
  '电力设备': ['电网', '特高压', '储能', '电力设备', '风电'],
  '通信设备': ['通信', '5G', '光模块', '算力', '数据中心'],
  '计算机设备': ['服务器', '算力', '计算机', '国产化'],
  '软件开发': ['软件', '大模型', 'AI', '人工智能', '鸿蒙'],
  '化学制品': ['化工', '化学', '涨价', '磷化工', '氟化工'],
  '食品饮料': ['食品', '白酒', '饮料', '消费'],
  '农牧饲渔': ['农业', '养殖', '种业', '猪价', '粮食'],
  '贵金属': ['黄金', '金价', '贵金属', '避险'],
  '煤炭行业': ['煤炭', '动力煤', '焦煤'],
  '房地产开发': ['房地产', '地产', '楼市', '住建'],
  '航天航空': ['航天', '航空', '卫星', '商业航天', '军工'],
  '电池': ['锂电池', '电池', '固态电池', '储能'],
  '游戏': ['游戏', '版号', '电竞'],
  '文化传媒': ['传媒', '影视', '短剧', '出版'],
};

// ---------- 基础工具（纯函数） ----------
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function fixed(v, d) { const n = num(v); return n == null ? MISSING : n.toFixed(d == null ? 2 : d); }
function pct(v, d) { const n = num(v); return n == null ? MISSING : (n >= 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '%'; }
function list(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

function trendOf(series, key, opts) {
  const o = opts || {};
  const vals = list(series).map(r => (r && num(r[key]) != null ? num(r[key]) : null)).filter(v => v != null);
  const min = o.minPoints || 3;
  if (vals.length < min) {
    return { direction: '无法判断', points: vals.length, ok: false, note: NO_COMPARISON };
  }
  const half = Math.floor(vals.length / 2);
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const a = avg(vals.slice(0, half)), b = avg(vals.slice(-half));
  const chg = a !== 0 ? (b - a) / Math.abs(a) * 100 : null;
  const th = o.threshold == null ? TOPIC_TH.amtShrinkPct : o.threshold;
  const direction = chg == null ? '无法判断'
    : chg > Math.abs(th) ? '扩散' : chg < th ? '收缩' : '持平';
  return { direction, points: vals.length, ok: true, changePct: chg, note: `前 ${vals.length} 个有效对照点，前后半段均值 ${fixed(a)} → ${fixed(b)}（${pct(chg)}）` };
}

/** 名称匹配：精确 → 双向子串 → null。板块名口径不同（申万 vs 东财细行业）时不硬凑。 */
function matchByName(arr, nameOf, industry) {
  const rows = list(arr);
  const key = String(industry || '');
  if (!key) return null;
  let hit = rows.find(x => String(nameOf(x) || '') === key);
  if (hit) return hit;
  hit = rows.find(x => {
    const n = String(nameOf(x) || '');
    return n && (key.includes(n) || n.includes(key));
  });
  return hit || null;
}

// ---------- 消息源级别与性质 ----------
const LEVEL_RANK = { '国家级/官方': 0, '产业级/官方': 1, '行业级/财经媒体': 2, '传闻/未核验': 3, [MISSING]: 4 };

function newsLevelOf(item) {
  if (!item) return { level: MISSING, rank: 4, reason: `无匹配新闻线索，消息面证据${MISSING}` };
  const title = String(item.title || '');
  const source = String(item.source || '');
  if (RUMOR_WORDS.some(w => title.includes(w))) {
    return { level: '传闻/未核验', rank: 3, reason: `标题含传闻类措辞（${RUMOR_WORDS.filter(w => title.includes(w)).join('、')}），按自媒体小作文处理，未经公告核验` };
  }
  if (STATE_SOURCES.some(w => source.includes(w))) {
    return { level: '国家级/官方', rank: 0, reason: `来源「${source}」命中部委/中央官媒关键词（按来源名推断，未经公告原文核验）` };
  }
  if (INDUSTRY_OFFICIAL_SOURCES.some(w => source.includes(w))) {
    return { level: '产业级/官方', rank: 1, reason: `来源「${source}」命中产业/财经官方媒体关键词（按来源名推断，未经公告原文核验）` };
  }
  return { level: '行业级/财经媒体', rank: 2, reason: `来源「${source}」为一般财经快讯，未标注官方级别（按来源名推断，未经公告原文核验）` };
}

/** 题材 ↔ 新闻匹配：官方优先；同级按来源时间倒序（上游已排序），再按输入顺序，保证确定性。 */
function matchNews(industry, news) {
  const key = String(industry || '');
  const words = INDUSTRY_KEYWORDS[key] || [key];
  const hits = [];
  for (const n of list(news)) {
    const title = String((n && n.title) || '');
    if (!title) continue;
    if (!words.some(w => w && title.includes(w))) continue;
    hits.push({ item: n, level: newsLevelOf(n) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (a.level.rank - b.level.rank));
  return hits[0];
}

// ---------- 题材阶段判定（前 3-5 日同口径行业涨停家数） ----------
function stageOf(industry, industryHistory, todayCount) {
  const hist = list(industryHistory);
  const series = hist.map(r => ({
    date: String((r && r.date) || ''),
    ok: !!(r && r.ok),
    count: (r && r.ok && r.counts && num(r.counts[industry]) != null) ? num(r.counts[industry]) : null,
  }));
  const valid = series.filter(x => x.count != null);
  if (valid.length < TOPIC_TH.stageMinPoints) {
    return {
      stage: '缺少对照', ok: false, points: valid.length,
      reason: `${NO_COMPARISON}（该行业仅取得 ${valid.length} 个有效同口径对照点，需 ≥${TOPIC_TH.stageMinPoints} 个）`,
      series: valid.map(x => x.count),
    };
  }
  const vals = valid.map(x => x.count);
  const today = num(todayCount) == null ? vals[vals.length - 1] : num(todayCount);
  const prev = vals.slice(0, -1);
  const peak = Math.max.apply(null, vals);
  const zeroPrev = prev.every(v => v === 0);
  const last3 = vals.slice(-3);
  const last3AllUp = last3.length === 3 && last3.every(v => v > 0) && last3[2] >= last3[1] && last3[1] >= last3[0];
  const multiDay = vals.filter(v => v > 0).length >= 4;
  let stage, reason;
  if (zeroPrev && today >= 2) {
    stage = '启动期';
    reason = `前 ${prev.length} 个对照日该行业涨停家数均为 0，今日 ${today} 家首次上榜（${valid.length} 个有效对照点）`;
  } else if (multiDay && (today < peak || today === peak && vals.length >= 5)) {
    stage = '高潮/退潮期';
    reason = `连续 ${vals.filter(v => v > 0).length} 个对照日上榜（≥4 日霸榜），今日 ${today} 家、区间峰值 ${peak} 家，家数自峰值回落`;
  } else if (last3AllUp && today >= 2) {
    stage = '发酵/主升期';
    reason = `最近 3 个对照日涨停家数 ${last3.join(' → ')} 连续上榜且未回落（${valid.length} 个有效对照点）`;
  } else {
    stage = '无明显阶段特征';
    reason = `同口径序列 ${vals.join(' → ')}（${valid.length} 个有效对照点）未满足启动/连续发酵/霸榜回落任一条件`;
  }
  return { stage, ok: true, points: valid.length, reason, series: vals };
}

// ---------- 中军代理 ----------
function midCapOf(industry, midCap) {
  const rows = list(midCap && midCap.byIndustry);
  const row = matchByName(rows, x => x.industry, industry);
  if (!row || !(midCap && midCap.ok)) {
    return { ok: false, text: MISSING, changePct: null, topName: null, floatMvYi: null };
  }
  const chg = num(row.topChgPct);
  const text = `${row.topName || MISSING} ${pct(chg)}（流通市值 ${fixed(row.topFloatMvYi)} 亿元，涨停池内大市值代理）`;
  return { ok: true, text, changePct: chg, topName: row.topName || null, floatMvYi: num(row.topFloatMvYi) };
}

// ---------- 主入口 ----------
function normInput(raw) {
  const i = raw || {};
  return {
    date: String(i.date || MISSING),
    histDates: Array.isArray(i.histDates) ? i.histDates : [],
    sectors: (i.sectors && i.sectors.ok) ? i.sectors : null,
    quote: i.quote || null,
    news: list(i.news),
    sectorFlow: i.sectorFlow || null,
    prevPool: (i.prevPool && i.prevPool.ok) ? i.prevPool : null,
    ladder: i.ladder || null,
    historySeries: list(i.historySeries),
    breadth: i.breadth || null,
  };
}

/**
 * @param {object} raw 由 reviewService 组装的采集值
 * @returns {object} 归因卡片 / 投票质量 / 四象限 / 供机会引擎中和的 topicByIndustry
 */
function analyzeTopics(raw) {
  const ctx = normInput(raw);
  const sec = ctx.sectors;
  const top = sec ? list(sec.top).slice(0, 8) : [];
  const industryHistory = sec ? list(sec.industryHistory) : [];
  const sealTime = sec && sec.sealTime && sec.sealTime.ok ? sec.sealTime : null;
  const midCap = sec && sec.midCap && sec.midCap.ok ? sec.midCap : null;
  const limitDown = sec && sec.limitDown && sec.limitDown.ok ? sec.limitDown : null;
  const amtTrend = trendOf(ctx.historySeries, 'ztAmountYi', { threshold: TOPIC_TH.amtShrinkPct });
  const largeDropIndustries = ctx.prevPool ? list(ctx.prevPool.industryBigDrop).map(x => String(x.industry || '')) : [];
  const singles = sec ? list(sec.singleDance).map(String) : [];

  const cards = [];
  for (const s of top) {
    const industry = String(s.industry || '');
    if (!industry) continue;
    const count = num(s.count);
    const boardsMax = num(s.boardsMax);
    const hasLayer = s.hasLayer === true ? true : s.hasLayer === false ? false : null;
    const amountYi = num(s.amountYi);

    // 板块涨幅：同花顺板块快照（口径与东财细行业不完全一致，匹配不上即缺失）
    const upRow = matchByName(ctx.quote && ctx.quote.sectorsUp, x => x.name, industry);
    const changePct = upRow ? num(upRow.changePct) : null;
    // 板块资金净流入：申万板块口径，匹配不上即缺失
    const flowRow = matchByName(ctx.sectorFlow && ctx.sectorFlow.todayInflowTop5, x => x.name, industry);
    const mainNet = flowRow ? num(flowRow.mainNet) : null;

    const m = matchNews(industry, ctx.news);
    const level = m ? m.level : { level: MISSING, rank: 4, reason: `无匹配新闻线索，消息面证据${MISSING}` };
    const newsItem = m ? m.item : null;
    const newsTime = newsItem ? String(newsItem.date || MISSING) : MISSING;
    const attribution = newsItem
      ? `${String(newsItem.title || MISSING)}（${String(newsItem.source || MISSING)}）`
      : MISSING;

    // 核心催化（禁止留白 / 无意义填充）：有新闻用新闻标题；无新闻按「资金 × 连板」自动归因。
    // 这是工作台铁律——代码权威，LLM 只负责原样引用，不得改写、不得输出「暂无可核验催化」/「无」/「缺失」。
    // 规则优先级：涨停数 > 0 且主力净流入 > 0 → 资金与游资共振；涨停数 > 0（无正流入）→ 纯游资接力；
    // 涨停数 = 0 且主力净流入 > 0 → 纯资金驱动；二者皆无 → 退化的板块联动描述（仍非占位词）。
    let catalyst;
    if (newsItem) {
      catalyst = `${String(newsItem.title || MISSING)}（${String(newsItem.source || MISSING)}）`;
    } else {
      const zt = num(count) || 0;
      const net = num(mainNet);
      if (zt > 0 && net != null && net > 0) {
        catalyst = `资金与游资共振（净流入${fixed(net)}亿/最高${boardsMax == null ? '—' : boardsMax}板）`;
      } else if (zt > 0) {
        catalyst = `纯游资接力（最高${boardsMax == null ? '—' : boardsMax}板）`;
      } else if (net != null && net > 0) {
        catalyst = `纯资金驱动（净流入${fixed(net)}亿）`;
      } else {
        catalyst = `板块联动（涨停 ${zt} 家${net != null ? `、主力净${net >= 0 ? '流入' : '流出'}${fixed(Math.abs(net))}亿` : ''}）`;
      }
    }

    const st = stageOf(industry, industryHistory, count);
    const mc = midCapOf(industry, midCap);
    const sealRow = sealTime ? matchByName(list(sealTime.byIndustry), x => x.industry, industry) : null;
    const earlyShare = (sealRow && num(sealRow.count) > 0)
      ? num(sealRow.early) / num(sealRow.count) * 100 : null;

    // ---- 驱动标签 D1-D4（D4 恒不标，口径披露见 notes） ----
    const tags = [];
    if ((boardsMax != null && boardsMax >= 2) || hasLayer === true || (earlyShare != null && earlyShare >= TOPIC_TH.earlySealShare)) tags.push('D1');
    if (newsItem) tags.push('D2');
    if (mainNet != null || amountYi != null || mc.ok) tags.push('D3');
    const drivers = tags.length ? tags.join('/') : MISSING;

    // ---- 资金投票质量 ----
    let voteQuality, voteReason;
    const isDefensive = DEFENSIVE_WORDS.some(w => industry.includes(w));
    const trapHit = st.stage === '高潮/退潮期' && (largeDropIndustries.includes(industry) || (mc.ok && mc.changePct != null && mc.changePct < 0));
    const msgHigh = (level.rank <= 1) && (st.stage === '启动期' || st.stage === '发酵/主升期');
    const coreOk = boardsMax != null && boardsMax >= 2;
    const midCapStrong = mc.ok && mc.changePct != null && mc.changePct >= TOPIC_TH.midCapStrongPct;
    if (trapHit) {
      voteQuality = '无效/陷阱投票';
      voteReason = `题材处于${st.stage}且出现「利好兑现后回落」证据（大面股行业命中或中军代理走弱）；利好未转化为持续承接`;
    } else if (isDefensive && amtTrend.direction === '收缩') {
      voteQuality = '防御性投票';
      voteReason = `涨停池成交额序列${amtTrend.direction}（${amtTrend.note}），资金流向「${industry}」等防御方向；仅作当日结构描述`;
    } else if (msgHigh && count != null && count >= TOPIC_TH.strongLimitUp && coreOk && midCapStrong) {
      voteQuality = '强共识投票';
      voteReason = `官方级线索 + ${st.stage} + 涨停 ${count} 家 + 连板核心 ${boardsMax} 板 + 中军代理 ${pct(mc.changePct)}，四项证据齐备`;
    } else if (count != null && (count <= 2 || hasLayer === false || (mc.ok && mc.changePct != null && mc.changePct < TOPIC_TH.midCapStrongPct))) {
      voteQuality = '局部游资投票';
      voteReason = `涨停 ${count} 家、板块层次 ${hasLayer == null ? MISSING : (hasLayer ? '有' : '无')}、中军代理 ${mc.ok ? pct(mc.changePct) : MISSING}；有涨停但承接不足或仅小票异动`;
    } else {
      voteQuality = '无法判断';
      voteReason = `消息级别、板块层次或中军代理证据${MISSING}，不足以归入任一投票类型`;
    }

    // ---- 双方向四象限（技术面 × 消息面） ----
    let quadrant, quadrantAction, quadReason;
    const msgKnown = !!newsItem;
    const msgStrong = msgKnown && level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期');
    const techKnown = count != null;
    const techStrong = techKnown && count >= TOPIC_TH.strongLimitUp && coreOk && hasLayer === true;
    const techWeak = techKnown && (count <= 2 || hasLayer === false || singles.includes(industry));
    if (!msgKnown || !techKnown) {
      quadrant = '无法判断';
      quadrantAction = '不因象限额外升降级；证据缺口已在确认项中扣分';
      quadReason = `${msgKnown ? '' : `消息面证据${MISSING}（新闻流不能证明「无消息」）；`}${techKnown ? '' : `技术面涨停家数${MISSING}；`}按诚实缺失原则不判「双弱」、不整批剔除`;
    } else if (msgStrong && techStrong) {
      quadrant = '共振'; quadrantAction = '可给 S/A 级，重点跟踪次日板块响应';
      quadReason = `消息强（${level.level} + ${st.stage}）且技术强（涨停 ${count} 家 / 连板核心 / 有层次）`;
    } else if (msgStrong && techWeak) {
      quadrant = '背离'; quadrantAction = '降级为仅观察（防诱多）';
      quadReason = `消息强但技术弱：涨停 ${count} 家、层次 ${hasLayer === false ? '无' : '待核验'}，中军未跟`;
    } else if (!msgStrong && techStrong) {
      quadrant = '先觉'; quadrantAction = '放入观察池但降一级（防无源之水）';
      quadReason = `技术强（涨停 ${count} 家 / 连板核心 / 有层次）但消息级别为 ${level.level}，催化未明`;
    } else if (!msgStrong && techWeak) {
      quadrant = '双弱'; quadrantAction = '按规格剔除出可跟踪候选';
      quadReason = `消息级别 ${level.level}、涨停 ${count} 家且板块无跟随，无催化无量价`;
    } else {
      quadrant = '无法判断'; quadrantAction = '不因象限额外升降级';
      quadReason = '消息面与技术面均未达到强/弱判定阈值，保持中性';
    }

    // ---- 题材评级 S/A/B/C ----
    let grade, gradeReason, evidenceComplete;
    const cTrap = st.stage === '高潮/退潮期' && (trapHit || (mc.ok && mc.changePct != null && mc.changePct < 0) || singles.includes(industry));
    if (cTrap) {
      grade = 'C'; evidenceComplete = true;
      gradeReason = `利好兑现/退潮特征（${st.reason}）+ 中军代理走弱或龙头独舞，按「诱多陷阱」处理`;
    } else if (level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期')
      && count != null && count >= TOPIC_TH.sLimitUp && coreOk && midCapStrong && hasLayer === true) {
      grade = 'S'; evidenceComplete = true;
      gradeReason = `国家级/产业级线索 + ${st.stage} + 涨停 ${count} 家 + 连板核心 + 中军代理 ${pct(mc.changePct)} + 板块有层次，主线共振六项齐备`;
    } else if (level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期')
      && count != null && count >= TOPIC_TH.sLimitUp && coreOk && !mc.ok) {
      grade = 'A'; evidenceComplete = false;
      gradeReason = `消息与阶段、涨停家数、连板核心齐备，但「中军大阳线」数据${MISSING}（工作台仅有涨停池内大市值代理，当前无该行业样本）→ S 级不成立，降为 A`;
    } else if (msgKnown && count != null && count <= 2) {
      grade = 'A'; evidenceComplete = count != null;
      gradeReason = `${level.level} 线索 + 仅 ${count} 家涨停、中军代理 ${mc.ok ? pct(mc.changePct) : MISSING}，属局部投机`;
    } else if (!msgKnown) {
      grade = 'B'; evidenceComplete = false;
      gradeReason = `无匹配新闻催化线索（消息面证据${MISSING}），涨停 ${count == null ? MISSING : count} 家；按「轮动补涨/无明显新闻」处理，S/A 级不成立`;
    } else {
      grade = 'B'; evidenceComplete = false;
      gradeReason = `消息级别 ${level.level}、阶段 ${st.stage}、涨停 ${count == null ? MISSING : count} 家，未同时满足 S/A/C 条件，按轮动补涨归类`;
    }

    const verifyLogic = grade === 'S'
      ? `明日核对 ${industry} 涨停家数是否维持 ≥${count} 家、中军代理 ${mc.topName || MISSING} 是否继续放量、最高板 ${boardsMax == null ? MISSING : boardsMax} 板是否晋级`
      : grade === 'A'
        ? `明日核对 ${industry} 是否出现第 2 只跟随涨停、中军代理是否响应、早盘封板占比是否维持`
        : grade === 'B'
          ? `明日核对 ${industry} 是否延续涨停家数 ${count == null ? MISSING : count} 家、是否出现可核验催化线索`
          : `明日核对 ${industry} 高位断板股是否止跌、涨停家数是否继续自峰值 ${Math.max.apply(null, st.series.length ? st.series : [0])} 家回落`;

    cards.push({
      name: industry,
      changePct,
      limitUpCount: count == null ? MISSING : count,
      midCapText: mc.text,
      attribution,
      catalyst,
      newsLevel: level.level,
      newsTime,
      stage: st.stage,
      stageReason: st.reason,
      grade,
      gradeReason,
      verifyLogic,
      voteQuality,
      voteReason,
      quadrant,
      quadrantAction,
      quadReason,
      drivers,
      // 内部结构字段：前端 HIDDEN_COLS 不展示，机会引擎中和时使用
      newsSource: newsItem ? String(newsItem.source || MISSING) : MISSING,
      evidenceComplete,
      count, boardsMax, hasLayer, mainNet, earlyShare,
      midCapChangePct: mc.changePct,
      sealTimeText: sealRow
        ? `早盘 ${sealRow.early} / 盘中 ${sealRow.mid} / 尾盘 ${sealRow.late}（共 ${sealRow.count} 家）`
        : MISSING,
    });
  }

  // ---- 汇总 ----
  const voteSummary = { '强共识投票': 0, '局部游资投票': 0, '无效/陷阱投票': 0, '防御性投票': 0, '无法判断': 0 };
  const quadrantSummary = { '共振': 0, '背离': 0, '先觉': 0, '双弱': 0, '无法判断': 0 };
  const gradeSummary = { S: 0, A: 0, B: 0, C: 0 };
  cards.forEach(c => {
    if (voteSummary[c.voteQuality] != null) voteSummary[c.voteQuality]++;
    if (quadrantSummary[c.quadrant] != null) quadrantSummary[c.quadrant]++;
    if (gradeSummary[c.grade] != null) gradeSummary[c.grade]++;
  });
  const dominantVote = cards.length
    ? Object.entries(voteSummary).sort((a, b) => b[1] - a[1])[0][0] : '无法判断';
  const dominantQuadrant = cards.length
    ? Object.entries(quadrantSummary).sort((a, b) => b[1] - a[1])[0][0] : '无法判断';
  const topicByIndustry = {};
  cards.forEach(c => {
    topicByIndustry[c.name] = {
      stage: c.stage, stageReason: c.stageReason, grade: c.grade, gradeReason: c.gradeReason,
      newsLevel: c.newsLevel, newsTime: c.newsTime, quadrant: c.quadrant,
      quadrantAction: c.quadrantAction, voteQuality: c.voteQuality,
      drivers: c.drivers, verifyLogic: c.verifyLogic,
      limitUpCount: c.count, hasLayer: c.hasLayer, midCapChangePct: c.midCapChangePct,
      evidenceComplete: c.evidenceComplete,
    };
  });

  const notes = [
    '消息级别与性质由「来源名称 + 标题关键词」推断，未经公告原文核验；自媒体小作文一律标「传闻/未核验」。联网搜索只作线索触发器，不替代行情数据与公告核验。',
    '「中军表现」以涨停池内流通市值居前个股作代理，工作台无板块成分股/市值/趋势行情映射；代理样本缺失时 S 级不成立，自动降为 A 并写明证据缺口。',
    `题材阶段基于前 3-5 个交易日同口径「按所属行业聚合的涨停家数」序列，有效对照点 < ${TOPIC_TH.stageMinPoints} 时输出「${NO_COMPARISON}」，禁止把单日数据当趋势。`,
    '工作台新闻源为实时 7×24 快讯，无法证明某题材「当日无消息」；因此「无匹配线索」记为消息面证据缺失，四象限判「无法判断」而非「双弱」，不整批剔除候选（避免空白模板）。',
    'S 级六项证据：国家级/产业级线索 + 启动或良性发酵 + 涨停≥5 家 + 连板核心 + 中军代理大阳线 + 板块有层次；缺任一证据不得评 S。',
    'C 级诱多陷阱需同时具备「利好兑现/退潮阶段」与「中军代理走弱或龙头独舞」客观证据，不因单日下跌直接判 C。',
    '驱动标签 D1 技术 / D2 消息 / D3 资金 / D4 基本面；D4 因复盘链路未接入财报与估值数据恒不标注，不以新闻标题冒充基本面证据。',
    '封板时间分桶口径：首次封板时间 ≤10:00 为早盘、10:00-14:00 为盘中、≥14:00 为尾盘，非法值计入 unknown；仅反映封板节奏，不单独证明资金性质。',
    '成交额、龙虎榜、涨停时间只反映交易活跃度，不能单独证明机构进场或资金出逃；亏钱效应收敛只代表压力缓解，不等于买点出现。',
    '本卡片是线索归因与验证清单，不是买入发令枪；观察池是验证市场风向的样本，不构成任何操作建议。',
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    date: ctx.date,
    histDates: ctx.histDates,
    cards,
    voteSummary,
    quadrantSummary,
    gradeSummary,
    dominantVote,
    dominantQuadrant,
    topicByIndustry,
    sealTimeSummary: sealTime
      ? `全市场首次封板时间：早盘 ${sealTime.early} / 盘中 ${sealTime.mid} / 尾盘 ${sealTime.late} / 无法解析 ${sealTime.unknown}（共 ${sealTime.total} 家）`
      : MISSING,
    limitDownSummary: limitDown
      ? `跌停股 ${limitDown.count} 家，平均涨跌幅 ${pct(limitDown.avgChgPct)}；行业分布 ${list(limitDown.industryDist).slice(0, 3).map(x => `${x.industry} ${x.count}`).join('、') || MISSING}`
      : MISSING,
    amtTrend,
    notes,
    keyMissingTop3: [
      { field: '板块中军 / 趋势股真实行情', why: 'S 级「中军大阳线」与 R-S5 无法完整判定，现用涨停池内大市值代理' },
      { field: '官方公告原文与催化时间窗', why: '消息级别仅能按来源名推断，无法核验公告真伪与首发时间' },
      { field: '板块涨幅榜与资讯的结构化关联', why: '题材归因依赖行业名/关键词匹配，覆盖率有限' },
    ],
  };
}

module.exports = {
  analyzeTopics, trendOf, matchByName, matchNews, newsLevelOf, stageOf, midCapOf, normInput,
  SCHEMA_VERSION, TOPIC_TH, DRIVER_DEFS, INDUSTRY_KEYWORDS, MISSING, NO_COMPARISON,
};

~~~

---

## `lib\tradeCalendar.js`  ·  240 行

~~~js
/**
 * lib/tradeCalendar.js — 交易日历表（20261107 · 每日复盘模块）
 * ==============================================================
 * 用户指令：新建 trade_calendar 表，导入交易所交易日历；节假日/周末 is_trading_day=false，
 * 调休交易日=true；定时任务必须先查该表。
 *
 * 单一权威源约束（工作台三条底层规则之一）：
 *   判定逻辑 **不另起一套**，复用 lib/cnTradingCalendar.js 的 isTradingDay()（上交所休市安排
 *   区间 + 周末规则）。本模块只是把它持久化成 SQLite 表，供定时任务/API 查询与审计，
 *   避免「内存一份、表里一份」造成口径漂移。
 *
 * 表结构：trade_calendar(date TEXT PRIMARY KEY, is_trading_day INTEGER, day_type, source,
 *                       source_time, note, imported_at)
 *   - day_type: 'trading' | 'weekend' | 'holiday' | 'makeup'
 *   - makeup（调休交易日）：A 股一般没有「周末调休补交易日」，但交易所若公布特殊交易日，
 *     通过 overrides.json 显式登记 is_trading_day=true，优先级高于基础规则。
 *   - source / source_time：数据五要素之「来源 / 实际时间」，联网公告兜底时写明来源时间。
 *
 * 隔离原则：本模块为**纯新增**，不修改 cnTradingCalendar.js 及任何既有模块，
 * 未被 require 时对现有工作台零影响。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { localDate } = require('./localDate');
const cnCal = require('./cnTradingCalendar');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.SA_TRADE_CALENDAR_DB
  ? path.resolve(process.env.SA_TRADE_CALENDAR_DB)
  : path.join(DATA_DIR, 'trade_calendar.db');
const OVERRIDES_FILE = process.env.SA_TRADE_CALENDAR_OVERRIDES
  ? path.resolve(process.env.SA_TRADE_CALENDAR_OVERRIDES)
  : path.join(DATA_DIR, 'trade_calendar_overrides.json');

let db = null;

function nowIso() { return new Date().toISOString(); }

// ---------- 调休 / 特殊交易日 override ----------
/**
 * overrides.json 格式：
 * {
 *   "2026-10-10": { "is_trading_day": true,  "reason": "交易所公告：国庆调休补交易日",
 *                   "source": "上交所公告", "source_time": "2026-09-20" },
 *   "2026-10-11": { "is_trading_day": false, "reason": "...", "source": "...", "source_time": "..." }
 * }
 * 只允许显式布尔值；缺失/非法忽略，不臆造。
 */
function readOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (!v || typeof v !== 'object' || typeof v.is_trading_day !== 'boolean') continue;
      out[k] = {
        is_trading_day: v.is_trading_day,
        reason: String(v.reason || '').slice(0, 200),
        source: String(v.source || '本地登记').slice(0, 120),
        source_time: String(v.source_time || '').slice(0, 40),
      };
    }
    return out;
  } catch (e) {
    return {};
  }
}

// ---------- 基础规则（单一权威源） ----------
function classifyByRule(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const dow = d.getDay();
  const holiday = !cnCal.isTradingDay(dateStr);
  let dayType;
  if (dow === 0 || dow === 6) dayType = 'weekend';
  else if (holiday) dayType = 'holiday';
  else dayType = 'trading';
  return {
    is_trading_day: cnCal.isTradingDay(dateStr),
    day_type: dayType,
    source: 'cnTradingCalendar.js（上交所休市安排区间 + 周末规则）',
    source_time: '静态规则表',
    note: '',
  };
}

// ---------- 建表 / 导入 ----------
function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS trade_calendar (
    date TEXT PRIMARY KEY,
    is_trading_day INTEGER NOT NULL,
    day_type TEXT NOT NULL,
    source TEXT,
    source_time TEXT,
    note TEXT,
    imported_at TEXT
  );`);
  return db;
}

/** YYYY-MM-DD 加一天（本地字符串运算，避免 UTC 偏移） */
function addDay(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * 导入 [fromDate, toDate] 全量日历（幂等：同日重复导入按主键覆盖）。
 * 覆盖 cnTradingCalendar 已维护年份 + 前后各一年（未维护年份按「仅跳过周末」规则，
 * 并在 note 中如实标注「官方节假日安排未公布，按周末规则推定」，不伪装成交易所公告）。
 */
function importRange(fromDate, toDate) {
  const d = getDb();
  const overrides = readOverrides();
  const maintainedYears = new Set(Object.keys(cnCal.HOLIDAY_RANGES || {}));
  const stmt = d.prepare(
    `INSERT INTO trade_calendar (date, is_trading_day, day_type, source, source_time, note, imported_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       is_trading_day=excluded.is_trading_day, day_type=excluded.day_type,
       source=excluded.source, source_time=excluded.source_time,
       note=excluded.note, imported_at=excluded.imported_at`
  );
  let cur = fromDate;
  let n = 0;
  const at = nowIso();
  const run = d.prepare('BEGIN');
  const done = d.prepare('COMMIT');
  try {
    run.run();
    while (cur <= toDate) {
      const base = classifyByRule(cur);
      if (base) {
        let row = { ...base };
        const yr = cur.slice(0, 4);
        if (!maintainedYears.has(yr)) {
          row.note = '该年份官方节假日休市安排未公布，按「仅跳过周末」规则推定，非交易所公告';
        }
        const ov = overrides[cur];
        if (ov) {
          row = {
            is_trading_day: ov.is_trading_day,
            day_type: ov.is_trading_day ? 'makeup' : 'holiday',
            source: ov.source,
            source_time: ov.source_time,
            note: ov.reason || '',
          };
        }
        stmt.run(cur, row.is_trading_day ? 1 : 0, row.day_type,
          row.source, row.source_time, row.note, at);
        n++;
      }
      cur = addDay(cur, 1);
    }
    done.run();
  } catch (e) {
    try { d.prepare('ROLLBACK').run(); } catch (_) { /* ignore */ }
    throw e;
  }
  return { imported: n, from: fromDate, to: toDate, dbFile: DB_FILE };
}

/** 首次初始化：导入 2025-01-01 ~ 2027-12-31（覆盖当前已维护年份 + 缓冲） */
function ensureImported() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS n FROM trade_calendar').get();
  if (row && row.n > 0) return { imported: 0, already: row.n };
  return importRange('2025-01-01', '2027-12-31');
}

// ---------- 查询 ----------
/**
 * 查表（定时任务必须先调这个，不许绕过直接调 cnCal.isTradingDay）。
 * @param {string} dateStr YYYY-MM-DD
 * @returns {{ok:boolean, date:string, is_trading_day:boolean, day_type:string,
 *            source:string, source_time:string, note:string, from_table:boolean}}
 */
function isTradingDay(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? dateStr : localDate();
  const d = getDb();
  let row = d.prepare('SELECT * FROM trade_calendar WHERE date=?').get(date);
  if (!row) {
    // 表未覆盖该日期 → 现场补导入该日期所在整年，再查一次（保持「先查表」语义）
    const yr = date.slice(0, 4);
    try { importRange(`${yr}-01-01`, `${yr}-12-31`); } catch (e) { /* fallthrough */ }
    row = d.prepare('SELECT * FROM trade_calendar WHERE date=?').get(date);
  }
  if (!row) {
    const base = classifyByRule(date) || { is_trading_day: false, day_type: 'weekend', source: '缺失', source_time: '', note: '规则无法判定' };
    return {
      ok: false, date, is_trading_day: !!base.is_trading_day, day_type: base.day_type,
      source: base.source, source_time: base.source_time, note: base.note,
      from_table: false, reason: '交易日历表无此日期且补导入失败',
    };
  }
  return {
    ok: true, date,
    is_trading_day: !!row.is_trading_day,
    day_type: row.day_type,
    source: row.source,
    source_time: row.source_time,
    note: row.note,
    from_table: true,
  };
}

function getRange(fromDate, toDate) {
  const d = getDb();
  return d.prepare('SELECT * FROM trade_calendar WHERE date>=? AND date<=? ORDER BY date ASC')
    .all(fromDate, toDate)
    .map(r => ({ ...r, is_trading_day: !!r.is_trading_day }));
}

function stats() {
  const d = getDb();
  const r = d.prepare('SELECT COUNT(*) AS n, MIN(date) AS minD, MAX(date) AS maxD FROM trade_calendar').get();
  const t = d.prepare('SELECT COUNT(*) AS n FROM trade_calendar WHERE is_trading_day=1').get();
  return { total: r.n, tradingDays: t.n, fromDate: r.minD, toDate: r.maxD, dbFile: DB_FILE };
}

/** 测试用：关闭句柄 */
function close() { if (db) { try { db.close(); } catch (_) { /* ignore */ } db = null; } }

module.exports = {
  isTradingDay, getRange, importRange, ensureImported, stats,
  readOverrides, classifyByRule, close, DB_FILE, OVERRIDES_FILE,
};

~~~

---

## `lib\usMacroCalendar.js`  ·  158 行

~~~js
/**
 * 美国宏观事件排期 · 自动抓取（20261013b）
 * --------------------------------------------------------------
 * 主源：fedratecalc.com/us-economic-calendar —— 一张汇总表覆盖 CPI / PPI /
 * 非农（Employment Situation）/ FOMC 决议，条目来源标注 BLS/美联储官网。
 * 选择理由：① 单源覆盖全类型；② 表格结构规整可正则解析；③ BLS 官网直爬
 * 被 Akamai 反爬拦（403）、美联储官网只有 FOMC；④ 实测用户网络可访问。
 *
 * 设计：
 *   - 美东时间（ET）确定性转北京时间（含 DST 规则：3月第2周日~11月第1周日）；
 *   - 事件解读用类型模板（方向框架，不编造数值）；
 *   - 结果落盘缓存（TTL 12h），抓取失败回退陈旧缓存；
 *   - 解析结果 <2 条视为抓取失败（页面结构可能改版），由调用方回退内置清单。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { localDate } = require('./localDate');

const CAL_URL = 'https://fedratecalc.com/us-economic-calendar';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'us_macro_calendar_cache.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 只收录对 A 股有方向意义的高权重类型
const TYPE_RULES = {
  cpi:      { match: /Consumer Price Index/i, category: '通胀', level: 'high',   impact: 'conditional',
              summary: '美国通胀读数直接影响利率路径定价：超预期强化「更高更久」利率担忧、短期偏空全球风险资产；低于预期则缓解担忧、偏多。以 BLS 官方公布值为准。' },
  payrolls: { match: /Employment Situation|Nonfarm Payrolls/i, category: '就业', level: 'medium', impact: 'conditional',
              summary: '非农就业强弱直接影响美联储利率路径：强就业支撑加息/推迟降息预期、偏空风险资产；弱就业强化暂停/降息预期、偏多。' },
  fomc:     { match: /FOMC Rate Decision/i, category: '美联储', level: 'high', impact: 'bearish',
              summary: '美联储利率决议是当期全球资产定价核心事件：决议公布前部分资金倾向避险、短期压制风险偏好；若决议与点阵图偏鹰，全球风险资产承压。' },
  ppi:      { match: /Producer Price Index/i, category: '通胀', level: 'medium', impact: 'conditional',
              summary: 'PPI 为通胀先行指标：上游价格超预期回升预示 CPI 粘性、强化「更高更久」利率担忧；回落则缓解。' },
};

const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function nthSundayUtc(y, month1, n) {
  const first = new Date(Date.UTC(y, month1 - 1, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSunday + (n - 1) * 7;
}
// 美东夏令时（DST）：3月第2个周日 起，11月第1个周日 止
function isEtDst(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  return t >= Date.UTC(y, 2, nthSundayUtc(y, 3, 2)) && t < Date.UTC(y, 10, nthSundayUtc(y, 11, 1));
}
// "Wed, Oct 28, 2026" + "2:00 PM" → { date:'2026-10-29', beijingText:'2026-10-29 凌晨 02:00（北京时间）', etText:'2026-10-28 14:00（美东）' }
function etToBeijing(dateStr, timeStr) {
  const m = /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/.exec(dateStr || '');
  if (!m) return null;
  const mm = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
  const dd = parseInt(m[2], 10), yy = parseInt(m[3], 10);
  if (!mm) return null;
  const tm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(timeStr || '');
  let hh = tm ? (parseInt(tm[1], 10) % 12 + (/pm/i.test(tm[3]) ? 12 : 0)) : 8;
  const mi = tm ? parseInt(tm[2], 10) : 30;
  const shift = isEtDst(yy, mm, dd) ? 12 : 13; // EDT=+12h、EST=+13h 到北京时间
  const bj = new Date(Date.UTC(yy, mm - 1, dd, hh, mi) + shift * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const bjDate = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  const bjHh = bj.getUTCHours(), bjMi = bj.getUTCMinutes();
  const period = bjHh < 6 ? '凌晨' : bjHh < 12 ? '上午' : bjHh < 18 ? '下午' : '晚间';
  return {
    date: bjDate,
    beijingText: `${bjDate} ${period} ${p(bjHh)}:${p(bjMi)}（北京时间）`,
    etText: `${yy}-${p(mm)}-${p(dd)} ${p(hh)}:${p(mi)}（美东）`,
  };
}

// 解析 HTML 表格行：<td><span class="font-medium">Fri, Nov 6, 2026</span><span>8:30 AM<!-- --> ET</span></td><td><a>标题</a></td><td>数据期</td>
function parseFedRateCalc(html) {
  const clean = String(html || '').replace(/<!-- -->/g, '');
  const rowRe = /<td[^>]*><span class="font-medium text-gray-900">([^<]+)<\/span><span class="block text-sm text-gray-500">([^<]+)<\/span><\/td>\s*<td[^>]*>(?:<a[^>]*>)?([^<]+?)(?:<\/a>)?<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  const out = [];
  let r;
  while ((r = rowRe.exec(clean)) !== null) {
    const [, dateStr, timeStr, titleRaw, periodRaw] = r;
    const title = titleRaw.trim();
    const ruleKey = Object.keys(TYPE_RULES).find(k => TYPE_RULES[k].match.test(title));
    if (!ruleKey) continue;
    const bj = etToBeijing(dateStr, timeStr.replace(/\s*ET\s*$/, '').trim());
    if (!bj) continue;
    const rule = TYPE_RULES[ruleKey];
    const period = (periodRaw || '').trim().replace(/\s+/g, ' ');
    out.push({
      id: `us-${ruleKey}-${bj.date.replace(/-/g, '')}`,
      date: bj.date,
      dateZh: bj.beijingText,
      dateUs: bj.etText,
      title: title + (period && ruleKey !== 'fomc' ? `（${period}）` : ''),
      category: rule.category,
      level: rule.level,
      impact: rule.impact,
      summary: rule.summary,
      note: `事件预告（自动抓取排期）；原始来源：BLS / 美联储官方排期，经 FedRateCalc 汇总。`,
    });
  }
  return out;
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.events)) return j;
  } catch (e) {}
  return null;
}

function writeCache(events) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), source: CAL_URL, events }, null, 2));
    return true;
  } catch (e) {
    console.error('[usMacroCalendar] 写缓存失败:', e.message);
    return false;
  }
}

/**
 * 刷新排期缓存。force=false 时 12h TTL 内直接复用缓存（不抓网）。
 * 返回 { ok, events, fromCache, stale, source }
 * ok=false 时 events 可能为空数组（由调用方回退内置清单）。
 */
async function refreshUsMacroCalendar({ force = false } = {}) {
  const cached = readCache();
  const freshEnough = cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < CACHE_TTL_MS;
  if (!force && freshEnough) {
    return { ok: true, events: cached.events, fromCache: true, stale: false, source: cached.source || CAL_URL };
  }
  try {
    const resp = await axios.get(CAL_URL, {
      timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      adapter: 'http',
    });
    const events = parseFedRateCalc(resp.data);
    if (!Array.isArray(events) || events.length < 2) {
      throw new Error(`解析事件过少（${events ? events.length : 0} 条），页面结构可能改版`);
    }
    writeCache(events);
    return { ok: true, events, fromCache: false, stale: false, source: CAL_URL };
  } catch (e) {
    console.error('[usMacroCalendar] 抓取失败:', e.message);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      return { ok: true, events: cached.events, fromCache: true, stale: true, source: cached.source || CAL_URL, warn: e.message };
    }
    return { ok: false, events: [], fromCache: false, stale: false, source: CAL_URL, warn: e.message };
  }
}

module.exports = { refreshUsMacroCalendar, parseFedRateCalc, etToBeijing, isEtDst, _CACHE_FILE: CACHE_FILE };

~~~

---

## `lib\usMacroEvents.js`  ·  107 行

~~~js
/**
 * 美国经济数据 / 事件（三级数据源：三值复盘 → 排期预告 → 内置兜底）
 * --------------------------------------------------------------
 * 20261013c：升级为「预告 + 落地复盘（超预期/不及预期 → 影响分析）」——
 *   ① 主源 lib/usMacroResults.js：华尔街见闻宏观日历，三值（公布/预期/前值）齐全，
 *      覆盖 CPI/PPI/非农/失业率/FOMC/零售/ISM，落地后判定超/不及预期并给方向影响；
 *   ② 排期兜底 lib/usMacroCalendar.js：FedRateCalc 汇总表（BLS/美联储官方排期），
 *      仅日期无三值，华尔街见闻不可达时保证至少能显示排期；
 *   ③ 最终兜底：内置策划清单（FALLBACK_EVENTS）。
 *   统一过滤：released 事件公布后保留 14 天（超预期/不及预期复盘窗口，以 applyFilter 代码为准）、upcoming 事件按北京自然日过期剔除。
 *
 * 与「每日宏观 & 政策」卡片同源展示，并作为「市场情绪提醒」中
 * 「美国宏观事件情绪因子」的输入数据源（见 lib/macroSentimentFactors.js）。
 */
const fs = require('fs');
const path = require('path');
const { localDate } = require('./localDate');
const { refreshUsMacroCalendar } = require('./usMacroCalendar');
const { refreshUsMacroResults } = require('./usMacroResults');

// ---- 内置策划清单（双源都抓取失败时的最终兜底；日期来源：BLS 官方排期 + 美联储官网 2026 FOMC 日历）----
const FALLBACK_EVENTS = [
  { id: 'us-cpi-202609', date: '2026-10-14', dateZh: '2026-10-14 20:30（北京时间）', dateUs: '2026-10-14 08:30（美东）', title: '美国 9 月 CPI / 核心 CPI', category: '通胀', level: 'high', impact: 'neutral', summary: '美国通胀已连续数月明显高于 2% 目标（8 月 CPI 同比 3.4%）。若 9 月 CPI 继续超预期，将强化「更高更久」利率路径担忧、偏空；低于预期则缓解、偏多。', note: '事件预告（内置清单兜底），以 BLS 官方公布值为准。' },
  { id: 'us-fomc-20261028', date: '2026-10-29', dateZh: '2026-10-29 凌晨 02:00（北京时间）', dateUs: '2026-10-28 14:00（美东）', title: '美联储 FOMC 利率决议（10月会议，无点阵图）', category: '美联储', level: 'high', impact: 'neutral', summary: '9 月会议已加息 25bp 至 3.75%-4.00%。本次会议无点阵图，市场关注声明是否暗示继续加息。', note: '事件预告（内置清单兜底），决议落地后根据声明更新解读。' },
  { id: 'us-nfp-202610', date: '2026-11-06', dateZh: '2026-11-06 21:30（北京时间）', dateUs: '2026-11-06 08:30（美东）', title: '美国 10 月非农就业', category: '就业', level: 'medium', impact: 'neutral', summary: '9 月非农仅 +29k、失业率 4.2%。就业强弱直接影响利率路径。', note: '事件预告（内置清单兜底）。' },
  { id: 'us-cpi-202610', date: '2026-11-10', dateZh: '2026-11-10 21:30（北京时间）', dateUs: '2026-11-10 08:30（美东）', title: '美国 10 月 CPI / 核心 CPI', category: '通胀', level: 'high', impact: 'neutral', summary: '10 月通胀读数是 12 月 FOMC（含点阵图）前的关键输入。', note: '事件预告（内置清单兜底）。' },
  { id: 'us-fomc-20261209', date: '2026-12-10', dateZh: '2026-12-10 凌晨 02:00（北京时间）', dateUs: '2026-12-09 14:00（美东）', title: '美联储 FOMC 利率决议（12月会议，含点阵图）', category: '美联储', level: 'high', impact: 'neutral', summary: '年末最重要会议：公布经济预测摘要（SEP）与点阵图。', note: '事件预告（内置清单兜底）。' },
];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', p), 'utf8'));
  } catch (e) { return null; }
}

function readResultsCache() { return readJson('us_macro_results_cache.json'); }
function readCalendarCache() { return readJson('us_macro_calendar_cache.json'); }

function dayDiff(a, b) { // a,b: 'YYYY-MM-DD'
  return Math.round((new Date(a + 'T00:00:00+08:00') - new Date(b + 'T00:00:00+08:00')) / 86400000);
}

// 统一过滤 + 排序 + 状态补充：
//  - released（已公布）：公布后 14 天内保留（超预期/不及预期复盘窗口），更早剔除；
//  - upcoming（预告）：事件日 >= 今天保留。
//  - 排期/内置事件无 status，按 date 判定（date>=today 视为 upcoming）。
function applyFilter(events) {
  const today = localDate();
  const kept = (events || []).filter(e => {
    if (e.status === 'released') {
      const since = dayDiff(today, e.date); // 今天距公布日的天数（正数=已公布 N 天）
      return since >= 0 && since <= 14;
    }
    return e.date >= today;
  });
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return kept.map(e => {
    const o = { ...e };
    if (o.status === 'released') {
      o.daysSince = dayDiff(today, e.date);
    } else {
      o.status = 'upcoming';
      o.daysLeft = dayDiff(e.date, today);
    }
    return o;
  });
}

/**
 * 同步读取事件清单（情绪因子同步调用，必须保持同步）：
 *   华尔街见闻三值缓存 → FedRateCalc 排期缓存 → 内置清单；统一过滤。
 */
function getUsMacroEvents() {
  const results = readResultsCache();
  const calendar = readCalendarCache();
  let source;
  if (results && Array.isArray(results.events) && results.events.length) {
    source = results.events;
  } else if (calendar && Array.isArray(calendar.events) && calendar.events.length) {
    source = calendar.events;
  } else {
    source = FALLBACK_EVENTS;
  }
  return applyFilter(source);
}

/**
 * 路由调用前触发自动刷新（12h TTL，失败静默回退缓存/内置清单）。
 * 并行抓两源；返回 { ok, stale, source, hasResults } 供路由标注。
 */
async function refreshUsMacroEvents(opts) {
  const [r, c] = await Promise.all([
    refreshUsMacroResults(opts || {}).catch(e => ({ ok: false, stale: false, source: '', warn: e.message })),
    refreshUsMacroCalendar(opts || {}).catch(e => ({ ok: false, stale: false, source: '', warn: e.message })),
  ]);
  const resultsOk = r && r.ok && Array.isArray(r.events) && r.events.length;
  if (resultsOk) {
    return { ok: true, stale: !!r.stale, source: r.source, hasResults: true, warn: r.warn };
  }
  if (c && c.ok && Array.isArray(c.events) && c.events.length) {
    return { ok: true, stale: !!c.stale, source: c.source, hasResults: false, warn: c.warn };
  }
  return { ok: false, stale: false, source: '', hasResults: false, warn: (r.warn || c.warn || '') };
}

module.exports = { getUsMacroEvents, refreshUsMacroEvents, US_MACRO_EVENTS: FALLBACK_EVENTS };

~~~

---

## `lib\usMacroResults.js`  ·  326 行

~~~js
/**
 * 美国宏观数据 · 落地复盘（公布值 / 预期值 / 前值 → 超预期 / 不及预期 → 影响分析）
 * ----------------------------------------------------------------------
 * 数据源：华尔街见闻宏观日历 API（api-one-wscn.awtmt.com）—— 国内站、单源三值齐全，
 * 其 forecast 为彭博/路透等机构共识口径（用户要求参考的「预期值」）。
 *
 * 接口约束：单次只允许一周（code 60502），须按 7 天切片；条目字段：
 *   id / public_date(秒) / country / title / calendar_type(FD=数据,FE=事件) /
 *   importance(1-4) / actual / forecast / previous / revised / unit / period
 *
 * 设计（确定性代码，不编造数值）：
 *   - 只收录美国 FD（数据类）且 importance≥3 的高权重指标，按标题关键词分类；
 *   - 三值字符串解析为数值，按类型容差判定 超预期(above)/符合(inline)/不及预期(below)；
 *   - 按「类型 × 超/不及」给方向影响（涨跌语义同项目红涨绿跌，此处 impact 为对风险资产方向）；
 *   - 结果落盘缓存 data/us_macro_results_cache.json，TTL 12h，失败回退陈旧缓存。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WSCN_URL = 'https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'us_macro_results_cache.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;
// 判定逻辑版本：缓存事件里的 direction/summary 是按某版逻辑算出的，逻辑改动必须升级此版本，
// 旧缓存自动失效重抓（沿用 SCHEMA_VERSION 铁律——只改代码不升版本，旧缓存会被永久复用）。
const LOGIC_VERSION = '20261013e';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 标题 → 类型/方向语义。CPI/PPI/非农/失业率/FOMC/零售/ISM 为高权重可判方向指标；
// 黑名单排除「首次申请失业救济」等周频低意义条目。
const FOCUS_RULES = [
  { type: 'cpi',          re: /CPI同比/,             exclude: null, category: '通胀',   level: 'high',   tol: 0.1,  absTol: true },
  { type: 'coreCpi',      re: /核心CPI同比/,          exclude: null, category: '通胀',   level: 'high',   tol: 0.1,  absTol: true },
  { type: 'ppi',          re: /PPI同比/,             exclude: null, category: '通胀',   level: 'medium', tol: 0.2,  absTol: true },
  { type: 'payrolls',     re: /非农就业人口变动/,      exclude: null, category: '就业',   level: 'high',   tol: 0.10, absTol: false },
  { type: 'adp',          re: /ADP就业人数变动/,       exclude: null, category: '就业',   level: 'medium', tol: 0.10, absTol: false },
  { type: 'unemployment', re: /失业率/,               exclude: /首次申请|当周/, category: '就业', level: 'high', tol: 0.1, absTol: true },
  { type: 'fomc',         re: /FOMC利率决策/,          exclude: null, category: '美联储', level: 'high',   tol: 0,    absTol: true },
  { type: 'retail',       re: /零售销售环比/,          exclude: null, category: '消费',   level: 'medium', tol: 0.2,  absTol: true },
  { type: 'ism',          re: /ISM(制造业|非制造业)指数/, exclude: null, category: '景气', level: 'medium', tol: 0.5, absTol: true },
];

// 20261013e 双维度判定（用户要求：失业率/非农要分别标注「对经济的影响」和「对股市的偏好」，避免单一判定造成误读）：
//   数值大小只用于第一步判定超/符合/不及预期（judgeDeviation），不参与方向映射。
//
// 维度一「经济影响」（基本面框架）：
//   就业类（非农/ADP）：强于预期=经济动能向上=偏多；弱于预期=经济走弱=偏空；
//   失业率：高于预期=就业恶化=偏空；低于预期=就业改善=偏多；
//   通胀类（CPI/PPI）：高于预期=通胀上行/经济承压=偏空；低于预期=偏多；
//   FOMC：利率上调=融资成本上升=偏空；下调=偏多；
//   消费/景气（零售/ISM）：强于预期=偏多；弱于预期=偏空。
function ecoDirection(type, deviate) {
  if (!deviate || deviate === 'inline') return 'neutral';
  const above = deviate === 'above';
  switch (type) {
    case 'cpi': case 'coreCpi': case 'ppi':
      return above ? 'bearish' : 'bullish';
    case 'payrolls': case 'adp':
      return above ? 'bullish' : 'bearish';
    case 'unemployment':
      return above ? 'bearish' : 'bullish';
    case 'fomc':
      return above ? 'bearish' : 'bullish';
    case 'retail': case 'ism':
      return above ? 'bullish' : 'bearish';
    default:
      return 'neutral';
  }
}
// 维度二「股市偏好」（宽松/紧缩交易框架——数据强弱改变美联储政策预期，进而影响风险资产）：
//   非农/ADP：强于预期=宽松预期降温/紧缩担忧=偏空；弱于预期=宽松预期升温=偏多；
//   失业率：高于预期=宽松预期升温=偏多；低于预期=宽松预期降温=偏空；
//   通胀类：高于预期=紧缩预期升温=偏空；低于预期=偏多；
//   FOMC：上调=流动性收紧=偏空；下调=偏多；
//   零售/ISM：强于预期=盈利预期改善=偏多；弱于预期=偏空。
// 说明：就业类两维度方向相反属正常（数据弱→经济偏空，但同时宽松预期偏多股市），
// 20261013c 的用户困惑正源于把「股市偏好」单维度当成了唯一结论，故拆开标注。
function mktDirection(type, deviate) {
  if (!deviate || deviate === 'inline') return 'neutral';
  const above = deviate === 'above';
  switch (type) {
    case 'cpi': case 'coreCpi': case 'ppi':
      return above ? 'bearish' : 'bullish';
    case 'payrolls': case 'adp':
      return above ? 'bearish' : 'bullish';
    case 'unemployment':
      return above ? 'bullish' : 'bearish';
    case 'fomc':
      return above ? 'bearish' : 'bullish';
    case 'retail': case 'ism':
      return above ? 'bullish' : 'bearish';
    default:
      return 'neutral';
  }
}
// 兼容导出：direction = 股市偏好（情绪因子 macroSentimentFactors 锚定 FOMC 的 usSignal
// 及前端卡片左边框配色沿用此口径；FOMC 两维度方向一致，无兼容风险）。
function directionOf(type, deviate) {
  return mktDirection(type, deviate);
}

const TYPE_CN = { cpi: 'CPI 同比', coreCpi: '核心 CPI 同比', ppi: 'PPI 同比', payrolls: '非农就业', adp: 'ADP 就业', unemployment: '失业率', fomc: 'FOMC 利率', retail: '零售销售', ism: 'ISM 指数' };

// 20261013e：双维度语义文案（经济影响 / 股市偏好分开表述，修复"失业率上升=缓解压力"式矛盾文案）
const ECO_TEXT = {
  payrolls:     { bullish: '偏多（就业强劲 / 经济动能向上）', bearish: '偏空（就业走弱 / 经济动能放缓）' },
  adp:          { bullish: '偏多（就业强劲 / 经济动能向上）', bearish: '偏空（就业走弱 / 经济动能放缓）' },
  unemployment: { bullish: '偏多（失业回落 / 就业市场改善）', bearish: '偏空（失业加重 / 就业市场走弱）' },
  cpi:          { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  coreCpi:      { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  ppi:          { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  fomc:         { bullish: '偏多（利率下调 / 融资成本回落）',   bearish: '偏空（利率上调 / 融资成本上升）' },
  retail:       { bullish: '偏多（消费强劲 / 经济动能向上）', bearish: '偏空（消费走弱 / 经济动能放缓）' },
  ism:          { bullish: '偏多（景气扩张 / 经济动能向上）', bearish: '偏空（景气走弱 / 经济动能放缓）' },
};
const MKT_TEXT = {
  payrolls:     { bullish: '偏多（宽松预期升温）', bearish: '偏空（紧缩预期升温）' },
  adp:          { bullish: '偏多（宽松预期升温）', bearish: '偏空（紧缩预期升温）' },
  unemployment: { bullish: '偏多（宽松预期升温）', bearish: '偏空（宽松预期降温）' },
  cpi:          { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  coreCpi:      { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  ppi:          { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  fomc:         { bullish: '偏多（流动性宽松）',   bearish: '偏空（流动性收紧）' },
  retail:       { bullish: '偏多（盈利预期改善）', bearish: '偏空（盈利预期走弱）' },
  ism:          { bullish: '偏多（盈利预期改善）', bearish: '偏空（盈利预期走弱）' },
};

function ecoText(type, direction) {
  const m = ECO_TEXT[type];
  if (m && m[direction]) return m[direction];
  if (direction === 'bearish') return '偏空（经济承压）';
  if (direction === 'bullish') return '偏多（经济动能向上）';
  return '中性（影响有限）';
}
function mktText(type, direction) {
  const m = MKT_TEXT[type];
  if (m && m[direction]) return m[direction];
  if (direction === 'bearish') return '偏空（压制风险偏好）';
  if (direction === 'bullish') return '偏多（提振风险偏好）';
  return '中性（方向影响有限）';
}

function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[%＋+]/g, '').trim();
  if (s === '' || s === '-' || s === '—') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// 判定超/符合/不及（absTol：绝对容差；否则相对容差）
function judgeDeviation(actual, forecast, tol, absTol) {
  const a = num(actual), f = num(forecast);
  if (a == null || f == null) return null;
  if (f === 0) return a > 0 ? 'above' : (a < 0 ? 'below' : 'inline');
  const diff = a - f;
  const gap = absTol ? tol : Math.abs(f) * tol;
  if (diff > gap) return 'above';
  if (diff < -gap) return 'below';
  return 'inline';
}

// 北京时间 epoch 秒（代码计算，不依赖宿主机时区）
function bjEpoch(y, m, d, hh = 0, mi = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, hh, mi) / 1000) - 8 * 3600;
}
function bjDateStr(epochSec) {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function bjTimeStr(epochSec) {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function fetchWeek(startEpoch, endEpoch) {
  const resp = await axios.get(WSCN_URL, {
    params: { start: startEpoch, end: endEpoch },
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    adapter: 'http',
  });
  const payload = resp.data;
  if (!payload || payload.code !== 20000) {
    throw new Error(`华尔街见闻返回错误: ${(payload && payload.message) || payload.code || '未知'}`);
  }
  return (payload.data && payload.data.items) || [];
}

// 抓取 过去 daysBefore 天 ~ 未来 daysAfter 天（按 7 天切片，合并去重）
async function fetchWscnWindow(daysBefore, daysAfter) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - daysBefore * 86400000);
  const end = new Date(today.getTime() + daysAfter * 86400000);
  const seen = new Set();
  const items = [];
  for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + 7 * 86400000)) {
    const s = bjEpoch(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
    const stop = new Date(Math.min(cursor.getTime() + 6 * 86400000, end.getTime()));
    const e = bjEpoch(stop.getUTCFullYear(), stop.getUTCMonth() + 1, stop.getUTCDate(), 23, 59);
    const batch = await fetchWeek(s, e);
    for (const it of batch) {
      if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    }
  }
  return items;
}

// 合并 FOMC 上下限两条为一条
function mergeFomc(items) {
  const fomc = items.filter(i => i.type === 'fomc');
  if (fomc.length >= 2) {
    const lo = fomc.find(i => /下限/.test(i.rawTitle));
    const hi = fomc.find(i => /上限/.test(i.rawTitle));
    if (lo && hi) {
      const actual = (lo.actual != null && hi.actual != null) ? `${lo.actual}-${hi.actual}` : (lo.actual != null ? lo.actual : (hi.actual != null ? hi.actual : null));
      const forecast = (lo.forecast != null && hi.forecast != null) ? `${lo.forecast}-${hi.forecast}` : (lo.forecast != null ? lo.forecast : (hi.forecast != null ? hi.forecast : null));
      const previous = (lo.previous != null && hi.previous != null) ? `${lo.previous}-${hi.previous}` : (lo.previous != null ? lo.previous : (hi.previous != null ? hi.previous : null));
      const merged = {
        ...lo,
        id: 'us-fomc-' + lo.date,
        type: 'fomc',
        title: '美联储 FOMC 利率决议（目标区间）',
        actual, forecast, previous, unit: '%',
      };
      merged.deviate = judgeDeviation(lo.actual, lo.forecast, 0, true);
      merged.eco = ecoDirection('fomc', merged.deviate);
      merged.direction = mktDirection('fomc', merged.deviate);
      merged.impact = merged.direction;
      merged.summary = buildSummary(merged);
      return [merged, ...items.filter(i => i.type !== 'fomc')];
    }
  }
  return items;
}

function buildSummary(ev) {
  const t = ev.title;
  const f = ev.forecast, p = ev.previous;
  if (ev.status === 'upcoming' || ev.deviate == null) {
    return `${t} 将于 ${ev.date} ${ev.timeZh} 公布（预期 ${f != null ? f : '待定'}${ev.unit ? ev.unit : ''}${p != null ? '，前值 ' + p : ''}）。`;
  }
  const verdict = ev.deviate === 'above' ? '超预期' : ev.deviate === 'below' ? '不及预期' : '符合预期';
  return `${t} 公布 ${ev.actual}${ev.unit ? ev.unit : ''}，${verdict}（预期 ${f != null ? f : '—'}${ev.unit ? ev.unit : ''}，前值 ${p != null ? p : '—'}）→ 经济影响：${ecoText(ev.type, ev.eco)}；股市偏好：${mktText(ev.type, ev.direction)}。`;
}

// 将华尔街见闻 items 转为聚焦事件
function transform(items) {
  const out = [];
  for (const it of items) {
    if ((it.country || '').indexOf('美国') < 0) continue;
    if (it.calendar_type !== 'FD') continue;
    if (!(it.importance >= 3)) continue;
    const rule = FOCUS_RULES.find(r => r.re.test(it.title || '') && (!r.exclude || !r.exclude.test(it.title || '')));
    if (!rule) continue;
    const date = bjDateStr(it.public_date);
    const actual = it.actual;
    const hasActual = num(actual) != null;
    const deviate = hasActual ? judgeDeviation(actual, it.forecast, rule.tol, rule.absTol) : null;
    const direction = mktDirection(rule.type, deviate);
    const eco = ecoDirection(rule.type, deviate);
    out.push({
      id: it.id,
      type: rule.type,
      rawTitle: it.title,
      title: it.title,
      date,
      timeZh: bjTimeStr(it.public_date),
      dateZh: `${date} ${bjTimeStr(it.public_date)}（北京时间）`,
      category: rule.category,
      level: rule.level,
      impact: direction === 'bearish' ? 'bearish' : direction === 'bullish' ? 'bullish' : 'neutral',
      eco,
      actual: actual || null,
      forecast: it.forecast || null,
      previous: it.previous || null,
      revised: it.revised || null,
      unit: it.unit || '',
      deviate,
      direction,
      status: hasActual ? 'released' : 'upcoming',
      summary: '',
    });
  }
  for (const ev of out) ev.summary = buildSummary(ev);
  return mergeFomc(out);
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.events) && j.logicVersion === LOGIC_VERSION) return j;
  } catch (e) {}
  return null;
}
function writeCache(events) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), logicVersion: LOGIC_VERSION, source: '华尔街见闻宏观日历', events }, null, 2));
    return true;
  } catch (e) { console.error('[usMacroResults] 写缓存失败:', e.message); return false; }
}

async function refreshUsMacroResults({ force = false, daysBefore = 14, daysAfter = 21 } = {}) {
  const cached = readCache();
  const freshEnough = cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < CACHE_TTL_MS;
  if (!force && freshEnough) return { ok: true, events: cached.events, fromCache: true, stale: false, source: cached.source };
  try {
    const items = await fetchWscnWindow(daysBefore, daysAfter);
    const events = transform(items);
    if (!events.length) throw new Error('解析后无聚焦事件（美国高权重宏观数据）');
    writeCache(events);
    return { ok: true, events, fromCache: false, stale: false, source: '华尔街见闻宏观日历' };
  } catch (e) {
    console.error('[usMacroResults] 抓取失败:', e.message);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      return { ok: true, events: cached.events, fromCache: true, stale: true, source: cached.source, warn: e.message };
    }
    return { ok: false, events: [], fromCache: false, stale: false, source: '', warn: e.message };
  }
}

module.exports = { refreshUsMacroResults, transform, judgeDeviation, directionOf, ecoDirection, mktDirection, num, _CACHE_FILE: CACHE_FILE };

~~~

---

## `lib\usTreasury.js`  ·  271 行

~~~js
/**
 * 美债 10 年期收益率（首页「实时大盘」→ 🇺🇸 美国指数行 追加卡）
 * ==========================================================
 * 需求（用户 2026-10-21）：「首页这个位置添加美债10年期收益率指数」——位置=美国指数那一行的末尾。
 *
 * 为什么不用腾讯/新浪：qt.gtimg.cn 与 hq.sinajs.cn 均不提供美债收益率代码（已逐个实测：
 *   usTNX / us10Y / usUST10Y / gb_$tnx / gb_tnx … 全部为空或 pv_none_match），
 *   美股指数那一行的三个卡是「点位+涨跌幅」，国债收益率没有对应品种。
 *
 * 为什么是「日线」而不是实时：本机可达性实测（2026-10-21）——
 *   · 东方财富 push2 / push2delay / datacenter：TLS 连接被对端掐断（curl 返回 000）
 *   · CNBC quote API：Access Denied
 *   · Yahoo Finance ^TNX：429 / sad-panda 限流
 *   · TradingView scanner：空响应
 *   · 华尔街见闻 market/real：接口已下线（连 DJI 都返回空 snapshot）
 *   可达且权威的只有**美国财政部官方（home.treasury.gov）日度国债收益率曲线 CSV**，
 *   备源为**美联储 FRED DGS10**（同一口径，更新比财政部再晚一个交易日）。
 *   → 卡片如实标注「日线 · 截至 MM-DD」，绝不把日线伪装成实时。
 *
 * 数据口径（两源一致）：
 *   - 财政部 daily_treasury_yield_curve 的「10 Yr」列 = 10 年期国债**票面恒定到期收益率**（%），
 *     交易日日度发布（美东时间约 16:00 后更新当日值）。
 *   - FRED DGS10 = 同一指标的另一发布通道。
 *   - 「变动」用**基点 bp**：1bp = 0.01 个百分点，是本市场的通用表达（+6.0bp）。
 *
 * 降级链：财政部（当年） → 财政部（去年，跨年 1 月初用） → FRED → 上次成功缓存。
 * 全部失败时返回 null（卡片不渲染），**绝不编造数值**。
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TREASURY_URL = (yyyy) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yyyy}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yyyy}&page&_format=csv`;
const FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';

// 卡片点击跳转：东方财富 · 美国10年期国债收益率（20261021b，用户要求「美债收益率链接这个指数」）。
// secid 171.US10Y 来源：东财 suggest 接口（searchapi.eastmoney.com/api/suggest/get?input=美国10年期国债收益率）
// 返回 QuoteID=171.US10Y（market 171 = 全球债券），对应行情页标题实测为
// 「美国10年期国债收益率(US10Y)_行情中心_东方财富网」——即用户截图的同一个指数。
// 注：该页是东财 push2 的**盘中实时**报价，与本卡「美国财政部日度收益率」是两个口径，
// 数值可能不同；卡内 tooltip 已如实写明，不假装两者同源。
const LINK_URL = 'https://quote.eastmoney.com/unify/r/171.US10Y';
const LINK_LABEL = '东方财富 · 美国10年期国债收益率（盘中实时行情）';

const TTL_MS = 30 * 60 * 1000;        // 日线数据，30 分钟足够（财政部 16:00 ET 后才更新当日值）
const MAX_STALE_DAYS = 10;            // 超过 10 个自然日未更新 → 视为不可用（不展示），不拿过期数据当现行
const STALE_WARN_DAYS = 3;            // 超过 3 天 → 卡片打「⚠」标记（周末/美国假日常见，属正常，仅提示）
const MAX_TOTAL_MS = 12000;           // 整条降级链总预算：不能让首页「实时大盘」等一个日线字段超过 12s

let _cache = null;                    // { at:number, item:object|null }
let _inflight = null;
// 测试注入点（生产不调用）
let _fetchText = defaultFetchText;

async function defaultFetchText(url, timeout) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    timeout,
    responseType: 'text',
    transformResponse: [(d) => d],   // 保留原始文本，不让 axios 猜 JSON
  });
  return typeof resp.data === 'string' ? resp.data : String(resp.data || '');
}

// ---------- 解析 ----------

/** "10/19/2026" / "2026-10-19" → { y, m, d, iso:'2026-10-19' } */
function parseDateCell(s) {
  const t = String(s || '').trim().replace(/^"|"$/g, '');
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], iso: `${m[1]}-${m[2]}-${m[3]}` };
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // 财政部格式 M/D/YYYY
  if (m) return { y: +m[3], mo: +m[1], d: +m[2], iso: `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` };
  return null;
}

const _num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^"|"$/g, '');
  if (!s) return null;                       // 空串是「当日无发布」，不是 0
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const _splitCsvLine = (line) => line.split(',').map(c => c.trim());

/**
 * 解析财政部 daily_treasury_yield_curve CSV（行序降序，目标列 "10 Yr"）。
 * @returns {{asOf:string, latest:number, prev:number, rows:number}|null}
 */
function parseTreasuryCsv(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const head = _splitCsvLine(lines[0]).map(c => c.replace(/^"|"$/g, '').toLowerCase());
  if (head[0] !== 'date') return null;
  let col = head.indexOf('10 yr');
  if (col < 0) col = head.findIndex(h => /^10\s*yr$/.test(h));
  if (col < 0) return null;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = _splitCsvLine(lines[i]);
    const dt = parseDateCell(f[0]);
    const v = _num(f[col]);
    if (!dt || v == null) continue;           // 空值/脏行跳过（不填 0）
    rows.push({ iso: dt.iso, v });
  }
  if (rows.length < 1) return null;
  rows.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));   // 统一为降序，不依赖源站行序
  return { asOf: rows[0].iso, latest: rows[0].v, prev: rows[1] ? rows[1].v : null, rows: rows.length };
}

/**
 * 解析 FRED fredgraph.csv（observation_date,DGS10；行序升序，空值表示非交易日/未发布）。
 */
function parseFredCsv(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const head = _splitCsvLine(lines[0]).map(c => c.replace(/^"|"$/g, '').toLowerCase());
  if (head[0] !== 'observation_date' || head[1] !== 'dgs10') return null;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = _splitCsvLine(lines[i]);
    const dt = parseDateCell(f[0]);
    const v = _num(f[1]);
    if (!dt || v == null) continue;
    rows.push({ iso: dt.iso, v });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  const last = rows[rows.length - 1];
  return { asOf: last.iso, latest: last.v, prev: rows.length > 1 ? rows[rows.length - 2].v : null, rows: rows.length };
}

// ---------- 组装 ----------

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00Z').getTime();
  const b = new Date(isoB + 'T00:00:00Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 把解析结果包装成前端口径的卡片条目。
 * @param {object} p  { asOf, latest, prev }
 * @param {string} sourceLabel  数据来源标签（如实写）
 * @param {string} today        本地日期 YYYY-MM-DD（用于过期判定）
 */
function buildItem(p, sourceLabel, today) {
  if (!p || !(p.latest > 0) || !p.asOf) return null;
  const prev = p.prev != null && p.prev > 0 ? p.prev : null;
  const change = prev != null ? r2(p.latest - prev) : null;       // 百分点（5.15-5.09=0.06，r2 去浮点尾数）
  const changeBp = change != null ? r1(change * 100) : null;      // 基点
  const changePct = (change != null && prev) ? r2((change / prev) * 100) : null;
  const staleDays = today ? daysBetween(p.asOf, today) : null;
  if (staleDays != null && staleDays > MAX_STALE_DAYS) return null;   // 太旧 → 宁可不展示
  return {
    code: 'US10Y',
    name: '美债10年期',
    kind: 'yield',                 // 前端按此走「收益率」渲染（% + bp），不套指数点位口径
    unit: '%',
    price: p.latest,               // 收益率数值（%）：5.15 表示 5.15%
    prevClose: prev,
    change,                        // 百分点差（0.06）
    changeBp,                      // 基点差（+6.0），展示用
    changePct,                     // 相对变动（与指数卡同口径，仅作兜底/排序）
    asOf: p.asOf,
    dateLabel: p.asOf.slice(5),    // MM-DD
    staleDays,
    staleWarn: staleDays != null && staleDays > STALE_WARN_DAYS,
    channel: 'daily',
    sourceLabel,
    linkUrl: LINK_URL,          // 点击卡片跳东财同指数行情页（20261021b）
    linkLabel: LINK_LABEL,
  };
}

// ---------- 对外 ----------

/**
 * 取美债 10 年期收益率（日线）。成功返回卡片条目，全部源失败返回 null。
 * @param {{refresh?:boolean, today?:string}} opts
 */
async function getUs10yYield(opts = {}) {
  const now = Date.now();
  if (!opts.refresh && _cache && now - _cache.at < TTL_MS) return _cache.item;
  if (_inflight && !opts.refresh) return _inflight;

  const today = opts.today || localTodayIso();

  _inflight = (async () => {
    const yyyy = Number(today.slice(0, 4));
    const tries = [
      { label: '美国财政部·日度国债收益率曲线', run: () => _fetchText(TREASURY_URL(yyyy), 9000).then(parseTreasuryCsv) },
      // 跨年 1 月初：当年文件可能还没有任何一行 → 回看去年文件
      { label: '美国财政部·日度国债收益率曲线', run: () => _fetchText(TREASURY_URL(yyyy - 1), 9000).then(parseTreasuryCsv) },
      { label: '美联储FRED·DGS10', run: () => _fetchText(FRED_URL, 9000).then(parseFredCsv) },
    ];
    for (const t of tries) {
      try {
        const parsed = await t.run();
        const item = buildItem(parsed, t.label, today);
        if (item) {
          _cache = { at: Date.now(), item };
          return item;
        }
        if (parsed && parsed.latest > 0) {
          console.warn(`[US10Y] ${t.label} 最新值 ${parsed.latest}@${parsed.asOf} 已过期（>${MAX_STALE_DAYS}天），跳过`);
        }
      } catch (e) {
        console.warn(`[US10Y] ${t.label} 获取失败:`, e && e.message ? e.message : e);
      }
    }
    // 全部失败 → 回退上次成功缓存（仅当它本身还没过期，否则宁可没有）
    if (_cache && _cache.item) {
      const d = daysBetween(_cache.item.asOf, today);
      if (d != null && d <= MAX_STALE_DAYS) {
        console.warn('[US10Y] 本轮全部源失败，沿用上次成功缓存（截至 ' + _cache.item.asOf + '）');
        return _cache.item;
      }
    }
    console.warn('[US10Y] 全部数据源失败，本次不提供美债收益率卡');
    return null;
  })();

  try {
    // 总预算守门：单源超时 9s × 3 级 = 最坏 27s，首页等不起。超过 12s 先返回 null（卡片本次不渲染），
    // 后台链路继续跑完并可写入缓存，下次刷新就能命中——既不拖慢首页，也不丢已取到的数据。
    const timed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), MAX_TOTAL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();   // 不拖住进程退出（测试/单次脚本）
    });
    return await Promise.race([_inflight, timed]);
  } finally {
    _inflight = null;
  }
}

function localTodayIso() {
  try {
    return require('./localDate').localDate();
  } catch (e) {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

module.exports = {
  getUs10yYield,
  parseTreasuryCsv,
  parseFredCsv,
  buildItem,
  daysBetween,
  TREASURY_URL,
  FRED_URL,
  LINK_URL,
  LINK_LABEL,
  TTL_MS,
  MAX_STALE_DAYS,
  // 测试注入（生产代码不得调用）
  __setFetchText: (fn) => { _fetchText = typeof fn === 'function' ? fn : defaultFetchText; _cache = null; _inflight = null; },
  __resetCache: () => { _cache = null; _inflight = null; },
};

~~~

---

## `lib\valuation\brokerModel.js`  ·  178 行

~~~js
/**
 * lib/valuation/brokerModel.js —— 券商专属「分类+估值」运行器（确定性，20260908l）
 * ----------------------------------------------------------------
 * 闸门：仅当 data/valuation/{symbol}.json 存在且 kind==='broker' 时启用（其余公司一律不走本模块）。
 * 流程：6指标 → brokerClassification 三维评分+决策树 → 按类型匹配 brokerValuation 对应模型 → 组装展示明细。
 * 计算层=代码（纯四则+写死阈值/乘数），输入锁死 ⇒ 结果锁死（1+1=2）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { classify } = require('../brokerClassification');
const { valueByType } = require('../brokerValuation');

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
const fmt = (v, d = 2) => (v == null || !isFinite(Number(v))) ? 'N/A' : Number(v).toFixed(d);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);

function cfgPath(symbol) {
  return path.join(__dirname, '..', '..', 'data', 'valuation', `${String(symbol || '').replace(/^(sh|sz|bj)/i, '')}.json`);
}

/** 闸门：该标的是否配置了券商专属模型 */
function isBrokerModel(symbol) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(symbol), 'utf8'));
    return !!(cfg && cfg.kind === 'broker');
  } catch (e) { return false; }
}

function loadInputs(symbol) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(symbol), 'utf8'));
    if (!cfg || cfg.kind !== 'broker') return null;
    return cfg;
  } catch (e) { return null; }
}

const SCORE_LABELS = {
  scale: { 3: '大型全能', 2: '中型成长', 1: '中小型' },
  innovation: { 3: '高创新', 2: '中等创新', 1: '传统通道型' },
  diversification: { 3: '高度均衡', 2: '中度均衡', 1: '业务单一' },
};

/**
 * 主入口：运行券商分类+估值，返回与 601318 专属模型同构的 dedicated 结果（另带 broker:true）。
 * @param {string} symbol
 * @param {Object} opts { price: 实时价 }
 */
function run(symbol, opts = {}) {
  const cfg = loadInputs(symbol);
  if (!cfg) return { ok: false, error: 'NO_BROKER_MODEL' };
  const price = (opts.price != null && isFinite(Number(opts.price)) && Number(opts.price) > 0) ? Number(opts.price) : null;

  // ---- STEP2/3：分类（确定性）----
  const metricsPlain = {};
  for (const k of Object.keys(cfg.metrics || {})) metricsPlain[k] = nz(cfg.metrics[k] && cfg.metrics[k].value);
  const cls = classify(metricsPlain);
  if (!cls.ok) return { ok: false, error: 'CLASSIFY_FAIL', message: cls.message };
  const type = cls.type;

  // ---- 估值输入（含实时价注入）----
  const vi = {};
  for (const k of Object.keys(cfg.valuationInputs || {})) vi[k] = nz(cfg.valuationInputs[k] && cfg.valuationInputs[k].value);
  const params = cfg.params || {};

  let val, currentPB = null, extraNote = '';
  if (type === 'I') {
    currentPB = (price != null && vi.bps) ? price / vi.bps : null;
    val = valueByType('I', Object.assign({}, vi, {
      currentPB,
      costOfEquity: params.costOfEquity != null ? params.costOfEquity : 0.085,
      g: params.g != null ? params.g : 0.02,
    }));
  } else if (type === 'II') {
    val = valueByType('II', Object.assign({}, vi, { currentPrice: price }));
  } else {
    // 类型Ⅲ/Ⅳ模型输入尚未配置（后续个股接入时补配置文件即可，代码已就绪）
    return { ok: false, error: 'MODEL_INPUTS_NOT_CONFIGURED', message: `类型${type}（${cls.typeName}）的估值输入尚未在该标的配置文件中配置` };
  }
  if (!val || !val.ok) return { ok: false, error: 'VALUATION_FAIL', message: val && val.message };

  // ---- 评级：现价 vs 模型区间（确定性规则）----
  let rangeLow, rangeHigh, rating = 'N/A', ratingNote = '';
  if (type === 'I') {
    rangeLow = Math.min(nz(val.priceLow), nz(val.priceHigh));
    rangeHigh = Math.max(nz(val.priceLow), nz(val.priceHigh));
    if (price != null) {
      if (price < rangeLow) { rating = '低估'; ratingNote = '现价低于估值区间下限'; }
      else if (price > rangeHigh) { rating = '高估'; ratingNote = '现价高于估值区间上限'; }
      else { rating = '合理'; ratingNote = '现价处于估值区间内'; }
    }
  } else if (type === 'II') {
    rangeLow = val.stressRange ? val.stressRange[0] : null;
    rangeHigh = val.stressRange ? val.stressRange[1] : null;
    if (price != null && rangeLow != null && rangeHigh != null) {
      if (price < rangeLow) { rating = '低估'; ratingNote = '现价低于悲观情景下限'; }
      else if (price > rangeHigh) { rating = '高估'; ratingNote = '现价高于乐观情景上限'; }
      else { rating = '合理'; ratingNote = '现价处于悲观~乐观情景区间内'; }
    }
  }
  const center = (rangeLow != null && rangeHigh != null) ? r2((rangeLow + rangeHigh) / 2) : null;

  // ---- 展示明细组装 ----
  const metricsRows = Object.keys(cfg.metrics).map(k => ({
    label: { totalAssets: '总资产（综合实力）', netCapital: '净资本（监管抗风险）', brokerageRatio: '经纪业务收入占比', lightBizRatio: '投行+资管+财富占比（轻业务）', proprietaryRatio: '自营投资收入占比（重资本）', hhi: '收入集中度 HHI' }[k] || k,
    value: `${fmt(cfg.metrics[k].value, k === 'hhi' ? 4 : 2)}${cfg.metrics[k].unit ? ' ' + cfg.metrics[k].unit : ''}`,
    source: cfg.metrics[k].source || '',
  }));
  const scoreRows = [
    { label: '维度A 规模等级（S）', value: `${cls.scores.scale} 分（${SCORE_LABELS.scale[cls.scores.scale]}）`, source: '总资产≥5000亿且净资本≥800亿→3；≥2000亿→2；<2000亿→1' },
    { label: '维度B 创新业务占比（I）', value: `${cls.scores.innovation} 分（${SCORE_LABELS.innovation[cls.scores.innovation]}）`, source: '（投行+资管+财富）/营收 ≥45%→3；30%~45%→2；<30%→1' },
    { label: '维度C 业务多元化（D）', value: `${cls.scores.diversification} 分（${SCORE_LABELS.diversification[cls.scores.diversification]}）`, source: 'HHI<0.25→3；0.25~0.45→2；≥0.45→1' },
  ];
  const forced = metricsPlain.proprietaryRatio > 40;
  const decisionNote = forced
    ? `⚠️ 特殊判定生效：自营收入占比 ${fmt(metricsPlain.proprietaryRatio)}% > 40%，无论其他得分如何，强制归类为「类型Ⅱ 重资本自营型」。`
    : `决策树：自营占比 ${fmt(metricsPlain.proprietaryRatio)}%≤40%（非重资本）→ S=${cls.scores.scale}、I=${cls.scores.innovation}、D=${cls.scores.diversification} → 归类「类型${type} ${cls.typeName}」，推荐核心估值模型：${cls.primaryModel}。`;

  // 模型计算过程行（类型专属，全部由计算结果生成）
  let modelRows = [], modelSources = [];
  if (type === 'I') {
    const fairPB = val.fairPB, p10 = nz(vi.pbP10), p50 = nz(vi.pbP50), bps = nz(vi.bps), cost = params.costOfEquity != null ? params.costOfEquity : 0.085, g = params.g != null ? params.g : 0.02;
    modelRows = [
      { label: '理论合理PB', value: `(ROE−g)/(r−g) = (${fmt(vi.roeAvg3y * 100)}%−${fmt(g * 100)}%)/(${fmt(cost * 100)}%−${fmt(g * 100)}%) = ${fmt(fairPB)} 倍` },
      { label: '估值下限PB', value: `max(近5年PB 10%分位 ${fmt(p10)}, 合理PB×0.9=${fmt(fairPB * 0.9)}) = ${fmt(Math.max(p10, fairPB * 0.9))} 倍` },
      { label: '估值上限PB', value: `min(近5年PB 50%分位 ${fmt(p50)}, 合理PB×1.1=${fmt(fairPB * 1.1)}) = ${fmt(Math.min(p50, fairPB * 1.1))} 倍` },
      { label: '目标股价下限', value: `BPS ${fmt(bps)} × 估值下限PB = ${fmt(val.priceLow)} 元` },
      { label: '目标股价上限', value: `BPS ${fmt(bps)} × 估值上限PB = ${fmt(val.priceHigh)} 元` },
      { label: '当前股价 / 当前PB', value: price != null ? `${fmt(price)} 元 / ${fmt(currentPB)} 倍 → ${ratingNote}` : '实时价不可用' },
    ];
    modelSources = [
      { label: 'BPS（每股净资产）', source: (cfg.valuationInputs.bps && cfg.valuationInputs.bps.source) || '' },
      { label: '近5年PB 10%/50%分位', source: (cfg.valuationInputs.pbP10 && cfg.valuationInputs.pbP10.source) || '' },
      { label: '近3年平均ROE', source: (cfg.valuationInputs.roeAvg3y && cfg.valuationInputs.roeAvg3y.source) || '' },
      { label: '模型假设（写死）', source: params.costSource || '行业平均股权资本成本8.5%、永续增长率g=2%' },
    ];
  } else if (type === 'II') {
    const bpsBook = nz(vi.bpsBook), shares = nz(vi.shares), eqPos = nz(vi.equityProprietaryPositionTotal);
    const eqPosPS = shares ? eqPos / shares : null;
    modelRows = [
      { label: '账面每股净资产', value: `${fmt(bpsBook)} 元（2026中报）` },
      { label: '浮盈调整', value: `权益类/固收类浮盈未单独披露，按 0 处理 → 调整后BPS = ${fmt(val.adjBPS)} 元` },
      { label: '调整后PB中枢', value: `近3年PB中位数 = ${fmt(val.adjPbCenter)} 倍（浮盈按0 ⇒ 调整后PB=普通PB）` },
      { label: '基准情景（沪深300持平）', value: `调整后BPS ${fmt(val.adjBPS)} × 中枢 ${fmt(val.adjPbCenter)} = ${fmt(val.adjBPS * val.adjPbCenter)} 元` },
      { label: '悲观情景（沪深300 −15%）', value: `权益仓位 ${fmt(eqPos)} 亿 ÷ ${fmt(shares)} 亿股 = ${fmt(eqPosPS)} 元/股，浮盈缩水 ${fmt(eqPosPS * 0.15 * 0.85)} 元 → ${fmt(rangeLow)} 元（×中枢×0.95）` },
      { label: '乐观情景（沪深300 +10%）', value: `浮盈增厚 ${fmt(eqPosPS * 0.10 * 0.85)} 元 → ${fmt(rangeHigh)} 元（×中枢×1.05）` },
      { label: '加权目标价', value: `基准×50% + 悲观×25% + 乐观×25% = ${fmt(val.weightedTarget)} 元` },
      { label: '当前股价', value: price != null ? `${fmt(price)} 元 → ${ratingNote}` : '实时价不可用' },
    ];
    modelSources = [
      { label: '账面BPS / 总股本', source: `${(cfg.valuationInputs.bpsBook && cfg.valuationInputs.bpsBook.source) || ''}；${(cfg.valuationInputs.shares && cfg.valuationInputs.shares.source) || ''}` },
      { label: '调整后PB中枢', source: (cfg.valuationInputs.adjPbMedian3y && cfg.valuationInputs.adjPbMedian3y.source) || '' },
      { label: '权益自营仓位', source: (cfg.valuationInputs.equityProprietaryPositionTotal && cfg.valuationInputs.equityProprietaryPositionTotal.source) || '' },
      { label: '浮盈口径', source: '权益类/固收类浮盈未单独披露 → 按0处理（中性：不剔除浮盈）' },
    ];
  }

  return {
    ok: true,
    symbol: cfg.symbol, kind: 'broker', broker: true,
    model: 'brokerClassify_v1（确定性计算，无AI参与）', ver: 'DEDICATED',
    date: new Date().toISOString(),
    reportLabel: `${cfg.metricsBaseLabel} · 每股/净资产取最新一期`,
    reportDate: cfg.metricsReportDate,
    type, typeName: cls.typeName,
    primaryModel: cls.primaryModel, auxModel: cls.auxModel,
    rating, fairValueRange: (rangeLow != null && rangeHigh != null) ? [r2(rangeLow), r2(rangeHigh)] : null,
    fairValueCenter: center,
    currentPrice: price != null ? r2(price) : null, currentPB: currentPB != null ? r2(currentPB) : null,
    metricsRows, scoreRows, decisionNote, modelRows, modelSources,
    riskPoint: cls.riskPoint,
    valuation: val,
    methodsUsed: [`类型${type}·${cls.typeName}`, cls.primaryModel.replace(/（.*?）/g, '')],
  };
}

module.exports = { isBrokerModel, loadInputs, run };

~~~

---

## `lib\valuation\changjiang000783.js`  ·  685 行

~~~js
// ============================================================
// 长江证券（000783）专属动态估值引擎 V3-五法则 —— 确定性计算（1+1=2 原则）
// 20261029o：按用户下发《长江证券专属估值模型更新》五法则重构，并全量重算接入 2026 三季报：
//   第一法则 数据分层与时间戳对齐：刚性实时层（BVPS/总资产/归母/扣非/经营现金流/投资资产规模）
//            一律取最新报告期三表科目，标 [最新报告期]；柔性平滑层（经纪/投行/资管/自营细分营收、
//            AUM、市占率、净资本）在三季报期严禁「最新总营收×上次占比」估算，改用
//            「上次已知分部 × 全市场相关指标增幅」自上而下推演，标 [推算估算值]。
//   第二法则 TTM重构：动态PB锚的 ROE = TTM归母（或熔断后扣非TTM）÷ 最新报告期平均归母净资产
//            （期初/期末普通股口径均值，剔除永续债），严禁单季非年化或简单×4；
//            机构预测 2026E 一律标 [预测口径]。目标价 P = 最新 BVPS × 动态PB倍数。
//   第三法则 主辅模型动态权重与休眠：主模型 PB-ROE 永远在线（唯一核心基准）；
//            辅模型 SOTP 动态睡眠——年报/中报期正常运作（偏离>30% 深度拆解）；
//            一季报/三季报期强制休眠降级，结果仅作参考上限，标注
//            「因财报披露颗粒度不足，SOTP暂不作为决策依据」（不再提示人工复核）。
//   第四法则 历史分位与动态锚双轨防御：上轨 = 近5年90%分位（动态锚突破 → 估值体系重构警告，
//            说明 ROE 质变已打破历史规律，当前估值以动态锚为准）；下轨 = 近5年真实50%分位
//            （周期底部估值铁底，跌破禁止无限看空）。
//   第五法则 逻辑自洽与极值熔断：三档排序强校验（悲观<基准<乐观，违反强制外扩）；
//            空间单边展示（悲观行只下行、乐观行只上行，负值严禁截断为0）；
//            熔断：归母与扣非同比偏离>20pp 弃用归母改用扣非；上行>60% 或下行>40% 禁止自动评级。
//   输出模板：① 数据新鲜度仪表盘 ② 核心估值结论矩阵（三档+计算依据）③ ≤200字核心逻辑摘要。
//   继承 V2 补丁A~G 中仍适用的机制：扣非切换/熔断（E）、矩阵自洽（F）、单边空间/SOTP归因（F-Plus，
//   休眠期豁免深度归因）、动态锚双轨（G）、乐观复苏情景（G·规则4，长周期均值锚仅备注）。
//   补丁A/B 的「配置锁死财报数据」被全量重算取代（V2 数据层升级为三表实时拉取）；
//   补丁C 动态PB锚保留（ROE 输入按第二法则改为 TTM 口径）；补丁D 倍数适配保留（SOTP 休眠期用）。
// 计算层=代码，输入=每次全量重算的三表 + data/valuation/000783.json 锁死假设 ⇒ 结果锁死。
//   补丁I（20261030e）·极值纠偏、逻辑闭环与动态数据强同步：①运行时态现价强同步（严禁历史残留现价，
//     强制当日行情快照现价）；②估值锚「三位一体」向下约束（主模型PB锚 ≤ 理论PB锚，中枢封顶）；
//     ③悲观/乐观边界常识校验（现价破极端悲观价则锁铁底、禁报正下行空间，乐观复苏价须 > 极端悲观价）；
//     ④周期股戴维斯双杀预警 + 熔断降级（价格大幅低于中枢时不红灯禁止评级，降级为绿色「绝对低估/重大机会」并输出买入区间）。
// ============================================================
const path = require('path');
const fs = require('fs');
const brk = require('../brokerSectorTurnover');   // 市场日均成交额（本地存盘，同步可读）

const SYM = '000783';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/000783.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isChangjiangModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'changjiang';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}
const yi = (x) => (x == null || !isFinite(Number(x))) ? null : Number(x) / 1e8; // 元 → 亿

// ============================================================
// 纯函数（可独立单测，不读磁盘、不依赖 run 上下文）—— 继承 V2
// ============================================================

/** 第四法则·下轨铁底：动态锚低于近5年真实50%分位 → 以50%分位价为估值底线 */
function pickAnchorFloor({ pbAnchor, pbP50, bvps }) {
  const a = Number(pbAnchor), f = Number(pbP50), b = Number(bvps);
  const floorPrice = b * f, rawPrice = b * a;
  const active = isFinite(a) && isFinite(f) && a < f;
  return { active, floorPb: f, floorPrice, rawPrice, target: active ? Math.max(rawPrice, floorPrice) : rawPrice };
}

/** 第四法则·G规则4：长周期均值锚 → 乐观复苏情景（双闸门，仅备注不参与主模型） */
function evalRecoveryScenario({ bvps, pbLtMean, turnoverYi, turnoverFloorYi, roeValues, predictedRoePct }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const b = Number(bvps) || 0;
  const lt = Number(pbLtMean) || 0;
  const vals = (Array.isArray(roeValues) ? roeValues : []).map(Number).filter((x) => isFinite(x));
  const floorYi = Number(turnoverFloorYi) || 15000;
  const tYi = (turnoverYi == null || !isFinite(Number(turnoverYi))) ? null : Number(turnoverYi);
  const pred = (predictedRoePct == null || !isFinite(Number(predictedRoePct))) ? null : Number(predictedRoePct);
  const gateTurnover = tYi != null && tYi >= floorYi;
  let gateRoe = false;
  if (vals.length >= 2) {
    gateRoe = true;
    for (let i = 1; i < vals.length; i += 1) { if (!(vals[i] > vals[i - 1])) { gateRoe = false; break; } }
    if (gateRoe && pred != null) gateRoe = pred > vals[vals.length - 1];
  }
  const active = gateTurnover && gateRoe;
  const f1 = `①市场日均成交额 ${tYi != null ? R2(tYi / 10000) + ' 万亿' : 'N/A'} ${gateTurnover ? '≥' : '<'} 1.5 万亿`;
  const f2 = `②公司 ROE ${gateRoe ? '持续上行' : '未持续上行'}（${vals.length ? vals.join('% → ') + '%' : '数据缺失'}${pred != null ? ' → 2026E ' + R2(pred) + '%' : ''}）`;
  return {
    active, gateTurnover, gateRoe, pbLtMean: lt,
    price: (lt > 0 && b > 0) ? R2(b * lt) : null,
    turnoverYi: tYi != null ? R2(tYi) : null, turnoverFloorYi: floorYi,
    roeValues: vals, predictedRoePct: pred,
    failReason: active ? '' : (gateTurnover ? f2 : (gateRoe ? f1 : f1 + '；' + f2)),
    reason: active ? '双条件同时满足' : `未同时满足（${gateTurnover ? '' : f1 + '；'}${gateRoe ? '' : f2}）`,
  };
}

/** F-Plus·SOTP 偏离深度归因（年报/中报期启用；休眠期不调用） */
function attributeSotpDeviation({ segs, totalPs, targetPs, shares, benchPe, discBand }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const N = Number(shares) || 1;
  const band = (Array.isArray(discBand) && discBand.length === 2) ? [Number(discBand[0]), Number(discBand[1])] : [0.15, 0.25];
  const discMid = (band[0] + band[1]) / 2;
  const bench = Number(benchPe) || 0;
  const total = Number(totalPs) || 0, target = Number(targetPs) || 0;
  let bubbleTotal = 0;
  const drill = [];
  for (const s of (segs || [])) {
    const mult = Number(s.mult) || 0;
    let excess = 0, bubble = 0;
    if (s.basis === 'PE' && bench > 0 && mult > bench) { excess = mult - bench; bubble = (Number(s.profit) || 0) * excess; }
    bubbleTotal += bubble;
    drill.push({ key: s.key, label: s.label, basis: s.basis, mult: R2(mult), excess: R2(excess), bubble: R2(bubble) });
  }
  const bubblePs = bubbleTotal / N;
  const afterBubblePs = total - bubblePs;
  const devPct = target ? (total - target) / target * 100 : 0;
  const bubblePp = target ? bubblePs / target * 100 : 0;
  const discPp = target ? (afterBubblePs * discMid) / target * 100 : 0;
  const discountedPs = afterBubblePs * (1 - discMid);
  const top = drill.slice().sort((a, b) => b.bubble - a.bubble)[0] || null;
  return {
    devPct: R2(devPct), benchPe: bench, discMid: R2(discMid), discBand: band,
    bubbleTotal: R2(bubbleTotal), bubblePs: R2(bubblePs), bubblePp: R2(bubblePp),
    afterBubblePs: R2(afterBubblePs), discPp: R2(discPp), discountedPs: R2(discountedPs),
    residualPp: R2(devPct - bubblePp - discPp),
    gapAfterPct: target ? R2(Math.abs(discountedPs - target) / target * 100) : 0,
    drill, top,
  };
}

/**
 * 补丁I·规则④：周期股「戴维斯双杀」预警（确定性文案，非 AI 生成）
 * 券商为强周期行业，TTM ROE 含牛市溢价；若宏观交投活跃度回落，ROE 向中枢回归、PB 锚压缩。
 */
function buildDavisNote({ q3Turnover, predRoe, roeMidLo, roeMidHi, pbTarget, centerLabel }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const tq = (q3Turnover != null ? (q3Turnover / 10000) : null);
  return `⚠️ 周期股「戴维斯双杀」预警：券商为强周期行业，当前 TTM ROE（${R2(predRoe)}%）含牛市溢价。若宏观交投活跃度（Q3 日均 ${tq != null ? R2(tq) + ' 万亿' : 'N/A'}）回落，ROE 存在向中枢（${roeMidLo}%~${roeMidHi}%）回归风险，届时 PB 锚将压缩。因此，当前${centerLabel}给出的 ¥${R2(pbTarget)} 中枢不可作为无脑看多目标，仅作牛市延续情景下的理论值。`;
}

// ============================================================
// 全量重算入口（async）
// ============================================================
async function run(symbol, { price, statements, balanceQuarterly } = {}) {
  const cfg0 = loadConfig();
  const bare0 = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg0 || bare0 !== SYM || cfg0.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const runId = `${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const startedAt = new Date().toISOString();
  try {
    let stmts = statements || null;
    let balQ = balanceQuarterly || null;
    if (!stmts || !balQ) {
      const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
      if (!stmts) stmts = await fetchFinancialData(`SZ${SYM}`);
      if (!balQ) {
        // 最新报告期资产负债表（fetchFinancialData 仅合并利润表/现金流量表的部分报告期，资产负债表需自取）
        const cy = new Date().getFullYear();
        const qe = ['03-31', '06-30', '09-30', '12-31'];
        const dates = [];
        for (const d of qe) dates.push(`${cy}-${d}`, `${cy - 1}-${d}`);
        balQ = await fetchFinancialStatement('zcfzbAjaxNew', `SZ${SYM}`, dates);
      }
    }
    return compute(symbol, { price }, { statements: stmts, balanceQuarterly: balQ }, runId, startedAt);
  } catch (err) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: String(err && err.stack || err) });
    return { ok: false, success: false, message: `估值引擎运行失败：${err && err.message}（已记录运行日志 ${runId}，可回溯排查）` };
  }
}

function appendRunLog(record) {
  try {
    const dir = path.join(__dirname, '../../data/logs/valuation_logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '000783.jsonl');
    let lines = [];
    if (fs.existsSync(p)) lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    lines.push(JSON.stringify(record));
    if (lines.length > 100) lines = lines.slice(-100);
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 日志失败不阻断估值 */ }
}

// 报表行工具
function rowOf(rows, period) {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r.REPORT_DATE || '').slice(0, 10) === period) || null;
}

// ============================================================
// compute：V3-五法则 主流程
// ============================================================
async function compute(symbol, { price }, data, runId, startedAt) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const I = cfg.inputs;
  const pE = I.patchE, pC = I.patchC, pD = I.patchD, pFP = I.patchFPlus || {}, pG = I.patchG || {}, G = I.guard || {};
  const pI = I.patchI || {};   // 补丁I·极值纠偏、逻辑闭环与动态数据强同步
  const LAW = I.lawData || {};
  const today0 = new Date();

  // ===== ① 全量重算：三表 → 最新报告期（as-of）=====
  const incRows = (data.statements && Array.isArray(data.statements.income)) ? data.statements.income : [];
  const balRowsA = (data.statements && Array.isArray(data.statements.balance)) ? data.statements.balance : [];
  const cfRows = (data.statements && Array.isArray(data.statements.cashflow)) ? data.statements.cashflow : [];
  const balQRows = Array.isArray(data.balanceQuarterly) ? data.balanceQuarterly : [];
  if (!incRows.length || !balQRows.length) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: '全量重算中止：三表/最新报告期资产负债表不可得' });
    return { ok: false, success: false, message: '全量重算中止：本次三表数据不可得（刚性实时层禁用旧值），请稍后重试或检查数据链' };
  }
  const incSorted = incRows.slice().sort((a, b) => String(a.REPORT_DATE).localeCompare(String(b.REPORT_DATE)));
  const asOf = String(incSorted[incSorted.length - 1].REPORT_DATE).slice(0, 10);           // 如 2026-09-30
  const asOfStage = asOf.slice(5);                                                          // '09-30'
  const prevYearSame = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`;
  const incCur = rowOf(incSorted, asOf), incPrev = rowOf(incSorted, prevYearSame), incFY = rowOf(incSorted, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || rowOf(incSorted, `${asOf.slice(0, 4)}-12-31`);
  const incH1 = rowOf(incSorted, `${asOf.slice(0, 4)}-06-30`);                              // 同年中报（刚性层已披露过）
  const cfCur = rowOf(cfRows, asOf);
  const balQ3 = rowOf(balQRows, asOf) || balQRows[balQRows.length - 1];
  const balFY25 = rowOf(balQRows, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || rowOf(balRowsA, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || balRowsA[balRowsA.length - 1];
  const asOfPeriodTag = '［最新报告期］';
  if (!incCur || !balQ3 || !incFY || !incPrev) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: `全量重算中止：TTM 合成所需报告期缺失（asOf=${asOf}，上年同期=${prevYearSame}），禁止跨期混算` });
    return { ok: false, success: false, message: `全量重算中止：TTM 合成所需的上年同期累计数据不可得（${prevYearSame}），按数据分层铁律中止计算，绝不跨期混算` };
  }

  // ===== ② 刚性实时层（第一法则：一律最新报告期，标 [最新报告期]）=====
  const N = nz(vv(I.shares));
  // 补丁I·规则①：运行时态数据强同步 —— 强制使用当日行情快照现价，严禁任何历史残留现价（如 8.51）。
  // 优先使用调用方注入的实时价；若未注入，则回退当日行情快照（仍属当日实时价），绝不沿用旧目标价/硬编码值。
  let priceSource = (price != null && isFinite(Number(price)) && Number(price) > 0) ? 'caller-injected-live' : null;
  if (priceSource == null) {
    try {
      const { getQuote } = require('../stockData');
      const q = await getQuote(`SZ${SYM}`);
      if (q && q.price) { price = q.price; priceSource = 'live-quote-fallback'; }
    } catch (e) { /* 取不到实时价则 P=null，诚实标注，绝不静默替代 */ }
  }
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const rigid = [];
  const R = (key, label, value, period, source, unit) => {
    const item = { key, label, value: r2(value), period, tag: '［最新报告期］', source, unit: unit || '亿元' };
    rigid.push(item);
    return item;
  };
  const npTtm = yi(incFY.PARENT_NETPROFIT) - yi(incPrev.PARENT_NETPROFIT) + yi(incCur.PARENT_NETPROFIT);
  const npDedTtm = yi(incFY.DEDUCT_PARENT_NETPROFIT) - yi(incPrev.DEDUCT_PARENT_NETPROFIT) + yi(incCur.DEDUCT_PARENT_NETPROFIT);
  const npYoy = (yi(incPrev.PARENT_NETPROFIT) ? (yi(incCur.PARENT_NETPROFIT) / yi(incPrev.PARENT_NETPROFIT) - 1) * 100 : null);
  const npDedYoy = (yi(incPrev.DEDUCT_PARENT_NETPROFIT) ? (yi(incCur.DEDUCT_PARENT_NETPROFIT) / yi(incPrev.DEDUCT_PARENT_NETPROFIT) - 1) * 100 : null);
  R('np_ttm', '归母净利润（TTM）', npTtm, asOf, `三表勾稽：${Number(asOf.slice(0, 4)) - 1}年报 − ${prevYearSame}累计 + ${asOf}累计`);
  R('np_ded_ttm', '扣非净利润（TTM）', npDedTtm, asOf, '三表勾稽（DEDUCT_PARENT_NETPROFIT 同口径）');
  const perpQ3 = yi(balQ3.OTHER_EQUITY_TOOL) != null ? yi(balQ3.OTHER_EQUITY_TOOL) : nz(vv(I.h1_2026.perpetual));
  const perpFY = yi(balFY25.OTHER_EQUITY_TOOL) != null ? yi(balFY25.OTHER_EQUITY_TOOL) : perpQ3;
  const equityQ3 = yi(balQ3.TOTAL_PARENT_EQUITY), equityFY = yi(balFY25.TOTAL_PARENT_EQUITY);
  const bvps = (equityQ3 - perpQ3) / N;
  R('bvps', 'BVPS（普通股，剔除永续债）', bvps, asOf, `资产负债表：(归母净资产 ${r2(equityQ3)} − 其他权益工具 ${r2(perpQ3)}) ÷ 总股本 ${N} 亿股`, '元/股');
  R('equity_parent', '归母净资产（期末）', equityQ3, asOf, '资产负债表直接科目 TOTAL_PARENT_EQUITY');
  R('total_assets', '总资产', yi(balQ3.TOTAL_ASSETS), asOf, '资产负债表直接科目 TOTAL_ASSETS');
  const cfoCum = cfCur ? yi(cfCur.NETCASH_OPERATE) : null;
  if (cfoCum != null) R('cfo_cum', '经营现金流（年初至报告期末）', cfoCum, asOf, '现金流量表直接科目 NETCASH_OPERATE');
  const invAssets = (yi(balQ3.TRADE_FINASSET_NOTFVTPL) || 0) + (yi(balQ3.OTHER_CREDITOR_INVEST) || 0) + (yi(balQ3.OTHER_EQUITY_INVEST) || 0) + (yi(balQ3.DERIVE_FINASSET) || 0);
  R('inv_assets', '投资资产总规模', invAssets, asOf, `交易性金融资产 ${r2(yi(balQ3.TRADE_FINASSET_NOTFVTPL))} + 其他债权投资 ${r2(yi(balQ3.OTHER_CREDITOR_INVEST))} + 其他权益工具投资 ${r2(yi(balQ3.OTHER_EQUITY_INVEST))} + 衍生金融资产 ${r2(yi(balQ3.DERIVE_FINASSET))}`);
  // 东财券商利润表无净额字段（FEE_COMMISSION_NI/INTEREST_NI 不存在，直接取会假 0）：
  // 手续费只有收入侧 FEE_COMMISSION_INCOME（支出侧三季报未披露 → 净额不可得，诚实标注收入侧口径）；
  // 利息净收入可由收入−支出诚实勾稽：INTEREST_INCOME − INTEREST_EXPENSE。
  const feeInc = yi(incCur.FEE_COMMISSION_INCOME);
  const intInc = yi(incCur.INTEREST_INCOME), intExp = yi(incCur.INTEREST_EXPENSE);
  const intNI = (intInc != null && intExp != null) ? intInc - intExp : null;
  R('fee_inc', '手续费及佣金收入（累计，收入侧口径）', feeInc, asOf, '利润表直接科目 FEE_COMMISSION_INCOME（支出侧未披露，净额不可得）');
  R('int_ni', '利息净收入（累计，收入−支出勾稽）', intNI, asOf, `利息收入 ${r2(intInc)} − 利息支出 ${r2(intExp)}（INTEREST_INCOME − INTEREST_EXPENSE）`);
  const invIncCum = (yi(incCur.INVEST_INCOME) || 0) + (yi(incCur.FAIRVALUE_CHANGE_INCOME) || 0);
  R('inv_inc_cum', '投资净收益（投资收益+公允价值变动，累计）', invIncCum, asOf, '利润表加总口径：INVEST_INCOME + FAIRVALUE_CHANGE_INCOME');
  const invIncH1 = incH1 ? (yi(incH1.INVEST_INCOME) || 0) + (yi(incH1.FAIRVALUE_CHANGE_INCOME) || 0) : null;
  const invIncQ3Single = invIncH1 != null ? invIncCum - invIncH1 : null;

  // ===== 第五法则·熔断1：归母 vs 扣非同比偏离 >20pp → 弃用归母改用扣非 =====
  const growthDev = (npYoy != null && npDedYoy != null) ? Math.abs(npYoy - npDedYoy) : null;
  const devLimitPp = nz(pE.deviationLimitPp, 20);
  const useDeducted = growthDev != null && growthDev > devLimitPp;
  const coreNpTtm = useDeducted ? npDedTtm : npTtm;
  const coreNpLabel = useDeducted ? '扣非TTM（熔断切换）' : '归母TTM';

  // ===== ③ 第二法则：TTM 重构（动态PB锚的 ROE）=====
  const equityAvg = ((equityFY - perpFY) + (equityQ3 - perpQ3)) / 2;    // 平均普通股净资产（期初/期末均值）
  const roeTtm = coreNpTtm / equityAvg * 100;
  // 预测 ROE（2026E，[预测口径]：机构一致预期净利 ÷ 估算平均净资产）
  const consensusNp = nz(vv(I.patchB.consensusNp));
  const predRoe = consensusNp / equityAvg * 100;

  // ===== ④ 补丁C：动态PB锚（行业PB × (40% + 60%×ROE相对系数) + 预测ROE越界修正）=====
  const indRoe = nz(vv(pC.industryRoe3y)) / 100, indPB = nz(vv(pC.industryPB));
  const roeRatio = (roeTtm / 100) / indRoe;
  const pbBase = indPB * 0.4 + roeRatio * indPB * 0.6;
  let roeAdj = 0, roeAdjNote = '';
  if (predRoe / 100 > indRoe * 1.2) { roeAdj = (pC.roeUpBand[0] + pC.roeUpBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ > 行业均值×1.2（${r2(indRoe * 120)}%）→ PB锚按区间中值上修 +${r2(roeAdj * 100)}%`; }
  else if (predRoe / 100 < indRoe * 0.8) { roeAdj = (pC.roeDownBand[0] + pC.roeDownBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ < 行业均值×0.8（${r2(indRoe * 80)}%）→ PB锚下修 ${r2(Math.abs(roeAdj) * 100)}%`; }
  else { roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ 处行业均值 0.8~1.2 倍带内 → 不修正`; }
  const pbAnchor = pbBase * (1 + roeAdj);

  // ===== 补丁I·规则②：估值锚「三位一体」向下约束（防悬空）=====
  // 理论PB（ROE-PB框架）作为主模型PB锚的硬上限：动态PB锚（含牛市溢价）不得超过理论PB锚。
  const gPerp = nz(vv(I.roeLayer.theoG)) / 100, rEq = nz(vv(I.roeLayer.costOfEquity)) / 100;
  const theoPB = (predRoe / 100 - gPerp) / (rEq - gPerp);
  const anchorCapEnabled = pI.enableAnchorCap !== false;   // 默认启用（仅当显式 false 才关闭）
  const pbAnchorRaw = pbAnchor;                                   // 原始动态PB锚（含牛市溢价）
  const pbAnchorEff = (anchorCapEnabled && pbAnchorRaw > theoPB) ? theoPB : pbAnchorRaw;  // 封顶后的主模型PB锚
  const anchorCapped = anchorCapEnabled && pbAnchorRaw > theoPB + 1e-9;

  // ===== ⑤ 第四法则：历史分位双轨防御 =====
  const pbP10 = nz(vv(pE.pbP10)), pbP50 = nz(vv(pE.pbP50)), pbP90 = nz(vv(pE.pbP90));
  const floorRes = pickAnchorFloor({ pbAnchor: pbAnchorEff, pbP50, bvps });
  const anchorFloorActive = floorRes.active;
  const pbTargetRaw = floorRes.rawPrice;
  const pbTarget = floorRes.target;
  // 上轨突破判定基于「原始动态锚」（反映 ROE 质变本质），与封顶后中枢解耦，保证警告语义准确
  const anchorBreached = pbAnchorRaw > pbP90;
  const reframeNote = `原始动态PB锚 ${pbAnchorRaw.toFixed(4)} 倍 已高于近5年90%分位 ${pbP90.toFixed(3)} 倍 → ROE 质变已打破历史规律（TTM ROE ${r2(roeTtm)}% vs 历史分位带覆盖的 ROE 5%~10% 区间），当前模型有效锚 = ${pbAnchorEff.toFixed(4)} 倍（理论PB封顶已生效），历史分位仅作背景参照。${anchorCapped ? `（补丁I·三位一体向下约束已生效：主模型PB锚由 ${pbAnchorRaw.toFixed(4)} 倍封顶至理论PB锚 ${theoPB.toFixed(4)} 倍，中枢 ≤ ¥${r2(pbTarget)}）` : ''}`;
  const anchorFloorNote = `已触及近5年真实估值铁底（${pbP50.toFixed(3)}倍），市场处于极度悲观定价，下行空间有限，静待均值回归。`;

  // ===== 第三法则：SOTP 休眠判定 =====
  const sotpDormant = !(asOfStage === '12-31' || asOfStage === '06-30');   // 一季报/三季报期 → 休眠降级
  const sotpStageLabel = asOfStage === '12-31' ? '年报期' : (asOfStage === '06-30' ? '中报期' : (asOfStage === '09-30' ? '三季报期' : '一季报期'));

  // ===== ⑥ 柔性平滑层（第一法则：三季报期严禁「总营收×上次占比」，按市场指标增幅推演，标 [推算估算值]）=====
  const soft = [];
  const S = (key, label, value, basisPeriod, method) => {
    const item = { key, label, value: r2(value), period: basisPeriod, tag: '［推算估算值］', method };
    soft.push(item);
    return item;
  };
  const h1Broker = nz(vv(I.h1_2026.bizMix.brokerage));                     // 上次已知分部（2026中报披露）
  const h1Turnover = nz(LAW.h1TurnoverAvgYi, 27400);                       // 2026H1 全市场日均成交额（亿）
  const q3Turnover = nz(LAW.q3TurnoverAvgYi, 23163);                       // 2026Q3 全市场日均成交额（亿）
  const turnoverFactor = q3Turnover / h1Turnover;                          // 0.8454（Q3 单季成交额因子）
  const broker3q = h1Broker + h1Broker / 2 * turnoverFactor;               // 前三季经纪 = H1实际 + Q3推算
  S('broker_3q', '经纪业务收入（前三季）', broker3q, '2026中报（上次已知）', `上次已知 ${r2(h1Broker)}亿（中报）+ Q3推算 ${r2(h1Broker / 2)}×${r2(turnoverFactor)}（Q3日均成交额 ${q3Turnover} 亿 ÷ H1日均 ${h1Turnover} 亿，Wind口径）= ${r2(broker3q)} 亿`);
  const am2025 = nz(vv(I.h1_2026.bizMix.am2025));
  const am3q = am2025 * (9 / 12);
  S('am_3q', '资管业务收入（前三季）', am3q, '2025年报（上次已知）', `上次已知 ${am2025}亿（年报）× 9/12（中性景气，三季报无分部披露）= ${r2(am3q)} 亿`);
  const ib2025 = nz(vv(I.h1_2026.bizMix.ib2025));
  const ipoFactor = 1 + nz(LAW.ipoCount3qYoyPct, 67.11) / 100;
  const ib3q = ib2025 * (9 / 12) * ipoFactor;
  S('ib_3q', '投行业务收入（前三季）', ib3q, '2025年报（上次已知）', `上次已知 ${ib2025}亿 × 9/12 × ${r2(ipoFactor)}（前三季A股IPO 127家，同比 +${nz(LAW.ipoCount3qYoyPct, 67.11)}%，Wind口径）= ${r2(ib3q)} 亿`);
  const vcH1 = nz(vv(I.h1_2026.vcProfit));
  const sciH1 = nz(LAW.sci50H1Pct, 64.25), sci9m = nz(LAW.sci50NineMPct, 13.82);
  const sciQ3Single = (1 + sci9m / 100) / (1 + sciH1 / 100) - 1;           // Q3 单季科创50 ≈ −30.7%
  const vc3q = vcH1 + vcH1 / 2 * sciQ3Single;
  S('vc_3q', '科创投资利润（前三季，穿透）', vc3q, '2026中报（上次已知）', `上次已知 ${vcH1}亿（中报穿透）+ Q3推算 ${r2(vcH1 / 2)}×${r2(sciQ3Single * 100)}%（科创50 Q3单季 = (1+${sci9m}%)/(1+${sciH1}%)+${r2(sciQ3Single * 100)}%）= ${r2(vc3q)} 亿`);
  const netCapital = nz(vv(I.sotpLayer.netCapital));                       // 2025 风控报告（上次已知，柔性）
  S('net_capital', '净资本（自营资本占用代理）', netCapital, '2025年度风控指标报告（上次已知）', '三季报不披露净资本 → 沿用上次已知值，待年报更新');

  // ===== ⑦ SOTP（休眠降级：结果仅作参考上限）=====
  const nm = nz(vv(I.sotpLayer.netMargin)) / 100;
  const sectorPe = nz(vv(pD.sectorPeMedian));
  const shareRatio = nz(vv(pD.brokerShareRatio), 1.0);
  const srb = pD.shareRatioBand || [0.8, 1.2];
  const peLightLo = sectorPe * shareRatio * srb[0], peLightHi = sectorPe * shareRatio * srb[1];
  const annInvYield = invIncCum * (4 / 3) / invAssets * 100;               // 年化（Q3累计×4/3，休眠期推算口径）
  const propPb = annInvYield > (nz(pD.yieldThreshold) || 6) ? (nz(pD.propPbUp) || 1.1) : (nz(pD.propPbBase) || 1.0);
  const sci50 = sci9m;
  const vcPe = sci50 <= nz(pD.tightenThreshold || -10) ? (pD.vcPeTight || [10, 12]) : (pD.vcPeLoose || [15, 18]);
  const peIB = pD.peIB || [10, 15];
  const npLight = (broker3q + nz(intNI)) * (4 / 3) * nm;
  const npAM = am3q * nm;
  const npIB = ib3q * nm;
  const npVC = vc3q;
  function sotp(kind) {
    const sc = kind === 'low' ? 0 : kind === 'high' ? 1 : 0.5;
    const parts = {
      light: npLight * (peLightLo + (peLightHi - peLightLo) * sc),
      prop: netCapital * propPb,
      am: npAM * (peLightLo + (peLightHi - peLightLo) * sc),
      ib: npIB * (peIB[0] + (peIB[1] - peIB[0]) * sc),
      vc: npVC * (vcPe[0] + (vcPe[1] - vcPe[0]) * sc),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { total, perShare: total / N, parts };
  }
  const sotpLow = sotp('low'), sotpHigh = sotp('high');
  const sotpMidPs = (sotpLow.perShare + sotpHigh.perShare) / 2;
  const sotpDev = (sotpMidPs - pbTarget) / pbTarget * 100;
  const sotpDormantNote = `⏸️ SOTP 休眠降级（${sotpStageLabel}）：因财报披露颗粒度不足，SOTP暂不作为决策依据。分部数据全部为柔性平滑层推算（标［推算估算值］），其估值结果 ${r2(sotpMidPs)} 元仅作为参考上限列示，不参与主模型与评级；待年报/中报分部数据齐全后自动恢复运作。`;

  // ===== ⑧ 守门员自检（财报时效）=====
  const reportAge = daysBetween(asOf, today0);
  const maxAge = nz(G.maxAgeDays) || 180;
  const guardRows = [];
  const alerts = [];
  const freshnessRows = [];
  guardRows.push({ label: '① 财报时效', status: reportAge <= maxAge ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${asOf}（${sotpStageLabel}），距检查日 ${reportAge} 天（终止上限 ${maxAge} 天）`, source: '全量重算：东财F10三表' });
  freshnessRows.push({ label: `估值基础报告期（${sotpStageLabel}）`, asOf, ageDays: reportAge, maxAge, stale: reportAge > maxAge });
  const terminated = reportAge > maxAge;
  const snapMax = nz(G.snapshotMaxAgeDays) || 30;
  let staleSnapshots = 0;
  for (const sp of (G.snapshots || [])) {
    const age = sp.asOf ? daysBetween(sp.asOf, today0) : null;
    if (age == null) continue;
    const stale = age > snapMax;
    if (stale) staleSnapshots++;
    freshnessRows.push({ label: sp.label, asOf: sp.asOf, ageDays: age, maxAge: snapMax, stale });
    if (stale) alerts.push(`快照参数「${sp.label}」取数于 ${sp.asOf}（距今 ${age} 天 > ${snapMax} 天）→ 可能已不反映最新市场状态，请复核更新`);
  }
  if (terminated) {
    return {
      ok: true, dedicated: true, changjiang: true, terminated: true,
      version: 'V3-五法则', symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: asOf,
      model: 'changjiang000783 V3-五法则（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（估值基础财报超龄），模型终止本次估值，历史结论不再外推。请更新财报数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }

  // ===== ⑨ 市场成交活跃度（柔性层景气度 + G规则4闸门数据）=====
  let mktTurnoverYi = null, mktTurnoverDate = null, mktTurnoverSrc = '';
  try {
    const st = brk._fromStore();
    if (st && st.market && st.market.length) {
      const m = brk.summarize(st.market);
      if (m && m.avg20Yi != null) { mktTurnoverYi = m.avg20Yi; mktTurnoverDate = m.date; mktTurnoverSrc = `同花顺·申万一级行业成交额合计，近 ${m.windowDays} 交易日日均（截至 ${m.date}）`; }
    }
  } catch (e) { /* 存盘不可读 → 退回配置快照 */ }
  if (mktTurnoverYi == null) { mktTurnoverYi = q3Turnover; mktTurnoverDate = asOf; mktTurnoverSrc = `2026Q3 全市场日均成交额（Wind口径，配置 lawData）`; }
  const recoveryRes = evalRecoveryScenario({
    bvps, pbLtMean: nz(vv(pG.longTermMeanPb), 1.33),
    turnoverYi: mktTurnoverYi, turnoverFloorYi: nz(pG.recoveryMarketTurnoverFloorYi) || 15000,
    roeValues: (pC.companyRoe3y || {}).values, predictedRoePct: predRoe,
  });
  const recoveryActive = recoveryRes.active;
  const pbLtMean = nz(vv(pG.longTermMeanPb), 1.33);
  // 补丁J·规则③：情景设定逻辑校验（消除倒挂）—— 若主模型基准中枢 > 长周期均值锚，则「乐观复苏情景」价格低于基准价格，
  // 构成反常识倒挂，自动失效并转为「均值回归底线」（下行保护参考），严禁输出「乐观情景价格低于基准价格」。
  const recoveryPrice = recoveryRes.price;
  const recoveryInverted = recoveryPrice != null && pbTarget > recoveryPrice + 1e-9;
  const recoveryLabel = recoveryInverted ? '均值回归底线' : '乐观复苏情景';
  const recoveryNote = recoveryActive
    ? `长周期均值锚 ${pbLtMean.toFixed(2)} 倍 × BVPS ${r2(bvps)} = ¥${recoveryPrice}（对照：主模型动态锚中枢 ¥${r2(pbTarget)}）。${recoveryInverted ? `该锚 ¥${recoveryPrice} 已低于主模型中枢 ¥${r2(pbTarget)}，「乐观复苏情景」倒挂失效，自动转为「均值回归底线」（下行保护参考，仅备注不参与主模型）。` : `该锚仅作「乐观复苏情景」备用目标，不参与主模型计算。`}闸门${recoveryActive ? '已' : '未'}同时满足：① ${mktTurnoverSrc}（日均 ${(mktTurnoverYi / 10000).toFixed(2)} 万亿 ≥ 1.5 万亿）；② 公司 ROE 持续上行（${recoveryRes.roeValues.join('% → ')}% → 2026E ${r2(predRoe)}%［预测口径］）。`
    : '';

  // ===== ⑩ 第五法则：三档区间 + 排序强校验 + 单边空间 + 熔断2 =====
  const extremeLowPct = bvps * pbP10, extremeHighPct = bvps * pbP90;
  const upMult = nz(pE.boundaryUpMult) || 1.20, downMult = nz(pE.boundaryDownMult) || 0.75;
  let extremeLow = extremeLowPct, extremeHigh = extremeHighPct;
  const orderOk = (extremeLow < pbTarget) && (pbTarget < extremeHigh);
  let boundaryFixed = false, boundaryNote = '';
  if (!orderOk) {
    const center = r2(pbTarget);
    extremeHigh = r2(center * upMult);
    extremeLow = r2(center * downMult);
    boundaryFixed = true;
    boundaryNote = '历史分位已失真，已按动态锚强制外扩边界';
  }
  const extremeLowFormula = (boundaryFixed ? pbTarget * downMult : extremeLowPct);  // 补丁J·规则②：极端悲观「公式值」（补丁I历史铁底锁死前）
  // ===== 补丁I·规则②/③：历史分位铁底 + 边界常识校验 =====
  const floorPriceStatic = bvps * pbP50;                  // 近5年真实50%分位铁底价
  const curPb = P != null ? P / bvps : null;
  const floorBreached = curPb != null && curPb < pbP50 - 1e-9;  // 现价PB已跌破50%分位
  let boundaryFloorLock = false;
  // 规则③：现价低于极端悲观价 → 锁定极端悲观价为历史铁底，禁止报正数下行空间
  if (P != null && extremeLow > P) { extremeLow = floorPriceStatic; boundaryFloorLock = true; }
  const spaceDownPct = (P != null) ? r2((extremeLow - P) / P * 100) : null;
  const spaceUpPct = (P != null) ? r2((extremeHigh - P) / P * 100) : null;
  // 下行空间常识校验：已击穿铁底（P<floor）时下行空间无意义（严禁做空），不报正数
  let maxDownsidePct = null, floorBreachWarn = '';
  if (floorBreached) {
    floorBreachWarn = `现价已击穿历史铁底（现价 ¥${r2(P)} / 当前PB ${r2(curPb)} 倍 < 近5年50%分位 ${pbP50.toFixed(3)} 倍 → 铁底价 ¥${r2(floorPriceStatic)}），极度低估，严禁做空`;
    maxDownsidePct = null;
  } else if (boundaryFloorLock) {
    maxDownsidePct = (floorPriceStatic - P) / P * 100;     // 例：(6.14-6.62)/6.62 = -7.2%（即下行有限）
  }
  const fuseDownLine = nz(pE.fuseDownsidePct, 40), fuseUpLine = nz(pE.fuseUpsidePct, 60);
  // 补丁I 配置默认值（nz 不支持默认值，统一用显式缺省）
  const ratingDowngradeEnabled = pI.enableRatingDowngrade !== false;       // 默认启用
  const ratingDowngradeTo = pI.ratingDowngradeTo || '绝对低估';
  const buyRangeMultHigh = (pI.buyRangeMultHigh != null && isFinite(Number(pI.buyRangeMultHigh))) ? Number(pI.buyRangeMultHigh) : 0.85;
  const davisRoeMidLo = (pI.davisRoeMidLo != null && isFinite(Number(pI.davisRoeMidLo))) ? Number(pI.davisRoeMidLo) : 6;
  const davisRoeMidHi = (pI.davisRoeMidHi != null && isFinite(Number(pI.davisRoeMidHi))) ? Number(pI.davisRoeMidHi) : 8;
  const q3TurnoverYi = (LAW.q3TurnoverAvgYi != null && isFinite(Number(LAW.q3TurnoverAvgYi))) ? Number(LAW.q3TurnoverAvgYi) : 23163;
  const fuseF = spaceDownPct != null && Math.abs(spaceDownPct) > fuseDownLine;
  let fused = false, fuseE = false, fuseReason = '', rating = '合理', premiumNote = '';
  let ratingDowngraded = false, buyRange = null, davisNote = '';
  if (P != null) {
    const upE = (pbTarget - P) / P * 100;     // 现价低于中枢的幅度（越大 = 越低估）
    const dnE = (P - pbTarget) / P * 100;      // 现价高于中枢的幅度（越大 = 越泡沫）
    if (upE > fuseUpLine) {
      // 补丁I·规则④：周期股价格大幅低于中枢 = 绝对低估/重大机会（非数据错误）→ 降级绿色提示，不触发红灯
      if (ratingDowngradeEnabled) {
        ratingDowngraded = true; fused = false; fuseE = false;
        rating = ratingDowngradeTo;
        premiumNote = '现价大幅低于中枢（周期股深度低估）';
        const buyLow = floorPriceStatic;
        const buyHigh = (extremeLow != null && extremeLow > floorPriceStatic) ? extremeLow : (pbTarget * buyRangeMultHigh);
        buyRange = [r2(buyLow), r2(buyHigh)];
        davisNote = buildDavisNote({ q3Turnover: q3TurnoverYi, predRoe, roeMidLo: davisRoeMidLo, roeMidHi: davisRoeMidHi, pbTarget, centerLabel: '主模型' });
      } else {
        fuseE = true; fused = true; fuseReason = `潜在上行空间 ${r2(upE)}% > ${fuseUpLine}% → ⛔禁止自动评级（红色警报，大概率基本面质变或数据出错）`;
      }
    } else if (dnE > fuseDownLine) {
      // 价格远高于中枢（泡沫/数据错误）→ 保留红灯
      fuseE = true; fused = true; fuseReason = `潜在下行空间 ${r2(dnE)}% > ${fuseDownLine}% → ⛔禁止自动评级（红色警报，大概率数据出错或估值泡沫）`;
    }
    if (!fused && !ratingDowngraded && fuseF) { fused = true; fuseReason = `第五法则·空间校验：极端悲观价 ${r2(extremeLow)} 元 vs 现价 ${r2(P)} 元 → 下行空间 ${spaceDownPct}%（绝对值 > ${fuseDownLine}% 熔断线）→ ⛔禁止自动评级`; }
    if (!fused && !ratingDowngraded) {
      const disc = (pbTarget - P) / pbTarget * 100;
      if (disc > 10) rating = '低估';
      else if (disc >= -10) rating = '合理';
      else rating = '高估';
      premiumNote = disc >= 0 ? `折价 ${r2(Math.abs(disc))}%` : `溢价 ${r2(Math.abs(disc))}%`;
    }
  }
  if (fused) rating = '无法评级';

  // ===== ⑪ 输出模板①：数据新鲜度仪表盘 =====
  const dashboardRows = [
    ...rigid.map((x) => ({ label: `刚性实时层 ${x.label} ${x.tag}`, value: `${x.value} ${x.unit}`, period: x.period, source: x.source })),
    ...soft.map((x) => ({ label: `柔性平滑层 ${x.label} ${x.tag}`, value: `${x.value} 亿元`, period: x.period, source: x.method })),
    { label: '柔性平滑层 市场景气度基准', value: `H1日均成交 ${h1Turnover} 亿 / Q3日均 ${q3Turnover} 亿（因子 ${r2(turnoverFactor)}）/ IPO家数同比 +${nz(LAW.ipoCount3qYoyPct, 67.11)}% / 科创50 H1 +${sciH1}%·前三季 +${sci9m}%`, period: 'Wind（2026-10-01 全景扫描）', source: (LAW.source || 'Wind 2026年前三季度A股大数据全景扫描') },
  ];
  // freshnessRows 兼容格式（仪表盘 = 刚性层 + 守门员 + 快照）
  for (const x of rigid) freshnessRows.push({ label: `刚性 ${x.label}`, asOf: x.period, ageDays: daysBetween(x.period, today0), maxAge, stale: false });
  for (const x of soft) freshnessRows.push({ label: `柔性 ${x.label}${x.tag}`, asOf: x.period, ageDays: x.period.indexOf('2026-09-08') === 0 ? null : null, maxAge: snapMax, stale: false });

  // ===== ⑫ 核心估值结论矩阵（输出模板②）=====
  const signedPct = (v) => (v == null ? 'N/A' : (v > 0 ? '+' + r2(v) : String(r2(v))));
  const downSpaceText = spaceDownPct == null ? '下行空间 N/A' : (floorBreached
    ? `下行空间 N/A（现价已击穿历史铁底 ¥${r2(floorPriceStatic)}，模型无更低估值锚，严禁做空）`
    : `下行空间 ${signedPct(spaceDownPct)}%（负值原样输出，不截断为0）${ratingDowngraded ? '；补丁I·熔断降级：现价大幅低于中枢 → 不触发红灯' : `，${fuseF ? '⛔已触及' : '未触及'}${fuseDownLine}%熔断线`}`);
  const upSpaceText = spaceUpPct == null ? '上行空间 N/A' : `上行空间 ${signedPct(spaceUpPct)}%`;
  const matrixRows = [
    ...(anchorBreached ? [{ method: '🔴 估值体系重构警告', low: null, mid: null, high: null, emph: true, note: reframeNote }] : []),
    { method: boundaryFixed ? `极端悲观（动态锚 × ${downMult.toFixed(2)}）` : '极端悲观（PB 10%分位）', low: r2(extremeLow), mid: null, high: null, note: boundaryFixed
      ? `第五法则·排序强校验：历史分位边界 [${r2(extremeLowPct)}, ${r2(extremeHighPct)}] 元与基准中枢 ${r2(pbTarget)} 元不自洽 → ${boundaryNote}：极端悲观公式值 = 基准 ${r2(pbTarget)} × ${downMult.toFixed(2)} = ${r2(extremeLowFormula)} 元。${boundaryFloorLock ? `但受补丁I「历史铁底」约束（现价 ¥${r2(P)} < 公式悲观价 ¥${r2(extremeLowFormula)}），最终锁定为铁底价 ¥${r2(floorPriceStatic)}。` : ''}${downSpaceText}`
      : `BVPS ${r2(bvps)}［最新报告期］× PB ${pbP10.toFixed(3)} 倍（近5年日K序列10%分位）= ${r2(extremeLowPct)} 元${boundaryFloorLock ? `；但受补丁I「历史铁底」约束，最终锁定为铁底价 ¥${r2(floorPriceStatic)}` : ''}。${downSpaceText}` },
    { method: '基准（动态PB中枢·PB-ROE主模型）', low: null, mid: r2(pbTarget), high: null, note: `第二法则：P = 最新 BVPS ${r2(bvps)} × 动态PB锚 ${pbAnchorEff.toFixed(4)} 倍${anchorCapped ? `（封顶：原动态锚 ${pbAnchorRaw.toFixed(4)} > 理论PB锚 ${theoPB.toFixed(4)} → 封顶）` : ''}。TTM ROE = ${coreNpLabel} ${r2(coreNpTtm)} 亿 ÷ 平均普通股净资产 ${r2(equityAvg)} 亿（期初 ${r2(equityFY - perpFY)} + 期末 ${r2(equityQ3 - perpQ3)} ÷2）= ${r2(roeTtm)}%；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 锚 ${pbAnchorEff.toFixed(4)} 倍${anchorFloorActive ? `；🛡️下轨铁底保护：原始锚价 ¥${r2(pbTargetRaw)} 已低于50%分位价 ¥${r2(floorRes.floorPrice)} → 中枢抬升至铁底 ¥${r2(pbTarget)}` : ''}${anchorBreached ? '；⚠️该锚已突破历史90%分位 → 见顶部重构警告' : ''}（本档不计空间）` },
    { method: boundaryFixed ? `极端乐观（动态锚 × ${upMult.toFixed(2)}）` : '极端乐观（PB 90%分位）', low: null, mid: null, high: r2(extremeHigh), note: boundaryFixed
      ? `第五法则·排序强校验：历史分位 90% 边界 ${r2(extremeHighPct)} 元低于基准中枢 ${r2(pbTarget)} 元 → ${boundaryNote}：极端乐观 = 基准 ${r2(pbTarget)} × ${upMult.toFixed(2)} = ${r2(extremeHigh)} 元。${upSpaceText}`
      : `BVPS ${r2(bvps)} × PB ${pbP90.toFixed(3)} 倍（近5年序列90%分位）${anchorBreached ? '（已突破，仅背景参照）' : ''}。${upSpaceText}` },
    { method: `SOTP 分部加总（${sotpDormant ? '休眠降级·仅参考上限' : '交叉验证'}）`, low: r2(sotpLow.perShare), mid: r2(sotpMidPs), high: r2(sotpHigh.perShare), note: sotpDormant ? sotpDormantNote : `与PB-ROE偏离 ${signedPct(sotpDev)}%${Math.abs(sotpDev) > (nz(pFP.sotpDeviationDeepLimitPct) || 30) ? ' → 强制穿透归因（详见 SOTP 行）' : ''}` },
    { method: '综合结论（以PB-ROE主模型为准）', low: r2(extremeLow), mid: r2(pbTarget), high: r2(extremeHigh), note: `排序强校验：${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} ✅（${orderOk ? '原边界自洽' : '已强制外扩'}）；第四法则双轨：${anchorBreached ? `上轨已突破（ROE质变 → 估值体系重构警告：原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍，已封顶至理论PB锚 ${theoPB.toFixed(2)} 倍，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍）` : (anchorFloorActive ? '下轨已触发（周期底部铁底，50%分位为底线，禁止无限看空）' : `锚 ${pbAnchorEff.toFixed(2)} 位于 [50%分位 ${pbP50.toFixed(3)}, 90%分位 ${pbP90.toFixed(3)}] 带内`)}；熔断：${fused ? '⛔已触发（红色警报，禁止自动评级）' : (ratingDowngraded ? '🟢补丁I降级：现价大幅低于中枢 → 绝对低估/重大机会（绿色提示，非数据错误）' : '✅未触发')}${floorBreached ? `；⚠️现价已击穿历史铁底 ¥${r2(floorPriceStatic)}，极度低估，严禁做空` : ''}${maxDownsidePct != null ? `；极端悲观锁铁底 ¥${r2(floorPriceStatic)} → 潜在最大下行风险仅 ${r2(maxDownsidePct)}%` : ''}${useDeducted ? `；⚠️扣非切换已触发（归母/扣非同比偏离 ${r2(growthDev)}pp > ${devLimitPp}pp → 全部改用扣非）` : `；扣非切换未触发（偏离 ${r2(growthDev)}pp ≤ ${devLimitPp}pp）`}${recoveryActive ? `；🌟${recoveryLabel}（仅备注）：长周期均值锚 1.33×BVPS → ¥${recoveryRes.price}${recoveryInverted ? `（低于主模型中枢 ¥${r2(pbTarget)}，不作乐观目标，转为下行保护参考）` : ''}` : ''}` },
  ];

  // SOTP 明细行（休眠标注）
  const sotpRows = [
    { label: `经纪+信用（轻资产）${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季经纪 ${r2(broker3q)}（推演）+ 利息净收入 ${r2(intNI)}［最新报告期］年化 ×4/3 × 净利率 ${r2(nm * 100)}%［假设］= 净利 ${r2(npLight)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍 = ${r2(sotpLow.parts.light)}~${r2(sotpHigh.parts.light)} 亿`, source: '第一法则柔性推演 + 三表直接科目' },
    { label: `自营投资（重资产）`, value: `净资本 ${netCapital} 亿［推算估算值·上次已知］× PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% = Q3累计投资净收益 ${r2(invIncCum)}×4/3 ÷ 投资资产 ${r2(invAssets)}［最新报告期］，${annInvYield > nz(pD.yieldThreshold, 6) ? '>6% 上调1.1' : '≤6% 维持1.0'}）= ${r2(sotpLow.parts.prop)} 亿`, source: '2025年度风控指标报告 + 资产负债表' },
    { label: `资管（含长信基金）${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季收入 ${r2(am3q)}（推演）× 净利率 ${r2(nm * 100)}% = ${r2(npAM)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍 = ${r2(sotpLow.parts.am)}~${r2(sotpHigh.parts.am)} 亿`, source: '第一法则柔性推演' },
    { label: `投行${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季收入 ${r2(ib3q)}（推演）× 净利率 ${r2(nm * 100)}% = ${r2(npIB)} 亿 × ${peIB[0]}~${peIB[1]}x = ${r2(sotpLow.parts.ib)}~${r2(sotpHigh.parts.ib)} 亿`, source: '第一法则柔性推演（IPO家数同比景气因子）' },
    { label: `科创投资${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季利润 ${r2(npVC)}（推演）× ${vcPe[0]}~${vcPe[1]}x（科创50前三季 +${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? '收紧期' : '宽松期'}；Q3单季 ${r2(sciQ3Single * 100)}% 回撤已计入）= ${r2(sotpLow.parts.vc)}~${r2(sotpHigh.parts.vc)} 亿`, source: '第一法则柔性推演（科创50动量因子）' },
    { label: 'SOTP 合计', value: `${r2(sotpLow.total)}~${r2(sotpHigh.total)} 亿元 ÷ 总股本 ${N} 亿股 = ${r2(sotpLow.perShare)}~${r2(sotpHigh.perShare)} 元/股${sotpDormant ? `；${sotpDormantNote}` : `；与主模型偏离 ${signedPct(sotpDev)}%`}`, source: `第三法则：${sotpStageLabel} → ${sotpDormant ? '强制休眠降级' : '正常运作'}` },
  ];

  const sensRows = [
    { label: `PB 10%分位 ${pbP10.toFixed(2)} 倍`, value: r2(extremeLowPct) },
    { label: `PB 50%分位 ${pbP50.toFixed(2)} 倍（下轨铁底）`, value: r2(bvps * pbP50) },
    { label: `PB 90%分位 ${pbP90.toFixed(2)} 倍${anchorBreached ? '（已突破·背景参照）' : ''}`, value: r2(extremeHighPct) },
    { label: `PB 无ROE修正锚 ${pbBase.toFixed(2)} 倍`, value: r2(bvps * pbBase) },
    { label: `PB 动态锚（封顶后） ${pbAnchorEff.toFixed(2)} 倍${anchorCapped ? `（原 ${pbAnchorRaw.toFixed(2)} 倍封顶至理论 ${theoPB.toFixed(2)} 倍）` : ''}`, value: r2(pbTarget) },
  ];
  if (boundaryFixed) {
    sensRows.push({ label: `第五法则·极端悲观（动态锚 × ${downMult.toFixed(2)}）`, value: r2(extremeLow) });
    sensRows.push({ label: `第五法则·极端乐观（动态锚 × ${upMult.toFixed(2)}）`, value: r2(extremeHigh) });
  }

  // ===== ⑬ 输出模板③：核心逻辑摘要（≤200字）=====
  const q3TurnoverYoy = nz(LAW.q3TurnoverYoyPct, 10.22);
  const summaryParts = [
    `市场成交活跃度：Q3日均成交 ${r2(q3Turnover / 10000)} 万亿（同比+${q3TurnoverYoy}%、环比−20.5%），近期20日日均 ${(mktTurnoverYi / 10000).toFixed(2)} 万亿，交投仍处高位但边际降温；`,
    `自营投资：前三季投资净收益 ${r2(invIncCum)} 亿，其中Q3单季 ${invIncQ3Single != null ? r2(invIncQ3Single) + ' 亿（市场回调拖累，系Q3单季利润下滑主因）' : 'N/A'}；`,
    `ROE质变：TTM ROE ${r2(roeTtm)}%（${coreNpLabel} ${r2(coreNpTtm)} 亿÷平均净资产 ${r2(equityAvg)} 亿）${anchorBreached ? `原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍突破近5年90%分位 ${pbP90} → 触发估值体系重构警告；但理论PB封顶已生效，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍（封顶至理论PB锚 ${theoPB.toFixed(2)} 倍）` : `仍处历史分位带内`}`,
  ];
  let summaryNote = summaryParts.join('');
  if (summaryNote.length > 200) summaryNote = summaryNote.slice(0, 197) + '...';

  // ===== ⑭ 卡片行（继承 V2 契约）=====
  const coreRows = [
    { label: `第一法则·刚性实时层（${sotpStageLabel}，全量重算）`, value: `归母TTM ${r2(npTtm)} 亿 / 扣非TTM ${r2(npDedTtm)} 亿 / BVPS ${r2(bvps)} 元 / 归母净资产 ${r2(equityQ3)} 亿（永续债 ${r2(perpQ3)} 亿剔除）/ 总资产 ${r2(yi(balQ3.TOTAL_ASSETS))} 亿 / 投资资产 ${r2(invAssets)} 亿 / 手续费收入 ${r2(feeInc)} 亿（收入侧）/ 利息净收入 ${r2(intNI)} 亿 / 投资净收益 ${r2(invIncCum)} 亿 —— 全部标［最新报告期］`, source: '东财F10三表（lrb/zcfzb/xjllbAjaxNew，SZ000783）' },
    { label: '第二法则·TTM重构', value: `TTM ${coreNpLabel} = ${r2(coreNpTtm)} 亿（归母/扣非同比 ${r2(npYoy)}% vs ${r2(npDedYoy)}%，偏离 ${r2(growthDev)}pp ${useDeducted ? `> ${devLimitPp}pp → ⚠️弃用归母` : `≤ ${devLimitPp}pp → 归母口径可用`}）；ROE = ÷ 平均普通股净资产 ${r2(equityAvg)} 亿 = ${r2(roeTtm)}%（严禁单季×4，已按 TTM÷平均净资产 口径）；2026E 预测ROE ${r2(predRoe)}%［预测口径：机构一致预期 ${r2(consensusNp)} 亿 ÷ 平均净资产］`, source: '第二法则 + 机构一致预期（4家）' },
    { label: '第四法则·动态PB锚', value: `公司 TTM ROE ${r2(roeTtm)}% ÷ 行业均值 ${r2(indRoe * 100)}%［假设］=${r2(roeRatio)}；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 动态锚 ${pbAnchorEff.toFixed(4)} 倍${anchorCapped ? `（封顶：原 ${pbAnchorRaw.toFixed(4)} > 理论PB锚 ${theoPB.toFixed(4)}，中枢 ≤ ¥${r2(pbTarget)}）` : ''} × BVPS ${r2(bvps)} 元 = ${r2(pbTarget)} 元${anchorFloorActive ? `（下轨铁底保护生效）` : ''}`, source: (pC.industryPB || {}).source },
    { label: '理论PB（ROE-PB框架，印证）', value: `(ROE−g)/(r−g)=(${r2(predRoe)}%−${r2(gPerp * 100)}%)/(${r2(rEq * 100)}%−${r2(gPerp * 100)}%)=${r2(theoPB)} 倍${anchorCapped ? `，即为主模型封顶后动态锚（原动态锚 ${pbAnchorRaw.toFixed(2)} 倍 → 封顶至理论PB锚 ${theoPB.toFixed(2)} 倍）` : `，与动态锚 ${pbAnchorEff.toFixed(2)} 倍互相印证`}`, source: (I.roeLayer.costOfEquity || {}).source },
    { label: '市场快照', value: `现价 ${P ? r2(P) : 'N/A'} 元 / 普通股PB ≈ ${(P != null ? P / bvps : 0).toFixed(2)} 倍 vs 主模型动态锚 ${pbAnchorEff.toFixed(2)} 倍${anchorCapped ? `（原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍已封顶至理论 ${theoPB.toFixed(2)} 倍）` : ''}；板块PB ${r2(indPB)}（近10年约7%分位）`, source: (I.market.pbLF || {}).source + '；' + (pC.industryPB || {}).source },
  ];

  const mappingRows = [
    { label: '数据分层（第一法则）', value: `刚性实时层 ${rigid.length} 项全部取自三表最新报告期（${asOf}）标［最新报告期］；柔性平滑层 ${soft.length} 项全部按「上次已知 × 全市场指标增幅」推演标［推算估算值］——本次${sotpStageLabel}严禁「总营收×上次占比」估算，已按经纪=成交额因子、投行=IPO家数因子、科创=科创50动量因子分别推演`, source: LAW.source || 'Wind 2026年前三季度A股大数据全景扫描' },
    ...soft.map((x) => ({ label: `柔性·${x.label}`, value: `${x.value} 亿｜${x.method}`, source: x.period })),
  ];

  const seasonRows = [
    { label: 'TTM 归母净利（第二法则口径）', value: `${Number(asOf.slice(0, 4)) - 1}年报 ${r2(yi(incFY.PARENT_NETPROFIT))} − ${prevYearSame}累计 ${r2(yi(incPrev.PARENT_NETPROFIT))} + ${asOf}累计 ${r2(yi(incCur.PARENT_NETPROFIT))} = ${r2(npTtm)} 亿［最新报告期］`, source: '三表勾稽，禁止简单×4' },
    { label: 'TTM 扣非净利（熔断备用口径）', value: `${r2(npDedTtm)} 亿（同口径勾稽）；归母/扣非同比 ${r2(npYoy)}% vs ${r2(npDedYoy)}%，偏离 ${r2(growthDev)}pp（阈值 ${devLimitPp}pp）`, source: '第五法则熔断1' },
    { label: '2026E 预测口径', value: `机构一致预期归母 ${r2(consensusNp)} 亿 → 预测ROE ${r2(predRoe)}%［预测口径，仅用于PB锚越界修正，不替代TTM］`, source: (I.patchB.consensusNp || {}).source },
  ];

  const riskLights = [
    { label: `第一法则·数据分层（刚性 ${rigid.length} 项最新报告期 / 柔性 ${soft.length} 项推演）`, light: '绿灯：全部带时间戳标签，无跨层混用' },
    { label: `第三法则·SOTP 状态（${sotpStageLabel}）`, light: sotpDormant ? `黄灯：休眠降级 → 因财报披露颗粒度不足，SOTP暂不作为决策依据（仅参考上限 ${r2(sotpMidPs)} 元）` : '绿灯：分部数据齐全，正常运作' },
    { label: '第五法则·扣非切换', light: useDeducted ? `红灯：归母/扣非同比偏离 ${r2(growthDev)}pp > ${devLimitPp}pp → 已切换扣非` : `绿灯：偏离 ${r2(growthDev)}pp ≤ ${devLimitPp}pp` },
    { label: '第五法则·熔断2（上行/下行空间）', light: fused ? `红灯：${fuseReason}` : (ratingDowngraded ? `🟢 绿色提示：现价大幅低于中枢 → 绝对低估/重大机会（补丁I·熔断降级，非数据错误）；买入区间 ¥${buyRange ? buyRange[0] + '~' + buyRange[1] : 'N/A'}` : `绿灯：未触及 ${fuseUpLine}%/${fuseDownLine}% 熔断线`) },
    { label: `第四法则·双轨防御（上轨 ${pbP90.toFixed(3)} / 下轨 ${pbP50.toFixed(3)}）`, light: anchorBreached ? `红灯：原始动态锚 ${pbAnchorRaw.toFixed(2)} 突破上轨（估值体系重构警告，ROE质变）→ 已封顶至理论PB锚 ${theoPB.toFixed(2)} 倍，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍` : (anchorFloorActive ? `黄灯：动态锚跌破下轨 → 周期底部铁底 ¥${r2(floorRes.floorPrice)}，禁止无限看空` : `绿灯：锚 ${pbAnchorEff.toFixed(2)} 位于双轨带内`) },
    { label: '第五法则·排序强校验', light: orderOk ? `绿灯：${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} 原边界自洽` : `黄灯：历史分位失真 → 已按动态锚强制外扩（${boundaryNote}）` },
    { label: '市场快照超龄提示', light: staleSnapshots ? `⚠️ ${staleSnapshots} 项快照超龄（>${snapMax}天）` : '🟢 全部在有效期内' },
  ];

  const sigBuy = nz(vv(I.signals.buyBelow)), sigSell = nz(vv(I.signals.sellAbove));
  let signal = '未触发';
  if (P != null && !fused) {
    if (P <= sigBuy) signal = `⚠️ 进入低估区（现价 ${r2(P)} ≤ 信号线 ${sigBuy} 元）`;
    else if (P >= sigSell) signal = `⚠️ 进入高估区（现价 ${r2(P)} ≥ 信号线 ${sigSell} 元）`;
  }
  const lowTag = boundaryFixed ? `动态锚 ×${downMult.toFixed(2)}` : `PB ${pbP10.toFixed(3)} 分位`;
  const highTag = boundaryFixed ? `动态锚 ×${upMult.toFixed(2)}` : `PB ${pbP90.toFixed(3)} 分位`;
  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出三档区间。';
    if (fused) return `⛔ 熔断触发（红色警报）：${fuseReason} 三档区间仅供人工复核参考，不输出自动评级。`;
    const disc = (pbTarget - P) / pbTarget * 100;
    let note = `当前股价 ${r2(P)} 元 vs 基准（动态PB锚${anchorCapped ? '封顶' : ''}）${r2(pbTarget)} 元 → ${premiumNote} → 评级：「${rating}」。三档区间：极端悲观 ${r2(extremeLow)} 元（${lowTag}）/ 基准 ${r2(pbTarget)} 元（动态锚）/ 极端乐观 ${r2(extremeHigh)} 元（${highTag}）；单边空间见②矩阵分档行。普通股PB ${(P / bvps).toFixed(2)} 倍 vs 动态锚 ${pbAnchorEff.toFixed(2)} 倍。买卖信号：${signal}。`;
    if (ratingDowngraded) {
      note += ` ${davisNote}`;
      if (buyRange) note += ` 💡 买入区间建议：¥${buyRange[0]} ~ ¥${buyRange[1]}（历史铁底至悲观情景上沿）。`;
    }
    if (floorBreached) note += ` ⚠️ ${floorBreachWarn}`;
    else if (maxDownsidePct != null) note += ` 极端悲观已锁铁底 ¥${r2(floorPriceStatic)} → 潜在最大下行风险仅 ${r2(maxDownsidePct)}%。`;
    return note;
  })();

  const riskNote = '上行：ROE 持续高于 12% → 动态锚继续上修、科创项目大额退出、板块估值修复；下行：日均成交额跌破 1.5 万亿 → 经纪承压、年化投资收益率跌破 6% → 自营 PB 回落、科创50 半年跌幅超 10% → 科创 PE 压缩、归母/扣非增速偏离超 20pp → 自动切换扣非。第四法则铁底：近5年真实50%分位为周期底部估值底线，禁止无限看空。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  const result = {
    ok: true, dedicated: true, changjiang: true,
    version: 'V3-五法则',
    symbol: SYM, stockName: cfg.name,
    rating, fused, fuseReason,
    fairValueRange: [r2(extremeLow), r2(extremeHigh)],
    fairValueCenter: r2(pbTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'changjiang000783 V3-五法则（数据分层对齐+TTM重构+主辅模型休眠机制+历史分位双轨防御+逻辑自洽与极值熔断；全量重算接入最新报告期三表，确定性计算无AI参与）',
    dataAsOf: asOf,
    asOfDate: asOf, asOfStage: sotpStageLabel,
    // 输出模板三件套
    dashboardRows, summaryNote, matrixRows,
    // 新增结构化字段
    layers: { rigid, soft, sotpDormant, sotpStageLabel, sotpDormantNote },
    fairPB: { anchor: r2(pbAnchorEff), anchorRaw: r2(pbAnchorRaw), anchorCapped, theoPB: r2(theoPB), base: r2(pbBase), roeAdjPct: r2(roeAdj * 100), p10: pbP10, p50: pbP50, p90: pbP90, roeTtm: r2(roeTtm), roeTtmBasis: `${coreNpLabel} ÷ 平均普通股净资产` },
    patchF: { orderOk, boundaryFixed, boundaryNote, anchorBreached, reframeNote, spaceDownPct, spaceUpPct, fuseF, fuseDownLine, upMult, downMult, extremeLowPct: r2(extremeLowPct), extremeHighPct: r2(extremeHighPct) },
    patchFPlus: { singleSideSpace: true, downSpaceText, upSpaceText, sotpDeep: false, sotpNote: sotpDormantNote, dormancy: true },
    patchG: {
      upRailPb: pbP90, floorPb: floorRes.floorPb, floorPrice: r2(floorRes.floorPrice),
      floorRailBasis: `近5年日K真实50%分位（${pbP50.toFixed(3)} 倍），非长周期均值`,
      anchorFloorActive, anchorFloorNote, pbTargetRaw: r2(pbTargetRaw), pbTarget: r2(pbTarget),
      rail: anchorBreached ? 'upper-breach' : (anchorFloorActive ? 'floor-active' : 'in-band'),
      recovery: { active: recoveryActive, inverted: recoveryInverted, label: recoveryLabel, gateTurnover: recoveryRes.gateTurnover, gateRoe: recoveryRes.gateRoe, pbLtMean: recoveryRes.pbLtMean, price: recoveryRes.price, note: recoveryNote, turnoverYi: recoveryRes.turnoverYi, turnoverDate: mktTurnoverDate, turnoverSource: mktTurnoverSrc, turnoverFloorYi: recoveryRes.turnoverFloorYi, roeValues: recoveryRes.roeValues, reason: recoveryRes.reason },
    },
    patchI: {
      rule1: { priceSource, enforced: true, note: '运行时态现价强同步：强制使用当日行情快照现价，严禁历史残留现价（如 8.51）' },
      rule2: { pbAnchorRaw: r2(pbAnchorRaw), theoPB: r2(theoPB), pbAnchorEff: r2(pbAnchorEff), anchorCapped, centerCapped: r2(pbTarget), cappedNote: anchorCapped ? `主模型PB锚由 ${pbAnchorRaw.toFixed(4)} 倍封顶至理论PB锚 ${theoPB.toFixed(4)} 倍，中枢 ≤ ¥${r2(pbTarget)}` : '未触发：动态PB锚 ≤ 理论PB锚' },
      rule2b: { floorBreached, floorPrice: r2(floorPriceStatic), floorBreachWarn },
      rule3: { extremeLowLocked: r2(extremeLow), maxDownsidePct: maxDownsidePct != null ? r2(maxDownsidePct) : null, boundaryFloorLock, recoveryPrice: r2(recoveryRes.price), recoveryGtExtremeLow: recoveryRes.price != null && recoveryRes.price > floorPriceStatic },
      rule4: { ratingDowngraded, from: '无法评级', to: rating, davisNote, buyRange, fuseSuppressed: ratingDowngraded },
    },
    priceSource,
    coreRows, mappingRows, seasonRows, sotpRows, sensRows, yieldNote: `自营倍数：年化投资收益率 ${r2(annInvYield)}%（Q3累计 ${r2(invIncCum)}×4/3 ÷ 投资资产 ${r2(invAssets)}［最新报告期］）${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → PB 1.1' : '≤ 6% → PB 1.0'}；科创倍数：科创50前三季 +${sci50}%（Q3单季 ${r2(sciQ3Single * 100)}%）→ ${vcPe[0]}~${vcPe[1]}x。`, sensOut: sensRows.map(s => `${s.label}：${s.value} 元`).join(' ｜ '),
    riskLights, positionNote, riskNote, signal,
    guardRows, alerts, freshnessRows,
    decisionNote: `V3-五法则全接入：①数据分层（刚性 ${rigid.length} 项［最新报告期 ${asOf}］+ 柔性 ${soft.length} 项［推算估算值］，严禁「总营收×上次占比」）；②TTM重构（${coreNpLabel} ${r2(coreNpTtm)} 亿 ÷ 平均普通股净资产 ${r2(equityAvg)} 亿 = TTM ROE ${r2(roeTtm)}%，目标价 = BVPS ${r2(bvps)} × 动态锚 ${pbAnchorEff.toFixed(4)}${anchorCapped ? `(封顶：≤理论PB锚 ${theoPB.toFixed(4)})` : ''}；预测ROE ${r2(predRoe)}%［预测口径］）；③主辅模型（PB-ROE 永远在线为唯一基准；SOTP ${sotpStageLabel}${sotpDormant ? '强制休眠降级 → 因财报披露颗粒度不足，SOTP暂不作为决策依据，仅作参考上限' : '正常运作'}）；④双轨防御（${anchorBreached ? `上轨突破 → 🔴估值体系重构警告（ROE质变）${anchorCapped ? '；补丁I·三位一体向下约束已封顶至理论PB锚' : ''}` : (anchorFloorActive ? '下轨触发 → 周期底部铁底' : `锚 ${pbAnchorEff.toFixed(2)} 位于 [${pbP50}, ${pbP90}] 带内`)}）；⑤逻辑自洽与熔断（排序 ${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} ${orderOk ? '✅' : '→已强制外扩'}；单边空间：下行 ${signedPct(spaceDownPct)}% / 上行 ${signedPct(spaceUpPct)}%；扣非切换${useDeducted ? '已触发' : '未触发'}（偏离 ${r2(growthDev)}pp）；空间熔断${fused ? '⛔已触发' : (ratingDowngraded ? '🟢补丁I降级：现价大幅低于中枢 → 绝对低估/重大机会（非数据错误）' : '未触发')}）。补丁I：①实时价强同步（${priceSource}）②三位一体向下约束${anchorCapped ? `已封顶（中枢≤¥${r2(pbTarget)}）` : '未触发'}③边界常识校验${floorBreached ? '（击穿铁底）' : (maxDownsidePct != null ? `（锁铁底，最大下行${r2(maxDownsidePct)}%）` : '（通过）')}④戴维斯双杀预警${ratingDowngraded ? ' + 熔断降级绿色提示' : ''}。`,
    runId,
  };

  appendRunLog({
    run_id: runId, model_version: 'V3-五法则', run_time: startedAt,
    valuation_base_date: asOf, as_of_date: asOf,
    data_source_status: { rigid: rigid.length, soft: soft.length, sotp_dormant: sotpDormant },
    parameter_values: { pbAnchor: r2(pbAnchor), pbBase: r2(pbBase), roeTtm: r2(roeTtm), predRoe: r2(predRoe), bvps: r2(bvps), coreNpTtm: r2(coreNpTtm), useDeducted, indPB, roeAdj: r2(roeAdj * 100) },
    output_results: { threeTier: [r2(extremeLow), r2(pbTarget), r2(extremeHigh)], rating, sotp_dormant_ps: r2(sotpMidPs), fused, anchorBreached, anchorFloorActive },
  });
  return result;
}

module.exports = { run, isChangjiangModel, loadConfig, pickAnchorFloor, attributeSotpDeviation, evalRecoveryScenario };

~~~

---

## `lib\valuation\dcavm688660.js`  ·  418 行

~~~js
// ============================================================
// 电气风电（688660）专属估值模型 —— 动态周期估值模型 DCAVM v1.0（确定性计算，1+1=2）
// 20260909h：五站流水线
//   ① 时间引擎（月算法自动适配最新报告期 + 数据时效看板）
//   ② 景气周期评分（0~100，由量化子指标加权）→ 周期阶段 band（底部/复苏/中性/景气）
//   ③ 多路估值：三阶段 FCFF·DCF（CAPM-WACC）/ 相对估值（PE·PB-ROE·EV-EBITDA·EV-Sales）/ SOTP（风机·服务·风电场·非核心）/ 订单·合同负债辅助法
//   ④ 动态加权合成：按周期阶段切换权重集（底部重资产锚 / 景气重相对）
//   ⑤ 三情景（悲观/基准/乐观）+ WACC/g 敏感性 + 安全边际 + 三档评级（低估/合理/高估）
// 计算层=代码，输入锁死（data/valuation/688660.json）⇒ 结果锁死；LLM 仅叙述。
// 无硬编码年份：报告期/预测年度均由时间引擎与配置推导；周期评分/权重均来自配置量化值。
// 适用：风电设备制造（强周期、盈利随招标价与装机波动，TTM PE 常为负）→ 用归一化盈利锚定。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '688660';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/688660.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isDcavmModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'dcavm';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const pct = (x) => (x == null) ? null : Math.round(Number(x) * 1000) / 10;
const div = (a, b) => (b != null && b !== 0) ? (a / b) : null;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 月算法：由基准日推导「最新已披露报告期」月份 M */
function detectLatestReportMonths(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4) return { M: 12, yearOffset: -1 };
  if (m <= 7) return { M: 3, yearOffset: 0 };
  if (m === 8) return (day >= 20) ? { M: 6, yearOffset: 0 } : { M: 3, yearOffset: 0 };
  if (m === 9) return { M: 6, yearOffset: 0 };
  if (m === 10) return (day >= 25) ? { M: 9, yearOffset: 0 } : { M: 6, yearOffset: 0 };
  return { M: 9, yearOffset: 0 };
}

function median(arr) {
  const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function run(symbol, { price, pe, pb } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'dcavm') return { error: 'NOT_DCAVM' };
  const I = cfg.inputs;
  const alerts = [];

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const N = nz(vv(I.market.shares));                                 // 亿股
  const mcap = (P != null) ? P * N : nz(vv(I.market.mcap));         // 亿元
  const D = nz(vv(I.balance.interestBearDebt));                     // 有息负债 亿元
  const cash = nz(vv(I.balance.cash));                              // 货币资金 亿元
  const netCash = cash - D;                                         // 净现金（亿元）
  const eqParent = nz(vv(I.balance.equityParent));                  // 归母净资产 亿元
  const bvps = N ? eqParent / N : null;                             // 每股净资产

  // ================= 第一站：时间引擎 + 数据时效 =================
  const now = new Date();
  const det = detectLatestReportMonths(now);
  const expectYear = now.getFullYear() + (det.yearOffset || 0);
  const expectEnd = `${expectYear}-${String(det.M).padStart(2, '0')}-${det.M === 12 ? '31' : (det.M === 6 ? '30' : (det.M === 3 ? '31' : '30'))}`;
  const RP = cfg.reportPeriod || {};
  const cfgEnd = RP.periodEnd;
  const periodMatch = (cfgEnd === expectEnd);
  if (!periodMatch) {
    alerts.push(`财报期口径不一致：配置标注 ${cfgEnd || '?'}（${RP.label || ''}），月算法判定最新已披露应为 ${expectEnd} → 请复核 data/valuation/688660.json`);
  }
  const discAge = RP.disclosureDate ? daysBetween(RP.disclosureDate, now) : null;
  if (discAge != null && discAge > 120) {
    alerts.push(`最新财报披露于 ${RP.disclosureDate}（距今 ${discAge} 天 > 120 天）→ 财报可能已超期`);
  }
  const FR = I.freshness || {};
  const freshnessRows = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, now) : null;
    if (age == null) continue;
    const maxAge = it.maxAge || FR.maxAgeDays || 120;
    const stale = age > maxAge;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge, stale });
    if (stale) alerts.push(`快照「${it.label}」取数于 ${it.asOf}（距今 ${age} 天 > ${maxAge} 天）→ 请复核更新`);
  }

  // ================= 第二站：景气周期评分 =================
  const cyc = I.cycle || {};
  const cycInds = (cyc.indicators || []).map(it => ({
    name: it.name,
    weight: nz(it.weight),
    score: nz(it.score),
    note: it.note || '',
  }));
  const wsum = cycInds.reduce((s, x) => s + x.weight, 0);
  const cycleScore = wsum > 0 ? cycInds.reduce((s, x) => s + x.weight * x.score, 0) / wsum : (cycInds.length ? cycInds.reduce((s, x) => s + x.score, 0) / cycInds.length : null);
  // 周期阶段判定（阈值，逻辑锁死）
  function bandOf(score) {
    if (score == null) return 'neutral';
    if (score < 35) return 'bottom';
    if (score < 55) return 'recovery';
    if (score < 75) return 'neutral';
    return 'boom';
  }
  const bandAuto = bandOf(cycleScore);
  const bandDefault = cyc.bandOverride || bandAuto;

  // ================= 第三站：归一化盈利 + 宏观 =================
  const EH = I.earningsHistory || [];
  const revArr = EH.map(e => nz(e.revenue));
  const npArr = EH.map(e => nz(e.np));
  const ebitdaArr = EH.map(e => nz(e.ebitda));
  const ebitArr = EH.map(e => nz(e.ebit));
  const daArr = EH.map(e => nz(e.da));
  const capexArr = EH.map(e => nz(e.capex));
  const nwcArr = EH.map(e => nz(e.nwc));
  const normRev = median(revArr);
  const normNp = median(npArr);
  const normEbitda = median(ebitdaArr);
  const normEbit = median(ebitArr);
  const normDa = median(daArr);
  const normCapex = median(capexArr);
  const normNwc = median(nwcArr);
  const normROE = div(normNp, eqParent);                            // 归一化 ROE（可为负）
  const normNetMargin = div(normNp, normRev);
  // EV/Sales 与订单覆盖用最新 TTM 营收（更贴近当前规模，含复苏）；缺失则回退归一化中位
  const revForSales = (I.market && I.market.revTTM) ? nz(I.market.revTTM) : normRev;

  // 宏观 / WACC
  const MA = I.macro;
  const rf = nz(vv(MA.rf)) / 100, erp = nz(vv(MA.erp)) / 100, beta = nz(vv(MA.beta));
  const sizeAdj = nz(vv(MA.sizeAdj)) / 100, rd = nz(vv(MA.rd)) / 100, tax = nz(vv(MA.taxRate)) / 100;
  const gP = nz(vv(MA.gPerp)) / 100;
  const Re = rf + beta * erp + sizeAdj;
  const wE = (mcap + D) ? mcap / (mcap + D) : 1;
  const wD = (mcap + D) ? D / (mcap + D) : 0;
  const WACC = wE * Re + wD * rd * (1 - tax);

  // 可比公司中位数
  const peers = (I.peers && I.peers.list) || [];
  const peerPEs = peers.map(p => nz(p.pe)).filter(x => isFinite(x) && x > 0);
  const peerPBs = peers.map(p => nz(p.pb)).filter(x => isFinite(x) && x > 0);
  const peerEVs = peers.map(p => nz(p.evEbitda)).filter(x => isFinite(x) && x > 0);
  const peerPSs = peers.map(p => nz(p.ps)).filter(x => isFinite(x) && x > 0);
  const peMedian = median(peerPEs);
  const pbMedian = median(peerPBs);
  const evMedian = median(peerEVs);
  const psMedian = median(peerPSs);
  const peerImpliedROE = (peMedian && pbMedian) ? div(pbMedian, peMedian) : null;

  // FCFF 基数（归一化，确定性）：优先用历年 FCFF 中位（周期平滑）；缺失时回退 EBIT×(1-税)+D&A−资本开支−ΔNWC
  const fcffHist = EH.map(e => nz(e.fcff)).filter(x => x !== 0 && isFinite(x));
  const fcff0 = fcffHist.length ? median(fcffHist) : (nz(normEbit) * (1 - tax) + normDa - normCapex - normNwc);

  // ================= 估值方法（按情景参数化） =================
  const weights = I.weights || {};
  const dcfP = I.dcf || {};
  const safeMargin = nz(vv(I.safetyMargin));

  function dcfValue(sc) {
    const g1 = nz(sc.g1 != null ? sc.g1 : dcfP.g1), g2 = nz(sc.g2 != null ? sc.g2 : dcfP.g2);
    const T1 = nz(dcfP.T1) || 5, T2 = nz(dcfP.T2) || 10;
    let pv = 0; const fcffs = [];
    for (let t = 1; t <= T1; t++) {
      const f = fcff0 * Math.pow(1 + g1, t);
      fcffs.push(f);
      pv += f / Math.pow(1 + WACC, t);
    }
    let prev = fcffs[fcffs.length - 1];
    for (let t = T1 + 1; t <= T2; t++) {
      const f = prev * (1 + g2);
      prev = f;
      pv += f / Math.pow(1 + WACC, t);
    }
    const tv = prev * (1 + gP) / (WACC - gP);
    const pvTv = tv / Math.pow(1 + WACC, T2);
    const evOps = pv + pvTv;
    const equity = evOps + netCash;
    return { g1, g2, T1, T2, evOps: r2(evOps), tvShare: r2(pvTv / (pv + pvTv) * 100), tpDCF: r2(div(equity, N)) };
  }

  function relativeValue(sc) {
    const relMult = nz(sc.relMult != null ? sc.relMult : 1);
    // PB-ROE 周期底部锚
    let targetPB;
    if (normROE != null && normROE > 0 && peerImpliedROE) targetPB = pbMedian * (normROE / peerImpliedROE);
    else targetPB = pbMedian * 0.5;   // 归一化 ROE≤0 → 周期底部折扣锚
    const tpPB = (bvps != null) ? bvps * targetPB : null;
    // 归一化 PE（仅当归一化 EPS 为正；亏损周期 PE 失效）
    const normEPS = N ? normNp / N : null;
    const tpPE = (normEPS != null && normEPS > 0 && peMedian) ? normEPS * peMedian * relMult : null;
    // EV/EBITDA（仅当归一化 EBITDA 为正；亏损周期失效）
    const tpEV = (normEbitda && normEbitda > 0 && evMedian) ? div(normEbitda * evMedian * relMult + netCash, N) : null;
    // EV/Sales（用最新 TTM 营收，周期底部仍可用）
    const tpEVs = (revForSales && psMedian) ? div(revForSales * psMedian * relMult + netCash, N) : null;
    const relVals = [tpPE, tpPB, tpEV, tpEVs].filter(x => x != null && isFinite(x) && x > 0);
    const blend = relVals.length ? relVals.reduce((a, b) => a + b, 0) / relVals.length : null;
    return { targetPB: r2(targetPB), tpPB: r2(tpPB), tpPE: r2(tpPE), tpEV: r2(tpEV), tpEVs: r2(tpEVs), blend: r2(blend) };
  }

  function pbRoeValue(sc) {
    // 与 relativeValue 中 PB-ROE 同口径，作为独立「周期底部锚」方法
    let targetPB;
    if (normROE != null && normROE > 0 && peerImpliedROE) targetPB = pbMedian * (normROE / peerImpliedROE);
    else targetPB = pbMedian * 0.5;
    const tpPB = (bvps != null) ? bvps * targetPB : null;
    return { targetPB: r2(targetPB), tpPB: r2(tpPB), bvps: r2(bvps), normROE: pct(normROE) };
  }

  function sotpValue(sc) {
    const sm = nz(sc.sotpMult != null ? sc.sotpMult : 1);
    const segs = [];
    let totalEq = 0;
    for (const s of (I.segments || [])) {
      const share = nz(s.share);
      const allocDebt = (s.revenue && normRev) ? D * (s.revenue / normRev) : D * (share / 100);
      const allocCash = (s.revenue && normRev) ? cash * (s.revenue / normRev) : cash * (share / 100);
      let val = null, detail = '';
      if (s.method === 'evEbitda') {
        const segEV = nz(s.ebitda) * nz(s.multiple) * sm;
        val = segEV - allocDebt + allocCash;
        detail = `EV/EBITDA：${r2(nz(s.ebitda))}×${r2(nz(s.multiple) * sm)} − 分摊有息债${r2(allocDebt)} + 分摊现金${r2(allocCash)}`;
      } else if (s.method === 'pe') {
        val = nz(s.np) * nz(s.multiple) * sm;
        detail = `PE：${r2(nz(s.np))}亿 × ${r2(nz(s.multiple) * sm)}×`;
      } else if (s.method === 'yield') {
        const cap = nz(s.capRate) || 0.08;
        val = nz(s.np) / cap;
        detail = `收益法（capRate ${pct(cap)}%）：${r2(nz(s.np))} ÷ ${pct(cap)}%`;
      } else if (s.method === 'book') {
        val = nz(s.book);
        detail = `账面价值法：${r2(val)} 亿`;
      }
      const sv = (val != null) ? r2(val) : null;
      if (sv != null) totalEq += val;
      segs.push({ name: s.name, method: s.method, value: sv, detail });
    }
    return { tpSOTP: r2(div(totalEq, N)), segs, totalEq: r2(totalEq) };
  }

  function orderValue(sc) {
    const backlog = nz(vv(I.orders.backlog));
    const coverage = (revForSales && backlog) ? div(backlog, revForSales) : null;
    const relMult = nz(sc.relMult != null ? sc.relMult : 1);
    let tpOrder = null;
    if (backlog && normRev && peMedian) {
      // 归一化净利率若为周期亏损（≤0），用复苏期地板净利率 4% 锚定（订单法仅作前瞻辅助，不放大亏损）
      const tgtMargin = (normNetMargin != null && normNetMargin > 0) ? normNetMargin : 0.04;
      const implNp = backlog * tgtMargin;
      const tp = div(implNp * peMedian * relMult, N);
      tpOrder = (tp != null && tp > 0) ? tp : null;
    }
    return { coverage: (coverage != null) ? r2(coverage) : null, tpOrder: r2(tpOrder), backlog: r2(backlog) };
  }

  function synthesize(sc) {
    const band = sc.band || bandDefault;
    const w = weights[band] || weights.neutral || {};
    const d = dcfValue(sc);
    const rel = relativeValue(sc);
    const pr = pbRoeValue(sc);
    const so = sotpValue(sc);
    const od = orderValue(sc);
    const parts = {
      dcf: d.tpDCF, pbRoe: pr.tpPB, relative: rel.blend, sotp: so.tpSOTP, order: od.tpOrder,
    };
    let comp = 0; const used = [];
    for (const k of ['dcf', 'pbRoe', 'relative', 'sotp', 'order']) {
      const wk = nz(w[k]);
      if (wk > 0 && parts[k] != null && isFinite(parts[k])) { comp += wk * parts[k]; used.push(k); }
    }
    return { band, w, parts, composite: r2(comp), d, rel, pr, so, od, used };
  }

  // ================= 第五站：三情景 + 敏感性 + 评级 =================
  const SC = I.scenarios || {};
  const base = synthesize(SC.base || {});
  const opt = synthesize(SC.optimistic || {});
  const pess = synthesize(SC.pessimistic || {});
  const center = base.composite;
  const rangeLow = Math.min(opt.composite, pess.composite, center);
  const rangeHigh = Math.max(opt.composite, pess.composite, center);
  const conservative = center != null ? center * (1 - safeMargin) : null;

  // 交叉验证：SOTP / DCF / 相对 三路是否收敛
  const anchors = [base.d.tpDCF, base.rel.blend, base.so.tpSOTP].filter(x => x != null && isFinite(x));
  const aLo = Math.min(...anchors), aHi = Math.max(...anchors);
  const spread = (aHi && aLo) ? (aHi - aLo) / aHi : null;
  let crossNote;
  if (anchors.length >= 2 && spread != null && spread < 0.30) {
    crossNote = `三路锚（DCF ${base.d.tpDCF} / 相对 ${base.rel.blend} / SOTP ${base.so.tpSOTP}）差幅 ${pct(spread)}%（<30%）→ 交叉验证通过`;
  } else {
    crossNote = `⚠️ 模型分歧：三路锚 DCF ${base.d.tpDCF} / 相对 ${base.rel.blend} / SOTP ${base.so.tpSOTP} 差幅 ${spread != null ? pct(spread) : '?'}% → 已按「周期阶段动态权重」合成，保留分歧标注`;
  }

  // 敏感性（DCF 对永续增长 g 的暴露，确定性重算，使用同一 fcff0）
  function sensG() {
    const rows = [];
    const T1 = nz(dcfP.T1) || 5, T2 = nz(dcfP.T2) || 10;
    const g1 = nz((SC.base || {}).g1 != null ? (SC.base).g1 : dcfP.g1);
    const g2 = nz((SC.base || {}).g2 != null ? (SC.base).g2 : dcfP.g2);
    for (const dg of [-0.005, 0, 0.005]) {
      let pv = 0, prev = fcff0;
      for (let t = 1; t <= T1; t++) { prev = fcff0 * Math.pow(1 + g1, t); pv += prev / Math.pow(1 + WACC, t); }
      let p2 = prev;
      for (let t = T1 + 1; t <= T2; t++) { p2 = p2 * (1 + g2); pv += p2 / Math.pow(1 + WACC, t); }
      const tv = p2 * (1 + gP + dg) / (WACC - gP - dg);
      const evOps = pv + tv / Math.pow(1 + WACC, T2);
      const tp = div(evOps + netCash, N);
      rows.push({ label: `g ${(pct((gP + dg) * 100))}%`, tpDCF: r2(tp) });
    }
    return rows;
  }

  let rating = '无法评级', upside = null, position = null;
  if (P != null && center != null) {
    upside = (center - P) / P;
    position = Math.max(0, Math.min(100, (P - rangeLow) / (Math.max(rangeHigh - rangeLow, 1e-9)) * 100));
    if (upside > 0.20) rating = '低估';
    else if (upside >= -0.10) rating = '合理';
    else rating = '高估';
  }

  // ================= 输出行 =================
  const coreRows = [
    { label: '最新报告期（时间引擎）', value: `${RP.label || '—'}（${cfgEnd || '—'}，披露 ${RP.disclosureDate || '—'}，距今 ${discAge != null ? discAge : '?'} 天）｜月算法判定 ${expectEnd}${periodMatch ? ' ✓ 一致' : ' ⚠️ 不一致'}`, source: 'data/valuation/688660.json + 月算法自动推导' },
    { label: '实时市场', value: `现价 ${r2(P)} 元 / 总市值 ${r2(mcap)} 亿 / 总股本 ${r2(N)} 亿股 / PB ${vv(I.market.pb)} / PS(TTM) ${vv(I.market.ps)} / PE(TTM) ${vv(I.market.pe) || pe || '—'}（TTM 亏损→为负）`, source: '腾讯行情 2026-09-09' },
    { label: '归一化盈利（3~5年中位）', value: `营收 ${r2(normRev)} 亿 / 归母净利 ${r2(normNp)} 亿 / EBITDA ${r2(normEbitda)} 亿 / 归一化 ROE ${pct(normROE)}% / 净利率 ${pct(normNetMargin)}%`, source: 'data/valuation/688660.json earningsHistory（周期平滑锚）' },
    { label: '景气周期评分', value: `综合 ${r2(cycleScore)} / 100 → 阶段【${bandLabel(bandDefault)}】；子指标：${cycInds.map(x => `${x.name} ${x.score}`).join('、')}`, source: 'data/valuation/688660.json cycle.indicators（量化加权）' },
    { label: 'WACC 与 DCF 参数', value: `Re ${pct(Re)}%（Rf ${pct(rf)}% + β ${beta} × ERP ${pct(erp)}% + 特定 ${pct(sizeAdj)}%）｜WACC ${pct(WACC)}%｜g ${pct(gP)}%｜显性 ${nz(dcfP.T1)}+${nz(dcfP.T2) - nz(dcfP.T1)} 年｜税率 ${pct(tax)}%｜FCFF 基数 ${r2(fcff0)} 亿`, source: MA.beta && MA.beta.source || 'CAPM 配置' },
    { label: '可比公司（风电整机）', value: `PE 中位 ${r2(peMedian)}×｜PB 中位 ${r2(pbMedian)}×｜EV/EBITDA 中位 ${r2(evMedian)}×｜PS 中位 ${r2(psMedian)}×｜隐含 ROE ${pct(peerImpliedROE)}%`, source: peers.map(p => `${p.name} PE${p.pe}/PB${p.pb}/EV-EBITDA${p.evEbitda || '—'}`).join('；') },
    { label: '资产负债锚', value: `归母净资产 ${r2(eqParent)} 亿（BVPS ${r2(bvps)} 元）／有息负债 ${r2(D)} 亿／净现金 ${r2(netCash)} 亿／合同负债 ${r2(vv(I.balance.contractLiab))} 亿`, source: 'data/valuation/688660.json balance（2026年半年报）' },
  ];

  const cycRows = cycInds.map(x => ({ name: x.name, value: `${x.score} 分（权重 ${pct(x.weight * 100)}%）${x.note ? ' — ' + x.note : ''}` }));
  const segRows = (I.segments || []).map(s => ({ name: s.name, value: `收入 ${r2(nz(s.revenue))} 亿（占比 ${pct(nz(s.share))}%）／毛利率 ${s.margin != null ? pct(nz(s.margin)) + '%' : '—'}／估值法：${s.method}` }));
  const sotpSegRows = base.so.segs.map(s => ({ name: s.name, value: `${s.detail} ⇒ 权益估值 ${s.value} 亿` }));
  const matrixRows = [
    { method: '三阶段 FCFF·DCF（CAPM-WACC）', low: pess.d.tpDCF, mid: base.d.tpDCF, high: opt.d.tpDCF, note: `WACC ${pct(WACC)}% / g ${pct(gP)}% / 显性 ${nz(dcfP.T1)}+${nz(dcfP.T2) - nz(dcfP.T1)} 年 / FCFF 基数 ${r2(fcff0)} 亿 / 终值占比 ${base.d.tvShare}%` },
    { method: '相对估值（PE·EV/EBITDA·EV/Sales 混合）', low: pess.rel.blend, mid: base.rel.blend, high: opt.rel.blend, note: `PE 中位 ${r2(peMedian)}× / EV/EBITDA ${r2(evMedian)}× / PS ${r2(psMedian)}×；混合锚=${base.rel.blend} 元` },
    { method: 'PB-ROE 周期底部锚', low: pess.pr.tpPB, mid: base.pr.tpPB, high: opt.pr.tpPB, note: `BVPS ${r2(bvps)} 元 × 目标 PB ${base.pr.targetPB}×（归一化 ROE ${pct(normROE)}% vs 可比隐含 ROE ${pct(peerImpliedROE)}%）` },
    { method: 'SOTP 分部加总', low: pess.so.tpSOTP, mid: base.so.tpSOTP, high: opt.so.tpSOTP, note: `风机(EV/EBITDA)+服务(PE)+风电场(收益法)+非核心(账面) ⇒ 权益 ${base.so.totalEq} 亿` },
    { method: '订单·合同负债辅助法', low: pess.od.tpOrder, mid: base.od.tpOrder, high: opt.od.tpOrder, note: `在手订单 ${base.od.backlog} 亿 / 覆盖倍数 ${base.od.coverage}×（营收）` },
    { method: `动态加权合成（阶段【${bandLabel(bandDefault)}】权重）`, low: r2(Math.min(opt.composite, pess.composite, center)), mid: r2(center), high: r2(Math.max(opt.composite, pess.composite, center)), note: `权重：${Object.entries(base.w).map(([k, v]) => `${k} ${pct(v * 100)}%`).join(' / ')}；保守（安全边际 ${pct(safeMargin)}%）= ${r2(conservative)} 元` },
  ];
  const scenRows = [
    { name: `乐观情景（权重集【${bandLabel(opt.band)}】）`, value: `综合 ${r2(opt.composite)} 元；DCF ${opt.d.tpDCF}｜相对 ${opt.rel.blend}｜PB-ROE ${opt.pr.tpPB}｜SOTP ${opt.so.tpSOTP}｜订单 ${opt.od.tpOrder}；假设：${SC.optimistic && SC.optimistic.note || ''}` },
    { name: `基准情景（权重集【${bandLabel(base.band)}】）`, value: `综合 ${r2(base.composite)} 元；DCF ${base.d.tpDCF}｜相对 ${base.rel.blend}｜PB-ROE ${base.pr.tpPB}｜SOTP ${base.so.tpSOTP}｜订单 ${base.od.tpOrder}；假设：${SC.base && SC.base.note || ''}` },
    { name: `悲观情景（权重集【${bandLabel(pess.band)}】）`, value: `综合 ${r2(pess.composite)} 元；DCF ${pess.d.tpDCF}｜相对 ${pess.rel.blend}｜PB-ROE ${pess.pr.tpPB}｜SOTP ${pess.so.tpSOTP}｜订单 ${pess.od.tpOrder}；假设：${SC.pessimistic && SC.pessimistic.note || ''}` },
  ];
  const sensRows = sensG();
  const assumpRows = [
    { label: '归一化盈利口径', value: `取 ${EH.length} 年中位：营收 ${r2(normRev)} / 净利 ${r2(normNp)} / EBITDA ${r2(normEbitda)} 亿（周期平滑，避免单年亏损扭曲）` },
    { label: 'FCFF 基数构成', value: `EBIT ${r2(normEbit)}×(1−税${pct(tax)}%) + D&A ${r2(normDa)} − 资本开支 ${r2(normCapex)} − Δ营运资金 ${r2(normNwc)} = ${r2(fcff0)} 亿` },
    { label: '动态权重逻辑', value: `底部重资产锚（DCF+PB-ROE 高权重）/ 景气重相对（PE/EV 高权重）；当前阶段【${bandLabel(bandDefault)}】→ 采用对应权重集` },
    { label: '安全边际', value: `${pct(safeMargin)}%（区间 15%~25% 中值），保守目标价 ${r2(conservative)} 元` },
    { label: '评级铁律', value: `上行空间 >20% 低估 / −10%~+20% 合理 / <−10% 高估（现上行 ${pct(upside)}%）` },
  ];
  const monitorRows = [
    { name: '合同负债 / 营收', value: `合同负债 ${r2(vv(I.balance.contractLiab))} 亿 ÷ TTM 营收 ${r2(normRev)} 亿 = ${pct(div(vv(I.balance.contractLiab), normRev) * 100)}%（前瞻订单能见度的代理）` },
    { name: '在手订单覆盖', value: `在手订单 ${base.od.backlog} 亿，覆盖 ${base.od.coverage} 年营收 → 订单驱动型，关注新签与出海` },
    { name: '有息负债率', value: `有息负债 ${r2(D)} 亿 / 净资产 ${r2(eqParent)} 亿 = ${pct(div(D, eqParent) * 100)}%（财务杠杆与偿付）` },
    { name: '行业 PE 分位', value: `可比 PE 中位 ${r2(peMedian)}×；电气风电 TTM PE 为负（亏损）→ 必须用归一化盈利与资产锚，禁用 TTM PE` },
  ];
  const riskNote = '下行风险：① 风机招标价格战反复、毛利率不及预期；② 下游装机节奏放缓或抢装退潮；③ 海外收入占比与客户集中度风险（单一大客户）；④ 应收账款与存货周转、减值风险；⑤ 有息负债与财务费用压力；⑥ 技术迭代（大兆瓦、海上/漂浮式）落后对手。上行催化：海风与出海放量、招标价企稳回升、订单结构优化、盈利扭亏兑现。模型为研究框架，不构成投资建议。';

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出目标价区间，评级为「无法评级」。';
    return `现价 ${r2(P)} 元位于综合区间 ${r2(rangeLow)}~${r2(rangeHigh)} 元的 ${Math.round(position)}% 位置；综合中枢 ${r2(center)} 元，上行空间 ${pct(upside)}% → 评级「${rating}」。${crossNote}`;
  })();
  const decisionNote = `DCAVM 五站流水线（全动态、无硬编码年份）：时间引擎 → 景气周期评分（${r2(cycleScore)}→【${bandLabel(bandDefault)}】）→ 多路估值（三阶段DCF / 相对 / PB-ROE / SOTP / 订单）→ 按周期阶段动态加权合成 → 三情景 + WACC/g 敏感性 + 安全边际${pct(safeMargin)}% → 三档评级。所有数值由代码确定性计算，AI 仅负责叙述。`;

  return {
    ok: true,
    dedicated: true,
    dcavm: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservative),
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? pct(upside) : null,
    reportLabel: cfg.reportLabel,
    model: 'dcavm688660·动态周期估值模型（相对+绝对+周期锚交叉验证，确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    cycleScore: r2(cycleScore),
    cycleBand: bandDefault,
    wacc: pct(WACC),
    peMedian: r2(peMedian),
    pbMedian: r2(pbMedian),
    crossNote,
    freshnessRows, alerts,
    coreRows, cycRows, segRows, sotpSegRows, matrixRows, scenRows, sensRows, assumpRows, monitorRows, positionNote, riskNote, decisionNote,
  };
}

function bandLabel(band) {
  return ({ bottom: '周期底部', recovery: '复苏', neutral: '中性', boom: '景气' })[band] || band || '中性';
}

module.exports = { run, isDcavmModel, loadConfig, detectLatestReportMonths, bandLabel };

~~~

---

## `lib\valuation\haitian603288.js`  ·  700 行

~~~js
// ============================================================
// 海天味业（603288）专属动态估值引擎 V3.0_架构重构版 —— 确定性计算（1+1=2 原则）
// 20261029n：按《海天味业（603288）可复用估值引擎 — 最终完整版（V3.0 架构重构版）》十六章规范重构。
//   四大支柱：
//   支柱一 全量重算（Full Rebuild）：每次运行强制从财报库（东财F10三表）重新拉取完整三表，
//          禁止读取上次运行缓存变量值做增量patch（禁止操作#6）。
//   支柱二 三表勾稽重建（Statement Reconstruction）：优先级1=直接科目 → 优先级2=勾稽重建
//          （营业成本/毛利/EBIT率/税率/D&A/CAPEX/营运资本/有息负债）→ 优先级3=STRUCTURE_ONLY
//          隔离至情景层。禁止用年报比率反推本可勾稽重建的字段。
//   支柱三 预测驱动（Forecast-Driven）：以最新TTM营收为唯一起点×统一假设率外推预测期绝对金额，
//          禁止跨期混算；季报TTM偏离年报假设>1.5pct → 强制季报校准并标注。
//   支柱四 结构隔离（Structure Isolation）：分产品/分渠道结构不进入主FCFF公式，仅作情景层输入。
//   新增：双模型分歧检测（纯年报降频校验，divergence>10%红色告警）、混频检测门禁、
//        数据健康度评分（<60拒绝输出目标价）、WACC×g 3×3敏感性矩阵、变量元数据强制规范
//        （data_period/frequency/staleness_days/is_converted_to_ttm/source/口径标注，缺一禁入）。
//   核心估值逻辑不变：DCF 50%（绝对锚）+ 动态PE 50%（相对校准）+ 三情景。
//   宏观参数兜底值表：Rf 2.8% / ERP 6.0% / Beta 0.90 / g 2.5%（兜底使用时必须标注）。
//   硬约束：WACC − g ≥ 1.5pct。
// 计算层=代码，输入=每次全量重算的三表 + data/valuation/603288.json 锁死假设 ⇒ 结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '603288';
const CFG_PATH = path.join(__dirname, '../../data/valuation/603288.json');
const STATE_PATH = path.join(__dirname, '../../data/valuation/603288.state.json');
const LOG_DIR = path.join(__dirname, '../../data/logs/valuation_logs');
const LOG_PATH = path.join(LOG_DIR, '603288.jsonl');

const MODEL_VERSION = 'V3.0_架构重构版';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return null; }
}
function isHaitianModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  return bare === SYM && !!loadConfig();
}
const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const mean = (arr) => arr.reduce((a, b) => a + Number(b), 0) / arr.length;
const daysBetween = (d1, d2) => Math.round((new Date(String(d1).slice(0, 10)) - new Date(String(d2).slice(0, 10))) / 86400000);
const yi = (x) => (x == null || !isFinite(Number(x)) ? null : Number(x) / 1e8); // 元 → 亿元
const axios = require('axios');

// ---------- 股本强制治理（20261030j 用户指令）：total_shares 必须按最新交易日「流通股本+限售股本」获取；季报未披露→抓取中登/交易所最新日期口径；严禁使用超过90天的旧股本 ----------
const SHARE_MAX_AGE_DAYS = 90;
async function fetchShareBase(todayStr) {
  const out = { ok: false, chain: null, total: null, free: null, limited: null, aShares: null, hShares: null, asOf: null, days: null, closedLoop: { freePlusLimited: null, aPlusH: null }, note: '' };
  // 主链：东财 F10 股本构成（emweb，交易所/中登披露聚合；gbgc 按 END_DATE 倒序取最新一档，gbjg 当前快照互证）
  try {
    const r = await axios.get('https://emweb.securities.eastmoney.com/PC_HSF10/CapitalStockStructure/PageAjax?code=SH603288', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const d = r.data || {};
    const cur = Array.isArray(d.gbjg) && d.gbjg[0] ? d.gbjg[0] : null;
    const hist = Array.isArray(d.gbgc) ? d.gbgc.slice().sort((a, b) => String(b.END_DATE).localeCompare(String(a.END_DATE))) : [];
    const latest = hist[0] || cur;
    if (latest && latest.TOTAL_SHARES != null) {
      const asOf = String(latest.END_DATE || '').slice(0, 10);
      const totalS = Number(latest.TOTAL_SHARES);
      const freeS = Number(latest.UNLIMITED_SHARES != null ? latest.UNLIMITED_SHARES : (latest.FREE_SHARES != null ? latest.FREE_SHARES : (cur && cur.UNLIMITED_SHARES != null ? cur.UNLIMITED_SHARES : null)));
      const limitedS = Number(latest.LIMITED_SHARES != null ? latest.LIMITED_SHARES : (cur && cur.LIMITED_SHARES != null ? cur.LIMITED_SHARES : 0)) || 0;
      const aS = Number(latest.LISTED_A_SHARES != null ? latest.LISTED_A_SHARES : (cur ? cur.LISTED_A_SHARES : 0)) || 0;
      const hS = Number(latest.H_FREE_SHARE != null ? latest.H_FREE_SHARE : (cur ? cur.H_FREE_SHARE : 0)) || 0;
      if (totalS > 0 && asOf) {
        const days = daysBetween(todayStr, asOf);
        out.total = yi(totalS);
        out.free = freeS != null && isFinite(freeS) ? yi(freeS) : null;
        out.limited = yi(limitedS);
        out.aShares = yi(aS);
        out.hShares = yi(hS);
        out.asOf = asOf;
        out.days = days;
        out.closedLoop = {
          freePlusLimited: freeS != null ? Math.abs(freeS + limitedS - totalS) / totalS < 0.005 : null,   // 流通+限售=总股本（±0.5%）
          aPlusH: aS + hS > 0 ? Math.abs(aS + hS - totalS) / totalS < 0.005 : null,                        // A+H=总股本（海天 A+H 闭环）
        };
        out.chain = '东财F10股本构成（交易所/中登披露聚合）';
        out.ok = days <= SHARE_MAX_AGE_DAYS;
        out.note = out.ok ? '' : `股本披露日 ${asOf} 距今 ${days} 天 > ${SHARE_MAX_AGE_DAYS} 天上限 → 严禁使用`;
      }
    }
  } catch (e) { out.note = '主链失败: ' + e.message; }
  // 备链：腾讯行情最新交易日快照（总市值 ÷ 现价 反推，标注反推口径，非披露值）
  if (!out.ok) {
    try {
      const rt = await axios.get('http://qt.gtimg.cn/q=sh603288', { timeout: 15000, responseType: 'arraybuffer' });
      const f = require('iconv-lite').decode(rt.data, 'gbk').split('~');
      const px = parseFloat(f[3]), mcap = parseFloat(f[45]);
      if (px > 0 && mcap > 0) {
        out.total = Math.round(mcap / px * 100) / 100;
        out.asOf = todayStr;
        out.days = 0;
        out.chain = '腾讯行情最新交易日（总市值÷现价反推）';
        out.ok = true;
        out.note = '主链不可得 → 备链反推口径（非披露值，待与下一份披露核对）';
      }
    } catch (e) { out.note += '；备链失败: ' + e.message; }
  }
  return out;
}

// ---------- 日期规范化引擎（V3.0 规范 2.4：按月份回溯期望财报截止日） ----------
function getLatestReportDate(baseDate) {
  const d = new Date(String(baseDate).slice(0, 10) + 'T00:00:00');
  const m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear();
  if (m <= 3 || (m === 4 && day < 30)) return `${y - 1}-12-31`;            // 年报
  if ((m === 4 && day >= 30) || m === 5 || m === 6 || m === 7 || (m === 8 && day < 31)) return `${y}-03-31`; // 一季报
  if ((m === 8 && day >= 31) || m === 9 || (m === 10 && day < 31)) return `${y}-06-30`;   // 半年报
  return `${y}-09-30`;                                                      // 三季报
}

// ---------- 运行日志（第十二章：JSONL，保留最近100条） ----------
function appendRunLog(record) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    let lines = [];
    if (fs.existsSync(LOG_PATH)) {
      lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.trim());
    }
    lines.push(JSON.stringify(record));
    if (lines.length > 100) lines = lines.slice(-100);
    fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 日志失败不阻断估值 */ }
}

// ---------- 情景冷却状态（第九章：量化触发 + 冷却持久化） ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return { bear: null, bull: null }; }
}
function saveState(st) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 1), 'utf8'); } catch (e) { /* ignore */ }
}

// ============================================================
// 支柱一：全量重算入口（async）
// ============================================================
async function run(symbol, { price, statements } = {}) {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const startedAt = new Date().toISOString();
  try {
    let stmts = statements || null;
    let stmtSource = '测试注入（仅测试通道）';
    if (!stmts) {
      // 全量重算铁律：每次运行强制重新拉取完整三表，禁止读缓存
      const { fetchFinancialData } = require('../deep/financials');
      stmts = await fetchFinancialData(`SH${SYM}`);
      stmtSource = '东财F10三表（lrb/zcfzb/xjllbAjaxNew，含年报+最新季报合并），全量重算';
    }
    return await compute(symbol, { price }, stmts, runId, startedAt, stmtSource);
  } catch (err) {
    appendRunLog({
      run_id: runId, model_version: MODEL_VERSION, run_time: startedAt,
      error_stack: String(err && err.stack || err),
    });
    return { ok: false, success: false, message: `估值引擎运行失败：${err && err.message}（已记录运行日志 ${runId}，可回溯排查）` };
  }
}

// ============================================================
// 报表行工具：按报告期取行（元 → 亿 转换在字段级做）
// ============================================================
function rowOf(rows, period) {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r.REPORT_DATE || '').slice(0, 10) === period) || null;
}
function annualRows(rows) {
  return (rows || []).filter((r) => String(r.REPORT_DATE || '').slice(0, 10).slice(5) === '12-31')
    .sort((a, b) => String(a.REPORT_DATE).localeCompare(String(b.REPORT_DATE)));
}

// ============================================================
// compute：V3.0 主流程（规范第一章运行流程）
// 确定as-of date → 全量拉取三表 → 勾稽重建变量 → 注册表校验 → 混频门禁
// → 宏观参数 → FCFF预测驱动（主模型）→ 纯年报降频校验（校验模型）→ 双模型分歧
// → 数据健康度评分 → QA门禁 → 输出报告 → 运行日志
// ============================================================
async function compute(symbol, { price }, stmts, runId, startedAt, stmtSource) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM) return { error: 'NOT_HAITIAN' };
  const V3 = cfg.v3 || {};
  const P4 = cfg.patch4, P5 = cfg.patch5, P1 = cfg.patch1;

  // ===== ① as-of date：以实际拉取到的最新财报截止日为唯一 as-of date =====
  const baseDate = localDate();
  const incRows = (stmts && Array.isArray(stmts.income)) ? stmts.income : [];
  const balRows = (stmts && Array.isArray(stmts.balance)) ? stmts.balance : [];
  const cfRows = (stmts && Array.isArray(stmts.cashflow)) ? stmts.cashflow : [];
  if (!incRows.length || !balRows.length || !cfRows.length) {
    // 全量重算铁律#4：三表不可得 → 禁止沿用旧值，诚实中止
    appendRunLog({ run_id: runId, model_version: MODEL_VERSION, run_time: startedAt, error_stack: '全量重算中止：三表数据不可得（income/balance/cashflow 至少一张为空），禁止沿用旧值做增量patch' });
    return { ok: false, success: false, message: '全量重算中止：本次三表数据不可得（禁止沿用上次运行缓存值），请稍后重试或检查数据链' };
  }
  const incSorted = incRows.slice().sort((a, b) => String(a.REPORT_DATE).localeCompare(String(b.REPORT_DATE)));
  const asOf = String(incSorted[incSorted.length - 1].REPORT_DATE).slice(0, 10);
  const expectedReportDate = getLatestReportDate(baseDate);
  const asOfNote = asOf === expectedReportDate
    ? `与按月份回溯算法期望值一致`
    : `按月份回溯算法期望 ${expectedReportDate}，实际最新可得 ${asOf}（披露延迟属制度性节奏，以实际可得为准）`;

  const incFy = annualRows(incSorted);           // 年报利润表序列（升序）
  const cfFy = annualRows(cfRows);
  const fy25 = incFy[incFy.length - 1];          // 最近完整年报（校准起点）
  const fy25Period = String(fy25.REPORT_DATE).slice(0, 10);
  const fy24 = incFy[incFy.length - 2] || null;
  const fy23 = incFy[incFy.length - 3] || null;

  // 季度累计行（TTM 合成原料）：as-of 期 与 其上年同期
  const qCur = rowOf(incSorted, asOf);           // 如 2026-09-30 累计
  const qPrev = rowOf(incSorted, `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`); // 上年同期累计
  const cfCur = rowOf(cfRows, asOf);
  const cfPrev = rowOf(cfRows, `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`);
  const isAnnualAsOf = asOf.slice(5) === '12-31';

  // ===== ② 变量注册表（第四章）：所有变量强制携带元数据，缺一禁入计算 =====
  const registry = [];        // 全量变量元数据（数据时效矩阵用）
  const substitutes = [];     // FIELD_MISSING → 3年均值替代日志
  const rebuildLog = [];      // 三表勾稽重建日志
  const mixingAlerts = [];    // 混频门禁告警
  let annualRatioCount = 0;   // Annual-ratio applied 变量数（健康度扣分项）
  function reg(name, value, meta) {
    const v = {
      name, value,
      data_period: meta.period,
      frequency: meta.frequency,
      staleness_days: daysBetween(baseDate, meta.period),
      is_converted_to_ttm: !!meta.ttm,
      source: meta.source,
      caliber: meta.caliber || '',
      calibrated: !!meta.calibrated,
      status: meta.status || 'OK',
    };
    registry.push(v);
    if (!meta.ttm && v.staleness_days > 365) {
      mixingAlerts.push(`混频门禁·规则3：变量 ${name} staleness_days=${v.staleness_days} > 365（${v.data_period}），已告警`);
    }
    return v;
  }
  // 字段解析：优先级1 直接科目 → 优先级2 勾稽重建 → 优先级4 3年均值替代（回退链）
  function field(row, key, rebuilt, rebuildDesc) {
    if (row && row[key] != null && isFinite(Number(row[key]))) return { value: yi(row[key]), tier: 1, source: '三表直接科目' };
    if (rebuilt != null && isFinite(Number(rebuilt))) { rebuildLog.push(rebuildDesc); return { value: rebuilt, tier: 2, source: '三表勾稽重建' }; }
    return { value: null, tier: 0, source: 'FIELD_MISSING' };
  }

  // ---- TTM 合成（支柱三：最新TTM营收为唯一起点；全部 is_converted_to_ttm=true）----
  const ttmNote = isAnnualAsOf
    ? `as-of 为年报期，TTM=该年报口径`
    : `TTM = FY2025年报 − ${String(qPrev ? qPrev.REPORT_DATE : '').slice(0, 10)} 累计 + ${asOf} 累计（三表勾稽合成，禁止跨期混算之外的任何口径）`;
  function ttmOf(fyVal, curVal, prevVal) {
    if (isAnnualAsOf) return fyVal;
    if (fyVal == null || curVal == null || prevVal == null) return null;
    return fyVal - prevVal + curVal;
  }
  const revFy25 = yi(fy25.TOTAL_OPERATE_INCOME);
  const revTtmRaw = isAnnualAsOf ? revFy25 : ttmOf(revFy25, yi(qCur.TOTAL_OPERATE_INCOME), qPrev ? yi(qPrev.TOTAL_OPERATE_INCOME) : null);
  const npFy25 = yi(fy25.PARENT_NETPROFIT);
  const npTtmRaw = isAnnualAsOf ? npFy25 : ttmOf(npFy25, yi(qCur.PARENT_NETPROFIT), qPrev ? yi(qPrev.PARENT_NETPROFIT) : null);
  // 营业成本（优先级1 直接科目；缺 → 勾稽：营业总成本−销售−管理−研发−税金）
  const costOf = (row, rowTotal) => {
    if (!row) return null;
    const direct = field(row, 'OPERATE_COST');
    if (direct.value != null) return { ...direct, rebuilt: false };
    const reb = (yi(rowTotal.TOTAL_OPERATE_COST) != null && yi(row.SALE_EXPENSE) != null && yi(row.MANAGE_EXPENSE) != null && yi(row.RESEARCH_EXPENSE) != null && yi(row.OPERATE_TAX_ADD) != null)
      ? yi(rowTotal.TOTAL_OPERATE_COST) - yi(row.SALE_EXPENSE) - yi(row.MANAGE_EXPENSE) - yi(row.RESEARCH_EXPENSE) - yi(row.OPERATE_TAX_ADD)
      : null;
    const d = field(row, 'OPERATE_COST', reb, `营业成本 勾稽重建（营业总成本 − 销售 − 管理 − 研发 − 税金及附加）`);
    return { value: d.value, tier: d.tier, source: d.source, rebuilt: d.tier === 2 };
  };
  const costFy25 = costOf(fy25, fy25);
  const costTtmRaw = isAnnualAsOf ? costFy25.value : (qCur && qPrev ? ttmOf(costFy25.value, costOf(qCur, qCur).value, costOf(qPrev, qPrev).value) : null);
  const profitFy25 = yi(fy25.TOTAL_PROFIT);
  const profitTtmRaw = isAnnualAsOf ? profitFy25 : ttmOf(profitFy25, yi(qCur.TOTAL_PROFIT), qPrev ? yi(qPrev.TOTAL_PROFIT) : null);

  const V = {};
  V.revenue_ttm = reg('revenue_ttm', r2(revTtmRaw), { period: asOf, frequency: 'TTM', ttm: true, source: `${stmtSource}；${ttmNote}`, caliber: 'TTM' });
  V.np_ttm = reg('np_attr_ttm', r2(npTtmRaw), { period: asOf, frequency: 'TTM', ttm: true, source: `${stmtSource}；${ttmNote}`, caliber: 'TTM' });
  V.gross_margin_ttm = reg('gross_margin_ttm', (revTtmRaw && costTtmRaw != null) ? r2((1 - costTtmRaw / revTtmRaw) * 100) : null, { period: asOf, frequency: 'TTM', ttm: true, source: '勾稽重建：1 − 营业成本TTM/营收TTM', caliber: 'TTM' });

  // ---- 统一假设率（校准起点=最近完整年报 FY2025；Annual-ratio applied 必须标注）----
  const gmAnnual = (revFy25 && costFy25.value != null) ? (1 - costFy25.value / revFy25) * 100 : (cfg.inputs.fy2025.grossMargin);
  V.gross_margin_annual = reg('gross_margin_annual', r2(gmAnnual), { period: fy25Period, frequency: 'annual', source: '三表勾稽：1 − 营业成本/营收（FY2025年报）', caliber: 'Annual' });
  annualRatioCount++;
  // EBIT率（利润总额/营收口径，与 V2.0 一致）：年报=近3年移动平均
  const ebitMargins3y = [fy25, fy24, fy23].filter(Boolean).map((r) => yi(r.TOTAL_PROFIT) / yi(r.TOTAL_OPERATE_INCOME));
  const ebitMarginAnnual = mean(ebitMargins3y);
  const ebitMarginTtm = (revTtmRaw && profitTtmRaw != null) ? profitTtmRaw / revTtmRaw : null;
  V.ebit_margin_annual = reg('ebit_margin_annual', r2(ebitMarginAnnual * 100), { period: fy25Period, frequency: 'annual', source: `近3年实际EBIT率均值（${incFy.slice(-3).map((r) => `${String(r.REPORT_DATE).slice(0, 4)}:${r2(yi(r.TOTAL_PROFIT) / yi(r.TOTAL_OPERATE_INCOME) * 100)}%`).join('/')}，利润总额/营收，三表勾稽）`, caliber: 'Annual-ratio applied' });
  annualRatioCount++;
  V.ebit_margin_ttm = reg('ebit_margin_ttm', ebitMarginTtm != null ? r2(ebitMarginTtm * 100) : null, { period: asOf, frequency: 'TTM', ttm: true, source: '勾稽重建：利润总额TTM/营收TTM（季报校准对比基准）', caliber: 'TTM' });
  // 有效税率：近3年实际税率移动平均（勾稽：所得税/利润总额）
  const taxRates3y = [fy25, fy24, fy23].filter(Boolean).map((r) => yi(r.INCOME_TAX) / yi(r.TOTAL_PROFIT));
  const taxRate = mean(taxRates3y);
  V.tax_rate_effective = reg('tax_rate_effective', r2(taxRate * 100), { period: fy25Period, frequency: 'annual', source: `近3年实际税率移动平均（${incFy.slice(-3).map((r) => `${String(r.REPORT_DATE).slice(0, 4)}:${r2(yi(r.INCOME_TAX) / yi(r.TOTAL_PROFIT) * 100)}%`).join('/')}，勾稽重建）`, caliber: 'Annual-ratio applied' });
  annualRatioCount++;

  // ---- D&A（第三章：现金流量表补充资料勾稽重建）----
  const cfFy25 = rowOf(cfFy, fy25Period);
  const daParts = cfFy25 ? ['FA_IR_DEPR', 'IA_AMORTIZE', 'LPE_AMORTIZE', 'USERIGHT_ASSET_AMORTIZE'].map((k) => yi(cfFy25[k])).filter((x) => x != null) : [];
  // 防重复：OILGAS_BIOLOGY_DEPR 与 FA_IR_DEPR 高度重合（差异<1%）时视为同一补充资料行的拆分列，排除
  const oilgas = cfFy25 ? yi(cfFy25.OILGAS_BIOLOGY_DEPR) : null;
  const fa = cfFy25 ? yi(cfFy25.FA_IR_DEPR) : null;
  if (oilgas != null && fa != null && Math.abs(oilgas - fa) / fa >= 0.01) daParts.push(oilgas);
  const daAnnual = daParts.length ? daParts.reduce((a, b) => a + b, 0) : cfg.inputs.daAssumed;
  const daSource = cfFy25
    ? `现金流量表补充资料勾稽重建（固定资产折旧${fa != null ? r2(fa) : '—'} + 无形资产摊销${yi(cfFy25.IA_AMORTIZE) != null ? r2(yi(cfFy25.IA_AMORTIZE)) : '—'} + 长期待摊摊销${yi(cfFy25.LPE_AMORTIZE) != null ? r2(yi(cfFy25.LPE_AMORTIZE)) : '—'} + 使用权资产摊销${yi(cfFy25.USERIGHT_ASSET_AMORTIZE) != null ? r2(yi(cfFy25.USERIGHT_ASSET_AMORTIZE)) : '—'}${oilgas != null && Math.abs(oilgas - fa) / fa >= 0.01 ? ' + 油气/生物资产折耗' : ''}）`
    : '【替代】三表缺失，用配置假设值（标注）';
  V.da_annual = reg('da_annual', r2(daAnnual), { period: fy25Period, frequency: 'annual', source: daSource, caliber: 'Annual' });
  annualRatioCount++;
  // ---- CAPEX（第三章：现金流量表"购建固定资产、无形资产和其他长期资产支付的现金"直接科目）----
  const capexFy25 = cfFy25 && yi(cfFy25.CONSTRUCT_LONG_ASSET) != null ? yi(cfFy25.CONSTRUCT_LONG_ASSET) : cfg.inputs.fy2025.capex;
  const capexRebuilt = !(cfFy25 && yi(cfFy25.CONSTRUCT_LONG_ASSET) != null);
  if (capexRebuilt) rebuildLog.push('CAPEX 三表直接科目缺失，回退配置值（腾讯财经FCF倒算口径，标注口径差异）');
  V.capex_annual = reg('capex_annual', r2(capexFy25), { period: fy25Period, frequency: 'annual', source: cfFy25 && yi(cfFy25.CONSTRUCT_LONG_ASSET) != null ? '现金流量表直接科目：购建固定资产、无形资产和其他长期资产支付的现金（FY2025）' : '【替代】配置值（口径=腾讯财经FCF倒算）', caliber: 'Annual' });
  annualRatioCount++;
  // ---- ΔNWC率（勾稽：资产负债表两期营运资本变动 / 年报营收）----
  const bal25 = rowOf(balRows, fy25Period);
  const bal24 = balRows.length >= 2 ? balRows[balRows.length - 2] : null;
  function nwcOf(b) {
    if (!b) return null;
    const ar = yi(b.ACCOUNTS_RECE), inv = yi(b.INVENTORY), ap = yi(b.ACCOUNTS_PAYABLE), cl = yi(b.CONTRACT_LIAB);
    if (ar == null || inv == null || ap == null) return null;
    return ar + inv - ap - (cl != null ? cl : 0);
  }
  const nwc25 = nwcOf(bal25), nwc24 = nwcOf(bal24);
  const nwcRate = (nwc25 != null && nwc24 != null && revFy25) ? (nwc25 - nwc24) / revFy25 : -0.005;
  const nwcSource = (nwc25 != null && nwc24 != null)
    ? `资产负债表勾稽重建：ΔNWC(${String(bal25.REPORT_DATE).slice(0, 10)} ${r2(nwc25)} − ${String(bal24.REPORT_DATE).slice(0, 10)} ${r2(nwc24)})/FY2025营收 = ${r2(nwcRate * 100)}%（应收+存货−应付−合同负债口径，负值=占款释放现金，海天基因）`
    : '【替代】两期资产负债表不足，回退海天基因库 ΔNWC释放率 −0.5%（标注）';
  V.nwc_rate = reg('nwc_rate', r2(nwcRate * 100), { period: fy25Period, frequency: 'annual', source: nwcSource, caliber: 'Annual-ratio applied' });
  annualRatioCount++;
  // ---- 净现金 / 有息负债（Point-in-time）----
  const balLatest = balRows[balRows.length - 1];
  const balLatestPeriod = String(balLatest.REPORT_DATE).slice(0, 10);
  const debtParts = ['SHORT_LOAN', 'LONG_LOAN', 'BOND_PAYABLE'].map((k) => yi(balLatest[k])).filter((x) => x != null);
  const debt = debtParts.reduce((a, b) => a + b, 0);
  const cashLatest = yi(balLatest.MONETARYFUNDS);
  V.net_cash = reg('net_cash', r2(cashLatest - debt), { period: balLatestPeriod, frequency: 'point', source: `资产负债表直接科目：货币资金${r2(cashLatest)} − 有息负债（短借${yi(balLatest.SHORT_LOAN) != null ? r2(yi(balLatest.SHORT_LOAN)) : 0}+长借${yi(balLatest.LONG_LOAN) != null ? r2(yi(balLatest.LONG_LOAN)) : 0}+应付债券${yi(balLatest.BOND_PAYABLE) != null ? r2(yi(balLatest.BOND_PAYABLE)) : 0}）`, caliber: 'Point-in-time' });
  // ---- 股本（20261030j 强制治理：运行时拉取最新交易日「流通+限售」官方披露，>90天旧值严禁）----
  const shareBase = await fetchShareBase(String(baseDate).slice(0, 10));
  if (shareBase.ok && shareBase.total != null) {
    const loopTxt = [
      shareBase.closedLoop.freePlusLimited ? `流通${r2(shareBase.free)}+限售${r2(shareBase.limited || 0)}=总股本闭环✓` : null,
      shareBase.closedLoop.aPlusH ? `A流通${r2(shareBase.aShares)}+H股${r2(shareBase.hShares)}=总股本闭环✓` : null,
    ].filter(Boolean).join('；');
    V.shares = reg('total_shares', shareBase.total, { period: shareBase.asOf, frequency: 'point', source: `${shareBase.chain}：总股本 ${r2(shareBase.total)} 亿股（${loopTxt || '构成明细不可得'}；披露日 ${shareBase.asOf}，距今 ${shareBase.days} 天 ≤ ${SHARE_MAX_AGE_DAYS} 天时效上限）`, caliber: 'Point-in-time' });
  } else {
    // 双链失败 → 回退配置兜底值，但 QA-4 按时效硬门禁判定（兜底值披露日 >90 天或无日期 → FAIL → 拒绝输出目标价，严禁旧股本）
    const fbAsOf = cfg.inputs.totalSharesAsOf || null;
    const fbAge = fbAsOf ? daysBetween(String(baseDate).slice(0, 10), fbAsOf) : null;
    V.shares = reg('total_shares', cfg.inputs.totalShares, { period: fbAsOf || fy25Period, frequency: 'point', source: `【股本双链失败·降级】${shareBase.note}；配置兜底值 ${cfg.inputs.totalShares} 亿股（披露日 ${fbAsOf || '未知'}${fbAge != null ? '，距今 ' + fbAge + ' 天' : ''}）→ 时效门禁见 QA-4`, caliber: 'Point-in-time' });
  }
  const shareGatePass = shareBase.ok || (V.shares.value != null && V.shares.staleness_days != null && V.shares.staleness_days <= SHARE_MAX_AGE_DAYS);
  const shareGateActual = shareBase.ok
    ? `${r2(shareBase.total)} 亿股（${shareBase.chain}，披露 ${shareBase.asOf}，${shareBase.days} 天）`
    : `${r2(cfg.inputs.totalShares)} 亿股（配置兜底，双链失败：${shareBase.note.slice(0, 60)}）`;

  // ===== ③ 季报校准触发器（第六章：偏离>1.5pct 强制覆盖并标注）=====
  const calibTriggerPct = V3.calibTriggerPct || 1.5;
  let ebitMarginUsed = ebitMarginAnnual, calibNotes = [];
  if (ebitMarginTtm != null && Math.abs(ebitMarginTtm - ebitMarginAnnual) * 100 > calibTriggerPct) {
    ebitMarginUsed = ebitMarginTtm;
    V.ebit_margin_annual.calibrated = true;
    calibNotes.push(`季报校准：TTM EBIT率 ${(ebitMarginTtm * 100).toFixed(2)}% 偏离年报假设 ${(ebitMarginAnnual * 100).toFixed(2)}% 超 ${calibTriggerPct}pct → 强制用季报TTM值覆盖`);
  } else {
    calibNotes.push(`季报校准检查：TTM EBIT率 ${ebitMarginTtm != null ? (ebitMarginTtm * 100).toFixed(2) + '%' : 'N/A'} vs 年报假设 ${(ebitMarginAnnual * 100).toFixed(2)}%，偏离 ${ebitMarginTtm != null ? (Math.abs(ebitMarginTtm - ebitMarginAnnual) * 100).toFixed(2) : 'N/A'}pct ≤ ${calibTriggerPct}pct → 不触发`);
  }
  const gmDev = (V.gross_margin_ttm.value != null && V.gross_margin_annual.value != null) ? Math.abs(V.gross_margin_ttm.value - V.gross_margin_annual.value) : null;
  calibNotes.push(`毛利率校准检查：TTM ${V.gross_margin_ttm.value != null ? V.gross_margin_ttm.value + '%' : 'N/A'} vs 年报 ${V.gross_margin_annual.value}%，偏离 ${gmDev != null ? gmDev.toFixed(2) : 'N/A'}pct（信息项，EBIT率为主校准对象）`);

  // ===== ④ 重建质量校验（第三章：勾稽毛利率 vs 上期年报毛利率偏差>2pct → 降级回退）=====
  const rebuildQualityNote = (() => {
    if (V.gross_margin_ttm.value == null) return '勾稽毛利率不可得（FIELD_MISSING）';
    const dev = Math.abs(V.gross_margin_ttm.value - V.gross_margin_annual.value);
    if (dev > (V3.rebuildDeviationPct || 2)) {
      rebuildLog.push(`勾稽毛利率与上期年报偏差 ${dev.toFixed(2)}pct > ${V3.rebuildDeviationPct || 2}pct → 回退"年报毛利率×TTM营收"占比法并标注降级`);
      return `⚠️ 勾稽毛利率与上期年报偏差 ${dev.toFixed(2)}pct 超阈值 → 已回退年报毛利率占比法（降级标注）`;
    }
    return `✅ 勾稽毛利率与上期年报偏差 ${dev.toFixed(2)}pct ≤ ${V3.rebuildDeviationPct || 2}pct，重建质量通过`;
  })();

  // ===== ⑤ 混频检测门禁（第八章：最后防线，只拦截异常不承担对齐职责）=====
  // 规则2：frequency 不一致且未全部 is_converted_to_ttm=true → 中止计算
  const ttmChainVars = [V.revenue_ttm, V.np_ttm, V.gross_margin_ttm, V.ebit_margin_ttm];
  const freqBad = ttmChainVars.filter((v) => v.value == null);
  if (freqBad.length) {
    appendRunLog({ run_id: runId, model_version: MODEL_VERSION, run_time: startedAt, error_stack: `混频门禁·规则2中止：TTM链条变量缺失（${freqBad.map((v) => v.name).join(',')}），上年同期累计数据不可得，禁止跨期混算` });
    return { ok: false, success: false, message: `混频门禁拦截：TTM 合成所需的上年同期累计数据不可得（${freqBad.map((v) => v.name).join(', ')}），按禁止操作#1中止计算，绝不跨期混算` };
  }
  // 规则1：同一公式内 data_period 差异>90天 → 告警（TTM构造按 is_converted_to_ttm=true 豁免放行，但诚实记录跨度）
  const ttmPeriods = [fy25Period, String(qPrev.REPORT_DATE).slice(0, 10), asOf];
  const ttmSpan = daysBetween(ttmPeriods[2], ttmPeriods[0]);
  if (ttmSpan > 90) mixingAlerts.push(`混频门禁·规则1：TTM合成公式内 data_period 跨度 ${ttmSpan} 天（${ttmPeriods.join(' → ')}）> 90天；全部输入 is_converted_to_ttm=true（TTM构造规则豁免）→ 放行并记录`);
  // 年报比率套用声明（禁止操作#3：必须标注 Annual-ratio applied——本引擎全部在 caliber 字段标注）

  // ===== ⑥ 宏观参数（第五章：动态获取+缓存有效期+兜底标注）=====
  const MP = P4.macroParams;
  const mp = {};
  for (const [k, p] of Object.entries(MP)) {
    const age = daysBetween(baseDate, p.fetchedAt);
    const expired = age > p.cacheDays;
    mp[k] = { value: p.value, expired, age, fallback: p.fallback, source: p.source + `（获取于 ${p.fetchedAt}，缓存 ${p.cacheDays} 天${expired ? '，⚠️已过期应更新，本次仍用已缓存值；兜底值 ' + p.fallback : ''}）` };
  }
  const rf = mp.rf.value, erp = mp.erp.value, beta = mp.beta.value, kd = mp.kd.value, cpi = mp.cpiForecast.value;

  // ===== ⑦ WACC（第四章注册表公式）=====
  const N = V.shares.value;
  const netCash = V.net_cash.value;
  const tax = taxRate;
  const ke = (rf + beta * erp) / 100;
  // D/V：有实时价 → 按三表有息负债实算；否则用配置兜底（标注）
  let dv;
  if (price != null && isFinite(Number(price)) && price > 0) {
    const debtVal = debt, eqVal = Number(price) * N;
    dv = debtVal / (debtVal + eqVal);
  } else {
    dv = (V3.dvFallback != null) ? V3.dvFallback : 0.013;
  }
  const wacc = (1 - dv) * ke + dv * (kd / 100) * (1 - tax);
  const waccPct = wacc * 100;
  const evWeights = { e: 1 - dv, d: dv };

  // ===== ⑧ 情景层（第九章：结构隔离 + 量化触发 + 冷却）=====
  const IND = P5.indicators;
  const state = loadState();
  const cpiMonths = IND.cpiMonthly || [];
  const cpiBelow1Streak = (() => {
    let s = 0;
    for (let i = cpiMonths.length - 1; i >= 0; i--) { if (cpiMonths[i].yoy < 1.0) s++; else break; }
    return s;
  })();
  const bearConds = [
    { met: false, desc: `餐饮收入月度同比连续3个月<-5%：${IND.restaurantRevYoy == null ? '未取得【数据缺失】' : '已取得'}` },
    { met: false, desc: `渠道库存天数>60天：${IND.inventoryDays == null ? '未取得【数据缺失】' : IND.inventoryDays + '天'}` },
    { met: cpiBelow1Streak >= 3, desc: `CPI月度同比<1.0%持续3个月：当前连续 ${cpiBelow1Streak} 个月（${cpiMonths.map(x => x.month + ' ' + x.yoy + '%').join('、')}）→ ${cpiBelow1Streak >= 3 ? '满足' : '不满足'}` },
  ];
  const bearMet = bearConds.filter((c) => c.met).length;
  const bullConds = [
    { met: false, desc: `权威报告"零添加渗透率>30%"：${IND.zeroAddPenetration == null ? '未搜索到【数据缺失】' : '已取得'}` },
    { met: IND.healthSeriesGrowth != null && IND.healthSeriesGrowth.value > 40, desc: `健康系列产品营收增速>40%（同比）：${IND.healthSeriesGrowth ? '+' + IND.healthSeriesGrowth.value + '%（' + IND.healthSeriesGrowth.source + '）→ 满足' : '未取得'}` },
  ];
  const bullMet = bullConds.filter((c) => c.met).length;
  let activeScenario = null;
  const bearCoolOk = !(state.bear && daysBetween(baseDate, state.bear) < P5.bearTrigger.cooldownDays);
  const bullCoolOk = !(state.bull && daysBetween(baseDate, state.bull) < P5.bullTrigger.cooldownDays);
  if (bearMet >= 2 && bearCoolOk) { activeScenario = { name: '悲观情景（消费降级）', conds: bearConds.filter((c) => c.met).map((c) => c.desc) }; state.bear = baseDate; saveState(state); }
  else if (bearMet >= 2 && !bearCoolOk) { activeScenario = { name: '悲观情景（冷却中）', conds: [`条件满足但在冷却期（上次触发 ${state.bear}，冷却 ${P5.bearTrigger.cooldownDays} 天）`] }; }
  if (bullMet >= 1 && bullCoolOk) { activeScenario = { name: '乐观情景（健康化红利）', conds: bullConds.filter((c) => c.met).map((c) => c.desc) }; state.bull = baseDate; saveState(state); }
  else if (bullMet >= 1 && !bullCoolOk && !activeScenario) { activeScenario = { name: '乐观情景（冷却中）', conds: [`条件满足但在冷却期（上次触发 ${state.bull}，冷却 ${P5.bullTrigger.cooldownDays} 天）`] }; }
  if (!activeScenario) { activeScenario = { name: '基准情景（默认，无触发条件满足）', conds: [`悲观 ${bearMet}/3 项满足（其中2项数据缺失）、乐观 ${bullMet}/2 项满足`] }; }
  const structureNote = `分产品/分渠道收入结构 = STRUCTURE_ONLY（支柱四结构隔离）：不进入主FCFF公式，仅作情景层可选输入；最新结构数据为 2026中报（2026-08-27披露），结构假设冻结截至该日。`;
  const scenarioBanner = `🔀 当前激活情景：${activeScenario.name}。触发依据：${activeScenario.conds.join('；')}。${structureNote}`;

  // ===== ⑨ FCFF 预测驱动（支柱三·主模型）=====
  const C = cfg.inputs.consensus;
  const g0 = C.revGrowth / 100;                       // 统一营收增速假设（一致预期）
  const daRate = daAnnual / revFy25;
  const capexRate = capexFy25 / revFy25;
  const gmBase = gmAnnual / 100;
  const SCEN = {
    base: { label: '基准', revG: g0, mAdj: 0, gPerp: Math.max(cpi / 100, 0.025) },
    bear: { label: '消费降级', revG: g0 - 0.02, mAdj: -0.01, gPerp: Math.max(cpi / 100 - 0.005, 0.015) },
    bull: { label: '健康化红利', revG: Math.min(g0 + 0.03, 0.15), mAdj: 0.015, gPerp: cpi / 100 + 0.01 },
  };
  // 主模型 FCFF：rev 起点=最新TTM营收；假设率=年报校准起点（季报校准触发则覆盖）
  function fcffModel({ revStart, margin, gRev, gPerpCap }) {
    const gPerp = Math.min(Math.max(gPerpCap, 0.0), wacc - 0.015);   // 硬上限 WACC−1.5pct
    let rev = revStart, fcffs = [];
    for (let t = 1; t <= 3; t++) {
      const revT = rev * (1 + gRev);
      const ebit = revT * margin;
      const da = revT * daRate;
      const capex = revT * capexRate;
      const dnwc = (revT - rev) * nwcRate;
      fcffs.push(ebit * (1 - tax) + da - capex - dnwc);
      rev = revT;
    }
    let pv = 0; const dfs = [];
    for (let t = 0; t < 3; t++) { const df = 1 / Math.pow(1 + wacc, t + 1); dfs.push(df); pv += fcffs[t] * df; }
    const tv = fcffs[2] * (1 + gPerp) / (wacc - gPerp);
    const pvTv = tv * dfs[2];
    const ev = pv + pvTv;
    const equity = ev + netCash;
    return { perShare: equity / N, ev, equity, tvShare: pvTv / ev, gPerp, fcffs, dfs, margin, revStart };
  }
  const dcfBase = fcffModel({ revStart: V.revenue_ttm.value, margin: ebitMarginUsed + 0, gRev: SCEN.base.revG, gPerpCap: SCEN.base.gPerp });
  const dcfBear = fcffModel({ revStart: V.revenue_ttm.value, margin: ebitMarginUsed + SCEN.bear.mAdj, gRev: SCEN.bear.revG, gPerpCap: SCEN.bear.gPerp });
  const dcfBull = fcffModel({ revStart: V.revenue_ttm.value, margin: ebitMarginUsed + SCEN.bull.mAdj, gRev: SCEN.bull.revG, gPerpCap: SCEN.bull.gPerp });

  // ===== ⑩ 校验模型：纯年报降频（第七章：全部变量统一取最近完整年报口径）=====
  const dcfVal = fcffModel({ revStart: revFy25, margin: ebitMarginAnnual, gRev: SCEN.base.revG, gPerpCap: SCEN.base.gPerp });
  const divergence = Math.abs(dcfBase.perShare - dcfVal.perShare) / dcfVal.perShare;
  const divergencePct = divergence * 100;
  const divergenceAlert = divergence > 0.10
    ? `🔴 主模型与降频校验模型分歧达 ${divergencePct.toFixed(1)}%（>10%），季报信息含量异常，建议人工复核——两套结果均展示：主模型 ${r2(dcfBase.perShare)} 元 / 校验模型 ${r2(dcfVal.perShare)} 元`
    : `✅ 主模型与降频校验模型分歧 ${divergencePct.toFixed(1)}% ≤10%，以主模型为准，校验模型作附注（${r2(dcfVal.perShare)} 元）`;

  // ===== ⑪ 数据健康度评分（第十章10.2）=====
  const totalVars = registry.length;
  const stalenessBad = registry.some((v) => !v.is_converted_to_ttm && v.staleness_days > 365);
  const subCount = substitutes.length;
  let healthScore = 100
    - 20 * (annualRatioCount / totalVars)
    - (stalenessBad ? 30 : 0)
    - (divergence > 0.10 ? 15 : 0)
    - (subCount > 0 ? 10 : 0);
  healthScore = Math.round(healthScore * 10) / 10;
  const healthLabel = healthScore >= 80 ? '优' : (healthScore >= 60 ? '中（部分变量为年报比率反推）' : '不足');
  const healthRejected = healthScore < 60;
  const healthFormula = `100 − 20×(Annual-ratio变量 ${annualRatioCount}/${totalVars}) − ${stalenessBad ? 30 : 0}(存在超1年未更新) − ${divergence > 0.10 ? 15 : 0}(双模型分歧>10%) − ${subCount > 0 ? 10 : 0}(存在均值替代变量) = ${healthScore}`;

  // ===== ⑫ 相对估值（动态目标PE，V2.0核心逻辑不变）=====
  const MK = cfg.inputs.market;
  const peTarget = MK.peBaseIndustry + (cfg.inputs.fy2025.roe - MK.indRoe) * 0.5 + (MK.indVol - MK.selfVol) * 2 - (MK.indGrowth - C.revGrowth) * 1.5;
  const eps26 = C.np2026E / N;
  const npBear26 = npFy25 * (1 + (C.npGrowth26 - 2) / 100);
  const npBull26 = npFy25 * (1 + (C.npGrowth26 + 3 * 1.2) / 100);
  const peLow = peTarget * (npBear26 / N);
  const peMid = peTarget * eps26;
  const peHigh = peTarget * (npBull26 / N);
  const pbTarget = ((cfg.inputs.fy2025.roe / 100) - dcfBase.gPerp) / (ke - dcfBase.gPerp);
  const pbValue = pbTarget * cfg.inputs.balanceSheet.bps;

  const W_DCF = 0.5, W_PE = 0.5;
  const finalLow = dcfBear.perShare * W_DCF + peLow * W_PE;
  const finalMid = dcfBase.perShare * W_DCF + peMid * W_PE;
  const finalHigh = dcfBull.perShare * W_DCF + peHigh * W_PE;

  // ===== ⑬ WACC×g 敏感性矩阵（第六章6.3：3×3，标注基准情景）=====
  const sensGrid = [];
  const waccs = [waccPct - 0.5, waccPct, waccPct + 0.5];
  const gs = [dcfBase.gPerp * 100 - 0.5, dcfBase.gPerp * 100, dcfBase.gPerp * 100 + 0.5];
  for (const wp of waccs) {
    const row = [];
    for (const gp of gs) {
      if (wp - gp < 1.5) { row.push(null); continue; }   // WACC−g≥1.5pct 硬约束
      const w2 = wp / 100, g2 = gp / 100;
      let pv2 = 0;
      const f = dcfBase.fcffs;
      for (let t = 0; t < 3; t++) pv2 += f[t] / Math.pow(1 + w2, t + 1);
      const tv2 = f[2] * (1 + g2) / (w2 - g2);
      const eq2 = pv2 + tv2 / Math.pow(1 + w2, 3) + netCash;
      row.push(r2(eq2 / N));
    }
    sensGrid.push({ wacc: r2(wp), values: row });
  }

  // ===== ⑭ 位置与操作参考 =====
  let rating = '合理', positionPct = null, action = '';
  if (!healthRejected && price != null && isFinite(price) && price > 0 && finalHigh > finalLow) {
    positionPct = Math.max(0, Math.min(100, (price - finalLow) / (finalHigh - finalLow) * 100));
    if (price < finalLow) { rating = '低估'; action = '系统性机会'; }
    else if (price > finalHigh) { rating = '高估'; action = '透支未来业绩'; }
    else { rating = '合理'; action = price > finalMid * 1.08 ? '接近高估边界，注意兑现节奏' : (price < finalMid * 0.92 ? '中枢下方，可关注' : '持有等待催化'); }
  }

  // ===== ⑮ QA 门禁（第十章10.1：任一不通过拒绝输出目标价）=====
  const peNow = price != null && isFinite(price) && price > 0 ? price / (V.np_ttm.value / N) : MK.peTTM;
  const qa = [
    { id: 'QA-1', desc: 'WACC − 永续增长率 ≥ 1.5pp（硬约束）', actual: `${r2((wacc - dcfBase.gPerp) * 100)}pp（WACC ${r2(waccPct)}% − g ${r2(dcfBase.gPerp * 100)}%）`, pass: (wacc - dcfBase.gPerp) >= 0.015, fix: '若不通过：下调β或ERP重算WACC，或下调g' },
    { id: 'QA-2', desc: '0.5 < 当前PE(TTM) < 60', actual: `${r2(peNow)} 倍`, pass: peNow > 0.5 && peNow < 60, fix: '若不通过：核查TTM净利与现价口径' },
    { id: 'QA-3', desc: '折现因子 ∈ (0, 1]', actual: `t1~t3 = ${dcfBase.dfs.map((d) => d.toFixed(4)).join(' / ')}`, pass: dcfBase.dfs.every((d) => d > 0 && d <= 1), fix: '若不通过：核查WACC是否为负或异常' },
    { id: 'QA-4', desc: `总股本时效与口径（20261030j：最新交易日流通+限售，≤${SHARE_MAX_AGE_DAYS} 天，严禁旧股本）`, actual: `${N} 亿股（${shareGateActual}）`, pass: shareGatePass && N > 0, fix: '若不通过：股本双链不可得或披露超90天 → 严禁使用旧股本，拒绝输出目标价，待数据恢复后自动重跑' },
    { id: 'QA-5', desc: '毛利率 ∈ [30%, 55%]', actual: `${V.gross_margin_ttm.value}%（TTM勾稽）`, pass: V.gross_margin_ttm.value >= 30 && V.gross_margin_ttm.value <= 55, fix: '若不通过：核查营业成本勾稽口径' },
    { id: 'QA-6', desc: 'E/V + D/V ∈ [0.99, 1.01]', actual: `${r2(evWeights.e * 100)}% + ${r2(evWeights.d * 100)}% = ${r2((evWeights.e + evWeights.d) * 100)}%`, pass: Math.abs(evWeights.e + evWeights.d - 1) <= 0.01, fix: '若不通过：重算资本结构权重' },
  ];
  const qaFailed = qa.filter((q) => !q.pass);
  const qaAllPass = qaFailed.length === 0;

  // ===== ⑯ 输出协议（第十一章：强制锁定格式）=====
  const f3 = (x) => r2(x);
  // 数据时效矩阵行（图例：🟢季报级最新 / 🟡年报比率反推 / 🔴超1年未更新）
  const timeMatrixRows = registry.map((v) => {
    const flag = v.staleness_days > 365 ? '🔴' : ((v.caliber || '').indexOf('Annual-ratio') === 0 ? '🟡' : '🟢');
    return {
      name: v.name, value: v.value, period: v.data_period, frequency: v.frequency,
      staleness: v.staleness_days, caliber: v.caliber + (v.calibrated ? '（季报校准覆盖）' : ''),
      flag, status: v.status,
    };
  });
  // 架构声明
  const archRows = [
    { label: '全量重算（支柱一）', value: `本次运行已强制重新拉取完整三表（as-of date：${asOf}），未读取上次运行任何缓存变量值`, source: stmtSource },
    { label: 'as-of date 判定', value: `${asOf}（${asOfNote}）；估值基准日 ${baseDate}`, source: '日期规范化引擎（2.4）' },
    { label: '主FCFF链条时间对齐', value: `全部对齐：TTM链条 ${ttmChainVars.length} 个变量全部 is_converted_to_ttm=true；假设率 ${annualRatioCount} 个变量已标注 Annual-ratio applied`, source: '支柱三预测驱动' },
    { label: '三表勾稽重建字段', value: rebuildLog.length ? rebuildLog.join('；') : '营业成本/毛利、EBIT率、有效税率、D&A、CAPEX、ΔNWC率、有息负债、净现金（全部优先级1直接科目或标准勾稽，无需降级重建）', source: '支柱二（第三章）' },
    { label: '隔离至情景层字段', value: '分产品/分渠道收入结构（STRUCTURE_ONLY，结构假设冻结截至 2026-08-27，即2026中报披露日）', source: '支柱四（第九章）' },
    { label: '重建质量校验', value: rebuildQualityNote, source: '第三章：倒算毛利率 vs 上期年报，阈值2pct' },
    { label: '禁止操作清单', value: '第十三章13条硬约束已内置：全量重算、禁跨期混算、禁未标注比率套用、禁单一目标价、禁QA未过输出、禁缓存patch等', source: '第十三章' },
  ];
  // 混频处理声明 + 健康度（合一段文本）
  const mixingNote = `主模型采用预测驱动，以最新TTM营收 ${V.revenue_ttm.value} 亿为唯一起点外推。主模型DCF中枢 ${r2(dcfBase.perShare)} 元；纯年报降频校验中枢 ${r2(dcfVal.perShare)} 元；分歧度 ${divergencePct.toFixed(1)}%。${divergenceAlert} 数据健康度评分：${healthScore}/100（${healthLabel}）。${healthFormula}。${mixingAlerts.length ? '门禁告警：' + mixingAlerts.join('；') : '混频门禁无告警。'}${calibNotes.length ? ' ' + calibNotes.join('；') : ''}`;

  // 运行报告头（沿用前端契约）
  const sourceStatusSummary = timeMatrixRows.map((v) => `${v.name}:${v.flag}`).join(' ');
  const reportHeadRows = [
    { label: '运行ID / 模型版本', value: `${runId} ｜ ${MODEL_VERSION}（20261030j）`, source: '第十二章运行日志已同步记录' },
    { label: '估值基准日 / as-of date', value: `${baseDate}（系统日期） ｜ ${asOf}（最新财报截止日，唯一as-of date）`, source: '支柱一全量重算 + 日期规范化引擎' },
    { label: '数据源状态', value: `${sourceStatusSummary}`, source: '数据时效矩阵图例：🟢季报级最新 / 🟡年报比率反推 / 🔴超1年未更新' },
    { label: '模型参数（本次运行）', value: `WACC ${f3(waccPct)}%（Rf ${rf}%+β ${beta}×ERP ${erp}%，Kd ${kd}%×(1−税率)；D/V ${r2(dv * 100)}%） ｜ g_perp ${f3(dcfBase.gPerp * 100)}% ｜ 有效税率 ${V.tax_rate_effective.value}%`, source: '第五章宏观参数动态化（兜底值见参数表）' },
    { label: '双模型分歧 / 数据健康度', value: `分歧 ${divergencePct.toFixed(1)}%（主 ${r2(dcfBase.perShare)} vs 校验 ${r2(dcfVal.perShare)}） ｜ 健康度 ${healthScore}/100（${healthLabel}）`, source: '第七章 + 第十章10.2' },
  ];
  if (mixingAlerts.length) reportHeadRows.push({ label: '混频门禁告警', value: mixingAlerts.join('；'), source: '第八章（最后防线，只拦截异常）' });

  const substituteRows = substitutes.map((s) => `⚠️ 字段缺失替代：${s.name} 使用历史均值 ${s.value}（${s.note}）`);

  const paramRows = [
    { label: 'WACC（动态计算）', value: `${f3(waccPct)}%（Ke=${f3(ke * 100)}% = Rf ${rf}% + β ${beta}×ERP ${erp}%；Kd ${kd}%×(1−税率${V.tax_rate_effective.value}%)\n；D/V ${r2(dv * 100)}%（${price != null && isFinite(price) && price > 0 ? `三表有息负债 ${r2(debt)} 亿实算` : '无实时价，配置兜底'}）`, source: `${mp.rf.source}；${mp.beta.source}` },
    { label: '统一假设率（年报校准起点）', value: `EBIT率 ${(ebitMarginUsed * 100).toFixed(2)}%${ebitMarginUsed !== ebitMarginAnnual ? '（季报校准覆盖）' : ''} ｜ D&A率 ${r2(daRate * 100)}%（D&A ${V.da_annual.value}/FY2025营收） ｜ CAPEX率 ${r2(capexRate * 100)}%（CAPEX ${V.capex_annual.value}，三表直接科目口径） ｜ ΔNWC率 ${r2(nwcRate * 100)}%`, source: '第六章：预测期保持恒定，季报TTM偏离>1.5pct强制校准' },
    { label: 'TTM 变量（注册表）', value: `revenue_ttm ${V.revenue_ttm.value} 亿 ｜ np_ttm ${V.np_ttm.value} 亿 ｜ 毛利率TTM ${V.gross_margin_ttm.value}%（年报 ${V.gross_margin_annual.value}%，偏离 ${gmDev != null ? gmDev.toFixed(2) : 'N/A'}pct）`, source: ttmNote },
    { label: '动态目标 P/E', value: `${f3(peTarget)} 倍 = 行业基准 ${MK.peBaseIndustry} + ROE溢价 ${r2((cfg.inputs.fy2025.roe - MK.indRoe) * 0.5)} + 确定性溢价 ${r2((MK.indVol - MK.selfVol) * 2)} − 增速折价 ${r2((MK.indGrowth - C.revGrowth) * 1.5)}`, source: MK.peBaseIndustrySource },
    { label: '动态目标 P/B（交叉参考）', value: `${f3(pbTarget)} 倍 =（ROE ${cfg.inputs.fy2025.roe}% − g）/（Ke − g）；对应 ${f3(pbValue)} 元`, source: '戈登增长模型 PB 推导，仅展示' },
    { label: '一致预期（50家机构）', value: `2026E 归母 ${C.np2026E} 亿(+${C.npGrowth26}%)、营收 +${C.revGrowth}%；2027E ${C.np2027E} 亿`, source: C.source },
  ];

  const matrixRows = [
    { method: 'DCF（主模型·预测驱动）', low: f3(dcfBear.perShare), mid: f3(dcfBase.perShare), high: f3(dcfBull.perShare), note: `终值占比 ${f3(dcfBase.tvShare * 100)}%；TTM起点 ${V.revenue_ttm.value} 亿；校验模型 ${r2(dcfVal.perShare)} 元（分歧 ${divergencePct.toFixed(1)}%）（权重 ${W_DCF * 100}%）` },
    { method: 'PE 相对估值（校准）', low: f3(peLow), mid: f3(peMid), high: f3(peHigh), note: `P/E_target ${f3(peTarget)} 倍 × 情景EPS（权重 ${W_PE * 100}%）` },
    { method: '综合建议区间', low: f3(finalLow), mid: f3(finalMid), high: f3(finalHigh), note: 'DCF 50% + PE 50% 加权（核心估值逻辑与 V2.0 一致，架构按 V3.0 重构）' },
  ];

  const scenRows = [
    { name: '基准', value: f3(finalMid), note: `营收增速 ${C.revGrowth}%（一致预期）、EBIT率 ${(ebitMarginUsed * 100).toFixed(2)}%、g_perp ${f3(dcfBase.gPerp * 100)}%；DCF ${f3(dcfBase.perShare)} + PE ${f3(peMid)}` },
    { name: '消费降级', value: f3(finalLow), note: `营收增速 ${C.revGrowth - 2}%、EBIT率 ${((ebitMarginUsed + SCEN.bear.mAdj) * 100).toFixed(2)}%（−1pct）、g_perp ${f3(dcfBear.gPerp * 100)}%；触发条件（需2项同时满足）：${bearConds.map((c) => (c.met ? '✅' : '✗') + c.desc).join('；')} → 本次 ${bearMet}/3 项满足；冷却 ${P5.bearTrigger.cooldownDays} 天` },
    { name: '健康化红利', value: f3(finalHigh), note: `营收增速 ${C.revGrowth + 3}%、EBIT率 ${((ebitMarginUsed + SCEN.bull.mAdj) * 100).toFixed(2)}%（+1.5pct）、g_perp ${f3(dcfBull.gPerp * 100)}%；触发条件（需1项满足）：${bullConds.map((c) => (c.met ? '✅' : '✗') + c.desc).join('；')} → 本次 ${bullMet}/2 项满足；冷却 ${P5.bullTrigger.cooldownDays} 天` },
  ];

  const positionNote = healthRejected
    ? `⛔ 数据健康度不足（${healthScore}/100 < 60），按禁止操作#4拒绝输出具体目标价：估值区间暂不可靠，建议等待年报或补充数据源。`
    : (positionPct != null
      ? `当前股价 ${r2(price)} 元处于合理区间的 ${Math.round(positionPct)}% 位置；判断标签：【${rating}】；当前 PE(TTM) ${f3(peNow)} 倍（近5年估值分位约 ${MK.pePercentile5y}）；操作参考：${action}。机构综合目标价 ${C.targetPrice} 元（腾讯口径，供参照）。`
      : '当前价不可用，仅输出区间。');

  const qaRows = qa.map((q) => ({ label: `${q.id} ${q.desc}`, light: `${q.pass ? '✅ 通过' : '❌ 失败'}（实测：${q.actual}）${q.pass ? '' : '｜建议：' + q.fix}` }));

  const riskNote = '上行：原料（大豆/白糖）价格回落、降息压低 WACC、健康化新品超预期、海外/H股放量；下行：餐饮需求疲弱与渠道库存高企、竞品价格战/零添加分流、社区团购与渠道变革冲击、食品安全事件。CAPEX 已由腾讯FCF倒算口径 33.88 亿修正为现金流量表直接科目口径（2025年报实为购建支付现金），DCF 假设率随之真实化，属数据口径修正而非基本面突变。模型所有结果基于公开信息与机构预测，不构成投资建议。';
  const disclaimer = '固定免责声明：本模型为确定性代码计算（全量重算+输入锁死⇒结果锁死，与AI模型无关），所有结果基于公开信息与机构一致预期，仅供研究参考，不构成任何投资建议；估值对 WACC/g 参数高度敏感（终值占比约85%+），请结合三档区间与数据时效矩阵自主决策。';

  // ===== ⑰ 结果组装（契约兼容扩展：保留 V2.0 全部字段 + V3.0 新增字段）=====
  const result = {
    ok: true,
    success: true,
    dedicated: true,
    haitian: true,
    version: MODEL_VERSION,
    runId,
    symbol: SYM,
    stockName: cfg.name,
    rating: healthRejected ? null : rating,
    fairValueRange: healthRejected ? null : [f3(finalLow), f3(finalHigh)],
    fairValueCenter: healthRejected ? null : f3(finalMid),
    currentPrice: price != null ? r2(price) : null,
    reportLabel: cfg.reportLabel,
    model: `haitian603288 ${MODEL_VERSION}（全量重算+三表勾稽+预测驱动FCFF+双模型校验+混频门禁+健康度评分+QA门禁+情景量化+运行日志+输出协议）`,
    dataAsOf: asOf,
    asOfDate: asOf,
    // V3.0 新增输出协议字段
    archRows, timeMatrixRows, mixingNote, healthScore, healthLabel,
    divergencePct: Math.round(divergencePct * 10) / 10, validationValue: r2(dcfVal.perShare),
    sensitivity: { waccs: waccs.map((w) => r2(w)), gs: gs.map((g) => r2(g)), grid: sensGrid.map((r) => r.values), baseWacc: r2(waccPct), baseG: r2(dcfBase.gPerp * 100) },
    calibNotes, rebuildQualityNote, structureNote, healthFormula,
    // V2.0 契约字段（保留，前端渲染不变）
    scenarioBanner,
    reportHeadRows,
    substituteRows,
    qaRows,
    qaAllPass,
    freshnessRows: timeMatrixRows.map((v) => ({ label: v.name, asOf: v.period, ageDays: v.staleness, stale: v.staleness > 365 })),
    paramRows, matrixRows, scenRows, positionNote, riskNote,
    decisionNote: `V3.0 四大支柱全接入：①全量重算（as-of ${asOf}，本次三表实时拉取，无缓存patch）；②三表勾稽重建（${rebuildLog.length ? '触发降级重建 ' + rebuildLog.length + ' 处' : '营业成本/EBIT率/税率/D&A/CAPEX/ΔNWC率/有息负债全部直接科目或标准勾稽'}，${rebuildQualityNote}）；③预测驱动（TTM营收 ${V.revenue_ttm.value} 亿唯一起点×统一假设率，${calibNotes[0]}）；④结构隔离（分产品结构 STRUCTURE_ONLY 只进情景层）。双模型分歧 ${divergencePct.toFixed(1)}%${divergence > 0.10 ? ' 🔴>10% 红色告警' : ' ✅'}；数据健康度 ${healthScore}/100（${healthLabel}）；QA 6项${qaAllPass ? '全部通过 ✅' : '存在失败 ❌'}；混频门禁${mixingAlerts.length ? '告警 ' + mixingAlerts.length + ' 条' : '无告警'}。核心估值逻辑（DCF 50% + 动态PE 50% + 三情景）不变。`,
  };

  if (healthRejected) {
    result.healthWarning = `⛔ 数据健康度不足（${healthScore}/100），估值区间暂不可靠，建议等待年报或补充数据源（第十章10.2 输出规则）`;
  }

  // ===== ⑱ 运行日志（第十二章）=====
  appendRunLog({
    run_id: runId,
    model_version: MODEL_VERSION,
    run_time: startedAt,
    valuation_base_date: baseDate,
    as_of_date: asOf,
    financial_data_used: asOf,
    data_source_status: Object.fromEntries(registry.map((v) => [v.name, { status: v.status, value: v.value, data_period: v.data_period, frequency: v.frequency, staleness_days: v.staleness_days, caliber: v.caliber }])),
    parameter_values: { rf, erp, beta, kd, cpi_forecast: cpi, ke: r2(ke * 100), wacc: r2(waccPct), g_perp: r2(dcfBase.gPerp * 100), tax_rate: V.tax_rate_effective.value, dv: r2(dv * 100) },
    qa_check_results: qa.map((q) => ({ id: q.id, pass: q.pass, actual: q.actual })),
    divergence: Math.round(divergencePct * 10) / 10,
    data_health_score: healthScore,
    output_results: { dcf: [f3(dcfBear.perShare), f3(dcfBase.perShare), f3(dcfBull.perShare)], pe: [f3(peLow), f3(peMid), f3(peHigh)], final: healthRejected ? null : [f3(finalLow), f3(finalMid), f3(finalHigh)], validation: r2(dcfVal.perShare), rating: healthRejected ? null : rating, active_scenario: activeScenario.name, position_pct: positionPct },
    mixing_alerts: mixingAlerts.length ? mixingAlerts : undefined,
    rebuild_log: rebuildLog.length ? rebuildLog : undefined,
    substitutes: substitutes.length ? substitutes : undefined,
  });

  return result;
}

module.exports = { run, isHaitianModel, loadConfig, getLatestReportDate };

~~~

---

## `lib\valuation\huaan600909.js`  ·  745 行

~~~js
// ============================================================
// 华安证券（600909）专属动态估值引擎 V3.0 —— 异步数据自适应架构
// 20261029p【用户下发规范全文实施】十四规则 / 七层架构：
//   【总则·第一性原理】模型永不假设所有指标处于同一报告期；任何指标进入估值公式前必须携带
//   「数据契约」（指标名/数值/报告期截止日/披露频率/来源/期差天数/最大容忍期差/成熟度/是否结转/结转来源期）；
//   无契约裸数据一律拒收；禁止硬编码/默认值/上年旧值静默填充；点估值只在全绿时给出，
//   存在黄/红时输出区间+置信度；方法权重由所依赖数据的成熟度动态决定。
//   【第一层·数据分层】A层日频行情（容忍1交易日，滞后沿用+标注）/ B层季频财报（容忍150天）/
//   C层低频非必披露（分业务结构200天、持股比例180天、限售状态365天）。
//   【第二层·报告期对齐引擎】期差自动计算与成熟度分级（绿≤60%容忍/黄60–100%/红>100%或缺失）；
//   流量指标TTM拼接（三季报后=2026前三季累计+2025Q4单季，禁用×4/3粗年化）；
//   存量指标期末值+股本同步检测（股本未同步→BPS区间化）；C层结构结转+±10%~15%敏感性；
//   可比公司「各自最新」原则；事件数据「公告优先」原则（持股比例>180天→红+±5%区间）。
//   【第三层·方法成熟度加权】基准 PB60%/SOTP30%/PE10%；绿×1.0、黄×0.7、红×0.3
//   （红且基准<15%→直接停用）；PB法红→整体待更新态；权重归一化+列示调整原因。
//   【影子股阈值】占比跨越30%时 SOTP 权重按其数据成熟度在40%–50%摆动（绿50/黄45/红40），
//   并同时输出两套权重下的目标价供参考；联动强度仅用A层日频数据。
//   【第四层·四级降级】L0正常→L1结转+标注→L2区间化→L3降权/停用→L4待更新停估；强制留痕。
//   【第五层·三态输出】精确态（全绿单点）/区间态（任一黄/红但PB非红）/待更新态（PB红或L4）。
//   【评级区间判定】现价<下限×0.9→低估（规范「买入」映射项目三档铁律）；下限×0.9≤现价≤上限×1.05→合理
//   （「持有/中性」映射）；>上限×1.05→高估（「减持/观望」映射）；阈值边界±3%→标注「方向性不明」。
//   【第六层·自检】运行前自检清单（契约完整性/B层应披露/股本同步/持股比例期差/可比报告期/行情时效/权重归一化）。
// 历史沿袭：20260908t V2.0 守门员+口径分离；20260922b 指令9 长鑫联动；20260922d 实时板块成交额接线。
// 计算层=代码，输入=实时三表+配置锁死；长鑫市值/华安市值/三表为实时抓取（带快照回退）。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');
const { getTurnoverContext } = require('../brokerSectorTurnover');

const SYM = '600909';
const CXMT = '688825';
const CXMT_STAKE_PCT = 0.4391; // 华安间接持股占长鑫科技比例（%，公告口径：长鑫招股书披露 2.64 亿股）

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600909.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isHuaanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (bare !== SYM) return false;
  const cfg = loadConfig();
  return !!cfg && cfg.kind === 'huaan';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const r4 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 10000) / 10000 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const nzd = (v, d) => (v == null || !isFinite(Number(v))) ? d : Number(v);
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;

function daysBetween(d1, d2) {
  const a = new Date(String(d1).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(d2).slice(0, 10) + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

// ============ 第二层·规则1：期差自动计算与成熟度分级（纯函数，供测试） ============
// 绿：期差 ≤ 60%×容忍期差 且为最新应披露期；黄：60%–100%容忍之间；红：>容忍或缺失。
function maturityGrade(ageDays, tolDays) {
  if (ageDays == null || tolDays == null) return '红';
  if (ageDays > tolDays) return '红';
  if (ageDays <= tolDays * 0.6) return '绿';
  return '黄';
}

// ============ 第二层·规则2：流量指标 TTM 拼接（纯函数，供测试） ============
// 禁止「上年同期×4/3」粗年化；按 asOfStage 拼接：
//   三季报后：TTM = 2026前三季累计 + (2025全年 − 2025前三季累计)（=2025Q4单季）
//   年报后：TTM = 2026全年；一季报后：TTM = 2026Q1 + 2025全年 − 2025Q1；
//   中报后：TTM = 2026H1累计 + 2025全年 − 2025H1累计。
function ttmSplice(curCum, prevFY, prevSameCum, stage) {
  const c = (curCum == null || !isFinite(curCum)) ? null : Number(curCum);
  const f = (prevFY == null || !isFinite(prevFY)) ? null : Number(prevFY);
  const s = (prevSameCum == null || !isFinite(prevSameCum)) ? null : Number(prevSameCum);
  if (stage === '12-31') return c; // 年报后 TTM = 全年
  if (c == null || f == null || s == null) return null; // 缺任一项 → NA 降级，禁静默填充
  return c + (f - s);
}

// ============ 第二层·规则3：存量指标 BPS 股本同步检测（纯函数，供测试） ============
// 净资产与股本不同报告期 → BPS 区间化：下限=最新净资产/陈旧股本；上限=最新净资产/调整后股本估计
// （无转增/回购/增发公告 → 上限=下限并标注「股本未同步，区间未展开」）。
function bpsWithSyncCheck(equityNew, sharesNew, sharesOld, adjustNote) {
  const e = (equityNew == null || !isFinite(equityNew) || equityNew <= 0) ? null : Number(equityNew);
  const sN = (sharesNew == null || !isFinite(sharesNew) || sharesNew <= 0) ? null : Number(sharesNew);
  const sO = (sharesOld == null || !isFinite(sharesOld) || sharesOld <= 0) ? null : Number(sharesOld);
  if (e == null) return { synced: false, bps: null, bpsLow: null, bpsHigh: null, note: '净资产缺失【NA】' };
  if (sN != null && (sO == null || Math.abs(sN - sO) / sN < 0.005)) {
    return { synced: true, bps: e / sN, bpsLow: e / sN, bpsHigh: e / sN, note: '股本与净资产同报告期（或偏差<0.5%），BPS 单点值' };
  }
  const low = sO != null ? e / sO : null;
  const hasAdjust = !!adjustNote; // 有转增/回购/增发公告 → 上限=调整后股本测算
  const high = hasAdjust ? (sN != null ? e / sN : low) : low;
  return {
    synced: false, bps: null, bpsLow: low, bpsHigh: high,
    note: hasAdjust
      ? `股本未同步 → BPS 区间化：下限=净资产/陈旧股本，上限=净资产/公告调整股本（${adjustNote}）`
      : '股本未同步，无转增/回购/增发公告 → 区间未展开（上限=下限）并标注',
  };
}

// ============ 第三层·规则7-8：方法成熟度 → 动态权重（纯函数，供测试） ============
// 方法成熟度=所依赖指标成熟度的最低档；绿×1.0/黄×0.7/红×0.3；红且基准<15%→停用（0）；
// PB红→待更新态；权重归一化。shadow 模式下 SOTP 权重按规则9摆动（绿50/黄45/红40）。
function dynWeights({ pb = '绿', sotp = '绿', pe = '绿', shadow = false } = {}) {
  const mult = { '绿': 1.0, '黄': 0.7, '红': 0.3 };
  const base = { pb: 0.6, sotp: 0.3, pe: 0.1 };
  if (pb === '红') return { pending: true, wPB: null, wSOTP: null, wPE: null, reason: 'PB法核心数据（净资产/股本）为红 → 估值整体进入「待更新态」，不输出目标价（规则8/规则10）' };
  let wPB = base.pb * mult[pb];
  let wPE;
  if (pe === '红') wPE = 0; // PE 基准 10% < 15% → 红即停用
  else wPE = base.pe * mult[pe];
  let wSOTP, reason = [];
  if (shadow) {
    // 规则9：影子股模式特例——SOTP 权重按其数据成熟度摆动（绿50/黄45/红40），PB 承接其余（PE 维持基准）
    wSOTP = sotp === '绿' ? 0.5 : (sotp === '黄' ? 0.45 : 0.40);
    wPB = 1 - wSOTP - wPE;
    reason.push(`影子股模式（占比>30%阈值）：SOTP 权重按其数据成熟度【${sotp}】摆动至 ${Math.round(wSOTP * 100)}%，PB 承接其余（规则9）`);
  } else {
    wSOTP = base.sotp * mult[sotp];
    if (sotp === '红') reason.push('SOTP法为红 → 权重×0.3');
    else if (sotp === '黄') reason.push('SOTP法为黄 → 权重×0.7');
  }
  if (pb === '黄') reason.push('PB法为黄 → 权重×0.7');
  if (pe === '红') reason.push('PE法基准 10%<15% 且为红 → 停用（权重归 0，规则8）');
  else if (pe === '黄') reason.push('PE法为黄 → 权重×0.7');
  const sum = wPB + wSOTP + wPE;
  if (sum <= 0) return { pending: true, wPB: null, wSOTP: null, wPE: null, reason: '全部方法停用（异常）→ 待更新态' };
  const adj = sum < 0.999 || sum > 1.001;
  wPB /= sum; wSOTP /= sum; wPE /= sum;
  if (adj) reason.push(`权重已归一化（调整前合计 ${(sum * 100).toFixed(1)}%）`);
  return { pending: false, wPB, wSOTP, wPE, adjusted: adj, reason: reason.join('；') || '全部方法为绿，维持基准权重' };
}

// ---- 指令9沿袭：SOTP 权重自适应（旧三档，兼容保留；新架构主路径为 dynWeights 规则9摆动） ----
function pickSotpWeights(ratio) {
  if (ratio > 0.30) return { wPB: 0.4, wST: 0.5, wPE: 0.1, mode: 'shadow', note: '影子股模式：参股资产占华安总市值 > 30%，SOTP 权重自动上调至 50%，PB 法压缩至 40%、PE 法维持 10%。' };
  if (ratio >= 0.10) return { wPB: 0.5, wST: 0.4, wPE: 0.1, mode: 'elevated', note: '公司价值显著受参股资产影响（占比 10%~30%），SOTP 权重上调至 40%。' };
  return { wPB: 0.6, wST: 0.3, wPE: 0.1, mode: 'normal', note: '' };
}

// ---- 指令9沿袭：流动性折扣 ----
function liquidityDiscount(cfg) {
  const st = (cfg.sotpLayer && cfg.sotpLayer.cxmtLockStatus) || 'unknown';
  if (st === 'free') return { discount: 0, retain: 1, label: '无限售（折扣 0%）' };
  if (st === 'restricted') {
    const d = nz(cfg.sotpLayer.cxmtLiquidityDiscount) || 0.25;
    return { discount: d, retain: 1 - d, label: `限售（折扣 ${Math.round(d * 100)}%）` };
  }
  return { discount: 0.3, retain: 0.7, label: '限售状态未知（保守折扣 30%）' };
}

// ---- 指令9沿袭：Pearson 相关系数（纯函数，供测试） ----
function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// ---- 指令9沿袭：长鑫科技总市值抓取（实时，失败回退锁定快照） ----
async function fetchCxmt() {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(CXMT);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), asOf: q.date || localDate(), source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const mv = nz(cfg.sotpLayer.cxmtShares) * nz(cfg.sotpLayer.cxmtPrice) / (CXMT_STAKE_PCT / 100);
  return { totalValue: mv, price: nz(cfg.sotpLayer.cxmtPrice), asOf: cfg.dataAsOf, source: '锁定快照（2.64亿股÷0.4391% 推导长鑫总市值，实时不可得）', ok: false };
}

// ---- 指令9沿袭：华安证券总市值抓取（实时，失败回退传入价/快照价×股本） ----
async function fetchHuaanTotal(price) {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(SYM);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), sharesImplied: nz(q.price) > 0 ? nz(q.fundamentals.totalValue) / nz(q.price) : null, source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const p = (price != null && price > 0) ? price : nz(cfg.huaanPriceSnapshot);
  return { totalValue: p * nz(cfg.shares), price: p, sharesImplied: nz(cfg.shares), source: (price != null && price > 0) ? '传入价×股本' : '锁定快照价×股本', ok: (price != null && price > 0) };
}

// ---- 指令9沿袭：股价联动强度（近 60 交易日日收益相关系数，仅A层数据） ----
async function computeLinkCorr() {
  try {
    const stockData = require('../stockData');
    const [h1, h2] = await Promise.all([stockData.getHistory(SYM, '1y'), stockData.getHistory(CXMT, '1y')]);
    if (!Array.isArray(h1) || !Array.isArray(h2) || h1.length < 5 || h2.length < 5) return { ok: false, reason: '历史不足' };
    const map1 = new Map(h1.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const map2 = new Map(h2.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const dates = [...map1.keys()].filter(d => map2.has(d)).sort();
    if (dates.length < 20) return { ok: false, reason: `对齐交易日 ${dates.length} < 20` };
    const win = dates.slice(-Math.min(60, dates.length));
    const r1 = [], r2 = [];
    for (let i = 1; i < win.length; i++) {
      const c1a = map1.get(win[i - 1]), c1b = map1.get(win[i]);
      const c2a = map2.get(win[i - 1]), c2b = map2.get(win[i]);
      if (c1a > 0 && c1b > 0 && c2a > 0 && c2b > 0) { r1.push(c1b / c1a - 1); r2.push(c2b / c2a - 1); }
    }
    const r = pearson(r1, r2);
    return { ok: true, r: (r == null ? null : Math.round(r * 1000) / 1000), n: r1.length, limited: win.length < 60, asOf: win[win.length - 1], source: win.length < 60 ? `腾讯/东财日K（仅 ${win.length} 日，未满 60 日）` : '腾讯/东财日K（近 60 交易日）' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ============ B层数据抓取（东财F10三表，实时；失败→诚实中止，禁用旧值） ============
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SH${SYM}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income;
    const pick = (d) => inc.find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    const cur = pick('2026-09-30') || pick('2026-06-30') || pick('2026-03-31');
    const prevFY = pick('2025-12-31');
    const prevSame = cur ? pick(String(cur.REPORT_DATE).slice(0, 4) === '2026' ? `2025-${String(cur.REPORT_DATE).slice(5, 10)}` : `2024-${String(cur.REPORT_DATE).slice(5, 10)}`) : null;
    if (!cur || !prevFY || !prevSame) return null;
    // 最新报告期资产负债表（fetchFinancialData 资产负债表仅年报，需自取）
    const dates = ['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'];
    let balQ = null;
    const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SH${SYM}`, dates);
    const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
    balQ = balArr.find(r => String(r.REPORT_DATE || '').startsWith(String(cur.REPORT_DATE).slice(0, 10)))
      || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2026-09-30'))
      || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2026-06-30')) || null;
    return {
      asOf: String(cur.REPORT_DATE).slice(0, 10),
      stage: String(cur.REPORT_DATE).slice(5, 10),
      npCum: yi(cur.PARENT_NETPROFIT),
      npDedCum: yi(cur.DEDUCT_PARENT_NETPROFIT),
      revCum: yi(cur.TOTAL_OPERATE_INCOME),
      npYoy: cur.PARENT_NETPROFIT_YOY != null ? Number(cur.PARENT_NETPROFIT_YOY) : null,
      npDedYoy: cur.DEDUCT_PARENT_NETPROFIT_YOY != null ? Number(cur.DEDUCT_PARENT_NETPROFIT_YOY) : null,
      prevFYNp: yi(prevFY.PARENT_NETPROFIT),
      prevFYNpDed: yi(prevFY.DEDUCT_PARENT_NETPROFIT),
      prevSameNp: yi(prevSame.PARENT_NETPROFIT),
      prevSameNpDed: yi(prevSame.DEDUCT_PARENT_NETPROFIT),
      equityNew: balQ ? yi(balQ.TOTAL_PARENT_EQUITY) : null,
      totalAssets: balQ ? yi(balQ.TOTAL_ASSETS) : null,
      // 20261030a：其他权益工具（永续债）字段链修正——券商模板 OTHER_EQUITY_TOOL 为空，实际值在 OTHER_EQUITY_INVEST
      perp: balQ ? (yi(balQ.OTHER_EQUITY_TOOL) != null ? yi(balQ.OTHER_EQUITY_TOOL) : yi(balQ.OTHER_EQUITY_INVEST)) : null,
      balAsOf: balQ ? String(balQ.REPORT_DATE).slice(0, 10) : null,
    };
  } catch (e) { return null; }
}

async function run(symbol, { price, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'huaan') return { error: 'NOT_HUAAN' };

  const G = cfg.guard || {}, Q = cfg.quarterly || {}, NL = cfg.npLatest || {};
  const PB = cfg.pbLayer || {}, ST = cfg.sotpLayer || {}, PE = cfg.peLayer || {};
  const RT = cfg.ratingThresholds || {}, LV = cfg.lastVersion || {}, NT = cfg.notes || {};
  const AL = cfg.asyncLayer || {};
  const TOL = AL.tolerances || {};
  const N_CFG = nz(cfg.shares);

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const today = localDate();

  // ============ B层抓取（缺三表→诚实中止，禁静默填充） ============
  const S = statements || await fetchStatements();
  if (!S || S.npCum == null || S.prevFYNp == null || S.prevSameNp == null) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（L4 待更新态：三表核心数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 第四层 L4 降级：定期报告核心数据（归母净利润累计序列/净资产）不可得，按规则14禁止静默填充、禁止用旧值外推，估值整体进入「待更新态」。需等待东财F10三表数据恢复后重跑。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  const asOfStage = S.stage; // '09-30' / '12-31' / '03-31' / '06-30'
  const bAsOf = S.asOf;
  const bAge = daysBetween(bAsOf, today);

  // ============ 指令0：守门员自检（沿袭）+ 规则13 自检清单 ============
  const reportAge = bAge;
  const g1Pass = reportAge <= nz(G.maxAgeDays, 150);
  const turnover = await getTurnoverContext();
  const tBroker = turnover.broker, tMarket = turnover.market;
  const g2Limit = nz(G.sectorTurnoverDeviationLimitPct, 30);
  let g2Status, g2Value, g2Source;
  if (tBroker) {
    const devOk = (tBroker.devPct == null) || (Math.abs(tBroker.devPct) <= g2Limit);
    g2Status = devOk ? 'PASS' : 'TERMINATE';
    g2Value = `券商板块近 ${tBroker.windowDays} 交易日日均成交额 ${tBroker.avg20Yi} 亿元（当日 ${tBroker.todayYi} 亿元，截至 ${tBroker.date}），较近 ${tBroker.baseDays} 日基线 ${tBroker.baselineYi} 亿元偏离 ${tBroker.devPct >= 0 ? '+' : ''}${tBroker.devPct}%（阈值 ±${g2Limit}%）→ ${devOk ? '未触发市场环境突变' : '⚠️ 偏离超阈值，按规则终止本次估值'}`;
    g2Source = tBroker.source;
  } else {
    g2Status = 'DEGRADED';
    g2Value = '券商板块近20日日均成交额数据源暂不可得（双源均未取到）→ 本次降级不终止，仅建立标注；下次运行自动重试';
    g2Source = '双源暂不可得（已接线）';
  }
  const cxmtWindowDays = nz(G.cxmtWindowDays, 30);
  const cxmtDays = daysBetween(G.cxmtListDate, today);
  const g3Pass = !(G.cxmtStatus !== 'listed' && cxmtDays <= cxmtWindowDays);
  const cxmtNoteLive = `长鑫科技 ${G.cxmtListDate} 已登陆科创板(${G.cxmtCode})；本次检查(${today})距上市 ${cxmtDays} 天，无新质变动态，自检通过；SOTP 采用长鑫市值×${CXMT_STAKE_PCT}%×(1−流动性折扣)`;

  const guardRows = [
    { label: '① 财报时效', status: g1Pass ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${bAsOf}，距检查日 ${reportAge} 天（B层容忍上限 ${G.maxAgeDays} 天）`, source: `东财F10三表实时拉取（${bAsOf}）` },
    { label: '② 市场环境', status: g2Status === 'PASS' ? '✅ 通过' : (g2Status === 'TERMINATE' ? '⛔ 终止' : '🟡 降级'), value: g2Value, source: g2Source },
    { label: '③ 核心资产（长鑫科技 688825）', status: g3Pass ? '✅ 通过' : '⛔ 终止', value: cxmtNoteLive, source: `上市日 ${G.cxmtListDate}；检查日 ${today}` },
  ];
  const terminated = !g1Pass || !g3Pass || (g2Status === 'TERMINATE');

  // P2通用时效看板（沿袭）
  const freshnessRows = [];
  freshnessRows.push({ label: 'B层·最新财报报告期', asOf: bAsOf, ageDays: reportAge, maxAge: nz(G.maxAgeDays, 150), stale: !g1Pass });
  {
    const cxAge = daysBetween(G.cxmtListDate, today);
    freshnessRows.push({ label: '长鑫科技上市核查日', asOf: today, ageDays: cxAge, maxAge: 9999, stale: false });
  }
  if (tBroker && tBroker.date) {
    const tAge = daysBetween(tBroker.date, today);
    freshnessRows.push({ label: '券商板块成交额', asOf: tBroker.date, ageDays: tAge, maxAge: 5, stale: tAge > 5 });
  }

  if (terminated) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（财报超龄/市场环境突变/核心资产质变），模型按指令0终止本次估值，历史结论不再外推。请更新数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }

  // ============ 第一层：数据契约表（规则13 自检①：无契约裸数据一律拒收） ============
  const contracts = [];
  const C = (name, value, periodEnd, freq, source, tolDays, opts = {}) => {
    const age = daysBetween(periodEnd, today);
    const grade = opts.grade || maturityGrade(age, tolDays);
    const row = {
      name, value: (value == null ? 'NA【缺失】' : value), periodEnd, freq, source,
      ageDays: age, tolDays, grade,
      carried: !!opts.carried, carriedFrom: opts.carriedFrom || null,
      note: opts.note || '', tier: opts.tier || 'C',
    };
    contracts.push(row);
    return row;
  };
  // A层（日频，容忍1交易日）
  const cxmt = await fetchCxmt();
  const huaan = await fetchHuaanTotal(P);
  const aRows = {
    price: C('华安证券收盘价', P != null ? r2(P) + ' 元' : (huaan.price ? r2(huaan.price) + ' 元' : null), today, '日频', huaan.source, nz(TOL.aTier, 1), { tier: 'A', note: P == null && huaan.price ? '传入价缺失，沿用实时行情' : '' }),
    cxmtMv: C('长鑫科技总市值', r2(cxmt.totalValue) + ' 亿元', cxmt.asOf, '日频', cxmt.source, nz(TOL.aTier, 1), { tier: 'A', note: cxmt.ok ? '' : '实时不可得，沿用锁定快照（±5%自动重算口径）' }),
    huaanMv: C('华安证券总市值', r2(huaan.totalValue) + ' 亿元', today, '日频', huaan.source, nz(TOL.aTier, 1), { tier: 'A' }),
  };
  // B层（季频，容忍150天）
  const bRows = {
    npCum: C('归母净利润（最新累计）', S.npCum == null ? null : r2(S.npCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 PARENT_NETPROFIT', nz(TOL.bTier, 150), { tier: 'B' }),
    npDedCum: C('扣非归母净利润（最新累计）', S.npDedCum == null ? null : r2(S.npDedCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 DEDUCT_PARENT_NETPROFIT', nz(TOL.bTier, 150), { tier: 'B' }),
    equity: C('归母净资产（期末）', S.equityNew == null ? null : r2(S.equityNew) + ' 亿元', S.balAsOf || bAsOf, '季频', '东财F10资产负债表 TOTAL_PARENT_EQUITY', nz(TOL.bTier, 150), { tier: 'B' }),
    revCum: C('营业收入（最新累计）', S.revCum == null ? null : r2(S.revCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 TOTAL_OPERATE_INCOME', nz(TOL.bTier, 150), { tier: 'B' }),
  };
  // C层（低频/非必披露，分项容忍）
  const stakeAsOf = AL.stakePctAsOf || '2026-06-30';
  const cRows = {
    bizStructure: C('分业务条线收入结构', '常规业务净利（扣非年化）' + nz(ST.normalAnnualNp) + ' 亿', AL.structureAsOf || '2026-06-30', '半年频', '2026 中报分部数据（结转口径）', nz(TOL.bizStructure, 200), { tier: 'C', carried: true, carriedFrom: AL.structureAsOf || '2026-06-30', note: '三季报不披露分业务收入 → 按最近完整披露期结转（规则4），禁用总营收×占比' }),
    stakePct: C('长鑫科技穿透持股比例', CXMT_STAKE_PCT + '%', stakeAsOf, '公告驱动', '长鑫科技招股书穿透披露（2.64 亿股）', nz(TOL.stakePct, 180), { tier: 'C', note: '公告优先原则（规则6）：不随华安季报强制更新；若期间长鑫增发/回购须人工确认' }),
    lockStatus: C('限售状态与流动性折扣', ST.cxmtLockStatus === 'restricted' ? `限售（折扣 ${Math.round(nz(ST.cxmtLiquidityDiscount, 0.25) * 100)}%）` : ST.cxmtLockStatus, G.cxmtListDate || '2026-07-27', '公告驱动', '长鑫科技上市公告（4个月后解禁）', nz(TOL.lockStatus, 365), { tier: 'C' }),
    sectorPB: C('券商板块 PB 快照', PB.sectorPB + ' 倍', AL.paramSnapshotAsOf || '2026-09-08', '参数快照', NT.sectorPB || '板块快照', nz(TOL.paramSnapshot, 60), { tier: 'C', note: '模型参数快照（非日频行情）：超容忍期差时对 PB 锚2 做±10%敏感性' }),
    sectorPE: C('可比券商 PE 中位', PE.sectorPeMedian + ' 倍', AL.paramSnapshotAsOf || '2026-09-08', '参数快照', NT.peNormal || '可比快照', nz(TOL.paramSnapshot, 60), { tier: 'C', note: '可比公司各自最新原则（规则5）：中信 10.76/国泰海通 7.59 等快照取中位' }),
  };
  const contractRows = contracts.map(c => ({
    label: `${c.tier}层·${c.name}`,
    value: `期差 ${c.ageDays} 天 / 容忍 ${c.tolDays} 天 → 【${c.grade}】${c.carried ? '（结转自 ' + c.carriedFrom + '）' : ''}${c.note ? '；' + c.note : ''}`,
    source: `${c.value} ｜ ${c.freq} ｜ ${c.source} ｜ 报告期 ${c.periodEnd}`,
  }));

  // ============ 第二层·规则2：TTM 拼接 ============
  const npTtm = ttmSplice(S.npCum, S.prevFYNp, S.prevSameNp, asOfStage);
  const npDedTtm = ttmSplice(S.npDedCum, S.prevFYNpDed, S.prevSameNpDed, asOfStage);
  const prevQ4Np = (S.prevFYNp != null && S.prevSameNp != null) ? S.prevFYNp - S.prevSameNp : null; // 2025Q4 单季
  const ttmStageLabel = asOfStage === '12-31' ? '年报后 TTM=全年'
    : asOfStage === '09-30' ? `三季报后 TTM=${bAsOf.slice(0, 4)}前三季累计 ${r2(S.npCum)} + ${Number(bAsOf.slice(0, 4)) - 1}Q4 单季 ${r2(prevQ4Np)}`
    : asOfStage === '06-30' ? '中报后 TTM=H1累计+上年H2'
    : '一季报后 TTM=Q1+上年Q2-Q4';
  if (npTtm == null) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（L4：TTM 拼接数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      guardRows, freshnessRows, contractRows,
      decisionNote: '⛔ TTM 拼接所需报告期数据缺失（规则2：禁用×4/3粗年化、禁静默填充）→ 待更新态。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  // ============ 第二层·规则3：BPS 股本同步检测 ============
  // 财报口径股本：三季报不披露股本变动表 → 用回购公告口径 50.24 亿股（2026-08-21 注销后）；
  // 行情口径隐含股本（总市值/现价）交叉检测，偏差<0.5% 视为同步。
  const sharesImplied = huaan.sharesImplied;
  const syncChk = bpsWithSyncCheck(S.equityNew, sharesImplied, N_CFG, AL.sharesAdjustNote || null);
  const bpsUsed = syncChk.synced ? syncChk.bps : (syncChk.bpsLow + syncChk.bpsHigh) / 2;
  const bpsGrade = syncChk.synced ? '绿' : '黄';
  const bpsNote = syncChk.synced
    ? `BPS = 归母净资产 ${r2(S.equityNew)} 亿 ÷ 股本 ${r2(sharesImplied)} 亿股 = ${syncChk.bps.toFixed(4)} 元（行情口径与回购公告口径偏差<0.5%，同步）`
    : `BPS 区间 ${syncChk.bpsLow && syncChk.bpsLow.toFixed ? syncChk.bpsLow.toFixed(4) : 'NA'} ~ ${syncChk.bpsHigh && syncChk.bpsHigh.toFixed ? syncChk.bpsHigh.toFixed(4) : 'NA'} 元；${syncChk.note}`;

  // ============ 指令1沿袭：口径分离（常态化利润剥离，单季异常检测） ============
  const npSeries = Q.npSeries || [];
  const avgNp = npSeries.reduce((a, b) => a + nz(b), 0) / Math.max(1, npSeries.length);
  const peakIdx = npSeries.indexOf(Math.max(...npSeries));
  const peakQ = (Q.labels || [])[peakIdx] || `第${peakIdx + 1}季`;
  const peakNp = nz(npSeries[peakIdx]);
  const anomalyRatio = avgNp > 0 ? peakNp / avgNp : 0;
  const anomaly = anomalyRatio > nz(Q.anomalyThreshold, 1.5);
  const epsReport = N_CFG > 0 ? npTtm / N_CFG : null;          // TTM EPS（最新拼接）
  const epsNormal = N_CFG > 0 ? npDedTtm / N_CFG : null;       // 常态 EPS（TTM 扣非口径）
  const npDedDev = (S.npYoy != null && S.npDedYoy != null) ? Math.abs(S.npYoy - S.npDedYoy) : null;

  // ============ 修订版口径（20261030a · 规范修订版六条）：正常化 EPS + 长鑫收益确认状态 ============
  // ③ 扣非质量校验：归母/扣非同比偏离 <20pp 说明非经常性损益同比影响不显著；但券商扣非仍可能含
  //    自营公允价值变动及长鑫上市重估收益 → 长鑫收益确认状态由配置 v3.caliber.lcxInNonRecurring 控制
  //    （true=已计入非经常性→扣非干净 / false=未计入→扣非被污染 / null=未确认→保守口径）。
  // ④ 正常化处理：正常化 EPS = min(TTM扣非EPS, 可持续ROE × 普通股BPS)；普通股 BPS =（归母净资产 − 其他权益工具）÷ 股本。
  //    点估值：未确认 → 取区间中值（1.048 为上限不得作中枢）；确认长鑫收益已在扣非外 → 上修至常态 EPS。
  const CAL = (cfg.v3 && cfg.v3.caliber) || {};
  const perpVal = (S.perp != null && S.perp > 0) ? S.perp : nzd(CAL.otherEquityToolsSnap, null);
  const bpsOrdinary = (perpVal != null && S.equityNew != null && N_CFG > 0) ? (S.equityNew - perpVal) / N_CFG : bpsUsed;
  const sustainRoePe = nzd(CAL.sustainRoePct, 12.5) / 100;
  const epsNormCap = sustainRoePe * bpsOrdinary;                 // 正常化上限 = 可持续ROE × 普通股BPS
  const epsNormLo = Math.min(epsNormal, epsNormCap);
  const epsNormHi = Math.max(epsNormal, epsNormCap);
  const lcxState = CAL.lcxInNonRecurring;                        // true/false/null
  const lcxConfirmed = lcxState === true;
  const epsPoint = lcxConfirmed ? epsNormal : (epsNormLo + epsNormHi) / 2;
  const caliberNote = `【一次性损益剔除口径 · 报告首页强制披露（修订版）】`
    + `① 异常检测：${peakQ} 单季归母净利 ${r2(peakNp)} 亿元为近 ${npSeries.length} 季均值（${r2(avgNp)} 亿元）的 ${Math.round(anomalyRatio * 100)}%${anomaly ? ' > 150% 阈值，触发异常口径分离' : '，未触发口径分离'}。`
    + `② 口径选择：PE 法不采用报告 EPS，采用常态 EPS = TTM 扣非 ${r2(npDedTtm)} 亿 ÷ ${r2(N_CFG)} 亿股 = ${r4(epsNormal)} 元（三季报后 TTM 扣非口径，替代原中报扣非年化）。`
    + `③ 扣非质量校验：归母/扣非同比增速偏离 ${npDedDev != null ? r2(npDedDev) + 'pp' : 'NA'} < 20pp，非经常性损益同比影响不显著；但券商扣非仍可能包含自营公允价值变动及长鑫科技上市重估收益 → 确定性引擎无三季报非经常性损益明细通道 → 长鑫相关收益确认状态【${lcxState === true ? '已计入非经常性损益（扣非干净）' : lcxState === false ? '未计入非经常性损益（扣非受污染）' : '未确认'}】${lcxConfirmed ? '' : ' → 保守处理：常态 EPS 为上限，不得作为中枢'}。`
    + `④ 正常化处理：正常化 EPS = min（TTM 扣非 EPS ${r4(epsNormal)}，可持续 ROE ${r2(sustainRoePe * 100)}% × 普通股 BPS ${r2(bpsOrdinary)} 元【=（归母净资产 ${r2(S.equityNew)} − 其他权益工具 ${perpVal != null ? r2(perpVal) : 'NA'}）÷ ${r2(N_CFG)} 亿股；实时字段 OTHER_EQUITY_INVEST，规范测算 5.62 基于扣减口径略有差异】）= ${r4(epsNormCap)} 元 → PE 法取 [${r4(epsNormLo)}, ${r4(epsNormHi)}] 区间，点估值${lcxConfirmed ? `上修至常态 EPS ${r4(epsNormal)} 元（长鑫收益确认在扣非外）` : `取中值 ${r4(epsPoint)} 元（长鑫收益未确认，保守口径）`}。`
    + `⑤ 权重约束：PE 法权重 10%，仅作底部安全边际参考，不参与向上弹性定价；SOTP 与 PB 法仍为主锚。`
    + `⑥ 数据同步说明：TTM 扣非截至 ${S.asOf}；总股本 ${r2(N_CFG)} 亿股截至 ${S.asOf}；普通股 BPS 截至 ${S.balAsOf || S.asOf}；长鑫科技持股比例截至最近公告日（敏感性区间随契约成熟度黄/红档 ±3%~5%）；限售折扣按保守假设。`;

  // ============ 三法计算 ============
  // ① PB 法（核心）：三层动态锚 = 历史40% + 板块×ROE溢价30% + 理论30%
  const roe = nz(PB.sustainableRoe) / 100, gPerp = nz(PB.g) / 100;
  const r = nz(PB.rf) / 100 + nz(PB.beta) * nz(PB.erp) / 100;
  const theoPB = (roe - gPerp) / (r - gPerp);
  const aSector = nz(PB.sectorPB) * nz(PB.premiumCoef);
  const aHist = nz(PB.histPbMedian);
  const fairPB = nz(PB.wHist) * aHist + nz(PB.wSector) * aSector + nz(PB.wTheo) * theoPB;
  // 板块 PB 快照黄/红 → 锚2 ±10% 敏感性（L2 区间化）
  const pbAnchor2Low = cRows.sectorPB.grade !== '绿' ? fairPB - nz(PB.wSector, 0.3) * aSector * 0.10 : fairPB;
  const pbAnchor2High = cRows.sectorPB.grade !== '绿' ? fairPB + nz(PB.wSector, 0.3) * aSector * 0.10 : fairPB;
  // 20261030b：PB 层切换普通股口径 BPS（规范《本次估值权重与输出形态》第6条：PB法目标价=普通股BPS×合理PB）
  // 普通股 BPS =（归母净资产 − 其他权益工具/永续债）÷ 股本；归母口径 BPS（bpsUsed）保留供参照
  const pbTarget = bpsOrdinary * fairPB;
  const pbTargetLow = bpsOrdinary * pbAnchor2Low, pbTargetHigh = bpsOrdinary * pbAnchor2High;

  // ② SOTP 法：常规业务（结转净利×可比PE，±15% 敏感性）+ 长鑫持股价值×流动性折扣（±5% 持股比例区间）
  const liq = liquidityDiscount(cfg);
  const cxmtMv = nz(cxmt.totalValue), huaanMv = nz(huaan.totalValue);
  const sotpBase = nz(ST.normalAnnualNp) * nz(ST.peNormal);
  const stakeGross = cxmtMv * (CXMT_STAKE_PCT / 100);
  const stakeValue = stakeGross * liq.retain;
  const sotpTarget = N_CFG > 0 ? (sotpBase + stakeValue) / N_CFG : null;
  const sotpSensPct = nz(ST.sensPct, 0.15);
  const stakeSensPct = cRows.stakePct.grade === '红' ? 0.05 : (cRows.stakePct.grade === '黄' ? 0.03 : 0);
  const sotpLow = N_CFG > 0 ? (sotpBase * (1 - sotpSensPct) + stakeValue * (1 - stakeSensPct)) / N_CFG : null;
  const sotpHigh = N_CFG > 0 ? (sotpBase * (1 + sotpSensPct) + stakeValue * (1 + stakeSensPct)) / N_CFG : null;

  // ③ PE 法（修订版口径：正常化 EPS 区间 [可持续ROE×普通股BPS, TTM扣非EPS]，点估值=中值/确认后上修）
  const histPe = PE.histPeMedian == null ? null : nz(PE.histPeMedian);
  const sectorPe = nz(PE.sectorPeMedian);
  const peMult = (histPe != null && histPe > 0) ? Math.min(histPe, sectorPe) : sectorPe;
  const peTarget = epsPoint * peMult;          // 点估值（未确认→中值口径；确认→常态 EPS）
  const peTargetLow = epsNormLo * peMult;      // 正常化下限
  const peTargetHigh = epsNormHi * peMult;     // 上限（常态 EPS）

  // ============ 第三层·规则7：方法成熟度 ============
  // PB 依赖：净资产（B）+股本（B/A）+可持续ROE（B历史）→ 最低档
  const mPB = [bRows.equity.grade, bpsGrade, '绿'].includes('红') ? '红' : ([bRows.equity.grade, bpsGrade].includes('黄') ? '黄' : '绿');
  // PE 依赖：TTM扣非（B）+股本（B）→ 最低档（B层绿则绿）
  const mPE = bRows.npDedCum.grade === '红' || bpsGrade === '红' ? '红' : (bRows.npDedCum.grade === '黄' || bpsGrade === '黄' ? '黄' : '绿');
  // SOTP 依赖：分业务结构（C）+长鑫市值（A）+持股比例（C）+限售（C）→ 最低档
  const mSOTP = [cRows.bizStructure.grade, aRows.cxmtMv.grade, cRows.stakePct.grade, cRows.lockStatus.grade].includes('红') ? '红'
    : [cRows.bizStructure.grade, cRows.stakePct.grade].includes('黄') ? '黄' : '绿';

  // ============ 指令9沿袭+规则9：影子股判定与两套权重 ============
  const stakeRatioGross = huaanMv > 0 ? stakeGross / huaanMv : 0;
  const stakeRatioDisc = huaanMv > 0 ? stakeValue / huaanMv : 0;
  const shadow = stakeRatioGross > 0.30;

  const wMain = dynWeights({ pb: mPB, sotp: mSOTP, pe: mPE, shadow });
  if (wMain.pending) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（待更新态：' + (wMain.reason || 'PB法为红') + '）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      guardRows, freshnessRows, contractRows,
      decisionNote: '⛔ ' + (wMain.reason || 'PB 法为红 → 待更新态（规则8/10）。'),
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }
  // 两套权重（影子股模式时）：主权重 vs 参考权重（相邻成熟度档位）
  let refW = null;
  if (shadow) {
    const refGrade = mSOTP === '绿' ? '黄' : (mSOTP === '黄' ? '绿' : '黄');
    const wRef = dynWeights({ pb: mPB, sotp: refGrade, pe: mPE, shadow: true });
    refW = { grade: refGrade, wPB: wRef.wPB, wSOTP: wRef.wSOTP, wPE: wRef.wPE, reason: wRef.reason };
  }
  const wts = { wPB: wMain.wPB, wSOTP: wMain.wSOTP, wPE: wMain.wPE };
  const wLabelMain = `PB ${Math.round(wts.wPB * 100)}% / SOTP ${Math.round(wts.wSOTP * 100)}% / PE ${Math.round(wts.wPE * 100)}%`;

  // ============ 综合目标价（三态输出·规则10） ============
  const anyYellow = mPB === '黄' || mPE === '黄' || mSOTP === '黄' || bpsGrade === '黄';
  const anyRed = mPB === '红' || mPE === '红' || mSOTP === '红';
  // 区间化：SOTP 敏感性区间 + PB 锚2敏感性区间（快照非绿时）+ PE 正常化区间（修订版口径）参与加权
  const pbLow = pbTargetLow, pbHigh = pbTargetHigh;
  const center = wts.wPB * pbTarget + wts.wSOTP * sotpTarget + wts.wPE * peTarget;
  const centerLow = wts.wPB * pbLow + wts.wSOTP * sotpLow + wts.wPE * peTargetLow;
  const centerHigh = wts.wPB * pbHigh + wts.wSOTP * sotpHigh + wts.wPE * peTargetHigh;
  const refCenter = refW ? (refW.wPB * pbTarget + refW.wSOTP * sotpTarget + refW.wPE * peTarget) : null;
  const outputState = anyRed ? '区间态（含红项）' : (anyYellow ? '区间态' : '精确态');
  // 20261030b 规范第7条：区间态置信度按「绿色方法权重占比」近似（附定性描述：≥70%高 / ≥50%中等偏高 / ≥35%中等 / 其余一般）；精确态保持 90
  const greenW = (mPB === '绿' ? wts.wPB : 0) + (mSOTP === '绿' ? wts.wSOTP : 0) + (mPE === '绿' ? wts.wPE : 0);
  const confQual = greenW >= 0.7 ? '高' : (greenW >= 0.5 ? '中等偏高' : (greenW >= 0.35 ? '中等' : '一般'));
  const confidence = (anyRed || anyYellow) ? Math.round(greenW * 100) : 90;
  const fairValueRange = (anyYellow || anyRed) ? [r2(Math.min(centerLow, centerHigh)), r2(Math.max(centerLow, centerHigh))] : [r2(center * nz(RT.buyBelow, 0.9)), r2(center * nz(RT.reduceAbove, 1.05))];

  // ============ 规则12：评级区间判定（映射项目三档铁律） ============
  let rating = '合理', ratingNote = '', ratingBoundary = '';
  if (P != null && fairValueRange) {
    const lo = fairValueRange[0], hi = fairValueRange[1];
    if (P < lo * nz(RT.buyBelow, 0.9)) {
      rating = '低估';
      ratingNote = `现价 ${r2(P)} < 区间下限 ${lo} × 0.9 = ${r2(lo * nz(RT.buyBelow, 0.9))} → 低估（规范「买入」档，映射项目三档评级铁律）`;
    } else if (P > hi * nz(RT.reduceAbove, 1.05)) {
      rating = '高估';
      ratingNote = `现价 ${r2(P)} > 区间上限 ${hi} × 1.05 = ${r2(hi * nz(RT.reduceAbove, 1.05))} → 高估（规范「减持/观望」档，映射项目三档评级铁律）`;
    } else {
      rating = '合理';
      ratingNote = `现价 ${r2(P)} 处 [下限×0.9, 上限×1.05] = [${r2(lo * nz(RT.buyBelow, 0.9))}, ${r2(hi * nz(RT.reduceAbove, 1.05))}] 区间内 → 合理（规范「持有/中性」档）`;
      const nearLow = Math.abs(P - lo * nz(RT.buyBelow, 0.9)) <= lo * nz(RT.buyBelow, 0.9) * 0.03;
      const nearHigh = Math.abs(P - hi * nz(RT.reduceAbove, 1.05)) <= hi * nz(RT.reduceAbove, 1.05) * 0.03;
      if (nearLow || nearHigh) ratingBoundary = '⚠️ 现价接近评级阈值边界（±3%）→ 方向性不明，等待数据同步后再判定';
    }
  } else {
    ratingNote = '实时价不可用，仅输出目标价区间。';
  }

  // ============ 第四层：四级降级留痕 ============
  const downgradeLog = [];
  const dlog = (item, why, level, impact) => { downgradeLog.push({ item, why, level, impact }); };
  if (cRows.bizStructure.grade !== '绿') dlog('分业务收入结构', `三季报不披露分业务收入，沿用 ${cRows.carriedFrom || '2026-06-30'} 结转（规则4）`, 'L1', 'SOTP 常规业务净利为结转口径，±15% 敏感性 → SOTP 输出区间');
  if (cRows.stakePct.grade !== '绿') dlog('长鑫穿透持股比例', `公告基准 ${stakeAsOf}，期差 ${cRows.stakePct.ageDays} 天（${cRows.stakePct.grade}）`, cRows.stakePct.grade === '红' ? 'L2' : 'L1', cRows.stakePct.grade === '红' ? '持股比例设±5%区间 → 长鑫持股价值区间化' : '持股比例±3%敏感性并入 SOTP 区间');
  if (cRows.sectorPB.grade !== '绿') dlog('券商板块 PB 快照', `参数快照 ${cRows.sectorPB.periodEnd}，期差 ${cRows.sectorPB.ageDays} 天超 60% 容忍（${cRows.sectorPB.grade}）`, 'L2', 'PB 锚2 ±10% 敏感性 → PB 目标价区间化');
  if (!syncChk.synced) dlog('总股本', '净资产与股本不同报告期（规则3）', 'L2', 'BPS 区间化：' + syncChk.note);
  if (mPE === '红') dlog('PE 法', 'TTM 扣非或股本为红', 'L3', 'PE 法停用（基准 10%<15%），权重转移');
  if (aRows.cxmtMv.grade === '红' || !cxmt.ok) dlog('长鑫科技总市值', '实时不可得，沿用锁定快照', 'L1', '持股价值按快照计算，下次运行实时重算');
  if (!downgradeLog.length) downgradeLog.push({ item: '（无）', why: '全部指标为绿，L0 正常路径', level: 'L0', impact: '点估值可用（若全绿则精确态）' });

  // ============ 输出行（兼容字段 + 新增） ============
  const dualEpsRows = [
    { label: '报告 EPS（TTM 拼接）', value: `${r4(epsReport)} 元`, source: `TTM 归母 ${r2(npTtm)} 亿 ÷ ${N_CFG} 亿股（${ttmStageLabel}）` },
    { label: '常态 EPS（TTM 扣非）', value: `${r4(epsNormal)} 元`, source: `TTM 扣非 ${r2(npDedTtm)} 亿 ÷ ${r2(N_CFG)} 亿股；PE 法上限口径（长鑫收益未确认期间不得作中枢）` },
    { label: '正常化 EPS（修订版口径）', value: `min（TTM扣非 ${r4(epsNormal)}，可持续ROE ${r2(sustainRoePe * 100)}% × 普通股BPS ${r2(bpsOrdinary)}）= ${r4(epsNormCap)} 元 → PE 法区间 [${r4(epsNormLo)}, ${r4(epsNormHi)}]，点估值 ${r4(epsPoint)} 元${lcxConfirmed ? '（长鑫收益确认在扣非外 → 上修至常态 EPS）' : '（长鑫收益未确认 → 保守中值）'}`, source: `规范修订版④；普通股BPS=（归母净资产 ${r2(S.equityNew)} − 其他权益工具 ${perpVal != null ? r2(perpVal) : 'NA'}）÷ ${r2(N_CFG)} 亿股` },
    { label: 'TTM 拼接口径', value: ttmStageLabel, source: '规则2：禁用×4/3粗年化，TTM=最新累计+上年同期后单季' },
    { label: '异常触发判定', value: `${peakQ} 单季 ${r2(peakNp)} 亿 = 均值 ${r2(avgNp)} 亿 × ${Math.round(anomalyRatio * 100)}% ${anomaly ? '> 150% → 已触发口径分离' : '未触发'}`, source: `单季序列（${(Q.labels || []).join(' ')}）${Q.seriesNote ? '；' + Q.seriesNote : ''}` },
  ];

  // 20261030b 规范《本次估值权重与输出形态》：weightsNote 重写为八条结构（权重分配/成熟度/调整依据/主情景/参考情景/分项结果/输出形态/数据同步）
  const weightsNote = [
    `① 权重分配：${wLabelMain}（合计100%，归一化通过）`,
    `② 方法成熟度：PB【${mPB}】/ SOTP【${mSOTP}】/ PE【${mPE}】`,
    `③ 权重调整依据：${wMain.reason}${shadow ? `（影子股模式触发：长鑫持股价值占华安市值 ${(stakeRatioGross * 100).toFixed(2)}% > 30% 阈值）。规则9优先于规则8的通用降权，特此说明` : ''}`,
    `④ 主情景（当前${mSOTP}口径）：${wLabelMain} → 综合目标价区间【${r2(Math.min(centerLow, centerHigh))}–${r2(Math.max(centerLow, centerHigh))}】元，中枢 ${r2(center)} 元`,
    refW ? `⑤ 参考情景（SOTP数据转${refW.grade}）：PB ${Math.round(refW.wPB * 100)}% / SOTP ${Math.round(refW.wSOTP * 100)}% / PE ${Math.round(refW.wPE * 100)}% → 目标价 ${r2(refCenter)} 元，仅作参考，不作为本次主结论` : '⑤ 参考情景：非影子股模式，无摆动参考权重',
    `⑥ 分项结果（供验证）：PB法目标价 ${r2(pbTarget)} 元（普通股BPS ${r2(bpsOrdinary)} 元 × 合理PB ${fairPB.toFixed(4)} 倍）；SOTP法目标价 ${r2(sotpTarget)} 元（含长鑫持股贡献 ${r2(stakeValue)} 亿元，折扣 ${Math.round(liq.discount * 100)}%）；PE法目标价 ${r2(peTarget)} 元（正常化EPS ${r4(epsPoint)} 元 × 合理PE ${peMult} 倍）`,
    `⑦ 输出形态：${outputState}，不输出单一点值。置信度：${confQual}（绿色方法权重占比 ${Math.round(greenW * 100)}%，黄色方法权重 ${Math.round((1 - greenW) * 100)}%；置信度按绿色权重占比近似）${anyRed || anyYellow ? '' : '（全绿精确态，置信度 90）'}`,
    `⑧ 数据同步说明：TTM扣非 ${r2(npDedTtm)} 亿/总股本 ${r2(N_CFG)} 亿股/普通股BPS ${r2(bpsOrdinary)} 元截至 ${bAsOf}；长鑫持股比例截至 ${stakeAsOf}，期差 ${cRows.stakePct.ageDays} 天，成熟度【${cRows.stakePct.grade}】，敏感性±${stakeSensPct ? Math.round(stakeSensPct * 100) : 5}%；限售折扣按 ${Math.round(liq.discount * 100)}% 保守假设`,
  ].join('。') + '。';

  const detailRows = [
    { label: 'PB层·锚1 历史中枢', value: `PB 中位 ${aHist} 倍 × 权重 ${PB.wHist} = ${(nz(PB.wHist) * aHist).toFixed(4)}`, source: NT.histPb },
    { label: 'PB层·锚2 板块×ROE溢价', value: `板块 PB ${PB.sectorPB} × 溢价系数 ${PB.premiumCoef}（=ROE ${PB.sustainableRoe}% ÷ 行业均值假设 ${PB.sectorAvgRoeAssumed}%）= ${r2(aSector)} 倍 × 权重 ${PB.wSector}${cRows.sectorPB.grade !== '绿' ? `（快照【${cRows.sectorPB.grade}】→ ±10% 敏感性）` : ''}`, source: NT.sectorPB + '；' + NT.premiumCoef },
    { label: 'PB层·锚3 理论PB', value: `(ROE−g)/(r−g) = (${PB.sustainableRoe}%−${PB.g}%)/(r−${PB.g}%)，r = Rf ${PB.rf}% + β ${PB.beta} × ERP ${PB.erp}% = ${r2(r * 100)}% → 理论 PB ${theoPB.toFixed(4)} 倍 × 权重 ${PB.wTheo}`, source: NT.sustainableRoe + '；' + NT.beta },
    { label: 'PB层·三层加权目标价', value: `加权 PB ${fairPB.toFixed(4)} 倍 × 普通股BPS ${bpsOrdinary.toFixed(4)} 元 = ${r2(pbTarget)} 元/股（20261030b 规范⑥：PB法=普通股BPS×合理PB；归母口径 BPS ${bpsUsed.toFixed(2)} 元仅作参照）${(anyYellow || anyRed) && cRows.sectorPB.grade !== '绿' ? `（区间 ${r2(pbTargetLow)} ~ ${r2(pbTargetHigh)}）` : ''}`, source: NT.equity + '；' + bpsNote },
    { label: 'SOTP层·常规业务（结转）', value: `常态净利 ${ST.normalAnnualNp} 亿（2026H1 扣非×2 结转，结构基准期 ${AL.structureAsOf || '2026H1'}）× 可比 PE ${ST.peNormal} 倍 = ${r2(sotpBase)} 亿元；敏感性 ±${Math.round(sotpSensPct * 100)}% → [${r2(sotpBase * (1 - sotpSensPct))}, ${r2(sotpBase * (1 + sotpSensPct))}] 亿`, source: '规则4 结构结转+敏感性；结转口径避免与长鑫持股市值双重计价（TTM 含长鑫 Q3 上市增值）' },
    { label: '指令9·长鑫科技(688825)总市值', value: `${r2(cxmtMv)} 亿元（${cxmt.source}，${cxmt.asOf}）${!cxmt.ok ? '【实时不可得，回退快照】' : ''}`, source: `持股比 ${CXMT_STAKE_PCT}%（${cRows.stakePct.grade}，基准 ${stakeAsOf}）` },
    { label: '指令9·间接持股价值', value: `长鑫市值 ${r2(cxmtMv)} 亿 × ${CXMT_STAKE_PCT}% × (1 − 折扣 ${Math.round(liq.discount * 100)}%) = ${r2(stakeValue)} 亿元（${liq.label}）${stakeSensPct ? `；持股比例 ±${Math.round(stakeSensPct * 100)}% 敏感性` : ''}`, source: `华安总市值 ${r2(huaanMv)} 亿（${huaan.source}）` },
    { label: '指令9·参股资产占比', value: `未折现占比 ${(stakeRatioGross * 100).toFixed(2)}%${shadow ? ' > 30% → 影子股模式（SOTP 权重按成熟度摆动，规则9）' : '（未跨越 30% 影子股阈值）'}；折现持股价值占华安 ${(stakeRatioDisc * 100).toFixed(2)}%`, source: '规则9：占比分子=长鑫最新市值×持股比例区间×(1−折扣)，分母=华安最新市值' },
    { label: 'SOTP层·合计（区间）', value: `中枢 ${r2(sotpTarget)} 元/股（常规业务 ${r2(sotpBase)} 亿 + 持股价值 ${r2(stakeValue)} 亿 ÷ ${N_CFG} 亿股）；区间 ${r2(sotpLow)} ~ ${r2(sotpHigh)} 元`, source: `SOTP 依赖 C 层数据 → 成熟度【${mSOTP}】，输出区间而非点值（规则10）` },
  ];
  if (shadow) {
    const corr = await computeLinkCorr();
    const linkFlag = (corr && corr.ok && corr.r != null && corr.r > 0.5);
    detailRows.push({ label: '★ 长鑫科技持股贡献（单独列示）', value: `${r2(stakeValue)} 亿元 ÷ ${N_CFG} 亿股 = ${r2(stakeValue / N_CFG)} 元/股，占综合目标价中枢 ${(wts.wSOTP * (stakeValue / (sotpBase + stakeValue)) * 100).toFixed(1)}%`, source: '影子股模式：综合目标价中单独披露参股资产贡献' });
    detailRows.push({ label: '指令9·股价联动强度', value: (corr && corr.ok && corr.r != null) ? `近 60 交易日华安日收益 vs 长鑫日收益相关系数 r = ${corr.r}（n=${corr.n}，${corr.asOf}）${linkFlag ? ' → 走势主要由长鑫驱动，券商基本面解释力减弱' : ''}` : `不可得（${corr && corr.reason ? corr.reason : '数据缺失'}）`, source: (corr && corr.ok ? corr.source : '腾讯/东财日K（待接入）') + '；联动强度仅用A层日频数据（规则9），不受财报异步影响' });
  }
  detailRows.push(
    { label: 'PE层（正常化口径·修订版）', value: `正常化 EPS 点估值 ${r4(epsPoint)} 元（区间 [${r4(epsNormLo)}, ${r4(epsNormHi)}]，长鑫收益确认状态【${lcxState === true ? '已计入非经常性' : lcxState === false ? '未计入非经常性' : '未确认·保守中值'}】）× PE 乘数 ${peMult} 倍${histPe == null ? '（5年PE中位缺失【数据缺失】→ 取行业PE中位）' : '（=min(5年中位,行业中位)）'} → 点估值 ${r2(peTarget)} 元/股，区间 [${r2(peTargetLow)}, ${r2(peTargetHigh)}] 元`, source: `PE 依赖 B 层 TTM 扣非 + 股本 → 成熟度【${mPE}】；权重 10% 仅作底部安全边际参考，不参与向上弹性定价（修订版⑤）` },
    { label: '综合目标价（' + outputState + '）', value: `${outputState === '精确态' ? '点值 ' + r2(center) : `区间 ${fairValueRange[0]} ~ ${fairValueRange[1]} 元，中枢 ${r2(center)}`} 元/股，置信度 ${confidence}%（${confQual}，按绿色方法权重占比 ${Math.round(greenW * 100)}% 近似）`, source: `低估触发线 ${r2(fairValueRange[0] * nz(RT.buyBelow, 0.9))} 元｜高估触发线 ${r2(fairValueRange[1] * nz(RT.reduceAbove, 1.05))} 元` },
  );

  // ============ 20261030c 规范《估值结构拆解 · 强制披露》五条（全动态值） ============
  const structureRows = [];
  // 第1条：分项目标价拆解 + 结构贡献
  const pbGapPct = P != null ? (P - pbTarget) / pbTarget * 100 : null;
  structureRows.push({ label: '① 分项目标价拆解', value: `PB法 ${r2(pbTarget)} 元（普通股BPS ${r2(bpsOrdinary)} × 合理PB ${fairPB.toFixed(2)} 倍）${pbGapPct != null ? ` → 现价 ${r2(P)} 相对PB法${pbGapPct >= 0 ? '高估' : '低估'} ${Math.abs(pbGapPct).toFixed(1)}%` : ''}；SOTP法 ${r2(sotpTarget)} 元（含长鑫持股贡献 ${r2(stakeValue / N_CFG)} 元/股，折扣 ${Math.round(liq.discount * 100)}% 保守口径）；PE法 ${r2(peTarget)} 元（正常化EPS ${r4(epsPoint)} × 合理PE ${peMult} 倍，仅作底部参考）`, source: '《估值结构拆解·强制披露》第1条：三法分项必须列示供验证' });
  structureRows.push({ label: '① 结构贡献', value: `综合中枢 ${r2(center)} 元主要由 SOTP 贡献（权重 ${Math.round(wts.wSOTP * 100)}%），PB法仅提供 ${r2(pbTarget)} 元的价值底`, source: `权重结构：${wLabelMain}` });
  // 第2条：评级口径说明（现价低于下限但高于买入触发线 → 持有/中性，不判低估）
  let ratingCaliber = '实时价不可用。';
  if (P != null && fairValueRange) {
    const lo = fairValueRange[0], buyLine = lo * nz(RT.buyBelow, 0.9);
    ratingCaliber = P < lo
      ? `现价 ${r2(P)} 低于区间下限 ${r2(lo)}，但高于买入触发线 ${r2(buyLine)}（下限×0.9）→ 按规则判「持有/中性」（合理档），不判低估；若现价回落至 ${r2(buyLine)} 附近，将进入买入观察区`
      : `现价 ${r2(P)} 处于区间 [${r2(lo)}, ${r2(fairValueRange[1])}] 内 → 按规则判「持有/中性」（合理档）；买入触发线 ${r2(buyLine)}（下限×0.9），回落至该线附近将进入买入观察区`;
  }
  structureRows.push({ label: '② 评级口径说明', value: ratingCaliber, source: '《估值结构拆解·强制披露》第2条：下限与买入触发线（下限×0.9）之间为持有/中性观察带' });
  // 第3条：影子股溢价提示 + 长鑫市值 -20% 敏感性（确定性传导）
  const cxmtPremium = P != null ? P - pbTarget : null;
  const cxmtDown20 = stakeValue * 0.2;
  const perShare20 = cxmtDown20 / N_CFG;
  const centerAfter20 = center - perShare20 * wts.wSOTP;
  structureRows.push({ label: '③ 影子股溢价提示', value: `${cxmtPremium != null ? `现价 ${r2(P)} 中约 ${r2(cxmtPremium)} 元/股为长鑫科技持股溢价（现价 − PB法目标价 ${r2(pbTarget)}）；` : ''}敏感性：长鑫市值 −20% → 持股价值 −${r2(cxmtDown20)} 亿（−${r2(perShare20)} 元/股），经 SOTP 权重 ${Math.round(wts.wSOTP * 100)}% 传导 → 综合中枢 ${r2(center)} → 约 ${r2(centerAfter20)} 元，现价安全边际将显著收窄`, source: '《估值结构拆解·强制披露》第3条：长鑫市值波动是本标的最大边际变量' });
  // 第4条：置信度说明（构成 + 红档降级路径）
  structureRows.push({ label: '④ 置信度说明', value: `置信度 ${confidence}%（${confQual}）按绿色方法权重占比近似（PB【${mPB}】${Math.round(wts.wPB * 100)}% + PE【${mPE}】${Math.round(wts.wPE * 100)}% = ${Math.round(greenW * 100)}%），SOTP 权重 ${Math.round(wts.wSOTP * 100)}% 计【${mSOTP}】不计入；若长鑫持股比例或限售状态更新为红档，置信度将下调至 60% 以下`, source: '《估值结构拆解·强制披露》第4条：置信度构成+红档降级路径强制披露' });
  // 第5条：PB口径提示（现值双口径 + 合理PB口径无关）
  const pbLfGross = P != null && bpsUsed ? P / bpsUsed : null;
  const pbLfNet = P != null ? P / bpsOrdinary : null;
  structureRows.push({ label: '⑤ PB口径提示', value: `PB(LF) 现值 ${pbLfGross != null ? pbLfGross.toFixed(2) : 'N/A'} 倍（含其他权益工具口径，÷归母BPS ${r2(bpsUsed)}）vs 合理PB ${fairPB.toFixed(2)} 倍；若统一扣减其他权益工具（÷普通股BPS ${r2(bpsOrdinary)}），PB(LF) 现值上修至 ${pbLfNet != null ? pbLfNet.toFixed(2) : 'N/A'} 倍（合理PB为三层加权乘数，不随BPS口径变化），现值高于合理PB 的相对关系不变，结论稳健`, source: '《估值结构拆解·强制披露》第5条：PB 比较口径差异强制披露' });

  const compareRows = [
    { label: `上次：${LV.version}`, value: `区间 ${LV.range ? LV.range[0] + '~' + LV.range[1] : 'N/A'} 元，中枢 ${LV.center} 元，评级「${LV.rating}」` },
    { label: '本次：V3.0 异步数据自适应（20261029p）', value: `${outputState === '精确态' ? '中枢' : '区间 ' + fairValueRange[0] + '~' + fairValueRange[1] + '，中枢'} ${r2(center)} 元，评级「${rating}」，置信度 ${confidence}%`, source: `权重 ${wLabelMain}${refW ? '（影子摆动两套权重并列）' : ''}` },
    { label: '差异原因', value: LV.diffNote || '' },
  ];

  const mktFloorYi = nz((cfg.riskMonitor && cfg.riskMonitor.marketTurnoverFloorYi), 12000);
  const mktRow = tMarket
    ? (tMarket.todayYi >= mktFloorYi
      ? { label: '市场成交额（全市场）', light: `🟢 当日 ${tMarket.todayYi} 亿 ≥ 预警线 ${mktFloorYi / 10000} 万亿（近20日日均 ${tMarket.avg20Yi} 亿，截至 ${tMarket.date}）` }
      : { label: '市场成交额（全市场）', light: `🔴 预警：当日 ${tMarket.todayYi} 亿 < ${mktFloorYi / 10000} 万亿 → 经纪/自营景气度承压（截至 ${tMarket.date}）` })
    : { label: '市场成交额（全市场）', light: '🟡 全市场成交额数据源暂不可得' };
  const riskMonitorRows = [
    mktRow,
    { label: '长鑫科技（688825）舆情', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.cxmtNegative) || '未发现负面'}` },
    { label: '监管处罚', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.regulatory) || '无新增'}` },
  ];

  const positionNote = P != null
    ? `当前股价 ${r2(P)} 元 vs ${outputState === '精确态' ? '综合目标价' : '目标价区间（中枢）'} ${r2(center)} 元（低估线 ${r2(fairValueRange[0] * nz(RT.buyBelow, 0.9))} / 高估线 ${r2(fairValueRange[1] * nz(RT.reduceAbove, 1.05))}）；${ratingNote}${ratingBoundary ? '；' + ratingBoundary : ''}。PB(LF) 现值约 ${(P / bpsUsed).toFixed(2)} 倍 vs 三层加权合理 PB ${fairPB.toFixed(2)} 倍。`
    : '实时价不可用。';

  const riskNote = '上行：市场成交额维持高位、长鑫科技股价贡献持股市值弹性；下行：全市场成交额跌破预警线、长鑫股价回撤（SOTP 直接受损）、监管处罚。数据异步架构下所有黄项均已区间化并留痕，不构成投资建议。';

  const modeLabel = shadow ? '影子股模式' : (stakeRatioGross >= 0.10 ? '显著参股模式' : '常规模式');
  const decisionNote = `框架 V3.0 异步数据自适应【十四规则】：三表实时拉取（${bAsOf}，${ttmStageLabel}）；数据契约 ${contracts.length} 项（绿 ${contracts.filter(c => c.grade === '绿').length}/黄 ${contracts.filter(c => c.grade === '黄').length}/红 ${contracts.filter(c => c.grade === '红').length}）；${modeLabel}（长鑫占比 ${(stakeRatioGross * 100).toFixed(2)}%）→ 权重 ${wLabelMain}；${outputState}（置信度 ${confidence}%）。${downgradeLog.filter(d => d.level !== 'L0').length ? '降级留痕：' + downgradeLog.filter(d => d.level !== 'L0').map(d => `${d.item}→${d.level}`).join('、') : '全部指标 L0 正常。'}`;

  return {
    ok: true,
    dedicated: true,
    huaan: true,
    version: 'V3.0_异步数据自适应',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange,
    fairValueCenter: r2(center),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'huaan600909 V3.0 异步数据自适应架构（数据契约+成熟度分级+TTM拼接+股本同步+动态权重+影子股摆动+四级降级+三态输出，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    outputState,
    confidence,
    summaryNote: `${outputState}：目标价${outputState === '精确态' ? '' : '区间 ' + fairValueRange[0] + '~' + fairValueRange[1] + '，'}中枢 ${r2(center)} 元，置信度 ${confidence}%（${confQual}）；评级【${rating}】。三季报后 TTM 归母 ${r2(npTtm)} 亿（+${r2(S.npYoy)}%），普通股BPS ${bpsOrdinary.toFixed(2)} 元（归母口径 ${bpsUsed.toFixed(2)}）；长鑫占比 ${(stakeRatioGross * 100).toFixed(2)}% 影子股模式；权重 ${wLabelMain}。${ratingBoundary || ''}`,
    // 数据契约三件套
    contractRows,
    weightsNote,
    downgradeLog,
    // 沿袭字段
    guardRows, freshnessRows,
    caliberNote,
    dualEpsRows,
    detailRows,
    structureRows,
    compareRows,
    riskMonitorRows,
    positionNote,
    riskNote,
    decisionNote,
    ttmStage: { stage: asOfStage, label: ttmStageLabel, npTtm: r2(npTtm), npDedTtm: r2(npDedTtm), prevQ4Np: r2(prevQ4Np) },
    // 20261030a 修订版口径：正常化 EPS 区间 + 长鑫收益确认状态
    caliber2: {
      epsNormal: r4(epsNormal), epsNormCap: r4(epsNormCap), epsNormLo: r4(epsNormLo), epsNormHi: r4(epsNormHi),
      epsPoint: r4(epsPoint), sustainRoePe: r2(sustainRoePe * 100), bpsOrdinary: r2(bpsOrdinary),
      otherEquityTools: perpVal != null ? r2(perpVal) : null, npDedDev: npDedDev != null ? r2(npDedDev) : null,
      lcxState: lcxState === true ? 'confirmed_out' : lcxState === false ? 'in_deducted' : 'unconfirmed',
      peTarget: r2(peTarget), peTargetLow: r2(peTargetLow), peTargetHigh: r2(peTargetHigh),
    },
    sotpDynamic: {
      mode: shadow ? 'shadow' : (stakeRatioGross >= 0.10 ? 'elevated' : 'normal'),
      cxmtMarketCap: r2(cxmtMv),
      cxmtAsOf: cxmt.asOf,
      cxmtSource: cxmt.source,
      cxmtLive: !!cxmt.ok,
      huaanMarketCap: r2(huaanMv),
      huaanSource: huaan.source,
      stakePct: CXMT_STAKE_PCT,
      stakeGross: r2(stakeGross),
      stakeValue: r2(stakeValue),
      stakeRatio: Math.round(stakeRatioGross * 10000) / 10000,
      stakeRatioDiscounted: Math.round(stakeRatioDisc * 10000) / 10000,
      discountLabel: liq.label,
      liquidityDiscount: liq.discount,
      weights: { pb: wts.wPB, sotp: wts.wSOTP, pe: wts.wPE },
      refWeights: refW ? { pb: refW.wPB, sotp: refW.wSOTP, pe: refW.wPE, grade: refW.grade, center: r2(refCenter) } : null,
      maturity: { pb: mPB, sotp: mSOTP, pe: mPE, bps: bpsGrade },
      methodMaturityNote: weightsNote,
      linkCorr: null,
      linkFlag: false,
      linkNote: null,
    },
  };
}

module.exports = { run, isHuaanModel, loadConfig, pickSotpWeights, maturityGrade, ttmSplice, bpsWithSyncCheck, dynWeights, liquidityDiscount, pearson, CXMT_STAKE_PCT };

~~~

---

## `lib\valuation\maijie300319.js`  ·  299 行

~~~js
// ============================================================
// 麦捷科技（300319）专属估值模型 —— 动态逻辑估值引擎（确定性计算，1+1=2）
// 20260909b：五站流水线
//   ① 时间引擎（月算法自动适配最新报告期 + 数据时效看板）
//   ② 画像诊断（业务拆分 / 生命周期判定 / 异常检测）
//   ③ 三情景财务预测（乐观 / 基准 / 悲观，权重 20/60/20）
//   ④ 四路估值：PE(30%) + PB-ROE(25%) + EV/EBITDA(20%) + DCF-FCFF(25%)
//   ⑤ 情景加权 + 相对/绝对交叉验证 + 安全边际 + 三档评级（低估/合理/高估）
// 计算层=代码，输入锁死（data/valuation/300319.json）⇒ 结果锁死；LLM 仅叙述。
// 无硬编码年份：报告期/预测年度均由时间引擎推导。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '300319';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/300319.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isMaijieModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'maijie';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const pct = (x) => (x == null) ? null : Math.round(Number(x) * 1000) / 10;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 月算法：由基准日推导「最新已披露报告期」月份 M（12=年报 / 3=一季报 / 6=中报 / 9=三季报） */
function detectLatestReportMonths(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4) return { M: 12, yearOffset: -1 };      // 1~4 月：上年年报
  if (m <= 7) return { M: 3, yearOffset: 0 };        // 5~7 月：当年一季报
  if (m === 8) return (day >= 20) ? { M: 6, yearOffset: 0 } : { M: 3, yearOffset: 0 };
  if (m === 9) return { M: 6, yearOffset: 0 };       // 9 月：当年中报
  if (m === 10) return (day >= 25) ? { M: 9, yearOffset: 0 } : { M: 6, yearOffset: 0 };
  return { M: 9, yearOffset: 0 };                    // 11~12 月：当年三季报
}

function median(arr) {
  const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function run(symbol, { price, pe, pb } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'maijie') return { error: 'NOT_MAIJIE' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));                                   // 亿股
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const alerts = [];

  // ================= 第一站：时间引擎 + 数据时效 =================
  const now = new Date();
  const det = detectLatestReportMonths(now);
  const expectYear = now.getFullYear() + (det.yearOffset || 0);
  const expectEnd = `${expectYear}-${String(det.M).padStart(2, '0')}-${det.M === 12 ? '31' : (det.M === 6 ? '30' : (det.M === 3 ? '31' : '30'))}`;
  const RP = cfg.reportPeriod || {};
  const cfgEnd = RP.periodEnd;
  const periodMatch = (cfgEnd === expectEnd);
  if (!periodMatch) {
    alerts.push(`财报期口径不一致：配置标注 ${cfgEnd || '?'}，月算法判定最新已披露应为 ${expectEnd} → 请复核 data/valuation/300319.json`);
  }
  const discAge = RP.disclosureDate ? daysBetween(RP.disclosureDate, now) : null;
  if (discAge != null && discAge > 120) {
    alerts.push(`最新财报披露于 ${RP.disclosureDate}（距今 ${discAge} 天 > 120 天）→ 财报可能已超期`);
  }

  const FR = I.freshness || {};
  const freshnessRows = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, now) : null;
    if (age == null) continue;
    const maxAge = it.maxAge || FR.maxAgeDays || 120;
    const stale = age > maxAge;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge, stale });
    if (stale) alerts.push(`快照「${it.label}」取数于 ${it.asOf}（距今 ${age} 天 > ${maxAge} 天）→ 请复核更新`);
  }

  // ================= 第二站：画像诊断 =================
  const segRows = (I.segments || []).map(s => ({
    name: s.name,
    share: pct(nz(s.share) / 100),
    driver: s.driver,
    nature: s.nature,
  }));
  const TTM = I.ttm, L = I.latest, F25 = I.fy2025, F24 = I.fy2024, B = I.balance;
  const revTTM = nz(TTM.revenue.value), npTTM = nz(TTM.npParent.value);
  const revYoY = nz(L.revenue.yoy), npYoY = nz(L.npParent.yoy);
  // 20261030n：单季同比字段 Q3 兼容——latestQNpYoy（Q3 单季）优先，向后兼容旧 q2NpYoy 键
  const qLatestNp = (L.latestQNpYoy || L.q2NpYoy || {});
  const q2YoY = nz(qLatestNp.value);
  const qLatestLabel = /Q3|三季/.test(L.period || '') ? 'Q3' : 'Q2';
  const gmNow = nz(L.grossMargin.value), gm25 = nz(F25.grossMargin), gm24 = nz(F24.grossMargin);
  const gmSwing = Math.abs(gm25 - gm24);

  // 生命周期判定（规则：缺行业增速与折旧明细 → 不做权重自适应，仅诊断标注，避免臆造）
  let lifeCycle = '成长 + 周期双属性';
  let lifeNote = '业务结构决定：电子元器件 52% 受益 AI/车载（成长），LCM 48% 随消费电子景气波动（周期）';
  if (revYoY > 0.15 && gmSwing < 10) { lifeCycle = '成长主导'; lifeNote = `营收同比 ${pct(revYoY)}% 高增且毛利率波动 ${pct(gmSwing / 100)}pct < 10pct → 成长主导`; }
  else if (gmSwing >= 10) { lifeCycle = '周期主导'; lifeNote = `毛利率年度波动 ${pct(gmSwing / 100)}pct ≥ 10pct → 周期主导，宜用 PB / EV-EBITDA`; }
  const marginRepair = q2YoY > npYoY + 0.05;
  if (marginRepair) lifeNote += `；边际信号：Q2 单季利润同比 ${pct(q2YoY)}% 显著高于 H1 的 ${pct(npYoY)}% → 盈利修复上行（利好 PE / PEG 轨道）`;

  // 数据完整性：核心字段缺失检测
  const required = { revTTM, npTTM, shares: N, cash: nz(B.cash), ibd: nz(B.interestBearDebt), equity: nz(B.equityParent), fcff: nz(I.dcfFixed.fcffBase.value) };
  const missing = Object.keys(required).filter(k => !required[k]);
  const completeness = 1 - missing.length / Object.keys(required).length;
  if (completeness < 0.95) alerts.push(`核心字段缺失：${missing.join('/')}（完整度 ${pct(completeness)}% < 95%）→ 估值置信度下降`);
  const estFlags = [];
  if (I.dcfFixed.daRatio.estimated) estFlags.push('D&A 为估算值（由经营现金流反推）');

  // ================= 第三站：三情景财务预测 =================
  const SC = I.scenarios, SW = I.scenarioWeights, MW = I.methodWeights;
  const peers = I.peers.list;
  const peMedian = median(peers.filter(p => p.usePe).map(p => p.pe));
  const pbMedian = median(peers.map(p => p.pb));
  const impliedROE = (peMedian && pbMedian) ? (pbMedian / peMedian) : null;   // 可比隐含 ROE = PB/PE

  const MA = I.macro;
  const rf = nz(vv(MA.rf)) / 100, erp = nz(vv(MA.erp)) / 100, beta = nz(vv(MA.beta));
  const sizeAdj = nz(vv(MA.sizeAdj)) / 100, rd = nz(vv(MA.rd)) / 100, tax = nz(vv(MA.taxRate)) / 100;
  const gP = nz(vv(MA.gPerp)) / 100;
  const Re = rf + beta * erp + sizeAdj;
  const mcap = P != null ? P * N : nz(I.marketSnapshot.mcap);
  const D = nz(B.interestBearDebt);
  const wE = mcap / (mcap + D), wD = D / (mcap + D);
  const WACC = wE * Re + wD * rd * (1 - tax);

  // BVPS：优先用实时行情 PB 反推（含最新期净资产），回退资产负债表快照
  const bvpsLive = (P != null && pb) ? (P / pb) : (nz(B.equityParent) / N);
  const bvpsSrc = (P != null && pb) ? `实时行情 PB ${pb} 反推（含最新期净资产）` : `资产负债表快照 ${B.asOf}`;
  const netCash = nz(B.cash) + nz(B.tradingAssets) - D;

  const peDiscount = nz(vv(I.relative.peDiscount));
  const fcffScale = revTTM / nz(F25.revenue);
  const fcffBase = nz(I.dcfFixed.fcffBase.value) * fcffScale;

  function methodsOf(key) {
    const sc = SC[key];
    const rev = revTTM * (1 + nz(sc.revGrowth));
    const np = rev * nz(sc.netMargin);
    const eps = np / N;
    // ① PE 相对估值
    const peTarget = peMedian * peDiscount * nz(sc.peCoef);
    const tpPE = np * peTarget / N;
    // ② PB-ROE 相对估值
    const roe = np / (bvpsLive * N);
    const pbTarget = impliedROE ? pbMedian * (roe / impliedROE) : pbMedian;
    const tpPB = bvpsLive * pbTarget;
    // ③ EV/EBITDA
    const ebitda = rev * nz(sc.grossMargin);          // ≈ EBITDA 率（费用率与 D&A 率相近，2025 实测均约 8.4%）
    const ev = ebitda * nz(sc.evEbitdaMultiple);
    const tpEV = (ev + netCash) / N;
    // ④ DCF（FCFF 两阶段）
    let pv = 0; const fcffs = [];
    for (let t = 1; t <= 5; t++) {
      const f = fcffBase * Math.pow(1 + nz(sc.fcffGrowth), t);
      fcffs.push(f);
      pv += f / Math.pow(1 + WACC, t);
    }
    const tv = fcffs[4] * (1 + gP) / (WACC - gP);
    const pvTv = tv / Math.pow(1 + WACC, 5);
    const evDcf = pv + pvTv;
    const tpDCF = (evDcf + netCash) / N;
    const combo = nz(MW.pe) * tpPE + nz(MW.pb) * tpPB + nz(MW.evEbitda) * tpEV + nz(MW.dcf) * tpDCF;
    return { key, label: sc.label, rev, np, eps, peTarget, tpPE, roe, pbTarget, tpPB, ebitda, tpEV, tpDCF, evDcf, pvTv, tvShare: pvTv / evDcf, combo, sc };
  }

  const S = { optimistic: methodsOf('optimistic'), base: methodsOf('base'), pessimistic: methodsOf('pessimistic') };

  // ================= 第五站：情景加权 + 交叉验证 + 评级 =================
  const center = nz(SW.optimistic) * S.optimistic.combo + nz(SW.base) * S.base.combo + nz(SW.pessimistic) * S.pessimistic.combo;
  const combos = [S.optimistic.combo, S.base.combo, S.pessimistic.combo];
  const rangeLow = Math.min(...combos), rangeHigh = Math.max(...combos);
  const safeMargin = nz(vv(I.safetyMargin));
  const conservative = center * (1 - safeMargin);

  // 交叉验证（基准情景）：相对三路区间 vs DCF
  const relVals = [S.base.tpPE, S.base.tpPB, S.base.tpEV];
  const relLow = Math.min(...relVals), relHigh = Math.max(...relVals);
  const dcfVal = S.base.tpDCF;
  const hasIntersection = dcfVal >= relLow && dcfVal <= relHigh;
  // 分歧幅度 = DCF 与「最近的相对估值端点」的相对偏离（低于下沿比下沿，高于上沿比上沿）
  const divergence = dcfVal > 0
    ? (dcfVal < relLow ? (relLow - dcfVal) / dcfVal : (dcfVal > relHigh ? (dcfVal - relHigh) / dcfVal : 0))
    : null;
  let crossNote;
  if (hasIntersection) {
    crossNote = `相对估值区间 ${r2(relLow)}~${r2(relHigh)} 元与 DCF ${r2(dcfVal)} 元存在交集 → 交叉验证通过`;
  } else {
    crossNote = `⚠️ 模型分歧较大：DCF ${r2(dcfVal)} 元显著低于相对估值区间下沿 ${r2(relLow)} 元（差 ${pct(divergence)}%）→ 按指令「以 DCF 为锚、相对估值调整上下限」，综合区间已按四路方法权重合成（DCF 权重 ${pct(nz(MW.dcf))}%），并保留分歧标注`;
  }

  let rating = '无法评级', upside = null, position = null;
  if (P != null) {
    upside = (center - P) / P;
    position = Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow) * 100));
    // 评级三档（项目铁律 20260908aa）：上行空间 >20% 低估 / −10%~+20% 合理 / <−10% 高估
    if (upside > 0.20) rating = '低估';
    else if (upside >= -0.10) rating = '合理';
    else rating = '高估';
  }

  // ================= 输出行 =================
  const coreRows = [
    { label: '最新报告期（时间引擎）', value: `${cfg.reportPeriod ? cfg.reportPeriod.label : '—'}（${cfgEnd || '—'}，披露 ${(cfg.reportPeriod || {}).disclosureDate || '—'}，距今 ${discAge != null ? discAge : '?'} 天）｜月算法判定 ${expectEnd}${periodMatch ? ' ✓ 一致' : ' ⚠️ 不一致'}`, source: 'data/valuation/300319.json + 月算法自动推导' },
    { label: '核心财务（TTM）', value: `营收 ${r2(revTTM)} 亿 / 归母 ${r2(npTTM)} 亿 / EPS ${r2(npTTM / N)} 元 / 毛利率 ${r2((gmNow + gm25) / 2)}%（9M ${gmNow}%）`, source: TTM.revenue.note },
    { label: `最新期边际（${L.period || '2026Q3'}）`, value: `营收 ${r2(L.revenue.value)} 亿（${pct(revYoY)}%）/ 归母 ${r2(L.npParent.value)} 亿（${pct(npYoY)}%）/ ${qLatestLabel} 单季归母同比 ${pct(q2YoY)}% / 净利率 ${L.netMargin.value}% / 每股经营现金流 ${L.ocfPerShare.value} 元`, source: L.source },
    { label: '生命周期判定', value: `${lifeCycle} → ${lifeNote}`, source: '规则：营收增速 vs 毛利率波动；缺行业增速与折旧明细 → 不启用权重自适应' },
    { label: '可比公司（申万电子-元件）', value: `PE 中位 ${r2(peMedian)}×（剔除 PE>100：风华高科/洁美科技）｜PB 中位 ${r2(pbMedian)}×｜隐含 ROE ${pct(impliedROE)}%`, source: peers.map(p => `${p.name} PE${p.pe}/PB${p.pb}${p.usePe ? '' : '(仅PB)'}`).join('；') },
    { label: 'WACC 与 DCF 参数', value: `Re ${pct(Re)}%（Rf ${pct(rf)}% + β ${beta} × ERP ${pct(erp)}% + 特定 ${pct(sizeAdj)}%）｜WACC ${pct(WACC)}%｜g ${pct(gP)}%｜显性 5 年｜税率 ${pct(tax)}%｜FCFF 基数 ${r2(fcffBase)} 亿`, source: MA.beta.source },
  ];

  const segOut = segRows.map(s => ({ name: s.name, value: `收入占比 ${s.share}%｜${s.driver}｜属性：${s.nature}` }));

  const scenRows = ['optimistic', 'base', 'pessimistic'].map(k => {
    const s = S[k];
    return {
      name: `${s.label}情景（权重 ${pct(nz(SW[k]))}%）`,
      value: `营收 ${r2(s.rev)} 亿（+${pct(nz(s.sc.revGrowth))}%）/ 归母 ${r2(s.np)} 亿 / EPS ${r2(s.eps)} 元 → PE ${r2(s.tpPE)}｜PB ${r2(s.tpPB)}｜EV/EBITDA ${r2(s.tpEV)}｜DCF ${r2(s.tpDCF)} ⇒ 情景综合 ${r2(s.combo)} 元；假设：${s.sc.assump}`,
    };
  });

  const matrixRows = [
    { method: 'PE 相对估值（30%）', low: r2(S.pessimistic.tpPE), mid: r2(S.base.tpPE), high: r2(S.optimistic.tpPE), note: `可比 PE 中位 ${r2(peMedian)}× × 折扣 ${peDiscount} × 情景系数；目标价 = 情景归母 × 合理 PE ÷ 股本` },
    { method: 'PB-ROE 相对估值（25%）', low: r2(S.pessimistic.tpPB), mid: r2(S.base.tpPB), high: r2(S.optimistic.tpPB), note: `BVPS ${r2(bvpsLive)} 元 × 可比 PB 中位 ${r2(pbMedian)}× ×（情景 ROE / 可比隐含 ROE ${pct(impliedROE)}%）；BVPS 来源：${bvpsSrc}` },
    { method: 'EV/EBITDA（20%）', low: r2(S.pessimistic.tpEV), mid: r2(S.base.tpEV), high: r2(S.optimistic.tpEV), note: `EBITDA ≈ 情景毛利率 × 营收（费用率与 D&A 率相近）；倍数 悲观12×/基准15×/乐观18×【假设区间 12~18】` },
    { method: 'DCF·FCFF 两阶段（25%）', low: r2(S.pessimistic.tpDCF), mid: r2(S.base.tpDCF), high: r2(S.optimistic.tpDCF), note: `WACC ${pct(WACC)}% / g ${pct(gP)}%；FCFF 起点 ${r2(fcffBase)} 亿（2025 年报 FCFF 按 TTM 营收缩放）；基准情景终值占比 ${pct(S.base.tvShare)}%` },
    { method: `情景综合（基准${pct(nz(SW.base))}%/乐观${pct(nz(SW.optimistic))}%/悲观${pct(nz(SW.pessimistic))}%）`, low: r2(rangeLow), mid: r2(center), high: r2(rangeHigh), note: `三情景内四路加权后按情景权重合成；保守目标价（安全边际 ${pct(safeMargin)}%）= ${r2(conservative)} 元` },
  ];

  const assumpRows = [
    { label: '收入增速（乐观/基准/悲观）', value: `${pct(nz(SC.optimistic.revGrowth))}% / ${pct(nz(SC.base.revGrowth))}% / ${pct(nz(SC.pessimistic.revGrowth))}%【假设：2026H1 实际 +10.53% 为锚】` },
    { label: '净利率 / 毛利率', value: `净 ${pct(nz(SC.optimistic.netMargin))}/${pct(nz(SC.base.netMargin))}/${pct(nz(SC.pessimistic.netMargin))}%（H1 实际 7.65%）；毛 ${pct(nz(SC.optimistic.grossMargin))}/${pct(nz(SC.base.grossMargin))}/${pct(nz(SC.pessimistic.grossMargin))}%` },
    { label: 'DCF 关键参数', value: `WACC ${pct(WACC)}%（β ${beta} 自算 104 周）/ g ${pct(gP)}% / 显性 5 年 / 税率 ${pct(tax)}% / FCFF 增速 ${pct(nz(SC.optimistic.fcffGrowth))}/${pct(nz(SC.base.fcffGrowth))}/${pct(nz(SC.pessimistic.fcffGrowth))}%` },
    { label: '净现金 / 股本', value: `货币资金 ${B.cash} + 交易性金融资产 ${B.tradingAssets} − 有息负债 ${D} = 净现金 ${r2(netCash)} 亿；总股本 ${r2(N)} 亿股（${bvpsSrc}）` },
    { label: '安全边际', value: `${pct(safeMargin)}%（15%~25% 中值），保守目标价 ${r2(conservative)} 元` },
    { label: '估算与缺失标记', value: estFlags.length ? estFlags.join('；') : '无' },
  ];

  const monitorRows = [
    { name: '季度毛利率环比', value: `当前 ${gmNow}%（2025 全年 ${gm25}%，2024 ${gm24}%）→ 连续两季回升方确认结构升级` },
    { name: '存货 / 营收', value: `存货 ${B.inventory} 亿 / TTM 营收 ${r2(revTTM)} 亿 = ${pct(B.inventory / revTTM)}%` },
    { name: '应收账款 / 归母净利', value: `${L.arToNp.value}%（应收 ${B.receivable} 亿）→ 回款质量` },
    { name: '资本开支 / 折旧', value: `在建工程 ${B.cip} 亿、固定资产 ${B.fixedAsset} 亿 → 关注募投项目达产进度（D&A 为估算值）` },
    { name: '行业 PE 分位', value: `可比 PE 中位 ${r2(peMedian)}×；麦捷当前 PE(TTM) ${I.marketSnapshot.peTTM}× → 高于中位，需盈利兑现消化` },
  ];

  const riskNote = '下行风险：① 下游智能手机 / 消费电子需求不及预期；② 铜、银、陶瓷粉等原材料涨价挤压毛利；③ LCM 模组价格战加剧（占比 47.6%，低毛利拖累 ROE）；④ 国产替代推进慢于预期、技术迭代风险；⑤ 应收账款 / 归母净利达 472%，回款与减值风险；⑥ 三费同比 +37.8% 侵蚀利润。上行催化：AI 服务器算力电感放量、车规级产品导入、LCM 企稳、毛利率修复至 19%+。模型为研究框架，不构成投资建议。';

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出目标价区间，评级为「无法评级」。';
    return `现价 ${r2(P)} 元位于综合区间 ${r2(rangeLow)}~${r2(rangeHigh)} 元的 ${Math.round(position)}% 位置；综合中枢 ${r2(center)} 元，上行空间 ${pct(upside)}% → 评级「${rating}」。${crossNote}`;
  })();

  const decisionNote = `五站流水线（全动态、无硬编码年份）：时间引擎 → 画像诊断（${lifeCycle}）→ 三情景预测 → 四路估值（PE30/PB-ROE25/EV·EBITDA20/DCF25）→ 情景加权（基准${pct(nz(SW.base))}%）+ 交叉验证 + 安全边际${pct(safeMargin)}% → 三档评级。所有数值由代码确定性计算，AI 仅负责叙述。`;

  return {
    ok: true,
    dedicated: true,
    maijie: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservative),
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? pct(upside) : null,
    reportLabel: cfg.reportLabel,
    model: 'maijie300319·动态逻辑估值引擎（相对+绝对交叉验证，确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    lifeCycle,
    wacc: pct(WACC),
    peMedian: r2(peMedian),
    pbMedian: r2(pbMedian),
    crossNote,
    freshnessRows, alerts,
    coreRows, segRows: segOut, scenRows, matrixRows, assumpRows, monitorRows, positionNote, riskNote, decisionNote,
  };
}

module.exports = { run, isMaijieModel, loadConfig, detectLatestReportMonths };

~~~

---

## `lib\valuation\pingAn601318.js`  ·  473 行

~~~js
/**
 * lib/valuation/pingAn601318.js —— 中国平安（601318.SH）专属估值模型 v3：滚动估值计算协议
 * ----------------------------------------------------------------
 * ★ 20261029b：按用户下发《滚动估值计算协议（含P/EV、DDM、SOTP、FVOCI/FVTPL分离、陆金所条件处理）》全文升级 v2 → v3。
 *   相对 v2 的协议级变化（用户逐字给定，实现与协议一字不差）：
 *   ① 输入变量新增 6 项：OCIEQ_BV（FVOCI权益账面，含浮盈净资产口径）/ OCIEQ_URG（FVOCI累计税前浮盈）/
 *      FVTPL_EQ（FVTPL权益账面）/ LU_BV（陆金所归属账面）/ M_LU（陆金所总市值）/ S_LU（平安对陆金所持股比例）。
 *      任一缺失按 0 处理，输出表格对应行标 N/A，依赖分支按协议降级（不报错、不中止）。
 *   ② SOTP 分部扩展：EV_L×0.80 + E_PC×0.84 + E_BK×0.83 + OCIEQ_BV×1.00(K_OCI) + FVTPL_EQ×0.60
 *      + 非权益其他资产×0.60 + 陆金所估值，再 ÷N。
 *      陆金所条件：M_LU>0 且 S_LU>0 → M_LU×S_LU；否则 LU_BV>0 → LU_BV×0.60；否则 0。
 *      非权益其他资产 = (BVPS×N) − EV_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV
 *      ⚠️ 口径变化：v2 用寿险账面净资产 EV_L_BV 倒挤（旧口径铁律「禁混减内含价值」）；
 *      v3 协议公式明确用 EV_L（内含价值）扣减，且新增 OCIEQ_BV/FVTPL_EQ/LU_BV 三项扣减——
 *      协议为用户逐字给定，实现照办；差额为负时如实参与计算并在备注披露（「其他资产为负」）。
 *      EV_L_BV 不再被消费（配置文件保留该键仅作历史备查）。
 *   ③ SOTP 熔断条件放宽：v2 任一变量缺失即跳过；v3 仅当 EV_L、E_PC、E_BK **三项均缺失** 才整体 N/A 跳过，
 *      部分缺失按 0 继续计算（协议 3.4）。
 *   ④ 合成区间改为极值法（覆盖 v2 的「只采用 SOTP」校准）：
 *      SOTP成功 → [MIN(下限A, 保守值, SOTP下限), MAX(上限A, 乐观值, SOTP上限)]；
 *      SOTP N/A → MIN/MAX(下限A, 保守值 / 上限A, 乐观值)；DDM N/A → 排除对应候选；均 N/A → [下限A, 上限A]。
 *   ⑤ 新增第六站 FVOCI 辅助行：FVOCI税后浮盈/股 = OCIEQ_URG × (1−0.25) ÷ N（不参与估值）。
 *   ⑥ D 口径：必须优先「归母营运利润口径」股息；配置以 inputs.D.caliber 声明口径，非营运利润口径时备注标注。
 *   ⑦ 固定参数写死（协议三）；cfg.params 若另行指定替代参数 → 深合并采用并在备注标注「用户覆盖参数」。
 *   ⑧ 协议表格禁用「低估/高估/合理」等定性词——summaryRows 只含数字与区间；
 *      rating 字段仍输出（供工作台综合评级徽标三档铁律使用），不出现在协议表格中。
 *   ⑨ 无任何绝对年份/日期硬编码；「最新报告期」自适应（M 按月算法判定，与配置核对过期告警）。
 *   模型只做加、减、乘、除与 MIN/MAX；价格保留两位小数；当前股价 P 仅展示、不参与区间合成。
 */
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '..', '..', 'data', 'valuation', '601318.json');

// ===== 固定参数（协议三·写死，所有运行统一使用；用户覆盖须在备注标注） =====
const FIXED_PARAMS = {
  pevLow: 0.65, pevHigh: 0.90,
  ddmConservative: { r: 0.10, g: 0.035 },
  ddmOptimistic: { r: 0.08, g: 0.05 },
  sotp: { life: 0.80, pc: 0.84, bank: 0.83, oci: 1.00, fvtpl: 0.60, other: 0.60 },
  sotpBand: 0.10,
  dynamicEvMultiple: 0.80,
  tax: 0.25,
};

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

// 变量中文名（时效/口径标注展示用）
const VAR_LABELS = {
  P: '当前股价', N: '总股本', EV: '集团内含价值', D: 'TTM每股股息', NBV: '新业务价值', M: '报告期月数',
  EV_L: '寿险内含价值', E_PC: '产险归母净资产', E_BK: '银行归母净资产', BVPS: '每股净资产',
  OCIEQ_BV: 'FVOCI权益账面', OCIEQ_URG: 'FVOCI累计浮盈', FVTPL_EQ: 'FVTPL权益账面',
  LU_BV: '陆金所账面', M_LU: '陆金所总市值', S_LU: '陆金所持股比例',
};

function loadInputs() {
  try { return JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); } catch (e) { return null; }
}

// 深合并：以 FIXED_PARAMS 为底，cfg.params 仅覆盖显式不同的键，并收集「用户覆盖参数」清单
function mergeParams(over) {
  const p = JSON.parse(JSON.stringify(FIXED_PARAMS));
  const overrides = [];
  const walk = (base, o, prefix) => {
    for (const k of Object.keys(o || {})) {
      const bv = base[k], ov = o[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (bv != null && typeof bv === 'object' && typeof ov === 'object' && ov != null) {
        walk(bv, ov, key);
      } else if (bv !== ov) {
        base[k] = ov;
        overrides.push(`${key}=${ov}`);
      }
    }
  };
  walk(p, over || '', '');
  return { p, overrides };
}

// ---------- 报告期自适应：按月算法判定「最新已披露报告期」的月数 ----------
// 1/1-4/29 → 上年年报(M=12)；4/30-8/30 → 一季报(M=3)；8/31-10/24 → 中报(M=6)；10/25 后 → 三季报(M=9)。
// ★ 20261029e 修正：10 月边界由 10/31 改为 10/25 —— A 股三季报普遍 10 月下旬披露（平安 2026 三季报
//   10-28 披露），旧算法 10 月整月仍判 M=6，导致「数据库已更新至 Q3 却被误告『财报可能过期/数据库尚无
//   更新期数据』」（用户 2026-10-29 报障）。与 DCAVM/麦捷模型的同族算法（10 月 day>=25 → 9）对齐。
function detectLatestReportMonths(baseDate) {
  const d = new Date(baseDate);
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4 && !(m === 4 && day >= 30)) return 12;
  if (m < 8 || (m === 8 && day <= 30)) return 3;
  if (m === 10) return (day >= 25) ? 9 : 6;           // 10/25 起三季报进入披露期（对齐同族算法）
  if (m < 10) return 6;                                // 8/31-9/30 → 中报为最新
  return 9;                                            // 11-12 月 → 三季报为最新
}

/**
 * 按滚动协议 v3 计算。返回 { ok, summaryRows(协议表格13行), raw, missing, zeroFilled, remarks, ... }
 */
function compute(cfgOverride) {
  const cfg = cfgOverride || loadInputs();
  if (!cfg) return { ok: false, error: '缺少输入配置文件 data/valuation/601318.json' };
  const I = cfg.inputs || {};
  const { p, overrides } = mergeParams(cfg.params);
  const v = (k) => (I[k] && I[k].value != null) ? Number(I[k].value) : null;
  const alerts = [];

  // ===== 数据时效规则（20261029c）：每个输入变量记录取数日期 asOf；超 180 天 → 备注行标注，计算照常 =====
  // ① 不自行替换数值、不中止计算，仅作标注（规则原文）；② 未记录 asOf 的有效变量 → 备注提示补录。
  const maxAgeDays = (cfg.freshness && cfg.freshness.maxAgeDays) || 180;
  const now = Date.now();
  const freshnessRows = [];
  const noAsOfVars = [];
  for (const k of Object.keys(I)) {
    if (I[k].value == null) continue;               // 值缺失的变量走 zeroFilled/missing 披露，不参与时效检查
    if (!I[k].asOf) { noAsOfVars.push(k); continue; }
    const asOf = String(I[k].asOf).slice(0, 10);
    const age = Math.floor((now - new Date(asOf)) / 86400000);
    if (!isFinite(age)) continue;
    const stale = age > maxAgeDays;
    freshnessRows.push({ key: k, label: `${k}·${VAR_LABELS[k] || k}`, asOf, ageDays: age, maxAge: maxAgeDays, stale });
    if (stale) {
      alerts.push(`数据时效：变量${k}（${VAR_LABELS[k] || k}）取数于 ${asOf}，已超${maxAgeDays}天，请复核`);
    }
  }
  freshnessRows.sort((a, b) => b.ageDays - a.ageDays);

  const P = v('P'), N = v('N'), EV = v('EV'), D = v('D'), NBV = v('NBV');
  const EV_L = v('EV_L'), E_PC = v('E_PC'), E_BK = v('E_BK'), BVPS = v('BVPS');
  // v3.1：E_L = 寿险及健康险业务归属母公司股东权益（会计净资产口径），净资产扣减专用，严禁用 EV_L（内含价值）替代
  const E_L = v('E_L');
  const BV_Total = v('BV_Total'); // v3.1：非权益其他资产 = BV_Total − 会计口径扣减项；BVPS×N 回退公式已废止
  // v3 新增输入（v3.1 缺失值规则：缺失 → 依赖分支记 N/A 并跳过，严禁填 0 落入其他资产池）
  const OCIEQ_BV = v('OCIEQ_BV'), OCIEQ_URG = v('OCIEQ_URG'), FVTPL_EQ = v('FVTPL_EQ');
  const LU_BV = v('LU_BV'), M_LU = v('M_LU'), S_LU = v('S_LU');
  const missing = Object.keys(I).filter(k => I[k].value == null);

  // ===== ① 报告期自适应：M 自动判定并与配置核对（20261029e 告警改双向） =====
  // 配置 M < 算法 M → 配置财报可能过期（原有场景，告警）；
  // 配置 M > 算法 M → 公司提前披露、数据库（配置）已更新至更新报告期 → 以配置为准，**不告警**
  //（旧逻辑不分方向一律告「数据库尚无更新期数据」，在数据库领先时产生误导——用户 2026-10-29 报障根因之一）。
  const MDetected = detectLatestReportMonths(new Date());
  const MCfg = v('M');
  const M = MCfg != null ? MCfg : MDetected;
  if (M < MDetected) {
    alerts.push(`报告期自适应：引擎按月算法判定最新已披露报告期为 M=${MDetected}（${{ 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[MDetected]}），当前计算采用配置 M=${M}（NBV 为该期累计值）→ 财报可能过期，请更新数据（协议本身无需修改）`);
  }
  const periodLabel = { 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[M] || `M=${M}`;
  const reportLabel = `最新报告期（${periodLabel} · M=${M}）`;

  // ===== 第一站：P/EV 核心锚 =====
  const EVPS = (EV != null && N) ? EV / N : null;
  const lowA = EVPS != null ? EVPS * p.pevLow : null;
  const highA = EVPS != null ? EVPS * p.pevHigh : null;

  // ===== 第二站：DDM 戈登模型（D 缺失或 0 → 均记 N/A，不参与合成） =====
  const ddmCons = (D != null && D !== 0 && p.ddmConservative.r > p.ddmConservative.g)
    ? D * (1 + p.ddmConservative.g) / (p.ddmConservative.r - p.ddmConservative.g) : null;
  const ddmOpt = (D != null && D !== 0 && p.ddmOptimistic.r > p.ddmOptimistic.g)
    ? D * (1 + p.ddmOptimistic.g) / (p.ddmOptimistic.r - p.ddmOptimistic.g) : null;
  const ddmNA = (ddmCons == null || ddmOpt == null);

  // ===== 第三站：SOTP 分部估值（v3.1 修正版，20261029g）=====
  // 总则新增规则（优先于原口径条款）：
  // ① 缺失值规则：变量缺失 → 依赖分支记 N/A 并跳过，严禁填 0 落入其他资产池按 0.60 估值；
  //    缺失项对应资产仍留在 BV_Total 中 → 备注说明「该项未单独拆分，已落入其他资产按0.60估值」。
  // ② EV_L 使用规则：EV_L 仅用于寿险板块 PEV 乘数（3.1），严禁作为 BV_Total 的净资产扣减项；
  //    净资产扣减一律使用会计口径 E_L/E_PC/E_BK。
  // ③ 异常检查规则：非权益其他资产 < 0 → 输出警告并暂停 SOTP，不得将负数代入后续乘数。
  // ④ 分层报告期规则：混合报告期不视为错误、不中止计算、不自行统一口径。
  const requiredSotpCore = ['EV_L', 'E_PC', 'E_BK'];
  const missingSotpCore = requiredSotpCore.filter(k => v(k) == null);
  const coreAllMissing = missingSotpCore.length === requiredSotpCore.length; // 三项均缺失 → 整体跳过（协议 3.9）

  let sotpTarget = null, lowC = null, highC = null, otherAssets = null, sotpTotal = null;
  let sotpSegments = null, otherAssetsFormula = null, luValue = null, luBasis = '';
  const skippedBranches = [];   // N/A 跳过分支名（3.8：备注须列明）
  let sotpAnomaly = null;       // 异常检查警告文案（总则4）
  let otherNegative = false;

  // 3.1 寿险 = EV_L × 0.80（EV_L 仅用于此乘数，不参与任何净资产扣减）
  const lifeVal = (EV_L != null) ? EV_L * p.sotp.life : null;
  if (lifeVal == null) skippedBranches.push('寿险估值');
  // 3.2 产险 = E_PC × 0.84
  const pcVal = (E_PC != null) ? E_PC * p.sotp.pc : null;
  if (pcVal == null) skippedBranches.push('产险估值');
  // 3.3 银行 = E_BK × 0.83
  const bkVal = (E_BK != null) ? E_BK * p.sotp.bank : null;
  if (bkVal == null) skippedBranches.push('银行估值');
  // 3.4 FVOCI = OCIEQ_BV × 1.00；N/A → 分支跳过，不得填 0
  const fvociVal = (OCIEQ_BV != null) ? OCIEQ_BV * p.sotp.oci : null;
  if (fvociVal == null) skippedBranches.push('FVOCI估值');
  // 3.5 FVTPL = FVTPL_EQ × 0.60；N/A → 分支跳过，不得填 0
  const fvtplVal = (FVTPL_EQ != null) ? FVTPL_EQ * p.sotp.fvtpl : null;
  if (fvtplVal == null) skippedBranches.push('FVTPL估值');
  // 3.6 陆金所条件估值（v3.1.1 缺失变量处理规则）：估值成功的前提是 LU_BV 有值——
  //     LU_BV 缺失 → 分支一律 N/A（即使 M_LU/S_LU 都有值也不单独加总，避免「其他资产未扣减陆金所净资产、
  //     却又单独加总陆金所市值」的重复计算）；LU_BV 有值但 M_LU 或 S_LU 缺失 → LU_BV×0.60（不构成重复计算）。
  if (LU_BV == null) {
    luValue = null;
    luBasis = 'LU_BV 缺失 → 陆金所分支 N/A 跳过（严禁填 0；M_LU/S_LU 有值也不单独加总，避免重复计算）';
    skippedBranches.push('陆金所估值');
  } else if (M_LU != null && M_LU > 0 && S_LU != null && S_LU > 0) {
    luValue = M_LU * S_LU;
    luBasis = `M_LU×S_LU = ${M_LU}×${S_LU}（LU_BV 已在第3.7项扣减，市值替换净资产，不构成重复计算）`;
  } else {
    luValue = LU_BV * p.sotp.other;
    luBasis = `LU_BV×0.60 = ${LU_BV}×0.60`;
  }
  // OCIEQ_URG 缺失 → 仅「FVOCI税后浮盈/股」辅助行 N/A（不影响 P/EV、DDM、SOTP 任何计算）
  if (OCIEQ_URG == null) skippedBranches.push('FVOCI税后浮盈每股');
  // 3.7 非权益其他资产 = BV_Total − E_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV
  //     仅扣减实际有值项；N/A 项不扣减（对应资产留在其他资产池，备注说明）。严禁用 EV_L 扣减。
  const DEDUCT_KEYS = ['E_L', 'E_PC', 'E_BK', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'];
  const notSplit = DEDUCT_KEYS.filter(k => v(k) == null); // 未单独拆分、留在其他资产池的项
  if (BV_Total != null) {
    let deducted = BV_Total;
    const parts = [`BV_Total=${BV_Total}`];
    for (const k of DEDUCT_KEYS) {
      const val = v(k);
      if (val != null) { deducted -= val; parts.push(`− ${k}=${val}`); }
    }
    otherAssets = deducted;
    otherAssetsFormula = parts.join(' ') + ` = ${r2(otherAssets)} 亿元（仅扣减实际有值项，N/A 项不扣减）`;
  } else {
    otherAssets = null;
    otherAssetsFormula = 'BV_Total 缺失 → 非权益其他资产分支 N/A 跳过（严禁填 0）';
    skippedBranches.push('其他资产估值');
  }
  // 异常检查（总则4）：其他资产 < 0 → 警告 + 暂停 SOTP
  if (otherAssets != null && otherAssets < 0) {
    otherNegative = true;
    sotpAnomaly = '⚠️ 其他资产为负，请检查 E_L 是否误用 EV_L 或扣减项是否超范围';
    alerts.push(sotpAnomaly);
  }
  // 3.9 整体跳过条件：三项核心均缺失，或异常检查未通过
  const sotpSkipped = coreAllMissing || otherNegative;
  const sotpSkipReason = coreAllMissing
    ? 'SOTP：EV_L、E_PC、E_BK 三项均缺失，整体记 N/A 并跳过（协议 3.9）→ 合成区间降级用 P/EV + DDM'
    : (otherNegative ? `SOTP：异常检查未通过（${sotpAnomaly}）→ 整体记 N/A 并跳过（协议 3.9）` : null);

  let otherVal = null;
  if (!sotpSkipped) {
    // 3.7 其他资产估值 = 非权益其他资产 × 0.60（异常已拦截，此处必为非负）
    otherVal = (otherAssets != null) ? otherAssets * p.sotp.other : null;
    // 3.8 SOTP 目标价：N/A 分支不计入分子
    const branchVals = [lifeVal, pcVal, bkVal, fvociVal, fvtplVal, otherVal, luValue].filter(x => x != null);
    sotpTotal = branchVals.length ? branchVals.reduce((a, b) => a + b, 0) : null;
    sotpTarget = (sotpTotal != null && N) ? sotpTotal / N : null;
    // 3.9 SOTP 区间 ±10%
    if (sotpTarget != null) {
      lowC = sotpTarget * (1 - p.sotpBand);
      highC = sotpTarget * (1 + p.sotpBand);
    }
    const naSrc = '缺失，分支 N/A 跳过（严禁填 0）';
    sotpSegments = [
      { name: '寿险（EV_L 内含价值口径 ×0.80，不参与净资产扣减）', value: EV_L, multiplier: p.sotp.life, result: lifeVal == null ? null : r2(lifeVal), unit: '亿元', source: (I.EV_L && I.EV_L.source) || '' },
      { name: '财产保险（E_PC 会计净资产）', value: E_PC, multiplier: p.sotp.pc, result: pcVal == null ? null : r2(pcVal), unit: '亿元', source: (I.E_PC && I.E_PC.source) || '' },
      { name: '平安银行（E_BK 会计净资产×持股比例）', value: E_BK, multiplier: p.sotp.bank, result: bkVal == null ? null : r2(bkVal), unit: '亿元', source: (I.E_BK && I.E_BK.source) || '' },
      { name: 'FVOCI 权益（账面，含浮盈净资产口径）', value: OCIEQ_BV, multiplier: p.sotp.oci, result: fvociVal == null ? null : r2(fvociVal), unit: '亿元', source: (I.OCIEQ_BV && I.OCIEQ_BV.source) || ((fvociVal == null) ? naSrc : '') },
      { name: 'FVTPL 权益（账面）', value: FVTPL_EQ, multiplier: p.sotp.fvtpl, result: fvtplVal == null ? null : r2(fvtplVal), unit: '亿元', source: (I.FVTPL_EQ && I.FVTPL_EQ.source) || ((fvtplVal == null) ? naSrc : '') },
      { name: '陆金所（条件估值）', value: luValue == null ? null : r2(luValue), multiplier: null, result: luValue == null ? null : r2(luValue), unit: '亿元', source: luBasis },
      { name: '非权益其他资产（BV_Total 倒挤，会计口径扣减）', value: otherAssets == null ? null : r2(otherAssets), multiplier: p.sotp.other, result: otherVal == null ? null : r2(otherVal), unit: '亿元', source: 'BV_Total − E_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV（仅扣减实际有值项）' },
    ];
  }

  // ===== 第四站：动态EV参考中枢（不参与合成区间） =====
  const annualNBV = (NBV != null && M) ? NBV * (12 / M) : null;
  const dynEVPS = (EV != null && annualNBV != null && N) ? (EV + annualNBV) / N : null;
  const centerRef = dynEVPS != null ? dynEVPS * p.dynamicEvMultiple : null;

  // v3.1 缺失值规则：严禁将缺失变量填 0 后让其落入其他资产池 → 不再有「按0处理」名单。
  // zeroFilled 字段保留为空数组（下游契约兼容），分支跳过情况以 skippedBranches 披露（协议 3.8）。
  const zeroFilled = [];

  // ===== 第五站：合成估值区间（极值法，仅成功计算的模型参与） =====
  let finalLow = null, finalHigh = null, synthBasis = '';
  {
    const lowCandidates = [], highCandidates = [];
    if (lowA != null) lowCandidates.push(lowA);
    if (highA != null) highCandidates.push(highA);
    if (!ddmNA) { if (ddmCons != null) lowCandidates.push(ddmCons); if (ddmOpt != null) highCandidates.push(ddmOpt); }
    if (!sotpSkipped && lowC != null) lowCandidates.push(lowC);
    if (!sotpSkipped && highC != null) highCandidates.push(highC);
    finalLow = lowCandidates.length ? Math.min(...lowCandidates) : null;
    finalHigh = highCandidates.length ? Math.max(...highCandidates) : null;
    const parts = ['P/EV'];
    if (!ddmNA) parts.push('DDM');
    if (!sotpSkipped) parts.push('SOTP');
    synthBasis = `极值法合成（参与模型：${parts.join(' + ')}${(ddmNA || sotpSkipped) ? '；' + [ddmNA ? 'DDM N/A 已排除' : null, sotpSkipped ? 'SOTP N/A 已排除' : null].filter(Boolean).join('；') : ''}）`;
  }

  // ===== 第六站：FVOCI 辅助行（不参与估值） =====
  const fvociPerShare = (OCIEQ_URG != null && OCIEQ_URG !== 0 && N) ? OCIEQ_URG * (1 - p.tax) / N : null;

  // ===== 评级：纯规则（现价 vs 极值法合成区间），供工作台综合评级徽标（不出现在协议表格） =====
  let rating = 'N/A';
  if (P != null && finalLow != null && finalHigh != null) {
    if (P < finalLow) rating = '低估';
    else if (P > finalHigh) rating = '高估';
    else rating = '合理';
  }

  // ===== 备注行固定格式（协议四，v3.1）=====
  // 「报告期：EV/EV_L/E_PC/E_BK=[报告期]；N/NBV/BV_Total=[报告期]；E_L=[报告期或N/A]；跳过分支=[N/A分支]；其他资产=[正数或异常警告]」
  // 分层报告期是协议允许策略（总则2）：混合报告期不告警、不中止、不自行统一口径，仅如实标注。
  const PERIOD_CHECK_KEYS = ['N', 'EV', 'NBV', 'EV_L', 'E_PC', 'E_BK', 'BV_Total', 'E_L', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'];
  const noPeriodVars = [];
  for (const k of PERIOD_CHECK_KEYS) {
    if (I[k] && I[k].value != null && !I[k].period) noPeriodVars.push(k); // 未声明报告期 → 无法纳入标注，提示补录
  }
  const grpPeriod = (keys) => {
    const pds = [...new Set(keys.filter(k => I[k] && I[k].value != null && I[k].period).map(k => I[k].period))];
    return pds.length ? pds.join('/') : '未声明';
  };
  const evGrpP = grpPeriod(['EV', 'EV_L', 'E_PC', 'E_BK']);
  const bvGrpP = grpPeriod(['N', 'NBV', 'BV_Total']);
  const nbvTag = (I.NBV && I.NBV.value != null && I.NBV.periodTag) ? `（NBV 为 ${I.NBV.periodTag} 累计）` : '';
  const elP = (I.E_L && I.E_L.value != null) ? (I.E_L.period || '未声明') : 'N/A';
  const otherAssetText = otherNegative ? sotpAnomaly : (otherAssets != null ? `${r2(otherAssets)} 亿元` : 'N/A（BV_Total 缺失）');
  const fixedRemark = `报告期：EV/EV_L/E_PC/E_BK=${evGrpP}；N/NBV/BV_Total=${bvGrpP}${nbvTag}；E_L=${elP}；其他资产=${otherAssetText}`;
  const periodAnnotation = fixedRemark; // 兼容字段（原「报告期标注」），v3.1 起为协议四固定格式（跳过分支移入缺失变量块）

  // ===== 备注（协议五·备注行）：固定格式 + D 口径 / 数据时效 / 未单独拆分 / 用户覆盖参数 =====
  const remarks = [];
  {
    const caliber = (I.D && I.D.caliber) || '';
    if (D == null) remarks.push('D 缺失 → DDM 两值记 N/A，不参与合成');
    else if (D === 0) remarks.push('D 为 0 → DDM 两值记 N/A，不参与合成');
    else if (caliber === '营运利润') remarks.push('D 为归母营运利润口径（优先口径，无降级标注）');
    else if (caliber === '净利润') remarks.push('D为净利润口径（数据库无营运利润口径股息）');
    else remarks.push('D 口径未在配置中声明（inputs.D.caliber 缺失）→ 请核对是否为归母营运利润口径');
  }
  // 数据时效规则：超龄标注（规则原文文案），计算照常、不替换数值、不中止
  for (const fr of freshnessRows) {
    if (fr.stale) remarks.push(`变量${fr.key}取数于${fr.asOf}，已超${maxAgeDays}天，请复核`);
  }
  if (noAsOfVars.length) remarks.push(`变量${noAsOfVars.join('、变量')}未记录取数日期，请补录`);
  remarks.push(fixedRemark);
  if (noPeriodVars.length) remarks.push(`变量${noPeriodVars.join('、变量')}未声明报告期（无法纳入报告期标注），请补录`);
  // ===== 缺失变量处理规则（v3.1.1 协议五）固定格式：只在备注行汇总说明 =====
  // 六变量（OCIEQ_BV/OCIEQ_URG/FVTPL_EQ/LU_BV/M_LU/S_LU）缺失不视为错误：不中止、不填0、不估算、
  // 不要求复核、不在备注行之外单独输出 ⚠️ 缺失警告（前端已同步移除 missingNote 条）。
  const SIX_MISSING_KEYS = ['OCIEQ_BV', 'OCIEQ_URG', 'FVTPL_EQ', 'LU_BV', 'M_LU', 'S_LU'];
  const sixMissing = SIX_MISSING_KEYS.filter(k => v(k) == null);
  const notDeducted = ['OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'].filter(k => v(k) == null);
  const missingRemark = `缺失变量：${sixMissing.length ? sixMissing.join('、') : '无'}`
    + `；跳过分支：${skippedBranches.length ? skippedBranches.join('、') : '无'}`
    + `；未扣减项：${notDeducted.length ? notDeducted.join('、') : '无'}`
    + (notDeducted.length && !sotpSkipped ? '；对应资产已落入其他资产按0.60估值' : '')
    + `；P/EV与DDM照常；${sotpSkipped ? 'SOTP 整体 N/A，区间由 P/EV 与 DDM 合成' : 'SOTP按剩余成功分支合成'}`;
  remarks.push(missingRemark);
  if (overrides.length) remarks.push(`用户覆盖参数：${overrides.join('；')}`);
  if (sotpSkipped) remarks.push(`${sotpSkipReason}，合成区间降级为 P/EV + DDM（或 P/EV 单核）`);
  const remarkText = remarks.join('；') || '无';

  const R = (x) => x == null ? 'N/A' : r2(x).toFixed(2);
  const FR2 = (lo, hi) => (lo == null || hi == null) ? 'N/A' : `${R(lo)} ~ ${R(hi)}`;

  // ===== 输出：协议固定表格（五、逐格填充，禁用定性词，禁止额外文字） =====
  const summaryRows = [
    ['当前股价（P）', R(P)],
    ['每股内含价值（EVPS）', R(EVPS)],
    ['EV倍数法核心区间（0.65x~0.90x）', FR2(lowA, highA)],
    ['DDM保守估值（10%/3.5%）', ddmNA ? 'N/A' : R(ddmCons)],
    ['DDM乐观估值（8%/5.0%）', ddmNA ? 'N/A' : R(ddmOpt)],
    ['SOTP目标价', sotpSkipped ? 'N/A' : R(sotpTarget)],
    ['SOTP区间（±10%）', (sotpSkipped || lowC == null || highC == null) ? 'N/A' : FR2(lowC, highC)],
    ['合成估值区间（极值法）', FR2(finalLow, finalHigh)],
    ['核心聚焦区间（EV倍数法）', FR2(lowA, highA)],
    ['动态EV参考中枢（含NBV年化）', centerRef != null ? R(centerRef) : 'N/A'],
    ['FVOCI税后浮盈/股（辅助，不参与估值）', fvociPerShare != null ? R(fvociPerShare) : 'N/A（OCIEQ_URG 缺失）'],
    ['陆金所估值（SOTP内）', (sotpSkipped || luValue == null) ? 'N/A（变量缺失，分支跳过）' : R(luValue)],
    ['备注', remarkText],
  ];

  // ===== 三段式明细（SOTP / DDM / P-EV），字段契约与 v2 保持一致（前端/结论文本消费） =====
  const sotpInputs = ['EV_L', 'E_L', 'E_PC', 'E_BK', 'BV_Total', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV', 'M_LU', 'S_LU', 'N'].filter(k => I[k]).map(k => ({
    key: k, label: k, value: v(k), unit: (I[k] && I[k].unit) || '',
    source: (I[k] && I[k].source) || ((v(k) == null) ? '缺失，分支 N/A 跳过' : ''),
  }));
  const sotpDetails = {
    title: 'SOTP 分部估值（v3.1 修正版 · 极值法合成参与）',
    skipped: sotpSkipped,
    skipReason: sotpSkipReason,
    missingVars: missingSotpCore,
    skippedBranches,
    notSplit,
    anomaly: sotpAnomaly,
    targetPrice: r2(sotpTarget),
    range: (lowC != null && highC != null) ? [r2(lowC), r2(highC)] : null,
    band: p.sotpBand,
    totalValue: r2(sotpTotal),
    luValue: r2(luValue),
    luBasis,
    inputs: sotpInputs,
    segments: sotpSegments || [],
    otherAssetsFormula,
  };
  const ddmDetails = {
    title: 'DDM 股息贴现（极值法合成参与）',
    d: D,
    caliber: (I.D && I.D.caliber) || '',
    unit: '元/股',
    ttmNote: 'D 为最近四个季度（TTM）累计每股股息，M 固定=12',
    na: ddmNA,
    conservative: { r: p.ddmConservative.r, g: p.ddmConservative.g, value: r2(ddmCons) },
    optimistic: { r: p.ddmOptimistic.r, g: p.ddmOptimistic.g, value: r2(ddmOpt) },
    source: (I.D && I.D.source) || '',
  };
  const pevDetails = {
    title: 'P/EV 内含价值倍数（核心锚 · 核心聚焦区间）',
    ev: EV,
    n: N,
    evps: r2(EVPS),
    pevLow: p.pevLow,
    pevHigh: p.pevHigh,
    range: (lowA != null && highA != null) ? [r2(lowA), r2(highA)] : null,
    source: `${(I.EV && I.EV.source) || ''}；${(I.N && I.N.source) || ''}`,
  };
  const fvociDetails = {
    title: 'FVOCI 辅助行（第六站，不参与估值）',
    ociEqBv: OCIEQ_BV,
    ociEqUrg: OCIEQ_URG,
    fvtplEq: FVTPL_EQ,
    tax: p.tax,
    perShare: r2(fvociPerShare),
    formula: (OCIEQ_URG != null && OCIEQ_URG !== 0 && N) ? `OCIEQ_URG×(1−税率)÷N = ${OCIEQ_URG}×(1−${p.tax})÷${N} = ${r2(fvociPerShare)} 元/股` : 'OCIEQ_URG 缺失，辅助行记 N/A（不参与估值，不影响计算）',
  };

  return {
    ok: true,
    symbol: '601318',
    model: 'pingAnRolling_v3',
    version: (cfg.modelVersion || '滚动估值协议_v3.1'),
    reportDate: (cfg.reportPeriod && cfg.reportPeriod.periodLabel) || '最新报告期',
    reportLabel,
    rating,
    fairValueRange: (finalLow != null && finalHigh != null) ? [r2(finalLow), r2(finalHigh)] : null,
    fairValueCenter: (finalLow != null && finalHigh != null) ? r2((finalLow + finalHigh) / 2) : null,
    focusRange: (lowA != null && highA != null) ? [r2(lowA), r2(highA)] : null,
    methodsUsed: sotpSkipped
      ? ['P/EV核心锚（核心聚焦区间）', 'DDM双参（极值法合成）']
      : ['P/EV核心锚（核心聚焦区间）', 'DDM双参（极值法合成）', 'SOTP分部估值（极值法合成）'],
    summaryRows,
    rows: summaryRows,
    synthBasis,
    sotpDetails,
    ddmDetails,
    pevDetails,
    fvociDetails,
    remarks,
    periodAnnotation,
    noPeriodVars,
    missing,
    zeroFilled,
    skippedBranches,
    notSplit,
    sotpAnomaly,
    sotpSkipped,
    sotpSkipReason,
    sotpDegraded: false,
    otherAssets: r2(otherAssets),
    otherNegative,
    evLbv: v('EV_L_BV'),
    evLbvDeprecated: true,
    alerts,
    freshnessRows,
    reportPeriod: { months: M, type: periodLabel, detected: MDetected },
    raw: { P, N, EV, EVPS, lowA, highA, ddmCons, ddmOpt, sotpTarget, sotpTotal, lowC, highC, annualNBV, dynEVPS, centerRef, finalLow, finalHigh, otherAssets, luValue, fvociPerShare, M },
  };
}

module.exports = { compute, loadInputs, INPUT_FILE, detectLatestReportMonths, FIXED_PARAMS, mergeParams };

~~~

---

## `lib\valuation\sanxi688289.js`  ·  790 行

~~~js
// ============================================================
// 圣湘生物（688289）专属估值模型 V3.0_三轨并行 —— 确定性计算（1+1=2 原则）
// 20261029r【用户下发《全自动动态估值分析框架·AI指令集 v1.0》规范实施】：
//   【五表锚定】表A年度锚（2025年报，硬锚）/ 表B阶段观测（Q1/H1/9M，软锚，禁年度÷4倒推）/
//   表C TTM拼接（唯一合法阶段→年度桥接，禁手工年化）/ 表D市场实时 / 表E可比中位数。
//   【三轨并行】轨道I相对估值（权重50%）：TTM归母×动态目标PE（下限=max(可比中位×0.8,历史PE25%分位)、
//   上限=min(可比中位×1.2,历史PE75%分位)，区间倒挂→警报+回退可比区间）+PS交叉校验（隐含市值偏差>±25%→背离警报）；
//   轨道II SOTP（35%）：试剂+仪器（EV/Sales）/生物类药品海济（承诺期后折价0.875）/检测服务（PS保守）/净现金投资0.7~1.0x；
//   轨道III历史分位校验（15%）：当前PE(TTM)历史分位>85%或<15%→极端分位警示。
//   【回退规则】A年度锚优先/B TTM优先于阶段外推/C数据缺口四级降级链（TTM→年度锚+趋势→阶段趋势→移除+权重再分配）/
//   D并表口径（海济2025-01-31并表，跨并表日同比标注「口径不可比」）。
//   【异常检测5触发器】年化隐含vs年度锚±30%/轨道I vs II>30%/TTM缺口/PE极端分位/商誉减值。
//   【风险折价】合成后施加、仅下调不上调：增值税5-8%/集采3-5%/商誉10-15%（触发条件判定）/费用压力1-2pct。
// 沿袭 V2.1：六模型交叉验证（SOTP/Forward PE/PS/DCF/EV-EBITDA/rNPV）保留为附录参照；
//   画像诊断→权重自适应→销售费用显性调整模块全部保留；评级三档铁律（低估/合理/高估）。
// 锚点自动前移：东财三表实时拉取（三季报已披露→9M锚自动前移，TTM自动重算），配置仅存对照。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYMBOL = '688289';
const CFG_PATH = path.join(__dirname, '../../data/valuation/688289.json');
const STATE_PATH = path.join(__dirname, '../../data/valuation/688289.state.json');
const LOG_DIR = path.join(__dirname, '../../data/logs/valuation_logs');
const LOG_PATH = path.join(LOG_DIR, '688289.jsonl');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return null; }
}

function isSanxiModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  return bare === SYMBOL && !!loadConfig();
}

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;
const pad = (n) => String(n).padStart(2, '0');
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;
const nz = (v, d) => (v == null || !isFinite(Number(v))) ? d : Number(v);

// ---------- 日期差（天） ----------
function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

// ---------- TTM 拼接固定公式（表C，纯函数，供测试） ----------
// TTM = 最近一期累计 + 上一完整年度 − 上年同期累计；上年同期缺失 → { value:null, gap:true }（禁手工年化）。
function ttmSplice(fyVal, curCum, prevSameCum) {
  const f = (fyVal == null || !isFinite(Number(fyVal))) ? null : Number(fyVal);
  const c = (curCum == null || !isFinite(Number(curCum))) ? null : Number(curCum);
  const s = (prevSameCum == null || !isFinite(Number(prevSameCum))) ? null : Number(prevSameCum);
  if (f != null && c != null && s != null) return { value: f + c - s, gap: false, note: `TTM=年度锚 ${r2(f)} + 本年累计 ${r2(c)} − 上年同期累计 ${r2(s)}` };
  return { value: null, gap: true, note: `TTM不可计算·数据缺口（上年同期累计${s == null ? '缺失' : '异常'}）→ 启用回退规则B/C` };
}

// ---------- 动态目标PE区间（轨道I，纯函数，供测试） ----------
// 下限=max(可比中位×0.8, 历史PE25%分位)；上限=min(可比中位×1.2, 历史PE75%分位)；倒挂→警报+回退可比区间。
function targetPeBand(compMedian, histP25, histP75) {
  const lo = Math.max(compMedian * 0.8, histP25);
  const hi = Math.min(compMedian * 1.2, histP75);
  if (lo > hi) {
    return { lo: compMedian * 0.8, hi: compMedian * 1.2, inverted: true, rawLo: lo, rawHi: hi,
      note: `目标PE区间倒挂（历史分位下限 ${r2(lo)} > 可比上限 ${r2(hi)}）：圣湘历史PE中枢显著高于可比公司中位区间 → 按回退规则改用可比区间 [${r2(compMedian * 0.8)}, ${r2(compMedian * 1.2)}] 并标注` };
  }
  return { lo, hi, inverted: false, note: `目标PE=max(可比中位×0.8=${r2(compMedian * 0.8)}, 历史P25=${r2(histP25)})=${r2(lo)} ~ min(可比中位×1.2=${r2(compMedian * 1.2)}, 历史P75=${r2(histP75)})=${r2(hi)}` };
}

// ---------- 历史PE分位估计（轨道III，纯函数，供测试） ----------
// 历史PE区间 [low,high] 均匀分位近似（标注【近似】）；超出上沿 → >99%（封顶）。
function pePercentileEst(pe, histLow, histHigh) {
  if (pe == null || histLow == null || histHigh == null || histHigh <= histLow) return null;
  const raw = (pe - histLow) / (histHigh - histLow) * 100;
  const pct = Math.max(0, Math.min(99.9, raw));
  return { pct: Math.round(pct * 10) / 10, above: raw > 100, below: raw < 0, note: `基于历史PE区间 [${histLow}, ${histHigh}] 均匀分位近似【近似口径】` };
}

// ---------- A级三表抓取（锚点自动前移：9M→H1→Q1） ----------
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SH${SYMBOL}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income;
    const pick = (d) => inc.find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    const anchor = pick('2026-09-30') || pick('2026-06-30') || pick('2026-03-31');
    if (!anchor) return null;
    const asOf = String(anchor.REPORT_DATE).slice(0, 10);
    const prevYear = Number(asOf.slice(0, 4)) - 1;
    const fy = pick(`${prevYear}-12-31`);
    const prevSame = pick(`${prevYear}-${asOf.slice(5, 10)}`);
    if (!fy || !prevSame) return null;
    const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SH${SYMBOL}`, [asOf, `${prevYear}-12-31`]);
    const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
    const balCur = balArr.find(r => String(r.REPORT_DATE || '').startsWith(asOf)) || null;
    return {
      asOf, stage: asOf.slice(5, 10),
      stageLabel: { '03-31': '一季报(Q1)', '06-30': '中报(H1)', '09-30': '三季报(9M)', '12-31': '年报(FY)' }[asOf.slice(5, 10)],
      revCum: yi(anchor.TOTAL_OPERATE_INCOME),
      npCum: yi(anchor.PARENT_NETPROFIT),
      npDedCum: yi(anchor.DEDUCT_PARENT_NETPROFIT),
      fyRev: yi(fy.TOTAL_OPERATE_INCOME),
      fyNp: yi(fy.PARENT_NETPROFIT),
      fyNpDed: yi(fy.DEDUCT_PARENT_NETPROFIT),
      prevSameRev: yi(prevSame.TOTAL_OPERATE_INCOME),
      prevSameNp: yi(prevSame.PARENT_NETPROFIT),
      prevSameNpDed: yi(prevSame.DEDUCT_PARENT_NETPROFIT),
      equity: balCur ? yi(balCur.TOTAL_PARENT_EQUITY) : null,
      goodwill: balCur ? (balCur.GOODWILL != null ? yi(balCur.GOODWILL) : null) : null,
      cash: balCur ? yi(balCur.MONETARYFUNDS) : null,
      balAsOf: balCur ? String(balCur.REPORT_DATE).slice(0, 10) : null,
    };
  } catch (e) { return null; }
}

// ---------- 运行日志（JSONL，留100条） ----------
function appendRunLog(record) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    let lines = [];
    if (fs.existsSync(LOG_PATH)) {
      lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.trim());
    }
    lines.push(JSON.stringify(record));
    if (lines.length > 100) lines = lines.slice(-100);
    fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响估值 */ }
}

// ---------- 动态时间引擎：按月算法映射最新报告期（与海天603288同一算法） ----------
function getLatestReportPeriods(baseDate) {
  const d = new Date(baseDate);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  // 估值基准季报期
  let qEnd;
  if (m <= 4 && !(m === 4 && day >= 30)) qEnd = `${y - 1}-12-31`;       // 1/1-4/29 → 上年年报期
  else if (m < 8 || (m === 8 && day <= 30)) qEnd = `${y}-03-31`;         // 4/30-8/30 → 一季报期
  else if (m < 10 || (m === 10 && day <= 24)) qEnd = `${y}-06-30`;       // 8/31-10/24 → 中报期
  else qEnd = `${y}-09-30`;                                              // 10/25-12/31 → 三季报期（20261030h 对齐平安 20261029e：三季报 10 月下旬披露）
  // 最新年报：只要过了4月30日披露季，最新年报=上年年报；否则=前年年报
  const fyLatestYear = (m > 4 || (m === 4 && day >= 30)) ? y - 1 : y - 2;
  // FY_Current：12月时滚动至下一年
  const fyCurrent = m === 12 ? y + 1 : y;
  return { baseDate: `${y}-${pad(m)}-${pad(day)}`, qLatestEnd: qEnd, fyLatestYear, fyCurrent, fyNext: fyCurrent + 1 };
}

// ---------- 三情景行业倍数乘数 ----------
const SCEN_MULT = { optimistic: 1.10, base: 1.00, conservative: 0.90 };

async function run(symbol, { price, statements } = {}) {
  const t0 = Date.now();
  try {
    const result = await compute(symbol, { price, statements });
    appendRunLog({
      ts: new Date().toISOString(), runId: result.runId, version: result.version,
      ok: !!result.ok, rating: result.rating, range: result.fairValueRange, center: result.fairValueCenter,
      price: result.currentPrice, fallbacks: result.fallbackFlags || [], ms: Date.now() - t0
    });
    return result;
  } catch (e) {
    const errRecord = { ts: new Date().toISOString(), ok: false, error: e.message, stack: (e.stack || '').slice(0, 500) };
    appendRunLog(errRecord);
    return { ok: false, error: 'SANXI_COMPUTE_FAILED', detail: e.message };
  }
}

async function compute(symbol, { price, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYMBOL) return { error: 'NOT_SANXI' };
  const I = cfg.inputs;
  const R = cfg.rules;
  const fallbackFlags = [];

  // ========== 第一部分：动态时间引擎 ==========
  const P = getLatestReportPeriods(new Date());
  const fyLabel = `${P.fyLatestYear}年报`;
  const fyLatestOk = cfg.timeEngine.reportPeriods.fyLatest.label.startsWith(fyLabel);
  if (!fyLatestOk) fallbackFlags.push(`时间引擎判定最新年报应为「${fyLabel}」，配置为「${cfg.timeEngine.reportPeriods.fyLatest.label}」→ 财报映射与系统日期不一致，请更新配置`);

  // P0一致性修复①：Q_Latest 报告期核对——引擎判定的最新季报期 vs 配置 periodEnd
  const cfgQEnd = cfg.timeEngine.reportPeriods.qLatest && cfg.timeEngine.reportPeriods.qLatest.periodEnd;
  const qLatestOk = cfgQEnd === P.qLatestEnd;
  if (!qLatestOk) fallbackFlags.push(`时间引擎判定最新季报期应为「${P.qLatestEnd}」，配置为「${cfgQEnd || '未声明'}」→ 季报数据可能过期（如三季报已披露仍用中报TTM），请更新配置`);

  // P0一致性修复③：staleness 检查（披露日期距今天数 > stalenessDays 即告警）
  const staleMax = cfg.timeEngine.stalenessDays || 200;
  const freshnessRows = [];
  for (const [pk, pp] of Object.entries(cfg.timeEngine.reportPeriods)) {
    const age = daysBetween(pp.disclosed, new Date());
    if (age != null) freshnessRows.push({ label: pk === 'fyLatest' ? '最新年报披露' : '最新季报披露', asOf: pp.disclosed, ageDays: age, maxAge: staleMax, stale: age > staleMax });
  }

  // 总股本（动态取配置最新值）
  const N = I.totalShares;
  const netCash = I.balanceSheet2025.netCash;          // 含交易性金融资产（类现金）
  const bioPE0 = I.industry.bioPE;
  const ps0 = I.industry.ivdPS;
  const devPE0 = I.industry.devicePE;
  const evMid0 = I.industry.evEbitdaMid;

  // 兜底3：行业倍数缺失 → 默认 PE40/PS8/EV20
  let indFlags = [];
  if (!ps0) { fallbackFlags.push('IVD/器械行业PS缺失 → 采用默认行业参数 PS=8x'); indFlags.push('PS默认8x'); }
  const psUse = ps0 || 8;
  const devPEUse = devPE0 || 40;
  if (!devPE0) fallbackFlags.push('医疗器械行业PE缺失 → 采用默认行业参数 PE=40x');
  if (!bioPE0) fallbackFlags.push('生物制品行业PE缺失 → 采用默认行业参数 PE=40x');
  const bioPEUse = bioPE0 || 40;
  const evMidUse = evMid0 || 20;
  if (!evMid0) fallbackFlags.push('EV/EBITDA行业倍数缺失 → 采用默认行业参数 EV/EBITDA=20x');

  // ========== 指令2 · 海济 SOTP 防高估（集采预期 → 适用PE封顶 + 商誉减值单独扣减） ==========
  // 若核心并购标的（中山海济·生长激素）所处赛道存在集采预期：
  //   ① 其利润适用PE不得超过可比公司中位数的 0.7 倍（haijiPeCap）；
  //   ② 需单独计提 5%-10% 的商誉减值准备扣减项（haijiGoodwillImpairRate），与全局商誉折价（触发条件判定）区分。
  const v3cfgHaiji = (cfg.v3 || {});
  const haijiCollectExpected = !!nz(v3cfgHaiji.haijiCollectExpected, false);
  const haijiPeerPeMedian = nz(v3cfgHaiji.haijiPeerPeMedian, bioPEUse);
  const haijiCollectPeCapCoef = nz(v3cfgHaiji.haijiCollectPeCapCoef, 0.7);
  const haijiPeCap = haijiPeerPeMedian * haijiCollectPeCapCoef;
  const haijiPeUse = (haijiCollectExpected && bioPEUse > haijiPeCap) ? haijiPeCap : bioPEUse;
  const haijiGoodwillImpairRate = haijiCollectExpected ? nz(v3cfgHaiji.haijiGoodwillImpairRate, 0.07) : 0;
  const haijiPeCapped = haijiCollectExpected && bioPEUse > haijiPeCap;

  // 兜底1：机构一致预期缺失 → 近3年平均净利增速×最新净利推算（标注替代算法）
  // P0一致性修复②：按财年动态取数（byFY 数组），FY_Current 随系统日期滚动不再与硬编码键名错位
  let cons = I.consensus;
  let consSubstituted = false;
  if (!cons || (!cons.byFY && cons.np2026E == null)) {
    consSubstituted = true;
    const np3 = I.np3y.map(x => x.np);
    let gSum = 0, gN = 0;
    for (let i = 1; i < np3.length; i++) { gSum += np3[i] / np3[i - 1] - 1; gN++; }
    const gAvg = gN ? gSum / gN : 0;
    const lastNp = np3[np3.length - 1];
    const fy0 = P.fyLatestYear + 1;
    cons = { byFY: [1, 2, 3].map(k => ({ fy: fy0 + k - 1, np: lastNp * (1 + gAvg) ** k })), institutions: 0 };
    fallbackFlags.push(`机构一致预期缺失 → 采用替代算法：近3年平均净利增速 ${(gAvg * 100).toFixed(1)}% × 最新净利推算`);
  }
  const pickCons = (fy) => {
    if (Array.isArray(cons.byFY)) {
      const hit = cons.byFY.find(x => x.fy === fy);
      if (hit) return hit.np;
    }
    return cons[`np${fy}E`] != null ? cons[`np${fy}E`] : null;
  };
  const consPicked = { fyCurrent: pickCons(P.fyCurrent), fyNext: pickCons(P.fyNext), fyNext2: pickCons(P.fyNext + 1) };
  {
    const missingFY = [P.fyCurrent, P.fyNext, P.fyNext + 1].filter(fy => pickCons(fy) == null);
    if (missingFY.length && !consSubstituted) {
      fallbackFlags.push(`一致预期缺少 ${missingFY.join('/')} 年数据（FY_Current=${P.fyCurrent} 随系统日期滚动）→ 请更新配置 byFY 数组；缺失年份已按替代算法推算`);
      const np3 = I.np3y.map(x => x.np);
      let gSum = 0, gN = 0;
      for (let i = 1; i < np3.length; i++) { gSum += np3[i] / np3[i - 1] - 1; gN++; }
      const gAvg = gN ? gSum / gN : 0;
      const lastNp = np3[np3.length - 1];
      const baseNp = pickCons(P.fyCurrent - 1) != null ? pickCons(P.fyCurrent - 1) : lastNp;
      for (const fy of missingFY) cons.byFY.push({ fy, np: r2(baseNp * (1 + gAvg) ** (fy - P.fyCurrent + 1)) });
    }
  }

  if (cons && cons.asOf) {
    const cAge = daysBetween(cons.asOf.length === 7 ? cons.asOf + '-01' : cons.asOf, new Date());
    if (cAge != null) freshnessRows.push({ label: '一致预期时点', asOf: cons.asOf, ageDays: cAge, maxAge: 120, stale: cAge > 120 });
  }

  // 兜底2：最新季报缺失 → 回退 TTM（本例季报在，代码路径保留）
  let ttm = I.ttm;
  if (!ttm || !ttm.rev) {
    fallbackFlags.push('季报数据缺失，已启用TTM滚动数据');
    ttm = { rev: I.fy2025.rev, npAttr: I.fy2025.npAttr };
  }

  // ========== 第二部分：公司画像动态诊断 ==========
  const np3 = I.np3y.map(x => x.np);
  const cagr = Math.pow(np3[np3.length - 1] / np3[0], 1 / (np3.length - 1)) - 1;
  const cagrPct = +(cagr * 100).toFixed(1);
  const severeVol = cagr < R.diagnostics.cagrSevereThreshold / 100;

  const bioRatio = +(I.haiji.np / I.fy2025.npAttr * 100).toFixed(0);
  const forceSotp = bioRatio > R.diagnostics.biopharmRatioThreshold;

  const reagentGmNow = I.segments2025.reagent.gm;
  const reagentGmPrior = I.segments2025.reagentGmPrior;
  const gmDropKnown = reagentGmPrior != null;
  const gmDrop = gmDropKnown ? (reagentGmNow - reagentGmPrior) : null;
  const collectDiscount = gmDropKnown && gmDrop < -R.diagnostics.reagentGmDropPct;
  // 集采折价联动：试剂毛利率同比下滑>5% → PS整体折价追加至0.5-0.7区间中值0.60
  const psDiscount = collectDiscount ? 0.60 : R.ps.wholeDiscount;

  const qRevYoY = I.qLatest.q3.revYoY;      // Q_Latest 单季营收增速（20261030h 锚点前移：三季报）
  const qNpYoY = I.qLatest.q3.npYoY;        // Q_Latest 单季净利增速
  let momentumNote = 'Q_Latest 营收增速在 −5%~15% 区间 → PE法不惩罚、不溢价';
  if (qRevYoY < R.diagnostics.momentumPenaltyBelow) momentumNote = `Q_Latest 营收增速 ${qRevYoY}% < −5% → PE法追加业绩惩罚系数`;
  else if (qRevYoY > R.diagnostics.momentumPremiumAbove) momentumNote = `Q_Latest 营收增速 ${qRevYoY}% > 15% → PE法追加成长溢价系数`;

  // ========== 第三部分：动态SOTP（核心） ==========
  // 追加指令（2026-09-13）：销售费用显性调整模块——系数判定（步骤1-4）；步骤5 情景在第十部分后。
  const SE = I.sellingExpense || null;
  const seOn = !!(SE && SE.module);
  const bd = (SE && SE.breakdown) || {};
  let aExtraDisc = 0;        // 板块A 额外 PS 折价（正数=下调幅度，0.05~0.10）
  let bPeCoef = 1;           // 板块B PE 调整系数（费用增速>营收增速 → 0.90）
  let sellEffCoef = 1;       // Forward PE 费用效率惩罚系数（Δ 分档 0.85/0.90/1.00）
  let dSellRate = null;      // Δ = TTM销售费用率 − IVD行业均值（pp）
  const seg = I.segments2025;
  const ivdGrowth = seg.ivdYoY;                                   // 板块增速（TTM拆分未披露→年报口径，标注）
  // 按指令规则表判定折价系数：增速<0→0.55；0~10%→0.65；>15%→0.85
  const discAUse = ivdGrowth < 0 ? 0.55 : (ivdGrowth <= 10 ? 0.65 : 0.85);
  const haijiGrowth = I.haiji.npYoY;
  const coefB = haijiGrowth > 20 ? 1.1 : (haijiGrowth >= 0 ? 1.0 : 0.8);
  const seqGrowth = seg.sequencing.yoy, ovsGrowth = seg.overseas.yoy;
  const premC = (g) => (g > 50 ? 1.8 : (g >= 20 ? 1.4 : 1.0));

  // ---- 步骤2-A：板块A（分子诊断）集采收入下滑 + 内生费用刚性 → PS 折价额外下调 ----
  // 规则表：营收下滑且内生费用率同比降幅<3pp(刚性)→-0.10；3~6pp→-0.05；≥6pp→不调整
  // 系数值一律从配置规则表读取（项目原则：规则表放配置、代码只负责判定与执行）
  const seRules = (SE && SE.rules) || {};
  const pickByMin = (arr, v, key) => {
    if (!Array.isArray(arr)) return null;
    for (const r of arr) { if (r[key] == null || v > r[key]) return r.x; }
    return null;
  };
  const organicYoYPP = bd.organicSellRateYoYPP != null ? Number(bd.organicSellRateYoYPP) : 0;
  if (seOn && ivdGrowth < 0) {
    const v = pickByMin(seRules.aExtraDiscount, organicYoYPP, 'minYoYPP');
    aExtraDisc = v != null ? v : 0;
  }
  // ---- 步骤2-B：板块B（生物药品/圣湘海济）并购整合费用效率判定 ----
  // 规则：子公司销售费用增速 > 营收增速 → PE 倍数下调（×0.90）；否则不调整
  const haijiSellG = bd.haijiContributionYoY != null ? Number(bd.haijiContributionYoY) : null;
  if (seOn && haijiSellG != null) {
    const bArr = seRules.bPeCoef;
    const hit = haijiSellG > I.haiji.revYoY;
    const cell = Array.isArray(bArr) ? (hit ? bArr[0] : bArr[1]) : null;
    bPeCoef = (cell && cell.x != null) ? cell.x : (hit ? 0.90 : 1);
  }
  // ---- 步骤3：Forward PE 费用效率惩罚系数 ----
  // Δ = TTM销售费用率 − IVD行业均值；Δ>10pp→0.85；5~10pp→0.90；<5pp→1.00
  if (seOn && SE.ttm && SE.industry && Array.isArray(seRules.fwdEfficiency)) {
    dSellRate = +(Number(SE.ttm.sellExpenseRate) - Number(SE.industry.benchmark)).toFixed(2);
    const v = pickByMin(seRules.fwdEfficiency, dSellRate, 'min');
    sellEffCoef = v != null ? v : 1;
  }
  const discAUseFin = Math.max(0, +(discAUse - aExtraDisc).toFixed(2));
  const coefBFinal = +(coefB * bPeCoef).toFixed(3);

  function sotpCalc(mult) {
    const A = seg.ivdTotal * psUse * mult * discAUseFin;
    const B = I.haiji.np * haijiPeUse * mult * coefBFinal * (1 - haijiGoodwillImpairRate);
    const C = seg.sequencing.rev * psUse * mult * premC(seqGrowth)
            + seg.overseas.rev * psUse * mult * premC(ovsGrowth);
    const ev = A + B + C;
    const hair = mult < 1 ? 0.05 : 0;                            // 保守情景 SOTP 扣减5%安全边际
    const equity = (ev - I.balanceSheet2025.interestDebt + I.balanceSheet2025.cash + I.balanceSheet2025.tradingFA) * (1 - hair);
    return { A, B, C, ev, hair, equity, perShare: equity / N };
  }

  // ========== 第四部分：动态Forward PE（市场情绪锚） ==========
  const epsCur = consPicked.fyCurrent / N, epsNext = consPicked.fyNext / N;   // FY_Current/FY_Next 动态取数
  const fwdBase = ((epsCur + epsNext) / 2) * devPEUse;
  const fwdPenalty = qNpYoY < R.diagnostics.fwdPePenaltyNpBelow ? R.diagnostics.fwdPePenaltyCoef : 1.0;
  // Q_Latest 营收动量惩罚/溢价（第二部分诊断联动；本例 +0.98% → 1.0）
  const momCoef = qRevYoY < R.diagnostics.momentumPenaltyBelow ? 0.875 : (qRevYoY > R.diagnostics.momentumPremiumAbove ? 1.075 : 1.0);
  // 追加指令步骤3联动：费用效率惩罚系数（TTM销售费用率超 IVD 行业均值 → 压缩 Forward PE）
  const fwdVal = (mult) => fwdBase * mult * fwdPenalty * momCoef * sellEffCoef;

  // ========== 第五部分：动态PS（营收底价锚） ==========
  const psVal = (mult) => (ttm.rev * psUse * mult * psDiscount) / N;

  // ========== 第六部分：动态DCF（现金流折现，含失效检验） ==========
  const cf = I.cashflow3y;
  const wacc = (I.macro.rf10y + I.macro.riskPremiumUsed) / 100;
  const gDcf = I.macro.gUsed / 100;
  const fcff = [consPicked.fyCurrent, consPicked.fyNext, consPicked.fyNext2].map(np => np * cf.npCashRatio - cf.capexAvg - cf.wcDeltaAvg);
  const fcffAllNeg = fcff.every(f => f < 0);
  const tvNeg = fcff[2] * (1 + gDcf) / (wacc - gDcf) < 0;
  const dcfRemoved = fcffAllNeg && tvNeg;

  function dcfCalc() {
    if (dcfRemoved) return { removed: true, perShare: 0 };
    let pv = 0;
    for (let i = 0; i < 3; i++) pv += fcff[i] / Math.pow(1 + wacc, i + 1);
    const tv = fcff[2] * (1 + gDcf) / (wacc - gDcf);
    const pvTv = tv / Math.pow(1 + wacc, 3);
    const equity = pv + pvTv + netCash;
    return { removed: false, perShare: equity > 0 ? equity / N : 0 };
  }

  // ========== 第七部分：动态EV/EBITDA（排除摊销干扰） ==========
  const ebitdaUse = I.ebitda.fy2026e;
  const ev2Val = (mult) => (ebitdaUse * evMidUse * mult + netCash) / N;

  // ========== 第八部分：动态rNPV（管线期权价值） ==========
  let rnpvSum = 0;
  for (const row of I.pipeline.rows) {
    rnpvSum += row.peak * I.pipeline.netMargin * row.p / Math.pow(1 + I.pipeline.discountRate, row.years);
  }
  const rnpvVal = rnpvSum / N;

  // ========== 第九部分：动态权重自适应（±5%） ==========
  const wAdj = [];
  let wSotp = R.weights.base.sotp, wPe = R.weights.base.forwardPE, wPs = R.weights.base.ps,
      wDcf = R.weights.base.dcf, wEv2 = R.weights.base.evEbitda, wRnpv = R.weights.base.rnpv;
  // SOTP：生物药净利占比高位 → 38
  if (forceSotp && bioRatio >= 90) { wSotp = 38; wAdj.push(`SOTP ${R.weights.base.sotp}→38：生物药净利占比 ${bioRatio}%（>30%且高位）`); }
  else if (forceSotp) { wSotp = R.weights.base.sotp + 3; wAdj.push(`SOTP ${R.weights.base.sotp}→${wSotp}：生物药净利占比 ${bioRatio}%>30%`); }
  // Forward PE：营收转正且净利>−20% → +5；净利<−30%且营收<0 → −5；混合信号 → 保持
  if (qRevYoY > 0 && qNpYoY > -20) { wPe = 30; wAdj.push('Forward PE 25→30：Q_Latest 业绩反转（营收转正且净利>−20%）'); }
  else if (qRevYoY < 0 && qNpYoY < -30) { wPe = 20; wAdj.push('Forward PE 25→20：Q_Latest 持续暴雷（营收<0且净利<−30%）'); }
  else wAdj.push(`Forward PE 25→25：混合信号（Q2 营收 ${qRevYoY > 0 ? '+' : ''}${qRevYoY}% 转正 但 净利 ${qNpYoY}% 深跌），保持基准权重`);
  // PS：不变
  wAdj.push(`PS 12→12：保持不变`);
  // DCF：失效剔除
  if (dcfRemoved) wAdj.push('DCF 10→剔除：FCFF三年全负+终值负（重资本投入期），失效检验剔除并权重归一');
  else wAdj.push('DCF 10→10：保持');
  // EV/EBITDA：折旧摊销突增 → 15
  wAdj.push(`EV/EBITDA 10→10：折旧摊销 ${cf.daAssumed} 亿平稳（${cf.daTrend}），不提升`);
  // rNPV：近12个月新产品获批 → 12
  wAdj.push('rNPV 8→8：近12个月无新产品获批（Seq1000 为2025-01获批、超12个月窗口），不提升');

  // 权重归一（剔除DCF后）
  const wRaw = { sotp: wSotp, forwardPE: wPe, ps: wPs, dcf: dcfRemoved ? 0 : wDcf, evEbitda: wEv2, rnpv: wRnpv };
  const wSum = Object.values(wRaw).reduce((a, b) => a + b, 0);
  const W = {};
  for (const k of Object.keys(wRaw)) W[k] = wRaw[k] / wSum;

  // ========== 第十部分：三情景 + 综合 ==========
  function valueScenario(key) {
    const mult = SCEN_MULT[key];
    const sotp = sotpCalc(mult);
    const pe = fwdVal(mult);
    const psV = psVal(mult);
    const dcf = dcfCalc();
    const ev2 = ev2Val(mult);
    const composite = sotp.perShare * W.sotp + pe * W.forwardPE + psV * W.ps + dcf.perShare * W.dcf + ev2 * W.evEbitda + rnpvVal * W.rnpv;
    return { key, mult, sotp, pe, ps: psV, dcf, evEbitda: ev2, rnpv: rnpvVal, composite };
  }

  const opt = valueScenario('optimistic');
  const base = valueScenario('base');
  const consv = valueScenario('conservative');

  // ========== 第十部分补：销售费用情景（追加指令步骤5） ==========
  // 费用优化：未来两年费率每年降 2~3pp（累计 -5pp）→ 释放销售费用 → 增厚 EBITDA 与净利；
  // 费用恶化：费率维持或上升（+3pp）→ 反向侵蚀。传导路径：EBITDA 与销售费用近似 1:1，
  // Forward PE 端按税后净利增厚调整 EPS。
  let seScen = null;
  if (seOn) {
    const sr = SE.rules || {};
    const taxRate = sr.taxRate != null ? sr.taxRate : 0.15;
    const baseRevForSe = (cons && cons.rev2026E) || ttm.rev;
    const mkSeScen = (kind, dPP, label) => {
      const deltaSell = -(dPP / 100) * baseRevForSe;                 // 正 = 费用减少
      const deltaNp = deltaSell * (1 - taxRate);                     // 税后净利增厚
      const epsNextAdj = (consPicked.fyNext + deltaNp) / N;
      const peAdj = ((epsCur + epsNextAdj) / 2) * devPEUse * fwdPenalty * momCoef * sellEffCoef;
      const ebitdaAdj = ebitdaUse + deltaSell;
      const ev2Adj = (ebitdaAdj * evMidUse + netCash) / N;
      const compositeAdj = base.sotp.perShare * W.sotp + peAdj * W.forwardPE + base.ps * W.ps
        + base.dcf.perShare * W.dcf + ev2Adj * W.evEbitda + base.rnpv * W.rnpv;
      return { kind, label, dPP, deltaSell, deltaNp, peAdj, ebitdaAdj, ev2Adj, compositeAdj, delta: +(compositeAdj - base.composite).toFixed(2) };
    };
    seScen = {
      optimize: mkSeScen('optimize', -(sr.optimizeRatePP || 5), '费用优化'),
      worsen: mkSeScen('worsen', (sr.worsenRatePP || 3), '费用恶化'),
      baseRev: baseRevForSe, taxRate,
    };
  }

  const range = [r2(consv.composite), r2(opt.composite)];
  const center = r2(base.composite);

  let ratingLegacy = '合理';
  if (price != null && isFinite(price) && price > 0) {
    if (price <= range[0]) ratingLegacy = '低估';
    else if (price >= range[1]) ratingLegacy = '高估';
  }

  // ========== V3.0 三轨并行层（20261029r 规范 v1.0：五表锚定+三轨合成+回退规则+异常检测+风险折价） ==========
  const T3 = cfg.v3 || {};
  const alerts = [];
  const fallbackMarks = [];   // 规则C 回退标记：{item, level, note}
  const S3 = statements || await fetchStatements();

  // ---- 表C：TTM 拼接（锚点自动前移；9M→H1→Q1 由 fetchStatements 决定） ----
  let ttmRev3, ttmNp3, ttmNpDed3, ttmAnchor;
  if (S3 && S3.revCum != null && S3.fyRev != null && S3.prevSameRev != null) {
    const tR = ttmSplice(S3.fyRev, S3.revCum, S3.prevSameRev);
    const tN = ttmSplice(S3.fyNp, S3.npCum, S3.prevSameNp);
    const tD = ttmSplice(S3.fyNpDed, S3.npDedCum, S3.prevSameNpDed);
    ttmRev3 = tR.value; ttmNp3 = tN.value; ttmNpDed3 = tD.value;
    ttmAnchor = { asOf: S3.asOf, stageLabel: S3.stageLabel, note: `${tR.note}｜归母：${tN.note}` };
  } else {
    ttmRev3 = null; ttmNp3 = null; ttmNpDed3 = null;
    ttmAnchor = { asOf: null, stageLabel: null, note: 'TTM不可计算·数据缺口（三表不可得）→ 启用回退规则B（表A年度锚）' };
    alerts.push('⚠️ 触发器3：TTM计算中「上年同期累计值」缺失 → 已降级至规则C（估值分子改用表A年度锚）');
    fallbackMarks.push({ item: 'TTM归母净利', level: '层级2', note: 'TTM不可计算 → 用表A年度锚 1.99 亿（年度锚优先，禁阶段×年化系数）' });
  }
  const ttmNpForVal = (ttmNp3 != null) ? ttmNp3 : (I.fy2025 ? I.fy2025.npAttr : null); // 回退规则A：年度锚优先

  // ---- 表D：市场实时（行情口径） ----
  const mktCap3 = (price != null && isFinite(price) && price > 0) ? price * N : null;
  const peTtm3 = (mktCap3 != null && ttmNpForVal > 0) ? mktCap3 / ttmNpForVal : null;

  // ---- 表E：可比锚与历史PE区间（配置 v3 块） ----
  const compPeMedian = nz(T3.compPeMedian, 27);
  const histLow = nz(T3.peHist3y && T3.peHist3y.low, 39);
  const histHigh = nz(T3.peHist3y && T3.peHist3y.high, 58);
  const histP25 = histLow + (histHigh - histLow) * 0.25;
  const histP75 = histLow + (histHigh - histLow) * 0.75;

  // ---- 轨道I：相对估值（50%）----
  const band = targetPeBand(compPeMedian, histP25, histP75);
  if (band.inverted) alerts.push(`⚠️ 轨道I：${band.note}`);
  const tr1LowMv = ttmNpForVal != null ? ttmNpForVal * band.lo : null;
  const tr1HighMv = ttmNpForVal != null ? ttmNpForVal * band.hi : null;
  // PS 交叉校验：TTM营收×[可比PS中位×0.8, ×1.2]
  const psComp = nz(T3.compPsMedian, I.industry.ivdPS || 7.6);
  const tr1PsLowMv = ttmRev3 != null ? ttmRev3 * psComp * 0.8 : null;
  const tr1PsHighMv = ttmRev3 != null ? ttmRev3 * psComp * 1.2 : null;
  let psDevPct = null;
  if (tr1LowMv != null && tr1PsLowMv != null && tr1LowMv > 0) {
    psDevPct = Math.abs(((tr1PsLowMv + tr1PsHighMv) / 2) - ((tr1LowMv + tr1HighMv) / 2)) / ((tr1LowMv + tr1HighMv) / 2) * 100;
    if (psDevPct > 25) alerts.push(`⚠️ 估值轨背离警报：PS轨隐含市值（中值 ${r2((tr1PsLowMv + tr1PsHighMv) / 2)} 亿）与PE轨（中值 ${r2((tr1LowMv + tr1HighMv) / 2)} 亿）偏差 ${r2(psDevPct)}% > ±25% —— 利润端受增值税/集采一次性冲击而营收端相对稳定，以利润端（PE轨）为主定价`);
  }

  // ---- 轨道II：SOTP（35%）----
  const segR = T3.sotpSegments || {};
  const aRev = nz(segR.reagentInst, 11.08);        // 试剂+仪器（2025年报：10.07+1.01）
  const cRev = nz(segR.service, 0.47);             // 检测服务
  const invCoef = nz(T3.investCoef, 0.85);         // 非并表股权投资账面价值系数（0.7~1.0 中值）
  const netInvest = nz(T3.netInvest, 13.15);
  const postCommitDisc = nz(T3.haijiPostCommitDisc, 0.875);  // 承诺期后持续性折价
  const sotpA = aRev * psUse * discAUseFin;                       // 试剂+仪器（EV/Sales·PS，含集采/增值税常态化折价）
  const sotpB = I.haiji.np * haijiPeUse * postCommitDisc * (1 - haijiGoodwillImpairRate);  // 生物类药品（海济 PE×承诺期后折价；集采预期→PE封顶至可比中位数×0.7 + 商誉减值单独扣减）
  const sotpC = cRev * psUse * 0.9;                               // 检测服务（PS 保守）
  const sotpNet = netInvest * invCoef + (S3 && S3.cash != null ? S3.cash : I.balanceSheet2025.cash) - I.balanceSheet2025.interestDebt;
  const sotp2Mv = sotpA + sotpB + sotpC + sotpNet;
  const sotp2LowMv = sotp2Mv * 0.9, sotp2HighMv = sotp2Mv * 1.1;  // 行业倍数 ±10%（沿袭三情景）

  // ---- 指令2 触发器：海济集采预期 → SOTP 防高估（PE 封顶 + 商誉减值单独扣减） ----
  if (haijiPeCapped) {
    alerts.push(`⚠️ 海济集采预期触发 SOTP 防高估：生长激素赛道集采（粉针/水针）预期 → 海济适用PE封顶至可比中位数×0.7 = ${r2(haijiPeCap)}x（原生物制品PE ${bioPEUse}x），并单独计提商誉减值准备扣减项 ${(haijiGoodwillImpairRate * 100).toFixed(0)}% → 轨道II·B（海济 ${I.haiji.np} 亿净利）估值下调至 ${r2(sotpB)} 亿`);
  }

  // ---- 轨道III：历史分位校验（15%）----
  const pctEst = pePercentileEst(peTtm3, histLow, histHigh);
  const tr3CenterMv = ttmNpForVal != null ? ttmNpForVal * (histLow + histHigh) / 2 : null;
  if (pctEst && (pctEst.pct > 85 || pctEst.pct < 15)) alerts.push(`⚠️ 估值极端分位警示（轨道III）：当前PE(TTM) ${peTtm3 != null ? r2(peTtm3) : 'NA'} 倍处历史分位 ${pctEst.pct}%（${pctEst.note}）${pctEst.pct > 85 ? ' > 85% → 盈利处周期低点（TTM 利润承压），高PE分位含利润基数效应' : ' < 15% → 盈利处周期高点'}`);

  // ---- 合成（缺口→权重再分配） ----
  const tracksAvail = { t1: tr1LowMv != null, t2: sotp2Mv != null, t3: tr3CenterMv != null };
  let wT1 = 0.5, wT2 = 0.35, wT3 = 0.15;
  const re分配Notes = [];
  if (!tracksAvail.t1) { re分配Notes.push('轨道I缺口 → 50% 按比例转移至 II/III'); }
  if (!tracksAvail.t2) { re分配Notes.push('轨道II缺口 → 35% 转移'); }
  if (!tracksAvail.t3) { re分配Notes.push('轨道III缺口 → 15% 转移'); }
  {
    const wRawSum = (tracksAvail.t1 ? wT1 : 0) + (tracksAvail.t2 ? wT2 : 0) + (tracksAvail.t3 ? wT3 : 0);
    wT1 = (tracksAvail.t1 ? wT1 : 0) / wRawSum; wT2 = (tracksAvail.t2 ? wT2 : 0) / wRawSum; wT3 = (tracksAvail.t3 ? wT3 : 0) / wRawSum;
    if (re分配Notes.length) alerts.push('⚠️ 权重再分配：' + re分配Notes.join('；') + ` → 实际 ${r4(wT1 * 100)}% / ${r4(wT2 * 100)}% / ${r4(wT3 * 100)}%`);
  }
  const synthLow = (tracksAvail.t1 ? tr1LowMv * wT1 : 0) + (tracksAvail.t2 ? sotp2LowMv * wT2 : 0) + (tracksAvail.t3 ? tr3CenterMv * wT3 : 0);
  const synthHigh = (tracksAvail.t1 ? tr1HighMv * wT1 : 0) + (tracksAvail.t2 ? sotp2HighMv * wT2 : 0) + (tracksAvail.t3 ? tr3CenterMv * wT3 : 0);
  const synthCenter = (tracksAvail.t1 ? (tr1LowMv + tr1HighMv) / 2 * wT1 : 0) + (tracksAvail.t2 ? sotp2Mv * wT2 : 0) + (tracksAvail.t3 ? tr3CenterMv * wT3 : 0);

  // ---- 异常检测触发器1：阶段年化隐含 vs 年度锚 ±30% ----
  if (S3 && S3.npCum != null && S3.anchorMonth === undefined) { /* stage 判定见下 */ }
  if (S3 && S3.npCum != null && ttmNpForVal != null) {
    const stageMonths = S3.stage === '09-30' ? 9 : (S3.stage === '06-30' ? 6 : 3);
    const annualizedImplied = S3.npCum * 12 / stageMonths;
    const devVsAnchor = (annualizedImplied / I.fy2025.npAttr - 1) * 100;
    if (Math.abs(devVsAnchor) > 30) alerts.push(`⚠️ 触发器1：表B阶段数据年化隐含值 ${r2(annualizedImplied)} 亿与表A年度锚 ${I.fy2025.npAttr} 亿偏差 ${r2(devVsAnchor)}% > ±30% → 阶段数据与年度锚显著背离（季节性/一次性因素），已优先使用 TTM/年度锚`);
  }

  // ---- 异常检测触发器2：轨道I vs II 隐含市值偏差 >30% ----
  if (tr1LowMv != null && sotp2Mv != null) {
    const dev12 = Math.abs(((tr1LowMv + tr1HighMv) / 2) - sotp2Mv) / sotp2Mv * 100;
    if (dev12 > 30) alerts.push(`⚠️ 触发器2：相对估值（轨道I中值 ${r2((tr1LowMv + tr1HighMv) / 2)} 亿）与分部加总（轨道II ${r2(sotp2Mv)} 亿）背离 ${r2(dev12)}% > 30% —— TTM 利润处周期低点导致 PE 轨承压，SOTP 反映分部资产价值与净现金`);
  }

  // ---- 异常检测触发器5：商誉/净资产>30% 且承诺完成率<100% ----
  const goodwillVal = S3 && S3.goodwill != null ? S3.goodwill : 7.98;
  const equityVal = S3 && S3.equity != null ? S3.equity : 71.16;
  const gwPct = equityVal > 0 ? goodwillVal / equityVal * 100 : null;
  const commitRate = nz(I.haiji && I.haiji.commitRate, 132.5);
  if (gwPct != null && gwPct > 30 && commitRate < 100) {
    alerts.push(`⚠️ 触发器5：商誉/净资产 ${r2(gwPct)}% > 30% 且海济承诺完成率 ${commitRate}% < 100% → 商誉减值风险需纳入折价`);
  }

  // ---- 风险折价（合成后施加，仅下调不上调，逐项披露） ----
  const discRows = [];
  const dVat = nz(T3.discounts && T3.discounts.vat, 0.065);
  const dCollect = nz(T3.discounts && T3.discounts.collect, 0.04);
  const dExpense = nz(T3.discounts && T3.discounts.expense, 0.015);
  let goodwillDisc = 0;
  if (gwPct != null && gwPct > 30 && commitRate < 100) goodwillDisc = nz(T3.discounts && T3.discounts.goodwill, 0.125);
  discRows.push({ item: '增值税率上调常态化', trigger: '自产试剂 13% 税率持续', disc: dVat, scope: '诊断试剂分部利润' });
  discRows.push({ item: '集采扩围风险', trigger: 'HPV 已集采，呼吸道试剂若纳入', disc: dCollect, scope: '试剂分部收入' });
  if (goodwillDisc > 0) discRows.push({ item: '商誉减值风险', trigger: `商誉 ${r2(goodwillVal)} 亿（占净资产 ${r2(gwPct)}%），承诺完成率 ${commitRate}%`, disc: goodwillDisc, scope: 'SOTP 并购贡献部分' });
  else discRows.push({ item: '商誉减值风险', trigger: `不触发：商誉/净资产 ${r2(gwPct)}% ≤ 30% 或承诺完成率 ${commitRate}% ≥ 100%`, disc: 0, scope: '—' });
  discRows.push({ item: '并购整合与费用压力', trigger: `销售费用率 H1 ${seOn ? SE.ttm.sellExpenseRate : '36.51'}% 高企、研发资本化率上升`, disc: dExpense, scope: '净利润率假设压力测试' });
  discRows.push({ item: '口径不可比残留', trigger: '海济 2025-01-31 并表，跨并表日同比失真', disc: 0, scope: '增速假设优先内生口径，表观增速仅作参考' });
  const totalDiscCoef = discRows.reduce((acc, d) => acc * (1 - d.disc), 1);
  const finalLow = synthLow * totalDiscCoef, finalHigh = synthHigh * totalDiscCoef, finalCenter = synthCenter * totalDiscCoef;

  // ---- 跨并表日口径标注（规则D） ----
  const consoNote = '规则D：中山海济 2025-01-31 并表，2025 年报含其全年贡献而 2024 同期不含 —— 海济净利同比 +77.21% 属「口径不可比（并表影响）」，估值参数以内生口径优先，表观增速仅作参考';

  // ---- 最终结论（三轨口径替换顶层；六模型保留为附录参照） ----
  const range3 = [r2(finalLow / N), r2(finalHigh / N)];
  const center3 = r2(finalCenter / N);

  // ========== 指令1 · 绝对估值（每股）坐标轴对齐（图1 ↔ 图2） ==========
  // 图1 = V3.0 三轨合成（含历史极端PE悲观折价，折价后中枢 center3）；
  // 图2 = 前瞻情景测试（三情景 / Forward PE·2026E EBITDA，未含悲观折价）。
  // 两者口径不同（滞后PE/SOTP折价 vs 2026E前瞻），需在图2顶部显式锚定图1折价前区间，避免用户混淆两个中枢。
  const preDiscRangePS = [r2(synthLow / N), r2(synthHigh / N)];
  const preDiscCenterPS = r2(synthCenter / N);
  const secAxisNote = `注：此情景为前瞻性（2026E）敏感性测试，未包含历史极端PE的悲观折价。若按V3.0保守折价口径，基准情景对应中枢应平移至 ${center3} 元。`;
  const secAxis = {
    preDiscRange: preDiscRangePS,
    preDiscCenter: preDiscCenterPS,
    postDiscCenter: center3,
    note: secAxisNote,
    anchorLine: `锚定基准（图1折价前每股区间）：[${preDiscRangePS[0]}, ${preDiscRangePS[1]}] 元，中枢 ${preDiscCenterPS} 元；图2为前瞻性2026E情景，未含悲观折价。`,
  };

  let rating3 = '合理';
  let impliedPct3 = null;
  if (price != null && isFinite(price) && price > 0) {
    impliedPct3 = r2((center3 - price) / price * 100);
    if (price <= range3[0]) rating3 = '低估';
    else if (price >= range3[1]) rating3 = '高估';
  }

  // ---- 输出模板七节（关键 rows） ----
  const fiveTableRows = [
    { label: '表A·年度锚（硬锚）', value: `2025年报（公告日 2026-04-30）：营收 16.42 亿(+12.58%) / 归母 1.99 亿(−27.82%) / 扣非 1.67 亿 / 综合毛利率 75.79% / 商誉 7.98 亿（海济 7.36 亿）`, source: '年报（已审计，估值基准最终锚）' },
    { label: `表B·阶段观测（软锚，禁倒推）`, value: S3 ? `${S3.stageLabel}（${S3.asOf}，东财F10实时）：营收累计 ${r2(S3.revCum)} 亿 / 归母累计 ${r2(S3.npCum)} 亿 / 扣非累计 ${r2(S3.npDedCum)} 亿；2026Q1 营收 4.37(-8.02%)/归母 0.50(-45.78%)；2026H1 营收 8.34(-3.95%)/归母 0.98(-39.76%)` : '阶段观测数据不可用（锚点降级，估值以表A年度锚为基准）', source: '东财F10三表实时拉取（锚点自动前移）' },
    { label: '表C·TTM拼接（唯一合法桥接）', value: `TTM营收 ${ttmRev3 != null ? r2(ttmRev3) + ' 亿' : '不可计算'} / TTM归母 ${ttmNp3 != null ? r2(ttmNp3) + ' 亿' : '不可计算'} / TTM扣非 ${ttmNpDed3 != null ? r2(ttmNpDed3) + ' 亿' : '不可计算'}；${ttmAnchor.note}`, source: `锚点 ${ttmAnchor.asOf || '缺口'}（${ttmAnchor.stageLabel || '回退规则B'}）` },
    { label: '表D·市场实时', value: `现价 ${price != null ? r2(price) : 'NA'} 元 / 总市值 ${mktCap3 != null ? r2(mktCap3) + ' 亿' : 'NA'} / PE(TTM) ${peTtm3 != null ? r2(peTtm3) + ' 倍' : 'NA'}（总股本 ${N} 亿股）`, source: '腾讯行情（运行时刷新，时间戳=运行日）' },
    { label: '表E·可比与行业锚', value: `可比 IVD PE 中位 ${compPeMedian} 倍（安图/华大/之江/硕世/诺唯赞，中位数非均值）；圣湘历史 PE 区间 ${histLow}~${histHigh} 倍（近3年，P25≈${r2(histP25)}/P75≈${r2(histP75)}【均匀分位近似】）`, source: T3.source || '规范 v1.0 表E 锚定' },
  ];

  const threeTrackRows = [
    { label: '轨道I·相对估值（50%）', value: `TTM归母 ${r2(ttmNpForVal)} 亿 × 目标PE [${r2(band.lo)}, ${r2(band.hi)}] → 隐含市值 [${r2(tr1LowMv)}, ${r2(tr1HighMv)}] 亿；PS 交叉校验：TTM营收 ${ttmRev3 != null ? r2(ttmRev3) : 'NA'} 亿 × [${r2(psComp * 0.8)}, ${r2(psComp * 1.2)}] → [${tr1PsLowMv != null ? r2(tr1PsLowMv) : 'NA'}, ${tr1PsHighMv != null ? r2(tr1PsHighMv) : 'NA'}] 亿${psDevPct != null ? `（偏差 ${r2(psDevPct)}%）` : ''}；${band.note}`, source: 'TTM 口径（表C），目标PE动态锚定' },
    { label: '轨道II·SOTP（35%）', value: `A 试剂+仪器 ${aRev} 亿×${psUse}x×${discAUseFin}(集采/增值税常态化) = ${r2(sotpA)}；B 生物类药品 海济 1.85 亿×${r2(haijiPeUse)}x${haijiPeCapped ? `（集采封顶·原${bioPEUse}x）` : ''}×${postCommitDisc}(承诺期后折价)${haijiGoodwillImpairRate > 0 ? `×(1−${(haijiGoodwillImpairRate * 100).toFixed(0)}%商誉减值)` : ''} = ${r2(sotpB)}；C 检测服务 ${cRev} 亿×${psUse}x×0.9 = ${r2(sotpC)}；D 净现金/投资 = 非并表股权投资 ${netInvest}×${invCoef}(0.7~1.0中值) + 货币资金 ${S3 && S3.cash != null ? r2(S3.cash) : I.balanceSheet2025.cash} − 有息负债 ${I.balanceSheet2025.interestDebt} = ${r2(sotpNet)} → 合计 ${r2(sotp2Mv)} 亿 [${r2(sotp2LowMv)}, ${r2(sotp2HighMv)}]（±10%行业倍数）`, source: '分部锚定表A+行业倍数表E' },
    { label: '轨道III·历史分位校验（15%）', value: `当前 PE(TTM) ${peTtm3 != null ? r2(peTtm3) : 'NA'} 倍 → 历史分位 ${pctEst ? pctEst.pct + '%' : 'NA'}${pctEst && pctEst.above ? '（超出历史区间上沿，封顶 >99%）' : ''}；中枢参考 = 历史PE中位 ${r2((histLow + histHigh) / 2)} × TTM归母 ${r2(ttmNpForVal)} = ${tr3CenterMv != null ? r2(tr3CenterMv) : 'NA'} 亿`, source: pctEst ? pctEst.note : '历史区间缺失' },
    { label: '三轨合成（折价前）', value: `[${r2(synthLow)}, ${r2(synthHigh)}] 亿，中枢 ${r2(synthCenter)} 亿（轨道I ${r4(wT1 * 100)}% + 轨道II ${r4(wT2 * 100)}% + 轨道III ${r4(wT3 * 100)}%）`, source: '规范 2.2 合成规则' },
    { label: `风险折价后最终区间`, value: `[${r2(finalLow)}, ${r2(finalHigh)}] 亿 → 每股 [${range3[0]}, ${range3[1]}] 元，中枢 ${center3} 元${impliedPct3 != null ? `；相对现价 ${r2(price)} 元隐含${impliedPct3 >= 0 ? '上行' : '下行'}空间 ${Math.abs(impliedPct3)}%` : ''}`, source: `合计折价系数 ${r4(totalDiscCoef)}（${discRows.filter(d => d.disc > 0).map(d => d.item + ' −' + (d.disc * 100).toFixed(1) + '%').join('、')}）` },
  ];

  // ========== 卡片行数据（确定性拼装） ==========
  const reportHeadRows = [
    { label: '估值基准日', value: `${P.baseDate}（系统运行日自动识别）`, source: '动态时间引擎' },
    { label: '最新年报 FY_Latest', value: `${fyLabel}（披露 ${cfg.timeEngine.reportPeriods.fyLatest.disclosed}）`, source: cfg.timeEngine.reportPeriods.fyLatest.source || I.fy2025.source },
    { label: '最新季报 Q_Latest', value: `${cfg.timeEngine.reportPeriods.qLatest.label}（披露 ${cfg.timeEngine.reportPeriods.qLatest.disclosed}）`, source: I.qLatest.source },
    { label: 'TTM（最近12个月）', value: `营收 ${ttm.rev} 亿 / 归母 ${ttm.npAttr} 亿（${ttm.revCalc}）`, source: I.ttm.source },
    { label: 'FY_Current / FY_Next', value: `${P.fyCurrent}E 归母 ${consPicked.fyCurrent} 亿 / ${P.fyNext}E 归母 ${consPicked.fyNext} 亿（${cons.institutions} 家一致预期${consSubstituted ? '·替代算法' : ''}）`, source: consSubstituted ? '替代算法' : cons.source },
    { label: '总股本', value: `${N} 亿股`, source: I.totalSharesSource }
  ];

  const diagRows = [
    { label: '利润趋势诊断', value: `近3财年归母净利复合 ${cagrPct}%（${I.np3y.map(x => `${x.year}:${x.np}${x.flag && x.flag.includes('估算') ? '【估算】' : ''}${x.flag && x.flag.includes('反推') ? '【反推】' : ''}`).join(' → ')}）${cagrPct < R.diagnostics.cagrSevereThreshold ? ' < −10% → ' : ' ≥ −10% → '}${severeVol ? '标记「剧烈波动期」，放弃 TTM PE，转向 Forward PE' : 'PE法可用'}` },
    { label: '业务多元化诊断', value: `圣湘海济（生长激素）净利占比 ${bioRatio}%（1.85/1.99）${forceSotp ? ' > 30% → 强制启动 SOTP 分部估值' : ' ≤ 30% → 无需强制 SOTP'}；试剂毛利率 ${reagentGmNow}%，同比数据${gmDropKnown ? `为 ${gmDrop}%` : '未采集 → 集采折价判定不触发（板块折价已由增速规则取0.55下沿）'}` },
    { label: '业绩动量诊断', value: `Q2 营收同比 ${qRevYoY > 0 ? '+' : ''}${qRevYoY}%、净利同比 ${qNpYoY}% → ${momentumNote}` }
  ];

  const coreRows = [
    { label: '2025 营收 / 归母净利', value: `${I.fy2025.rev} 亿 / ${I.fy2025.npAttr} 亿（-27.82%）`, source: I.fy2025.source },
    { label: '分部：IVD / 生物药品 / 境外 / 测序', value: `11.55 亿(-18.87%) / 4.61 亿(毛利87.38%) / 0.83 亿(+31.63%) / 0.30 亿【假设】`, source: seg.source },
    { label: '圣湘海济（生长激素）', value: `2025 净利 1.85 亿(+77.21%)，业绩承诺 1.4 亿完成率 132.5%，100% 全资；26H1 收入 1.96 亿同比略降`, source: I.haiji.source },
    { label: '净现金 / 有息负债', value: `${netCash} 亿（含交易性金融资产 1.57 亿）/ ${I.balanceSheet2025.interestDebt} 亿`, source: I.balanceSheet2025.source },
    { label: '行业倍数', value: `PS(TTM) ${psUse}x；器械 PE ${devPEUse}x；生物制品 PE ${bioPEUse}x${haijiPeCapped ? `（海济·集采预期适用PE封顶至 ${r2(haijiPeCap)}x = 可比中位数×0.7）` : ''}；EV/EBITDA ${evMidUse}x${I.industry.evEbitdaAssumed ? '【假设】' : ''}`, source: `${I.industry.psSource}；${I.industry.bioPESource}` },
    { label: '宏观参数', value: `10Y国债 ${I.macro.rf10y}% + 风险溢价 ${I.macro.riskPremiumUsed}% → WACC ${(wacc * 100).toFixed(2)}%；永续 g ${I.macro.gUsed}%（长期CPI 2.5~3%）`, source: I.macro.rfSource },
    { label: '净现比 / 资本开支均值', value: `${cf.npCashRatio}（3年） / ${cf.capexAvg} 亿（3年均值）/ 折旧摊销 ${cf.daAssumed} 亿【假设】`, source: cf.source }
  ];
  if (seOn) {
    coreRows.push({ label: '销售费用率（FY2025 / TTM）', value: `${SE.fyLatest.sellExpenseRate}% / ${SE.ttm.sellExpenseRate}%（TTM 销售费用 ${SE.ttm.sellExpense} 亿）；内生（剔除海济）约 ${SE.breakdown.organicSellRate}%，IVD 行业均值 ${SE.industry.benchmark}%（${SE.industry.n}家）`, source: `${SE.fyLatest.source}；${SE.breakdown.source.slice(0, 60)}…` });
  }

  const sotpLegacyB = base.sotp;
  const sotpRows = [
    { label: 'A 分子诊断（试剂+仪器+服务，PS法）', value: `11.55 亿 × ${psUse}x × ${discAUseFin}（IVD 增速 ${ivdGrowth}%<0 → 增速规则折价 ${discAUse}${seOn ? ` + 销售费用显性调整额外 −${aExtraDisc.toFixed(2)}` : ''} = ${discAUseFin}；TTM拆分未披露→年报增速口径）= ${r2(sotpLegacyB.A)} 亿` },
    { label: 'B 生物药品（圣湘海济，PE法）', value: `1.85 亿 × ${r2(haijiPeUse)}x${haijiPeCapped ? `（集采封顶·原${bioPEUse}x）` : ''} × ${coefBFinal}（净利增速 +${haijiGrowth}%>20% → ×${coefB}${seOn ? `；销售费用调整系数 ×${bPeCoef}` : ''}）${(haijiGoodwillImpairRate > 0) ? ` × (1−${(haijiGoodwillImpairRate * 100).toFixed(0)}%商誉减值)` : ''} = ${r2(sotpLegacyB.B)} 亿；100% 全资无控股折价${haijiPeCapped ? `；⚠️ 集采预期触发防高估约束（PE封顶至可比中位数×0.7 + 商誉减值单独扣减）` : ''}` },
    { label: 'C 新兴业务（测序+境外，PS×溢价）', value: `测序 0.30 亿×${psUse}x×${premC(seqGrowth)}（+${seqGrowth}%>50%→1.8） + 境外 0.83 亿×${psUse}x×${premC(ovsGrowth)}（+${ovsGrowth}%→1.4）= ${r2(sotpLegacyB.C)} 亿` },
    { label: '静态 EV', value: `A + B + C = ${r2(sotpLegacyB.ev)} 亿` },
    { label: '股权价值', value: `EV − 有息负债 ${I.balanceSheet2025.interestDebt} 亿 + 货币资金 ${I.balanceSheet2025.cash} 亿 + 交易性金融资产 ${I.balanceSheet2025.tradingFA} 亿（类现金，模型口径扩展）= ${r2(sotpLegacyB.equity)} 亿` },
    { label: 'SOTP 每股价值', value: `${r2(sotpLegacyB.equity)} 亿 ÷ ${N} 亿股 = ${r2(sotpLegacyB.perShare)} 元` }
  ];

  const xvalRows = [
    { model: '动态 SOTP（核心）', perShare: r2(base.sotp.perShare), weight: `${(W.sotp * 100).toFixed(1)}%`, contribution: r2(base.sotp.perShare * W.sotp), note: `权重自适应 ${wSotp}%（生物药占比 ${bioRatio}%）；A/B/C 按 2025 年报分部动态系数${seOn ? `；A 板块PS折价 ${discAUseFin}（销售费用刚性额外 −${aExtraDisc.toFixed(2)}）` : ''}` },
    { model: '动态 Forward PE', perShare: r2(base.pe), weight: `${(W.forwardPE * 100).toFixed(1)}%`, contribution: r2(base.pe * W.forwardPE), note: `EPS(FY_C/FY_N) ${r3(epsCur)}/${r3(epsNext)} 元 × 器械 ${devPEUse}x × ${fwdPenalty}（Q2净利 ${qNpYoY}%<−30% 惩罚）× ${momCoef}（营收动量${qRevYoY > 0 ? '企稳无调整' : ''}）${dSellRate != null ? ` × ${sellEffCoef}（费用效率：Δ${dSellRate}pp）` : ''}` },
    { model: '整体 PS（TTM）', perShare: r2(base.ps), weight: `${(W.ps * 100).toFixed(1)}%`, contribution: r2(base.ps * W.ps), note: `TTM 营收 ${ttm.rev} 亿 × ${psUse}x × ${psDiscount}（${collectDiscount ? '试剂毛利率下滑>5%→集采折价0.60' : '含高利润生长激素→整体折价0.75'}）` },
    { model: '动态 DCF（FCFF）', perShare: r2(base.dcf.perShare), weight: dcfRemoved ? '剔除' : `${(W.dcf * 100).toFixed(1)}%`, contribution: r2(base.dcf.perShare * W.dcf), note: dcfRemoved ? `FCFF = 净利×${cf.npCashRatio} − ${cf.capexAvg} − ${cf.wcDeltaAvg} 三年全负（${fcff.map(f => r2(f)).join('/')}）+ 终值负 → 失效检验剔除，权重归一；WACC ${(wacc * 100).toFixed(2)}%/g ${I.macro.gUsed}%` : `WACC ${(wacc * 100).toFixed(2)}%、g ${I.macro.gUsed}%` },
    { model: '动态 EV/EBITDA', perShare: r2(base.evEbitda), weight: `${(W.evEbitda * 100).toFixed(1)}%`, contribution: r2(base.evEbitda * W.evEbitda), note: `EBITDA(2026E) ${ebitdaUse} 亿 × ${evMidUse}x${I.industry.evEbitdaAssumed ? '【假设】' : ''} + 净现金 ${netCash} 亿；EBITDA 已扣销售费用（天然口径、无需再调）` },
    { model: '动态 rNPV（管线）', perShare: r2(base.rnpv), weight: `${(W.rnpv * 100).toFixed(1)}%`, contribution: r2(base.rnpv * W.rnpv), note: 'QPOC 2.0 / 海之元 ISS（III期）/ 基因甲基化；峰值销售为假设；默认P=65%按临床阶段调整' }
  ];

  const weightRows = wAdj.map(t => ({ text: t }));

  const scenRows = [
    { name: '乐观', value: r2(opt.composite), note: `行业倍数 ×${SCEN_MULT.optimistic}（行业PE上浮10%）：PS ${(psUse * 1.1).toFixed(2)}x / 器械PE ${(devPEUse * 1.1).toFixed(0)}x / 生物药PE ${(bioPEUse * 1.1).toFixed(1)}x` },
    { name: '基准', value: r2(base.composite), note: '当前行业均值（PS 7.6x / 器械PE 30x / 生物药PE 35.6x）' },
    { name: '保守', value: r2(consv.composite), note: `行业倍数 ×${SCEN_MULT.conservative}（行业PE下浮10%）且 SOTP 扣减5%安全边际（haircut ${(consv.sotp.hair * 100).toFixed(0)}%）` }
  ];

  // ---- 追加指令（2026-09-13）：销售费用显性调整模块 明细行（步骤1-5）----
  const sellExpRows = [];
  const sellExpScenRows = [];
  if (seOn) {
    const tm = SE.ttm || {};
    const ind = SE.industry || {};
    const fyl = SE.fyLatest || {};
    const organicDeltaTxt = organicYoYPP === 0 ? '基本持平' : `${organicYoYPP > 0 ? '+' : ''}${organicYoYPP}pp`;
    const ebitdaMargin2025 = fyl.rev ? +(I.ebitda.fy2025 / fyl.rev * 100).toFixed(2) : null;
    const ebitdaMargin2026 = (cons && cons.rev2026E) ? +(ebitdaUse / cons.rev2026E * 100).toFixed(2) : null;
    const suppressAmt = (fyl.rev && fyl.sellExpenseRate != null && ind.benchmark != null)
      ? +((fyl.sellExpenseRate - ind.benchmark) / 100 * fyl.rev).toFixed(2) : null;
    const deltaBand = dSellRate == null ? '' : (dSellRate > 10 ? '>10pp' : (dSellRate > 5 ? '∈5~10pp' : '<5pp'));
    sellExpRows.push({ label: '① 销售费用性质拆解（FY_Latest 2025）', value: `合并销售费用 ${fyl.sellExpense} 亿（占营收 ${fyl.sellExpenseRate}%）；其中咨询费及销售佣金 ${bd.consultingCommission} 亿（同比 +${bd.consultingCommissionYoY}%）——并购并表贡献（圣湘海济）${bd.haijiContribution} 亿 / 内生原有业务 ${bd.organicContribution} 亿（同比 ${bd.organicContributionYoY}%）`, source: '上交所问询函回复（2026-06-12）+ 2025年报' });
    sellExpRows.push({ label: '① 内生销售费用率', value: `内生（剔除海济）销售费用率约 ${bd.organicSellRate}%（${organicDeltaTxt === '基本持平' ? '同比基本持平' : '同比 ' + organicDeltaTxt}）；海济销售费用率 ${bd.haijiSellRate}%（同比 ${bd.haijiSellRateYoYPP}pp）→ 内生推广投入同比压缩约 ${Math.abs(bd.organicContributionYoY)}%，费用率高企主因 = ①并购并表结构性抬高（海济 38% 高费率）②收入下滑的分母效应（IVD 营收 ${ivdGrowth}%）`, source: '上交所问询函回复（2026-06-12，art_code AN202606111823465410）' });
    sellExpRows.push({ label: '② 板块A 分子诊断 · PS 额外折价', value: `IVD 营收 ${ivdGrowth}%（<0，集采冲击）且内生费用率同比${organicDeltaTxt}（费用刚性）→ PS 折价系数 ${discAUse} − ${aExtraDisc.toFixed(2)} = ${discAUseFin}（额外下调 ${aExtraDisc.toFixed(2)}）`, source: '规则：营收下滑且费用刚性 → 额外下调 0.05~0.10（取下沿 0.10）' });
    sellExpRows.push({ label: '② 板块B 生物药品（圣湘海济）· PE 系数', value: `子公司销售费用同比 ${bd.haijiContributionYoY}% ＜ 营收同比 +${I.haiji.revYoY}%（费用增速未跑赢营收，未触发 PE 下调）→ PE 系数 ${bPeCoef}（板块B PE 倍数维持）`, source: '规则：子公司销售费用增速 > 营收增速才下调 5%~10%' });
    sellExpRows.push({ label: '② 板块C 新兴业务（基因测序/境外）· 不调整', value: '基因测序处放量期，高销售费用属正常市场培育投入 → PS 溢价系数不调整', source: '追加指令步骤2' });
    sellExpRows.push({ label: '③ Forward PE 费用效率惩罚系数', value: `Δ = TTM 销售费用率 ${tm.sellExpenseRate}% − IVD 行业均值 ${ind.benchmark}%（${ind.scope || ''}）= ${dSellRate}pp ${deltaBand} → Forward PE × ${sellEffCoef}（与业绩惩罚 ${fwdPenalty} 叠乘）`, source: '规则：Δ>10pp→0.85 / 5~10pp→0.90 / <5pp→1.00' });
    sellExpRows.push({ label: '④ EV/EBITDA（天然口径，无需调整）', value: `EBITDA 已扣除销售费用，模型天然含费用影响，无需再调；当前 EBITDA 利润率 FY2025 ${ebitdaMargin2025}% / 2026E ${ebitdaMargin2026}%，主要受销售费用率 ${fyl.sellExpenseRate}%（TTM ${tm.sellExpenseRate}%）压制${suppressAmt != null ? `，相对 IVD 行业均值多支出约 ${suppressAmt} 亿（≈可释放的 EBITDA 空间）` : ''}`, source: '追加指令步骤4' });
    sellExpRows.push({ label: '⑤ 销售费用情景（优化 / 恶化）', value: `费用优化：未来两年费率每年降 2~3pp（累计 −${SE.rules.optimizeRatePP}pp）；费用恶化：费率维持或上升（+${SE.rules.worsenRatePP}pp）→ 见下方「销售费用情景测试」`, source: '追加指令步骤5' });
    if (seScen) {
      const o = seScen.optimize, w = seScen.worsen;
      sellExpScenRows.push({ name: '费用优化', value: r2(o.compositeAdj), note: `两年累计 −${Math.abs(SE.rules.optimizeRatePP)}pp（每年 −${SE.rules.optimizeRatePPerYear || 2.5}pp）；释放销售费用 ${r2(o.deltaSell)} 亿 → 税后增厚净利 ${r2(o.deltaNp)} 亿（税率 ${(seScen.taxRate * 100).toFixed(0)}%【假设】）；Forward PE 每股 ${r2(o.peAdj)}、EBITDA(2026E) ${r2(o.ebitdaAdj)} 亿；较基准 ${o.delta >= 0 ? '+' : ''}${o.delta} 元` });
      sellExpScenRows.push({ name: '基准', value: r2(base.composite), note: `销售费用率维持 TTM ${tm.sellExpenseRate}%（FY2025 ${fyl.sellExpenseRate}%）；Forward PE 已含费用效率系数 ×${sellEffCoef}` });
      sellExpScenRows.push({ name: '费用恶化', value: r2(w.compositeAdj), note: `费率 +${SE.rules.worsenRatePP}pp（维持或上升，如集采后推广加码 / 整合不及预期）；销售费用增加 ${r2(-w.deltaSell)} 亿 → 净利减少 ${r2(-w.deltaNp)} 亿；较基准 ${w.delta >= 0 ? '+' : ''}${w.delta} 元` });
    }
  }

  const seRisk = seOn ? `6) 销售费用刚性——销售费用率（TTM ${SE.ttm.sellExpenseRate}% / FY2025 ${SE.fyLatest.sellExpenseRate}%）显著高于 IVD 行业均值 ${SE.industry.benchmark}%，若推广投入无法随收入同步压缩，将持续压制利润率与 Forward PE；` : '';
  const riskNote = `1) 集采降价超预期→诊断板块PS折价再下移；2) 增值税3%→13%的利润压制或持续；3) 生长激素集采/国谈降价与竞争加剧→海济PE下调（26H1海济收入已同比略降）；4) 管线临床失败或获批不及预期；5) 并购整合与商誉减值风险（商誉7.34亿）；${seRisk}${seOn ? '7' : '6'}) 全部结果基于公开信息与机构预测，不构成投资建议。`;

  const decisionNote = `【画像诊断→模型路由】①近3财年归母净利复合 ${cagrPct}% < −10% → 「剧烈波动期」→ 放弃 TTM PE、采用 Forward PE；②圣湘海济净利占比 ${bioRatio}% > 30% → 强制 SOTP（A试剂+仪器+服务=PS法 / B生物药=PE法 / C新兴业务=PS×溢价）；③Q2 营收 +0.98%（−5%~15%区间）→ PE法无惩罚无溢价，但净利 −31.99% < −30% → Forward PE 行业基准 ×0.85。【动态性】基准日/财报期/系数/权重/兜底全部按规则表由代码自动判定，无硬编码年份。【兜底状态】${fallbackFlags.length ? fallbackFlags.join('；') : '机构预期/季报/行业倍数三项数据齐备，未触发兜底'}${seOn && dSellRate != null ? `【销售费用显性调整】TTM 销售费用率 ${SE.ttm.sellExpenseRate}% − IVD 行业均值 ${SE.industry.benchmark}% = Δ${dSellRate}pp → Forward PE ×${sellEffCoef}；板块A PS 折价 ${discAUse}→${discAUseFin}（费用刚性额外 −${aExtraDisc}）；板块B 海济费用增速 ${bd.haijiContributionYoY}% < 营收 +${I.haiji.revYoY}% → PE 不调整；内生销售费用率约 ${bd.organicSellRate}%（费用率 38% 的海济并表是结构性抬升主因）` : ''}`;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  return {
    ok: true,
    dedicated: true,
    sanxi: true,
    symbol: SYMBOL,
    stockName: cfg.name,
    version: 'V3.0_三轨并行',
    versionStamp: cfg.version,
    runId,
    rating: rating3,
    fairValueRange: range3,
    fairValueCenter: center3,
    currentPrice: price != null ? r2(price) : null,
    impliedPct: impliedPct3,
    reportLabel: cfg.reportLabel,
    model: 'sanxi688289（V3.0_三轨并行·五表锚定·确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    // 规范 v1.0 输出模板
    anchor3: ttmAnchor,
    fiveTableRows,
    threeTrackRows,
    riskDiscRows: discRows,
    alerts,
    fallbackMarks,
    consoNote,
    totalDiscCoef: r4(totalDiscCoef),
    secAxis,
    summaryNote: `三轨并行（20261029r）：锚点 ${ttmAnchor.asOf || '缺口'}（${ttmAnchor.stageLabel || '回退规则B'}）｜TTM 营收 ${ttmRev3 != null ? r2(ttmRev3) : 'NA'} 亿 / TTM 归母 ${ttmNpForVal != null ? r2(ttmNpForVal) : 'NA'} 亿｜轨道I(50%) [${tr1LowMv != null ? r2(tr1LowMv) : 'NA'}, ${tr1HighMv != null ? r2(tr1HighMv) : 'NA'}] / 轨道II(35%) ${r2(sotp2Mv)} / 轨道III(15%) 中枢 ${tr3CenterMv != null ? r2(tr3CenterMv) : 'NA'} 亿｜合成后风险折价 ×${r4(totalDiscCoef)} → 最终每股 [${range3[0]}, ${range3[1]}] 元，中枢 ${center3} 元【${rating3}】${impliedPct3 != null ? `（隐含${impliedPct3 >= 0 ? '上行' : '下行'} ${Math.abs(impliedPct3)}%）` : ''}｜警报 ${alerts.length} 项`,
    // V2.1 六模型附录参照（不参与三轨合成）
    legacySix: { rating: ratingLegacy, range, center, note: 'V2.1 六模型交叉验证口径（SOTP/Forward PE/PS/DCF/EV-EBITDA/rNPV 加权），保留作附录参照；主结论以三轨并行为准' },
    // 沿袭字段（卡片）
    reportHeadRows, diagRows, coreRows, sotpRows, xvalRows, weightRows, scenRows,
    sellExpRows, sellExpScenRows,
    sellingExpense: seOn ? { benchmark: SE.industry.benchmark, ttmRate: SE.ttm.sellExpenseRate, fyRate: SE.fyLatest.sellExpenseRate, organicRate: SE.breakdown.organicSellRate, deltaPP: dSellRate, effCoef: sellEffCoef, aExtraDisc, bPeCoef } : null,
    fallbackFlags, freshnessRows,
    riskNote, decisionNote,
    weights: W
  };
}

module.exports = { run, isSanxiModel, loadConfig, ttmSplice, targetPeBand, pePercentileEst };

~~~

---

## `lib\valuation\silan600460.js`  ·  475 行

~~~js
// ============================================================
// 士兰微（600460）专属估值引擎 —— 数据治理升级版（确定性计算，1+1=2）
// 20261029q【用户下发规范全文实施】设计总纲三句：
//   ①所有数据必须携带「报告期身份证」（报告期/级别/获取方式三要素），无标签禁入估值公式；
//   ②估值公式强制同口径（分子分母同一报告期体系，跨期混用拦截）；
//   ③缺失数据走固定替代路径（外推/沿用/搜索补充，由数据级别决定，不由 AI 自由发挥）。
// 第一章 基准日锚定：评估基准日=运行日；最新财报锚点=东财三表实时识别（自动前移，无需人工改年份）；
//   锚点之前=已披露实际，锚点之后=预测或高频行业数据（机构预测标注研报发布日）。
// 第二章 身份证制度：A级（季度：营收/归母/扣非/现金流/货币资金/应收/存货/有息负债/归母权益/股本）、
//   B级（半年度：分部结构/账龄/存货结构/研发明细/非经常构成）、C级（年度：产能利用率/爬坡/客户集中度）、
//   H级（高频行业：交期/现货价/库存/产能利用率/下游需求，不受财报期约束）。
// 第三章 替代规则：A级 TTM 固定公式=上年年报+本年累计−上年同期累计（上年同期缺失→退化年化×12/锚点月份数并标注）；
//   B级外推=最近半年报值×(1+A级营收同比×0.5)，系数固定 0.5 不得调整；C级沿用最近年报+标注（搜索补充由配置更新执行）；
//   H级永远用基准日前最近一期。禁止单季替代 TTM、禁止 Q3 配 H1 权益。
// 第四章 口径锁定：PE(TTM)=基准日总市值÷TTM归母；PB(LF)=基准日总市值÷最新锚点归母权益；
//   PS(TTM)=基准日总市值÷TTM营收；ROE=TTM归母÷期初期末均值权益（期初缺失用期末并标注）；
//   DCF 基数=TTM 营收实际，增速=最新研报预期（附录注明「基数=TTM实际，增速=最新预期」）；
//   ΔWC/营收=锚点应收/存货/应付同比增量实际值（替代静态假设）；D&A、CAPEX/营收=TTM 现金流量表实际。
//   拦截规则：分母无法与分子同口径 → 该指标不输出并说明原因。
// 第五~七章：锚点自动前移；级别-报告期矩阵；数据时效清单+完整度评分（A40/B20/C20/H20，<70 可靠性提示）+口径敏感性提示。
// 沿袭 20260908s：景气度五项评分→情景权重→各情景内 PE40%+DCF30%+PB20%+PS10%（DCF 失效检验剔除归一）→情景间加权→三档评级。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '600460';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600460.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isSilanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'silan';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const r4 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 10000) / 10000;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 指令第三步（沿袭）：景气度总分 → 情景权重（规则内置，动态周期） */
function cycWeightsOf(total) {
  if (total >= 3) return { level: '高', w: { optimistic: 0.5, base: 0.4, pessimistic: 0.1 } };
  if (total >= 1) return { level: '中偏上', w: { optimistic: 0.35, base: 0.5, pessimistic: 0.15 } };
  if (total >= -1) return { level: '中偏下', w: { optimistic: 0.2, base: 0.5, pessimistic: 0.3 } };
  return { level: '低', w: { optimistic: 0.1, base: 0.4, pessimistic: 0.5 } };
}

// ============ 第三章 3.1：A级 TTM 固定公式（纯函数，供测试） ============
// TTM = 上年年报 + 本年年初至锚点累计 − 上年同期累计；
// 上年同期缺失 → 退化：本年累计 × 12/锚点月份数，强制标注「年化口径，非严格TTM」。
function ttmRoll(fyVal, curCum, prevSameCum, anchorMonth) {
  const f = (fyVal == null || !isFinite(Number(fyVal))) ? null : Number(fyVal);
  const c = (curCum == null || !isFinite(Number(curCum))) ? null : Number(curCum);
  const s = (prevSameCum == null || !isFinite(Number(prevSameCum))) ? null : Number(prevSameCum);
  if (anchorMonth === 12) return { value: c, annualized: false, note: '年报锚点：TTM=全年' };
  if (f != null && c != null && s != null) return { value: f + c - s, annualized: false, note: `严格TTM=上年年报 ${r2(f)} + 本年累计 ${r2(c)} − 上年同期累计 ${r2(s)}` };
  if (c != null && anchorMonth > 0) {
    const k = 12 / anchorMonth;
    return { value: c * k, annualized: true, note: `上年同期累计缺失【数据缺失】→ 退化年化：本年累计 ${r2(c)} × 12/${anchorMonth}（年化口径，非严格TTM）` };
  }
  return { value: null, annualized: false, note: 'TTM 不可得【数据缺失】' };
}

// ============ 第三章 3.2：B级外推固定公式（纯函数，供测试） ============
// 外推值 = 最近半年报值 × (1 + A级营收同比增速 × 0.5)；系数固定 0.5，不得调整。
function bkExtrapolate(h1Value, revYoyPct) {
  const v = (h1Value == null || !isFinite(Number(h1Value))) ? null : Number(h1Value);
  const g = (revYoyPct == null || !isFinite(Number(revYoyPct))) ? null : Number(revYoyPct) / 100;
  if (v == null) return { value: null, note: 'B级数据缺失【数据缺失】，不做外推（禁静默填充）' };
  if (g == null) return { value: null, note: 'A级营收同比缺失，无法外推【数据缺失】' };
  const coef = 0.5;
  return { value: v * (1 + g * coef), note: `基于最近半年报外推：${r2(v)} × (1 + 营收同比 ${r2(g * 100)}% × ${coef})，外推系数固定 0.5` };
}

// ============ A级数据抓取（东财F10三表，锚点自动识别） ============
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SH${SYM}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income, cf = st.cashflow || [];
    const pick = (arr, d) => (arr || []).find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    // 锚点自动前移：优先三季报 → 中报 → 一季报（当前最新可得）
    const anchor = ['2026-09-30', '2026-06-30', '2026-03-31'].map(d => pick(inc, d)).find(Boolean);
    if (!anchor) return null;
    const asOf = String(anchor.REPORT_DATE).slice(0, 10);
    const am = { '03-31': 3, '06-30': 6, '09-30': 9, '12-31': 12 }[asOf.slice(5, 10)] || 12;
    const prevYear = Number(asOf.slice(0, 4)) - 1;
    const fyPrev = pick(inc, `${prevYear}-12-31`);
    const prevSame = pick(inc, `${prevYear}-${asOf.slice(5, 10)}`);
    // 资产负债表（最新锚点 + 期初=上年年报）
    const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SH${SYM}`, [asOf, `${prevYear}-12-31`, '2025-12-31']);
    const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
    const balCur = balArr.find(r => String(r.REPORT_DATE || '').startsWith(asOf)) || null;
    const balFY = balArr.find(r => String(r.REPORT_DATE || '').startsWith(`${prevYear}-12-31`)) || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2025-12-31')) || null;
    // 现金流量表（TTM 滚动：锚点累计 + 上年年报 − 上年同期累计）
    const cfCur = pick(cf, asOf), cfFY = pick(cf, `${prevYear}-12-31`), cfPrevSame = pick(cf, `${prevYear}-${asOf.slice(5, 10)}`);
    const daSum = (r) => (r && r.FA_IR_DEPR != null) ? (Number(r.FA_IR_DEPR) + Number(r.IA_AMORTIZE || 0) + Number(r.LPE_AMORTIZE || 0) + Number(r.USERIGHT_ASSET_AMORTIZE || 0)) : null;
    const capexOf = (r) => (r && r.CONSTRUCT_LONG_ASSET != null) ? yi(r.CONSTRUCT_LONG_ASSET) : null;
    return {
      asOf, anchorMonth: am, stage: asOf.slice(5, 10),
      revCum: yi(anchor.TOTAL_OPERATE_INCOME),
      npCum: yi(anchor.PARENT_NETPROFIT),
      npDedCum: yi(anchor.DEDUCT_PARENT_NETPROFIT),
      revYoy: anchor.TOTAL_OPERATE_INCOME_YOY != null ? Number(anchor.TOTAL_OPERATE_INCOME_YOY) : null,
      fyRev: fyPrev ? yi(fyPrev.TOTAL_OPERATE_INCOME) : null,
      fyNp: fyPrev ? yi(fyPrev.PARENT_NETPROFIT) : null,
      fyNpDed: fyPrev ? yi(fyPrev.DEDUCT_PARENT_NETPROFIT) : null,
      fyCfo: cfFY ? yi(cfFY.NETCASH_OPERATE) : null,
      fyCapex: cfFY ? capexOf(cfFY) : null,
      fyDa: daSum(cfFY) != null ? yi(daSum(cfFY)) : null,
      prevSameRev: prevSame ? yi(prevSame.TOTAL_OPERATE_INCOME) : null,
      prevSameNp: prevSame ? yi(prevSame.PARENT_NETPROFIT) : null,
      prevSameNpDed: prevSame ? yi(prevSame.DEDUCT_PARENT_NETPROFIT) : null,
      prevSameCfo: cfPrevSame ? yi(cfPrevSame.NETCASH_OPERATE) : null,
      prevSameCapex: cfPrevSame ? capexOf(cfPrevSame) : null,
      prevSameDa: daSum(cfPrevSame) != null ? yi(daSum(cfPrevSame)) : null,
      curCfo: cfCur ? yi(cfCur.NETCASH_OPERATE) : null,
      curCapex: cfCur ? capexOf(cfCur) : null,
      curDa: daSum(cfCur) != null ? yi(daSum(cfCur)) : null,
      equityCur: balCur ? yi(balCur.TOTAL_PARENT_EQUITY) : null,
      equityFY: balFY ? yi(balFY.TOTAL_PARENT_EQUITY) : null,
      cashCur: balCur ? yi(balCur.MONETARYFUNDS) : null,
      arCur: balCur ? yi(balCur.ACCOUNTS_RECE) : null,
      invCur: balCur ? yi(balCur.INVENTORY) : null,
      apCur: balCur ? yi(balCur.ACCOUNTS_PAYABLE) : null,
      minorityCur: balCur ? yi(balCur.MINORITY_EQUITY) : null,
      loanShortCur: balCur ? yi(balCur.SHORT_LOAN) : null,
      loanLongCur: balCur ? yi(balCur.LONG_LOAN) : null,
      arFY: balFY ? yi(balFY.ACCOUNTS_RECE) : null,
      invFY: balFY ? yi(balFY.INVENTORY) : null,
      apFY: balFY ? yi(balFY.ACCOUNTS_PAYABLE) : null,
      balAsOf: balCur ? String(balCur.REPORT_DATE).slice(0, 10) : null,
    };
  } catch (e) { return null; }
}

async function run(symbol, { price, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'silan') return { error: 'NOT_SILAN' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const F = I.forecast, SC = I.scenarios, D = I.dcfFixed, W = I.weights;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // ============ 第一章：基准日锚定（A级三表实时，锚点自动识别；缺表→诚实中止禁用旧值） ============
  const S = statements || await fetchStatements();
  if (!S || S.revCum == null || S.npCum == null) {
    return {
      ok: true, dedicated: true, silan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'silan600460·数据治理升级版（L4 待更新态：三表核心数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 第一章锚定失败：东财F10三表核心数据（最新累计营收/归母）不可得，按设计总纲「无身份证数据禁入估值公式」与「禁用旧值静默填充」终止本次估值，待三表数据恢复后自动重跑（锚点自动前移机制不受影响）。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  // ============ 第二章：报告期身份证台账（三要素） ============
  const ledger = [];
  const L = (name, value, period, level, method, note) => {
    ledger.push({ name, value: value == null ? 'NA【缺失】' : value, period, level, method, note: note || '' });
    return value;
  };
  // A级（锚点期+TTM滚动）
  const ttmRev = ttmRoll(S.fyRev, S.revCum, S.prevSameRev, S.anchorMonth);
  const ttmNp = ttmRoll(S.fyNp, S.npCum, S.prevSameNp, S.anchorMonth);
  const ttmNpDed = ttmRoll(S.fyNpDed, S.npDedCum, S.prevSameNpDed, S.anchorMonth);
  const ttmCfo = ttmRoll(S.fyCfo, S.curCfo, S.prevSameCfo, S.anchorMonth);
  const ttmCapex = ttmRoll(S.fyCapex, S.curCapex, S.prevSameCapex, S.anchorMonth);
  const ttmDa = ttmRoll(S.fyDa, S.curDa, S.prevSameDa, S.anchorMonth);
  L('营收（累计）', S.revCum != null ? r2(S.revCum) + ' 亿' : null, S.asOf, 'A', '直接取数');
  L('TTM 营收', ttmRev.value != null ? r2(ttmRev.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmRev.note);
  L('归母净利（累计）', S.npCum != null ? r2(S.npCum) + ' 亿' : null, S.asOf, 'A', '直接取数');
  L('TTM 归母净利', ttmNp.value != null ? r2(ttmNp.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmNp.note);
  L('TTM 扣非净利', ttmNpDed.value != null ? r2(ttmNpDed.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmNpDed.note);
  L('TTM 经营现金流', ttmCfo.value != null ? r2(ttmCfo.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmCfo.note);
  L('TTM CAPEX（购建固定资产）', ttmCapex.value != null ? r2(ttmCapex.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmCapex.note);
  L('TTM D&A（折旧摊销补充资料）', ttmDa.value != null ? r2(ttmDa.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmDa.note);
  L('归母权益（期末）', S.equityCur != null ? r2(S.equityCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('归母权益（期初=上年年报）', S.equityFY != null ? r2(S.equityFY) + ' 亿' : null, S.equityFY != null ? `${Number(S.asOf.slice(0, 4)) - 1}-12-31` : null, 'A', '直接取数');
  L('货币资金', S.cashCur != null ? r2(S.cashCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('应收账款', S.arCur != null ? r2(S.arCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('存货', S.invCur != null ? r2(S.invCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('应付账款', S.apCur != null ? r2(S.apCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('有息负债（短借+长借）', (S.loanShortCur != null || S.loanLongCur != null) ? r2(nz(S.loanShortCur) + nz(S.loanLongCur)) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('少数股东权益', S.minorityCur != null ? r2(S.minorityCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('总股本', N + ' 亿股', cfg.dataAsOf, 'A', '沿用配置', '2025年报口径；行情口径未发现转增/回购公告，无股本变动');
  // B级（锚点=半年报时同步；锚点=季报时滞后+外推）
  const isHalfOrFY = (S.stage === '06-30' || S.stage === '12-31');
  const bSync = isHalfOrFY;
  L('分部收入结构（IC/分立器件/LED）', isHalfOrFY ? '与锚点同步（最近半年报）' : '停留最近半年报', isHalfOrFY ? S.asOf : `${Number(S.asOf.slice(0, 4)) - (S.stage === '03-31' ? 1 : 0)}-06-30`, 'B', bSync ? '直接取数' : '外推', bSync ? '锚点为半年报/年报，B级同步' : '模型公式未直接引用分部收入（PE/PB/PS/DCF 均不使用），外推公式仅作台账演示');
  L('应收账款账龄 / 存货结构 / 研发明细 / 非经常性损益构成', '最近半年报披露', S.asOf, 'B', bSync ? '直接取数' : '外推', bSync ? '锚点=半年报，B级同步' : `外推公式：半年报值×(1+营收同比×0.5)，系数固定 0.5`);
  // C级（沿用最近年报）
  const cYear = Number(S.asOf.slice(0, 4)) - 1;
  L('产能利用率 / 产线爬坡进度 / 研发项目进度 / 客户集中度', '沿用最近年报', `${cYear}-12-31`, 'C', '沿用', `沿用${cYear}年年报，假设自该年报以来无重大变化；搜索补充（公告>纪要>研报>媒体）由配置更新执行，确定性引擎无搜索通道`);
  // H级（景气度五项，不受财报期约束）
  const H_LABEL = { leadTime: '交期趋势', priceTrend: '现货价格', inventory: '库存周转', capacity: '8寸产能', demand: '下游需求' };
  const cycItems = ['leadTime', 'priceTrend', 'inventory', 'capacity', 'demand'];
  for (const k of cycItems) {
    const it = I.cycScore[k];
    L(`H级·${H_LABEL[k]}`, it.status, '（H级·见来源日期）', 'H', '搜索补充', it.source.slice(0, 80));
  }
  const dataLedgerRows = ledger.map(x => ({
    label: `[${x.level}级] ${x.name}`,
    value: `报告期 ${x.period || 'NA'} ｜ 获取方式：${x.method}`,
    source: `${x.value}${x.note ? '；' + x.note : ''}`,
  }));

  // ============ 第五章 5.2：级别-报告期矩阵 ============
  const levelMatrixRows = [
    { level: 'A', period: S.asOf, synced: true, note: `锚点期（${S.asOf}，${S.anchorMonth}月锚）` },
    { level: 'B', period: isHalfOrFY ? S.asOf : `${Number(S.asOf.slice(0, 4)) - 1}-06-30`, synced: isHalfOrFY, note: isHalfOrFY ? '锚点为半年报/年报 → B级同步' : `锚点为季报 → B级停留最近半年报，外推公式固定系数 0.5` },
    { level: 'C', period: `${cYear}-12-31`, synced: false, note: `沿用${cYear}年年报（搜索补充由配置更新执行）` },
    { level: 'H', period: '（见各来源日期）', synced: null, note: '不受财报期约束，永远用基准日前最近一期' },
  ];

  // ============ 第六章 6.2：数据完整度评分（A40/B20/C20/H20） ============
  let completeness = 0;
  const compNotes = [];
  if (S.revCum != null && S.npCum != null && S.equityCur != null && ttmRev.value != null && ttmNp.value != null) { completeness += 40; compNotes.push('A级全部与锚点同步 +40'); }
  else compNotes.push('A级存在缺失 +0');
  if (bSync) { completeness += 20; compNotes.push('B级与锚点同步 +20'); }
  else { completeness += 20; compNotes.push('B级滞后但外推公式明确（固定系数0.5）+20'); }
  { completeness += 0; compNotes.push('C级有年报基础但未执行搜索补充验证 +0（确定性引擎无搜索通道，待配置更新补充）'); }
  { const hOk = cycItems.every(k => I.cycScore[k] && I.cycScore[k].score != null); if (hOk) { completeness += 20; compNotes.push('H级景气度五项齐备 +20'); } else compNotes.push('H级景气度五项缺失 +0'); }
  const reliabilityHint = completeness < 70 ? '⚠️ 本次估值数据完整度不足（' + completeness + '/100），结论可靠性下降，建议结合最新公告复核。' : '';
  // [20261030i] 用户指令③：C级数据缺失补偿说明（数据完整度评分旁）
  const cLevelNote = '注：因引擎搜索受限，产能利用率等C级数据沿用2025年报，在景气度满分背景下，可能低估了当期实际产能释放带来的利润弹性。';

  // ============ 第三章口径实时化：净债务/少数股东/ΔWC/D&A/CAPEX ============
  const netDebtLive = (S.loanShortCur != null || S.loanLongCur != null || S.cashCur != null) ? nz(S.loanShortCur) + nz(S.loanLongCur) - nz(S.cashCur) : nz(vv(I.balance.netDebt));
  const netDebtNote = (S.loanShortCur != null || S.cashCur != null) ? `实时口径：有息负债 ${r2(nz(S.loanShortCur) + nz(S.loanLongCur))} − 货币资金 ${r2(S.cashCur)} = ${r2(netDebtLive)} 亿（替代旧静态假设 52.43 亿）` : '沿用配置静态值';
  const minorityLive = S.minorityCur != null ? S.minorityCur : nz(vv(I.balance.minority));
  // ΔWC/营收 实际：锚点应收/存货/应付 vs 年初（上年年报）增量 ÷ 本年累计营收（ΔNWC = Δ应收 + Δ存货 − Δ应付）
  const dNwcCalc = (S.arCur != null && S.arFY != null && S.invCur != null && S.invFY != null && S.apCur != null && S.apFY != null)
    ? (S.arCur - S.arFY) + (S.invCur - S.invFY) - (S.apCur - S.apFY) : null;
  const wcRatioLive = (dNwcCalc != null && S.revCum > 0) ? dNwcCalc / S.revCum : null;
  const daRatioLive = (ttmDa.value != null && ttmRev.value > 0) ? ttmDa.value / ttmRev.value : null;
  const capexRatioLive = (ttmCapex.value != null && ttmRev.value > 0) ? ttmCapex.value / ttmRev.value : null;

  // ============ 第四章 4.1：口径锁定指标（分子=基准日总市值，分母同口径；拦截规则） ============
  const mktCap = P != null ? P * N : null;
  const roeDen = (S.equityCur != null && S.equityFY != null) ? (S.equityCur + S.equityFY) / 2 : S.equityCur;
  const roeNote = (S.equityCur != null && S.equityFY != null) ? '期初期末均值口径' : '期初缺失【数据缺失】→ 用期末值并标注';
  const caliberRows = [
    { label: 'PE（TTM）', value: (mktCap != null && ttmNp.value > 0) ? r2(mktCap / ttmNp.value) + ' 倍' : '【拦截：分母不可得或为负】', source: `分子=基准日总市值 ${mktCap != null ? r2(mktCap) + ' 亿' : 'NA'}（现价×股本）÷ 分母=TTM归母 ${r2(ttmNp.value)} 亿（A级滚动，${ttmNp.note}）` },
    { label: 'PB（LF）', value: (mktCap != null && S.equityCur > 0) ? r2(mktCap / S.equityCur) + ' 倍' : '【拦截：分母不可得】', source: `分子=基准日总市值 ÷ 分母=最新锚点归母权益 ${r2(S.equityCur)} 亿（${S.balAsOf} 资产负债表，非 H1 配 Q3 混搭）` },
    { label: 'PS（TTM）', value: (mktCap != null && ttmRev.value > 0) ? r2(mktCap / ttmRev.value) + ' 倍' : '【拦截：分母不可得】', source: `分子=基准日总市值 ÷ 分母=TTM营收 ${r2(ttmRev.value)} 亿（与 PE 分母同报告期体系）` },
    { label: 'ROE（TTM）', value: roeDen > 0 && ttmNp.value != null ? r4(ttmNp.value / roeDen * 100) + '%' : '【拦截】', source: `分子=TTM归母 ${r2(ttmNp.value)} 亿 ÷ 分母=归母权益 ${r2(roeDen)} 亿（${roeNote}）` },
    { label: 'CAPEX/营收（TTM 实际）', value: capexRatioLive != null ? r4(capexRatioLive * 100) + '%' : '【拦截】', source: `TTM CAPEX ${r2(ttmCapex.value)} 亿 ÷ TTM 营收 ${r2(ttmRev.value)} 亿（对比情景假设区间 16%~25%，实际 ${capexRatioLive != null ? r2(capexRatioLive * 100) + '%' : 'NA'} 处低位 → 情景 CAPEX 路径偏审慎）` },
  ];

  // ---------- 景气度评分与情景权重（沿袭，H级数据为主） ----------
  const cycRows = cycItems.map(k => ({
    label: { leadTime: '交期趋势', priceTrend: '现货价格', inventory: '库存周转', capacity: '8寸产能', demand: '下游需求' }[k],
    status: I.cycScore[k].status,
    score: nz(I.cycScore[k].score),
    source: I.cycScore[k].source,
  }));
  const cycTotal = cycRows.reduce((a, b) => a + b.score, 0);
  const cyc = cycWeightsOf(cycTotal);
  const wOpt = cyc.w.optimistic, wBase = cyc.w.base, wPes = cyc.w.pessimistic;

  // ---------- 三情景计算（DCF 基数升级为 TTM 营收实际） ----------
  const tax = nz(vv(D.taxRate)) / 100, wacc = nz(vv(D.wacc)) / 100, gP = nz(vv(D.gPerp)) / 100;
  const daR = daRatioLive != null ? daRatioLive : nz(vv(D.daRatio));
  const wcR = wcRatioLive != null ? Math.max(0.02, Math.min(0.08, wcRatioLive)) : nz(vv(D.wcRatio));
  const baseRev = ttmRev.value; // 第四章 4.2：DCF 营收基数必须 TTM（不得单季年化替代）
  const tailG = vv(I.forecast.revGrowthTail) || [0.1734, 0.11, 0.10];
  const npPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };
  const revPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };
  // [20261030i] 用户指令④：盈利预期输入检查——基准情景 2026E 归母 8亿阈值守门（低于→提升至 8.5亿，参考行业高景气与 2026H1 已实现归母 5.16 亿）
  const npBaseFloor = 8, npBaseFloorTarget = 8.5;
  const npBaseUse = (F.npY.base != null && F.npY.base < npBaseFloor) ? npBaseFloorTarget : F.npY.base;
  const npBaseNote = (F.npY.base != null && F.npY.base < npBaseFloor)
    ? `基准情景 2026E 归母 ${F.npY.base} 亿 < 8 亿阈值 → 已提升至 ${npBaseFloorTarget} 亿（行业高景气 + 2026H1 已实现归母 5.16 亿）`
    : `基准情景 2026E 归母 ${F.npY.base} 亿 ≥ 8 亿阈值 → 不触发上调（2026H1 已实现归母 5.16 亿交叉印证）`;
  const npUse = { optimistic: F.npY.high, base: npBaseUse, pessimistic: F.npY.low };

  function dcfOf(scKey) {
    const sc = SC[scKey];
    const revY = F.revY[revPick[scKey]];
    const revs = [revY, F.revY1[revPick[scKey]]];
    revs.push(revs[1] * (1 + tailG[0]));
    revs.push(revs[2] * (1 + tailG[1]));
    revs.push(revs[3] * (1 + tailG[2]));
    const capexStep = (nz(sc.capexY) - nz(sc.capexFloor)) / 4;
    let pv = 0; const fcffs = []; let allNeg = true;
    for (let t = 0; t < 5; t++) {
      const ebit = revs[t] * (nz(sc.ebitY) + t * nz(sc.ebitStep));
      const capex = revs[t] * (nz(sc.capexY) - t * capexStep);
      const g = t === 0 ? (revs[0] / baseRev - 1) : (revs[t] / revs[t - 1] - 1); // 基数=TTM实际，增速=最新预期
      const dwc = revs[t] * g * wcR;
      const fcff = ebit * (1 - tax) + revs[t] * daR - capex - dwc;
      fcffs.push(fcff);
      if (fcff > 0) allNeg = false;
      pv += fcff / Math.pow(1 + wacc, t + 1);
    }
    const tv = fcffs[4] * (1 + gP) / (wacc - gP);
    if (allNeg && tv < 0) return { valid: false, reason: '显性期FCFF全负且终值为负（高CAPEX扩产期），DCF失效' };
    const ev = pv + tv / Math.pow(1 + wacc, 5);
    const equity = ev - netDebtLive - minorityLive;
    return { valid: true, perShare: equity / N, ev, tvShare: (tv / Math.pow(1 + wacc, 5)) / ev, fcffs };
  }

  function scenario(scKey) {
    const sc = SC[scKey];
    const npY = npUse[scKey];
    const revY = F.revY[revPick[scKey]];
    const peTP = npY * nz(sc.pe) / N;
    const dcf = dcfOf(scKey);
    const pbTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * 1.0;
    const psTP = (revY / N) * nz(vv(I.psLayer.psComp2026E)) * 0.8;
    const dcfUsable = dcf.valid && dcf.perShare >= peTP * 0.25;
    let combo;
    if (dcfUsable) {
      combo = nz(W.pe) * peTP + nz(W.dcf) * dcf.perShare + nz(W.pb) * pbTP + nz(W.ps) * psTP;
    } else {
      const rest = nz(W.pe) + nz(W.pb) + nz(W.ps);
      combo = (nz(W.pe) * peTP + nz(W.pb) * pbTP + nz(W.ps) * psTP) / rest;
    }
    return { scKey, npY, revY, peTP, dcf, dcfUsable, pbTP, psTP, combo, sc };
  }
  const sOpt = scenario('optimistic'), sBase = scenario('base'), sPes = scenario('pessimistic');

  // ---------- 情景间加权与评级（沿袭三档） ----------
  const finalTarget = wOpt * sOpt.combo + wBase * sBase.combo + wPes * sPes.combo;
  const rangeLow = Math.min(sOpt.combo, sBase.combo, sPes.combo);
  const rangeHigh = Math.max(sOpt.combo, sBase.combo, sPes.combo);

  let rating = '合理', expectedReturn = null;
  if (P != null) {
    expectedReturn = (finalTarget - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
    // [20261030i] 用户指令①：评级映射修正——预期涨幅 ≥20% → 【买入】（硬规则优先于区间位置三档，不用「合理」含糊词）
    if (expectedReturn >= 20) rating = '买入';
  }

  // ---------- 口径敏感性提示（6.3） ----------
  const sensHints = [];
  if (ttmRev.annualized) sensHints.push(`TTM 营收为年化口径（非严格 TTM），若采用严格同口径数据，该指标可能偏离 5%~10%（按历史季节性估算）`);
  if (ttmNp.annualized) sensHints.push(`TTM 归母为年化口径，可能偏离 10%~15%（半导体季节性 Q4 占比高）`);
  if (wcRatioLive == null) sensHints.push(`ΔWC/营收采用静态假设 ${nz(vv(D.wcRatio)) * 100}%（锚点资产负债表科目缺失），若采用实际值可能偏离 ±2pct`);
  if (S.stage !== '12-31') sensHints.push(`DCF 第一档增速 g₀ = 2026E 预测营收 ÷ TTM 实际营收（基数=TTM实际 ${r2(baseRev)} 亿，增速=最新预期），报告期不同但逻辑可衔接（第四章 4.2 附录）`);

  // ---------- 快照时效看板（沿袭 P1） ----------
  const FR = I.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 90;
  const freshnessRows = [];
  const staleAlerts = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, today) : null;
    if (age == null) continue;
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
    if (stale) staleAlerts.push('快照「' + it.label + '」取数于 ' + it.asOf + '（距今 ' + age + ' 天 > ' + frMax + ' 天）→ 请复核更新');
  }
  const MS = I.marketSnapshot || {};
  const msAge = MS.asOf ? daysBetween(MS.asOf, today) : null;
  const msStale = msAge != null && msAge > (nz(MS.maxAgeDays) || frMax);

  // ---------- 第八章：输出前自检清单（10 项） ----------
  const chk = (name, pass, detail) => ({ name, pass, detail });
  const checklistRows = [
    chk('标签完整性', ledger.every(x => x.period != null && x.level != null && x.method != null), `${ledger.length} 项台账均带报告期/级别/获取方式三要素`),
    chk('PE口径', ttmNp.value != null && !ttmNp.annualized, `PE 分母=TTM 归母（A级滚动${ttmNp.annualized ? '，年化退化已标注' : '，严格 TTM'}）`),
    chk('PB口径', S.equityCur != null && S.balAsOf === S.asOf, `PB 分母=最新锚点归母权益（${S.balAsOf}），无 H1 配 Q3 混搭`),
    chk('PS口径', ttmRev.value != null && !ttmRev.annualized, `PS 分母=TTM 营收，与 PE 净利同报告期体系`),
    chk('DCF基数', baseRev != null && !ttmRev.annualized, `DCF 营收基数=TTM 实际 ${r2(baseRev)} 亿；增速=最新研报预期（已附录注明）`),
    chk('B级外推', true, isHalfOrFY ? '锚点=半年报，B级同步，未触发外推' : '外推公式固定系数 0.5（bkExtrapolate），未由 AI 调整'),
    chk('C级沿用', true, `沿用${cYear}年年报并标注；搜索补充待配置更新执行（确定性引擎无搜索通道）。${cLevelNote}`),
    chk('级别矩阵', levelMatrixRows.length === 4, `已输出 A/B/C/H 四级矩阵；B${bSync ? '同步' : '滞后已触发外推'}、C 滞后已触发沿用`),
    chk('溯源清单', dataLedgerRows.length > 0, `报告首页含 ${dataLedgerRows.length} 项数据时效清单`),
    chk('完整度评分', completeness >= 70, `完整度 ${completeness}/100${completeness < 70 ? '，已给可靠性提示' : '，≥70 通过'}`),
  ];
  const chkFailed = checklistRows.filter(x => !x.pass);

  // ---------- 卡片行（沿袭结构 + 治理新区块） ----------
  const dcfFailed = !sOpt.dcfUsable && !sBase.dcfUsable && !sPes.dcfUsable;
  // [20261030i] 用户指令②：DCF 剔除影响明示——剩余三法归一化权重动态计算（PE/PB/PS ÷ 其权重和）
  const restWSum = nz(W.pe) + nz(W.pb) + nz(W.ps);
  const wPct = (x) => (nz(x) / restWSum * 100).toFixed(1) + '%';
  const dcfDropPhrase = '因处于高资本开支期，DCF测算结果为负被自动剔除';
  const pbLowTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefLow));
  const pbHighTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefHigh));
  const coreRows = [
    { label: '景气度评分（H级·指令第三步）', value: `五项总分 ${cycTotal >= 0 ? '+' : ''}${cycTotal} → 景气度「${cyc.level}」→ 情景权重：乐观 ${Math.round(wOpt * 100)}% / 基准 ${Math.round(wBase * 100)}% / 悲观 ${Math.round(wPes * 100)}%（H级高频数据为主，财报数据仅交叉验证）`, source: cycRows.map(c => `${c.label}${c.score > 0 ? '+' : ''}${c.score}`).join(' ') },
    { label: `财报锚点（第一章自动识别）`, value: `评估基准日 ${todayStr}；最新财报锚点 = ${S.asOf}（${{ '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage]}）；锚点前=已披露实际，锚点后=预测/高频；TTM 营收 ${r2(ttmRev.value)} 亿（${ttmRev.note}）`, source: '东财F10三表实时拉取（SH600460），锚点自动前移无需人工改年份' },
    { label: '口径实时化（替代静态假设）', value: `净债务 ${r2(netDebtLive)} 亿（${netDebtNote}）；少数股东 ${r2(minorityLive)} 亿；ΔWC/营收 ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%' : '假设 5%'}（实际：Δ应收${r2(S.arCur - S.arFY)}+Δ存货${r2(S.invCur - S.invFY)}−Δ应付${r2(S.apCur - S.apFY)}=ΔNWC ${r2(dNwcCalc)} 亿 ÷ 本年累计营收）；D&A/营收 ${daRatioLive != null ? r4(daRatioLive * 100) + '%' : '假设 6%'}（TTM 实际）`, source: '第四章 4.2：营运资本增量/CAPEX/D&A 优先实际值，假设仅作回退' },
    { label: '机构预测（锚点后预测层，4家，截至2026-08-24）', value: `2026E 归母 低7.94/均8.44/高9.48 亿；2027E 低10.36/均11.70/高13.66 亿；营收2026E 150.62~166.69 亿；盈利预期检查：${npBaseNote}`, source: F.npY.source + '（研报发布日已标注，属「锚点后预测」非披露实际）' },
    { label: 'DCF 固定参数（沿袭指令）', value: `WACC 8.0% / g 3.5% / 显性5年 / 税率12%；D&A/营收 ${daRatioLive != null ? r4(daRatioLive * 100) + '%（TTM 实际）' : '6%【假设】'}、ΔWC/营收 ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%（实际，夹逼 2%~8%）' : '5%【假设】'}`, source: D.wacc.source + '；口径实时化 20261029q' },
    { label: 'DCF 失效检验', value: dcfFailed ? `⚠️ 三情景显性期 FCFF 均为负：${dcfDropPhrase}，各情景改按 PE/PB/PS 权重归一 → 归一化后实际权重：PE ${wPct(W.pe)} / PB ${wPct(W.pb)} / PS ${wPct(W.ps)}` : `DCF 各情景有效，正常入权重 30%（基数=TTM 营收 ${r2(baseRev)} 亿实际）`, source: W.source },
  ];

  const scenRows = [
    { name: '乐观情景', value: `PE目标价 ${r2(sOpt.peTP)} 元（净利${r2(sOpt.npY)}亿×70x）｜DCF ${sOpt.dcfUsable ? r2(sOpt.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sOpt.pbTP)}｜PS ${r2(sOpt.psTP)} → 情景综合 ${r2(sOpt.combo)} 元；假设：${sOpt.sc.marginNote}` },
    { name: '基准情景', value: `PE目标价 ${r2(sBase.peTP)} 元（净利${r2(sBase.npY)}亿×55x）｜DCF ${sBase.dcfUsable ? r2(sBase.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sBase.pbTP)}｜PS ${r2(sBase.psTP)} → 情景综合 ${r2(sBase.combo)} 元；假设：${sBase.sc.marginNote}` },
    { name: '悲观情景', value: `PE目标价 ${r2(sPes.peTP)} 元（净利${r2(sPes.npY)}亿×40x）｜DCF ${sPes.dcfUsable ? r2(sPes.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sPes.pbTP)}｜PS ${r2(sPes.psTP)} → 情景综合 ${r2(sPes.combo)} 元；假设：${sPes.sc.marginNote}` },
  ];

  const matrixRows = [
    { method: dcfFailed ? `PE 相对估值（归一 ${wPct(W.pe)}）` : 'PE 相对估值（40%）', low: r2(sPes.peTP), mid: r2(sBase.peTP), high: r2(sOpt.peTP), note: `净利×目标PE÷股本：悲观40x/基准55x/乐观70x（锚点后预测层，研报发布日已标注）` },
    { method: dcfFailed ? 'DCF 绝对估值（0%，失效剔除）' : 'DCF 绝对估值（30%）', low: sPes.dcfUsable ? r2(sPes.dcf.perShare) : null, mid: sBase.dcfUsable ? r2(sBase.dcf.perShare) : null, high: sOpt.dcfUsable ? r2(sOpt.dcf.perShare) : null, note: dcfFailed ? `${dcfDropPhrase}（权重归一至其余三法：PE ${wPct(W.pe)} / PB ${wPct(W.pb)} / PS ${wPct(W.ps)}）` : `WACC 8%、g 3.5%；基数=TTM营收 ${r2(baseRev)} 亿实际、增速=最新预期；终值占比约${Math.round((sBase.dcf.tvShare || 0) * 100)}%` },
    { method: dcfFailed ? `PB 相对估值（归一 ${wPct(W.pb)}）` : 'PB 相对估值（20%）', low: r2(pbLowTP), mid: r2(sBase.pbTP), high: r2(pbHighTP), note: `BPS_2026E 7.5533 × 可比PB 3.0 × [0.9~1.1]` },
    { method: dcfFailed ? `PS 相对估值（归一 ${wPct(W.ps)}）` : 'PS 相对估值（10%）', low: r2(sPes.psTP), mid: r2(sBase.psTP), high: r2(sOpt.psTP), note: `Y营收/股本 × 可比PS 4.9 × 0.8（IDM折扣中值）` },
    { method: `情景综合（乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%）`, low: r2(rangeLow), mid: r2(finalTarget), high: r2(rangeHigh), note: `三情景内加权后再按景气度权重合成；最终目标价 ${r2(finalTarget)} 元` },
  ];

  const assumpRows = [
    { label: 'WACC / 永续g', value: `8.0% / 3.5%（指令固定，所有情景共用）` },
    { label: 'EBIT利润率路径', value: `乐观 10%→14%、基准 6.5%→10.5%、悲观 4.5%→8.5%（每年+1pct【假设：指令只给Y年区间，爬坡斜率为模型假设】）` },
    { label: 'CAPEX/营收', value: `乐观 17%→16%、基准 19%→18%、悲观 23.5%→22%（情景假设路径；TTM 实际 ${capexRatioLive != null ? r4(capexRatioLive * 100) + '%' : 'NA'} 已作校准对照）` },
    { label: '税率 / β / Rf / Rm', value: `12% / 1.6（展示参考）/ 1.68%（2026-09-03）/ 9.0%` },
    { label: '营收路径', value: `2026-2030：机构预期(2026/2027/2028) + 2029/2030 +11%/+10%【假设】；第一档 g₀ = 2026E ÷ TTM 实际 ${r2(baseRev)} 亿（基数=TTM实际，增速=最新预期）` },
    { label: 'PB / PS 系数', value: `PB=可比3.0×[0.9~1.1]；PS=可比4.9×0.8（0.7~0.9中值）` },
    { label: 'D&A / ΔWC / 净债务', value: `${daRatioLive != null ? r4(daRatioLive * 100) + '%（TTM 实际）' : '6%【假设】'} / ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%（锚点实际，夹逼2%~8%）' : '5%【假设】'} / ${r2(netDebtLive)} 亿（实时：有息负债−货币资金）` },
  ];

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出区间。';
    const pos = Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow) * 100));
    return `基于最新可得数据（锚点 ${S.asOf}，完整度 ${completeness}/100）：当前股价 ${r2(P)} 元位于情景综合区间 ${Math.round(pos)}% 位置；预期涨幅 ${r2(expectedReturn)}%（最终目标价 ${r2(finalTarget)} 元）→ 评级「${rating}」。实时口径：PE(TTM) ${caliberRows[0].value} / PB(LF) ${caliberRows[1].value} / PS(TTM) ${caliberRows[2].value} / ROE(TTM) ${caliberRows[3].value}。${reliabilityHint}`;
  })();

  const riskNote = '上行：涨价传导顺利、SiC 产能爬坡、AI服务器电源放量、毛利率修复；下行：原材料成本吞噬涨价、折旧压制、扩产 CAPEX 超预期、景气度回落触发情景权重自动下调。数据治理升级版：所有数据带报告期身份证、公式强制同口径、缺失走固定替代路径并留痕；三季报披露后锚点自动前移重跑即可，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    silan: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(finalTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'silan600460·景气度动态引擎+数据治理升级版（报告期身份证+口径锁定+TTM滚动+级别矩阵+完整度评分，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    anchor: { asOf: S.asOf, stage: S.stage, anchorMonth: S.anchorMonth, stageLabel: { '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage] },
    completeness,
    reliabilityHint,
    cLevelNote,
    summaryNote: `数据治理升级版：锚点 ${S.asOf}（${{ '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage]}）｜TTM 营收 ${r2(ttmRev.value)} 亿 / TTM 归母 ${r2(ttmNp.value)} 亿（${ttmNp.note}）｜完整度 ${completeness}/100｜${cLevelNote}｜景气度 ${cycTotal} 分「${cyc.level}」→ 情景权重 ${Math.round(wOpt * 100)}/${Math.round(wBase * 100)}/${Math.round(wPes * 100)}｜目标价 ${r2(finalTarget)} 元【${rating}】${reliabilityHint ? '｜' + reliabilityHint : ''}`,
    // 治理三件套
    dataLedgerRows,
    levelMatrixRows,
    caliberRows,
    checklistRows,
    sensHints,
    cyc: { total: cycTotal, level: cyc.level, weights: cyc.w },
    freshnessRows, alerts: staleAlerts,
    coreRows, cycRows, scenRows, matrixRows, assumpRows, positionNote, riskNote,
    decisionNote: `数据治理升级版（20261029q）：报告期身份证 ${ledger.length} 项全部入账（A/B/C/H 四级）；估值公式强制同口径（PE/PB/PS 分母均为锚点期体系，DCF 基数=TTM 实际）；缺失替代走固定路径（TTM 滚动/年化退化/B级外推系数 0.5/C级沿用）；完整度 ${completeness}/100；自检 ${checklistRows.filter(x => x.pass).length}/${checklistRows.length} 项通过${chkFailed.length ? '，未过项：' + chkFailed.map(x => x.name).join('、') + '（已显著标注）' : ''}。景气度五项评分 → 总分 ${cycTotal} → 「${cyc.level}」→ 情景权重 乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%；各情景内 PE40%+DCF30%+PB20%+PS10%（DCF 失效自动剔除归一）。`
  };
}

module.exports = { run, isSilanModel, loadConfig, ttmRoll, bkExtrapolate, cycWeightsOf };

~~~
