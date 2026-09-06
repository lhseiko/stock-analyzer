/**
 * lib/deep/conclusions.js —— deepAnalysis 领域子模块：各分析小节「结论 + 论证」生成（财务/估值/分红/保险 7 节）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 全部 build* 与 analyzeRoeMarginTrend 导出供 deep/pipeline 的 augmentSections 装配使用；
 * segmentTopItems 仅内部复用，不导出。
 */
const { fmtPrice, fmtPct } = require('./shared');
const { formatValuationLine } = require('../valuationHub');

// ---- 各分析小节「结论 + 论证」生成（Feature: 结论与论证过程） ----
function buildRevenueConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const first = rc[0];
  const trend = latest.revenue >= first.revenue ? '上升' : '下降';
  const gmChg = (typeof latest.grossMargin === 'number') ? latest.grossMargin - first.grossMargin : null;
  const gmTxt = (gmChg == null) ? `净利率 ${fmtPct(latest.netMargin)}` : `毛利率 ${fmtPct(latest.grossMargin)}（较首期${gmChg >= 0 ? '提升' : '下降'} ${Math.abs(gmChg).toFixed(1)}pct）、净利率 ${fmtPct(latest.netMargin)}`;
  const conclusion = `近 ${rc.length} 年营收整体呈${trend}趋势，最新营收 ${latest.revenue} 亿（同比 ${fmtPct(latest.revenueYoy)}），归母净利润 ${latest.netProfit} 亿（同比 ${fmtPct(latest.profitYoy)}），营运利润 ${latest.operatingProfit} 亿，${gmTxt}。`;
  const reasoning = [
    `样本区间：${first.year} ~ ${latest.year}，共 ${rc.length} 个年度。`,
    `最新营收 ${latest.revenue} 亿，同比增速 ${fmtPct(latest.revenueYoy)}，营收${latest.revenueYoy >= 0 ? '保持增长' : '出现下滑'}。`,
    `最新归母净利润 ${latest.netProfit} 亿，同比增速 ${fmtPct(latest.profitYoy)}；利润增速${Math.abs(latest.profitYoy) < Math.abs(latest.revenueYoy) ? '低于营收增速，盈利质量承压' : '不低于营收增速，盈利能力增强'}。`,
    `营运利润 ${latest.operatingProfit} 亿，${gmTxt}，反映核心经营盈利能力与费用控制水平。`,
    ...(gmChg != null ? [`毛利率由 ${first.grossMargin}% 变动至 ${latest.grossMargin}%（${gmChg >= 0 ? '+' : ''}${gmChg.toFixed(1)} pct），反映产品定价能力与成本端变化。`] : []),
  ];
  return { conclusion, reasoning };
}

function buildCashFlowConclusion(cf) {
  if (!cf || cf.length < 2) return null;
  const latest = cf[cf.length - 1];
  const prev = cf[cf.length - 2];
  const np = latest.netProfit;
  const ocf = latest.operatingCashFlow;
  if (!(np > 0)) return { conclusion: '最新净利润为负或缺失，暂无法评估现金流质量。', reasoning: ['净利润数据不足。'] };
  const ratio = (ocf / np * 100);
  const quality = ocf >= np ? '充足，盈利含金量高' : '低于净利润，需关注回款与盈利质量';
  const conclusion = `最新经营现金流净额 ${ocf} 亿，净利润 ${np} 亿，经营现金流/净利润 = ${ratio.toFixed(0)}%，现金流${quality}。`;
  const reasoning = [
    `经营现金流净额 ${ocf} 亿 vs 净利润 ${np} 亿。`,
    `比值 ${ratio.toFixed(0)}%：${ocf >= np ? '≥100%，利润基本以现金形式实现' : '<100%，存在应收账款/存货占用，盈利质量偏弱'}。`,
  ];
  // 解释经营现金流同比大幅波动
  if (prev && prev.operatingCashFlow > 0) {
    const ocfYoY = ((ocf - prev.operatingCashFlow) / prev.operatingCashFlow * 100);
    const isLargeMove = Math.abs(ocfYoY) > 20;
    if (isLargeMove) {
      const direction = ocfYoY >= 0 ? '增长' : '下降';
      reasoning.push(`经营现金流较上年${direction} ${Math.abs(ocfYoY).toFixed(1)}%，若变动主要由保费回款、投资收回/投放、退保或营运资本变化驱动，通常不代表收入质量恶化；建议结合年报「现金流量表补充资料」中的「将净利润调节为经营活动现金流量」逐项核对。`);
    }
  }
  // 若最末年为 TTM，提示口径
  if (latest.ttm) {
    reasoning.push(`注：${latest.year} 年经营现金流净额按 TTM 滚动累计还原为全年等效口径。`);
  }
  return { conclusion, reasoning };
}

