/**
 * 全市场「基金行业配置」聚合模块
 * ==============================================================
 * 目标：把**大部分公募基金**（权益类，按母基金去重）最新报告期的**前十大重仓股**，
 *       按个股所属行业聚合，按**持仓市值（万元）**加总后排名，得到「基金行业配置名单」。
 *
 * 数据源（全部为东方财富公开接口，无需鉴权）：
 *   1) 基金全量列表   https://fund.eastmoney.com/js/fundcode_search.js
 *   2) 单只基金前十大重仓股（含 持仓市值 万元）
 *      https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=<code>&topline=10&year=<Y>&month=
 *   3) 个股 → 行业：resolveSectorIdentity（东财 F10/申万）；港股用 push2delay f127
 *
 * 关键设计（为什么这样写）：
 *   * **按母基金去重**：东财对同一只基金的 A/C 等份额报出**完全相同的持仓市值**
 *     （实测 021179 与 021180 每只重仓股市值逐位相同），说明市值是"母基金"口径。
 *     若按份额全爬会把同一笔持仓重复加总 N 倍（权益类 17920 份额 → 10126 母基金，43.5% 是重复）。
 *   * **磁盘缓存 + 可续跑**：全量约 1 万只基金，单次采集需十几分钟；数据是**季报**口径，
 *     一季度内不变。故落盘缓存，重跑时跳过已采集的，进程重启也能接着跑。
 *   * **低并发错峰**：fundf10 对同 IP 短时并发会限流（实测并发 6 时 120 请求失败 83 个；
 *     并发 4 + 间隔 80ms + 重试则 240 请求仅失败 1 个）。
 *
 * 更新频率（**自然季度**，不是「上次采集后 +90 天」）：
 *   报告期与自然季度严格对应，例如 2026Q2 报告 = 自然季度 Q2（4~6月）的持仓。
 *   进入新自然季度后（如 7/1 起盯 2026Q2 报告、10/1 起盯 2026Q3 报告），本模块每天检查一次
 *   东财「当前实际最新报告期」是否已开始发布；一旦开始发布，就**分批次**增量更新
 *   （每天一批，受时间预算约束），直到全部母基金都更新到本季度为止，然后本季度结束。
 *   现实中各基金披露日期不同（大公司先、小公司后，季报在季末后 15 个工作日内），
 *   所以「每天一批、未出的次日再探」天然对应真实披露节奏。
 *
 * 产物文件（data/fund_holdings/）：
 *   universe.json  基金宇宙（权益类母基金列表）
 *   holdings.json  每只母基金最新报告期前十大重仓股（+ 上一报告期，供环比）
 *   progress.json  采集进度（阶段/完成数/失败清单/速率/ETA）
 *   quarter.json   自然季度账本（目标报告期/是否已发布/是否完成/每日执行记录）
 *   ../stock_industry_cache.json  个股→行业 磁盘缓存（90 天，**与更新频率无关**）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveSectorIdentity } = require('./sectorIdentity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, '..', 'data', 'fund_holdings');
const F_UNIVERSE = path.join(DATA_DIR, 'universe.json');
const F_HOLDINGS = path.join(DATA_DIR, 'holdings.json');
const F_PROGRESS = path.join(DATA_DIR, 'progress.json');
const F_QUARTER = path.join(DATA_DIR, 'quarter.json');
const F_IND = path.join(__dirname, '..', 'data', 'stock_industry_cache.json');

const UNIVERSE_TTL = 7 * 24 * 3600 * 1000;    // 基金列表 7 天
const INDUSTRY_TTL = 90 * 24 * 3600 * 1000;   // 个股行业 90 天（行业归属极少变动；仅影响「是否重解析行业」，与季度更新无关）

// 权益类口径：有股票持仓的基金；剔除债券/货币/理财/REITs/商品（无股票十大重仓）
const RE_EQUITY = /股票|混合|指数|QDII/;
const RE_EXCLUDE = /债券|货币|Reits|REITs|FOF|商品|理财|其他|^$/i;

const CONC = 3;        // 持仓采集并发
const IND_CONC = 2;    // 个股→行业 解析并发（与持仓采集并行，不额外抬高单点压力）
const GAP_MS = 80;     // 每次请求之间的错峰间隔
const RETRY = 3;       // 单只基金重试次数
const SAVE_EVERY = 250;                       // 每处理 N 只落盘一次
const SAVE_MS = 60 * 1000;                    // 另外按时间兜底落盘（最多丢 60 秒进度）

// —— 自然季度更新调度参数 ——
const DAILY_HOUR = 19;                        // 每日检查时刻（收盘后）；启动时若当天未跑过则忽略该时刻补跑
const DAILY_BATCH = 2500;                     // 单日单轮最多处理的基金数（分批推进）
const DAILY_BUDGET_MS = 20 * 60 * 1000;       // 单日单轮时间预算，到点即暂停、次日继续
// 披露宽限期（自自然季度开始日起算）：超过该天数仍有基金未出报告期，则记为「滞后」并不再阻塞「本季完成」。
// 依据公募基金信息披露规则：季报=季末后 15 个工作日内；半年报(Q2 持仓)=上半年结束后 60 日内；
// 年报(Q4 持仓)=年度结束后 90 日内。留足缓冲，避免每天无限重试迟报基金。
const GRACE_DAYS_BY_Q = { 1: 40, 2: 70, 3: 40, 4: 100 };

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _num = (s) => parseFloat(String(s).replace(/,/g, ''));
const _stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function _ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ } }
function _loadJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function _saveJson(file, obj) {
  try {
    _ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { console.error('[FundMatrix] 写盘失败', file, e.message); }
}

/** 母基金名：去掉尾部份额字母与括号后缀（A/C/E/I/O/后端/美元/人民币/发起式…） */
function baseFundName(n) {
  let s = String(n || '').trim();
  s = s.replace(/[（(][^)）]*[)）]\s*$/g, '');
  s = s.replace(/\s+/g, '');
  for (let i = 0; i < 3; i++) s = s.replace(/[A-Za-z]{1,3}$/, '');
  return s;
}

