/**
 * 全市场情绪指数（Market Sentiment Index, MSI）
 * --------------------------------------------------------------
 * 目标：为「市场情绪拐点识别」模块提供单一、可追溯的全市场情绪度量。
 *
 * 设计原则：
 *   1) 只聚合【市场级】信号，绝不混入个股级情感（如个股新闻/个股股吧得分），
 *      否则就不是"全市场"情绪，而是某只股票的影子。
 *   2) 每个分量都归一化到 [-1, 1]，按权重融合；任一分量失败则从融合中剔除并重新归一化权重，
 *      严守"同源、数值一致"的红线——前端展示的分量值与后端计算值完全一致。
 *   3) 每次计算都会落一盘后快照到 data/sentiment-index/series.json，
 *      形成时间序列，供拐点检测器做 z-score / 动量 / 背离分析（天然训练集）。
 *
 * 分量（权重）：
 *   - 涨跌停比 breadth      0.22  （东财涨跌停池，恐惧/贪婪代理）
 *   - 融资余额 margin       0.16  （杠杆资金日环比，资金面贪婪/恐慌）
 *   - 股吧市场热度 marketHeat 0.14 （东财股吧全市场综合得分 + 上升家数占比）
 *   - 全网舆情 globalSent   0.16  （cn-financial-scraper 60+ 源聚合）
 *   - 大盘动量 indexMom     0.20  （上证指数 位置/近期收益，价格维度 · 真实历史）
 *   - 涨跌广度 advDecline   0.12  （大盘指数平均涨跌 + 板块涨跌家数分布）
 *
 * 回填策略（关键）：真实快照不足时，过去交易日用【真实】上证动量/广度分量重建，
 * 静态分量（涨跌停比/融资余额/热度/舆情）用最新快照近似，使序列产生真实波动，
 * z-score 才能识别极值。重建点标记 approx:true，真实点优先且覆盖。
 *
 * 复用现有数据层：sentiment(getMarketSentiment) / cnscraperAdapter(getGlobalSentiment) /
 *                stockData(getHistory / getMarketOverview)。
 */

const fs = require('fs');
const path = require('path');

const { getMarketSentiment } = require('./sentiment');
const { getGlobalSentiment } = require('./cnscraperAdapter');
const { getHistory, getMarketOverview } = require('./stockData');
const { clamp } = require('./ruleCore');

const INDEX_DIR = path.join(__dirname, '..', 'data', 'sentiment-index');
const SERIES_FILE = path.join(INDEX_DIR, 'series.json');

const DEFAULT_SYMBOL = '601318';
const DEFAULT_NAME = '中国平安';

const WEIGHTS = {
  breadth: 0.22,
  margin: 0.16,
  marketHeat: 0.14,
  globalSent: 0.16,
  indexMom: 0.20,
  advDecline: 0.12,
};

function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ensureDir() { if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true }); }

