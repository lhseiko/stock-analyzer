/**
 * lib/valuation/brokerModel.js —— 券商专属「分类+估值」运行器（确定性，20260908l）
 * ----------------------------------------------------------------
 * 闸门：仅当 data/valuation/{symbol}.json 存在且 kind==='broker' 时启用（其余公司一律不走本模块）。
 * 流程：6指标 → brokerClassification 三维评分+决策树 → 按类型匹配 brokerValuation 对应模型 → 组装展示明细。
 * 计算层=代码（纯四则+写死阈值/乘数），输入锁死 ⇒ 结果锁死（1+1=2）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { classify } = require('../brokerClassification');
const { valueByType } = require('../brokerValuation');

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
const fmt = (v, d = 2) => (v == null || !isFinite(Number(v))) ? 'N/A' : Number(v).toFixed(d);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);

function cfgPath(symbol) {
  return path.join(__dirname, '..', '..', 'data', 'valuation', `${String(symbol || '').replace(/^(sh|sz|bj)/i, '')}.json`);
}

/** 闸门：该标的是否配置了券商专属模型 */
function isBrokerModel(symbol) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(symbol), 'utf8'));
    return !!(cfg && cfg.kind === 'broker');
  } catch (e) { return false; }
}

function loadInputs(symbol) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(symbol), 'utf8'));
    if (!cfg || cfg.kind !== 'broker') return null;
    return cfg;
  } catch (e) { return null; }
}

const SCORE_LABELS = {
  scale: { 3: '大型全能', 2: '中型成长', 1: '中小型' },
  innovation: { 3: '高创新', 2: '中等创新', 1: '传统通道型' },
  diversification: { 3: '高度均衡', 2: '中度均衡', 1: '业务单一' },
};

/**
 * 主入口：运行券商分类+估值，返回与 601318 专属模型同构的 dedicated 结果（另带 broker:true）。
 * @param {string} symbol
 * @param {Object} opts { price: 实时价 }
 */
