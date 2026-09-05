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
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const klt = period === '60m' ? 60 : period === 'week' ? 102 : period === 'month' ? 103 : 101;
  const fqt = period === '60m' ? 0 : 1;
  // 60分钟数据仅保留近端区间，beg 取最近 120 个自然日，避免起止区间过宽导致接口返回空
  let begDate = '20100101';
  if (period === '60m') {
    const d = new Date();
    d.setDate(d.getDate() - 120);
    begDate = d.toISOString().slice(0, 10).replace(/-/g, '');
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

  // 解析行情时间（fields[30] 形如 "2026-08-03 15:00:02" 或 "20260803 15:00:02"）
  const dtRaw = fields[30] || '';
  let qtDate = '', qtTime = '';
  const dm = dtRaw.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (dm) qtDate = `${dm[1]}-${dm[2]}-${dm[3]}`;
  const tm = dtRaw.match(/(\d{2}):(\d{2})/);
  if (tm) qtTime = `${tm[1]}:${tm[2]}`;
  if (!qtDate) {
    const now = new Date();
    qtDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  return {
    name: fields[1],
    code: fields[2],
    price,
    prevClose,
    date: qtDate,
    time: qtTime,
    open: parseFloat(fields[5]) || 0,
    high: parseFloat(fields[33]) || 0,
    low: parseFloat(fields[34]) || 0,
    change,
    changePct,
    volume: volume * 100, // 转为股
    amount: amount * 10000,
    turnover,
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
  // 顶栏大盘行情状态栏：按用户指定顺序展示的 8 个核心指数
  topbar: [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000688', name: '科创50' },
    { code: 'bj899050', name: '北证50' },
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

async function getMarketOverview() {
  // 合并 cn / us / sectors / topbar 四组，按 code 去重后一次性请求（腾讯接口支持逗号分隔批量）
  const seen = new Set();
  const all = [...MARKET_INDEX_GROUPS.cn, ...MARKET_INDEX_GROUPS.us, ...MARKET_INDEX_GROUPS.sectors, ...MARKET_INDEX_GROUPS.topbar]
    .filter(i => (seen.has(i.code) ? false : (seen.add(i.code), true)));
  const url = `https://qt.gtimg.cn/q=${all.map(i => i.code).join(',')}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000,
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(Buffer.from(resp.data), 'GBK');

  function parse(code) {
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
  let sectorError = null;
  try {
    sectorBlock = await getThsSectorRanking();
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
      sectorDate: new Date().toISOString().slice(0, 10),
    };
  }
  // 当最终不是东方财富源时，给出明确提示，避免用户拿不同口径的榜单去对比东财行情软件。
  if (!sectorBlock.sectorIsEastmoney && sectorBlock.sectorSource !== '同花顺·行业板块') {
    sectorBlock.sectorWarning = '东方财富实时板块接口(push2)受限，已回退其他数据源；其分类口径与东方财富「行业板块」不同，请勿直接对比东方财富数据';
  } else if (sectorBlock.sectorSource === '同花顺·行业板块') {
    sectorBlock.sectorNote = '分类口径为同花顺申万一级行业，与东方财富行情软件「行业板块」基本一致（个别板块命名/细分程度略有差异）';
  }

  return {
    cn: group(MARKET_INDEX_GROUPS.cn),
    us: group(MARKET_INDEX_GROUPS.us),
    topbar: group(MARKET_INDEX_GROUPS.topbar),
    sectorsUp: sectorBlock.sectorsUp,
    sectorsDown: sectorBlock.sectorsDown,
    sectorSource: sectorBlock.sectorSource,
    sectorIsEastmoney: !!sectorBlock.sectorIsEastmoney,
    sectorWarning: sectorBlock.sectorWarning || null,
    sectorNote: sectorBlock.sectorNote || null,
    sectorTotal: sectorBlock.sectorTotal,
    sectorUpCount: sectorBlock.sectorUpCount,
    sectorDownCount: sectorBlock.sectorDownCount,
    sectorFlatCount: sectorBlock.sectorFlatCount,
    sectorDate: sectorBlock.sectorDate,
    sectorAll: sectorBlock.allSectors || null,   // 全量板块（含成交额），供行业拥挤度计算
    updatedAt: Date.now()
  };
}

// ---- 同花顺 行业板块 实时涨跌排名（本机网络最稳定）----
// 东方财富 push2 在本机常被 TLS 重置/连接掐断，返回的数据既不及时也不完整。
// 同花顺行业板块一览（90 个申万一级行业口径）与东方财富行情软件「行业板块」高度对应，
// 且本机可稳定访问，故作为首页板块排名的首选数据源。
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
    changePct: s.changePct || 0,
    amount: s.amount || 0,        // 板块当日总成交额（亿元）
    upCount: s.upCount || 0,
    downCount: s.downCount || 0,
    leader: s.leader || '',
    unavailable: false,
  }));
  if (list.length < 30) throw new Error('同花顺板块数据不足: ' + list.length);
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    allSectors: list,             // 全量板块（含成交额），供行业拥挤度模块使用
    sectorSource: '同花顺·行业板块',
    sectorIsEastmoney: false,
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: parsed.date || new Date().toISOString().slice(0, 10),
  };
  _thsSectorCache = { ts: now, data: result };
  return result;
}

// 探测 Python 解释器：结果记忆化，整个进程只探测一次；且改为异步，
// 不再用同步 execFileSync 阻塞事件循环（避免分析期间服务端冻结、其他请求排队）。
let _pyBinChecked = false;
let _pyBinCache = null;
async function findPythonForScript() {
  if (_pyBinChecked) return _pyBinCache;
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
  _pyBinChecked = true;
  return null;
}

// ---- 东方财富 行业板块 实时涨跌排名（真正的"板块涨跌幅榜"）----
// 替代原先仅 12 个中证/国证指数的做法（样本太小、不具代表性，今日全样本下跌时
// 会错误地把"跌幅最小的板块"当成"涨幅前五"）
let _sectorRankingCache = { ts: 0, data: null };
async function getEastmoneySectorRanking() {
  const now = Date.now();
  if (_sectorRankingCache.data && now - _sectorRankingCache.ts < 30000) {
    return _sectorRankingCache.data;
  }
  // 东方财富「行业板块」实时排名：fs=m:90+t:2（BK 行业板块，与东方财富官网板块榜一致）。
  // 本机网络常屏蔽 push2.eastmoney.com（TLS 重置 / 连接被掐），故按顺序尝试多个东财镜像主机，
  // 任一可达即采用；全部失败才抛出错误，由上层回退到其他数据源。
  const hosts = [
    'https://push2.eastmoney.com',
    'https://push2delay.eastmoney.com',
    'https://82.push2.eastmoney.com',
    'https://16.push2.eastmoney.com',
  ];
  const path = '/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f2,f3,f62';
  let diff = null;
  let lastErr = null;
  for (const host of hosts) {
    const url = host + path;
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
      diff = resp.data?.data?.diff || [];
      if (Array.isArray(diff) && diff.length) break;
    } catch (e) {
      lastErr = e;
      // Node 的 TLS 指纹被中间设备重置时，用系统 curl（schannel）二次尝试
      try {
        const out = await execFileAsync('curl', ['-s', '--max-time', '10', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const json = JSON.parse(out.stdout);
        diff = json?.data?.diff || [];
        if (Array.isArray(diff) && diff.length) break;
      } catch (e2) {
        lastErr = e2;
      }
    }
  }
  if (!Array.isArray(diff) || diff.length === 0) {
    throw new Error('东方财富行业板块获取失败(全部镜像不可达): ' + (lastErr && lastErr.message));
  }
  const list = diff.map(d => ({
    code: d.f12,
    name: d.f14,
    price: parseFloat(d.f2) || 0,
    changePct: parseFloat(d.f3) || 0,
    mainFlow: parseFloat(d.f62) || 0,
    unavailable: false,
  }));
  // 涨幅前五：只从实际上涨的板块中取；跌幅前五：只从实际下跌的板块中取。
  // 普涨/普跌时，避免把“涨幅最小的板块”误标为跌幅前五，或反之。
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    sectorSource: '东方财富·行业板块',
    sectorIsEastmoney: true,
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: new Date().toISOString().slice(0, 10),
  };
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
    sectorDate: new Date().toISOString().slice(0, 10),
  };
  _tencentSectorCache = { ts: now, data: result };
  return result;
}

async function fetchTencentHistory(tencentCode, count = 320) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},qfq`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 8000
  });
  const data = resp.data;
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];

  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: parseFloat(d[5]) || 0
  }));
}

