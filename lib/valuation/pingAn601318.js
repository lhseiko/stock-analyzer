/**
 * lib/valuation/pingAn601318.js —— 中国平安（601318.SH）专属估值模型 v3：滚动估值计算协议
 * ----------------------------------------------------------------
 * ★ 20261029b：按用户下发《滚动估值计算协议（含P/EV、DDM、SOTP、FVOCI/FVTPL分离、陆金所条件处理）》全文升级 v2 → v3。
 *   相对 v2 的协议级变化（用户逐字给定，实现与协议一字不差）：
 *   ① 输入变量新增 6 项：OCIEQ_BV（FVOCI权益账面，含浮盈净资产口径）/ OCIEQ_URG（FVOCI累计税前浮盈）/
 *      FVTPL_EQ（FVTPL权益账面）/ LU_BV（陆金所归属账面）/ M_LU（陆金所总市值）/ S_LU（平安对陆金所持股比例）。
 *      任一缺失按 0 处理，输出表格对应行标 N/A，依赖分支按协议降级（不报错、不中止）。
 *   ② SOTP 分部扩展：EV_L×0.80 + E_PC×0.84 + E_BK×0.83 + OCIEQ_BV×1.00(K_OCI) + FVTPL_EQ×0.60
 *      + 非权益其他资产×0.60 + 陆金所估值，再 ÷N。
 *      陆金所条件：M_LU>0 且 S_LU>0 → M_LU×S_LU；否则 LU_BV>0 → LU_BV×0.60；否则 0。
 *      非权益其他资产 = (BVPS×N) − EV_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV
 *      ⚠️ 口径变化：v2 用寿险账面净资产 EV_L_BV 倒挤（旧口径铁律「禁混减内含价值」）；
 *      v3 协议公式明确用 EV_L（内含价值）扣减，且新增 OCIEQ_BV/FVTPL_EQ/LU_BV 三项扣减——
 *      协议为用户逐字给定，实现照办；差额为负时如实参与计算并在备注披露（「其他资产为负」）。
 *      EV_L_BV 不再被消费（配置文件保留该键仅作历史备查）。
 *   ③ SOTP 熔断条件放宽：v2 任一变量缺失即跳过；v3 仅当 EV_L、E_PC、E_BK **三项均缺失** 才整体 N/A 跳过，
 *      部分缺失按 0 继续计算（协议 3.4）。
 *   ④ 合成区间改为极值法（覆盖 v2 的「只采用 SOTP」校准）：
 *      SOTP成功 → [MIN(下限A, 保守值, SOTP下限), MAX(上限A, 乐观值, SOTP上限)]；
 *      SOTP N/A → MIN/MAX(下限A, 保守值 / 上限A, 乐观值)；DDM N/A → 排除对应候选；均 N/A → [下限A, 上限A]。
 *   ⑤ 新增第六站 FVOCI 辅助行：FVOCI税后浮盈/股 = OCIEQ_URG × (1−0.25) ÷ N（不参与估值）。
 *   ⑥ D 口径：必须优先「归母营运利润口径」股息；配置以 inputs.D.caliber 声明口径，非营运利润口径时备注标注。
 *   ⑦ 固定参数写死（协议三）；cfg.params 若另行指定替代参数 → 深合并采用并在备注标注「用户覆盖参数」。
 *   ⑧ 协议表格禁用「低估/高估/合理」等定性词——summaryRows 只含数字与区间；
 *      rating 字段仍输出（供工作台综合评级徽标三档铁律使用），不出现在协议表格中。
 *   ⑨ 无任何绝对年份/日期硬编码；「最新报告期」自适应（M 按月算法判定，与配置核对过期告警）。
 *   模型只做加、减、乘、除与 MIN/MAX；价格保留两位小数；当前股价 P 仅展示、不参与区间合成。
 */
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '..', '..', 'data', 'valuation', '601318.json');

// ===== 固定参数（协议三·写死，所有运行统一使用；用户覆盖须在备注标注） =====
const FIXED_PARAMS = {
  pevLow: 0.65, pevHigh: 0.90,
  ddmConservative: { r: 0.10, g: 0.035 },
  ddmOptimistic: { r: 0.08, g: 0.05 },
  sotp: { life: 0.80, pc: 0.84, bank: 0.83, oci: 1.00, fvtpl: 0.60, other: 0.60 },
  sotpBand: 0.10,
  dynamicEvMultiple: 0.80,
  tax: 0.25,
};

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

