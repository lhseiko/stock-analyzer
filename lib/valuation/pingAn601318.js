/**
 * lib/valuation/pingAn601318.js —— 中国平安（601318.SH）专属估值模型 v2：滚动估值计算协议
 * ----------------------------------------------------------------
 * 20260908x：滚动估值协议（永久版·无日期硬编码·财报自动适配）
 *   ① 报告期自适应：M（NBV报告期月数）由引擎按月算法自动判定（一季报=3/半年报=6/三季报=9/年报=12）；
 *      D 为 TTM 口径（M 固定=12）；配置未跟上报告期时标记「财报可能过期」。
 *   ② 熔断与降级：SOTP 所需变量（EV_L/E_PC/E_BK/EV_L_BV/BVPS/N）任一缺失 → 整体跳过 SOTP，
 *      仅用 P/EV + DDM 双核合成，并标注「SOTP：数据不足，已跳过」（缺失项不再按 0 参与公式）。
 *   ③ 合成规则（20260908z2 用户校准）：综合估值区间只采用 SOTP（±10%）；P/EV 与 DDM 仅展示；SOTP 熔断跳过时才降级用 P/EV+DDM 双核极值合成。核心聚焦区间 = [EVPS×0.65, EVPS×0.90]。
 *   ④ 动态EV中枢：年化NBV=NBV×(12÷M)；中枢价=[(EV+年化NBV)÷N]×0.80（不参与区间合成）。
 *   ⑤ 输出 = 协议固定表格（逐格填充）+ 三段式明细（SOTP/DDM/P-EV）。
 * 模型只做加、减、乘、除与 MIN/MAX；参数写死；输入锁死 ⇒ 结果锁死（1+1=2）。
 * ⚠️ 口径铁律（20260908 确立，保留）：「其他资产=BVPS×N−EV_L_BV−E_PC−E_BK」按账面口径倒挤，
 *    禁止把内含价值 EV_L 直接混减账面净资产（原式必为负）。寿险估值仍用 EV_L×0.80（内含价值口径）。
 */
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '..', '..', 'data', 'valuation', '601318.json');
const DEFAULT_PARAMS = {
  pevLow: 0.65, pevHigh: 0.90,
  ddmConservative: { r: 0.10, g: 0.035 },
  ddmOptimistic: { r: 0.08, g: 0.05 },
  sotp: { life: 0.80, pc: 0.84, bank: 0.83, other: 0.60 },
  sotpBand: 0.10,
  dynamicEvMultiple: 0.80,
};

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

function loadInputs() {
  try { return JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); } catch (e) { return null; }
}

// ---------- 报告期自适应：按月算法判定「最新已披露报告期」的月数 ----------
// 1/1-4/29 → 上年年报(M=12)；4/30-8/30 → 最新披露为一季报(M=3)；
// 8/31-10/30 → 中报披露截止已过 → M=6；10/31 后 → 三季报 M=9。
// 与海天603288/圣湘688289 同一算法族。
function detectLatestReportMonths(baseDate) {
  const d = new Date(baseDate);
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4 && !(m === 4 && day >= 30)) return 12;   // 年报披露季（4/30 截止前沿用上年年报）
  if (m < 8 || (m === 8 && day <= 30)) return 3;      // 4/30-8/30 → 最新披露为一季报
  if (m < 10 || (m === 10 && day <= 30)) return 6;    // 8/31-10/30 → 中报为最新
  return 9;                                            // 10/31-12/31 → 三季报为最新
}

/**
 * 按滚动协议计算。返回 { ok, rows(协议模板表), raw, missing, sotpSkipped, ... }
 */