function buildGrowthConclusion(g) {
  if (!g) return null;
  const conclusion = `${g.baseYear} 年至 ${g.latestYear} 年，营收累计增长 ${g.revenueGrowth}%，净利润累计增长 ${g.profitGrowth}%。`;
  const reasoning = [
    `基准年 ${g.baseYear} 至最新年 ${g.latestYear}。`,
    `营收累计增幅 ${g.revenueGrowth}%（长期成长性）。`,
    `净利润累计增幅 ${g.profitGrowth}%，${g.profitGrowth > g.revenueGrowth ? '利润增速快于营收，规模效应/利润率提升' : '利润增速慢于营收，成本或费用压力上升'}。`,
  ];
  return { conclusion, reasoning };
}

function buildMarginConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const first = rc[0];
  const gmChg = latest.grossMargin - first.grossMargin;
  const nmChg = latest.netMargin - first.netMargin;
  const conclusion = `毛利率从 ${first.grossMargin}% 变动至 ${latest.grossMargin}%（${gmChg >= 0 ? '提升' : '下降'} ${Math.abs(gmChg).toFixed(1)} pct），净利率${nmChg >= 0 ? '提升' : '下降'} ${Math.abs(nmChg).toFixed(1)} pct。`;
  const reasoning = [
    `毛利率：${first.grossMargin}% → ${latest.grossMargin}%（变动 ${gmChg >= 0 ? '+' : ''}${gmChg.toFixed(1)} pct），反映产品竞争力/成本端变化。`,
    `净利率：${first.netMargin}% → ${latest.netMargin}%（变动 ${nmChg >= 0 ? '+' : ''}${nmChg.toFixed(1)} pct），含费用与税项影响。`,
    `毛利率与净利率剪刀差约 ${(latest.grossMargin - latest.netMargin).toFixed(1)} pct，为三费与税费占用。`,
  ];
  return { conclusion, reasoning };
}

