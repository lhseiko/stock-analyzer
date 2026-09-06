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
// 202609 拆分重构：主流程编排/小节结论装配/筹码分布迁至 deep/pipeline（readCache 已改走 ai/cache）
const pipeline = require('./deep/pipeline');
const deepAnalysis = pipeline.deepAnalysis;
const { fmtPrice, fmtPct, toYi, _calcStats, _stmtStage, UA, HEADERS, withTimeout } = shared;

module.exports = { deepAnalysis, fetchFinancialData, getLocalDocuments, fetchSegmentData, fetchResearchReports, fetchAnnouncements, fetchDividends, persistDividends, loadDividendSeries, classifyDividendStage, dividendLabel, normalizeSymbol, persistValuationScalars };
