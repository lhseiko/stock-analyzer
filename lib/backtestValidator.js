'use strict';
/**
 * lib/backtestValidator.js
 * 个股量化策略虚拟盘风控校验模块（纯 JS 实现，无外部依赖）
 *
 * 设计：输入锁死 + 确定性计算（与项目其他模块一致：数值一律代码计算，LLM 不参与估值/统计）。
 * 统计检验为本机 JS 移植首版（ADF/KPSS/ACF/PACF/OLS/Engle-Granger 协整），
 * 临界值采用标准近似常数并标注 TODO，后续可替换为 statsmodels 级精度。
 *
 * 6 阶段流水线：
 *   1) 取数（复用 lib/stockData.getHistory 前复权日线）
 *   2) DSL 解析（JSON 或 行式文本）
 *   3) 表达式求值（指标 + 信号函数）
 *   4) 虚拟盘 T+1 回测（次日开盘成交，0.55%/笔成本）
 *   5) 统计检验（平稳性 / 协整 / 自相关 / 趋势）
 *   6) 五大胜率修正 + 操作建议（结构化 JSON 输出）
 */

const { getHistory } = require('./stockData');
const strategyNL = require('./strategyNL');

// =====================================================================
//  数学基础（无依赖）
// =====================================================================
function mean(a) {
  if (!a || a.length === 0) return 0;
  let s = 0;
  for (const v of a) s += (isFinite(v) ? v : 0);
  return s / a.length;
}
function variance(a) {
  if (!a || a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) { const d = (isFinite(v) ? v : 0) - m; s += d * d; }
  return s / (a.length - 1);
}
function std(a) { return Math.sqrt(variance(a)); }
function covariance(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let s = 0;
  for (let i = 0; i < n; i++) s += ((isFinite(x[i]) ? x[i] : 0) - mx) * ((isFinite(y[i]) ? y[i] : 0) - my);
  return s / (n - 1);
}
function diff(a) {
  const out = [0];
  for (let i = 1; i < a.length; i++) out.push((a[i] || 0) - (a[i - 1] || 0));
  return out;
}
function corr(x, y) { return covariance(x, y) / (std(x) * std(y) || 1); }

// 高斯消元解线性系统 Ax=b（A 为 n×n，b 为长度 n）
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.slice().concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}
// 矩阵求逆（n×n）
function matInverse(A) {
  const n = A.length;
  const M = A.map((row, i) => row.slice().concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}
// 通用 OLS：X（行=观测，列=特征），y。返回系数 / t 值 / R² / 残差
function olsGeneral(X, y) {
  const n = X.length, k = X[0].length;
  const Xt = Array.from({ length: k }, (_, j) => X.map(row => row[j]));
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => {
    let s = 0; for (let r = 0; r < n; r++) s += Xt[i][r] * Xt[j][r]; return s;
  }));
  const Xty = Xt.map(col => { let s = 0; for (let r = 0; r < n; r++) s += col[r] * y[r]; return s; });
  const beta = solveLinear(XtX, Xty);
  const yhat = X.map(row => row.reduce((acc, v, j) => acc + v * beta[j], 0));
  const resid = y.map((v, i) => v - yhat[i]);
  const sse = resid.reduce((acc, v) => acc + v * v, 0);
  const my = mean(y);
  const sst = y.reduce((acc, v) => acc + (v - my) * (v - my), 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const dof = Math.max(n - k, 1);
  const sigma2 = sse / dof;
  let XtXInv;
  try { XtXInv = matInverse(XtX); } catch (e) { XtXInv = null; }
  const tStats = beta.map((b, j) => {
    if (!XtXInv) return 0;
    const se = Math.sqrt(Math.max(sigma2 * XtXInv[j][j], 0));
    return se > 0 ? b / se : 0;
  });
  return { beta, tStats, r2, resid, n, k };
}

// =====================================================================
//  统计检验（首版 JS 移植，临界值近似，标注 TODO）
// =====================================================================
// ACF（自相关函数）
function acf(series, lag) {
  const n = series.length;
  if (n <= lag + 1) return 0;
  const sub = series.slice(lag);
  const base = series.slice(0, n - lag);
  const c0 = covariance(series, series);
  const cl = covariance(base, sub);
  return c0 > 0 ? cl / c0 : 0;
}
// PACF（偏自相关）—— Levinson-Durbin 递推取最后系数
function pacf(series, maxLag) {
  const r = [];
  for (let k = 0; k <= maxLag; k++) r.push(acf(series, k));
  const out = [1];
  let a = [], prevErr = r[0];
  for (let k = 1; k <= maxLag; k++) {
    let num = r[k];
    for (let j = 1; j < k; j++) num += a[j - 1] * r[k - j];
    const kcoef = prevErr > 0 ? -num / prevErr : 0;
    const newA = a.map(v => v);
    newA.unshift(kcoef);
    for (let j = 0; j < a.length; j++) newA[j + 1] += kcoef * a[a.length - 1 - j];
    const err = (1 - kcoef * kcoef) * prevErr;
    out.push(newA[0]);
    a = newA; prevErr = err;
  }
  return out; // [lag0, lag1, ...]
}

