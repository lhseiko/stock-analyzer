/**
 * 大盘量能情绪分析模型 · 计算引擎（lib/marketEmotionModel.js · 20260917d）
 * ==================================================================
 * 用户 20260917 给出的完整逻辑（「大盘量能情绪分析模型——完整执行逻辑（最终版）」）
 * 的确定性实现：所有打分/权重/学习规则全部由代码执行，**无 LLM 参与**。
 *
 * 因子（10 个 = 8 常驻 + 2 非常驻）与基准权重：
 *   量能活跃度 15 | 市场宽度与极端情绪 15 | 量价配合度 10 | 大盘近期涨跌势头 10
 *   融资余额 10 | 主力资金流向 10 | 股吧讨论热度 10（反向）| 避险情绪 10
 *   国内宏观数据情绪 5（非常驻）| 美国宏观事件情绪 5（非常驻）
 *
 * 覆盖规则：§四 因子计算 / §五 非常驻衰减 / §六 自学习与准确率 /
 *           §七 总分与动态归一化 / §八 长期自适应（极端值剔除·双基准·风格自适应·
 *           数据自检·月度健康报告·极端熔断）/ §九 时间周期与数据质量修正 / §十 输出格式。
 *
 * 存储：data/market-emotion/
 *   state.json      自学习权重状态 + 因子准确率台账
 *   snapshots.json  每日快照（主力净额/热度/量比…）→ 供 5 日均值与历史分位
 *   records.json    预测台账（T+1 / T+3 / T+5 事后核对）
 *   health/YYYY-MM.json 模型健康度月度报告
 */

const fs = require('fs');
const path = require('path');
// 只取别名：本文件自己声明了 function localDate（委托用），避免重名冲突
const { localDate: _localDate } = require('./localDate');

// 允许用环境变量覆盖存储目录（离线回归测试用；生产默认 data/market-emotion）
const DIR = process.env.SA_MARKET_EMOTION_DIR
  ? path.resolve(process.env.SA_MARKET_EMOTION_DIR)
  : path.join(__dirname, '..', 'data', 'market-emotion');
const HEALTH_DIR = path.join(DIR, 'health');
const STATE_FILE = path.join(DIR, 'state.json');
const SNAP_FILE = path.join(DIR, 'snapshots.json');
const REC_FILE = path.join(DIR, 'records.json');

const MID_HORIZON = 20;

// ---- 基准权重（spec §三.2）----
const BASE_WEIGHTS = {
  volumeActivity: 15,
  breadthExtreme: 15,
  priceVolume: 10,
  indexMomentum: 10,
  margin: 10,
  mainCapital: 10,
  discussionHeat: 10,
  riskAversion: 10,
  domesticMacro: 5,   // 非常驻
  usMacro: 5,         // 非常驻
};
const NON_RESIDENT = ['domesticMacro', 'usMacro'];
const FACTOR_NAMES = {
  volumeActivity: '量能活跃度',
  breadthExtreme: '市场宽度与极端情绪',
  priceVolume: '量价配合度',
  indexMomentum: '大盘近期涨跌势头',
  margin: '融资余额（杠杆资金）',
  mainCapital: '主力资金流向',
  discussionHeat: '股吧讨论热度（散户情绪·反向）',
  riskAversion: '避险情绪',
  domesticMacro: '国内宏观数据情绪',
  usMacro: '美国宏观事件情绪',
};

// ---- 自学习约束（spec §三.3）----
const W_MIN = 5;           // 常驻因子权重下限 %
const W_MAX = 30;          // 常驻因子权重上限 %
const LEARN_MIN_SAMPLE = 20;   // 权重自学习最小样本（spec §六.样本量要求）
const LEARN_WINDOW = 30;       // 最近 30 次
const UP_THRESHOLD = 0.60;
const DOWN_THRESHOLD = 0.45;
const UP_STEP = 0.15;      // 上调 10%~20%（取中值 15%）
const DOWN_STEP = 0.15;    // 下调 10%~20%

// ---- 非常驻衰减（spec §五）----
const DECAY_PER_DAY = 0.8;
const DECAY_FLOOR = 1;     // 权重低于 1% 归零休眠

// ---- 双基准（spec §八.2）----
const VOL_PCTL_LOW = 0.10;
const VOL_PCTL_HIGH = 0.90;

// ---- 热度时效（spec §九：滞后数据打折 / 过期剔除）----
const LAG_DEGRADE_DAYS = 3;   // 股吧热度滞后 >= 3 个交易日 → 降级归零并分摊

const FLAT_TOL = 0.5;

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); }
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function ensureHealthDir() { try { if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true }); } catch (e) {} }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) { try { ensureDir(); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch (e) {} }

// 统一委托给 lib/localDate.js（北京时区，不依赖宿主机时区；UTC+8 下逐点等价）
function localDate(d = new Date()) { return _localDate(d); }

/** 分位数（0~1），线性插值 */
function percentile(values, p) {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  const pos = clamp(p, 0, 1) * (arr.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}
/** 某值在过去窗口中的分位（0~1） */
function rankPercentile(values, v) {
  const arr = values.filter(x => typeof x === 'number' && isFinite(x));
  if (!arr.length || typeof v !== 'number') return null;
  let below = 0;
  for (const x of arr) if (x < v) below++;
  return below / arr.length;
}

/** 滚动窗口极端值剔除（spec §八.1）：剔除 > mean+3σ 的样本后返回剩余 */
function trimExtremes(values, sigma = 3) {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v));
  if (arr.length < 10) return { kept: arr, removed: 0 };
  const m = mean(arr), s = std(arr);
  const cap = m + sigma * s;
  const kept = arr.filter(v => v <= cap);
  return { kept, removed: arr.length - kept.length };
}

// ================= 数据源状态读写 =================
function loadState() {
  const s = readJson(STATE_FILE, null);
  if (s && s.weights) return s;
  return {
    weights: { ...BASE_WEIGHTS },
    factorAcc: {},      // key -> { samples:[], total, correct }
    events: {},         // domesticMacro/usMacro -> { status, initialWeight, weight, lastTrigger, decayDays }
    lastUpdated: null,
  };
}
function saveState(s) { s.lastUpdated = new Date().toISOString(); writeJson(STATE_FILE, s); }
function loadSnapshots() { const a = readJson(SNAP_FILE, []); return Array.isArray(a) ? a : []; }
function saveSnapshots(a) { writeJson(SNAP_FILE, a); }
function loadRecords() { const a = readJson(REC_FILE, []); return Array.isArray(a) ? a : []; }
function saveRecords(a) { writeJson(REC_FILE, a); }

