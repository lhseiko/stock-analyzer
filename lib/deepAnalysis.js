/**
 * Deep Analysis Module - Company Analysis (Product + Insurance)
 * Based on 26-section analysis outline for product-type companies
 * Plus 18-section insurance analysis framework
 * Includes financial data revision detection
 */
const axios = require('axios');
const { getQuote, detectMarket } = require('./stockData');
const { isInsuranceCompany, analyzeInsuranceCompany } = require('./insuranceAnalysis');
const { classifyCompanyType } = require('./companyType');
const docStore = require('./docStore');
const { getFuturesMeta } = require('./futuresData');
const { readCache } = require('./aiAugment');
const { analyzeChangesForSymbol } = require('./changeAnalysis');
const { fetchValuationTTM } = require('./eastmoneyValuation');
const { getValuationHub, beginSnapshot, formatValuationLine } = require('./valuationHub');
const { getFinanceHub, formatFinanceLine } = require('./financeHub');
const { getQuoteHub, wrapQuote } = require('./quoteHub');
const db = require('./db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）
// 202609 拆分重构：纯工具函数/常量迁至 deep/shared（跨子模块复用叶子；_calcStats 与 statements 内局部 calcStats 无关）
const shared = require('./deep/shared');
// 202609 拆分重构：财务三表与股东抓取迁至 deep/financials
const financials = require('./deep/financials');
const { fetchFinancialData, fetchShareholders, buildShareholderStats, fetchTopShareholders } = financials;
// 202609 拆分重构：分红抓取/校准/持久化迁至 deep/dividends
const dividends = require('./deep/dividends');
const { fetchDividends, calibrateDividends, classifyDividendStage, dividendLabel, normalizeSymbol, persistDividends, loadDividendSeries, persistValuationScalars, aggregateAnnualDPS } = dividends;
// 202609 拆分重构：股息率趋势迁至 deep/yield
const { analyzeDividendYield } = require('./deep/yield');
// 202609 拆分重构：本地文档/主营构成/研报/公告抓取迁至 deep/research（_cninfoOrgCache 唯一持有）
const research = require('./deep/research');
const { getLocalDocuments, fetchSegmentData, buildProductGrossMargin, fetchResearchReports, fetchAnnouncements } = research;
// 202609 拆分重构：三表分析/估值/成长/DCF 迁至 deep/statements（局部 calcStats 原样保留，D5）
const statements = require('./deep/statements');
const { analyzeRevenueCost, analyzeBalanceSheet, analyzeCashFlow, analyzeValuation, analyzeGrowth, calculateDCF } = statements;
// 202609 拆分重构：各小节结论/论证生成迁至 deep/conclusions
const conclusions = require('./deep/conclusions');
const { buildRevenueConclusion, buildCashFlowConclusion, buildGrowthConclusion, buildMarginConclusion, analyzeRoeMarginTrend, buildBalanceConclusion, buildDividendConclusion, buildDCFConclusion, buildAssetCompConclusion, buildLiabCompConclusion, buildMarketCapConclusion, buildProfitVsCashConclusion, buildRevVsCostConclusion, buildRevVsExpConclusion, buildPayableConclusion, buildValuationMetricConclusion, buildDivYieldConclusion, buildSegmentProductConclusion, buildSegmentRegionConclusion, buildProductMarginConclusion, buildInsurancePremiumConclusion, buildInsuranceCombinedRatioConclusion, buildInsuranceInvestmentYieldConclusion, buildInsuranceNBVConclusion, buildInsuranceProfitCompConclusion, buildInsurancePEVConclusion, buildInsuranceDDMConclusion, buildBusinessLineConclusion, buildValuationReasoning } = conclusions;
// 202609 拆分重构：估值综合结论生成迁至 deep/conclusion
const { generateConclusion } = require('./deep/conclusion');
const { fmtPrice, fmtPct, toYi, _calcStats, _stmtStage, UA, HEADERS, withTimeout } = shared;

// 给各 section 附加 conclusion / reasoning
// 注意：部分 section 本身是数组（如 revenueCostData / cashFlowData），数组上的
// 自定义属性在 JSON 序列化时会被丢弃，因此统一收集到 sections._conclusions 这个
// 普通对象中，确保前端能稳定拿到结论与论证。
function augmentSections(sections, ctx) {
  const c = {};

  // ---- 营收与盈利趋势（含毛利率维度）----
  const rc = buildRevenueConclusion(sections.revenueCostData);
  if (rc) c.revenueCost = rc;

  // ---- 现金流 ----
  const cf = buildCashFlowConclusion(sections.cashFlowData);
  if (cf) c.cashFlow = cf;

  const g = buildGrowthConclusion(sections.growth);
  if (g) c.growth = g;

  const m = buildMarginConclusion(sections.revenueCostData);
  if (m) c.margin = m;

  const bal = buildBalanceConclusion(sections.shortTermRisk, sections.assetComposition, sections.liabilityComposition, ctx.balanceAnalysis);
  if (bal) c.balance = bal;

  const div = buildDividendConclusion(sections.dividendData);
  if (div) c.dividend = div;

  const dcfC = buildDCFConclusion(sections.dcf);
  c.dcf = dcfC;

  if (sections.conclusion) {
    const vr = buildValuationReasoning(sections.conclusion);
    c.valuation = { conclusion: sections.conclusion.conclusionText, reasoning: vr };
  }

  // ---- 资产 / 负债构成 ----
  const assetConcl = buildAssetCompConclusion(sections.assetComposition, sections.totalAssets);
  if (assetConcl) c.asset = assetConcl;

  const liabConcl = buildLiabCompConclusion(sections.liabilityComposition, sections.totalLiabilities);
  if (liabConcl) c.liability = liabConcl;

  // ---- 市值对比（营收 / 净利润 / 净资产 vs 市值）----
  const mcRevenue = buildMarketCapConclusion(sections.marketCapData, 'revenue', '营业总收入', '市销率');
  if (mcRevenue) c.marketCapRevenue = mcRevenue;
  const mcProfit = buildMarketCapConclusion(sections.marketCapData, 'netProfit', '归母净利润', '市盈率');
  if (mcProfit) c.marketCapProfit = mcProfit;
  const mcNav = buildMarketCapConclusion(sections.marketCapData, 'netAssets', '净资产', '市净率');
  if (mcNav) c.marketCapNav = mcNav;

  // ---- 净利润 vs 经营现金流（业绩真实性）----
  const pvc = buildProfitVsCashConclusion(sections.cashFlowData);
  if (pvc) c.profitVsCash = pvc;

  // ---- 营收 vs 总成本 ----
  const rvc = buildRevVsCostConclusion(sections.revenueCostData);
  if (rvc) c.revVsCost = rvc;

  // ---- 营收 vs 三费 ----
  const rve = buildRevVsExpConclusion(sections.expenseData);
  if (rve) c.revVsExp = rve;

  // ---- 营收 vs 应付账款 ----
  const pay = buildPayableConclusion(sections.payableData);
  if (pay) c.payable = pay;

  // ---- 估值指标（PE / PB / PS）----
  const vPE = buildValuationMetricConclusion(sections.valuation, 'PE');
  if (vPE) c.valuationPE = vPE;
  const vPB = buildValuationMetricConclusion(sections.valuation, 'PB');
  if (vPB) c.valuationPB = vPB;
  const vPS = buildValuationMetricConclusion(sections.valuation, 'PS');
  if (vPS) c.valuationPS = vPS;

  // ---- 股息率趋势 ----
  const dy = buildDivYieldConclusion(sections.dividendYieldData);
  if (dy) c.divYield = dy;

  // ---- 分产品 / 分地区主营构成 ----
  const segP = buildSegmentProductConclusion(sections.segmentData);
  if (segP) c.segmentProduct = segP;
  const segR = buildSegmentRegionConclusion(sections.segmentData);
  if (segR) c.segmentRegion = segR;

  // ---- 细分产品毛利率 ----
  const pm = buildProductMarginConclusion(sections.productGrossMargin);
  if (pm) c.productMargin = pm;

  // ---- 保险公司专属结论 ----
  const insurance = sections.insuranceAnalysis;
  if (insurance && insurance.sections) {
    const s = insurance.sections;
    const premium = buildInsurancePremiumConclusion(s.premiumAnalysis);
    if (premium) c.premium = premium;
    const cr = buildInsuranceCombinedRatioConclusion(s.combinedRatioAnalysis);
    if (cr) c.combinedRatio = cr;
    const iy = buildInsuranceInvestmentYieldConclusion(s.investmentYieldAnalysis);
    if (iy) c.investmentYield = iy;
    const nbv = buildInsuranceNBVConclusion(s.nbvAnalysis);
    if (nbv) c.nbv = nbv;
    const pc = buildInsuranceProfitCompConclusion(s.profitDivergence);
    if (pc) c.insuranceProfit = pc;
    const pev = buildInsurancePEVConclusion(s.pevValuation);
    if (pev) c.pev = pev;
    const ddm = buildInsuranceDDMConclusion(s.ddmValuation);
    if (ddm) c.ddm = ddm;
    const bl = s.businessLines || {};
    const life = buildBusinessLineConclusion(bl.life, '寿险保费');
    if (life) c.businessLife = life;
    const prop = buildBusinessLineConclusion(bl.property, '财产险保费');
    if (prop) c.businessProperty = prop;
    const pens = buildBusinessLineConclusion(bl.pension, '养老险保费');
    if (pens) c.businessPension = pens;
    const health = buildBusinessLineConclusion(bl.health, '健康险保费');
    if (health) c.businessHealth = health;
  }

  sections._conclusions = c;

  return sections;
}

// Main deep analysis function
async function deepAnalysis(symbol, name, quote, history) {
  console.log(`[DeepAnalysis] Starting for ${symbol}...`);
  
  const info = require('./stockData').detectMarket(symbol);
  if (info.market !== 'CN') {
    return { error: '深度分析目前仅支持A股市场', sections: [] };
  }
  
  const code = info.tencentCode.replace(/^(sh|sz)/, m => m.toUpperCase());
  const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  const stockCode = info.tencentCode.replace(/^(sh|sz)/, '');

  // 规则一：确立「当前价」的唯一权威来源（行情网关 → 腾讯行情）。
  // 此前 currentPrice 存在 quote.price 与 history末日close 两套取法（同指标两值）。
  // 这里用 wrapQuote 包装「已获取」的 quote/history（不二次请求），
  // 避免再发一次网络请求导致两次取价不一致——取数只发生一次，包装也只有一层。
  let priceRef = null;
  let quoteRules = null;
  try {
    const qh = wrapQuote(quote, history);
    if (qh && qh.ok && qh.latest && qh.latest.price && qh.latest.price.value > 0) {
      priceRef = qh.latest.price;
      quoteRules = beginSnapshot(qh);
    }
  } catch (e) {
    console.error('[DeepAnalysis] wrapQuote failed:', e.message);
  }
  // 权威价不可用时，不做静默替换：标记来源为降级，保证可追溯
  if (!priceRef) {
    const fallbackClose = (history && history.length) ? history[history.length - 1].close : 0;
    priceRef = {
      name: '当前价', value: fallbackClose || 0,
      dataTime: (history && history.length) ? history[history.length - 1].date : null,
      source: '日线末日收盘价（行情接口不可用，降级）',
      fetchTime: new Date().toISOString(),
      degraded: true,
    };
  }
  const authoritativePrice = priceRef.value || 0;

  // 规则一·五要素 + 规则二·TTL：把「当前价」这一标量事实落地到 data_points（来源/实际时间/获取时间齐全，5 分钟有效）。
  try {
    db.upsertDataPoint({
      symbol: normalizeSymbol(emCode),
      key: 'current_price',
      value: authoritativePrice,
      asOf: priceRef.dataTime || null,
      source: priceRef.source || 'quote',
      ttlType: 'realtime',
      extra: { degraded: !!priceRef.degraded },
    });
  } catch (e) { console.error('[DB] upsertDataPoint current_price failed:', e.message); }

  // Check local document store first (for historical reports and announcements)
  const localDocuments = getLocalDocuments(stockCode);

  // Detect company type (insurance vs product)
  const isInsurance = isInsuranceCompany(symbol, name, quote);
  console.log(`[DeepAnalysis] Company type: ${isInsurance ? 'Insurance' : 'Product'}`);

  console.log(`[DeepAnalysis] Fetching financial data for ${emCode}...`);

  // Fetch all financial data in parallel
  const [finData, shareholders, dividends] = await Promise.all([
    fetchFinancialData(emCode),
    fetchShareholders(code),
    fetchDividends(emCode),
  ]);

  // 规则一/二/三：分红原始记录落地 SQLite（五要素 + 时序，支撑边际分析）；失败不阻断主流程。
  try { persistDividends(symbol, emCode, dividends); } catch (e2) { console.error('[DeepAnalysis] persistDividends failed:', e2.message); }
  
  const { income, balance, cashflow } = finData;

  // 三规则铺开：财务模块（报告期 + 90 天时效 + 同比增速的边际）
  let financeRules = null;
  try {
    const fh = getFinanceHub(finData);
    if (fh && fh.ok) financeRules = beginSnapshot(fh);
  } catch (e) {
    console.error('[DeepAnalysis] financeHub failed:', e.message);
  }
  
  console.log(`[DeepAnalysis] Income: ${income.length}, Balance: ${balance.length}, Cashflow: ${cashflow.length}`);
  
  if (income.length === 0) {
    return { error: '无法获取财务数据', sections: [] };
  }
  
  // Compute all analysis sections
  const revenueCostData = analyzeRevenueCost(income);
  const balanceAnalysis = analyzeBalanceSheet(balance);
  const cashFlowData = analyzeCashFlow(cashflow, income, revenueCostData);
  // 东方财富 TTM 估值历史（填充当年 2026 数据空缺、修正历史 PE/PB/PS 口径），失败则回退年报口径
  let emValuation = null;
  try {
    emValuation = await fetchValuationTTM(emCode);
    console.log(`[DeepAnalysis] EastMoney TTM valuation: ${emValuation ? emValuation.series.length + ' points (' + emValuation.source + ')' : 'unavailable'}`);
  } catch (e) {
    console.error('[DeepAnalysis] fetchValuationTTM failed:', e.message);
  }
  const valuation = analyzeValuation(finData, quote, shareholders, emValuation);

  // 三规则样板：估值模块统一走 valuationHub（单一数据源 + 五要素 + 时效体检 + 变化与边际）
  // 规则一③：分析期数据锁定——快照后本次分析全程使用冻结数据，中途源更新不影响。
  let valuationRules = null;
  try {
    const hub = await getValuationHub(emCode);
    if (hub && hub.ok) {
      valuationRules = beginSnapshot({
        latest: hub.latest,
        freshness: hub.freshness,
        staleNote: hub.staleNote,
        sanity: hub.sanity,
        analysis: hub.analysis,
        shortTerm: hub.shortTerm,
        source: hub.source,
        fetchedAt: hub.fetchedAt,
      });
    }
  } catch (e) {
    console.error('[DeepAnalysis] valuationHub failed:', e.message);
  }
  // 规则一：估值模块对外只暴露这一份带血缘的数据
  if (valuationRules) valuation.rules = valuationRules;
  // 规则一/二：把估值标量（PE/PB/PS）落地 data_points（五要素 + 90 天 TTL）；失败不阻断主流程。
  try { persistValuationScalars(symbol, emCode, valuation); } catch (e2) { console.error('[DeepAnalysis] persistValuationScalars failed:', e2.message); }
  // 规则一：权威价来源可追溯（供排查；对外输出走 sections.quoteRules）
  if (priceRef) quote.__priceRef = priceRef;
  const growth = analyzeGrowth(revenueCostData);
  const dcf = calculateDCF(finData, balance, quote, shareholders);
  
  // Classify company type (growth / value / dividend / balanced) — 兜底防止整页 500
  let companyType;
  try {
    companyType = classifyCompanyType(symbol, name, quote, finData, shareholders, dividends);
    console.log(`[DeepAnalysis] Company classification: ${companyType.typeName} (${companyType.type})`);
    console.log(`[DeepAnalysis] Classification data: marketCap=${companyType.classificationData.marketCap}亿, PE=${companyType.classificationData.pe}, divYield=${companyType.classificationData.dividendYield}%, revGrowth=${companyType.classificationData.revenueGrowth}%, roe=${companyType.classificationData.roe}%`);
  } catch (e) {
    console.error('[DeepAnalysis] classifyCompanyType failed:', e.message);
    companyType = { type: 'balanced', typeName: '均衡型', typeIcon: '⚖️', description: '', focusText: '各维度均衡评估', classificationData: {}, weights: { valuation: 0.25, profitability: 0.25, growth: 0.25, health: 0.25 } };
  }

  // Audit opinion check
  const latestIncome = income[income.length - 1];
  const auditOpinion = latestIncome?.OPINION_TYPE || '';
  const auditWarning = auditOpinion && !auditOpinion.includes('标准无保留') 
    ? `⚠️ 最新一期审计意见为"${auditOpinion}"，非标准无保留意见，请重点关注！`
    : null;
  
  // Insurance-specific analysis：必须在 generateConclusion 之前拿到 P/EV、DDM，
  // 分业务趋势所需的板块构成数据（8s 超时，绝不拖垮主流程）；提前抓取以便保险分析复用
  const [segmentData] = await Promise.all([
    withTimeout(fetchSegmentData(emCode), 8000, null),
  ]);
  console.log(`[DeepAnalysis] Optional: segment=${segmentData ? 'ok' : 'null'}`);

  // 以便对保险公司压降 DCF 权重并纳入合适的估值口径。
  let insuranceAnalysis = null;
  if (isInsurance) {
    console.log(`[DeepAnalysis] Running insurance-specific analysis...`);
    try {
      insuranceAnalysis = await analyzeInsuranceCompany(emCode, symbol, name, quote, income, balance, cashflow, shareholders, dividends, segmentData);
    } catch (e) {
      console.error('[DeepAnalysis] Insurance analysis failed:', e.message);
      insuranceAnalysis = { isInsurance: true, error: e.message };
    }
  }

  // Generate valuation conclusion (with company type)
  let conclusion;
  try {
    conclusion = generateConclusion(dcf, valuation, growth, cashFlowData, revenueCostData, balanceAnalysis, auditOpinion, shareholders, companyType, dividends, quote, insuranceAnalysis);
  } catch (e) {
    console.error('[DeepAnalysis] generateConclusion failed:', e.message);
    conclusion = { overallRating: '数据不足', currentPrice: quote?.price || 0, methodsUsed: [], ratings: [], conclusionText: '估值结论生成失败：' + e.message, companyType: companyType.type, companyTypeName: companyType.typeName };
  }

  // Calculate chip distribution from price history
  const chipDistribution = calculateChipDistribution(history, authoritativePrice);

  // Build dividend data with net profit for comparison (Section 22)
  // dividends[].dividend is in 元, netProfit is in 亿
  const dividendData = revenueCostData.map(rc => {
    const div = dividends.find(d => d.year === rc.year);
    const divYi = div ? toYi(div.dividend) : 0; // Convert to 亿
    return {
      year: rc.year,
      netProfit: rc.netProfit,
      dividend: divYi,
      dividendPerShare: div?.dividendPerShare || 0,
      dividendRate: rc.netProfit > 0 && divYi > 0 ? Math.round(divYi / rc.netProfit * 10000) / 100 : 0,
    };
  });

  // 分红派次明细（近5年每次分红，含公告未分配）——供前端「每次/每年」柱状图
  // 来源：东方财富分红方案 RPT_SHAREBONUS_DET（fetchDividends 返回的原始每次派息记录，
  // 含董事会预案/股东大会通过等尚未实施（公告未分配）的记录，progress 字段标记进度）。
  const recentYears = revenueCostData.map(rc => rc.year);
  let maxShares = 0;
  for (const d of (dividends || [])) { const s = parseFloat(d.totalShares) || 0; if (s > maxShares) maxShares = s; }
  const dividendPayouts = (dividends || [])
    .filter(d => d.year && recentYears.includes(d.year))
    .map(d => {
      const shares = parseFloat(d.totalShares) || maxShares;
      const amountYi = toYi((parseFloat(d.dividendPerShare) || 0) * shares); // 元→亿
      const plan = d.plan || '';
      const reportDate = d.reportDate || '';
      // 复用统一阶段判定（单一展示口径，规则一）：中报/年报由 REPORT_DATE 月份决定，特别股息由 plan 决定。
      const stage = classifyDividendStage(reportDate, plan);
      const isPending = !/实施|派发|派息/.test(d.progress || ''); // 公告未分配（董事会预案/股东大会通过等）
      const sortKey = `${d.year}-${stage === '中期' ? '1' : stage === '特别' ? '2' : '9'}-${d.exDate || ''}`;
      return {
        year: d.year,
        label: dividendLabel(d.year, stage),
        amountYi: Math.round(amountYi * 100) / 100,
        perShare: d.dividendPerShare || 0,
        progress: d.progress || '',
        isPending,
        sortKey,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // 股息率趋势（近10年 + 均值±标准差参考线 + 行业对比）
  let dividendYieldData = { series: [], stats: { mean: 0, std: 0, high: 0, low: 0 }, latest: null, current: null, industry: null };
  try {
    dividendYieldData = await analyzeDividendYield(dividends, quote, symbol, name);
    console.log(`[DeepAnalysis] Dividend yield: ${dividendYieldData.series.length} years, mean=${dividendYieldData.stats.mean}%, current=${dividendYieldData.current?.yield}%`);
  } catch (e) {
    console.error('[DeepAnalysis] analyzeDividendYield failed:', e.message);
  }

  // Revenue vs market cap (Section 10, 11, 12)
  // 估值序列含当年(2026)当前 TTM 点（无年报营收），此处仅取有营收的年报口径年份，避免空值
  const marketCapData = valuation.valuationData
    .filter(v => v.revenue != null && v.revenue > 0)
    .map(v => ({
      year: v.year,
      revenue: v.revenue,
      netProfit: v.netProfit,
      netAssets: v.netAssets,
      marketCap: v.marketCap,
    }));

  // 研报 / 公告 / 最新财报解读：读取已存的 AI 联网总结缓存（由对应 /api/ai/* 按需生成），不在此处联网
  let aiResearch = null, aiAnnc = null, aiEarnings = null;
  try { aiResearch = readCache(symbol, '_research'); } catch {}
  try { aiAnnc = readCache(symbol, '_announcements'); } catch {}
  try { aiEarnings = readCache(symbol, '_earnings'); } catch {}

  // 细分产品/业务毛利率（营收占比 / 成本占比 / 毛利率）
  let productGrossMargin = null;
  try {
    productGrossMargin = buildProductGrossMargin(segmentData);
  } catch (e) { console.error('[DeepAnalysis] productGrossMargin failed:', e.message); }
  
  // 前十大股东 + 机构统计（用于饼图与机构持股说明）
  let topHolders = [];
  try { topHolders = await fetchTopShareholders(emCode); } catch (e) { console.error('Top shareholders failed:', e.message); }
  const shareholderStats = buildShareholderStats(topHolders, shareholders?.totalShares || 0);

  const sections = {
      // 行情三规则（当前价权威来源 + 时效 + 涨跌边际）；此前挂在 quote 对象上不会随响应返回
      quoteRules,
      // 财务三规则（报告期 + 90 天时效 + 同比增速边际）
      financeRules,
      // 估值结论
      conclusion,
      // 公司类型分类
      companyClassification: companyType,
      // 本地资料库文档列表
      localDocuments,
      // 筹码分布
      chipDistribution,
      // 保险公司专属分析
      insuranceAnalysis,
      // Section 4: Product revenue trend
      revenueCostData,
      // Section 6: Short-term financial risk
      shortTermRisk: balanceAnalysis?.shortTermRisk,
      // Section 7: Asset composition
      assetComposition: balanceAnalysis?.assetComposition,
      totalAssets: balanceAnalysis?.totalAssets,
      goodwill: balanceAnalysis?.goodwill,
      // Section 8: Liability composition
      liabilityComposition: balanceAnalysis?.liabilityComposition,
      totalLiabilities: balanceAnalysis?.totalLiabilities,
      netAssets: balanceAnalysis?.netAssets,
      // Section 9, 13: Cash flow
      cashFlowData,
      // Section 10, 11, 12: Market cap vs fundamentals
      marketCapData,
      // Section 14: Revenue vs cost
      // (already in revenueCostData)
      // Section 15: Gross margin trend
      grossMarginTrend: revenueCostData.map(d => ({ year: d.year, grossMargin: d.grossMargin, netMargin: d.netMargin })),
      // Section 15b: 近5年 ROE 与毛利率走势（含文字解读）
      roeMarginTrend: analyzeRoeMarginTrend(revenueCostData, quote),
      // Section 16: Revenue vs expenses
      expenseData: revenueCostData.map(d => ({
        year: d.year,
        revenue: d.revenue,
        saleExpense: d.saleExpense,
        manageExpense: d.manageExpense,
        researchExpense: d.researchExpense,
        ttm: d.ttm,
      })),
      // Section 17: Growth rates
      growth,
      // Section 18: Revenue vs accounts payable
      payableData: balanceAnalysis?.netAssetsTrend.map(d => ({
        year: d.year,
        revenue: revenueCostData.find(rc => rc.year === d.year)?.revenue || 0,
        accountsPayable: d.accountsPayable,
      })) || [],
      // Section 19, 20, 21: Valuation indicators
      valuation,
      // Section 22: Dividends
      dividendData,
      // Section 22c: 每次/每年分红金额柱状图（近5年派次明细）
      dividendPayouts,
      // Section 22b: Dividend yield trend (10y + stats + industry)
      dividendYieldData,
      // Section 23: DCF valuation
      dcf,
      // Section 25: Shareholders
      shareholders,
      topShareholders: topHolders,
      shareholderStats,
      // Net assets trend
      netAssetsTrend: balanceAnalysis?.netAssetsTrend,
      // ---- 新增小节（第4/25节）----
      segmentData,                                // 第4/5节：分产品 / 分地区主营构成
      productGrossMargin,                         // 第4节补充：细分产品/业务毛利率（营收占比·成本占比·毛利率）
      // ---- 第24/25节：研报与公告改为 AI 联网总结（缓存优先，结构化抓取已弃用）----
      researchReports: [],
      announcements: [],
      researchAI: aiResearch || null,
      announcementAI: aiAnnc || null,
      earningsReport: aiEarnings || null,
    };

  // 为各分析小节附加「结论 + 论证」
  augmentSections(sections, { balanceAnalysis, companyType, dividends, quote });

  // 重大财务变化 AI 归因与历史留存
  try {
    const changeAnalysis = await analyzeChangesForSymbol(symbol, name, sections);
    sections.changeAnalysis = changeAnalysis;
  } catch (e) {
    console.error('[DeepAnalysis] changeAnalysis failed:', e.message);
    sections.changeAnalysis = { hasChanges: false, analyses: [], error: e.message };
  }

  // 规则二·分析期数据锁定：把本次分析的完整数据冻结进 SQLite（可复现/审计），失败不影响主流程。
  const result = {
    symbol,
    name,
    market: info.market,
    exchange: info.exchange,
    companyType: isInsurance ? 'insurance' : 'product',
    companyClassification: companyType,
    localDocuments,
    auditOpinion,
    auditWarning,
    sections,
    timestamp: new Date().toISOString(),
  };

  try {
    db.saveSnapshot({
      symbol: normalizeSymbol(emCode),
      snapshotId: `${normalizeSymbol(emCode)}-${Date.now()}`,
      range: (history && history.range) || 'daily',
      payload: result,
    });
  } catch (e) { console.error('[DB] saveSnapshot failed:', e.message); }

  return result;
}

// ---- 筹码分布计算 ----
function calculateChipDistribution(history, authoritativePrice) {
  if (!history || history.length < 30) return null;

  // 规则一：当前价统一取入口确立的权威价（行情网关），不再用「历史末日收盘价」另起一套
  const currentPrice = (authoritativePrice != null && authoritativePrice > 0)
    ? authoritativePrice
    : history[history.length - 1].close;
  // Use recent 120 trading days for chip calculation
  const recent = history.slice(-120);
  
  // Find price range
  let minPrice = Infinity, maxPrice = -Infinity;
  for (const d of recent) {
    minPrice = Math.min(minPrice, d.low);
    maxPrice = Math.max(maxPrice, d.high);
  }
  
  // Create 50 price bins
  const binCount = 50;
  const binSize = (maxPrice - minPrice) / binCount;
  if (binSize <= 0) return null;
  
  const bins = new Array(binCount).fill(0);
  let totalVolume = 0;
  
  // Distribute each day's volume across its price range
  // Weight: more recent days have higher weight (exponential decay)
  const decay = 0.995;
  const dayWeight = (i) => Math.pow(decay, recent.length - 1 - i);
  
  for (let i = 0; i < recent.length; i++) {
    const d = recent[i];
    const dayLow = d.low;
    const dayHigh = d.high;
    const range = dayHigh - dayLow;
    const w = dayWeight(i);
    
    if (range <= 0) {
      // Single price point
      const binIdx = Math.min(binCount - 1, Math.floor((dayLow - minPrice) / binSize));
      bins[binIdx] += d.volume * w;
      totalVolume += d.volume * w;
    } else {
      // Distribute volume across price range (assume normal distribution within day)
      const startBin = Math.max(0, Math.floor((dayLow - minPrice) / binSize));
      const endBin = Math.min(binCount - 1, Math.ceil((dayHigh - minPrice) / binSize));
      const binVol = (d.volume * w) / (endBin - startBin + 1);
      for (let b = startBin; b <= endBin; b++) {
        bins[b] += binVol;
      }
      totalVolume += d.volume * w;
    }
  }
  
  // Calculate average cost (volume-weighted average price)
  let costSum = 0, volSum = 0;
  for (let i = 0; i < binCount; i++) {
    const price = minPrice + (i + 0.5) * binSize;
    costSum += price * bins[i];
    volSum += bins[i];
  }
  const avgCost = volSum > 0 ? costSum / volSum : currentPrice;
  
  // Calculate profit ratio (percentage of chips below current price)
  let profitVol = 0;
  for (let i = 0; i < binCount; i++) {
    const price = minPrice + (i + 0.5) * binSize;
    if (price <= currentPrice) {
      profitVol += bins[i];
    }
  }
  const profitRatio = volSum > 0 ? (profitVol / volSum * 100) : 0;
  
  // Find concentration (peak chips)
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < binCount; i++) {
    if (bins[i] > peakVal) { peakVal = bins[i]; peakIdx = i; }
  }
  const peakPrice = minPrice + (peakIdx + 0.5) * binSize;
  
  // Build chart data (price -> percentage)
  const chartData = bins.map((v, i) => ({
    price: Math.round((minPrice + (i + 0.5) * binSize) * 100) / 100,
    ratio: volSum > 0 ? Math.round(v / volSum * 10000) / 100 : 0,
  }));
  
  return {
    chartData,
    currentPrice: Math.round(currentPrice * 100) / 100,
    avgCost: Math.round(avgCost * 100) / 100,
    profitRatio: Math.round(profitRatio * 100) / 100,
    peakPrice: Math.round(peakPrice * 100) / 100,
    minPrice: Math.round(minPrice * 100) / 100,
    maxPrice: Math.round(maxPrice * 100) / 100,
  };
}

module.exports = { deepAnalysis, fetchFinancialData, getLocalDocuments, fetchSegmentData, fetchResearchReports, fetchAnnouncements, fetchDividends, persistDividends, loadDividendSeries, classifyDividendStage, dividendLabel, normalizeSymbol, persistValuationScalars };
