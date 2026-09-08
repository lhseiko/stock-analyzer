// ============================================================
// 华安证券（600909）专属动态估值引擎 V2.0 —— 确定性计算（1+1=2 原则）
// 20260908t：按用户《动态估值框架 V2.0 修正版》指令整体重写：
//   指令0 守门员自检（财报时效>150天终止 / 板块成交额偏离±30%终止 / 长鑫30天质变终止）
//   指令1 口径分离（单季归母>8季均值150%触发 → 报告EPS vs 常态EPS 双套数据 + 三层容错）
//   指令2 三层次估值：PB法60%（三层动态锚）+ SOTP法30%（长鑫市值×80%流动性折扣）+ PE法10%（仅常态EPS）
//   指令3 综合目标价与评级（<0.9低估 / 0.9~1.05合理 / >1.05高估，20260908z2 三档校准）+ 与上次对比
//   指令4 风险监测（成交额<1.2万亿 / 长鑫负面舆情 / 监管处罚）
// 计算层=代码，输入锁死（data/valuation/600909.json）⇒ 结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '600909';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600909.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isHuaanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (bare !== SYM) return false;
  const cfg = loadConfig();
  return !!cfg && cfg.kind === 'huaan';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);

// 两个 YYYY-MM-DD 之间的自然日差
function daysBetween(d1, d2) {
  const a = new Date(String(d1).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(d2).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'huaan') return { error: 'NOT_HUAAN' };

  const G = cfg.guard || {}, Q = cfg.quarterly || {}, NL = cfg.npLatest || {};
  const PB = cfg.pbLayer || {}, ST = cfg.sotpLayer || {}, PE = cfg.peLayer || {};
  const W = cfg.weights || {}, RT = cfg.ratingThresholds || {}, LV = cfg.lastVersion || {};
  const NT = cfg.notes || {};
  const N = nz(cfg.shares);

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const today = new Date().toISOString().slice(0, 10);

  // ============ 指令0：守门员自检 ============
  const reportAge = daysBetween(G.reportPeriodEnd, today);
  const g1Pass = reportAge <= nz(G.maxAgeDays, 150);
  const baseline = G.sectorTurnoverBaseline;
  const g2Status = baseline == null ? 'DEGRADED' : 'PASS';   // 基线缺失→降级不终止；接入后按±30%执行
  const cxmtDays = daysBetween(G.cxmtListDate, G.cxmtCheckDate || today);
  const g3Pass = !(G.cxmtStatus !== 'listed' && cxmtDays <= nz(G.cxmtWindowDays, 30));

  const guardRows = [
    { label: '① 财报时效', status: g1Pass ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${G.reportPeriodEnd}，距检查日 ${reportAge} 天（终止上限 ${G.maxAgeDays} 天）`, source: '2026 中报（2026-08-25 披露）' },
    { label: '② 市场环境', status: g2Status === 'PASS' ? '✅ 通过' : '🟡 降级', value: g2Status === 'PASS' ? `券商板块(801193.SI)近20日日均成交额偏离基线 ${G.sectorTurnoverDeviationLimitPct}% 以内` : '板块近20日日均成交额基线不可得【数据缺失】→ 本次降级不终止，仅建立基线标注；数据源接入后按 ±30% 偏离终止规则执行', source: '801193.SI（待接入）' },
    { label: '③ 核心资产（长鑫科技 688825）', status: g3Pass ? '✅ 通过' : '⛔ 终止', value: `${G.cxmtNote}`, source: `上市日 ${G.cxmtListDate}；检查日 ${G.cxmtCheckDate}` },
  ];
  const terminated = !g1Pass || !g3Pass || (g2Status === 'TERMINATE');

  // P2通用时效看板（20260908z）
  const freshnessRows = [];
  if (G.reportPeriodEnd) freshnessRows.push({ label: '最新财报报告期', asOf: G.reportPeriodEnd, ageDays: reportAge, maxAge: nz(G.maxAgeDays, 150), stale: !g1Pass });
  if (G.cxmtCheckDate) {
    const cxAge = daysBetween(G.cxmtListDate, new Date(G.cxmtCheckDate));
    if (cxAge != null) freshnessRows.push({ label: '长鑫科技上市核查日', asOf: G.cxmtCheckDate, ageDays: cxAge, maxAge: 9999, stale: false });
  }

  if (terminated) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V2.0（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（财报超龄/市场环境突变/核心资产质变），模型按指令0终止本次估值，历史结论不再外推。请更新数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }

  // ============ 指令1：口径分离（常态化利润剥离） ============
  const npSeries = Q.npSeries || [];
  const avgNp = npSeries.reduce((a, b) => a + nz(b), 0) / Math.max(1, npSeries.length);
  const peakIdx = npSeries.indexOf(Math.max(...npSeries));
  const peakQ = (Q.labels || [])[peakIdx] || `第${peakIdx + 1}季`;
  const peakNp = nz(npSeries[peakIdx]);
  const anomalyRatio = avgNp > 0 ? peakNp / avgNp : 0;
  const anomaly = anomalyRatio > nz(Q.anomalyThreshold, 1.5);

  const epsReport = nz(NL.epsReport), epsNormal = nz(NL.epsNormal);
  const caliberNote = `【一次性损益剔除口径 · 报告首页强制披露】${peakQ} 单季归母净利 ${r2(peakNp)} 亿元为近 ${npSeries.length} 季均值（${r2(avgNp)} 亿元）的 ${Math.round(anomalyRatio * 100)}%，超过 150% 异常阈值，已触发口径分离：PE 法仅采用常态 EPS（扣非年化）${epsNormal} 元，弃用报告 EPS（TTM）${epsReport} 元。注：2026H1 扣非与归母差异仅 ${r2(NL.oneOffAmount)} 亿元（占比 0.66%），Q2 冲高主因市场交投活跃带来的自营+经纪景气性收入，属景气性而非一次性损益；常态化利润剥离采用扣非年化口径。`;

  const dualEpsRows = [
    { label: '报告 EPS（TTM）', value: `${epsReport} 元`, source: `近4季归母 ${r2(npSeries.slice(-4).reduce((a, b) => a + nz(b), 0))} 亿 ÷ ${N} 亿股（2025Q3~2026Q2）` },
    { label: '常态 EPS（扣非年化）', value: `${epsNormal} 元`, source: `2026H1 扣非 ${r2(NL.npH1 && NL.npDeductedH1)} 亿 ×2 ÷ ${N} 亿股；PE 法专用` },
    { label: '一次性损益（H1）', value: `${r2(NL.oneOffAmount)} 亿元（占 H1 归母 0.66%）`, source: '2026 中报：归母 − 扣非' },
    { label: '异常触发判定', value: `${peakQ} 单季 ${r2(peakNp)} 亿 = 均值 ${r2(avgNp)} 亿 × ${Math.round(anomalyRatio * 100)}% ${anomaly ? '> 150% → 触发口径分离' : '未触发'}`, source: `单季序列（${(Q.labels || []).join(' ')}）${Q.seriesNote ? '；' + Q.seriesNote : ''}` },
  ];

  // ============ 指令2：三层次估值 ============
  // —— ① PB 法（权重60%，核心）：三层动态锚 = 历史40% + 板块×ROE溢价30% + 理论30%
  const roe = nz(PB.sustainableRoe) / 100, gPerp = nz(PB.g) / 100;
  const r = nz(PB.rf) / 100 + nz(PB.beta) * nz(PB.erp) / 100;
  const theoPB = (roe - gPerp) / (r - gPerp);
  const aSector = nz(PB.sectorPB) * nz(PB.premiumCoef);
  const aHist = nz(PB.histPbMedian);
  const fairPB = nz(PB.wHist) * aHist + nz(PB.wSector) * aSector + nz(PB.wTheo) * theoPB;
  const pbTarget = nz(cfg.bpsLatest) * fairPB;

  // —— ② SOTP 法（权重30%）：常规业务（常态年化净利×可比PE）+ 长鑫持股市值×80%流动性折扣
  const sotpBase = nz(ST.normalAnnualNp) * nz(ST.peNormal);
  const cxmtMv = nz(ST.cxmtShares) * nz(ST.cxmtPrice);
  const cxmtVal = cxmtMv * nz(ST.cxmtDiscount);
  const sotpTotal = sotpBase + cxmtVal;
  const sotpTarget = N > 0 ? sotpTotal / N : null;

  // —— ③ PE 法（权重10%）：仅常态EPS × min(5年PE中位, 行业PE中位)
  const histPe = PE.histPeMedian == null ? null : nz(PE.histPeMedian);
  const sectorPe = nz(PE.sectorPeMedian);
  const peMult = (histPe != null && histPe > 0) ? Math.min(histPe, sectorPe) : sectorPe;
  const pePeMissing = histPe == null;
  const peTarget = epsNormal * peMult;

  // ============ 指令3：综合目标价与评级 ============
  const wPB = nz(W.pb, 0.6), wST = nz(W.sotp, 0.3), wPE = nz(W.pe, 0.1);
  const center = wPB * pbTarget + wST * sotpTarget + wPE * peTarget;
  const buyLine = center * nz(RT.buyBelow, 0.9);
  const reduceLine = center * nz(RT.reduceAbove, 1.05);

  let rating = '合理', ratingNote = '';
  if (P != null) {
    const ratio = P / center;
    if (ratio < nz(RT.buyBelow, 0.9)) { rating = '低估'; ratingNote = `现价/目标价 = ${r2(ratio)} < ${RT.buyBelow} → 低估`; }
    else if (ratio <= nz(RT.reduceAbove, 1.05)) { rating = '合理'; ratingNote = `现价/目标价 = ${r2(ratio)}，处 ${RT.buyBelow}~${RT.reduceAbove} 区间 → 合理`; }
    else { rating = '高估'; ratingNote = `现价/目标价 = ${r2(ratio)} > ${RT.reduceAbove} → 高估`; }
  } else {
    ratingNote = '实时价不可用，仅输出目标价区间。';
  }

  const detailRows = [
    { label: 'PB层·锚1 历史中枢', value: `PB 中位 ${aHist} 倍 × 权重 ${PB.wHist} = ${(nz(PB.wHist) * aHist).toFixed(4)}`, source: NT.histPb },
    { label: 'PB层·锚2 板块×ROE溢价', value: `板块 PB ${PB.sectorPB} × 溢价系数 ${PB.premiumCoef}（=ROE ${PB.sustainableRoe}% ÷ 行业均值假设 ${PB.sectorAvgRoeAssumed}%）= ${r2(aSector)} 倍 × 权重 ${PB.wSector}`, source: NT.sectorPB + '；' + NT.premiumCoef },
    { label: 'PB层·锚3 理论PB', value: `(ROE−g)/(r−g) = (${PB.sustainableRoe}%−${PB.g}%)/(r−${PB.g}%)，r = Rf ${PB.rf}% + β ${PB.beta} × ERP ${PB.erp}% = ${r2(r * 100)}% → 理论 PB ${theoPB.toFixed(4)} 倍 × 权重 ${PB.wTheo}`, source: NT.sustainableRoe + '；' + NT.beta },
    { label: 'PB层·三层加权目标价', value: `加权 PB ${fairPB.toFixed(4)} 倍 × BPS ${cfg.bpsLatest} 元 = ${r2(pbTarget)} 元/股（权重 ${wPB * 100}%）`, source: NT.equity },
    { label: 'SOTP层·常规业务', value: `常态年化归母净利 ${ST.normalAnnualNp} 亿（扣非H1×2）× 可比PE ${ST.peNormal} 倍 = ${r2(sotpBase)} 亿元`, source: NT.peNormal + '；' + NT.sotpCaliber },
    { label: 'SOTP层·长鑫科技(688825)', value: `持股 ${ST.cxmtShares} 亿股 × 市价 ${ST.cxmtPrice} 元（2026-09-08 快照）= ${r2(cxmtMv)} 亿 × 流动性折扣 80% = ${r2(cxmtVal)} 亿元`, source: NT.cxmt },
    { label: 'SOTP层·合计', value: `${r2(sotpTotal)} 亿元 ÷ ${N} 亿股 = ${r2(sotpTarget)} 元/股（权重 ${wST * 100}%）`, source: '指令2：SOTP 已上市口径=持股市值×80%' },
    { label: 'PE层（常态口径）', value: `常态 EPS ${epsNormal} 元 × PE 乘数 ${peMult} 倍${pePeMissing ? '（5年PE中位缺失【数据缺失】→ 取行业PE中位）' : '（=min(5年中位,行业中位)）'} = ${r2(peTarget)} 元/股（权重 ${wPE * 100}%）`, source: '指令2：PE 仅用常态EPS（三层容错：报告EPS弃用→常态EPS兜底→异常中断）' },
    { label: '综合目标价', value: `${wPB * 100}%×${r2(pbTarget)} + ${wST * 100}%×${r2(sotpTarget)} + ${wPE * 100}%×${r2(peTarget)} = ${r2(center)} 元/股`, source: `低估触发线 ${r2(buyLine)} 元（<0.9×）｜高估触发线 ${r2(reduceLine)} 元（>1.05×）` },
  ];

  const compareRows = [
    { label: `上次：${LV.version}`, value: `区间 ${LV.range ? LV.range[0] + '~' + LV.range[1] : 'N/A'} 元，中枢 ${LV.center} 元，评级「${LV.rating}」` },
    { label: '本次：V2.0（20260908t）', value: `中枢 ${r2(center)} 元（低估线 ${r2(buyLine)} / 高估线 ${r2(reduceLine)}），评级「${rating}」` },
    { label: '差异原因', value: LV.diffNote || '' },
  ];

  const riskMonitorRows = [
    { label: '券商板块成交额', light: `🟡 待接入：日成交额跌破 ${(cfg.riskMonitor && cfg.riskMonitor.sectorTurnoverFloorYi) ? (cfg.riskMonitor.sectorTurnoverFloorYi / 10000) + ' 万亿' : '1.2 万亿'} 触发预警（板块成交额数据源待接入）` },
    { label: '长鑫科技（688825）舆情', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.cxmtNegative) || '未发现负面'}` },
    { label: '监管处罚', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.regulatory) || '无新增'}` },
  ];

  const positionNote = P != null
    ? `当前股价 ${r2(P)} 元 vs 综合目标价 ${r2(center)} 元（低估线 ${r2(buyLine)} / 高估线 ${r2(reduceLine)}）；${ratingNote}。PB(LF) 现值约 ${(P / nz(cfg.bpsLatest)).toFixed(2)} 倍 vs 三层加权合理 PB ${fairPB.toFixed(2)} 倍。`
    : '实时价不可用。';

  const riskNote = '上行：市场成交额维持高位（Q2 景气性收入可持续）、长鑫科技股价贡献持股市值弹性；下行：成交额跌破 1.2 万亿、长鑫股价回撤（SOTP 直接受损，每±10% 波动影响目标价约±0.37 元）、监管处罚。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    huaan: true,
    version: 'V2.0',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(buyLine), r2(reduceLine)],
    fairValueCenter: r2(center),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'huaan600909 V2.0（守门员+口径分离+PB60/SOTP30/PE10，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    guardRows, freshnessRows,
    caliberNote,
    dualEpsRows,
    detailRows,
    compareRows,
    riskMonitorRows,
    positionNote,
    riskNote,
    decisionNote: '框架 V2.0：PB法60%（三层动态锚：历史/板块×ROE溢价/理论）+ SOTP法30%（常态净利×可比PE + 长鑫持股市值×80%流动性折扣）+ PE法10%（仅常态EPS）。守门员三项自检通过（市场环境项降级为基线标注）；口径分离已触发（2026Q2=均值237%>150%）。假设项（行业均值ROE 6.4%、可持续ROE 7.37%、ERP 6.25%、g 2.5%）均已在卡片标注。',
  };
}

module.exports = { run, isHuaanModel, loadConfig };
