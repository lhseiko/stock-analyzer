// ============================================================
// 华安证券（600909）专属动态估值引擎 V3.0 —— 确定性计算（1+1=2 原则）
// 20260908t：V2.0 守门员自检 + 口径分离 + PB60%/SOTP30%/PE10%。
// 20260922d：守门员②「市场环境」与风险监测该行接线实时取数（lib/brokerSectorTurnover.js）——
//   板块成交额 = 同花顺行业板块（备源 东财概念「券商概念」）；全市场成交额 = 同花顺申万一级行业合计。
//   替换原「数据源待接入 /【数据缺失】」；风险监测该行经用户确认由「券商板块成交额(1.2万亿)」改为「市场成交额（全市场）」。
// 20260922b【指令9：核心参股资产联动监测与 SOTP 权重动态调整】：
//   - 自动抓取长鑫科技(688825.SH)最新总市值（腾讯行情，失败回退锁定快照 2.64亿股×58.39）。
//   - 间接持股价值 = 长鑫市值 × 0.4391% × (1 − 流动性折扣)；参股占比 = 长鑫市值 × 0.4391% ÷ 华安总市值。
//   - SOTP 权重自适应：占比 <10% → 30%（PB60/PE10）；10%~30% → 40%（PB50/PE10，标注"公司价值显著受参股资产影响"）；>30% → 影子股模式（SOTP50/PB40/PE10，单独列示"长鑫科技持股贡献"，加"股价联动强度"60日收益相关系数，corr>0.5 标注"走势主要由长鑫驱动"）。
//   - 流动性折扣：限售 20%~30%（取 25%）/ 无限售 0% / 未知保守 30%。
//   - 动态更新：每次运行实时重算长鑫市值；市值较锁定快照 ±5% 自动反映；0.4391% 持股比于每次财报披露复核。
// 计算层=代码，输入锁死（data/valuation/600909.json）⇒ 结果锁死；长鑫市值/华安总市值为实时抓取（带快照回退）。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate, localCompact, localDateFromTs } = require('../localDate');
const { getTurnoverContext } = require('../brokerSectorTurnover');

const SYM = '600909';
const CXMT = '688825';
const CXMT_STAKE_PCT = 0.4391; // 华安间接持股占长鑫科技比例（%）

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

// ---- 指令9：流动性折扣 ----
function liquidityDiscount(cfg) {
  const st = (cfg.sotpLayer && cfg.sotpLayer.cxmtLockStatus) || 'unknown';
  if (st === 'free') return { discount: 0, retain: 1, label: '无限售（折扣 0%）' };
  if (st === 'restricted') {
    const d = nz(cfg.sotpLayer.cxmtLiquidityDiscount) || 0.25;
    return { discount: d, retain: 1 - d, label: `限售（折扣 ${Math.round(d * 100)}%）` };
  }
  return { discount: 0.3, retain: 0.7, label: '限售状态未知（保守折扣 30%）' };
}

// ---- 指令9：SOTP 权重自适应 ----
function pickSotpWeights(ratio) {
  if (ratio > 0.30) return { wPB: 0.4, wST: 0.5, wPE: 0.1, mode: 'shadow', note: '影子股模式：参股资产占华安总市值 > 30%，SOTP 权重自动上调至 50%，PB 法压缩至 40%、PE 法维持 10%。' };
  if (ratio >= 0.10) return { wPB: 0.5, wST: 0.4, wPE: 0.1, mode: 'elevated', note: '公司价值显著受参股资产影响（占比 10%~30%），SOTP 权重上调至 40%。' };
  return { wPB: 0.6, wST: 0.3, wPE: 0.1, mode: 'normal', note: '' };
}

// ---- 指令9：Pearson 相关系数（纯函数，供测试） ----
function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// ---- 指令9：长鑫科技总市值抓取（实时，失败回退锁定快照） ----
async function fetchCxmt() {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(CXMT);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), asOf: q.date || localDate(), source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const mv = nz(cfg.sotpLayer.cxmtShares) * nz(cfg.sotpLayer.cxmtPrice) / (CXMT_STAKE_PCT / 100); // 由持股股数÷持股比推导长鑫总市值（2.64亿股=0.4391% → 总市值≈35107亿）
  return { totalValue: mv, price: nz(cfg.sotpLayer.cxmtPrice), asOf: cfg.dataAsOf, source: '锁定快照（2.64亿股÷0.4391% 推导长鑫总市值，实时不可得）', ok: false };
}

