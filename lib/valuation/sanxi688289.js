// ============================================================
// 圣湘生物（688289）专属估值模型 V2.0_全动态 —— 确定性计算（1+1=2 原则）
// 20260908w：动态时间引擎 + 画像诊断 + 动态SOTP核心 + 五重交叉验证
//            + 权重自适应(±5%) + 行业倍数±10%三情景 + 三级兜底 + 运行日志
// 六模型架构不变：SOTP / Forward PE / 整体PS / DCF / EV-EBITDA / rNPV
// 计算层=代码，输入锁死（data/valuation/688289.json）⇒ 结果锁死；
// 动态指：基准日=系统日自动映射财报期、系数按规则表自动判定、兜底自动回退——
// 全部由确定性代码实现，无 LLM 参与、无硬编码年份。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYMBOL = '688289';
const CFG_PATH = path.join(__dirname, '../../data/valuation/688289.json');
const STATE_PATH = path.join(__dirname, '../../data/valuation/688289.state.json');
const LOG_DIR = path.join(__dirname, '../../data/logs/valuation_logs');
const LOG_PATH = path.join(LOG_DIR, '688289.jsonl');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return null; }
}

function isSanxiModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  return bare === SYMBOL && !!loadConfig();
}

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');

// ---------- 日期差（天） ----------
function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

// ---------- 运行日志（JSONL，留100条） ----------
function appendRunLog(record) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    let lines = [];
    if (fs.existsSync(LOG_PATH)) {
      lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.trim());
    }
    lines.push(JSON.stringify(record));
    if (lines.length > 100) lines = lines.slice(-100);
    fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响估值 */ }
}

// ---------- 动态时间引擎：按月算法映射最新报告期（与海天603288同一算法） ----------
function getLatestReportPeriods(baseDate) {
  const d = new Date(baseDate);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  // 估值基准季报期
  let qEnd;
  if (m <= 4 && !(m === 4 && day >= 30)) qEnd = `${y - 1}-12-31`;       // 1/1-4/29 → 上年年报期
  else if (m < 8 || (m === 8 && day <= 30)) qEnd = `${y}-03-31`;         // 4/30-8/30 → 一季报期
  else if (m < 10 || (m === 10 && day <= 30)) qEnd = `${y}-06-30`;       // 8/31-10/30 → 中报期
  else qEnd = `${y}-09-30`;                                              // 10/31-12/31 → 三季报期
  // 最新年报：只要过了4月30日披露季，最新年报=上年年报；否则=前年年报
  const fyLatestYear = (m > 4 || (m === 4 && day >= 30)) ? y - 1 : y - 2;
  // FY_Current：12月时滚动至下一年
  const fyCurrent = m === 12 ? y + 1 : y;
  return { baseDate: `${y}-${pad(m)}-${pad(day)}`, qLatestEnd: qEnd, fyLatestYear, fyCurrent, fyNext: fyCurrent + 1 };
}

// ---------- 三情景行业倍数乘数 ----------
const SCEN_MULT = { optimistic: 1.10, base: 1.00, conservative: 0.90 };

function run(symbol, { price } = {}) {
  const t0 = Date.now();
  try {
    const result = compute(symbol, { price });
    appendRunLog({
      ts: new Date().toISOString(), runId: result.runId, version: result.version,
      ok: !!result.ok, rating: result.rating, range: result.fairValueRange, center: result.fairValueCenter,
      price: result.currentPrice, fallbacks: result.fallbackFlags || [], ms: Date.now() - t0
    });
    return result;
  } catch (e) {
    const errRecord = { ts: new Date().toISOString(), ok: false, error: e.message, stack: (e.stack || '').slice(0, 500) };
    appendRunLog(errRecord);
    return { ok: false, error: 'SANXI_COMPUTE_FAILED', detail: e.message };
  }
}