// ADF 检验（含常数项 + 滞后项），返回 t 统计量 + 临界值近似
function adf(series, lags = 1) {
  const n = series.length;
  if (n < lags + 4) return { stat: 0, pValueApprox: 1, stationary: false, critical: { p10: -2.57, p5: -2.86, p1: -3.43 }, note: '样本不足' };
  const dy = diff(series);
  const ylag = series.slice(0, n - 1); // y[t-1]
  const rows = [];
  for (let t = lags + 1; t < n; t++) {
    const row = [1, ylag[t - 1]];
    for (let l = 1; l <= lags; l++) row.push(dy[t - l]);
    rows.push(row);
  }
  const yv = dy.slice(lags + 1);
  const fit = olsGeneral(rows, yv);
  const tStat = fit.tStats[1]; // y[t-1] 系数 t 值
  const cv = { p10: -2.57, p5: -2.86, p1: -3.43 }; // 含常数项近似
  // p 值近似：在临界值间线性插值（粗略）
  let p = 1;
  if (tStat <= cv.p1) p = 0.01;
  else if (tStat <= cv.p5) p = 0.01 + (tStat - cv.p1) / (cv.p5 - cv.p1) * 0.04;
  else if (tStat <= cv.p10) p = 0.05 + (tStat - cv.p5) / (cv.p10 - cv.p5) * 0.05;
  else p = 0.10 + (tStat - cv.p10) / (1.0 - cv.p10) * 0.9;
  return { stat: tStat, pValueApprox: Math.max(0, Math.min(1, p)), stationary: tStat < cv.p5, critical: cv, note: 'ADF(含常数项) 近似，临界值为标准值' };
}

// KPSS 检验（原假设：平稳），长程方差用 0 阶近似
function kpss(series) {
  const n = series.length;
  if (n < 8) return { stat: 0, stationary: true, critical: { p10: 0.347, p5: 0.463, p1: 0.739 }, note: '样本不足' };
  const m = mean(series);
  const detr = series.map(v => v - m);
  let S = 0;
  for (let t = 0; t < n; t++) { let acc = 0; for (let i = 0; i <= t; i++) acc += detr[i]; S += acc * acc; }
  const s2 = S / (n * n);
  const longRun = variance(series); // 0 阶近似长程方差
  const stat = longRun > 0 ? s2 / longRun : 0;
  const cv = { p10: 0.347, p5: 0.463, p1: 0.739 };
  return { stat, stationary: stat < cv.p5, critical: cv, note: 'KPSS(常数) 近似，长程方差取 0 阶' };
}

// Engle-Granger 协整检验：y ~ x 回归残差做 ADF
function engleGranger(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 12) return { stat: 0, cointegrated: false, pValueApprox: 1, note: '样本不足' };
  const X = x.slice(0, n).map(v => [1, v]);
  const fit = olsGeneral(X, y.slice(0, n));
  const resid = fit.resid;
  const adfRes = adf(resid, 1);
  // EG 临界值（大样本 5% ≈ -3.37）
  const cv = { p5: -3.37, p1: -3.90 };
  return { stat: adfRes.stat, pValueApprox: adfRes.pValueApprox, cointegrated: adfRes.stat < cv.p5, critical: cv, note: 'Engle-Granger 残差 ADF（Johansen 降级实现）' };
}

// 线性趋势（用于趋势贡献系数）
function linearTrend(series) {
  const n = series.length;
  if (n < 4) return { slope: 0, tStat: 0, r2: 0, direction: 'flat' };
  const t = series.map((_, i) => i);
  const fit = olsGeneral(t.map(v => [1, v]), series);
  const direction = fit.beta[1] > 0 ? 'up' : (fit.beta[1] < 0 ? 'down' : 'flat');
  return { slope: fit.beta[1], tStat: fit.tStats[1], r2: fit.r2, direction };
}

// =====================================================================
//  技术指标（首版 JS 实现）
// =====================================================================
function MA(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += (arr[i] || 0);
    if (i >= n) sum -= (arr[i - n] || 0);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function EMA(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] || 0;
    if (i === 0) { prev = v; out[i] = NaN; continue; }
    prev = (isNaN(prev) ? v : (v * k + prev * (1 - k)));
    out[i] = prev;
  }
  return out;
}
function RSI(arr, n = 14) {
  const out = new Array(arr.length).fill(NaN);
  if (arr.length < 2) return out;
  n = Math.min(n, arr.length - 1); // 窗口不得超出数据长度
  let gain = 0, loss = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = (arr[i] || 0) - (arr[i - 1] || 0);
    if (i <= n) {
      if (d >= 0) gain += d; else loss -= d;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}
function BOLL(arr, n = 20, k = 2) {
  const mid = MA(arr, n);
  const upper = new Array(arr.length).fill(NaN);
  const lower = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) { const d = (arr[j] || 0) - mid[i]; s += d * d; }
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { upper, mid, lower };
}
function MACD(arr, fast = 12, slow = 26, signal = 9) {
  const ef = EMA(arr, fast), es = EMA(arr, slow);
  const dif = arr.map((_, i) => (isNaN(ef[i]) || isNaN(es[i]) ? NaN : ef[i] - es[i]));
  // DEA = EMA of DIF
  const valid = dif.map(v => (isNaN(v) ? 0 : v));
  const deaArr = EMA(valid, signal);
  const dea = dif.map((v, i) => (isNaN(v) ? NaN : deaArr[i]));
  const bar = dif.map((v, i) => (isNaN(v) || isNaN(dea[i]) ? NaN : (v - dea[i]) * 2));
  return { dif, dea, bar };
}

