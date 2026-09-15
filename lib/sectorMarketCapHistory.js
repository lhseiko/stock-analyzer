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

/** 拉取板块成分股名单（代码 / 名称 / 最新总市值，单位：元） */
async function fetchConstituents(sectorCode) {
  const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:${encodeURIComponent(sectorCode)}&fields=f12,f14,f20,f21`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
  const list = diff
    .map(d => ({ code: String(d.f12 || ''), name: String(d.f14 || ''), marketCap: Number(d.f20) || 0 }))
    .filter(d => d.code);
  return list;
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

  // 1) 成分股
  let all = [];
  try {
    all = await fetchConstituents(code);
  } catch (e) {
    return { success: false, error: 'CONSTITUENT_FETCH_FAILED', message: '获取板块成分股失败：' + (e && e.message) };
  }
  if (!all.length) {
    return { success: false, error: 'NO_CONSTITUENTS', message: `板块 ${code} 未返回成分股（可能代码有误或数据源受限）` };
  }

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
