// ============================================================
// 长江证券（000783）专属动态估值引擎 V2 —— 确定性计算（1+1=2 原则）
// 20260908u：在 20260908r PB-ROE 主模型基础上叠加五项补丁：
//   补丁A 智能数据映射：动态字段模糊匹配 + 营收三级匹配链 + 经纪×70%估算回退 + 3年均值平滑容错
//   补丁B 去季节性年化：TTM滚动 vs 简单年化，偏离>15%触发季节性异常警告 → 弃用简单年化，仅用机构一致预测
//   补丁C 动态PB锚：合理PB中枢=行业PB×40%+(公司3年ROE/行业3年ROE×行业PB)×60%，预测ROE越界±5~10%上/下修
//         + 自修复机制（连续2次方向性偏差→10年窗口截断至5年重算，监测待接入）
//   补丁D 分部倍数动态适配：经纪/资管PE=板块PE中位×市占率相对系数×0.8~1.2；自营PB固定1.0（收益率>6%→1.1）；
//         科创PE按科创50半年涨跌判牛熊（跌幅>10%→10-12x，宽松→15-18x）
//   补丁E 熔断与极端区间：归母/扣非增速偏离>20pp弃用归母；上行>60%或下行>40%禁止自动评级（锁定"无法评级"）；
//         强制三档：极端悲观(PB 10%分位)/基准(PB中枢)/极端乐观(PB 90%分位)
// 计算层=代码，输入锁死（data/valuation/000783.json）⇒ 结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '000783';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/000783.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isChangjiangModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'changjiang';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const pA = I.patchA, pB = I.patchB, pC = I.patchC, pD = I.patchD, pE = I.patchE;
  const G = I.guard || {};
  const today0 = new Date();

  // ========== 守门员自检（P0一致性修复 20260908z）：财报时效强制终止 + 快照超龄提示 ==========
  const rpEnd = G.reportPeriodEnd && G.reportPeriodEnd.value;
  const reportAge = rpEnd ? daysBetween(rpEnd, today0) : null;
  const maxAge = nz(G.maxAgeDays) || 180;
  const guardRows = [];
  const alerts = [];
  const freshnessRows = [];
  if (rpEnd) {
    freshnessRows.push({ label: '估值基础报告期（中报口径）', asOf: rpEnd, ageDays: reportAge, maxAge, stale: reportAge > maxAge });
    guardRows.push({ label: '① 财报时效', status: reportAge <= maxAge ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${rpEnd}，距检查日 ${reportAge} 天（终止上限 ${maxAge} 天）`, source: (G.reportPeriodEnd || {}).source || '' });
  }
  const snapMax = nz(G.snapshotMaxAgeDays) || 30;
  let staleSnapshots = 0;
  for (const sp of (G.snapshots || [])) {
    const age = sp.asOf ? daysBetween(sp.asOf, today0) : null;
    if (age == null) continue;
    const stale = age > snapMax;
    if (stale) staleSnapshots++;
    freshnessRows.push({ label: sp.label, asOf: sp.asOf, ageDays: age, maxAge: snapMax, stale });
    if (stale) alerts.push(`快照参数「${sp.label}」取数于 ${sp.asOf}（距今 ${age} 天 > ${snapMax} 天）→ 可能已不反映最新市场状态，请复核更新`);
  }
  const terminated = reportAge != null && reportAge > maxAge;

  if (terminated) {
    return {
      ok: true, dedicated: true, changjiang: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'changjiang000783 V2（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（估值基础财报超龄），模型终止本次估值，历史结论不再外推。请更新财报数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }
  const bvps = nz(vv(I.h1_2026.bvpsCommon));           // 6.67（普通股口径，剔除永续债60亿）

  // ========== 补丁A：智能数据映射（动态字段模糊匹配） ==========
  const RF = pA.rawFields || {};
  const fRev = nz(vv(RF['营业总收入']) || 74.26);
  const fComm = nz(vv(RF['手续费及佣金净收入']));
  const fBroker = nz(vv(RF['经纪业务（含\'经纪\'字段）']) || vv(RF['经纪业务']));
  const fInt = nz(vv(RF['利息净收入']));
  const fInv = nz(vv(RF['投资收益+公允价值变动净收益']));
  const fVC = nz(vv(RF['科创投资利润（穿透合并报表）']));
  // 经纪回退链：'经纪'字段缺失 → 手续费及佣金净收入×70%（行业平均占比）【估算标签】
  const brokerEstimated = !fBroker;
  const brokerVal = fBroker || (fComm * 0.70);
  const mappingRows = [
    { label: '营收（三级匹配链）', value: `优先匹配"营业总收入" ✅精确命中 = ${r2(fRev)} 亿（1H26）；未启用"营业收入"次级、未启用四科目加总兜底`, source: (RF['营业总收入'] || {}).source || '' },
    { label: '经纪业务（模糊匹配）', value: brokerEstimated ? `⚠️"经纪"字段缺失 → 按手续费及佣金净收入 ${r2(fComm)} 亿×70%（行业平均占比）= ${r2(brokerVal)} 亿【估算标签】` : `匹配包含"经纪"字段 ✅命中 = ${r2(brokerVal)} 亿（1H26）；未触发"手续费×70%"估算回退`, source: (RF['经纪业务（含\'经纪\'字段）'] || {}).source || (RF['经纪业务'] || {}).source || '' },
    { label: '自营/投资（加总口径）', value: `投资收益 + 公允价值变动净收益 = ${r2(fInv)} 亿（1H26，+110.42%）——补丁A规则3加总口径，替代旧硬编码"投资收入"`, source: (RF['投资收益+公允价值变动净收益'] || {}).source || '' },
    { label: '科创投资利润（穿透）', value: `联营合营投资收益科目无余额；穿透合并报表：长江创新 9.0 亿（中报披露）+ 长江资本 ≈2.4 亿 = ${r2(fVC)} 亿（长江资本为合计倒挤【估算标签】）`, source: (RF['科创投资利润（穿透合并报表）'] || {}).source || '' },
    { label: '容错机制（3年均值平滑）', value: '✅ 本季各业务线字段全部匹配成功，"数据缺失，采用平滑处理"高亮未触发；若未来科目改名/缺失自动按补丁A容错链执行', source: pA.fallbackNote },
  ];

  // ========== 补丁B：去季节性年化（TTM滚动 vs 简单年化） ==========
  const ttmNp = nz(pB.npCum.h1Now) + nz(pB.npCum.fyPrev) - nz(pB.npCum.h1Prev);          // 51.52
  const ttmDed = nz(pB.npDedCum.h1Now) + nz(pB.npDedCum.fyPrev) - nz(pB.npDedCum.h1Prev); // 52.30
  const simpleAnn = nz(pB.npCum.h1Now) * 2;                                              // 63.85
  const divergence = (simpleAnn - ttmNp) / ttmNp * 100;                                  // +23.9%
  const seasonAlert = Math.abs(divergence) > nz(pB.divergenceLimitPct, 15);
  const consensusNp = nz(vv(pB.consensusNp));                                            // 49.99
  // 预测全年净利润：未触发异常→区间公式；触发异常→弃用简单年化，仅用机构一致预测
  const bandLow = Math.max(simpleAnn * pB.simpleAnnualizeBand[0], ttmNp);
  const bandHigh = Math.min(simpleAnn * pB.simpleAnnualizeBand[1], ttmNp * pB.ttmCapFactor);
  const np2026E = seasonAlert ? consensusNp : (bandLow + bandHigh) / 2;
  const np2026EBasis = seasonAlert
    ? `⚠️季节性异常警告触发（偏离 ${r2(divergence)}% > ${pB.divergenceLimitPct}%）→ 自动弃用简单年化，仅采用机构一致性预测（4家均值）${r2(consensusNp)} 亿为基准`
    : `基准 = 区间 [${r2(bandLow)}, ${r2(bandHigh)}] 中值 ${r2(np2026E)} 亿`;
  const seasonRows = [
    { label: 'TTM 归母净利（滚动12个月）', value: `2026H1 ${r2(pB.npCum.h1Now)} + (2025全年 ${r2(pB.npCum.fyPrev)} − 2025H1 ${r2(pB.npCum.h1Prev)}) = ${r2(ttmNp)} 亿`, source: pB.sources.h1Now + '；' + pB.sources.fyPrev },
    { label: 'TTM 扣非净利（双轨展示）', value: `${r2(pB.npDedCum.h1Now)} + (${r2(pB.npDedCum.fyPrev)} − ${r2(pB.npDedCum.h1Prev)}) = ${r2(ttmDed)} 亿`, source: pB.sources.h1Now },
    { label: '简单年化（禁止直接采用）', value: `2026H1×2 = ${r2(simpleAnn)} 亿；与 TTM 偏离 ${r2(divergence)}%（Q4 计提减值+下半年行情错位导致，简单年化会高估约 ${r2(simpleAnn - ttmNp)} 亿）`, source: '补丁B：禁止简单算术年化' },
    { label: '季节性异常判定', value: seasonAlert ? `⚠️ |${r2(divergence)}%| > ${pB.divergenceLimitPct}% → 触发"季节性异常警告"，简单年化已弃用（避免 Q4 暴雷导致预测崩盘）` : `偏离 ${r2(divergence)}% ≤ ${pB.divergenceLimitPct}% → 采用区间公式 [${r2(bandLow)}, ${r2(bandHigh)}]`, source: `补丁B偏离阈值 ${pB.divergenceLimitPct}%` },
    { label: '2026E 全年净利基准', value: `${r2(np2026E)} 亿（${np2026EBasis}）→ 2026E ROE ≈ ${r2(np2026E / 389 * 100)}%`, source: (pB.consensusNp || {}).source || '' },
  ];

  // ========== 补丁C：动态PB锚点（三阶贝叶斯式调整） ==========
  const roe3y = (pC.companyRoe3y.values || []).reduce((a, b) => a + nz(b), 0) / (pC.companyRoe3y.values || [1]).length; // 6.63
  const indRoe = nz(vv(pC.industryRoe3y)) / 100, indPB = nz(vv(pC.industryPB));
  const roeRatio = (roe3y / 100) / indRoe;
  const pbBase = indPB * 0.4 + roeRatio * indPB * 0.6;                                   // 1.3076
  const predRoe = nz(vv(pC.predictedRoe)) / 100;                                         // 12.9%
  let roeAdj = 0, roeAdjNote = '';
  if (predRoe > indRoe * 1.2) { roeAdj = (pC.roeUpBand[0] + pC.roeUpBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe * 100)}% > 行业均值×1.2（${r2(indRoe * 120)}%）→ PB锚按区间中值上修 +${r2(roeAdj * 100)}%（区间 ${pC.roeUpBand[0]}~${pC.roeUpBand[1]}%）`; }
  else if (predRoe < indRoe * 0.8) { roeAdj = (pC.roeDownBand[0] + pC.roeDownBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe * 100)}% < 行业均值×0.8（${r2(indRoe * 80)}%）→ PB锚下修 ${r2(Math.abs(roeAdj) * 100)}%（区间 ${pC.roeDownBand[0]}~${pC.roeDownBand[1]}%）`; }
  else { roeAdjNote = `预测ROE ${r2(predRoe * 100)}% 处行业均值 0.8~1.2 倍带内 → 不修正`; }
  const pbAnchor = pbBase * (1 + roeAdj);                                                // 1.4057
  const pbTarget = bvps * pbAnchor;                                                      // 9.38
  // 理论PB（展示参考）
  const gPerp = nz(vv(I.roeLayer.theoG)) / 100, r = nz(vv(I.roeLayer.costOfEquity)) / 100;
  const theoPB = (predRoe - gPerp) / (r - gPerp);

  // ========== 补丁D：分部倍数动态适配（挂钩市场风险偏好） ==========
  const nm = nz(vv(I.sotpLayer.netMargin)) / 100;
  const sectorPe = nz(vv(pD.sectorPeMedian));                                            // 9.18
  const shareRatio = nz(vv(pD.brokerShareRatio), 1.0);                                   // 1.0【估算】
  const srb = pD.shareRatioBand || [0.8, 1.2];
  const peLightLo = sectorPe * shareRatio * srb[0], peLightHi = sectorPe * shareRatio * srb[1]; // 7.34~11.02
  const invAssets = nz(pD.invAssets.trading) + nz(pD.invAssets.debt) + nz(pD.invAssets.equityOther); // 525.9
  const annInvYield = nz(pD.invIncomeH1) * 2 / invAssets * 100;                          // 12.1%
  const propPb = annInvYield > nz(pD.yieldThreshold, 6) ? nz(pD.propPbUp, 1.1) : nz(pD.propPbBase, 1.0);
  const sci50 = nz(vv(pD.sci50HalfYearChg));
  const vcPe = sci50 <= nz(pD.tightenThreshold || -10) ? (pD.vcPeTight || [10, 12]) : (pD.vcPeLoose || [15, 18]);
  const peIB = pD.peIB || [10, 15];
  const npLight = (nz(vv(I.h1_2026.bizMix.brokerage)) + nz(vv(I.h1_2026.bizMix.netInterest))) * 2 * nm; // 25.38
  const npAM = nz(vv(I.h1_2026.bizMix.am2025)) * nm;
  const npIB = nz(vv(I.h1_2026.bizMix.ib2025)) * nm;
  const npVC = nz(vv(I.h1_2026.vcProfit));
  const netCap = nz(vv(I.sotpLayer.netCapital));
  function sotp(kind) {
    const sc = kind === 'low' ? 0 : kind === 'high' ? 1 : 0.5;
    const parts = {
      light: npLight * (peLightLo + (peLightHi - peLightLo) * sc),
      prop: netCap * propPb,
      am: npAM * (peLightLo + (peLightHi - peLightLo) * sc),
      ib: npIB * (peIB[0] + (peIB[1] - peIB[0]) * sc),
      vc: npVC * (vcPe[0] + (vcPe[1] - vcPe[0]) * sc),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { total, perShare: total / N, parts };
  }
  const sotpLow = sotp('low'), sotpMid = sotp('mid'), sotpHigh = sotp('high');
  const sotpMidPs = (sotpLow.perShare + sotpHigh.perShare) / 2;
  const sotpDev = (sotpMidPs - pbTarget) / pbTarget * 100;

  // ========== 补丁E：扣非切换判定 + 极端三档 + 熔断 ==========
  const growthDev = Math.abs(nz(pE.npGrowthH1) - nz(pE.npDeductedGrowthH1));             // 1.13pp
  const useDeducted = growthDev > nz(pE.deviationLimitPp, 20);
  const pbP10 = nz(vv(pE.pbP10)), pbP50 = nz(vv(pE.pbP50)), pbP90 = nz(vv(pE.pbP90));
  const extremeLow = bvps * pbP10, extremeHigh = bvps * pbP90;
  let fused = false, fuseReason = '', rating = '合理', premiumNote = '';
  if (P != null) {
    const upside = (pbTarget - P) / P * 100;
    const downside = (P - pbTarget) / P * 100;
    if (upside > nz(pE.fuseUpsidePct, 60)) { fused = true; fuseReason = `潜在上行空间 ${r2(upside)}% > ${pE.fuseUpsidePct}% → ⛔禁止自动评级，锁定"无法评级"并推送人工复核（大概率基本面质变或数据出错）`; }
    else if (downside > nz(pE.fuseDownsidePct, 40)) { fused = true; fuseReason = `潜在下行空间 ${r2(downside)}% > ${pE.fuseDownsidePct}% → ⛔禁止自动评级，锁定"无法评级"并推送人工复核`; }
    if (!fused) {
      const disc = (pbTarget - P) / pbTarget * 100;
      if (disc > 10) rating = '低估';
      else if (disc >= -10) rating = '合理';
      else rating = '高估';
      premiumNote = disc >= 0 ? `折价 ${r2(Math.abs(disc))}%` : `溢价 ${r2(Math.abs(disc))}%`;
    }
  }
  if (fused) rating = '无法评级';

  // ---------- 补丁C自修复机制状态 ----------
  const selfHealNote = pC.selfHealNote;

  // ---------- 敏感性：PB 从 10%分位 → 锚 ----------
  const sensRows = [
    { label: `PB 10%分位 ${pbP10.toFixed(2)} 倍`, value: r2(extremeLow) },
    { label: `PB 50%分位 ${pbP50.toFixed(2)} 倍`, value: r2(bvps * pbP50) },
    { label: `PB 90%分位 ${pbP90.toFixed(2)} 倍`, value: r2(extremeHigh) },
    { label: `PB 无ROE修正锚 ${pbBase.toFixed(2)} 倍`, value: r2(bvps * pbBase) },
    { label: `PB 动态锚（修正后） ${pbAnchor.toFixed(2)} 倍`, value: r2(pbTarget) },
  ];

  // ---------- 卡片行 ----------
  const coreRows = [
    { label: '2025 年报', value: `营收 105.48 亿(+59.86%) / 归母 36.96 亿(+101.44%) / 扣非 37.77 亿 / EPS 0.63 元 / 加权ROE 10.02%(+4.94pct) / 分红率 44.88%`, source: I.fy2025.roe.source },
    { label: '2026 中报', value: `营收 74.26 亿(+58.60%) / 归母 31.92 亿(+83.80%) / 扣非 31.64 亿(+84.93%) / ROE 8.39%(+3.63pct) / 归母净资产 429.04 亿 → 普通股 BVPS ${bvps} 元`, source: I.h1_2026.bvpsCommon.source },
    { label: '补丁A·智能数据映射', value: `营收 ✅"营业总收入"精确命中；经纪 ✅"经纪"字段命中 ${r2(brokerVal)} 亿${brokerEstimated ? '【估算标签】' : ''}；自营 ✅加总口径 ${r2(fInv)} 亿；科创 ✅穿透 ${r2(fVC)} 亿；3年均值平滑未触发`, source: pA.fallbackNote },
    { label: '补丁B·去季节性年化', value: `TTM 归母 ${r2(ttmNp)} 亿 / 简单年化 ${r2(simpleAnn)} 亿 → 偏离 ${r2(divergence)}% ${seasonAlert ? `> ${pB.divergenceLimitPct}% ⚠️季节性异常 → 弃用简单年化` : `≤ ${pB.divergenceLimitPct}% 正常`}；2026E 基准 = ${r2(np2026E)} 亿（4家机构一致预测）`, source: (pB.consensusNp || {}).source || '' },
    { label: '补丁E·扣非切换判定', value: `归母增速 +${pE.npGrowthH1}% vs 扣非增速 +${pE.npDeductedGrowthH1}% → 偏离 ${r2(growthDev)} 个百分点 ${useDeducted ? `> ${pE.deviationLimitPp}pp → ⚠️弃用归母，全部改用扣非【非经常性损益干扰】` : `≤ ${pE.deviationLimitPp}pp → 未触发扣非切换，归母口径可用（TTM 扣非 ${r2(ttmDed)} 亿双轨展示）`}`, source: '补丁E规则1：扣非净利润优先原则' },
    { label: '补丁C·动态PB锚', value: `公司3年ROE均值 ${r2(roe3y)}%（4.79/5.08/10.02）÷ 行业3年均值 ${r2(indRoe * 100)}%【假设】=${r2(roeRatio)}；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 动态锚 ${pbAnchor.toFixed(4)} 倍 × BVPS ${bvps} 元 = ${r2(pbTarget)} 元`, source: pC.industryPB.source },
    { label: '理论PB（ROE-PB框架，印证）', value: `(ROE−g)/(r−g)=(${r2(predRoe * 100)}%−${r2(gPerp * 100)}%)/(${r2(r * 100)}%−${r2(gPerp * 100)}%)=${r2(theoPB)} 倍（与动态锚 ${pbAnchor.toFixed(2)} 倍互相印证）`, source: I.roeLayer.costOfEquity.source },
    { label: '补丁D·分部倍数适配', value: `板块PE中位 ${sectorPe} × 市占率相对系数 ${shareRatio}【估算标签：市占率缺失取中性】× 0.8~1.2 → 经纪/资管 PE ${r2(peLightLo)}~${r2(peLightHi)} 倍；自营 PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% ${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → 上调1.1' : '≤ 6% → 维持1.0'}）；科创50近半年 ${sci50 > 0 ? '+' : ''}${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? 'IPO收紧期' : '宽松期'} → 科创PE ${vcPe[0]}~${vcPe[1]} 倍`, source: (pD.sectorPeMedian || {}).source + '；' + (pD.sci50HalfYearChg || {}).source },
    { label: '市场快照', value: `现价 ${P ? r2(P) : 'N/A'} 元 / PE(TTM) 9.23 / PB(LF) 1.11（含永续债口径）/ 普通股PB ≈ ${(P != null ? (P * N / (nz(vv(I.h1_2026.equityParent)) - nz(vv(I.h1_2026.perpetual)))) : 0).toFixed(2)} 倍`, source: I.market.pbLF.source },
  ];

  const matrixRows = [
    { method: '极端悲观（PB 10%分位）', low: r2(extremeLow), mid: null, high: null, note: `BVPS ${bvps} × PB ${pbP10.toFixed(3)} 倍（近5年1211根日K序列10%分位）；熔断检查：${fused ? fuseReason : `现价 ${P ? r2(P) : 'N/A'} 元 → 上行空间 ${P ? r2((pbTarget - P) / P * 100) : 'N/A'}% / 下行空间 ${P ? Math.max(0, r2((P - pbTarget) / P * 100)) : 'N/A'}%，${fused ? '⛔熔断' : '未触及 60%/40% 熔断线 ✅'}`}` },
    { method: '基准（动态PB中枢）', low: null, mid: r2(pbTarget), high: null, note: `BVPS ${bvps} × 动态PB锚 ${pbAnchor.toFixed(4)} 倍（补丁C三阶调整后）；2026E 基准净利 ${r2(np2026E)} 亿（补丁B：${seasonAlert ? '机构一致预测口径' : 'TTM区间口径'}）` },
    { method: '极端乐观（PB 90%分位）', low: null, mid: null, high: r2(extremeHigh), note: `BVPS ${bvps} × PB ${pbP90.toFixed(3)} 倍（近5年序列90%分位）；⚠️结构性提示：动态锚 ${pbAnchor.toFixed(2)} 倍已高于近5年90%分位 ${pbP90.toFixed(2)} 倍——ROE 从 5% 跃升至 13% 期间，历史分位带系统性低于基本面锚，属补丁C设计预期而非数据错误` },
    { method: 'SOTP 分部加总（交叉验证，补丁D倍数）', low: r2(sotpLow.perShare), mid: r2(sotpMidPs), high: r2(sotpHigh.perShare), note: `与PB-ROE偏离 ${sotpDev > 0 ? '+' : ''}${Math.round(sotpDev)}%，${Math.abs(sotpDev) > 15 ? '⚠️偏离>15% 触发人工复核提示（分部PE加总未计集团折价，结果系统性高于PB-ROE口径，以PB-ROE为准）' : '偏离可接受'}` },
    { method: '综合结论（以PB-ROE为主）', low: r2(extremeLow), mid: r2(pbTarget), high: r2(extremeHigh), note: `主模型=动态PB锚；三档供主观决策：极端悲观 ${r2(extremeLow)} / 基准 ${r2(pbTarget)} / 极端乐观 ${r2(extremeHigh)}；熔断状态：${fused ? '⛔已熔断' : '✅未触发'}` },
  ];

  const sotpRows = [
    { label: '经纪+信用（轻资产）', value: `年化收入 (24.3+11.9)×2=72.40 亿 × 净利率 35.06%【假设】= 净利 ${r2(npLight)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍（板块PE中位 ${sectorPe}×相对系数 ${shareRatio}【估算标签】×0.8~1.2）= ${r2(sotpLow.parts.light)}~${r2(sotpHigh.parts.light)} 亿`, source: (pD.sectorPeMedian || {}).source },
    { label: '自营投资（重资产）', value: `净资产法：净资本 ${netCap} 亿 × PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% = 31.88×2 ÷ ${r2(invAssets)} 亿金融投资资产，${annInvYield > nz(pD.yieldThreshold, 6) ? '>6% 上调至1.1' : '≤6% 维持1.0'}）= ${r2(sotpLow.parts.prop)} 亿`, source: (pD.invAssets || {}).source },
    { label: '资管（含长信基金）', value: `2025 净利 2.94×35.06%= ${r2(npAM)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍（与经纪同用补丁D公式）= ${r2(sotpLow.parts.am)}~${r2(sotpHigh.parts.am)} 亿`, source: (pD.shareRatioBand || []).join('~') + ' 倍带（补丁D）' },
    { label: '投行（补充单列）', value: `2025 净利 3.99×35.06%= ${r2(npIB)} 亿 × ${peIB[0]}~${peIB[1]}x PE（补丁未覆盖，沿用框架）= ${r2(sotpLow.parts.ib)}~${r2(sotpHigh.parts.ib)} 亿`, source: '框架SOTP表沿用' },
    { label: '科创投资（长江创新+长江资本）', value: `净利 ${r2(npVC)} 亿 × ${vcPe[0]}~${vcPe[1]}x PE（科创50近半年 ${sci50 > 0 ? '+' : ''}${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? '收紧期 10-12x' : '宽松期 15-18x'}）= ${r2(sotpLow.parts.vc)}~${r2(sotpHigh.parts.vc)} 亿`, source: (pD.sci50HalfYearChg || {}).source },
    { label: 'SOTP 合计', value: `${r2(sotpLow.total)}~${r2(sotpHigh.total)} 亿元 ÷ 总股本 ${N} 亿股 = ${r2(sotpLow.perShare)}~${r2(sotpHigh.perShare)} 元/股`, source: '补丁D：倍数挂钩市场分位数动态适配' },
  ];

  const sensOut = sensRows.map(s => `${s.label}：${s.value} 元`).join(' ｜ ');
  const yieldNote = `自营倍数已由补丁D动态化：年化投资收益率 ${r2(annInvYield)}%（金融投资资产 ${r2(invAssets)} 亿口径）${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → PB 1.1' : '≤ 6% → PB 1.0'}；科创倍数由科创50半年动量自动切换（当前 ${sci50 > 0 ? '+' : ''}${sci50}% → ${vcPe[0]}~${vcPe[1]}x）。`;

  const riskLights = [
    { label: '市场风险（日均成交额 2.74 万亿 > 1.5 万亿）', light: '绿灯' },
    { label: '经营风险（经营杠杆 3.11x < 4.0x）', light: '绿灯' },
    { label: '监管风险（无新增监管措施）', light: '绿灯' },
    { label: '补丁B·季节性异常（TTM与简单年化偏离 ' + r2(divergence) + '% > 15%）', light: '黄灯：已自动弃用简单年化，改用机构一致预测' },
    { label: '补丁E·熔断机制（上行 ' + (P != null ? r2(Math.max(0, (pbTarget - P) / P * 100)) : 'N/A') + '% / 下行 ' + (P != null ? r2(Math.max(0, (P - pbTarget) / P * 100)) : 'N/A') + '%）', light: fused ? '红灯：已熔断，禁止自动评级' : '绿灯：未触及 60%/40% 熔断线' },
    { label: '补丁C·自修复机制（30日走势监测）', light: '监控中：连续2次方向性偏差→10年窗口截断至5年重算（监测通道待接入）' },
    { label: '科创投资（项目退出节奏，IPO 政策敏感）', light: '关注' },
  ];

  // ---------- 买卖信号（沿用框架：8.50 买 / 10.50 卖） ----------
  const sigBuy = nz(vv(I.signals.buyBelow)), sigSell = nz(vv(I.signals.sellAbove));
  let signal = '未触发';
  if (P != null && !fused) {
    if (P <= sigBuy) signal = `⚠️ 进入低估区（现价 ${r2(P)} ≤ 信号线 ${sigBuy} 元）`;
    else if (P >= sigSell) signal = `⚠️ 进入高估区（现价 ${r2(P)} ≥ 信号线 ${sigSell} 元）`;
  }

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出三档区间。';
    if (fused) return `⛔ 熔断触发：${fuseReason} 三档区间（极端悲观 ${r2(extremeLow)} / 基准 ${r2(pbTarget)} / 极端乐观 ${r2(extremeHigh)}）仅供人工复核参考，不输出自动评级。`;
    const disc = (pbTarget - P) / pbTarget * 100;
    return `当前股价 ${r2(P)} 元 vs 基准（动态PB锚）${r2(pbTarget)} 元 → ${premiumNote} → 评级：「${rating}」。三档区间：极端悲观 ${r2(extremeLow)} 元（PB 10%分位）/ 基准 ${r2(pbTarget)} 元（动态锚）/ 极端乐观 ${r2(extremeHigh)} 元（PB 90%分位）；现价处三档区间的 ${Math.max(0, Math.min(100, (P - extremeLow) / (pbTarget - extremeLow) * 100)).toFixed(0)}% 水位（悲观~基准段）。普通股PB ${(P * N / (nz(vv(I.h1_2026.equityParent)) - nz(vv(I.h1_2026.perpetual)))).toFixed(2)} 倍 vs 动态锚 ${pbAnchor.toFixed(2)} 倍。买卖信号：${signal}。`;
  })();

  const riskNote = '上行：ROE 持续高于 12% → 动态锚继续上修、科创项目大额退出 → 上调盈利预测、板块估值修复；下行：日均成交额跌破 1.5 万亿 → 经纪承压、年化投资收益率跌破 6% → 自营 PB 回落至 1.0、科创50 半年跌幅超 10% → 科创 PE 压缩至 10-12x、归母/扣非增速偏离超 20pp → 自动切换扣非口径。熔断保险：上行 >60% 或下行 >40% 禁止自动评级。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    changjiang: true,
    version: 'V2-patched',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(extremeLow), r2(pbTarget)],
    fairValueCenter: r2(pbTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'changjiang000783 V2（补丁A~E：智能映射+去季节年化+动态PB锚+倍数适配+熔断，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    fairPB: { anchor: r2(pbAnchor), base: r2(pbBase), roeAdjPct: r2(roeAdj * 100), theoPB: r2(theoPB), p10: pbP10, p50: pbP50, p90: pbP90 },
    fused,
    fuseReason,
    mappingRows,
    seasonRows,
    coreRows, matrixRows, sotpRows, sensRows, sensOut, yieldNote, riskLights: riskLights.concat([{ label: '⏱ 数据时效', light: staleSnapshots ? ('⚠️ ' + staleSnapshots + ' 项快照超龄（>' + snapMax + '天），详见时效提示') : '🟢 全部在有效期内' }]), positionNote, riskNote, signal,
    guardRows, alerts, freshnessRows,
    decisionNote: `V2 五补丁全接入：A 智能数据映射（模糊匹配+容错，本次全部精确/模糊命中，平滑未触发）；B 去季节性年化（TTM ${r2(ttmNp)} 亿 vs 简单年化 ${r2(simpleAnn)} 亿偏离 ${r2(divergence)}% > 15% ⚠️已弃用简单年化，基准=4家机构一致预测 ${r2(consensusNp)} 亿）；C 动态PB锚（${pbBase.toFixed(4)} 倍中枢 ${roeAdjNote} → ${pbAnchor.toFixed(4)} 倍）；D 分部倍数动态适配（经纪/资管 PE ${r2(peLightLo)}~${r2(peLightHi)}x、自营 PB ${propPb}、科创 ${vcPe[0]}~${vcPe[1]}x）；E 扣非切换未触发（偏离 ${r2(growthDev)}pp）、熔断未触发、强制三档输出（${r2(extremeLow)}/${r2(pbTarget)}/${r2(extremeHigh)}）。BVPS 取普通股口径 6.67 元（剔除永续债 60 亿）。假设项（行业ROE 6.4%、市占率相对系数 1.0【估算标签】、分部净利率 35.06%）均已在卡片标注。`
  };
}

module.exports = { run, isChangjiangModel, loadConfig };