// ---------- 1) 基金宇宙（权益类，按母基金去重） ----------
async function getFundUniverse(opts = {}) {
  const cached = _loadJson(F_UNIVERSE, null);
  if (!opts.force && cached && cached.list && cached.list.length && (Date.now() - (cached.ts || 0) < UNIVERSE_TTL)) {
    return cached;
  }
  const r = await axios.get('https://fund.eastmoney.com/js/fundcode_search.js', {
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
    timeout: 30000, responseType: 'text',
  });
  const m = String(r.data).match(/\[\s*\[[\s\S]*?\]\s*\]/);
  if (!m) throw new Error('基金列表解析失败');
  const arr = JSON.parse(m[0]);
  const seen = new Set();
  const list = [];
  let shareClasses = 0;
  for (const x of arr) {
    const type = x[3] || '';
    if (!RE_EQUITY.test(type) || RE_EXCLUDE.test(type)) continue;
    shareClasses++;
    const base = baseFundName(x[2]);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    list.push({ code: x[0], name: x[2], base, type });
  }
  const out = { ts: Date.now(), total: arr.length, shareClasses, list };
  _saveJson(F_UNIVERSE, out);
  console.log(`[FundMatrix] 基金宇宙：全量 ${arr.length} → 权益类份额 ${shareClasses} → 母基金 ${list.length}`);
  return out;
}

// ---------- 2) 单只基金前十大重仓股（一次请求返回最近两个季度）----------
// 报告期排序键：'2026年2季度' → 20262（用于比较/取最新两个季度）
function _qKey(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  return m ? parseInt(m[1], 10) * 10 + parseInt(m[2], 10) : -1;
}
function _qLabel(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  return m ? `${m[1]}Q${m[2]}` : String(q || '');
}
/** 紧邻的上一报告期：'2026年2季度' → '2026年1季度'；'2026年1季度' → '2025年4季度' */
function _prevQuarterOf(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  if (!m) return '';
  let y = parseInt(m[1], 10), n = parseInt(m[2], 10) - 1;
  if (n < 1) { n = 4; y -= 1; }
  return `${y}年${n}季度`;
}

// ---------- 2.5) 自然季度：目标报告期 + 季度账本 ----------
function _dateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 自然季度 → 应当采集的报告期。
 * 报告期与自然季度一一对应：进入新自然季度后，盯的是「上一个已结束的自然季度」的报告。
 *   1/1 ~ 3/31  → 上一年 4 季度报告
 *   4/1 ~ 6/30  → 当年   1 季度报告
 *   7/1 ~ 9/30  → 当年   2 季度报告
 *  10/1 ~12/31  → 当年   3 季度报告
 * 注意：报告披露有滞后（季报在季末后 15 个工作日内），所以「是否真的可以采」由
 * detectLatestPeriod() 探测东财实际返回的最新报告期来决定，本函数只负责给出**目标**。
 */
function naturalQuarterTarget(d = new Date()) {
  const y = d.getFullYear();
  const nq = Math.floor(d.getMonth() / 3) + 1;      // 当前所在自然季度 1~4
  let yr = y, q = nq - 1;
  if (q < 1) { q = 4; yr = y - 1; }
  return {
    period: `${yr}年${q}季度`,
    key: yr * 10 + q,
    label: `${yr}Q${q}`,
    naturalQuarter: `${y}Q${nq}`,
    naturalQuarterLabel: `${y} 年第 ${nq} 季度`,
    windowStart: `${y}-${String((nq - 1) * 3 + 1).padStart(2, '0')}-01`,
  };
}

