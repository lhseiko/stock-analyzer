/**
 * 大盘量能情绪模型 · 数据采集层（lib/marketEmotionData.js · 20260917d）
 * --------------------------------------------------------------
 * 职责单一：把 scripts/market_emotion.py 的市场级原始数据取回来并做「数据源异常自检」，
 * 不做任何判断/打分（打分在 lib/marketEmotionModel.js，确定性计算）。
 *
 * 数据块（单一权威源）：
 *   index    上证指数最近 320 交易日量价（首页量能根 lib/marketTechnical.fetchIndexDailyBars
 *            单一通道·腾讯 fqkline 直采，vol=成交量·手；20261018 起不再走 market_emotion.py
 *            的 akshare 通道——实测两条通道重叠 260 根 date/close/vol 零差异，收敛后窗口统一 320）
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
// 20261018：index（上证日线）改由首页量能根单一通道采集（lib/marketTechnical 与大盘技术分析
// 同源同窗口），market_emotion.py 不再返回 index 块
const { fetchIndexDailyBars } = require('./marketTechnical');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'market_emotion.py');

const _cache = { ts: 0, date: '', data: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * [20261015d] 主力资金 S1（主稳定源）：东财「数据中心」行业资金流报表求和（datacenter-web，本机稳定可达）。
 * 为什么可行：RPT_INDUSTRY_FUNDFLOW 按日给出全部申万行业（128 个板块/日）的 SUPERDEAL_NET(超大单)
 * 与 BIGDEAL_NET(大单)，行业是对沪深两市的完整划分 → 全行业求和 ≈ 沪深两市主力净额，与
 * push2 fflow daykline（主链）完全同一东财口径、同一单位（元）。
 * 完整性守卫：当日板块行数必须 ≥ 前一交易日行数，否则视为「当日行尚未发布完整」，不产出当日值
 *（宁可缺失，绝不拿半截数据冒充当日）。
 * 时效：本报表只含「已收盘交易日」，盘中/盘前最新行通常为 T-1（收盘口径），与 push2delay 实时主链不同。
 * 20261024a：此前 getMarketEmotionData 用 `fb.date === today` 硬门槛拒收 T-1 → 因子永久「缺失」。
 * 现改为接受「最新已收盘交易日」并如实标注口径日（见 _enrichMainFundSource），与融资余额 T+1 同范式。
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

/**
 * [20261024a] 主力资金 S2（兜底交叉校验源）：东财「数据中心」板块资金流报表求和（datacenter-web，稳定可达）。
 * 与 S1 同源（东财·数据中心族），但覆盖维度不同——RPT_FUNDFLOW_BOARD 是「概念板块」(BK 代码)，
 * 板块间有股票重叠 → 求和会重复计入，量级可能偏高，故仅作 S1 不可达时的兜底，source 如实标注。
 * 单位：报表 AMOUNT/SUPERDEAL_AMOUNT/BIGDEAL_AMOUNT 均为「万元」，需 ×1e4 转元、÷1e8 转亿。
 * 主力 = 超大单净额(SUPERDEAL_AMOUNT) + 大单净额(BIGDEAL_AMOUNT)，与 S1 口径一致。
 * 完整性守卫同 S1：最新交易日板块行数需 >= 前一交易日，否则当日值不给（mainNetToday=null）。
 * @returns {Promise<object>} 与 fetchMainFundViaDataCenter 同形状
 */
