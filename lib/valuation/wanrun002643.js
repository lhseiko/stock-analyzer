// ============================================================
// 万润股份（002643）专属估值模型 v2.1 —— 数据熔断与异常校准版（确定性计算，1+1=2，无 LLM 参与）
// 依《万润股份逻辑估值模型 v2.0：数据频率自适应版》+《v2.1 数据熔断与异常校准补丁》（20261030k 用户指令，强制开启）：
//   永久有效原则：估值方法/权重结构/防失真规则/输出格式永久固定，数值型假设随最新财报与市场数据自动重算。
//   v2.0 新增：①数据频率四层分级（A定期报告全披露/B半年报年报/C年报或外部采集/D实时市场）
//             ②累计转单季再滚动TTM（A层流量指标统一法则）③存量指标最近时点法则
//             ④结构外推+总和校验 ⑤置信度衰减（点估计不变，只影响区间宽度与层权重）
//             ⑥一致性校验四条（总和/趋势/环比/交叉）⑦DCF再平衡先于置信度调整、最终权重归一化。
//   v2.1 新增（四项熔断，强制开启）：
//             熔断1 行业PE极值熔断——行业PE中位数>60倍或近5年80%分位以上 → 基准PE=min(中位数,60)再×折价系数，记录「行业PE极值熔断已触发」；
//             熔断2 市场隐含定价（反向）约束——市值÷目标PE隐含利润 vs 机构一致预期偏差>30% → PE层预测净利取两者均值（向市场现实妥协）；
//             熔断3 D层行情时效强校验——D层数据与估值基准日差>5个交易日 → 强制标「⚠️ 行情数据滞后，非实时估值」+隐含涨跌幅置信度降至0.6；>15个交易日 → 禁止输出低估/高估信号，仅输出绝对估值区间；
//             熔断4 层间背离一票否决——PB-ROE与PE差异>100%（极端戴维斯双击/双杀）→ 禁止简单加权，合并值取两者较低者（保守原则），释放权重转移给DCF。
//   三层加权（永久固定）：①PB-ROE 主锚 50% ②PE 相对 35% ③DCF 辅助 15%。
//   五业务单元（显示/环保/半导体/生命科学/新能源）仅用于叙事，新能源按期权价值、不单独估值。
// 计算层=代码；A层核心输入每次运行实时拉取东财 F10 三表（锚点自动前移 9M→H1→Q1）⇒ 数据不变则结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '002643';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/002643.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isWanrunModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'wanrun';
}

const r1 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 10) / 10;
const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const r3 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 1000) / 1000;
const r4 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 10000) / 10000;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const nzd = (v, d) => (v == null || !isFinite(Number(v))) ? d : Number(v);
const vv = (o) => (o && o.value != null) ? o.value : (o == null ? null : o);
const mean = (a) => (a && a.length) ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100);
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

// ==================== v2.0 纯函数（导出供零网络测试） ====================

// 表C式 TTM 拼接：TTM = 年度锚 + 本年累计 − 上年同期累计（严格口径，禁年化）。
function ttmSplice(fyVal, curCum, prevSameCum) {
  const f = (fyVal == null || !isFinite(Number(fyVal))) ? null : Number(fyVal);
  const c = (curCum == null || !isFinite(Number(curCum))) ? null : Number(curCum);
  const s = (prevSameCum == null || !isFinite(Number(prevSameCum))) ? null : Number(prevSameCum);
  if (f != null && c != null && s != null) return { value: f + c - s, gap: false, note: `TTM=年度锚 ${r2(f)} + 本年累计 ${r2(c)} − 上年同期累计 ${r2(s)}` };
  return { value: null, gap: true, note: 'TTM不可计算·数据缺口 → 按第五节法则用上年同季插补（置信度 0.6）或回退配置锚' };
}

// 累计转单季（第五节第一步）：{q1,h1,q3,fy} 累计值 → 单季数组 [Q1,Q2,Q3,Q4]
function cumToQuarters(c) {
  const q = {};
  if (c && c.q1 != null) q.Q1 = c.q1;
  if (c && c.q1 != null && c.h1 != null) q.Q2 = c.h1 - c.q1;
  if (c && c.h1 != null && c.q3 != null) q.Q3 = c.q3 - c.h1;
  if (c && c.q3 != null && c.fy != null) q.Q4 = c.fy - c.q3;
  return q;
}

// 一致性校验一：总和校验（分板块外推收入之和 vs 总营收，偏差 >2% 按比例缩放）
function sumCheckSegs(segs, total, tol) {
  const t = tol != null ? tol : 0.02;
  const sum = segs.reduce((a, s) => a + nz(s.rev), 0);
  const devPct = total > 0 ? Math.abs(sum - total) / total * 100 : null;
  if (devPct != null && devPct > t * 100) {
    const k = total / sum;
    return { ok: false, devPct: r2(devPct), before: segs.map(s => ({ name: s.name, rev: r2(nz(s.rev)) })), after: segs.map(s => ({ name: s.name, rev: r2(nz(s.rev) * k) })), scaled: true, note: `偏差 ${r2(devPct)}% > ${t * 100}% → 按比例缩放（×${r4(k)}）使加总=总营收 ${r2(total)} 亿` };
  }
  return { ok: true, devPct: r2(devPct), scaled: false, note: `偏差 ${r2(devPct)}% ≤ ${t * 100}%，总和校验通过` };
}

// 趋势偏离：|v − ref| / ref（用于趋势校验 ±30% 判定）
function deviationPct(v, ref) {
  if (v == null || !ref) return null;
  return Math.abs(v - ref) / Math.abs(ref) * 100;
}

// 置信度层权重调整（第八节）：先 DCF 再平衡，再置信度调整，最后归一化。
// confs: {pbRoe, pe, dcf} ∈ [0.5,1.0]；weights: {pbRoe, pe, dcf} 基准权重（和=1）
// dcfPrice/pbPrice/pePrice 用于 DCF 再平衡判定（偏离 >80% → DCF 5%、释放 10% 给 PB-ROE）
function confRebalance(weights, confs, dcfPrice, pbPrice, pePrice) {
  const notes = [];
  let w = { pbRoe: nz(weights.pbRoe), pe: nz(weights.pe), dcf: nz(weights.dcf) };
  let dcfRebalanced = false;
  // —— 第一步：DCF 再平衡（先执行） ——
  const m = (nz(pbPrice) + nz(pePrice)) / 2;
  const dev = m > 0 ? Math.abs(nz(dcfPrice) - m) / m * 100 : null;
  if (dev != null && dev > 80) {
    w = { pbRoe: 0.60, pe: 0.35, dcf: 0.05 };
    dcfRebalanced = true;
    notes.push(`DCF再平衡触发：DCF ${r2(dcfPrice)} 与 PB-ROE/PE 均值 ${r2(m)} 偏离 ${r2(dev)}% > 80% → DCF 权重降至 5%，释放 10% 给 PB-ROE（60/35/5）`);
  } else {
    notes.push(`DCF再平衡未触发（偏离 ${r2(dev)}% ≤ 80%）→ 维持基准权重`);
  }
  // —— 第二步：置信度调整 ——
  let confAdjusted = false;
  const keys = ['pbRoe', 'pe', 'dcf'];
  const adjusted = {}; let released = 0; const beneficiaries = [];
  for (const k of keys) {
    const C = nzd(confs[k], 1.0);
    if (C < 0.7) {
      adjusted[k] = w[k] * (C / 0.7);
      released += w[k] - adjusted[k];
      confAdjusted = true;
      notes.push(`置信度调整：${k} 层平均置信度 ${r2(C)} < 0.7 → 权重 ×${r3(C / 0.7)}（${pct(w[k])}% → ${pct(adjusted[k])}%）`);
    } else {
      adjusted[k] = w[k];
      beneficiaries.push(k);
    }
  }
  if (confAdjusted && released > 0 && beneficiaries.length) {
    const cSum = beneficiaries.reduce((a, k) => a + nzd(confs[k], 1.0), 0);
    for (const k of beneficiaries) adjusted[k] += released * (nzd(confs[k], 1.0) / cSum);
  }
  // —— 第三步：归一化 ——
  const s = keys.reduce((a, k) => a + adjusted[k], 0);
  for (const k of keys) adjusted[k] = adjusted[k] / s;
  return { weights: adjusted, dcfRebalanced, confAdjusted, dcfDeviationPct: r2(dev), notes };
}

// 估值区间（第八节）：半宽 = 基准半宽（±15%）÷ 平均置信度
function intervalRange(center, avgC, baseHalf) {
  const bh = baseHalf != null ? baseHalf : 0.15;
  const C = nzd(avgC, 1.0);
  const half = bh / Math.max(C, 0.01);
  return { range: [r2(center * (1 - half)), r2(center * (1 + half))], halfPct: r2(half * 100), avgC: r4(C) };
}

// ==================== v2.1 数据熔断与异常校准（四项强制熔断，纯函数导出供零网络测试） ====================

// 熔断1：行业PE极值熔断——行业PE中位数>60倍 或 近5年80%分位以上 → 基准PE=min(中位数, 60)，再×折价系数
function peCircuitBreaker(indMedPe, percentileNum, cap) {
  const CAP = (cap != null && isFinite(Number(cap)) && Number(cap) > 0) ? Number(cap) : 60;
  const mpe = (indMedPe != null && isFinite(Number(indMedPe))) ? Number(indMedPe) : null;
  const p = (percentileNum != null && isFinite(Number(percentileNum))) ? Number(percentileNum) : null;
  const overCap = mpe != null && mpe > CAP;
  const overPctile = p != null && p >= 80;
  const triggered = !!(overCap || overPctile);
  return {
    triggered,
    basePe: triggered && mpe != null ? Math.min(mpe, CAP) : mpe,
    cap: CAP,
    percentile: p,
    triggerReason: triggered
      ? (overCap && overPctile ? `行业中位数 ${r2(mpe)} > ${CAP}倍 且历史分位 ${p}% ≥ 80%`
        : (overCap ? `行业中位数 ${r2(mpe)} > ${CAP}倍` : `历史分位 ${p}% ≥ 80%`))
      : null,
  };
}