/** 下一次「每日检查」的时刻（用于前端展示） */
function _nextDailyCheckAt() {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAILY_HOUR, 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/**
 * 该基金相对目标报告期是否还需要继续处理（拉取/重试）。
 * 判据必须与「本季完成」的统计口径完全一致，否则会出现 remaining 永远不归零、
 * 每天白跑一批的死循环（**历史踩坑**）。
 *  - 对 2026Q2 这种「季报」达标即可；核对标记 ck 记录「该条数据是冲着哪个报告期抓的」。
 *  - 旧缓存没有 ck → 以其自身报告期为标记（等价于「上次就是冲那一期抓的」）。
 */
function _needsWork(e, targetKey) {
  if (!e || !('q' in e)) return true;                          // 从未采集 / 旧格式
  const ck = (e.ck == null) ? _qKey(e.q) : e.ck;
  if (ck !== targetKey) return true;                           // 还没针对本目标期核对过
  if (!e.q) return false;                                      // 已核对本目标期，确认无持仓 → 完结
  return _qKey(e.q) < targetKey;                               // 仍落后 → 继续重试（直到披露或宽限期结束）
}

/** 本自然季度的披露宽限期（天） */
function _graceDays(t) {
  const m = String((t && t.period) || '').match(/(\d)季度/);
  return (m && GRACE_DAYS_BY_Q[parseInt(m[1], 10)]) || 45;
}

/**
 * 统计相对本自然季度目标期的更新情况。
 *  remaining 只统计「宽限期内、仍待处理」的基金；超过宽限期仍滞后的记入 lagged 且不阻塞「完成」。
 */
function _countQuarter(list, H, targetKey) {
  const t = naturalQuarterTarget();
  const daysIn = Math.floor((Date.now() - new Date(t.windowStart + 'T00:00:00').getTime()) / 86400000);
  const grace = _graceDays(t);
  const graceOver = daysIn > grace;
  let remaining = 0, updatedTo = 0, lagged = 0;
  for (const f of list) {
    const e = H[f.code];
    if (e && e.q && _qKey(e.q) >= targetKey) { updatedTo++; continue; }
    if (!_needsWork(e, targetKey)) continue;                   // 已核对且确认无持仓 → 完结
    if (graceOver) { lagged++; continue; }                     // 宽限期已过 → 记为滞后
    remaining++;
  }
  return { remaining, updatedTo, lagged, daysIn, grace, graceOver };
}

let _ledger = null;
function _lg() { if (!_ledger) _ledger = _loadJson(F_QUARTER, null) || {}; return _ledger; }
function _saveLedger() { if (_ledger) _saveJson(F_QUARTER, _ledger); }

/** 新建/重置某自然季度的账本。保留 holdings 作为数据基础（新报告期靠重采覆盖）。 */
function _newLedger(t) {
  _ledger = {
    target: t.period, targetKey: t.key, label: t.label,
    naturalQuarter: t.naturalQuarter, windowStart: t.windowStart,
    published: false,            // 东财是否已开始发布该报告期
    done: false,                 // 本季度是否已全部更新完成
    createdAt: Date.now(), startedAt: 0, finishedAt: 0,
    lastProbeDate: '', lastProbePeriod: '',
    lastRunDate: '', batchRuns: 0,
    remaining: -1, updatedTo: 0,
  };
  _saveLedger();
  return _ledger;
}

/** 账本 → 前端可见的季度状态 */
function getQuarterStatus() {
  const t = naturalQuarterTarget();
  const L = _lg();
  const stale = !L || L.target !== t.period;          // 是否已跨入新自然季度（尚未重置账本）
  // 宽限期相关字段：账本尚未写入时按实时计算，避免显示 0
  const graceLive = _graceDays(t);
  const daysInLive = Math.max(0, Math.floor((Date.now() - new Date(t.windowStart + 'T00:00:00').getTime()) / 86400000));
  return {
    naturalQuarter: t.naturalQuarter,
    naturalQuarterLabel: t.naturalQuarterLabel,
    windowStart: t.windowStart,
    target: t.period,
    targetLabel: t.label,
    targetKey: t.key,
    inWindow: !stale,
    published: !stale && !!L.published,
    done: !stale && !!L.done,
    lastProbeDate: stale ? '' : (L.lastProbeDate || ''),
    lastProbePeriod: stale ? '' : (L.lastProbePeriod || ''),
    lastProbeLabel: stale ? '' : _qLabel(L.lastProbePeriod || ''),
    lastRunDate: stale ? '' : (L.lastRunDate || ''),
    batchRuns: stale ? 0 : (L.batchRuns || 0),
    remaining: stale ? -1 : (L.remaining == null ? -1 : L.remaining),
    updatedTo: stale ? 0 : (L.updatedTo || 0),
    lagged: stale ? 0 : (L.lagged || 0),
    daysIn: stale ? daysInLive : (L.daysIn || daysInLive),
    grace: stale ? graceLive : (L.grace || graceLive),
    graceOver: stale ? (daysInLive > graceLive) : (L.graceOver == null ? (daysInLive > graceLive) : !!L.graceOver),
    startedAt: stale ? 0 : (L.startedAt || 0),
    finishedAt: stale ? 0 : (L.finishedAt || 0),
    dailyHour: DAILY_HOUR,
    dailyBatch: DAILY_BATCH,
    nextCheckAt: _nextDailyCheckAt(),
  };
}

function _parseQuarterBox(box) {
  const qm = box.match(/(\d{4}年\d季度)股票投资明细/);
  const quarter = qm ? qm[1] : '';
  const rows = [];
  for (const tr of box.split('<tr>').slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => _stripTags(x[1]));
    if (cells.length < 4) continue;
    const ci = cells.findIndex((c) => /^\d{6}$/.test(c) || /^\d{5}$/.test(c));
    if (ci < 0) continue;
    const name = cells[ci + 1] || '';
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(name)) continue;
    // 列序：序号|代码|名称|最新价|涨跌幅|相关资讯|占净值比例|持股数(万股)|持仓市值(万元)
    const pi = cells.findIndex((c, i) => i > ci && /^\d+(\.\d+)?%$/.test(c));
    let shares = null, value = null;
    if (pi >= 0) {
      const nums = cells.slice(pi + 1).filter((c) => /^[\d,]+(\.\d+)?$/.test(c)).map(_num).filter(Number.isFinite);
      if (nums.length) shares = nums[0];
      if (nums.length > 1) value = nums[1];
    }
    rows.push({ code: cells[ci], name, weight: pi >= 0 ? _num(cells[pi]) : null, shares, value });
  }
  return { quarter, rows };
}

// 解析出页面内**全部季度**（东财一次返回最近两季），按报告期倒序
function _parseHoldingsHtml(html) {
  const m = String(html || '').match(/content:"([\s\S]*?)",arryear/);
  if (!m) return null;
  const boxes = m[1].split("<div class='boxitem").slice(1);
  if (!boxes.length) return null;
  const quarters = boxes.map(_parseQuarterBox).filter((q) => q.quarter && q.rows.length);
  if (!quarters.length) return null;
  quarters.sort((a, b) => _qKey(b.quarter) - _qKey(a.quarter));
  return { quarters };
}

async function _fetchHoldings(code, year) {
  const r = await axios.get(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=`, {
    headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
    timeout: 12000, responseType: 'text',
  });
  return _parseHoldingsHtml(r.data);
}

// 探测「东财当前实际最新报告期」：用几只大基金试抓，取最大报告期。
// 用途：① 每日「更新情况」检查——判断目标报告期是否已开始披露；② 展示用实际最新期。
// 传入 targetPeriod 时，一旦确认已到/超过目标期就立即返回（通常只花 1 次请求）。
const _PERIOD_PROBES = ['000001', '110011', '002910', '013840', '161725', '519674'];
async function detectLatestPeriod(targetPeriod) {
  const tk = _qKey(targetPeriod || '');
  const year = new Date().getFullYear();
  let best = '';
  for (const code of _PERIOD_PROBES) {
    for (const y of [year, year - 1]) {
      try {
        const p = await _fetchHoldings(code, y);
        const q = p && p.quarters && p.quarters[0] && p.quarters[0].quarter;
        if (q && _qKey(q) > _qKey(best)) best = q;
        // 已确认目标期（或更新）已发布 → 提前结束，省请求
        if (tk >= 0 && best && _qKey(best) >= tk) return best;
      } catch (e) { /* 忽略单只探测失败 */ }
      if (best && _qKey(best) >= _qKey(`${year}年4季度`)) break;
    }
    if (_qKey(best) > _qKey(`${year}年1季度`)) break;
  }
  return best;
}

// ---------- 3) 个股 → 行业（磁盘缓存） ----------
const INDUSTRY_MISS_TTL = 7 * 24 * 3600 * 1000;   // 「查不到」的短 TTL：避免每轮都重试无解标的（如部分港股）
let _indDisk = null;
function _indStore() { if (!_indDisk) _indDisk = _loadJson(F_IND, {}); return _indDisk; }
let _indDirty = 0;
function _indCacheSet(code, v) {
  const st = _indStore();
  st[code] = { v: v || '', ts: Date.now() };
  if (++_indDirty % 200 === 0) _saveJson(F_IND, st);
}
/** 该 code 是否已在缓存中「有结论」（可能是行业名，也可能是明确的查不到） */
function _indCacheResolved(code) {
  const hit = _indStore()[code];
  if (!hit) return false;
  return (Date.now() - hit.ts) < (hit.v ? INDUSTRY_TTL : INDUSTRY_MISS_TTL);
}
function _indCacheGet(code) {
  const st = _indStore(); const hit = st[code];
  if (hit && hit.v && Date.now() - hit.ts < INDUSTRY_TTL) return hit.v;
  return '';
}

async function _lookupHkIndustry(code) {
  try {
    const r = await axios.get(`https://push2delay.eastmoney.com/api/qt/stock/get?secid=116.${code}&fields=f57,f58,f127`, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 10000, responseType: 'text',
    });
    const j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const v = j && j.data && j.data.f127;
    return (v && v !== '-' && v !== '') ? String(v).trim() : '';
  } catch (e) { return ''; }
}