// ---- 近5年 ROE 与毛利率走势（含文字解读）----
// 数据来源：毛利率/净利率取自营收成本表（revenueCostData，与全页一致口径）；
// ROE 取自东方财富 ZYZBAjaxNew 多期指标（zyzbHistory，字段 ROEJQ），按年报期对齐。
// 单一权威源原则：ROE 仅来自 zyzbHistory 一处，不混用其他来源。
function analyzeRoeMarginTrend(revenueCostData, quote) {
  if (!revenueCostData || revenueCostData.length < 2) return null;
  // 取最近 5 年
  const rcYears = revenueCostData.slice(-5);
  // 构建 ROE 年度映射：优先年报(12-31)，否则取该年任一报告期
  const hist = quote && quote.fundamentals && Array.isArray(quote.fundamentals.zyzbHistory)
    ? quote.fundamentals.zyzbHistory : [];
  const roeByYear = {};
  const roeSource = [];
  for (const h of hist) {
    const rd = h.REPORT_DATE || '';
    const y = rd.slice(0, 4);
    if (!y) continue;
    const roe = parseFloat(h.ROEJQ);
    if (isNaN(roe)) continue;
    if (!roeByYear[y] || rd.endsWith('12-31')) roeByYear[y] = { roe, isAnnual: rd.endsWith('12-31') };
    if (rd.endsWith('12-31') && roeSource.indexOf('东方财富 ZYZBAjaxNew 净资产收益率(ROEJQ)') === -1) {
      roeSource.push('东方财富 ZYZBAjaxNew 净资产收益率(ROEJQ)');
    }
  }
  const years = rcYears.map(d => {
    const y = String(d.year);
    const roeRec = roeByYear[y];
    return {
      year: d.year,
      roe: roeRec ? roeRec.roe : null,
      grossMargin: (typeof d.grossMargin === 'number') ? d.grossMargin : null,
      netMargin: (typeof d.netMargin === 'number') ? d.netMargin : null,
      ttm: !!d.ttm,
    };
  }).filter(d => d.roe !== null || d.grossMargin !== null);

  if (years.length < 2) return null;

  // 文字解读（方向 + 幅度 + 边际，遵循规则三）
  const roePts = years.filter(d => d.roe !== null);
  const gmPts = years.filter(d => d.grossMargin !== null);
  const reasoning = [];
  let conclusionParts = [];

  if (roePts.length >= 2) {
    const first = roePts[0], last = roePts[roePts.length - 1];
    const chg = last.roe - first.roe;
    const dir = chg > 0.1 ? '提升' : (chg < -0.1 ? '下降' : '基本持平');
    conclusionParts.push(`ROE 从 ${first.year} 年 ${first.roe.toFixed(1)}% ${dir}至 ${last.year} 年 ${last.roe.toFixed(1)}%（变动 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)} pct）`);
    // 边际变化：相邻两期
    const last2 = roePts[roePts.length - 2];
    const margin = last.roe - last2.roe;
    reasoning.push(`ROE：${first.year} ${first.roe.toFixed(1)}% → ${last.year} ${last.roe.toFixed(1)}%，整体${dir} ${Math.abs(chg).toFixed(1)} pct；最近一期较上期${margin >= 0 ? '上升' : '下降'} ${Math.abs(margin).toFixed(1)} pct（${Math.abs(margin) < 0.3 ? '边际平稳' : '边际' + (margin > 0 ? '改善' : '走弱')}）。`);
  }
  if (gmPts.length >= 2) {
    const first = gmPts[0], last = gmPts[gmPts.length - 1];
    const chg = last.grossMargin - first.grossMargin;
    const dir = chg > 0.1 ? '提升' : (chg < -0.1 ? '下降' : '基本持平');
    conclusionParts.push(`毛利率由 ${first.grossMargin.toFixed(1)}% ${dir}至 ${last.grossMargin.toFixed(1)}%（变动 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)} pct）`);
    const last2 = gmPts[gmPts.length - 2];
    const margin = last.grossMargin - last2.grossMargin;
    reasoning.push(`毛利率：${first.grossMargin.toFixed(1)}% → ${last.grossMargin.toFixed(1)}%，整体${dir} ${Math.abs(chg).toFixed(1)} pct；最近一期较上期${margin >= 0 ? '上升' : '下降'} ${Math.abs(margin).toFixed(1)} pct（${Math.abs(margin) < 0.3 ? '边际平稳' : '边际' + (margin > 0 ? '改善' : '走弱')}）。`);
  }
  const nmPts = years.filter(d => d.netMargin !== null);
  if (nmPts.length >= 2) {
    const first = nmPts[0], last = nmPts[nmPts.length - 1];
    const chg = last.netMargin - first.netMargin;
    conclusionParts.push(`净利率由 ${first.netMargin.toFixed(1)}% 变动至 ${last.netMargin.toFixed(1)}%`);
  }

  const conclusion = '近' + years.length + '年盈利能力走势：' + conclusionParts.join('；') + '。';
  const source = '毛利率/净利率：东方财富 F10 利润表（与营收成本趋势同源）；ROE：' + (roeSource.join('、') || '东方财富财务指标');

  return { years, conclusion, reasoning, source };
}

function buildBalanceConclusion(shortTerm, assetComp, liabComp, bal) {
  if (!shortTerm && !assetComp && !bal) return null;
  const parts = [];
  const reasoning = [];
  if (shortTerm) {
    const cash = shortTerm.cash, debt = shortTerm.shortTermDebt;
    const cover = debt > 0 ? (cash / debt) : null;
    parts.push(`货币资金 ${cash} 亿、短期借款 ${debt} 亿，现金短债比 ${cover !== null ? cover.toFixed(1) : 'N/A'}`);
    reasoning.push(`货币资金 ${cash} 亿、短期借款 ${debt} 亿；现金短债比 ${cover !== null ? cover.toFixed(2) : 'N/A'}${cover !== null ? (cover >= 1 ? '，短期偿债无虞' : '，短期偿债存在压力') : ''}。`);
  }
  if (assetComp && assetComp.length) {
    const top = assetComp.slice(0, 3).map(a => a.name + ' ' + a.value + '亿').join('、');
    parts.push(`资产以 ${top} 为主`);
    reasoning.push(`资产构成前三大：${top}。`);
  }
  if (liabComp && liabComp.length) {
    const top = liabComp.slice(0, 3).map(a => a.name + ' ' + a.value + '亿').join('、');
    parts.push(`负债以 ${top} 为主`);
    reasoning.push(`负债构成前三大：${top}。`);
  }
  if (bal && bal.totalLiabilities > 0 && bal.totalAssets > 0) {
    const dar = (bal.totalLiabilities / bal.totalAssets * 100).toFixed(1);
    parts.push(`资产负债率 ${dar}%`);
    reasoning.push(`资产负债率 ${dar}%（总负债 ${bal.totalLiabilities} 亿 / 总资产 ${bal.totalAssets} 亿）。`);
  }
  if (bal && bal.goodwill > 0 && bal.netAssets > 0) {
    const gwRatio = (bal.goodwill / bal.netAssets * 100);
    reasoning.push(`商誉 ${bal.goodwill} 亿，占净资产 ${gwRatio.toFixed(1)}%${gwRatio > 30 ? '，商誉减值风险需关注' : ''}。`);
  }
  const conclusion = '财务结构：' + parts.join('；') + '。';
  return { conclusion, reasoning };
}