function compute(cfgOverride) {
  const cfg = cfgOverride || loadInputs();
  if (!cfg) return { ok: false, error: '缺少输入配置文件 data/valuation/601318.json' };
  const I = cfg.inputs || {};
  const p = Object.assign({}, DEFAULT_PARAMS, cfg.params || {});
  const v = (k) => (I[k] && I[k].value != null) ? Number(I[k].value) : null;
  const alerts = [];
  const freshnessRows = [];
  {
    const FR = cfg.freshness || {};
    const frMax = FR.maxAgeDays || 180;
    for (const it of (FR.items || [])) {
      const key = it.label.startsWith('D') ? 'D' : 'N';
      const age = I[key] && I[key].asOf ? Math.floor((Date.now() - new Date(I[key].asOf)) / 86400000) : null;
      if (age == null) continue;
      const stale = age > frMax;
      freshnessRows.push({ label: it.label, asOf: I[key].asOf, ageDays: age, maxAge: frMax, stale });
      if (stale) alerts.push(it.label + ' 取数于 ' + I[key].asOf + '（距今 ' + age + ' 天 > ' + frMax + ' 天）→ 请复核更新（' + ((I[key] && I[key].asOfNote) || '') + '）');
    }
  }

  const P = v('P'), N = v('N'), EV = v('EV'), D = v('D'), NBV = v('NBV');
  const EV_L = v('EV_L'), E_PC = v('E_PC'), E_BK = v('E_BK'), BVPS = v('BVPS'), EV_L_BV = v('EV_L_BV');

  // ===== ① 报告期自适应：M 自动判定并与配置核对 =====
  const MDetected = detectLatestReportMonths(new Date());
  const MCfg = v('M');
  const M = MCfg != null ? MCfg : MDetected;
  if (M !== MDetected) {
    alerts.push(`报告期自适应：引擎按月算法判定最新已披露报告期为 M=${MDetected}（${{ 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[MDetected]}），当前计算采用配置 M=${M} → 财报可能过期或提前适配，请核对数据（协议本身无需修改）`);
  }
  const periodLabel = { 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[M] || `M=${M}`;
  const reportLabel = `最新报告期（${periodLabel} · M=${M}）`;

  const missing = Object.keys(I).filter(k => I[k].value == null);

  // ===== 第一站：P/EV 核心锚（永远优先计算） =====
  const EVPS = (EV != null && N) ? EV / N : null;
  const lowA = EVPS != null ? EVPS * p.pevLow : null;
  const highA = EVPS != null ? EVPS * p.pevHigh : null;

  // ===== 第二站：DDM 戈登模型（保守与乐观并行） =====
  const ddmCons = (D != null && p.ddmConservative.r > p.ddmConservative.g)
    ? D * (1 + p.ddmConservative.g) / (p.ddmConservative.r - p.ddmConservative.g) : null;
  const ddmOpt = (D != null && p.ddmOptimistic.r > p.ddmOptimistic.g)
    ? D * (1 + p.ddmOptimistic.g) / (p.ddmOptimistic.r - p.ddmOptimistic.g) : null;

  // ===== 第三站：SOTP 分部估值（条件触发 + 熔断降级） =====
  const requiredSotp = ['EV_L', 'E_PC', 'E_BK', 'EV_L_BV', 'BVPS', 'N'];
  const missingSotpVars = requiredSotp.filter(k => v(k) == null);
  const sotpSkipped = missingSotpVars.length > 0;
  const sotpSkipReason = sotpSkipped
    ? `SOTP：数据不足，已跳过（缺：${missingSotpVars.join('、')}）→ 仅采用 P/EV + DDM 双核合成区间`
    : null;

  let sotpTarget = null, lowC = null, highC = null, otherAssets = null, sotpTotal = null;
  let sotpSegments = null, otherAssetsFormula = null;
  if (!sotpSkipped) {
    otherAssets = BVPS * N - EV_L_BV - E_PC - E_BK;
    const vLife = EV_L * p.sotp.life, vPc = E_PC * p.sotp.pc, vBk = E_BK * p.sotp.bank, vOther = otherAssets * p.sotp.other;
    sotpTotal = vLife + vPc + vBk + vOther;
    sotpTarget = sotpTotal / N;
    lowC = sotpTarget * (1 - p.sotpBand);
    highC = sotpTarget * (1 + p.sotpBand);
    sotpSegments = [
      { name: '寿险及健康险（内含价值口径）', value: EV_L, multiplier: p.sotp.life, result: r2(vLife), unit: '亿元', source: (I.EV_L && I.EV_L.source) || '' },
      { name: '财产保险（归母净资产）', value: E_PC, multiplier: p.sotp.pc, result: r2(vPc), unit: '亿元', source: (I.E_PC && I.E_PC.source) || '' },
      { name: '银行（归母净资产×持股比例）', value: E_BK, multiplier: p.sotp.bank, result: r2(vBk), unit: '亿元', source: (I.E_BK && I.E_BK.source) || '' },
      { name: '其他资产（账面口径倒挤）', value: r2(otherAssets), multiplier: p.sotp.other, result: r2(vOther), unit: '亿元', source: `BVPS×N − EV_L_BV − E_PC − E_BK` },
    ];
    otherAssetsFormula = `BVPS×N − EV_L_BV − E_PC − E_BK = ${BVPS}×${N} − ${EV_L_BV} − ${E_PC} − ${E_BK} = ${r2(otherAssets)} 亿元`;
  }

  // ===== 第四站：动态EV中枢（含NBV年化，不参与区间合成） =====
  const annualNBV = (NBV != null && M) ? NBV * (12 / M) : null;
  const dynEVPS = (EV != null && annualNBV != null && N) ? (EV + annualNBV) / N : null;
  const centerRef = dynEVPS != null ? dynEVPS * p.dynamicEvMultiple : null;

  // ===== 第五站：合成最终区间（20260908z2 用户校准：综合估值区间只采用 SOTP；P/EV 与 DDM 仅作展示与交叉参考） =====
  // 熔断降级路径保留：SOTP 数据不足被跳过时，才用 P/EV + DDM 双核极值合成，并在表格标注。
  let finalLow = null, finalHigh = null, synthBasis = '';
  if (!sotpSkipped && lowC != null && highC != null) {
    finalLow = lowC;
    finalHigh = highC;
    synthBasis = '综合估值区间只采用 SOTP（±10%）；P/EV 与 DDM 仅作展示，不融入综合区间';
  } else {
    const lowCandidates = [], highCandidates = [];
    if (lowA != null && highA != null) { lowCandidates.push(lowA); highCandidates.push(highA); }
    if (ddmCons != null) lowCandidates.push(ddmCons);
    if (ddmOpt != null) highCandidates.push(ddmOpt);
    finalLow = lowCandidates.length ? Math.min(...lowCandidates) : null;
    finalHigh = highCandidates.length ? Math.max(...highCandidates) : null;
    synthBasis = 'SOTP：数据不足，已跳过 → 降级采用 P/EV + DDM 双核极值合成';
  }

  // 评级：纯规则（现价 vs 极值法合成区间），不含主观判断
  let rating = 'N/A';
  if (P != null && finalLow != null && finalHigh != null) {
    if (P < finalLow) rating = '低估';
    else if (P > finalHigh) rating = '高估';
    else rating = '合理';
  }

  const R = (x) => x == null ? 'N/A' : r2(x).toFixed(2);
  const F = (x) => x == null ? 'N/A' : Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ===== 输出：协议固定表格（逐格填充，禁止额外文字） =====
  const summaryRows = [
    ['当前股价（P）', R(P)],
    ['每股内含价值（EVPS）', R(EVPS)],
    ['EV倍数法核心区间（0.65x~0.90x）', (lowA == null || highA == null) ? 'N/A' : `${R(lowA)} ~ ${R(highA)}`],
    ['DDM保守估值（10%/3.5%）', R(ddmCons)],
    ['DDM乐观估值（8%/5.0%）', R(ddmOpt)],
    ['SOTP分部估值结果', sotpSkipped ? 'N/A（数据不足，已跳过）' : R(sotpTarget)],
    ['综合估值区间（仅采用SOTP）' + (sotpSkipped ? '（降级：P/EV+DDM双核）' : ''), (finalLow == null || finalHigh == null) ? 'N/A' : `${R(finalLow)} ~ ${R(finalHigh)}`],
    ['动态EV参考中枢（含NBV年化）', R(centerRef)],
  ];

  // ===== 三段式明细（SOTP / DDM / P-EV） =====
  const sotpDetails = {
    title: 'SOTP 分部估值（综合估值区间采用）',
    skipped: sotpSkipped,
    skipReason: sotpSkipReason,
    missingVars: missingSotpVars,
    targetPrice: r2(sotpTarget),
    range: (lowC != null && highC != null) ? [r2(lowC), r2(highC)] : null,
    band: p.sotpBand,
    totalValue: r2(sotpTotal),
    inputs: requiredSotp.concat(['EV_L_BV']).filter((k, i, a) => a.indexOf(k) === i && I[k]).map(k => ({
      key: k, label: k, value: v(k), unit: (I[k] && I[k].unit) || '', source: (I[k] && I[k].source) || '',
    })),
    segments: sotpSegments || [],
    otherAssetsFormula,
  };
  const ddmDetails = {
    title: 'DDM 股息贴现（仅展示，不融入综合区间）',
    d: D,
    unit: '元/股',
    ttmNote: 'D 为最近四个季度（TTM）累计每股股息',
    conservative: { r: p.ddmConservative.r, g: p.ddmConservative.g, value: r2(ddmCons) },
    optimistic: { r: p.ddmOptimistic.r, g: p.ddmOptimistic.g, value: r2(ddmOpt) },
    source: (I.D && I.D.source) || '',
  };
  const pevDetails = {
    title: 'P/EV 内含价值倍数（核心锚 · 核心聚焦区间）',
    ev: EV,
    n: N,
    evps: r2(EVPS),
    pevLow: p.pevLow,
    pevHigh: p.pevHigh,
    range: (lowA != null && highA != null) ? [r2(lowA), r2(highA)] : null,
    source: `${(I.EV && I.EV.source) || ''}；${(I.N && I.N.source) || ''}`,
  };

  return {
    ok: true,
    symbol: '601318',
    model: 'pingAnRolling_v2',
    version: (cfg.modelVersion || '滚动估值协议_v2.0'),
    reportDate: (cfg.reportPeriod && cfg.reportPeriod.periodLabel) || '最新报告期',
    reportLabel,
    rating,
    fairValueRange: (finalLow != null && finalHigh != null) ? [r2(finalLow), r2(finalHigh)] : null,
    fairValueCenter: (finalLow != null && finalHigh != null) ? r2((finalLow + finalHigh) / 2) : null,
    focusRange: (lowA != null && highA != null) ? [r2(lowA), r2(highA)] : null,
    methodsUsed: sotpSkipped ? ['P/EV内含价值（核心锚）', 'DDM股息贴现'] : ['P/EV内含价值（核心锚）', 'DDM股息贴现', 'SOTP分部估值（综合区间采用）'],
    summaryRows,
    rows: summaryRows,
    sotpDetails,
    ddmDetails,
    pevDetails,
    missing,
    sotpSkipped,
    sotpSkipReason,
    sotpDegraded: false,
    otherAssets: r2(otherAssets),
    otherNegative: otherAssets != null && otherAssets < 0,
    evLbv: EV_L_BV,
    alerts,
    freshnessRows,
    reportPeriod: { months: M, type: periodLabel, detected: MDetected },
    raw: { P, N, EV, EVPS, lowA, highA, ddmCons, ddmOpt, sotpTarget, lowC, highC, annualNBV, dynEVPS, centerRef, finalLow, finalHigh, otherAssets, M },
  };
}

module.exports = { compute, loadInputs, INPUT_FILE, detectLatestReportMonths };
