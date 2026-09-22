/**
 * 行业板块资金流向 —— 东方财富「数据中心」报表源
 * ==================================================================
 * 背景：本机对东方财富「行情推送族」（push2 / push2delay / push2his / 82.push2 …）
 *   的请求会被对端在 TLS 握手后立刻重置（HTTPS 与纯 HTTP(80) 一样），
 *   而东方财富「数据中心族」（datacenter-web.eastmoney.com）完全可达
 *   （同项目 lib/analysis.js 的行业估值 RPT_VALUEINDUSTRY_DET、lib/capitalFlow.js 的融资融券
 *     RPTA_WEB_RZRQ_GGMX 早已走该域名，即为旁证）。取数细节见 lib/emDataCenter.js。
 *
 * 本模块用报表 RPT_INDUSTRY_FUNDFLOW 取「东财行业板块」资金流，可与 push2delay 口径互换：
 *   字段                含义                        对应 push2delay 字段
 *   ---------------------------------------------------------------
 *   BOARD_NAME          板块名                       f14
 *   CHANGE_RATE         当日涨跌幅(%)                f3
 *   NET_INFLOW          主力净流入(元)                f62
 *   SUPERDEAL_NET       超大单净流入(元)              f66
 *   BIGDEAL_NET         大单净流入(元)                f72
 *   SMALLDEAL_NET       小单净流入(元) = 散户口径      f84
 *   MAX_NETINFLOW_SEC   主力净流入最大股               f204
 *   TRADE_DATE          交易日（逐日一行）            ← 关键：可求和得「近5日」
 *
 * 口径：主力 = 超大单 + 大单（含暗盘性质机构资金）；散户 = 小单。
 * 单位：库内为「元」，对外统一换算为「亿元」，与卡片既有口径一致。
 * 层级：板块名用 parseSwSectorName 解析真实申万层级，再按 SW_LEVEL_UNIFIED 过滤（单层级，父子不重复计入）。
 */
const { parseSwSectorName, SW_LEVEL_UNIFIED } = require('./stockData');
const { REPORTS, fetchReport, latestTradeDate, shiftDate } = require('./emDataCenter');

const MAX_5D_DAYS = 5;                 // 「近5日」= 最近 5 个交易日
const WINDOW_LOOKBACK_DAYS = 16;       // 自然日回溯（覆盖 5 个交易日 + 周末/节假日余量）
const PAGE_SIZE = 900;                 // 单页容纳 ≥7 个交易日全量板块（每日约 128 行）

function _fmtYi(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n / 1e8 * 100) / 100 : 0;
}

