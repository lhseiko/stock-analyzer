/**
 * lib/brokerValuation.js —— 券商 4 类估值模型（确定性计算层）
 * ----------------------------------------------------------------
 * 用户 2026-09-08 确立，与 601318 专属模型、brokerClassification 同一原则：
 * 计算层=代码（纯四则+固定乘数/阈值），不依赖 AI；输入锁死 ⇒ 结果锁死（1+1=2）。
 *
 * 四类画像 → 对应估值模型（详见 prompts/broker-valuation-models.md 的 AI 叙述版）：
 *   类型Ⅰ 传统通道型中小券商  → valueTypeI   单一PB（PB-ROE修正）
 *   类型Ⅱ 重资本自营型券商    → valueTypeII  调整后PB + 市场敏感性测试
 *   类型Ⅲ 精品投行/财富管理型 → valueTypeIII PE（主）+ RIM（辅）
 *   类型Ⅳ 综合航母均衡型      → valueTypeIV  SOTP 分部加总
 *
 * 单位约定：金额默认「亿元」，股价/BPS 默认「元/股」，占比为百分点(%)、HHI 为 0~1。
 */
'use strict';
const { classify } = require('./brokerClassification');

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

// ============ 类型Ⅰ：单一PB（PB-ROE 修正模型） ============
function valueTypeI(inp) {
  const bps = Number(inp.bps);
  const pbMedian5y = Number(inp.pbMedian5y); // 近5年PB历史中位数（倍数）
  const pbP10 = Number(inp.pbP10);           // 近5年PB 10%分位（倍数）
  const pbP50 = Number(inp.pbP50);           // 近5年PB 50%分位（倍数）
  const roeAvg3y = Number(inp.roeAvg3y);     // 近3年平均ROE（小数，如0.06）
  const cost = inp.costOfEquity != null ? Number(inp.costOfEquity) : 0.085; // 行业股权资本成本
  const g = inp.g != null ? Number(inp.g) : 0.02;                            // 永续增长（通胀）
  const currentPB = inp.currentPB != null ? Number(inp.currentPB) : null;

  const fairPB = (roeAvg3y - g) / (cost - g);
  const low = Math.max(pbP10, fairPB * 0.9);
  const high = Math.min(pbP50, fairPB * 1.1);
  const priceLow = bps * low;
  const priceHigh = bps * high;

  let undervalued = null, note = '';
  if (currentPB != null) {
    if (currentPB < low) { undervalued = true; note = '当前PB低于估值下限，处于低估区间'; }
    else if (currentPB > high) { undervalued = false; note = '当前PB高于估值上限，处于高估区间'; }
    else { undervalued = '中性'; note = '当前PB处于估值区间内，合理'; }
  }
  const brokenNet = currentPB != null && currentPB < 1;
  return {
    ok: true, type: 'I', model: '单一PB（PB-ROE修正）',
    fairPB: r2(fairPB),
    rangeLowPB: r2(low), rangeHighPB: r2(high),
    priceLow: r2(priceLow), priceHigh: r2(priceHigh),
    undervalued,
    note: (brokenNet ? '当前已破净（PB<1），属深度价值区间。' : '') + note,
    risk: '该估值对市场日均成交量（ADT）敏感，若ADT环比下滑超15%，需下调ROE预期并重算。',
  };
}

// ============ 类型Ⅱ：调整后PB + 市场敏感性测试 ============
// 注：提示词中「浮盈总额/仓位」为全公司总额（亿元），需除以总股本（亿股）转成每股口径后再参与每股净资产计算。
function valueTypeII(inp) {
  const bpsBook = Number(inp.bpsBook);                 // 账面每股净资产（元/股）
  const shares = Number(inp.shares);                   // 总股本（亿股）
  const eqGainTotal = Number(inp.equityUnrealizedGainTotal);   // 权益类账面浮盈（亿元，已扣递延所得税）
  const fiGainTotal = Number(inp.fixedIncomeUnrealizedGainTotal); // 固收类账面浮盈（亿元）
  const adjPb = Number(inp.adjPbMedian3y);             // 历史3年调整后PB中枢（乘数）
  const eqPosTotal = Number(inp.equityProprietaryPositionTotal); // 权益自营仓位（亿元）
  const currentPrice = inp.currentPrice != null ? Number(inp.currentPrice) : null;

  const eqGainPS = eqGainTotal / shares;
  const fiGainPS = fiGainTotal / shares;
  const eqPosPS = eqPosTotal / shares;

  const adjBPS = bpsBook - eqGainPS * 0.85 - fiGainPS * 1.0;
  const base = adjBPS * adjPb;
  // 悲观：沪深300 -15% → 权益浮盈缩水约 15%×仓位（85%税调）
  const adjBPS_pess = adjBPS - eqPosPS * 0.15 * 0.85;
  const pess = adjBPS_pess * adjPb * 0.95;
  // 乐观：沪深300 +10%
  const adjBPS_opt = adjBPS + eqPosPS * 0.10 * 0.85;
  const opt = adjBPS_opt * adjPb * 1.05;
  const weighted = base * 0.5 + pess * 0.25 + opt * 0.25;

  const bookPB = currentPrice != null && bpsBook ? currentPrice / bpsBook : null;
  return {
    ok: true, type: 'II', model: '调整后PB + 市场敏感性测试',
    bookPB: bookPB != null ? r2(bookPB) : null,
    adjPbCenter: r2(adjPb),
    adjBPS: r2(adjBPS),
    stressRange: [r2(pess), r2(opt)],
    weightedTarget: r2(weighted),
    risk: '若十年期国债利率上行超过50BP，债券自营浮盈将快速缩水，需重新触发该模型。',
  };
}

