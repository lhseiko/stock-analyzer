/**
 * lib/deep/conclusion.js —— deepAnalysis 领域子模块：估值综合结论生成（generateConclusion + 文案）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 单独成文件原因：原主流程块近 940 行超出粒度上限，且「估值综合结论」与「主流程编排」是两个内聚职责。
 * generateConclusionText 仅被 generateConclusion 内部调用，不导出。
 */
const { fmtPrice, fmtPct, toYi } = require('./shared');
const { formatValuationLine } = require('../valuationHub');

// ---- 估值结论生成 ----
function generateConclusion(dcf, valuation, growth, cashFlowData, revenueCostData, balanceAnalysis, auditOpinion, shareholders, companyType, dividends, quote, insuranceAnalysis) {
  const methods = [];
  const ratings = []; // Each: { method, rating, detail, weight }
  const currentPrice = quote?.price || dcf?.currentPrice || 0;
  const ct = companyType?.type || 'balanced';
  // 计算每股指标（用于把 PE/PB/PS 估值带换算为价格级合理估值区间）
  const latestVal = valuation?.valuationData?.[valuation.valuationData.length - 1];
  const totalSharesFV = shareholders?.totalShares || quote?.fundamentals?.totalShares || quote?.totalShares || 0;
  let eps = 0, bvps = 0;
  // 优先用当前PE(TTM)反推EPS，保证与「当前PE(TTM)」口径一致；否则 fallback 到最近年报净利润/总股本
  if (currentPrice > 0 && valuation?.currentPeTtm > 0) {
    eps = currentPrice / valuation.currentPeTtm;
  } else if (latestVal && totalSharesFV > 0) {
    // latestVal.netProfit/netAssets 已转为「亿」(÷1e8)，换算回「元」再 ÷ 股数
    eps = (latestVal.netProfit * 1e8) / totalSharesFV;
  }
  if (latestVal && totalSharesFV > 0) {
    bvps = (latestVal.netAssets * 1e8) / totalSharesFV;
  }
  const ctName = companyType?.typeName || '均衡型';
  const weights = companyType?.weights || { valuation: 25, profitability: 25, growth: 25, health: 25 };
  const isInsurance = !!(insuranceAnalysis && insuranceAnalysis.isInsurance);
  const revenueGrowth = companyType?.classificationData?.revenueGrowth || 0;
  const isHighGrowth = !isInsurance && revenueGrowth >= 20;
  const isLowGrowth = !isInsurance && revenueGrowth < 20;

  // 1. DCF 估值法：非保险企业仅保留 PE 估值带，DCF/PB/股息率不再纳入估值方法与综合区间（dcf 对象仍用于结论文本中的参数展示）。

  // 1b. 保险公司专属估值：P/EV + DDM（与 DCF 并行参与综合评分）
  if (isInsurance && insuranceAnalysis.sections) {
    const { pevValuation, ddmValuation } = insuranceAnalysis.sections;
    if (pevValuation && pevValuation.currentPEV > 0) {
      methods.push('P/EV内含价值');
      const pev = pevValuation.currentPEV;
      const pevRating = pev < 0.8 ? '低估' : pev < 1.5 ? '合理' : pev < 2.0 ? '偏高' : '高估';
      // 每股内含价值 = 股价 / P/EV（P/EV=1.0 时的合理股价锚）
      const perShareEV = (currentPrice > 0 && pev > 0) ? Math.round((currentPrice / pev) * 100) / 100 : 0;
      ratings.push({
        method: 'P/EV内含价值',
        rating: pevRating,
        detail: `当前P/EV ${pev.toFixed(2)}；${pevValuation.interpretation}`,
        weight: 0.35,
        fairValue: perShareEV,
      });
    }
    if (ddmValuation && ddmValuation.intrinsicValue > 0) {
      methods.push('DDM股息贴现');
      ratings.push({
        method: 'DDM股息贴现',
        rating: ddmValuation.rating,
        detail: `两阶段DDM内在价值 ¥${ddmValuation.intrinsicValue.toFixed(2)}，较现价${ddmValuation.premium > 0 ? '高估' : '低估'}${Math.abs(ddmValuation.premium).toFixed(1)}%。`,
        weight: 0.25,
        fairValue: Math.round(ddmValuation.intrinsicValue * 100) / 100,
      });
    }
  }

  // 2. PE 估值带法
  // 非保险企业均以 PE 为核心估值锚：低增长企业 PE 占绝对主导，高增长企业 PE/PB/DCF 均衡。
  const peStats = valuation?.peStats;
  if (peStats && peStats.mean > 0 && !isInsurance) {
    // 当前 PE 采用行情 TTM 口径（currentPeTtm），不再停留在最近年报静态 PE
    const latestPE = valuation?.currentPeTtm || valuation.valuationData[valuation.valuationData.length - 1]?.pe || 0;
    if (latestPE > 0) {
      let rating, label;
      const epsNote = eps > 0 ? `；按当前PE反推每股收益(TTM)约¥${eps.toFixed(2)}` : '';
      if (latestPE < peStats.low) { rating = '低估'; label = `当前PE ${latestPE}，低于历史-1σ区间(${peStats.low})，估值偏低${epsNote}`; }
      else if (latestPE <= peStats.high) { rating = '合理'; label = `当前PE ${latestPE}，处于历史均值±1σ区间(${peStats.low}~${peStats.high})内，估值合理${epsNote}`; }
      else if (latestPE <= peStats.mean * 1.5) { rating = '偏高'; label = `当前PE ${latestPE}，高于历史+1σ(${peStats.high})，估值偏高${epsNote}`; }
      else { rating = '高估'; label = `当前PE ${latestPE}，远高于历史均值(${peStats.mean})，估值过高${epsNote}`; }
      // 规则一②/规则二：补数据来源与数据时间；规则三：补方向、幅度与边际
      const rPE = valuation.rules && valuation.rules.latest && valuation.rules.latest.pe;
      const aPE = valuation.rules && valuation.rules.analysis && valuation.rules.analysis.PE;
      if (rPE) label += `；数据来源 ${rPE.source}，数据时间 ${rPE.dataTime}`;
      if (aPE && aPE.available) label += `；${aPE.direction}，变化率 ${aPE.changeRate}%，边际 ${aPE.marginal}，${aPE.accel}`;
      const peFairLow = eps > 0 ? Math.round(eps * peStats.low * 100) / 100 : 0;
      const peFairHigh = eps > 0 ? Math.round(eps * peStats.high * 100) / 100 : 0;
      const peFairMean = eps > 0 ? Math.round(eps * peStats.mean * 100) / 100 : 0;
      methods.push('PE估值带');
      const peWeight = isLowGrowth
        ? (ct === 'dividend' ? 0.45 : 0.55)
        : (ct === 'growth' ? 0.35 : ct === 'value' ? 0.35 : ct === 'dividend' ? 0.40 : 0.35);
      ratings.push({ method: 'PE估值带', rating, detail: label, weight: peWeight, fairValue: peFairMean, fairValueRange: [peFairLow, peFairHigh] });
    }
  }

  // 3. PB 估值带法（非保险企业仅作图表展示，不再纳入估值方法与综合区间）

  // 4. PS 估值带法
  // 所有非保险企业均不以 PS 作为估值依据：低增长企业以 PE 为主，高增长企业使用 PE/PB/DCF。
  // PS 统计仍保留供估值图表展示，但不参与综合评级与合理估值区间计算。
  const psStats = valuation?.psStats;

  // 5. Dividend yield analysis（非保险企业仅作图表展示，不再纳入估值方法与综合区间）

  // 汇总各方法的「价格级合理估值」用于综合区间
  // 保险公司：P/EV + DDM 纳入综合区间；非保险企业：仅采用 PE 估值带（DCF/PB 偏差过大）
  const fairPoints = [];
  for (const r of ratings) {
    if (r.fairValue != null && r.fairValue > 0) {
      if (isInsurance && r.method === 'DCF现金流折现') continue;
      if (!isInsurance && r.method !== 'PE估值带') continue;
      const low = (r.fairValueRange && r.fairValueRange[0] != null) ? r.fairValueRange[0] : r.fairValue;
      const high = (r.fairValueRange && r.fairValueRange[1] != null) ? r.fairValueRange[1] : r.fairValue;
      fairPoints.push({ method: r.method, price: r.fairValue, low, high });
    }
  }
  let fairValueRange = null, fairValueCenter = null;
  if (fairPoints.length > 0) {
    const prices = fairPoints.map(p => p.price).sort((a, b) => a - b);
    fairValueCenter = Math.round(prices[Math.floor(prices.length / 2)] * 100) / 100;
    const lows = fairPoints.map(p => p.low).sort((a, b) => a - b);
    const highs = fairPoints.map(p => p.high).sort((a, b) => a - b);
    fairValueRange = [Math.round(lows[0] * 100) / 100, Math.round(highs[highs.length - 1] * 100) / 100];
  }

  // 综合评级 (weighted by company type)
  const scoreMap = { '低估': -1, '合理': 0, '偏高': 1, '高估': 2 };
  const reverseMap = { '-1': '低估', '0': '合理', '1': '偏高', '2': '高估' };
  const validRatings = ratings.filter(r => r.rating);
  if (validRatings.length > 0) {
    // Weighted average
    const totalWeight = validRatings.reduce((s, r) => s + (r.weight || 0.25), 0);
    const weightedScore = validRatings.reduce((s, r) => s + scoreMap[r.rating] * (r.weight || 0.25), 0) / totalWeight;
    let overallRating;
    if (weightedScore <= -0.5) overallRating = '低估';
    else if (weightedScore <= 0.5) overallRating = '合理';
    else if (weightedScore <= 1.5) overallRating = '偏高';
    else overallRating = '高估';

    // 生成综合结论文本 (with company type focus)
    const conclusionText = generateConclusionText(overallRating, currentPrice, dcf, valuation, growth, cashFlowData, revenueCostData, auditOpinion, validRatings, companyType, dividends, quote, insuranceAnalysis, fairValueCenter, fairValueRange);

    return {
      overallRating,
      currentPrice,
      methodsUsed: methods,
      ratings,
      conclusionText,
      fairValueRange,
      fairValueCenter,
      companyType: ct,
      companyTypeName: ctName,
    };
  }

  return { overallRating: '数据不足', currentPrice, methodsUsed: methods, ratings: [], conclusionText: '估值数据不足，无法生成结论。', companyType: ct, companyTypeName: ctName };
}

