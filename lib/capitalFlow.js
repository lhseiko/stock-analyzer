/**
 * Capital Flow & Volume Analysis Module
 * 资金量能分析 — 量价关系、资金流向、量能指标、融资融券
 */
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 本地小工具（与各消费模块原同名函数逐行等价，保证 20261017a 收敛迁入后数值不变）
const _round = (n, d = 2) => {
  if (n === null || n === undefined || isNaN(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};
const _clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const _avg = (a) => (a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/**
 * Fetch URL using curl with forced IPv4 (Eastmoney push2his IPv6 is broken)
 * 改为异步 execFile（不使用 shell），既避免 cmd.exe 括号解析问题，又不阻塞事件循环。
 */
async function fetchWithCurl(url, timeoutMs = 10000) {
  const args = [
    '-4', '-s',
    '--connect-timeout', '5',
    '--max-time', String(Math.floor(timeoutMs / 1000)),
    '-H', 'User-Agent: Mozilla/5.0',
    '-H', 'Referer: https://quote.eastmoney.com/',
    url,
  ];
  try {
    const result = await execFileAsync('curl', args, {
      timeout: timeoutMs + 5000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (e) {
    throw new Error(`curl failed: ${e.message}`);
  }
}

/**
 * 获取每日资金流向（主力净流入/流出）
 * Eastmoney push2his fflow daykline API
 * Note: push2/push2his domains block Node.js TLS, so we use curl as fallback
 */
async function fetchDailyMoneyFlow(symbol) {
  const { getEastmoneySecid } = require('./stockData');
  const secid = getEastmoneySecid(symbol);
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=120&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;

  // Try axios first (will fail if IPv6 is broken), then fall back to curl with -4
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
      timeout: 8000,
    });
    const klines = resp.data?.data?.klines || [];
    if (klines.length > 0) return parseMoneyFlowKlines(klines);
  } catch (e) {
    console.log(`[CapitalFlow] Money flow axios failed: ${e.message}, falling back to curl...`);
  }

  // Fallback: use curl
  try {
    const raw = await fetchWithCurl(url, 10000);
    const data = JSON.parse(raw);
    const klines = data?.data?.klines || [];
    if (klines.length > 0) {
      console.log(`[CapitalFlow] Money flow fetched via curl: ${klines.length} days`);
      return parseMoneyFlowKlines(klines);
    }
  } catch (e) {
    console.error('[CapitalFlow] Money flow curl fallback failed:', e.message);
  }
  return [];
}

function parseMoneyFlowKlines(klines) {
  // Each line: date,mainNet,smallNet,mediumNet,largeNet,superLargeNet,mainPct,smallPct,mediumPct,largePct,superLargePct,closePrice,changePct
  return klines.map(k => {
    const p = k.split(',');
    return {
      date: p[0],
      mainNet: parseFloat(p[1]) || 0,        // 主力净流入(元) = 大单 + 超大单
      smallNet: parseFloat(p[2]) || 0,       // 小单净流入
      mediumNet: parseFloat(p[3]) || 0,      // 中单净流入
      largeNet: parseFloat(p[4]) || 0,       // 大单净流入
      superLargeNet: parseFloat(p[5]) || 0,  // 超大单净流入
      mainPct: parseFloat(p[6]) || 0,
      smallPct: parseFloat(p[7]) || 0,
      mediumPct: parseFloat(p[8]) || 0,
      largePct: parseFloat(p[9]) || 0,
      superLargePct: parseFloat(p[10]) || 0,
    };
  });
}

/**
 * 获取融资融券数据
 * Eastmoney datacenter API — reportName=RPTA_WEB_RZRQ_GGMX (updated 2025)
 * Old report name RPT_RZRQ_RZRQMX is deprecated and returns "报表配置不存在"
 */
async function fetchMarginTrading(symbol) {
  const stockCode = symbol.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&filter=(SCODE=%22${stockCode}%22)&pageSize=60&pageNumber=1&sortColumns=DATE&sortTypes=-1`;

  // 最多 2 次（1 次重试），每次自带硬超时，避免东财不可达时长时间阻塞整条 capital-flow 链路
  const callOnce = () => axios.get(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
    timeout: 4000,
  });
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('margin-timeout')), ms)),
  ]);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await withTimeout(callOnce(), 4000);
      const data = resp.data?.result?.data;
      if (!data || data.length === 0) return { hasData: false, data: [], degraded: true };

      const marginData = data.map(d => ({
        date: (d.DATE || '').slice(0, 10),
        tradeDate: (d.DATE || '').slice(0, 10),
        rzBalance: parseFloat(d.RZYE) || 0,         // 融资余额(元)
        rzBuy: parseFloat(d.RZMRE) || 0,            // 融资买入额(元)
        rzRepay: parseFloat(d.RZCHE) || 0,          // 融资偿还额(元)
        rzNetBuy: parseFloat(d.RZJME) || 0,         // 融资净买入(元)
        rqBalance: parseFloat(d.RQYE) || 0,         // 融券余额(元)
        rqVolume: parseFloat(d.RQYL) || 0,          // 融券余量(股)
        rqSell: parseFloat(d.RQMCL) || 0,           // 融券卖出量(股)
        rqRepay: parseFloat(d.RQCHL) || 0,          // 融券偿还量(股)
        rzrqBalance: parseFloat(d.RZRQYE) || 0,     // 融资融券余额合计(元)
        rzrqDiff: parseFloat(d.RZRQYECZ) || 0,      // 融资融券余额差值
        rzRatio: parseFloat(d.RZYEZB) || 0,         // 余额占流通市值比(%)
        closePrice: parseFloat(d.SPJ) || 0,         // 收盘价
        changePct: parseFloat(d.ZDF) || 0,          // 涨跌幅(%)
      })).filter(d => d.tradeDate).reverse();

      // Calculate recent trend
      const latest = marginData[marginData.length - 1] || {};
      const prev = marginData[marginData.length - 2] || {};
      const rzChange = latest.rzBalance - prev.rzBalance;
      const rqChange = latest.rqBalance - prev.rqBalance;

      return {
        hasData: true,
        data: marginData,
        latest: {
          rzBalance: latest.rzBalance,
          rzBuy: latest.rzBuy,
          rzNetBuy: latest.rzNetBuy,
          rqBalance: latest.rqBalance,
          rqVolume: latest.rqVolume,
          rzrqBalance: latest.rzrqBalance,
          rzRatio: latest.rzRatio,
          rzChange,
          rqChange,
        },
        trend: rzChange > 0 ? '融资增加' : rzChange < 0 ? '融资减少' : '持平',
      };
    } catch (e) {
      if (attempt < 2) {
        console.log(`[CapitalFlow] Margin trading attempt ${attempt} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      console.error('[CapitalFlow] Margin trading failed after 2 attempts:', e.message);
      // 降级返回（不抛异常），analyzeCapitalFlow 仍可用其余维度评分，前端显示"暂无数据"
      return { hasData: false, data: [], error: e.message, degraded: true };
    }
  }
  return { hasData: false, data: [], degraded: true };
}

/**
 * 盘中折算因子：当日K线为今天且处于交易时段内时，按已交易分钟数
 * 把盘中累计量折算为预估全天量（240分钟），避免半日量被误判为缩量。
 * 非今日或已收盘返回 1；开盘半小时内（样本过少）不折算返回 1。
 */
function intradayVolFactor(dateStr) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (dateStr !== today) return 1;
  const t = now.getHours() * 60 + now.getMinutes();
  let traded;
  if (t < 570) traded = 0;                      // 9:30 前
  else if (t <= 690) traded = t - 570;          // 上午 9:30-11:30
  else if (t <= 780) traded = 120;              // 午休 11:30-13:00
  else if (t <= 900) traded = 120 + (t - 780);  // 下午 13:00-15:00
  else traded = 240;                            // 收盘后
  if (traded <= 24) return 1;
  return 240 / traded;
}