/** 引导：从既有 MSI 序列读取「股吧讨论热度」历史（免等待 10 天冷启动） */
function loadHeatHistoryFromMSI() {
  try {
    // 允许用 SA_MSI_SERIES 覆盖路径，便于零网络回归测试完全隔离（默认读生产序列）
    const p = process.env.SA_MSI_SERIES || path.join(__dirname, '..', 'data', 'sentiment-index', 'series.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const s of arr) {
      const c = (s.components || []).find(x => x.key === 'marketHeat');
      if (c && typeof c.signal === 'number' && s.date) out.push({ date: s.date, heat: c.signal });
    }
    return out;
  } catch (e) { return []; }
}

/** 合并热度历史（MSI 引导 + 本模型快照），按日期去重排序；保留日期以便做「交易日过滤 + 时效校验」 */
function mergeHeatHistory(snapshots) {
  const map = new Map();
  for (const h of loadHeatHistoryFromMSI()) map.set(h.date, h.heat);
  for (const s of snapshots) if (typeof s.heat === 'number' && s.date) map.set(s.date, s.heat);
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, heat]) => ({ date, heat }));
}

/**
 * 交易日滞后：heatDate 距 modelDate 之间隔了几个交易日（用上证 bars 的日期当交易日历）。
 * 返回 0 表示同日；null 表示无法判断（缺日期）。
 */
function tradingLagDays(heatDate, modelDate, barDates) {
  if (!heatDate || !modelDate) return null;
  if (heatDate === modelDate) return 0;
  const after = barDates.filter(dt => dt > heatDate).length;
  if (after > 0) return after;
  const a = Date.parse(heatDate), b = Date.parse(modelDate);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(1, Math.round((b - a) / 86400000));
}

// ================= 因子计算 =================

/** 1) 量能活跃度（15%） */
function calcVolumeActivity(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 25) return { score: 0, degraded: true, reason: '上证日线不足 25 根', value: '' };
  const vols = bars.map(b => b.vol);
  const today = vols[vols.length - 1];
  // 20 日窗口（不含今日）做极端值剔除
  const win20 = vols.slice(-21, -1);
  const { kept, removed } = trimExtremes(win20);
  const avg20 = mean(kept) || 1;
  const ratio = today / avg20;

  // 双基准：过去 1 年分位
  const year = vols.slice(-250);
  const pct = rankPercentile(year, today);

  let score = 0, state = '平量', note = '';
  if (ratio > 1.5) { score = 1; state = '放量'; }
  else if (ratio < 0.7) { score = -1; state = '缩量'; }
  else { score = 0; state = '平量'; }

  // 方向修正：放量必须结合市场宽度
  if (score === 1) {
    const b = d.breadth;
    const upRatio = b ? b.up / Math.max(1, b.up + b.down) : null;
    if (upRatio != null) {
      if (upRatio < 0.45) { score = -1; note = '放量且普跌 → 恐慌抛售'; }
      else if (upRatio > 0.55) { note = '放量且普涨 → 健康上涨'; }
      else { note = '放量但涨跌互现，方向不明'; }
    }
  }

  // 双基准修正（spec §八.2）
  if (pct != null) {
    if (pct < VOL_PCTL_LOW) {
      if (score > 0 || ratio > 1.3) { score = Math.min(score, 0); note = '量能处于过去1年10%分位以下 → 属极度缩量后的微弱反弹，不判健康放量'; }
      else note = note || '量能处于过去1年低位';
    } else if (pct > VOL_PCTL_HIGH) {
      note = (note ? note + '；' : '') + '量能处于历史高位，警惕过热';
      if (score > 0) score = Math.min(score, 0.5);
    }
  }

  const value = `量比 ${round(ratio, 2)}（${state}）· 1年分位 ${pct != null ? round(pct * 100, 0) + '%' : '—'}`;
  const detail = `今日成交 ${round(today / 1e8, 1)} 亿手 ÷ 近20日均量 ${round(avg20 / 1e8, 1)} 亿手 = ${round(ratio, 2)} 倍${removed ? `（20日窗口剔除 ${removed} 个极端值）` : ''}${note ? '；' + note : ''}`;
  return { score, degraded: false, value, detail, ratio: round(ratio, 3), volPct: pct != null ? round(pct, 3) : null, state };
}

/** 2) 市场宽度与极端情绪（15%） */
function calcBreadthExtreme(d) {
  const b = d.breadth;
  if (!b || !(b.up + b.down > 0)) return { score: 0, degraded: true, reason: '涨跌家数缺失', value: '' };
  const upRatio = b.up / (b.up + b.down);
  const limitDiff = (b.limitUp - b.limitDown) / 100;
  const fewLimitDown = b.limitDown <= 5;
  const manyLimitDown = b.limitDown >= 20;

  let score = 0, note = '';
  if (upRatio > 0.6 && fewLimitDown) { score = 1; note = '健康普涨'; }
  else if (upRatio < 0.4 && manyLimitDown) { score = -1; note = '恐慌普跌'; }
  else if (b.limitUp >= 30 && upRatio < 0.5) { score = 0; note = '涨停不少但下跌家数更多 → 结构性分化，不给方向分'; }
  else { score = 0; note = '涨跌互现，方向不明'; }

  // 结构健康度修正（spec §四.2）
  let structureNote = '';
  const cap = d.capital;
  if (cap && typeof cap.topDecileShare === 'number') {
    if (cap.topDecileShare > 50) {
      score = round(score * 0.7, 3);
      structureNote = `成交额前10%个股贡献 ${cap.topDecileShare}% 总成交 → 结构不健康，得分打7折`;
    } else {
      structureNote = `成交额前10%个股贡献 ${cap.topDecileShare}% 总成交，结构正常`;
    }
  }

  const value = `涨:跌 = ${b.up}:${b.down}（${round(upRatio * 100, 0)}%）· 涨停 ${b.limitUp} / 跌停 ${b.limitDown}`;
  const detail = `上涨 ${b.up} 家、下跌 ${b.down} 家（涨跌家数比 ${round(upRatio, 3)}）；涨停 ${b.limitUp} 家、跌停 ${b.limitDown} 家（涨跌停差 ${round(limitDiff, 2)}）→ ${note}。${structureNote}`;
  return { score: clamp(score, -1, 1), degraded: false, value, detail, upRatio: round(upRatio, 3), limitDiff: round(limitDiff, 2) };
}

