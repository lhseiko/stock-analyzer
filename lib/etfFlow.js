/**
 * etfFlow.js — 宽基 ETF 申购赎回跟踪（20261022h 新建；20261026a：shareDate 改按采集日推 + 披露未跨日守卫，修跨日补采假 Δ=0）
 * =========================================================
 * 目的：把「宽基 ETF 的申购/赎回」变成可进情绪模型的资金流信号 —— 宽基 ETF 被净申购
 * = 增量资金通过一篮子股票入市（成分股被"买"）；被净赎回 = 一篮子股票被卖回市场。
 *
 * 【口径必须说清，否则会骗人】
 *   1. 交易所 PCF（申购赎回清单）只是「申赎一篮子要交什么」的**模板**，本身不含当日实际申赎量。
 *   2. 真正反映申赎的是**基金总份额的变化**（东财 f84，单位：份）。
 *      份额是"净"概念：Δ份额 = 当日申购 − 当日赎回。所以**分不出申购总量与赎回总量两个绝对数**。
 *   3. 本模块的做法：按日归集方向 —— Δ>0 的日计入「净申购」，Δ<0 的日计入「净赎回」，
 *      分别累计。这给出的是「净申购日累计 / 净赎回日累计」，不是「申购总量 / 赎回总量」，
 *      文案一律写明，不允许含糊成"申购了多少"。
 *   4. 逐股股数 = 篮数 × 该股每篮份数，其中 篮数 = Δ份额 ÷ 最小申赎单位。
 *      这是申赎带来的**理论**增减股数（基金实际会因现金替代/取整有偏差）。
 *
 * 【文件结构】
 *   data/etf-flow/<TRADING_DAY>.json   每日快照（份额 + 全篮成分），保留最近 N 天
 *   data/etf-flow/pcf-cache/<date>.json  当日 PCF 缓存（同一交易日重复运行不重复抓）
 *   data/etf-flow/ledger.json          累计台账（净申购/净赎回日累计），幂等：同日只累加一次
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { localCompact, localDateTime } = require('./localDate');
const { previousTradingDay } = require('./cnTradingCalendar');
// 快照日期是紧凑格式 20261023，而 previousTradingDay 只认 2026-10-23 → 统一归一后再回紧凑。
const _prevTd = (compact) => {
  const dashed = /^\d{8}$/.test(String(compact))
    ? `${String(compact).slice(0, 4)}-${String(compact).slice(4, 6)}-${String(compact).slice(6)}`
    : String(compact);
  return previousTradingDay(dashed).replace(/-/g, '');
};
// PCF 缓存键 = 中国自然日（YYYYMMDD）。用 UTC 日期会在早盘前段错位一天，
// 让「今天该抓的清单」被当成「昨天已抓过」而读到空缓存。

// 允许用环境变量覆盖存储目录（离线回归测试用；生产默认 data/etf-flow）
const DIR = process.env.SA_ETF_FLOW_DIR
  ? path.resolve(process.env.SA_ETF_FLOW_DIR)
  : path.join(__dirname, '..', 'data', 'etf-flow');
const PCF_DIR = path.join(DIR, 'pcf-cache');
const LEDGER = path.join(DIR, 'ledger.json');
const KEEP_DAYS = 10;            // 快照保留天数（够算"上一交易日"即可）
const MAX_ETF = 40;              // 全量抓取上限，防请求过多（20+4+4+3+3 = 34，留余量）
const SHARE_BASE = 20e8;         // 净申赎额归一基准：20 亿元 ≈ score ±0.76
const FETCH_TIMEOUT = 20000;
const CONCURRENCY = 4;

const SSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.sse.com.cn/disclosure/fund/etflist/',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};
const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://quote.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
// 东财 push2 族镜像：本机 Node 的 TLS 指纹常被对端直接 reset（socket hang up），
// 只靠单主机单通道会全军覆没。策略同 lib/stockData.js：多镜像 × (Node https → 系统 curl)。
const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://16.push2.eastmoney.com',
];
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

// 宽基家族定义：名称关键词 + 期望成分数（成分数用于排除行业/策略/增强衍生品）
const GROUPS = [
  { key: 'csi300',   label: '沪深300',  kw: '沪深300',  comps: 300, cls: ['03'], max: 20 },
  { key: 'sse50',    label: '上证50',   kw: '上证50',   comps: 50,  cls: ['01', '03'], max: 4 },
  { key: 'csi500',   label: '中证500',  kw: '中证500',  comps: 500, cls: ['03'], max: 4 },
  { key: 'csi1000',  label: '中证1000', kw: '中证1000', comps: 1000, cls: ['03'], max: 3 },
  { key: 'star50',   label: '科创50',   kw: '科创板50', comps: 50,  cls: ['09'], max: 3 },   // 上交所全称是「上证科创板50成份」，写「科创50」匹配不到
];
// 名称里出现这些词 = 行业/策略/增强衍生品，不是纯宽基复制
const DERIV = /医药|红利|ESG|增强|价值|成长|低波|质量|动量|等权|非银|银行|消费|科技|信息|军工|有色|能源|地产|国企|央企|龙头|优选|量化|策略|REIT/i;

/**
 * 内部错误台账：所有 try/catch 都把原因记进来（而不是静默吞掉），
 * 由 getEtfFlow 汇总进 gaps 一并披露 —— 采集"部分失败"与"全部失败"必须能区分。
 */