/**
 * 计算量能指标
 * OBV (On Balance Volume), VR (Volume Ratio), 换手率趋势
 *
 * 20261017a：本函数是个股侧量能分析的唯一出口（根数据源）。
 * 除原有 OBV/VR/MFI/均量/换手率/当日量价信号外，新增 7 项此前由各消费模块
 * 自行计算的量能指标（latestVsPriorAvg / breakout / vol5Vs20 / shrink3d /
 * turnoverChange / volActivity / volumeProfile），口径与原实现逐行对齐。
 * 其他模块一律改为引用本函数输出，不再各自重算。
 *
 * @param {Array}  history       日线序列（至少 20 根）
 * @param {object} quote         行情快照（取 turnover；可为 null）
 * @param {Array}  turnoverSeries 换手率序列 [{date,turnover,close}]（可为 null）
 * @param {object} opts          { includeProfile: 是否计算 750 日筹码分布（默认 false，
 *                                避免 30 分档膨胀 /api/capital-flow 接口载荷）
 *                                unifiedTier: 统一量能档位（20261017i，来自 lib/volumeEngine.js
 *                                _volumeTier）。传入时「量价信号」与「量能热度」改由该档位推导，
 *                                与「量能分析·资金行为」同源；未传入时保持原本地口径，零副作用 }
 *
 * 20261017i 跨卡一致性修复：此前本函数用「当日量 ÷ 前20日均量」判放量/缩量，
 * heatLevel 又用「近3日均量 ÷ 近20日均量」（分子含在分母里，比值天然压向 1，
 * 几乎恒为「量能平稳」），而量能分析卡（volumeEngine combo）用「当日量 ÷ 5日均量 +
 * 60日均量确认」——三套口径互不校验，实测 20 只样本 14 只出现「缩量/放量/平量」同屏互斥。
 * 现统一引自引擎 volumeTier，三者同源。
 */
