'use strict';
/**
 * lib/strategyGenerator.js
 * 自动策略生成器（用户无需提供任何策略 → 由代码确定性产出多套候选并逐一校验）
 *
 * 设计（与项目铁律一致：确定性计算由代码执行，LLM 只叙事）：
 *   1) 经工作台数据层 getHistory 取前复权日线；经资料库 docStore 取个股上下文（ST/退市风险）。
 *   2) 代码确定性枚举候选策略库（双均线 / MACD / RSI 极值 / 布林回归 / 布林突破 / 收益率 z-score 回归）。
 *   3) 每个候选走虚拟回测（T+1、0.55% 成本）+ 风险修正（平稳性闸门 / 前视 / 成本 / 趋势 / 过拟合 / 幸存者 / 结构突变 / 季节性）。
 *   4) 按修正后胜率排名，挑出最优；LLM 仅用确定性结果做中文口语化解读（失败则回退确定性文案）。
 *
 * 风险校验维度：
 *   时间序列结构：趋势 / 季节性 / 周期性 / 结构性突变 → trend / seasonality / structural_break。
 *   平稳性闸门：非平稳价格上的均值回归 = 伪回归陷阱 → 闸门 ×0.5；用 RET/ZSCORE 走平稳收益率路径。
 *   回测偏差校验：前视偏差 / 交易成本 / 过拟合(训练-测试+walk-forward) / 幸存者偏差。
 */

const { getHistory, getHistoryPeriod } = require('./stockData');
const docStore = require('./docStore');
const llm = require('./ai/llm');
const config = require('./ai/config');
const V = require('./backtestValidator');
const { analyzePriceAction } = require('./priceAction');
const { fetchValuationTTM } = require('./eastmoneyValuation');
const { getBuybackPlan } = require('./buybackEmDc');
const { getCninfoAnnouncements } = require('./cninfoAnnouncements');

const COST_PER_SIDE = 0.0055;
const TRAIN_RATIO = 0.7;

// 候选策略库（按用户框架整理为 5 大类）
// 类别：trend=趋势跟踪 / mean_reversion=均值回归 / momentum=动量·轮动 / value=价值·基本面 / event=事件驱动
const CATEGORY_NAMES = {
  trend: '趋势跟踪', mean_reversion: '均值回归', momentum: '动量/轮动',
  value: '价值/基本面', event: '事件驱动'
};

// —— 滚动极值/均线工具（数组版，供突破/海龟/偏离类信号）——
function highest(arr, n) {
  const N = arr.length, out = new Array(N).fill(-Infinity);
  for (let i = n; i < N; i++) { let m = -Infinity; for (let j = i - n; j < i; j++) if (arr[j] > m) m = arr[j]; out[i] = m; }
  return out;
}
function lowest(arr, n) {
  const N = arr.length, out = new Array(N).fill(Infinity);
  for (let i = n; i < N; i++) { let m = Infinity; for (let j = i - n; j < i; j++) if (arr[j] < m) m = arr[j]; out[i] = m; }
  return out;
}
function maArr(arr, n) {
  const N = arr.length, out = new Array(N).fill(NaN);
  let sum = 0;
  for (let i = 0; i < N; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; if (i >= n - 1) out[i] = sum / n; }
  return out;
}
function pct(arr, q) {
  const v = arr.filter(x => x != null && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.floor(q * v.length)));
  return v[idx];
}

// 把「日频布尔序列」按日期映射到任意更细粒度序列（如 60 分钟），用于把日线策略信号搬到回测序列上。
// dailyFlags[i] 对应 dailyDates[i]（'YYYY-MM-DD'）；返回与 targetBars 等长的布尔数组，命中日期为真。
function broadcastDailyToBars(dailyFlags, dailyDates, targetBars) {
  const daySet = new Set();
  for (let i = 0; i < dailyFlags.length; i++) if (dailyFlags[i]) daySet.add(String(dailyDates[i]).slice(0, 10));
  return targetBars.map(b => daySet.has(String(b.date).slice(0, 10)));
}