async function lookupIndustry(code, name) {
  if (_indCacheResolved(code)) return _indCacheGet(code);
  let v = '';
  try {
    if (/^\d{5}$/.test(String(code || ''))) {
      v = await _lookupHkIndustry(code);   // 港股：A 股映射不适用
    }
    if (!v) {
      const id = await Promise.race([
        resolveSectorIdentity(code, name || '').catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 15000)),
      ]);
      // 只认 identity.industry（东财行业名）；绝不接受股票名回显作为行业名
      if (id && id.ok && id.industry && id.industry !== '未知') v = id.industry;
    }
  } catch (e) { /* 保持空 */ }
  // ⚠️ 无论成功与否都落缓存：否则「查不到的标的」每轮都会被重新入队并各耗最多 15s（历史踩坑）
  _indCacheSet(code, v);
  return v;
}

// ---------- 4) 后台采集（可续跑） ----------
const state = {
  running: false,
  phase: '',            // 'universe' | 'holdings' | 'industry' | 'batch' | 'done' | 'stopped' | 'error'
  period: '',           // 最新报告期（如 2026年2季度）
  prevPeriod: '',       // 上一报告期（环比基准）
  total: 0, done: 0, failed: 0, ok: 0, withPrev: 0,
  indTotal: 0, indDone: 0, indUnresolved: 0,
  remaining: -1,        // 相对目标报告期仍待处理的基金数（-1 = 未知）
  updatedTo: 0,         // 已更新到目标报告期的基金数
  lagged: 0,            // 超过披露宽限期仍滞后的基金数
  graceOver: false,     // 是否已过披露宽限期
  budgetPaused: false,  // 是否因「单日时间预算」到点而暂停（次日继续）
  failedCodes: [],
  startedAt: 0, finishedAt: 0, lastTickAt: 0,
  rate: 0, etaSec: null, lastError: '',
};

let _stop = false;
let _holdings = null;
function _h() { if (!_holdings) _holdings = _loadJson(F_HOLDINGS, {}); return _holdings; }
function _persistProgress() {
  _saveJson(F_PROGRESS, {
    period: state.period, prevPeriod: state.prevPeriod, phase: state.phase,
    total: state.total, done: state.done, ok: state.ok, failed: state.failed, withPrev: state.withPrev,
    remaining: state.remaining, updatedTo: state.updatedTo,
    failedCodes: state.failedCodes.slice(-5000),
    startedAt: state.startedAt, finishedAt: state.finishedAt, updatedAt: Date.now(),
  });
}

function _loadProgress() {
  const p = _loadJson(F_PROGRESS, null);
  if (p && p.period !== undefined) {
    state.period = p.period || ''; state.prevPeriod = p.prevPeriod || '';
    state.phase = p.phase || ''; state.total = p.total || 0;
    state.done = p.done || 0; state.ok = p.ok || 0; state.failed = p.failed || 0;
    state.withPrev = p.withPrev || 0;
    state.remaining = p.remaining == null ? -1 : p.remaining;
    state.updatedTo = p.updatedTo || 0;
    state.failedCodes = Array.isArray(p.failedCodes) ? p.failedCodes : [];
    state.startedAt = p.startedAt || 0; state.finishedAt = p.finishedAt || 0;
  }
}

/** 当前最新报告期猜测（用于按年抓取；季度标签以页面实际返回为准） */
function _guessYear() { return new Date().getFullYear(); }