function buildDividendConclusion(dd) {
  if (!dd || dd.length === 0) return null;
  const valid = dd.filter(d => d.dividendRate > 0);
  const latest = dd[dd.length - 1];
  const years = valid.length;
  const rates = valid.map(d => d.dividendRate);
  const conclusion = `最新年度分红率约 ${latest.dividendRate}%，派息 ${latest.dividend} 亿，有分红记录约 ${years} 年。`;
  const reasoning = [
    `最新年度：净利润 ${latest.netProfit} 亿，分红 ${latest.dividend} 亿，分红率 ${latest.dividendRate}%。`,
    rates.length ? `历史分红率区间：${Math.min(...rates)}% ~ ${Math.max(...rates)}%。` : '历史分红率数据不足。',
    `分红率${latest.dividendRate > 70 ? '偏高（>70%），需关注是否透支' : latest.dividendRate < 30 ? '偏低' : '适中'}，可持续性取决于盈利稳定性与现金流。`,
  ];
  return { conclusion, reasoning };
}

function buildDCFConclusion(dcf) {
  if (!dcf) return { conclusion: 'DCF 数据不足。', reasoning: [] };
  if (dcf.error) return { conclusion: 'DCF 不可用：' + dcf.error, reasoning: [] };
  const premium = dcf.premium;
  const conclusion = `DCF 每股内在价值 ¥${fmtPrice(dcf.perShareValue)}，现价 ¥${fmtPrice(dcf.currentPrice)}，估值${premium > 0 ? '高估' : '低估'} ${fmtPct(Math.abs(premium))}。`;
  const reasoning = [
    `基础自由现金流 ${dcf.baseFCF} 亿，假设预测增长 ${dcf.projectedGrowth}%、折现率 ${dcf.discountRate}%、永续增长 ${dcf.perpetualGrowth}%。`,
    `企业价值 ${dcf.enterpriseValue} 亿，股权价值 ${dcf.equityValue} 亿，每股内在价值 ¥${fmtPrice(dcf.perShareValue)}。`,
    `相对现价 ¥${fmtPrice(dcf.currentPrice)}：溢价 ${fmtPct(premium)}，即${premium > 0 ? '当前价格高于内在价值，已兑现预期' : '当前价格低于内在价值，存在安全边际'}。`,
    `注：DCF 对增长与折现率假设高度敏感，结论仅作参考。`,
  ];
  return { conclusion, reasoning };
}

function buildAssetCompConclusion(assetComposition, totalAssets) {
  if (!Array.isArray(assetComposition) || assetComposition.length === 0) return null;
  const top = assetComposition.slice(0, 3).map(a => `${a.name} ${a.value}亿`).join('、');
  const conclusion = `${totalAssets != null ? `总资产 ${totalAssets} 亿，` : ''}资产构成以 ${top} 为主。`;
  const reasoning = [`资产前三大：${top}。`, ...(totalAssets != null ? [`总资产 ${totalAssets} 亿。`] : [])];
  return { conclusion, reasoning };
}

function buildLiabCompConclusion(liabilityComposition, totalLiabilities) {
  if (!Array.isArray(liabilityComposition) || liabilityComposition.length === 0) return null;
  const top = liabilityComposition.slice(0, 3).map(a => `${a.name} ${a.value}亿`).join('、');
  const conclusion = `${totalLiabilities != null ? `总负债 ${totalLiabilities} 亿，` : ''}负债构成以 ${top} 为主。`;
  const reasoning = [`负债前三大：${top}。`];
  return { conclusion, reasoning };
}