const _errs = [];
function noteErr(where, e) {
  if (_errs.length >= 20) return;
  const msg = `${where}：${e && e.message ? e.message : e}`;
  if (_errs.indexOf(msg) < 0) _errs.push(msg);
}
function drainErrs() { return _errs.splice(0, _errs.length); }

function ensureDir(p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch (e) { noteErr('创建目录 ' + p, e); } }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) {
  try {
    ensureDir(path.dirname(p));
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { return false; }
}
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[￥,\s%]/g, '')); return Number.isFinite(n) ? n : null; };
const round = (x, n = 2) => { const p = Math.pow(10, n); return Math.round(x * p) / p; };

/**
 * 该交易日的份额变动是否已「定稿」。
 * 份额（f84）是盘中实时更新的，盘中读到的 Δ份额 只是半天进度。
 * 累计台账必须只吃定稿值，否则 10:00 那次采样的半天增量会被永久写进台账
 * （幂等闸门 lastDate===date 会把收盘后的真实值挡在外面）。
 * 定稿判据与 zoneValidity.finalizedBars 同口径：交易日 15:05 后；历史日期天然定稿。
 */
function sessionSettled(tradeDate) {
  if (!tradeDate) return false;
  const now = localDateTime();                 // 'YYYY-MM-DD HH:mm'
  const d = now.slice(0, 10).replace(/-/g, '');
  if (tradeDate < d) return true;
  if (tradeDate > d) return false;
  return now.slice(11, 16) >= '15:05';
}

function httpGet(url, headers, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(bufs).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
/** 原样返回 Buffer（腾讯行情是 GBK，不能用 utf8 解读） */
function httpGetBuf(url, headers, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(bufs));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
const getJson = async (u, h) => JSON.parse(await httpGet(u, h));

/**
 * 东财 push2 族请求：逐镜像尝试，每个镜像先走 Node https，被 reset 再交给系统 curl。
 * 任一条能拿到含 data 的 JSON 即返回，全部失败抛错（由调用方降级）。
 *
 * 熔断：本机对 push2 全族常常整体不可达（4 镜像 × 2 通道 × 超时 ≈ 90s），
 * 只要失败一次就进入 10 分钟静默期，避免每条降级路径都把请求拖成分钟级。
 * @param {string} apiPath 形如 '/api/qt/ulist.np/get?fltt=2&fields=...'
 */
let _emDownUntil = 0;
async function getJsonEm(apiPath) {
  if (Date.now() < _emDownUntil) throw new Error('东财通道处于静默期（近期全部镜像不可达）');
  let lastErr = null;
  for (const host of EM_HOSTS) {
    const url = host + apiPath + (apiPath.includes('?') ? '&' : '?') + `ut=${EM_UT}&invt=2`;
    try {
      const j = await getJson(url, EM_HEADERS);
      if (j && j.data) return j;
      lastErr = new Error('返回无 data');
    } catch (e) { lastErr = e; }
    // Node TLS 被重置时用系统 curl（schannel 指纹）二次尝试
    try {
      const out = await execFileAsync('curl', ['-s', '--max-time', '8', '-H', 'Referer: https://quote.eastmoney.com/', url],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const j = JSON.parse(out.stdout);
      if (j && j.data) return j;
      lastErr = new Error('curl 返回无 data');
    } catch (e) { lastErr = e; }
  }
  _emDownUntil = Date.now() + 10 * 60 * 1000;
  throw lastErr || new Error('东财接口全部镜像不可达');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: e.message, __item: items[k] }; }
    }
  }));
  return out;
}

// ── 上交所接口 ──
const Q = 'https://query.sse.com.cn/commonQuery.do';
const listUrl = (cls) => `${Q}?isPagination=true&pageHelp.pageSize=600&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1&sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=${cls}&type=inParams&FUND_CODE=&KEY_WORDS=`;
const jbxxUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`;
const compUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C`;