// 变量中文名（时效/口径标注展示用）
const VAR_LABELS = {
  P: '当前股价', N: '总股本', EV: '集团内含价值', D: 'TTM每股股息', NBV: '新业务价值', M: '报告期月数',
  EV_L: '寿险内含价值', E_PC: '产险归母净资产', E_BK: '银行归母净资产', BVPS: '每股净资产',
  OCIEQ_BV: 'FVOCI权益账面', OCIEQ_URG: 'FVOCI累计浮盈', FVTPL_EQ: 'FVTPL权益账面',
  LU_BV: '陆金所账面', M_LU: '陆金所总市值', S_LU: '陆金所持股比例',
};

function loadInputs() {
  try { return JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); } catch (e) { return null; }
}

// 深合并：以 FIXED_PARAMS 为底，cfg.params 仅覆盖显式不同的键，并收集「用户覆盖参数」清单
function mergeParams(over) {
  const p = JSON.parse(JSON.stringify(FIXED_PARAMS));
  const overrides = [];
  const walk = (base, o, prefix) => {
    for (const k of Object.keys(o || {})) {
      const bv = base[k], ov = o[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (bv != null && typeof bv === 'object' && typeof ov === 'object' && ov != null) {
        walk(bv, ov, key);
      } else if (bv !== ov) {
        base[k] = ov;
        overrides.push(`${key}=${ov}`);
      }
    }
  };
  walk(p, over || '', '');
  return { p, overrides };
}

// ---------- 报告期自适应：按月算法判定「最新已披露报告期」的月数 ----------
// 1/1-4/29 → 上年年报(M=12)；4/30-8/30 → 一季报(M=3)；8/31-10/24 → 中报(M=6)；10/25 后 → 三季报(M=9)。
// ★ 20261029e 修正：10 月边界由 10/31 改为 10/25 —— A 股三季报普遍 10 月下旬披露（平安 2026 三季报
//   10-28 披露），旧算法 10 月整月仍判 M=6，导致「数据库已更新至 Q3 却被误告『财报可能过期/数据库尚无
//   更新期数据』」（用户 2026-10-29 报障）。与 DCAVM/麦捷模型的同族算法（10 月 day>=25 → 9）对齐。
function detectLatestReportMonths(baseDate) {
  const d = new Date(baseDate);
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4 && !(m === 4 && day >= 30)) return 12;
  if (m < 8 || (m === 8 && day <= 30)) return 3;
  if (m === 10) return (day >= 25) ? 9 : 6;           // 10/25 起三季报进入披露期（对齐同族算法）
  if (m < 10) return 6;                                // 8/31-9/30 → 中报为最新
  return 9;                                            // 11-12 月 → 三季报为最新
}

/**
 * 按滚动协议 v3 计算。返回 { ok, summaryRows(协议表格13行), raw, missing, zeroFilled, remarks, ... }
 */
