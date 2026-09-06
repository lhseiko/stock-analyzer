/**
 * lib/deep/financials.js —— deepAnalysis 领域子模块：东方财富 F10 财务三表 + 股东数据抓取
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 导出（供 deep/pipeline 与门面使用）：fetchFinancialData / fetchShareholders /
 * buildShareholderStats / fetchTopShareholders（后三个不进门面，仅内部）。
 */
const axios = require('axios');
const { UA, HEADERS, _stmtStage } = require('./shared');

const EM_FINANCE_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis';

// 取「最近 N 个已完结年度」的 12-31 报告期（不包含当年未来日期，
// 否则 East Money 对 2026-12-31 返回空、实际只拿到 N-1 个真实年报年，导致最早一年缺失）
function getAnnualDates(years = 10) {
  const currentYear = new Date().getFullYear();
  const dates = [];
  for (let i = 0; i < years; i++) {
    dates.push(`${currentYear - 1 - i}-12-31`);
  }
  return dates;
}

// Fetch financial statement (income/balance/cashflow) for multiple years
// Falls back from companyType=4 to companyType=2 if data is empty (insurance companies)
async function fetchFinancialStatement(type, code, dates) {
  const url = `${EM_FINANCE_BASE}/${type}?companyType=4&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    if (resp.data && resp.data.data && Array.isArray(resp.data.data) && resp.data.data.length > 0) {
      return resp.data.data.sort((a, b) => {
        return new Date(a.REPORT_DATE) - new Date(b.REPORT_DATE);
      });
    }
    // Fallback: companyType=4 may return empty for insurance companies' balance sheet
    console.log(`[FetchStmt] companyType=4 returned no data for ${type}, trying companyType=2...`);
    const url2 = `${EM_FINANCE_BASE}/${type}?companyType=2&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
    const resp2 = await axios.get(url2, { headers: HEADERS, timeout: 15000 });
    if (resp2.data && resp2.data.data && Array.isArray(resp2.data.data) && resp2.data.data.length > 0) {
      return resp2.data.data.sort((a, b) => {
        return new Date(a.REPORT_DATE) - new Date(b.REPORT_DATE);
      });
    }
  } catch (e) {
    console.error(`Fetch ${type} failed:`, e.message);
    // Try fallback on error too
    try {
      const url2 = `${EM_FINANCE_BASE}/${type}?companyType=2&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
      const resp2 = await axios.get(url2, { headers: HEADERS, timeout: 15000 });
      if (resp2.data && resp2.data.data && Array.isArray(resp2.data.data)) {
        return resp2.data.data.sort((a, b) => new Date(a.REPORT_DATE) - new Date(b.REPORT_DATE));
      }
    } catch (e2) {
      console.error(`Fetch ${type} fallback also failed:`, e2.message);
    }
  }
  return [];
}

// 深度分析使用的年报数据回溯年数（用户要求固定为 5 年）
const ANALYSIS_YEARS = 5;

// 计算「最新一期非年报」对应的报告期日期，用于 TTM 滚动估算。
// 返回 [当年最新部分报告日期, 上一年同阶段部分报告日期]；若当前已到年报季（1-4月）则返空数组。
function getLatestPartialQuarterDates() {
  const now = new Date();
  const month = now.getMonth() + 1;
  let q = 0; // 1=一季报 2=中报 3=三季报 0=年报季（无需部分报告）
  if (month >= 5 && month <= 7) q = 1;
  else if (month >= 8 && month <= 10) q = 2;
  else if (month >= 11) q = 3;
  if (q === 0) return [];
  const qe = ['03-31', '06-30', '09-30', '12-31'];
  const d = qe[q - 1];
  const cy = now.getFullYear();
  return [`${cy}-${d}`, `${cy - 1}-${d}`];
}

// 合并年报与部分报告，去重（同一 REPORT_DATE 不重复）
function mergePartialStatements(annual, partial) {
  if (!partial || !partial.length) return annual;
  const seen = new Set((annual || []).map(r => r.REPORT_DATE));
  const out = (annual || []).slice();
  for (const r of partial) {
    if (r.REPORT_DATE && !seen.has(r.REPORT_DATE)) { out.push(r); seen.add(r.REPORT_DATE); }
  }
  return out;
}

// Fetch annual financial data for the most recent N years
async function fetchFinancialData(code) {
  const dates = getAnnualDates(ANALYSIS_YEARS); // 最近 N 年

  const [income, balance, cashflow] = await Promise.all([
    fetchFinancialStatement('lrbAjaxNew', code, dates),
    fetchFinancialStatement('zcfzbAjaxNew', code, dates),
    fetchFinancialStatement('xjllbAjaxNew', code, dates),
  ]);

  // 补充最新一期非年报（利润表 / 现金流量表），供营收/成本/营运利润/经营现金流做 TTM 滚动估算（如 2026 仅出中报时）
  let mergedIncome = income;
  let mergedCashflow = cashflow;
  try {
    const partDates = getLatestPartialQuarterDates();
    if (partDates.length) {
      const [partialIncome, partialCashflow] = await Promise.all([
        fetchFinancialStatement('lrbAjaxNew', code, partDates),
        fetchFinancialStatement('xjllbAjaxNew', code, partDates),
      ]);
      // 仅保留真正的部分报告（非年报）
      const partInc = (partialIncome || []).filter(r => {
        const st = _stmtStage(r.REPORT_DATE_NAME || '');
        return st && st !== 'FY';
      });
      const partCf = (partialCashflow || []).filter(r => {
        const st = _stmtStage(r.REPORT_DATE_NAME || '');
        return st && st !== 'FY';
      });
      mergedIncome = mergePartialStatements(income, partInc);
      mergedCashflow = mergePartialStatements(cashflow, partCf);
    }
  } catch (e) {
    console.error('[FetchPartial] failed, fall back to annual only:', e.message);
    mergedIncome = income;
    mergedCashflow = cashflow;
  }

  return { income: mergedIncome, balance, cashflow: mergedCashflow };
}

// Fetch shareholder data
async function fetchShareholders(code) {
  const secid = code.startsWith('SH') ? `1.${code.slice(2)}` : `0.${code.slice(2)}`;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f84,f85,f86,f100,f102,f103,f116,f117,f162,f163,f167,f173,f184,f185,f186,f187,f188,f190,f191,f192`;
  try {
    const resp = await axios.get(url, { 
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
      timeout: 10000 
    });
    const d = resp.data?.data;
    if (d) {
      return {
        totalShares: d.f84 || 0,
        floatShares: d.f85 || 0,
        pe: d.f162 || 0,
        pb: d.f163 || 0,
        totalMarketCap: d.f116 || 0,
        floatMarketCap: d.f117 || 0,
      };
    }
  } catch (e) {
    console.error('Shareholder data failed:', e.message);
  }
  return null;
}

// 判断股东是否为机构（基金/证券/保险/社保/资管/陆股通/法人等），用于机构持股统计
function isInstitutionName(name) {
  const n = name || '';
  if (/陆股通|香港中央结算/.test(n)) return true;            // 外资/机构通道
  if (/基金|证券|保险|社保|养老|信托|银行|证金|汇金|资管|资产|投资|集团|控股|理财|年金|私募|合伙/.test(n)) return true;
  if (/有限公司|股份公司|企业|公司$/.test(n)) return true;   // 法人股东
  // 纯中文短名（2-4字且无机构关键词）多数为自然人
  const isShortChineseName = /^[\u4e00-\u9fa5]{2,4}$/.test(n.replace(/[（(].*$/, '').trim());
  if (isShortChineseName && !/公司|集团|基金/.test(n)) return false;
  return false;
}

// 基于前十大股东计算机构统计
function buildShareholderStats(topHolders, totalShares) {
  if (!Array.isArray(topHolders) || topHolders.length === 0) return null;
  let instCount = 0, instRatio = 0;
  for (const h of topHolders) {
    if (h.isInstitution) { instCount++; instRatio += (h.holdRatio || 0); }
  }
  return {
    institutionCount: instCount,
    institutionRatio: Math.round(instRatio * 100) / 100,
    topHoldersEndDate: topHolders[0]?.endDate || '',
    totalShares,
    note: '机构统计基于披露的前十大股东（含基金/证券/保险/社保/资管/陆股通/法人等），自然人股东不计入；机构占总股本比例为前十大中机构持股之和。',
  };
}

// Fetch top 10 shareholders
// 20260823h：同步 shareholderData.js 的数值解析，新增 changeAmount/changeRatio，避免深度分析页
// 与短期判断因子使用同一数据源却两套字段。
async function fetchTopShareholders(code) {
  const stockCode = code.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    if (resp.data?.result?.data) {
      return resp.data.result.data.map(h => {
        const rawChange = h.HOLD_NUM_CHANGE;
        const rawRatio = h.CHANGE_RATIO;
        let changeText = '';
        let changeAmount = null;
        let changeRatio = null;
        if (rawChange != null) {
          if (typeof rawChange === 'number') {
            changeAmount = rawChange;
            changeText = rawChange > 0 ? '增持' : rawChange < 0 ? '减持' : '不变';
          } else {
            changeText = String(rawChange);
            const n = Number(changeText.replace(/,/g, ''));
            if (!Number.isNaN(n)) changeAmount = n;
          }
        }
        if (rawRatio != null) {
          const r = Number(rawRatio);
          if (!Number.isNaN(r)) changeRatio = r;
        }
        return {
          name: h.HOLDER_NAME || '',
          holdRatio: h.HOLD_NUM_RATIO || 0,
          holdAmount: h.HOLD_NUM || 0,
          change: changeText,
          changeAmount,
          changeRatio,
          endDate: h.END_DATE || '',
          isInstitution: isInstitutionName(h.HOLDER_NAME || ''),
        };
      });
    }
  } catch (e) {
    console.error('Top shareholders failed:', e.message);
  }
  return [];
}

module.exports = { fetchFinancialData, fetchShareholders, buildShareholderStats, fetchTopShareholders };