// 量价类候选（趋势跟踪 / 均值回归 / 动量轮动）：纯 OHLCV 确定性生成，无需外部数据。
// 信号可写为 DSL 字符串（evaluateCondition 求值）或 signal(ctx) 函数（返回 buy/sell 布尔数组）。
function buildCandidateLibrary() {
  const cands = [];
  // —— 趋势跟踪：顺势而为，适合单边行情 ——
  cands.push({ key: 'trend_ma_5_20', name: '趋势跟踪·双均线(5/20)金叉', category: 'trend', cls: 'trend',
    desc: '5日线上穿20日线买入，下穿卖出（短期趋势）', buy: 'CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', sell: 'CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))' });
  cands.push({ key: 'trend_ma_20_60', name: '趋势跟踪·双均线(20/60)金叉', category: 'trend', cls: 'trend',
    desc: '20日线上穿60日线买入，下穿卖出（中期趋势）', buy: 'CROSS_UP(MA(CLOSE,20), MA(CLOSE,60))', sell: 'CROSS_DOWN(MA(CLOSE,20), MA(CLOSE,60))' });
  cands.push({ key: 'trend_breakout_20', name: '趋势跟踪·突破20日高点', category: 'trend', cls: 'trend',
    desc: '收盘价突破近20日最高价买入，跌破近10日最低价卖出', signal: ctx => { const h = highest(ctx.close, 20), l = lowest(ctx.low, 10); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 20 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 10 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_breakout_60', name: '趋势跟踪·突破60日高点', category: 'trend', cls: 'trend',
    desc: '收盘价突破近60日最高价买入，跌破近20日最低价(趋势线)卖出', signal: ctx => { const h = highest(ctx.close, 60), l = lowest(ctx.close, 20); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 60 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 20 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_turtle', name: '趋势跟踪·海龟法则(20/10)', category: 'trend', cls: 'trend',
    desc: '突破近20日最高价(Donchian)入场，跌破近10日最低价离场；ATR 用于仓位与止损参考', signal: ctx => { const h = highest(ctx.high, 20), l = lowest(ctx.low, 10); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (i >= 20 && ctx.close[i] > h[i]) buy[i] = true; if (i >= 10 && ctx.close[i] < l[i]) sell[i] = true; } return { buy, sell }; } });
  cands.push({ key: 'trend_macd', name: '趋势跟踪·MACD金叉/死叉', category: 'trend', cls: 'trend',
    desc: 'MACD DIF 上穿 DEA 买入，下穿卖出', buy: 'CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))', sell: 'CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))' });
  // —— 均值回归：震荡市有效，涨多必跌跌多必涨 ——
  cands.push({ key: 'rev_boll', name: '均值回归·布林带', category: 'mean_reversion', cls: 'reversion',
    desc: '跌破下轨且超卖买入，回到中轨/上轨卖出', buy: 'CROSS_UP(CLOSE, BOLL_LOWER(CLOSE,20))', sell: 'CROSS_DOWN(CLOSE, BOLL_UPPER(CLOSE,20))' });
  cands.push({ key: 'rev_rsi', name: '均值回归·RSI极值', category: 'mean_reversion', cls: 'reversion',
    desc: 'RSI(14)<30 超卖买入，>70 超买卖出', buy: 'RSI(CLOSE,14) < 30', sell: 'RSI(CLOSE,14) > 70' });
  cands.push({ key: 'rev_ma_dev', name: '均值回归·均线偏离', category: 'mean_reversion', cls: 'reversion',
    desc: '价格大幅低于20日均线(<-5%)买入，回归均线卖出', signal: ctx => { const m = maArr(ctx.close, 20); const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 0; i < N; i++) { if (!isNaN(m[i])) { if (ctx.close[i] < m[i] * 0.95) buy[i] = true; if (ctx.close[i] >= m[i]) sell[i] = true; } } return { buy, sell }; } });
  // —— 动量/轮动：买入近期强势、卖出转弱（单股动量为代理）——
  cands.push({ key: 'mom_roc20', name: '动量·20日收益动量', category: 'momentum', cls: 'momentum',
    desc: '近20日收益率为正(强势)持有，转负(转弱)退出', signal: ctx => { const N = ctx.close.length; const buy = new Array(N).fill(false), sell = new Array(N).fill(false); for (let i = 20; i < N; i++) { const roc = ctx.close[i] / ctx.close[i - 20] - 1; if (roc > 0) buy[i] = true; if (roc < 0) sell[i] = true; } return { buy, sell }; } });
  // 平稳合规路径：在「平稳的收益率」上做 z-score 均值回归（规避伪回归陷阱）
  cands.push({ key: 'ret_zscore', name: '均值回归·收益率z-score(平稳路径)', category: 'mean_reversion', cls: 'return-reversion',
    desc: '收益率 z-score < -1.5 买入，> 1.5 卖出（走平稳收益率路径）', buy: 'ZSCORE(RET(CLOSE),20) < -1.5', sell: 'ZSCORE(RET(CLOSE),20) > 1.5' });
  return cands;
}

