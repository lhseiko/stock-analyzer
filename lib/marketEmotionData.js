/**
 * 大盘量能情绪模型 · 数据采集层（lib/marketEmotionData.js · 20260917d）
 * --------------------------------------------------------------
 * 职责单一：把 scripts/market_emotion.py 的市场级原始数据取回来并做「数据源异常自检」，
 * 不做任何判断/打分（打分在 lib/marketEmotionModel.js，确定性计算）。
 *
 * 数据块（单一权威源）：
 *   index    上证指数最近 ~260 交易日量价（腾讯·fqkline，vol=成交量·手）
 *   breadth  上涨/下跌/平盘/涨停/跌停家数（乐咕乐股·市场活跃度）
 *   margin   沪深融资余额（亿元）+ 1日/5日变化（沪深交易所）
 *   mainFund 市场主力净额（亿元，东财 push2delay，主力=超大单+大单）
 *   capital  全市场成交额 / 换手率均值 / 成交额前10%占比（同花顺个股资金流聚合）
 *   fx       USD/CNH、USD/CNY 及涨跌幅（新浪财经）
 *   bond     中国 10 年期国债收益率及 5 日变化（bp）
 *
 * 自检规则（spec §八.4）：任一块缺失 / 数值为 0 / 明显过期 → 记入 issues，
 * 由模型侧把该因子权重临时归零并按比例分摊，绝不用错误数据硬算。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'market_emotion.py');

const _cache = { ts: 0, date: '', data: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tradingDaysBetween(a, b) {
  // 粗略估算两个日期之间相隔的自然日（用于数据新鲜度判断）
  const d1 = Date.parse(a + 'T00:00:00');
  const d2 = Date.parse(b + 'T00:00:00');
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

async function runScript() {
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('market_emotion.py 不存在: ' + SCRIPT);
  const out = await execFileAsync(py, [SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

/** 数据源异常自检 → issues 列表 */
function selfCheck(data, today) {
  const issues = [];
  const push = (block, msg) => issues.push({ block, msg });

  // index：需 >= 25 根用于动量/均线，>= 120 用于 1 年分位
  const bars = data.index && Array.isArray(data.index.bars) ? data.index.bars : [];
  if (!bars.length) push('index', '上证指数日线缺失');
  else {
    if (bars.length < 25) push('index', `上证指数日线仅 ${bars.length} 根（<25，动量/均线不可用）`);
    const lastBar = bars[bars.length - 1];
    const lag = tradingDaysBetween(lastBar.date, today);
    if (lag != null && lag > 4) push('index', `上证指数日线最新为 ${lastBar.date}，滞后 ${lag} 天`);
    if (!(lastBar.vol > 0)) push('index', '上证指数最新成交量为 0');
  }

  const b = data.breadth;
  if (!b) push('breadth', '涨跌家数缺失');
  else {
    if (!(b.up + b.down > 0)) push('breadth', '涨跌家数全为 0');
    const lag = tradingDaysBetween(b.date, today);
    if (lag != null && lag > 4) push('breadth', `涨跌家数统计日为 ${b.date}，滞后 ${lag} 天`);
  }

  const m = data.margin;
  if (!m) push('margin', '融资余额缺失');
  else if (!(m.latest > 0)) push('margin', '融资余额为 0');

  const mf = data.mainFund;
  if (!mf || mf.mainNetToday == null) push('mainFund', '市场主力净额缺失');

  const cap = data.capital;
  if (!cap) push('capital', '市场成交额缺失');
  else if (!(cap.totalAmount > 0)) push('capital', '全市场成交额为 0');

  const fx = data.fx;
  if (!fx || !(fx.usdcnh > 0 || fx.usdcny > 0)) push('fx', '人民币汇率缺失');

  const bond = data.bond;
  if (!bond || !(bond.cn10y > 0)) push('bond', '国债收益率缺失');

  return issues;
}

/**
 * 取市场级原始数据（带缓存 + 自检）。
 * @param {{refresh?:boolean}} opts
 * @returns {Promise<object>} { ok, date, index, breadth, margin, mainFund, capital, fx, bond, issues, warnings, fetchedAt, fromCache }
 */
async function getMarketEmotionData(opts = {}) {
  const today = localDate();
  const now = Date.now();
  if (!opts.refresh && _cache.data && now - _cache.ts < CACHE_TTL) {
    return { ..._cache.data, fromCache: true };
  }
  let raw;
  try {
    raw = await runScript();
  } catch (e) {
    const errData = { ok: false, date: today, issues: [{ block: 'all', msg: '采集脚本失败: ' + (e && e.message) }], warnings: [], fetchedAt: new Date().toISOString() };
    _cache.ts = now; _cache.date = today; _cache.data = errData;
    return errData;
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.slice() : [];
  const extra = selfCheck(raw, today);
  const data = {
    ok: raw.ok !== false && extra.filter(i => i.block === 'index' || i.block === 'breadth').length === 0,
    date: today,
    index: raw.index || null,
    breadth: raw.breadth || null,
    margin: raw.margin || null,
    mainFund: raw.mainFund || null,
    capital: raw.capital || null,
    fx: raw.fx || null,
    bond: raw.bond || null,
    issues: issues.concat(extra),
    warnings: raw.warnings || [],
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  _cache.ts = now; _cache.date = today; _cache.data = data;
  return data;
}

module.exports = { getMarketEmotionData, SCRIPT };