/** 3) 量价配合度（10%）：最近 5 日价格/量能走势 */
function calcPriceVolume(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 10) return { score: 0, degraded: true, reason: '上证日线不足', value: '' };
  const closes = bars.map(b => b.close), vols = bars.map(b => b.vol);
  const n = bars.length;
  const pNow = closes[n - 1], p5 = closes[n - 6];
  const priceUp = pNow > p5;
  const vRecent = mean(vols.slice(n - 3));
  const vPrev = mean(vols.slice(n - 6, n - 3));
  const volUp = vRecent > vPrev;

  let score = 0, label = '';
  if (priceUp && volUp) { score = 1; label = '量价齐升（趋势健康）'; }
  else if (!priceUp && !volUp) { score = -1; label = '量价齐跌（资金退潮）'; }
  else if (!priceUp && volUp) { score = -1; label = '量升价跌（放量下跌/恐慌出货）'; }
  else if (priceUp && !volUp) { score = -0.5; label = '量缩价升（动能不足，警惕诱多）'; }
  else { score = 0; label = '量价关系中性'; }

  const value = `价格5日 ${round((pNow - p5) / p5 * 100, 2)}% · 量能近3日 vs 前3日 ${round((vRecent / vPrev - 1) * 100, 1)}%`;
  const detail = `${label}：近5日价格${priceUp ? '上行' : '下行'}、量能${volUp ? '放大' : '萎缩'}`;
  return { score, degraded: false, value, detail };
}

/** 4) 大盘近期涨跌势头（10%）：vs MA5 / MA60 */
function calcIndexMomentum(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 61) return { score: 0, degraded: true, reason: '上证日线不足 61 根', value: '' };
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const last = closes[n - 1];
  const ma5 = mean(closes.slice(n - 5));
  const ma60 = mean(closes.slice(n - 60));
  let score = 0;
  const above5 = last > ma5, above60 = last > ma60;
  score += above5 ? 0.5 : -0.5;
  score += above60 ? 0.5 : -0.5;
  score = clamp(score, -1, 1);
  const value = `现价 ${round(last, 1)} · vs MA5 ${above5 ? '上' : '下'} · vs MA60 ${above60 ? '上' : '下'}`;
  const detail = `上证收盘 ${round(last, 1)}，5 日均线 ${round(ma5, 1)}、60 日均线 ${round(ma60, 1)} → 位于 ${[above5 ? 'MA5上方' : 'MA5下方', above60 ? 'MA60上方' : 'MA60下方'].join('、')}`;
  return { score, degraded: false, value, detail, above5, above60 };
}

/** 5) 融资余额（10%）：今日 vs 5 日前 */
function calcMargin(d, isMonthEnd) {
  const m = d.margin;
  if (!m || !(m.latest > 0)) return { score: 0, degraded: true, reason: '融资余额缺失', value: '' };
  const chg = typeof m.change5Pct === 'number' ? m.change5Pct : (typeof m.changePct === 'number' ? m.changePct : null);
  if (chg == null) return { score: 0, degraded: true, reason: '融资余额变化不可用', value: '' };
  let score = 0, label = '变化不明显';
  // 时间周期修正（spec §九）：月末/季末放宽
  const thresh = isMonthEnd ? 0.8 : 0.5;
  if (chg > thresh) { score = 1; label = '杠杆资金加仓'; }
  else if (chg < -thresh) { score = -1; label = '杠杆资金撤离'; }
  const value = `5日 ${chg >= 0 ? '+' : ''}${round(chg, 2)}%`;
  const detail = `沪深融资余额 ${round(m.latest, 0)} 亿元，较 5 个交易日前 ${chg >= 0 ? '+' : ''}${round(chg, 2)}%（阈值 ±${thresh}%${isMonthEnd ? '，月末放宽' : ''}）→ ${label}（融资余额为 T+1 滞后数据，权重按规则 ×0.8）`;
  // 数据滞后打 8 折（spec §九）
  return { score, degraded: false, lagged: true, value, detail, change5Pct: round(chg, 3) };
}

/** 6) 主力资金流向（10%）：今日净流入 ÷ 5 日均净流入 */
function calcMainCapital(d, snapshots) {
  const mf = d.mainFund;
  if (!mf || mf.mainNetToday == null) return { score: 0, degraded: true, reason: '主力资金缺失', value: '' };
  const today = mf.mainNetToday;
  // 5 日净流入样本：由每日快照累计（含今日）
  const hist = snapshots.map(s => s.mainNet).filter(v => typeof v === 'number');
  const series = hist.length ? hist.slice(-5) : [];
  const hasToday = snapshots.some(s => s.date === d.date);
  const pool = hasToday ? series : series.concat([today]).slice(-5);
  if (pool.length < 3) {
    return { score: 0, degraded: true, reason: `主力资金 5 日均样本不足（${pool.length}/5，需累计逐日快照）`, value: `今日主力净额 ${round(today, 1)} 亿`, todayNet: today, sampleDays: pool.length };
  }
  const avg5 = mean(pool) || 0;
  let ratio = null, score = 0, label = '流向平稳';
  if (Math.abs(avg5) > 1e-6) {
    ratio = today / avg5;
    if (ratio > 1.5 && today > 0) { score = 1; label = '主力大幅流入'; }
    else if (ratio > 1.5 && today < 0) { score = -1; label = '主力大幅流出'; }
    else if (today > 0) { score = 0.3; label = '主力小幅流入'; }
    else if (today < 0) { score = -0.3; label = '主力小幅流出'; }
  }
  const value = `今日 ${today >= 0 ? '+' : ''}${round(today, 1)} 亿 · 5日均 ${round(avg5, 1)} 亿`;
  const detail = `市场主力净额（超大单+大单）今日 ${today >= 0 ? '+' : ''}${round(today, 1)} 亿，5 日平均 ${round(avg5, 1)} 亿${ratio != null ? `，比值 ${round(ratio, 2)}` : ''} → ${label}（5日样本 ${pool.length} 天）`;
  return { score, degraded: false, value, detail, todayNet: today, avg5: round(avg5, 2), ratio: ratio != null ? round(ratio, 2) : null, sampleDays: pool.length };
}