/** 选出宽基 ETF 名单（按家族、成分数、排除衍生词） */
async function selectUniverse() {
  const byCls = {};
  for (const cls of ['03', '01', '09']) {
    try {
      const j = await getJson(listUrl(cls), SSE_HEADERS);
      byCls[cls] = ((j.pageHelp && j.pageHelp.data) || []).map(x => ({
        code: x.FUNDID2, name: x.ETF_FULLNAME || '', comp: x.FUND_COMP_NAME || '', cls,
      }));
    } catch (e) { byCls[cls] = []; }
  }
  const picked = [];
  const seen = new Set();
  for (const g of GROUPS) {
    const pool = [];
    for (const cls of g.cls) {
      for (const it of (byCls[cls] || [])) {
        if (!it.name.includes(g.kw)) continue;
        if (DERIV.test(it.name)) continue;
        pool.push(it);
      }
    }
    pool.sort((a, b) => a.code.localeCompare(b.code));
    let n = 0;
    for (const it of pool) {
      if (n >= g.max || seen.has(it.code)) continue;
      picked.push(Object.assign({}, it, { group: g.key, groupLabel: g.label, expectComps: g.comps }));
      seen.add(it.code);
      n++;
    }
  }
  return picked.slice(0, MAX_ETF);
}

/** 抓一只 ETF 的 PCF（基本信息 + 成分股） */
async function fetchPcf(code) {
  const [j, c] = await Promise.all([getJson(jbxxUrl(code), SSE_HEADERS), getJson(compUrl(code), SSE_HEADERS)]);
  const base = (j.result && j.result[0]) || null;
  if (!base) throw new Error('无当日清单');
  const comps = (c.result || [])
    .filter(x => x && x.INSTRUMENT_ID && num(x.QUANTITY) > 0)   // 股数 0 = 纯现金替代，不构成实物持仓
    .map(x => [x.INSTRUMENT_ID, num(x.QUANTITY) || 0]);
  return {
    code,
    name: base.FUND_NAME,
    tradeDate: base.TRADING_DAY,
    nav: num(base.NAV),
    unit: num(base.CREATION_REDEMPTION_UNIT),
    navPerCu: num(base.NAVPERCU),
    cash: num(base.ESTIMATED_CASH_COMPONENT),
    compCount: num(base.RECORD_NUM),
    comps,
  };
}

/**
 * 腾讯行情批量取数（GBK，字段位固定）。
 * 为什么份额用腾讯而不是东财：本机 push2 全族常整体不可达（socket hang up），
 * 而 qt.gtimg.cn 是本项目主行情源、稳定可达；一次请求可批量 60 只。
 * 字段（下标从 0 起，`~` 分隔）：1=名称 3=现价 72=流通股本/份额 73=总股本/份额 78=净值(IOPV)
 * 交叉验证（20261022 实测）：510300 现价 4.107、总市值 1240.28 亿 → 份额 = 1240.28e8/4.107 = 301.99 亿份，
 * 与字段 72 = 30199087700 完全一致；601318 字段 72=106.6 亿（A股流通）/73=181.08 亿（总股本）亦正确。
 * ETF 的 72 与 73 相等（无流通/非流通之分），取 72 优先、73 兜底。
 */
const TX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://gu.qq.com/',
};
const txPrefix = (c) => (/^(5|6|9)/.test(c) ? 'sh' : 'sz') + c;

async function tencentQuotes(codes, timeout = 12000) {
  const out = {};
  const BATCH = 60;
  for (let i = 0; i < codes.length; i += BATCH) {
    const chunk = codes.slice(i, i + BATCH);
    try {
      const buf = await httpGetBuf('https://qt.gtimg.cn/q=' + chunk.map(txPrefix).join(','), TX_HEADERS, timeout);
      const txt = new TextDecoder('gbk').decode(buf);
      for (const seg of txt.split(';')) {
        const s = seg.trim();
        if (!s || s.indexOf('~') < 0) continue;
        const a = s.split('~');
        const m = /v_[a-z]{2}(\d{6})/.exec(s);
        const code = a[2] || (m && m[1]);
        if (!code) continue;
        out[code] = {
          name: a[1] || '',
          price: num(a[3]),
          shares: num(a[72]) || num(a[73]),
          nav: num(a[78]),
        };
      }
    } catch (e) { noteErr('腾讯行情批量取数', e); }
  }
  return out;
}

/** 东财实时份额（f84，单位：份）—— 仅作腾讯缺失时的备链 */
async function fetchSharesEastmoney(codes) {
  const out = {};
  const q = codes.map(c => (/^(6|9)/.test(c) ? '1.' : '0.') + c).join(',');
  try {
    const j = await getJsonEm(`/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f84&secids=${q}`);
    const list = (j.data && j.data.diff) || [];
    for (const it of (Array.isArray(list) ? list : Object.values(list))) {
      const v = num(it.f84);
      if (it.f12 && v) out[it.f12] = v;
    }
  } catch (e) { noteErr('东财 f84 备链', e); }
  return out;
}

/** 基金份额（份）：腾讯 → 东财备链。返回 {code: 份} */
async function fetchShares(codes) {
  if (!codes.length) return {};
  const tx = await tencentQuotes(codes);
  const out = {};
  for (const c of codes) if (tx[c] && tx[c].shares) out[c] = tx[c].shares;
  const missing = codes.filter(c => !out[c]);
  if (missing.length) {
    const em = await fetchSharesEastmoney(missing);
    for (const c of missing) if (em[c]) out[c] = em[c];
  }
  return out;
}