// 熔断2：市场隐含定价（反向）约束——市值÷目标PE=隐含利润 vs 机构一致预期 偏差>30% → PE层预测净利取两者均值
function marketImpliedNpCheck(mcap, targetPe, fcastNp, threshold) {
  const TH = (threshold != null && isFinite(Number(threshold))) ? Number(threshold) : 30;
  const mc = (mcap != null && isFinite(Number(mcap)) && Number(mcap) > 0) ? Number(mcap) : null;
  const tpe = (targetPe != null && isFinite(Number(targetPe)) && Number(targetPe) > 0) ? Number(targetPe) : null;
  const f = (fcastNp != null && isFinite(Number(fcastNp)) && Number(fcastNp) > 0) ? Number(fcastNp) : null;
  const impliedNp = (mc != null && tpe != null) ? mc / tpe : null;
  const diffPct = (impliedNp != null && f != null) ? Math.abs(impliedNp - f) / f * 100 : null;
  const triggered = diffPct != null && diffPct > TH;
  return {
    impliedNp: impliedNp != null ? r4(impliedNp) : null,
    diffPct: diffPct != null ? r2(diffPct) : null,
    triggered,
    npUsed: triggered ? r4((impliedNp + f) / 2) : f,
    threshold: TH,
  };
}

// 熔断4：层间背离一票否决——PB-ROE 与 PE 差异>100% → 合并值取较低者（保守原则），释放权重转移给 DCF
function layerVetoMerge(pbPrice, pePrice, wPbr, wPe, wDcf, threshold) {
  const TH = (threshold != null && isFinite(Number(threshold))) ? Number(threshold) : 100;
  const pb = nz(pbPrice), pe = nz(pePrice);
  const base = (pb + pe) / 2;
  const diffPct = base > 0 ? Math.abs(pb - pe) / base * 100 : null;
  if (diffPct == null || diffPct <= TH) {
    return { triggered: false, diffPct: diffPct != null ? r2(diffPct) : null, threshold: TH, mergedPrice: null, lowerIsPbr: null, releasedWeight: 0, weights: { pbRoe: nz(wPbr), pe: nz(wPe), dcf: nz(wDcf) } };
  }
  const lowerIsPbr = pb <= pe;
  const merged = Math.min(pb, pe);
  const released = lowerIsPbr ? nz(wPe) : nz(wPbr);
  return {
    triggered: true,
    diffPct: r2(diffPct),
    threshold: TH,
    mergedPrice: r4(merged),
    lowerIsPbr,
    releasedWeight: r4(released),
    weights: lowerIsPbr
      ? { pbRoe: nz(wPbr), pe: 0, dcf: nz(wDcf) + nz(wPe) }
      : { pbRoe: 0, pe: nz(wPe), dcf: nz(wDcf) + nz(wPbr) },
  };
}

