/**
 * 券商板块成交额 / 全市场成交额 —— 供华安证券(600909)专属估值模型
 *   「守门员② 市场环境」与「风险监测（指令4）」取数使用。
 * ==================================================================
 * 背景（20260922d，用户质疑「东财明明有，为何标黄『无法获取』」）：
 *   - 东财「行业板块成交额」是 push2 行情族独有字段（clist 的 f6）；本机 push2 族被对端
 *     在 TLS 握手后重置（与项目其它 push2 依赖同因），故该字段不可达。
 *   - 东财「数据中心」报表族：RPT_INDUSTRY_FUNDFLOW（行业）**不含成交额**；
 *     RPT_FUNDFLOW_BOARD（概念板块）**含逐日成交额 AMOUNT**（单位≈万元）。
 *     即：东财数据中心能拿到的是「概念板块」成交额（如「券商概念」BK0711）。
 *   - 项目既有「同花顺·行业板块成交额」落盘于 data/sector_crowding_history.json
 *     （lib/sectorCrowding.js 维护，「证券」板块 + marketTotal=全市场合计），实测
 *     2026-09-22 券商板块 182.63 亿，与用户东财截图「证券Ⅱ 184.71 亿」吻合。
 *
 * 取值优先级（满足「同一指标单一数据源」，并为缺失提供兜底）：
 *   券商板块成交额：① 同花顺行业板块（本地存盘，与 sectorCrowding 同源）
 *                  ② 东方财富·概念板块「券商概念」(BK0711)（数据中心，逐日）
 *   全市场成交额：  ① 同花顺·申万一级行业成交额合计（本地存盘 marketTotal，sectorCrowding 既有口径）
 *
 * 偏离基线（守门员②）：近 20 交易日日均成交额 相对 近 60 交易日（可用窗口）日均成交额
 *   的偏离百分比；|偏离| > 阈值（默认 30%）→ 判定「市场环境突变」。
 */
const fs = require('fs');
const path = require('path');
const em = require('./emDataCenter');

const STORE = path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
const BROKER_NAME_RE = /^(证券Ⅱ?|券商)/;   // 同花顺行业板块名（「证券」= 申万二级 证券Ⅱ 类比）
const EM_BROKER_BOARD = 'BK0711';           // 东财概念「券商概念」（备源）
const WIN = 20;                             // 近 20 交易日
const BASE_WIN = 60;                        // 基线窗口（可用则取 60，不足取全部）

const _r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const _avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function _readStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) { return null; }
}

/** 从本地同花顺行业板块存盘抽取「券商板块成交额」与「全市场成交额」逐日序列 */
function _fromStore() {
  const store = _readStore();
  if (!store) return null;
  const dates = Object.keys(store).sort();
  if (!dates.length) return null;
  const broker = [], market = [];
  for (const d of dates) {
    const e = store[d];
    if (!e) continue;
    const s = (e.sectors || []).find((x) => BROKER_NAME_RE.test(String(x.name || '')));
    if (s && Number(s.amount) > 0) broker.push({ date: d, amountYi: Number(s.amount) });
    if (Number(e.marketTotal) > 0) market.push({ date: d, amountYi: Number(e.marketTotal) });
  }
  if (!broker.length && !market.length) return null;
  return { broker, market };
}

/** 备源：东财数据中心·概念板块「券商概念」逐日成交额（AMOUNT 单位≈万元 → 亿元） */
async function _fromEmConcept() {
  const rows = await em.fetchReport(em.REPORTS.FUNDFLOW_BOARD, {
    filter: `(BOARD_CODE1="${EM_BROKER_BOARD}")`,
    sortColumns: 'TRADE_DATE', sortTypes: -1,
    pageSize: 90, columns: 'BOARD_CODE1,BOARD_NAME,TRADE_DATE,AMOUNT',
  });
  const broker = rows
    .map((r) => ({ date: String(r.TRADE_DATE).slice(0, 10), amountYi: _r2(Number(r.AMOUNT) / 10000) }))
    .filter((x) => x.amountYi > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return broker.length ? broker : null;
}

/**
 * 由逐日序列汇总：当日 / 近20日日均 / 基线日均 / 偏离%。
 * @param {Array<{date:string, amountYi:number}>} series
 */
function summarize(series, win = WIN, baseWin = BASE_WIN) {
  if (!Array.isArray(series) || !series.length) return null;
  const arr = series.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const vals = arr.map((x) => x.amountYi);
  const today = arr[arr.length - 1];
  const avg20 = _r2(_avg(vals.slice(-Math.min(win, vals.length))));
  const baseline = _r2(_avg(vals.slice(-Math.min(baseWin, vals.length))));
  const devPct = (baseline && baseline > 0) ? _r2(((avg20 - baseline) / baseline) * 100) : null;
  return {
    date: today.date,
    todayYi: _r2(today.amountYi),
    avg20Yi: avg20,
    baselineYi: baseline,
    devPct,                                   // (近20日日均 − 基线日均) / 基线日均 × 100
    windowDays: Math.min(win, vals.length),
    baseDays: Math.min(baseWin, vals.length),
    n: vals.length,
  };
}

/**
 * 汇总输出：{ ok, broker:{...}, market:{...} }。
 * broker 缺失时尝试东财概念板块备源；market 缺失时 broker 仍可用。
 */
async function getTurnoverContext() {
  const out = { ok: false, broker: null, market: null, source: null };
  const st = _fromStore();
  if (st) {
    if (st.broker.length) {
      out.broker = summarize(st.broker);
      out.broker.source = '同花顺·行业板块（申万二级「证券」口径，与 sectorCrowding 同源）';
    }
    if (st.market.length) {
      const m = summarize(st.market);
      out.market = {
        date: m.date, todayYi: m.todayYi, avg20Yi: m.avg20Yi, n: m.n,
        source: '同花顺·申万一级行业成交额合计（A股全市场成交额近似，同 sectorCrowding 口径）',
      };
    }
  }
  if (!out.broker) {
    try {
      const b = await _fromEmConcept();
      if (b) {
        out.broker = summarize(b);
        out.broker.source = '东方财富·概念板块「券商概念」(BK0711)（数据中心，逐日）';
      }
    } catch (e) { /* 备源失败则维持 null，由调用方降级 */ }
  }
  out.source = out.broker ? out.broker.source : null;
  out.ok = !!(out.broker && out.market);
  return out;
}

module.exports = { getTurnoverContext, summarize, _fromStore, BROKER_NAME_RE, EM_BROKER_BOARD };