// —— 收益率 / 滚动统计（非平稳价格 → 差分取收益率 → 重新检验平稳性）——
function rollingMean(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += (arr[i] || 0);
    if (i >= n) sum -= (arr[i - n] || 0);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function rollingStd(arr, n) {
  const m = rollingMean(arr, n);
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) { const d = (arr[j] || 0) - m[i]; s += d * d; }
    out[i] = Math.sqrt(s / n);
  }
  return out;
}
// 百分比收益率序列（用于均值回归的平稳化路径）
function returnsPct(arr) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = 1; i < arr.length; i++) out[i] = (arr[i - 1] || 0) ? (arr[i] - arr[i - 1]) / arr[i - 1] : NaN;
  return out;
}
function zscore(arr, n) {
  const m = rollingMean(arr, n);
  const s = rollingStd(arr, n);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    if (isNaN(s[i]) || s[i] === 0) out[i] = NaN;
    else out[i] = (arr[i] - m[i]) / s[i];
  }
  return out;
}

// =====================================================================
//  DSL 解析
// =====================================================================
// 支持两种输入：
//   A) JSON 对象：{ strategy_type, name, buy_condition, sell_condition, range, symbols, params, train_ratio, cost_per_side, survivorship }
//   B) 行式文本：
//      STRATEGY_TYPE: single
//      NAME: 双均线金叉
//      BUY: CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))
//      SELL: CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))
//      RANGE: 3y
function parseDSL(raw) {
  if (typeof raw === 'object' && raw !== null) return normalizeDSL(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try { return normalizeDSL(JSON.parse(trimmed)); } catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
    }
    return normalizeDSL(parseTextDSL(trimmed));
  }
  throw new Error('DSL 必须是对象或字符串');
}
function parseTextDSL(text) {
  const obj = {};
  for (const line of text.split(/\n+/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && val) obj[key] = val;
  }
  return obj;
}
function normalizeDSL(o) {
  const buy = o.buy_condition || o.buy || o.buy_signal;
  const sell = o.sell_condition || o.sell || o.sell_signal;
  if (!buy || !sell) throw new Error('DSL 必须包含买/卖条件（buy_condition / sell_condition）');
  return {
    strategyType: (o.strategy_type || o.strategyType || 'single').toLowerCase(),
    name: o.name || '未命名策略',
    buy: String(buy),
    sell: String(sell),
    range: o.range || o.period || '3y',
    symbols: Array.isArray(o.symbols) ? o.symbols : (o.symbols ? String(o.symbols).split(/[,，\s]+/) : []),
    trainRatio: Number(o.train_ratio || o.trainRatio || 0.7),
    costPerSide: o.cost_per_side != null ? Number(o.cost_per_side) : 0.0055,
    survivorship: o.survivorship != null ? Number(o.survivorship) : null
  };
}

// =====================================================================
//  表达式求值器（指标 + 信号函数）
// =====================================================================
const SERIES_NAMES = { CLOSE: 'close', OPEN: 'open', HIGH: 'high', LOW: 'low', VOLUME: 'volume', VOL: 'volume' };

function tokenize(expr) {
  const tokens = [];
  const s = expr;
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i + 1;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < s.length && (isAlpha(s[j]) || isDigit(s[j]))) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if (c === '>' || c === '<' || c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') {
      tokens.push({ t: c === '(' ? 'lp' : c === ')' ? 'rp' : c === ',' ? 'com' : 'op', v: c }); i++; continue;
    }
    throw new Error('无法识别的字符: ' + c);
  }
  return tokens;
}

// 递归下降解析 → AST
function parseExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'OR') { next(); const right = parseAnd(); left = { type: 'or', left, right }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'AND') { next(); const right = parseCmp(); left = { type: 'and', left, right }; }
    return left;
  }
  function parseCmp() {
    let left = parseAdd();
    while (peek() && peek().t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(peek().v)) {
      const op = next().v; const right = parseAdd(); left = { type: 'cmp', op, left, right };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v; const right = parseMul(); left = { type: 'bin', op, left, right };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v; const right = parseUnary(); left = { type: 'bin', op, left, right };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && peek().v === '-') { next(); return { type: 'neg', operand: parseUnary() }; }
    if (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'NOT') { next(); return { type: 'not', operand: parseUnary() }; }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    while (peek() && peek().t === 'lp') {
      next();
      const args = [];
      if (!(peek() && peek().t === 'rp')) {
        args.push(parseOr());
        while (peek() && peek().t === 'com') { next(); args.push(parseOr()); }
      }
      if (!(peek() && peek().t === 'rp')) throw new Error('函数缺少右括号');
      next();
      node = { type: 'call', name: node.value, args };
    }
    return node;
  }
  function parsePrimary() {
    const tk = next();
    if (!tk) throw new Error('表达式意外结束');
    if (tk.t === 'num') return { type: 'num', value: tk.v };
    if (tk.t === 'lp') { const e = parseOr(); if (!(peek() && peek().t === 'rp')) throw new Error('缺少右括号'); next(); return e; }
    if (tk.t === 'id') return { type: 'var', value: tk.v };
    throw new Error('无法解析 token: ' + JSON.stringify(tk));
  }
  const ast = parseOr();
  if (pos < tokens.length) throw new Error('多余 token: ' + JSON.stringify(tokens[pos]));
  return ast;
}

