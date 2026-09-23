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