async function _runCrawl(opts = {}) {
  const force = !!opts.force;
  const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10) || 0) : 0;
  const budgetMs = Math.max(0, parseInt(opts.budgetMs || 0, 10) || 0);
  if (state.running) return getCrawlStatus();
  state.running = true; _stop = false; state.budgetPaused = false;
  const t0 = Date.now();
  if (force) { state.done = 0; state.ok = 0; state.failed = 0; state.failedCodes = []; state.updatedTo = 0; state.remaining = -1; _persistProgress(); }
  try {
    // --- 阶段 1：基金宇宙 ---
    state.phase = 'universe'; state.lastTickAt = t0;
    state.startedAt = state.startedAt || t0;
    const uni = await getFundUniverse({ force: !!force });
    const list = uni.list;

    // --- 阶段 2：逐只抓前十大重仓股（并与「个股→行业」解析并行）---
    state.phase = 'holdings';
    state.total = list.length;
    const H = _h();
    // 需要采集的条件：本轮 force / 未采集过 / 未针对本目标期核对过 / 报告期仍落后于目标期。
    // 判据统一走 _needsWork（与「本季完成」统计口径一致，避免 remaining 永不归零）。
    const targetKey = _qKey(opts.targetPeriod || '');
    const graceOver = targetKey >= 0 ? _countQuarter(list, H, targetKey).graceOver : false;
    const pendingAll = list.filter((f) => {
      if (force) return true;
      const e = H[f.code];
      if (targetKey < 0) return !e || !('q' in e);              // 无目标期：只补「从未采集」的缺口
      if (!_needsWork(e, targetKey)) return false;
      // 宽限期已过 → 只做一遍「未核对过本目标期」的普查，不再反复重试迟报基金
      if (graceOver) {
        const ck = (e && e.ck != null) ? e.ck : (e ? _qKey(e.q) : -1);
        return ck !== targetKey;
      }
      return true;
    });
    // 分批：只处理前 limit 只；但进度分母用**未分批**的 pendingAll，否则「已完成」会虚报
    const pending = limit ? pendingAll.slice(0, limit) : pendingAll;
    state.done = list.length - pendingAll.length;
    state.ok = Object.keys(H).length;
    let saved = 0, holdingsFinished = false, runCount = 0, lastSaveAt = t0;
    const year = _guessYear();

    // 个股→行业：独立小队列 + 2 个并行 worker。
    // 目的：不要等 1 万只基金全采完才解析行业，否则采集过程中「未分类」会占大头、排名没法看。
    const indQueue = new Map();          // 待解析 code -> name
    const seenCodes = new Set();
    const enqueue = (rows) => {
      for (const h of (rows || [])) {
        if (!h || !h.code || seenCodes.has(h.code)) continue;
        seenCodes.add(h.code);
        state.indTotal++;
        if (_indCacheResolved(h.code)) state.indDone++;
        else indQueue.set(h.code, h.name);
      }
    };
    for (const fc of Object.keys(H)) enqueue(H[fc].holdings);   // 历史缓存里的个股也补解析
    state.indDone = state.indTotal - indQueue.size;

    const indWorkers = Array.from({ length: IND_CONC }, async () => {
      while (true) {
        if (indQueue.size === 0) {
          if (holdingsFinished || _stop) return;
          await sleep(200); continue;
        }
        const [c, n] = indQueue.entries().next().value;
        indQueue.delete(c);
        await lookupIndustry(c, n);
        state.indDone++;
        if (_indDirty > 0 && state.indDone % 200 === 0) _saveJson(F_IND, _indStore());
        await sleep(GAP_MS);
      }
    });

    let cur = 0;
    const workers = Array.from({ length: CONC }, async () => {
      while (!_stop) {
        // 单日时间预算到点 → 暂停本轮，剩余留到下一次（次日）继续
        if (budgetMs && Date.now() - t0 > budgetMs) {
          state.budgetPaused = true; _stop = true; return;
        }
        const i = cur++; if (i >= pending.length) return;
        const f = pending[i];
        let got = null, ok = false;
        for (let a = 0; a < RETRY && !ok; a++) {
          try {
            let p = await _fetchHoldings(f.code, year);
            if ((!p || !p.quarters || !p.quarters.length)) p = await _fetchHoldings(f.code, year - 1);
            if (p && p.quarters && p.quarters.length) {
              got = p; ok = true;
            } else if (a === RETRY - 1) {
              got = null; ok = true; // 明确无数据（非失败）
            } else { await sleep(400 * (a + 1)); }
          } catch (e) {
            if (a === RETRY - 1) { got = null; ok = false; }
            else await sleep(400 * (a + 1));
          }
        }
        if (got) {
          // 页面一次返回最近两个季度 → 同时留下「最新季」与「上一季」，供环比变化使用
          const latest = got.quarters[0];
          const prev = got.quarters[1] || null;
          H[f.code] = {
            name: f.name, base: f.base, type: f.type, fetched: true,
            q: latest.quarter, holdings: latest.rows,
            pq: prev ? prev.quarter : '', prevHoldings: prev ? prev.rows : [],
            // ck：该条数据是冲着哪个报告期抓的（本季完成判定的唯一依据）
            ck: targetKey >= 0 ? targetKey : _qKey(latest.quarter),
            checkedAt: Date.now(),
          };
          state.ok++;
          enqueue(latest.rows);
          // 报告期标签以页面实际返回为准，取**最大值**（避免被后面的旧期覆盖）
          if (latest.quarter && _qKey(latest.quarter) > _qKey(state.period)) state.period = latest.quarter;
          if (latest.quarter && targetKey >= 0 && _qKey(latest.quarter) >= targetKey) state.updatedTo++;
        } else if (ok) {
          const old = H[f.code];
          if (old && old.q) {
            // 本次没取到，但历史上拿到过 → **保留旧数据**，只更新核对标记（绝不降级/清空）
            old.ck = targetKey >= 0 ? targetKey : old.ck;
            old.checkedAt = Date.now();
          } else {
            // 确认无持仓：记 q='' 并打上核对标记，避免每轮重复重试（历史踩坑）
            H[f.code] = {
              name: f.name, base: f.base, type: f.type, fetched: true,
              q: '', holdings: [], pq: '', prevHoldings: [],
              ck: targetKey >= 0 ? targetKey : -1, checkedAt: Date.now(),
            };
          }
          state.failedCodes.push(f.code);
        } else {
          state.failed++; state.failedCodes.push(f.code);
        }
        state.done++;
        runCount++;
        // 双条件落盘：每 250 只，或距上次落盘超过 60 秒。
        // 后者用于兜底——限流导致速率降到 ~1 只/秒时，只靠 250 只触发会变成 4 分钟才存一次。
        if (++saved % SAVE_EVERY === 0 || Date.now() - lastSaveAt > SAVE_MS) {
          _saveJson(F_HOLDINGS, H); _persistProgress(); lastSaveAt = Date.now();
        }
        // 速率/ETA 必须用「本轮实际处理量」，用累计 done 会把续跑前的存量算进来（曾显示 374 只/秒）
        const el = (Date.now() - t0) / 1000;
        state.rate = runCount / Math.max(el, 1);
        const remain = (state.total - state.done) + Math.max(0, state.indTotal - state.indDone);
        state.etaSec = state.rate > 0 ? Math.round(remain / state.rate) : null;
        await sleep(GAP_MS);
      }
    });
    await Promise.all(workers);
    holdingsFinished = true;
    _saveJson(F_HOLDINGS, H);
    _persistProgress();
    // 无论本轮是否暂停/分批，都要把已入队的「个股→行业」解析完（否则未分类会残留）
    state.phase = 'industry';
    await Promise.all(indWorkers);
    _saveJson(F_IND, _indStore());
    state.indUnresolved = Math.max(0, state.indTotal - state.indDone);

    // 真实覆盖数（不能用 total 顶替，否则「已完成」会虚报）
    state.total = list.length;
    let covered = 0, withPrev = 0;
    for (const f of list) {
      const e = H[f.code];
      if (!e) continue;
      covered++;
      if (e.prevHoldings && e.prevHoldings.length) withPrev++;
    }
    state.done = covered;
    state.withPrev = withPrev;
    if (targetKey >= 0) {
      const k = _countQuarter(list, H, targetKey);
      state.updatedTo = k.updatedTo;
      state.remaining = k.remaining;
      state.lagged = k.lagged;
      state.graceOver = k.graceOver;
    }
    if (_stop) {
      state.phase = state.budgetPaused ? 'batch' : 'stopped';   // batch = 因单日预算暂停，次日继续
    } else {
      state.phase = 'done'; state.finishedAt = Date.now();
    }
    _persistProgress();
  } catch (e) {
    state.lastError = e.message;
    state.phase = 'error';
    console.error('[FundMatrix] 采集失败:', e.message);
  } finally {
    state.running = false;
    if (!state.startedAt) state.startedAt = t0;
    _persistProgress();
  }
  return getCrawlStatus();
}

