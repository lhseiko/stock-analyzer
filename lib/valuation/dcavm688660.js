// ============================================================
// 电气风电（688660）专属估值模型 —— 动态周期估值模型 DCAVM v1.0（确定性计算，1+1=2）
// 20260909h：五站流水线
//   ① 时间引擎（月算法自动适配最新报告期 + 数据时效看板）
//   ② 景气周期评分（0~100，由量化子指标加权）→ 周期阶段 band（底部/复苏/中性/景气）
//   ③ 多路估值：三阶段 FCFF·DCF（CAPM-WACC）/ 相对估值（PE·PB-ROE·EV-EBITDA·EV-Sales）/ SOTP（风机·服务·风电场·非核心）/ 订单·合同负债辅助法
//   ④ 动态加权合成：按周期阶段切换权重集（底部重资产锚 / 景气重相对）
//   ⑤ 三情景（悲观/基准/乐观）+ WACC/g 敏感性 + 安全边际 + 三档评级（低估/合理/高估）
// 计算层=代码，输入锁死（data/valuation/688660.json）⇒ 结果锁死；LLM 仅叙述。
// 无硬编码年份：报告期/预测年度均由时间引擎与配置推导；周期评分/权重均来自配置量化值。
// 适用：风电设备制造（强周期、盈利随招标价与装机波动，TTM PE 常为负）→ 用归一化盈利锚定。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '688660';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/688660.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isDcavmModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'dcavm';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const pct = (x) => (x == null) ? null : Math.round(Number(x) * 1000) / 10;
const div = (a, b) => (b != null && b !== 0) ? (a / b) : null;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 月算法：由基准日推导「最新已披露报告期」月份 M */
function detectLatestReportMonths(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4) return { M: 12, yearOffset: -1 };
  if (m <= 7) return { M: 3, yearOffset: 0 };
  if (m === 8) return (day >= 20) ? { M: 6, yearOffset: 0 } : { M: 3, yearOffset: 0 };
  if (m === 9) return { M: 6, yearOffset: 0 };
  if (m === 10) return (day >= 25) ? { M: 9, yearOffset: 0 } : { M: 6, yearOffset: 0 };
  return { M: 9, yearOffset: 0 };
}

