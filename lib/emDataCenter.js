/**
 * 东方财富「数据中心」报表通用取数器（datacenter-web）
 * ============================================================
 * 为什么单独成模块：东财「行情推送族」（push2 / push2delay / push2his / 82.push2 / 16.push2）在本机被
 * 对端在 TLS 握手完成后**立刻重置**（HTTPS 与纯 HTTP(80) 一样，偶发成功 ≈1/15）；而东财「数据中心族」
 * （datacenter-web.eastmoney.com）**稳定可达**。凡 push2 取不到的日频/报表型数据，统一走这里取，
 * 保证口径仍属**东财**，不必退到同花顺等异源（避免破坏项目「数据一致性」铁律）。
 *
 * 本模块刻意**不依赖 lib/stockData.js、也不依赖 axios**：
 *   - 不依赖 stockData → 避免与调用方（stockData / sectorFundFlowEmDc）形成循环 require；
 *   - 不用 axios → Node 原生 https 天然忽略 HTTP_PROXY / HTTPS_PROXY 环境变量，避免被本机代理劫持。
 *
 * 接口：GET https://datacenter-web.eastmoney.com/api/data/v1/get
 *   ?reportName=<报表名>&columns=ALL&source=WEB&client=WEB
 *   [&filter=(列='值' 或 >='值')][&sortColumns=列&sortTypes=-1][&pageSize=N][&pageNumber=1]
 *
 * ⚠️ 失败形态：报表名写错时返回 **HTTP 200 但 `{"success":false,"message":"报表配置不存在,X","code":9501}`**
 *   → 必须显式抛错，否则会被上层误判成「没有数据」而静默失败。
 *
 * 已验证报表（2026-09-21 实测）：
 *   - RPT_INDUSTRY_FUNDFLOW  东财行业板块资金流（逐交易日一行，128 板块/日，单位=元）
 *       BOARD_CODE / BOARD_NAME / TRADE_DATE / CHANGE_RATE / NET_INFLOW /
 *       SUPERDEAL_NET / BIGDEAL_NET / MIDDEAL_NET / SMALLDEAL_NET（=散户小单）/ MAX_NETINFLOW_SEC
 *   - RPT_FUNDFLOW_BOARD     东财板块资金流（含成交额 AMOUNT，单位≈万元，覆盖概念板块）
 *   - RPT_VALUEINDUSTRY_DET  行业估值（lib/analysis.js 在用）
 *   - RPT_VALUEANALYSIS_DET  个股估值（lib/analysis.js 在用）
 *   - RPTA_WEB_RZRQ_GGMX     融资融券明细（lib/capitalFlow.js 在用）
 */
const https = require('https');

const HOST = 'datacenter-web.eastmoney.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://data.eastmoney.com/bkzj/hy.html';
const CALL_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 600;

const REPORTS = {
  INDUSTRY_FUNDFLOW: 'RPT_INDUSTRY_FUNDFLOW',
  FUNDFLOW_BOARD: 'RPT_FUNDFLOW_BOARD',
};

/** 日期平移（UTC 计算，规避本地时区导致串日）；入参/出参均为 'YYYY-MM-DD' */
function shiftDate(ymd, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + deltaDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 单次报表请求（已 JSON 解析；HTTP 200 但 success=false 视为失败并抛错） */
function _request(path, retries) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.request({
        host: HOST,
        path,
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json, text/plain, */*' },
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch (e) { j = null; }
          if (!j || j.success === false) {
            const msg = (j && j.message) || ('HTTP ' + res.statusCode + ' 响应不可解析: ' + body.slice(0, 120));
            if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
            return reject(new Error('东财数据中心接口失败: ' + msg));
          }
          resolve(j);
        });
      });
      req.on('error', (e) => {
        if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
        reject(new Error('东财数据中心不可达: ' + (e.code || e.message)));
      });
      req.setTimeout(CALL_TIMEOUT_MS, () => {
        req.destroy();
        if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
        reject(new Error('东财数据中心请求超时'));
      });
      req.end();
    };
    attempt(typeof retries === 'number' ? retries : DEFAULT_RETRIES);
  });
}

/**
 * 取一张报表的数据行。
 * @param {string} reportName 报表名（见 REPORTS）
 * @param {{filter?:string, sortColumns?:string, sortTypes?:number, pageSize?:number, pageNumber?:number, columns?:string, retries?:number}} [opts]
 * @returns {Promise<Array<object>>} 数据行数组（无数据时返回空数组）
 */
async function fetchReport(reportName, opts = {}) {
  if (!reportName) throw new Error('fetchReport: 缺少 reportName');
  const qs = [
    'reportName=' + encodeURIComponent(reportName),
    'columns=' + encodeURIComponent(opts.columns || 'ALL'),
    'source=WEB',
    'client=WEB',
  ];
  if (opts.filter) qs.push('filter=' + encodeURIComponent(opts.filter));
  if (opts.sortColumns) qs.push('sortColumns=' + encodeURIComponent(opts.sortColumns));
  if (opts.sortTypes != null) qs.push('sortTypes=' + encodeURIComponent(String(opts.sortTypes)));
  qs.push('pageSize=' + encodeURIComponent(String(opts.pageSize || 100)));
  qs.push('pageNumber=' + encodeURIComponent(String(opts.pageNumber || 1)));
  const j = await _request('/api/data/v1/get?' + qs.join('&'), opts.retries);
  const data = j && j.result && j.result.data;
  return Array.isArray(data) ? data : [];
}

/** 某张报表里的最新交易日（'YYYY-MM-DD'，以数据为准，不依赖本地日期/交易日历） */
async function latestTradeDate(reportName, dateColumn = 'TRADE_DATE', retries) {
  const rows = await fetchReport(reportName, {
    sortColumns: dateColumn, sortTypes: -1, pageSize: 1, pageNumber: 1, retries,
  });
  if (!rows.length) throw new Error('东财数据中心报表暂无数据: ' + reportName);
  return String(rows[0][dateColumn]).slice(0, 10);
}

module.exports = { REPORTS, fetchReport, latestTradeDate, shiftDate, HOST };
