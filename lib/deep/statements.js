/**
 * lib/deep/statements.js —— deepAnalysis 领域子模块：三表分析（营收成本/资产负债/现金流）+ 估值/成长/DCF
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 注意：analyzeValuation 内部局部函数 calcStats 与 shared._calcStats 是两个独立实现，严禁合并（设计差异点 D5）。
 */
const { toYi, _stmtStage } = require('./shared');

const _STAGE_ORDER = { Q1: 1, H1: 2, Q3: 3 };

// 按中国财报累计值口径，从利润表计算最新一期归母净利润 TTM
// 例如最新为 2025 三季报（1-9月累计），则 TTM = 2025Q3 + 2024FY - 2024Q3
function _calcTtmProfit(income) {
  if (!income || income.length === 0) return 0;
  const sorted = [...income].sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')));
  const latest = sorted[sorted.length - 1];
  const latestProfit = Number(latest.PARENT_NETPROFIT) || 0;
  const st = _stmtStage(latest.REPORT_DATE_NAME || '');
  if (!st || st === 'FY') return latestProfit;
  const latestYear = String(latest.REPORT_DATE || '').slice(0, 4);
  if (!latestYear) return latestProfit;
  const prevYear = String(Number(latestYear) - 1);
  const prevSame = sorted.find(r => String(r.REPORT_DATE || '').startsWith(prevYear) && _stmtStage(r.REPORT_DATE_NAME || '') === st);
  const prevFY = sorted.find(r => String(r.REPORT_DATE || '').startsWith(prevYear) && _stmtStage(r.REPORT_DATE_NAME || '') === 'FY');
  if (!prevSame || !prevFY) return latestProfit;
  return latestProfit + (Number(prevFY.PARENT_NETPROFIT) || 0) - (Number(prevSame.PARENT_NETPROFIT) || 0);
}

// 抽取单条利润表的流量指标（用于 TTM 还原），单位：亿元
function _stmtFlow(r) {
  return {
    revenue: toYi(r.TOTAL_OPERATE_INCOME),
    cost: toYi(r.TOTAL_OPERATE_COST),
    operatingCost: toYi(r.OPERATE_COST),
    netProfit: toYi(r.PARENT_NETPROFIT),
    operatingProfit: toYi(r.OPERATE_PROFIT),
    saleExpense: toYi(r.SALE_EXPENSE),
    manageExpense: toYi(r.MANAGE_EXPENSE),
    researchExpense: toYi(r.RESEARCH_EXPENSE),
    financeExpense: toYi(r.FINANCE_EXPENSE),
  };
}

// 单条利润表 → 营收成本趋势条目
function _mapRevenueCost(r, year, opts) {
  opts = opts || {};
  const f = _stmtFlow(r);
  const revenue = opts.revenue != null ? opts.revenue : f.revenue;
  const cost = opts.cost != null ? opts.cost : f.cost;
  const operatingCost = opts.operatingCost != null ? opts.operatingCost : f.operatingCost;
  const netProfit = opts.netProfit != null ? opts.netProfit : f.netProfit;
  const operatingProfit = opts.operatingProfit != null ? opts.operatingProfit : f.operatingProfit;
  const saleExpense = opts.saleExpense != null ? opts.saleExpense : f.saleExpense;
  const manageExpense = opts.manageExpense != null ? opts.manageExpense : f.manageExpense;
  const researchExpense = opts.researchExpense != null ? opts.researchExpense : f.researchExpense;
  const financeExpense = opts.financeExpense != null ? opts.financeExpense : f.financeExpense;
  const grossMargin = operatingCost > 0 && revenue > 0 ? Math.round((1 - operatingCost / revenue) * 10000) / 100 : 0;
  const netMargin = revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : 0;
  return {
    year,
    revenue, cost, operatingCost, netProfit, operatingProfit,
    grossMargin, netMargin,
    revenueYoy: opts.ttm ? null : (r.TOTAL_OPERATE_INCOME_YOY || 0),
    profitYoy: opts.ttm ? null : (r.PARENT_NETPROFIT_YOY || 0),
    saleExpense,
    manageExpense,
    researchExpense,
    financeExpense,
    eps: r.BASIC_EPS || 0,
    ttm: !!opts.ttm,
  };
}