/** 7) 股吧讨论热度（10%）· 反向指标 */
function calcDiscussionHeat(d, heatHist, modelDate) {
  const heat = d.discussionHeat;
  if (heat == null || typeof heat.marketHeat !== 'number') {
    return { score: 0, degraded: true, reason: '股吧热度缺失', value: '' };
  }
  const bars = (d.index && d.index.bars) || [];
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date).filter(Boolean);
  const idxChg5 = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] * 100 : null;

  // 时效校验（spec §九）：热度必须与当日同源。原先只取数值、不比对日期，
  // 会在 MSI 当天缺 marketHeat 时静默沿用几天前的旧值（实测缺 09-10 / 09-16）。
  const lagDays = tradingLagDays(heat.date, modelDate, barDates);
  const stale = lagDays == null || lagDays >= LAG_DEGRADE_DAYS;

  // 分位样本：只保留真实交易日，滤掉序列里混入的周末/非交易日读数
  const tradeSet = new Set(barDates);
  let hist = (heatHist || []).filter(h => h && typeof h.heat === 'number' && h.date);
  const droppedNonTrading = tradeSet.size ? hist.filter(h => !tradeSet.has(h.date)).length : 0;
  if (tradeSet.size) hist = hist.filter(h => tradeSet.has(h.date));
  const values = hist.map(h => h.heat);
  const pct = values.length >= 10 ? rankPercentile(values, heat.marketHeat) : null;

  let score = 0, label = '';
  const bigRally = idxChg5 != null && idxChg5 > 2;
  const bigDrop = idxChg5 != null && idxChg5 < -2;
  if (stale) {
    label = `热度数据已过期（${heat.date || '日期未知'}），本日不参与打分`;
  } else if (pct != null && pct > 0.9 && bigRally) { score = -1; label = '散户情绪极度亢奋 + 大盘近期大涨 → 警惕见顶'; }
  else if (pct != null && pct < 0.1 && bigDrop) { score = 1; label = '散户无人问津 + 大盘近期大跌 → 可能见底'; }
  else if (pct != null && pct > 0.5 && pct <= 0.9 && idxChg5 != null && idxChg5 > 0 && idxChg5 <= 2) { score = 0.5; label = '情绪温和放大 + 大盘温和上涨 → 情绪正常发酵'; }
  else if (pct == null) { label = `热度历史样本不足（${values.length}/10），暂时中性`; }
  else { label = '情绪处于常态区间'; }

  const pctText = pct != null ? `历史分位 ${round(pct * 100, 0)}%` : `样本不足（${values.length}/10）`;
  const lagText = lagDays == null ? '热度日期未知' : (lagDays > 0 ? `滞后 ${lagDays} 个交易日` : '当日');
  const srcText = heat.detail ? ` · 来源：${heat.detail}` : '';
  const dropText = droppedNonTrading ? ` · 已滤除 ${droppedNonTrading} 个非交易日样本` : '';
  const value = `热度 ${round(heat.marketHeat, 2)} · ${pctText}`;
  const detail = `股吧全市场讨论热度 ${round(heat.marketHeat, 2)}（${pctText}，${lagText}${dropText}）${srcText}，大盘近 5 日 ${idxChg5 != null ? round(idxChg5, 2) + '%' : '—'} → ${label}`;

  return {
    score,
    degraded: stale || pct == null,
    lagged: !stale && lagDays > 0,   // 滞后 1~2 个交易日：按 spec §九 打 8 折
    reason: stale
      ? `股吧热度${lagDays == null ? '日期未知' : `滞后 ${lagDays} 个交易日`}，已按过期数据剔除`
      : (pct == null ? `股吧热度历史样本不足（${values.length}/10）` : null),
    value, detail,
    heat: heat.marketHeat,
    heatDate: heat.date || null,
    heatPct: pct != null ? round(pct, 3) : null,
    lagDays: lagDays == null ? null : lagDays,
    heatSamples: values.length,
  };
}

/** 8) 避险情绪（10%）：USD/CNH + 国债收益率 */
function calcRiskAversion(d) {
  const fx = d.fx, bond = d.bond;
  const fxChg = fx ? (fx.usdcnhChgPct != null ? fx.usdcnhChgPct : fx.usdcnyChgPct) : null;
  const bondChgBp = bond ? bond.chgBp5 : null;
  if (fxChg == null && bondChgBp == null) return { score: 0, degraded: true, reason: '汇率/国债收益率缺失', value: '' };

  let score = 0, label = '中性';
  const cnhUp = fxChg != null ? fxChg : 0;      // USD/CNH 上行 = 人民币贬值
  const yieldDown = bondChgBp != null ? bondChgBp : 0;
  if (cnhUp > 0.15 && yieldDown < -3) { score = -1; label = '人民币快速贬值 + 国债收益率快速下行 → 资金避险'; }
  else if (cnhUp < -0.15 && yieldDown > 3) { score = 1; label = '人民币企稳升值 + 国债收益率上行 → 风险偏好提升'; }
  else if (cnhUp > 0.15) { label = '人民币贬值（避险倾向），国债未配合'; score = -0.3; }
  else if (yieldDown < -3) { label = '国债收益率快速下行（避险倾向）'; score = -0.3; }
  else if (cnhUp < -0.15 || yieldDown > 3) { label = '边际转暖（人民币或收益率向好）'; score = 0.3; }

  const value = `USD/CNH ${fx ? round(fx.usdcnh || fx.usdcny, 4) : '—'}（${cnhUp >= 0 ? '+' : ''}${round(cnhUp, 2)}%）· 10Y国债 ${bond ? round(bond.cn10y, 3) + '%' : '—'}（${bondChgBp != null ? (bondChgBp >= 0 ? '+' : '') + bondChgBp + 'bp' : '—'}）`;
  const detail = `${label}：美元兑离岸人民币 ${cnhUp >= 0 ? '上行（贬值）' : '下行（升值）'} ${round(Math.abs(cnhUp), 2)}%，中国 10 年期国债收益率 5 日变化 ${bondChgBp != null ? bondChgBp + 'bp' : '—'}`;
  return { score, degraded: false, value, detail, fxChg: round(cnhUp, 3), bondChgBp };
}

/** 9/10) 宏观因子（非常驻）：由 lib/macroSentimentFactors 提供 */
function calcMacro(f) {
  if (!f || typeof f.signal !== 'number') {
    return { score: 0, active: false, value: '未激活', detail: '该宏观因子当前处于休眠状态（无同类事件触发）' };
  }
  const s = clamp(f.signal, -1, 1);
  return {
    score: round(s, 3),
    active: true,
    value: s > 0.05 ? '偏多' : s < -0.05 ? '偏空' : '中性',
    detail: f.interpretation || f.detail || '',
  };
}

// ================= 权重与自学习 =================
/**
 * 有界等比缩放：把一组权重缩放到总和 = target，同时把每一项夹紧在 [min,max]。
 * 超出边界的"溢出量"按比例转嫁给仍处于自由区间的项，因此不会出现
 * "先夹紧再归一 → 又被拉回越界" 的老问题（spec §七 权重硬约束）。
 */