/**
 * 成分股名称（只抓缺的，永久累积到 stock-names.json）。
 * PCF 只给 INSTRUMENT_ID，不给名称；页签要显示"哪只股票被申购"就必须补名称。
 * 一次全市场宽基交集约 1400~1600 只，首轮约 25 个批次，之后基本零请求。
 */
const NAME_CACHE = path.join(DIR, 'stock-names.json');
async function fetchStockNames(codes) {
  let cache = readJson(NAME_CACHE, null);
  if (!cache || typeof cache !== 'object') cache = {};
  const missing = Array.from(new Set(codes)).filter(c => c && !cache[c]);
  if (missing.length) {
    const got = await tencentQuotes(missing);
    let n = 0;
    for (const c of Object.keys(got)) {
      if (got[c] && got[c].name) { cache[c] = got[c].name; n++; }
    }
    if (n) writeJson(NAME_CACHE, cache);
  }
  return cache;
}

// ── 快照 ──
function snapPath(date) { return path.join(DIR, `${date}.json`); }
function pcfCachePath(date) { return path.join(PCF_DIR, `${date}.json`); }
function listSnapshots() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => /^\d{8}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch (e) { return []; }
}
function pruneSnapshots() {
  const all = listSnapshots();
  for (const d of all.slice(0, Math.max(0, all.length - KEEP_DAYS))) {
    try { fs.unlinkSync(snapPath(d)); } catch (e) { noteErr('清理过期快照 ' + d, e); }
  }
}

/**
 * 采集当日快照（PCF 当日缓存 + 份额实时）。
 * @returns {{ok:boolean, date:string, etfs:Array, gaps:string[]}}
 */
async function collect(opts = {}) {
  const gaps = [];
  const universe = await selectUniverse();
  if (!universe.length) return { ok: false, date: null, etfs: [], gaps: ['上交所宽基 ETF 名单为空'] };

  // PCF 缓存键用**北京日期**：同一自然日内 RPC 内容固定（开市前已发布），重复运行不必重抓。
  // 交易日由 PCF 自己的 TRADING_DAY 决定（非交易日会返回上一交易日清单）→ 天然规避假期。
  const cacheKey = opts.cacheKey || localCompact();
  const cache = readJson(pcfCachePath(cacheKey), null);

  let tradeDate = null;
  let pcfs;
  if (cache && cache.byCode) {
    tradeDate = cache.date;
    pcfs = universe.map(u => cache.byCode[u.code] || null);
    // 缓存命中的只是「当时那份名单」。名单扩容（修正关键词/放宽配额）后，新增的 ETF 不能被
    // cache 一挡就是一整天 —— 只补抓缺的那几只，并回写缓存（其它已有条目不动）。
    const missCodes = universe.filter(u => !cache.byCode[u.code]).map(u => u.code);
    if (missCodes.length) {
      const extra = await mapLimit(missCodes, CONCURRENCY, (code) => fetchPcf(code));
      let added = 0;
      missCodes.forEach((code, i) => {
        const p = extra[i];
        if (p && !p.__err) { cache.byCode[code] = p; added++; }
        else gaps.push(`${code} 无当日清单${p && p.__err ? '（' + p.__err + '）' : ''}`);
      });
      if (added) {
        writeJson(pcfCachePath(cacheKey), { date: tradeDate, savedAt: new Date().toISOString(), byCode: cache.byCode });
        gaps.push(`名单扩容：补抓 ${added} 只新增 ETF 的当日清单`);
      }
      pcfs = universe.map(u => cache.byCode[u.code] || null);
    }
  } else {
    pcfs = await mapLimit(universe.map(u => u.code), CONCURRENCY, (code) => fetchPcf(code));
    const okList = pcfs.filter(p => p && !p.__err);
    if (!okList.length) return { ok: false, date: null, etfs: [], gaps: ['PCF 全部抓取失败'] };
    tradeDate = okList[0].tradeDate;
    const byCode = {};
    for (const p of okList) byCode[p.code] = p;
    writeJson(pcfCachePath(cacheKey), { date: tradeDate, savedAt: new Date().toISOString(), byCode });
  }

  const okPcfs = [];
  pcfs.forEach((p, i) => {
    if (!p) { gaps.push(`${universe[i].code} 无当日清单`); return; }
    if (p.__err) { gaps.push(`${universe[i].code} 抓取失败：${p.__err}`); return; }
    okPcfs.push(p);
  });

  const shares = await fetchShares(okPcfs.map(p => p.code));
  const missingShare = okPcfs.filter(p => !shares[p.code]).map(p => p.code);
  if (missingShare.length) gaps.push(`份额缺失 ${missingShare.length} 只（${missingShare.slice(0, 5).join('、')}${missingShare.length > 5 ? ' 等' : ''}）`);

  const etfs = okPcfs.map((p) => {
    const u = universe.find(x => x.code === p.code) || {};
    return {
      code: p.code,
      name: p.name,
      group: u.group || 'other',
      groupLabel: u.groupLabel || '其他',
      nav: p.nav,
      unit: p.unit,
      navPerCu: p.navPerCu,
      cash: p.cash,
      compCount: p.compCount,
      shares: shares[p.code] || null,
      comps: p.comps,
    };
  });

  // 20261026a：shareDate 必须按「采集日」推，不能按 tradeDate 推。
  // 份额是 T+1 披露：采集当日能看到的最新官方份额 = 采集日前一交易日的收盘份额。
  // 若按 tradeDate 推：跨日补采（如周六补采周五 tradeDate）时 field72 已前进到 tradeDate
  // 当日官方值，却仍标成 tradeDate-1 → 与下一份快照「同日对同日」相减得出假 Δ=0
  // （2026-10-23 数据日实测：510300 真实净申购 +25.13 亿份被显示成 0.00 亿，用户报障）。
  let snapShareDate = _prevTd(localCompact());   // 采集日（北京日期），与 PCF cacheKey 无关
  if (snapShareDate > tradeDate) snapShareDate = tradeDate;   // 补采更早 tradeDate 时钳回，防日期倒挂
  const snap = { date: tradeDate, shareDate: snapShareDate, savedAt: new Date().toISOString(), settled: sessionSettled(tradeDate), etfs };

  // 成分股名称补齐（只抓缺失、永久累积；失败不阻断，展示时用代码兜底）
  try {
    const allCodes = [];
    for (const e of etfs) for (const [c] of e.comps) allCodes.push(c);
    const names = await fetchStockNames(allCodes);
    if (Object.keys(names || {}).length) snap.stockNames = names;
  } catch (e) { gaps.push('成分股名称抓取失败（将只显示代码）'); }

  // 已定稿的快照不允许被盘中读数降级覆盖（否则次日算 Δ份额 会以半天数据为基期）
  const exist = readJson(snapPath(tradeDate), null);
  if (!(exist && exist.settled && !snap.settled)) writeJson(snapPath(tradeDate), snap);
  pruneSnapshots();
  return { ok: true, date: tradeDate, etfs, gaps, settled: snap.settled };
}