function computeVolumeIndicators(history, quote, turnoverSeries, opts = {}) {
  const includeProfile = !!(opts && opts.includeProfile);
  if (!history || history.length < 20) return null;

  const closes = history.map(d => d.close);
  const volumes = history.map(d => d.volume);
  const amounts = history.map(d => d.amount || 0);
  const dates = history.map(d => d.date);

  // ---- OBV (On Balance Volume) ----
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv.push(obv[i - 1] + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      obv.push(obv[i - 1] - volumes[i]);
    } else {
      obv.push(obv[i - 1]);
    }
  }

  // ---- VR (Volume Ratio, 26-day) ----
  const vrPeriod = 26;
  const vr = new Array(closes.length).fill(null);
  for (let i = vrPeriod; i < closes.length; i++) {
    let upVol = 0, downVol = 0;
    for (let j = 0; j < vrPeriod; j++) {
      const idx = i - j;
      if (idx <= 0) break;
      if (closes[idx] > closes[idx - 1]) upVol += volumes[idx];
      else if (closes[idx] < closes[idx - 1]) downVol += volumes[idx];
    }
    vr[i] = downVol > 0 ? Math.round(upVol / downVol * 100) : (upVol > 0 ? 500 : 100);
  }

  // ---- MFI (Money Flow Index, 14-day) ----
  const mfiPeriod = 14;
  const mfi = new Array(closes.length).fill(null);
  const typicalPrices = history.map(d => (d.high + d.low + d.close) / 3);
  const moneyFlow = typicalPrices.map((tp, i) => tp * volumes[i]);

  for (let i = mfiPeriod; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = 0; j < mfiPeriod; j++) {
      const idx = i - j;
      if (idx <= 0) break;
      if (typicalPrices[idx] > typicalPrices[idx - 1]) posFlow += moneyFlow[idx];
      else if (typicalPrices[idx] < typicalPrices[idx - 1]) negFlow += moneyFlow[idx];
    }
    mfi[i] = negFlow > 0 ? Math.round(100 - 100 / (1 + posFlow / negFlow)) : 100;
  }

  // ---- Volume MA (5日, 10日, 20日均量) ----
  const volMA = (period) => {
    const result = new Array(volumes.length).fill(null);
    for (let i = period - 1; i < volumes.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += volumes[i - j];
      result[i] = Math.round(sum / period);
    }
    return result;
  };
  const volMA5 = volMA(5);
  const volMA10 = volMA(10);
  const volMA20 = volMA(20);

  // ---- 量价关系分析 ----
  const recent20 = history.slice(-20);
  let upDays = 0, downDays = 0;
  const upVols = [], downVols = [];
  for (const d of recent20) {
    if (d.close >= d.open) { upDays++; upVols.push(d.volume); }
    else { downDays++; downVols.push(d.volume); }
  }
  // 20260902l 修复：涨/跌日均量改为抗脉冲口径——同侧超过自身中位数 2.5 倍的极端量
  // （如中报日单日 3-4 倍巨量）截尾至 2.5 倍中位数再求均值，避免「一天事件量主导
  // 整个 20 日窗口的量价结论」。截尾只作用于同侧内部离群值，涨/跌两侧正常量级对比不受影响。
  const _medianVol = a => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
  };
  const _winsorVol = a => {
    const cap = _medianVol(a) * 2.5;
    return cap > 0 ? a.map(v => Math.min(v, cap)) : a;
  };
  const avgUpVol = upDays > 0 ? _winsorVol(upVols).reduce((s, v) => s + v, 0) / upDays : 0;
  const avgDownVol = downDays > 0 ? _winsorVol(downVols).reduce((s, v) => s + v, 0) / downDays : 0;
  const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;

  // 20日净涨跌（背景参考字段）
  const vpPriceChangePct = recent20.length >= 2
    ? (recent20[recent20.length - 1].close - recent20[0].close) / recent20[0].close * 100
    : 0;

  // ---- 当日量价信号（20260902m：主信号改为当日口径） ----
  // 用户明确要求量价信号反映「当日盘面」而非20日累计统计：当日下跌时显示「量价齐升」
  // 这类20日窗口结论极易被误读。改为：
  //   方向 = 当日涨跌幅（今日收盘 vs 昨收，真实涨跌，避免高开低走/低开高走的阴阳线误判）
  //   量能 = 当日量比（今日量 ÷ 前20日均量，基准不含今日；盘中未收盘按已交易时间折算预估全天量）
  // 20日窗口统计（ratio/upDays/downDays/netChangePct）保留为背景参考字段，供深度分析页展示。
  const lastDay = history[history.length - 1];
  const prevDay = history[history.length - 2] || null;
  const dayChangePct = prevDay ? (lastDay.close - prevDay.close) / prevDay.close * 100 : 0;
  const priorDays = history.slice(-21, -1);
  const priorAvgVol = priorDays.length > 0
    ? priorDays.reduce((s, d) => s + d.volume, 0) / priorDays.length
    : (volumes.length > 1 ? volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (volumes.length - 1) : 0);
  const volFactor = intradayVolFactor(lastDay.date);
  const dayVolRatio = priorAvgVol > 0
    ? Math.round(lastDay.volume * volFactor / priorAvgVol * 100) / 100
    : 1;

  // ---- 20261017i：统一量能档位（跨卡一致性） ----
  // 引擎 volumeTier 是全工作台「放量/缩量」的唯一真值源：
  //   定档 = 当日量 ÷ 前5日均量（市场标准量比口径，与东方财富 App 一致：缩量 <0.8 /
  //   平量 0.8~1.2 / 放量 >1.2；20261019f 起 60 日均量口径不再翻转档位，仅作分歧披露）。
  //   本函数与「量能分析·资金行为」改引同源，彻底消除「量价信号 / 量能热度 / 资金行为」三处结论互斥。
  // 未传入 unifiedTier（如 lib/analysis.js、lib/priceAction.js 单独调用）时退回原本地
  // 口径，行为与改动前完全一致。
  const ut = (opts && opts.unifiedTier) || null;
  const BUCKET_LABEL = { huge: '显著放量', amp: '明显放量', flat: '平量', shrink: '缩量', dry: '地量' };
  let unifiedVolState = null; // 'huge' | 'amp' | 'flat' | 'shrink' | 'dry'
  if (ut && typeof ut === 'object') {
    if (ut.amplified) unifiedVolState = (typeof ut.ratio5 === 'number' && ut.ratio5 > 2.5) ? 'huge' : 'amp';
    else if (ut.shrunk) unifiedVolState = (typeof ut.ratio5 === 'number' && ut.ratio5 < 0.5) ? 'dry' : 'shrink'; // 20261019f：dry 边界 0.4→0.5，对齐市场标准「严重缩量 <0.5」
    else unifiedVolState = 'flat';
  }

  const dayChangeStr = `${dayChangePct > 0 ? '+' : ''}${Math.round(dayChangePct * 100) / 100}%`;
  // 统一口径时说明依据（让用户看到档位由何而来），本地口径时保持原文案
  const volNote = unifiedVolState
    ? `当日${dayChangeStr}，量能${BUCKET_LABEL[unifiedVolState]}（当日量 ÷ 前5日均量 ${ut.ratio5 !== null && ut.ratio5 !== undefined ? ut.ratio5 : '数据不足'} 倍，60日均量口径${ut.confirm || '未确认'}）`
    : `当日${dayChangeStr}，量比${dayVolRatio}${volFactor > 1 ? '（盘中折算）' : ''}`;
  const isUp = dayChangePct > 0.05;
  const isDown = dayChangePct < -0.05;
  // 大涨/大跌分档（|涨跌|≥3%）：同量级下文案与信号必须反映波动幅度，
  // 避免「-4%大跌」被「缩量回调、抛压有限」这类温和文案掩盖风险。
  const bigUp = dayChangePct >= 3;
  const bigDown = dayChangePct <= -3;

  // 量能档位：优先统一档位，否则退回本地「当日量 ÷ 前20日均量」五档（原逻辑原样保留）
  let volBucket;
  if (unifiedVolState) volBucket = unifiedVolState;
  else if (dayVolRatio >= 1.5) volBucket = 'huge';
  else if (dayVolRatio >= 1.2) volBucket = 'amp';
  else if (dayVolRatio >= 0.8) volBucket = 'flat';
  else if (dayVolRatio >= 0.5) volBucket = 'shrink';
  else volBucket = 'dry';

  let volumePriceSignal = '量价平衡';
  let volumePriceDesc = `${volNote}，涨跌幅极小，量价无明显方向`;
  if (isUp) {
    if (volBucket === 'huge') {
      volumePriceSignal = '放量上涨';
      volumePriceDesc = `${volNote}，放量上攻，多头资金积极，量价配合佳`;
    } else if (volBucket === 'amp') {
      volumePriceSignal = '量价齐升';
      volumePriceDesc = `${volNote}，上涨放量，量价配合良好`;
    } else if (volBucket === 'flat') {
      volumePriceSignal = bigUp ? '大涨平量' : '温和上涨'; // 20260921c：大涨而量能未放大（0.8~1.2 平量）=量价背离、上攻乏力，改判中性（原「显著上涨」误给正分）
      volumePriceDesc = bigUp
        ? `${volNote}，大涨但量能仅平量，量价背离、上攻力度与涨幅不匹配，谨防冲高回落`
        : `${volNote}，平量上涨，涨势平稳但动能一般`;
    } else if (volBucket === 'shrink') {
      volumePriceSignal = '缩量上涨';
      volumePriceDesc = `${volNote}，缩量上涨，买盘力度不足，谨防冲高回落`;
    } else {
      volumePriceSignal = '地量上涨';
      volumePriceDesc = `${volNote}，地量上涨，市场参与度极低，持续性存疑`;
    }
  } else if (isDown) {
    // 20261019e：修正量价标签与解释自相矛盾的 bug（海天味业案例：标签「量价齐跌」暗示量缩，
    // 解释却是「下跌放量」）。旧 amp 档标签「量价齐跌」是 20 日窗口时代的遗留词（价跌+20日量能萎缩），
    // 而当日口径下 amp 档 = 价跌且当日量 ÷ 前5日均量 1.3~2.5（量增），标签与解释语义相反 → 统一为「放量下跌」。
    // huge 档同步改名「巨量下跌」，与上涨侧「放量上涨（huge）/量价齐升（amp）」分级对称。
    if (volBucket === 'huge') {
      volumePriceSignal = '巨量下跌';
      volumePriceDesc = `${volNote}，巨量下跌，抛压沉重，注意风险`;
    } else if (volBucket === 'amp') {
      volumePriceSignal = '放量下跌';
      volumePriceDesc = `${volNote}，下跌放量，空头占优，观望为宜`;
    } else if (volBucket === 'flat') {
      volumePriceSignal = bigDown ? '显著下跌' : '温和回调';
      volumePriceDesc = bigDown
        ? `${volNote}，跌幅较大且量能未明显萎缩，抛压真实存在，注意风险`
        : `${volNote}，平量回调，属正常波动`;
    } else if (volBucket === 'shrink') {
      volumePriceSignal = bigDown ? '缩量下跌' : '缩量回调';
      volumePriceDesc = bigDown
        ? `${volNote}，大跌但量能萎缩，恐慌抛售不重、然买盘承接意愿也不足，弱势观望`
        : `${volNote}，缩量回调，抛压有限，观望情绪为主`;
    } else {
      volumePriceSignal = bigDown ? '地量下跌' : '地量回调';
      volumePriceDesc = bigDown
        ? `${volNote}，大跌且地量，交投极度清淡，流动性风险需警惕`
        : `${volNote}，地量回调，交投极度清淡`;
    }
  }

  // ---- 换手率分析（相对月均换手率，避免绝对阈值误判不同活跃度的个股） ----
  const turnover = quote?.turnover || 0;
  const tvSeries = Array.isArray(turnoverSeries)
    ? turnoverSeries.filter(t => t && typeof t.turnover === 'number' && t.turnover > 0)
    : [];
  // 月均换手率：取最近约 22 个交易日（一个月）
  const monthlyTv = tvSeries.slice(-22);
  const turnoverAvg = monthlyTv.length > 0
    ? monthlyTv.reduce((s, t) => s + t.turnover, 0) / monthlyTv.length
    : 0;
  const turnoverRatio = (turnoverAvg > 0 && turnover > 0) ? turnover / turnoverAvg : null;

  let turnoverLevel = '正常';
  if (turnoverRatio !== null) {
    if (turnoverRatio >= 2.0) turnoverLevel = '异常活跃';
    else if (turnoverRatio >= 1.5) turnoverLevel = '高度活跃';
    else if (turnoverRatio >= 0.8) turnoverLevel = '正常';
    else if (turnoverRatio >= 0.5) turnoverLevel = '偏低';
    else turnoverLevel = '低迷';
  } else {
    // 无月均参考（换手率序列缺失）时退回宽松绝对阈值
    if (turnover > 10) turnoverLevel = '异常活跃';
    else if (turnover > 5) turnoverLevel = '高度活跃';
    else if (turnover > 3) turnoverLevel = '活跃';
    else if (turnover > 1) turnoverLevel = '正常';
    else turnoverLevel = '低迷';
  }

  // ---- 近3日/20日成交量对比（量能热度） ----
  // 20260902l 修复：原「近5日均量/近20日均量」口径会被窗口内单日巨量脉冲（如中报日 3-4 倍量）
  // 显著拉高——脉冲发生后连续缩量仍显示「显著放量」，与K线肉眼所见完全相反。
  // 改用近3日均量：单日脉冲权重从 1/5 降至 1/3，且 3 日后即衰减出窗，更贴近当前量能状态；
  // 保留多日平滑（3日）以维持盘中当日K线不完整时的稳定性。
  const tailN = Math.max(1, Math.min(3, volumes.length));
  const last3Vol = volumes.slice(-tailN).reduce((s, v) => s + v, 0) / tailN;
  const last20Vol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const volRatio = last20Vol > 0 ? Math.round(last3Vol / last20Vol * 100) / 100 : 0;

  // ---- 量能水平（方向无关：只看交易量多少，用于「资金热度」评分，与股价涨跌无关） ----
  // 20261017i：统一档位优先。原「近3日均量 ÷ 近20日均量」口径有两个结构性缺陷：
  //   ① 分子（近3日）本身包含在分母（近20日）内，比值天然被压向 1 → 实测几乎恒为
  //      「量能平稳」，与同卡「量价信号」频繁互斥（20 只样本 10 只）；
  //   ② 与量能分析卡（÷5日均量）分母不同 → 跨卡互斥（20 只样本 11 只）。
  // 现与 volumePriceSignal 共用同一个 unifiedVolState，同卡与跨卡双重一致。
  // volRatio 仍按原口径保留输出（背景参考字段，其他消费方与历史行为不变）。
  const HEAT_BY_BUCKET = { huge: '显著放量', amp: '温和放量', flat: '量能平稳', shrink: '缩量', dry: '地量' };
  let heatLevel;
  if (unifiedVolState) heatLevel = HEAT_BY_BUCKET[unifiedVolState];
  else if (volRatio >= 1.5) heatLevel = '显著放量';
  else if (volRatio >= 1.2) heatLevel = '温和放量';
  else if (volRatio > 0.8) heatLevel = '量能平稳';
  else if (volRatio > 0.5) heatLevel = '缩量';
  else heatLevel = '地量';

  // ---- 最新指标值 ----
  const lastIdx = closes.length - 1;
  const latestOBV = obv[lastIdx];
  const latestVR = vr[lastIdx];
  const latestMFI = mfi[lastIdx];

  // OBV趋势判断
  const obvMA5 = obv.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const obvMA20 = obv.slice(-20).reduce((s, v) => s + v, 0) / 20;
  let obvTrend = '中性';
  if (latestOBV > obvMA5 && obvMA5 > obvMA20) obvTrend = '上升趋势';
  else if (latestOBV < obvMA5 && obvMA5 < obvMA20) obvTrend = '下降趋势';

  // VR判断
  let vrSignal = '中性';
  if (latestVR !== null) {
    if (latestVR > 200) vrSignal = '多头资金占优';
    else if (latestVR > 120) vrSignal = '偏多';
    else if (latestVR < 70) vrSignal = '空头资金占优';
    else if (latestVR < 80) vrSignal = '偏空';
  }

  // MFI判断
  let mfiSignal = '中性';
  if (latestMFI !== null) {
    if (latestMFI > 80) mfiSignal = '超买';
    else if (latestMFI > 50) mfiSignal = '资金流入';
    else if (latestMFI < 20) mfiSignal = '超卖';
    else if (latestMFI < 40) mfiSignal = '资金流出';
  }

  // ============ 量能根指标（20261017a：个股侧量能唯一出口） ============
  // 以下 7 项原由各消费模块自行计算，按「单一权威源」规则收敛迁入本模块，
  // 口径与原实现逐行对齐（数据不变则结论不变）：
  //   latestVsPriorAvg  原 lib/analysis.js:356-369        analyzeVolume
  //   breakout          原 lib/priceAction.js:369-377     （20日高低点突破量比与形态判定）
  //   vol5Vs20          原 lib/priceAction.js:479-481
  //   shrink3d          原 lib/priceAction.js:596-601     （空心化上涨证伪）
  //   turnoverChange    原 lib/sameDayJudgment.js:184-211 _computeTurnoverChange
  //   volActivity       原 lib/sameDayJudgment.js:352-370 （量能活跃度子信号）
  //   volumeProfile     原 lib/priceAction.js:293-328     calcVolumeProfile（opt-in）

  // ① 最新量 ÷ 前 19 日均量（20 日窗口内，基准不含最新日）+ 四档趋势
  const prior19 = history.slice(-20, -1);
  const prior19Avg = prior19.length > 0 ? prior19.reduce((s, d) => s + (d.volume || 0), 0) / prior19.length : 0;
  const latestVol = volumes[lastIdx];
  const latestVsPriorAvg = {
    ratio: prior19Avg > 0 ? Math.round(latestVol / prior19Avg * 100) / 100 : 0,
    priorAvgVol: prior19Avg,
    trend: 'normal',
  };
  // [20261024c] 阈值对齐项目「量比」铁律（与 unifiedVolState / volumeEngine._volumeTier 同源）：放量>1.2 / 缩量<0.8。
  // 旧值 >1.5→温和放量 / <0.5→缩量 让量比 1.3 判为 normal，与主档位（量比>1.2=放量）自相矛盾（用户 2026-10-24 报障同一类问题）。
  if (latestVsPriorAvg.ratio > 2) latestVsPriorAvg.trend = '放量';
  else if (latestVsPriorAvg.ratio > 1.2) latestVsPriorAvg.trend = '温和放量';
  else if (latestVsPriorAvg.ratio < 0.8) latestVsPriorAvg.trend = '缩量';

  // ② 突破量比与形态（基准 = 前 20 个交易日，不含最新日）
  const prior20 = history.slice(-21, -1);
  const prior20Vol = prior20.length > 0 ? prior20.reduce((s, d) => s + (d.volume || 0), 0) / prior20.length : 0;
  const breakoutVolRatio = prior20Vol > 0 ? Math.round(latestVol / prior20Vol * 100) / 100 : null;
  const prior20High = prior20.length > 0 ? Math.max(...prior20.map(d => d.high)) : null;
  const prior20Low = prior20.length > 0 ? Math.min(...prior20.map(d => d.low)) : null;
  const lastCloseVal = closes[lastIdx];
  let breakoutPattern = '无显著形态';
  // [20261024c] 突破放量阈值对齐项目「量比」铁律（量比>1.2=放量，与 zoneValidity/zoneReversal 的 BREAK_VOL_MIN=1.2 同源，不另立一套）。
  // 旧值 >=1.5 与箱体突破引擎 1.2 不一致；现统一 1.2。
  if (prior20High && lastCloseVal > prior20High && breakoutVolRatio !== null && breakoutVolRatio >= 1.2) breakoutPattern = '放量突破前高';
  else if (prior20Low && lastCloseVal < prior20Low && breakoutVolRatio !== null && breakoutVolRatio >= 1.2) breakoutPattern = '放量跌破前低';
  else if (prior20High && lastCloseVal > prior20High && breakoutVolRatio !== null && breakoutVolRatio < 0.8) breakoutPattern = '缩量新高';
  const breakout = { volRatio: breakoutVolRatio, high20: prior20High, low20: prior20Low, pattern: breakoutPattern };

  // ③ 5 日均量 ÷ 20 日均量（均含最新日）。注意：不做四舍五入——
  // 原 lib/priceAction.js:481 即为未取整原值，且该值直接参与 <0.9 / <0.8 阈值比较，
  // 取整可能让边界样本翻转判定，故逐行保持原口径。
  const vol5Win = volumes.slice(-5);
  const vol20Win = volumes.slice(-20);
  const avgVol5 = vol5Win.reduce((s, v) => s + v, 0) / 5;
  const avgVol20 = vol20Win.reduce((s, v) => s + v, 0) / 20;
  const vol5Vs20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  // ④ 空心化上涨证伪：近 3 日连续收涨且成交量连续 2 日递减
  let shrink3d = false;
  if (lastIdx >= 3) {
    shrink3d = closes[lastIdx] > closes[lastIdx - 1] && closes[lastIdx - 1] > closes[lastIdx - 2] && closes[lastIdx - 2] > closes[lastIdx - 3]
      && volumes[lastIdx] < volumes[lastIdx - 1] && volumes[lastIdx - 1] < volumes[lastIdx - 2];
  }

  // ⑤ 换手率变化：最近一日 vs 前 (N-5) 日均值偏离 × 近两日价格方向
  const turnoverChange = computeTurnoverChangeShared(turnoverSeries);

  // ⑥ 量能活跃度：近 20 日均量比 × 近两日价格方向
  let volActivity = null;
  {
    const last = history[history.length - 1];
    const vols20 = history.slice(-20).map(h => h.volume).filter(v => typeof v === 'number' && v > 0);
    if (vols20.length >= 5 && last.volume != null) {
      const avgVol = _avg(vols20);
      const ratio = avgVol > 0 ? last.volume / avgVol : 1;
      const prevClose = history[history.length - 2] ? history[history.length - 2].close : null;
      const priceDir = (prevClose != null && last.close != null) ? (last.close - prevClose) : 0;
      const volDir = ratio >= 1 ? 1 : -0.5;
      const signal = _clamp(Math.abs(ratio - 1) * (priceDir >= 0 ? 1 : -1) * volDir, -1, 1);
      const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
      const toneTxt = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
      volActivity = { signal, ratio, avgVol, lastVol: last.volume, priceDir, volTxt, toneTxt };
    }
  }

  return {
    indicators: {
      obv: latestOBV,
      obvTrend,
      vr: latestVR,
      vrSignal,
      mfi: latestMFI,
      mfiSignal,
      volMA5: volMA5[lastIdx],
      volMA10: volMA10[lastIdx],
      volMA20: volMA20[lastIdx],
      volRatio,
      turnover,
      turnoverLevel,
      turnoverAvg: turnoverAvg > 0 ? Math.round(turnoverAvg * 100) / 100 : 0,
      turnoverRatio: turnoverRatio !== null ? Math.round(turnoverRatio * 100) / 100 : null,
      // 20261017a 量能根指标（收敛迁入，详见函数头注释）
      latestVsPriorAvg,
      breakout,
      vol5Vs20,
      shrink3d,
      turnoverChange,
      volActivity,
    },
    volumePrice: {
      // 主信号（当日口径）
      signal: volumePriceSignal,
      description: volumePriceDesc,
      dayChangePct: Math.round(dayChangePct * 100) / 100,
      dayVolRatio,
      // 20日背景参考
      ratio: Math.round(volumePriceRatio * 100) / 100,
      netChangePct: Math.round(vpPriceChangePct * 100) / 100,
      upDays,
      downDays,
      avgUpVol: Math.round(avgUpVol),
      avgDownVol: Math.round(avgDownVol),
      heatLevel,
      // 20261017i：统一量能档位回执（跨卡一致性）。接入引擎时非 null，前端据此展示
      // 口径来源并优先显示 ratio5；未接入时为 null，前端退回既有 dayVolRatio 展示。
      // 纯新增字段，既有消费方零影响。
      unified: ut ? {
        tier: ut.tier,
        bucket: unifiedVolState,
        ratio5: ut.ratio5 !== undefined ? ut.ratio5 : null,
        ratio20: ut.ratio20 !== undefined ? ut.ratio20 : null,
        confirm: ut.confirm || null,
        basis: ut.basis,
        consistent: ut.consistent === undefined ? null : ut.consistent,
        divergenceNote: ut.divergenceNote || null,
      } : null,
    },
    series: {
      dates: dates.slice(-60),
      obv: obv.slice(-60),
      vr: vr.slice(-60),
      mfi: mfi.slice(-60),
      volumes: volumes.slice(-60),
      volMA5: volMA5.slice(-60),
      volMA10: volMA10.slice(-60),
      volMA20: volMA20.slice(-60),
    },
    // 750 日筹码分布仅按需计算（opt-in）：分档 30 个，默认关闭以免膨胀接口载荷
    volumeProfile: includeProfile ? calcVolumeProfileShared(history, 750) : undefined,
  };
}