// 类型广播
function isArr(x) { return Array.isArray(x); }
function numOrArrOp(a, b, fn) {
  if (isArr(a) && isArr(b)) return a.map((v, i) => fn(v, b[i]));
  if (isArr(a)) return a.map(v => fn(v, b));
  if (isArr(b)) return b.map(v => fn(a, v));
  return fn(a, b);
}

function evalNode(node, ctx) {
  switch (node.type) {
    case 'num': return node.value;
    case 'var': {
      const name = node.value.toUpperCase();
      if (SERIES_NAMES[name]) return ctx[SERIES_NAMES[name]];
      if (ctx.extra && ctx.extra[name] != null) return ctx.extra[name];
      throw new Error('未知变量: ' + node.value);
    }
    case 'call': return evalCall(node, ctx);
    case 'neg': { const v = evalNode(node.operand, ctx); return isArr(v) ? v.map(x => -x) : -v; }
    case 'not': { const v = evalNode(node.operand, ctx); return v.map(x => !x); }
    case 'bin': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      const fn = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => (y === 0 ? NaN : x / y) }[node.op];
      return numOrArrOp(a, b, fn);
    }
    case 'cmp': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      const fn = { '>': (x, y) => x > y, '<': (x, y) => x < y, '>=': (x, y) => x >= y, '<=': (x, y) => x <= y, '==': (x, y) => x === y, '!=': (x, y) => x !== y }[node.op];
      return numOrArrOp(a, b, (x, y) => !!fn(x, y));
    }
    case 'and': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      return numOrArrOp(a, b, (x, y) => !!x && !!y);
    }
    case 'or': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      return numOrArrOp(a, b, (x, y) => !!x || !!y);
    }
    default: throw new Error('未知节点类型: ' + node.type);
  }
}

function evalCall(node, ctx) {
  const name = node.name.toUpperCase();
  const args = node.args.map(a => evalNode(a, ctx));
  const L = ctx.close.length;
  const toArr = v => (isArr(v) ? v : new Array(L).fill(v));
  switch (name) {
    case 'MA': return MA(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'EMA': return EMA(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'RSI': return RSI(toArr(args[0]), Math.max(2, Math.round(args[1] || 14)));
    case 'BOLL_UPPER': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.upper; }
    case 'BOLL_MID': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.mid; }
    case 'BOLL_LOWER': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.lower; }
    case 'MACD_DIF': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.dif; }
    case 'MACD_DEA': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.dea; }
    case 'MACD_BAR': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.bar; }
    case 'SPREAD': { const a = toArr(args[0]), b = toArr(args[1]); return a.map((v, i) => v - b[i]); }
    case 'RET': return returnsPct(toArr(args[0]));
    case 'MEAN': return rollingMean(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'STD': return rollingStd(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'ZSCORE': return zscore(toArr(args[0]), Math.max(2, Math.round(args[1] || 20)));
    case 'CROSS_UP': {
      const a = toArr(args[0]), b = toArr(args[1]);
      return a.map((v, i) => i > 0 ? (v > b[i] && a[i - 1] <= b[i - 1]) : false);
    }
    case 'CROSS_DOWN': {
      const a = toArr(args[0]), b = toArr(args[1]);
      return a.map((v, i) => i > 0 ? (v < b[i] && a[i - 1] >= b[i - 1]) : false);
    }
    default: throw new Error('未知函数: ' + node.name);
  }
}

function evaluateCondition(expr, ctx) {
  const ast = parseExpr(tokenize(expr));
  const res = evalNode(ast, ctx);
  if (!isArr(res)) throw new Error('条件表达式必须返回序列: ' + expr);
  return res.map(v => !!v);
}

