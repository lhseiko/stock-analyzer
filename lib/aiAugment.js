// lib/aiAugment.js —— 门面：仅 re-export，导出基线与拆分前逐键一致（24 键，键序与原 L2386-2387 一致）
const config    = require('./ai/config');
const cache     = require('./ai/cache');
const llm       = require('./ai/llm');
const augment   = require('./ai/augmentStock');
const products  = require('./ai/products');
const company   = require('./ai/company');
const market    = require('./ai/market');
const research  = require('./ai/research');
const earnings  = require('./ai/earnings');
const valuation = require('./ai/valuation');

module.exports = {
  augmentStock: augment.augmentStock,
  analyzeAspects: augment.analyzeAspects,
  analyzeProducts: products.analyzeProducts,
  analyzeCompany: company.analyzeCompany,
  analyzeSupplyChain: company.analyzeSupplyChain,
  analyzeShareholdersAI: company.analyzeShareholdersAI,
  analyzeMarketOverview: market.analyzeMarketOverview,
  analyzeIndustryIndex: market.analyzeIndustryIndex,
  analyzeResearchReports: research.analyzeResearchReports,
  analyzeAnnouncements: research.analyzeAnnouncements,
  analyzeEarningsReport: earnings.analyzeEarningsReport,
  analyzeValuation: valuation.analyzeValuation,
  readIndustryIndexCache: market.readIndustryIndexCache,
  loadConfig: config.loadConfig,
  saveConfig: config.saveConfig,
  publicConfig: config.publicConfig,
  readCache: cache.readCache,
  readEarningsCache: cache.readEarningsCache,
  readValuationCache: cache.readValuationCache,
  extractEarningsSignal: earnings._extractEarningsSignal,   // ← 别名导出，原样保留
  PROVIDERS: config.PROVIDERS,                               // ← 同一对象引用
  callLLM: llm.callLLM,
  pickModelFor: llm.pickModelFor,
  buildLocalEarningsContext: earnings.buildLocalEarningsContext,
};