function getCrawlStatus() {
  return {
    running: state.running, phase: state.phase, period: state.period, prevPeriod: state.prevPeriod,
    total: state.total, done: state.done, ok: state.ok, failed: state.failed, withPrev: state.withPrev,
    remaining: state.remaining, updatedTo: state.updatedTo, budgetPaused: state.budgetPaused,
    industry: { total: state.indTotal, done: state.indDone, unresolved: state.indUnresolved },
    rate: Math.round(state.rate * 10) / 10, etaSec: state.etaSec,
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    updatedAt: Date.now(), lastError: state.lastError,
  };
}

/**
 * 每日一次的自然季度检查 + 分批推进（**本模块的季度更新主入口**）。
 * 流程：
 *   1) 结算「当前自然季度 → 目标报告期」；跨季度则重置账本
 *   2) 账本已完成 → 跳过（0 请求）
 *   3) 今天已跑过 → 跳过（保证「每日一次」）
 *   4) 探测东财实际最新报告期：目标期尚未开始发布 → 今天只花几次探测请求就结束，明天再看
 *   5) 已开始发布 → 跑**一批**（受 DAILY_BATCH / DAILY_BUDGET_MS 约束），跑完更新账本；
 *      未全部完成则次日继续，直到 remaining=0 → 本季度完成
 * @returns {Promise<{ran:boolean, reason:string}>} 立即返回；批采集在后台继续
 */
async function runDailyUpdate(opts = {}) {
  _loadProgress();
  const force = !!opts.force;
  const t = naturalQuarterTarget();
  const today = _dateStr();
  let L = _lg();

  // 跨入新自然季度 → 重置账本（holdings 保留，新报告期靠重采逐只覆盖）
  if (!force && (!L || L.target !== t.period)) {
    L = _newLedger(t);
    console.log(`[FundMatrix] 进入自然季度 ${t.naturalQuarter} → 本季目标报告期 ${t.label}`);
  }
  L = _lg();

  const view = () => ({ quarter: getQuarterStatus(), status: getCrawlStatus() });

  if (L.done && !force) return { ran: false, reason: 'quarter-done', target: t.label, ...view() };
  if (state.running && !force) return { ran: false, reason: 'already-running', target: t.label, ...view() };
  if (L.lastRunDate === today && !force) return { ran: false, reason: 'already-ran-today', target: t.label, ...view() };
  // 每日执行时刻：定时器早于 DAILY_HOUR 不跑；启动补偿(ignoreHour)例外
  if (!force && !opts.ignoreHour && new Date().getHours() < DAILY_HOUR) {
    return { ran: false, reason: 'before-daily-hour', target: t.label, ...view() };
  }

  // 探测东财实际最新报告期（通常 1 次请求即返回）
  let latest = '';
  try { latest = await detectLatestPeriod(L.target); } catch (e) { /* 探测失败按未发布处理 */ }
  L.lastProbeDate = today; L.lastProbePeriod = latest || '';
  L.published = !!latest && _qKey(latest) >= L.targetKey;
  _saveLedger();

  if (!L.published) {
    L.lastRunDate = today;                 // 记为「今天已检查过」，避免一天内反复探测
    _saveLedger();
    console.log(`[FundMatrix] ${t.label} 报告尚未发布（东财最新 ${_qLabel(latest) || '未知'}），今日跳过`);
    return { ran: false, reason: 'not-published', target: t.label, detected: latest, detectedLabel: _qLabel(latest), ...view() };
  }

  L.batchRuns = (L.batchRuns || 0) + 1;
  if (!L.startedAt) L.startedAt = Date.now();
  _saveLedger();
  console.log(`[FundMatrix] ${t.label} 已开始发布 → 执行本日批次（上限 ${opts.batchSize || DAILY_BATCH} 只 / ${Math.round((opts.budgetMs || DAILY_BUDGET_MS) / 60000)} 分钟）`);

  const batchSize = Math.max(1, parseInt(opts.batchSize || DAILY_BATCH, 10) || DAILY_BATCH);
  const budgetMs = Math.max(1000, parseInt(opts.budgetMs || DAILY_BUDGET_MS, 10) || DAILY_BUDGET_MS);

  // 后台跑一批；跑完回落账本。调用方不等待（避免阻塞 HTTP 请求）
  const p = _runCrawl({ targetPeriod: L.target, limit: batchSize, budgetMs })
    .then(() => _finalizeLedger())
    .catch((e) => { console.error('[FundMatrix] 批次失败:', e.message); _finalizeLedger(); });
  if (opts.awaitBatch) await p;
  return { ran: true, target: t.label, batchSize, ...view() };
}

/** 一批跑完后回落账本：统计剩余 / 是否本季度完成 */
function _finalizeLedger() {
  const L = _lg();
  if (!L || !L.targetKey) return;
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const k = (uni && uni.list)
    ? _countQuarter(uni.list, H, L.targetKey)
    : { remaining: 0, updatedTo: 0, lagged: 0, daysIn: 0, grace: 0, graceOver: false };
  L.remaining = k.remaining;
  L.updatedTo = k.updatedTo;
  L.lagged = k.lagged;
  L.daysIn = k.daysIn;
  L.grace = k.grace;
  L.graceOver = k.graceOver;
  // 「今天已跑过」在**批次结束**时才记：这样中途重启/中断不会白等一天，会接着跑
  L.lastRunDate = _dateStr();
  if (k.remaining === 0) {
    L.done = true; L.finishedAt = Date.now();
    console.log(`[FundMatrix] ✅ 自然季度 ${L.label} 报告更新完成：已达标 ${k.updatedTo} 只`
      + (k.lagged ? `，滞后未披露 ${k.lagged} 只（已过 ${k.grace} 天宽限期）` : ''));
  } else {
    console.log(`[FundMatrix] ${L.label} 本次批次完成，剩余 ${k.remaining} 只待披露/待更新，次日继续`
      + (k.lagged ? `（另有滞后 ${k.lagged} 只）` : ''));
  }
  _saveLedger();
}