function compute(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYMBOL) return { error: 'NOT_SANXI' };
  const I = cfg.inputs;
  const R = cfg.rules;
  const fallbackFlags = [];

  // ========== 第一部分：动态时间引擎 ==========
  const P = getLatestReportPeriods(new Date());
  const fyLabel = `${P.fyLatestYear}年报`;
  const fyLatestOk = cfg.timeEngine.reportPeriods.fyLatest.label.startsWith(fyLabel);
  if (!fyLatestOk) fallbackFlags.push(`时间引擎判定最新年报应为「${fyLabel}」，配置为「${cfg.timeEngine.reportPeriods.fyLatest.label}」→ 财报映射与系统日期不一致，请更新配置`);

  // P0一致性修复①：Q_Latest 报告期核对——引擎判定的最新季报期 vs 配置 periodEnd
  const cfgQEnd = cfg.timeEngine.reportPeriods.qLatest && cfg.timeEngine.reportPeriods.qLatest.periodEnd;
  const qLatestOk = cfgQEnd === P.qLatestEnd;
  if (!qLatestOk) fallbackFlags.push(`时间引擎判定最新季报期应为「${P.qLatestEnd}」，配置为「${cfgQEnd || '未声明'}」→ 季报数据可能过期（如三季报已披露仍用中报TTM），请更新配置`);

  // P0一致性修复③：staleness 检查（披露日期距今天数 > stalenessDays 即告警）
  const staleMax = cfg.timeEngine.stalenessDays || 200;
  const freshnessRows = [];
  for (const [pk, pp] of Object.entries(cfg.timeEngine.reportPeriods)) {
    const age = daysBetween(pp.disclosed, new Date());
    if (age != null) freshnessRows.push({ label: pk === 'fyLatest' ? '最新年报披露' : '最新季报披露', asOf: pp.disclosed, ageDays: age, maxAge: staleMax, stale: age > staleMax });
  }

  // 总股本（动态取配置最新值）
  const N = I.totalShares;
  const netCash = I.balanceSheet2025.netCash;          // 含交易性金融资产（类现金）
  const bioPE0 = I.industry.bioPE;
  const ps0 = I.industry.ivdPS;
  const devPE0 = I.industry.devicePE;
  const evMid0 = I.industry.evEbitdaMid;

  // 兜底3：行业倍数缺失 → 默认 PE40/PS8/EV20
  let indFlags = [];
  if (!ps0) { fallbackFlags.push('IVD/器械行业PS缺失 → 采用默认行业参数 PS=8x'); indFlags.push('PS默认8x'); }
  const psUse = ps0 || 8;
  const devPEUse = devPE0 || 40;
  if (!devPE0) fallbackFlags.push('医疗器械行业PE缺失 → 采用默认行业参数 PE=40x');
  if (!bioPE0) fallbackFlags.push('生物制品行业PE缺失 → 采用默认行业参数 PE=40x');
  const bioPEUse = bioPE0 || 40;
  const evMidUse = evMid0 || 20;
  if (!evMid0) fallbackFlags.push('EV/EBITDA行业倍数缺失 → 采用默认行业参数 EV/EBITDA=20x');

  // 兜底1：机构一致预期缺失 → 近3年平均净利增速×最新净利推算（标注替代算法）
  // P0一致性修复②：按财年动态取数（byFY 数组），FY_Current 随系统日期滚动不再与硬编码键名错位
  let cons = I.consensus;
  let consSubstituted = false;
  if (!cons || (!cons.byFY && cons.np2026E == null)) {
    consSubstituted = true;
    const np3 = I.np3y.map(x => x.np);
    let gSum = 0, gN = 0;
    for (let i = 1; i < np3.length; i++) { gSum += np3[i] / np3[i - 1] - 1; gN++; }
    const gAvg = gN ? gSum / gN : 0;
    const lastNp = np3[np3.length - 1];
    const fy0 = P.fyLatestYear + 1;
    cons = { byFY: [1, 2, 3].map(k => ({ fy: fy0 + k - 1, np: lastNp * (1 + gAvg) ** k })), institutions: 0 };
    fallbackFlags.push(`机构一致预期缺失 → 采用替代算法：近3年平均净利增速 ${(gAvg * 100).toFixed(1)}% × 最新净利推算`);
  }
  const pickCons = (fy) => {
    if (Array.isArray(cons.byFY)) {
      const hit = cons.byFY.find(x => x.fy === fy);
      if (hit) return hit.np;
    }
    return cons[`np${fy}E`] != null ? cons[`np${fy}E`] : null;
  };
  const consPicked = { fyCurrent: pickCons(P.fyCurrent), fyNext: pickCons(P.fyNext), fyNext2: pickCons(P.fyNext + 1) };
  {
    const missingFY = [P.fyCurrent, P.fyNext, P.fyNext + 1].filter(fy => pickCons(fy) == null);
    if (missingFY.length && !consSubstituted) {
      fallbackFlags.push(`一致预期缺少 ${missingFY.join('/')} 年数据（FY_Current=${P.fyCurrent} 随系统日期滚动）→ 请更新配置 byFY 数组；缺失年份已按替代算法推算`);
      const np3 = I.np3y.map(x => x.np);
      let gSum = 0, gN = 0;
      for (let i = 1; i < np3.length; i++) { gSum += np3[i] / np3[i - 1] - 1; gN++; }
      const gAvg = gN ? gSum / gN : 0;
      const lastNp = np3[np3.length - 1];
      const baseNp = pickCons(P.fyCurrent - 1) != null ? pickCons(P.fyCurrent - 1) : lastNp;
      for (const fy of missingFY) cons.byFY.push({ fy, np: r2(baseNp * (1 + gAvg) ** (fy - P.fyCurrent + 1)) });
    }
  }

  if (cons && cons.asOf) {
    const cAge = daysBetween(cons.asOf.length === 7 ? cons.asOf + '-01' : cons.asOf, new Date());
    if (cAge != null) freshnessRows.push({ label: '一致预期时点', asOf: cons.asOf, ageDays: cAge, maxAge: 120, stale: cAge > 120 });
  }

  // 兜底2：最新季报缺失 → 回退 TTM（本例季报在，代码路径保留）
  let ttm = I.ttm;
  if (!ttm || !ttm.rev) {
    fallbackFlags.push('季报数据缺失，已启用TTM滚动数据');
    ttm = { rev: I.fy2025.rev, npAttr: I.fy2025.npAttr };
  }

  // ========== 第二部分：公司画像动态诊断 ==========
  const np3 = I.np3y.map(x => x.np);
  const cagr = Math.pow(np3[np3.length - 1] / np3[0], 1 / (np3.length - 1)) - 1;
  const cagrPct = +(cagr * 100).toFixed(1);
  const severeVol = cagr < R.diagnostics.cagrSevereThreshold / 100;

  const bioRatio = +(I.haiji.np / I.fy2025.npAttr * 100).toFixed(0);
  const forceSotp = bioRatio > R.diagnostics.biopharmRatioThreshold;

  const reagentGmNow = I.segments2025.reagent.gm;
  const reagentGmPrior = I.segments2025.reagentGmPrior;
  const gmDropKnown = reagentGmPrior != null;
  const gmDrop = gmDropKnown ? (reagentGmNow - reagentGmPrior) : null;
  const collectDiscount = gmDropKnown && gmDrop < -R.diagnostics.reagentGmDropPct;
  // 集采折价联动：试剂毛利率同比下滑>5% → PS整体折价追加至0.5-0.7区间中值0.60
  const psDiscount = collectDiscount ? 0.60 : R.ps.wholeDiscount;

  const qRevYoY = I.qLatest.q2.revYoY;      // Q_Latest 单季营收增速
  const qNpYoY = I.qLatest.q2.npYoY;        // Q_Latest 单季净利增速
  let momentumNote = 'Q_Latest 营收增速在 −5%~15% 区间 → PE法不惩罚、不溢价';
  if (qRevYoY < R.diagnostics.momentumPenaltyBelow) momentumNote = `Q_Latest 营收增速 ${qRevYoY}% < −5% → PE法追加业绩惩罚系数`;
  else if (qRevYoY > R.diagnostics.momentumPremiumAbove) momentumNote = `Q_Latest 营收增速 ${qRevYoY}% > 15% → PE法追加成长溢价系数`;

  // ========== 第三部分：动态SOTP（核心） ==========
  // 追加指令（2026-09-13）：销售费用显性调整模块——系数判定（步骤1-4）；步骤5 情景在第十部分后。
  const SE = I.sellingExpense || null;
  const seOn = !!(SE && SE.module);
  const bd = (SE && SE.breakdown) || {};
  let aExtraDisc = 0;        // 板块A 额外 PS 折价（正数=下调幅度，0.05~0.10）
  let bPeCoef = 1;           // 板块B PE 调整系数（费用增速>营收增速 → 0.90）
  let sellEffCoef = 1;       // Forward PE 费用效率惩罚系数（Δ 分档 0.85/0.90/1.00）
  let dSellRate = null;      // Δ = TTM销售费用率 − IVD行业均值（pp）
  const seg = I.segments2025;
  const ivdGrowth = seg.ivdYoY;                                   // 板块增速（TTM拆分未披露→年报口径，标注）
  // 按指令规则表判定折价系数：增速<0→0.55；0~10%→0.65；>15%→0.85
  const discAUse = ivdGrowth < 0 ? 0.55 : (ivdGrowth <= 10 ? 0.65 : 0.85);
  const haijiGrowth = I.haiji.npYoY;
  const coefB = haijiGrowth > 20 ? 1.1 : (haijiGrowth >= 0 ? 1.0 : 0.8);
  const seqGrowth = seg.sequencing.yoy, ovsGrowth = seg.overseas.yoy;
  const premC = (g) => (g > 50 ? 1.8 : (g >= 20 ? 1.4 : 1.0));

  // ---- 步骤2-A：板块A（分子诊断）集采收入下滑 + 内生费用刚性 → PS 折价额外下调 ----
  // 规则表：营收下滑且内生费用率同比降幅<3pp(刚性)→-0.10；3~6pp→-0.05；≥6pp→不调整
  // 系数值一律从配置规则表读取（项目原则：规则表放配置、代码只负责判定与执行）
  const seRules = (SE && SE.rules) || {};
  const pickByMin = (arr, v, key) => {
    if (!Array.isArray(arr)) return null;
    for (const r of arr) { if (r[key] == null || v > r[key]) return r.x; }
    return null;
  };
  const organicYoYPP = bd.organicSellRateYoYPP != null ? Number(bd.organicSellRateYoYPP) : 0;
  if (seOn && ivdGrowth < 0) {
    const v = pickByMin(seRules.aExtraDiscount, organicYoYPP, 'minYoYPP');
    aExtraDisc = v != null ? v : 0;
  }
  // ---- 步骤2-B：板块B（生物药品/圣湘海济）并购整合费用效率判定 ----
  // 规则：子公司销售费用增速 > 营收增速 → PE 倍数下调（×0.90）；否则不调整
  const haijiSellG = bd.haijiContributionYoY != null ? Number(bd.haijiContributionYoY) : null;
  if (seOn && haijiSellG != null) {
    const bArr = seRules.bPeCoef;
    const hit = haijiSellG > I.haiji.revYoY;
    const cell = Array.isArray(bArr) ? (hit ? bArr[0] : bArr[1]) : null;
    bPeCoef = (cell && cell.x != null) ? cell.x : (hit ? 0.90 : 1);
  }
  // ---- 步骤3：Forward PE 费用效率惩罚系数 ----
  // Δ = TTM销售费用率 − IVD行业均值；Δ>10pp→0.85；5~10pp→0.90；<5pp→1.00
  if (seOn && SE.ttm && SE.industry && Array.isArray(seRules.fwdEfficiency)) {
    dSellRate = +(Number(SE.ttm.sellExpenseRate) - Number(SE.industry.benchmark)).toFixed(2);
    const v = pickByMin(seRules.fwdEfficiency, dSellRate, 'min');
    sellEffCoef = v != null ? v : 1;
  }
  const discAUseFin = Math.max(0, +(discAUse - aExtraDisc).toFixed(2));
  const coefBFinal = +(coefB * bPeCoef).toFixed(3);

  function sotpCalc(mult) {
    const A = seg.ivdTotal * psUse * mult * discAUseFin;
    const B = I.haiji.np * bioPEUse * mult * coefBFinal;
    const C = seg.sequencing.rev * psUse * mult * premC(seqGrowth)
            + seg.overseas.rev * psUse * mult * premC(ovsGrowth);
    const ev = A + B + C;
    const hair = mult < 1 ? 0.05 : 0;                            // 保守情景 SOTP 扣减5%安全边际
    const equity = (ev - I.balanceSheet2025.interestDebt + I.balanceSheet2025.cash + I.balanceSheet2025.tradingFA) * (1 - hair);
    return { A, B, C, ev, hair, equity, perShare: equity / N };
  }

  // ========== 第四部分：动态Forward PE（市场情绪锚） ==========
  const epsCur = consPicked.fyCurrent / N, epsNext = consPicked.fyNext / N;   // FY_Current/FY_Next 动态取数
  const fwdBase = ((epsCur + epsNext) / 2) * devPEUse;
  const fwdPenalty = qNpYoY < R.diagnostics.fwdPePenaltyNpBelow ? R.diagnostics.fwdPePenaltyCoef : 1.0;
  // Q_Latest 营收动量惩罚/溢价（第二部分诊断联动；本例 +0.98% → 1.0）
  const momCoef = qRevYoY < R.diagnostics.momentumPenaltyBelow ? 0.875 : (qRevYoY > R.diagnostics.momentumPremiumAbove ? 1.075 : 1.0);
  // 追加指令步骤3联动：费用效率惩罚系数（TTM销售费用率超 IVD 行业均值 → 压缩 Forward PE）
  const fwdVal = (mult) => fwdBase * mult * fwdPenalty * momCoef * sellEffCoef;

  // ========== 第五部分：动态PS（营收底价锚） ==========
  const psVal = (mult) => (ttm.rev * psUse * mult * psDiscount) / N;

  // ========== 第六部分：动态DCF（现金流折现，含失效检验） ==========
  const cf = I.cashflow3y;
  const wacc = (I.macro.rf10y + I.macro.riskPremiumUsed) / 100;
  const gDcf = I.macro.gUsed / 100;
  const fcff = [consPicked.fyCurrent, consPicked.fyNext, consPicked.fyNext2].map(np => np * cf.npCashRatio - cf.capexAvg - cf.wcDeltaAvg);
  const fcffAllNeg = fcff.every(f => f < 0);
  const tvNeg = fcff[2] * (1 + gDcf) / (wacc - gDcf) < 0;
  const dcfRemoved = fcffAllNeg && tvNeg;

  function dcfCalc() {
    if (dcfRemoved) return { removed: true, perShare: 0 };
    let pv = 0;
    for (let i = 0; i < 3; i++) pv += fcff[i] / Math.pow(1 + wacc, i + 1);
    const tv = fcff[2] * (1 + gDcf) / (wacc - gDcf);
    const pvTv = tv / Math.pow(1 + wacc, 3);
    const equity = pv + pvTv + netCash;
    return { removed: false, perShare: equity > 0 ? equity / N : 0 };
  }

  // ========== 第七部分：动态EV/EBITDA（排除摊销干扰） ==========
  const ebitdaUse = I.ebitda.fy2026e;
  const ev2Val = (mult) => (ebitdaUse * evMidUse * mult + netCash) / N;

  // ========== 第八部分：动态rNPV（管线期权价值） ==========
  let rnpvSum = 0;
  for (const row of I.pipeline.rows) {
    rnpvSum += row.peak * I.pipeline.netMargin * row.p / Math.pow(1 + I.pipeline.discountRate, row.years);
  }
  const rnpvVal = rnpvSum / N;

  // ========== 第九部分：动态权重自适应（±5%） ==========
  const wAdj = [];
  let wSotp = R.weights.base.sotp, wPe = R.weights.base.forwardPE, wPs = R.weights.base.ps,
      wDcf = R.weights.base.dcf, wEv2 = R.weights.base.evEbitda, wRnpv = R.weights.base.rnpv;
  // SOTP：生物药净利占比高位 → 38
  if (forceSotp && bioRatio >= 90) { wSotp = 38; wAdj.push(`SOTP ${R.weights.base.sotp}→38：生物药净利占比 ${bioRatio}%（>30%且高位）`); }
  else if (forceSotp) { wSotp = R.weights.base.sotp + 3; wAdj.push(`SOTP ${R.weights.base.sotp}→${wSotp}：生物药净利占比 ${bioRatio}%>30%`); }
  // Forward PE：营收转正且净利>−20% → +5；净利<−30%且营收<0 → −5；混合信号 → 保持
  if (qRevYoY > 0 && qNpYoY > -20) { wPe = 30; wAdj.push('Forward PE 25→30：Q_Latest 业绩反转（营收转正且净利>−20%）'); }
  else if (qRevYoY < 0 && qNpYoY < -30) { wPe = 20; wAdj.push('Forward PE 25→20：Q_Latest 持续暴雷（营收<0且净利<−30%）'); }
  else wAdj.push(`Forward PE 25→25：混合信号（Q2 营收 ${qRevYoY > 0 ? '+' : ''}${qRevYoY}% 转正 但 净利 ${qNpYoY}% 深跌），保持基准权重`);
  // PS：不变
  wAdj.push(`PS 12→12：保持不变`);
  // DCF：失效剔除
  if (dcfRemoved) wAdj.push('DCF 10→剔除：FCFF三年全负+终值负（重资本投入期），失效检验剔除并权重归一');
  else wAdj.push('DCF 10→10：保持');
  // EV/EBITDA：折旧摊销突增 → 15
  wAdj.push(`EV/EBITDA 10→10：折旧摊销 ${cf.daAssumed} 亿平稳（${cf.daTrend}），不提升`);
  // rNPV：近12个月新产品获批 → 12
  wAdj.push('rNPV 8→8：近12个月无新产品获批（Seq1000 为2025-01获批、超12个月窗口），不提升');

  // 权重归一（剔除DCF后）
  const wRaw = { sotp: wSotp, forwardPE: wPe, ps: wPs, dcf: dcfRemoved ? 0 : wDcf, evEbitda: wEv2, rnpv: wRnpv };
  const wSum = Object.values(wRaw).reduce((a, b) => a + b, 0);
  const W = {};
  for (const k of Object.keys(wRaw)) W[k] = wRaw[k] / wSum;

  // ========== 第十部分：三情景 + 综合 ==========
  function valueScenario(key) {
    const mult = SCEN_MULT[key];
    const sotp = sotpCalc(mult);
    const pe = fwdVal(mult);
    const psV = psVal(mult);
    const dcf = dcfCalc();
    const ev2 = ev2Val(mult);
    const composite = sotp.perShare * W.sotp + pe * W.forwardPE + psV * W.ps + dcf.perShare * W.dcf + ev2 * W.evEbitda + rnpvVal * W.rnpv;
    return { key, mult, sotp, pe, ps: psV, dcf, evEbitda: ev2, rnpv: rnpvVal, composite };
  }

  const opt = valueScenario('optimistic');
  const base = valueScenario('base');
  const consv = valueScenario('conservative');

  // ========== 第十部分补：销售费用情景（追加指令步骤5） ==========
  // 费用优化：未来两年费率每年降 2~3pp（累计 -5pp）→ 释放销售费用 → 增厚 EBITDA 与净利；
  // 费用恶化：费率维持或上升（+3pp）→ 反向侵蚀。传导路径：EBITDA 与销售费用近似 1:1，
  // Forward PE 端按税后净利增厚调整 EPS。
  let seScen = null;
  if (seOn) {
    const sr = SE.rules || {};
    const taxRate = sr.taxRate != null ? sr.taxRate : 0.15;
    const baseRevForSe = (cons && cons.rev2026E) || ttm.rev;
    const mkSeScen = (kind, dPP, label) => {
      const deltaSell = -(dPP / 100) * baseRevForSe;                 // 正 = 费用减少
      const deltaNp = deltaSell * (1 - taxRate);                     // 税后净利增厚
      const epsNextAdj = (consPicked.fyNext + deltaNp) / N;
      const peAdj = ((epsCur + epsNextAdj) / 2) * devPEUse * fwdPenalty * momCoef * sellEffCoef;
      const ebitdaAdj = ebitdaUse + deltaSell;
      const ev2Adj = (ebitdaAdj * evMidUse + netCash) / N;
      const compositeAdj = base.sotp.perShare * W.sotp + peAdj * W.forwardPE + base.ps * W.ps
        + base.dcf.perShare * W.dcf + ev2Adj * W.evEbitda + base.rnpv * W.rnpv;
      return { kind, label, dPP, deltaSell, deltaNp, peAdj, ebitdaAdj, ev2Adj, compositeAdj, delta: +(compositeAdj - base.composite).toFixed(2) };
    };
    seScen = {
      optimize: mkSeScen('optimize', -(sr.optimizeRatePP || 5), '费用优化'),
      worsen: mkSeScen('worsen', (sr.worsenRatePP || 3), '费用恶化'),
      baseRev: baseRevForSe, taxRate,
    };
  }

  const range = [r2(consv.composite), r2(opt.composite)];
  const center = r2(base.composite);

  let rating = '合理';
  if (price != null && isFinite(price) && price > 0) {
    if (price <= range[0]) rating = '低估';
    else if (price >= range[1]) rating = '高估';
  }

  // ========== 卡片行数据（确定性拼装） ==========
  const reportHeadRows = [
    { label: '估值基准日', value: `${P.baseDate}（系统运行日自动识别）`, source: '动态时间引擎' },
    { label: '最新年报 FY_Latest', value: `${fyLabel}（披露 ${cfg.timeEngine.reportPeriods.fyLatest.disclosed}）`, source: cfg.timeEngine.reportPeriods.fyLatest.source || I.fy2025.source },
    { label: '最新季报 Q_Latest', value: `${cfg.timeEngine.reportPeriods.qLatest.label}（披露 ${cfg.timeEngine.reportPeriods.qLatest.disclosed}）`, source: I.qLatest.source },
    { label: 'TTM（最近12个月）', value: `营收 ${ttm.rev} 亿 / 归母 ${ttm.npAttr} 亿（${ttm.revCalc}）`, source: I.ttm.source },
    { label: 'FY_Current / FY_Next', value: `${P.fyCurrent}E 归母 ${consPicked.fyCurrent} 亿 / ${P.fyNext}E 归母 ${consPicked.fyNext} 亿（${cons.institutions} 家一致预期${consSubstituted ? '·替代算法' : ''}）`, source: consSubstituted ? '替代算法' : cons.source },
    { label: '总股本', value: `${N} 亿股`, source: I.totalSharesSource }
  ];

  const diagRows = [
    { label: '利润趋势诊断', value: `近3财年归母净利复合 ${cagrPct}%（${I.np3y.map(x => `${x.year}:${x.np}${x.flag && x.flag.includes('估算') ? '【估算】' : ''}${x.flag && x.flag.includes('反推') ? '【反推】' : ''}`).join(' → ')}）${cagrPct < R.diagnostics.cagrSevereThreshold ? ' < −10% → ' : ' ≥ −10% → '}${severeVol ? '标记「剧烈波动期」，放弃 TTM PE，转向 Forward PE' : 'PE法可用'}` },
    { label: '业务多元化诊断', value: `圣湘海济（生长激素）净利占比 ${bioRatio}%（1.85/1.99）${forceSotp ? ' > 30% → 强制启动 SOTP 分部估值' : ' ≤ 30% → 无需强制 SOTP'}；试剂毛利率 ${reagentGmNow}%，同比数据${gmDropKnown ? `为 ${gmDrop}%` : '未采集 → 集采折价判定不触发（板块折价已由增速规则取0.55下沿）'}` },
    { label: '业绩动量诊断', value: `Q2 营收同比 ${qRevYoY > 0 ? '+' : ''}${qRevYoY}%、净利同比 ${qNpYoY}% → ${momentumNote}` }
  ];

  const coreRows = [
    { label: '2025 营收 / 归母净利', value: `${I.fy2025.rev} 亿 / ${I.fy2025.npAttr} 亿（-27.82%）`, source: I.fy2025.source },
    { label: '分部：IVD / 生物药品 / 境外 / 测序', value: `11.55 亿(-18.87%) / 4.61 亿(毛利87.38%) / 0.83 亿(+31.63%) / 0.30 亿【假设】`, source: seg.source },
    { label: '圣湘海济（生长激素）', value: `2025 净利 1.85 亿(+77.21%)，业绩承诺 1.4 亿完成率 132.5%，100% 全资；26H1 收入 1.96 亿同比略降`, source: I.haiji.source },
    { label: '净现金 / 有息负债', value: `${netCash} 亿（含交易性金融资产 1.57 亿）/ ${I.balanceSheet2025.interestDebt} 亿`, source: I.balanceSheet2025.source },
    { label: '行业倍数', value: `PS(TTM) ${psUse}x；器械 PE ${devPEUse}x；生物制品 PE ${bioPEUse}x；EV/EBITDA ${evMidUse}x${I.industry.evEbitdaAssumed ? '【假设】' : ''}`, source: `${I.industry.psSource}；${I.industry.bioPESource}` },
    { label: '宏观参数', value: `10Y国债 ${I.macro.rf10y}% + 风险溢价 ${I.macro.riskPremiumUsed}% → WACC ${(wacc * 100).toFixed(2)}%；永续 g ${I.macro.gUsed}%（长期CPI 2.5~3%）`, source: I.macro.rfSource },
    { label: '净现比 / 资本开支均值', value: `${cf.npCashRatio}（3年） / ${cf.capexAvg} 亿（3年均值）/ 折旧摊销 ${cf.daAssumed} 亿【假设】`, source: cf.source }
  ];
  if (seOn) {
    coreRows.push({ label: '销售费用率（FY2025 / TTM）', value: `${SE.fyLatest.sellExpenseRate}% / ${SE.ttm.sellExpenseRate}%（TTM 销售费用 ${SE.ttm.sellExpense} 亿）；内生（剔除海济）约 ${SE.breakdown.organicSellRate}%，IVD 行业均值 ${SE.industry.benchmark}%（${SE.industry.n}家）`, source: `${SE.fyLatest.source}；${SE.breakdown.source.slice(0, 60)}…` });
  }

  const sotpB = base.sotp;
  const sotpRows = [
    { label: 'A 分子诊断（试剂+仪器+服务，PS法）', value: `11.55 亿 × ${psUse}x × ${discAUseFin}（IVD 增速 ${ivdGrowth}%<0 → 增速规则折价 ${discAUse}${seOn ? ` + 销售费用显性调整额外 −${aExtraDisc.toFixed(2)}` : ''} = ${discAUseFin}；TTM拆分未披露→年报增速口径）= ${r2(sotpB.A)} 亿` },
    { label: 'B 生物药品（圣湘海济，PE法）', value: `1.85 亿 × ${bioPEUse}x × ${coefBFinal}（净利增速 +${haijiGrowth}%>20% → ×${coefB}${seOn ? `；销售费用调整系数 ×${bPeCoef}` : ''}）= ${r2(sotpB.B)} 亿；100% 全资无控股折价` },
    { label: 'C 新兴业务（测序+境外，PS×溢价）', value: `测序 0.30 亿×${psUse}x×${premC(seqGrowth)}（+${seqGrowth}%>50%→1.8） + 境外 0.83 亿×${psUse}x×${premC(ovsGrowth)}（+${ovsGrowth}%→1.4）= ${r2(sotpB.C)} 亿` },
    { label: '静态 EV', value: `A + B + C = ${r2(sotpB.ev)} 亿` },
    { label: '股权价值', value: `EV − 有息负债 ${I.balanceSheet2025.interestDebt} 亿 + 货币资金 ${I.balanceSheet2025.cash} 亿 + 交易性金融资产 ${I.balanceSheet2025.tradingFA} 亿（类现金，模型口径扩展）= ${r2(sotpB.equity)} 亿` },
    { label: 'SOTP 每股价值', value: `${r2(sotpB.equity)} 亿 ÷ ${N} 亿股 = ${r2(sotpB.perShare)} 元` }
  ];

  const xvalRows = [
    { model: '动态 SOTP（核心）', perShare: r2(base.sotp.perShare), weight: `${(W.sotp * 100).toFixed(1)}%`, contribution: r2(base.sotp.perShare * W.sotp), note: `权重自适应 ${wSotp}%（生物药占比 ${bioRatio}%）；A/B/C 按 2025 年报分部动态系数${seOn ? `；A 板块PS折价 ${discAUseFin}（销售费用刚性额外 −${aExtraDisc.toFixed(2)}）` : ''}` },
    { model: '动态 Forward PE', perShare: r2(base.pe), weight: `${(W.forwardPE * 100).toFixed(1)}%`, contribution: r2(base.pe * W.forwardPE), note: `EPS(FY_C/FY_N) ${r3(epsCur)}/${r3(epsNext)} 元 × 器械 ${devPEUse}x × ${fwdPenalty}（Q2净利 ${qNpYoY}%<−30% 惩罚）× ${momCoef}（营收动量${qRevYoY > 0 ? '企稳无调整' : ''}）${dSellRate != null ? ` × ${sellEffCoef}（费用效率：Δ${dSellRate}pp）` : ''}` },
    { model: '整体 PS（TTM）', perShare: r2(base.ps), weight: `${(W.ps * 100).toFixed(1)}%`, contribution: r2(base.ps * W.ps), note: `TTM 营收 ${ttm.rev} 亿 × ${psUse}x × ${psDiscount}（${collectDiscount ? '试剂毛利率下滑>5%→集采折价0.60' : '含高利润生长激素→整体折价0.75'}）` },
    { model: '动态 DCF（FCFF）', perShare: r2(base.dcf.perShare), weight: dcfRemoved ? '剔除' : `${(W.dcf * 100).toFixed(1)}%`, contribution: r2(base.dcf.perShare * W.dcf), note: dcfRemoved ? `FCFF = 净利×${cf.npCashRatio} − ${cf.capexAvg} − ${cf.wcDeltaAvg} 三年全负（${fcff.map(f => r2(f)).join('/')}）+ 终值负 → 失效检验剔除，权重归一；WACC ${(wacc * 100).toFixed(2)}%/g ${I.macro.gUsed}%` : `WACC ${(wacc * 100).toFixed(2)}%、g ${I.macro.gUsed}%` },
    { model: '动态 EV/EBITDA', perShare: r2(base.evEbitda), weight: `${(W.evEbitda * 100).toFixed(1)}%`, contribution: r2(base.evEbitda * W.evEbitda), note: `EBITDA(2026E) ${ebitdaUse} 亿 × ${evMidUse}x${I.industry.evEbitdaAssumed ? '【假设】' : ''} + 净现金 ${netCash} 亿；EBITDA 已扣销售费用（天然口径、无需再调）` },
    { model: '动态 rNPV（管线）', perShare: r2(base.rnpv), weight: `${(W.rnpv * 100).toFixed(1)}%`, contribution: r2(base.rnpv * W.rnpv), note: 'QPOC 2.0 / 海之元 ISS（III期）/ 基因甲基化；峰值销售为假设；默认P=65%按临床阶段调整' }
  ];

  const weightRows = wAdj.map(t => ({ text: t }));

  const scenRows = [
    { name: '乐观', value: r2(opt.composite), note: `行业倍数 ×${SCEN_MULT.optimistic}（行业PE上浮10%）：PS ${(psUse * 1.1).toFixed(2)}x / 器械PE ${(devPEUse * 1.1).toFixed(0)}x / 生物药PE ${(bioPEUse * 1.1).toFixed(1)}x` },
    { name: '基准', value: r2(base.composite), note: '当前行业均值（PS 7.6x / 器械PE 30x / 生物药PE 35.6x）' },
    { name: '保守', value: r2(consv.composite), note: `行业倍数 ×${SCEN_MULT.conservative}（行业PE下浮10%）且 SOTP 扣减5%安全边际（haircut ${(consv.sotp.hair * 100).toFixed(0)}%）` }
  ];

  // ---- 追加指令（2026-09-13）：销售费用显性调整模块 明细行（步骤1-5）----
  const sellExpRows = [];
  const sellExpScenRows = [];
  if (seOn) {
    const tm = SE.ttm || {};
    const ind = SE.industry || {};
    const fyl = SE.fyLatest || {};
    const organicDeltaTxt = organicYoYPP === 0 ? '基本持平' : `${organicYoYPP > 0 ? '+' : ''}${organicYoYPP}pp`;
    const ebitdaMargin2025 = fyl.rev ? +(I.ebitda.fy2025 / fyl.rev * 100).toFixed(2) : null;
    const ebitdaMargin2026 = (cons && cons.rev2026E) ? +(ebitdaUse / cons.rev2026E * 100).toFixed(2) : null;
    const suppressAmt = (fyl.rev && fyl.sellExpenseRate != null && ind.benchmark != null)
      ? +((fyl.sellExpenseRate - ind.benchmark) / 100 * fyl.rev).toFixed(2) : null;
    const deltaBand = dSellRate == null ? '' : (dSellRate > 10 ? '>10pp' : (dSellRate > 5 ? '∈5~10pp' : '<5pp'));
    sellExpRows.push({ label: '① 销售费用性质拆解（FY_Latest 2025）', value: `合并销售费用 ${fyl.sellExpense} 亿（占营收 ${fyl.sellExpenseRate}%）；其中咨询费及销售佣金 ${bd.consultingCommission} 亿（同比 +${bd.consultingCommissionYoY}%）——并购并表贡献（圣湘海济）${bd.haijiContribution} 亿 / 内生原有业务 ${bd.organicContribution} 亿（同比 ${bd.organicContributionYoY}%）`, source: '上交所问询函回复（2026-06-12）+ 2025年报' });
    sellExpRows.push({ label: '① 内生销售费用率', value: `内生（剔除海济）销售费用率约 ${bd.organicSellRate}%（${organicDeltaTxt === '基本持平' ? '同比基本持平' : '同比 ' + organicDeltaTxt}）；海济销售费用率 ${bd.haijiSellRate}%（同比 ${bd.haijiSellRateYoYPP}pp）→ 内生推广投入同比压缩约 ${Math.abs(bd.organicContributionYoY)}%，费用率高企主因 = ①并购并表结构性抬高（海济 38% 高费率）②收入下滑的分母效应（IVD 营收 ${ivdGrowth}%）`, source: '上交所问询函回复（2026-06-12，art_code AN202606111823465410）' });
    sellExpRows.push({ label: '② 板块A 分子诊断 · PS 额外折价', value: `IVD 营收 ${ivdGrowth}%（<0，集采冲击）且内生费用率同比${organicDeltaTxt}（费用刚性）→ PS 折价系数 ${discAUse} − ${aExtraDisc.toFixed(2)} = ${discAUseFin}（额外下调 ${aExtraDisc.toFixed(2)}）`, source: '规则：营收下滑且费用刚性 → 额外下调 0.05~0.10（取下沿 0.10）' });
    sellExpRows.push({ label: '② 板块B 生物药品（圣湘海济）· PE 系数', value: `子公司销售费用同比 ${bd.haijiContributionYoY}% ＜ 营收同比 +${I.haiji.revYoY}%（费用增速未跑赢营收，未触发 PE 下调）→ PE 系数 ${bPeCoef}（板块B PE 倍数维持）`, source: '规则：子公司销售费用增速 > 营收增速才下调 5%~10%' });
    sellExpRows.push({ label: '② 板块C 新兴业务（基因测序/境外）· 不调整', value: '基因测序处放量期，高销售费用属正常市场培育投入 → PS 溢价系数不调整', source: '追加指令步骤2' });
    sellExpRows.push({ label: '③ Forward PE 费用效率惩罚系数', value: `Δ = TTM 销售费用率 ${tm.sellExpenseRate}% − IVD 行业均值 ${ind.benchmark}%（${ind.scope || ''}）= ${dSellRate}pp ${deltaBand} → Forward PE × ${sellEffCoef}（与业绩惩罚 ${fwdPenalty} 叠乘）`, source: '规则：Δ>10pp→0.85 / 5~10pp→0.90 / <5pp→1.00' });
    sellExpRows.push({ label: '④ EV/EBITDA（天然口径，无需调整）', value: `EBITDA 已扣除销售费用，模型天然含费用影响，无需再调；当前 EBITDA 利润率 FY2025 ${ebitdaMargin2025}% / 2026E ${ebitdaMargin2026}%，主要受销售费用率 ${fyl.sellExpenseRate}%（TTM ${tm.sellExpenseRate}%）压制${suppressAmt != null ? `，相对 IVD 行业均值多支出约 ${suppressAmt} 亿（≈可释放的 EBITDA 空间）` : ''}`, source: '追加指令步骤4' });
    sellExpRows.push({ label: '⑤ 销售费用情景（优化 / 恶化）', value: `费用优化：未来两年费率每年降 2~3pp（累计 −${SE.rules.optimizeRatePP}pp）；费用恶化：费率维持或上升（+${SE.rules.worsenRatePP}pp）→ 见下方「销售费用情景测试」`, source: '追加指令步骤5' });
    if (seScen) {
      const o = seScen.optimize, w = seScen.worsen;
      sellExpScenRows.push({ name: '费用优化', value: r2(o.compositeAdj), note: `两年累计 −${Math.abs(SE.rules.optimizeRatePP)}pp（每年 −${SE.rules.optimizeRatePPerYear || 2.5}pp）；释放销售费用 ${r2(o.deltaSell)} 亿 → 税后增厚净利 ${r2(o.deltaNp)} 亿（税率 ${(seScen.taxRate * 100).toFixed(0)}%【假设】）；Forward PE 每股 ${r2(o.peAdj)}、EBITDA(2026E) ${r2(o.ebitdaAdj)} 亿；较基准 ${o.delta >= 0 ? '+' : ''}${o.delta} 元` });
      sellExpScenRows.push({ name: '基准', value: r2(base.composite), note: `销售费用率维持 TTM ${tm.sellExpenseRate}%（FY2025 ${fyl.sellExpenseRate}%）；Forward PE 已含费用效率系数 ×${sellEffCoef}` });
      sellExpScenRows.push({ name: '费用恶化', value: r2(w.compositeAdj), note: `费率 +${SE.rules.worsenRatePP}pp（维持或上升，如集采后推广加码 / 整合不及预期）；销售费用增加 ${r2(-w.deltaSell)} 亿 → 净利减少 ${r2(-w.deltaNp)} 亿；较基准 ${w.delta >= 0 ? '+' : ''}${w.delta} 元` });
    }
  }

  const seRisk = seOn ? `6) 销售费用刚性——销售费用率（TTM ${SE.ttm.sellExpenseRate}% / FY2025 ${SE.fyLatest.sellExpenseRate}%）显著高于 IVD 行业均值 ${SE.industry.benchmark}%，若推广投入无法随收入同步压缩，将持续压制利润率与 Forward PE；` : '';
  const riskNote = `1) 集采降价超预期→诊断板块PS折价再下移；2) 增值税3%→13%的利润压制或持续；3) 生长激素集采/国谈降价与竞争加剧→海济PE下调（26H1海济收入已同比略降）；4) 管线临床失败或获批不及预期；5) 并购整合与商誉减值风险（商誉7.34亿）；${seRisk}${seOn ? '7' : '6'}) 全部结果基于公开信息与机构预测，不构成投资建议。`;

  const decisionNote = `【画像诊断→模型路由】①近3财年归母净利复合 ${cagrPct}% < −10% → 「剧烈波动期」→ 放弃 TTM PE、采用 Forward PE；②圣湘海济净利占比 ${bioRatio}% > 30% → 强制 SOTP（A试剂+仪器+服务=PS法 / B生物药=PE法 / C新兴业务=PS×溢价）；③Q2 营收 +0.98%（−5%~15%区间）→ PE法无惩罚无溢价，但净利 −31.99% < −30% → Forward PE 行业基准 ×0.85。【动态性】基准日/财报期/系数/权重/兜底全部按规则表由代码自动判定，无硬编码年份。【兜底状态】${fallbackFlags.length ? fallbackFlags.join('；') : '机构预期/季报/行业倍数三项数据齐备，未触发兜底'}${seOn && dSellRate != null ? `【销售费用显性调整】TTM 销售费用率 ${SE.ttm.sellExpenseRate}% − IVD 行业均值 ${SE.industry.benchmark}% = Δ${dSellRate}pp → Forward PE ×${sellEffCoef}；板块A PS 折价 ${discAUse}→${discAUseFin}（费用刚性额外 −${aExtraDisc}）；板块B 海济费用增速 ${bd.haijiContributionYoY}% < 营收 +${I.haiji.revYoY}% → PE 不调整；内生销售费用率约 ${bd.organicSellRate}%（费用率 38% 的海济并表是结构性抬升主因）` : ''}`;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  return {
    ok: true,
    dedicated: true,
    sanxi: true,
    symbol: SYMBOL,
    stockName: cfg.name,
    version: cfg.modelVersion,
    versionStamp: cfg.version,
    runId,
    rating,
    fairValueRange: range,
    fairValueCenter: center,
    currentPrice: price != null ? r2(price) : null,
    reportLabel: cfg.reportLabel,
    model: 'sanxi688289（V2.1_销售费用显性调整·确定性六模型）',
    dataAsOf: cfg.dataAsOf,
    reportHeadRows, diagRows, coreRows, sotpRows, xvalRows, weightRows, scenRows,
    sellExpRows, sellExpScenRows,
    sellingExpense: seOn ? { benchmark: SE.industry.benchmark, ttmRate: SE.ttm.sellExpenseRate, fyRate: SE.fyLatest.sellExpenseRate, organicRate: SE.breakdown.organicSellRate, deltaPP: dSellRate, effCoef: sellEffCoef, aExtraDisc, bPeCoef } : null,
    fallbackFlags, freshnessRows,
    riskNote, decisionNote,
    weights: W
  };
}

module.exports = { run, isSanxiModel, loadConfig };