// ── 计算 ──
/** 净申赎额 → 因子得分（±1，tanh 软饱和；基准 SHARE_BASE 元 ≈ ±0.76） */
function scoreOf(totalNet) {
  const v = Number(totalNet);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, Math.tanh(v / SHARE_BASE)));
}

/**
 * 以「本日快照 − 最近一份已定稿快照」算净申赎，并把定稿日的增量累加到台账。
 * 基期只认 settled:true 的快照：份额是盘中实时值，若拿 10:00 的半天读数当基期，
 * 次日算出来的 Δ份额 会虚增。
 * @returns {object} 明细（供因子与前端页签使用）
 */
function computeFromSnapshots(date) {
  const today = readJson(snapPath(date), null);
  if (!today) return { ok: false, reason: '当日快照缺失' };

  // 20261023j：腾讯行情 field 72（基金份额）是 T-1 披露值——10-23 收盘后取到的份额，权威数据实际
  // 对应上一交易日（510300 实测：本站 32,729,887,700 份 = 东财 2026-10-22 的 327.3 亿份）。
  // 因此「数据日」必须用份额披露日 shareDate，不能用快照的 tradeDate，否则会「标注今日、数据是昨天」。
  const shareDate = today.shareDate || _prevTd(today.date);

  // 基期 = 本日之前最近一份「已定稿」快照
  let baseDate = null, base = null;
  for (const d of listSnapshots()) {
    if (d >= date) continue;
    const s = readJson(snapPath(d), null);
    if (s && s.settled) { baseDate = d; base = s; }
  }
  const baseShareDate = base ? (base.shareDate || _prevTd(base.date)) : null;

  // 20261026a 守卫：基期披露日 ≥ 本期披露日 → 两份快照拿到的是同一披露日的份额，
  // 相减必得假 Δ=0（2026-10-23 数据日实测事故）。宁可诚实报「无法计算」，不可输出假 0。
  if (baseShareDate && baseShareDate >= shareDate) {
    return {
      ok: false,
      overlap: true,
      date: shareDate,
      snapshotDate: today.date,
      baseDate,
      reason: `份额披露未跨日：本期与基期快照拿到的都是 ${shareDate} 收盘份额（基期快照 ${baseDate} 为跨日补采，未捕获更早披露日），净申赎无法计算。下一交易日快照披露跨日后自动恢复。`,
      etfs: today.etfs.map(e => ({ code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel, nav: e.nav, unit: e.unit, shares: e.shares, dShares: null, baskets: null, netAmount: null, note: '' })),
      stocks: [],
      groups: [],
      settled: !!today.settled,
    };
  }
  // 基期披露日与本期不相邻（跨多日）：Δ 为多日合计，须标注，防止误读为单日申赎
  const spanNote = (baseShareDate && _prevTd(shareDate) !== baseShareDate)
    ? `基期披露日 ${baseShareDate} 与本期 ${shareDate} 不相邻，净申赎为多日合计值`
    : null;
  if (!base) {
    return {
      ok: false,
      noPrev: true,
      date: shareDate,
      snapshotDate: today.date,
      baseDate: null,
      reason: `已建立基线（${shareDate}），下一交易日出现第二份定稿快照后即可计算净申赎`,
      etfs: today.etfs.map(e => ({ code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel, nav: e.nav, unit: e.unit, shares: e.shares, dShares: null, baskets: null, netAmount: null, note: '' })),
      stocks: [],
      groups: [],
      settled: !!today.settled,
    };
  }
  const prevMap = {};
  for (const e of (base.etfs || [])) prevMap[e.code] = e;

  const etfRows = [];
  const stockAgg = new Map();     // group|code -> {buyShares, sellShares, buyDays?, ...}
  const groupAgg = new Map();
  let totalNet = 0;
  let priced = 0;

  for (const e of today.etfs) {
    const p = prevMap[e.code];
    const row = {
      code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel,
      nav: e.nav, unit: e.unit, shares: e.shares, prevShares: p ? p.shares : null,
      dShares: null, baskets: null, netAmount: null, note: '',
    };
    if (!p) { row.note = '基期无快照（新入名单）'; etfRows.push(row); continue; }
    if (!e.shares || !p.shares) { row.note = '份额缺失'; etfRows.push(row); continue; }
    const dShares = e.shares - p.shares;
    row.dShares = dShares;
    row.baskets = e.unit ? dShares / e.unit : null;
    row.netAmount = (e.nav || p.nav) ? dShares * (e.nav || p.nav) : null;
    if (row.baskets != null && Math.abs(row.baskets - Math.round(row.baskets)) > 0.05 && dShares !== 0) {
      row.note = `Δ份额 ÷ 申赎单位 = ${round(row.baskets, 3)}，非整数（可能含分红/拆分或份额口径差异）`;
    }
    if (row.netAmount != null) { totalNet += row.netAmount; priced++; }
    etfRows.push(row);

    // 逐股：篮数 × 每篮份数（用当日篮子；篮子若调仓，差额归因于调仓，不归因于申赎）
    // 聚合键用**股票代码**而不是「家族|代码」：用户要看的是"这只股票一共被申购多少"，
    // 同一只股票同时属于沪深300与中证500篮子时必须合并，拆成两行会让人以为只被买了半份。
    if (row.baskets) {
      for (const [code, qty] of e.comps) {
        let a = stockAgg.get(code);
        if (!a) { a = { code, buyShares: 0, sellShares: 0, groups: new Set() }; stockAgg.set(code, a); }
        a.groups.add(e.group);
        const delta = row.baskets * qty;
        if (delta > 0) a.buyShares += delta; else a.sellShares += delta;
      }
      let g = groupAgg.get(e.group);
      if (!g) { g = { key: e.group, label: e.groupLabel, netAmount: 0, buyAmount: 0, sellAmount: 0, etfCount: 0 }; groupAgg.set(e.group, g); }
      if (row.netAmount != null) {
        g.netAmount += row.netAmount;
        if (row.netAmount > 0) g.buyAmount += row.netAmount; else g.sellAmount += row.netAmount;
        g.etfCount++;
      }
    }
  }

  // 累计台账（幂等：同一代码同日只累加一次；只吃「已定稿」的收盘值，盘中增量不进台账）
  // settled 取**快照里记录的**标志，不按当前时间重算：一份 14:00 采的快照到了晚上依然是盘中值，
  // 若按当前时间重算就会把半天增量当成收盘值记进累计台账。
  const ledger = readJson(LEDGER, { lastDate: null, cum: {}, days: 0 }) || { lastDate: null, cum: {}, days: 0 };
  // 20261023j 一次性迁移：旧台账把 lastDate 记成 tradeDate（20261023），实际份额日期是 20261022。
  if (ledger.lastDate && ledger.lastDate === today.date && shareDate !== today.date) {
    ledger.lastDate = shareDate;
    writeJson(LEDGER, ledger);
  }
  const settled = !!today.settled;
  const already = ledger.lastDate === shareDate;
  if (settled && !already) {
    for (const [key, a] of stockAgg) {
      let c = ledger.cum[key];
      if (!c) { c = { buyShares: 0, sellShares: 0, buyDays: 0, sellDays: 0 }; ledger.cum[key] = c; }
      if (a.buyShares > 0) { c.buyShares += a.buyShares; c.buyDays += 1; }
      if (a.sellShares < 0) { c.sellShares += a.sellShares; c.sellDays += 1; }
    }
    ledger.lastDate = shareDate;
    ledger.days = (ledger.days || 0) + 1;
    writeJson(LEDGER, ledger);
  }

  // 逐股清单 = 今日篮子 ∪ 台账历史（已退出篮子的股票其累计值仍要展示，否则"一共被申购了多少"会少算）
  const names = today.stockNames || readJson(NAME_CACHE, {}) || {};
  const gLabel = (k) => (GROUPS.find(g => g.key === k) || {}).label || k;
  const keys = new Set(Object.keys(ledger.cum || {}));
  for (const k of stockAgg.keys()) keys.add(k);
  const stocks = [];
  for (const code of keys) {
    const a = stockAgg.get(code);
    const c = (ledger.cum || {})[code] || { buyShares: 0, sellShares: 0, buyDays: 0, sellDays: 0 };
    if (!c.buyShares && !c.sellShares && !(a && (a.buyShares || a.sellShares))) continue;
    const groups = a ? Array.from(a.groups) : [];
    stocks.push({
      code,
      name: names[code] || '',
      groups,
      groupLabel: groups.map(gLabel).join(' / '),
      dayBuy: a ? a.buyShares : 0, daySell: a ? a.sellShares : 0,
      cumBuy: c.buyShares, cumSell: c.sellShares,
      buyDays: c.buyDays, sellDays: c.sellDays,
    });
  }
  const mag = (v) => Math.abs(v || 0);
  stocks.sort((x, y) => (mag(y.cumBuy) + mag(y.cumSell)) - (mag(x.cumBuy) + mag(x.cumSell))
    || (mag(y.dayBuy) + mag(y.daySell)) - (mag(x.dayBuy) + mag(x.daySell)));

  return {
    ok: true,
    date: shareDate,
    snapshotDate: today.date,
    baseDate: baseShareDate,
    settled,
    spanNote,
    etfs: etfRows,
    stocks,
    groups: Array.from(groupAgg.values()).map(g => Object.assign(g, {
      netAmount: round(g.netAmount, 0), buyAmount: round(g.buyAmount, 0), sellAmount: round(g.sellAmount, 0),
    })),
    totalNet: round(totalNet, 0),
    pricedCount: priced,
    ledgerDays: ledger.days || 0,
    ledgerDate: ledger.lastDate,
    ledgerIncludesToday: already || (settled && ledger.lastDate === date),
  };
}

