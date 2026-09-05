/**
 * Capital Flow & Volume Analysis Module
 * 资金量能分析 — 量价关系、资金流向、量能指标、融资融券
 */
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
 */
function computeVolumeIndicators(history, quote, turnoverSeries) {
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

  const dayChangeStr = `${dayChangePct > 0 ? '+' : ''}${Math.round(dayChangePct * 100) / 100}%`;
  const volNote = `当日${dayChangeStr}，量比${dayVolRatio}${volFactor > 1 ? '（盘中折算）' : ''}`;
  const isUp = dayChangePct > 0.05;
  const isDown = dayChangePct < -0.05;
  // 大涨/大跌分档（|涨跌|≥3%）：同量级下文案与信号必须反映波动幅度，
  // 避免「-4%大跌」被「缩量回调、抛压有限」这类温和文案掩盖风险。
  const bigUp = dayChangePct >= 3;
  const bigDown = dayChangePct <= -3;
  let volumePriceSignal = '量价平衡';
  let volumePriceDesc = `${volNote}，涨跌幅极小，量价无明显方向`;
  if (isUp) {
    if (dayVolRatio >= 1.5) {
      volumePriceSignal = '放量上涨';
      volumePriceDesc = `${volNote}，放量上攻，多头资金积极，量价配合佳`;
    } else if (dayVolRatio >= 1.2) {
      volumePriceSignal = '量价齐升';
      volumePriceDesc = `${volNote}，上涨放量，量价配合良好`;
    } else if (dayVolRatio >= 0.8) {
      volumePriceSignal = bigUp ? '显著上涨' : '温和上涨';
      volumePriceDesc = bigUp
        ? `${volNote}，大涨但量能仅平量，上攻力度与涨幅不完全匹配，谨防冲高回落`
        : `${volNote}，平量上涨，涨势平稳但动能一般`;
    } else if (dayVolRatio >= 0.5) {
      volumePriceSignal = '缩量上涨';
      volumePriceDesc = `${volNote}，缩量上涨，买盘力度不足，谨防冲高回落`;
    } else {
      volumePriceSignal = '地量上涨';
      volumePriceDesc = `${volNote}，地量上涨，市场参与度极低，持续性存疑`;
    }
  } else if (isDown) {
    if (dayVolRatio >= 1.5) {
      volumePriceSignal = '放量下跌';
      volumePriceDesc = `${volNote}，放量下跌，抛压沉重，注意风险`;
    } else if (dayVolRatio >= 1.2) {
      volumePriceSignal = '量价齐跌';
      volumePriceDesc = `${volNote}，下跌放量，空头占优，观望为宜`;
    } else if (dayVolRatio >= 0.8) {
      volumePriceSignal = bigDown ? '显著下跌' : '温和回调';
      volumePriceDesc = bigDown
        ? `${volNote}，跌幅较大且量能未明显萎缩，抛压真实存在，注意风险`
        : `${volNote}，平量回调，属正常波动`;
    } else if (dayVolRatio >= 0.5) {
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
  let heatLevel;
  if (volRatio >= 1.5) heatLevel = '显著放量';
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
 * 主函数：资金量能分析
 */
async function analyzeCapitalFlow(symbol, name, quote, history) {
  console.log(`[CapitalFlow] Starting for ${symbol}...`);

  // 并行获取资金流向、融资融券、换手率序列（换手率序列用于「换手率相对月均」的参考基准）
  const { getEastmoneyTurnover } = require('./stockData');
  const [moneyFlow, margin, turnoverSeries] = await Promise.all([
    fetchDailyMoneyFlow(symbol),
    fetchMarginTrading(symbol),
    getEastmoneyTurnover(symbol, 60).catch(() => []),
  ]);

  // 计算量能指标（传入换手率序列）
  const volumeIndicators = computeVolumeIndicators(history, quote, turnoverSeries);

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

  // 量能（交易量）水平（±15，方向无关：只衡量成交量多少，放量=热度高、缩量=热度低，
  // 不再因股价上涨/下跌而加减分，修正「资金热度」被股价方向主导的问题）
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
      '放量上涨': 12, '量价齐升': 9, '显著上涨': 8, '温和上涨': 4, '缩量上涨': -5, '地量上涨': -3,
      '放量下跌': -12, '量价齐跌': -9, '显著下跌': -8, '缩量下跌': -4, '地量下跌': -5,
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
    else if (['放量下跌'].includes(s)) bearScore += 2;
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
  // 避免「放量下跌」这类高成交却下跌的个股因成交量放大而被误判为偏多。
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

module.exports = { analyzeCapitalFlow, computeCapitalConclusion };