/**
 * 换手率变化（20261017a 自 lib/sameDayJudgment.js:184-211 _computeTurnoverChange 原样迁入）
 * 取最近 ~60 日换手率序列，以前 (N-5) 个交易日均值为基准，最新值相对基准的偏离，
 * 结合近两日价格方向加权（量价配合：放量上涨偏多、放量下跌偏空；缩量反向且强度减半）。
 * 返回 { ok, signal, detail } —— 数据不足时 ok:false，由上层按中性处理。
 */
function computeTurnoverChangeShared(series) {
  if (!Array.isArray(series) || series.length < 20) {
    return { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' };
  }
  const base = series.slice(0, -5);
  const baseline = _avg(base.map(s => s.turnover));
  const tail = series.slice(-5);
  const latest = tail[tail.length - 1].turnover;
  if (!(baseline > 0)) return { ok: false, signal: 0, detail: '换手率基准为0，按中性处理' };
  const ratio = latest / baseline;
  const lastClose = series[series.length - 1].close;
  const prevClose = series[series.length - 2].close;
  const priceDir = (typeof lastClose === 'number' && typeof prevClose === 'number' && prevClose > 0)
    ? (lastClose - prevClose >= 0 ? 1 : -1) : 0;
  const dev = _clamp(Math.abs(ratio - 1) * 1.2, 0, 1.2);
  const volDir = ratio >= 1 ? 1 : -0.5;
  const signal = _clamp(dev * priceDir * volDir, -1, 1);
  const dirTxt = priceDir > 0 ? '价涨' : priceDir < 0 ? '价跌' : '价平';
  const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
  const tone = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  // 20261017a：原 detail 文案写「近15日均值」，但代码基准为前 (N-5) 个交易日（60 日序列即前 55 日），
  // 文案与实现不符。此处按实际口径改为「基准均值」，计算逻辑不变。
  const detail = `最新换手率 ${_round(latest, 2)}%，基准均值 ${_round(baseline, 2)}%（偏离 ${(ratio >= 1 ? '+' : '') + _round((ratio - 1) * 100, 1)}%），近两日${dirTxt}·${volTxt} → ${tone}`;
  return { ok: true, signal, detail };
}

/**
 * 长期筹码密集区：价格分档成交量分布（20261017a 自 lib/priceAction.js:293-328 calcVolumeProfile 原样迁入）
 * @param {Array}  daily    日线序列
 * @param {number} lookback 回溯交易日数，默认 750（约 3 年）
 */
function calcVolumeProfileShared(daily, lookback = 750) {
  const recent = daily.slice(-lookback);
  if (recent.length < 60) return null;
  const close = recent[recent.length - 1].close;
  const lo = Math.min(...recent.map(d => d.low));
  const hi = Math.max(...recent.map(d => d.high));
  if (!(hi > lo)) return null;
  const N = 30;
  const step = (hi - lo) / N;
  const bins = Array.from({ length: N }, (_, i) => ({ low: _round(lo + i * step), high: _round(lo + (i + 1) * step), vol: 0 }));
  let total = 0;
  for (const d of recent) {
    const tp = (d.high + d.low + d.close) / 3;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((tp - lo) / step)));
    bins[idx].vol += d.volume || 0;
    total += d.volume || 0;
  }
  bins.forEach(b => { b.pct = total > 0 ? _round((b.vol / total) * 100, 2) : 0; });

  const aboveVols = bins.filter(b => b.low >= close);
  const abovePct = _round(aboveVols.reduce((s, b) => s + b.pct, 0), 2);

  // 上方最大密集区（阻力带）与下方最大密集区（支撑带）
  let resistance = null, support = null;
  for (const b of bins) {
    if (b.low >= close && (!resistance || b.vol > resistance.vol)) resistance = b;
    if (b.high <= close && (!support || b.vol > support.vol)) support = b;
  }
  return {
    bins,
    currentPrice: close,
    abovePct,
    belowPct: _round(100 - abovePct, 2),
    resistance: resistance ? { low: resistance.low, high: resistance.high, pct: resistance.pct } : null,
    support: support ? { low: support.low, high: support.high, pct: support.pct } : null,
  };
}