function compute(cfgOverride) {
  const cfg = cfgOverride || loadInputs();
  if (!cfg) return { ok: false, error: '缺少输入配置文件 data/valuation/601318.json' };
  const I = cfg.inputs || {};
  const { p, overrides } = mergeParams(cfg.params);
  const v = (k) => (I[k] && I[k].value != null) ? Number(I[k].value) : null;
  const alerts = [];

  // ===== 数据时效规则（20261029c）：每个输入变量记录取数日期 asOf；超 180 天 → 备注行标注，计算照常 =====
  // ① 不自行替换数值、不中止计算，仅作标注（规则原文）；② 未记录 asOf 的有效变量 → 备注提示补录。
  const maxAgeDays = (cfg.freshness && cfg.freshness.maxAgeDays) || 180;
  const now = Date.now();
  const freshnessRows = [];
  const noAsOfVars = [];
  for (const k of Object.keys(I)) {
    if (I[k].value == null) continue;               // 值缺失的变量走 zeroFilled/missing 披露，不参与时效检查
    if (!I[k].asOf) { noAsOfVars.push(k); continue; }
    const asOf = String(I[k].asOf).slice(0, 10);
    const age = Math.floor((now - new Date(asOf)) / 86400000);
    if (!isFinite(age)) continue;
    const stale = age > maxAgeDays;
    freshnessRows.push({ key: k, label: `${k}·${VAR_LABELS[k] || k}`, asOf, ageDays: age, maxAge: maxAgeDays, stale });
    if (stale) {
      alerts.push(`数据时效：变量${k}（${VAR_LABELS[k] || k}）取数于 ${asOf}，已超${maxAgeDays}天，请复核`);
    }
  }
  freshnessRows.sort((a, b) => b.ageDays - a.ageDays);

  const P = v('P'), N = v('N'), EV = v('EV'), D = v('D'), NBV = v('NBV');
  const EV_L = v('EV_L'), E_PC = v('E_PC'), E_BK = v('E_BK'), BVPS = v('BVPS');
  // v3.1：E_L = 寿险及健康险业务归属母公司股东权益（会计净资产口径），净资产扣减专用，严禁用 EV_L（内含价值）替代
  const E_L = v('E_L');
  const BV_Total = v('BV_Total'); // v3.1：非权益其他资产 = BV_Total − 会计口径扣减项；BVPS×N 回退公式已废止
  // v3 新增输入（v3.1 缺失值规则：缺失 → 依赖分支记 N/A 并跳过，严禁填 0 落入其他资产池）
  const OCIEQ_BV = v('OCIEQ_BV'), OCIEQ_URG = v('OCIEQ_URG'), FVTPL_EQ = v('FVTPL_EQ');
  const LU_BV = v('LU_BV'), M_LU = v('M_LU'), S_LU = v('S_LU');
  const missing = Object.keys(I).filter(k => I[k].value == null);

  // ===== ① 报告期自适应：M 自动判定并与配置核对（20261029e 告警改双向） =====
  // 配置 M < 算法 M → 配置财报可能过期（原有场景，告警）；
  // 配置 M > 算法 M → 公司提前披露、数据库（配置）已更新至更新报告期 → 以配置为准，**不告警**
  //（旧逻辑不分方向一律告「数据库尚无更新期数据」，在数据库领先时产生误导——用户 2026-10-29 报障根因之一）。
  const MDetected = detectLatestReportMonths(new Date());
  const MCfg = v('M');
  const M = MCfg != null ? MCfg : MDetected;
  if (M < MDetected) {
    alerts.push(`报告期自适应：引擎按月算法判定最新已披露报告期为 M=${MDetected}（${{ 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[MDetected]}），当前计算采用配置 M=${M}（NBV 为该期累计值）→ 财报可能过期，请更新数据（协议本身无需修改）`);
  }
  const periodLabel = { 3: '一季报', 6: '半年度', 9: '三季报', 12: '年度' }[M] || `M=${M}`;
  const reportLabel = `最新报告期（${periodLabel} · M=${M}）`;

  // ===== 第一站：P/EV 核心锚 =====
  const EVPS = (EV != null && N) ? EV / N : null;
  const lowA = EVPS != null ? EVPS * p.pevLow : null;
  const highA = EVPS != null ? EVPS * p.pevHigh : null;

  // ===== 第二站：DDM 戈登模型（D 缺失或 0 → 均记 N/A，不参与合成） =====
  const ddmCons = (D != null && D !== 0 && p.ddmConservative.r > p.ddmConservative.g)
    ? D * (1 + p.ddmConservative.g) / (p.ddmConservative.r - p.ddmConservative.g) : null;
  const ddmOpt = (D != null && D !== 0 && p.ddmOptimistic.r > p.ddmOptimistic.g)
    ? D * (1 + p.ddmOptimistic.g) / (p.ddmOptimistic.r - p.ddmOptimistic.g) : null;
  const ddmNA = (ddmCons == null || ddmOpt == null);

  // ===== 第三站：SOTP 分部估值（v3.1 修正版，20261029g）=====
  // 总则新增规则（优先于原口径条款）：
  // ① 缺失值规则：变量缺失 → 依赖分支记 N/A 并跳过，严禁填 0 落入其他资产池按 0.60 估值；
  //    缺失项对应资产仍留在 BV_Total 中 → 备注说明「该项未单独拆分，已落入其他资产按0.60估值」。
  // ② EV_L 使用规则：EV_L 仅用于寿险板块 PEV 乘数（3.1），严禁作为 BV_Total 的净资产扣减项；
  //    净资产扣减一律使用会计口径 E_L/E_PC/E_BK。
  // ③ 异常检查规则：非权益其他资产 < 0 → 输出警告并暂停 SOTP，不得将负数代入后续乘数。
  // ④ 分层报告期规则：混合报告期不视为错误、不中止计算、不自行统一口径。
  const requiredSotpCore = ['EV_L', 'E_PC', 'E_BK'];
  const missingSotpCore = requiredSotpCore.filter(k => v(k) == null);
  const coreAllMissing = missingSotpCore.length === requiredSotpCore.length; // 三项均缺失 → 整体跳过（协议 3.9）

  let sotpTarget = null, lowC = null, highC = null, otherAssets = null, sotpTotal = null;
  let sotpSegments = null, otherAssetsFormula = null, luValue = null, luBasis = '';
  const skippedBranches = [];   // N/A 跳过分支名（3.8：备注须列明）
  let sotpAnomaly = null;       // 异常检查警告文案（总则4）
  let otherNegative = false;

  // 3.1 寿险 = EV_L × 0.80（EV_L 仅用于此乘数，不参与任何净资产扣减）
  const lifeVal = (EV_L != null) ? EV_L * p.sotp.life : null;
  if (lifeVal == null) skippedBranches.push('寿险估值');
  // 3.2 产险 = E_PC × 0.84
  const pcVal = (E_PC != null) ? E_PC * p.sotp.pc : null;
  if (pcVal == null) skippedBranches.push('产险估值');
  // 3.3 银行 = E_BK × 0.83
  const bkVal = (E_BK != null) ? E_BK * p.sotp.bank : null;
  if (bkVal == null) skippedBranches.push('银行估值');
  // 3.4 FVOCI = OCIEQ_BV × 1.00；N/A → 分支跳过，不得填 0
  const fvociVal = (OCIEQ_BV != null) ? OCIEQ_BV * p.sotp.oci : null;
  if (fvociVal == null) skippedBranches.push('FVOCI估值');
  // 3.5 FVTPL = FVTPL_EQ × 0.60；N/A → 分支跳过，不得填 0
  const fvtplVal = (FVTPL_EQ != null) ? FVTPL_EQ * p.sotp.fvtpl : null;
  if (fvtplVal == null) skippedBranches.push('FVTPL估值');
  // 3.6 陆金所条件估值（v3.1.1 缺失变量处理规则）：估值成功的前提是 LU_BV 有值——
  //     LU_BV 缺失 → 分支一律 N/A（即使 M_LU/S_LU 都有值也不单独加总，避免「其他资产未扣减陆金所净资产、
  //     却又单独加总陆金所市值」的重复计算）；LU_BV 有值但 M_LU 或 S_LU 缺失 → LU_BV×0.60（不构成重复计算）。
  if (LU_BV == null) {
    luValue = null;
    luBasis = 'LU_BV 缺失 → 陆金所分支 N/A 跳过（严禁填 0；M_LU/S_LU 有值也不单独加总，避免重复计算）';
    skippedBranches.push('陆金所估值');
  } else if (M_LU != null && M_LU > 0 && S_LU != null && S_LU > 0) {
    luValue = M_LU * S_LU;
    luBasis = `M_LU×S_LU = ${M_LU}×${S_LU}（LU_BV 已在第3.7项扣减，市值替换净资产，不构成重复计算）`;
  } else {
    luValue = LU_BV * p.sotp.other;
    luBasis = `LU_BV×0.60 = ${LU_BV}×0.60`;
  }
  // OCIEQ_URG 缺失 → 仅「FVOCI税后浮盈/股」辅助行 N/A（不影响 P/EV、DDM、SOTP 任何计算）
  if (OCIEQ_URG == null) skippedBranches.push('FVOCI税后浮盈每股');
  // 3.7 非权益其他资产 = BV_Total − E_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV
  //     仅扣减实际有值项；N/A 项不扣减（对应资产留在其他资产池，备注说明）。严禁用 EV_L 扣减。
  const DEDUCT_KEYS = ['E_L', 'E_PC', 'E_BK', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'];
  const notSplit = DEDUCT_KEYS.filter(k => v(k) == null); // 未单独拆分、留在其他资产池的项
  if (BV_Total != null) {
    let deducted = BV_Total;
    const parts = [`BV_Total=${BV_Total}`];
    for (const k of DEDUCT_KEYS) {
      const val = v(k);
      if (val != null) { deducted -= val; parts.push(`− ${k}=${val}`); }
    }
    otherAssets = deducted;
    otherAssetsFormula = parts.join(' ') + ` = ${r2(otherAssets)} 亿元（仅扣减实际有值项，N/A 项不扣减）`;
  } else {
    otherAssets = null;
    otherAssetsFormula = 'BV_Total 缺失 → 非权益其他资产分支 N/A 跳过（严禁填 0）';
    skippedBranches.push('其他资产估值');
  }
  // 异常检查（总则4）：其他资产 < 0 → 警告 + 暂停 SOTP
  if (otherAssets != null && otherAssets < 0) {
    otherNegative = true;
    sotpAnomaly = '⚠️ 其他资产为负，请检查 E_L 是否误用 EV_L 或扣减项是否超范围';
    alerts.push(sotpAnomaly);
  }
  // 3.9 整体跳过条件：三项核心均缺失，或异常检查未通过
  const sotpSkipped = coreAllMissing || otherNegative;
  const sotpSkipReason = coreAllMissing
    ? 'SOTP：EV_L、E_PC、E_BK 三项均缺失，整体记 N/A 并跳过（协议 3.9）→ 合成区间降级用 P/EV + DDM'
    : (otherNegative ? `SOTP：异常检查未通过（${sotpAnomaly}）→ 整体记 N/A 并跳过（协议 3.9）` : null);

  let otherVal = null;
  if (!sotpSkipped) {
    // 3.7 其他资产估值 = 非权益其他资产 × 0.60（异常已拦截，此处必为非负）
    otherVal = (otherAssets != null) ? otherAssets * p.sotp.other : null;
    // 3.8 SOTP 目标价：N/A 分支不计入分子
    const branchVals = [lifeVal, pcVal, bkVal, fvociVal, fvtplVal, otherVal, luValue].filter(x => x != null);
    sotpTotal = branchVals.length ? branchVals.reduce((a, b) => a + b, 0) : null;
    sotpTarget = (sotpTotal != null && N) ? sotpTotal / N : null;
    // 3.9 SOTP 区间 ±10%
    if (sotpTarget != null) {
      lowC = sotpTarget * (1 - p.sotpBand);
      highC = sotpTarget * (1 + p.sotpBand);
    }
    const naSrc = '缺失，分支 N/A 跳过（严禁填 0）';
    sotpSegments = [
      { name: '寿险（EV_L 内含价值口径 ×0.80，不参与净资产扣减）', value: EV_L, multiplier: p.sotp.life, result: lifeVal == null ? null : r2(lifeVal), unit: '亿元', source: (I.EV_L && I.EV_L.source) || '' },
      { name: '财产保险（E_PC 会计净资产）', value: E_PC, multiplier: p.sotp.pc, result: pcVal == null ? null : r2(pcVal), unit: '亿元', source: (I.E_PC && I.E_PC.source) || '' },
      { name: '平安银行（E_BK 会计净资产×持股比例）', value: E_BK, multiplier: p.sotp.bank, result: bkVal == null ? null : r2(bkVal), unit: '亿元', source: (I.E_BK && I.E_BK.source) || '' },
      { name: 'FVOCI 权益（账面，含浮盈净资产口径）', value: OCIEQ_BV, multiplier: p.sotp.oci, result: fvociVal == null ? null : r2(fvociVal), unit: '亿元', source: (I.OCIEQ_BV && I.OCIEQ_BV.source) || ((fvociVal == null) ? naSrc : '') },
      { name: 'FVTPL 权益（账面）', value: FVTPL_EQ, multiplier: p.sotp.fvtpl, result: fvtplVal == null ? null : r2(fvtplVal), unit: '亿元', source: (I.FVTPL_EQ && I.FVTPL_EQ.source) || ((fvtplVal == null) ? naSrc : '') },
      { name: '陆金所（条件估值）', value: luValue == null ? null : r2(luValue), multiplier: null, result: luValue == null ? null : r2(luValue), unit: '亿元', source: luBasis },
      { name: '非权益其他资产（BV_Total 倒挤，会计口径扣减）', value: otherAssets == null ? null : r2(otherAssets), multiplier: p.sotp.other, result: otherVal == null ? null : r2(otherVal), unit: '亿元', source: 'BV_Total − E_L − E_PC − E_BK − OCIEQ_BV − FVTPL_EQ − LU_BV（仅扣减实际有值项）' },
    ];
  }

  // ===== 第四站：动态EV参考中枢（不参与合成区间） =====
  const annualNBV = (NBV != null && M) ? NBV * (12 / M) : null;
  const dynEVPS = (EV != null && annualNBV != null && N) ? (EV + annualNBV) / N : null;
  const centerRef = dynEVPS != null ? dynEVPS * p.dynamicEvMultiple : null;

  // v3.1 缺失值规则：严禁将缺失变量填 0 后让其落入其他资产池 → 不再有「按0处理」名单。
  // zeroFilled 字段保留为空数组（下游契约兼容），分支跳过情况以 skippedBranches 披露（协议 3.8）。
  const zeroFilled = [];

  // ===== 第五站：合成估值区间（极值法，仅成功计算的模型参与） =====
  let finalLow = null, finalHigh = null, synthBasis = '';
  {
    const lowCandidates = [], highCandidates = [];
    if (lowA != null) lowCandidates.push(lowA);
    if (highA != null) highCandidates.push(highA);
    if (!ddmNA) { if (ddmCons != null) lowCandidates.push(ddmCons); if (ddmOpt != null) highCandidates.push(ddmOpt); }
    if (!sotpSkipped && lowC != null) lowCandidates.push(lowC);
    if (!sotpSkipped && highC != null) highCandidates.push(highC);
    finalLow = lowCandidates.length ? Math.min(...lowCandidates) : null;
    finalHigh = highCandidates.length ? Math.max(...highCandidates) : null;
    const parts = ['P/EV'];
    if (!ddmNA) parts.push('DDM');
    if (!sotpSkipped) parts.push('SOTP');
    synthBasis = `极值法合成（参与模型：${parts.join(' + ')}${(ddmNA || sotpSkipped) ? '；' + [ddmNA ? 'DDM N/A 已排除' : null, sotpSkipped ? 'SOTP N/A 已排除' : null].filter(Boolean).join('；') : ''}）`;
  }

  // ===== 第六站：FVOCI 辅助行（不参与估值） =====
  const fvociPerShare = (OCIEQ_URG != null && OCIEQ_URG !== 0 && N) ? OCIEQ_URG * (1 - p.tax) / N : null;

  // ===== 评级：纯规则（现价 vs 极值法合成区间），供工作台综合评级徽标（不出现在协议表格） =====
  let rating = 'N/A';
  if (P != null && finalLow != null && finalHigh != null) {
    if (P < finalLow) rating = '低估';
    else if (P > finalHigh) rating = '高估';
    else rating = '合理';
  }

  // ===== 备注行固定格式（协议四，v3.1）=====
  // 「报告期：EV/EV_L/E_PC/E_BK=[报告期]；N/NBV/BV_Total=[报告期]；E_L=[报告期或N/A]；跳过分支=[N/A分支]；其他资产=[正数或异常警告]」
  // 分层报告期是协议允许策略（总则2）：混合报告期不告警、不中止、不自行统一口径，仅如实标注。
  const PERIOD_CHECK_KEYS = ['N', 'EV', 'NBV', 'EV_L', 'E_PC', 'E_BK', 'BV_Total', 'E_L', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'];
  const noPeriodVars = [];
  for (const k of PERIOD_CHECK_KEYS) {
    if (I[k] && I[k].value != null && !I[k].period) noPeriodVars.push(k); // 未声明报告期 → 无法纳入标注，提示补录
  }
  const grpPeriod = (keys) => {
    const pds = [...new Set(keys.filter(k => I[k] && I[k].value != null && I[k].period).map(k => I[k].period))];
    return pds.length ? pds.join('/') : '未声明';
  };
  const evGrpP = grpPeriod(['EV', 'EV_L', 'E_PC', 'E_BK']);
  const bvGrpP = grpPeriod(['N', 'NBV', 'BV_Total']);
  const nbvTag = (I.NBV && I.NBV.value != null && I.NBV.periodTag) ? `（NBV 为 ${I.NBV.periodTag} 累计）` : '';
  const elP = (I.E_L && I.E_L.value != null) ? (I.E_L.period || '未声明') : 'N/A';
  const otherAssetText = otherNegative ? sotpAnomaly : (otherAssets != null ? `${r2(otherAssets)} 亿元` : 'N/A（BV_Total 缺失）');
  const fixedRemark = `报告期：EV/EV_L/E_PC/E_BK=${evGrpP}；N/NBV/BV_Total=${bvGrpP}${nbvTag}；E_L=${elP}；其他资产=${otherAssetText}`;
  const periodAnnotation = fixedRemark; // 兼容字段（原「报告期标注」），v3.1 起为协议四固定格式（跳过分支移入缺失变量块）

  // ===== 备注（协议五·备注行）：固定格式 + D 口径 / 数据时效 / 未单独拆分 / 用户覆盖参数 =====
  const remarks = [];
  {
    const caliber = (I.D && I.D.caliber) || '';
    if (D == null) remarks.push('D 缺失 → DDM 两值记 N/A，不参与合成');
    else if (D === 0) remarks.push('D 为 0 → DDM 两值记 N/A，不参与合成');
    else if (caliber === '营运利润') remarks.push('D 为归母营运利润口径（优先口径，无降级标注）');
    else if (caliber === '净利润') remarks.push('D为净利润口径（数据库无营运利润口径股息）');
    else remarks.push('D 口径未在配置中声明（inputs.D.caliber 缺失）→ 请核对是否为归母营运利润口径');
  }
  // 数据时效规则：超龄标注（规则原文文案），计算照常、不替换数值、不中止
  for (const fr of freshnessRows) {
    if (fr.stale) remarks.push(`变量${fr.key}取数于${fr.asOf}，已超${maxAgeDays}天，请复核`);
  }
  if (noAsOfVars.length) remarks.push(`变量${noAsOfVars.join('、变量')}未记录取数日期，请补录`);
  remarks.push(fixedRemark);
  if (noPeriodVars.length) remarks.push(`变量${noPeriodVars.join('、变量')}未声明报告期（无法纳入报告期标注），请补录`);
  // ===== 缺失变量处理规则（v3.1.1 协议五）固定格式：只在备注行汇总说明 =====
  // 六变量（OCIEQ_BV/OCIEQ_URG/FVTPL_EQ/LU_BV/M_LU/S_LU）缺失不视为错误：不中止、不填0、不估算、
  // 不要求复核、不在备注行之外单独输出 ⚠️ 缺失警告（前端已同步移除 missingNote 条）。
  const SIX_MISSING_KEYS = ['OCIEQ_BV', 'OCIEQ_URG', 'FVTPL_EQ', 'LU_BV', 'M_LU', 'S_LU'];
  const sixMissing = SIX_MISSING_KEYS.filter(k => v(k) == null);
  const notDeducted = ['OCIEQ_BV', 'FVTPL_EQ', 'LU_BV'].filter(k => v(k) == null);
  const missingRemark = `缺失变量：${sixMissing.length ? sixMissing.join('、') : '无'}`
    + `；跳过分支：${skippedBranches.length ? skippedBranches.join('、') : '无'}`
    + `；未扣减项：${notDeducted.length ? notDeducted.join('、') : '无'}`
    + (notDeducted.length && !sotpSkipped ? '；对应资产已落入其他资产按0.60估值' : '')
    + `；P/EV与DDM照常；${sotpSkipped ? 'SOTP 整体 N/A，区间由 P/EV 与 DDM 合成' : 'SOTP按剩余成功分支合成'}`;
  remarks.push(missingRemark);
  if (overrides.length) remarks.push(`用户覆盖参数：${overrides.join('；')}`);
  if (sotpSkipped) remarks.push(`${sotpSkipReason}，合成区间降级为 P/EV + DDM（或 P/EV 单核）`);
  const remarkText = remarks.join('；') || '无';

  const R = (x) => x == null ? 'N/A' : r2(x).toFixed(2);
  const FR2 = (lo, hi) => (lo == null || hi == null) ? 'N/A' : `${R(lo)} ~ ${R(hi)}`;

  // ===== 输出：协议固定表格（五、逐格填充，禁用定性词，禁止额外文字） =====
  const summaryRows = [
    ['当前股价（P）', R(P)],
    ['每股内含价值（EVPS）', R(EVPS)],
    ['EV倍数法核心区间（0.65x~0.90x）', FR2(lowA, highA)],
    ['DDM保守估值（10%/3.5%）', ddmNA ? 'N/A' : R(ddmCons)],
    ['DDM乐观估值（8%/5.0%）', ddmNA ? 'N/A' : R(ddmOpt)],
    ['SOTP目标价', sotpSkipped ? 'N/A' : R(sotpTarget)],
    ['SOTP区间（±10%）', (sotpSkipped || lowC == null || highC == null) ? 'N/A' : FR2(lowC, highC)],
    ['合成估值区间（极值法）', FR2(finalLow, finalHigh)],
    ['核心聚焦区间（EV倍数法）', FR2(lowA, highA)],
    ['动态EV参考中枢（含NBV年化）', centerRef != null ? R(centerRef) : 'N/A'],
    ['FVOCI税后浮盈/股（辅助，不参与估值）', fvociPerShare != null ? R(fvociPerShare) : 'N/A（OCIEQ_URG 缺失）'],
    ['陆金所估值（SOTP内）', (sotpSkipped || luValue == null) ? 'N/A（变量缺失，分支跳过）' : R(luValue)],
    ['备注', remarkText],
  ];

  // ===== 三段式明细（SOTP / DDM / P-EV），字段契约与 v2 保持一致（前端/结论文本消费） =====
  const sotpInputs = ['EV_L', 'E_L', 'E_PC', 'E_BK', 'BV_Total', 'OCIEQ_BV', 'FVTPL_EQ', 'LU_BV', 'M_LU', 'S_LU', 'N'].filter(k => I[k]).map(k => ({
    key: k, label: k, value: v(k), unit: (I[k] && I[k].unit) || '',
    source: (I[k] && I[k].source) || ((v(k) == null) ? '缺失，分支 N/A 跳过' : ''),
  }));
  const sotpDetails = {
    title: 'SOTP 分部估值（v3.1 修正版 · 极值法合成参与）',
    skipped: sotpSkipped,
    skipReason: sotpSkipReason,
    missingVars: missingSotpCore,
    skippedBranches,
    notSplit,
    anomaly: sotpAnomaly,
    targetPrice: r2(sotpTarget),
    range: (lowC != null && highC != null) ? [r2(lowC), r2(highC)] : null,
    band: p.sotpBand,
    totalValue: r2(sotpTotal),
    luValue: r2(luValue),
    luBasis,
    inputs: sotpInputs,
    segments: sotpSegments || [],
    otherAssetsFormula,
  };
  const ddmDetails = {
    title: 'DDM 股息贴现（极值法合成参与）',
    d: D,
    caliber: (I.D && I.D.caliber) || '',
    unit: '元/股',
    ttmNote: 'D 为最近四个季度（TTM）累计每股股息，M 固定=12',
    na: ddmNA,
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
  const fvociDetails = {
    title: 'FVOCI 辅助行（第六站，不参与估值）',
    ociEqBv: OCIEQ_BV,
    ociEqUrg: OCIEQ_URG,
    fvtplEq: FVTPL_EQ,
    tax: p.tax,
    perShare: r2(fvociPerShare),
    formula: (OCIEQ_URG != null && OCIEQ_URG !== 0 && N) ? `OCIEQ_URG×(1−税率)÷N = ${OCIEQ_URG}×(1−${p.tax})÷${N} = ${r2(fvociPerShare)} 元/股` : 'OCIEQ_URG 缺失，辅助行记 N/A（不参与估值，不影响计算）',
  };

  return {
    ok: true,
    symbol: '601318',
    model: 'pingAnRolling_v3',
    version: (cfg.modelVersion || '滚动估值协议_v3.1'),
    reportDate: (cfg.reportPeriod && cfg.reportPeriod.periodLabel) || '最新报告期',
    reportLabel,
    rating,
    fairValueRange: (finalLow != null && finalHigh != null) ? [r2(finalLow), r2(finalHigh)] : null,
    fairValueCenter: (finalLow != null && finalHigh != null) ? r2((finalLow + finalHigh) / 2) : null,
    focusRange: (lowA != null && highA != null) ? [r2(lowA), r2(highA)] : null,
    methodsUsed: sotpSkipped
      ? ['P/EV核心锚（核心聚焦区间）', 'DDM双参（极值法合成）']
      : ['P/EV核心锚（核心聚焦区间）', 'DDM双参（极值法合成）', 'SOTP分部估值（极值法合成）'],
    summaryRows,
    rows: summaryRows,
    synthBasis,
    sotpDetails,
    ddmDetails,
    pevDetails,
    fvociDetails,
    remarks,
    periodAnnotation,
    noPeriodVars,
    missing,
    zeroFilled,
    skippedBranches,
    notSplit,
    sotpAnomaly,
    sotpSkipped,
    sotpSkipReason,
    sotpDegraded: false,
    otherAssets: r2(otherAssets),
    otherNegative,
    evLbv: v('EV_L_BV'),
    evLbvDeprecated: true,
    alerts,
    freshnessRows,
    reportPeriod: { months: M, type: periodLabel, detected: MDetected },
    raw: { P, N, EV, EVPS, lowA, highA, ddmCons, ddmOpt, sotpTarget, sotpTotal, lowC, highC, annualNBV, dynEVPS, centerRef, finalLow, finalHigh, otherAssets, luValue, fvociPerShare, M },
  };
}

module.exports = { compute, loadInputs, INPUT_FILE, detectLatestReportMonths, FIXED_PARAMS, mergeParams };