function scaleBounded(vals, target, min, max) {
  const n = vals.length;
  if (!n) return [];
  // 因子太少导致区间装不下 target 时（大面积数据缺失），平移边界使其可行：
  // 仍保持总和 = target，只是被迫越过 5%~30% 的软边界（由调用方记入 dataNote）
  let lo = min, hi = max;
  if (target < n * min) lo = target / n;
  else if (target > n * max) hi = target / n;
  const sum = vals.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  const x = vals.map(v => (v > 0 ? v : 0) / sum * target);
  for (let it = 0; it < 80; it++) {
    let fixed = 0;
    const free = [];
    for (let i = 0; i < n; i++) {
      if (x[i] <= lo + 1e-9) { x[i] = lo; fixed += lo; }
      else if (x[i] >= hi - 1e-9) { x[i] = hi; fixed += hi; }
      else free.push(i);
    }
    if (!free.length) break;
    const targetFree = target - fixed;
    const freeSum = free.reduce((a, i) => a + x[i], 0);
    if (freeSum <= 0) {
      const eq = targetFree / free.length;
      for (const i of free) x[i] = eq;
      continue;
    }
    const scale = targetFree / freeSum;
    let moved = 0;
    for (const i of free) { const nv = x[i] * scale; moved += Math.abs(nv - x[i]); x[i] = nv; }
    if (moved < 1e-9) break;
  }
  return x;
}

function computeWeights(state, activeNonResident) {
  // 基准权重；非常驻休眠→其权重按比例分摊给常驻（spec §三.3 / §七）
  const w = { ...BASE_WEIGHTS };
  const stateW = state.weights || {};
  // 自学习后的常驻权重（若有），否则用基准
  for (const k of Object.keys(BASE_WEIGHTS)) {
    if (!NON_RESIDENT.includes(k) && typeof stateW[k] === 'number') w[k] = stateW[k];
  }
  const residentKeys = Object.keys(BASE_WEIGHTS).filter(k => !NON_RESIDENT.includes(k));

  // 非常驻：激活时用其（衰减后）权重，否则为 0
  let nonSum = 0;
  for (const k of NON_RESIDENT) {
    if (activeNonResident[k]) {
      const ev = (state.events || {})[k];
      // 只有事件确实处于 active 且权重为正时才沿用，否则回落到基准权重。
      // 否则上一次休眠留下的 { status:'dormant', weight:0 } 会把刚激活的因子压成 0。
      const iw = (ev && ev.status === 'active' && typeof ev.weight === 'number' && ev.weight > 0)
        ? ev.weight : BASE_WEIGHTS[k];
      w[k] = iw; nonSum += iw;
    } else {
      w[k] = 0;
    }
  }
  // 常驻权重：等比缩放至 (100 - 非常驻)，并对每项夹紧 [W_MIN, W_MAX]（spec §七）
  const targetResident = Math.max(0, 100 - nonSum);
  const scaled = scaleBounded(residentKeys.map(k => w[k]), targetResident, W_MIN, W_MAX);
  residentKeys.forEach((k, i) => { w[k] = round(scaled[i], 2); });

  // 修正舍入误差：补给仍有余量的常驻因子，避免把某一项顶出边界
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const diff = round(100 - total, 2);
  if (Math.abs(diff) > 0.001) {
    const cand = residentKeys.find(k => w[k] + diff >= W_MIN - 1e-9 && w[k] + diff <= W_MAX + 1e-9) || residentKeys[0];
    w[cand] = round(w[cand] + diff, 2);
  }
  return w;
}

/** 自学习：按最近 30 次因子命中率调整常驻权重（spec §六） */
function learnWeights(state) {
  const acc = state.factorAcc || {};
  const residentKeys = Object.keys(BASE_WEIGHTS).filter(k => !NON_RESIDENT.includes(k));
  const learnLog = [];
  for (const k of residentKeys) {
    const a = acc[k];
    if (!a || !a.samples || a.samples.length < LEARN_MIN_SAMPLE) continue;
    const recent = a.samples.slice(-LEARN_WINDOW);
    const t = recent.length, c = recent.filter(Boolean).length;
    if (!t) continue;
    const rate = c / t;
    let cur = (state.weights && typeof state.weights[k] === 'number') ? state.weights[k] : BASE_WEIGHTS[k];
    let nxt = cur;
    if (rate > UP_THRESHOLD) nxt = cur * (1 + UP_STEP);
    else if (rate < DOWN_THRESHOLD) nxt = cur * (1 - DOWN_STEP);
    nxt = clamp(nxt, W_MIN, W_MAX);
    if (Math.abs(nxt - cur) > 0.01) {
      state.weights[k] = round(nxt, 2);
      learnLog.push({ key: k, name: FACTOR_NAMES[k], rate: round(rate, 3), from: round(cur, 2), to: round(nxt, 2), n: t });
    }
  }
  return learnLog;
}

/** 记录今日各因子方向，供 T+1 结算时统计因子命中率 */
function recordFactorDirections(rec, factors) {
  rec.factorDirs = {};
  for (const f of factors) {
    if (f.type === 'nonResident') continue;
    rec.factorDirs[f.key] = Math.sign(f.score) || 0;
  }
}

// ================= 主流程 =================
/**
 * 计算大盘量能情绪状态。
 * @param {object} opts { data: getMarketEmotionData() 返回值, macroFactors:[], discussionHeat, refresh }
 */