/**
 * 对外入口：返回 {ok, date, factor:{score,value,detail}, detail:{...}, gaps}
 * 失败一律降级（不抛错、不影响情绪模型其它因子）。
 *
 * 缓存两层：
 *   1. 内存 memo（TTL 3 分钟）+ in-flight 去重 —— 情绪模型与前端页签同时要数据时
 *      只发一轮请求（上交所接口对高频调用会 502）。
 *   2. 磁盘 PCF 缓存（按中国自然日）—— 同一自然日内清单不变，跨进程重启也免重抓。
 * refresh=true 绕过内存 memo（磁盘缓存仍生效，因为清单本身就是当日固定的）。
 */
const MEMO_TTL = 3 * 60 * 1000;
let _memo = null;
let _inflight = null;

function getEtfFlow(opts = {}) {
  const refresh = !!opts.refresh;
  if (!refresh && _memo && Date.now() - _memo.at < MEMO_TTL) {
    return Promise.resolve(Object.assign({}, _memo.result, { fromMemo: true }));
  }
  if (_inflight) return _inflight;
  _inflight = _computeEtfFlow(opts)
    .then((r) => { _memo = { at: Date.now(), result: r }; return r; })
    .catch((e) => ({ ok: false, gaps: [`采集异常：${e && e.message ? e.message : e}`], detail: null, factor: null }))
    .finally(() => { _inflight = null; });
  return _inflight;
}