/**
 * 基于K线数据估算资金流向（当 push2his API 不可用时的回退方案）
 * 使用量价关系推算主力/大中小单的净流向
 */
function estimateMoneyFlowFromHistory(history) {
  if (!history || history.length < 2) return [];

  return history.map((d, i) => {
    if (i === 0) {
      return {
        date: d.date,
        mainNet: 0, smallNet: 0, mediumNet: 0, largeNet: 0, superLargeNet: 0,
        mainPct: 0, smallPct: 0, mediumPct: 0, largePct: 0, superLargePct: 0,
        estimated: true,
      };
    }
    const prev = history[i - 1];
    const turnover = (d.amount || d.close * d.volume) || 0;
    const range = Math.max(d.high - d.low, 0.01);
    // 方向因子：正表示买方主导，负表示卖方主导
    const direction = Math.max(-1, Math.min(1, (d.close - prev.close) / range));

    // 估算净流向：方向 × 成交额 × 主力占比
    const netFlow = direction * turnover;
    const mainNet = Math.round(netFlow * 0.55);      // 主力(超大单+大单)约占55%
    const superLargeNet = Math.round(netFlow * 0.35);  // 超大单约35%
    const largeNet = Math.round(netFlow * 0.20);       // 大单约20%
    const mediumNet = Math.round(-netFlow * 0.30);     // 中单反向约30%
    const smallNet = Math.round(-netFlow * 0.25);      // 小单反向约25%

    return {
      date: d.date,
      mainNet, smallNet, mediumNet, largeNet, superLargeNet,
      mainPct: turnover > 0 ? Math.round(mainNet / turnover * 10000) / 100 : 0,
      smallPct: turnover > 0 ? Math.round(smallNet / turnover * 10000) / 100 : 0,
      mediumPct: turnover > 0 ? Math.round(mediumNet / turnover * 10000) / 100 : 0,
      largePct: turnover > 0 ? Math.round(largeNet / turnover * 10000) / 100 : 0,
      superLargePct: turnover > 0 ? Math.round(superLargeNet / turnover * 10000) / 100 : 0,
      estimated: true,
    };
  });
}

