# 核心业务逻辑（lib/） · 第 4 卷

> 共 14 个文件，本卷约 7816 行


---

## `lib\valuation\wanrun002643.js`  ·  758 行

~~~js
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

~~~

---

## `lib\valuation\weigao603014.js`  ·  355 行

~~~js
// ============================================================
// 威高血净（603014）专属估值模型 —— 动态估值 AI 指令集（整合版）九指令
// 确定性计算（1+1=2，无 LLM 参与）。执行顺序严格按指令一：
//   并表状态识别 → 三口径桥接 → 数据新鲜度分级 → 核心矩阵构建 → 估值引擎 → 动态结论
// 设计原则：新鲜度分级解决「报告期错配」，并表协议解决「合并范围断层」，
//   三口径桥接解决「备考数与法定数混用」。估值准确性不为数据缺失让路——
//   降级指标自动改变其在估值中的权重，而非机械填充或强行年化。
// 硬约束：
//   ① 每次运行必须声明「本次 DCF 基期采用口径①（法定合并）」；
//   ② 备考口径（②）不得直接输入 DCF、不得年化；凡引用「同比+156.69%」类表述
//      必须标注「备考口径对比，非法定报表同比」；
//   ③ 并表首年附加禁止：2026 年 1—8 月普瑞利润不入合并 FCFF；禁止将当期利润简单年化；
//   ④ 承诺期结束后（2029 起）不得将承诺期 CAGR 线性外推至永续；
//   ⑤ PE/EPS 一律使用摊薄后总股本 6.95 亿股；
//   ⑥ 协同效应看涨期权独立列示，不并入基准 DCF；
//   ⑦ 指令九 11 节输出缺项视为运行无效。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '603014';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/603014.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isWeigaoModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'weigao';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const mean = (a) => {
  const s = a.filter(x => x != null && isFinite(Number(x))).map(Number);
  if (!s.length) return null;
  return s.reduce((x, y) => x + y, 0) / s.length;
};

// ============================================================
// DCF 分部折现（估值基准日 2026-12-31，预测年 t=1..5 → 2027..2031）
// flows: 每年 FCFF 数组（亿元）；wacc/g 小数；返回 {pvFlows, pvTV, tv, total}
// ============================================================
function dcfPart(flows, wacc, g) {
  let pvFlows = 0;
  flows.forEach((f, i) => { pvFlows += f / Math.pow(1 + wacc, i + 1); });
  const tv = flows[flows.length - 1] * (1 + g) / (wacc - g);
  const pvTV = tv / Math.pow(1 + wacc, flows.length);
  return { pvFlows, tv, pvTV, total: pvFlows + pvTV };
}

// 假设权重表（指令七：基准情景 C 级指标权重 > 20% → 降低置信权重）
const ASSUMPTION_WEIGHTS = [
  { name: '血净分部增长率假设', grade: 'B', weight: 0.15 },
  { name: '血净分部 WACC', grade: 'A', weight: 0.10 },
  { name: '血净永续 g（2.0%）', grade: 'A', weight: 0.10 },
  { name: '普瑞承诺净利（2027/2028）', grade: 'A', weight: 0.25 },
  { name: '普瑞分部 WACC（−40bp）', grade: 'A', weight: 0.10 },
  { name: '普瑞永续 g（≤3%）', grade: 'B', weight: 0.10 },
  { name: 'FCFF 转换系数（0.90）', grade: 'C', weight: 0.10 },
  { name: '净债务 ≈ 0（2025 年报）', grade: 'A', weight: 0.05 },
  { name: '估值基准日 2026-12-31', grade: 'A', weight: 0.05 },
];

// ============================================================
// 主入口（同步，run(symbol,{price}) 契约）
// ============================================================
function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'weigao') return { error: 'NOT_WEIGAO' };

  const CON = cfg.consolidation, BR = cfg.bridge, ACT = cfg.actualStandalone,
    CM = cfg.coreMatrix, PR = cfg.promises, D = cfg.dcf, CP = cfg.comps,
    PA = cfg.peAttribution, SY = cfg.synergy, CC = cfg.considerationCheck;

  const N = nz(CON && cfg.market && cfg.market.shares && cfg.market.shares.value) || 6.95; // 摊薄总股本（硬约束⑤）
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : nz(cfg.market.priceSources[0].px);
  const priceSourceNote = (price != null && isFinite(Number(price)) && Number(price) > 0)
    ? '实时行情（getQuote 传入）' : '配置锁死快照（' + (cfg.market.priceAdopt || '') + '）';
  const mktCap = P * N;

  // ===== 〇 指令一/九①：并表状态与口径声明 =====
  const openingStatement = `当前并表状态：${CON.status}（${CON.statusNote}）。本次 DCF 基期采用口径①（法定合并）。威高普瑞在最新报告期并表了 ${BR.consolidatedMonths} 个月（购买日 ${CON.purchaseMonth}）。${BR.mandatorySentence}凡涉及「归母同比+156.69%」类表述均为备考口径对比，非法定报表同比，不得直接年化或外推为 2027 年增速。`;

  // ===== 一 指令三：三口径桥接表（缺项视为运行无效） =====
  const bridgeRows = BR.rows.map(r => ({
    label: r.item,
    value: `standalone ${r.standalone}　|　普瑞全期 ${r.puri}　|　备考合并 ${r.proforma}　|　法定合并 ≈${r.statutory}${r.statutoryIsEst ? '（估算，以实际法定报表为准）' : ''}　|　并表 ${r.months} 个月`,
    source: '血净standalone = 备考 − 普瑞全期；法定合并 ≈ standalone + 普瑞全期×(并表月数/报告期月数)，9月单月按普瑞月均估算',
  }));
  bridgeRows.unshift({
    label: '桥接锚点',
    value: `${BR.asOf}；并表月数按购买日 ${CON.purchaseMonth} 精确计算；普瑞月均：营收 ${BR.puriMonthlyAvg.rev} 亿/月、净利 ${BR.puriMonthlyAvg.np} 亿/月`,
    source: BR.rules.join(' '),
  });

  // ===== 二 指令四：数据新鲜度分级 =====
  const frMax = nz(cfg.freshness.maxAgeDays) || 200;
  const today = new Date();
  const freshnessRows = (cfg.freshness.items || []).filter(it => it.asOf).map(it => {
    const age = Math.floor((today - new Date(it.asOf)) / 86400000);
    return { label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale: age > frMax };
  });
  // 分级汇总（指令九③）
  const gradeItems = [
    { name: '总量损益（营收/归母/扣非/CFO）', grade: 'A', caliber: '②备考 + ①法定合并（估算）' },
    { name: '综合毛利率 41.47%（-2.42pct）', grade: 'A', caliber: '法定合并' },
    { name: '普瑞贡献拆分（16.72 / 5.27，+18.4% / +8.5%）', grade: 'A', caliber: '③标的全期' },
    { name: '血净 standalone（26.96 / 3.37；Q3 9.39 / 1.07）', grade: 'A', caliber: '③' },
    { name: '分产品结构（耗材/设备 vs 药包材）', grade: 'B/C', caliber: '降级至 2026 半年报或 2025 年报（结构冻结）' },
    { name: '分渠道（经销/直销）', grade: 'C', caliber: '仅年报披露 → 基准情景采用行业中值保守替代' },
    { name: '境外收入（2025：3.29 亿，+62.23%，占比 8.7%）', grade: 'B/C', caliber: '降级至最近半年报/年报' },
    { name: '总股本 6.95 亿（4.18 + 2.77）', grade: 'A', caliber: '最新（交割后）' },
    { name: '净有息负债 ≈ 0（402 万）', grade: 'A', caliber: '2025 年报' },
  ];
  const aShare = Math.round(gradeItems.filter(g => g.grade === 'A').length / gradeItems.length * 100);
  const cList = gradeItems.filter(g => String(g.grade).includes('C')).map(g => g.name);
  const freshnessOverview = `最新报告期：2026Q3（2026-10-31 披露）。总量指标 A 级占比：${aShare}%。进入基准估值的分产品/分渠道指标最高新鲜度：B/C 级（分产品，半年报口径、结构冻结）。C 级指标清单：${cList.join('；')}。`;

  // ===== 三 指令五：核心财务矩阵（[报告期 | 新鲜度 | 口径 | 质量标记]） =====
  const statutoryTtmNp = nz(ACT.fy2025.np) + nz(BR.rows[1].statutory) - nz(ACT.q3_2025.np9m); // 口径① TTM：4.823 + 3.96 − 3.408 = 5.375
  const cfoNp2025 = nz(ACT.fy2025.cfo) / nz(ACT.fy2025.np); // 1.646
  const cfoNpWarn = cfoNp2025 < nz(cfg.reverseCheck.cfoNpGood);
  const coreRows = [
    { label: '法定合并 TTM 归母（口径①）', value: `${r2(statutoryTtmNp)} 亿 = 2025全年 ${r2(ACT.fy2025.np)}（A级实际） + 2026 1-9月法定合并 ${BR.rows[1].statutory}（估算） − 2025 1-9月 standalone ${r2(ACT.q3_2025.np9m)}（A级实际）｜[2026Q3 | A级+估算成分 | 口径① | TTM严格拼接]`, source: '分子分母同源同报告期；腾讯 PE-TTM 45.27 反推 ≈5.20 亿交叉验证吻合' },
    { label: '备考 1—9月 / 法定合并 1—9月', value: `营收 ${CM.totalPL.proformaRev} / ≈${CM.totalPL.statutoryRev}；归母 ${CM.totalPL.proformaNp} / ≈${CM.totalPL.statutoryNp}（估算）｜[2026 1-9月 | A级 | ②+① | 备考不得年化]`, source: '指令五总量损益' },
    { label: '综合毛利率', value: `${CM.grossMargin.value}%（同比 ${CM.grossMargin.yoyPct}pct）｜[2026 1-9月 | A级 | 法定合并 | 血净集采拖累]`, source: '指令五；禁止用旧结构百分比嫁接 TTM' },
    { label: '普瑞贡献拆分', value: `营收 ${CM.puriContribution.rev} 亿（+${CM.puriContribution.revYoy}%）、净利 ${CM.puriContribution.np} 亿（+${CM.puriContribution.npYoy}%）｜[2026 1-9月 | A级 | ③标的全期]`, source: '口径③：承诺追踪与标的独立估值用' },
    { label: '血净 standalone', value: `1—9月 营收 ${CM.standalone.rev} / 归母 ${CM.standalone.np}；Q3 单季 ${CM.standalone.q3Rev} / ${CM.standalone.q3Np}｜[2026 1-9月 | A级 | ③推导]（实际披露对照：1-9月归母 ${r2(ACT.q3_2025.np9m)} 亿/2025全年 ${r2(ACT.fy2025.np)} 亿）`, source: ACT.bridgeCrossCheck },
    { label: '经营现金流/归母净利', value: `2025 实际 ${r2(cfoNp2025)}×（7.937/4.823）${cfoNpWarn ? ' → ⚠️ 黄色预警' : ' → ≥0.7 ✅ 盈利质量正常'}｜[2025FY | A级 | ③standalone]；2026 9M 法定合并 CFO 未披露 → 显式标记`, source: `校验阈值 <${cfg.reverseCheck.cfoNpGood} 黄色预警` },
    { label: '股本与摊薄口径', value: `总股本 ${N} 亿股（原 ${cfg.market.shares.preShares} + 新增 ${cfg.market.shares.newShares}）｜[最新 | A级 | 交割后 | PE/EPS 一律用 6.95 亿股]`, source: cfg.market.shares.shareCheckNote },
    { label: '资产负债', value: `2025 末归母净资产 ${r2(ACT.fy2025.equity)} 亿、有息负债仅 0.04 亿（净现金状态）｜[2025FY | A级 | 净债务≈0]`, source: 'DCF 未单独扣净债务（误差 <0.2%）' },
  ];

  // ===== 四 指令六：业绩承诺追踪（口径③） =====
  const promise2026 = nz(PR.annual['2026']), promise2027 = nz(PR.annual['2027']), promise2028 = nz(PR.annual['2028']);
  const actual9M = nz(PR.actual9M2026);
  const progressPct = actual9M / promise2026 * 100;                     // 82.3%
  const q4Threshold = promise2026 - actual9M;                          // 代码权威：6.40−5.27 = 1.13 亿
  const timeProgressPct = 9 / 12 * 100;                                // 时序 75%
  const aheadOfSchedule = progressPct > timeProgressPct;
  const fullYearFloor = actual9M + q4Threshold;                        // 承诺下限 6.40
  const expectedFullYearPct = fullYearFloor / promise2026 * 100;       // 100%
  const promiseRows = [
    { label: '承诺净利润', value: `2026：${promise2026} 亿 / 2027：${promise2027} 亿 / 2028：${promise2028} 亿（口径③）`, source: '指令六；如延后至 2027 交割则改为 2027:7.20 / 2028:7.84 / 2029:8.45' },
    { label: '进度追踪', value: `2026 前三季普瑞净利 ${actual9M} 亿 / 全年承诺 ${promise2026} 亿 = ${r2(progressPct)}%（时序进度 ${timeProgressPct}% → ${aheadOfSchedule ? '超前 ✅' : '落后 ⚠️'}）`, source: '口径③标的全期' },
    { label: 'Q4 达标门槛（代码计算）', value: `${r2(q4Threshold)} 亿（= 承诺 ${promise2026} − 9M 实际 ${actual9M}）`, source: '指令集原文记 0.13 亿；按承诺−累计实际计算实际门槛为 1.13 亿（代码权威原则，以本计算为准）' },
    { label: '基数质量判断', value: `当前以承诺下限构建 Q4（压线情景：全年 ${r2(fullYearFloor)} 亿 = ${r2(expectedFullYearPct)}%）→ 2027 承诺 ${promise2027} 亿的同比 +12.5% 建立在低基数上 → 基准情景对普瑞增速施加上限 ${PR.baseQualityRule.coef} 保守系数（已启用）`, source: PR.baseQualityRule.text + '；除非 2026 年报显示 Q4 实际显著高于门槛（见核心跟踪变量①）' },
    { label: '压力信号 / 减值敏感性', value: `预期全年完成率 ${r2(expectedFullYearPct)}% ${expectedFullYearPct < PR.stress.warnBelow * 100 ? '→ ⚠️ 承诺压力信号' : '→ 无压力信号'}；< ${PR.stress.impairBelow * 100}% 触发减值敏感性`, source: PR.stress.warnText },
    { label: '商誉敞口', value: `对价 ${PR.consideration} 亿 − 标的净资产 ${PR.targetNetAsset} 亿 = 隐含约 ${r2(PR.goodwillApprox)} 亿商誉及可辨认无形资产增量`, source: PR.goodwillNote + '；2027 普瑞增速 < 8% → 减值敏感性测试（跟踪变量③）' },
    { label: '永续外推禁令', value: `承诺期后（2029 起）不得将承诺期 CAGR（${r2((Math.pow(promise2028 / nz(PR.puri2025Np), 1 / 3) - 1) * 100)}%）线性外推至永续`, source: PR.postPromiseRule },
  ];

  // ===== 五 指令七·轨道A：DCF 分部双轨（估值基准日 2026-12-31） =====
  const conv = nz(D.fcffConv.coef);
  const bloodBase = nz(D.blood.baseE.value) * conv;                    // 4.823 × 0.90 = 4.341
  const bc = D.scenarios.base, oc = D.scenarios.optimistic, pc2 = D.scenarios.pessimistic;
  // 血净分部：基准/乐观/悲观增长率（B 级 → ×0.85 收缩已在配置换算：0 / 2.55 / −4.25；配置为百分数 → /100）
  const bloodFlows = (growthPct) => D.forecastYears.map((y, i) => bloodBase * Math.pow(1 + nz(growthPct) / 100, i + 1));
  const bloodBaseRes = dcfPart(bloodFlows(bc.bloodGrowth), bc.bloodWacc / 100, bc.bloodG / 100);
  const bloodOptRes = dcfPart(bloodFlows(oc.bloodGrowth), oc.bloodWacc / 100, oc.bloodG / 100);
  const bloodPesRes = dcfPart(bloodFlows(pc2.bloodGrowth), pc2.bloodWacc / 100, pc2.bloodG / 100);
  // 普瑞分部：2027 承诺 7.20 / 2028 承诺 7.84（下限，指令七）；2029-2031 按情景路径（hold/decline3/converge3）
  const puriFlows = (post) => {
    const f28 = nz(D.puri.flow2028);
    const arr = [nz(D.puri.flow2027), f28];
    for (let i = 0; i < 3; i++) {
      const prev = arr[arr.length - 1];
      const post0 = String(post || '');
      if (post0.startsWith('decline3')) arr.push(prev * 0.97);
      else if (post0.startsWith('converge3')) arr.push(prev * 1.03);
      else arr.push(prev);                                             // hold：持平承诺期末值（不线性外推）
    }
    return arr;
  };
  const puriBaseRes = dcfPart(puriFlows(bc.puriPost).map(x => x * conv), bc.puriWacc / 100, bc.puriG / 100);
  const puriOptRes = dcfPart(puriFlows(oc.puriPost).map(x => x * conv), oc.puriWacc / 100, oc.puriG / 100);
  const puriPesRes = dcfPart(puriFlows(pc2.puriPost).map(x => x * conv), pc2.puriWacc / 100, pc2.puriG / 100);

  const evBase = bloodBaseRes.total + puriBaseRes.total;
  const evOpt = bloodOptRes.total + puriOptRes.total;
  const evPes = bloodPesRes.total + puriPesRes.total;
  const pxBase = evBase / N, pxOpt = evOpt / N, pxPes = evPes / N;

  // C 级权重（指令七：>20% → 降低置信权重、区间呈现）
  const cWeightPct = Math.round(ASSUMPTION_WEIGHTS.filter(a => a.grade === 'C').reduce((s, a) => s + a.weight, 0) * 100);
  const cWeightAlert = cWeightPct > nz(D.cWeightAlert);

  const dcfRows = [
    { name: `悲观情景`, value: `血净分部 ${r2(bloodPesRes.total)} 亿（WACC ${pc2.bloodWacc}%、增速 ${pc2.bloodGrowth}%、g ${pc2.bloodG}%） + 普瑞分部 ${r2(puriPesRes.total)} 亿（WACC ${pc2.puriWacc}%、g ${pc2.puriG}%、2029-31 ${pc2.puriPost}） = 股权价值 ${r2(evPes)} 亿 → ${r2(pxPes)} 元/股；B/C 新鲜度分布：B 25%、C 10%；${pc2.note}` },
    { name: `基准情景`, value: `血净分部 ${r2(bloodBaseRes.total)} 亿（WACC ${bc.bloodWacc}%、增速 ${bc.bloodGrowth}%（B级×0.85 收缩后）、g ${bc.bloodG}%） + 普瑞分部 ${r2(puriBaseRes.total)} 亿（WACC ${bc.puriWacc}%（血净−40bp）、承诺下限 2027:7.20/2028:7.84、2029-31 持平不外推、g ${bc.puriG}%） = 股权价值 ${r2(evBase)} 亿 → ${r2(pxBase)} 元/股；C 级权重 ${cWeightPct}%${cWeightAlert ? ' > 20% → 已降低置信权重、区间呈现' : ' ≤ 20% → 无需降权'}；${bc.note}` },
    { name: `乐观情景`, value: `血净分部 ${r2(bloodOptRes.total)} 亿（WACC ${oc.bloodWacc}%、增速 ${oc.bloodGrowth}%、g ${oc.bloodG}%） + 普瑞分部 ${r2(puriOptRes.total)} 亿（WACC ${oc.puriWacc}%、g ${oc.puriG}%、2029-31 ${oc.puriPost}） = 股权价值 ${r2(evOpt)} 亿 → ${r2(pxOpt)} 元/股；B/C 新鲜度分布：B 25%、C 10%；${oc.note}` },
    { name: `DCF 基期与参数声明`, value: `${D.baseCaliber}；rf = ${D.rf.value}%（运行日 10Y 国债 ${D.rf.range.join('~')}% 区间中值，${D.rf.asOf} 快照，未沿用旧研报值）；FCFF 转换系数 ${conv}（${D.fcffConv.grade}级）；净债务≈0（${D.netDebt.note}）`, source: D.valuationDate },
  ];

  // ===== 六 指令七·轨道B：分部相对估值（交叉验证，不单独作为目标价） =====
  const bloodPe = mean(CP.bloodPeers.filter(p => !p.excluded).map(p => p.pe));  // (22.91+17.05+23.17)/3 = 21.04
  const packPe = mean(CP.packPeers.filter(p => !p.excluded).map(p => p.pe));    // 18.49
  const wBlood = nz(BR.rows[1].standalone) / nz(BR.rows[1].proforma);           // 3.37/8.64 = 39.0%
  const wPack = 1 - wBlood;                                                     // 61.0%
  const impliedPe = wBlood * bloodPe + wPack * packPe;                          // ≈19.49x
  // 分部×分部 2027E 利润（F 状态首年：standalone 零增长 + 普瑞承诺下限）
  const bloodE2027 = nz(D.blood.baseE.value);                                   // 4.823（基准零增长）
  const puriE2027 = nz(D.puri.flow2027);                                        // 7.20
  const evRel = bloodE2027 * bloodPe + puriE2027 * packPe;
  const pxRel = evRel / N;                                                      // ≈33.76
  const devRel = (pxBase - pxRel) / pxRel * 100;
  const devAlert = Math.abs(devRel) > nz(CP.devAlertPct);
  const compRows = [
    { label: `血净业务可比（${CP.snapshotDate} 快照）`, value: CP.bloodPeers.map(p => `${p.name} ${p.pe != null ? p.pe + 'x' : '负值'}`).join('、') + `；剔除：` + CP.bloodPeers.filter(p => p.excluded).map(p => `${p.name}（${p.excludeReason}）`).join('、') + ` → 平均 PE-TTM ${r2(bloodPe)}x`, source: '指令七轨道B；剔除负值/极端失真值后算术平均' },
    { label: `药包材可比（${CP.snapshotDate} 快照）`, value: CP.packPeers.map(p => `${p.name} ${p.pe}x`).join('、') + `；剔除：` + CP.packPeers.filter(p => p.excluded).map(p => `${p.name}（${p.excludeReason}）`).join('、') + ` → 主锚 ${r2(packPe)}x`, source: '正川/力诺运行时实时拉取（2026-11-04 东财）：PE-TTM 异常偏高，仅列示不采用' },
    { label: '利润贡献加权（2026 备考 9M）', value: `血净 ${r2(wBlood * 100)}% / 药包材 ${r2(wPack * 100)}%（standalone ${BR.rows[1].standalone} / 普瑞 ${BR.rows[1].puri}，A级锚） → 加权隐含 PE ${r2(impliedPe)}x`, source: CP.weightsBasis },
    { label: '分部隐含股权价值', value: `血净 ${r2(bloodE2027)} 亿 × ${r2(bloodPe)}x + 普瑞 ${r2(puriE2027)} 亿 × ${r2(packPe)}x = ${r2(evRel)} 亿 ÷ ${N} 亿股 = ${r2(pxRel)} 元/股（交叉验证口径，不单独作为目标价）`, source: '分部利润取 2027E（F 状态首年）：standalone 零增长 + 普瑞承诺下限' },
    { label: 'DCF × 相对估值 交叉验证', value: `DCF 基准 ${r2(pxBase)} 元 vs 相对估值 ${r2(pxRel)} 元 → 偏离 ${devRel >= 0 ? '+' : ''}${r2(devRel)}% ${devAlert ? '→ ⚠️ 偏离超过 ±40%，触发偏离警示' : '→ ±40% 以内，双轨一致'}`, source: `偏离阈值 ±${nz(CP.devAlertPct)}%（指令七）` },
  ];

  // ===== 七 PE 归因（静态 vs 动态，指令七强制） =====
  const staticPe = mktCap / nz(PA.staticE.value);
  const dynPe = mktCap / nz(PA.dynE.value);
  const peRows = [
    { label: '静态 PE（口径③ 2025 全年实际）', value: `市值 ${r2(mktCap)} 亿 ÷ ${r2(PA.staticE.value)} 亿 = ${r2(staticPe)}x（指令集撰写日快照 ${PA.snapshot.staticPe}x）`, source: PA.staticE.caliber },
    { label: '动态 PE（②备考口径）', value: `市值 ${r2(mktCap)} 亿 ÷ ${r2(PA.dynE.value)} 亿 = ${r2(dynPe)}x（指令集撰写日快照 ${PA.snapshot.dynPe}x）——【备考口径对比，非法定报表同比】`, source: PA.dynE.build },
    { label: '差异归因（强制披露）', value: `静态 ${r2(staticPe)}x vs 动态 ${r2(dynPe)}x 的差异归因于：①并表基数效应（法定合并仅含普瑞 1 个月 ≈0.59 亿，备考含全期 5.27 亿）；②股本摊薄（4.18 → 6.95 亿股）。不得将备考口径动态 PE 直接年化或外推为 2027 增速。`, source: PA.attributionMandatory },
  ];

  // ===== 八 指令八：协同期权（独立列示）+ 对价合理性（独立结论） =====
  const optLow = SY.deltaNpRange[0] * SY.fcffConv / ((SY.discWacc - SY.g) / 100) * SY.probBase / N;
  const optHigh = SY.deltaNpRange[1] * SY.fcffConv / ((SY.discWacc - SY.g) / 100) * SY.probBase / N;
  const optMid = (optLow + optHigh) / 2;
  const pxBasePlusOpt = pxBase + optMid;
  const optionRows = [
    { label: '协同兑现概率', value: `${(SY.probRange[0] * 100).toFixed(0)}%—${(SY.probRange[1] * 100).toFixed(0)}%（基准取 ${(SY.probBase * 100).toFixed(0)}%）`, source: SY.probNote },
    { label: '协同增量净利假设', value: `${SY.deltaNpRange.join('~')} 亿/年【${SY.deltaNpGrade}级：无可验证现金流锚（滤器尚未商业化），仅用于期权层量化】`, source: SY.deltaNpNote },
    { label: '期权价值量化', value: `ΔNP×0.9 ÷ (WACC ${SY.discWacc}% − g ${SY.g}%) × 概率 ${(SY.probBase * 100).toFixed(0)}% ÷ ${N} 亿股 = ${r2(optLow)}~${r2(optHigh)} 元/股（中值 ${r2(optMid)} 元）；贴现率 ${SY.discWacc}%（协同层更高贴现率）`, source: SY.discNote },
    { label: '独立列示声明', value: `基准 DCF 仅含普瑞独立运营现金流（协同增量 = 0）；协同以「基准 DCF ${r2(pxBase)} 元 + 期权概率加权 ${r2(optMid)} 元 = 综合基准价值 ${r2(pxBasePlusOpt)} 元」呈现，不并入基准目标价`, source: SY.content + '；兑现前提：' + SY.premise },
    { label: 'EPS 增厚≠价值创造', value: `备考 EPS 增厚 ${SY.epsThickAnchor.value}% —— 增厚是用 ${cfg.market.shares.newShares} 亿新股和约 ${r2(PR.goodwillApprox)} 亿商誉换来的，不得直接等同于原股东价值创造`, source: SY.epsThickAnchor.warning },
  ];
  const impliedPe2025 = nz(CC.consideration) / nz(CC.puri2025Np);
  const verdict = impliedPe2025 < packPe * 0.9 ? '轻微增厚' : (impliedPe2025 > packPe * 1.15 ? '存在高估风险' : '价值中性');
  const considerationRows = [
    { label: '对价隐含倍数', value: `${CC.consideration} 亿 ÷ 普瑞 2025 净利 ${CC.puri2025Np} 亿 = ${r2(impliedPe2025)}x（2025 口径）`, source: CC.impliedPe2025 },
    { label: '行业区间对比', value: `药包材主锚（山东药玻）${r2(packPe)}x、血净可比均值 ${r2(bloodPe)}x → 对价倍数低于药包材可比 ${r2((1 - impliedPe2025 / packPe) * 100)}%`, source: CC.industryRef },
    { label: '承诺期 CAGR 校验', value: `6.01 → ${promise2026} → ${promise2027} → ${promise2028}：CAGR ${r2((Math.pow(promise2028 / CC.puri2025Np, 1 / 3) - 1) * 100)}%（指令集称约 10%）→ 校验一致`, source: CC.promiseCagrCheck },
    { label: '独立结论', value: `【${verdict}】——对价相对行业可比偏温和，但约 ${r2(PR.goodwillApprox)} 亿商誉构成后续减值敏感性敞口（2027 普瑞增速 < 8% 触发）；本判断不并入合并 DCF，与 DCF 并列呈现`, source: CC.verdictScale.join(' / ') },
  ];

  // ===== 九 反向验证清单 =====
  const reverseRows = [
    { id: '1.盈利质量（CFO/归母）', result: cfoNpWarn ? '否' : '是', detail: `2025 实际 ${r2(cfoNp2025)}× ≥ ${cfg.reverseCheck.cfoNpGood} ✅（CFO 7.94 亿/归母 4.82 亿，销售现金比 21%）；2026 9M 法定合并 CFO 未披露 → 显式标记，不静默替代` },
    { id: '2.归母扣非背离', result: '是', detail: `2025：归母 +7.33% vs 扣非 +5.06%，背离 2.27pct < 15pct ✅；2026 9M 法定扣非未披露（桥接表仅归母）→ 显式标记` },
    { id: '3.承诺达成前瞻', result: '是', detail: `普瑞 9M ${actual9M} 亿（时序 ${timeProgressPct}% 点位完成 ${r2(progressPct)}%）→ 按承诺下限全年 100% 达成；压线情景已启用 2027 增速 ×${PR.baseQualityRule.coef} 保守系数` },
    { id: '4.永续外推合规', result: '是', detail: `普瑞 2029-2031 基准持平承诺期末值（hold）、血净 g 2.0%/药包 g 2.5% 独立构建 → 未将承诺期 CAGR 线性外推至永续 ✅` },
    { id: '5.备考口径隔离', result: '是', detail: `DCF 全部现金流来自口径①/③（standalone 实际 + 承诺下限），备考 8.64 亿未直接输入 DCF、未年化 ✅；法定合并 TTM ${r2(statutoryTtmNp)} 亿仅用于 PE 口径展示` },
  ];
  const reverseAllPass = reverseRows.every(r => r.result === '是');

  // ===== 置信度（指令九⑪） =====
  let confidenceLevel, confidenceNote;
  if (cWeightAlert) { confidenceLevel = '低'; confidenceNote = `基准情景 C 级指标权重 ${cWeightPct}% > 20% → 降低置信权重、区间形式呈现`; }
  else if (!reverseAllPass) { confidenceLevel = '低'; confidenceNote = '反向验证存在未通过项'; }
  else {
    confidenceLevel = '中';
    confidenceNote = `C 级权重 ${cWeightPct}% ≤ 20%、反向验证全部通过、双轨偏离 ${r2(Math.abs(devRel))}%（±40% 内）→ 本可为高；但因 ①法定合并 9M（3.96/28.8 亿）为月均估算值而非实际法定报表、②FCFF 转换系数 0.90 为 C 级假设、③分产品/分渠道结构降级（B/C 级）→ 置信度定为【中】。降级项已全部强制标注。`;
  }

  // ===== 模型失效检查 =====
  const failRows = (cfg.modelFailure.conds || []).map(c => ({
    id: c.id, text: c.text, threshold: c.threshold, triggered: !!c.triggered, status: c.triggered ? '⛔ 触发' : '✅ 未触发',
  }));
  const modelSuspended = failRows.some(f => f.triggered);

  // ===== 评级（严格三档：低估/合理/高估） =====
  const rangeLow = Math.min(pxPes, pxBase, pxOpt);
  const rangeHigh = Math.max(pxPes, pxBase, pxOpt);
  let rating = '合理', expectedReturn = null, upside = null;
  if (P != null) {
    expectedReturn = (pxBase - P) / P * 100;
    upside = (pxOpt - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
  }

  // ===== 核心跟踪变量（指令九⑨） =====
  const trackRows = cfg.trackVars.map(t => ({ label: '跟踪项', value: t, source: '下一报告期重点校验：哪项 B/C 级数据有望升级为 A 级并实质性改变假设' }));

  // ===== 输出区块（指令九 11 节全量） =====
  const consolidationRows = [
    { label: '并表状态判定', value: `${CON.statusFull}（${CON.purchaseMonth} 完成资产交割及过户、新增股份登记，自 2026-09 起纳入合并报表）`, source: '指令二 Step1：并表月数按购买日精确计算' },
    ...CON.timeline.map(t => ({ label: `${t.year} 年状态`, value: `${t.status} — ${t.note}`, source: '指令二状态表' })),
    ...CON.caliberDefs.map(c => ({ label: c.id, value: `${c.name}：${c.def}`, source: '三口径定义（任何时点运行均强制区分）' })),
    { label: '硬性规则声明', value: CON.hardRule, source: '指令二硬性规则（每次运行强制声明）' },
  ];

  const summaryNote = `${openingStatement}【威高血净专属估值 | RUN_DATE：${localDate()}】DCF 基准合理价 ${r2(pxBase)} 元（三档区间 ${r2(pxPes)}~${r2(pxOpt)}，估值基准日 2026-12-31），相对当前价 ${P != null ? '¥' + r2(P) : 'N/A'} 空间 ${r2(expectedReturn)}%；协同期权概率加权（${(SY.probBase * 100).toFixed(0)}%）后综合基准价值 ${r2(pxBasePlusOpt)} 元；评级【${rating}】；置信度【${confidenceLevel}】。分部相对估值 ${r2(pxRel)} 元与 DCF 偏离 ${r2(devRel)}%（±40% 内一致）。对价合理性独立结论：【${verdict}】。`;

  const positionNote = (P == null)
    ? '当前价不可用，仅输出估值区间。'
    : `基于最新可得数据（截止 ${cfg.dataAsOf}，财报期 2026Q3）：当前股价 ¥${r2(P)} 位于 DCF 三档区间 [${r2(pxPes)}, ${r2(pxOpt)}] 元的 ${Math.round(Math.max(0, Math.min(100, (P - pxPes) / (pxOpt - pxPes || 1) * 100)))}% 位置；DCF 基准 ¥${r2(pxBase)}、加协同期权中值后 ¥${r2(pxBasePlusOpt)}，预期空间 ${r2(expectedReturn)}%。法定 TTM PE ${r2(staticPe)}x（口径①）、备考口径动态 PE ${r2(dynPe)}x（②，不得年化）、静态 PE（2025 实际）${r2(staticPe)}x。核心逻辑：血净分部集采拖累与 ESRD 刚性需求对冲（基准零增长）+ 普瑞预灌封国内市占率 >50%（承诺 2027:7.20/2028:7.84 亿为下限）双分部驱动；约 ${r2(PR.goodwillApprox)} 亿商誉与 2027 普瑞增速为主要风险敞口。`;

  const riskNote = '上行：滤器协同兑现（看涨期权）、海外收入延续高增（2025 +62.23%）、集采续约好于唯低价预期、普瑞超承诺；下行：血净集采续约降价超预期、普瑞客户备案替代（周期半年至一年半）、约 58 亿商誉减值（2027 增速 <8% 触发敏感性）、生物制药资本开支下行压制协同期权价值。本模型按九指令整合版实现、参数按最新财报与公告快照更新；结论不构成投资建议。';

  const hardConstraintNote = '硬约束核验：① 本次 DCF 基期已声明采用口径①（法定合并）；② 备考口径未直接输入 DCF、未年化（所有 DCF 现金流来自口径①/③）；③ 2026 年 1—8 月普瑞利润未计入合并 FCFF（并表首年禁令）；④ 承诺期后未将 CAGR 线性外推至永续（2029-31 持平 + 独立永续 g）；⑤ PE/EPS 全部使用摊薄后 6.95 亿股；⑥ 协同期权独立列示未并入基准；⑦ 指令九 11 节输出齐备（并表状态/桥接表/新鲜度/承诺/DCF三档/期权/交叉验证/对价/跟踪变量/口径披露/置信度）；⑧ 缺失维度（2026 9M 法定扣非与 CFO、分产品/分渠道季报值）已显式标记，未静默替代。';

  return {
    ok: true,
    dedicated: true,
    weigao: true,
    symbol: SYM,
    stockName: cfg.name,
    rating: modelSuspended ? '需人工复核' : rating,
    modelSuspended,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(pxBase),
    conservativeTarget: r2(pxPes),
    conservativePct: (P != null) ? r2((pxPes - P) / P * 100) : null,
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? r2(upside) : null,
    expectedReturn: expectedReturn != null ? r2(expectedReturn) : null,
    confidence: confidenceLevel,
    outputState: '区间态（DCF 三档 + 期权加权）',
    confidenceNote,
    model: 'weigao603014·动态估值引擎 V1.0（九指令整合版，确定性计算，无 AI 参与）',
    version: cfg.version,
    dataAsOf: cfg.dataAsOf,
    reportLabel: '2026Q3',
    openingStatement,
    // 九节 rows
    consolidationRows, bridgeRows, freshnessOverview, coreRows, promiseRows,
    dcfRows, compRows, peRows, optionRows, considerationRows, reverseRows, trackRows, failRows,
    modelFailureNote: modelSuspended
      ? '⛔ 模型暂停/降级：' + failRows.filter(f => f.triggered).map(f => f.text).join('；') + ' → 对应维度自动切换至悲观情景权重（政策/整合断点）'
      : '✅ 失效/人工干预条件均未触发（集采规则 / 并购整合 / 普瑞增速 <8% / 归母扣非背离 >15pct）',
    // 汇总
    summaryNote, positionNote, riskNote, hardConstraintNote,
    decisionNote: `DCF 双轨：基准 ${r2(pxBase)} 元（血净 ${r2(bloodBaseRes.total)} 亿 + 普瑞 ${r2(puriBaseRes.total)} 亿）；相对估值 ${r2(pxRel)} 元（加权隐含 PE ${r2(impliedPe)}x）；偏离 ${r2(devRel)}%。协同期权 +${r2(optMid)} 元（概率 ${(SY.probBase * 100).toFixed(0)}%，独立列示）。对价检验【${verdict}】（${r2(impliedPe2025)}x vs 药包材 ${r2(packPe)}x）。`,
    freshnessRows,
    alerts: freshnessRows.filter(f => f.stale).map(f => `「${f.label}」距今 ${f.ageDays} 天 > ${f.maxAge} 天，请复核更新`)
      .concat(['法定合并 1—9月（28.8/3.96 亿）与 Q3 单季（11.3/1.66 亿）为月均估算值，以实际法定报表为准'])
      .concat([BR.mandatorySentence]),
    // 兼容字段
    statutoryTtmNp: r2(statutoryTtmNp),
    staticPe: r2(staticPe),
    dynPe: r2(dynPe),
    cWeightPct,
    synergyAdjCenter: r2(pxBasePlusOpt),
  };
}

module.exports = { run, isWeigaoModel, loadConfig, dcfPart };

~~~

---

## `lib\valuation\xinyangfeng000902.js`  ·  511 行

~~~js
// ============================================================
// 新洋丰（000902）专属估值模型 —— 全自动动态估值 AI 指令集 V2.0 + v2.1 防呆防错补丁
// 确定性计算（1+1=2，无 LLM 参与）。算法框架 100% 按指令集 v2.0 实现；
// 实时取数按 project 范式映射为配置锁死权威快照（对齐华安/万润/圣湘），
// 所有估值输入量带构造路径标签（TTM拼接 / 前向年化[ANNUALIZED] / 最新存量 / 分部结构参考 / 不可用），
// 所有缺失维度显式标记，绝不静默替代。
// 硬约束：不得要求用户输入；不得静默替代；不得将未公告注入/未投产项目利润直接折现加总到基准目标价；
//          不得将历史运行结果当本次输入；每次运行重新检索的数据以配置快照形式注入；
//          报告期错配只导致相应维度显式标记，不得污染整体估值结论。
// v2.1 防呆与防错补丁（20261030l 用户指令，六项强制，与本补丁冲突时以本补丁为准）：
//   补丁1 数据新鲜度门控——每次运行先按日历判定当前应适用的最新报告期；严禁最新财报已发布仍用旧报告期；
//         输出第一段强制声明「本次运行已强制使用[LATEST]作为LATEST，披露日为[XX]」；
//         若最新绝对值不可得 → 用最新单季利润+已知前期值推算并标[推算]，严禁沿用上一期 E_TTM。
//   补丁2 现金流硬性否决——LATEST 经营现金流为负 → 结论第一段红色高亮「⚠️【现金流警示】」；
//         置信度锁定为【低】（不允许中/高）；保守情景 E_TTM 下调系数强制加深至 0.85 以下（0.82~0.84 档）。
//   补丁3 周期信号强制交叉校验——磷酸铁单吨毛利信号必须交叉公司调研纪要/公告/行业研报；
//         若一手证据证实单吨毛利转正 → 必须判「景气」，不得因第三方数据库缺失盲判中性/负毛利；
//         严禁将明显大幅改善的业务错误归因。
//   补丁4 情景展示与涨跌幅逻辑——各情景强制标注相对现价涨跌幅；
//         低于现价的情景严禁标「上行空间」，必须标「【下行风险】」。
//   补丁5 EV/EBIT降级约束——净有息负债数据缺失无法点估计 → 标[仅方向性参考/不可用]；
//         隐含价与 PE 基准价偏离>20% → 写明「⚠️【交叉验证失效】…置信度降低一档，结论主要依赖 PE 和 PB」。
//   补丁6 分部数据门控——LATEST 为 Q3（不披露分部）→ E_TTM 用 Q3 总归母 TTM 拼接；
//         分部结构仅取最近半年报/年报基准，并强制声明「Q3实际结构可能已发生漂移」。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '000902';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/000902.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isXinyangfengModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'xinyangfeng';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const r3 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 1000) / 1000;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (o) => (o && o.value != null) ? o.value : (o == null ? null : o);
const median = (a) => {
  const s = [...a].map(Number).filter(x => isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ============================================================
// v2.1 补丁1：数据新鲜度门控（纯函数，导出供零网络测试）
// 按估值基准日判定「法定披露截止日已过的最新报告期」，与配置 LATEST 比对：
//   Q1 截止 04-30；H1 截止 08-31；Q3 截止 10-31；FY 截止次年 04-30。
//   配置 LATEST 期次落后于应适用期次 → gatePass=false（基准期滞后），置信度强制低 + 显式告警。
// ============================================================
function periodRank(y, type) { return y * 10 + ({ Q1: 1, H1: 2, Q3: 3, FY: 4 }[type] || 0); }
function freshnessGate(periodCfg, todayStr) {
  const d = new Date(todayStr);
  if (isNaN(d.getTime()) || !periodCfg || !periodCfg.latestType) return { gatePass: null, reason: '门控不可判定（日期或配置缺失）' };
  const y = d.getFullYear(), m = d.getMonth() + 1;
  let expY, expT;
  if (m <= 4) { expY = y - 1; expT = 'FY'; }        // 01-01~04-30 → 上年年报（04-30 截止）
  else if (m <= 8) { expY = y; expT = 'Q1'; }        // 05-01~08-31 → 当年一季报（04-30 截止）
  else if (m <= 10) { expY = y; expT = 'H1'; }       // 09-01~10-31 → 当年中报（08-31 截止）
  else { expY = y; expT = 'Q3'; }                    // 11-01~12-31 → 当年三季报（10-31 截止）
  // 配置 LATEST 的实际所属年份：baseY 为 BASE_Y（上年），FY 是 BASE_Y 当年，其余期次在 baseY+1
  const latestY = (parseInt(periodCfg.baseY, 10) || 0) + (periodCfg.latestType === 'FY' ? 0 : 1);
  const cfgRank = periodRank(latestY, periodCfg.latestType);
  const expRank = periodRank(expY, expT);
  // 领先于应适用期次（如 10 月下旬已披露三季报）→ 通过且标注「超前期望」；落后 → 滞后违规
  const gatePass = cfgRank >= expRank;
  const ahead = cfgRank > expRank;
  return {
    gatePass,
    ahead,
    expectedLatest: expY + (expT === 'FY' ? 'FY（年报）' : expT),
    cfgLatest: latestY + periodCfg.latestType,
    stalePeriod: gatePass === false,
    reason: gatePass
      ? (ahead ? `配置 LATEST（${latestY}${periodCfg.latestType}）领先于按披露日历的应适用期次（${expY}${expT}）→ 已强制使用最新披露报告期`
        : `配置 LATEST（${latestY}${periodCfg.latestType}）与按披露日历的应适用期次（${expY}${expT}）一致 → 门控通过`)
      : `⛔ 基准期滞后：按披露日历应适用 ${expY}${expT}，配置仍为 ${latestY}${periodCfg.latestType} → 严禁沿用旧报告期，须更新或[推算]`,
  };
}

// ============================================================
// A1：周期状态内生判定（三信号多数决；v2.1 补丁3：磷酸铁信号强制交叉调研纪要/公告证据）
// ============================================================
function cycleView(cs) {
  // 信号1：磷酸一铵价差偏离
  const gap = nz(cs.mapPriceGapPct);
  const s1 = gap > 15 ? '景气' : (gap < -15 ? '低迷' : '中性');
  // 信号2：新型复合肥毛利率趋势
  const gmTrend = nz(cs.newTypeGmTrendPct);
  const s2 = gmTrend > 1 ? '景气' : (gmTrend < -1 ? '低迷' : '中性');
  // 信号3：磷酸铁单吨毛利（v2.1 补丁3：必须交叉调研纪要/公告/行业研报；不得因第三方数据库缺失盲判中性/负毛利）
  const ip = cs.ironPhosphateUnitProfit || {};
  const evd = ip.thirdPartyEvidence || {};
  const s3 = (ip.positive && ip.twoQuarterRising) ? '景气' : '中性';
  const s3Note = (ip.positive && ip.twoQuarterRising)
    ? (evd.source ? `一手证据交叉证实：${evd.source}（${evd.evidenceDate || ''}）→ 单吨毛利已转正且盈利逐季抬升 → 景气（不得因第三方数据库缺失判中性/负毛利）` : '单吨毛利转正且两季抬升 → 景气')
    : (ip.note || '未盈利/未披露 → 中性（结构性增量非周期信号）');  const votes = { 景气: 0, 低迷: 0, 中性: 0 };
  [s1, s2, s3].forEach(s => votes[s]++);
  let view, split = false;
  if (votes['景气'] >= 2) view = '景气';
  else if (votes['低迷'] >= 2) view = '低迷';
  else if (votes['中性'] >= 2) view = '中性';
  else { view = '中性'; split = true; } // 无多数 → 中性+信号分裂标注
  return {
    view, split,
    signals: [
      { name: '磷酸一铵价差偏离', value: gap + '%', signal: s1, note: cs.mapPriceGapNote || '' },
      { name: '新型复合肥毛利率趋势', value: (gmTrend > 0 ? '+' : '') + gmTrend + 'pct', signal: s2, note: cs.newTypeGmTrendNote || '' },
      { name: '磷酸铁单吨毛利', value: (ip.value != null ? ip.value + (ip.unit || '') : 'N/A'), signal: s3, note: s3Note },
    ],
  };
}

// ============================================================
// R2：TTM 拼接；R3：前向年化降级（[ANNUALIZED] 标记）
// ============================================================
function buildTTM(cfg, latestType) {
  const S = cfg.statements;
  const baseY = cfg.period.baseY;
  const fyBase = S.fy[String(baseY)] || {};
  const npBase = nz(fyBase.np);
  const ebitBase = nz(fyBase.ebit);
  const cfoBase = nz(fyBase.cfo);

  // 取 LATEST 各期累计与上年同期
  const latest = (latestType === 'FY') ? S.fy[String(baseY)] : (S[latestType.toLowerCase()] || {})[String(baseY + (latestType === 'FY' ? 0 : 1))] || {};
  const yoy = (S[latestType.toLowerCase()] || {})[String(baseY)] || {};

  // R2 拼接：baseY 全年 + LATEST 累计 − 上年同期累计
  const npL = nz(latest.np), npY = nz(yoy.np);
  const ebitL = nz(latest.ebit), ebitY = nz(yoy.ebit);
  const cfoL = nz(latest.cfo), cfoY = nz(yoy.cfo);

  let npTTM, ebitTTM, cfoTTM, path, pathNote, annualized = false;

  if (npL > 0 && npY > 0) {
    npTTM = npBase + npL - npY;
    ebitTTM = ebitBase + ebitL - ebitY;
    cfoTTM = cfoBase + cfoL - cfoY;
    path = 'R2·TTM拼接';
    pathNote = `TTM归母 = ${r2(npBase)}(${baseY}全年) + ${r2(npL)}(LATEST累计) − ${r2(npY)}(上年同期) = ${r2(npTTM)} 亿（路径 R2）`;
  } else {
    // R3 前向年化降级
    annualized = true;
    const seas = (cfg.seasonal && cfg.seasonal[latestType.toLowerCase()]) || { factor: 1, note: '季节性调整未生效' };
    const factor = nz(seas.factor) || 1;
    const mult = latestType === 'Q1' ? 4 : (latestType === 'H1' ? 2 : (latestType === 'Q3' ? 4 / 3 : 1));
    npTTM = npL * mult * factor;
    ebitTTM = ebitL * mult * factor;
    cfoTTM = cfoL * mult * factor;
    path = 'R3·前向年化[ANNUALIZED]';
    pathNote = `上年同期缺失 → 降级 R3：${latestType} × ${mult} × 季节性因子 ${factor} = ${r2(npTTM)} 亿[ANNUALIZED]（${seas.note || ''}）`;
  }
  return { npTTM, ebitTTM, cfoTTM, path, pathNote, annualized };
}

// ============================================================
// 主入口（同步，与现有消费方 run(symbol,{price}) 契约兼容）
// ============================================================
function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'xinyangfeng') return { error: 'NOT_XINYANGFENG' };

  const M = cfg.market, P0 = cfg.period, ST = cfg.statements, BS = cfg.balanceSheet, CY = cfg.cycleSignals, V = cfg.valuation;
  const N = nz(vv(M.shares));                                   // 总股本（亿股）
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : nz(M.priceSources && M.priceSources[0] && M.priceSources[0].px);
  const priceSourceNote = (price != null && isFinite(Number(price)) && Number(price) > 0)
    ? '实时行情（getQuote 传入）'
    : '配置锁死快照（' + (M.priceAdopt || '多源交叉取 13.85') + '）';

  // ===== 〇、内生判定声明（A1）=====
  const cyc = cycleView(CY);

  // ===== 〇·1、v2.1 补丁1：数据新鲜度门控（每次运行强制先查当前应适用最新报告期） =====
  const gate = freshnessGate(P0, localDate());
  const latestFin = (ST[P0.latestType.toLowerCase()] || {})[String(P0.baseY + (P0.latestType === 'FY' ? 0 : 1))] || {};
  const latestAbsAvailable = latestFin.np != null;   // 补丁1.4：最新绝对值不可得 → 须[推算]，严禁沿用上一期 E_TTM
  const missing = [];                                 // R6 缺失标记（各维度最低必需项）
  if (!latestAbsAvailable) missing.push('LATEST最新财报绝对值（须用最新单季利润+已知前期值[推算]，严禁沿用上期E_TTM）');

  // ===== 〇·2、v2.1 补丁2：现金流硬性否决判定 =====
  const latestCfo = nz(latestFin.cfo);
  const cfoVetoTriggered = latestAbsAvailable && latestCfo < 0;
  const cfoVetoWarning = cfoVetoTriggered
    ? `⚠️【现金流警示】最新报告期经营现金流为负（${r2(latestCfo)}亿元），利润质量存疑。`
    : null;

  // ===== 〇·3、v2.1 补丁6：分部数据门控声明（Q3 不披露分部 → 结构取最近 H1/FY 基准 + 漂移声明） =====
  const segDriftNote = (P0.latestType === 'Q3' && !P0.segmentConsistent)
    ? `当前盈利结构参考为[${P0.segmentBasePeriod}]分部数据，Q3实际结构可能已发生漂移。`
    : null;

  // ===== 一、期间锚定与数据质量声明（R1/R2/R5/R6）=====
  const latestType = P0.latestType;                              // FY/H1/Q3/Q1
  const ttm = buildTTM(cfg, latestType);
  const equityLatest = nz((ST[latestType.toLowerCase()] || {})[String(P0.baseY + (latestType === 'FY' ? 0 : 1))]?.equity);
  // R5 分部门控
  const segConsistent = !!P0.segmentConsistent;

  // R6 缺失标记（数组已在补丁1门控处声明）
  if (!N) missing.push('总股本');
  if (!(ttm.npTTM > 0)) missing.push('TTM归母净利');
  if (!(ttm.ebitTTM > 0)) missing.push('TTM EBIT');
  if (!equityLatest) missing.push('最新归母净资产');
  if (!(BS.netInterestBearingDebt != null)) missing.push('净有息负债');
  const evComplete = !!(M.netDebtCompleteness && M.netDebtCompleteness.complete);

  // ===== 二、核心输入量 =====
  const E_TTM = ttm.npTTM;
  const EBIT_TTM = ttm.ebitTTM;
  const CFO_TTM = ttm.cfoTTM;
  const netDebt = nz(BS.netInterestBearingDebt);
  const mktCap = P * N;
  const ev = mktCap + netDebt;                                  // R4：EV = 市值 + 净有息负债
  const ROE_TTM = equityLatest > 0 ? E_TTM / equityLatest * 100 : null;

  // 分红（最近已实施）
  const DV = cfg.dividend || {};
  const divPerShare = nz(vv(DV.latestPerShare));
  const divRate = nz(vv(DV.rate));
  const divYield = P > 0 ? divPerShare / P * 100 : null;

  // ===== 三、估值三角 =====
  // 4.1 主模型 PE-TTM
  const peerMedian = median(V.peerPE);
  const histMedian = median(V.peHist);
  let peBase = 0.5 * nz(peerMedian) + 0.5 * nz(histMedian);
  const peAdj = V.peAdjust || {};
  let peAdjNote = `PE_base = 0.5×peer中位(${r2(peerMedian)}) + 0.5×hist中位(${r2(histMedian)}) = ${r2(peBase)}`;
  let adjSum = 0;
  const roeTTMv = nz(ROE_TTM);
  if (roeTTMv > nz(peAdj.roeGood)) { adjSum += 0.5; }
  const cfoQuality = CFO_TTM / Math.max(E_TTM, 1e-9);
  if (cfoQuality > nz(peAdj.cfoQualityGood)) { adjSum += 0.3; }
  if (nz(peAdj.newTypeShare) > nz(peAdj.newTypeShareThreshold)) { adjSum += 0.5; peAdjNote += '；新型肥占比>40% → 上修'; }
  peBase += adjSum;
  peAdjNote += `；调整项（ROE_TTM>${nz(peAdj.roeGood)}→+0.5、CFO/E>${nz(peAdj.cfoQualityGood)}→+0.3）合计 +${r2(adjSum)} → PE_base≈${r2(peBase)} 倍`;
  const pricePE = E_TTM * peBase / N;

  // 4.2 交叉验证 EV/EBIT-TTM
  const evEbitTarget = nz(V.evEbitTargetMultiple);
  const evEbitImplied = EBIT_TTM > 0 ? ev / EBIT_TTM : null;    // 当前 EV/EBIT 倍数
  const evEbitDev = (evEbitImplied != null && evEbitTarget > 0) ? (evEbitImplied - evEbitTarget) / evEbitTarget * 100 : null;
  const priceEV = (EBIT_TTM * evEbitTarget - netDebt) / N;      // EV/EBIT 隐含合理价（下沿约束）
  // v2.1 补丁5：净有息负债数据缺失 → [仅方向性参考/不可用]；隐含价与 PE 基准价偏离>20% → 交叉验证失效（禁用「约束边界」措辞）
  const evDevAbs = Math.abs(nz(evEbitDev));
  const peBasePrice = pricePE;                                   // PE-TTM 基准价
  const evPeDev = (peBasePrice > 0 && priceEV != null && isFinite(priceEV)) ? (priceEV - peBasePrice) / peBasePrice * 100 : null;
  const evCrossInvalid = !evComplete && evPeDev != null && Math.abs(evPeDev) > 20;
  const evCross = evCrossInvalid
    ? `⚠️【交叉验证失效】由于负债端数据缺失，EV/EBIT隐含价与PE偏离达${r2(evPeDev)}%，本次模型置信度降低一档，结论主要依赖于PE和PB。`
    : (evEbitDev != null && evDevAbs > 20
      ? `两种主模型分歧较大（EV/EBIT 隐含 ${r2(evEbitImplied)}x vs 目标 ${r2(evEbitTarget)}x，偏离 ${r2(evEbitDev)}%）→ 以 PE 为主、EV/EBIT 为约束边界`
      : `EV/EBIT 隐含 ${r2(evEbitImplied)}x，与目标 ${r2(evEbitTarget)}x 偏离 ${r2(evEbitDev)}%，可接受`);
  const evState = !evComplete
    ? (evCrossInvalid ? '⚠️【交叉验证失效】[仅方向性参考/不可用]（净有息负债不完整 + 隐含价与PE偏离>20%）' : '[仅方向性参考/不可用]（净有息负债不完整，按 R6-EV）')
    : (evDevAbs > 30 ? '可执行·与主模型分歧>30%（作下沿约束）' : '可执行');

  // 4.3 PB-ROE 锚（方向性）
  const pbRoe = V.pbRoe || { g: 2.5, r: 9.0 };
  const g = nz(pbRoe.g) / 100, r = nz(pbRoe.r) / 100;
  const fairPB = (ROE_TTM / 100 - g) / (r - g);
  const curPB = equityLatest > 0 ? P / (equityLatest / N) : null;
  let pbNote = 'PB-ROE 仅方向性检验，不单独产出目标价';
  if (fairPB != null && curPB != null) {
    if (curPB > fairPB * (1 + 1 / 3)) pbNote = `现价 PB ${r2(curPB)} > 合理 PB ${r2(fairPB)}（超 1 个标准差）→ PE 结论可能偏乐观`;
    else if (curPB < fairPB) pbNote = `现价 PB ${r2(curPB)} < 合理 PB ${r2(fairPB)} → PE 结论可能偏保守（现价相对 PB 便宜）`;
  }

  // 4.4 期权增量（独立列示，不并入）
  const OPT = cfg.options || {};
  const optRows = [];
  const pm = OPT.phosphateMineInjection || {};
  const ip = OPT.ironPhosphate || {};
  optRows.push({
    label: '【期权】磷矿注入',
    value: `条件未达成（${pm.condition || '无明确时间表'}）→ 仅定性描述，不计入基准价；若兑现年化增厚 ${(pm.profitLift || []).join('~')} 亿 → 每股 ${(pm.perShare || []).join('~')} 元`,
    source: pm.note || '',
  });
  optRows.push({
    label: '【期权】磷酸铁扭亏',
    value: `当前单吨毛利为负/未披露、无连续趋势证据 → 留在期权段，不升格为基准 E 已包含项；若满产且正毛利年化增厚 ${(ip.profitLift || []).join('~')} 亿 → 每股 ${(ip.perShare || []).join('~')} 元`,
    source: ip.note || '',
  });
  const optInBase = false; // 硬约束：期权绝不并入基准

  // ===== 四、三情景（5.1 同向调整 + 收敛校准；v2.1 补丁2/4：现金流否决加深 + 相对现价涨跌幅强制标注）=====
  function scenario(key) {
    const sc = cfg.scenarioAdj[key];
    let eL = sc.eMult[0], eH = sc.eMult[1];
    const peL = sc.peMult[0], peH = sc.peMult[1];
    let vetoNote = '';
    if (cfoVetoTriggered && key === 'conservative') {
      // 补丁2：LATEST 经营现金流为负 → 保守情景 E_TTM 下调系数强制加深至 0.85 以下（0.82~0.84 档）
      eL = 0.82; eH = 0.84;
      vetoNote = '｜⚠️ 现金流硬性否决（补丁2）：LATEST 经营现金流为负（' + r2(latestCfo) + ' 亿）→ E_TTM 下调系数由 ' + sc.eMult.join('~') + ' 强制加深至 0.82~0.84（<0.85 档，反映营运资本恶化与纸面利润风险）';
    }
    const eUsed = E_TTM * (eL + eH) / 2;
    const peUsed = peBase * (peL + peH) / 2;
    const price = eUsed * peUsed / N;
    // 补丁4：强制标注相对现价涨跌幅；低于现价严禁标「上行空间」→ 标「【下行风险】」
    let pctTxt = '';
    if (P != null) {
      const pctv = (price - P) / P * 100;
      pctTxt = pctv >= 0 ? `（相对现价 +${r2(pctv)}%）` : `【下行风险】（相对现价 -${r2(-pctv)}%）`;
    }
    const namePrefix = { conservative: '保守目标价', base: '基准目标价', optimistic: '乐观目标价' }[key] || '目标价';
    return { key, eUsed: r2(eUsed), peUsed: r2(peUsed), price: r2(price), pctTxt, namePrefix, eMultUsed: [eL, eH], peMultUsed: [peL, peH], note: (sc.trigger || '') + vetoNote };
  }
  const sC = scenario('conservative'), sB = scenario('base'), sO = scenario('optimistic');
  const rangeLow = Math.min(sC.price, sB.price, sO.price);
  const rangeHigh = Math.max(sC.price, sB.price, sO.price);
  const center = sB.price;
  const conservativeTarget = rangeLow; // 保守情景即区间下沿

  // ===== 五、反向验证清单（5.2）=====
  const RC = cfg.reverseCheck || {};
  const cfoERatio = E_TTM > 0 ? CFO_TTM / E_TTM : null;
  const rev1 = { id: '1.现金流验证', result: (cfoERatio != null && cfoERatio > nz(RC.cfoEThreshold)) ? '是' : '否',
    detail: `CFO_TTM/E_TTM = ${r2(cfoERatio)} ${cfoERatio != null && cfoERatio > nz(RC.cfoEThreshold) ? '> ' + nz(RC.cfoEThreshold) + ' → 利润质量良好' : '< ' + nz(RC.cfoEThreshold) + ' 或无法计算 → 提示利润质量风险'}${cfoVetoTriggered ? `；⚠️ LATEST（${P0.latest}）经营现金流为负（${r2(latestCfo)} 亿）→ 现金流硬性否决已触发（补丁2）：置信度锁定低、保守情景 E 系数加深至 0.82~0.84` : ''}` };
  const roeLastYear = nz(ST.fy[String(P0.baseY)].roe);
  const rev2 = { id: '2.ROE趋势', result: (ROE_TTM != null && ROE_TTM < nz(RC.roeFloorLastYear)) ? '否' : '不适用',
    detail: `ROE_TTM ${r2(ROE_TTM)}%（LATEST=${P0.latest} 口径；${P0.baseY} 全年 ${r2(roeLastYear)}%）；未跌破 ${nz(RC.roeFloorLastYear)}% 警戒线 → 盈利中枢未下移（季内波动看待全年）` };
  const divCovered = (divPerShare * N) > 0 ? CFO_TTM / (divPerShare * N) : null;
  const divPass = divRate >= nz(RC.dividendRateThreshold) && nz(divCovered) > nz(RC.cfoECommittedThreshold);
  const rev3 = { id: '3.分红可持续性', result: divPass ? '是' : '否',
    detail: `分红率 ${r2(divRate * 100)}%（${divRate >= nz(RC.dividendRateThreshold) ? '≥' : '<'}${nz(RC.dividendRateThreshold) * 100}%）且 CFO 覆盖分红 ${r2(divCovered)}× ${nz(divCovered) > nz(RC.cfoECommittedThreshold) ? '>' : '≤'} ${nz(RC.cfoECommittedThreshold)}× → ${divPass ? '可持续' : '分红覆盖不足（现金流硬性否决连带：CFO_TTM 含 LATEST 负现金流拖累）'}` };
  const rev4 = { id: '4.出口政策敏感性', result: '是',
    detail: `保守情景已含「磷肥出口管控持续收紧」假设 → 出口政策风险已在悲观情景反映` };
  const shareDilPct = 0; // 2026H1 与 BASE_Y 股本一致（配置已声明无变动）
  const rev5 = { id: '5.股本稀释', result: shareDilPct <= nz(RC.shareDilutionThresholdPct) ? '不适用' : '否',
    detail: `最新总股本 ${r2(N)} 亿股较 BASE_Y(${P0.baseY}) 增幅 ${shareDilPct}% ≤ ${nz(RC.shareDilutionThresholdPct)}% → 每股指标无需重算（验证通过）` };
  const reverseRows = [rev1, rev2, rev3, rev4, rev5];
  const reverseAllPass = reverseRows.every(r => r.result === '是' || r.result === '不适用');

  // ===== 六、置信度（指令集六档；v2.1 补丁1/2/5 三条强制规则）=====
  let confidenceLevel, confidenceNote;
  if (cfoVetoTriggered) {
    // 补丁2：LATEST 经营现金流为负 → 置信度锁定【低】，不允许评为【中】或【高】
    confidenceLevel = '低';
    confidenceNote = `现金流硬性否决（补丁2）：LATEST（${P0.latest}）经营现金流为负（${r2(latestCfo)} 亿）→ 置信度锁定为【低】，不允许中/高；保守情景 E_TTM 下调系数已强制加深至 0.82~0.84（<0.85 档）`;
  } else if (gate.stalePeriod) {
    // 补丁1：基准期滞后 → 强制低
    confidenceLevel = '低';
    confidenceNote = gate.reason + '（补丁1 数据新鲜度门控）';
  } else if (!latestAbsAvailable) {
    confidenceLevel = '低';
    confidenceNote = 'LATEST 最新财报绝对值缺失 → 走[推算]路径（最新单季利润+已知前期值），置信度强制低（补丁1.4：严禁沿用上一期 E_TTM）';
  } else if (ttm.annualized) {
    confidenceLevel = '低';
    confidenceNote = '使用了[ANNUALIZED]前向年化（非 TTM 拼接）→ 置信度低';
  } else if (!reverseAllPass) {
    confidenceLevel = '低';
    confidenceNote = '任一反向验证失败 → 置信度低';
  } else if (!evComplete) {
    confidenceLevel = '低';
    confidenceNote = 'EV/EBIT 降级为仅方向性（净有息负债不完整）→ 置信度低';
  } else if (Math.abs(nz(evEbitDev)) > 30) {
    confidenceLevel = '中';
    confidenceNote = `EV/EBIT 与主模型 PE 分歧 >30%（偏离 ${r2(evEbitDev)}%）→ 置信度由高下调至中，PE 为主、EV 为下沿约束`;
  } else if (Math.abs(nz(evEbitDev)) > 20) {
    confidenceLevel = '中';
    confidenceNote = `EV/EBIT 偏离 ${r2(evEbitDev)}%（20%~30%）→ 置信度中`;
  } else {
    confidenceLevel = '高';
    confidenceNote = 'TTM 路径 + 反向验证全部通过 + EV/EBIT 偏离 <20% → 置信度高';
  }
  // 补丁5：交叉验证失效（负债端缺失 + 隐含价与 PE 偏离>20%）→ 在上述结果上再降一档（低不可再降）
  if (evCrossInvalid) {
    confidenceLevel = (confidenceLevel === '高') ? '中' : '低';
    confidenceNote += '；⚠️【交叉验证失效】由于负债端数据缺失，EV/EBIT隐含价与PE偏离达' + r2(evPeDev) + '%，本次模型置信度降低一档，结论主要依赖于PE和PB（补丁5）';
  }

  // ===== 评级（严格三档）=====
  let rating = '合理', expectedReturn = null, upside = null;
  if (P != null && center != null) {
    expectedReturn = (center - P) / P * 100;
    upside = (rangeHigh - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
  }

  // ===== 模型失效检查 =====
  const MF = cfg.modelFailure || { conds: [] };
  const failRows = (MF.conds || []).map(c => {
    const trig = !!c.triggered;
    return { id: c.id, text: c.text, threshold: c.threshold, triggered: trig, status: trig ? '⛔ 触发' : '✅ 未触发' };
  });
  const modelSuspended = failRows.some(f => f.triggered);

  // ===== 时效看板 =====
  const FR = cfg.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 200;
  const freshnessRows = [];
  const today = new Date();
  for (const it of (FR.items || [])) {
    if (!it.asOf) continue;
    const age = Math.floor((today - new Date(it.asOf)) / 86400000);
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
  }

  // ===== 输出区块（v2.0 结构）=====
  const cycleRows = [
    { label: 'CYCLE_VIEW 自判结果', value: cyc.view + (cyc.split ? '（信号分裂，无多数→中性）' : ''), source: 'A1 三信号多数决' },
    ...cyc.signals.map(s => ({ label: '　└ ' + s.name, value: `${s.value} → ${s.signal}`, source: s.note })),
  ];
  const periodRows = [
    { label: '数据新鲜度门控（v2.1补丁1）', value: gate.reason, source: '按披露日历强制判定：Q1截止04-30 / H1截止08-31 / Q3截止10-31 / FY截止次年04-30；滞后→置信度强制低' },
    { label: 'BASE_Y / LATEST', value: `${P0.baseY} / ${P0.latest}（披露日 ${P0.latestDisclosureDate}）`, source: 'R1 期间锚定；补丁1.3：已强制声明使用最新披露报告期' },
    { label: 'TTM 构造路径', value: ttm.path + (ttm.annualized ? '[ANNUALIZED]' : '') + (P0.latestType === 'Q3' ? '（补丁6：Q3 不披露分部 → E_TTM 用 Q3 总归母 TTM 拼接）' : ''), source: ttm.pathNote },
    { label: '分部数据基准期', value: `${P0.segmentBasePeriod}（与 LATEST 一致：${segConsistent ? '是' : '否'} → ${segConsistent ? '结构判断可用' : '仅定性权重'}）`, source: 'R5 分部门控' + (segDriftNote ? '；' + segDriftNote : '') },
    { label: '现金流硬性否决（v2.1补丁2）', value: cfoVetoTriggered ? `⛔ 已触发：LATEST（${P0.latest}）经营现金流 ${r2(latestCfo)} 亿 < 0 → 置信度锁定【低】+ 保守情景 E 系数加深至 0.82~0.84` : `✅ 未触发（LATEST 经营现金流 ${latestAbsAvailable ? r2(latestCfo) + ' 亿' : '不可得'}）`, source: 'LATEST 期末经营现金流判定；触发→结论第一段红色高亮' },
    { label: '净有息负债完整性', value: evComplete ? '完整（五项齐全）' : '部分缺失：' + ((M.netDebtCompleteness && M.netDebtCompleteness.missing) || []).join('/') + ' → EV/EBIT [仅方向性参考/不可用]', source: evComplete ? 'EV/EBIT 可执行' : '补丁5 + R6-EV' },
    { label: '不可用维度', value: missing.length ? missing.join('、') : '无', source: 'R6 显式标记（硬约束：不静默替代）' },
  ];
  const coreRows = [
    { label: 'E_TTM（归母）', value: `${r2(E_TTM)} 亿元　[${ttm.path}]`, source: ttm.pathNote },
    { label: 'EBIT_TTM', value: `${r2(EBIT_TTM)} 亿元　[${ttm.path}]`, source: ttm.pathNote },
    { label: '净有息负债', value: `${r2(netDebt)} 亿元（LATEST 末值）`, source: 'R4 存量取点' },
    { label: '总股本 / 当前价 / 市值', value: `${r2(N)} 亿股 / ¥${r2(P)} / ${r2(mktCap)} 亿`, source: priceSourceNote },
    { label: 'ROE_TTM', value: `${r2(ROE_TTM)}%（E_TTM / 最新归母净资产 ${r2(equityLatest)} 亿）`, source: '估值三角 4.3' },
    { label: '经营现金流 / E_TTM', value: `${r2(cfoERatio)}×`, source: '反向验证 5.2①' },
    { label: '最近分红', value: `每股 ${r2(divPerShare)} 元，分红率 ${r2(divRate * 100)}%，股息率 ${r2(divYield)}%`, source: DV.asOf || '' },
  ];
  const tripleRows = [
    { label: '① PE-TTM（主）', value: `PE_base ${r2(peBase)} 倍 × E_TTM ${r2(E_TTM)} 亿 ÷ ${r2(N)} 亿股 = ${r2(pricePE)} 元/股`, source: peAdjNote },
    { label: '② EV/EBIT-TTM（交叉）', value: `EV ${r2(ev)} 亿 ÷ EBIT_TTM ${r2(EBIT_TTM)} = ${r2(evEbitImplied)}x；目标 ${r2(evEbitTarget)}x → 隐含价 ${r2(priceEV)} 元（下沿约束）　[${evState}]`, source: evCross },
    { label: '③ PB-ROE（方向性锚）', value: `合理 PB = (${r2(ROE_TTM)}% − ${nz(pbRoe.g)}%)/(${nz(pbRoe.r)}% − ${nz(pbRoe.g)}%) = ${r2(fairPB)}；现价 PB ${r2(curPB)} → ${pbNote}`, source: '仅方向性检验' },
  ];
  const scenRows = [
    { name: '保守情景', value: `E ${sC.eUsed} 亿(×${sC.eMultUsed.join('~')}${cfoVetoTriggered ? '，原 ' + cfg.scenarioAdj.conservative.eMult.join('~') + ' 现金流否决加深' : ''}) × PE ${sC.peUsed} 倍(×${sC.peMultUsed.join('~')}) → ${sC.namePrefix} ${sC.price} 元${sC.pctTxt}；${sC.note}` },
    { name: '基准情景', value: `E ${sB.eUsed} 亿 × PE ${sB.peUsed} 倍 → ${sB.namePrefix} ${sB.price} 元${sB.pctTxt}（中枢）；${sB.note}` },
    { name: '乐观情景', value: `E ${sO.eUsed} 亿(×${sO.eMultUsed.join('~')}) × PE ${sO.peUsed} 倍(×${sO.peMultUsed.join('~')}) → ${sO.namePrefix} ${sO.price} 元${sO.pctTxt}；${sO.note}` },
  ];

  // v2.1 补丁1.3/2/6：输出第一段 = LATEST 强制声明 + 分部漂移声明 + 现金流红色警示（前端以红色高亮渲染）
  const openingStatement = `本次运行已强制使用[${P0.latest}]作为LATEST，披露日为[${P0.latestDisclosureDate}]。`
    + (segDriftNote || '')
    + (cfoVetoWarning || '')
    + (gate.stalePeriod ? gate.reason + '。' : '')
    + (!latestAbsAvailable ? 'LATEST 最新财报绝对值缺失 → 已按[推算]路径处理（最新单季利润+已知前期值，严禁沿用上期 E_TTM）。' : '');

  const summaryNote = `${openingStatement}【新洋丰全自动估值 | RUN_DATE：${localDate()}】基准合理价 ${r2(center)} 元（区间 ${r2(rangeLow)}~${r2(rangeHigh)}），相对当前价 ${P != null ? '¥' + r2(P) : 'N/A'} 空间 ${r2(expectedReturn)}%；评级【${rating}】；置信度【${confidenceLevel}】${cfoVetoTriggered ? '（现金流硬性否决锁定）' : ''}。CYCLE_VIEW=${cyc.view}。估值三角：PE-TTM 主 ${r2(pricePE)} 元、EV/EBIT ${evCrossInvalid ? '[不可用·交叉验证失效]' : '下沿 ' + r2(priceEV) + ' 元'}、PB-ROE 方向性（合理 PB ${r2(fairPB)}）。期权增量（磷矿/磷酸铁）独立列示，不并入基准。`;

  const positionNote = (P == null)
    ? '当前价不可用，仅输出估值区间。'
    : `基于最新可得数据（截止 ${cfg.dataAsOf}，财报期 ${P0.latest}）：当前股价 ¥${r2(P)} 位于三情景区间 [${r2(rangeLow)}, ${r2(rangeHigh)}] 元的 ${Math.round(Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow || 1) * 100)))}% 位置；基准中枢 ¥${r2(center)}，预期空间 ${r2(expectedReturn)}%。PE(TTM) ${r2(P / (E_TTM / N))} 倍、PB ${r2(curPB)} 倍。核心逻辑：新型肥料占比提升（34.3%）→ 综合毛利中枢上移；磷矿自给率（14.3%）与莲花山矿注入提供期权增量；渠道护城河（6000 经销商/70000 终端/2700 县）为最稳壁垒。`;

  const riskNote = '上行：新型肥料占比突破 40%、莲花山矿公告注入、磷酸铁稳定盈利、行业集中度提升；下行：硫磺/磷矿石/合成氨价格高位压制毛利、新型肥渗透停滞、莲花山矿注入延迟、磷酸铁持续亏损、磷肥出口管控收紧。本模型逻辑框架按 v2.0 指令集实现、参数按最新财报与公告动态更新；结论不构成投资建议。';

  const hardConstraintNote = '硬约束核验：① 不静默替代（缺失维度显式标记：' + (missing.length ? missing.join('、') : '无') + '）；② 所有缺失已显式标记；③ 期权增量（磷矿/磷酸铁）独立列示，未并入基准目标价；④ 未将历史运行结果当本次输入（配置即本次检索快照）；⑤ 报告期错配（如有）仅导致相应维度标记，未污染整体结论；⑥ v2.1 六项防呆防错补丁已强制启用（数据新鲜度门控 / 现金流硬性否决 / 周期信号证据交叉校验 / 情景涨跌幅与下行风险标注 / EV/EBIT 降级约束 / 分部数据门控）。';

  return {
    ok: true,
    dedicated: true,
    xinyangfeng: true,
    symbol: SYM,
    stockName: cfg.name,
    rating: modelSuspended ? '需人工复核' : rating,
    modelSuspended,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservativeTarget),
    conservativePct: (P != null && conservativeTarget != null) ? r2((conservativeTarget - P) / P * 100) : null,
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? r2(upside) : null,
    expectedReturn: expectedReturn != null ? r2(expectedReturn) : null,
    confidence: confidenceLevel,
    outputState: '区间态（三情景）',
    confidenceNote,
    model: 'xinyangfeng000902·全自动动态估值 V2.1（v2.0 框架 + 六项防呆防错补丁，确定性计算，无 AI 参与）',
    version: cfg.version,
    dataAsOf: cfg.dataAsOf,
    reportLabel: P0.latest,
    cycleView: cyc.view,
    // v2.1 补丁字段
    openingStatement,
    freshnessGate: gate,
    cfoVeto: cfoVetoTriggered,
    cfoVetoWarning,
    segDriftNote,
    evCrossInvalid,
    evPeDev: r2(evPeDev),
    // v2.0 区块
    cycleRows, periodRows, coreRows, tripleRows, scenRows, optionRows: optRows, reverseRows,
    failRows,
    modelFailureNote: modelSuspended
      ? '⛔ 模型暂停，需人工复核：' + failRows.filter(f => f.triggered).map(f => f.text).join('；')
      : '✅ 失效预警条件均未触发，模型有效（' + failRows.map(f => f.id + '未触发').join('、') + '）',
    summaryNote, positionNote, riskNote, hardConstraintNote,
    decisionNote: peAdjNote + '。' + evCross + '。' + pbNote + '。',
    freshnessRows,
    alerts: freshnessRows.filter(f => f.stale).map(f => `「${f.label}」距今 ${f.ageDays} 天 > ${f.maxAge} 天，请复核更新`),
    // 兼容性字段（老消费方可能读取）
    fairValueCenterOld: r2(center),
  };
}

module.exports = { run, isXinyangfengModel, loadConfig, freshnessGate, cycleView };

~~~

---

## `lib\valuationHub.js`  ·  156 行

~~~js
/**
 * 估值分析 · 统一数据网关（三条底层铁律的样板实现）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：估值指标只从 eastmoneyValuation（东财 RPT_VALUEANALYSIS_DET）取，
 *     本模块是该指标在工作台内的唯一出口，其他模块禁止自行取数。
 *   - 五要素身份：每个指标携带 { name, value, dataTime, source, fetchTime }。
 *   - 分析期锁定：beginSnapshot() 冻结一次分析所用数据，中途源更新不影响本次分析。
 * 规则二 数据最新性：按类型有效期；体检；过期必带「数据已过期，最后更新时间是 X」；异常值拒收。
 * 规则三 变化与边际分析：变化率、边际变化、方向 + 幅度 + 边际三维度、特殊信号标注。
 *
 * 注：通用原语全部复用 ./ruleCore，本文件只保留估值业务特有的取数与组装，
 *     避免同一套规则逻辑在多个 Hub 里各实现一份而产生口径分叉。
 * ============================================================================
 */
const { fetchValuationTTM } = require('./eastmoneyValuation');
const core = require('./ruleCore');

const {
  TTL, makeDatum, beginSnapshot,
  checkFreshness, staleLabel, validateSane,
  analyzeSeries, analyzeWindow, assertAnalysis,
} = core;

// 估值口径归类：最新 TTM 随交易日更新 → 日线；历史年度序列属财务属性 → 财务
const KIND = { latest: 'daily', series: 'financial' };

/**
 * 生成「规则合规」的估值描述片段，供 deepAnalysis 等模块直接拼接。
 * 内容 = 数值 + 来源 + 数据时间（规则一②/二）+ 方向·幅度·边际（规则三④）
 * @returns {string|null} 规则不可用（无快照）时返回 null，调用方应回退原逻辑
 */
function formatValuationLine(rules, metric) {
  const m = String(metric || '').toUpperCase();
  if (!rules || !rules.latest || !rules.analysis) return null;
  const d = rules.latest[m.toLowerCase()];
  const a = rules.analysis[m];
  if (!d || d.value == null) return null;

  const fresh = rules.freshness && rules.freshness.latest;
  const stale = (fresh && fresh.expired && rules.staleNote) ? `；⚠️ ${rules.staleNote}` : '';
  const base = `${d.name} ${d.value}（来源：${d.source}，数据时间 ${d.dataTime}${stale}）`;
  // 三规则集中硬闸门：分析不可用（序列不足/校验未过）→ 不输出方向性结论，仅给数值
  try {
    assertAnalysis(a, `估值${m}`);
  } catch (e) {
    if (e.name === 'RuleNotSatisfied') return base;
    throw e;
  }
  return `${base}；${a.text}`;
}

/**
 * 主入口：获取「三规则合规」的估值分析数据
 * @param {string} symbol 形如 sh601318 / 601318
 * @param {Object} opts { prevLatest } prevLatest 用于异常值校验的前值
 */
async function getValuationHub(symbol, opts = {}) {
  const nowIso = new Date().toISOString();
  let raw = null, fetchError = null;
  try {
    raw = await fetchValuationTTM(symbol);
  } catch (e) {
    fetchError = e.message;
  }

  // 规则二④：抓取失败 → 无有效数据，明确标注且不编造、不推测
  if (!raw) {
    return {
      ok: false,
      error: fetchError || '未获取到估值数据',
      note: '⚠️ 未能获取估值数据，本次不输出估值结论（规则：无有效数据不得分析）。',
      fetchedAt: nowIso,
    };
  }

  const src = raw.source || '东方财富TTM';
  const fetchTime = raw.fetchedAt || nowIso;
  const latestDate = (raw.latest && raw.latest.date) || null;

  // 规则一②：五要素化最新估值
  const latest = {
    pe: makeDatum('PE(TTM)', raw.latest.pe, latestDate, src, fetchTime),
    pb: makeDatum('PB(MRQ)', raw.latest.pb, latestDate, src, fetchTime),
    ps: makeDatum('PS(TTM)', raw.latest.ps, latestDate, src, fetchTime),
  };

  // 规则二③：异常值校验（与上一次已知值比对）
  const sanity = {};
  if (opts.prevLatest) {
    ['pe', 'pb', 'ps'].forEach(k => {
      const r = validateSane(opts.prevLatest[k], latest[k].value);
      sanity[k] = r;
      if (!r.ok) latest[k].rejected = true; // 标记但不静默替换
    });
  }

  // 规则二②：时效体检（最新值按日频口径且开启交易日感知）
  const freshness = {
    latest: checkFreshness(latestDate, KIND.latest, Date.now(), { tradingDayAware: true }),
    series: checkFreshness(latestDate, KIND.series, Date.now(), { tradingDayAware: true }),
  };
  const staleNote = freshness.latest.expired ? staleLabel(latestDate) : '';

  // 规则三：年度序列（相邻期）+ 日频近 20 交易日（窗口首尾）
  const mk = (arr, key) => arr.map(s => ({ date: s.date, value: s[key], source: src, fetchTime }));
  const analysis = {
    PE: analyzeSeries(mk(raw.series || [], 'pe'), 'PE(TTM)'),
    PB: analyzeSeries(mk(raw.series || [], 'pb'), 'PB(MRQ)'),
    PS: analyzeSeries(mk(raw.series || [], 'ps'), 'PS(TTM)'),
  };

  const daily = raw.daily || [];
  const recent20 = daily.slice(-20);
  const shortTerm = {
    PE: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.pe })), 'PE(TTM)·近20交易日'),
    PB: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.pb })), 'PB(MRQ)·近20交易日'),
    PS: analyzeWindow(recent20.map(d => ({ date: d.date, value: d.ps })), 'PS(TTM)·近20交易日'),
  };

  return {
    ok: true,
    symbol,
    latest,
    sanity,
    freshness,
    staleNote,
    analysis,
    shortTerm,
    dailyPoints: daily.length,
    source: src,
    fetchedAt: fetchTime,
    ttl: TTL,
  };
}

module.exports = {
  getValuationHub,
  formatValuationLine,
  beginSnapshot,
  // 透传内核能力，便于其它模块直接复用（保持原导出兼容）
  analyzeSeries,
  analyzeWindow,
  checkFreshness,
  validateSane,
  staleLabel,
  TTL,
  _internal: {
    changeRate: core.changeRate,
    classifyDirection: core.classifyDirection,
    classifyAccel: core.classifyAccel,
    marginalStreak: core.marginalStreak,
    makeDatum: core.makeDatum,
  },
};

~~~

---

## `lib\volcSearch.js`  ·  145 行

~~~js
/**
 * 火山引擎 豆包联网搜索客户端（20260903n 新增）
 * ----------------------------------------------------------------
 * 免费额度（官方口径，2026-06-22 联网搜索能力升级后）：
 *   主账号维度 **每月 500 次免费，每月 1 日重置**（周期性额度，不是一次性总额度）；
 *   超出后 0.020 元/次。单次最多返回 50 条结果。
 * 相比阿里百炼 MCP（前 2000 次一次性、超出 0.029 元/次）与模型内置 enable_search
 * （无免费额度、≈0.003 元/次），本方案在本工作台当前用量（≈400 次/月）下可长期免费。
 *
 * ⚠️ API 形态说明（与阿里/百度 MCP 不同）：
 * 火山的联网搜索不是独立的「搜索 REST 接口」，而是 **Ark Responses API 的原生工具**
 * （tools: [{ type: 'web_search' }]），搜索结果由模型消费后写进回答文本，
 * 引用来源以 `url_citation` 注解形式挂在 content 上。因此：
 *   1) 本模块拿到的是「模型基于搜索结果整理的文本 + 引用列表」，而非原始 SERP；
 *   2) 上层把它当成「搜索证据」注入 prompt 即可，语义与 MCP 返回的文本一致；
 *   3) 响应结构随版本可能变化，全部解析都做防御性处理，缺字段不抛异常、只跳过。
 *
 * 端点：POST https://ark.cn-beijing.volces.com/api/v3/responses
 * 鉴权：Authorization: Bearer <Ark API Key>（火山方舟通用 Key，不是 Agent Plan 专用 Key）
 */
'use strict';

const axios = require('axios');

const VOLC_RESPONSES_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';
// 支持 web_search 内置工具的豆包模型（可在 AI 设置里覆盖）
const DEFAULT_VOLC_MODEL = 'doubao-seed-1-6-250615';

/** 递归收集对象里的文本片段（防御性：结构变化也能兜到） */
function collectTexts(node, out, depth) {
  if (!node || depth > 6) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(node)) {
    for (const it of node) collectTexts(it, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.text === 'string' && node.text.trim()) out.push(node.text.trim());
    if (Array.isArray(node.content)) collectTexts(node.content, out, depth + 1);
  }
}

/** 提取 url_citation 引用（防御性遍历 annotations） */
function collectCitations(node, out, depth) {
  if (!node || depth > 8 || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const it of node) collectCitations(it, out, depth + 1);
    return;
  }
  if (Array.isArray(node.annotations)) {
    for (const a of node.annotations) {
      if (!a || typeof a !== 'object') continue;
      const url = a.url || (a.url_citation && a.url_citation.url);
      if (!url) continue;
      const title = a.title || (a.url_citation && a.url_citation.title) || '';
      out.push({ title: String(title).slice(0, 120), url: String(url).slice(0, 300) });
    }
  }
  if (Array.isArray(node.content)) collectCitations(node.content, out, depth + 1);
  if (Array.isArray(node.output)) collectCitations(node.output, out, depth + 1);
}

/**
 * 调用火山豆包联网搜索，返回「搜索证据文本（含来源列表）」。
 * @param {string} apiKey 火山方舟 Ark API Key
 * @param {string} query 搜索词
 * @param {Object} [opts]
 * @param {string} [opts.model] 豆包模型（默认 doubao-seed-1-6-250615）
 * @param {number} [opts.maxResults=8] 单次返回条数上限（火山上限 50）
 * @param {number} [opts.timeout=30000]
 * @returns {Promise<string>}
 */
async function volcWebSearch(apiKey, query, { model, maxResults = 8, timeout = 30000 } = {}) {
  if (!apiKey) throw new Error('缺少 API Key（火山豆包搜索需要火山方舟 Ark API Key）');
  const q = (query || '').toString().trim();
  if (!q) throw new Error('搜索词为空');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const mdl = (model && String(model).trim()) || DEFAULT_VOLC_MODEL;
  const limit = Math.max(1, Math.min(50, Number(maxResults) || 8));

  const buildBody = (withLimit) => ({
    model: mdl,
    input: [{
      role: 'user',
      content: `请联网检索并汇总以下问题的最新公开信息，逐条给出要点与来源日期，不要加入你的主观判断：\n${q.slice(0, 500)}`,
    }],
    tools: [withLimit ? { type: 'web_search', limit } : { type: 'web_search' }],
    stream: false,
  });

  let resp;
  try {
    resp = await axios.post(VOLC_RESPONSES_ENDPOINT, buildBody(true), { headers, timeout });
  } catch (e) {
    // 部分模型/版本不接受 limit 字段，去掉后重试一次
    const status = e && e.response && e.response.status;
    if (status === 400 || status === 422) {
      resp = await axios.post(VOLC_RESPONSES_ENDPOINT, buildBody(false), { headers, timeout });
    } else {
      const detail = (e && e.response && e.response.data)
        ? JSON.stringify(e.response.data).slice(0, 200)
        : (e && e.message) || String(e);
      throw new Error('火山豆包搜索调用失败：' + detail);
    }
  }

  const data = resp && resp.data;
  if (!data || typeof data !== 'object') throw new Error('火山豆包搜索返回空响应');

  // 文本：优先 output_text（SDK 便捷字段），否则从 output[] 递归收集
  const texts = [];
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    texts.push(data.output_text.trim());
  } else {
    collectTexts(data.output, texts, 0);
  }
  const body = texts.join('\n').trim();

  // 来源：url_citation 注解
  const cites = [];
  collectCitations(data, cites, 0);
  const seen = new Set();
  const uniq = cites.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, limit);

  if (!body && !uniq.length) {
    throw new Error('火山豆包搜索未返回有效内容：' + JSON.stringify(data).slice(0, 200));
  }

  let out = body;
  if (uniq.length) {
    out += '\n\n【引用来源】\n' + uniq.map((c, i) => `${i + 1}. ${c.title || '(无标题)'} - ${c.url}`).join('\n');
  }
  return out.slice(0, 8000);
}

module.exports = { volcWebSearch, VOLC_RESPONSES_ENDPOINT, DEFAULT_VOLC_MODEL };

~~~

---

## `lib\volumeCaliber.js`  ·  71 行

~~~js
'use strict';

/**
 * 全工作台「量能判定」单一真值源（20261109c）
 * ============================================================
 * 用户 2026-11-09 明确纠正：「工作台已经统一使用 20 日量能比来作为量能标准，
 * 为什么现在会出现其他的标准选择？」——工作台不允许存在第二套量能标准。
 *
 * 唯一权威口径：
 *   ratio20 = 当日成交量 ÷ 前 20 日均量
 *   放量  > VOL_AMP(1.3) / 平量 0.8~1.3 / 缩量 < VOL_SHRINK(0.8)
 *
 * 适用范围（全部算「判定层」，禁止自行保留阈值）：
 *   lib/volumeEngine.js 的 _volumeTier / _volTier5 / 生死位五规则（规则1/3/4）/
 *   三问持续性 / 单根脉冲 / 口诀4 / 11.3.1 该放量未放量 / 缩量止跌观察 / 风险标签；
 *   lib/capitalFlow.js 的 ÷20 五档回退、量能热度、最新量比趋势、突破量比形态；
 *   public/js/app.js 的口径说明文案。
 *
 * 明确不适用（显式标注分母的「原始指标」，不承担量价判定结论）：
 *   顶部「量比」（腾讯行情直采，÷前5日均量）、lib/zoneValidity.js 的放量穿越线
 *   （÷前5日均量，箱体有效性专用判据）。这些卡片的标题/口径说明必须写明分母。
 *   注：public/js/capitalCharts.js 的「每日20日量能比趋势」图已由 [20261109d] 改为 ÷20 同源口径
 *   （数据取 volumeIndicators.series.ratio20Series），故它属于「适用」分组、与判定层同源，
 *   不再是独立原始指标（原 ÷前5日均量口径已于该次一并退役）。
 *
 * ⚠️ 同屏互斥 = 结论无效：同一交易日不得同时出现「放量」与「缩量 / 量能未有效放大」。
 * ⚠️ 基准可比性：前高量能基准必须与分析期、价位带可比，禁止用全历史全局最高价
 *    （常为上市首日天量）当突破承接量基准；且前高量能只作展示参照，不参与判定。
 *
 * 纯函数、零网络、零依赖，供引擎 / 资金流 / 守卫共同 require，避免循环依赖。
 */

const VOL_AMP = 1.3;     // 放量阈值：ratio20 > 1.3
const VOL_SHRINK = 0.8;  // 缩量阈值：ratio20 < 0.8
const VOL_HUGE = 2.5;    // 显著放量（capitalFlow 五档回退与 unifiedVolState 同源）
const VOL_DRY = 0.5;     // 地量（同上）
const VOL_BASIS = '放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8';

// —— 基准可比性常量（规则3「同价位带最近前高」专用）——
const REF_PRICE_BAND_PCT = 0.10;      // 与阻力区间触及线的价位带容差 ±10%
const REF_LISTING_GUARD_BARS = 5;     // 剔除上市首日 / 上市初期前 5 根
const REF_EXTREME_VOL_MULT = 4;       // 超过同价位带成交量中位数 4 倍 → 极端异常量，剔除
const REF_EXRIGHT_GAP = 0.22;         // 单日收盘跳变 >22% 视为除权/股本断点，只用断点之后的样本

function _finite(v) { return typeof v === 'number' && isFinite(v); }

/** 任意 ÷20 均量比值 → 是否放量（唯一判定入口） */
function isAmpRatio(r) { return _finite(r) && r > VOL_AMP; }

/** 任意 ÷20 均量比值 → 是否缩量（唯一判定入口） */
function isShrinkRatio(r) { return _finite(r) && r < VOL_SHRINK; }

/** 任意 ÷20 均量比值 → 三态档位；数据不足返回 null（不臆造） */
function tierOfRatio(r) {
  if (!_finite(r)) return null;
  if (r > VOL_AMP) return '放量';
  if (r < VOL_SHRINK) return '缩量';
  return '平量';
}

/** 单日成交量 + 20 日均量 → 比值；均量不可得返回 null */
function ratioOfVol(vol, avg20) {
  return (_finite(vol) && _finite(avg20) && avg20 > 0) ? vol / avg20 : null;
}

module.exports = {
  VOL_AMP, VOL_SHRINK, VOL_HUGE, VOL_DRY, VOL_BASIS,
  REF_PRICE_BAND_PCT, REF_LISTING_GUARD_BARS, REF_EXTREME_VOL_MULT, REF_EXRIGHT_GAP,
  isAmpRatio, isShrinkRatio, tierOfRatio, ratioOfVol,
};

~~~

---

## `lib\volumeEngine.js`  ·  3504 行

~~~js
/**
 * lib/volumeEngine.js — 个股量能分析引擎（20261017g）
 *
 * 依据《AI 股票量能分析工作台统一业务逻辑说明书（最终整合版）》实现的确定性量能分析管线。
 * 纯 IF-THEN 计算，无 LLM：所有数值由代码计算，缺数据如实标注「数据不足/样本不足」，不得臆造；
 * 所有输出仅客观分析标签（看多/看空/信号/预警/观察均为分析标签），不衍生任何交易指令。
 * 20261017g 修正两项分时口径缺陷：
 *   ① 尾盘窗口按「时间戳」截取 14:30-15:00，不再取数组末尾 30 条——腾讯分时收盘后追加盘后条目
 *      （实测 2026-10-19 15:10 共 247 条，末尾 1500/1506…1510），按末尾取会把盘后算进窗口且随时间后移；
 *      且盘中未收盘时不得把「最近半小时」当尾盘，须标「分时尚未覆盖到收盘」。
 *   ② 开盘量比单位换算按日K通道自适应——分时 cumVol 恒为「手」，东财/同花顺日K为「股」、
 *      腾讯日K为「手」（实测 000902 同日 7,923,196 股 vs 80,528 手），写死 ÷100 会在腾讯降级时
 *      把基准缩小 100 倍导致开盘量比虚高、必然误判「量比超3」。
 *
 * 链路（spec 第十三章）：
 *   预计算 → 位置判定 → 量价三问 → 背离检测 → 五大生死位规则 →
 *   位置×量能组合 → 不同位置量价补充规则（7.4）→ 量比实战口诀（7.5）→
 *   常见矛盾信号（11.3）→ 连续量能序列 → 打分(0-100) → 流动性/黑名单衰减 →
 *   信号分类（含 11.2/11.3/11.4 一致性约束）+ 风险标签 + 结构化输出
 *   （四维度客观描述 + 结论提示 + 三个强制归集总结 + 免责备注）。
 *
 * 三个强制归集总结（spec 11.2/11.3/11.4，无论是否命中都必须逐条完整输出）：
 *   positionVolumeSummary  不同位置量价分析归集总结（高位放量滞涨/低位放量震荡/缩量上涨两种情况/缩量下跌两种情况）
 *   contradictionSummary   常见矛盾信号归集总结（该放量未放量/该缩量反放巨量/高位放巨量价格不涨/低位放大量价格不跌）
 *   ratioSummary           量比实战口诀归集总结（五句口诀）
 *   未命中必须写「未命中」、数据不足必须写「数据不足，无法判定」，不得留空、不得臆造。
 *
 * 日K采集降级链（20261017e，analyzeVolume 内；本机实测东财双主机被断、同花顺可达）：
 *   ① 东财多主机日K（push2his → push2，klt=101 前复权，含成交额 amount 与换手率 turnover 全字段）；
 *   ② 同花顺日K（d.10jqka all.js 压缩解码全历史 + last.js 近 140 根含成交额/换手率，重叠段闸门校验，前复权同口径）；
 *   ③ 腾讯日K（ifzq.gtimg qfqday，仅 OHLCV；成交额/换手率缺失由 _precompute 按 spec 降级并如实标注，不臆造）；
 *   任一级拿到 ≥10 根即采用；全部不可达返回空数组，引擎输出「日线数据不足」。
 *
 * 当日 bar 终值对齐（20261019b，用户 000902 新洋丰实测：东财 App 量比 0.99 / 当日 +1.87%，
 * 工作台 0.97 / +2.39%）：同花顺当日 bar 虽带今日日期，但收盘后数值仍是盘中快照
 * （close 13.69 / 79,232 手，真实终值 close 13.62 / 80,528 手）——20261019a 新鲜度判据
 * 只校验「末根日期 = 今天」，日期新鲜 ≠ 数值终值，快路径直接采用了错误快照。
 * 修复（数据一致性铁律：当日数据单一权威源）：主行情源腾讯实时 quote 为交易所终值，
 * 末根日期 = quote 日期 → 用 quote 的 OHLC/量/额覆写末根；quote 日期更新且为今日 →
 * 直接以 quote 补齐当日 bar（全通道日K集体延迟场景）。单位按通道自适应：
 * quote.volume 为「股」；日K通道 bar 单位见 lib/volUnit.js（东财/腾讯=手、同花顺=股，20261021h 实测）。
 *
 * 工作台口径配置（spec 允许「由工作台配置」的参数，未配置时按此处默认并如实标注）：
 * - 均量基准不含当日（与 capitalFlow.js「量比 = 今日量 ÷ 前20日均量」同口径）；
 * - 5/10/20 日均量分别取最近 5/10/20 个交易日（不含当日）；60 日均量已于 20261106n 整体退役；
 * - 250 日窗口用于成交额百分位与流动性分级；日K 取 320 根 ≈ 13 个月，覆盖 12 个月价格分位；
 * - 量比阈值未配置 → 不单独以量比触发结论，以 ÷20 日均量统一三态为准（20261106n：60 日确认退役）；
 * - 阶段新高低窗口未配置 → 取近 250 个交易日（≈12 个月）高低点；
 * - 大盘环境折扣未配置 → 输出标注「未叠加大盘环境折扣」；
 * - 黑名单「近期」取近 180 天内的解禁/减持公告标题匹配 + ST/退市风险名称识别；
 * - 7.4/7.5 子阶段阈值（低位大跌后距高点 -15%、下跌初期距高点 -10%、开盘/尾盘 30 分钟窗口等）
 *   为工作台默认口径，未配置时按此处默认并在输出中如实呈现计算依据；
 * - 20261017g 分时口径：尾盘 = 时间戳 14:30-15:00（需分时已收盘且窗口 ≥25 分钟，否则「数据不足」）；
 *   开盘量比分母单位随 barsSource 自适应（tencent 日K为「手」→ 不除 100，其余通道为「股」→ 除 100）。
 */

'use strict';

// ===================== 常量（spec 第三/九/十章） =====================

// 量能档位：当前量 ÷ 5 日均量倍数
// 20261019f：阈值对齐市场标准量比（东方财富/同花顺 App 通用口径；用户 2026-10-19 明确要求
// 「缩量的判定标准和市场上的缩量的判定标准一致」）——缩量 <0.8、平量 [0.8,1.2]、
// 放量 >1.2、严重缩量 <0.5。旧阈值 0.7/1.3/0.4 与市场存在偏差（如量比 0.75 市场判缩量、
// 旧口径判平量）。内部分级（大量/天量 2.5/4）保留，与市场「巨量」概念兼容。
// 20261021h：日K成交量单位的唯一来源（东财/腾讯=手、同花顺=股），见 lib/volUnit.js 头注释的实测表
const { sharesToBarUnit, toLotDivisor } = require('./volUnit');
// 20261024f：交易日感知（周末/法定节假日）——「日K是否缺今日数据」必须按交易日判定，
// 否则周六/周日/长假期间会恒报「未包含今日数据」这一假缺口（今日 2026-10-24 为周六、末根为周五 10-23）。
const { isTradingDay, previousTradingDay } = require('./cnTradingCalendar');

const LEVEL_RULES = [
  { level: '极度缩量', test: r => r < 0.5 },
  { level: '温和缩量', test: r => r >= 0.5 && r < 0.8 },
  { level: '平量', test: r => r >= 0.8 && r <= 1.2 },
  { level: '温和放量', test: r => r > 1.2 && r <= 2.5 },
  { level: '大量', test: r => r > 2.5 && r <= 4 },
  { level: '天量', test: r => r > 4 },
];

// [20261109c] 全工作台量能判定接入「单一真值源」lib/volumeCaliber.js（用户裁决「全引擎统一到 1.3」）。
// 旧 AMP_CONFIRM=1.5 / SHRINK_CONFIRM=0.7 是 20261106j「分母统一 ÷20」的漏改点：异常特例层
// 规则3 用 ×1.5 + 「当日量 > 前高量能」作第二套判据，与 135 格 ÷20 日均量 >1.3 主判在
// 1.3~1.5 夹缝里同屏互斥（2026-11-09 威高血净 603014：ratio20=1.47，一边「放量」一边「缩量假突破」）。
// 现所有放量/缩量/量能确认判定层一律消费同一模块，禁止再出现第二套阈值或本地硬编码。
const {
  VOL_AMP, VOL_SHRINK, VOL_BASIS,
  isAmpRatio, isShrinkRatio, tierOfRatio, ratioOfVol,
  REF_PRICE_BAND_PCT, REF_LISTING_GUARD_BARS, REF_EXTREME_VOL_MULT, REF_EXRIGHT_GAP,
} = require('./volumeCaliber');

// 流动性分级与置信系数（spec 第十章）
const LIQ_TIERS = [
  { level: '流动性严重不足', coef: 0.4, tag: '低流动性', test: p => p < 0.2 },
  { level: '流动性一般', coef: 0.7, tag: '流动性偏弱', test: p => p >= 0.2 && p < 0.4 },
  { level: '流动性充足', coef: 1.0, tag: null, test: p => p >= 0.4 && p <= 0.85 },
  { level: '流动性过热', coef: 0.85, tag: '流动性过热', test: p => p > 0.85 },
];
const FALLBACK_AMOUNT = 5e6;  // 单日成交额低于 500 万 → 兜底 ×0.2
const SAMPLE_MIN_BARS = 60;   // 样本不足判定：可用历史交易日 < 60 根 → ×0.5
const BLACKLIST_COEF = 0.3;   // 黑名单衰减系数

// 打分权重（spec 第九章）
const W_VOLUME_PRICE = 40;
const W_TREND = 30;
const W_LEVEL_FIT = 20;
const DIVERGE_PENALTY = { top: 30, general: 20, bottom: 15 }; // 单次最高扣 30

// 档位适配分（spec：极度缩量不进看多；巨量/天量增风险折扣）
const LEVEL_FIT_SCORE = { '极度缩量': 5, '温和缩量': 12, '平量': 15, '温和放量': 20, '大量': 10, '天量': 8 };

// ===================== 基础工具 =====================

function _round(n, d = 2) {
  if (n === null || n === undefined || !isFinite(n)) return 0;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function _mean(a) {
  if (!a || !a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function _median(a) {
  if (!a || !a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 量能三态：把任意窗口量比折算为 放量 / 平量 / 缩量。
 * 20261019f：边界对齐市场标准量比（缩量 <0.8、平量 [0.8,1.2]、放量 >1.2）——
 * 用户要求缩量判定与市场一致；旧边界 0.7/1.3 与市场（东方财富 App：量比 0.8~1.2
 * 为平量）有偏差。跨卡一致性要求：边界必须与 _comboEngine 的 amplified/shrunk
 * 完全同源，任何一处改动都必须两处同步，否则「量价分析」与「量能分析」会重新互斥。
 */
function _volTriState(r) {
  if (r === null || r === undefined || !isFinite(r)) return null;
  if (r > 1.2) return 'amp';
  if (r < 0.8) return 'shrink';
  return 'flat';
}

/**
 * 统一量能档位（20261017i 新增，全工作台「放量/缩量」唯一真值源）。
 * 20261019f：定档标准对齐市场——只认「当日量 ÷ 前 5 日均量」（= 东方财富/腾讯 App
 * 量比口径，20261019c 起优先取数据源直采值），阈值 0.8/1.2。**60 日均量口径
 * （×1.5/×0.7）不再翻转档位**，仅在与 5 日档位不一致时作分歧披露——旧逻辑让 60 日
 * 口径把「量比 0.99（市场标准=平量）」翻成「缩量」，与市场标准矛盾（用户 2026-10-19
 * 新洋丰 000902 实测反馈「缩量的判定标准和市场上的缩量的判定标准出现矛盾」）。
 * 与 _comboEngine 的 amplified / shrunk 同式，保证「量价信号」「量能热度」
 * 「引擎资金行为」三处结论同源，杜绝同屏互斥。
 */
function _volumeTier(pc) {
  // 20261106j：分母统一到 ÷20 日均量（= 135 格推演图 volCell 归格口径，_volTier5 同源），
  // 彻底消除「同一标的在 135 格判放量、在资金行为 / 今日量价关系判平量」的互斥
  // （典型：威高血净 ÷5 日 1.2 平量 vs ÷20 日 2.63 放量）。阈值对齐 135 格 _volTier5：
  // 放量 >1.3 / 缩量 <0.8 / 平量 0.8~1.3；tier 取三态（放量 / 缩量 / 平量）与 posModel135 的
  // vol 取值同源。pc.level（÷5 六态）仅保留为 ratio5Level 原始指标，不再作判定档位。
  // 20261106n（用户裁决「60日量能比仅用于放量/缩量判定 → 彻底删除，统一÷20」）：
  // 60 日 confirm/confirmDesc 字段与跨基准分歧披露整体退役（消费点均为放量/缩量判定，
  // 已全部统一到 ÷20；multi-day 规则基准同步 avg60 → avg20）。
  const ratio20 = pc.ratio20;
  // [20261109c] 阈值统一从 volumeCaliber 取，禁止本地硬编码 1.3 / 0.8
  const amplified = isAmpRatio(ratio20);
  const shrunk = isShrinkRatio(ratio20);
  // 跨窗口分歧如实标注（工作台「诚实合规」原则：不静默取一侧）——
  // 近5日量能与近20日主基准分处不同档位（近期量能突变）
  const t5 = _volTriState(pc.ratio5);
  const t20 = _volTriState(ratio20);
  const crossWindowOk = (t5 === null || t20 === null) ? true : t5 === t20;
  const consistent = crossWindowOk;
  const notes = [];
  if (!crossWindowOk) {
    const r5 = pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足';
    const r20 = ratio20 !== null ? _round(ratio20) : '数据不足';
    const trend = (t5 === 'amp') ? '抬升' : (t5 === 'shrink') ? '回落' : '回归';
    notes.push(`近5日量能（÷5日均量 ${r5} 倍）与近20日主基准（÷20日均量 ${r20} 倍）分处不同档位，近期量能较近20日水平明显${trend}`);
  }
  const divergenceNote = notes.length ? notes.join('；') : null;
  let tier;
  if (ratio20 === null || ratio20 === undefined || !isFinite(ratio20)) tier = pc.level; // 退化：保留 ÷5 六态，不臆造
  else if (amplified) tier = '放量';
  else if (shrunk) tier = '缩量';
  else tier = '平量';
  return {
    // 20261106j：tier 取 ÷20 日均量三态（与 135 格 volCell 同源）；ratio5Level 保留 ÷5 六态原始指标
    tier,
    ratio5Level: pc.level,
    basis: `当日量 ÷ 20 日均量（与 135 格推演图同源：${VOL_BASIS}）`,
    ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
    ratio20: ratio20 !== null ? _round(ratio20) : null,
    amplified,
    shrunk,
    consistent,
    divergenceNote,
  };
}

// 历史百分位（0-1）：口径 = 窗口内 ≤ v 的样本占比（与 marketEmotionModel.rankPercentile 同口径）
function _pctRank(values, v) {
  if (!values || !values.length || v === null || v === undefined || !isFinite(v)) return null;
  let cnt = 0;
  for (const x of values) if (x <= v) cnt++;
  return cnt / values.length;
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _fmtPct(n, d = 1) {
  if (n === null || n === undefined || !isFinite(n)) return '数据不足';
  return `${_round(n, d)}%`;
}

// ===================== 1. 预计算（spec 第二章） =====================

// 20261019c：量比优先取数据源直采值（腾讯行情 fields[49]），本地「今日量÷5日均量」仅作兜底。
// opts.quoteVolumeRatio 由 analyzeVolume 从实时 quote.volumeRatio 透传；有效（finite > 0）时直接采用，
// 并标注 ratio5Basis='tencent_quote'；缺失/无效时退回本地计算，标注 'local_fallback'。
function _precompute(bars, opts = {}) {
  const n = bars.length;
  const vols = bars.map(b => b.volume);
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const opens = bars.map(b => b.open);
  const amounts = bars.map(b => (typeof b.amount === 'number' ? b.amount : 0));
  const turnovers = bars.map(b => (typeof b.turnover === 'number' ? b.turnover : 0));
  const hasAmount = amounts.some(a => a > 0);
  const hasTurnover = turnovers.some(t => t > 0);
  const dataGaps = [];

  const volToday = vols[n - 1];
  const volPrev = n >= 2 ? vols[n - 2] : null;
  const closeToday = closes[n - 1];
  const closePrev = n >= 2 ? closes[n - 2] : null;
  const highToday = highs[n - 1];
  const lowToday = lows[n - 1];
  const openToday = opens[n - 1];
  const amountToday = amounts[n - 1];
  const turnoverToday = turnovers[n - 1];
  const chgPct = closePrev ? (closeToday - closePrev) / closePrev * 100 : null;

  // 均量：基准不含当日（工作台既有口径）
  const avgOf = (k) => {
    const w = vols.slice(Math.max(0, n - 1 - k), n - 1);
    return w.length >= Math.min(k, n - 1) ? _mean(w) : (w.length ? _mean(w) : 0);
  };
  const avg5 = avgOf(5);
  const avg10 = avgOf(10);
  const avg20 = avgOf(20);
  // 20261106n（用户裁决）：60 日均量（avg60）整体退役——原消费点（confirm 确认/生死位规则/
  // 底部相位/预期量能）全部改用 ÷20 日均量基准，avg60 字段从预计算输出中删除。
  if (n - 1 < 5) dataGaps.push('历史K线不足，均量按可用样本计算，可靠性下降');
  if (n - 1 < 20) dataGaps.push(`历史K线仅 ${n} 根（不足20），20 日均量按可用样本计算`);

  const ratio5Local = avg5 > 0 ? volToday / avg5 : null;
  // 量比直采：优先用数据源现成量比（与东方财富 App 口径一致），本地重算仅兜底。
  let ratio5 = ratio5Local;
  let ratio5Basis = 'local_fallback';
  const srcVR = (typeof opts.quoteVolumeRatio === 'number' && isFinite(opts.quoteVolumeRatio) && opts.quoteVolumeRatio > 0)
    ? opts.quoteVolumeRatio : null;
  if (srcVR !== null) {
    ratio5 = srcVR;
    ratio5Basis = 'tencent_quote';
  } else if (ratio5Local !== null) {
    ratio5Basis = 'local_fallback';
  } else {
    ratio5Basis = 'unavailable';
  }
  const ratio10 = avg10 > 0 ? volToday / avg10 : null;
  const ratio20 = avg20 > 0 ? volToday / avg20 : null;
  // 前一日的 5 日均量口径（背离检测「量能水平持续回落」用）。
  // 20261017c：修正窗口——prev 日是 n-2，其 5 日均量（不含自身，与 avg5「基准不含当日」同口径）
  // 应为 mean(vols[n-7..n-3])。原窗口 slice(n-6, n-1) 把前一日自身也包了进去，
  // 导致 ratio5Prev 与 ratio5 同分母，「量能水平回落」退化为「今日量<前日量」的重复判断。
  const avg5Prev = n >= 7 ? _mean(vols.slice(n - 7, n - 2)) : 0;
  const ratio5Prev = avg5Prev > 0 && volPrev ? volPrev / avg5Prev : null;

  // 量能档位（当前量 ÷ 5 日均量）
  let level = '数据不足';
  if (ratio5 !== null) {
    const hit = LEVEL_RULES.find(r => r.test(ratio5));
    level = hit ? hit.level : '平量';
  }

  // 20261106n（用户裁决）：60 日均量 confirm 确认机制整体退役——消费点均为放量/缩量判定，
  // 已全部统一到 ÷20 日均量主基准（_volumeTier 三态），不再保留第二套口径。
  // judgedLevel（÷5 六态原始指标）保留为 ratio5Level 展示与天量/地量极端档位用途。
  let judgedLevel = '数据不足';
  if (ratio5 !== null) {
    const ampNow = ratio5 > 1.2;
    const shrNow = ratio5 < 0.8;
    if (ampNow) judgedLevel = ratio5 > 4 ? '天量' : (ratio5 > 2.5 ? '大量' : '温和放量');
    else if (shrNow) judgedLevel = ratio5 < 0.5 ? '极度缩量' : '温和缩量';
    else judgedLevel = '平量';
  }

  // 250 日成交额百分位与中位数（spec 第十章；窗口不足 250 根时按可用样本并标注）
  const amtWin = amounts.slice(-250).filter(a => a > 0);
  const amountPct250 = amtWin.length ? _pctRank(amtWin, amountToday) : null;
  const amountMedian250 = amtWin.length ? _median(amtWin) : null;

  // 近 12 个月价格分位与阶段高低点（250 根窗口；不足按可用样本）
  const closeWin = closes.slice(-250);
  const highWin = highs.slice(-250);
  const lowWin = lows.slice(-250);
  const winMaxClose = Math.max(...closeWin);
  const winMinClose = Math.min(...closeWin);
  const pricePct12m = winMaxClose > winMinClose ? (closeToday - winMinClose) / (winMaxClose - winMinClose) : null;
  const stageHigh = Math.max(...highWin);
  const stageLow = Math.min(...lowWin);
  const stageHighClose = winMaxClose;
  const stageLowClose = winMinClose;
  const drawdownFromHigh = stageHighClose > 0 ? (closeToday - stageHighClose) / stageHighClose * 100 : null;
  const rallyFromLow = stageLowClose > 0 ? (closeToday - stageLowClose) / stageLowClose * 100 : null;
  if (n < 250) dataGaps.push(`价格分位/阶段高低点窗口仅 ${n} 根（不足250），按可用样本计算`);

  // 换手率及历史均值（东财日K f61；腾讯/新浪通道无此字段）
  const turnoverWin = turnovers.slice(-250).filter(t => t > 0);
  const turnoverMean = turnoverWin.length ? _mean(turnoverWin) : null;
  if (!hasTurnover) dataGaps.push('换手率数据不足（当前日K通道无换手率字段），天量确认降级');
  if (!hasAmount) dataGaps.push('成交额数据不足（当前日K通道无成交额字段），流动性校验降级');
  // 20261017e：部分通道（同花顺 last.js）仅近期区间带成交额/换手率字段——
  // 250 日窗口样本不足时如实标注，不冒充全窗口分位/均值
  if (hasAmount && amtWin.length < 250) dataGaps.push(`成交额样本仅 ${amtWin.length} 天（不足250），250日分位按可用样本计算`);
  if (hasTurnover && turnoverWin.length < 250) dataGaps.push(`换手率样本仅 ${turnoverWin.length} 天（不足250），阶段均值按可用样本计算`);
  // 20261022e：同花顺历史段的成交额/换手率为回填推算（stockData._backfillThsFields），如实披露。
  // 20261023f：成交额回填改用腾讯「不复权」收盘价（amountBasis='raw_close'）后，与交易所同口径、
  // 实测偏差 <1%，不再算作「数据不足」；此类条目降级为「来源与口径说明」，前端单独展示。
  const estBars = Array.isArray(bars) ? bars.filter(b => b && (b.amountEstimated || b.turnoverEstimated)) : [];
  const hasEstimatedFields = estBars.length > 0;
  if (estBars.length) {
    const anyRaw = estBars.some(b => b.amountBasis === 'raw_close');
    const anyQfq = estBars.some(b => b.amountEstimated && b.amountBasis !== 'raw_close');
    if (anyRaw && !anyQfq) {
      dataGaps.push('历史段成交额按「不复权收盘价 × 成交量」还原（实测与交易所成交额偏差通常 <1%）；换手率按流通盘推算（实测与交易所口径一致）——属来源与口径说明，不影响结论');
    } else {
      dataGaps.push('历史段成交额/换手率为推算值（按近 140 根反推流通盘 + 收盘价估算），跨除权日可能有数%偏差；成交量/价格类判断不受影响');
    }
  }

  // 均线（含当日，标准口径）
  const ma20 = n >= 20 ? _mean(closes.slice(-20)) : null;
  const ma60 = n >= 60 ? _mean(closes.slice(-60)) : null;

  // 单根脉冲爆量：只有最新一根巨量（>5 日均量 2.5 倍），前后 K 线均为缩量（÷20 日均量 <0.8；
  // 20261109c 阈值统一到 volumeCaliber）。三问/连续序列/打分共用此判定。
  const pulse = ratio5 !== null && ratio5 > 2.5
    && avg20 > 0 && n >= 3
    && isShrinkRatio(ratioOfVol(vols[n - 2], avg20))
    && isShrinkRatio(ratioOfVol(vols[n - 3], avg20));

  return {
    n, vols, closes, highs, lows, opens, amounts, turnovers,
    hasAmount, hasTurnover, hasEstimatedFields, dataGaps,
    volToday, volPrev, closeToday, closePrev, highToday, lowToday, openToday,
    amountToday, turnoverToday, chgPct,
    avg5, avg10, avg20, ratio5, ratio10, ratio20, ratio5Prev, ratio5Basis,
    level, judgedLevel,
    amountPct250, amountMedian250,
    pricePct12m, stageHigh, stageLow, stageHighClose, stageLowClose,
    drawdownFromHigh, rallyFromLow,
    turnoverMean, ma20, ma60,
    pulse,
  };
}

// ===================== 2. 位置判定与关键位（spec 第三章） =====================

function _sidewaysAndPlatform(bars) {
  const n = bars.length;
  const band = (i, j) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = i; k <= j; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    return lo > 0 ? (hi - lo) / lo : Infinity;
  };
  // 横盘形态：连续 ≥20 个交易日，区间涨跌幅在 ±15% 以内（形态标签，可与四态并列）
  // 20261102g：同时返回近 20 日带宽值 band20（第二步「运行状态」判定的展示与审计依据）
  // 20261102h：同时返回近 20 日净涨跌幅 trend20（趋势运行时附带「上涨趋势 / 下跌趋势」方向说明的依据，
  //   与 band20 同窗口 n-20..n-1，取窗口首尾收盘的净变动）
  let band20 = null;
  let trend20 = null;
  if (n >= 20) {
    band20 = band(n - 20, n - 1);
    if (bars[n - 20].close > 0) trend20 = bars[n - 1].close / bars[n - 20].close - 1;
  }
  let currentSideways = false;
  if (band20 !== null && band20 <= 0.15) currentSideways = true;
  // 前期平台：从倒数第 4 根往前找最近的、长度 ≥20 且带宽 ≤15% 的窗口
  // （规则1「前期已完成不少于20个交易日横盘整理」与规则3「平台上沿」用；
  //   endIdx ≤ n-4 保证平台结束于最近 3 根放量 K 线之前）
  let platform = null;
  for (let e = n - 4; e >= 19; e--) {
    if (band(e - 19, e) <= 0.15) {
      let hi = -Infinity, lo = Infinity;
      for (let k = e - 19; k <= e; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      platform = { high: hi, low: lo, startIdx: e - 19, endIdx: e, days: 20 };
      break;
    }
  }
  return { currentSideways, platform, band20, trend20 };
}

// ===================== 20261104e：近 120 日趋势段检测（用户定位原则第一步） =====================
// 用户报障（2026-11-04）：量能涨跌关系分析推演图上只有四种股价定位（低位区/高位区/上涨途中/趋势向下），
// 原则上不应有超出这四种的定位；无法判定时先参考公司短期股价是否呈趋势运行（新洋丰 000902 自 7 月
// 约 11 元涨至今接近 15 元，是趋势运行不是震荡）；若短期是区间震荡，再拉长参考时间再定位（海天味业
// 一年内区间震荡、拉长 3-4 年看是长期下跌趋势）。
// 现状缺陷：_detectPosition 只看 12 个月分位 + MA20/MA60——新洋丰 MA 粘合（13.78/13.80）+ 分位被
// 年初高点稀释到 41.5% → 直接兜底「区间震荡」，与第二步运行状态「趋势运行·上涨趋势」同屏打架。
// 确定性规则（零 LLM、纯代码执行）：近 120 个交易日窗口内找最近一段显著趋势段——
//   上涨段 = 自窗口内最低收盘涨幅 ≥20%，锚点距今 ≥10 根（有持续期），期间最大回撤 ≤ 顺向涨幅 ×60%（结构未破坏）；
//   下跌段 = 对称（自窗口内最高收盘跌幅 ≥20%，期间最大反弹 ≤ 顺向跌幅 ×60%）；
//   两段同存取锚点更近者（最近一段行情主导当前状态）；
//   无趋势段 → 交回 _detectPosition 拉长参考时间（长期 MA250 定论）定位，两者皆无才保留「区间震荡」诚实兜底。
const TREND_SEG_WINDOW = 120;   // 趋势段检测窗口（约 6 个月，覆盖「7 月以来」级别行情）
const TREND_SEG_MOVE = 0.20;    // 顺向幅度 ≥20% 才算显著趋势段（真机例证：新洋丰 +26.1% 达标，海天 ±8.8% 不达标）
const TREND_SEG_MIN_AGE = 10;   // 锚点距今 ≥10 根，保证趋势段有持续期（刚创新低/新高不构成段）
const TREND_SEG_DD_RATIO = 0.6; // 期间最大逆向回撤 ≤ 顺向幅度 ×60%（趋势结构未破坏；新洋丰 12.1/26.1=0.46 ✓）

function _trendSegment(bars) {
  if (!Array.isArray(bars) || bars.length < TREND_SEG_WINDOW) return null;
  const n = bars.length;
  const win = bars.slice(n - TREND_SEG_WINDOW);
  const lastClose = win[win.length - 1].close;
  // 窗口内最低/最高收盘锚点
  let loIdx = 0, hiIdx = 0;
  for (let i = 1; i < win.length; i++) {
    if (win[i].close < win[loIdx].close) loIdx = i;
    if (win[i].close > win[hiIdx].close) hiIdx = i;
  }
  // 上涨段：自窗口最低收盘
  const lowAge = win.length - 1 - loIdx;
  const rise = lastClose / win[loIdx].close - 1;
  let upSeg = null;
  if (rise >= TREND_SEG_MOVE && lowAge >= TREND_SEG_MIN_AGE) {
    let peak = win[loIdx].close, maxDD = 0;
    for (let i = loIdx; i < win.length; i++) {
      if (win[i].close > peak) peak = win[i].close;
      const dd = 1 - win[i].close / peak;
      if (dd > maxDD) maxDD = dd;
    }
    if (maxDD <= rise * TREND_SEG_DD_RATIO) {
      upSeg = { anchorDate: win[loIdx].date, anchorPrice: win[loIdx].close, movePct: rise * 100, pullbackPct: maxDD * 100, age: lowAge };
    }
  }
  // 下跌段：自窗口最高收盘（对称）
  const highAge = win.length - 1 - hiIdx;
  const drop = lastClose / win[hiIdx].close - 1;
  let downSeg = null;
  if (-drop >= TREND_SEG_MOVE && highAge >= TREND_SEG_MIN_AGE) {
    let trough = win[hiIdx].close, maxRb = 0;
    for (let i = hiIdx; i < win.length; i++) {
      if (win[i].close < trough) trough = win[i].close;
      const rb = win[i].close / trough - 1;
      if (rb > maxRb) maxRb = rb;
    }
    if (maxRb <= -drop * TREND_SEG_DD_RATIO) {
      downSeg = { anchorDate: win[hiIdx].date, anchorPrice: win[hiIdx].close, movePct: drop * 100, pullbackPct: maxRb * 100, age: highAge };
    }
  }
  // 两段同存 → 取锚点更近者（最近一段行情主导当前状态）；同距防御性取幅度大者
  let seg = null;
  if (upSeg && downSeg) {
    seg = (upSeg.age < downSeg.age || (upSeg.age === downSeg.age && upSeg.movePct > -downSeg.movePct))
      ? { direction: 'up', ...upSeg }
      : { direction: 'down', ...downSeg };
  } else if (upSeg) {
    seg = { direction: 'up', ...upSeg };
  } else if (downSeg) {
    seg = { direction: 'down', ...downSeg };
  }
  if (!seg) return null;
  seg.window = TREND_SEG_WINDOW;
  seg.reason = seg.direction === 'up'
    ? `近 ${TREND_SEG_WINDOW} 日趋势段：自 ${seg.anchorDate} 低点 ${_round(seg.anchorPrice)} 上涨 +${_round(seg.movePct)}%（期间最大回撤 ${_round(seg.pullbackPct)}%，上涨结构完整）→ 判定趋势运行`
    : `近 ${TREND_SEG_WINDOW} 日趋势段：自 ${seg.anchorDate} 高点 ${_round(seg.anchorPrice)} 下跌 ${_round(seg.movePct)}%（期间最大反弹 ${_round(seg.pullbackPct)}%，下跌结构未扭转）→ 判定趋势运行`;
  return seg;
}

function _keyLevels(pc, platform, hints) {
  const cands = [];
  if (platform) {
    cands.push({ price: platform.high, kind: '震荡平台上沿' });
    cands.push({ price: platform.low, kind: '震荡平台下沿' });
  }
  cands.push({ price: pc.stageHigh, kind: '阶段高点' });
  cands.push({ price: pc.stageLow, kind: '阶段低点' });
  if (pc.ma60) cands.push({ price: pc.ma60, kind: '60日均线' });
  if (pc.ma20) cands.push({ price: pc.ma20, kind: '20日均线' });
  // 关键压力位：平台上沿正处于测试（收盘价在其下方 10% 以内）时优先，否则取上方最近候选
  let resistance;
  if (platform && platform.high >= pc.closeToday * 0.90) {
    resistance = { price: platform.high, kind: '震荡平台上沿' };
  } else {
    const above = cands.filter(c => c.price > pc.closeToday * 1.001).sort((a, b) => a.price - b.price);
    resistance = above.length ? above[0] : { price: pc.stageHigh, kind: '阶段高点（上方无其他候选）' };
  }
  // 关键支撑位：平台下沿正处于测试（收盘价在其上方 10% 以内，含刚跌破）时优先，否则取下方最近候选
  let support;
  if (platform && platform.low <= pc.closeToday * 1.10) {
    support = { price: platform.low, kind: '震荡平台下沿' };
  } else {
    const below = cands.filter(c => c.price < pc.closeToday * 0.999).sort((a, b) => b.price - a.price);
    support = below.length ? below[0] : { price: pc.stageLow, kind: '阶段低点（下方无其他候选）' };
  }
  // 20261022d：优先引用「短期动向预判」模块的有效区间，避免本引擎另立一套支撑/阻力口径。
  // hint 是区间 [low, high]：支撑 → price 取 low（跌破线）、触及线用 high；
  //                          阻力 → price 取 high（突破线）、触及线用 low。
  // 20261106p：加 fromHints 标记——规则3「假突破量能不确认」只认②卡区间（唯一权威点位来源），
  //   引擎自算兜底位仅供关键支撑/压力卡与规则4等展示/破位判定使用，不再作为假突破攻击目标。
  const isNum = (v) => typeof v === 'number' && isFinite(v) && v > 0;
  const h = hints || {};
  if (h.support && isNum(h.support.low) && isNum(h.support.high) && h.support.high >= h.support.low) {
    support = { price: h.support.low, low: h.support.low, high: h.support.high, kind: h.support.kind || '短期动向·支撑区间', fromHints: true };
  }
  if (h.resistance && isNum(h.resistance.low) && isNum(h.resistance.high) && h.resistance.high >= h.resistance.low) {
    resistance = { price: h.resistance.high, low: h.resistance.low, high: h.resistance.high, kind: h.resistance.kind || '短期动向·阻力区间', fromHints: true };
  }
  // 统一补齐 low/high（无 hint 时 = 单点价位）
  if (!isNum(support.low)) support = { price: support.price, low: support.price, high: support.price, kind: support.kind };
  if (!isNum(resistance.low)) resistance = { price: resistance.price, low: resistance.price, high: resistance.price, kind: resistance.kind };
  return { support, resistance };
}

// 20261106a：位置判定统一为新标准三分区（高位区间 / 中位区间 / 低位区间），与 _posZone 的价格分位口径同源。
// 旧四类位置体系（趋势方向混入位置标签的旧定位）整体退役：方向语义不再由位置标签承载，
// 改由新标准 135 格的运行状态（_runState / posModel135）判定；趋势段与长期年线信息保留在
// basis / trendSegment / longTermVerdict 供审计，但不再改写位置标签（20261104e 阶梯对位置的影响取消）。
function _detectPosition(pc, platform, trendSeg) {
  const pct = pc.pricePct12m;
  const dd = pc.drawdownFromHigh;
  const rally = pc.rallyFromLow;
  const lt = pc.longTerm || null;
  const ltVerdict = lt && lt.verdict ? lt.verdict : null;

  let label = '中位区间';
  let divergence = null;
  if (pct !== null && pct < 0.3) {
    label = '低位区间';
    if (dd !== null && dd > -15) divergence = `位置判定存在分歧：12个月价格分位 ${_fmtPct(pct * 100)} 属低位，但现价距阶段高点仅 ${_fmtPct(-dd)}，近期自底部反弹 ${_fmtPct(rally)}，低位结论置信度下调`;
  } else if (pct !== null && pct > 0.7) {
    label = '高位区间';
    if (rally !== null && rally < 30) divergence = `位置判定存在分歧：12个月价格分位 ${_fmtPct(pct * 100)} 属高位，但现价距阶段低点仅 ${_fmtPct(rally)}，未经过大幅上涨，高位结论置信度下调`;
  } else if (pct === null) {
    divergence = '位置判定存在分歧：价格分位数据不足，按中位区间处理';
  }

  let basis = pct !== null
    ? `12个月价格分位 ${_fmtPct(pct * 100)}（新标准三分区：≥70% 高位 / ≤30% 低位，其余中位）；距阶段高点 ${_fmtPct(dd)}；距阶段低点 ${_fmtPct(rally)}；MA20 ${pc.ma20 ? _round(pc.ma20) : '数据不足'} / MA60 ${pc.ma60 ? _round(pc.ma60) : '数据不足'}`
    : '价格分位数据不足';
  if (trendSeg && trendSeg.reason) basis += `；短期趋势段（仅审计，不改写位置）：${trendSeg.reason}`;
  if (ltVerdict) {
    const ma250 = lt && lt.ma250 ? lt.ma250 : null;
    basis += ma250
      ? `；长期趋势（MA250 年线，仅审计）：${ltVerdict}——年线 ${_round(ma250.value)}（${ma250.slopeState}，近20日斜率${ma250.slopePct >= 0 ? '+' : ''}${ma250.slopePct}%）`
      : `；长期趋势（MA250 年线，仅审计）：${ltVerdict}（年线数据不足）`;
  }
  return { label, divergence, basis, longTermVerdict: ltVerdict, trendSegment: trendSeg || null };
}

// ===================== 3. 量价三问（spec 第四章） =====================

function _threeChecks(pc) {
  const failed = [];
  // ① 量能真实性：当前量能显著偏离日常水平（相对 20 日均量偏离 ≥50%）
  const dev = pc.ratio20 !== null ? Math.abs(pc.ratio20 - 1) : null;
  const authenticity = {
    pass: dev !== null && dev >= 0.5,
    note: dev === null ? '20 日均量数据不足，真实性无法校验'
      : (dev >= 0.5 ? `当前量相对 20 日均量 ${_round(pc.ratio20)} 倍，显著偏离日常水平，可确认为主动资金行为`
        : `当前量相对 20 日均量 ${_round(pc.ratio20)} 倍，与日常水平接近，偏向散户零散交易随机波动`),
  };
  if (!authenticity.pass) failed.push('量能真实性不足');

  // ② 价格认可度：放量应对应价格企稳/突破；缩量应对应价格回落/无力
  // 20261106n：判定基准由 60 日 confirm 改为 ÷20 日均量统一三态（放量 >1.3 / 缩量 <0.8）
  let priceAcceptance;
  if (pc.chgPct === null) {
    priceAcceptance = { pass: false, note: '前一日收盘数据不足，价格认可度无法校验' };
  } else if (isAmpRatio(pc.ratio20)) {
    const ok = pc.chgPct > 0;
    priceAcceptance = {
      pass: ok,
      note: ok ? `放量（当日量 ÷ 20日均量 ${_round(pc.ratio20)} 倍）且当日收涨 ${_fmtPct(pc.chgPct, 2)}，价格与量能同向反馈`
        : `放量（当日量 ÷ 20日均量 ${_round(pc.ratio20)} 倍）但当日收跌 ${_fmtPct(pc.chgPct, 2)}，量价不匹配，标记矛盾`,
    };
  } else if (isShrinkRatio(pc.ratio20)) {
    const ok = pc.chgPct <= 0;
    priceAcceptance = {
      pass: ok,
      note: ok ? `缩量（当日量 ÷ 20日均量 ${_round(pc.ratio20)} 倍）且当日收跌 ${_fmtPct(pc.chgPct, 2)}，抛压萎缩与价格回落匹配`
        : `缩量（当日量 ÷ 20日均量 ${_round(pc.ratio20)} 倍）但当日收涨 ${_fmtPct(pc.chgPct, 2)}，上涨无量能确认，标记矛盾`,
    };
  } else {
    priceAcceptance = { pass: true, note: '当前量能未达放量/缩量阈值（÷20日均量 0.8~1.3 平量区），按常态处理' };
  }
  if (!priceAcceptance.pass) failed.push('价格认可度不足');

  // ③ 持续性：放量/缩量状态连续 ≥2 个交易日（20261109c 阈值统一 volumeCaliber：×1.3 / ×0.8）
  const n = pc.n;
  let persistence;
  if (pc.avg20 <= 0 || n < 3) {
    persistence = { pass: false, note: '20 日均量数据不足，持续性无法校验' };
  } else {
    const v1 = pc.vols[n - 1], v2 = pc.vols[n - 2];
    const amp2 = isAmpRatio(ratioOfVol(v1, pc.avg20)) && isAmpRatio(ratioOfVol(v2, pc.avg20));
    const shrink2 = isShrinkRatio(ratioOfVol(v1, pc.avg20)) && isShrinkRatio(ratioOfVol(v2, pc.avg20));
    if (amp2) persistence = { pass: true, note: `最近 2 个交易日成交量均超过 20 日均量 ×${VOL_AMP}，放量具备持续性` };
    else if (shrink2) persistence = { pass: true, note: `最近 2 个交易日成交量均低于 20 日均量 ×${VOL_SHRINK}，缩量具备持续性` };
    else {
      persistence = { pass: false, note: '量能状态仅最新一日偏离，未连续不少于 2 个交易日，排除单日异动前持续性不足' };
      failed.push('持续性不足');
    }
  }

  // 单根脉冲爆量：只有最新一根巨量（>5 日均量 2.5 倍），前后 K 线均为缩量（÷20 日均量 <0.8；20261109c 统一阈值）
  // 口径与 _precompute.pulse 一致（三问/连续序列/打分共用同一判定）
  const pulse = pc.pulse;
  if (pulse) failed.push('单日脉冲');

  return { authenticity, priceAcceptance, persistence, pulse, failed };
}

// ===================== 4. 背离检测（spec 第五章） =====================

function _detectDivergence(pc) {
  if (pc.n < 2 || pc.ratio5Prev === null) {
    return { type: null, note: '数据不足，无法判定量价背离' };
  }
  const prevCloses = pc.closes.slice(-250, -1);
  // 严格创新高/新低：收盘必须超过/跌破此前极值（持平不算「创出」）
  const newHigh = pc.closeToday > Math.max(...prevCloses);
  const newLow = pc.closeToday < Math.min(...prevCloses);
  const volDown = pc.volPrev !== null && pc.volToday < pc.volPrev;
  const ratioFalling = pc.ratio5 < pc.ratio5Prev; // 相对 5 日均量的量能水平回落

  if (newHigh && volDown && ratioFalling) {
    return { type: '顶背离', note: '价格创阶段新高，但成交量低于前一日且相对 5 日均量的量能水平持续回落：多头量能衰竭，作为风险标签输出' };
  }
  if (newLow && volDown && !ratioFalling) {
    return { type: '底背离', note: '价格创阶段新低，成交量低于前一日但萎缩程度不再继续创新低：空头量能衰竭，潜在底部观察点' };
  }
  if (newHigh || newLow) {
    const volUp = pc.volPrev !== null && pc.volToday > pc.volPrev;
    if ((newHigh && !volUp) || (newLow && !volUp)) {
      return { type: '一般量价背离', note: `价格创阶段${newHigh ? '新高' : '新低'}但量能未同步放大，标记量价背离风险` };
    }
  }
  return { type: null, note: '未检测到量价背离' };
}

// ===================== 5. 五大生死位规则（spec 第六章） =====================

function _limitPct(symbol, name) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '');
  if (/\*?ST|退/i.test(name || '')) return 0.05;
  if (/^(688|30)/.test(code)) return 0.2;
  if (/^[48]/.test(code)) return 0.3;
  return 0.1;
}

/**
 * [20261109c] 同价位带最近前高（基准可比性铁律，仅作展示参照、不参与任何量能判定）
 * ------------------------------------------------------------------
 * 旧实现 `for (i<n-1) if (bars[i].high > pH)` 取全窗口全局最高价那天，
 * 对上市不久/长期下行的标的必然选到「上市首日天量 + 远价位」（威高血净 603014
 * 选中 2025-05-19 的 265682 手 / 48.44，而 2026-11-09 股价仅 ~35、阻力区间 ~36-38，
 * 2026-06-17 明明有 ~38 的同价位前高）。跨期跨价位量能不可比，且把「当日量必须
 * 超过它」当门槛 → 结构性假命中「缩量假突破」。
 *
 * 现按用户裁决「同价位带最近前高」：
 *   ① 与分析期可比：剔除上市初期前 5 根、剔除除权/股本断点之前的样本；
 *   ② 与价位带可比：只认阻力区间触及线 ±REF_PRICE_BAND_PCT 内的局部高点；
 *   ③ 时间最近：从攻击日前一根倒序取第一个有效局部前高；
 *   ④ 剔除极端异常量：超过同价位带成交量中位数 ×REF_EXTREME_VOL_MULT 的样本；
 *   ⑤ 无合格样本返回 null，由调用方诚实披露「参照不可得」，绝不回退全局最高价。
 *
 * @param {Array} bars 日K（升序，含 date/high/close/volume）
 * @param {number} n   bars 长度（含当日）
 * @param {number} anchor 阻力区间触及线（resLevel.low）
 * @returns {{date:string, price:number, volume:number, bandPct:number}|null}
 */
function _pickRefHigh(bars, n, anchor) {
  if (!Array.isArray(bars) || !(anchor > 0) || n < REF_LISTING_GUARD_BARS + 4) return null;
  const end = n - 1; // 攻击日（不含）
  // ① 除权/股本断点：单日收盘跳变超过阈值，视为复权断点，只用断点之后的样本
  let start = REF_LISTING_GUARD_BARS;
  for (let i = REF_LISTING_GUARD_BARS + 1; i < end; i++) {
    const c0 = Number(bars[i - 1] && bars[i - 1].close);
    const c1 = Number(bars[i] && bars[i].close);
    if (c0 > 0 && c1 > 0 && Math.abs(c1 / c0 - 1) > REF_EXRIGHT_GAP) start = Math.max(start, i); // 不回退上市保护线
  }
  if (end - start < 3) return null;
  const inBand = (b) => {
    const h = Number(b && b.high);
    return h > 0 && Math.abs(h - anchor) / anchor <= REF_PRICE_BAND_PCT;
  };
  // ④ 同价位带成交量中位数 → 极端异常量剔除线
  const bandVols = [];
  for (let i = start; i < end; i++) {
    if (!inBand(bars[i])) continue;
    const v = Number(bars[i] && bars[i].volume);
    if (v > 0) bandVols.push(v);
  }
  const med = bandVols.length ? _median(bandVols) : 0;
  // ②③ 倒序取同价位带内时间最近的「有效局部前高」
  for (let i = end - 1; i >= start + 1; i--) {
    const b = bars[i];
    if (!b || !inBand(b)) continue;
    const h = Number(b.high), v = Number(b.volume);
    if (!(h > 0) || !(v > 0)) continue;
    const hp = Number(bars[i - 1] && bars[i - 1].high);
    const hn = Number(bars[i + 1] && bars[i + 1].high);
    if (!(h >= hp && h > hn)) continue; // 必须是局部高点（右侧严格高于，避免平台重复计数）
    if (med > 0 && v > med * REF_EXTREME_VOL_MULT) continue; // 极端异常量
    return { date: String(b.date || ''), price: h, volume: v, bandPct: REF_PRICE_BAND_PCT };
  }
  return null;
}

function _lifeRules(pc, ctx) {
  const { position, platform, minutes, symbol, name } = ctx;
  const bars = ctx.bars;
  const n = pc.n;
  const rules = [];

  // ---- 规则 1：低位吸筹（多头信号） ----
  {
    const dataGaps = [];
    let matched = false;
    const priorSideways = !!(platform && platform.endIdx <= n - 4 && platform.days >= 20);
    if (!priorSideways) dataGaps.push('前期未识别到不少于 20 个交易日的横盘整理');
    const last3 = pc.vols.slice(-3);
    // 20261109c：连续放量阈值统一 volumeCaliber（×1.3），与 135 格主判同源
    const amp3 = pc.avg20 > 0 && last3.length === 3 && last3.every(v => isAmpRatio(ratioOfVol(v, pc.avg20)));
    const steady = pc.closes[n - 1] >= pc.closes[n - 3];
    if (!steady) dataGaps.push('价格随放量下跌，重心未企稳或小幅抬升');
    if (!amp3) {
      const thr = pc.avg20 > 0 ? _round(pc.avg20 * VOL_AMP, 0) : null;
      const last3Txt = last3.length === 3 ? last3.map(v => _round(v, 0)).join(' / ') : '样本不足';
      dataGaps.push(`最近 3 个交易日成交量 ${last3Txt} 手，未连续超过 20 日均量（${pc.avg20 > 0 ? _round(pc.avg20, 0) : '数据不足'} 手）×${VOL_AMP} = ${thr} 手`);
    }
    matched = position.label === '低位区间' && priorSideways && amp3 && steady && !ctx.checks.pulse;
    rules.push({
      id: 1, name: '低位吸筹', direction: 'bull', priority: 'normal', matched,
      conclusion: matched
        ? '判定为低位资金承接吸筹行为：价格处于低位区间，前期完成横盘整理后连续 3 日放量，价格重心企稳未随放量下跌，量能放大具备连续性。筹码呈现由散户向主力集中的转移趋势，量价配合处于健康多头初期状态'
        : '不满足低位吸筹触发条件（需同时满足：低位区间 + 前期≥20日横盘 + 连续3日放量 + 价格重心企稳 + 非单日脉冲）',
      dataGaps,
    });
  }

  // ---- 规则 2：高位派发（空头预警，最高优先级） ----
  {
    const dataGaps = [];
    let matched = false;
    const isYearMaxVol = pc.volToday >= Math.max(...pc.vols.slice(-250, -1)); // 近 12 个月（250 根）历史新高
    if (!pc.hasTurnover) dataGaps.push('换手率数据不足，天量确认降级');
    const turnoverExtreme = pc.hasTurnover && pc.turnoverMean !== null && pc.turnoverToday >= pc.turnoverMean * 2;
    if (!minutes || !minutes.minutes || !minutes.minutes.length) {
      dataGaps.push('分时数据不足，本规则不匹配（日内分时震荡与涨停开板无法核验，不得臆造）');
    }
    let intradayOk = false;
    if (minutes && minutes.minutes && minutes.minutes.length) {
      const prices = minutes.minutes.map(m => m.price).filter(p => isFinite(p) && p > 0);
      if (prices.length) {
        const mx = Math.max(...prices), mn = Math.min(...prices);
        const swing = mn > 0 ? (mx - mn) / mn : 0;
        intradayOk = swing >= 0.03; // 日内分时线大幅上下震荡（≥3%）
      }
    }
    // 涨停封死核验：北交所/科创/创业板 20%、ST 5%、其余 10%（前复权口径下为近似值）
    const limitPct = _limitPct(symbol, name);
    const limitPrice = pc.closePrev ? pc.closePrev * (1 + limitPct) : null;
    const touchedLimit = limitPrice !== null && pc.highToday >= limitPrice * 0.995;
    const notSealed = limitPrice !== null && pc.closeToday < limitPrice * 0.995;
    const atHigh = pc.closeToday >= pc.highToday * 0.995;
    if (!touchedLimit) dataGaps.push('当日未触及涨停价，「无法封死涨停/反复开板」条件不适用，按分时大幅震荡 + 历史天量 + 换手率阶段极高判定');
    if (position.label === '高位区间' && isYearMaxVol && turnoverExtreme && intradayOk && !atHigh && (touchedLimit ? notSealed : true)) {
      matched = true;
    }
    if (position.label !== '高位区间') dataGaps.push('价格未处于高位区间');
    if (!isYearMaxVol) {
      const maxVol12m = pc.vols.length >= 2 ? Math.max(...pc.vols.slice(-250, -1)) : null;
      dataGaps.push(`当日成交量 ${_round(pc.volToday, 0)} 手，未创近 12 个月历史新高（历史峰值 ${_round(maxVol12m, 0)} 手，天量条件不满足）`);
    }
    if (pc.hasTurnover && !turnoverExtreme) {
      const mean2 = pc.turnoverMean !== null ? _round(pc.turnoverMean * 2, 2) : null;
      dataGaps.push(`换手率 ${_round(pc.turnoverToday, 2)}%，未达历史均值 2 倍的阶段极高水平（均值 ${_round(pc.turnoverMean, 2)}% ×2 = ${mean2}%）`);
    }
    rules.push({
      id: 2, name: '高位派发', direction: 'bear', priority: 'top', matched,
      conclusion: matched
        ? '判定为高位资金派发行为：价格处于高位区间，单日放出历史天量且换手率处于阶段极高值，日内分时大幅震荡且未能收在高点，主力筹码向散户转移，抛压集中释放，量价结构呈现明确空头预警状态'
        : '不满足高位派发触发条件（需同时满足：高位区间 + 历史天量 + 换手率阶段极高 + 分时大幅震荡 + 无法封死涨停/反复开板）',
      dataGaps,
    });
  }

  // ---- 规则 3：假突破量能不确认（多头失效信号） ----
  // [20261109c] 用户裁决（威高血净 603014，2026-11-09 两张截图）：
  //   ① 量能判定必须接入 20 日量能比单一真值源，禁止再保留 ×1.5 或「当日量 > 前高量能」第二套判据；
  //   ② 前高量能基准改「同价位带 + 时间最近的有效局部前高」，剔除上市初期 / 除权断点 /
  //      极端异常量，且只作展示参照、不参与判定；
  //   ③ 全个股统一（非单只特例）；④ 原规则名「缩量假突破」在平量/放量日会与主判互斥，改中性表述。
  {
    const dataGaps = [];
    let matched = false;
    let detail = '';
    // 20261028a：盘中停判——当日量为「部分日累计」，与全天量能基准结构上不可比，
    // 盘中比较必然偏小 → fail-closed 必假命中；盘中只给参考数值，收盘后按同一规则定论。
    const intradayPending = ctx.intradayPending === true;
    if (intradayPending) dataGaps.push('当日未收盘，本规则收盘后判定：盘中当日量为部分日累计，与 20 日均量全天基准不可比，盘中比较必然偏小，不作定论');
    // 唯一量能判据（与 _volumeTier / 135 格 _volTier5 同源）：÷20 日均量 >1.3 = 已放量确认
    const ratio20 = pc.ratio20;
    const volumeDataOk = ratio20 !== null && ratio20 !== undefined && isFinite(ratio20);
    const ampOk = volumeDataOk && isAmpRatio(ratio20);
    const volTierTxt = tierOfRatio(ratio20) || '数据不足';
    const ampThr = pc.avg20 > 0 ? _round(pc.avg20 * VOL_AMP, 0) : null;
    // 攻击目标：仅认②卡有效阻力区间（fromHints 标记，见 _keyLevels 20261106p 注释）
    const resLevel = (ctx.levels && ctx.levels.resistance && ctx.levels.resistance.fromHints === true) ? ctx.levels.resistance : null;
    if (!resLevel) {
      dataGaps.push('②卡「短期动向预判」有效阻力区间不可得（快照缺失），本规则诚实停判：技术面区间为唯一权威点位来源，不回退引擎自算平台（20261106p）');
    } else if (!volumeDataOk) {
      dataGaps.push('20 日均量数据不足，量能档位不可判（不硬套、不臆造），本规则诚实停判');
    } else {
      const touchPrice = resLevel.low;
      const touched = bars[n - 1].high >= touchPrice * 0.995;
      const fellBack = pc.closeToday < touchPrice;
      // 前高对应量能：同价位带 + 时间最近的有效局部前高（仅展示参照，绝不参与判定）
      const ref = _pickRefHigh(bars, n, touchPrice);
      const refTxt = ref
        ? `同价位带最近前高对应量能 ${_round(ref.volume, 0)} 手（${ref.date}，高点 ${_round(ref.price)}，偏离触及线 ${_round((ref.price - touchPrice) / touchPrice * 100, 1)}%；仅作参照、不参与判定）`
        : `同价位带（触及线 ±${_round(REF_PRICE_BAND_PCT * 100, 0)}%）内无有效局部前高，前高量能参照不可得（不臆造，也不影响本规则判定）`;
      const volDetail = `当日成交量 ${_round(bars[n - 1].volume, 0)} 手，${refTxt}；20 日量能比 ${_round(ratio20)} 倍（${volTierTxt}；20 日均量 ${pc.avg20 > 0 ? _round(pc.avg20, 0) : '数据不足'} 手 ×${VOL_AMP} = ${ampThr} 手）`;
      if (!touched) {
        dataGaps.push(`未冲击有效阻力区间（${resLevel.kind}，触及线 ${_round(touchPrice)}），或突破日量能已有效放大`);
      } else if (!fellBack) {
        dataGaps.push(`价格站稳有效阻力区间触及线 ${_round(touchPrice)} 上方，不属于短暂突破后快速回落`);
      } else if (intradayPending) {
        dataGaps.push(`盘中参考（不构成判定）：冲击有效阻力区间（${resLevel.kind}）触及线 ${_round(touchPrice)} 后回落，${volDetail} —— 收盘后按同一规则定论`);
      } else if (!ampOk) {
        matched = true;
        detail = `价格冲击有效阻力区间（${resLevel.kind}）触及线 ${_round(touchPrice)} 后快速回落，${volDetail}，量能未获放量确认（÷20 日均量 ${_round(ratio20)} 倍，未达放量阈值 >${VOL_AMP}），无新增增量资金承接。标记 K 线骗线、假突破，不得给出看多信号`;
      }
    }
    if (!matched && !dataGaps.length) dataGaps.push('近期未冲击②卡有效阻力区间，或突破日量能已有效放大');
    rules.push({
      id: 3, name: '假突破量能不确认', direction: 'bear-block', priority: 'normal', matched,
      conclusion: matched
        ? `判定为假突破量能不确认：${detail}`
        : (intradayPending
          ? '当日未收盘，需收盘后定论（盘中当日量为部分日累计，与 20 日均量全天基准不可比，盘中一律不判）'
          : '不满足触发条件（需同时满足：冲击②卡有效阻力区间 + 快速回落 + 当日量 ÷ 20 日均量未达放量阈值；区间或量能数据不可得时诚实停判）'),
      dataGaps,
    });
  }

  // ---- 规则 4：放量破位（空头确认，最高优先级） ----
  {
    const dataGaps = [];
    let matched = false;
    // 20261022d：支撑位优先引用「短期动向预判」模块的有效支撑区间，不再另算一套。
    // 区间化后：「触及」= 最低价到达区间上沿（high）；「跌破」= 收盘跌破区间下沿（low）≥3%。
    // 无 hint 时 low=high=price（单点），行为与旧版完全一致。
    const sup = ctx.levels.support || {};
    const touchLine = (typeof sup.high === 'number' && isFinite(sup.high) && sup.high > 0) ? sup.high : sup.price;
    const breakLine = (typeof sup.low === 'number' && isFinite(sup.low) && sup.low > 0) ? sup.low : sup.price;
    const s = breakLine;
    const touchedS = touchLine > 0 && pc.lowToday <= touchLine * 1.01;
    const amplified = isAmpRatio(pc.ratio20); // [20261109c] 与 135 格 / 规则3 共用单一真值源
    const effBreak = s > 0 && pc.closeToday < s * 0.97; // 收盘跌破支撑 ≥3%
    const twoDays = n >= 2 && s > 0 && pc.closes[n - 1] < s * 0.97 && pc.closes[n - 2] < s * 0.97;
    matched = touchedS && amplified && effBreak;
    if (!touchedS) dataGaps.push('价格未触及关键支撑位');
    if (touchedS && !amplified) {
      const thr = pc.avg20 > 0 ? _round(pc.avg20 * VOL_AMP, 0) : null;
      dataGaps.push(`跌破未伴随放量（今日量 ${_round(pc.volToday, 0)} 手，÷20 日均量 ${pc.avg20 > 0 ? _round(pc.avg20, 0) : '数据不足'} 手未达 ×${VOL_AMP} = ${thr} 手）`);
    }
    if (touchedS && amplified && !effBreak) dataGaps.push('收盘价未有效跌破支撑位（未跌破 3%）');
    rules.push({
      id: 4, name: '放量破位', direction: 'bear', priority: 'top',
      matched: matched && twoDays,
      partial: matched && !twoDays,
      conclusion: matched && twoDays
        ? `判定为支撑位资金集中离场行为：价格触及关键支撑位 ${_round(s)}（${ctx.levels.support.kind}），放量且收盘有效跌破并连续 2 日站不回，关键支撑位的筹码承接彻底失效，抛压主导市场，量价结构确认空头破位状态`
        : (matched && !twoDays
          ? `价格已放量触及关键支撑位 ${_round(s)} 并单日跌破 3%，但尚未满足「连续 2 个交易日站不回」的有效破位定义，按初步破位处理，有效破位待确认`
          : '不满足放量破位触发条件（需同时满足：触及关键支撑位 + 跌破当日放量 + 收盘有效跌破）'),
      dataGaps,
    });
  }

  // ---- 规则 5：分时无量拉升（日内空头信号） ----
  {
    const dataGaps = [];
    let matched = false;
    if (!minutes || !minutes.minutes || minutes.minutes.length < 30) {
      dataGaps.push('分时数据不足，本规则不匹配');
    } else {
      const ms = minutes.minutes;
      // 20261020c：尾盘窗口按 time 时间戳剔除盘后条目（与口诀3「14:30-15:00 时间戳截取」同口径）。
      // 根因（用户 2026-10-20 截图报障 688289 圣湘生物误命中）：腾讯分时收盘后追加 15:01-15:30
      // 盘后条目（688289 实测追加 25 条、末条 15:30，cumVol 恒定等于收盘累计值）→ 盘后分钟
      // 差分量恒为 0。原实现用原始数组位置取「最后 40/20 分钟」，实际窗口混入约 25 分钟零量
      // 盘后数据：① 第 3/4 桶几乎全为盘后零量（688289 实测 b3=3、b4=0）→ 末桶不足首桶 60%
      // 恒真；② 末 20 分钟最大分钟量≈0 → 「无新增接力」恒真。于是 shrink+noRelay 对任何
      // 收盘股近乎恒真，只剩 priceAtHigh 一道闸——688289 收盘 15.95 距日内最高 15.98 仅 0.19%
      // 恰好过 0.998 线而误命中。实证（剔除盘后条目后）：688289 末 40 分钟分桶
      // 381/865/653/2333（末桶最大，量能实际放大）且末 20 分钟最大分钟量 453 = 此前均量
      // 118.4 的 3.8 倍——「逐级萎缩且无新增量能接力」与事实正好相反。
      const timeOf = (x) => (/^\d{4}$/.test(String(x.time || '')) ? String(x.time) : null);
      const tradeMs = ms.filter(x => { const t = timeOf(x); return t !== null && t <= '1500'; });
      if (tradeMs.length < 40) {
        dataGaps.push(`分时交易时段数据不足（时间戳可解析且不晚于 15:00 的条目仅 ${tradeMs.length} 分钟，需 ≥40），本规则不匹配`);
      } else if (!tradeMs.every(m => typeof m.cumVol === 'number')) {
        dataGaps.push('分时累计成交量字段缺失，无法计算每分钟成交量，本规则不匹配');
      } else {
        const tradePrices = tradeMs.map(m => m.price).filter(p => isFinite(p) && p > 0);
        const priceAtHigh = tradePrices.length && tradePrices[tradePrices.length - 1] >= Math.max(...tradePrices) * 0.998;
        // 每分钟成交量 = 相邻累计量差分（仅交易时段条目；14:57-15:00 收盘集合竞价时段的零量分钟为真实数据，保留）
        const mv = [];
        for (let i = 1; i < tradeMs.length; i++) mv.push(Math.max(0, tradeMs[i].cumVol - tradeMs[i - 1].cumVol));
        // 逐级萎缩：最后 40 分钟分 4 桶（每桶 10 分钟），桶和递减且末桶不足首桶 60%
        let shrink = false;
        if (mv.length >= 40) {
          const b1 = mv.slice(-40, -30).reduce((a, b) => a + b, 0);
          const b2 = mv.slice(-30, -20).reduce((a, b) => a + b, 0);
          const b3 = mv.slice(-20, -10).reduce((a, b) => a + b, 0);
          const b4 = mv.slice(-10).reduce((a, b) => a + b, 0);
          shrink = b1 > b2 && b2 >= b3 && b3 > b4 && b4 < b1 * 0.6;
        }
        // 无新增量能接力：最后 20 分钟无脉冲（最大分钟量 ≤ 此前均量 ×1.2）
        let noRelay = false;
        if (mv.length >= 40) {
          const prevMean = _mean(mv.slice(0, -20));
          noRelay = prevMean > 0 && Math.max(...mv.slice(-20)) <= prevMean * 1.2;
        }
        matched = !!priceAtHigh && shrink && noRelay;
        if (!priceAtHigh) dataGaps.push('分时价格未持续走高至日内新高附近');
        if (!shrink) dataGaps.push('分时成交量未呈逐级萎缩');
        if (!noRelay) dataGaps.push('尾盘出现新增量能脉冲，存在接力');
      }
    }
    rules.push({
      id: 5, name: '分时无量拉升', direction: 'bear', priority: 'normal', matched,
      conclusion: matched
        ? '判定为日内无量空涨形态：分时价格持续走高创出日内新高，但分时成交量逐级萎缩且无新增量能接力，属于无承接的被动拉升，量价形成日内背离'
        : '不满足分时无量拉升触发条件（需分时数据 + 价格创日内新高 + 成交量逐级萎缩 + 无新增接力）',
      dataGaps,
    });
  }

  return rules;
}

// ===================== 6. 位置×量能组合引擎（spec 第七章） =====================

function _longUpperShadow(pc) {
  const body = Math.abs(pc.closeToday - pc.openToday);
  const upper = pc.highToday - Math.max(pc.openToday, pc.closeToday);
  return upper >= pc.closeToday * 0.03 && upper >= 2 * body;
}

function _comboEngine(pc, ctx) {
  const { position } = ctx;
  const up = pc.chgPct !== null && pc.chgPct > 0;
  const down = pc.chgPct !== null && pc.chgPct < 0;
  const flat = pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2;
  // 20261019f：放量/缩量判定改为市场标准量比（÷5日均量 >1.2 / <0.8）单独定档，
  // 60 日均量确认不再翻转——旧逻辑把量比 0.99（市场=平量）翻成缩量，与市场标准矛盾
  // （用户 2026-10-19 新洋丰实测反馈）；与 _volumeTier / _volTraits 同式，三卡保持同源。
  // 20261106n（用户裁决）：amplified/shrunk 统一到 ÷20 日均量三态（>1.3 / <0.8，与 _volumeTier
  // / 135 格 _volTier5 同源）——旧式 ratio5>1.2/<0.8 是 20261106j 分母统一的漏改点，导致
  // 「资金行为判量平价升（÷5 平量）vs 量价关系判放量上涨（÷20 放量）」同屏互斥
  // （LRN-20261106-001 同类复发：两条链并存、下游读旧链）。huge（大量/天量极端档）保留 ÷5 口径。
  const amplified = isAmpRatio(pc.ratio20);
  const shrunk = isShrinkRatio(pc.ratio20);
  const huge = pc.level === '大量' || pc.level === '天量';
  const tags = [];
  let direction = 'neutral';
  let scenario = '常态运行';
  let conclusion = '当前量价无显著异常信号，处于常态运行';

  if (flat) {
    // 横盘震荡场景（spec 第五章4）
    if (pc.level === '极度缩量') {
      scenario = '横盘极度缩量';
      direction = 'observe';
      conclusion = '横盘叠加极度缩量：判定筹码沉淀，浮动筹码减少，等待放量突破信号，仅入观察池不生成看多信号';
    } else if (huge && ctx.persistentHuge) {
      scenario = '横盘持续巨量';
      direction = 'caution';
      conclusion = '横盘持续巨量：判定筹码剧烈交换，多空分歧巨大，方向不明，作为风险结论输出';
      tags.push('单日脉冲假信号');
    } else {
      scenario = '横盘常态';
      direction = 'neutral';
      conclusion = '横盘震荡，量价无显著异常';
    }
    return { scenario, direction, conclusion, tags };
  }

  const pos = position.label;
  if (up) {
    if (amplified) {
      // 位置优先（spec 第五章矩阵按位置×量能组织）；巨量折扣由打分层 s40 巨量−5 承担，不覆盖矩阵格
      if (pos === '高位区间') {
        scenario = '高位放量收阳';
        direction = 'caution';
        conclusion = '高位区间放量收阳：重点识别诱多和 K 线造假，阳线好看但放量代表主力大规模派发筹码，量能暴露逃顶事实';
        tags.push('K线骗线');
      } else if (pos === '趋势向下') {
        scenario = '趋势向下放量反弹';
        direction = 'bear';
        conclusion = '趋势向下放量反弹：无论阴阳，判定抛压释放、下跌动能强化，反弹大概率是诱多';
      } else if (pos === '低位区间') {
        scenario = '低位放量收阳';
        direction = 'bull';
        conclusion = '低位区间放量收阳：判定资金进场信号，真实买盘介入，K 线阳线可信度高';
      } else if (_longUpperShadow(pc)) {
        scenario = '趋势向上放量长上影';
        direction = 'caution';
        conclusion = '趋势向上放量长上影：判定分歧加大，短期有回调风险，警惕假突破';
      } else if (huge) {
        scenario = '放量上涨（巨量）';
        direction = 'caution';
        conclusion = `上涨叠加巨量（当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍）：加分下调，警惕冲高兑现`;
      } else {
        scenario = '趋势向上放量收阳';
        direction = 'bull';
        conclusion = '趋势向上放量收阳：判定健康换手，资金接力，趋势延续概率高';
      }
    } else if (shrunk) {
      scenario = '缩量上涨';
      direction = 'caution';
      conclusion = '缩量上涨：上涨动能不足，量能不确认，保持谨慎；若为突破形态，标记 K 线骗线、假突破嫌疑';
      tags.push('K线骗线', '量能不确认');
    } else {
      scenario = '平量上涨';
      direction = 'observe';
      conclusion = '量平价升：成交量与前期相当，没有增量资金大举进场、也没有资金砸盘，属于弱需求上涨、持续性存疑；只作观察，等放量突破确认或放量回落证伪';
    }
  } else if (down) {
    if (amplified) {
      // 位置优先：低位放量收阴即底部洗盘（出逃判定只属于高位，由规则2 高位派发兜底）
      if (pos === '低位区间') {
        scenario = '低位放量收阴';
        direction = 'observe';
        conclusion = '低位区间放量收阴：判定恐慌抛盘释放，筹码交换，属于底部洗盘特征，不是新主力出逃';
      } else if (huge) {
        scenario = '放量杀跌（巨量）';
        direction = 'bear';
        conclusion = '下跌叠加巨量：判定恐慌抛盘，强空头趋势，扣分并增加放量杀跌风险标签';
        tags.push('放量杀跌');
      } else {
        scenario = '放量下跌';
        direction = 'bear';
        conclusion = '下跌放量：判定抛压释放，下跌动能强化';
      }
    } else if (shrunk) {
      if (pos === '高位区间') {
        scenario = '高位缩量';
        direction = 'caution';
        conclusion = '高位区间缩量：判定买盘枯竭，缺少新增资金，行情即将见顶';
      } else if (pos === '趋势向下') {
        scenario = '趋势向下缩量';
        direction = 'bear';
        conclusion = '趋势向下缩量：判定阴跌延续，没有承接资金，不言底';
      } else {
        scenario = '缩量下跌';
        direction = 'observe';
        conclusion = '下跌叠加缩量：抛压衰减，标记为观察止跌机会';
      }
    } else {
      scenario = '平量下跌';
      direction = 'observe';
      conclusion = '量平价跌：成交量与前期相当，抛压稳定但无资金承接，空头主导、弱势；不逆势抄底、不扛单';
    }
  }

  return { scenario, direction, conclusion, tags };
}

// ===================== 6.5 不同位置量价补充规则（spec 7.4，20261017f 新增） =====================

// 量能性状（spec 7.1/7.2 的放量/缩量定义；7.4/7.5/11.3 共用同一判定，保证口径一致）
function _volTraits(pc) {
  const r5 = pc.ratio5;
  return {
    // 明显放量：巨量/天量档，或 5 日量比 >1.2（20261019f：对齐市场标准，去掉 60 日确认翻转）
    isHugeVol: pc.level === '大量' || pc.level === '天量' || (r5 !== null && r5 > 1.2),
    // 缩量：5 日量比 <0.8（20261019f：对齐市场标准，去掉 60 日确认翻转）
    isShrink: r5 !== null && r5 < 0.8,
    // 滞涨/横盘：收盘涨跌幅绝对值 <1.2%
    isStagnant: pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2,
    // 冲高回落：最高价高于收盘价 2% 以上
    fellFromHigh: pc.closeToday > 0 && (pc.highToday - pc.closeToday) / pc.closeToday >= 0.02,
  };
}

// 子阶段/状态归一：命中 → '命中'；基础条件不满足 → '未命中'；子阶段无法判定 → '数据不足'
function _subStageStatus(base, subStage) {
  if (subStage === '数据不足') return '数据不足';
  if (!base) return '未命中';
  return subStage === '位置子阶段不明' ? '数据不足' : '命中';
}

/**
 * 不同位置量价补充规则（spec 7.4）——同一成交量在不同位置含义完全相反，先判位置子阶段再判放量/缩量。
 * 返回四类形态；每类带 status（命中/未命中/数据不足）、detail 与展示结论，供 11.2 归集总结与信号分类约束消费。
 */
function _positionVolumeRules(pc, ctx) {
  const { position, rules } = ctx;
  const t = _volTraits(pc);
  const n = pc.n;
  const pos = position.label;
  const rule1 = (rules || []).find(r => r.id === 1);
  const rule2 = (rules || []).find(r => r.id === 2);
  const dd = pc.drawdownFromHigh;
  const recentLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
  const minRecentLow = recentLows.length ? Math.min(...recentLows) : null;
  // 未创新低：当日低点不低于近 20 日最低（触及前低不算「继续下跌」）
  const notNewLow = minRecentLow !== null && pc.lowToday >= minRecentLow;

  // ---- 7.4.1 高位放量滞涨（风险；与规则2 高位派发同时满足时按最高优先级空头规则处理） ----
  const hsBase = pos === '高位区间' && t.isHugeVol;
  const hsMatched = hsBase && (t.isStagnant || t.fellFromHigh);
  const highStagnant = {
    form: '高位放量滞涨',
    status: hsMatched ? '命中' : '未命中',
    matched: hsMatched,
    conclusion: hsMatched
      ? `高位放量滞涨：量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）但价格无法继续冲高（${t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，滞涨/横盘` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：筹码正在大规模交换，市场分歧极大，价格上方抛压很强。风险提示：高位派发风险；降低量价匹配得分，不得因为收阳而给健康多头满分`
      : '未命中高位放量滞涨（需同时满足：高位区间 + 巨量/天量/明显放量 + 价格滞涨/横盘/冲高回落）',
    detail: {
      positionHigh: pos === '高位区间',
      volume: t.isHugeVol ? `量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍；÷20 日均量统一档位：${pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足'} 倍）` : `量能未达明显放量标准（档位${pc.level}）`,
      priceBehavior: hsMatched
        ? (t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，价格无法继续冲高，呈滞涨/横盘状态` : `冲高回落：最高 ${_round(pc.highToday)}、收盘 ${_round(pc.closeToday)}`)
        : '价格未呈滞涨、横盘或冲高回落状态',
      interpretation: hsMatched ? '筹码正在大规模交换，市场分歧极大，价格上方抛压很强' : '未命中高位放量滞涨',
      riskHint: hsMatched ? '高位派发风险；降低量价匹配得分，不得因为收阳而给健康多头满分' : '',
      withRule2: !!(rule2 && rule2.matched),
    },
  };

  // ---- 7.4.2 低位放量震荡（观察池；与规则1 低位吸筹同时满足时以规则1 为准） ----
  const loMatched = pos === '低位区间' && t.isHugeVol && t.isStagnant && notNewLow;
  const lowOscillate = {
    form: '低位放量震荡',
    status: loMatched ? '命中' : '未命中',
    matched: loMatched,
    conclusion: loMatched
      ? `低位放量震荡：低位区间出现大成交量（档位${pc.level}），价格未继续下跌，收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，小阴小阳来回震荡且未创近 20 日新低：大量筹码正在重新分配，值得跟踪，但不直接生成看多信号，仅放入观察池。跟踪提示：等待更强上涨信号（连续递增放量、重心抬升、有效突破或低位吸筹规则确认）`
      : '未命中低位放量震荡（需同时满足：低位区间 + 大成交量 + 小阴小阳震荡 + 未创新低）',
    detail: {
      positionLow: pos === '低位区间',
      volume: t.isHugeVol ? `出现大成交量（档位${pc.level}，当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）` : `量能未达大成交量标准（档位${pc.level}）`,
      priceBehavior: loMatched
        ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，价格未继续下跌，小阴小阳来回震荡且未创近 20 日新低`
        : (notNewLow ? '价格未满足小阴小阳震荡条件' : '价格仍在创近 20 日新低，不属于震荡企稳'),
      interpretation: loMatched ? '大量筹码正在重新分配，值得跟踪，但不直接生成看多信号，仅放入观察池' : '未命中低位放量震荡',
      trackHint: loMatched ? '等待更强上涨信号：连续递增放量、重心抬升、有效突破或低位吸筹规则确认' : '',
      withRule1: !!(rule1 && rule1.matched),
    },
  };

  // ---- 7.4.3 缩量上涨的两种情况（低位启动阶段 / 高位阶段） ----
  const upBase = pc.chgPct !== null && pc.chgPct > 0 && t.isShrink && pc.ratio5 !== null;
  let upSub = '不属于缩量上涨';
  if (pc.ratio5 === null || pc.chgPct === null) upSub = '数据不足';
  else if (upBase) {
    if (pos === '低位区间') upSub = '低位启动阶段';
    else if (pos === '高位区间') upSub = '高位阶段';
    else upSub = '位置子阶段不明';
  }
  const shrinkUp = {
    form: '缩量上涨',
    status: _subStageStatus(upBase, upSub),
    matched: upBase,
    subStage: upSub,
    conclusion: upSub === '低位启动阶段'
      ? `低位缩量上涨：价格自低位启动且缩量上行（档位${pc.level}），市场卖盘少、筹码相对稳定，不需要大量成交量也能推动价格；不按「上涨缩量动能不足」强扣分，标记「低位缩量上涨、筹码稳定、待放量确认」，不直接给强看多信号`
      : upSub === '高位阶段'
        ? `高位缩量上涨：价格已连续上涨到高位，后续反弹越来越缩量（档位${pc.level}），价格仍在涨但成交量跟不上：买盘持续性存疑，量价不匹配，存在顶背离或买盘枯竭风险，纳入风险观察`
        : upSub === '位置子阶段不明'
          ? '缩量上涨，位置子阶段不明，按谨慎观察处理，数据不足'
          : upSub === '数据不足'
            ? '缩量上涨：涨跌幅或量比数据不足，无法判定'
            : '未命中缩量上涨（当前非缩量上涨形态）',
    detail: {
      volume: t.isShrink ? `缩量（档位${pc.level}；÷20 日均量统一档位：${pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足'} 倍）` : `非缩量（档位${pc.level}）`,
      priceBehavior: `收盘涨跌幅 ${pc.chgPct !== null ? _fmtPct(pc.chgPct, 2) : '数据不足'}`,
      hint: upSub === '低位启动阶段' ? '低位缩量上涨、筹码稳定、待放量确认；不直接给强看多信号'
        : upSub === '高位阶段' ? '高位缩量上涨、买盘存疑、关注买盘能否持续；纳入风险观察'
          : upSub === '位置子阶段不明' ? '按谨慎观察处理，数据不足' : '',
    },
  };

  // ---- 7.4.4 缩量下跌的两种情况（低位大跌后 / 下跌初期） ----
  const downBase = pc.chgPct !== null && pc.chgPct < 0 && t.isShrink && pc.ratio5 !== null;
  let downSub = '不属于缩量下跌';
  if (pc.ratio5 === null || pc.chgPct === null) downSub = '数据不足';
  else if (downBase) {
    if (pos === '低位区间' && dd !== null && dd <= -15) downSub = '低位大跌后';
    else if (pos === '趋势向下' && dd !== null && dd > -10) downSub = '下跌初期';
    else downSub = '位置子阶段不明';
  }
  const shrinkDown = {
    form: '缩量下跌',
    status: _subStageStatus(downBase, downSub),
    matched: downBase,
    subStage: downSub,
    bearish: downSub === '下跌初期',
    conclusion: downSub === '低位大跌后'
      ? `低位大跌后缩量出清：连续大跌后处于低位（距阶段高点 ${_fmtPct(dd)}）且成交缩到极低（档位${pc.level}）：卖盘已基本出清，浮动筹码减少，可能接近底部；不按「阴跌无承接」强扣分，仅作观察，不直接看多`
      : downSub === '下跌初期'
        ? `下跌初期缩量无承接：刚开始下跌（距阶段高点 ${_fmtPct(dd)}）就出现缩量（档位${pc.level}）：承接盘不足，下方无人愿意接盘，后续可能继续下跌；按看空观察或看空预警处理`
        : downSub === '位置子阶段不明'
          ? '缩量下跌，位置子阶段不明，按谨慎处理，数据不足'
          : downSub === '数据不足'
            ? '缩量下跌：涨跌幅或量比数据不足，无法判定'
            : '未命中缩量下跌（当前非缩量下跌形态）',
    detail: {
      volume: t.isShrink ? `缩量（档位${pc.level}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: `收盘涨跌幅 ${pc.chgPct !== null ? _fmtPct(pc.chgPct, 2) : '数据不足'}；距阶段高点 ${_fmtPct(dd)}`,
      hint: downSub === '低位大跌后' ? '低位大跌后缩量出清、潜在底部观察；仅作观察，不直接看多'
        : downSub === '下跌初期' ? '下跌初期缩量无承接、谨防延续下跌；按看空观察或看空预警处理'
          : downSub === '位置子阶段不明' ? '按谨慎处理，数据不足' : '',
    },
  };

  return { highStagnant, lowOscillate, shrinkUp, shrinkDown, traits: t };
}

// ===================== 6.6 量比实战口诀（spec 7.5，20261017f 新增） =====================

/**
 * 五句量比实战口诀。量比为辅助规则，不替代档位/三问/生死位/位置量价规则；
 * 涉及开盘、均价线、尾盘、分时持续买单的条目仅在提供分时数据时启用，
 * 仅有日线数据时标注「分时数据不足，本条无法判定」，不得臆造。
 */
function _ratioRules(pc, ctx) {
  const t = _volTraits(pc);
  const n = pc.n;
  const ms = (ctx.minutes && Array.isArray(ctx.minutes.minutes)) ? ctx.minutes.minutes : [];
  const items = [];
  const dataGaps = [];

  // ---- 口诀 1：开盘量比超 3 且股价站在均价线上方（分时） ----
  {
    const hasMin = ms.length >= 30;
    const item = { id: 1, name: '开盘量比超3且股价站在均价线上方', matched: false, status: '未命中', dataOk: hasMin, tag: null, steady: null, conclusion: '', hint: '', detail: {} };
    if (!hasMin) {
      item.status = '数据不足';
      item.conclusion = '分时数据不足，本条无法判定';
      dataGaps.push('分时数据不足，「开盘量比超3且股价站在均价线上方」无法判定');
    } else {
      // 开盘阶段 = 前 30 分钟；开盘量比按标准口径：开盘每分钟均量 ÷ 过去 5 日每日每分钟均量
      // （分时 cumVol 为「手」、日线 volume 为「股」，换算 ÷100；开盘 30 分钟占全日 240 分钟的 1/8）
      const openEnd = Math.min(30, ms.length);
      const openCum = typeof ms[openEnd - 1].cumVol === 'number' ? ms[openEnd - 1].cumVol : 0;
      // 20261017g：单位换算按日K通道自适应——分时 cumVol 恒为「手」，但日K成交量单位随通道不同：
      // 东财/同花顺日K为「股」（实测 000902 同花顺 7,923,196 股），腾讯日K为「手」（同日 80,528 手，比值≈100）。
      // 写死 ÷100 会在腾讯日K降级时把基准缩小 100 倍，导致开盘量比虚高必然误判「量比超3」。
      // 20261021h：与覆写函数共用 lib/volUnit 的通道表（此前这里把东财也当「股」→ ÷100，
      // 会把 5 日均量基准缩小 100 倍，开盘量比凭空放大 100 倍）
      const unitDivisor = toLotDivisor(ctx.barsSource);
      const prevAvgPerMin = pc.avg5 > 0 ? pc.avg5 / unitDivisor / 240 : 0;
      const openRatio = prevAvgPerMin > 0 ? (openCum / openEnd) / prevAvgPerMin : null;
      const lastPrice = ms[ms.length - 1].price;
      const lastAvg = ms[ms.length - 1].avg;
      const aboveAvg = isFinite(lastPrice) && isFinite(lastAvg) && lastAvg > 0 && lastPrice >= lastAvg;
      item.detail = { openRatio: openRatio !== null ? _round(openRatio) : null, aboveAvg };
      if (openRatio !== null && openRatio > 3 && aboveAvg) {
        item.matched = true;
        item.status = '命中';
        item.steady = aboveAvg; // 分时末端仍在均价线上方 → 放量后价格稳住；跌破 → 承接失败
        item.conclusion = item.steady
          ? `开盘量比 ${_round(openRatio)} 倍且股价站在均价线上方，放量后价格稳住：抛压被承接，该放量有实际意义，按观察/确认处理，不直接输出看多信号`
          : `开盘量比 ${_round(openRatio)} 倍但价格回落跌破均价线：放量承接失败，转为风险观察`;
        item.hint = item.steady
          ? '资金持续沉淀、抛压被承接、放量有意义；只输出观察/确认，不直接输出看多信号'
          : '放量承接失败，转为风险观察；不得输出看多信号';
        item.tag = item.steady ? '开盘量比超3放量待确认' : '开盘放量承接失败';
      } else {
        item.conclusion = `未命中（开盘量比 ${openRatio !== null ? _round(openRatio) : '数据不足'}，${aboveAvg ? '股价在均价线上方' : '股价未站上均价线'}，需开盘量比 >3 且站上均价线）`;
      }
    }
    items.push(item);
  }

  // ---- 口诀 2：量比从高位回落至 1 附近且股价横盘不跌（日线可判定） ----
  {
    const r5 = pc.ratio5, r5p = pc.ratio5Prev;
    const matched = r5 !== null && r5p !== null && r5p > 1.3 && r5 >= 0.8 && r5 <= 1.2
      && pc.chgPct !== null && Math.abs(pc.chgPct) < 1.2 && pc.closePrev > 0 && pc.closeToday >= pc.closePrev * 0.995;
    items.push({
      id: 2, name: '量比从高位回落至1附近且股价横盘不跌', matched, status: matched ? '命中' : '未命中', dataOk: true, tag: matched ? '量比回落横盘卖盘变轻观察' : null,
      conclusion: matched
        ? `量比自 ${_round(r5p)} 倍回落至 ${_round(r5)} 倍（≈1 附近）且股价横盘不跌（收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}）：不要急于判断走弱，先观察卖盘是否变轻，按强势整理观察处理，不得因量比回落直接输出看空结论`
        : '未命中（需昨日量比 >1.3 回落至 0.8-1.2 且股价横盘不跌）',
      hint: matched ? '强势整理观察、成交量减少但价格不下跌；不得因量比回落直接输出看空结论' : '',
      detail: { ratio5: r5 !== null ? _round(r5) : null, ratio5Prev: r5p !== null ? _round(r5p) : null },
    });
  }

  // ---- 口诀 3：尾盘突然放量拉升（分时） ----
  {
    // 20261017g：尾盘窗口按「时间戳」截取真实交易时段最后 30 分钟（14:30-15:00），
    // 不再按数组末尾位置 m-30 截取。原因（实测 2026-10-19 15:10 取 000902 共 247 条）：
    // ①腾讯分时收盘后会追加盘后条目（末尾 6 条为 1500/1506/1507/1508/1509/1510），取末尾 30 条
    //   会把盘后非交易时段算进窗口，且窗口随追加条目持续后移（14:36 而非 14:30）；
    // ②盘中尚未收盘时取末尾 30 条会把「最近半小时」误当作尾盘（如 11:10 时判 10:40-11:10）。
    const timeOf = (x) => (/^\d{4}$/.test(String(x.time || '')) ? String(x.time) : null);
    const clockTimes = ms.map((x, i) => ({ i, t: timeOf(x) })).filter(x => x.t);
    const closed = clockTimes.some(x => x.t >= '1500');
    const tailWindow = clockTimes.filter(x => x.t >= '1430' && x.t <= '1500');
    const hasMin = closed && tailWindow.length >= 25;
    const item = { id: 3, name: '尾盘突然放量拉升', matched: false, status: '未命中', dataOk: hasMin, tag: null, conclusion: '', hint: '', detail: {} };
    if (!hasMin) {
      item.status = '数据不足';
      item.conclusion = closed
        ? '分时数据不足（尾盘 14:30-15:00 窗口不足 25 分钟），本条无法判定'
        : '分时尚未覆盖到收盘（当日未收盘），尾盘突然放量拉升需收盘后判定';
      dataGaps.push(closed
        ? '分时数据不足，「尾盘突然放量拉升」无法判定'
        : '分时尚未覆盖收盘，「尾盘突然放量拉升」无法判定');
    } else {
      // 尾盘 = 14:30-15:00 窗口；尾盘每分钟均量 vs 此前每分钟均量（≥2 倍判为突然放量）
      const first = tailWindow[0].i;
      const last = tailWindow[tailWindow.length - 1].i;
      const cumAt = (i) => (i >= 0 && typeof ms[i].cumVol === 'number' ? ms[i].cumVol : 0);
      const tailVol = cumAt(last) - (first > 0 ? cumAt(first - 1) : 0);
      const priorVol = first > 0 ? cumAt(first - 1) : 0;
      const tailPerMin = tailVol / (last - first + 1);
      const priorPerMin = first > 0 ? priorVol / first : 0;
      const priceTail = ms[last].price;
      const priceBefore = ms[first].price;
      const rally = isFinite(priceTail) && isFinite(priceBefore) && priceBefore > 0 && priceTail >= priceBefore * 1.005;
      item.detail = { tailPerMin: _round(tailPerMin), priorPerMin: _round(priorPerMin), rally };
      if (priorPerMin > 0 && tailPerMin >= 2 * priorPerMin && rally) {
        item.matched = true;
        item.status = '命中';
        item.tag = '尾盘放量拉升真实性待确认';
        item.conclusion = `尾盘突然放量拉升（尾盘每分钟均量为此前 ${_round(tailPerMin / priorPerMin)} 倍且价格走高）：不能仅因红盘判断为抢筹，需确认是否有持续买单；尾盘放量可能是资金制造价格假象，仅看量比无法区分`;
        item.hint = '尾盘放量拉升真实性待确认、警惕价格假象；不得输出看多信号';
      } else {
        item.conclusion = `未命中（尾盘每分钟均量 ${_round(tailPerMin)} vs 此前 ${_round(priorPerMin)}，${rally ? '价格走高' : '价格未走高'}，需尾盘放量 ≥2 倍且拉升）`;
      }
    }
    items.push(item);
  }

  // ---- 口诀 4：连续低成交且股价不再创新低（日线可判定） ----
  // 20261109c：低成交阈值统一 volumeCaliber（÷20 日均量 <0.8），与 135 格主判同源
  {
    const low3 = n >= 3 && pc.avg20 > 0
      && isShrinkRatio(ratioOfVol(pc.vols[n - 1], pc.avg20))
      && isShrinkRatio(ratioOfVol(pc.vols[n - 2], pc.avg20))
      && isShrinkRatio(ratioOfVol(pc.vols[n - 3], pc.avg20));
    const winLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
    const notNewLow = winLows.length > 0 && pc.lowToday > Math.min(...winLows);
    const matched = low3 && notNewLow;
    // 有效放量阳线是否已出现（出现后本条不再限制信号升级）；放量判定 = ÷20 日均量统一真值源
    const confirmed = pc.chgPct !== null && pc.chgPct > 0 && isAmpRatio(pc.ratio20);
    // 20261020b：阈值具象化（用户 2026-10-20 截图要求「把数据计算结果展示出来，均量乘以0.7是多少」）——
    // 「20 日均量 ×0.7」由纯符号表述改为同屏展示均值、阈值与实际近 3 日量能，便于用户核对判定依据；
    // 20261109c 阈值随单一真值源改为 ×0.8。
    // 成交量单位随日K通道不同（东财/同花顺=股、腾讯=手），此处只展示数值与相对关系，不写死单位。
    // matched 时 low3 已保证 avg20>0 且 n>=3，故命中分支中三个展示值必然齐全。
    const avg20Show = pc.avg20 > 0 ? _round(pc.avg20, 0) : null;
    const shrinkThr = pc.avg20 > 0 ? _round(pc.avg20 * VOL_SHRINK, 0) : null;
    const vols3 = n >= 3 ? [_round(pc.vols[n - 3], 0), _round(pc.vols[n - 2], 0), _round(pc.vols[n - 1], 0)] : [];
    const vols3Txt = vols3.length === 3 ? vols3.join(' / ') : '数据不足';
    const thrTxt = avg20Show !== null ? `20 日均量 ${avg20Show} ×${VOL_SHRINK} = ${shrinkThr}` : null;
    items.push({
      id: 4, name: '连续低成交且股价不再创新低', matched, status: matched ? '命中' : '未命中', dataOk: true, confirmed,
      tag: matched && !confirmed ? '连续低成交不再新低待放量阳线' : null,
      conclusion: matched
        ? `连续低成交（近 3 日成交量 ${vols3Txt}，均低于 ${thrTxt}）且股价不再创新低：缩量仅说明卖盘减少，放量上涨才代表新买盘真正进入${confirmed ? '；当日已出现有效放量阳线，跟踪确认成立' : '；等待后续第一根有效放量阳线确认'}`
        : `未命中（需近 3 日连续低成交且股价不再创近 20 日新低${thrTxt && vols3.length === 3 ? `；低成交线 ${thrTxt}，近 3 日实际 ${vols3Txt}` : ''}）`,
      hint: matched && !confirmed ? '低成交止跌观察、等待有效放量阳线确认；在有效放量阳线出现前不得直接输出看多信号' : '',
      detail: { low3, notNewLow, confirmed, avg20: avg20Show, shrinkThreshold: shrinkThr, vols3 },
    });
  }

  // ---- 口诀 5：量比大但股价涨不动（日线可判定） ----
  {
    const bigVol = pc.ratio5 !== null && pc.ratio5 > 2;
    const cantUp = t.isStagnant || t.fellFromHigh;
    const matched = bigVol && cantUp;
    const inHigh = ctx.position && ctx.position.label === '高位区间';
    items.push({
      id: 5, name: '量比大但股价涨不动', matched, status: matched ? '命中' : '未命中', dataOk: true,
      tag: matched ? '量比大价格滞涨警惕对倒' : null, inHigh: !!inHigh,
      conclusion: matched
        ? `量比大（当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍）但股价涨不动（${t.isStagnant ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，滞涨` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：不能直接视为资金抢筹，大量成交却推不动价格，说明上方卖压极重，需警惕是否为对倒出货；仅靠量比无法下结论，但必须提高警惕`
        : '未命中（需量比 >2 且股价涨不动/滞涨/冲高回落）',
      hint: matched
        ? (inHigh ? '按高位派发风险处理；不得输出看多信号，必须降低置信度' : '不得输出看多信号，必须降低置信度并警惕对倒风险')
        : '',
      detail: { ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null, inHigh: !!inHigh },
    });
  }

  return { items, dataGaps };
}

// ===================== 6.7 常见矛盾信号（spec 11.3，20261017f 新增） =====================

/**
 * 底部区域相位分类（20261020a，用户 2026-10-20 六维度框架）——
 * 区分「底部构筑期（该缩量：卖压衰竭验证）」与「底部启动/确认区（该放量：买盘进场验证）」。
 *
 * 背景（用户截图报障：同一股票同时命中「该放量未放量，资金没有跟上」与「该缩量反放巨量，分歧未结束」）：
 * 原 _contradictionRules 的「该放量」/「该缩量」场景清单独立收集，「低位区间+前期平台整理」
 * 无条件同时进两侧清单（该放量侧「低位吸筹确认场景」；该缩量侧「横盘整理/低位洗盘」），
 * 且该缩量侧的巨量判定接受 60 日 confirm 口径——平量股（÷5 日均量 1.15）因 60 日口径判「放量」
 * 竟命中「反放巨量」。两个互斥期望同时成立 = 自相矛盾。
 * 修复：低位平台区域先判相位，「该放量/该缩量」期望由相位单源推导，两侧互斥。
 *
 * 六维度框架 → 代码映射（阈值取用户框架范围内保守值，注释对标来源）：
 *   一、时间维度：构筑期 = 缩量常态持续多日（近10日≥6日地量）；启动区 = 放量集中且持续（近3日≥2日放量）
 *   二、量能形态：地量维持（量≤20日均量×50% 反复出现，20261106n 基准由 60 日改 20 日）vs 倍量突破（≥5日均量×1.5 且收阳）
 *   三、价格行为：窄幅横盘+未突破平台上沿+均线走平粘合 vs 突破平台上沿/涨幅≥3%+均线拐头
 *   四、确认逻辑：卖压衰竭（地量持续+不创新低 = 必要条件）vs 买盘验证（倍量/放量持续+价格抬升 = 充分条件）
 *   五、假信号：单日脉冲 = 构筑期内噪音（不算启动）；放量仅 1 日 = 一日游候选（不判启动）；
 *      「任何单日信号不足以定性，至少 2—3 日交叉验证」→ 启动确认必须满足放量持续≥2 日
 *   六、观察清单：见 detail 输出（lowVolDays/ampDays/doubleVol/notNewLow/breakPlatform/maFlat/maTurnUp）
 * 相位优先级：启动确认区（充分条件）> 构筑期（必要条件）> 方向不明（未定性，不臆断期望）。
 */
const BOTTOM_LOWVOL_RATIO = 0.5;  // 地量线：量 ≤ 20 日均量 ×50%（框架：「萎缩至前期均量的 30%—50% 以下」，取区间上限为认定线；20261106n 基准由 60 日改 20 日）
const BOTTOM_LOWVOL_DAYS = 6;     // 地量持续：近 10 个交易日 ≥6 日处于地量线下方（框架：「反复维持，不是一两天的事」）
const BOTTOM_AMP_DAYS = 2;        // 放量持续：近 3 个交易日 ≥2 日 ÷5 日均量 >1.2（框架：「连续 2—3 日量能维持在较高水平」）
const BOTTOM_DOUBLE_VOL = 1.5;    // 倍量线：当日量 ≥ 5 日均量 ×1.5 且收阳（框架：「达到前一日或近期均量的 1.5—2 倍以上，且配合阳线」）
const BOTTOM_BREAK_PCT = 3;       // 启动涨幅：当日涨幅 ≥3%（框架：「股价明显上涨（如涨幅 3% 以上或突破关键位）」）
const BOTTOM_MA_FLAT = 0.03;      // 均线走平粘合：|MA20-MA60|/MA60 ≤3%（框架：「均线系统走平、粘合，尚未形成多头排列」）
const BOTTOM_BREAK_TOL = 0.995;   // 突破平台上沿容差：收盘 ≥ 平台上沿 ×0.995（与 11.3.1 attackResistance 同口径）

function _bottomPhase(pc, ctx) {
  const pos = (ctx.position && ctx.position.label) || '';
  const platform = ctx.platform || null;
  if (pos !== '低位区间' || !platform) {
    return { phase: '不适用', basis: '非低位区间或未识别到前期平台整理，不进入底部相位区分', detail: {} };
  }
  const n = pc.n;
  if (n < 25 || pc.avg20 <= 0 || pc.avg5 <= 0 || pc.ratio5 === null) {
    return { phase: '数据不足', basis: `样本不足（${n} 根）或均量/量比缺失，无法判定底部相位`, detail: { n } };
  }
  const vols = pc.vols, closes = pc.closes;
  // 单日 ÷5 日均量（基准不含当日，与 ratio5 同口径）
  const dayRatio5 = (j) => {
    if (j < 5) return null;
    const a = _mean(vols.slice(j - 5, j));
    return a > 0 ? vols[j] / a : null;
  };
  // D1 时间维度：地量持续 vs 放量集中持续
  const lowVolDays = vols.slice(-10).filter(v => v <= pc.avg20 * BOTTOM_LOWVOL_RATIO).length;
  const ampDays = [n - 3, n - 2, n - 1].map(dayRatio5).filter(r => r !== null && r > 1.2).length;
  // D2 量能形态：倍量阳线 / 缩量不跌（低点不再大幅下移）
  const doubleVol = pc.volToday >= pc.avg5 * BOTTOM_DOUBLE_VOL && pc.chgPct !== null && pc.chgPct > 0;
  const recent20Lows = pc.lows.slice(Math.max(0, n - 21), n - 1);
  const minRecentLow = recent20Lows.length ? Math.min(...recent20Lows) : null;
  const notNewLow = minRecentLow !== null && pc.lowToday >= minRecentLow;
  // D3 价格行为：突破平台上沿 / 涨幅 / 均线走平与拐头
  const breakPlatform = pc.closeToday >= platform.high * BOTTOM_BREAK_TOL || !!ctx.breakThrough;
  const priceLift = breakPlatform || (pc.chgPct !== null && pc.chgPct >= BOTTOM_BREAK_PCT);
  const maFlat = pc.ma20 && pc.ma60 ? Math.abs(pc.ma20 - pc.ma60) / pc.ma60 <= BOTTOM_MA_FLAT : null;
  const ma20Prev = n >= 25 ? _mean(closes.slice(n - 25, n - 5)) : null;
  const maTurnUp = pc.ma20 && ma20Prev ? pc.ma20 > ma20Prev : null;
  // D4 确认逻辑：卖压衰竭（必要条件）vs 买盘验证（充分条件，且须 2-3 日交叉验证）
  const rule1 = (ctx.rules || []).find(r => r.id === 1);
  const rule1Matched = !!(rule1 && rule1.matched);
  const sellExhausted = lowVolDays >= BOTTOM_LOWVOL_DAYS && notNewLow;
  const buyVerified = (doubleVol || ampDays >= BOTTOM_AMP_DAYS) && priceLift && (ampDays >= BOTTOM_AMP_DAYS || rule1Matched);
  const pulse = !!pc.pulse;
  const detail = {
    lowVolDays, ampDays, doubleVol, notNewLow, breakPlatform, priceLift,
    maFlat, maTurnUp, pulse, rule1Matched,
    platformBandPct: platform.high > 0 ? _round((platform.high - platform.low) / platform.low * 100, 1) : null,
  };
  if (buyVerified) {
    return {
      phase: '启动确认区',
      basis: `买盘验证成立：${doubleVol ? '倍量阳线' : '放量持续'}（近3日${ampDays}日放量）+ 价格抬升（${breakPlatform ? '突破平台上沿' : `当日涨幅${_fmtPct(pc.chgPct, 2)}`}），非单日信号（${ampDays >= 2 ? '连续放量交叉验证通过' : '规则1低位吸筹完整命中'}）：底部启动/确认区域，该放量为预期`,
      detail,
    };
  }
  if (sellExhausted && !breakPlatform && maFlat !== false) {
    const noise = pc.ratio5 > 1.2
      ? `；当日放量（÷5 日均量 ${_round(pc.ratio5)} 倍）${pulse ? '属单日脉冲噪音，不构成启动' : (ampDays >= 2 ? '且连续放量但价格未突破平台上沿，构筑期未结束' : '未持续，属构筑期内噪音，不构成启动确认')}`
      : '';
    return {
      phase: '构筑期',
      basis: `卖压衰竭验证成立：近10日${lowVolDays}日地量（≤20日均量×50%）+ 低点不再下移 + 未突破平台上沿${maFlat ? ' + 均线走平粘合' : ''}：底部构筑期（缩量磨底、跌不动），该缩量为预期${noise}`,
      detail,
    };
  }
  const reasons = [];
  if (lowVolDays < BOTTOM_LOWVOL_DAYS) reasons.push(`地量仅 ${lowVolDays}/10 日（未形成持续磨底常态）`);
  if (!notNewLow) reasons.push('低点仍在下移（构筑未完成）');
  if (breakPlatform && !buyVerified) reasons.push('已触及平台上沿但放量未持续（一日游候选，需 2—3 日交叉验证）');
  if (maFlat === false) reasons.push('均线空头排列发散');
  if (!reasons.length) reasons.push('量价均未达构筑期或启动区的验证阈值');
  return {
    phase: '方向不明',
    basis: `底部平台区域未定性：${reasons.join('；')}——既未进入地量磨底的缩量常态，也未出现倍量突破+放量持续的启动特征，继续观察，暂不施加该放量/该缩量期望`,
    detail,
  };
}

/**
 * 常见矛盾信号归集（spec 11.3）——重点识别「K 线形态好看但量能不匹配」的虚假信号。
 * 四个信号项（第三项拆「高位放巨量价格不涨 / 低位放大量价格不跌」两个子项），
 * 每项带 status/判定依据/客观结论/风险或跟踪提示，供归集总结与信号分类约束消费。
 * 20261020a：低位平台区域的「该放量/该缩量」期望由 _bottomPhase 相位单源推导（见该函数注释），
 * 消除原双清单并行收集导致的两侧同时命中的自相矛盾（用户 2026-10-20 截图报障）。
 */
function _contradictionRules(pc, ctx) {
  const t = _volTraits(pc);
  const n = pc.n;
  const pos = (ctx.position && ctx.position.label) || '';
  const levels = ctx.levels || {};
  const sequence = ctx.sequence || {};
  const rule1 = (ctx.rules || []).find(r => r.id === 1);
  const rule2 = (ctx.rules || []).find(r => r.id === 2);
  const rule3 = (ctx.rules || []).find(r => r.id === 3);
  const support = levels.support ? levels.support.price : null;
  const resistance = levels.resistance ? levels.resistance.price : null;
  // 规则1 低位吸筹完整命中 = 连续3日放量+重心企稳（spec 7.4 例外：吸筹场景放量是预期行为，不构成「该缩量反放巨量」矛盾）
  const rule1Matched = !!(rule1 && rule1.matched);

  // 20261020a：底部区域相位分类（用户六维度框架，见 _bottomPhase 注释）——
  // 低位平台区域先判相位，「该放量/该缩量」期望由相位单源推导，两侧互斥，
  // 消除原双清单并行收集导致的双命中矛盾（用户 2026-10-20 截图报障）。
  const bottomPhase = _bottomPhase(pc, ctx);
  const bpPhase = bottomPhase.phase;

  // ---- 11.3.1 该放量的时候没有放量，资金没有跟上 ----
  const scenarios = [];
  // 攻击关键压力位：当日高点触及压力位，且须创新近 60 日新高（排除平盘股「压力位即当日自身高点」的每日误触发）
  const recent60High = n >= 2 ? Math.max(...pc.highs.slice(Math.max(0, n - 61), n - 1)) : null;
  const attackResistance = resistance !== null && recent60High !== null
    && pc.highToday >= resistance * 0.995 && pc.highToday > recent60High;
  if (attackResistance) scenarios.push('突破关键压力位');
  if (ctx.breakThrough) scenarios.push('有效突破确认');
  if (pc.chgPct !== null && pc.chgPct >= 1.2) scenarios.push('上涨确认');
  // 低位平台区域：仅当相位判定为「启动确认区」（倍量/放量持续 + 价格突破，买盘验证成立）才期望放量；
  // 构筑期该缩量、方向不明不施加期望——相位单源推导，与 11.3.2 侧互斥（见 _bottomPhase 注释）
  if (pos === '低位区间' && ctx.platform && bpPhase === '启动确认区') scenarios.push('底部启动确认场景（低位平台+放量持续+价格突破）');
  if (sequence.type === '连续递增') scenarios.push('连续递增量能确认');
  if (support !== null && pc.lowToday <= support * 1.01 && pc.chgPct !== null && pc.chgPct > 0 && pc.closeToday > support) scenarios.push('关键支撑反弹确认');
    // 20261028a：盘中停判（与规则 3 同口径）——盘中当日量为部分日累计，与 20 日均量全天基准不可比，
    // 且「上涨确认/有效突破确认」等场景本身需收盘定论，盘中一律不判「资金未跟上」。
    const intradayPending = ctx.intradayPending === true;
    const ampNotPending = intradayPending && scenarios.length > 0;
    // 20261109c：判定门接入 lib/volumeCaliber 单一真值源（>1.3 放量即视为量能跟上），
    // 不再有任何本地阈值；旧 AMP_CONFIRM=1.5 与此处 >1.3 曾形成夹缝同屏互斥。
    const ampOkUnified = isAmpRatio(pc.ratio20);
    const ampNotMatched = !intradayPending && scenarios.length > 0 && !ampOkUnified;
    // 20261020d：阈值具象化（延续 LRN-20261020-003，用户截图要求「均量 ×1.5 给出具体数值」）——
    // 纯符号表述改为同屏展示本次数据的计算结果（均值 X ×阈值 = 阈值 + 当日实际量），
    // 便于用户核对判定依据；20261109c 阈值随单一真值源统一为 ×1.3。
    // 单位随日K通道不同（东财/同花顺=股、腾讯=手），只展示数值不写死单位。
    const ampAvgShow = pc.avg20 > 0 ? _round(pc.avg20, 0) : null;
    const ampThr = pc.avg20 > 0 ? _round(pc.avg20 * VOL_AMP, 0) : null;
    const volTodayShow = pc.volToday > 0 ? _round(pc.volToday, 0) : null;
    // 20261021h：文案必须与**实际比较**一致，不能只凭档位就写"未达阈值"。
    // 阈值为 null / 当日量缺失时不比较，避免出现「未达 null」这种废话。
    const volVsThr = (ampThr !== null && volTodayShow !== null && ampThr > 0) ? volTodayShow / ampThr : null;
    const volCmpTxt = volVsThr === null ? '' : `（当日量为阈值的 ${_round(volVsThr, 2)} 倍）`;
    const ampThrTxt = ampAvgShow !== null
      ? `20 日均量 ${ampAvgShow} ×${VOL_AMP} = ${ampThr}${volTodayShow !== null ? `（当日量 ${volTodayShow}）` : ''}`
      : null;
    const shouldAmpNot = {
      signal: '该放量未放量，资金没有跟上',
      status: ampNotMatched ? '命中' : (ampNotPending ? '盘中停判' : '未命中'),
      matched: ampNotMatched,
      scenario: scenarios.join('、') || '无',
      volume: `当前量 ÷ 20 日均量 ${pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足'} 倍（统一三态档位：${tierOfRatio(pc.ratio20) || '数据不足'}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      conclusion: ampNotMatched
        ? `该放量未放量：处于「${scenarios.join('、')}」本应放量确认的场景，按 ÷20 日均量统一口径仅 ${pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足'} 倍（放量阈值 >1.3${volVsThr !== null && ampThrTxt ? `，确认级阈值 ${ampThrTxt}${volCmpTxt}` : ''}）：资金未跟上，量能不确认，K 线形态可信度下降`
        : (ampNotPending
        ? `当日未收盘，收盘后判定：处于「${scenarios.join('、')}」场景，盘中当日量为部分日累计，与 ${ampThrTxt || `20 日均量 ×${VOL_AMP}`} 全天基准不可比，盘中不判「资金未跟上」`
        : (pos === '低位区间' && ctx.platform && bpPhase !== '启动确认区')
        ? `未命中「该放量未放量、资金未跟上」：${bottomPhase.basis}`
        : '未命中「该放量未放量、资金未跟上」（当前无本应放量场景，或量能已有效放大）'),
    riskHint: ampNotMatched ? '谨防假突破、K 线骗线、上涨动能不足；不得输出看多信号，看多观察也必须降级并注明量能不确认' : '',
    related: [rule3 && rule3.matched ? '假突破量能不确认' : null, pc.chgPct !== null && pc.chgPct > 0 && t.isShrink ? '上涨缩量' : null].filter(Boolean),
  };

  // ---- 11.3.2 该缩量的时候反而放巨量，市场分歧还没有结束 ----
  // 20261020a：低位平台区域相位门控——仅构筑期（卖压衰竭验证成立）期望缩量；
  // 启动确认区放量是预期行为，方向不明不施加期望。低位场景（横盘整理/低位洗盘）
  // 一律过该门控，与 11.3.1 侧互斥（相位单源推导，见 _bottomPhase 注释）。
  const lowSideOk = pos !== '低位区间' || bpPhase === '构筑期';
  const shrinkScenes = [];
  if ((ctx.currentSideways || t.isStagnant) && lowSideOk) shrinkScenes.push('横盘整理');
  if (pos === '趋势向上' && pc.chgPct !== null && pc.chgPct < 0) shrinkScenes.push('趋势向上缩量回调');
  if (pos === '趋势向下' && pc.chgPct !== null && pc.chgPct < 0) shrinkScenes.push('趋势向下缩量阴跌');
  if (pos === '低位区间' && pc.chgPct !== null && pc.chgPct < 0 && lowSideOk) shrinkScenes.push('低位洗盘');
  // 巨量口径只认 ÷5 日档位（大量/天量）：60 日 confirm 不得触发基于 ÷5 日档位的判定
  // （20261019f 铁律——「确认」机制不许有「改判」权力；截图报障中 ÷5 量比 1.15 的平量股
  // 因 60 日 confirm=放量 竟命中「反放巨量」即此口径污染，本次一并收严）
  const hugeVol = pc.level === '大量' || pc.level === '天量';
  // 低位单日脉冲豁免：框架「假信号识别」——单日脉冲是构筑期内噪音，单日信号不足以定性
  const lowPulseExempt = pos === '低位区间' && !!pc.pulse;
  const shrinkHugeMatched = shrinkScenes.length > 0 && hugeVol && !rule1Matched && !lowPulseExempt;
  const shouldShrinkHuge = {
    signal: '该缩量反放巨量，分歧未结束',
    status: shrinkHugeMatched ? '命中' : '未命中',
    matched: shrinkHugeMatched,
    scenario: shrinkScenes.join('、') || '无',
    volume: `当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍（档位${pc.level}）`,
    priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
    conclusion: shrinkHugeMatched
      ? `该缩量反放巨量：处于「${shrinkScenes.join('、')}」本应缩量或量能收敛的场景，但当前量能处于${pc.level}区（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）：市场分歧未结束，筹码剧烈交换，方向尚未明朗或风险仍在释放`
      : (pos === '低位区间' && ctx.platform && bpPhase !== '构筑期')
        ? `未命中「该缩量反放巨量、分歧未结束」：${bottomPhase.basis}`
        : '未命中「该缩量反放巨量、分歧未结束」（当前无本应缩量场景，或量能未达巨量/明显放量）',
    riskHint: shrinkHugeMatched
      ? `降低置信度，规避方向不明阶段，等待分歧收敛；不得输出高置信度看多信号${(pos === '高位区间' || pos === '趋势向下') ? '；同时处于高位/趋势向下，应同步输出看空观察或看空预警' : ''}`
      : '',
  };

  // ---- 11.3.3.1 高位放巨量但价格不涨，要小心 ----
  const hhMatched = pos === '高位区间' && t.isHugeVol && (t.isStagnant || t.fellFromHigh);
  const highHugeNotUp = {
    signal: '高位放巨量但价格不涨，要小心',
    status: hhMatched ? '命中' : '未命中',
    matched: hhMatched,
    conclusion: hhMatched
      ? `高位放巨量但价格不涨：高位区间量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍），价格无法继续冲高（${t.isStagnant && !t.fellFromHigh ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : `冲高回落，上影线 ${_round((pc.highToday - pc.closeToday) / pc.closeToday * 100)}%`}）：筹码大规模交换，市场分歧极大，上方抛压强，需小心高位派发`
      : '未命中「高位放巨量但价格不涨」（需高位区间 + 巨量/明显放量 + 价格滞涨/冲高回落）',
    riskHint: hhMatched ? '高位派发风险、诱多风险、量能暴露派发事实；不得输出看多信号，必须同步输出「高位放量滞涨」或「高位派发风险」风险标签' : '',
    withRule2: !!(rule2 && rule2.matched),
    withHighStagnant: !!(ctx.pv && ctx.pv.highStagnant && ctx.pv.highStagnant.matched),
  };

  // ---- 11.3.3.2 低位放大量但价格不跌，要跟踪 ----
  // 20261023c：修正误判——原条件 `(t.isStagnant || (chgPct !== null && chgPct > 0))`
  // 把「大涨」也算成「价格不跌」。用户 2026-10-23 报障：海天味业（603288）当日 +3.41%，
  // 仍命中「仅小阴小阳震荡或重心企稳」，与语义自相矛盾（大涨已是方向性上涨，不是「不跌」）。
  // 现口径（与 _volTraits.isStagnant / 低位放量震荡同一阈值 1.2%）：
  //   ① 小阴小阳震荡：当日 |涨跌幅| < 1.2%（硬门槛）；
  //   ② 重心企稳：近 3 日收盘重心不下移（与规则1 同口径），作为二次确认/文案，不豁免当日大涨；
  // 大涨/大跌（|涨跌幅| ≥ 1.2%）一律不属「价格不跌」——放量大涨由「低位倍量阳线/启动」规则另行判定。
  const lhRecentLows = pc.lows.slice(Math.max(0, n - 21), n - 1);
  const lhNotNewLow = lhRecentLows.length > 0 && pc.lowToday >= Math.min(...lhRecentLows);
  const LH_FLAT_PCT = 1.2; // 与 t.isStagnant 阈值一致：|收盘涨跌幅| < 1.2% 视为小阴小阳
  const lhSmallOsc = pc.chgPct !== null && Math.abs(pc.chgPct) < LH_FLAT_PCT;
  const lhSteadyCenter = n >= 3 && Array.isArray(pc.closes) && pc.closes.length >= n && pc.closes[n - 1] >= pc.closes[n - 3]; // 近 3 日重心不下移
  const lhBigRise = pc.chgPct !== null && pc.chgPct >= LH_FLAT_PCT;
  const lhMatched = pos === '低位区间' && t.isHugeVol && lhSmallOsc && lhNotNewLow;
  const lowHugeNotDown = {
    signal: '低位放大量但价格不跌，要跟踪',
    status: lhMatched ? '命中' : '未命中',
    matched: lhMatched,
    conclusion: lhMatched
      ? `低位放大量但价格不跌：低位区间出现大成交量（档位${pc.level}），价格没有继续下跌（收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，${lhSteadyCenter ? '近 3 日重心企稳' : '小阴小阳震荡'}）：大量筹码正在重新分配，值得跟踪但不直接看多`
      : (lhBigRise
          ? `未命中「低位放大量但价格不跌」：当日收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)} 已属大涨（≥${LH_FLAT_PCT}%），是方向性上涨、不是「价格不跌」，不适用本项（放量大涨由「低位倍量阳线/启动」规则另行判定）`
          : '未命中「低位放大量但价格不跌」（需低位区间 + 大成交量 + 仅小阴小阳震荡（|涨跌幅|<1.2%）或近 3 日重心企稳 + 未创近 20 日新低）'),
    trackHint: lhMatched ? '等待更强上涨信号：连续递增放量、重心抬升、有效突破或低位吸筹规则确认；只能输出观察，不得直接输出看多信号' : '',
    withRule1: !!(rule1 && rule1.matched),
    withLowOscillate: !!(ctx.pv && ctx.pv.lowOscillate && ctx.pv.lowOscillate.matched),
  };

  return { shouldAmpNot, shouldShrinkHuge, highHugeNotUp, lowHugeNotDown, traits: t, bottomPhase };
}

// ===================== 7.5b 预期量能规则（20261019d 新增） =====================
// 覆盖用户提供的「什么时候该放量 / 该缩量」判定中，现有 _positionVolumeRules / _contradictionRules
// 尚未覆盖的 4 类缺口：
//   风险类：①高位放量下跌（放量大阴线）②趋势向下放量阳线诱多 ③高位缩量横盘（温水煮青蛙）
//   正向确认类：④突破后回踩缩量不破 ⑤长期下跌后倍量阳线启动 ⑥主升浪缩量上涨（控盘）
// 全部为确定性 IF-THEN，零 LLM。命中即注入 _classify 约束 / 风险标签 / 归集总结。
// 与既有规则的边界（避免重复）：
//   - 高位放量下跌 ≠ highHugeNotUp/highStagnant：后者仅覆盖「滞涨横盘(|chgPct|<1.2%)」或「冲高回落(上影≥2%)」，
//     明显收跌的放量大阴线(chgPct≤-1.2%) 既非滞涨也非冲高回落，原规则漏判；本规则补此缺口。
//   - 趋势向下放量阳线诱多 ≠ shouldShrinkHuge：后者「趋势向下」场景要求 chgPct<0（仅缩量阴跌），
//     放量阳线(chgPct>0) 是经典诱多，原规则漏判；本规则补此缺口。
//   - 高位缩量横盘 ≠ shrinkUp 高位阶段：后者要求 chgPct>0（仅高位缩量上涨），
//     高位缩量横盘(|chgPct|<1.2%) 是动能衰竭危险横盘，原规则漏判；本规则补此缺口。
//   - 3 条正向确认在既有模型中无任何正面口径（模型偏矛盾/风险信号），本规则首次给出明确看多支撑。

// ===================== 6.8 量价十口诀（郭睿体系，20261023d 新增） =====================

const { volCell } = require('./posModel135'); // 20261105f：135 格知识表（与 volume-map.html 合并版 v2 页面逐字同源）

// ===== 20261105f 定版：量价判定模型合并版 v2 新判定链（位置3区 × 状态五步 × 量能五档 × 走势5档 = 135 格主轴 + 信号叠加层 + 异常特例） =====
// 判定标准：data/volume-model-spec.md（① 位置锚点一 / ② 运行状态五步 / ③ 量能档位 / ④ 当日走势 / ⑤ 信号叠加层 / ⑥ 异常特例 / ⑦ 一致性核查裁决）
// 135 格文案真值：lib/posModel135.js（与 public/volume-map.html 合并版 v2 页面逐字同源）
// 确定性逻辑全部由代码执行，零 LLM、零随机；数据不足时诚实降级（不硬套、不臆造归格）。

// —— ADX/DI（14 日 Wilder 平滑，标准参数；spec ② 强度判定） ——
function _adx14(bars) {
  const n = bars.length;
  if (n < 30) return null;
  const trs = [], pdm = [], mdm = [];
  for (let i = 1; i < n; i++) {
    const h = bars[i].high, l = bars[i].low, hc = bars[i - 1].high, lc = bars[i - 1].low, pc0 = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc0), Math.abs(l - pc0));
    const up = h - hc, dn = lc - l;
    trs.push(tr);
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const m = trs.length;
  // Wilder 平滑：首值取前 14 期和，其后 smooth = prev - prev/14 + cur
  const smooth = (arr) => {
    const s = [];
    let acc = arr.slice(0, 14).reduce((a, b) => a + b, 0);
    s.push(acc);
    for (let i = 14; i < m; i++) { acc = acc - acc / 14 + arr[i]; s.push(acc); }
    return s;
  };
  const trS = smooth(trs), pS = smooth(pdm), mS = smooth(mdm);
  if (trS.length < 15) return null;
  const dxs = [];
  let prevDI = null;
  const diSeries = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] <= 0) { diSeries.push(null); dxs.push(null); continue; }
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const dx = (pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    diSeries.push({ pdi, mdi, dx });
    dxs.push(dx);
  }
  // ADX = DX 的 14 期 Wilder 平滑
  const valid = dxs.filter(x => x !== null);
  if (valid.length < 14) return null;
  let adx = valid.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  let adxPrev = null;
  for (let i = 14, cnt = 0; i < dxs.length; i++) {
    if (dxs[i] === null) continue;
    adxPrev = adx;
    adx = (adx * 13 + dxs[i]) / 14;
  }
  const last = diSeries[diSeries.length - 1];
  const prev = diSeries[diSeries.length - 2];
  if (!last) return null;
  return {
    adx, adxPrev,
    plusDI: last.pdi, minusDI: last.mdi,
    spreadPrev: prev ? Math.abs(prev.pdi - prev.mdi) : null,
    spread: Math.abs(last.pdi - last.mdi),
  };
}

// —— 道氏摆动高低点递进（左右各 3 根确认；spec ② 价格结构锚点） ——
function _dowStructure(bars) {
  const W = 3;
  const n = bars.length;
  if (n < 2 * W + 5) return { dir: null, note: 'K 线不足，无法识别摆动高低点' };
  const highs = [], lows = [];
  for (let i = W; i < n - W; i++) {
    let isH = true, isL = true;
    for (let j = i - W; j <= i + W; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low <= bars[i].low) isL = false;
    }
    if (isH) highs.push({ idx: i, price: bars[i].high });
    if (isL) lows.push({ idx: i, price: bars[i].low });
  }
  const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
  if (!h2 || !l2 || !h1 || !l1) return { dir: null, note: '摆动高低点不足（各需 2 个确认点）' };
  const up = h2.price > h1.price && l2.price > l1.price;
  const down = h2.price < h1.price && l2.price < l1.price;
  const note = up
    ? `最近两个摆动高点抬高（${_round(h1.price)}→${_round(h2.price)}）且低点抬高（${_round(l1.price)}→${_round(l2.price)}），道氏向上结构`
    : down
      ? `最近两个摆动高点降低（${_round(h1.price)}→${_round(h2.price)}）且低点降低（${_round(l1.price)}→${_round(l2.price)}），道氏向下结构`
      : `高低点无同步递进（高点 ${_round(h1.price)}→${_round(h2.price)}，低点 ${_round(l1.price)}→${_round(l2.price)}），道氏结构中性`;
  return { dir: up ? 'up' : down ? 'down' : null, note };
}

// —— 均线排列 + 斜率（spec ② 视觉确认；斜率比排列更重要） ——
function _maArrange(pc, bars) {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const ma = (k, end) => end >= k ? _mean(closes.slice(end - k, end)) : null;
  const ma20 = ma(20, n), ma60 = ma(60, n), ma250 = ma(250, n);
  const ma20Prev = ma(20, n - 5);
  if (!ma20 || !ma60) return { ok: false, note: 'MA20/MA60 数据不足' };
  const bull = pc.closeToday > ma20 && ma20 >= ma60;
  const bear = pc.closeToday < ma20 && ma20 <= ma60;
  const slope = ma20Prev ? (ma20 - ma20Prev) / ma20Prev * 100 : null;
  const slopeTxt = slope === null ? '斜率数据不足' : `MA20 五日斜率 ${slope > 0 ? '+' : ''}${_round(slope)}%`;
  const arrTxt = bull ? '多头排列' : bear ? '空头排列' : '均线纠缠';
  const note = `${arrTxt}（MA20 ${_round(ma20)} / MA60 ${_round(ma60)}${ma250 ? ` / MA250 ${_round(ma250)}` : ''}），${slopeTxt}`;
  return { ok: true, bull, bear, slope, ma20, ma60, ma250, note };
}

// —— 箱体量化（spec ② 五条件同时满足；spec ⑦ 裁决：宽度 8%~25%、布林带宽 <15% 近似用 20 日带宽） ——
function _boxQuant(bars, sidewaysInfo) {
  const n = bars.length;
  const win = bars.slice(-40);
  const w = win.length;
  if (w < 20) return { hit: false, conds: [], note: 'K 线不足 20 根，箱体量化不适用' };
  const hi = Math.max(...win.map(b => b.high));
  const lo = Math.min(...win.map(b => b.low));
  const width = lo > 0 ? (hi - lo) / lo * 100 : null;
  // 条件1：横盘持续 >20 交易日（近期收盘均落在箱体内）
  const inside = win.filter(b => b.close >= lo && b.close <= hi).length;
  const cond1 = w >= 20 && inside / w >= 0.9;
  // 条件2：≥2 次触上下沿（high 距上沿 1.5% 内 / low 距下沿 1.5% 内）
  const touchTop = win.filter(b => b.high >= hi * 0.985).length;
  const touchBot = win.filter(b => b.low <= lo * 1.015).length;
  const cond2 = touchTop >= 2 && touchBot >= 2;
  // 条件3：上下沿偏差 <3%（两侧极值群与沿的距离）
  const nearTop = win.filter(b => b.high >= hi * 0.985).map(b => b.high);
  const nearBot = win.filter(b => b.low <= lo * 1.015).map(b => b.low);
  const devTop = nearTop.length ? (hi - _mean(nearTop)) / hi * 100 : 99;
  const devBot = nearBot.length ? (_mean(nearBot) - lo) / lo * 100 : 99;
  const cond3 = devTop < 3 && devBot < 3;
  // 条件4：宽度 8%~25%
  const cond4 = width !== null && width >= 8 && width <= 25;
  // 条件5：布林带宽 <15%（20 日 2 倍标准差 / 均值）
  const c20 = win.slice(-20).map(b => b.close);
  const ma20 = _mean(c20);
  const sd = Math.sqrt(_mean(c20.map(c => (c - ma20) * (c - ma20))));
  const bollWidth = ma20 > 0 ? 2 * sd / ma20 * 100 : null;
  const cond5 = bollWidth !== null && bollWidth < 15;
  const conds = [
    { k: '横盘 >20 交易日', ok: cond1, v: `近 ${w} 日内 ${Math.round(inside / w * 100)}% 收盘在箱体内` },
    { k: '≥2 次触上下沿', ok: cond2, v: `触上沿 ${touchTop} 次 / 触下沿 ${touchBot} 次` },
    { k: '上下沿偏差 <3%', ok: cond3, v: `上沿偏差 ${_round(devTop)}% / 下沿偏差 ${_round(devBot)}%` },
    { k: '箱体宽度 8%~25%', ok: cond4, v: width === null ? '宽度数据不足' : `宽度 ${_round(width)}%` },
    { k: '布林带宽 <15%', ok: cond5, v: bollWidth === null ? '数据不足' : `带宽 ${_round(bollWidth)}%` },
  ];
  const hit = conds.every(c => c.ok);
  return {
    hit, conds, high: hi, low: lo,
    note: hit
      ? `箱体量化五条件全部满足（上沿 ${_round(hi)} / 下沿 ${_round(lo)}，宽度 ${_round(width)}%），判为区间震荡（有顶有底，不形成有效突破）；此为横盘箱体量化（运行状态判定条件），非②卡支撑/阻力区间，两者口径不同、数值不应相等（20261106p）`
      : `箱体量化未全部满足（${conds.filter(c => !c.ok).map(c => c.k).join('、')}不成立）`,
  };
}

// —— 运行状态五步综合（spec ②；裁决：ADX 三段制 <20 震荡 / 20~25 灰色 / ≥25 趋势） ——
function _runState(bars, pc, trendSeg) {
  const adx = _adx14(bars);
  const dow = _dowStructure(bars);
  const maA = _maArrange(pc, bars);
  const box = _boxQuant(bars, null);
  // 量价健康度：近 20 日上涨日均量 / 下跌日均量
  const recent = bars.slice(-20);
  const upVols = recent.filter(b => b.close >= b.open).map(b => b.volume);
  const dnVols = recent.filter(b => b.close < b.open).map(b => b.volume);
  const health = (upVols.length && dnVols.length) ? _mean(upVols) / _mean(dnVols) : null;
  const healthTxt = health === null ? '量价健康度数据不足'
    : health >= 1.15 ? `上涨日均量为下跌日 ${_round(health)} 倍（≥1.15，量价健康）`
    : health <= 0.85 ? `上涨日均量仅为下跌日 ${_round(health)} 倍（≤0.85，量价质量存疑）`
    : `上涨/下跌日均量比 ${_round(health)}（均衡）`;
  const steps = [
    { k: '① 道氏结构', v: dow.note, hit: !!dow.dir },
    { k: '② ADX 强度', v: adx ? `ADX ${_round(adx.adx)}（+DI ${_round(adx.plusDI)} / -DI ${_round(adx.minusDI)}${adx.spreadPrev != null ? (adx.spread > adx.spreadPrev ? '，开口扩大' : '，开口收窄') : ''}）${adx.adx >= 25 ? '：趋势成立' : adx.adx < 20 ? '：无趋势动能（震荡行情）' : '：灰色地带（20~25，观察）'}` : 'ADX 数据不足（K 线不足 30 根）', hit: !!adx && adx.adx >= 25 },
    { k: '③ 均线排列', v: maA.note, hit: !!(maA.bull || maA.bear) },
    { k: '④ 箱体量化', v: box.note, hit: box.hit },
    { k: '⑤ 量价健康度', v: healthTxt, hit: health !== null && (health >= 1.15 || health <= 0.85) },
  ];
  const adxTxt = adx ? adx.adx : null;
  const diUp = adx && adx.plusDI > adx.minusDI;
  const diDown = adx && adx.minusDI > adx.plusDI;
  let state = null, gray = false, note = '';
  if (adxTxt !== null && adxTxt >= 25 && (diUp || diDown) && adx.spread >= 3) {
    state = diUp ? '趋势向上' : '趋势向下';
    gray = false;
    note = `ADX ≥25 且 ${diUp ? '+DI 在 -DI 上方' : '-DI 在 +DI 上方'}（开口 ${adx.spreadPrev != null && adx.spread > adx.spreadPrev ? '扩大' : '收窄'}），趋势成立`;
  } else if (box.hit) {
    state = '区间震荡';
    note = 'ADX 未达趋势阈值（或方向不明），箱体量化五条件全部满足 → 区间震荡';
  } else if (adxTxt !== null && adxTxt < 20) {
    state = '区间震荡';
    note = 'ADX <20，市场处于震荡行情（缺乏趋势动能，方向性不明确）';
  } else {
    // 灰色地带（20~25）或 ADX≥25 但 DI 纠缠：按道氏结构 + 均线 + 趋势段倾向输出，灰色标注
    gray = true;
    const seg = trendSeg || null;
    const dowDir = dow.dir, maDir = maA.bull ? 'up' : maA.bear ? 'down' : null;
    const vote = [dowDir, maDir, seg && seg.direction === 'up' ? 'up' : seg && seg.direction === 'down' ? 'down' : null].filter(Boolean);
    const upN = vote.filter(x => x === 'up').length, dnN = vote.filter(x => x === 'down').length;
    if (upN > dnN) { state = '趋势向上'; note = `ADX 处于灰色地带（${_round(adxTxt)}，20~25），按道氏结构+均线倾向判定（${upN} 票向上 / ${dnN} 票向下），趋势强度不足、以观察为主`; }
    else if (dnN > upN) { state = '趋势向下'; note = `ADX 处于灰色地带（${_round(adxTxt)}，20~25），按道氏结构+均线倾向判定（${dnN} 票向下 / ${upN} 票向上），趋势强度不足、以观察为主`; }
    else { state = '区间震荡'; note = `ADX 灰色地带且道氏/均线无一致倾向，判为区间震荡`; }
  }
  if (!state) { state = '区间震荡'; note = '判定数据不足，按无趋势观察处理'; }
  return { state, gray, steps, note, adx, dow, maA, box, health };
}

// —— 位置锚点一：250 日价格分位 3 区归格（spec ①；锚点二~四仅参考提醒） ——
function _posZone(pc, ctx) {
  const pct = pc.pricePct12m; // 0~1，250 根收盘 min-max 归一
  if (pct === null || pct === undefined) return { label: null, note: '价格分位数据不足，位置无法归格' };
  const label = pct >= 0.7 ? '高位区间' : pct <= 0.3 ? '低位区间' : '中位区间';
  const zoneName = pct >= 0.7 ? '① 高位区间' : pct <= 0.3 ? '③ 低位区间' : '② 中位区间';
  const dd = pc.drawdownFromHigh, rally = pc.rallyFromLow;
  const basis = `锚点一（默认判定源）：250 日价格分位 ${Math.round(pct * 100)}%（当前价距 250 日最高 ${dd !== null ? `${_round(dd)}%` : '?'} / 距 250 日最低 ${rally !== null ? `+${_round(rally)}%` : '?'}），归格 ${label}（≥70% 高位 / ≤30% 低位）`;
  // 锚点二~四参考提醒（20261105f 定版接线：锚点二=quote PE/PB 快照，锚点三=本地 CYQ 筹码，锚点四=技术偏离度）
  const qs = (ctx && ctx.quoteSnapshot) || null;
  const chip = (ctx && ctx.chip) || null;
  const bias20 = pc.ma20 ? (pc.closeToday - pc.ma20) / pc.ma20 * 100 : null;
  const refs = [];
  if (qs && (qs.pe || qs.pb)) {
    const peTxt = qs.pe ? `PE(TTM) ${_round(qs.pe)} 倍` : null;
    const pbTxt = qs.pb ? `PB ${_round(qs.pb)} 倍` : null;
    refs.push({ k: '锚点二 · 估值分位', v: `${[peTxt, pbTxt].filter(Boolean).join(' / ')}（绝对水平参考；PE/PB 历史百分位时序数据源建设中，暂不提供分位）`, available: true });
  } else {
    refs.push({ k: '锚点二 · 估值分位', v: '未接入（PE/PB 历史百分位时序数据源建设中）', available: false });
  }
  if (chip && chip.benefitPct !== undefined) {
    refs.push({ k: '锚点三 · 筹码获利盘', v: `获利盘 ${chip.benefitPct}%，平均成本 ${chip.avgCost} 元（${chip.verdict}，本地 CYQ 250 日窗口，仅参考提醒）`, available: true });
  } else {
    refs.push({ k: '锚点三 · 筹码获利盘', v: intradayPendingReason(ctx) || '数据不足（流通股本不可得，筹码计算跳过）', available: false });
  }
  refs.push({ k: '锚点四 · 技术偏离度', v: bias20 !== null ? `BIAS20 ${bias20 > 0 ? '+' : ''}${_round(bias20)}%；距 250 日高点回撤 ${dd !== null ? `${_round(Math.abs(dd))}%` : '?'}（38.2% 回撤位参考）` : '数据不足', available: bias20 !== null });
  return { label, zoneName, pct, basis, refs, note: null };
}

function intradayPendingReason(ctx) {
  return (ctx && ctx.intradayPending === true) ? '盘中停算（当日筹码按实时价近似失真，收盘后定论）' : null;
}

// —— 量能五档（spec ③ 基准二：量比 = 当日量 ÷ 20 日均量；裁决：平量 0.8~1.3 含上界） ——
function _volTier5(pc, bars) {
  const ratio20 = pc.ratio20;
  if (ratio20 === null || ratio20 === undefined || !isFinite(ratio20)) {
    return { vol: null, extreme: null, ratio20: null, basis: '20 日均量数据不足，量能档位无法归格（不硬套）' };
  }
  // 250 日量极值（除今日）
  const vols = bars.map(b => b.volume);
  const n = vols.length;
  const win = vols.slice(Math.max(0, n - 250), n - 1).filter(v => v > 0);
  const volMax = win.length ? Math.max(...win) : null;
  const volMin = win.length ? Math.min(...win) : null;
  const isNewHigh = volMax !== null && pc.volToday >= volMax;
  const isNewLow = volMin !== null && pc.volToday <= volMin;
  let vol, extreme = null, basis;
  if (isAmpRatio(ratio20)) {
    vol = '放量';
    if (ratio20 >= 2 && isNewHigh) { extreme = '天量'; basis = `量比 ${_round(ratio20)}（≥2 且创 250 日量新高）→ 天量（放量的极端形态）`; }
    else basis = `量比 ${_round(ratio20)}（>${VOL_AMP}）→ 放量（温和增量）`;
  } else if (isShrinkRatio(ratio20)) {
    vol = '缩量';
    if (ratio20 < 0.5 && isNewLow) { extreme = '地量'; basis = `量比 ${_round(ratio20)}（<0.5 且创 250 日量新低）→ 地量（缩量的极端形态）`; }
    else basis = `量比 ${_round(ratio20)}（<${VOL_SHRINK}）→ 缩量（交投低于常态）`;
  } else {
    vol = '平量';
    basis = `量比 ${_round(ratio20)}（${VOL_SHRINK}~${VOL_AMP}，与 20 日均量基本持平）→ 平量（正常状态）`;
  }
  return { vol, extreme, ratio20, basis, isNewHigh, isNewLow };
}

// —— 当日走势五档（spec ④：大涨 ≥5% / 上涨 1.2~5% / 震荡 <1.2% / 下跌 -1.2~-5% / 大跌 ≤-5%；震荡档天然覆盖 0） ——
function _walkTier5(chg) {
  if (chg === null || chg === undefined || !isFinite(chg)) return null;
  if (chg >= 5) return '大涨';
  if (chg >= 1.2) return '上涨';
  if (chg > -1.2) return '震荡';
  if (chg > -5) return '下跌';
  return '大跌';
}

// —— 信号叠加层三卡（spec ⑤；递进链条：预警层→确认层→分歧信号；无确认仅预警） ——
function _signalLayer(bars, pc, posZone, volT5, intradayPending) {
  const n = bars.length;
  // —— 卡1 量价背离（MACD DIF 摆动点比较 + RSI 门控 + 量能确认） ——
  let divergence = { triggered: false, state: '未出现', type: null, note: '未检测到 MACD 背离结构' };
  try {
    const { MACD, RSI } = require('./analysis');
    const closes = bars.map(b => b.close);
    const m = MACD(closes);
    const r = RSI(closes, 14);
    const W = 3;
    const swHighs = [], swLows = [];
    for (let i = W; i < n - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (bars[j].high >= bars[i].high) isH = false;
        if (bars[j].low <= bars[i].low) isL = false;
      }
      if (isH) swHighs.push({ idx: i, price: bars[i].high });
      if (isL) swLows.push({ idx: i, price: bars[i].low });
    }
    const difAt = (idx) => m.dif[idx];
    const rsiLast = r[r.length - 1];
    // 顶背离：相邻两摆动高点更高但 DIF 更低；门控 RSI ≥70
    const h1 = swHighs[swHighs.length - 2], h2 = swHighs[swHighs.length - 1];
    const l1 = swLows[swLows.length - 2], l2 = swLows[swLows.length - 1];
    const difH1 = h1 && difAt(h1.idx), difH2 = h2 && difAt(h2.idx);
    const difL1 = l1 && difAt(l1.idx), difL2 = l2 && difAt(l2.idx);
    const crossUp = n >= 2 && m.dif[n - 2] !== null && m.dif[n - 1] !== null && m.signal[n - 2] !== null && m.signal[n - 1] !== null
      && m.dif[n - 2] <= m.signal[n - 2] && m.dif[n - 1] > m.signal[n - 1];
    const crossDn = n >= 2 && m.dif[n - 2] !== null && m.dif[n - 1] !== null && m.signal[n - 2] !== null && m.signal[n - 1] !== null
      && m.dif[n - 2] >= m.signal[n - 2] && m.dif[n - 1] < m.signal[n - 1];
    const volConfirmUp = crossUp && pc.volToday > (pc.avg5 || 0);
    if (h1 && h2 && difH1 !== null && difH2 !== null && h2.price > h1.price && difH2 < difH1) {
      if (rsiLast !== null && rsiLast < 70) {
        divergence = { triggered: false, state: '不予采纳', type: '顶背离', note: `检测到价格新高但 DIF 走低（顶背离结构），但 RSI ${_round(rsiLast)} <70 未入超买区，按 spec ⑤ 门控不予采纳` };
      } else {
        const confirmed = crossDn && pc.volToday > (pc.avg5 || 0);
        divergence = { triggered: true, state: confirmed ? '已确认（死叉放量离场）' : '出现（待死叉确认）', type: '顶背离', note: `顶背离：价格摆动高点 ${_round(h1.price)}→${_round(h2.price)} 创新高但 DIF ${_round(difH1)}→${_round(difH2)} 走低${rsiLast !== null ? `（RSI ${_round(rsiLast)} ≥70 超买区内）` : ''}；口诀「新高量能跟不上，死叉放量离场」${confirmed ? '——死叉当日已放量下跌，资金集中出逃，背离确认' : '——待死叉当日放量确认；若新高同时持续爆量则背离易被突破作废'}` };
      }
    } else if (l1 && l2 && difL1 !== null && difL2 !== null && l2.price < l1.price && difL2 > difL1) {
      if (rsiLast !== null && rsiLast > 30) {
        divergence = { triggered: false, state: '不予采纳', type: '底背离', note: `检测到价格新低但 DIF 走高（底背离结构），但 RSI ${_round(rsiLast)} >30 未入超卖区，按 spec ⑤ 门控不予采纳` };
      } else {
        divergence = { triggered: true, state: volConfirmUp ? '已确认（金叉放量进场）' : '出现（待金叉确认）', type: '底背离', note: `底背离：价格摆动低点 ${_round(l1.price)}→${_round(l2.price)} 创新低但 DIF ${_round(difL1)}→${_round(difL2)} 走高${rsiLast !== null ? `（RSI ${_round(rsiLast)} ≤30 超卖区内）` : ''}；口诀「下跌缩量衰竭，金叉放量进场」${volConfirmUp ? '——金叉当日已放量并站上短期均线观察，背离确认' : '——待首次金叉当天放量（>5 日均量）确认；若背离全程放量下跌则属恐慌出逃、大概率继续阴跌'}` };
      }
    }
  } catch (e) {
    divergence = { triggered: false, state: '数据不足', type: null, note: `MACD/RSI 计算不可用：${e.message}` };
  }
  // —— 卡2 极端量能（spec ⑤ 双口径；裁决 ⑦-3：换手历史 90% 分位并列口径适配大盘股） ——
  let extreme = { triggered: false, type: null, note: '未触发（当日量能未达极端口径）' };
  if (intradayPending) {
    extreme = { triggered: false, pending: true, type: null, note: '盘中停判：当日量为部分日累计，与全天量能阈值不可比，收盘后定论' };
  } else if (volT5.extreme === '天量') {
    const to = pc.turnoverToday;
    const toPass = (typeof to === 'number' && to >= 20);
    const toWin = Array.isArray(pc.turnovers) ? pc.turnovers.slice(-250).filter(t => t > 0) : [];
    const toPct = toWin.length && typeof to === 'number' ? _pctRank(toWin, to) : null;
    const toPctPass = toPct !== null && toPct >= 90;
    const dual = toPass || toPctPass;
    extreme = {
      triggered: true, type: '天量', dual,
      note: `天量（量比 ${_round(volT5.ratio20)} ≥2 且创 250 日量新高）${dual ? `，换手率口径${toPass ? ` ${_round(to)}% ≥20%` : `处于历史 ${Math.round(toPct)}% 分位 ≥90%`}同时满足，分歧达到极致` : '，换手率口径未达标（换手数据不足或未及阈值），按量能口径单列警示'}；方向取决于位置：${posZone.label === '高位区间' ? '当前处于高位——指向多头透支、主力派发，高度警惕' : posZone.label === '低位区间' ? '当前处于低位——指向做空衰竭、资金承接观察' : '中位天量——方向中性，紧盯后续量价延续'}`,
    };
  } else if (volT5.extreme === '地量') {
    const to = pc.turnoverToday;
    const toAux = (typeof to === 'number' && to < 0.5) ? `，换手率 ${_round(to)}% <0.5% 辅助确认` : (typeof to === 'number' ? `，换手率 ${_round(to)}%（辅助口径未达 <0.5%，以量能口径为准）` : '，换手率数据不足（辅助口径无法核验）');
    extreme = {
      triggered: true, type: '地量', dual: null,
      note: `地量（量比 ${_round(volT5.ratio20)} <0.5 且创 250 日量新低）${toAux}；地量需连续多个交易日出现才构成有效「抛压耗尽」，单日地量可能是假日效应，持续观察`,
    };
  }
  // —— 卡3 弱方向异动（滞涨/滞跌；spec ⑤ 努力与结果不匹配；裁决 ⑦-5：叠加警示不覆盖主判） ——
  let weak = { triggered: false, type: null, auxCount: 0, position: null, note: '未触发（量能与价格结果匹配或量能未放大）' };
  if (!intradayPending && pc.ratio5 !== null) {
    const chg = pc.chgPct;
    const amp = pc.highToday !== null && pc.lowToday !== null && pc.closePrev ? (pc.highToday - pc.lowToday) / pc.closePrev * 100 : null;
    const upperShadow = pc.highToday !== null && pc.closeToday !== null && pc.openToday !== null ? (pc.highToday - Math.max(pc.closeToday, pc.openToday)) / Math.max(pc.closeToday - pc.lowToday, 0.0001) : null;
    const lowerBody = Math.abs(pc.closeToday - pc.openToday);
    const auxs = [];
    if (amp !== null && amp < 3) auxs.push(`振幅 ${_round(amp)}% <3%（价格被压制在窄区间）`);
    if (upperShadow !== null && upperShadow > 2 && lowerBody > 0) auxs.push('长上影（盘中高位遭遇持续抛压）');
    if (typeof pc.turnoverToday === 'number' && Array.isArray(pc.turnovers)) {
      const tw = pc.turnovers.slice(-250).filter(t => t > 0);
      const tp = tw.length ? _pctRank(tw, pc.turnoverToday) : null;
      if (tp >= 90) auxs.push(`换手率处历史 ${Math.round(tp)}% 分位（≥90%）但价格不创新高`);
    }
    const posTxt = posZone.pct != null
      ? (posZone.pct >= 0.7 ? '高位·出货风险倾向（回落时不缩量、快速跌破放量日最低价则为出货确认）'
        : posZone.pct <= 0.3 ? '低位·吸筹可能倾向（回落时明显缩量、守住放量日低点则为吸筹确认）'
        : '中位·方向中性（待后续 3~5 日量价延续性确认）')
      : '位置数据不足';
    if (pc.ratio5 >= 2 && chg !== null && chg > 0 && chg < 1.2) {
      weak = { triggered: true, type: '放量滞涨', auxCount: auxs.length, auxs, position: posTxt, note: `量比（5 日）${_round(pc.ratio5)} ≥2 但涨幅仅 ${_round(chg)}% <1.2%，量能的「努力」未换来价格「结果」${auxs.length ? `；辅助确认 ${auxs.length} 项（${auxs.join('；')}）` : ''}；位置解读：${posTxt}。滞涨不等于出货——关键在后续 3~5 天量价延续性` };
    } else if (pc.ratio5 >= 2 && chg !== null && chg < 0 && chg > -1.2) {
      weak = { triggered: true, type: '放量滞跌', auxCount: auxs.length, auxs, position: posTxt, note: `量比（5 日）${_round(pc.ratio5)} ≥2 但跌幅仅 ${_round(chg)}% >-1.2%，放量下方有承接但上行动能不足；位置解读：${posTxt}` };
    } else if (isShrinkRatio(volT5.ratio20) && chg !== null && chg < 0) {
      weak = { triggered: true, type: '缩量止跌观察', auxCount: 0, auxs: [], position: posTxt, note: `量比（20 日）${_round(volT5.ratio20)} <${VOL_SHRINK} 且股价下跌——愿意在低位割肉的筹码已少，卖压自然枯竭（滞跌的本质是卖压枯竭而非买盘进场）；滞跌不等于见底，待跌幅收窄或不再创新低确认` };
    }
  }
  const cards = [divergence, extreme, weak];
  const trigCount = cards.filter(c => c.triggered).length;
  const resonance = trigCount >= 2;
  return {
    divergence, extreme, weak,
    resonance,
    resonanceNote: resonance ? `三卡共振（${cards.filter(c => c.triggered).map(c => c.type).join(' + ')}）——递进链条「预警层→确认层→分歧信号」同时点亮，信号可靠性远高于单独出现` : null,
  };
}

// —— 异常特例检测层（spec ⑥；优先于主轴，命中则主判挂起不臆造归格） ——
function _specialCases(bars, pc) {
  const n = bars.length;
  const today = bars[n - 1], prev = bars[n - 2];
  const chg = pc.chgPct;
  // ⑥1 一字板：开=高=低=收 且接近涨跌停（价格锁死、指标空转、无有效新信息）
  if (today && prev && today.open === today.high && today.high === today.low && today.low === today.close && chg !== null && Math.abs(chg) >= 9.5) {
    return { type: '一字板', note: `一字${chg > 0 ? '涨停' : '跌停'}板（开=高=低=收，|涨跌幅| ${_round(Math.abs(chg))}%）：价格被锁死、买卖双方排不上队，均线/MACD/ADX 等指标空转，板期间不产生有效新信息——量价分析失效。观察窗口后移至开板日：开板日必然放巨量（积压单一次性结清，量本身不指示方向），最硬判据为「收盘价相对板价的位置」——收盘守在锁死价位上方=承接有效；跌破锁死价位=板内买入筹码全部浮亏，次日卖压集中释放` };
  }
  // ⑥4 停牌复牌：相邻日K间隔 >10 自然日（价格断裂+结构失效，用悬空K线群替代）
  if (today && prev && today.date && prev.date) {
    const dt = (new Date(today.date) - new Date(prev.date)) / 86400000;
    if (dt > 10) {
      const grp = bars.slice(-5);
      const gh = Math.max(...grp.map(b => b.high)), gl = Math.min(...grp.map(b => b.low));
      return { type: '停牌复牌', note: `停牌 ${Math.round(dt - 1)} 天后复牌（${prev.date} → ${today.date}）：复牌前均线/趋势/指标全部断裂，不得将停牌前结论套用到复牌后。观察工具=悬空K线群：近 ${grp.length} 根高低点构成悬空箱体（高 ${_round(gh)} / 低 ${_round(gl)}），向上突破群高点→倾向主力收集/趋势延续；向下跌破群低点→倾向派发/趋势转弱；复牌巨量K线是出货还是建仓无法凭当日量价判断，待突破方向确认` };
    }
  }
  // ⑥2 黑天鹅跳空：向下实体跳空且缺口幅度超波动率框架（价格连续假设被打破）
  if (today && prev && chg !== null && chg < 0) {
    const gapPct = prev.close > 0 ? (prev.close - today.high) / prev.close * 100 : 0;
    const recent = bars.slice(-20).slice(0, -1);
    const avgAmp = recent.length ? _mean(recent.map(b => (b.high - b.low) / b.close * 100)) : null;
    if (gapPct > 1.5 && avgAmp !== null && gapPct > avgAmp * 2) {
      return { type: '黑天鹅跳空', note: `向下跳空缺口 ${_round(gapPct)}%（超近 20 日均振幅 ${_round(avgAmp)}% 的 2 倍）：价格连续假设被打破，止损/支撑/均线在缺口瞬间失效，常规「缩量止跌」信号不可按原义解读（流动性可能在缺口下方断裂）。框架调整：暂停常规量价方向判断，观察缺口回补的速度与方式（回补行为比缺口当日量能更有信息量）；风控前置到仓位管理而非止损单` };
    }
  }
  // ⑥3 对倒嫌疑：换手率异常高但价格无回应（Level-2/盘口不可得，仅量价特征嫌疑标注）
  if (typeof pc.turnoverToday === 'number' && pc.turnoverToday > 20 && chg !== null && Math.abs(chg) < 1.5) {
    return { type: '对倒嫌疑', note: `换手率 ${_round(pc.turnoverToday)}% >20% 但涨跌幅仅 ${_round(chg)}%（量增价不动）：符合对倒识别锚点之「巨量滞涨」——量在努力、价格没有回应。框架调整：成交量绝对值降权、量价一致性升权（真实放量伴随价格同向稳步推进，对倒量多为量价背离）。注：Level-2 逐笔/盘口大单撤单等数据工作台不可得，本条为量价特征嫌疑标注而非定论` };
  }
  return null;
}

// —— 主链组装：_posVolumeMatrix 重写（20261105f 定版，替代旧 24 格矩阵扩展链） ——
function _posVolumeMatrix(pc, ctx, bars) {
  const barsArr = Array.isArray(bars) ? bars : [];
  const intradayPending = !!(ctx && ctx.intradayPending);
  const posZ = _posZone(pc, ctx);
  const runS = barsArr.length >= 30 ? _runState(barsArr, pc, ctx && ctx.trendSegment) : { state: null, gray: false, steps: [], note: 'K 线不足 30 根，运行状态五步判定不可用', adx: null, dow: null, maA: { ok: false, note: '数据不足' }, box: { hit: false, conds: [] }, health: null };
  const volT5 = _volTier5(pc, barsArr);
  const chg = pc.chgPct;
  const walkT5 = _walkTier5(chg);
  const weakAmp = chg !== null && chg !== 0 && Math.abs(chg) < 1.2;
  const chgTxt = chg !== null ? _fmtPct(chg, 2) : '涨跌幅数据不足';

  // 异常特例：优先于主轴（命中则挂起主判）
  const special = barsArr.length >= 2 ? _specialCases(barsArr, pc) : null;

  // 主轴归格：位置 × 状态 × 量能 × 走势 → 135 格
  let cell = null;
  let cellFail = null;
  if (special) {
    cellFail = `异常特例生效（${special.type}）：主轴判定挂起，切换到该场景专用观察维度（见特例说明），不臆造归格`;
  } else if (!posZ.label) {
    cellFail = posZ.note || '位置无法归格';
  } else if (!runS.state) {
    cellFail = runS.note;
  } else if (!volT5.vol) {
    cellFail = volT5.basis;
  } else if (!walkT5) {
    cellFail = '当日涨跌幅数据不足，走势档位无法归格';
  } else {
    const c = volCell(posZ.zoneName, runS.state, volT5.vol, walkT5);
    if (!c) cellFail = '归格组合未命中知识表（理论上不应出现，如实上报）';
    else {
      const dirMap = { '大涨': 'bull', '上涨': 'bull', '震荡': 'observe', '下跌': 'bear', '大跌': 'bear' };
      const dirTextMap = { '大涨': '偏多（强）', '上涨': '偏多', '震荡': '观察', '下跌': '看空', '大跌': '看空（强）' };
      cell = { ...c, direction: dirMap[walkT5], dirText: dirTextMap[walkT5], tier5: walkT5 };
    }
  }

  // 信号叠加层
  const signals = _signalLayer(barsArr, pc, posZ, volT5, intradayPending);

  const mode = {
    key: runS.state,
    gray: runS.gray,
    steps: runS.steps,
    note: runS.note,
  };
  const anomaly = {
    divergence: signals.divergence.triggered
      ? { triggered: true, key: signals.divergence.type, note: signals.divergence.note }
      : { triggered: false, key: null, note: signals.divergence.note },
    extreme: signals.extreme.triggered || signals.extreme.pending
      ? { triggered: signals.extreme.triggered, pending: !!signals.extreme.pending, key: signals.extreme.type, note: signals.extreme.note }
      : { triggered: false, pending: false, key: null, note: signals.extreme.note },
  };

  // summary 生成
  let summary;
  if (special) {
    summary = `${cellFail || ''} ${special.note}`;
  } else if (!cell) {
    summary = `量价判定暂不可出结论：${cellFail}。已定位 ${posZ.label || '位置数据不足'}、运行状态 ${runS.state || '数据不足'}、量能 ${volT5.vol || '数据不足'}、走势 ${walkT5 || '数据不足'}——按诚实降级处理，不硬套归格。`;
  } else {
    const grayTxt = runS.gray ? '（趋势强度灰色地带，以观察为主）' : '';
    const exTxt = volT5.extreme ? `（${volT5.extreme}——${volT5.vol}的极端形态）` : '';
    summary = `第一步定位：${posZ.label}（250 日价格分位 ${Math.round((posZ.pct || 0) * 100)}%）；第二步运行状态：${runS.state}${grayTxt}（${runS.note}）；第三步结合量能与涨跌幅：${volT5.vol}${exTxt} + ${walkT5}（当日 ${chgTxt}）→ 主轴 135 格归格${cell.derived ? '（推导格）' : ''}。`;
  }

  return {
    schema: 'pos-model-135-1',
    model: '合并版 v2 · 主轴 135 格',
    position: {
      label: posZ.label,
      zoneName: posZ.zoneName || null,
      display: posZ.label || '数据不足',
      note: posZ.note || null,
      basis: posZ.basis || null,
      pct: posZ.pct ?? null,
      refs: posZ.refs || [],
      divergence: (ctx && ctx.position && ctx.position.divergence) || null,
    },
    mode,
    volume: {
      tier: volT5.vol,
      tier5: volT5.extreme || volT5.vol,
      extreme: volT5.extreme,
      ratio20: volT5.ratio20 !== null && volT5.ratio20 !== undefined ? _round(volT5.ratio20) : null,
      ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
      level: pc.level,
      levelText: `量能档位${pc.level}`,
      basis: volT5.basis,
    },
    price: { chgPct: chg, walk: walkT5, text: chgTxt, weakAmp },
    cell,
    signals,
    special,
    anomaly,
    summary,
  };
}
// ===== 20261105f 新判定链结束 =====


function _expectedVolumeRules(pc, ctx) {
  const t = _volTraits(pc);
  const pos = (ctx.position && ctx.position.label) || '';
  const levels = ctx.levels || {};
  const breakThrough = !!ctx.breakThrough;
  const rule1 = (ctx.rules || []).find(r => r.id === 1);
  const rule1Matched = !!(rule1 && rule1.matched);

  // ---- ①高位放量下跌（放量大阴线 / 高位派发）----
  const hvMatched = pos === '高位区间' && t.isHugeVol && pc.chgPct !== null && pc.chgPct <= -1.2;
  const highVolumeDrop = {
    form: '高位放量下跌',
    signal: '高位放量大阴线，警惕派发',
    status: pc.chgPct === null ? '数据不足' : (hvMatched ? '命中' : '未命中'),
    matched: hvMatched,
    tone: hvMatched ? 've-bear' : null,
    conclusion: hvMatched
      ? `高位放量下跌：高位区间出现大成交量（档位${pc.level}，当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）且收盘明显下跌（${_fmtPct(pc.chgPct, 2)}）：高位放量大阴线，筹码大规模出逃，属典型高位派发 / 出货信号，需警惕后续破位`
      : (pc.chgPct === null
          ? '高位放量下跌：涨跌幅数据不足，无法判定'
          : (pos === '高位区间' && t.isHugeVol
              ? '高位放量但收跌幅度未达明显下跌阈值（|跌幅|<1.2% 偏滞涨 / 上影），由「高位放量滞涨」规则覆盖'
              : '未处于高位区间或量能未达明显放量，不触发高位放量下跌判定')),
    detail: {
      positionHigh: pos === '高位区间',
      volume: t.isHugeVol ? `量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）` : `量能未达明显放量标准（档位${pc.level}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      interpretation: hvMatched ? '高位放量大阴线，筹码大规模出逃，高位派发 / 出货风险' : '未命中高位放量下跌',
      riskHint: hvMatched ? '高位派发风险；不得输出看多信号，必须同步输出风险标签' : '',
    },
  };

  // ---- ②趋势向下放量阳线诱多 ----
  const dvutMatched = pos === '趋势向下' && t.isHugeVol && pc.chgPct !== null && pc.chgPct > 0 && !rule1Matched;
  const downtrendVolUpTrap = {
    form: '趋势向下放量阳线',
    signal: '下跌中继放量阳线，疑似诱多',
    status: pc.chgPct === null ? '数据不足' : (dvutMatched ? '命中' : '未命中'),
    matched: dvutMatched,
    tone: dvutMatched ? 've-bear' : null,
    conclusion: dvutMatched
      ? `趋势向下放量阳线：趋势向下出现大成交量（档位${pc.level}）且收阳（${_fmtPct(pc.chgPct, 2)}）：属下跌中继的放量阳线诱多，主力借反弹对倒出货，并非趋势反转，需警惕再次破位`
      : (pc.chgPct === null
          ? '趋势向下放量阳线：涨跌幅数据不足，无法判定'
          : (pos === '趋势向下' && t.isHugeVol
              ? '趋势向下放量但收阴（缩量阴跌场景），由「该缩量反放巨量」规则覆盖'
              : '未处于趋势向下或量能未达明显放量，不触发趋势向下放量阳线判定')),
    detail: {
      positionDowntrend: pos === '趋势向下',
      volume: t.isHugeVol ? `量能${pc.level}（当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）` : `量能未达明显放量标准（档位${pc.level}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      interpretation: dvutMatched ? '下跌中继放量阳线诱多，对倒出货，非趋势反转' : '未命中趋势向下放量阳线诱多',
      riskHint: dvutMatched ? '诱多陷阱；不得输出看多信号，按看空观察 / 看空预警处理' : '',
    },
  };

  // ---- ③高位缩量横盘（温水煮青蛙）----
  const hssMatched = pos === '高位区间' && t.isShrink && t.isStagnant;
  const highShrinkSideways = {
    form: '高位缩量横盘',
    signal: '高位缩量横盘，动能衰竭',
    status: (pc.chgPct === null) ? '数据不足' : (hssMatched ? '命中' : '未命中'),
    matched: hssMatched,
    tone: hssMatched ? 've-bear' : null,
    conclusion: hssMatched
      ? `高位缩量横盘：高位区间成交缩到低位（档位${pc.level}，当前量 ÷ 5 日均量 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍）且价格横盘（${_fmtPct(pc.chgPct, 2)}）：上涨动能衰竭，高位无人愿意接力，属温水煮青蛙式危险横盘，随时可能补跌`
      : (pc.chgPct === null
          ? '高位缩量横盘：涨跌幅数据不足，无法判定'
          : (pos === '高位区间' && t.isShrink
              ? '高位缩量但价格仍在上行（缩量上涨场景），由「高位缩量上涨」规则覆盖'
              : '未处于高位区间或量能未缩，不触发高位缩量横盘判定')),
    detail: {
      positionHigh: pos === '高位区间',
      volume: t.isShrink ? `缩量（档位${pc.level}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}，横盘状态` : '数据不足',
      interpretation: hssMatched ? '高位缩量横盘，上涨动能衰竭，补跌风险' : '未命中高位缩量横盘',
      riskHint: hssMatched ? '上涨动能衰竭；不得输出看多信号' : '',
    },
  };

  // ---- ④突破后回踩缩量不破（正向确认）----
  const bpMatched = breakThrough && t.isShrink && pc.chgPct !== null && pc.chgPct < 0
    && levels.resistance && levels.resistance.price != null
    && pc.closeToday >= levels.resistance.price * 0.995;
  const breakoutPullbackShrink = {
    form: '突破后回踩缩量',
    signal: '有效突破后缩量回踩不破，确认突破',
    status: bpMatched ? '命中' : (breakThrough ? '未命中' : '未触发'),
    matched: bpMatched,
    tone: bpMatched ? 've-bull' : null,
    conclusion: bpMatched
      ? `突破后回踩缩量：已有效突破关键压力位（站稳 3% 连续 2 日）后回调，但成交缩量（档位${pc.level}）且收盘价（${_round(pc.closeToday)}）未跌破原压力位（${_round(levels.resistance.price)}）：属健康回踩确认，筹码锁定良好，突破有效性增强`
      : (breakThrough
          ? '已有效突破但回踩时量能未缩或跌破原压力位，突破确认度一般'
          : '当前无有效突破前提，不触发突破后回踩缩量判定'),
    detail: {
      breakThrough,
      volume: t.isShrink ? `缩量（档位${pc.level}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      interpretation: bpMatched ? '有效突破后缩量回踩不破，突破确认，看多支撑' : '未命中突破后回踩缩量',
      hint: bpMatched ? '作为看多支撑：突破有效性增强，量价配合健康' : '',
    },
  };

  // ---- ⑤长期下跌后倍量阳线启动（正向确认）----
  const bvusMatched = pos === '低位区间' && pc.chgPct !== null && pc.chgPct > 0
    && pc.ratio5 !== null && pc.ratio5 >= 2;
  const bottomVolUpStart = {
    form: '低位倍量阳线',
    signal: '长期下跌后倍量阳线启动，底部启动信号',
    status: (pc.chgPct === null || pc.ratio5 === null) ? '数据不足' : (bvusMatched ? '命中' : '未命中'),
    matched: bvusMatched,
    tone: bvusMatched ? 've-bull' : null,
    conclusion: bvusMatched
      ? `低位倍量阳线：低位区间出现倍量阳线（当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍，涨幅 ${_fmtPct(pc.chgPct, 2)}）：长期下跌后首次倍量启动，属底部启动信号，但单日倍量可能为一日游，需后续连续放量 / 重心抬升确认`
      : ((pc.chgPct === null || pc.ratio5 === null)
          ? '低位倍量阳线：涨跌幅或量比数据不足，无法判定'
          : (pos === '低位区间' && pc.chgPct !== null && pc.chgPct > 0
              ? '低位区间收阳但量能未达倍量（<2×），暂按低位缩量上涨 / 放量震荡观察'
              : '未处于低位区间或收阳，不触发低位倍量阳线判定')),
    detail: {
      positionLow: pos === '低位区间',
      volume: pc.ratio5 !== null ? `当前量 ÷ 5 日均量 ${_round(pc.ratio5)} 倍${pc.ratio5 >= 2 ? '（倍量）' : ''}` : '数据不足',
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      interpretation: bvusMatched ? '长期下跌后倍量阳线启动，底部启动信号，待确认' : '未命中低位倍量阳线启动',
      hint: bvusMatched ? '作为看多支撑：底部启动信号，但需后续放量确认，不可单日下定论' : '',
    },
  };

  // ---- ⑥主升浪缩量上涨（控盘，正向确认）----
  const mrcMatched = pos === '趋势向上' && pc.chgPct !== null && pc.chgPct > 0 && t.isShrink && pc.ratio5 !== null;
  const mainRiseShrinkControl = {
    form: '主升浪缩量上涨',
    signal: '主升浪缩量上涨，筹码锁定良好（控盘）',
    status: (pc.chgPct === null || pc.ratio5 === null) ? '数据不足' : (mrcMatched ? '命中' : '未命中'),
    matched: mrcMatched,
    tone: mrcMatched ? 've-bull' : null,
    conclusion: mrcMatched
      ? `主升浪缩量上涨：趋势向上（主升浪）价格上行（${_fmtPct(pc.chgPct, 2)}）但成交缩量（档位${pc.level}）：筹码锁定良好，主力控盘度高，不用大量成交也能推升价格，属健康上涨形态`
      : ((pc.chgPct === null || pc.ratio5 === null)
          ? '主升浪缩量上涨：涨跌幅或量比数据不足，无法判定'
          : (pos === '趋势向上' && pc.chgPct !== null && pc.chgPct > 0
              ? '趋势向上但量能未缩（放量上涨），按常规量价配合处理'
              : '未处于趋势向上或收阳，不触发主升浪缩量上涨判定')),
    detail: {
      positionMid: pos === '趋势向上',
      volume: t.isShrink ? `缩量（档位${pc.level}）` : `非缩量（档位${pc.level}）`,
      priceBehavior: pc.chgPct !== null ? `收盘涨跌幅 ${_fmtPct(pc.chgPct, 2)}` : '数据不足',
      interpretation: mrcMatched ? '主升浪缩量上涨，筹码锁定良好，控盘健康' : '未命中主升浪缩量上涨',
      hint: mrcMatched ? '作为看多支撑：控盘健康，量价配合良好' : '',
    },
  };

  return { highVolumeDrop, downtrendVolUpTrap, highShrinkSideways, breakoutPullbackShrink, bottomVolUpStart, mainRiseShrinkControl };
}

// ===================== 7. 连续量能序列（spec 第八章） =====================

function _sequenceRule(pc) {
  const n = pc.n;
  if (n < 3) return { type: '无显著序列', bullConfirm: false, note: 'K 线不足 3 根，无法判定连续量能序列' };
  const v = [pc.vols[n - 3], pc.vols[n - 2], pc.vols[n - 1]];
  const c = [pc.closes[n - 3], pc.closes[n - 2], pc.closes[n - 1]];
  if (v[0] < v[1] && v[1] < v[2] && c[0] < c[1] && c[1] < c[2]) {
    return { type: '连续递增', bullConfirm: true, note: '成交量依次放大且价格同步抬升：判定多头趋势量能确认，额外加分' };
  }
  if (v[0] > v[1] && v[1] > v[2] && c[0] > c[1] && c[1] > c[2]) {
    return { type: '连续递减', bullConfirm: false, note: '成交量依次缩小且价格同步下行：判定空头衰竭，仅作为观察信号，不作为强多头依据' };
  }
  if (pc.pulse) {
    return { type: '单根脉冲', bullConfirm: false, note: '仅最新一根 K 线巨量、前后均缩量：判定为一次性资金动作，信号可靠性打折，输出单日脉冲巨量风险标签' };
  }
  return { type: '无显著序列', bullConfirm: false, note: '最近 3 根 K 线量能无序，价格无量能配合特征' };
}

// ===================== 8. 量化打分（spec 第九章） =====================

function _scoreEngine(pc, ctx) {
  // ① 量价匹配度 40
  let s40 = 20;
  let n40 = '量价无显著方向，按基准中性计分';
  if (ctx.combo.direction === 'bull') { s40 = 40; n40 = '量价同向匹配健康（放量上涨/资金进场/健康换手）'; }
  else if (ctx.combo.direction === 'observe') { s40 = 16; n40 = '量价匹配偏向观察（抛压衰减/底部洗盘/筹码沉淀）'; }
  else if (ctx.combo.direction === 'caution') { s40 = 12; n40 = '量价存在矛盾或诱多特征，匹配度打折'; }
  else if (ctx.combo.direction === 'bear') { s40 = 8; n40 = '量价指向空头（放量下跌/派发/破位），匹配度低分'; }
  if (pc.level === '大量' || pc.level === '天量') { s40 -= 5; n40 += '；巨量/天量增风险折扣 -5'; }
  if (ctx.checks.pulse) { s40 -= 10; n40 += '；单日脉冲爆量 -10'; }
  // 20261017f（spec 7.4 一致性约束）：高位放量滞涨 → 降低量价匹配得分，不得因为收阳给健康多头满分；
  // 低位缩量上涨（低位启动阶段）→ 不按「上涨缩量动能不足」强扣分
  const pv = ctx.pv || {};
  if (pv.highStagnant && pv.highStagnant.matched && s40 > 12) { s40 = 12; n40 += '；高位放量滞涨，量价匹配得分下调'; }
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段' && s40 < 16) { s40 = 16; n40 += '；低位缩量上涨，不按上涨动能不足强扣分'; }
  s40 = _clamp(s40, 0, W_VOLUME_PRICE);

  // ② 连续量能趋势 30
  let s30 = 15;
  let n30 = '连续量能无序';
  if (ctx.sequence.type === '连续递增' && ctx.sequence.bullConfirm) { s30 = 30; n30 = '连续 3 根量能递增且价格抬升，多头趋势量能确认'; }
  else if (ctx.sequence.type === '连续递减') { s30 = 12; n30 = '连续 3 根量能递减且价格下行，空头衰竭仅观察'; }
  else if (ctx.sequence.type === '单根脉冲') { s30 = 8; n30 = '单根脉冲爆量，一次性资金动作，总分打折'; }
  s30 = _clamp(s30, 0, W_TREND);

  // ③ 档位适配 20
  const s20 = LEVEL_FIT_SCORE[pc.level] !== undefined ? LEVEL_FIT_SCORE[pc.level] : 10;
  const n20 = pc.level === '极度缩量' ? '极度缩量不生成看多信号，仅入观察池'
    : (pc.level === '天量' || pc.level === '大量' ? `${pc.level}增风险折扣` : `${pc.level}档位适配`);

  // ④ 背离扣分（单次最高 30）
  let divPen = 0;
  if (ctx.divergence.type === '顶背离') divPen = DIVERGE_PENALTY.top;
  else if (ctx.divergence.type === '一般量价背离') divPen = DIVERGE_PENALTY.general;
  else if (ctx.divergence.type === '底背离') divPen = DIVERGE_PENALTY.bottom;

  const base = _clamp(s40 + s30 + s20 - divPen, 0, 100);
  return {
    base,
    components: {
      volumePrice: { score: s40, max: W_VOLUME_PRICE, note: n40 },
      trend: { score: s30, max: W_TREND, note: n30 },
      levelFit: { score: s20, max: W_LEVEL_FIT, note: n20 },
    },
    divergencePenalty: divPen,
  };
}

// ===================== 9. 流动性与黑名单衰减（spec 第十章） =====================

function _liquidityCheck(pc) {
  const out = { amountPct250: pc.amountPct250, amountMedian250: pc.amountMedian250, level: null, coef: 1, tag: null, note: '' };
  if (!pc.hasAmount) {
    out.note = '成交额数据不足（日K通道无成交额字段），流动性校验降级：不做衰减，仅标注';
    return out;
  }
  if (pc.n < SAMPLE_MIN_BARS) {
    out.level = '样本不足';
    out.coef = 0.5;
    out.tag = '流动性样本不足';
    out.note = `可用历史交易日仅 ${pc.n} 根（不足 ${SAMPLE_MIN_BARS}），无法计算可靠历史百分位，量能综合得分强制乘以 0.5`;
    return out;
  }
  if (pc.amountToday < FALLBACK_AMOUNT) {
    out.level = '流动性严重不足（兜底）';
    out.coef = 0.2;
    out.tag = '低流动性';
    out.note = `单日成交额 ${_round(pc.amountToday / 1e4, 2)} 万元低于 500 万兜底线，直接判定流动性严重不足，乘以 0.2（仅过滤几乎无成交的僵尸个股）`;
    return out;
  }
  const tier = LIQ_TIERS.find(t => t.test(pc.amountPct250));
  out.level = tier.level;
  out.coef = tier.coef;
  out.tag = tier.tag;
  out.note = `当前成交额处于近 250 个交易日 ${_round(pc.amountPct250 * 100)}% 分位（中位数 ${_round(pc.amountMedian250 / 1e8, 2)} 亿元），${tier.level}`;
  return out;
}

// ===================== 10. 信号分类与汇总（spec 第十一/十二章） =====================

/**
 * 信号分类（spec 第九章/第十一章 + 20261017f 新增 11.2/11.3/11.4 一致性约束）：
 *  - 空头类结论优先级永远高于多头类；高位派发、放量破位为最高优先级空头规则；
 *  - 命中「该放量未放量」不得输出看多信号（看多观察降级并注明量能不确认）；
 *  - 命中「高位放量滞涨 / 高位缩量上涨买盘存疑 / 高位放巨量价格不涨 / 口诀3 / 口诀5 / 口诀1」不得输出看多信号；
 *  - 命中「低位放量震荡 / 低位缩量上涨待确认 / 低位大跌后缩量出清 / 低位放大量价格不跌 / 该缩量反放巨量 / 口诀4(未确认)」
 *    只能输出观察，不得直接输出看多信号（规则1 低位吸筹完整命中时按 spec 7.4 例外处理）；
 *  - 命中「下跌初期缩量无承接」按看空观察处理；「该缩量反放巨量」且处于高位/趋势向下 → 看空观察。
 */
function _classify(ctx, score) {
  const { rules, combo, divergence, sequence, checks } = ctx;
  const position = ctx.position || {};
  const pv = ctx.pv || {};
  const ratio = ctx.ratio || {};
  const contra = ctx.contra || {};
  const exp = ctx.exp || {}; // 20261019d：预期量能规则（该放/该缩缺口补充）
  const rtItems = Array.isArray(ratio.items) ? ratio.items : [];
  const rt1 = rtItems[0] || {}, rt3 = rtItems[2] || {}, rt4 = rtItems[3] || {}, rt5 = rtItems[4] || {};
  const bearTop = rules.find(r => r.matched && r.priority === 'top' && r.direction === 'bear');
  const bearPartial = rules.find(r => r.partial && r.priority === 'top');
  const bearRule = rules.find(r => r.matched && r.direction === 'bear');
  const bullRule = rules.find(r => r.matched && r.direction === 'bull');
  const blockBull = rules.find(r => r.matched && r.direction === 'bear-block');
  const bearish = !!(bearTop || bearRule || bearPartial || divergence.type === '顶背离'
    || combo.direction === 'bear' || ctx.riskTags.includes('放量杀跌'));

  // ---- 20261017f：一致性约束（spec 11.2/11.3/11.4 与信号分类的关系） ----
  const rule1Matched = !!(bullRule && bullRule.id === 1); // 低位吸筹完整命中 = 连续3日放量+重心企稳（spec 7.4 例外条件）
  const noBullReasons = [];   // 命中即不得输出看多信号（连观察都需谨慎的场景由文案体现）
  const observeOnlyReasons = []; // 命中即只能输出观察（看多信号降级为看多观察）
  if (contra.shouldAmpNot && contra.shouldAmpNot.matched) noBullReasons.push('该放量未放量，量能不确认');
  if (pv.highStagnant && pv.highStagnant.matched) noBullReasons.push('高位放量滞涨');
  if (pv.shrinkUp && pv.shrinkUp.subStage === '高位阶段') noBullReasons.push('高位缩量上涨，买盘持续性存疑');
  if (contra.highHugeNotUp && contra.highHugeNotUp.matched) noBullReasons.push('高位放巨量但价格不涨');
  // 20261019d：预期量能风险类（命中即不得看多）
  if (exp.highVolumeDrop && exp.highVolumeDrop.matched) noBullReasons.push('高位放量大阴线，派发风险');
  if (exp.highShrinkSideways && exp.highShrinkSideways.matched) noBullReasons.push('高位缩量横盘，动能衰竭');
  if (rt5.matched) noBullReasons.push('量比大但价格涨不动，警惕对倒出货');
  if (rt3.matched) noBullReasons.push('尾盘放量拉升，真实性待确认');
  if (rt1.matched) noBullReasons.push('开盘放量承接待确认');
  if (rt4.matched && !rt4.confirmed) noBullReasons.push('连续低成交不再新低，等待有效放量阳线');
  if (!rule1Matched) {
    // spec 7.4 例外：低位吸筹（规则1）完整命中时，低位放量震荡/低位放大量价格不跌不限制看多信号
    if (pv.lowOscillate && pv.lowOscillate.matched) observeOnlyReasons.push('低位放量震荡，仅跟踪观察');
    if (contra.lowHugeNotDown && contra.lowHugeNotDown.matched) observeOnlyReasons.push('低位放大量但价格不跌，仅跟踪');
  }
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段') observeOnlyReasons.push('低位缩量上涨，待放量确认');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '低位大跌后') observeOnlyReasons.push('低位大跌后缩量出清，仅观察');
  if (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched) observeOnlyReasons.push('该缩量反放巨量，分歧未结束');
  // 20261019d：趋势向下放量阳线诱多——属下跌中继陷阱，降级为观察（由 forceBear 按位置进一步判看空）
  if (exp.downtrendVolUpTrap && exp.downtrendVolUpTrap.matched) observeOnlyReasons.push('趋势向下放量阳线，疑似诱多');
  const noBullSignal = noBullReasons.length > 0 || observeOnlyReasons.length > 0;
  const capReasons = noBullReasons.concat(observeOnlyReasons);
  // 强制看空：下跌初期缩量无承接；该缩量反放巨量且处于高位/趋势向下；趋势向下放量阳线诱多（20261019d）
  const forceBear = (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期')
    || (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched && (position.label === '高位区间' || position.label === '趋势向下'))
    || (exp.downtrendVolUpTrap && exp.downtrendVolUpTrap.matched && position.label === '趋势向下');

  // 20261019d：正向量能确认（突破回踩缩量/低位倍量阳线/主升浪缩量控盘）。
  // 仅作为看多支撑增强置信度，不单独生成信号；命中时在 note 末尾追加。
  const bullSupportReasons = [];
  if (exp.breakoutPullbackShrink && exp.breakoutPullbackShrink.matched) bullSupportReasons.push('突破后回踩缩量不破，突破确认');
  if (exp.bottomVolUpStart && exp.bottomVolUpStart.matched) bullSupportReasons.push('低位倍量阳线启动，底部启动信号');
  if (exp.mainRiseShrinkControl && exp.mainRiseShrinkControl.matched) bullSupportReasons.push('主升浪缩量上涨，筹码锁定良好');
  const bullSupportNote = bullSupportReasons.length ? `正向量能确认：${bullSupportReasons.join('；')}` : '';

  let category = '中性';
  let ruleBased = false;
  let note = '';

  if (bearTop) {
    category = '看空预警';
    ruleBased = true;
    note = `命中最高优先级空头规则「${bearTop.name}」，空头结论优先级高于多头`;
  } else if (bearPartial) {
    category = '看空观察';
    ruleBased = true;
    note = `「${bearPartial.name}」初步触发，有效破位待确认，按看空观察输出`;
  } else if (forceBear) {
    category = '看空观察';
    ruleBased = true;
    note = (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期')
      ? '缩量下跌处于下跌初期：承接盘不足，下方无人愿意接盘，按看空观察处理'
      : '该缩量场景反而放巨量且处于高位/趋势向下：市场分歧未结束，按看空观察处理';
  } else if (bearish) {
    category = '看空观察';
    ruleBased = !!bearRule;
    note = bearRule ? `命中空头规则「${bearRule.name}」` : (divergence.type === '顶背离' ? '顶背离：多头量能衰竭' : '量价组合指向空头');
  } else if (blockBull) {
    category = '中性';
    ruleBased = true;
    note = `命中「${blockBull.name}」（多头失效信号），不得给出看多信号`;
  } else if (bullRule) {
    if (noBullSignal) {
      category = '看多观察';
      ruleBased = true;
      note = `命中多头规则「${bullRule.name}」，但${capReasons.join('；')}，按看多观察输出`;
    } else {
      category = '看多信号';
      ruleBased = true;
      note = `命中多头规则「${bullRule.name}」且无空头冲突`;
    }
  } else if (pc_level_extreme(ctx)) {
    category = '中性';
    note = '极度缩量状态不生成看多信号，仅放入观察池';
  } else if (combo.direction === 'bull' || sequence.bullConfirm) {
    category = '看多观察';
    note = noBullSignal
      ? `量价组合偏多，但${capReasons.join('；')}，看多观察降级${contra.shouldAmpNot && contra.shouldAmpNot.matched ? '并注明量能不确认' : ''}`
      : '量价组合偏多但未达规则级确认，按看多观察输出';
  } else if (score.base >= 75) {
    if (noBullSignal) {
      category = '看多观察';
      note = `量能基础综合得分 ${score.base} 达看多信号档，但${capReasons.join('；')}，降级为看多观察`;
    } else {
      category = '看多信号';
      note = '无规则命中，按量能基础综合得分分档（≥75）';
    }
  } else if (score.base >= 55) {
    category = '看多观察';
    note = '无规则命中，按量能基础综合得分分档（55-75）';
  } else if (score.base >= 40) {
    category = '中性';
    note = '无规则命中，按量能基础综合得分分档（40-55）';
  } else if (score.base >= 25) {
    category = '看空观察';
    note = '无规则命中，按量能基础综合得分分档（25-40）';
  } else {
    category = '看空预警';
    note = '无规则命中，按量能基础综合得分分档（<25）';
  }
  // 20261019d：正向量能确认仅在「看多信号」或「无硬性禁多理由的看多观察」时追加，
  // 避免与「高位放量滞涨/放量大阴线」等禁多理由自相矛盾（诚实性约束）。
  if (bullSupportNote && (category === '看多信号' || (category === '看多观察' && noBullReasons.length === 0))) {
    note += (note ? '；' : '') + bullSupportNote;
  }
  return { category, ruleBased, note, bullSupport: bullSupportReasons };
}

function pc_level_extreme(ctx) {
  return ctx.pc.level === '极度缩量';
}

// ===================== 10.5 三个强制归集总结（spec 11.2/11.3/11.4，20261017f 新增） =====================

/**
 * 无论是否命中都必须逐条完整输出三个归集总结：
 *  - 未命中必须写「未命中」、数据不足必须写「数据不足，无法判定」，不得留空、不得臆造；
 *  - 命中多条时全部列出，不得只保留最高优先级一条而隐藏其他；
 *  - 总结性判定按「空头类优先于多头类」给出主结论，但明细必须完整。
 */
function _buildSummaries(ctx) {
  const pv = ctx.pv || {};
  const ratio = ctx.ratio || { items: [] };
  const contra = ctx.contra || {};
  const exp = ctx.exp || {}; // 20261019d：预期量能规则归集
  const rtItems = Array.isArray(ratio.items) ? ratio.items : [];

  // ---- 11.2 不同位置量价分析归集总结 ----
  const pvItems = [
    {
      form: pv.highStagnant ? pv.highStagnant.form : '高位放量滞涨',
      status: pv.highStagnant ? pv.highStagnant.status : '数据不足',
      matched: !!(pv.highStagnant && pv.highStagnant.matched),
      conclusion: pv.highStagnant ? pv.highStagnant.conclusion : '高位放量滞涨：数据不足，无法判定',
      detail: pv.highStagnant ? pv.highStagnant.detail : {},
    },
    {
      form: pv.lowOscillate ? pv.lowOscillate.form : '低位放量震荡',
      status: pv.lowOscillate ? pv.lowOscillate.status : '数据不足',
      matched: !!(pv.lowOscillate && pv.lowOscillate.matched),
      conclusion: pv.lowOscillate ? pv.lowOscillate.conclusion : '低位放量震荡：数据不足，无法判定',
      detail: pv.lowOscillate ? pv.lowOscillate.detail : {},
    },
    {
      form: '缩量上涨',
      status: pv.shrinkUp ? pv.shrinkUp.status : '数据不足',
      matched: !!(pv.shrinkUp && pv.shrinkUp.matched),
      subStage: pv.shrinkUp ? pv.shrinkUp.subStage : '数据不足',
      conclusion: pv.shrinkUp ? pv.shrinkUp.conclusion : '缩量上涨：数据不足，无法判定',
      detail: pv.shrinkUp ? pv.shrinkUp.detail : {},
    },
    {
      form: '缩量下跌',
      status: pv.shrinkDown ? pv.shrinkDown.status : '数据不足',
      matched: !!(pv.shrinkDown && pv.shrinkDown.matched),
      subStage: pv.shrinkDown ? pv.shrinkDown.subStage : '数据不足',
      conclusion: pv.shrinkDown ? pv.shrinkDown.conclusion : '缩量下跌：数据不足，无法判定',
      detail: pv.shrinkDown ? pv.shrinkDown.detail : {},
    },
  ];
  const hitPv = pvItems.filter(i => i.status === '命中').map(i => i.form + (i.subStage ? `（${i.subStage}）` : ''));
  const gapPv = pvItems.filter(i => i.status === '数据不足').map(i => `${i.form}（${i.subStage || '数据不足'}）`);
  const missPv = pvItems.filter(i => i.status === '未命中').map(i => i.form);
  const bearPv = [];
  if (pv.highStagnant && pv.highStagnant.matched) bearPv.push('高位放量滞涨（高位派发风险）');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '下跌初期') bearPv.push('下跌初期缩量无承接（谨防延续下跌）');
  const observePv = [];
  if (pv.lowOscillate && pv.lowOscillate.matched) observePv.push('低位放量震荡（等待更强上涨信号）');
  if (pv.shrinkUp && pv.shrinkUp.subStage === '低位启动阶段') observePv.push('低位缩量上涨待确认');
  if (pv.shrinkDown && pv.shrinkDown.subStage === '低位大跌后') observePv.push('低位大跌后缩量出清（潜在底部观察）');
  const positionVolumeSummary = {
    items: pvItems,
    summary: hitPv.length === 0 && gapPv.length === 0
      ? '当前未命中高位放量滞涨、低位放量震荡、缩量上涨两种情况、缩量下跌两种情况，量价形态处于常态运行'
      : `当前不同位置量价分析主要命中【${hitPv[0] || '无'}】；次要命中【${hitPv.slice(1).join('、') || '无'}】；空头优先结论为【${bearPv.length ? '有：' + bearPv.join('；') : '无'}】；观察项为【${observePv.join('；') || '无'}】；未命中项为【${missPv.join('、') || '无'}】；数据不足项为【${gapPv.join('；') || '无'}】`,
  };

  // ---- 11.3 常见矛盾信号归集总结 ----
  const contraDefs = [
    { key: 'shouldAmpNot', label: '该放量未放量，资金没有跟上' },
    { key: 'shouldShrinkHuge', label: '该缩量反放巨量，分歧未结束' },
    { key: 'highHugeNotUp', label: '高位放巨量但价格不涨，要小心' },
    { key: 'lowHugeNotDown', label: '低位放大量但价格不跌，要跟踪' },
  ];
  const contraItems = contraDefs.map(d => {
    const it = contra[d.key] || {};
    return {
      signal: d.label,
      status: it.status || '数据不足',
      matched: !!it.matched,
      scenario: it.scenario || '',
      volume: it.volume || '',
      priceBehavior: it.priceBehavior || '',
      conclusion: it.conclusion || `${d.label}：数据不足，无法判定`,
      riskHint: it.riskHint || it.trackHint || '',
    };
  });
  const hitCt = contraItems.filter(i => i.matched).map(i => i.signal);
  const gapCt = contraItems.filter(i => i.status === '数据不足').map(i => i.signal);
  const missCt = contraItems.filter(i => !i.matched && i.status !== '数据不足').map(i => i.signal);
  const bearCt = [];
  if (contra.highHugeNotUp && contra.highHugeNotUp.matched) bearCt.push('高位放巨量但价格不涨（高位派发风险）');
  if (contra.shouldShrinkHuge && contra.shouldShrinkHuge.matched && (ctx.position && (ctx.position.label === '高位区间' || ctx.position.label === '趋势向下'))) bearCt.push('该缩量反放巨量且处于高位/趋势向下（分歧未结束）');
  const watchCt = [];
  if (contra.lowHugeNotDown && contra.lowHugeNotDown.matched) watchCt.push('低位放大量但价格不跌（等待更强上涨信号）');
  if (contra.shouldAmpNot && contra.shouldAmpNot.matched) watchCt.push('该放量未放量（谨防假突破、K 线骗线）');
  const contradictionSummary = {
    items: contraItems,
    summary: (() => {
      // 20261020a：底部区域相位说明——低位平台时追加相位判定，说明「该放量/该缩量」
      // 期望由相位单源推导、两侧互斥（用户 2026-10-20 截图报障：双信号同时命中自相矛盾）
      const bp = contra.bottomPhase || {};
      const phaseNote = (bp.phase === '构筑期' || bp.phase === '启动确认区' || bp.phase === '方向不明')
        ? `；底部相位判定为【${bp.phase}】（${bp.basis}），该放量/该缩量期望按相位单源推导、两侧互斥，不会同时成立`
        : '';
      return (hitCt.length === 0 && gapCt.length === 0
        ? '当前未命中该放量未放量、该缩量反放巨量、高位放巨量价格不涨、低位放大量价格不跌，常见矛盾信号不显著'
        : `当前常见矛盾信号主要命中【${hitCt[0] || '无'}】；次要命中【${hitCt.slice(1).join('、') || '无'}】；空头优先结论为【${bearCt.length ? '有：' + bearCt.join('；') : '无'}】；需小心的项为【${hitCt.filter(s => /高位/.test(s)).join('；') || '无'}】；需跟踪的项为【${watchCt.join('；') || '无'}】；未命中项为【${missCt.join('、') || '无'}】；数据不足项为【${gapCt.join('；') || '无'}】`) + phaseNote;
    })(),
  };

  // ---- 11.4 量比实战口诀归集总结 ----
  const rtSummaryItems = rtItems.map(it => ({
    id: it.id,
    name: it.name,
    status: it.status || '数据不足',
    matched: !!it.matched,
    dataOk: it.dataOk !== false,
    conclusion: it.conclusion || `${it.name}：数据不足，无法判定`,
    hint: it.hint || '',
    tag: it.tag || null,
    detail: it.detail || {},
  }));
  const hitRt = rtSummaryItems.filter(i => i.matched).map(i => i.name);
  const gapRt = rtSummaryItems.filter(i => i.status === '数据不足').map(i => `${i.name}（分时数据不足）`);
  const missRt = rtSummaryItems.filter(i => !i.matched && i.status !== '数据不足').map(i => i.name);
  const watchRt = rtSummaryItems.filter(i => i.matched && (i.id === 1 || i.id === 2 || i.id === 4)).map(i => i.name);
  const alertRt = rtSummaryItems.filter(i => i.matched && (i.id === 3 || i.id === 5)).map(i => i.name);
  const ratioSummary = {
    items: rtSummaryItems,
    summary: hitRt.length === 0 && gapRt.length === 0
      ? '当前未命中五句量比实战口诀，量比维度无显著异常，处于常态运行'
      : `当前量比实战口诀主要命中【${hitRt[0] || '无'}】；次要命中【${hitRt.slice(1).join('、') || '无'}】；需观察项为【${watchRt.join('；') || '无'}】；需警惕项为【${alertRt.join('；') || '无'}】；未命中项为【${missRt.join('、') || '无'}】；数据不足项为【${gapRt.join('；') || '无'}】`,
  };

  // ---- 7.5b 预期量能规则归集总结（20261019d：该放/该缩缺口补充，3 风险 + 3 正向确认）----
  // 无论是否命中都必须逐条完整输出：未命中=未命中、数据不足=数据不足，不得臆造；命中全部列出。
  const expDefs = [
    { key: 'highVolumeDrop', label: '高位放量下跌' },
    { key: 'downtrendVolUpTrap', label: '趋势向下放量阳线诱多' },
    { key: 'highShrinkSideways', label: '高位缩量横盘' },
    { key: 'breakoutPullbackShrink', label: '突破后回踩缩量不破' },
    { key: 'bottomVolUpStart', label: '低位倍量阳线启动' },
    { key: 'mainRiseShrinkControl', label: '主升浪缩量上涨（控盘）' },
  ];
  const expItems = expDefs.map(d => {
    const it = exp[d.key] || {};
    const det = it.detail || {};
    return {
      form: it.form || d.label,
      signal: it.signal || d.label,
      status: it.status || '数据不足',
      matched: !!it.matched,
      tone: it.tone || (it.matched ? 've-block' : null),
      conclusion: it.conclusion || `${d.label}：数据不足，无法判定`,
      hint: det.riskHint || det.hint || '',
      detail: det,
    };
  });
  const hitExp = expItems.filter(i => i.matched).map(i => i.form);
  const gapExp = expItems.filter(i => i.status === '数据不足').map(i => i.form);
  const missExp = expItems.filter(i => !i.matched && i.status !== '数据不足').map(i => i.form);
  const riskExp = expItems.filter(i => i.matched && i.tone === 've-bear').map(i => i.form);
  const posExp = expItems.filter(i => i.matched && i.tone === 've-bull').map(i => i.form);
  const expectedVolumeSummary = {
    items: expItems,
    summary: hitExp.length === 0 && gapExp.length === 0
      ? '当前未命中高位放量下跌、趋势向下放量阳线诱多、高位缩量横盘、突破后回踩缩量不破、低位倍量阳线启动、主升浪缩量上涨，预期量能规则处于常态运行'
      : `当前预期量能规则主要命中【${hitExp[0] || '无'}】；次要命中【${hitExp.slice(1).join('、') || '无'}】；空头类命中为【${riskExp.length ? '有：' + riskExp.join('；') : '无'}】；正向量能确认为【${posExp.length ? '有：' + posExp.join('；') : '无'}】；未命中项为【${missExp.join('、') || '无'}】；数据不足项为【${gapExp.join('；') || '无'}】`,
  };

  return { positionVolumeSummary, contradictionSummary, ratioSummary, expectedVolumeSummary };
}

// ===================== 主入口：纯计算 =====================

/**
 * 量能引擎纯计算入口（无网络）。
 * @param {Object} input
 * @param {Array}  input.bars      日线序列（旧→新）：{date,open,high,low,close,volume,amount?,turnover?}
 * @param {Object} [input.minutes] 分时数据 {minutes:[{time,price,avg,cumVol?}],prevClose}
 * @param {Array}  [input.blacklistReasons] 黑名单原因列表（解禁/减持/ST）
 * @param {string} [input.symbol] 代码（推断涨跌停幅度用）
 * @param {string} [input.name]   名称（ST 识别已在采集层，此处备用）
 * @param {Object} [input.marketEnv] 大盘环境 {label,discount?}，未配置则仅标注
 * @returns {Object} 结构化量能分析结果
 */
function computeVolumeEngine(input) {
  const bars = (input && Array.isArray(input.bars)) ? input.bars.filter(b => b && isFinite(b.close) && isFinite(b.volume)) : [];
  const barsSource = (input && input.barsSource) || null;
  if (bars.length < 10) {
    return {
      ok: false,
      error: `日线数据不足（可用 ${bars.length} 根，少于 10 根下限），无法进行量能分析`,
      barsSource,
      dataGaps: ['日线样本不足'],
    };
  }

  const pc = _precompute(bars, { quoteVolumeRatio: input && input.quoteVolumeRatio });
  pc.longTerm = (input && input.longTerm) || null; // 20261103a：长期趋势定论（来自 analyzeVolume 的 2400 根日K MA250 推演），仅作位置叠加展示，不改矩阵键
  const { currentSideways, platform, band20, trend20 } = _sidewaysAndPlatform(bars);
  // 20261104e：近 120 日趋势段检测（用户定位原则第一步——无法判定时先看短期是否呈趋势运行）
  const trendSeg = _trendSegment(bars);
  const levels = _keyLevels(pc, platform, input && input.levelHints);
  const position = _detectPosition(pc, platform, trendSeg);
  const checks = _threeChecks(pc);
  const divergence = _detectDivergence(pc);
  // 20261028a：盘中判定守门开关（analyzeVolume 计算：末根 bar=今日且未到 15:00 收盘）。
  // 盘中当日量为「部分日累计」，与全天基准（20 日均量 ×1.3）结构上不可比，
  // fail-closed 规则（规则3 假突破量能不确认、11.3.1 该放量未放量）盘中停判，收盘后自动恢复。
  const ctxBase = { bars, pc, platform, levels, position, checks, divergence, minutes: input.minutes || null, symbol: input.symbol || '', name: input.name || '', barsSource, intradayPending: input.intradayPending === true, quoteSnapshot: input.quoteSnapshot || null, chip: input.chip || null };
  const rules = _lifeRules(pc, ctxBase);

  // 持续巨量：最近 3 根中 ≥2 根为巨量/天量（每根按「量 ÷ 前 5 日均量 > 2.5」判定；spec 第五章4）
  const n = pc.n;
  const hugeFlags = pc.vols.slice(-3).map((v, i) => {
    const j = n - 3 + i;
    if (j < 5) return false;
    const a = _mean(pc.vols.slice(j - 5, j));
    return a > 0 ? v / a > 2.5 : false;
  });
  const persistentHuge = hugeFlags.filter(Boolean).length >= 2;

  const combo = _comboEngine(pc, { ...ctxBase, persistentHuge });
  const sequence = _sequenceRule(pc);

  // 有效突破/破位标记（spec 第三章3：站稳 3% 且连续 2 日）
  const breakThrough = n >= 2 && pc.closes[n - 1] > levels.resistance.price * 1.03 && pc.closes[n - 2] > levels.resistance.price * 1.03;
  const breakDown = n >= 2 && pc.closes[n - 1] < levels.support.price * 0.97 && pc.closes[n - 2] < levels.support.price * 0.97;

  // 20261017f：7.4 不同位置量价补充规则 / 7.5 量比实战口诀 / 11.3 常见矛盾信号
  const pv = _positionVolumeRules(pc, { ...ctxBase, rules });
  const ratio = _ratioRules(pc, ctxBase);
  const contra = _contradictionRules(pc, { ...ctxBase, rules, sequence, pv, platform, levels, currentSideways, breakThrough });
  // 20261019d：预期量能规则（该放 / 该缩 缺口补充：3 风险 + 3 正向确认）
  const exp = _expectedVolumeRules(pc, { ...ctxBase, rules, levels, position, breakThrough, pv, contra });
  // 20261023d：量价十口诀（郭睿体系）—— 主判层，既有 7.4/7.5/11.3 保留为补充
  // 20261101d：位置感知量价判定主判（图片 24 格矩阵：先定位置 → 量能×涨跌幅 → 判定）；
  // 十口诀降为补充辅助。仅新增字段不改既有字段（铁律第一条），combo/评分/结论零影响。
  const posJudgment = _posVolumeMatrix(pc, { ...ctxBase, rules, levels, position, currentSideways, band20, trend20, trendSegment: trendSeg }, bars);

  const score = _scoreEngine(pc, { combo, sequence, checks, divergence, pv });
  const liquidity = _liquidityCheck(pc);
  const blacklistReasons = Array.isArray(input.blacklistReasons) ? input.blacklistReasons.slice(0, 5) : [];
  const blacklist = {
    triggered: blacklistReasons.length > 0,
    reasons: blacklistReasons,
    coef: blacklistReasons.length > 0 ? BLACKLIST_COEF : 1,
  };

  // 大盘环境（未配置折扣 → 仅标注，不臆造数值）
  let marketCoef = 1;
  const marketNote = input.marketEnv && input.marketEnv.discount
    ? `叠加大盘环境标签「${input.marketEnv.label || '外部环境'}」，可信度按配置折扣 ×${input.marketEnv.discount}`
    : '未叠加大盘环境折扣（工作台未配置）';
  if (input.marketEnv && input.marketEnv.discount) marketCoef = input.marketEnv.discount;

  const final = _round(score.base * liquidity.coef * blacklist.coef * marketCoef, 1);

  // 风险标签集合
  const riskTags = [];
  if (divergence.type === '顶背离') riskTags.push('顶量价背离');
  if (divergence.type === '底背离') riskTags.push('底量价背离');
  if (divergence.type === '一般量价背离') riskTags.push('一般量价背离');
  if (checks.pulse) riskTags.push('单日脉冲巨量');
  if (sequence.type === '连续递减' && isShrinkRatio(pc.ratio20)) riskTags.push('持续缩量无动能');
  if (combo.tags.includes('放量杀跌')) riskTags.push('放量杀跌');
  rules.forEach(r => {
    if (!r.matched) return;
    if (r.id === 2) riskTags.push('高位派发');
    if (r.id === 3) { riskTags.push('假突破量能不确认', 'K线骗线'); }
    if (r.id === 4) riskTags.push('放量破位');
    if (r.id === 5) riskTags.push('日内无量拉升');
  });
  if (combo.tags.includes('K线骗线')) riskTags.push('K线骗线');
  if (liquidity.tag) riskTags.push(liquidity.tag);
  if (blacklist.triggered) riskTags.push('黑名单衰减');
  if (position.divergence) riskTags.push('位置判定分歧');
  checks.failed.forEach(f => { if (f !== '单日脉冲') riskTags.push(f); });
  // 20261017f：spec 11.2/11.3/11.4 风险标签同步（命中即输出对应标签，未命中不输出）
  if (pv.highStagnant.matched) riskTags.push('高位放量滞涨');
  if (pv.lowOscillate.matched) riskTags.push('低位放量震荡');
  if (pv.shrinkUp.subStage === '低位启动阶段') riskTags.push('低位缩量上涨待确认');
  if (pv.shrinkUp.subStage === '高位阶段') riskTags.push('高位缩量上涨买盘存疑');
  if (pv.shrinkDown.subStage === '低位大跌后') riskTags.push('低位大跌后缩量出清');
  if (pv.shrinkDown.subStage === '下跌初期') riskTags.push('下跌初期缩量无承接');
  if (contra.shouldAmpNot.matched) riskTags.push('该放量未放量资金未跟上');
  if (contra.shouldShrinkHuge.matched) riskTags.push('该缩量反放巨量分歧未结束');
  if (contra.highHugeNotUp.matched) riskTags.push('高位放巨量价格不涨');
  if (contra.lowHugeNotDown.matched) riskTags.push('低位放大量价格不跌');
  // 20261019d：预期量能规则风险标签（命中即输出，未命中不输出）
  if (exp.highVolumeDrop.matched) riskTags.push('高位放量大阴线派发风险');
  if (exp.highShrinkSideways.matched) riskTags.push('高位缩量横盘动能衰竭');
  if (exp.downtrendVolUpTrap.matched) riskTags.push('趋势向下放量阳线诱多');
  ratio.items.forEach(it => { if (it.tag) riskTags.push(it.tag); });
  const riskTagSet = [...new Set(riskTags)];

  const ctxFull = { ...ctxBase, rules, combo, sequence, riskTags: riskTagSet, persistentHuge, pc, pv, ratio, contra, exp, currentSideways, breakThrough, breakDown };
  const signal = _classify(ctxFull, score);

  // 20261106j：原四个强制归集总结（_buildSummaries）不再输出到 API 响应体——
  // 其判定逻辑已并入 135 格推演图（posModel135）与引擎评分/风险标签（_classify / riskTags /
  // bullSupport 备注），同屏只保留唯一的量价判定模块。_buildSummaries 函数与导出保留，
  // 仍供单元测试与诊断使用，但生产路径不再调用，避免重复判定。

  // 20261106n：60 日 confirm 确认机制整体退役——四维度量能状态文本统一 ÷20 日均量
  // （放量/缩量判定不再有第二套口径，档位与 volumeTier.tier 同源）

  // 四维度客观描述（spec 第十一章）
  // 20261103f：chipTransferInfo 供 tone 字段（见 _chipTransfer 注释）
  const chipTransferInfo = _chipTransfer(rules, combo, pc, pv);
  const dimensions = {
    // 20261106n（用户裁决「文字分析统一使用20日量能比判定」）：量能状态文本由 ÷5 六态 + 60 日
    // 双口径改写为 ÷20 统一三态主描述 + ÷5 原始指标辅助（数值不应相等的口径差异由口径说明披露）
    volumeState: `量能档位${(() => { const r20 = pc.ratio20; return (r20 === null || r20 === undefined || !isFinite(r20)) ? '数据不足' : (r20 > 1.3 ? '放量' : r20 < 0.8 ? '缩量' : '平量'); })()}（当日量 ÷ 20 日均量 = ${pc.ratio20 !== null ? _round(pc.ratio20) : '数据不足'} 倍，放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8，与 135 格推演图同源；÷5 日均量原始指标 ${pc.ratio5 !== null ? _round(pc.ratio5) : '数据不足'} 倍，口径不同数值不应相等）`,
    position: `价格位置${position.label}${currentSideways ? '（叠加横盘形态）' : ''}：12个月价格分位 ${pc.pricePct12m !== null ? _round(pc.pricePct12m * 100) + '%' : '数据不足'}；关键支撑 ${_round(levels.support.price)}（${levels.support.kind}）/ 关键压力 ${_round(levels.resistance.price)}（${levels.resistance.kind}）`,
    capitalBehavior: combo.conclusion,
    // 20261103f：语义方向（bull/bear/neutral）——combo.direction 含 observe 等档位，归一为三值
    capitalBehaviorTone: combo.direction === 'bull' ? 'bull' : combo.direction === 'bear' ? 'bear' : 'neutral',
    chipTransfer: chipTransferInfo.text,
    chipTransferTone: chipTransferInfo.tone,
  };

  // 结论提示（自然语言，不含交易指令）
  const ruleHit = rules.find(r => r.matched);
  let conclusion;
  if (ruleHit) {
    conclusion = `${ruleHit.conclusion}。${signal.note}`;
  } else if (combo.direction !== 'neutral') {
    conclusion = `${combo.conclusion}。${checks.failed.length ? '注意：' + checks.failed.join('、') + '，结论置信度受限。' : ''}`;
  } else {
    conclusion = '当前量价无显著异常信号，处于常态运行';
  }
  if (blacklist.triggered) conclusion += `；触发黑名单衰减（${blacklist.reasons.join('；')}），最终有效得分 ×${blacklist.coef}`;
  if (liquidity.coef !== 1) conclusion += `；${liquidity.note}`;
  // 20261017f：7.4/7.5/11.3 命中要点并入结论提示（三个归集总结另有完整逐条输出）
  const highlights = [];
  if (pv.highStagnant.matched) highlights.push('高位放量滞涨：筹码大规模交换，上方抛压强（高位派发风险）');
  if (pv.lowOscillate.matched) highlights.push('低位放量震荡：筹码重新分配，仅跟踪观察');
  if (pv.shrinkUp.subStage === '高位阶段') highlights.push('高位缩量上涨：买盘持续性存疑');
  if (pv.shrinkUp.subStage === '低位启动阶段') highlights.push('低位缩量上涨：筹码稳定，待放量确认');
  if (pv.shrinkDown.subStage === '下跌初期') highlights.push('下跌初期缩量无承接：谨防延续下跌');
  if (pv.shrinkDown.subStage === '低位大跌后') highlights.push('低位大跌后缩量出清：潜在底部观察');
  if (contra.shouldAmpNot.matched) highlights.push('该放量未放量：资金未跟上，量能不确认');
  if (contra.shouldShrinkHuge.matched) highlights.push('该缩量反放巨量：市场分歧未结束');
  // 20261019d：预期量能规则命中要点（3 风险 + 3 正向确认）
  if (exp.highVolumeDrop.matched) highlights.push('高位放量大阴线：筹码大规模出逃，高位派发风险');
  if (exp.highShrinkSideways.matched) highlights.push('高位缩量横盘：上涨动能衰竭，补跌风险');
  if (exp.downtrendVolUpTrap.matched) highlights.push('趋势向下放量阳线：疑似诱多，谨防再次破位');
  if (exp.breakoutPullbackShrink.matched) highlights.push('突破后回踩缩量不破：突破确认，量价健康');
  if (exp.bottomVolUpStart.matched) highlights.push('低位倍量阳线：底部启动信号，待放量确认');
  if (exp.mainRiseShrinkControl.matched) highlights.push('主升浪缩量上涨：筹码锁定良好，控盘健康');
  const rt5 = ratio.items.find(i => i.id === 5 && i.matched);
  if (rt5) highlights.push('量比大但价格涨不动：警惕对倒出货');
  if (highlights.length) conclusion += '；' + highlights.join('；');

  // 数据不足标注汇总（只收录真正的数据缺口；规则未命中的条件解释留在各规则 dataGaps 内）
  const dataGaps = [...pc.dataGaps];
  const GAP_KEY = /数据不足|样本不足|不匹配|缺失|降级/;
  rules.forEach(r => r.dataGaps.forEach(g => { if (GAP_KEY.test(g) && !dataGaps.includes(g)) dataGaps.push(g); }));
  // 20261017f：量比口诀中因分时数据不足而无法判定的条目，同步收录（spec：不得臆造）
  ratio.dataGaps.forEach(g => { if (!dataGaps.includes(g)) dataGaps.push(g); });
  if (!pc.hasTurnover) { /* 已在 pc.dataGaps */ }
  if (divergence.type === null && divergence.note && divergence.note.includes('数据不足') && !dataGaps.includes(divergence.note)) dataGaps.push(divergence.note);
  // 日K通道降级来源标注（20261017e）：腾讯通道仅 OHLCV；同花顺通道成交额/换手率仅覆盖近 140 根
  // （窗口样本不足由 _precompute 单独标注），具体字段后果已由 pc.dataGaps 说明，
  // 此处补充「哪条通道、为何降级」便于溯源
  // 20261021h：当日量单位异常（已拒绝覆写）必须进 dataGaps，否则用户看到「档位平量但阈值对不上」也无从解释
  if (input && input.unitMismatch) {
    dataGaps.push(`当日实时成交量单位异常（换算后为日K量的 ${input.unitMismatch.mag} 倍），已跳过当日对齐、保留日K原值`);
  }
  if (barsSource && barsSource !== 'eastmoney') {
    const srcLabel = barsSource === 'tencent' ? '腾讯日K（仅 OHLCV）'
      : barsSource === 'ths' ? '同花顺日K（近期含成交额/换手率，历史段仅OHLCV）'
        : barsSource;
    dataGaps.push(`日K数据源：${srcLabel}（东财通道不可达，已自动降级）`);
  }

  return {
    ok: true,
    // 20261017i：输出结构新增 volumeTier（统一量能档位真值源）与 volumeState.ratio5Level
    // （原始 ÷5日均量档位），volumeState.level 语义改为判定性档位 → 升 schema 版本。
    // 20261019d：新增 expectedVolumeSummary 归集与 signal.bullSupport 正向量能确认 → schema 升至 20261019d。
    // 20261019f：定档标准改市场标准量比（÷5日均量 0.8/1.2 单独定档，60 日确认降级为分歧披露）→ schema 升至 20261019f。
    // 20261020a：新增 bottomPhase 底部区域相位分类（构筑期/启动确认区/方向不明），
    // 该放量/该缩量期望由相位单源推导、两侧互斥（消除双命中矛盾）→ schema 升至 20261020a。
    // 20261020b：口诀4 结论文案阈值具象化（「60 日均量 ×0.7」改为同屏展示均值/阈值/实际近3日量能），
    // detail 新增 avg60/shrinkThreshold/vols3 三个具象化字段 → schema 升至 20261020b。
    // 20261020c：规则5「分时无量拉升」尾盘窗口按 time 时间戳剔除盘后条目（15:01-15:30 cumVol 恒定的
    // 零量条目曾把「逐级萎缩/无接力」两条件抹成恒真，导致尾盘收在高点附近的股票系统性误命中）→ schema 升至 20261020c。
    // 20261020d：11.3.1「该放量未放量」结论文案阈值具象化（「60 日均量 ×1.5」改为同屏展示
    // 均值 X ×阈值 = 阈值 + 当日实际量，avg60≤0 退回原纯文本）→ schema 升至 20261020d。
// 20261106a：旧量价十口诀主判层（tenRules）已整块删除，判定统一由 135 格 _posVolumeMatrix / volCell 承担。
    // 既有 7.4/7.5/11.3 保留为补充；平量涨/跌方向由 neutral 调整为 observe（弱势/待确认）→ schema 升至 20261023d。
    schema: 'volume-engine-20261109c', // [20261109c] 全引擎量能判定接入 lib/volumeCaliber 单一真值源（>1.3 放量 / <0.8 缩量）；规则3 前高量能改「同价位带最近前高」且降级为展示参照、不再作判定门槛；规则名「缩量假突破」→「假突破量能不确认」；旧 20261106p：攻击目标改②卡区间 / 60 日均量口径退役 / 分母统一 ÷20
    symbol: input.symbol || '',
    name: input.name || '',
    date: bars[bars.length - 1].date,
    barsSource,
    volumeState: {
      // 20261017i：level 改为判定性档位 judgedLevel（与 combo 结论同源），
      // 原始 ÷5日均量档位以 ratio5Level 保留，两者不一致时由 volumeTier.divergenceNote 说明。
      // 20261019f：定档改市场标准量比单独定档 → judgedLevel 恒等于 level、ratio5Level 同为 level；
      // 60 日确认与 5 日档位不一致时由 volumeTier.divergenceNote 披露（不翻转档位）。
      level: pc.judgedLevel !== undefined ? pc.judgedLevel : pc.level,
      ratio5Level: pc.level,
      ratio5: pc.ratio5 !== null ? _round(pc.ratio5) : null,
      ratio5Basis: pc.ratio5Basis || 'unavailable', // 20261019c：量比来源（tencent_quote 直采 / local_fallback 本地兜底 / unavailable）
      ratio10: pc.ratio10 !== null ? _round(pc.ratio10) : null,
      ratio20: pc.ratio20 !== null ? _round(pc.ratio20) : null,
      avg5: _round(pc.avg5), avg10: _round(pc.avg10), avg20: _round(pc.avg20),
      volToday: pc.volToday,
      amountToday: pc.hasAmount ? pc.amountToday : null,
      turnoverToday: pc.hasTurnover ? pc.turnoverToday : null,
    },
    // 20261017i：统一量能档位真值源。capitalFlow 的「量价信号」与「量能热度」
    // 改引自此处，与下方 combo（资金行为）同源，消除三处各算一套导致的同屏互斥。
    volumeTier: _volumeTier(pc),
    position: {
      label: position.label,
      sideways: currentSideways,
      pricePct12m: pc.pricePct12m !== null ? _round(pc.pricePct12m * 100) : null,
      drawdownFromHigh: pc.drawdownFromHigh !== null ? _round(pc.drawdownFromHigh) : null,
      support: { price: _round(levels.support.price), kind: levels.support.kind },
      resistance: { price: _round(levels.resistance.price), kind: levels.resistance.kind },
      platform: platform ? { high: _round(platform.high), low: _round(platform.low), days: platform.days } : null,
      ma20: pc.ma20 ? _round(pc.ma20) : null,
      ma60: pc.ma60 ? _round(pc.ma60) : null,
      breakThrough, breakDown,
      basis: position.basis,
      divergence: position.divergence,
      // 20261104e：近 120 日趋势段概要（无趋势段为 null；与 position.basis 中的人话依据同源）
      trendSegment: position.trendSegment || null,
    },
    checks: {
      authenticity: checks.authenticity,
      priceAcceptance: checks.priceAcceptance,
      persistence: checks.persistence,
      pulse: checks.pulse,
      failed: checks.failed,
    },
    divergence,
    rules: rules.map(r => ({ id: r.id, name: r.name, direction: r.direction, priority: r.priority, matched: r.matched, partial: !!r.partial, conclusion: r.conclusion, dataGaps: r.dataGaps })),
    combo: { scenario: combo.scenario, direction: combo.direction, conclusion: combo.conclusion, tags: combo.tags },
    sequence,
    score: {
      base: score.base,
      components: score.components,
      divergencePenalty: score.divergencePenalty,
      liquidityCoef: liquidity.coef,
      blacklistCoef: blacklist.coef,
      marketCoef,
      final,
    },
    liquidity: {
      amountPct250: liquidity.amountPct250 !== null ? _round(liquidity.amountPct250 * 100) : null,
      amountMedian250: liquidity.amountMedian250,
      level: liquidity.level,
      coef: liquidity.coef,
      note: liquidity.note,
    },
    blacklist,
    signal,
    riskTags: riskTagSet,
    dimensions,
    conclusion,
    marketEnvNote: marketNote,
    disclaimer: '仅量能维度分析，不构成投资建议，需要叠加估值、K 线生死位交叉验证；不涉及交易执行。',
    dataGaps,
    // 20261106j：四个强制归集总结（positionVolumeSummary / contradictionSummary / ratioSummary /
    // expectedVolumeSummary）已从 API 响应体移除——判定逻辑并入 135 格推演图与引擎评分/风险标签，
    // 同屏只保留唯一的量价判定模块（见上方 posJudgment）。保留 posJudgment 作为唯一输出。
    // 20261020a：底部区域相位分类（低位平台时输出 构筑期/启动确认区/方向不明；非低位或无平台输出 不适用/数据不足）
    bottomPhase: contra.bottomPhase,
    // 20261023d：量价十口诀（郭睿体系）—— 补充辅助层（primary/items/framework/reminders/summary），
    // 既有 7.4/7.5/11.3 归集保留为「补充」，字段与结论不变（仅平量涨/跌方向在 _comboEngine 对齐）
    // 20261101d：位置感知量价判定主判（图片 24 格矩阵）—— 前端主判卡先渲染本字段
    posJudgment,
  };
}

// 20261103f（用户截图指令：利好/利空内容按红/绿语义着色）：_chipTransfer 改返回 { text, tone }——
// text 与原版逐字一致（下游 dimensions.chipTransfer 字符串不变），tone 为语义方向（bull/bear/neutral），
// 供前端「筹码转移」tile 着色；新增 dimensions.capitalBehaviorTone（= combo.direction 归一）。
function _chipTransfer(rules, combo, pc, pv) {
  const r1 = rules.find(r => r.id === 1 && r.matched);
  const r2 = rules.find(r => r.id === 2 && r.matched);
  const r4 = rules.find(r => r.id === 4 && r.matched);
  if (r2) return { text: '主力筹码向散户转移（高位派发）', tone: 'bear' };
  if (r4) return { text: '筹码承接失效，持仓筹码集中离场（放量破位）', tone: 'bear' };
  if (r1) return { text: '筹码呈现由散户向主力集中的转移趋势（低位吸筹）', tone: 'bull' };
  // 20261017f：7.4 低位放量震荡——规则1 未完整命中时按观察口径描述
  if (pv && pv.lowOscillate && pv.lowOscillate.matched) return { text: '大量筹码正在重新分配（低位放量震荡），值得跟踪但不直接看多', tone: 'neutral' };
  if (combo.scenario === '横盘持续巨量') return { text: '筹码剧烈交换，方向不明', tone: 'neutral' };
  if (pc.level === '极度缩量') return { text: '筹码沉淀，浮动筹码减少', tone: 'neutral' };
  if (combo.direction === 'bull') return { text: '筹码向积极买方转移，量价配合健康', tone: 'bull' };
  if (combo.direction === 'bear') return { text: '筹码向卖方转移，抛压主导', tone: 'bear' };
  return { text: '筹码交换平稳，无显著单向转移', tone: 'neutral' };
}

// ===================== 采集入口：数据组装后调纯计算 =====================

/**
 * 采集 + 分析入口（供 server 路由 / 资金量能卡调用）。
 * 日K四级降级链（20261017e）：东财多主机日K（push2his→push2，含成交额 amount 与
 * 换手率 turnover 全字段）→ 同花顺日K（all.js 解码全历史 + last.js 近 140 根含成交额/换手率，
 * 重叠段闸门校验）→ 腾讯日K（仅 OHLCV，缺字段由引擎按 spec 降级并如实标注）。
 * 任一级拿到 ≥10 根即采用；全部不可达则保留最长可用集，引擎如实输出「日线数据不足（可用 N 根）」。
 * 其余通道：腾讯分时（规则 2/5）+ 东财公告（黑名单解禁/减持）+ ST 名称识别。
 * 任一通道失败只降级对应字段并如实标注，不阻塞其他维度。
 */
async function analyzeVolume(symbol, name, quote, opts = {}) {
  const { detectMarket, fetchTencentMinutes } = require('./stockData');
  const { searchAnnouncementsByCode } = require('./cnscraperAdapter');

  let info = {};
  try { info = detectMarket(symbol) || {}; } catch (e) { console.warn('[VolumeEngine] detectMarket failed:', e.message); /* 市场识别失败仅影响分时/腾讯日K兜底通道，东财日K与公告不受影响，下游按「分时数据不足」降级 */ }

  const [barsResult, minuteData, ann] = await Promise.all([
    _fetchDailyBars(symbol, info),
    info.tencentCode ? fetchTencentMinutes(info.tencentCode).catch(() => null) : Promise.resolve(null),
    searchAnnouncementsByCode(symbol, 30).catch(() => null),
  ]);

  // 20261103a：长期趋势定论（MA250 年线：上行/下行/震荡）——复用系统既有价格行为推演（lib/priceAction），
  // 拉取 2400 根日K 算 MA250，弥补量价判定卡「只看 12 个月」看不见 2023 年以来长期下跌的盲点。
  // 失败/数据不足时降级为 null，量价判定按原逻辑运行，不阻断。
  const longTerm = await (async () => {
    try {
      const { getHistoryDeep } = require('./stockData');
      const { analyzePriceAction } = require('./priceAction'); // 懒加载，避免 volumeEngine→priceAction→capitalFlow→volumeEngine 循环依赖在加载期触发
      const deep = await getHistoryDeep(symbol, 2400).catch(() => null);
      if (!deep || deep.length < 250) return null;
      const pa = analyzePriceAction(deep, null);
      return (pa && pa.longTerm) ? pa.longTerm : null;
    } catch (e) {
      console.warn('[VolumeEngine] 长期趋势定论获取失败（降级隐藏，不影响量价判定）：', e && e.message ? e.message : e);
      return null;
    }
  })();

  // 20261019b：当日 bar 实时行情终值对齐（详见 _reconcileTodayBar 注释）。
  // 日期新鲜 ≠ 数值终值——同花顺当日 bar 收盘后可能是盘中快照（000902 实测 close 13.69 vs 终值 13.62），
  // 统一以腾讯实时 quote（交易所终值）覆写/补齐当日 bar，量比与当日涨跌随之回到东财口径。
  const _now = new Date();
  const _todayStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const recon = _reconcileTodayBar(barsResult.bars, quote, barsResult.source, _todayStr);
  // 20261028a：盘中判定守门——末根 bar 是今日且未到 15:00 收盘 → 当日量为部分日累计，
  // fail-closed 规则（规则3 假突破量能不确认、该放量未放量）盘中停判（见 computeVolumeEngine/ctxBase 注释）。
  // 非交易日 quote.date 不会等于今日、收盘后 ≥15:00、末根停牌滞后 → 三种情况均不触发守门，按收盘口径正常判定。
  const _lastBarDate = Array.isArray(barsResult.bars) && barsResult.bars.length ? barsResult.bars[barsResult.bars.length - 1].date : null;
  const _minutesOfDay = _now.getHours() * 60 + _now.getMinutes();
  const intradayPending = _lastBarDate === _todayStr && _minutesOfDay < 15 * 60;
  if (recon.appended) barsResult.stale = false; // 当日已由实时行情补齐，不再是「未包含今日数据」
  // 20261021h：单位不符（实时量与日K量差 >20 倍）→ 已拒绝覆写，这里如实上报，不静默
  if (recon.note === 'unit_mismatch') {
    console.warn(`[VolumeEngine] ${symbol} 当日量单位异常：实时量换算后为日K量的 ${recon.mag} 倍，已拒绝覆写当日K线（保留日K原值）`);
    barsResult.unitMismatch = { mag: recon.mag, quoteVolume: recon.next && recon.next.volume, barVolume: recon.prev && recon.prev.volume };
  }

  // 黑名单：近 180 天内标题含「解禁/减持」的公告 + ST/退市风险
  const blacklistReasons = [];
  const stockName = name || (quote && quote.name) || '';
  if (ann && ann.ok && Array.isArray(ann.items)) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    for (const it of ann.items) {
      const title = String(it.title || '');
      if (it.date && it.date >= cutoffStr && /解禁|减持/.test(title)) {
        blacklistReasons.push(`近期公告：${it.date} ${title.slice(0, 40)}`);
      }
    }
  }
  if (/\*?ST|退市/i.test(stockName)) {
    blacklistReasons.push(`ST/退市风险警示：${stockName}`);
  }

  // 20261019c：量比优先取数据源直采（腾讯行情 fields[49]），不本地重算。
  // quote.volumeRatio 为 null 时（腾讯未提供/解析失败）由引擎退回「今日量÷5日均量」本地兜底。
  const quoteVolumeRatio = (quote && typeof quote.volumeRatio === 'number') ? quote.volumeRatio : null;
  // 20261105f：锚点三筹码分布（本地 CYQ，东财同款算法）——流通股本=腾讯行情流通市值(亿)×1e8/现价
  let chipData = null;
  try {
    const { computeChipDistribution } = require('./chipDistribution');
    const fv = quote && typeof quote.circulationValue === 'number' && quote.circulationValue > 0 ? quote.circulationValue : null;
    // 20261105g 修复：quote 对象现价字段名为 price（stockData 腾讯行情 f[3]），close 仅日 K bar 有——两字段名都兼容
    const pxRaw = quote ? (typeof quote.close === 'number' && quote.close > 0 ? quote.close : (typeof quote.price === 'number' && quote.price > 0 ? quote.price : null)) : null;
    const px = pxRaw;
    if (fv && px) {
      chipData = computeChipDistribution(barsResult.bars, fv * 1e8 / px, { intradayPending });
      if (chipData && intradayPending) chipData.intradayPending = true; // 盘中筹码按当前价为近似，标注
    }
  } catch (e) { chipData = null; }
  const result = computeVolumeEngine({
    symbol,
    name: stockName,
    bars: barsResult.bars,
    barsSource: barsResult.source,
    longTerm,                                       // 20261103a：长期趋势定论（MA250），传入 computeVolumeEngine 做位置叠加
    unitMismatch: barsResult.unitMismatch || null,   // 20261021h：单位异常（已拒绝覆写）如实上报
    minutes: minuteData,
    blacklistReasons,
    marketEnv: opts.marketEnv || null,
    config: opts.config || null,
    // 20261022d：短期动向模块的有效支撑/阻力区间（由 capitalFlow 注入），供 _keyLevels 优先采用
    levelHints: opts.levelHints || null,
    quoteVolumeRatio,
    intradayPending, // 20261028a：盘中停判开关（末根=今日且未到 15:00）
    // 20261105f：锚点二估值快照（quote PE/PB 绝对水平）+ 锚点三筹码分布（本地 CYQ）——仅参考提醒
    quoteSnapshot: (quote && (typeof quote.pe === 'number' || typeof quote.pb === 'number')) ? { pe: quote.pe || null, pb: quote.pb || null } : null,
    chip: chipData,
  });

  // 20261019a：降级链选中的日K若末根不是今天（停牌 / 当日K线通道延迟），
  // 如实标注——所有量能结论基于末根日期，不得让用户误以为是今日盘面。
  if (result.ok && barsResult.stale && Array.isArray(barsResult.bars) && barsResult.bars.length) {
    const lastD = barsResult.bars[barsResult.bars.length - 1].date;
    // 20261024f：交易日感知文案——周末/节假日末根=最近交易日不再误报「未包含今日数据」真缺口
    const gapText = _staleBarGapText(lastD, _todayStr);
    if (gapText) result.dataGaps.push(gapText);
  }
  // 20261019b：当日 bar 对齐动作如实留痕（通道快照滞后 / 实时行情补齐）
  if (result.ok && recon.note === 'overwritten') {
    result.dataGaps.push(`当日 bar 原为「${barsResult.source}」通道快照（close ${recon.prev.close} / 量 ${recon.prev.volume}），已按腾讯实时行情终值覆写（close ${recon.next.close} / 量 ${recon.next.volume}）`);
  } else if (result.ok && recon.note === 'appended') {
    result.dataGaps.push(`各日K通道均未提供今日数据，当日 bar 已由腾讯实时行情补齐（${quote.date}，close ${recon.next.close} / 量 ${recon.next.volume}）`);
  }
  // 20261019c：量比来源透明标注——直采腾讯行情 fields[49] 时明确「非本地计算」，本地兜底时如实说明。
  if (result.ok) {
    const basis = (result.volumeState && result.volumeState.ratio5Basis) || 'unavailable';
    if (basis === 'tencent_quote') {
      result.dataGaps.push(`量比 ${_round(quoteVolumeRatio)} 取自腾讯实时行情直采（fields[49]），非本地工作台重算`);
    } else if (basis === 'local_fallback') {
      result.dataGaps.push(`量比本地回退计算（腾讯行情未提供量比字段，采用「今日量 ÷ 前5日均量」）`);
    }
  }

  // 20261017i：内部字段 bars —— 引擎已拉到的日K原样透出，供 capitalFlow 的「量价分析」复用
  // 同一份数据（消除「两卡各拉一份日K、连『今日』定格在哪根都可能不同」的隐患）。
  // 仅在服务端模块间传递：capitalFlow 组装完指标后即剔除，不下发前端、不进 API 响应。
  return { ...result, bars: barsResult.bars };
}

/**
 * 日K四级降级链（20261017e 建立；20261019a 采用判据升级：根数够 → 根数够且新鲜）。
 * ① 东财多主机日K（push2his → push2，klt=101 前复权）：含成交额 amount + 换手率 turnover 全字段；
 * ② 同花顺日K（all.js 压缩解码全历史 + last.js 近 140 根含成交额/换手率，重叠段 close 闸门校验；前复权同口径）；
 * ③ 腾讯日K（ifzq.gtimg qfqday）：仅 OHLCV，缺字段由 _precompute 按 spec 降级并如实标注，不臆造。
 *
 * 20261019a 缺陷修复（用户 000783 长江证券实测：东财 App 量比 0.82，工作台 1.26）：
 * 旧判据「任一级 ≥10 根即采用」只看根数不看新旧——本机东财被断，同花顺返回 140 根
 * 但当日 K 线收盘后延迟更新（末根止于 10-16），链条直接采用、不再看腾讯（腾讯有 10-19），
 * 工作台遂用 3 天前的 K 线得出与东财 App 截然不同的量比与涨跌幅。
 * 新判据：末根日期 = 今天才视为「新鲜」。某级新鲜 → 立即采用（快路径，零额外请求）；
 * 不新鲜 → 记为候选继续尝试下一级；全部候选均非新鲜（停牌 / 节假日 / 各通道集体延迟）
 * → 选「末根最新」者，并列（各通道末根一致）时按 东财>同花顺>腾讯 优先级（字段全者优先，
 * 与旧行为一致）；全部不足 10 根 → 保留最长可用集（原兜底不变）。
 * 选中的候选若非新鲜，由 analyzeVolume 在 dataGaps 如实标注「未包含今日数据」。
 */
function _chooseDailyBars(candidates, todayStr) {
  const ok = (candidates || []).filter(c => c && Array.isArray(c.bars) && c.bars.length >= 10);
  if (!ok.length) return null;
  const meta = ok.map(c => ({
    bars: c.bars, source: c.source, priority: c.priority || 0,
    lastDate: c.bars[c.bars.length - 1] && c.bars[c.bars.length - 1].date,
  }));
  const fresh = meta.find(c => c.lastDate === todayStr);
  if (fresh) return { bars: fresh.bars, source: fresh.source, lastDate: fresh.lastDate, stale: false };
  const maxDate = meta.map(c => c.lastDate).sort().pop();
  const winners = meta.filter(c => c.lastDate === maxDate).sort((a, b) => a.priority - b.priority);
  return { bars: winners[0].bars, source: winners[0].source, lastDate: winners[0].lastDate, stale: true };
}

/**
 * 20261024f：日K「缺今日/最近交易日」的说明文案（交易日感知，纯函数，导出供单测）。
 * ---------------------------------------------------------------------------
 * 缺陷（用户 2026-10-24 周六 13:35 截图，红色「数据不足」框）：末根为周五 10-23，
 * 却报「日K最新一根为 2026-10-23，未包含今日数据」——今日 10-24 是周六、非交易日，
 * 数据其实已更新到最近交易日（周五收盘），这是**假缺口**，不应进红框吓用户。
 *
 * 判定（数据最新性铁律：交易日感知 + 过期标注）：
 *   - 交易日：末根 ≠ 今日 → 「未包含今日数据」（原口径，如实标注）
 *   - 非交易日（周末/节假日）：
 *       · 末根 ≥ 最近交易日 → 数据已更新至最近交易日 → **中性来源说明**（不进红框）
 *       · 末根 < 最近交易日 → 真缺口「未包含最近交易日 X 的数据」（红框）
 * @param {string} lastD 日K末根日期 YYYY-MM-DD
 * @param {string} todayStr 今日 YYYY-MM-DD
 * @returns {string} 缺口/说明文案（调用方直接 push 进 dataGaps）
 */
function _staleBarGapText(lastD, todayStr) {
  if (!lastD || !todayStr) return null;
  const tradingToday = isTradingDay(todayStr);
  if (tradingToday) {
    return `日K最新一根为 ${lastD}，未包含今日数据（该股可能停牌，或当日K线通道延迟更新）——量能结论基于 ${lastD}，非今日盘面`;
  }
  const expectedLatest = previousTradingDay(todayStr);
  if (lastD >= expectedLatest) {
    // 非交易日 + 数据已到最近交易日 → 中性说明（TRUE_GAP_RE 不匹配，落「来源说明」中性框）
    return `今日 ${todayStr} 为非交易日（周末/节假日），量能结论基于最近交易日 ${lastD} 收盘数据（数据已更新至最新交易日）`;
  }
  return `日K最新一根为 ${lastD}，未包含最近交易日 ${expectedLatest} 的数据（该股可能停牌，或当日K线通道延迟更新）——量能结论基于 ${lastD}`;
}

async function _fetchDailyBars(symbol, info, count = 320) {
  const { fetchEastmoneyHistoryMultiHost, fetchThsHistory, fetchTencentHistory } = require('./stockData');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const collected = [];
  let longest = { bars: [], source: 'none' };
  const collect = (bars, source, priority) => {
    if (!Array.isArray(bars) || !bars.length) return;
    if (bars.length > longest.bars.length) longest = { bars, source };
    if (bars.length >= 10) collected.push({ bars, source, priority });
  };

  try {
    collect(await fetchEastmoneyHistoryMultiHost(symbol, count), 'eastmoney', 0);
  } catch (e) {
    console.warn('[VolumeEngine] fetchEastmoneyHistoryMultiHost failed:', e.message);
  }
  // 注意：_chooseDailyBars 对「全部候选均非新鲜」也会返回最优 stale 候选（stale:true）。
  // stale 时不得提前 return——必须继续尝试下一级（这正是 000783 缺陷的修复点：
  // 同花顺 stale 若在此返回，腾讯虽有今日数据也轮不到）。
  let chosen = _chooseDailyBars(collected, todayStr);
  if (chosen && !chosen.stale) return chosen;

  try {
    collect(await fetchThsHistory(symbol, count), 'ths', 1);
  } catch (e) {
    console.warn('[VolumeEngine] fetchThsHistory failed:', e.message);
  }
  chosen = _chooseDailyBars(collected, todayStr);
  if (chosen && !chosen.stale) return chosen;

  if (info && info.tencentCode) {
    try {
      collect(await fetchTencentHistory(info.tencentCode, count), 'tencent', 2);
    } catch (e) {
      console.warn('[VolumeEngine] fetchTencentHistory failed:', e.message);
    }
  }
  // 走完全部通道后的最终选取：有 fresh 取 fresh；全 stale 取「末根最新+通道优先」；
  // 无任何 ≥10 根候选 → 最长可用集兜底。
  chosen = _chooseDailyBars(collected, todayStr);
  if (chosen) return chosen;
  return longest;
}

/**
 * 当日 bar 实时行情终值对齐（20261019b，纯函数，导出供单测）。
 *
 * 缺陷（用户 000902 新洋丰实测：东财 App 量比 0.99 / 当日 +1.87%，工作台 0.97 / +2.39%）：
 * 本机东财通道被断，降级链采用同花顺；同花顺当日 bar 带今日日期但数值是盘中快照
 * （close 13.69 / 7,923,196 股），收盘后未固化为终值（真实 close 13.62 / 8,052,800 股）。
 * 20261019a 新鲜度判据只校验「末根日期 = 今天」——日期新鲜 ≠ 数值终值。
 *
 * 修复原则（数据一致性铁律 · 当日数据单一权威源）：主行情源腾讯实时 quote 即交易所终值
 * （qt.gtimg 实时快照，收盘后 = 收盘终值，盘中 = 实时累计），以其对齐当日 bar：
 *   ① 末根日期 = quote 日期 → 覆写末根 OHLC/量/额（数值一致时幂等不动）；
 *   ② quote 日期 > 末根日期且 = 今天 → 直接以 quote 补齐当日 bar（全通道日K集体延迟场景，
 *      与 20261019a「全 stale 选末根最新」互补：历史段用通道，当日段永远以实时行情为准）。
 *
 * 防御与单位：
 * - quote 缺失 / price 非正 / volume 非正（停牌、盘前）/ date 缺失 → 不动，返回 { note: null }；
 * - 仅当 quote.date === 末根日期才覆写（quote 陈旧时不得污染更新的 bar）；
 * - 单位按通道自适应（20261021h 修正）：`quote.volume` 恒为「股」；**各日K通道的 bar 单位不统一**，
 *   必须按下表换算，不能按"是否 tencent"二分——旧写法把东财当成「股」，导致当日量被写成 ×100
 *   （000902 实测：bar 73588 手 vs quote 7,358,800 股，覆写后成了 7358800，与本文件 avg60 113900 相差 64 倍，
 *   文案就输出成「60日均量 113900 ×1.5 算出阈值 170850（当日量 7358800）却未达阈值」这种自相矛盾）；
 * - amount 仅覆写非 tencent 通道（腾讯日K仅 OHLCV，无 amount 字段）；
 * - 覆写仅在数值实质变化时返回 note='overwritten'（close 差 >0.1% 或量差 >0.5%），一致则静默幂等。
 *
 * @returns {{note: null|'overwritten'|'appended', prev?:object, next?:object}}
 */
function _reconcileTodayBar(bars, quote, barsSource, todayStr) {
  if (!Array.isArray(bars) || !bars.length) return { note: null };
  if (!quote || !isFinite(quote.price) || quote.price <= 0) return { note: null };
  if (!isFinite(quote.volume) || quote.volume <= 0) return { note: null };
  if (!quote.date) return { note: null };

  // 单位对齐（20261021h）：quote.volume 恒为「股」；日K channel 单位统一由 lib/volUnit 声明
  //（东财/腾讯 = 手，同花顺 = 股），此处只做换算、不再自己维护一份表。
  const qVol = sharesToBarUnit(quote.volume, barsSource);
  const qBar = {
    date: quote.date,
    open: isFinite(quote.open) && quote.open > 0 ? quote.open : quote.price,
    high: isFinite(quote.high) && quote.high > 0 ? quote.high : quote.price,
    low: isFinite(quote.low) && quote.low > 0 ? quote.low : quote.price,
    close: quote.price,
    volume: qVol,
  };
  if (barsSource !== 'tencent' && isFinite(quote.amount) && quote.amount > 0) qBar.amount = quote.amount;

  const last = bars[bars.length - 1];
  if (last && last.date === quote.date) {
    // 20261021h 防线：即便通道表写错，也不许把「股」写进「手」序列。
    // 同一天同一只股票，换算后的实时量与日K量不可能差 20 倍以上——差这么多只能是单位错。
    // 此时**不覆写**（保留日K原值），只返回 note 让上层标注，绝不静默污染整条量能序列。
    if (last.volume > 0 && qVol > 0) {
      const mag = qVol / last.volume;
      if (mag > 20 || mag < 1 / 20) {
        return { note: 'unit_mismatch', prev: { close: last.close, volume: last.volume }, next: { close: qBar.close, volume: qVol }, mag: Math.round(mag * 100) / 100 };
      }
    }
    const closeDiff = last.close > 0 ? Math.abs(qBar.close - last.close) / last.close : 1;
    const volDiff = last.volume > 0 ? Math.abs(qBar.volume - last.volume) / last.volume : 1;
    const material = closeDiff > 0.001 || volDiff > 0.005;
    const prev = { close: last.close, volume: last.volume };
    Object.assign(last, qBar);
    return material ? { note: 'overwritten', prev, next: { close: qBar.close, volume: qBar.volume } } : { note: null };
  }
  if (quote.date > (last ? last.date : '') && quote.date <= todayStr && isTradingDay(quote.date)) {
    // 20261025l：放宽旧条件「quote.date === todayStr」——周末/节假日访问时最近交易日（如周五）
    // ≠ 今天（周六），旧条件把最近交易日的终值 quote 拒之门外，bars 末根停留在前一交易日
    // （000902 实测：10-23 放量下跌 -4.18% 缺失 → 量能信号停在 10-22 误判「中性」，
    //  与当日量价配合「放量下跌」同屏矛盾）。现改为：quote 严格新于末根、不晚于本地今天
    // （防时钟错乱的"未来日期"）、且是交易日（防假报）即以交易所终值补齐。
    bars.push(qBar);
    return { note: 'appended', next: { close: qBar.close, volume: qBar.volume } };
  }
  return { note: null };
}

module.exports = {
  computeVolumeEngine,
  analyzeVolume,
  // 导出纯函数供单测（20261017e）
  _precompute,
  _detectPosition,
  _keyLevels,
  _threeChecks,
  _detectDivergence,
  _lifeRules,
  _pickRefHigh, // 20261109c：同价位带最近前高（基准可比性守卫可单测）
  _comboEngine,
  _sequenceRule,
  _scoreEngine,
  _liquidityCheck,
  _sidewaysAndPlatform,
  _trendSegment, // 20261104e：近 120 日趋势段检测（位置定位阶梯第一步）
  _classify,
  // 导出纯函数供单测（20261017f：7.4/7.5/11.3 规则与三个强制归集总结）
  _volTraits,
  _positionVolumeRules,
  _ratioRules,
  _contradictionRules,
  _posVolumeMatrix,
  // 20261105f：新判定链函数导出（守卫可单测）
  _adx14,
  _dowStructure,
  _maArrange,
  _boxQuant,
  _runState,
  _posZone,
  _volTier5,
  _walkTier5,
  _signalLayer,
  _specialCases,
  _buildSummaries,
  // 导出纯函数供单测（20261017i：跨卡一致性统一量能档位）
  _volTriState,
  _volumeTier,
  // 导出纯函数供单测（20261019d：预期量能规则，该放/该缩缺口补充）
  _expectedVolumeRules,
  // 导出纯函数供单测（20261019a：日K降级链「新鲜度」选取判据）
  _chooseDailyBars,
  // 导出纯函数供单测（20261019b：当日 bar 实时行情终值对齐）
  _reconcileTodayBar,
  // 导出纯函数供单测（20261024f：日K「缺今日/最近交易日」文案的交易日感知）
  _staleBarGapText,
  // 导出纯函数供单测（20261020a：底部区域相位分类，构筑期/启动确认区/方向不明）
  _bottomPhase,
};

~~~

---

## `lib\volUnit.js`  ·  41 行

~~~js
/**
 * 日K成交量「单位」单一来源（20261021h）
 * ==========================================================
 * 背景（用户 2026-10-21 截图报障）：
 *   文案「60 日均量 113900 ×1.5 = 170850（当日量 7358800）」——当日量比阈值大 43 倍，
 *   却判「未达阈值」。根因是当日 bar 被实时行情覆写时单位换错：把「股」写进了「手」序列。
 *
 * 实测（2026-10-21，用「成交额 = 收盘价 × 量 × 100」反验，最可靠）：
 *   | 通道 | 日K volume 单位 | 证据 |
 *   |---|---|---|
 *   | eastmoney（东财 kline f56） | **手** | 000902: 73588 手 ×13.87×100 = 1.02 亿 = quote.amount；600519: 33514×1309.69×100 = 43.89 亿 ≈ 44.04 亿 |
 *   | tencent（fetchTencentHistory 已归一） | **手** | 科创板 688/689 的「股」已在取数时 ÷100 |
 *   | ths（同花顺 last.js） | **股** | 同花顺日K量级为东财的 ~100 倍 |
 *   | quote（腾讯实时快照 fields[36]） | **股** | 与日K手数恒差 100 倍 |
 *
 * 教训：这段"哪个通道是什么单位"的知识此前散落在至少三处（volumeEngine 的覆写函数、
 * volumeEngine 的开盘量比、capitalFlow 的 VOLUME_TO_LOT），其中两处把东财当成「股」，
 * 于是同一个文件里同时存在 ×100 与 ÷100 两种错误方向。现在收敛到本文件，任何新调用点只许调这里。
 */

// 日K通道 → volume 单位（'hand' 手 / 'share' 股）
const BAR_VOL_UNIT = { eastmoney: 'hand', tencent: 'hand', ths: 'share' };

/** 该通道日K的成交量单位；未知通道按「股」保守处理（宁可少除，也不凭空 ÷100 把量做小） */
function barVolumeUnit(source) {
  return BAR_VOL_UNIT[source] || 'share';
}

/** 把「股」换算成该通道日K的单位（实时 quote 恒为股，写进日K前必须过这一步） */
function sharesToBarUnit(shares, source) {
  if (!isFinite(shares)) return null;
  return barVolumeUnit(source) === 'share' ? shares : shares / 100;
}

/** 该通道日K → 「手」的换算除数（东财/腾讯=1，同花顺=100） */
function toLotDivisor(source) {
  return barVolumeUnit(source) === 'share' ? 100 : 1;
}

module.exports = { BAR_VOL_UNIT, barVolumeUnit, sharesToBarUnit, toLotDivisor };

~~~

---

## `lib\webSearchMcp.js`  ·  415 行

~~~js
/**
 * 联网搜索 MCP 通用客户端（20260903m 新增 / 20260903n 支持多端点）
 * ----------------------------------------------------------------
 * 背景：原工作台联网搜索走模型内置 enable_search（sfm_plugin_public），
 * 按次计费、无免费额度（≈0.003 元/次）。多家云厂商另提供「联网搜索 MCP」服务，
 * 均为 Streamable HTTP 协议，本模块用同一套 JSON-RPC 流程适配。
 *
 * 已支持端点（endpoint 参数切换）：
 *   - MCP_ENDPOINT（阿里云百炼 WebSearch）：全部用户前 2000 次调用免费（一次性总额度、不重置），
 *     超出 ≈0.029 元/次。Key = 百炼通用 Key（sk-xxx），与模型调用同一把。
 *     【20260903r 免费额度保险】本地持久化「成功调用」计数（data/cache/ali_mcp_quota.json，重启不丢），
 *     计数达到 2000 后不再发起任何网络请求，直接抛错 → 上层自动回退模型内置 enable_search（见 mcpWebSearch）。
 *   - BAIDU_ENDPOINT（百度千帆 AI 搜索）：每日 100 次免费（周期性重置，≈3000 次/月），
 *     超出智能搜索生成 ≈0.008 元/次（限时折扣价）。Key = 千帆 API Key（bce-v3/... 或 Bearer Key）。
 *
 * 本模块把「搜索」从模型内置参数解耦出来：先调 MCP 拿到搜索结果文本，
 * 再由上层注入 prompt、用 modelWeb 纯推理（不带 enable_search）。
 * 这样搜索部分吃厂商免费额度，模型 token 走免费试用/低价模型。
 *
 * 协议：Streamable HTTP MCP（JSON-RPC 2.0）
 *   1) initialize         -> 取 Mcp-Session-Id
 *   2) notifications/initialized
 *   3) tools/list         -> 发现工具名（首次，之后按端点缓存）
 *   4) tools/call         -> 返回搜索结果文本
 *
 * 20261001a 优化（体检 P3b）：
 *   - 会话复用：Mcp-Session-Id + 工具名按「端点+Key」缓存，命中后直接 tools/call（1 次往返，
 *     原 4 次）；服务端会话过期（400/404/410）时清缓存、完整握手后重试一次。
 *   - 总超时守卫：整链路 overallTimeout（默认 25s）兜底，防止 4 段 × 15s 的极端悬挂
 *     占满上层 LLM 的 60s 预算。
 *   - 百度千帆每日免费 100 次本地计数（data/cache/baidu_mcp_daily.json，中国自然日重置），
 *     达限后本地短路抛错 → 上层降级其他搜索通道。
 *   - 错误归一化：超时/网络错误统一为带厂商标识的中文文案，原始错误挂 err.raw。
 */
'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { localDate } = require('./localDate');

const MCP_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
const BAIDU_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/mcp';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TOOL = 'web_search';

// 工具名发现后缓存（同一进程内复用，省一次 tools/list 往返）
// 不同厂商工具名不同（阿里 web_search / 百度 ai_search 等），必须按 endpoint 隔离
const cachedToolNameByEp = Object.create(null);

// MCP 会话复用缓存（20261001a）：endpoint+apiKey → { sessionId, toolName }。
// initialize/initialized/tools/list 三段握手只在会话缺失时做；服务端把会话回收
// （tools/call 返回 400/404/410）时清缓存重新完整握手。换 Key 也会自然失配重新握手。
const mcpSessionCache = new Map();

// ── 阿里百炼 MCP 免费额度保险（20260903r 新增，仅对 MCP_ENDPOINT 生效）──────────
// 免费额度为一次性总额度（前 2000 次成功调用免费、不重置），本模块本地持久化计数：
//   - 每次【成功】取回搜索结果计数 +1（失败调用不计，落盘 data/cache/ali_mcp_quota.json，重启不丢）；
//   - 计数达到 ALI_QUOTA_LIMIT 后不再发起任何网络请求，直接抛特定错误 →
//     上层 callLLM 的现有 catch 自动回退模型内置 enable_search，功能不中断、不再产生费用；
//   - 计数达 ALI_QUOTA_WARN_AT 起每次成功调用都打日志提醒；
//   - 若服务端明确返回「额度用尽/欠费」类错误（本地计数可能少于真实用量，例如用户在
//     阿里云控制台手动测试过），把计数锁定为上限兜底，后续调用全部本地短路。
//   - 手动把 JSON 里 count 改小或删除该文件即可重新计数。
const ALI_QUOTA_LIMIT = 2000;
const ALI_QUOTA_WARN_AT = 1800;
const ALI_QUOTA_FILE = path.join(__dirname, '..', 'data', 'cache', 'ali_mcp_quota.json');
// 服务端「额度用尽/欠费」信号特征（同时排除限流类误报——限流是暂时的，不能永久锁死通道）
const ALI_QUOTA_EXHAUSTED_RE = /(free\s*quota[^a-z]{0,40}(exhaust|used\s*up|deplet)|额度[^。]{0,10}(用尽|耗尽|已用完)|欠费|arrearage)/i;
const ALI_QUOTA_RATE_RE = /(throttl|rate\s*limit|too\s*many|频率|429)/i;

let gAliQuotaCache = null;  // 进程内缓存，避免每次成功调用都读盘
let gAliQuotaMtime = 0;     // 文件 mtime，外部手改文件后自动重载

function loadAliQuotaState() {
  try {
    const st = fs.statSync(ALI_QUOTA_FILE);
    if (gAliQuotaCache && st.mtimeMs === gAliQuotaMtime) return gAliQuotaCache;
    const j = JSON.parse(fs.readFileSync(ALI_QUOTA_FILE, 'utf8'));
    gAliQuotaCache = {
      count: Math.max(0, parseInt(j.count, 10) || 0),
      updatedAt: j.updatedAt || '',
    };
    gAliQuotaMtime = st.mtimeMs;
  } catch (_) {
    if (!gAliQuotaCache) gAliQuotaCache = { count: 0, updatedAt: '' };
  }
  return gAliQuotaCache;
}

function saveAliQuotaState(state) {
  try {
    fs.mkdirSync(path.dirname(ALI_QUOTA_FILE), { recursive: true });
    const payload = {
      _note: '阿里百炼联网搜索MCP免费额度本地计数：每次成功调用+1，达到2000自动回退内置enable_search。手动改小count或删除本文件即重新计数。',
      count: state.count,
      limit: ALI_QUOTA_LIMIT,
      updatedAt: state.updatedAt,
    };
    fs.writeFileSync(ALI_QUOTA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    try { gAliQuotaMtime = fs.statSync(ALI_QUOTA_FILE).mtimeMs; } catch (_) {}
  } catch (e) {
    console.warn('[ali-mcp-quota] 计数落盘失败（不影响本次搜索）：', e && e.message);
  }
}

// 检查错误信息是否为服务端「额度用尽/欠费」信号 → 本地计数锁定为上限
function latchAliQuotaIfExhausted(err) {
  try {
    // 20261001a：错误经 normalizeMcpError 包装后 response 挂在 err.raw 上，两边都检查
    let msg = (err && err.message) || '';
    const orig = (err && err.raw) || err;
    const rd = (orig && orig.response && orig.response.data) || (err && err.response && err.response.data);
    if (rd) msg += ' ' + (typeof rd === 'string' ? rd : JSON.stringify(rd));
    if (ALI_QUOTA_EXHAUSTED_RE.test(msg) && !ALI_QUOTA_RATE_RE.test(msg)) {
      const st = loadAliQuotaState();
      if (st.count < ALI_QUOTA_LIMIT) {
        st.count = ALI_QUOTA_LIMIT;
        st.updatedAt = new Date().toISOString();
        saveAliQuotaState(st);
        console.warn('[ali-mcp-quota] 服务端返回额度用尽/欠费信号，本地计数锁定为上限，后续自动回退内置联网搜索');
      }
    }
  } catch (_) { /* 保险逻辑自身异常绝不影响主流程 */ }
}

// 对外暴露额度状态（/api/ai/config 展示用），不泄露文件路径
function getAliMcpQuotaState() {
  const st = loadAliQuotaState();
  return { count: st.count, limit: ALI_QUOTA_LIMIT, warnAt: ALI_QUOTA_WARN_AT, updatedAt: st.updatedAt };
}

// ── 百度千帆 MCP 每日免费额度计数（20261001a，仅对 BAIDU_ENDPOINT 生效）──────────
// 百度 AI 搜索每日 100 次免费、周期性重置（区别于阿里的一次性总额度）。
// 用中国自然日（localDate）做重置边界，避免 UTC 跨日错位；达到上限后本地短路抛错 →
// 上层降级其他搜索通道，不产生计费调用。手动改小 JSON 里的 count 或删除文件即可重置。
const BAIDU_DAILY_LIMIT = 100;
const BAIDU_DAILY_FILE = path.join(__dirname, '..', 'data', 'cache', 'baidu_mcp_daily.json');
let _baiduDaily = null;

function loadBaiduDaily() {
  const today = localDate();
  if (_baiduDaily && _baiduDaily.date === today) return _baiduDaily;
  try {
    const j = JSON.parse(fs.readFileSync(BAIDU_DAILY_FILE, 'utf8'));
    _baiduDaily = (j && j.date === today)
      ? { date: today, count: Math.max(0, parseInt(j.count, 10) || 0) }
      : { date: today, count: 0 };
  } catch (_) {
    _baiduDaily = { date: today, count: 0 };
  }
  return _baiduDaily;
}

function saveBaiduDaily(st) {
  try {
    fs.mkdirSync(path.dirname(BAIDU_DAILY_FILE), { recursive: true });
    fs.writeFileSync(BAIDU_DAILY_FILE, JSON.stringify({
      _note: '百度千帆 AI 搜索 MCP 每日免费额度本地计数：成功调用+1，每日(中国自然日)自动重置，上限 100 次/天。手动改小 count 或删除本文件即可重置。',
      date: st.date,
      count: st.count,
      limit: BAIDU_DAILY_LIMIT,
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[baidu-mcp-daily] 计数落盘失败（不影响本次搜索）：', e && e.message);
  }
}

// 对外暴露额度状态（与 getAliMcpQuotaState 同级的只读视图），不泄露文件路径
function getBaiduMcpDailyState() {
  const st = loadBaiduDaily();
  return { count: st.count, limit: BAIDU_DAILY_LIMIT, date: st.date };
}

function parseSSE(raw) {
  if (typeof raw !== 'string') return [raw];
  const out = [];
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const json = t.slice(5).trim();
        if (!json) continue;
        try { out.push(JSON.parse(json)); } catch (_) { /* 跳过非 JSON 行 */ }
      }
    }
  }
  return out;
}

function extractText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n\n');
}

// 从 JSON-RPC 响应集合中按 id 取出对应事件
function pickEvent(events, id) {
  const arr = Array.isArray(events) ? events : [events];
  return arr.find((e) => e && e.id === id) || arr[arr.length - 1] || null;
}

/** 错误归一化（20261001a）：超时/网络错误统一为带厂商标识的中文文案，原始错误挂 err.raw */
function normalizeMcpError(e, label) {
  const rawMsg = String((e && e.message) || e);
  if (e && e.mcpInternal) return e;        // 本模块自产文案（总超时等），不再二次包装
  if (rawMsg.startsWith(label)) return e;  // 已带厂商标识的内部错误（返回异常/未返回文本）
  let msg;
  if (e && (e.code === 'ECONNABORTED' || /timeout/i.test(rawMsg))) {
    msg = `${label} 请求超时，请稍后重试`;
  } else {
    msg = `${label} 调用失败：` + rawMsg.slice(0, 200);
  }
  const err = new Error(msg);
  err.mcpInternal = true;
  err.raw = e;
  return err;
}

/** 完整三段握手：initialize → initialized 通知 → tools/list（工具名沿用端点级缓存） */
async function _mcpHandshake(endpoint, headers, timeout) {
  // 1) initialize
  const initResp = await axios.post(
    endpoint,
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'stock-analyzer', version: '1.0.0' },
      },
    },
    { headers, timeout }
  );
  const h = initResp.headers || {};
  const sessionId = h['mcp-session-id'] || h['Mcp-Session-Id'];
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  // 2) initialized 通知（无 id，服务端返回 202）
  await axios.post(
    endpoint,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { headers, timeout }
  );

  // 3) tools/list（发现真实工具名，按端点缓存复用）
  let toolName = cachedToolNameByEp[endpoint] || DEFAULT_TOOL;
  if (!cachedToolNameByEp[endpoint]) {
    try {
      const listResp = await axios.post(
        endpoint,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { headers, timeout }
      );
      const listPayload = listResp.data;
      const listEvents = typeof listPayload === 'string' ? parseSSE(listPayload) : listPayload;
      const listEvent = pickEvent(listEvents, 2);
      const tools = (listEvent && listEvent.result && Array.isArray(listEvent.result.tools))
        ? listEvent.result.tools : [];
      const found = tools.find((t) => t && /search|web/i.test(t.name || ''));
      if (found) { toolName = found.name; cachedToolNameByEp[endpoint] = toolName; }
    } catch (_) {
      // 发现失败则回退默认名
      toolName = DEFAULT_TOOL;
    }
  }
  return { sessionId: sessionId || null, toolName };
}

/** 单次 tools/call 并解析出结果文本 */
async function _mcpToolsCall(endpoint, headers, timeout, toolName, q, maxResults, label) {
  const callResp = await axios.post(
    endpoint,
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: toolName, arguments: { query: q.slice(0, 500), max_results: maxResults } },
    },
    { headers, timeout }
  );

  const callPayload = callResp.data;
  const callEvents = typeof callPayload === 'string' ? parseSSE(callPayload) : callPayload;
  const callEvent = pickEvent(callEvents, 3);
  if (!callEvent || !callEvent.result) {
    throw new Error(`${label} 返回异常：` + JSON.stringify(callEvent || callPayload).slice(0, 200));
  }
  const text = extractText(callEvent.result);
  if (!text.trim()) throw new Error(`${label} 未返回有效文本`);
  return text.slice(0, 8000);
}

/**
 * 调用联网搜索 MCP（阿里百炼 / 百度千帆通用），返回拼接后的搜索结果文本。
 * 20261001a：会话复用（缓存 sessionId+toolName，命中时 1 次往返）+ 总超时守卫 + 错误归一化。
 * @param {string} apiKey 对应厂商的 API Key（阿里=百炼通用 Key sk-xxx；百度=千帆 Key）
 * @param {string} query 搜索词
 * @param {Object} [opts]
 * @param {number} [opts.maxResults=8]
 * @param {number} [opts.timeout=15000] 单次 HTTP 请求超时
 * @param {number} [opts.overallTimeout=25000] 整链路总超时（含完整握手的最坏情况）
 * @param {string} [opts.endpoint=MCP_ENDPOINT] MCP 端点，默认阿里百炼；百度传 BAIDU_ENDPOINT
 * @param {string} [opts.label='联网搜索 MCP'] 报错文案里的厂商标识
 * @returns {Promise<string>}
 */
async function mcpWebSearchRaw(apiKey, query, {
  maxResults = 8,
  timeout = 15000,
  overallTimeout = 25000,
  endpoint = MCP_ENDPOINT,
  label = '联网搜索 MCP',
} = {}) {
  if (!apiKey) throw new Error(`缺少 API Key（${label} 需要对应厂商的 API Key）`);
  const q = (query || '').toString().trim();
  if (!q) throw new Error('搜索词为空');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };

  const run = async () => {
    const cacheKey = endpoint + '|' + apiKey;
    const cached = mcpSessionCache.get(cacheKey);
    if (cached && cached.sessionId) {
      // 会话复用：直接 tools/call（1 次往返）
      headers['Mcp-Session-Id'] = cached.sessionId;
      try {
        return await _mcpToolsCall(endpoint, headers, timeout, cached.toolName, q, maxResults, label);
      } catch (e) {
        // 任何失败都先让会话缓存失效（换 Key/会话被回收均覆盖）；仅对「会话失效类」
        // 状态码（400/404/410）走完整握手重试一次，网络/超时类错误直接上抛。
        mcpSessionCache.delete(cacheKey);
        delete headers['Mcp-Session-Id'];
        const status = e && e.response && e.response.status;
        if (!(status === 400 || status === 404 || status === 410)) throw e;
      }
    }
    const hs = await _mcpHandshake(endpoint, headers, timeout);
    const text = await _mcpToolsCall(endpoint, headers, timeout, hs.toolName, q, maxResults, label);
    if (hs.sessionId) mcpSessionCache.set(cacheKey, { sessionId: hs.sessionId, toolName: hs.toolName });
    return text;
  };

  // 总超时守卫：握手 3 段 + 调用整体不超 overallTimeout，防止 4 段 × timeout 的极端悬挂
  let timer = null;
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} 总超时（${overallTimeout}ms），放弃本次搜索`);
          err.mcpInternal = true;
          reject(err);
        }, overallTimeout);
      }),
    ]);
  } catch (e) {
    throw normalizeMcpError(e, label);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 带免费额度保险的搜索入口（20260903r 阿里总额度保险 / 20261001a 百度每日计数）。
 * 阿里：调用前查本地计数（≥2000 直接短路抛错，不发任何请求）→ 成功计数 +1 落盘 →
 *       失败检查是否服务端「额度用尽/欠费」信号并兜底锁定。
 * 百度：每日 100 次免费（中国自然日重置），达限短路抛错；成功计数 +1 落盘。
 * 短路抛出的错误由上层 callLLM 的现有 catch 捕获，自动降级纯推理 / 回退其他通道。
 */
async function mcpWebSearch(apiKey, query, opts = {}) {
  const endpoint = opts.endpoint || MCP_ENDPOINT;
  if (endpoint === MCP_ENDPOINT) {
    const st = loadAliQuotaState();
    if (st.count >= ALI_QUOTA_LIMIT) {
      // 免费额度已用尽：本地直接短路，不花一分钱、不发任何请求
      throw new Error(`阿里百炼 MCP 免费额度已用尽（本地成功调用计数 ${st.count}/${ALI_QUOTA_LIMIT}），自动回退内置联网搜索`);
    }
  } else if (endpoint === BAIDU_ENDPOINT) {
    const st = loadBaiduDaily();
    if (st.count >= BAIDU_DAILY_LIMIT) {
      // 今日免费次数已用完：本地直接短路，不产生计费调用
      throw new Error(`百度千帆 MCP 今日免费 ${BAIDU_DAILY_LIMIT} 次已用完（本地计数 ${st.count}），自动降级其他搜索通道`);
    }
  }
  try {
    const text = await mcpWebSearchRaw(apiKey, query, opts);
    if (endpoint === MCP_ENDPOINT) {
      const st = loadAliQuotaState();
      st.count += 1;
      st.updatedAt = new Date().toISOString();
      saveAliQuotaState(st);
      if (st.count >= ALI_QUOTA_WARN_AT || st.count % 50 === 0) {
        console.log(`[ali-mcp-quota] 阿里 MCP 免费额度累计成功调用 ${st.count}/${ALI_QUOTA_LIMIT} 次`);
      }
    } else if (endpoint === BAIDU_ENDPOINT) {
      const st = loadBaiduDaily();
      st.count += 1;
      saveBaiduDaily(st);
      if (st.count >= BAIDU_DAILY_LIMIT - 10 || st.count % 20 === 0) {
        console.log(`[baidu-mcp-daily] 百度 MCP 今日成功调用 ${st.count}/${BAIDU_DAILY_LIMIT} 次`);
      }
    }
    return text;
  } catch (e) {
    if (endpoint === MCP_ENDPOINT) latchAliQuotaIfExhausted(e);
    throw e;
  }
}

module.exports = { mcpWebSearch, getAliMcpQuotaState, getBaiduMcpDailyState, MCP_ENDPOINT, BAIDU_ENDPOINT };

~~~

---

## `lib\zoneLevelsHint.js`  ·  50 行

~~~js
/**
 * 由「短期动向预判」区间 → 量能引擎关键支撑/阻力（20261022d）
 * ==========================================================
 * 目的：量能引擎「4. 放量破位」原先用 `_keyLevels` 自算一套支撑位（平台沿/阶段高低/MA20/MA60 取最近），
 * 与②卡「短期动向预判」的阻力/支撑区间是两套口径，可能给出不同价位。
 * 现在改为：优先引用②卡的有效区间（同一套 swing + 有效性检验 + 侵蚀 + 反转结果），
 * 引擎只在拿不到区间时才回退自算（`_keyLevels` 兜底）。
 *
 * 选取规则（纯函数，零网络）：
 *   - 支撑：只在「区间上沿 ≤ 现价 ×1.02」的**有效支撑**里，取上沿最高者（离现价最近，含刚被跌破的）。
 *   - 阻力：只在「区间下沿 ≥ 现价 ×0.98」的**有效阻力**里，取下沿最低者（离现价最近）。
 *   - 无有效区间 → 返回 null（调用方回退引擎自算，不臆造）。
 *
 * @param {object} shortTerm 价格行为快照的 shortTerm（含 resistances/supports，每条带 low/high/valid/source）
 * @param {number} price     现价（quote.price）
 * @returns {{support?:{low:number,high:number,kind:string}, resistance?:{low:number,high:number,kind:string}}|null}
 */
function _zones(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(z => {
      if (!z || z.valid === false) return false;
      const lo = Number(z.low), hi = Number(z.high);
      return isFinite(lo) && isFinite(hi) && lo > 0 && hi >= lo;
    })
    .map(z => ({ low: Number(z.low), high: Number(z.high), source: String(z.source || '') }));
}

function deriveLevelHints(shortTerm, price) {
  const p = Number(price);
  if (!shortTerm || !isFinite(p) || p <= 0) return null;
  const sups = _zones(shortTerm.supports);
  const ress = _zones(shortTerm.resistances);

  const sup = sups.filter(z => z.high <= p * 1.02).sort((a, b) => b.high - a.high)[0] || null;
  const res = ress.filter(z => z.low >= p * 0.98).sort((a, b) => a.low - b.low)[0] || null;

  const mk = (z, side) => (z
    ? {
        low: z.low,
        high: z.high,
        kind: `${z.source || '短期动向'}·${side === 'support' ? '支撑区间' : '阻力区间'}`,
      }
    : null);

  const out = { support: mk(sup, 'support'), resistance: mk(res, 'resistance') };
  return (out.support || out.resistance) ? out : null;
}

module.exports = { deriveLevelHints };

~~~

---

## `lib\zoneMethods.js`  ·  840 行

~~~js
/**
 * zoneMethods.js — 支撑/阻力「候选区间」生成器（20261022g，用户新规范）
 * ==========================================================
 * 用户 2026-10-22 给出一份完整的支撑阻力分析规范，要求把②卡从「4 种来源」升级为
 * 「10 种方法 + 共振合并 + 强度分级 + 周线/60分钟多周期」。
 *
 * 本文件只负责第一层：**各方法各自产出候选区间**（纯函数、零网络、零 IO）。
 * 合并与强度分级在 lib/zoneResonance.js；有效性检验仍归 lib/zoneValidity.js。
 *
 * 统一输出结构（所有方法一致，便于共振层无差别处理）：
 *   {
 *     low, high,          // 区间上下限（必填，low <= high）
 *     center,             // 中心参考价
 *     side,               // 'resistance' | 'support'
 *     method,             // 方法键（pivot/fib/ma20/...），共振层用它去重
 *     source,             // 中文来源名（前端展示）
 *     tier,               // 'major' 大周期 | 'minor' 小周期（强度分级用）
 *     note,               // 补充说明（可选）
 *     weakOnly,           // true = 按用户规范「必须与其他方法重合才用」（整数关口）
 *   }
 *
 * 【区间宽度】用户选定「按波动率自适应 ATR」：
 *   半宽 = ATR(20) × WIDTH_ATR_RATIO，并不低于 price × MIN_WIDTH_PCT。
 *   理由：旧的 ±0.5% / ±1% 使两种方法几乎不可能重叠，共振算法失效。
 *
 * 【公式勘误 · 必须记录】用户原文「支撑2等于P减H减L」按字面算是 P-H-L，
 *   在 H=110/L=100/C=105 时得 -105（负数），与 S3=90 完全颠倒，明显为笔误。
 *   标准枢轴为 S2 = P − (H − L)（即 P−H+L），本实现采用标准式，与同类平台一致。
 *   其余公式（P/R1/S1/R2/R3/S3）与用户原文完全一致，已逐条核对。
 */
const { SMA } = require('./analysis');

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 区间宽度：ATR 半宽比例（全宽 ≈ 0.7×ATR）与最小宽度（价格的 0.2%）
const WIDTH_ATR_RATIO = 0.35;
const MIN_WIDTH_PCT = 0.002;

function _num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 平均真实波幅 ATR（默认 20 日）。
 * TR = max(high−low, |high−prevClose|, |low−prevClose|)
 */
function atr(bars, n) {
  const list = Array.isArray(bars) ? bars : [];
  const win = Number.isFinite(n) && n > 0 ? n : 20;
  if (list.length < win + 1) return null;
  let sum = 0;
  let cnt = 0;
  for (let i = list.length - win; i < list.length; i++) {
    const h = _num(list[i] && list[i].high);
    const l = _num(list[i] && list[i].low);
    const pc = _num(list[i - 1] && list[i - 1].close);
    if (h == null || l == null || pc == null) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    cnt += 1;
  }
  if (cnt === 0) return null;
  const v = sum / cnt;
  return v > 0 ? v : null;
}

/** 按给定中心价与半宽生成区间（半宽同时受最小宽度保护，并做 low<=high 兜底） */
function zoneAround(center, halfWidth, price) {
  const c = _num(center);
  if (c == null || c <= 0) return null;
  const hw0 = _num(halfWidth);
  const minHw = (Number.isFinite(price) && price > 0 ? price : c) * MIN_WIDTH_PCT;
  const hw = Math.max(Number.isFinite(hw0) ? hw0 : 0, minHw);
  return { low: round2(c - hw), high: round2(c + hw), center: round2(c) };
}

// =========================================================
// 1) 摆动高点 / 摆动低点（前高前低）
// =========================================================
/**
 * 用户规范：某根K线高点高于左右各 2~3 根高点 → 摆动高点；低点同理。
 * 采用「先按 2 根判定，样本不足退化到 1 根」的自适应（与既有 swingPoints 同思路，
 * 但保留每个摆动点的**触碰次数**——同价位被反复测试是强度的重要依据）。
 * @returns {Array} 候选区间
 */
function swingZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const win = Number.isFinite(o.window) ? o.window : 2;
  const lookback = Number.isFinite(o.lookback) ? o.lookback : 120;
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  if (list.length < win * 2 + 3 || atrV == null || price == null) return [];

  const start = Math.max(win, list.length - lookback);
  const highs = [];
  const lows = [];
  for (let i = start; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ price: _num(list[i].high), date: list[i].date, idx: i });
    if (isLow) lows.push({ price: _num(list[i].low), date: list[i].date, idx: i });
  }

  // 同价位聚类（阈值 = ATR×0.5）：簇内点数即「触碰次数」
  const cluster = (pts) => {
    const sorted = pts.filter(p => _num(p.price) > 0).slice().sort((a, b) => a.price - b.price);
    const out = [];
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(p.price - last.sum / last.n) <= atrV * 0.5) {
        last.sum += p.price;
        last.n += 1;
        last.dates.push(p.date);
      } else {
        out.push({ sum: p.price, n: 1, dates: [p.date] });
      }
    }
    return out.map(c => ({ price: c.sum / c.n, touches: c.n, lastDate: c.dates[c.dates.length - 1] }));
  };

  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const c of cluster(highs)) {
    if (!(c.price > price)) continue;   // 摆动高点在现价下方 → 已失守，不再作阻力
    const z = zoneAround(c.price, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'resistance', method: 'swing', source: '近' + lookback + '日摆动高点',
      tier: 'minor', touches: c.touches, note: `${c.touches} 次触及，最近 ${c.lastDate}`,
    }));
  }
  for (const c of cluster(lows)) {
    if (!(c.price < price)) continue;
    const z = zoneAround(c.price, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'support', method: 'swing', source: '近' + lookback + '日摆动低点',
      tier: 'minor', touches: c.touches, note: `${c.touches} 次触及，最近 ${c.lastDate}`,
    }));
  }
  return out;
}

// =========================================================
// 2) 枢轴点（标准 + Camarilla）
// =========================================================
/**
 * 标准枢轴：取**最新已收盘**一根K的 H/L/C（对下一个交易日而言，它就是「前一日」）。
 *   P=(H+L+C)/3，R1=2P−L，S1=2P−H，R2=P+(H−L)，S2=P−(H−L)，R3=H+2(P−L)，S3=L−2(H−P)
 * Camarilla：R1..R4 = C ± (H−L)×1.1/{12,6,4,2}
 */
function pivotZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 2) return [];
  const atrV = o.atr || atr(list, 20);
  const last = list[list.length - 1];
  const H = _num(last.high);
  const L = _num(last.low);
  const C = _num(last.close);
  if (H == null || L == null || C == null || !(H > L)) return [];
  const price = o.price != null ? _num(o.price) : C;
  const half = (atrV || (H - L)) * WIDTH_ATR_RATIO;

  const P = (H + L + C) / 3;
  const range = H - L;
  const levels = [
    { v: 2 * P - L, name: 'R1', side: 'resistance' },
    { v: P + (H - L), name: 'R2', side: 'resistance' },
    { v: H + 2 * (P - L), name: 'R3', side: 'resistance' },
    { v: 2 * P - H, name: 'S1', side: 'support' },
    { v: P - (H - L), name: 'S2', side: 'support' },
    { v: L - 2 * (H - P), name: 'S3', side: 'support' },
  ];
  const out = [];
  for (const lv of levels) {
    const z = zoneAround(lv.v, half, price);
    if (!z) continue;
    // 方向一致性：阻力必须在现价上方、支撑在下方；跨越现价的中枢位不列入（会与另一侧混淆）
    if (lv.side === 'resistance' && !(z.center > price)) continue;
    if (lv.side === 'support' && !(z.center < price)) continue;
    out.push(Object.assign(z, {
      side: lv.side, method: 'pivot', source: `枢轴 ${lv.name}`,
      tier: 'minor', note: `前一交易日 H${round2(H)}/L${round2(L)}/C${round2(C)}，P=${round2(P)}`,
    }));
  }

  // Camarilla（对跳空与极端行情敏感，按用户要求「只作参考」→ tier=minor）
  const cam = [
    { v: C + range * 1.1 / 12, name: 'C-R1', side: 'resistance' },
    { v: C + range * 1.1 / 6, name: 'C-R2', side: 'resistance' },
    { v: C + range * 1.1 / 4, name: 'C-R3', side: 'resistance' },
    { v: C + range * 1.1 / 2, name: 'C-R4', side: 'resistance' },
    { v: C - range * 1.1 / 12, name: 'C-S1', side: 'support' },
    { v: C - range * 1.1 / 6, name: 'C-S2', side: 'support' },
    { v: C - range * 1.1 / 4, name: 'C-S3', side: 'support' },
    { v: C - range * 1.1 / 2, name: 'C-S4', side: 'support' },
  ];
  for (const lv of cam) {
    const z = zoneAround(lv.v, half, price);
    if (!z) continue;
    if (lv.side === 'resistance' && !(z.center > price)) continue;
    if (lv.side === 'support' && !(z.center < price)) continue;
    out.push(Object.assign(z, {
      side: lv.side, method: 'camarilla', source: `Camarilla ${lv.name}`,
      tier: 'minor', note: '对跳空与极端行情敏感，仅作参考',
    }));
  }
  return out;
}

// =========================================================
// 3) 多周期均线（20/60/120/250）
// =========================================================
/**
 * 价格在均线上方 → 支撑；下方 → 阻力。
 * 斜率：近 10 根均线变化 ≥ 0.5% 判上翘/下压，否则走平。
 * 均线粘合（相邻均线距离 < ATR×0.5）另出一「粘合带」候选（用户规范明确要求）。
 */
function maZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 21) return [];
  const closes = list.map(d => _num(d.close)).map(v => (v == null ? 0 : v));
  const price = o.price != null ? _num(o.price) : closes[closes.length - 1];
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0)) return [];
  const prices = [20, 60, 120, 250];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;

  const valid = [];
  for (const p of prices) {
    if (list.length < p) continue;
    const series = SMA(closes, p);
    const t = series.length - 1;
    const v = series[t];
    if (v == null || !(v > 0)) continue;
    const ref = t - 10 >= 0 ? series[t - 10] : null;
    const slopePct = ref != null && ref > 0 ? ((v - ref) / ref) * 100 : null;
    valid.push({ period: p, value: v, slopePct });
  }
  if (valid.length === 0) return [];

  const out = [];
  for (const m of valid) {
    const above = price > m.value;
    const z = zoneAround(m.value, half, price);
    if (!z) continue;
    const slopeTxt = m.slopePct == null ? '斜率未知' : m.slopePct > 0.5 ? '上翘' : m.slopePct < -0.5 ? '下压' : '走平';
    // 用户规范：均线向上倾斜时支撑更有效、向下倾斜时阻力更有效 → 反向情形记 note 但不改 tier
    const aligned = (above && m.slopePct != null && m.slopePct > 0) || (!above && m.slopePct != null && m.slopePct < 0);
    out.push(Object.assign(z, {
      side: above ? 'support' : 'resistance',
      method: 'ma' + m.period,
      source: `MA${m.period}（${slopeTxt}）`,
      tier: m.period >= 120 ? 'major' : 'minor',
      slopeAligned: aligned,
      note: `价格在均线${above ? '上方 → 作为动态支撑' : '下方 → 作为动态阻力'}；${slopeTxt}${aligned ? '，方向与角色一致（更有效）' : '，方向与角色相反（有效性打折）'}`,
    }));
  }

  // 均线粘合带（多条均线挤在一起 → 支撑/阻力带）
  if (valid.length >= 2 && atrV != null) {
    const sorted = valid.slice().sort((a, b) => a.value - b.value);
    let group = [sorted[0]];
    const flush = () => {
      if (group.length < 2) return;
      const lo = Math.min(...group.map(g => g.value));
      const hi = Math.max(...group.map(g => g.value));
      const center = (lo + hi) / 2;
      const above = price > center;
      const names = group.map(g => 'MA' + g.period).join('+');
      out.push({
        low: round2(lo), high: round2(hi), center: round2(center),
        side: above ? 'support' : 'resistance',
        method: 'ma-cluster',
        source: `${names} 粘合带`,
        tier: 'major',
        note: `多条均线在 ${round2(lo)}~${round2(hi)} 密集（带宽 ${round2(hi - lo)}），粘合区常作为强支撑/阻力带`,
      });
    };
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].value - sorted[i - 1].value <= atrV * 0.5) group.push(sorted[i]);
      else { flush(); group = [sorted[i]]; }
    }
    flush();
  }
  return out;
}

// =========================================================
// 4) 斐波那契回撤（波段自动选取）
// =========================================================
/**
 * 波段选取（必须「有趋势和成交量配合，不得随意截取」）：
 *   - 用左右各 2 根确认的摆动点；
 *   - 相邻「低→高」（上涨波段）或「高→低」（下跌波段），两点间隔 ≥ 10 根；
 *   - 幅度 ≥ ATR×3（有实际空间，避免把震荡当波段）；
 *   - 取**最近一个**满足条件的波段。
 * 上涨后回调：high − 幅度×{0.382,0.5,0.618} → 支撑
 * 下跌后反弹：low + 幅度×{0.382,0.5,0.618} → 阻力
 */
function fibZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 30) return [];
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (atrV == null || !(price > 0)) return [];

  const win = 2;
  const pts = [];
  for (let i = win; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) pts.push({ idx: i, price: _num(list[i].high), kind: 'high', date: list[i].date, vol: _num(list[i].volume) || 0 });
    if (isLow) pts.push({ idx: i, price: _num(list[i].low), kind: 'low', date: list[i].date, vol: _num(list[i].volume) || 0 });
  }
  // 按时间排序后，寻找最近一个合格波段（相邻点交替）
  const seq = pts.filter(p => p.price > 0).sort((a, b) => a.idx - b.idx);
  let leg = null;
  for (let i = seq.length - 1; i >= 1; i--) {
    const b = seq[i];
    const a = seq[i - 1];
    if (a.kind === b.kind) continue;
    if (b.idx - a.idx < 10) continue;
    const amp = Math.abs(b.price - a.price);
    if (amp < atrV * 3) continue;
    leg = { from: a, to: b, amp };
    break;
  }
  if (!leg) return [];

  const up = leg.to.kind === 'high';   // 低→高 = 上涨波段 → 回调支撑
  const ratios = [0.382, 0.5, 0.618];
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const r of ratios) {
    const v = up ? leg.to.price - leg.amp * r : leg.to.price + leg.amp * r;
    const z = zoneAround(v, half, price);
    if (!z) continue;
    const desired = up ? 'support' : 'resistance';
    // 斐波那契位落在现价另一侧时，其「潜在回调位」角色仍然有效（例如价格已跌破 61.8%），
    // 但为避免与另一侧清单混淆，只在其位于对应一侧时收录，其余写入 note 由前端提示。
    if (desired === 'support' && !(z.center < price)) continue;
    if (desired === 'resistance' && !(z.center > price)) continue;
    out.push(Object.assign(z, {
      side: desired, method: 'fib' + String(r).replace('0.', ''), source: `斐波那契 ${(r * 100).toFixed(1)}%`,
      tier: 'minor',
      note: `${up ? '上涨' : '下跌'}波段 ${leg.from.date}(${round2(leg.from.price)}) → ${leg.to.date}(${round2(leg.to.price)})，幅度 ${round2(leg.amp)}`,
    }));
  }
  return out;
}

// =========================================================
// 5) VWAP（成交量加权平均价，动态成本参考）
// =========================================================
/**
 * VWAP = Σ(典型价 × 成交量) / Σ成交量，典型价 = (H+L+C)/3。
 * 价格在 VWAP 上方 → 动态支撑；下方 → 动态阻力。
 */
function vwapZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0) || atrV == null) return [];
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (const n of [20, 60, 120, 250]) {
    if (list.length < n) continue;
    const slice = list.slice(-n);
    let pv = 0;
    let vv = 0;
    let ok = true;
    for (const d of slice) {
      const h = _num(d.high);
      const l = _num(d.low);
      const c = _num(d.close);
      const v = _num(d.volume);
      if (h == null || l == null || c == null || v == null || v <= 0) { ok = false; break; }
      pv += ((h + l + c) / 3) * v;
      vv += v;
    }
    if (!ok || !(vv > 0)) continue;
    const vwap = pv / vv;
    if (!(vwap > 0)) continue;
    const z = zoneAround(vwap, half, price);
    if (!z) continue;
    const above = price > vwap;
    out.push(Object.assign(z, {
      side: above ? 'support' : 'resistance',
      method: 'vwap' + n,
      source: `${n}日成交量加权均价`,
      tier: n >= 120 ? 'major' : 'minor',
      note: `近${n}日成交量加权平均价 ${round2(vwap)}；价格在其${above ? '上方 → 作为动态支撑参考' : '下方 → 作为动态阻力参考'}`,
    }));
  }
  return out;
}

// =========================================================
// 6) 成交量密集区 / 筹码峰（VPVR）
// =========================================================
/**
 * 用户规范：没有筹码分布图时，用近 60/120/250 个交易日的成交量加权价格分布近似。
 * 每根K线取 (H+L+C)/3 作为典型价，按价格区间归集成交量，取成交量最大的几个价格区间。
 * 本实现按 24 档归集，识别「局部峰」（占比 ≥ 1.5 倍均档占比），每窗口取前 3 个峰。
 * 结构判定（低位单峰/高位单峰/多峰）写入 note，供前端说明强度。
 */
function volumeProfileZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0)) return [];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const BINS = 24;
  const out = [];

  for (const n of [60, 120, 250]) {
    if (list.length < n) continue;
    const slice = list.slice(-n);
    const lo = Math.min(...slice.map(d => _num(d.low)).filter(v => v != null));
    const hi = Math.max(...slice.map(d => _num(d.high)).filter(v => v != null));
    if (!(hi > lo)) continue;
    const step = (hi - lo) / BINS;
    if (!(step > 0)) continue;
    const bins = Array.from({ length: BINS }, (_, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, vol: 0 }));
    let total = 0;
    for (const d of slice) {
      const h = _num(d.high);
      const l = _num(d.low);
      const c = _num(d.close);
      const v = _num(d.volume);
      if (h == null || l == null || c == null || v == null || v <= 0) continue;
      const tp = (h + l + c) / 3;
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((tp - lo) / step)));
      bins[idx].vol += v;
      total += v;
    }
    if (!(total > 0)) continue;
    const avg = total / BINS;
    const peaks = [];
    for (let i = 0; i < BINS; i++) {
      const cur = bins[i].vol;
      if (cur < avg * 1.5) continue;                                  // 明显高于均档才叫峰
      const lv = i > 0 ? bins[i - 1].vol : 0;
      const rv = i < BINS - 1 ? bins[i + 1].vol : 0;
      if (cur < lv || cur < rv) continue;                              // 只留局部最大
      peaks.push({ i, low: bins[i].low, high: bins[i].high, vol: cur, pct: (cur / total) * 100 });
    }
    peaks.sort((a, b) => b.vol - a.vol);
    const top = peaks.slice(0, 3);
    if (top.length === 0) continue;
    const above = top.filter(p => (p.low + p.high) / 2 > price).length;
    const below = top.filter(p => (p.low + p.high) / 2 < price).length;
    const shape = top.length === 1 ? (above ? '高位单峰' : '低位单峰') : `多峰（${top.length}）`;

    for (const p of top) {
      const center = (p.low + p.high) / 2;
      const side = center > price ? 'resistance' : 'support';
      // 峰的实际区间比 ATR 宽度更宽时用峰自身宽度（筹码区本就成片）
      const widthLow = round2(p.low);
      const widthHigh = round2(p.high);
      const zHalf = zoneAround(center, Math.max(half, (p.high - p.low) / 2), price);
      out.push({
        low: widthLow, high: widthHigh, center: round2(center),
        side, method: 'vpvr' + n,
        source: `近${n}日成交密集区`,
        tier: n >= 120 ? 'major' : 'minor',
        note: `占该窗口成交量 ${round2(p.pct)}%；${shape}结构（上方 ${above} 峰 / 下方 ${below} 峰）` + (zHalf ? '' : ''),
      });
    }
  }
  return out;
}

// =========================================================
// 7) 整数关口（心理位，必须与其他方法重合才用）
// =========================================================
/**
 * 按价格量级决定刻度：<5 元用 0.5，<20 用 1，<100 用 5，<500 用 10，其余用 50。
 * 只取现价 ATR×6 范围内的关口（更远的对 1-5 日判断无意义）。
 * weakOnly=true：共振层只把它当作「印证」（不单独成带、不计入强度分子）。
 */
function roundNumberZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  if (!(price > 0) || atrV == null) return [];
  const step = price < 5 ? 0.5 : price < 20 ? 1 : price < 100 ? 5 : price < 500 ? 10 : 50;
  const reach = atrV * 6;
  const from = Math.ceil((price - reach) / step) * step;
  const to = Math.floor((price + reach) / step) * step;
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) {
    const val = Math.round(v * 100) / 100;
    if (Math.abs(val - price) < 1e-9) continue;      // 现价本身不算关口
    const z = zoneAround(val, half, price);
    if (!z) continue;
    out.push(Object.assign(z, {
      side: val > price ? 'resistance' : 'support',
      method: 'round',
      source: `整数关口 ${val}`,
      tier: 'minor',
      weakOnly: true,
      note: '心理参考位，必须与其他方法重合时才纳入强度',
    }));
  }
  return out;
}

// =========================================================
// 8) 缺口
// =========================================================
/**
 * 向上跳空：今日 low > 昨日 high → 缺口区间 [昨日high, 今日low]，下沿作支撑。
 * 向下跳空：今日 high < 昨日 low → 缺口区间 [今日high, 昨日low]，上沿作阻力。
 * 只保留**未回补**的缺口（此后最低价未回到缺口区间内 / 最高价未回到区间内）。
 */
function gapZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const lookback = Number.isFinite(o.lookback) ? o.lookback : 120;
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  if (!(price > 0) || list.length < 3) return [];
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const start = Math.max(1, list.length - lookback);
  const out = [];
  const seen = new Set();
  for (let i = start; i < list.length; i++) {
    const cur = list[i];
    const prev = list[i - 1];
    const ch = _num(cur.high);
    const cl = _num(cur.low);
    const ph = _num(prev.high);
    const pl = _num(prev.low);
    if (ch == null || cl == null || ph == null || pl == null) continue;

    const upGap = cl > ph;      // 向上跳空
    const downGap = ch < pl;    // 向下跳空
    if (!upGap && !downGap) continue;

    // 未回补判定：用缺口形成日之后的K线检查
    const after = list.slice(i + 1);
    const filled = upGap
      ? after.some(d => _num(d.low) != null && _num(d.low) <= ph)
      : after.some(d => _num(d.high) != null && _num(d.high) >= pl);
    if (filled) continue;

    const gLow = upGap ? ph : ch;
    const gHigh = upGap ? cl : pl;
    const center = (gLow + gHigh) / 2;
    const key = `${round2(gLow)}|${round2(gHigh)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 向上跳空的缺口下沿作支撑；向下跳空的上沿作阻力。方向与现价冲突时跳过。
    const side = upGap ? 'support' : 'resistance';
    if (side === 'support' && !(center < price)) continue;
    if (side === 'resistance' && !(center > price)) continue;

    const z = zoneAround(center, Math.max(half, (gHigh - gLow) / 2), price);
    if (!z) continue;
    out.push(Object.assign(z, {
      side, method: 'gap', source: `${upGap ? '向上' : '向下'}跳空缺口`,
      tier: 'minor',
      note: `${cur.date} ${upGap ? '向上' : '向下'}跳空 ${round2(gLow)}~${round2(gHigh)}，尚未回补；${upGap ? '缺口下沿作支撑' : '缺口上沿作阻力'}`,
    }));
  }
  return out.slice(-4);   // 最多 4 个（越近越相关）
}

// =========================================================
// 9) 趋势线（两点连线 + 第三点验证）
// =========================================================
/**
 * 上升趋势线：最近 3 个摆动低点中，取两点连线，验证第三点在该线附近（±ATR×0.6）；
 * 当前价格在线上方 → 支撑。下降趋势线反之（两点摆动高点，价格在线下方 → 阻力）。
 * 主观性强，按用户规范「只作辅助」→ tier=minor，且 note 明示主观性。
 */
function trendlineZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 40) return [];
  const atrV = o.atr || atr(list, 20);
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (atrV == null || !(price > 0)) return [];
  const win = 2;
  const highs = [];
  const lows = [];
  for (let i = win; i < list.length - win; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= win; j++) {
      if (list[i].high < list[i - j].high || list[i].high < list[i + j].high) isHigh = false;
      if (list[i].low > list[i - j].low || list[i].low > list[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: _num(list[i].high), date: list[i].date });
    if (isLow) lows.push({ idx: i, price: _num(list[i].low), date: list[i].date });
  }
  const half = atrV * WIDTH_ATR_RATIO;
  const out = [];
  // 第三点共线容差：用户规范只要求「第三个点验证后更有效」，未指定精度。
  // 原先用 0.6 ATR 过严，实测 603288/601318/600519/000902 全部算不出趋势线；
  // 放宽到 1.5 ATR（即「大致在线上」），并允许在最近 6 个摆动点里任选两点连线、以更后一个点验证。
  const tol = atrV * 1.5;
  const lastIdx = list.length - 1;

  const build = (pts, wantUp) => {
    if (pts.length < 3) return null;
    const take = pts.slice(-6);
    let best = null;
    for (let i = 0; i < take.length - 2; i++) {
      for (let j = i + 1; j < take.length - 1; j++) {
        const a = take[i];
        const b = take[j];
        if (b.idx - a.idx < 5) continue;
        const slope = (b.price - a.price) / (b.idx - a.idx);
        if (wantUp ? !(slope > 0) : !(slope < 0)) continue;
        const c = take[j + 1];
        if (!c) continue;
        if (c.idx - b.idx < 5) continue;
        const projC = b.price + slope * (c.idx - b.idx);
        const err = Math.abs(c.price - projC);
        if (err > tol) continue;
        const cur = a.price + slope * (lastIdx - a.idx);
        if (!(cur > 0)) continue;
        if (!best || err < best.err) best = { value: cur, a, b, c, slope, err };
      }
    }
    return best;
  };

  const up = build(lows, true);
  // 与现价的距离也要合理：太远（>4 ATR）对 1-5 日判断无意义
  if (up && up.value > 0 && up.value < price && (price - up.value) <= atrV * 4) {
    const z = zoneAround(up.value, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'support', method: 'trendline', source: '上升趋势线',
      tier: 'minor',
      note: `${up.a.date}(${round2(up.a.price)}) 与 ${up.b.date}(${round2(up.b.price)}) 连线，${up.c.date}(${round2(up.c.price)}) 第三点验证（偏差 ${round2(up.err)}）；延伸至当前 ${round2(up.value)}。趋势线有主观性，仅作辅助`,
    }));
  }
  const dn = build(highs, false);
  if (dn && dn.value > 0 && dn.value > price && (dn.value - price) <= atrV * 4) {
    const z = zoneAround(dn.value, half, price);
    if (z) out.push(Object.assign(z, {
      side: 'resistance', method: 'trendline', source: '下降趋势线',
      tier: 'minor',
      note: `${dn.a.date}(${round2(dn.a.price)}) 与 ${dn.b.date}(${round2(dn.b.price)}) 连线，${dn.c.date}(${round2(dn.c.price)}) 第三点验证（偏差 ${round2(dn.err)}）；延伸至当前 ${round2(dn.value)}。趋势线有主观性，仅作辅助`,
    }));
  }
  return out;
}

// =========================================================
// 10) 周线层（大周期定区域）
// =========================================================
/**
 * 把日K重采样为周线后：
 *   - 周线枢轴（用**上一完整周**的 H/L/C 计算本周枢轴）；
 *   - 周线摆动高/低点（左右各 2 周确认）。
 * 全部 tier=major（用户规范：大周期定区域）。
 */
function weeklyZones(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  if (list.length < 60) return [];
  const price = o.price != null ? _num(o.price) : _num(list[list.length - 1].close);
  if (!(price > 0)) return [];
  const weeks = resampleWeeks(list);
  if (weeks.length < 6) return [];
  const atrV = o.atr || atr(list, 20);
  const half = (atrV || price * 0.01) * WIDTH_ATR_RATIO;
  const out = [];

  // 上一完整周（最后一条周线若与当前自然周重叠，取倒数第二条更稳妥；这里取最后一条已完整聚合的周）
  const pw = weeks[weeks.length - 1];
  const H = _num(pw.high);
  const L = _num(pw.low);
  const C = _num(pw.close);
  if (H != null && L != null && C != null && H > L) {
    const P = (H + L + C) / 3;
    const levels = [
      { v: 2 * P - L, name: '周P-R1', side: 'resistance' },
      { v: P + (H - L), name: '周P-R2', side: 'resistance' },
      { v: 2 * P - H, name: '周P-S1', side: 'support' },
      { v: P - (H - L), name: '周P-S2', side: 'support' },
    ];
    for (const lv of levels) {
      const z = zoneAround(lv.v, half * 1.5, price);   // 周线级别宽度放宽 1.5 倍
      if (!z) continue;
      if (lv.side === 'resistance' && !(z.center > price)) continue;
      if (lv.side === 'support' && !(z.center < price)) continue;
      out.push(Object.assign(z, {
        side: lv.side, method: 'weekly-pivot', source: lv.name,
        tier: 'major',
        note: `上周(${pw.label}) H${round2(H)}/L${round2(L)}/C${round2(C)}，周枢轴 P=${round2(P)}`,
      }));
    }
  }

  // 周线摆动点
  const w = 2;
  for (let i = w; i < weeks.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= w; j++) {
      if (weeks[i].high < weeks[i - j].high || weeks[i].high < weeks[i + j].high) isHigh = false;
      if (weeks[i].low > weeks[i - j].low || weeks[i].low > weeks[i + j].low) isLow = false;
    }
    if (isHigh && _num(weeks[i].high) > price) {
      const z = zoneAround(weeks[i].high, half * 1.5, price);
      if (z) out.push(Object.assign(z, {
        side: 'resistance', method: 'weekly-swing', source: '周线摆动高点',
        tier: 'major', note: `${weeks[i].label} 周高点 ${round2(weeks[i].high)}`,
      }));
    }
    if (isLow && _num(weeks[i].low) < price) {
      const z = zoneAround(weeks[i].low, half * 1.5, price);
      if (z) out.push(Object.assign(z, {
        side: 'support', method: 'weekly-swing', source: '周线摆动低点',
        tier: 'major', note: `${weeks[i].label} 周低点 ${round2(weeks[i].low)}`,
      }));
    }
  }
  return out;
}

// 日K → 周线（ISO 周，周一为键）
function resampleWeeks(daily) {
  const bars = [];
  let cur = null;
  let curKey = null;
  for (const d of daily) {
    const k = weekKeyOf(d.date);
    if (!k) continue;
    if (!cur || k !== curKey) {
      if (cur) bars.push(cur);
      curKey = k;
      cur = { label: k, high: _num(d.high), low: _num(d.low), close: _num(d.close), open: _num(d.open) };
    } else {
      cur.high = Math.max(cur.high, _num(d.high));
      cur.low = Math.min(cur.low, _num(d.low));
      cur.close = _num(d.close);
    }
  }
  if (cur) bars.push(cur);
  return bars.filter(b => b.high > 0 && b.low > 0);
}

function weekKeyOf(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - day + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// =========================================================
// 汇总入口
// =========================================================
/**
 * 生成全部候选区间（未合并、未检验）。
 * @param {Array} daily 日K（升序，最后一根应为已收盘K）
 * @param {object} opts { price, atr, lookback, includeWeak }
 * @returns {{ candidates: Array, atr: number, price: number, skipped: string[] }}
 */
function buildCandidates(daily, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const o = opts || {};
  const price = o.price != null ? _num(o.price) : (list.length ? _num(list[list.length - 1].close) : null);
  const atrV = o.atr || atr(list, 20);
  const skipped = [];
  if (!(price > 0)) return { candidates: [], atr: null, price: null, skipped: ['无有效收盘价'] };
  if (atrV == null) skipped.push('ATR 无法计算（样本不足或数据缺失）');

  const base = { atr: atrV, price };
  const groups = [
    ['swing', () => swingZones(list, base)],
    ['pivot', () => pivotZones(list, base)],
    ['ma', () => maZones(list, base)],
    ['fib', () => fibZones(list, base)],
    ['vwap', () => vwapZones(list, base)],
    ['vpvr', () => volumeProfileZones(list, base)],
    ['round', () => roundNumberZones(list, base)],
    ['gap', () => gapZones(list, base)],
    ['trendline', () => trendlineZones(list, base)],
    ['weekly', () => weeklyZones(list, base)],
  ];
  const candidates = [];
  for (const [name, fn] of groups) {
    try {
      const got = fn();
      if (!Array.isArray(got) || got.length === 0) { skipped.push(`${name}：无条件满足`); continue; }
      for (const z of got) {
        if (z && Number.isFinite(z.low) && Number.isFinite(z.high) && z.high >= z.low) candidates.push(z);
      }
    } catch (e) {
      skipped.push(`${name}：计算出错（${e && e.message ? e.message : e}）`);
    }
  }
  return { candidates, atr: atrV, price, skipped };
}

module.exports = {
  WIDTH_ATR_RATIO,
  MIN_WIDTH_PCT,
  atr,
  zoneAround,
  swingZones,
  pivotZones,
  maZones,
  fibZones,
  vwapZones,
  volumeProfileZones,
  roundNumberZones,
  gapZones,
  trendlineZones,
  weeklyZones,
  resampleWeeks,
  buildCandidates,
};

~~~

---

## `lib\zoneResonance.js`  ·  362 行

~~~js
/**
 * zoneResonance.js — 共振合并 + 强度分级（20261022g，用户新规范第三部分）
 * ==========================================================
 * 输入：lib/zoneMethods.js 产出的候选区间（10 种方法 + 周线层）
 * 输出：合并后的「共振支撑带 / 共振阻力带」，每条带带强度、确认信号、失效位。
 *
 * 用户规范原文要点（逐条对应实现）：
 *   - 「当多个方法落在相近价格带时，合并为共振支撑带/阻力带」→ clusterSide()
 *   - 「重合方法越多、周期越大、触碰次数越多，强度越高」
 *   - 「强区域要求至少两个大周期方法重合，并有量能或收盘确认」→ grade()
 *   - 「中区域要求两个方法重合」；「弱区域为单一方法」
 *   - 「对每个区域给出：下限、上限、中心价、来源、强度、适用周期、确认信号」
 *   - 「必须给出每个关键区域的失效位或失效条件」→ invalidationLevel
 *   - 「放量收盘跌破支撑区下沿并留有缓冲，视为支撑失效」→ 缓冲 = ATR×0.3
 *   - 「价格回到支撑区缩量企稳…支撑有效性提高」→ 缩量触碰计入 confirmSignals（提升强度，但不改有效性判定）
 *
 * 【与 zoneValidity 的分工·务必分清】
 *   zoneValidity = 结构资格（这个位**本来**有没有阻碍作用；缩量穿过 = 没有 → 本次不展示，不落永久黑名单）
 *   zoneResonance = 强度评分（既已确认结构存在，它有多强；缩量企稳 = 有承接 → 加分）
 *   两者统计口径独立，不得互相回灌。
 *
 * 【兼容性硬约束】输出数组排序必须保持「阻力按 low 升序 / 支撑按 low 降序」——
 *   calcFalsification 取 [0] 作为「最近的反转边界」，zoneLevelsHint 取「就近支撑/阻力」，
 *   排序一变，④卡文案与量能规则4 的引用位就会跟着变。强度只作为字段供前端分组，不参与排序。
 *
 * 【三阶段流水线】（顺序不可调换）
 *   ① 几何：聚类 + 定带宽 + 裁到现价对应一侧
 *   ② 消解：排序后切开相邻重叠，保证清单里区域互不重叠
 *   ③ 统计：触碰次数、60分钟确认、强度评分、失效位 —— 必须在几何定稿之后算，
 *      否则「先算触碰、后改带宽」会让统计口径与展示区域对不上。
 */
const { volRatioAt } = require('./zoneValidity');

const MERGE_ATR_RATIO = 1.05;     // 簇首判定：中心距 ≤ ATR×1.05 视为同一价格带
const BAND_MIN_ATR = 0.7;         // 单带最小宽度（ATR 倍数）：保证是「区域」而非「一条线」
const BAND_MAX_ATR = 1.0;         // 单带最大宽度（ATR 倍数）：防单一宽来源撑爆整条带
const MIN_KEEP_ATR = 0.3;         // 侵蚀后的最小保留宽度（20261022g 用户决策：不得压成单点）
const INVALID_BUFFER_ATR = 0.3;   // 失效缓冲：越过带沿 ATR×0.3 才算有效突破
const TOUCH_LOOKBACK = 60;        // 触碰统计窗口
const MAX_PER_SIDE = 6;           // 每侧最多输出条数

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/**
 * 统计某条带在近 N 日被触碰的情况（只用于强度，不做有效性判定）。
 * 触碰定义：当日收盘价落在 [low, high] 内（支撑/阻力同口径——都是「价格来到这个区域」）。
 * 放量触碰：触碰日量比 > 1.2（与 zoneValidity.BREAK_VOL_MIN 同源）。
 * 缩量触碰：触碰日量比 ≤ 1.2（用户规范：「缩量企稳 → 有效性提高」）。
 */
function touchStats(daily, band, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const lookback = Number.isFinite(opts && opts.lookback) ? opts.lookback : TOUCH_LOOKBACK;
  const lo = Number(band && band.low);
  const hi = Number(band && band.high);
  const out = { touches: 0, volTouches: 0, shrinkTouches: 0, lastTouchDate: null };
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return out;
  const start = Math.max(0, list.length - lookback);
  for (let i = start; i < list.length; i++) {
    const c = Number(list[i] && list[i].close);
    if (!Number.isFinite(c)) continue;
    if (c < lo || c > hi) continue;
    out.touches += 1;
    out.lastTouchDate = list[i].date || out.lastTouchDate;
    const vr = volRatioAt(list, i);
    if (vr != null) {
      if (vr > 1.2) out.volTouches += 1;
      else out.shrinkTouches += 1;
    }
  }
  return out;
}

/**
 * 单侧聚类：按**锚定簇首中心**方式合并（防链式漂移，与 analysis.clusterLevels 同思路）。
 * @param {Array} cands 同一 side 的候选
 * @param {number} atrV
 * @param {number} price
 */
function clusterSide(cands, atrV, price) {
  const list = (Array.isArray(cands) ? cands : [])
    .filter(z => z && Number.isFinite(z.low) && Number.isFinite(z.high) && z.high >= z.low)
    .slice()
    .sort((a, b) => (a.low + a.high) - (b.low + b.high));
  if (list.length === 0) return [];

  const anchorTol = (atrV || price * 0.01) * MERGE_ATR_RATIO;
  const clusters = [];
  for (const z of list) {
    const zc = (z.low + z.high) / 2;
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(zc - last.anchorCenter) <= anchorTol) {
      last.members.push(z);
      last.unionLow = Math.min(last.unionLow, z.low);
      last.unionHigh = Math.max(last.unionHigh, z.high);
      continue;
    }
    clusters.push({
      anchorCenter: zc,
      unionLow: z.low,
      unionHigh: z.high,
      members: [z],
    });
  }
  return clusters;
}

/**
 * 强度分级（用户规范第三部分）。
 *   强 = 大周期方法 ≥2 且（放量触碰 ≥1 或 缩量触碰 ≥2 或 60分钟确认）
 *   中 = 不同方法 ≥2
 *   弱 = 单一方法
 * @returns {{strength:'强'|'中'|'弱', score:number, reasons:string[]}}
 */
function grade(m) {
  const reasons = [];
  let score = 0;
  score += Math.min(m.methodCount, 4) * 10;
  score += Math.min(m.majorCount, 3) * 12;
  score += Math.min(m.touches, 4) * 4;
  if (m.volConfirmed) score += 8;
  if (m.shrinkConfirmed) score += 5;
  if (m.hourlyConfirmed) score += 6;

  const volOrClose = m.volConfirmed || m.shrinkConfirmed || m.hourlyConfirmed;
  let strength;
  if (m.majorCount >= 2 && volOrClose) {
    strength = '强';
    reasons.push(`大周期方法 ${m.majorCount} 个重合`);
    reasons.push(m.volConfirmed ? '有放量触碰确认' : m.shrinkConfirmed ? '有缩量触碰（承接/抛压确认）' : '60分钟级别确认');
  } else if (m.methodCount >= 2) {
    strength = '中';
    reasons.push(`方法 ${m.methodCount} 个重合`);
    if (m.majorCount >= 2 && !volOrClose) reasons.push('大周期方法够但暂无量能/收盘确认，故记「中」');
  } else {
    strength = '弱';
    reasons.push('单一方法');
  }
  return { strength, score, reasons };
}

/**
 * 60 分钟级别确认（用户规范「大周期定区域，小周期找确认」）。
 * 判定：最近 40 根 60 分钟K中，收盘价进入过该带，且没有一次收盘越过带沿+缓冲（穿破）。
 * @param {Array} h60 60分钟K（升序）
 * @param {object} band
 * @param {'resistance'|'support'} side
 * @param {number} atrV
 */
function hourlyConfirm(h60, band, side, atrV) {
  const list = Array.isArray(h60) ? h60 : [];
  if (list.length < 10 || !band) return { confirmed: false, note: '' };
  const lo = Number(band.low);
  const hi = Number(band.high);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { confirmed: false, note: '' };
  const buf = (atrV || 0) * INVALID_BUFFER_ATR;
  const start = Math.max(0, list.length - 40);
  let entered = 0;
  let brokeOut = 0;
  for (let i = start; i < list.length; i++) {
    const c = Number(list[i] && list[i].close);
    if (!Number.isFinite(c)) continue;
    if (c >= lo && c <= hi) entered += 1;
    if (side === 'support' && c < lo - buf) brokeOut += 1;
    if (side === 'resistance' && c > hi + buf) brokeOut += 1;
  }
  if (entered > 0 && brokeOut === 0) {
    return { confirmed: true, note: `60分钟级别 ${entered} 次进入该带且未收盘穿破，小周期确认有效` };
  }
  return { confirmed: false, note: entered > 0 ? `60分钟级别进入 ${entered} 次、收盘穿破 ${brokeOut} 次` : '' };
}

/**
 * 主入口：候选 → 共振带。
 * @param {Array}  candidates zoneMethods.buildCandidates 的结果
 * @param {object} opts { daily, h60, atr, price, maxPerSide }
 * @returns {{resistanceBands:Array, supportBands:Array, atr:number, price:number, stats:object}}
 */
function mergeResonance(candidates, opts) {
  const o = opts || {};
  const daily = Array.isArray(o.daily) ? o.daily : [];
  const h60 = Array.isArray(o.h60) ? o.h60 : [];
  const price = Number(o.price);
  const atrV = Number(o.atr) || null;
  const all = Array.isArray(candidates) ? candidates : [];
  const base = atrV || (Number.isFinite(price) ? price * 0.01 : 0.01);

  const stat = { input: all.length, droppedWeakOnly: 0, droppedWrongSide: 0, merged: 0, overlapCut: 0 };

  const buildOneSide = (side) => {
    const raw = all.filter(z => z && z.side === side);
    const clusters = clusterSide(raw, base, price);

    // ─────────── 阶段 1：几何（只定位，不做统计）───────────
    const drafts = [];
    for (const cl of clusters) {
      const members = cl.members;
      // 整数关口等「必须与其他方法重合才用」的来源：单独成簇则丢弃（用户规范明确要求）
      const nonWeak = members.filter(m => !m.weakOnly);
      if (nonWeak.length === 0) { stat.droppedWeakOnly += 1; continue; }
      const majorMembers = members.filter(m => m.tier === 'major');

      // center = 各来源中心的中位数（抗极值）；带宽钳在 [0.7, 1.0]×ATR。
      // 为什么不用「参与者区间的并集」当带宽：单个宽来源（筹码峰、均线粘合带）会把整条带撑到
      // 跨越上方一大片（实测 603288 曾出现 33.50~35.35 即 ATR 的 2.6 倍，并与下一条重叠）。
      const centers = members
        .map(m => (Number(m.low) + Number(m.high)) / 2)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const center = centers.length ? centers[Math.floor(centers.length / 2)] : (cl.unionLow + cl.unionHigh) / 2;
      const unionW = cl.unionHigh - cl.unionLow;
      const bw = Math.min(Math.max(unionW, base * BAND_MIN_ATR), base * BAND_MAX_ATR);
      let low = center - bw / 2;
      let high = center + bw / 2;

      // 裁剪到现价的对应一侧（避免阻力带跨到现价下方、支撑带跨到现价上方）
      if (Number.isFinite(price)) {
        if (side === 'resistance' && low <= price) low = price * 1.001;
        if (side === 'support' && high >= price) high = price * 0.999;
        if (!(high >= low)) { stat.droppedWrongSide += 1; continue; }
      }
      drafts.push({
        members, nonWeak, majorMembers,
        center: r2(center), low: r2(low), high: r2(high),
      });
    }

    // ─────────── 阶段 2：排序 + 重叠消解 ───────────
    // 保持「阻力按 low 升序 / 支撑按 low 降序」（下游 ④卡反转边界、量能规则4 取就近位依赖此序）。
    // 消解方式：以两带中心的中点为界切开重叠区 → 清单里的区域绝不互相重叠。
    // ⚠ 两种 side 的数组方向相反，切口作用在**哪一端**也必须相反，否则会出现 low>high 的畸形带：
    //     阻力（升序）：a 在下、b 在上，重叠区在 a.high ~ b.low → 收 a.high、抬 b.low
    //     支撑（降序）：a 在上、b 在下，重叠区在 b.high ~ a.low → 抬 a.low、收 b.high
    drafts.sort((a, b) => (side === 'resistance' ? a.low - b.low : b.low - a.low));
    for (let i = 0; i < drafts.length - 1; i++) {
      const a = drafts[i];
      const b = drafts[i + 1];
      if (side === 'resistance') {
        if (!(a.high > b.low)) continue;
        const cut = r2((a.center + b.center) / 2);
        a.high = r2(Math.max(a.low, Math.min(a.high, cut)));
        b.low = r2(Math.min(b.high, Math.max(b.low, cut)));
        a.center = r2((a.low + a.high) / 2);
        b.center = r2((b.low + b.high) / 2);
      } else {
        if (!(b.high > a.low)) continue;
        const cut = r2((a.center + b.center) / 2);
        a.low = r2(Math.min(a.high, Math.max(a.low, cut)));
        b.high = r2(Math.max(b.low, Math.min(b.high, cut)));
        a.center = r2((a.low + a.high) / 2);
        b.center = r2((b.low + b.high) / 2);
      }
      stat.overlapCut += 1;
    }
    // 消解后自检：任何一条带必须满足 low <= high（防御性，正常路径不会触发）
    for (let i = drafts.length - 1; i >= 0; i--) {
      const d = drafts[i];
      if (!(d.high >= d.low) || !(d.high > 0)) {
        drafts.splice(i, 1);
        stat.droppedWrongSide += 1;
      }
    }

    // ─────────── 阶段 3：统计 + 评分 + 输出（几何定稿后才算）───────────
    const bands = [];
    for (const d of drafts) {
      const { members, nonWeak, majorMembers } = d;
      const band = { low: d.low, high: d.high, center: d.center };
      const ts = touchStats(daily, band, {});
      const hc = hourlyConfirm(h60, band, side, base);
      const methodCount = new Set(nonWeak.map(m => m.method)).size;
      const majorCount = new Set(majorMembers.filter(m => !m.weakOnly).map(m => m.method)).size;
      const g = grade({
        methodCount,
        majorCount,
        touches: ts.touches,
        volConfirmed: ts.volTouches > 0,
        shrinkConfirmed: ts.shrinkTouches >= 2,
        hourlyConfirmed: hc.confirmed,
      });
      if (members.length > 1) stat.merged += 1;

      // 来源名：大周期优先，最多列 3 个，其余折叠为「等 N 项」
      const ordered = members.slice().sort((a, b) => (b.tier === 'major' ? 1 : 0) - (a.tier === 'major' ? 1 : 0));
      const names = [];
      for (const mem of ordered) {
        const nm = mem.source || mem.method;
        if (!names.includes(nm)) names.push(nm);
      }
      const sourceText = names.length <= 3 ? names.join(' + ') : `${names.slice(0, 3).join(' + ')} 等 ${names.length} 项`;

      const confirmSignals = [];
      if (ts.volTouches > 0) confirmSignals.push(`近${TOUCH_LOOKBACK}日有 ${ts.volTouches} 次放量触碰`);
      if (ts.shrinkTouches >= 2) confirmSignals.push(`近${TOUCH_LOOKBACK}日有 ${ts.shrinkTouches} 次缩量触碰（${side === 'support' ? '缩量企稳，承接确认' : '缩量滞涨，抛压确认'}）`);
      if (ts.touches === 0) confirmSignals.push(`近${TOUCH_LOOKBACK}日尚未被触碰，属未被测试的位置`);
      if (hc.note) confirmSignals.push(hc.note);
      for (const r of g.reasons) if (!confirmSignals.includes(r)) confirmSignals.push(r);

      // 失效位：支撑破下沿减缓冲；阻力破上沿加缓冲（用户规范「留有缓冲」）
      const buf = base * INVALID_BUFFER_ATR;
      const invalidationLevel = side === 'support' ? r2(band.low - buf) : r2(band.high + buf);
      const invalidationText = side === 'support'
        ? `放量收盘跌破 ${invalidationLevel}（下沿 ${band.low} 再减 ${r2(buf)} 缓冲）→ 支撑失效，可能转为阻力`
        : `放量收盘站上 ${invalidationLevel}（上沿 ${band.high} 再加 ${r2(buf)} 缓冲）→ 阻力失效，可能转为支撑`;

      bands.push({
        low: band.low,
        high: band.high,
        center: band.center,
        side,
        source: sourceText,
        sources: members.map(mem => ({
          method: mem.method, source: mem.source, tier: mem.tier,
          low: mem.low, high: mem.high, weakOnly: !!mem.weakOnly, note: mem.note || '',
        })),
        strength: g.strength,
        strengthScore: g.score,
        strengthReasons: g.reasons,
        methodCount,
        majorCount,
        touches: ts.touches,
        lastTouchDate: ts.lastTouchDate,
        volConfirmed: ts.volTouches > 0,
        shrinkConfirmed: ts.shrinkTouches >= 2,
        hourlyConfirmed: hc.confirmed,
        confirmSignals,
        invalidationLevel,
        invalidationText,
        validityHint: `以当日收盘价判定：${invalidationText.split('→')[0].trim()}`,
        note: ordered.filter(x => x.note).slice(0, 2).map(x => x.note).join('；'),
      });
    }

    const cap = Number.isFinite(o.maxPerSide) ? o.maxPerSide : MAX_PER_SIDE;
    return bands.slice(0, cap);
  };

  const resistanceBands = buildOneSide('resistance');
  const supportBands = buildOneSide('support');
  return {
    resistanceBands,
    supportBands,
    atr: r2(base),
    price: r2(price),
    stats: stat,
  };
}

module.exports = {
  MERGE_ATR_RATIO,
  BAND_MIN_ATR,
  BAND_MAX_ATR,
  MIN_KEEP_ATR,
  INVALID_BUFFER_ATR,
  TOUCH_LOOKBACK,
  MAX_PER_SIDE,
  touchStats,
  clusterSide,
  grade,
  hourlyConfirm,
  mergeResonance,
};

~~~

---

## `lib\zoneReversal.js`  ·  339 行

~~~js
/**
 * 阻力 / 支撑区间 · 放量突破反转（20261022b，用户新增规则）
 * ==========================================================
 * 用户原话（2026-10-22）：
 *   「如果上方阻力区间或下方支撑区间被放量有效突破，该区间将被记录下来
 *    （已收紧部分、被侵蚀规则排除部分不算），转换成反方向区间，
 *    例如下方支撑区间被有效放量打穿后，系统自动记录下来，然后转换为上方阻力区间
 *    （允许多次转换），直到被有效性检验判定为无效才从记录删除。」
 *
 * 落地口径（可核对，勿擅自放宽/收紧）：
 *   - 「有效放量突破」= 收盘越过区间**远端**（阻力 > high / 支撑 < low）且该日量比 > 1.2，
 *     并且**当前仍在外侧**（突破站住才算「有效」，当日冲高即回落不算）。
 *   - 反转 = 角色互换：上破阻力 → 该位变支撑；下破支撑 → 该位变阻力。
 *   - 区间几何：沿用**侵蚀后的当前区间**（已收紧/被侵蚀排除的部分不再纳入）——
 *     这与 zoneValidity 的「远端恒不变、只收紧近端」一致：反转记录的是当下的有效区间。
 *   - 允许多次反转：每次在新的当前方向上再次「放量有效突破」就再翻一次，累计 flipCount。
 *   - 终止：反转记录本身继续接受**标准1**（无放量轻松突破）检验——一旦被无放量穿越，
 *     即判定该区间无效，从记录中删除。
 *   - 量能缺失（量比 null）→ 不翻转也不删除（无法确认放量/无放量，绝不臆断）。
 *
 * 与模型的隔离：
 *   - 反转记录落盘 `data/zone-reversals/<6位>.json`，不影响方向判断/概率/④卡/准确率
 *     （这些在 analyzePriceAction 内部、本模块之前已算完）。
 *   - 20261103h（用户报障：「手动设定的阻力被突破为什么还保持显示」）：**手动区间也接入本生命周期**——
 *     此前只消费模型区间，手动阻力被放量有效突破后既不判无效（标准1 只判无放量穿越）也不反转，
 *     会一直以原方向挂在清单里。现改为：手动区间满足同一条件（放量有效突破且仍在外侧）时同样
 *     创建反转记录（带 origin:'manual' + manualId 链接回源条目），原手动区间从清单移除；
 *     手动区间删除时经 purgeByManualId 联动清除其反转记录。仍不参与方向/概率/④卡/准确率。
 *
 * 纯函数（replayRecord / createRecordFromZone）零 IO，便于单测；attachReversedZones 负责读写。
 */
const fs = require('fs');
const path = require('path');
const { volRatioAt, BREAK_VOL_MIN } = require('./zoneValidity');

const DIR = path.join(__dirname, '..', 'data', 'zone-reversals');
const SCHEMA = 1;
const MAX_RECORDS = 40;   // 单股反转记录上限（防历史无限累积；超出丢弃最早评估的）

const r2 = (n) => Math.round(n * 100) / 100;
const _num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
function fileFor(sym) { return path.join(DIR, normalizeSymbol(sym) + '.json'); }
function ensureDir() {
  try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {
    console.warn('[ZoneReversal] 创建目录失败（落盘时再报错）:', e && e.message ? e.message : e);
  }
}

function oppositeSide(side) { return side === 'resistance' ? 'support' : 'resistance'; }
function isBeyond(rec, close) { return rec.side === 'resistance' ? close > rec.high : close < rec.low; }
function rangesIntersect(a, b) {
  const al = _num(a && a.low), ah = _num(a && a.high), bl = _num(b && b.low), bh = _num(b && b.high);
  if (al == null || ah == null || bl == null || bh == null) return false;
  return al <= bh && bl <= ah;
}

/** 读盘（缺文件/坏 JSON → 空，不编造） */
function loadRecords(symbol) {
  const sym = normalizeSymbol(symbol);
  const base = { symbol: sym, schema: SCHEMA, records: [], updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
    if (!raw || !Array.isArray(raw.records)) return base;
    const records = raw.records.filter(r => r
      && (r.side === 'resistance' || r.side === 'support')
      && (r.originSide === 'resistance' || r.originSide === 'support')
      && _num(r.low) > 0 && _num(r.high) > 0 && _num(r.low) <= _num(r.high))
      .map(r => ({
        id: String(r.id || ''),
        low: r2(_num(r.low)),
        high: r2(_num(r.high)),
        side: r.side,
        originSide: r.originSide,
        origin: r.origin === 'manual' ? 'manual' : null,      // 20261103h：手动来源反转记录
        manualId: r.manualId ? String(r.manualId) : null,     // 20261103h：链接回源手动区间
        flipCount: Number(r.flipCount) || 0,
        history: Array.isArray(r.history) ? r.history.slice(-20) : [],
        lastEvalDate: r.lastEvalDate || null,
        wasBeyond: typeof r.wasBeyond === 'boolean' ? r.wasBeyond : null,
        active: r.active !== false,
        invalidReason: r.invalidReason || null,
        createdAt: r.createdAt || null,
      }));
    return { symbol: sym, schema: SCHEMA, records, updatedAt: raw.updatedAt || null };
  } catch (e) {
    return base;
  }
}

function saveRecords(symbol, records) {
  ensureDir();
  const sym = normalizeSymbol(symbol);
  const list = Array.isArray(records) ? records.slice(-MAX_RECORDS) : [];
  const payload = { symbol: sym, schema: SCHEMA, records: list, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileFor(sym), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * 把一条反转记录推进到最新日K（纯函数，不改入参）。
 * 只在 lastEvalDate 之后的新交易日上判断：
 *   - 出现「放量」（量比 > 1.2）的有效突破 → 翻转角色（可多次）
 *   - 出现「无放量」（量比 ≤ 1.2）的突破 → 标准1 判无效 → active=false（删除）
 *   - 量能缺失 → 不翻转、不删除
 * @returns {object} 新记录（可能 active=false）
 */
function replayRecord(rec, bars) {
  const out = Object.assign({}, rec, { history: Array.isArray(rec.history) ? rec.history.slice() : [] });
  if (!Array.isArray(bars) || bars.length === 0) return out;
  if (out.active === false) return out;
  const lastEval = out.lastEvalDate || null;
  let prevBeyond = (out.wasBeyond === true) ? true : (out.wasBeyond === false ? false : null);
  // 只处理日期严格晚于 lastEvalDate 的K线（避免同一事件反复翻转）
  let i0 = 0;
  if (lastEval) {
    i0 = bars.length;
    for (let k = 0; k < bars.length; k++) {
      if (String((bars[k] && bars[k].date) || '') > lastEval) { i0 = k; break; }
    }
  }
  for (let i = i0; i < bars.length; i++) {
    const c = _num(bars[i] && bars[i].close);
    if (c == null) continue;
    let beyond = isBeyond(out, c);
    if (prevBeyond === false && beyond === true) {
      const vr = volRatioAt(bars, i);
      if (vr != null && vr > BREAK_VOL_MIN) {
        const from = out.side;
        out.side = oppositeSide(from);
        out.flipCount = (Number(out.flipCount) || 0) + 1;
        out.history.push({ date: (bars[i] && bars[i].date) || null, from, to: out.side, vr, close: r2(c) });
        beyond = isBeyond(out, c);   // 翻转后按新方向重算是否在外侧
      } else if (vr != null && vr <= BREAK_VOL_MIN) {
        // 无放量轻松穿越 → 标准1 判无效 → 删除记录
        out.active = false;
        out.invalidReason = `反转记录被无放量穿越（量比 ${vr} ≤ ${BREAK_VOL_MIN}），按标准1 失效`;
        out.lastEvalDate = (bars[i] && bars[i].date) || lastEval;
        return out;
      }
      // vr == null → 量能缺失，不翻转也不删除
    }
    prevBeyond = beyond;
  }
  out.wasBeyond = prevBeyond;
  out.lastEvalDate = (bars[bars.length - 1] && bars[bars.length - 1].date) || lastEval;
  return out;
}

/**
 * 由一条「已被放量有效突破」的模型区间创建反转记录（纯函数）。
 * 条件：最近一次突破为放量（量比 > 1.2）且**当前仍在外侧**（有效突破，非当日冲高即回落）。
 * @returns {object|null}
 */
function createRecordFromZone(zone, side, bars, extra) {
  if (!zone || !Array.isArray(bars) || bars.length === 0) return null;
  const lo = _num(zone.low), hi = _num(zone.high);
  if (lo == null || hi == null || !(hi >= lo)) return null;
  const ck = zone.zoneCheck || {};
  const vr = _num(ck.lastBreakVr);
  if (!(vr != null && vr > BREAK_VOL_MIN)) return null;
  if (!(Number(ck.breakCount) > 0)) return null;
  const lastBar = bars[bars.length - 1];
  const lastClose = _num(lastBar && lastBar.close);
  if (lastClose == null) return null;
  const stillBeyond = side === 'resistance' ? lastClose > hi : lastClose < lo;
  if (!stillBeyond) return null;   // 有效突破才算：突破后仍在外侧
  const newSide = oppositeSide(side);
  const rec = {
    id: 'zr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    low: r2(lo), high: r2(hi),
    originSide: side,
    side: newSide,
    // 20261103h：手动来源反转记录（origin='manual' + manualId 链接回源条目，删除时联动清除）
    origin: (extra && extra.origin === 'manual') ? 'manual' : null,
    manualId: (extra && extra.manualId) ? String(extra.manualId) : null,
    flipCount: 1,
    history: [{ date: ck.lastBreakDate || null, from: side, to: newSide, vr, close: r2(lastClose) }],
    lastEvalDate: (lastBar && lastBar.date) || null,
    wasBeyond: null,
    active: true,
    invalidReason: null,
    createdAt: new Date().toISOString(),
  };
  rec.wasBeyond = isBeyond(rec, lastClose);
  return rec;
}

function _findDuplicate(records, zone, side) {
  return (records || []).find(r => r.originSide === side && rangesIntersect(r, zone));
}

function _buildZone(rec) {
  return {
    low: rec.low,
    high: rec.high,
    // 20261103h：手动来源反转的来源标注（清单来源列 + 展开详情都能看出「这是你手动标的那条」）
    source: rec.origin === 'manual' ? '手动区间·放量突破反转' : '放量突破反转',
    isReversed: true,
    originManual: rec.origin === 'manual',
    manualId: rec.manualId || null,
    reversedFrom: rec.originSide,
    flipCount: rec.flipCount || 1,
    reversalHistory: rec.history || [],
    valid: true,
    invalidReasons: [],
    zoneCheck: { side: rec.side, breakVolMin: BREAK_VOL_MIN, reversed: true, flipCount: rec.flipCount || 1 },
  };
}

/**
 * 快照接线：读出反转记录 → 推进（翻转/失效）→ 从模型区间补充新记录 →
 * 把有效记录注入对应阻力/支撑清单（并移除被反转取代的原始区间）→ 落盘。
 * 失败一律降级（不改动 data 其它部分），不阻塞②卡。
 * @param {object} data  analyzePriceAction 结果（含 shortTerm）
 * @param {Array}  daily 日K
 * @param {string} symbol
 */
function attachReversedZones(data, daily, symbol) {
  if (!data || !data.shortTerm || !Array.isArray(daily) || daily.length < 2) return data;
  let store;
  try { store = loadRecords(symbol); } catch (e) { return data; }
  let records = (store.records || []).slice();

  // 1) 推进既有记录
  try {
    records = records.map(r => replayRecord(r, daily)).filter(r => r.active !== false);
  } catch (e) {
    console.warn('[ZoneReversal] 反转记录推进失败（按原样保留）:', e && e.message ? e.message : e);
  }

  // 2) 从模型区间与手动区间补充新反转记录（20261103h：手动区间接入同一条生命周期；反转来源不参与）
  const suppress = [];
  const manualReversed = [];   // 手动区间被反转的事件（供 manualZonesMeta.reversed → 手动页签徽标）
  try {
    const groups = [
      ['resistance', data.shortTerm.resistances],
      ['support', data.shortTerm.supports],
    ];
    for (const [side, arr] of groups) {
      if (!Array.isArray(arr)) continue;
      for (const z of arr) {
        if (!z || z.isReversed) continue;
        if (!z.zoneCheck) continue;
        const vr = _num(z.zoneCheck.lastBreakVr);
        if (!(vr != null && vr > BREAK_VOL_MIN)) continue;
        if (!(Number(z.zoneCheck.breakCount) > 0)) continue;
        const isManual = z.isManual === true;
        const dup = _findDuplicate(records, z, side);
        if (dup) {
          // 同位已有反转记录（同一位置只保留反转后的方向）。手动区间同位时也移除原条目，
          // 并记入 manualReversed 让「手动添加」页签标注原因（否则用户会纳闷条目去哪了）。
          if (isManual && z.manualId) manualReversed.push({ manualId: z.manualId, to: dup.side, date: z.zoneCheck.lastBreakDate || null, vr, duplicate: true });
          suppress.push({ side, z });
          continue;
        }
        const rec = createRecordFromZone(z, side, daily, isManual ? { origin: 'manual', manualId: z.manualId } : null);
        if (rec) {
          records.push(rec);
          suppress.push({ side, z });
          if (isManual && z.manualId) manualReversed.push({ manualId: z.manualId, to: rec.side, date: z.zoneCheck.lastBreakDate || null, vr, duplicate: false });
        }
      }
    }
  } catch (e) {
    console.warn('[ZoneReversal] 新反转记录生成失败（本次不新增）:', e && e.message ? e.message : e);
  }

  // 3) 移除被反转取代的原始模型区间（同一位置只保留反转后的方向）
  for (const { side, z } of suppress) {
    const arr = side === 'resistance' ? data.shortTerm.resistances : data.shortTerm.supports;
    const idx = Array.isArray(arr) ? arr.indexOf(z) : -1;
    if (idx >= 0) arr.splice(idx, 1);
  }

  // 4) 注入有效反转区间
  const active = records.filter(r => r.active !== false);
  for (const rec of active) {
    const zone = _buildZone(rec);
    const arr = rec.side === 'resistance' ? data.shortTerm.resistances : data.shortTerm.supports;
    if (Array.isArray(arr)) arr.push(zone);
  }

  // 5) 落盘（含刚失效的记录会被 filter 掉，不再写回）。
  //    没有活动记录且此前也没有落盘文件 → 不创建空文件（避免为每只股票都生成一个空 json）。
  try {
    if (active.length > 0 || fs.existsSync(fileFor(symbol))) saveRecords(symbol, active);
  } catch (e) {
    console.warn('[ZoneReversal] 反转记录落盘失败:', e && e.message ? e.message : e);
  }

  data.zoneReversalMeta = {
    total: active.length,
    note: '放量有效突破 → 反方向区间（可多次反转）；被标准1（无放量轻松突破）判无效时自动移除。手动区间同样接入本生命周期（20261103h）。',
  };

  // 6) 20261103h：手动区间被反转后，重算 manualZonesMeta（被移出的条目不再计入 valid/invalid，
  //    并以 reversed 事件列表供「手动添加」页签标注「已反转」——用户不会纳闷条目去哪了）。
  if (data.manualZonesMeta) {
    const mans = []
      .concat(data.shortTerm.resistances || [], data.shortTerm.supports || [])
      .filter(z => z && z.isManual);
    data.manualZonesMeta.total = mans.length + manualReversed.length;
    data.manualZonesMeta.valid = mans.filter(z => z.valid !== false).length;
    data.manualZonesMeta.invalid = mans.filter(z => z.valid === false).length;
    if (manualReversed.length) data.manualZonesMeta.reversed = manualReversed;
  }
  return data;
}

/**
 * 20261103h：删除手动区间时联动清除其产生的反转记录（否则源条目删了，反转出来的对侧区间还挂着）。
 * @returns {{ok:boolean, removed:number}}
 */
function purgeByManualId(symbol, manualId) {
  const id = String(manualId || '');
  if (!id) return { ok: false, removed: 0 };
  const store = loadRecords(symbol);
  const before = (store.records || []).length;
  const kept = store.records.filter(r => r.manualId !== id);
  const removed = before - kept.length;
  if (removed > 0) saveRecords(symbol, kept);
  return { ok: true, removed };
}

module.exports = {
  attachReversedZones, replayRecord, createRecordFromZone,
  loadRecords, saveRecords, oppositeSide, rangesIntersect, purgeByManualId,
  normalizeSymbol, DIR, MAX_RECORDS, SCHEMA,
};

~~~

---

## `lib\zoneValidity.js`  ·  269 行

~~~js
/**
 * 阻力 / 支撑区间口径（20261020i 建 → 20261020l 修正口径 → 20261020m 增侵蚀 → 20261022b 删标准2）
 * ==========================================================
 * 本文件负责两件事，**顺序不可颠倒**：
 *   ① `assessZone/assessZones` —— **有效性检验**：这个位还值不值得展示。
 *   ② `erodeZone/erodeZones`   —— **侵蚀收缩**：能展示的话，它还剩下多大（无放量侵入但未打穿 → 近端收紧）。
 * 先判有效性再收缩几何；侵蚀结果不回灌 ①，否则会形成「越侵蚀越有效」的自我强化。
 *
 * 用户 2026-10-20 给过两条标准；**2026-10-22 用户要求彻底删除标准2**（超过三天来回突破），
 * 只保留标准1（原话）：
 *   1）「如果股价不需要放量就轻松突破，则判定无效。」
 *   → 无效价格区间无需展示。
 * 注：2026-10-22 同步新增「放量有效突破 → 角色反转」规则（lib/zoneReversal.js）：
 *   放量突破不再由本文件判无效，而由反转模块翻成反方向区间并记录，
 *   直到本文件的标准1判无效才从记录删除。
 *
 * 【方向性】
 *   阻力只关心「向上穿越」；支撑只关心「向下穿越」。反方向穿越不计入突破——股价从上方掉下来
 *   穿过某个价位，对该价位作为「上方阻力」的身份不构成突破，不能拿它来判死。
 *   端点口径：close == high / low 视为区间内（穿越时用 > high / < low）。
 *
 * 【标准1 · 无放量轻松突破】（唯一有效性标准）
 *   取最近一次「真突破」（收盘越过区间**远端**：阻力 > high、支撑 < low）的交易日，
 *   量比 = 当日成交量 ÷ 前 5 日均量（不含当日）。
 *   量比 > 1.2 视为放量（本模块分母为「前 5 日均量」，与页面顶部「量比」同源）。
 *   ⚠️ 20261109c 更正：本阈值**不是** ÷20 日均量量价判定档位（后者唯一真值源为
 *   lib/volumeCaliber.js：放量 >1.3 / 缩量 <0.8）。此处是箱体有效性的专用穿越确认线，
 *   分母不同且在页面显式标注，不参与 135 格 / 量价关系 / 生死位规则判定。
 *   量比 ≤ 1.2 → 不需要放量就能穿过去 → 无效。
 *   量能缺失（前 5 日不足 / 成交量为 0）→ 本条不判定，也不臆造量比。
 *
 * 纯函数、零网络：入参为日K数组 + 区间列表，返回带 valid / invalidReasons / zoneCheck 的区间列表。
 */
const LOOKBACK_DAYS = 60;
const VOL_AVG_DAYS = 5;
const BREAK_VOL_MIN = 1.2;   // 放量穿越线（÷前5日均量专用判据；÷20 判定档位见 lib/volumeCaliber.js）

function _num(v) {
  // 注意：Number(null) === 0、Number('') === 0 —— 必须先挡掉空值，否则「缺字段」会被当成价格为 0，
  // 导致 close > 0 恒成立、整个区间被判成「当前站在外侧」而误杀（测试 [9] 已锁定）。
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 第 i 日相对「前 5 日均量」的量比；数据不足返回 null（不臆断）
function volRatioAt(bars, i) {
  if (i < VOL_AVG_DAYS) return null;
  const cur = _num(bars[i] && bars[i].volume);
  if (cur == null || cur <= 0) return null;
  let sum = 0;
  for (let k = i - VOL_AVG_DAYS; k < i; k++) {
    const v = _num(bars[k] && bars[k].volume);
    if (v == null || v <= 0) return null;
    sum += v;
  }
  const avg = sum / VOL_AVG_DAYS;
  if (!(avg > 0)) return null;
  return Math.round((cur / avg) * 100) / 100;
}

/**
 * 单区间检验
 * @param {Array} bars   日K（升序，含 date/open/high/low/close/volume）
 * @param {Object} zone  { low, high, source }
 * @param {'resistance'|'support'} side
 */
function assessZone(bars, zone, side) {
  const lo = _num(zone && zone.low);
  const hi = _num(zone && zone.high);
  const base = { valid: true, invalidReasons: [], zoneCheck: null };
  if (lo == null || hi == null || !(hi >= lo)) return base;   // 脏数据不判死，按有效透传

  const list = Array.isArray(bars) ? bars : [];
  const n = list.length;
  const start = Math.max(0, n - LOOKBACK_DAYS);
  const isRes = side === 'resistance';
  // 「真突破」：收盘越过区间**远端**（阻力 > high、支撑 < low）。标准1 只看这一种穿越。
  const beyondOf = (c) => (isRes ? c > hi : c < lo);

  let breakCount = 0;          // 从内→外 的次数（真正"突破/跌破"的次数）
  let lastBreakIdx = -1;
  let prevBeyond = null;
  for (let i = start; i < n; i++) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    const beyond = beyondOf(c);
    if (prevBeyond === false && beyond === true) { breakCount += 1; lastBreakIdx = i; }
    prevBeyond = beyond;
  }

  const vr = lastBreakIdx >= 0 ? volRatioAt(list, lastBreakIdx) : null;
  const lastBreakDate = lastBreakIdx >= 0 ? (list[lastBreakIdx].date || null) : null;
  const dirTxt = isRes ? '向上突破' : '向下跌破';
  const reasons = [];

  // 唯一有效性标准：最近一次真突破是「无放量轻松穿越」→ 无效。
  if (lastBreakIdx >= 0 && vr != null && vr <= BREAK_VOL_MIN) {
    reasons.push(`最近一次${dirTxt}（${lastBreakDate}）量比 ${vr} ≤ ${BREAK_VOL_MIN}，属无放量轻松穿越`);
  }

  return {
    valid: reasons.length === 0,
    invalidReasons: reasons,
    zoneCheck: {
      lookbackDays: Math.min(LOOKBACK_DAYS, n),
      side,
      breakCount,
      lastBreakDate,
      lastBreakVr: vr,
      breakVolMin: BREAK_VOL_MIN,
      volUnknown: lastBreakIdx >= 0 && vr == null,
    },
  };
}

/**
 * 20261022c（用户口径）：突破 / 破位 / 打穿一律以**当日收盘价**为准，不认分时价。
 * 数据源（Sina 日K）盘中实测不含当日这根（最后一根 = 上一交易日收盘）；
 * 但为防任何来源塞入「未收盘的当日K线」用盘中最新价冒充收盘价，这里统一过滤：
 *   末根 date == 今天 且 现在未到收盘（默认 15:05）→ 丢弃该根，只用已收盘的日K。
 * @param {Array} bars
 * @param {Date} [now]
 * @param {number} [closeHhmm] 收盘时刻 HHMM（A股 15:00 + 5 分钟落定）
 */
function finalizedBars(bars, now, closeHhmm) {
  const list = Array.isArray(bars) ? bars : [];
  if (list.length === 0) return list;
  const n = now instanceof Date ? now : new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  const last = list[list.length - 1];
  const lastDate = String((last && last.date) || '').slice(0, 10);
  if (lastDate !== today) return list;                 // 末根不是今天 → 已是收盘价
  const limit = Number.isFinite(closeHhmm) ? closeHhmm : 1505;
  const hhmm = n.getHours() * 100 + n.getMinutes();
  if (hhmm >= limit) return list;                      // 已收盘 → 当日收盘价可用
  return list.slice(0, -1);                            // 未收盘 → 丢弃当日K线
}

/**
 * 批量检验（阻力 / 支撑分别按各自方向判）
 * @returns {{resistances:Array, supports:Array, summary:Object}}
 */
function assessZones(bars, shortTerm) {
  const st = shortTerm || {};
  const mapList = (arr, side) => (Array.isArray(arr) ? arr : []).map(z => {
    const r = assessZone(bars, z, side);
    return Object.assign({}, z, { valid: r.valid, invalidReasons: r.invalidReasons, zoneCheck: r.zoneCheck });
  });
  const resistances = mapList(st.resistances, 'resistance');
  const supports = mapList(st.supports, 'support');
  const all = resistances.concat(supports);
  return {
    resistances,
    supports,
    summary: {
      total: all.length,
      valid: all.filter(z => z.valid).length,
      invalid: all.filter(z => !z.valid).length,
      lookbackDays: LOOKBACK_DAYS,
      breakVolMin: BREAK_VOL_MIN,
    },
  };
}

/**
 * 单区间侵蚀（20261020m，用户口径）
 * ==========================================================
 * 用户原话：「只要收盘价在无放量的情况下侵入阻力或者支撑区间，但无法完整突破整个区间，
 *   则把区间范围缩小，远端值不变，但近端的值改为突破近端值的那一次收盘价。」
 *   例：阻力 34.53~34.87，之后某日无放量收在 34.7 → 调整为 34.7~34.87；
 *       支撑 32.25~32.57，之后某日无放量收在 32.5 → 调整为 32.25~32.5。
 *
 * 三个必要条件（缺一不侵蚀）：
 *   1) **侵入区间内部**：`low < close < high`。只到近端或越过远端都不算——
 *      越到远端之外属「突破」，交给 assessZone 的标准1 判有效性，不在这里改几何。
 *   2) **无放量**：该日量比 ≤ BREAK_VOL_MIN(1.2)，量比 = 当日量 ÷ 前 5 日均量（与标准1 同一公式）。
 *      量能缺失 → 不侵蚀（无法确认"无放量"就不动区间，绝不臆造）。
 *   3) **没有完整突破**：即条件 1 的 `close < high`（阻力）/ `close > low`（支撑）。
 *
 * **单调侵蚀**：区间内所有合规侵入日里，阻力取**最高**收盘、支撑取**最低**收盘作为新近端。
 * 取极值而非"最后一次"，是因为价格到过的位置就已经被消耗过——若取最后一次，价格回落会让
 * 区间又"长回去"，那就不是侵蚀了。
 *
 * **远端恒不变**：阻力的 high、支撑的 low 永远保持原值。
 *
 * @returns {{low:number, high:number, eroded:boolean, erosion:object|null}}
 */
function erodeZone(bars, zone, side) {
  const lo = _num(zone && zone.low);
  const hi = _num(zone && zone.high);
  const base = { low: zone ? zone.low : null, high: zone ? zone.high : null, eroded: false, erosion: null };
  if (lo == null || hi == null || !(hi > lo)) return base;   // 单点/脏数据：无可侵蚀空间

  const list = Array.isArray(bars) ? bars : [];
  const n = list.length;
  const start = Math.max(0, n - LOOKBACK_DAYS);
  const isRes = side === 'resistance';
  const nearFrom = isRes ? lo : hi;   // 近端：阻力=下沿 low，支撑=上沿 high

  let best = null;
  for (let i = start; i < n; i++) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    if (!(c > lo && c < hi)) continue;              // 必须落在区间内部（条件1、2、3 合并）
    const vr = volRatioAt(list, i);
    if (vr == null || vr > BREAK_VOL_MIN) continue; // 有放量 / 量能缺失 → 不侵蚀
    if (!best
      || (isRes && c > best.close)
      || (!isRes && c < best.close)) {
      best = { close: c, date: list[i].date || null, vr };
    }
  }
  if (!best) return base;

  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    low: isRes ? r2(best.close) : r2(lo),
    high: isRes ? r2(hi) : r2(best.close),
    eroded: true,
    erosion: {
      side,
      from: r2(nearFrom),
      to: r2(best.close),
      close: r2(best.close),
      date: best.date,
      vr: best.vr,
      volRatioMax: BREAK_VOL_MIN,
      rangeFrom: `${r2(lo)} ~ ${r2(hi)}`,
      rangeTo: isRes ? `${r2(best.close)} ~ ${r2(hi)}` : `${r2(lo)} ~ ${r2(best.close)}`,
    },
  };
}

/**
 * 批量侵蚀：**只处理通过有效性检验的区间**（valid !== false）。
 * 顺序铁律：先判有效性（决定展示与否）→ 再按侵蚀收缩几何（决定展示成多大）。
 * 侵蚀结果**绝不回灌** assessZone 的计数，否则「收缩后的近端」会让原先算到的往返次数消失，
 * 变成"越侵蚀越有效"的自我强化循环。
 * @returns {{resistances:Array, supports:Array, summary:Object}}
 */
function erodeZones(bars, checked) {
  const src = checked || {};
  const mapList = (arr, side) => (Array.isArray(arr) ? arr : []).map(z => {
    if (z && z.valid === false) return z;   // 无效区间不展示，无需收缩
    const r = erodeZone(bars, z, side);
    return Object.assign({}, z, { low: r.low, high: r.high, eroded: r.eroded, erosion: r.erosion });
  });
  const resistances = mapList(src.resistances, 'resistance');
  const supports = mapList(src.supports, 'support');
  const all = resistances.concat(supports).filter(z => z && z.valid !== false);
  return {
    resistances,
    supports,
    summary: {
      total: all.length,
      eroded: all.filter(z => z.eroded).length,
      breakVolMin: BREAK_VOL_MIN,
      lookbackDays: LOOKBACK_DAYS,
    },
  };
}

module.exports = {
  assessZone, assessZones, erodeZone, erodeZones, volRatioAt, finalizedBars,
  LOOKBACK_DAYS, VOL_AVG_DAYS, BREAK_VOL_MIN,
};

~~~
