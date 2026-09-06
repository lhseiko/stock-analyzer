// lib/deepAnalysis.js —— 门面：仅 re-export，导出基线与拆分前逐键一致（13 键）
const pipeline   = require('./deep/pipeline');
const financials = require('./deep/financials');
const dividends  = require('./deep/dividends');
const research   = require('./deep/research');

module.exports = {
  deepAnalysis: pipeline.deepAnalysis,
  fetchFinancialData: financials.fetchFinancialData,
  getLocalDocuments: research.getLocalDocuments,
  fetchSegmentData: research.fetchSegmentData,
  fetchResearchReports: research.fetchResearchReports,
  fetchAnnouncements: research.fetchAnnouncements,
  fetchDividends: dividends.fetchDividends,
  persistDividends: dividends.persistDividends,
  loadDividendSeries: dividends.loadDividendSeries,
  classifyDividendStage: dividends.classifyDividendStage,
  dividendLabel: dividends.dividendLabel,
  normalizeSymbol: dividends.normalizeSymbol,
  persistValuationScalars: dividends.persistValuationScalars,
};