/**
 * 剔除引擎内部字段 bars（20261017i）
 * bars 仅用于本模块与量能卡复用同一份日K，不下发前端（250+ 根日K会显著膨胀接口载荷）。
 */
function stripEngineBars(ve) {
  if (!ve || typeof ve !== 'object') return ve;
  const out = { ...ve };
  delete out.bars;
  return out;
}

// 日K通道 volume 单位 → 「手」的换算系数（20261017i 建，20261021h 修正）
// 20261021h：实测（成交额反验）**东财日K也是「手」**，旧表把东财当「股」→ 每条量都除以 100。
// 比值型指标不受影响（分子分母同除），但绝对量（avgVol/lastVol）会小 100 倍，属用户可感知的「小数点错」。
// 单位单一来源已收敛到 lib/volUnit.js，这里只取除数。
const { toLotDivisor } = require('./volUnit');
const VOLUME_TO_LOT = { eastmoney: toLotDivisor('eastmoney'), ths: toLotDivisor('ths'), tencent: toLotDivisor('tencent') };

/**
 * 主函数：资金量能分析
 */
async function analyzeCapitalFlow(symbol, name, quote, history) {
  console.log(`[CapitalFlow] Starting for ${symbol}...`);

  // 并行获取资金流向、融资融券、换手率序列（换手率序列用于「换手率相对月均」的参考基准）
  const { getEastmoneyTurnover } = require('./stockData');
  // 20261017f：量能分析引擎（spec 十三步链路 + 7.4/7.5/11.2-11.4 归集总结，lib/volumeEngine.js）。
  // 与 lib/analysis.js 的同名 analyzeVolume（量能指标 trend/ratio 委托）是不同的职责，别名导入避免遮蔽。
  const { analyzeVolume: analyzeVolumeEngine } = require('./volumeEngine');
  const [moneyFlow, margin, turnoverSeries, volumeEngine] = await Promise.all([
    fetchDailyMoneyFlow(symbol),
    fetchMarginTrading(symbol),
    getEastmoneyTurnover(symbol, 60).catch(() => []),
    // 引擎内部已按通道降级（日K三级链：东财多主机 push2his→push2 → 腾讯日K仅OHLCV；
    // 腾讯分时/公告各自 catch 并如实标注）；
    // 此处整体 catch 只作为最后防线——失败置 null，绝不阻塞资金量能主链路，也不伪造数据。
    // 20261022d：量能引擎「放量破位」的支撑位改为引用②卡「短期动向预判」的有效区间，避免两套口径。
    // 个股页②卡通常已预热同一 symbol 的快照缓存，此处多为缓存命中；任何失败一律降级为引擎自身 _keyLevels。
    (async () => {
      let levelHints = null;
      try {
        const { getPriceActionSnapshot } = require('./priceActionHub');
        const { deriveLevelHints } = require('./zoneLevelsHint');
        // 快照通常已由②卡预热（缓存命中）；给它最多 6s，超时即放弃→引擎自算，绝不让它拖垮 15s 总预算。
        const snap = await Promise.race([
          getPriceActionSnapshot(symbol).catch(() => null),
          new Promise(resolve => setTimeout(() => resolve(null), 6000)),
        ]);
        levelHints = deriveLevelHints(snap && snap.shortTerm, quote && quote.price);
      } catch (e) {
        console.warn('[CapitalFlow] 读取短期动向区间失败（支撑位降级为引擎自算）:', e && e.message ? e.message : e);
      }
      return analyzeVolumeEngine(symbol, name, quote, { levelHints }).catch(e => {
        console.warn('[CapitalFlow] volumeEngine failed:', e.message);
        return null;
      });
    })(),
  ]);

  // ---- 20261017i：数据源统一 + 统一量能档位 ----
  // 数据源：此前「量价分析」用路由传入的 getHistory() 日K，「量能分析」用引擎四级降级链
  // 自拉，两条通道可能停在不同交易日 → 连「今日」定格在哪根 K 线都可能不同。
  // 现量价指标改用引擎已拉到的同一份日K（字段更全：含成交额/换手率），两卡彻底同源。
  // 降级保护：引擎失败 / bars 不足 20 根时自动退回原 history，行为与改动前一致。
  let viHistory = history;
  let unifiedTier = null;
  if (volumeEngine && volumeEngine.ok !== false && Array.isArray(volumeEngine.bars)
      && volumeEngine.bars.length >= 20 && volumeEngine.volumeTier) {
    const div = VOLUME_TO_LOT[volumeEngine.barsSource] || 1;
    viHistory = div !== 1
      ? volumeEngine.bars.map(b => ({ ...b, volume: b.volume / div }))
      : volumeEngine.bars;
    unifiedTier = volumeEngine.volumeTier;
  }

  // 计算量能指标（传入换手率序列；统一档位存在时一并传入，使三处结论同源）
  let volumeIndicators = computeVolumeIndicators(
    viHistory, quote, turnoverSeries,
    unifiedTier ? { unifiedTier } : undefined,
  );
  // 20261024i：量价指标双源兜底——原实现只走单一来源，个别个股若该来源 <20 根（引擎缺 volumeTier
  // 时退回的路由 history 可能过短/失败）→ 量价整块空白。此处若首选来源算不出，改用另一来源
  // （引擎 bars ↔ 路由 history），只要 ≥20 根即可计算，从根上避免「个别个股量价失效」。
  if (!volumeIndicators) {
    let alt = null;
    if (viHistory === history) {
      if (volumeEngine && Array.isArray(volumeEngine.bars) && volumeEngine.bars.length >= 20) {
        const div = VOLUME_TO_LOT[volumeEngine.barsSource] || 1;
        alt = div !== 1 ? volumeEngine.bars.map(b => ({ ...b, volume: b.volume / div })) : volumeEngine.bars;
      }
    } else {
      alt = history;
    }
    if (Array.isArray(alt) && alt.length >= 20) {
      volumeIndicators = computeVolumeIndicators(alt, quote, turnoverSeries, unifiedTier ? { unifiedTier } : undefined);
    }
  }

  // 资金流向：API失败时使用估算数据
  let flowData = moneyFlow;
  let flowSource = 'api';
  if (!flowData || flowData.length === 0) {
    console.log('[CapitalFlow] API data unavailable, using estimated money flow from K-line data');
    flowData = estimateMoneyFlowFromHistory(history);
    flowSource = 'estimated';
  }

  // 汇总资金流向近N日数据
  const flowSummary = summarizeMoneyFlow(flowData);

  // 流通市值（亿元）：腾讯 circulationValue/totalValue 为"<100按万亿、≥100按亿"混编，统一转亿元
  const capRaw = (quote && (quote.circulationValue || quote.totalValue)) || 0;
  const floatMarketCapYi = capRaw > 0 ? (capRaw < 100 ? capRaw * 1e4 : capRaw) : 0;

  // 统一资金量能结论：与前端 capitalCharts.calculateScore / renderConclusion 完全同口径
  // 后端算一次，判断引擎因子与个股分析页共用，保证跨页面一致。
  const conclusion = computeCapitalConclusion({
    volumeIndicators,
    moneyFlow: { summary: flowSummary, source: flowSource },
    marginTrading: margin,
    floatMarketCapYi,
  });

  return {
    symbol,
    name,
    moneyFlow: {
      daily: flowData.slice(-60),
      summary: flowSummary,
      source: flowSource,
    },
    marginTrading: margin,
    volumeIndicators,
    conclusion,
    floatMarketCapYi,
    // 20261017e：量能分析引擎结构化结果（spec：位置判定/量价三问/背离/五大生死位/
    // 位置×量能组合/连续序列/打分/流动性衰减/信号分类/四维度描述；
    // barsSource 标注日K实际通道（eastmoney/tencent），降级时附数据不足说明）。
    // 纯新增字段：既有消费方（moneyFlow/marginTrading/volumeIndicators/conclusion/rules）零改动；
    // 新增渲染方见前端 renderVolumeEngine（个股页资金量能 tab 内「量能分析」卡）。
    // 20261017i：剔除内部字段 bars（仅供本模块复用，不下发前端）。
    volumeEngine: stripEngineBars(volumeEngine),
    // 三规则铺开：时效体检 + 资金净额的变化与边际分析
    // flowSource==='estimated' 时为「基于K线量价估算」，非实际资金流披露值，
    // 按规则二须在来源中如实标注，不得冒充真实数据。
    rules: decorateCapitalRules(flowData, flowSource, history),
  };
}

