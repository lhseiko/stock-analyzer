/**
 * Company Type Classifier
 * Classifies companies into: growth (增长型), value (价值型), dividend (红利型), or balanced (均衡型)
 * Different types should prioritize different fundamental metrics:
 *   - Growth SMEs: revenue growth + P/S ratio
 *   - Value blue-chips: P/E ratio + ROE
 *   - Dividend stocks: dividend yield + dividend sustainability
 */

/**
 * Classify company type based on available data
 * @param {string} symbol - Stock symbol
 * @param {string} name - Company name
 * @param {object} quote - Quote data (includes fundamentals, price, totalValue)
 * @param {object} financialData - { income, balance, cashflow } from Eastmoney
 * @param {object|null} shareholders - Shareholder data (includes totalMarketCap)
 * @param {array} dividends - Dividend history array
 * @returns {object} { type, typeName, typeIcon, description, keyMetrics, weights }
 */
function classifyCompanyType(symbol, name, quote, financialData, shareholders, dividends) {
  const { income } = financialData || {};
  
  // Gather data for classification
  const marketCap = getMarketCap(quote, shareholders);
  const pe = getPE(quote, shareholders, income);
  const dividendYield = getDividendYield(quote, dividends);
  const revenueGrowth = getRevenueGrowth(income);
  const roe = getROE(quote, financialData);
  const dividendYears = getDividendYears(dividends, quote);
  const isConsistentDividend = checkDividendConsistency(dividends) || (quote?.fundamentals?.dividendYears >= 3);
  
  // Known dividend-type companies (banks, utilities like 长江电力)
  const dividendKeywords = ['银行', '电力', '高速', '港口', '煤炭', '石油', '石化', '燃气', '水务', '铁路', '码头'];
  const nameIsDividendType = dividendKeywords.some(kw => (name || '').includes(kw));
  
  // Classification logic (priority order: dividend > growth > value > balanced)
  
  // 0. Known dividend-type company (banks, utilities) with long dividend history (5+ years)
  //    Even if current yield can't be calculated (e.g., latest dividend not yet announced)
  if (nameIsDividendType && dividendYears >= 5) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 1. Dividend stock: dividend yield > 3% AND consistent dividends for 3+ years
  //    OR known dividend-type company with yield > 2%
  if (
    (dividendYield >= 3 && dividendYears >= 3 && isConsistentDividend) ||
    (nameIsDividendType && dividendYield >= 2 && dividendYears >= 2)
  ) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 2. Growth stock: very high revenue growth (>50%) regardless of market cap
  //    OR moderate growth (>=20%) with smaller market cap (<500亿)
  if (revenueGrowth >= 50) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  if (revenueGrowth >= 20 && marketCap > 0 && marketCap < 500) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 3. Value stock: market cap > 500亿 AND PE 10-25 AND ROE > 10%
  if (marketCap >= 500 && pe >= 10 && pe <= 25 && roe >= 10) {
    return buildResult('value', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 4. Large cap with moderate characteristics -> value
  if (marketCap >= 500 && pe > 0 && pe <= 40 && roe >= 5) {
    return buildResult('value', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 5. Small cap with high growth -> growth
  if (revenueGrowth >= 15 && marketCap > 0 && marketCap < 300) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 6. High dividend even without long history -> dividend
  if (dividendYield >= 4 && dividendYears >= 1) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // Default: balanced
  return buildResult('balanced', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
}

function buildResult(type, marketCap, pe, divYield, revGrowth, roe, divYears, name) {
  // 金融业识别：银行/保险/证券/信托/基金等其高负债是经营常态（存贷/承保业务天然依赖负债），
  // 不应将高「资债比」判为利空。名称关键字足以覆盖 A 股上市金融机构。
  const financialKeywords = ['银行', '保险', '证券', '信托', '期货', '基金', '资管', '财富', '金控', '租赁', '财务', '再保险', '寿险', '财险', '人寿', '太保', '人保', '平安'];
  const isFinancial = financialKeywords.some(kw => (name || '').includes(kw));

  const typeInfo = {
    growth: {
      typeName: '增长型',
      typeIcon: '🚀',
      description: '增长型中小企业，重点关注营收增长和市销率(PS)',
      keyMetrics: ['revenueGrowth', 'ps', 'profitGrowth'],
      weights: { growth: 40, valuation: 20, profitability: 20, health: 20 },
      focusText: '营收增长率、市销率(PS)、利润增速',
    },
    value: {
      typeName: '价值型',
      typeIcon: '💎',
      description: '价值型白马股，重点关注市盈率(PE)和净资产收益率(ROE)',
      keyMetrics: ['pe', 'roe', 'pb', 'netMargin'],
      weights: { valuation: 35, profitability: 30, growth: 15, health: 20 },
      focusText: '市盈率(PE)、ROE、市净率(PB)、净利率',
    },
    dividend: {
      typeName: '红利型',
      typeIcon: '💰',
      description: '红利型股票，重点关注股息率和分红的可持续性',
      keyMetrics: ['dividendYield', 'dividendYears', 'payoutRatio', 'roe'],
      weights: { health: 35, profitability: 25, valuation: 25, growth: 15 },
      focusText: '股息率、分红年限、派息率、ROE稳定性',
    },
    balanced: {
      typeName: '均衡型',
      typeIcon: '⚖️',
      description: '均衡型公司，各维度均衡评估',
      keyMetrics: ['pe', 'roe', 'revenueGrowth', 'dividendYield'],
      weights: { valuation: 25, profitability: 25, growth: 25, health: 25 },
      focusText: '市盈率、ROE、营收增长、股息率',
    },
  };
  
  const info = typeInfo[type] || typeInfo.balanced;
  
  return {
    type,
    typeName: info.typeName,
    typeIcon: info.typeIcon,
    description: info.description,
    keyMetrics: info.keyMetrics,
    weights: info.weights,
    focusText: info.focusText,
    isFinancial,
    classificationData: {
      marketCap,
      pe,
      dividendYield: divYield,
      revenueGrowth: revGrowth,
      roe,
      dividendYears: divYears,
    },
  };
}

// ---- Helper functions to extract metrics ----

function getMarketCap(quote, shareholders) {
  // Try multiple sources
  if (shareholders?.totalMarketCap && shareholders.totalMarketCap > 0) {
    return Math.round(shareholders.totalMarketCap / 1e8 * 100) / 100; // Convert to 亿
  }
  if (quote?.totalValue && quote.totalValue > 0) {
    return quote.totalValue; // Already in 亿
  }
  if (quote?.fundamentals?.marketCap && quote.fundamentals.marketCap > 0) {
    return Math.round(quote.fundamentals.marketCap / 1e8 * 100) / 100;
  }
  return 0;
}

function getPE(quote, shareholders, income) {
  // Try quote first
  if (quote?.pe && quote.pe > 0) return quote.pe;
  if (quote?.fundamentals?.pe && quote.fundamentals.pe > 0) return quote.fundamentals.pe;
  // Calculate from financial data
  if (income && income.length > 0 && shareholders?.totalMarketCap) {
    const latest = income[income.length - 1];
    const netProfit = latest?.PARENT_NETPROFIT || 0;
    const marketCap = shareholders.totalMarketCap;
    if (netProfit > 0 && marketCap > 0) {
      return Math.round(marketCap / (netProfit / 1e8) * 100) / 100;
    }
  }
  return 0;
}

function getDividendYield(quote, dividends) {
  // Try quote first
  if (quote?.fundamentals?.dividendYield && quote.fundamentals.dividendYield > 0) {
    const dy = quote.fundamentals.dividendYield;
    return typeof dy === 'number' && dy < 1 && !quote.fundamentals.dividendYieldIsPct ? dy * 100 : dy;
  }
  // Calculate from dividends — find the most recent record with non-zero dividendPerShare
  if (dividends && dividends.length > 0 && quote?.price > 0) {
    for (const d of dividends) {
      if (d?.dividendPerShare && d.dividendPerShare > 0) {
        return Math.round(d.dividendPerShare / quote.price * 10000) / 100;
      }
    }
  }
  return 0;
}

function getRevenueGrowth(income) {
  if (!income || income.length < 2) return 0;
  const latest = income[income.length - 1];
  const prev = income[income.length - 2];
  const latestRev = latest?.TOTAL_OPERATE_INCOME || 0;
  const prevRev = prev?.TOTAL_OPERATE_INCOME || 0;
  if (prevRev > 0 && latestRev > 0) {
    return Math.round((latestRev / prevRev - 1) * 10000) / 100;
  }
  // Try YoY field
  if (latest?.TOTAL_OPERATE_INCOME_YOY) {
    return Math.round(latest.TOTAL_OPERATE_INCOME_YOY * 100) / 100;
  }
  return 0;
}

function getROE(quote, financialData) {
  // Try quote fundamentals
  if (quote?.fundamentals?.roe) {
    const roe = quote.fundamentals.roe;
    return typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  }
  if (quote?.fundamentals?.returnOnEquity) {
    const roe = quote.fundamentals.returnOnEquity;
    return typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  }
  // Try ZYZB data
  if (quote?.fundamentals?.roeJQ) {
    return quote.fundamentals.roeJQ;
  }
  return 0;
}

function getDividendYears(dividends, quote) {
  // 优先用东财分红接口统计的年数（/api/analysis 场景 dividends 可能为空数组）
  if ((!dividends || dividends.length === 0) && quote?.fundamentals?.dividendYears) {
    return quote.fundamentals.dividendYears;
  }
  if (!dividends || dividends.length === 0) return 0;
  // Count unique years with dividends
  const years = new Set(dividends.map(d => d.year).filter(y => y));
  return years.size;
}

function checkDividendConsistency(dividends) {
  if (!dividends || dividends.length < 3) return false;
  // Check if dividends exist for at least 3 consecutive years
  const years = dividends.map(d => parseInt(d.year)).filter(y => !isNaN(y)).sort((a, b) => a - b);
  if (years.length < 3) return false;
  let consecutive = 1;
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] === 1) {
      consecutive++;
      if (consecutive >= 3) return true;
    } else {
      consecutive = 1;
    }
  }
  return false;
}

module.exports = { classifyCompanyType };