function buildMarketCapConclusion(data, key, metricLabel, ratioLabel) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const valid = data.filter(d => d[key] != null && d[key] > 0 && d.marketCap != null && d.marketCap > 0);
  if (valid.length < 2) return null;
  const latest = valid[valid.length - 1];
  const first = valid[0];
  const val = latest[key];
  const mc = latest.marketCap;
  const multiple = mc / val;
  const conclusion = `${metricLabel} ${val} 亿，最新市值 ${mc} 亿（${ratioLabel}约 ${multiple.toFixed(2)} 倍），${val >= first[key] ? '较首期上升' : '较首期下降'}。`;
  const reasoning = [
    `区间：${first.year} ~ ${latest.year}（${valid.length} 个可比年度）。`,
    `最新 ${metricLabel} ${val} 亿、总市值 ${mc} 亿，对应 ${ratioLabel} ${multiple.toFixed(2)} 倍。`,
  ];
  return { conclusion, reasoning };
}

function buildProfitVsCashConclusion(cf) {
  if (!cf || cf.length < 2) return null;
  const latest = cf[cf.length - 1];
  const np = latest.netProfit, ocf = latest.operatingCashFlow;
  if (!(np > 0)) return null;
  const conclusion = `最新净利润 ${np} 亿、经营现金流净额 ${ocf} 亿，经营现金流/净利润 = ${(ocf / np * 100).toFixed(0)}%，${ocf >= np ? '利润现金含量充足' : '利润现金含量偏低，需关注回款质量'}。`;
  const reasoning = [
    `净利润 ${np} 亿 vs 经营现金流净额 ${ocf} 亿。`,
    `比值 ${(ocf / np * 100).toFixed(0)}%${ocf >= np ? '（≥100%，业绩以现金形式实现，真实性强）' : '（<100%，存在应收/存货占用，业绩真实性承压）'}。`,
  ];
  return { conclusion, reasoning };
}

function buildRevVsCostConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const rev = latest.revenue, cost = latest.cost;
  if (!(rev > 0)) return null;
  const margin = (1 - cost / rev) * 100;
  const conclusion = `最新营收 ${rev} 亿、营业总成本 ${cost} 亿，营收成本差约 ${margin.toFixed(1)}%（营运利润率参考）。`;
  const reasoning = [`营收 ${rev} 亿、营业总成本 ${cost} 亿，两者差额 ${(rev - cost).toFixed(1)} 亿。`];
  return { conclusion, reasoning };
}

function buildRevVsExpConclusion(exp) {
  if (!exp || exp.length < 2) return null;
  const latest = exp[exp.length - 1];
  const rev = latest.revenue;
  if (!(rev > 0)) return null;
  const sale = latest.saleExpense || 0, manage = latest.manageExpense || 0, research = latest.researchExpense || 0;
  const totalExp = sale + manage + research;
  const ratio = totalExp / rev * 100;
  const conclusion = `最新三费合计 ${totalExp.toFixed(1)} 亿，占营收 ${ratio.toFixed(1)}%（销售 ${sale}、管理 ${manage}、研发 ${research} 亿）。`;
  const reasoning = [`三费合计 ${totalExp.toFixed(1)} 亿，费用率 ${ratio.toFixed(1)}%，体现费用控制与研发投入强度。`];
  return { conclusion, reasoning };
}

function buildPayableConclusion(pd) {
  if (!pd || pd.length < 2) return null;
  const latest = pd[pd.length - 1];
  const rev = latest.revenue, ap = latest.accountsPayable;
  if (!(rev > 0)) return null;
  const ratio = ap / rev * 100;
  const conclusion = `最新应付账款 ${ap != null ? ap + ' 亿' : 'N/A'}，占营收 ${ratio.toFixed(1)}%（对上游资金占用强度）。`;
  const reasoning = [`应付账款 ${ap != null ? ap + ' 亿' : 'N/A'}、营收 ${rev} 亿，占比 ${ratio.toFixed(1)}%。`, '应付占营收越高，通常对上游议价/占款能力越强，但也需关注自身偿债与供应商关系。'];
  return { conclusion, reasoning };
}