// 营收与成本趋势：按年分组，优先采用「年报」；若某年（如 2026）尚未披露年报但有
// 最新一期报告（中报/一季报），则采用 TTM 滚动累计还原该年（当年部分 + 上年剩余季度）。
function analyzeRevenueCost(income) {
  if (!income || !income.length) return [];
  const byYear = {};
  for (const r of income) {
    const y = r.REPORT_DATE
      ? r.REPORT_DATE.slice(0, 4)
      : (r.REPORT_DATE_NAME ? r.REPORT_DATE_NAME.replace(/年报|一季报|中报|三季报/g, '') : '');
    if (!y) continue;
    const st = _stmtStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = [];
  let prev = { fy: null, partials: {} };
  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      rec = _mapRevenueCost(g.annual, y, {});
    } else {
      // 取最新一期非年报
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prev.fy && prev.partials[bestStage]) {
        const cur = _stmtFlow(bestRec);
        const pf = prev.fy, ps = prev.partials[bestStage];
        const ttm = {
          revenue: Math.round((cur.revenue + (pf.revenue - ps.revenue)) * 100) / 100,
          cost: Math.round((cur.cost + (pf.cost - ps.cost)) * 100) / 100,
          operatingCost: Math.round((cur.operatingCost + (pf.operatingCost - ps.operatingCost)) * 100) / 100,
          netProfit: Math.round((cur.netProfit + (pf.netProfit - ps.netProfit)) * 100) / 100,
          operatingProfit: Math.round((cur.operatingProfit + (pf.operatingProfit - ps.operatingProfit)) * 100) / 100,
          saleExpense: Math.round((cur.saleExpense + (pf.saleExpense - ps.saleExpense)) * 100) / 100,
          manageExpense: Math.round((cur.manageExpense + (pf.manageExpense - ps.manageExpense)) * 100) / 100,
          researchExpense: Math.round((cur.researchExpense + (pf.researchExpense - ps.researchExpense)) * 100) / 100,
          financeExpense: Math.round((cur.financeExpense + (pf.financeExpense - ps.financeExpense)) * 100) / 100,
        };
        rec = _mapRevenueCost(bestRec, y, { ...ttm, ttm: true });
      } else if (bestRec) {
        rec = _mapRevenueCost(bestRec, y, { ttm: true });
      }
    }
    if (rec) result.push(rec);
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) thisPartials[s] = _stmtFlow(g.partials[s]);
    prev = { fy: g.annual ? _stmtFlow(g.annual) : prev.fy, partials: thisPartials };
  }
  return result;
}