async function _computeEtfFlow(opts = {}) {
  const gaps = [];
  let collected = null;
  try {
    collected = await collect(opts);
  } catch (e) {
    return { ok: false, gaps: [`采集失败：${e && e.message ? e.message : e}`], detail: null, factor: null };
  }
  if (!collected.ok) return { ok: false, gaps: collected.gaps || ['无数据'], detail: null, factor: null };
  gaps.push(...(collected.gaps || []));
  // 采集过程中的非致命错误（某批行情失败、备链不可达等）如实并入 gaps
  const errs = drainErrs();
  if (errs.length) gaps.push(...errs.slice(0, 5));

  const calc = computeFromSnapshots(collected.date);
  if (!calc.ok) {
    return {
      ok: true,
      date: calc.date || collected.date,
      baselineOnly: true,
      reason: calc.reason,
      gaps,
      factor: { score: 0, degraded: true, reason: calc.reason, value: calc.overlap ? '披露未跨日，净申赎无法计算' : '基线日（尚无定稿基期快照）', detail: calc.reason },
      detail: calc,
    };
  }
  if (calc.spanNote) gaps.push(calc.spanNote);

  const totalNet = calc.totalNet;
  const score = scoreOf(totalNet);
  const yi = (v) => (v == null ? '—' : (v / 1e8).toFixed(2) + ' 亿');
  const valid = calc.etfs.filter(e => e.netAmount != null);
  const nBuy = valid.filter(e => e.netAmount > 0).length;
  const nSell = valid.filter(e => e.netAmount < 0).length;
  const value = `${totalNet >= 0 ? '净申购' : '净赎回'} ${yi(Math.abs(totalNet))} · ${nBuy} 只净申购 / ${nSell} 只净赎回`;
  const sessText = calc.settled ? '已收盘定稿' : '盘中读数（收盘后定稿）';
  const detail = `宽基 ETF（${calc.groups.map(g => g.label).join('、')}，有效 ${valid.length} 只）份额较上一收盘 ${calc.baseDate} `
    + `${totalNet >= 0 ? '合计增加' : '合计减少'} → 折算${totalNet >= 0 ? '净申购' : '净赎回'} ${yi(Math.abs(totalNet))}（${sessText}）。`
    + `口径：Δ份额 ÷ 最小申赎单位 = 篮数，再乘每篮成分股数得逐股理论增减量；份额本身是「净」概念，无法拆出申购总量与赎回总量。`;
  return {
    ok: true,
    date: calc.date,              // 20261023j：份额披露日（T-1），不是快照 tradeDate
    snapshotDate: calc.snapshotDate,
    baseDate: calc.baseDate,
    settled: calc.settled,
    gaps,
    factor: {
      score: round(score, 3), degraded: false, value, detail,
      totalNet, ledgerDays: calc.ledgerDays, settleStatus: calc.settled ? 'settled' : 'intraday',
    },
    detail: calc,
  };
}