async function computeMarketEmotion(opts = {}) {
  const d = opts.data || {};
  const today = d.date || localDate();
  const state = loadState();
  const snapshots = loadSnapshots();
  const now = new Date();

  // ---- 是否月末/季末（spec §九 时间周期修正）----
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const isMonthEnd = now.getDate() >= lastDayOfMonth - 2;
  const isQuarterEnd = isMonthEnd && [2, 5, 8, 11].includes(now.getMonth());

  // ---- 极端行情熔断（spec §八.6）----
  const bars = (d.index && d.index.bars) || [];
  const closes = bars.map(b => b.close);
  const idxChgPct = closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100 : 0;
  const b = d.breadth || {};
  const circuit = (b.limitDown >= 1000) || (b.limitUp >= 1000) || (Math.abs(idxChgPct) >= 5);

  // ---- 8 个常驻因子 ----
  const factors = [];
  const va = calcVolumeActivity(d);
  factors.push({ key: 'volumeActivity', type: 'resident', ...va });

  const be = calcBreadthExtreme(d);
  factors.push({ key: 'breadthExtreme', type: 'resident', ...be });

  const pv = calcPriceVolume(d);
  factors.push({ key: 'priceVolume', type: 'resident', ...pv });

  const im = calcIndexMomentum(d);
  factors.push({ key: 'indexMomentum', type: 'resident', ...im });

  const mg = calcMargin(d, isMonthEnd);
  factors.push({ key: 'margin', type: 'resident', ...mg });

  const mc = calcMainCapital(d, snapshots);
  factors.push({ key: 'mainCapital', type: 'resident', ...mc });

  const heatHist = mergeHeatHistory(snapshots);
  const dh = calcDiscussionHeat(d, heatHist, today);
  factors.push({ key: 'discussionHeat', type: 'resident', ...dh });

  const ra = calcRiskAversion(d);
  factors.push({ key: 'riskAversion', type: 'resident', ...ra });

  // ---- 顶部出货特殊警示（spec §四.6）----
  let topWarning = null;
  const heatHigh = dh.heatPct != null && dh.heatPct > 0.9;
  const marginSurge = mg.change5Pct != null && mg.change5Pct > 1.5;
  const mainOut = typeof mc.todayNet === 'number' && mc.todayNet < -200;
  if (heatHigh && marginSurge && mainOut) {
    topWarning = '经典顶部出货信号：散户狂热（股吧热度 >90% 分位）+ 融资余额暴增 + 主力资金大幅净流出';
    const f = factors.find(x => x.key === 'mainCapital');
    if (f) f.score = clamp(f.score - 0.5, -1, 1);
  }

  // ---- 2 个非常驻因子 ----
  const macroList = Array.isArray(opts.macroFactors) ? opts.macroFactors : [];
  const domF = macroList.find(f => f.key === 'DOMESTIC_MACRO');
  const usF = macroList.find(f => f.key === 'US_MACRO');
  const domC = calcMacro(domF);
  factors.push({ key: 'domesticMacro', type: 'nonResident', ...domC });
  const usC = calcMacro(usF);
  factors.push({ key: 'usMacro', type: 'nonResident', ...usC });

  const activeNonResident = { domesticMacro: !!domC.active, usMacro: !!usC.active };

  // ---- 权重 ----
  const weights = computeWeights(state, activeNonResident);

  // ---- 数据自检：降级因子（数据源异常/样本不足）→ 权重归零并"有界"分摊（spec §七 / §八.4 / §九）----
  // 注意：分摊必须同时守住 5%~30% 硬边界，否则常驻因子的权重会被"越分越大"冲破上限。
  const degradedKeys = factors.filter(f => f.degraded).map(f => f.key);
  const resKeys = factors.filter(f => f.type !== 'nonResident').map(f => f.key);
  const nonKeys = factors.filter(f => f.type === 'nonResident').map(f => f.key);

  // 1) 先算降级归零 / 滞后打 8 折之后的原始权重
  const rawW = {};
  for (const f of factors) {
    f.name = FACTOR_NAMES[f.key];
    let wv = weights[f.key] || 0;
    if (f.degraded) wv = 0;
    else if (f.lagged) wv = wv * 0.8;   // 数据滞后打 8 折（spec §九）
    rawW[f.key] = wv;
  }
  // 2) 非常驻保持事件权重（可低于 5%），常驻则"有界"缩放到剩余空间
  const nonTarget = round(nonKeys.reduce((a, k) => a + rawW[k], 0), 2);
  const resUsable = resKeys.filter(k => !degradedKeys.includes(k));
  const resTarget = Math.max(0, 100 - nonTarget);
  const resBounded = scaleBounded(resUsable.map(k => rawW[k]), resTarget, W_MIN, W_MAX);
  resUsable.forEach((k, i) => { rawW[k] = resBounded[i]; });
  // 3) 记录是否有因子被"因子数不足"被迫越界（诚实标注，不静默）
  let weightRelaxed = false;
  for (const k of resUsable) {
    if (rawW[k] > W_MAX + 0.01 || rawW[k] < W_MIN - 0.01) weightRelaxed = true;
  }
  for (const f of factors) f.weight = f.degraded ? 0 : round(rawW[f.key] || 0, 2);
  // 4) 总和对齐到 100%（补差给仍有余量的常驻因子，避免顶出边界）
  const wSum = factors.reduce((a, f) => a + (f.weight || 0), 0);
  const gap = round(100 - wSum, 2);
  if (Math.abs(gap) > 0.02) {
    const cand = resUsable
      .map(k => factors.find(f => f.key === k))
      .find(f => f && f.weight + gap >= W_MIN - 0.01 && f.weight + gap <= W_MAX + 0.01);
    if (cand) cand.weight = round(cand.weight + gap, 2);
  }

  // ---- 总分（spec §七）----
  let score10 = 0;
  for (const f of factors) score10 += (f.score || 0) * (f.weight / 100);
  const totalScore = round(clamp(score10, -1, 1), 3);

  // ---- 短期倾向 ----
  let tendency = '中性', tendencyKey = 'neutral';
  if (totalScore >= 0.2) { tendency = '看涨'; tendencyKey = 'bull'; }
  else if (totalScore <= -0.2) { tendency = '看跌'; tendencyKey = 'bear'; }

  // ---- 核心驱动 ----
  const ranked = factors.slice().sort((a, x) => Math.abs((x.score || 0) * x.weight) - Math.abs((a.score || 0) * a.weight));
  const driver = ranked[0];
  const driverText = driver ? `${driver.name}（得分 ${round(driver.score, 2)} × 权重 ${driver.weight}%）` : '—';

  // ---- 量能状态 ----
  const volumeText = `${va.state || '—'}${va.ratio != null ? `（量比 ${va.ratio}）` : ''}；量价${pv.score > 0 ? '配合' : pv.score < 0 ? '背离' : '中性'}`;

  // ---- 操作建议（仓位）----
  let posRange;
  if (totalScore >= 0.5) posRange = '7~8 成';
  else if (totalScore >= 0.25) posRange = '6 成';
  else if (totalScore >= 0) posRange = '5 成';
  else if (totalScore >= -0.25) posRange = '4 成';
  else if (totalScore >= -0.5) posRange = '3 成';
  else posRange = '1~2 成';
  const stance = totalScore >= 0.25 ? '可适度积极' : totalScore <= -0.25 ? '应以谨慎防守为主' : '维持中性、不追高不杀跌';
  let advice = `${stance}，建议仓位 ${posRange}`;

  // ---- 风险提示（只放市场风险，数据缺口另列 dataNote）----
  const risks = [];
  if (pv.score < 0) risks.push('量价背离（放量下跌或量价齐跌）');
  if (be.score < 0) risks.push('市场宽度转弱（普跌且跌停增多）');
  if (be.detail && /结构不健康/.test(be.detail)) risks.push('成交结构不健康（成交额高度集中于前10%个股）');
  if (topWarning) risks.push(topWarning);
  if (dh.score < 0) risks.push('散户情绪过热，存在见顶风险');
  if (va.volPct != null && va.volPct > VOL_PCTL_HIGH) risks.push('量能处于历史高位，警惕过热');
  const divergence = ranked.find(f => (f.key === 'breadthExtreme' || f.key === 'mainCapital' || f.key === 'discussionHeat') && Math.sign(f.score) !== Math.sign(totalScore) && Math.abs(f.score) > 0.3);
  if (divergence) risks.unshift(`最大背离：${divergence.name}（得分 ${round(divergence.score, 2)}）与整体倾向不一致`);
  const riskText = risks.length ? risks.slice(0, 3).join('；') : '暂无明显背离或异常风险点';

  // ---- 数据缺口说明（spec §八.4：缺失因子权重已归零并按比例分摊）----
  const noteParts = [];
  if (degradedKeys.length) {
    noteParts.push(`以下因子因数据源异常/样本不足，已按规则将权重临时归零并分摊给其他因子：` +
      factors.filter(f => f.degraded).map(f => `${f.name}（${f.reason || '数据不可用'}）`).join('、'));
  }
  if (weightRelaxed) {
    noteParts.push('可用因子数量不足，个别因子权重被迫越过 5%~30% 常规区间以保证权重合计 100%，本日结论置信度偏低。');
  }
  const dataNote = noteParts.join(' ');

  // ---- 熔断输出（spec §八.6）----
  if (circuit) {
    advice = '当前市场处于极端状态，模型置信度低，建议观望，等待数据恢复正常。';
  }

  // ---- 学习与准确率 ----
  let records = loadRecords();
  // 结算历史记录（T+1/T+3/T+5）
  const settleResult = settleRecords(records, closes, bars);
  records = settleResult.records;

  // 记录今日预测
  const existing = records.find(r => r.date === today);
  const rec = existing || { date: today, createdAt: new Date().toISOString() };
  rec.score = totalScore;
  rec.tendency = tendency;
  rec.indexClose = closes.length ? round(closes[closes.length - 1], 2) : null;
  rec.indexChgPct = round(idxChgPct, 2);
  rec.baselineDate = bars.length ? bars[bars.length - 1].date : today;
  rec.volumeState = va.state || null;
  rec.topWarning = topWarning;
  // 20260917i：补存结论文字字段，供个股页「大盘」卡片的「市场情绪提醒」子因子直接引用
  // （个股页只读本文件落盘的当日判断、不重算 —— 规则一·指标级单源）。
  rec.tendencyKey = tendencyKey;
  rec.coreDriver = driverText;
  rec.advice = advice;
  rec.riskTip = riskText;
  recordFactorDirections(rec, factors);
  if (!existing) records.push(rec);
  saveRecords(records);

  // 因子准确率台账（用 T+1 结算结果回填）
  applyFactorAccuracy(state, settleResult.settledToday);

  // 权重自学习
  const learnLog = learnWeights(state);
  // 非常驻衰减
  decayEvents(state, today, activeNonResident);

  saveState(state);

  // 快照（供 5 日均值 / 热度历史分位）
  upsertSnapshot(snapshots, {
    date: today,
    mainNet: typeof mc.todayNet === 'number' ? mc.todayNet : (d.mainFund ? d.mainFund.mainNetToday : null),
    // 只在热度与当日同源（lagDays === 0）时记入快照；陈旧/缺失一律记 null。
    // 否则会把上一天的旧热度挂到今天的日期上，污染后续的分位历史样本。
    heat: (typeof dh.heat === 'number' && dh.lagDays === 0) ? dh.heat : null,
    volRatio: va.ratio != null ? va.ratio : null,
    totalAmount: d.capital ? d.capital.totalAmount : null,
    indexClose: closes.length ? round(closes[closes.length - 1], 2) : null,
    score: totalScore,
  });
  saveSnapshots(snapshots);

  // 月度健康报告（spec §八.5）
  const health = maybeMonthlyHealth(state, records, today);

  return {
    model: 'volume-emotion-v1',
    success: true,
    date: today,
    baselineDate: rec.baselineDate,

    // ---- §十 最终输出（简洁直接）----
    totalScore,
    tendency,
    tendencyKey,
    coreDriver: driverText,
    volumeState: volumeText,
    advice,
    riskTip: riskText,
    dataNote,

    // ---- 明细 ----
    factors: factors.map(f => ({
      key: f.key, name: f.name, type: f.type,
      score: round(f.score, 3), weight: f.weight,
      value: f.value || '', detail: f.detail || '',
      degraded: !!f.degraded, reason: f.reason || null, lagged: !!f.lagged,
      // 股吧热度的时效与样本可追溯性（供卡片展示与回归测试断言）
      lagDays: f.lagDays === undefined ? null : f.lagDays,
      heatDate: f.heatDate || null,
      heatPct: f.heatPct === undefined ? null : f.heatPct,
      heatSamples: f.heatSamples === undefined ? null : f.heatSamples,
    })),
    degradedKeys,
    weights,
    learnLog,
    topWarning,
    circuit,
    context: {
      indexChgPct: round(idxChgPct, 2),
      isMonthEnd, isQuarterEnd,
      breadthUp: b.up || null, breadthDown: b.down || null,
      limitUp: b.limitUp || null, limitDown: b.limitDown || null,
    },
    health,
    accuracy: computeAccuracy(records),
    issues: d.issues || [],
    warnings: d.warnings || [],
    sampleNote: `共 10 个因子（8 常驻 + 2 非常驻）；本日 ${degradedKeys.length ? `有 ${degradedKeys.length} 个因子因数据不足/异常按规则归零并分摊权重` : '全部因子数据齐备'}。`,
    source: '东方财富（大盘资金流）、同花顺（成交额/换手率/集中度）、乐咕乐股（涨跌家数/涨跌停）、腾讯（上证量价）、新浪（人民币汇率）、中美国债收益率；主力=超大单+大单。',
    _weightsSnapshot: weights,
  };
}