// 腾讯日K按结束日期分段（单段上限约800根，count>800 会返回空）
async function fetchTencentHistoryEndingAt(tencentCode, endDate, count = 800) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,${endDate},${count},qfq`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000
  });
  const data = resp.data;
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];
  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: parseFloat(d[5]) || 0
  }));
}

// 长历史日K（约10年）：腾讯单次上限约800根，向前分段拼接（供价格行为趋势推演使用）
async function getHistoryDeep(input, totalBars = 2400) {
  const info = detectMarket(input);
  if (info.market !== 'CN' && info.market !== 'HK') {
    return getHistory(input, '5y'); // 美股/其他市场沿用原通道
  }
  const SEG = 800;
  const seen = new Set();
  const all = [];
  let endDate = ''; // 空 = 最新
  for (let seg = 0; seg < Math.ceil(totalBars / SEG); seg++) {
    let bars;
    try {
      bars = await fetchTencentHistoryEndingAt(info.tencentCode, endDate, SEG);
    } catch (e) {
      console.error(`Tencent history segment ${seg + 1} failed:`, e.message);
      break;
    }
    if (!Array.isArray(bars) || bars.length === 0) break;
    let newOnes = 0;
    for (const b of bars) {
      if (!seen.has(b.date)) { seen.add(b.date); all.push(b); newOnes++; }
    }
    const firstDate = bars[0].date;
    if (newOnes === 0) break; // 无新数据
    if (endDate !== '' && firstDate >= endDate) break; // API 忽略结束日期，无法继续回溯
    endDate = firstDate; // 下一段以本段最早日期为结束日（该日会去重）
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  return all;
}

// 腾讯 60分钟 K线（东财 push2his 在本机被 TLS 阻断，腾讯 mkline 稳定可用）
// 返回结构与日K一致：{ date:'YYYY-MM-DD HH:mm', open, close, high, low, volume(手), amount(元), turnover }
async function fetchTencentKline60m(tencentCode, count = 320) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tencentCode},m60,,${count}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000,
  });
  const data = resp.data?.data?.[tencentCode];
  const bars = data?.m60 || [];
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.map(b => {
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
}

// Tencent minute data
async function fetchTencentMinutes(tencentCode) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tencentCode}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 8000
    });
    const data = resp.data?.data?.[tencentCode];
    if (!data) return { minutes: [], prevClose: 0 };
    const entries = data.data?.data || [];
    // 昨收：与 fetchTencentQuote 同一口径，腾讯 qt 数组 index[4] 为昨收
    let prevClose = 0;
    const qtArr = data.qt?.[tencentCode];
    if (Array.isArray(qtArr) && qtArr.length > 4) {
      const v = parseFloat(qtArr[4]);
      if (!isNaN(v) && v > 0) prevClose = v;
    }
    const minutes = entries.map(e => {
      const parts = e.split(' ');
      const price = parseFloat(parts[1]);
      const cumVol = parseFloat(parts[2]) || 0; // 累计成交量（手）
      const cumAmt = parseFloat(parts[3]) || 0; // 累计成交额（元）
      const avg = cumVol > 0 ? cumAmt / (cumVol * 100) : price; // 均价 = 累计成交额 / 累计成交股数
      return { time: parts[0], price, avg };
    });
    return { minutes, prevClose };
  } catch {
    return { minutes: [], prevClose: 0 };
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
  // 根据当前月份推断最新可得季报：Q1 5月、Q2 8月、Q3 11月、年报次年4月
  const month = now.getMonth() + 1;
  let q;
  if (month >= 5 && month <= 7) q = 1;
  else if (month >= 8 && month <= 10) q = 2;
  else if (month >= 11) q = 3;
  else if (month >= 1 && month <= 4) { q = 4; year -= 1; }
  else q = 4; // 5月之前但年报已出，取年报
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
      result.revenueYoy = d.TOTALOPERATEREVETZ || d.DJD_TOI_YOY || d2.TOTALOPERATEREVETZ || 0; // 营收同比增长率
      result.profitYoy = d.PARENTNETPROFITTZ || d.DJD_DPNP_YOY || d2.PARENTNETPROFITTZ || 0;   // 归母净利润同比增长率
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

module.exports = { detectMarket, getQuote, getHistory, getHistoryPeriod, getHistoryDeep, getEastmoneyTurnover, searchStocks, fetchTencentMinutes, fetchEastmoneyHistory, getEastmoneySecid, getMarketOverview, findPythonForScript };