/**
 * 资金模块三规则装饰器：时效（日频）+ 主力净额的变化与边际
 */
function decorateCapitalRules(flowData, flowSource, history) {
  const core = require('./ruleCore');
  const srcLabel = flowSource === 'estimated'
    ? '东方财富资金流向(API不可用，回退为K线量价估算)'
    : '东方财富资金流向';
  const series = (flowData || [])
    .filter(d => d && d.date)
    .map(d => ({
      date: d.date,
      // 原始单位为「元」，数值极大不利于阅读与比较，统一折算为「亿元」；
      // 仅用于变化与边际分析展示，不改变原始字段口径。
      value: Number(
        d.mainNet != null ? d.mainNet
          : (d.mainNetInflow != null ? d.mainNetInflow : d.netInflow)
      ) / 1e8,
    }))
    .filter(d => isFinite(d.value))
    .slice(-30);
  const lastDate = series.length
    ? series[series.length - 1].date
    : ((history && history.length) ? history[history.length - 1].date : null);
  return core.decorateRules({
    dataTime: lastDate,
    source: srcLabel,
    kind: 'daily',
    series,
    name: '主力净流入(亿元)',
    // 资金净流入可为负（净流出），必须放开负值过滤，否则负值被丢弃导致变化率算错
    allowNegative: true,
  });
}

/**
 * 统一资金量能结论（后端单一数据源）
 * 评分/标签口径与前端 capitalCharts.calculateScore、renderConclusion 完全一致：
 *   量能(交易量,±) + 短期/中期资金流向(±) + 量能指标(OBV/VR ±) + 融资融券(±) + 换手率(相对月均,±)
 * 输出 signal(-1..1，供判断引擎因子)、score(0-100，供评分卡)、label(综合判断文本)、
 * bullScore/bearScore(多空打分)、reasons(评分追溯)、grade(等级)。
 */

/**
 * 按"主力净额占流通市值比"给分（解决"同样金额对大小市值股影响不同"的问题）
 * @param {number} ratioPct 主力净额占流通市值百分比（正=净流入，负=净流出）
 * @param {number} maxUp 该周期满分（5日=15，20日=10）
 * @returns {number} 已含方向符号的得分
 */
function flowScoreByRatio(ratioPct, maxUp) {
  const mag = Math.abs(ratioPct);
  let base;
  if (mag > 0.5) base = maxUp;
  else if (mag > 0.2) base = Math.round(maxUp * 0.66);
  else if (mag > 0) base = Math.round(maxUp * 0.33);
  else base = 0;
  return ratioPct >= 0 ? base : -base;
}