function upsertSnapshot(arr, snap) {
  const i = arr.findIndex(s => s.date === snap.date);
  if (i >= 0) arr[i] = { ...arr[i], ...snap };
  else arr.push(snap);
  arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (arr.length > 400) arr.splice(0, arr.length - 400);
}

/** T+1/T+3/T+5 结算 + 因子方向命中回填 */
function settleRecords(records, closes, bars) {
  const dateToIdx = {};
  (bars || []).forEach((b, i) => { dateToIdx[b.date] = i; });
  const settledToday = [];
  for (const r of records) {
    if (r.settledT5) continue;
    const bi = dateToIdx[r.baselineDate];
    if (bi == null) continue;
    const base = bars[bi].close;
    const check = (n, field, flagField) => {
      const ti = bi + n;
      if (r[flagField]) return;
      if (ti >= bars.length) return;
      const chg = (bars[ti].close - base) / base * 100;
      const dir = Math.abs(chg) <= FLAT_TOL ? 'flat' : (chg > 0 ? 'up' : 'down');
      r[field] = { targetDate: bars[ti].date, chgPct: round(chg, 2), dir };
      r[flagField] = true;
      if (n === 1) {
        // 判定方向命中
        const pred = r.tendency === '看涨' ? 'up' : r.tendency === '看跌' ? 'down' : 'flat';
        r.correctT1 = (r.tendency === '中性') ? (dir === 'flat') : (pred === dir);
        settledToday.push({ record: r, actualDir: dir });
      }
    };
    check(1, 'resultT1', 'settledT1');
    check(3, 'resultT3', 'settledT3');
    check(5, 'resultT5', 'settledT5');
    if (r.settledT1 && !r.settledT3 && bi + 3 >= bars.length) { /* 尚未到 */ }
  }
  return { records, settledToday };
}

