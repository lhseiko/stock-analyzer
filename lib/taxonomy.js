/**
 * lib/taxonomy.js — 跨模块常量单源（20261110g · 整改方案 P1-3）
 * ==========================================================================
 * 问题：同一业务常量曾在多个模块各自定义（如震荡容差 0.5 在 3 个模块各写一份、
 *   sameDayJudgment 的 1.0 是内联魔数），改口径时漏改一处就是「同链不同容忍度」。
 *
 * 本文件是全站唯一定义处。规则：
 *   - 消费方一律 `const TAX = require('./taxonomy')` 后引用，**禁止再写死字面量**；
 *   - 新守卫 scripts/test_single_source_taxonomy.js 用源码扫描断言「定义处只有一份」；
 *   - 语义不同的阈值分立登记（绝不把语义不同的 LEARN_MIN_SAMPLE 硬并成同一个数）。
 *
 * 零依赖、零 I/O。
 */
'use strict';

// ---------------------------------------------------------------------------
// 震荡容差（整改方案 P1-3：**显式两常量，禁止第三种取值**）
// ---------------------------------------------------------------------------
/** 个股震荡容差（%）：个股短期判断结算、技术面形态结算——个股波动大，容差放宽 */
const FLAT_TOLERANCE_STOCK = 1.0;
/** 指数震荡容差（%）：大盘技术判断、情绪预警结算、5 日动量基准——指数波动小，容差收紧 */
const FLAT_TOLERANCE_INDEX = 0.5;

// ---------------------------------------------------------------------------
// 自学习最小样本（三处语义不同，分立登记；严禁互相挪用）
// ---------------------------------------------------------------------------
/** 短期判断单因子权重调整下限（sameDayJudgment：低于此值不调整该因子权重） */
const LEARN_MIN_SAMPLE_FACTOR = 5;
/** 大盘情绪模型权重自学习最小样本（marketEmotionModel spec §六） */
const LEARN_MIN_SAMPLE_EMO_WEIGHT = 20;
/** 情绪拐点自适应调整最小样本（sentimentTurningPoint） */
const LEARN_MIN_SAMPLE_TURNING = 15;

// ---------------------------------------------------------------------------
// 评级文案三档（全站唯一口径：禁止增持/减持/偏高/卖出等主观词）
// ---------------------------------------------------------------------------
const RATING_WORDS = ['低估', '合理', '高估'];
/** 合规禁用词（判定/建议文案层，全站扫描）：命中即违规（否定语境豁免） */
const FORBIDDEN_ADVICE_WORDS = ['建议买入', '建议卖出', '建议加仓', '建议减仓', '建议清仓', '建议仓位'];
/** 「目标价」单列：仅限估值计算语境（专属估值模型的情景/DCF 输出是估值结果，不是买卖建议）。
 *  扫描时按 PRICE_TARGET_EXEMPT_PREFIXES 路径豁免，其余位置出现即违规。 */
const PRICE_TARGET_WORD = '目标价';
/** 估值计算语境豁免（目标价=估值输出） */
const PRICE_TARGET_EXEMPT_PREFIXES = ['lib/valuation/', 'lib/deep/conclusion.js', 'prompts/broker-valuation-models.md', 'prompts/event-triage-system.md'];
/** 研报转述/分类语境豁免（券商研报原文含评级/目标价，转述事实非工作台建议）+ 本文件自身（禁词表定义处） */
const ADVICE_SCAN_FILE_EXEMPT = ['lib/ai/research.js', 'lib/ai/augmentStock.js', 'lib/eventEngine.js', 'lib/factStore.js', 'lib/industryAnalysis.js', 'lib/taxonomy.js'];

// ---------------------------------------------------------------------------
// 事件封顶系数（三联动权重再平衡：routine_monetary_policy 类型上限 moderate）
// ---------------------------------------------------------------------------
/** 事件影响评分上限（0~1 标量）：常规货币政策（降准/降息/加息/美联储议息）封顶值 */
const EVENT_IMPACT_CAP_ROUTINE_MONETARY = 0.5;

// ---------------------------------------------------------------------------
// 因子集（P2-3 因子相关性分析专用，20261112 收编至单源）
// ---------------------------------------------------------------------------
// 主因子集（inCluster:true，8 项）同源 getHistory 日K OHLCV，参与相关性聚类；
// warmup 取 scripts/analyze_factor_corr.js 的 computeFactors 实际阈值，数值与 P2-3 报告一致（1840 / 1720 / 236）。
// 快照因子（inCluster:false，4 项）仅 getQuote 快照 / 无逐日序列，不参与聚类：
//   pe_ttm / pb（仅 getQuote 快照，无历史序列）、turnover（腾讯主源不回传换手率，无 250 日序列）、
//   log_market_cap（无逐日股本序列 → 不加时间序列）。
const _FACTOR_RAW = [
  { key: 'mom_20d',       label: '20日动量',        src: 'getHistory.close',           warmup: 20, inCluster: true },
  { key: 'vol_20d',       label: '20日收益波动率',  src: 'getHistory.close 日收益',    warmup: 20, inCluster: true },
  { key: 'vol_ratio',     label: '量比',            src: 'getHistory.volume',          warmup: 19, inCluster: true },
  { key: 'ma_bias',       label: '均线偏离',        src: 'getHistory.close/MA20',      warmup: 20, inCluster: true },
  { key: 'rsi_14',        label: '14日RSI',         src: 'getHistory.close',           warmup: 14, inCluster: true },
  { key: 'macd_hist',     label: 'MACD柱',          src: 'getHistory.close',           warmup: 35, inCluster: true },
  { key: 'gap_20d',       label: '隔夜跳空',        src: 'getHistory.open/prevClose',  warmup: 1,  inCluster: true },
  { key: 'drawdown_20d',  label: '20日回撤',        src: 'getHistory.close',           warmup: 20, inCluster: true },
  { key: 'pe_ttm',        label: '市盈率TTM',       src: 'getQuote 快照',              warmup: 0,  inCluster: false },
  { key: 'pb',            label: '市净率',          src: 'getQuote 快照',              warmup: 0,  inCluster: false },
  { key: 'turnover',      label: '换手率',          src: 'getQuote 快照',              warmup: 0,  inCluster: false },
  { key: 'log_market_cap', label: '对数市值',       src: 'getQuote 快照',              warmup: 0,  inCluster: false },
];
const FACTOR_LIST = Object.freeze(_FACTOR_RAW.map(f => Object.freeze(f))); // 深度冻结：防 push 与属性改写

module.exports = {
  FLAT_TOLERANCE_STOCK, FLAT_TOLERANCE_INDEX,
  LEARN_MIN_SAMPLE_FACTOR, LEARN_MIN_SAMPLE_EMO_WEIGHT, LEARN_MIN_SAMPLE_TURNING,
  RATING_WORDS, FORBIDDEN_ADVICE_WORDS, PRICE_TARGET_WORD, PRICE_TARGET_EXEMPT_PREFIXES,
  ADVICE_SCAN_FILE_EXEMPT, EVENT_IMPACT_CAP_ROUTINE_MONETARY, FACTOR_LIST,
};