function computeCapitalConclusion(data) {
  const vi = (data && data.volumeIndicators) || {};
  const mf = (data && data.moneyFlow) || {};
  const margin = (data && data.marginTrading) || {};
  const summary = mf.summary && mf.summary.summary ? mf.summary.summary : {};
  const vp = vi.volumePrice || null;
  const ind = vi.indicators || {};

  // ---- 评分（0-100，50 为中性起点） ----
  let score = 50;   // 资金热度：只反映「交易量多少」（热度维度）
  let dirScore = 50; // 方向评分：供判断引擎「资金量能」因子，只反映多空方向
  const reasons = [];

  // 量能（交易量）水平（实际区间 +13 ~ -10，方向无关：只衡量成交量多少，放量=热度高、缩量=热度低，
  // 不再因股价上涨/下跌而加减分，修正「资金热度」被股价方向主导的问题）
  // 20261016b 注释校正（审计 CA5）：旧注释写「±15」，与下方 HEAT_MAP 实际取值（显著放量 +13 / 地量 -10）不符。
  // 注意：本项与下方「短期资金流向（:686）」的 ±15 不是同一项，后者确为 ±15，勿混淆。
  if (vp) {
    const HEAT_MAP = {
      '显著放量': 13, '温和放量': 8, '量能平稳': 0, '缩量': -6, '地量': -10,
    };
    const heat = vp.heatLevel || '量能平稳';
    const d = HEAT_MAP[heat] != null ? HEAT_MAP[heat] : 0;
    score += d;
    reasons.push(d ? `量能（交易量）：${heat}，${d > 0 ? '+' : ''}${d}` : `量能（交易量）：${heat}，0`);
    // 方向首项：量价关系的方向性权重（放量上涨偏多、放量下跌偏空），仅计入 dirScore（signal），
    // 不计入热度 score，从而让「热度」与「方向」彻底解耦。
    const VP_MAP = {
      // 20260902m：量价主信号改为当日口径后的方向权重（-12 ~ +12）
      // 20261019e：下跌侧改为「巨量下跌（huge）/放量下跌（amp）」分级（原 huge=放量下跌、amp=量价齐跌，
      // 后者标签与解释矛盾）。分值按档位继承：巨量下跌 = 原放量下跌 -12、放量下跌 = 原量价齐跌 -9，全表零分值变化。
      '放量上涨': 12, '量价齐升': 9, '大涨平量': 0, '温和上涨': 4, '缩量上涨': -5, '地量上涨': -3,
      '巨量下跌': -12, '放量下跌': -9, '显著下跌': -8, '缩量下跌': -4, '地量下跌': -5,
      '温和回调': -4, '缩量回调': 3, '地量回调': -1, '量价平衡': 0,
    };
    dirScore += (VP_MAP[vp.signal] != null ? VP_MAP[vp.signal] : 0);
  }

  // 流通市值（亿元）：用于把"主力净额"归一化为占市值比，避免大小市值股同金额同分
  const fmc = (typeof data.floatMarketCapYi === 'number' && data.floatMarketCapYi > 0) ? data.floatMarketCapYi : 0;

  // 短期资金流向（±15，按占流通市值比分级：金额越大、市值越小影响越大）
  const s5 = summary['5d'];
  if (s5 && typeof s5.mainNet === 'number') {
    const amt = Math.abs(s5.mainNet);
    const ratio = fmc > 0 ? (s5.mainNet / fmc) * 100 : null;
    let sc5;
    if (ratio === null) {
      sc5 = s5.mainNet > 0 ? 15 : -15;
      reasons.push(s5.mainNet > 0 ? `近5日主力净流入${amt.toFixed(2)}亿，+15` : `近5日主力净流出${amt.toFixed(2)}亿，-15`);
    } else {
      sc5 = flowScoreByRatio(ratio, 15);
      reasons.push(`近5日主力${s5.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc5 > 0 ? '，+' : '，'}${sc5}`);
    }
    score += sc5;
    dirScore += sc5;
  }

  // 中期资金流向（±10，同上归一化）
  const s20 = summary['20d'];
  if (s20 && typeof s20.mainNet === 'number') {
    const amt = Math.abs(s20.mainNet);
    const ratio = fmc > 0 ? (s20.mainNet / fmc) * 100 : null;
    let sc20;
    if (ratio === null) {
      sc20 = s20.mainNet > 0 ? 10 : -10;
      reasons.push(s20.mainNet > 0 ? `近20日主力净流入${amt.toFixed(2)}亿，+10` : `近20日主力净流出${amt.toFixed(2)}亿，-10`);
    } else {
      sc20 = flowScoreByRatio(ratio, 10);
      reasons.push(`近20日主力${s20.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc20 > 0 ? '，+' : '，'}${sc20}`);
    }
    score += sc20;
    dirScore += sc20;
  }

  // 量能指标（±10）
  if (ind.obvTrend === '上升趋势') { score += 6; dirScore += 6; reasons.push('OBV 上升趋势，+6'); }
  else if (ind.obvTrend === '下降趋势') { score -= 6; dirScore -= 6; reasons.push('OBV 下降趋势，-6'); }
  if (ind.vrSignal && ind.vrSignal.includes('多')) { score += 4; dirScore += 4; reasons.push(`VR 信号${ind.vrSignal}，+4`); }
  else if (ind.vrSignal && ind.vrSignal.includes('空')) { score -= 4; dirScore -= 4; reasons.push(`VR 信号${ind.vrSignal}，-4`); }

  // 融资融券（变化按"占流通市值比"归一化分级，与主力净额同口径；存量杠杆按余额占比评级，已天然归一化）
  if (margin.hasData && margin.latest) {
    const l = margin.latest;
    // 融资余额变化：增加=看多正面，按占流通市值比分级（金额越大、市值越小影响越大）
    if (typeof l.rzChange === 'number') {
      const rzYi = l.rzChange / 1e8; // 元→亿
      const rzChgPct = fmc > 0 ? (rzYi / fmc) * 100 : null;
      let rzSc;
      if (rzChgPct === null) {
        rzSc = l.rzChange > 0 ? 6 : -6;
        reasons.push(l.rzChange > 0 ? `融资余额增加${Math.abs(rzYi).toFixed(2)}亿，+6` : `融资余额减少${Math.abs(rzYi).toFixed(2)}亿，-6`);
      } else {
        rzSc = flowScoreByRatio(rzChgPct, 6);
        reasons.push(`融资余额${l.rzChange > 0 ? '增加' : '减少'}${Math.abs(rzYi).toFixed(2)}亿(占流通市值${rzChgPct.toFixed(2)}%)${rzSc > 0 ? '，+' : '，'}${rzSc}`);
      }
      score += rzSc;
      dirScore += rzSc;
    }
    // 融券余额变化：增加=做空力量增强=负面，按占流通市值比分级（方向与融资相反）
    if (typeof l.rqChange === 'number') {
      const rqYi = l.rqChange / 1e8; // 元→亿
      const rqChgPct = fmc > 0 ? (rqYi / fmc) * 100 : null;
      let rqSc;
      if (rqChgPct === null) {
        rqSc = l.rqChange > 0 ? -6 : 6;
        reasons.push(l.rqChange > 0 ? `融券余额增加${Math.abs(rqYi).toFixed(2)}亿，-6` : `融券余额减少${Math.abs(rqYi).toFixed(2)}亿，+6`);
      } else {
        rqSc = -flowScoreByRatio(rqChgPct, 6); // 融券增加→扣
        reasons.push(`融券余额${l.rqChange > 0 ? '增加' : '减少'}${Math.abs(rqYi).toFixed(2)}亿(占流通市值${rqChgPct.toFixed(2)}%)${rqSc > 0 ? '，+' : '，'}${rqSc}`);
      }
      score += rqSc;
      dirScore += rqSc;
    }
    // 融资余额占流通市值比（存量杠杆，已归一化）
    let rzRatioSc = 0;
    if (l.rzRatio > 5) { rzRatioSc = 4; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，杠杆活跃，+4`); }
    else if (l.rzRatio > 2) { rzRatioSc = 2; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，+2`); }
    score += rzRatioSc;
    dirScore += rzRatioSc;
  }

  // 换手率加成（±5，相对月均换手率：以个股自身近一个月的活跃度为基准，替代绝对阈值）
  if (ind.turnover) {
    const t = parseFloat(ind.turnover);
    const ratio = (typeof ind.turnoverRatio === 'number' && ind.turnoverRatio > 0) ? ind.turnoverRatio : null;
    if (ratio !== null) {
      const avgStr = (ind.turnoverAvg > 0) ? `月均${ind.turnoverAvg.toFixed(2)}%的${ratio.toFixed(1)}倍` : `月均参考缺失`;
      if (ratio >= 2.0) { score += 5; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）异常活跃，+5`); }
      else if (ratio >= 1.5) { score += 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）高度活跃，+3`); }
      else if (ratio < 0.5) { score -= 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）低迷，-3`); }
    } else {
      // 无月均参考（换手率序列缺失）时退回宽松绝对阈值
      if (t > 10) { score += 5; reasons.push(`换手率${t.toFixed(2)}% 极高，+5`); }
      else if (t > 5) { score += 3; reasons.push(`换手率${t.toFixed(2)}% 较高，+3`); }
      else if (t < 1) { score -= 3; reasons.push(`换手率${t.toFixed(2)}% 较低，-3`); }
    }
  }

  score = Math.max(0, Math.min(100, score));

  // ---- 多空打分（用于综合判断标签，与 renderConclusion 同口径） ----
  let bullScore = 0, bearScore = 0;
  if (vp) {
    const s = vp.signal;
    if (['放量上涨', '量价齐升', '量价温和偏多'].includes(s)) bullScore += 2;
    else if (['缩量下跌'].includes(s)) bullScore += 1;
    else if (['上涨缩量', '量价温和偏弱'].includes(s)) bearScore += 1;
    else if (['巨量下跌', '放量下跌'].includes(s)) bearScore += 2; // 20261019e：huge 改名「巨量下跌」后仍覆盖；同时修复历史遗漏——旧 amp 档「量价齐跌」不在列（下跌放量不得空头分），现 amp 改判「放量下跌」后已覆盖
  }
  if (s5 && typeof s5.mainNet === 'number') {
    if (s5.mainNet > 0) bullScore += 2;
    else if (s5.mainNet < 0) bearScore += 2;
  }
  if (ind.obvTrend === '上升趋势') bullScore += 1;
  if (ind.obvTrend === '下降趋势') bearScore += 1;
  if (ind.vrSignal && ind.vrSignal.includes('多')) bullScore += 1;
  if (ind.vrSignal && ind.vrSignal.includes('空')) bearScore += 1;
  if (margin.latest && typeof margin.latest.rzChange === 'number') {
    if (margin.latest.rzChange > 0) bullScore += 1;
    else if (margin.latest.rzChange < 0) bearScore += 1;
  }

  const diff = bullScore - bearScore;
  // 方向信号（供判断引擎「资金量能」因子）：由方向评分 dirScore 归一化，仅反映多空方向。
  // 与「资金热度 score」解耦——score 只反映交易量多少（热度），signal 只反映多空方向，
  // 避免「放量下跌 / 巨量下跌」这类高成交却下跌的个股因成交量放大而被误判为偏多。
  const signal = Math.max(-1, Math.min(1, (dirScore - 50) / 50));
  let label;
  if (diff >= 3) label = '资金面偏多，量能支撑上涨';
  else if (diff >= 1) label = '资金面中性偏多';
  else if (diff <= -3) label = '资金面偏空，注意风险';
  else if (diff <= -1) label = '资金面中性偏空';
  else label = '资金面中性，方向不明';

  let grade;
  if (score >= 80) grade = '非常活跃';
  else if (score >= 65) grade = '活跃';
  else if (score >= 45) grade = '中性';
  else if (score >= 30) grade = '低迷';
  else grade = '极度低迷';

  return { signal, score, label, bullScore, bearScore, reasons, grade };
}

/**
 * 汇总资金流向
 */
function summarizeMoneyFlow(moneyFlow) {
  if (!moneyFlow || moneyFlow.length === 0) return null;

  const periods = [5, 10, 20, 60];
  const summary = {};

  for (const p of periods) {
    const data = moneyFlow.slice(-p);
    if (data.length === 0) continue;
    const mainNet = data.reduce((s, d) => s + d.mainNet, 0);
    const largeNet = data.reduce((s, d) => s + d.largeNet, 0);
    const mediumNet = data.reduce((s, d) => s + d.mediumNet, 0);
    const smallNet = data.reduce((s, d) => s + d.smallNet, 0);

    summary[`${p}d`] = {
      mainNet: Math.round(mainNet / 1e8 * 100) / 100,
      largeNet: Math.round(largeNet / 1e8 * 100) / 100,
      mediumNet: Math.round(mediumNet / 1e8 * 100) / 100,
      smallNet: Math.round(smallNet / 1e8 * 100) / 100,
      direction: mainNet > 0 ? '净流入' : '净流出',
    };
  }

  // 最近5日逐日明细
  const recent5 = moneyFlow.slice(-5).map(d => ({
    date: d.date,
    mainNet: Math.round(d.mainNet / 1e8 * 100) / 100,
    direction: d.mainNet > 0 ? '流入' : '流出',
  }));

  return { summary, recent5 };
}

// 20261017a：导出 computeVolumeIndicators 作为个股侧量能指标的纯计算入口
// （不触发任何外网抓取），供 priceAction / analysis 等模块直接引用，避免为取量能指标
// 而白白拉起资金流与融资融券请求。
module.exports = { analyzeCapitalFlow, computeCapitalConclusion, computeVolumeIndicators };
