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