function applyFactorAccuracy(state, settledToday) {
  if (!state.factorAcc) state.factorAcc = {};
  for (const { record, actualDir } of settledToday) {
    if (!record.factorDirs) continue;
    const actualUp = actualDir === 'up';
    for (const [key, dir] of Object.entries(record.factorDirs)) {
      if (dir === 0) continue; // 中性因子不参与命中统计
      if (!state.factorAcc[key]) state.factorAcc[key] = { samples: [], total: 0, correct: 0 };
      const ok = (dir > 0) === actualUp;
      state.factorAcc[key].samples.push(ok);
      state.factorAcc[key].total++;
      if (ok) state.factorAcc[key].correct++;
      if (state.factorAcc[key].samples.length > 200) state.factorAcc[key].samples.shift();
    }
  }
}

/** 非常驻因子衰减（spec §五） */
function decayEvents(state, today, active) {
  if (!state.events) state.events = {};
  for (const k of NON_RESIDENT) {
    const ev = state.events[k] || { status: 'dormant', weight: 0, lastTrigger: null };
    if (active[k]) {
      if (ev.status !== 'active') { ev.status = 'active'; ev.weight = BASE_WEIGHTS[k]; }
      ev.lastTrigger = ev.lastTrigger || today;
    } else if (ev.status === 'active') {
      // 未激活则按日衰减（每次运行衰减一次，按日期去重）
      if (ev.lastDecay !== today) {
        ev.lastDecay = today;
        ev.weight = round((ev.weight || BASE_WEIGHTS[k]) * DECAY_PER_DAY, 2);
        if (ev.weight < DECAY_FLOOR) { ev.weight = 0; ev.status = 'dormant'; }
      }
    }
    state.events[k] = ev;
  }
}

/** 准确率统计 */
function computeAccuracy(records) {
  const settled = records.filter(r => r.settledT1);
  const correct = settled.filter(r => r.correctT1).length;
  const byDir = { up: { t: 0, c: 0 }, down: { t: 0, c: 0 }, flat: { t: 0, c: 0 } };
  for (const r of settled) {
    const key = r.tendency === '看涨' ? 'up' : r.tendency === '看跌' ? 'down' : 'flat';
    byDir[key].t++; if (r.correctT1) byDir[key].c++;
  }
  const rate = p => (p.t ? round(p.c / p.t * 100, 1) : null);
  return {
    totalRecords: records.length,
    settledCount: settled.length,
    accuracy: settled.length ? round(correct / settled.length * 100, 1) : null,
    bullRate: rate(byDir.up), bullTotal: byDir.up.t,
    bearRate: rate(byDir.down), bearTotal: byDir.down.t,
    flatRate: rate(byDir.flat), flatTotal: byDir.flat.t,
    horizonLabel: 'T+1 / T+3 / T+5',
    source: '大盘量能情绪模型（短期倾向 vs 上证指数实际涨跌，容差 ±0.5%）',
  };
}

/** 月度健康报告（spec §八.5）：每月最后一个自然日生成 */
function maybeMonthlyHealth(state, records, today) {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() !== lastDay) {
    // 非月末：返回既有报告摘要
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev = readJson(path.join(HEALTH_DIR, key + '.json'), null);
    return prev ? { month: key, generatedAt: prev.generatedAt, report: prev.report } : null;
  }
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthRecs = records.filter(r => r.settledT1 && (r.date || '').slice(0, 7) === key);
  const factorStats = {};
  const acc = state.factorAcc || {};
  const failures = [];
  for (const [k, a] of Object.entries(acc)) {
    const recent = (a.samples || []).slice(-30);
    if (!recent.length) continue;
    const rate = recent.filter(Boolean).length / recent.length;
    factorStats[k] = { name: FACTOR_NAMES[k] || k, rate: round(rate, 3), n: recent.length };
    const tail = (a.samples || []).slice(-10);
    if (tail.length === 10 && tail.filter(x => !x).length >= 6) {
      failures.push(`${FACTOR_NAMES[k] || k}：最近 10 次准确率低于 40%`);
      // 连续 10 次 <40% → 权重压到底线
      if (!NON_RESIDENT.includes(k)) state.weights[k] = W_MIN;
    }
  }
  const report = {
    month: key,
    settledCount: monthRecs.length,
    accuracy: monthRecs.length ? round(monthRecs.filter(r => r.correctT1).length / monthRecs.length * 100, 1) : null,
    factorStats,
    failedFactors: failures,
  };
  ensureHealthDir();
  writeJson(path.join(HEALTH_DIR, key + '.json'), { month: key, generatedAt: new Date().toISOString(), report });
  return { month: key, generatedAt: new Date().toISOString(), report };
}

/**
 * 读「最近一条」每日情绪判断（20260917i 新增）。
 * 供个股页「大盘」卡片的「市场情绪提醒」子因子直接引用首页判断，
 * 避免个股页重算导致与首页双源不一致（规则一·指标级单源）。
 * @returns {object|null} { date, score, tendency, tendencyKey, coreDriver, volumeState, advice, riskTip, baselineDate, indexChgPct }
 *   无记录或记录异常时返回 null（调用方按中性处理）。
 */
function readLatestJudgment() {
  let a = [];
  try { a = loadRecords(); } catch (e) { return null; }
  if (!Array.isArray(a) || !a.length) return null;
  const rec = a[a.length - 1];
  if (!rec || typeof rec.score !== 'number') return null;
  return {
    date: rec.date || null,
    score: rec.score,
    tendency: rec.tendency || '震荡',
    tendencyKey: rec.tendencyKey || null,
    coreDriver: rec.coreDriver || '',
    volumeState: rec.volumeState || '',
    advice: rec.advice || '',
    riskTip: rec.riskTip || '',
    baselineDate: rec.baselineDate || null,
    indexChgPct: rec.indexChgPct != null ? rec.indexChgPct : null,
  };
}

module.exports = {
  computeMarketEmotion,
  readLatestJudgment,
  BASE_WEIGHTS, FACTOR_NAMES, NON_RESIDENT, W_MIN, W_MAX,
  percentile, rankPercentile, trimExtremes,
  DIR,
};