// ============ 类型Ⅲ：PE（主）+ RIM（辅） ============
function valueTypeIII(inp) {
  const eps = Number(inp.eps);
  const cagr = Number(inp.epsCAGR);     // 未来3年EPS复合增长率（小数）
  const roe = Number(inp.roe);
  const industryAvgRoe = Number(inp.industryAvgRoe);
  const industryAvgPE = inp.industryAvgPE != null ? Number(inp.industryAvgPE) : 16; // A股证券行业PE中位数
  const bps0 = Number(inp.bps);
  const cost = inp.costOfEquity != null ? Number(inp.costOfEquity) : 0.095;
  const gTerm = 0.03;

  const growthAdj = cagr > 0.20 ? 1.1 : (cagr >= 0.10 ? 1.0 : 0.9);
  const fairPE = industryAvgPE * (roe / industryAvgRoe) * growthAdj;
  const peTarget = eps * fairPE;

  const epsArr = [Number(inp.eps1), Number(inp.eps2), Number(inp.eps3)]; // 未来3年预测EPS
  const bpsPath = [Number(inp.bps0), Number(inp.bps1), Number(inp.bps2)]; // 各年期初BPS（t-1）
  let pv = 0;
  for (let t = 1; t <= 3; t++) {
    const ri = epsArr[t - 1] - cost * (t === 1 ? bps0 : bpsPath[t - 2]);
    pv += ri / Math.pow(1 + cost, t);
  }
  const ri3 = epsArr[2] - cost * bpsPath[1];
  const tv = ri3 * (1 + gTerm) / (cost - gTerm) / Math.pow(1 + cost, 3);
  const rimValue = bps0 + pv + tv;

  const finalPrice = peTarget * 0.6 + rimValue * 0.4;
  return {
    ok: true, type: 'III', model: 'PE（主）+ RIM（辅）',
    fairPE: r2(fairPE),
    peTarget: r2(peTarget),
    rimValue: r2(rimValue),
    finalPrice: r2(finalPrice),
    finalRange: [r2(finalPrice * 0.95), r2(finalPrice * 1.05)],
    risk: '若该公司代销金融产品（基金销售）市占率发生重大变化，需同步上调或下调RIM中的永续增长率g。',
  };
}

// ============ 类型Ⅳ：SOTP 分部加总 ============
function valueTypeIV(inp) {
  const R_credit = Number(inp.R_credit);     // 经纪与信用净资产（亿元）
  const E_IB = Number(inp.E_IB);             // 投行净利润（亿元）
  const E_AM = Number(inp.E_AM);             // 资管与财富净利润（亿元）
  const R_principal = Number(inp.R_principal); // 自营投资净资产（亿元）
  const R_other = Number(inp.R_other);       // 其他净资产（亿元）
  const D_corp = Number(inp.D_corp);         // 集团总部净债务（亿元）
  const shares = Number(inp.totalShares);    // 总股本（亿股）

  const mCredit = 1.1, mIB = 16.5, mAM = 22.5, mPrincipal = 1.0, mOther = 1.0;
  const V_credit = R_credit * mCredit;
  const V_IB = E_IB * mIB;
  const V_AM = E_AM * mAM;
  const V_principal = R_principal * mPrincipal;
  const V_other = R_other * mOther;
  const total = V_credit + V_IB + V_AM + V_principal + V_other - D_corp;
  const perShare = total / shares;
  const low = (R_credit * mCredit * 0.95 + E_IB * mIB * 0.95 + E_AM * mAM * 0.95 + R_principal * mPrincipal * 0.95 + R_other * mOther * 0.95 - D_corp) / shares;
  const high = (R_credit * mCredit * 1.05 + E_IB * mIB * 1.05 + E_AM * mAM * 1.05 + R_principal * mPrincipal * 1.05 + R_other * mOther * 1.05 - D_corp) / shares;

  const breakdown = [
    { name: '经纪与信用', value: r2(V_credit) },
    { name: '投行', value: r2(V_IB) },
    { name: '资管与财富', value: r2(V_AM) },
    { name: '自营投资', value: r2(V_principal) },
    { name: '其他', value: r2(V_other) },
  ];
  return {
    ok: true, type: 'IV', model: 'SOTP 分部加总',
    breakdown,
    totalMarketCap: r2(total),
    perShare: r2(perShare),
    range: [r2(low), r2(high)],
    risk: '该模型高度依赖投行IPO及再融资节奏，若审核政策收紧，需同步下调V_IB乘数至12倍。',
  };
}

function valueByType(type, inp) {
  if (type === 'I') return valueTypeI(inp);
  if (type === 'II') return valueTypeII(inp);
  if (type === 'III') return valueTypeIII(inp);
  if (type === 'IV') return valueTypeIV(inp);
  return { ok: false, error: 'UNKNOWN_TYPE', message: `未知券商类型：${type}` };
}

/**
 * 组合入口：先分类，再按类型估值。
 * @param {Object} metrics 6 核心指标（见 brokerClassification）
 * @param {Object} valuationInputs 对应类型的估值输入（见各 valueTypeX）
 */
function classifyAndValue(metrics, valuationInputs) {
  const cls = classify(metrics);
  if (!cls.ok) return cls;
  const val = valueByType(cls.type, valuationInputs || {});
  return Object.assign({}, cls, { valuation: val });
}

module.exports = { valueTypeI, valueTypeII, valueTypeIII, valueTypeIV, valueByType, classifyAndValue };
