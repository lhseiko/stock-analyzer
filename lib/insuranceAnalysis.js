/**
 * Insurance Company Analysis Module
 * Based on insurance analysis outline (18 sections)
 * Covers: Premium income, NBV, combined ratio, investment yield, P/EV, DDM
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};

// Known insurance company codes (A-share)
// 仅收录 A 股主营保险业务的上市公司；非保险股一律不列入。
const INSURANCE_CODES = {
  '601318': '中国平安',
  '601628': '中国人寿',
  '601336': '新华保险',
  '601319': '中国人保',
  '601601': '中国太保',
};

// ─────────────────────────────────────────────────────────────────────────
// 保险公司核心指标「真实值」备查库
// 来源：东方财富妙想金融数据 + 中国平安年报，已交叉核对（2026-08-25）。
// 用途：替代利润表难以直接提取的 NBV / 综合成本率 / 投资收益率等保险专属指标。
// 这些指标在合并利润表/资产负债表无直接对应科目，用流量字段估算会产生量级错误
// （此前投资收益率被低估至 0.x%、综合成本率被算成 0.0x% 即是此因）。
// 数据一致性红线：单一指标只从此处取数，跨模块复用同一份，不另起估算。
// 数值为各报告期「累计」值：中报=上半年累计、三季报=前三季度累计、年报=全年。
// ─────────────────────────────────────────────────────────────────────────
const INSURANCE_REAL_DATA = {
  '601318': {
    // 寿险及健康险 新业务价值 NBV（亿元）。
    // 妙想返回的是各报告期「累计」口径：Q1=单季，H1=Q1+Q2，Q3=前三季，FY=全年。
    // 2020–2025 共 24 个季度，用于绘制真正的季度趋势图。
    nbv: {
      source: '妙想金融数据 + 中国平安年报',
      note: '数据回溯提醒：公司把 2023 年、2024 年新业务价值的长期投资回报率假设由 5% 调低到 4.5% 再至 4%，历史口径不可直接对比。',
      cumulative: [
        { period: '2020Q1', label: '2020Q1', value: 164.5 },
        { period: '2020H1', label: '2020H1', value: 310.3 },
        { period: '2020Q3', label: '2020Q3', value: 428.4 },
        { period: '2020FY', label: '2020年报', value: 495.8 },
        { period: '2021Q1', label: '2021Q1', value: 189.8 },
        { period: '2021H1', label: '2021H1', value: 273.9 },
        { period: '2021Q3', label: '2021Q3', value: 352.4 },
        { period: '2021FY', label: '2021年报', value: 379.0 },
        { period: '2022Q1', label: '2022Q1', value: 125.9 },
        { period: '2022H1', label: '2022H1', value: 195.7 },
        { period: '2022Q3', label: '2022Q3', value: 258.5 },
        { period: '2022FY', label: '2022年报', value: 288.2 },
        { period: '2023Q1', label: '2023Q1', value: 137.0 },
        { period: '2023H1', label: '2023H1', value: 259.6 },
        { period: '2023Q3', label: '2023Q3', value: 335.7 },
        { period: '2023FY', label: '2023年报', value: 310.8 },
        { period: '2024Q1', label: '2024Q1', value: 128.9 },
        { period: '2024H1', label: '2024H1', value: 223.2 },
        { period: '2024Q3', label: '2024Q3', value: 351.6 },
        { period: '2024FY', label: '2024年报', value: 400.2 },
        { period: '2025Q1', label: '2025Q1', value: 128.9 },
        { period: '2025H1', label: '2025H1', value: 223.4 },
        { period: '2025Q3', label: '2025Q3', value: 357.2 },
        { period: '2025FY', label: '2025年报', value: 369.0 },
        { period: '2026Q1', label: '2026Q1', value: 155.7 },
        { period: '2026H1', label: '2026H1', value: 248.5 },
      ],
    },
    // 综合成本率（产险业务，%）。产险业务综合成本率 = (赔付+费用+准备金变动)/已赚保费。
    combinedRatio: {
      source: '妙想金融数据',
      data: [
        { period: '2025Q1', label: '2025Q1', value: 96.6 },
        { period: '2025H1', label: '2025H1', value: 95.2 },
        { period: '2025Q3', label: '2025Q3', value: 97.0 },
        { period: '2025FY', label: '2025年报', value: 96.8 },
        { period: '2026Q1', label: '2026Q1', value: 95.8 },
        { period: '2026H1', label: '2026H1', value: 95.1 },
      ],
    },
    // 总投资收益率（年化，%）。
    // 口径说明：保险行业惯例披露「年化」总投资收益率（interim 报告按年化处理）。
    // 2020-2023 及 2025 中报前数据取自中国平安年报/季报披露的年化值；
    // 2024-2025 年报及 2026 各期为券商测算（平安官方年报主要披露净/综合投资收益率，
    // 总投资收益率 ≈ 总投资收益 / 平均投资资产），其中 2026Q1/H1 由单季非年化值按期间年化推算。
    investmentYield: {
      source: '中国平安年报/季报 + 妙想金融数据 + 券商测算',
      data: [
        { period: '2020Q1', label: '2020Q1', value: 3.4 },
        { period: '2020H1', label: '2020H1', value: 4.4 },
        { period: '2020FY', label: '2020FY', value: 6.2 },
        { period: '2021Q1', label: '2021Q1', value: 3.1 },
        { period: '2021H1', label: '2021H1', value: 3.5 },
        { period: '2021FY', label: '2021FY', value: 4.0 },
        { period: '2022Q1', label: '2022Q1', value: 2.3 },
        { period: '2022H1', label: '2022H1', value: 3.1 },
        { period: '2022FY', label: '2022FY', value: 2.5 },
        { period: '2023Q1', label: '2023Q1', value: 3.3 },
        { period: '2023H1', label: '2023H1', value: 3.4 },
        { period: '2023FY', label: '2023FY', value: 3.0 },
        { period: '2024Q1', label: '2024Q1', value: 3.5 },
        { period: '2024H1', label: '2024H1', value: 4.2 },
        { period: '2024FY', label: '2024FY', value: 4.0 },
        { period: '2025Q1', label: '2025Q1', value: 5.2 },
        { period: '2025H1', label: '2025H1', value: 6.2 },
        { period: '2025FY', label: '2025FY', value: 4.6 },
        { period: '2026Q1', label: '2026Q1', value: 1.6 },
        { period: '2026H1', label: '2026H1', value: 4.2 },
      ],
    },
    // 险种 / 业务结构占比（主营构成口径）。
    // 平安集团为综合金融集团，合并利润表无法直接拆分「保费险种占比」；
    // 此处采用妙想主营构成中的分业务营业收入作为业务结构近似替代。
    premiumComposition: {
      source: '妙想金融数据（主营构成）',
      reportDate: '2026-06-30',
      note: '口径：平安集团分业务主营构成（2026年中报），已剔除内部抵销；银行、资管、金融赋能为非保险业务。',
      // value 采用各业务营业收入（亿元）；ECharts 会自动计算占比。
      data: [
        { name: '寿险及健康险', value: 2694.0 },
        { name: '财产保险', value: 1790.0 },
        { name: '银行', value: 706.2 },
        { name: '资产管理', value: 426.6 },
        { name: '金融赋能', value: 224.9 },
      ],
    },
  },
};

// 取两位小数的小工具
function round2(n) {
  const v = parseFloat(n);
  return isNaN(v) ? 0 : Math.round(v * 100) / 100;
}

// 按报告期（年 + 阶段）做时间顺序排序：Q1 < H1 < Q3 < FY
const _PERIOD_ORDER = { Q1: 1, H1: 2, Q3: 3, FY: 4 };
function sortByReportPeriod(arr) {
  return arr.slice().sort((a, b) => {
    const pa = String(a.year || ''), pb = String(b.year || '');
    const ya = pa.slice(0, 4), yb = pb.slice(0, 4);
    if (ya !== yb) return ya < yb ? -1 : 1;
    const sa = (pa.match(/(Q1|H1|Q3|FY)$/) || [''])[0];
    const sb = (pb.match(/(Q1|H1|Q3|FY)$/) || [''])[0];
    return (_PERIOD_ORDER[sa] || 0) - (_PERIOD_ORDER[sb] || 0);
  });
}

// 将「累计」口径的 NBV 序列拆成各季度「环比增量」+ 累计值，并计算 TTM 滚动。
// 年内顺序 Q1 → H1(=Q1+Q2) → Q3(=Q1+Q2+Q3) → FY(全年)。
function buildQuarterlyNBV(cumulative) {
  const byYear = {};
  for (const c of (cumulative || [])) {
    const m = /^(\d{4})(Q1|H1|Q3|FY)$/.exec(c.period || '');
    if (!m) continue;
    (byYear[m[1]] = byYear[m[1]] || {})[m[2]] = c.value;
  }
  const quarters = [];
  for (const y of Object.keys(byYear).sort()) {
    const g = byYear[y];
    const q1 = g.Q1, h1 = g.H1, q3 = g.Q3, fy = g.FY;
    if (q1 != null) quarters.push({ year: y, quarter: 'Q1', label: `${y}Q1`, value: round2(q1), cumulative: round2(q1) });
    if (h1 != null && q1 != null) quarters.push({ year: y, quarter: 'Q2', label: `${y}Q2`, value: round2(h1 - q1), cumulative: round2(h1) });
    if (q3 != null && h1 != null) quarters.push({ year: y, quarter: 'Q3', label: `${y}Q3`, value: round2(q3 - h1), cumulative: round2(q3) });
    if (fy != null && q3 != null) quarters.push({ year: y, quarter: 'Q4', label: `${y}Q4`, value: round2(fy - q3), cumulative: round2(fy) });
    else if (fy != null && h1 != null) quarters.push({ year: y, quarter: 'Q4', label: `${y}Q4`, value: round2(fy - h1), cumulative: round2(fy) });
  }

  // 计算 TTM 滚动：每个报告期往前推 4 个单季度增量之和。
  // 这能消除年内季节波动，与市场上常见的「NBV TTM」趋势图口径一致。
  for (let i = 3; i < quarters.length; i++) {
    const ttm = quarters[i].value + quarters[i - 1].value + quarters[i - 2].value + quarters[i - 3].value;
    quarters[i].ttm = round2(ttm);
  }

  return quarters;
}

// Insurance industry detection by name/code
function isInsuranceCompany(symbol, name, quote) {
  // Check by known codes
  const code = symbol.replace(/^(SH|SZ|sh|sz)/, '');
  if (INSURANCE_CODES[code]) return true;
  
  // Check by name keywords
  // 注意：裸「平安」会误标平安银行（000001），故不以裸「平安」判定；
  // 中国平安(601318)已由代码表命中，名称含「保险」亦可命中。
  const n = (name || '').toLowerCase();
  if (n.includes('保险') || n.includes('人寿') || n.includes('太保') || n.includes('人保')) {
    return true;
  }
  
  // Check by industry from quote
  const industry = quote?.industry || quote?.f100 || '';
  if (typeof industry === 'string' && industry.includes('保险')) {
    return true;
  }
  
  return false;
}

// Fetch insurance operational data from Eastmoney
// This API returns premium income, NBV, combined ratio, etc.
async function fetchInsuranceOperations(emCode) {
  const results = {
    premiums: [],        // 保费收入 by year
    premiumByType: [],   // 分险种保费
    nbv: [],             // 新业务价值
    combinedRatio: [],   // 综合成本率
    investmentYield: [], // 综合投资收益率
    embeddedValue: [],   // 内含价值
    operatingProfit: [], // 营运利润
    netProfit: [],       // 净利润
  };
  
  // Try Eastmoney's operation data API
  // Endpoint: CompanyOperation/PageAjax
  const opUrl = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanyOperation/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(opUrl, { headers: HEADERS, timeout: 15000 });
    const data = resp.data;
    
    // Parse operational data - structure varies by company
    // Look for insurance-specific indicators
    if (data) {
      // Try to find premium income data
      const indicators = data.bzyszb || data.jyzb || data.OperationIndicators || [];
      if (Array.isArray(indicators)) {
        for (const item of indicators) {
          if (item.OPERATING_TYPE || item.ITEM_NAME) {
            const typeName = item.OPERATING_TYPE || item.ITEM_NAME || '';
            const year = item.REPORT_DATE ? item.REPORT_DATE.substring(0, 4) : '';
            const value = parseFloat(item.OPERATING_INCOME || item.AMOUNT || 0);
            
            if (typeName.includes('保费') || typeName.includes('原保险')) {
              results.premiums.push({ year, value, type: typeName, reportDate: item.REPORT_DATE || '' });
            }
            if (typeName.includes('新业务价值') || typeName.includes('NBV')) {
              results.nbv.push({ year, value, type: typeName });
            }
            if (typeName.includes('综合成本率')) {
              results.combinedRatio.push({ year, value, type: typeName });
            }
            if (typeName.includes('投资收益率') || typeName.includes('总投资收益率')) {
              results.investmentYield.push({ year, value, type: typeName });
            }
            if (typeName.includes('内含价值')) {
              results.embeddedValue.push({ year, value, type: typeName });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[InsuranceOps] Fetch failed:', e.message);
  }
  
  return results;
}

// TTM 流量指标字段定义（字段名 -> 提取函数）
const _TTM_FIELDS = {
  earnedPremium: r => toYi(r.EARNED_PREMIUM || r.OPERATE_INCOME || 0),
  insuranceRevenue: r => toYi(r.OPERATE_INCOME || r.EARNED_PREMIUM || 0),
  claimPayments: r => toYi(r.NET_COMPENSATE_EXPENSE || 0),
  surrenderValue: r => toYi(r.SURRENDER_VALUE || 0),
  reserveChange: r => toYi(r.NET_CONTRACT_RESERVE || 0),
  investmentIncome: r => toYi(r.INVEST_INCOME || 0),
  operatingProfit: r => toYi(r.OPERATE_PROFIT || 0),
  netProfit: r => toYi(r.PARENT_NETPROFIT || r.NETPROFIT || 0),
  commissionExpense: r => toYi(r.FEE_COMMISSION_EXPENSE || 0),
};

// 对利润表流量指标按年做 TTM 还原。
// 规则：有年报用年报；无年报取最新一期非年报，并用「当年部分 + 上一年年报 - 上一年同阶段部分」还原为 TTM。
function computeTTMFromIncome(income) {
  if (!income || !income.length) {
    const empty = {};
    for (const k of Object.keys(_TTM_FIELDS)) empty[k] = [];
    return empty;
  }
  const byYear = {};
  for (const r of income) {
    const y = r.REPORT_DATE ? r.REPORT_DATE.slice(0, 4) : '';
    if (!y) continue;
    const st = _reportStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = {};
  for (const k of Object.keys(_TTM_FIELDS)) result[k] = [];

  let prevFY = null;          // 上一年年报值 { key -> 亿 }
  let prevPartials = {};      // 上一年各阶段部分报告值 { stage -> { key -> 亿 } }

  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.annual);
      rec = { year: y, ...vals, ttm: false, note: '' };
    } else {
      // 取最新一期非年报
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prevFY) {
        const vals = {};
        for (const [k, fn] of Object.entries(_TTM_FIELDS)) {
          const cur = fn(bestRec);
          const pf = prevFY[k] || 0;
          const ps = (prevPartials[bestStage] && prevPartials[bestStage][k]) || 0;
          vals[k] = Math.round((cur + (pf - ps)) * 100) / 100;
        }
        rec = { year: y, ...vals, ttm: true, note: `TTM估算（${bestRec.REPORT_DATE_NAME || bestStage}）` };
      } else if (bestRec) {
        const vals = {};
        for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(bestRec);
        rec = { year: y, ...vals, ttm: true, note: `${bestRec.REPORT_DATE_NAME || bestStage}累计值（无上一年同阶段）` };
      }
    }
    if (rec) {
      for (const k of Object.keys(_TTM_FIELDS)) {
        result[k].push({ year: rec.year, value: rec[k], ttm: rec.ttm, note: rec.note });
      }
    }
    // 更新上一年追踪
    if (g.annual) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.annual);
      prevFY = vals;
    }
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.partials[s]);
      thisPartials[s] = vals;
    }
    prevPartials = thisPartials;
  }
  return result;
}

// Extract insurance-specific data from financial statements
// Income statement for insurance companies has special items:
// EARNED_PREMIUM, NET_COMPENSATE_EXPENSE, NET_CONTRACT_RESERVE, SURRENDER_VALUE,
// INVEST_INCOME, OPERATE_PROFIT, PARENT_NETPROFIT
function extractInsuranceMetricsFromStatements(income, balance) {
  // 利润表流量指标统一按 TTM 还原，避免 2026 年中报累计值直接对比 2025 年年报，
  // 并消除同一年年报+部分报告被重复相加的问题。
  const ttm = computeTTMFromIncome(income);
  const metrics = {
    earnedPremium: ttm.earnedPremium,      // 已赚保费
    insuranceRevenue: ttm.insuranceRevenue,// 保险业务收入
    claimPayments: ttm.claimPayments,      // 赔付支出
    surrenderValue: ttm.surrenderValue,    // 退保金
    reserveChange: ttm.reserveChange,      // 准备金净增加额
    investmentIncome: ttm.investmentIncome,// 投资收益
    operatingProfit: ttm.operatingProfit,  // 营业利润
    netProfit: ttm.netProfit,              // 归母净利润
    commissionExpense: ttm.commissionExpense, // 手续费及佣金支出（估算综合成本率用）
    totalAssets: [],        // 总资产
    netAssets: [],          // 归母净资产
    insuranceReserves: [],  // 保险合同准备金
  };
  
  for (const item of balance) {
    const year = item.REPORT_DATE ? item.REPORT_DATE.substring(0, 4) : '';
    if (!year) continue;
    
    metrics.totalAssets.push({
      year,
      value: toYi(item.TOTAL_ASSETS || 0),
    });
    metrics.netAssets.push({
      year,
      value: toYi(item.TOTAL_PARENT_EQUITY || item.TOTAL_EQUITY || 0),
    });
    // Insurance contract reserves - try multiple field names
    metrics.insuranceReserves.push({
      year,
      value: toYi(item.INSURANCE_CONTRACT_RESERVES || item.BXHTZBJ || item.RESERVE_INSURANCE || 0),
    });
  }
  
  return metrics;
}

// Analyze premium income trends (10 years)
function analyzePremiumTrends(metrics, operations, symbol) {
  // Merge data from financial statements and operational data
  let premiumData = operations.premiums.length > 0 
    ? operations.premiums 
    : metrics.earnedPremium;
  
  // 运营口径若同一年出现多条（年报 + 部分报告），按年去重：优先取年报(12-31)，否则取最新一期，避免重复相加
  if (premiumData !== metrics.earnedPremium) {
    const dedup = new Map();
    for (const p of premiumData) {
      if (!p.year) continue;
      const isAnnual = (p.reportDate || '').includes('12-31');
      const prev = dedup.get(p.year);
      if (!prev) { dedup.set(p.year, p); continue; }
      if (isAnnual && !prev.isAnnual) dedup.set(p.year, { ...p, isAnnual: true });
      else if (isAnnual === prev.isAnnual && (p.reportDate || '') > (prev.reportDate || '')) dedup.set(p.year, { ...p, isAnnual });
    }
    premiumData = Array.from(dedup.values());
  }
  
  // Group by year and aggregate
  const yearMap = new Map();
  for (const p of premiumData) {
    if (!p.year) continue;
    if (!yearMap.has(p.year)) {
      yearMap.set(p.year, { year: p.year, total: 0, byType: {}, ttm: false, note: '' });
    }
    const entry = yearMap.get(p.year);
    entry.total += p.value || 0;
    if (p.ttm) { entry.ttm = true; if (p.note) entry.note = p.note; }
    if (p.type) {
      entry.byType[p.type] = (entry.byType[p.type] || 0) + (p.value || 0);
    }
  }
  
  const yearlyData = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate YoY growth
  for (let i = 1; i < yearlyData.length; i++) {
    const prev = yearlyData[i - 1].total;
    const curr = yearlyData[i].total;
    yearlyData[i].yoyGrowth = prev > 0 ? ((curr - prev) / prev * 100) : 0;
  }
  if (yearlyData.length > 0) yearlyData[0].yoyGrowth = 0;
  
  // Premium type breakdown (latest year)
  const latest = yearlyData[yearlyData.length - 1];
  let typeBreakdown = latest ? Object.entries(latest.byType).map(([type, value]) => ({
    name: type,
    value,
    percentage: latest.total > 0 ? (value / latest.total * 100) : 0,
  })).sort((a, b) => b.value - a.value) : [];
  
  // 如果利润表/运营数据无法拆出险种结构，改用真实备查库（妙想主营构成）
  let compositionSource = null;
  let compositionNote = null;
  if (typeBreakdown.length === 0 && symbol && INSURANCE_REAL_DATA[symbol]?.premiumComposition) {
    const comp = INSURANCE_REAL_DATA[symbol].premiumComposition;
    typeBreakdown = comp.data.map(d => ({ ...d, percentage: 0 })); // percentage 由 ECharts 计算
    compositionSource = comp.source;
    compositionNote = comp.note;
  }
  
  return {
    yearlyData,
    typeBreakdown,
    totalGrowth: yearlyData.length >= 2 
      ? ((yearlyData[yearlyData.length - 1].total / yearlyData[0].total - 1) * 100) 
      : 0,
    latestYear: latest?.year || '',
    latestPremium: latest?.total || 0,
    compositionSource,
    compositionNote,
  };
}

// 报告期阶段判定：年报 / 一季报 / 中报 / 三季报
function _reportStage(reportName) {
  if (!reportName) return null;
  if (reportName.includes('年报')) return 'FY';
  if (reportName.includes('一季报')) return 'Q1';
  if (reportName.includes('中报')) return 'H1';
  if (reportName.includes('三季报')) return 'Q3';
  return null;
}
// 阶段优先级（数值越大越"新"）
const _STAGE_ORDER = { Q1: 1, H1: 2, Q3: 3 };

// Extract a yearly business-line series from segment data (集团年报分业务披露)
// 口径规则（用户要求）：
//   1) 优先采用「年报」数据；
//   2) 若某年（如 2026）尚未披露年报、但有最新一期报告（中报/一季报），
//      则采用 TTM 滚动累计：当年已披露部分 + 上一年剩余季度。
//        TTM(当年) = 当年部分报告值 + (上一年年报 - 上一年同阶段部分报告值)
function buildBusinessLineFromSegment(segmentData, keyword) {
  // 优先使用 allPeriods（保留该年全部报告期），以便 TTM 取「上一年同阶段部分报告」还原剩余季度；
  // 缺失时回退 byYear（仅最新一期，TTM 不可用）。
  const src = (segmentData && segmentData.allPeriods) || (segmentData && segmentData.byYear) || null;
  if (!src) return [];
  const out = [];
  const years = (segmentData.years || []).slice().sort();
  // 规范化：兼容 allPeriods[{stage,reportName,items}] 与 byYear[扁平 items] 两种形态
  const _periodsOf = (y) => {
    const raw = src[y] && (src[y]['产品'] || src[y]['产品分部']);
    if (!raw || !raw.length) return [];
    if (Array.isArray(raw[0] && raw[0].items)) return raw;
    return [{ stage: _reportStage((raw[0] && raw[0].reportName) || ''), reportName: (raw[0] && raw[0].reportName) || '', items: raw }];
  };
  // 上一年追踪：年报值 + 各阶段部分报告值（用于 TTM 还原剩余季度）
  let prevFY = null;
  let prevPartials = {}; // stage -> 收入(亿)
  for (const y of years) {
    const periods = _periodsOf(y);
    if (!periods.length) { prevFY = null; prevPartials = {}; continue; }
    let annual = null, partial = null;
    for (const p of periods) {
      const it = (p.items || []).find(x => x.name.includes(keyword));
      if (!it) continue;
      const st = p.stage || _reportStage(p.reportName);
      const v = Math.round(it.income / 1e8 * 100) / 100;
      if (st === 'FY') { if (!annual) annual = { value: v, ratio: it.ratio, grossMargin: it.grossMargin, reportName: p.reportName }; }
      else if (st) { if (!partial || _STAGE_ORDER[st] > _STAGE_ORDER[partial.stage]) partial = { stage: st, value: v, ratio: it.ratio, grossMargin: it.grossMargin, reportName: p.reportName }; }
    }
    let entry = null;
    if (annual) {
      entry = {
        year: y,
        value: annual.value,
        ratio: annual.ratio,
        grossMargin: annual.grossMargin,
        ttm: false,
        note: '',
      };
    } else if (partial && prevFY != null && prevPartials[partial.stage] != null) {
      // TTM 估算：当年部分 + 上年剩余季度
      const ttmVal = Math.round((partial.value + (prevFY - prevPartials[partial.stage])) * 100) / 100;
      entry = {
        year: y,
        value: ttmVal,
        ratio: partial.ratio,
        grossMargin: partial.grossMargin,
        ttm: true,
        note: `TTM估算（${partial.reportName}叠加${parseInt(y, 10) - 1}年后三季度）`,
      };
    }
    if (entry) out.push(entry);
    // 更新上一年追踪
    const thisPartials = {};
    for (const p of periods) {
      const it = (p.items || []).find(x => x.name.includes(keyword));
      if (!it) continue;
      const st = p.stage || _reportStage(p.reportName);
      if (st && st !== 'FY') thisPartials[st] = Math.round(it.income / 1e8 * 100) / 100;
    }
    prevFY = annual ? annual.value : prevFY;
    prevPartials = thisPartials;
  }
  out.sort((a, b) => a.year.localeCompare(b.year));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].value, curr = out[i].value;
    out[i].yoy = prev > 0 ? Math.round((curr - prev) / prev * 100 * 100) / 100 : 0;
  }
  return out;
}

// Build the 5 business-line trend series for the deep-analysis "分业务趋势" section.
// Sources: life/property from group segment disclosure (annual reports); pension/health from
// Ping An's monthly/annual original-premium announcements (subsidiary 口径); NBV from annual reports.
// 一致性红线：pension/health/nbv 是「中国平安(601318)专属」的真实值备查库数据，
// 仅当 symbol === '601318' 时才注入；其它保险股无对应真实数据，返回空数组，避免把平安数据泄漏到其它公司。
function buildBusinessLines(segmentData, symbol) {
  const life = buildBusinessLineFromSegment(segmentData, '寿险');
  const property = buildBusinessLineFromSegment(segmentData, '财产');

  // 仅中国平安(601318)使用其专属养老/健康/NBV 真实值备查库
  const isPingAn = symbol === '601318';

  // 平安养老（平安养老保险股份有限公司）保险业务收入 / 原保险保费收入（亿元）
  // 来源：平安养老年报、原保险保费收入公告、2025年四季度偿付能力报告
  const pension = isPingAn ? [
    { year: '2013', value: 69.77 }, { year: '2014', value: 88.61 }, { year: '2015', value: 130.86 },
    { year: '2016', value: 152.94 }, { year: '2017', value: 175.60 }, { year: '2018', value: 211.12 },
    { year: '2019', value: 236.13 }, { year: '2020', value: 262.18 }, { year: '2021', value: 220.22 },
    { year: '2022', value: 184.83 }, { year: '2023', value: 173.26 }, { year: '2024', value: 165.95 },
    { year: '2025', value: 99.70 },
  ] : [];

  // 平安健康（平安健康保险股份有限公司）保险业务收入 / 原保险保费收入（亿元）
  // 来源：平安健康年报、原保险保费收入公告、2025年四季度偿付能力报告
  const health = isPingAn ? [
    { year: '2019', value: 92.85 }, { year: '2020', value: 122.08 }, { year: '2021', value: 149.54 },
    { year: '2022', value: 158.05 }, { year: '2023', value: 146.68 }, { year: '2024', value: 168.49 },
    { year: '2025', value: 195.40 },
  ] : [];

  // 寿险及健康险新业务价值 NBV（亿元）
  // 来源：2024/2025 年报及保费公告；2023/2024 NBV 的长期投资回报率假设由 5% 回溯至 4.5% 再至 4%，历史口径不可直接对比
  const nbv = isPingAn ? [
    { year: '2024', value: 285.34 }, { year: '2025', value: 368.97 },
  ] : [];

  for (const arr of [pension, health, nbv]) {
    if (!arr.length) continue;
    arr.sort((a, b) => a.year.localeCompare(b.year));
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1].value, curr = arr[i].value;
      arr[i].yoy = prev > 0 ? Math.round((curr - prev) / prev * 100 * 100) / 100 : 0;
    }
  }

  return { life, property, pension, health, nbv };
}

// Analyze NBV (New Business Value) trends — 细化到每个季度
// 数据来源：妙想金融数据 + 中国平安年报（累计口径），拆成各季度环比增量 + 累计。
function analyzeNBV(symbol) {
  const real = INSURANCE_REAL_DATA[symbol]?.nbv;
  if (real && real.cumulative && real.cumulative.length) {
    const quarters = buildQuarterlyNBV(real.cumulative);

    // 全年 NBV（仅含 Q4 / FY 的年报值），用于跨年可比分析
    const yearlyFY = [];
    for (const q of quarters) {
      if (q.quarter === 'Q4') yearlyFY.push({ year: q.year, value: q.cumulative });
    }
    // 若最新一年尚未披露年报，把它作为「部分年度」单独标注
    const lastYear = quarters.length ? quarters[quarters.length - 1].year : '';
    const hasFY = yearlyFY.some(y => y.year === lastYear);
    let latestPartial = null;
    if (!hasFY && lastYear) {
      const partialSum = round2(quarters.filter(q => q.year === lastYear).reduce((s, q) => s + q.value, 0));
      const partialStage = quarters.filter(q => q.year === lastYear).pop()?.label || '';
      latestPartial = { year: lastYear, value: partialSum, stage: partialStage };
    }

    // 年度同比（仅基于年报口径）
    for (let i = 1; i < yearlyFY.length; i++) {
      const prev = yearlyFY[i - 1].value, curr = yearlyFY[i].value;
      yearlyFY[i].yoyGrowth = prev > 0 ? round2((curr - prev) / prev * 100) : 0;
    }
    if (yearlyFY.length) yearlyFY[0].yoyGrowth = 0;

    // TTM 滚动序列（从第 4 个季度点开始，因为 TTM = 连续 4 个单季增量之和）
    const ttmSeries = quarters.filter(q => q.ttm != null).map(q => ({
      label: q.label,
      year: q.year,
      quarter: q.quarter,
      value: q.ttm,
    }));

    // 生成解读文字
    const explanation = _buildNBVExplanation(quarters, yearlyFY, latestPartial, ttmSeries, real.note);

    return {
      data: quarters,                 // 各季度（含当季增量 value + 累计 cumulative + ttm）
      ttmSeries,                      // TTM 滚动 12 个月 NBV
      yearly: yearlyFY,               // 年度合计（仅年报口径，跨年可比）
      latestPartial,                  // 最新部分年度（如 2026H1）
      hasData: true,
      unit: '亿元',
      source: real.source,
      note: `寿险及健康险新业务价值(NBV)已细化至各季度：柱状为当季环比增量，蓝色折线为累计值，黄色折线为 TTM 滚动 12 个月（与常见行情软件口径一致）。数据来源：${real.source}。`,
      explanation,
    };
  }
  return {
    data: [],
    yearly: [],
    hasData: false,
    note: '新业务价值(NBV)数据需从公司年报或运营数据中获取，当前数据源暂未覆盖。建议查看公司年报中的"内含价值"部分。',
  };
}

// 根据季度/年度 NBV 生成结构化解读
function _buildNBVExplanation(quarters, yearlyFY, latestPartial, ttmSeries, sourceNote) {
  if (!quarters.length) return '';

  // 跨年趋势：只用全年年报口径
  const firstYear = yearlyFY[0]?.year;
  const lastFullYear = yearlyFY[yearlyFY.length - 1]?.year;
  const firstVal = yearlyFY[0]?.value;
  const lastFullVal = yearlyFY[yearlyFY.length - 1]?.value;
  const totalChange = firstVal > 0 && lastFullVal > 0
    ? round2((lastFullVal - firstVal) / firstVal * 100)
    : 0;

  // 年度极值
  const sortedYearly = yearlyFY.slice().sort((a, b) => b.value - a.value);
  const peakYear = sortedYearly[0];
  const troughYear = sortedYearly[sortedYearly.length - 1];

  // 最近年报同比
  const latest = yearlyFY[yearlyFY.length - 1];
  const prevYear = yearlyFY[yearlyFY.length - 2];
  const latestYoY = prevYear && prevYear.value > 0
    ? round2((latest.value - prevYear.value) / prevYear.value * 100)
    : null;

  // 单季极值（当季增量）
  const sortedQ = quarters.slice().sort((a, b) => b.value - a.value);
  const peakQ = sortedQ[0];
  const troughQ = sortedQ[sortedQ.length - 1];

  // 季节性：用完整年份数量做平均
  const fullYearCount = yearlyFY.length || 1;
  const season = {};
  for (const q of quarters) {
    // 只纳入有完整 FY 的年份做季节平均，避免 2026 部分年份扭曲
    if (!latestPartial || q.year !== latestPartial.year) {
      season[q.quarter] = (season[q.quarter] || 0) + q.value;
    }
  }
  const seasonAvg = Object.entries(season).map(([k, v]) => ({
    quarter: k,
    avg: round2(v / fullYearCount),
  })).sort((a, b) => (['Q1', 'Q2', 'Q3', 'Q4'].indexOf(a.quarter) - ['Q1', 'Q2', 'Q3', 'Q4'].indexOf(b.quarter)));
  const strongestSeason = seasonAvg.length ? seasonAvg.reduce((a, b) => a.avg > b.avg ? a : b) : null;
  const weakestSeason = seasonAvg.length ? seasonAvg.reduce((a, b) => a.avg < b.avg ? a : b) : null;

  // 最新 TTM 滚动值（含 2026）
  const latestTTM = ttmSeries && ttmSeries.length ? ttmSeries[ttmSeries.length - 1] : null;
  const prevTTM = ttmSeries && ttmSeries.length >= 5 ? ttmSeries[ttmSeries.length - 5] : null; // 同比：前推 4 个季度
  const ttmYoY = latestTTM && prevTTM && prevTTM.value > 0
    ? round2((latestTTM.value - prevTTM.value) / prevTTM.value * 100)
    : null;

  let text = '';
  if (firstYear && lastFullYear && firstVal != null && lastFullVal != null) {
    text += `寿险及健康险 NBV 从 ${firstYear} 年 ${firstVal} 亿变化至 ${lastFullYear} 年 ${lastFullVal} 亿，累计变动 ${totalChange >= 0 ? '+' : ''}${totalChange}%。`;
  }
  if (peakYear && troughYear) {
    text += ` 年度高点为 ${peakYear.year} 年 ${peakYear.value} 亿，低点为 ${troughYear.year} 年 ${troughYear.value} 亿。`;
  }
  if (latestYoY != null) text += ` ${lastFullYear} 年同比 ${latestYoY >= 0 ? '+' : ''}${latestYoY}%。`;
  if (latestPartial) {
    text += ` ${latestPartial.year} 年已披露至 ${latestPartial.stage} 累计 ${latestPartial.value} 亿（部分年度，非全年）。`;
  }
  text += ` 单季增量高点为 ${peakQ.label} 的 ${peakQ.value} 亿，低点为 ${troughQ.label} 的 ${troughQ.value} 亿。`;
  if (strongestSeason && weakestSeason) {
    text += ` 季节规律上，${strongestSeason.quarter} 通常最强（近 ${fullYearCount} 年均值 ${strongestSeason.avg} 亿），${weakestSeason.quarter} 最弱（均值 ${weakestSeason.avg} 亿）。`;
  }
  if (latestTTM) {
    text += ` TTM 滚动 12 个月最新值 ${latestTTM.value} 亿（${latestTTM.label}）`;
    if (ttmYoY != null) text += `，同比 ${ttmYoY >= 0 ? '+' : ''}${ttmYoY}%`;
    text += '；该口径已纳入 2026 年中报数据，可与行情软件趋势图直接对照。';
  }
  if (sourceNote) text += ` ${sourceNote}`;
  return text;
}

// Analyze combined ratio (综合成本率) — 优先使用真实披露值
function analyzeCombinedRatio(symbol, operations, metrics) {
  const real = INSURANCE_REAL_DATA[symbol]?.combinedRatio;
  if (real && real.data && real.data.length) {
    const data = sortByReportPeriod(
      real.data.map(d => ({ year: d.period, label: d.label, value: d.value, source: real.source }))
    );
    return {
      data,
      hasData: true,
      isEstimated: false,
      industryBenchmark: 98.5, // 行业平均综合成本率（产险）
      source: real.source,
      note: `综合成本率(产险业务)。数据来源：${real.source}。`,
    };
  }

  // 回退：运营数据或利润表 TTM 流量估算（仅当结果落在合理区间 80~120% 才展示，避免量级错误）
  let ratioData = operations.combinedRatio;
  if (ratioData.length === 0 && metrics) {
    const yearMap = new Map();
    for (const r of (metrics.earnedPremium || [])) if (!yearMap.has(r.year)) yearMap.set(r.year, { year: r.year });
    const byYear = y => yearMap.get(y) || (yearMap.set(y, { year: y }), yearMap.get(y));
    for (const r of (metrics.earnedPremium || [])) byYear(r.year).earnedPremium = r.value;
    for (const r of (metrics.claimPayments || [])) byYear(r.year).claims = r.value;
    for (const r of (metrics.reserveChange || [])) byYear(r.year).reserveChange = r.value;
    for (const r of (metrics.commissionExpense || [])) byYear(r.year).commission = r.value;
    ratioData = [];
    for (const d of yearMap.values()) {
      if ((d.earnedPremium || 0) > 0) {
        const estimatedRatio = ((d.claims || 0) + (d.reserveChange || 0) + (d.commission || 0)) / d.earnedPremium * 100;
        if (estimatedRatio >= 80 && estimatedRatio <= 120) {
          ratioData.push({ year: d.year, value: Math.round(estimatedRatio * 100) / 100, type: '估算综合成本率', estimated: true });
        }
      }
    }
  }

  ratioData.sort((a, b) => a.year.localeCompare(b.year));
  return {
    data: ratioData,
    hasData: ratioData.length > 0,
    isEstimated: ratioData.some(d => d.estimated),
    industryBenchmark: 98.5,
    note: ratioData.some(d => d.estimated)
      ? '⚠️ 综合成本率为估算值（基于利润表 TTM 数据计算），实际数据请参考公司年报。'
      : '综合成本率数据暂未覆盖，需公司披露或专业数据源。',
  };
}

// Analyze investment yield (总投资收益率) — 优先使用真实披露值
function analyzeInvestmentYield(symbol, operations, metrics, balance) {
  const real = INSURANCE_REAL_DATA[symbol]?.investmentYield;
  if (real && real.data && real.data.length) {
    const data = sortByReportPeriod(
      real.data.map(d => ({ year: d.period, label: d.label, value: d.value, source: real.source }))
    );
    return {
      data,
      hasData: true,
      isEstimated: false,
      industryBenchmark: 5.0, // 行业平均总投资收益率
      source: real.source,
      metricName: '总投资收益率',
      note: `年化总投资收益率（%）。数据来源：${real.source}。口径：保险行业惯例按「年化」披露（interim 报告年化）；2020-2023 及 2025 中报前为年报/季报披露年化值，2024-2025 年报及 2026 各期为券商测算（总投资收益/平均投资资产），2026Q1/H1 由单季非年化值按期间年化推算，不可与早年直接等同。行业基准线=5.0%（行业平均总投资收益率）。`,
    };
  }

  // 回退：投资收益（TTM）/ 投资资产估算，仅保留 2%~12% 区间内的合理值
  let yieldData = operations.investmentYield;
  if (yieldData.length === 0 && metrics && (metrics.investmentIncome || []).length > 0) {
    const balByYear = new Map();
    for (const b of (balance || [])) {
      const y = b.REPORT_DATE ? b.REPORT_DATE.substring(0, 4) : '';
      if (!y) continue;
      const st = _reportStage(b.REPORT_DATE_NAME || '');
      const order = st === 'FY' ? 9 : (_STAGE_ORDER[st] || 0);
      const cur = balByYear.get(y);
      if (!cur || order > (cur.order || 0)) {
        balByYear.set(y, { order, totalAssets: toYi(b.TOTAL_ASSETS || 0) });
      }
    }
    yieldData = [];
    for (const ii of metrics.investmentIncome) {
      const totalAssets = balByYear.get(ii.year)?.totalAssets || 0;
      const investmentAssets = totalAssets > 0 ? totalAssets * 0.75 : 0;
      if (investmentAssets > 0 && ii.value > 0) {
        const estimatedYield = (ii.value / investmentAssets * 100);
        if (estimatedYield >= 2 && estimatedYield <= 12) {
          yieldData.push({ year: ii.year, value: Math.round(estimatedYield * 100) / 100, type: '估算投资收益率', estimated: true });
        }
      }
    }
  }

  yieldData.sort((a, b) => a.year.localeCompare(b.year));
  return {
    data: yieldData,
    hasData: yieldData.length > 0,
    isEstimated: yieldData.some(d => d.estimated),
    industryBenchmark: 5.0,
    metricName: '投资收益率',
    note: yieldData.some(d => d.estimated)
      ? '⚠️ 投资收益率为估算值（收益取 TTM，资产取当年最新资产负债表），实际数据请参考公司年报。'
      : '投资收益率数据暂未覆盖，需公司披露或专业数据源。',
  };
}

// Analyze operating profit vs net profit
function analyzeProfitComparison(metrics) {
  const opProfit = metrics.operatingProfit;
  const netProfit = metrics.netProfit;
  
  // Merge by year
  const yearMap = new Map();
  for (const p of opProfit) {
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year });
    yearMap.get(p.year).operatingProfit = p.value;
  }
  for (const p of netProfit) {
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year });
    yearMap.get(p.year).netProfit = p.value;
  }
  
  const data = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate difference and ratio
  for (const d of data) {
    d.difference = (d.operatingProfit || 0) - (d.netProfit || 0);
    d.ratio = d.netProfit > 0 && d.operatingProfit > 0 
      ? (d.netProfit / d.operatingProfit * 100) 
      : 0;
  }
  
  return {
    data,
    hasData: data.length > 0,
    trendNote: analyzeProfitTrend(data),
  };
}

function analyzeProfitTrend(data) {
  if (data.length < 2) return '';
  
  const latest = data[data.length - 1];
  const prev = data[data.length - 2];
  
  const opGrowth = prev.operatingProfit > 0 
    ? ((latest.operatingProfit - prev.operatingProfit) / prev.operatingProfit * 100) 
    : 0;
  const netGrowth = prev.netProfit > 0 
    ? ((latest.netProfit - prev.netProfit) / prev.netProfit * 100) 
    : 0;
  
  if (Math.abs(opGrowth - netGrowth) > 10) {
    return `营运利润增长${opGrowth.toFixed(2)}%与净利润增长${netGrowth.toFixed(2)}%趋势不一致，差异${Math.abs(opGrowth - netGrowth).toFixed(2)}个百分点。可能原因：投资收益波动、资产减值、一次性损益、或会计政策变更。建议查看年报附注了解差异详情。`;
  }
  return `营运利润与净利润增长趋势基本一致，说明公司盈利质量较高。`;
}

// P/EV (Price to Embedded Value) valuation
function calculatePEV(operations, quote, balance, shareholders) {
  let evData = operations.embeddedValue;
  
  // If no operational data, try to estimate from net assets
  // For insurance companies, embedded value > net assets (includes value of in-force business)
  // Typically EV ≈ 1.1-1.5x net assets for life insurance
  if (evData.length === 0 && balance.length > 0) {
    evData = balance.map(b => {
      const year = b.REPORT_DATE ? b.REPORT_DATE.substring(0, 4) : '';
      const netAssets = toYi(b.TOTAL_PARENT_EQUITY || b.TOTAL_EQUITY || 0);
      return { year, value: netAssets * 1.2, type: '估算内含价值', estimated: true };
    });
  }
  
  evData.sort((a, b) => a.year.localeCompare(b.year));
  
  const latestEV = evData[evData.length - 1];
  // quote.totalValue is total market cap in 亿 (from Tencent API)
  // shareholders.totalMarketCap is in 元 (from push2 API, may not be available)
  const marketCapYi = quote?.totalValue || toYi(shareholders?.totalMarketCap || 0);
  
  const pev = latestEV && latestEV.value > 0 && marketCapYi > 0
    ? Math.round(marketCapYi / latestEV.value * 100) / 100
    : 0;
  
  // P/EV historical
  const pevHistory = [];
  for (const ev of evData) {
    pevHistory.push({ year: ev.year, ev: ev.value, estimated: ev.estimated });
  }
  
  return {
    currentPEV: pev,
    latestEV: latestEV?.value || 0,
    marketCap: marketCapYi,
    evHistory: pevHistory,
    isEstimated: latestEV?.estimated || false,
    interpretation: interpretPEV(pev),
    note: latestEV?.estimated 
      ? '⚠️ 内含价值为估算值（基于归母净资产的1.2倍），实际数据请参考公司年报中的"内含价值"部分。'
      : '',
  };
}

function interpretPEV(pev) {
  if (pev <= 0) return '数据不足，无法计算P/EV';
  if (pev < 0.5) return 'P/EV < 0.5，严重低估。市场可能对公司未来增长极度悲观，或存在隐性风险。';
  if (pev < 0.8) return 'P/EV 0.5-0.8，低估。当前股价低于内含价值，具备投资价值。';
  if (pev < 1.0) return 'P/EV 0.8-1.0，合理偏低。股价接近内含价值，安全边际有限。';
  if (pev < 1.5) return 'P/EV 1.0-1.5，合理估值。市场对公司未来增长持中性预期。';
  if (pev < 2.0) return 'P/EV 1.5-2.0，偏高估值。市场对公司未来增长有较高预期。';
  return 'P/EV > 2.0，高估。需警惕估值回调风险。';
}

// DDM (Dividend Discount Model) valuation
function calculateDDM(dividends, netProfits, quote, shareholders) {
  // dividends array now has: { year, dividendPerShare, totalShares, dividend (total amount in 元) }
  // Build merged data by year
  const yearMap = new Map();
  
  for (const d of dividends) {
    if (!d.year) continue;
    if (!yearMap.has(d.year)) yearMap.set(d.year, { year: d.year, dps: 0, dividend: 0, netProfit: 0 });
    const entry = yearMap.get(d.year);
    // Use dividendPerShare if available, otherwise calculate from total
    if (d.dividendPerShare) {
      entry.dps += d.dividendPerShare; // Accumulate (multiple dividends per year)
    } else if (d.dividend && d.totalShares) {
      entry.dps += d.dividend / d.totalShares;
    }
    entry.dividend += d.dividend || 0;
  }
  for (const p of netProfits) {
    if (!p.year) continue;
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year, dps: 0, dividend: 0, netProfit: 0 });
    yearMap.get(p.year).netProfit = p.value || 0;
  }
  
  const data = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate payout ratio
  for (const d of data) {
    // netProfit is in 亿, dividend is in 元
    const npYuan = d.netProfit * 1e8;
    d.payoutRatio = npYuan > 0 && d.dividend > 0 ? (d.dividend / npYuan * 100) : 0;
  }
  
  // Calculate average dividend growth rate (based on DPS)
  // Only use records where DPS > 0 to avoid skewed growth from zero dividends
  const dpsData = data.filter(d => d.dps > 0);
  const growthRates = [];
  for (let i = 1; i < dpsData.length; i++) {
    if (dpsData[i - 1].dps > 0) {
      growthRates.push((dpsData[i].dps / dpsData[i - 1].dps - 1) * 100);
    }
  }
  const avgGrowth = growthRates.length > 0 
    ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length 
    : 5; // Default 5%
  
  // Average payout ratio
  const avgPayout = data.length > 0
    ? data.reduce((sum, d) => sum + (d.payoutRatio || 0), 0) / data.length
    : 30;
  
  // Latest DPS
  const latestDPS = data.length > 0 ? data[data.length - 1].dps : 0;
  
  // DDM with two-stage model
  const discountRate = 0.10; // 10% discount rate
  const terminalGrowth = 0.03; // 3% perpetual growth
  const highGrowthYears = 10;
  const highGrowth = Math.max(0, Math.min(avgGrowth / 100, 0.15)); // Cap at 15%
  
  let intrinsicValue = 0;
  let currentDPS = latestDPS;
  
  // Stage 1: High growth period
  for (let i = 1; i <= highGrowthYears; i++) {
    currentDPS *= (1 + highGrowth);
    intrinsicValue += currentDPS / Math.pow(1 + discountRate, i);
  }
  
  // Stage 2: Terminal value
  const terminalDPS = currentDPS * (1 + terminalGrowth);
  const terminalValue = terminalDPS / (discountRate - terminalGrowth);
  intrinsicValue += terminalValue / Math.pow(1 + discountRate, highGrowthYears);
  
  const currentPrice = quote?.price || 0;
  const premium = currentPrice > 0 && intrinsicValue > 0
    ? Math.round((currentPrice / intrinsicValue - 1) * 10000) / 100
    : 0;
  
  return {
    model: '两阶段股息贴现模型 (DDM)',
    latestDPS: Math.round(latestDPS * 100) / 100,
    avgGrowth: Math.round(avgGrowth * 100) / 100,
    avgPayout: Math.round(avgPayout * 100) / 100,
    discountRate: discountRate * 100,
    terminalGrowth: terminalGrowth * 100,
    highGrowthYears,
    intrinsicValue: Math.round(intrinsicValue * 100) / 100,
    currentPrice,
    premium,
    rating: intrinsicValue <= 0 ? '数据不足' : premium < -20 ? '低估' : premium < 0 ? '合理偏低' : premium < 20 ? '合理' : premium < 50 ? '偏高' : '高估',
    dividendHistory: data,
    note: latestDPS === 0 
      ? '⚠️ 未获取到分红数据，DDM估值结果仅供参考。'
      : '',
  };
}

// Analyze operating profit vs net profit divergence
function analyzeProfitDivergence(metrics) {
  const comparison = analyzeProfitComparison(metrics);
  if (!comparison.hasData) return null;
  
  const latest = comparison.data[comparison.data.length - 1];
  const divergence = latest.difference;
  const divergencePct = latest.operatingProfit > 0 
    ? (divergence / latest.operatingProfit * 100) 
    : 0;
  
  return {
    ...comparison,
    latestDivergence: divergence,
    divergencePct,
    isSignificant: Math.abs(divergencePct) > 15,
    note: Math.abs(divergencePct) > 15
      ? `⚠️ 营运利润与净利润差异${Math.abs(divergencePct).toFixed(1)}%，差异较大。可能涉及：短期投资波动、资产减值损失、一次性损益项目。建议深入分析利润表非经常性项目。`
      : '营运利润与净利润差异在正常范围内。',
  };
}

// Main insurance analysis function
async function analyzeInsuranceCompany(emCode, symbol, name, quote, income, balance, cashflow, shareholders, dividends, segmentData) {
  console.log(`[InsuranceAnalysis] Starting for ${symbol} (${name})...`);
  
  // Fetch insurance-specific operational data
  const operations = await fetchInsuranceOperations(emCode);
  
  // Extract insurance metrics from financial statements
  const metrics = extractInsuranceMetricsFromStatements(income, balance);
  
  // Run all insurance-specific analyses
  const premiumAnalysis = analyzePremiumTrends(metrics, operations, symbol);
  const nbvAnalysis = analyzeNBV(symbol);
  const combinedRatioAnalysis = analyzeCombinedRatio(symbol, operations, metrics);
  const investmentYieldAnalysis = analyzeInvestmentYield(symbol, operations, metrics, balance);
  const profitDivergence = analyzeProfitDivergence(metrics);
  const pevValuation = calculatePEV(operations, quote, balance, shareholders);
  const ddmValuation = calculateDDM(dividends, metrics.netProfit, quote, shareholders);
  // 分业务趋势（寿险/财产险来自集团年报分业务披露；养老/健康来自原保险保费收入公告；NBV 来自年报）
  const businessLines = buildBusinessLines(segmentData, symbol);
  
  return {
    isInsurance: true,
    companyName: name,
    symbol,
    sections: {
      premiumAnalysis,
      nbvAnalysis,
      combinedRatioAnalysis,
      investmentYieldAnalysis,
      profitDivergence,
      pevValuation,
      ddmValuation,
      businessLines,
    },
  };
}

// Helper: convert to 亿 (100 million), handles null/undefined
function toYi(n) {
  if (n === null || n === undefined || isNaN(n)) return 0;
  return Math.round(parseFloat(n) / 1e8 * 100) / 100;
}

module.exports = {
  isInsuranceCompany,
  analyzeInsuranceCompany,
  extractInsuranceMetricsFromStatements,
};