// 价值/基本面：历史 PE/PB 低位买入、高位卖出（数据取自 eastmoneyValuation.fetchValuationTTM 的日频序列）
function buildValueCandidates(series, valRaw) {
  const byDate = {};
  for (const d of valRaw.series) if (d && d.date) byDate[String(d.date).slice(0, 10)] = d;
  const peArr = series.map(s => { const d = byDate[String(s.date).slice(0, 10)]; return (d && isFinite(d.pe)) ? d.pe : null; });
  const pbArr = series.map(s => { const d = byDate[String(s.date).slice(0, 10)]; return (d && isFinite(d.pb)) ? d.pb : null; });
  const peLow = pct(peArr, 0.30), peHigh = pct(peArr, 0.70);
  const pbLow = pct(pbArr, 0.30), pbHigh = pct(pbArr, 0.70);
  const out = [];
  if (peLow != null && peHigh != null) {
    const N = series.length, buy = new Array(N).fill(false), sell = new Array(N).fill(false);
    for (let i = 0; i < N; i++) { if (peArr[i] != null) { if (peArr[i] < peLow) buy[i] = true; if (peArr[i] > peHigh) sell[i] = true; } }
    out.push({ key: 'val_low_pe', name: '价值·历史PE低位(30分位)', category: 'value', cls: 'value',
      desc: `PE 低于近 ${valRaw.series.length} 交易日 30% 分位(≈${peLow.toFixed(1)})买入，高于 70% 分位(≈${peHigh.toFixed(1)})卖出`, buy, sell });
  }
  if (pbLow != null && pbHigh != null) {
    const N = series.length, buy = new Array(N).fill(false), sell = new Array(N).fill(false);
    for (let i = 0; i < N; i++) { if (pbArr[i] != null) { if (pbArr[i] < pbLow) buy[i] = true; if (pbArr[i] > pbHigh) sell[i] = true; } }
    out.push({ key: 'val_low_pb', name: '价值·历史PB低位(30分位)', category: 'value', cls: 'value',
      desc: `PB 低于近 ${valRaw.series.length} 交易日 30% 分位(≈${pbLow.toFixed(2)})买入，高于 70% 分位(≈${pbHigh.toFixed(2)})卖出`, buy, sell });
  }
  return out;
}

// 事件驱动：把事件日期映射为「事件日买入、持有 holdDays 后卖出」的布尔信号
function eventSignals(series, dates, holdDays) {
  const N = series.length;
  const buy = new Array(N).fill(false), sell = new Array(N).fill(false);
  const idxByDate = {};
  series.forEach((s, i) => { idxByDate[String(s.date).slice(0, 10)] = i; });
  for (const ds of dates) {
    let i = idxByDate[String(ds).slice(0, 10)];
    if (i == null) {
      let best = -1, bestD = 1e9;
      for (let k = 0; k < N; k++) { const diff = Math.abs(Date.parse(series[k].date) - Date.parse(ds)); if (diff < bestD) { bestD = diff; best = k; } }
      if (bestD <= 4 * 86400000) i = best;
    }
    if (i == null || i < 0) continue;
    if (!buy[i]) buy[i] = true;
    const exit = Math.min(N - 1, i + (holdDays || 20));
    if (!sell[exit]) sell[exit] = true;
  }
  return { buy, sell };
}