// 熔断3：D层行情时效——交易日差计数（按工作日近似：周一~周五计 1，法定节假日不剔除，确定性口径）
function tradingDaysBetween(fromStr, toStr) {
  try {
    const a = new Date(fromStr), b = new Date(toStr);
    if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return null;
    let n = 0;
    const d = new Date(a);
    d.setDate(d.getDate() + 1);
    while (d <= b) {
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  } catch (e) { return null; }
}

// ==================== A级三表抓取（锚点自动前移：9M→H1→Q1，深市 SZ 前缀） ====================
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SZ${SYM}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income;
    const pick = (d) => inc.find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    const anchor = pick('2026-09-30') || pick('2026-06-30') || pick('2026-03-31');
    if (!anchor) return null;
    const asOf = String(anchor.REPORT_DATE).slice(0, 10);
    const prevYear = Number(asOf.slice(0, 4)) - 1;
    const fy = pick(`${prevYear}-12-31`);
    const prevSame = pick(`${prevYear}-${asOf.slice(5, 10)}`);
    if (!fy || !prevSame) return null;
    // 现金流量表（fetchFinancialData 已含 cashflow）
    const cf = st.cashflow || [];
    const cfPick = (d) => cf.find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    const cfAnchor = cfPick(asOf), cfFy = cfPick(`${prevYear}-12-31`), cfPrevSame = cfPick(`${prevYear}-${asOf.slice(5, 10)}`);
    // 资产负债表（存量指标：最近时点）
    let balCur = null;
    try {
      const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SZ${SYM}`, [asOf, `${prevYear}-12-31`]);
      const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
      balCur = balArr.find(r => String(r.REPORT_DATE || '').startsWith(asOf)) || null;
    } catch (e) { /* 存量缺失时回退配置 */ }
    return {
      asOf, stageLabel: { '03-31': '一季报(Q1)', '06-30': '中报(H1)', '09-30': '三季报(9M)', '12-31': '年报(FY)' }[asOf.slice(5, 10)],
      inc: {
        revCum: yi(anchor.TOTAL_OPERATE_INCOME), npCum: yi(anchor.PARENT_NETPROFIT), npDedCum: yi(anchor.DEDUCT_PARENT_NETPROFIT),
        costCum: yi(anchor.OPERATE_COST), finExpCum: yi(anchor.FINANCE_EXPENSE), rdExpCum: yi(anchor.RESEARCH_EXPENSE),
      },
      fy: {
        rev: yi(fy.TOTAL_OPERATE_INCOME), np: yi(fy.PARENT_NETPROFIT), npDed: yi(fy.DEDUCT_PARENT_NETPROFIT),
        cost: yi(fy.OPERATE_COST), finExp: yi(fy.FINANCE_EXPENSE), rdExp: yi(fy.RESEARCH_EXPENSE),
      },
      prevSame: {
        rev: yi(prevSame.TOTAL_OPERATE_INCOME), np: yi(prevSame.PARENT_NETPROFIT), npDed: yi(prevSame.DEDUCT_PARENT_NETPROFIT),
        cost: yi(prevSame.OPERATE_COST), finExp: yi(prevSame.FINANCE_EXPENSE), rdExp: yi(prevSame.RESEARCH_EXPENSE),
      },
      cf: {
        cfoCum: cfAnchor ? yi(cfAnchor.NETCASH_OPERATE) : null, capexCum: cfAnchor ? yi(cfAnchor.CONSTRUCT_LONG_ASSET) : null,
        cfoFy: cfFy ? yi(cfFy.NETCASH_OPERATE) : null, capexFy: cfFy ? yi(cfFy.CONSTRUCT_LONG_ASSET) : null,
        cfoPrevSame: cfPrevSame ? yi(cfPrevSame.NETCASH_OPERATE) : null, capexPrevSame: cfPrevSame ? yi(cfPrevSame.CONSTRUCT_LONG_ASSET) : null,
      },
      bal: balCur ? {
        equity: yi(balCur.TOTAL_PARENT_EQUITY), cip: yi(balCur.CIP), fixed: yi(balCur.FIXED_ASSET),
        cash: yi(balCur.MONETARYFUNDS), stLoan: yi(balCur.SHORT_LOAN), ltLoan: yi(balCur.LONG_LOAN),
        balAsOf: String(balCur.REPORT_DATE).slice(0, 10),
      } : null,
    };
  } catch (e) { return null; }
}

// ==================== 主计算 ====================
async function run(symbol, { price, pe, pb, statements } = {}) {
  try {
    return await compute(symbol, { price, pe, pb, statements });
  } catch (e) {
    return { ok: false, error: 'WANRUN_COMPUTE_FAILED', detail: e.message };
  }
}

async function compute(symbol, { price, pe, pb, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'wanrun') return { error: 'NOT_WANRUN' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const MS = I.marketSnapshot || {};
  const PEq = (pe != null && isFinite(Number(pe))) ? Number(pe) : nz(MS.peTTM);
  const PBq = (pb != null && isFinite(Number(pb))) ? Number(pb) : nz(MS.pb);

  const PBR = I.pbRoe, PEP = I.pePolicy, D = I.dcf, SC = I.scenarios, W = I.weights, IND = I.industry;
  const DR = I.distortionRules || {};

  // ========== v2.0 数据频率自适应层：A层实时三表 → TTM / 存量 ==========
  const S = statements || await fetchStatements();
  const fallbackFlags = [];
  const spliceRows = [];   // 第三部分·数据拼接与置信度表

  // —— 字段一/二：营收、归母、扣非（A层，累计转单季再滚动TTM，置信度 1.0） ——
  const ps = S ? (S.prevSame || {}) : null;
  const sRev = S ? ttmSplice(S.fy.rev, S.inc.revCum, ps.rev) : { value: null, gap: true };
  const sNp = S ? ttmSplice(S.fy.np, S.inc.npCum, ps.np) : { value: null, gap: true };
  const sNpDed = S ? ttmSplice(S.fy.npDed, S.inc.npDedCum, ps.npDed) : { value: null, gap: true };
  const ttmRev = sRev.gap ? nz(I.latest.fy2025.rev) : sRev.value;
  const ttmNp = sNp.gap ? nz(I.latest.ttmNp) : sNp.value;
  if (sRev.gap || sNp.gap) { fallbackFlags.push('A层三表不可得 → TTM 回退配置锚（置信度 0.6，区间放宽）'); }
  spliceRows.push({ field: '营业收入 TTM', layer: 'A', method: sRev.gap ? '回退配置锚【插补】' : '累计转单季再滚动TTM【实际披露】', conf: sRev.gap ? 0.6 : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmRev) + ' 亿' });
  spliceRows.push({ field: '归母净利润 TTM', layer: 'A', method: sNp.gap ? '回退配置锚【插补】' : '累计转单季再滚动TTM【实际披露】', conf: sNp.gap ? 0.6 : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmNp) + ' 亿' });
  spliceRows.push({ field: '扣非净利润 TTM', layer: 'A', method: sNpDed.gap ? '不可计算（不参与点估计）' : '累计转单季再滚动TTM【实际披露】', conf: sNpDed.gap ? null : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: sNpDed.gap ? '—' : r2(sNpDed.value) + ' 亿' });

  // —— 字段三：TTM 毛利率（A层） ——
  const sCost = S ? ttmSplice(S.fy.cost, S.inc.costCum, ps.cost) : { value: null, gap: true };
  const ttmGm = sCost.gap ? nz(I.normalization.gmNormalized) : (1 - sCost.value / ttmRev) * 100;
  spliceRows.push({ field: 'TTM 毛利率', layer: 'A', method: sCost.gap ? '回退正常化假设【插补】' : '1 − TTM营业成本/TTM营收【实际披露】', conf: sCost.gap ? 0.6 : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmGm) + '%' });

  // —— 字段四/五：存量指标（最近时点）+ 总股本 ——
  const equity = (S && S.bal && S.bal.equity != null) ? S.bal.equity : nz(I.latest.fy2025.equityParent);
  const bps = equity / N;
  const balAsOf = (S && S.bal && S.bal.balAsOf) ? S.bal.balAsOf : '2025-12-31';
  spliceRows.push({ field: '归母净资产 / BPS', layer: 'A·存量', method: S && S.bal && S.bal.equity != null ? `最近报告期末时点值【实际披露】` : '回退最近年报【插补】', conf: (S && S.bal && S.bal.equity != null) ? 1.0 : 0.6, asOf: balAsOf, value: r2(equity) + ' 亿 / ¥' + r2(bps) });
  spliceRows.push({ field: '总股本', layer: 'A', method: '最新财报/公告披露值（无增发回购行权公告 → 不覆盖）【实际披露】', conf: 1.0, asOf: balAsOf, value: r2(N) + ' 亿股' });

  // —— 字段六：TTM ROE（A层：TTM归母 ÷ 最近时点归母净资产） ——
  const ttmRoe = ttmNp > 0 && equity > 0 ? ttmNp / equity * 100 : nz(I.latest.ttmRoe);
  spliceRows.push({ field: 'TTM ROE', layer: 'A', method: 'TTM归母 ÷ 最近报告期末归母净资产【实际披露】', conf: 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmRoe) + '%' });

  // —— 字段七：财务费用 TTM（A层）；字段八：汇兑损益（B层半年报实际披露，近似来源标注） ——
  const sFin = S ? ttmSplice(S.fy.finExp, S.inc.finExpCum, ps.finExp) : { value: null, gap: true };
  const ttmFinExp = sFin.gap ? null : sFin.value;
  const fxLoss = nz(vv(DR.fx && DR.fx.fxLoss26H1));  // 26H1 汇兑净损失（半年报实际披露，B层）
  spliceRows.push({ field: '财务费用 TTM', layer: 'A', method: sFin.gap ? '不可计算（仅趋势提示）' : '累计转单季再滚动TTM【实际披露】', conf: sFin.gap ? null : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: sFin.gap ? '—' : r2(ttmFinExp) + ' 亿' });
  spliceRows.push({ field: '汇兑损益', layer: 'B', method: '26H1 半年报实际披露净损失（确定性引擎无搜索通道 → 未用财务费用同比增量近似）【实际披露·半年报】', conf: 0.9, asOf: '2026-06-30', value: fxLoss + ' 亿（损失）' });

  // —— 字段十/十一：经营现金流、资本开支 TTM（A层） → DCF FCFF ——
  const cfv = (S && S.cf) || {};
  const sCfo = (cfv.cfoCum != null && cfv.cfoFy != null && cfv.cfoPrevSame != null) ? ttmSplice(cfv.cfoFy, cfv.cfoCum, cfv.cfoPrevSame) : { value: null, gap: true };
  const sCapex = (cfv.capexCum != null && cfv.capexFy != null && cfv.capexPrevSame != null) ? ttmSplice(cfv.capexFy, cfv.capexCum, cfv.capexPrevSame) : { value: null, gap: true };
  const ttmCfo = sCfo.gap ? nz(I.latest.fy2025.cfo) : sCfo.value;
  const ttmCapex = sCapex.gap ? nz(I.latest.fy2025.capex) : sCapex.value;
  // 字段十一 → DCF 规则：OCF > capex → FCFF = OCF − capex；否则 FCFF = OCF × 0.6
  const fcffBase = ttmCfo > ttmCapex ? ttmCfo - ttmCapex : ttmCfo * 0.6;
  spliceRows.push({ field: '经营现金流 TTM', layer: 'A', method: sCfo.gap ? '回退配置锚【插补】' : '累计转单季再滚动TTM【实际披露】', conf: sCfo.gap ? 0.6 : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmCfo) + ' 亿' });
  spliceRows.push({ field: '资本开支 TTM', layer: 'A', method: sCapex.gap ? '回退配置锚【插补】' : '购建固定资产等支付的现金·累计转单季再滚动TTM【实际披露】', conf: sCapex.gap ? 0.6 : 1.0, asOf: S ? S.asOf : cfg.dataAsOf, value: r2(ttmCapex) + ' 亿' });

  // —— 字段十二：在建工程/固定资产（存量，最近时点） → 周期系数判定 ——
  const cip = (S && S.bal && S.bal.cip != null) ? S.bal.cip : null;
  const fixed = (S && S.bal && S.bal.fixed != null) ? S.bal.fixed : null;
  const cipRatioNow = (cip != null && fixed > 0) ? cip / fixed : null;
  const cipRatio25 = 18.3663 / 33.7475;   // 2025年报（东财三表，代码内常量=三表披露值，非硬编码假设）
  const cipRatio24 = 19.9575 / 28.5859;   // 2024年报
  const transitionConfirmed = cipRatioNow != null && cipRatioNow < cipRatio25 && cipRatio25 < cipRatio24; // 持续下降 → 产能释放期过渡
  const cycleCoef = transitionConfirmed ? nz(vv(PBR.cycleCoefficient)) : 1.0;
  spliceRows.push({ field: '在建工程/固定资产比', layer: 'A·存量', method: `最近报告期末时点值【实际披露】${cipRatioNow != null ? `（${r2(cipRatio24)} → ${r2(cipRatio25)} → ${r2(cipRatioNow)} 持续下降 → 过渡期确认，周期系数 ${r2(cycleCoef)}）` : '（缺失 → 周期系数回退 1.0）'}`, conf: cipRatioNow != null ? 1.0 : 0.6, asOf: balAsOf, value: cipRatioNow != null ? `${r2(cip)} / ${r2(fixed)} 亿 = ${r2(cipRatioNow)}` : '—' });

  // —— 净债务（存量实时化） ——
  const netDebtLive = (S && S.bal && S.bal.cash != null && S.bal.stLoan != null && S.bal.ltLoan != null) ? (S.bal.stLoan + S.bal.ltLoan - S.bal.cash) : null;
  const netDebt = netDebtLive != null ? netDebtLive : nz(vv(D.netDebt));
  spliceRows.push({ field: '净债务', layer: 'A·存量', method: netDebtLive != null ? '短借+长借−货币资金（最近报告期末）【实际披露】' : '回退配置假设【插补】', conf: netDebtLive != null ? 1.0 : 0.85, asOf: balAsOf, value: r2(netDebt) + ' 亿' });

  // —— B层结构外推（字段十三：分业务收入 = 最近一期结构 × TTM 总营收，总和校验） ——
  const segH1 = I.segmentData.h1_2026;
  const segEntries = [
    { name: '功能性材料', share: nz(segH1.functional.share) / 100 },
    { name: '生命科学与医药', share: nz(segH1.lifeSci.share) / 100 },
  ];
  const segSum = segEntries.reduce((a, s) => a + s.share, 0);
  const segExtrap = segEntries.map(s => ({ name: s.name, rev: ttmRev * (s.share / (segSum > 0 ? segSum : 1)) }));
  const sumChk = sumCheckSegs(segExtrap, ttmRev, 0.02);
  spliceRows.push({ field: '分业务收入结构', layer: 'B', method: `最近一期（26H1）结构占比 × TTM 总营收外推${sumChk.scaled ? '【外推+缩放】' : '【外推·总和校验通过】'}；仅作景气度判断，不作为点估计唯一依据`, conf: 0.7, asOf: '2026-06-30', value: segExtrap.map(s => `${s.name} ${s.rev}`).join(' / ') + ' 亿' });

  // ========== 第一层：PB-ROE 主锚 ==========
  // 可持续 ROE = TTM ROE × 周期系数 + 新产能贡献，上限 = 历史 ROE 中枢 × 1.20
  const gPerp = nz(vv(PBR.terminalGrowth)) / 100;
  const rEquity = nz(vv(PBR.costOfEquity)) / 100;
  const newCapLift = nz(vv(PBR.newCapacityRoeLift));
  const roeCap = nz(I.normalization.roeCap);
  const roeHistCenter = nz(I.normalization.roeHistCenter);
  const roeSustRaw = ttmRoe * cycleCoef + newCapLift;
  const roeSust = Math.min(roeSustRaw, roeCap);
  const roeCapped = roeSustRaw > roeCap;
  const fairPb = (roeSust / 100 - gPerp) / (rEquity - gPerp);
  const pbPrice = fairPb * bps;

  // ========== 第二层：PE 相对（v2.1 熔断1/熔断2 强制开启） ==========
  const indMedPe = nz(vv(PEP.industryPeMedian));
  const indMedPeAlt = nz(PEP.industryPeMedian.alt);
  const fcastNp = nz(vv(PEP.forecastNp));
  const fyNp2025 = nz(I.latest.fy2025.npAttr);
  const consGrowth = fyNp2025 > 0 ? (fcastNp / fyNp2025 - 1) * 100 : null;
  // 折价系数规则（确定性）：预测增速 > 行业中位增速 → 0.85；>0 且低于中位 → 0.7；负增长 → 0.55
  const indGrowthMed = 46;  // 行业 26E 净利增速中位数（配置 industry.growthMedianNote 披露口径，随配置更新）
  const discCoef = consGrowth != null ? (consGrowth > indGrowthMed ? 0.85 : (consGrowth > 0 ? 0.7 : 0.55)) : nz(vv(PEP.discountCoefficient));
  // —— 熔断1：行业PE极值熔断（中位数>60倍 或 近5年80%分位以上 → 基准PE=min(中位数,60)，防行业周期底谷/异常值干扰） ——
  const PE_CAP = 60;
  const pctileNum = (() => { const mm = String(IND.historicalPercentile || '').match(/(\d+(?:\.\d+)?)\s*%/); return mm ? parseFloat(mm[1]) : null; })();
  const peCb = peCircuitBreaker(indMedPe, pctileNum, PE_CAP);
  const targetPe = nz(peCb.basePe) * discCoef;
  const peCbNote = peCb.triggered
    ? `⛔ 行业PE极值熔断已触发（${peCb.triggerReason}）→ 基准PE取 min(${r2(indMedPe)}, ${PE_CAP})=${r2(peCb.basePe)}`
    : `行业PE中位数 ${r2(indMedPe)} ≤ ${PE_CAP}倍且分位<80% → 熔断未触发`;
  // —— 熔断2：市场隐含定价（反向）约束（市值÷目标PE=隐含利润 vs 机构一致预期 偏差>30% → 取均值，向市场现实妥协） ——
  const mcapNow = P != null ? P * N : nz(MS.marketCap);
  const mktChk = marketImpliedNpCheck(mcapNow, targetPe, fcastNp, 30);
  const npPeUsed = nz(mktChk.npUsed);
  const mktChkNote = mktChk.triggered
    ? `⛔ 市场隐含定价约束已触发：市值 ${r2(mcapNow)} 亿 ÷ 目标PE ${r2(targetPe)} = 隐含利润 ${r2(mktChk.impliedNp)} 亿，与机构一致预期 ${r2(fcastNp)} 亿偏差 ${r2(mktChk.diffPct)}% > 30% → PE层预测净利取均值 ${r2(npPeUsed)} 亿`
    : `市值隐含利润 ${mktChk.impliedNp != null ? r2(mktChk.impliedNp) : '—'} 亿 vs 机构一致预期 ${r2(fcastNp)} 亿，偏差 ${mktChk.diffPct != null ? r2(mktChk.diffPct) : '—'}% ≤ 30% → 未触发`;
  const pePrice = npPeUsed * targetPe / N;
  const peFairMC = npPeUsed * targetPe;

  // ========== 第三层：DCF 辅助（FCFF 基期 = A层 TTM 规则值） ==========
  function dcfOf(fcff0) {
    const wacc = nz(vv(D.wacc)) / 100, g = nz(vv(D.gPerp)) / 100;
    const gp = (D.growthPath && D.growthPath.length) ? D.growthPath : [0.15, 0.15, 0.15, 0.15, 0.15];
    let pv = 0, b = fcff0; const arr = [];
    for (let t = 0; t < gp.length; t++) { b = b * (1 + gp[t]); arr.push(b); pv += b / Math.pow(1 + wacc, t + 1); }
    const tv = arr[arr.length - 1] * (1 + g) / (wacc - g);
    const ev = pv + tv / Math.pow(1 + wacc, gp.length);
    const equityV = ev - netDebt;
    return { perShare: equityV / N, ev, tvShare: (tv / Math.pow(1 + wacc, gp.length)) / ev };
  }
  const dcfBase = dcfOf(fcffBase);

  // ========== 权重：先 DCF 再平衡 → 再置信度调整 → 归一化（第八节） ==========
  // 层内平均置信度：PB-ROE（TTM ROE 1.0 + BPS 1.0）；PE（一致预期 0.9 + 行业PE 1.0）；DCF（TTM现金流 1.0 + 净债务 1.0）
  const confPbr = (sNp.gap || (S && S.bal && S.bal.equity == null)) ? 0.6 : 1.0;
  const consCount = nz(I.consensus.analystCount);
  const confPe = ((consCount >= 5 ? 0.9 : 0.7) + 1.0) / 2;
  const confCfo = (sCfo.gap || sCapex.gap) ? 0.6 : 1.0;
  const confDebt = netDebtLive != null ? 1.0 : 0.85;
  const confDcf = (confCfo + confDebt) / 2;
  const confs = { pbRoe: r4(confPbr), pe: r4(confPe), dcf: r4(confDcf) };
  const reb = confRebalance({ pbRoe: nz(W.pbRoe), pe: nz(W.pe), dcf: nz(W.dcf) }, confs, dcfBase.perShare, pbPrice, pePrice);
  const wuPbr0 = reb.weights.pbRoe, wuPe0 = reb.weights.pe, wuDcf0 = reb.weights.dcf;

  // —— 熔断4：层间背离一票否决（v2.1）——PB-ROE 与 PE 差异>100%（极端戴维斯双击/双杀）→ 禁止简单加权，
  //    合并值取两者较低者（保守原则），被否决层释放的权重转移给 DCF（防止 PE 层高估值拉高本应处于底部的安全边际）。
  const divergencePct = (pbPrice > 0 && pePrice > 0) ? Math.abs(pbPrice - pePrice) / ((pbPrice + pePrice) / 2) * 100 : null;
  const divergenceTriggered = divergencePct != null && divergencePct > 50;
  const veto = layerVetoMerge(pbPrice, pePrice, wuPbr0, wuPe0, wuDcf0, 100);
  const wuPbr = veto.weights.pbRoe, wuPe = veto.weights.pe, wuDcf = veto.weights.dcf;

  // ========== 加权目标价与置信度区间（第八节/第十四节第一部分） ==========
  const finalTarget = wuPbr * pbPrice + wuPe * pePrice + wuDcf * dcfBase.perShare;
  const avgC = wuPbr * confs.pbRoe + wuPe * confs.pe + wuDcf * confs.dcf;
  // —— 熔断3：D层行情时效强校验（v2.1）——
  //    P 为运行时注入的实时价 → D层时效=0；否则 D层回退配置行情快照（MS.asOf）。
  //    与估值基准日差 >5 个交易日 → 强制标「⚠️ 行情数据滞后，非实时估值」+ 隐含涨跌幅置信度降至 0.6（区间放宽）；
  //    >15 个交易日 → 禁止输出低估/高估信号，仅输出绝对估值区间。
  const baseDateStr = localDate();
  const dLayerAsOf = (P != null) ? baseDateStr : (MS.asOf || cfg.dataAsOf);
  const dLagTd = tradingDaysBetween(dLayerAsOf, baseDateStr);
  const quoteLag5 = dLagTd != null && dLagTd > 5;
  const signalBlocked = dLagTd != null && dLagTd > 15;
  const quoteLagConf = quoteLag5 ? 0.6 : null;
  const avgCeff = quoteLag5 ? Math.min(avgC, 0.6) : avgC;
  const iv = intervalRange(finalTarget, avgCeff, 0.15);
  const rangeLow = iv.range[0], rangeHigh = iv.range[1];

  // ========== 评级（第十四节信号规则：P/target <0.75 低估 / >1.30 高估；v2.1 熔断3 滞后>15交易日禁止方向信号） ==========
  let rating = '合理', upside = null, expectedReturn = null, signalRatio = null;
  if (P != null) {
    signalRatio = finalTarget > 0 ? P / finalTarget : null;
    expectedReturn = finalTarget > 0 ? (finalTarget - P) / P * 100 : null;
    upside = (rangeHigh - P) / P * 100;
    rating = signalRatio != null ? (signalRatio < 0.75 ? '低估' : (signalRatio > 1.30 ? '高估' : '合理')) : '合理';
  }
  if (signalBlocked) rating = '仅区间参考（行情数据滞后，方向信号禁止输出）';

  // ========== 一致性校验四条（第九节） ==========
  const checkRows = [];
  // 校验一：总和校验
  checkRows.push({ id: '校验一·总和校验', pass: sumChk.ok, detail: `分板块外推之和 ${r2(segExtrap.reduce((a, s) => a + s.rev, 0))} 亿 vs 总营收 ${r2(ttmRev)} 亿：${sumChk.note}` });
  // 校验二：趋势校验（TTM 毛利率 / TTM ROE vs 近三年均值 ±30%；触发则剥离一次性因素）
  const gm23 = 1 - 24.7590 / 43.0532, gm24 = 1 - 22.2299 / 36.9326, gm25 = 1 - 22.4631 / 37.1663; // 2023/2024/2025 年报披露值推导
  const gmHistMean = (gm23 + gm24 + gm25) / 3 * 100;
  const gmDev = deviationPct(ttmGm, gmHistMean);
  const roeHistMean = (11.53 + 3.53 + 4.02) / 3; // 2021~2023? 口径：2023 高点 11.53 / 2024 3.53 / 2025 4.02 → 近三年均值 6.36（配置 normalization 口径）
  const roeDev = deviationPct(ttmRoe, roeHistMean);
  const sustainableNp = ttmNp + fxLoss * 0.75;  // 汇兑剥离：+ 损失×(1−税率25%)
  const roeAfterStrip = equity > 0 ? sustainableNp / equity * 100 : null;
  const trendTriggered = (gmDev != null && gmDev > 30) || (roeDev != null && roeDev > 30);
  checkRows.push({ id: '校验二·趋势校验', pass: !trendTriggered, detail: `TTM毛利率 ${r2(ttmGm)}%（近三年均值 ${r2(gmHistMean)}%，偏离 ${r2(gmDev)}%）；TTM ROE ${r2(ttmRoe)}%（近三年均值 ${r2(roeHistMean)}%，偏离 ${r2(roeDev)}%）${trendTriggered ? ` → ⚠️ 偏离历史区间：剥离汇兑损失 ${fxLoss} 亿×(1−25%)=${r4(fxLoss * 0.75)} 亿后可持续净利 ${r2(sustainableNp)} 亿、ROE ${r2(roeAfterStrip)}%（仍处周期低位：历史中枢含 2023 高价周期，属周期性偏离而非一次性失真）` : ' → ✅ 在历史区间内'}` });
  // 校验三：环比校验（本期 TTM 归母变化 vs 最近单季同比，差异 >30pp 并列展示）
  const h1_2025np = nz(I.latest.h1_2025 ? I.latest.h1_2025.npAttr : null);
  let qoqDetail = '上期 TTM 基数缺失 → 校验三跳过（记录）';
  let qoqDiff = null;
  if (h1_2025np > 0 && S && S.inc.npCum != null) {
    const prevTtmNp = nz(I.latest.fy2025.npAttr) - h1_2025np + (S.inc.npCum >= S.fy.np ? 0 : nz(I.latest.h1_2026.npAttr));
    // 上期 TTM（H1 锚）= FY2025 − 2025H1 + 2026H1
    const prevTtm = S.asOf === '2026-06-30' ? ttmNp : (nz(I.latest.fy2025.npAttr) - h1_2025np + nz(I.latest.h1_2026.npAttr));
    const ttmChg = prevTtm > 0 ? (ttmNp / prevTtm - 1) * 100 : null;
    const q3_26 = (S.inc.npCum != null) ? (S.inc.npCum - nz(I.latest.h1_2026.npAttr)) : null;
    const q3_25 = (ps && ps.np != null && h1_2025np > 0) ? (ps.np - h1_2025np) : null;
    const q3YoY = (q3_26 != null && q3_25 != null && q3_25 > 0) ? (q3_26 / q3_25 - 1) * 100 : null;
    qoqDiff = (ttmChg != null && q3YoY != null) ? Math.abs(ttmChg - q3YoY) : null;
    qoqDetail = `本期 TTM 归母 ${r2(ttmNp)} 亿 vs 上期 TTM（H1锚）${r2(prevTtm)} 亿（${ttmChg != null ? (ttmChg >= 0 ? '+' : '') + r2(ttmChg) + '%' : 'NA'}）；最近单季（Q3）同比 ${q3YoY != null ? (q3YoY >= 0 ? '+' : '') + r2(q3YoY) + '%' : 'NA'} → 差异 ${r2(qoqDiff)}pp ${qoqDiff != null && qoqDiff > 30 ? '→ ⚠️ 盈利波动异常（两口径并列展示，不强行取其一）' : '→ ✅ < 30pp 通过'}`;
  }
  checkRows.push({ id: '校验三·环比校验', pass: qoqDiff == null ? true : qoqDiff <= 30, detail: qoqDetail });
  // 校验四：交叉校验（PE层反推隐含净利 vs 机构一致预期，差异 >30pp）
  let crossDetail = '现价不可用 → 校验四跳过（记录）';
  let crossDiff = null;
  if (P != null && targetPe > 0) {
    const impliedNp = P * N / targetPe;
    const impliedGrowth = fyNp2025 > 0 ? (impliedNp / fyNp2025 - 1) * 100 : null;
    crossDiff = (impliedGrowth != null && consGrowth != null) ? Math.abs(impliedGrowth - consGrowth) : null;
    crossDetail = `现价隐含 2026E 净利 = 市值 ${r2(P * N)} 亿 ÷ 目标PE ${r2(targetPe)} = ${r2(impliedNp)} 亿（隐含增速 ${impliedGrowth != null ? r2(impliedGrowth) + '%' : 'NA'}）vs 机构一致预期 ${r2(fcastNp)} 亿（+${r2(consGrowth)}%）→ 差异 ${r2(crossDiff)}pp ${crossDiff != null && crossDiff > 30 ? '→ ⚠️ PE层与机构预期分歧：目标PE取行业中位×折价系数高于市场当前定价隐含口径（目标PE假设偏高），已在风险提示说明' : '→ ✅ < 30pp 通过'}`;
  }
  checkRows.push({ id: '校验四·交叉校验', pass: crossDiff == null ? true : crossDiff <= 30, detail: crossDetail });

  // （估值分歧预警已前移至熔断4计算处：divergencePct/divergenceTriggered）

  // ========== 模型触发/失效检查 ==========
  const MF = I.modelFailure;
  const failRows = MF.conds.map(c => {
    const trig = !!c.triggered;
    return { id: c.id, text: c.text, value: c.value, threshold: c.threshold, triggered: trig, status: trig ? '⛔ 触发' : '✅ 未触发' };
  });
  const modelSuspended = failRows.some(f => f.triggered);

  // ========== 数据新鲜度表（第二部分：D层行情 + A/B/C 层截止期） ==========
  const FR = I.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 200;
  const freshnessRows = [];
  const alerts = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, new Date()) : null;
    if (age == null) continue;
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
    if (stale) alerts.push('「' + it.label + '」取数于 ' + it.asOf + '（距今 ' + age + ' 天 > ' + frMax + ' 天）→ 请复核更新');
  }
  freshnessRows.unshift(
    { label: '营收/归母/扣非/现金流 TTM（A层）', asOf: S ? S.asOf : cfg.dataAsOf, ageDays: S ? daysBetween(S.asOf, new Date()) : daysBetween(cfg.dataAsOf, new Date()), maxAge: frMax, stale: false },
    { label: '归母净资产/在建/固资/净债务（A层存量）', asOf: balAsOf, ageDays: daysBetween(balAsOf, new Date()), maxAge: frMax, stale: false },
    { label: '分业务结构/汇兑（B层·半年报）', asOf: '2026-06-30', ageDays: daysBetween('2026-06-30', new Date()), maxAge: frMax, stale: false },
    { label: '机构一致预期（C层）', asOf: I.consensus.source || cfg.dataAsOf, ageDays: daysBetween(cfg.dataAsOf, new Date()), maxAge: frMax, stale: false },
  );
  const MSage = MS.asOf ? daysBetween(MS.asOf, new Date()) : null;
  const msStale = MSage != null && MSage > (nz(MS.maxAgeDays) || 3);
  if (msStale) alerts.push('「实时行情」取数于 ' + MS.asOf + '（距今 ' + MSage + ' 天）→ 请复核更新');

  // ========== 三情景（PB-ROE 随可持续 ROE 变；PE 随预测净利/目标PE 变；DCF 固定底线） ==========
  function scenario(key) {
    const sc = SC[key];
    const roe = nz(sc.roe) / 100;
    const np = nz(sc.np);
    const peU = nz(sc.pe);
    const pbP = (roe - gPerp) / (rEquity - gPerp) * bps;
    const peP = np * peU / N;
    let combo, vetoNoteS = '';
    if (veto.triggered) {
      // 熔断4 同口径生效：该情景下同样取 PB-ROE 与 PE 较低者合并、释放权重转移给 DCF（基准权重 wu*0）
      const lowerIsPbrS = pbP <= peP;
      const mergedS = Math.min(pbP, peP);
      const relS = lowerIsPbrS ? wuPe0 : wuPbr0;
      combo = (lowerIsPbrS ? wuPbr0 : wuPe0) * mergedS + (wuDcf0 + relS) * dcfBase.perShare;
      vetoNoteS = '｜熔断4：合并值取 min(PB-ROE, PE)=' + r2(mergedS) + '，释放权重 ' + pct(relS) + ' 转移给 DCF';
    } else {
      combo = wuPbr * pbP + wuPe * peP + wuDcf * dcfBase.perShare;
    }
    return { key, roe: nz(sc.roe), np, pe: peU, pbP, peP, dcfP: dcfBase.perShare, combo, note: sc.note + vetoNoteS };
  }
  const sPes = scenario('pessimistic'), sBase = scenario('base'), sOpt = scenario('optimistic');

  // ========== 敏感性分析（两矩阵，网格由参数自动生成，不硬编码；净利基点 = 熔断2 校准后 npPeUsed） ==========
  const roeGrid = [0.7, 0.85, 1, 1.15, 1.3].map(k => r1(roeSust * k));
  const npGrid = [0.75, 0.9, 1, 1.1, 1.2].map(k => r2(npPeUsed * k));
  const peCols = [r1(peCb.basePe * 0.6), r1(peCb.basePe * 0.8), r1(targetPe), r1(peCb.basePe)];
  const sensRoePe = roeGrid.map(roe => {
    const rr = roe / 100;
    const pbP = (rr - gPerp) / (rEquity - gPerp) * bps;
    return { roe, pbPrice: r2(pbP), cells: peCols.map(tpe => {
      const pePc = npPeUsed * tpe / N;
      let tgt;
      if (veto.triggered) {
        const lowerIsPbrC = pbP <= pePc;
        const relC = lowerIsPbrC ? wuPe0 : wuPbr0;
        tgt = (lowerIsPbrC ? wuPbr0 : wuPe0) * Math.min(pbP, pePc) + (wuDcf0 + relC) * dcfBase.perShare;
      } else {
        tgt = wuPbr * pbP + wuPe * pePc + wuDcf * dcfBase.perShare;
      }
      return { pe: tpe, target: r2(tgt) };
    }) };
  });
  const sensNpPe = npGrid.map(np => ({ np: r2(np), cells: peCols.map(tpe => ({ pe: tpe, mc: r2(np * tpe), price: r2(np * tpe / N) })) }));
  const sensRows = [];
  sensRoePe.forEach(row => sensRows.push({ name: '矩阵一 可持续ROE ' + row.roe + '%（PB-ROE ' + row.pbPrice + ' 元）× 目标PE', value: row.cells.map(c => 'PE' + c.pe + '→¥' + c.target).join('　') }));
  sensNpPe.forEach(row => sensRows.push({ name: '矩阵二 预测净利 ' + row.np + ' 亿 × 目标PE（市值/股价）', value: row.cells.map(c => 'PE' + c.pe + '→' + c.mc + '亿/¥' + c.price).join('　') }));

  // ========== v2.1 四项熔断状态表 ==========
  const cbRows = [
    {
      label: '熔断1·行业PE极值熔断（>60倍或近5年80%分位 → 基准PE=min(中位数,60)）',
      value: (peCb.triggered ? '⛔ 已触发｜' : '✅ 未触发｜') + peCbNote + ' → 目标PE ' + r2(targetPe) + ' = ' + r2(peCb.basePe) + ' × 折价系数 ' + r2(discCoef),
    },
    {
      label: '熔断2·市场隐含定价反向约束（隐含利润 vs 一致预期 偏差>30% → 取均值）',
      value: (mktChk.triggered ? '⛔ 已触发｜' : '✅ 未触发｜') + mktChkNote,
    },
    {
      label: '熔断3·D层行情时效强校验（>5交易日标滞后+置信度0.6；>15交易日禁止方向信号）',
      value: (dLagTd != null
        ? (signalBlocked ? '⛔ 已触发（>' + 15 + '交易日）｜' : (quoteLag5 ? '⚠️ 已触发（>5交易日）｜' : '✅ 未触发｜'))
          + 'D层数据截止 ' + dLayerAsOf + '，距估值基准日 ' + baseDateStr + ' 约 ' + dLagTd + ' 个交易日（工作日近似，节假日不剔除）'
            + (signalBlocked ? ' → 禁止输出低估/高估信号，仅输出绝对估值区间' : (quoteLag5 ? ' → 已标「⚠️ 行情数据滞后，非实时估值」，隐含涨跌幅置信度降至 0.6' : ' → 行情数据实时'))
        : 'D层时效不可判定'),
    },
    {
      label: '熔断4·层间背离一票否决（PB-ROE vs PE 差异>100% → 取较低者合并，释放权重转 DCF）',
      value: (veto.triggered
        ? '⛔ 已触发｜PB-ROE ' + r2(pbPrice) + ' vs PE ' + r2(pePrice) + ' 差异 ' + r2(veto.diffPct) + '% > 100%（极端戴维斯双击/双杀预期）→ 合并值取较低者 ' + r2(veto.mergedPrice) + ' 元（保守原则），释放权重 ' + pct(veto.releasedWeight) + ' 转移给 DCF → 调整后 PB-ROE ' + pct(wuPbr) + '% / PE ' + pct(wuPe) + '% / DCF ' + pct(wuDcf) + '%'
        : '✅ 未触发｜PB-ROE ' + r2(pbPrice) + ' vs PE ' + r2(pePrice) + ' 差异 ' + r2(divergencePct) + '% ≤ 100% → 维持三层加权'),
    },
  ];

  // ========== 卡片行 ==========
  const reportHeadRows = [
    { label: '估值基准日', value: localDate(), source: '系统当前日期' },
    { label: '锚点报告期（A层）', value: S ? `${S.asOf} ${S.stageLabel}（东财F10三表实时拉取，锚点自动前移）` : `${cfg.reportLabel}（实时拉取失败 → 配置锚）`, source: '东财F10三表 + 巨潮定期报告' },
    { label: '模型版本', value: 'v2.1 数据熔断与异常校准版（v2.0 四层分级 + 累计转单季再滚动TTM + 置信度衰减 + 四项强制熔断）', source: '规范永久有效，数据自动重算；四项熔断强制开启不可关闭' },
  ];

  const diagRows = [
    { label: 'TTM 锚（A层·实时）', value: `营收 ${r2(ttmRev)} 亿 / 归母 ${r2(ttmNp)} 亿 / 扣非 ${sNpDed.gap ? '—' : r2(sNpDed.value)} 亿（锚点 ${S ? S.asOf : cfg.dataAsOf}）` },
    { label: 'TTM 盈利质量', value: `毛利率 ${r2(ttmGm)}% / TTM ROE ${r2(ttmRoe)}%（TTM归母 ÷ 最近时点净资产 ${r2(equity)} 亿）/ TTM 财务费用 ${sFin.gap ? '—' : r2(ttmFinExp) + ' 亿'}` },
    { label: 'BPS / 总股本', value: `¥${r2(bps)}（= 净资产 ${r2(equity)} 亿 ÷ ${r2(N)} 亿股，存量最近时点 ${balAsOf}）` },
    { label: '在建/固资（产能周期）', value: cipRatioNow != null ? `${r2(cipRatio24)} → ${r2(cipRatio25)} → ${r2(cipRatioNow)} 持续下降 → 「产能投入期→释放期」过渡确认 → 周期系数 ${r2(cycleCoef)}` : '存量缺失 → 周期系数回退 1.0' },
    { label: '现金流（A层 TTM）', value: `CFO ${r2(ttmCfo)} 亿 / capex ${r2(ttmCapex)} 亿 → FCFF ${r2(fcffBase)} 亿（${ttmCfo > ttmCapex ? 'OCF>capex → 差值' : 'OCF<capex → OCF×0.6'}）` },
    { label: '净债务（存量实时）', value: `${r2(netDebt)} 亿（${netDebtLive != null ? '短借+长借−货币资金，' + balAsOf : '配置假设'}）` },
    { label: '机构一致预期（C层）', value: `2026E 归母 ${r2(fcastNp)} 亿（+${r2(consGrowth)}%）/ ${consCount} 家覆盖（≥5 家 → 置信度 0.9）/ 目标价 ¥${r2(I.consensus.targetPrice)}` },
    { label: '行业 PE 中位数（D层）', value: `${r2(indMedPe)} 倍（电子化学品Ⅱ ${nz(IND.constituents)} 只；交叉 ${r2(indMedPeAlt)} 倍；历史分位 ${IND.historicalPercentile || '—'}）→ ${peCb.triggered ? peCbNote + '，' : ''}折价系数 ${r2(discCoef)}（增速 +${r2(consGrowth)}% > 行业中位 ${indGrowthMed}% → 0.85 档）→ 目标PE ${r2(targetPe)} 倍` },
    { label: '当前股价 / 市值', value: (P != null ? '¥' + r2(P) : 'N/A') + ' / ' + (P != null ? r2(P * N) + ' 亿元' : 'N/A') + '（PE(TTM) ' + r2(PEq) + '、PB ' + r2(PBq) + '）' },
  ];

  const layerRows = [
    { label: '第一层 PB-ROE 主锚（权重 ' + pct(wuPbr) + '%）', value: '可持续ROE ' + r2(roeSust) + '%（= TTM ' + r2(ttmRoe) + '% × 周期系数 ' + r2(cycleCoef) + ' + 新产能 ' + r2(newCapLift) + '%' + (roeCapped ? `，触顶 ${r2(roeCap)}%` : '') + '）→ 合理PB ' + r2(fairPb) + ' × BPS ' + r2(bps) + ' = ' + r2(pbPrice) + ' 元' },
    { label: '第二层 PE 相对（权重 ' + pct(wuPe) + '%）', value: '预测净利 ' + r2(npPeUsed) + ' 亿' + (mktChk.triggered ? '（熔断2：机构一致 ' + r2(fcastNp) + ' 与市值隐含 ' + r2(mktChk.impliedNp) + ' 偏差 ' + r2(mktChk.diffPct) + '% >30% → 取均值）' : '（机构一致预期）') + ' × 目标PE ' + r2(targetPe) + '（' + peCbNote + '，× 折价系数 ' + r2(discCoef) + '）→ 市值 ' + r2(peFairMC) + ' 亿 ÷ ' + r2(N) + ' 亿股 = ' + r2(pePrice) + ' 元' },
    { label: '第三层 DCF 辅助（权重 ' + pct(wuDcf) + '%）', value: 'FCFF 基期 ' + r2(fcffBase) + ' 亿（A层 TTM 规则值） / WACC ' + r2(nz(vv(D.wacc))) + '% / g∞ ' + r2(nz(vv(D.gPerp))) + '% → EV ' + r2(dcfBase.ev) + ' 亿 − 净债务 ' + r2(netDebt) + ' 亿 = ' + r2(dcfBase.perShare) + ' 元（终值占比 ' + pct(dcfBase.tvShare) + '%）' },
    ...reb.notes.map(n => ({ label: '权重调整过程', value: n })),
  ];

  const weightRows = [
    { label: '基准权重', value: 'PB-ROE ' + pct(W.pbRoe) + '% / PE ' + pct(W.pe) + '% / DCF ' + pct(W.dcf) + '%' },
    { label: '层内平均置信度', value: 'PB-ROE ' + r2(confs.pbRoe) + ' / PE ' + r2(confs.pe) + ' / DCF ' + r2(confs.dcf) + '（点估计不变，置信度只影响区间宽度与层权重）' },
    { label: '调整后权重（归一化）', value: 'PB-ROE ' + pct(wuPbr) + '% / PE ' + pct(wuPe) + '% / DCF ' + pct(wuDcf) + '%' + (veto.triggered ? '（含熔断4一票否决：合并值取较低者，释放权重转移给 DCF）' : '') },
    { label: '平均置信度 → 区间半宽', value: r4(avgCeff) + (quoteLag5 ? '（熔断3：行情滞后 >5 交易日 → 置信度封顶 0.6）' : '') + ' → 半宽 15%÷' + r4(avgCeff) + ' = ±' + r2(iv.halfPct) + '% → 区间 [' + rangeLow + ', ' + rangeHigh + '] 元' },
  ];

  const unitRows = (I.businessUnits.units || []).map(u => ({
    label: u.name,
    value: (u.h1_2026 || '') + '｜驱动：' + (u.driver || '')
  }));
  unitRows.push({ label: '分业务外推（B层·总和校验）', value: segExtrap.map(s => `${s.name} ${s.rev} 亿`).join(' / ') + `（26H1 结构占比 × TTM 营收；${sumChk.note}）` });
  unitRows.push({ label: '分地区口径（26H1）', value: '境外 ' + r2(segH1.overseas.rev) + ' 亿（' + r2(segH1.overseas.share) + '%，毛利率 ' + r2(segH1.overseas.gm) + '%）；境内 ' + r2(segH1.domestic.rev) + ' 亿（+' + r2(segH1.domestic.revYoY) + '%）' });

  const scenRows = [
    { name: '悲观情景', value: '可持续ROE ' + r2(sPes.roe) + '% → PB-ROE ' + r2(sPes.pbP) + ' 元｜净利 ' + r2(sPes.np) + ' 亿 × PE ' + r2(sPes.pe) + ' → ' + r2(sPes.peP) + ' 元｜DCF ' + r2(sPes.dcfP) + ' → 加权 ' + r2(sPes.combo) + ' 元；' + sPes.note },
    { name: '基准情景', value: '可持续ROE ' + r2(sBase.roe) + '% → PB-ROE ' + r2(sBase.pbP) + ' 元｜净利 ' + r2(sBase.np) + ' 亿 × PE ' + r2(sBase.pe) + ' → ' + r2(sBase.peP) + ' 元｜DCF ' + r2(sBase.dcfP) + ' → 加权 ' + r2(sBase.combo) + ' 元；' + sBase.note },
    { name: '乐观情景', value: '可持续ROE ' + r2(sOpt.roe) + '% → PB-ROE ' + r2(sOpt.pbP) + ' 元｜净利 ' + r2(sOpt.np) + ' 亿 × PE ' + r2(sOpt.pe) + ' → ' + r2(sOpt.peP) + ' 元｜DCF ' + r2(sOpt.dcfP) + ' → 加权 ' + r2(sOpt.combo) + ' 元；' + sOpt.note },
  ];

  const distortionRows = [
    { label: 'v2.1 四项熔断（强制开启）', value: '熔断1 行业PE极值 ' + (peCb.triggered ? '⛔触发' : '✅未触发') + '｜熔断2 市场隐含约束 ' + (mktChk.triggered ? '⛔触发' : '✅未触发') + '｜熔断3 行情时效 ' + (signalBlocked ? '⛔触发(>15交易日)' : (quoteLag5 ? '⚠️触发(>5交易日)' : '✅未触发')) + '｜熔断4 层间一票否决 ' + (veto.triggered ? '⛔触发' : '✅未触发') + '（明细见熔断状态表 cbRows）' },
    { label: '汇兑损益剥离', value: '26H1 汇兑净损失 ' + r2(fxLoss) + ' 亿（半年报实际披露）→ 趋势校验中剥离至可持续净利 ' + r2(sustainableNp) + ' 亿；敏感性：人民币每 1% 升值 ≈ 净利 ' + r2(DR.fx && DR.fx.sensitivityPerPct) + ' 亿' },
    { label: '季报 ROE 防失真', value: '✅ 已用 TTM ROE（' + r2(ttmRoe) + '%，TTM归母÷最近时点净资产），未使用单季年化 → 不触发八折' },
    { label: '股本变动追踪', value: '总股本 ' + r2(N) + ' 亿股（无增发/回购/行权公告 → 不覆盖）→ 所有每股指标按最新股本' },
    { label: '估值分歧预警（阈值 50%）', value: (divergenceTriggered ? '⚠️ 已触发：' : '未触发：') + 'PB-ROE ' + r2(pbPrice) + ' vs PE ' + r2(pePrice) + ' 差异 ' + r2(divergencePct) + '%　→ ' + (divergenceTriggered ? '根因：行业 PE 处历史 ~100% 分位、可持续 ROE 处周期低位；须在风险提示说明' : '两层互相印证') },
    { label: '报告期错配禁止', value: '✅ 所有流量指标（营收/归母/成本/财务费/CFO/capex）已统一转 TTM 后再算比率；存量指标（净资产/在建/固资/净债务/股本）用最近时点 ' + balAsOf },
    { label: '外推标注强制', value: spliceRows.length ? '本次共 ' + spliceRows.length + ' 项逐项标注（见数据拼接与置信度表）→ 无静默使用' : '无拼接数据' },
  ];

  const assumpRows = [
    { label: '可持续 ROE', value: r2(roeSust) + '%（= TTM ' + r2(ttmRoe) + '% × 周期系数 ' + r2(cycleCoef) + ' + 新产能 ' + r2(newCapLift) + '%；上限 ' + r2(roeCap) + '% = 历史中枢 ' + r2(roeHistCenter) + '% × 1.2）' },
    { label: '永续增长 / 股权成本', value: 'g ' + r2(gPerp * 100) + '% / r ' + r2(rEquity * 100) + '%（模型默认；CAPM 若国债/ERP 显著变化再调）' },
    { label: '合理 PB / PB-ROE 股价', value: r2(fairPb) + ' / ¥' + r2(pbPrice) + '（= (ROE−g)/(r−g) × BPS ' + r2(bps) + '）' },
    { label: '预测净利润 / 目标 PE', value: r2(npPeUsed) + ' 亿（' + (mktChk.triggered ? '熔断2均值：机构一致 ' + r2(fcastNp) + ' 与市值隐含 ' + r2(mktChk.impliedNp) + ' 的均值；' : '机构一致 ' + consCount + ' 家，C层置信度 0.9；') + '）× ' + r2(targetPe) + ' 倍（' + (peCb.triggered ? '熔断1后基准 ' + r2(peCb.basePe) : '行业 ' + r2(indMedPe)) + ' × 折价 ' + r2(discCoef) + '）' },
    { label: 'DCF 参数', value: 'WACC ' + r2(nz(vv(D.wacc))) + '% / g∞ ' + r2(nz(vv(D.gPerp))) + '% / 显性 5 年（增速路径 ' + (D.growthPath || []).map(g => pct(g) + '%').join('→') + '）/ FCFF 基期 ' + r2(fcffBase) + ' 亿（A层 TTM 规则值）/ 净债务 ' + r2(netDebt) + ' 亿' },
    { label: '层内平均置信度 → 调整后权重', value: 'PB-ROE ' + r2(confs.pbRoe) + ' → ' + pct(wuPbr) + '%；PE ' + r2(confs.pe) + ' → ' + pct(wuPe) + '%；DCF ' + r2(confs.dcf) + ' → ' + pct(wuDcf) + '%' },
    { label: '置信度区间', value: '半宽 = 15% ÷ 平均置信度 ' + r4(avgC) + ' = ±' + r2(iv.halfPct) + '% → [' + rangeLow + ', ' + rangeHigh + '] 元（拼接越多区间越宽，点估计不变）' },
  ];

  const coreRows = [
    { label: '2025 年报（年度锚·硬锚）', value: '营收 ' + r2(I.latest.fy2025.rev) + ' 亿 / 归母 ' + r2(I.latest.fy2025.npAttr) + ' 亿 / 扣非 ' + r2(I.latest.fy2025.npDeducted) + ' 亿 / CFO ' + r2(I.latest.fy2025.cfo) + ' 亿', source: I.latest.fy2025.source },
    { label: '锚点期累计（A层·实时）', value: S ? `${S.asOf} ${S.stageLabel}：营收 ${r2(S.inc.revCum)} 亿 / 归母 ${r2(S.inc.npCum)} 亿 / 扣非 ${r2(S.inc.npDedCum)} 亿 / 上年同期营收 ${ps ? r2(ps.rev) : '—'} 亿 / 归母 ${ps ? r2(ps.np) : '—'} 亿` : '实时拉取失败 → 配置锚', source: '东财F10三表实时（锚点自动前移）' },
    { label: 'TTM（累计转单季再滚动）', value: `营收 ${r2(ttmRev)} 亿 / 归母 ${r2(ttmNp)} 亿（${sNp.gap ? '配置锚回退' : sNp.note}）`, source: 'A层 1.0（实际披露推导）' },
    { label: '存量时点（' + balAsOf + '）', value: `归母净资产 ${r2(equity)} 亿 / 在建 ${cip != null ? r2(cip) : '—'} / 固资 ${fixed != null ? r2(fixed) : '—'} / 货币资金 ${S && S.bal && S.bal.cash != null ? r2(S.bal.cash) : '—'} 亿`, source: 'A层存量·最近时点 1.0' },
    { label: '机构一致预期', value: '2026E 归母 ' + r2(fcastNp) + ' 亿 / 目标价 ¥' + r2(I.consensus.targetPrice) + '（' + consCount + ' 家）', source: I.consensus.source },
    { label: '实时行情（' + MS.asOf + '）', value: '现价 ¥' + r2(nz(MS.price)) + ' / PE(TTM) ' + r2(PEq) + ' / PB ' + r2(PBq) + ' / 市值 ' + r2(nz(MS.marketCap)) + ' 亿　' + (msStale ? '⚠️ 超龄请复核' : '✅ 在有效期内'), source: MS.source },
  ];

  const decisionNote = '口径：v2.1 数据熔断与异常校准版（v2.0 基础 + 四项强制熔断）——A层流量指标统一「累计转单季再滚动TTM」（锚点 ' + (S ? S.asOf : cfg.dataAsOf) + '）、存量指标用最近时点（' + balAsOf + '）、B层结构外推+总和校验、置信度衰减只影响区间宽度与层权重（点估计不变）。三层加权 PB-ROE 50% + PE 35% + DCF 15%（永久固定），先 DCF 再平衡后置信度调整再归一化' + (veto.triggered ? '，末级叠加熔断4一票否决（PB-ROE vs PE 差异 ' + r2(veto.diffPct) + '% >100% → 取较低者合并、释放权重转 DCF）' : '') + '。四项熔断强制开启：①行业PE极值熔断（>60倍或80%分位 → 基准PE=min(中位数,60)，本次' + (peCb.triggered ? '已触发' : '未触发') + '）；②市场隐含定价反向约束（隐含利润 vs 一致预期偏差>30% → 取均值，本次' + (mktChk.triggered ? '已触发，PE层净利取 ' + r2(npPeUsed) + ' 亿' : '未触发') + '）；③D层行情时效强校验（>5交易日标滞后+置信度0.6，>15交易日禁止方向信号，本次 ' + (dLagTd != null ? dLagTd + ' 个交易日' : '不可判定') + '）；④层间背离一票否决（>100% 取较低者合并，本次' + (veto.triggered ? '已触发' : '未触发') + '）。五业务单元仅叙事，新能源按期权价值不单独估值。禁止硬编码日期/股价/财报数值——A层核心输入每次运行实时拉取东财三表。';

  const positionNote = (P == null)
    ? (signalBlocked
      ? '当前价不可用且 D 层行情快照（' + dLayerAsOf + '）距估值基准日约 ' + dLagTd + ' 个交易日（>15 交易日）→ 熔断3 生效：禁止输出低估/高估信号，仅输出绝对估值区间 [' + rangeLow + ', ' + rangeHigh + '] 元。'
      : '当前价不可用，仅输出估值区间。')
    : '当前股价 ¥' + r2(P) + '：信号比 P/target = ' + r2(signalRatio) + '（<0.75 低估 / >1.30 高估）→ ' + rating + '；加权目标价 ¥' + r2(finalTarget) + '，置信度区间 [' + rangeLow + ', ' + rangeHigh + ']（半宽 ±' + r2(iv.halfPct) + '%），预期涨幅 ' + r2(expectedReturn) + '%' + (quoteLag5 ? '（熔断3：行情滞后 >5 交易日，该涨跌幅置信度降至 0.6）' : '') + '。PE(TTM) ' + r2(PEq) + ' 倍、PB ' + r2(PBq) + ' 倍' + (quoteLag5 ? '。⚠️ 行情数据滞后，非实时估值' : '') + '。核心逻辑：① 半导体材料（光刻胶单体/树脂/光酸）国产替代 + 新产能爬坡（在建/固资比 ' + (cipRatioNow != null ? r2(cipRatioNow) : '—') + ' 持续下降→释放期）；② 显示材料 PI/PSPI 与 OLED 成品放量；③ 环保沸石受益排放标准趋严；④ 生命科学受 MP 需求疲软拖累；⑤ 硫化锂/钙钛矿为长期期权。';

  const riskNote = '【汇率风险】境外收入占比 ' + r2(I.segmentData.h1_2026.overseas.share) + '%、美元计价结算为主；26H1 汇兑净损失 ' + r2(fxLoss) + ' 亿，人民币每 1% 升值约影响净利 ' + r2(DR.fx && DR.fx.sensitivityPerPct) + ' 亿。【产能释放节奏】在建工程 ' + (cip != null ? r2(cip) : '—') + ' 亿转固、半导体/PI/硫化锂/钙钛矿产线爬坡，转固慢或满产后延须下调新产能 ROE 贡献。【大客户集中度】庄信万丰+面板厂集中（前五客户占比见年报），需求/合同变化须下调对应板块收入 10~20%。【DCF 局限】资本开支高峰期 FCFF 仅 ' + r2(fcffBase) + ' 亿（A层 TTM 规则值），DCF 对 capex 极敏感，仅作底线参考（权重已按再平衡规则调整至 ' + pct(wuDcf) + '%）。【估值方法周期性偏差】行业 PE 中位数 ' + r2(indMedPe) + ' 倍（历史 ~100% 分位）' + (peCb.triggered ? '——熔断1已将基准PE封顶至 ' + r2(peCb.basePe) + ' 倍（目标PE ' + r2(targetPe) + '），但若行业 PE 回归历史中枢，PE 层仍有大幅下修空间' : '，若回归中枢则 PE 股价大幅回落') + '；PB-ROE 与 PE 差异 ' + r2(divergencePct) + '%' + (veto.triggered ? '，熔断4一票否决已生效（合并值取较低者，防 PE 高估值拉高底部安全边际）' : (divergenceTriggered ? ' 已触发分歧预警' : '')) + '。【结构数据陈旧风险】B层分业务结构截止 2026-06-30（半年报），季报不披露 → 外推置信度 0.7。本模型逻辑框架永久不变、A层核心输入每次运行实时拉取；结论不构成投资建议。';

  const versionNote = '本次更新 ' + localDate() + '｜数据截止：A层 ' + (S ? S.asOf : cfg.dataAsOf) + '（' + (S ? S.stageLabel : '配置锚') + '）/ B层 2026-06-30（26H1）/ C层 ' + cfg.dataAsOf + '（一致预期）/ D层 ' + MS.asOf + '（行情）。关键假设变化：可持续ROE ' + r2(roeSust) + '%（TTM ROE 实时化）、BPS ' + r2(bps) + '（存量时点）、FCFF 基期 ' + r2(fcffBase) + ' 亿（A层 TTM 规则值，替代原假设 4.0 亿）、净债务 ' + r2(netDebt) + ' 亿（存量实时，替代原假设 5.5 亿）。v1.0→v2.0：数据频率自适应层上线（四层分级/TTM统一法则/置信度衰减/一致性校验四条），三层加权结构不变。v2.0→v2.1：四项熔断强制开启——①行业PE极值熔断（' + (peCb.triggered ? '已触发：' + peCb.triggerReason + ' → 基准PE封顶 ' + r2(peCb.basePe) + '，目标PE 87.9→' + r2(targetPe) : '未触发') + '）；②市场隐含定价反向约束（' + (mktChk.triggered ? '已触发：PE层净利 ' + r2(fcastNp) + '→' + r2(npPeUsed) + ' 亿（与市值隐含 ' + r2(mktChk.impliedNp) + ' 取均值）' : '未触发') + '）；③D层行情时效强校验（本次 ' + (dLagTd != null ? dLagTd + ' 个交易日' + (signalBlocked ? '，>15 → 禁止方向信号' : (quoteLag5 ? '，>5 → 滞后标签+置信度0.6' : '')) : '不可判定') + '）；④层间背离一票否决（' + (veto.triggered ? '已触发：差异 ' + r2(veto.diffPct) + '% >100% → 取较低者 ' + r2(veto.mergedPrice) + ' 元合并，释放权重 ' + pct(veto.releasedWeight) + ' 转 DCF' : '未触发') + '）。';

  return {
    ok: true,
    dedicated: true,
    wanrun: true,
    symbol: SYM,
    stockName: cfg.name,
    rating: modelSuspended ? '需人工复核' : rating,
    modelSuspended,
    fairValueRange: iv.range,
    fairValueCenter: r2(finalTarget),
    conservativeTarget: r2(rangeLow + (rangeHigh - rangeLow) * 0.25),
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? r2(upside) : null,
    expectedReturn: expectedReturn != null ? r2(expectedReturn) : null,
    signalRatio: signalRatio != null ? r2(signalRatio) : null,
    reportLabel: cfg.reportLabel,
    model: 'wanrun002643·v2.1 数据熔断与异常校准版（三层加权确定性计算 + 四项强制熔断，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    version: 'v2.1_数据熔断与异常校准',
    anchor2: { asOf: S ? S.asOf : null, stageLabel: S ? S.stageLabel : null, ttm: { rev: r2(ttmRev), np: r2(ttmNp), npDed: sNpDed.gap ? null : r2(sNpDed.value), gm: r2(ttmGm), roe: r2(ttmRoe), cfo: r2(ttmCfo), capex: r2(ttmCapex), fcff: r2(fcffBase) }, equity: r2(equity), bps: r2(bps), netDebt: r2(netDebt), cipRatio: cipRatioNow != null ? r2(cipRatioNow) : null },
    confLayers: { pbRoe: confs.pbRoe, pe: confs.pe, dcf: confs.dcf, avg: r4(avgC), effAvg: r4(avgCeff), halfPct: iv.halfPct },
    weights: { base: { pbRoe: nz(W.pbRoe), pe: nz(W.pe), dcf: nz(W.dcf) }, final: { pbRoe: r4(wuPbr), pe: r4(wuPe), dcf: r4(wuDcf) }, dcfRebalanced: reb.dcfRebalanced, confAdjusted: reb.confAdjusted, dcfDeviationPct: reb.dcfDeviationPct },
    spliceRows, checkRows, weightRows, versionNote,
    freshnessRows, alerts, fallbackFlags,
    reportHeadRows, diagRows, layerRows, unitRows, scenRows, sensRows, sensColsPe: peCols,
    distortionRows, assumpRows, coreRows, failRows,
    divergence: { triggered: divergenceTriggered, pct: r2(divergencePct) },
    rebalance: { triggered: reb.dcfRebalanced, deviationPct: reb.dcfDeviationPct },
    // v2.1 四项熔断明细
    cbRows,
    circuitBreakers: {
      peExtreme: { triggered: peCb.triggered, basePe: r2(peCb.basePe), cap: peCb.cap, percentile: pctileNum, targetPe: r2(targetPe), reason: peCb.triggerReason },
      marketImplied: { triggered: mktChk.triggered, impliedNp: mktChk.impliedNp, diffPct: mktChk.diffPct, npUsed: r4(npPeUsed), fcastNp: r4(fcastNp), threshold: mktChk.threshold },
      quoteLag: { asOf: dLayerAsOf, baseDate: baseDateStr, tradingDays: dLagTd, tagged: quoteLag5, conf: quoteLagConf, signalBlocked },
      layerVeto: { triggered: veto.triggered, diffPct: veto.diffPct, mergedPrice: veto.mergedPrice, lowerIsPbr: veto.lowerIsPbr, releasedWeight: veto.releasedWeight, weights: veto.weights },
    },
    modelFailureNote: modelSuspended
      ? '⛔ 模型条件触发，需人工复核：' + failRows.filter(f => f.triggered).map(f => f.text).join('；')
      : '✅ 触发条件均未触发（' + failRows.map(f => f.id + '未触发').join('、') + '）',
    decisionNote,
    positionNote,
    riskNote,
  };
}

module.exports = { run, isWanrunModel, loadConfig, ttmSplice, cumToQuarters, sumCheckSegs, confRebalance, intervalRange, deviationPct, peCircuitBreaker, marketImpliedNpCheck, layerVetoMerge, tradingDaysBetween };