// =====================================================================
//  虚拟盘 T+1 回测引擎
// =====================================================================
// 信号在 day i 触发，次日（i+1）开盘成交；单边成本 costPerSide。
function runBacktest(series, buySig, sellSig, opts) {
  const cost = opts.costPerSide != null ? opts.costPerSide : 0.0055;
  const capPerDay = !!opts.maxOneTradePerDay;
  const N = series.length;
  const dayOf = (b) => String(b.date).slice(0, 10);
  let inPos = false, entryOpen = 0, entryDay = -1, lastTradeDay = null;
  const equity = [1];
  const dailyRet = [];
  const trades = [];
  for (let i = 1; i < N; i++) {
    const sigBuy = buySig[i - 1];
    const sigSell = sellSig[i - 1];
    const day = dayOf(series[i]);
    let ret = 0;
    if (!inPos && sigBuy) {
      if (capPerDay && lastTradeDay === day) { /* 当天已达交易上限，跳过建仓 */ }
      else {
        entryOpen = series[i].open * (1 + cost);
        inPos = true; entryDay = i; lastTradeDay = day;
        ret = (series[i].close - entryOpen) / entryOpen;
      }
    } else if (inPos && sigSell) {
      if (capPerDay && lastTradeDay === day) { /* 当天已达交易上限，跳过平仓 */ }
      else {
        const exitOpen = series[i].open * (1 - cost);
        ret = (exitOpen - entryOpen) / entryOpen;
        trades.push({ entry: series[entryDay].date, exit: series[i].date, pnl: ret, side: 'long' });
        inPos = false; entryOpen = 0; lastTradeDay = day;
      }
    } else if (inPos) {
      ret = series[i].close / series[i - 1].close - 1;
    } else {
      ret = 0;
    }
    const prevEq = equity[equity.length - 1];
    equity.push(prevEq * (1 + ret));
    dailyRet.push(ret);
  }
  if (inPos) {
    const last = N - 1;
    const day = dayOf(series[last]);
    // 样本末笔强制平仓仍遵守「每天≤1笔」：若末日已交易则不重复计入交易笔数（权益已含当日浮动盈亏）
    if (!(capPerDay && lastTradeDay === day)) {
      const pnl = (series[last].close - entryOpen) / entryOpen;
      trades.push({ entry: series[entryDay].date, exit: series[last].date, pnl, side: 'long', openAtEnd: true });
    }
  }
  // 指标
  const wins = trades.filter(t => t.pnl > 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalReturn = equity[equity.length - 1] - 1;
  const buyHold = N > 1 ? series[N - 1].close / series[0].close - 1 : 0;
  const avgPnl = totalTrades > 0 ? mean(trades.map(t => t.pnl)) : 0;
  const gains = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const losses = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = losses > 0 ? gains / losses : (gains > 0 ? Infinity : 0);
  // 最大回撤
  let peak = equity[0], maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak); }
  // 年化（按 252 交易日）
  const tradingDays = dailyRet.length;
  const mu = mean(dailyRet), sd = std(dailyRet);
  const annReturn = Math.pow(equity[equity.length - 1], 252 / Math.max(tradingDays, 1)) - 1;
  const sharpe = sd > 0 ? (mu / sd) * Math.sqrt(252) : 0;
  return {
    totalTrades, wins, winRate, totalReturn, buyHold, avgPnl, profitFactor,
    maxDrawdown: maxDD, annReturn, sharpe,
    trades: trades.slice(-30) // 仅保留最近 30 笔明细，避免体积过大
  };
}

// =====================================================================
//  风险分析辅助函数（平稳性闸门 + 四类回测偏差校验扩展）
// =====================================================================

// 策略分类：均值回归 / 趋势跟踪 / 收益率均值回归（平稳化路径）
function classifyStrategy(buyStr, sellStr) {
  const b = (buyStr || '').toUpperCase(), s = (sellStr || '').toUpperCase();
  const both = b + ' ' + s;
  if (both.includes('ZSCORE(') && both.includes('RET(')) return 'return-reversion';
  if (b.includes('BOLL_LOWER') || s.includes('BOLL_UPPER')) {
    return b.includes('BOLL_LOWER') ? 'reversion' : 'trend';
  }
  if ((b.includes('RSI') && b.includes('<')) || (s.includes('RSI') && s.includes('>'))) return 'reversion';
  if (both.includes('MACD_DIF') || both.includes('MACD_DEA')) return 'trend';
  if (both.includes('CROSS_UP(MA(') || both.includes('CROSS_DOWN(MA(')) return 'trend';
  return 'mixed';
}