// Compute balance sheet analysis (Section 6, 7, 8)
function analyzeBalanceSheet(balance) {
  if (balance.length === 0) return null;
  const latest = balance[balance.length - 1];
  
  // Short-term financial risk (Section 6)
  const shortTermRisk = {
    cash: toYi(latest.MONETARYFUNDS),
    shortTermInvestments: toYi(latest.TRADE_FINASSET_NOTFVTPL || latest.BUY_RESALE_FINASSET || 0),
    shortTermDebt: toYi(latest.SHORT_LOAN || 0),
    accountsPayable: toYi(latest.ACCOUNTS_PAYABLE || 0),
  };

  // Asset composition (Section 7)
  const assetItems = [
    { name: '货币资金', value: toYi(latest.MONETARYFUNDS) },
    { name: '存货', value: toYi(latest.INVENTORY) },
    { name: '固定资产', value: toYi(latest.FIXED_ASSET) },
    { name: '无形资产', value: toYi(latest.INTANGIBLE_ASSET) },
    { name: '应收账款', value: toYi(latest.ACCOUNTS_RECE) },
    { name: '预付款项', value: toYi(latest.PREPAYMENT) },
    { name: '其他流动资产', value: toYi(latest.OTHER_CURRENT_ASSET) },
    { name: '递延所得税资产', value: toYi(latest.DEFER_TAX_ASSET) },
    { name: '在建工程', value: toYi(latest.CIP) },
    { name: '商誉', value: toYi(latest.GOODWILL) },
    { name: '发放贷款及垫款', value: toYi(latest.LEND_FUND) },
    { name: '其他非流动金融资产', value: toYi(latest.OTHER_NONCURRENT_FINASSET) },
  ].filter(a => a.value > 0).sort((a, b) => b.value - a.value);

  // Liability composition (Section 8)
  const liabilityItems = [
    { name: '应付账款', value: toYi(latest.ACCOUNTS_PAYABLE) },
    { name: '合同负债', value: toYi(latest.CONTRACT_LIAB) },
    { name: '应交税费', value: toYi(latest.TAX_PAYABLE) },
    { name: '应付职工薪酬', value: toYi(latest.STAFF_SALARY_PAYABLE) },
    { name: '其他应付款', value: toYi(latest.TOTAL_OTHER_PAYABLE) },
    { name: '短期借款', value: toYi(latest.SHORT_LOAN) },
    { name: '租赁负债', value: toYi(latest.LEASE_LIAB) },
    { name: '其他流动负债', value: toYi(latest.OTHER_CURRENT_LIAB) },
    { name: '递延所得税负债', value: toYi(latest.DEFER_TAX_LIAB) },
    { name: '长期借款', value: toYi(latest.LONG_LOAN) },
    { name: '应付债券', value: toYi(latest.BOND_PAYABLE) },
    { name: '吸收存款及同业存放', value: toYi(latest.ACCEPT_DEPOSIT_INTERBANK) },
  ].filter(l => l.value > 0).sort((a, b) => b.value - a.value);

  // Multi-year net assets
  const netAssetsTrend = balance.map(r => ({
    year: r.REPORT_DATE_NAME?.replace('年报', '') || r.REPORT_DATE?.slice(0, 4),
    totalAssets: toYi(r.TOTAL_ASSETS),
    totalLiabilities: toYi(r.TOTAL_LIABILITIES),
    netAssets: toYi(r.TOTAL_PARENT_EQUITY),
    inventory: toYi(r.INVENTORY),
    accountsPayable: toYi(r.ACCOUNTS_PAYABLE),
  }));

  return {
    shortTermRisk,
    assetComposition: assetItems,
    liabilityComposition: liabilityItems,
    totalAssets: toYi(latest.TOTAL_ASSETS),
    totalLiabilities: toYi(latest.TOTAL_LIABILITIES),
    netAssets: toYi(latest.TOTAL_PARENT_EQUITY),
    goodwill: toYi(latest.GOODWILL),
    netAssetsTrend,
  };
}

// Compute cash flow analysis (Section 9, 13)
// 现金流量表：按年分组，优先采用年报；若当年仅有部分报告，则做 TTM 滚动累计还原。
function _cfFlow(r) {
  return {
    operatingCashFlow: toYi(r.NETCASH_OPERATE),
    cashFromSales: toYi(r.SALES_SERVICES),
    dividends: toYi(r.ASSIGN_DIVIDEND_PORFIT),
  };
}
function analyzeCashFlow(cashflow, income, rcData) {
  if (!cashflow || !cashflow.length) return [];
  // 从已 TTM 还原的 revenueCostData 按年份取 netProfit / revenue，保证与营收趋势口径一致
  const rcByYear = {};
  if (rcData && rcData.length) {
    for (const r of rcData) rcByYear[r.year] = r;
  }
  const byYear = {};
  for (const r of cashflow) {
    const y = r.REPORT_DATE ? r.REPORT_DATE.slice(0, 4) : (r.REPORT_DATE_NAME ? r.REPORT_DATE_NAME.replace(/年报|一季报|中报|三季报/g, '') : '');
    if (!y) continue;
    const st = _stmtStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = [];
  let prev = { fy: null, partials: {} };
  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      const cf = _cfFlow(g.annual);
      const rc = rcByYear[y] || {};
      rec = { year: y, ...cf, netProfit: rc.netProfit != null ? rc.netProfit : toYi(g.annual.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(g.annual.TOTAL_OPERATE_INCOME), ttm: false };
    } else {
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prev.fy && prev.partials[bestStage]) {
        const cur = _cfFlow(bestRec);
        const pf = prev.fy, ps = prev.partials[bestStage];
        const ttm = {
          operatingCashFlow: Math.round((cur.operatingCashFlow + (pf.operatingCashFlow - ps.operatingCashFlow)) * 100) / 100,
          cashFromSales: Math.round((cur.cashFromSales + (pf.cashFromSales - ps.cashFromSales)) * 100) / 100,
          dividends: Math.round((cur.dividends + (pf.dividends - ps.dividends)) * 100) / 100,
        };
        const rc = rcByYear[y] || {};
        rec = { year: y, ...ttm, netProfit: rc.netProfit != null ? rc.netProfit : toYi(bestRec.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(bestRec.TOTAL_OPERATE_INCOME), ttm: true };
      } else if (bestRec) {
        const cur = _cfFlow(bestRec);
        const rc = rcByYear[y] || {};
        rec = { year: y, ...cur, netProfit: rc.netProfit != null ? rc.netProfit : toYi(bestRec.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(bestRec.TOTAL_OPERATE_INCOME), ttm: true };
      }
    }
    if (rec) result.push(rec);
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) thisPartials[s] = _cfFlow(g.partials[s]);
    prev = { fy: g.annual ? _cfFlow(g.annual) : prev.fy, partials: thisPartials };
  }
  return result;
}