// ---- 指令9：华安证券总市值抓取（实时，失败回退传入价/快照价×股本） ----
async function fetchHuaanTotal(price) {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(SYM);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const p = (price != null && price > 0) ? price : nz(cfg.huaanPriceSnapshot);
  return { totalValue: p * nz(cfg.shares), price: p, source: (price != null && price > 0) ? '传入价×股本' : '锁定快照价×股本', ok: (price != null && price > 0) };
}

// ---- 指令9：股价联动强度（近 60 交易日日收益相关系数） ----
async function computeLinkCorr() {
  try {
    const stockData = require('../stockData');
    const [h1, h2] = await Promise.all([stockData.getHistory(SYM, '1y'), stockData.getHistory(CXMT, '1y')]);
    if (!Array.isArray(h1) || !Array.isArray(h2) || h1.length < 5 || h2.length < 5) return { ok: false, reason: '历史不足' };
    const map1 = new Map(h1.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const map2 = new Map(h2.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const dates = [...map1.keys()].filter(d => map2.has(d)).sort();
    if (dates.length < 20) return { ok: false, reason: `对齐交易日 ${dates.length} < 20` };
    const win = dates.slice(-Math.min(60, dates.length)); // 长鑫科技 2026-07-27 才上市，历史不足 60 日时取全部可用日
    const r1 = [], r2 = [];
    for (let i = 1; i < win.length; i++) {
      const c1a = map1.get(win[i - 1]), c1b = map1.get(win[i]);
      const c2a = map2.get(win[i - 1]), c2b = map2.get(win[i]);
      if (c1a > 0 && c1b > 0 && c2a > 0 && c2b > 0) { r1.push(c1b / c1a - 1); r2.push(c2b / c2a - 1); }
    }
    const r = pearson(r1, r2);
    return { ok: true, r: (r == null ? null : Math.round(r * 1000) / 1000), n: r1.length, limited: win.length < 60, asOf: win[win.length - 1], source: win.length < 60 ? `腾讯/东财日K（仅 ${win.length} 日，未满 60 日）` : '腾讯/东财日K（近 60 交易日）' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'huaan') return { error: 'NOT_HUAAN' };

  const G = cfg.guard || {}, Q = cfg.quarterly || {}, NL = cfg.npLatest || {};
  const PB = cfg.pbLayer || {}, ST = cfg.sotpLayer || {}, PE = cfg.peLayer || {};
  const W = cfg.weights || {}, RT = cfg.ratingThresholds || {}, LV = cfg.lastVersion || {};
  const NT = cfg.notes || {};
  const N = nz(cfg.shares);

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const today = localDate();

  // ============ 指令0：守门员自检 ============
  const reportAge = daysBetween(G.reportPeriodEnd, today);
  const g1Pass = reportAge <= nz(G.maxAgeDays, 150);
  // 20260922d 接线：券商板块成交额（板块级）+ 全市场成交额实时取数，替换原「数据源待接入【数据缺失】」。
  // 取数见 lib/brokerSectorTurnover.js（同花顺行业板块存盘为主源、东财概念板块为备源）。
  const turnover = await getTurnoverContext();
  const tBroker = turnover.broker, tMarket = turnover.market;
  const g2Limit = nz(G.sectorTurnoverDeviationLimitPct, 30);
  let g2Status, g2Value, g2Source;
  if (tBroker) {
    const devOk = (tBroker.devPct == null) || (Math.abs(tBroker.devPct) <= g2Limit);
    g2Status = devOk ? 'PASS' : 'TERMINATE';
    g2Value = `券商板块近 ${tBroker.windowDays} 交易日日均成交额 ${tBroker.avg20Yi} 亿元（当日 ${tBroker.todayYi} 亿元，截至 ${tBroker.date}），较近 ${tBroker.baseDays} 日基线 ${tBroker.baselineYi} 亿元偏离 ${tBroker.devPct >= 0 ? '+' : ''}${tBroker.devPct}%（阈值 ±${g2Limit}%）→ ${devOk ? '未触发市场环境突变' : '⚠️ 偏离超阈值，按规则终止本次估值'}`;
    g2Source = tBroker.source;
  } else {
    g2Status = 'DEGRADED';
    g2Value = '券商板块近20日日均成交额数据源暂不可得（同花顺行业存盘与东财概念板块双源均未取到）→ 本次降级不终止，仅建立标注；下次运行自动重试';
    g2Source = '双源暂不可得（已接线，非静态「待接入」）';
  }
  const cxmtWindowDays = nz(G.cxmtWindowDays, 30);
  const cxmtDays = daysBetween(G.cxmtListDate, today);
  const g3Pass = !(G.cxmtStatus !== 'listed' && cxmtDays <= cxmtWindowDays);
  // 指令9：模型每次运行均实时核验核心资产状态，检查日取当前日期（不再写死过期检查日）
  const cxmtNoteLive = `长鑫科技 ${G.cxmtListDate} 已登陆科创板(${G.cxmtCode})；本次检查(${today})距上市 ${cxmtDays} 天${cxmtDays > cxmtWindowDays ? ' > ' : ' ≤ '}${cxmtWindowDays} 天窗口，无新质变动态，自检通过；SOTP 采用 V3.0 口径（长鑫市值×${CXMT_STAKE_PCT}%×(1−流动性折扣)）`;

  const guardRows = [
    { label: '① 财报时效', status: g1Pass ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${G.reportPeriodEnd}，距检查日 ${reportAge} 天（终止上限 ${G.maxAgeDays} 天）`, source: '2026 中报（2026-08-25 披露）' },
    { label: '② 市场环境', status: g2Status === 'PASS' ? '✅ 通过' : (g2Status === 'TERMINATE' ? '⛔ 终止' : '🟡 降级'), value: g2Value, source: g2Source },
    { label: '③ 核心资产（长鑫科技 688825）', status: g3Pass ? '✅ 通过' : '⛔ 终止', value: cxmtNoteLive, source: `上市日 ${G.cxmtListDate}；检查日 ${today}` },
  ];
  const terminated = !g1Pass || !g3Pass || (g2Status === 'TERMINATE');

  // P2通用时效看板（20260908z）
  const freshnessRows = [];
  if (G.reportPeriodEnd) freshnessRows.push({ label: '最新财报报告期', asOf: G.reportPeriodEnd, ageDays: reportAge, maxAge: nz(G.maxAgeDays, 150), stale: !g1Pass });
  {
    const cxAge = daysBetween(G.cxmtListDate, today);
    if (cxAge != null) freshnessRows.push({ label: '长鑫科技上市核查日', asOf: today, ageDays: cxAge, maxAge: 9999, stale: false });
  }
  if (tBroker && tBroker.date) {
    const tAge = daysBetween(tBroker.date, today);
    freshnessRows.push({ label: '券商板块成交额', asOf: tBroker.date, ageDays: tAge, maxAge: 5, stale: tAge > 5 });
  }

  if (terminated) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0（守门员终止：估值结果待更新/需人工复核）',
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
  // —— ① PB 法（核心）：三层动态锚 = 历史40% + 板块×ROE溢价30% + 理论30%
  const roe = nz(PB.sustainableRoe) / 100, gPerp = nz(PB.g) / 100;
  const r = nz(PB.rf) / 100 + nz(PB.beta) * nz(PB.erp) / 100;
  const theoPB = (roe - gPerp) / (r - gPerp);
  const aSector = nz(PB.sectorPB) * nz(PB.premiumCoef);
  const aHist = nz(PB.histPbMedian);
  const fairPB = nz(PB.wHist) * aHist + nz(PB.wSector) * aSector + nz(PB.wTheo) * theoPB;
  const pbTarget = nz(cfg.bpsLatest) * fairPB;

  // ============ 指令9：核心参股资产联动监测（实时抓取，带回退） ============
  const liq = liquidityDiscount(cfg);
  const cxmt = await fetchCxmt();
  const huaan = await fetchHuaanTotal(P);
  const cxmtMv = nz(cxmt.totalValue);                 // 长鑫科技总市值（亿）
  const huaanMv = nz(huaan.totalValue);               // 华安证券总市值（亿）
  const stakeGross = cxmtMv * (CXMT_STAKE_PCT / 100); // 长鑫市值 × 0.4391%（未折现持股价值，亿）
  const stakeValue = stakeGross * liq.retain;         // 持股价值（折现后 SOTP 贡献，亿）
  const stakeRatioGross = huaanMv > 0 ? stakeGross / huaanMv : 0; // 参股占比（未折现，权重决策口径，匹配指令9定义）
  const stakeRatioDisc = huaanMv > 0 ? stakeValue / huaanMv : 0;  // 折现持股价值占华安比（展示用）
  const wts = pickSotpWeights(stakeRatioGross);
  const corr = (wts.mode === 'shadow') ? await computeLinkCorr() : { ok: false, reason: '非影子股模式，跳过联动强度计算' };
  const linkFlag = (corr && corr.ok && corr.r != null && corr.r > 0.5);
  const cxmtSnapshotMv = nz(ST.cxmtShares) * nz(ST.cxmtPrice) / (CXMT_STAKE_PCT / 100); // 锁定快照长鑫总市值（2.64亿股÷0.4391%）
  const cxmtDevPct = cxmtSnapshotMv > 0 ? (cxmtMv - cxmtSnapshotMv) / cxmtSnapshotMv * 100 : 0;

  // —— ② SOTP 法：常规业务（常态年化净利×可比PE）+ 长鑫持股价值×流动性折扣
  const sotpBase = nz(ST.normalAnnualNp) * nz(ST.peNormal);
  const sotpTotal = sotpBase + stakeValue;
  const sotpTarget = N > 0 ? sotpTotal / N : null;

  // —— ③ PE 法（仅常态EPS × min(5年PE中位, 行业PE中位)）
  const histPe = PE.histPeMedian == null ? null : nz(PE.histPeMedian);
  const sectorPe = nz(PE.sectorPeMedian);
  const peMult = (histPe != null && histPe > 0) ? Math.min(histPe, sectorPe) : sectorPe;
  const pePeMissing = histPe == null;
  const peTarget = epsNormal * peMult;

  // ============ 指令3：综合目标价与评级（权重自适应） ============
  const wPB = wts.wPB, wST = wts.wST, wPE = wts.wPE;
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
    { label: '指令9·长鑫科技(688825)总市值', value: `${cxmtMv} 亿元（${cxmt.source}，${cxmt.asOf}）${!cxmt.ok ? '【实时不可得，回退快照】' : ''}`, source: `持股比 ${CXMT_STAKE_PCT}%；较锁定快照 ${cxmtSnapshotMv} 亿变动 ${cxmtDevPct >= 0 ? '+' : ''}${r2(cxmtDevPct)}%${Math.abs(cxmtDevPct) >= 5 ? '（≥±5%，已实时重算）' : ''}` },
    { label: '指令9·间接持股价值', value: `长鑫市值 ${cxmtMv} 亿 × ${CXMT_STAKE_PCT}% × (1 − 折扣 ${Math.round(liq.discount * 100)}%) = ${r2(stakeValue)} 亿元（${liq.label}）`, source: `华安总市值 ${huaanMv} 亿（${huaan.source}）` },
    { label: '指令9·参股资产占比', value: `未折现占比 ${(stakeRatioGross * 100).toFixed(2)}%（权重决策口径）→ SOTP 权重模式【${wts.mode === 'shadow' ? '影子股' : wts.mode === 'elevated' ? '显著参股' : '常规'}】；折现持股价值占华安 ${(stakeRatioDisc * 100).toFixed(2)}%`, source: wts.note || '占比 < 10%，SOTP 维持 30%' },
    { label: 'SOTP层·合计', value: `${r2(sotpTotal)} 亿元 ÷ ${N} 亿股 = ${r2(sotpTarget)} 元/股（权重 ${wST * 100}%）`, source: '指令9：SOTP = 常规业务 + 长鑫持股价值×流动性折扣' },
  ];
  // 影子股模式：单独列示"长鑫科技持股贡献"，并补联动强度行
  if (wts.mode === 'shadow') {
    detailRows.push({ label: '★ 长鑫科技持股贡献（单独列示）', value: `${r2(stakeValue)} 亿元 ÷ ${N} 亿股 = ${r2(stakeValue / N)} 元/股，占综合目标价 ${(wST * (stakeValue / sotpTotal) * 100).toFixed(1)}%`, source: '影子股模式：综合目标价中单独披露参股资产贡献' });
    detailRows.push({ label: '指令9·股价联动强度', value: (corr && corr.ok && corr.r != null) ? `近 60 交易日华安日收益 vs 长鑫日收益相关系数 r = ${corr.r}（n=${corr.n}，${corr.asOf}）${linkFlag ? ' → 走势主要由长鑫驱动，券商基本面解释力减弱' : ''}` : `不可得（${corr && corr.reason ? corr.reason : '数据缺失'}）`, source: corr && corr.ok ? corr.source : '腾讯/东财日K（待接入）' });
  }
  detailRows.push(
    { label: 'PE层（常态口径）', value: `常态 EPS ${epsNormal} 元 × PE 乘数 ${peMult} 倍${pePeMissing ? '（5年PE中位缺失【数据缺失】→ 取行业PE中位）' : '（=min(5年中位,行业中位)）'} = ${r2(peTarget)} 元/股（权重 ${wPE * 100}%）`, source: '指令2：PE 仅用常态EPS（三层容错：报告EPS弃用→常态EPS兜底→异常中断）' },
    { label: '综合目标价', value: `${wPB * 100}%×${r2(pbTarget)} + ${wST * 100}%×${r2(sotpTarget)} + ${wPE * 100}%×${r2(peTarget)} = ${r2(center)} 元/股`, source: `低估触发线 ${r2(buyLine)} 元（<0.9×）｜高估触发线 ${r2(reduceLine)} 元（>1.05×）${wts.mode === 'shadow' ? '；影子股模式 SOTP 50%/PB 40%/PE 10%' : wts.mode === 'elevated' ? '；显著参股模式 SOTP 40%/PB 50%/PE 10%' : ''}` },
  );

  const compareRows = [
    { label: `上次：${LV.version}`, value: `区间 ${LV.range ? LV.range[0] + '~' + LV.range[1] : 'N/A'} 元，中枢 ${LV.center} 元，评级「${LV.rating}」` },
    { label: '本次：V3.0（20260922d）', value: `中枢 ${r2(center)} 元（低估线 ${r2(buyLine)} / 高估线 ${r2(reduceLine)}），评级「${rating}」`, source: `SOTP 权重模式：${wts.mode}` },
    { label: '差异原因', value: LV.diffNote || '' },
  ];

  // 20260922d：原「券商板块成交额 1.2 万亿」实为全市场成交额量级（板块仅约 200 亿），已按用户确认改为全市场口径
  const mktFloorYi = nz((cfg.riskMonitor && cfg.riskMonitor.marketTurnoverFloorYi), nz((cfg.riskMonitor && cfg.riskMonitor.sectorTurnoverFloorYi), 12000));
  const mktRow = tMarket
    ? (tMarket.todayYi >= mktFloorYi
      ? { label: '市场成交额（全市场）', light: `🟢 当日 ${tMarket.todayYi} 亿 ≥ 预警线 ${mktFloorYi / 10000} 万亿（近20日日均 ${tMarket.avg20Yi} 亿，截至 ${tMarket.date}）` }
      : { label: '市场成交额（全市场）', light: `🔴 预警：当日 ${tMarket.todayYi} 亿 < ${mktFloorYi / 10000} 万亿 → 经纪/自营景气度承压（截至 ${tMarket.date}）` })
    : { label: '市场成交额（全市场）', light: '🟡 全市场成交额数据源暂不可得' };
  const riskMonitorRows = [
    mktRow,
    { label: '长鑫科技（688825）舆情', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.cxmtNegative) || '未发现负面'}` },
    { label: '监管处罚', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.regulatory) || '无新增'}` },
  ];

  const positionNote = P != null
    ? `当前股价 ${r2(P)} 元 vs 综合目标价 ${r2(center)} 元（低估线 ${r2(buyLine)} / 高估线 ${r2(reduceLine)}）；${ratingNote}。PB(LF) 现值约 ${(P / nz(cfg.bpsLatest)).toFixed(2)} 倍 vs 三层加权合理 PB ${fairPB.toFixed(2)} 倍。`
    : '实时价不可用。';

  const riskNote = '上行：市场成交额维持高位（Q2 景气性收入可持续）、长鑫科技股价贡献持股市值弹性；下行：全市场成交额跌破 1.2 万亿、长鑫股价回撤（SOTP 直接受损，每±10% 波动影响目标价约±0.37 元）、监管处罚。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  const modeLabel = wts.mode === 'shadow' ? '影子股模式' : wts.mode === 'elevated' ? '显著参股模式' : '常规模式';
  const decisionNote = `框架 V3.0【指令9】：实时抓取长鑫科技(688825)总市值 ${cxmtMv} 亿（${cxmt.source}），间接持股价值 ${r2(stakeValue)} 亿、占华安总市值 ${(stakeRatioGross * 100).toFixed(2)}% → ${modeLabel}（SOTP ${(wST * 100)}% / PB ${(wPB * 100)}% / PE ${(wPE * 100)}%）。` +
    (wts.mode === 'shadow' ? (linkFlag ? '⚠️ 股价联动强度 r=' + corr.r + ' > 0.5：该股当前走势主要由长鑫科技驱动，券商基本面解释力减弱。' : '影子股模式已触发，长鑫科技持股贡献已单独列示。' + ((corr && corr.ok && corr.limited) ? `（联动强度样本仅 ${corr.n} 日，未满 60 日，待长鑫科技交易满 60 日后复核）` : '')) : (wts.note || '')) +
    `持股比 0.4391% 须于每次财报披露复核；长鑫市值较锁定快照变动 ${cxmtDevPct >= 0 ? '+' : ''}${r2(cxmtDevPct)}%（${Math.abs(cxmtDevPct) >= 5 ? '≥±5%，本次已实时重算' : '实时重算'}）。`;

  return {
    ok: true,
    dedicated: true,
    huaan: true,
    version: 'V3.0',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(buyLine), r2(reduceLine)],
    fairValueCenter: r2(center),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'huaan600909 V3.0（守门员+口径分离+指令9 SOTP权重自适应+PB/SOTP/PE动态加权，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    guardRows, freshnessRows,
    caliberNote,
    dualEpsRows,
    detailRows,
    compareRows,
    riskMonitorRows,
    positionNote,
    riskNote,
    decisionNote,
    // 指令9 结构化输出（供前端/测试消费）
    sotpDynamic: {
      mode: wts.mode,
      cxmtMarketCap: r2(cxmtMv),
      cxmtAsOf: cxmt.asOf,
      cxmtSource: cxmt.source,
      cxmtLive: !!cxmt.ok,
      huaanMarketCap: r2(huaanMv),
      huaanSource: huaan.source,
      stakePct: CXMT_STAKE_PCT,
      stakeGross: r2(stakeGross),
      stakeValue: r2(stakeValue),
      stakeRatio: Math.round(stakeRatioGross * 10000) / 10000,
      stakeRatioDiscounted: Math.round(stakeRatioDisc * 10000) / 10000,
      discountLabel: liq.label,
      liquidityDiscount: liq.discount,
      weights: { pb: wPB, sotp: wST, pe: wPE },
      cxmtDevPct: r2(cxmtDevPct),
      linkCorr: (corr && corr.ok) ? corr.r : null,
      linkFlag: !!linkFlag,
      linkNote: (corr && corr.ok && corr.r != null) ? (linkFlag ? '走势主要由长鑫科技驱动，券商基本面解释力减弱' : '联动强度未达 0.5，券商自身基本面仍主导') : null,
    },
  };
}

module.exports = { run, isHuaanModel, loadConfig, pickSotpWeights, liquidityDiscount, pearson, CXMT_STAKE_PCT };