async function fetchMainFundViaBoardFlow() {
  const rows = await fetchReport('RPT_FUNDFLOW_BOARD', { sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 500 });
  if (!rows.length) throw new Error('板块资金流报表为空');
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { n: 0, superWan: 0, bigWan: 0, mainWan: 0 });
    const o = byDate.get(d);
    o.n++;
    const sv = Number(r.SUPERDEAL_AMOUNT), bv = Number(r.BIGDEAL_AMOUNT);
    if (isFinite(sv)) { o.superWan += sv; o.mainWan += sv; }
    if (isFinite(bv)) { o.bigWan += bv; o.mainWan += bv; }
  }
  const dates = [...byDate.keys()];
  if (!dates.length) throw new Error('板块资金流无可解析日期行');
  const latest = dates[0];               // 已按 TRADE_DATE 倒序
  const prev = dates[1] || null;
  const latestAgg = byDate.get(latest);
  const prevN = prev ? byDate.get(prev).n : null;
  const complete = prevN == null || latestAgg.n >= prevN;
  const toYi = (v) => Math.round(v * 1e4 / 1e8 * 100) / 100; // 万元 → 亿元
  return {
    date: latest,
    mainNetToday: complete ? toYi(latestAgg.mainWan) : null,
    bigNet: complete ? toYi(latestAgg.bigWan) : null,
    superBigNet: complete ? toYi(latestAgg.superWan) : null,
    mainNetPct: null,
    history: dates.slice(0, 6).map(d => ({ date: d, mainNet: toYi(byDate.get(d).mainWan) })),
    source: `东方财富·数据中心板块资金流汇总（${latestAgg.n} 概念板块，可能含跨板块重复计入，仅作兜底）`,
  };
}

/**
 * [20261024a] 主力资金注入助手：把稳定源链路（fetchMarketMainFund）的结果注入 raw.mainFund。
 * 抽成独立函数便于离线测试（不依赖 runScript/python）。行为与原内联逻辑完全一致：
 *   - raw.mainFund 已有有效当日值 → 不动；
 *   - 否则调 fetchMarketMainFund()（S1 行业资金流求和优先 + S2 板块资金流汇总兜底）；
 *   - 取到则注入 raw.mainFund（同形状，source 已标注口径日/T-lag）；取不到返回说明文案。
 * @returns {string|null} 取数失败时的说明文案（成功为 null）
 */
async function resolveMainFund(raw, today) {
  if (!raw.mainFund || raw.mainFund.mainNetToday == null) {
    try {
      const fb = await fetchMarketMainFund();
      if (fb && fb.mainNetToday != null) {
        raw.mainFund = fb; // 同形状注入；source 已如实标注口径日与「T-lag 收盘口径」
      } else {
        return '主力资金：东财数据中心行业/板块资金流报表均未取到有效数据（数据源恢复后每日快照自动回补）';
      }
    } catch (e) {
      console.warn('[MarketOverview] 主力资金稳定源（数据中心）失败:', e && e.message ? e.message : e);
      return '主力资金：东财数据中心行业/板块资金流报表均不可达';
    }
  }
  return null;
}

/**
 * [20261024a] 主力资金稳定源链路：S1（行业资金流求和，沪深全市场完整划分）优先；
 * S1 抛错或取不到有效值时降级 S2（板块资金流汇总兜底）；两源均失败返回 null。
 * 两个源都来自东财「数据中心族」（本机稳定可达），不引入异源，满足项目「数据一致性」铁律。
 * 返回块 shape 与 fetch_main_fund 一致；口径日与「T-lag 收盘口径」标注由 _enrichMainFundSource 统一追加。
 * @returns {Promise<object|null>}
 */
async function fetchMarketMainFund() {
  // S1：行业资金流求和（申万 128 行业 = 沪深两市完整划分，单位元，与 push2 主链同口径）
  try {
    const fb = await fetchMainFundViaDataCenter();
    if (fb && fb.mainNetToday != null) return _enrichMainFundSource(fb);
  } catch (e) {
    console.warn('[MarketOverview] 主力资金 S1（行业资金流）失败:', e.message);
  }
  // S2：板块资金流汇总（概念板块，仅作 S1 不可达兜底）
  try {
    const fb = await fetchMainFundViaBoardFlow();
    if (fb && fb.mainNetToday != null) return _enrichMainFundSource(fb);
  } catch (e) {
    console.warn('[MarketOverview] 主力资金 S2（板块资金流）失败:', e.message);
  }
  return null;
}

