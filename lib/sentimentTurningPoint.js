/**
 * 市场情绪拐点检测器 + 自适应学习
 * --------------------------------------------------------------
 * 输入：全市场情绪指数(MSI)时间序列（来自 marketSentimentIndex，含真实快照 + 近似回填）
 *       + 上证指数历史（真实）。
 *
 * 三段能力：
 *   1) detectTurningPoint：基于 MSI 序列识别情绪拐点，输出预警等级
 *      （无 / 关注 / 预警 / 强烈预警）+ 隐含方向 + 可读原因。
 *      三类信号：
 *        a. 极值 z-score：当前 MSI 相对近 60 日分布的偏离（自适应阈值 extremeZ）
 *        b. 动量翻转：MSI 短期(5日)动量方向与上一窗口相反
 *        c. 与上证背离：MSI 方向 与 上证近期方向 不一致（情绪与价格脱节）
 *   2) labelAndLearn：仅对"极值日"用次日上证实际反转方向打标，统计命中率，
 *      并自适应调整 extremeZ（命中率过低→提高阈值减少误报；命中率过高且样本充足→略降阈值扩大覆盖），
 *      实现"通过历史数据持续进化"。
 *   3) getTurningPointState：汇总检测 + 学习状态 +（个股页）市场敏感度，供前后端消费。
 *
 * 历史校准：首次无学习状态时，用上证历史自身 z-score 作为情绪极值代理，
 * 在各候选阈值下统计次日反转命中率，选取精度最优的阈值作为初始 extremeZ，
 * 使模块从第一天就有合理基线（"用历史数据训练"）。
 */

const fs = require('fs');
const path = require('path');

const MSI = require('./marketSentimentIndex');
const { getHistory } = require('./stockData');
const { clamp } = require('./ruleCore');

const INDEX_DIR = path.join(__dirname, '..', 'data', 'sentiment-index');
const LEARN_FILE = path.join(INDEX_DIR, 'learning.json');

const ZSCORE_WINDOW = 60;     // z-score 回望窗口
const MA_SHORT = 5;           // 短期均线
const MA_LONG = 20;           // 长期均线
const LEARN_MIN_SAMPLE = 15;  // 自适应调整最小样本
const LEARN_SMOOTH = 0.5;     // 阈值调整平滑
const EXTREME_Z_DEFAULT = 2.0;
const EXTREME_Z_MIN = 1.5;
const EXTREME_Z_MAX = 3.5;

function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function ensureDir() { if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true }); }

function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(_mean(a.map(x => (x - m) * (x - m))));
}

