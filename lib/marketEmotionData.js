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
const { fetchReport } = require('./emDataCenter');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'market_emotion.py');

const _cache = { ts: 0, date: '', data: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * [20261015d] 主力资金备链：东财「数据中心」行业资金流报表求和（datacenter-web，本机稳定可达）。
 * 为什么可行：RPT_INDUSTRY_FUNDFLOW 按日给出全部申万行业（128 个板块/日）的 SUPERDEAL_NET(超大单)
 * 与 BIGDEAL_NET(大单)，行业是对沪深两市的完整划分 → 全行业求和 ≈ 沪深两市主力净额，与
 * push2 fflow daykline（主链）完全同一东财口径、同一单位（元）。
 * 完整性守卫：当日板块行数必须 ≥ 前一交易日行数，否则视为「当日行尚未发布完整」，不产出当日值
 *（宁可缺失，绝不拿半截数据冒充当日）。
 * @returns {Promise<object>} 与 scripts/market_emotion.py fetch_main_fund 同形状
 */
async function fetchMainFundViaDataCenter() {
  const rows = await fetchReport('RPT_INDUSTRY_FUNDFLOW', { sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 500 });
  if (!rows.length) throw new Error('行业资金流报表为空');
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { n: 0, main: 0, big: 0, superBig: 0 });
    const o = byDate.get(d);
    o.n++;
    const sv = Number(r.SUPERDEAL_NET), bv = Number(r.BIGDEAL_NET);
    if (isFinite(sv)) { o.superBig += sv; o.main += sv; }
    if (isFinite(bv)) { o.big += bv; o.main += bv; }
  }
  const dates = [...byDate.keys()];
  if (!dates.length) throw new Error('行业资金流无可解析日期行');
  const latest = dates[0];               // 已按 TRADE_DATE 倒序，第一组即最新交易日
  const prev = dates[1] || null;
  const latestAgg = byDate.get(latest);
  const prevN = prev ? byDate.get(prev).n : null;
  // 完整性守卫：当日行数 < 前日行数 → 当日尚未发布完整 → 当日值不给（mainNetToday=null），历史照给
  const complete = prevN == null || latestAgg.n >= prevN;
  const toYi = (v) => Math.round(v / 1e8 * 100) / 100;
  return {
    date: latest,
    mainNetToday: complete ? toYi(latestAgg.main) : null,
    bigNet: complete ? toYi(latestAgg.big) : null,
    superBigNet: complete ? toYi(latestAgg.superBig) : null,
    mainNetPct: null,                    // 报表无全市场净占比，宁缺毋假
    history: dates.slice(0, 6).map(d => ({ date: d, mainNet: toYi(byDate.get(d).main) })),
    source: `东方财富·数据中心行业资金流求和（${latestAgg.n} 板块，超大单+大单=主力，与 push2 主链同口径${complete ? '' : `；当日行尚未发布完整（${latestAgg.n}/${prevN}），当日值暂缺`}）`,
  };
}

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
  if (!mf || mf.mainNetToday == null) push('mainFund', '市场主力净额缺失（东财 push2 实时通道与数据中心收盘口径备链均未取到当日数据；数据源恢复后每日快照自动回补，因子权重已按规则归零分摊）');

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
  // [20261015d] 主力资金备链（必须在 selfCheck 之前注入，保证 issues 反映注入后的真实状态）：
  // push2delay 实时主链失败（本机常年被 TLS 重置）时，走东财数据中心行业资金流求和
  //（同口径、本机稳定可达）。仅当备链给出的交易日就是今天才注入当日值；
  // 盘中备链尚未更新至今日时保持缺失（自检文案会如实说明），收盘后自动回补。
  let mainFundFallbackNote = null;
  if (!raw.mainFund || raw.mainFund.mainNetToday == null) {
    try {
      const fb = await fetchMainFundViaDataCenter();
      if (fb.mainNetToday != null && fb.date === today) {
        raw.mainFund = fb; // 同形状注入，source 已如实标注求和口径
      } else {
        console.warn(`[MarketOverview] 主力资金备链：数据中心最新为 ${fb.date}（今日 ${today}），暂不注入当日值`);
        mainFundFallbackNote = `主力资金实时主链不可达，收盘口径备链最新为 ${fb.date}（尚未更新至今日），收盘后自动回补`;
      }
    } catch (e) {
      console.warn('[MarketOverview] 主力资金备链（数据中心求和）失败:', e.message);
    }
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.slice() : [];
  const extra = selfCheck(raw, today);
  if (mainFundFallbackNote) extra.push({ block: 'mainFund', msg: mainFundFallbackNote });
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

module.exports = { getMarketEmotionData, fetchMainFundViaDataCenter, SCRIPT };