/** 冷启动采集完成后建立账本（把当前缓存状态落到当季账本） */
function _initLedgerAfterFirstCrawl() {
  const t = naturalQuarterTarget();
  const L = _newLedger(t);
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const k = (uni && uni.list)
    ? _countQuarter(uni.list, H, L.targetKey)
    : { remaining: 0, updatedTo: 0, lagged: 0, daysIn: 0, grace: 0, graceOver: false };
  L.updatedTo = k.updatedTo; L.remaining = k.remaining; L.lagged = k.lagged;
  L.daysIn = k.daysIn; L.grace = k.grace; L.graceOver = k.graceOver;
  L.published = k.updatedTo > 0;
  L.lastRunDate = _dateStr();
  L.startedAt = Date.now();
  if (k.remaining === 0) { L.done = true; L.finishedAt = Date.now(); }
  _saveLedger();
  console.log(`[FundMatrix] 采集完成 → 季度账本 ${L.label}：已达标 ${k.updatedTo}，待更新 ${k.remaining}，滞后 ${k.lagged}`
    + (L.done ? '（本季已完成）' : ''));
  return getQuarterStatus();
}

/**
 * 统一入口（供 server.js 调用）。
 *  - **冷启动**（尚无季度账本，或还有基金从未采集过）→ 全量/续跑把 1 万只拉齐，完成后建立当季账本
 *  - **已建仓** → 走 runDailyUpdate：每日一次检查 + 分批推进直到本季度完成
 */
async function startCrawl(opts = {}) {
  _loadProgress();
  if (state.running) return { started: false, reason: 'already-running', status: getCrawlStatus() };
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const cov = unpackCoverage(uni, H);

  if (opts.force) {
    const t = naturalQuarterTarget();
    _newLedger(t);
    _runCrawl({ force: true, targetPeriod: t.period })
      .then(() => { _finalizeLedger(); })
      .catch((e) => console.error('[FundMatrix] crawl fatal', e.message));
    return { started: true, reason: 'force-full', status: getCrawlStatus(), quarter: getQuarterStatus() };
  }

  // 冷启动/续跑：无账本，或仍有基金从未采集过 → 先把全量拉齐（此阶段不适用「每日分批」）
  const led = _lg();
  const hasLedger = !!(led && led.target);
  if (!hasLedger || cov.covered < cov.total) {
    // 带上当季目标期：既能补齐从未采集的缺口，也能把仍是旧报告期的条目一起更新
    const t = naturalQuarterTarget();
    _runCrawl({ targetPeriod: t.period }).then(() => _initLedgerAfterFirstCrawl())
      .catch((e) => console.error('[FundMatrix] crawl fatal', e.message));
    return {
      started: true, reason: hasLedger ? 'cold-resume' : 'first-crawl',
      unfinished: Math.max(0, cov.total - cov.covered),
      status: getCrawlStatus(), quarter: getQuarterStatus(),
    };
  }

  const r = await runDailyUpdate(opts);
  return { started: !!r.ran, ...r };
}

function stopCrawl() { _stop = true; return { stopped: true, status: getCrawlStatus() }; }

/**
 * 立即把所有内存缓存强制落盘。
 * 用途：进程退出/关机前调用，避免丢掉「已采集但还没到落盘条件」的最后一批进度。
 * 采集本来是可续跑的（重启后从 pending 接着跑），这里只是把断点位置推到最后一刻。
 */