function buildValuationMetricConclusion(valuation, label) {
  if (!valuation || !valuation.valuationData) return null;
  const key = label.toLowerCase();
  const vals = valuation.valuationData.filter(d => typeof d[key] === 'number' && d[key] > 0).map(d => d[key]);
  if (vals.length < 2) return null;
  const latest = vals[vals.length - 1];
  const stats = valuation[key + 'Stats'] || {};
  const mean = stats.mean, high = stats.high, low = stats.low;
  let pos;
  if (mean != null && high != null && low != null) {
    pos = latest >= high ? `处于历史高位区（≥${high}，偏贵）` : latest <= low ? `处于历史低位区（≤${low}，偏便宜）` : `处于历史均值（${mean}）附近`;
  } else {
    pos = '（缺少均值参考）';
  }
  let conclusion = `${label} 当前约 ${latest}，${pos}，近 ${vals.length} 期均值 ${mean != null ? mean : '--'}。`;
  const reasoning = [
    `${label} 序列区间：${vals[0]} ~ ${latest}（共 ${vals.length} 期）。`,
    `历史均值 ${mean != null ? mean : '--'}，+1σ 高估线 ${high != null ? high : '--'}，-1σ 低估线 ${low != null ? low : '--'}。`,
  ];
  if (label === 'PE' && valuation.currentPeTtm > 0) {
    reasoning.push(`当前 PE(TTM) ${valuation.currentPeTtm}（来源：${valuation.peSource || '东方财富TTM'}），${valuation.currentPeTtm > latest ? '高于' : '低于'}最近一期静态 PE。`);
  }
  // 规则三：结论补充「方向+幅度+边际」；规则一②/二：推理补充「数值+来源+数据时间」
  const ruleLine = valuation.rules ? formatValuationLine(valuation.rules, label) : null;
  if (ruleLine) {
    const segs = ruleLine.split('；');
    if (segs.length > 1) conclusion += segs.slice(1).join('；') + '。';
    reasoning.push(segs[0]);
  }
  return { conclusion, reasoning };
}

function buildDivYieldConclusion(dy) {
  if (!dy || !Array.isArray(dy.series) || dy.series.length === 0) return null;
  const cur = dy.current && typeof dy.current.yield === 'number' ? dy.current.yield : null;
  const mean = dy.stats && typeof dy.stats.mean === 'number' ? dy.stats.mean : null;
  const cmp = (cur != null && mean != null) ? `，${cur >= mean ? '高于' : '低于'}均值` : '';
  const conclusion = `当前股息率 ${cur != null ? cur + '%' : '--'}${mean != null ? `，近 ${dy.series.length} 年均值 ${mean.toFixed(2)}%${cmp}` : ''}。`;
  const reasoning = [
    ...(mean != null ? [`近 ${dy.series.length} 年股息率均值 ${mean.toFixed(2)}%。`] : []),
    ...(cur != null && mean != null ? [`当前 ${cur}% ${cur >= mean ? '高于' : '低于'}均值，股息吸引力${cur >= mean ? '较强' : '一般'}。`] : []),
  ];
  return { conclusion, reasoning };
}

function segmentTopItems(seg, typeFilter) {
  if (!seg || !seg.byYear || !seg.years || seg.years.length === 0) return null;
  const lastYear = seg.years[seg.years.length - 1];
  const yearMap = seg.byYear[lastYear] || {};
  const types = Object.keys(yearMap);
  const key = types.find(t => t.includes(typeFilter)) || (typeFilter === '产品' ? types.find(t => !t.includes('地区') && !t.includes('行业')) : types.find(t => t.includes('地区') || t.includes('内') || t.includes('外')));
  if (!key) return null;
  const items = yearMap[key];
  if (!Array.isArray(items) || items.length === 0) return null;
  return { lastYear, items };
}

function buildSegmentProductConclusion(seg) {
  const r = segmentTopItems(seg, '产品');
  if (!r) return null;
  const total = r.items.reduce((s, p) => s + ((p.income || 0) / 1e8), 0);
  if (total <= 0) return null;
  const top = [...r.items].filter(p => (p.income || 0) > 0).sort((a, b) => (b.income || 0) - (a.income || 0)).slice(0, 3);
  if (top.length === 0) return null;
  const topTxt = top.map(p => `${p.name}（${((p.income || 0) / 1e8 / total * 100).toFixed(0)}%）`).join('、');
  const conclusion = `${r.lastYear} 年分产品收入以 ${topTxt} 为主。`;
  const reasoning = [`${r.lastYear} 年度按主营业务构成口径统计的产品收入占比。`];
  return { conclusion, reasoning };
}