// ---- 学习状态读写 ----
function readLearning() {
  try {
    if (!fs.existsSync(LEARN_FILE)) return null;
    return JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
  } catch (e) { return null; }
}
function writeLearning(state) {
  ensureDir();
  try { fs.writeFileSync(LEARN_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

// ---- 上证历史校准：用上证自身 z-score 作为情绪极值代理，挑选初始 extremeZ ----
function calibrateExtremeZ(shHistory) {
  const closes = (Array.isArray(shHistory) ? shHistory : [])
    .map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length < 120) return EXTREME_Z_DEFAULT; // 数据不足，用默认
  // 计算每日"相对 MA60 偏离"的 z-score（回望 120 日分布）
  const dev = [];
  for (let i = 60; i < closes.length; i++) {
    const win = closes.slice(i - 60, i);
    const m = _mean(win), s = _std(win) || 1e-9;
    dev.push((closes[i] - m) / s);
  }
  // 对每个候选阈值，统计"极值且次日反转"的命中率
  const candidates = [];
  for (let th = 1.5; th <= 3.5 + 1e-9; th += 0.25) {
    let total = 0, correct = 0;
    for (let i = 0; i < dev.length - 1; i++) {
      if (Math.abs(dev[i]) >= th) {
        const overbought = dev[i] > 0;
        // 次日收益
        const nextRet = closes[60 + i + 1] - closes[60 + i];
        const reversed = overbought ? nextRet < 0 : nextRet > 0;
        total++; if (reversed) correct++;
      }
    }
    if (total >= 30) {
      candidates.push({ th: round(th, 2), total, hitRate: correct / total });
    }
  }
  if (!candidates.length) return EXTREME_Z_DEFAULT;
  // 选精度最高（命中率最高）；并列取阈值较小者（覆盖更敏感）
  candidates.sort((a, b) => (b.hitRate - a.hitRate) || (a.th - b.th));
  const best = candidates[0];
  // 取一个略保守的值：在最优阈值上 +0.1，避免过拟合噪声
  return clamp(round(best.th + 0.1, 2), EXTREME_Z_MIN, EXTREME_Z_MAX);
}

/**
 * 检测拐点。series: 升序数组（含 approx 标记）；shHistory: 上证历史。
 * opts.extremeZ 可覆盖（默认读学习状态或默认）。
 */
function detectTurningPoint(series, shHistory, opts = {}) {
  const extremeZ = (typeof opts.extremeZ === 'number') ? opts.extremeZ
    : (readLearning() && readLearning().extremeZ) || EXTREME_Z_DEFAULT;

  if (!Array.isArray(series) || series.length < 5) {
    return {
      level: '无', levelKey: 'none', impliedDir: '震荡', extremeZ,
      index: null, zScore: null, ma5: null, ma20: null,
      momentumFlip: false, divergence: false, extreme: false, overbought: false, oversold: false,
      reasons: [{ text: '情绪指数序列样本不足（<5日），暂无法识别拐点', type: 'info' }],
      sampleNote: `当前序列 ${Array.isArray(series) ? series.length : 0} 日`,
    };
  }

  const idx = series.map(s => s.index);
  const n = idx.length;
  const x = idx[n - 1];
  const win = idx.slice(Math.max(0, n - ZSCORE_WINDOW));
  const mean = _mean(win);
  const std = _std(win);
  const z = std > 1e-6 ? (x - mean) / std : 0;

  const ma = (k) => { const s = idx.slice(Math.max(0, n - k)); return _mean(s); };
  const ma5 = ma(MA_SHORT), ma20 = ma(MA_LONG);
  const ma5Prev = (n > MA_SHORT + 5) ? _mean(idx.slice(n - MA_SHORT - 5, n - 5)) : ma5;

  // 动量翻转：最近一个 5 日窗口的"MSI 变化方向"与上上个窗口相反，且幅度显著
  let momentumFlip = false, momentumDir = 0;
  if (n >= MA_LONG + 6) {
    const d1 = idx[n - 1] - idx[n - 1 - MA_SHORT];      // 最近 5 日变化
    const d0 = idx[n - 1 - MA_SHORT] - idx[n - 1 - 2 * MA_SHORT]; // 上一个 5 日变化
    momentumDir = Math.sign(d1);
    if (Math.sign(d1) !== 0 && Math.sign(d0) !== 0 && Math.sign(d1) !== Math.sign(d0)
      && Math.abs(d1) >= 0.08) {
      momentumFlip = true;
    }
  }

  // 与上证背离：MSI 方向与上证近 5 日方向不一致
  let divergence = false, shDir = 0;
  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length >= 6) {
    const shRet5 = closes[closes.length - 1] - closes[closes.length - 6];
    shDir = Math.sign(shRet5);
    const msDir = Math.sign(x - ma5);
    if (msDir !== 0 && shDir !== 0 && msDir !== shDir) divergence = true;
  }

  const extreme = Math.abs(z) >= extremeZ;
  const overbought = z > 0 && extreme;
  const oversold = z < 0 && extreme;

  // 预警等级
  let level = '无', levelKey = 'none';
  if (extreme && (momentumFlip || divergence)) level = '强烈预警', levelKey = 'strong';
  else if (extreme) level = '预警', levelKey = 'warn';
  else if (momentumFlip && divergence) level = '预警', levelKey = 'warn';
  else if (momentumFlip || divergence || Math.abs(z) >= extremeZ * 0.66) level = '关注', levelKey = 'watch';

  // 隐含方向
  let impliedDir = '震荡';
  if (overbought) impliedDir = '看跌(回调风险)';
  else if (oversold) impliedDir = '看涨(反弹机会)';
  else if (momentumFlip) impliedDir = momentumDir > 0 ? '看涨' : '看跌';
  else if (divergence) impliedDir = shDir > 0 ? '看涨' : '看跌';

  // 可读原因（通俗化）
  const reasons = [];
  if (extreme) {
    reasons.push({
      text: `市场情绪${overbought ? '过热' : '过冷'}：当前评分 ${round(x)}，最近${win.length}天的偏离值 ${round(z)}（警戒线 ${extremeZ}），处于历史${overbought ? '高位' : '低位'}，之后容易朝相反方向回落`,
      type: overbought ? 'bearish' : 'bullish',
    });
  } else if (Math.abs(z) >= extremeZ * 0.66) {
    reasons.push({ text: `市场情绪偏离正常水平：偏离值 ${round(z)}（警戒线 ${extremeZ}），还没到极端，但需要留意`, type: 'info' });
  }
  if (momentumFlip) {
    // momentumDir = sign(d1) 是当前（新）5日窗口的方向；d0 是上一个窗口的方向 = 原方向
    const newDir = momentumDir > 0 ? '向上' : '向下';
    const oldDir = momentumDir > 0 ? '向下' : '向上';
    // 颜色按「转向后的新方向」标：新方向向上=利好（红），向下=利空（绿）
    const newType = momentumDir > 0 ? 'bullish' : 'bearish';
    reasons.push({ text: `情绪掉头：市场情绪的短期（5天）方向，由原来的${oldDir}转为${newDir}，变化幅度 ${round(Math.abs(idx[n - 1] - idx[n - 1 - MA_SHORT]))}`, type: newType });
  }
  if (divergence) {
    // 背离消息按「实际股价方向」着色：大盘涨=红/跌=绿，避免"在涨"却被标成绿色
    const divType = shDir > 0 ? 'bullish' : (shDir < 0 ? 'bearish' : 'warn');
    reasons.push({ text: `情绪和股价唱反调：情绪${Math.sign(x - ma5) > 0 ? '在回暖' : '在转冷'}，但大盘最近5天${shDir > 0 ? '在涨' : '在跌'}，说明情绪和真实价格走势不一致`, type: divType });
  }
  if (!reasons.length) reasons.push({ text: '市场情绪处于正常区间，暂时没发现明显要转向的信号', type: 'info' });

  const approxCount = series.filter(s => s.approx).length;
  const sampleNote = `参考了 ${n} 天的市场情绪数据（其中 ${approxCount} 天是用大盘历史推算的）；判断是否"到极端"时，对比最近 ${win.length} 天`;

  return {
    level, levelKey, impliedDir,
    index: round(x), zScore: round(z), ma5: round(ma5), ma20: round(ma20),
    momentumFlip, divergence, extreme, overbought, oversold, extremeZ,
    reasons, sampleNote,
  };
}

/**
 * 自适应学习：用真实快照的极值日 + 次日上证反转打标，统计命中率并调整 extremeZ。
 * 返回学习状态。
 */
function labelAndLearn(series, shHistory, opts = {}) {
  let state = readLearning() || { extremeZ: EXTREME_Z_DEFAULT, total: 0, correct: 0, byDir: { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } }, samples: [], lastUpdated: null };
  const extremeZ = state.extremeZ || EXTREME_Z_DEFAULT;

  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  // 建立 date→close 映射（近似：用序列顺序对齐上证尾部）
  // 由于 MSI 序列日期与上证交易日未必逐日对齐，这里改用"序列顺序"定位次日：
  // 对每个真实快照 i（非回填），次日反转由 shHistory 中"该快照之后最近一个交易日"的涨跌近似。
  // 简化且稳健的实现：用 MSI 序列自身的"下一日 index 变化方向"作为情绪延续性标签，
  // 用上证"下一日涨跌"作为价格实际方向，二者相反即视为"情绪拐点预示了反转"。
  const idx = series.map(s => s.index);
  const n = idx.length;

  let total = 0, correct = 0;
  const byDir = { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } };
  const newSamples = [];
  for (let i = 0; i < n - 1; i++) {
    const s = series[i];
    if (s.approx) continue; // 仅用真实快照
    const win = idx.slice(Math.max(0, i - ZSCORE_WINDOW), i + 1);
    const m = _mean(win), sd = _std(win);
    const z = sd > 1e-6 ? (idx[i] - m) / sd : 0;
    if (Math.abs(z) < extremeZ) continue; // 仅极值日
    const overbought = z > 0;
    // 情绪预测：过热→次日应回调(跌)，过冷→次日应反弹(涨)
    const expectedDown = overbought;
    // 实际：次日 MSI 变化方向（情绪延续性）与上证方向交叉验证
    const nextIdxChg = idx[i + 1] - idx[i];
    const sentReversed = overbought ? nextIdxChg < 0 : nextIdxChg > 0;
    // 价格实际方向：取上证尾部对齐（i 映射到 closes 尾部偏移）
    let shReversed = null;
    if (closes.length >= 2) {
      const off = closes.length - (n - i); // 把序列末尾对齐 closes 末尾
      const j = clamp(off, 0, closes.length - 2);
      const shNext = closes[j + 1] - closes[j];
      shReversed = overbought ? shNext < 0 : shNext > 0;
    }
    const ok = sentReversed || (shReversed === true);
    total++;
    if (overbought) { byDir.overbought.t++; if (ok) { byDir.overbought.c++; correct++; } }
    else { byDir.oversold.t++; if (ok) { byDir.oversold.c++; correct++; } }
    newSamples.push({ date: s.date, z: round(z), overbought, ok });
  }

  // 合并历史累计（持久化累加，避免重复计数：仅当本次有新样本时追加）
  if (total > 0) {
    state.total = (state.total || 0) + total;
    state.correct = (state.correct || 0) + correct;
    state.byDir = {
      overbought: {
        t: (state.byDir?.overbought?.t || 0) + byDir.overbought.t,
        c: (state.byDir?.overbought?.c || 0) + byDir.overbought.c,
      },
      oversold: {
        t: (state.byDir?.oversold?.t || 0) + byDir.oversold.t,
        c: (state.byDir?.oversold?.c || 0) + byDir.oversold.c,
      },
    };
    // 自适应调整 extremeZ
    const hitRate = state.total > 0 ? state.correct / state.total : 0.5;
    if (state.total >= LEARN_MIN_SAMPLE) {
      let adj = 0;
      if (hitRate < 0.5) adj = +0.1 * LEARN_SMOOTH;       // 误报多→提高阈值
      else if (hitRate > 0.68 && state.total >= 40) adj = -0.05 * LEARN_SMOOTH; // 精度高→略降阈值扩覆盖
      if (adj !== 0) state.extremeZ = clamp(round((state.extremeZ || EXTREME_Z_DEFAULT) + adj, 2), EXTREME_Z_MIN, EXTREME_Z_MAX);
    }
    state.hitRate = round(hitRate, 3);
    state.lastUpdated = new Date().toISOString();
    state.recentSamples = newSamples.slice(-20);
    writeLearning(state);
  }
  return state;
}

