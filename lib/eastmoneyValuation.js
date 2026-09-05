/**
 * 东方财富 TTM 估值历史抓取
 * 使用 datacenter-web 的 RPT_VALUEANALYSIS_DET 接口，返回每日 TTM 估值
 * （PE_TTM / PB_MRQ / PS_TTM），用于估值分析改用真实 TTM 口径并补充当年(2026)数据空缺。
 */
const axios = require('axios');

const CACHE = new Map(); // secucode -> { ts, data }
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时

function toSecucode(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.includes('.')) {
    const [code, exch] = s.split('.');
    const suffix = (exch || '').toLowerCase() === 'sh' ? 'SH' : 'SZ';
    return `${code}.${suffix}`;
  }
  const m = s.match(/^(sh|sz)?(\d{6})$/i);
  if (!m) return s;
  const code = m[2];
  const exch = m[1] ? m[1].toLowerCase() : (code.startsWith('6') ? 'sh' : 'sz');
  return `${code}.${exch === 'sh' ? 'SH' : 'SZ'}`;
}

function round2(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * 抓取东方财富 TTM 估值历史
 * @param {string} symbol 形如 sh601318 / 601318 / 601318.SH
 * @returns {Promise<{series:Array,latest:Object,source:string}|null>}
 *   series: [{ year, date, pe, pb, ps, marketCap(亿元), close, isCurrent }]  按年份升序
 */
async function fetchValuationTTM(symbol) {
  const secucode = toSecucode(symbol);
  if (!secucode) return null;
  const cached = CACHE.get(secucode);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const cols = 'TRADE_DATE,PE_TTM,PB_MRQ,PS_TTM,CLOSE_PRICE,TOTAL_MARKET_CAP';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=2000&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=${cols}&filter=(SECUCODE=%22${secucode}%22)`;

  const r = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' },
    timeout: 20000,
  });
  const rows = (r.data && r.data.result && r.data.result.data) || [];
  if (!rows.length) return null;

  // 降序返回：每个年份首条 = 该年最后交易日(年末)TTM 值；最新一条即为当前 TTM
  const byYear = {};
  let latest = null;
  for (const d of rows) {
    const date = String(d.TRADE_DATE || '').slice(0, 10);
    const y = date.slice(0, 4);
    if (!y) continue;
    if (!byYear[y]) byYear[y] = d; // 降序下首次出现 = 年末
    if (!latest) latest = d;
  }

  // 规则三（变化与边际分析）需要日频/期频序列：保留原始交易日序列（升序），
  // 仅追加字段、不改变既有 series/latest 结构，不影响现有消费方。
  const daily = rows
    .map(d => ({
      date: String(d.TRADE_DATE || '').slice(0, 10),
      pe: round2(d.PE_TTM),
      pb: round2(d.PB_MRQ),
      ps: round2(d.PS_TTM),
      close: d.CLOSE_PRICE != null ? Number(d.CLOSE_PRICE) : null,
      marketCap: round2((Number(d.TOTAL_MARKET_CAP) || 0) / 1e8),
    }))
    .filter(d => d.date && d.pe > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const curYear = String(new Date().getFullYear());
  const series = Object.keys(byYear).sort().map((y) => {
    const d = byYear[y];
    return {
      year: y,
      date: String(d.TRADE_DATE || '').slice(0, 10),
      pe: round2(d.PE_TTM),
      pb: round2(d.PB_MRQ),
      ps: round2(d.PS_TTM),
      marketCap: round2((Number(d.TOTAL_MARKET_CAP) || 0) / 1e8),
      close: d.CLOSE_PRICE,
      isCurrent: y === curYear,
    };
  });

  if (!series.length) return null;

  const data = {
    series,
    daily,                                   // 规则三：日频序列（升序），用于变化率/边际计算
    latest: {
      year: String(latest.TRADE_DATE || '').slice(0, 4),
      date: String(latest.TRADE_DATE || '').slice(0, 10),
      pe: round2(latest.PE_TTM),
      pb: round2(latest.PB_MRQ),
      ps: round2(latest.PS_TTM),
      marketCap: round2((Number(latest.TOTAL_MARKET_CAP) || 0) / 1e8),
    },
    source: '东方财富TTM',
    fetchedAt: new Date().toISOString(),      // 规则一②：获取时间（五要素之一）
  };
  CACHE.set(secucode, { ts: Date.now(), data });
  return data;
}

module.exports = { fetchValuationTTM };