module.exports = {
  /**
   * 取行业板块资金流（东财数据中心报表口径），返回值与 sectorCapitalFlow.fetchAll 完全同构。
   * @returns {Promise<object>}
   */
  async getEmDcSectorCapitalFlow() {
    // 1) 最新交易日：以数据为准（数据驱动，不依赖本地日期/交易日历）
    const d0 = await latestTradeDate(REPORTS.INDUSTRY_FUNDFLOW);

    // 2) 取 d0 往前 16 个自然日的全部「逐日」行
    const from = shiftDate(d0, -WINDOW_LOOKBACK_DAYS);
    const all = await fetchReport(REPORTS.INDUSTRY_FUNDFLOW, {
      filter: `(TRADE_DATE>='${from}')`,
      sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: PAGE_SIZE, pageNumber: 1,
    });
    if (!all.length) throw new Error('东财数据中心行业资金流报表窗口内无数据');

    // 3) 交易日分组（以数据中实际出现的日期为准，避免把不完整日期算入 5 日窗口）
    const byDate = new Map();
    for (const r of all) {
      const d = String(r.TRADE_DATE).slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }
    const dates = [...byDate.keys()].sort().reverse();
    const win5 = dates.slice(0, MAX_5D_DAYS);
    const today = byDate.get(d0) || [];
    if (!today.length) throw new Error('东财数据中心行业资金流报表当日无数据');

    // 4) 单条 → 卡片 tile（netKey 指定用哪个净额字段排序，与 push2delay 版同构）
    const tile = (r, netKey = 'NET_INFLOW') => {
      const p = parseSwSectorName(r.BOARD_NAME);
      const isMain = netKey === 'NET_INFLOW';
      return {
        name: p.name,
        rawName: p.rawName,
        swLevel: p.swLevel || null,
        changePct: Number(r.CHANGE_RATE) || 0,
        mainNet: _fmtYi(r[netKey]),
        superLargeNet: isMain ? _fmtYi(r.SUPERDEAL_NET) : null,
        largeNet: isMain ? _fmtYi(r.BIGDEAL_NET) : null,
        leader: r.MAX_NETINFLOW_SEC ? String(r.MAX_NETINFLOW_SEC).trim() : '',
      };
    };
    const inLevel = (x) => !!x && x.swLevel === SW_LEVEL_UNIFIED;
    const top = (rows, netKey, dir, n = 5) => (rows || [])
      .map((r) => tile(r, netKey))
      .filter((x) => inLevel(x) && (dir === 'in' ? x.mainNet > 0 : x.mainNet < 0))
      .sort((a, b) => (dir === 'in' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet))
      .slice(0, n);

    // 5) 近5日累计（对同一板块在最近 5 个交易日上的逐日值求和）
    const acc = new Map();
    for (const d of win5) {
      for (const r of byDate.get(d) || []) {
        const key = String(r.BOARD_NAME).trim();
        if (!key) continue;
        const cur = acc.get(key) || { raw: key, main: 0, retail: 0, days: 0 };
        cur.main += Number(r.NET_INFLOW) || 0;
        cur.retail += Number(r.SMALLDEAL_NET) || 0;
        cur.days += 1;
        acc.set(key, cur);
      }
    }
    const sumTile = (v, field) => {
      const p = parseSwSectorName(v.raw);
      return {
        name: p.name,
        rawName: p.rawName,
        swLevel: p.swLevel || null,
        changePct: 0,
        mainNet: _fmtYi(v[field]),
        superLargeNet: null,
        largeNet: null,
        leader: '',
      };
    };
    const sumList = [...acc.values()].map((v) => ({ main: sumTile(v, 'main'), retail: sumTile(v, 'retail') }));
    const pick = (field, dir) => sumList
      .map((x) => x[field]).filter(inLevel)
      .sort((a, b) => (dir === 'max' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet))[0] || null;

    const winLabel = win5.length > 1 ? `${win5[win5.length - 1]} ~ ${win5[0]}` : win5[0];

    return {
      ok: true,
      date: d0,
      source: '东方财富·行业资金流（数据中心）',
      note: `主力净流入 = 超大单 + 大单（含暗盘性质机构资金）；散户净流入 = 小单净流入（单笔＜2万股或＜4万元）；`
        + `榜单统一${SW_LEVEL_UNIFIED}口径（单层级，父子行业不重复计入）。`
        + `取数：东方财富数据中心·行业资金流报表（逐日口径），数据截至 ${d0}；近5日 = 最近 ${win5.length} 个交易日（${winLabel}）逐日累计`,
      todayInflowTop5: top(today, 'NET_INFLOW', 'in'),
      todayOutflowTop5: top(today, 'NET_INFLOW', 'out'),
      retailInflowTop5: top(today, 'SMALLDEAL_NET', 'in'),
      retailOutflowTop5: top(today, 'SMALLDEAL_NET', 'out'),
      fiveDayMaxInflow: pick('main', 'max'),
      fiveDayMaxOutflow: pick('main', 'min'),
      retailFiveDayMaxInflow: pick('retail', 'max'),
      retailFiveDayMaxOutflow: pick('retail', 'min'),
      fallbackWarning: `东方财富实时行情接口(push2delay)在本机不可达，已改用东方财富数据中心·行业资金流报表（同为东财口径，数据截至 ${d0}）`,
      fiveDayWarning: null,
    };
  },
};