function readSeries() {
  try {
    if (!fs.existsSync(SERIES_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeSeries(arr) {
  ensureDir();
  try { fs.writeFileSync(SERIES_FILE, JSON.stringify(arr, null, 2)); } catch (e) {}
}

function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) { if (a.length < 2) return 0; const m = _mean(a); return Math.sqrt(_mean(a.map(x => (x - m) * (x - m)))); }

// ---- 融合：输入 [{key, signal, ...}]（仅含可用分量），按 WEIGHTS 归一化返回 {index, components} ----
function blendComponents(present) {
  const avail = present.filter(c => typeof c.signal === 'number');
  const wsum = avail.reduce((a, c) => a + (WEIGHTS[c.key] || 0), 0) || 1;
  let s = 0;
  for (const c of avail) s += (WEIGHTS[c.key] || 0) * c.signal;
  s = clamp(s / wsum, -1, 1);
  const components = present.map(c => ({ ...c, weight: round((WEIGHTS[c.key] || 0) / wsum) }));
  return { index: round(s), components };
}

// ---- 大盘动量分量（真实历史，来自上证指数 K 线，按位置 i 计算）----
function _indexMomentumAt(closes, i) {
  if (!Array.isArray(closes) || closes.length < 25 || i < 24) {
    return { ok: false, signal: 0, detail: '上证历史不足，动量分量缺失' };
  }
  const last = closes[i];
  const ma = (n) => { const s = closes.slice(Math.max(0, i - n + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; };
  const ma20 = ma(20), ma60 = ma(60);
  const posDev = (last - ma60) / ma60 / 0.03;
  const ret5 = (last - closes[i - 5]) / closes[i - 5] / 0.03;
  const signal = clamp(0.6 * clamp(posDev, -1, 1) + 0.4 * clamp(ret5, -1, 1), -1, 1);
  const dir = signal > 0.05 ? '偏强' : signal < -0.05 ? '偏弱' : '中性';
  const realDev = (last - ma60) / ma60 * 100;
  const realRet5 = (last - closes[i - 5]) / closes[i - 5] * 100;
  return { ok: true, signal: round(signal), detail: `大盘相对近60天平均 ${round(realDev)}%、最近5天 ${round(realRet5)}% → 近期走势${dir}` };
}

// ---- 涨跌广度分量（用上证当日涨跌 + 板块/个股涨跌家数分布）----
// stockCounts: { up, down, flat, source, approx }，优先用同花顺行业板块个股家数合计；
// 缺失时退化为 sectorSignal（板块涨跌数量）。
function _advDeclineAt(shRet, sectorSignal, stockCounts) {
  const idxSignal = clamp((shRet || 0) / 1.5, -1, 1);
  let signal;
  let value = '';
  let detail = '';
  if (stockCounts && typeof stockCounts.up === 'number' && typeof stockCounts.down === 'number') {
    const up = stockCounts.up, down = stockCounts.down, flat = stockCounts.flat || 0;
    const total = up + down + flat || 1;
    const stockSignal = clamp((up - down) / total / 0.6, -1, 1);
    signal = clamp(0.5 * idxSignal + 0.5 * stockSignal, -1, 1);
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    value = `上涨 ${up} 家 / 下跌 ${down} 家` + (flat ? ` / 平盘 ${flat} 家` : '');
    detail = `全市场约 ${total} 只个股，上涨 ${up} 家、下跌 ${down} 家${flat ? `、平盘 ${flat} 家` : ''} → 多数股票${dir}` + (stockCounts.approx ? `（${stockCounts.source || '估算'}）` : `（${stockCounts.source || '同花顺·行业板块个股合计'}）`);
  } else if (typeof sectorSignal === 'number') {
    signal = clamp(0.6 * idxSignal + 0.4 * clamp(sectorSignal, -1, 1), -1, 1);
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    detail = `大盘今天 ${round(shRet || 0, 2)}% → 多数股票${dir}`;
  } else {
    signal = idxSignal;
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    detail = `大盘今天 ${round(shRet || 0, 2)}% → 多数股票${dir}`;
  }
  return { ok: true, signal: round(signal), value, detail };
}

/**
 * 计算当前全市场情绪指数（实时聚合，不落盘）。
 */
async function computeIndex(opts = {}) {
  const symbol = opts.symbol || DEFAULT_SYMBOL;
  const name = opts.name || DEFAULT_NAME;

  const [sentRes, shRes, moRes] = await Promise.allSettled([
    getMarketSentiment(symbol, name),
    getHistory('sh000001', '6m'),
    getMarketOverview(),
  ]);
  const sent = sentRes.status === 'fulfilled' ? sentRes.value : null;
  const shHist = shRes.status === 'fulfilled' ? shRes.value : [];
  const mo = moRes.status === 'fulfilled' ? moRes.value : null;

  const gs = await getGlobalSentiment('A股,沪深,大盘', { days: 2, maxArticles: 12, budget: 10 })
    .catch(() => ({ ok: false, count: 0 }));

  const present = [];

  if (sent && sent.breadth && sent.breadth.ok) {
    const b = sent.breadth;
    present.push({ key: 'breadth', label: '涨停 vs 跌停家数', signal: clamp(b.signal, -1, 1),
      value: `涨停 ${b.limitUp} 家 / 跌停 ${b.limitDown} 家`,
      detail: `今天全市场涨停 ${b.limitUp} 家、跌停 ${b.limitDown} 家（两者差距越大，说明市场越一边倒）` });
  }
  if (sent && sent.margin && sent.margin.ok) {
    const m = sent.margin;
    present.push({ key: 'margin', label: '融资余额（杠杆资金）', signal: clamp(m.signal, -1, 1),
      value: `${m.changePct >= 0 ? '+' : ''}${round(m.changePct, 2)}%`,
      detail: `融资余额（借钱炒股的资金）最新 ${round(m.latest, 0)} 亿，比上次 ${m.changePct >= 0 ? '+' : ''}${round(m.changePct, 2)}%（增加说明杠杆资金更敢买）` });
  }
  if (sent && sent.marketSentiment && sent.marketSentiment.ok && typeof sent.marketSentiment.marketHeat === 'number') {
    const mc = sent.marketSentiment;
    present.push({ key: 'marketHeat', label: '股吧讨论热度', signal: clamp(mc.marketHeat, -1, 1),
      value: `热度 ${round(mc.marketHeat, 2)}`,
      detail: `股吧全市场讨论综合得分 ${mc.marketAvgScore}、看多的人占 ${round(mc.marketUpRatio * 100)}%` });
  }
  if (gs && gs.ok && typeof gs.signal === 'number' && gs.count > 0) {
    present.push({ key: 'globalSent', label: '全网消息面', signal: clamp(gs.signal, -1, 1),
      value: `利好 ${gs.positive}/利空 ${gs.negative}`,
      detail: `最近全网 ${gs.count} 条相关消息，整体偏${gs.avg_score != null ? (gs.avg_score >= 0 ? '好' : '差') : '—'}（情感分 ${gs.avg_score != null ? (gs.avg_score >= 0 ? '+' : '') + round(gs.avg_score, 2) : '—'}）` });
  }
  // 动量（真实历史，用最新一根）
  const closes = (Array.isArray(shHist) ? shHist : []).map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length >= 25) {
    const mom = _indexMomentumAt(closes, closes.length - 1);
    present.push({ key: 'indexMom', label: '大盘近期涨跌势头', signal: mom.signal, detail: mom.detail, value: '' });
  }
  // 广度（最新一根 + 个股涨跌家数，优先用同花顺行业板块个股合计）
  let sectorSignal = null;
  let stockCounts = null;
  if (mo) {
    const up = mo.sectorUpCount || 0, down = mo.sectorDownCount || 0, flat = mo.sectorFlatCount || 0;
    const tot = up + down + flat;
    if (tot > 0) sectorSignal = clamp((up - down) / tot / 0.6, -1, 1);
    // 若返回了全量板块，加总各板块内上涨/下跌家数，得到全市场个股涨跌数量（比板块数量更细）
    if (Array.isArray(mo.sectorAll) && mo.sectorAll.length) {
      const stockUp = mo.sectorAll.reduce((a, s) => a + (s.upCount || 0), 0);
      const stockDown = mo.sectorAll.reduce((a, s) => a + (s.downCount || 0), 0);
      const stockFlat = mo.sectorAll.reduce((a, s) => a + (s.flatCount || 0), 0);
      stockCounts = {
        up: stockUp,
        down: stockDown,
        flat: stockFlat || undefined,
        source: mo.sectorSource || '同花顺·行业板块个股合计',
        approx: !mo.sectorIsEastmoney,
      };
    }
  }
  const lastRet = closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100 : 0;
  const ad = _advDeclineAt(lastRet, sectorSignal, stockCounts);
  present.push({ key: 'advDecline', label: '上涨 vs 下跌家数', signal: ad.signal, detail: ad.detail, value: ad.value });

  const { index, components } = blendComponents(present);
  return {
    date: localDate(), index, components,
    available: components.filter(c => c.weight > 0).length,
    total: 6,
    source: '东方财富·涨跌停池/融资余额/股吧舆情 + cn-financial-scraper 全网舆情 + 上证指数动量/广度',
  };
}

/**
 * 记录当日快照（盘后/启动 best-effort 调用）。同一天多次调用幂等（覆盖）。
 */
async function recordDailySnapshot(opts = {}) {
  let idx;
  try { idx = await computeIndex(opts); } catch (e) { return null; }
  if (!idx || typeof idx.index !== 'number') return null;
  const series = readSeries();
  const snap = {
    date: idx.date, index: idx.index,
    components: idx.components.map(c => ({ key: c.key, label: c.label, signal: c.signal, weight: c.weight })),
    ts: Date.now(),
  };
  const i = series.findIndex(s => s.date === snap.date);
  if (i >= 0) series[i] = snap; else series.push(snap);
  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeSeries(series);
  return snap;
}

/**
 * 重建过去交易日的近似快照：静态分量（涨跌停比/融资余额/热度/舆情）用 latestStatic 近似，
 * 动量/广度用上证真实历史，使序列产生真实波动（z-score 可用）。
 */
function rebuildBackfill(shHist, latestStatic, earliestDate, backfillDays) {
  const closes = (Array.isArray(shHist) ? shHist : []).map(h => h.close).filter(v => typeof v === 'number');
  const dates = (Array.isArray(shHist) ? shHist : []).map(h => h.date).filter((_, i) => typeof closes[i] === 'number');
  if (closes.length < 25) return [];
  const out = [];
  for (let i = 24; i < closes.length; i++) {
    const d = dates[i];
    if (!d || d >= earliestDate) continue; // 真实快照优先
    const dayDiff = (Date.parse(earliestDate) - Date.parse(d)) / 86400000;
    if (dayDiff > backfillDays) continue;
    const mom = _indexMomentumAt(closes, i);
    const shRet = i >= 1 ? (closes[i] - closes[i - 1]) / closes[i - 1] * 100 : 0;
    const adv = _advDeclineAt(shRet, null);
    const present = [...latestStatic, { key: 'indexMom', signal: mom.signal }, { key: 'advDecline', signal: adv.signal }];
    const { index, components } = blendComponents(present);
    out.push({ date: d, index, components: components.map(c => ({ key: c.key, signal: c.signal, weight: c.weight })), ts: 0, approx: true });
  }
  return out;
}

/**
 * 读取时间序列（含回填）。
 * opts.shHistory: 上证历史（用于真实动量回填）；opts.staticComponents: 最新快照的静态分量 [{key,signal}]。
 */
async function getSeries({ allowBackfill = true, shHistory = null, staticComponents = [], backfillDays = 120 } = {}) {
  const real = readSeries();
  if (!allowBackfill || real.length >= 40) return { real, full: real, backfilled: 0 };
  const earliest = real.length ? real[0].date : localDate();
  let sh = shHistory;
  if (!sh) { try { sh = await getHistory('sh000001', '1y'); } catch (e) { sh = []; } }
  // 静态分量：优先用传入的最新快照；否则取最近真实快照的分量信号
  let statics = staticComponents && staticComponents.length ? staticComponents.slice() : [];
  if (!statics.length && real.length) {
    statics = (real[real.length - 1].components || []).map(c => ({ key: c.key, signal: c.signal }));
  }
  // 仅保留"静态类"分量（排除动量/广度，因其用真实历史重建）
  statics = statics.filter(c => ['breadth', 'margin', 'marketHeat', 'globalSent'].includes(c.key));
  const backfilled = rebuildBackfill(sh, statics, earliest, backfillDays);
  const full = real.concat(backfilled);
  full.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { real, full, backfilled: backfilled.length };
}

module.exports = {
  computeIndex, recordDailySnapshot, getSeries, readSeries,
  SERIES_FILE, DEFAULT_SYMBOL, DEFAULT_NAME,
};