/**
 * 某只成分股「当月逐日」被宽基 ETF 申购/赎回/净申赎（20261027a 新建；20261027b 修标签口径）。
 * 口径与累计台账一致：只认已定稿(settled)快照；相邻两份快照的 ETF Δ份额 ÷ 申赎单位 = 篮数，
 * 篮数 × 该股在该 ETF 篮子里的股数 = 该股当日理论增减；多只 ETF 含同一股票时按代码合并。
 * 20261027b（用户质询「今日数据怎么来的」）：行标签必须用**份额披露日 shareDate（数据日）**，
 * 不能用快照 tradeDate——快照 20261027 里的份额是 T+1 披露的 20261026 官方值，标成 20261027
 * 会「标注今日、数据是昨天」（与 20261023j 主卡修正同规则）。基期取全量快照链中前一份已定稿
 * 快照（正确处理跨月/跨假期）；披露日不相邻时打 spanNote「多日合计」，绝不吃掉跨度。
 */
function stockMonthlyFlow(code, month) {
  const target = String(code || '').trim();
  if (!target) return { ok: false, error: '缺少股票代码' };
  const prefix = String(month || '').trim() ||
    (function () { const d = new Date(); return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'); })();
  const snaps = listSnapshots()
    .map(d => readJson(snapPath(d), null))
    .filter(s => s && s.settled && Array.isArray(s.etfs))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const rows = [];
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i], p = snaps[i - 1];
    const shareDate = s.shareDate || _prevTd(s.date);
    if (!shareDate || !shareDate.startsWith(prefix)) continue;
    const prevMap = {};
    for (const e of (p.etfs || [])) prevMap[e.code] = e;
    let buy = 0, sell = 0;
    for (const e of s.etfs) {
      const q = prevMap[e.code];
      if (!q || !e.shares || !q.shares || !e.unit) continue;
      const dBaskets = (e.shares - q.shares) / e.unit;
      if (!isFinite(dBaskets) || dBaskets === 0) continue;
      const comp = (e.comps || []).find(c => c && c[0] === target);
      if (!comp) continue;
      const delta = dBaskets * (comp[1] || 0);
      if (delta > 0) buy += delta; else sell += Math.abs(delta);
    }
    const baseShareDate = p.shareDate || _prevTd(p.date);
    const spanNote = (baseShareDate && _prevTd(shareDate) !== baseShareDate)
      ? `多日合计（${baseShareDate}→${shareDate}）` : null;
    rows.push({
      date: shareDate,          // 数据日 = 份额披露日（T+1），不是快照采集日
      snapshotDate: s.date,     // 溯源：哪天的收盘快照取到的
      buy: Math.round(buy), sell: Math.round(sell), net: Math.round(buy - sell),
      spanNote,
    });
  }
  const totals = rows.reduce((a, r) => ({ buy: a.buy + r.buy, sell: a.sell + r.sell, net: a.net + r.net }), { buy: 0, sell: 0, net: 0 });
  return { ok: true, code: target, month: prefix, rows, totals, settledDays: snaps.length };
}

module.exports = {
  GROUPS, DERIV, SHARE_BASE,
  selectUniverse, fetchPcf, fetchShares, tencentQuotes, collect, computeFromSnapshots, scoreOf, getEtfFlow, stockMonthlyFlow,
  sessionSettled, listSnapshots, snapPath, pcfCachePath, LEDGER, NAME_CACHE, DIR,
};