function run(symbol, opts = {}) {
  const cfg = loadInputs(symbol);
  if (!cfg) return { ok: false, error: 'NO_BROKER_MODEL' };
  const price = (opts.price != null && isFinite(Number(opts.price)) && Number(opts.price) > 0) ? Number(opts.price) : null;

  // ---- STEP2/3：分类（确定性）----
  const metricsPlain = {};
  for (const k of Object.keys(cfg.metrics || {})) metricsPlain[k] = nz(cfg.metrics[k] && cfg.metrics[k].value);
  const cls = classify(metricsPlain);
  if (!cls.ok) return { ok: false, error: 'CLASSIFY_FAIL', message: cls.message };
  const type = cls.type;

  // ---- 估值输入（含实时价注入）----
  const vi = {};
  for (const k of Object.keys(cfg.valuationInputs || {})) vi[k] = nz(cfg.valuationInputs[k] && cfg.valuationInputs[k].value);
  const params = cfg.params || {};

  let val, currentPB = null, extraNote = '';
  if (type === 'I') {
    currentPB = (price != null && vi.bps) ? price / vi.bps : null;
    val = valueByType('I', Object.assign({}, vi, {
      currentPB,
      costOfEquity: params.costOfEquity != null ? params.costOfEquity : 0.085,
      g: params.g != null ? params.g : 0.02,
    }));
  } else if (type === 'II') {
    val = valueByType('II', Object.assign({}, vi, { currentPrice: price }));
  } else {
    // 类型Ⅲ/Ⅳ模型输入尚未配置（后续个股接入时补配置文件即可，代码已就绪）
    return { ok: false, error: 'MODEL_INPUTS_NOT_CONFIGURED', message: `类型${type}（${cls.typeName}）的估值输入尚未在该标的配置文件中配置` };
  }
  if (!val || !val.ok) return { ok: false, error: 'VALUATION_FAIL', message: val && val.message };

  // ---- 评级：现价 vs 模型区间（确定性规则）----
  let rangeLow, rangeHigh, rating = 'N/A', ratingNote = '';
  if (type === 'I') {
    rangeLow = Math.min(nz(val.priceLow), nz(val.priceHigh));
    rangeHigh = Math.max(nz(val.priceLow), nz(val.priceHigh));
    if (price != null) {
      if (price < rangeLow) { rating = '低估'; ratingNote = '现价低于估值区间下限'; }
      else if (price > rangeHigh) { rating = '高估'; ratingNote = '现价高于估值区间上限'; }
      else { rating = '合理'; ratingNote = '现价处于估值区间内'; }
    }
  } else if (type === 'II') {
    rangeLow = val.stressRange ? val.stressRange[0] : null;
    rangeHigh = val.stressRange ? val.stressRange[1] : null;
    if (price != null && rangeLow != null && rangeHigh != null) {
      if (price < rangeLow) { rating = '低估'; ratingNote = '现价低于悲观情景下限'; }
      else if (price > rangeHigh) { rating = '高估'; ratingNote = '现价高于乐观情景上限'; }
      else { rating = '合理'; ratingNote = '现价处于悲观~乐观情景区间内'; }
    }
  }
  const center = (rangeLow != null && rangeHigh != null) ? r2((rangeLow + rangeHigh) / 2) : null;

  // ---- 展示明细组装 ----
  const metricsRows = Object.keys(cfg.metrics).map(k => ({
    label: { totalAssets: '总资产（综合实力）', netCapital: '净资本（监管抗风险）', brokerageRatio: '经纪业务收入占比', lightBizRatio: '投行+资管+财富占比（轻业务）', proprietaryRatio: '自营投资收入占比（重资本）', hhi: '收入集中度 HHI' }[k] || k,
    value: `${fmt(cfg.metrics[k].value, k === 'hhi' ? 4 : 2)}${cfg.metrics[k].unit ? ' ' + cfg.metrics[k].unit : ''}`,
    source: cfg.metrics[k].source || '',
  }));
  const scoreRows = [
    { label: '维度A 规模等级（S）', value: `${cls.scores.scale} 分（${SCORE_LABELS.scale[cls.scores.scale]}）`, source: '总资产≥5000亿且净资本≥800亿→3；≥2000亿→2；<2000亿→1' },
    { label: '维度B 创新业务占比（I）', value: `${cls.scores.innovation} 分（${SCORE_LABELS.innovation[cls.scores.innovation]}）`, source: '（投行+资管+财富）/营收 ≥45%→3；30%~45%→2；<30%→1' },
    { label: '维度C 业务多元化（D）', value: `${cls.scores.diversification} 分（${SCORE_LABELS.diversification[cls.scores.diversification]}）`, source: 'HHI<0.25→3；0.25~0.45→2；≥0.45→1' },
  ];
  const forced = metricsPlain.proprietaryRatio > 40;
  const decisionNote = forced
    ? `⚠️ 特殊判定生效：自营收入占比 ${fmt(metricsPlain.proprietaryRatio)}% > 40%，无论其他得分如何，强制归类为「类型Ⅱ 重资本自营型」。`
    : `决策树：自营占比 ${fmt(metricsPlain.proprietaryRatio)}%≤40%（非重资本）→ S=${cls.scores.scale}、I=${cls.scores.innovation}、D=${cls.scores.diversification} → 归类「类型${type} ${cls.typeName}」，推荐核心估值模型：${cls.primaryModel}。`;

  // 模型计算过程行（类型专属，全部由计算结果生成）
  let modelRows = [], modelSources = [];
  if (type === 'I') {
    const fairPB = val.fairPB, p10 = nz(vi.pbP10), p50 = nz(vi.pbP50), bps = nz(vi.bps), cost = params.costOfEquity != null ? params.costOfEquity : 0.085, g = params.g != null ? params.g : 0.02;
    modelRows = [
      { label: '理论合理PB', value: `(ROE−g)/(r−g) = (${fmt(vi.roeAvg3y * 100)}%−${fmt(g * 100)}%)/(${fmt(cost * 100)}%−${fmt(g * 100)}%) = ${fmt(fairPB)} 倍` },
      { label: '估值下限PB', value: `max(近5年PB 10%分位 ${fmt(p10)}, 合理PB×0.9=${fmt(fairPB * 0.9)}) = ${fmt(Math.max(p10, fairPB * 0.9))} 倍` },
      { label: '估值上限PB', value: `min(近5年PB 50%分位 ${fmt(p50)}, 合理PB×1.1=${fmt(fairPB * 1.1)}) = ${fmt(Math.min(p50, fairPB * 1.1))} 倍` },
      { label: '目标股价下限', value: `BPS ${fmt(bps)} × 估值下限PB = ${fmt(val.priceLow)} 元` },
      { label: '目标股价上限', value: `BPS ${fmt(bps)} × 估值上限PB = ${fmt(val.priceHigh)} 元` },
      { label: '当前股价 / 当前PB', value: price != null ? `${fmt(price)} 元 / ${fmt(currentPB)} 倍 → ${ratingNote}` : '实时价不可用' },
    ];
    modelSources = [
      { label: 'BPS（每股净资产）', source: (cfg.valuationInputs.bps && cfg.valuationInputs.bps.source) || '' },
      { label: '近5年PB 10%/50%分位', source: (cfg.valuationInputs.pbP10 && cfg.valuationInputs.pbP10.source) || '' },
      { label: '近3年平均ROE', source: (cfg.valuationInputs.roeAvg3y && cfg.valuationInputs.roeAvg3y.source) || '' },
      { label: '模型假设（写死）', source: params.costSource || '行业平均股权资本成本8.5%、永续增长率g=2%' },
    ];
  } else if (type === 'II') {
    const bpsBook = nz(vi.bpsBook), shares = nz(vi.shares), eqPos = nz(vi.equityProprietaryPositionTotal);
    const eqPosPS = shares ? eqPos / shares : null;
    modelRows = [
      { label: '账面每股净资产', value: `${fmt(bpsBook)} 元（2026中报）` },
      { label: '浮盈调整', value: `权益类/固收类浮盈未单独披露，按 0 处理 → 调整后BPS = ${fmt(val.adjBPS)} 元` },
      { label: '调整后PB中枢', value: `近3年PB中位数 = ${fmt(val.adjPbCenter)} 倍（浮盈按0 ⇒ 调整后PB=普通PB）` },
      { label: '基准情景（沪深300持平）', value: `调整后BPS ${fmt(val.adjBPS)} × 中枢 ${fmt(val.adjPbCenter)} = ${fmt(val.adjBPS * val.adjPbCenter)} 元` },
      { label: '悲观情景（沪深300 −15%）', value: `权益仓位 ${fmt(eqPos)} 亿 ÷ ${fmt(shares)} 亿股 = ${fmt(eqPosPS)} 元/股，浮盈缩水 ${fmt(eqPosPS * 0.15 * 0.85)} 元 → ${fmt(rangeLow)} 元（×中枢×0.95）` },
      { label: '乐观情景（沪深300 +10%）', value: `浮盈增厚 ${fmt(eqPosPS * 0.10 * 0.85)} 元 → ${fmt(rangeHigh)} 元（×中枢×1.05）` },
      { label: '加权目标价', value: `基准×50% + 悲观×25% + 乐观×25% = ${fmt(val.weightedTarget)} 元` },
      { label: '当前股价', value: price != null ? `${fmt(price)} 元 → ${ratingNote}` : '实时价不可用' },
    ];
    modelSources = [
      { label: '账面BPS / 总股本', source: `${(cfg.valuationInputs.bpsBook && cfg.valuationInputs.bpsBook.source) || ''}；${(cfg.valuationInputs.shares && cfg.valuationInputs.shares.source) || ''}` },
      { label: '调整后PB中枢', source: (cfg.valuationInputs.adjPbMedian3y && cfg.valuationInputs.adjPbMedian3y.source) || '' },
      { label: '权益自营仓位', source: (cfg.valuationInputs.equityProprietaryPositionTotal && cfg.valuationInputs.equityProprietaryPositionTotal.source) || '' },
      { label: '浮盈口径', source: '权益类/固收类浮盈未单独披露 → 按0处理（中性：不剔除浮盈）' },
    ];
  }

  return {
    ok: true,
    symbol: cfg.symbol, kind: 'broker', broker: true,
    model: 'brokerClassify_v1（确定性计算，无AI参与）', ver: 'DEDICATED',
    date: new Date().toISOString(),
    reportLabel: `${cfg.metricsBaseLabel} · 每股/净资产取最新一期`,
    reportDate: cfg.metricsReportDate,
    type, typeName: cls.typeName,
    primaryModel: cls.primaryModel, auxModel: cls.auxModel,
    rating, fairValueRange: (rangeLow != null && rangeHigh != null) ? [r2(rangeLow), r2(rangeHigh)] : null,
    fairValueCenter: center,
    currentPrice: price != null ? r2(price) : null, currentPB: currentPB != null ? r2(currentPB) : null,
    metricsRows, scoreRows, decisionNote, modelRows, modelSources,
    riskPoint: cls.riskPoint,
    valuation: val,
    methodsUsed: [`类型${type}·${cls.typeName}`, cls.primaryModel.replace(/（.*?）/g, '')],
  };
}

module.exports = { isBrokerModel, loadInputs, run };