function generateConclusionText(rating, price, dcf, valuation, growth, cashFlowData, revenueCostData, auditOpinion, ratings, companyType, dividends, quote, insuranceAnalysis, fairValueCenter, fairValueRange) {
  const parts = [];
  const ct = companyType?.type || 'balanced';
  const ctName = companyType?.typeName || '均衡型';
  const ctIcon = companyType?.typeIcon || '⚖️';

  const isInsurance = !!(insuranceAnalysis && insuranceAnalysis.isInsurance);
  const revenueGrowth = companyType?.classificationData?.revenueGrowth || 0;
  const isHighGrowth = !isInsurance && revenueGrowth >= 20;
  const isLowGrowth = !isInsurance && revenueGrowth < 20;

  // 0. 公司类型说明
  parts.push(`${ctIcon} 公司类型：${ctName} — ${companyType?.description || ''}`);
  parts.push(`📊 分析重点：${companyType?.focusText || '各维度均衡评估'}\n`);
  if (isInsurance) {
    parts.push('🏦 保险股估值提示：保险公司负债驱动、现金流特殊，本估值仅采用 P/EV（内含价值）与 DDM（股息贴现模型），PE/PB/PS/DCF 等其他模型不参与估值。\n');
  } else if (isLowGrowth) {
    parts.push(`📉 估值提示：该股近 ${growth ? growth.baseYear + '年至' + growth.latestYear + '年' : '期'}营收累计增长 ${revenueGrowth}%（<20%），属于低增长企业，估值以 PE 为主、PB/DCF 为辅，PS 不参与估值。\n`);
  } else if (isHighGrowth) {
    parts.push(`📈 估值提示：该股近 ${growth ? growth.baseYear + '年至' + growth.latestYear + '年' : '期'}营收累计增长 ${revenueGrowth}%（≥20%），属于高增长企业，估值使用 PE/PB/DCF 综合判断，PS 不参与估值。\n`);
  }

  // 1. 估值结论
  const ratingColor = { '低估': '🔴', '合理': '🟡', '偏高': '🟠', '高估': '🟢' };
  parts.push(`${ratingColor[rating] || '⚪'} 综合估值评级：${rating}（加权综合，按${ctName}权重分配）`);

  // 2. 各方法结论 (with weight info)
  for (const r of ratings) {
    const wPct = Math.round((r.weight || 0.25) * 100);
    let fairText = '';
    if (r.fairValueRange && (r.fairValueRange[1] - r.fairValueRange[0] > 0.005)) {
      fairText = ` ｜ 合理估值区间 ¥${fmtPrice(r.fairValueRange[0])} ~ ¥${fmtPrice(r.fairValueRange[1])}`;
    } else if (r.fairValue != null && r.fairValue > 0) {
      fairText = ` ｜ 合理估值 ¥${fmtPrice(r.fairValue)}`;
    }
    parts.push(`【${r.method}】(权重${wPct}%) ${r.detail}${fairText}`);
  }

  // 2.5 综合合理估值区间
  if (fairValueRange && fairValueRange[0] > 0) {
    const vsCenter = price > 0 ? Math.round((price / fairValueCenter - 1) * 10000) / 100 : 0;
    parts.push(`💰 综合合理估值区间：¥${fmtPrice(fairValueRange[0])} ~ ¥${fmtPrice(fairValueRange[1])}（中枢 ¥${fmtPrice(fairValueCenter)}）。当前价 ¥${fmtPrice(price)}，较中枢${vsCenter >= 0 ? '高' : '低'}${fmtPct(Math.abs(vsCenter))}，属于${vsCenter >= 0 ? '偏高' : '偏低'}区间。`);
  }

  // 3. DCF 详情
  if (dcf && !dcf.error) {
    parts.push(`DCF模型参数：基础自由现金流${dcf.baseFCF}亿，预测增长率${dcf.projectedGrowth}%，折现率${dcf.discountRate}%，永续增长率${dcf.perpetualGrowth}%。企业价值${dcf.enterpriseValue}亿，股权价值${dcf.equityValue}亿，每股内在价值¥${fmtPrice(dcf.perShareValue)}。`);
  }

  // 4. 增长情况
  if (growth) {
    parts.push(`成长性：${growth.baseYear}年至${growth.latestYear}年，营收增长${growth.revenueGrowth}%，净利润增长${growth.profitGrowth}%。`);
  }

  // 5. 现金流质量
  if (cashFlowData && cashFlowData.length >= 2) {
    const latest = cashFlowData[cashFlowData.length - 1];
    const prev = cashFlowData[cashFlowData.length - 2];
    const ocf = latest.operatingCashFlow;
    const np = latest.netProfit;
    if (np > 0) {
      const ratio = (ocf / np * 100).toFixed(1);
      if (ocf >= np) {
        parts.push(`现金流质量：最新经营现金流净额${ocf}亿，净利润${np}亿，现金流/净利润=${ratio}%，现金流充足，盈利质量高。`);
      } else {
        parts.push(`现金流质量：最新经营现金流净额${ocf}亿，净利润${np}亿，现金流/净利润=${ratio}%，需关注盈利质量。`);
      }
    }
  }

  // 6. 毛利率趋势
  if (revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    const first = revenueCostData[0];
    const marginTrend = latest.grossMargin - first.grossMargin;
    if (Math.abs(marginTrend) > 2) {
      parts.push(`毛利率${marginTrend > 0 ? '上升' : '下降'}：从${first.year}年${first.grossMargin}%变动至${latest.year}年${latest.grossMargin}%。`);
    }
  }

  // 7. 审计意见
  if (auditOpinion && !auditOpinion.includes('标准无保留')) {
    parts.push(`⚠️ 审计意见异常：${auditOpinion}，请重点关注财务真实性风险！`);
  } else if (auditOpinion) {
    parts.push(`审计意见：${auditOpinion}，财务数据可信。`);
  }

  // 7.5 公司类型差异化分析
  if (ct === 'growth' && revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    const first = revenueCostData[0];
    parts.push(`\n📈 【增长型分析】`);
    parts.push(`营收增速：最新${fmtPct(latest.revenueYoy || 0)}，${first.year}至${latest.year}年营收从${first.revenue}亿增至${latest.revenue}亿。`);
    // 非保险企业均不以 PS 作为估值依据，仅作参考展示。
    if (valuation?.psStats) {
      const latestPS = valuation.valuationData[valuation.valuationData.length - 1]?.ps || 0;
      const rel = latestPS < valuation.psStats.mean ? '低于' : '高于';
      const ruleLinePS = formatValuationLine(valuation.rules, 'PS');
      // 规则合规优先；无快照时回退原静态描述
      parts.push(ruleLinePS
        ? `市销率(PS)：${ruleLinePS}；历史均值${valuation.psStats.mean}，${rel}历史中枢（仅参考，不参与估值）。`
        : `市销率(PS)：当前${latestPS}，历史均值${valuation.psStats.mean}，${rel}历史中枢（仅参考，不参与估值）。`);
    }
    if (latest.profitYoy) {
      parts.push(`利润增速：${fmtPct(latest.profitYoy)}，${latest.profitYoy > latest.revenueYoy ? '利润增速>营收增速，盈利能力提升' : '利润增速<营收增速，需关注盈利质量'}。`);
    }
  } else if (ct === 'value' && revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    parts.push(`\n💎 【价值型分析】`);
    parts.push(`估值锚点：低增长价值股以市盈率(PE)为核心估值指标，PB、DCF 仅作交叉验证。`);
    if (valuation?.peStats) {
      const latestPE = valuation?.currentPeTtm || valuation.valuationData[valuation.valuationData.length - 1]?.pe || 0;
      const zone = latestPE < valuation.peStats.low ? '低估区间' : latestPE > valuation.peStats.high ? '偏高区间' : '合理区间';
      // 规则合规优先：数值 + 来源 + 数据时间 + 方向/幅度/边际；无快照时回退原静态描述
      const ruleLine = formatValuationLine(valuation.rules, 'PE');
      if (ruleLine) {
        parts.push(`市盈率(PE)：${ruleLine}；历史均值${valuation.peStats.mean}，处于${zone}。`);
      } else {
        const peTag = valuation?.currentPeTtm ? `（TTM，来源：${valuation.peSource || '行情'}）` : '';
        parts.push(`市盈率(PE)：当前${latestPE}${peTag}，历史均值${valuation.peStats.mean}，处于${zone}。`);
      }
    }
    if (latest.netMargin) parts.push(`净利率：${latest.netMargin}%，${latest.netMargin > 15 ? '盈利能力强' : latest.netMargin > 8 ? '盈利能力中等' : '需关注盈利能力'}。`);
    if (latest.grossMargin) parts.push(`毛利率：${latest.grossMargin}%，${latest.grossMargin > 30 ? '具有较强定价权' : '毛利率一般'}。`);
  } else if (ct === 'dividend' && dividends && dividends.length > 0) {
    parts.push(`\n💰 【红利型分析】`);
    // Find the most recent record with non-zero dividendPerShare
    let validDiv = null;
    for (const d of dividends) {
      if (d?.dividendPerShare && d.dividendPerShare > 0) { validDiv = d; break; }
    }
    const divYield = quote?.price > 0 && validDiv ? (validDiv.dividendPerShare / quote.price * 100) : 0;
    parts.push(`股息率：当前约${divYield.toFixed(2)}%，${divYield >= 5 ? '高股息率，红利价值突出' : divYield >= 3 ? '股息率合理，具有红利价值' : '股息率偏低'}。`);
    const divYears = new Set(dividends.map(d => d.year).filter(y => y)).size;
    parts.push(`分红历史：已连续分红${divYears}年，${divYears >= 5 ? '分红历史较长，可持续性较好' : divYears >= 3 ? '分红历史中等' : '分红历史较短，需关注可持续性'}。`);
    if (revenueCostData && revenueCostData.length > 0) {
      const latest = revenueCostData[revenueCostData.length - 1];
      if (latest.netProfit > 0 && validDiv) {
        const divYi = validDiv.dividend ? toYi(validDiv.dividend) : 0;
        const payoutRatio = divYi / latest.netProfit * 100;
        parts.push(`派息率：约${payoutRatio.toFixed(1)}%，${payoutRatio < 50 ? '派息率适中，分红可持续性好' : payoutRatio < 80 ? '派息率偏高' : '派息率过高，需关注分红可持续性'}。`);
      }
    }
  }

  // 8. 综合建议 (type-specific)
  if (rating === '低估') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前股价处于历史估值低位，结合公司增长潜力和PS估值，具备成长投资价值。建议关注营收增速是否可持续，逢低布局。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：当前股息率较高，估值偏低，具备较好的红利投资价值。建议关注分红可持续性和公司盈利稳定性，适合长期持有收息。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：当前PE处于历史低位，基本面稳健，具备价值投资价值。建议关注ROE是否能维持，逢低布局。`);
    } else {
      parts.push(`💡 综合建议：当前股价处于历史估值低位区间，结合DCF内在价值分析，股价具备投资价值。建议关注基本面变化，适时布局。`);
    }
  } else if (rating === '合理') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前估值处于合理区间，营收增长强劲。建议持有或逢低加仓，重点跟踪季度营收增速变化。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股息率处于合理水平，分红可持续。适合作为底仓长期持有，享受稳定分红收益。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE估值合理，基本面与估值匹配。建议持有，关注业绩增长是否可持续。`);
    } else {
      parts.push(`💡 综合建议：当前股价处于合理估值区间，基本面与估值匹配。建议持有或逢低布局，关注业绩增长是否可持续。`);
    }
  } else if (rating === '偏高') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前PS估值偏高，市场对增长预期较高。建议谨慎追高，若营收增速不达预期可能面临戴维斯双杀风险。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股息率偏低，估值偏高。红利投资价值减弱，建议等待回调后再考虑介入。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE偏高，估值溢价较多。建议谨慎追高，等待回调后再考虑介入。`);
    } else {
      parts.push(`💡 综合建议：当前股价估值偏高，存在一定回调风险。建议谨慎追高，等待回调后再考虑介入。`);
    }
  } else if (rating === '高估') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：PS估值过高，市场已透支未来增长预期。建议控制仓位，警惕估值回归风险。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股价过高导致股息率过低，红利投资价值已不明显。建议减仓或观望。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE远高于历史中枢，估值过高。建议控制仓位，避免追高，关注估值回归。`);
    } else {
      parts.push(`💡 综合建议：当前股价明显高估，回调风险较大。建议控制仓位，避免追高，关注估值回归。`);
    }
  }

  return parts.join('\n');
}

module.exports = { generateConclusion };