// Compute valuation indicators (PE/PB/PS) over time (Section 19, 20, 21)
function analyzeValuation(financialData, quote, shareholders, emValuation) {
  const { income, balance } = financialData;
  // Try multiple sources for total shares
  const latestBalance = balance[balance.length - 1];
  const totalShares = shareholders?.totalShares || latestBalance?.SHARE_CAPITAL || quote?.fundamentals?.totalShares || quote?.totalShares || 0;
  const currentPrice = quote?.price || 0;
  
  // Build yearly valuation data（仅使用年报，避免部分报告期半年口径导致 PE/PB/PS 突兀跳变）
  let valuationData = [];
  for (const inc of income) {
    const st = _stmtStage(inc.REPORT_DATE_NAME || '');
    if (st && st !== 'FY') continue; // 跳过一季报/中报/三季报
    const year = inc.REPORT_DATE_NAME?.replace('年报', '') || inc.REPORT_DATE?.slice(0, 4);
    const bs = balance.find(b => b.REPORT_DATE === inc.REPORT_DATE);
    const netProfit = inc.PARENT_NETPROFIT || 0;
    const netAssets = bs?.TOTAL_PARENT_EQUITY || 0;
    const revenue = inc.TOTAL_OPERATE_INCOME || 0;
    const yearShares = bs?.SHARE_CAPITAL || totalShares;

    // Market cap = shares × current price (approximation)
    const marketCap = yearShares > 0 ? toYi(yearShares * currentPrice) : 0;

    const pe = netProfit > 0 && marketCap > 0 ? Math.round(marketCap / toYi(netProfit) * 100) / 100 : 0;
    const pb = netAssets > 0 && marketCap > 0 ? Math.round(marketCap / toYi(netAssets) * 100) / 100 : 0;
    const ps = revenue > 0 && marketCap > 0 ? Math.round(marketCap / toYi(revenue) * 100) / 100 : 0;

    valuationData.push({ year, pe, pb, ps, marketCap, netProfit: toYi(netProfit), netAssets: toYi(netAssets), revenue: toYi(revenue) });
  }

  // 优先采用东方财富 TTM 估值历史：用真实 TTM 口径替换历史 PE/PB/PS，并补充当年(2026)当前点
  // （原年报口径用「当年股份×当前价」算市值，历史 PE 失真；东财 TTM 为各年末真实市场估值）
  if (emValuation && Array.isArray(emValuation.series) && emValuation.series.length) {
    const baseByYear = {};
    for (const inc of income) {
      const st = _stmtStage(inc.REPORT_DATE_NAME || '');
      if (st && st !== 'FY') continue;
      const y = inc.REPORT_DATE_NAME?.replace('年报', '') || inc.REPORT_DATE?.slice(0, 4);
      baseByYear[y] = inc;
    }
    const balByReport = {};
    for (const b of (balance || [])) balByReport[b.REPORT_DATE] = b;

    // 为缺失年报数据的年份（尤其是当年当前点）回退到最近可用年报，
    // 保证 generateConclusion 计算每股指标时 eps/bvps/sps 不为 0。
    const yearsWithInc = Object.keys(baseByYear).sort();

    valuationData = emValuation.series.map((s) => {
      const y = s.year;
      let inc = baseByYear[y];
      let bs = inc ? balByReport[inc.REPORT_DATE] : null;
      if (!inc && yearsWithInc.length) {
        // 仅在「存在不晚于当前年的年报」时回退，避免把最新年份的财务数据错配到更早年份
        // （原逻辑 fallback 到 yearsWithInc 末位=最新年，会把 2025 财务数据复制到 2018-2021，造成图表年份错乱）
        const fallbackYear = yearsWithInc.filter(yy => yy <= y).pop();
        if (fallbackYear) {
          inc = baseByYear[fallbackYear];
          bs = inc ? balByReport[inc.REPORT_DATE] : null;
        }
        // 若 emValuation 的年份早于我们所有年报（如 2018-2020 不在 5 年回溯窗口内），
        // 则 inc 保持 null，netProfit/netAssets/revenue 为 null，后续 marketCapData 会按 revenue>0 过滤剔除，不展示错误数据。
      }
      const yearShares = bs?.SHARE_CAPITAL || totalShares;
      return {
        year: y,
        pe: s.pe, pb: s.pb, ps: s.ps,
        marketCap: s.marketCap != null ? s.marketCap : toYi(yearShares * currentPrice),
        netProfit: inc ? toYi(inc.PARENT_NETPROFIT) : null,
        netAssets: bs ? toYi(bs.TOTAL_PARENT_EQUITY) : null,
        revenue: inc ? toYi(inc.TOTAL_OPERATE_INCOME) : null,
        isCurrent: !!s.isCurrent,
        date: s.date,
      };
    });
  }

  // Calculate mean and std for each indicator
  function calcStats(arr) {
    const valid = arr.filter(v => v > 0);
    if (valid.length === 0) return { mean: 0, std: 0, high: 0, low: 0 };
    const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
    const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
    const std = Math.sqrt(variance);
    return { 
      mean: Math.round(mean * 100) / 100, 
      std: Math.round(std * 100) / 100, 
      high: Math.round((mean + std) * 100) / 100, 
      low: Math.round((mean - std) * 100) / 100 
    };
  }

  const peStats = calcStats(valuationData.map(v => v.pe));
  const pbStats = calcStats(valuationData.map(v => v.pb));
  const psStats = calcStats(valuationData.map(v => v.ps));

  // 当前 PE(TTM)：优先行情接口（腾讯/东财均为滚动 TTM 口径），
  // 用利润表最新一期做 TTM 滚动累计还原归母净利润，做交叉验证/兜底，
  // 避免估值分析停留在最近一个年报的静态 PE。
  const quotePe = (quote?.fundamentals?.pe > 0 ? quote.fundamentals.pe
    : (quote?.pe > 0 ? quote.pe : 0));
  const ttmNetProfitRaw = _calcTtmProfit(income);
  const ttmNetProfit = toYi(ttmNetProfitRaw);
  const ttmMarketCapYi = totalShares > 0 && currentPrice > 0 ? toYi(totalShares * currentPrice) : 0;
  const ttmPeComputed = ttmNetProfit > 0 && ttmMarketCapYi > 0
    ? Math.round(ttmMarketCapYi / ttmNetProfit * 100) / 100 : 0;

  let currentPeTtm = 0, peSource = '';
  if (quotePe > 0) {
    currentPeTtm = Math.round(quotePe * 100) / 100;
    peSource = quote?.fundamentals?.peSource || '行情数据(TTM)';
  } else if (ttmPeComputed > 0) {
    currentPeTtm = ttmPeComputed;
    peSource = '利润表TTM累计还原（行情PE缺失）';
  }
  // 东方财富 TTM 为估值分析主口径：当前 PE(TTM) 以其实时值覆盖，保证与序列末点一致
  if (emValuation && emValuation.latest && emValuation.latest.pe > 0) {
    currentPeTtm = Math.round(emValuation.latest.pe * 100) / 100;
    peSource = emValuation.source || '东方财富TTM';
  }

  return { valuationData, peStats, pbStats, psStats, currentPeTtm, peSource, ttmNetProfit, ttmMarketCap: ttmMarketCapYi };
}