function buildSegmentRegionConclusion(seg) {
  const r = segmentTopItems(seg, '地区');
  if (!r) return null;
  const total = r.items.reduce((s, p) => s + ((p.income || 0) / 1e8), 0);
  if (total <= 0) return null;
  const foreignMarks = ['境外', '海外', '国外', '国际', '香港', '澳门', '台湾', '外销', '出口', 'foreign', 'oversea', 'abroad'];
  let foreign = 0;
  r.items.forEach(p => {
    const n = String(p.name || '').toLowerCase();
    if (foreignMarks.some(m => n.includes(m))) foreign += (p.income || 0) / 1e8;
  });
  const foreignPct = foreign / total * 100;
  const conclusion = `${r.lastYear} 年国内收入占比约 ${(100 - foreignPct).toFixed(0)}%，海外收入占比约 ${foreignPct.toFixed(0)}%。`;
  const reasoning = [`海外收入合计约 ${foreign.toFixed(1)} 亿，占总收入 ${foreignPct.toFixed(1)}%。`];
  return { conclusion, reasoning };
}

function buildProductMarginConclusion(pm) {
  if (!pm || !Array.isArray(pm.items) || pm.items.length === 0) return null;
  const hasCost = pm.items.every(p => p.costYi != null);
  const overall = (hasCost && pm.totalIncomeYi > 0) ? Math.round((1 - pm.totalCostYi / pm.totalIncomeYi) * 10000) / 100 : null;
  const topGm = [...pm.items].filter(p => p.grossMargin != null).sort((a, b) => b.grossMargin - a.grossMargin).slice(0, 3);
  if (overall == null && topGm.length === 0) return null;
  const conclusion = `${pm.dimension || '产品/业务'}整体毛利率${overall != null ? '约 ' + overall + '%' : '—'}${topGm.length ? `；高毛利业务为 ${topGm.map(p => p.name).join('、')}` : ''}。`;
  const reasoning = [
    ...(overall != null ? [`整体毛利率约 ${overall}%（营收 ${pm.totalIncomeYi} 亿、成本 ${pm.totalCostYi} 亿）。`] : []),
    ...(topGm.length ? [`高毛利业务：${topGm.map(p => `${p.name}(${p.grossMargin}%)`).join('、')}。`] : []),
  ];
  return { conclusion, reasoning };
}

// ---- 保险公司专属模块结论 ----
function buildInsurancePremiumConclusion(pa) {
  if (!pa || !Array.isArray(pa.yearlyData) || pa.yearlyData.length < 2) return null;
  const latest = pa.yearlyData[pa.yearlyData.length - 1];
  const first = pa.yearlyData[0];
  const conclusion = `保费收入近 ${pa.yearlyData.length} 年由 ${first.total} 亿增至 ${latest.total} 亿，最新同比 ${fmtPct(latest.yoyGrowth)}。`;
  const reasoning = [`区间：${first.year} ~ ${latest.year}。`, `最新保费 ${latest.total} 亿，同比 ${fmtPct(latest.yoyGrowth)}。`];
  return { conclusion, reasoning };
}

function buildInsuranceCombinedRatioConclusion(cr) {
  if (!cr || !cr.hasData || !Array.isArray(cr.data) || cr.data.length === 0) return null;
  const latest = cr.data[cr.data.length - 1];
  const benchmark = cr.industryBenchmark || 98.5;
  const conclusion = `最新综合成本率 ${latest.value}%（${latest.value < benchmark ? '优于' : '高于'}行业基准 ${benchmark}%），承保端${latest.value < 100 ? '盈利' : '亏损'}。`;
  const reasoning = [`综合成本率 ${latest.value}%，行业基准 ${benchmark}%。`, '综合成本率 = 赔付率 + 费用率，<100% 表示承保端盈利。'];
  return { conclusion, reasoning };
}

function buildInsuranceInvestmentYieldConclusion(iy) {
  if (!iy || !iy.hasData || !Array.isArray(iy.data) || iy.data.length === 0) return null;
  const latest = iy.data[iy.data.length - 1];
  const benchmark = iy.industryBenchmark || 5.0;
  const conclusion = `最新${iy.metricName || '投资收益率'} ${latest.value}%（${latest.value >= benchmark ? '高于' : '低于'}行业基准 ${benchmark}%）。`;
  return { conclusion, reasoning: [`${iy.metricName || '投资收益率'} ${latest.value}%，行业基准 ${benchmark}%。`] };
}