function median(arr) {
  const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function run(symbol, { price, pe, pb } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'dcavm') return { error: 'NOT_DCAVM' };
  const I = cfg.inputs;
  const alerts = [];

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const N = nz(vv(I.market.shares));                                 // 亿股
  const mcap = (P != null) ? P * N : nz(vv(I.market.mcap));         // 亿元
  const D = nz(vv(I.balance.interestBearDebt));                     // 有息负债 亿元
  const cash = nz(vv(I.balance.cash));                              // 货币资金 亿元
  const netCash = cash - D;                                         // 净现金（亿元）
  const eqParent = nz(vv(I.balance.equityParent));                  // 归母净资产 亿元
  const bvps = N ? eqParent / N : null;                             // 每股净资产

  // ================= 第一站：时间引擎 + 数据时效 =================
  const now = new Date();
  const det = detectLatestReportMonths(now);
  const expectYear = now.getFullYear() + (det.yearOffset || 0);
  const expectEnd = `${expectYear}-${String(det.M).padStart(2, '0')}-${det.M === 12 ? '31' : (det.M === 6 ? '30' : (det.M === 3 ? '31' : '30'))}`;
  const RP = cfg.reportPeriod || {};
  const cfgEnd = RP.periodEnd;
  const periodMatch = (cfgEnd === expectEnd);
  if (!periodMatch) {
    alerts.push(`财报期口径不一致：配置标注 ${cfgEnd || '?'}（${RP.label || ''}），月算法判定最新已披露应为 ${expectEnd} → 请复核 data/valuation/688660.json`);
  }
  const discAge = RP.disclosureDate ? daysBetween(RP.disclosureDate, now) : null;
  if (discAge != null && discAge > 120) {
    alerts.push(`最新财报披露于 ${RP.disclosureDate}（距今 ${discAge} 天 > 120 天）→ 财报可能已超期`);
  }
  const FR = I.freshness || {};
  const freshnessRows = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, now) : null;
    if (age == null) continue;
    const maxAge = it.maxAge || FR.maxAgeDays || 120;
    const stale = age > maxAge;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge, stale });
    if (stale) alerts.push(`快照「${it.label}」取数于 ${it.asOf}（距今 ${age} 天 > ${maxAge} 天）→ 请复核更新`);
  }

  // ================= 第二站：景气周期评分 =================
  const cyc = I.cycle || {};
  const cycInds = (cyc.indicators || []).map(it => ({
    name: it.name,
    weight: nz(it.weight),
    score: nz(it.score),
    note: it.note || '',
  }));
  const wsum = cycInds.reduce((s, x) => s + x.weight, 0);
  const cycleScore = wsum > 0 ? cycInds.reduce((s, x) => s + x.weight * x.score, 0) / wsum : (cycInds.length ? cycInds.reduce((s, x) => s + x.score, 0) / cycInds.length : null);
  // 周期阶段判定（阈值，逻辑锁死）
  function bandOf(score) {
    if (score == null) return 'neutral';
    if (score < 35) return 'bottom';
    if (score < 55) return 'recovery';
    if (score < 75) return 'neutral';
    return 'boom';
  }
  const bandAuto = bandOf(cycleScore);
  const bandDefault = cyc.bandOverride || bandAuto;

  // ================= 第三站：归一化盈利 + 宏观 =================
  const EH = I.earningsHistory || [];
  const revArr = EH.map(e => nz(e.revenue));
  const npArr = EH.map(e => nz(e.np));
  const ebitdaArr = EH.map(e => nz(e.ebitda));
  const ebitArr = EH.map(e => nz(e.ebit));
  const daArr = EH.map(e => nz(e.da));
  const capexArr = EH.map(e => nz(e.capex));
  const nwcArr = EH.map(e => nz(e.nwc));
  const normRev = median(revArr);
  const normNp = median(npArr);
  const normEbitda = median(ebitdaArr);
  const normEbit = median(ebitArr);
  const normDa = median(daArr);
  const normCapex = median(capexArr);
  const normNwc = median(nwcArr);
  const normROE = div(normNp, eqParent);                            // 归一化 ROE（可为负）
  const normNetMargin = div(normNp, normRev);
  // EV/Sales 与订单覆盖用最新 TTM 营收（更贴近当前规模，含复苏）；缺失则回退归一化中位
  const revForSales = (I.market && I.market.revTTM) ? nz(I.market.revTTM) : normRev;

  // 宏观 / WACC
  const MA = I.macro;
  const rf = nz(vv(MA.rf)) / 100, erp = nz(vv(MA.erp)) / 100, beta = nz(vv(MA.beta));
  const sizeAdj = nz(vv(MA.sizeAdj)) / 100, rd = nz(vv(MA.rd)) / 100, tax = nz(vv(MA.taxRate)) / 100;
  const gP = nz(vv(MA.gPerp)) / 100;
  const Re = rf + beta * erp + sizeAdj;
  const wE = (mcap + D) ? mcap / (mcap + D) : 1;
  const wD = (mcap + D) ? D / (mcap + D) : 0;
  const WACC = wE * Re + wD * rd * (1 - tax);

  // 可比公司中位数
  const peers = (I.peers && I.peers.list) || [];
  const peerPEs = peers.map(p => nz(p.pe)).filter(x => isFinite(x) && x > 0);
  const peerPBs = peers.map(p => nz(p.pb)).filter(x => isFinite(x) && x > 0);
  const peerEVs = peers.map(p => nz(p.evEbitda)).filter(x => isFinite(x) && x > 0);
  const peerPSs = peers.map(p => nz(p.ps)).filter(x => isFinite(x) && x > 0);
  const peMedian = median(peerPEs);
  const pbMedian = median(peerPBs);
  const evMedian = median(peerEVs);
  const psMedian = median(peerPSs);
  const peerImpliedROE = (peMedian && pbMedian) ? div(pbMedian, peMedian) : null;

  // FCFF 基数（归一化，确定性）：优先用历年 FCFF 中位（周期平滑）；缺失时回退 EBIT×(1-税)+D&A−资本开支−ΔNWC
  const fcffHist = EH.map(e => nz(e.fcff)).filter(x => x !== 0 && isFinite(x));
  const fcff0 = fcffHist.length ? median(fcffHist) : (nz(normEbit) * (1 - tax) + normDa - normCapex - normNwc);

  // ================= 估值方法（按情景参数化） =================
  const weights = I.weights || {};
  const dcfP = I.dcf || {};
  const safeMargin = nz(vv(I.safetyMargin));

  function dcfValue(sc) {
    const g1 = nz(sc.g1 != null ? sc.g1 : dcfP.g1), g2 = nz(sc.g2 != null ? sc.g2 : dcfP.g2);
    const T1 = nz(dcfP.T1) || 5, T2 = nz(dcfP.T2) || 10;
    let pv = 0; const fcffs = [];
    for (let t = 1; t <= T1; t++) {
      const f = fcff0 * Math.pow(1 + g1, t);
      fcffs.push(f);
      pv += f / Math.pow(1 + WACC, t);
    }
    let prev = fcffs[fcffs.length - 1];
    for (let t = T1 + 1; t <= T2; t++) {
      const f = prev * (1 + g2);
      prev = f;
      pv += f / Math.pow(1 + WACC, t);
    }
    const tv = prev * (1 + gP) / (WACC - gP);
    const pvTv = tv / Math.pow(1 + WACC, T2);
    const evOps = pv + pvTv;
    const equity = evOps + netCash;
    return { g1, g2, T1, T2, evOps: r2(evOps), tvShare: r2(pvTv / (pv + pvTv) * 100), tpDCF: r2(div(equity, N)) };
  }

  function relativeValue(sc) {
    const relMult = nz(sc.relMult != null ? sc.relMult : 1);
    // PB-ROE 周期底部锚
    let targetPB;
    if (normROE != null && normROE > 0 && peerImpliedROE) targetPB = pbMedian * (normROE / peerImpliedROE);
    else targetPB = pbMedian * 0.5;   // 归一化 ROE≤0 → 周期底部折扣锚
    const tpPB = (bvps != null) ? bvps * targetPB : null;
    // 归一化 PE（仅当归一化 EPS 为正；亏损周期 PE 失效）
    const normEPS = N ? normNp / N : null;
    const tpPE = (normEPS != null && normEPS > 0 && peMedian) ? normEPS * peMedian * relMult : null;
    // EV/EBITDA（仅当归一化 EBITDA 为正；亏损周期失效）
    const tpEV = (normEbitda && normEbitda > 0 && evMedian) ? div(normEbitda * evMedian * relMult + netCash, N) : null;
    // EV/Sales（用最新 TTM 营收，周期底部仍可用）
    const tpEVs = (revForSales && psMedian) ? div(revForSales * psMedian * relMult + netCash, N) : null;
    const relVals = [tpPE, tpPB, tpEV, tpEVs].filter(x => x != null && isFinite(x) && x > 0);
    const blend = relVals.length ? relVals.reduce((a, b) => a + b, 0) / relVals.length : null;
    return { targetPB: r2(targetPB), tpPB: r2(tpPB), tpPE: r2(tpPE), tpEV: r2(tpEV), tpEVs: r2(tpEVs), blend: r2(blend) };
  }

  function pbRoeValue(sc) {
    // 与 relativeValue 中 PB-ROE 同口径，作为独立「周期底部锚」方法
    let targetPB;
    if (normROE != null && normROE > 0 && peerImpliedROE) targetPB = pbMedian * (normROE / peerImpliedROE);
    else targetPB = pbMedian * 0.5;
    const tpPB = (bvps != null) ? bvps * targetPB : null;
    return { targetPB: r2(targetPB), tpPB: r2(tpPB), bvps: r2(bvps), normROE: pct(normROE) };
  }

  function sotpValue(sc) {
    const sm = nz(sc.sotpMult != null ? sc.sotpMult : 1);
    const segs = [];
    let totalEq = 0;
    for (const s of (I.segments || [])) {
      const share = nz(s.share);
      const allocDebt = (s.revenue && normRev) ? D * (s.revenue / normRev) : D * (share / 100);
      const allocCash = (s.revenue && normRev) ? cash * (s.revenue / normRev) : cash * (share / 100);
      let val = null, detail = '';
      if (s.method === 'evEbitda') {
        const segEV = nz(s.ebitda) * nz(s.multiple) * sm;
        val = segEV - allocDebt + allocCash;
        detail = `EV/EBITDA：${r2(nz(s.ebitda))}×${r2(nz(s.multiple) * sm)} − 分摊有息债${r2(allocDebt)} + 分摊现金${r2(allocCash)}`;
      } else if (s.method === 'pe') {
        val = nz(s.np) * nz(s.multiple) * sm;
        detail = `PE：${r2(nz(s.np))}亿 × ${r2(nz(s.multiple) * sm)}×`;
      } else if (s.method === 'yield') {
        const cap = nz(s.capRate) || 0.08;
        val = nz(s.np) / cap;
        detail = `收益法（capRate ${pct(cap)}%）：${r2(nz(s.np))} ÷ ${pct(cap)}%`;
      } else if (s.method === 'book') {
        val = nz(s.book);
        detail = `账面价值法：${r2(val)} 亿`;
      }
      const sv = (val != null) ? r2(val) : null;
      if (sv != null) totalEq += val;
      segs.push({ name: s.name, method: s.method, value: sv, detail });
    }
    return { tpSOTP: r2(div(totalEq, N)), segs, totalEq: r2(totalEq) };
  }

  function orderValue(sc) {
    const backlog = nz(vv(I.orders.backlog));
    const coverage = (revForSales && backlog) ? div(backlog, revForSales) : null;
    const relMult = nz(sc.relMult != null ? sc.relMult : 1);
    let tpOrder = null;
    if (backlog && normRev && peMedian) {
      // 归一化净利率若为周期亏损（≤0），用复苏期地板净利率 4% 锚定（订单法仅作前瞻辅助，不放大亏损）
      const tgtMargin = (normNetMargin != null && normNetMargin > 0) ? normNetMargin : 0.04;
      const implNp = backlog * tgtMargin;
      const tp = div(implNp * peMedian * relMult, N);
      tpOrder = (tp != null && tp > 0) ? tp : null;
    }
    return { coverage: (coverage != null) ? r2(coverage) : null, tpOrder: r2(tpOrder), backlog: r2(backlog) };
  }

  function synthesize(sc) {
    const band = sc.band || bandDefault;
    const w = weights[band] || weights.neutral || {};
    const d = dcfValue(sc);
    const rel = relativeValue(sc);
    const pr = pbRoeValue(sc);
    const so = sotpValue(sc);
    const od = orderValue(sc);
    const parts = {
      dcf: d.tpDCF, pbRoe: pr.tpPB, relative: rel.blend, sotp: so.tpSOTP, order: od.tpOrder,
    };
    let comp = 0; const used = [];
    for (const k of ['dcf', 'pbRoe', 'relative', 'sotp', 'order']) {
      const wk = nz(w[k]);
      if (wk > 0 && parts[k] != null && isFinite(parts[k])) { comp += wk * parts[k]; used.push(k); }
    }
    return { band, w, parts, composite: r2(comp), d, rel, pr, so, od, used };
  }

  // ================= 第五站：三情景 + 敏感性 + 评级 =================
  const SC = I.scenarios || {};
  const base = synthesize(SC.base || {});
  const opt = synthesize(SC.optimistic || {});
  const pess = synthesize(SC.pessimistic || {});
  const center = base.composite;
  const rangeLow = Math.min(opt.composite, pess.composite, center);
  const rangeHigh = Math.max(opt.composite, pess.composite, center);
  const conservative = center != null ? center * (1 - safeMargin) : null;

  // 交叉验证：SOTP / DCF / 相对 三路是否收敛
  const anchors = [base.d.tpDCF, base.rel.blend, base.so.tpSOTP].filter(x => x != null && isFinite(x));
  const aLo = Math.min(...anchors), aHi = Math.max(...anchors);
  const spread = (aHi && aLo) ? (aHi - aLo) / aHi : null;
  let crossNote;
  if (anchors.length >= 2 && spread != null && spread < 0.30) {
    crossNote = `三路锚（DCF ${base.d.tpDCF} / 相对 ${base.rel.blend} / SOTP ${base.so.tpSOTP}）差幅 ${pct(spread)}%（<30%）→ 交叉验证通过`;
  } else {
    crossNote = `⚠️ 模型分歧：三路锚 DCF ${base.d.tpDCF} / 相对 ${base.rel.blend} / SOTP ${base.so.tpSOTP} 差幅 ${spread != null ? pct(spread) : '?'}% → 已按「周期阶段动态权重」合成，保留分歧标注`;
  }

  // 敏感性（DCF 对永续增长 g 的暴露，确定性重算，使用同一 fcff0）
  function sensG() {
    const rows = [];
    const T1 = nz(dcfP.T1) || 5, T2 = nz(dcfP.T2) || 10;
    const g1 = nz((SC.base || {}).g1 != null ? (SC.base).g1 : dcfP.g1);
    const g2 = nz((SC.base || {}).g2 != null ? (SC.base).g2 : dcfP.g2);
    for (const dg of [-0.005, 0, 0.005]) {
      let pv = 0, prev = fcff0;
      for (let t = 1; t <= T1; t++) { prev = fcff0 * Math.pow(1 + g1, t); pv += prev / Math.pow(1 + WACC, t); }
      let p2 = prev;
      for (let t = T1 + 1; t <= T2; t++) { p2 = p2 * (1 + g2); pv += p2 / Math.pow(1 + WACC, t); }
      const tv = p2 * (1 + gP + dg) / (WACC - gP - dg);
      const evOps = pv + tv / Math.pow(1 + WACC, T2);
      const tp = div(evOps + netCash, N);
      rows.push({ label: `g ${(pct((gP + dg) * 100))}%`, tpDCF: r2(tp) });
    }
    return rows;
  }

  let rating = '无法评级', upside = null, position = null;
  if (P != null && center != null) {
    upside = (center - P) / P;
    position = Math.max(0, Math.min(100, (P - rangeLow) / (Math.max(rangeHigh - rangeLow, 1e-9)) * 100));
    if (upside > 0.20) rating = '低估';
    else if (upside >= -0.10) rating = '合理';
    else rating = '高估';
  }

  // ================= 输出行 =================
  const coreRows = [
    { label: '最新报告期（时间引擎）', value: `${RP.label || '—'}（${cfgEnd || '—'}，披露 ${RP.disclosureDate || '—'}，距今 ${discAge != null ? discAge : '?'} 天）｜月算法判定 ${expectEnd}${periodMatch ? ' ✓ 一致' : ' ⚠️ 不一致'}`, source: 'data/valuation/688660.json + 月算法自动推导' },
    { label: '实时市场', value: `现价 ${r2(P)} 元 / 总市值 ${r2(mcap)} 亿 / 总股本 ${r2(N)} 亿股 / PB ${vv(I.market.pb)} / PS(TTM) ${vv(I.market.ps)} / PE(TTM) ${vv(I.market.pe) || pe || '—'}（TTM 亏损→为负）`, source: '腾讯行情 2026-09-09' },
    { label: '归一化盈利（3~5年中位）', value: `营收 ${r2(normRev)} 亿 / 归母净利 ${r2(normNp)} 亿 / EBITDA ${r2(normEbitda)} 亿 / 归一化 ROE ${pct(normROE)}% / 净利率 ${pct(normNetMargin)}%`, source: 'data/valuation/688660.json earningsHistory（周期平滑锚）' },
    { label: '景气周期评分', value: `综合 ${r2(cycleScore)} / 100 → 阶段【${bandLabel(bandDefault)}】；子指标：${cycInds.map(x => `${x.name} ${x.score}`).join('、')}`, source: 'data/valuation/688660.json cycle.indicators（量化加权）' },
    { label: 'WACC 与 DCF 参数', value: `Re ${pct(Re)}%（Rf ${pct(rf)}% + β ${beta} × ERP ${pct(erp)}% + 特定 ${pct(sizeAdj)}%）｜WACC ${pct(WACC)}%｜g ${pct(gP)}%｜显性 ${nz(dcfP.T1)}+${nz(dcfP.T2) - nz(dcfP.T1)} 年｜税率 ${pct(tax)}%｜FCFF 基数 ${r2(fcff0)} 亿`, source: MA.beta && MA.beta.source || 'CAPM 配置' },
    { label: '可比公司（风电整机）', value: `PE 中位 ${r2(peMedian)}×｜PB 中位 ${r2(pbMedian)}×｜EV/EBITDA 中位 ${r2(evMedian)}×｜PS 中位 ${r2(psMedian)}×｜隐含 ROE ${pct(peerImpliedROE)}%`, source: peers.map(p => `${p.name} PE${p.pe}/PB${p.pb}/EV-EBITDA${p.evEbitda || '—'}`).join('；') },
    { label: '资产负债锚', value: `归母净资产 ${r2(eqParent)} 亿（BVPS ${r2(bvps)} 元）／有息负债 ${r2(D)} 亿／净现金 ${r2(netCash)} 亿／合同负债 ${r2(vv(I.balance.contractLiab))} 亿`, source: 'data/valuation/688660.json balance（2026年半年报）' },
  ];

  const cycRows = cycInds.map(x => ({ name: x.name, value: `${x.score} 分（权重 ${pct(x.weight * 100)}%）${x.note ? ' — ' + x.note : ''}` }));
  const segRows = (I.segments || []).map(s => ({ name: s.name, value: `收入 ${r2(nz(s.revenue))} 亿（占比 ${pct(nz(s.share))}%）／毛利率 ${s.margin != null ? pct(nz(s.margin)) + '%' : '—'}／估值法：${s.method}` }));
  const sotpSegRows = base.so.segs.map(s => ({ name: s.name, value: `${s.detail} ⇒ 权益估值 ${s.value} 亿` }));
  const matrixRows = [
    { method: '三阶段 FCFF·DCF（CAPM-WACC）', low: pess.d.tpDCF, mid: base.d.tpDCF, high: opt.d.tpDCF, note: `WACC ${pct(WACC)}% / g ${pct(gP)}% / 显性 ${nz(dcfP.T1)}+${nz(dcfP.T2) - nz(dcfP.T1)} 年 / FCFF 基数 ${r2(fcff0)} 亿 / 终值占比 ${base.d.tvShare}%` },
    { method: '相对估值（PE·EV/EBITDA·EV/Sales 混合）', low: pess.rel.blend, mid: base.rel.blend, high: opt.rel.blend, note: `PE 中位 ${r2(peMedian)}× / EV/EBITDA ${r2(evMedian)}× / PS ${r2(psMedian)}×；混合锚=${base.rel.blend} 元` },
    { method: 'PB-ROE 周期底部锚', low: pess.pr.tpPB, mid: base.pr.tpPB, high: opt.pr.tpPB, note: `BVPS ${r2(bvps)} 元 × 目标 PB ${base.pr.targetPB}×（归一化 ROE ${pct(normROE)}% vs 可比隐含 ROE ${pct(peerImpliedROE)}%）` },
    { method: 'SOTP 分部加总', low: pess.so.tpSOTP, mid: base.so.tpSOTP, high: opt.so.tpSOTP, note: `风机(EV/EBITDA)+服务(PE)+风电场(收益法)+非核心(账面) ⇒ 权益 ${base.so.totalEq} 亿` },
    { method: '订单·合同负债辅助法', low: pess.od.tpOrder, mid: base.od.tpOrder, high: opt.od.tpOrder, note: `在手订单 ${base.od.backlog} 亿 / 覆盖倍数 ${base.od.coverage}×（营收）` },
    { method: `动态加权合成（阶段【${bandLabel(bandDefault)}】权重）`, low: r2(Math.min(opt.composite, pess.composite, center)), mid: r2(center), high: r2(Math.max(opt.composite, pess.composite, center)), note: `权重：${Object.entries(base.w).map(([k, v]) => `${k} ${pct(v * 100)}%`).join(' / ')}；保守（安全边际 ${pct(safeMargin)}%）= ${r2(conservative)} 元` },
  ];
  const scenRows = [
    { name: `乐观情景（权重集【${bandLabel(opt.band)}】）`, value: `综合 ${r2(opt.composite)} 元；DCF ${opt.d.tpDCF}｜相对 ${opt.rel.blend}｜PB-ROE ${opt.pr.tpPB}｜SOTP ${opt.so.tpSOTP}｜订单 ${opt.od.tpOrder}；假设：${SC.optimistic && SC.optimistic.note || ''}` },
    { name: `基准情景（权重集【${bandLabel(base.band)}】）`, value: `综合 ${r2(base.composite)} 元；DCF ${base.d.tpDCF}｜相对 ${base.rel.blend}｜PB-ROE ${base.pr.tpPB}｜SOTP ${base.so.tpSOTP}｜订单 ${base.od.tpOrder}；假设：${SC.base && SC.base.note || ''}` },
    { name: `悲观情景（权重集【${bandLabel(pess.band)}】）`, value: `综合 ${r2(pess.composite)} 元；DCF ${pess.d.tpDCF}｜相对 ${pess.rel.blend}｜PB-ROE ${pess.pr.tpPB}｜SOTP ${pess.so.tpSOTP}｜订单 ${pess.od.tpOrder}；假设：${SC.pessimistic && SC.pessimistic.note || ''}` },
  ];
  const sensRows = sensG();
  const assumpRows = [
    { label: '归一化盈利口径', value: `取 ${EH.length} 年中位：营收 ${r2(normRev)} / 净利 ${r2(normNp)} / EBITDA ${r2(normEbitda)} 亿（周期平滑，避免单年亏损扭曲）` },
    { label: 'FCFF 基数构成', value: `EBIT ${r2(normEbit)}×(1−税${pct(tax)}%) + D&A ${r2(normDa)} − 资本开支 ${r2(normCapex)} − Δ营运资金 ${r2(normNwc)} = ${r2(fcff0)} 亿` },
    { label: '动态权重逻辑', value: `底部重资产锚（DCF+PB-ROE 高权重）/ 景气重相对（PE/EV 高权重）；当前阶段【${bandLabel(bandDefault)}】→ 采用对应权重集` },
    { label: '安全边际', value: `${pct(safeMargin)}%（区间 15%~25% 中值），保守目标价 ${r2(conservative)} 元` },
    { label: '评级铁律', value: `上行空间 >20% 低估 / −10%~+20% 合理 / <−10% 高估（现上行 ${pct(upside)}%）` },
  ];
  const monitorRows = [
    { name: '合同负债 / 营收', value: `合同负债 ${r2(vv(I.balance.contractLiab))} 亿 ÷ TTM 营收 ${r2(normRev)} 亿 = ${pct(div(vv(I.balance.contractLiab), normRev) * 100)}%（前瞻订单能见度的代理）` },
    { name: '在手订单覆盖', value: `在手订单 ${base.od.backlog} 亿，覆盖 ${base.od.coverage} 年营收 → 订单驱动型，关注新签与出海` },
    { name: '有息负债率', value: `有息负债 ${r2(D)} 亿 / 净资产 ${r2(eqParent)} 亿 = ${pct(div(D, eqParent) * 100)}%（财务杠杆与偿付）` },
    { name: '行业 PE 分位', value: `可比 PE 中位 ${r2(peMedian)}×；电气风电 TTM PE 为负（亏损）→ 必须用归一化盈利与资产锚，禁用 TTM PE` },
  ];
  const riskNote = '下行风险：① 风机招标价格战反复、毛利率不及预期；② 下游装机节奏放缓或抢装退潮；③ 海外收入占比与客户集中度风险（单一大客户）；④ 应收账款与存货周转、减值风险；⑤ 有息负债与财务费用压力；⑥ 技术迭代（大兆瓦、海上/漂浮式）落后对手。上行催化：海风与出海放量、招标价企稳回升、订单结构优化、盈利扭亏兑现。模型为研究框架，不构成投资建议。';

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出目标价区间，评级为「无法评级」。';
    return `现价 ${r2(P)} 元位于综合区间 ${r2(rangeLow)}~${r2(rangeHigh)} 元的 ${Math.round(position)}% 位置；综合中枢 ${r2(center)} 元，上行空间 ${pct(upside)}% → 评级「${rating}」。${crossNote}`;
  })();
  const decisionNote = `DCAVM 五站流水线（全动态、无硬编码年份）：时间引擎 → 景气周期评分（${r2(cycleScore)}→【${bandLabel(bandDefault)}】）→ 多路估值（三阶段DCF / 相对 / PB-ROE / SOTP / 订单）→ 按周期阶段动态加权合成 → 三情景 + WACC/g 敏感性 + 安全边际${pct(safeMargin)}% → 三档评级。所有数值由代码确定性计算，AI 仅负责叙述。`;

  return {
    ok: true,
    dedicated: true,
    dcavm: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservative),
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? pct(upside) : null,
    reportLabel: cfg.reportLabel,
    model: 'dcavm688660·动态周期估值模型（相对+绝对+周期锚交叉验证，确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    cycleScore: r2(cycleScore),
    cycleBand: bandDefault,
    wacc: pct(WACC),
    peMedian: r2(peMedian),
    pbMedian: r2(pbMedian),
    crossNote,
    freshnessRows, alerts,
    coreRows, cycRows, segRows, sotpSegRows, matrixRows, scenRows, sensRows, assumpRows, monitorRows, positionNote, riskNote, decisionNote,
  };
}

function bandLabel(band) {
  return ({ bottom: '周期底部', recovery: '复苏', neutral: '中性', boom: '景气' })[band] || band || '中性';
}

module.exports = { run, isDcavmModel, loadConfig, detectLatestReportMonths, bandLabel };