// Compute growth rates from base year (Section 17)
function analyzeGrowth(revenueCostData) {
  if (revenueCostData.length < 2) return null;
  
  // Find 2020 as base year, or use earliest available
  const baseYear = revenueCostData.find(d => d.year === '2020') || revenueCostData[0];
  const latest = revenueCostData[revenueCostData.length - 1];
  
  const baseRevenue = baseYear.revenue || 1;
  const baseProfit = baseYear.netProfit || 1;
  
  return {
    baseYear: baseYear.year,
    latestYear: latest.year,
    revenueGrowth: baseRevenue > 0 ? Math.round((latest.revenue / baseRevenue - 1) * 10000) / 100 : 0,
    profitGrowth: baseProfit > 0 ? Math.round((latest.netProfit / baseProfit - 1) * 10000) / 100 : 0,
  };
}

// DCF Valuation (Section 23)
function calculateDCF(financialData, balance, quote, shareholders) {
  const { income, cashflow } = financialData;
  if (income.length === 0) return null;
  
  const discountRate = 0.08;
  const perpetualGrowth = 0.03;
  
  // Use average of recent 3 years FCF as base
  const recentFCF = cashflow.slice(-3).map(cf => cf.NETCASH_OPERATE || 0);
  const avgFCF = recentFCF.length > 0 ? recentFCF.reduce((s, v) => s + v, 0) / recentFCF.length : 0;
  
  if (avgFCF <= 0) return { error: '自由现金流为负，不适合DCF估值' };
  
  // Simple DCF: 10-year explicit + terminal value
  const projectedGrowth = 0.05; // Assume 5% growth for next 10 years
  let pvSum = 0;
  for (let i = 1; i <= 10; i++) {
    const fcf = avgFCF * Math.pow(1 + projectedGrowth, i);
    const pv = fcf / Math.pow(1 + discountRate, i);
    pvSum += pv;
  }
  
  // Terminal value
  const terminalFCF = avgFCF * Math.pow(1 + projectedGrowth, 10) * (1 + perpetualGrowth);
  const terminalValue = terminalFCF / (discountRate - perpetualGrowth);
  const terminalPV = terminalValue / Math.pow(1 + discountRate, 10);
  
  // Enterprise value
  const ev = pvSum + terminalPV;
  
  // Add cash, subtract debt
  const latestBalance = balance[balance.length - 1];
  const cash = latestBalance?.MONETARYFUNDS || 0;
  const shortTermDebt = latestBalance?.SHORT_LOAN || 0;
  const longTermDebt = latestBalance?.LONG_LOAN || 0;
  
  const equityValue = ev + cash - shortTermDebt - longTermDebt;
  const totalShares = shareholders?.totalShares || latestBalance?.SHARE_CAPITAL || quote?.fundamentals?.totalShares || 0;
  const perShareValue = totalShares > 0 ? equityValue / totalShares : 0;
  
  return {
    baseFCF: toYi(avgFCF),
    projectedGrowth: projectedGrowth * 100,
    discountRate: discountRate * 100,
    perpetualGrowth: perpetualGrowth * 100,
    enterpriseValue: toYi(ev),
    equityValue: toYi(equityValue),
    perShareValue: Math.round(perShareValue * 100) / 100,
    currentPrice: quote?.price || 0,
    // premium 定义为「相对内在价值的溢价率」= 股价/每股内在价值 - 1；
    // 正数 = 股价高于内在价值（高估），负数 = 股价低于内在价值（低估）。
    premium: perShareValue > 0 && quote?.price > 0 ? Math.round((quote.price / perShareValue - 1) * 10000) / 100 : 0,
  };
}

module.exports = { analyzeRevenueCost, analyzeBalanceSheet, analyzeCashFlow, analyzeValuation, analyzeGrowth, calculateDCF };
