/**
 * 行业景气度 · 「行业总营收 vs 行业总市值」走势对比
 * ================================================================
 * 用途：个股页「行业分析」tab 下方独立卡片 —— 展示该个股所属**申万二级行业**内
 *       **全部公司**的总营收与总市值的走势比较，并在卡片下方标注行业公司数量等注释。
 *
 * 为什么用「申万二级」层级（而不是一级/三级）：
 *   东方财富两个权威数据集（业绩报表 RPT_LICO_FN_CPD 的 PUBLISHNAME、
 *   估值明细 RPT_VALUEANALYSIS_DET 的 BOARD_NAME）**只按申万二级行业名归类**，
 *   且两边口径完全一致（已实测：证券Ⅱ/半导体/农化制品/医疗器械/保险Ⅱ/调味发酵品Ⅱ 逐一对齐）。
 *   一级/三级名在这两个数据集里取不到 → 只有二级能同时拿到「全行业营收」与「全行业市值」。
 *
 * 数据源（规则一·单一权威源）：
 *   1) 行业成员名单：东方财富板块成分股 push2delay `api/qt/clist/get`（fs=b:BKxxxx，分页取全量）
 *      —— 用于「行业一共包含多少家公司」的权威口径。
 *   2) 行业各报告期营收：东方财富业绩报表 `RPT_LICO_FN_CPD`
 *      filter=(REPORTDATE='<报告期末>')(PUBLISHNAME="<申万二级行业名>")
 *      → 一次请求即返回**该行业全部公司**的累计营业总收入（元）。
 *   3) 行业各报告期末总市值：东方财富估值明细 `RPT_VALUEANALYSIS_DET`
 *      filter=(BOARD_NAME="<申万二级行业名>")(TRADE_DATE>='<回看起点>')(TRADE_DATE<='<报告期末>')
 *      → 季末常落在周末/节假日（如 2024-06-30 为周日），必须用**区间查询**再取区间内最新交易日。
 *
 * 口径说明（规则一·数据一致性）：
 *   - 营收取「累计口径」原值（Q1/H1/Q3/FY 为年内累计），再按标准公式折算
 *     **TTM 滚动12个月 = 上年年报 + 本期累计 − 上年同期累计**（年报期则 TTM = 年报值）；
 *   - 市值取每个报告期末**最近一个交易日**的行业总市值合计（亿元）；
 *   - 明细缺失（未上市/已退市/无市值数据）**不臆造**：该期该股不参与合计，并在
 *     companiesPerPeriod / missing 中如实披露；
 *   - 行业景气度判读（营收增速 vs 市值增速的背离关系）由代码确定性计算，不由 LLM 叙事。
 *
 * 缓存：按 行业名 + 本地日期 落盘 data/cache/industry_prosperity/，TTL 12h。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveStockSectorLevels } = require('./stockSectorLevels');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'industry_prosperity');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12 小时
const PLOT_PERIODS = 12;                     // 图上展示最近 12 个报告期（约 3 年）
const FETCH_PERIODS = 18;                    // 多取 6 期，供 TTM（需回看上年同期+上年年报）
const CONCURRENCY = 4;                       // 受限并发，避免打爆数据源
const MCAP_LOOKBACK_DAYS = 8;                // 市值按报告期末回看天数（覆盖周末+短假）
const MAX_CONSTITUENT_PAGES = 8;             // 成分股分页上限（pz=100/页）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' };
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

// ---------------- 工具 ----------------
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
function cacheFile(industryName) {
  ensureDir();
  return path.join(CACHE_DIR, `${safeName(industryName)}_${localDate()}.json`);
}
function readCache(industryName) {
  try {
    const f = cacheFile(industryName);
    if (!fs.existsSync(f)) return null;
    if (Date.now() - fs.statSync(f).mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}
function writeCache(industryName, data) {
  try { fs.writeFileSync(cacheFile(industryName), JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
}
const round2 = (v) => Math.round(v * 100) / 100;

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

// ---------------- 报告期（季末）工具 ----------------
/** 生成最近 count 个「已披露」报告期末（YYYY-MM-DD），最新在前（不含当前未结束季度） */
function recentQuarterEnds(count, from = new Date()) {
  const out = [];
  let y = from.getFullYear();
  let q = Math.floor(from.getMonth() / 3); // 0=Q1 … 3=Q4（当前季度）
  while (out.length < count) {
    q -= 1;
    if (q < 0) { q = 3; y -= 1; }
    const endMonth = q * 3 + 2;                       // 2/5/8/11 → 3/6/9/12 月
    const lastDay = new Date(y, endMonth + 1, 0).getDate();
    out.push(`${y}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
  }
  return out;
}
/** 同一年内的上一季末 */
function prevQuarterEnd(p) {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  if (m === 3) return `${y - 1}-12-31`;
  if (m === 6) return `${y}-03-31`;
  if (m === 9) return `${y}-06-30`;
  return `${y}-09-30`;
}
/** 上年同期 */
function yearAgo(p) {
  return `${Number(p.slice(0, 4)) - 1}${p.slice(4)}`;
}
function prevYearEnd(p) {
  return `${Number(p.slice(0, 4)) - 1}-12-31`;
}
function isYearEnd(p) { return p.endsWith('-12-31'); }
function periodLabel(p) {
  const y = p.slice(0, 4), m = Number(p.slice(5, 7));
  return `${y}Q${m === 3 ? 1 : m === 6 ? 2 : m === 9 ? 3 : 4}`;
}
function shiftDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------- 数据抓取 ----------------
/** 行业成分股全量（分页，pz=100）：用于「行业一共包含多少家公司」 */
async function fetchConstituents(sectorCode) {
  const all = [];
  const seen = new Set();
  for (let pn = 1; pn <= MAX_CONSTITUENT_PAGES; pn++) {
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20`
      + `&fs=b:${encodeURIComponent(sectorCode)}&fields=f12,f14,f20`;
    let diff = [];
    try {
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
    } catch { diff = []; }
    if (!diff.length) break;
    for (const d of diff) {
      const code = String(d.f12 || '');
      if (code && !seen.has(code)) {
        seen.add(code);
        all.push({ code, name: String(d.f14 || ''), marketCap: Number(d.f20) || 0 });
      }
    }
    if (diff.length < 100) break;   // 末页
  }
  return all;
}

/** 某报告期该行业全部公司的累计营业总收入（Map<code, {name, cum(亿), noticeDate}>） */
async function fetchPeriodRevenue(industryName, period) {
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,NOTICE_DATE';
  const base = `${DC}?reportName=RPT_LICO_FN_CPD&columns=${cols}`
    + `&filter=${encodeURIComponent(`(REPORTDATE='${period}')(PUBLISHNAME="${industryName}")`)}&pageSize=500`;
  const m = new Map();
  let count = null;
  let maxNotice = '';
  const maxPages = 6;
  for (let pn = 1; pn <= maxPages; pn++) {
    let rows = [], cnt = null;
    try {
      const { data } = await axios.get(`${base}&pageNumber=${pn}`, { headers: HEADERS, timeout: 30000 });
      const res = (data && data.result) || {};
      rows = Array.isArray(res.data) ? res.data : [];
      cnt = res.count;
    } catch { rows = []; }
    if (cnt != null) count = cnt;
    for (const r of rows) {
      const code = String(r.SECURITY_CODE || '');
      if (!code) continue;
      const nd = r.NOTICE_DATE ? String(r.NOTICE_DATE).slice(0, 10) : '';
      if (nd && nd > maxNotice) maxNotice = nd;
      const inc = Number(r.TOTAL_OPERATE_INCOME);
      if (!isFinite(inc) || inc <= 0) continue;
      m.set(code, {
        name: String(r.SECURITY_NAME_ABBR || ''),
        cum: round2(inc / 1e8),                       // 元 → 亿元
        noticeDate: nd,
      });
    }
    if (!rows.length || (cnt != null && pn * 500 >= cnt)) break;
  }
  return { map: m, count, noticeDate: maxNotice };
}

/** 某报告期末（最近交易日）该行业全部公司的总市值合计 */
async function fetchPeriodMarketCap(industryName, period) {
  const from = shiftDays(period, -MCAP_LOOKBACK_DAYS);
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,TOTAL_MARKET_CAP';
  const url = `${DC}?reportName=RPT_VALUEANALYSIS_DET&columns=${cols}`
    + `&filter=${encodeURIComponent(`(BOARD_NAME="${industryName}")(TRADE_DATE>='${from}')(TRADE_DATE<='${period}')`)}`
    + `&pageSize=2000&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1`;
  let rows = [];
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
    rows = ((data && data.result && data.result.data) || []);
  } catch { rows = []; }
  if (!rows.length) return { date: '', total: null, map: new Map(), count: 0 };
  // 取区间内最新交易日
  const dates = rows.map(r => String(r.TRADE_DATE || '').slice(0, 10)).filter(Boolean);
  const latest = dates.sort().pop();
  const map = new Map();
  let sum = 0;
  for (const r of rows) {
    if (String(r.TRADE_DATE || '').slice(0, 10) !== latest) continue;
    const code = String(r.SECURITY_CODE || '');
    const cap = Number(r.TOTAL_MARKET_CAP);
    if (!code || !isFinite(cap) || cap <= 0) continue;
    map.set(code, round2(cap / 1e8));                 // 元 → 亿元
    sum += cap / 1e8;
  }
  return { date: latest, total: map.size ? round2(sum) : null, map, count: map.size };
}