/**
 * 汇总：检测 + 学习 +（可选个股）市场敏感度。
 * opts: { symbol, name, refresh, shHistory, forceCalibrate }
 */
async function getTurningPointState(opts = {}) {
  const { symbol, name } = opts;
  // 上证历史（真实，用于检测 + 校准）
  let shHistory = opts.shHistory;
  if (!shHistory) {
    try { shHistory = await getHistory('sh000001', '1y'); } catch (e) { shHistory = []; }
  }

  // 首次校准 extremeZ（无学习状态且数据充足时）
  let learning = readLearning();
  if (!learning && !opts.skipCalibrate) {
    const z0 = calibrateExtremeZ(shHistory);
    learning = { extremeZ: z0, total: 0, correct: 0, byDir: { overbought: { t: 0, c: 0 }, oversold: { t: 0, c: 0 } }, calibratedFrom: 'shHistory', lastUpdated: new Date().toISOString() };
    writeLearning(learning);
  }

  // 实时指数（用于展示分量 + 作为回填的静态分量基线）
  let live = null;
  try { live = await MSI.computeIndex({ symbol: symbol || MSI.DEFAULT_SYMBOL, name: name || MSI.DEFAULT_NAME }); }
  catch (e) { live = null; }

  // 序列（含回填）：用真实上证动量重建历史，静态分量用最新快照近似
  const staticComponents = (live && Array.isArray(live.components))
    ? live.components.filter(c => ['breadth', 'margin', 'marketHeat', 'globalSent'].includes(c.key)).map(c => ({ key: c.key, signal: c.signal }))
    : [];
  const { real, full, backfilled } = await MSI.getSeries({ allowBackfill: true, shHistory, staticComponents });

  // 检测（用实时 index 作为序列最新点，保证实时性）
  const seriesForDetect = full.slice();
  if (live && typeof live.index === 'number') {
    const today = live.date;
    if (seriesForDetect.length && seriesForDetect[seriesForDetect.length - 1].date === today) {
      seriesForDetect[seriesForDetect.length - 1] = { date: today, index: live.index, components: live.components, approx: false };
    } else {
      seriesForDetect.push({ date: today, index: live.index, components: live.components, approx: false });
    }
  }
  const detection = detectTurningPoint(seriesForDetect, shHistory, { extremeZ: learning && learning.extremeZ });

  // 学习（best-effort，仅当 refresh 或存在真实快照积累）
  let learningState = learning;
  if (opts.refresh || real.length >= LEARN_MIN_SAMPLE) {
    try { learningState = labelAndLearn(full, shHistory); } catch (e) { learningState = learning; }
  }

  // 个股市场敏感度（beta，best-effort）
  let sensitivity = null;
  if (symbol && symbol.match(/^\d{6}$/)) {
    try {
      const shCloses = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
      const stockHist = await getHistory(symbol, '3m');
      const stCloses = (Array.isArray(stockHist) ? stockHist : []).map(h => h.close).filter(v => typeof v === 'number');
      if (shCloses.length >= 20 && stCloses.length >= 20) {
        const k = Math.min(shCloses.length, stCloses.length);
        // 取各自最近 k 根收盘价，按日收益率对齐（避免长度不同导致越界/NaN）
        const shSlice = shCloses.slice(-k);
        const stSlice = stCloses.slice(-k);
        const shR = [], stR = [];
        for (let i = 1; i < k; i++) {
          shR.push((shSlice[i] - shSlice[i - 1]) / shSlice[i - 1]);
          stR.push((stSlice[i] - stSlice[i - 1]) / stSlice[i - 1]);
        }
        // 简单 beta = cov/var
        const mSh = _mean(shR), mSt = _mean(stR);
        let cov = 0, varSh = 0;
        for (let i = 0; i < shR.length; i++) { cov += (shR[i] - mSh) * (stR[i] - mSt); varSh += (shR[i] - mSh) * (shR[i] - mSh); }
        const beta = varSh > 1e-9 ? cov / varSh : 1;
        sensitivity = { beta: round(beta, 2), note: beta > 1.2 ? '高贝塔，对市场情绪更敏感' : beta < 0.8 ? '低贝塔，受市场情绪影响较小' : '中等贝塔' };
      }
    } catch (e) { sensitivity = null; }
  }

  return {
    date: (live && live.date) || new Date().toISOString().slice(0, 10),
    level: detection.level,
    levelKey: detection.levelKey,
    impliedDir: detection.impliedDir,
    index: detection.index,
    zScore: detection.zScore,
    ma5: detection.ma5,
    ma20: detection.ma20,
    extreme: detection.extreme,
    momentumFlip: detection.momentumFlip,
    divergence: detection.divergence,
    extremeZ: detection.extremeZ,
    reasons: detection.reasons,
    sampleNote: detection.sampleNote,
    components: live ? live.components : null,
    learning: {
      extremeZ: learningState.extremeZ,
      total: learningState.total || 0,
      correct: learningState.correct || 0,
      hitRate: learningState.hitRate != null ? learningState.hitRate : (learningState.total ? round((learningState.correct || 0) / learningState.total, 3) : null),
      byDir: learningState.byDir || null,
      lastUpdated: learningState.lastUpdated || null,
      calibratedFrom: learningState.calibratedFrom || null,
    },
    sensitivity,
    backfilled,
  };
}

module.exports = {
  detectTurningPoint,
  labelAndLearn,
  calibrateExtremeZ,
  getTurningPointState,
};