function buildInsuranceNBVConclusion(nb) {
  if (!nb || !nb.hasData || !Array.isArray(nb.data) || nb.data.length === 0) return null;
  const latest = nb.data[nb.data.length - 1];
  const latestCum = latest.cumulative != null ? latest.cumulative : latest.value;
  const conclusion = `最新季度（${latest.label}）NBV 当季 ${latest.value} 亿、累计 ${latestCum} 亿。`;
  const reasoning = [`最新季度 ${latest.label}：当季 NBV ${latest.value} 亿，累计 ${latestCum} 亿。`, ...(nb.note ? [nb.note] : [])];
  return { conclusion, reasoning };
}

function buildInsuranceProfitCompConclusion(pc) {
  if (!pc || !Array.isArray(pc.data) || pc.data.length === 0) return null;
  const latest = pc.data[pc.data.length - 1];
  const gap = (latest.operatingProfit || 0) - (latest.netProfit || 0);
  const conclusion = `${latest.year} 年营运利润 ${latest.operatingProfit || 0} 亿、净利润 ${latest.netProfit || 0} 亿，差额 ${gap.toFixed(1)} 亿。`;
  return { conclusion, reasoning: pc.trendNote ? [pc.trendNote] : [] };
}

function buildInsurancePEVConclusion(pev) {
  if (!pev) return null;
  if (pev.currentPEV == null) return { conclusion: 'P/EV 数据不足。', reasoning: [] };
  const conclusion = `当前 P/EV 约 ${pev.currentPEV}，${pev.interpretation || ''}`;
  return { conclusion, reasoning: [pev.interpretation || '', ...(pev.note ? [pev.note] : [])].filter(Boolean) };
}

function buildInsuranceDDMConclusion(ddm) {
  if (!ddm) return null;
  if (ddm.intrinsicValue == null) return { conclusion: 'DDM 数据不足。', reasoning: [] };
  const conclusion = `DDM 内在价值 ¥${fmtPrice(ddm.intrinsicValue)}，当前股价 ¥${fmtPrice(ddm.currentPrice)}，评级：${ddm.rating || '--'}。`;
  const reasoning = [`模型 ${ddm.model || 'DDM'} · 平均增速 ${ddm.avgGrowth != null ? ddm.avgGrowth.toFixed(1) + '%' : '--'} · 折现率 ${ddm.discountRate || '--'}% · 永续增长 ${ddm.terminalGrowth || '--'}%`, ...(ddm.note ? [ddm.note] : [])];
  return { conclusion, reasoning };
}

function buildBusinessLineConclusion(series, name) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = series[series.length - 1];
  const first = series[0];
  const yo = latest.yoy;
  const conclusion = `${name} ${first.year}~${latest.year} 由 ${first.value} 亿变动至 ${latest.value} 亿，最新同比 ${yo !== undefined && yo !== null ? fmtPct(yo) : '--'}。`;
  return { conclusion, reasoning: [`最新年度 ${latest.year}：${name} ${latest.value} 亿。`] };
}

function buildValuationReasoning(conclusionObj) {
  if (!conclusionObj || !Array.isArray(conclusionObj.ratings)) return [];
  const r = conclusionObj.ratings.map(rt => `【${rt.method}】(权重 ${Math.round((rt.weight || 0.25) * 100)}%) ${rt.detail}`);
  r.push('综合评级采用「按公司类型加权」打分，权重越高的方法对结论影响越大。');
  return r;
}

module.exports = { buildRevenueConclusion, buildCashFlowConclusion, buildGrowthConclusion, buildMarginConclusion, analyzeRoeMarginTrend, buildBalanceConclusion, buildDividendConclusion, buildDCFConclusion, buildAssetCompConclusion, buildLiabCompConclusion, buildMarketCapConclusion, buildProfitVsCashConclusion, buildRevVsCostConclusion, buildRevVsExpConclusion, buildPayableConclusion, buildValuationMetricConclusion, buildDivYieldConclusion, buildSegmentProductConclusion, buildSegmentRegionConclusion, buildProductMarginConclusion, buildInsurancePremiumConclusion, buildInsuranceCombinedRatioConclusion, buildInsuranceInvestmentYieldConclusion, buildInsuranceNBVConclusion, buildInsuranceProfitCompConclusion, buildInsurancePEVConclusion, buildInsuranceDDMConclusion, buildBusinessLineConclusion, buildValuationReasoning };