// 前视偏差扫描（偏差校验①）：检测 DSL 是否引用未来数据
function lookaheadScan(buyStr, sellStr) {
  const txt = (buyStr || '') + ' ' + (sellStr || '');
  const forbidden = [/\bNEXT\s*\(/i, /\bLEAD\s*\(/i, /\[\s*\+\s*\d+\s*\]/, /\+1\s*\]/];
  for (const re of forbidden) if (re.test(txt)) return { detected: true, reason: 'DSL 含未来函数（' + re + '）' };
  return { detected: false, reason: '信号仅引用当前/历史 bar，成交于次日开盘，结构上无前视偏差' };
}

// 平稳性闸门系数（铁律：非平稳价格上的均值回归 = 伪回归陷阱）
function stationarityFactorFor(cls, adfPriceStat, adfReturnStat) {
  if (cls === 'reversion' && adfPriceStat === false) return 0.5;   // 陷阱，折算
  if (cls === 'return-reversion' && adfReturnStat === true) return 1.0; // 方法论成立
  if (cls === 'trend' && adfPriceStat === false) return 1.0;       // 趋势即非平稳性的一种表现
  return 1.0;
}

// 滚动前向（walk-forward）：把样本切成 folds 段，逐段样本外回测，检验一致性（过拟合校验扩展）
function walkForward(series, buySig, sellSig, opts, folds) {
  folds = folds || 3;
  const N = series.length;
  const size = Math.floor(N / folds);
  const results = [];
  for (let k = 0; k < folds; k++) {
    const start = k * size;
    const end = (k === folds - 1) ? N : (k + 1) * size;
    const sub = series.slice(start, end);
    if (sub.length < 30) { results.push({ start, end, winRate: 0, trades: 0, skipped: true }); continue; }
    const r = runBacktest(sub, buySig.slice(start, end), sellSig.slice(start, end), opts);
    results.push({ start, end, winRate: +r.winRate.toFixed(3), trades: r.totalTrades, totalReturn: +r.totalReturn.toFixed(4) });
  }
  const valid = results.filter(r => !r.skipped && r.trades > 0);
  const meanWR = valid.length ? mean(valid.map(r => r.winRate)) : 0;
  const minWR = valid.length ? Math.min.apply(null, valid.map(r => r.winRate)) : 0;
  const consistency = meanWR > 0 ? Math.max(0, minWR / meanWR) : 0;
  return { folds: results, meanWinRate: +meanWR.toFixed(3), minWinRate: +minWR.toFixed(3), consistency: +consistency.toFixed(3), validFolds: valid.length };
}

// 结构性突变（结构性断点）：前后半段胜率差异
function structuralBreak(series, buySig, sellSig, opts) {
  const N = series.length;
  const mid = Math.floor(N / 2);
  const first = runBacktest(series.slice(0, mid), buySig.slice(0, mid), sellSig.slice(0, mid), opts);
  const second = runBacktest(series.slice(mid), buySig.slice(mid), sellSig.slice(mid), opts);
  const delta = second.winRate - first.winRate;
  return {
    firstHalfWinRate: +first.winRate.toFixed(3),
    secondHalfWinRate: +second.winRate.toFixed(3),
    delta: +delta.toFixed(3),
    significant: Math.abs(delta) >= 0.15,
    firstTrades: first.totalTrades,
    secondTrades: second.totalTrades
  };
}

// 季节性/周期性：收益率序列 ACF 在月(20)/季(60)滞后
function seasonalityScan(retSeries) {
  const lag20 = acf(retSeries, 20);
  const lag60 = acf(retSeries, 60);
  return { lag20: +lag20.toFixed(3), lag60: +lag60.toFixed(3), hasSeasonality: Math.abs(lag20) > 0.12 || Math.abs(lag60) > 0.12 };
}

// =====================================================================
//  五大胜率修正（A 项：接入平稳性闸门）
// =====================================================================
function applyCorrections(raw, stats, ctx, risk) {
  const steps = [];
  let winRate = raw.winRate;
  const trainWR = ctx.trainWinRate, testWR = ctx.testWinRate;
  risk = risk || {};

  // 0) 平稳性闸门（铁律：非平稳价格上的均值回归 = 伪回归陷阱）
  const stationarityFactor = risk.stationarityFactor != null ? risk.stationarityFactor : 1;
  let stNote;
  if (risk.strategyClass === 'reversion' && risk.adfPriceStationary === false) {
    stNote = '均值回归作用于非平稳价格序列（ADF 显示单位根）→ 伪回归陷阱，胜率 ×0.5 折算；建议改用平稳收益率 z-score 回归（RET/ZSCORE 函数）';
  } else if (risk.strategyClass === 'return-reversion' && risk.adfReturnStationary === true) {
    stNote = '回归作用于平稳收益率序列（ADF 通过）→ 方法论成立，无折算';
  } else if (risk.strategyClass === 'trend' && risk.adfPriceStationary === false) {
    stNote = '趋势跟踪作用于含趋势的非平稳序列，方法论成立（趋势即非平稳性的一种表现）';
  } else {
    stNote = '平稳性闸门未触发额外折算';
  }
  steps.push({ name: '平稳性闸门', factor: +stationarityFactor.toFixed(3), note: stNote });
  let wr = winRate * stationarityFactor;

  // 1) 前视偏差（偏差校验①）
  const lookahead = ctx.lookaheadDetected ? 1 : 0;
  const f1 = lookahead ? 0 : 1;
  steps.push({ name: '前视偏差', factor: f1, note: lookahead ? '检测到前视信号，胜率归零' : '未检出（信号次日开盘成交，结构上无前视）' });
  wr *= f1;

  // 2) 交易成本（0.55%/笔，已在回测中计提；这里量化成本拖累并做胜率折扣）
  const costDrag = raw.totalTrades * 2 * 0.0055; // 往返粗略拖累
  const f2 = Math.max(0.5, 1 - Math.min(0.3, costDrag * 0.5));
  steps.push({ name: '交易成本', factor: +f2.toFixed(3), note: `单边成本 ${(ctx.costPerSide * 100).toFixed(2)}%，估算往返拖累 ≈${(costDrag * 100).toFixed(2)}%` });
  wr *= f2;

  // 3) 趋势贡献（策略收益多大程度由市场趋势贡献）
  const trend = ctx.trend || { r2: 0, direction: 'flat' };
  let f3 = 1;
  if (trend.r2 > 0.7) f3 = 0.3; else if (trend.r2 > 0.3) f3 = 0.7; else f3 = 1;
  steps.push({ name: '趋势贡献', factor: f3, note: `价格线性趋势 R²=${trend.r2.toFixed(2)}（${trend.direction}）→ 系数 ${f3}` });
  wr *= f3;

  // 4) 过拟合（测试集 vs 训练集，偏差校验③）
  let f4 = 1;
  if (trainWR > 0 && testWR >= 0) {
    f4 = testWR / Math.max(trainWR, 1e-9);
    if (f4 > 1) f4 = 1; // 测试更好不惩罚
  }
  steps.push({ name: '过拟合', factor: +f4.toFixed(3), note: `训练胜率 ${(trainWR * 100).toFixed(1)}% / 测试胜率 ${(testWR * 100).toFixed(1)}% → 系数 ${f4.toFixed(2)}` });
  wr *= f4;

  // 5) 幸存者偏差（偏差校验④）：默认 0.9；可由资料库 ST/退市扫描下调
  const f5 = ctx.survivorship != null ? ctx.survivorship : 0.9;
  steps.push({ name: '幸存者偏差', factor: f5, note: ctx.survivorship != null ? (risk.survivorshipBasis || '用户/资料库指定倍数') : '单只 A 股默认 0.9（未在全市场优选中挑选）' });
  wr *= f5;

  wr = Math.max(0, Math.min(1, wr));
  // 修正后总收益：以趋势/过拟合/幸存者三项缩放（成本与前视已在胜率体现）
  const adjReturn = raw.totalReturn * f3 * f4 * f5;

  // 结构性突变（E 项）计入警示
  const sb = risk.structuralBreak;
  const sbFlag = sb && sb.significant;

  let verdict = 'REJECT';
  let advice = '策略未通过校验，不建议实盘';
  if (lookahead) { verdict = 'REJECT'; advice = '检出前视偏差，策略逻辑存在未来函数，直接否决'; }
  else if (stationarityFactor < 0.9) { verdict = 'WARNING'; advice = '策略基于非平稳价格的均值回归（伪回归陷阱），修正后胜率不足以保证实盘；建议改用收益率 z-score 回归或趋势跟踪类策略。'; }
  else if (wr >= 0.55 && f4 >= 0.85 && !sbFlag) { verdict = 'PASS'; advice = '校验通过（平稳性/前视/成本/过拟合/幸存者均达标），可小仓位实盘验证，并持续跟踪样本外表现'; }
  else if (wr >= 0.45) { verdict = 'WARNING'; advice = (sbFlag ? '前后半段胜率差异显著（存在结构性突变），' : '') + '边际通过，建议缩小仓位并加强样本外跟踪（警惕过拟合/趋势依赖/结构突变）'; }
  else { verdict = 'REJECT'; advice = '修正后胜率不足，不建议实盘'; }

  return { adjustedWinRate: +wr.toFixed(4), adjustedReturn: +adjReturn.toFixed(4), steps, verdict, advice, stationarityFactor, structuralBreakFlag: !!sbFlag };
}

// =====================================================================
//  编排器：validateStrategy
// =====================================================================
async function validateStrategy(input) {
  const symbol = input.symbol || (input.symbols && input.symbols[0]);
  if (!symbol) throw new Error('缺少标的 symbol');
  // 解析 DSL；若用户写的是「大白话中文」，用确定性翻译器转成 DSL（纯代码、无 LLM）
  let dsl, derivedFrom = 'dsl', derivedNotes = [];
  try {
    dsl = parseDSL(input.dsl);
  } catch (e) {
    const nl = strategyNL.translate(input.dsl == null ? '' : String(input.dsl));
    if (nl && nl.ok) {
      dsl = normalizeDSL(nl.dsl);
      derivedFrom = 'natural_language';
      derivedNotes = nl.notes || [];
    } else if (nl && nl.reason === 'unsupported') {
      throw new Error('这段中文策略用到了回测引擎暂不支持的玩法：' + nl.unsupported.join('、')
        + '。引擎目前只支持「全进全出」的二元买卖与常见技术指标（均线 / MACD / RSI / 布林带 / 收益率 z-score）。可改用上方「🤖 生成并校验策略」，或点「模板」按钮套用现成策略。');
    } else {
      throw new Error((e && e.message || 'DSL 解析失败')
        + '。若想直接用中文描述，请写清买卖方向 + 常见技术指标，例如：「5日均线上穿20日均线买入，5日均线下穿20日均线卖出」。');
    }
  }
  const range = dsl.range;

  // 1) 取数
  const hist = await getHistory(symbol, range);
  if (!Array.isArray(hist) || hist.length < 30) {
    throw new Error(`标的 ${symbol} 历史数据不足（${hist ? hist.length : 0} 根），无法回测`);
  }
  const series = hist.map(d => ({
    date: d.date,
    open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
  }));

  // 数据契约占位（前复权；ST/停牌/退市本版未接入，标注 unverified）
  const contract = {
    adjust_type: 'qfq',
    adj_factor: 1,
    is_suspended: 'unverified',
    is_st: 'unverified',
    is_delisted: 'unverified',
    note: '本版前复权已归一；ST/停牌/退市状态需接入 F10 数据源后补全'
  };

  // 2) 指标上下文
  const close = series.map(s => s.close);
  const ctx = { close, open: series.map(s => s.open), high: series.map(s => s.high), low: series.map(s => s.low), volume: series.map(s => s.volume) };

  // 3) 信号
  const buySig = evaluateCondition(dsl.buy, ctx);
  const sellSig = evaluateCondition(dsl.sell, ctx);

  // 4) 训练/测试拆分回测
  const N = series.length;
  const splitIdx = Math.max(2, Math.floor(N * dsl.trainRatio));
  const trainSeries = series.slice(0, splitIdx);
  const testSeries = series.slice(splitIdx);
  const full = runBacktest(series, buySig, sellSig, { costPerSide: dsl.costPerSide });
  const train = runBacktest(trainSeries, buySig.slice(0, splitIdx), sellSig.slice(0, splitIdx), { costPerSide: dsl.costPerSide });
  const test = runBacktest(testSeries, buySig.slice(splitIdx), sellSig.slice(splitIdx), { costPerSide: dsl.costPerSide });

  // 5) 统计检验
  const retSeries = returnsPct(close).slice(1);
  const adfClose = adf(close, 1);
  const adfRet = adf(retSeries, 1);
  const kp = kpss(close);
  const acf1 = acf(retSeries, 1);
  const acf5 = acf(retSeries, 5);
  const acf20 = acf(retSeries, 20);
  const acf60 = acf(retSeries, 60);
  const pacfArr = pacf(retSeries, 5);
  let cointegration = null;
  if (dsl.strategyType === 'pair' && dsl.symbols.length >= 2) {
    const histB = await getHistory(dsl.symbols[1], range);
    const closeB = histB.map(d => +d.close);
    const mn = Math.min(close.length, closeB.length);
    cointegration = engleGranger(close.slice(0, mn), closeB.slice(0, mn));
  }
  const trend = linearTrend(close);

  // 策略分类 / 前视扫描 / 平稳性闸门（铁律）+ 结构突变 / 季节性
  const strategyClass = classifyStrategy(dsl.buy, dsl.sell);
  const la = lookaheadScan(dsl.buy, dsl.sell);
  const stationarityFactor = stationarityFactorFor(strategyClass, adfClose.stationary, adfRet.stationary);
  const sb = structuralBreak(series, buySig, sellSig, { costPerSide: dsl.costPerSide });
  const season = seasonalityScan(retSeries);

  // 6) 五大修正（含 A 项平稳性闸门）
  const corrections = applyCorrections(full, null, {
    trainWinRate: train.winRate,
    testWinRate: test.winRate,
    trend,
    costPerSide: dsl.costPerSide,
    survivorship: dsl.survivorship,
    lookaheadDetected: la.detected
  }, {
    strategyClass,
    adfPriceStationary: adfClose.stationary,
    adfReturnStationary: adfRet.stationary,
    stationarityFactor,
    structuralBreak: sb,
    seasonality: season
  });

  const riskCheck = {
    strategy_class: strategyClass,
    lookahead: la,
    adf_price: adfClose,
    adf_return: adfRet,
    kpss_price: kp,
    acf: { lag1: +acf1.toFixed(3), lag5: +acf5.toFixed(3), lag20: +acf20.toFixed(3), lag60: +acf60.toFixed(3) },
    pacf_lag1_5: pacfArr.slice(1, 6).map(v => +v.toFixed(3)),
    cointegration,
    structural_break: sb,
    seasonality: season,
    notes: [
      'ADF 原假设=存在单位根；stat < p5 临界值 拒绝原假设→平稳',
      'KPSS 原假设=平稳；stat > p5 临界值 拒绝原假设→非平稳',
      '协整（pair）采用 Engle-Granger 残差 ADF（Johansen 降级实现，后续可升级）',
      '平稳性闸门：非平稳价格上的均值回归策略会被 ×0.5 折算（伪回归陷阱）'
    ]
  };

  return {
    base_info: {
      symbol,
      name: input.name || dsl.name,
      strategy_type: dsl.strategyType,
      strategy_name: dsl.name,
      range,
      data_points: N,
      train_ratio: dsl.trainRatio,
      cost_per_side: dsl.costPerSide,
      contract,
      derived_from: derivedFrom,
      derived_buy: derivedFrom === 'natural_language' ? dsl.buy : null,
      derived_sell: derivedFrom === 'natural_language' ? dsl.sell : null,
      derived_notes: derivedNotes
    },
    raw_backtest_result: {
      full: full,
      train: { totalTrades: train.totalTrades, winRate: train.winRate, totalReturn: train.totalReturn, sharpe: train.sharpe, maxDrawdown: train.maxDrawdown },
      test: { totalTrades: test.totalTrades, winRate: test.winRate, totalReturn: test.totalReturn, sharpe: test.sharpe, maxDrawdown: test.maxDrawdown }
    },
    risk_check_result: riskCheck,
    adjusted_result: {
      adjusted_win_rate: corrections.adjustedWinRate,
      adjusted_return: corrections.adjustedReturn,
      corrections: corrections.steps
    },
    operation_suggestion: {
      verdict: corrections.verdict,
      advice: corrections.advice,
      warnings: (() => {
        const w = [];
        if (la.detected) w.push('⚠ 前视偏差：' + la.reason);
        if (strategyClass === 'reversion' && !adfClose.stationary) w.push('⚠ 伪回归陷阱：价格序列非平稳，均值回归策略不可靠，建议改用 RET/ZSCORE 收益率路径');
        if (sb.significant) w.push('⚠ 结构性突变：前后半段胜率差 ' + (sb.delta * 100).toFixed(0) + 'pp（' + (sb.firstHalfWinRate * 100).toFixed(0) + '% → ' + (sb.secondHalfWinRate * 100).toFixed(0) + '%）');
        if (season.hasSeasonality) w.push('ℹ 检出季节性/周期性（月滞后面 ACF=' + season.lag20 + '，季=' + season.lag60 + '）');
        return w;
      })()
    },
    diagnostics: {
      buy_signal_days: buySig.filter(Boolean).length,
      sell_signal_days: sellSig.filter(Boolean).length,
      note: '首版骨架：统计临界值为标准近似；pair 协整为 Engle-Granger 降级；ST/停牌状态未接入'
    }
  };
}

module.exports = {
  validateStrategy,
  parseDSL,
  evaluateCondition,
  runBacktest,
  applyCorrections,
  // 风险分析辅助（A–E）
  classifyStrategy,
  lookaheadScan,
  stationarityFactorFor,
  walkForward,
  structuralBreak,
  seasonalityScan,
  returnsPct,
  rollingMean,
  rollingStd,
  zscore,
  // 暴露统计/指标便于单测
  adf, kpss, pacf, acf, engleGranger, linearTrend, MA, EMA, RSI, BOLL, MACD
};