// 收集事件（取自其他模块）：① 股份回购（buybackEmDc）② 财报公告（cninfoAnnouncements）
async function collectEvents(symbol) {
  const events = [];
  try {
    const bk = await getBuybackPlan(symbol);
    if (bk && bk.ok && bk.plan && !bk.plan.neutral && bk.plan.date) {
      events.push({ date: bk.plan.date, type: '回购', label: '股份回购(' + (bk.plan.progress || '') + ')' });
    }
  } catch (e) { /* 忽略，继续 */ }
  try {
    const ann = await getCninfoAnnouncements(symbol, 60);
    if (ann && ann.ok && Array.isArray(ann.items)) {
      for (const it of ann.items) {
        const t = (it.title || '');
        if (/年报|半年报|季报|业绩|快报/.test(t) && it.date) events.push({ date: it.date, type: '财报', label: t.slice(0, 24) });
      }
    }
  } catch (e) { /* 忽略 */ }
  const seen = new Set(); const uniq = [];
  for (const e of events) { const k = e.date + e.type; if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  uniq.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  return uniq;
}

function buildEventCandidates(series, events) {
  const earnings = events.filter(e => e.type === '财报').map(e => e.date);
  const buybacks = events.filter(e => e.type === '回购').map(e => e.date);
  const out = [];
  if (earnings.length) {
    const sig = eventSignals(series, earnings, 20);
    out.push({ key: 'evt_earnings', name: '事件·财报公告(持有20日)', category: 'event', cls: 'event',
      desc: `财报公告日(${earnings.length}次)买入，持有约20交易日后卖出`, buy: sig.buy, sell: sig.sell });
  }
  if (buybacks.length) {
    const sig = eventSignals(series, buybacks, 20);
    out.push({ key: 'evt_buyback', name: '事件·股份回购(持有20日)', category: 'event', cls: 'event',
      desc: `股份回购公告日(${buybacks.length}次)买入，持有约20交易日后卖出`, buy: sig.buy, sell: sig.sell });
  }
  return out;
}

// 信号解析：signal(ctx) 函数直接返回数组；DSL 字符串用 evaluateCondition 求值；其余按预计算数组
function resolveSignal(c, ctx) {
  if (typeof c.signal === 'function') return c.signal(ctx);
  const buy = typeof c.buy === 'string' ? V.evaluateCondition(c.buy, ctx) : c.buy;
  const sell = typeof c.sell === 'string' ? V.evaluateCondition(c.sell, ctx) : c.sell;
  return { buy, sell };
}

// 把「行情判定」的确定性技术内核回算成历史买卖信号序列
// 复用 priceAction.analyzePriceAction（与个股页「技术面分析 / 行情判定」同源，纯价格计算，无实时外部数据依赖）
// 映射：长期 verdict=上行→多头；下行→清仓；短期 direction=上行→多头；下行/震荡偏下→清仓；其余维持现状
function rollingJudgmentSignals(series) {
  const N = series.length;
  const close = series.map(s => s.close);
  const longBull = new Array(N).fill(false);
  const longBear = new Array(N).fill(false);
  const shortBull = new Array(N).fill(false);
  const shortBear = new Array(N).fill(false);
  const sliceDaily = (n) => series.slice(0, n);
  for (let i = 0; i < N; i++) {
    if (i + 1 < 120) continue;
    const pa = analyzePriceAction(sliceDaily(i + 1), null);
    if (!pa) continue;
    if (i + 1 >= 250 && pa.longTerm) {
      if (pa.longTerm.verdict === '上行') longBull[i] = true;
      else if (pa.longTerm.verdict === '下行') longBear[i] = true;
    }
    if (pa.shortTerm) {
      const d = pa.shortTerm.direction;
      if (d === '上行') shortBull[i] = true;
      else if (d === '下行' || d === '震荡偏下') shortBear[i] = true;
    }
  }
  return { longBull, longBear, shortBull, shortBear };
}

// D 项：资料库 ST/退市风险扫描，决定幸存者偏差折扣
function scanSurvivorship(symbol) {
  let survivorship = 0.9;
  let basis = '单只 A 股默认 0.9（未在全市场优选中挑选）';
  try {
    const docs = docStore.searchDocuments(symbol) || [];
    const hay = docs.map(d => ((d.title || '') + ' ' + (d.description || '') + ' ' + (d.fileName || ''))).join(' ').toLowerCase();
    if (/st|退市|暂停上市|风险警示|终止上市|摘牌/.test(hay)) {
      survivorship = 0.8;
      basis = '资料库检出 ST/退市/风险警示相关文档，幸存者偏差折扣下调至 0.8';
    }
  } catch (e) { /* 资料库不可用时退回默认 */ }
  return { survivorship, basis };
}

function deterministicAdvice(best, ranked, sys) {
  const b = best || {};
  const lines = [];
  lines.push(`自动生成并校验 ${ranked.length} 个候选策略，最优为「${b.name || '-'}」（类别：${b.cls || '-'}）。`);
  const verdictText = { PASS: '校验通过', WARNING: '边际通过（需谨慎）', REJECT: '未通过校验' }[b.verdict] || b.verdict;
  lines.push(`校验结论：${verdictText}。修正后胜率 ${(b.adjusted_win_rate * 100 || 0).toFixed(1)}%（原始 ${(b.raw ? b.raw.winRate * 100 : 0).toFixed(1)}%），样本内交易 ${b.raw ? b.raw.trades : 0} 笔。`);
  if (sys) {
    lines.push(`标的价格序列${sys.adfPriceStationary ? '平稳' : '非平稳'}、收益率序列${sys.adfReturnStationary ? '平稳' : '非平稳'}，趋势 R²=${sys.trendR2}。`);
  }
  if (b.cls === 'reversion' && sys && !sys.adfPriceStationary) {
    lines.push('⚠ 注意：该均值回归策略作用在「非平稳价格」上，属伪回归陷阱，已按 ×0.5 折算；同库内「收益率 z-score 均值回归」为平稳合规路径，可优先参考。');
  }
  if (b.walk_forward && b.walk_forward.consistency != null) {
    lines.push(`样本外一致性（walk-forward）=${(b.walk_forward.consistency * 100).toFixed(0)}%，一致性越低越可能过拟合。`);
  }
  if (b.verdict === 'PASS') {
    lines.push('实操建议：可小仓位（≤10%）实盘验证，严格止损，持续跟踪样本外表现与结构性突变。');
  } else if (b.verdict === 'WARNING') {
    lines.push('实操建议：仅作观察/模拟盘，暂不重仓；若坚持参与，仓位 ≤5% 并设定硬止损。');
  } else {
    lines.push('实操建议：不建议实盘；如需参考，仅用于理解因子，不要据此下单。');
  }
  return lines.join('\n');
}

async function generateStrategies(input) {
  const symbol = input.symbol;
  const name = input.name || '';
  const range = input.range || '3y';
  if (!symbol) throw new Error('缺少标的 symbol');

  // 日线（用于 行情判定 / 价值 / 事件 三类需要日频数据的候选；judge 内核依赖日K）
  const histD = await getHistory(symbol, range);
  if (!Array.isArray(histD) || histD.length < 60) {
    throw new Error(`标的 ${symbol} 历史数据不足（${histD ? histD.length : 0} 根），无法生成策略`);
  }
  const seriesD = histD.map(d => ({
    date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
  }));
  const dailyDates = seriesD.map(s => s.date);

  // 60 分钟 K 线（提高虚拟交易频率、增大样本量；硬约束每天≤1笔）。失败则回退日线。
  let seriesM = null, intradayNote = '';
  try {
    const histM = await getHistoryPeriod(symbol, '60m', 800);
    if (Array.isArray(histM) && histM.length >= 60) {
      seriesM = histM.map(d => ({
        date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
      }));
    } else {
      intradayNote = '60分钟数据不足，已回退日线（样本量不变）';
    }
  } catch (e) {
    intradayNote = '60分钟获取失败（' + e.message + '），已回退日线';
  }
  const useIntraday = !!seriesM;
  const series = useIntraday ? seriesM : seriesD;
  const close = series.map(s => s.close);
  const ctx = {
    close,
    open: series.map(s => s.open),
    high: series.map(s => s.high),
    low: series.map(s => s.low),
    volume: series.map(s => s.volume)
  };
  const N = series.length;

  // 全局统计（时间序列结构 + 平稳性）—— 以实际回测所用序列（60m 或日线）为准
  const retSeries = V.returnsPct(close).slice(1);
  const adfClose = V.adf(close, 1);
  const adfRet = V.adf(retSeries, 1);
  const kp = V.kpss(close);
  const trend = V.linearTrend(close);
  const season = V.seasonalityScan(retSeries);
  const sys = {
    adfPriceStationary: adfClose.stationary,
    adfReturnStationary: adfRet.stationary,
    trendR2: +trend.r2.toFixed(2),
    trendDirection: trend.direction
  };

  const { survivorship, basis } = scanSurvivorship(symbol);

  // —— 组装候选策略库（5 大类）——
  const candidates = buildCandidateLibrary(); // 量价类（趋势/均值/动量）：直接用 60m/日线 ctx 生成信号
  // 行情判定派生：短期判定归入「趋势跟踪」（内核依赖日K，故在 seriesD 上回算后映射到回测序列）
  const js = rollingJudgmentSignals(seriesD);
  candidates.push({
    key: 'judge_short', name: '趋势跟踪·短期行情判定（技术核心）', category: 'trend', cls: 'trend', holder: true,
    desc: '短期动向 direction=上行 建仓，下行/震荡偏下 清仓',
    buy: useIntraday ? broadcastDailyToBars(js.shortBull, dailyDates, series) : js.shortBull,
    sell: useIntraday ? broadcastDailyToBars(js.shortBear, dailyDates, series) : js.shortBear
  });
  // 价值/基本面（历史 PE/PB，取自估值模块 eastmoneyValuation）：日线计算后映射到回测序列
  const dataNotes = {};
  try {
    const valRaw = await fetchValuationTTM(symbol);
    if (valRaw && Array.isArray(valRaw.series) && valRaw.series.length) {
      const vals = buildValueCandidates(seriesD, valRaw);
      if (useIntraday) vals.forEach(c => { c.buy = broadcastDailyToBars(c.buy, dailyDates, series); c.sell = broadcastDailyToBars(c.sell, dailyDates, series); });
      candidates.push(...vals);
    } else { dataNotes.value = '未获取到历史估值序列，价值/基本面策略跳过'; }
  } catch (e) { dataNotes.value = '估值数据获取失败：' + e.message; }
  // 事件驱动（回购 + 财报公告，取自 buybackEmDc / cninfoAnnouncements）：日线计算后映射到回测序列
  try {
    const events = await collectEvents(symbol);
    if (events.length) {
      const evs = buildEventCandidates(seriesD, events);
      if (useIntraday) evs.forEach(c => { c.buy = broadcastDailyToBars(c.buy, dailyDates, series); c.sell = broadcastDailyToBars(c.sell, dailyDates, series); });
      candidates.push(...evs);
    } else dataNotes.event = '区间内未检索到可用事件（回购/财报公告），事件驱动策略跳过';
  } catch (e) { dataNotes.event = '事件数据获取失败：' + e.message; }
  if (intradayNote) dataNotes.intraday = intradayNote;

  const results = [];
  for (const c of candidates) {
    const sig = resolveSignal(c, ctx);
    const full = V.runBacktest(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE, maxOneTradePerDay: useIntraday });
    // 持仓型/事件型换手天然低 → 门槛放宽到 3 笔；指标型仍 10 笔
    const threshold = (c.holder || c.category === 'event') ? 3 : 10;
    if (full.totalTrades < threshold) {
      let reason = '样本内交易笔数 < ' + threshold + '，无法统计胜率，已剔除';
      if (c.category === 'value' && !sig.buy.some(Boolean)) reason = '回测区间内估值从未进入低估区（PE/PB 未达历史低位阈值），策略未产生交易';
      else if (c.category === 'event') reason = '事件驱动策略天然低频：区间内仅 ' + full.totalTrades + ' 次事件信号，样本不足（<3）无法统计胜率';
      results.push({ key: c.key, name: c.name, category: c.category, cls: c.cls, dsl: { buy: c.desc, sell: c.desc }, insufficient: true, trades: full.totalTrades, winRate: full.winRate, reason });
      continue;
    }
    const splitIdx = Math.floor(N * TRAIN_RATIO);
    const train = V.runBacktest(series.slice(0, splitIdx), sig.buy.slice(0, splitIdx), sig.sell.slice(0, splitIdx), { costPerSide: COST_PER_SIDE });
    const test = V.runBacktest(series.slice(splitIdx), sig.buy.slice(splitIdx), sig.sell.slice(splitIdx), { costPerSide: COST_PER_SIDE });
    const wf = V.walkForward(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE }, 3);
    const sb = V.structuralBreak(series, sig.buy, sig.sell, { costPerSide: COST_PER_SIDE });
    const sf = V.stationarityFactorFor(c.cls, adfClose.stationary, adfRet.stationary);
    const corr = V.applyCorrections(full, null, {
      trainWinRate: train.winRate, testWinRate: test.winRate, trend,
      costPerSide: COST_PER_SIDE, survivorship, lookaheadDetected: false
    }, {
      strategyClass: c.cls,
      adfPriceStationary: adfClose.stationary,
      adfReturnStationary: adfRet.stationary,
      stationarityFactor: sf,
      structuralBreak: sb,
      seasonality: season,
      survivorshipBasis: basis
    });
    results.push({
      key: c.key, name: c.name, category: c.category, cls: c.cls, dsl: { buy: c.desc, sell: c.desc },
      raw: { winRate: full.winRate, trades: full.totalTrades, totalReturn: full.totalReturn, sharpe: full.sharpe, maxDrawdown: full.maxDrawdown, buyHold: full.buyHold },
      train: { winRate: train.winRate, trades: train.totalTrades },
      test: { winRate: test.winRate, trades: test.totalTrades },
      walk_forward: wf,
      structural_break: sb,
      corrections: corr.steps,
      adjusted_win_rate: corr.adjustedWinRate,
      adjusted_return: corr.adjustedReturn,
      verdict: corr.verdict,
      stationarityFactor: sf,
      warnings: (() => {
        const w = [];
        if (full.totalTrades < 10) w.push('样本内交易笔数偏少（' + full.totalTrades + ' 笔），胜率统计置信度有限');
        if (c.cls === 'reversion' && !adfClose.stationary) w.push('伪回归陷阱：非平稳价格上的均值回归');
        if (sb.significant) w.push('结构性突变：前后半段胜率差 ' + (sb.delta * 100).toFixed(0) + 'pp');
        if (season.hasSeasonality) w.push('季节性/周期性：月 ACF=' + season.lag20 + '，季 ACF=' + season.lag60);
        if (wf.consistency < 0.8) w.push('样本外一致性偏低（' + (wf.consistency * 100).toFixed(0) + '%），疑似过拟合');
        return w;
      })()
    });
  }

  // 排名：修正后胜率降序；同分时 PASS > WARNING > REJECT
  const rankOrder = { PASS: 0, WARNING: 1, REJECT: 2 };
  const valid = results.filter(r => !r.insufficient);
  valid.sort((a, b) => {
    if (b.adjusted_win_rate !== a.adjusted_win_rate) return b.adjusted_win_rate - a.adjusted_win_rate;
    return (rankOrder[a.verdict] || 9) - (rankOrder[b.verdict] || 9);
  });

  // E 项：参数敏感性汇总（跨候选的修正胜率分布）
  const adjList = valid.map(r => r.adjusted_win_rate);
  const paramSensitivity = valid.length
    ? {
        candidateCount: valid.length,
        min: Math.min.apply(null, adjList),
        max: Math.max.apply(null, adjList),
        mean: adjList.reduce((a, x) => a + x, 0) / adjList.length,
        spread: Math.max.apply(null, adjList) - Math.min.apply(null, adjList),
        note: '跨候选修正胜率离散度越大，策略对「选股/选参」越敏感；离散度小说明结论更稳健'
      }
    : { candidateCount: 0, note: '无可用候选' };

  const best = valid[0] || null;

  // LLM 仅叙事（失败回退确定性文案）
  let narration = '';
  if (!input.skipLLM) {
    try {
      const cfg = config.loadConfig();
      if (cfg && cfg.apiKey) {
        const model = cfg.modelLocal || cfg.modelWeb || cfg.model || 'qwen-max';
        const messages = [
          { role: 'system', content: '你是严谨的量化策略分析师。只基于给定回测与统计事实做中文口语化解读，不编造数字，不给出具体买卖点位，提醒用户本结果为历史回测、不构成投资建议。' },
          {
            role: 'user',
            content: `标的 ${symbol}（${name}），区间 ${range}。\n全局统计：价格 ADF 平稳=${adfClose.stationary}，收益率 ADF 平稳=${adfRet.stationary}，趋势线性 R²=${trend.r2.toFixed(2)}（${trend.direction}）。\n候选策略 ${valid.length} 个，最优：「${best ? best.name : '-'}」（类别 ${best ? best.cls : '-'}），修正后胜率 ${(best ? best.adjusted_win_rate * 100 : 0).toFixed(1)}%，原始胜率 ${(best && best.raw ? best.raw.winRate * 100 : 0).toFixed(1)}%，交易 ${best && best.raw ? best.raw.trades : 0} 笔，walk-forward 一致性 ${best ? (best.walk_forward.consistency * 100).toFixed(0) : '-'}%。\n校验结论：${best ? best.verdict : '-'}。\n请输出：① 该策略为什么（不）可靠；② 对普通投资者的实操建议（仓位/跟踪/风险）。不超过 200 字。`
          }
        ];
        narration = await llm.callLLM(cfg.provider, cfg.apiKey, model, messages, { webSearch: false, timeoutMs: 45000 });
      }
    } catch (e) {
      narration = '';
    }
  }
  if (!narration || !narration.trim()) narration = deterministicAdvice(best, valid, sys);

  const categorySummary = {};
  for (const r of results) {
    const cat = r.category || 'other';
    if (!categorySummary[cat]) categorySummary[cat] = { name: CATEGORY_NAMES[cat] || cat, valid: 0, insufficient: 0 };
    if (r.insufficient) categorySummary[cat].insufficient++; else categorySummary[cat].valid++;
  }
  return {
    success: true,
    base_info: {
      symbol,
      name,
      range,
      resolution: useIntraday ? '60m' : 'day',
      trade_cap: '≤1 笔/交易日',
      data_points: N,
      cost_per_side: COST_PER_SIDE,
      candidate_count: candidates.length,
      valid_count: valid.length,
      insufficient_count: results.length - valid.length,
      generated_at: new Date().toISOString()
    },
    category_summary: categorySummary,
    data_notes: dataNotes,
    market_context: {
      adf_price: { stat: +adfClose.stat.toFixed(2), stationary: adfClose.stationary },
      adf_return: { stat: +adfRet.stat.toFixed(2), stationary: adfRet.stationary },
      kpss_price: { stat: +kp.stat.toFixed(2), stationary: kp.stationary },
      trend: { r2: +trend.r2.toFixed(2), direction: trend.direction, slope: +trend.slope.toFixed(4) },
      seasonality: season
    },
    parameter_sensitivity: {
      min: +paramSensitivity.min.toFixed(4),
      max: +paramSensitivity.max.toFixed(4),
      mean: +paramSensitivity.mean.toFixed(4),
      spread: +paramSensitivity.spread.toFixed(4),
      candidate_count: paramSensitivity.candidateCount,
      note: paramSensitivity.note
    },
    ranked_strategies: valid,
    insufficient_strategies: results.filter(r => r.insufficient).map(r => ({ key: r.key, name: r.name, category: r.category, reason: r.reason, trades: r.trades })),
    best_strategy: best,
    operation_advice: {
      verdict: best ? best.verdict : 'REJECT',
      adjusted_win_rate: best ? best.adjusted_win_rate : 0,
      narrative: narration.trim(),
      deterministic: !narration || narration === deterministicAdvice(best, valid, sys)
    }
  };
}

module.exports = { generateStrategies, buildCandidateLibrary, rollingJudgmentSignals };