// ---------------- 主函数 ----------------
/**
 * @param {string} symbol 个股代码（如 '600909'）
 * @param {object} [opts]
 * @param {string} [opts.name] 个股名称（回显用）
 * @param {boolean} [opts.force] 忽略缓存
 * @param {number} [opts.periods] 展示报告期数（默认 12）
 * @returns {Promise<object>}
 */
async function getIndustryProsperity(symbol, opts = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) return { success: false, error: 'NO_SYMBOL', message: '缺少个股代码' };
  const force = !!opts.force;
  const plotN = Math.min(Math.max(Number(opts.periods) || PLOT_PERIODS, 4), 20);
  const stockName = String(opts.name || '').trim();

  // 1) 解析所属申万行业层级，锁定「二级」
  let levels = [];
  let sectorCode = '', industryName = '';
  try {
    const lv = await resolveStockSectorLevels(sym, { name: stockName, force: false });
    levels = (lv && Array.isArray(lv.levels)) ? lv.levels : [];
  } catch (e) {
    return { success: false, error: 'SECTOR_RESOLVE_FAILED', message: '解析所属行业失败：' + (e && e.message) };
  }
  const lv2 = levels.find(x => x.swLevel === '二级') || null;
  if (!lv2 || !lv2.sectorName) {
    return {
      success: false, error: 'NO_SW2_SECTOR',
      message: '未解析到该股的申万二级行业（营收/市值全行业口径仅二级可对齐），暂不展示行业景气度。',
      levels,
    };
  }
  sectorCode = lv2.sectorCode || '';
  industryName = lv2.sectorName;

  // 2) 缓存
  const cacheKey = industryName;
  if (!force) {
    const cached = readCache(cacheKey);
    if (cached && cached.success && Array.isArray(cached.periods) && cached.periods.length) {
      return { ...cached, symbol: sym, stockName, levels, cached: true };
    }
  }

  // 3) 报告期列表 + 行业成员名单 并行取
  const candidates = recentQuarterEnds(FETCH_PERIODS);
  const [revList, constituents] = await Promise.all([
    mapLimit(candidates, CONCURRENCY, (p) => fetchPeriodRevenue(industryName, p)),
    fetchConstituents(sectorCode).catch(() => []),
  ]);

  // 4) 只保留「确有该行业营收数据」的报告期（升序）
  const periodsWithData = candidates
    .map((p, i) => ({ period: p, res: revList[i] }))
    .filter(x => x.res && x.res.map && x.res.map.size > 0)
    .map(x => ({ period: x.period, map: x.res.map, noticeDate: (x.res && x.res.noticeDate) || '' }))
    .sort((a, b) => a.period.localeCompare(b.period));

  if (periodsWithData.length < 2) {
    return {
      success: false, error: 'NO_REVENUE_DATA',
      message: `未取到「${industryName}」行业的历史营收数据（数据源未覆盖或行业名不匹配），暂不展示行业景气度。`,
      industry: { swLevel: '二级', sectorCode, sectorName: industryName }, levels,
    };
  }
  const revByPeriod = new Map(periodsWithData.map(x => [x.period, x.map]));
  const noticeByPeriod = new Map(periodsWithData.map(x => [x.period, x.noticeDate]));
  // 展示期 = 最新 plotN 期
  const plotPeriods = periodsWithData.slice(Math.max(0, periodsWithData.length - plotN)).map(x => x.period);

  // 5) 各展示期市值得（并行）
  const mcapList = await mapLimit(plotPeriods, CONCURRENCY, (p) => fetchPeriodMarketCap(industryName, p));

  // 6) 逐期聚合：TTM 营收 / 单季营收 / 总市值 / 参与公司数
  const revenueTTM = [], revenueSingle = [], marketCap = [], companiesPerPeriod = [], mcapDates = [];
  for (let i = 0; i < plotPeriods.length; i++) {
    const p = plotPeriods[i];
    const cumMap = revByPeriod.get(p) || new Map();

    // 该期营收口径下出现过的全部代码（含缺 TTM 所需的）
    let ttmSum = 0, ttmCnt = 0, sgSum = 0, sgCnt = 0;
    for (const [code, rec] of cumMap) {
      // TTM
      let ttm = null;
      if (isYearEnd(p)) {
        ttm = rec.cum;
      } else {
        const fy = revByPeriod.get(prevYearEnd(p));
        const same = revByPeriod.get(yearAgo(p));
        const fyV = fy ? fy.get(code) : null;
        const sameV = same ? same.get(code) : null;
        if (fyV && sameV && isFinite(fyV.cum) && isFinite(sameV.cum)) {
          ttm = round2(fyV.cum + rec.cum - sameV.cum);
        }
      }
      if (ttm != null && ttm > 0) { ttmSum += ttm; ttmCnt++; }

      // 单季（供 tooltip/注释）
      let sg = null;
      if (p.endsWith('-03-31')) sg = rec.cum;
      else {
        const pq = revByPeriod.get(prevQuarterEnd(p));
        const pqV = pq ? pq.get(code) : null;
        if (pqV && isFinite(pqV.cum)) sg = round2(rec.cum - pqV.cum);
      }
      if (sg != null && sg > 0) { sgSum += sg; sgCnt++; }
    }

    const mc = mcapList[i] || { total: null, count: 0, date: '' };
    revenueTTM.push(ttmCnt ? round2(ttmSum) : null);
    revenueSingle.push(sgCnt ? round2(sgSum) : null);
    marketCap.push(mc.total);
    companiesPerPeriod.push({ period: p, revenue: ttmCnt, marketCap: mc.count });
    mcapDates.push(mc.date || '');
  }

  // 7) 行业公司总数（权威口径 = 板块成分股）与覆盖度
  const memberCodes = new Set(constituents.map(x => x.code));
  const latestRevMap = revByPeriod.get(plotPeriods[plotPeriods.length - 1]) || new Map();
  const latestMc = mcapList[mcapList.length - 1] || { map: new Map() };
  const latestMcMap = latestMc.map || new Map();
  const revCodes = new Set();
  revByPeriod.forEach(mp => mp.forEach((_v, c) => revCodes.add(c)));
  latestMcMap.forEach((_v, c) => revCodes.add(c));

  // 全行业成员（并集：板块成分 ∪ 营收口径 ∪ 市值口径），缺数据者显式列出
  const universeCodes = new Set();
  memberCodes.forEach(c => universeCodes.add(c));
  revCodes.forEach(c => universeCodes.add(c));

  const nameOf = new Map();
  constituents.forEach(x => nameOf.set(x.code, x.name));
  latestRevMap.forEach((v, c) => { if (!nameOf.get(c)) nameOf.set(c, v.name); });
  latestMcMap.forEach((_v, c) => { if (!nameOf.get(c)) nameOf.set(c, ''); });

  const missing = [];
  universeCodes.forEach(c => {
    const hasRev = revCodes.has(c);
    const hasMc = latestMcMap.has(c);
    if (!hasRev || !hasMc) {
      missing.push({ code: c, name: nameOf.get(c) || '', noRevenue: !hasRev, noMarketCap: !hasMc });
    }
  });

  // 8) 最新一期统计与同比
  const nP = plotPeriods.length;
  const last = nP - 1;
  const lastPeriod = plotPeriods[last];
  const lastTTM = revenueTTM[last];
  const lastSingle = revenueSingle[last];
  const lastMc = marketCap[last];

  // 同比：TTM 与市值均与「4 个报告期前」比较（季度序列天然年距）
  const yoyOf = (arr, idx) => {
    const prevIdx = idx - 4;
    const a = arr[idx], b = prevIdx >= 0 ? arr[prevIdx] : null;
    if (a == null || b == null || b <= 0) return null;
    return round2((a / b - 1) * 100);
  };
  const revTTMYoY = yoyOf(revenueTTM, last);
  const mcYoY = yoyOf(marketCap, last);

  // 9) 景气度判读（确定性规则，代码计算，不由 LLM 叙事）
  let verdict = null;
  if (revTTMYoY != null && mcYoY != null) {
    const revUp = revTTMYoY > 0, mcUp = mcYoY > 0;
    if (revUp && mcUp) {
      verdict = { tag: '景气上行', tone: 'bull', text: `行业营收（TTM）同比 ${revTTMYoY >= 0 ? '+' : ''}${revTTMYoY}%、总市值同比 ${mcYoY >= 0 ? '+' : ''}${mcYoY}%，量价同向向上，景气与市场定价共振。` };
    } else if (revUp && !mcUp) {
      verdict = { tag: '基本面改善·市场未反映', tone: 'neutral', text: `行业营收（TTM）同比 +${revTTMYoY}%，但总市值同比 ${mcYoY}%。基本面在改善而市值回落，景气度领先于股价，注意是否被低估。` };
    } else if (!revUp && mcUp) {
      verdict = { tag: '估值扩张·景气未跟上', tone: 'bear', text: `行业营收（TTM）同比 ${revTTMYoY}%，但总市值同比 +${mcYoY}%。市值上行快于基本面，属估值扩张，需警惕景气证伪后的回落风险。` };
    } else {
      verdict = { tag: '景气下行', tone: 'bear', text: `行业营收（TTM）同比 ${revTTMYoY}%、总市值同比 ${mcYoY}%，量价同向走弱，行业景气处于下行区间。` };
    }
  }

  // 口径提示（规则一·数据一致性）：成员数随报告期变动时，同比含「新股上市/退市」影响，须显式说明
  const caveats = [];
  const revCntFirst = companiesPerPeriod[0] ? companiesPerPeriod[0].revenue : 0;
  const revCntLast = companiesPerPeriod[last] ? companiesPerPeriod[last].revenue : 0;
  if (revCntFirst !== revCntLast) {
    caveats.push(`各报告期纳入的营收公司数不同（最早 ${revCntFirst} 家 → 最新 ${revCntLast} 家，含新股上市/退市），同比增速含成员变动影响，非纯内生增长。`);
  }
  if (missing.length) {
    caveats.push(`另有 ${missing.length} 家公司未纳入合计（无营收或市值数据），已在下方注明。`);
  }
  if (marketCap.some(v => v == null)) {
    caveats.push('部分报告期缺行业总市值数据（数据源未覆盖），该点以断线表示。');
  }
  const maxNotice = noticeByPeriod.get(lastPeriod) || '';

  const result = {
    success: true,
    symbol: sym,
    stockName,
    industry: { swLevel: '二级', sectorCode, sectorName: industryName },
    levels,
    periods: plotPeriods,
    periodLabels: plotPeriods.map(periodLabel),
    revenueTTM,                 // 亿元（TTM 滚动12个月，全行业合计）
    revenueSingle,              // 亿元（单季，全行业合计）
    marketCap,                  // 亿元（报告期末最近交易日，全行业合计）
    mcapDates,                  // 各期市值对应的实际交易日
    companiesPerPeriod,         // 各期参与合计的公司数（营收/市值）
    industryCompanyCount: constituents.length || universeCodes.size,   // 行业一共包含多少家公司
    universeCount: universeCodes.size,
    coveredRevenue: companiesPerPeriod[last] ? companiesPerPeriod[last].revenue : 0,
    coveredMarketCap: companiesPerPeriod[last] ? companiesPerPeriod[last].marketCap : 0,
    missing,
    caveats,
    latest: {
      period: lastPeriod,
      label: periodLabel(lastPeriod),
      revenueTTM: lastTTM,
      revenueSingle: lastSingle,
      revenueTTMYoY: revTTMYoY,
      marketCap: lastMc,
      marketCapYoY: mcYoY,
      noticeDate: maxNotice,
    },
    verdict,
    unit: '亿元',
    date: mcapDates[last] || lastPeriod,
    source: `东方财富（行业营收：业绩报表 RPT_LICO_FN_CPD 按申万二级「${industryName}」全量汇总；行业总市值：估值明细 RPT_VALUEANALYSIS_DET 同行业口径；成员数：板块成分股）`,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  writeCache(cacheKey, result);
  return result;
}

module.exports = { getIndustryProsperity };