function flushCache() {
  try {
    const funds = _holdings ? Object.keys(_holdings).length : 0;
    const inds = _indDisk ? Object.keys(_indDisk).length : 0;
    if (_holdings) _saveJson(F_HOLDINGS, _holdings);
    if (_indDisk) _saveJson(F_IND, _indDisk);
    if (_ledger) _saveJson(F_QUARTER, _ledger);
    _persistProgress();
    return { ok: true, funds, industry: inds };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function unpackCoverage(uni, H) {
  const total = uni && uni.list ? uni.list.length : 0;
  let covered = 0;
  if (uni && uni.list) for (const f of uni.list) if (H[f.code]) covered++;
  return { total, covered, remaining: Math.max(0, total - covered), shareClasses: uni ? uni.shareClasses : 0, allFunds: uni ? uni.total : 0 };
}

// ---------- 5) 聚合：行业 × 持仓市值 排名 ----------
/**
 * 环比口径（**严格可比**）：
 *   只纳入「同时拥有  展示期 + 紧邻上一期  两期数据」的**同一批基金**。
 *   否则 A 期用全体、B 期用子集，差额里会混入"样本变化"，不是真实的增减持。
 *   因此 fundsComparable 既是样本量，也是「本季度已更新进度」的最直接体现。
 */
function getFundIndustryRanking(opts = {}) {
  // ⚠️ 只在内存状态尚未初始化时读盘；否则每次 API 请求都会用磁盘旧值
  //    覆盖正在运行的实时状态（phase/done/remaining 会被打回上一次落盘值）。
  if (!state.period && !state.running) _loadProgress();
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const cov = unpackCoverage(uni, H);
  const qs = getQuarterStatus();

  // 展示期：优先「账本目标期（已开始发布）」，否则退回缓存中出现最多的报告期
  const tally = new Map();
  for (const code of Object.keys(H)) { const q = H[code] && H[code].q; if (q) tally.set(q, (tally.get(q) || 0) + 1); }
  const modeQ = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || '';
  const displayQ = (qs.published && qs.target) ? qs.target : modeQ;
  const prevQ = _prevQuarterOf(displayQ);

  const indMap = new Map();
  let holdings = 0, totalValue = 0, stocksSeen = 0;
  let prevTotalValue = 0, fundsComparable = 0;
  const stockSet = new Set();

  const _row = (name) => {
    if (!indMap.has(name)) indMap.set(name, { name, marketValue: 0, prevValue: 0, fundSet: new Set(), stocks: new Map() });
    return indMap.get(name);
  };

  for (const code of Object.keys(H)) {
    const f = H[code];
    if (!f || !f.q || f.q !== displayQ) continue;          // 未更新到展示期 → 不纳入（避免混口径）
    if (!prevQ || f.pq !== prevQ) continue;                // 缺紧邻上一期 → 无法严格可比，排除
    fundsComparable++;

    for (const h of f.holdings) {
      if (!h || !h.code) continue;
      stocksSeen++;
      stockSet.add(h.code);
      const ind = _indCacheGet(h.code) || '未分类';
      const v = Number.isFinite(h.value) ? h.value : 0;   // 持仓市值（万元）
      const row = _row(ind);
      row.marketValue += v;
      row.fundSet.add(code);
      if (!row.stocks.has(h.code)) row.stocks.set(h.code, { code: h.code, name: h.name, marketValue: 0, fundCount: 0 });
      const s = row.stocks.get(h.code);
      s.marketValue += v; s.fundCount += 1;
      holdings++; totalValue += v;
    }
    // 上一期沿用同一个个股→行业映射，且**基金集合完全相同** → 环比才可比
    for (const h of (f.prevHoldings || [])) {
      if (!h || !h.code) continue;
      const ind = _indCacheGet(h.code) || '未分类';
      const v = Number.isFinite(h.value) ? h.value : 0;
      _row(ind).prevValue += v;
      prevTotalValue += v;
    }
  }

  const industries = Array.from(indMap.values())
    .map((r) => {
      const changeWan = r.marketValue - r.prevValue;                      // 万元
      return {
        name: r.name,
        marketValue: Math.round(r.marketValue * 100) / 100,                    // 万元
        marketValueYi: Math.round(r.marketValue / 10000 * 100) / 100,          // 亿元
        prevMarketValue: Math.round(r.prevValue * 100) / 100,
        prevMarketValueYi: Math.round(r.prevValue / 10000 * 100) / 100,
        changeWan: Math.round(changeWan * 100) / 100,
        changeYi: Math.round(changeWan / 10000 * 100) / 100,
        // 环比变化率：基数为 0 或无基数时给 null（不硬造百分比）
        changePct: r.prevValue > 0 ? Math.round(changeWan / r.prevValue * 10000) / 100 : null,
        share: totalValue > 0 ? Math.round(r.marketValue / totalValue * 10000) / 100 : 0, // 占纳入基金重仓市值 %
        fundCount: r.fundSet.size,
        stockCount: r.stocks.size,
        topStocks: Array.from(r.stocks.values())
          .sort((a, b) => b.marketValue - a.marketValue)
          .slice(0, 8)
          .map((s) => ({ code: s.code, name: s.name, marketValue: Math.round(s.marketValue * 100) / 100, fundCount: s.fundCount })),
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const minFunds = opts.minFunds || 0;
  const filtered = minFunds ? industries.filter((i) => i.fundCount >= minFunds) : industries;

  // 行业解析进度（从磁盘缓存实算，重启后也准确）
  let indResolved = 0, indMiss = 0;
  for (const c of stockSet) {
    if (_indCacheGet(c)) indResolved++;
    else if (_indCacheResolved(c)) indMiss++;   // 已有结论=查不到（负缓存）
  }
  const indUnresolved = Math.max(0, stockSet.size - indResolved - indMiss);

  // 已更新到展示期的基金数（含缺上一期而无法纳入环比的）
  let fundsAtTarget = 0;
  for (const code of Object.keys(H)) { const f = H[code]; if (f && f.q === displayQ) fundsAtTarget++; }

  return {
    ok: true,
    mode: 'market',
    metric: '持仓市值（万元）加总',
    scopes: '权益类公募基金（股票/混合/指数/QDII），按母基金去重',
    period: displayQ,
    prevPeriod: prevQ,
    periodLabel: _qLabel(displayQ),
    prevPeriodLabel: _qLabel(prevQ),
    quarter: qs,
    coverage: {
      allFunds: cov.allFunds,          // 全市场基金总数
      shareClasses: cov.shareClasses,  // 权益类份额数
      universe: cov.total,             // 去重后母基金数（采集目标）
      covered: cov.covered,            // 已采集
      fundsAtTarget,                   // 已更新到展示期的基金数
      fundsComparable,                 // 两期齐全、可严格算环比的基金数（= 当前排名样本量）
      remaining: qs.remaining >= 0 ? qs.remaining : cov.remaining,
      stocks: stockSet.size,
      holdings,                        // 重仓股记录数
      totalMarketValueWan: Math.round(totalValue * 100) / 100,
      totalMarketValueYi: Math.round(totalValue / 10000 * 100) / 100,
      prevTotalMarketValueYi: Math.round(prevTotalValue / 10000 * 100) / 100,
      industryResolved: indResolved,
      industryMiss: indMiss,
      industryUnresolved: indUnresolved,
    },
    progress: getCrawlStatus(),
    industries: filtered,
    note: `数据源：东方财富公开接口（基金列表 + 各基金 ${_qLabel(displayQ) || '最新期'} 与 ${_qLabel(prevQ) || '上一期'} 前十大重仓股 + 个股行业）。`
        + `更新频率=**自然季度**：${qs.naturalQuarterLabel}对应目标报告期 ${qs.targetLabel}，`
        + '进入季度后每日检查一次东财披露情况，分批更新、直到全部母基金更新完毕（各基金披露日期不同，故分批推进）。'
        + '行业口径为东财归一行业名；只含前十大重仓股，非全部持仓。'
        + '按母基金去重（A/C 等份额不重复计，因东财对同一基金各份额报出的持仓市值相同）。'
        + '「环比变化」采用**严格可比口径**：最新期与上一期均取自同一批基金（当前 '
        + `${fundsComparable} 只），避免样本变化混入增减持结论；缺上一期数据的基金不计入（新发基金等）。`,
  };
}

module.exports = {
  getFundUniverse,
  getFundIndustryRanking,
  getCrawlStatus,
  getQuarterStatus,
  naturalQuarterTarget,
  runDailyUpdate,
  startCrawl,
  stopCrawl,
  flushCache,
  lookupIndustry,
  detectLatestPeriod,
  baseFundName,
  _parseHoldingsHtml,
  _prevQuarterOf,
  _qKey,
  _qLabel,
  _needsWork,
  _countQuarter,
  DAILY_HOUR,
  DAILY_BATCH,
  DAILY_BUDGET_MS,
};