/** [20261024a] 给主力资金源追加「口径日 + T-lag 收盘口径」标注，保证数据最新性规则（标注时效） */
function _enrichMainFundSource(fb) {
  const today = localDate();
  const lagDays = fb.date ? Math.round((Date.parse(today) - Date.parse(fb.date)) / 86400000) : null;
  const lagNote = (lagDays && lagDays > 0)
    ? `；口径日 ${fb.date}（T-${lagDays} 收盘，非实时当日）`
    : (fb.date ? `；口径日 ${fb.date}` : '');
  return { ...fb, source: (fb.source || '') + lagNote };
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
  // [20261024a] 主力资金稳定源链路（必须在 selfCheck 之前注入，保证 issues 反映注入后的真实状态）：
  // 旧逻辑主链 push2delay 实时通道本机常年被 TLS 重置 → 长期取不到当日数据，因子永久「缺失」；
  // 备链（数据中心行业资金流求和）本机稳定可达，但旧代码用 `fb.date === today` 硬门槛拒收 T-1
  //（盘中报表只发布到上一收盘日），导致连稳定源也被丢弃。
  // 现改用 fetchMarketMainFund()：S1 行业资金流求和优先，S1 不可达降级 S2 板块资金流汇总兜底；
  // 接受「最新已收盘交易日」（通常 T-1），由 _enrichMainFundSource 如实标注口径日与「T-lag 收盘口径」，
  // 与融资余额 T+1 同范式——不再因非要「实时当日」而长期空白。收盘后东财发布当日报表时自动变为 T-0。
  const mainFundFallbackNote = await resolveMainFund(raw, today);
  // [20261018] index（上证日线）改由首页量能根单一通道采集：与大盘技术分析同源（腾讯 fqkline
  // 直采）、同窗口（320）、同单位（vol=成交量·手）；原 market_emotion.py 的 akshare 通道
  // 实测与直采重叠 260 根零差异，收敛后只保留一条通道。输出格式不变：
  // { code, name, bars:[{date, close, vol}] }（失败如实记入 issues，不用其他数据冒充）。
  let indexBlock = null, indexErr = null;
  try {
    const rootBars = await fetchIndexDailyBars(320);
    if (rootBars && rootBars.length) {
      indexBlock = {
        code: 'sh000001', name: '上证指数',
        bars: rootBars.map(b => ({ date: b.date, close: b.close, vol: b.volume })),
      };
    }
  } catch (e) {
    indexErr = e;
    console.warn('[MarketEmotionData] 上证日线（量能根通道）失败:', e.message);
  }
  raw.index = indexBlock; // 自检与输出统一用根通道结果（Python 不再返回 index）
  // 20261023o：深证成指日线（与上证同通道、同窗口），供「量能活跃与量价配合」同时分析深市。
  // 失败只让深市子项缺失（卡片按上证单市降级），不影响主流程。
  let indexSZBlock = null, indexSZErr = null;
  try {
    const szBars = await fetchIndexDailyBars(320, 'sz399001');
    if (szBars && szBars.length) {
      indexSZBlock = {
        code: 'sz399001', name: '深证成指',
        bars: szBars.map(b => ({ date: b.date, close: b.close, vol: b.volume })),
      };
    }
  } catch (e) {
    indexSZErr = e;
    console.warn('[MarketEmotionData] 深证成指日线（量能根通道）失败:', e.message);
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.slice() : [];
  const extra = selfCheck(raw, today);
  if (indexErr) extra.push({ block: 'index', msg: '上证指数日线采集失败（量能根通道）：' + indexErr.message });
  if (indexSZErr) extra.push({ block: 'indexSZ', msg: '深证成指日线采集失败（量能根通道）：' + indexSZErr.message });
  if (mainFundFallbackNote) extra.push({ block: 'mainFund', msg: mainFundFallbackNote });
  const data = {
    ok: raw.ok !== false && extra.filter(i => i.block === 'index' || i.block === 'breadth').length === 0,
    date: today,
    index: raw.index || null,
    indexSZ: indexSZBlock,
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

module.exports = { getMarketEmotionData, fetchMainFundViaDataCenter, fetchMainFundViaBoardFlow, fetchMarketMainFund, resolveMainFund, SCRIPT };
