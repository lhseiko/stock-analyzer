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
// 20261015f：companyType 回退链由 [4,2] 扩展为 [4,2,3,1]，与 lib/stockData.js 现金流量表
// 取数（xjllbAjaxNew，注释「不同行业 companyType 不同（通用4/银行2/保险3/券商1）依次尝试」）
// 完全对齐。根因（服务日志实测 + 接口实测）：券商股（如 000783 长江证券 / 600909 华安证券）的
// 资产负债表 zcfzbAjaxNew / 现金流量表 xjllbAjaxNew 仅 companyType=1 有数据，ct=4/2/3 全部
// 返回空 → 深析页 Balance: 0 / Cashflow: 0，资产负债与现金流分析、DCF 全部失真。
// 普通股 ct=4 首次命中（一次请求，行为不变）；保险/银行/券商逐级回退，任一类型返回非空即用。
async function fetchFinancialStatement(type, code, dates) {
  for (const companyType of [4, 2, 3, 1]) {
    const url = `${EM_FINANCE_BASE}/${type}?companyType=${companyType}&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      if (resp.data && resp.data.data && Array.isArray(resp.data.data) && resp.data.data.length > 0) {
        return resp.data.data.sort((a, b) => {
          return new Date(a.REPORT_DATE) - new Date(b.REPORT_DATE);
        });
      }
      console.log(`[FetchStmt] companyType=${companyType} returned no data for ${type}, trying next companyType...`);
    } catch (e) {
      console.error(`Fetch ${type} (companyType=${companyType}) failed:`, e.message);
    }
  }
  return [];
}

// 深度分析使用的年报数据回溯年数（用户要求固定为 5 年）
const ANALYSIS_YEARS = 5;

// 计算「部分报告期」日期列表，用于 TTM 滚动估算 / 单季拆分。
// 20261023h：改为「直接请求最近两年的全部季末报告期」，由 F10 返回实际已披露的那些；
// 不再按月份猜「现在是几季报」——原实现 10 月仍判中报季（q=2），三季报已披露也不请求 09-30，
// 导致「三季报已出、模块仍解读半年报」（用户 2026-10-23 洲明科技 300232 报障）。
// 早于披露日请求时 F10 返回空，天然无副作用；披露后同一次请求即可取到。
// 12-31（年报）由调用方 _stmtStage==='FY' 过滤，不会混入「部分报告」。
function getLatestPartialQuarterDates(now = new Date()) {
  const cy = now.getFullYear();
  const qe = ['03-31', '06-30', '09-30', '12-31'];
  const dates = [];
  for (const d of qe) dates.push(`${cy}-${d}`, `${cy - 1}-${d}`);
  return dates;
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
// 20261015f：数据源统一——原走 push2.eastmoney.com（本机常年被对端 TLS 重置，服务日志实测
// 000783/600909 持续 socket hang up，深析估值/DCF/公司分类长期拿不到股本与市值），现改为
// 东财「数据中心」估值分析报表 RPT_VALUEANALYSIS_DET（datacenter-web 本机稳定可达）。
// 与两个既有权威口径完全一致：①基本面的 totalShares / PS_TTM 同源同报表
// （lib/stockData.fetchStockValuationAnalysis）；②与腾讯行情实测逐位吻合（000783 实测：
// datacenter 总股本 5,530,072,948 股、总市值 431.90 亿、PE_TTM 8.3832/PB 1.1703 = 腾讯
// 8.38/1.17/431.90 亿）。返回六字段与原 push2 f84/f85/f116/f117/f162/f163 完全同名同单位
// （股/股/元/元/倍/倍），下游 analyzeValuation / calculateDCF / classifyCompanyType 零改动。
// 失败时仍返回 null（消费方已有 quote 兜底链，维持契约不伪造）。
async function fetchShareholders(code) {
  const stockCode = String(code || '').replace(/^(SH|SZ|BJ)/i, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=1&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    const d = resp.data?.result?.data?.[0];
    if (d && Number(d.TOTAL_SHARES) > 0) {
      return {
        totalShares: Number(d.TOTAL_SHARES) || 0,
        floatShares: Number(d.FREE_SHARES_A) || 0,
        pe: Number(d.PE_TTM) || 0,
        pb: Number(d.PB_MRQ) || 0,
        totalMarketCap: Number(d.TOTAL_MARKET_CAP) || 0,
        floatMarketCap: Number(d.NOTLIMITED_MARKETCAP_A) || 0,
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
// 20260913g：与 shareholderData.js 同步修正报告期选取——pageSize 由 10 提到 80，并取
// 「最新一个满 10 行的完整披露日」（含非季度末的权益变动/临时披露，如海天味业 2026-07-03），
// 不再只认季度末；endDate 统一截取到 10 位、新增 periodKind。避免深度分析页与短期判断两卡口径不一致。
const _QE_RE = /-(03-31|06-30|09-30|12-31)$/;
function _pickLatestDisclosure(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = String(r.END_DATE || '').slice(0, 10);
    if (d) byDate[d] = (byDate[d] || 0) + 1;
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return { date: '', kind: '' };
  const full = dates.filter(d => byDate[d] >= 10);
  let date = full.length ? full[full.length - 1] : '';
  if (!date) {
    const q = dates.filter(d => _QE_RE.test(d));
    date = q.length ? q[q.length - 1] : dates[dates.length - 1];
  }
  return { date, kind: _QE_RE.test(date) ? '季度末报告期' : '最新披露（权益变动/临时公告）' };
}
async function fetchTopShareholders(code) {
  const stockCode = code.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=80&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    if (resp.data?.result?.data) {
      const _rows = resp.data.result.data;
      const _picked = _pickLatestDisclosure(_rows);
      return _rows.filter(h => String(h.END_DATE || '').slice(0, 10) === _picked.date).map(h => {
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
          endDate: _picked.date,
          periodKind: _picked.kind,
          isInstitution: isInstitutionName(h.HOLDER_NAME || ''),
        };
      });
    }
  } catch (e) {
    console.error('Top shareholders failed:', e.message);
  }
  return [];
}

module.exports = { fetchFinancialData, fetchShareholders, buildShareholderStats, fetchTopShareholders, getLatestPartialQuarterDates };
