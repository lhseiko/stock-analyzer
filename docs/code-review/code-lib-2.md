# 核心业务逻辑（lib/） · 第 2 卷

> 共 49 个文件，本卷约 17810 行


---

## `lib\fundamentalScore.js`  ·  411 行

~~~js
// ============================================================
// 基本面评分引擎（20260909d 重构版）—— 全个股通用、确定性计算（1+1=2）
// 规则（用户指令）：
//   总分 100 分，估值 / 盈利能力 / 成长性 / 财务健康 四维度各 25 分（固定，不随公司类型浮动）。
//   ① 估值：PE/PB/PS 任意一项为负 → 重度利空、本维度 0 分（不做中性评价）；三项全为正时，
//      各指标取「行业均值分位」×0.6 + 「自身历史百分位」×0.4 → 加权分位越低得分越高；PEG<1 额外 +5（封顶 25）。
//   ② 盈利能力：按滚动 12 个月（TTM）统一权威口径计算 ROE / 净利率 / 毛利率（20260909j 起取自
//      取数层 stockData.computeTtmMetrics，可加分子/分母滚动后相除；窗口不完整回退最新披露期）；
//      均值高于行业中枢得满分，低于则按与中枢的差值比例扣分。
//   ③ 成长性：纳入三项同比（合并营业收入 / 归母净利润 / 扣非净利润，均优先取本地财报库）；
//      任意一项为负 → 本维度 0 分；四项全为正 → 结合连续两年增速趋势 + 行业平均增速计分。
//   ④ 财务健康：资产负债率、流动比率、每股经营现金流、股息率；
//      负债率处于行业合理区间、流动比率 >1、每股经营现金流为正得高分，偏离则扣分。
//   ⑤ 全局兜底：任意指标因联网异常 / 接口故障 / 本地无对应财报无法取值时 → 标记「无法取值」、
//      显示 0、不参与该维度评分，并汇总为提示告知用户。
// 输出结构与旧版完全一致（metrics/scores/dimensionLogic/overall/rating），仅底层逻辑替换；
// 不触碰任何版面、字体、颜色。
// ============================================================

const clampPct = (x) => Math.max(0, Math.min(100, Number(x) || 0));
const { orderedYoYFields } = require('./growthCaliber'); // 20261104b 增长口径一键切换（单季/累计）
const num = (v) => {
  const n = parseFloat(v);
  return (v == null || isNaN(n) || !isFinite(n)) ? null : n;
};
/** 百分位：value 在样本数组中的排位（0~100，越小越低估/越差） */
function percentileRank(arr, value) {
  if (!Array.isArray(arr) || arr.length === 0 || value == null || !isFinite(value)) return null;
  const s = arr.filter(v => v != null && isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  let c = 0;
  for (const v of s) if (v <= value) c++;
  return Math.round((c / s.length) * 100);
}
/** 行业均值分位：以行业均值为 50 分位锚，按 value/均值 线性映射到 0~100（等于均值=50，2 倍均值=100） */
function industryPercentile(value, avg) {
  const v = num(value), a = num(avg);
  if (v == null || a == null || a <= 0 || v <= 0) return null;
  return Math.round(clampPct(50 * (v / a)));
}

// ---------- 财报库：滚动 12 个月（TTM）取值 ----------
// 20260909j：TTM 指标改取「取数层权威计算」字段（lib/stockData.js computeTtmMetrics 挂到 quote.fundamentals），
// 与关键财务指标行 / 利好利空信号 / 历史百分位 / 深度分析 ROE 走势图共用同一数值（单一权威源）。
// 此前在本模块对 ROEJQ/XSMLL/XSJLL「比率直接加减」重构 TTM 的做法在数学上不成立（各期分母不同），已废弃。
// 兜底：取数层 TTM 窗口不完整时，回退最新披露期口径并如实标注。
function ttmRatios(f) {
  const reason = 'TTM 窗口不完整（缺上一年报/上年同期或股本数据），回退最新披露期口径';
  return {
    roe:   { value: num(f.roeTtm),          basis: f.roeTtmBasis || '', reason: f.roeTtm == null ? reason : '' },
    net:   { value: num(f.netMarginTtm),    basis: '', reason: f.netMarginTtm == null ? reason : '' },
    gross: { value: num(f.grossMarginTtm),  basis: '', reason: f.grossMarginTtm == null ? reason : '' },
  };
}

/** 取最新一期的同比增速，以及「上年同期披露的同比」（用于两年趋势） */
// 20261102a（用户指令：增长指标优先最新单季口径）：fields 支持数组（逐行按序取首个非空值）——
// 增长类优先 DJD_*_YOY（东财主要指标自带单季同比），缺失回退累计口径 *_TZ；比率/水平类仍传单一字段。
function yoyPair(hist, fields) {
  const fl = Array.isArray(fields) ? fields : [fields];
  if (!Array.isArray(hist) || !hist.length) return { cur: null, prev: null, name: '', reason: '本地财报库无多期数据' };
  const rows = hist
    .map(d => {
      let v = null;
      for (const k of fl) { const n = num(d[k]); if (n != null) { v = n; break; } }
      return { d: new Date(String(d.REPORT_DATE || '').slice(0, 10)), v, name: d.REPORT_DATE_NAME || '' };
    })
    .filter(r => r.d && !isNaN(r.d.getTime()) && r.v != null)
    .sort((a, b) => b.d - a.d);
  if (!rows.length) return { cur: null, prev: null, name: '', reason: `财报库无「${fl.join('/')}」字段` };
  const latest = rows[0];
  const M = latest.d.getMonth() + 1;
  const prev = rows.find(r => r.d.getFullYear() === latest.d.getFullYear() - 1 && r.d.getMonth() + 1 === M);
  return { cur: latest.v, prev: prev ? prev.v : null, name: latest.name, reason: '' };
}

// ---------- 行业基准（单一来源：东财行业估值 + 已持久化行业均值） ----------
function buildBenchmark(industryAvg) {
  const ia = industryAvg || {};
  const pe = num(ia.pe), pb = num(ia.pb), ps = num(ia.ps);
  // 行业中枢：ROE ≈ PB/PE；净利率 ≈ PS/PE（由行业级估值恒等推导，非个股估算）
  const roe = (pb != null && pe != null && pe > 0) ? (pb / pe) * 100 : num(ia.roe);
  const netMargin = (ps != null && pe != null && pe > 0) ? (ps / pe) * 100 : null;
  return {
    pe, pb, ps, roe, netMargin,
    grossMargin: null,          // 行业毛利率中枢：当前数据源未提供 → 兜底
    revenueGrowth: null,        // 行业平均营收增速：当前数据源未提供 → 兜底
    debtRatio: null,            // 行业资产负债率中枢：当前数据源未提供 → 兜底
    source: ia.source || '东方财富行业估值',
  };
}

/** 资产负债率合理区间：行业中枢可得则用 中枢±15pp；否则按行业属性内置区间（确定性、可解释） */
function debtReasonRange(benchRow, industryName, isFinancial) {
  const mid = num(benchRow);
  if (mid != null && mid > 0) return { low: mid - 15, high: mid + 15, basis: `行业中枢 ${mid.toFixed(1)}% ± 15pp` };
  if (isFinancial) return { low: 80, high: 96, basis: '金融业高杠杆属经营常态（内置合理区间 80%~96%）' };
  if (/地产|建筑|房屋|基建国|工程/i.test(industryName || '')) return { low: 60, high: 80, basis: '重资产/地产建筑类（内置合理区间 60%~80%）' };
  return { low: 30, high: 60, basis: '一般行业（内置合理区间 30%~60%）' };
}

/**
 * 计算基本面评分
 * @param {object} opts { quote, companyType, industryAvg, percentiles }
 */
function computeFundamentalScore({ quote, companyType, industryAvg } = {}) {
  const f = (quote && quote.fundamentals) || {};
  const isFinancial = !!(companyType && companyType.isFinancial);
  const industryName = f.industryName || '';
  const bm = buildBenchmark(industryAvg);

  const DIM = 25;   // 四维度各 25 分，固定
  const unavailable = [];   // 全局兜底清单：{ dimension, metric, reason }
  const mark = (dimension, metric, reason) => unavailable.push({ dimension, metric, reason });

  const result = {
    metrics: {},
    scores: {},
    overall: '未知',
    score: 0,
    rating: '',
    description: '',
    companyType: (companyType && companyType.type) || 'balanced',
    companyTypeName: (companyType && companyType.typeName) || '均衡型',
    unavailable,
    dimensionLogic: {},
  };

  const vh = Array.isArray(f.valuationHistory) ? f.valuationHistory : [];
  const zy = Array.isArray(f.zyzbHistory) ? f.zyzbHistory : [];

  // ================= ① 估值（25 分） =================
  const raw = { pe: num(f.pe), pb: num(f.pb), ps: num(f.ps) };
  result.metrics.pe = raw.pe || 0;
  result.metrics.pb = raw.pb || 0;
  result.metrics.ps = raw.ps || 0;
  result.metrics.peg = num(f.peg) || 0;
  result.metrics.evEbitda = num(f.evEbitda) || 0;

  let valScore = 0, valRule = '';
  const valMetrics = [];
  const NEGATIVE = Object.keys(raw).filter(k => raw[k] != null && raw[k] < 0);
  const MISSING = Object.keys(raw).filter(k => raw[k] == null);

  if (NEGATIVE.length) {
    // 任意一项为负 → 重度利空，本维度 0 分（不做中性评价）
    valScore = 0;
    valRule = `${NEGATIVE.map(k => k.toUpperCase()).join('/')} 为负 → 重度利空，估值维度直接 0 分（不做中性评价）`;
  } else {
    const benchMap = { pe: bm.pe, pb: bm.pb, ps: bm.ps };
    const seriesMap = { pe: vh.map(d => d.pe), pb: vh.map(d => d.pb), ps: vh.map(d => d.ps) };
    // 20260909j 审计：口径标注——PE/PS 为 TTM 滚动口径，PB 为最新报告期账面值（MRQ）口径
    const valUnit = { pe: 'TTM', pb: 'MRQ', ps: 'TTM' };
    let sumW = 0, cnt = 0;
    for (const k of ['pe', 'pb', 'ps']) {
      const v = raw[k];
      if (v == null) { mark('估值', k.toUpperCase(), '接口/财报无该指标取值'); valMetrics.push([`${k.toUpperCase()}（估值·${valUnit[k]}）`, '0（无法取值）']); continue; }
      if (v <= 0) { valMetrics.push([`${k.toUpperCase()}（估值·${valUnit[k]}）`, '0（无法取值）']); continue; }
      const hist = vh.length >= 30 ? percentileRank(seriesMap[k], v) : null;
      const ind = industryPercentile(v, benchMap[k]);
      if (hist == null) mark('估值', `${k.toUpperCase()} 历史百分位`, vh.length >= 30 ? '历史序列缺失该指标' : '估值历史序列不足 30 期');
      if (ind == null) mark('估值', `${k.toUpperCase()} 行业均值分位`, '行业均值缺失（联网异常或该行业无数据）');
      if (hist == null && ind == null) { valMetrics.push([`${k.toUpperCase()}（估值·${valUnit[k]}）`, '0（无法取值）']); continue; }
      // 单侧缺失时按另一侧等权替代（仍标注缺失项）
      const w = (ind != null && hist != null)
        ? ind * 0.6 + hist * 0.4
        : (ind != null ? ind : hist);
      sumW += w; cnt++;
      valMetrics.push([`${k.toUpperCase()}（行业分位/历史分位）`,
        `${ind == null ? '—' : ind} / ${hist == null ? '—' : hist} → 加权 ${Math.round(w)}`]);
    }
    if (cnt === 0) {
      valScore = 0;
      valRule = 'PE/PB/PS 三项均无法取值 → 本维度不参与评分（0 分）';
      mark('估值', '估值维度', '三项指标均无法取值，维度不参与评分');
    } else {
      const avgW = sumW / cnt;
      valScore = 25 * (1 - avgW / 100);   // 加权分位越低（越便宜）→ 得分越高
      valRule = `${cnt} 项有效：加权分位均值 ${Math.round(avgW)}（行业分位×0.6 + 历史分位×0.4），得分 = 25 ×(1 − ${Math.round(avgW)}/100) = ${valScore.toFixed(1)}`;
      const peg = num(f.peg);
      if (peg == null) {
        mark('估值', 'PEG', '接口无 PEG 取值，未计入 +5 加成');
      } else if (peg > 0 && peg < 1) {
        valScore += 5;
        valRule += `；PEG ${peg.toFixed(2)} < 1 额外 +5`;
      }
      valScore = Math.max(0, Math.min(DIM, valScore));
    }
  }
  const valActual = Math.round(valScore);
  result.scores.valuation = { score: valActual, max: DIM, label: '估值' };
  result.dimensionLogic.valuation = {
    label: '估值', score: valActual, max: DIM,
    metrics: valMetrics.length ? valMetrics : [
      ['市盈率 PE(TTM)', raw.pe ? raw.pe.toFixed(1) + ' 倍' : '无法取值'],
      ['市净率 PB(MRQ)', raw.pb ? raw.pb.toFixed(1) + ' 倍' : '无法取值'],
      ['市销率 PS(TTM)', raw.ps ? raw.ps.toFixed(1) : '无法取值'],
    ],
    rule: valRule || '—',
    summary: `估值维度固定 ${DIM} 分；PE/PS 为 TTM 滚动口径、PB 为最新报告期账面值（MRQ）口径；任一项为负即判重度利空得 0 分，三项为正时按「行业均值分位×0.6 + 历史百分位×0.4」加权，分位越低得分越高，PEG<1 额外 +5（封顶 ${DIM}）。本次得 ${valActual}/${DIM} 分。`,
  };
  let total = valActual;

  // ================= ② 盈利能力（25 分） =================
  // 20260909j：统一取「取数层权威 TTM」（stockData.computeTtmMetrics → quote.fundamentals.roeTtm 等），
  // 与关键财务指标行 / 信号 / 百分位 / 深度分析走势图同源；无法取 TTM 时回退最新披露期口径（如实标注）。
  const ttm = ttmRatios(f);
  const ttmRoe = ttm.roe;
  const ttmNet = ttm.net;
  const ttmGross = ttm.gross;
  result.metrics.roe = ttmRoe.value != null ? ttmRoe.value : (num(f.roe) || 0);
  result.metrics.netMargin = ttmNet.value != null ? ttmNet.value : (num(f.netMargin) || 0);
  result.metrics.grossMargin = ttmGross.value != null ? ttmGross.value : (num(f.grossMargin) || 0);
  result.metrics.roa = num(f.returnOnAssets) || 0;

  const profItems = [
    { key: 'ROE', v: ttmRoe.value, basis: ttmRoe.basis, reason: ttmRoe.reason, center: bm.roe, centerTxt: bm.roe != null ? bm.roe.toFixed(2) + '%' : null },
    { key: '净利率', v: ttmNet.value, basis: ttmNet.basis, reason: ttmNet.reason, center: bm.netMargin, centerTxt: bm.netMargin != null ? bm.netMargin.toFixed(2) + '%' : null },
    { key: '毛利率', v: ttmGross.value, basis: ttmGross.basis, reason: ttmGross.reason, center: bm.grossMargin, centerTxt: null },
  ];
  let profSum = 0, profCnt = 0;
  const profMetrics = [];
  for (const it of profItems) {
    if (it.v == null) {
      mark('盈利能力', it.key, it.reason || '本地财报库无对应财报');
      profMetrics.push([`${it.key}（TTM）`, '0（无法取值）']);
      continue;
    }
    if (it.center == null) {
      mark('盈利能力', `${it.key} 行业中枢`, '当前数据源未提供该指标行业中枢');
      profMetrics.push([`${it.key}（TTM）`, `${it.v.toFixed(2)}%（无行业中枢，不参与评分）`]);
      continue;
    }
    const full = DIM / 3;
    const s = it.v >= it.center ? full : full * Math.max(0, it.v / it.center);
    profSum += s; profCnt++;
    profMetrics.push([`${it.key}（TTM / 行业中枢）`, `${it.v.toFixed(2)}% / ${it.centerTxt} → ${s.toFixed(1)} 分`]);
  }
  // 按「有效指标数」归一到 25 分（无法取值的指标不参与评分，不稀释得分）
  const profActual = Math.round(profCnt ? Math.min(DIM, (profSum / profCnt) * 3) : 0);
  result.scores.profitability = { score: profActual, max: DIM, label: '盈利能力' };
  result.dimensionLogic.profitability = {
    label: '盈利能力', score: profActual, max: DIM,
    metrics: profMetrics,
    rule: profCnt
      ? `${profCnt} 项有效（滚动12个月口径：${profItems.filter(p => p.v != null && p.center != null).map(p => `${p.key} ${p.v.toFixed(2)}% vs 中枢 ${p.centerTxt}`).join('；')}）；高于中枢得满分，低于按差值比例扣分`
      : '全部指标无法取值 → 本维度不参与评分（0 分）',
    summary: `盈利能力维度固定 ${DIM} 分；按滚动 12 个月（TTM）统一权威口径计算——ROE＝TTM归母净利÷期末归母净资产、毛利率/净利率＝TTM分子÷TTM营收（与关键财务指标行同源），与行业中枢比较，高于得满分、低于按比例扣分；无法取值项不参与评分。本次得 ${profActual}/${DIM} 分。`,
  };
  if (!profCnt) mark('盈利能力', '盈利能力维度', '全部指标无法取值，维度不参与评分');
  total += profActual;

  // ================= ③ 成长性（25 分） =================
  // 三项指标均优先从本地财报库（zyzbHistory）取数。
  // 20261102a（用户指令）：三项同比优先「最新单季」口径（DJD_*_YOY），单季缺失回退累计（*_TZ）——
  //   单季营收同比 DJD_TOI_YOY / 单季归母净利同比 DJD_DPNP_YOY / 单季扣非同比 DJD_DEDUCTDPNP_YOY。
  // 20261104b（用户指令）：字段优先级随口径设置重排（单季/累计一键切换），与右卡指标分析同口径。
  const revYoY = yoyPair(zy, orderedYoYFields(['DJD_TOI_YOY', 'TOTALOPERATEREVETZ']));   // 营业总收入同比（口径随设置，组内回退）
  const npYoY = yoyPair(zy, orderedYoYFields(['DJD_DPNP_YOY', 'PARENTNETPROFITTZ']));     // 归母净利润同比（口径随设置，组内回退）
  const dedYoY = yoyPair(zy, orderedYoYFields(['DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ']));  // 扣非净利润同比（口径随设置，组内回退）
  const growthItems = [
    { key: '合并口径营业收入同比', cur: revYoY.cur, prev: revYoY.prev, name: revYoY.name, reason: revYoY.reason },
    { key: '归母净利润同比', cur: npYoY.cur, prev: npYoY.prev, name: npYoY.name, reason: npYoY.reason },
    { key: '扣非净利润同比', cur: dedYoY.cur, prev: dedYoY.prev, name: dedYoY.name, reason: dedYoY.reason },
  ];
  const gAvail = growthItems.filter(g => g.cur != null);
  const gNegative = growthItems.filter(g => g.cur != null && g.cur < 0);
  let growthScore = 0, growthRule = '';
  const growthMetrics = [];
  for (const g of growthItems) {
    if (g.cur == null) {
      mark('成长性', g.key, g.reason || '本地财报库无对应财报');
      growthMetrics.push([g.key, '0（无法取值）']);
    } else {
      growthMetrics.push([g.key, `${g.cur.toFixed(2)}%${g.prev != null ? `（上年同期 ${g.prev.toFixed(2)}%）` : ''}`]);
    }
  }
  if (gNegative.length) {
    growthScore = 0;
    growthRule = `${gNegative.map(g => `${g.key} ${g.cur.toFixed(2)}%`).join('、')} 为负 → 本维度直接 0 分`;
  } else if (!gAvail.length) {
    growthScore = 0;
    growthRule = '三项增速均无法取值 → 本维度不参与评分（0 分）';
    mark('成长性', '成长性维度', '三项增速均无法取值，维度不参与评分');
  } else {
    // 绝对增速档位 × 两年趋势系数（行业平均增速不可得时，以趋势与绝对档位计分）
    const levelOf = (g) => (g > 30 ? 1 : g > 20 ? 0.8 : g > 10 ? 0.6 : g > 5 ? 0.4 : 0.2);
    let sum = 0;
    for (const g of gAvail) {
      const trend = (g.prev == null) ? 1 : (g.cur > g.prev ? 1.15 : (Math.abs(g.cur - g.prev) < 0.5 ? 1 : 0.85));
      sum += DIM * levelOf(g.cur) * trend;
    }
    growthScore = Math.min(DIM, sum / gAvail.length);
    growthRule = `${gAvail.length} 项有效：${gAvail.map(g => `${g.key} ${g.cur.toFixed(2)}%`).join('、')}；按绝对增速档位 × 两年趋势系数（加速×1.15 / 持平×1.0 / 减速×0.85）计分`;
    if (bm.revenueGrowth == null) mark('成长性', '行业平均增速', '当前数据源未提供行业平均增速，已按自身两年趋势与绝对档位计分');
  }
  const growthActual = Math.round(Math.max(0, Math.min(DIM, growthScore)));
  result.metrics.revenueGrowth = revYoY.cur != null ? revYoY.cur : (num(f.revenueYoy) || 0);
  result.metrics.profitGrowth = npYoY.cur != null ? npYoY.cur : (num(f.profitYoy) || 0);
  result.metrics.deductedProfitGrowth = dedYoY.cur != null ? dedYoY.cur : 0;
  result.scores.growth = { score: growthActual, max: DIM, label: '成长性' };
  result.dimensionLogic.growth = {
    label: '成长性', score: growthActual, max: DIM,
    metrics: growthMetrics,
    rule: growthRule || '—',
    summary: `成长性维度固定 ${DIM} 分；三项同比（合并营业收入/归母净利润/扣非净利润，单季口径优先、缺单季回退累计）任意一项为负即 0 分，全为正时结合连续两年增速趋势与行业平均增速计分；无法取值项不参与评分。本次得 ${growthActual}/${DIM} 分。`,
  };
  total += growthActual;

  // ================= ④ 财务健康（25 分） =================
  const debt = num(f.debtToEquity);              // A股为资产负债率%
  const isPct = !!f.debtMetricPct;
  const cr = num(f.currentRatio);
  const ocfps = num(f.operatingCashFlowPerShare);
  // 20260909k 审计：与 analysis.js/companyType.js 同款守卫——东财源值已是百分数（dividendYieldIsPct），仅无标记的兜底源做小数换算
  const divYRaw = num(f.dividendYield);
  const divY = (divYRaw != null && divYRaw < 1 && !f.dividendYieldIsPct) ? divYRaw * 100 : divYRaw;
  result.metrics.debtToEquity = debt != null ? debt : 0;
  result.metrics.debtMetricPct = isPct;
  result.metrics.currentRatio = cr != null ? cr : 0;
  result.metrics.quickRatio = num(f.quickRatio) || 0;
  result.metrics.operatingCashFlowPerShare = ocfps != null ? ocfps : 0;
  result.metrics.dividendYield = divY != null ? divY : 0;

  const full = DIM / 4;   // 四项各 6.25 分
  let healthSum = 0, healthCnt = 0;
  const healthMetrics = [];
  // 资产负债率
  if (debt == null) {
    mark('财务健康', '资产负债率', '财报/接口无该指标取值');
    healthMetrics.push(['资产负债率', '0（无法取值）']);
  } else if (!isPct) {
    healthMetrics.push(['带息债/权益', `${debt.toFixed(2)}（非百分比口径，不参与评分）`]);
    mark('财务健康', '资产负债率', '非百分比口径（港股/美股），行业合理区间不适用');
  } else {
    const rg = debtReasonRange(bm.debtRatio, industryName, isFinancial);
    let s;
    if (debt >= rg.low && debt <= rg.high) s = full;
    else {
      const dev = debt < rg.low ? (rg.low - debt) : (debt - rg.high);
      s = full * Math.max(0, 1 - dev / 30);   // 每偏离 30pp 扣满
    }
    healthSum += s; healthCnt++;
    healthMetrics.push(['资产负债率', `${debt.toFixed(2)}%（合理区间 ${rg.low.toFixed(0)}~${rg.high.toFixed(0)}%，${rg.basis}）→ ${s.toFixed(1)} 分`]);
  }
  // 流动比率
  if (cr == null) {
    mark('财务健康', '流动比率', '财报/接口无该指标取值');
    healthMetrics.push(['流动比率', '0（无法取值）']);
  } else {
    const s = cr >= 2 ? full : (cr >= 1.5 ? full * 0.85 : (cr > 1 ? full * 0.7 : 0));
    healthSum += s; healthCnt++;
    healthMetrics.push(['流动比率', `${cr.toFixed(2)}${cr > 1 ? '（>1，达标）' : '（≤1，不达标）'} → ${s.toFixed(1)} 分`]);
  }
  // 每股经营现金流
  if (ocfps == null) {
    mark('财务健康', '每股经营现金流', '财报/接口无该指标取值');
    healthMetrics.push(['每股经营现金流', '0（无法取值）']);
  } else {
    const s = ocfps > 0 ? full : 0;
    healthSum += s; healthCnt++;
    healthMetrics.push(['每股经营现金流', `${ocfps.toFixed(3)} 元${ocfps > 0 ? '（为正，达标）' : '（非正，不达标）'} → ${s.toFixed(1)} 分`]);
  }
  // 股息率
  if (divY == null) {
    mark('财务健康', '股息率', '分红数据缺失（接口无股息率）');
    healthMetrics.push(['股息率', '0（无法取值）']);
  } else {
    const s = divY >= 3 ? full : (divY >= 1 ? full * 0.6 : (divY > 0 ? full * 0.3 : 0));
    healthSum += s; healthCnt++;
    healthMetrics.push(['股息率', `${divY.toFixed(2)}% → ${s.toFixed(1)} 分`]);
  }
  const healthActual = Math.round(healthCnt ? Math.min(DIM, (healthSum / healthCnt) * 4) : 0);
  result.scores.health = { score: healthActual, max: DIM, label: '财务健康' };
  result.dimensionLogic.health = {
    label: '财务健康', score: healthActual, max: DIM,
    metrics: healthMetrics,
    rule: healthCnt
      ? `${healthCnt} 项有效：资产负债率/流动比率/每股经营现金流/股息率分档计分（负债率偏离合理区间每 30pp 扣满、流动比率需 >1、每股经营现金流需为正）`
      : '四项指标均无法取值 → 本维度不参与评分（0 分）',
    summary: `财务健康维度固定 ${DIM} 分；以资产负债率（行业合理区间）、流动比率（>1）、每股经营现金流（为正）、股息率四项计分，偏离则按比例扣分；无法取值项不参与评分。本次得 ${healthActual}/${DIM} 分。`,
  };
  if (!healthCnt) mark('财务健康', '财务健康维度', '四项指标均无法取值，维度不参与评分');
  total += healthActual;

  result.score = Math.round(total);
  if (result.score >= 80) { result.overall = '优秀'; result.rating = 'A+'; }
  else if (result.score >= 65) { result.overall = '良好'; result.rating = 'A'; }
  else if (result.score >= 50) { result.overall = '一般'; result.rating = 'B'; }
  else if (result.score >= 35) { result.overall = '较弱'; result.rating = 'C'; }
  else { result.overall = '较差'; result.rating = 'D'; }

  // 20260919a：原「分析师评级」（analystTarget）底层逻辑已删除，改由 lib/metricAnalysis.js「指标分析」承接。
  const parts = [];
  if (result.metrics.pe > 0) parts.push(`市盈率${result.metrics.pe.toFixed(1)}倍`);
  if (result.metrics.pb > 0) parts.push(`市净率${result.metrics.pb.toFixed(1)}倍`);
  if (result.metrics.roe > 0) parts.push(`ROE ${result.metrics.roe.toFixed(1)}%`);
  if (result.metrics.netMargin > 0) parts.push(`净利率${result.metrics.netMargin.toFixed(1)}%`);
  result.description = parts.join('，');

  // 提示文案（供前端弹出告知）
  result.notice = unavailable.length
    ? `有 ${unavailable.length} 项指标无法取值（已显示为 0 并排除出对应维度评分）：` +
      unavailable.slice(0, 8).map(u => `${u.dimension}·${u.metric}`).join('、') +
      (unavailable.length > 8 ? ' 等' : '')
    : '';
  return result;
}

module.exports = { computeFundamentalScore, ttmRatios, yoyPair, percentileRank, industryPercentile, buildBenchmark };

~~~

---

## `lib\fundIndustryMatrix.js`  ·  1010 行

~~~js
/**
 * 全市场「基金行业配置」聚合模块
 * ==============================================================
 * 目标：把**大部分公募基金**（权益类，按母基金去重）最新报告期的**前十大重仓股**，
 *       按个股所属行业聚合，按**持仓市值（万元）**加总后排名，得到「基金行业配置名单」。
 *
 * 数据源（全部为东方财富公开接口，无需鉴权）：
 *   1) 基金全量列表   https://fund.eastmoney.com/js/fundcode_search.js
 *   2) 单只基金前十大重仓股（含 持仓市值 万元）
 *      https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=<code>&topline=10&year=<Y>&month=
 *   3) 个股 → 行业：resolveSectorIdentity（东财 F10/申万）；港股用 push2delay f127
 *
 * 关键设计（为什么这样写）：
 *   * **按母基金去重**：东财对同一只基金的 A/C 等份额报出**完全相同的持仓市值**
 *     （实测 021179 与 021180 每只重仓股市值逐位相同），说明市值是"母基金"口径。
 *     若按份额全爬会把同一笔持仓重复加总 N 倍（权益类 17920 份额 → 10126 母基金，43.5% 是重复）。
 *   * **磁盘缓存 + 可续跑**：全量约 1 万只基金，单次采集需十几分钟；数据是**季报**口径，
 *     一季度内不变。故落盘缓存，重跑时跳过已采集的，进程重启也能接着跑。
 *   * **低并发错峰**：fundf10 对同 IP 短时并发会限流（实测并发 6 时 120 请求失败 83 个；
 *     并发 4 + 间隔 80ms + 重试则 240 请求仅失败 1 个）。
 *
 * 更新频率（**自然季度**，不是「上次采集后 +90 天」）：
 *   报告期与自然季度严格对应，例如 2026Q2 报告 = 自然季度 Q2（4~6月）的持仓。
 *   进入新自然季度后（如 7/1 起盯 2026Q2 报告、10/1 起盯 2026Q3 报告），本模块每天检查一次
 *   东财「当前实际最新报告期」是否已开始发布；一旦开始发布，就**分批次**增量更新
 *   （每天一批，受时间预算约束），直到全部母基金都更新到本季度为止，然后本季度结束。
 *   现实中各基金披露日期不同（大公司先、小公司后，季报在季末后 15 个工作日内），
 *   所以「每天一批、未出的次日再探」天然对应真实披露节奏。
 *
 * 产物文件（data/fund_holdings/）：
 *   universe.json  基金宇宙（权益类母基金列表）
 *   holdings.json  每只母基金最新报告期前十大重仓股（+ 上一报告期，供环比）
 *   progress.json  采集进度（阶段/完成数/失败清单/速率/ETA）
 *   quarter.json   自然季度账本（目标报告期/是否已发布/是否完成/每日执行记录）
 *   ../stock_industry_cache.json  个股→行业 磁盘缓存（90 天，**与更新频率无关**）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveSectorIdentity } = require('./sectorIdentity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, '..', 'data', 'fund_holdings');
const F_UNIVERSE = path.join(DATA_DIR, 'universe.json');
const F_HOLDINGS = path.join(DATA_DIR, 'holdings.json');
const F_PROGRESS = path.join(DATA_DIR, 'progress.json');
const F_QUARTER = path.join(DATA_DIR, 'quarter.json');
const F_IND = path.join(__dirname, '..', 'data', 'stock_industry_cache.json');

const UNIVERSE_TTL = 7 * 24 * 3600 * 1000;    // 基金列表 7 天
const INDUSTRY_TTL = 90 * 24 * 3600 * 1000;   // 个股行业 90 天（行业归属极少变动；仅影响「是否重解析行业」，与季度更新无关）

// 权益类口径：有股票持仓的基金；剔除债券/货币/理财/REITs/商品（无股票十大重仓）
const RE_EQUITY = /股票|混合|指数|QDII/;
const RE_EXCLUDE = /债券|货币|Reits|REITs|FOF|商品|理财|其他|^$/i;

const CONC = 3;        // 持仓采集并发
const IND_CONC = 2;    // 个股→行业 解析并发（与持仓采集并行，不额外抬高单点压力）
const GAP_MS = 80;     // 每次请求之间的错峰间隔
const RETRY = 3;       // 单只基金重试次数
const SAVE_EVERY = 250;                       // 每处理 N 只落盘一次
const SAVE_MS = 60 * 1000;                    // 另外按时间兜底落盘（最多丢 60 秒进度）

// —— 自然季度更新调度参数 ——
const DAILY_HOUR = 19;                        // 每日检查时刻（收盘后）；启动时若当天未跑过则忽略该时刻补跑
const DAILY_BATCH = 2500;                     // 单日单轮最多处理的基金数（分批推进）
const DAILY_BUDGET_MS = 20 * 60 * 1000;       // 单日单轮时间预算，到点即暂停、次日继续
// 披露宽限期（自自然季度开始日起算）：超过该天数仍有基金未出报告期，则记为「滞后」并不再阻塞「本季完成」。
// 依据公募基金信息披露规则：季报=季末后 15 个工作日内；半年报(Q2 持仓)=上半年结束后 60 日内；
// 年报(Q4 持仓)=年度结束后 90 日内。留足缓冲，避免每天无限重试迟报基金。
const GRACE_DAYS_BY_Q = { 1: 40, 2: 70, 3: 40, 4: 100 };

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _num = (s) => parseFloat(String(s).replace(/,/g, ''));
const _stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function _ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ } }
function _loadJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function _saveJson(file, obj) {
  try {
    _ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { console.error('[FundMatrix] 写盘失败', file, e.message); }
}

/** 母基金名：去掉尾部份额字母与括号后缀（A/C/E/I/O/后端/美元/人民币/发起式…） */
function baseFundName(n) {
  let s = String(n || '').trim();
  s = s.replace(/[（(][^)）]*[)）]\s*$/g, '');
  s = s.replace(/\s+/g, '');
  for (let i = 0; i < 3; i++) s = s.replace(/[A-Za-z]{1,3}$/, '');
  return s;
}

// ---------- 1) 基金宇宙（权益类，按母基金去重） ----------
async function getFundUniverse(opts = {}) {
  const cached = _loadJson(F_UNIVERSE, null);
  if (!opts.force && cached && cached.list && cached.list.length && (Date.now() - (cached.ts || 0) < UNIVERSE_TTL)) {
    return cached;
  }
  const r = await axios.get('https://fund.eastmoney.com/js/fundcode_search.js', {
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
    timeout: 30000, responseType: 'text',
  });
  const m = String(r.data).match(/\[\s*\[[\s\S]*?\]\s*\]/);
  if (!m) throw new Error('基金列表解析失败');
  const arr = JSON.parse(m[0]);
  const seen = new Set();
  const list = [];
  let shareClasses = 0;
  for (const x of arr) {
    const type = x[3] || '';
    if (!RE_EQUITY.test(type) || RE_EXCLUDE.test(type)) continue;
    shareClasses++;
    const base = baseFundName(x[2]);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    list.push({ code: x[0], name: x[2], base, type });
  }
  const out = { ts: Date.now(), total: arr.length, shareClasses, list };
  _saveJson(F_UNIVERSE, out);
  console.log(`[FundMatrix] 基金宇宙：全量 ${arr.length} → 权益类份额 ${shareClasses} → 母基金 ${list.length}`);
  return out;
}

// ---------- 2) 单只基金前十大重仓股（一次请求返回最近两个季度）----------
// 报告期排序键：'2026年2季度' → 20262（用于比较/取最新两个季度）
function _qKey(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  return m ? parseInt(m[1], 10) * 10 + parseInt(m[2], 10) : -1;
}
function _qLabel(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  return m ? `${m[1]}Q${m[2]}` : String(q || '');
}
/** 紧邻的上一报告期：'2026年2季度' → '2026年1季度'；'2026年1季度' → '2025年4季度' */
function _prevQuarterOf(q) {
  const m = String(q || '').match(/(\d{4})年(\d)季度/);
  if (!m) return '';
  let y = parseInt(m[1], 10), n = parseInt(m[2], 10) - 1;
  if (n < 1) { n = 4; y -= 1; }
  return `${y}年${n}季度`;
}

// ---------- 2.5) 自然季度：目标报告期 + 季度账本 ----------
function _dateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 自然季度 → 应当采集的报告期。
 * 报告期与自然季度一一对应：进入新自然季度后，盯的是「上一个已结束的自然季度」的报告。
 *   1/1 ~ 3/31  → 上一年 4 季度报告
 *   4/1 ~ 6/30  → 当年   1 季度报告
 *   7/1 ~ 9/30  → 当年   2 季度报告
 *  10/1 ~12/31  → 当年   3 季度报告
 * 注意：报告披露有滞后（季报在季末后 15 个工作日内），所以「是否真的可以采」由
 * detectLatestPeriod() 探测东财实际返回的最新报告期来决定，本函数只负责给出**目标**。
 */
function naturalQuarterTarget(d = new Date()) {
  const y = d.getFullYear();
  const nq = Math.floor(d.getMonth() / 3) + 1;      // 当前所在自然季度 1~4
  let yr = y, q = nq - 1;
  if (q < 1) { q = 4; yr = y - 1; }
  return {
    period: `${yr}年${q}季度`,
    key: yr * 10 + q,
    label: `${yr}Q${q}`,
    naturalQuarter: `${y}Q${nq}`,
    naturalQuarterLabel: `${y} 年第 ${nq} 季度`,
    windowStart: `${y}-${String((nq - 1) * 3 + 1).padStart(2, '0')}-01`,
  };
}

/** 下一次「每日检查」的时刻（用于前端展示） */
function _nextDailyCheckAt() {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAILY_HOUR, 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/**
 * 该基金相对目标报告期是否还需要继续处理（拉取/重试）。
 * 判据必须与「本季完成」的统计口径完全一致，否则会出现 remaining 永远不归零、
 * 每天白跑一批的死循环（**历史踩坑**）。
 *  - 对 2026Q2 这种「季报」达标即可；核对标记 ck 记录「该条数据是冲着哪个报告期抓的」。
 *  - 旧缓存没有 ck → 以其自身报告期为标记（等价于「上次就是冲那一期抓的」）。
 */
function _needsWork(e, targetKey) {
  if (!e || !('q' in e)) return true;                          // 从未采集 / 旧格式
  const ck = (e.ck == null) ? _qKey(e.q) : e.ck;
  if (ck !== targetKey) return true;                           // 还没针对本目标期核对过
  if (!e.q) return false;                                      // 已核对本目标期，确认无持仓 → 完结
  return _qKey(e.q) < targetKey;                               // 仍落后 → 继续重试（直到披露或宽限期结束）
}

/** 本自然季度的披露宽限期（天） */
function _graceDays(t) {
  const m = String((t && t.period) || '').match(/(\d)季度/);
  return (m && GRACE_DAYS_BY_Q[parseInt(m[1], 10)]) || 45;
}

/**
 * 统计相对本自然季度目标期的更新情况。
 *  remaining 只统计「宽限期内、仍待处理」的基金；超过宽限期仍滞后的记入 lagged 且不阻塞「完成」。
 */
function _countQuarter(list, H, targetKey) {
  const t = naturalQuarterTarget();
  const daysIn = Math.floor((Date.now() - new Date(t.windowStart + 'T00:00:00').getTime()) / 86400000);
  const grace = _graceDays(t);
  const graceOver = daysIn > grace;
  let remaining = 0, updatedTo = 0, lagged = 0;
  for (const f of list) {
    const e = H[f.code];
    if (e && e.q && _qKey(e.q) >= targetKey) { updatedTo++; continue; }
    if (!_needsWork(e, targetKey)) continue;                   // 已核对且确认无持仓 → 完结
    if (graceOver) { lagged++; continue; }                     // 宽限期已过 → 记为滞后
    remaining++;
  }
  return { remaining, updatedTo, lagged, daysIn, grace, graceOver };
}

let _ledger = null;
function _lg() { if (!_ledger) _ledger = _loadJson(F_QUARTER, null) || {}; return _ledger; }
function _saveLedger() { if (_ledger) _saveJson(F_QUARTER, _ledger); }

/** 新建/重置某自然季度的账本。保留 holdings 作为数据基础（新报告期靠重采覆盖）。 */
function _newLedger(t) {
  _ledger = {
    target: t.period, targetKey: t.key, label: t.label,
    naturalQuarter: t.naturalQuarter, windowStart: t.windowStart,
    published: false,            // 东财是否已开始发布该报告期
    done: false,                 // 本季度是否已全部更新完成
    createdAt: Date.now(), startedAt: 0, finishedAt: 0,
    lastProbeDate: '', lastProbePeriod: '',
    lastRunDate: '', batchRuns: 0,
    remaining: -1, updatedTo: 0,
  };
  _saveLedger();
  return _ledger;
}

/** 账本 → 前端可见的季度状态 */
function getQuarterStatus() {
  const t = naturalQuarterTarget();
  const L = _lg();
  const stale = !L || L.target !== t.period;          // 是否已跨入新自然季度（尚未重置账本）
  // 宽限期相关字段：账本尚未写入时按实时计算，避免显示 0
  const graceLive = _graceDays(t);
  const daysInLive = Math.max(0, Math.floor((Date.now() - new Date(t.windowStart + 'T00:00:00').getTime()) / 86400000));
  return {
    naturalQuarter: t.naturalQuarter,
    naturalQuarterLabel: t.naturalQuarterLabel,
    windowStart: t.windowStart,
    target: t.period,
    targetLabel: t.label,
    targetKey: t.key,
    inWindow: !stale,
    published: !stale && !!L.published,
    done: !stale && !!L.done,
    lastProbeDate: stale ? '' : (L.lastProbeDate || ''),
    lastProbePeriod: stale ? '' : (L.lastProbePeriod || ''),
    lastProbeLabel: stale ? '' : _qLabel(L.lastProbePeriod || ''),
    lastRunDate: stale ? '' : (L.lastRunDate || ''),
    batchRuns: stale ? 0 : (L.batchRuns || 0),
    remaining: stale ? -1 : (L.remaining == null ? -1 : L.remaining),
    updatedTo: stale ? 0 : (L.updatedTo || 0),
    lagged: stale ? 0 : (L.lagged || 0),
    daysIn: stale ? daysInLive : (L.daysIn || daysInLive),
    grace: stale ? graceLive : (L.grace || graceLive),
    graceOver: stale ? (daysInLive > graceLive) : (L.graceOver == null ? (daysInLive > graceLive) : !!L.graceOver),
    startedAt: stale ? 0 : (L.startedAt || 0),
    finishedAt: stale ? 0 : (L.finishedAt || 0),
    dailyHour: DAILY_HOUR,
    dailyBatch: DAILY_BATCH,
    nextCheckAt: _nextDailyCheckAt(),
  };
}

function _parseQuarterBox(box) {
  const qm = box.match(/(\d{4}年\d季度)股票投资明细/);
  const quarter = qm ? qm[1] : '';
  const rows = [];
  for (const tr of box.split('<tr>').slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => _stripTags(x[1]));
    if (cells.length < 4) continue;
    const ci = cells.findIndex((c) => /^\d{6}$/.test(c) || /^\d{5}$/.test(c));
    if (ci < 0) continue;
    const name = cells[ci + 1] || '';
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(name)) continue;
    // 列序：序号|代码|名称|最新价|涨跌幅|相关资讯|占净值比例|持股数(万股)|持仓市值(万元)
    const pi = cells.findIndex((c, i) => i > ci && /^\d+(\.\d+)?%$/.test(c));
    let shares = null, value = null;
    if (pi >= 0) {
      const nums = cells.slice(pi + 1).filter((c) => /^[\d,]+(\.\d+)?$/.test(c)).map(_num).filter(Number.isFinite);
      if (nums.length) shares = nums[0];
      if (nums.length > 1) value = nums[1];
    }
    rows.push({ code: cells[ci], name, weight: pi >= 0 ? _num(cells[pi]) : null, shares, value });
  }
  return { quarter, rows };
}

// 解析出页面内**全部季度**（东财一次返回最近两季），按报告期倒序
function _parseHoldingsHtml(html) {
  const m = String(html || '').match(/content:"([\s\S]*?)",arryear/);
  if (!m) return null;
  const boxes = m[1].split("<div class='boxitem").slice(1);
  if (!boxes.length) return null;
  const quarters = boxes.map(_parseQuarterBox).filter((q) => q.quarter && q.rows.length);
  if (!quarters.length) return null;
  quarters.sort((a, b) => _qKey(b.quarter) - _qKey(a.quarter));
  return { quarters };
}

async function _fetchHoldings(code, year) {
  const r = await axios.get(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=`, {
    headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
    timeout: 12000, responseType: 'text',
  });
  return _parseHoldingsHtml(r.data);
}

// 探测「东财当前实际最新报告期」：用几只大基金试抓，取最大报告期。
// 用途：① 每日「更新情况」检查——判断目标报告期是否已开始披露；② 展示用实际最新期。
// 传入 targetPeriod 时，一旦确认已到/超过目标期就立即返回（通常只花 1 次请求）。
const _PERIOD_PROBES = ['000001', '110011', '002910', '013840', '161725', '519674'];
async function detectLatestPeriod(targetPeriod) {
  const tk = _qKey(targetPeriod || '');
  const year = new Date().getFullYear();
  let best = '';
  for (const code of _PERIOD_PROBES) {
    for (const y of [year, year - 1]) {
      try {
        const p = await _fetchHoldings(code, y);
        const q = p && p.quarters && p.quarters[0] && p.quarters[0].quarter;
        if (q && _qKey(q) > _qKey(best)) best = q;
        // 已确认目标期（或更新）已发布 → 提前结束，省请求
        if (tk >= 0 && best && _qKey(best) >= tk) return best;
      } catch (e) { /* 忽略单只探测失败 */ }
      if (best && _qKey(best) >= _qKey(`${year}年4季度`)) break;
    }
    if (_qKey(best) > _qKey(`${year}年1季度`)) break;
  }
  return best;
}

// ---------- 3) 个股 → 行业（磁盘缓存） ----------
const INDUSTRY_MISS_TTL = 7 * 24 * 3600 * 1000;   // 「查不到」的短 TTL：避免每轮都重试无解标的（如部分港股）
let _indDisk = null;
function _indStore() { if (!_indDisk) _indDisk = _loadJson(F_IND, {}); return _indDisk; }
let _indDirty = 0;
function _indCacheSet(code, v) {
  const st = _indStore();
  st[code] = { v: v || '', ts: Date.now() };
  if (++_indDirty % 200 === 0) _saveJson(F_IND, st);
}
/** 该 code 是否已在缓存中「有结论」（可能是行业名，也可能是明确的查不到） */
function _indCacheResolved(code) {
  const hit = _indStore()[code];
  if (!hit) return false;
  return (Date.now() - hit.ts) < (hit.v ? INDUSTRY_TTL : INDUSTRY_MISS_TTL);
}
function _indCacheGet(code) {
  const st = _indStore(); const hit = st[code];
  if (hit && hit.v && Date.now() - hit.ts < INDUSTRY_TTL) return hit.v;
  return '';
}

async function _lookupHkIndustry(code) {
  try {
    const r = await axios.get(`https://push2delay.eastmoney.com/api/qt/stock/get?secid=116.${code}&fields=f57,f58,f127`, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 10000, responseType: 'text',
    });
    const j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const v = j && j.data && j.data.f127;
    return (v && v !== '-' && v !== '') ? String(v).trim() : '';
  } catch (e) { return ''; }
}

async function lookupIndustry(code, name) {
  if (_indCacheResolved(code)) return _indCacheGet(code);
  let v = '';
  try {
    if (/^\d{5}$/.test(String(code || ''))) {
      v = await _lookupHkIndustry(code);   // 港股：A 股映射不适用
    }
    if (!v) {
      const id = await Promise.race([
        resolveSectorIdentity(code, name || '').catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 15000)),
      ]);
      // 只认 identity.industry（东财行业名）；绝不接受股票名回显作为行业名
      if (id && id.ok && id.industry && id.industry !== '未知') v = id.industry;
    }
  } catch (e) { /* 保持空 */ }
  // ⚠️ 无论成功与否都落缓存：否则「查不到的标的」每轮都会被重新入队并各耗最多 15s（历史踩坑）
  _indCacheSet(code, v);
  return v;
}

// ---------- 4) 后台采集（可续跑） ----------
const state = {
  running: false,
  phase: '',            // 'universe' | 'holdings' | 'industry' | 'batch' | 'done' | 'stopped' | 'error'
  period: '',           // 最新报告期（如 2026年2季度）
  prevPeriod: '',       // 上一报告期（环比基准）
  total: 0, done: 0, failed: 0, ok: 0, withPrev: 0,
  indTotal: 0, indDone: 0, indUnresolved: 0,
  remaining: -1,        // 相对目标报告期仍待处理的基金数（-1 = 未知）
  updatedTo: 0,         // 已更新到目标报告期的基金数
  lagged: 0,            // 超过披露宽限期仍滞后的基金数
  graceOver: false,     // 是否已过披露宽限期
  budgetPaused: false,  // 是否因「单日时间预算」到点而暂停（次日继续）
  failedCodes: [],
  startedAt: 0, finishedAt: 0, lastTickAt: 0,
  rate: 0, etaSec: null, lastError: '',
};

let _stop = false;
let _holdings = null;
function _h() { if (!_holdings) _holdings = _loadJson(F_HOLDINGS, {}); return _holdings; }
function _persistProgress() {
  _saveJson(F_PROGRESS, {
    period: state.period, prevPeriod: state.prevPeriod, phase: state.phase,
    total: state.total, done: state.done, ok: state.ok, failed: state.failed, withPrev: state.withPrev,
    remaining: state.remaining, updatedTo: state.updatedTo,
    failedCodes: state.failedCodes.slice(-5000),
    startedAt: state.startedAt, finishedAt: state.finishedAt, updatedAt: Date.now(),
  });
}

function _loadProgress() {
  const p = _loadJson(F_PROGRESS, null);
  if (p && p.period !== undefined) {
    state.period = p.period || ''; state.prevPeriod = p.prevPeriod || '';
    state.phase = p.phase || ''; state.total = p.total || 0;
    state.done = p.done || 0; state.ok = p.ok || 0; state.failed = p.failed || 0;
    state.withPrev = p.withPrev || 0;
    state.remaining = p.remaining == null ? -1 : p.remaining;
    state.updatedTo = p.updatedTo || 0;
    state.failedCodes = Array.isArray(p.failedCodes) ? p.failedCodes : [];
    state.startedAt = p.startedAt || 0; state.finishedAt = p.finishedAt || 0;
  }
}

/** 当前最新报告期猜测（用于按年抓取；季度标签以页面实际返回为准） */
function _guessYear() { return new Date().getFullYear(); }

async function _runCrawl(opts = {}) {
  const force = !!opts.force;
  const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10) || 0) : 0;
  const budgetMs = Math.max(0, parseInt(opts.budgetMs || 0, 10) || 0);
  if (state.running) return getCrawlStatus();
  state.running = true; _stop = false; state.budgetPaused = false;
  const t0 = Date.now();
  if (force) { state.done = 0; state.ok = 0; state.failed = 0; state.failedCodes = []; state.updatedTo = 0; state.remaining = -1; _persistProgress(); }
  try {
    // --- 阶段 1：基金宇宙 ---
    state.phase = 'universe'; state.lastTickAt = t0;
    state.startedAt = state.startedAt || t0;
    const uni = await getFundUniverse({ force: !!force });
    const list = uni.list;

    // --- 阶段 2：逐只抓前十大重仓股（并与「个股→行业」解析并行）---
    state.phase = 'holdings';
    state.total = list.length;
    const H = _h();
    // 需要采集的条件：本轮 force / 未采集过 / 未针对本目标期核对过 / 报告期仍落后于目标期。
    // 判据统一走 _needsWork（与「本季完成」统计口径一致，避免 remaining 永不归零）。
    const targetKey = _qKey(opts.targetPeriod || '');
    const graceOver = targetKey >= 0 ? _countQuarter(list, H, targetKey).graceOver : false;
    const pendingAll = list.filter((f) => {
      if (force) return true;
      const e = H[f.code];
      if (targetKey < 0) return !e || !('q' in e);              // 无目标期：只补「从未采集」的缺口
      if (!_needsWork(e, targetKey)) return false;
      // 宽限期已过 → 只做一遍「未核对过本目标期」的普查，不再反复重试迟报基金
      if (graceOver) {
        const ck = (e && e.ck != null) ? e.ck : (e ? _qKey(e.q) : -1);
        return ck !== targetKey;
      }
      return true;
    });
    // 分批：只处理前 limit 只；但进度分母用**未分批**的 pendingAll，否则「已完成」会虚报
    const pending = limit ? pendingAll.slice(0, limit) : pendingAll;
    state.done = list.length - pendingAll.length;
    state.ok = Object.keys(H).length;
    let saved = 0, holdingsFinished = false, runCount = 0, lastSaveAt = t0;
    const year = _guessYear();

    // 个股→行业：独立小队列 + 2 个并行 worker。
    // 目的：不要等 1 万只基金全采完才解析行业，否则采集过程中「未分类」会占大头、排名没法看。
    const indQueue = new Map();          // 待解析 code -> name
    const seenCodes = new Set();
    const enqueue = (rows) => {
      for (const h of (rows || [])) {
        if (!h || !h.code || seenCodes.has(h.code)) continue;
        seenCodes.add(h.code);
        state.indTotal++;
        if (_indCacheResolved(h.code)) state.indDone++;
        else indQueue.set(h.code, h.name);
      }
    };
    for (const fc of Object.keys(H)) enqueue(H[fc].holdings);   // 历史缓存里的个股也补解析
    state.indDone = state.indTotal - indQueue.size;

    const indWorkers = Array.from({ length: IND_CONC }, async () => {
      while (true) {
        if (indQueue.size === 0) {
          if (holdingsFinished || _stop) return;
          await sleep(200); continue;
        }
        const [c, n] = indQueue.entries().next().value;
        indQueue.delete(c);
        await lookupIndustry(c, n);
        state.indDone++;
        if (_indDirty > 0 && state.indDone % 200 === 0) _saveJson(F_IND, _indStore());
        await sleep(GAP_MS);
      }
    });

    let cur = 0;
    const workers = Array.from({ length: CONC }, async () => {
      while (!_stop) {
        // 单日时间预算到点 → 暂停本轮，剩余留到下一次（次日）继续
        if (budgetMs && Date.now() - t0 > budgetMs) {
          state.budgetPaused = true; _stop = true; return;
        }
        const i = cur++; if (i >= pending.length) return;
        const f = pending[i];
        let got = null, ok = false;
        for (let a = 0; a < RETRY && !ok; a++) {
          try {
            let p = await _fetchHoldings(f.code, year);
            if ((!p || !p.quarters || !p.quarters.length)) p = await _fetchHoldings(f.code, year - 1);
            if (p && p.quarters && p.quarters.length) {
              got = p; ok = true;
            } else if (a === RETRY - 1) {
              got = null; ok = true; // 明确无数据（非失败）
            } else { await sleep(400 * (a + 1)); }
          } catch (e) {
            if (a === RETRY - 1) { got = null; ok = false; }
            else await sleep(400 * (a + 1));
          }
        }
        if (got) {
          // 页面一次返回最近两个季度 → 同时留下「最新季」与「上一季」，供环比变化使用
          const latest = got.quarters[0];
          const prev = got.quarters[1] || null;
          H[f.code] = {
            name: f.name, base: f.base, type: f.type, fetched: true,
            q: latest.quarter, holdings: latest.rows,
            pq: prev ? prev.quarter : '', prevHoldings: prev ? prev.rows : [],
            // ck：该条数据是冲着哪个报告期抓的（本季完成判定的唯一依据）
            ck: targetKey >= 0 ? targetKey : _qKey(latest.quarter),
            checkedAt: Date.now(),
          };
          state.ok++;
          enqueue(latest.rows);
          // 报告期标签以页面实际返回为准，取**最大值**（避免被后面的旧期覆盖）
          if (latest.quarter && _qKey(latest.quarter) > _qKey(state.period)) state.period = latest.quarter;
          if (latest.quarter && targetKey >= 0 && _qKey(latest.quarter) >= targetKey) state.updatedTo++;
        } else if (ok) {
          const old = H[f.code];
          if (old && old.q) {
            // 本次没取到，但历史上拿到过 → **保留旧数据**，只更新核对标记（绝不降级/清空）
            old.ck = targetKey >= 0 ? targetKey : old.ck;
            old.checkedAt = Date.now();
          } else {
            // 确认无持仓：记 q='' 并打上核对标记，避免每轮重复重试（历史踩坑）
            H[f.code] = {
              name: f.name, base: f.base, type: f.type, fetched: true,
              q: '', holdings: [], pq: '', prevHoldings: [],
              ck: targetKey >= 0 ? targetKey : -1, checkedAt: Date.now(),
            };
          }
          state.failedCodes.push(f.code);
        } else {
          state.failed++; state.failedCodes.push(f.code);
        }
        state.done++;
        runCount++;
        // 双条件落盘：每 250 只，或距上次落盘超过 60 秒。
        // 后者用于兜底——限流导致速率降到 ~1 只/秒时，只靠 250 只触发会变成 4 分钟才存一次。
        if (++saved % SAVE_EVERY === 0 || Date.now() - lastSaveAt > SAVE_MS) {
          _saveJson(F_HOLDINGS, H); _persistProgress(); lastSaveAt = Date.now();
        }
        // 速率/ETA 必须用「本轮实际处理量」，用累计 done 会把续跑前的存量算进来（曾显示 374 只/秒）
        const el = (Date.now() - t0) / 1000;
        state.rate = runCount / Math.max(el, 1);
        const remain = (state.total - state.done) + Math.max(0, state.indTotal - state.indDone);
        state.etaSec = state.rate > 0 ? Math.round(remain / state.rate) : null;
        await sleep(GAP_MS);
      }
    });
    await Promise.all(workers);
    holdingsFinished = true;
    _saveJson(F_HOLDINGS, H);
    _persistProgress();
    // 无论本轮是否暂停/分批，都要把已入队的「个股→行业」解析完（否则未分类会残留）
    state.phase = 'industry';
    await Promise.all(indWorkers);
    _saveJson(F_IND, _indStore());
    state.indUnresolved = Math.max(0, state.indTotal - state.indDone);

    // 真实覆盖数（不能用 total 顶替，否则「已完成」会虚报）
    state.total = list.length;
    let covered = 0, withPrev = 0;
    for (const f of list) {
      const e = H[f.code];
      if (!e) continue;
      covered++;
      if (e.prevHoldings && e.prevHoldings.length) withPrev++;
    }
    state.done = covered;
    state.withPrev = withPrev;
    if (targetKey >= 0) {
      const k = _countQuarter(list, H, targetKey);
      state.updatedTo = k.updatedTo;
      state.remaining = k.remaining;
      state.lagged = k.lagged;
      state.graceOver = k.graceOver;
    }
    if (_stop) {
      state.phase = state.budgetPaused ? 'batch' : 'stopped';   // batch = 因单日预算暂停，次日继续
    } else {
      state.phase = 'done'; state.finishedAt = Date.now();
    }
    _persistProgress();
  } catch (e) {
    state.lastError = e.message;
    state.phase = 'error';
    console.error('[FundMatrix] 采集失败:', e.message);
  } finally {
    state.running = false;
    if (!state.startedAt) state.startedAt = t0;
    _persistProgress();
  }
  return getCrawlStatus();
}

function getCrawlStatus() {
  return {
    running: state.running, phase: state.phase, period: state.period, prevPeriod: state.prevPeriod,
    total: state.total, done: state.done, ok: state.ok, failed: state.failed, withPrev: state.withPrev,
    remaining: state.remaining, updatedTo: state.updatedTo, budgetPaused: state.budgetPaused,
    industry: { total: state.indTotal, done: state.indDone, unresolved: state.indUnresolved },
    rate: Math.round(state.rate * 10) / 10, etaSec: state.etaSec,
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    updatedAt: Date.now(), lastError: state.lastError,
  };
}

/**
 * 每日一次的自然季度检查 + 分批推进（**本模块的季度更新主入口**）。
 * 流程：
 *   1) 结算「当前自然季度 → 目标报告期」；跨季度则重置账本
 *   2) 账本已完成 → 跳过（0 请求）
 *   3) 今天已跑过 → 跳过（保证「每日一次」）
 *   4) 探测东财实际最新报告期：目标期尚未开始发布 → 今天只花几次探测请求就结束，明天再看
 *   5) 已开始发布 → 跑**一批**（受 DAILY_BATCH / DAILY_BUDGET_MS 约束），跑完更新账本；
 *      未全部完成则次日继续，直到 remaining=0 → 本季度完成
 * @returns {Promise<{ran:boolean, reason:string}>} 立即返回；批采集在后台继续
 */
async function runDailyUpdate(opts = {}) {
  _loadProgress();
  const force = !!opts.force;
  const t = naturalQuarterTarget();
  const today = _dateStr();
  let L = _lg();

  // 跨入新自然季度 → 重置账本（holdings 保留，新报告期靠重采逐只覆盖）
  if (!force && (!L || L.target !== t.period)) {
    L = _newLedger(t);
    console.log(`[FundMatrix] 进入自然季度 ${t.naturalQuarter} → 本季目标报告期 ${t.label}`);
  }
  L = _lg();

  const view = () => ({ quarter: getQuarterStatus(), status: getCrawlStatus() });

  if (L.done && !force) return { ran: false, reason: 'quarter-done', target: t.label, ...view() };
  if (state.running && !force) return { ran: false, reason: 'already-running', target: t.label, ...view() };
  if (L.lastRunDate === today && !force) return { ran: false, reason: 'already-ran-today', target: t.label, ...view() };
  // 每日执行时刻：定时器早于 DAILY_HOUR 不跑；启动补偿(ignoreHour)例外
  if (!force && !opts.ignoreHour && new Date().getHours() < DAILY_HOUR) {
    return { ran: false, reason: 'before-daily-hour', target: t.label, ...view() };
  }

  // 探测东财实际最新报告期（通常 1 次请求即返回）
  let latest = '';
  try { latest = await detectLatestPeriod(L.target); } catch (e) { /* 探测失败按未发布处理 */ }
  L.lastProbeDate = today; L.lastProbePeriod = latest || '';
  L.published = !!latest && _qKey(latest) >= L.targetKey;
  _saveLedger();

  if (!L.published) {
    L.lastRunDate = today;                 // 记为「今天已检查过」，避免一天内反复探测
    _saveLedger();
    console.log(`[FundMatrix] ${t.label} 报告尚未发布（东财最新 ${_qLabel(latest) || '未知'}），今日跳过`);
    return { ran: false, reason: 'not-published', target: t.label, detected: latest, detectedLabel: _qLabel(latest), ...view() };
  }

  L.batchRuns = (L.batchRuns || 0) + 1;
  if (!L.startedAt) L.startedAt = Date.now();
  _saveLedger();
  console.log(`[FundMatrix] ${t.label} 已开始发布 → 执行本日批次（上限 ${opts.batchSize || DAILY_BATCH} 只 / ${Math.round((opts.budgetMs || DAILY_BUDGET_MS) / 60000)} 分钟）`);

  const batchSize = Math.max(1, parseInt(opts.batchSize || DAILY_BATCH, 10) || DAILY_BATCH);
  const budgetMs = Math.max(1000, parseInt(opts.budgetMs || DAILY_BUDGET_MS, 10) || DAILY_BUDGET_MS);

  // 后台跑一批；跑完回落账本。调用方不等待（避免阻塞 HTTP 请求）
  const p = _runCrawl({ targetPeriod: L.target, limit: batchSize, budgetMs })
    .then(() => _finalizeLedger())
    .catch((e) => { console.error('[FundMatrix] 批次失败:', e.message); _finalizeLedger(); });
  if (opts.awaitBatch) await p;
  return { ran: true, target: t.label, batchSize, ...view() };
}

/** 一批跑完后回落账本：统计剩余 / 是否本季度完成 */
function _finalizeLedger() {
  const L = _lg();
  if (!L || !L.targetKey) return;
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const k = (uni && uni.list)
    ? _countQuarter(uni.list, H, L.targetKey)
    : { remaining: 0, updatedTo: 0, lagged: 0, daysIn: 0, grace: 0, graceOver: false };
  L.remaining = k.remaining;
  L.updatedTo = k.updatedTo;
  L.lagged = k.lagged;
  L.daysIn = k.daysIn;
  L.grace = k.grace;
  L.graceOver = k.graceOver;
  // 「今天已跑过」在**批次结束**时才记：这样中途重启/中断不会白等一天，会接着跑
  L.lastRunDate = _dateStr();
  if (k.remaining === 0) {
    L.done = true; L.finishedAt = Date.now();
    console.log(`[FundMatrix] ✅ 自然季度 ${L.label} 报告更新完成：已达标 ${k.updatedTo} 只`
      + (k.lagged ? `，滞后未披露 ${k.lagged} 只（已过 ${k.grace} 天宽限期）` : ''));
  } else {
    console.log(`[FundMatrix] ${L.label} 本次批次完成，剩余 ${k.remaining} 只待披露/待更新，次日继续`
      + (k.lagged ? `（另有滞后 ${k.lagged} 只）` : ''));
  }
  _saveLedger();
}

/** 冷启动采集完成后建立账本（把当前缓存状态落到当季账本） */
function _initLedgerAfterFirstCrawl() {
  const t = naturalQuarterTarget();
  const L = _newLedger(t);
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const k = (uni && uni.list)
    ? _countQuarter(uni.list, H, L.targetKey)
    : { remaining: 0, updatedTo: 0, lagged: 0, daysIn: 0, grace: 0, graceOver: false };
  L.updatedTo = k.updatedTo; L.remaining = k.remaining; L.lagged = k.lagged;
  L.daysIn = k.daysIn; L.grace = k.grace; L.graceOver = k.graceOver;
  L.published = k.updatedTo > 0;
  L.lastRunDate = _dateStr();
  L.startedAt = Date.now();
  if (k.remaining === 0) { L.done = true; L.finishedAt = Date.now(); }
  _saveLedger();
  console.log(`[FundMatrix] 采集完成 → 季度账本 ${L.label}：已达标 ${k.updatedTo}，待更新 ${k.remaining}，滞后 ${k.lagged}`
    + (L.done ? '（本季已完成）' : ''));
  return getQuarterStatus();
}

/**
 * 统一入口（供 server.js 调用）。
 *  - **冷启动**（尚无季度账本，或还有基金从未采集过）→ 全量/续跑把 1 万只拉齐，完成后建立当季账本
 *  - **已建仓** → 走 runDailyUpdate：每日一次检查 + 分批推进直到本季度完成
 */
async function startCrawl(opts = {}) {
  _loadProgress();
  if (state.running) return { started: false, reason: 'already-running', status: getCrawlStatus() };
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const cov = unpackCoverage(uni, H);

  if (opts.force) {
    const t = naturalQuarterTarget();
    _newLedger(t);
    _runCrawl({ force: true, targetPeriod: t.period })
      .then(() => { _finalizeLedger(); })
      .catch((e) => console.error('[FundMatrix] crawl fatal', e.message));
    return { started: true, reason: 'force-full', status: getCrawlStatus(), quarter: getQuarterStatus() };
  }

  // 冷启动/续跑：无账本，或仍有基金从未采集过 → 先把全量拉齐（此阶段不适用「每日分批」）
  const led = _lg();
  const hasLedger = !!(led && led.target);
  if (!hasLedger || cov.covered < cov.total) {
    // 带上当季目标期：既能补齐从未采集的缺口，也能把仍是旧报告期的条目一起更新
    const t = naturalQuarterTarget();
    _runCrawl({ targetPeriod: t.period }).then(() => _initLedgerAfterFirstCrawl())
      .catch((e) => console.error('[FundMatrix] crawl fatal', e.message));
    return {
      started: true, reason: hasLedger ? 'cold-resume' : 'first-crawl',
      unfinished: Math.max(0, cov.total - cov.covered),
      status: getCrawlStatus(), quarter: getQuarterStatus(),
    };
  }

  const r = await runDailyUpdate(opts);
  return { started: !!r.ran, ...r };
}

function stopCrawl() { _stop = true; return { stopped: true, status: getCrawlStatus() }; }

/**
 * 立即把所有内存缓存强制落盘。
 * 用途：进程退出/关机前调用，避免丢掉「已采集但还没到落盘条件」的最后一批进度。
 * 采集本来是可续跑的（重启后从 pending 接着跑），这里只是把断点位置推到最后一刻。
 */
function flushCache() {
  try {
    const funds = _holdings ? Object.keys(_holdings).length : 0;
    const inds = _indDisk ? Object.keys(_indDisk).length : 0;
    if (_holdings) _saveJson(F_HOLDINGS, _holdings);
    if (_indDisk) _saveJson(F_IND, _indDisk);
    if (_ledger) _saveJson(F_QUARTER, _ledger);
    _persistProgress();
    return { ok: true, funds, industry: inds };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function unpackCoverage(uni, H) {
  const total = uni && uni.list ? uni.list.length : 0;
  let covered = 0;
  if (uni && uni.list) for (const f of uni.list) if (H[f.code]) covered++;
  return { total, covered, remaining: Math.max(0, total - covered), shareClasses: uni ? uni.shareClasses : 0, allFunds: uni ? uni.total : 0 };
}

// ---------- 5) 聚合：行业 × 持仓市值 排名 ----------
/**
 * 环比口径（**严格可比**）：
 *   只纳入「同时拥有  展示期 + 紧邻上一期  两期数据」的**同一批基金**。
 *   否则 A 期用全体、B 期用子集，差额里会混入"样本变化"，不是真实的增减持。
 *   因此 fundsComparable 既是样本量，也是「本季度已更新进度」的最直接体现。
 */
function getFundIndustryRanking(opts = {}) {
  // ⚠️ 只在内存状态尚未初始化时读盘；否则每次 API 请求都会用磁盘旧值
  //    覆盖正在运行的实时状态（phase/done/remaining 会被打回上一次落盘值）。
  if (!state.period && !state.running) _loadProgress();
  const uni = _loadJson(F_UNIVERSE, null);
  const H = _h();
  const cov = unpackCoverage(uni, H);
  const qs = getQuarterStatus();

  // 展示期：优先「账本目标期（已开始发布）」，否则退回缓存中出现最多的报告期
  const tally = new Map();
  for (const code of Object.keys(H)) { const q = H[code] && H[code].q; if (q) tally.set(q, (tally.get(q) || 0) + 1); }
  const modeQ = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || '';
  const displayQ = (qs.published && qs.target) ? qs.target : modeQ;
  const prevQ = _prevQuarterOf(displayQ);

  const indMap = new Map();
  let holdings = 0, totalValue = 0, stocksSeen = 0;
  let prevTotalValue = 0, fundsComparable = 0;
  const stockSet = new Set();

  const _row = (name) => {
    if (!indMap.has(name)) indMap.set(name, { name, marketValue: 0, prevValue: 0, fundSet: new Set(), stocks: new Map() });
    return indMap.get(name);
  };

  for (const code of Object.keys(H)) {
    const f = H[code];
    if (!f || !f.q || f.q !== displayQ) continue;          // 未更新到展示期 → 不纳入（避免混口径）
    if (!prevQ || f.pq !== prevQ) continue;                // 缺紧邻上一期 → 无法严格可比，排除
    fundsComparable++;

    for (const h of f.holdings) {
      if (!h || !h.code) continue;
      stocksSeen++;
      stockSet.add(h.code);
      const ind = _indCacheGet(h.code) || '未分类';
      const v = Number.isFinite(h.value) ? h.value : 0;   // 持仓市值（万元）
      const row = _row(ind);
      row.marketValue += v;
      row.fundSet.add(code);
      if (!row.stocks.has(h.code)) row.stocks.set(h.code, { code: h.code, name: h.name, marketValue: 0, fundCount: 0 });
      const s = row.stocks.get(h.code);
      s.marketValue += v; s.fundCount += 1;
      holdings++; totalValue += v;
    }
    // 上一期沿用同一个个股→行业映射，且**基金集合完全相同** → 环比才可比
    for (const h of (f.prevHoldings || [])) {
      if (!h || !h.code) continue;
      const ind = _indCacheGet(h.code) || '未分类';
      const v = Number.isFinite(h.value) ? h.value : 0;
      _row(ind).prevValue += v;
      prevTotalValue += v;
    }
  }

  const industries = Array.from(indMap.values())
    .map((r) => {
      const changeWan = r.marketValue - r.prevValue;                      // 万元
      return {
        name: r.name,
        marketValue: Math.round(r.marketValue * 100) / 100,                    // 万元
        marketValueYi: Math.round(r.marketValue / 10000 * 100) / 100,          // 亿元
        prevMarketValue: Math.round(r.prevValue * 100) / 100,
        prevMarketValueYi: Math.round(r.prevValue / 10000 * 100) / 100,
        changeWan: Math.round(changeWan * 100) / 100,
        changeYi: Math.round(changeWan / 10000 * 100) / 100,
        // 环比变化率：基数为 0 或无基数时给 null（不硬造百分比）
        changePct: r.prevValue > 0 ? Math.round(changeWan / r.prevValue * 10000) / 100 : null,
        share: totalValue > 0 ? Math.round(r.marketValue / totalValue * 10000) / 100 : 0, // 占纳入基金重仓市值 %
        fundCount: r.fundSet.size,
        stockCount: r.stocks.size,
        topStocks: Array.from(r.stocks.values())
          .sort((a, b) => b.marketValue - a.marketValue)
          .slice(0, 8)
          .map((s) => ({ code: s.code, name: s.name, marketValue: Math.round(s.marketValue * 100) / 100, fundCount: s.fundCount })),
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const minFunds = opts.minFunds || 0;
  const filtered = minFunds ? industries.filter((i) => i.fundCount >= minFunds) : industries;

  // 行业解析进度（从磁盘缓存实算，重启后也准确）
  let indResolved = 0, indMiss = 0;
  for (const c of stockSet) {
    if (_indCacheGet(c)) indResolved++;
    else if (_indCacheResolved(c)) indMiss++;   // 已有结论=查不到（负缓存）
  }
  const indUnresolved = Math.max(0, stockSet.size - indResolved - indMiss);

  // 已更新到展示期的基金数（含缺上一期而无法纳入环比的）
  let fundsAtTarget = 0;
  for (const code of Object.keys(H)) { const f = H[code]; if (f && f.q === displayQ) fundsAtTarget++; }

  return {
    ok: true,
    mode: 'market',
    metric: '持仓市值（万元）加总',
    scopes: '权益类公募基金（股票/混合/指数/QDII），按母基金去重',
    period: displayQ,
    prevPeriod: prevQ,
    periodLabel: _qLabel(displayQ),
    prevPeriodLabel: _qLabel(prevQ),
    quarter: qs,
    coverage: {
      allFunds: cov.allFunds,          // 全市场基金总数
      shareClasses: cov.shareClasses,  // 权益类份额数
      universe: cov.total,             // 去重后母基金数（采集目标）
      covered: cov.covered,            // 已采集
      fundsAtTarget,                   // 已更新到展示期的基金数
      fundsComparable,                 // 两期齐全、可严格算环比的基金数（= 当前排名样本量）
      remaining: qs.remaining >= 0 ? qs.remaining : cov.remaining,
      stocks: stockSet.size,
      holdings,                        // 重仓股记录数
      totalMarketValueWan: Math.round(totalValue * 100) / 100,
      totalMarketValueYi: Math.round(totalValue / 10000 * 100) / 100,
      prevTotalMarketValueYi: Math.round(prevTotalValue / 10000 * 100) / 100,
      industryResolved: indResolved,
      industryMiss: indMiss,
      industryUnresolved: indUnresolved,
    },
    progress: getCrawlStatus(),
    industries: filtered,
    note: `数据源：东方财富公开接口（基金列表 + 各基金 ${_qLabel(displayQ) || '最新期'} 与 ${_qLabel(prevQ) || '上一期'} 前十大重仓股 + 个股行业）。`
        + `更新频率=**自然季度**：${qs.naturalQuarterLabel}对应目标报告期 ${qs.targetLabel}，`
        + '进入季度后每日检查一次东财披露情况，分批更新、直到全部母基金更新完毕（各基金披露日期不同，故分批推进）。'
        + '行业口径为东财归一行业名；只含前十大重仓股，非全部持仓。'
        + '按母基金去重（A/C 等份额不重复计，因东财对同一基金各份额报出的持仓市值相同）。'
        + '「环比变化」采用**严格可比口径**：最新期与上一期均取自同一批基金（当前 '
        + `${fundsComparable} 只），避免样本变化混入增减持结论；缺上一期数据的基金不计入（新发基金等）。`,
  };
}

module.exports = {
  getFundUniverse,
  getFundIndustryRanking,
  getCrawlStatus,
  getQuarterStatus,
  naturalQuarterTarget,
  runDailyUpdate,
  startCrawl,
  stopCrawl,
  flushCache,
  lookupIndustry,
  detectLatestPeriod,
  baseFundName,
  _parseHoldingsHtml,
  _prevQuarterOf,
  _qKey,
  _qLabel,
  _needsWork,
  _countQuarter,
  DAILY_HOUR,
  DAILY_BATCH,
  DAILY_BUDGET_MS,
};

~~~

---

## `lib\futuresData.js`  ·  212 行

~~~js
/**
 * Futures Correlation Module
 * 为产品型公司（如中国海油↔原油期货）提供期货指数与股价的关联分析。
 * 数据来源：新浪财经期货日线 (InnerFuturesNewService.getDailyKLine)
 * 股价来源：项目既有 getHistory（腾讯日线）
 */
const axios = require('axios');
const { getHistory, detectMarket } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 股票代码(6位) -> 关联期货
// symbol: 新浪期货连续合约代码; name: 中文名; note: 关联逻辑说明
const FUTURES_MAP = {
  // —— 原油/能源 ——
  '600938': { symbol: 'sc0', name: '原油(上海)', note: '中国海油主要从事上游油气勘探开发，原油价格是决定其销售收入与利润的核心变量。' },
  '601857': { symbol: 'sc0', name: '原油(上海)', note: '中国石油业务涵盖勘探开采与炼化，原油价格直接影响上游板块盈利。' },
  '600028': { symbol: 'sc0', name: '原油(上海)', note: '中国石化以炼化为主，油价通过炼油价差与库存收益间接影响业绩。' },
  '601808': { symbol: 'sc0', name: '原油(上海)', note: '中海油服为海上油田服务商，油价高低决定油公司资本开支意愿，进而影响其工作量。' },
  '600583': { symbol: 'sc0', name: '原油(上海)', note: '海油工程从事海上油气工程，与中海油资本开支及油价高度相关。' },
  '600256': { symbol: 'sc0', name: '原油(上海)', note: '广汇能源涉及LNG与煤化工，能源价格影响其产品盈利。' },
  '002493': { symbol: 'sc0', name: '原油(上海)', note: '荣盛石化主营炼化，原油成本与化工品价差决定其利润。' },
  '600346': { symbol: 'sc0', name: '原油(上海)', note: '恒力石化以炼化一体化为主，油价通过原料成本与库存收益影响盈利。' },
  // —— 铜 ——
  '601899': { symbol: 'cu0', name: '铜(沪铜)', note: '紫金矿业铜产量占比高，铜价是核心利润驱动。' },
  '600362': { symbol: 'cu0', name: '铜(沪铜)', note: '江西铜业为铜冶炼加工龙头，铜价影响加工费与库存收益。' },
  '000630': { symbol: 'cu0', name: '铜(沪铜)', note: '铜陵有色主营阴极铜，铜价直接决定产品收入。' },
  '000878': { symbol: 'cu0', name: '铜(沪铜)', note: '云南铜业为铜冶炼企业，铜价影响其营收与利润。' },
  '601168': { symbol: 'cu0', name: '铜(沪铜)', note: '西部矿业拥有铜铅锌矿，铜价贡献主要利润。' },
  '600362': { symbol: 'cu0', name: '铜(沪铜)', note: '江西铜业。' },
  // —— 黄金/白银 ——
  '600547': { symbol: 'au0', name: '黄金(沪金)', note: '山东黄金为纯黄金开采企业，金价直接决定其利润。' },
  '600489': { symbol: 'au0', name: '黄金(沪金)', note: '中金黄金黄金储量丰富，金价为核心驱动。' },
  '600988': { symbol: 'au0', name: '黄金(沪金)', note: '赤峰黄金以黄金开采为主，金价高度相关。' },
  '000975': { symbol: 'au0', name: '黄金(沪金)', note: '银泰黄金金矿资源为主，金价驱动盈利。' },
  '002155': { symbol: 'au0', name: '黄金(沪金)', note: '湖南黄金金锑并举，金价为主驱动。' },
  '601899b': { symbol: 'au0', name: '黄金(沪金)', note: '紫金矿业黄金产量同样可观，金价影响显著。' },
  // —— 螺纹钢/钢铁 ——
  '600019': { symbol: 'rb0', name: '螺纹钢', note: '宝钢股份为钢铁龙头，钢价与原料成本决定利润。' },
  '000898': { symbol: 'rb0', name: '螺纹钢', note: '鞍钢股份主营板材与长材，钢价为核心变量。' },
  '000932': { symbol: 'rb0', name: '螺纹钢', note: '华菱钢铁，钢价与需求影响其盈利。' },
  '000959': { symbol: 'rb0', name: '螺纹钢', note: '首钢股份，钢价驱动业绩。' },
  '000709': { symbol: 'rb0', name: '螺纹钢', note: '河钢股份，钢价为核心变量。' },
  // —— 铝 ——
  '601600': { symbol: 'al0', name: '铝(沪铝)', note: '中国铝业为氧化铝/电解铝龙头，铝价决定利润。' },
  '000807': { symbol: 'al0', name: '铝(沪铝)', note: '云铝股份水电铝企业，铝价为核心驱动。' },
  '600219': { symbol: 'al0', name: '铝(沪铝)', note: '南山铝业铝加工一体化，铝价影响盈利。' },
  // —— 锌/铅 ——
  '000060': { symbol: 'zn0', name: '锌(沪锌)', note: '中金岭南铅锌矿企，锌价为核心驱动。' },
  '600497': { symbol: 'zn0', name: '锌(沪锌)', note: '驰宏锌锗铅锌龙头，锌价决定利润。' },
  // —— 煤炭 ——
  '601088': { symbol: 'jm0', name: '焦煤', note: '中国神华以动力煤为主，焦煤价格是其煤价体系的重要参照。' },
  '601898': { symbol: 'jm0', name: '焦煤', note: '中煤能源煤炭巨头，煤价决定其盈利。' },
  '600188': { symbol: 'jm0', name: '焦煤', note: '兖矿能源，煤价为核心变量。' },
  '601225': { symbol: 'jm0', name: '焦煤', note: '陕西煤业，煤价驱动业绩。' },
  // —— 化工 ——
  '601233': { symbol: 'ta0', name: 'PTA', note: '桐昆股份聚酯龙头，PTA与原油价差决定利润。' },
  '600426': { symbol: 'ma0', name: '甲醇', note: '华鲁恒升煤化工，甲醇等化工品价格影响盈利。' },
  // —— 橡胶 ——
  '601118': { symbol: 'ru0', name: '橡胶(沪胶)', note: '海南橡胶天然橡胶种植加工，胶价为唯一核心变量。' },
  // —— 糖 ——
  '600737': { symbol: 'sr0', name: '白糖', note: '中粮糖业食糖产业龙头，糖价决定利润。' },
  '000911': { symbol: 'sr0', name: '白糖', note: '南宁糖业制糖企业，糖价核心驱动。' },
  // —— 农产品 ——
  '600598': { symbol: 'a0', name: '豆一', note: '北大荒土地发包与农产品，粮价影响其收益。' },
  // HK 代码
  '00883': { symbol: 'sc0', name: '原油(上海)', note: '中国海洋石油(港股)，原油价格为核心驱动。' },
  '00857': { symbol: 'sc0', name: '原油(上海)', note: '中国石油股份(港股)，油价影响上游盈利。' },
  '00386': { symbol: 'sc0', name: '原油(上海)', note: '中国石油化工(港股)，炼化价差受油价影响。' },
};

// 备用别名（避免重复键）
FUTURES_MAP['601899_au'] = { symbol: 'au0', name: '黄金(沪金)', note: '紫金矿业黄金产量同样可观，金价影响显著。' };

function getFuturesMeta(symbol) {
  const info = detectMarket(symbol);
  const code = info.tencentCode.replace(/^(sh|sz|hk)/, '');
  return FUTURES_MAP[code] || null;
}

// 抓取新浪期货日线
async function fetchSinaFutures(symbol) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getDailyKLine?symbol=' + symbol;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, timeout: 15000 });
    const arr = Array.isArray(r.data) ? r.data : [];
    return arr
      .map(k => ({ date: k.d, close: parseFloat(k.c) }))
      .filter(x => x.close > 0 && x.date);
  } catch (e) {
    console.error('[Futures] Sina fetch failed for', symbol, e.message);
    return [];
  }
}

// 皮尔逊相关系数
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * 计算股票与关联期货的走势关联。
 * 返回 { hasFutures, futuresName, note, correlation, dates, stockNorm, futuresNorm, stockClose, futuresClose, conclusion, reasoning }
 */
async function fetchFuturesCorrelation(symbol, name) {
  const meta = getFuturesMeta(symbol);
  if (!meta) return { hasFutures: false };

  const [stockHist, futHist] = await Promise.all([
    getHistory(symbol, 'daily').catch(() => []),
    fetchSinaFutures(meta.symbol),
  ]);

  if (stockHist.length < 30 || futHist.length < 30) {
    return { hasFutures: true, futuresName: meta.name, note: meta.note, correlation: null,
      conclusion: '股价或期货历史数据不足，暂无法进行关联分析。', reasoning: ['样本不足（需至少30个交易日）。'] };
  }

  // 建日期索引
  const futByDate = {};
  for (const f of futHist) futByDate[f.date] = f.close;

  const dates = [];
  const stockClose = [];
  const futuresClose = [];
  for (const d of stockHist) {
    const fc = futByDate[d.date];
    if (fc && d.close > 0) {
      dates.push(d.date);
      stockClose.push(d.close);
      futuresClose.push(fc);
    }
  }

  if (dates.length < 30) {
    return { hasFutures: true, futuresName: meta.name, note: meta.note, correlation: null,
      conclusion: '股价与期货的可比交易日不足，暂无法进行关联分析。', reasoning: ['对齐后的共同交易日少于30天。'] };
  }

  // 归一化（基准日=100）
  const sBase = stockClose[0], fBase = futuresClose[0];
  const stockNorm = stockClose.map(v => Math.round(v / sBase * 1000) / 10);
  const futuresNorm = futuresClose.map(v => Math.round(v / fBase * 1000) / 10);

  const corr = Math.round(pearson(stockNorm, futuresNorm) * 1000) / 1000;

  // 区间涨跌幅
  const stockChg = Math.round((stockClose[stockClose.length - 1] / sBase - 1) * 1000) / 10;
  const futChg = Math.round((futuresClose[futuresClose.length - 1] / fBase - 1) * 1000) / 10;

  // 结论与推导
  let level, conclusion;
  const absC = Math.abs(corr);
  if (absC >= 0.6) level = '高度';
  else if (absC >= 0.35) level = '中度';
  else if (absC >= 0.15) level = '弱';
  else level = '基本无';

  const dir = corr >= 0 ? '正' : '负';
  conclusion = `股价与${meta.name}期货走势呈现${level}${dir}相关（相关系数 ${corr.toFixed(2)}）。` +
    `统计区间内，股价${stockChg >= 0 ? '上涨' : '下跌'}${Math.abs(stockChg)}%，${meta.name}期货${futChg >= 0 ? '上涨' : '下跌'}${Math.abs(futChg)}%。` +
    (absC >= 0.6
      ? `两者联动紧密，研判${meta.name}后市对判断该公司股价方向具有重要参考意义。`
      : absC >= 0.35
      ? `两者存在一定联动，可结合${meta.name}走势辅助判断，但需关注公司自身基本面与事件因素。`
      : `两者联动较弱，公司股价更多受自身经营、估值或市场风格驱动，期货走势仅作弱参考。`);

  const reasoning = [
    `关联期货：${meta.name}（新浪代码 ${meta.symbol}）。${meta.note}`,
    `样本区间：共同交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）。`,
    `归一化方法：以区间首日收盘价为基准 100，分别标准化股价与期货价格后计算皮尔逊相关系数。`,
    `股价区间涨跌幅：${stockChg}%；${meta.name}期货区间涨跌幅：${futChg}%。`,
    `相关系数 ${corr.toFixed(2)} → 判定为「${level}${dir}相关」。`,
    absC >= 0.6 ? '相关系数≥0.6，属于强联动，期货方向对股价有较强指示性。'
      : absC >= 0.35 ? '相关系数 0.35~0.6，属于中等联动。'
      : absC >= 0.15 ? '相关系数 0.15~0.35，联动偏弱。'
      : '相关系数<0.15，几乎独立。',
  ];

  return {
    hasFutures: true,
    futuresName: meta.name,
    futuresSymbol: meta.symbol,
    note: meta.note,
    correlation: corr,
    level,
    direction: dir,
    dates,
    stockNorm,
    futuresNorm,
    stockClose,
    futuresClose,
    stockChg,
    futuresChg: futChg,
    conclusion,
    reasoning,
  };
}

module.exports = { fetchFuturesCorrelation, getFuturesMeta, FUTURES_MAP };

~~~

---

## `lib\growthCaliber.js`  ·  78 行

~~~js
/**
 * lib/growthCaliber.js — 增长类指标口径设置（20261104b，用户指令：单季/累计一键切换）
 *
 * 背景：20261102a 起「单季优先」（DJD_*_YOY 优先，缺失回退累计 *_TZ）；用户 20261104 决策：
 * 增长指标（营收/利润/扣非）口径应可一键切换（单季 ↔ 累计），切换后对应指标分析
 * （左卡关键财务指标 / 右卡指标分析 / 顶栏 tiles / 信号判定 / 历史百分位）同步切换。
 *
 * 设计：
 *  - 持久化 data/settings.json { growthCaliber: 'sq' | 'cum' }，默认 'sq'（沿用 20261102a 行为）。
 *  - 口径只影响「同比主值」取数字段的**优先级顺序**：sq = 单季 DJD 优先回退累计；cum = 累计 TZ 优先回退单季
 *    （组内逐字段回退的既有稳健机制不变，仅重排优先级——orderedYoYFields）。
 *  - 口径不影响的模块（保持单季优先，各有独立口径语义）：sameDayJudgment 短期行情判断因子、
 *    deep 深度分析年度结论序列、stockData 原始快照字段（revenueYoy/profitYoy 仍 DJD 优先落库）。
 *  - 环比维度（单季绝对额环比·本机计算）与本设置无关，始终如实标注口径。
 *  - 测试重定向：环境变量 SA_SETTINGS_FILE 指定设置文件路径（同 SA_NOTES_FILE 模式）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'settings.json');
const settingsFile = () => process.env.SA_SETTINGS_FILE || DEFAULT_FILE;

// mtime 检测缓存：外部改文件即时生效，不重复读盘
let cache = { mtimeMs: 0, val: null };

function readSettings() {
  try {
    const st = fs.statSync(settingsFile());
    if (!cache.val || cache.mtimeMs !== st.mtimeMs) {
      cache = { mtimeMs: st.mtimeMs, val: JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {} };
    }
    return cache.val;
  } catch (e) {
    return {};
  }
}

/** 当前增长口径：'sq'（单季优先，默认）| 'cum'（累计优先） */
function getGrowthCaliber() {
  const v = readSettings().growthCaliber;
  return v === 'cum' ? 'cum' : 'sq';
}

/** 口径中文标签 */
function growthCaliberLabel(c) {
  return (c || getGrowthCaliber()) === 'cum' ? '累计口径' : '单季优先口径';
}

/** 设置口径并持久化（原子写：tmp + rename）；非法值抛错 */
function setGrowthCaliber(c) {
  if (c !== 'sq' && c !== 'cum') throw new Error('growthCaliber 必须是 sq（单季优先）或 cum（累计优先）');
  const file = settingsFile();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { s = {}; } // 文件不存在/损坏 → 从空设置开始（默认口径 sq）
  s.growthCaliber = c;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache = { mtimeMs: 0, val: null };
  return getGrowthCaliber();
}

/**
 * 增长类同比取数字段组：按当前口径重排优先级。
 * @param {string[]} pair 固定 [单季字段, 累计字段]（如 ['DJD_TOI_YOY', 'TOTALOPERATEREVETZ']）
 * @param {'sq'|'cum'} caliber 可选，缺省读当前设置
 * @returns {string[]} sq → 原序（单季优先回退累计）；cum → 反序（累计优先回退单季）
 */
function orderedYoYFields(pair, caliber) {
  const cal = caliber || getGrowthCaliber();
  if (!Array.isArray(pair) || pair.length !== 2) return pair;
  return cal === 'cum' ? [pair[1], pair[0]] : [pair[0], pair[1]];
}

module.exports = { getGrowthCaliber, setGrowthCaliber, growthCaliberLabel, orderedYoYFields };

~~~

---

## `lib\hotTopics.js`  ·  739 行

~~~js
/**
 * 个股近期热点（后端模块，20260827c 重构）
 * --------------------------------------------------------------
 * 模块只做一件事：AI 联网分析该股当前最值得关注的热点。
 * 两种模式（20261013g：按当日涨跌幅 或 振幅自动切换）：
 *   1) 涨跌幅绝对值 ≥ 3% 或 当日振幅 > 3% → 「当日异动归因」：AI 联网分析今日涨跌/宽幅震荡的最直接原因
 *      （用户 20261013 要求：个股当日震荡幅度超过 3%，联网搜索分析原因——收盘平盘但盘中深 V/冲高回落也算异动）
 *   2) 未触发上述阈值      → 「网络热议话题」：AI 联网分析该股近期网络上讨论最多的话题/关键词
 * 所有结果按交易日缓存，避免盘中/每次打开反复调用 AI。
 *
 * 数据源：lib/cnscraperAdapter（全网舆情 + 交易所公告）+ lib/sentiment（同花顺股吧讨论帖 +
 *         东财/同花顺/雪球讨论热度 + 个股新闻情感，与「舆情与讨论热度（个股）」因子同一数据源）
 *         + lib/aiAugment.callLLM（联网搜索）。
 * 20260913f 增强（用户反馈「热点说无热议话题、舆情却抓到焦点帖」两卡口径不一致）：
 *   ① 新增抓取渠道：同花顺股吧讨论帖、东财/同花顺/雪球讨论热度、个股新闻情感——直接复用
 *      lib/sentiment（即「舆情与讨论热度（个股）」因子的同一数据源），从源头消除两卡不一致；
 *   ② 增加「确定性讨论摘要」discussionDigest：不依赖 LLM，只要有讨论帖/热度就必展示，
 *      杜绝「明明有焦点帖却显示无热议话题」；
 *   ③ LLM 综述若在已有讨论证据的情况下仍答「未抓取到」，强制以确定性摘要覆盖；
 *   ④ 缓存加 CACHE_VER 版本门控，旧空结果不再被复用。
 * 所有外部调用均 best-effort 失败降级，绝不抛异常拖垮个股页。
 * AI 调用需要用户在「⚙️ AI 设置」中配置 API Key；无 Key 时仅展示提示。
 */
const fs = require('fs');
const path = require('path');
const cns = require('./cnscraperAdapter');
const marketSentiment = require('./sentiment');
const ai = require('./aiAugment');
const { getQuote } = require('./stockData');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const PRICE_CHANGE_THRESHOLD = 3; // 涨跌幅绝对值阈值 %
const AMPLITUDE_THRESHOLD = 3;    // 20261013g：当日振幅阈值 %（用户要求：震荡幅度超过 3% 联网分析原因）
// 缓存版本门控：结果结构/口径变化时 +1，旧缓存自动作废重算（避免升级后仍看到旧空结果）
const CACHE_VER = '20261013g'; // [20261013g] 模式切换新增振幅触发（>3%），缓存结构加 triggeredBy/amplitude 字段，旧缓存作废重算
                               // [20260923h] 新增「投资者问答」子卡（沪:上证e互动 / 深:巨潮互动易，scripts/sentiment.py）。改子卡展示内容必升版强制重算
                               // [20260923g] 同花顺热榜增补「排名变化 + 概念标签」

// 20261013g：确定性触发判定（代码权威，LLM 不参与触发判断）
// 振幅口径：腾讯行情 fields[43] =（最高-最低）/昨收 ×100%；字段缺失时用 high/low/prevClose 确定性补算。
function resolveTrigger(quote) {
  if (!quote || quote.changePct == null) return null;
  const changePct = quote.changePct;
  let amplitude = (quote.amplitude != null && quote.amplitude > 0) ? quote.amplitude : null;
  if (amplitude == null && quote.high != null && quote.low != null && quote.prevClose) {
    amplitude = Math.round((quote.high - quote.low) / quote.prevClose * 10000) / 100;
  }
  if (Math.abs(changePct) >= PRICE_CHANGE_THRESHOLD) {
    return { triggeredBy: 'priceChange', changePct, amplitude };
  }
  if (amplitude != null && amplitude > AMPLITUDE_THRESHOLD) {
    return { triggeredBy: 'amplitude', changePct, amplitude };
  }
  return null;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT = path.join(DATA_DIR, 'hot-topics');

function ensureDirs() {
  try { if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true }); } catch (e) { /* 忽略 */ }
}

function symDir(symbol) {
  return path.join(ROOT, String(symbol || '').trim());
}

function readJSON(symbol, file, fallback) {
  try {
    const fp = path.join(symDir(symbol), file);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(symbol, file, obj) {
  ensureDirs();
  const d = symDir(symbol);
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  fs.writeFileSync(path.join(d, file), JSON.stringify(obj, null, 2), 'utf8');
}

function aiExtractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

// 给外部（行情/LLM）调用加超时兜底，避免请求路径被挂死（项目红线：请求内不可阻塞）
function pTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'call') + ' 超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function normalizeKeyword(kw) {
  return String(kw || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 40);
}

// 从已抓取证据（全网舆情/交易所公告/财报解读）提取原始条目作为 LLM 失败/超时时的降级展示
function buildFallbackTopics(evidence) {
  const out = [];
  const seen = new Set();
  for (const e of (evidence || [])) {
    const items = e.items || e.articles || [];
    if (!Array.isArray(items) || !items.length) continue;
    for (const it of items) {
      const kw = String(it.title || it.headline || it.keyword || (it.content || '').slice(0, 30) || '').trim();
      if (!kw) continue;
      const dedup = kw.slice(0, 24);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({
        keyword: kw.slice(0, 40),
        desc: String(it.summary || it.desc || it.content || it.abstract || '').trim().slice(0, 120),
        heat: ['高', '中', '低'].includes(it.heat) ? it.heat : '中',
        sentiment: ['利好', '利空', '中性', '未知'].includes(it.sentiment || it.orientation) ? (it.sentiment || it.orientation) : '未知',
        sources: [e.source],
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- 讨论帖/热度渠道（20260913f）----
// 复用「舆情与讨论热度（个股）」因子的同一数据源（lib/sentiment → scripts/sentiment.py），
// 保证个股近期热点与舆情卡片看到的是同一批帖子和同一套热度口径，从源头杜绝两卡结论打架。
async function collectDiscussion(symbol, name) {
  const out = { ok: false, posts: [], heat: null, news: null, irm: null };
  try {
    const s = await pTimeout(marketSentiment.getMarketSentiment(symbol, name), 65000, 'sentiment');
    if (!s) return out;
    const rawPosts = (s.stockDiscussion && Array.isArray(s.stockDiscussion.posts)) ? s.stockDiscussion.posts : [];
    if (rawPosts.length) {
      out.posts = rawPosts.map(p => {
        const ctime = Number(p.ctime) || 0;
        const eng = (Number(p.reply) || 0) + (Number(p.like) || 0) + (Number(p.share) || 0) + (Number(p.forward) || 0);
        return {
          content: String((p && (p.content || p.title)) || '').replace(/\s+/g, ' ').trim(),
          date: ctime > 0 ? localDateFromTs(ctime) : '',
          eng,
          isV: !!(p && p.isV),
        };
      }).filter(p => p.content);
    }
    if (s.discussionHeat && s.discussionHeat.ok) out.heat = s.discussionHeat;
    if (s.newsSentiment && s.newsSentiment.ok) out.news = s.newsSentiment;
    // 20260923h：投资者问答（沪市上证e互动 / 深市巨潮互动易）——即便无讨论帖也会带回官方问答，
    // 故单独持有，不参与 out.ok 判定（out.ok 仍表示「有股吧讨论/热度」）。
    // 有问答 → 展示；取数失败 → 保留失败原因如实标注（诚实降级）；
    // 仅「该市场本无此数据源」(unsupported_market，如北交所) 不展示，避免每只北交所股票都挂一个无用的空子卡。
    if (s.irmQa && (s.irmQa.posts || []).length) {
      out.irm = s.irmQa;
    } else if (s.irmQa && s.irmQa.ok === false && s.irmQa.error && s.irmQa.error !== 'unsupported_market') {
      out.irm = s.irmQa;
    }
    out.ok = !!(out.posts.length || out.heat);
  } catch (e) {
    // 本机 Python/网络受限时静默降级，不影响 LLM 联网检索主路径
  }
  return out;
}

// 讨论帖 → 证据条目（title 用帖子正文，供 LLM 归纳 & 降级展示）
function postsToEvidenceItems(posts) {
  return posts.slice()
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 12)
    .map(p => ({ title: p.content.slice(0, 140), date: p.date, sentiment: '未知', heat: p.eng >= 5 ? '高' : p.eng >= 1 ? '中' : '低' }));
}

// 确定性讨论摘要（不依赖 LLM）：只要有讨论帖或多平台热度就必定展示，
// 避免「明明抓到 14 帖焦点帖、卡片却写无热议话题」。
function buildDiscussionDigest(disc) {
  if (!disc || !disc.ok) return '';
  const parts = [];
  const heat = disc.heat;
  if (heat) {
    const em = heat.eastmoney || {};
    const th = heat.tonghuashun || {};
    const xq = heat.xueqiu || {};
    const seg = [];
    if (em.symbolScore != null) seg.push(`东财股吧热度 ${em.symbolScore}${em.symbolRise != null ? (em.symbolRise > 0 ? '↑' : '↓') : ''}`);
    if (th.inHotList) {
      const chg = Number(th.rankChg) || 0;
      const chgTxt = chg > 0 ? `（较昨日↑${chg}）` : (chg < 0 ? `（较昨日↓${-chg}）` : '');
      const pop = th.popTag ? `·${th.popTag}` : '';
      seg.push(`同花顺热榜第 ${th.rank} 名${chgTxt}${pop}`);
    } else if (th.ok) seg.push('同花顺未入热榜');
    if (xq.inTop) seg.push(`雪球关注榜第 ${xq.rank} 名（${xq.follow} 人关注）`);
    else if (xq.ok) seg.push('雪球未入关注榜');
    if (seg.length) parts.push(`多平台讨论热度：${seg.join(' / ')}`);
    if (th.inHotList && Array.isArray(th.concepts) && th.concepts.length) {
      parts.push(`同花顺概念标签：${th.concepts.slice(0, 4).join(' / ')}`);
    }
  }
  if (disc.posts.length) {
    parts.push(`近端股吧讨论帖 ${disc.posts.length} 条`);
    const top = disc.posts.slice().sort((a, b) => b.eng - a.eng)[0];
    if (top) parts.push(`最热帖${top.date ? '（' + top.date + '）' : ''}：${top.content.slice(0, 60)}`);
  }
  return parts.join('；');
}

// ---- 投资者问答（20260923h）----
// 沪市→上证e互动（交易所官方平台）/ 深市→巨潮互动易。问答由 Python 侧采集（scripts/sentiment.py
// fetch_irm_qa，含 uid 落盘缓存），此处只做归一化 + 截断，保证前端渲染稳定、缓存体积可控。
const IRM_QA_MAX_POSTS = 6;
const IRM_Q_MAX = 120;
const IRM_A_MAX = 200;

function buildIrmQaBlock(irm) {
  if (!irm || !irm.ok || !Array.isArray(irm.posts) || !irm.posts.length) {
    // 保留失败原因（便于前端如实标注「未获取到」，而不是静默不显示）
    if (irm && (irm.note || irm.error)) {
      return { ok: false, source: irm.source || '', note: String(irm.note || irm.error).slice(0, 120), posts: [] };
    }
    return null;
  }
  const posts = irm.posts.slice(0, IRM_QA_MAX_POSTS).map(p => ({
    question: String(p.question || '').replace(/\s+/g, ' ').trim().slice(0, IRM_Q_MAX),
    answer: String(p.answer || '').replace(/\s+/g, ' ').trim().slice(0, IRM_A_MAX),
    askTime: String(p.askTime || '').trim(),
    answered: !!p.answered || !!p.replied,
  })).filter(p => p.question);
  if (!posts.length) return null;
  return {
    ok: true,
    source: irm.source || '',
    count: Number(irm.count) || posts.length,
    answered: Number(irm.answered) || posts.filter(p => p.answered).length,
    note: String(irm.note || '').slice(0, 140),
    unansweredList: !!irm.posts[0].unansweredList,
    posts,
  };
}

// 投资者问答 → 证据条目（问题+公司回复是最硬的一手信息，供 LLM 归纳与降级展示）
function irmToEvidenceItems(irm) {
  if (!irm || !Array.isArray(irm.posts) || !irm.posts.length) return [];
  return irm.posts.slice(0, IRM_QA_MAX_POSTS).map(p => ({
    title: `Q：${String(p.question || '').slice(0, 90)}${p.answer ? ' ／ A：' + String(p.answer).slice(0, 90) : '（公司未回复）'}`,
    date: String(p.askTime || ''),
    sentiment: '未知',
    heat: '中',
  }));
}

// LLM 综述「否认有内容」的典型措辞；在已抓到讨论证据时用于纠正
const NO_CONTENT_RE = /未抓取到|未获取到|无法抓取|无热议|没有热议|缺乏热点|缺乏实质性话题|热度处于低位|未发现相关讨论|无相关讨论/;

// 统一错误分类：区分「鉴权失败 / 请求参数 / 超时 / 网络错误 / 其他」，
// 供重试兜底与用户提示使用（避免把所有失败笼统说成"检查网络或 Key"）。
function classifyAIError(e) {
  const msg = String((e && e.message) || '');
  const status = (e && e.response && e.response.status) || 0;
  if (status === 401 || status === 403 || /invalid_api_key|unauthorized|authentication|api[ _-]?key/i.test(msg)) {
    return { kind: 'auth', label: 'AI API Key 无效或已过期', hint: '请在「AI 设置」中确认 Key 正确且未过期' };
  }
  if (status === 400 || status === 404) {
    return { kind: 'badRequest', label: 'AI 请求参数或模型不可用', hint: '请在「AI 设置」中确认所选模型支持联网搜索' };
  }
  if (/超时|timeout/i.test(msg) || status === 408 || status === 504) {
    return { kind: 'timeout', label: 'AI 分析超时', hint: '请稍后点「重新分析」重试；如频繁超时请检查网络或更换更快模型' };
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|network/i.test(msg)) {
    return { kind: 'network', label: '网络连接失败', hint: '请检查本机网络后重试' };
  }
  return { kind: 'other', label: 'AI 分析失败', hint: '请稍后重试' };
}

// 带指数退避重试的 LLM 调用（默认 60s 超时，与底层 axios 超时对齐）：
// 仅对「网络错误」这类快速失败做重试；超时已给足 60s，鉴权/400 重试无意义，均不重试。
// webSearch=true（默认）=联网类（异动归因/热议话题，需检索最新公告舆情）
async function callLLMWithRetry(cfg, messages, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const attempts = opts.attempts || 2;
  const webSearch = opts.webSearch !== false; // 默认联网
  // 20260904a：透传妙想参数（mxQuery 替换 / mxInject 增强）给 ai.callLLM
  const mxOpts = {};
  if (opts.mxQuery) mxOpts.mxQuery = opts.mxQuery;
  if (opts.mxInject) mxOpts.mxInject = true;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pTimeout(ai.callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch, ...mxOpts }), timeoutMs, 'LLM');
    } catch (e) {
      lastErr = e;
      const cls = classifyAIError(e);
      if (cls.kind !== 'network' || i === attempts - 1) break;
      await sleep(1000 * Math.pow(2, i)); // 1s、2s…
    }
  }
  throw lastErr;
}

// ---- 模式一：当日异动归因（涨跌幅绝对值 ≥3%）----

/**
 * 当个股涨跌幅绝对值 ≥3% 时，联网搜索并调用 LLM 分析当日涨跌的最直接原因。
 * @param {string} symbol
 * @param {string} name
 * @param {object|null} quoteArg 已取出的行情（避免重复拉取）；为空则内部拉取
 * @param {boolean} force 为 true 时忽略缓存、强制重新分析
 * 返回 {mode:'priceChange', triggered, changePct, analysis, sources, date} 或 null（未触发）
 */
async function analyzePriceChange(symbol, name, quoteArg, force) {
  let quote = quoteArg;
  if (!quote) {
    try { quote = await getQuote(symbol); } catch (e) {
      console.error('[HotTopics] getQuote failed:', e.message);
      return null;
    }
  }
  if (!quote || quote.changePct == null) return null;
  // 20261013g：触发判定 = 涨跌幅绝对值 ≥3% 或 当日振幅 >3%（用户要求：震荡幅度超 3% 也联网分析原因）
  const trig = resolveTrigger(quote);
  if (!trig) return null;
  const changePct = trig.changePct;
  const triggeredBy = trig.triggeredBy; // 'priceChange'（涨跌幅触发）| 'amplitude'（振幅触发）

  // 数据一致性红线：分析对象名称以权威行情源为准，入参 name 仅作降级，
  // 确保证据检索（舆情/公告）与 LLM prompt 都指向正确的公司。
  const resolvedName = (quote.name && String(quote.name).trim()) || String(name || '').trim() || String(symbol);

  const today = quote.date || localDate();
  const cache = readJSON(symbol, 'price-change.json', null);
  // 按交易日缓存：同方向且仍满足阈值时复用，避免盘中频繁调用 AI
  // 额外校验分析对象名称：若缓存的公司名与当前行情源名称不一致（说明当时分析错了公司），
  // 视为无效缓存，作废重算——避免错误归因被长期复用误导用户。
  // 缓存必须同时具备 symbolName 且与当前行情源名称一致才可信；
  // 旧版本写入的缓存无 symbolName 字段（无法证明分析对象正确），一律作废重算。
  const cacheName = cache && cache.symbolName ? String(cache.symbolName).trim() : '';
  const cacheNameOk = !!(cacheName && quote.name && cacheName === String(quote.name).trim());
  // 缓存复用额外要求触发方式一致（涨跌幅触发 vs 振幅触发）且方向一致：盘中振幅扩大/方向翻转时重算
  const cacheTriggeredBy = (cache && cache.triggeredBy) || 'priceChange';
  // 数据一致性红线：缓存只复用 AI 归因「文本」，展示用数值（涨跌幅/振幅/最高/最低/现价/昨收）
  // 必须以当前行情为准——盘中快照（如 14:00 取的 -4.40%/振幅2.98%）会被收盘后（实际 -5.97%）复用，
  // 导致卡片数字与页头实际涨跌不符（用户 2026-11-01 报障：长江证券 000783 卡显示 -4.40%/振幅2.98%，页头 -5.97%）。
  // 若盘中快照与当前涨跌幅漂移 >1.0pp（典型为盘中→收盘漂移），作废缓存重算，保证归因文本与数字同时正确。
  const cacheDrift = (cache && typeof cache.changePct === 'number') ? Math.abs(changePct - cache.changePct) : 99;
  const cacheUsable = !force && cache && cache.date === today && cache.analysis && cacheNameOk && cache.cacheVer === CACHE_VER && cacheTriggeredBy === triggeredBy && Math.sign(cache.changePct) === Math.sign(changePct) && cacheDrift <= 1.0;
  if (cacheUsable) {
    return {
      ...cache,
      mode: 'priceChange',
      cached: true,
      changePct,
      amplitude: trig.amplitude,
      high: quote.high != null ? quote.high : null,
      low: quote.low != null ? quote.low : null,
      price: quote.price,
      prevClose: quote.prevClose,
      date: today,
    };
  }

  // 收集公开信息证据（20260913f：并行抓取 + 新增股吧讨论帖/热度/个股新闻三路渠道）
  const evidence = [];
  const [ann, sent, rep, disc] = await Promise.all([
    cns.searchAnnouncementsByCode(symbol, 20).catch(() => ({ ok: false })),
    cns.getGlobalSentiment(resolvedName, { days: 3, maxArticles: 15, budget: 10 }).catch(() => ({ ok: false })),
    cns.interpretReport(symbol).catch(() => ({ ok: false })),
    collectDiscussion(symbol, resolvedName),
  ]);
  if (ann && ann.ok && ann.items && ann.items.length) {
    evidence.push({ source: '交易所公告', items: ann.items.slice(0, 10) });
  }
  if (sent && sent.ok && sent.articles && sent.articles.length) {
    evidence.push({ source: '全网舆情', items: sent.articles.slice(0, 10) });
  }
  if (rep && rep.ok) evidence.push({ source: '财报解读', ...rep });
  const postItems = disc && disc.posts.length ? postsToEvidenceItems(disc.posts) : [];
  if (postItems.length) evidence.push({ source: '同花顺股吧讨论帖', items: postItems });
  const discussionDigest = buildDiscussionDigest(disc);
  if (discussionDigest) evidence.push({ source: '多平台讨论热度（东财/同花顺/雪球）', items: [{ title: discussionDigest, heat: '高' }] });
  // 20260923h：投资者问答（交易所官方平台的一手问答，归因时价值高）
  const irmItems = (disc && disc.irm) ? irmToEvidenceItems(disc.irm.posts) : [];
  if (irmItems.length) evidence.push({ source: `投资者问答（${disc.irm.source || ''}）`, items: irmItems });

  const cfg = ai.loadConfig();
  const baseResult = {
    ok: true,
    mode: 'priceChange',
    triggered: true,
    triggeredBy,                    // 20261013g：触发方式（涨跌幅 / 振幅）
    changePct,
    amplitude: trig.amplitude,      // 20261013g：当日振幅%（供前端展示）
    high: quote.high != null ? quote.high : null,
    low: quote.low != null ? quote.low : null,
    price: quote.price,
    prevClose: quote.prevClose,
    date: today,
    threshold: PRICE_CHANGE_THRESHOLD,
    amplitudeThreshold: AMPLITUDE_THRESHOLD,
    symbol,
    symbolName: quote.name || '', // 记录本次分析对象，供缓存复用时校验一致性
    cacheVer: CACHE_VER,          // 20260913f：口径版本门控
    discussion: (typeof discussionDigest === 'string' && discussionDigest) ? { digest: discussionDigest } : null,
    irmQa: buildIrmQaBlock(disc && disc.irm), // 20260923h：投资者问答子卡
  };

  if (!cfg.apiKey) {
    const result = {
      ...baseResult,
      analysis: '未配置 AI API Key，无法自动联网归因。请在「AI 设置」中配置 Key 后刷新。',
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
      noKey: true,
    };
    writeJSON(symbol, 'price-change.json', result);
    return result;
  }

  const evidenceText = evidence
    .map((e, idx) => `[证据${idx + 1}] ${e.source}: ${JSON.stringify(e.items || e).slice(0, 1800)}`)
    .join('\n---\n');

  // 20261013g：归因对象描述按触发方式区分——涨跌幅触发说「上涨/下跌」，振幅触发说「宽幅震荡」
  const direction = changePct > 0 ? '上涨' : '下跌';
  const situation = triggeredBy === 'amplitude'
    ? `今日股价宽幅震荡：振幅 ${Number(trig.amplitude).toFixed(2)}%（盘中最高 ${quote.high != null ? quote.high : '—'} 元 / 最低 ${quote.low != null ? quote.low : '—'} 元），收盘涨跌幅 ${changePct.toFixed(2)}%（现价 ${quote.price} 元，昨收 ${quote.prevClose} 元）`
    : `今日${direction} ${Math.abs(changePct).toFixed(2)}%（现价 ${quote.price} 元，昨收 ${quote.prevClose} 元）`;
  const askTarget = triggeredBy === 'amplitude' ? '今日盘中宽幅震荡（冲高回落/探底回升/深 V 等）的最直接原因' : '今日股价异动的最直接原因';
  const prompt = `你是 A 股短线分析师，熟悉公告、舆情与盘面。股票「${resolvedName}」（代码 ${symbol}）${situation}。请结合联网搜索到的最新公开信息，分析${askTarget}。
要求：
1) 用简体中文，直接给出 1-3 条最可能的核心原因；
2) 每条原因说明是「公告驱动」「舆情/新闻驱动」「板块/大盘带动」「资金博弈」还是「其他」；
3) 标注信息来源与可信度（已核实公告 / 媒体报道 / 市场推测）；
4) 若公开信息不足以解释，明确写「公开信息未能完全解释今日异动」；
5) 总长度控制在 300 字以内，只输出分析结论，不要 JSON。`;

  try {
    // 20260904a：异动归因用妙想东财资讯补公告/舆情事实源（evidence 已含 cnscraper 公告+全网舆情），
    // 妙想可用时省通用搜索；失败自动回退通用搜索。
    const priceMxQuery = `${resolvedName}（${symbol}）今日股价异动原因 最新公告 新闻 板块`;
    const text = await callLLMWithRetry(cfg, [
      { role: 'system', content: '你是专业 A 股分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt + (evidenceText ? '\n\n可参考以下公开信息片段：\n' + evidenceText : '') },
    ], { webSearch: true, mxQuery: priceMxQuery });
    const result = {
      ...baseResult,
      analysis: text || 'AI 返回为空',
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
    };
    writeJSON(symbol, 'price-change.json', result);
    return result;
  } catch (e) {
    console.error('[HotTopics] analyzePriceChange LLM failed:', e.message);
    const cls = classifyAIError(e);
    // 降级顺序：① 历史成功结果 → ② 本次抓取的公开信息 → ③ 明确提示
    if (cache && cache.analysis && !cache.noKey) {
      // 降级时也以当前行情刷新展示数值（不展示盘中冻结快照）
      return {
        ...cache,
        mode: 'priceChange',
        cached: false,
        stale: true,
        changePct,
        amplitude: trig.amplitude,
        high: quote.high != null ? quote.high : null,
        low: quote.low != null ? quote.low : null,
        price: quote.price,
        prevClose: quote.prevClose,
        date: today,
      };
    }
    let analysis = `${cls.label}。`;
    const evParts = [];
    for (const ev of evidence) {
      const items = ev.items || ev.articles || [];
      if (Array.isArray(items) && items.length) {
        evParts.push('【' + ev.source + '】' + items.slice(0, 5).map(it => it.title || it.content || '').filter(Boolean).join('；'));
      }
    }
    analysis += evParts.length
      ? ' 可参考公开信息：' + evParts.join(' ')
      : ` 未抓取到有效公开信息。${cls.hint}。`;
    const result = {
      ...baseResult,
      analysis,
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
      error: e.message,
    };
    return result;
  }
}

// ---- 模式二：网络热议话题（涨跌幅绝对值 <3%）----

/**
 * 当个股涨跌幅绝对值 <3% 时，联网搜索并调用 LLM 分析该股近期网络上讨论最多的话题/关键词。
 * @param {string} symbol
 * @param {string} name
 * @param {object|null} quote 已取出的行情（取当日日期/涨跌幅）
 * @param {boolean} force 为 true 时忽略缓存、强制重新分析
 */
async function analyzeTrendingTopics(symbol, name, quote, force) {
  const today = (quote && quote.date) || localDate();
  const cache = readJSON(symbol, 'trending.json', null);
  // 同 priceChange：校验分析对象名称，缓存的公司名与当前行情源不一致则作废重算
  // 同 priceChange：缓存必须带 symbolName 且与行情源一致才可信，缺失一律作废重算
  const cacheName = cache && cache.symbolName ? String(cache.symbolName).trim() : '';
  const cacheNameOk = !!(cacheName && quote && quote.name && cacheName === String(quote.name).trim());
  const cacheVerOk = !!(cache && cache.cacheVer === CACHE_VER); // 20260913f：旧口径缓存作废重算
  if (!force && cache && cache.date === today && Array.isArray(cache.topics) && cache.topics.length && cacheNameOk && cacheVerOk) {
    return { ...cache, mode: 'trending', cached: true };
  }

  // 数据一致性红线：分析对象名称以权威行情源为准，入参 name 仅作降级
  const resolvedName = (quote && quote.name && String(quote.name).trim()) || String(name || '').trim() || String(symbol);

  // best-effort 抓取舆情/公告/股吧讨论作为 grounding（失败不影响，LLM 自带联网搜索兜底）
  // 20260913f：五路渠道并行抓取——① 全网舆情(cnscraper 60+源) ② 交易所公告
  // ③ 同花顺股吧讨论帖 ④ 东财/同花顺/雪球讨论热度 ⑤ 个股新闻情感。
  // ③④⑤ 与「舆情与讨论热度（个股）」因子同源（lib/sentiment），确保两卡口径一致。
  const evidence = [];
  const [sent, ann, disc] = await Promise.all([
    cns.getGlobalSentiment(resolvedName, { days: 7, maxArticles: 18, budget: 14 }).catch(() => ({ ok: false })),
    cns.searchAnnouncementsByCode(symbol, 20).catch(() => ({ ok: false })),
    collectDiscussion(symbol, resolvedName),
  ]);
  if (sent && sent.ok && sent.articles && sent.articles.length) {
    evidence.push({ source: '全网舆情', items: sent.articles.slice(0, 12) });
  }
  if (ann && ann.ok && ann.items && ann.items.length) {
    evidence.push({ source: '交易所公告', items: ann.items.slice(0, 10) });
  }
  // ③ 同花顺股吧讨论帖（真实股民发帖，含焦点帖）
  const postItems = disc && disc.posts.length ? postsToEvidenceItems(disc.posts) : [];
  if (postItems.length) {
    evidence.push({ source: '同花顺股吧讨论帖', items: postItems });
  }
  // ④ 多平台讨论热度（东财股吧 / 同花顺热榜 / 雪球关注榜）
  const discussionDigest = buildDiscussionDigest(disc);
  if (discussionDigest) {
    evidence.push({ source: '多平台讨论热度（东财/同花顺/雪球）', items: [{ title: discussionDigest, heat: '高' }] });
  }
  // ⑤ 个股新闻情感样例（标题本身即是话题线索）
  if (disc && disc.news && Array.isArray(disc.news.samples) && disc.news.samples.length) {
    evidence.push({
      source: '个股新闻',
      items: disc.news.samples.slice(0, 8).map(s => ({
        title: s.title,
        date: s.date,
        sentiment: (Number(s.score) > 0.2) ? '利好' : (Number(s.score) < -0.2 ? '利空' : '中性'),
      })),
    });
  }
  // ⑥ 投资者问答（20260923h：交易所官方平台，投资者当下最关切的问题 + 公司回复口径）
  const irmItems = (disc && disc.irm) ? irmToEvidenceItems(disc.irm.posts) : [];
  if (irmItems.length) evidence.push({ source: `投资者问答（${disc.irm.source || ''}）`, items: irmItems });

  const baseResult = {
    ok: true,
    mode: 'trending',
    triggered: false,
    changePct: quote && quote.changePct != null ? quote.changePct : 0,
    date: today,
    symbol,
    symbolName: (quote && quote.name) || '', // 记录本次分析对象，供缓存复用时校验一致性
    cacheVer: CACHE_VER,                     // 20260913f：口径版本门控
    // 投资者问答子卡（20260923h）：独立于 discussion，无讨论帖也照常展示
    irmQa: buildIrmQaBlock(disc && disc.irm),
    // 讨论帖/热度（与「舆情与讨论热度（个股）」因子同源），供前端展示与口径对齐
    discussion: (disc && disc.ok) ? {
      digest: discussionDigest,
      postCount: disc.posts.length,
      topPost: disc.posts.length ? disc.posts.slice().sort((a, b) => b.eng - a.eng)[0].content.slice(0, 100) : '',
      topPostDate: disc.posts.length ? disc.posts.slice().sort((a, b) => b.eng - a.eng)[0].date : '',
      heat: disc.heat ? {
        eastmoney: disc.heat.eastmoney || null,
        tonghuashun: disc.heat.tonghuashun || null,
        xueqiu: disc.heat.xueqiu || null,
      } : null,
    } : null,
  };

  const cfg = ai.loadConfig();
  if (!cfg.apiKey) {
    const result = {
      ...baseResult,
      topics: [],
      content: '未配置 AI API Key，无法联网分析网络热议话题。请在「AI 设置」中配置 Key 后刷新。',
      sources: [],
      noKey: true,
    };
    writeJSON(symbol, 'trending.json', result);
    return result;
  }

  const evidenceText = evidence
    .map((e, idx) => `[证据${idx + 1}] ${e.source}: ${JSON.stringify(e.items || e).slice(0, 1500)}`)
    .join('\n---\n');

  const prompt = `你是 A 股舆情分析师，需联网搜索最新信息。请联网搜索股票「${resolvedName}」（代码 ${symbol}）近期（最近 1-2 周）在网络上被讨论最多、热度最高的话题与关键词（覆盖财经社区/股吧/雪球/同花顺/新闻媒体等）。
要求：
1) 只输出严格 JSON，不要 Markdown 代码块，格式：
{"topics":[{"keyword":"话题或关键词（2-12字）","desc":"1-2 句说明市场主要观点或争议点","heat":"高|中|低","sentiment":"利好|利空|中性|未知"}],"summary":"对整体舆论热度的综述（2-3 句，含多空与热度判断）"}
2) 取 5-8 个最热话题，覆盖不同维度（业绩/政策/行业/事件/资金等）；
3) 仅输出确有公开讨论支撑的话题，不要编造无依据内容；
4) 简体中文。
5) 下方「可参考的公开信息片段」中若已包含「同花顺股吧讨论帖」或「多平台讨论热度」，
   必须优先据其归纳出真实话题（含股民正在讨论的具体事件），**严禁**回答"未抓取到帖子/无热议话题"——
   只有在你既未联网检索到、证据中也没有任何讨论内容时，才可说明"当前公开渠道暂未发现明显热议话题"。`;

  try {
    const text = await callLLMWithRetry(cfg, [
      { role: 'system', content: '你是专业 A 股舆情分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt + (evidenceText ? '\n\n可参考以下公开信息片段：\n' + evidenceText : '') },
    ], { webSearch: true });
    const parsed = aiExtractJson(text);
    let topics = [];
    if (parsed && Array.isArray(parsed.topics)) {
      topics = parsed.topics.map(t => ({
        keyword: normalizeKeyword(t.keyword),
        desc: String(t.desc || '').trim(),
        heat: ['高', '中', '低'].includes(t.heat) ? t.heat : '中',
        sentiment: ['利好', '利空', '中性', '未知'].includes(t.sentiment) ? t.sentiment : '未知',
      })).filter(t => t.keyword).slice(0, 8);
    }
    let content = String((parsed && parsed.summary) || '').trim() || '（AI 未返回综述）';
    // 20260913f：LLM 在已抓到讨论帖的情况下仍称「未抓取到」时（典型：只看到页面框架就断言），
    // 用确定性讨论摘要覆盖综述，保证与「舆情与讨论热度（个股）」卡片结论一致。
    // 正常情况讨论摘要由前端单独渲染（analysis.discussion.digest），不在此重复拼接。
    if (discussionDigest && NO_CONTENT_RE.test(content)) {
      content = `【讨论热度】${discussionDigest}。已抓取到股吧讨论帖与多平台热度，详见下方话题列表。`;
    }
    // LLM 成功但返回空话题时，降级到原始舆情/公告/股吧讨论帖，避免卡片显示空
    if (!topics.length) {
      const fallbackTopics = buildFallbackTopics(evidence);
      const result = {
        ...baseResult,
        topics: fallbackTopics,
        content: fallbackTopics.length
          ? 'AI 聚合返回为空，已展示抓取到的股吧讨论帖/舆情/公告原始条目。'
          : '当前未能抓取到有效网络舆情、公告或股吧讨论，且 AI 聚合返回为空，请稍后刷新或检查网络。',
        sources: evidence.filter(e => e.items || e.articles).map(e => e.source),
        llmEmpty: true,
      };
      writeJSON(symbol, 'trending.json', result);
      return result;
    }
    const result = {
      ...baseResult,
      topics,
      content,
      sources: evidence.filter(e => e.items).map(e => e.source),
    };
    writeJSON(symbol, 'trending.json', result);
    return result;
  } catch (e) {
    console.error('[HotTopics] analyzeTrendingTopics LLM failed:', e.message);
    const cls = classifyAIError(e);
    // 降级顺序：① 历史成功结果（昨日/更早，且为同口径版本）→ ② 本次抓取的讨论帖/舆情/公告 → ③ 明确提示
    if (cache && cacheVerOk && Array.isArray(cache.topics) && cache.topics.length) {
      const prefix = String(cache.content || '').trim();
      const result = {
        ...baseResult,
        topics: cache.topics,
        content: prefix + (prefix ? ' ' : '') + `【${cls.label}，暂展示历史分析结果，可点「重新分析」重试】`,
        sources: cache.sources || [],
        stale: true,
        error: e.message,
      };
      return result;
    }
    const fallbackTopics = buildFallbackTopics(evidence);
    const result = {
      ...baseResult,
      topics: fallbackTopics,
      content: fallbackTopics.length
        ? `${cls.label}，已展示抓取到的股吧讨论帖/舆情/公告原始条目。`
        : `${cls.label}：未抓取到有效网络舆情、公告或股吧讨论。${cls.hint}。`,
      sources: evidence.filter(e => e.items || e.articles).map(e => e.source),
      error: e.message,
    };
    return result;
  }
}

// ---- 统一状态入口（前端只读）----
// force=true 时忽略缓存、强制重新分析（来自前端「重新分析」按钮 ?refresh=1）

async function getState(symbol, nameArg, force) {
  const cfg = ai.loadConfig();
  let quote = null;
  try { quote = await pTimeout(getQuote(symbol), 8000, 'getQuote'); } catch (e) { console.error('[HotTopics] getQuote timeout/err:', e.message); }
  const changePct = quote && quote.changePct != null ? quote.changePct : 0;

  // 数据一致性红线：股票名称以权威行情源（腾讯）为准，前端传入的 name 仅作降级。
  // 前端曾在切换股票时残留上一只股票的名称（600460 却传「长江证券」），
  // 导致 LLM 全部证据检索、公告解读、板块分析都基于错误公司，整张卡片不可信。
  const quoteName = quote && quote.name ? String(quote.name).trim() : '';
  const argName = String(nameArg || '').trim();
  let name = quoteName || argName || String(symbol || '');
  if (argName && quoteName && argName !== quoteName) {
    console.warn(`[HotTopics] 名称不一致：入参「${argName}」，行情源「${quoteName}」（${symbol}），以行情源为准`);
  }

  let analysis = null;
  // 20261013g：切换条件 = 涨跌幅绝对值 ≥3% 或 当日振幅 >3%（用户要求：震荡幅度超 3% 联网分析原因）
  const trigQuick = resolveTrigger(quote);
  if (trigQuick) {
    analysis = await analyzePriceChange(symbol, name, quote, force);
    if (analysis) analysis.mode = 'priceChange';
  } else {
    analysis = await analyzeTrendingTopics(symbol, name, quote, force);
    if (analysis) analysis.mode = 'trending';
  }

  return {
    ok: true,
    symbol,
    hasKey: !!cfg.apiKey,
    changePct,
    amplitude: quote && quote.amplitude != null ? quote.amplitude : null, // 20261013g：供前端展示
    triggeredBy: trigQuick ? trigQuick.triggeredBy : null,
    mode: analysis ? analysis.mode : null,
    analysis,
  };
}

module.exports = {
  analyzePriceChange,
  analyzeTrendingTopics,
  getState,
};

~~~

---

## `lib\hotTopicsWeekly\config.js`  ·  66 行

~~~js
/**
 * 板块舆情热度周榜 · 配置（20260913h 双社区源）
 * 默认值内置于此；用户可在 data/hotTopics/config.json 覆盖同名键（浅合并，按节覆盖）。
 * 全部权重/阈值人工可配置 —— 对应用户框架「权重、阈值、新手判定规则人工可配置」。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 五项指标权重（A 舆情曝光 / B 社区讨论 / D 舆情情感 / E 社区情感；C 只参与告警不进综合分）
  weights: { A: 0.4, B: 0.4, D: 0.1, E: 0.1 },
  // 社区讨论不可用时的降级权重（A+D 重新归一）
  degradeWeights: { A: 0.8, D: 0.2 },
  // 社区讨论数据源（双源合并去重，20260913h）：em=东方财富股吧板块吧，ths=同花顺讨论 API
  //   —— Python 采集器读取 data/hotTopics/config.json 的同一节；两源任一可用即不降级。
  //   emIntervalSec=东财抓取间隔（秒）；emFailStreakMax=东财连续失败熔断阈值。
  community: { em: true, ths: true, emIntervalSec: 1.2, emFailStreakMax: 8 },
  // 热度等级阈值
  levels: { hot: 72, warm: 60 },
  // 告警：C 归一化 ≥ cNorm 且综合分 ≥ score → ⚠️ 韭菜蜂拥
  alarm: { cNorm: 90, score: 70 },
  // 三路交叉验证修正（外部输入：行业5日涨幅 / 主力5日净占比 / 归一化A、B）
  crossCheck: {
    enabled: true,
    fundConfirm: { scoreMin: 60, netPctMin: 1.0, adj: 4 },    // 热度高+资金流入确认 +
    fundDiverge: { scoreMin: 60, netPctMax: -1.0, adj: -6 },  // 热度高+资金流出背离 −
    chaseOverheat: { scoreMin: 70, pctMin: 5.0, adj: -6 },    // 热度高+周涨幅过热（追高拥挤）−
    resonance: { aMin: 70, bMin: 70, adj: 4, gapMin: 50, gapAdj: -3 }, // 舆情/社区共振 + / 单源虚热 −
    maxAdjust: 8,                                              // 修正总量上限（每方向）
  },
  // 情绪标签阈值（按优先级自上而下命中一条即止）
  sentimentTags: {
    runAway: { scoreMin: 70, pctMax: -3 },        // 比谁跑得快：高热+周涨幅显著为负
    panic: { eMax: 25, scoreMin: 50 },            // 极度恐慌：社区看多占比极低
    crowded: { netPctMin: 3.0, scoreMin: 70 },    // 资金拥挤：主力大额流入+高热
    kolSwarm: { dMin: 85, eMin: 75, scoreMin: 60 }, // KOL蜂拥：舆情与社区一致强烈看多
    divergence: { dEGapMin: 35, scoreMin: 40 },   // 分化磨盘：舆情与社区情绪显著分歧
    numb: { scoreMin: 40, scoreMax: 60, netPctAbs: 1.0, pctAbs: 2.0 }, // 筹码钝化：温吞+资金平静
  },
  // 采集调度
  collect: { gubaIntervalSec: 1.2, staleMinutes: 30, pythonTimeoutMs: 300000 },
  // 榜单规模
  topN: 10,
};

function loadConfig(dataDir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const p = path.join(dataDir, 'config.json');
    if (fs.existsSync(p)) {
      const user = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const k of Object.keys(user)) {
        if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && cfg[k] && typeof cfg[k] === 'object') {
          Object.assign(cfg[k], user[k]);
        } else {
          cfg[k] = user[k];
        }
      }
    }
  } catch (e) { /* 配置文件损坏 → 用默认值 */ }
  return cfg;
}

module.exports = { DEFAULTS, loadConfig };

~~~

---

## `lib\hotTopicsWeekly\engine.js`  ·  311 行

~~~js
/**
 * 板块舆情热度周榜 · 周聚合计算引擎（20260913h 双社区源）
 * --------------------------------------------------------------
 * 流程：本周已有每日采集文件 → 帖子/快讯按 id 去重 → 五项原始指标（A 舆情曝光 / B 社区讨论 /
 * C 韭菜讨论 / D 舆情情感 / E 社区情感）→ Min-Max 归一化(A/B/C) → 加权基础分 →
 * 三路交叉验证修正(5 组合，外部输入=行业5日涨幅/主力5日净占比/归一化A、B) →
 * 热度等级 + 情绪标签 + 告警 → 降序榜单。
 *
 * 铁律：全部确定性代码计算，无 LLM；社区源缺失时自动降级（权重重分配并在 meta 标注）。
 * 口径：A=本周归属快讯条数（快讯无曝光量字段，以条数为代理指标）；B=社区讨论帖累计增量+
 *       采样帖浏览/评论之和；C=采样帖中韭菜句式帖数；D/E=看多占比(%)。
 * 社区源（20260913h 起双源合并）：`gubaEm`=东方财富股吧板块吧（真实散户帖，**只参与 C/E**）；
 *       `guba`=同花顺讨论 API（同时提供 B 的帖数增量与互动量）；两源任一有数据即不降级。
 *       ⚠️ B 的量级项一律取同花顺单源：东财 post_click_count 是真·浏览量（十万级）、同花顺 clicks 是
 *          点赞+转发（十位级），相加会让 B 被东财浏览量压垮并使排名偏向「恰好被东财覆盖的板块」。
 *          东财 `count`（板块总帖数）已采集存档，待「全量覆盖/分源归一化」后再用于 B 的增量。
 */
'use strict';
const { classifySentiment, isRookiePost, isSpam, normalizeText, buildMatcher } = require('./nlp');

// ---------- ISO 周工具 ----------
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function mondayOf(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - (day - 1));
  return date;
}
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 本自然周 周一..今天 的日期串列表（含端点） */
function weekDatesUntilToday(now) {
  const mon = mondayOf(now);
  const out = [];
  for (let i = 0; ; i++) {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    out.push(fmtDate(d));
    if (fmtDate(d) === fmtDate(now)) break;
    if (i > 10) break; // 保险
  }
  return out;
}

// ---------- 归一化 ----------
function minMaxNormalize(values) {
  // values: Map<code, raw|null> → Map<code, 0..100|null>
  const entries = [...values.entries()].filter(([, v]) => v != null);
  const out = new Map();
  if (!entries.length) return out;
  let min = Infinity, max = -Infinity;
  for (const [, v] of entries) { if (v < min) min = v; if (v > max) max = v; }
  for (const [k, v] of values) {
    if (v == null) { out.set(k, null); continue; }
    out.set(k, max === min ? 50 : ((v - min) / (max - min)) * 100);
  }
  return out;
}

// ---------- 主计算 ----------
/**
 * @param {Array<{code,name,aliases,keywords}>} boards
 * @param {Array<{date,data}>} dailies 按日期升序的本周每日采集文件
 * @param {object} cfg loadConfig 结果
 */
function computeWeekly(boards, dailies, cfg) {
  const normName = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const baseName = s => String(s || '').replace(/[ⅠⅡⅢIV]+$/g, '').trim();

  // 0) 最新有效行情行（交叉验证输入）
  let marketRows = [];
  for (const d of dailies) {
    if (d.data.market && d.data.market.status === 'ok' && Array.isArray(d.data.market.rows) && d.data.market.rows.length) {
      marketRows = d.data.market.rows; // 取最近一个成功日
    }
  }
  const marketByName = new Map();
  const marketByCode = new Map();
  for (const r of marketRows) {
    if (r.code) marketByCode.set(String(r.code).toUpperCase(), r);
    marketByName.set(normName(r.name), r);
    marketByName.set(normName(baseName(r.name)), r);
  }

  // 1) 匹配器（含主导股名归属）
  const leadingStocks = new Map();
  for (const r of marketRows) {
    if (r.maxStock) {
      const key = normName(baseName(r.name));
      if (!leadingStocks.has(key)) leadingStocks.set(key, []);
      leadingStocks.get(key).push(r.maxStock);
    }
  }
  const matcher = buildMatcher(boards, leadingStocks);

  // 2) 聚合容器
  const agg = new Map(); // code -> {name, newsCount, newsBull, newsBear, newsTotal, posts Map, clicks, comments, rookie, gubaBull, gubaBear, gubaTotal, countByDate}
  const boardByCode = new Map();
  for (const b of boards) {
    boardByCode.set(b.code, b);
    agg.set(b.code, {
      name: b.name, newsCount: 0, newsBull: 0, newsBear: 0, newsTotal: 0,
      posts: new Map(), clicks: 0, comments: 0, rookie: 0,
      gubaBull: 0, gubaBear: 0, gubaTotal: 0, countByDate: new Map(),
      clicksCounted: new Set(), // 已计入 B 互动量的帖 id（防跨日/跨源重复累加）
    });
  }

  // 3) 舆情文本归属（跨日去重）
  const newsSeen = new Set();
  let newsItemsTotal = 0;
  for (const d of dailies) {
    const items = (d.data.news && d.data.news.items) || [];
    for (const it of items) {
      const text = `${it.title || ''} ${it.text || ''}`.trim();
      if (!text) continue;
      const key = normalizeText(it.title || it.text || '').slice(0, 60);
      if (!key || newsSeen.has(key)) continue;
      newsSeen.add(key);
      newsItemsTotal++;
      const codes = matcher.attribute(text);
      const sent = classifySentiment(text);
      for (const code of codes) {
        const a = agg.get(code);
        if (!a) continue;
        a.newsCount++;
        a.newsTotal++;
        if (sent === 'bullish') a.newsBull++;
        else if (sent === 'bearish') a.newsBear++;
      }
    }
  }

  // 4) 社区帖子聚合（双源：东财股吧板块吧 'gubaEm' + 同花顺讨论 API 'guba'；跨日跨源按 post_id 去重；置顶帖不计入采样）
  //
  //    ⚠️ 口径边界（重要，勿混算）：两源的「互动量」量级不可比 —— 东财 `post_click_count` 是**真·浏览量**
  //    （单帖可达十万级），同花顺 `clicks` = 点赞+转发（十位级）。若相加，B 会被东财浏览量彻底压垮，
  //    且排名会偏向「恰好被东财覆盖到的板块」（东财受风控，本次仅覆盖 62/92 板块）。
  //    因此本版口径：**B 的「帖数增量 + 互动量」统一取同花顺**（口径一致、覆盖全部板块）；
  //    东财只贡献**采样帖**进入 C/E（占比/计数，不涉及量级混算），并在 sources 中单独报告。
  //    东财 `count`（板块总帖数）已随日文件采集存档，待「全量覆盖 或 分源归一化」后再用于 B 的增量。
  const COMMUNITY_SOURCES = [
    { key: 'gubaEm', tag: 'em', feedsB: false }, // 东方财富股吧（板块吧）
    { key: 'guba', tag: 'ths', feedsB: true },   // 同花顺讨论 API（B 的量级项来源）
  ];
  let gubaOkDays = 0;                  // 至少一个社区源提供数据的天数
  const srcOkDays = { em: 0, ths: 0 }; // 各源提供数据的天数（含 challenge 部分成功的天数）
  for (const d of dailies) {
    let dayAnyOk = false;
    for (const S of COMMUNITY_SOURCES) {
      const g = d.data[S.key];
      // ⚠️ 'challenge'（采集到一半被风控拦截）**已拿到的板块数据仍然有效**，必须照常并入——
      //    熔断的目的就是保住已抓到的数据，不能因为 status 不是 'ok' 就整包丢弃。
      //    仅当该源完全没产出板块数据（error/disabled/空）时才跳过。
      if (!g || !g.boards || !Object.keys(g.boards).length) continue;
      srcOkDays[S.tag]++;
      dayAnyOk = true;
      for (const [code, bd] of Object.entries(g.boards)) {
        const a = agg.get(code);
        if (!a) continue;
        if (S.feedsB && bd.count != null) a.countByDate.set(d.date, bd.count);
        for (const p of (bd.posts || [])) {
          if (!p.id) continue;
          const isNew = !a.posts.has(p.id);
          if (isNew) a.posts.set(p.id, p); // 帖子身份去重容器
          if (p.pinned) continue;
          if (isSpam(p.title)) continue;
          // B 的互动量：本源 feedsB（同花顺）且本帖尚未计入过同花顺互动量 → 累加一次。
          // ⚠️ 即便该帖身份此前由东财登记过，也不应丢失同花顺的互动量（两源 ID 命名空间不同，
          //     同一 id 跨源碰撞极罕见；但若发生，同花顺 clicks/comments 才是 B 的口径来源）。
          if (S.feedsB && !a.clicksCounted.has(p.id)) {
            a.clicksCounted.add(p.id);
            a.clicks += p.clicks || 0;
            a.comments += p.comments || 0;
          }
          // E/C（情绪/韭菜）按帖子身份去重：仅首次见到的帖参与采样（跨日/跨源各计一次）
          if (isNew) {
            if (isRookiePost(p.title)) a.rookie++;
            const sent = classifySentiment(p.title);
            a.gubaTotal++;
            if (sent === 'bullish') a.gubaBull++;
            else if (sent === 'bearish') a.gubaBear++;
          }
        }
      }
    }
    if (dayAnyOk) gubaOkDays++;
  }

  // 5) 原始指标
  for (const [code, a] of agg) {
    // B 的帖数增量：相邻有效日 count 差值之和；单日 → 采样帖数近似（口径见文件头）
    const dates = [...a.countByDate.keys()].sort();
    let delta = null;
    if (dates.length >= 2) {
      delta = 0;
      for (let i = 1; i < dates.length; i++) delta += Math.max(0, a.countByDate.get(dates[i]) - a.countByDate.get(dates[i - 1]));
    } else if (dates.length === 1) {
      delta = a.posts.size; // 首日种子：采样帖数近似
    }
    a.B_raw = (delta != null || a.clicks || a.comments) ? (delta || 0) + a.clicks + a.comments : 0;
    a.A_raw = a.newsCount;
    a.C_raw = a.rookie;
    a.D_raw = a.newsTotal ? (a.newsBull / a.newsTotal) * 100 : null;
    a.E_raw = a.gubaTotal ? (a.gubaBull / a.gubaTotal) * 100 : null;
  }

  // 6) 榜单池：任一指标有值的板块（E 也算一个指标——只有社区情绪、A/B/C 皆 0 的板块不应被丢弃）
  const universe = [...agg.entries()].filter(([, a]) => (a.A_raw || 0) > 0 || (a.B_raw || 0) > 0 || (a.C_raw || 0) > 0 || a.E_raw != null);

  // 7) 归一化（A/B/C 计数型 Min-Max；D/E 本身 0~100 百分比，保留绝对口径）
  const A_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.A_raw])));
  const B_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.B_raw])));
  const C_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.C_raw])));

  // 8) 通道可用性 → 权重（降级重分配；两个社区源任一可用即不降级）
  const communityAvailable = gubaOkDays > 0;
  const gubaAvailable = communityAvailable; // 兼容旧字段名（前端/外部读取）
  const w = communityAvailable ? cfg.weights : cfg.degradeWeights;

  // 9) 逐板块算分
  const rows = [];
  for (const [code, a] of universe) {
    const An = A_n.get(code), Bn = B_n.get(code), Cn = C_n.get(code);
    let base = 0;
    if (An != null) base += (w.A || 0) * An;
    if (gubaAvailable && Bn != null) base += (w.B || 0) * Bn;
    if (a.D_raw != null) base += (w.D || 0) * a.D_raw;
    if (gubaAvailable && a.E_raw != null) base += (w.E || 0) * a.E_raw;

    const m = marketByCode.get(String(code).toUpperCase()) ||
      marketByName.get(normName(a.name)) || marketByName.get(normName(baseName(a.name))) || {};
    const cc = cfg.crossCheck || {};
    let adj = 0;
    if (cc.enabled !== false) {
      const parts = [];
      if (m.netPct5d != null && base >= (cc.fundConfirm?.scoreMin ?? 60) && m.netPct5d >= (cc.fundConfirm?.netPctMin ?? 1)) parts.push(cc.fundConfirm?.adj ?? 4);
      if (m.netPct5d != null && base >= (cc.fundDiverge?.scoreMin ?? 60) && m.netPct5d <= (cc.fundDiverge?.netPctMax ?? -1)) parts.push(cc.fundDiverge?.adj ?? -6);
      if (m.pct5d != null && base >= (cc.chaseOverheat?.scoreMin ?? 70) && m.pct5d >= (cc.chaseOverheat?.pctMin ?? 5)) parts.push(cc.chaseOverheat?.adj ?? -6);
      if (An != null && Bn != null && An >= (cc.resonance?.aMin ?? 70) && Bn >= (cc.resonance?.bMin ?? 70)) parts.push(cc.resonance?.adj ?? 4);
      if (An != null && Bn != null && Math.abs(An - Bn) >= (cc.resonance?.gapMin ?? 50)) parts.push(cc.resonance?.gapAdj ?? -3);
      const maxA = Math.abs(cc.maxAdjust ?? 8);
      const sum = parts.reduce((s, x) => s + x, 0);
      adj = Math.max(-maxA, Math.min(maxA, sum));
    }
    let score = Math.max(0, Math.min(100, base + adj));

    // 热度等级
    const lv = cfg.levels || {};
    let level = '热度一般';
    if (score >= (lv.hot ?? 72)) level = '最热';
    else if (score >= (lv.warm ?? 60)) level = '有点挤';

    // 情绪标签（优先级自上而下）
    const st = cfg.sentimentTags || {};
    let tag = null;
    if (m.pct5d != null && score >= (st.runAway?.scoreMin ?? 70) && m.pct5d <= (st.runAway?.pctMax ?? -3)) tag = '比谁跑得快';
    else if (a.E_raw != null && a.E_raw <= (st.panic?.eMax ?? 25) && score >= (st.panic?.scoreMin ?? 50)) tag = '极度恐慌';
    else if (m.netPct5d != null && m.netPct5d >= (st.crowded?.netPctMin ?? 3) && score >= (st.crowded?.scoreMin ?? 70)) tag = '资金拥挤';
    else if (a.D_raw != null && a.E_raw != null && a.D_raw >= (st.kolSwarm?.dMin ?? 85) && a.E_raw >= (st.kolSwarm?.eMin ?? 75) && score >= (st.kolSwarm?.scoreMin ?? 60)) tag = 'KOL蜂拥';
    else if (a.D_raw != null && a.E_raw != null && Math.abs(a.D_raw - a.E_raw) >= (st.divergence?.dEGapMin ?? 35) && score >= (st.divergence?.scoreMin ?? 40)) tag = '分化磨盘';
    else if (score >= (st.numb?.scoreMin ?? 40) && score < (st.numb?.scoreMax ?? 60) && Math.abs(m.netPct5d || 0) < (st.numb?.netPctAbs ?? 1) && Math.abs(m.pct5d || 0) < (st.numb?.pctAbs ?? 2)) tag = '筹码钝化';

    // 告警
    const al = cfg.alarm || {};
    const alarm = !!(Cn != null && Cn >= (al.cNorm ?? 90) && score >= (al.score ?? 70));

    rows.push({
      code, name: a.name,
      score: Math.round(score * 10) / 10, level, tag, alarm,
      A: { raw: a.A_raw, n: An == null ? null : Math.round(An) },
      B: { raw: a.B_raw, n: Bn == null ? null : Math.round(Bn) },
      C: { raw: a.C_raw, n: Cn == null ? null : Math.round(Cn) },
      D: a.D_raw == null ? null : Math.round(a.D_raw),
      E: a.E_raw == null ? null : Math.round(a.E_raw),
      pct5d: m.pct5d != null ? m.pct5d : null,
      netPct5d: m.netPct5d != null ? m.netPct5d : null,
      maxStock: m.maxStock || '',
    });
  }
  rows.sort((x, y) => y.score - x.score);

  return {
    ok: rows.length > 0,
    rows,
    meta: {
      boardsTotal: boards.length,
      rankedCount: rows.length,
      newsItemsTotal,
      gubaAvailable,                 // 兼容旧字段：任一社区源有数据即 true
      communityAvailable,
      communitySrcOkDays: srcOkDays, // { em, ths } 各源提供数据的天数（含 challenge 部分成功）
      gubaOkDays,                    // 至少一个社区源提供数据的天数
      marketRows: marketRows.length,
      weightsUsed: w,
      degradeMode: !communityAvailable,
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { computeWeekly, isoWeekKey, weekDatesUntilToday, fmtDate };

~~~

---

## `lib\hotTopicsWeekly\index.js`  ·  208 行

~~~js
/**
 * 板块舆情热度周榜 · 调度入口（20260913h 双社区源）
 * --------------------------------------------------------------
 * GET /api/home-hot-topics 的后端实现（替换旧「今日最热股票话题/涨停板池」逻辑）。
 * - 数据文件：data/hotTopics/daily/{YYYY-MM-DD}.json（每日增量，python 采集器产出）
 *             data/hotTopics/weekly/{ISO周}.json（周榜存档，便于审计/回看）
 * - 社区讨论为双源（20260913h）：东方财富股吧板块吧（gubaEm）+ 同花顺讨论 API（guba），
 *   由 engine.js 合并去重后计入 B/C/E；两源任一可用即不降级。
 * - 调度：今日文件缺失 → 后台触发采集（立即返回「采集中」状态，不阻塞 HTTP）；
 *         refresh=1 且今日文件已过 staleMinutes → 重新采集（后台）+ 用现有文件先算一版。
 * - 防并发：同一时刻仅一个采集进程；重复请求复用在途 Promise。
 * - 铁律：全部计算为确定性代码（engine.js），LLM 不参与；数据不足时诚实返回状态，不编造。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { findPython } = require('../pyRuntime');
const { loadConfig } = require('./config');
const { computeWeekly, isoWeekKey, weekDatesUntilToday, fmtDate } = require('./engine');

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'hotTopics');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const WEEKLY_DIR = path.join(DATA_DIR, 'weekly');

// 在途采集锁（进程级）
let _collectInFlight = null;
let _collectStartedAt = 0;
let _lastCollectFinishAt = 0;

function _readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}
function _writeJsonAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { return false; }
}
function _dailyPath(dateStr) { return path.join(DAILY_DIR, dateStr + '.json'); }

function _today() {
  const d = new Date();
  return fmtDate(d);
}

/** 触发每日采集（后台执行，返回 Promise；防并发） */
function startDailyCollect(force) {
  if (_collectInFlight) return _collectInFlight;
  const py = findPython();
  if (!py) {
    _lastCollectFinishAt = Date.now();
    return Promise.resolve({ ok: false, error: '未找到可用 Python 解释器（akshare 环境）' });
  }
  const script = path.join(__dirname, '..', '..', 'scripts', 'hot_topics_collect.py');
  const args = [script, '--date', _today()];
  if (force) args.push('--force');
  _collectStartedAt = Date.now();
  _collectInFlight = execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
    windowsHide: true,
    cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
  }).then(
    (r) => ({ ok: true, stdout: (r.stdout || '').slice(-400) }),
    (e) => ({ ok: false, error: String(e && e.message || e).slice(0, 300) })
  ).finally(() => {
    _lastCollectFinishAt = Date.now();
    _collectInFlight = null;
  });
  return _collectInFlight;
}

/** 采集进行中？ */
function isCollecting() { return !!_collectInFlight; }

/**
 * 周榜主入口。
 * @param {boolean} force 前端「刷新」按钮触发
 */
async function getWeeklyReport(force) {
  const cfg = loadConfig(DATA_DIR);
  const map = _readJson(path.join(DATA_DIR, 'sector_map.json'));
  if (!map || !Array.isArray(map.boards) || !map.boards.length) {
    return { ok: false, status: 'error', message: '板块映射表缺失（data/hotTopics/sector_map.json）' };
  }

  const today = _today();
  const now = new Date();
  const weekKey = isoWeekKey(now);
  const dates = weekDatesUntilToday(now);
  const todayPath = _dailyPath(today);
  const todayData = _readJson(todayPath);

  // 今日数据缺失 → 触发后台采集，立即返回「采集中」
  if (!todayData) {
    const collecting = isCollecting();
    if (!collecting) startDailyCollect(false);
    return {
      ok: false, status: 'collecting', weekKey,
      message: '本周板块舆情数据采集中（首次约 4-5 分钟：92 板块 × 双社区源限速抓取），页面将自动重试。',
      completeness: { collectedDays: 0, expectedDays: dates.length, dates },
      collecting: true,
    };
  }

  // refresh=1 且今日文件已过期（超过 staleMinutes）→ 后台重采，同时用现有数据先算一版
  let reCollecting = false;
  if (force) {
    const staleMs = (cfg.collect?.staleMinutes ?? 30) * 60 * 1000;
    const age = Date.now() - (fs.statSync(todayPath).mtimeMs || 0);
    if (age > staleMs && !isCollecting() && Date.now() - _lastCollectFinishAt > 60 * 1000) {
      startDailyCollect(true);
      reCollecting = true;
    }
  }

  // 读取本周已有每日文件（升序）
  const dailies = [];
  for (const d of dates) {
    const data = _readJson(_dailyPath(d));
    if (data) dailies.push({ date: d, data });
  }
  if (!dailies.length) {
    return { ok: false, status: 'collecting', weekKey, collecting: true, message: '本周数据文件尚未生成，稍后自动重试。' };
  }

  const result = computeWeekly(map.boards, dailies, cfg);
  if (!result.ok) {
    return {
      ok: false, status: 'empty', weekKey,
      message: '本周暂无可统计的舆情/讨论数据（采集可能受限，稍后自动重试）。',
      completeness: { collectedDays: dailies.length, expectedDays: dates.length, dates },
    };
  }

  // 完整度与来源状态
  const last = dailies[dailies.length - 1].data;
  const summary = last.summary || {};
  const completeness = {
    collectedDays: dailies.length, expectedDays: dates.length, dates: dailies.map(d => d.date),
    status: dailies.length >= 5 ? '本周数据完整' : (dailies.length >= 3 ? '数据累积中（可用）' : '数据累积中（仅供参考）'),
  };
  const sources = {
    news: summary.news || (last.news && last.news.status) || 'unknown',
    // 社区讨论·主源：同花顺讨论 API
    guba: summary.guba || (last.guba && last.guba.status) || 'unknown',
    // 社区讨论·补充源：东方财富股吧板块吧（20260913h）
    gubaEm: summary.gubaEm || (last.gubaEm && last.gubaEm.status) || 'unknown',
    market: summary.market || (last.market && last.market.status) || 'unknown',
    gubaBoards: `${summary.gubaOk ?? last.guba?.okCount ?? 0}/${summary.gubaTotal ?? last.guba?.mapCount ?? map.boards.length}`,
    gubaEmBoards: `${summary.gubaEmOk ?? last.gubaEm?.okCount ?? 0}/${summary.gubaEmTotal ?? last.gubaEm?.mapCount ?? map.boards.length}`,
    // 合并口径：任一社区源可用即 ok
    community: (summary.guba === 'ok' || summary.gubaEm === 'ok') ? 'ok' : 'degraded',
  };

  const report = {
    ok: true,
    status: reCollecting ? 'refreshing' : 'ok',
    weekKey,
    updated: last.fetchedAt || new Date().toISOString(),
    date: today,
    completeness, sources,
    meta: result.meta,
    rows: result.rows.slice(0, cfg.topN || 10),
    rowsTotal: result.rows.length,
    footnotes: buildFootnotes(cfg, result.meta, sources),
  };

  // 周榜存档（审计/回看）
  _writeJsonAtomic(path.join(WEEKLY_DIR, weekKey + '.json'), Object.assign({}, report, { rows: result.rows }));

  // refresh 时后台采集完成后无需额外动作：下次请求自然读到新文件
  if (reCollecting && _collectInFlight) {
    _collectInFlight.catch(() => {});
  }
  return report;
}

function buildFootnotes(cfg, meta, sources) {
  const notes = [
    '热度≠涨跌预测：本榜只反映舆情与社区讨论热度，不构成买卖建议。',
    'NLP 词典法存在固有误差（情绪/韭菜识别为规则近似），仅供参考。',
    `指标口径：A=归属快讯条数（代理曝光量）；B=社区讨论帖数增量+采样帖浏览评论和（量级项统一取同花顺讨论 API，避免与东财股吧「真·浏览量」混算）；C=韭菜句式帖数；D=舆情看多%；E=社区看多%（社区帖取自东方财富股吧 + 同花顺讨论 API 合并去重）。`,
    '右侧「综合分」（0~100）= A 舆情曝光 / B 社区讨论 / D 舆情情感 / E 社区情感 四指标加权合成；C 韭菜讨论只参与「⚠️ 韭菜蜂拥」告警、不计入综合分。综合分下方的 5 日涨跌幅与资金净额占比仅作交叉参考——热度高不代表看涨。',
    '快讯源（决定 A 的条数基数）：新浪财经 7×24 · 同花顺全球财经快讯 · 华尔街见闻 7×24 · 财联社电报（后两源 20260923 新增，走独立域名、互为备份，可经 data/hotTopics/config.json 的 news 节单独开关）。',
  ];
  if (meta.degradeMode) {
    notes.push('⚠️ 降级模式：两个社区讨论通道（东方财富股吧 + 同花顺讨论 API）当日均无数据，B/E 指标缺失，权重已重分配为 A×0.8+D×0.2。');
  }
  if (sources.news && sources.news !== 'ok') {
    notes.push(`⚠️ 舆情快讯通道当日状态：${sources.news}。若为空，A（曝光）对全部板块等值、不产生区分度，请以 B/C/D/E 为主解读。`);
  }
  if ((sources.guba && sources.guba !== 'ok') || (sources.gubaEm && sources.gubaEm !== 'ok')) {
    notes.push(`社区讨论当日状态：东方财富股吧 ${sources.gubaEm}（${sources.gubaEmBoards} 板块成功）· 同花顺讨论 ${sources.guba}（${sources.gubaBoards} 板块成功）；东财受反爬风控时会在熔断后保留已抓板块，未覆盖板块自动由同花顺兜底。`);
  }
  return notes;
}

module.exports = { getWeeklyReport, startDailyCollect, isCollecting };

~~~

---

## `lib\hotTopicsWeekly\nlp.js`  ·  149 行

~~~js
/**
 * 板块舆情热度周榜 · NLP 词典与文本归属（20260909m）
 * --------------------------------------------------------------
 * 代码权威铁律：所有情绪判定 / 韭菜识别 / 板块归属全部由本模块的确定性规则完成，
 * LLM 不参与任何计算（仅 UI 文案可能用到 AI 叙事，且本模块默认不调用 LLM）。
 *
 * 口径声明（诚实降级）：
 * - 情绪识别 = 看多/看空规则词典 + 否定词窗口翻转，存在词典法固有误差（页面有免责标注）；
 * - 韭菜识别 = 新手提问/跟风句式词典近似（无法获取发帖人历史），属口径降级；
 * - 登录墙平台（抖音/快手/小红书/公众号/知乎等）不采集，见 README。
 */
'use strict';

// ---------- 文本归一化 ----------
function normalizeText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/\s+/g, '')
    .replace(/[【】\[\]（）()《》<>「」]/g, '');
}

// ---------- 垃圾帖/广告过滤 ----------
const SPAM_RE = /(广告|推广|开户|福利|直播间|牛股群|加微信|加v|vx|免费领|荐股|带单|私募合作|点击链接|速来领取)/;
function isSpam(text) {
  const t = String(text == null ? '' : text).trim();
  if (t.length < 5) return true; // 过短无信息量
  if (SPAM_RE.test(t.toLowerCase())) return true;
  if (/^\d+$/.test(t)) return true; // 纯数字
  return false;
}

// ---------- 情绪识别（看多/看空 + 否定词翻转） ----------
const NEGATION = ['不', '没', '无', '别', '未', '难', '非', '莫', '勿', '难以', '并非', '并没有', '不能', '不会'];
const BULL_TERMS = ['看多', '看涨', '利好', '大涨', '涨停', '反弹', '突破', '拉升', '起爆', '起飞', '走强',
  '加仓', '买入', '抄底', '上车', '主线', '龙头', '机会', '稳了', '新高', '走牛', '放量上攻', '资金流入',
  '景气上行', '业绩超预期', '供不应求', '涨价'];
const BEAR_TERMS = ['看空', '看跌', '利空', '大跌', '跌停', '破位', '下杀', '崩', '走弱', '减仓', '卖出',
  '见顶', '崩盘', '暴雷', '套牢', '割肉', '腰斩', '诱多', '出货', '资金流出', '景气下行', '业绩不及预期',
  '产能过剩', '跌跌不休', '杀跌', '走熊'];

/**
 * 情感分类：扫描词典词 + 否定词窗口（词前 3 字符内出现否定词则翻转方向）。
 * 得分 = 多 - 空；>0 看多 / <0 看空 / =0 中性。
 * @returns {'bullish'|'bearish'|'neutral'}
 */
function classifySentiment(text) {
  const t = normalizeText(text);
  if (!t) return 'neutral';
  let bull = 0, bear = 0;
  const scan = (terms, isBull) => {
    for (const term of terms) {
      const tt = normalizeText(term);
      let idx = t.indexOf(tt);
      while (idx >= 0) {
        const win = t.slice(Math.max(0, idx - 3), idx);
        const negated = NEGATION.some(n => win.includes(normalizeText(n)));
        if (!negated) { if (isBull) bull++; else bear++; }
        else { if (isBull) bear++; else bull++; }
        idx = t.indexOf(tt, idx + tt.length);
      }
    }
  };
  scan(BULL_TERMS, true);
  scan(BEAR_TERMS, false);
  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

// ---------- 韭菜（新手/跟风）识别 —— 句式词典近似 ----------
const ROOKIE_STRONG = ['新手', '小白', '刚入市', '刚开户', '求教', '请教', '求指点', '该买什么', '买什么好',
  '能买吗', '还能追吗', '还能上车吗', '梭哈', '满仓干', '全仓买', '老师带带我', '大佬们', '大神们',
  '被套了', '被套住', '回本', '割肉吗', '要不要跑', '还有救吗', '怎么操作', '怎么办'];
const ROOKIE_WEAK = ['吗', '？', '?', '什么', '怎么', '如何', '为啥', '为什么', '什么意思', '懂的说说', '有没有人'];
/** 韭菜判定：强词 ≥1，或弱词 ≥2。确定性规则，无 AI。 */
function isRookiePost(text) {
  const t = normalizeText(text);
  if (!t) return false;
  let strong = 0, weak = 0;
  for (const w of ROOKIE_STRONG) if (t.includes(normalizeText(w))) strong++;
  for (const w of ROOKIE_WEAK) {
    const ww = normalizeText(w);
    let idx = t.indexOf(ww), cnt = 0;
    while (idx >= 0) { cnt++; idx = t.indexOf(ww, idx + ww.length); }
    weak += cnt;
  }
  return strong >= 1 || weak >= 2;
}

// ---------- 板块归属 ----------
/**
 * 构建文本→板块匹配器。
 * @param {Array<{code,name,aliases,keywords}>} boards sector_map.boards
 * @param {Map<string,string[]>} leadingStocks 板块名(归一化) → [主力净流入最大股]
 * @returns {{attribute:(text:string)=>string[]}}
 */
function buildMatcher(boards, leadingStocks) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const entries = []; // {code, word, prio, wlen}
  for (const b of boards) {
    const baseAlias = String(b.name || '').replace(/[ⅠⅡⅢIV]+$/g, '').trim();
    const words = [
      { w: norm(b.name), prio: 3 },
      { w: norm(baseAlias), prio: 2 },
      ...(b.aliases || []).map(a => ({ w: norm(a), prio: 2 })),
      ...(b.keywords || []).map(k => ({ w: norm(k), prio: 1 })),
    ].filter(x => x.w && x.w.length >= 2);
    const seen = new Set();
    for (const x of words) {
      if (seen.has(x.w)) continue;
      seen.add(x.w);
      entries.push({ code: b.code, word: x.w, prio: x.prio, wlen: x.w.length });
    }
  }
  // 主导股名 → 板块（长度优先，避免子串误配）
  if (leadingStocks) {
    for (const [boardName, stocks] of leadingStocks.entries()) {
      const board = boards.find(b => norm(b.name) === norm(boardName) ||
        norm(String(b.name || '').replace(/[ⅠⅡⅢIV]+$/g, '')) === norm(boardName));
      if (!board) continue;
      for (const s of (stocks || [])) {
        const w = norm(s);
        if (w && w.length >= 2) entries.push({ code: board.code, word: w, prio: 2, wlen: w.length });
      }
    }
  }
  // 长词优先匹配，避免「电力」抢先吃掉「电网设备」类文本
  entries.sort((a, b2) => b2.wlen - a.wlen || b2.prio - a.prio);

  function attribute(text) {
    const t = norm(text);
    if (!t) return [];
    const hits = new Map(); // code -> best prio
    for (const e of entries) {
      if (t.indexOf(e.word) < 0) continue;
      const cur = hits.get(e.code) || 0;
      if (e.prio > cur) hits.set(e.code, e.prio);
      if (hits.size >= 6) break; // 粗筛上限
    }
    const arr = [...hits.entries()];
    arr.sort((a, b2) => b2[1] - a[1]);
    return arr.slice(0, 3).map(x => x[0]); // 每条文本最多归属 3 个板块
  }
  return { attribute };
}

module.exports = { normalizeText, isSpam, classifySentiment, isRookiePost, buildMatcher };

~~~

---

## `lib\indexConstituents.js`  ·  198 行

~~~js
/**
 * 主要指数成分股数据（用于按个股所属市场筛相关指数，修复此前"按市场一刀切"bug）
 * ------------------------------------------------------------
 * 上证50 成分股（50只，CSI 官方 2025-04 调整版）
 * 沪深300 成分股（300只）：实时从 Sina Market_Center API 拉取（hs300 节点，分页）
 * 创业板指 成分股（100只）：实时从 Sina Market_Center API 拉取（cyb 节点）
 *
 * 数据来源：
 *   - 上证50：中证指数有限公司 CSI 官方 2025-04-18 调整名单
 *   - 沪深300 / 创业板指：新浪财经 Market_Center API（每日变动小，磁盘缓存 24h）
 *
 * 缓存策略：沪深300/创业板指 进程内 5 分钟 + 磁盘 24h。冷启动时优先读磁盘，
 *          磁盘失效再走 Sina，Sina 失败则降级为空集并打 warn。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 上证50 官方成分股（上交所 2026-06-15 发布版，50 只；2026-06-12 调整后生效）
// 来源：https://www.sse.com.cn/market/sseindex/indexlist/basic/index.shtml?COMPANY_CODE=000016
// 注：本数据每半年（6月/12月）调整一次，建议下次调整时同步更新本数组。
//  2026-06 调入：特变电工/生益科技/中国铝业/华泰证券/兆易创新；
//  2026-06 调出：上汽集团/海尔智家/陕西煤业/京沪高铁/中国核电；
//  海天味业(603288) 已不在名单（2025-12 调整时调出后未再调入）。
const SSE50_CONSTITUENTS = [
  '600028', '600030', '600031', '600036', '600050', '600089', '600111', '600150',
  '600183', '600276', '600309', '600406', '600519', '600760', '600809', '600887',
  '600900', '600930', '601012', '601088', '601127', '601166', '601211', '601288',
  '601318', '601328', '601398', '601600', '601601', '601628', '601658', '601668',
  '601688', '601728', '601857', '601888', '601899', '601919', '601988', '603019',
  '603259', '603501', '603986', '603993', '688008', '688012', '688041', '688111',
  '688256', '688981',
];
// 注：600460 士兰微不在名单；上证50 ⊂ 沪深300，沪深300 包含士兰微。

// ===== Sina 沪深300 / 创业板指 缓存（进程内 + 磁盘）=====
const CACHE_DIR = path.join(__dirname, '..', 'data', 'index_cache');
const INMEM_TTL = 5 * 60 * 1000; // 5 分钟
const DISK_TTL = 24 * 60 * 60 * 1000; // 24 小时

const _inmem = new Map(); // key -> { ts, data }

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function readDisk(key) {
  try {
    const p = path.join(CACHE_DIR, key + '.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - (j.ts || 0) > DISK_TTL) return null;
    return j.data;
  } catch (e) { return null; }
}

function writeDisk(key, data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { /* 磁盘写失败不影响运行 */ }
}

async function fetchSinaNodeAll(node, total) {
  // Sina Market_Center API 分页：每页最多 100 只，按 num=100 拉多次
  const pages = Math.ceil(total / 100);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?num=100&page=${p}&node=${node}&sort=mktcap&asc=0`;
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': UA, Referer: 'https://vip.stock.finance.sina.com.cn/' },
        timeout: 10000,
      });
      const rows = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) || [];
      for (const x of rows) {
        if (x && x.code) all.push(String(x.code));
      }
    } catch (e) {
      console.warn(`[IndexConstituents] Sina ${node} page ${p} fetch failed:`, e.message);
    }
  }
  return Array.from(new Set(all)); // 去重
}

async function getHs300() {
  const key = 'hs300';
  const cached = _inmem.get(key);
  if (cached && Date.now() - cached.ts < INMEM_TTL) return cached.data;
  let data = readDisk(key);
  if (!data) {
    data = await fetchSinaNodeAll('hs300', 300);
    if (data && data.length) writeDisk(key, data);
  }
  if (data && data.length) _inmem.set(key, { ts: Date.now(), data });
  return data || [];
}

async function getCyb() {
  const key = 'cyb';
  const cached = _inmem.get(key);
  if (cached && Date.now() - cached.ts < INMEM_TTL) return cached.data;
  let data = readDisk(key);
  if (!data) {
    data = await fetchSinaNodeAll('cyb', 100);
    if (data && data.length) writeDisk(key, data);
  }
  if (data && data.length) _inmem.set(key, { ts: Date.now(), data });
  return data || [];
}

/**
 * 查个股是否在某指数成分内。
 * @param {string} symbol 6 位股票代码（不含交易所前缀）
 * @param {'sse50'|'hs300'|'cyb'} index
 * @returns {Promise<boolean>}
 */
async function isMemberOf(symbol, index) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
  if (!code) return false;
  if (index === 'sse50') return SSE50_CONSTITUENTS.includes(code);
  if (index === 'hs300') {
    const set = await getHs300();
    return set.includes(code);
  }
  if (index === 'cyb') {
    const set = await getCyb();
    return set.includes(code);
  }
  return false;
}

/**
 * 一次性把个股所属市场的相关指数筛出来（含上交所/深交所/创业板映射 + 真实成分判定）。
 * 取代此前 "沪市 → 上证+上证50+沪深300" 一刀切的逻辑。
 *
 * @param {string} symbol
 * @param {string} cnIndexCodeList 腾讯行情接口返回的 cn 指数数组（每项含 code/name）
 * @returns {Promise<{indices: Array, scopeLabel: string, marketLabel: string}>}
 */
async function pickIndicesForStock(symbol, cnArr) {
  const all = (cnArr || []).filter(c => c && typeof c.changePct === 'number');
  if (!all.length) return { indices: [], scopeLabel: '—', marketLabel: '' };
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
  // 检测交易所：6/9 开头 → SH；0/3 开头 → SZ
  const isSH = /^[69]/.test(code);
  const isSZ = /^[03]/.test(code);
  const isCyb = /^3/.test(code); // 创业板仅 30xxxx/301xxx

  // 20260905e：建两个 map（code→item 和 name→item），wantNames 是名称（与 cn[i].name 对齐），
  // 所以用 name 做 key 查找，否则会全部 miss 退回全宽基。
  const codeMap = new Map(all.map(c => [String(c.code || ''), c]));
  const nameMap = new Map(all.map(c => [String(c.name || ''), c]));
  const wantNames = []; // 指数名（与 cn[i].name 对齐）

  if (isSH) {
    // 上证指数：所有沪市股都属于（上证指数是全沪市加权指数）
    wantNames.push('上证指数');
    // 上证50：仅在官方 50 只名单内才引用
    if (await isMemberOf(code, 'sse50')) wantNames.push('上证50');
    // 沪深300：仅在 300 只名单内才引用
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else if (isSZ) {
    // 深证成指：所有深市主板/创业板股都引用（深证成指涵盖深市主板+中小板）
    wantNames.push('深证成指');
    // 创业板指：仅创业板股 + 在 100 只名单内才引用
    if (isCyb && await isMemberOf(code, 'cyb')) wantNames.push('创业板指');
    // 沪深300：仅在 300 只名单内才引用
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else {
    // 非 A 股：兜底全宽基
    return {
      indices: all,
      scopeLabel: '上证/深成指/创业板/沪深300/上证50/中证500/科创50（个股非 A 股，退回全宽基）',
      marketLabel: 'OTHER',
    };
  }

  const picked = wantNames.map(n => nameMap.get(n)).filter(Boolean);
  const scopeLabel = wantNames.join('/');
  if (!picked.length) {
    return { indices: all, scopeLabel: scopeLabel + '（个别指数缺失，已回退）', marketLabel: isSH ? 'SH' : 'SZ' };
  }
  return { indices: picked, scopeLabel, marketLabel: isSH ? 'SH' : 'SZ' };
}

module.exports = {
  SSE50_CONSTITUENTS,
  pickIndicesForStock,
  isMemberOf,
  // 暴露给上层按 name 过滤长期指数（longTerm 的 indices 数组只有 name + chg60d）
  isSHCode: (s) => /^[69]/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isSZCode: (s) => /^[03]/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isCybCode: (s) => /^3/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isSse50: (s) => SSE50_CONSTITUENTS.includes(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
};
~~~

---

## `lib\indexPETrend.js`  ·  209 行

~~~js
/**
 * 大盘估值趋势：上证50 / 沪深300 / 科创50 近5年市盈率(TTM)趋势
 * -------------------------------------------------------------
 * 数据源：
 * - 上证50、沪深300：乐咕乐股(legulegu.com) 月度滚动市盈率(TTM)
 * - 科创50：东方财富·市场估值 (RPT_VALUEMARKET) 日频平均市盈率(TTM)，按月采样
 *
 * 注意：不同指数/不同数据源在口径上存在天然差异。
 * 上证50/沪深300为指数成份股加权PE；科创50为东方财富“科创板50”板块的平均PE，
 * 因此与指数详情页中显示的加权PE数值不完全一致，仅用于观察趋势与相对位置。
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const { decorateRules } = require('./ruleCore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'index-pe-trend.json');
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// allowStale=true 时允许返回已过期缓存（调用方须以 stale 标注诚实展示）；
// 修复 20261016 审计发现：旧实现对过期缓存一律返回 null，导致 getIndexPETrend catch 分支的
// 「取数失败回退缓存」是死代码——抓取失败时永远直接落到 success:false 空数据。
function readCache(allowStale = false) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.updatedAt) return null;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > CACHE_TTL) return allowStale ? Object.assign({}, parsed, { __stale: true }) : null;
    return parsed;
  } catch (e) {
    console.error('[IndexPETrend] cache read error:', e.message);
    return null;
  }
}

function writeCache(payload) {
  try {
    ensureDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('[IndexPETrend] cache write error:', e.message);
  }
}

async function findPythonForScript() {
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000, windowsHide: true });
      return c;
    } catch (e) {
      // try next
    }
  }
  return null;
}

async function fetchFromScript() {
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到可用的 Python 解释器');
  const script = path.join(__dirname, '..', 'scripts', 'index_pe_trend.py');
  if (!fs.existsSync(script)) throw new Error('脚本不存在: ' + script);

  const { stdout, stderr } = await execFileAsync(py, [script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (stderr) console.error('[IndexPETrend] python stderr:', stderr.slice(0, 500));

  const parsed = JSON.parse(stdout);
  if (!parsed || !parsed.success) {
    throw new Error(parsed && parsed.error ? parsed.error : '脚本返回失败');
  }
  return parsed;
}

function emptyFallback(name) {
  return {
    name,
    source: '—',
    peField: '—',
    series: [],
    latest: null,
    quantile: null,
  };
}

function calcQuantile(pe, series) {
  // 计算当前PE在近5年序列中的历史百分位
  if (!series || !series.length || pe == null || !isFinite(pe)) return null;
  const pes = series.map(d => d.pe).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!pes.length) return null;
  let lower = 0;
  for (const v of pes) if (v < pe) lower++;
  const same = pes.filter(v => v === pe).length;
  const rank = lower + same / 2;
  return Math.round((rank / pes.length) * 100);
}

async function getIndexPETrend({ force = false } = {}) {
  let raw = null;
  let fromCache = false;
  let staleFallback = false;

  if (!force) {
    const cached = readCache();
    if (cached) {
      raw = cached;
      fromCache = true;
    }
  }

  if (!raw) {
    try {
      raw = await fetchFromScript();
      writeCache(raw);
    } catch (e) {
      console.error('[IndexPETrend] fetch failed:', e.message);
      // 20261016 修复：允许过期缓存兜底（原死代码），并剥离内部 __stale 标记、以顶层 stale 诚实标注
      const cached = readCache(true);
      if (cached) {
        const { __stale, ...rawC } = cached;
        raw = rawC;
        fromCache = true;
        staleFallback = true;
      } else {
        return {
          success: false,
          error: e.message,
          data: {
            '上证50': emptyFallback('上证50'),
            '沪深300': emptyFallback('沪深300'),
            '科创50': emptyFallback('科创50'),
          },
        };
      }
    }
  }

  const result = {};
  // 20261105b：新增中证1000（乐咕乐股，与上证50/沪深300 同源同口径）；四指数对称
  const names = ['上证50', '沪深300', '中证1000', '科创50'];
  for (const name of names) {
    const item = (raw.data && raw.data[name]) || { series: [] };
    const series = (item.series || []).map(d => ({
      date: d.date,
      pe: d.pe != null ? +d.pe.toFixed(2) : null,
      close: d.close != null ? +d.close.toFixed(2) : null,
    })).filter(d => d.pe != null && isFinite(d.pe));
    // 20261105b：全历史月度序列（脚本新增 seriesAll 输出），计算「历史百分位」（东方财富估值页全部历史口径）
    // seriesAll 缺失（旧缓存）时回退近5年序列计算
    const seriesAll = (item.seriesAll || item.series || []).map(d => ({
      date: d.date,
      pe: d.pe != null ? +d.pe.toFixed(2) : null,
    })).filter(d => d.pe != null && isFinite(d.pe));
    const latest = series.length ? series[series.length - 1] : null;
    result[name] = {
      name,
      source: item.source || '—',
      peField: item.peField || '市盈率(TTM)',
      series,
      latest,
      // 20261105b（用户指令：停止「近5年新高」标注，改用历史百分位）：quantileAll = 最新 PE 在
      // 全历史月度序列中的百分位；seriesAll 缺失时如实回退近5年 quantile
      quantileAll: latest ? (calcQuantile(latest.pe, seriesAll) != null ? calcQuantile(latest.pe, seriesAll) : calcQuantile(latest.pe, series)) : null,
      quantile: latest ? calcQuantile(latest.pe, series) : null,
      // 三规则铺开：时效（日频）+ PE 的变化与边际
      rules: decorateRules({
        dataTime: latest ? latest.date : null,
        source: item.source || '—',
        kind: 'daily',
        series: series.map(d => ({ date: d.date, value: d.pe })),
        name: `${name} PE(TTM)`,
      }),
    };
  }

  return {
    success: true,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    cached: fromCache,
    stale: staleFallback,
    staleNote: staleFallback
      ? `⚠️ 实时数据源暂不可达，当前展示 ${raw.updatedAt ? new Date(raw.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '较早'} 的缓存数据，待数据源恢复后自动更新。`
      : '',
    note: '上证50/沪深300/中证1000为指数加权滚动PE；科创50为东方财富“科创板50”板块平均滚动PE。历史百分位基于全部历史数据得出。不同口径不可直接比较数值，仅用于趋势观察。',
    data: result,
  };
}

module.exports = { getIndexPETrend, calcQuantile };

~~~

---

## `lib\industryAnalysis.js`  ·  198 行

~~~js
/**
 * Industry Analysis Module（行业分析）
 * 为「深度分析」之后的独立「行业分析」页提供数据：
 *   1. 期货指数分析（仅当公司产品与期货相关，复用 fetchFuturesCorrelation）
 *   2. 行业归属 + 国家发展规划政策前景（内置 INDUSTRY_POLICY 映射）
 *   3. 行业板块（分析师研报情绪：评级分布 / 月度趋势 / 目标价）
 *   4. 行业分析师研究报告列表（东方财富行业研报 qType=1）
 *
 * 所有外部接口均做 try/catch + withTimeout 兜底，任何异常只降级不抛错，
 * 保证页面不会整片空白。
 */
const axios = require('axios');
const { fetchFuturesCorrelation } = require('./futuresData');
const { resolveSectorIdentity, getSectorKeywords, INDUSTRY_BY_CODE } = require('./sectorIdentity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 通用工具 ----
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- 行业政策扶持映射（内置重点行业）----
// level: 扶持级别；plans: 国家发展规划相关条目；summary: 前景分析
const INDUSTRY_POLICY = [
  { keys: ['半导体', '芯片', '集成电路', 'EDA', '光刻'], level: '国家战略扶持', plans: ['《十四五规划纲要》：集成电路被列为科技前沿攻关首位', '国家集成电路产业投资基金（大基金）一/二期持续注资', '"强链补链"自主可控政策'], summary: '半导体国产化是科技自立与产业链安全的战略核心，政策与资金长期倾斜，国产替代空间巨大；但技术壁垒高、研发周期长，需甄别真正具备突破能力的环节。' },
  { keys: ['人工智能', 'AI', '算力', '大模型', '数据中心', '光模块'], level: '国家战略扶持', plans: ['"人工智能+"行动（2024）', '算力基础设施高质量发展行动计划', '新质生产力核心方向'], summary: 'AI 与算力被定位为新质生产力的核心引擎，政策与资本高度关注，处于高速成长期；但估值波动大、技术迭代快，需关注业绩兑现节奏。' },
  { keys: ['新能源', '光伏', '风电', '储能', '锂电', '电池'], level: '国家战略扶持', plans: ['"双碳"目标（2030 碳达峰 / 2060 碳中和）', '新能源汽车产业发展规划(2021-2035)', '新型储能装机目标'], summary: '双碳战略下新能源长期向上，但阶段性产能过剩与价格战压制盈利，需密切关注供需节奏与技术路线变化。' },
  { keys: ['新能源汽车', '汽车', '整车'], level: '国家战略扶持', plans: ['新能源汽车产业发展规划(2021-2035)', '汽车以旧换新补贴政策', '智能网联汽车准入与上路试点'], summary: '新能源车渗透率持续提升，政策支持与出口亮眼；但价格竞争激烈、盈利分化，智能化成为新一轮竞争焦点。' },
  { keys: ['创新药', '医药', '生物', '疫苗', 'CXO', '医疗器械', '制药'], level: '战略扶持（审慎）', plans: ['"十四五"生物医药产业发展规划', '创新药医保谈判与提速审批', '科创板第五套标准 / 港股 18A 支持未盈利生物科技'], summary: '创新药与医疗器械受政策鼓励，但集采与医保控费持续压制利润；研发风险高、周期长，需甄别管线质量与商业化能力。' },
  { keys: ['白酒', '酿酒', '食品饮料', '消费'], level: '中性（顺周期）', plans: ['扩大内需战略', '促消费政策（以旧换新外溢拉动）'], summary: '消费是扩大内需主力，白酒等具备强品牌护城河与充沛现金流；但受经济顺周期与消费意愿影响，高端化红利边际放缓。' },
  { keys: ['军工', '航天', '航空', '国防', '卫星'], level: '国家战略扶持', plans: ['国防和军队现代化（2027 / 2035 节点）', '军民融合深度发展', '装备放量列装'], summary: '军工受国防预算稳步增长与装备升级驱动，订单确定性强、逆周期属性突出；但信息不透明、估值往往偏高。' },
  { keys: ['银行', '保险', '证券', '金融', '期货'], level: '中性（强监管）', plans: ['金融供给侧结构性改革', '服务实体经济、防范化解风险'], summary: '金融业以服务实体与防风险为主线，低估值高股息具防御属性；但让利实体与地产风险压制盈利弹性。' },
  { keys: ['房地产', '地产'], level: '受限（托底）', plans: ['"房住不炒"基调', '因城施策托底（保交楼 / 限购优化）'], summary: '房地产处于去杠杆与转型期，政策以"托底防风险"为主，行业出清尚未完成，投资需极度审慎。' },
  { keys: ['煤炭', '钢铁', '有色', '化工', '石油', '石化', '电力', '能源'], level: '中性（周期）', plans: ['能源安全新战略', '煤炭清洁高效利用', '新型电力系统建设'], summary: '传统能源与周期品受供需与价格周期主导，高股息具配置价值；但长期面临新能源替代与碳约束。' },
  { keys: ['通信', '5G', '算力网络'], level: '国家战略扶持', plans: ['"双千兆"网络发展行动', '东数西算工程', '6G 前瞻布局'], summary: '通信基础设施承上启下，受益于数字中国与算力网络建设；运营商稳健，设备商看技术迭代节奏。' },
  { keys: ['计算机', '软件', '信创', '工业软件'], level: '国家战略扶持', plans: ['信创国产化替代', '"软件定义"与工业软件攻关'], summary: '信创与工业软件国产化空间广阔，政策驱动党政及行业替换；但短期业绩兑现与生态建设是关键。' },
  { keys: ['家电', '机械', '工程机械'], level: '中性（出海）', plans: ['家电以旧换新补贴', '设备更新改造政策'], summary: '家电与机械受益于以旧换新与设备更新，龙头出海打开第二曲线；但受地产与海外需求扰动。' },
  { keys: ['农业', '种业', '养殖', '化肥', '农化'], level: '战略扶持', plans: ['粮食安全党政同责', '种业振兴行动', '高标准农田建设'], summary: '农业关乎粮食安全，种业振兴与高标准农田受政策倾斜；但周期性强（猪周期 / 粮价），盈利波动大。' },
  { keys: ['环保', '水务', '绿化', '生态'], level: '战略扶持', plans: ['污染防治攻坚战', '碳达峰碳中和', 'EOD 模式'], summary: '环保受政策驱动但依赖政府付费，回款与订单节奏是主要矛盾，估值弹性有限。' },
  { keys: ['传媒', '游戏', '影视', '互联网'], level: '中性（监管）', plans: ['文化数字化战略', '游戏版号常态化'], summary: '传媒互联网受内容监管与消费景气影响；游戏版号常态化修复供给，但政策与流量红利见顶并存。' },
  { keys: ['建材', '水泥', '玻璃'], level: '中性（周期）', plans: ['基建稳增长', '产能置换与错峰生产'], summary: '建材与基建 / 地产强相关，需求承压下以成本与份额竞争为主，关注基建端边际改善。' },
  { keys: ['物流', '快递', '交运'], level: '中性', plans: ['现代物流体系规划', '全国统一大市场'], summary: '物流受益于统一大市场与电商渗透，价格战趋缓后盈利修复；但同质化竞争仍在。' },
  { keys: ['电力设备', '电网', '特高压'], level: '国家战略扶持', plans: ['新型电力系统建设', '特高压 / 配电网投资加速'], summary: '电力设备受益于新型电力系统与电网投资上行，结构机会突出；但需关注招标价格与交付节奏。' },
];

function getPolicySupport(industryName, induName) {
  const text = `${industryName || ''} ${induName || ''}`;
  // 最长（最具体）关键词优先匹配（20261016b 修复 IA1/IA2）。
  // 旧实现为「按数组顺序遍历 + 第一命中即返回」，导致：
  //   「电力设备」被第 42 行的「电力」抢先 → 错落「中性（周期）」，拿不到「国家战略扶持」；
  //   「新能源汽车」被第 35 行的「新能源」抢先（评级同、summary 口径偏）。
  // 现改为全表扫描取「最长命中键」；等长时保留原数组顺序（先用者胜）。
  // 返回结构与旧版完全一致（matched/level/plans/summary），下游无需适配。
  let best = null;
  INDUSTRY_POLICY.forEach((item, idx) => {
    item.keys.forEach((k) => {
      if (text.includes(k) && (!best || k.length > best.len)) {
        best = { len: k.length, idx };
      }
    });
  });
  if (best) {
    const item = INDUSTRY_POLICY[best.idx];
    return { matched: true, level: item.level, plans: item.plans, summary: item.summary };
  }
  return {
    matched: false,
    level: '中性（需结合具体政策判断）',
    plans: ['行业具体扶持 / 限制政策需结合最新国家发展规划与部委文件判断。'],
    summary: `「${industryName || induName || '该行业'}」暂未纳入内置重点行业政策库，建议结合最新"十四五"规划、政府工作报告及行业主管部门文件综合判断其政策定位与发展前景。`,
  };
}

// 为了向后兼容，复用 sectorIdentity 的覆盖表与校正函数
const INDUSTRY_NAME_OVERRIDE = INDUSTRY_BY_CODE;
function correctIndustryName(symbol, name, rawName) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
  if (INDUSTRY_BY_CODE[code]) return INDUSTRY_BY_CODE[code];
  return rawName;
}

// ---- 行业归属（申万/证监会行业 + 东方财富行业研报分类码）----
// 20260821c：委托 sectorIdentity 做统一、确定性的个股行业解析，
// 本模块只负责补齐研报列表等附加信息。
async function fetchIndustryInfo(symbol, name) {
  const identity = await resolveSectorIdentity(symbol, name);
  return {
    name: identity.industry || '未知',
    csrc: identity.f10Name || '',
    induCode: identity.induCode || '',
    // 东方财富行业分类：优先用东方财富精确分类（如海天味业=调味发酵品2），其次研报/F10/归一化兜底
    induName: identity.emIndustry || identity.reportName || identity.f10Name || identity.industry || '',
    // 同花顺 K 线专用板块（命中覆盖表时填充，前端用于拉取行业指数 K 线）
    boardName: identity.boardName || '',
  };
}

// ---- 公司研报（针对本公司的研报，东方财富个股研报 qType=0）----
async function fetchCompanyReports(symbol) {
  const code = normSymbol(symbol);
  if (!code) return [];
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
  const url = `https://reportapi.eastmoney.com/report/list?qType=0&pageSize=60&pageNo=1&code=${code}&beginTime=${fmtDate(begin)}&endTime=${fmtDate(end)}&industryCode=*&rating=&ratingChange=`;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://reportapi.eastmoney.com/' },
    timeout: 15000,
  });
  const rows = r.data?.data || [];
  return rows
    .map((x) => ({
      title: x.title || '',
      org: x.orgSName || x.orgName || '',
      rating: x.emRatingName || x.sRatingName || '',
      targetPrice: x.indvAimPriceT ? parseFloat(x.indvAimPriceT) : (x.indvAimPriceL ? parseFloat(x.indvAimPriceL) : null),
      publishDate: (x.publishDate || '').slice(0, 10),
      infoCode: x.infoCode || '',
    }))
    .filter((r) => r.title);
}

// ---- 行业分析师研究报告（东方财富行业研报 qType=1）----
async function fetchIndustryReports(induCode) {
  if (!induCode) return [];
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
  const url = `https://reportapi.eastmoney.com/report/list?qType=1&pageSize=60&pageNo=1&beginTime=${fmtDate(begin)}&endTime=${fmtDate(end)}&industryCode=${induCode}&rating=&ratingChange=`;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://reportapi.eastmoney.com/' },
    timeout: 15000,
  });
  const rows = r.data?.data || [];
  return rows
    .map((x) => ({
      title: x.title || '',
      org: x.orgSName || x.orgName || '',
      rating: x.emRatingName || x.sRatingName || '',
      targetPrice: x.indvAimPriceT ? parseFloat(x.indvAimPriceT) : (x.indvAimPriceL ? parseFloat(x.indvAimPriceL) : null),
      publishDate: (x.publishDate || '').slice(0, 10),
      induName: x.indvInduName || '',
      infoCode: x.infoCode || '',
    }))
    .filter((r) => r.title);
}

// ---- 工具：纯代码去除 SH/SZ/BJ 前缀（不依赖 detectMarket，保持轻量）----
function normSymbol(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
}

// ---- 主流程 ----
async function industryAnalysis(symbol, name) {
  const out = {
    symbol,
    name: name || '',
    generatedAt: Date.now(),
    industry: null,
    futures: { hasFutures: false },
    policy: null,
    companyReports: [],
    industryReports: [],
    error: null,
  };

  try {
    const [futures, industry, companyReports] = await Promise.all([
      withTimeout(fetchFuturesCorrelation(symbol, name), 12000, { hasFutures: false }),
      withTimeout(fetchIndustryInfo(symbol, name), 13000, null),
      withTimeout(fetchCompanyReports(symbol), 15000, []),
    ]);

    if (name && !out.name) out.name = name;
    out.futures = futures || { hasFutures: false };
    out.industry = industry;
    out.companyReports = companyReports || [];

    if (industry) {
      out.policy = getPolicySupport(industry.name, industry.induName);
      out.industryReports = await withTimeout(fetchIndustryReports(industry.induCode), 15000, []);
    }
  } catch (e) {
    console.error('[Industry] analysis error:', e.message);
    out.error = e.message;
  }

  return out;
}

module.exports = { industryAnalysis, getPolicySupport, correctIndustryName, INDUSTRY_NAME_OVERRIDE };

~~~

---

## `lib\industryIndexHistory.js`  ·  138 行

~~~js
/**
 * 同花顺行业指数历史行情（K线数据）
 * --------------------------------
 * 封装 scripts/ths_industry_index_history.py，按行业名称拉取日线 OHLC，
 * 并提供单日缓存（按行业名 + 本地日期），供 /api/industry-index-history 使用。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ths_industry_index_history.py');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'industry_index_history');
const DEFAULT_DAYS = 250; // 默认约 1 年
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 本地日期一致即命中，自然日 1 天

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

function cacheFile(name) {
  ensureDir();
  return path.join(CACHE_DIR, `${safeName(name)}_${localDate()}.json`);
}

function readCache(name) {
  try {
    const f = cacheFile(name);
    if (!fs.existsSync(f)) return null;
    const stat = fs.statSync(f);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(name, data) {
  try {
    fs.writeFileSync(cacheFile(name), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

function parseStdout(stdout) {
  const raw = String(stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 兼容 akshare tqdm 进度条混入 stdout：取最后一个 { ... }
    const m = raw.match(/\{[\s\S]*\}$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { /* ignore */ }
    }
  }
  return null;
}

/**
 * 获取同花顺行业指数日线历史行情。
 * @param {string} industryName 行业名称（如"保险"）
 * @param {object} opts
 * @param {number} [opts.days=250] 取最近多少个交易日
 * @param {string} [opts.pythonPath] Python 解释器路径（由调用方传入，复用 server.js findPython）
 * @param {boolean} [opts.force=false] 是否忽略缓存强制重抓
 * @returns {Promise<{success:boolean, name?:string, code?:string, tradeDate?:string, data?:Array, source?:string, error?:string}>}
 */
async function getIndustryIndexHistory(industryName, opts = {}) {
  const { days = DEFAULT_DAYS, pythonPath, force = false } = opts;
  if (!industryName || !industryName.trim()) {
    return { success: false, error: '缺少行业名称' };
  }
  const name = industryName.trim();

  if (!force) {
    const cached = readCache(name);
    if (cached && cached.success && Array.isArray(cached.data) && cached.data.length > 0) {
      return { ...cached, cached: true };
    }
  }

  const py = pythonPath || process.env.PYTHON_BIN || process.env.PYTHON_PATH || 'python3';
  let stdout = '';
  try {
    const res = await execFileAsync(py, [SCRIPT, '--name', name, '--days', String(days)], {
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    stdout = (res && res.stdout) ? res.stdout : '';
  } catch (e) {
    return {
      success: false,
      error: '执行 Python 脚本失败: ' + (e && e.message),
      stderr: e && e.stderr ? String(e.stderr).slice(0, 500) : '',
    };
  }

  const data = parseStdout(stdout);
  if (!data) {
    return { success: false, error: '解析行情数据失败', raw: String(stdout).slice(0, 500) };
  }
  if (!data.ok) {
    return { success: false, error: data.error || '获取行情失败' };
  }
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return { success: false, error: '无历史行情数据' };
  }

  const result = {
    success: true,
    name: data.name,
    code: data.code,
    tradeDate: data.tradeDate,
    data: data.data,
    source: data.source || '同花顺·行业板块',
    cached: false,
  };
  writeCache(name, result);
  return result;
}

module.exports = { getIndustryIndexHistory };

~~~

---

## `lib\industryProsperity.js`  ·  459 行

~~~js
/**
 * 行业景气度 · 「行业总营收 vs 行业总市值」走势对比
 * ================================================================
 * 用途：个股页「行业分析」tab 下方独立卡片 —— 展示该个股所属**申万二级行业**内
 *       **全部公司**的总营收与总市值的走势比较，并在卡片下方标注行业公司数量等注释。
 *
 * 为什么用「申万二级」层级（而不是一级/三级）：
 *   东方财富两个权威数据集（业绩报表 RPT_LICO_FN_CPD 的 PUBLISHNAME、
 *   估值明细 RPT_VALUEANALYSIS_DET 的 BOARD_NAME）**只按申万二级行业名归类**，
 *   且两边口径完全一致（已实测：证券Ⅱ/半导体/农化制品/医疗器械/保险Ⅱ/调味发酵品Ⅱ 逐一对齐）。
 *   一级/三级名在这两个数据集里取不到 → 只有二级能同时拿到「全行业营收」与「全行业市值」。
 *
 * 数据源（规则一·单一权威源）：
 *   1) 行业成员名单：东方财富板块成分股 push2delay `api/qt/clist/get`（fs=b:BKxxxx，分页取全量）
 *      —— 用于「行业一共包含多少家公司」的权威口径。
 *   2) 行业各报告期营收：东方财富业绩报表 `RPT_LICO_FN_CPD`
 *      filter=(REPORTDATE='<报告期末>')(PUBLISHNAME="<申万二级行业名>")
 *      → 一次请求即返回**该行业全部公司**的累计营业总收入（元）。
 *   3) 行业各报告期末总市值：东方财富估值明细 `RPT_VALUEANALYSIS_DET`
 *      filter=(BOARD_NAME="<申万二级行业名>")(TRADE_DATE>='<回看起点>')(TRADE_DATE<='<报告期末>')
 *      → 季末常落在周末/节假日（如 2024-06-30 为周日），必须用**区间查询**再取区间内最新交易日。
 *
 * 口径说明（规则一·数据一致性）：
 *   - 营收取「累计口径」原值（Q1/H1/Q3/FY 为年内累计），再按标准公式折算
 *     **TTM 滚动12个月 = 上年年报 + 本期累计 − 上年同期累计**（年报期则 TTM = 年报值）；
 *   - 市值取每个报告期末**最近一个交易日**的行业总市值合计（亿元）；
 *   - 明细缺失（未上市/已退市/无市值数据）**不臆造**：该期该股不参与合计，并在
 *     companiesPerPeriod / missing 中如实披露；
 *   - 行业景气度判读（营收增速 vs 市值增速的背离关系）由代码确定性计算，不由 LLM 叙事。
 *
 * 缓存：按 行业名 + 本地日期 落盘 data/cache/industry_prosperity/，TTL 12h。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveStockSectorLevels } = require('./stockSectorLevels');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'industry_prosperity');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12 小时
const PLOT_PERIODS = 12;                     // 图上展示最近 12 个报告期（约 3 年）
const FETCH_PERIODS = 18;                    // 多取 6 期，供 TTM（需回看上年同期+上年年报）
const CONCURRENCY = 4;                       // 受限并发，避免打爆数据源
const MCAP_LOOKBACK_DAYS = 8;                // 市值按报告期末回看天数（覆盖周末+短假）
const MAX_CONSTITUENT_PAGES = 8;             // 成分股分页上限（pz=100/页）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' };
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

// ---------------- 工具 ----------------
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ensureDir() {
  try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}
function cacheFile(industryName) {
  ensureDir();
  return path.join(CACHE_DIR, `${safeName(industryName)}_${localDate()}.json`);
}
function readCache(industryName) {
  try {
    const f = cacheFile(industryName);
    if (!fs.existsSync(f)) return null;
    if (Date.now() - fs.statSync(f).mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}
function writeCache(industryName, data) {
  try { fs.writeFileSync(cacheFile(industryName), JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
}
const round2 = (v) => Math.round(v * 100) / 100;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e && e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------- 报告期（季末）工具 ----------------
/** 生成最近 count 个「已披露」报告期末（YYYY-MM-DD），最新在前（不含当前未结束季度） */
function recentQuarterEnds(count, from = new Date()) {
  const out = [];
  let y = from.getFullYear();
  let q = Math.floor(from.getMonth() / 3); // 0=Q1 … 3=Q4（当前季度）
  while (out.length < count) {
    q -= 1;
    if (q < 0) { q = 3; y -= 1; }
    const endMonth = q * 3 + 2;                       // 2/5/8/11 → 3/6/9/12 月
    const lastDay = new Date(y, endMonth + 1, 0).getDate();
    out.push(`${y}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
  }
  return out;
}
/** 同一年内的上一季末 */
function prevQuarterEnd(p) {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  if (m === 3) return `${y - 1}-12-31`;
  if (m === 6) return `${y}-03-31`;
  if (m === 9) return `${y}-06-30`;
  return `${y}-09-30`;
}
/** 上年同期 */
function yearAgo(p) {
  return `${Number(p.slice(0, 4)) - 1}${p.slice(4)}`;
}
function prevYearEnd(p) {
  return `${Number(p.slice(0, 4)) - 1}-12-31`;
}
function isYearEnd(p) { return p.endsWith('-12-31'); }
function periodLabel(p) {
  const y = p.slice(0, 4), m = Number(p.slice(5, 7));
  return `${y}Q${m === 3 ? 1 : m === 6 ? 2 : m === 9 ? 3 : 4}`;
}
function shiftDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------- 数据抓取 ----------------
/** 行业成分股全量（分页，pz=100）：用于「行业一共包含多少家公司」 */
async function fetchConstituents(sectorCode) {
  const all = [];
  const seen = new Set();
  for (let pn = 1; pn <= MAX_CONSTITUENT_PAGES; pn++) {
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20`
      + `&fs=b:${encodeURIComponent(sectorCode)}&fields=f12,f14,f20`;
    let diff = [];
    try {
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
    } catch { diff = []; }
    if (!diff.length) break;
    for (const d of diff) {
      const code = String(d.f12 || '');
      if (code && !seen.has(code)) {
        seen.add(code);
        all.push({ code, name: String(d.f14 || ''), marketCap: Number(d.f20) || 0 });
      }
    }
    if (diff.length < 100) break;   // 末页
  }
  return all;
}

/** 某报告期该行业全部公司的累计营业总收入（Map<code, {name, cum(亿), noticeDate}>） */
async function fetchPeriodRevenue(industryName, period) {
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,NOTICE_DATE';
  const base = `${DC}?reportName=RPT_LICO_FN_CPD&columns=${cols}`
    + `&filter=${encodeURIComponent(`(REPORTDATE='${period}')(PUBLISHNAME="${industryName}")`)}&pageSize=500`;
  const m = new Map();
  let count = null;
  let maxNotice = '';
  const maxPages = 6;
  for (let pn = 1; pn <= maxPages; pn++) {
    let rows = [], cnt = null;
    try {
      const { data } = await axios.get(`${base}&pageNumber=${pn}`, { headers: HEADERS, timeout: 30000 });
      const res = (data && data.result) || {};
      rows = Array.isArray(res.data) ? res.data : [];
      cnt = res.count;
    } catch { rows = []; }
    if (cnt != null) count = cnt;
    for (const r of rows) {
      const code = String(r.SECURITY_CODE || '');
      if (!code) continue;
      const nd = r.NOTICE_DATE ? String(r.NOTICE_DATE).slice(0, 10) : '';
      if (nd && nd > maxNotice) maxNotice = nd;
      const inc = Number(r.TOTAL_OPERATE_INCOME);
      if (!isFinite(inc) || inc <= 0) continue;
      m.set(code, {
        name: String(r.SECURITY_NAME_ABBR || ''),
        cum: round2(inc / 1e8),                       // 元 → 亿元
        noticeDate: nd,
      });
    }
    if (!rows.length || (cnt != null && pn * 500 >= cnt)) break;
  }
  return { map: m, count, noticeDate: maxNotice };
}

/** 某报告期末（最近交易日）该行业全部公司的总市值合计 */
async function fetchPeriodMarketCap(industryName, period) {
  const from = shiftDays(period, -MCAP_LOOKBACK_DAYS);
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,TOTAL_MARKET_CAP';
  const url = `${DC}?reportName=RPT_VALUEANALYSIS_DET&columns=${cols}`
    + `&filter=${encodeURIComponent(`(BOARD_NAME="${industryName}")(TRADE_DATE>='${from}')(TRADE_DATE<='${period}')`)}`
    + `&pageSize=2000&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1`;
  let rows = [];
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
    rows = ((data && data.result && data.result.data) || []);
  } catch { rows = []; }
  if (!rows.length) return { date: '', total: null, map: new Map(), count: 0 };
  // 取区间内最新交易日
  const dates = rows.map(r => String(r.TRADE_DATE || '').slice(0, 10)).filter(Boolean);
  const latest = dates.sort().pop();
  const map = new Map();
  let sum = 0;
  for (const r of rows) {
    if (String(r.TRADE_DATE || '').slice(0, 10) !== latest) continue;
    const code = String(r.SECURITY_CODE || '');
    const cap = Number(r.TOTAL_MARKET_CAP);
    if (!code || !isFinite(cap) || cap <= 0) continue;
    map.set(code, round2(cap / 1e8));                 // 元 → 亿元
    sum += cap / 1e8;
  }
  return { date: latest, total: map.size ? round2(sum) : null, map, count: map.size };
}

// ---------------- 主函数 ----------------
/**
 * @param {string} symbol 个股代码（如 '600909'）
 * @param {object} [opts]
 * @param {string} [opts.name] 个股名称（回显用）
 * @param {boolean} [opts.force] 忽略缓存
 * @param {number} [opts.periods] 展示报告期数（默认 12）
 * @returns {Promise<object>}
 */
async function getIndustryProsperity(symbol, opts = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) return { success: false, error: 'NO_SYMBOL', message: '缺少个股代码' };
  const force = !!opts.force;
  const plotN = Math.min(Math.max(Number(opts.periods) || PLOT_PERIODS, 4), 20);
  const stockName = String(opts.name || '').trim();

  // 1) 解析所属申万行业层级，锁定「二级」
  let levels = [];
  let sectorCode = '', industryName = '';
  try {
    const lv = await resolveStockSectorLevels(sym, { name: stockName, force: false });
    levels = (lv && Array.isArray(lv.levels)) ? lv.levels : [];
  } catch (e) {
    return { success: false, error: 'SECTOR_RESOLVE_FAILED', message: '解析所属行业失败：' + (e && e.message) };
  }
  const lv2 = levels.find(x => x.swLevel === '二级') || null;
  if (!lv2 || !lv2.sectorName) {
    return {
      success: false, error: 'NO_SW2_SECTOR',
      message: '未解析到该股的申万二级行业（营收/市值全行业口径仅二级可对齐），暂不展示行业景气度。',
      levels,
    };
  }
  sectorCode = lv2.sectorCode || '';
  industryName = lv2.sectorName;

  // 2) 缓存
  const cacheKey = industryName;
  if (!force) {
    const cached = readCache(cacheKey);
    if (cached && cached.success && Array.isArray(cached.periods) && cached.periods.length) {
      return { ...cached, symbol: sym, stockName, levels, cached: true };
    }
  }

  // 3) 报告期列表 + 行业成员名单 并行取
  const candidates = recentQuarterEnds(FETCH_PERIODS);
  const [revList, constituents] = await Promise.all([
    mapLimit(candidates, CONCURRENCY, (p) => fetchPeriodRevenue(industryName, p)),
    fetchConstituents(sectorCode).catch(() => []),
  ]);

  // 4) 只保留「确有该行业营收数据」的报告期（升序）
  const periodsWithData = candidates
    .map((p, i) => ({ period: p, res: revList[i] }))
    .filter(x => x.res && x.res.map && x.res.map.size > 0)
    .map(x => ({ period: x.period, map: x.res.map, noticeDate: (x.res && x.res.noticeDate) || '' }))
    .sort((a, b) => a.period.localeCompare(b.period));

  if (periodsWithData.length < 2) {
    return {
      success: false, error: 'NO_REVENUE_DATA',
      message: `未取到「${industryName}」行业的历史营收数据（数据源未覆盖或行业名不匹配），暂不展示行业景气度。`,
      industry: { swLevel: '二级', sectorCode, sectorName: industryName }, levels,
    };
  }
  const revByPeriod = new Map(periodsWithData.map(x => [x.period, x.map]));
  const noticeByPeriod = new Map(periodsWithData.map(x => [x.period, x.noticeDate]));
  // 展示期 = 最新 plotN 期
  const plotPeriods = periodsWithData.slice(Math.max(0, periodsWithData.length - plotN)).map(x => x.period);

  // 5) 各展示期市值得（并行）
  const mcapList = await mapLimit(plotPeriods, CONCURRENCY, (p) => fetchPeriodMarketCap(industryName, p));

  // 6) 逐期聚合：TTM 营收 / 单季营收 / 总市值 / 参与公司数
  const revenueTTM = [], revenueSingle = [], marketCap = [], companiesPerPeriod = [], mcapDates = [];
  for (let i = 0; i < plotPeriods.length; i++) {
    const p = plotPeriods[i];
    const cumMap = revByPeriod.get(p) || new Map();

    // 该期营收口径下出现过的全部代码（含缺 TTM 所需的）
    let ttmSum = 0, ttmCnt = 0, sgSum = 0, sgCnt = 0;
    for (const [code, rec] of cumMap) {
      // TTM
      let ttm = null;
      if (isYearEnd(p)) {
        ttm = rec.cum;
      } else {
        const fy = revByPeriod.get(prevYearEnd(p));
        const same = revByPeriod.get(yearAgo(p));
        const fyV = fy ? fy.get(code) : null;
        const sameV = same ? same.get(code) : null;
        if (fyV && sameV && isFinite(fyV.cum) && isFinite(sameV.cum)) {
          ttm = round2(fyV.cum + rec.cum - sameV.cum);
        }
      }
      if (ttm != null && ttm > 0) { ttmSum += ttm; ttmCnt++; }

      // 单季（供 tooltip/注释）
      let sg = null;
      if (p.endsWith('-03-31')) sg = rec.cum;
      else {
        const pq = revByPeriod.get(prevQuarterEnd(p));
        const pqV = pq ? pq.get(code) : null;
        if (pqV && isFinite(pqV.cum)) sg = round2(rec.cum - pqV.cum);
      }
      if (sg != null && sg > 0) { sgSum += sg; sgCnt++; }
    }

    const mc = mcapList[i] || { total: null, count: 0, date: '' };
    revenueTTM.push(ttmCnt ? round2(ttmSum) : null);
    revenueSingle.push(sgCnt ? round2(sgSum) : null);
    marketCap.push(mc.total);
    companiesPerPeriod.push({ period: p, revenue: ttmCnt, marketCap: mc.count });
    mcapDates.push(mc.date || '');
  }

  // 7) 行业公司总数（权威口径 = 板块成分股）与覆盖度
  const memberCodes = new Set(constituents.map(x => x.code));
  const latestRevMap = revByPeriod.get(plotPeriods[plotPeriods.length - 1]) || new Map();
  const latestMc = mcapList[mcapList.length - 1] || { map: new Map() };
  const latestMcMap = latestMc.map || new Map();
  const revCodes = new Set();
  revByPeriod.forEach(mp => mp.forEach((_v, c) => revCodes.add(c)));
  latestMcMap.forEach((_v, c) => revCodes.add(c));

  // 全行业成员（并集：板块成分 ∪ 营收口径 ∪ 市值口径），缺数据者显式列出
  const universeCodes = new Set();
  memberCodes.forEach(c => universeCodes.add(c));
  revCodes.forEach(c => universeCodes.add(c));

  const nameOf = new Map();
  constituents.forEach(x => nameOf.set(x.code, x.name));
  latestRevMap.forEach((v, c) => { if (!nameOf.get(c)) nameOf.set(c, v.name); });
  latestMcMap.forEach((_v, c) => { if (!nameOf.get(c)) nameOf.set(c, ''); });

  const missing = [];
  universeCodes.forEach(c => {
    const hasRev = revCodes.has(c);
    const hasMc = latestMcMap.has(c);
    if (!hasRev || !hasMc) {
      missing.push({ code: c, name: nameOf.get(c) || '', noRevenue: !hasRev, noMarketCap: !hasMc });
    }
  });

  // 8) 最新一期统计与同比
  const nP = plotPeriods.length;
  const last = nP - 1;
  const lastPeriod = plotPeriods[last];
  const lastTTM = revenueTTM[last];
  const lastSingle = revenueSingle[last];
  const lastMc = marketCap[last];

  // 同比：TTM 与市值均与「4 个报告期前」比较（季度序列天然年距）
  const yoyOf = (arr, idx) => {
    const prevIdx = idx - 4;
    const a = arr[idx], b = prevIdx >= 0 ? arr[prevIdx] : null;
    if (a == null || b == null || b <= 0) return null;
    return round2((a / b - 1) * 100);
  };
  const revTTMYoY = yoyOf(revenueTTM, last);
  const mcYoY = yoyOf(marketCap, last);

  // 9) 景气度判读（确定性规则，代码计算，不由 LLM 叙事）
  let verdict = null;
  if (revTTMYoY != null && mcYoY != null) {
    const revUp = revTTMYoY > 0, mcUp = mcYoY > 0;
    if (revUp && mcUp) {
      verdict = { tag: '景气上行', tone: 'bull', text: `行业营收（TTM）同比 ${revTTMYoY >= 0 ? '+' : ''}${revTTMYoY}%、总市值同比 ${mcYoY >= 0 ? '+' : ''}${mcYoY}%，量价同向向上，景气与市场定价共振。` };
    } else if (revUp && !mcUp) {
      verdict = { tag: '基本面改善·市场未反映', tone: 'neutral', text: `行业营收（TTM）同比 +${revTTMYoY}%，但总市值同比 ${mcYoY}%。基本面在改善而市值回落，景气度领先于股价，注意是否被低估。` };
    } else if (!revUp && mcUp) {
      verdict = { tag: '估值扩张·景气未跟上', tone: 'bear', text: `行业营收（TTM）同比 ${revTTMYoY}%，但总市值同比 +${mcYoY}%。市值上行快于基本面，属估值扩张，需警惕景气证伪后的回落风险。` };
    } else {
      verdict = { tag: '景气下行', tone: 'bear', text: `行业营收（TTM）同比 ${revTTMYoY}%、总市值同比 ${mcYoY}%，量价同向走弱，行业景气处于下行区间。` };
    }
  }

  // 口径提示（规则一·数据一致性）：成员数随报告期变动时，同比含「新股上市/退市」影响，须显式说明
  const caveats = [];
  const revCntFirst = companiesPerPeriod[0] ? companiesPerPeriod[0].revenue : 0;
  const revCntLast = companiesPerPeriod[last] ? companiesPerPeriod[last].revenue : 0;
  if (revCntFirst !== revCntLast) {
    caveats.push(`各报告期纳入的营收公司数不同（最早 ${revCntFirst} 家 → 最新 ${revCntLast} 家，含新股上市/退市），同比增速含成员变动影响，非纯内生增长。`);
  }
  if (missing.length) {
    caveats.push(`另有 ${missing.length} 家公司未纳入合计（无营收或市值数据），已在下方注明。`);
  }
  if (marketCap.some(v => v == null)) {
    caveats.push('部分报告期缺行业总市值数据（数据源未覆盖），该点以断线表示。');
  }
  const maxNotice = noticeByPeriod.get(lastPeriod) || '';

  const result = {
    success: true,
    symbol: sym,
    stockName,
    industry: { swLevel: '二级', sectorCode, sectorName: industryName },
    levels,
    periods: plotPeriods,
    periodLabels: plotPeriods.map(periodLabel),
    revenueTTM,                 // 亿元（TTM 滚动12个月，全行业合计）
    revenueSingle,              // 亿元（单季，全行业合计）
    marketCap,                  // 亿元（报告期末最近交易日，全行业合计）
    mcapDates,                  // 各期市值对应的实际交易日
    companiesPerPeriod,         // 各期参与合计的公司数（营收/市值）
    industryCompanyCount: constituents.length || universeCodes.size,   // 行业一共包含多少家公司
    universeCount: universeCodes.size,
    coveredRevenue: companiesPerPeriod[last] ? companiesPerPeriod[last].revenue : 0,
    coveredMarketCap: companiesPerPeriod[last] ? companiesPerPeriod[last].marketCap : 0,
    missing,
    caveats,
    latest: {
      period: lastPeriod,
      label: periodLabel(lastPeriod),
      revenueTTM: lastTTM,
      revenueSingle: lastSingle,
      revenueTTMYoY: revTTMYoY,
      marketCap: lastMc,
      marketCapYoY: mcYoY,
      noticeDate: maxNotice,
    },
    verdict,
    unit: '亿元',
    date: mcapDates[last] || lastPeriod,
    source: `东方财富（行业营收：业绩报表 RPT_LICO_FN_CPD 按申万二级「${industryName}」全量汇总；行业总市值：估值明细 RPT_VALUEANALYSIS_DET 同行业口径；成员数：板块成分股）`,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  writeCache(cacheKey, result);
  return result;
}

module.exports = { getIndustryProsperity };

~~~

---

## `lib\insuranceAnalysis.js`  ·  1168 行

~~~js
/**
 * Insurance Company Analysis Module
 * Based on insurance analysis outline (18 sections)
 * Covers: Premium income, NBV, combined ratio, investment yield, P/EV, DDM
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};

// Known insurance company codes (A-share)
// 仅收录 A 股主营保险业务的上市公司；非保险股一律不列入。
const INSURANCE_CODES = {
  '601318': '中国平安',
  '601628': '中国人寿',
  '601336': '新华保险',
  '601319': '中国人保',
  '601601': '中国太保',
};

// ─────────────────────────────────────────────────────────────────────────
// 保险公司核心指标「真实值」备查库
// 来源：东方财富妙想金融数据 + 中国平安年报，已交叉核对（2026-08-25）。
// 用途：替代利润表难以直接提取的 NBV / 综合成本率 / 投资收益率等保险专属指标。
// 这些指标在合并利润表/资产负债表无直接对应科目，用流量字段估算会产生量级错误
// （此前投资收益率被低估至 0.x%、综合成本率被算成 0.0x% 即是此因）。
// 数据一致性红线：单一指标只从此处取数，跨模块复用同一份，不另起估算。
// 数值为各报告期「累计」值：中报=上半年累计、三季报=前三季度累计、年报=全年。
// ─────────────────────────────────────────────────────────────────────────
const INSURANCE_REAL_DATA = {
  '601318': {
    // 寿险及健康险 新业务价值 NBV（亿元）。
    // 妙想返回的是各报告期「累计」口径：Q1=单季，H1=Q1+Q2，Q3=前三季，FY=全年。
    // 2020–2025 共 24 个季度，用于绘制真正的季度趋势图。
    nbv: {
      source: '妙想金融数据 + 中国平安年报',
      note: '数据回溯提醒：公司把 2023 年、2024 年新业务价值的长期投资回报率假设由 5% 调低到 4.5% 再至 4%，历史口径不可直接对比。',
      cumulative: [
        { period: '2020Q1', label: '2020Q1', value: 164.5 },
        { period: '2020H1', label: '2020H1', value: 310.3 },
        { period: '2020Q3', label: '2020Q3', value: 428.4 },
        { period: '2020FY', label: '2020年报', value: 495.8 },
        { period: '2021Q1', label: '2021Q1', value: 189.8 },
        { period: '2021H1', label: '2021H1', value: 273.9 },
        { period: '2021Q3', label: '2021Q3', value: 352.4 },
        { period: '2021FY', label: '2021年报', value: 379.0 },
        { period: '2022Q1', label: '2022Q1', value: 125.9 },
        { period: '2022H1', label: '2022H1', value: 195.7 },
        { period: '2022Q3', label: '2022Q3', value: 258.5 },
        { period: '2022FY', label: '2022年报', value: 288.2 },
        { period: '2023Q1', label: '2023Q1', value: 137.0 },
        { period: '2023H1', label: '2023H1', value: 259.6 },
        { period: '2023Q3', label: '2023Q3', value: 335.7 },
        { period: '2023FY', label: '2023年报', value: 310.8 },
        { period: '2024Q1', label: '2024Q1', value: 128.9 },
        { period: '2024H1', label: '2024H1', value: 223.2 },
        { period: '2024Q3', label: '2024Q3', value: 351.6 },
        { period: '2024FY', label: '2024年报', value: 400.2 },
        { period: '2025Q1', label: '2025Q1', value: 128.9 },
        { period: '2025H1', label: '2025H1', value: 223.4 },
        { period: '2025Q3', label: '2025Q3', value: 357.2 },
        { period: '2025FY', label: '2025年报', value: 369.0 },
        { period: '2026Q1', label: '2026Q1', value: 155.7 },
        { period: '2026H1', label: '2026H1', value: 248.5 },
      ],
    },
    // 综合成本率（产险业务，%）。产险业务综合成本率 = (赔付+费用+准备金变动)/已赚保费。
    combinedRatio: {
      source: '妙想金融数据',
      data: [
        { period: '2025Q1', label: '2025Q1', value: 96.6 },
        { period: '2025H1', label: '2025H1', value: 95.2 },
        { period: '2025Q3', label: '2025Q3', value: 97.0 },
        { period: '2025FY', label: '2025年报', value: 96.8 },
        { period: '2026Q1', label: '2026Q1', value: 95.8 },
        { period: '2026H1', label: '2026H1', value: 95.1 },
      ],
    },
    // 总投资收益率（年化，%）。
    // 口径说明：保险行业惯例披露「年化」总投资收益率（interim 报告按年化处理）。
    // 2020-2023 及 2025 中报前数据取自中国平安年报/季报披露的年化值；
    // 2024-2025 年报及 2026 各期为券商测算（平安官方年报主要披露净/综合投资收益率，
    // 总投资收益率 ≈ 总投资收益 / 平均投资资产），其中 2026Q1/H1 由单季非年化值按期间年化推算。
    investmentYield: {
      source: '中国平安年报/季报 + 妙想金融数据 + 券商测算',
      data: [
        { period: '2020Q1', label: '2020Q1', value: 3.4 },
        { period: '2020H1', label: '2020H1', value: 4.4 },
        { period: '2020FY', label: '2020FY', value: 6.2 },
        { period: '2021Q1', label: '2021Q1', value: 3.1 },
        { period: '2021H1', label: '2021H1', value: 3.5 },
        { period: '2021FY', label: '2021FY', value: 4.0 },
        { period: '2022Q1', label: '2022Q1', value: 2.3 },
        { period: '2022H1', label: '2022H1', value: 3.1 },
        { period: '2022FY', label: '2022FY', value: 2.5 },
        { period: '2023Q1', label: '2023Q1', value: 3.3 },
        { period: '2023H1', label: '2023H1', value: 3.4 },
        { period: '2023FY', label: '2023FY', value: 3.0 },
        { period: '2024Q1', label: '2024Q1', value: 3.5 },
        { period: '2024H1', label: '2024H1', value: 4.2 },
        { period: '2024FY', label: '2024FY', value: 4.0 },
        { period: '2025Q1', label: '2025Q1', value: 5.2 },
        { period: '2025H1', label: '2025H1', value: 6.2 },
        { period: '2025FY', label: '2025FY', value: 4.6 },
        { period: '2026Q1', label: '2026Q1', value: 1.6 },
        { period: '2026H1', label: '2026H1', value: 4.2 },
      ],
    },
    // 险种 / 业务结构占比（主营构成口径）。
    // 平安集团为综合金融集团，合并利润表无法直接拆分「保费险种占比」；
    // 此处采用妙想主营构成中的分业务营业收入作为业务结构近似替代。
    premiumComposition: {
      source: '妙想金融数据（主营构成）',
      reportDate: '2026-06-30',
      note: '口径：平安集团分业务主营构成（2026年中报），已剔除内部抵销；银行、资管、金融赋能为非保险业务。',
      // value 采用各业务营业收入（亿元）；ECharts 会自动计算占比。
      data: [
        { name: '寿险及健康险', value: 2694.0 },
        { name: '财产保险', value: 1790.0 },
        { name: '银行', value: 706.2 },
        { name: '资产管理', value: 426.6 },
        { name: '金融赋能', value: 224.9 },
      ],
    },
  },
};

// 取两位小数的小工具
function round2(n) {
  const v = parseFloat(n);
  return isNaN(v) ? 0 : Math.round(v * 100) / 100;
}

// 按报告期（年 + 阶段）做时间顺序排序：Q1 < H1 < Q3 < FY
const _PERIOD_ORDER = { Q1: 1, H1: 2, Q3: 3, FY: 4 };
function sortByReportPeriod(arr) {
  return arr.slice().sort((a, b) => {
    const pa = String(a.year || ''), pb = String(b.year || '');
    const ya = pa.slice(0, 4), yb = pb.slice(0, 4);
    if (ya !== yb) return ya < yb ? -1 : 1;
    const sa = (pa.match(/(Q1|H1|Q3|FY)$/) || [''])[0];
    const sb = (pb.match(/(Q1|H1|Q3|FY)$/) || [''])[0];
    return (_PERIOD_ORDER[sa] || 0) - (_PERIOD_ORDER[sb] || 0);
  });
}

// 将「累计」口径的 NBV 序列拆成各季度「环比增量」+ 累计值，并计算 TTM 滚动。
// 年内顺序 Q1 → H1(=Q1+Q2) → Q3(=Q1+Q2+Q3) → FY(全年)。
function buildQuarterlyNBV(cumulative) {
  const byYear = {};
  for (const c of (cumulative || [])) {
    const m = /^(\d{4})(Q1|H1|Q3|FY)$/.exec(c.period || '');
    if (!m) continue;
    (byYear[m[1]] = byYear[m[1]] || {})[m[2]] = c.value;
  }
  const quarters = [];
  for (const y of Object.keys(byYear).sort()) {
    const g = byYear[y];
    const q1 = g.Q1, h1 = g.H1, q3 = g.Q3, fy = g.FY;
    if (q1 != null) quarters.push({ year: y, quarter: 'Q1', label: `${y}Q1`, value: round2(q1), cumulative: round2(q1) });
    if (h1 != null && q1 != null) quarters.push({ year: y, quarter: 'Q2', label: `${y}Q2`, value: round2(h1 - q1), cumulative: round2(h1) });
    if (q3 != null && h1 != null) quarters.push({ year: y, quarter: 'Q3', label: `${y}Q3`, value: round2(q3 - h1), cumulative: round2(q3) });
    if (fy != null && q3 != null) quarters.push({ year: y, quarter: 'Q4', label: `${y}Q4`, value: round2(fy - q3), cumulative: round2(fy) });
    else if (fy != null && h1 != null) quarters.push({ year: y, quarter: 'Q4', label: `${y}Q4`, value: round2(fy - h1), cumulative: round2(fy) });
  }

  // 计算 TTM 滚动：每个报告期往前推 4 个单季度增量之和。
  // 这能消除年内季节波动，与市场上常见的「NBV TTM」趋势图口径一致。
  for (let i = 3; i < quarters.length; i++) {
    const ttm = quarters[i].value + quarters[i - 1].value + quarters[i - 2].value + quarters[i - 3].value;
    quarters[i].ttm = round2(ttm);
  }

  return quarters;
}

// Insurance industry detection by name/code
function isInsuranceCompany(symbol, name, quote) {
  // Check by known codes
  const code = symbol.replace(/^(SH|SZ|sh|sz)/, '');
  if (INSURANCE_CODES[code]) return true;
  
  // Check by name keywords
  // 注意：裸「平安」会误标平安银行（000001），故不以裸「平安」判定；
  // 中国平安(601318)已由代码表命中，名称含「保险」亦可命中。
  const n = (name || '').toLowerCase();
  if (n.includes('保险') || n.includes('人寿') || n.includes('太保') || n.includes('人保')) {
    return true;
  }
  
  // Check by industry from quote
  const industry = quote?.industry || quote?.f100 || '';
  if (typeof industry === 'string' && industry.includes('保险')) {
    return true;
  }
  
  return false;
}

// Fetch insurance operational data from Eastmoney
// This API returns premium income, NBV, combined ratio, etc.
async function fetchInsuranceOperations(emCode) {
  const results = {
    premiums: [],        // 保费收入 by year
    premiumByType: [],   // 分险种保费
    nbv: [],             // 新业务价值
    combinedRatio: [],   // 综合成本率
    investmentYield: [], // 综合投资收益率
    embeddedValue: [],   // 内含价值
    operatingProfit: [], // 营运利润
    netProfit: [],       // 净利润
  };
  
  // Try Eastmoney's operation data API
  // Endpoint: CompanyOperation/PageAjax
  const opUrl = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanyOperation/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(opUrl, { headers: HEADERS, timeout: 15000 });
    const data = resp.data;
    
    // Parse operational data - structure varies by company
    // Look for insurance-specific indicators
    if (data) {
      // Try to find premium income data
      const indicators = data.bzyszb || data.jyzb || data.OperationIndicators || [];
      if (Array.isArray(indicators)) {
        for (const item of indicators) {
          if (item.OPERATING_TYPE || item.ITEM_NAME) {
            const typeName = item.OPERATING_TYPE || item.ITEM_NAME || '';
            const year = item.REPORT_DATE ? item.REPORT_DATE.substring(0, 4) : '';
            const value = parseFloat(item.OPERATING_INCOME || item.AMOUNT || 0);
            
            if (typeName.includes('保费') || typeName.includes('原保险')) {
              results.premiums.push({ year, value, type: typeName, reportDate: item.REPORT_DATE || '' });
            }
            if (typeName.includes('新业务价值') || typeName.includes('NBV')) {
              results.nbv.push({ year, value, type: typeName });
            }
            if (typeName.includes('综合成本率')) {
              results.combinedRatio.push({ year, value, type: typeName });
            }
            if (typeName.includes('投资收益率') || typeName.includes('总投资收益率')) {
              results.investmentYield.push({ year, value, type: typeName });
            }
            if (typeName.includes('内含价值')) {
              results.embeddedValue.push({ year, value, type: typeName });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[InsuranceOps] Fetch failed:', e.message);
  }
  
  return results;
}

// TTM 流量指标字段定义（字段名 -> 提取函数）
const _TTM_FIELDS = {
  earnedPremium: r => toYi(r.EARNED_PREMIUM || r.OPERATE_INCOME || 0),
  insuranceRevenue: r => toYi(r.OPERATE_INCOME || r.EARNED_PREMIUM || 0),
  claimPayments: r => toYi(r.NET_COMPENSATE_EXPENSE || 0),
  surrenderValue: r => toYi(r.SURRENDER_VALUE || 0),
  reserveChange: r => toYi(r.NET_CONTRACT_RESERVE || 0),
  investmentIncome: r => toYi(r.INVEST_INCOME || 0),
  operatingProfit: r => toYi(r.OPERATE_PROFIT || 0),
  netProfit: r => toYi(r.PARENT_NETPROFIT || r.NETPROFIT || 0),
  commissionExpense: r => toYi(r.FEE_COMMISSION_EXPENSE || 0),
};

// 对利润表流量指标按年做 TTM 还原。
// 规则：有年报用年报；无年报取最新一期非年报，并用「当年部分 + 上一年年报 - 上一年同阶段部分」还原为 TTM。
function computeTTMFromIncome(income) {
  if (!income || !income.length) {
    const empty = {};
    for (const k of Object.keys(_TTM_FIELDS)) empty[k] = [];
    return empty;
  }
  const byYear = {};
  for (const r of income) {
    const y = r.REPORT_DATE ? r.REPORT_DATE.slice(0, 4) : '';
    if (!y) continue;
    const st = _reportStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = {};
  for (const k of Object.keys(_TTM_FIELDS)) result[k] = [];

  let prevFY = null;          // 上一年年报值 { key -> 亿 }
  let prevPartials = {};      // 上一年各阶段部分报告值 { stage -> { key -> 亿 } }

  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.annual);
      rec = { year: y, ...vals, ttm: false, note: '' };
    } else {
      // 取最新一期非年报
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prevFY) {
        const vals = {};
        for (const [k, fn] of Object.entries(_TTM_FIELDS)) {
          const cur = fn(bestRec);
          const pf = prevFY[k] || 0;
          const ps = (prevPartials[bestStage] && prevPartials[bestStage][k]) || 0;
          vals[k] = Math.round((cur + (pf - ps)) * 100) / 100;
        }
        rec = { year: y, ...vals, ttm: true, note: `TTM估算（${bestRec.REPORT_DATE_NAME || bestStage}）` };
      } else if (bestRec) {
        const vals = {};
        for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(bestRec);
        rec = { year: y, ...vals, ttm: true, note: `${bestRec.REPORT_DATE_NAME || bestStage}累计值（无上一年同阶段）` };
      }
    }
    if (rec) {
      for (const k of Object.keys(_TTM_FIELDS)) {
        result[k].push({ year: rec.year, value: rec[k], ttm: rec.ttm, note: rec.note });
      }
    }
    // 更新上一年追踪
    if (g.annual) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.annual);
      prevFY = vals;
    }
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) {
      const vals = {};
      for (const [k, fn] of Object.entries(_TTM_FIELDS)) vals[k] = fn(g.partials[s]);
      thisPartials[s] = vals;
    }
    prevPartials = thisPartials;
  }
  return result;
}

// Extract insurance-specific data from financial statements
// Income statement for insurance companies has special items:
// EARNED_PREMIUM, NET_COMPENSATE_EXPENSE, NET_CONTRACT_RESERVE, SURRENDER_VALUE,
// INVEST_INCOME, OPERATE_PROFIT, PARENT_NETPROFIT
function extractInsuranceMetricsFromStatements(income, balance) {
  // 利润表流量指标统一按 TTM 还原，避免 2026 年中报累计值直接对比 2025 年年报，
  // 并消除同一年年报+部分报告被重复相加的问题。
  const ttm = computeTTMFromIncome(income);
  const metrics = {
    earnedPremium: ttm.earnedPremium,      // 已赚保费
    insuranceRevenue: ttm.insuranceRevenue,// 保险业务收入
    claimPayments: ttm.claimPayments,      // 赔付支出
    surrenderValue: ttm.surrenderValue,    // 退保金
    reserveChange: ttm.reserveChange,      // 准备金净增加额
    investmentIncome: ttm.investmentIncome,// 投资收益
    operatingProfit: ttm.operatingProfit,  // 营业利润
    netProfit: ttm.netProfit,              // 归母净利润
    commissionExpense: ttm.commissionExpense, // 手续费及佣金支出（估算综合成本率用）
    totalAssets: [],        // 总资产
    netAssets: [],          // 归母净资产
    insuranceReserves: [],  // 保险合同准备金
  };
  
  for (const item of balance) {
    const year = item.REPORT_DATE ? item.REPORT_DATE.substring(0, 4) : '';
    if (!year) continue;
    
    metrics.totalAssets.push({
      year,
      value: toYi(item.TOTAL_ASSETS || 0),
    });
    metrics.netAssets.push({
      year,
      value: toYi(item.TOTAL_PARENT_EQUITY || item.TOTAL_EQUITY || 0),
    });
    // Insurance contract reserves - try multiple field names
    metrics.insuranceReserves.push({
      year,
      value: toYi(item.INSURANCE_CONTRACT_RESERVES || item.BXHTZBJ || item.RESERVE_INSURANCE || 0),
    });
  }
  
  return metrics;
}

// Analyze premium income trends (10 years)
function analyzePremiumTrends(metrics, operations, symbol) {
  // Merge data from financial statements and operational data
  let premiumData = operations.premiums.length > 0 
    ? operations.premiums 
    : metrics.earnedPremium;
  
  // 运营口径若同一年出现多条（年报 + 部分报告），按年去重：优先取年报(12-31)，否则取最新一期，避免重复相加
  if (premiumData !== metrics.earnedPremium) {
    const dedup = new Map();
    for (const p of premiumData) {
      if (!p.year) continue;
      const isAnnual = (p.reportDate || '').includes('12-31');
      const prev = dedup.get(p.year);
      if (!prev) { dedup.set(p.year, p); continue; }
      if (isAnnual && !prev.isAnnual) dedup.set(p.year, { ...p, isAnnual: true });
      else if (isAnnual === prev.isAnnual && (p.reportDate || '') > (prev.reportDate || '')) dedup.set(p.year, { ...p, isAnnual });
    }
    premiumData = Array.from(dedup.values());
  }
  
  // Group by year and aggregate
  const yearMap = new Map();
  for (const p of premiumData) {
    if (!p.year) continue;
    if (!yearMap.has(p.year)) {
      yearMap.set(p.year, { year: p.year, total: 0, byType: {}, ttm: false, note: '' });
    }
    const entry = yearMap.get(p.year);
    entry.total += p.value || 0;
    if (p.ttm) { entry.ttm = true; if (p.note) entry.note = p.note; }
    if (p.type) {
      entry.byType[p.type] = (entry.byType[p.type] || 0) + (p.value || 0);
    }
  }
  
  const yearlyData = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate YoY growth
  for (let i = 1; i < yearlyData.length; i++) {
    const prev = yearlyData[i - 1].total;
    const curr = yearlyData[i].total;
    yearlyData[i].yoyGrowth = prev > 0 ? ((curr - prev) / prev * 100) : 0;
  }
  if (yearlyData.length > 0) yearlyData[0].yoyGrowth = 0;
  
  // Premium type breakdown (latest year)
  const latest = yearlyData[yearlyData.length - 1];
  let typeBreakdown = latest ? Object.entries(latest.byType).map(([type, value]) => ({
    name: type,
    value,
    percentage: latest.total > 0 ? (value / latest.total * 100) : 0,
  })).sort((a, b) => b.value - a.value) : [];
  
  // 如果利润表/运营数据无法拆出险种结构，改用真实备查库（妙想主营构成）
  let compositionSource = null;
  let compositionNote = null;
  if (typeBreakdown.length === 0 && symbol && INSURANCE_REAL_DATA[symbol]?.premiumComposition) {
    const comp = INSURANCE_REAL_DATA[symbol].premiumComposition;
    typeBreakdown = comp.data.map(d => ({ ...d, percentage: 0 })); // percentage 由 ECharts 计算
    compositionSource = comp.source;
    compositionNote = comp.note;
  }
  
  return {
    yearlyData,
    typeBreakdown,
    totalGrowth: yearlyData.length >= 2 
      ? ((yearlyData[yearlyData.length - 1].total / yearlyData[0].total - 1) * 100) 
      : 0,
    latestYear: latest?.year || '',
    latestPremium: latest?.total || 0,
    compositionSource,
    compositionNote,
  };
}

// 报告期阶段判定：年报 / 一季报 / 中报 / 三季报
function _reportStage(reportName) {
  if (!reportName) return null;
  if (reportName.includes('年报')) return 'FY';
  if (reportName.includes('一季报')) return 'Q1';
  if (reportName.includes('中报')) return 'H1';
  if (reportName.includes('三季报')) return 'Q3';
  return null;
}
// 阶段优先级（数值越大越"新"）
const _STAGE_ORDER = { Q1: 1, H1: 2, Q3: 3 };

// Extract a yearly business-line series from segment data (集团年报分业务披露)
// 口径规则（用户要求）：
//   1) 优先采用「年报」数据；
//   2) 若某年（如 2026）尚未披露年报、但有最新一期报告（中报/一季报），
//      则采用 TTM 滚动累计：当年已披露部分 + 上一年剩余季度。
//        TTM(当年) = 当年部分报告值 + (上一年年报 - 上一年同阶段部分报告值)
function buildBusinessLineFromSegment(segmentData, keyword) {
  // 优先使用 allPeriods（保留该年全部报告期），以便 TTM 取「上一年同阶段部分报告」还原剩余季度；
  // 缺失时回退 byYear（仅最新一期，TTM 不可用）。
  const src = (segmentData && segmentData.allPeriods) || (segmentData && segmentData.byYear) || null;
  if (!src) return [];
  const out = [];
  const years = (segmentData.years || []).slice().sort();
  // 规范化：兼容 allPeriods[{stage,reportName,items}] 与 byYear[扁平 items] 两种形态
  const _periodsOf = (y) => {
    const raw = src[y] && (src[y]['产品'] || src[y]['产品分部']);
    if (!raw || !raw.length) return [];
    if (Array.isArray(raw[0] && raw[0].items)) return raw;
    return [{ stage: _reportStage((raw[0] && raw[0].reportName) || ''), reportName: (raw[0] && raw[0].reportName) || '', items: raw }];
  };
  // 上一年追踪：年报值 + 各阶段部分报告值（用于 TTM 还原剩余季度）
  let prevFY = null;
  let prevPartials = {}; // stage -> 收入(亿)
  for (const y of years) {
    const periods = _periodsOf(y);
    if (!periods.length) { prevFY = null; prevPartials = {}; continue; }
    let annual = null, partial = null;
    for (const p of periods) {
      const it = (p.items || []).find(x => x.name.includes(keyword));
      if (!it) continue;
      const st = p.stage || _reportStage(p.reportName);
      const v = Math.round(it.income / 1e8 * 100) / 100;
      if (st === 'FY') { if (!annual) annual = { value: v, ratio: it.ratio, grossMargin: it.grossMargin, reportName: p.reportName }; }
      else if (st) { if (!partial || _STAGE_ORDER[st] > _STAGE_ORDER[partial.stage]) partial = { stage: st, value: v, ratio: it.ratio, grossMargin: it.grossMargin, reportName: p.reportName }; }
    }
    let entry = null;
    if (annual) {
      entry = {
        year: y,
        value: annual.value,
        ratio: annual.ratio,
        grossMargin: annual.grossMargin,
        ttm: false,
        note: '',
      };
    } else if (partial && prevFY != null && prevPartials[partial.stage] != null) {
      // TTM 估算：当年部分 + 上年剩余季度
      const ttmVal = Math.round((partial.value + (prevFY - prevPartials[partial.stage])) * 100) / 100;
      entry = {
        year: y,
        value: ttmVal,
        ratio: partial.ratio,
        grossMargin: partial.grossMargin,
        ttm: true,
        note: `TTM估算（${partial.reportName}叠加${parseInt(y, 10) - 1}年后三季度）`,
      };
    }
    if (entry) out.push(entry);
    // 更新上一年追踪
    const thisPartials = {};
    for (const p of periods) {
      const it = (p.items || []).find(x => x.name.includes(keyword));
      if (!it) continue;
      const st = p.stage || _reportStage(p.reportName);
      if (st && st !== 'FY') thisPartials[st] = Math.round(it.income / 1e8 * 100) / 100;
    }
    prevFY = annual ? annual.value : prevFY;
    prevPartials = thisPartials;
  }
  out.sort((a, b) => a.year.localeCompare(b.year));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].value, curr = out[i].value;
    out[i].yoy = prev > 0 ? Math.round((curr - prev) / prev * 100 * 100) / 100 : 0;
  }
  return out;
}

// Build the 5 business-line trend series for the deep-analysis "分业务趋势" section.
// Sources: life/property from group segment disclosure (annual reports); pension/health from
// Ping An's monthly/annual original-premium announcements (subsidiary 口径); NBV from annual reports.
// 一致性红线：pension/health/nbv 是「中国平安(601318)专属」的真实值备查库数据，
// 仅当 symbol === '601318' 时才注入；其它保险股无对应真实数据，返回空数组，避免把平安数据泄漏到其它公司。
function buildBusinessLines(segmentData, symbol) {
  const life = buildBusinessLineFromSegment(segmentData, '寿险');
  const property = buildBusinessLineFromSegment(segmentData, '财产');

  // 仅中国平安(601318)使用其专属养老/健康/NBV 真实值备查库
  const isPingAn = symbol === '601318';

  // 平安养老（平安养老保险股份有限公司）保险业务收入 / 原保险保费收入（亿元）
  // 来源：平安养老年报、原保险保费收入公告、2025年四季度偿付能力报告
  const pension = isPingAn ? [
    { year: '2013', value: 69.77 }, { year: '2014', value: 88.61 }, { year: '2015', value: 130.86 },
    { year: '2016', value: 152.94 }, { year: '2017', value: 175.60 }, { year: '2018', value: 211.12 },
    { year: '2019', value: 236.13 }, { year: '2020', value: 262.18 }, { year: '2021', value: 220.22 },
    { year: '2022', value: 184.83 }, { year: '2023', value: 173.26 }, { year: '2024', value: 165.95 },
    { year: '2025', value: 99.70 },
  ] : [];

  // 平安健康（平安健康保险股份有限公司）保险业务收入 / 原保险保费收入（亿元）
  // 来源：平安健康年报、原保险保费收入公告、2025年四季度偿付能力报告
  const health = isPingAn ? [
    { year: '2019', value: 92.85 }, { year: '2020', value: 122.08 }, { year: '2021', value: 149.54 },
    { year: '2022', value: 158.05 }, { year: '2023', value: 146.68 }, { year: '2024', value: 168.49 },
    { year: '2025', value: 195.40 },
  ] : [];

  // 寿险及健康险新业务价值 NBV（亿元）
  // 来源：2024/2025 年报及保费公告；2023/2024 NBV 的长期投资回报率假设由 5% 回溯至 4.5% 再至 4%，历史口径不可直接对比
  const nbv = isPingAn ? [
    { year: '2024', value: 285.34 }, { year: '2025', value: 368.97 },
  ] : [];

  for (const arr of [pension, health, nbv]) {
    if (!arr.length) continue;
    arr.sort((a, b) => a.year.localeCompare(b.year));
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1].value, curr = arr[i].value;
      arr[i].yoy = prev > 0 ? Math.round((curr - prev) / prev * 100 * 100) / 100 : 0;
    }
  }

  return { life, property, pension, health, nbv };
}

// Analyze NBV (New Business Value) trends — 细化到每个季度
// 数据来源：妙想金融数据 + 中国平安年报（累计口径），拆成各季度环比增量 + 累计。
function analyzeNBV(symbol) {
  const real = INSURANCE_REAL_DATA[symbol]?.nbv;
  if (real && real.cumulative && real.cumulative.length) {
    const quarters = buildQuarterlyNBV(real.cumulative);

    // 全年 NBV（仅含 Q4 / FY 的年报值），用于跨年可比分析
    const yearlyFY = [];
    for (const q of quarters) {
      if (q.quarter === 'Q4') yearlyFY.push({ year: q.year, value: q.cumulative });
    }
    // 若最新一年尚未披露年报，把它作为「部分年度」单独标注
    const lastYear = quarters.length ? quarters[quarters.length - 1].year : '';
    const hasFY = yearlyFY.some(y => y.year === lastYear);
    let latestPartial = null;
    if (!hasFY && lastYear) {
      const partialSum = round2(quarters.filter(q => q.year === lastYear).reduce((s, q) => s + q.value, 0));
      const partialStage = quarters.filter(q => q.year === lastYear).pop()?.label || '';
      latestPartial = { year: lastYear, value: partialSum, stage: partialStage };
    }

    // 年度同比（仅基于年报口径）
    for (let i = 1; i < yearlyFY.length; i++) {
      const prev = yearlyFY[i - 1].value, curr = yearlyFY[i].value;
      yearlyFY[i].yoyGrowth = prev > 0 ? round2((curr - prev) / prev * 100) : 0;
    }
    if (yearlyFY.length) yearlyFY[0].yoyGrowth = 0;

    // TTM 滚动序列（从第 4 个季度点开始，因为 TTM = 连续 4 个单季增量之和）
    const ttmSeries = quarters.filter(q => q.ttm != null).map(q => ({
      label: q.label,
      year: q.year,
      quarter: q.quarter,
      value: q.ttm,
    }));

    // 生成解读文字
    const explanation = _buildNBVExplanation(quarters, yearlyFY, latestPartial, ttmSeries, real.note);

    return {
      data: quarters,                 // 各季度（含当季增量 value + 累计 cumulative + ttm）
      ttmSeries,                      // TTM 滚动 12 个月 NBV
      yearly: yearlyFY,               // 年度合计（仅年报口径，跨年可比）
      latestPartial,                  // 最新部分年度（如 2026H1）
      hasData: true,
      unit: '亿元',
      source: real.source,
      note: `寿险及健康险新业务价值(NBV)已细化至各季度：柱状为当季环比增量，蓝色折线为累计值，黄色折线为 TTM 滚动 12 个月（与常见行情软件口径一致）。数据来源：${real.source}。`,
      explanation,
    };
  }
  return {
    data: [],
    yearly: [],
    hasData: false,
    note: '新业务价值(NBV)数据需从公司年报或运营数据中获取，当前数据源暂未覆盖。建议查看公司年报中的"内含价值"部分。',
  };
}

// 根据季度/年度 NBV 生成结构化解读
function _buildNBVExplanation(quarters, yearlyFY, latestPartial, ttmSeries, sourceNote) {
  if (!quarters.length) return '';

  // 跨年趋势：只用全年年报口径
  const firstYear = yearlyFY[0]?.year;
  const lastFullYear = yearlyFY[yearlyFY.length - 1]?.year;
  const firstVal = yearlyFY[0]?.value;
  const lastFullVal = yearlyFY[yearlyFY.length - 1]?.value;
  const totalChange = firstVal > 0 && lastFullVal > 0
    ? round2((lastFullVal - firstVal) / firstVal * 100)
    : 0;

  // 年度极值
  const sortedYearly = yearlyFY.slice().sort((a, b) => b.value - a.value);
  const peakYear = sortedYearly[0];
  const troughYear = sortedYearly[sortedYearly.length - 1];

  // 最近年报同比
  const latest = yearlyFY[yearlyFY.length - 1];
  const prevYear = yearlyFY[yearlyFY.length - 2];
  const latestYoY = prevYear && prevYear.value > 0
    ? round2((latest.value - prevYear.value) / prevYear.value * 100)
    : null;

  // 单季极值（当季增量）
  const sortedQ = quarters.slice().sort((a, b) => b.value - a.value);
  const peakQ = sortedQ[0];
  const troughQ = sortedQ[sortedQ.length - 1];

  // 季节性：用完整年份数量做平均
  const fullYearCount = yearlyFY.length || 1;
  const season = {};
  for (const q of quarters) {
    // 只纳入有完整 FY 的年份做季节平均，避免 2026 部分年份扭曲
    if (!latestPartial || q.year !== latestPartial.year) {
      season[q.quarter] = (season[q.quarter] || 0) + q.value;
    }
  }
  const seasonAvg = Object.entries(season).map(([k, v]) => ({
    quarter: k,
    avg: round2(v / fullYearCount),
  })).sort((a, b) => (['Q1', 'Q2', 'Q3', 'Q4'].indexOf(a.quarter) - ['Q1', 'Q2', 'Q3', 'Q4'].indexOf(b.quarter)));
  const strongestSeason = seasonAvg.length ? seasonAvg.reduce((a, b) => a.avg > b.avg ? a : b) : null;
  const weakestSeason = seasonAvg.length ? seasonAvg.reduce((a, b) => a.avg < b.avg ? a : b) : null;

  // 最新 TTM 滚动值（含 2026）
  const latestTTM = ttmSeries && ttmSeries.length ? ttmSeries[ttmSeries.length - 1] : null;
  const prevTTM = ttmSeries && ttmSeries.length >= 5 ? ttmSeries[ttmSeries.length - 5] : null; // 同比：前推 4 个季度
  const ttmYoY = latestTTM && prevTTM && prevTTM.value > 0
    ? round2((latestTTM.value - prevTTM.value) / prevTTM.value * 100)
    : null;

  let text = '';
  if (firstYear && lastFullYear && firstVal != null && lastFullVal != null) {
    text += `寿险及健康险 NBV 从 ${firstYear} 年 ${firstVal} 亿变化至 ${lastFullYear} 年 ${lastFullVal} 亿，累计变动 ${totalChange >= 0 ? '+' : ''}${totalChange}%。`;
  }
  if (peakYear && troughYear) {
    text += ` 年度高点为 ${peakYear.year} 年 ${peakYear.value} 亿，低点为 ${troughYear.year} 年 ${troughYear.value} 亿。`;
  }
  if (latestYoY != null) text += ` ${lastFullYear} 年同比 ${latestYoY >= 0 ? '+' : ''}${latestYoY}%。`;
  if (latestPartial) {
    text += ` ${latestPartial.year} 年已披露至 ${latestPartial.stage} 累计 ${latestPartial.value} 亿（部分年度，非全年）。`;
  }
  text += ` 单季增量高点为 ${peakQ.label} 的 ${peakQ.value} 亿，低点为 ${troughQ.label} 的 ${troughQ.value} 亿。`;
  if (strongestSeason && weakestSeason) {
    text += ` 季节规律上，${strongestSeason.quarter} 通常最强（近 ${fullYearCount} 年均值 ${strongestSeason.avg} 亿），${weakestSeason.quarter} 最弱（均值 ${weakestSeason.avg} 亿）。`;
  }
  if (latestTTM) {
    text += ` TTM 滚动 12 个月最新值 ${latestTTM.value} 亿（${latestTTM.label}）`;
    if (ttmYoY != null) text += `，同比 ${ttmYoY >= 0 ? '+' : ''}${ttmYoY}%`;
    text += '；该口径已纳入 2026 年中报数据，可与行情软件趋势图直接对照。';
  }
  if (sourceNote) text += ` ${sourceNote}`;
  return text;
}

// Analyze combined ratio (综合成本率) — 优先使用真实披露值
function analyzeCombinedRatio(symbol, operations, metrics) {
  const real = INSURANCE_REAL_DATA[symbol]?.combinedRatio;
  if (real && real.data && real.data.length) {
    const data = sortByReportPeriod(
      real.data.map(d => ({ year: d.period, label: d.label, value: d.value, source: real.source }))
    );
    return {
      data,
      hasData: true,
      isEstimated: false,
      industryBenchmark: 98.5, // 行业平均综合成本率（产险）
      source: real.source,
      note: `综合成本率(产险业务)。数据来源：${real.source}。`,
    };
  }

  // 回退：运营数据或利润表 TTM 流量估算（仅当结果落在合理区间 80~120% 才展示，避免量级错误）
  let ratioData = operations.combinedRatio;
  if (ratioData.length === 0 && metrics) {
    const yearMap = new Map();
    for (const r of (metrics.earnedPremium || [])) if (!yearMap.has(r.year)) yearMap.set(r.year, { year: r.year });
    const byYear = y => yearMap.get(y) || (yearMap.set(y, { year: y }), yearMap.get(y));
    for (const r of (metrics.earnedPremium || [])) byYear(r.year).earnedPremium = r.value;
    for (const r of (metrics.claimPayments || [])) byYear(r.year).claims = r.value;
    for (const r of (metrics.reserveChange || [])) byYear(r.year).reserveChange = r.value;
    for (const r of (metrics.commissionExpense || [])) byYear(r.year).commission = r.value;
    ratioData = [];
    for (const d of yearMap.values()) {
      if ((d.earnedPremium || 0) > 0) {
        const estimatedRatio = ((d.claims || 0) + (d.reserveChange || 0) + (d.commission || 0)) / d.earnedPremium * 100;
        if (estimatedRatio >= 80 && estimatedRatio <= 120) {
          ratioData.push({ year: d.year, value: Math.round(estimatedRatio * 100) / 100, type: '估算综合成本率', estimated: true });
        }
      }
    }
  }

  ratioData.sort((a, b) => a.year.localeCompare(b.year));
  return {
    data: ratioData,
    hasData: ratioData.length > 0,
    isEstimated: ratioData.some(d => d.estimated),
    industryBenchmark: 98.5,
    note: ratioData.some(d => d.estimated)
      ? '⚠️ 综合成本率为估算值（基于利润表 TTM 数据计算），实际数据请参考公司年报。'
      : '综合成本率数据暂未覆盖，需公司披露或专业数据源。',
  };
}

// Analyze investment yield (总投资收益率) — 优先使用真实披露值
function analyzeInvestmentYield(symbol, operations, metrics, balance) {
  const real = INSURANCE_REAL_DATA[symbol]?.investmentYield;
  if (real && real.data && real.data.length) {
    const data = sortByReportPeriod(
      real.data.map(d => ({ year: d.period, label: d.label, value: d.value, source: real.source }))
    );
    return {
      data,
      hasData: true,
      isEstimated: false,
      industryBenchmark: 5.0, // 行业平均总投资收益率
      source: real.source,
      metricName: '总投资收益率',
      note: `年化总投资收益率（%）。数据来源：${real.source}。口径：保险行业惯例按「年化」披露（interim 报告年化）；2020-2023 及 2025 中报前为年报/季报披露年化值，2024-2025 年报及 2026 各期为券商测算（总投资收益/平均投资资产），2026Q1/H1 由单季非年化值按期间年化推算，不可与早年直接等同。行业基准线=5.0%（行业平均总投资收益率）。`,
    };
  }

  // 回退：投资收益（TTM）/ 投资资产估算，仅保留 2%~12% 区间内的合理值
  let yieldData = operations.investmentYield;
  if (yieldData.length === 0 && metrics && (metrics.investmentIncome || []).length > 0) {
    const balByYear = new Map();
    for (const b of (balance || [])) {
      const y = b.REPORT_DATE ? b.REPORT_DATE.substring(0, 4) : '';
      if (!y) continue;
      const st = _reportStage(b.REPORT_DATE_NAME || '');
      const order = st === 'FY' ? 9 : (_STAGE_ORDER[st] || 0);
      const cur = balByYear.get(y);
      if (!cur || order > (cur.order || 0)) {
        balByYear.set(y, { order, totalAssets: toYi(b.TOTAL_ASSETS || 0) });
      }
    }
    yieldData = [];
    for (const ii of metrics.investmentIncome) {
      const totalAssets = balByYear.get(ii.year)?.totalAssets || 0;
      const investmentAssets = totalAssets > 0 ? totalAssets * 0.75 : 0;
      if (investmentAssets > 0 && ii.value > 0) {
        const estimatedYield = (ii.value / investmentAssets * 100);
        if (estimatedYield >= 2 && estimatedYield <= 12) {
          yieldData.push({ year: ii.year, value: Math.round(estimatedYield * 100) / 100, type: '估算投资收益率', estimated: true });
        }
      }
    }
  }

  yieldData.sort((a, b) => a.year.localeCompare(b.year));
  return {
    data: yieldData,
    hasData: yieldData.length > 0,
    isEstimated: yieldData.some(d => d.estimated),
    industryBenchmark: 5.0,
    metricName: '投资收益率',
    note: yieldData.some(d => d.estimated)
      ? '⚠️ 投资收益率为估算值（收益取 TTM，资产取当年最新资产负债表），实际数据请参考公司年报。'
      : '投资收益率数据暂未覆盖，需公司披露或专业数据源。',
  };
}

// Analyze operating profit vs net profit
function analyzeProfitComparison(metrics) {
  const opProfit = metrics.operatingProfit;
  const netProfit = metrics.netProfit;
  
  // Merge by year
  const yearMap = new Map();
  for (const p of opProfit) {
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year });
    yearMap.get(p.year).operatingProfit = p.value;
  }
  for (const p of netProfit) {
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year });
    yearMap.get(p.year).netProfit = p.value;
  }
  
  const data = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate difference and ratio
  for (const d of data) {
    d.difference = (d.operatingProfit || 0) - (d.netProfit || 0);
    d.ratio = d.netProfit > 0 && d.operatingProfit > 0 
      ? (d.netProfit / d.operatingProfit * 100) 
      : 0;
  }
  
  return {
    data,
    hasData: data.length > 0,
    trendNote: analyzeProfitTrend(data),
  };
}

function analyzeProfitTrend(data) {
  if (data.length < 2) return '';
  
  const latest = data[data.length - 1];
  const prev = data[data.length - 2];
  
  const opGrowth = prev.operatingProfit > 0 
    ? ((latest.operatingProfit - prev.operatingProfit) / prev.operatingProfit * 100) 
    : 0;
  const netGrowth = prev.netProfit > 0 
    ? ((latest.netProfit - prev.netProfit) / prev.netProfit * 100) 
    : 0;
  
  if (Math.abs(opGrowth - netGrowth) > 10) {
    return `营运利润增长${opGrowth.toFixed(2)}%与净利润增长${netGrowth.toFixed(2)}%趋势不一致，差异${Math.abs(opGrowth - netGrowth).toFixed(2)}个百分点。可能原因：投资收益波动、资产减值、一次性损益、或会计政策变更。建议查看年报附注了解差异详情。`;
  }
  return `营运利润与净利润增长趋势基本一致，说明公司盈利质量较高。`;
}

// P/EV (Price to Embedded Value) valuation
function calculatePEV(operations, quote, balance, shareholders) {
  let evData = operations.embeddedValue;
  
  // If no operational data, try to estimate from net assets
  // For insurance companies, embedded value > net assets (includes value of in-force business)
  // Typically EV ≈ 1.1-1.5x net assets for life insurance
  if (evData.length === 0 && balance.length > 0) {
    evData = balance.map(b => {
      const year = b.REPORT_DATE ? b.REPORT_DATE.substring(0, 4) : '';
      const netAssets = toYi(b.TOTAL_PARENT_EQUITY || b.TOTAL_EQUITY || 0);
      return { year, value: netAssets * 1.2, type: '估算内含价值', estimated: true };
    });
  }
  
  evData.sort((a, b) => a.year.localeCompare(b.year));
  
  const latestEV = evData[evData.length - 1];
  // quote.totalValue is total market cap in 亿 (from Tencent API)
  // shareholders.totalMarketCap is in 元 (from push2 API, may not be available)
  const marketCapYi = quote?.totalValue || toYi(shareholders?.totalMarketCap || 0);
  
  const pev = latestEV && latestEV.value > 0 && marketCapYi > 0
    ? Math.round(marketCapYi / latestEV.value * 100) / 100
    : 0;
  
  // P/EV historical
  const pevHistory = [];
  for (const ev of evData) {
    pevHistory.push({ year: ev.year, ev: ev.value, estimated: ev.estimated });
  }
  
  return {
    currentPEV: pev,
    latestEV: latestEV?.value || 0,
    marketCap: marketCapYi,
    evHistory: pevHistory,
    isEstimated: latestEV?.estimated || false,
    interpretation: interpretPEV(pev),
    note: latestEV?.estimated 
      ? '⚠️ 内含价值为估算值（基于归母净资产的1.2倍），实际数据请参考公司年报中的"内含价值"部分。'
      : '',
  };
}

function interpretPEV(pev) {
  if (pev <= 0) return '数据不足，无法计算P/EV';
  if (pev < 0.5) return 'P/EV < 0.5，严重低估。市场可能对公司未来增长极度悲观，或存在隐性风险。';
  if (pev < 0.8) return 'P/EV 0.5-0.8，低估。当前股价低于内含价值，具备投资价值。';
  if (pev < 1.0) return 'P/EV 0.8-1.0，合理偏低。股价接近内含价值，安全边际有限。';
  if (pev < 1.5) return 'P/EV 1.0-1.5，合理估值。市场对公司未来增长持中性预期。';
  if (pev < 2.0) return 'P/EV 1.5-2.0，偏高估值。市场对公司未来增长有较高预期。';
  return 'P/EV > 2.0，高估。需警惕估值回调风险。';
}

// DDM (Dividend Discount Model) valuation
function calculateDDM(dividends, netProfits, quote, shareholders) {
  // dividends array now has: { year, dividendPerShare, totalShares, dividend (total amount in 元) }
  // Build merged data by year
  const yearMap = new Map();
  
  for (const d of dividends) {
    if (!d.year) continue;
    if (!yearMap.has(d.year)) yearMap.set(d.year, { year: d.year, dps: 0, dividend: 0, netProfit: 0 });
    const entry = yearMap.get(d.year);
    // Use dividendPerShare if available, otherwise calculate from total
    if (d.dividendPerShare) {
      entry.dps += d.dividendPerShare; // Accumulate (multiple dividends per year)
    } else if (d.dividend && d.totalShares) {
      entry.dps += d.dividend / d.totalShares;
    }
    entry.dividend += d.dividend || 0;
  }
  for (const p of netProfits) {
    if (!p.year) continue;
    if (!yearMap.has(p.year)) yearMap.set(p.year, { year: p.year, dps: 0, dividend: 0, netProfit: 0 });
    yearMap.get(p.year).netProfit = p.value || 0;
  }
  
  const data = Array.from(yearMap.values()).sort((a, b) => a.year.localeCompare(b.year));
  
  // Calculate payout ratio
  for (const d of data) {
    // netProfit is in 亿, dividend is in 元
    const npYuan = d.netProfit * 1e8;
    d.payoutRatio = npYuan > 0 && d.dividend > 0 ? (d.dividend / npYuan * 100) : 0;
  }
  
  // Calculate average dividend growth rate (based on DPS)
  // Only use records where DPS > 0 to avoid skewed growth from zero dividends
  const dpsData = data.filter(d => d.dps > 0);
  const growthRates = [];
  for (let i = 1; i < dpsData.length; i++) {
    if (dpsData[i - 1].dps > 0) {
      growthRates.push((dpsData[i].dps / dpsData[i - 1].dps - 1) * 100);
    }
  }
  const avgGrowth = growthRates.length > 0 
    ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length 
    : 5; // Default 5%
  
  // Average payout ratio
  const avgPayout = data.length > 0
    ? data.reduce((sum, d) => sum + (d.payoutRatio || 0), 0) / data.length
    : 30;
  
  // Latest DPS
  const latestDPS = data.length > 0 ? data[data.length - 1].dps : 0;
  
  // DDM with two-stage model
  const discountRate = 0.10; // 10% discount rate
  const terminalGrowth = 0.03; // 3% perpetual growth
  const highGrowthYears = 10;
  const highGrowth = Math.max(0, Math.min(avgGrowth / 100, 0.15)); // Cap at 15%
  
  let intrinsicValue = 0;
  let currentDPS = latestDPS;
  
  // Stage 1: High growth period
  for (let i = 1; i <= highGrowthYears; i++) {
    currentDPS *= (1 + highGrowth);
    intrinsicValue += currentDPS / Math.pow(1 + discountRate, i);
  }
  
  // Stage 2: Terminal value
  const terminalDPS = currentDPS * (1 + terminalGrowth);
  const terminalValue = terminalDPS / (discountRate - terminalGrowth);
  intrinsicValue += terminalValue / Math.pow(1 + discountRate, highGrowthYears);
  
  const currentPrice = quote?.price || 0;
  const premium = currentPrice > 0 && intrinsicValue > 0
    ? Math.round((currentPrice / intrinsicValue - 1) * 10000) / 100
    : 0;
  
  return {
    model: '两阶段股息贴现模型 (DDM)',
    latestDPS: Math.round(latestDPS * 100) / 100,
    avgGrowth: Math.round(avgGrowth * 100) / 100,
    avgPayout: Math.round(avgPayout * 100) / 100,
    discountRate: discountRate * 100,
    terminalGrowth: terminalGrowth * 100,
    highGrowthYears,
    intrinsicValue: Math.round(intrinsicValue * 100) / 100,
    currentPrice,
    premium,
    // 20261016b 三档铁律：原五档（含「合理偏低」「偏高」两个非标准档）→ 严格三档；
    // 「合理偏低」并入「合理」，「偏高」并入「高估」，阈值取原相邻边界，不新增分档。
    rating: intrinsicValue <= 0 ? '数据不足' : premium < -20 ? '低估' : premium < 20 ? '合理' : '高估',
    dividendHistory: data,
    note: latestDPS === 0 
      ? '⚠️ 未获取到分红数据，DDM估值结果仅供参考。'
      : '',
  };
}

// Analyze operating profit vs net profit divergence
function analyzeProfitDivergence(metrics) {
  const comparison = analyzeProfitComparison(metrics);
  if (!comparison.hasData) return null;
  
  const latest = comparison.data[comparison.data.length - 1];
  const divergence = latest.difference;
  const divergencePct = latest.operatingProfit > 0 
    ? (divergence / latest.operatingProfit * 100) 
    : 0;
  
  return {
    ...comparison,
    latestDivergence: divergence,
    divergencePct,
    isSignificant: Math.abs(divergencePct) > 15,
    note: Math.abs(divergencePct) > 15
      ? `⚠️ 营运利润与净利润差异${Math.abs(divergencePct).toFixed(1)}%，差异较大。可能涉及：短期投资波动、资产减值损失、一次性损益项目。建议深入分析利润表非经常性项目。`
      : '营运利润与净利润差异在正常范围内。',
  };
}

// Main insurance analysis function
async function analyzeInsuranceCompany(emCode, symbol, name, quote, income, balance, cashflow, shareholders, dividends, segmentData) {
  console.log(`[InsuranceAnalysis] Starting for ${symbol} (${name})...`);
  
  // Fetch insurance-specific operational data
  const operations = await fetchInsuranceOperations(emCode);
  
  // Extract insurance metrics from financial statements
  const metrics = extractInsuranceMetricsFromStatements(income, balance);
  
  // Run all insurance-specific analyses
  const premiumAnalysis = analyzePremiumTrends(metrics, operations, symbol);
  const nbvAnalysis = analyzeNBV(symbol);
  const combinedRatioAnalysis = analyzeCombinedRatio(symbol, operations, metrics);
  const investmentYieldAnalysis = analyzeInvestmentYield(symbol, operations, metrics, balance);
  const profitDivergence = analyzeProfitDivergence(metrics);
  const pevValuation = calculatePEV(operations, quote, balance, shareholders);
  const ddmValuation = calculateDDM(dividends, metrics.netProfit, quote, shareholders);
  // 分业务趋势（寿险/财产险来自集团年报分业务披露；养老/健康来自原保险保费收入公告；NBV 来自年报）
  const businessLines = buildBusinessLines(segmentData, symbol);
  
  return {
    isInsurance: true,
    companyName: name,
    symbol,
    sections: {
      premiumAnalysis,
      nbvAnalysis,
      combinedRatioAnalysis,
      investmentYieldAnalysis,
      profitDivergence,
      pevValuation,
      ddmValuation,
      businessLines,
    },
  };
}

// Helper: convert to 亿 (100 million), handles null/undefined
function toYi(n) {
  if (n === null || n === undefined || isNaN(n)) return 0;
  return Math.round(parseFloat(n) / 1e8 * 100) / 100;
}

// ─── 20261029a：NBV 最新快照（关键财务指标「NBV(新业务价值)」行数据源）───
// 仅 INSURANCE_REAL_DATA 中登记了 nbv.cumulative 的公司有数据（当前仅 601318 中国平安）；
// 非保险股 / 无备查库数据 → 返回 null（前端整行不渲染，绝不把平安数据泄漏到其它公司）。
// 同比口径：与「去年同期同累计阶段」比（如 2026H1 248.5亿 vs 2025H1 223.4亿，同为中报累计），
// 跨阶段不可比；缺同期 → yoyPct=null 如实不可得。
function latestNbvSnapshot(symbol) {
  const code = String(symbol || '').replace(/^(SH|SZ)/i, '');
  const real = INSURANCE_REAL_DATA[code] && INSURANCE_REAL_DATA[code].nbv;
  if (!real || !Array.isArray(real.cumulative) || !real.cumulative.length) return null;
  const latest = real.cumulative[real.cumulative.length - 1];
  const m = /^(\d{4})(Q1|H1|Q3|FY)$/.exec(latest.period || '');
  let yoyPct = null, prev = null, prevLabel = null;
  if (m) {
    const tgt = (parseInt(m[1], 10) - 1) + m[2];
    prev = real.cumulative.find(c => c.period === tgt) || null;
    if (prev && prev.value > 0) {
      yoyPct = Math.round((latest.value - prev.value) / prev.value * 100 * 100) / 100;
      prevLabel = prev.label;
    }
  }
  const stageName = m ? ({ Q1: '一季报', H1: '中报', Q3: '三季报', FY: '年报' }[m[2]] || '') : '';
  return {
    symbol: code,
    valueYi: latest.value,
    period: latest.period,
    label: latest.label,
    periodText: m ? `${m[1]}年${stageName}` : (latest.label || ''),
    yoyPct,
    prevValueYi: prev ? prev.value : null,
    prevLabel,
    source: real.source,
    assumptionNote: real.note || '',
  };
}

module.exports = {
  isInsuranceCompany,
  analyzeInsuranceCompany,
  extractInsuranceMetricsFromStatements,
  latestNbvSnapshot,
};

~~~

---

## `lib\localDate.js`  ·  94 行

~~~js
/**
 * 中国自然日 / 交易日日期工具（lib/localDate.js）
 * --------------------------------------------------------------
 * 背景（为什么需要它）：
 *   `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日期**。在 UTC+8 下，
 *   每天北京时间 00:00–07:59 这段时间里，UTC 日期比北京日期晚一天，于是：
 *     - 交易台账/事件/缓存 的「今天」会写成昨天 → 记录错位、幂等判断失效；
 *     - 估值基准日、板块快照日期、新闻日期 也会整体前移一天。
 *   白天（08:00 之后）两者一致，所以这个 bug 长期隐蔽、只在早盘前段暴露。
 *
 * 设计要点：
 *   1. 时区固定为 Asia/Shanghai（UTC+8，无夏令时），**不依赖宿主机时区设置**；
 *      即使机器时区被改成 UTC 或别的时区，取到的仍是正确的中国自然日。
 *   2. 用 Intl.DateTimeFormat + formatToParts（缓存实例），避免自算偏移出错。
 *   3. hour 用 hourCycle 'h23'，保证午夜是 00:00 而不是 24:00。
 *
 * 用法：
 *   const { localDate, localDateTime, localCompact, localDateFromTs } = require('./localDate');
 *   localDate()                      // '2026-09-17'（此刻的中国自然日）
 *   localDate(new Date('...'))       // 指定时刻的中国自然日
 *   localDateTime(msOrDate)          // '2026-09-17 18:39'
 *   localCompact(msOrDate)           // '20260917'（东财等接口的 beg/end 参数）
 *   localDateFromTs(1758100000)      // 秒级时间戳 → '2026-09-17'（自动识别秒/毫秒）
 */
const TZ = 'Asia/Shanghai';

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false, hourCycle: 'h23',
});

/** 归一化为 Date；无法解析时返回 null */
function _toDate(input) {
  if (input === undefined || input === null) return new Date();
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

/** 拆出中国时区的年月日时分：{ year, month, day, hour, minute }；不可解析返回 null */
function bjParts(input) {
  const d = _toDate(input);
  if (!d) return null;
  const out = {};
  for (const p of _fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** 'YYYY-MM-DD'（中国自然日） */
function localDate(input) {
  const p = bjParts(input);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** 'YYYY-MM-DD HH:mm'（中国本地时间，用于展示） */
function localDateTime(input) {
  const p = bjParts(input);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '';
}

/** 'YYYYMMDD'（东财等接口的日期参数格式） */
function localCompact(input) {
  const p = bjParts(input);
  return p ? `${p.year}${p.month}${p.day}` : '';
}

/** 时间戳 → 中国自然日；自动兼容秒级（<1e12）与毫秒级 */
function localDateFromTs(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  return localDate(n < 1e12 ? n * 1000 : n);
}

/** 时间戳 → 'YYYY-MM-DD HH:mm'；自动兼容秒级与毫秒级 */
function localDateTimeFromTs(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  return localDateTime(n < 1e12 ? n * 1000 : n);
}

module.exports = {
  TZ,
  bjParts,
  localDate,
  localDateTime,
  localCompact,
  localDateFromTs,
  localDateTimeFromTs,
};

~~~

---

## `lib\longTermJudgment.js`  ·  467 行

~~~js
/**
 * 长期行情判断引擎（长期走势 / 价值取向，非次日涨跌）
 * --------------------------------------------------------------
 * 与「短期行情」不同，本模块回答的是「这只股票中长期（约 3~12 个月）是否值得看多」，
 * 不做次日涨跌预测，也暂不核算准确率。四因子：
 *   1) 公司基本面      (fundamentalAnalysis：估值/盈利/成长/财务健康综合评分)
 *   2) 行业前景        (industryAnalysis.policy：国家政策扶持级别与规划)
 *   3) 对标期货长期走势 (futuresData：期货长期区间涨跌幅 × 与股价相关性)
 *   4) 大盘及行业中长期走势 (按个股市场筛主要指数 60 日趋势 + 个股所属行业板块 + 首页大盘技术分析模块中期研判)
 *
 * 更新机制：每次打开工作台（前端请求本模块）即时重算：基本面/指数/期货为确定性接口抓取，
 * 行业前景因子取自内置静态政策库（INDUSTRY_POLICY，非联网、非 AI）；
 * 不落盘历史、不核算准确率。仅做进程内短时缓存（约 5 分钟）避免重复请求。
 *
 * 每个因子同样给出：方向(+1 看多 / -1 看空 / 0 中性)、权重、贡献分、取值、判断依据文字，
 * 保证「判断逻辑」完全可查看。
 *
 * 20260905d：第 4 个因子（大盘及行业中长期走势）：
 *   - 大盘指数部分从「全 4 指数平均」改为「按个股市场筛」：
 *     SH → 上证/上证50/沪深300；SZ → 深证成指/创业板指/沪深300；其他→ 全部 4 指数。
 *   - 同时把首页大盘技术分析模块（lib/marketTechnical）对这几个指数的「中期研判」注入 detail。
 *   - 「个股所属行业板块」部分完全保留原逻辑（20260821c / 用户明确要求不改）。
 */

const { getQuote, getHistory, getHistoryDeep, getMarketOverview, detectMarket } = require('./stockData');
const { fundamentalAnalysis } = require('./analysis');
const { classifyCompanyType } = require('./companyType');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./futuresData');
const { industryAnalysis } = require('./industryAnalysis');
const { resolveSectorIdentity } = require('./sectorIdentity');
const { getSectorTrend } = require('./sectorTrend');
const { getNews } = require('./newsSearch');
const { analyzePriceAction } = require('./priceAction'); // 20260903o：技术面长期趋势因子引用其 longTerm（现作为 hub 失败时的本地回退）
const { getPriceActionSnapshot } = require('./priceActionHub'); // 20260905g：与技术面分析页共用同一份快照（指标级单源）
const { withImpact, clamp } = require('./ruleCore');
const eventEngine = require('./eventEngine'); // 20260907a：三联动·事件驱动权重引擎
const dedicatedFactor = require('./dedicatedFactor'); // 20260911：专属因子（海天味业CPI等）
// 20260905d：大盘及行业中长期走势因子联动首页大盘技术分析模块中期研判
const { getMarketTechnical } = require('./marketTechnical');
// 20260905e：按个股真实成分股判定上证50/创业板指/沪深300（与短期因子同源）
const { SSE50_CONSTITUENTS, isMemberOf } = require('./indexConstituents');

// ---- 工具 ----
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function normSymbol(s) { return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase(); }

const VERDICT_LABEL = { 涨: '看多', 跌: '看空', 震荡: '中性' };

// ---- 单因子计算 ----

// 1) 公司基本面：复用 fundamentalAnalysis 的综合评分（50 分 → 中性，100 → 强看多，0 → 强看空）
function factorFundamentals(fund) {
  if (fund && typeof fund.score === 'number') {
    const signal = clamp((fund.score - 50) / 50, -1, 1);
    const detail = `基本面综合评分 ${fund.score}/100（${fund.overall || '—'}，评级 ${fund.rating || '—'}）` +
      (fund.description ? `；${fund.description}` : '') +
      (fund.companyTypeName ? `；按「${fund.companyTypeName}」口径加权` : '');
    return { key: 'fundamentals', name: '公司基本面', weight: 0.280, signal, applicable: true,
      value: `${fund.score}/100 · ${fund.overall || '—'}`, detail };
  }
  return { key: 'fundamentals', name: '公司基本面', weight: 0.280, signal: 0, applicable: true,
    value: '—', detail: '基本面数据不足，按中性处理' };
}

// 2) 行业前景：industryAnalysis.policy 的国家政策扶持级别
function factorIndustryPolicy(policy) {
  if (policy && policy.level) {
    let signal = 0;
    const lv = policy.level;
    if (lv.includes('国家战略扶持')) signal = 1;
    else if (lv.includes('战略扶持')) signal = 0.7;
    else if (lv.includes('中性')) signal = 0;
    else if (lv.includes('受限')) signal = -0.7;
    const plans = (Array.isArray(policy.plans) && policy.plans.length) ? policy.plans.slice(0, 3).join('；') : '';
    const detail = `行业政策定位「${lv}」${plans ? '；' + plans : ''}` +
      (policy.summary ? `；${policy.summary}` : '');
    return { key: 'industry', name: '行业前景', weight: 0.200, signal, applicable: true,
      value: lv, detail };
  }
  return { key: 'industry', name: '行业前景', weight: 0.200, signal: 0, applicable: true,
    value: '—', detail: '行业政策信息不足，按中性处理' };
}

// 3) 对标期货长期走势：期货长期区间涨跌幅（整个统计区间）× 相关性强度
function factorFuturesLong(futures) {
  if (futures && futures.hasFutures && typeof futures.futuresChg === 'number') {
    const corr = typeof futures.correlation === 'number' ? futures.correlation : 0;
    // 方向语义修正（20260901a，与短期同源）：corr 为皮尔逊相关系数，可为负。
    // 原实现只取 |corr| 作强度，负相关个股方向被判反（期货涨却判该股看多）。
    const corrStrength = Math.abs(corr) >= 0.6 ? 1 : (Math.abs(corr) >= 0.35 ? 0.7 : (Math.abs(corr) >= 0.15 ? 0.4 : 0.2));
    const corrSigned = corrStrength * (corr >= 0 ? 1 : -1);
    const chg = futures.futuresChg;
    // 长期阈值更大（期货长期 ±15% 视为满格）
    const signal = clamp(chg / 15, -1, 1) * corrSigned;
    const detail = `对标 ${futures.futuresName || '期货'} 统计区间 ${chg >= 0 ? '+' : ''}${round(chg)}%（相关性 ${round(corr, 2)}，${futures.level || '—'}${futures.direction || ''}相关）→ ${signal > 0.05 ? '该股偏多' : signal < -0.05 ? '该股偏空' : '该股中性'}`;
    const value = `${chg >= 0 ? '+' : ''}${round(chg)}%`;
    return { key: 'futures', name: '对标期货长期走势', weight: 0.120, signal, applicable: true, value, detail };
  }
  return { key: 'futures', name: '对标期货长期走势', weight: 0.120, signal: 0, applicable: false,
    value: '不适用', detail: '该公司无直接对标期货，本因子不参与打分' };
}

// 4) 大盘及行业中长期走势：按个股市场筛主要指数 60 日趋势 + 所属行业板块 + 首页大盘技术分析模块中期研判
//    20260905d：因子名改为「大盘及行业中长期走势」；指数范围按个股市场筛选。
//    20260905e：与短期因子同步——按个股真实成分股判定上证50/创业板指/沪深300：
//      士兰微 600460 → 上证指数(沪市) + 沪深300(在 300 名单)；不取上证50(不在 50 名单)。
//    所属行业板块（sector）部分完全保留原逻辑（20260821c 起），用户明确要求不要修改。
async function selectLongIndicesByStock(idxs, symbol) {
  const haveIdx = (idxs || []).filter(i => typeof i.chg60d === 'number');
  if (!haveIdx.length) return { indices: [], scopeLabel: '—' };
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
  const isSH = /^[69]/.test(code);
  const isSZ = /^[03]/.test(code);
  const isCyb = /^3/.test(code);
  // 1) 决定候选指数名（按市场 + 真实成分股）
  const wantNames = [];
  if (isSH) {
    wantNames.push('上证指数');
    if (SSE50_CONSTITUENTS.includes(code)) wantNames.push('上证50');
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else if (isSZ) {
    wantNames.push('深证成指');
    if (isCyb && await isMemberOf(code, 'cyb')) wantNames.push('创业板指');
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else {
    // 非 A 股
    return { indices: haveIdx, scopeLabel: '上证/深成指/创业板/沪深300（个股非 A 股，退回到全宽基）' };
  }
  const picked = wantNames.map(n => haveIdx.find(i => i.name === n)).filter(Boolean);
  if (!picked.length) return { indices: haveIdx, scopeLabel: wantNames.join('/') + '（个别指数缺失，已回退）' };
  return { indices: picked, scopeLabel: wantNames.join('/') };
}

function midDirectionToSignal(direction) {
  if (direction === '看多') return 1;
  if (direction === '看空') return -1;
  return 0;
}

function factorMarketLong(marketLong, sector, stockContext) {
  const idxs = (marketLong && Array.isArray(marketLong.indices)) ? marketLong.indices : [];
  const techIndices = (stockContext && stockContext.techIndices) || [];
  // 大盘指数部分：已按真实成分股筛好的（buildLongTermJudgment 预计算）
  const haveIdx = (stockContext && stockContext.selectedIndices) || [];
  const scopeLabel = (stockContext && stockContext.scopeLabel) || '—';
  let detail = '';
  let value = '';
  if (haveIdx.length) {
    const avg60 = avg(haveIdx.map(i => i.chg60d));
    // 指数部分信号
    const idxSignal = clamp(avg60 / 12, -1, 1);
    // 行业板块部分（当日板块涨跌，作为行业长期的最新状态）—— 保留原逻辑不动
    const secOk = sector && sector.ok && typeof sector.boardChange === 'number';
    const secChg = secOk ? sector.boardChange : 0;
    const secSignal = secOk ? clamp(secChg / 5, -1, 1) : 0;
    const signal = clamp(0.6 * idxSignal + 0.4 * secSignal, -1, 1);

    // 首页大盘技术分析模块的中期研判（看多/看空/震荡），取与个股同市场的指数，取均值。
    const techByName = new Map();
    for (const t of techIndices) { if (t && t.name) techByName.set(t.name, t); }
    const techPicks = haveIdx.map(idx => {
      const tech = techByName.get(idx.name);
      if (!tech || !tech.step6 || !tech.step6.midTerm) return null;
      return { name: idx.name, direction: tech.step6.midTerm.direction };
    }).filter(Boolean);
    const techSigSum = techPicks.reduce((s, p) => s + midDirectionToSignal(p.direction), 0);
    const techSigAvg = techPicks.length ? techSigSum / techPicks.length : 0;
    const techVerdict = techSigAvg > 0.34 ? '看多' : techSigAvg < -0.34 ? '看空' : '震荡';
    const techDetail = techPicks.length
      ? techPicks.map(p => `${p.name}${p.direction}`).join('、')
      : '暂未提供与该股同市场的中期研判';

    detail = `${scopeLabel} 60 日平均 ${avg60 >= 0 ? '+' : ''}${round(avg60)}%（${haveIdx.map(i => `${i.name}${i.chg60d >= 0 ? '+' : ''}${round(i.chg60d)}%`).join('、')}）；中期研判：${techVerdict}（${techDetail}）` +
      (secOk ? `；所属「${sector.boardName || sector.industryName}」板块 ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${sector.upCount}/跌 ${sector.downCount}）` : '；行业板块数据暂缺');
    value = `指数60日 ${avg60 >= 0 ? '+' : ''}${round(avg60)}%`;
    return { key: 'market', name: '大盘及行业中长期走势', weight: 0.200, signal, applicable: true, value, detail };
  }
  return { key: 'market', name: '大盘及行业中长期走势', weight: 0.200, signal: 0, applicable: true,
    value: '—', detail: '指数长期数据不可用，按中性处理' };
}

// 5) 技术面长期趋势：引用价格行为趋势推演（lib/priceAction.analyzePriceAction）的 longTerm 输出，
// 与「技术面分析」页同源，保证数据一致性（规则一·指标级单源）。
// 权重暂定 0.200（与其他 4 因子等比缩放后合计=1.000），长期模块当前无准确率结算/自学习层（与既有设计一致）。
function factorTechnicalLong(pa) {
  const ltx = pa && pa.longTerm ? pa.longTerm : null;
  if (!ltx || typeof ltx.score !== 'number') {
    return {
      key: 'technicalLong', name: '个股长期趋势', weight: 0.200,
      signal: 0, applicable: true, value: '—',
      detail: '个股长期趋势数据不足（K线<250 或价格行为推演未返回长期趋势），按中性处理。来源：价格行为趋势推演（周/月级别）',
    };
  }
  const signal = clamp(round(ltx.score, 3) / 4, -1, 1); // 趋势评分量级约 ±4.5，/4 限幅到 ±1
  const ma250 = ltx.ma250;
  const detail =
    `个股长期趋势：${ltx.verdict}（趋势评分 ${ltx.score}）。` +
    (ma250 ? `年线MA250=${ma250.value}（${ma250.slopeState}，斜率${ma250.slopePct != null ? (ma250.slopePct >= 0 ? '+' : '') + ma250.slopePct : '—'}%，价格偏离${ma250.positionPct != null ? (ma250.positionPct >= 0 ? '+' : '') + ma250.positionPct : '—'}%）` : '年线数据不足') +
    (ltx.ma120 ? `；MA120=${ltx.ma120.value}` : '') +
    `；月线MACD=${ltx.monthlyMacd && ltx.monthlyMacd.zeroPos ? ltx.monthlyMacd.zeroPos : '—'}${ltx.monthlyMacd && ltx.monthlyMacd.lastCross ? `（${ltx.monthlyMacd.lastCross}）` : ''}` +
    `；月线结构=${ltx.structure || '—'}。来源：价格行为趋势推演（周/月级别），与「技术面分析」页同源。`;
  return {
    key: 'technicalLong', name: '个股长期趋势', weight: 0.200,
    signal: round(signal, 3), applicable: true,
    value: ltx.verdict,
    detail,
  };
}

// ---- 汇总（20260907a：支持事件驱动权重覆盖 weightOverride）----
function combineFactors(factors, weightOverride) {
  const used = factors.filter(f => f.applicable);
  const wsum = used.reduce((a, f) => a + (weightOverride && weightOverride[f.key] != null ? weightOverride[f.key] : f.weight), 0) || 1;
  let total = 0;
  const out = factors.map(f => {
    const w = (weightOverride && weightOverride[f.key] != null) ? weightOverride[f.key] : f.weight;
    const eff = f.applicable ? w / wsum : 0;
    const contribution = round(eff * f.signal, 3);
    total += contribution;
    // 影响程度评分：与短期判断共用 ruleCore.withImpact 同一映射（规则一·指标级单源）
    return withImpact({ ...f, effectiveWeight: round(eff, 3), contribution });
  });
  total = round(total, 3);
  let dir = '震荡';
  if (total > 0.12) dir = '涨';
  else if (total < -0.12) dir = '跌';
  const agree = used.filter(f => f.signal !== 0 && Math.sign(f.signal) === Math.sign(total)).length;
  const mag = Math.abs(total);
  let confidence = '低';
  if (mag >= 0.35 && used.length && agree >= Math.ceil(used.length * 0.6)) confidence = '高';
  else if (mag >= 0.2) confidence = '中';
  return { factors: out, totalScore: total, dir, verdict: VERDICT_LABEL[dir], confidence };
}

// ---- 指数 60 日长期趋势 ----
// 拉取主要指数的日线，计算最近 60 个交易日的区间涨跌幅（约 3 个月长期趋势）。
const LONG_INDEX_CODES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000300', name: '沪深300' },
];
async function fetchIndexLongTerm() {
  const indices = await Promise.all(LONG_INDEX_CODES.map(async (idx) => {
    try {
      const hist = await getHistory(idx.code, '1y').catch(() => []);
      if (!hist || hist.length < 60) return { name: idx.name, chg60d: null };
      const last = hist[hist.length - 1];
      const base = hist[hist.length - 60];
      const chg60d = (last.close - base.close) / base.close * 100;
      return { name: idx.name, chg60d: round(chg60d, 2) };
    } catch (e) {
      return { name: idx.name, chg60d: null };
    }
  }));
  return { indices };
}

// ---- 进程内短时缓存（约 5 分钟），避免同一次打开重复联网抓取 ----
let _cache = {}; // key: symbol -> { ts, data }
const CACHE_TTL = 5 * 60 * 1000;

/**
 * 生成长期行情判断。
 * 每次调用都联网抓取最新数据（基本面/行业/新闻/期货/指数），即时重算，不落盘。
 */
async function buildLongTermJudgment(symbol, name) {
  const [quoteR, industryR, sectorIdR, futuresR, marketLongR, sectorR, newsR, dailyR, marketTechR] = await Promise.allSettled([
    getQuote(symbol),
    industryAnalysis(symbol, name || '').catch(() => null),
    resolveSectorIdentity(symbol, name || '').catch(() => null),
    Promise.resolve(getFuturesMeta(symbol) ? fetchFuturesCorrelation(symbol, name || '').catch(() => ({ hasFutures: false })) : { hasFutures: false }),
    fetchIndexLongTerm(),
    getSectorTrend(symbol, name || '', '').catch(() => null),
    getNews(symbol, name || '').catch(() => []),
    getHistoryDeep(symbol, 2400).catch(() => []), // 20260903o：技术面长期趋势因子（与「技术面分析」页同源，需≥250日K）
    getMarketTechnical().catch(() => ({ indices: [] })), // 20260905d：大盘及行业中长期走势因子联动首页大盘技术分析模块中期研判
  ]);

  const quote = quoteR.status === 'fulfilled' ? quoteR.value : null;
  const ind = industryR.status === 'fulfilled' ? industryR.value : null;
  const sectorId = sectorIdR.status === 'fulfilled' ? sectorIdR.value : null;
  const futures = futuresR.status === 'fulfilled' ? futuresR.value : { hasFutures: false };
  const marketLong = marketLongR.status === 'fulfilled' ? marketLongR.value : { indices: [] };
  const sector = sectorR.status === 'fulfilled' ? sectorR.value : null;
  const news = newsR.status === 'fulfilled' ? newsR.value : [];
  const daily = dailyR && dailyR.status === 'fulfilled' ? dailyR.value : [];
  const marketTech = marketTechR && marketTechR.status === 'fulfilled' ? marketTechR.value : { indices: [] };
  // 20260922：取日K历史供事件引擎"内幕抢跑"检查（事件出现前 3 日回溯）；失败不影响主流程
  const history = await getHistory(symbol, '1y').catch(() => []);

  // 公司类型 + 基本面
  const companyType = quote
    ? classifyCompanyType(symbol, name || (quote.name || ''), quote, { income: [], balance: [], cashflow: [] }, null, [])
    : null;
  const fund = quote ? fundamentalAnalysis(quote, companyType) : null;

  // 行业名称：20260821c 统一走 sectorIdentity 单一可信源，industryAnalysis 仅用于政策/研报
  // 20260821e 修复：sectorIdentity 返回的 symbol 已 normalize，必须用 normSymbol 比较，
  // 避免带前缀 symbol 时丢弃正确行业、回退到可能错误的 industryAnalysis 结果。
  const sectorIdMatch = sectorId && normSymbol(sectorId.symbol) === normSymbol(symbol);
  let industryName = sectorIdMatch ? (sectorId.industry || '') : '';
  if (!industryName) {
    industryName = (ind && ind.industry && (ind.industry.name || ind.industry.induName)) || '';
  }

  // 20260910 修复：板块走势定位改用「细分行业名优先」（与 sameDayJudgment 同口径）。
  // 根因：申万一级（如 688660 电气风电=「新能源」）传入 sector_trend.py 后经同义词表泛化扩展
  // （新能源→[光伏,风电,储能,锂电]），候选按列表顺序盲匹配，「光伏」排在「风电」前 → 误命中「光伏设备」。
  // F10 细分行业（f10Name，如「风电设备」）能在同花顺板块列表精确命中，优先使用。
  const fineIndustry = sectorIdMatch ? String(sectorId.f10Name || sectorId.emIndustry || '').trim() : '';

  // 若 sector 未定位板块（industry 为空时），用行业名再试一次
  let sectorData = sector;
  const needRelocate = !sectorData || !sectorData.ok
    || (!!fineIndustry && !!sectorData.boardName && !String(sectorData.boardName).includes(fineIndustry));
  if (needRelocate && (fineIndustry || industryName)) {
    sectorData = await getSectorTrend(symbol, name || '', fineIndustry || industryName).catch(() => null);
  }

  // 20260905g：技术面长期趋势因子改走 priceActionHub 唯一出口——与「技术面分析」页共用
  // 同一份快照与缓存（指标级单源），消除跨页时点错位；hub 失败时回退本地 analyzePriceAction。
  let priceActionLong = null;
  try {
    const paSnap = await getPriceActionSnapshot(symbol);
    if (paSnap && !paSnap.error && paSnap.longTerm) priceActionLong = paSnap;
  } catch (e) { /* 回退本地计算 */ }
  if (!priceActionLong && daily && daily.length >= 250) {
    try { priceActionLong = analyzePriceAction(daily); } catch (e) { priceActionLong = null; }
  }

  // 20260905e：按个股真实成分股筛长期指数（lib/indexConstituents 同源逻辑），一次性算好传入因子。
  let selectedLongIndices = (marketLong && Array.isArray(marketLong.indices)) ? marketLong.indices : [];
  let longScopeLabel = '—';
  try {
    const sel = await selectLongIndicesByStock(marketLong && marketLong.indices, symbol);
    selectedLongIndices = sel.indices || [];
    longScopeLabel = sel.scopeLabel || longScopeLabel;
  } catch (e) {
    console.warn('[LongTermJudgment] selectLongIndicesByStock failed:', e.message);
  }
  const longStockCtx = { symbol, techIndices: marketTech.indices || [], selectedIndices: selectedLongIndices, scopeLabel: longScopeLabel };

  const factors = [
    factorFundamentals(fund),
    factorIndustryPolicy(ind && ind.policy),
    factorFuturesLong(futures),
    factorMarketLong(marketLong, sectorData, longStockCtx),
    factorTechnicalLong(priceActionLong),
  ];

  // 20260907a：叠加「事件驱动」权重覆盖（长期口径）。
  // 既有 5 因子按各自原权重等比例压缩，新增「事件驱动」因子，总和恒为 100%。
  // 20260911：若该股有「专属因子」（如海天味业CPI），一并归并（与短期同机制，零回归）。
  const LONG_KEYS = ['fundamentals', 'industry', 'futures', 'market', 'technicalLong'];
  const longBaseWeights = {};
  for (const f of factors) longBaseWeights[f.key] = f.weight;
  const evLong = eventEngine.buildEventOverride({ symbol, baseWeights: longBaseWeights, factorKeys: LONG_KEYS, horizon: 'long', history });
  const dedLong = dedicatedFactor.buildDedicatedOverride({ symbol, baseWeights: longBaseWeights, factorKeys: LONG_KEYS, horizon: 'long' });
  const nrLong = [];
  if (evLong) nrLong.push({ key: 'event', weight: evLong.combinedWeight, factor: evLong.eventFactor });
  if (dedLong) dedLong.dedicatedFactors.forEach(f => nrLong.push({ key: f.key, weight: f.weight, factor: f }));
  let finalFactors = factors;
  let finalWeights = null;
  if (nrLong.length) {
    const merged = dedicatedFactor.mergeNonResidentOverrides(longBaseWeights, LONG_KEYS, nrLong);
    finalFactors = factors.concat(merged.factors);
    finalWeights = merged.override;
  }
  const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(finalFactors, finalWeights);

  return {
    symbol,
    name: (quote && quote.name) || name || symbol,
    industry: industryName,
    date: localDate(),
    generatedAt: new Date().toISOString(),
    horizon: 'long',          // 长期
    horizonLabel: '中长期（约 3~12 个月）',
    verdict,
    dir,
    score: Math.round(totalScore * 100),
    confidence,
    factors: scored,
    weightsUsed: finalWeights || longBaseWeights,
    weightsDefault: longBaseWeights,
    autoUpdated: true,        // 每次打开自动联网更新
    newsCount: Array.isArray(news) ? news.length : 0,
    marketLong: marketLong.indices,
    // 20261016b 诚实性修正（审计 L1）：旧文案「AI 联网抓取」夸大——本模块无 AI 参与；
    // 且行业前景因子的 policy.level 来自内置静态表 INDUSTRY_POLICY（非联网）。如实分层标注。
    source: '东方财富 · 同花顺 · 新浪期货 · 腾讯行情（确定性接口抓取）；行业前景因子取自内置静态政策库（非联网、非 AI）',
    // 三规则铺开：时效（日频）+ 当日涨跌与判断方向的一致性
    // ★ 20260902a：传入 dir，使 consistency 文字方向词与 verdict/dir 同源（修复口径冲突）
    rules: buildLongTermRules(quote, totalScore, localDate(), dir),
  };
}

/**
 * 长期判断三规则装饰器：时效 + 当日涨跌与判断方向是否同向
 *
 * ★ 20260902a 修复口径冲突（用户反馈"偏空却显示红色"根因）：
 *   原实现 `bullish = Math.round(totalScore*100) > 50` 与 dir 判定阈值（|total|>0.12，
 *   即 score>12 才"涨"）严重不一致。当 score 落在 (12,50] 时 dir="涨"→verdict 红色
 *   "看多"，但 consistency 文字却因 score<50 硬判"偏空"，形成"偏空配红字"的视觉矛盾。
 *   现直接用 dir 字段（与 combineFactors 同源）决定方向词，杜绝二次阈值分叉。
 */
function buildLongTermRules(quote, totalScore, fallbackDate, dir) {
  const core = require('./ruleCore');
  const dayChange = (quote && quote.prevClose > 0 && quote.price > 0)
    ? core.changeRate(quote.price, quote.prevClose) : null;
  let consistency = '无价格数据';
  if (dayChange != null) {
    // 与 dir 同源：dir='涨'→偏多 / dir='跌'→偏空 / dir='震荡'→中性，不再二次开阈值
    const bullish = dir === '涨';
    const bearish = dir === '跌';
    const dirWord = bullish ? '偏多' : bearish ? '偏空' : '中性';
    const up = dayChange > 0;
    if (bullish || bearish) {
      const sameDir = (bullish && up) || (bearish && !up);
      consistency = sameDir
        ? `判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）同向`
        : `⚠️ 判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）背离`;
    } else {
      // 中性区间不再被硬判"偏空"，避免 verdict 灰色却文字说偏空的口径错位
      consistency = `判断方向为中性，当日${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%`;
    }
  }
  return {
    ...core.decorateRules({
      dataTime: (quote && quote.date) ? quote.date : fallbackDate,
      // 20261016b 诚实性修正：本规则块描述的是价格/时效，数据源实为腾讯行情确定性抓取，非 AI。
      source: '腾讯行情（确定性接口抓取）',
      kind: 'daily',
      series: (quote && quote.prevClose > 0 && quote.price > 0)
        ? [{ date: '昨收', value: quote.prevClose }, { date: '当前', value: quote.price }]
        : [],
      name: '价格',
    }),
    dayChange,
    consistency,
  };
}

/**
 * 对外入口：带 5 分钟进程内缓存，避免同一次打开重复联网。
 */
async function getLongTermJudgment(symbol, name, force = false) {
  const now = Date.now();
  const hit = _cache[symbol];
  if (!force && hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const data = await buildLongTermJudgment(symbol, name);
  _cache[symbol] = { ts: now, data };
  return data;
}

module.exports = { getLongTermJudgment, buildLongTermJudgment, VERDICT_LABEL, factorTechnicalLong };

~~~

---

## `lib\macroData.js`  ·  773 行

~~~js
/**
 * 重要经济数据（结构化指标 + 解读）
 * --------------------------------------------------------------
 * 从东方财富数据中心（datacenter-web.eastmoney.com）拉取中国核心宏观指标：
 *   CPI（居民消费价格指数）、PPI（工业品出厂价格）、GDP（国内生产总值）、
 *   PMI（制造业采购经理指数）、M2（货币供应量）、财政收入（一般公共预算）。
 * 每个指标解析出「同比 / 环比 / 余额 / 累计」等数值，自动对比上期计算方向，
 * 并按阈值规则生成中文「解读」，供首页「每日宏观 & 政策」卡片以「数据卡片」形式展示。
 *
 * 说明：社融 / 进出口 / 城镇调查失业率在东方财富数据中心无对应报表（数据源为央行 / 商务部 /
 * 统计局），本模块聚焦东方财富可直接结构化获取的 5 个核心指标 + 财政收入（RPT_ECONOMY_INCOME）。
 *
 * 20260916 补全（妙想 EDB）：
 *   东方财富数据中心无「工业增加值 / 财政支出」报表，原分别依赖金十（数据陈旧至 202111，已失效）
 *   与财政部公告解析（外挂源偶发不可达），导致首页出现「数据源暂未提供最新值」占位卡片。
 *   现统一改由「东方财富妙想 EDB 宏观数据」补齐，两者口径如下：
 *     · 规模以上工业增加值 → EMM00008445（当月同比，国家统计局）+ EMM00008464（累计同比）
 *     · 一般公共预算支出   → EMM00059246（当月同比，财政部）+ EMM00059231（当月值，元）
 *   妙想不可用时逐级兜底（工业增加值→金十时效校验；财政支出→财政部公告解析），
 *   全部不可用才降级为占位卡片，保证任何情况下不展示陈旧/估算数据。
 */
const axios = require('axios');
const { getFiscalData } = require('./cnscraperAdapter');
const { getSocialFinancing } = require('./pbcMacro');
const { searchMacro, searchMacroFor, pickSeries, hasSeriesId } = require('./miaoxiangMacro');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

// 本地自然日（GMT+8），跨日自动失效
function localToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function fetchReport(reportName, columns, pageSize = 3) {
  const url = `${BASE}?reportName=${reportName}&columns=${encodeURIComponent(columns)}&pageSize=${pageSize}&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
    timeout: 12000,
  });
  const list = r.data && r.data.result && Array.isArray(r.data.result.data) ? r.data.result.data : [];
  return list;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function fmtInt(n) {
  if (n == null) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function signed(v, d = 1) {
  if (v == null) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(d);
}
function trendOf(cur, prev) {
  if (prev == null || cur == null) return { dir: 'flat', delta: null };
  if (cur > prev) return { dir: 'up', delta: cur - prev };
  if (cur < prev) return { dir: 'down', delta: prev - cur };
  return { dir: 'flat', delta: 0 };
}

// ---------- 妙想 EDB 通用小工具（20260916）----------
const MX_SRC = '东方财富妙想 · EDB 宏观数据';

// 'YYYY-MM' → 'YYYY年MM月份'（与东财 TIME 字段口径保持一致，便于卡片样式统一）
function ymToPeriod(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}年${m[2]}月份` : String(ym || '');
}
// 'YYYY-MM' → 月份数字（'2026-08' → 8）
function ymMonth(ym) {
  const m = String(ym || '').match(/^\d{4}-(\d{2})/);
  return m ? String(parseInt(m[1], 10)) : '';
}
// 同比增速变化文案（与卡片其他指标同一措辞）
function yoyTrendTxt(t, p, subject = '当月同比增速') {
  if (p == null) return '';
  if (t.dir === 'up') return `${subject}较上月回升 ${t.delta.toFixed(1)} 个百分点`;
  if (t.dir === 'down') return `${subject}较上月回落 ${t.delta.toFixed(1)} 个百分点`;
  return `${subject}与上月持平`;
}

// ---------- 各指标解析 + 解读 ----------
function buildCPI(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.NATIONAL_SAME);
  const seq = num(cur.NATIONAL_SEQUENTIAL);
  const acc = num(cur.NATIONAL_ACCUMULATE); // 累计指数（1-当月平均），-100 ≈ 累计同比
  const p = prev ? num(prev.NATIONAL_SAME) : null;
  const t = trendOf(v, p);
  let level;
  if (v == null) return null;
  if (v < 0) level = `为负（${v}%），处于通缩区间，反映内需偏弱、物价下行`;
  else if (v < 1) level = `低位（${v}%），通胀温和、通缩隐忧仍在`;
  else if (v < 3) level = `${signed(v)}%，物价温和，处于政策合意区间`;
  else level = `${signed(v)}%，通胀压力抬头，关注货币政策边际收紧`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `较上月回落 ${t.delta.toFixed(1)} 个百分点` : '与上月持平');
  return {
    key: 'CPI', name: 'CPI 居民消费价格指数', period: cur.TIME,
    value: v, unit: '%', valueLabel: '同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics: [
      { label: '环比', value: seq == null ? '—' : signed(seq) + '%' },
      { label: '累计同比', value: acc == null ? '—' : (acc - 100).toFixed(1) + '%' },
    ],
    interpretation: `CPI 同比${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_CPI',
  };
}

function buildPPI(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.BASE_SAME);
  const acc = num(cur.BASE_ACCUMULATE);
  const p = prev ? num(prev.BASE_SAME) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  let level;
  if (v < 0) level = `${v}%，工业品出厂价格下降，工业需求不足、企业盈利承压`;
  else if (v < 3) level = `${signed(v)}%，工业品价格温和回升`;
  else level = `${signed(v)}%，上游价格上行，关注向 CPI 的成本传导`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `较上月回落 ${t.delta.toFixed(1)} 个百分点` : '与上月持平');
  return {
    key: 'PPI', name: 'PPI 工业品出厂价格', period: cur.TIME,
    value: v, unit: '%', valueLabel: '同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics: [
      { label: '累计同比', value: acc == null ? '—' : (acc - 100).toFixed(1) + '%' },
    ],
    interpretation: `PPI 同比${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_PPI',
  };
}

function buildGDP(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.SUM_SAME);
  const abs = num(cur.DOMESTICL_PRODUCT_BASE); // 亿元
  const p = prev ? num(prev.SUM_SAME) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  let level;
  if (v < 4) level = `${v}%，增速放缓，经济承压`;
  else if (v < 6) level = `${v}%，经济保持稳健增长`;
  else level = `${v}%，增长动能强劲`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `较上期回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `较上期回落 ${t.delta.toFixed(1)} 个百分点` : '与上期持平');
  const metrics = [
    { label: '绝对值', value: abs == null ? '—' : (abs / 10000).toFixed(2) + ' 万亿' },
  ];
  if (num(cur.FIRST_SAME) != null) metrics.push({ label: '一产同比', value: cur.FIRST_SAME + '%' });
  if (num(cur.SECOND_SAME) != null) metrics.push({ label: '二产同比', value: cur.SECOND_SAME + '%' });
  if (num(cur.THIRD_SAME) != null) metrics.push({ label: '三产同比', value: cur.THIRD_SAME + '%' });
  return {
    key: 'GDP', name: 'GDP 国内生产总值', period: cur.TIME,
    value: v, unit: '%', valueLabel: '同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `GDP 同比${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_GDP',
  };
}

function buildPMI(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.MAKE_INDEX);
  const nm = num(cur.NMAKE_INDEX);
  const p = prev ? num(prev.MAKE_INDEX) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  const level = v > 50
    ? `${v}，高于荣枯线（50），制造业处于扩张区间`
    : (v >= 47 ? `${v}，低于荣枯线，制造业收缩` : `${v}，明显收缩区间`);
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `较上月回升 ${t.delta.toFixed(1)} 点` :
      t.dir === 'down' ? `较上月回落 ${t.delta.toFixed(1)} 点` : '与上月持平');
  const metrics = [];
  if (nm != null) metrics.push({ label: '非制造业', value: nm });
  metrics.push({ label: '荣枯线', value: '50' });
  return {
    key: 'PMI', name: 'PMI 制造业采购经理指数', period: cur.TIME,
    value: v, unit: '', valueLabel: '制造业',
    trend: t.dir, delta: t.delta, deltaUnit: '点',
    metrics,
    interpretation: `制造业 PMI ${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_PMI',
  };
}

function buildM2(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.BASIC_CURRENCY_SAME);
  const bal = num(cur.BASIC_CURRENCY); // 亿元
  const m1 = num(cur.CURRENCY_SAME);
  const m0 = num(cur.FREE_CASH_SAME);
  const p = prev ? num(prev.BASIC_CURRENCY_SAME) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  let level;
  if (v < 8) level = `${v}%，货币供应偏紧`;
  else if (v <= 12) level = `${v}%，流动性合理充裕`;
  else level = `${v}%，信用扩张加快、流动性宽松`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `较上月回落 ${t.delta.toFixed(1)} 个百分点` : '与上月持平');
  const metrics = [];
  if (bal != null) metrics.push({ label: 'M2 余额', value: (bal / 10000).toFixed(2) + ' 万亿' });
  if (m1 != null) metrics.push({ label: 'M1 同比', value: signed(m1) + '%' });
  if (m0 != null) metrics.push({ label: 'M0 同比', value: signed(m0) + '%' });
  return {
    key: 'M2', name: 'M2 货币供应量', period: cur.TIME,
    value: v, unit: '%', valueLabel: '同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `M2 同比${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_CURRENCY_SUPPLY',
  };
}

// ---------- 社会消费品零售总额 ----------
function buildRetail(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.RETAIL_TOTAL_SAME);           // 同比 %
  const total = num(cur.RETAIL_TOTAL);           // 当月（亿元）
  const seq = num(cur.RETAIL_TOTAL_SEQUENTIAL);  // 环比 %
  const acc = num(cur.RETAIL_TOTAL_ACCUMULATE);  // 累计（亿元）
  const accYoy = num(cur.RETAIL_ACCUMULATE_SAME); // 累计同比 %
  const p = prev ? num(prev.RETAIL_TOTAL_SAME) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  let level;
  if (v < 0) level = `${signed(v)}%，社零同比负增，消费动能走弱、需求不足`;
  else if (v < 3) level = `${signed(v)}%，社零增速偏低，居民消费意愿仍偏谨慎`;
  else if (v < 6) level = `${signed(v)}%，社零温和增长，消费总体平稳`;
  else level = `${signed(v)}%，社零较快增长，消费复苏动能增强`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `同比增速较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `同比增速较上月回落 ${t.delta.toFixed(1)} 个百分点` : '同比增速与上月持平');
  const ym = (cur.TIME || '').replace(/[^0-9]/g, '');
  const mp = ym.length >= 6 ? ym.slice(4, 6) : '';
  const metrics = [];
  if (total != null) metrics.push({ label: '当月', value: fmtInt(total) + ' 亿' });
  if (seq != null) metrics.push({ label: '环比', value: signed(seq) + '%' });
  if (acc != null) metrics.push({ label: '累计', value: fmtInt(acc) + ' 亿' });
  if (accYoy != null) metrics.push({ label: '累计同比', value: signed(accYoy) + '%' });
  return {
    key: 'RETAIL', name: '社会消费品零售总额', period: cur.TIME,
    value: Math.round(v * 10) / 10, unit: '%', valueLabel: '同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `社零同比${level}。${trendTxt}。${mp && acc != null && accYoy != null ? `1-${mp}月累计 ${fmtInt(acc)} 亿元，累计同比 ${signed(accYoy)}%。` : ''}`,
    source: '东方财富数据中心 · RPT_ECONOMY_TOTAL_RETAIL',
  };
}

// ---------- 固定资产投资（不含农户）----------
function buildAssetInvest(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const v = num(cur.BASE_SAME);                 // 当月同比 %
  const base = num(cur.BASE);                   // 当月（亿元）
  const seq = num(cur.BASE_SEQUENTIAL);         // 环比 %
  const acc = num(cur.BASE_ACCUMULATE);         // 累计（亿元）
  const p = prev ? num(prev.BASE_SAME) : null;
  const t = trendOf(v, p);
  if (v == null) return null;
  let level;
  if (v < 0) level = `${signed(v)}%，固定资产投资同比下滑，基建与制造业投资承压`;
  else if (v < 3) level = `${signed(v)}%，投资增速偏低，稳增长动能偏弱`;
  else if (v < 8) level = `${signed(v)}%，投资平稳增长，基建与制造业支撑有力`;
  else level = `${signed(v)}%，投资较快增长，稳增长发力明显`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `当月同比增速较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `当月同比增速较上月回落 ${t.delta.toFixed(1)} 个百分点` : '当月同比增速与上月持平');
  const ym = (cur.TIME || '').replace(/[^0-9]/g, '');
  const mp = ym.length >= 6 ? ym.slice(4, 6) : '';
  const metrics = [];
  if (acc != null) metrics.push({ label: '累计', value: fmtInt(acc) + ' 亿' });
  if (seq != null) metrics.push({ label: '环比', value: signed(seq) + '%' });
  if (base != null) metrics.push({ label: '当月', value: fmtInt(base) + ' 亿' });
  return {
    key: 'ASSET_INVEST', name: '固定资产投资（不含农户）', period: cur.TIME,
    value: Math.round(v * 10) / 10, unit: '%', valueLabel: '当月同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `固定资产投资当月同比${level}。${trendTxt}。${mp && acc != null ? `1-${mp}月累计 ${fmtInt(acc)} 亿元。` : ''}`,
    source: '东方财富数据中心 · RPT_ECONOMY_ASSET_INVEST',
  };
}

// ---------- 财政收入（一般公共预算）----------
function buildFiscalRevenue(rows) {
  if (!rows.length) return null;
  const cur = rows[0], prev = rows[1];
  const curMonth = num(cur.BASE);          // 当月（亿元）
  const yoy = num(cur.BASE_SAME);          // 当月同比（%）
  const mom = num(cur.BASE_SEQUENTIAL);    // 当月环比（%）
  const acc = num(cur.BASE_ACCUMULATE);    // 累计（亿元）
  const accYoy = num(cur.ACCUMULATE_SAME); // 累计同比（%）
  if (yoy == null) return null;
  const p = prev ? num(prev.BASE_SAME) : null;
  const t = trendOf(yoy, p);
  let level;
  if (yoy < 0) level = `同比下滑，反映经济税基承压、减税降费效应延续`;
  else if (yoy < 3) level = `温和增长，财源修复偏缓`;
  else if (yoy < 8) level = `稳健增长，财源基础稳固`;
  else level = `较快增长，预算完成进度靠前`;
  const trendTxt = p == null ? '' :
    (t.dir === 'up' ? `同比增速较上月回升 ${t.delta.toFixed(1)} 个百分点` :
      t.dir === 'down' ? `同比增速较上月回落 ${t.delta.toFixed(1)} 个百分点` : '同比增速与上月持平');
  const m = (cur.TIME || '').match(/(\d{1,2})月份/);
  const monthLabel = m ? `1-${parseInt(m[1], 10)} 月` : '累计';
  const metrics = [];
  if (curMonth != null) metrics.push({ label: '当月', value: fmtInt(curMonth) + ' 亿' });
  if (mom != null) metrics.push({ label: '环比', value: signed(mom) + '%' });
  if (acc != null) metrics.push({ label: '累计', value: fmtInt(acc) + ' 亿' });
  if (accYoy != null) metrics.push({ label: '累计同比', value: signed(accYoy) + '%' });
  return {
    key: 'FISCAL_REV', name: '财政收入（一般公共预算）', period: cur.TIME,
    value: Math.round(yoy * 10) / 10, unit: '%', valueLabel: '当月同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `财政收入当月 ${curMonth != null ? fmtInt(curMonth) : '—'} 亿元，同比 ${signed(yoy)}%` +
      `${mom != null ? `，环比 ${signed(mom)}%` : ''}；${monthLabel}累计 ${acc != null ? fmtInt(acc) : '—'} 亿元` +
      `${accYoy != null ? `，累计同比 ${signed(accYoy)}%` : ''}。${level}。${trendTxt}。`,
    source: '东方财富数据中心 · RPT_ECONOMY_INCOME',
  };
}

// ---------- 财政支出（一般公共预算，财政部公告解析）----------
// 与财政收入（buildFiscalRevenue）对称展示：以「累计同比」为主数值，累计额作为指标。
// d 来自 getFiscalData()：{ ok, date, source, title, url, revenue, expenditure }
function buildFiscalExpenditure(d) {
  const src = '财政部·财政收支情况（公告解析）';
  const ok = !!(d && d.ok && d.expenditure && d.expenditure.acc != null);
  if (!ok) {
    // 暂不可达：仍占位成对称卡片，避免与「财政收入」布局失衡
    return {
      key: 'FISCAL_EXP', name: '财政支出（一般公共预算）', period: (d && d.date) || '',
      value: '—', unit: '', valueLabel: '累计同比',
      trend: 'flat', delta: null, deltaUnit: '',
      metrics: [
        { label: '累计', value: '—' },
        { label: '累计同比', value: '—' },
      ],
      interpretation: '财政支出数据暂不可达：财政部《财政收支情况》公告解析源未连接或本期尚未发布，请稍后刷新。',
      source: src,
      unavailable: true,
    };
  }
  const exp = d.expenditure;
  const acc = Number(exp.acc);
  const yoy = exp.yoy != null ? Number(exp.yoy) : null;
  const trend = yoy == null ? 'flat' : (yoy > 0 ? 'up' : (yoy < 0 ? 'down' : 'flat'));
  let level;
  if (yoy == null) level = '（同比未披露）';
  else if (yoy < 0) level = `同比下滑，财政支出收缩，积极财政力度边际减弱`;
  else if (yoy < 3) level = `温和增长，财政支出平稳发力`;
  else if (yoy < 8) level = `稳健增长，财政扩张力度适中`;
  else level = `较快增长，积极财政靠前发力明显`;
  const metrics = [];
  if (acc != null) metrics.push({ label: '累计', value: fmtInt(acc) + ' 亿' });
  if (yoy != null) metrics.push({ label: '累计同比', value: signed(yoy) + '%' });
  const note = (d.title ? `（${d.title}）` : '');
  return {
    key: 'FISCAL_EXP', name: '财政支出（一般公共预算）', period: (d.date) || '',
    value: yoy, unit: '%', valueLabel: '累计同比',
    trend, delta: null, deltaUnit: 'pct',
    metrics,
    interpretation: `财政支出累计 ${fmtInt(acc)} 亿元` +
      `${yoy != null ? `，累计同比 ${signed(yoy)}%` : ''}。${level}。`,
    source: src + note,
  };
}

// ---------- 规模以上工业增加值（金十数据源，含时效校验 + 优雅降级）----------
async function fetchIndustrialValueAdded() {
  // 东方财富数据中心无工业增加值对应报表；金十免费 CDN 数据可能陈旧，需时效校验。
  try {
    const r = await axios.get('https://cdn.jin10.com/dc/reports/dc_chinese_industrial_production_yoy_all.js', {
      headers: { 'User-Agent': UA, Referer: 'https://datacenter.jin10.com/' }, timeout: 8000,
    });
    const txt = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const m = txt.match(/var dataCenter_data\s*=\s*(\{[\s\S]*\})\s*;?/);
    if (!m) return null;
    const obj = JSON.parse(m[1]);
    const list = obj.list || [];
    if (!list.length) return null;
    const last = list[list.length - 1];
    const dt = new Date(String(last.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
    const ageDays = (Date.now() - dt.getTime()) / 86400000;
    if (!(ageDays >= 0 && ageDays <= 90)) return { stale: true, lastDate: String(last.date) };
    const arr = (last.datas && obj.types && last.datas[obj.types[0]]) || [];
    const yoy = num(arr[1]);
    const prevYoy = num(arr[0]);
    if (yoy == null) return null;
    const t = trendOf(yoy, prevYoy);
    let level;
    if (yoy < 0) level = `${signed(yoy)}%，工业增加值同比负增，工业景气承压`;
    else if (yoy < 4) level = `${signed(yoy)}%，工业增速偏低，需求仍不足`;
    else if (yoy < 7) level = `${signed(yoy)}%，工业温和增长`;
    else level = `${signed(yoy)}%，工业较快增长，景气回升`;
    return {
      key: 'INDUSTRIAL', name: '规模以上工业增加值（同比）', period: String(last.date),
      value: Math.round(yoy * 10) / 10, unit: '%', valueLabel: '同比',
      trend: t.dir, delta: t.delta, deltaUnit: 'pct',
      metrics: [{ label: '前值', value: prevYoy == null ? '—' : signed(prevYoy) + '%' }],
      interpretation: `工业增加值同比${level}。`,
      source: '金十数据中心 · 规模以上工业增加值年率报告',
    };
  } catch (e) { return null; }
}

// ---------- 妙想 EDB：指标挑选取数（优先按已知 EMM 指标 ID 命中，退化到名称关键词）----------
function pickMxSeries(tables, prefIds, include, exclude = []) {
  const all = [];
  for (const t of (tables || [])) for (const s of (t.series || [])) all.push(s);
  for (const id of (prefIds || [])) {
    const hit = all.find(s => s.id === id && s.points && s.points.length);
    if (hit) return hit;
  }
  return pickSeries(tables, include, exclude);
}

// ---------- 规模以上工业增加值（妙想 EDB 主源 · 20260916 补全）----------
// EMM00008445 中国:工业增加值:同比(%)（国家统计局，当月口径）
// EMM00008464 中国:工业增加值:累计同比(%)
// 妙想为自然语言检索，命中率随措辞波动，故给出多组措辞依次兜底。
const MX_IND_QUERIES = [
  '中国:工业增加值:同比，最近14个月',
  '工业增加值同比，最近14个月',
];
async function fetchIndustrialFromMx() {
  const r = await searchMacroFor(MX_IND_QUERIES, ts => hasSeriesId(ts, 'EMM00008445'));
  if (!r || !r.ok) return null;
  const yoyS = pickMxSeries(r.tables, ['EMM00008445'], ['工业增加值', '同比'], ['预测', '累计', '制造业']);
  if (!yoyS || !yoyS.points.length) return null;
  const accS = pickMxSeries(r.tables, ['EMM00008464'], ['工业增加值', '累计同比'], ['预测', '制造业']);
  const cur = yoyS.points[0], prev = yoyS.points[1] || null;
  const v = Number(cur.value);
  if (!isFinite(v)) return null;
  const p = prev ? Number(prev.value) : null;
  const t = trendOf(v, p);
  let level;
  if (v < 0) level = `${signed(v)}%，工业增加值同比负增，工业景气承压`;
  else if (v < 4) level = `${signed(v)}%，工业增速偏低，需求仍不足`;
  else if (v < 7) level = `${signed(v)}%，工业温和增长`;
  else level = `${signed(v)}%，工业较快增长，景气回升`;
  const accRaw = (accS && accS.points.length) ? Number(accS.points[0].value) : null;
  const acc = isFinite(accRaw) ? accRaw : null;
  const mm = ymMonth(cur.date);
  const tt = yoyTrendTxt(t, p);
  const metrics = [];
  if (p != null) metrics.push({ label: '前值', value: signed(p) + '%' });
  if (acc != null) metrics.push({ label: '累计同比', value: signed(acc) + '%' });
  return {
    key: 'INDUSTRIAL', name: '规模以上工业增加值（同比）', period: ymToPeriod(cur.date),
    value: Math.round(v * 10) / 10, unit: '%', valueLabel: '当月同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `工业增加值当月同比${level}。${tt ? tt + '。' : ''}` +
      `${mm && acc != null ? `1-${mm}月累计同比 ${signed(acc)}%。` : ''}`,
    source: `${MX_SRC}（国家统计局）· ${yoyS.id}`,
  };
}

// ---------- 财政支出（妙想 EDB 主源 · 20260916 补全）----------
// EMM00059246 中国:一般公共预算支出:同比(%)（财政部，当月口径）→ 主值
// 与「财政收入（一般公共预算）」卡片同口径（当月同比为主值），两侧布局对称。
// 「累计额 / 累计同比」妙想 EDB 无对应指标（仅有当月值），改由财政部《财政收支情况》公告解析补充；
// 该外挂源不可达时自动省略累计指标，不影响主值。
// 妙想服务端频率敏感，故此处只发一次取数（措辞兜底最多两次），避免调用链过长拖慢首屏。
const MX_EXP_YOY_QUERIES = [
  '中国一般公共预算支出当月同比，最近14个月',
  '中国一般公共预算支出:同比，最近14个月',
];
async function fetchFiscalExpFromMx() {
  const r = await searchMacroFor(MX_EXP_YOY_QUERIES, ts => hasSeriesId(ts, 'EMM00059246'));
  if (!r || !r.ok) return null;
  const yoyS = pickMxSeries(r.tables, ['EMM00059246'], ['一般公共预算支出', '同比'], ['累计', '收入']);
  if (!yoyS || !yoyS.points.length) return null;
  const cur = yoyS.points[0], prev = yoyS.points[1] || null;
  const v = Number(cur.value);
  if (!isFinite(v)) return null;
  const p = prev ? Number(prev.value) : null;
  const t = trendOf(v, p);
  let level;
  if (v < 0) level = `同比下滑，财政支出收缩，积极财政力度边际减弱`;
  else if (v < 3) level = `温和增长，财政支出平稳发力`;
  else if (v < 8) level = `稳健增长，财政扩张力度适中`;
  else level = `较快增长，积极财政靠前发力明显`;
  const tt = yoyTrendTxt(t, p);
  const metrics = [];
  if (p != null) metrics.push({ label: '前值', value: signed(p) + '%' });
  return {
    key: 'FISCAL_EXP', name: '财政支出（一般公共预算）', period: ymToPeriod(cur.date),
    value: Math.round(v * 100) / 100, unit: '%', valueLabel: '当月同比',
    trend: t.dir, delta: t.delta, deltaUnit: 'pct',
    metrics,
    interpretation: `财政支出当月同比${signed(v)}%。${level}。${tt ? tt + '。' : ''}`,
    source: `${MX_SRC}（财政部）· ${yoyS.id}`,
  };
}

/**
 * 把财政部《财政收支情况》公告解析的「累计」口径数据并入妙想财政支出卡片。
 * 妙想无累计指标，财政部解析不可达时自动跳过（不改变卡片主口径）。
 */
function mergeFiscalAccum(card, fiscalRaw) {
  if (!card) return card;
  const expd = (fiscalRaw && fiscalRaw.ok && fiscalRaw.expenditure) || null;
  if (!expd) return card;
  const accRaw = expd.acc != null ? Number(expd.acc) : null;
  const acc = isFinite(accRaw) ? accRaw : null;
  const accYoyRaw = expd.yoy != null ? Number(expd.yoy) : null;
  const accYoy = isFinite(accYoyRaw) ? accYoyRaw : null;
  if (acc == null) return card;
  const metrics = (card.metrics || []).slice();
  metrics.push({ label: '累计', value: fmtInt(acc) + ' 亿' });
  if (accYoy != null) metrics.push({ label: '累计同比', value: signed(accYoy) + '%' });
  const ym = String(card.period || '').replace(/[^0-9]/g, '');
  const monthLabel = ym.length >= 6 ? `1-${parseInt(ym.slice(4, 6), 10)}月` : '累计';
  return {
    ...card,
    metrics,
    interpretation: card.interpretation +
      `${monthLabel}累计 ${fmtInt(acc)} 亿元${accYoy != null ? `，累计同比 ${signed(accYoy)}%` : ''}。`,
    source: `${card.source}；累计取自财政部《财政收支情况》公告解析`,
  };
}

// ---------- LPR 贷款市场报价利率（东财 RPTA_WEB_RATE，确定性数据）----------
async function fetchLPR() {
  try {
    // 注意：RPTA_WEB_RATE 的日期列为 TRADE_DATE（非通用 REPORT_DATE），
    // 不能用 fetchReport（其 sortColumns 写死 REPORT_DATE 会导致该报表排序失败返回空），故直连取数。
    const url = `${BASE}?reportName=RPTA_WEB_RATE&columns=TRADE_DATE,LPR1Y,LPR5Y`
      + `&pageSize=30&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' }, timeout: 12000,
    });
    const rows = (r.data && r.data.result && Array.isArray(r.data.result.data)) ? r.data.result.data : [];
    // rows 按 TRADE_DATE 降序；跳过旧的贷款基准利率行（LPR1Y 为空），第一条非空即最新 LPR 报价
    const valid = rows.filter(x => num(x.LPR1Y) != null);
    if (!valid.length) return null;
    const cur = valid[0];
    const prev = valid[1] || null;
    const v1y = num(cur.LPR1Y);
    const v5y = num(cur.LPR5Y);
    const date = String(cur.TRADE_DATE || '').slice(0, 10);
    const t = trendOf(v1y, prev ? num(prev.LPR1Y) : null);
    const deltaPct = (t.delta != null) ? t.delta : null; // 与上次报价差（百分点）
    const metrics = [];
    if (v5y != null) metrics.push({ label: '5年期', value: v5y.toFixed(1) + '%' });
    if (prev) metrics.push({ label: '上次1年期', value: num(prev.LPR1Y).toFixed(1) + '%' });
    const deltaTxt = (deltaPct != null)
      ? `，较上次报价${t.dir === 'up' ? '上调' : t.dir === 'down' ? '下调' : '持平'} ${Math.abs(deltaPct).toFixed(2)} 个百分点`
      : '';
    let level;
    if (v1y < 3.5) level = `${v1y.toFixed(1)}%，处于历史低位，实体融资成本较低`;
    else if (v1y < 4) level = `${v1y.toFixed(1)}%，贷款利率中性偏低`;
    else level = `${v1y.toFixed(1)}%，贷款利率偏高`;
    return {
      key: 'LPR', name: 'LPR 贷款市场报价利率', period: date,
      value: v1y, unit: '%', valueLabel: '1年期',
      trend: t.dir, delta: deltaPct, deltaUnit: 'pct',
      metrics,
      interpretation: `最新 LPR 报价（${date}）：1年期 ${v1y.toFixed(1)}%、5年期以上 ${v5y != null ? v5y.toFixed(1) + '%' : '—'}。LPR 是银行贷款定价锚，1年期主要影响短期信贷成本，5年期以上主要影响房贷与长期融资${deltaTxt}。${level}。`,
      source: '东方财富数据中心 · RPTA_WEB_RATE',
    };
  } catch (e) { return null; }
}

// ---------- 社会融资规模增量（人民银行，pandas 解析央行 xlsx，确定性数据）----------
function buildSocialFinancing(d) {
  if (!d || !d.ok || d.afre_total == null) {
    return {
      key: 'SOCIAL_FIN', name: '社会融资规模增量', period: '',
      value: '—', unit: '', valueLabel: '当月增量',
      trend: 'flat', delta: null, deltaUnit: '',
      metrics: [{ label: '最新', value: '不可达' }],
      interpretation: '社融数据暂不可达：人民银行统计表解析源未连接或本期尚未发布，请稍后刷新。',
      source: '中国人民银行（解析源）', unavailable: true,
    };
  }
  const v = Number(d.afre_total);
  const ytd = d.ytd_total != null ? Number(d.ytd_total) : null;
  const loans = d.rmb_loans != null ? Number(d.rmb_loans) : null;
  const gov = d.government_bonds != null ? Number(d.government_bonds) : null;
  const metrics = [];
  if (ytd != null) metrics.push({ label: (d.year ? d.year + '年' : '年内') + '累计', value: fmtInt(ytd) + ' 亿' });
  if (loans != null) metrics.push({ label: '人民币贷款', value: fmtInt(loans) + ' 亿' });
  if (gov != null) metrics.push({ label: '政府债券', value: fmtInt(gov) + ' 亿' });
  let level;
  if (v < 0) level = `${fmtInt(v)} 亿元，当月社融净缩减，信用收缩`;
  else if (v < 15000) level = `${fmtInt(v)} 亿元，当月社融偏低，实体融资需求偏弱`;
  else level = `${fmtInt(v)} 亿元，当月社融较强，信用扩张`;
  return {
    key: 'SOCIAL_FIN', name: '社会融资规模增量', period: (d.month || ''),
    value: v, unit: '亿', valueLabel: '当月增量',
    trend: 'flat', delta: null, deltaUnit: '',
    metrics,
    interpretation: `${d.month || ''} 社会融资规模增量 ${fmtInt(v)} 亿元。${level}。`
      + `${ytd != null ? `${(d.year ? d.year + '年' : '年内')}累计 ${fmtInt(ytd)} 亿元。 ` : ''}`
      + `${loans != null ? `其中人民币贷款 ${fmtInt(loans)} 亿、政府债券 ${gov != null ? fmtInt(gov) : '—'} 亿，是主要拉动项。` : ''}`,
    source: d.source || '中国人民银行·社会融资规模增量统计表',
  };
}

// 每个指标的拉取配置
const FETCHERS = [
  { key: 'CPI', fn: buildCPI, report: 'RPT_ECONOMY_CPI', cols: 'REPORT_DATE,TIME,NATIONAL_SAME,NATIONAL_SEQUENTIAL,NATIONAL_ACCUMULATE' },
  { key: 'PPI', fn: buildPPI, report: 'RPT_ECONOMY_PPI', cols: 'REPORT_DATE,TIME,BASE_SAME,BASE_ACCUMULATE' },
  { key: 'GDP', fn: buildGDP, report: 'RPT_ECONOMY_GDP', cols: 'REPORT_DATE,TIME,DOMESTICL_PRODUCT_BASE,SUM_SAME,FIRST_SAME,SECOND_SAME,THIRD_SAME' },
  { key: 'PMI', fn: buildPMI, report: 'RPT_ECONOMY_PMI', cols: 'REPORT_DATE,TIME,MAKE_INDEX,NMAKE_INDEX' },
  { key: 'M2', fn: buildM2, report: 'RPT_ECONOMY_CURRENCY_SUPPLY', cols: 'REPORT_DATE,TIME,BASIC_CURRENCY,BASIC_CURRENCY_SAME,CURRENCY_SAME,FREE_CASH_SAME' },
  { key: 'RETAIL', fn: buildRetail, report: 'RPT_ECONOMY_TOTAL_RETAIL', cols: 'REPORT_DATE,TIME,RETAIL_TOTAL,RETAIL_TOTAL_SAME,RETAIL_TOTAL_SEQUENTIAL,RETAIL_TOTAL_ACCUMULATE,RETAIL_ACCUMULATE_SAME' },
  { key: 'ASSET_INVEST', fn: buildAssetInvest, report: 'RPT_ECONOMY_ASSET_INVEST', cols: 'REPORT_DATE,TIME,BASE,BASE_SAME,BASE_SEQUENTIAL,BASE_ACCUMULATE' },
  { key: 'FISCAL_REV', fn: buildFiscalRevenue, report: 'RPT_ECONOMY_INCOME', cols: 'REPORT_DATE,TIME,BASE,BASE_SAME,BASE_SEQUENTIAL,BASE_ACCUMULATE,ACCUMULATE_SAME' },
];

// 每日缓存（跨日自动失效）
let dataCache = { date: '', data: null };

// 指标排序：生产/消费/投资类指标归组在货币之后、财政之前；工业增加值紧随固定资产投资
const INDICATOR_ORDER = ['CPI', 'PPI', 'GDP', 'PMI', 'M2', 'LPR', 'SOCIAL_FIN', 'RETAIL', 'ASSET_INVEST', 'INDUSTRIAL', 'FISCAL_REV', 'FISCAL_EXP'];

async function getMacroIndicators(force = false) {
  const today = localToday();
  if (!force && dataCache.date === today && dataCache.data) return dataCache.data;

  const results = await Promise.allSettled(
    FETCHERS.map(f => fetchReport(f.report, f.cols, 3).then(rows => f.fn(rows)))
  );

  const indicators = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) indicators.push(r.value);
  }

  // 财政支出 + 规模以上工业增加值：妙想 EDB 主源（20260916），与财政部公告解析三路并发以缩短首屏等待。
  // 兜底链：妙想 →（财政支出）财政部公告解析 /（工业增加值）金十时效校验 → 占位卡片。
  const TF = 12000;
  const fiscalRawP = Promise.race([
    getFiscalData(),
    new Promise(res => setTimeout(() => res(null), TF)),
  ]).catch(() => null);
  const [mxIndustrial, mxFiscalExp, fiscalRaw] = await Promise.all([
    Promise.race([fetchIndustrialFromMx(), new Promise(res => setTimeout(() => res(null), TF))]).catch(() => null),
    Promise.race([fetchFiscalExpFromMx(), new Promise(res => setTimeout(() => res(null), TF))]).catch(() => null),
    fiscalRawP,
  ]);

  // 财政支出：妙想命中 → 并入财政部累计口径（可选补充）；妙想不可达 → 整卡回退财政部公告解析（累计口径）
  const fiscalExp = mxFiscalExp
    ? mergeFiscalAccum(mxFiscalExp, fiscalRaw)
    : buildFiscalExpenditure(fiscalRaw);
  if (fiscalExp) indicators.push(fiscalExp);

  // 规模以上工业增加值：妙想不可达时才回退金十（含 90 天时效校验，陈旧则降级为占位卡）
  let industrial = mxIndustrial || null;
  if (!industrial) {
    try {
      const iv = await Promise.race([
        fetchIndustrialValueAdded(),
        new Promise(res => setTimeout(() => res(null), 8000)),
      ]);
      if (iv && iv.stale) {
        industrial = {
          key: 'INDUSTRIAL', name: '规模以上工业增加值（同比）', period: '',
          value: '—', unit: '', valueLabel: '当月同比',
          trend: 'flat', delta: null, deltaUnit: '',
          metrics: [{ label: '最新数据', value: '陈旧/不可达' }],
          interpretation: `工业增加值数据暂不可达：妙想 EDB 未返回数据，备用金十免费数据源最新仅至 ${(iv.lastDate || '未知').slice(0, 6)}（已超 90 天时效），按三规则（数据最新性）优雅降级，不展示陈旧数据，待数据源更新后自动恢复。`,
          source: '数据源未提供最新值',
          unavailable: true,
        };
      } else if (iv) {
        industrial = iv;
      }
    } catch (e) { industrial = null; }
  }
  // 最终兜底：保留占位卡片，避免与相邻「固定资产投资」卡片布局失衡
  if (!industrial) {
    industrial = {
      key: 'INDUSTRIAL', name: '规模以上工业增加值（同比）', period: '',
      value: '—', unit: '', valueLabel: '当月同比',
      trend: 'flat', delta: null, deltaUnit: '',
      metrics: [{ label: '最新数据', value: '陈旧/不可达' }],
      interpretation: '工业增加值数据暂不可达：妙想 EDB 与金十备用源均未返回数据，按三规则（数据最新性）保持占位，待数据源恢复后自动补全。',
      source: '数据源暂未提供最新值',
      unavailable: true,
    };
  }
  if (industrial) indicators.push(industrial);

  // LPR + 社融：确定性宏观利率 / 信用数据，与东财宏观指标并列展示。
  // 社融走人民银行 xlsx 解析（pandas），耗时较长，单独放宽超时。
  const [lprCard, socialFinRaw] = await Promise.all([
    Promise.race([fetchLPR(), new Promise(res => setTimeout(() => res(null), TF))]).catch(() => null),
    Promise.race([getSocialFinancing(), new Promise(res => setTimeout(() => res(null), 90000))]).catch(() => null),
  ]);
  const socialFin = buildSocialFinancing(socialFinRaw);
  if (lprCard) indicators.push(lprCard);
  if (socialFin) indicators.push(socialFin);

  indicators.sort((a, b) => (INDICATOR_ORDER.indexOf(a.key) - INDICATOR_ORDER.indexOf(b.key)));

  const okCount = indicators.length;
  // 来源标注按实际命中的通道动态生成（妙想主源 / 备用源），避免标注与实际数据源不一致
  const srcParts = ['东方财富数据中心（结构化宏观指标）'];
  if (mxIndustrial) srcParts.push('工业增加值取自东方财富妙想 EDB');
  else if (industrial && !industrial.unavailable) srcParts.push('工业增加值取自金十（备用源）');
  if (mxFiscalExp) srcParts.push('财政支出取自东方财富妙想 EDB');
  else if (fiscalExp && !fiscalExp.unavailable) srcParts.push('财政支出取自财政部公告解析（备用源）');
  if (lprCard) srcParts.push('LPR 取自东方财富数据中心 RPTA_WEB_RATE');
  if (socialFin && !socialFin.unavailable) srcParts.push('社融取自人民银行统计表（xlsx 解析）');
  const data = {
    source: okCount ? srcParts.join('·') : '东方财富数据中心（暂不可达）',
    date: today,
    updated: new Date().toISOString(),
    indicators,
    available: okCount,
    total: FETCHERS.length + 4,
  };

  // 三规则铺开：宏观指标多为月度/季度披露，按「财务」档（90 天）做时效体检，
  // 并对每个指标补上变化与边际分析。
  data.rules = buildMacroRules(indicators, today, data.source);
  dataCache = { date: today, data };
  return data;
}

/**
 * 宏观模块三规则装饰器：时效（财务档 90 天）+ 各指标变化与边际
 */
function buildMacroRules(indicators, today, fallbackSource) {
  const core = require('./ruleCore');
  const out = {};
  (indicators || []).forEach(ind => {
    const series = Array.isArray(ind.series) ? ind.series : [];
    // 数据时间优先取指标自身的统计期（period/date），没有则用采集日
    const dataTime = ind.period || ind.date || today;
    out[ind.key] = core.decorateRules({
      dataTime,
      source: ind.source || fallbackSource || '东方财富数据中心',
      kind: 'financial',
      series: series
        .filter(p => p && (p.value != null) && isFinite(Number(p.value)))
        .map(p => ({ date: p.date || p.period, value: Number(p.value) })),
      name: ind.name || ind.key,
    });
  });
  return out;
}

module.exports = { getMacroIndicators };

~~~

---

## `lib\macroNews.js`  ·  140 行

~~~js
/**
 * 每日宏观 & 政策采集
 * --------------------------------------------------------------
 * 基于东方财富 7×24 快讯，过滤出「宏观经济 / 货币政策 / 财政监管 / 数据发布 /
 * 国际宏观」相关条目，按类别分组，供首页「每日宏观 & 政策」卡片展示。
 * 按自然日缓存（每日自动采集一次），进入页面时加载，可手动刷新。
 *
 * 说明：实时抓取宏观指标精确数值（如统计局 CPI/PMI）需官网结构化解析，
 * 本环境以「宏观/政策类快讯」为主来源，覆盖绝大多数每日宏观与政策动态，
 * 每条均标注来源与时间；如需精确数值指标可后续接入官网解析（见 macro-monitor）。
 */
const { fetchKuaixunNews, fetchEastmoneyContentNews } = require('./newsSearch');
const { analyzeSentiment } = require('./analysis');
const { getRegulatoryNews } = require('./cnscraperAdapter');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

// 按类别的关键词（命中任一即归入该类）
const MACRO_CATS = {
  货币政策: /(央行|降准|降息|LPR|MLF|逆回购|货币|流动性|信贷|社融|存款准备金|公开市场|基础货币|宽货币|紧货币|汇率|人民币)/,
  财政监管: /(财政|财政收入|财政支出|财政收支|一般公共预算|预算收支|财政赤字|减税|专项债|国债|国务院|发改委|证监会|资管|监管|国常会|政治局|两会|税收|补贴|社保|公积金|财政部|货币.*政策报告|央行.*报告)/,
  数据发布: /(CPI|PPI|PMI|GDP|工业增加|社零|固定资产投资|进出口|失业率|M2|外汇储备|物价|经济数据|宏观数据|财政.*数据|社融.*数据|信贷.*数据)/,
  国际宏观: /(美联储|加息|非农|FOMC|欧央行|日央|地缘|俄乌|中东|美元|美债|特朗普|拜登|关税|贸易战|IMF|世行|国际经济)/,
};

function macroCategory(title = '', summary = '') {
  const t = title + ' ' + (summary || '');
  for (const [cat, re] of Object.entries(MACRO_CATS)) {
    if (re.test(t)) return cat;
  }
  return null;
}

// 本地自然日（GMT+8），避免 toISOString() 的 UTC 跨日导致缓存过早/过晚失效
// 20260917l：此前误写成 _localDate() 但本文件只导入了 localDate（无别名）→ 每次调用都抛
// ReferenceError: _localDate is not defined，服务日志刷屏「Macro news error」，首页宏观卡片长期取不到数据。
function localToday() { return localDate(); }

// 内存缓存：以自然日为单位，跨自然日自动失效（每日自动采集）
let macroCache = { date: '', data: null };

async function getMacroNews(force = false) {
  const today = localToday();
  if (!force && macroCache.date === today && macroCache.data) return macroCache.data;

  const result = await collectMacro(today);
  macroCache = { date: today, data: result };
  return result;
}

async function collectMacro(today) {
  // 主源：东方财富 7×24 快讯（宏观/政策过滤）
  let items = [];
  try {
    items = await fetchKuaixunNews(60);
  } catch (e) {
    items = [];
  }
  let macro = items.filter(n => macroCategory(n.title, n.summary));

  // 兜底：主源受限或过滤后过少时，用内容搜索补宏观/政策动态（与「今日热点」同源兜底）
  let usedFallback = false;
  if (macro.length < 6) {
    try {
      const fbRaw = await fetchEastmoneyContentNews('宏观 政策 央行 货币 财政 经济数据 GDP CPI 降准 降息', 30);
      const fb = (fbRaw || []).filter(n => macroCategory(n.title, n.summary || ''));
      const have = new Set(macro.map(n => n.title));
      for (const n of fb) {
        if (!have.has(n.title)) { macro.push(n); have.add(n.title); }
      }
      if (fb.length) usedFallback = true;
    } catch (e) { /* 兜底失败则保留主源结果 */ }
  }

  // 仍过少：放宽到含经济/市场/股市关键词且尚未包含的条目
  if (macro.length < 6) {
    const extra = items.filter(n =>
      /(经济|市场|股市|A股|债市|基金|外汇|人民币|金融|产业)/.test(n.title) && !macro.includes(n));
    macro = macro.concat(extra).slice(0, 40);
  }

  // 兜底（增强）：主源 + 内容搜索仍偏薄时，用 cn-financial-scraper 监管/政策源补「财政部发布 /
  // 财政收支 / 预算」类动态——7×24 快讯偶尔漏抓财政部数据发布，此兜底让首页「财政监管」分类
  // 能主动进化捕获（本机沙箱常返回空，属正常降级；联网环境生效）。
  if (macro.length < 8) {
    try {
      const reg = await getRegulatoryNews('all', 20);
      if (reg && reg.ok && Array.isArray(reg.items) && reg.items.length) {
        const have = new Set(macro.map(n => n.title));
        const fiscalOrPolicy = /(财政|预算|税收|减税|专项债|国债|政策|央行|货币|经济|监管|国常会|政治局)/;
        for (const it of reg.items) {
          const title = it.title || '';
          if (!title || have.has(title)) continue;
          if (macroCategory(title, it.summary || '') || fiscalOrPolicy.test(title)) {
            macro.push({
              title,
              summary: it.summary || '',
              url: it.url || '',
              date: it.date || '',
              source: it.source || '监管政策源',
            });
            have.add(title);
          }
        }
      }
    } catch (e) { /* 兜底失败则保留主源结果，绝不抛异常 */ }
  }

  macro = macro.map(n => ({
    ...n,
    category: macroCategory(n.title, n.summary) || '市场',
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
  }));
  macro.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  macro = macro.slice(0, 24);

  const byCategory = {};
  for (const m of macro) {
    const cat = m.category || '市场';
    (byCategory[cat] = byCategory[cat] || []).push(m);
  }
  const order = ['货币政策', '财政监管', '数据发布', '国际宏观', '市场'];

  const fromKuaixun = items.length > 0;
  const source = fromKuaixun
    ? (usedFallback ? '东方财富 7×24 快讯 + 内容搜索兜底（宏观/政策）' : '东方财富 7×24 快讯（宏观/政策过滤）')
    : '东方财富内容搜索（宏观/政策 · kuaixun 不可用时兜底）';

  return {
    source,
    updated: new Date().toISOString(),
    date: today,
    total: macro.length,
    items: macro,
    byCategory,
    order,
  };
}

module.exports = { getMacroNews, macroCategory };

~~~

---

## `lib\macroSentimentFactors.js`  ·  206 行

~~~js
/**
 * 市场情绪提醒 · 宏观情绪因子（非常驻 · 自学习）
 * --------------------------------------------------------------
 * 在市场情绪拐点面板中新增两张「非常驻」因子小卡片，引用「每日宏观 & 政策」卡片数据：
 *   - 国内宏观数据情绪因子：解读最新国内经济数据公布（社零 / 固定资产投资 / 工业增加值等）
 *     对短期市场情绪的影响。
 *   - 美国宏观事件情绪因子：解读最新美国经济数据 / 事件（以 FOMC 为主）对短期情绪的影响。
 *
 * 行为约定（来自需求）：
 *   1) 两因子初始权重「平均分配」（各 50%）。
 *   2) 自学习：若大盘指数走势与因子预示的影响相悖，该因子权重自动归 0，转为「休眠」，
 *      待下一次数据 / 事件触发再恢复默认权重（重新激活）。
 *   3) 非常驻：国内因子以宏观数据公布期（period）为触发键；美国因子以美国事件 id 为触发键。
 *      触发键变化即视为「新触发」，重置为激活态 + 默认权重。
 *
 * 依赖：lib/macroData.getMacroIndicators（国内指标）、lib/usMacroEvents.getUsMacroEvents（美国事件）、
 *       shHistory（上证历史，由调用方 getTurningPointState 复用，避免重复拉取）。
 */
const fs = require('fs');
const path = require('path');

const { getMacroIndicators } = require('./macroData');
const { getUsMacroEvents } = require('./usMacroEvents');

const DATA_DIR = path.join(__dirname, '..', 'data', 'sentiment-macro');
const STATE_FILE = path.join(DATA_DIR, 'macroFactors.json');

const BASE_WEIGHT = 0.5; // 两因子平均分配

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {}
}

// 国内宏观综合评分：在合理区间=利好(+1)，偏低/收缩/负增=利空(-1)，否则 0
// 20261016 D4（用户批准方案①+②）：原只覆盖 7 个指标（CPI/PPI/GDP/PMI/M2/社零/固投），
//   LPR/社融/工业增加值/财政收入/财政支出「有卡无分」。现按各卡片自身分档口径补全 5 项规则，
//   实现 12 项指标全覆盖；同时统计 participating（实际参与方向打分的指标数）供展示层明示。
//   新增规则阈值全部对齐 macroData.js 各 build 函数已有分档（非新造阈值）：
//     LPR       → 用 trend 方向（:566）：下调=宽松 +1 / 上调=收紧 -1 / 持平 0
//     社融      → 当月增量（:610-612）：<0 净缩减 -1 / ≥15000 亿信用扩张 +1 / 其间 0
//     工业增加值 → 当月同比（:414-417）：≥4% 景气 +1 / <0 负增 -1 / 其间 0
//     财政收入   → 当月同比（:319-322）：≥3% 财源稳固 +1 / <0 税基承压 -1 / 其间 0
//     财政支出   → 累计同比（:372-375）：≥3% 积极财政发力 +1 / <0 支出收缩 -1 / 其间 0
function deriveDomestic(indicators) {
  const scores = [];
  const parts = [];
  let participating = 0; // 命中具体规则（非 default）的指标数
  let total = 0;         // 非 unavailable 的指标数（评分分母）
  for (const ind of (indicators || [])) {
    if (!ind || ind.unavailable) continue;
    const v = Number(ind.value);
    let s = 0;
    let scored = false;
    switch (ind.key) {
      case 'CPI': s = (v >= 0.5 && v <= 3) ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      case 'PPI': s = (v >= 0 && v <= 4) ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      case 'GDP': s = (v >= 4.5 && v <= 6) ? 1 : (v < 4 ? -1 : 0); scored = true; break;
      case 'PMI': s = v >= 50 ? 1 : -1; scored = true; break;
      case 'M2': s = (v >= 8 && v <= 12) ? 1 : (v < 8 ? -1 : 0); scored = true; break;
      case 'RETAIL': s = (v >= 3 && v <= 8) ? 1 : (v < 2 ? -1 : 0); scored = true; break;
      case 'ASSET_INVEST': s = (v >= 3 && v <= 9) ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      // ---- 20261016 D4 新增 5 项 ----
      case 'LPR': s = ind.trend === 'down' ? 1 : (ind.trend === 'up' ? -1 : 0); scored = true; break;
      case 'SOCIAL_FIN': s = v < 0 ? -1 : (v >= 15000 ? 1 : 0); scored = true; break;
      case 'INDUSTRIAL': s = v >= 4 ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      case 'FISCAL_REV': s = v >= 3 ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      case 'FISCAL_EXP': s = v >= 3 ? 1 : (v < 0 ? -1 : 0); scored = true; break;
      default: s = 0;
    }
    if (scored) participating++;
    total++;
    scores.push(s);
    parts.push(`${ind.name.replace(/（.*?）/g, '').slice(0, 6)} ${v}${ind.unit || ''}${s < 0 ? '↓' : s > 0 ? '↑' : '→'}`);
  }
  if (!scores.length) return { signal: 0, score: 0, label: '中性（影响有限）', parts: [], participating: 0, total: 0 };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  let signal = 0, label = '中性（影响有限）';
  if (avg > 0.15) { signal = 1; label = '偏多（支撑风险偏好）'; }
  else if (avg < -0.15) { signal = -1; label = '偏空（压制风险偏好）'; }
  return { signal, score: Math.round(avg * 100) / 100, label, parts, participating, total };
}

function lastClose(shHistory) {
  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  return closes.length ? closes[closes.length - 1] : null;
}

// 取「不晚于 dateStr 的最近一根上证收盘」（shHistory 升序）——用于把基准点位锚定到事件日/数据日
function closeOnOrBefore(shHistory, dateStr) {
  if (!dateStr) return null;
  const bars = (Array.isArray(shHistory) ? shHistory : []).filter(h => h && typeof h.close === 'number' && h.date);
  if (!bars.length) return null;
  let hit = null;
  for (const b of bars) { if (String(b.date).slice(0, 10) <= dateStr) hit = b; else break; }
  return hit ? hit.close : null;
}
// 从事件对象解析日期（dateZh / dateUs 里的 YYYY-MM-DD）
function eventDate(e) {
  const m = String((e && (e.dateZh || e.dateUs)) || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// 单因子「触发 / 休眠 / 相悖归零」状态机
// anchorIndex：本次触发的「基准指数点位」。优先取触发日（事件日/数据日）的上证收盘，
//   缺省回退到本次实时收盘；历史快照若缺 observedIndex（旧版本未持久化）则一并自愈补锚，
//   否则相悖判定会被永久跳过 → 「写着自动归 0、权重却仍是默认值」的自相矛盾。
function stepFactor(prev, triggerKey, signal, curIndex, anchorIndex) {
  const out = { status: prev.status || 'dormant', weight: prev.weight != null ? prev.weight : 0, observedIndex: prev.observedIndex };
  const fresh = prev.lastKey !== triggerKey;
  if (fresh) {
    out.status = 'active';
    out.weight = BASE_WEIGHT;
    out.observedIndex = (anchorIndex != null) ? anchorIndex : curIndex;   // 新触发 → 重新锚定
  } else if (out.status === 'active' && out.observedIndex == null) {
    out.observedIndex = (anchorIndex != null) ? anchorIndex : curIndex;   // 旧快照缺锚 → 自愈补锚
  }
  // 相悖检测：预测方向（signal）与实际方向（curIndex − observedIndex）相反 → 归零休眠
  if (out.status === 'active' && out.observedIndex != null && curIndex != null) {
    const dir = Math.sign(curIndex - out.observedIndex);
    // 预测：signal<0 期望市场向下；signal>0 期望向上。实际方向相反即「相悖」→ 归零休眠
    if ((signal < 0 && dir > 0) || (signal > 0 && dir < 0)) {
      out.status = 'dormant';
      out.weight = 0;
    }
  }
  out.lastKey = triggerKey;
  out.signal = signal;
  out.lastUpdated = new Date().toISOString();
  return out;
}

// ---- 展示文案（按「实际状态」生成，杜绝「写着自动归零、却仍显示默认权重」的自相矛盾）----
function domRuleText(status, signal) {
  if (status === 'dormant') return '本因子权重已因大盘走势与预示方向相悖而自动归 0 并转入休眠，待下期数据公布重新触发。';
  if (!signal) return '当前数据整体中性、无明确方向，因子以默认权重计入（对总分无方向贡献）；待下期数据公布再评估。';
  return '本因子当前处于激活状态（权重未归零）；若大盘走势与预示方向相反，权重将自动归 0 并转入休眠，待下期数据公布再触发。';
}
function usRuleText(status, signal) {
  if (status === 'dormant') return '本因子权重已因「议息后 A 股不跌反涨」与加息拖累预期相悖而自动归 0 并转入休眠，待下次美国宏观事件触发恢复。';
  if (!signal) return '近期无明确方向性美国事件，因子以默认权重计入（对总分无方向贡献）。';
  return '本因子当前处于激活状态（权重未归零）；若议息后 A 股不跌反涨（与「加息拖累全球股市」相悖），权重将自动归 0，待下次美国宏观事件触发恢复。';
}

async function computeMacroFactors({ shHistory } = {}) {
  try {
    const macro = await getMacroIndicators(false);
    const events = getUsMacroEvents();
    const indicators = (macro && macro.indicators) || [];
    // 20261016 审计修复：触发键（domKey）原取「排序后首个指标的 period」，CPI 抓取失败时会
    // 漂移到 PPI 等其他指标的 period → stepFactor 误判「新触发」→ 权重重置为 0.5、状态复活。
    // 现优先取 CPI 的数据期（月度公布、最稳定），CPI 缺失才回退排序首位，最后回退采集日。
    const cpiInd = indicators.find(i => i.key === 'CPI');
    const period = (cpiInd && cpiInd.period) || (indicators[0] && indicators[0].period) || (macro && macro.date) || '';

    const dom = deriveDomestic(indicators);

    const activeEvents = (events || []).filter(e => e && e.id);
    // 20261013c：只锚定 FOMC 利率决议（避免 ADP/非农等 bearish 事件干扰美国因子）；
    // usSignal 按事件实际方向映射（bearish→-1 / bullish→+1 / neutral→0），不再固定 -1。
    const fomc = activeEvents.find(e => /FOMC|利率决议|利率决策/.test(e.title || '')) || null;
    const usSignal = fomc ? (fomc.direction === 'bearish' ? -1 : fomc.direction === 'bullish' ? 1 : 0) : 0;
    const usLabel = fomc
      ? (usSignal < 0 ? '偏空（短期压制全球风险偏好）' : usSignal > 0 ? '偏多（缓解加息压力）' : '中性（决议落地前方向待定）')
      : (activeEvents.length ? '中性（关注待落地事件）' : '中性（近期无重大美国宏观事件）');
    const usKey = (fomc && fomc.id) || (events && events[0] && events[0].id) || 'none';

    const curIndex = lastClose(shHistory);
    const domKey = period || 'dom';
    // 美国因子基准点位锚定到事件日（如 FOMC 当日）收盘，才能判定「议息后 A 股是否不跌反涨」
    const usAnchor = closeOnOrBefore(shHistory, eventDate(fomc));

    const state = readState();
    const domSt = stepFactor(state.DOMESTIC || {}, domKey, dom.signal, curIndex, null);
    const usSt = stepFactor(state.US || {}, usKey, usSignal, curIndex, usAnchor);
    writeState({ DOMESTIC: domSt, US: usSt });

    const domInterp = `最新（${period || '—'}）国内宏观：经济动能${dom.signal < 0 ? '偏弱' : dom.signal > 0 ? '稳健' : '中性'}（${dom.parts.join('，')}）。整体对短期市场情绪${dom.label}（${dom.participating}/${dom.total} 项指标参与方向评分，规则阈值对齐各指标卡片分档口径）。${domRuleText(domSt.status, dom.signal)}`;
    const usInterp = fomc
      ? `近期美国宏观核心事件：${fomc.title}（${fomc.dateZh}）。${fomc.summary} 短期对 A 股风险偏好${usLabel}。${usRuleText(usSt.status, usSignal)}`
      : `近期无重大美国宏观事件，因子维持中性。`;

    return [
      {
        key: 'DOMESTIC_MACRO', name: '国内宏观数据情绪因子', signal: dom.signal,
        weight: domSt.weight, status: domSt.status, interpretation: domInterp,
        source: '每日宏观 & 政策（东方财富数据中心）',
      },
      {
        key: 'US_MACRO', name: '美国宏观事件情绪因子', signal: usSignal,
        weight: usSt.weight, status: usSt.status, interpretation: usInterp,
        source: '每日宏观 & 政策 · 美国经济事件（策划式）',
      },
    ];
  } catch (e) {
    console.error('[macroFactors][COMPUTE] threw:', e && e.stack ? e.stack : String(e));
    return [];
  }
}

module.exports = { computeMacroFactors, BASE_WEIGHT, stepFactor, closeOnOrBefore, eventDate, domRuleText, usRuleText };

~~~

---

## `lib\manualZones.js`  ·  144 行

~~~js
/**
 * 手动阻力 / 支撑区间（用户自填，20261021d）
 * ==========================================================
 * 需求（用户 2026-10-21）：「模块添加一条 tab：可以自行手动添加上方阻力区间和下方支撑区间。」
 *
 * 定位：②「短期动向预判」卡新增一个「手动添加」页签，用户可自己标注模型没识别到的关键位。
 *
 * 三条口径纪律（与模型区间**严格隔离**，否则会污染准确率归因）：
 *   1. 有效性口径演变：20261021e 起手动区间并入短期清单并**同样跑** `lib/zoneValidity.js`
 *      的标准1 检验（无效的不进清单，手动页签标注原因）；20261103h 起进一步接入
 *      `lib/zoneReversal.js` 的「放量有效突破 → 角色反转」生命周期（原手动条目移出清单、
 *      反转记录带 origin:'manual'+manualId，删除时联动清除）。**仍不参与侵蚀收缩**。
 *   2. 手动区间**不参与**方向判断、概率、④卡反转边界、任何准确率统计，只做展示。
 *   3. 落盘在 `data/manual-zones/<symbol>.json`，与模型的 `data/judgments`、`data/market-tech` 互不相干。
 *
 * 存储结构：
 *   { symbol: '600909', zones: [ { id, side, low, high, note, createdAt } ], updatedAt }
 *
 * 校验：side 必须 resistance/support；low/high 必须 >0 且 low<=high；同侧同区间去重；
 *       每侧最多 MAX_PER_SIDE 条（防误点刷屏）；备注截断到 40 字。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'manual-zones');
const MAX_PER_SIDE = 20;
const NOTE_MAX = 40;
const ROUND = 2;

function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(symbol) { return path.join(DIR, normalizeSymbol(symbol) + '.json'); }

/** 统一代码：允许 sh600909 / 600909.SH / 600909，一律归一为 6 位数字 */
function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const r2 = (n) => Math.round(n * 100) / 100;
const _num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

function readStore(symbol) {
  const sym = normalizeSymbol(symbol);
  const base = { symbol: sym, zones: [], updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
    if (!raw || !Array.isArray(raw.zones)) return base;
    // 读侧也做一次净化：脏数据（写坏的区间/非法 side）不进入展示
    const zones = raw.zones.filter(z => z && (z.side === 'resistance' || z.side === 'support')
      && _num(z.low) > 0 && _num(z.high) > 0 && _num(z.low) <= _num(z.high))
      .map(z => ({
        id: String(z.id || ''),
        side: z.side,
        low: r2(_num(z.low)),
        high: r2(_num(z.high)),
        note: String(z.note || '').slice(0, NOTE_MAX),
        createdAt: z.createdAt || null,
      }));
    return { symbol: sym, zones, updatedAt: raw.updatedAt || null };
  } catch (e) {
    return base;   // 文件不存在 / 解析失败 → 空，不编造
  }
}

function writeStore(symbol, store) {
  ensureDir();
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym, zones: store.zones, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileFor(sym), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/** 列表（按价格降序返回，前端直接渲染即可） */
function listZones(symbol) {
  const s = readStore(symbol);
  const byPriceDesc = (a, b) => (b.high - a.high) || (b.low - a.low);
  return {
    symbol: s.symbol,
    resistances: s.zones.filter(z => z.side === 'resistance').sort(byPriceDesc),
    supports: s.zones.filter(z => z.side === 'support').sort(byPriceDesc),
    total: s.zones.length,
    updatedAt: s.updatedAt,
    limits: { maxPerSide: MAX_PER_SIDE, noteMax: NOTE_MAX },
  };
}

/**
 * 新增一条手动区间。
 * @returns {{ok:boolean, zone?:object, data?:object, error?:string}}
 */
function addZone(symbol, input) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { ok: false, error: '股票代码无效' };
  const side = String((input && input.side) || '').trim();
  if (side !== 'resistance' && side !== 'support') return { ok: false, error: '方向必须是阻力或支撑' };
  const low = _num(input && input.low);
  let high = _num(input && input.high);
  if (low == null) return { ok: false, error: '请填写有效价格' };
  // 只填一个价位 = 单点区间（前端也这么传，接口层再兜一次，避免调用方漏传 high 就被判非法）
  if (high == null && String((input && input.high) || '').trim() === '') high = low;
  if (high == null) return { ok: false, error: '请填写有效价格' };
  if (!(low > 0) || !(high > 0)) return { ok: false, error: '价格必须大于 0' };
  if (low > high) return { ok: false, error: '下沿不能高于上沿' };

  const store = readStore(sym);
  const l = r2(low), h = r2(high);
  const same = store.zones.filter(z => z.side === side);
  if (same.some(z => z.low === l && z.high === h)) {
    return { ok: false, error: '该区间已存在' };
  }
  if (same.length >= MAX_PER_SIDE) {
    return { ok: false, error: `每侧最多 ${MAX_PER_SIDE} 条，请先删除旧条目` };
  }
  const zone = {
    id: 'mz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    side,
    low: l,
    high: h,
    note: String((input && input.note) || '').trim().slice(0, NOTE_MAX),
    createdAt: new Date().toISOString(),
  };
  store.zones.push(zone);
  const data = writeStore(sym, store);
  return { ok: true, zone, data: listZones(sym) };
}

/** 删除一条（按 id） */
function removeZone(symbol, id) {
  const sym = normalizeSymbol(symbol);
  const store = readStore(sym);
  const idx = store.zones.findIndex(z => z.id === String(id || ''));
  if (idx < 0) return { ok: false, error: '未找到该条目' };
  const [removed] = store.zones.splice(idx, 1);
  writeStore(sym, store);
  return { ok: true, removed, data: listZones(sym) };
}

module.exports = { listZones, addZone, removeZone, normalizeSymbol, DIR, MAX_PER_SIDE, NOTE_MAX };

~~~

---

## `lib\marketEmotionData.js`  ·  348 行

~~~js
/**
 * 大盘量能情绪模型 · 数据采集层（lib/marketEmotionData.js · 20260917d）
 * --------------------------------------------------------------
 * 职责单一：把 scripts/market_emotion.py 的市场级原始数据取回来并做「数据源异常自检」，
 * 不做任何判断/打分（打分在 lib/marketEmotionModel.js，确定性计算）。
 *
 * 数据块（单一权威源）：
 *   index    上证指数最近 320 交易日量价（首页量能根 lib/marketTechnical.fetchIndexDailyBars
 *            单一通道·腾讯 fqkline 直采，vol=成交量·手；20261018 起不再走 market_emotion.py
 *            的 akshare 通道——实测两条通道重叠 260 根 date/close/vol 零差异，收敛后窗口统一 320）
 *   breadth  上涨/下跌/平盘/涨停/跌停家数（乐咕乐股·市场活跃度）
 *   margin   沪深融资余额 + 融券余额（亿元）+ 各自的 5 日变化（沪深交易所 / 金十；20261109a 增 rq* 字段）
 *   mainFund 市场主力净额（亿元，东财 push2delay，主力=超大单+大单）
 *   capital  全市场成交额 / 换手率均值 / 成交额前10%占比（同花顺个股资金流聚合）
 *   fx       USD/CNH、USD/CNY 及涨跌幅（新浪财经）
 *   bond     中国 10 年期国债收益率及 5 日变化（bp）
 *
 * 自检规则（spec §八.4）：任一块缺失 / 数值为 0 / 明显过期 → 记入 issues，
 * 由模型侧把该因子权重临时归零并按比例分摊，绝不用错误数据硬算。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');
const { fetchReport } = require('./emDataCenter');
// 20261018：index（上证日线）改由首页量能根单一通道采集（lib/marketTechnical 与大盘技术分析
// 同源同窗口），market_emotion.py 不再返回 index 块
const { fetchIndexDailyBars } = require('./marketTechnical');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'market_emotion.py');

const _cache = { ts: 0, date: '', data: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * [20261015d] 主力资金 S1（主稳定源）：东财「数据中心」行业资金流报表求和（datacenter-web，本机稳定可达）。
 * 为什么可行：RPT_INDUSTRY_FUNDFLOW 按日给出全部申万行业（128 个板块/日）的 SUPERDEAL_NET(超大单)
 * 与 BIGDEAL_NET(大单)，行业是对沪深两市的完整划分 → 全行业求和 ≈ 沪深两市主力净额，与
 * push2 fflow daykline（主链）完全同一东财口径、同一单位（元）。
 * 完整性守卫：当日板块行数必须 ≥ 前一交易日行数，否则视为「当日行尚未发布完整」，不产出当日值
 *（宁可缺失，绝不拿半截数据冒充当日）。
 * 时效：本报表只含「已收盘交易日」，盘中/盘前最新行通常为 T-1（收盘口径），与 push2delay 实时主链不同。
 * 20261024a：此前 getMarketEmotionData 用 `fb.date === today` 硬门槛拒收 T-1 → 因子永久「缺失」。
 * 现改为接受「最新已收盘交易日」并如实标注口径日（见 _enrichMainFundSource），与融资余额 T+1 同范式。
 * @returns {Promise<object>} 与 scripts/market_emotion.py fetch_main_fund 同形状
 */
async function fetchMainFundViaDataCenter() {
  const rows = await fetchReport('RPT_INDUSTRY_FUNDFLOW', { sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 500 });
  if (!rows.length) throw new Error('行业资金流报表为空');
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { n: 0, main: 0, big: 0, superBig: 0 });
    const o = byDate.get(d);
    o.n++;
    const sv = Number(r.SUPERDEAL_NET), bv = Number(r.BIGDEAL_NET);
    if (isFinite(sv)) { o.superBig += sv; o.main += sv; }
    if (isFinite(bv)) { o.big += bv; o.main += bv; }
  }
  const dates = [...byDate.keys()];
  if (!dates.length) throw new Error('行业资金流无可解析日期行');
  const latest = dates[0];               // 已按 TRADE_DATE 倒序，第一组即最新交易日
  const prev = dates[1] || null;
  const latestAgg = byDate.get(latest);
  const prevN = prev ? byDate.get(prev).n : null;
  // 完整性守卫：当日行数 < 前日行数 → 当日尚未发布完整 → 当日值不给（mainNetToday=null），历史照给
  const complete = prevN == null || latestAgg.n >= prevN;
  const toYi = (v) => Math.round(v / 1e8 * 100) / 100;
  return {
    date: latest,
    mainNetToday: complete ? toYi(latestAgg.main) : null,
    bigNet: complete ? toYi(latestAgg.big) : null,
    superBigNet: complete ? toYi(latestAgg.superBig) : null,
    mainNetPct: null,                    // 报表无全市场净占比，宁缺毋假
    history: dates.slice(0, 6).map(d => ({ date: d, mainNet: toYi(byDate.get(d).main) })),
    source: `东方财富·数据中心行业资金流求和（${latestAgg.n} 板块，超大单+大单=主力，与 push2 主链同口径${complete ? '' : `；当日行尚未发布完整（${latestAgg.n}/${prevN}），当日值暂缺`}）`,
  };
}

/**
 * [20261024a] 主力资金 S2（兜底交叉校验源）：东财「数据中心」板块资金流报表求和（datacenter-web，稳定可达）。
 * 与 S1 同源（东财·数据中心族），但覆盖维度不同——RPT_FUNDFLOW_BOARD 是「概念板块」(BK 代码)，
 * 板块间有股票重叠 → 求和会重复计入，量级可能偏高，故仅作 S1 不可达时的兜底，source 如实标注。
 * 单位：报表 AMOUNT/SUPERDEAL_AMOUNT/BIGDEAL_AMOUNT 均为「万元」，需 ×1e4 转元、÷1e8 转亿。
 * 主力 = 超大单净额(SUPERDEAL_AMOUNT) + 大单净额(BIGDEAL_AMOUNT)，与 S1 口径一致。
 * 完整性守卫同 S1：最新交易日板块行数需 >= 前一交易日，否则当日值不给（mainNetToday=null）。
 * @returns {Promise<object>} 与 fetchMainFundViaDataCenter 同形状
 */
async function fetchMainFundViaBoardFlow() {
  const rows = await fetchReport('RPT_FUNDFLOW_BOARD', { sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 500 });
  if (!rows.length) throw new Error('板块资金流报表为空');
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { n: 0, superWan: 0, bigWan: 0, mainWan: 0 });
    const o = byDate.get(d);
    o.n++;
    const sv = Number(r.SUPERDEAL_AMOUNT), bv = Number(r.BIGDEAL_AMOUNT);
    if (isFinite(sv)) { o.superWan += sv; o.mainWan += sv; }
    if (isFinite(bv)) { o.bigWan += bv; o.mainWan += bv; }
  }
  const dates = [...byDate.keys()];
  if (!dates.length) throw new Error('板块资金流无可解析日期行');
  const latest = dates[0];               // 已按 TRADE_DATE 倒序
  const prev = dates[1] || null;
  const latestAgg = byDate.get(latest);
  const prevN = prev ? byDate.get(prev).n : null;
  const complete = prevN == null || latestAgg.n >= prevN;
  const toYi = (v) => Math.round(v * 1e4 / 1e8 * 100) / 100; // 万元 → 亿元
  return {
    date: latest,
    mainNetToday: complete ? toYi(latestAgg.mainWan) : null,
    bigNet: complete ? toYi(latestAgg.bigWan) : null,
    superBigNet: complete ? toYi(latestAgg.superWan) : null,
    mainNetPct: null,
    history: dates.slice(0, 6).map(d => ({ date: d, mainNet: toYi(byDate.get(d).mainWan) })),
    source: `东方财富·数据中心板块资金流汇总（${latestAgg.n} 概念板块，可能含跨板块重复计入，仅作兜底）`,
  };
}

/**
 * [20261024a] 主力资金注入助手：把稳定源链路（fetchMarketMainFund）的结果注入 raw.mainFund。
 * 抽成独立函数便于离线测试（不依赖 runScript/python）。行为与原内联逻辑完全一致：
 *   - raw.mainFund 已有有效当日值 → 不动；
 *   - 否则调 fetchMarketMainFund()（S1 行业资金流求和优先 + S2 板块资金流汇总兜底）；
 *   - 取到则注入 raw.mainFund（同形状，source 已标注口径日/T-lag）；取不到返回说明文案。
 * @returns {string|null} 取数失败时的说明文案（成功为 null）
 */
async function resolveMainFund(raw, today) {
  if (!raw.mainFund || raw.mainFund.mainNetToday == null) {
    try {
      const fb = await fetchMarketMainFund();
      if (fb && fb.mainNetToday != null) {
        raw.mainFund = fb; // 同形状注入；source 已如实标注口径日与「T-lag 收盘口径」
      } else {
        return '主力资金：东财数据中心行业/板块资金流报表均未取到有效数据（数据源恢复后每日快照自动回补）';
      }
    } catch (e) {
      console.warn('[MarketOverview] 主力资金稳定源（数据中心）失败:', e && e.message ? e.message : e);
      return '主力资金：东财数据中心行业/板块资金流报表均不可达';
    }
  }
  return null;
}

/**
 * [20261024a] 主力资金稳定源链路：S1（行业资金流求和，沪深全市场完整划分）优先；
 * S1 抛错或取不到有效值时降级 S2（板块资金流汇总兜底）；两源均失败返回 null。
 * 两个源都来自东财「数据中心族」（本机稳定可达），不引入异源，满足项目「数据一致性」铁律。
 * 返回块 shape 与 fetch_main_fund 一致；口径日与「T-lag 收盘口径」标注由 _enrichMainFundSource 统一追加。
 * @returns {Promise<object|null>}
 */
async function fetchMarketMainFund() {
  // S1：行业资金流求和（申万 128 行业 = 沪深两市完整划分，单位元，与 push2 主链同口径）
  try {
    const fb = await fetchMainFundViaDataCenter();
    if (fb && fb.mainNetToday != null) return _enrichMainFundSource(fb);
  } catch (e) {
    console.warn('[MarketOverview] 主力资金 S1（行业资金流）失败:', e.message);
  }
  // S2：板块资金流汇总（概念板块，仅作 S1 不可达兜底）
  try {
    const fb = await fetchMainFundViaBoardFlow();
    if (fb && fb.mainNetToday != null) return _enrichMainFundSource(fb);
  } catch (e) {
    console.warn('[MarketOverview] 主力资金 S2（板块资金流）失败:', e.message);
  }
  return null;
}

/** [20261024a] 给主力资金源追加「口径日 + T-lag 收盘口径」标注，保证数据最新性规则（标注时效） */
function _enrichMainFundSource(fb) {
  const today = localDate();
  const lagDays = fb.date ? Math.round((Date.parse(today) - Date.parse(fb.date)) / 86400000) : null;
  const lagNote = (lagDays && lagDays > 0)
    ? `；口径日 ${fb.date}（T-${lagDays} 收盘，非实时当日）`
    : (fb.date ? `；口径日 ${fb.date}` : '');
  return { ...fb, source: (fb.source || '') + lagNote };
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tradingDaysBetween(a, b) {
  // 粗略估算两个日期之间相隔的自然日（用于数据新鲜度判断）
  const d1 = Date.parse(a + 'T00:00:00');
  const d2 = Date.parse(b + 'T00:00:00');
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

async function runScript() {
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('market_emotion.py 不存在: ' + SCRIPT);
  const out = await execFileAsync(py, [SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

/** 数据源异常自检 → issues 列表 */
function selfCheck(data, today) {
  const issues = [];
  const push = (block, msg) => issues.push({ block, msg });

  // index：需 >= 25 根用于动量/均线，>= 120 用于 1 年分位
  const bars = data.index && Array.isArray(data.index.bars) ? data.index.bars : [];
  if (!bars.length) push('index', '上证指数日线缺失');
  else {
    if (bars.length < 25) push('index', `上证指数日线仅 ${bars.length} 根（<25，动量/均线不可用）`);
    const lastBar = bars[bars.length - 1];
    const lag = tradingDaysBetween(lastBar.date, today);
    if (lag != null && lag > 4) push('index', `上证指数日线最新为 ${lastBar.date}，滞后 ${lag} 天`);
    if (!(lastBar.vol > 0)) push('index', '上证指数最新成交量为 0');
  }

  const b = data.breadth;
  if (!b) push('breadth', '涨跌家数缺失');
  else {
    if (!(b.up + b.down > 0)) push('breadth', '涨跌家数全为 0');
    const lag = tradingDaysBetween(b.date, today);
    if (lag != null && lag > 4) push('breadth', `涨跌家数统计日为 ${b.date}，滞后 ${lag} 天`);
  }

  const m = data.margin;
  if (!m) push('margin', '融资/融券余额缺失');
  else if (!(m.latest > 0)) push('margin', '融资余额为 0');
  // [20261109a] 融券余额单独缺失不把整卡判为 issue（不降级、不分摊权重）：
  //   calcMargin 会把融券子项记 0 方向、只计融资半权重，并在卡片文案中如实披露。

  const mf = data.mainFund;
  if (!mf || mf.mainNetToday == null) push('mainFund', '市场主力净额缺失（东财 push2 实时通道与数据中心收盘口径备链均未取到当日数据；数据源恢复后每日快照自动回补，因子权重已按规则归零分摊）');

  const cap = data.capital;
  if (!cap) push('capital', '市场成交额缺失');
  else if (!(cap.totalAmount > 0)) push('capital', '全市场成交额为 0');

  const fx = data.fx;
  if (!fx || !(fx.usdcnh > 0 || fx.usdcny > 0)) push('fx', '人民币汇率缺失');

  const bond = data.bond;
  if (!bond || !(bond.cn10y > 0)) push('bond', '国债收益率缺失');

  return issues;
}

/**
 * 取市场级原始数据（带缓存 + 自检）。
 * @param {{refresh?:boolean}} opts
 * @returns {Promise<object>} { ok, date, index, breadth, margin, mainFund, capital, fx, bond, issues, warnings, fetchedAt, fromCache }
 */
async function getMarketEmotionData(opts = {}) {
  const today = localDate();
  const now = Date.now();
  if (!opts.refresh && _cache.data && now - _cache.ts < CACHE_TTL) {
    return { ..._cache.data, fromCache: true };
  }
  let raw;
  try {
    raw = await runScript();
  } catch (e) {
    const errData = { ok: false, date: today, issues: [{ block: 'all', msg: '采集脚本失败: ' + (e && e.message) }], warnings: [], fetchedAt: new Date().toISOString() };
    _cache.ts = now; _cache.date = today; _cache.data = errData;
    return errData;
  }
  // [20261024a] 主力资金稳定源链路（必须在 selfCheck 之前注入，保证 issues 反映注入后的真实状态）：
  // 旧逻辑主链 push2delay 实时通道本机常年被 TLS 重置 → 长期取不到当日数据，因子永久「缺失」；
  // 备链（数据中心行业资金流求和）本机稳定可达，但旧代码用 `fb.date === today` 硬门槛拒收 T-1
  //（盘中报表只发布到上一收盘日），导致连稳定源也被丢弃。
  // 现改用 fetchMarketMainFund()：S1 行业资金流求和优先，S1 不可达降级 S2 板块资金流汇总兜底；
  // 接受「最新已收盘交易日」（通常 T-1），由 _enrichMainFundSource 如实标注口径日与「T-lag 收盘口径」，
  // 与融资余额 T+1 同范式——不再因非要「实时当日」而长期空白。收盘后东财发布当日报表时自动变为 T-0。
  const mainFundFallbackNote = await resolveMainFund(raw, today);
  // [20261018] index（上证日线）改由首页量能根单一通道采集：与大盘技术分析同源（腾讯 fqkline
  // 直采）、同窗口（320）、同单位（vol=成交量·手）；原 market_emotion.py 的 akshare 通道
  // 实测与直采重叠 260 根零差异，收敛后只保留一条通道。输出格式不变：
  // { code, name, bars:[{date, close, vol}] }（失败如实记入 issues，不用其他数据冒充）。
  let indexBlock = null, indexErr = null;
  try {
    const rootBars = await fetchIndexDailyBars(320);
    if (rootBars && rootBars.length) {
      indexBlock = {
        code: 'sh000001', name: '上证指数',
        bars: rootBars.map(b => ({ date: b.date, close: b.close, vol: b.volume })),
      };
    }
  } catch (e) {
    indexErr = e;
    console.warn('[MarketEmotionData] 上证日线（量能根通道）失败:', e.message);
  }
  raw.index = indexBlock; // 自检与输出统一用根通道结果（Python 不再返回 index）
  // 20261023o：深证成指日线（与上证同通道、同窗口），供「量能活跃与量价配合」同时分析深市。
  // 失败只让深市子项缺失（卡片按上证单市降级），不影响主流程。
  let indexSZBlock = null, indexSZErr = null;
  try {
    const szBars = await fetchIndexDailyBars(320, 'sz399001');
    if (szBars && szBars.length) {
      indexSZBlock = {
        code: 'sz399001', name: '深证成指',
        bars: szBars.map(b => ({ date: b.date, close: b.close, vol: b.volume })),
      };
    }
  } catch (e) {
    indexSZErr = e;
    console.warn('[MarketEmotionData] 深证成指日线（量能根通道）失败:', e.message);
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.slice() : [];
  const extra = selfCheck(raw, today);
  if (indexErr) extra.push({ block: 'index', msg: '上证指数日线采集失败（量能根通道）：' + indexErr.message });
  if (indexSZErr) extra.push({ block: 'indexSZ', msg: '深证成指日线采集失败（量能根通道）：' + indexSZErr.message });
  if (mainFundFallbackNote) extra.push({ block: 'mainFund', msg: mainFundFallbackNote });
  const data = {
    ok: raw.ok !== false && extra.filter(i => i.block === 'index' || i.block === 'breadth').length === 0,
    date: today,
    index: raw.index || null,
    indexSZ: indexSZBlock,
    breadth: raw.breadth || null,
    margin: raw.margin || null,
    mainFund: raw.mainFund || null,
    capital: raw.capital || null,
    fx: raw.fx || null,
    bond: raw.bond || null,
    issues: issues.concat(extra),
    warnings: raw.warnings || [],
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  _cache.ts = now; _cache.date = today; _cache.data = data;
  return data;
}

module.exports = { getMarketEmotionData, fetchMainFundViaDataCenter, fetchMainFundViaBoardFlow, fetchMarketMainFund, resolveMainFund, SCRIPT };

~~~

---

## `lib\marketEmotionModel.js`  ·  1414 行

~~~js
/**
 * 大盘量能情绪分析模型 · 计算引擎（lib/marketEmotionModel.js · 20260917d）
 * ==================================================================
 * 用户 20260917 给出的完整逻辑（「大盘量能情绪分析模型——完整执行逻辑（最终版）」）
 * 的确定性实现：所有打分/权重/学习规则全部由代码执行，**无 LLM 参与**。
 *
 * 因子（10 个 = 8 常驻 + 2 非常驻）与基准权重（20261015k：量能活跃度 15 与量价配合度 10
 * 合并为「量能活跃与量价配合」25，加权合成，合并前后总分贡献数学等价）：
 *   量能活跃与量价配合 25 | 市场宽度与极端情绪 15 | 大盘近期涨跌势头 10
 *   融资余额 10 | 主力资金流向 10 | 股吧讨论热度 10（反向）| 避险情绪 10
 *   国内宏观数据情绪 5（非常驻）| 美国宏观事件情绪 5（非常驻）
 *
 * 覆盖规则：§四 因子计算 / §五 非常驻衰减 / §六 自学习与准确率 /
 *           §七 总分与动态归一化 / §八 长期自适应（极端值剔除·双基准·风格自适应·
 *           数据自检·月度健康报告·极端熔断）/ §九 时间周期与数据质量修正 / §十 输出格式。
 *
 * 存储：data/market-emotion/
 *   state.json      自学习权重状态 + 因子准确率台账
 *   snapshots.json  每日快照（主力净额/热度/量比…）→ 供 5 日均值与历史分位
 *   records.json    预测台账（T+1 / T+3 / T+5 事后核对）
 *   health/YYYY-MM.json 模型健康度月度报告
 */

const fs = require('fs');
const path = require('path');
// 只取别名：本文件自己声明了 function localDate（委托用），避免重名冲突
const { localDate: _localDate } = require('./localDate');
const { previousTradingDay } = require('./cnTradingCalendar');
// 20261018：首页侧量能收敛——量能量能活跃度/量价配合度的底层指标统一走大盘技术分析的
// 量价关系根（lib/marketTechnical.computeMarketVolumeMetrics，与个股侧 capitalFlow 收敛同模式）
const { computeMarketVolumeMetrics } = require('./marketTechnical');

// 允许用环境变量覆盖存储目录（离线回归测试用；生产默认 data/market-emotion）
const DIR = process.env.SA_MARKET_EMOTION_DIR
  ? path.resolve(process.env.SA_MARKET_EMOTION_DIR)
  : path.join(__dirname, '..', 'data', 'market-emotion');
const HEALTH_DIR = path.join(DIR, 'health');
const STATE_FILE = path.join(DIR, 'state.json');
const SNAP_FILE = path.join(DIR, 'snapshots.json');
const REC_FILE = path.join(DIR, 'records.json');

const MID_HORIZON = 20;

// ---- 基准权重（spec §三.2；20261015k：量能活跃度+量价配合度合并为量能活跃与量价配合 25）----
// 20261022h：新增「宽基ETF申购赎回」常驻因子（10%）。原有 7 个常驻因子按比例压缩让出 10 个点
// （25→22、15→13、其余 5 个 10→9，常驻合计仍 90），非常驻国内/美国宏观 5+5 不变，总和恒 100。
const BASE_WEIGHTS = {
  volumePrice: 22,
  breadthExtreme: 13,
  indexMomentum: 9,
  margin: 9,
  mainCapital: 9,
  discussionHeat: 9,
  riskAversion: 9,
  etfFlow: 10,
  domesticMacro: 5,   // 非常驻
  usMacro: 5,         // 非常驻
};
const NON_RESIDENT = ['domesticMacro', 'usMacro'];
const FACTOR_NAMES = {
  volumePrice: '量能活跃与量价配合',
  breadthExtreme: '市场宽度与极端情绪',
  indexMomentum: '大盘近期涨跌势头',
  // [20261109a] 卡内新增融券余额双栏，标题缩短避免折行；margin key 不变（自学习 state.weights 旧键继续兼容）
  margin: '两融余额',
  mainCapital: '主力资金流向',
  discussionHeat: '股吧讨论热度（散户情绪·反向）',
  riskAversion: '避险情绪',
  etfFlow: '宽基ETF申购赎回（增量资金）',
  domesticMacro: '国内宏观数据情绪',
  usMacro: '美国宏观事件情绪',
};

// ---- 自学习约束（spec §三.3）----
const W_MIN = 5;           // 常驻因子权重下限 %
const W_MAX = 30;          // 常驻因子权重上限 %
const LEARN_MIN_SAMPLE = 20;   // 权重自学习最小样本（spec §六.样本量要求）
const LEARN_WINDOW = 30;       // 最近 30 次
const UP_THRESHOLD = 0.60;
const DOWN_THRESHOLD = 0.45;
const UP_STEP = 0.15;      // 上调 10%~20%（取中值 15%）
const DOWN_STEP = 0.15;    // 下调 10%~20%

// ---- 非常驻衰减（spec §五）----
const DECAY_PER_DAY = 0.8;
const DECAY_FLOOR = 1;     // 权重低于 1% 归零休眠

// ---- 双基准（spec §八.2）----
const VOL_PCTL_LOW = 0.10;
const VOL_PCTL_HIGH = 0.90;

// ---- 热度时效（spec §九：滞后数据打折 / 过期剔除）----
const LAG_DEGRADE_DAYS = 3;   // 股吧热度滞后 >= 3 个交易日 → 降级归零并分摊

const FLAT_TOL = 0.5;

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
// 20261025n：权重=评分统一口径（用户要求「市场情绪提醒 8 因子参考个股短期判断模块同样修改」）——
// 因子只取满格方向（+1/-1/0），评分 = 方向 × 权重（净权重），不再乘 0.6 这类强度折扣；
// 强度信息保留在因子文案与核心驱动排序里。
// [20261109a] 例外：两融余额（margin）两子项平分权重，score 允许 ±0.5，
// 该因子以 subScore 标记，净权重与总分改用原始 score（见 dirWeight），不走本函数。
function dirOf(s) { return s > 0 ? 1 : (s < 0 ? -1 : 0); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); }
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function ensureHealthDir() { try { if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true }); } catch (e) {} }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) { try { ensureDir(); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch (e) {} }

// 统一委托给 lib/localDate.js（北京时区，不依赖宿主机时区；UTC+8 下逐点等价）
function localDate(d = new Date()) { return _localDate(d); }

/** 分位数（0~1），线性插值 */
function percentile(values, p) {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  const pos = clamp(p, 0, 1) * (arr.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

// 20261023l：紧凑/带横线日期 → 上一交易日（带横线），供「T+1 例行披露」因子标注真实数据日
function _prevTdDash(dateStr) {
  const s = String(dateStr || '');
  const dashed = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
  return dashed ? previousTradingDay(dashed) : '';
}
/** 某值在过去窗口中的分位（0~1） */
function rankPercentile(values, v) {
  const arr = values.filter(x => typeof x === 'number' && isFinite(x));
  if (!arr.length || typeof v !== 'number') return null;
  let below = 0;
  for (const x of arr) if (x < v) below++;
  return below / arr.length;
}

/** 滚动窗口极端值剔除（spec §八.1）：剔除 > mean+3σ 的样本后返回剩余
 *  20261018：量能活跃度路径的剔除逻辑已随指标计算迁入首页量能根
 *  （lib/marketTechnical.computeMarketVolumeMetrics 内的逐行等价副本 _mTrimExtremes），
 *  本函数保留供导出 API 兼容与潜在复用（calcDiscussionHeat 的热度分位不用本函数）。 */
function trimExtremes(values, sigma = 3) {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v));
  if (arr.length < 10) return { kept: arr, removed: 0 };
  const m = mean(arr), s = std(arr);
  const cap = m + sigma * s;
  const kept = arr.filter(v => v <= cap);
  return { kept, removed: arr.length - kept.length };
}

// ================= 数据源状态读写 =================
/**
 * 20261015k 因子结构合并迁移（幂等）：量能活跃度(15) + 量价配合度(10) → 量能活跃与量价配合(25)。
 * 自学习调整过的权重取两旧 key 之和（保留学习成果）；未学过则回落合并基准 25。
 * 超 W_MAX 的部分由 computeWeights 的 scaleBounded 夹紧，不破坏边界与总和 100%。
 * 历史 factorAcc 的旧 key 记账保留不迁移（准确率台账可追溯；新因子学习从零开始，仍需 20 样本）。
 */
function migrateVolumePriceWeights(s) {
  const w = s.weights || {};
  if (typeof w.volumePrice !== 'number') {
    const oldVa = typeof w.volumeActivity === 'number' ? w.volumeActivity : 15;
    const oldPv = typeof w.priceVolume === 'number' ? w.priceVolume : 10;
    w.volumePrice = round(oldVa + oldPv, 2);
  }
  delete w.volumeActivity;
  delete w.priceVolume;
}
function loadState() {
  const s = readJson(STATE_FILE, null);
  if (s && s.weights) { migrateVolumePriceWeights(s); return s; }
  return {
    weights: { ...BASE_WEIGHTS },
    factorAcc: {},      // key -> { samples:[], total, correct }
    events: {},         // domesticMacro/usMacro -> { status, initialWeight, weight, lastTrigger, decayDays }
    lastUpdated: null,
  };
}
function saveState(s) { s.lastUpdated = new Date().toISOString(); writeJson(STATE_FILE, s); }
function loadSnapshots() { const a = readJson(SNAP_FILE, []); return Array.isArray(a) ? a : []; }
function saveSnapshots(a) { writeJson(SNAP_FILE, a); }
function loadRecords() { const a = readJson(REC_FILE, []); return Array.isArray(a) ? a : []; }
function saveRecords(a) { writeJson(REC_FILE, a); }

/** 引导：从既有 MSI 序列读取「股吧讨论热度」历史（免等待 10 天冷启动） */
function loadHeatHistoryFromMSI() {
  try {
    // 允许用 SA_MSI_SERIES 覆盖路径，便于零网络回归测试完全隔离（默认读生产序列）
    const p = process.env.SA_MSI_SERIES || path.join(__dirname, '..', 'data', 'sentiment-index', 'series.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const s of arr) {
      const c = (s.components || []).find(x => x.key === 'marketHeat');
      if (c && typeof c.signal === 'number' && s.date) out.push({ date: s.date, heat: c.signal });
    }
    return out;
  } catch (e) { return []; }
}

/** 合并热度历史（MSI 引导 + 本模型快照），按日期去重排序；保留日期以便做「交易日过滤 + 时效校验」 */
function mergeHeatHistory(snapshots) {
  const map = new Map();
  for (const h of loadHeatHistoryFromMSI()) map.set(h.date, h.heat);
  for (const s of snapshots) if (typeof s.heat === 'number' && s.date) map.set(s.date, s.heat);
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, heat]) => ({ date, heat }));
}

/**
 * 交易日滞后：heatDate 距 modelDate 之间隔了几个交易日（用上证 bars 的日期当交易日历）。
 * 返回 0 表示同日；null 表示无法判断（缺日期）。
 */
function tradingLagDays(heatDate, modelDate, barDates) {
  if (!heatDate || !modelDate) return null;
  if (heatDate === modelDate) return 0;
  const after = barDates.filter(dt => dt > heatDate).length;
  if (after > 0) return after;
  const a = Date.parse(heatDate), b = Date.parse(modelDate);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(1, Math.round((b - a) / 86400000));
}

// ================= 因子计算 =================

/** 1) 量能活跃度（15%） */
function calcVolumeActivity(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 25) return { score: 0, degraded: true, reason: '上证日线不足 25 根', value: '' };
  // 20261018：底层指标改引首页量能根 lib/marketTechnical.computeMarketVolumeMetrics
  // （与个股侧 capitalFlow 收敛同款模式：根算指标、本模块只保留打分与文案），口径逐行一致。
  const m = computeMarketVolumeMetrics(bars);
  if (!m) return { score: 0, degraded: true, reason: '上证日线不足 25 根', value: '' };
  const ratio = m.ratio;

  // 双基准：过去 1 年分位
  const pct = m.volPct;

  let score = 0, state = '平量', note = '';
  // [20261024b] 阈值对齐项目「量比」铁律（同基准 ÷近20日均量，与最新日函数/技术页统一）：>1.2 放量 / <0.8 缩量
  if (ratio > 1.2) { score = 1; state = '放量'; }
  else if (ratio < 0.8) { score = -1; state = '缩量'; }
  else { score = 0; state = '平量'; }

  // 方向修正：放量必须结合市场宽度
  if (score === 1) {
    const b = d.breadth;
    const upRatio = b ? b.up / Math.max(1, b.up + b.down) : null;
    if (upRatio != null) {
      if (upRatio < 0.45) { score = -1; note = '放量且普跌 → 恐慌抛售'; }
      else if (upRatio > 0.55) { note = '放量且普涨 → 健康上涨'; }
      else { note = '放量但涨跌互现，方向不明'; }
    }
  }

  // 双基准修正（spec §八.2）
  if (pct != null) {
    if (pct < VOL_PCTL_LOW) {
      if (score > 0 || ratio > 1.3) { score = Math.min(score, 0); note = '量能处于过去1年10%分位以下 → 属极度缩量后的微弱反弹，不判健康放量'; }
      else note = note || '量能处于过去1年低位';
    } else if (pct > VOL_PCTL_HIGH) {
      note = (note ? note + '；' : '') + '量能处于历史高位，警惕过热';
      if (score > 0) score = Math.min(score, 0.5);
    }
  }

  const value = `量比 ${round(ratio, 2)}（${state}）· 1年分位 ${pct != null ? round(pct * 100, 0) + '%' : '—'}`;
  const detail = `今日成交 ${round(m.volToday / 1e8, 1)} 亿手 ÷ 近20日均量 ${round(m.avg20Excl / 1e8, 1)} 亿手 = ${round(ratio, 2)} 倍${m.removed ? `（20日窗口剔除 ${m.removed} 个极端值）` : ''}${note ? '；' + note : ''}`;
  return { score, degraded: false, value, detail, ratio: round(ratio, 3), volPct: pct != null ? round(pct, 3) : null, state };
}

/**
 * 1) 量能活跃与量价配合（25% = 原「量能活跃度 15」+「量价配合度 10」，20261015k 按用户需求合并）
 * 得分 =（量能活跃度得分 × 15 + 量价配合度得分 × 10）÷ 25 —— 按原权重加权合成，
 * 权重不变时与合并前两因子分别计分对总分的贡献数学等价（数据不变则结论不变）。
 * 降级：任一半不可用 → 整体降级归零并按比例分摊（两半同源于上证日线，实际同生同死；
 * 单边缺失只在 breadth 异常等场景出现，此时按规则整体降级并在 reason 中说明是哪一半）。
 */
function calcVolumePrice(d) {
  // 20261023o：口径改为「最新日 + 上证/深证双市」；旧 5日/3日函数保留不动（大盘技术分析/守卫用）。
  const va = calcVolumeActivityLatest(d);
  const pv = calcPriceVolumeLatest(d);
  if (va.degraded || pv.degraded) {
    const parts = [];
    if (va.degraded) parts.push(`量能活跃度（${va.reason || '数据不可用'}）`);
    if (pv.degraded) parts.push(`量价配合度（${pv.reason || '数据不可用'}）`);
    return {
      score: 0, degraded: true, reason: parts.join('；'), value: '', detail: '',
      volRatio: null, volPct: null, volState: null, pvScore: null, pvLabel: null, pvKind: null,
    };
  }
  const score = round((va.score * 15 + pv.score * 10) / 25, 3);
  const value = `${va.value} · ${pv.value}`;
  const detail = `${va.detail}；${pv.detail}。合成得分 =（量能活跃度 ${round(va.score, 2)} × 15 + 量价配合度 ${round(pv.score, 2)} × 10）÷ 25 = ${score}（口径：最新日 · 上证+深证，非5日/3日）`;
  return {
    score, degraded: false, value, detail,
    volRatio: va.ratio != null ? va.ratio : null,
    volPct: va.volPct != null ? va.volPct : null,
    volState: va.state || null,
    pvScore: round(pv.score, 3),
    pvLabel: pv.label || null,
    pvKind: pv.kind || null,
  };
}

/**
 * 20261021f：量价形态 → 风险提示文案（单一来源，可单测）。
 * 三种 `pv.score < 0` 的形态互斥，绝不能用一句固定的「放量下跌或量价齐跌」覆盖：
 * 用户看到「量能状态：平量」的同时被提示「放量下跌」，会直接判定为 bug（2026-10-21 报障）。
 */
const PV_RISK_TEXT = {
  // 20261023o：卡片口径改为「最新日 + 上证+深证」，故窗口统一写「最新日」，不再写近5日/近3日。
  // 每条都写明窗口，避免与当日「量能状态（量比档位）」混淆。
  bothFall: '最新日量价齐跌（价格下行 + 量能萎缩），资金退潮',
  volUpPriceDown: '最新日放量下跌（量能放大而价格下行），恐慌出货',
  priceUpVolDown: '最新日量缩价升（价格上行但量能萎缩），动能不足、警惕诱多',
};
/**
 * @param {{pvScore:number|null, pvKind:string|null, pvLabel:string|null}} vp
 * @returns {string|null} 风险文案；非负分值/无数据 → null（不提示）
 */
function pvRiskText(vp) {
  if (!vp || vp.pvScore == null || !(vp.pvScore < 0)) return null;
  if (vp.pvKind && PV_RISK_TEXT[vp.pvKind]) return PV_RISK_TEXT[vp.pvKind];
  // 形态枚举缺失（旧快照/降级）→ 用形态原文兜底，不臆造方向
  return `量价配合转弱（${vp.pvLabel || '量价形态偏离'}）`;
}

/** 2) 市场宽度与极端情绪（15%） */
function calcBreadthExtreme(d) {
  const b = d.breadth;
  if (!b || !(b.up + b.down > 0)) return { score: 0, degraded: true, reason: '涨跌家数缺失', value: '' };
  const upRatio = b.up / (b.up + b.down);
  const limitDiff = (b.limitUp - b.limitDown) / 100;
  const fewLimitDown = b.limitDown <= 5;
  const manyLimitDown = b.limitDown >= 20;
  // 炸板率（20261015j）：曾涨停但收盘未封住的比例 = 炸板家数 / (涨停 + 炸板家数)，衡量涨停阵营封板质量
  const zr = typeof b.zbgcRate === 'number' ? b.zbgcRate : null;

  let score = 0, note = '';
  if (upRatio > 0.6 && fewLimitDown) { score = 1; note = '健康普涨'; }
  else if (upRatio < 0.4 && manyLimitDown) { score = -1; note = '恐慌普跌'; }
  else if (b.limitUp >= 30 && upRatio < 0.5) { score = 0; note = '涨停不少但下跌家数更多 → 结构性分化，不给方向分'; }
  else { score = 0; note = '涨跌互现，方向不明'; }

  // 炸板率质量修正（20261015j）：仅作用于方向分 >0 的场景——判「健康普涨」时若炸板率过高，
  // 说明涨停阵营封板质量差、抛压重（虚涨停），按质量打折；score≤0（普跌/分化）时炸板率不构成
  // 反向证据，不修正；炸板率缺失时不修正，仅在 detail 如实标注（不伪造、不静默）。
  let zbgcNote = '';
  if (zr != null && score > 0) {
    if (zr >= 0.7) { score = score * 0.5; zbgcNote = `炸板率 ${round(zr * 100, 1)}% ≥ 70% → 涨停严重虚浮，得分打5折`; }
    else if (zr >= 0.5) { score = score * 0.7; zbgcNote = `炸板率 ${round(zr * 100, 1)}% ≥ 50% → 封板质量偏差，得分打7折`; }
    else zbgcNote = `炸板率 ${round(zr * 100, 1)}%，封板质量正常`;
  } else if (zr != null) {
    zbgcNote = `炸板率 ${round(zr * 100, 1)}%（非普涨场景，不参与修正）`;
  } else {
    zbgcNote = '炸板率暂缺（东财炸板股池未取到），本次未参与修正';
  }

  // 结构健康度修正（spec §四.2）
  let structureNote = '';
  const cap = d.capital;
  if (cap && typeof cap.topDecileShare === 'number') {
    if (cap.topDecileShare > 50) {
      score = round(score * 0.7, 3);
      structureNote = `成交额前10%个股贡献 ${cap.topDecileShare}% 总成交 → 结构不健康，得分打7折`;
    } else {
      structureNote = `成交额前10%个股贡献 ${cap.topDecileShare}% 总成交，结构正常`;
    }
  }

  const zbgcTxt = zr != null ? ` · 炸板率 ${round(zr * 100, 1)}%（${b.zbgcCount}/${(b.limitUp || 0) + (b.zbgcCount || 0)}）` : '';
  const value = `涨:跌 = ${b.up}:${b.down}（${round(upRatio * 100, 0)}%）· 涨停 ${b.limitUp} / 跌停 ${b.limitDown}${zbgcTxt}`;
  const detail = `上涨 ${b.up} 家、下跌 ${b.down} 家（涨跌家数比 ${round(upRatio, 3)}）；涨停 ${b.limitUp} 家、跌停 ${b.limitDown} 家（涨跌停差 ${round(limitDiff, 2)}）→ ${note}。${zbgcNote}${structureNote ? '；' + structureNote : ''}`;
  return {
    score: clamp(score, -1, 1), degraded: false, value, detail,
    upRatio: round(upRatio, 3), limitDiff: round(limitDiff, 2),
    zbgcRate: zr,
    zbgcCount: typeof b.zbgcCount === 'number' ? b.zbgcCount : null,
    zbgcBreaks: typeof b.zbgcBreaks === 'number' ? b.zbgcBreaks : null,
  };
}

/** 3) 量价配合度（10%）：最近 5 日价格/量能走势 */
function calcPriceVolume(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 10) return { score: 0, degraded: true, reason: '上证日线不足', value: '' };
  // 20261018：底层指标改引首页量能根（口径与原实现逐行一致）。根函数要求 ≥10 根，
  // 与本函数的降级门限对齐；10~24 根的边界场景与旧实现行为完全相同（根通道固定 320 窗口，
  // 生产中不可达，保留守门以防数据源异常）。
  const m = computeMarketVolumeMetrics(bars);
  if (!m) return { score: 0, degraded: true, reason: '上证日线不足', value: '' };
  const priceUp = m.priceUp5, volUp = m.volUp3;
  const pNow = m.pNow, p5 = m.p5, vRecent = m.vRecent3, vPrev = m.vPrev3;

  // 20261021f：补 kind（形态枚举）。下游（风险提示/量能文案）**必须按实际形态取词**，
  // 不许再拿一句固定联合文案覆盖全部 pv.score<0 的情形——那会把「量价齐跌」「放量下跌」
  // 「量缩价升」三种互斥形态并列，且与当日量能档位（可能只是平量）直接冲突。
  let score = 0, label = '', kind = 'flat';
  if (priceUp && volUp) { score = 1; label = '量价齐升（趋势健康）'; kind = 'bothRise'; }
  else if (!priceUp && !volUp) { score = -1; label = '量价齐跌（资金退潮）'; kind = 'bothFall'; }
  else if (!priceUp && volUp) { score = -1; label = '量升价跌（放量下跌/恐慌出货）'; kind = 'volUpPriceDown'; }
  else if (priceUp && !volUp) { score = -0.5; label = '量缩价升（动能不足，警惕诱多）'; kind = 'priceUpVolDown'; }
  else { score = 0; label = '量价关系中性'; }

  const value = `价格5日 ${round((pNow - p5) / p5 * 100, 2)}% · 量能近3日 vs 前3日 ${round((vRecent / vPrev - 1) * 100, 1)}%`;
  const detail = `${label}：近5日价格${priceUp ? '上行' : '下行'}、量能${volUp ? '放大' : '萎缩'}`;
  return { score, degraded: false, value, detail, label, kind };
}

// ===== 20261023o：最新日量能 / 量价（上证 + 深证），替代 5 日 / 3 日窗口 =====
// 用户要求：卡片所有口径改成最新日数据，并同时分析深市。
// 隔离：原 calcVolumeActivity / calcPriceVolume（5日/3日）保持不变，供大盘技术分析页与
//   test_market_volume_root_migration 等价性守卫；本组新函数只服务首页情绪卡的 calcVolumePrice。
function _latestDayMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 21) return null;
  const m = computeMarketVolumeMetrics(bars);
  if (!m) return null;
  const n = bars.length;
  const vols = bars.map(b => b.vol);
  const close = bars[n - 1].close;
  const prev = bars[n - 2].close;
  const chgPct = prev > 0 ? (close - prev) / prev * 100 : null;
  const avg20 = mean(vols.slice(n - 21, n - 1)); // 不含今日
  if (!(vols[n - 1] > 0) || !(avg20 > 0)) return null; // 0/缺失成交量 → 视为该市不可用
  const ratio = m.ratio != null ? m.ratio : (avg20 > 0 ? vols[n - 1] / avg20 : null);
  const volState = ratio == null ? '未知' : (ratio > 1.2 ? '放量' : (ratio < 0.8 ? '缩量' : '平量'));
  return { close, prev, chgPct, vol: vols[n - 1], avg20, ratio, volPct: m.volPct, volState };
}

function _pvLatestOne(m) {
  if (!m || m.chgPct == null || m.ratio == null) return null;
  const priceUp = m.chgPct > 0;
  const priceDown = m.chgPct < 0;
  const volUp = m.volState === '放量';
  const volDown = m.volState === '缩量';
  let score = 0, label = '', kind = 'flat';
  if (volUp && priceUp) { score = 1; label = '量价齐升（放量上涨）'; kind = 'bothRise'; }
  else if (volUp && priceDown) { score = -1; label = '量升价跌（放量下跌/恐慌出货）'; kind = 'volUpPriceDown'; }
  else if (volDown && priceUp) { score = -0.5; label = '量缩价升（动能不足，警惕诱多）'; kind = 'priceUpVolDown'; }
  else if (volDown && priceDown) { score = -1; label = '量价齐跌（缩量下跌，资金退潮）'; kind = 'bothFall'; }
  else if (priceUp) { score = 0; label = '量平价涨（量能未配合）'; kind = 'flatVolPriceUp'; }
  else if (priceDown) { score = 0; label = '量平价跌（抛压不重）'; kind = 'flatVolPriceDown'; }
  else { score = 0; label = '量价平（横盘）'; kind = 'flat'; }
  return { score, label, kind, chgPct: m.chgPct, ratio: m.ratio, volState: m.volState };
}

function _fmtHands(v) { return v == null ? '—' : (v / 1e8).toFixed(2) + ' 亿手'; }

function calcVolumeActivityLatest(d) {
  const sh = _latestDayMetrics(d.index && d.index.bars);
  const sz = _latestDayMetrics(d.indexSZ && d.indexSZ.bars);
  if (!sh && !sz) return { score: 0, degraded: true, reason: '上证/深证日线不足 21 根', value: '' };
  const ratios = [sh && sh.ratio, sz && sz.ratio].filter(v => typeof v === 'number' && isFinite(v));
  const ratio = ratios.length ? mean(ratios) : null;
  // [20261024b] 阈值对齐项目「量比」铁律（_volumeTier 唯一真值源）：>1.2 放量 / 0.8~1.2 平量 / <0.8 缩量。
  // 旧值 1.5/0.7 导致「量比 1.21（平量）」与项目 1.2 口径自相矛盾（用户 2026-10-24 报障）。
  const state = ratio == null ? '未知' : (ratio > 1.2 ? '放量' : (ratio < 0.8 ? '缩量' : '平量'));
  let score = ratio == null ? 0 : (ratio > 1.2 ? 1 : (ratio < 0.8 ? -1 : 0));
  let note = '';
  if (score === 1) {
    const b = d.breadth;
    const upRatio = b ? b.up / Math.max(1, b.up + b.down) : null;
    if (upRatio != null) {
      if (upRatio < 0.45) { score = -1; note = '放量且普跌 → 恐慌抛售'; }
      else if (upRatio > 0.55) note = '放量且普涨 → 健康上涨';
      else note = '放量但涨跌互现，方向不明';
    }
  }
  const shTxt = sh
    ? `上证 今日 ${_fmtHands(sh.vol)} ÷ 20日均量 ${_fmtHands(sh.avg20)} = ${sh.ratio.toFixed(2)}（${sh.volState}）`
    : '上证 缺失';
  const szTxt = sz
    ? `深证 今日 ${_fmtHands(sz.vol)} ÷ 20日均量 ${_fmtHands(sz.avg20)} = ${sz.ratio.toFixed(2)}（${sz.volState}）`
    : '深证 缺失';
  const value = `${sh ? `上证 ${sh.ratio.toFixed(2)}（${sh.volState}）` : '上证 缺失'} / ${sz ? `深证 ${sz.ratio.toFixed(2)}（${sz.volState}）` : '深证 缺失'} · 综合 ${ratio == null ? '—' : ratio.toFixed(2)}（${state}）`;
  const detail = `今日量能（vs 各自近20日均量）：${shTxt}；${szTxt}${note ? '；' + note : ''}`;
  return { score, ratio, state, value, detail, volPct: sh ? sh.volPct : (sz ? sz.volPct : null), sh, sz };
}

function calcPriceVolumeLatest(d) {
  const sh = _latestDayMetrics(d.index && d.index.bars);
  const sz = _latestDayMetrics(d.indexSZ && d.indexSZ.bars);
  const shPv = _pvLatestOne(sh), szPv = _pvLatestOne(sz);
  if (!shPv && !szPv) return { score: 0, degraded: true, reason: '上证/深证日线不足 21 根', value: '' };
  const scores = [shPv && shPv.score, szPv && szPv.score].filter(v => typeof v === 'number');
  const score = scores.length ? round(mean(scores), 3) : 0;
  const parts = [];
  if (shPv) parts.push(`上证 今日 ${shPv.chgPct >= 0 ? '+' : ''}${round(shPv.chgPct, 2)}%、量比 ${shPv.ratio.toFixed(2)}（${shPv.volState}）→ ${shPv.label}`);
  if (szPv) parts.push(`深证 今日 ${szPv.chgPct >= 0 ? '+' : ''}${round(szPv.chgPct, 2)}%、量比 ${szPv.ratio.toFixed(2)}（${szPv.volState}）→ ${szPv.label}`);
  let label = '', kind = 'flat';
  if (shPv && szPv && shPv.kind === szPv.kind) { label = shPv.label + '（沪深一致）'; kind = shPv.kind; }
  else if (shPv && szPv) { label = '沪深分化'; kind = 'mixed'; }
  else { label = (shPv || szPv).label + '（仅单市）'; kind = (shPv || szPv).kind; }
  const value = parts.join(' ｜ ');
  const detail = `最新日量价（上证 + 深证）：${parts.join('；')}${label ? ` → ${label}` : ''}`;
  return { score, label, kind, value, detail, shPv, szPv };
}

/** 4) 大盘近期涨跌势头（10%）：vs MA5 / MA60 */
function calcIndexMomentum(d) {
  const bars = (d.index && d.index.bars) || [];
  if (bars.length < 61) return { score: 0, degraded: true, reason: '上证日线不足 61 根', value: '' };
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const last = closes[n - 1];
  const ma5 = mean(closes.slice(n - 5));
  const ma60 = mean(closes.slice(n - 60));
  let score = 0;
  const above5 = last > ma5, above60 = last > ma60;
  score += above5 ? 0.5 : -0.5;
  score += above60 ? 0.5 : -0.5;
  score = clamp(score, -1, 1);
  const value = `现价 ${round(last, 1)} · vs MA5 ${above5 ? '上' : '下'} · vs MA60 ${above60 ? '上' : '下'}`;
  const detail = `上证收盘 ${round(last, 1)}，5 日均线 ${round(ma5, 1)}、60 日均线 ${round(ma60, 1)} → 位于 ${[above5 ? 'MA5上方' : 'MA5下方', above60 ? 'MA60上方' : 'MA60下方'].join('、')}`;
  return { score, degraded: false, value, detail, above5, above60 };
}

/**
 * 5) 两融余额（9%）：一张卡内融资 / 融券双栏，各占本卡 50% 权重（[20261109a] 用户指令）
 *
 * 用户口径：融资余额增加 = 杠杆资金加仓 = 短期利好（+1），减少 = 撤离 = 利空（-1）；
 *          融券余额增加 = 做空力量增强 = 短期利空（-1），减少 = 短期利好（+1）。
 * 两个子项沿用同一套判定口径：5 日变动、阈值 ±0.5%（月末/季末 ±0.8%）、±10% 异常闸门。
 * 实测 2026-11-05 前 35 个双边完整日融券 5 日变动 -4.32%~+2.63%，无一日超 ±10%，闸门不会误伤。
 *
 * 「平分权重」不能靠 score=±0.5 后照旧走 dirOf()——dirOf 会把半格压回满格。
 * 本因子返回 subScore:true，净权重与总分改用**原始 score**（0.5 步长，∈[-1,1]），
 * 其它因子仍走 dirOf；因子数仍 8 常驻 + 2 非常驻、权重总和恒 100、margin key 不变。
 */
function calcMargin(d, isMonthEnd) {
  const m = d.margin;
  // 时间周期修正（spec §九）：月末/季末放宽
  const thresh = isMonthEnd ? 0.8 : 0.5;
  const pct = (v) => `${v >= 0 ? '+' : ''}${round(v, 2)}%`;
  if (!m || !(m.latest > 0)) return { score: 0, degraded: true, reason: '融资余额缺失', value: '', subScore: true };

  // ---- 融资子项：判定、阈值、异常闸门、降级条件与旧版完全一致 ----
  const rzChg = typeof m.change5Pct === 'number' ? m.change5Pct
    : (typeof m.changePct === 'number' ? m.changePct : null);
  if (rzChg == null) return { score: 0, degraded: true, reason: '融资余额变化不可用', value: '', subScore: true };
  // 数据异常闸门：真实两融余额 5 日变动不可能超 ±10%（历史极端去杠杆单周亦 <5%）。
  // 超出即判定源数据残缺（如沪深单边缺失致虚假腰斩），按降级处理，不输出方向分（防御，正常不触发）。
  if (Math.abs(rzChg) > 10) {
    return { score: 0, degraded: true, reason: `融资余额5日变动 ${round(rzChg, 1)}% 超 ±10%，疑源数据残缺`, value: '', subScore: true };
  }
  let rzDir = 0, rzLabel = '变化不明显';
  if (rzChg > thresh) { rzDir = 1; rzLabel = '杠杆资金加仓'; }
  else if (rzChg < -thresh) { rzDir = -1; rzLabel = '杠杆资金撤离'; }

  // ---- 融券子项：方向与融资相反（用户 20261109a 口径）----
  const rqChg = typeof m.rqChange5Pct === 'number' ? m.rqChange5Pct : null;
  let rqDir = 0, rqLabel = '变化不明显', rqAbsent = false, rqNote = '';
  if (rqChg == null || !(m.rqLatest > 0)) {
    rqAbsent = true; rqNote = m.rqMissingNote || '融券余额缺失（本子项不计分）';
  } else if (Math.abs(rqChg) > 10) {
    rqAbsent = true; rqNote = `融券余额5日变动 ${round(rqChg, 1)}% 超 ±10%，疑源数据残缺`;
  } else if (rqChg > thresh) { rqDir = -1; rqLabel = '融券余额增加 → 短期利空'; }
  else if (rqChg < -thresh) { rqDir = 1; rqLabel = '融券余额减少 → 短期利好'; }

  // 平分：两子项各占 50%；缺失子项方向记 0，不把半权重让渡给另一子项（诚实留空、不放大单侧）
  const score = round((rzDir + rqDir) / 2, 3);
  const subs = [
    {
      key: 'marginLong', name: '融资余额', weightPct: 50,
      latest: round(m.latest, 0), change5Pct: round(rzChg, 2), dir: rzDir,
      value: `5日 ${pct(rzChg)}`, label: rzLabel,
      tone: rzDir > 0 ? 'bull' : rzDir < 0 ? 'bear' : 'flat',
      note: `余额 ${round(m.latest, 0)} 亿元 · 增加=加杠杆利好 / 减少=去杠杆利空`,
    },
    {
      key: 'marginShort', name: '融券余额', weightPct: 50,
      latest: rqAbsent ? null : round(m.rqLatest, 2), change5Pct: rqAbsent ? null : round(rqChg, 2),
      dir: rqDir, value: rqAbsent ? '—' : `5日 ${pct(rqChg)}`, label: rqLabel,
      tone: rqAbsent ? 'flat' : (rqDir > 0 ? 'bull' : rqDir < 0 ? 'bear' : 'flat'),
      absent: rqAbsent, absentNote: rqNote,
      note: rqAbsent ? rqNote : `余额 ${round(m.rqLatest, 2)} 亿元 · 增加=做空增强利空 / 减少=利好`,
    },
  ];
  const value = `融资 5日 ${pct(rzChg)} · 融券 ${rqAbsent ? '缺失' : '5日 ' + pct(rqChg)}`;
  const partialTxt = m.partialNote ? `（${m.partialNote}）` : '';
  const rqPartialTxt = (!rqAbsent && m.rqPartialNote) ? `；${m.rqPartialNote}` : '';
  // 20261023l：两融是交易所 T+1 例行披露（最新可得=上一交易日），不是抓取失败。
  //   dataDate 标明真实数据日；lagKind='cadence' 让前端区分「例行滞后」与「异常滞后」。
  const dataDate = _prevTdDash(d.date);
  const lagNote = `两融余额为交易所 T+1 例行披露（最新可得 ${dataDate}）`;
  // detail 不写带符号百分比：融券「余额增加(+)」是利空，若走前端 _dirColorize 会把 + 号染红，
  // 与本卡「利空=绿」语义错位。数值与方向色统一由双栏 tone 承担（前端 margin 分支亦跳过 value 行）。
  const detail = `融资 ${round(m.latest, 0)} 亿元 → ${rzLabel}；融券 `
    + (rqAbsent ? '不可用' : `${round(m.rqLatest, 2)} 亿元 → ${rqLabel}`)
    + `。两子项各占本卡 50% 权重：融资增=利好 / 融券增=利空，方向相反；`
    + `阈值 ±${thresh}%${isMonthEnd ? '，月末放宽' : ''}；两融为 T+1 例行披露（最新可得 ${dataDate}），`
    + `组内相对权重压低 20%，绝对值随权重归一同步调整${partialTxt}${rqPartialTxt}`;
  return {
    score, degraded: false, subScore: true, subs, value, detail,
    splitNote: '融资 / 融券各占本卡 50% 权重',
    lagged: true, lagDays: 1, lagKind: 'cadence', dataDate, lagNote,
    change5Pct: round(rzChg, 3),      // topWarning 仍读融资 5 日变动，口径不变
    rqChange5Pct: rqAbsent ? null : round(rqChg, 3),
  };
}

/** 6) 主力资金流向（10%）：净流入 ÷ 5 日均净流入 */
function calcMainCapital(d, snapshots) {
  const mf = d.mainFund;
  if (!mf || mf.mainNetToday == null) return { score: 0, degraded: true, reason: '主力资金缺失（东财数据中心行业/板块资金流报表均未取到有效数据；数据源恢复后每日快照自动回补）', value: '' };
  const today = mf.mainNetToday;
  // [20261024a] 时效校验：主力资金源（东财数据中心报表）只含已收盘交易日，盘中最新通常为 T-1（收盘口径）。
  // 与融资余额 T+1 同范式：lagged 时如实标注口径日，不把 T-1 值冒充「今日」，也不打分时折扣。
  const dataDate = mf.date && /^\d{4}-\d{2}-\d{2}$/.test(mf.date) ? mf.date : d.date;
  const lagged = !!(mf.date && mf.date !== d.date);
  const lagDays = lagged ? Math.round((Date.parse(d.date) - Date.parse(dataDate)) / 86400000) : 0;
  const dayLabel = lagged ? `截至 ${dataDate}` : '今日';
  // 5 日净流入样本：由每日快照累计（仅含已记为当日的干净样本）
  const hist = snapshots.map(s => s.mainNet).filter(v => typeof v === 'number');
  const series = hist.length ? hist.slice(-5) : [];
  const hasToday = snapshots.some(s => s.date === d.date);
  const pool = hasToday ? series : series.concat([today]).slice(-5);
  if (pool.length < 3) {
    const skip = lagged ? `（口径日 ${dataDate}，T-${lagDays} 收盘，非实时当日）` : '';
    return { score: 0, degraded: true, reason: `主力资金 5 日均样本不足（${pool.length}/5，需累计逐日快照）`, value: `${dayLabel}主力净额 ${round(today, 1)} 亿${skip}`, todayNet: today, sampleDays: pool.length, lagged, lagDays, lagKind: 'cadence', dataDate, lagNote: lagged ? `主力资金为收盘口径（最新可得 ${dataDate}）` : null };
  }
  const avg5 = mean(pool) || 0;
  let ratio = null, score = 0, label = '流向平稳';
  if (Math.abs(avg5) > 1e-6) {
    ratio = today / avg5;
    if (ratio > 1.5 && today > 0) { score = 1; label = '主力大幅流入'; }
    else if (ratio > 1.5 && today < 0) { score = -1; label = '主力大幅流出'; }
    else if (today > 0) { score = 0.3; label = '主力小幅流入'; }
    else if (today < 0) { score = -0.3; label = '主力小幅流出'; }
  }
  const lagTail = lagged ? `（口径日 ${dataDate}，T-${lagDays} 收盘，非实时当日）` : '';
  const value = `${dayLabel} ${today >= 0 ? '+' : ''}${round(today, 1)} 亿 · 5日均 ${round(avg5, 1)} 亿`;
  const detail = `市场主力净额（超大单+大单）${dayLabel} ${today >= 0 ? '+' : ''}${round(today, 1)} 亿，5 日平均 ${round(avg5, 1)} 亿${ratio != null ? `，比值 ${round(ratio, 2)}` : ''} → ${label}（5日样本 ${pool.length} 天）${lagTail}`;
  return { score, degraded: false, value, detail, todayNet: today, avg5: round(avg5, 2), ratio: ratio != null ? round(ratio, 2) : null, sampleDays: pool.length, lagged, lagDays, lagKind: 'cadence', dataDate, lagNote: lagged ? `主力资金为收盘口径（最新可得 ${dataDate}）` : null };
}

/** 7) 股吧讨论热度（10%）· 反向指标 */
function calcDiscussionHeat(d, heatHist, modelDate) {
  const heat = d.discussionHeat;
  if (heat == null || typeof heat.marketHeat !== 'number') {
    return { score: 0, degraded: true, reason: '股吧热度缺失', value: '' };
  }
  const bars = (d.index && d.index.bars) || [];
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date).filter(Boolean);
  const idxChg5 = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] * 100 : null;

  // 时效校验（spec §九）：热度必须与当日同源。原先只取数值、不比对日期，
  // 会在 MSI 当天缺 marketHeat 时静默沿用几天前的旧值（实测缺 09-10 / 09-16）。
  const lagDays = tradingLagDays(heat.date, modelDate, barDates);
  const stale = lagDays == null || lagDays >= LAG_DEGRADE_DAYS;

  // 分位样本：只保留真实交易日，滤掉序列里混入的周末/非交易日读数
  const tradeSet = new Set(barDates);
  let hist = (heatHist || []).filter(h => h && typeof h.heat === 'number' && h.date);
  const droppedNonTrading = tradeSet.size ? hist.filter(h => !tradeSet.has(h.date)).length : 0;
  if (tradeSet.size) hist = hist.filter(h => tradeSet.has(h.date));
  const values = hist.map(h => h.heat);
  const pct = values.length >= 10 ? rankPercentile(values, heat.marketHeat) : null;

  let score = 0, label = '';
  const bigRally = idxChg5 != null && idxChg5 > 2;
  const bigDrop = idxChg5 != null && idxChg5 < -2;
  if (stale) {
    label = `热度数据已过期（${heat.date || '日期未知'}），本日不参与打分`;
  } else if (pct != null && pct > 0.9 && bigRally) { score = -1; label = '散户情绪极度亢奋 + 大盘近期大涨 → 警惕见顶'; }
  else if (pct != null && pct < 0.1 && bigDrop) { score = 1; label = '散户无人问津 + 大盘近期大跌 → 可能见底'; }
  else if (pct != null && pct > 0.5 && pct <= 0.9 && idxChg5 != null && idxChg5 > 0 && idxChg5 <= 2) { score = 0.5; label = '情绪温和放大 + 大盘温和上涨 → 情绪正常发酵'; }
  else if (pct == null) { label = `热度历史样本不足（${values.length}/10），暂时中性`; }
  else { label = '情绪处于常态区间'; }

  const pctText = pct != null ? `历史分位 ${round(pct * 100, 0)}%` : `样本不足（${values.length}/10）`;
  const lagText = lagDays == null ? '热度日期未知' : (lagDays > 0 ? `滞后 ${lagDays} 个交易日` : '当日');
  const srcText = heat.detail ? ` · 来源：${heat.detail}` : '';
  const dropText = droppedNonTrading ? ` · 已滤除 ${droppedNonTrading} 个非交易日样本` : '';
  const value = `热度 ${round(heat.marketHeat, 2)} · ${pctText}`;
  const detail = `股吧全市场讨论热度 ${round(heat.marketHeat, 2)}（${pctText}，${lagText}${dropText}）${srcText}，大盘近 5 日 ${idxChg5 != null ? round(idxChg5, 2) + '%' : '—'} → ${label}`;

  return {
    score,
    degraded: stale || pct == null,
    lagged: !stale && lagDays > 0,   // 滞后 1~2 个交易日：按 spec §九 打 8 折
    reason: stale
      ? `股吧热度${lagDays == null ? '日期未知' : `滞后 ${lagDays} 个交易日`}，已按过期数据剔除`
      : (pct == null ? `股吧热度历史样本不足（${values.length}/10）` : null),
    value, detail,
    heat: heat.marketHeat,
    heatDate: heat.date || null,
    heatPct: pct != null ? round(pct, 3) : null,
    lagDays: lagDays == null ? null : lagDays,
    heatSamples: values.length,
  };
}

/** 8) 避险情绪（10%）：USD/CNH + 国债收益率 */
function calcRiskAversion(d) {
  const fx = d.fx, bond = d.bond;
  const fxChg = fx ? (fx.usdcnhChgPct != null ? fx.usdcnhChgPct : fx.usdcnyChgPct) : null;
  const bondChgBp = bond ? bond.chgBp5 : null;
  if (fxChg == null && bondChgBp == null) return { score: 0, degraded: true, reason: '汇率/国债收益率缺失', value: '' };

  let score = 0, label = '中性';
  const cnhUp = fxChg != null ? fxChg : 0;      // USD/CNH 上行 = 人民币贬值
  const yieldDown = bondChgBp != null ? bondChgBp : 0;
  if (cnhUp > 0.15 && yieldDown < -3) { score = -1; label = '人民币快速贬值 + 国债收益率快速下行 → 资金避险'; }
  else if (cnhUp < -0.15 && yieldDown > 3) { score = 1; label = '人民币企稳升值 + 国债收益率上行 → 风险偏好提升'; }
  else if (cnhUp > 0.15) { label = '人民币贬值（避险倾向），国债未配合'; score = -0.3; }
  else if (yieldDown < -3) { label = '国债收益率快速下行（避险倾向）'; score = -0.3; }
  else if (cnhUp < -0.15 || yieldDown > 3) { label = '边际转暖（人民币或收益率向好）'; score = 0.3; }

  const value = `USD/CNH ${fx ? round(fx.usdcnh || fx.usdcny, 4) : '—'}（${cnhUp >= 0 ? '+' : ''}${round(cnhUp, 2)}%）· 10Y国债 ${bond ? round(bond.cn10y, 3) + '%' : '—'}（${bondChgBp != null ? (bondChgBp >= 0 ? '+' : '') + bondChgBp + 'bp' : '—'}）`;
  const detail = `${label}：美元兑离岸人民币 ${cnhUp >= 0 ? '上行（贬值）' : '下行（升值）'} ${round(Math.abs(cnhUp), 2)}%，中国 10 年期国债收益率 5 日变化 ${bondChgBp != null ? bondChgBp + 'bp' : '—'}`;
  return { score, degraded: false, value, detail, fxChg: round(cnhUp, 3), bondChgBp };
}

/** 9) 宽基 ETF 申购赎回（10%）· 增量资金 —— 数据由 server 侧 lib/etfFlow 注入（20261022h 新增）
 *  分子：净申赎额（元）。宽基 ETF 被净申购 = 一篮子成分股被"买走"，是增量资金入市的直接证据；
 *  净赎回 = 一篮子股票被卖回市场。份额是"净"概念，只能给净额，分不出申购总量与赎回总量。
 */
function calcEtfFlow(d) {
  const ef = d.etfFlow;
  if (!ef || typeof ef.score !== 'number') {
    return { score: 0, degraded: true, reason: '宽基 ETF 申赎数据缺失（上交所申赎清单 / 基金份额未取到）', value: '' };
  }
  if (ef.degraded) {
    // 20261026a：降级也透传 etfDate——否则卡片「数据日期」回退到模型基准日，
    // 出现「标注今日、数据是上一披露日」的日期错标（用户 2026-10-26 截图报障）。
    return { score: 0, degraded: true, reason: ef.reason || '宽基 ETF 申赎数据不可用', value: ef.value || '', etfDate: ef.date || null };
  }
  // 数据日早于模型基准日（如周末/假期取到的是上一交易日清单）→ 按滞后打 8 折，不静默当当日值
  // 20261023k：ef.date 是紧凑格式 20261022，d.date 是 2026-10-23，直接字符串比较会误判（'-' < '1'），
  // 必须先归一到 YYYY-MM-DD 再比。
  const efDateDash = /^\d{8}$/.test(String(ef.date || ''))
    ? `${String(ef.date).slice(0, 4)}-${String(ef.date).slice(4, 6)}-${String(ef.date).slice(6)}`
    : String(ef.date || '');
  const lagged = !!(efDateDash && d.date && efDateDash < d.date);
  return {
    score: clamp(ef.score, -1, 1),
    degraded: false,
    lagged,
    lagDays: lagged ? 1 : null,   // 20261023k：份额固定滞后 1 个交易日（T-1 披露）
    lagKind: lagged ? 'cadence' : null, // 20261023l：例行披露（非抓取失败），前端用中性说明
    // 20261023m：PCF（申购赎回清单）是 T 日盘前 8:30 披露（上交所细则第三十条），
    //   T+1 的是「基金份额」，两者不是同一个东西；这里明确区分，避免误导。
    lagNote: lagged ? `基金份额为 T+1 披露（最新可得 ${efDateDash}）；申购赎回清单 PCF 为 T 日盘前 8:30 发布、不含实际申赎量` : null,
    value: ef.value,
    detail: ef.detail,
    totalNet: ef.totalNet,
    etfDate: ef.date || null,
    settleStatus: ef.settleStatus || null,
  };
}

/** 9/10) 宏观因子（非常驻）：由 lib/macroSentimentFactors 提供 */
function calcMacro(f) {
  // 20260922k：必须同时尊重 macroSentimentFactors 的 status —— 该因子「走势相悖 → 权重自动归 0（dormant）」
  // 的承诺只有在休眠态真正被识别为「未激活」时才会兑现；否则会回落到基准权重 5%，
  // 出现「卡片写着自动归 0、却仍显示占 5%」的自相矛盾。
  if (!f || typeof f.signal !== 'number' || f.status === 'dormant') {
    return {
      score: 0, active: false, value: f && f.status === 'dormant' ? '休眠（已归零）' : '未激活',
      detail: (f && f.interpretation) || '该宏观因子当前处于休眠状态（无同类事件触发）',
    };
  }
  const s = clamp(f.signal, -1, 1);
  return {
    score: round(s, 3),
    active: true,
    value: s > 0.05 ? '偏多' : s < -0.05 ? '偏空' : '中性',
    detail: f.interpretation || f.detail || '',
  };
}

// ================= 权重与自学习 =================
/**
 * 有界等比缩放：把一组权重缩放到总和 = target，同时把每一项夹紧在 [min,max]。
 * 超出边界的"溢出量"按比例转嫁给仍处于自由区间的项，因此不会出现
 * "先夹紧再归一 → 又被拉回越界" 的老问题（spec §七 权重硬约束）。
 */
function scaleBounded(vals, target, min, max) {
  const n = vals.length;
  if (!n) return [];
  // 因子太少导致区间装不下 target 时（大面积数据缺失），平移边界使其可行：
  // 仍保持总和 = target，只是被迫越过 5%~30% 的软边界（由调用方记入 dataNote）
  let lo = min, hi = max;
  if (target < n * min) lo = target / n;
  else if (target > n * max) hi = target / n;
  const sum = vals.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  const x = vals.map(v => (v > 0 ? v : 0) / sum * target);
  for (let it = 0; it < 80; it++) {
    let fixed = 0;
    const free = [];
    for (let i = 0; i < n; i++) {
      if (x[i] <= lo + 1e-9) { x[i] = lo; fixed += lo; }
      else if (x[i] >= hi - 1e-9) { x[i] = hi; fixed += hi; }
      else free.push(i);
    }
    if (!free.length) break;
    const targetFree = target - fixed;
    const freeSum = free.reduce((a, i) => a + x[i], 0);
    if (freeSum <= 0) {
      const eq = targetFree / free.length;
      for (const i of free) x[i] = eq;
      continue;
    }
    const scale = targetFree / freeSum;
    let moved = 0;
    for (const i of free) { const nv = x[i] * scale; moved += Math.abs(nv - x[i]); x[i] = nv; }
    if (moved < 1e-9) break;
  }
  return x;
}

function computeWeights(state, activeNonResident) {
  // 基准权重；非常驻休眠→其权重按比例分摊给常驻（spec §三.3 / §七）
  const w = { ...BASE_WEIGHTS };
  const stateW = state.weights || {};
  // 自学习后的常驻权重（若有），否则用基准
  for (const k of Object.keys(BASE_WEIGHTS)) {
    if (!NON_RESIDENT.includes(k) && typeof stateW[k] === 'number') w[k] = stateW[k];
  }
  const residentKeys = Object.keys(BASE_WEIGHTS).filter(k => !NON_RESIDENT.includes(k));

  // 非常驻：激活时用其（衰减后）权重，否则为 0
  let nonSum = 0;
  for (const k of NON_RESIDENT) {
    if (activeNonResident[k]) {
      const ev = (state.events || {})[k];
      // 只有事件确实处于 active 且权重为正时才沿用，否则回落到基准权重。
      // 否则上一次休眠留下的 { status:'dormant', weight:0 } 会把刚激活的因子压成 0。
      const iw = (ev && ev.status === 'active' && typeof ev.weight === 'number' && ev.weight > 0)
        ? ev.weight : BASE_WEIGHTS[k];
      w[k] = iw; nonSum += iw;
    } else {
      w[k] = 0;
    }
  }
  // 常驻权重：等比缩放至 (100 - 非常驻)，并对每项夹紧 [W_MIN, W_MAX]（spec §七）
  const targetResident = Math.max(0, 100 - nonSum);
  const scaled = scaleBounded(residentKeys.map(k => w[k]), targetResident, W_MIN, W_MAX);
  residentKeys.forEach((k, i) => { w[k] = round(scaled[i], 2); });

  // 修正舍入误差：补给仍有余量的常驻因子，避免把某一项顶出边界
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const diff = round(100 - total, 2);
  if (Math.abs(diff) > 0.001) {
    const cand = residentKeys.find(k => w[k] + diff >= W_MIN - 1e-9 && w[k] + diff <= W_MAX + 1e-9) || residentKeys[0];
    w[cand] = round(w[cand] + diff, 2);
  }
  return w;
}

/** 自学习：按最近 30 次因子命中率调整常驻权重（spec §六）。
 *  20261027c（用户质询「样本>20 为何自学习不启动，是不是死逻辑」）：
 *  实证 learnLog 为空 ≠ 样本不足——indexMomentum/margin 已学满顶到 30% 上限（rate>60% 但 clamp 后无变化）。
 *  新增 learnDetail 逐因子诊断（样本数/近窗命中率/当前权重/状态），供前端诚实展示；
 *  调整行为与原逻辑完全一致（同门槛/同窗口/同步长/同 clamp）。 */
function learnWeights(state) {
  const acc = state.factorAcc || {};
  const residentKeys = Object.keys(BASE_WEIGHTS).filter(k => !NON_RESIDENT.includes(k));
  const learnLog = [];
  const learnDetail = [];
  for (const k of residentKeys) {
    const a = acc[k];
    const n = (a && Array.isArray(a.samples)) ? a.samples.length : 0;
    const recent = (a && Array.isArray(a.samples)) ? a.samples.slice(-LEARN_WINDOW) : [];
    const t = recent.length, c = recent.filter(Boolean).length;
    const rate = t ? c / t : null;
    const cur = (state.weights && typeof state.weights[k] === 'number') ? state.weights[k] : BASE_WEIGHTS[k];
    let status;
    if (!a || n < LEARN_MIN_SAMPLE || !t) {
      status = 'insufficient';   // 样本不足（门槛按因子各自计，中性因子不累积）
    } else {
      let nxt = cur;
      if (rate > UP_THRESHOLD) nxt = cur * (1 + UP_STEP);
      else if (rate < DOWN_THRESHOLD) nxt = cur * (1 - DOWN_STEP);
      nxt = clamp(nxt, W_MIN, W_MAX);
      if (Math.abs(nxt - cur) > 0.01) {
        state.weights[k] = round(nxt, 2);
        learnLog.push({ key: k, name: FACTOR_NAMES[k], rate: round(rate, 3), from: round(cur, 2), to: round(nxt, 2), n: t });
        status = 'adjusted';
      } else if (rate > UP_THRESHOLD && cur >= W_MAX - 1e-9) status = 'cap_up';     // 命中率高但已顶 30% 上限
      else if (rate < DOWN_THRESHOLD && cur <= W_MIN + 1e-9) status = 'cap_down';   // 命中率低但已踩 5% 下限
      else status = 'deadzone';                                                      // 45%~60% 死区，按规则不动
    }
    learnDetail.push({
      key: k, name: FACTOR_NAMES[k],
      n, total: a ? (a.total || n) : 0,
      rate: rate == null ? null : round(rate, 3),
      weight: cur, status,
    });
  }
  return { learnLog, learnDetail };
}

/** 记录今日各因子方向，供 T+1 结算时统计因子命中率 */
function recordFactorDirections(rec, factors) {
  rec.factorDirs = {};
  for (const f of factors) {
    if (f.type === 'nonResident') continue;
    rec.factorDirs[f.key] = Math.sign(f.score) || 0;
  }
}

// ================= 主流程 =================
/**
 * 计算大盘量能情绪状态。
 * @param {object} opts { data: getMarketEmotionData() 返回值, macroFactors:[], discussionHeat, refresh }
 */
async function computeMarketEmotion(opts = {}) {
  const d = opts.data || {};
  const today = d.date || localDate();
  const state = loadState();
  const snapshots = loadSnapshots();
  const now = new Date();

  // ---- 是否月末/季末（spec §九 时间周期修正）----
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const isMonthEnd = now.getDate() >= lastDayOfMonth - 2;
  const isQuarterEnd = isMonthEnd && [2, 5, 8, 11].includes(now.getMonth());

  // ---- 极端行情熔断（spec §八.6）----
  const bars = (d.index && d.index.bars) || [];
  const closes = bars.map(b => b.close);
  const idxChgPct = closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100 : 0;
  const b = d.breadth || {};
  const circuit = (b.limitDown >= 1000) || (b.limitUp >= 1000) || (Math.abs(idxChgPct) >= 5);

  // ---- 8 个常驻因子 ----
  const factors = [];

  const vp = calcVolumePrice(d);
  factors.push({ key: 'volumePrice', type: 'resident', ...vp });

  const be = calcBreadthExtreme(d);
  factors.push({ key: 'breadthExtreme', type: 'resident', ...be });

  const im = calcIndexMomentum(d);
  factors.push({ key: 'indexMomentum', type: 'resident', ...im });

  const mg = calcMargin(d, isMonthEnd);
  factors.push({ key: 'margin', type: 'resident', ...mg });

  const mc = calcMainCapital(d, snapshots);
  factors.push({ key: 'mainCapital', type: 'resident', ...mc });

  const heatHist = mergeHeatHistory(snapshots);
  const dh = calcDiscussionHeat(d, heatHist, today);
  factors.push({ key: 'discussionHeat', type: 'resident', ...dh });

  const ra = calcRiskAversion(d);
  factors.push({ key: 'riskAversion', type: 'resident', ...ra });

  const ef = calcEtfFlow(d);
  factors.push({ key: 'etfFlow', type: 'resident', ...ef });

  // ---- 顶部出货特殊警示（spec §四.6）----
  let topWarning = null;
  const heatHigh = dh.heatPct != null && dh.heatPct > 0.9;
  const marginSurge = mg.change5Pct != null && mg.change5Pct > 1.5;
  const mainOut = typeof mc.todayNet === 'number' && mc.todayNet < -200;
  if (heatHigh && marginSurge && mainOut) {
    topWarning = '经典顶部出货信号：散户狂热（股吧热度 >90% 分位）+ 融资余额暴增 + 主力资金大幅净流出';
    const f = factors.find(x => x.key === 'mainCapital');
    if (f) f.score = clamp(f.score - 0.5, -1, 1);
  }

  // ---- 2 个非常驻因子 ----
  const macroList = Array.isArray(opts.macroFactors) ? opts.macroFactors : [];
  const domF = macroList.find(f => f.key === 'DOMESTIC_MACRO');
  const usF = macroList.find(f => f.key === 'US_MACRO');
  const domC = calcMacro(domF);
  factors.push({ key: 'domesticMacro', type: 'nonResident', ...domC });
  const usC = calcMacro(usF);
  factors.push({ key: 'usMacro', type: 'nonResident', ...usC });

  const activeNonResident = { domesticMacro: !!domC.active, usMacro: !!usC.active };

  // ---- 权重 ----
  const weights = computeWeights(state, activeNonResident);

  // ---- 数据自检：降级因子（数据源异常/样本不足）→ 权重归零并"有界"分摊（spec §七 / §八.4 / §九）----
  // 注意：分摊必须同时守住 5%~30% 硬边界，否则常驻因子的权重会被"越分越大"冲破上限。
  const degradedKeys = factors.filter(f => f.degraded).map(f => f.key);
  const resKeys = factors.filter(f => f.type !== 'nonResident').map(f => f.key);
  const nonKeys = factors.filter(f => f.type === 'nonResident').map(f => f.key);

  // 1) 先算降级归零 / 滞后打 8 折之后的原始权重
  const rawW = {};
  for (const f of factors) {
    f.name = FACTOR_NAMES[f.key];
    let wv = weights[f.key] || 0;
    if (f.degraded) wv = 0;
    else if (f.lagged) wv = wv * 0.8;   // 数据滞后打 8 折（spec §九）
    rawW[f.key] = wv;
  }
  // 2) 非常驻保持事件权重（可低于 5%），常驻则"有界"缩放到剩余空间
  const nonTarget = round(nonKeys.reduce((a, k) => a + rawW[k], 0), 2);
  const resUsable = resKeys.filter(k => !degradedKeys.includes(k));
  const resTarget = Math.max(0, 100 - nonTarget);
  const resBounded = scaleBounded(resUsable.map(k => rawW[k]), resTarget, W_MIN, W_MAX);
  resUsable.forEach((k, i) => { rawW[k] = resBounded[i]; });
  // 3) 记录是否有因子被"因子数不足"被迫越界（诚实标注，不静默）
  let weightRelaxed = false;
  for (const k of resUsable) {
    if (rawW[k] > W_MAX + 0.01 || rawW[k] < W_MIN - 0.01) weightRelaxed = true;
  }
  for (const f of factors) f.weight = f.degraded ? 0 : round(rawW[f.key] || 0, 2);
  // 20261025n：每因子下发「净权重=评分」——方向满格 ×（已含降级归零/滞后 8 折的）权重
  // [20261109a] 唯一例外：两融余额因子 subScore=true，融资/融券平分本卡权重，
  //   score 是 0.5 步长的方向强度（±1 / ±0.5 / 0），必须用原始 score；
  //   若照旧走 dirOf 会把半格压回满格，等于凭空给单侧子项多算一倍权重。
  //   其余 9 个因子判定、数值、权重零改动。
  const dirWeight = (f) => (f.subScore ? (f.score || 0) : dirOf(f.score || 0));
  for (const f of factors) f.contribution = round(dirWeight(f) * (f.weight || 0), 2);
  // 4) 总和对齐到 100%（补差给仍有余量的常驻因子，避免顶出边界）
  // 20261016 审计修复：权重均为两位小数，N 个因子舍入后总和与 100 的差必为 0.01 的整数倍，
  // 最大残差 = N×0.005（9 因子=0.045）。旧阈值 0.02 会把 0.02~0.045 区间的残差永久留下
  // （权重和 99.98）；改为 0.005 = 「凡有残差即补齐」，找不到不越界的候选因子时才保留（诚实暴露）。
  const wSum = factors.reduce((a, f) => a + (f.weight || 0), 0);
  const gap = round(100 - wSum, 2);
  if (Math.abs(gap) > 0.005) {
    const cand = resUsable
      .map(k => factors.find(f => f.key === k))
      .find(f => f && f.weight + gap >= W_MIN - 0.01 && f.weight + gap <= W_MAX + 0.01);
    if (cand) cand.weight = round(cand.weight + gap, 2);
  }

  // ---- 总分（20261025n：权重=评分，对齐个股短期判断模块）----
  // 旧口径 Σ(score×权重) 把强度折扣混进总分；新口径每因子按满格方向 ±1 计入，
  // 总分 = Σ(方向 × 权重%) = 各因子净权重之和，因子评分 = ±权重。
  let score10 = 0;
  // [20261109a] dirWeight 与 contribution 同源：两融双栏按半格计入总分，其它因子仍按满格方向
  for (const f of factors) score10 += dirWeight(f) * (f.weight / 100);
  const totalScore = round(clamp(score10, -1, 1), 3);

  // ---- 短期倾向 ----
  let tendency = '中性', tendencyKey = 'neutral';
  if (totalScore >= 0.2) { tendency = '看涨'; tendencyKey = 'bull'; }
  else if (totalScore <= -0.2) { tendency = '看跌'; tendencyKey = 'bear'; }

  // ---- 核心驱动（20261025n：按净权重贡献绝对值排序）----
  const ranked = factors.slice().sort((a, x) => Math.abs(x.contribution || 0) - Math.abs(a.contribution || 0));
  const driver = ranked[0];
  const driverText = driver ? `${driver.name}（净权重 ${driver.contribution > 0 ? '+' : ''}${round(driver.contribution, 2)} 分 / 权重 ${round(driver.weight, 2)}%）` : '—';

  // ---- 量能状态 ----
  // 20261021f：量能状态（当日量比档位）与量价形态（最新日价格 × 最新日量能，上证+深证双市）是**两个口径**，
  // 旧文案把后者压成「配合/背离」两态，会把「量价齐跌」也叫成"背离"。现在直接给形态原文。
  const pvPart = vp.pvLabel
    ? vp.pvLabel
    : (vp.pvScore == null ? '' : (vp.pvScore > 0 ? '量价配合' : vp.pvScore < 0 ? '量价背离' : '量价中性'));
  const volumeText = `${vp.volState || '—'}${vp.volRatio != null ? `（量比 ${round(vp.volRatio, 2)}）` : ''}${pvPart ? '；' + pvPart : ''}`;

  // ---- 操作建议（仓位）----
  let posRange;
  if (totalScore >= 0.5) posRange = '7~8 成';
  else if (totalScore >= 0.25) posRange = '6 成';
  else if (totalScore >= 0) posRange = '5 成';
  else if (totalScore >= -0.25) posRange = '4 成';
  else if (totalScore >= -0.5) posRange = '3 成';
  else posRange = '1~2 成';
  const stance = totalScore >= 0.25 ? '可适度积极' : totalScore <= -0.25 ? '应以谨慎防守为主' : '维持中性、不追高不杀跌';
  let advice = `${stance}，建议仓位 ${posRange}`;

  // ---- 风险提示（只放市场风险，数据缺口另列 dataNote）----
  const risks = [];
  // 20261021f（用户报障）：旧文案是「量价背离（放量下跌或量价齐跌）」——把三种互斥形态并列，
  // 且当日量能可能只是「平量」，同屏就会出现「量能状态：平量」+「放量下跌」的自相矛盾。
  // 20261023o：现在按 pvKind 取**当前实际形态**（最新日 + 上证深证双市），窗口统一写「最新日」。文案见 PV_RISK_TEXT。
  const pvRisk = pvRiskText(vp);
  if (pvRisk) risks.push(pvRisk);
  if (be.score < 0) risks.push('市场宽度转弱（普跌且跌停增多）');
  if (be.zbgcRate != null && be.zbgcRate >= 0.7) risks.push(`涨停封板质量极差（炸板率 ${round(be.zbgcRate * 100, 1)}%），追高风险大`);
  if (be.detail && /结构不健康/.test(be.detail)) risks.push('成交结构不健康（成交额高度集中于前10%个股）');
  if (topWarning) risks.push(topWarning);
  if (dh.score < 0) risks.push('散户情绪过热，存在见顶风险');
  if (vp.volPct != null && vp.volPct > VOL_PCTL_HIGH) risks.push('量能处于历史高位，警惕过热');
  const divergence = ranked.find(f => (f.key === 'breadthExtreme' || f.key === 'mainCapital' || f.key === 'discussionHeat') && Math.sign(f.score) !== Math.sign(totalScore) && Math.abs(f.score) > 0.3);
  if (divergence) risks.unshift(`最大背离：${divergence.name}（得分 ${round(divergence.score, 2)}）与整体倾向不一致`);
  const riskText = risks.length ? risks.slice(0, 3).join('；') : '暂无明显背离或异常风险点';

  // ---- 数据缺口说明（spec §八.4：缺失因子权重已归零并按比例分摊）----
  const noteParts = [];
  if (degradedKeys.length) {
    noteParts.push(`以下因子因数据源异常/样本不足，已按规则将权重临时归零并分摊给其他因子：` +
      factors.filter(f => f.degraded).map(f => `${f.name}（${f.reason || '数据不可用'}）`).join('、'));
  }
  if (weightRelaxed) {
    noteParts.push('可用因子数量不足，个别因子权重被迫越过 5%~30% 常规区间以保证权重合计 100%，本日结论置信度偏低。');
  }
  const dataNote = noteParts.join(' ');

  // ---- 熔断输出（spec §八.6）----
  if (circuit) {
    advice = '当前市场处于极端状态，模型置信度低，建议观望，等待数据恢复正常。';
  }

  // ---- 学习与准确率 ----
  let records = loadRecords();
  // 结算历史记录（T+1/T+3/T+5）
  const settleResult = settleRecords(records, closes, bars);
  records = settleResult.records;

  // 记录今日预测
  const existing = records.find(r => r.date === today);
  const rec = existing || { date: today, createdAt: new Date().toISOString() };
  rec.score = totalScore;
  rec.tendency = tendency;
  rec.indexClose = closes.length ? round(closes[closes.length - 1], 2) : null;
  rec.indexChgPct = round(idxChgPct, 2);
  rec.baselineDate = bars.length ? bars[bars.length - 1].date : today;
  rec.volumeState = vp.volState || null;
  rec.pvLabel = vp.pvLabel || null;   // 20261021f：供个股页「市场情绪提醒」子因子直接引用形态原文
  rec.pvKind = vp.pvKind || null;
  rec.topWarning = topWarning;
  // 20260917i：补存结论文字字段，供个股页「大盘」卡片的「市场情绪提醒」子因子直接引用
  // （个股页只读本文件落盘的当日判断、不重算 —— 规则一·指标级单源）。
  rec.tendencyKey = tendencyKey;
  rec.coreDriver = driverText;
  rec.advice = advice;
  rec.riskTip = riskText;
  recordFactorDirections(rec, factors);
  if (!existing) records.push(rec);
  saveRecords(records);

  // 因子准确率台账（用 T+1 结算结果回填）
  applyFactorAccuracy(state, settleResult.settledToday);

  // 权重自学习
  const { learnLog, learnDetail } = learnWeights(state);
  // 非常驻衰减
  decayEvents(state, today, activeNonResident);

  saveState(state);

  // 快照（供 5 日均值 / 热度历史分位）
  upsertSnapshot(snapshots, {
    date: today,
    // 20261024a：主力资金若来自收盘口径（T-1，lagged），不得挂到今日日期写入快照，
    // 否则会污染后续 5 日均与分位样本（与热度 lagDays===0 才记入的护栏同范式）。仅 T-0 当日值写入。
    mainNet: mc.lagged ? null : (typeof mc.todayNet === 'number' ? mc.todayNet : (d.mainFund ? d.mainFund.mainNetToday : null)),
    // 只在热度与当日同源（lagDays === 0）时记入快照；陈旧/缺失一律记 null。
    // 否则会把上一天的旧热度挂到今天的日期上，污染后续的分位历史样本。
    heat: (typeof dh.heat === 'number' && dh.lagDays === 0) ? dh.heat : null,
    volRatio: vp.volRatio != null ? vp.volRatio : null,
    totalAmount: d.capital ? d.capital.totalAmount : null,
    indexClose: closes.length ? round(closes[closes.length - 1], 2) : null,
    score: totalScore,
  });
  saveSnapshots(snapshots);

  // 月度健康报告（spec §八.5）
  const health = maybeMonthlyHealth(state, records, today);

  return {
    model: 'volume-emotion-v2',
    success: true,
    date: today,
    baselineDate: rec.baselineDate,

    // ---- §十 最终输出（简洁直接）----
    totalScore,
    tendency,
    tendencyKey,
    coreDriver: driverText,
    volumeState: volumeText,
    advice,
    riskTip: riskText,
    dataNote,

    // ---- 明细 ----
    factors: factors.map(f => ({
      key: f.key, name: f.name, type: f.type,
      score: round(f.score, 3), weight: f.weight,
      // 20261025n：净权重=评分（方向满格 × 权重），前端直接展示 ±X%
      contribution: f.contribution === undefined ? 0 : f.contribution,
      value: f.value || '', detail: f.detail || '',
      degraded: !!f.degraded, reason: f.reason || null, lagged: !!f.lagged,
      // 股吧热度的时效与样本可追溯性（供卡片展示与回归测试断言）
      lagDays: f.lagDays === undefined ? null : f.lagDays,
      heatDate: f.heatDate || null,
      // 20261023k：宽基 ETF 的份额披露日（T-1）与定稿状态——原 map 未透出 etfDate，
      // 导致卡片「数据日期」只能回退到模型基准日（标注 10-23、实际数据 10-22）。
      etfDate: f.etfDate || null,
      dataDate: f.dataDate || null,
      lagKind: f.lagKind || null,
      lagNote: f.lagNote || null,
      settleStatus: f.settleStatus || null,
      totalNet: f.totalNet === undefined ? null : f.totalNet,
      heatPct: f.heatPct === undefined ? null : f.heatPct,
      heatSamples: f.heatSamples === undefined ? null : f.heatSamples,
      // 炸板率（20261015j）：统计展示 + 封板质量修正的可追溯字段
      zbgcRate: f.zbgcRate === undefined ? null : f.zbgcRate,
      zbgcCount: f.zbgcCount === undefined ? null : f.zbgcCount,
      zbgcBreaks: f.zbgcBreaks === undefined ? null : f.zbgcBreaks,
      // 量能活跃与量价配合（20261015k 合并因子）的可追溯字段
      volRatio: f.volRatio === undefined ? null : f.volRatio,
      volPct: f.volPct === undefined ? null : f.volPct,
      volState: f.volState === undefined ? null : f.volState,
      pvScore: f.pvScore === undefined ? null : f.pvScore,
      // 20261021f：量价形态原文与枚举（风险提示按形态取词，前端可追溯）
      pvLabel: f.pvLabel === undefined ? null : f.pvLabel,
      pvKind: f.pvKind === undefined ? null : f.pvKind,
      // [20261109a] 两融余额双栏：此处是 factors 的**输出白名单**，漏透出 subs 会让前端
      //   isDual 判否、双栏根本不渲染（曾在端到端渲染探针中实测暴露）。subScore 一并发前端，
      //   供下游/守卫识别「本卡按 0.5 步长方向强度计分」；其余因子这些字段恒为 false/null。
      subScore: !!f.subScore,
      subs: Array.isArray(f.subs) ? f.subs : null,
      splitNote: f.splitNote || null,
    })),
    degradedKeys,
    weights,
    learnLog,
    learnDetail,   // 20261027c：逐因子自学习诊断（样本/命中率/权重/状态），前端诚实展示用
    topWarning,
    circuit,
    context: {
      indexChgPct: round(idxChgPct, 2),
      isMonthEnd, isQuarterEnd,
      breadthUp: b.up || null, breadthDown: b.down || null,
      limitUp: b.limitUp || null, limitDown: b.limitDown || null,
    },
    health,
    accuracy: computeAccuracy(records),
    issues: d.issues || [],
    warnings: d.warnings || [],
    sampleNote: `共 10 个因子（8 常驻 + 2 非常驻）；本日 ${degradedKeys.length ? `有 ${degradedKeys.length} 个因子因数据不足/异常按规则归零并分摊权重` : '全部因子数据齐备'}。`,
    source: '东方财富（大盘资金流：push2 实时主链，不可达时自动切换数据中心行业资金流求和备链，两口径同为超大单+大单；炸板率：炸板股池）、同花顺（成交额/换手率/集中度）、乐咕乐股（涨跌家数/涨跌停）、腾讯（上证量价）、新浪（人民币汇率）、中美国债收益率；主力=超大单+大单。',
    _weightsSnapshot: weights,
  };
}

function upsertSnapshot(arr, snap) {
  const i = arr.findIndex(s => s.date === snap.date);
  if (i >= 0) arr[i] = { ...arr[i], ...snap };
  else arr.push(snap);
  arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (arr.length > 400) arr.splice(0, arr.length - 400);
}

/** T+1/T+3/T+5 结算 + 因子方向命中回填 */
function settleRecords(records, closes, bars) {
  const dateToIdx = {};
  (bars || []).forEach((b, i) => { dateToIdx[b.date] = i; });
  const settledToday = [];
  for (const r of records) {
    if (r.settledT5) continue;
    const bi = dateToIdx[r.baselineDate];
    if (bi == null) continue;
    const base = bars[bi].close;
    const check = (n, field, flagField) => {
      const ti = bi + n;
      if (r[flagField]) return;
      if (ti >= bars.length) return;
      const chg = (bars[ti].close - base) / base * 100;
      const dir = Math.abs(chg) <= FLAT_TOL ? 'flat' : (chg > 0 ? 'up' : 'down');
      r[field] = { targetDate: bars[ti].date, chgPct: round(chg, 2), dir };
      r[flagField] = true;
      if (n === 1) {
        // 判定方向命中
        const pred = r.tendency === '看涨' ? 'up' : r.tendency === '看跌' ? 'down' : 'flat';
        r.correctT1 = (r.tendency === '中性') ? (dir === 'flat') : (pred === dir);
        settledToday.push({ record: r, actualDir: dir });
      }
    };
    check(1, 'resultT1', 'settledT1');
    check(3, 'resultT3', 'settledT3');
    check(5, 'resultT5', 'settledT5');
    if (r.settledT1 && !r.settledT3 && bi + 3 >= bars.length) { /* 尚未到 */ }
  }
  return { records, settledToday };
}

function applyFactorAccuracy(state, settledToday) {
  if (!state.factorAcc) state.factorAcc = {};
  for (const { record, actualDir } of settledToday) {
    if (!record.factorDirs) continue;
    const actualUp = actualDir === 'up';
    for (const [key, dir] of Object.entries(record.factorDirs)) {
      if (dir === 0) continue; // 中性因子不参与命中统计
      if (!state.factorAcc[key]) state.factorAcc[key] = { samples: [], total: 0, correct: 0 };
      const ok = (dir > 0) === actualUp;
      state.factorAcc[key].samples.push(ok);
      state.factorAcc[key].total++;
      if (ok) state.factorAcc[key].correct++;
      if (state.factorAcc[key].samples.length > 200) state.factorAcc[key].samples.shift();
    }
  }
}

/** 非常驻因子衰减（spec §五） */
function decayEvents(state, today, active) {
  if (!state.events) state.events = {};
  for (const k of NON_RESIDENT) {
    const ev = state.events[k] || { status: 'dormant', weight: 0, lastTrigger: null };
    if (active[k]) {
      if (ev.status !== 'active') { ev.status = 'active'; ev.weight = BASE_WEIGHTS[k]; }
      ev.lastTrigger = ev.lastTrigger || today;
    } else if (ev.status === 'active') {
      // 未激活则按日衰减（每次运行衰减一次，按日期去重）
      if (ev.lastDecay !== today) {
        ev.lastDecay = today;
        ev.weight = round((ev.weight || BASE_WEIGHTS[k]) * DECAY_PER_DAY, 2);
        if (ev.weight < DECAY_FLOOR) { ev.weight = 0; ev.status = 'dormant'; }
      }
    }
    state.events[k] = ev;
  }
}

/** 准确率统计 */
function computeAccuracy(records) {
  const settled = records.filter(r => r.settledT1);
  const correct = settled.filter(r => r.correctT1).length;
  const byDir = { up: { t: 0, c: 0 }, down: { t: 0, c: 0 }, flat: { t: 0, c: 0 } };
  for (const r of settled) {
    const key = r.tendency === '看涨' ? 'up' : r.tendency === '看跌' ? 'down' : 'flat';
    byDir[key].t++; if (r.correctT1) byDir[key].c++;
  }
  const rate = p => (p.t ? round(p.c / p.t * 100, 1) : null);
  return {
    totalRecords: records.length,
    settledCount: settled.length,
    accuracy: settled.length ? round(correct / settled.length * 100, 1) : null,
    bullRate: rate(byDir.up), bullTotal: byDir.up.t,
    bearRate: rate(byDir.down), bearTotal: byDir.down.t,
    flatRate: rate(byDir.flat), flatTotal: byDir.flat.t,
    horizonLabel: 'T+1 / T+3 / T+5',
    source: '大盘量能情绪模型（短期倾向 vs 上证指数实际涨跌，容差 ±0.5%）',
  };
}

/** 月度健康报告（spec §八.5）：每月最后一个自然日生成 */
function maybeMonthlyHealth(state, records, today) {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() !== lastDay) {
    // 非月末：返回既有报告摘要
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev = readJson(path.join(HEALTH_DIR, key + '.json'), null);
    return prev ? { month: key, generatedAt: prev.generatedAt, report: prev.report } : null;
  }
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthRecs = records.filter(r => r.settledT1 && (r.date || '').slice(0, 7) === key);
  const factorStats = {};
  const acc = state.factorAcc || {};
  const failures = [];
  for (const [k, a] of Object.entries(acc)) {
    const recent = (a.samples || []).slice(-30);
    if (!recent.length) continue;
    const rate = recent.filter(Boolean).length / recent.length;
    factorStats[k] = { name: FACTOR_NAMES[k] || k, rate: round(rate, 3), n: recent.length };
    const tail = (a.samples || []).slice(-10);
    if (tail.length === 10 && tail.filter(x => !x).length >= 6) {
      failures.push(`${FACTOR_NAMES[k] || k}：最近 10 次准确率低于 40%`);
      // 连续 10 次 <40% → 权重压到底线
      if (!NON_RESIDENT.includes(k)) state.weights[k] = W_MIN;
    }
  }
  const report = {
    month: key,
    settledCount: monthRecs.length,
    accuracy: monthRecs.length ? round(monthRecs.filter(r => r.correctT1).length / monthRecs.length * 100, 1) : null,
    factorStats,
    failedFactors: failures,
  };
  ensureHealthDir();
  writeJson(path.join(HEALTH_DIR, key + '.json'), { month: key, generatedAt: new Date().toISOString(), report });
  return { month: key, generatedAt: new Date().toISOString(), report };
}

/**
 * 读「最近一条」每日情绪判断（20260917i 新增）。
 * 供个股页「大盘」卡片的「市场情绪提醒」子因子直接引用首页判断，
 * 避免个股页重算导致与首页双源不一致（规则一·指标级单源）。
 * @returns {object|null} { date, score, tendency, tendencyKey, coreDriver, volumeState, advice, riskTip, baselineDate, indexChgPct }
 *   无记录或记录异常时返回 null（调用方按中性处理）。
 */
function readLatestJudgment() {
  let a = [];
  try { a = loadRecords(); } catch (e) { return null; }
  if (!Array.isArray(a) || !a.length) return null;
  const rec = a[a.length - 1];
  if (!rec || typeof rec.score !== 'number') return null;
  return {
    date: rec.date || null,
    score: rec.score,
    tendency: rec.tendency || '震荡',
    tendencyKey: rec.tendencyKey || null,
    coreDriver: rec.coreDriver || '',
    volumeState: rec.volumeState || '',
    advice: rec.advice || '',
    riskTip: rec.riskTip || '',
    baselineDate: rec.baselineDate || null,
    indexChgPct: rec.indexChgPct != null ? rec.indexChgPct : null,
  };
}

module.exports = {
  computeMarketEmotion,
  readLatestJudgment,
  BASE_WEIGHTS, FACTOR_NAMES, NON_RESIDENT, W_MIN, W_MAX,
  percentile, rankPercentile, trimExtremes,
  calcMacro, // 20260922k：导出以支持「休眠态必须归零」单测
  calcMargin, // [20261109a] 导出以支持「融资/融券双栏平分权重」纯函数分支单测
  // 20261021f：导出以支持「量能档位与量价文案必须自洽」单测
  calcVolumeActivity, calcPriceVolume, calcVolumePrice, calcVolumeActivityLatest, calcPriceVolumeLatest, pvRiskText, PV_RISK_TEXT,
  DIR,
};

~~~

---

## `lib\marketLogDb.js`  ·  319 行

~~~js
/**
 * lib/marketLogDb.js — 大盘记录数据库（20261103i）
 * ==========================================================
 * 用户指令（2026-11-03）：「把大盘记录做成一个简单的数据库，添加相应的检索功能，
 * 能够按日期、行业和涨跌等关键词进行搜索。」
 *
 * 大盘记录 = data/notes.json 中 scope='market' 的条目（AI 每日复盘自动写入 + 用户手写）。
 * 本模块把它们**派生**成一份结构化 SQLite 库（data/market-log.db，Node 22 内置 node:sqlite
 * 零额外依赖），提供按 日期 / 行业 / 涨跌 / 关键词 的检索。
 *
 * 设计口径：
 *   1. **派生库**：notes.json 仍是唯一权威源；本库是它的结构化镜像，可随时全量重建（幂等）。
 *      同步时机 = 检索请求时检测 notes.json mtime 变化 → 重建（记录量级为百条内，全量重建 <10ms）。
 *   2. **代码权威**：日期/指数涨跌幅/方向/行业候选全部由本机正则解析，不用 LLM；解析不到的
 *      字段如实置 null/空数组（诚实缺失），绝不臆造。
 *   3. **行业检索是关键词匹配**：AI 文案自由度高（"电机涨5.18%居首""银行受净息差压制"），
 *      行业名解析只取「分句开头 + 紧跟涨/跌」的高置信候选（供展示 chips 与检索建议）；
 *      检索本身对 sectors JSON + content 全文 LIKE，解析不完美不影响命中。
 *   4. **方向（涨/跌）**：按沪指（沪指/上证指数）当日涨跌幅符号判定，红涨绿跌语义由前端着色；
 *      解析不到 → direction=null（中性·未知，不硬猜）。
 *   5. 隔离：不改动 lib/db.js 与既有 notes 链路；库文件独立，测试可用环境变量重定向。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const NOTES_FILE = process.env.SA_NOTES_FILE
  ? path.resolve(process.env.SA_NOTES_FILE)
  : path.join(__dirname, '..', 'data', 'notes.json');
const DB_FILE = process.env.SA_MARKET_LOG_DB
  ? path.resolve(process.env.SA_MARKET_LOG_DB)
  : path.join(__dirname, '..', 'data', 'market-log.db');

let db = null;
let _lastSyncMtimeMs = null;

function nowIso() { return new Date().toISOString(); }

/** 本地时区 YYYY-MM-DD（手写条目没有交易日标记，用笔记时间兜底） */
function localDateOf(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 解析（纯函数） ----------

/** 从一段文本里提取「指数名 + 涨跌幅」对（如 沪指 +0.89%、创业板指 4.16%） */
function parseIndices(text) {
  const out = [];
  const re = /([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)\s*([+-]?\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const name = m[1].replace(/^[，。、；：,.;:()\[\]（）\s]+/, '');
    const pct = Number(m[2]);
    if (name && Number.isFinite(pct)) out.push({ name, changePct: Math.round(pct * 100) / 100 });
  }
  return out;
}

/**
 * 从「领涨/领跌板块」段提取行业名候选（高置信口径，20261103i）：
 * ① 按逗号/句号/分号切大句，大句必须含 涨/跌 动词（无动词的叙述句直接跳过，噪声控制）；
 * ② 大句内按顿号切分：a) 段内「前缀紧跟涨/跌」→ 取前缀（「电机涨5.18%」→ 电机）；
 *    b) 顿号链共享动词的无动词段（「软件开发、自动化设备涨近5%」的「软件开发」）→
 *       段为 2~8 字纯中文时取整段；
 * ③ 前缀尾部剥离复数/频度副词（「银行双双跌」→ 银行）与数字字母尾（「宇树科技20涨停」→ 宇树科技）。
 * 例：「电机涨5.18%居首，软件开发、自动化设备涨近5%」→ [电机, 软件开发, 自动化设备]。
 */
const SECTOR_TAIL_ADVERBS = ['双双', '纷纷', '同步', '集体', '携手', '合计', '共同', '连续', '再度', '继续'];
function parseSectors(text) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  };
  const big = String(text || '').split(/[，,；;。\n]+/);
  for (const b of big) {
    if (!/[涨跌]/.test(b)) continue;   // 大句无涨跌动词 → 跳过（叙述句，不提行业候选）
    const parts = b.split('、');
    for (const seg of parts) {
      const s = seg.trim();
      if (!s) continue;
      const m = s.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)(?=涨|跌)/);
      if (m) {
        let name = m[1].replace(/[0-9A-Za-z]+$/, '').trim();   // 剥数字/字母尾
        let changed = true;
        while (changed) {
          changed = false;
          for (const adv of SECTOR_TAIL_ADVERBS) {
            if (name.length > adv.length && name.endsWith(adv)) { name = name.slice(0, -adv.length); changed = true; }
          }
        }
        push(name);
      } else if (parts.length > 1) {
        // 顿号链中无动词的段：整段为 2~8 字纯中文才作行业候选（长度/字符集双重噪声门槛）
        const m2 = s.match(/^([\u4e00-\u9fa5]{2,8})$/);
        if (m2) push(m2[1]);
      }
    }
  }
  return out;
}

/** 在指数列表里找主指数（沪指/上证指数）涨跌幅；找不到在【大盘】段兜底找「沪指涨/跌 x%」 */
function extractMarketPct(indices, wholeText) {
  const pri = indices.find(i => /^(沪指|上证指数|上证综指|沪)$/.test(i.name))
    || indices.find(i => /沪指|上证/.test(i.name));
  if (pri) return pri.changePct;
  const m = String(wholeText || '').match(/沪指(?:上涨|涨|下跌|跌)\s*([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) return Math.round(Number(m[1]) * 100) / 100;
  return null;
}

/**
 * 把一条 scope=market 笔记解析为结构化记录（纯函数）。
 * AI 复盘条目：交易日从 title「AI 大盘复盘 · YYYY-MM-DD」提取，段落标记解析；
 * 手写条目：无标记段落 → 结构字段如实置空，tradeDate 用笔记时间，全文参与关键词检索。
 */
function parseMarketNote(note) {
  const content = String((note && note.content) || '');
  const title = String((note && note.title) || '');
  const seg = (label) => {
    const m = content.match(new RegExp('【' + label + '】([^\\n]*)'));
    return m ? m[1].trim() : '';
  };
  const idxText = seg('指数收盘');
  const indices = idxText ? parseIndices(idxText) : [];
  const upText = seg('领涨板块');
  const downText = seg('领跌板块');
  const sectorsUp = upText ? parseSectors(upText) : [];
  const sectorsDown = downText ? parseSectors(downText) : [];
  const marketPct = extractMarketPct(indices, content);
  let direction = null;
  if (marketPct != null) direction = marketPct > 0 ? 'up' : marketPct < 0 ? 'down' : 'flat';
  const tm = title.match(/(\d{4}-\d{2}-\d{2})/);
  const tradeDate = tm ? tm[1] : localDateOf(note && note.date);
  const isAi = (note && note.ai === true) || (note && note.type === 'ai');
  return {
    noteId: String((note && note.id) || ''),
    tradeDate: tradeDate || null,
    direction,
    marketPct,
    indices,
    sectorsUp,
    sectorsDown,
    title,
    content,
    tags: Array.isArray(note && note.tags) ? note.tags.map(String) : [],
    source: isAi ? 'ai' : 'manual',
    createdAt: (note && note.date) || null,
    updatedAt: (note && note.updatedAt) || (note && note.date) || null,
  };
}

// ---------- SQLite（派生库） ----------

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS market_log (
    note_id TEXT PRIMARY KEY,
    trade_date TEXT,
    direction TEXT,
    market_pct REAL,
    indices TEXT,
    sectors_up TEXT,
    sectors_down TEXT,
    title TEXT,
    content TEXT,
    tags TEXT,
    source TEXT,
    created_at TEXT,
    updated_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mlog_date ON market_log(trade_date);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mlog_dir ON market_log(direction);');
  return db;
}

function readMarketNotes() {
  try {
    const arr = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return (Array.isArray(arr) ? arr : []).filter(n => n && n.scope === 'market');
  } catch (e) {
    return [];
  }
}

/**
 * 全量重建派生库（幂等）：notes.json 是权威源，库内多删少补。
 * @returns {{synced:number, rebuilt:boolean}}
 */
function syncMarketLog() {
  const notes = readMarketNotes();
  const records = notes.map(parseMarketNote).filter(r => r.noteId);
  const d = getDb();
  const tx = d.prepare('BEGIN');
  try {
    tx.run();
    d.prepare('DELETE FROM market_log').run();
    const ins = d.prepare(
      `INSERT INTO market_log (note_id, trade_date, direction, market_pct, indices, sectors_up, sectors_down, title, content, tags, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of records) {
      ins.run(
        r.noteId, r.tradeDate, r.direction, r.marketPct,
        JSON.stringify(r.indices), JSON.stringify(r.sectorsUp), JSON.stringify(r.sectorsDown),
        r.title, r.content, JSON.stringify(r.tags), r.source, r.createdAt, r.updatedAt
      );
    }
    d.prepare('COMMIT').run();
  } catch (e) {
    try { d.prepare('ROLLBACK').run(); } catch (e2) {}
    throw e;
  }
  try { _lastSyncMtimeMs = fs.statSync(NOTES_FILE).mtimeMs; } catch (e) { _lastSyncMtimeMs = null; }
  return { synced: records.length, rebuilt: true };
}

/** notes.json 变了才重建（mtime 检测；首次必建） */
function ensureSynced() {
  let mtime = null;
  try { mtime = fs.statSync(NOTES_FILE).mtimeMs; } catch (e) {}
  if (_lastSyncMtimeMs == null || mtime !== _lastSyncMtimeMs) return syncMarketLog();
  return { synced: count(), rebuilt: false };
}

function rowToRecord(r) {
  return {
    noteId: r.note_id,
    tradeDate: r.trade_date,
    direction: r.direction,
    marketPct: r.market_pct == null ? null : Number(r.market_pct),
    indices: JSON.parse(r.indices || '[]'),
    sectorsUp: JSON.parse(r.sectors_up || '[]'),
    sectorsDown: JSON.parse(r.sectors_down || '[]'),
    title: r.title,
    content: r.content,
    tags: JSON.parse(r.tags || '[]'),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 检索（全部条件 AND，可任意组合；一律先 ensureSynced）。
 * @param {object} p
 *   q        关键词（title/content/tags LIKE）
 *   sector   行业（sectors_up/sectors_down/indices/content LIKE —— 关键词匹配，非精确字段）
 *   direction 'up' | 'down' | 'flat'
 *   from/to  交易日范围（YYYY-MM-DD，闭区间）
 *   index    指数名（indices LIKE，如「创业板指」）
 *   limit    返回条数上限（默认 200）
 * @returns {{total:number, records:Array, facets:{sectors:Array}}}
 */
function searchMarketLog(p) {
  ensureSynced();
  const cond = [];
  const args = [];
  const q = String((p && p.q) || '').trim();
  if (q) { cond.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sector = String((p && p.sector) || '').trim();
  if (sector) { cond.push('(sectors_up LIKE ? OR sectors_down LIKE ? OR content LIKE ?)'); args.push(`%${sector}%`, `%${sector}%`, `%${sector}%`); }
  const direction = String((p && p.direction) || '').trim();
  if (direction === 'up' || direction === 'down' || direction === 'flat') { cond.push('direction = ?'); args.push(direction); }
  const from = String((p && p.from) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { cond.push('trade_date >= ?'); args.push(from); }
  const to = String((p && p.to) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { cond.push('trade_date <= ?'); args.push(to); }
  const indexName = String((p && p.index) || '').trim();
  if (indexName) { cond.push('indices LIKE ?'); args.push(`%${indexName}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM market_log ${where}`).get(...args).n;
  const limit = Math.min(Math.max(Number(p && p.limit) || 200, 1), 1000);
  const rows = d.prepare(
    `SELECT * FROM market_log ${where} ORDER BY trade_date DESC, created_at DESC LIMIT ?`
  ).all(...args, limit);
  // facets：全库行业候选 top 20（供前端检索建议 datalist）
  const facetRows = d.prepare(`SELECT sectors_up, sectors_down FROM market_log`).all();
  const counter = new Map();
  for (const fr of facetRows) {
    for (const s of JSON.parse(fr.sectors_up || '[]')) counter.set(s, (counter.get(s) || 0) + 1);
    for (const s of JSON.parse(fr.sectors_down || '[]')) counter.set(s, (counter.get(s) || 0) + 1);
  }
  const facets = { sectors: Array.from(counter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })) };
  return { total, records: rows.map(rowToRecord), facets };
}

function count() {
  try { return getDb().prepare('SELECT COUNT(*) AS n FROM market_log').get().n; } catch (e) { return 0; }
}

/** 库概况（前端统计行）：条数 + 日期范围 */
function getStats() {
  ensureSynced();
  const d = getDb();
  const r = d.prepare('SELECT COUNT(*) AS n, MIN(trade_date) AS minD, MAX(trade_date) AS maxD FROM market_log').get();
  return { total: r.n, fromDate: r.minD || null, toDate: r.maxD || null, dbFile: DB_FILE };
}

/** 测试/重置辅助：关闭连接 */
function close() { try { if (db) { db.close(); db = null; _lastSyncMtimeMs = null; } } catch (e) { db = null; } }

module.exports = {
  parseMarketNote, parseIndices, parseSectors, extractMarketPct,
  syncMarketLog, ensureSynced, searchMarketLog, getStats, count, close,
  NOTES_FILE, DB_FILE,
};

~~~

---

## `lib\marketRank.js`  ·  200 行

~~~js
/**
 * 首页「基金重仓行业配置矩阵」
 * --------------------------------------------------------------
 * 数据说明：
 *   公募基金主动权益基金重仓股的申万一级行业配置比例（重仓股口径），
 *   按季度末（9/30、12/31、3/31、6/30）展示各行业占比。
 *
 * 数据源现状：
 *   东方财富 datacenter-web 所有基金/机构行业配置聚合报表（RPT_FUND_*_INDUSTRY 等）
 *   经大量探针实测均返回「报表配置不存在」，免费公开结构化接口未覆盖该聚合数据。
 *   因此后端先保留真实探测逻辑（getRealtimeMatrix），失败时回退到本地缓存文件；
 *   本地缓存文件初始用用户提供的截图示例值填充，并明确标注为「示例数据/来源待确认」。
 *   用户可通过 POST /api/market-rank 导入自己的 CSV/JSON 数据替换示例值。
 *
 * 数据使用原则：
 *   - 不编造数据：所有展示百分比必须能追溯到真实来源或用户导入。
 *   - 来源必标注：卡片头部、表格下方均展示 source 与 updatedAt。
 *   - 投资有风险：本模块仅展示机构持仓结构，不构成投资建议。
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DC_HOST = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MATRIX_FILE = path.join(DATA_DIR, 'sector-matrix.json');

// 示例数据：来自用户截图，作为初始占位；source 标记为待确认
const SEED_MATRIX = {
  title: '主动权益基金重仓行业配置比例（重仓股口径）',
  source: '用户提供截图（示例数据，来源待确认）',
  sourceUrl: '',
  reportDate: '截至 2026-06-30',
  updatedAt: new Date().toISOString(),
  available: true,
  isSample: true,
  quarters: ['2025/9/30', '2025/12/31', '2026/3/31', '2026/6/30'],
  sectors: [
    { name: '电子', values: [25.60, 23.76, 21.68, 43.31] },
    { name: '通信', values: [9.29, 11.14, 13.06, 16.91] },
    { name: '电力设备', values: [12.33, 11.51, 12.30, 7.35] },
    { name: '机械设备', values: [4.08, 4.77, 4.98, 6.13] },
    { name: '医药生物', values: [9.68, 8.07, 8.50, 5.49] },
    { name: '有色金属', values: [5.90, 8.06, 6.95, 3.59] },
    { name: '基础化工', values: [2.41, 3.19, 4.40, 2.23] },
    { name: '汽车', values: [4.89, 5.08, 4.14, 1.94] },
    { name: '建筑材料', values: [0.61, 0.72, 0.91, 1.78] },
    { name: '国防军工', values: [3.00, 2.63, 2.51, 1.54] },
    { name: '其他合计', values: [22.21, 21.06, 20.07, 9.74] }
  ]
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLocalMatrix() {
  ensureDataDir();
  if (!fs.existsSync(MATRIX_FILE)) {
    fs.writeFileSync(MATRIX_FILE, JSON.stringify(SEED_MATRIX, null, 2), 'utf8');
    return SEED_MATRIX;
  }
  try {
    const raw = fs.readFileSync(MATRIX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sectors) || !Array.isArray(parsed.quarters)) {
      throw new Error('本地矩阵文件格式异常');
    }
    return parsed;
  } catch (e) {
    console.error('readLocalMatrix error:', e.message);
    return SEED_MATRIX;
  }
}

function writeLocalMatrix(data) {
  ensureDataDir();
  const payload = {
    ...data,
    updatedAt: new Date().toISOString(),
    isSample: false
  };
  fs.writeFileSync(MATRIX_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

// 尝试从东方财富数据中心获取聚合行业配置（当前未覆盖，保留探测能力）
async function getRealtimeMatrix() {
  const reportNames = [
    'RPT_FUND_HOLD_INDUSTRY',
    'RPT_FUND_INDUSTRY_ALLOCATION',
    'RPT_FUND_INDUSTRY_DISTRIBUTION',
    'RPT_FUND_POSITION_INDUSTRY',
    'RPT_FUND_SECTOR_ALLOCATION',
    'RPT_PUBLIC_FUND_INDUSTRY',
    'RPT_FUND_HEAVY_INDUSTRY'
  ];
  for (const name of reportNames) {
    const url = `${DC_HOST}?reportName=${encodeURIComponent(name)}&columns=ALL&pageSize=20&pageNumber=1&source=WEB&client=WEB`;
    try {
      const r = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' }, timeout: 8000 });
      const data = r.data;
      if (data && data.result && Array.isArray(data.result.data) && data.result.data.length > 0) {
        console.log('marketRank realtime hit:', name);
        return { hit: true, reportName: name, raw: data.result.data };
      }
    } catch (e) {
      // 继续试下一个
    }
  }
  return { hit: false };
}

function getMatrix(force = false) {
  const local = readLocalMatrix();
  // 若要求刷新且本地是示例数据，尝试实时源；即使失败也返回本地数据
  if (force) {
    getRealtimeMatrix().then(res => {
      if (res.hit) {
        // 未来若接口恢复，可在此解析 raw 并写入本地文件
        console.log('Real-time matrix source available:', res.reportName);
      }
    }).catch(() => {});
  }
  return local;
}

// 后端归一化校验：把各种导入格式转成统一结构
function normalizeMatrix(input) {
  if (!input) throw new Error('导入内容为空');

  let payload;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      payload = JSON.parse(trimmed);
    } else {
      // CSV 解析：首行是季度，第一列是行业名
      const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const header = lines[0].split(',').map(s => s.trim());
      const quarters = header.slice(1);
      const sectors = lines.slice(1).map(line => {
        const cells = line.split(',').map(s => s.trim());
        const values = cells.slice(1).map(v => {
          const n = parseFloat(v.replace(/%/g, ''));
          return isNaN(n) ? 0 : n;
        });
        return { name: cells[0], values };
      });
      payload = { quarters, sectors };
    }
  } else {
    payload = input;
  }

  if (!Array.isArray(payload.quarters) || payload.quarters.length < 2) {
    throw new Error('季度列至少需要 2 列');
  }
  if (!Array.isArray(payload.sectors) || payload.sectors.length < 1) {
    throw new Error('行业行至少需要 1 行');
  }
  for (const s of payload.sectors) {
    if (!s.name || !Array.isArray(s.values)) {
      throw new Error('每条行业记录必须包含 name 和 values 数组');
    }
    if (s.values.length !== payload.quarters.length) {
      throw new Error(`行业「${s.name}」的数值列数与季度列数不一致`);
    }
  }

  return {
    title: payload.title || SEED_MATRIX.title,
    source: payload.source || '用户导入',
    sourceUrl: payload.sourceUrl || '',
    reportDate: payload.reportDate || `截至 ${payload.quarters[payload.quarters.length - 1]}`,
    available: true,
    isSample: false,
    quarters: payload.quarters,
    sectors: payload.sectors
  };
}

module.exports = {
  getMarketRank: async ({ force = false } = {}) => {
    const data = getMatrix(force);
    return {
      ...data,
      updated: data.updatedAt || new Date().toISOString(),
      note: '本矩阵展示主动权益基金重仓股的申万一级行业配置比例。当前免费公开接口未覆盖该聚合数据，默认填充用户截图示例值；可通过「导入数据」替换为 Wind/Choice/iFinD 等真实数据。'
    };
  },
  updateMarketRank: (input) => {
    const normalized = normalizeMatrix(input);
    return writeLocalMatrix(normalized);
  },
  // 暴露供测试/调试
  _MATRIX_FILE: MATRIX_FILE
};

~~~

---

## `lib\marketSentimentIndex.js`  ·  319 行

~~~js
/**
 * 全市场情绪指数（Market Sentiment Index, MSI）
 * --------------------------------------------------------------
 * 目标：为「市场情绪拐点识别」模块提供单一、可追溯的全市场情绪度量。
 *
 * 设计原则：
 *   1) 只聚合【市场级】信号，绝不混入个股级情感（如个股新闻/个股股吧得分），
 *      否则就不是"全市场"情绪，而是某只股票的影子。
 *   2) 每个分量都归一化到 [-1, 1]，按权重融合；任一分量失败则从融合中剔除并重新归一化权重，
 *      严守"同源、数值一致"的红线——前端展示的分量值与后端计算值完全一致。
 *   3) 每次计算都会落一盘后快照到 data/sentiment-index/series.json，
 *      形成时间序列，供拐点检测器做 z-score / 动量 / 背离分析（天然训练集）。
 *
 * 分量（权重，合计 1.0）：
 *   - 涨跌停比 breadth      0.176 （东财涨跌停池，恐惧/贪婪代理）
 *   - 融资余额 margin       0.128 （杠杆资金日环比，资金面贪婪/恐慌）
 *   - 股吧市场热度 marketHeat 0.112（东财股吧全市场综合得分 + 上升家数占比）
 *   - 全网舆情 globalSent   0.128 （cn-financial-scraper 60+ 源聚合）
 *   - 大盘动量 indexMom     0.160 （上证指数 位置/近期收益，价格维度 · 真实历史）
 *   - 涨跌广度 advDecline   0.096 （大盘指数平均涨跌 + 板块涨跌家数分布）
 *   - 国内宏观数据情绪因子 domesticMacro 0.10（非常驻 · 自学习；由 sentimentTurningPoint 通过 opts.macroComponents 注入，休眠时剔除并重新归一化）
 *   - 美国宏观事件情绪因子 usMacro     0.10（非常驻 · 自学习；同上）
 *
 * 回填策略（关键）：真实快照不足时，过去交易日用【真实】上证动量/广度分量重建，
 * 静态分量（涨跌停比/融资余额/热度/舆情）用最新快照近似，使序列产生真实波动，
 * z-score 才能识别极值。重建点标记 approx:true，真实点优先且覆盖。
 *
 * 复用现有数据层：sentiment(getMarketSentiment) / cnscraperAdapter(getGlobalSentiment) /
 *                stockData(getHistory / getMarketOverview)。
 */

const fs = require('fs');
const path = require('path');

const { getMarketSentiment } = require('./sentiment');
const { getGlobalSentiment } = require('./cnscraperAdapter');
const { getHistory, getMarketOverview } = require('./stockData');
const { clamp } = require('./ruleCore');
// 只取别名：本文件自己声明了 function localDate（委托用），避免重名冲突
const { localDate: _localDate } = require('./localDate');

const INDEX_DIR = path.join(__dirname, '..', 'data', 'sentiment-index');
const SERIES_FILE = path.join(INDEX_DIR, 'series.json');

const DEFAULT_SYMBOL = '601318';
const DEFAULT_NAME = '中国平安';

const WEIGHTS = {
  breadth: 0.176,
  margin: 0.128,
  marketHeat: 0.112,
  globalSent: 0.128,
  indexMom: 0.160,
  advDecline: 0.096,
  domesticMacro: 0.10,   // 国内宏观数据情绪因子（非常驻 · 自学习，由 sentimentTurningPoint 注入）
  usMacro: 0.10,         // 美国宏观事件情绪因子（非常驻 · 自学习，由 sentimentTurningPoint 注入）
};

function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
// 统一委托给 lib/localDate.js（北京时区；UTC+8 下逐点等价）
function localDate(d = new Date()) { return _localDate(d); }
function ensureDir() { if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true }); }

function readSeries() {
  try {
    if (!fs.existsSync(SERIES_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeSeries(arr) {
  ensureDir();
  try { fs.writeFileSync(SERIES_FILE, JSON.stringify(arr, null, 2)); } catch (e) {}
}

function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) { if (a.length < 2) return 0; const m = _mean(a); return Math.sqrt(_mean(a.map(x => (x - m) * (x - m)))); }

// ---- 融合：输入 [{key, signal, ...}]（仅含可用分量），按 WEIGHTS 归一化返回 {index, components} ----
function blendComponents(present) {
  const avail = present.filter(c => typeof c.signal === 'number');
  const wsum = avail.reduce((a, c) => a + (WEIGHTS[c.key] || 0), 0) || 1;
  let s = 0;
  for (const c of avail) s += (WEIGHTS[c.key] || 0) * c.signal;
  s = clamp(s / wsum, -1, 1);
  const components = present.map(c => ({ ...c, weight: round((WEIGHTS[c.key] || 0) / wsum) }));
  return { index: round(s), components };
}

// ---- 大盘动量分量（真实历史，来自上证指数 K 线，按位置 i 计算）----
function _indexMomentumAt(closes, i) {
  if (!Array.isArray(closes) || closes.length < 25 || i < 24) {
    return { ok: false, signal: 0, detail: '上证历史不足，动量分量缺失' };
  }
  const last = closes[i];
  const ma = (n) => { const s = closes.slice(Math.max(0, i - n + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; };
  const ma20 = ma(20), ma60 = ma(60);
  const posDev = (last - ma60) / ma60 / 0.03;
  const ret5 = (last - closes[i - 5]) / closes[i - 5] / 0.03;
  const signal = clamp(0.6 * clamp(posDev, -1, 1) + 0.4 * clamp(ret5, -1, 1), -1, 1);
  const dir = signal > 0.05 ? '偏强' : signal < -0.05 ? '偏弱' : '中性';
  const realDev = (last - ma60) / ma60 * 100;
  const realRet5 = (last - closes[i - 5]) / closes[i - 5] * 100;
  return { ok: true, signal: round(signal), detail: `大盘相对近60天平均 ${round(realDev)}%、最近5天 ${round(realRet5)}% → 近期走势${dir}` };
}

// ---- 涨跌广度分量（用上证当日涨跌 + 板块/个股涨跌家数分布）----
// stockCounts: { up, down, flat, source, approx }，优先用同花顺行业板块个股家数合计；
// 缺失时退化为 sectorSignal（板块涨跌数量）。
function _advDeclineAt(shRet, sectorSignal, stockCounts) {
  const idxSignal = clamp((shRet || 0) / 1.5, -1, 1);
  let signal;
  let value = '';
  let detail = '';
  if (stockCounts && typeof stockCounts.up === 'number' && typeof stockCounts.down === 'number') {
    const up = stockCounts.up, down = stockCounts.down, flat = stockCounts.flat || 0;
    const total = up + down + flat || 1;
    const stockSignal = clamp((up - down) / total / 0.6, -1, 1);
    signal = clamp(0.5 * idxSignal + 0.5 * stockSignal, -1, 1);
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    value = `上涨 ${up} 家 / 下跌 ${down} 家` + (flat ? ` / 平盘 ${flat} 家` : '');
    detail = `全市场约 ${total} 只个股，上涨 ${up} 家、下跌 ${down} 家${flat ? `、平盘 ${flat} 家` : ''} → 多数股票${dir}` + (stockCounts.approx ? `（${stockCounts.source || '估算'}）` : `（${stockCounts.source || '同花顺·行业板块个股合计'}）`);
  } else if (typeof sectorSignal === 'number') {
    signal = clamp(0.6 * idxSignal + 0.4 * clamp(sectorSignal, -1, 1), -1, 1);
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    detail = `大盘今天 ${round(shRet || 0, 2)}% → 多数股票${dir}`;
  } else {
    signal = idxSignal;
    const dir = signal > 0.05 ? '普涨' : signal < -0.05 ? '普跌' : '分化';
    detail = `大盘今天 ${round(shRet || 0, 2)}% → 多数股票${dir}`;
  }
  return { ok: true, signal: round(signal), value, detail };
}

/**
 * 计算当前全市场情绪指数（实时聚合，不落盘）。
 */
async function computeIndex(opts = {}) {
  const symbol = opts.symbol || DEFAULT_SYMBOL;
  const name = opts.name || DEFAULT_NAME;

  const [sentRes, shRes, moRes] = await Promise.allSettled([
    getMarketSentiment(symbol, name),
    getHistory('sh000001', '6m'),
    getMarketOverview(),
  ]);
  const sent = sentRes.status === 'fulfilled' ? sentRes.value : null;
  const shHist = shRes.status === 'fulfilled' ? shRes.value : [];
  const mo = moRes.status === 'fulfilled' ? moRes.value : null;

  const gs = await getGlobalSentiment('A股,沪深,大盘', { days: 2, maxArticles: 12, budget: 10 })
    .catch(() => ({ ok: false, count: 0 }));

  const present = [];

  if (sent && sent.breadth && sent.breadth.ok) {
    const b = sent.breadth;
    present.push({ key: 'breadth', label: '涨停 vs 跌停家数', signal: clamp(b.signal, -1, 1),
      value: `涨停 ${b.limitUp} 家 / 跌停 ${b.limitDown} 家`,
      detail: `今天全市场涨停 ${b.limitUp} 家、跌停 ${b.limitDown} 家（两者差距越大，说明市场越一边倒）` });
  }
  if (sent && sent.margin && sent.margin.ok) {
    const m = sent.margin;
    present.push({ key: 'margin', label: '融资余额（杠杆资金）', signal: clamp(m.signal, -1, 1),
      value: `${m.changePct >= 0 ? '+' : ''}${round(m.changePct, 2)}%`,
      detail: `融资余额（借钱炒股的资金）最新 ${round(m.latest, 0)} 亿，比上次 ${m.changePct >= 0 ? '+' : ''}${round(m.changePct, 2)}%（增加说明杠杆资金更敢买）` });
  }
  // 股吧讨论热度（市场级）：valid=false 或 marketHeat 缺失时自动剔除并重新归一化权重（C 方案：时效/覆盖标注 + 缺失剔除）
  if (sent && sent.marketSentiment && sent.marketSentiment.ok && sent.marketSentiment.valid !== false && typeof sent.marketSentiment.marketHeat === 'number') {
    const mc = sent.marketSentiment;
    let detail = `股吧全市场讨论综合得分 ${mc.marketAvgScore}、看多的人占 ${round((mc.marketUpRatio || 0) * 100)}%`;
    const cov = mc.coverage ? mc.coverage : '东财股吧';
    detail += `（数据源：${cov}`;
    if (typeof mc.sampleCount === 'number') detail += `，样本 ${mc.sampleCount} 只`;
    if (mc.updatedAt) detail += `，更新于 ${mc.updatedAt}`;
    detail += '）';
    present.push({ key: 'marketHeat', label: '股吧讨论热度', signal: clamp(mc.marketHeat, -1, 1),
      value: `热度 ${round(mc.marketHeat, 2)}`,
      detail });
  }
  if (gs && gs.ok && typeof gs.signal === 'number' && gs.count > 0) {
    present.push({ key: 'globalSent', label: '全网消息面', signal: clamp(gs.signal, -1, 1),
      value: `利好 ${gs.positive}/利空 ${gs.negative}`,
      detail: `最近全网 ${gs.count} 条相关消息，整体偏${gs.avg_score != null ? (gs.avg_score >= 0 ? '好' : '差') : '—'}（情感分 ${gs.avg_score != null ? (gs.avg_score >= 0 ? '+' : '') + round(gs.avg_score, 2) : '—'}）` });
  }
  // 动量（真实历史，用最新一根）
  const closes = (Array.isArray(shHist) ? shHist : []).map(h => h.close).filter(v => typeof v === 'number');
  if (closes.length >= 25) {
    const mom = _indexMomentumAt(closes, closes.length - 1);
    present.push({ key: 'indexMom', label: '大盘近期涨跌势头', signal: mom.signal, detail: mom.detail, value: '' });
  }
  // 广度（最新一根 + 个股涨跌家数，优先用同花顺行业板块个股合计）
  let sectorSignal = null;
  let stockCounts = null;
  if (mo) {
    const up = mo.sectorUpCount || 0, down = mo.sectorDownCount || 0, flat = mo.sectorFlatCount || 0;
    const tot = up + down + flat;
    if (tot > 0) sectorSignal = clamp((up - down) / tot / 0.6, -1, 1);
    // 若返回了全量板块，加总各板块内上涨/下跌家数，得到全市场个股涨跌数量（比板块数量更细）
    if (Array.isArray(mo.sectorAll) && mo.sectorAll.length) {
      const stockUp = mo.sectorAll.reduce((a, s) => a + (s.upCount || 0), 0);
      const stockDown = mo.sectorAll.reduce((a, s) => a + (s.downCount || 0), 0);
      const stockFlat = mo.sectorAll.reduce((a, s) => a + (s.flatCount || 0), 0);
      stockCounts = {
        up: stockUp,
        down: stockDown,
        flat: stockFlat || undefined,
        source: mo.sectorSource || '同花顺·行业板块个股合计',
        approx: !mo.sectorIsEastmoney,
      };
    }
  }
  const lastRet = closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100 : 0;
  const ad = _advDeclineAt(lastRet, sectorSignal, stockCounts);
  present.push({ key: 'advDecline', label: '上涨 vs 下跌家数', signal: ad.signal, detail: ad.detail, value: ad.value });

  // 宏观情绪因子（非常驻 · 自学习）：由 sentimentTurningPoint 预先计算并映射为统一组件格式传入；
  // 已是「激活 + 数值有效」的因子，直接并入权重池参与融合。休眠因子在调用方已被过滤，不进入 present。
  if (Array.isArray(opts.macroComponents)) {
    for (const mc of opts.macroComponents) {
      if (mc && typeof mc.signal === 'number') {
        present.push({
          key: mc.key,
          label: mc.label || '宏观情绪因子',
          signal: clamp(mc.signal, -1, 1),
          value: mc.value || '',
          detail: mc.detail || '',
        });
      }
    }
  }

  const { index, components } = blendComponents(present);
  return {
    date: localDate(), index, components,
    available: components.filter(c => c.weight > 0).length,
    total: 8,
    source: '东方财富·涨跌停池/融资余额/股吧舆情 + 同花顺热榜 + 雪球关注榜 交叉验证 + cn-financial-scraper 全网舆情 + 上证指数动量/广度 + 每日宏观 & 政策（国内经济数据 / 美国宏观事件）',
  };
}

/**
 * 记录当日快照（盘后/启动 best-effort 调用）。同一天多次调用幂等（覆盖）。
 */
async function recordDailySnapshot(opts = {}) {
  let idx;
  try { idx = await computeIndex(opts); } catch (e) { return null; }
  if (!idx || typeof idx.index !== 'number') return null;
  const series = readSeries();
  const snap = {
    date: idx.date, index: idx.index,
    // 20260917f：同时持久化 value/detail。原先只存 {key,label,signal,weight}，
    // 导致任何「读序列」而非「重新抓取」的消费方（如大盘量能情绪模型）拿不到
    // 数据源 / 样本数 / 更新时间 / 看多占比 等来源标注，只能显示一个光秃秃的数字。
    components: idx.components.map(c => ({
      key: c.key, label: c.label, signal: c.signal, weight: c.weight,
      value: c.value || '', detail: c.detail || '',
    })),
    ts: Date.now(),
  };
  const i = series.findIndex(s => s.date === snap.date);
  if (i >= 0) series[i] = snap; else series.push(snap);
  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeSeries(series);
  return snap;
}

/**
 * 重建过去交易日的近似快照：静态分量（涨跌停比/融资余额/热度/舆情）用 latestStatic 近似，
 * 动量/广度用上证真实历史，使序列产生真实波动（z-score 可用）。
 */
function rebuildBackfill(shHist, latestStatic, earliestDate, backfillDays) {
  const closes = (Array.isArray(shHist) ? shHist : []).map(h => h.close).filter(v => typeof v === 'number');
  const dates = (Array.isArray(shHist) ? shHist : []).map(h => h.date).filter((_, i) => typeof closes[i] === 'number');
  if (closes.length < 25) return [];
  const out = [];
  for (let i = 24; i < closes.length; i++) {
    const d = dates[i];
    if (!d || d >= earliestDate) continue; // 真实快照优先
    const dayDiff = (Date.parse(earliestDate) - Date.parse(d)) / 86400000;
    if (dayDiff > backfillDays) continue;
    const mom = _indexMomentumAt(closes, i);
    const shRet = i >= 1 ? (closes[i] - closes[i - 1]) / closes[i - 1] * 100 : 0;
    const adv = _advDeclineAt(shRet, null);
    const present = [...latestStatic, { key: 'indexMom', signal: mom.signal }, { key: 'advDecline', signal: adv.signal }];
    const { index, components } = blendComponents(present);
    out.push({ date: d, index, components: components.map(c => ({ key: c.key, signal: c.signal, weight: c.weight })), ts: 0, approx: true });
  }
  return out;
}

/**
 * 读取时间序列（含回填）。
 * opts.shHistory: 上证历史（用于真实动量回填）；opts.staticComponents: 最新快照的静态分量 [{key,signal}]。
 */
async function getSeries({ allowBackfill = true, shHistory = null, staticComponents = [], backfillDays = 120 } = {}) {
  const real = readSeries();
  if (!allowBackfill || real.length >= 40) return { real, full: real, backfilled: 0 };
  const earliest = real.length ? real[0].date : localDate();
  let sh = shHistory;
  if (!sh) { try { sh = await getHistory('sh000001', '1y'); } catch (e) { sh = []; } }
  // 静态分量：优先用传入的最新快照；否则取最近真实快照的分量信号
  let statics = staticComponents && staticComponents.length ? staticComponents.slice() : [];
  if (!statics.length && real.length) {
    statics = (real[real.length - 1].components || []).map(c => ({ key: c.key, signal: c.signal }));
  }
  // 仅保留"静态类"分量（排除动量/广度，因其用真实历史重建）
  statics = statics.filter(c => ['breadth', 'margin', 'marketHeat', 'globalSent'].includes(c.key));
  const backfilled = rebuildBackfill(sh, statics, earliest, backfillDays);
  const full = real.concat(backfilled);
  full.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { real, full, backfilled: backfilled.length };
}

module.exports = {
  computeIndex, recordDailySnapshot, getSeries, readSeries,
  SERIES_FILE, DEFAULT_SYMBOL, DEFAULT_NAME,
};

~~~

---

## `lib\marketTechJudgment.js`  ·  380 行

~~~js
/**
 * 大盘技术分析 · 准确率检查（lib/marketTechJudgment.js · 20260914i）
 * --------------------------------------------------------------
 * 目的：给「大盘技术分析」模块加入可事后验证的准确率统计，便于持续提升判断质量。
 *
 * 设计原则（与全局铁律一致）：
 *  1. 代码权威：命中判定全部为确定性 IF-THEN，无 LLM 参与。
 *  2. 口径复用：结算口径与 lib/sameDayJudgment.js 保持同源语义
 *     （震荡＝实际涨跌绝对值 ≤ 容差；方向＝预测方向与实际上涨/下跌方向一致）。
 *  3. 完全隔离：本模块独立落盘 data/market-tech/，**不碰** data/judgments/，
 *     避免污染个股准确率统计（sameDayJudgment 的 getAllRecords 硬编码读 judgments 目录）。
 *  4. 诚实合规：数据不足/未到目标日 → 不结算并显式计入 pending，绝不猜算。
 *
 * 结算口径（经用户确认）：
 *  · 短期方向 step6.shortTerm.direction（看多/看空/震荡）
 *      → 次日收盘 vs 基准日收盘，nextday 口径（与个股短期判断一致）
 *  · 中期方向 step6.midTerm.direction（看多/看空/震荡）
 *      → 第 MID_HORIZON 个交易日收盘 vs 基准日收盘（默认 20 个交易日）
 *  · 融合信号 fused.fusionSignal（强多/偏多/震荡/偏空/强空/反弹/回调风险）
 *      → 额外按 nextday 口径结算，并可做「置信度分桶准确率」
 *
 * 存储：data/market-tech/<基准日>.json（每日一条，含全部指数的判断与结算）
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { getKlineJson } = require('./tklineHost');   // 20261021g：腾讯K线主机族降级
const { localDate, nextTradingDay, marketClosed } = require('./sameDayJudgment');
const { isTradingDay } = require('./cnTradingCalendar');

// ---- 常量 ----
const DIR = path.join(__dirname, '..', 'data', 'market-tech');
const MID_HORIZON = 20;          // 中期验证周期（交易日）
const FLAT_TOLERANCE = 0.5;      // 「震荡」命中容差（%）：指数波动比个股小，容差收紧到 0.5%
// 20261021c：目标日无 K 线时的兜底容忍天数（停牌/数据缺口）。超过则不结算并写 settleError，
// 绝不把「20 天后的 K 线」当成「次日」来结算——那会静默改变验证口径。
const TARGET_FALLBACK_MAX_DAYS = 5;
const SETTLE_MIN_INTERVAL_MS = 3 * 60 * 1000;   // 页面自动结算的最小间隔（避免每次刷新都打网络）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQ_OPTS = { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 10000 };

// 基准指数：以「上证指数」作为大盘结算基准（其余指数为佐证，不单独结算，避免样本虚增）
const BENCH = { code: 'sh000001', name: '上证指数' };

// 模块级状态：自动结算节流时间戳 + 测试注入的日K取数函数
let _lastSettleAt = 0;
let _fetchDaily = fetchIndexDaily;   // 测试可替换，生产恒为 fetchIndexDaily

function round(x, n = 2) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function daysBetween(a, b) {
  const t1 = new Date(a + 'T00:00:00').getTime();
  const t2 = new Date(b + 'T00:00:00').getTime();
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}
function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(dateStr) { return path.join(DIR, dateStr + '.json'); }

/** 拉取指数日K（腾讯 fqkline，与 lib/marketTechnical.js 同源口径） */
async function fetchIndexDaily(code, count = 320) {
  // 20261021g：主机族降级（ifzq 501 → web.ifzq），否则准确率结算会因取不到上证日K而全部挂起
  const body = await getKlineJson(`/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`, REQ_OPTS);
  const node = body && body.data && body.data[code];
  if (!node) return [];
  const arr = node.day || node.qfqday || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(d => ({ date: String(d[0]), open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5] }))
    .filter(b => b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 方向归一化：把各种词汇映射为 涨/跌/震荡 三态（结算唯一口径） */
function normalizeDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/震荡|横盘|整理|观望|中性/.test(s)) return '震荡';
  if (/看多|偏多|强多|上行|向上|上涨|走强|反弹|多头/.test(s)) return '涨';
  if (/看空|偏空|强空|下行|向下|下跌|走弱|回调|空头/.test(s)) return '跌';
  return null;
}
function verdictOf(dir) {
  return dir === '涨' ? '看涨' : dir === '跌' ? '看跌' : dir === '震荡' ? '看震荡' : '';
}

/**
 * 从 getMarketTechnical() 的结果中抽取「可验证判断」并落盘。
 * 每日仅记一条（同一基准日重复调用则覆盖，保证幂等）。
 * @param {object} mt getMarketTechnical() 返回值
 * @returns {object|null} 落盘记录
 */
function recordDailyJudgment(mt) {
  try {
    if (!mt || !mt.success || !Array.isArray(mt.indices) || !mt.indices.length) return null;
    const sh = mt.indices.find(i => i.code === BENCH.code) || mt.indices[0];
    if (!sh || !sh.step6) return null;

    const baseDate = sh.date || mt.date || localDate();
    const baseClose = typeof sh.lastClose === 'number' ? sh.lastClose : null;
    if (baseClose == null) return null;

    const midRaw = sh.step6.midTerm && sh.step6.midTerm.direction;
    const shortRaw = sh.step6.shortTerm && sh.step6.shortTerm.direction;
    const fused = mt.fused || {};

    const rec = {
      baseDate,                                     // 判断所依据的收盘日
      targetDate: nextTradingDay(baseDate),         // 短期验证目标日（次日）
      midTargetIndex: MID_HORIZON,                  // 中期验证周期（交易日）
      generatedAt: new Date().toISOString(),
      benchCode: BENCH.code,
      benchName: BENCH.name,
      baseClose,

      // ---- 待验证判断（短期）----
      shortRaw: String(shortRaw || ''),
      shortDir: normalizeDir(shortRaw),
      shortVerdict: verdictOf(normalizeDir(shortRaw)),
      shortLogic: (sh.step6.shortTerm && sh.step6.shortTerm.logic) || '',

      // ---- 待验证判断（中期）----
      midRaw: String(midRaw || ''),
      midDir: normalizeDir(midRaw),
      midVerdict: verdictOf(normalizeDir(midRaw)),
      midLogic: (sh.step6.midTerm && sh.step6.midTerm.logic) || '',

      // ---- 融合信号 + 置信度（用于分桶准确率）----
      fusionSignal: String(fused.fusionSignal || ''),
      fusionDir: normalizeDir(fused.fusionSignal),
      confidence: String(fused.confidence || ''),
      positionText: (fused.position && fused.position.finalText) || '',

      // ---- 结算位（初始为空）----
      shortSettled: false, shortActualDir: null, shortActualChgPct: null, shortCorrect: null,
      midSettled: false, midActualDir: null, midActualChgPct: null, midCorrect: null,
      settleError: null,
    };

    ensureDir();
    fs.writeFileSync(fileFor(baseDate), JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  } catch (e) {
    console.error('[marketTechJudgment] 落盘失败:', e && e.message);
    return null;
  }
}

function getRecord(dateStr) {
  try { return JSON.parse(fs.readFileSync(fileFor(dateStr), 'utf8')); } catch (e) { return null; }
}

/** 读取全部记录（仅规范日期文件，排除备份残留） */
function getAllRecords() {
  ensureDir();
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (rec && rec.baseDate) out.push(rec);
    } catch (e) {}
  }
  return out;
}

/**
 * 结算一条记录。口径与 sameDayJudgment 同源：
 *   短期：targetDate 收盘 vs baseDate 收盘
 *   中期：baseDate 起第 MID_HORIZON 个交易日收盘 vs baseDate 收盘
 * 数据未就绪 / 未收盘 → 保持未结算（不改写），由 overdueCount 暴露。
 */
async function settleRecord(rec, sharedBars) {
  if (!rec || !rec.baseDate) return rec;
  const now = new Date();
  const today = localDate(now);
  try {
    const bars = Array.isArray(sharedBars) && sharedBars.length ? sharedBars : await _fetchDaily(BENCH.code);
    if (!bars.length) return rec;
    const idxOf = (d) => bars.findIndex(b => b.date === d);
    const baseIdx = idxOf(rec.baseDate);
    if (baseIdx < 0) { rec.settleError = '基准日K线缺失'; return rec; }
    const baseClose = rec.baseClose != null ? rec.baseClose : bars[baseIdx].close;

    // ---------- 短期（次日）----------
    if (!rec.shortSettled) {
      // 20261021c：**不信存储的 targetDate**。历史记录可能由旧口径写入（只跳周末、未跳法定节假日），
      // 于是 targetDate 落在节假日（例：09-24 的次日被记成中秋 09-25、09-30 的次日被记成国庆 10-01）。
      // K 线里永远没有这一天 → 既不结算、又永久计入「过期未结算」——这正是用户报障「老是无法结算」的根因。
      // 口径：短期就是「基准日之后的第一个交易日」，该值只由日历决定，存储值仅在它是交易日时才被采信。
      const authoritative = nextTradingDay(rec.baseDate);
      let targetDate = rec.targetDate && isTradingDay(rec.targetDate) ? rec.targetDate : authoritative;
      if (rec.targetDate !== targetDate) {
        rec.targetDateFixed = { from: rec.targetDate || null, to: targetDate, reason: '原目标日非交易日，按交易日历重算', at: new Date().toISOString() };
        rec.targetDate = targetDate;
      }
      let tIdx = idxOf(targetDate);
      let usedDate = targetDate;
      if (tIdx < 0) {
        // 目标日是交易日但没有 K 线（数据缺口/临时休市）→ 取其后首个有 K 线的交易日，
        // 但只在容忍天数内（TARGET_FALLBACK_MAX_DAYS），否则宁可挂着并写明原因，也不改口径。
        const fIdx = bars.findIndex(b => b.date > targetDate);
        if (fIdx >= 0) {
          const gap = daysBetween(targetDate, bars[fIdx].date);
          if (gap != null && gap <= TARGET_FALLBACK_MAX_DAYS) {
            tIdx = fIdx;
            usedDate = bars[fIdx].date;
            rec.shortTargetFallback = { want: targetDate, used: usedDate, gapDays: gap };
          } else {
            rec.settleError = `目标日 ${targetDate} 无K线，其后首个K线 ${bars[fIdx].date} 相隔 ${gap} 天，超出容忍 ${TARGET_FALLBACK_MAX_DAYS} 天`;
          }
        }
      }
      if (tIdx >= 0) {
        const tBar = bars[tIdx];
        // 目标日尚未收盘则不结算
        if (!(usedDate === today && !marketClosed(now))) {
          const chg = (tBar.close - baseClose) / baseClose * 100;
          const actDir = tBar.close > baseClose ? '涨' : (tBar.close < baseClose ? '跌' : '震荡');
          const correct = rec.shortDir === '震荡'
            ? Math.abs(chg) <= FLAT_TOLERANCE
            : rec.shortDir === actDir;
          rec.shortActualDir = actDir;
          rec.shortActualChgPct = round(chg, 2);
          rec.shortActualDate = usedDate;   // 实际用于结算的交易日（与 targetDate 不同时即走了兜底）
          rec.shortCorrect = !!correct;
          rec.shortSettled = true;
        }
      }
    }

    // ---------- 中期（MID_HORIZON 个交易日后）----------
    if (!rec.midSettled) {
      const midIdx = baseIdx + MID_HORIZON;
      if (midIdx < bars.length) {
        const mBar = bars[midIdx];
        const mDate = mBar.date;
        if (!(mDate === today && !marketClosed(now))) {
          const chg = (mBar.close - baseClose) / baseClose * 100;
          const actDir = mBar.close > baseClose ? '涨' : (mBar.close < baseClose ? '跌' : '震荡');
          const correct = rec.midDir === '震荡'
            ? Math.abs(chg) <= FLAT_TOLERANCE
            : rec.midDir === actDir;
          rec.midActualDir = actDir;
          rec.midActualChgPct = round(chg, 2);
          rec.midCorrect = !!correct;
          rec.midSettled = true;
          rec.midActualDate = mDate;
        }
      }
    }

    if (rec.shortSettled || rec.midSettled) {
      rec.settleError = null;
      ensureDir();
      fs.writeFileSync(fileFor(rec.baseDate), JSON.stringify(rec, null, 2), 'utf8');
    }
    return rec;
  } catch (e) {
    rec.settleError = e && e.message;
    return rec;
  }
}

/** 全量结算，返回最新准确率 */
async function settleAll() {
  const records = getAllRecords();
  let changed = 0;
  // 20261021c：整批只拉一次指数日K（原来每条记录各拉一次，19 条就 19 次网络请求）。
  let sharedBars = null;
  try { sharedBars = await _fetchDaily(BENCH.code); } catch (e) { sharedBars = null; }
  for (const rec of records) {
    const before = (rec.shortSettled ? 1 : 0) + (rec.midSettled ? 1 : 0);
    const after = await settleRecord(rec, sharedBars);
    const nowS = (after.shortSettled ? 1 : 0) + (after.midSettled ? 1 : 0);
    if (nowS > before) changed++;
  }
  return { changed, accuracy: computeAccuracy(getAllRecords()) };
}

/**
 * 20261021c：带节流的自动结算（页面/接口读取前调用）。
 * 用户报障「老是出现无法结算」的直接观感来源之一是：准确率条只**读**不**算**，
 * 只有点开「准确率核对」再手动结算才会推进。这里让读取路径顺带结算，但 3 分钟内不重复打网络。
 */
async function settleIfDue(opts = {}) {
  const now = Date.now();
  if (!opts.force && now - _lastSettleAt < SETTLE_MIN_INTERVAL_MS) {
    return { skipped: true, changed: 0, accuracy: computeAccuracy() };
  }
  _lastSettleAt = now;
  try {
    const r = await settleAll();
    return { skipped: false, ...r };
  } catch (e) {
    console.warn('[marketTechJudgment] 自动结算失败:', e && e.message);
    return { skipped: true, error: e && e.message, changed: 0, accuracy: computeAccuracy() };
  }
}

/**
 * 准确率统计：短期 / 中期 / 融合信号 三套，各自含总体与分方向、分置信度。
 */
function computeAccuracy(records) {
  const recs = (records || getAllRecords());
  const today = localDate();

  function stat(list, getPred, getActual, isSettled, isCorrect) {
    const settled = list.filter(isSettled);
    const t = settled.length;
    const c = settled.filter(isCorrect).length;
    const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
    const byConf = { 高: { t: 0, c: 0 }, 中: { t: 0, c: 0 }, 低: { t: 0, c: 0 } };
    for (const r of settled) {
      const p = getPred(r);
      if (byDir[p]) { byDir[p].t++; if (isCorrect(r)) byDir[p].c++; }
      const cf = r.confidence;
      if (byConf[cf]) { byConf[cf].t++; if (isCorrect(r)) byConf[cf].c++; }
    }
    const rate = (p) => (p.t ? round(p.c / p.t * 100, 1) : null);
    return {
      settledCount: t,
      correct: c,
      accuracy: t ? round(c / t * 100, 1) : null,
      bullRate: rate(byDir['涨']), bullTotal: byDir['涨'].t,
      bearRate: rate(byDir['跌']), bearTotal: byDir['跌'].t,
      flatRate: rate(byDir['震荡']), flatTotal: byDir['震荡'].t,
      confHighRate: rate(byConf['高']), confHighTotal: byConf['高'].t,
      confMidRate: rate(byConf['中']), confMidTotal: byConf['中'].t,
      confLowRate: rate(byConf['低']), confLowTotal: byConf['低'].t,
    };
  }

  // 短期：仅统计有明确方向的判断（无方向则不参与）
  const shortRecs = recs.filter(r => r.shortDir);
  const midRecs = recs.filter(r => r.midDir);
  const fusionRecs = recs.filter(r => r.fusionDir);

  const short = stat(shortRecs, r => r.shortDir, r => r.shortActualDir, r => r.shortSettled, r => r.shortCorrect);
  const mid = stat(midRecs, r => r.midDir, r => r.midActualDir, r => r.midSettled, r => r.midCorrect);
  const fusion = stat(fusionRecs, r => r.fusionDir, r => r.shortActualDir, r => r.shortSettled, r => r.shortCorrect);

  const shortPending = shortRecs.filter(r => !r.shortSettled).length;
  const midPending = midRecs.filter(r => !r.midSettled).length;
  // 20261021c：过期判定用**权威目标日**（存储值非交易日时按日历重算），
  // 否则旧记录里的节假日目标日会一直显示「过期未结算」，看起来永远修不好。
  const effTarget = (r) => (r.targetDate && isTradingDay(r.targetDate)) ? r.targetDate : nextTradingDay(r.baseDate);
  const overdueShort = shortRecs.filter(r => !r.shortSettled && effTarget(r) < today).length;

  return {
    totalRecords: recs.length,
    horizonLabel: `短期=次日 / 中期=${MID_HORIZON}交易日`,
    flatTolerance: FLAT_TOLERANCE,
    short: { ...short, pendingCount: shortPending, overdueCount: overdueShort },
    mid: { ...mid, pendingCount: midPending },
    fusion,
    benchmark: BENCH.name,
    source: '基准：上证指数（腾讯 fqkline 日K，前复权）；命中＝方向一致，震荡以涨跌绝对值 ≤ ' + FLAT_TOLERANCE + '% 计。',
  };
}

module.exports = {
  recordDailyJudgment,
  getAllRecords,
  getRecord,
  settleRecord,
  settleAll,
  computeAccuracy,
  normalizeDir,
  fetchIndexDaily,
  MID_HORIZON,
  FLAT_TOLERANCE,
  TARGET_FALLBACK_MAX_DAYS,
  SETTLE_MIN_INTERVAL_MS,
  settleIfDue,
  DIR,
  // 测试注入：替换指数日K取数（生产不得调用）
  __setFetchDaily: (fn) => { _fetchDaily = typeof fn === 'function' ? fn : fetchIndexDaily; _lastSettleAt = 0; },
};

~~~

---

## `lib\marketTechnical.js`  ·  920 行

~~~js
/**
 * 大盘技术分析融合引擎（lib/marketTechnical.js · 融合版 20260914e）
 * --------------------------------------------------------------
 * 把原「大盘技术分析（六步推演）」与「A股短线结构研判」两个首页模块合并为
 * 单一融合引擎，严格遵循用户投喂的「大盘技术分析融合版逻辑指令」七步推演：
 *   ① 趋势与结构定性  ② 统一量价引擎  ③ 指标共振与趋势过滤(ADX 门控)
 *   ④ 多周期与跨指数共振  ⑤ 短线结构执行层  ⑥ 外部变量可靠度修正
 *   ⑦ 综合决策与仓位（含置信度 + 证据链）
 *
 * 设计原则（与全局一致）：
 * 1. 代码权威：全部确定性 IF-THEN，无 LLM 数值/方向判断。
 * 2. 数据复用：技术面腾讯 K 线；外部变量 lib/macroNews（国际宏观，仅语义方向）。
 * 3. 隔离：本模块为纯重写，不改变对 downstream（sameDayJudgment/longTermJudgment）
 *    的契约——每只指数仍输出 step1..step6，且 step6.midTerm.direction /
 *    step6.shortTerm.direction 取值词汇保持「看多/看空/震荡」不变。
 * 4. 诚实合规：外部变量无精确实时报价，仅语义方向，明确标注。
 *
 * 输出（与前端/下游约定）：
 *   { success, date, updatedAt, indices[], synthesis,
 *     fused:{ state, reliable, anchors, volume, external, signals,
 *             risk, bias, position, confidence, evidenceChain,
 *             fusionSignal, resonance } }
 */

const axios = require('axios');
const { SMA, EMA, RSI, MACD, Bollinger, KDJ, ADX } = require('./analysis');
const { getKlineJson } = require('./tklineHost');   // 20261021g：腾讯K线主机族降级
const { getMacroNews } = require('./macroNews');
const { localDate, localCompact, localDateFromTs } = require('./localDate');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQ_OPTS = { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 10000 };

// 三大指数（腾讯代码）
const INDICES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
];

// ---- 工具函数 ----
function last(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}
function mean(a) {
  const v = a.filter(x => typeof x === 'number' && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function round(x, d = 0) {
  if (x === null || x === undefined || isNaN(x)) return null;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}
function num(x) { return (typeof x === 'number' && !isNaN(x)) ? x : null; }
function pct(x) { return (x == null) ? '—' : (x > 0 ? '+' : '') + x.toFixed(2) + '%'; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---- 数据拉取（腾讯 fqkline / mkline，绕开被墙的东财 push2his）----
async function fetchKline(code, period, count) {
  // 20261021g：主机族降级（ifzq 501 → web.ifzq）
  const body = await getKlineJson(`/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`, REQ_OPTS);
  const node = body && body.data && body.data[code];
  if (!node) return [];
  const arr = node[period] || node['qfq' + period] || [];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(d => ({
    date: String(d[0]),
    open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5],
  })).filter(b => b.close > 0);
}
async function fetchM30(code, count) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m30,,${count}`;
  const resp = await axios.get(url, REQ_OPTS);
  const node = resp.data && resp.data.data && resp.data.data[code];
  const arr = (node && node.m30) || [];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(d => ({
    date: String(d[0]),
    open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5],
  })).filter(b => b.close > 0);
}
async function fetchAllPeriods(code) {
  const [day, week, month, m30] = await Promise.all([
    fetchKline(code, 'day', 320),
    fetchKline(code, 'week', 160),
    fetchKline(code, 'month', 90),
    fetchM30(code, 160),
  ]);
  return { day, week, month, m30 };
}

// ---- 指标打包 ----
function computeIndicators(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const vols = bars.map(b => b.volume);
  const ma = {};
  [5, 10, 20, 60, 120, 250].forEach(p => { ma[p] = SMA(closes, Math.min(p, closes.length)); });
  return {
    closes, highs, lows, vols, ma,
    adx: ADX(highs, lows, closes, 14),
    macd: MACD(closes),
    kdj: KDJ(highs, lows, closes, 9),
    rsi: RSI(closes, 14),
    boll: Bollinger(closes, 20, 2),
  };
}

// 方向判定（用于周/月/日/30分周期）：last 收盘 vs MA(maP) 且 vs 前一根
function trendDirOf(bars, maP = 6) {
  if (!bars || bars.length < maP + 2) return '平';
  const closes = bars.map(b => b.close);
  const ma = SMA(closes, Math.min(maP, closes.length));
  const lastMa = last(ma);
  if (lastMa === null) return '平';
  const lastClose = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (lastClose > lastMa && lastClose >= prev) return '向上';
  if (lastClose < lastMa && lastClose <= prev) return '向下';
  if (lastClose > lastMa) return '向上';
  if (lastClose < lastMa) return '向下';
  return '平';
}
function barsFromInd(ind) {
  const bars = [];
  for (let i = 0; i < ind.closes.length; i++) {
    bars.push({ close: ind.closes[i], high: ind.highs[i], low: ind.lows[i] });
  }
  return bars;
}
// 摆动点法找最近下支撑 / 上压力
function nearestLevels(bars, current, count = 40) {
  const recent = bars.slice(-count);
  let sup = null, res = null;
  for (let i = 2; i < recent.length - 2; i++) {
    const lo = recent[i].low, hi = recent[i].high;
    if (lo < recent[i - 1].low && lo < recent[i - 2].low && lo < recent[i + 1].low && lo < recent[i + 2].low) {
      if (lo < current && (sup === null || lo > sup)) sup = lo;
    }
    if (hi > recent[i - 1].high && hi > recent[i - 2].high && hi > recent[i + 1].high && hi > recent[i + 2].high) {
      if (hi > current && (res === null || hi < res)) res = hi;
    }
  }
  return { sup, res };
}

// ---- 第一步：趋势与结构定性 ----
function step1Trend(ind) {
  const closes = ind.closes;
  const i = closes.length - 1;
  const maVals = {};
  [5, 10, 20, 60, 120, 250].forEach(p => { maVals[p] = ind.ma[p][i]; });
  const ordered = [5, 10, 20, 60, 120, 250].filter(p => maVals[p] != null);
  const vals = ordered.map(p => maVals[p]);
  let bullish = true, bearish = true;
  for (let k = 1; k < vals.length; k++) {
    if (vals[k] >= vals[k - 1]) bearish = false;
    if (vals[k] <= vals[k - 1]) bullish = false;
  }
  const arrangement = bullish ? '多头排列' : (bearish ? '空头排列' : '均线粘合/纠缠');
  const adxLast = last(ind.adx.adx);
  const plusDI = last(ind.adx.plusDI), minusDI = last(ind.adx.minusDI);
  let adxState, trendLabel;
  if (adxLast === null) { adxState = '无法判定'; trendLabel = '无法判定'; }
  else if (adxLast < 25) { adxState = '震荡市'; trendLabel = '区间震荡'; }
  else if (adxLast > 30) {
    adxState = '趋势市';
    trendLabel = bullish ? '趋势性上涨' : (bearish ? '趋势性下跌' : '区间震荡(方向不明)');
  } else { adxState = '临界(25-30)'; trendLabel = bullish ? '偏强震荡' : (bearish ? '偏弱震荡' : '区间震荡'); }
  return { maVals, arrangement, adx: adxLast, adxState, trendLabel, plusDI, minusDI };
}

// ---- 形态识别 ----
function detectPatterns(bars) {
  if (!bars || bars.length < 30) return { name: null, bias: '中性', note: '数据不足，无法判定形态' };
  const look = bars.slice(-60);
  const highs = look.map(b => b.high), lows = look.map(b => b.low), closes = look.map(b => b.close);
  const peaks = [], troughs = [];
  for (let i = 2; i < look.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) peaks.push({ i, v: highs[i] });
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) troughs.push({ i, v: lows[i] });
  }
  const lastClose = closes[closes.length - 1];
  if (peaks.length >= 2) {
    const a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
    if (Math.abs(a.v - b.v) / a.v < 0.03 && b.i - a.i > 5) {
      const neck = Math.min(...look.slice(a.i, b.i + 1).map(x => x.low));
      if (lastClose < neck) return { name: '双顶', bias: '偏空', note: `右顶 ${round(b.v)} 与左顶 ${round(a.v)} 等高，跌破颈线 ${round(neck)}` };
    }
  }
  if (troughs.length >= 2) {
    const a = troughs[troughs.length - 2], b = troughs[troughs.length - 1];
    if (Math.abs(a.v - b.v) / a.v < 0.03 && b.i - a.i > 5) {
      const neck = Math.max(...look.slice(a.i, b.i + 1).map(x => x.high));
      if (lastClose > neck) return { name: '双底', bias: '偏多', note: `右底 ${round(b.v)} 与左底 ${round(a.v)} 等高，突破颈线 ${round(neck)}` };
    }
  }
  const win = look.slice(-40);
  let hiDesc = true, loAsc = true;
  for (let i = 1; i < win.length; i++) {
    if (win[i].high > win[i - 1].high) hiDesc = false;
    if (win[i].low < win[i - 1].low) loAsc = false;
  }
  if (hiDesc && loAsc) return { name: '三角形收敛', bias: '中性', note: '高点下移、低点上移，方向待突破' };
  return { name: null, bias: '中性', note: '未识别到显著形态（无法判定）' };
}
function step2Structure(dayInd, weekInd, monthBars) {
  const monthDir = trendDirOf(monthBars, 6);
  const weekDir = trendDirOf(barsFromInd(weekInd), 6);
  const dayAboveMA60 = dayInd.ma[60][dayInd.closes.length - 1] !== null && dayInd.closes[dayInd.closes.length - 1] > dayInd.ma[60][dayInd.closes.length - 1];
  const dayAboveMA250 = dayInd.ma[250][dayInd.closes.length - 1] !== null && dayInd.closes[dayInd.closes.length - 1] > dayInd.ma[250][dayInd.closes.length - 1];
  const rsiWeek = last(weekInd.rsi);
  let structure;
  if (monthDir === '向上' && weekDir === '向上') {
    if (rsiWeek && rsiWeek > 80) structure = '主升浪末期(需防盛极而衰)';
    else if (dayAboveMA250) structure = '主升浪中期';
    else structure = '主升浪初期';
  } else if (monthDir === '向下' && weekDir === '向下') {
    structure = '下跌趋势·调整浪';
  } else if (monthDir === '向上' && weekDir === '向下') {
    structure = '中期调整(月线向上/周线向下)';
  } else if (monthDir === '向下' && weekDir === '向上') {
    structure = '下跌途中的反弹';
  } else if (dayAboveMA250) {
    structure = '底部盘整(站上长期均线)';
  } else {
    structure = '区间盘整';
  }
  const pattern = detectPatterns(dayInd._bars);
  return { monthDir, weekDir, dayAboveMA60, dayAboveMA250, rsiWeek, structure, pattern };
}

// ---- 第二步：统一量价引擎 ----
function step3Volume(ind, bars) {
  const vols = ind.vols, closes = ind.closes;
  const n = vols.length;
  const lastVol = vols[n - 1];
  const avg5 = mean(vols.slice(-5));
  const avg20 = mean(vols.slice(-20));
  const avg60 = mean(vols.slice(-60));
  let volState;
  if (avg20 && lastVol > avg20 * 2) volState = '异常放量';
  else if (avg20 && lastVol < avg20 * 0.6) volState = '地量';
  else if (avg20 && lastVol > avg20 * 1.2) volState = '温和放量';
  else if (avg20 && lastVol < avg20 * 0.8) volState = '缩量';
  else volState = '常态';
  let upVol = 0, downVol = 0, upCnt = 0, downCnt = 0;
  for (let i = 1; i < Math.min(20, n); i++) {
    const r = closes[n - i] - closes[n - i - 1];
    if (r > 0) { upVol += vols[n - i]; upCnt++; }
    else if (r < 0) { downVol += vols[n - i]; downCnt++; }
  }
  const avgUp = upCnt ? upVol / upCnt : 0, avgDown = downCnt ? downVol / downCnt : 0;
  const health = avgUp >= avgDown ? '健康' : '不健康';
  const recent = bars.slice(-60);
  const maxClose60 = Math.max(...recent.map(b => b.close));
  const lastClose = closes[n - 1];
  const isNewHigh = lastClose >= maxClose60 * 0.998;
  const divergence = isNewHigh && avg20 ? (lastVol < avg20) : false;
  const fakeBreakout = isNewHigh && avg20 ? (lastVol < avg20 * 0.9) : false;
  return { lastVol: round(lastVol), avg5: round(avg5), avg20: round(avg20), avg60: round(avg60), volState, health, divergence, fakeBreakout, isNewHigh, newHighLevel: round(maxClose60) };
}

// ---- 首页量能根（20261018 收敛）：上证日线序列 + 共用量能指标 ----
// 用户 2026-10-17 架构指令：首页侧量能根数据源设置在「大盘技术分析的量价关系」里，
// 其他首页模块需要的量能分析若根里没有，就在根里创建出来再引用。
// 收敛前：本模块 step3Volume 用 320 窗口（axios·腾讯 fqkline 直采），市场情绪模型
//   calcVolumeActivity/calcPriceVolume 用 260 窗口（scripts/market_emotion.py·akshare，
//   同上游腾讯 fqkline）——同源不同窗口、两套指标计算。
// 收敛后：单一采集通道（fetchIndexDailyBars，320 窗口）+ 单一指标计算
//   （computeMarketVolumeMetrics），模型侧只保留打分与文案（市场宽度修正等模型判断留本地）。
// 实测（2026-10-18）：两条通道重叠 260 根 date/close/vol 零差异；320 窗口 = 260 窗口 + 更老 60 根，
//   所有尾部窗口（-250 / -21,-1 / -20 / -5 / -3）样本集完全相同 → 数据不变则结论不变。

/** 首页量能根数据源：指数日线序列（唯一采集通道，qfq 前复权，vol=成交量·手）
 *  20261023o：新增可选 code（默认 sh000001），供情绪模型同时取深证成指（sz399001）。
 *  20261023p：腾讯 fqkline 全族被 WAF 拦（HTTP 501 + wa.gtimg.com 跳转验证页）时，
 *    指数日线降级新浪日K（仅限指数：指数无复权概念，新浪不复权日K与腾讯 qfq 数值等价；
 *    个股不走此降级——个股 qfq≠不复权）。量纲对齐：新浪指数 volume 单位=股、腾讯=手，
 *    实测 2026-10-23 sh000001 55284291200 股 vs 552842912 手 = 100.0 倍整 → ÷100。 */
async function fetchSinaIndexDailyBars(count, code) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${count}`;
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
  });
  const arr = resp.data;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('新浪日K返回为空');
  return arr.map(d => ({
    date: String(d.day),
    open: +d.open, close: +d.close, high: +d.high, low: +d.low,
    volume: Math.round(+d.volume / 100), // 股 → 手（与腾讯量纲对齐）
  })).filter(b => b.close > 0);
}
async function fetchIndexDailyBars(count = 320, code = 'sh000001') {
  try {
    const bars = await fetchKline(code, 'day', count);
    if (bars && bars.length > 0) return bars;
    throw new Error('腾讯日K返回为空');
  } catch (e) {
    // 20261021g 只在腾讯主机族内部换 host；全族失败（如 WAF 501/返回空）→ 新浪降级（仅指数）
    const bars = await fetchSinaIndexDailyBars(count, code);
    console.warn(`[MarketTechnical] ${code} 量能根已降级新浪源（腾讯通道失败：${e && e.message ? e.message : e}）`);
    return bars;
  }
}

// 本地小工具（与 marketEmotionModel 原同名函数逐行等价，保证收敛迁入后数值不变）
function _mMean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _mStd(a) { if (a.length < 2) return 0; const m = _mMean(a); return Math.sqrt(_mMean(a.map(x => (x - m) * (x - m)))); }
/** 滚动窗口极端值剔除（原 marketEmotionModel trimExtremes，spec §八.1）：剔除 > mean+3σ 的样本 */
function _mTrimExtremes(values, sigma = 3) {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v));
  if (arr.length < 10) return { kept: arr, removed: 0 };
  const m = _mMean(arr), s = _mStd(arr);
  const cap = m + sigma * s;
  const kept = arr.filter(v => v <= cap);
  return { kept, removed: arr.length - kept.length };
}
/** 某值在过去窗口中的分位 0~1（原 marketEmotionModel rankPercentile） */
function _mRankPercentile(values, v) {
  const arr = values.filter(x => typeof x === 'number' && isFinite(x));
  if (!arr.length || typeof v !== 'number') return null;
  let below = 0;
  for (const x of arr) if (x < v) below++;
  return below / arr.length;
}

/**
 * 首页量能根指标：上证日线 → 大盘技术分析与市场情绪模型共用的量能指标（纯函数）。
 * 覆盖两个消费方的底层指标需求：
 *   ① 量能活跃度（原 marketEmotionModel calcVolumeActivity）：当日量 vs 剔除极端值后的近20日
 *      均量（不含今日）、过去 250 根（≈1 年）分位；20 日窗口做 mean+3σ 截尾。
 *   ② 量价配合度（原 marketEmotionModel calcPriceVolume）：近5日价格方向、近3日 vs 前3日均量方向。
 * 返回未取整原值（取整由各消费方按自身展示口径处理）；bars 不足 10 根返回 null（模型侧据此降级）。
 * @param {Array<{date:string, close:number, vol:number}>} bars 上证日线（根数据源，320 窗口）
 */
function computeMarketVolumeMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 10) return null;
  const vols = bars.map(b => b.vol);
  const closes = bars.map(b => b.close);
  const n = bars.length;
  const volToday = vols[n - 1];
  // ① 量能活跃度：20 日窗口（不含今日）剔除极端值后取均量
  const win20 = vols.slice(-21, -1);
  const { kept, removed } = _mTrimExtremes(win20);
  const avg20Excl = _mMean(kept) || 1;
  const ratio = volToday / avg20Excl;
  // 双基准：过去 250 根（≈1 年）分位
  const year = vols.slice(-250);
  const volPct = _mRankPercentile(year, volToday);
  // ② 量价配合度：近5日价格 + 近3日 vs 前3日均量
  const pNow = closes[n - 1], p5 = closes[n - 6];
  const vRecent3 = _mMean(vols.slice(n - 3));
  const vPrev3 = _mMean(vols.slice(n - 6, n - 3));
  return {
    n,
    volToday, avg20Excl, removed, ratio, volPct,
    pNow, p5, priceUp5: pNow > p5,
    vRecent3, vPrev3, volUp3: vRecent3 > vPrev3,
  };
}

// ---- 第三步：指标共振与趋势过滤（RSI/BOLL 加 ADX 门控）----
function step4Resonance(ind) {
  const n = ind.closes.length, i = n - 1;
  const macd = ind.macd, kdj = ind.kdj, rsi = ind.rsi, boll = ind.boll;
  const close = ind.closes[i];
  const dif = macd.dif[i], sig = macd.signal[i], hist = macd.histogram[i], histPrev = macd.histogram[i - 1];
  let macdBull = false, macdBear = false;
  if (dif != null && sig != null) {
    if (dif > sig && hist > 0 && (histPrev == null || hist >= histPrev)) macdBull = true;
    else if (dif < sig && hist < 0 && (histPrev == null || hist <= histPrev)) macdBear = true;
  }
  const k = kdj.k[i], d = kdj.d[i], kPrev = kdj.k[i - 1];
  let kdjBull = false, kdjBear = false;
  if (k != null && d != null) {
    if (k < 20 && k > kPrev && k > d) kdjBull = true;
    else if (k > 80 && k < kPrev && k < d) kdjBear = true;
    else if (k > 50 && k > d) kdjBull = true;
    else if (k < 50 && k < d) kdjBear = true;
  }
  const adxLast = last(ind.adx.adx);
  const trendMarket = (adxLast != null && adxLast > 30); // ADX>30 趋势市
  const r = rsi[i];
  let rsiBull = false, rsiBear = false;
  if (r != null) {
    if (trendMarket) {
      // 趋势市：RSI 极值只降权，不参与方向投票（中性）
      rsiBull = false; rsiBear = false;
    } else {
      if (r > 70) rsiBear = true;
      else if (r < 30) rsiBull = true;
      else if (r > 50) rsiBull = true;
      else rsiBear = true;
    }
  }
  const bMid = boll.middle[i], bUp = boll.upper[i], bLo = boll.lower[i];
  let bollBull = false, bollBear = false;
  if (bMid != null) {
    if (trendMarket) {
      // 趋势市：破上轨强势多，破下轨强势空；否则中性（不强行给方向）
      if (bUp != null && close > bUp) bollBull = true;
      else if (bLo != null && close < bLo) bollBear = true;
    } else {
      // 震荡市：破上轨超买空，破下轨超卖多；否则看中轨
      if (bUp != null && close > bUp) bollBear = true;
      else if (bLo != null && close < bLo) bollBull = true;
      else if (close > bMid) bollBull = true;
      else bollBear = true;
    }
  }
  const bull = [macdBull, kdjBull, rsiBull, bollBull].filter(Boolean).length;
  const bear = [macdBear, kdjBear, rsiBear, bollBear].filter(Boolean).length;
  const resonance = bull >= 3 ? '共振看多' : (bear >= 3 ? '共振看空' : '分歧震荡');
  return {
    bull, bear, resonance,
    detail: {
      MACD: macdBull ? '多' : (macdBear ? '空' : '中性'),
      KDJ: kdjBull ? '多' : (kdjBear ? '空' : '中性'),
      RSI: rsiBull ? '多' : (rsiBear ? '空' : '中性'),
      BOLL: bollBull ? '多' : (bollBear ? '空' : '中性'),
    },
    values: { dif: round(dif, 1), hist: round(hist, 1), k: round(k, 1), d: round(d, 1), rsi: round(r, 1), close: round(close, 1), bMid: round(bMid, 1), bUp: round(bUp, 1), bLo: round(bLo, 1) },
  };
}

// ---- 第四步：多周期共振 ----
function step5Cycle(dayBars, weekBars, monthBars, m30Bars) {
  const monthDir = trendDirOf(monthBars, 6);
  const weekDir = trendDirOf(weekBars, 6);
  const dayDir = trendDirOf(dayBars, 6);
  const m30Dir = trendDirOf(m30Bars, 20);
  let conclusion, strategy;
  if (monthDir === '向上' && weekDir === '向上' && dayDir === '向上') { conclusion = '共振主升'; strategy = '顺势持有/逢回调加仓'; }
  else if (monthDir === '向上' && weekDir === '向下' && dayDir === '向下') { conclusion = '中期调整'; strategy = '控仓观望/等周线企稳'; }
  else if (monthDir === '向下' && weekDir === '向下' && dayDir === '向上') { conclusion = '反弹行情'; strategy = '反弹减仓/快进快出'; }
  else if (monthDir === '向上' && weekDir === '向上' && dayDir === '向下') { conclusion = '回调买入机会'; strategy = '逢低分批布局'; }
  else if (monthDir === '向下' && weekDir === '向下' && dayDir === '向下') { conclusion = '共振下跌'; strategy = '避险/降低仓位'; }
  else { conclusion = '多周期分歧震荡'; strategy = '轻仓等待方向选择'; }
  return { monthDir, weekDir, dayDir, m30Dir, conclusion, strategy };
}

// ---- 量能性质辨析（§2/§5）：有效放量 vs 弱/无效放量 ----
function classifyVolume(idx) {
  const s3 = idx.step3 || {};
  const ld = idx.lastDay;
  const volUp = s3.volState === '温和放量' || s3.volState === '异常放量';
  if (!volUp) return { nature: s3.volState || '常态', effective: false };
  const upDay = ld && ld.close >= ld.open; // 收阳 = 进攻属性
  if (s3.health === '健康' && upDay) return { nature: '有效放量', effective: true };
  const why = upDay ? '放量但量价不健康' : '放量收阴';
  return { nature: '弱/无效放量', effective: false };
}

// ---- 盘中结构：跌破防守锚 + 探底回升（§5）----
function intraday(idx) {
  const ld = idx.lastDay;
  const prevLow = idx.prevLow;
  if (!ld || prevLow == null) return { breachedShort: false, recovered: false };
  const breachedShort = ld.low < prevLow - 1e-6; // 当日最低 < 前低 = 触及/跌破短期防守锚
  const midHL = (ld.high + ld.low) / 2;
  const recovered = ld.close > midHL; // 收盘回到日内上半区 = 探底回升
  return { breachedShort, recovered };
}

// ---- 第五步：短线结构执行层（每指数）----
function buildShortStruct(idx) {
  const s1 = idx.step1 || {};
  const s3 = idx.step3 || {};
  const ld = idx.lastDay;
  const prevLow = idx.prevLow;
  const ma5 = num((s1.maVals && s1.maVals[5]) || null);
  const aboveMA5 = (ma5 != null && idx.lastClose != null) ? idx.lastClose > ma5 : null;
  // 进攻确认：前一日收盘 < MA5 且当日收盘 >= MA5 才算“重新站上”
  const prevClose = idx.prevClose != null ? idx.prevClose : null;
  const reCrossMA5 = (ma5 != null && prevClose != null && idx.lastClose != null)
    ? (prevClose < ma5 && idx.lastClose >= ma5) : false;
  const v = classifyVolume(idx);
  const ic = intraday(idx);
  const dayBars = idx._bars || [];
  const lastClose = idx.lastClose;
  const swing = dayBars.length ? nearestLevels(dayBars, lastClose, 60) : { sup: null, res: null };
  const downDay = ld && ld.close < ld.open;
  const structuralDefensive = swing.sup != null ? round(swing.sup) : null;
  const breachedStructural = (structuralDefensive != null && ld && ld.low < structuralDefensive - 1e-6);
  // 短线方向（保持下游契约：看多/看空/震荡）
  let direction;
  if (aboveMA5 && v.effective && ic.recovered) direction = '看多';
  else if (downDay && ic.breachedShort && !ic.recovered) direction = '看空';
  else direction = '震荡';
  return {
    direction,
    aboveMA5: aboveMA5 === true,
    reCrossMA5,
    volumeNature: v.nature,
    volumeEffective: v.effective,
    breachedShort: ic.breachedShort,
    breachedStructural,
    recovered: ic.recovered,
    downDay: downDay === true,
    shortDefensive: prevLow != null ? round(prevLow) : null,     // 短期防守锚 = 前一日最低
    structuralDefensive,                                          // 结构防守锚 = 20-60 日摆动低点
    offensiveConfirm: reCrossMA5,                                 // 进攻确认 = 重新站上 MA5
  };
}

// ---- 第六步：综合预判（mid/short 合成，保留下游契约字段）----
function computeMA(bars, p) { return SMA(bars.map(b => b.close), Math.min(p, bars.length)); }
function step6Synthesis(s1, s2, s3, s4, s5, dayBars, weekBars) {
  const lastClose = dayBars[dayBars.length - 1].close;
  let midDir;
  if (s5.monthDir === '向上' && s5.weekDir === '向上') midDir = '看多';
  else if (s5.monthDir === '向下' && s5.weekDir === '向下') midDir = '看空';
  else if (s4.resonance === '共振看多' && s1.trendLabel.includes('上涨')) midDir = '看多';
  else if (s4.resonance === '共振看空' && s1.trendLabel.includes('下跌')) midDir = '看空';
  else midDir = '震荡';

  let shortDir;
  if (s5.dayDir === '向上' && s5.m30Dir === '向上') shortDir = '看多';
  else if (s5.dayDir === '向下' && s5.m30Dir === '向下') shortDir = '看空';
  else if (s4.resonance === '共振看多') shortDir = '看多';
  else if (s4.resonance === '共振看空') shortDir = '看空';
  else shortDir = '震荡';

  const wk = nearestLevels(weekBars, lastClose, 26 * 5);
  const ma120 = last(computeMA(dayBars, 120));
  const ma250 = last(computeMA(dayBars, 250));
  const ma60 = last(computeMA(dayBars, 60));
  const midSupport = wk.sup != null ? round(wk.sup) : (ma250 != null ? round(ma250) : null);
  const midResistance = wk.res != null ? round(wk.res) : (ma60 != null ? round(ma60) : null);
  const dy = nearestLevels(dayBars, lastClose, 40);
  const bollLo = round(s4.values.bLo), bollUp = round(s4.values.bUp);
  const shortSupport = dy.sup != null ? round(dy.sup) : (bollLo != null ? bollLo : null);
  const shortResistance = dy.res != null ? round(dy.res) : (bollUp != null ? bollUp : null);

  const logicFrags = [];
  logicFrags.push(`${s1.arrangement}、ADX=${s1.adx == null ? 'NA' : round(s1.adx)}（${s1.adxState}），判定「${s1.trendLabel}」`);
  logicFrags.push(`指标${s4.resonance}（MACD${s4.detail.MACD}/KDJ${s4.detail.KDJ}/RSI${s4.detail.RSI}/BOLL${s4.detail.BOLL}）`);
  if (s3.divergence) logicFrags.push(`量价${s3.health}，${s3.fakeBreakout ? '出现缩量新高顶背离预警' : '未见明显背离'}`);
  else logicFrags.push(`量价${s3.health}（${s3.volState}）`);
  const midLogic = logicFrags.slice(0, 3).join('；');
  const shortLogic = `${s5.dayDir === '向上' ? '日线向上' : s5.dayDir === '向下' ? '日线向下' : '日线横盘'}、30分${s5.m30Dir === '向上' ? '向上' : s5.m30Dir === '向下' ? '向下' : '横盘'}，指标${s4.resonance}`;

  let position, action;
  if (midDir === '看多' && s5.conclusion === '共振主升') { position = '维持 7-8 成仓'; action = '顺势持有，逢回调（不破关键支撑）加仓'; }
  else if (midDir === '看多') { position = '6 成仓'; action = s5.conclusion === '回调买入机会' ? '逢低分批布局' : '逢低布局'; }
  else if (midDir === '看空') { position = s5.conclusion === '共振下跌' ? '降至 3 成以下' : '降至 3-4 成'; action = s5.conclusion === '反弹行情' ? '反弹减仓、快进快出' : '控仓观望'; }
  else { position = '5 成仓均衡'; action = '轻仓等待方向选择，突破跟进/破位减仓'; }

  const watch = `未来 3-5 个交易日：若放量突破 ${shortResistance} 点则短期转多；若缩量跌破 ${shortSupport} 点则转空，需减仓。`;

  let risk;
  if (s3.divergence) risk = '缩量新高形成的量价顶背离尚未消化，若后续补量失败需防快速回踩。';
  else if (s4.resonance === '共振看空') risk = '指标已共振看空但 ADX 仍偏低，市场易把下跌误判为震荡，需防阴跌后反弹诱多。';
  else if (s1.adx != null && s1.adx < 25) risk = '当前 ADX 偏低属震荡市，警惕假突破与频繁的上下影线洗盘。';
  else if (s2.pattern && s2.pattern.name === '双顶') risk = '日线疑似双顶结构，颈线一旦放量跌破，调整空间或被放大。';
  else risk = '政策空窗期与外围波动（汇率/美债/大宗商品）可能放大短线波动，留意流动性边际变化。';

  return {
    midTerm: { direction: midDir, logic: midLogic, support: midSupport, pressure: midResistance },
    shortTerm: { direction: shortDir, logic: shortLogic, support: shortSupport, pressure: shortResistance },
    strategy: { position, action, watch },
    risk,
  };
}

// ---- 外部变量语义研判（§6）----
function gaugeExternal(macro) {
  const intl = (macro && macro.byCategory && macro.byCategory['国际宏观']) || [];
  let score = 0;
  const signals = [];
  const hawk = /(加息|美债.*上行|美债.*攀升|美债.*走高|收益率.*上行|收益率.*走高|收益率.*抬升|油价.*上涨|油价.*上行|原油.*上涨|原油.*上行|美元.*走强|美元.*上行|偏鹰|鹰派|收紧|紧缩)/;
  const dove = /(降息|美债.*回落|美债.*下行|美债.*走低|收益率.*回落|收益率.*下行|收益率.*走低|油价.*回落|油价.*下跌|原油.*下跌|原油.*下行|美元.*走弱|美元.*回落|偏鸽|鸽派|宽松|放水|释放流动性)/;
  for (const it of intl) {
    const t = (it.title || '') + ' ' + (it.summary || '');
    if (hawk.test(t)) { score += 1; signals.push({ dir: 'hawk', text: it.title || '' }); }
    else if (dove.test(t)) { score -= 1; signals.push({ dir: 'dove', text: it.title || '' }); }
  }
  const bias = score > 0 ? '偏鹰' : (score < 0 ? '偏鸽' : '中性');
  return { bias, score, signals: signals.slice(0, 6) };
}

// ---- 单指数完整推演 ----
async function analyzeIndex(idx) {
  const periods = await fetchAllPeriods(idx.code);
  const issues = [];
  if (!periods.day || periods.day.length < 60) issues.push('日线数据不足');
  if (!periods.week || periods.week.length < 10) issues.push('周线数据不足');
  if (!periods.month || periods.month.length < 6) issues.push('月线数据不足');
  if (!periods.m30 || periods.m30.length < 10) issues.push('30分数据不足');
  if (periods.day.length < 60) return { code: idx.code, name: idx.name, error: '数据不足，无法判定', issues };

  const dayInd = computeIndicators(periods.day);
  dayInd._bars = periods.day;
  const weekInd = computeIndicators(periods.week);
  const monthInd = computeIndicators(periods.month);
  const m30Ind = computeIndicators(periods.m30);

  const s1 = step1Trend(dayInd);
  const s2 = step2Structure(dayInd, weekInd, periods.month);
  const s3 = step3Volume(dayInd, periods.day);
  const s4 = step4Resonance(dayInd);
  const s5 = step5Cycle(periods.day, periods.week, periods.month, periods.m30);
  const s6 = step6Synthesis(s1, s2, s3, s4, s5, periods.day, periods.week);

  const dayN = periods.day.length;
  const lastClose = periods.day[dayN - 1].close;
  const prevClose = periods.day[dayN - 2] ? periods.day[dayN - 2].close : lastClose;
  const changePct = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

  const out = {
    code: idx.code,
    name: idx.name,
    lastClose: round(lastClose, 2),
    prevClose: round(prevClose, 2),
    date: periods.day[dayN - 1].date,
    changePct: round(changePct, 2),
    step1: s1,
    step2: s2,
    step3: s3,
    step4: s4,
    step5: s5,
    step6: s6,
    lastDay: periods.day[dayN - 1] ? {
      date: periods.day[dayN - 1].date,
      open: round(periods.day[dayN - 1].open, 2),
      close: round(periods.day[dayN - 1].close, 2),
      high: round(periods.day[dayN - 1].high, 2),
      low: round(periods.day[dayN - 1].low, 2),
      volume: periods.day[dayN - 1].volume,
    } : null,
    prevLow: periods.day[dayN - 2] ? round(periods.day[dayN - 2].low, 2) : null,
    issues: issues.length ? issues : null,
  };
  out._bars = periods.day;          // 供 buildShortStruct 用
  out.shortStruct = buildShortStruct(out);
  out._bars = undefined;            // 不序列化大数组
  return out;
}

// ---- 跨指数综合（文本投票，保留旧契约）----
function synthesize(indices) {
  const ok = indices.filter(x => !x.error);
  if (!ok.length) return '三大指数数据均不可用，无法判定。';
  const mid = ok.map(x => x.step6.midTerm.direction);
  const bull = mid.filter(d => d === '看多').length;
  const bear = mid.filter(d => d === '看空').length;
  if (bull >= 2 && bear === 0) return `三大指数技术面高度共振偏多（${bull}/3 看多），中期趋势同向向上，以逢低布局为主。`;
  if (bear >= 2 && bull === 0) return `三大指数技术面共振偏空（${bear}/3 看空），中期趋势同向向下，以控仓避险为主。`;
  if (bull >= 1 && bear >= 1) return `三大指数技术面出现分化（看多 ${bull}/看空 ${bear}），结构性机会与风险并存，宜轻仓区别对待。`;
  return `三大指数技术面以震荡为主（看多 ${bull}/看空 ${bear}/震荡 ${ok.length - bull - bear}），等待方向选择。`;
}

// ---- 第七步：融合决策与仓位（含置信度 + 证据链）----
function synthesizeFused(indices, ext) {
  const ok = indices.filter(x => !x.error);
  const n = ok.length || 1;
  // 20261016 审计修复：代表指数明确优先取上证（sh000001），失败才顺延第一个可用指数——
  // 原实现直接取 ok[0]，上证抓取失败时会静默改用深证/创业板，但前端锚点标签硬编码「上证」，
  // 导致标签与数据张冠李戴。cycle/anchors 均以此代表为准。
  const shRep = ok.find(x => x.code === 'sh000001') || ok[0] || null;
  // 短线结构计数
  let aboveMA5 = 0, effVol = 0, recovered = 0, breached = 0, down = 0;
  ok.forEach(x => {
    const r = x.shortStruct;
    if (r.aboveMA5) aboveMA5++;
    if (r.volumeEffective) effVol++;
    if (r.recovered) recovered++;
    if (r.breachedShort) breached++;
    if (r.downDay) down++;
  });
  // 中期方向投票
  let midBull = 0, midBear = 0;
  ok.forEach(x => {
    const d = x.step6.midTerm.direction;
    if (d === '看多') midBull++;
    else if (d === '看空') midBear++;
  });
  // 周期共振结论（取上证为代表，失败顺延；与锚点同一代表口径）
  const cycle = shRep ? shRep.step5.conclusion : '多周期分歧震荡';

  // —— §5 三态（三态互斥）——
  let state;
  if (aboveMA5 >= 2 && effVol >= 2 && recovered >= 2) state = '止跌转强';
  else if (down >= 2 && breached >= 2 && recovered <= 1) state = '破位风险';
  else state = '弱势震荡';

  // —— §7 融合信号（七类）——
  const midUp = midBull >= 2, midDown = midBear >= 2, midFlat = !midUp && !midDown;
  let fusionSignal;
  if (midUp && cycle === '共振主升' && state === '止跌转强') fusionSignal = '强多';
  else if (midDown && cycle === '共振下跌' && state === '破位风险') fusionSignal = '强空';
  else if (midDown && state === '止跌转强') fusionSignal = '反弹';
  else if (midUp && state === '破位风险') fusionSignal = '回调风险';
  else if (midUp && (state === '止跌转强' || state === '弱势震荡')) fusionSignal = '偏多';
  else if ((midFlat || midDown) && state === '破位风险') fusionSignal = '偏空';
  else if (midFlat && state === '弱势震荡') fusionSignal = '震荡';
  else fusionSignal = '震荡';

  // —— §6 外部可靠度修正 ——
  let reliable = true;
  let extNote;
  if (state === '止跌转强') {
    if (ext.bias === '偏鹰') { reliable = false; extNote = '外部偏鹰（油价/美债/美元上行或美联储收紧预期），技术止跌信号易受压制，可靠性下降，需更多确认'; }
    else if (ext.bias === '偏鸽') extNote = '外部偏鸽（油价/美债回落或美联储宽松预期），技术止跌信号可靠性提升';
    else extNote = '外部环境中性，技术信号按自身量价与均线确认';
  } else if (state === '破位风险') {
    if (ext.bias === '偏鸽') extNote = '外部偏鸽略有缓和，但破位风险已现，仍以防守为主';
    else if (ext.bias === '偏鹰') extNote = '外部偏鹰叠加破位，风险进一步放大';
    else extNote = '外部环境中性，破位风险按自身技术结构判定';
  } else {
    if (ext.bias === '偏鹰') extNote = '弱势震荡叠加外部偏鹰，反弹空间受限';
    else if (ext.bias === '偏鸽') extNote = '弱势震荡但外部偏鸽，下行空间有限，等待企稳';
    else extNote = '弱势震荡，等待更明确的方向选择';
  }

  // —— §2/§5 锚点（上证为代表，其余在 indices[].shortStruct）——
  const sh = shRep;
  const structuralDef = sh && sh.shortStruct ? sh.shortStruct.structuralDefensive : null;
  const anchors = {
    shortDefensive: sh ? sh.shortStruct.shortDefensive : null,             // 短期防守锚 = 前低
    structuralDefensive: structuralDef,                                     // 结构防守锚 = 摆动低点
    offensiveConfirm: sh ? sh.shortStruct.offensiveConfirm : false,        // 进攻确认 = 重新站上 MA5
    midSupport: sh ? sh.step6.midTerm.support : null,
    midPressure: sh ? sh.step6.midTerm.pressure : null,
  };

  // —— §2 量能 ——
  const volNature = effVol >= 2 ? '有效放量' : (ok.some(x => x.shortStruct.volumeNature === '弱/无效放量') ? '弱/无效放量' : '缩量/常态');
  const anyDivergence = ok.some(x => x.step3 && x.step3.divergence);
  const anyFake = ok.some(x => x.step3 && x.step3.fakeBreakout);
  const volume = {
    nature: volNature, effective: effVol >= 2,
    health: ok.every(x => x.step3 && x.step3.health === '健康') ? '健康' : '分化/不健康',
    divergence: anyDivergence, fakeBreakout: anyFake,
    detail: `${effVol}/${n} 指数呈有效放量；放量性质=${volNature}${anyDivergence ? '；⚠️存在缩量新高顶背离' : ''}${anyFake ? '；⚠️存在缩量假突破' : ''}`,
  };

  // —— §7 仓位（区间，非确定值）——
  let midCenter;
  if (midDown && cycle === '共振下跌') midCenter = [2, 3];
  else if (midDown) midCenter = [3, 4];
  else if (midUp && cycle === '共振主升') midCenter = [7, 8];
  else if (midUp) midCenter = [6, 6];
  else midCenter = [5, 5];
  let shortCoef;
  if (state === '止跌转强') shortCoef = [1.0, 1.2];
  else if (state === '弱势震荡') shortCoef = [0.7, 0.9];
  else shortCoef = [0.3, 0.6];
  let extCoef;
  if (ext.bias === '偏鹰') extCoef = [0.8, 0.9];
  else if (ext.bias === '偏鸽') extCoef = [1.0, 1.1];
  else extCoef = [1.0, 1.0];
  const midMid = (midCenter[0] + midCenter[1]) / 2;
  const shortMid = (shortCoef[0] + shortCoef[1]) / 2;
  const extMid = (extCoef[0] + extCoef[1]) / 2;
  const finalMid = midMid * shortMid * extMid;
  let cap = Math.min(10, midCenter[1] + 2); // 上限=中期中枢上一档
  if (ext.bias === '偏鹰') cap = Math.round(cap * 0.85); // 偏鹰下调 10-20%
  let lo = Math.max(0, Math.round(finalMid * 0.9));
  let hi = Math.min(cap, Math.round(finalMid * 1.1));
  lo = Math.min(lo, hi);
  const noAdd = (state === '破位风险' && breached >= 1 && recovered <= 1); // 硬规则：禁止加仓
  const position = {
    midCenter: `${midCenter[0]}–${midCenter[1]} 成`,
    shortCoef: `${shortCoef[0]}–${shortCoef[1]}`,
    extCoef: `${extCoef[0]}–${extCoef[1]}`,
    finalRange: [lo, hi],
    finalText: `${lo}–${hi} 成`,
    cap, noAdd,
    note: noAdd ? '风控否决：破位未收回防守锚，禁止加仓' : '未见硬否决项，按区间执行',
  };

  // —— §7 动作倾向 ——
  let bias;
  switch (fusionSignal) {
    case '强多': bias = '顺势持有，回踩 MA5 且有效放量可低吸，确认延续则持有。'; break;
    case '偏多': bias = '逢低分批，不追高；以回踩均线且量能承接时介入为主。'; break;
    case '震荡': bias = '均衡观望，等方向选择；不盲目押注突破或破位。'; break;
    case '偏空': bias = '控仓防守，降低风险暴露，等待企稳信号。'; break;
    case '强空': bias = '避险降仓，优先保护本金，反弹视为减仓机会。'; break;
    case '反弹': bias = '轻仓快进快出，不视为反转；反弹至压力位附近减仓。'; break;
    case '回调风险': bias = '暂停加仓，减仓防守，等收回防守锚并重新站上 MA5 再评估。'; break;
    default: bias = '均衡观望，等方向选择。';
  }

  // —— §4 关键信号 ——
  const panicRecover = ok.some(x => {
    const r = x.shortStruct, s3 = x.step3;
    const volUp = s3 && (s3.volState === '温和放量' || s3.volState === '异常放量');
    return r.breachedShort && r.recovered && volUp && r.downDay;
  });
  const signals = [];
  signals.push(`5日线位置：${aboveMA5}/${n} 指数收盘站上 5 日线（进攻确认=${ok.filter(x => x.shortStruct.offensiveConfirm).length}/${n} 重新站上）`);
  signals.push(`量能性质：${volNature}（有效放量 ${effVol}/${n}）${volume.divergence ? '；⚠️量价顶背离' : ''}${volume.fakeBreakout ? '；⚠️缩量假突破' : ''}`);
  if (sh && sh.prevLow != null) {
    signals.push(`防守锚（前低）：${sh.name || '上证'} ${sh.prevLow}，今日盘中 ${breached >= 1 ? '已触及/跌破' : '未破'}（${recovered}/${n} 指数探底回升至日内上半区）`);
  }
  signals.push(`探底回升：${recovered}/${n} 指数收盘回到日内上半区（${panicRecover ? '恐慌释放与承接并存' : '下方有承接'}）`);
  if (ext.bias !== '中性') signals.push(`外部变量：${ext.bias}（${ext.score > 0 ? '偏压制' : '偏支撑'}技术信号）`);

  // —— §6/§4 风险（按优先级）——
  const risk = [];
  if (breached >= 1 && recovered <= 1) risk.push(`${breached}/${n} 指数盘中跌破防守锚且未收回，失望情绪易放大，延续弱势`);
  if (aboveMA5 < 2 && effVol >= 1) risk.push('放量但多数指数未站上 5 日线，信号偏弱，警惕假突破');
  if (ext.bias === '偏鹰') risk.push('外部偏鹰（油价/美债/美元上行或美联储收紧），技术信号可靠性下降，易失效');
  if (state === '弱势震荡') risk.push('未见「站上5日线 + 有效放量」确认，不见确认不追，等待更明确企稳信号');
  if (!risk.length) risk.push('未见明确破位或强压制信号，按结构信号应对即可');

  // —— §4 置信度 ——
  let confidence;
  if (cycle === '共振主升' || cycle === '共振下跌') confidence = '高';
  else if (ok.every(x => x.step4.resonance === '分歧震荡') && ext.bias !== '偏鸽') confidence = '低';
  else confidence = '中';
  if (confidence === '高' && ext.bias === '偏鹰' && state === '止跌转强') confidence = '中';

  // —— §4 证据链 ——
  const evidenceChain = [];
  evidenceChain.push(`命中：中期看多 ${midBull}/3、看空 ${midBear}/3；周期共振「${cycle}」；短线状态「${state}」`);
  evidenceChain.push(`计数：站上MA5 ${aboveMA5}/3、有效放量 ${effVol}/3、探底回升 ${recovered}/3、破锚 ${breached}/3、收阴 ${down}/3`);
  if (state === '止跌转强' && ext.bias === '偏鹰') evidenceChain.push('冲突：技术止跌但外部偏鹰压制，可靠度下调（reliable=false）');
  if (noAdd) evidenceChain.push('风控否决：破位未收回防守锚 → 禁止加仓（硬规则优先）');
  if (confidence === '低') evidenceChain.push('分歧：指标未形成 3 票共振，且外部未明确支撑，结论置信度低');
  evidenceChain.push(`融合信号：${fusionSignal}（冲突优先级：风控 > 中期 > 短线 > 外部）`);

  return {
    state, reliable, anchors, volume,
    external: {
      bias: ext.bias, score: ext.score, reliable, note: extNote,
      signals: ext.signals,
      disclaimer: ext.bias === '中性'
        ? '外部未捕获到明确偏鹰/偏鸽信号；外部不确定性出清前 A 股技术信号仍易受压制。'
        : '外部变量基于宏观快讯语义研判（美联储/油价/美债/美元方向），非精确实时报价；精确油价与美债收益率需后续接入数据源。',
    },
    signals, risk, bias, position, confidence, evidenceChain,
    fusionSignal,
    resonance: {
      indicator: ok.map(x => `${x.name} ${x.step4.resonance}`).join('、'),
      cycle,
      cross: synthesize(indices),
    },
  };
}

// ---- 缓存（内存 + 磁盘持久化；休息日/抓取失败回退到最近可用交易日）----
let _cache = { ts: 0, date: '', data: null };
const TTL = 30 * 60 * 1000; // 30 分钟（盘后）
const _PERSIST_DIR = path.join(__dirname, '..', 'data', 'ai_cache');
const _PERSIST_FILE = path.join(_PERSIST_DIR, 'market_technical_last.json');

function _loadPersisted() {
  try {
    if (!fs.existsSync(_PERSIST_FILE)) return null;
    const obj = JSON.parse(fs.readFileSync(_PERSIST_FILE, 'utf8'));
    if (obj && obj.success && Array.isArray(obj.indices) && obj.indices.length > 0) return obj;
  } catch (_e) { /* 忽略损坏文件 */ }
  return null;
}
function _savePersisted(result) {
  try {
    if (!fs.existsSync(_PERSIST_DIR)) fs.mkdirSync(_PERSIST_DIR, { recursive: true });
    fs.writeFileSync(_PERSIST_FILE, JSON.stringify(result), 'utf8');
  } catch (_e) { /* 忽略写入失败，不影响主流程 */ }
}

async function getMarketTechnical({ force } = {}) {
  const today = localDate();
  const now = Date.now();
  // 20261016 审计修复：回退数据（fallback）只给 2 分钟短 TTL——否则写进当日内存缓存后，
  // 即使实时抓取已恢复，30min 内仍命中旧缓存，真实数据被延迟最久 30 分钟。
  const effTTL = (_cache.data && _cache.data.fallback) ? 2 * 60 * 1000 : TTL;
  if (!force && _cache.data && _cache.date === today && now - _cache.ts < effTTL) {
    return _cache.data;
  }
  const [idxRes, macroRes] = await Promise.allSettled([
    Promise.all(INDICES.map(analyzeIndex)),
    getMacroNews(false),
  ]);
  const indices = idxRes.status === 'fulfilled' ? idxRes.value : [];
  const macro = macroRes.status === 'fulfilled' ? macroRes.value : null;
  const ext = gaugeExternal(macro);
  const fused = synthesizeFused(indices, ext);
  const result = {
    success: indices.some(x => !x.error),
    date: indices[0] && indices[0].date ? indices[0].date : today,
    updatedAt: new Date().toISOString(),
    indices,
    synthesis: synthesize(indices),
    fused,
    source: '技术面：腾讯行情 K 线（日/周/月/30分，前复权）；外部变量：东方财富 7×24 宏观快讯（lib/macroNews 国际宏观）。',
  };
  // 有效结果：写内存缓存 + 持久化到磁盘（休息日/抓取失败时的回退底座）
  if (indices.some(x => !x.error)) {
    _cache = { ts: now, date: today, data: result };
    _savePersisted(result);
    return result;
  }
  // 抓取为空（数据不足/瞬时失败/休市）：回退到磁盘持久化的最近交易日结果
  const persisted = _loadPersisted();
  if (persisted) {
    const fb = Object.assign({}, persisted, {
      fallback: true,
      fallbackNote: '实时行情抓取为空，已回退至最近一个有效交易日（' + persisted.date + '）的缓存数据。',
    });
    _cache = { ts: now, date: today, data: fb };
    return fb;
  }
  // 无任何可用数据：如实返回「不可用」，但绝不写入内存缓存（避免空白污染）
  return result;
}

module.exports = { getMarketTechnical, analyzeIndex, INDICES, fetchIndexDailyBars, computeMarketVolumeMetrics };

~~~

---

## `lib\metricAnalysis.js`  ·  626 行

~~~js
/**
 * lib/metricAnalysis.js — 「指标分析」确定性引擎（20260919a）
 *
 * 替代原「分析师评级」模块。对个股页左侧「关键财务指标」做确定性五维对比：
 *   ① 同比（去年同期同报告期）② 环比（较上一披露期，累计口径标注）
 *   ③ 行业均值对比 ④ 历史百分位对比 ⑤ 边际变化（趋势/加速·减速）
 * 并给出「判定依据」——20261103d 起按「五维多数决」出总体判定（可用维度≥2 时多数方向为准，
 * 与 evaluateSignals 信号冲突时显式标注并以多数决为准），左卡徽标/顶栏着色同步消费同一 judgment。
 *
 * 设计原则（承接 stock-analyzer 铁律）：
 *   - 全部为确定性代码计算，不做任何 LLM 估算；
 *   - 缺数据的维度如实标注「不可得」，绝不编造数值；
 *   - 五维取数与左侧「关键财务指标」卡、深度分析同数据源（quote.fundamentals / zyzbHistory / comparison）。
 *
 * ★ 20260923l 三项修复（用户反馈「左卡与右卡顺序不对应 + 右卡漏扣非净利润」）：
 *   1) **单一权威顺序**：新增 `METRIC_ORDER`，与左卡「关键财务指标」(`public/js/app.js` 的 rows 数组)
 *      逐项对齐（估值前置）。前端 `renderMetricAnalysis` 只按数组顺序渲染、不排序，
 *      所以**改这里的顺序就等于同时改两边**——以后两卡顺序必须由本常量唯一决定。
 *      ⚠️ 改 `METRIC_ORDER` 时**必须同步改** `public/js/app.js` 的 `rows` 数组（14 项、顺序一致），
 *         否则两卡再次错位；这属展示结构变化 → 需手动升 `LAYOUT_VERSION` 强制重算当日判断缓存。
 *   2) **修「扣非净利润增长」死代码**：旧代码读 `f.deductedProfitGrowth`（= quote.fundamentals），
 *      但该字段唯一生产点是 lib/fundamentalScore.js 的 `result.metrics.deductedProfitGrowth`
 *      （= `m` / fundamental.metrics），导致恒为 undefined、该项**对所有股票都永不渲染**。
 *      现统一走 `val()` 双源取值，并**无条件构建**（两卡项数保持一致）。
 *   3) **补 PEG**：左卡有 PEG、右卡原先完全没有 → 补上第 14 项，使两卡一一对应。
 *      当前数据源未提供 PEG 字段 → 如实标注不可得，不做估算。
 *   4) **统一 0 与 `--` 的口径**：生产端（stockData.js:1319-1332 / analysis.js:741 /
 *      fundamentalScore.js:290,312）用 `|| 0` 兜底，使「取不到」与「真实 0」不可区分。
 *      对 `ZERO_AS_MISSING` 列出的比率类字段，0 一律判为「数据缺失」→ 显示 `--`、维度标不可得
 *      （此前右卡对券商毛利率会输出无依据的「0.0%」，而左卡显示 `--`，两卡自相矛盾）。
 *   5) **统一小数位（20260923n）**：右卡原为「估值 2 位、其余 1 位」的混合精度，左卡整表统一 2 位
 *      → 同一指标两卡读数看着不同（如左卡 `123.28%` vs 右卡 `123.3%`）。现右卡所有百分比/增速/倍数
 *      一律 `toFixed(2)`，与左卡逐项一致。⚠️ 改精度时左卡（public/js/app.js rows）与本文 `valueText`/
 *      维度文案要同步；左卡 `行业均值` 亦为 2 位（app.js 的 `Number(ind[...]).toFixed(2)`）。
 */
'use strict';

const { getGrowthCaliber, growthCaliberLabel, orderedYoYFields } = require('./growthCaliber'); // 20261104b 增长口径一键切换

// ===== 单一权威顺序（20260923l；20261029a 扩至 16 项）=====
// ⚠️ 必须与左卡「关键财务指标」(`public/js/app.js` 的 rows 数组) 完全一致、同序。
// 估值 → 盈利 → 成长（+ 营运利润/NBV 20261029a）→ 偿债/现金流，与用户熟悉的左卡阅读顺序一致。
const METRIC_ORDER = [
  'pe', 'pb', 'ps', 'peg',
  'roe', 'grossMargin', 'netMargin',
  'growth', 'profitGrowth', 'dedProfitGrowth', 'opProfit', 'nbv',
  'debt', 'currentRatio', 'div', 'ocf',
];

// ===== 0 值哨兵（20260923l）=====
// 生产端以 `|| 0` / `!= null ? x : 0` 兜底 → 0 既可能是「真实值」也可能是「取不到」。
// 下列字段的 0 在实务上**不是可信数值**（估值 PE/PB/PS 为 0 不可能、券商/银行无毛利率概念、
// 0% 增长、0 负债率、0 流动比率、0 股息率）→ 统一判为「数据缺失」：显示 `--` 且五维标不可得，
// 绝不把兜底 0 当数据展示（项目铁律：缺数据如实标注「不可得」，绝不编造数值）。
// ⚠️ 已核实这些字段的生产端都会用 0 兜底：stockData.js:1319-1332（roe/grossMargin/netMargin/
//    revenueYoy/profitYoy/debtToEquity/currentRatio）、analysis.js:741,767,795、
//    fundamentalScore.js:290,312,313 —— 故 0 与「真实 0」不可区分，按缺失处理更诚实。
// ⚠️ 左卡（public/js/app.js 的 rows）对这些字段同样用「真值判定」（0 → `--`），两边口径一致；
//    改本集合时**必须同步改左卡对应行的判定写法**，否则两卡又会不一致。
const ZERO_AS_MISSING = new Set([
  'pe', 'pb', 'ps',
  'roe', 'grossMargin', 'netMargin',
  'growth', 'profitGrowth', 'dedProfitGrowth',
  'debt', 'currentRatio', 'div', 'ocf', 'peg',
]);

// 是否属于「兜底 0」哨兵
function isSentinel(v, key) {
  return v === 0 && ZERO_AS_MISSING.has(key);
}
// 归一：缺失 / 非数值 / 兜底 0 → null
function norm(v, key) {
  const n = (typeof v === 'number') ? v : parseFloat(v);
  if (!isFinite(n)) return null;
  return isSentinel(n, key) ? null : n;
}

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 同比：取最新披露期 vs 去年同期同一报告期（REPORT_DATE 年份-1 精确匹配，避免跨期误比）。
// 20261102a（用户指令：增长指标优先最新单季口径）：fields 支持数组（逐行按序取首个非空值）——
// 增长类优先 DJD_*_YOY（东财主要指标自带单季同比），缺失回退累计口径 *_TZ；比率/水平类仍传单一字段。
function samePeriodPair(zy, fields) {
  const fl = Array.isArray(fields) ? fields : [fields];
  const pickV = (row) => { if (!row) return null; for (const k of fl) { const n = toNum(row[k]); if (n != null) return n; } return null; };
  if (!Array.isArray(zy) || !zy.length) return { cur: null, prev: null };
  const latest = zy[0];
  const ld = String(latest.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return { cur: pickV(latest), prev: null };
  const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
  const prev = zy.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt);
  return { cur: pickV(latest), prev: prev != null ? pickV(prev) : null };
}

// 环比：取最新披露期 vs 上一相邻披露期（zyzbHistory 降序，zy[0] vs zy[1]）
function consecutivePair(zy, field) {
  if (!Array.isArray(zy) || zy.length < 2) return { cur: null, prev: null };
  return { cur: toNum(zy[0][field]), prev: toNum(zy[1][field]) };
}

// 方向信号：delta 在「有利方向」上为 bull，相反为 bear，近零为 neutral
function deltaSignal(delta, higherBetter) {
  if (delta == null) return null;
  if (Math.abs(delta) < 0.05) return 'neutral';
  return (delta > 0) === higherBetter ? 'bull' : 'bear';
}

// 维度：缺失
function na(text) { return { available: false, text: text || '不可得', signal: null }; }
// 维度：可用
function ok(text, signal) { return { available: true, text, signal: signal || null }; }

// ===== 五维多数决（20261103d，用户指令：五维中多数方向 = 指标总体判定）=====
// 规则：统计 dims 中 available 且带 signal 的维度票数（利好/利空/中性）；
//   利空票 > 利好票 → 利空；利好票 > 利空票 → 利好；持平 → 中性；
//   可用维度 < 2 时数据不足以投票 → 沿用原判定（fallback，即 evaluateSignals 信号）。
// 与原判定冲突时显式标注「已按多数决为准」并保留原判定依据——绝不静默改判。
// ===== 五维多数决 v2：水平锚定（20261104a，用户指令：便宜股/稳健指标因历史百分位口径被误判为利空）=====
// v1（20261103d）两处缺陷（六只自选股实测）：
//   ① 「水平判定」（绝对水平好坏，来自 evaluateSignals）不参与投票，而变化维度
//      （同比/环比/历史百分位/边际）最多 4 票且高度同源（均来自同一历史序列的近期变化），
//      绝对水平健康但边际走弱的稳健指标被变化票洪流覆盖成利空——
//      实测：圣湘负债率 26.4%（稳健）被判利空、万润 29.4% 同、海天/万润/圣湘流动比率
//      2.2~4.5（偿债能力强）被判利空、圣湘毛利率 72.3% / 海天净利率 23.8% 同理；
//   ② 计票忽略中性票数（bear 1 票可压 neutral 2 票直接判 bear）。
// v2 规则（全部确定性，代码执行）：
//   1) 水平票 lv = 原判定 signal，参与计票（水平是锚，回答「绝对好坏」）；
//   2) 变化维度（yoy/qoq/pct/marginal）信号与 lv 相反 → 降级为 neutral（水平锚定：
//      「绝对水平健康但边际走弱」不投利空票，反之亦然），降级数在 reason 显式标注；
//      industry 是横向水平对比（非变化维度）不降级；
//   3) 成长类指标（CHANGE_INHERENT_KEYS：指标值本身就是变化量，如营收增速 %）不锚定，
//      20261103d「三项利空维度 → 总体利空」规则对成长类原样保留；
//   4) 计票后：neutral 需严格多于方向票最大者才单独定中性；否则方向票多者胜；
//      方向票平票 → 以 lv 兜底（lv 不可得 → neutral）；
//   5) 可用票（含 lv）<2 → 沿用原判定不投票；
//   6) 与原判定不一致时 reason 显式标注并保留原判定依据（绝不静默改判）。
const VOTE_CHANGE_DIMS = ['yoy', 'qoq', 'pct', 'marginal'];
const CHANGE_INHERENT_KEYS = new Set(['growth', 'profitGrowth', 'dedProfitGrowth', 'opProfit']);
function dimsVote(dims, fallback, opts) {
  const d = dims || {};
  const fb = fallback || { signal: 'neutral', reason: '数据不足，无法判定' };
  const lv = fb.signal || 'neutral';
  const anchorOn = !(opts && opts.anchorChange === false);
  let bull = 0, bear = 0, neutral = 0, anchored = 0;
  // 水平票入局
  if (lv === 'bull') bull++; else if (lv === 'bear') bear++; else neutral++;
  for (const k of ['yoy', 'qoq', 'industry', 'pct', 'marginal']) {
    const dim = d[k];
    if (!dim || !dim.available || !dim.signal) continue;
    let sig = dim.signal;
    // 水平锚定：变化维度与水平信号方向相反 → 降级为中性票
    if (anchorOn && sig !== 'neutral' && sig !== lv && lv !== 'neutral' && VOTE_CHANGE_DIMS.indexOf(k) >= 0) {
      sig = 'neutral'; anchored++;
    }
    if (sig === 'bull') bull++;
    else if (sig === 'bear') bear++;
    else neutral++;
  }
  const votes = bull + bear + neutral;
  if (votes < 2) return { judgment: fb, conflict: false, votes: null };
  const max3 = Math.max(bull, bear, neutral);
  let signal;
  if (neutral === max3 && neutral > bull && neutral > bear) signal = 'neutral';
  else if (bull > bear) signal = 'bull';
  else if (bear > bull) signal = 'bear';
  else signal = lv; // 方向票平票 → 水平锚兜底
  if (signal === lv) {
    if (!anchored) return { judgment: fb, conflict: false, votes: { bull, bear, neutral, anchored } };
    return { judgment: { signal, reason: `${fb.reason || '—'}（${anchored} 项变化维度与水平锚相反，不改变方向判定）` }, conflict: false, votes: { bull, bear, neutral, anchored } };
  }
  const label = { bull: '利好', bear: '利空', neutral: '中性' };
  const anchorNote = anchored ? `，其中 ${anchored} 项变化维度与水平锚相反已降级中性` : '';
  const reason = `五维多数决·水平锚定（${bull}利好/${bear}利空/${neutral}中性${anchorNote}）判为${label[signal]}，与信号判定（${label[lv]}）不一致——已按多数决为准。原判定依据：${fb.reason || '—'}`;
  return { judgment: { signal, reason }, conflict: true, votes: { bull, bear, neutral, anchored } };
}

// ===== 单季值差分（20261103d，用户指令：环比无法从财报直接获得时，用季报累计值本机计算并标注）=====
// zyzbHistory 的绝对额字段（TOTALOPERATEREVE / PARENTNETPROFIT / KCFJCXSYJLR，元）为**累计口径**。
// 单季 = 本期累计 − 上期累计（同一年度内相邻报告期；Q1 单季 = 累计本身；Q4 单季 = FY − 9M）。
// 返回按报告期降序的 [{ date, sq }]，sq=null 表示该期缺上期累计无法差分。
function sqSeries(zy, field) {
  if (!Array.isArray(zy) || !zy.length) return [];
  const rows = [];
  for (const r of zy) {
    const date = String(r.REPORT_DATE || '').slice(0, 10);
    const cum = toNum(r[field]);
    if (/^\d{4}-\d{2}-\d{2}/.test(date) && cum != null) rows.push({ date, cum });
  }
  const byYear = {};
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    (byYear[y] = byYear[y] || []).push(r);
  }
  const out = [];
  for (const y of Object.keys(byYear)) {
    const chain = byYear[y].slice().sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < chain.length; i++) {
      const cur = chain[i];
      const isQ1 = cur.date.slice(5, 7) === '03';
      const prevCum = i > 0 ? chain[i - 1].cum : null;
      const sq = isQ1 ? cur.cum : (prevCum != null ? cur.cum - prevCum : null);
      out.push({ date: cur.date, sq });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// 成长类指标的环比维度（20261103d）：增长率本身为同比口径，但「单季绝对额环比增速」
// 可由季报累计值差分**本机计算**（非财报直供，标注「本机计算」）；跨年相邻季含季节性，如实提示。
function sqQoqDim(zy, cumField) {
  const s = sqSeries(zy, cumField).filter(x => x.sq != null);
  if (s.length < 2) return na('不可得（累计值不足两期，无法差分单季）');
  const cur = s[0], prev = s[1];
  if (prev.sq === 0) return na('不可得（上季单季为 0，环比不可比）');
  const pct = (cur.sq - prev.sq) / Math.abs(prev.sq) * 100;
  const sig = pct > 0.5 ? 'bull' : pct < -0.5 ? 'bear' : 'neutral';
  const crossYear = cur.date.slice(0, 4) !== prev.date.slice(0, 4);
  const yi = (v) => (v / 1e8).toFixed(2) + '亿';
  return ok(`单季环比 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%（${cur.date} 单季 ${yi(cur.sq)} vs ${prev.date} 单季 ${yi(prev.sq)}；季报累计值差分·本机计算${crossYear ? '·跨年相邻季含季节性' : ''}）`, sig);
}

// 同比维度（水平型指标：ROE/毛利率/净利率/负债率/流动比率/股息率）
// 20261029i 格式统一（用户指令）：全部对齐图二「本报告期 X（去年同期 Y，边际 ±Z）」三段式；
// 百分比口径的差值单位用 pp（避免「-4.54%」与增长率%混淆），非百分比口径（如流动比率）用原单位。
function yoyDim(cur, prev, higherBetter, unit) {
  if (cur == null) return na('不可得');
  const du = (unit === '%') ? 'pp' : unit;
  if (prev == null) return ok(`本报告期 ${cur.toFixed(2)}${unit}（缺去年同期对比）`, null);
  const delta = cur - prev;
  const sig = deltaSignal(delta, higherBetter);
  const dir = delta >= 0 ? '+' : '';
  return ok(`本报告期 ${cur.toFixed(2)}${unit}（去年同期 ${prev.toFixed(2)}${unit}，边际 ${dir}${delta.toFixed(2)}${du}）`, sig);
}

// 环比维度（较上一披露期，累计口径标注）
function qoqDim(cur, prev, higherBetter, unit) {
  if (cur == null) return na('不可得');
  if (prev == null) return ok(`${cur.toFixed(2)}${unit}（缺上一披露期，无法比较）`, null);
  const delta = cur - prev;
  const sig = deltaSignal(delta, higherBetter);
  const dir = delta >= 0 ? '+' : '';
  const du = (unit === '%') ? 'pp' : unit;
  // ★ 20261029i 修复：旧文案硬编码「%」→ 流动比率（unit=''）被显示成「4.54% vs 4.88%」（单位错误）
  return ok(`环比(较上一披露期·累计口径) ${dir}${delta.toFixed(2)}${du}（${cur.toFixed(2)}${unit} vs ${prev.toFixed(2)}${unit}）`, sig);
}

// 行业均值维度
function industryDim(cur, indVal, higherBetter, unit) {
  if (indVal == null || cur == null) return na('不可得（无行业均值）');
  const ratio = cur / indVal;
  let sig;
  if (higherBetter) sig = ratio >= 1.1 ? 'bull' : ratio <= 0.9 ? 'bear' : 'neutral';
  else sig = ratio <= 0.9 ? 'bull' : ratio >= 1.1 ? 'bear' : 'neutral';
  const relTxt = ratio >= 1 ? `高 ${ratio.toFixed(2)}×` : `低 ${(1 / ratio).toFixed(2)}×`;
  return ok(`行业均值 ${indVal.toFixed(2)}${unit}，相对${relTxt}`, sig);
}

// 历史百分位维度
function pctDim(p, higherBetter) {
  if (p == null) return na('不可得');
  let sig;
  if (higherBetter) sig = p >= 80 ? 'bull' : p <= 20 ? 'bear' : 'neutral';
  else sig = p <= 20 ? 'bull' : p >= 80 ? 'bear' : 'neutral';
  return ok(`处自身历史 ${p}% 分位`, sig);
}

// 边际变化维度（水平型：综合同比+环比方向）
function marginalLevelDim(yoy, qoq) {
  const ys = yoy.signal, qs = qoq.signal;
  if (ys == null && qs == null) return na('不可得');
  if (ys === 'bull' && qs === 'bull') return ok('同比/环比同步改善，趋势向上', 'bull');
  if (ys === 'bear' && qs === 'bear') return ok('同比/环比同步走弱，趋势向下', 'bear');
  if (ys === 'bull' && qs !== 'bull') return ok('同比改善，但近期环比未同步走强，持续性待观察', 'neutral');
  if (ys === 'bear' && qs === 'bull') return ok('同比仍弱，但环比已转正，边际企稳', 'neutral');
  if (ys === 'neutral' && qs === 'bull') return ok('同比持平、环比改善', 'neutral');
  if (ys === 'neutral' && qs === 'bear') return ok('同比持平、环比走弱', 'neutral');
  return ok('趋势平稳', 'neutral');
}

/**
 * 构建指标分析
 * @param {object} quote 行情对象（含 .fundamentals）
 * @param {object} comparison buildFundamentalComparison 结果（含 .percentiles / .industryAvg）
 * @param {object} companyType 公司类型（含 .isFinancial）
 * @param {Array} signals evaluateSignals 输出 signal 数组（提供权威判定依据）
 * @param {object} fundamental fundamentalAnalysis 结果（含 .metrics，与左侧「关键财务指标」卡同源）
 * @param {object|null} opProfit 20261029a：fetchOpProfitSnippet 结果（{cur,prev,yoyPct}），null=取不到→整行不渲染
 * @param {object|null} insuranceNBV 20261029a：latestNbvSnapshot 结果（仅保险股非 null）
 */
function buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, opProfit, insuranceNBV) {
  const f = (quote && quote.fundamentals) || {};
  const m = (fundamental && fundamental.metrics) || {};
  const comp = comparison || {};
  const pct = comp.percentiles || {};
  const ind = comp.industryAvg || {};
  const zyzb = Array.isArray(f.zyzbHistory) ? f.zyzbHistory : [];
  const isFinancial = !!(companyType && companyType.isFinancial);

  // 双源取值（20260923l 修正）：quote.fundamentals（f）优先 → fundamental.metrics（m，与左卡同源）兜底。
  // `key` 为上表所用的指标键，用于识别「兜底 0」哨兵并**穿透到另一源**继续找真实值，
  // 避免 f 里的哨兵 0 把 m 里的真实值挡住（旧版 val 只看 `!= null`，0 会被误当有效值）。
  const val = (fk, mk, key) => {
    const k = key || fk;
    const a = f[fk];
    if (a != null && !isSentinel(a, k)) return a;
    const b = m[mk];
    if (b != null && !isSentinel(b, k)) return b;
    return null;
  };

  const sigMap = {};
  (Array.isArray(signals) ? signals : []).forEach(s => { sigMap[s.key] = s; });

  // 收集容器：先按 key 收，最后按 METRIC_ORDER 统一输出（保证两卡顺序一致，且与 push 先后解耦）
  const collected = new Map();
  const metrics = { push: (mm) => { if (mm && mm.key) collected.set(mm.key, mm); } };

  // —— 估值指标（lowerBetter = false：估值越低越好）——
  const buildVal = (key, label, cur, indKey, pctKey) => {
    const c = norm(cur, key);
    const curText = c != null ? c.toFixed(2) : '--';
    metrics.push({
      key, label, valueText: curText, unit: '×',
      dims: {
        yoy: na('—（估值随行情每日变动，无同比口径）'),
        qoq: na('—（随行情实时变动）'),
        industry: industryDim(c, ind[indKey], false, '×'),
        pct: pctDim(pct[pctKey], false),
        marginal: na('—（随行情实时变动）'),
      },
      judgment: sigMap[key] || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  };
  buildVal('pe', '市盈率(PE·TTM)', val('pe', 'pe', 'pe'), 'pe', 'pe');
  buildVal('pb', '市净率(PB)', val('pb', 'pb', 'pb'), 'pb', 'pb');
  // PS 标签与左卡保持一字不差：左卡在 psSource 含 'PS_TTM' 时显示「市销率(PS·TTM)」，否则「市销率(PS)」
  buildVal('ps', (f.psSource && String(f.psSource).indexOf('PS_TTM') >= 0) ? '市销率(PS·TTM)' : '市销率(PS)', val('ps', 'ps', 'ps'), 'ps', 'ps');
  // PEG（20260923l 新增）：左卡有此项、右卡原先缺失 → 补上以保持两卡一一对应。
  // ⚠️ 当前行情/财报数据源均未提供 PEG 字段（fundamentalScore 用 `num(f.peg) || 0` 兜底），
  //    按项目铁律「不做估算」→ 如实标注不可得，绝不输出推算值。
  {
    const c = norm(val('peg', 'peg', 'peg'), 'peg');
    metrics.push({
      key: 'peg', label: 'PEG', valueText: (c != null && c > 0) ? c.toFixed(2) : '--', unit: '×',
      dims: {
        yoy: na('不可得（数据源未提供 PEG）'),
        qoq: na('不可得（数据源未提供 PEG）'),
        industry: na('不可得（无行业 PEG 均值）'),
        pct: na('不可得（无 PEG 历史序列）'),
        marginal: na('不可得（数据源未提供 PEG）'),
      },
      judgment: sigMap.peg || { signal: 'neutral', reason: 'PEG 数据源未提供，本工具不做估算' },
    });
  }

  // —— 水平型盈利能力/质量指标（higherBetter = true）——
  // ROE
  // ★ 20261104k：环比维度改为 TTM 同口径优先（roeTtmPrevQ，20261104k 新增），与毛利率/净利率同口径排查；
  //   roeTtmPrevQ 不可得时回退累计口径 ROEJQ（qoqDim 原范式）。
  {
    const cur = norm(val('roeTtm', 'roe', 'roe'), 'roe');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const roePrevTtm = (typeof f.roeTtmPrev === 'number' && !isSentinel(f.roeTtmPrev, 'roe')) ? f.roeTtmPrev : null;
    const roePrevQ = (typeof f.roeTtmPrevQ === 'number' && !isSentinel(f.roeTtmPrevQ, 'roe')) ? f.roeTtmPrevQ : null;
    const yoy = (cur != null && roePrevTtm != null)
      ? (() => { const d = cur - roePrevTtm; return ok(`本报告期 ${cur.toFixed(2)}%（去年同期 ${roePrevTtm.toFixed(2)}%，边际 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp；TTM 同口径）`, deltaSignal(d, true)); })()
      : yoyDim(norm(samePeriodPair(zyzb, 'ROEJQ').cur, 'roe'), norm(samePeriodPair(zyzb, 'ROEJQ').prev, 'roe'), true, '%');
    const qoq = (cur != null && roePrevQ != null)
      ? (() => { const d = cur - roePrevQ; return ok(`近12个月环比 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp（${cur.toFixed(2)}% vs 上一报告期TTM ${roePrevQ.toFixed(2)}%；TTM 同口径）`, deltaSignal(d, true)); })()
      : qoqDim(norm(consecutivePair(zyzb, 'ROEJQ').cur, 'roe'), norm(consecutivePair(zyzb, 'ROEJQ').prev, 'roe'), true, '%');
    metrics.push({
      key: 'roe', label: 'ROE', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: industryDim(cur, ind.roe, true, '%'), pct: pctDim(pct.roe, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.roe || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 毛利率
  // ★ 20261104k（用户报障「左卡 TTM 37.78% vs 右卡同比 41.47% 口径不一致」）：同比/环比维度改为
  //   TTM 同口径优先（grossMarginTtmPrev / grossMarginTtmPrevQ，与左卡主值同一权威源 computeTtmMetrics），
  //   复刻 ROE roeTtmPrev 范式；TTM prev 不可得时回退报告期累计口径并保留 yoyDim/qoqDim 原标注。
  {
    const cur = norm(val('grossMarginTtm', 'grossMargin', 'grossMargin'), 'grossMargin');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const gmPrevTtm = (typeof f.grossMarginTtmPrev === 'number' && !isSentinel(f.grossMarginTtmPrev, 'grossMargin')) ? f.grossMarginTtmPrev : null;
    const gmPrevQ = (typeof f.grossMarginTtmPrevQ === 'number' && !isSentinel(f.grossMarginTtmPrevQ, 'grossMargin')) ? f.grossMarginTtmPrevQ : null;
    const yoy = (cur != null && gmPrevTtm != null)
      ? (() => { const d = cur - gmPrevTtm; return ok(`本报告期 ${cur.toFixed(2)}%（去年同期TTM ${gmPrevTtm.toFixed(2)}%，边际 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp；TTM 同口径）`, deltaSignal(d, true)); })()
      : yoyDim(norm(samePeriodPair(zyzb, 'XSMLL').cur, 'grossMargin'), norm(samePeriodPair(zyzb, 'XSMLL').prev, 'grossMargin'), true, '%');
    const qoq = (cur != null && gmPrevQ != null)
      ? (() => { const d = cur - gmPrevQ; return ok(`近12个月环比 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp（${cur.toFixed(2)}% vs 上一报告期TTM ${gmPrevQ.toFixed(2)}%；TTM 同口径）`, deltaSignal(d, true)); })()
      : qoqDim(norm(consecutivePair(zyzb, 'XSMLL').cur, 'grossMargin'), norm(consecutivePair(zyzb, 'XSMLL').prev, 'grossMargin'), true, '%');
    metrics.push({
      key: 'grossMargin', label: '毛利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业毛利率均值）'), pct: pctDim(pct.grossMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.grossMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
      note: '口径说明：本卡主值与同比/环比维度均为 TTM 滚动口径（近12个月毛利÷近12个月营收），与左卡数值完全一致；「去年同期/上一报告期」对比值同为 TTM 同口径滚动。仅行业均值/历史百分位维度如有差异见对应标注。',
    });
  }
  // 净利率（20261104k：与毛利率同口径排查——TTM 同口径优先，同上）
  {
    const cur = norm(val('netMarginTtm', 'netMargin', 'netMargin'), 'netMargin');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const nmPrevTtm = (typeof f.netMarginTtmPrev === 'number' && !isSentinel(f.netMarginTtmPrev, 'netMargin')) ? f.netMarginTtmPrev : null;
    const nmPrevQ = (typeof f.netMarginTtmPrevQ === 'number' && !isSentinel(f.netMarginTtmPrevQ, 'netMargin')) ? f.netMarginTtmPrevQ : null;
    const yoy = (cur != null && nmPrevTtm != null)
      ? (() => { const d = cur - nmPrevTtm; return ok(`本报告期 ${cur.toFixed(2)}%（去年同期TTM ${nmPrevTtm.toFixed(2)}%，边际 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp；TTM 同口径）`, deltaSignal(d, true)); })()
      : yoyDim(norm(samePeriodPair(zyzb, 'XSJLL').cur, 'netMargin'), norm(samePeriodPair(zyzb, 'XSJLL').prev, 'netMargin'), true, '%');
    const qoq = (cur != null && nmPrevQ != null)
      ? (() => { const d = cur - nmPrevQ; return ok(`近12个月环比 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp（${cur.toFixed(2)}% vs 上一报告期TTM ${nmPrevQ.toFixed(2)}%；TTM 同口径）`, deltaSignal(d, true)); })()
      : qoqDim(norm(consecutivePair(zyzb, 'XSJLL').cur, 'netMargin'), norm(consecutivePair(zyzb, 'XSJLL').prev, 'netMargin'), true, '%');
    metrics.push({
      key: 'netMargin', label: '净利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业净利率均值）'), pct: pctDim(pct.netMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.netMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
      note: '口径说明：本卡主值与同比/环比维度均为 TTM 滚动口径（近12个月净利÷近12个月营收），与左卡数值完全一致；「去年同期/上一报告期」对比值同为 TTM 同口径滚动。仅行业均值/历史百分位维度如有差异见对应标注。',
    });
  }

  // —— 成长指标（值本身为同比 %）——
  // 20261103d：新增 cumField 参数（累计绝对额字段）——环比维度改为「单季绝对额环比增速」
  // （季报累计值差分·本机计算，替代原「环比不适用」占位；用户指令：环比无法直供时本机计算并标注）。
  const buildGrowth = (key, label, cur, pctKey, field, cumField) => {
    // 20261104b（用户指令：单季/累计一键切换）：同比取数字段按口径重排；主值也随口径取数
    // （zyzb 序列口径值优先，快照 f.revenueYoy/profitYoy（DJD 优先落库）兜底），与左卡/信号判定同口径。
    const of = orderedYoYFields(field);
    const calTx = growthCaliberLabel();
    const pair = samePeriodPair(zyzb, of);
    const c = (pair.cur != null) ? norm(pair.cur, key) : norm(cur, key);
    const curText = c != null ? c.toFixed(2) + '%' : '--';
    const prev = norm(pair.prev, key);
    let yoy, marginal;
    if (c == null) { yoy = na('不可得'); marginal = na('不可得'); }
    else if (prev == null) {
      yoy = ok(`本报告期(${calTx}) ${c.toFixed(2)}%（缺去年同期对比）`, c > 0 ? 'bull' : c < 0 ? 'bear' : 'neutral');
      marginal = ok(c > 0 ? '正增长' : '负增长', c > 0 ? 'bull' : 'bear');
    } else {
      const dpp = c - prev;
      const sig = dpp > 0.5 ? 'bull' : dpp < -0.5 ? 'bear' : 'neutral';
      yoy = ok(`本报告期(${calTx}) ${c.toFixed(2)}%（去年同期 ${prev.toFixed(2)}%，边际 ${dpp >= 0 ? '+' : ''}${dpp.toFixed(2)}pp）`, sig);
      marginal = ok(`增速同比${dpp > 0 ? '加速' : '放缓'} ${Math.abs(dpp).toFixed(2)}pp`, sig);
    }
    metrics.push({
      key, label, valueText: curText, unit: '%',
      dims: { yoy, qoq: cumField ? sqQoqDim(zyzb, cumField) : na('不可得（无累计值字段，无法差分单季）'), industry: na('不可得（无行业增速均值）'), pct: pctKey ? pctDim(pct[pctKey], true) : na('不可得（无增速历史百分位）'), marginal },
      judgment: sigMap[key] || { signal: 'neutral', reason: '数据不足，无法判定' },
      note: `口径说明：① 当前增长口径为「${calTx}」（20261102a 默认单季优先；20261104b 起可在左卡「关键财务指标」卡头一键切换 单季↔累计）——同比主值/去年同期/历史百分位序列/信号判定/左卡数值全链路同口径，组内单季↔累计自动回退。② 环比维度始终为「单季绝对额环比增速」（20261103d 起）：由季报累计值差分出单季（单季=本期累计−上期累计，Q1=累计）后本机计算，非财报直供，不随口径切换；单季环比存在季节性（跨年相邻季尤甚），参考即可。`,
    });
  };
  buildGrowth('growth', '营收增长', val('revenueYoy', 'revenueGrowth', 'growth'), 'revenueGrowth', ['DJD_TOI_YOY', 'TOTALOPERATEREVETZ'], 'TOTALOPERATEREVE');
  // 20261104k：显示名「利润增长」→「归母净利润」（用户指令：本指标就是归母净利润同比，名称直指口径）
  buildGrowth('profitGrowth', '归母净利润', val('profitYoy', 'profitGrowth', 'profitGrowth'), 'profitGrowth', ['DJD_DPNP_YOY', 'PARENTNETPROFITTZ'], 'PARENTNETPROFIT');
  // ★ 20260923l 修复：旧版 `if (f.deductedProfitGrowth != null)` 读 quote.fundamentals（该键从不写入）
  //   → 该项对所有股票恒不渲染。现改为 val() 双源（真实值在 fundamental.metrics）+ 无条件构建。
  buildGrowth('dedProfitGrowth', '扣非净利润增长', val('deductedProfitGrowth', 'deductedProfitGrowth', 'dedProfitGrowth'), null, ['DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ'], 'KCFJCXSYJLR');

  // ─── 营运利润（20261029a 新增，全个股；数据源 F10 利润表 lrbAjaxNew OPERATE_PROFIT）───
  // 绝对额指标（亿）。20261102a（用户指令）：优先「单季」口径（sqCur = 本期累计 − 上期累计；Q1 单季=累计），
  // 上期累计缺失导致单季不可得时回退累计并如实标注；判定为确定性代码按同比符号给出（非 LLM）。
  // opProfit 为 null（利润表取不到/缺科目）→ 整行不渲染（左右两卡一致），绝不编造。
  if (opProfit && opProfit.cur && typeof opProfit.cur.opProfitYi === 'number') {
    const useSq = !!(opProfit.sqCur && typeof opProfit.sqCur.opProfitYi === 'number');
    const curYi = useSq ? opProfit.sqCur.opProfitYi : opProfit.cur.opProfitYi;
    const prevObj = useSq ? opProfit.sqPrev : opProfit.prev;
    const prevYi = (prevObj && typeof prevObj.opProfitYi === 'number') ? prevObj.opProfitYi : null;
    const yoyPct = useSq
      ? ((typeof opProfit.sqYoyPct === 'number') ? opProfit.sqYoyPct : null)
      : ((typeof opProfit.yoyPct === 'number') ? opProfit.yoyPct : null);
    const calTx = useSq ? '单季' : '累计（单季值不可得，缺上期累计，如实回退）';
    const sig = (yoyPct == null) ? null : (yoyPct > 0.5 ? 'bull' : yoyPct < -0.5 ? 'bear' : 'neutral');
    const dir = (yoyPct != null && yoyPct >= 0) ? '+' : '';
    // 20261029i 格式统一（图二三段式）：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）；同比%移入边际维度
    const dYi = (prevYi != null) ? curYi - prevYi : null;
    const yoy = (yoyPct != null && prevYi != null)
      ? ok(`本报告期(${calTx}) ${curYi.toFixed(2)}亿（去年同期 ${prevYi.toFixed(2)}亿，边际 ${dYi >= 0 ? '+' : ''}${dYi.toFixed(2)}亿）`, sig)
      : (prevYi == null
        ? ok(`${curYi.toFixed(2)}亿（缺去年同期，无法比较）`, null)
        : na('不可得（去年同期为负/零，同比不可比）'));
    metrics.push({
      key: 'opProfit', label: '营运利润', valueText: curYi.toFixed(2) + '亿', unit: '亿',
      dims: {
        yoy,
        qoq: na('—（报告期累计口径，跨阶段环比不可比）'),
        industry: na('不可得（无行业营业利润均值）'),
        pct: na('不可得（无历史序列）'),
        marginal: (yoyPct != null) ? ok(`同比 ${dir}${yoyPct.toFixed(2)}%，同比${yoyPct > 0 ? '增长' : yoyPct < 0 ? '下降' : '持平'}`, sig) : na('不可得'),
      },
      judgment: {
        signal: sig || 'neutral',
        reason: (yoyPct != null)
          ? `营业利润${useSq ? '单季' : '累计'}同比 ${dir}${yoyPct.toFixed(2)}%（${opProfit.cur.date} 报告期，${useSq ? '单季=本期累计−上期累计' : '累计口径'}）`
          : `营业利润 ${curYi.toFixed(2)}亿（${opProfit.cur.date}，${useSq ? '单季' : '累计'}口径，缺同比基数，无法判定方向）`,
      },
      note: '口径说明：本行取自利润表「营业利润」科目（通用会计口径，全个股统一）。20261102a 起「单季优先」——单季值 = 本期累计 − 上期累计（Q1 报告期单季=累计），上期累计缺失时如实回退累计口径。它与「扣非净利润」的区别：① 位置不同——营业利润位于利润表中段（营业收入−营业成本−税金及附加−期间费用+投资收益等），尚未扣除所得税与少数股东损益；扣非净利润位于末端（归母净利润再剔除非经常性损益）。② 含义不同——营业利润看的是经营盘面的整体盈利（含投资收益/公允价值变动/减值等波动项，银行/保险/券商的利息与投资收入都计入其中）；扣非净利润看的是落到归母股东手里的经常性盈利。注：中国平安等公司财报另披露一个非通用口径的「营运利润」（剔除短期投资波动等），本工具不采用该口径。',
    });
  }

  // ─── NBV(新业务价值)（20261029a 新增，保险股专属）───
  // 数据源=INSURANCE_REAL_DATA 备查库（当前仅 601318 有数据）；非保险股 insuranceNBV=null → 整行不渲染。
  // 同比=去年同期同累计阶段（如 2026H1 vs 2025H1），跨阶段不可比。
  if (insuranceNBV && typeof insuranceNBV.valueYi === 'number') {
    const curYi = insuranceNBV.valueYi;
    const yoyPct = (typeof insuranceNBV.yoyPct === 'number') ? insuranceNBV.yoyPct : null;
    const prevYi = (typeof insuranceNBV.prevValueYi === 'number') ? insuranceNBV.prevValueYi : null;
    const sig = (yoyPct == null) ? null : (yoyPct > 0.5 ? 'bull' : yoyPct < -0.5 ? 'bear' : 'neutral');
    const dir = (yoyPct != null && yoyPct >= 0) ? '+' : '';
    // 20261029i 格式统一（图二三段式）：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）；同比%移入边际维度
    const dYi = (prevYi != null) ? curYi - prevYi : null;
    const yoy = (yoyPct != null && prevYi != null)
      ? ok(`本报告期 ${curYi.toFixed(2)}亿（去年同期 ${prevYi.toFixed(2)}亿，边际 ${dYi >= 0 ? '+' : ''}${dYi.toFixed(2)}亿）`, sig)
      : na('不可得（缺去年同期同阶段数据）');
    metrics.push({
      key: 'nbv', label: 'NBV(新业务价值)', valueText: curYi.toFixed(2) + '亿', unit: '亿',
      dims: {
        yoy,
        qoq: na('—（累计口径，跨阶段环比不可比）'),
        industry: na('不可得（无行业 NBV 均值）'),
        pct: na('不可得（无历史百分位）'),
        marginal: (yoyPct != null) ? ok(`同比 ${dir}${yoyPct.toFixed(2)}%，同比${yoyPct > 0 ? '增长' : yoyPct < 0 ? '下降' : '持平'}`, sig) : na('不可得'),
      },
      judgment: {
        signal: sig || 'neutral',
        reason: (yoyPct != null)
          ? `NBV 同比 ${dir}${yoyPct.toFixed(2)}%（${insuranceNBV.periodText} 累计口径，与去年同期同阶段可比）`
          : `NBV ${curYi.toFixed(2)}亿（${insuranceNBV.periodText}，缺同比基数，无法判定方向）`,
      },
      note: `口径说明：NBV（新业务价值）= 新签保单在未来可贡献利润的折现值，是寿险公司「新业务造血能力」的核心指标，为保险股专属（非保险股无此概念，其余财务指标均不适用衡量卖保单的盈利模式）。它衡量的是「未来利润的现值」而非当期现金流，与净利润/扣非净利润口径完全不同。数据来源：${insuranceNBV.source || '备查库'}。${insuranceNBV.assumptionNote || ''}`,
    });
  }

  // —— 偿债/质量指标 ——
  // 资产负债率（lowerBetter = false；金融业高负债为常态，判定由 signals 层处理）
  {
    const cur = norm(val('debtToEquity', 'debtToEquity', 'debt'), 'debt');
    const unit = f.debtMetricPct ? '%' : '';
    const curText = cur != null ? cur.toFixed(2) + unit : '--';
    const yoy = yoyDim(cur, norm(samePeriodPair(zyzb, 'ZCFZL').prev, 'debt'), false, unit);
    const qoq = qoqDim(norm(consecutivePair(zyzb, 'ZCFZL').cur, 'debt'), norm(consecutivePair(zyzb, 'ZCFZL').prev, 'debt'), false, unit);
    metrics.push({
      key: 'debt', label: '资产负债率', valueText: curText, unit,
      dims: { yoy, qoq, industry: na('不可得（无行业负债率均值）'), pct: pctDim(pct.debtToEquity, false), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.debt || { signal: 'neutral', reason: isFinancial ? '金融业高负债为经营常态，不视为利空' : '数据不足，无法判定' },
    });
  }
  // 流动比率（higherBetter = true）
  {
    const cur = norm(val('currentRatio', 'currentRatio', 'currentRatio'), 'currentRatio');
    const curText = cur != null ? cur.toFixed(2) : '--';
    const yoy = yoyDim(cur, norm(samePeriodPair(zyzb, 'LD').prev, 'currentRatio'), true, '');
    const qoq = qoqDim(norm(consecutivePair(zyzb, 'LD').cur, 'currentRatio'), norm(consecutivePair(zyzb, 'LD').prev, 'currentRatio'), true, '');
    metrics.push({
      key: 'currentRatio', label: '流动比率', valueText: curText, unit: '',
      dims: { yoy, qoq, industry: na('不可得（无行业流动比率均值）'), pct: pctDim(pct.currentRatio, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.currentRatio || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 股息率（higherBetter = true；同比用每股股息同比）
  // ⚠️ 'div' 已在 ZERO_AS_MISSING：生产端（fundamentalScore.js:313）同样 `|| 0` 兜底，
  //    无法区分「真 0（不分红）」与「取不到」→ 与左卡 `m.dividendYield ? : '--'` 保持同口径，
  //    0 一律显示 `--`（宁可不显示，也不把兜底 0 当「不分红」事实展示）。
  {
    const cur = norm(val('dividendYield', 'dividendYield', 'div'), 'div');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const dyYoy = typeof f.dividendYoyPct === 'number' ? f.dividendYoyPct : null;
    const yoy = dyYoy != null
      ? ok(`每股股息同比 ${dyYoy >= 0 ? '+' : ''}${dyYoy.toFixed(2)}%`, deltaSignal(dyYoy, true))
      : na('不可得（无分红同比）');
    metrics.push({
      key: 'div', label: '股息率(TTM)', valueText: curText, unit: '%',
      dims: { yoy, qoq: na('—（分红为离散事件，环比不适用）'), industry: na('不可得（无行业股息率均值）'), pct: na('不可得（无股息率历史序列）'), marginal: yoy.available ? ok(dyYoy > 0 ? '分红加码' : '分红缩减', yoy.signal) : na('不可得') },
      judgment: sigMap.div || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 每股经营现金流（higherBetter = true；无同比/行业序列时多标注不可得）
  {
    const cur = norm(val('operatingCashFlowPerShare', 'operatingCashFlowPerShare', 'ocf'), 'ocf');
    const curText = cur != null ? cur.toFixed(2) : '--';
    metrics.push({
      key: 'ocf', label: '每股经营现金流', valueText: curText, unit: '',
      dims: { yoy: na('不可得（无历史序列）'), qoq: na('不可得（无历史序列）'), industry: na('不可得（无行业均值）'), pct: na('不可得'), marginal: na('不可得') },
      judgment: sigMap.ocf || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }

  // ===== 按 METRIC_ORDER 输出（20260923l）：保证与左卡「关键财务指标」逐项同序 =====
  const ordered = [];
  for (const k of METRIC_ORDER) {
    const mm = collected.get(k);
    if (mm) { ordered.push(mm); collected.delete(k); }
  }
  // 防御：若未来新增了指标却忘了登记进 METRIC_ORDER，**不静默丢弃**（追加末尾并告警）
  if (collected.size) {
    console.warn('[metricAnalysis] 以下指标未登记进 METRIC_ORDER，已追加到末尾：', [...collected.keys()].join(', '));
    for (const mm of collected.values()) ordered.push(mm);
  }

  // ===== 五维多数决·水平锚定统一覆盖 judgment（20261103d 多数决 → 20261104a 水平锚定 v2）=====
  // 「判定依据」不再无条件引用 evaluateSignals：可用票（含水平票）≥2 时按多数方向出总体判定。
  // 20261104a 水平锚定：变化维度（同比/环比/历史百分位/边际）与水平信号方向相反 → 降级为中性票，
  // 修复「稳健指标（低负债/高流动比率/高毛利率）因历史分位与同比变化被误判利空」；
  // 成长类指标（营收/利润/扣非增速、营运利润）指标值本身是变化量，不锚定——
  // 20261103d「三项利空维度 → 总体利空」规则对成长类原样保留。
  // 左卡徽标 / 顶栏 tiles / 右卡三处消费同一 judgment（单一数据源，杜绝左右判定打架）。
  let voteConflicts = 0;
  for (const mm of ordered) {
    const v = dimsVote(mm.dims, mm.judgment, { anchorChange: !CHANGE_INHERENT_KEYS.has(mm.key) });
    if (v.conflict) voteConflicts++;
    mm.judgment = v.judgment;
  }

  return {
    metrics: ordered,
    order: METRIC_ORDER.slice(),
    isFinancial,
    voteConflicts,
    growthCaliber: getGrowthCaliber(), // 20261104b：当前增长口径（'sq'|'cum'），前端切换按钮单一数据源
    note: '指标分析为确定性代码计算，覆盖同比/环比(较上一披露期·累计口径)/行业均值/历史百分位/边际变化五维；总体判定 20261104a 起按「五维多数决·水平锚定」：水平判定（绝对水平好坏）作为锚票参与计票，变化维度（同比/环比/历史百分位/边际）与水平信号方向相反时降级为中性票——绝对水平健康但边际走弱的稳健指标（如低负债率、高流动比率、高毛利率）不再被历史分位/同比变化误判为利空；成长类指标（增速本身即变化量）不锚定，多数决原样生效；可用票≥2 时以多数方向为准，与信号判定冲突时显式标注并以多数决为准（左卡徽标/顶栏着色同步消费同一判定）。成长类指标环比为季报累计值差分本机计算（非财报直供）。缺数据维度如实标注「不可得」。指标顺序与左侧「关键财务指标」逐项对齐（单一权威顺序 METRIC_ORDER）。',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMetricAnalysis, METRIC_ORDER, ZERO_AS_MISSING, dimsVote, sqSeries, sqQoqDim };

~~~

---

## `lib\miaoxiang.js`  ·  382 行

~~~js
'use strict';
/**
 * 东方财富「妙想」数据客户端（纯 Node 实现，无需 Python）。
 *
 * 复刻 mx-finance-data / mx-finance-search 两个 Skill 的调用方式：
 *  - 鉴权：POST /api/auth/token/create 拿到 token+authUrl → 用户扫码授权 →
 *          POST /api/auth/token/result 拿到 apiKey，落盘 ~/.mx-skills/em_api_key
 *  - 取数：POST /proxy/b/mcp/tool/searchData  （结构化表格：股东户数/评级/业绩预告/龙虎榜…）
 *          POST /proxy/b/mcp/tool/searchNews   （资讯/研报/公告聚合）
 *  鉴权头统一为 em_api_key + x-open-id-vendor/tenant。
 *
 * 所有函数都对网络/业务错误做防御式处理，失败时返回结构化错误而非抛异常。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

const AUTH_BASE = (process.env.EM_AUTH_BASE || 'https://ai-saas.eastmoney.com').replace(/\/+$/, '');
const SEARCH_API_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchData';
const NEWS_API_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchNews';
const CLIENT_ID = 'mx-finance-data';
const MX_DIR = path.join(os.homedir(), '.mx-skills');
const KEY_PATH = path.join(MX_DIR, 'em_api_key');
const PENDING_PATH = path.join(MX_DIR, 'pending_auth.json');

function loadKey() {
  const env = (process.env.EM_API_KEY || '').trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(KEY_PATH, 'utf8').trim();
    return t || null;
  } catch { return null; }
}

function saveKey(key) {
  fs.mkdirSync(MX_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_PATH, key.trim() + '\n', { mode: 0o600 });
}

function readPending() {
  try {
    const d = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    if (d && d.token && d.expiresAt > Math.floor(Date.now() / 1000)) return d;
  } catch {}
  return null;
}

function writePending(p) {
  fs.mkdirSync(MX_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(p), { mode: 0o600 });
}

function clearPending() {
  try { fs.unlinkSync(PENDING_PATH); } catch {}
}

// 20260917：所有妙想请求统一带超时（默认 15s）。此前 postJson 用全局 fetch 且无限等待，
// 一旦 ai-saas.eastmoney.com 不可达/握手卡住（如工作台更新后网络出口或 MCP 鉴权状态变化），
// callLLM 里的 searchNewsToText 会无限挂起 → 个股「AI 生成亮点/雷点」永久卡在「AI 分析中…」。
// 本环境全局 fetch 是 axios 多填（follow-redirects）实现，自带 60s 内部超时且忽略 AbortSignal，
// Promise.race/AbortController 均无法截断，故改用 axios 直连并显式 timeout，妙想慢/不通会快速失败，
// callLLM 自动回退到阿里百炼 MCP 搜索，功能不中断。
const MIAOXIANG_TIMEOUT_MS = 15000;

async function postJson(url, body, headers, timeoutMs = MIAOXIANG_TIMEOUT_MS) {
  // 关键：本环境全局 fetch 是 axios 多填（follow-redirects）实现，自带 60s 内部超时且
  // 忽略 timeout/AbortSignal。axios 命中 https 时会切到 fetch adapter，导致 timeout:15000 被静默丢弃，
  // 请求会卡到 60s 才以「timeout of 60000ms exceeded」拒绝（且绕过本函数 try/catch）。
  // 因此：① 强制 adapter:'http'（http 适配器原生尊重 timeout）；② 再叠加一个真·Node 计时器兜底，
  // 无论适配器内部如何，到 timeoutMs 必 reject，保证妙想慢/不通时快速失败并回退 MCP 搜索。
  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      const err = new Error('妙想请求超时（' + timeoutMs + 'ms 无响应），已回退其他搜索通道');
      err.timeout = true;
      reject(err);
    }, timeoutMs);
  });
  try {
    const resp = await Promise.race([
      axios({
        method: 'post',
        url,
        data: body,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        timeout: timeoutMs,
        validateStatus: () => true, // 自己处理 401 等状态码，不让 axios 抛错
        maxRedirects: 5,
        adapter: 'http', // 强制 http 适配器，原生尊重 timeout（避免被 fetch 多填的 60s 覆盖）
      }),
      hardTimeout,
    ]);
    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = { raw: data }; }
    }
    return { status: resp.status, data };
  } catch (e) {
    if (e && e.timeout) throw e; // 我方硬超时（已含明确语义），原样抛出
    // 网络层错误（DNS/连接/超时）→ 包装成超时语义，交由上层回退其他搜索通道
    const err = new Error('妙想请求失败（' + (e && e.message || 'unknown') + '），已回退其他搜索通道');
    err.timeout = true;
    err.cause = e;
    throw err;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

async function createAuth() {
  const { data } = await postJson(`${AUTH_BASE}/api/auth/token/create`, { clientId: CLIENT_ID });
  // 响应结构：{ code, status, message, data: { token, authUrl, apiKeyUrl, expiresIn } }
  return (data && data.data) || {};
}

async function pollAuth(token) {
  const { data } = await postJson(`${AUTH_BASE}/api/auth/token/result`, { token });
  // 响应结构：{ code, status, message, data: { state, apiKey } }
  return (data && data.data) || {};
}

function authHeaders(key) {
  return {
    'em_api_key': key,
    'x-open-id-vendor': 'tencent',
    'x-open-id-app': 'workbuddy',
  };
}

function buildBody(query) {
  return {
    query,
    toolContext: {
      callId: 'call_' + crypto.randomBytes(4).toString('hex'),
      userInfo: { userId: 'user_' + crypto.randomBytes(4).toString('hex') },
    },
  };
}

// ---- 鉴权流程 ----

// 开始授权：已有 key 直接返回 authed；否则创建 pending 并返回 authUrl
async function startAuth() {
  const existing = loadKey();
  if (existing) return { authed: true };
  // 复用尚未过期的 pending token，避免每次调用都换新链接导致旧链接失效
  const pending = readPending();
  if (pending && pending.token && pending.authUrl) {
    return { authed: false, authUrl: pending.authUrl, apiKeyUrl: pending.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw', pending: true };
  }
  const created = await createAuth();
  if (!created.token || !created.authUrl) {
    return { authed: false, error: '授权创建失败: ' + JSON.stringify(created).slice(0, 200) };
  }
  const expiresIn = Number(created.expiresIn) || 30 * 24 * 60 * 60;
  writePending({
    token: created.token,
    authUrl: created.authUrl,
    apiKeyUrl: created.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw',
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn - 5,
  });
  return { authed: false, authUrl: created.authUrl, apiKeyUrl: created.apiKeyUrl || 'https://ai.eastmoney.com/mxClaw' };
}

// 查询授权状态：若 pending 已完成则落盘 key
async function getAuthStatus() {
  const existing = loadKey();
  if (existing) { clearPending(); return { authed: true }; }
  const pending = readPending();
  if (!pending) return { authed: false, needStart: true };
  const r = await pollAuth(pending.token);
  if (r.state === 'done' && r.apiKey) {
    saveKey(r.apiKey);
    clearPending();
    return { authed: true };
  }
  if (r.state === 'pending') return { authed: false, authUrl: pending.authUrl, apiKeyUrl: pending.apiKeyUrl };
  clearPending();
  return { authed: false, invalid: true };
}

// ---- 取数 ----

async function searchData(query) {
  const key = loadKey();
  if (!key) {
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const { status, data } = await postJson(SEARCH_API_URL, buildBody(query), authHeaders(key));
  if (status === 401) {
    clearPending();
    try { fs.unlinkSync(KEY_PATH); } catch {}
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const tables = parseTables(data);
  const message = extractMessage(data);
  const bizError = extractBusinessError(data);
  return { tables, message: message || null, error: bizError || null, bizError: !!bizError };
}

async function searchNews(query) {
  const key = loadKey();
  if (!key) {
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const { status, data } = await postJson(NEWS_API_URL, buildBody(query), authHeaders(key));
  if (status === 401) {
    clearPending();
    try { fs.unlinkSync(KEY_PATH); } catch {}
    const s = await startAuth();
    return { needAuth: true, authUrl: s.authUrl, apiKeyUrl: s.apiKeyUrl };
  }
  const content = data?.data?.llmSearchResponse
    || data?.llmSearchResponse
    || data?.data?.content
    || data?.content
    || '';
  const bizError = extractBusinessError(data);
  return { content: typeof content === 'string' ? content : JSON.stringify(content), error: bizError || null, bizError: !!bizError };
}

// ---- 资讯检索 → 干净文本（20260904a：供 aiAugment 注入作东财事实源）----

// 尝试把 searchNews 返回的字符串解析成条目列表（title/content/date）
// 妙想返回的 content 通常是一个 JSON 字符串：{"data":[{code,title,content,date,informationType,jumpUrl,...}]}
function parseNewsItems(content) {
  if (!content || typeof content !== 'string') return [];
  const raw = content.trim();
  // 剥离可能的围栏/前缀，直接尝试 JSON 解析
  try {
    const parsed = JSON.parse(raw);
    const arr = (parsed && (Array.isArray(parsed) ? parsed : (parsed.data || parsed.list || parsed.result || [])));
    if (Array.isArray(arr)) return arr.filter(it => it && typeof it === 'object');
    return [];
  } catch {
    return [];
  }
}

/**
 * 把妙想 searchNews 结果转成可注入模型的可读文本块。
 * @param {string} query 自然语言查询
 * @param {{maxItems?:number, maxChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, text:string, count:number, rawLen:number, source:string}>}
 */
async function searchNewsToText(query, opts = {}) {
  const { maxItems = 8, maxChars = 6000 } = opts;
  const r = await searchNews(query);
  if (r.needAuth || !r.content) {
    // 20260921g：把业务错误（如「积分已用完」）透出给调用方，避免静默降级成「无数据」
    return { ok: false, text: '', count: 0, rawLen: 0, source: '东方财富妙想AI', error: r.error || null, bizError: !!r.bizError };
  }
  const raw = String(r.content);
  const items = parseNewsItems(raw);
  if (items.length) {
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const title = String(it.title || '').trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const date = String(it.date || it.showTime || '').trim().slice(0, 10);
      const body = String(it.content || '').trim();
      const type = String(it.informationType || '资讯').trim();
      const head = body.length > 300 ? body.slice(0, 300) + '…' : body;
      out.push(`- [${date || '日期未知'}]（${type}）${title}\n  ${head}`);
      if (out.length >= maxItems) break;
    }
    if (out.length) {
      let text = `东方财富资讯（查询：${query}）：\n` + out.join('\n\n');
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（更多内容省略）';
      return { ok: true, text, count: out.length, rawLen: raw.length, source: '东方财富妙想AI' };
    }
  }
  // 非结构化：原样截断返回（只要不是空壳）
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length >= 80) {
    const text = trimmed.slice(0, maxChars);
    return { ok: true, text, count: 1, rawLen: raw.length, source: '东方财富妙想AI' };
  }
  return { ok: false, text: '', count: 0, rawLen: raw.length, source: '东方财富妙想AI' };
}

// ---- 响应解析 ----

function extractDtoList(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  const data = apiResult.data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.dataTableDTOList)) return data.dataTableDTOList;
    const sdr = data.searchDataResultDTO;
    if (sdr && Array.isArray(sdr.dataTableDTOList)) return sdr.dataTableDTOList;
    if (Array.isArray(data.tableList)) return data.tableList;
  }
  if (Array.isArray(apiResult.dataTableDTOList)) return apiResult.dataTableDTOList;
  return null;
}

function tableToRows(block) {
  const table = block.table || {};
  const entityName = String(block.entityName || '指标');
  if (!table || typeof table !== 'object') return { columns: [], rows: [] };
  const headers = Array.isArray(table.headName) ? table.headName : [];
  const keys = Object.keys(table).filter(k => k !== 'headName');
  const flatten = (v) => (v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));

  if (headers.length > 1 && keys.length >= 1) {
    const columns = [entityName, ...headers.map(h => String(h))];
    const rows = keys.map(k => {
      let vals = table[k];
      if (!Array.isArray(vals)) vals = [vals];
      return Object.fromEntries(columns.map((c, i) => [c, i === 0 ? String(k) : flatten(vals[i - 1])]));
    });
    return { columns, rows };
  }
  if (headers.length === 1 && keys.length >= 1) {
    const columns = [entityName, String(headers[0])];
    const rows = keys.map(k => {
      let v = table[k];
      if (Array.isArray(v)) v = v[0];
      return { [columns[0]]: String(k), [columns[1]]: flatten(v) };
    });
    return { columns, rows };
  }
  if (Array.isArray(table.rows)) {
    const cols = Array.isArray(table.columns) ? table.columns : Object.keys(table.rows[0] || {});
    return { columns: cols, rows: table.rows };
  }
  return { columns: [], rows: [] };
}

function parseTables(apiResult) {
  const dtoList = extractDtoList(apiResult);
  if (!dtoList || !dtoList.length) return [];
  const tables = [];
  for (const dto of dtoList) {
    if (!dto || typeof dto !== 'object') continue;
    const title = dto.title || dto.inputTitle || dto.entityName || '表';
    const condition = dto.condition || '';
    const { columns, rows } = tableToRows(dto);
    if (rows.length) tables.push({ title, entityName: dto.entityName || '', condition, columns, rows });
  }
  return tables;
}

function extractMessage(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  // 20260921g：业务失败时 message 位于**根级**、data 为 null；成功时 message 位于 data 内。
  // 旧实现只看 data.message，导致根级错误信息被丢弃。
  if (typeof apiResult.message === 'string' && apiResult.message.trim()) return apiResult.message.trim();
  const data = apiResult.data;
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  return null;
}

/**
 * 识别妙想「业务级失败」：HTTP 200 但 code/status 为负或 data 为空、且带 message。
 * 典型：积分耗尽 —— {"message":"你的积分已用完～请前往 …购买套餐包补充积分","status":-1,"code":-1,"data":null}
 * 此前上层只看到「tables 为空」，把「积分用完 / 未授权 / 参数错误」统统误判为「没有数据」，
 * 静默降级、无从排查（股东户数、评级、龙虎榜、宏观等所有走妙想的功能都受影响）。
 * @returns {string|null} 业务错误文案；正常响应返回 null
 */
function extractBusinessError(apiResult) {
  if (!apiResult || typeof apiResult !== 'object') return null;
  const msg = typeof apiResult.message === 'string' ? apiResult.message.trim() : '';
  if (!msg) return null;
  const code = Number(apiResult.code);
  const st = Number(apiResult.status);
  const negative = (Number.isFinite(code) && code < 0) || (Number.isFinite(st) && st < 0);
  if (negative || apiResult.data == null) return msg;
  return null;
}

module.exports = { startAuth, getAuthStatus, searchData, searchNews, searchNewsToText, loadKey, saveKey, clearPending };

~~~

---

## `lib\miaoxiangMacro.js`  ·  198 行

~~~js
'use strict';
/**
 * 妙想「宏观 / 行业经济指标」取数客户端
 * --------------------------------------------------------------
 * 对应东方财富妙想 MCP 的 `mx_macro_data` 工具，服务端 HTTP 路径：
 *   POST https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchMacroData
 * 鉴权与 lib/miaoxiang.js 一致（em_api_key 头，复用同一枚 Key）。
 *
 * 返回结构（服务端）：data.dataTables[].table 为「指标ID → [数据来源, 值...]」，
 * headName[0] 固定为「数据来源」，其余为时间列（如 2026-08）；
 * nameMap 给出「指标ID → 中文指标名」，macroAttributeExcelMap 给出单位/来源/频率。
 *
 * 本模块把这套结构归一化为 { tables: [{ headers, series:[{id,name,unit,source,freq,points}] }] }，
 * 便于上层按「指标名关键词」取数，并对网络/业务错误做防御式处理（失败返回 ok:false 而非抛异常）。
 */
const { loadKey } = require('./miaoxiang');

const URL_MACRO = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchMacroData';
const UA_VENDOR = { 'x-open-id-vendor': 'tencent', 'x-open-id-app': 'workbuddy' };

function authHeaders(key) {
  return { 'Content-Type': 'application/json', em_api_key: key, ...UA_VENDOR };
}

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '--' || s === '—') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// 时间列（'2026-08' / '2026-08-01' / '2026'）→ 原样保留字符串键
function isTimeHeader(h) {
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(h || '').trim());
}

/**
 * 归一化服务端响应。
 * @returns {{ok:boolean, tables:Array, message:?string, error:?string}}
 */
function normalize(apiResult) {
  const data = (apiResult && apiResult.data) || {};
  const raw = Array.isArray(data.dataTables) ? data.dataTables : [];
  const tables = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const table = t.table || {};
    const headName = Array.isArray(table.headName) ? table.headName : [];
    const timeHeaders = headName.filter(isTimeHeader);
    const nameMap = t.nameMap || {};
    const attrMap = t.macroAttributeExcelMap || {};
    const series = [];
    for (const id of Object.keys(table)) {
      if (id === 'headName') continue;
      const row = Array.isArray(table[id]) ? table[id] : [];
      // row[0] 为数据来源，其后与 timeHeaders 对齐
      const vals = row.slice(1);
      const points = [];
      timeHeaders.forEach((h, i) => {
        const v = numOrNull(vals[i]);
        if (v != null) points.push({ date: String(h), value: v });
      });
      if (!points.length) continue;
      const attr = attrMap[id] || {};
      series.push({
        id,
        name: String(nameMap[id] || attr.macroName || id),
        unit: String(attr.unit || ''),
        source: String(attr.dataSource || row[0] || ''),
        freq: String(attr.edbRateEnum || ''),
        points, // 服务端已按时间倒序（最新在前）
      });
    }
    if (series.length) {
      tables.push({ title: String(t.title || ''), entityName: String(t.entityName || ''), headers: timeHeaders, series });
    }
  }
  return { ok: tables.length > 0, tables, message: (data.message || null), error: null };
}

/**
 * 查询宏观/行业指标（单次请求，不含队列与重试）。
 * @param {string} query 自然语言问句（含指标名、口径、时间范围）
 */
async function searchMacroOnce(query) {
  const key = loadKey();
  if (!key) return { ok: false, tables: [], error: 'NO_KEY', needAuth: true };
  try {
    const r = await fetch(URL_MACRO, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({
        query,
        toolContext: { callId: 'call_' + Math.random().toString(36).slice(2, 10), userInfo: { userId: 'stock-analyzer' } },
      }),
    });
    const text = await r.text();
    if (r.status === 401) return { ok: false, tables: [], error: 'UNAUTHORIZED', needAuth: true };
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, tables: [], error: 'BAD_JSON' }; }
    const n = normalize(j);
    if (!n.ok) n.error = 'NO_DATA';
    return n;
  } catch (e) {
    return { ok: false, tables: [], error: 'NETWORK:' + (e && e.message) };
  }
}

// ---------- 调用节流队列 ----------
// 服务端对 searchMacroData 有频率敏感：并发或连续调用会返回「没有找到符合条件的数据」（NO_DATA）。
// 因此所有请求串行化并保证最小间隔，配合一次延迟重试，避免把「限流」误判成「无数据」。
const MIN_GAP_MS = 350;
const RETRY_WAIT_MS = 1200;
let queue = Promise.resolve();
let lastCallAt = 0;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function enqueue(task) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { lastCallAt = Date.now(); }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

/**
 * 查询宏观/行业指标（串行排队 + 一次延迟重试）。
 * @param {string} query 自然语言问句
 * @param {{retries?:number}} [opts] retries 默认 1（首次 NO_DATA 时延迟重试一次）
 */
function searchMacro(query, opts = {}) {
  const retries = opts.retries == null ? 1 : opts.retries;
  return enqueue(async () => {
    let last = null;
    for (let i = 0; i <= retries; i++) {
      last = await searchMacroOnce(query);
      if (last.ok || last.error === 'UNAUTHORIZED' || last.error === 'NO_KEY') return last;
      if (i < retries) await sleep(RETRY_WAIT_MS);
    }
    return last;
  });
}

/** 判断结果集中是否含某 EMM 指标 ID（且至少有一个数据点） */
function hasSeriesId(tables, id) {
  for (const t of (tables || [])) {
    for (const s of (t.series || [])) {
      if (s.id === id && s.points && s.points.length) return true;
    }
  }
  return false;
}

/**
 * 依次尝试多组措辞，返回首个满足 matchFn 的结果（命中措辞记录在 matchedQuery）。
 * 妙想的自然语言检索命中率会随措辞变化，多措辞兜底可显著提升取数成功率。
 * @param {string[]} queries 措辞候选（按优先级）
 * @param {(tables:Array)=>boolean} [matchFn] 命中判定
 */
async function searchMacroFor(queries, matchFn) {
  const list = Array.isArray(queries) ? queries : [queries];
  let lastErr = 'NO_MATCH';
  for (const q of list) {
    // 多措辞兜底本身已提供容错，故单条不再重试，避免调用链过长（服务端频率敏感 + 首屏超时约束）
    const r = await searchMacro(q, { retries: 0 });
    if (r.ok && (!matchFn || matchFn(r.tables))) return { ...r, matchedQuery: q };
    if (!r.ok) lastErr = r.error || lastErr;
  }
  return { ok: false, tables: [], error: 'NO_MATCH:' + lastErr };
}

/**
 * 从查询结果中按指标名关键词挑一条序列（全部关键词命中、且排除 exclude 命中）。
 * @param {Array} tables searchMacro().tables
 * @param {string[]} include 必须包含的关键词
 * @param {string[]} [exclude] 命中即排除的关键词
 */
function pickSeries(tables, include, exclude = []) {
  const inc = include.filter(Boolean);
  const exc = exclude.filter(Boolean);
  let best = null;
  for (const t of (tables || [])) {
    for (const s of t.series) {
      if (!inc.every(k => s.name.includes(k))) continue;
      if (exc.some(k => s.name.includes(k))) continue;
      // 优先取数据点更多的（信息量更大）
      if (!best || s.points.length > best.points.length) best = s;
    }
  }
  return best;
}

module.exports = { searchMacro, searchMacroOnce, searchMacroFor, pickSeries, hasSeriesId, normalize, URL_MACRO };

~~~

---

## `lib\miaoxiangSearch.js`  ·  81 行

~~~js
// 东方财富妙想（Miaoxiang）金融资讯检索客户端
// 复用 mx-finance-search skill 的 searchNews 接口（自然语言查询公告/研报/新闻）。
// 仅在 EM_API_KEY 可用时返回数据；未授权时返回 null，调用方回退到既有爬虫数据源。
'use strict';

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MCP_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchNews';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// EM_API_KEY 优先级：环境变量 > ~/.mx-skills/em_api_key 落盘文件
function loadApiKey() {
  const envKey = (process.env.EM_API_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const p = path.join(os.homedir(), '.mx-skills', 'em_api_key');
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf-8').trim();
      if (v) return v;
    }
  } catch (e) { /* ignore */ }
  return '';
}

// 从妙想返回体中提取可读正文（优先 llmSearchResponse），兼容 data/result 包裹
function extractContent(raw) {
  if (!raw || typeof raw !== 'object') return '';
  for (const k of ['data', 'result']) {
    const w = raw[k];
    if (w && typeof w === 'object') {
      const x = extractContent(w);
      if (x) return x;
    } else if (typeof w === 'string' && w.trim()) {
      return w.trim();
    }
  }
  for (const k of ['llmSearchResponse', 'searchResponse', 'content', 'answer', 'summary']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  }
  return '';
}

async function searchFinancial(query, timeoutMs = 15000) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.log('[Miaoxiang] 未配置 EM_API_KEY，跳过妙想检索（回退到既有数据源）。');
    return null;
  }
  const q = (query || '').trim();
  if (!q) return null;
  try {
    const resp = await axios.post(MCP_URL, { query: q, toolContext: { callId: 'call_' + Date.now() } }, {
      headers: {
        'Content-Type': 'application/json',
        'em_api_key': apiKey,
        'x-open-id-vendor': 'tencent',
        'x-open-id-app': 'workbuddy',
        'User-Agent': UA,
      },
      timeout: timeoutMs,
    });
    const raw = resp.data;
    if (raw && (raw.code === 401 || raw.status === 401)) {
      console.warn('[Miaoxiang] EM_API_KEY 失效（401），请重新授权。');
      return null;
    }
    const content = extractContent(raw);
    return content || null;
  } catch (e) {
    console.error('[Miaoxiang] search failed:', e.message);
    return null;
  }
}

module.exports = { searchFinancial, loadApiKey };

~~~

---

## `lib\moduleSync.js`  ·  208 行

~~~js
/**
 * lib/moduleSync.js —— 模块联动应答机制（20261024h）
 * =====================================================================
 * 用户需求（2026-10-24）：对所有联动模块添加应答机制——源模块发生变动时，
 * 自动向依赖它的联动模块发送「同步/失效」信号，避免各模块缓存各自为政、
 * 出现「首页一个值、个股页另一个值」这类同屏矛盾。
 *
 * 设计原则（不破坏既有口径）：
 *  1) 只做「通知 + 失效」，不改任何模块的计算口径（输出格式铁律①）。
 *  2) 失效句柄可选：有内存缓存的模块注册 onInvalidate 真正清缓存；
 *     无缓存/按需计算的模块不注册——信号照常记录（表示“上游变了，下游下次计算自然取新值”），
 *     绝不臆造一个假的失效动作。
 *  3) 错误隔离：任一处理器抛错只记录，不影响其他联动模块，也不回抛给源模块。
 *  4) 环路安全：BFS + visited，依赖图出现环也不会死循环。
 *  5) 合并去抖：同一 (source, date, symbols) 在 COALESCE_MS 内只发一次，
 *     避免一次刷新里多个入口重复失效（可用 ctx.force 强制重发）。
 *  6) 透明可查：getGraph()/getRecentSignals() 供 /api/module-sync/* 观测，
 *     用户能看到「谁变了、通知了谁、谁真的失效了几条」。
 *
 * 传递示例：manualZones 变动 → priceActionHub（丢快照）→ sameDayJudgment（作废判断）
 *   因为个股判断的 technicalShort/levelHints 消费价格行为快照，手动区间变了必须连带重算。
 */
'use strict';

const COALESCE_MS = 3000;
const MAX_LOG = 200;

// ===================== 依赖图（source -> 直接联动模块） =====================
// 语义：source 变动 → 列出的模块需要同步（再沿它们的 dependents 继续传递）。
// 注意：marketEmotion → sameDayJudgment 由 lib/sameDayJudgment._emotionSubStale 做「按分值变化懒同步」，
// 不走 eager 广播（首页每次加载都会重算情绪，eager 失效会无谓抖动）；此处声明关系供观测。
const DEPENDENTS = {
  quoteBars:       ['priceActionHub', 'volumeEngine', 'zoneValidity', 'capitalFlow', 'sameDayJudgment', 'deepAnalysis', 'valuation'],
  priceActionHub:  ['sameDayJudgment'],
  manualZones:     ['priceActionHub'],       // → 传递到 sameDayJudgment
  marketEmotion:   ['sameDayJudgment'],      // 懒同步（_emotionSubStale 门控）
  eventEngine:     ['sameDayJudgment', 'deepAnalysis'],
  dedicatedFactor: ['sameDayJudgment'],
  capitalFlow:     ['sameDayJudgment'],
  sectorMarket:    ['sameDayJudgment'],
  earnings:        ['sameDayJudgment'],      // 财报解读更新
  volumeEngine:    [],
  zoneValidity:    [],
  sameDayJudgment: [],
  deepAnalysis:    [],
  valuation:       [],
};

const MODULE_INFO = {
  quoteBars:       '行情/K线（根基数据源）',
  priceActionHub:  '价格行为快照（②卡短期动向/阻力支撑）',
  manualZones:     '手动阻力/支撑区间',
  marketEmotion:   '市场情绪提醒（大盘量能情绪模型）',
  eventEngine:     '事件引擎（新闻→事件→权重再平衡）',
  dedicatedFactor: '专属因子（公司特有事件）',
  capitalFlow:     '资金量能（主力资金/换手率）',
  sectorMarket:    '板块/行业短期走势',
  earnings:        '财报解读（深度分析）',
  volumeEngine:    '量能分析引擎',
  zoneValidity:    '箱体/阻力支撑有效性',
  sameDayJudgment: '当日行情判断（多因子聚合）',
  deepAnalysis:    '深度分析',
  valuation:       '估值模型（专属估值协议）',
};

const handlers = new Map();   // module -> (ctx) => info
const log = [];               // 最近信号
const recent = new Map();     // dedupeKey -> ts
let wiringDone = false;

/** 注册某联动模块的失效句柄（有缓存的模块调用；可选） */
function onInvalidate(module, fn) {
  if (!module || typeof fn !== 'function') return;
  handlers.set(module, fn);
}
const registerHandler = onInvalidate;

function _ctxSymbols(ctx) {
  return (ctx && Array.isArray(ctx.symbols)) ? ctx.symbols.map(String) : [];
}
function _dedupeKey(source, ctx) {
  const syms = _ctxSymbols(ctx).slice().sort().join(',');
  return `${source}|${(ctx && ctx.date) || ''}|${syms}`;
}

/**
 * 发送「源模块已变动」信号，自动通知所有（直接 + 间接）联动模块。
 * @param {string} source 源模块名（须在 DEPENDENTS 中）
 * @param {object} ctx { symbols?:string[], date?:string, reason?:string, force?:boolean }
 * @returns {{source:string, skipped:boolean, reason?:string, affected:string[], results:Array}}
 */
function emitChange(source, ctx = {}) {
  ensureDefaultWiring();
  if (!DEPENDENTS[source]) {
    return { source, skipped: true, reason: '未知源模块（未在依赖图登记）', affected: [], results: [] };
  }
  const now = Date.now();
  const key = _dedupeKey(source, ctx);
  const last = recent.get(key);
  if (!ctx.force && last && now - last < COALESCE_MS) {
    return { source, skipped: true, reason: 'coalesced', affected: [], results: [] };
  }
  recent.set(key, now);
  if (recent.size > 800) { // 防无限增长
    for (const [k, ts] of recent) if (now - ts > COALESCE_MS * 4) recent.delete(k);
  }

  // BFS 收集全部受影响的联动模块（含间接）
  const affected = [];
  const visited = new Set([source]);
  const queue = [...(DEPENDENTS[source] || [])];
  while (queue.length) {
    const m = queue.shift();
    if (visited.has(m)) continue;
    visited.add(m);
    affected.push(m);
    for (const d of (DEPENDENTS[m] || [])) if (!visited.has(d)) queue.push(d);
  }

  const results = [];
  const symbols = _ctxSymbols(ctx);
  for (const m of affected) {
    const fn = handlers.get(m);
    let info = null, ok = true, error = null;
    if (typeof fn === 'function') {
      try { info = fn({ ...ctx, symbols, source, module: m }); }
      catch (e) { ok = false; error = (e && e.message) ? e.message : String(e); }
    }
    results.push({ module: m, hasHandler: typeof fn === 'function', ok, error, info: info == null ? null : info });
  }

  const entry = {
    at: new Date().toISOString(),
    source,
    ctx: { symbols: symbols.length ? symbols : null, date: ctx.date || null, reason: ctx.reason || null },
    affected,
    results,
  };
  log.push(entry);
  if (log.length > MAX_LOG) log.shift();
  if (process.env.SA_MODULE_SYNC_LOG === '1') {
    const detail = results.map(r => `${r.module}${r.hasHandler ? '=' + (r.info && r.info.invalidated != null ? r.info.invalidated : 'ok') : '(仅记录)'}`).join(', ');
    console.log(`[ModuleSync] ${source}${ctx.reason ? '（' + ctx.reason + '）' : ''} → ${affected.length ? detail : '无联动模块'}`);
  }
  return { source, skipped: false, affected, results };
}

/** 默认接线：为有内存缓存的模块注册真正的失效句柄（懒 require 避免循环依赖） */
function ensureDefaultWiring() {
  if (wiringDone) return;
  wiringDone = true;

  onInvalidate('priceActionHub', (ctx) => {
    const syms = _ctxSymbols(ctx);
    if (!syms.length) return { invalidated: 0, note: '未给出 symbols，无法按标的清快照缓存' };
    const { invalidateSnapshot } = require('./priceActionHub');
    let n = 0;
    for (const s of syms) { try { invalidateSnapshot(s); n++; } catch (e) {} }
    return { invalidated: n };
  });

  onInvalidate('sameDayJudgment', (ctx) => {
    const syms = _ctxSymbols(ctx);
    if (!syms.length) return { invalidated: 0, note: '未给出 symbols，无法按标的作废判断' };
    const sdj = require('./sameDayJudgment');
    if (typeof sdj.invalidateJudgmentForSymbol !== 'function') return { invalidated: 0, note: 'invalidateJudgmentForSymbol 不可用' };
    let n = 0;
    for (const s of syms) { try { if (sdj.invalidateJudgmentForSymbol(s)) n++; } catch (e) {} }
    return { invalidated: n };
  });

  // volumeEngine / zoneValidity / capitalFlow / deepAnalysis / valuation：无进程内缓存或按需计算，
  // 不注册句柄——信号照常进入日志（下游下次计算自然取到上游新值），不臆造失效动作。
}

/** 依赖图（观测/文档） */
function getGraph() {
  ensureDefaultWiring();
  return {
    modules: Object.keys(MODULE_INFO).map(name => ({
      name, desc: MODULE_INFO[name], dependents: DEPENDENTS[name] || [], hasHandler: handlers.has(name),
    })),
    edges: Object.entries(DEPENDENTS).flatMap(([s, ds]) => (ds || []).map(d => ({ from: s, to: d }))),
  };
}
/** 最近信号（新的在前） */
function getRecentSignals(limit = 20) {
  const n = Math.max(1, Math.min(MAX_LOG, Number(limit) || 20));
  return log.slice(-n).reverse();
}
function stats() {
  ensureDefaultWiring();
  return { modules: Object.keys(MODULE_INFO).length, handlers: handlers.size, signals: log.length };
}
/** 单测用：重置内部状态 */
function _reset() {
  handlers.clear(); log.length = 0; recent.clear(); wiringDone = false;
}

module.exports = {
  emitChange, notify: emitChange,
  onInvalidate, registerHandler,
  ensureDefaultWiring,
  getGraph, getRecentSignals, stats,
  DEPENDENTS, MODULE_INFO, COALESCE_MS,
  _reset,
};

~~~

---

## `lib\newsImpactLearning.js`  ·  131 行

~~~js
/**
 * 新闻影响判断 · 自学习数据层
 * --------------------------------------------------------------
 * 记录「新闻 → 板块影响」的判断结果，支持人工更正，持续积累命中情况，
 * 为后续判断（联动市场情绪因子的板块消息联动）提供置信度与学习信号。
 *
 * 存储：data/news_impact_learning.json
 *   { records: [{ id, title, sector, direction, createdAt, corrected, correct, correctedSector, correctedDirection }],
 *     stats: { total, correctedCount, correctCount, bySector: {sector: {total, correct}} } }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'news_impact_learning.json');
const MAX_RECORDS = 2000;

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : { records: [], stats: {} };
  } catch (e) {
    return { records: [], stats: {} };
  }
}

function writeAll(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function makeId(title, sector) {
  return crypto.createHash('md5').update(String(title || '') + '|' + String(sector || '')).digest('hex').slice(0, 16);
}

function recomputeStats(records) {
  const stats = { total: records.length, correctedCount: 0, correctCount: 0, bySector: {} };
  for (const r of records) {
    if (!r.corrected) continue;
    stats.correctedCount++;
    if (r.correct) stats.correctCount++;
    if (r.sector) {
      const b = stats.bySector[r.sector] || (stats.bySector[r.sector] = { total: 0, correct: 0 });
      b.total++;
      if (r.correct) b.correct++;
    }
  }
  return stats;
}

// 记录一条判断（幂等：同 id 已存在则跳过/更新）
function recordImpact(title, sector, direction) {
  const all = readAll();
  const id = makeId(title, sector);
  const idx = all.records.findIndex(r => r.id === id);
  if (idx >= 0) {
    // 已存在，不重复记录
    return all.records[idx];
  }
  const rec = {
    id, title: String(title || '').slice(0, 120), sector, direction,
    createdAt: new Date().toISOString(), corrected: false, correct: null,
    correctedSector: null, correctedDirection: null,
  };
  all.records.push(rec);
  if (all.records.length > MAX_RECORDS) all.records = all.records.slice(-MAX_RECORDS);
  all.stats = recomputeStats(all.records);
  writeAll(all);
  return rec;
}

// 更正一条判断：人工反馈该判断是否正确，并可纠正板块/方向
function correctImpact(id, correct, correctedSector, correctedDirection) {
  const all = readAll();
  const rec = all.records.find(r => r.id === id);
  if (!rec) return null;
  rec.corrected = true;
  rec.correct = !!correct;
  if (correctedSector) rec.correctedSector = correctedSector;
  if (correctedDirection) rec.correctedDirection = correctedDirection;
  all.stats = recomputeStats(all.records);
  writeAll(all);
  return rec;
}

function getLearningState() {
  const all = readAll();
  return {
    ...all.stats,
    recent: all.records.slice(-20).reverse(),
    accuracy: all.stats.correctedCount ? Math.round(all.stats.correctCount / all.stats.correctedCount * 100) : null,
  };
}

/**
 * 自动复核（无需人工干预）：用「板块实际涨跌」对照新闻影响判断的方向，自动标记对错。
 * sectorChgMap = { 板块名: 涨跌幅(%) }，通常来自当日收盘的行业板块涨跌幅。
 * 方向规则：direction='up'(看涨) 且板块 chg>0 → 正确；direction='down'(看跌) 且 chg<0 → 正确；否则错误。
 * 已人工更正的记录不再覆盖；中性方向暂不自动复核。
 * 返回 { reviewed, correctN, wrongN, stats }。
 */
function autoReviewImpacts(sectorChgMap) {
  const all = readAll();
  let reviewed = 0, correctN = 0, wrongN = 0;
  for (const r of all.records) {
    if (r.corrected) continue;           // 已复核（人工或自动）不再覆盖
    if (!r.sector || r.direction === 'neutral') continue;
    const chg = (sectorChgMap && typeof sectorChgMap[r.sector] === 'number') ? sectorChgMap[r.sector] : null;
    if (chg == null) continue;           // 该板块涨跌数据缺失，跳过
    const up = r.direction === 'up';
    const correct = up ? chg > 0 : chg < 0;
    r.corrected = true;
    r.correct = correct;
    r.autoReviewed = true;
    r.reviewedAt = new Date().toISOString();
    r.reviewChg = Math.round(chg * 100) / 100;
    reviewed++;
    if (correct) correctN++; else wrongN++;
  }
  if (reviewed > 0) {
    all.stats = recomputeStats(all.records);
    writeAll(all);
  }
  return { reviewed, correctN, wrongN, accuracy: all.stats.correctedCount ? Math.round(all.stats.correctCount / all.stats.correctedCount * 100) : null, stats: all.stats };
}

module.exports = { recordImpact, correctImpact, getLearningState, autoReviewImpacts, makeId };

~~~

---

## `lib\newsSearch.js`  ·  475 行

~~~js
/**
 * News Search Module
 * Fetches financial news from Eastmoney content search API
 */
const axios = require('axios');
const { analyzeSentiment } = require('./analysis');
// Part B：关联度/弱关联持续性经验库（mRNA→医疗器械 等弱关联识别与衰减）
const { relevanceScore, WEAK_THRESHOLD } = require('./relevanceLearning');
// 北京时间渲染（避免 toISOString 的 UTC 8 小时错位）
const { localDateTime } = require('./localDate');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 内存缓存（避免每次打开首页都打外部接口）
let hotNewsCache = { ts: 0, data: null };

/**
 * 今日财经热点分类（时政 / 政策 / 国际 / 公司 / 市场）
 */
function classifyCategory(title = '', summary = '') {
  const t = (title + ' ' + (summary || '')).toLowerCase();
  if (/(央行|货币|利率|降准|降息|财政|国务院|发改委|证监会|资管|监管|政策|法案|国常会|政治局|两会|税收|补贴|社保|公积金|mlf|lpr)/.test(t)) return '政策';
  if (/(美联储|美股|特朗普|拜登|白宫|欧洲|日本|韩国|地缘|俄乌|中东|国际|加息|非农|fomc|英伟达|苹果|特斯拉|谷歌|微软|欧央行|日央)/.test(t)) return '国际';
  if (/(营收|净利|业绩|回购|减持|增持|并购|重组|上市|退市|分红|募资|中标|签约|订单|研报|发债|定增)/.test(t)) return '公司';
  return '市场';
}

/**
 * 东方财富 7×24 快讯（时政财经热点）
 * ------------------------------------------------------------------
 * 数据源（2026-09-17 抓真实响应核对后确认）：
 *   旧接口 https://newsapi.eastmoney.com/kuaixun/v1/getlist 已下线（实测 404），
 *   现改走 https://np-listapi.eastmoney.com/comm/web/getFastNewsList，
 *   响应体结构为 data.fastNewsList[]。
 *
 * 时间字段口径（本次核对的关键结论）：
 *   条目**没有** datetime 字段，实际提供两个时间：
 *     · showTime —— 北京墙钟字符串，形如 "2026-09-17 18:47:28"（可直接用）；
 *     · realSort —— 微秒级**真 epoch**（实测 1789642048033848；/1e6 后按 Asia/Shanghai
 *                  渲染与 showTime 完全一致，已逐条比对）。
 *   历史 bug：旧代码把真 epoch 交给 `new Date(ts).toISOString()` 渲染 —— toISOString 输出
 *   UTC，展示时间会比北京时间早 8 小时。现统一经 normalizeNewsTime() 按北京时区渲染。
 *   注：返回对象字段保持 { title, summary, source, url, date } 不变，仅内部实现变更，
 *       故下游卡片/影响标注模块无需改动。
 */
/**
 * 把快讯时间字段归一化为北京时间的 'YYYY-MM-DD HH:mm'。
 * 兼容：北京墙钟字符串（含 'YYYY-MM-DDTHH:mm:ss'）、秒/毫秒/微秒三种精度的 epoch。
 * 无法识别时返回 ''。
 */
function normalizeNewsTime(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return '';
    if (/^\d+$/.test(s)) return normalizeNewsTime(Number(s)); // 纯数字字符串按 epoch 处理
    const t = s.replace('T', ' ').slice(0, 16);
    // 仅接受形如 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm' 的日期，挡住脏字符串被当作时间展示
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(t)) return '';
    return isNaN(new Date(t.replace(' ', 'T')).getTime()) ? '' : t;
  }
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  let ms;
  if (n < 1e11) ms = n * 1000;        // 秒级（约 10 位）
  else if (n < 1e14) ms = n;          // 毫秒级（约 13 位）
  else ms = n / 1000;                 // 微秒级（约 16 位）
  return localDateTime(ms);
}

async function fetchKuaixunNews(pageSize = 40) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 40));
  const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
    + `?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=${size}&req_trace=${Date.now()}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://kuaixun.eastmoney.com/' },
      timeout: 9000,
    });
    const data = resp.data;
    const list = (data && data.data && (data.data.fastNewsList || data.data.list))
      || (data && data.list) || [];
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (const it of list) {
      // 时间：优先 showTime（北京墙钟），回退 realSort / datetime（真 epoch，按北京渲染）
      const dateStr = normalizeNewsTime(it.showTime)
        || normalizeNewsTime(it.realSort)
        || normalizeNewsTime(it.datetime);
      const title = (it.title || '').replace(/<\/?em>/g, '').trim();
      let summary = (it.summary || it.content || it.digest || '').replace(/<\/?em>/g, '').trim();
      // 新接口 summary 常以「【标题】正文」开头重复标题，去掉前缀避免卡片重复展示
      const m = /^【([^】]{2,40})】/.exec(summary);
      if (m && title && (m[1] === title || title.indexOf(m[1]) >= 0)) {
        summary = summary.slice(m[0].length).trim();
      }
      if (!title) continue;
      out.push({
        title,
        summary: summary.slice(0, 120),
        source: it.source || it.mediaName || '东方财富快讯',
        // 原接口已下线且新接口不含 url，用 code 合成原文深链（已实测可访问）
        url: it.url || (it.code ? `https://finance.eastmoney.com/a/${it.code}.html` : ''),
        date: dateStr,
      });
    }
    return out;
  } catch (e) {
    console.error('Kuaixun hot news failed:', e.message);
    return [];
  }
}

/**
 * 获取今日财经热点（带缓存 + 兜底）
 */
async function getHotNews(force = false) {
  const TTL = 10 * 60 * 1000;
  const now = Date.now();
  if (!force && hotNewsCache.data && now - hotNewsCache.ts < TTL) {
    return hotNewsCache.data;
  }
  let items = await fetchKuaixunNews();
  if (!items.length) {
    // 兜底：用内容搜索取泛财经要闻
    try {
      const fallback = await fetchEastmoneyContentNews('财经 股市 政策', 30);
      items = fallback.map(n => ({ ...n, date: (n.date || '').slice(0, 16) }));
    } catch (e) { items = []; }
  }
  if (!items.length) {
    const empty = { source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], error: '暂未获取到最新快讯（可能网络受限或接口变更）' };
    hotNewsCache = { ts: now, data: empty };
    return empty;
  }
  // 去重 + 分类 + 情绪 + 排序
  const seen = new Set();
  items = items.filter(n => {
    if (!n.title || seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  }).map(n => ({
    ...n,
    category: classifyCategory(n.title, n.summary),
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
  }));
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  items = items.slice(0, 24);
  const result = { source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items };
  hotNewsCache = { ts: now, data: result };
  return result;
}


/**
 * Search financial news from Eastmoney content search API
 * Works for both Chinese and international stocks (search by name/keyword)
 */
async function fetchEastmoneyContentNews(keyword, pageSize = 15) {
  const param = JSON.stringify({
    uid: "",
    keyword: keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize: pageSize,
        preTag: "",
        postTag: ""
      }
    }
  });

  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery&param=${encodeURIComponent(param)}`;

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://so.eastmoney.com/' },
      timeout: 8000
    });

    // Parse JSONP response
    const text = resp.data;
    const jsonStr = text.replace(/^jQuery\(/, '').replace(/\);?\s*$/, '');
    const data = JSON.parse(jsonStr);

    const articles = data?.result?.cmsArticleWebOld || [];

    return articles.map(a => ({
      title: (a.title || '').replace(/<\/?em>/g, ''),
      summary: (a.content || '').replace(/<\/?em>/g, '').slice(0, 200),
      source: a.mediaName || a.source || '东方财富',
      url: a.url || '',
      date: a.date || '',
    }));
  } catch (e) {
    console.error('Eastmoney content news failed:', e.message);
    return [];
  }
}

/**
 * Fetch stock-specific announcements from Eastmoney
 * 20261015f：数据源统一——原走 np-anotice.eastmoney.com（实测已失效：HTTP 200 但恒返回 0 条，
 * 个股新闻页的公告部分长期静默为空）。全工作台「个股公告」共有三处东财入口，现统一为唯一实测
 * 可用路径（与 lib/cnscraperAdapter.searchAnnouncementsByCode 20260922i 修正后的路径完全一致）：
 *   np-anotice-stock.eastmoney.com/api/security/ann?...&ann_type=A&client_source=web&f_node=0&s_node=0
 * 其中 f_node=0&s_node=0 必须携带，否则只返回全市场公告（20260922i 实测结论）。
 * 响应字段 title / notice_date / art_code 实测确认不变，解析逻辑零改动。
 */
async function fetchEastmoneyAnnouncements(stockCode, exchange) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web&stock_list=${stockCode}&f_node=0&s_node=0`;

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' },
      timeout: 8000
    });

    const items = resp.data?.data?.list || [];

    return items.map(item => ({
      title: item.title || '',
      summary: '',
      source: '东方财富公告',
      url: `https://np-cnotice.eastmoney.com/api/content/ann?art_code=${item.art_code}`,
      date: item.notice_date ? item.notice_date.slice(0, 10) : '',
    }));
  } catch (e) {
    console.error('Eastmoney announcements failed:', e.message);
    return [];
  }
}

/**
 * Main news fetch function
 * Uses Eastmoney content search for all markets
 */
async function getNews(input, stockName) {
  const { detectMarket } = require('./stockData');
  const info = detectMarket(input);

  let newsList = [];
  const searchKeyword = stockName || input;

  // Use Eastmoney content search for all markets
  const [contentResult, announceResult] = await Promise.allSettled([
    fetchEastmoneyContentNews(searchKeyword),
    info.market === 'CN' ? fetchEastmoneyAnnouncements(input, info.exchange) : Promise.resolve([])
  ]);

  if (contentResult.status === 'fulfilled') newsList.push(...contentResult.value);
  if (announceResult.status === 'fulfilled') newsList.push(...announceResult.value);

  // Deduplicate by title
  const seen = new Set();
  newsList = newsList.filter(n => {
    if (!n.title || seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });

  // Add sentiment analysis
  newsList = newsList.map(n => ({
    ...n,
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || ''))
  }));

  // Sort by date (newest first)
  newsList.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return newsList.slice(0, 20);
}

// ---- 时间衰减（时效性） ----
// 新闻情绪影响随时间递减：当天 1.0、1 天前 0.7、2 天前 0.5、3 天及以上 0.3。
// 用于个股新闻与板块新闻的情绪聚合，避免旧消息长期主导当前情绪。
function _parseNewsDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const d = new Date(s.replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

function _newsTimeDecayWeight(pubDate, base = new Date()) {
  if (!pubDate) return 0.5;
  const days = Math.max(0, (base - pubDate) / 86400000);
  if (days < 1) return 1.0;
  if (days < 2) return 0.7;
  if (days < 3) return 0.5;
  return 0.3;
}

// ---- 板块/赛道关键词映射（板块联动传导）----
// 个股行业名 → 广义赛道关键词。用于把「板块级/赛道级」消息事件（如 mRNA 疫苗催化生物制药）
// 传导到个股情绪，解决"个股新闻源抓不到板块级催化"的问题。关键词按行业常识扩展，越靠前越相关。
const SECTOR_KEYWORDS = {
  '医疗器械': ['医药生物', '创新药', '疫苗', '生物医药', 'mRNA', '医疗', '医疗器械'],
  '体外诊断': ['医药生物', '创新药', '生物医药', '医疗', '体外诊断'],
  '生物制品': ['医药生物', '创新药', '疫苗', 'mRNA', '生物医药', '生物制品'],
  '化学制药': ['医药生物', '创新药', '生物医药', '化学制药'],
  '中药': ['医药生物', '创新药', '生物医药', '中药'],
  '医疗服务': ['医药生物', '医疗', '创新药', '生物医药'],
  '证券': ['证券', '非银金融', '券商', '资本市场'],
  '券商信托': ['证券', '非银金融', '券商'],
  '保险': ['保险', '非银金融'],
  '银行': ['银行', '金融', '非银金融'],
  '半导体': ['半导体', '芯片', '集成电路', '国产替代', '光刻'],
  '消费电子': ['消费电子', '半导体', '芯片', '电子'],
  '白酒': ['白酒', '食品饮料', '消费', '酿酒'],
  '食品饮料': ['食品饮料', '消费', '白酒'],
  '新能源': ['新能源', '光伏', '风电', '储能', '锂电', '电池'],
  '光伏': ['光伏', '新能源', '储能', '电力设备'],
  '锂电池': ['锂电', '电池', '新能源', '新能源车'],
  '新能源汽车': ['新能源车', '汽车', '锂电', '智能驾驶'],
  '人工智能': ['人工智能', 'AI', '算力', '大模型', '光模块'],
  '算力': ['算力', 'AI', '人工智能', '光模块', '数据中心'],
  '通信': ['通信', '5G', '算力', '光模块', '卫星互联网'],
  '计算机': ['计算机', '软件', '信创', '人工智能', '数据要素'],
  '军工': ['军工', '国防军工', '航天', '卫星', '航空'],
  '有色': ['有色金属', '黄金', '铜', '锂', '稀土'],
  '煤炭': ['煤炭', '能源', '动力煤'],
  '石油石化': ['石油', '石化', '油气', '能源'],
  '钢铁': ['钢铁', '建材', '基建'],
  '房地产': ['房地产', '地产', '基建'],
  '建筑装饰': ['建筑', '基建', '地产'],
  '交通运输': ['交运', '物流', '航运', '航空'],
  '农业': ['农业', '种业', '养殖', '粮食'],
  '环保': ['环保', '碳中和', '生态'],
};

// 归一化行业名后取广义赛道关键词；无命中则回退行业名自身
function _broadSectorKeywords(industryName) {
  const norm = (industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  if (!norm) return [industryName].filter(Boolean);
  for (const [k, v] of Object.entries(SECTOR_KEYWORDS)) {
    const kn = k.replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
    if (norm.includes(kn) || kn.includes(norm)) {
      return v;
    }
  }
  return [industryName].filter(Boolean);
}

/**
 * 板块/赛道级消息情绪（板块联动传导）
 * 按「个股行业名 + 广义赛道关键词」抓板块级新闻（东财内容搜索，本机可用），
 * 聚合情绪并传导到个股。解决"个股新闻源抓不到板块级催化"的问题。
 * 额外做「重大事件精匹配」：命中事件级关键词（mRNA/三期/主要终点/里程碑等）时标记并提升敏感性。
 * 返回 { symbol, industryName, count, positive, negative, neutral, avgScore, signal, samples, keywords, note, events, eventBoosted }
 * 20260821a：增加 symbol/industryName 回显与 keywords 一致性校验，防止跨股/跨行业污染后难以排查。
 */
// 事件级关键词：用于从板块新闻里精确识别"重大催化事件"（而非泛泛的板块涨跌）
const EVENT_KEYWORDS = [
  'mRNA', '三期', 'III期', 'III 期', '主要终点', '里程碑', '历史性', '首创', '首个',
  '获批', '超预期', '重大进展', '突破', '达成', '成功', '关键进展', '突破性',
  '达到主要终点', '无进展生存', '完全缓解', '上市', '商业化', '中美双报', '紧急使用授权',
];

/**
 * 板块/赛道级消息情绪（板块联动传导）
 * 按「个股行业名 + 广义赛道关键词」抓板块级新闻，聚合情绪并传导到个股。
 * Part B 增强（20260823i）：逐条按「主题与个股行业的关联度」加权——弱关联主题（如 mRNA→医疗器械）
 *   只给弱权重，不再按强关联打分；×1.3 重大事件加码仅在该事件所属主题关联度≥0.6（高关联）时施加。
 *   relevanceFor 可选：若传入主题，则对整个聚合信号再乘一次关联度（用于显式指定主题口径），默认 null 走逐条自动关联度。
 * 返回 { ..., signal, relevance, relevanceByKeyword, weakThemes, events, eventBoosted }
 */
async function getSectorNewsSentiment(industryName, name = '', symbol = '', relevanceFor = null) {
  const baseKeywords = _broadSectorKeywords(industryName);
  // 校验：keywords 必须与 industryName 有语义关联，否则极可能是跨行业污染
  const core = String(industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  const keywordsMatch = core && baseKeywords.some(k => k.includes(core) || core.includes(k));
  if (baseKeywords.length && core && !keywordsMatch) {
    console.warn(`[SectorNews] keywords 与 industryName 不匹配: symbol=${symbol} industryName=${industryName} keywords=${baseKeywords.join(',')}`);
  }
  if (!baseKeywords.length) {
    return { symbol, industryName, count: 0, positive: 0, negative: 0, neutral: 0, avgScore: null, signal: 0, samples: [], keywords: [], relevanceByKeyword: {}, relevance: null, weakThemes: [], note: '无行业名，跳过板块消息', events: [], eventBoosted: false, ok: false };
  }
  // 按「主题与个股行业的关联度」降序排列关键词：高关联主题优先认领新闻，弱关联主题退后，
  // 避免 mRNA/疫苗 这类弱主题抢先"认领"本该属于医疗器械/医药板块的通用新闻。
  const kwRel = baseKeywords.map(k => ({ k, rel: relevanceScore(industryName, k) }));
  kwRel.sort((a, b) => b.rel - a.rel);
  const keywords = kwRel.map(x => x.k).slice(0, 5);
  const relByKw = {};
  kwRel.forEach(x => { relByKw[x.k] = x.rel; });

  const seen = new Set();
  const news = [];
  for (const kw of keywords) {
    let items = [];
    try {
      items = await fetchEastmoneyContentNews(kw, 8);
    } catch (e) { items = []; }
    for (const n of items) {
      if (n.title && !seen.has(n.title)) { seen.add(n.title); news.push({ ...n, _kw: kw }); }
    }
    if (news.length >= 24) break; // 已足够
  }
  if (!news.length) {
    return { symbol, industryName, count: 0, positive: 0, negative: 0, neutral: 0, avgScore: null, signal: 0, samples: [], keywords, relevanceByKeyword: relByKw, relevance: null, weakThemes: keywords.filter(k => relByKw[k] < WEAK_THRESHOLD), note: `板块「${industryName}」未检索到相关消息`, events: [], eventBoosted: false, ok: false };
  }
  const base = new Date();
  const scored = news.map(n => ({
    ...n,
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
    weight: _newsTimeDecayWeight(_parseNewsDate(n.date), base),
    // 每条新闻归属其被抓取的关键词主题，关联度随主题而定（弱主题→弱权重）
    rel: relByKw[n._kw] != null ? relByKw[n._kw] : relevanceScore(industryName, n._kw || industryName),
  }));
  let pos = 0, neg = 0, neu = 0;
  for (const n of scored) {
    const l = n.sentiment.label;
    if (l === '积极' || l === '偏多') pos++;
    else if (l === '消极' || l === '偏空') neg++;
    else neu++;
  }
  // 重大事件精匹配：标题/摘要命中事件级关键词；但只有「高关联主题(≥0.6)」的事件才允许×1.3 加码
  const events = [];
  for (const n of scored) {
    const text = n.title + ' ' + (n.summary || '');
    const hit = EVENT_KEYWORDS.filter(k => text.includes(k));
    if (hit.length) events.push({ title: n.title.slice(0, 60), keywords: hit, sentiment: n.sentiment.label, relevance: n.rel, kw: n._kw });
  }
  const eventBoosted = events.some(e => (e.relevance != null ? e.relevance : 0) >= WEAK_THRESHOLD);

  // 原始平均分（参考） + 加权平均分（信号）：旧消息按时间衰减，且每条按主题关联度加权
  const avgScore = Math.round(scored.reduce((s, n) => s + (n.sentiment.score || 0), 0) / scored.length);
  const totalWeight = scored.reduce((s, n) => s + n.weight * n.rel, 0) || 1;
  const weightedAvgScore = Math.round(scored.reduce((s, n) => s + (n.sentiment.score || 0) * n.weight * n.rel, 0) / totalWeight);
  let signal = Math.max(-1, Math.min(1, weightedAvgScore / 50));
  // 命中「高关联」重大事件时提升敏感性：信号向多/空方向放大（×1.3 后截断）
  if (eventBoosted && signal !== 0) {
    signal = Math.max(-1, Math.min(1, signal * 1.3));
  }
  // 显式指定主题口径：对整个聚合信号再乘一次关联度（可选，默认 null 走逐条自动关联度）
  if (relevanceFor) {
    const rf = relevanceScore(industryName, relevanceFor);
    if (rf < WEAK_THRESHOLD) eventBoosted = false; // 显式弱主题不享受加码
    signal = Math.max(-1, Math.min(1, signal * rf));
  }
  const avgRel = Math.round(scored.reduce((s, n) => s + n.rel, 0) / scored.length * 1000) / 1000;
  const weakThemes = keywords.filter(k => relByKw[k] < WEAK_THRESHOLD);
  const note = `板块/赛道关键词：${keywords.slice(0, 3).join('、')}（按发布时间+主题关联度加权，均关联度 ${avgRel}）${eventBoosted ? '；命中高关联重大事件' : ''}`;
  if (symbol && industryName && !keywordsMatch) {
    console.warn(`[SectorNews] 返回数据疑似跨行业污染，已降级: symbol=${symbol} industryName=${industryName} keywords=${keywords.join(',')}`);
  }
  return {
    symbol,
    industryName,
    count: scored.length,
    positive: pos,
    negative: neg,
    neutral: neu,
    avgScore,
    weightedAvgScore,
    signal: Math.round(signal * 1000) / 1000,
    samples: scored.slice(0, 5).map(n => ({ title: n.title.slice(0, 40), score: n.sentiment.score, weight: n.weight, relevance: n.rel, kw: n._kw })),
    keywords,
    relevanceByKeyword: relByKw,
    relevance: avgRel,
    weakThemes,
    note: note + (keywordsMatch ? '' : ' · 关键词与行业名不一致（已标记）'),
    events: events.slice(0, 5),
    eventBoosted,
    ok: true,
  };
}

module.exports = { getNews, fetchEastmoneyContentNews, fetchEastmoneyAnnouncements, getHotNews, fetchKuaixunNews, normalizeNewsTime, classifyCategory, getSectorNewsSentiment, SECTOR_KEYWORDS, EVENT_KEYWORDS };

~~~

---

## `lib\newsSectorImpact.js`  ·  306 行

~~~js
/**
 * 新闻 → 行业板块影响识别（自学习数据层）
 * --------------------------------------------------------------
 * 对首页财经热点新闻，识别其可能影响的行业板块与热门个股，并给出涨跌方向。
 *
 * 方向规则：利好/看涨 → 红（A股惯例），利空/看跌 → 绿。
 * 识别方式：
 *   1) 关键词 → 板块映射（NEWS_SECTOR_MAP，含板块名 + 热门个股候选）
 *   2) 用 analyzeSentiment 判断利好/利空方向
 *   3) 部分关键词带方向偏置（如"降准/降息"利好银行、"减持"利空）
 *
 * 自学习：识别结果持久化，支持人工更正（见 server.js /api/news-impact/correct），
 * 通过学习库统计「关键词→板块」命中情况，为后续判断提供置信度。
 */

const { analyzeSentiment } = require('./analysis');

// 新闻关键词 → 板块 + 热门个股。keywords 命中即关联该板块；direction 为方向偏置（1 利好 / -1 利空 / 0 由情绪判断）
//
// ★ 20260914i 修法（用户投诉「智能家居补贴被归到食品饮料」）：
//   旧实现「遍历 NEWS_SECTOR_MAP，首条命中即归」有三个致命缺陷：
//     ① 泛词抢答：「食品饮料」行含泛词「消费」，而「促进智能家居消费行动方案」含「消费」→ 误归食品饮料；
//     ② 顺序决定归属：命中多个板块时，排在表前面的赢，与语义无关；
//     ③ 无排除机制：专属词（智能家居）无法否决泛词（消费）。
//   现改为「打分制 + 强排除」：
//     - 每个关键词按其**专属程度**给分（`exclusive` 专属词 3 分 / `keywords` 通用词 1 分）；
//     - 泛词（消费、政策、补贴、以旧换新…）单独放 `generic`，只给 0.5 分，且**永远不能单独定归属**；
//     - `exclude` 为强排除词：新闻命中某板块的 exclude 词则该板块直接出局（如食品饮料排除「智能家居/家电/家居」）；
//     - 取总分最高的板块；平局时取「专属词命中数」多者；仍平局才回退表序。
//   `generic` 泛词表：这些词单独出现不构成任何行业归属。
const GENERIC_KEYWORDS = [
  '消费', '促消费', '扩内需', '政策', '补贴', '扶持', '以旧换新', '试点', '规划',
  '通知', '方案', '意见', '措施', '部署', '支持', '鼓励', '优惠', '减免',
  // ★ 20260923k：新增「证券」。它是**市场基础设施名词**的子串（证券交易所／证券公司／
  //   证券时报／证券市场／证券业协会），本身不指向券商行业。
  //   实证：东财快讯「土耳其伊斯坦布尔**证券交易所**宣布 BIST-50 卖空适用报升规则」
  //   → 旧实现因「证券」是普通关键词（1 分）而整条归到「证券（券商）」板块
  //   → 经 matchWatchlist 按 sector 广播到自选股里的华安证券/长江证券
  //   → 变成国内券商的中度利空（误报，用户 2026-09-23 投诉）。
  //   降为泛词后：0.5 分且**不能单独定归属**（须有非泛词命中），「证券交易所」再也定不了板块。
  //   券商行业的归属改由 `exclusive: ['券商','证券公司','注册制','印花税','IPO']` 承担。
  '证券',
];
const GENERIC_SCORE = 0.5;
const EXCLUSIVE_SCORE = 3;
const NORMAL_SCORE = 1;

const NEWS_SECTOR_MAP = [
  // ★ 20260921a：医药生物拆「药品」与「医疗器械」两条（申万二级口径）。
  //   旧实现把「医药/医疗」全归一级'医药生物'，导致药监局「药品安全」政策误伤医疗器械股（如圣湘生物）。
  //   现拆为：① 药品/制药条线→'医药生物'（强排除 医疗器械/设备/IVD/体外诊断…）；
  //           ② 医疗器械/设备/IVD/体外诊断/影像/监护/耗材→'医疗器械'（强排除 药品/制药/疫苗/集采…）。
  //   两条互斥：含「药品」必走①、含「医疗器械」必走②，避免交叉误挂。
  // ★ 20260930a：删除「设备」这个**裸通用词**——它是所有「…设备」类产业名的公共后缀
  //   （风电设备/电力设备/机械设备/光伏设备…），在 text.includes() 子串匹配下必然跨行业误命中。
  //   实证：东财快讯「**风电设备**板块表现活跃 威力传动涨超10%」因命中医疗器械专属词「设备」(3分)
  //   而误归医疗器械（用户 2026-09-30 投诉）。现改为**医疗专属完整词**「医疗设备/医用设备/医疗仪器」。
  { keywords: ['mRNA', '疫苗', '创新药', '生物医药', '抗癌', '肿瘤', '临床', '医保', '集采', '医药', '药品', '制药', '药企', '仿制药', '生物制品', '中药', '化药'], exclusive: ['疫苗', '创新药', '生物医药', 'mRNA', '集采', '药品', '制药'], exclude: ['医疗器械', '医疗设备', '医用设备', 'IVD', '体外诊断', '影像', '监护', '耗材', '手术机器人', '医械'], sector: '医药生物', hotStocks: ['恒瑞医药', '药明康德', '智飞生物', '沃森生物', '康希诺'], direction: 0 },
  { keywords: ['医疗器械', '医疗', '医疗设备', '医用设备', '医疗仪器', 'IVD', '体外诊断', '诊断试剂', '影像', '监护', '耗材', '手术机器人', '医械', '医疗服务'], exclusive: ['医疗器械', '医疗设备', '医用设备', '医疗仪器', 'IVD', '体外诊断', '影像', '监护', '耗材', '手术机器人'], exclude: ['药品', '制药', '药企', '仿制药', '疫苗', '创新药', '生物制品', '集采', '医保'], sector: '医疗器械', hotStocks: ['迈瑞医疗', '鱼跃医疗', '联影医疗', '乐普医疗', '圣湘生物', '阳普医疗'], direction: 0 },
  { keywords: ['半导体', '芯片', '集成电路', '光刻', '晶圆', '封测'], exclusive: ['半导体', '芯片', '集成电路', '光刻', '晶圆', '封测'], exclude: [], sector: '半导体', hotStocks: ['中芯国际', '北方华创', '韦尔股份', '兆易创新'], direction: 0 },
  { keywords: ['人工智能', 'AI', '算力', '大模型', '数据中心', '光模块', 'CPO'], exclusive: ['人工智能', '算力', '大模型', 'CPO', '光模块'], exclude: [], sector: '计算机', hotStocks: ['科大讯飞', '浪潮信息', '中际旭创', '金山办公'], direction: 0 },
  // ★ 20260930a：「风电」「风电设备」提升为专属词——风电是明确的电力设备子赛道，
  //   使其在「…设备」类新闻里以 3 分稳胜，不再被其它含「设备」的板块抢答。
  { keywords: ['新能源', '光伏', '储能', '锂电', '电池', '风电', '风电设备', '充电桩'], exclusive: ['光伏', '储能', '锂电', '充电桩', '风电', '风电设备'], exclude: [], sector: '电力设备', hotStocks: ['宁德时代', '隆基绿能', '阳光电源', '亿纬锂能'], direction: 0 },
  { keywords: ['新能源车', '汽车', '智能驾驶', '自动驾驶', '整车'], exclusive: ['新能源车', '智能驾驶', '自动驾驶', '整车'], exclude: ['汽车零部件'], sector: '汽车', hotStocks: ['比亚迪', '长城汽车', '赛力斯'], direction: 0 },
  { keywords: ['房地产', '地产', '楼市', '限购', '房贷'], exclusive: ['房地产', '楼市', '限购', '房贷'], exclude: [], sector: '房地产', hotStocks: ['万科A', '保利发展', '招商蛇口'], direction: 0 },
  { keywords: ['降准', '降息', 'LPR', '存款利率', '银行', '信贷'], exclusive: ['降准', '降息', '存款利率', 'LPR'], exclude: [], sector: '银行', hotStocks: ['招商银行', '工商银行', '平安银行'], direction: 1 },
  // ★ 20260923k：「证券」已从本行 keywords **移除**（改入 GENERIC_KEYWORDS 泛词表），
  //   避免「证券交易所」这类**市场基础设施名词**把境外交易所的本地规则误归到券商板块。
  //   ⚠️ 但**境内**交易所的规则变更确实通过交易量/流动性传导到券商经纪业务，是合法事件 →
  //      补入**境内专属**交易所名（上交所/深交所/北交所/全国股转/新三板），它们绝不可能出现在境外新闻里，
  //      所以既能救回境内覆盖，又不会重新打开误配口子（伊斯坦布尔证券交易所→ 0 命中）。
  //      补入「证券公司」（= 券商同义词）与「证券业」同理。
  { keywords: ['券商', '证券公司', '证券业', '资本市场', '注册制', 'IPO', '印花税', '上交所', '深交所', '北交所', '上海证券交易所', '深圳证券交易所', '北京证券交易所', '全国股转', '新三板'], exclusive: ['券商', '证券公司', '注册制', '印花税', 'IPO', '上交所', '深交所', '北交所', '上海证券交易所', '深圳证券交易所', '北京证券交易所', '全国股转', '新三板'], exclude: [], sector: '证券', hotStocks: ['中信证券', '东方财富', '华泰证券'], direction: 0 },
  // ⚠️ 食品饮料：删掉泛词「消费」，改为精确的食品类词；并强排除家居/家电/家装/汽车等非食品品类
  { keywords: ['食品饮料', '酿酒', '必选消费', '调味品', '食品', '白酒', '啤酒', '乳制品', '零食', '粮油'], exclusive: ['食品饮料', '酿酒', '调味品', '白酒', '啤酒', '乳制品', '粮油', '酱油'], exclude: ['智能家居', '家居', '家装', '家电', '家用电器', '汽车', '手机', '数码', '装修', '家具'], sector: '食品饮料', hotStocks: ['贵州茅台', '五粮液', '泸州老窖'], direction: 0 },
  { keywords: ['煤炭', '动力煤', '焦煤'], exclusive: ['动力煤', '焦煤', '煤炭'], exclude: [], sector: '煤炭', hotStocks: ['中国神华', '陕西煤业', '兖矿能源'], direction: 0 },
  { keywords: ['黄金', '金价', '有色', '铜价', '锂矿', '稀土'], exclusive: ['黄金', '铜价', '锂矿', '稀土'], exclude: [], sector: '有色金属', hotStocks: ['紫金矿业', '山东黄金', '赣锋锂业'], direction: 0 },
  { keywords: ['石油', '油价', '原油', '天然气'], exclusive: ['油价', '原油', '天然气', '石油'], exclude: [], sector: '石油石化', hotStocks: ['中国石油', '中国石化', '中国海油'], direction: 0 },
  { keywords: ['军工', '国防', '航天', '航空', '卫星', '导弹'], exclusive: ['军工', '国防', '导弹', '航天'], exclude: [], sector: '国防军工', hotStocks: ['中航沈飞', '航发动力', '中直股份'], direction: 0 },
  // ⚠️ 家用电器：补上智能家居/家居/家装/全屋智能——这类词以前完全没有归属方
  { keywords: ['家电', '以旧换新', '家用电器', '智能家居', '家居', '家装', '全屋智能', '数字家庭', '适老化家居', '家电以旧换新'], exclusive: ['智能家居', '全屋智能', '家用电器', '家电', '家居', '家装', '数字家庭'], exclude: [], sector: '家用电器', hotStocks: ['美的集团', '格力电器', '海尔智家'], direction: 0 },
  { keywords: ['钢铁', '钢价'], exclusive: ['钢价', '钢铁'], exclude: [], sector: '钢铁', hotStocks: ['宝钢股份', '华菱钢铁'], direction: 0 },
  { keywords: ['保险', '保费'], exclusive: ['保费', '保险'], exclude: [], sector: '保险', hotStocks: ['中国平安', '中国人寿', '中国太保'], direction: 0 },
  { keywords: ['通信', '5G', '6G', '卫星互联网', '东数西算'], exclusive: ['5G', '6G', '卫星互联网', '东数西算'], exclude: [], sector: '通信', hotStocks: ['中兴通讯', '中国移动', '烽火通信'], direction: 0 },
  { keywords: ['环保', '碳中和', '碳交易'], exclusive: ['碳中和', '碳交易'], exclude: [], sector: '环保', hotStocks: ['瀚蓝环境', '伟明环保'], direction: 0 },
  { keywords: ['农业', '种业', '粮食', '养殖', '猪价'], exclusive: ['种业', '猪价', '粮食'], exclude: [], sector: '农林牧渔', hotStocks: ['牧原股份', '隆平高科', '温氏股份'], direction: 0 },
  { keywords: ['传媒', '游戏', '影视', '短剧', '出版'], exclusive: ['短剧', '游戏', '影视'], exclude: [], sector: '传媒', hotStocks: ['三七互娱', '分众传媒', '芒果超媒'], direction: 0 },
];

// ===== 裸通用词防护（20260930a，系统性防「泛词抢答」同类 bug）=====
// 教训链：① 20260914i「消费」抢答食品饮料；② 20260923k「证券」抢答券商；③ 20260930a「设备」抢答医疗器械。
//   共性是**裸通用词**（行业名公共后缀/泛称）在 `text.includes()` 子串匹配下必然跨行业误命中：
//   如「风电**设备**」「电力**设备**」「机械**设备**」都会命中「设备」→ 若它还是专属词(×3) 就会压过真板块。
// 处置：这些词**永远不得**作为 keywords / exclusive / exclude 参与定归属，加载时统一剔除并告警。
//   注意按**整词相等**判断（`GENERIC_TOKENS.has(k)`），故「医疗设备」「医疗服务」等复合词不受影响。
const GENERIC_TOKENS = new Set(['设备', '市场', '行业', '板块', '产业', '产品', '服务', '材料', '技术', '系统', '平台', '项目', '业务']);
(function sanitizeSectorMap() {
  const removed = [];
  for (const m of NEWS_SECTOR_MAP) {
    for (const field of ['keywords', 'exclusive', 'exclude']) {
      if (!Array.isArray(m[field])) continue;
      m[field] = m[field].filter(k => {
        if (GENERIC_TOKENS.has(k)) { removed.push(`${m.sector}.${field}=${k}`); return false; }
        return true;
      });
    }
  }
  if (removed.length) {
    console.warn('[NewsSectorImpact] 已剔除裸通用词（防跨行业误命中）:', removed.join(', '));
  }
})();

// 方向偏置词：命中时直接给方向，覆盖情绪判断（用于政策/事件类词）
const BULLISH_HINTS = ['降准', '降息', '利好', '扶持', '补贴', '获批', '突破', '超预期', '上调', '扩产', '中标', '加仓', '回购', '增持'];
const BEARISH_HINTS = ['加息', '利空', '限制', '制裁', '处罚', '调查', '减持', '下调', '亏损', '退市', '风险警示', '立案'];

// ===== 境外市场闸门（20260923k 重写）=====
// 旧实现是一串**硬编码城市/国家名**，覆盖不到土耳其/伊斯坦布尔/BIST 等，导致
//   「伊斯坦布尔证券交易所对BIST 50成分股卖空实施报升规则」被当作境内新闻放行 →
//   又因「证券交易所」字面命中「证券」→ 误归券商板块 → 变成国内券商的中度利空（用户投诉）。
// 白名单法天生漏（全球交易所上百家、国别两百多个），现改为**三层闸门**：
//
//   ① 境外主体词（国别/城市/机构/区域）—— 原名单 + 大幅扩充；
//   ② 境外交易所/指数**缩写正则**（BIST/NSE/B3/MOEX/Tadawul… 这类不会出现在中文 A 股新闻里）；
//   ③ 结构规则：命中 ①② 之一 **且** 谈论的是「交易所/市场交易制度」 **且** 全文无境内锚点
//      （A股/中国/证监会/沪深北交所/央行/人民币…）→ 直接拒收。
//
// ⚠️ 例外（必须保留）：**全球定价品种**（原油/黄金/铜/半导体/存储…）的境外信息**仍要进**——
//    它们的价格是全球同源的，对 A 股相关板块有真实传导路径（见 GLOBAL_PRICE_KEYWORDS）。
//
// 判定口径（可复用）：境外事件要进 A 股事件池，须至少有一条传导路径
//   ① 全球定价品种；② 直接作用于境内上市公司/监管/税费；③ 可比公司映射（中概股/跨境业务）。
//   只有「境外某交易所的本地交易规则」→ 无路径 → 拒收。
const FOREIGN_MARKET_HINTS = [
  // —— 原名单（保留）——
  '日经', '东京', '伦敦', '纽约', '美股', '纳斯达克', '道琼斯', '标普', '韩国', '欧洲',
  '港股', '恒生', '美元', '欧元', '英镑', '外汇', '汇率',
  // —— 20260923k 扩充：国别 ——
  '土耳其', '日本', '德国', '法国', '英国', '美国', '加拿大', '澳大利亚', '新西兰',
  '巴西', '墨西哥', '阿根廷', '智利', '秘鲁', '哥伦比亚', '俄罗斯', '南非', '尼日利亚',
  '肯尼亚', '埃及', '摩洛哥', '沙特', '阿联酋', '卡塔尔', '科威特', '以色列', '伊朗', '伊拉克',
  '印度', '巴基斯坦', '孟加拉', '斯里兰卡', '越南', '泰国', '印尼', '马来西亚', '新加坡',
  '菲律宾', '哈萨克斯坦', '乌兹别克斯坦', '瑞士', '瑞典', '挪威', '丹麦', '芬兰', '荷兰',
  '比利时', '奥地利', '爱尔兰', '葡萄牙', '西班牙', '意大利', '希腊', '波兰', '捷克',
  '匈牙利', '罗马尼亚', '乌克兰', '蒙古', '缅甸', '柬埔寨', '老挝',
  // —— 20260923k 扩充：境内外主要金融城市 ——
  '伊斯坦布尔', '安卡拉', '首尔', '大阪', '名古屋', '法兰克福', '慕尼黑', '巴黎', '米兰',
  '马德里', '阿姆斯特丹', '苏黎世', '日内瓦', '斯德哥尔摩', '奥斯陆', '哥本哈根', '赫尔辛基',
  '都柏林', '布鲁塞尔', '维也纳', '里斯本', '雅典', '华沙', '布拉格', '布达佩斯', '莫斯科',
  '圣保罗', '里约', '墨西哥城', '布宜诺斯艾利斯', '圣地亚哥', '利马', '波哥大',
  '约翰内斯堡', '开普敦', '开罗', '内罗毕', '拉各斯', '利雅得', '迪拜', '阿布扎比', '多哈',
  '孟买', '新德里', '胡志明', '河内', '雅加达', '曼谷', '吉隆坡', '马尼拉', '卡拉奇',
  '悉尼', '墨尔本', '多伦多', '温哥华', '奥克兰',
  // —— 20260923k 扩充：境外监管/机构/区域概念 ——
  // ⚠️ 只用**无歧义全称**，不放 SEC/CFTC/FCA/MAS/SFC 这类短英文缩写：
  //    它们是 `text.includes()` 子串匹配，会误伤普通英文词（如 SECTION 含 SEC）。
  '土耳其里拉', '新兴市场', '美联储', '欧洲央行', '英国央行', '日本央行', '澳洲联储', '韩国央行',
];
// 境外交易所/指数缩写。⚠️ 刻意**不加 `/i`**：全大写才匹配，
// 否则 'SIX'/'SET'/'PSI'/'STI' 会命中普通英文小写词（six/set/psi/sti）→ 大面积误拒。
// ⚠️ 已剔除 'SET'（与英文 set 同形）与 'PX'、'IPC'（歧义高）。
const FOREIGN_EXCHANGE_RE = /\b(BIST|NSE|BSE|IDX|MOEX|Tadawul|DFM|ADX|JSE|B3|BMV|KRX|KOSPI|KOSDAQ|TWSE|TAIEX|JPX|TOPIX|NIKKEI|SGX|STI|KLSE|PSE|ASX|TSX|SIX|LSE|FTSE|DAX|CAC|FTSEMIB|IBEX|AEX|OMXS|OBX|OMXC|OMXH|WIG|BUX|ATX|PSI|RTS|MICEX|ISX|NZ50|Bovespa|Merval|IPSA|IGBVL|COLCAP)\b/;
// 全球定价品种：境外信息**仍要进**——价格全球同源，对 A 股相关板块有真实传导路径
const GLOBAL_PRICE_KEYWORDS = ['原油', '油价', '黄金', '金价', '铜', '锂', '稀土', '石油', '天然气', '芯片', '半导体', '存储'];
// 境内锚点：命中任一 → 认为是「境内为主的混合新闻」，不适用境外闸门（豁免）
const DOMESTIC_ANCHORS = ['A股', '中国', '我国', '国内', '境内', '证监会', '沪深', '上交所', '深交所', '北交所', '央行', '人民币', '中证', '国务院', '国资委', '银保监', '国家金融监督管理总局'];
/**
 * 境外闸门判定（20260923k）—— 返回 true 表示「应拒收，不映射 A 股板块」。
 * 顺序（每一步都有明确理由，勿随意调换）：
 *   ① 全球定价品种（原油/黄金/铜/半导体/存储…）→ 放行。价格全球同源，有真实传导路径。
 *   ② 无境外主体（国别/城市/机构词 或 境外交易所缩写）→ 放行。不是境外新闻，闸门不适用。
 *   ③ 有境内锚点（A股/中国/证监会/沪深北交所/央行/人民币…）→ 放行。属境内为主的混合新闻。
 *   ④ 其余（境外主体 + 无境内锚点）→ 拒收。
 * 口径保守取「宁拒勿错」：误报（把境外事件算成 A 股利空）代价远高于漏报（用户既定原则）。
 * 反例（本函数要拦的）：伊斯坦布尔证券交易所对 BIST-50 卖空实施报升规则 → 与国内券商无因果链。
 * 正例（本函数必须放过的）：中国石化与沙特阿美签约 / 挪威主权基金增持A股 / 全球油价上涨。
 */
function isForeignMarketNews(text) {
  if (GLOBAL_PRICE_KEYWORDS.some(k => text.includes(k))) return false;   // ①
  const hitEntity = FOREIGN_MARKET_HINTS.some(k => text.includes(k)) || FOREIGN_EXCHANGE_RE.test(text);
  if (!hitEntity) return false;                                          // ②
  if (DOMESTIC_ANCHORS.some(k => text.includes(k))) return false;        // ③
  return true;                                                           // ④
}
// 兼容旧名（其他模块若引用）：只按主体词判断
const FOREIGN_MARKET_ENTITIES = FOREIGN_MARKET_HINTS;

/**
 * 板块定归属（打分制）—— 20260914i 新增
 * --------------------------------------------------------------
 * 旧实现「首条命中即归」会被泛词抢答（「消费」→ 食品饮料），且顺序决定归属。
 * 现按关键词专属程度打分，取最高分板块：
 *   1) 强排除：命中该板块任一 exclude 词 → 该板块直接出局；
 *   2) 打分：exclusive 专属词 ×3 / keywords 通用词 ×1 / GENERIC 泛词 ×0.5；
 *   3) 泛词（消费/补贴/以旧换新…）只给分，**不能单独定归属**（必须有非泛词命中）；
 *   4) 裁决：总分降序 → 专属词命中数降序 → 表序（保证确定性）。
 * 返回命中的 map 项，或 null。
 */
function pickSector(text) {
  const scored = [];
  for (let i = 0; i < NEWS_SECTOR_MAP.length; i++) {
    const m = NEWS_SECTOR_MAP[i];
    // 1) 强排除
    if ((m.exclude || []).some(k => text.includes(k))) {
      scored.push({ m, i, score: 0, exHit: 0, nonGenericHit: 0, excluded: true });
      continue;
    }
    const ex = m.exclusive || [];
    const exHit = ex.filter(k => text.includes(k)).length;
    const normalHit = (m.keywords || []).filter(k => !ex.includes(k) && text.includes(k)).length;
    const genericHit = GENERIC_KEYWORDS.filter(k => text.includes(k)).length;
    // 2) 打分
    const score = exHit * EXCLUSIVE_SCORE + normalHit * NORMAL_SCORE + genericHit * GENERIC_SCORE;
    // 3) 泛词不能单独定归属
    const nonGenericHit = exHit + normalHit;
    scored.push({ m, i, score, exHit, nonGenericHit, excluded: false });
  }
  const eligible = scored.filter(s => !s.excluded && s.nonGenericHit > 0 && s.score > 0);
  if (!eligible.length) return null;
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.exHit !== a.exHit) return b.exHit - a.exHit;
    return a.i - b.i; // 表序兜底，保证结果确定
  });
  const win = eligible[0];
  win.m.__score = win.score;
  win.m.__exHit = win.exHit;
  return win.m;
}

/**
 * 对单条新闻识别板块影响。
 * 返回 { sector, hotStocks, direction, signal, note } 或 null（无关联板块）。
 * direction: 'up'=看涨(红) / 'down'=看跌(绿) / 'neutral'=中性
 */
/** 20261021j A1（用户报障「证监会支持并购重组被判利空-3」）：
 * 东财热新闻条目偶发 **summary 与 title 讲两件事**（标题"支持并购重组"、摘要"禁止调研费用转移支付"），
 * 方向判定与 LLM 定性都吃 title+summary → 方向被错配摘要带偏（该条落库 signal=-1，只看标题实测=0）。
 * 守卫：标题的 CJK 二元组在摘要中的覆盖率过低 → 判"错配"，弃用摘要、只按标题判。
 * 阈值：覆盖率 ≥0.2 且命中 ≥2 个二元组才算同题；标题太短（<6 个有效字符）不判（宁缺勿滥）。 */
function summaryMatchesTitle(title, summary) {
  const sum = String(summary || '').trim();
  if (!sum) return true; // 没摘要就谈不上错配
  const tt = String(title || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');
  if (tt.length < 6) return true;
  const grams = new Set();
  for (let i = 0; i + 2 <= tt.length; i++) grams.add(tt.slice(i, i + 2));
  if (!grams.size) return true;
  const ss = sum.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');
  let hits = 0;
  for (const g of grams) if (ss.includes(g)) hits++;
  return (hits / grams.size) >= 0.2 && hits >= 2;
}

function analyzeNewsImpact(title, summary) {
  // 20261021j A1：错配摘要不参与方向判定（同一守卫在 eventEngine 扫描层还会拦 LLM 输入与自选股匹配）
  let effSummary = String(summary || '');
  let summaryDropped = false;
  if (effSummary && !summaryMatchesTitle(title, effSummary)) { effSummary = ''; summaryDropped = true; }
  const text = (title || '') + ' ' + effSummary;
  if (!text.trim()) return null;
  // 境外市场新闻（日经/伦敦/纽约等）不映射 A 股板块，除非涉及全球定价的大宗/科技品
  // 境外闸门（20260923k 重写）：境外主体 + 市场交易制度 + 无境内锚点 → 与 A 股无因果链，拒收。
  // 例外：全球定价品种（原油/黄金/半导体…）不受拦，见 isForeignMarketNews。
  if (isForeignMarketNews(text)) return null;
  const matched = pickSector(text);
  if (!matched) return null;

  // 方向：先看方向偏置词，再看整体情绪
  let direction = 'neutral';
  let signal = 0;
  const hasBull = BULLISH_HINTS.some(k => text.includes(k));
  const hasBear = BEARISH_HINTS.some(k => text.includes(k));
  if (matched.direction === 1) { direction = 'up'; signal = 1; }
  else if (matched.direction === -1) { direction = 'down'; signal = -1; }
  else if (hasBull && !hasBear) { direction = 'up'; signal = 1; }
  else if (hasBear && !hasBull) { direction = 'down'; signal = -1; }
  else {
    const s = analyzeSentiment(text);
    if (s.score > 15) { direction = 'up'; signal = 1; }
    else if (s.score < -15) { direction = 'down'; signal = -1; }
    else { direction = 'neutral'; signal = 0; }
  }

  return {
    sector: matched.sector,
    hotStocks: matched.hotStocks,
    direction,
    signal,
    note: `关键词命中「${matched.sector}」板块（打分 ${matched.__score != null ? matched.__score : '-'}，专属词 ${matched.__exHit != null ? matched.__exHit : 0}）${summaryDropped ? '；摘要与标题疑似错配，已弃用摘要只按标题判' : ''}`,
  };
}

/**
 * 批量识别新闻列表的板块影响，返回带 impact 字段的新数组（仅给命中的新闻加 impact）。
 */
function annotateNewsImpact(items) {
  return (items || []).map(n => {
    const impact = analyzeNewsImpact(n.title, n.summary);
    return impact ? { ...n, impact } : n;
  });
}

module.exports = { analyzeNewsImpact, annotateNewsImpact, NEWS_SECTOR_MAP, pickSector, GENERIC_KEYWORDS, GENERIC_TOKENS, isForeignMarketNews, FOREIGN_MARKET_HINTS, GLOBAL_PRICE_KEYWORDS, summaryMatchesTitle };

~~~

---

## `lib\pbcMacro.js`  ·  48 行

~~~js
/**
 * 人民银行宏观数据（社融，确定性数据，非 AI）Node 包装层。
 * 通过 async execFile 调用 scripts/pbc_social_financing.py（pandas 解析央行 xlsx）。
 * 失败时返回 {ok:false} 而非抛异常，由上层降级为占位卡片。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pbc_social_financing.py');
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时内存缓存（社融为月度低频数据）
let _cache;
function _getCache() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;
  return undefined;
}
function _setCache(data) {
  _cache = { ts: Date.now(), data };
}

async function getSocialFinancing() {
  const cached = _getCache();
  if (cached) return cached;
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'pbc_social_financing.py 不存在' };
  try {
    const out = await execFileAsync(py, [SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    const r = parsed && parsed.ok ? parsed : { ...(parsed || {}), ok: false };
    _setCache(r);
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'PBC 调用失败' };
  }
}

module.exports = { getSocialFinancing };

~~~

---

## `lib\pdfText.js`  ·  107 行

~~~js
/**
 * PDF 文本提取（本地资料库财报正文）
 * --------------------------------
 * 通过 scripts/pdf_extract_text.py（pdfplumber）提取财报 PDF 前 N 页正文，
 * 供财报解读本地上下文使用。结果按「文件路径 + mtime + 参数」缓存到
 * data/cache/pdf_text/，避免重复解析大文件（年报 PDF 通常 3-8MB）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pdf_extract_text.py');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'pdf_text');

let _pyCache = null;
let _pyChecked = false;
// [20261015a] 失败不再永久缓存（同 stockData/pyRuntime 口径）：受管 Python 是指向
// WorkBuddy 应用资源目录的符号链接，自更新窗口内探测会瞬时全败；失败冷却 60s 后重探。
let _pyFailUntil = 0;
const PY_FAIL_COOLDOWN_MS = 60 * 1000;

// 探测可用且带 pdfplumber 的 Python 解释器（候选顺序与 server.js findPython 一致，
// 但以 import pdfplumber 成功为准——本功能强依赖该库）
function findPdfPython() {
  if (_pyChecked) return _pyCache;
  if (Date.now() < _pyFailUntil) return null; // 失败冷却期内直接复用失败结论
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import pdfplumber'], { timeout: 15000, windowsHide: true });
      if (r && !r.error && r.status === 0) {
        _pyCache = c;
        _pyChecked = true;
        return c;
      }
    } catch (e) { /* 尝试下一个候选 */ }
  }
  _pyCache = null;
  _pyFailUntil = Date.now() + PY_FAIL_COOLDOWN_MS;
  return null;
}

function cacheKeyOf(pdfPath, maxPages, charCap) {
  let mtime = 0;
  try { mtime = fs.statSync(pdfPath).mtimeMs; } catch (e) { /* ignore */ }
  const raw = `${pdfPath}|${mtime}|${maxPages}|${charCap}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/**
 * 提取 PDF 前若干页正文。
 * @param {string} pdfPath 绝对路径
 * @param {object} opts { maxPages=40, charCap=28000, timeoutMs=150000 }
 * @returns {Promise<{ok:boolean, text?:string, pages?:number, total_pages?:number, truncated?:boolean, cached?:boolean, error?:string}>}
 */
async function extractPdfText(pdfPath, opts = {}) {
  const { maxPages = 40, charCap = 28000, timeoutMs = 150000 } = opts;
  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok: false, error: '文件不存在' };

  const key = cacheKeyOf(pdfPath, maxPages, charCap);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.ok) return { ...c, cached: true };
    }
  } catch (e) { /* 缓存损坏则重新提取 */ }

  const py = findPdfPython();
  if (!py) return { ok: false, error: '无可用的 Python（pdfplumber）环境' };

  try {
    const res = await execFileAsync(py, [
      SCRIPT, '--file', pdfPath,
      '--max-pages', String(maxPages),
      '--char-cap', String(charCap),
    ], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const data = JSON.parse(String(res.stdout || '').trim());
    if (data && data.ok) {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
      } catch (e) { /* 写缓存失败不影响本次结果 */ }
      return { ...data, cached: false };
    }
    return { ok: false, error: (data && data.error) || 'PDF 提取失败' };
  } catch (e) {
    return { ok: false, error: 'PDF 提取执行失败: ' + (e.message || e) };
  }
}

module.exports = { extractPdfText };

~~~

---

## `lib\posModel135.js`  ·  691 行

~~~js
// lib/posModel135.js —— 量价判定模型合并版 v2 · 主轴 135 格知识表（20261105f 定版固化）
// 数据逐字来自用户提供的判定标准文本（data/_gen_map_long.js + _gen_map_merged2.js 提取），为引擎与页面生成器的同源真值。
// 结构：ZONES[3 分区] → states[3 状态] → vols[3 量能] → rows[上涨/震荡/下跌 3 档]；
//       STRONG[分区][状态][量能] = { 大涨, 大跌 }（54 格强形态，12 格为推导、带 derived 标注）。
// 查询：volCell(zone, state, vol, tier5) → { key, verdict, conclusion, derived } | null
'use strict';
const ZONES = [
  {
    "name": "① 高位区间",
    "pct": "价格百分位 ≥70%",
    "states": [
      {
        "name": "趋势向上",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向上+放量上涨",
                "资金主动推升，强势延续；⚠️如果是天量，资金分歧放大，见顶风险显著升高"
              ],
              [
                "当日震荡",
                "价格高位+趋势向上+放量震荡",
                "多空分歧加大，资金开始换手，滞涨信号，警惕拐头"
              ],
              [
                "当日下跌",
                "价格高位+趋势向上+放量下跌",
                "主力兑现离场，抛压释放，趋势大概率即将反转"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向上+平量上涨",
                "上涨动能衰减，跟进资金不足，上涨持续性偏弱"
              ],
              [
                "当日震荡",
                "价格高位+趋势向上+平量震荡",
                "多空暂时平衡，资金观望，方向等待选择"
              ],
              [
                "当日下跌",
                "价格高位+趋势向上+平量下跌",
                "抛压温和释放，多头承接乏力，慢慢走弱"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向上+缩量上涨",
                "浮筹锁定，但增量资金枯竭，属于无量虚涨，容易回落"
              ],
              [
                "当日震荡",
                "价格高位+趋势向上+缩量震荡",
                "交易情绪降温，资金观望，变盘窗口临近"
              ],
              [
                "当日下跌",
                "价格高位+趋势向上+缩量下跌",
                "抛压暂时不大，多头尚有抵抗，不一定直接走熊"
              ]
            ]
          }
        ]
      },
      {
        "name": "趋势向下",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向下+放量上涨",
                "反弹资金进场，属于高位反弹，大多是诱多"
              ],
              [
                "当日震荡",
                "价格高位+趋势向下+放量震荡",
                "反弹换手激烈，上方抛压很重，反弹空间有限"
              ],
              [
                "当日下跌",
                "价格高位+趋势向下+放量下跌",
                "抛压集中释放，空头主导，下跌加速信号"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向下+平量上涨",
                "反弹缺少增量，反弹持续性差"
              ],
              [
                "当日震荡",
                "价格高位+趋势向下+平量震荡",
                "下跌途中短暂休整，休整后继续下行概率大"
              ],
              [
                "当日下跌",
                "价格高位+趋势向下+平量下跌",
                "下跌节奏平稳，空头趋势延续"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "价格高位+趋势向下+缩量上涨",
                "无量反弹，没有资金认可，反弹极易夭折"
              ],
              [
                "当日震荡",
                "价格高位+趋势向下+缩量震荡",
                "交投冷清，空头暂时歇脚，不是企稳信号"
              ],
              [
                "当日下跌",
                "价格高位+趋势向下+缩量下跌",
                "抛压慢慢衰竭，但不代表见底，只是跌速放缓"
              ]
            ]
          }
        ]
      },
      {
        "name": "区间震荡",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "价格高位+震荡+放量上涨",
                "试探震荡上沿，放量是试盘，能否突破看后续承接"
              ],
              [
                "当日震荡",
                "价格高位+震荡+放量震荡",
                "震荡区间内部剧烈换手，资金博弈加剧，即将选择方向"
              ],
              [
                "当日下跌",
                "价格高位+震荡+放量下跌",
                "冲击震荡下沿，抛压变强，有向下破位风险"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "价格高位+震荡+平量上涨",
                "靠近上沿，动能一般，突破难度高"
              ],
              [
                "当日震荡",
                "价格高位+震荡+平量震荡",
                "震荡常态，没有明确方向信号"
              ],
              [
                "当日下跌",
                "价格高位+震荡+平量下跌",
                "向震荡下沿靠近，承接一般"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "价格高位+震荡+缩量上涨",
                "无量摸上沿，很难有效突破"
              ],
              [
                "当日震荡",
                "价格高位+震荡+缩量震荡",
                "震荡进入尾声，交投低迷，等待放量打破平衡"
              ],
              [
                "当日下跌",
                "价格高位+震荡+缩量下跌",
                "向下试探，抛压不强，区间结构暂时完好"
              ]
            ]
          }
        ]
      }
    ]
  },
  {
    "name": "② 中位区间",
    "pct": "价格百分位 30%～70%",
    "states": [
      {
        "name": "趋势向上",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向上+放量上涨",
                "健康主升，量价配合，趋势延续性较好"
              ],
              [
                "当日震荡",
                "中位+趋势向上+放量震荡",
                "途中换手洗盘，清洗浮筹，洗盘后继续上行概率高"
              ],
              [
                "当日下跌",
                "中位+趋势向上+放量下跌",
                "短期集中抛压，需要重点观察支撑，谨防趋势拐头"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向上+平量上涨",
                "稳步抬升，节奏温和，属于良性上涨"
              ],
              [
                "当日震荡",
                "中位+趋势向上+平量震荡",
                "正常休整，多空均衡"
              ],
              [
                "当日下跌",
                "中位+趋势向上+平量下跌",
                "小幅回踩，多头趋势里的正常回调"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向上+缩量上涨",
                "筹码稳定，但是缺少增量，上涨后劲不足"
              ],
              [
                "当日震荡",
                "中位+趋势向上+缩量震荡",
                "洗盘接近尾声，等待放量再起"
              ],
              [
                "当日下跌",
                "中位+趋势向上+缩量下跌",
                "缩量回踩，抛压不大，大概率是良性回调"
              ]
            ]
          }
        ]
      },
      {
        "name": "趋势向下",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向下+放量上涨",
                "放量反弹，资金进场博弈反弹，重点观察能否扭转下跌趋势"
              ],
              [
                "当日震荡",
                "中位+趋势向下+放量震荡",
                "多空激烈争夺，反弹抵抗，方向未定"
              ],
              [
                "当日下跌",
                "中位+趋势向下+放量下跌",
                "抛压释放，下跌趋势加速"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向下+平量上涨",
                "反弹力度有限，很难直接反转"
              ],
              [
                "当日震荡",
                "中位+趋势向下+平量震荡",
                "下跌中途休整平台"
              ],
              [
                "当日下跌",
                "中位+趋势向下+平量下跌",
                "下跌趋势平稳延续"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "中位+趋势向下+缩量上涨",
                "无量反弹，可信度低"
              ],
              [
                "当日震荡",
                "中位+趋势向下+缩量震荡",
                "交投冷淡，反弹无力"
              ],
              [
                "当日下跌",
                "中位+趋势向下+缩量下跌",
                "跌速放缓，抛压逐步消耗"
              ]
            ]
          }
        ]
      },
      {
        "name": "区间震荡",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "中位震荡+放量上涨",
                "放量试探上轨，突破有效性看后续确认"
              ],
              [
                "当日震荡",
                "中位震荡+放量震荡",
                "区间内分歧加大，方向选择节点"
              ],
              [
                "当日下跌",
                "中位震荡+放量下跌",
                "放量试探下轨，破位风险上升"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "中位震荡+平量上涨",
                "靠近上轨，动能一般"
              ],
              [
                "当日震荡",
                "中位震荡+平量震荡",
                "标准震荡行情，无信号"
              ],
              [
                "当日下跌",
                "中位震荡+平量下跌",
                "靠近下轨，承接一般"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "中位震荡+缩量上涨",
                "无量冲轨，很难突破"
              ],
              [
                "当日震荡",
                "中位震荡+缩量震荡",
                "震荡收敛，等待放量选择方向"
              ],
              [
                "当日下跌",
                "中位震荡+缩量下跌",
                "下沿试探，抛压不大，区间暂时安全"
              ]
            ]
          }
        ]
      }
    ]
  },
  {
    "name": "③ 低位区间",
    "pct": "价格百分位 ≤30%",
    "states": [
      {
        "name": "趋势向上",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向上+放量上涨",
                "底部启动信号；放量级别越大，启动可靠性越高"
              ],
              [
                "当日震荡",
                "低位+趋势向上+放量震荡",
                "底部换手洗盘，消化前期套牢盘"
              ],
              [
                "当日下跌",
                "低位+趋势向上+放量下跌",
                "底部反复挖坑，抛压释放，注意是否为假启动"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向上+平量上涨",
                "初步抬升，资金试探，反转信号偏弱"
              ],
              [
                "当日震荡",
                "低位+趋势向上+平量震荡",
                "底部磨底阶段，多空平衡"
              ],
              [
                "当日下跌",
                "低位+趋势向上+平量下跌",
                "底部反复磨底，支撑尚在"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向上+缩量上涨",
                "套牢盘少，但缺少买盘，反弹持续性弱"
              ],
              [
                "当日震荡",
                "低位+趋势向上+缩量震荡",
                "交投清淡，磨底阶段；⚠️如果是地量，恐慌基本出清"
              ],
              [
                "当日下跌",
                "低位+趋势向上+缩量下跌",
                "抛压枯竭，下跌空间有限"
              ]
            ]
          }
        ]
      },
      {
        "name": "趋势向下",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向下+放量上涨",
                "低位放量抵抗，有资金尝试承接，观察能否止跌"
              ],
              [
                "当日震荡",
                "低位+趋势向下+放量震荡",
                "恐慌盘和抄底盘互搏，博弈底部"
              ],
              [
                "当日下跌",
                "低位+趋势向下+放量下跌",
                "恐慌集中释放，最后一跌的一种可能"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向下+平量上涨",
                "小幅抵抗，止跌信号不强"
              ],
              [
                "当日震荡",
                "低位+趋势向下+平量震荡",
                "下跌放缓，进入磨底阶段"
              ],
              [
                "当日下跌",
                "低位+趋势向下+平量下跌",
                "缓慢阴跌，底部还没确认"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "低位+趋势向下+缩量上涨",
                "无量小反弹，抄底意愿弱"
              ],
              [
                "当日震荡",
                "低位+趋势向下+缩量震荡",
                "交易冷清；⚠️如果是地量，大概率接近底部区域"
              ],
              [
                "当日下跌",
                "低位+趋势向下+缩量下跌",
                "抛压衰竭，阴跌尾声，不要盲目杀跌"
              ]
            ]
          }
        ]
      },
      {
        "name": "区间震荡",
        "vols": [
          {
            "name": "放量",
            "rows": [
              [
                "当日上涨",
                "低位震荡+放量上涨",
                "放量试探震荡上沿，有尝试脱离底部的意图"
              ],
              [
                "当日震荡",
                "低位震荡+放量震荡",
                "底部换手，多空博弈激烈"
              ],
              [
                "当日下跌",
                "低位震荡+放量下跌",
                "下沿试盘，恐慌盘涌出"
              ]
            ]
          },
          {
            "name": "平量",
            "rows": [
              [
                "当日上涨",
                "低位震荡+平量上涨",
                "小幅向上试探，力度不足"
              ],
              [
                "当日震荡",
                "低位震荡+平量震荡",
                "标准底部箱体磨底"
              ],
              [
                "当日下跌",
                "低位震荡+平量下跌",
                "回踩箱体下沿"
              ]
            ]
          },
          {
            "name": "缩量",
            "rows": [
              [
                "当日上涨",
                "低位震荡+缩量上涨",
                "无量反弹，很难突破箱体"
              ],
              [
                "当日震荡",
                "低位震荡+缩量震荡",
                "地量常出现在这里，底部磨盘典型特征"
              ],
              [
                "当日下跌",
                "低位震荡+缩量下跌",
                "回踩下沿，抛压很小，箱体支撑有效"
              ]
            ]
          }
        ]
      }
    ]
  }
];

const STRONG = {
  '① 高位区间': {
    '趋势向上': { // ← 旧图「高位区」强形态逐字映射
      '放量': { '大涨': '高位放量大涨，多空分歧最大，多为诱多拉升或最后一冲；警惕主力对倒出货，严禁追高', '大跌': '高位放量大跌，获利盘集中出逃、主力派发明确；头部确认信号，下跌空间打开，优先减仓离场' },
      '平量': { '大涨': '高位平量大涨，量能不济却强行拉升，多头透支信号；冲高持续性差，警惕见顶回落', '大跌': '高位平量大跌，无承接盘的阴跌加速；主力多已在前期完成派发，破位风险高，规避' },
      '缩量': { '大涨': '高位缩量大涨，无量虚涨、买盘枯竭；多为诱多脉冲，随时可能拐头，谨防跳水', '大跌': '高位缩量大跌，承接稀少直接砸穿，抛压无需放量即可打压；头部结构强化，尽快离场' },
    },
    '趋势向下': { // （合并推导）按旧图高位区语料折中
      '放量': { '大涨': '高位趋势向下放量大涨，属于高位反弹诱多；反弹空间有限，反弹结束继续下行，不追', '大跌': '高位趋势向下放量大跌，头部破位后恐慌加速；下跌空间打开，空头主导，优先离场' },
      '平量': { '大涨': '高位趋势向下平量大涨，无量反抽；承接不足持续性差，反弹结束延续下行', '大跌': '高位趋势向下平量大跌，空头主导的阴跌加速；趋势未变，继续规避' },
      '缩量': { '大涨': '高位趋势向下缩量大涨，无量虚涨诱多；买盘枯竭，随时回落，谨防跳水', '大跌': '高位趋势向下缩量大跌，承接枯竭的阴跌；跌速或放缓但趋势未变，不宜抄底' },
    },
    '区间震荡': { // ← 旧图「高位箱体」强形态逐字
      '放量': { '大涨': '放量大涨突破箱体上沿；高位诱多突破概率大，警惕拉高出货，谨慎追入', '大跌': '放量大跌砸穿箱体下沿；头部确立，箱体支撑失效，下跌空间打开，优先离场' },
      '平量': { '大涨': '平量大涨冲上沿；多头透支的虚假突破，冲高持续性差，警惕见顶', '大跌': '平量大跌破下沿；无承接阴跌破位，箱体下沿失守后易加速，规避' },
      '缩量': { '大涨': '缩量大涨冲高；买盘枯竭的虚涨突破，随时回落，谨防跳水', '大跌': '缩量大跌跌破下沿；承接稀少的破位，头部结构强化，尽快离场' },
    },
  },
  '② 中位区间': {
    '趋势向上': { // ← 旧图「上涨途中」强形态逐字映射
      '放量': { '大涨': '上涨途中放量大涨，增量资金加速进场；主升浪特征，结构健康强势，可顺势持有', '大跌': '上涨途中放量大跌，获利盘集中兑现引发的急洗盘；只要趋势支撑不破，多为快速换手，观察止跌后的资金回补' },
      '平量': { '大涨': '上涨途中平量大涨，量能未跟上涨幅，上涨动能存疑；留意后续是否补量，若持续缩量滞涨则阶段见顶风险上升', '大跌': '上涨途中平量大跌，多空分歧有限、无恐慌放量；多为节奏性回调，紧盯趋势支撑，不破可继续观察' },
      '缩量': { '大涨': '上涨途中缩量大涨，筹码高度锁定、惜售推升；控盘度高的强势特征，趋势易延续', '大跌': '上涨途中缩量大跌，抛压虽不重但无承接，走势偏离健康节奏；警惕趋势转弱，关注支撑位能否守住' },
    },
    '趋势向下': { // ← 旧图「下跌途中」强形态逐字映射
      '放量': { '大涨': '下跌途中放量大涨，短线资金抄底博反弹；诱多概率大，快进快出持续性差，不当作反转', '大跌': '下跌途中放量大跌，恐慌集中释放、空头加速；下跌动能强，坚决回避，等待企稳信号' },
      '平量': { '大涨': '下跌途中平量大涨，无增量资金的超跌脉冲；反弹动能不足，反弹结束后大概率延续下行', '大跌': '下跌途中平量大跌，无恐慌释放也无承接，空头温和持续；趋势无企稳信号，继续规避' },
      '缩量': { '大涨': '下跌途中缩量大涨，无量反弹缺乏资金认可；弱势反抽，反弹后继续创新低概率大', '大跌': '下跌途中缩量大跌，卖盘持续而承接枯竭；阴跌加速段，下跌周期未见尽头，规避' },
    },
    '区间震荡': { // ← 引擎「震荡整理中性箱体」强形态逐字（中位震荡语境）
      '放量': { '大涨': '放量大涨突破箱体上沿；有效突破信号增强，需次日确认站稳上沿，谨防假突破', '大跌': '放量大跌砸破箱体下沿；破位信号增强，观察能否快速收回，收不回则箱体失效、方向选择向下' },
      '平量': { '大涨': '平量大涨向上离开箱体；量能未放大的突破可信度低，需补量确认', '大跌': '平量大跌向下离开箱体；无承接的破位，箱体延续性被破坏，方向选择向下风险大' },
      '缩量': { '大涨': '缩量大涨冲上箱体上沿；量能不足的突破，假突破概率大，容易遇阻回落', '大跌': '缩量大跌砸向箱体下沿；承接偏弱的破位尝试，关注下轨能否止跌' },
    },
  },
  '③ 低位区间': {
    '趋势向上': { // （合并推导）按旧图低位区/上涨途中语料折中
      '放量': { '大涨': '低位趋势向上放量大涨，底部启动与增量资金共振；启动确认信号，放量级别越大可靠性越高', '大跌': '低位趋势向上放量大跌，底部反复洗盘挖坑；抛压释放，重点观察趋势支撑能否守住' },
      '平量': { '大涨': '低位趋势向上平量大涨，试探性抬升；反转信号偏弱，需后续放量确认后再跟进', '大跌': '低位趋势向上平量大跌，磨底中的反复回踩；支撑尚在，重点观察是否假跌破' },
      '缩量': { '大涨': '低位趋势向上缩量大涨，套牢盘少但买盘有限；反弹持续性存疑，谨防冲高回落', '大跌': '低位趋势向上缩量大跌，抛压枯竭的浅回踩；下跌空间有限，大概率良性回踩' },
    },
    '趋势向下': { // ← 旧图「低位区」强形态逐字映射
      '放量': { '大涨': '低位放量大涨，大资金集中进场信号明确；反转启动概率高，若能持续放量突破压力位，行情有望从磨底升级为反转', '大跌': '低位放量大跌，恐慌盘集中宣泄、空头最后释放；常见挖坑 / 赶底动作，杀跌后易现长针探底，不宜跟随杀跌' },
      '平量': { '大涨': '低位平量大涨，量能未放大却大幅推升，缺乏增量资金背书；多为脉冲式反弹，需后续放量确认后才可跟进', '大跌': '低位平量大跌，无恐慌放量也无主动承接，多属阴跌加速段；底部信号仍需量能结构确认，不宜提前抄底' },
      '缩量': { '大涨': '低位缩量大涨，买盘稀少却大幅推升股价，多为超跌反抽或试探性拉升；缺乏量能支撑，持续性存疑，谨防冲高回落', '大跌': '低位缩量大跌，卖压释放但承接同样稀少；多见于流动性差的阴跌尾声，等待地量与承接信号共同确认底部' },
    },
    '区间震荡': { // ← 旧图「底部箱体」强形态逐字
      '放量': { '大涨': '放量大涨突破箱体上沿；强突破信号，突破有效性高，关注次日能否站稳上沿，站稳则反转启动', '大跌': '放量大跌砸穿箱体下沿；空头最后宣泄与挖坑诱空并存，观察能否快速收回，收回则是黄金坑' },
      '平量': { '大涨': '平量大涨离开箱体上沿；量能未放大的突破可信度低，多为脉冲，回踩箱体概率大', '大跌': '平量大跌离开箱体下沿；无恐慌也无承接的破位，箱体结构走坏，继续观察' },
      '缩量': { '大涨': '缩量大涨冲上箱体上沿；突破动能不足，假突破概率大，谨防冲高回落', '大跌': '缩量大跌跌破箱体下沿；承接稀少的阴跌破位，箱体失效，等待止跌信号' },
    },
  },
};

const DERIVED_KEYS = new Set(['① 高位区间|趋势向下', '③ 低位区间|趋势向上']);

const TIER5 = ['大涨', '上涨', '震荡', '下跌', '大跌'];

function volCell(zone, state, vol, tier5) {
  if (TIER5.indexOf(tier5) < 0) return null;
  const z = ZONES.find(x => x.name === zone);
  if (!z) return null;
  const st = z.states.find(x => x.name === state);
  if (!st) return null;
  const v = st.vols.find(x => x.name === vol);
  if (!v) return null;
  const key = `${zone}|${state}|${vol}|${tier5}`;
  if (tier5 === '大涨' || tier5 === '大跌') {
    const s = STRONG[zone] && STRONG[zone][state] && STRONG[zone][state][vol];
    if (!s) return null;
    return { key, verdict: `价格${z.name.replace(/^[①②③] /, '')}+${state}+${vol}${tier5}`, conclusion: s[tier5], derived: DERIVED_KEYS.has(`${zone}|${state}`) };
  }
  const row = v.rows.find(r => r[0] === `当日${tier5}`);
  if (!row) return null;
  return { key, verdict: row[1], conclusion: row[2], derived: false };
}

module.exports = { ZONES, STRONG, DERIVED_KEYS, TIER5, volCell };

~~~

---

## `lib\priceAction.js`  ·  773 行

~~~js
/**
 * 价格行为（Price Action）趋势推演模块
 *
 * 核心原理：价格包容一切 + 人性重复演绎
 * 量化趋势识别：基于历史价格与成交量，客观推演未来短期（日级别）与
 * 长期（周/月级别）价格路径的最大概率场景。
 *
 * 框架：
 *  1. 底层公理：趋势延续性 / 周期嵌套（道氏）/ 量价真实性
 *  2. 长期预判（周/月级别）：MA250-MA120 斜率与位置、月线 MACD 结构、筹码密集区
 *  3. 短期预判（日/60分钟级别）：乖离率、K线组合形态、60分钟 MA60 多空平衡线
 *  4. 长短周期嵌套「趋势一致性」推演矩阵
 *  5. 趋势自我否定的「证伪临界点」
 *
 * 只输出趋势方向与概率，不输出任何操作指令。
 */
const { SMA, MACD, findSupportResistance } = require('./analysis');
// 20261017a：个股侧量能唯一出口。价格行为中的量（突破量比/5:20均量比/缩量证伪/筹码分布）
// 一律改引自本模块，不再在 priceAction 内自行计算。
const { computeVolumeIndicators } = require('./capitalFlow');
// 20261020i：阻力/支撑区间有效性检验（用户两条标准：无放量突破即无效 / 区间外收盘超 3 天即无效）
const { assessZones, erodeZones, finalizedBars } = require('./zoneValidity');
// 20261022g（用户新规范）：10 种支撑阻力方法 + 共振合并 + 强度分级
const { buildCandidates } = require('./zoneMethods');
const { mergeResonance, INVALID_BUFFER_ATR, MIN_KEEP_ATR } = require('./zoneResonance');

const round = (n, d = 2) => {
  if (n === null || n === undefined || isNaN(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const lastOf = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

// ---- 日K线重采样为周线 / 月线 ----
function resample(daily, unit) {
  const bars = [];
  let cur = null;
  let curKey = null;
  const keyOf = (dateStr) => (unit === 'M' ? dateStr.slice(0, 7) : weekKey(dateStr));
  for (const d of daily) {
    const k = keyOf(d.date);
    if (!cur || k !== curKey) {
      if (cur) bars.push(cur);
      curKey = k;
      cur = { date: k, label: k, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, d.high);
      cur.low = Math.min(cur.low, d.low);
      cur.close = d.close;
      cur.volume += d.volume || 0;
    }
  }
  if (cur) bars.push(cur);
  return bars;
}

// ISO 周键（周一日期），用于周线聚合
function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - day + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ---- 摆动点（分形）：window 根K线确认的局部高/低点；单边趋势下 5 根分形稀少时自动降级为 3 根 ----
function swingPoints(bars, w = 2) {
  const find = (win) => {
    const highs = [];
    const lows = [];
    for (let i = win; i < bars.length - win; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= win; j++) {
        if (bars[i].high < bars[i - j].high || bars[i].high < bars[i + j].high) isHigh = false;
        if (bars[i].low > bars[i - j].low || bars[i].low > bars[i + j].low) isLow = false;
      }
      if (isHigh) highs.push({ idx: i, price: bars[i].high, date: bars[i].label || bars[i].date });
      if (isLow) lows.push({ idx: i, price: bars[i].low, date: bars[i].label || bars[i].date });
    }
    return { highs, lows };
  };
  const r = find(w);
  if (r.highs.length < 2 || r.lows.length < 2) {
    const r1 = find(1);
    return {
      highs: r.highs.length < 2 ? r1.highs : r.highs,
      lows: r.lows.length < 2 ? r1.lows : r.lows,
    };
  }
  return r;
}

// ---- MACD 红绿柱波段（连续同符号区间），用于顶/底背离判定 ----
function histWaves(hist) {
  const waves = [];
  let cur = null;
  for (let i = 0; i < hist.length; i++) {
    const v = hist[i];
    if (v === null || v === undefined) continue;
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (!cur || cur.sign !== sign) {
      if (cur) waves.push(cur);
      cur = { sign, start: i, end: i, peak: v, peakIdx: i };
    } else {
      cur.end = i;
      if (Math.abs(v) > Math.abs(cur.peak)) { cur.peak = v; cur.peakIdx = i; }
    }
  }
  if (cur) waves.push(cur);
  return waves;
}

// =========================================================
// 20261022g：侵蚀收缩后的派生字段同步
// =========================================================
/**
 * 侵蚀只改 low/high（近端收紧、远端不变），若不重算 center / invalidationLevel / invalidationText，
 * 前端会出现「区间 33.00~33.40、失效位 32.40」这种自相矛盾的组合（失效位是按侵蚀前的下沿算的）。
 * 只对共振带（带 invalidationLevel）生效；手动区间与反转区间没有这些字段，原样透传。
 */
function syncZoneDerived(zone, atrV) {
  if (!zone || !Number.isFinite(zone.low) || !Number.isFinite(zone.high)) return zone;
  // 20261022g（用户决策）：侵蚀不得把区域压成单点。
  // 旧区间只有 ±0.5%，侵蚀收个 0.1 无所谓；新共振带是 ATR 量级（0.7~1.0 ATR），
  // 侵蚀会一步收到另一头（实测海天 33.50~34.20 → 34.18~34.20，仅剩 0.02），
  // 与「支撑阻力必须输出为区域」直接冲突。故设最小保留宽度 = ATR×0.3。
  if (zone.invalidationLevel != null && Number.isFinite(atrV)) {
    const minKeep = atrV * MIN_KEEP_ATR;
    if (zone.high - zone.low < minKeep) {
      if (zone.side === 'support') zone.high = round(zone.low + minKeep);
      else zone.low = round(zone.high - minKeep);
      zone.minWidthApplied = true;
      // 侵蚀文案同步：否则前端会显示「已收紧 33.50~34.20 → 34.18~34.20」而实际是 33.99~34.20
      if (zone.erosion && zone.erosion.rangeTo) {
        zone.erosion.rangeToRaw = zone.erosion.rangeTo;
        zone.erosion.rangeTo = `${zone.low} ~ ${zone.high}`;
        zone.erosion.guardNote = `侵蚀本应收至 ${zone.erosion.to}，按最小保留宽度（ATR×${MIN_KEEP_ATR}）回退至 ${zone.low}~${zone.high}`;
      }
    }
  }
  if (zone.center != null) zone.center = round((zone.low + zone.high) / 2);
  if (zone.invalidationLevel != null && Number.isFinite(atrV)) {
    const buf = atrV * INVALID_BUFFER_ATR;
    if (zone.side === 'support') {
      zone.invalidationLevel = round(zone.low - buf);
      zone.invalidationText = `放量收盘跌破 ${zone.invalidationLevel}（下沿 ${zone.low} 再减 ${round(buf)} 缓冲）→ 支撑失效，可能转为阻力`;
    } else {
      zone.invalidationLevel = round(zone.high + buf);
      zone.invalidationText = `放量收盘站上 ${zone.invalidationLevel}（上沿 ${zone.high} 再加 ${round(buf)} 缓冲）→ 阻力失效，可能转为支撑`;
    }
    zone.validityHint = `以当日收盘价判定：${zone.invalidationText.split('→')[0].trim()}`;
  }
  return zone;
}

// =========================================================
// 第二部分：长期趋势预判（周线/月线级别）
// =========================================================
function calcLongTerm(daily, vol) {
  const closes = daily.map(d => d.close);
  const t = daily.length - 1;
  const close = closes[t];
  const evidence = [];

  const ma250 = SMA(closes, 250);
  const ma120 = SMA(closes, 120);
  const v250 = ma250[t];
  const v120 = ma120[t];

  // 1) 长期均线系统与趋势年龄
  const slopePct = (() => {
    if (v250 === null || v250 === undefined) return null;
    const ref = t - 20 >= 0 ? ma250[t - 20] : null;
    if (ref === null || ref === undefined || ref === 0) return null;
    return round(((v250 - ref) / ref) * 100, 2);
  })();
  const slopeState = slopePct === null ? null : slopePct > 0.5 ? '上翘' : slopePct < -0.5 ? '下压' : '走平';
  const positionPct = v250 ? round(((close - v250) / v250) * 100, 2) : null;

  // 缠绕判定：近120日价格与 MA250 的有效穿越次数（±1% 以内的贴线忽略）
  const flips = (() => {
    if (!v250) return null;
    let cnt = 0;
    let prevSide = 0;
    for (let i = Math.max(0, t - 119); i <= t; i++) {
      if (ma250[i] === null || ma250[i] === undefined) continue;
      const dev = (closes[i] - ma250[i]) / ma250[i];
      if (Math.abs(dev) < 0.01) continue;
      const side = dev > 0 ? 1 : -1;
      if (prevSide !== 0 && side !== prevSide) cnt++;
      prevSide = side;
    }
    return cnt;
  })();
  const winding = flips !== null && flips >= 4;

  // 2) 月线级别 MACD 与趋势结构
  const monthly = resample(daily, 'M');
  const monthlyCloses = monthly.map(m => m.close);
  const macd = monthlyCloses.length >= 35 ? MACD(monthlyCloses) : null;
  const mT = monthly.length - 1;
  const dif = macd ? macd.dif[mT] : null;
  const dea = macd ? macd.signal[mT] : null;
  const mHist = macd ? macd.histogram : null;

  const monthlyMacd = { available: !!macd, dif, dea, hist: mHist ? mHist[mT] : null, zeroPos: null, lastCross: null, crossBarsAgo: null };
  if (macd) {
    monthlyMacd.zeroPos = dif > 0 && dea > 0 ? '零轴上方' : (dif < 0 && dea < 0 ? '零轴下方' : '跨零轴');
    // 最近一次金叉/死叉
    for (let i = mT; i > 0; i--) {
      if (macd.dif[i] === null || macd.signal[i] === null || macd.dif[i - 1] === null || macd.signal[i - 1] === null) continue;
      if (macd.dif[i - 1] < macd.signal[i - 1] && macd.dif[i] > macd.signal[i]) {
        monthlyMacd.lastCross = macd.signal[i] > 0 ? '零轴上方金叉' : '零轴下方金叉';
        monthlyMacd.crossBarsAgo = mT - i;
        break;
      }
      if (macd.dif[i - 1] > macd.signal[i - 1] && macd.dif[i] < macd.signal[i]) {
        monthlyMacd.lastCross = macd.signal[i] < 0 ? '零轴下方死叉' : '零轴上方死叉';
        monthlyMacd.crossBarsAgo = mT - i;
        break;
      }
    }
  }

  // HH / HL 结构（月线摆动点）
  const monthlyRecent = monthly.slice(-48);
  const offset = monthly.length - monthlyRecent.length;
  const sw = swingPoints(monthlyRecent, 2);
  const sh = sw.highs.slice(-2);
  const sl = sw.lows.slice(-2);
  let structure = null;
  let brokeHL = false;
  if (sh.length === 2 && sl.length === 2) {
    const hh = sh[1].price > sh[0].price;
    const hl = sl[1].price > sl[0].price;
    brokeHL = close < sl[1].price;
    if (hh && hl) structure = 'HH/HL 上行结构';
    else if (!hh && !hl) structure = 'LH/LL 下行结构';
    else structure = '高低点结构紊乱';
  }

  // 月线 MACD 顶/底背离（价格新高但红柱峰值降低）
  let divergence = null;
  let divergenceNote = null;
  if (mHist) {
    const waves = histWaves(mHist).filter(w => w.sign > 0);
    if (waves.length >= 2) {
      const w1 = waves[waves.length - 2];
      const w2 = waves[waves.length - 1];
      const priceHigh1 = Math.max(...monthly.slice(w1.start, w1.end + 1).map(m => m.high));
      const priceHigh2 = Math.max(...monthly.slice(w2.start, w2.end + 1).map(m => m.high));
      if (priceHigh2 > priceHigh1 && w2.peak < w1.peak * 0.9) {
        divergence = '顶背离';
        divergenceNote = '价格创新高但月线MACD红柱峰值低于前一波，长期上行驱动力减弱，未来大概率面临中期回归均线的压力';
      }
    }
    const negWaves = histWaves(mHist).filter(w => w.sign < 0);
    if (!divergence && negWaves.length >= 2) {
      const w1 = negWaves[negWaves.length - 2];
      const w2 = negWaves[negWaves.length - 1];
      const priceLow1 = Math.min(...monthly.slice(w1.start, w1.end + 1).map(m => m.low));
      const priceLow2 = Math.min(...monthly.slice(w2.start, w2.end + 1).map(m => m.low));
      if (priceLow2 < priceLow1 && Math.abs(w2.peak) < Math.abs(w1.peak) * 0.9) {
        divergence = '底背离';
        divergenceNote = '价格创新低但月线MACD绿柱峰值低于前一波，长期下行动能衰竭，存在筑底修复预期';
      }
    }
  }

  // 3) 长期筹码密集区（近3年量价分布）
  // 20261017a：改引自量能根（lib/capitalFlow.js computeVolumeIndicators），原本地 calcVolumeProfile 已删除
  const profile = (vol && vol.volumeProfile) || null;

  // ---- 长期趋势定性合成 ----
  let verdict = '震荡';
  let score = 0;
  if (v250 !== null && v250 !== undefined) {
    if (slopeState === '上翘') score += 1;
    else if (slopeState === '下压') score -= 1;
    if (positionPct > 1) score += 1;
    else if (positionPct < -1) score -= 1;
  }
  if (monthlyMacd.available) {
    if (monthlyMacd.zeroPos === '零轴上方') score += 1;
    else if (monthlyMacd.zeroPos === '零轴下方') score -= 1;
    if (monthlyMacd.lastCross === '零轴上方金叉') score += 0.5;
    else if (monthlyMacd.lastCross === '零轴下方死叉') score -= 0.5;
  }
  if (structure === 'HH/HL 上行结构') score += 1;
  else if (structure === 'LH/LL 下行结构') score -= 1;
  if (divergence === '顶背离') score -= 0.5;
  else if (divergence === '底背离') score += 0.5;

  if (winding) {
    verdict = '震荡';
    evidence.push(`价格与年线（MA250）近半年反复穿越 ${flips} 次，呈缠绕形态，预判长期宽幅震荡，无单边趋势倾向`);
  } else if (score >= 1.5) verdict = '上行';
  else if (score <= -1.5) verdict = '下行';
  else verdict = '震荡';

  // 依据文本
  if (v250 !== null && v250 !== undefined) {
    evidence.push(`年线MA250=${v250}（${slopeState}，近20日斜率${slopePct >= 0 ? '+' : ''}${slopePct}%），价格${positionPct >= 0 ? '持续运行于年线之上' : '持续运行于年线之下'}（偏离${positionPct >= 0 ? '+' : ''}${positionPct}%）`);
    if (v120 !== null && v120 !== undefined) evidence.push(`半年线MA120=${v120}，价格${close > v120 ? '位于其上' : '位于其下'}，长期成本中枢${close > v120 && close > v250 ? '逐级上移' : close < v120 && close < v250 ? '逐级下移' : '方向不一'}`);
  } else {
    evidence.push('上市时间不足一年，年线数据不足，长期预判以半年线与月线MACD为参考');
  }
  if (monthlyMacd.available) {
    evidence.push(`月线MACD：DIF=${dif}、DEA=${dea}，位于${monthlyMacd.zeroPos}${monthlyMacd.lastCross ? `，近期发生${monthlyMacd.lastCross}（${monthlyMacd.crossBarsAgo}个月前）` : ''}，趋势惯性${monthlyMacd.zeroPos === '零轴上方' ? '偏多' : monthlyMacd.zeroPos === '零轴下方' ? '偏空' : '中性'}`);
  } else {
    evidence.push('月线数据不足35根，月线MACD不具备统计意义，已剔除该维度');
  }
  if (structure) {
    if (brokeHL && structure === 'HH/HL 上行结构') {
      evidence.push(`月线${structure}，但当前价格已跌破前一个更高低点（${sl[1].price}），长期趋势面临转折风险，预期修正为区间震荡或转熊`);
    } else {
      evidence.push(`月线摆动结构：${structure}${divergence ? `，且出现${divergence}` : ''}`);
    }
  }
  if (divergenceNote) evidence.push(divergenceNote);
  if (profile) {
    if (profile.resistance) evidence.push(`上方长期筹码密集区（阻力带）${profile.resistance.low}~${profile.resistance.high}，套牢筹码占近3年成交约${profile.abovePct}%`);
    if (profile.support) evidence.push(`下方长期缩量横盘密集区（支撑带）${profile.support.low}~${profile.support.high}`);
  }

  return {
    verdict,
    score,
    winding,
    ma250: v250 ? { value: v250, slopePct, slopeState, positionPct } : null,
    ma120: v120 ? { value: v120, position: close > v120 ? '上方' : '下方' } : null,
    monthlyMacd,
    structure,
    brokeHL,
    prevHL: sl.length === 2 ? sl[1].price : null,
    divergence,
    profile,
    evidence,
  };
}

// ---- 长期筹码密集区：价格分档成交量分布 ----
// 20261017a：本函数已迁至 lib/capitalFlow.js calcVolumeProfileShared（量能唯一出口），
// priceAction 不再保留副本，改由 computeVolumeIndicators(daily, null, null, {includeProfile:true}) 提供。

// =========================================================
// 第三部分：短期趋势预判（日线/60分钟级别，未来1-5个交易日）
// =========================================================
function calcShortTerm(daily, h60, vol) {
  const closes = daily.map(d => d.close);
  const t = daily.length - 1;
  const close = closes[t];
  const evidence = [];

  const ma5 = SMA(closes, 5);
  const ma60 = SMA(closes, 60);
  const ma20 = SMA(closes, 20);
  const v5 = ma5[t];

  // 1) 短期乖离率（波动率标准化：Z = 乖离 / 近20日日波动）
  const bias5 = v5 ? round(((close - v5) / v5) * 100, 2) : null;
  const rets = [];
  for (let i = Math.max(1, t - 19); i <= t; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rets.length || 1));
  const biasZ = bias5 !== null && std > 0 ? round(bias5 / (std * Math.sqrt(5) * 100), 2) : null;

  // MA5 与 MA60 斜率差（短期动能 vs 中期动能）
  const slopeSpread = (() => {
    if (!v5 || !ma60[t]) return null;
    const r5 = t - 3 >= 0 ? ma5[t - 3] : null;
    const r60 = t - 20 >= 0 ? ma60[t - 20] : null;
    if (r5 === null || r60 === null || !r5 || !r60) return null;
    const s5 = ((v5 - r5) / r5) * 100;
    const s60 = ((ma60[t] - r60) / r60) * 100;
    return round(s5 - s60, 2);
  })();

  const overbought = biasZ !== null && biasZ > 2;
  const oversold = biasZ !== null && biasZ < -2;
  const slopeSpreadWide = slopeSpread !== null && Math.abs(slopeSpread) > 8;

  // 2) 近期K线组合形态
  // 20261017a：突破量比与形态改引自量能根（lib/capitalFlow.js computeVolumeIndicators），
  // 原本地计算（前20日均量为基准）已删除；volRatio/high20/low20/pattern 含义与取值不变。
  const bo = (vol && vol.indicators && vol.indicators.breakout)
    || { volRatio: null, high20: null, low20: null, pattern: '无显著形态' };
  const volRatio = bo.volRatio;
  const high20 = bo.high20;
  const low20 = bo.low20;
  let pattern = bo.pattern;

  // 3) 60分钟 MA60 多空平衡线
  let h60ma = null;
  if (h60 && h60.length >= 60) {
    const c60 = h60.map(d => d.close);
    const m60 = SMA(c60, 60);
    const v = m60[m60.length - 1];
    if (v !== null && v !== undefined) {
      const last = c60[c60.length - 1];
      let crossings = 0;
      let prevSide = 0;
      for (let i = Math.max(0, c60.length - 16); i < c60.length; i++) {
        if (m60[i] === null || m60[i] === undefined) continue;
        const side = c60[i] > m60[i] ? 1 : -1;
        if (prevSide !== 0 && side !== prevSide) crossings++;
        prevSide = side;
      }
      h60ma = {
        value: v,
        position: crossings >= 3 ? '反复穿越' : last > v ? '上方' : '下方',
        crossings,
      };
    }
  }

  // ---- 短期方向合成 ----
  let dirScore = 0;
  if (pattern === '放量突破前高') dirScore += 2;
  else if (pattern === '放量跌破前低') dirScore -= 2;
  else if (pattern === '缩量新高') dirScore -= 0.5;
  if (h60ma) {
    if (h60ma.position === '上方') dirScore += 1;
    else if (h60ma.position === '下方') dirScore -= 1;
  }
  if (slopeSpreadWide && slopeSpread > 0) dirScore -= 1; // 动能透支
  if (overbought) dirScore -= 1.5;   // 均值回归压力
  if (oversold) dirScore += 1.5;

  let direction = '震荡';
  if (dirScore >= 1.5) direction = '上行';
  else if (dirScore <= -1.5) direction = '下行';
  else if (dirScore > 0) direction = '震荡偏上';
  else if (dirScore < 0) direction = '震荡偏下';
  if (overbought && direction === '上行') direction = '冲高回落';
  if (oversold && direction === '下行') direction = '超跌反弹';

  // ---- 阻力 / 支撑区间（20261022g：10 种方法 + 共振合并 + 强度分级）----
  // 20261022c（用户口径）：突破/破位/打穿一律以**当日收盘价**为准，不认分时价。
  // 未收盘的当日K线（若有）不参与任何计算——只对已收盘日K判定。
  const zoneBars = finalizedBars(daily);
  const zonePrice = zoneBars.length ? zoneBars[zoneBars.length - 1].close : close;

  let resistances = [];
  let supports = [];
  let zoneMethodsMeta = null;
  let zoneAtr = null;
  try {
    // 候选（10 种方法 + 周线层）→ 共振合并（按 ATR 聚类、钳带宽、切重叠）
    const built = buildCandidates(zoneBars, { price: zonePrice });
    const reso = mergeResonance(built.candidates, {
      daily: zoneBars,
      h60: h60 && h60.length ? h60 : null,
      atr: built.atr,
      price: zonePrice,
    });
    resistances = reso.resistanceBands;
    supports = reso.supportBands;
    zoneAtr = built.atr;
    const usedMethods = new Set();
    for (const c of built.candidates) if (c && c.method) usedMethods.add(c.method);
    zoneMethodsMeta = {
      atr: built.atr,
      price: round(zonePrice),
      candidateCount: built.candidates.length,
      methods: Array.from(usedMethods).sort(),
      stats: reso.stats,
      skipped: built.skipped,
    };
  } catch (e) {
    // 降级：共振引擎异常时退回旧的「摆动点 + MA20」，保证清单不为空（绝不因新算法故障丢结论）
    console.warn('[PriceAction] 共振区间生成失败，降级为摆动点+MA20:', e && e.message ? e.message : e);
    const sr = findSupportResistance(daily, 60);
    sr.resistances.slice(0, 2).forEach(r => resistances.push({ low: round(r * 0.995), high: round(r * 1.005), source: '近60日摆动高点' }));
    sr.supports.slice(0, 2).forEach(s => supports.push({ low: round(s * 0.995), high: round(s * 1.005), source: '近60日摆动低点' }));
    if (ma20[t]) {
      if (close > ma20[t]) supports.push({ low: round(ma20[t] * 0.99), high: round(ma20[t] * 1.01), source: 'MA20' });
      else resistances.push({ low: round(ma20[t] * 0.99), high: round(ma20[t] * 1.01), source: 'MA20' });
    }
    resistances.sort((a, b) => a.low - b.low);
    supports.sort((a, b) => b.low - a.low);
  }

  // 20261020i：有效性检验（必做，不通过的不展示）。
  // 20261022b：用户要求彻底删除标准2，仅保留标准1——首次穿越日量比 ≤1.2（不需要放量就突破）→ 无效。
  // 注意：区间在这里被「原地打标」而不是删掉——上游（④卡反转边界）与前端共用同一份数据，
  // 是否展示由前端按 valid 过滤，但语义只有一份（谁都不能把无效区间当有效用）。
  let zoneValiditySummary = null;
  let zoneErosionSummary = null;
  // 20261022g（用户澄清）：标准1 = 「该位置本来就没有阻碍」→ 判无效只影响**本次展示**，
  // 不落任何永久黑名单；下次重算若不再出现无放量穿越（例如后来被放量突破），区间会自然复现。
  try {
    const checked = assessZones(zoneBars, { resistances, supports });
    // 20261020m：侵蚀收缩（顺序铁律 —— 先判有效性、再收缩几何，不可颠倒）。
    // 无效区间不展示也就无需收缩；侵蚀只动近端（阻力 low / 支撑 high），远端恒不变。
    let eroded = checked;
    try {
      eroded = erodeZones(zoneBars, checked);
      zoneErosionSummary = eroded.summary;
    } catch (e2) {
      console.warn('[PriceAction] 区间侵蚀收缩失败（按未侵蚀降级）:', e2 && e2.message ? e2.message : e2);
    }
    resistances.length = 0;
    supports.length = 0;
    eroded.resistances.forEach(z => resistances.push(z));
    eroded.supports.forEach(z => supports.push(z));
    // 20261022g：侵蚀改了 low/high → 同步重算 center / 失效位（否则展示的失效位是侵蚀前的旧值）
    if (zoneAtr) {
      resistances.forEach(z => syncZoneDerived(z, zoneAtr));
      supports.forEach(z => syncZoneDerived(z, zoneAtr));
    }
    // 近端收缩后次序可能变化，重排保持「阻力按 low 升序 / 支撑按 low 降序」
    const numOr = (v, dflt) => (v === null || v === undefined || isNaN(v) ? dflt : Number(v));
    const byLow = (a, b) => numOr(a && a.low, 0) - numOr(b && b.low, 0);
    resistances.sort(byLow);
    supports.sort((a, b) => byLow(b, a));
    zoneValiditySummary = checked.summary;
  } catch (e) {
    console.warn('[PriceAction] 区间有效性检验失败（按全有效降级）:', e && e.message ? e.message : e);
  }

  // 依据文本
  if (bias5 !== null) {
    evidence.push(`价格偏离MA5 ${bias5 >= 0 ? '+' : ''}${bias5}%（标准化乖离Z=${biasZ}），${overbought ? '短期超买压力累积，未来数日向MA5/BOLL中轨靠拢的概率显著增加' : oversold ? '短期超卖，存在向MA5修复的均值回归预期' : '乖离率稳定，短期趋势惯性良好，当前运动方向大概率维持'}`);
  }
  if (slopeSpread !== null) {
    evidence.push(`MA5与MA60斜率差${slopeSpread >= 0 ? '+' : ''}${slopeSpread}%${slopeSpreadWide ? '，短期运行速率过快，回归预期增强' : ''}`);
  }
  if (pattern === '放量突破前高') evidence.push(`放量突破近20日前高（${round(high20)}），量比${volRatio}，短期多头力量占优，价格重心上移`);
  else if (pattern === '放量跌破前低') evidence.push(`放量跌破近20日前低（${round(low20)}），量比${volRatio}，短期空头力量占优，价格重心下移`);
  else if (pattern === '缩量新高') evidence.push(`缩量创出近20日新高（量比${volRatio}），追高意愿不足，存在冲高回落、重回下方支撑区的风险`);
  else evidence.push(`近20日高低点区间${round(low20)}~${round(high20)}内无方向性突破，量比${volRatio || '--'}`);
  if (h60ma) {
    evidence.push(`60分钟MA60（${h60ma.value}）：价格运行于其${h60ma.position}${h60ma.position === '反复穿越' ? '，短期方向不明，无清晰趋势预期' : h60ma.position === '上方' ? '，预判短期偏强震荡' : '，预判短期偏弱震荡'}`);
  }

  return {
    direction,
    dirScore,
    bias5,
    biasZ,
    overbought,
    oversold,
    slopeSpread,
    pattern,
    volRatio,
    high20: round(high20),
    low20: round(low20),
    h60ma,
    resistances,
    supports,
    zoneValidity: zoneValiditySummary,
    zoneErosion: zoneErosionSummary,
    zoneMethods: zoneMethodsMeta,   // 20261022g：10 种方法的产出统计（ATR/候选数/合并统计/算不出的方法）
    evidence,
  };
}

// =========================================================
// 短期状态分类（用于趋势一致性矩阵）
// =========================================================
function classifyShortState(daily, longTerm, shortTerm, vol) {
  const t = daily.length - 1;
  const closes = daily.map(d => d.close);
  const chg5 = closes[t - 4] ? ((closes[t] - closes[t - 4]) / closes[t - 4]) * 100 : 0;
  // 20261017a：5:20 均量比改引自量能根（lib/capitalFlow.js computeVolumeIndicators）
  const vol5Ratio = (vol && vol.indicators && typeof vol.indicators.vol5Vs20 === 'number') ? vol.indicators.vol5Vs20 : 1;
  const close = closes[t];
  const ma120 = SMA(closes, 120)[t];
  const ma250 = SMA(closes, 250)[t];
  const nearLongMA = (ma120 && Math.abs(close - ma120) / ma120 < 0.03) || (ma250 && Math.abs(close - ma250) / ma250 < 0.05);

  if (longTerm.verdict === '上行' && chg5 < -3 && nearLongMA && vol5Ratio < 0.9) return 'pullback_shrink';
  if (chg5 > 10 && shortTerm.volRatio >= 2) return 'surge_heavy';
  if (longTerm.verdict === '下行' && chg5 > 5 && (shortTerm.volRatio || 0) >= 1.3) return 'rebound_heavy';
  if (Math.abs(chg5) < 3 && vol5Ratio < 0.8) return 'sideways_shrink';
  if (longTerm.verdict === '震荡' && shortTerm.pattern === '放量突破前高') return 'breakout_heavy';
  if (shortTerm.pattern === '放量突破前高') return 'breakout_heavy';
  if (Math.abs(chg5) < 3) return 'sideways';
  return chg5 > 0 ? 'up' : 'down';
}

// =========================================================
// 第四部分：长短周期嵌套「趋势一致性」推演矩阵
// =========================================================
const MATRIX = {
  '上行+pullback_shrink': {
    scenario: '趋势共振向上',
    text: '短期回调大概率结束，价格未来重拾长期升势的预期强烈，短期目标指向近期前高',
    consistent: true, dominant: '长期',
  },
  '上行+surge_heavy': {
    scenario: '短期透支预期',
    text: '长期虽看多，但短期能量消耗过快，预判未来数日价格将进入横盘或回吐修正以修复超买指标，但不会扭转长期方向',
    consistent: false, dominant: '长期',
  },
  '下行+rebound_heavy': {
    scenario: '短期反弹，长期承压',
    text: '此为短期技术性修复，长期下行结构未变，价格反弹至上方长期均线或筹码密集区时将面临强大压制，恐重回跌势',
    consistent: false, dominant: '长期',
  },
  '下行+sideways_shrink': {
    scenario: '趋势延续预期',
    text: '当前缩量横盘为下跌中继，长期重心继续下移的概率较高',
    consistent: true, dominant: '长期',
  },
  '震荡+breakout_heavy': {
    scenario: '趋势尝试启动',
    text: '短期突破为有效尝试，但持续性有待观察：若后续成交量能维持，长期震荡格局有望转为上行；若快速缩量回归，则预判为假突破，重归震荡',
    consistent: false, dominant: '短期（观察期）',
  },
};

function calcCoordination(longTerm, shortTerm, shortState) {
  const key = `${longTerm.verdict}+${shortState}`;
  const m = MATRIX[key] || {
    scenario: key.startsWith('上行') ? '长期多头框架下的顺势延续' : key.startsWith('下行') ? '长期空头框架下的顺势延续' : '箱体震荡延续',
    text: key.startsWith('上行')
      ? '短期波动未破坏长期上行结构，预判价格在长期趋势框架内延续偏强运行'
      : key.startsWith('下行')
        ? '短期波动未改变长期下行结构，预判价格在长期趋势框架内延续偏弱运行'
        : '长期无单边倾向，短期亦无突破确认，预判价格延续箱体震荡，等待方向选择',
    consistent: true,
    dominant: '长期',
  };
  return {
    key,
    shortState,
    scenario: m.scenario,
    text: m.text,
    consistent: m.consistent,
    dominant: m.dominant,
  };
}

// =========================================================
// 第五部分：趋势自我否定的「证伪临界点」
// =========================================================
function calcFalsification(daily, longTerm, shortTerm, vol) {
  const monthly = resample(daily, 'M');
  const recent = monthly.slice(-36); // 近3年
  const offset = monthly.length - recent.length;
  const t = daily.length - 1;
  const close = daily[t].close;

  // 长期上升趋势线：近3年月线上「低点抬升」的最近两个摆动低点连线
  const sw = swingPoints(recent, 2);
  const lows = sw.lows;
  let upLine = null;
  for (let i = lows.length - 1; i > 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      if (lows[i].price > lows[j].price && lows[i].idx - lows[j].idx >= 6) {
        upLine = { p1: lows[j], p2: lows[i] };
        break;
      }
    }
    if (upLine) break;
  }
  let trendline = null;
  if (upLine) {
    const gIdx = offset + upLine.p2.idx;
    const monthsFromP2 = monthly.length - 1 - gIdx;
    const slopePerMonth = (upLine.p2.price - upLine.p1.price) / (upLine.p2.idx - upLine.p1.idx);
    const value = round(upLine.p2.price + slopePerMonth * monthsFromP2);
    trendline = {
      value,
      broken: close < value * 0.99,
      p1: { date: upLine.p1.date, price: upLine.p1.price },
      p2: { date: upLine.p2.date, price: upLine.p2.price },
    };
  }

  // 短期动能证伪：当日K线运行于前一日实体范围内且无方向性突破
  let insideDay = false;
  let prevBody = null;
  if (t >= 1) {
    const p = daily[t - 1];
    prevBody = { low: round(Math.min(p.open, p.close)), high: round(Math.max(p.open, p.close)) };
    insideDay = daily[t].high <= prevBody.high && daily[t].low >= prevBody.low;
  }

  // 量价背离证伪：上涨但成交量连续3日递减
  // 20261017a：改引自量能根（lib/capitalFlow.js computeVolumeIndicators 的 shrink3d）
  const hollowRally = !!(vol && vol.indicators && vol.indicators.shrink3d);

  // ---- 量化边界（含证伪条件）----
  const edges = [];
  // 20261020i：反转边界只引用「通过有效性检验」的区间；全部无效时退回原口径（不因过滤而丢条件）
  const firstRes = (shortTerm.resistances || []).find(z => z.valid !== false) || shortTerm.resistances[0];
  const firstSup = (shortTerm.supports || []).find(z => z.valid !== false) || shortTerm.supports[0];
  if (longTerm.verdict !== '下行' && firstRes) {
    edges.push({ condition: `若未来3日收盘价站稳 ${firstRes.high} 元（${firstRes.source}）`, effect: '强化上行预期，趋势共振确认' });
  }
  if (longTerm.verdict !== '上行' && firstSup) {
    edges.push({ condition: `若跌破 ${firstSup.low} 元（${firstSup.source}）`, effect: '修正为下行预期' });
  } else if (firstSup && longTerm.verdict === '上行') {
    edges.push({ condition: `若有效跌破 ${firstSup.low} 元（${firstSup.source}）`, effect: '短期调整升级，需回检长期结构' });
  }
  if (trendline && longTerm.verdict !== '下行') {
    edges.push({ condition: `若月线级别收盘有效跌破 ${trendline.value} 元（近3年上升趋势线：${trendline.p1.date} 低点 ${trendline.p1.price} 与 ${trendline.p2.date} 低点 ${trendline.p2.price} 连线）`, effect: '推翻"长期多头"预判，修正为长期转空或大级别调整预期' });
  }
  if (trendline && trendline.broken) {
    edges.push({ condition: `当前收盘 ${round(close)} 已跌破趋势线值 ${trendline.value}`, effect: '长期多头预判已触发证伪条件，应按"长期转空或大级别调整"预期重估' });
  }
  if (prevBody) {
    edges.push({ condition: `若次日价格始终运行于前一日实体 ${prevBody.low}~${prevBody.high} 内且无方向性突破`, effect: '维持"短期无明确方向"预判，不强行给出多空倾向' });
  }
  if (hollowRally) {
    edges.push({ condition: '近3日上涨但成交量逐日递减', effect: '当前上涨为"空心化上涨"，主动下调短期上行目标预期' });
  } else {
    edges.push({ condition: '若上涨伴随成交量连续3日递减', effect: '判定为"空心化上涨"，下调短期上行目标预期' });
  }

  return { trendline, insideDay, prevBody, hollowRally, edges };
}

// =========================================================
// 主入口：价格行为趋势推演
// =========================================================
function analyzePriceAction(daily, h60) {
  if (!daily || daily.length < 60) {
    return { error: 'K线数据不足（需至少60根），无法进行价格行为推演' };
  }
  // 20261017a：量能指标一次性取自唯一出口（含 750 日筹码分布 opt-in），
  // 由 longTerm/shortTerm/classifyShortState/falsification 共用，避免四处各自重算。
  const vol = computeVolumeIndicators(daily, null, null, { includeProfile: true });
  const longTerm = calcLongTerm(daily, vol);
  const shortTerm = calcShortTerm(daily, h60, vol);
  const shortState = classifyShortState(daily, longTerm, shortTerm, vol);
  const coordination = calcCoordination(longTerm, shortTerm, shortState);
  const falsification = calcFalsification(daily, longTerm, shortTerm, vol);

  // 短期概率：依据信号一致性（方向分值绝对值 + 矩阵匹配度）
  const absScore = Math.abs(shortTerm.dirScore || 0);
  const probability = coordination.consistent && absScore >= 2 ? '高' : absScore >= 1 ? '中' : '低';

  // 图表数据：月线K线 + 均线 + MACD
  const monthly = resample(daily, 'M');
  const monthlyCloses = monthly.map(m => m.close);
  const macd = monthlyCloses.length >= 35 ? MACD(monthlyCloses) : null;
  const charts = {
    monthly: {
      labels: monthly.map(m => m.label),
      ohlc: monthly.map(m => [m.open, m.close, m.low, m.high]),
      volumes: monthly.map(m => m.volume),
      ma5: SMA(monthlyCloses, 5),
      ma10: SMA(monthlyCloses, 10),
      ma30: SMA(monthlyCloses, 30),
      macd: macd ? { dif: macd.dif, dea: macd.signal, hist: macd.histogram } : null,
    },
    profile: longTerm.profile,
    trendline: falsification.trendline,
  };

  return {
    longTerm,
    shortTerm: { ...shortTerm, probability },
    coordination,
    falsification,
    charts,
    meta: {
      dailyBars: daily.length,
      monthlyBars: monthly.length,
      range: `${daily[0].date} ~ ${daily[daily.length - 1].date}`,
      source: '本地计算（日K/60分钟K线 + 价格行为框架）',
    },
  };
}

module.exports = { analyzePriceAction, resample };

~~~

---

## `lib\priceActionHub.js`  ·  160 行

~~~js
// ============ 价格行为推演快照·唯一出口（20260905g） ============
// 数据一致性规则一·指标级单源：「技术面分析」页(/api/price-action)、
// 短期行情判断(technicalShort 因子)、长期行情判断(technicalLong 因子)
// 统一从本模块取同一份价格行为快照，消除三处各自拉K线、各自缓存导致的跨页不一致。
//
// 缓存策略（沿用原 /api/price-action 语义）：
//   盘中（交易日 09:15–15:05）10 分钟；非盘中至当日结束（24h）。
//   拉取失败但存在旧快照时回退旧快照（陈旧快照优于空值，保证各页面不脱钩）。
//
// 20261020l：「关键位有效性检验」联动已整体下线（用户指出 20261020i 删错了模块——当时该删的是这张
// 「生死位规则口径」卡，却把箱体区块删了）。随之下线：getLevelValidity / _extractLevelValidity /
// _lvCache / LV_TIMEOUT_MS / analyzeVolume+getQuote 依赖，以及前端 ⑤ 卡、路由注入、样式与单测。
// 本模块回归「单箱体快照」单一职责：唯一出口 getPriceActionSnapshot（含 data.singleRange）。
const { getHistoryDeep, getHistoryPeriod } = require('./stockData');
const { analyzePriceAction } = require('./priceAction');
const { detectSingleRange } = require('./rangeDetector');   // 20261020j：单箱体模型（纯计算，零网络）
const { assessZone, finalizedBars } = require('./zoneValidity');   // 20261021e：手动区间同样过有效性检验（标准1）
const manualZones = require('./manualZones');               // 20261021d：用户手动阻力/支撑
const { attachReversedZones } = require('./zoneReversal');  // 20261022b：放量突破→角色反转（可多次）

const _cache = new Map(); // symbol -> { ts, data }

function _inTradingHours(now) {
  const hk = now.getHours() * 100 + now.getMinutes();
  const wd = now.getDay();
  return wd >= 1 && wd <= 5 && hk >= 915 && hk <= 1505;
}

/**
 * 20261021e：把手动区间接进短期清单，并**同样跑本模块的两条有效性检验**（用户 2026-10-21 要求）。
 * ----------------------------------------------------------
 * 用 `assessZone`（与模型区间同一个函数、同一份日K、同一窗口、同一阈值），因此「无放量轻松突破」
 * 与「三天来回穿越」这两条对用户自填的位同样生效——无效的会被前端按 valid!==false 过滤掉，
 * 但在「手动添加」页签里仍会显示并注明无效原因（那是用户自己录的，不能悄悄消失）。
 *
 * 三条边界：
 *   ① **不参与侵蚀**：用户只要求「两个有效性检验」，侵蚀是另一套规则；这里 append 在
 *      `erodeZones` 之后，所以手动区间不会被收缩。
 *   ② **不参与方向/概率/④卡反转边界/准确率**：这些在 `analyzePriceAction` 内部、本函数之前就
 *      算完了（`calcFalsification` 用它自己的区间），append 只影响展示层，不回头改结论。
 *   ③ 单点区间（low===high）照常过检验；脏数据由 assessZone 自身兜底（透传有效、不判死）。
 *
 * 20261103h：本函数已被提到 attachReversedZones **之前**执行——手动区间带的 zoneCheck
 * 供反转模块消费（放量有效突破 → 与模型区间同一条反转生命周期）。
 */
function attachManualZones(data, daily, symbol) {
  if (!data || !data.shortTerm || !Array.isArray(daily) || daily.length < 2) return data;
  let store;
  try {
    store = manualZones.listZones(symbol);
  } catch (e) {
    console.warn('[PriceAction] 手动区间读取失败（本次不并入）:', e && e.message ? e.message : e);
    return data;
  }
  const mk = (z, side) => {
    const r = assessZone(daily, { low: z.low, high: z.high }, side);
    return {
      low: z.low,
      high: z.high,
      source: z.note || '手动添加',
      isManual: true,
      manualId: z.id,
      valid: r.valid,
      invalidReasons: r.invalidReasons,
      zoneCheck: r.zoneCheck,
    };
  };
  const res = (store.resistances || []).map(z => mk(z, 'resistance'));
  const sup = (store.supports || []).map(z => mk(z, 'support'));
  data.shortTerm.resistances = (data.shortTerm.resistances || []).concat(res);
  data.shortTerm.supports = (data.shortTerm.supports || []).concat(sup);
  data.manualZonesMeta = {
    total: res.length + sup.length,
    valid: res.concat(sup).filter(z => z.valid !== false).length,
    invalid: res.concat(sup).filter(z => z.valid === false).length,
    note: '手动区间与模型区间走同一条有效性检验；但不参与侵蚀收缩，也不影响方向与概率。',
  };
  return data;
}

/**
 * 取个股价格行为推演快照（analyzePriceAction 完整结果：longTerm/shortTerm/coordination/falsification）。
 * @param {string} symbol 六位股票代码
 * @param {object} opts { force: 强制刷新（忽略缓存重拉） }
 * @returns {object} analyzePriceAction 结果；失败时 { error: '...' }（或回退旧快照）
 */
async function getPriceActionSnapshot(symbol, opts = {}) {
  const force = !!(opts.force || opts.forceRefresh);
  const now = new Date();
  const ttl = _inTradingHours(now) ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const cached = _cache.get(symbol);
  if (!force && cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  try {
    const [dailyRes, h60Res] = await Promise.allSettled([
      getHistoryDeep(symbol, 2400),
      getHistoryPeriod(symbol, '60m', 400),
    ]);
    const daily = dailyRes.status === 'fulfilled' ? dailyRes.value : [];
    const h60 = h60Res.status === 'fulfilled' ? h60Res.value : [];
    if (!daily || daily.length < 60) {
      // 拉取失败但有旧快照：沿用以保证各页面不脱钩
      if (cached) return cached.data;
      return { error: 'K线数据不足，无法进行价格行为推演' };
    }
    const data = analyzePriceAction(daily, h60 && h60.length ? h60 : null);
    // 20261020j：单箱体模型重新接入（20261020i 曾整体下线固定多窗口版本）。
    // 计算位置说明（LRN-20261020-006 三问）：
    //   ① 本快照被 sameDayJudgment 的 technicalShort/Long 消费 → 不得让展示需求拖入新依赖；
    //      而单箱体是**纯函数、零网络**，输入就是本函数已拉到的 daily，新增字段对既有消费者惰性，
    //      故放在快照内（与旧 ranges 位置一致），而非路由层二次拉取。
    //   ② 与「阻力/支撑区间有效性检验」（lib/zoneValidity.js）是两套完全独立的口径，前端须同屏声明。
    //   ③ 失败只降级本区块（singleRange=null），不阻塞价格行为主链路。
    try {
      data.singleRange = detectSingleRange(daily);
    } catch (e) {
      data.singleRange = null;
      console.warn('[PriceAction] 单箱体检测失败（该区块降级隐藏）:', e && e.message ? e.message : e);
    }
    // 20261022c（用户口径）：突破/破位/打穿一律以**当日收盘价**为准，不认分时价。
    // 反转与手动区间检验统一只用已收盘日K（未收盘的当日K线不参与判定）。
    const finalBars = finalizedBars(daily);
    // 20261021e：手动区间并入短期清单（含标准1 有效性检验）。
    // 20261103h 顺序调整：**先**并入手动区间（每条带上 zoneCheck），**再**跑反转模块——
    // 此前手动区间放在反转之后且反转模块跳过 isManual，导致手动阻力被放量有效突破后
    // 既不判无效（标准1 只判无放量穿越）也不反转，会一直以原方向挂在清单里（用户报障）。
    try {
      attachManualZones(data, finalBars, symbol);
    } catch (e) {
      console.warn('[PriceAction] 手动区间并入失败（该部分降级为空）:', e && e.message ? e.message : e);
    }
    // 20261022b：放量有效突破 → 角色反转。20261103h 起手动区间同样接入（origin='manual' +
    // manualId 链接回源条目，删除时 purgeByManualId 联动清除）；仍然只推进/记录，不改方向与概率。
    // 记录会推进（翻转/失效）后落盘。
    try {
      attachReversedZones(data, finalBars, symbol);
    } catch (e) {
      console.warn('[PriceAction] 反转区间并入失败（该部分降级为空）:', e && e.message ? e.message : e);
    }
    _cache.set(symbol, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;
    return { error: '价格行为推演失败：' + (e && e.message ? e.message : e) };
  }
}

// 20261020l：getLevelValidity / _extractLevelValidity 已整体删除（用户要求下线「关键位有效性检验」卡与其联动）
/**
 * 20261021e：丢弃某只股票的快照缓存。
 * 手动区间增删后必须调用——否则快照里的 `shortTerm.resistances` 还是旧的那一份，
 * 用户加完看不到、删完还在（他要等 24h 缓存过期）。只丢这一只，不影响其他标的。
 */
function invalidateSnapshot(symbol) {
  try { _cache.delete(symbol); } catch (e) {}
}

module.exports = { getPriceActionSnapshot, invalidateSnapshot, attachManualZones };

~~~

---

## `lib\pyRuntime.js`  ·  42 行

~~~js
/**
 * Python 解释器探测（进程级缓存）
 * ----------------------------------------------------------------------------
 * 供需要调用 scripts/ 下 Python 脚本的模块共用：
 *   - routes/aiRoutes.js（行业指数历史行情）
 *   - server.js（研报下载 / 板块拥挤度回补）
 * 原实现位于 server.js，20260906 路由拆分时迁出为共享 lib，避免双份逻辑漂移。
 */
const cp = require('child_process');

let _pyCacheChecked = false;
let _pyCache = null;
// [20261015a] 失败不再永久缓存：受管 Python 是指向 WorkBuddy 应用资源目录的符号链接，
// WorkBuddy 自更新重写该目录的几秒窗口内探测会全部失败；永久缓存失败会让所有 Python
// 依赖模块到重启前都无法自愈。改为失败冷却 60s 后自动重探。
let _pyFailUntil = 0;
const PY_FAIL_COOLDOWN_MS = 60 * 1000;
function findPython() {
  if (_pyCacheChecked) return _pyCache; // 已探测成功（永久缓存）
  if (Date.now() < _pyFailUntil) return null; // 失败冷却期内直接复用失败结论
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = cp.spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (!r.error) { _pyCache = c; _pyCacheChecked = true; return c; } // 能正常启动即为可用
    } catch (e) {
      // 尝试下一个
    }
  }
  _pyCache = null;
  _pyFailUntil = Date.now() + PY_FAIL_COOLDOWN_MS;
  return null;
}

module.exports = { findPython };

~~~

---

## `lib\quoteHub.js`  ·  141 行

~~~js
/**
 * 行情 · 统一数据网关（三条底层铁律铺开：行情模块）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：当前价/昨收/涨跌幅只从 stockData.getQuote（腾讯 qt.gtimg.cn）取。
 *     此前 deepAnalysis 内 currentPrice 存在「quote.price」与「history末日close」两套取法，
 *     同一指标两个值——本网关收口为唯一出口，消除该违规。
 *   - 五要素身份 + 分析期快照锁定（beginSnapshot）。
 * 规则二 数据最新性：实时行情 5 分钟有效期 + 交易日感知；过期必带标注；异常值拒收。
 * 规则三 变化与边际分析：
 *   - 变化率 = 当日涨跌幅（相对昨收）；
 *   - 边际 = 当日涨跌幅 − 上一交易日涨跌幅（加速/减速）；
 *   - 方向性变化（涨转跌/跌转涨/横盘突破）+ 连续同向边际的趋势强化信号。
 * 通用原语全部复用 ./ruleCore，本文件只做行情取数与序列组装。
 * ============================================================================
 */
const { getQuote, getHistory } = require('./stockData');
const core = require('./ruleCore');

const {
  TTL, makeDatum, beginSnapshot, changeRate,
  checkFreshness, staleLabel, validateSane,
  analyzeSeries, analyzeWindow,
} = core;

const SOURCE = '腾讯行情(qt.gtimg.cn)';

/**
 * 把「已获取」的 quote / history 包装为规则合规结构——**不发起任何网络请求**。
 * 规则一要求同一指标只取一次：deepAnalysis 等模块已持有 quote/history，
 * 若再调 getQuoteHub 会二次请求，两次之间价格可能变动而自相矛盾。故提供本函数收口。
 * @param {Object} q        getQuote 返回的行情对象
 * @param {Array}  history  日线数组（可选，用于边际分析）
 * @param {Object} opts     { prevPrice }
 */
function wrapQuote(q, history, opts = {}) {
  if (!q || !q.price) return null;

  const fetchTime = new Date().toISOString();
  const dataTime = q.date + (q.time ? ' ' + q.time : '');

  // 规则一②：五要素
  const latest = {
    price: makeDatum('当前价', q.price, dataTime, SOURCE, fetchTime),
    prevClose: makeDatum('昨收', q.prevClose, dataTime, SOURCE, fetchTime),
    changePct: makeDatum('当日涨跌幅(%)', q.changePct, dataTime, SOURCE, fetchTime),
  };

  // 规则二③：异常值校验
  const sanity = {};
  if (opts.prevPrice) {
    const r = validateSane(opts.prevPrice, q.price);
    sanity.price = r;
    if (!r.ok) latest.price.rejected = true;
  }

  // 规则二②：实时行情 5 分钟有效期 + 交易日感知
  const freshness = checkFreshness(dataTime, 'quote', Date.now(), { tradingDayAware: true });
  const staleNote = freshness.expired ? staleLabel(dataTime) : '';

  // 规则三：日线 + 当日行情 → 连续收盘序列（复用内核，不重写规则逻辑）
  const series = (history || [])
    .filter(d => d && d.date && d.close > 0)
    .map(d => ({ date: d.date, value: Number(d.close), source: SOURCE, fetchTime }));

  // 行情日尚未进入日线（盘中/当日未收盘）时，把当日价追加为最后一个点
  if (series.length && series[series.length - 1].date !== q.date && q.price > 0) {
    series.push({ date: q.date, value: q.price, source: SOURCE, fetchTime });
  }

  const analysis = analyzeSeries(series, '收盘价');
  const shortTerm = analyzeWindow(series.slice(-20), '收盘价·近20交易日');

  return {
    ok: true,
    symbol: q.code || null,
    name: q.name,
    latest, sanity, freshness, staleNote,
    analysis, shortTerm,
    dayChange: {
      today: q.changePct != null ? q.changePct : null,
      prevDay: (series.length >= 3)
        ? changeRate(series[series.length - 2].value, series[series.length - 3].value)
        : null,
    },
    dataTime, source: SOURCE, fetchedAt: fetchTime, ttl: TTL,
  };
}

/**
 * 独立使用入口（如 API 端点）：内部取数后转交 wrapQuote，保证只有一条取数路径。
 */
async function getQuoteHub(symbol, opts = {}) {
  const fetchTime = new Date().toISOString();
  let q = null, fetchError = null;
  try {
    q = await getQuote(symbol);
  } catch (e) {
    fetchError = e.message;
  }
  if (!q || !q.price) {
    return {
      ok: false,
      error: fetchError || '未获取到行情数据',
      note: '⚠️ 未能获取行情数据，本次不输出行情结论（规则：无有效数据不得分析）。',
      fetchedAt: fetchTime,
    };
  }
  let hist = [];
  if (opts.withHistory !== false) {
    try {
      hist = (await getHistory(symbol, '3m')) || [];
    } catch (e) {
      hist = []; // 日线取不到不影响行情主数据，仅降级边际分析
    }
  }
  return wrapQuote(q, hist, opts);
}

/**
 * 生成「规则合规」的行情描述片段（数值 + 来源 + 数据时间 + 方向/幅度/边际）
 */
function formatQuoteLine(hub, field = 'price') {
  if (!hub || !hub.latest) return null;
  const d = hub.latest[field];
  if (!d || d.value == null) return null;
  const stale = (hub.freshness && hub.freshness.expired && hub.staleNote) ? `；⚠️ ${hub.staleNote}` : '';
  const base = `${d.name} ${d.value}（来源：${d.source}，数据时间 ${d.dataTime}${stale}）`;
  const a = hub.analysis;
  if (!a || !a.available) return base;
  return `${base}；${a.text}`;
}

module.exports = {
  getQuoteHub,
  wrapQuote,
  formatQuoteLine,
  beginSnapshot,
  TTL,
};

~~~

---

## `lib\rangeDetector.js`  ·  311 行

~~~js
/**
 * 单箱体模型（20261020j 彻底重写，取代 20261020f/g/h 的「固定多窗口」版本）
 * ==========================================================================
 * 用户 2026-10-20 第四轮口径（原话拆解）：
 *   1）「自最新日股价开始回溯20个交易日起，无固定时间长度」
 *      → 种子 = 最近 SEED_DAYS(20) 个交易日（含最新日）；长度不预设上限，向前（历史方向）延长。
 *   2）「只要连续时间段内的股价上下振幅距离中轴不超过10%就可判定并纳入箱体」
 *      → 判定用「中轴 ±tol」的带，不是「收盘 min/max 包络」。段内每个收盘都必须落在带内。
 *   3）「振幅可以随着时间段的延长而放宽」
 *      → tol 随天数增长：tol(len) = min(10% × √(len/20), 15%)
 *        取 √ 的依据：价格随机游走的位移幅度 ∝ √t，箱体越久、正常摆动自然越宽；
 *        上限 15% 是防呆（否则久箱体的带宽会宽到没有意义 —— 用户上次已批评「500日35%只能算宽幅箱体」）。
 *   4）「其他判定逻辑按照原模型」
 *      → 保留：收盘定界（close == 边界视为区间内）、越界段/假突破计数定义、只陈述价格事实。
 *   5）「只要最新的股票收盘价连续三日突破箱体，无论是否放量，即判定箱体失效，直到下一个箱体的形成」
 *      → 失效判据与成交量完全无关（严禁复用 zoneValidity 的放量/反转次数口径）；
 *        失效后状态清空，重新积累 SEED_DAYS 日才可能形成下一个箱体。
 *
 * 与「阻力/支撑区间有效性检验」（lib/zoneValidity.js）的关系：
 *   **完全独立**。zoneValidity 是阻力/支撑的另一套口径（放量 + 反转次数），本文件不 require 它、
 *   不复用其常量、不把箱体边界并进阻力/支撑列表。两者唯一共用的只有「收盘价」这一原始数据。
 *
 * 状态机（逐日推进，t 为「某天」的下标）：
 *   无活动箱体 → 尝试用 [t-19, t] 形成：中轴 = 段内收盘中位数，tol = tol(20)，段内收盘全在带内则成立
 *   有活动箱体 → 用当日 tol(当前长度) 求带，收盘在带内则延长（并更新容差）；
 *                在带外则连续在外天数 +1，累计满 3 天即失效（清空状态）
 */
const SEED_DAYS = 20;          // 形成箱体的最小交易日数（用户：自最新日回溯 20 日起）
const TOL_BASE_PCT = 10;       // 20 日基准容差：距中轴 ±10%
const TOL_CAP_PCT = 15;        // 容差上限（随长度放宽，但不无限放宽）
const OUT_BREAK_DAYS = 3;      // 连续在带外天数达到该值 → 箱体失效（用户：连续三日突破）
const MAX_BARS = 1000;         // 单次扫描最多回看的日K根数（性能保护，非箱体长度上限）

const _r = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(d)) : null);
const _num = (v) => {
  // 注意：Number(null) === 0 —— 必须挡掉空值，否则缺字段会被当成价格为 0
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** 容差（%）：20 日 ±10%，按 √(天数/20) 放宽，上限 ±15% */
function tolPctFor(days) {
  const len = Math.max(SEED_DAYS, Number(days) || SEED_DAYS);
  return _r(Math.min(TOL_BASE_PCT * Math.sqrt(len / SEED_DAYS), TOL_CAP_PCT), 2);
}

/** 由中轴与容差求上下边界 */
function bandOf(mid, tolPct) {
  const t = tolPct / 100;
  return { L: _r(mid * (1 - t)), U: _r(mid * (1 + t)) };
}

/**
 * 箱体上下限 → ②卡「上方关键阻力区间 / 下方关键支撑区间」条目（20261020k，用户要求合并展示）
 *
 * **用哪一个上下限（关键取舍）**：
 *   用「实际收盘区间」envU/envL（如 600909 的 8.54 / 7.03），**不是**中轴±容差的失效线（9.35 / 6.91）。
 *   理由：失效线是纯判定阈值，通常离现价很远、且从未被价格触碰过，摆在「阻力/支撑」清单里没有交易含义；
 *   用户核对形态用的也是实际高低点（「最高 8.54，最低今日 7.03」）。失效线仍留在箱体行与 tooltip 里。
 *
 * **不参与 zoneValidity 过滤**：返回条目带 `isBox:true`，前端必须原样展示、不交给阻力/支撑有效性检验；
 * 箱体是否失效只由本文件「连续 3 日突破」判定（用户第六条：两套检验必须独立）。
 *
 * @param {object} sr detectSingleRange 结果
 * @returns {{upper:object|null, lower:object|null, label:string}|null}
 */
function boxEdges(sr) {
  if (!sr || sr.state !== 'active' || !sr.box) return null;
  const b = sr.box;
  const lastC = _num(sr.lastClose);
  const dur = `（${b.days} 日）`;
  // 已被突破的一侧不再当作阻力/支撑（现价已在其外侧），避免把「刚破的上沿」挂在阻力里误导
  const upper = (lastC == null || lastC <= b.envU + 1e-9)
    ? {
      price: b.envU,
      source: `箱体上沿${dur}`,
      isBox: true,
      kind: 'box-upper',
      note: `箱体 ${b.startDate} 起 ${b.days} 个交易日内的收盘最高；越过失效线 ${b.bandU}（中轴 ${b.mid}×(${1 + b.tolPct / 100})）连续 3 日才判箱体失效`,
    }
    : null;
  const lower = (lastC == null || lastC >= b.envL - 1e-9)
    ? {
      price: b.envL,
      source: `箱体下沿${dur}`,
      isBox: true,
      kind: 'box-lower',
      note: `箱体 ${b.startDate} 起 ${b.days} 个交易日内的收盘最低；跌破失效线 ${b.bandL}（中轴 ${b.mid}×(${1 - b.tolPct / 100})）连续 3 日才判箱体失效`,
    }
    : null;
  return { upper, lower, label: `箱体 ${b.startDate} 起 ${b.days} 个交易日` };
}


function cleanBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(b => b && _num(b.close) != null && _num(b.close) > 0)
    .slice(-MAX_BARS);
}

/**
 * 单箱体检测
 * @param {Array} bars 日K（升序：date/high/low/close/volume）
 * @param {Object} opts { seedDays }
 */
function detectSingleRange(bars, opts = {}) {
  const list = cleanBars(bars);
  const n = list.length;
  const seedDays = opts.seedDays || SEED_DAYS;

  if (n < seedDays) {
    return {
      ok: false,
      state: 'insufficient',
      error: `日K不足 ${seedDays} 根（现有 ${n} 根），无法回溯 ${seedDays} 个交易日形成箱体`,
      need: seedDays,
      barsUsed: n,
      seedDays,
      date: n ? list[n - 1].date : null,
    };
  }

  let active = null;        // 活动箱体
  let lastClosed = null;    // 最近一个失效的箱体
  let pendingSince = null;  // 失效后的起点下标（用于计算「新箱体还差几天」）
  let lastSeedFail = null;  // 最近一次「种子不合格」的原因（用于 noBox 结论）

  for (let t = seedDays - 1; t < n; t++) {
    if (!active) {
      // --- 尝试形成 ---
      const startIdx = t - seedDays + 1;
      const closes = list.slice(startIdx, t + 1).map(b => _num(b.close));
      const mid = median(closes);
      const tol = tolPctFor(seedDays);
      const maxDev = Math.max(...closes.map(c => Math.abs(c - mid) / mid));
      if (maxDev <= tol / 100 + 1e-9) {
        active = {
          startIdx,
          startDate: list[startIdx].date,
          endIdx: t,
          endDate: list[t].date,
          days: seedDays,
          mid,
          tolPct: tol,
          bandL: bandOf(mid, tol).L,
          bandU: bandOf(mid, tol).U,
          outStreak: 0,
          maxOutStreak: 0,
          outSegments: 0,        // 在带外的段数
          fakeBreaks: 0,         // 在带外但未满 3 日即收回的段数
          intraOutDays: 0,       // 盘中（high/low）出带的天数（仅披露）
        };
      } else {
        lastSeedFail = { date: list[t].date, maxDevPct: _r(maxDev * 100), tolPct: tol };
      }
      continue;
    }

    // --- 已有箱体：当日判定 ---
    const days = t - active.startIdx + 1;
    const tol = tolPctFor(days);
    const { L, U } = bandOf(active.mid, tol);
    const c = _num(list[t].close);
    const hi = _num(list[t].high);
    const lo = _num(list[t].low);
    if ((hi != null && hi > U) || (lo != null && lo < L)) active.intraOutDays += 1;

    if (c >= L && c <= U) {
      if (active.outStreak > 0) { active.fakeBreaks += 1; active.outStreak = 0; }  // 未满 3 日收回 → 假突破
      active.endIdx = t;
      active.endDate = list[t].date;
      active.days = days;
      active.tolPct = tol;
      active.bandL = L;
      active.bandU = U;
    } else {
      if (active.outStreak === 0) active.outSegments += 1;
      active.outStreak += 1;
      active.maxOutStreak = Math.max(active.maxOutStreak, active.outStreak);
      if (active.outStreak >= OUT_BREAK_DAYS) {
        const lastInIdx = t - active.outStreak;      // 最后一个仍在带内的交易日
        lastClosed = {
          startDate: active.startDate,
          endDate: list[Math.max(0, lastInIdx)].date,
          days: active.days,
          mid: _r(active.mid),
          tolPct: active.tolPct,
          bandL: active.bandL,
          bandU: active.bandU,
          fakeBreaks: active.fakeBreaks,
          intraOutDays: active.intraOutDays,
          invalidDate: list[t].date,
          invalidDir: c > U ? '向上' : '向下',
          invalidClose: _r(c),
          invalidStreak: active.outStreak,
          invalidLevel: c > U ? active.bandU : active.bandL,
        };
        active = null;
        pendingSince = t;   // 基准 = 失效当日（「已过 N 日」指失效之后经过的交易日数）
      }
    }
    if (!active && pendingSince == null) pendingSince = t;
  }

  const lastDate = list[n - 1].date;
  const lastClose = _r(_num(list[n - 1].close));

  if (!active) {
    // elapsed = 失效日之后的交易日数（失效当日记 0）
    const elapsed = pendingSince == null ? 0 : Math.max(0, (n - 1) - pendingSince);
    const remaining = Math.max(0, seedDays - elapsed);
    const parts = [];
    if (lastClosed) {
      parts.push(`上一个箱体（${lastClosed.startDate} 起 ${lastClosed.days} 个交易日，中轴 ${lastClosed.mid}）已于 ${lastClosed.invalidDate} 失效：连续 ${lastClosed.invalidStreak} 日收盘${lastClosed.invalidDir}突破 ${lastClosed.invalidLevel}`);
    } else {
      parts.push(`近 ${n} 个交易日内未形成过箱体${lastSeedFail ? `：最近一次 20 日种子（截至 ${lastSeedFail.date}）距中轴最大偏离 ${lastSeedFail.maxDevPct}% > 允许 ${lastSeedFail.tolPct}%` : ''}`);
    }
    parts.push(remaining > 0
      ? `新箱体需在失效后重新积累 ${seedDays} 个交易日（已过 ${elapsed} 日，还差 ${remaining} 日）`
      : `已满足 ${seedDays} 日种子长度，但区间振幅仍未收窄到容差内`);
    return {
      ok: true,
      state: 'noBox',
      date: lastDate,
      barsUsed: n,
      seedDays,
      lastClose,
      lastInvalid: lastClosed,
      nextFormation: { seedDays, elapsed, remaining },
      conclusion: parts.join('；'),
    };
  }

  // --- 活动箱体：包络（展示用）+ 盘中统计 ---
  const seg = list.slice(active.startIdx, active.endIdx + 1);
  const envL = _r(Math.min(...seg.map(b => _num(b.close))));
  const envU = _r(Math.max(...seg.map(b => _num(b.close))));
  const tolNow = tolPctFor(active.days);
  const bandNow = bandOf(active.mid, tolNow);
  // 20261020l：**倒计时只在真的越界时才存在**。收盘还在箱体内（或在带内）时，
  // 失效条件根本没被触发，`remainDays` 必须为 null——否则前端会渲染成「距失效还需 3 日」，
  // 让人误以为模型在倒数、三日后自动失效（用户实测报障：股价在箱体里震荡却显示还剩 3 日）。
  const remainToInvalid = active.outStreak > 0 ? Math.max(0, OUT_BREAK_DAYS - active.outStreak) : null;

  const ret = {
    ok: true,
    state: 'active',
    date: lastDate,
    barsUsed: n,
    seedDays,
    lastClose,
    box: {
      startDate: active.startDate,
      endDate: active.endDate,
      days: active.days,
      mid: _r(active.mid),
      tolPct: tolNow,
      bandL: bandNow.L,
      bandU: bandNow.U,
      envL,
      envU,
      ampEnvPct: _r((envU - envL) / active.mid * 100),                       // 实际包络宽度 ÷ 中轴（披露）
      halfDevPct: _r(Math.max(Math.abs(envU - active.mid), Math.abs(active.mid - envL)) / active.mid * 100),
      fakeBreaks: active.fakeBreaks,
      outSegments: active.outSegments,
      maxOutStreak: active.maxOutStreak,
      intraOutDays: active.intraOutDays,
    },
    invalidation: {
      rule: `最新收盘连续 ${OUT_BREAK_DAYS} 日突破箱体边界即失效（与是否放量无关）`,
      needDays: OUT_BREAK_DAYS,
      currentStreak: active.outStreak,
      remainDays: remainToInvalid,
      upLevel: bandNow.U,
      downLevel: bandNow.L,
      note: active.outStreak > 0
        ? `当前已连续 ${active.outStreak} 日在箱体边界外，再有 ${remainToInvalid} 日即失效`
        : '当前收盘在箱体内，未触发失效',
    },
    tolerance: {
      basePct: TOL_BASE_PCT,
      capPct: TOL_CAP_PCT,
      basis: `20 日基准 ±${TOL_BASE_PCT}%，按 √(天数/20) 放宽、上限 ±${TOL_CAP_PCT}%（当前 ${active.days} 日 → ±${tolNow}%）`,
    },
    conclusion: `箱体自 ${active.startDate} 起延续 ${active.days} 个交易日（中轴 ${_r(active.mid)}，收盘包络 ${envL} ~ ${envU}，容差 ±${tolNow}%）；${active.outStreak > 0 ? `当前已连续 ${active.outStreak} 日在边界外，再有 ${remainToInvalid} 日即失效` : '当前收盘在箱体内，箱体有效'}`,
  };
  // 上下限并入②卡阻力/支撑清单（20261020k）；单独挂字段，前端不得交给 zoneValidity 过滤
  ret.edges = boxEdges(ret);
  return ret;
}

module.exports = {
  detectSingleRange,
  boxEdges,
  tolPctFor,
  bandOf,
  median,
  SEED_DAYS,
  TOL_BASE_PCT,
  TOL_CAP_PCT,
  OUT_BREAK_DAYS,
};

~~~

---

## `lib\relevanceLearning.js`  ·  227 行

~~~js
/**
 * 关联度 / 弱关联持续性经验库（Part B 核心）
 * --------------------------------------------------------------
 * 解决"弱关联消息被当成强利好/利空打分"的根因：
 *   mRNA 疫苗作为创新药利好 → 对医疗器械股（如圣湘生物）影响有限，
 *   但原系统按【强关联 + 重大事件×1.3 加码】打分，方向还可能反了。
 *
 * 设计（用户要求的三步链路）：
 *   1) relevanceScore(industry, theme)：个股子行业 与 主题（mRNA/疫苗/创新药…）
 *      的关联度 0~1。同子行业=1.0，同域弱亲疏=0.3~0.6，跨域=0.1。
 *   2) getExperienceDiscount / effectiveRelevance：基于历史"弱关联主题是否持续误导"
 *      的经验折扣；历史上该主题对个股多次反向/噪音 → 折扣下调。
 *      最终有效衰减 = 关联度 × 经验折扣。
 *   3) recordOutcome：结算复盘时记录 (个股, 主题, 关联度, 主题信号方向, 实际方向)，
 *      若弱关联主题持续误导则经验折扣递减，下次再下调关联度评分。
 *
 * 被以下模块消费：
 *   - newsSearch.getSectorNewsSentiment（板块消息联动：按主题逐条关联度加权，
 *     且 ×1.3 重大事件加码只在高关联主题生效）
 *   - crossMarket.getCrossMarketSignal（跨市场传导：信号按对标主题关联度衰减）
 *   - sameDayJudgment.settleRecord（结算时记录持续性，驱动经验折扣）
 */

const fs = require('fs');
const path = require('path');

// ---- 子行业 → 大领域 ----
// 医疗器械、体外诊断、医药、生物制品、创新药、疫苗… 都属"医药"大领域，但子行业亲疏不同。
const DOMAIN = {
  '医疗器械': '医药', '体外诊断': '医药', 'IVD': '医药', '医药': '医药',
  '生物制品': '医药', '化学制药': '医药', '中药': '医药', '医疗服务': '医药',
  '疫苗': '医药', '创新药': '医药', '生物医药': '医药',
  '半导体': '电子科技', '芯片': '电子科技', '集成电路': '电子科技',
  '消费电子': '电子科技', '电子': '电子科技', '光模块': '电子科技',
  '人工智能': '电子科技', '算力': '电子科技',
  '通信': '电子科技', '5G': '电子科技', '6G': '电子科技',
  '计算机': '计算机', '软件': '计算机', '信创': '计算机', 'IT服务': '计算机',
  '新能源': '新能源', '光伏': '新能源', '锂电池': '新能源', '储能': '新能源', '风电': '新能源',
  '新能源汽车': '新能源', '汽车': '新能源',
  '保险': '金融', '证券': '金融', '券商': '金融', '银行': '金融',
  '食品饮料': '消费', '白酒': '消费', '消费': '消费', '零售': '消费',
  '有色': '周期', '钢铁': '周期', '煤炭': '周期', '石油石化': '周期', '化工': '周期', '建材': '周期',
  '军工': '军工', '国防': '军工',
  '房地产': '地产', '建筑装饰': '地产', '建筑': '地产',
  '传媒': '传媒', '游戏': '传媒',
  '环保': '环保', '农业': '农业', '物流': '物流',
};

// ---- 主题（关键词）→ 核心 / 弱相关子行业 ----
// 同一条新闻主题，对"核心子行业"强相关，对"弱相关子行业"只是沾边（设备/诊断 ≠ 做药）。
// 例：mRNA 主题核心是生物制品/创新药/疫苗，医疗器械只是设备/诊断，弱相关 → 0.3。
//     泛主题（医药生物/医药）对医疗器械是核心 → 0.85（器械公司本就是医药板块成员）。
const THEME_PROFILE = {
  'mRNA':      { core: ['生物制品', '创新药', '疫苗', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '医疗服务', '中药', '化学制药'] },
  '疫苗':      { core: ['疫苗', '生物制品', '创新药', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '化学制药', '医疗服务'] },
  '创新药':    { core: ['创新药', '医药', '生物制品', '化学制药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '医疗服务'] },
  '生物医药':  { core: ['生物制品', '创新药', '疫苗', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '化学制药', '医疗服务'] },
  '医药生物':  { core: ['医药', '生物制品', '化学制药', '中药', '医疗器械', '体外诊断', '创新药', '疫苗', '医疗服务', '生物医药'], weak: [] },
  '医药':      { core: ['医药', '生物制品', '化学制药', '中药', '医疗器械', '体外诊断', '创新药', '医疗服务'], weak: [] },
  '半导体':    { core: ['半导体', '芯片', '集成电路', '电子'], weak: ['消费电子', '光模块', '通信'] },
  '芯片':      { core: ['芯片', '半导体', '集成电路', '电子'], weak: ['消费电子', '光模块', '通信'] },
  '人工智能':  { core: ['人工智能', '算力', '计算机', '软件'], weak: ['通信', '光模块', '消费电子'] },
  '算力':      { core: ['算力', '人工智能', '通信', '光模块'], weak: ['计算机', '消费电子'] },
  '新能源':    { core: ['新能源', '光伏', '锂电池', '储能', '风电'], weak: ['新能源汽车'] },
  '光伏':      { core: ['光伏', '新能源', '储能'], weak: ['风电', '锂电池'] },
  '锂电池':    { core: ['锂电池', '新能源', '储能'], weak: ['光伏', '新能源汽车'] },
  '新能源汽车': { core: ['新能源汽车', '汽车'], weak: ['锂电池', '新能源'] },
};

// 美股对标 → 主题（用于跨市场传导关联度）
const BENCHMARK_THEME = { 'MRNA': 'mRNA', 'BNTX': '疫苗', 'NVDA': '人工智能', 'AMD': '半导体', 'MSFT': '人工智能', 'AAPL': '消费电子', 'TSLA': '新能源汽车', 'NIO': '新能源汽车', 'FSLR': '光伏', 'FCX': '有色', 'NEM': '有色', 'GOLD': '黄金', 'XOM': '石油石化', 'CVX': '石油石化' };

const WEAK_THRESHOLD = 0.6; // 关联度 < 0.6 视为弱关联（不享受重大事件×1.3 加码）

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'relevance_learning.json');

function _norm(s) {
  return String(s || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
}
function _domainOf(industry) {
  const n = _norm(industry);
  if (!n) return '';
  for (const [k, v] of Object.entries(DOMAIN)) {
    if (n.includes(k) || k.includes(n)) return v;
  }
  return n; // 未知归到自身
}
function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 关联度 0~1：个股子行业(industry) 与 主题(theme) 的相关强度。
 *  - 完全同子行业 → 1.0
 *  - 同大领域但不同子行业 → 看 THEME_PROFILE（核心 0.85，弱相关 0.30）
 *  - 跨大领域 → 0.1
 * 主题越具体（mRNA）越敏感；泛主题（医药）对同域股都较高。
 * 例：relevanceScore('医疗器械','mRNA') ≈ 0.30（弱相关）
 *    relevanceScore('医疗器械','医药生物') ≈ 0.85（核心）
 *    relevanceScore('生物制品','mRNA') ≈ 0.85（核心）
 */
function relevanceScore(industry, theme) {
  const ind = _norm(industry);
  const th = _norm(theme);
  if (!ind || !th) return 0.5; // 缺信息按中性
  // 直接同子行业 / 包含关系
  if (ind === th || ind.includes(th) || th.includes(ind)) return 1.0;

  const profile = THEME_PROFILE[th];
  const dom = _domainOf(ind);
  const themeDom = _domainOf(th);

  if (profile) {
    const inList = (arr) => arr.some(s => {
      const ns = _norm(s);
      return ind === ns || ind.includes(ns) || ns.includes(ind);
    });
    if (inList(profile.core)) return 0.85;
    if (inList(profile.weak)) return 0.30;
  }
  // 无精确 profile：同域给 0.6，跨域给 0.1
  if (dom && themeDom && dom === themeDom) return 0.6;
  return 0.1;
}

// ---- 经验折扣持久化 ----
let cache = null;
function _load() {
  if (cache) return cache;
  let obj = null;
  try { obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { obj = null; }
  cache = {
    entries: (obj && Array.isArray(obj.entries)) ? obj.entries : [],
    themeStats: (obj && obj.themeStats) ? obj.themeStats : {},
  };
  return cache;
}
function _save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

// 经验折扣：基于历史"弱关联主题是否持续误导"。默认 1.0。
// 当某主题对个股反复反向/噪音（实际方向与主题信号相反），折扣递减（下限 0.5）。
function getExperienceDiscount(symbol, theme) {
  const st = _load();
  const key = `${symbol || ''}|${_norm(theme) || theme}`;
  const ts = st.themeStats[key];
  return ts && ts.discount != null ? ts.discount : 1.0;
}

// 有效关联度 = 关联度 × 经验折扣（弱关联 + 历史误导 → 进一步衰减）
function effectiveRelevance(industry, theme, symbol) {
  const r = relevanceScore(industry, theme);
  const d = getExperienceDiscount(symbol, theme);
  return round(r * d, 3);
}

// 跨市场对标股的关联度（给定美股代码，查其主题再算关联度）
function benchmarkRelevance(industry, ticker, symbol) {
  const theme = BENCHMARK_THEME[String(ticker || '').toUpperCase()];
  if (!theme) return { theme: null, relevance: 0.5 };
  return { theme, relevance: effectiveRelevance(industry, theme, symbol) };
}

/**
 * 结算复盘：记录一条 (个股, 主题, 关联度, 主题信号方向, 实际方向)。
 * predictedSign: +1/-1（主题信号方向）；actualDir: '涨'/'跌'/'震荡'。
 * 弱关联(relevance<0.6) 且 主题信号方向与真实方向相反 → 记为"误导"，经验折扣递减。
 */
function recordOutcome({ symbol, industry, theme, predictedSign, actualDir, relevance, date }) {
  const st = _load();
  const rel = relevance != null ? relevance : relevanceScore(industry, theme);
  const sign = Math.sign(predictedSign || 0);
  const actualSign = actualDir === '涨' ? 1 : actualDir === '跌' ? -1 : 0;
  const misleading = rel < WEAK_THRESHOLD && sign !== 0 && sign === -actualSign;
  st.entries.push({
    symbol, theme: _norm(theme) || theme, relevance: rel,
    predictedSign: sign, actualDir, misleading,
    date: date || localDateStr(),
  });
  if (st.entries.length > 500) st.entries = st.entries.slice(-500);

  if (symbol) {
    const key = `${symbol}|${_norm(theme) || theme}`;
    if (!st.themeStats[key]) st.themeStats[key] = { weakSamples: 0, misleadCount: 0, discount: 1.0, lastUpdated: null };
    const ts = st.themeStats[key];
    if (rel < WEAK_THRESHOLD) {
      ts.weakSamples = (ts.weakSamples || 0) + 1;
      if (misleading) ts.misleadCount = (ts.misleadCount || 0) + 1;
      ts.discount = round(Math.max(0.5, 1 - 0.1 * (ts.misleadCount || 0)), 3);
    }
    ts.lastUpdated = new Date().toISOString();
  }
  _save();
  return st;
}

// 调试用：返回当前经验库快照
function getState() {
  const st = _load();
  return {
    weakThreshold: WEAK_THRESHOLD,
    entries: st.entries.slice(-50),
    totalEntries: st.entries.length,
    themeStats: st.themeStats,
  };
}

module.exports = {
  relevanceScore,
  getExperienceDiscount,
  effectiveRelevance,
  benchmarkRelevance,
  recordOutcome,
  getState,
  WEAK_THRESHOLD,
  BENCHMARK_THEME,
};

~~~

---

## `lib\reportSync.js`  ·  354 行

~~~js
/**
 * Report Sync Module (20260821f)
 * =====================================================================
 * 财报事件 → 资料库自动同步
 *
 * 一致性原则：判断引擎/公告源检测到某标的发布了最新定期报告（年报/半年报/季报）时，
 * 自动检查资料库（docStore）是否已持有该报告期的 PDF；若缺失，自动触发下载脚本
 * （scripts/download_reports.py，巨潮优先）并登记进资料库。
 *
 * 幂等约束：
 *  - 进程内 _inflight 防并发：同一 (symbol,type,year) 同时只允许一个下载任务；
 *  - 持久化状态 data/report_sync.json：每个 (symbol,type,year) 每日仅同步一次；
 *  - 下载脚本自身有 _downloaded.json 去重清单，重复调用不会重复下载。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const docStore = require('./docStore');

const SYNC_STATE_FILE = path.join(__dirname, '..', 'data', 'report_sync.json');
const DOWNLOAD_SCRIPT = path.join(__dirname, '..', 'scripts', 'download_reports.py');
const REPORTS_OUT_DIR = path.join(__dirname, '..', 'data', 'reports');

const _inflight = new Set(); // `${symbol}:${type}:${year}`

// 报告标题识别：兼容「2026年中期报告」「2026年半年度报告」「2025年年度报告」
// 「2024_年半年度报告」（下划线变体）「2026年半年度报告全文」等写法。
// 20260821f 增强：单独提取年份后按剩余文本判断类型，兼容「2026年中期拟派现」、
// 「2026年中期业绩发布会」「2026中报」等不含"报告"字样的中报事件标题，
// 避免判断引擎已捕捉到中报事件、资料库联动却因标题字面不匹配而漏检。
const REPORT_YEAR_RE = /(20\d{2})/;
const SEMI_RE = /(中期报告|半年度报告|半年报|中期|中报)/;
const QUARTER_RE = /(季度报告|一季报|三季报|季报)/;
const ANNUAL_RE = /(年度报告|年报)/;

const TYPE_LABEL = { annual: '年报', semi: '半年报', quarterly: '季报' };

// [20261029m] 从标题解析「报告期类型+年份」。docStore 登记的 year 取的是文件名首个日期
// = 公告日期年份：「2026-04-28 发布的《2026年第一季度报告》」与「2026-03-27 发布的
// 《2025年度报告》」都被标 year=2026——前者错误挡住 2026 三季报同步（603288/000783
// 实证：hasReportDoc 假阳性），后者年份显示错 +1。口径与 lib/ai/earnings.js pickReportDoc 一致。
const PERIOD_PATS = [
  { type: 'annual', re: /(\d{4})年年度报告/ },
  { type: 'semi', re: /(\d{4})年(?:半年度|中期)报告/ },
  { type: 'q1', re: /(\d{4})年第?一季度报告/ },
  { type: 'q3', re: /(\d{4})年第?三季度报告/ },
];
function reportPeriodOf(text) {
  for (const p of PERIOD_PATS) {
    const m = String(text || '').match(p.re);
    if (m) return { type: p.type, year: m[1] };
  }
  return null;
}

function normSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase();
}

/**
 * 从新闻/公告标题中检测最新财报发布事件。
 * @param {string} symbol 股票代码（可带 SH/SZ 前缀）
 * @param {string} name   股票名称
 * @param {Array}  newsList   个股新闻列表 [{title,date}]
 * @param {Array}  announceList 公告列表 [{title,date}]
 * @returns {null|{symbol,type,year,title,date}}
 */
function detectReportEvent(symbol, name, newsList = [], announceList = []) {
  const titles = [];
  for (const n of newsList || []) if (n && n.title) titles.push({ title: String(n.title), date: n.date || '' });
  for (const a of announceList || []) if (a && a.title) titles.push({ title: String(a.title), date: a.date || '' });
  let best = null;
  for (const t of titles) {
    const m = t.title.match(REPORT_YEAR_RE);
    if (!m) continue;
    const year = m[1];
    const rest = t.title.slice((m.index || 0) + m[0].length);
    let type = null;
    if (SEMI_RE.test(rest)) type = 'semi';
    else if (QUARTER_RE.test(rest)) type = 'quarterly';
    else if (ANNUAL_RE.test(rest)) type = 'annual';
    if (!type) continue;
    // 取最近一年份的事件（同一年取第一条即可）
    if (!best || year > best.year) {
      best = { symbol: normSymbol(symbol), type, year, title: t.title, date: t.date };
    }
  }
  return best;
}

/**
 * 检查资料库是否已持有某报告期文档。
 * [20261029m] 按标题解析报告期年份+季度（docStore.year 是公告年，不可靠）；
 * quarterly 事件按标题收窄到具体季度，避免「已有 Q1」挡住 Q3。
 */
function hasReportDoc(symbol, type, year, title) {
  const code = normSymbol(symbol);
  const docs = docStore.listCompanyDocuments(code);
  const t = String(title || '');
  const want = type === 'quarterly'
    ? (/三季报|第三季度/.test(t) ? 'q3' : /一季报|第一季度/.test(t) ? 'q1' : null)
    : (type === 'annual' || type === 'semi') ? type : null;
  const periodOf = d => reportPeriodOf(`${d.title || ''} ${d.fileName || ''}`);
  if (want) {
    return docs.some(d => {
      const p = periodOf(d);
      return p && p.type === want && p.year === String(year);
    });
  }
  // 泛称「季报」（未指明季度）：该年任意季度报告均视为已覆盖
  return docs.some(d => {
    const p = periodOf(d);
    return p && (p.type === 'q1' || p.type === 'q3') && p.year === String(year);
  });
}

/** 读取同步状态（幂等记录） */
function readSyncState() {
  try { return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function writeSyncState(state) {
  try {
    fs.mkdirSync(path.dirname(SYNC_STATE_FILE), { recursive: true });
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { console.error('[reportSync] 写状态失败:', e.message); }
}

/** 是否今日已同步过该事件 */
function _doneToday(key, today) {
  const st = readSyncState();
  const rec = st[key];
  return !!(rec && rec.doneAt && String(rec.doneAt).slice(0, 10) === today);
}

/**
 * [20261029l] 事件类型 → 下载脚本类型参数。
 * 脚本合法键为 annual/semi/q1/q3（无 quarterly）：此前直接传 quarterly 被脚本
 * 静默丢弃并回退 annual,semi（静默降级 bug），三季报/一季报从未被下载过
 * （2026-10-29 华安证券 600909 用户报障，全自选股同因）。按事件标题收窄季度，
 * 泛称「季报」时 q1+q3 都查。
 */
function scriptTypesFor(event) {
  if (event.type !== 'quarterly') return event.type;   // annual / semi 原样
  const t = String(event.title || '');
  if (/三季报|第三季度/.test(t)) return 'q3';
  if (/一季报|第一季度/.test(t)) return 'q1';
  return 'q1,q3';
}

/**
 * [20261029l] 新文档落地后定点失效该股财报解读缓存。
 * earnings 缓存 TTL 30 天：PDF 变了但缓存未失效 → 财报解读停留在旧报告节选
 * （用户感知「资料库更新了、财报解读不更新」）。删除 {code}_earnings.json，
 * 下次打开个股页自动按新 PDF 重算（LLM 重算仅在用户打开时触发，不主动耗额度）。
 */
function invalidateEarningsCache(code) {
  const f = path.join(__dirname, '..', 'data', 'ai_cache', `${code}_earnings.json`);
  try {
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`[reportSync] 已失效 ${code} 财报解读缓存（新文档落地）`); return true; }
  } catch (e) { console.error('[reportSync] 失效财报解读缓存失败:', e.message); }
  return false;
}

function _today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 查找 Python 解释器（与 server.js findPython 同源候选，避免重复探测开销） */
let _pyChecked = false;
let _pyCache = null;
function findPython() {
  if (_pyChecked) return _pyCache;
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = cp.spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (!r.error) { _pyCache = c; _pyChecked = true; return c; }
    } catch (e) { /* continue */ }
  }
  _pyCache = null; _pyChecked = true;
  return null;
}

/** 登记 data/reports 下新下载的 PDF（与 server.js registerDownloadedReports 同逻辑，供 lib 独立调用） */
function registerDownloadedReports() {
  const reportsDir = REPORTS_OUT_DIR;
  if (!fs.existsSync(reportsDir)) return 0;
  let registered = 0;
  for (const codeDir of fs.readdirSync(reportsDir)) {
    const dir = path.join(reportsDir, codeDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.pdf$/i.test(f)) continue;
      const relPath = `reports/${codeDir}/${f}`;
      if (docStore.findByRelativePath(relPath)) continue;
      // [20261029m] year = 报告期年份（标题解析），公告日期年份仅兜底；类型同步按标题判定
      const per = reportPeriodOf(f);
      let type;
      if (per) type = (per.type === 'q1' || per.type === 'q3') ? 'quarterly' : per.type;
      else if (/(中期报告|半年度报告)/.test(f)) type = 'semi';
      else if (/(季度报告|一季报|三季报)/.test(f)) type = 'quarterly';
      else type = 'annual';
      const ym = f.match(/(\d{4})-(\d{2})-(\d{2})/);
      const year = per ? per.year : (ym ? ym[1] : '');
      const full = path.join(dir, f);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) {}
      docStore.addDocument({
        stockCode: codeDir,
        stockName: '',
        type,
        fileName: f,
        fileSize: size,
        year,
        relativePath: relPath,
        title: f.replace(/\.pdf$/i, ''),
      });
      registered++;
    }
  }
  if (registered > 0) console.log(`[reportSync] Registered ${registered} report file(s) into doc store.`);
  return registered;
}

/**
 * 同步某标的的指定报告期：若资料库缺失则下载并登记。
 * 幂等：进程内防并发 + 每日每 (symbol,type,year) 一次。
 * @param {{symbol,type,year,title,date}} event detectReportEvent 返回的事件
 * @returns {Promise<{ok,event,gap,downloaded,registered,reason}>}
 */
async function syncReportForSymbol(event) {
  const code = normSymbol(event && event.symbol);
  const type = event && event.type;
  const year = event && event.year;
  if (!code || !type || !year) return { ok: false, reason: '事件缺少 code/type/year' };

  // 1) 缺口检查：资料库已有该报告期文档 → 无需同步
  if (hasReportDoc(code, type, year, event && event.title)) {
    return { ok: true, gap: false, reason: '资料库已有 ' + year + ' ' + (TYPE_LABEL[type] || type) };
  }

  // 2) 幂等：今日已同步过 / 正在同步 → 跳过
  const key = `${code}:${type}:${year}`;
  const today = _today();
  if (_doneToday(key, today)) {
    return { ok: false, gap: true, reason: '今日已尝试同步，跳过（见 data/report_sync.json）' };
  }
  if (_inflight.has(key)) {
    return { ok: false, gap: true, reason: '同步任务进行中，跳过' };
  }
  _inflight.add(key);

  try {
    // 3) 触发下载脚本（仅该类型、回溯 1 年，巨潮优先）
    const py = findPython();
    if (!py) {
      const msg = '未找到 Python 解释器';
      _markDone(key, today, 'error', msg);
      return { ok: false, gap: true, reason: msg };
    }
    if (!fs.existsSync(DOWNLOAD_SCRIPT)) {
      const msg = '下载脚本不存在: ' + DOWNLOAD_SCRIPT;
      _markDone(key, today, 'error', msg);
      return { ok: false, gap: true, reason: msg };
    }
    const args = [
      DOWNLOAD_SCRIPT,
      '--codes', code,
      '--years', '1',
      '--types', scriptTypesFor(event),   // [20261029l] quarterly → q3/q1（按标题收窄），不再静默降级
      '--out', REPORTS_OUT_DIR,
      '--channel', 'cninfo',
      '--json',
    ];
    console.log(`[reportSync] 触发下载: ${py} ${args.join(' ')}`);
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileP = promisify(execFile);
    let stdout = '';
    try {
      const r = await execFileP(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 180000 });
      stdout = r.stdout || '';
    } catch (e) {
      stdout = (e.stdout || '') + (e.stderr || '');
    }
    // 4) 登记新下载文件（有新文档 → 定点失效该股财报解读缓存，下次打开自动按新 PDF 重算）
    const registered = registerDownloadedReports();
    if (registered > 0) invalidateEarningsCache(code);

    // 5) 汇总结果
    let downloaded = 0, skipped = 0, errors = 0;
    const m = stdout.match(/RESULT_JSON:(\{[\s\S]*\})/);
    if (m) {
      try {
        const summary = JSON.parse(m[1]);
        downloaded = summary.downloaded || 0;
        skipped = summary.skipped || 0;
        errors = summary.errors || 0;
      } catch (e) {}
    }
    const gapNow = !hasReportDoc(code, type, year, event && event.title);
    const status = (downloaded > 0 || registered > 0) ? 'ok' : (gapNow ? 'error' : 'ok');
    const reason = gapNow
      ? `下载未命中（脚本 downloaded=${downloaded} skipped=${skipped} errors=${errors}），资料库仍缺 ${year} ${TYPE_LABEL[type] || type}`
      : `已同步 ${year} ${TYPE_LABEL[type] || type}（新下载 ${downloaded}，登记 ${registered}）`;
    _markDone(key, today, status, reason);
    return { ok: !gapNow, gap: gapNow, downloaded, skipped, errors, registered, reason };
  } finally {
    _inflight.delete(key);
  }
}

function _markDone(key, today, status, reason) {
  const st = readSyncState();
  st[key] = { doneAt: new Date().toISOString(), date: today, status, reason };
  writeSyncState(st);
}

/**
 * 获取某标的的「资料同步状态」概览（供前端展示）。
 * @returns {{code, gaps:[], events:[]}}
 */
function getSyncStatus(symbol) {
  const code = normSymbol(symbol);
  const st = readSyncState();
  const events = [];
  for (const [k, rec] of Object.entries(st)) {
    if (k.startsWith(code + ':')) events.push({ key: k, ...rec });
  }
  events.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  return { code, events };
}

module.exports = {
  detectReportEvent,
  hasReportDoc,
  syncReportForSymbol,
  getSyncStatus,
  registerDownloadedReports,
  reportPeriodOf,
  normSymbol,
};

~~~

---

## `lib\reviewContext.js`  ·  318 行

~~~js
/**
 * lib/reviewContext.js — 每日复盘「干净 JSON Context」构建器（20261110b · LLM 生成架构）
 * ==================================================================================
 * 用户 2026-11-10 16:03 裁决：停止纯代码拼接报告。
 *   「代码只负责取数：抓取原始数据（涨停数、连板梯队、新闻标题等），
 *     组装成一个干净的 JSON 对象，作为 Context 喂给大模型。」
 *
 * 本文件的唯一职责：把 gatherSources() 的采集结果与确定性引擎算出的**数值**
 * 清洗成一个不含任何报告文案的 JSON 对象。文字生成全部交给 lib/reviewLlm.js。
 *
 * 与旧 lib/reviewOutput.js 的本质区别：
 *   - 旧：SECTION_DEFS 固定 11 段 + lhbLines()/plainify()/plainRisks() 拼句子 + qualityOf() 硬门禁。
 *   - 新：无段落定义、无文本拼装、无质检拦截；只输出数据与枚举。
 *
 * 【重要】computed 段只保留引擎产出的**数值 / 枚举 / 标签**，刻意过滤掉引擎生成的
 * 句子（trends.*.note、risks.*.fact、cards.*.gradeReason / verifyLogic / attribution 等）。
 * 否则 LLM 会照抄这些写死的文案，等于换汤不换药。归因由 LLM 基于原始新闻标题自己完成。
 *
 * 【诚实边界】缺失项保留 null / status!='ok'，不补占位数字、不臆造。
 */
'use strict';

// 输出契约从「11 段结构化 JSON」变为「一整篇 Markdown」，按 SCHEMA_VERSION 升级铁律必须升版，
// 否则 data/reviews/*.json 里的旧文档会被 runReview 的幂等判定永久复用，新报告永远进不来。
const SCHEMA_VERSION = 'review-llm-20261110b';
const CONTEXT_VERSION = 'review-context-20261110b';
const MAX_ITEMS = 40;
const MAX_STR = 600;
const MAX_DEPTH = 6;

function byKey(sources, key) { return (sources || []).find(s => s && s.key === key) || null; }
function srcData(sources, key) { const s = byKey(sources, key); return s && s.data ? s.data : null; }
function srcOk(sources, key) { const s = byKey(sources, key); return !!(s && s.status === 'ok' && s.data); }

/** 递归清洗：去内部字段/函数/循环引用，限制深度、数组长度与字符串长度。不改写数值。 */
function sanitize(v, depth, seen) {
  const d = depth || 0;
  const s = seen || new WeakSet();
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
  if (d >= MAX_DEPTH) return null;
  if (typeof v === 'object') {
    if (s.has(v)) return null;
    s.add(v);
    if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map(x => sanitize(x, d + 1, s));
    const out = {};
    for (const k of Object.keys(v)) {
      if (k.startsWith('__') || k.startsWith('_') || typeof v[k] === 'function') continue;
      out[k] = sanitize(v[k], d + 1, s);
    }
    return out;
  }
  return null;
}

/** 严格白名单：只取数值 / 枚举 / 标签，杜绝引擎生成的句子混入 Context。 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = sanitize(obj[k]);
  return out;
}
function pickList(arr, keys) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_ITEMS).map(x => pick(x, keys)).filter(Boolean);
}

/** 龙虎榜数据块：build() 与晚间补录共用，避免两处字段口径漂移。 */
function lhbBlock(H, date, sourceLabel, available) {
  const ok = !!available;
  return {
    available: ok,
    count: ok ? (H.count == null ? null : H.count) : null,
    netBuyTotal: ok ? (H.netBuyTotal == null ? null : H.netBuyTotal) : null,
    buyTotal: ok ? (H.buyTotal == null ? null : H.buyTotal) : null,
    sellTotal: ok ? (H.sellTotal == null ? null : H.sellTotal) : null,
    asOf: ok ? (H.asOf || date) : null,
    source: ok ? (H.source || sourceLabel || null) : null,
    note: !ok ? '盘后延迟发布数据，当前时点尚未发布，晚间补录（非接口故障、非数据缺失）' : null,
    topNetBuy: ok ? briefList(H.topNetBuy, ['name', 'code', 'netBuyYi', 'reason'], 5) : [],
    reasonStats: ok ? briefList(H.reasonStats, ['reason', 'count'], 5) : [],
    institutionBuyMentions: ok && H.institutionBuyMentions != null ? H.institutionBuyMentions : null,
    institutionSellMentions: ok && H.institutionSellMentions != null ? H.institutionSellMentions : null,
    countingCaveat: '机构买卖为「解读」文本关键词计数，不是席位穿透核验',
  };
}

const CANDIDATE_KEYS = ['name', 'code', 'grade', 'category', 'quadrant', 'drivers',
  'trackable', 'confirmCount', 'vetoCount', 'layer', 'capitalContinuity', 'sector'];
const TOPIC_CARD_KEYS = ['name', 'grade', 'stage', 'quadrant', 'voteQuality',
  'changePct', 'limitUpCount', 'newsLevel', 'newsTime', 'drivers',
  'catalyst', 'verifyLogic'];

// ---------------------------------------------------------------------------
// 体积控制：Context 直接注入大模型用户消息。实测未裁剪时可达 88KB，
// 导致模型 240s 无响应超时（模型本身最小请求仅 2-3s）。因此：
//   ① 原始大块走显式字段白名单，只保留复盘真正用得上的数值 / 名称；
//   ② 末尾 trimToBudget() 做字符预算硬闸，确定性裁剪低优先级明细。
// 注意：裁剪只丢明细，绝不改写任何数值、绝不补齐缺失。
// ---------------------------------------------------------------------------
const MAX_CONTEXT_CHARS = 12000;
function briefList(arr, keys, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, n == null ? 8 : n).map(x => pick(x, keys)).filter(Boolean);
}
function compactQuote(q) {
  if (!q) return null;
  return {
    index: briefList(q.cn, ['code', 'name', 'changePct', 'price'], 5),
    sectorsUp: briefList(q.sectorsUp, ['name', 'changePct'], 6),
    sectorsDown: briefList(q.sectorsDown, ['name', 'changePct'], 6),
    sectorUpCount: q.sectorUpCount == null ? null : q.sectorUpCount,
    sectorDownCount: q.sectorDownCount == null ? null : q.sectorDownCount,
    sectorTotal: q.sectorTotal == null ? null : q.sectorTotal,
    sectorDate: q.sectorDate || null,
    topLimitUpBoard: pick(q.topLimitUpBoard, ['name', 'count', 'date']),
  };
}
function compactSectorFlow(sf) {
  if (!sf) return null;
  return {
    date: sf.date || null,
    inflowTop: briefList(sf.todayInflowTop5, ['name', 'mainNet'], 5),
    outflowTop: briefList(sf.todayOutflowTop5, ['name', 'mainNet'], 5),
  };
}
function compactLadder(L) {
  if (!L) return null;
  const o = pick(L, ['ok', 'asOf', 'maxBoards', 'limitUpCount', 'hasGap', 'gapAt',
    'board2PlusCount', 'board3PlusCount', 'firstBoardCount', 'brokenCount',
    'brokenRate', 'limitDownCount', 'sealFundTotal', 'spaceBoard', 'promotion']);
  o.tiers = (Array.isArray(L.tiers) ? L.tiers : []).slice(0, 8).map(t => ({
    ...pick(t, ['boards', 'count']),
    stocks: briefList(t && t.stocks, ['code', 'name', 'industry'], 3),
  }));
  return o;
}
function compactPrevPool(P) {
  if (!P) return null;
  const o = pick(P, ['ok', 'asOf', 'count', 'redCount', 'redRate', 'avgChgPct',
    'bigDropCount', 'bigDropRate', 'promotion']);
  o.topGainers = briefList(P.topGainers, ['code', 'name', 'chgPct', 'prevBoards'], 5);
  o.topLosers = briefList(P.topLosers, ['code', 'name', 'chgPct', 'prevBoards'], 5);
  o.industryBigDrop = briefList(P.industryBigDrop, ['industry', 'count'], 5);
  return o;
}
function compactSectors(S) {
  if (!S) return null;
  const o = pick(S, ['ok', 'asOf', 'total', 'singleDance']);
  o.top = briefList(S.top, ['industry', 'count', 'boardsMax', 'sealFundYi', 'amountYi', 'hasLayer'], 8);
  const st = S.sealTime || {};
  o.sealTime = { ...pick(st, ['ok', 'total', 'early', 'mid', 'late', 'unknown']),
    byIndustry: briefList(st.byIndustry, ['industry', 'count', 'early', 'mid', 'late'], 5) };
  const mc = S.midCap || {};
  o.midCap = { ...pick(mc, ['ok']), byIndustry: briefList(mc.byIndustry,
    ['industry', 'count', 'topName', 'topFloatMvYi', 'topChgPct', 'avgFloatMvYi'], 5) };
  const ld = S.limitDown || {};
  o.limitDown = { ...pick(ld, ['ok', 'count', 'avgChgPct']),
    topLosers: briefList(ld.topLosers, ['code', 'name', 'chgPct', 'industry'], 3) };
  o.industryHistory = sanitize(Array.isArray(S.industryHistory) ? S.industryHistory.slice(0, 5) : []);
  return o;
}
function compactActivity(A) {
  if (!A) return null;
  const o = pick(A, ['ok', 'asOf', 'ztAmountYi', 'strongCount', 'strongAmountYi']);
  o.topAmount = briefList(A.topAmount, ['code', 'name', 'amountYi', 'chgPct', 'industry'], 5);
  return o;
}
function compactHistoryRecords(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 6).map(r => pick(r, ['date', 'title', 'summary', 'content', 'note']));
}
function trimToBudget(o) {
  const size = () => JSON.stringify(o).length;
  const steps = [
    () => { o.news = (o.news || []).slice(0, 8); },
    () => { o.history.records = (o.history.records || []).slice(0, 3); },
    () => { o.computed.engine.candidates = (o.computed.engine.candidates || []).slice(0, 6);
      o.computed.topics.cards = (o.computed.topics.cards || []).slice(0, 6); },
    () => { o.sectors = pick(o.sectors, ['ok', 'asOf', 'total', 'top']); o.market.quote = null; },
    () => { o.history.records = []; o.news = (o.news || []).slice(0, 5); o.ladder = pick(o.ladder, ['ok', 'asOf', 'maxBoards', 'limitUpCount']); },
    () => { o.computed.engine.candidates = []; o.computed.topics.cards = []; o.sectors = null; o.activity = null; },
  ];
  let i = 0;
  while (size() > MAX_CONTEXT_CHARS && i < steps.length) { steps[i++](); }
  o.meta.contextChars = size();
  o.meta.contextTrimmed = i > 0;
  return o;
}

/**
 * 组装干净 JSON Context。
 * @param {object} a {date, sources, engine, topics, meta, stage, dragonTigerStatus,
 *                    completeness, baselines, verdictRows, historyRecords}
 * @returns {object} 可直接 JSON.stringify 后注入 LLM 用户消息
 */
function build(a) {
  const sources = a.sources || [];
  const engine = a.engine || {};
  const topics = a.topics || {};
  const meta = a.meta || {};

  const quote = srcData(sources, 'quote');
  const bb = srcData(sources, 'breadth');
  const breadth = bb && bb.breadth ? bb.breadth : null;
  const mf = srcData(sources, 'mainFund');
  const sf = srcData(sources, 'sectorFlow');
  const hs = srcData(sources, 'historySeries');
  const H = srcData(sources, 'dragonTiger');
  const news = srcData(sources, 'news');
  const calData = srcData(sources, 'calendar');
  const hist = srcData(sources, 'history');

  // 龙虎榜：available 只由「数据块 ok + count 有值」决定，未发布不算数据故障。
  const lhbAvailable = !!(srcOk(sources, 'dragonTiger') && H && H.ok !== false && H.count != null);
  const lhbSrc = byKey(sources, 'dragonTiger');
  const dragonTiger = lhbBlock(H || {}, a.date, lhbSrc && lhbSrc.source, lhbAvailable);

  // 五要素清单：source / asOf / fetchedAt 是工作台数据一致性铁律，必须随 Context 交给 LLM。
  const sourceRows = sources.map(s => ({
    key: s.key, label: s.label, category: s.category,
    status: s.status, source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt,
    note: s.note || null,
  }));
  const missing = sources.filter(s => s.status !== 'ok').map(s => ({
    key: s.key, label: s.label, reason: s.note || null,
  }));

  const ctx = {
    schema: CONTEXT_VERSION,
    meta: {
      reviewDate: a.date,
      tradingDay: calData ? {
        is_trading_day: calData.is_trading_day == null ? null : calData.is_trading_day,
        day_type: calData.day_type || null,
      } : null,
      tz: 'Asia/Shanghai',
      stage: a.stage || 'formal',
      dragonTigerStatus: a.dragonTigerStatus || null,
      prevDate: meta.prevDate || null,
      histDates: Array.isArray(meta.histDates) ? meta.histDates : [],
      completeness: a.completeness && a.completeness.score != null ? a.completeness.score : null,
    },
    // 原始数据（无文案）：显式白名单裁剪，避免把全量明细塞进大模型请求
    market: {
      breadth: pick(breadth, ['date', 'up', 'down', 'flat', 'limitUp', 'limitDown',
        'activePct', 'zbgcCount', 'zbgcBreaks', 'zbgcRate']),
      quote: compactQuote(quote),
      mainFund: mf && mf.mainFund ? pick(mf.mainFund, ['mainNetToday', 'date', 'source']) : null,
      sectorFlow: compactSectorFlow(sf),
    },
    ladder: compactLadder(srcData(sources, 'ladder')),
    prevPool: compactPrevPool(srcData(sources, 'prevPool')),
    sectors: compactSectors(srcData(sources, 'sectors')),
    activity: compactActivity(srcData(sources, 'activity')),
    historySeries: hs && Array.isArray(hs.series) ? sanitize(hs.series.slice(0, 6)) : [],
    dragonTiger,
    news: news && Array.isArray(news.items)
      ? news.items.slice(0, 12).map(n => ({
        title: n.title == null ? null : String(n.title).slice(0, 160),
        source: n.source || null, date: n.date || null,
        category: n.category || null,
      })) : [],
    history: {
      records: compactHistoryRecords(hist && hist.records),
      baselines: Array.isArray(a.baselines) ? sanitize(a.baselines) : [],
      verdicts: Array.isArray(a.verdictRows) ? sanitize(a.verdictRows.slice(0, 12)) : [],
    },
    // 确定性引擎结果：只带数值与枚举，不带任何引擎生成的句子
    computed: {
      engine: {
        schemaVersion: engine.schemaVersion || null,
        marketRiskLevel: engine.marketRiskLevel == null ? null : engine.marketRiskLevel,
        trends: Object.fromEntries(Object.entries(engine.trends || {}).map(([k, t]) => [
          k, { direction: t && t.direction != null ? t.direction : null, ok: !!(t && t.ok) },
        ])),
        candidates: briefList(engine.candidates, CANDIDATE_KEYS, 12),
      },
      topics: {
        schemaVersion: topics.schemaVersion || null,
        gradeSummary: sanitize(topics.gradeSummary),
        dominantVote: topics.dominantVote == null ? null : topics.dominantVote,
        dominantQuadrant: topics.dominantQuadrant == null ? null : topics.dominantQuadrant,
        cards: briefList(topics.cards, TOPIC_CARD_KEYS, 12),
      },
    },
    sources: sourceRows,
    missing,
  };
  return trimToBudget(ctx);
}

/**
 * LLM 不可用时的降级数据快照。
 * 注意：这不是「报告模板」，只是把 JSON 原样摆出来 + 一句说明；
 * 不拼段落、不写结论，也不因为缺数据拒绝发布。
 */
function toDataSnapshotMarkdown(context, reason) {
  const d = (context && context.meta && context.meta.reviewDate) || '';
  return [
    '# 每日复盘 · ' + d + '（数据快照）',
    '',
    '> AI 生成暂不可用' + (reason ? '（' + String(reason).slice(0, 160) + '）' : '') +
    '。以下是工作台代码采集到的原始数据，未做任何文字推演；AI 通道恢复后点右上角「手动重跑」即可生成完整复盘。',
    '',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    '',
    '_本文为盘后观察记录，不是投资建议。_',
  ].join('\n');
}

module.exports = {
  SCHEMA_VERSION, CONTEXT_VERSION,
  build, lhbBlock, toDataSnapshotMarkdown, sanitize, srcData, srcOk,
};

~~~

---

## `lib\reviewEngines.js`  ·  831 行

~~~js
/**
 * lib/reviewEngines.js — 每日复盘「机会识别引擎 / 风险识别引擎」（20261108a → 20261108d）
 * ==========================================================================
 * 用户新框架落地要点：
 *  - 四段式：事实 → 判断（机会/风险分类+等级）→ 次日验证条件 → 判断不成立信号。
 *  - 机会：O1-O5 分类、L1-L5 五层漏斗、C1-C8 确认清单、V1-V8 否决清单、A/B/C/D 评级。
 *  - 驱动标签：D1 技术 / D2 消息 / D3 资金 / D4 基本面（D4 无本机源，恒不标注）。
 *  - 中和过滤：接入 lib/topicEngines.js 的「技术面 × 消息面」四象限结论
 *    （共振不处理 / 背离降级 C / 先觉降一级 / 双弱剔除 D / 无法判断不额外升降级）。
 *  - 风险：R-M1~R-M4（市场级）/ R-S1~R-S5（板块级）/ R-I1~R-I5（个股级）。
 *  - 持续性判断必须取前 3-5 个交易日对照；对照不足写「缺少对照，暂不作持续性判断」。
 *
 * 【架构铁律】工作台「代码权威」：分类、漏斗、确认、否决、评级、风险等级全部是确定性规则，
 *   由本文件纯函数从真实采集值计算；LLM 不参与任何推导，只做（可选的）叙述复述。
 *   本文件零 require、零 I/O、零网络，可独立单测。
 *
 * 【诚实边界】数据缺失一律返回 null（未知），绝不返回 false（未通过）或臆造数值。
 *   未知项不计入确认清单命中数，也不命中否决项，但会在 evidence/reason 中标注「缺失」。
 *   这会让多数候选落在 C 级「仅观察」——这是数据不足时的正确结论，不是缺陷。
 *
 * 【口径声明】（复盘「数据完整性与口径」段须披露）
 *  - 大面股 = 昨日涨停股今日涨跌幅 <= -5%（工作台自定义代理口径，非交易所定义）。
 *  - 流动性不足阈值 = 个股成交额 < 1.0 亿元（工作台自定义阈值）。
 *  - 中军/趋势股、个股多日成交额序列、公告催化时间窗、题材新旧：
 *    工作台暂无可靠本机源 → 相关项恒为「缺失」，不由涨停池数据反推。
 *  - 成交额样本仅覆盖涨停池 + 强势股池，不代表两市成交额排名。
 *  - 新闻标题只作催化线索（附来源时间），不构成公告核验，不单独决定分类。
 */
'use strict';

const MISSING = '缺失';
const NO_COMPARISON = '缺少对照，暂不作持续性判断';

// 阈值集中定义，便于复盘附录统一披露
const TH = {
  bigDropPct: -5,          // 大面股代理阈值
  redRateWeak: 40,         // 昨日涨停今日红盘率低于此值视为接力弱（%）
  limitUpDropPct: -20,     // 涨停家数较前一日降幅超过此值视为收缩（%）
  liquidityMinYi: 1.0,     // 流动性不足阈值（亿元）
  highBoard: 5,            // 连续加速代理：连板数 >= 5
  trendMinPoints: 3,       // 持续性判断最少有效对照点
  bigDropRateHigh: 30,     // 当日大面股占比过高（%）
  promotionWeak: 20,       // 1进2 晋级率低于此值视为接力弱（%）
};

const OPPORTUNITY_CATEGORIES = {
  O1: '宏观/政策驱动',
  O2: '行业景气驱动',
  O3: '事件驱动',
  O4: '资金/情绪驱动',
  O5: '估值/错杀修复',
  MIX: '混合型',
};

// 新闻标题关键词线索（仅用于催化线索，不参与评级硬证据）
const CATALYST_KEYWORDS = {
  O1: ['政策', '国务院', '央行', '发改委', '财政部', '降准', '降息', '补贴', '规划', '会议', '部署'],
  O2: ['涨价', '提价', '订单', '库存', '渗透率', '产能', '景气', '需求', '销量', '价格'],
  O3: ['重组', '回购', '业绩预告', '中标', '新品', '发布', '签约', '收购', '增持', '获批'],
  O5: ['错杀', '低估', '估值', '周期底部', '预期差', '修复'],
};

const CONFIRM_DEFS = [
  { code: 'C1', label: '有明确催化剂或数据支撑' },
  { code: 'C2', label: '板块内部有层次（领涨+跟随+中军）' },
  { code: 'C3', label: '资金活跃≥2个交易日' },
  { code: 'C4', label: '梯队/板块未出现明显断层' },
  { code: 'C5', label: '回撤有承接或未出现高位负反馈' },
  { code: 'C6', label: '位置/拥挤度未极端' },
  { code: 'C7', label: '量价结构健康（放量突破/缩量踩支撑，非高位放量滞涨）' },
  { code: 'C8', label: '消息仍在催化/发酵期（非兑现退潮）' },
];

const VETO_DEFS = [
  { code: 'V1', label: '仅一只个股涨停、板块无跟随' },
  { code: 'V2', label: '成交额仅单日放大、次日无量' },
  { code: 'V3', label: '高位股断板后大幅走弱且扩散' },
  { code: 'V4', label: '大面股数量较前几日明显增多' },
  { code: 'V5', label: '催化剂已充分兑现、股价已连续加速' },
  { code: 'V6', label: '流动性不足' },
  { code: 'V7', label: '高位顶背离+放量滞涨+板块不跟' },
  { code: 'V8', label: '消息兑现+龙头独舞' },
];

const DRIVER_DEFS = { D1: '技术', D2: '消息', D3: '资金', D4: '基本面' };

const RISK_DEFS = {
  market: [
    { code: 'R-M1', label: '整体情绪转弱' },
    { code: 'R-M2', label: '亏钱效应扩散' },
    { code: 'R-M3', label: '赚钱效应收缩' },
    { code: 'R-M4', label: '量能萎缩或仅小票热闹' },
  ],
  sector: [
    { code: 'R-S1', label: '单票独舞，无跟随' },
    { code: 'R-S2', label: '梯队断层' },
    { code: 'R-S3', label: '高位股断板后负反馈扩散' },
    { code: 'R-S4', label: '老题材无新推动因素、资金撤离' },
    { code: 'R-S5', label: '板块内部分化，中军/趋势股走弱' },
  ],
  individual: [
    { code: 'R-I1', label: '高位爆量滞涨或冲高回落' },
    { code: 'R-I2', label: '断板后大幅走弱且无修复' },
    { code: 'R-I3', label: '催化剂已兑现、股价已加速' },
    { code: 'R-I4', label: '流动性不足' },
    { code: 'R-I5', label: '突发个股问题（公告/监管/业绩）' },
  ],
};

// ---------- 基础工具（全部纯函数） ----------
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function pct(v, digits) {
  const n = num(v);
  return n == null ? MISSING : (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits) + '%';
}
function fixed(v, digits) { const n = num(v); return n == null ? MISSING : n.toFixed(digits == null ? 2 : digits); }
function yi(v) { // 元 → 亿元
  const n = num(v);
  return n == null ? null : Math.round(n / 1e8 * 100) / 100;
}
function tri(v, yes, no) { return v === true ? yes : v === false ? no : MISSING; }

/**
 * 序列趋势：扩散 / 收缩 / 持平 / 无法判断。
 * 有效点不足 TH.trendMinPoints 时一律返回「无法判断」+ NO_COMPARISON 说明，
 * 禁止把单日数据当趋势（用户硬性规则）。
 */
function trendOf(series, key, opts) {
  const o = opts || {};
  const minPoints = o.minPoints || TH.trendMinPoints;
  const arr = Array.isArray(series) ? series : [];
  const vals = arr.map(r => (r && num(r[key]) != null ? num(r[key]) : null)).filter(v => v != null);
  if (vals.length < minPoints) {
    return { direction: '无法判断', points: vals.length, values: vals, note: NO_COMPARISON, ok: false };
  }
  const half = Math.floor(vals.length / 2);
  const early = vals.slice(0, half);
  const late = vals.slice(-half);
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const a = avg(early), b = avg(late);
  const chg = a !== 0 ? (b - a) / Math.abs(a) * 100 : null;
  const threshold = o.threshold == null ? 10 : o.threshold;
  const direction = chg == null ? '无法判断'
    : chg > threshold ? '扩散'
      : chg < -threshold ? '收缩' : '持平';
  return {
    direction, points: vals.length, values: vals,
    changePct: chg == null ? null : Math.round(chg * 100) / 100,
    note: `前 ${vals.length} 个有效对照点，前后半段均值 ${fixed(a)} → ${fixed(b)}（${pct(chg)}），阈值 ±${threshold}%`,
    ok: true,
  };
}

/** 四段式结论构造（唯一出口，保证每条核心判断都有验证条件与不成立信号） */
function quad(subject, fact, judgment, verify, invalidate, extra) {
  return Object.assign({
    subject: String(subject || ''),
    fact: String(fact || MISSING),
    judgment: String(judgment || MISSING),
    verify: String(verify || MISSING),
    invalidate: String(invalidate || MISSING),
  }, extra || {});
}

function riskItem(def, level, fact, observe, clear, evidence) {
  return {
    code: def.code, title: def.label,
    level: level || '无法判断',
    fact: String(fact || MISSING),
    observe: String(observe || MISSING),
    clear: String(clear || MISSING),
    evidence: evidence || [],
  };
}

// ---------- 输入归一化 ----------
function normInput(input) {
  const i = input || {};
  const hist = Array.isArray(i.historySeries) ? i.historySeries.filter(Boolean) : [];
  return {
    date: i.date || MISSING,
    histDates: Array.isArray(i.histDates) ? i.histDates : [],
    breadth: i.breadth || null,
    ladder: i.ladder || null,
    prevPool: (i.prevPool && i.prevPool.ok) ? i.prevPool : null,
    sectors: (i.sectors && i.sectors.ok) ? i.sectors : null,
    activity: (i.activity && i.activity.ok) ? i.activity : null,
    historySeries: hist,
    news: Array.isArray(i.news) ? i.news : [],
    lhb: i.lhb || null,
    sectorFlow: i.sectorFlow || null,
    mainFund: i.mainFund || null,
    quote: i.quote || null,
    // 20261108d：热点归因 / 四象限中和结论（lib/topicEngines.js 的 analyzeTopics 输出）
    topics: i.topics || null,
  };
}

// ---------- 新闻催化线索（只作线索，不单独决定分类） ----------
function catalystClues(subject, news) {
  const hits = [];
  const text = String(subject || '');
  for (const n of news || []) {
    const title = String((n && n.title) || '');
    if (!title || !text || !title.includes(text)) continue;
    for (const [code, words] of Object.entries(CATALYST_KEYWORDS)) {
      if (words.some(w => title.includes(w))) {
        hits.push({ code, title, source: String((n && n.source) || MISSING), date: String((n && n.date) || MISSING) });
      }
    }
  }
  return hits.slice(0, 3);
}

/**
 * O1-O5 分类。工作台客观证据只有 O4（连板梯队/板块联动/成交额集中）能稳定取得；
 * 其它类别必须命中带来源时间的新闻关键词线索，否则不硬猜。
 */
function classifyOpportunity(cand, ctx) {
  const clues = catalystClues(cand.matchText || cand.name, ctx.news);
  const nonO4 = clues.filter(c => c.code !== 'O4');
  const hasO4Evidence = cand.boards != null || cand.layer === true || cand.amountYi != null;
  if (!hasO4Evidence && !nonO4.length) {
    return {
      code: 'MIX', label: OPPORTUNITY_CATEGORIES.MIX, leading: '数据不足',
      reason: '既无连板/板块/成交额客观证据，也无催化线索；未做实质分类', clues,
    };
  }
  if (nonO4.length && hasO4Evidence) {
    const lead = nonO4[0];
    return {
      code: 'MIX', label: OPPORTUNITY_CATEGORIES.MIX, leading: lead.code,
      reason: `同时命中 ${lead.code} 催化线索与 O4 客观行情证据；主导类型 ${lead.code}（${OPPORTUNITY_CATEGORIES[lead.code]}）`,
      clues,
    };
  }
  if (nonO4.length) {
    const lead = nonO4[0];
    return {
      code: lead.code, label: OPPORTUNITY_CATEGORIES[lead.code], leading: lead.code,
      reason: `命中 ${lead.code} 新闻催化线索（附来源时间，非公告核验）`, clues,
    };
  }
  return {
    code: 'O4', label: OPPORTUNITY_CATEGORIES.O4, leading: 'O4',
    reason: '仅取得连板梯队/板块联动/成交额客观证据；政策、景气、事件、估值类催化数据缺失',
    clues,
  };
}

// ---------- 五层漏斗 ----------
function funnelOf(cand, ctx) {
  const L = {};
  const b = ctx.breadth;
  const lu = b ? num(b.limitUp) : null;
  const ld = b ? num(b.limitDown) : null;
  const up = b ? num(b.up) : null;
  const down = b ? num(b.down) : null;
  if (lu == null || ld == null || up == null || down == null) {
    L.L1 = { passed: null, reason: `今日成交额/涨跌家数/涨停跌停数据${MISSING}` };
  } else {
    const ok = lu > ld && up > down;
    L.L1 = { passed: ok, reason: `涨停 ${lu} / 跌停 ${ld}，涨 ${up} / 跌 ${down}（口径：涨停多于跌停且上涨家数多于下跌家数）` };
  }

  if (cand.layer == null) L.L2 = { passed: null, reason: `板块层次数据${MISSING}（中军/趋势股无可靠本机源）` };
  else L.L2 = { passed: cand.layer === true, reason: cand.layer ? '所属板块存在领涨+跟随的客观层次' : '所属板块仅单只涨停，判「单票独舞」' };

  if (cand.boards == null) L.L3 = { passed: null, reason: `个股定位与连板高度数据${MISSING}` };
  else L.L3 = {
    passed: cand.boards >= 2,
    reason: cand.boards >= 2
      ? `连板高度 ${cand.boards} 板，属领涨/高位样本`
      : '首板且位于跟随位，属跟风样本；基本面支撑数据' + MISSING,
  };

  if (cand.catalyst == null) L.L4 = { passed: null, reason: `明确催化剂或数据支撑${MISSING}` };
  else L.L4 = { passed: true, reason: cand.catalyst };

  // L5：个股多日成交额序列工作台暂无；只能用全市场涨停池成交额作市场级代理，并明确标注。
  const t = trendOf(ctx.historySeries, 'ztAmountYi');
  if (!t.ok) L.L5 = { passed: null, reason: `资金活跃持续性${MISSING}：个股多日成交额序列无本机源；${NO_COMPARISON}` };
  else L.L5 = {
    passed: t.direction !== '收缩',
    reason: `市场级代理口径：涨停池成交额 ${t.note}（非个股多日成交额；单日热闹与连续活跃不可由此完全区分）`,
  };

  const known = Object.values(L).filter(x => x.passed != null);
  return {
    layers: L,
    passedAll: known.length === 5 && known.every(x => x.passed === true),
    explicitFail: Object.values(L).some(x => x.passed === false),
    unknownCount: Object.values(L).filter(x => x.passed == null).length,
  };
}

// ---------- 热点归因 / 四象限 / 驱动标签（20261108d） ----------
function topicOf(cand, ctx) {
  const by = ctx.topics && ctx.topics.topicByIndustry;
  if (!by || !cand || !cand.industry || cand.industry === MISSING) return null;
  return by[cand.industry] || null;
}
function driversOf(cand, tp) {
  const tags = [];
  if (cand.boards != null || cand.layer != null) tags.push('D1');
  if (tp && tp.newsLevel && tp.newsLevel !== MISSING) tags.push('D2');
  if (cand.amountYi != null || (tp && String(tp.drivers || '').includes('D3'))) tags.push('D3');
  // D4 基本面：复盘链路未接入财报/估值数据，恒不标注（口径见 caliberNotes）。
  return tags.length ? tags.join('/') : MISSING;
}

// ---------- 确认清单 C1-C8 ----------
function confirmOf(cand, ctx) {
  const C = {};
  C.C1 = cand.catalyst == null
    ? { hit: null, reason: `催化剂与数据支撑均${MISSING}` }
    : { hit: true, reason: cand.catalyst };
  C.C2 = cand.layer == null
    ? { hit: null, reason: `板块内部层次${MISSING}（中军/趋势股无可靠本机源）` }
    : { hit: cand.layer, reason: cand.layer ? '领涨+跟随客观成立' : '板块仅单只涨停，无跟随' };
  // C3：个股多日成交额序列无本机源；全市场代理不能冒充个股级证据。
  C.C3 = { hit: null, reason: `个股资金活跃≥2交易日${MISSING}（工作台无个股多日成交额序列，不以全市场代理冒充）` };
  const gap = ctx.ladder ? ctx.ladder.hasGap : null;
  C.C4 = gap == null
    ? { hit: null, reason: `梯队断层数据${MISSING}` }
    : { hit: gap === false, reason: gap ? `梯队存在断层（缺 ${(ctx.ladder.gapAt || []).join('、')} 板档）` : '梯队未出现明显断层' };
  const pp = ctx.prevPool;
  if (!pp || num(pp.bigDropRate) == null) {
    C.C5 = { hit: null, reason: `高位负反馈数据${MISSING}` };
  } else {
    const bad = num(pp.bigDropRate) <= TH.bigDropRateHigh;
    C.C5 = {
      hit: bad,
      reason: `昨日涨停股今日大幅回落占比 ${fixed(pp.bigDropRate)}%（阈值 ${TH.bigDropRateHigh}%，工作台自定义大面股代理口径）`,
    };
  }
  if (cand.boards == null) C.C6 = { hit: null, reason: `连板高度${MISSING}` };
  else C.C6 = {
    hit: cand.boards < TH.highBoard,
    reason: `连板 ${cand.boards} 板；以 ≥${TH.highBoard} 板作「连续加速」代理，「全员讨论」热度数据${MISSING}`,
  };
  // C7：量价结构需要个股多日量价序列，工作台无可靠本机源 → 恒「缺失」，
  // 不以封板时间、单日成交额等其它口径冒充（诚实边界）。
  C.C7 = { hit: null, reason: `个股多日量价序列${MISSING}，无法判定「放量突破 / 缩量踩支撑 / 高位放量滞涨」` };
  // C8：由热点归因引擎的多日行业涨停家数序列确定性给出，是本轮唯一新增的真实可证确认项。
  const tp = topicOf(cand, ctx);
  if (!tp || !tp.stage) {
    C.C8 = { hit: null, reason: `题材阶段（催化/发酵 vs 兑现/退潮）数据${MISSING}` };
  } else if (tp.stage === '启动期' || tp.stage === '发酵/主升期') {
    C.C8 = { hit: true, reason: `题材处于 ${tp.stage}（${tp.stageReason}）` };
  } else if (tp.stage === '高潮/退潮期') {
    C.C8 = { hit: false, reason: `题材处于 ${tp.stage}，催化已兑现（${tp.stageReason}）` };
  } else {
    C.C8 = { hit: null, reason: `题材阶段：${tp.stage}；${tp.stageReason}` };
  }
  const count = Object.values(C).filter(x => x.hit === true).length;
  return { items: C, count, unknown: Object.values(C).filter(x => x.hit == null).length };
}

// ---------- 否决清单 V1-V8 ----------
// 否决项分级（口径披露见 caliberNotes）：
//  - 个股级硬否决 V1/V2/V6：标的一本身不合格 → D 剔除，不进汇总表。
//  - 市场级/位置级/消息级软否决 V3/V4/V5/V7/V8：按规格「不得进入可跟踪」降级为 C「仅观察」，
//    不整批剔除；否则一次高位负反馈或消息退潮就会让汇总表与观察池全空，等于输出空白模板。
//    这是对规格「降级或剔除」二选一的显式取舍，不是放宽标准：软否决命中后永远不能评 A/B。
const HARD_VETO = new Set(['V1', 'V2', 'V6']);
const SOFT_VETO = new Set(['V3', 'V4', 'V5', 'V7', 'V8']);

function vetoOf(cand, ctx) {
  const hits = [];
  const unknown = [];
  const sec = ctx.sectors;
  const singles = sec && Array.isArray(sec.singleDance) ? sec.singleDance : null;
  if (!singles) unknown.push('V1：板块跟随数据' + MISSING);
  else if (cand.industry && singles.includes(cand.industry)) {
    hits.push({ code: 'V1', reason: `${cand.industry} 板块仅 1 只涨停，无跟随` });
  }
  unknown.push('V2：个股多日成交额序列' + MISSING + '，无法判断「单日放大、次日无量」');

  const pp = ctx.prevPool;
  const highBreak = pp && Array.isArray(pp.topLosers)
    ? pp.topLosers.filter(x => num(x.prevBoards) >= 3 && num(x.chgPct) <= TH.bigDropPct)
    : [];
  if (pp && highBreak.length >= 2) {
    hits.push({ code: 'V3', reason: `昨日 3 板以上高位股今日大幅回落 ${highBreak.length} 只（${highBreak.slice(0, 3).map(x => x.name).join('、')}），负反馈已扩散` });
  } else if (!pp) unknown.push('V3：昨日涨停股今日表现' + MISSING);

  unknown.push('V4：前几日大面股序列' + MISSING + '，无法判断「较前几日明显增多」；仅能观察当日大面股占比');
  if (cand.boards != null && cand.boards >= TH.highBoard) {
    hits.push({ code: 'V5', reason: `连板 ${cand.boards} 板达到连续加速代理阈值；催化剂兑现时间窗数据${MISSING}，按位置极值处理` });
  }
  if (cand.amountYi == null) unknown.push('V6：个股成交额' + MISSING);
  else if (cand.amountYi < TH.liquidityMinYi) {
    hits.push({ code: 'V6', reason: `成交额 ${fixed(cand.amountYi)} 亿元 < ${TH.liquidityMinYi} 亿元（工作台自定义流动性阈值）` });
  }
  // V7 三项需同时成立（高位顶背离 + 放量滞涨 + 板块不跟）；前两项依赖个股多日量价 → 恒未知。
  unknown.push('V7：个股多日量价序列' + MISSING + '，无法判定顶背离/放量滞涨；板块不跟单独不构成 V7');
  // V8：题材阶段（来自多日行业涨停家数序列）+ 龙头独舞（单票独舞名单 / 涨停仅 1 家）。
  const tp = topicOf(cand, ctx);
  const singleHit = !!(singles && cand.industry && singles.includes(cand.industry));
  if (!tp || !tp.stage) unknown.push('V8：题材阶段 / 消息兑现数据' + MISSING);
  else if (tp.stage === '高潮/退潮期' && (singleHit || num(tp.limitUpCount) === 1)) {
    hits.push({
      code: 'V8',
      reason: `题材处于 ${tp.stage} 且龙头独舞（涨停 ${tp.limitUpCount == null ? MISSING : tp.limitUpCount} 家${singleHit ? ' / 单票独舞名单命中' : ''}），消息兑现后无跟随`,
    });
  }
  const hard = hits.filter(h => HARD_VETO.has(h.code));
  const soft = hits.filter(h => SOFT_VETO.has(h.code));
  return {
    hits, hardHits: hard, softHits: soft, unknown,
    hasVeto: hits.length > 0, hasHardVeto: hard.length > 0,
  };
}

// ---------- 机会评级 ----------
function gradeOf(cand, ctx) {
  const cls = classifyOpportunity(cand, ctx);
  const funnel = funnelOf(cand, ctx);
  const confirm = confirmOf(cand, ctx);
  const veto = vetoOf(cand, ctx);
  const marketHigh = ctx.marketRiskLevel === '高';
  let grade, reason;
  if (veto.hasHardVeto) {
    grade = 'D';
    reason = `命中个股级硬否决 ${veto.hardHits.map(v => v.code).join('、')}，剔除出观察池`;
  } else if (veto.softHits.length) {
    grade = 'C';
    reason = `命中市场级/位置级否决 ${veto.softHits.map(v => v.code).join('、')}，按「不得进入可跟踪」降级为 C 仅观察（不剔除，避免空白模板）`;
  } else if (funnel.explicitFail) {
    grade = 'C';
    const failed = Object.entries(funnel.layers)
      .filter(([, v]) => v.passed === false).map(([k]) => k).join('、');
    reason = `五层漏斗 ${failed} 层明确未通过，降级为仅观察（确认 ${confirm.count} 项）`;
  } else if (funnel.passedAll && confirm.count >= 5) {
    grade = marketHigh ? 'B' : 'A';
    reason = marketHigh ? '五层全过且确认≥5项，但市场级风险偏高，按规则降一级' : '五层全过 + 确认≥5项 + 无否决项';
  } else if (confirm.count >= 4) {
    grade = marketHigh ? 'C' : 'B';
    reason = marketHigh ? '确认≥4项，但市场级风险偏高，按规则降一级' : '确认清单≥4项 + 无否决项';
  } else {
    grade = 'C';
    reason = `确认清单仅 ${confirm.count} 项（<4），仅观察；其中 ${confirm.unknown} 项因数据缺失未计入`;
  }

  // 20261108d 中和过滤：接入热点归因引擎的「技术面 × 消息面」四象限。
  // 「无法判断」不额外升降级 —— 工作台新闻流是实时快讯，不能证明某题材「当日无消息」，
  // 因此不把证据缺失误判成「双弱」而整批剔除（避免空白模板）。
  const tp = topicOf(cand, ctx);
  const quadrant = tp ? tp.quadrant : '无法判断';
  if (tp && grade !== 'D') {
    if (quadrant === '双弱') {
      grade = 'D';
      reason += '；四象限判定「双弱」（无催化无量价），按规格剔除出可跟踪候选';
    } else if (quadrant === '背离' && (grade === 'A' || grade === 'B')) {
      grade = 'C';
      reason += '；四象限判定「消息强 + 技术弱」背离，降级为仅观察（防诱多）';
    } else if (quadrant === '先觉' && (grade === 'A' || grade === 'B')) {
      const before = grade;
      grade = before === 'A' ? 'B' : 'C';
      reason += `；四象限判定「消息弱 + 技术强」先觉，按规格降一级（${before} → ${grade}，防无源之水）`;
    }
  }
  return {
    ...cand,
    category: cls.code === 'MIX' ? `混合型（主导 ${cls.leading}）` : `${cls.code} ${cls.label}`,
    categoryCode: cls.code,
    classificationReason: cls.reason,
    clues: cls.clues,
    grade, gradeReason: reason,
    funnel, confirm, veto,
    quadrant, quadrantAction: tp ? tp.quadrantAction : '消息面证据缺失，不因象限额外升降级',
    drivers: driversOf(cand, tp),
    topicStage: tp ? tp.stage : MISSING,
    trackable: grade === 'A' || grade === 'B',
  };
}

// ---------- 候选生成（全部来自真实采集值，不臆造标的） ----------
function buildCandidates(ctx) {
  // 个股与板块分别限额：早期版本共用一个 24 上限，真实交易日个股候选多时
  // 会把板块级候选全部挤出，导致「板块结构与机会分类」段没有可分类对象。
  const stocks = [];
  const sectors = [];
  const out = stocks;
  const L = ctx.ladder;
  const sec = ctx.sectors;
  const act = ctx.activity;
  const pp = ctx.prevPool;

  const amountByCode = {};
  for (const x of (act && Array.isArray(act.topAmount) ? act.topAmount : [])) {
    if (x && x.code) amountByCode[String(x.code)] = num(x.amountYi); // 契约：amountYi 单位亿元
  }
  const layerByIndustry = {};
  for (const s of (sec && Array.isArray(sec.top) ? sec.top : [])) {
    if (s && s.industry) layerByIndustry[String(s.industry)] = s;
  }

  if (L && Array.isArray(L.tiers)) {
    for (const t of L.tiers) {
      for (const s of (t.stocks || []).slice(0, 8)) {
        if (!s || !s.code) continue;
        const ind = String(s.industry || '');
        const secInfo = layerByIndustry[ind];
        out.push({
          name: s.name, code: s.code, scope: 'stock', industry: ind || MISSING,
          matchText: s.name, boards: num(t.boards),
          layer: secInfo ? secInfo.hasLayer : null,
          amountYi: amountByCode[String(s.code)] != null ? amountByCode[String(s.code)] : null,
          catalyst: num(t.boards) >= 2 ? `连板 ${t.boards} 板（涨停池客观数据支撑，非公告催化）` : null,
          sourceTag: '连板梯队',
        });
      }
    }
  }
  // 断板修复股：昨日连板、今日仍上涨（客观修复信号，不做方向结论）
  if (pp && Array.isArray(pp.topGainers)) {
    for (const g of pp.topGainers.slice(0, 4)) {
      if (!g || !g.code || out.some(o => o.code === String(g.code))) continue;
      out.push({
        name: g.name, code: String(g.code), scope: 'stock', industry: MISSING,
        matchText: g.name, boards: num(g.prevBoards), layer: null,
        amountYi: null,
        catalyst: `昨日连板 ${g.prevBoards} 板、今日涨跌幅 ${pct(g.chgPct)}（断板修复客观数据支撑）`,
        sourceTag: '断板修复',
      });
    }
  }
  // 成交额活跃样本（低位放量代理；来自涨停池/强势股池局部样本）
  if (act && Array.isArray(act.topAmount)) {
    for (const a of act.topAmount.slice(0, 4)) {
      if (!a || !a.code || out.some(o => o.code === String(a.code))) continue;
      out.push({
        name: a.name, code: String(a.code), scope: 'stock', industry: String(a.industry || MISSING),
        matchText: a.name, boards: 1, layer: null,
        amountYi: num(a.amountYi), // 契约：亿元
        catalyst: `活跃度样本成交额 ${fixed(a.amountYi)} 亿元（仅涨停池/强势股池，非全市场排行）`,
        sourceTag: '活跃样本',
      });
    }
  }
  // 板块级候选
  if (sec && Array.isArray(sec.top)) {
    for (const s of sec.top.slice(0, 5)) {
      if (!s || !s.industry) continue;
      sectors.push({
        name: s.industry, code: '—', scope: 'sector', industry: s.industry,
        matchText: s.industry, boards: num(s.boardsMax), layer: s.hasLayer,
        amountYi: num(s.amountYi),
        catalyst: `板块涨停 ${s.count} 家（涨停池按所属行业聚合，客观数据支撑）`,
        sourceTag: '板块层次',
      });
    }
  }
  return stocks.slice(0, 16).concat(sectors.slice(0, 6));
}

// ---------- 风险识别引擎 ----------
function assessRisks(ctx) {
  const market = [], sector = [], individual = [];
  const D = RISK_DEFS;
  const b = ctx.breadth, L = ctx.ladder, pp = ctx.prevPool, sec = ctx.sectors, act = ctx.activity;
  const hist = ctx.historySeries;
  const tLimitUp = trendOf(hist, 'limitUp');
  const tPromo = trendOf(hist, 'promotionRate');
  const tRed = trendOf(hist, 'prevRedRate');
  const tDown = trendOf(hist, 'limitDown');
  const tAmt = trendOf(hist, 'ztAmountYi');

  // R-M1 整体情绪转弱
  {
    const lu = b ? num(b.limitUp) : null, ld = b ? num(b.limitDown) : null;
    const red = pp ? num(pp.redRate) : null;
    const weakParts = [];
    if (lu != null && ld != null && lu <= ld) weakParts.push(`涨停 ${lu} ≤ 跌停 ${ld}`);
    if (red != null && red < TH.redRateWeak) weakParts.push(`昨日涨停今日红盘率 ${fixed(red)}% < ${TH.redRateWeak}%`);
    if (tLimitUp.direction === '收缩') weakParts.push(`涨停家数序列${tLimitUp.note}`);
    const level = weakParts.length >= 2 ? '高' : weakParts.length === 1 ? '中' : (lu == null && red == null ? '无法判断' : '低');
    market.push(riskItem(D.market[0], level,
      weakParts.length ? weakParts.join('；') : `涨停 ${lu == null ? MISSING : lu} / 跌停 ${ld == null ? MISSING : ld}，昨日涨停红盘率 ${red == null ? MISSING : fixed(red) + '%'}；${tLimitUp.note}`,
      '次日核对涨停家数是否继续下降、跌停家数是否上升、昨日涨停股红盘率是否低于今日基准',
      '涨停家数回升且跌停家数回落、昨日涨停股红盘率回到 ' + TH.redRateWeak + '% 以上',
      [{ name: '涨停家数趋势', value: tLimitUp.direction }]));
  }
  // R-M2 亏钱效应扩散
  {
    const big = pp ? num(pp.bigDropCount) : null;
    const bigRate = pp ? num(pp.bigDropRate) : null;
    const indSpread = pp && Array.isArray(pp.industryBigDrop) ? pp.industryBigDrop : [];
    const dt = b ? num(b.limitDown) : null;
    const level = bigRate != null && bigRate > TH.bigDropRateHigh ? '高'
      : (big != null && big > 0 ? '中' : (big == null ? '无法判断' : '低'));
    market.push(riskItem(D.market[1], level,
      `大面股（昨日涨停今日涨跌幅≤${TH.bigDropPct}%）${big == null ? MISSING : big + ' 只'}，占比 ${bigRate == null ? MISSING : fixed(bigRate) + '%'}；跌停 ${dt == null ? MISSING : dt} 家；大面股行业分布 ${indSpread.length ? indSpread.slice(0, 3).map(x => `${x.industry} ${x.count} 只`).join('、') : MISSING}；跌停家数序列 ${tDown.direction}（${tDown.note}）`,
      '次日核对大面股数量是否减少、是否仍集中在同一批行业',
      '大面股数量与占比同步回落，且行业分布不再集中',
      [{ name: '跌停家数趋势', value: tDown.direction }]));
  }
  // R-M3 赚钱效应收缩
  {
    const promo = pp && Array.isArray(pp.promotion) ? pp.promotion.find(x => x.from === 1) : null;
    const rate = promo ? num(promo.rate) : null;
    const level = tPromo.direction === '收缩' ? '高'
      : (rate != null && rate < TH.promotionWeak ? '中'
        : (!tPromo.ok && rate == null ? '无法判断' : '低'));
    market.push(riskItem(D.market[2], level,
      `1进2 晋级率 ${rate == null ? MISSING : fixed(rate) + '%'}；连续晋级率序列 ${tPromo.direction}（${tPromo.note}）；昨日涨停红盘率序列 ${tRed.direction}`,
      '次日核对 1进2 晋级率与昨日涨停股红盘率是否继续走低',
      '晋级率与红盘率连续两日回升',
      [{ name: '晋级率趋势', value: tPromo.direction }]));
  }
  // R-M4 量能萎缩或仅小票热闹
  {
    const amt = act ? num(act.ztAmountYi) : null;
    const level = tAmt.direction === '收缩' ? '高'
      : (tAmt.direction === '持平' ? '中' : (!tAmt.ok ? '无法判断' : '低'));
    market.push(riskItem(D.market[3], level,
      `涨停池成交额合计 ${amt == null ? MISSING : fixed(amt) + ' 亿元'}；序列 ${tAmt.note}；全市场成交额靠前个股排行${MISSING}（接口为实时快照、口径日不符，未采用）`,
      '次日核对涨停池成交额是否继续萎缩、活跃是否仍集中在少数样本',
      '涨停池成交额回升且活跃样本扩散',
      [{ name: '涨停池成交额趋势', value: tAmt.direction }]));
  }

  // R-S1 单票独舞
  {
    const singles = sec && Array.isArray(sec.singleDance) ? sec.singleDance : null;
    const level = singles == null ? '无法判断' : singles.length >= 5 ? '高' : singles.length > 0 ? '中' : '低';
    sector.push(riskItem(D.sector[0], level,
      `仅 1 只涨停的行业 ${singles == null ? MISSING : singles.length + ' 个'}${singles && singles.length ? '（' + singles.slice(0, 5).join('、') + '）' : ''}`,
      '次日核对这些行业是否出现第二只跟随涨停',
      '出现跟随个股或该行业退出涨停样本',
      []));
  }
  // R-S2 梯队断层
  {
    const gap = L ? L.hasGap : null;
    const level = gap == null ? '无法判断' : gap ? '中' : '低';
    sector.push(riskItem(D.sector[1], level,
      gap == null ? `梯队断层数据${MISSING}` : gap
        ? `最高 ${L.maxBoards} 板，缺 ${(L.gapAt || []).join('、')} 板档`
        : `最高 ${L.maxBoards == null ? MISSING : L.maxBoards} 板，梯队未出现断层`,
      '次日核对缺口板档是否被补齐、最高板是否继续晋级',
      '梯队各板档补齐且最高板维持',
      []));
  }
  // R-S3 高位股断板负反馈扩散
  {
    const losers = pp && Array.isArray(pp.topLosers) ? pp.topLosers : null;
    const high = losers ? losers.filter(x => num(x.prevBoards) >= 3 && num(x.chgPct) <= TH.bigDropPct) : [];
    const level = !losers ? '无法判断' : high.length >= 2 ? '高' : high.length === 1 ? '中' : '低';
    sector.push(riskItem(D.sector[2], level,
      !losers ? `昨日高位股今日表现${MISSING}`
        : `昨日 3 板以上、今日跌幅≤${TH.bigDropPct}% 的高位股 ${high.length} 只${high.length ? '（' + high.slice(0, 3).map(x => x.name).join('、') + '）' : ''}`,
      '次日核对高位断板股是否继续走弱、是否扩散到同板块其他个股',
      '高位断板股止跌且同板块未出现新的大幅回落',
      []));
  }
  // R-S4 老题材无新推动：题材新旧判定无本机源
  sector.push(riskItem(D.sector[3], '无法判断',
    `题材新旧与「新推动因素」判定所需的历史题材标注/公告时间窗数据${MISSING}；不作持续性判断`,
    '补充题材首现日期与催化公告时间窗后再核对',
    '数据补齐后方可判定',
    []));
  // R-S5 板块内部分化、中军走弱
  {
    const top = sec && Array.isArray(sec.top) ? sec.top : null;
    const weak = top ? top.filter(s => s.hasLayer === false) : [];
    const level = !top ? '无法判断' : weak.length >= 3 ? '中' : '低';
    sector.push(riskItem(D.sector[4], level,
      `板块层次客观代理：${top == null ? MISSING : top.length + ' 个活跃行业中 ' + weak.length + ' 个无层次（仅领涨无跟随）'}；中军/趋势股表现${MISSING}（无可靠本机源）`,
      '次日核对活跃板块内是否出现更多跟随个股',
      '板块内跟随家数增加、层次恢复',
      []));
  }

  // R-I1 高位爆量滞涨：需个股多日量价
  individual.push(riskItem(D.individual[0], '无法判断',
    `个股多日量价序列${MISSING}，无法判定「爆量滞涨/冲高回落」；涨停池仅提供当日炸板次数`,
    '补充个股近 3-5 日量价后再核对',
    '数据补齐后方可判定', []));
  // R-I2 断板后大幅走弱且无修复（个股级，真实可算）
  {
    const losers = pp && Array.isArray(pp.topLosers) ? pp.topLosers : null;
    const bad = losers ? losers.filter(x => num(x.chgPct) <= TH.bigDropPct) : [];
    const level = !losers ? '无法判断' : bad.length >= 3 ? '高' : bad.length > 0 ? '中' : '低';
    individual.push(riskItem(D.individual[1], level,
      !losers ? `昨日涨停股今日表现${MISSING}`
        : `昨日涨停、今日跌幅≤${TH.bigDropPct}% 的个股 ${bad.length} 只${bad.length ? '（' + bad.slice(0, 3).map(x => `${x.name} ${pct(x.chgPct)}`).join('、') + '）' : ''}`,
      '次日核对这批个股是否继续走弱或出现修复',
      '断板个股止跌回升且未再创新低', []));
  }
  // R-I3 催化剂兑现 + 股价加速
  {
    const maxB = L ? num(L.maxBoards) : null;
    const level = maxB == null ? '无法判断' : maxB >= TH.highBoard ? '中' : '低';
    individual.push(riskItem(D.individual[2], level,
      `最高连板 ${maxB == null ? MISSING : maxB + ' 板'}；催化剂公告级别与兑现时间窗${MISSING}（仅以连板高度作「已加速」代理）`,
      '次日核对最高板是否继续加速或首次断板',
      '连板高度回落且未出现断板后大幅走弱', []));
  }
  // R-I4 流动性不足
  {
    const list = act && Array.isArray(act.topAmount) ? act.topAmount : null;
    const thin = list ? list.filter(x => num(x.amountYi) != null && num(x.amountYi) < TH.liquidityMinYi) : [];
    const level = !list ? '无法判断' : thin.length > 0 ? '中' : '低';
    individual.push(riskItem(D.individual[3], level,
      `活跃样本中成交额 < ${TH.liquidityMinYi} 亿元的 ${thin.length} 只（样本仅覆盖涨停池/强势股池）`,
      '次日核对该批个股成交额是否放大',
      '成交额回到阈值之上', []));
  }
  // R-I5 突发个股问题：无公告/监管本机源
  individual.push(riskItem(D.individual[4], '无法判断',
    `个股公告/监管/业绩突发数据源${MISSING}；联网搜索仅用于新闻催化线索，不替代公告核验`,
    '补充公告与监管数据源后再核对',
    '数据补齐后方可判定', []));

  return { market, sector, individual };
}

function marketRiskLevelOf(risks) {
  const all = [].concat(risks.market, risks.sector, risks.individual);
  if (all.some(r => r.level === '高')) return '高';
  if (all.some(r => r.level === '中')) return '中';
  if (all.some(r => r.level === '无法判断')) return '无法判断';
  return '低';
}

// ---------- 主入口 ----------
/**
 * @param {object} raw 由 reviewService 组装的采集值
 * @returns {object} 引擎输出（全部确定性，可直接落盘/渲染）
 */
function analyze(raw) {
  const ctx = normInput(raw);
  // 先算风险（不含市场级降级的初版），再把市场级风险等级回填给机会评级
  const risksFirst = assessRisks(ctx);
  ctx.marketRiskLevel = marketRiskLevelOf(risksFirst);
  const candidates = buildCandidates(ctx).map(c => gradeOf(c, ctx));
  const passed = candidates.filter(c => c.grade !== 'D');
  const rank = { A: 0, B: 1, C: 2, D: 3 };
  passed.sort((a, b) => (rank[a.grade] - rank[b.grade]) || (b.confirm.count - a.confirm.count));
  // 观察池保底：用户要求 3-8 只，但硬凑会变成臆造。优先取个股级候选；
  // 不足 3 只时用板块级候选补足并标注类别，仍不足则如实输出实际数量 + 原因（不输出空白表）。
  let watch = passed.filter(c => c.scope === 'stock').slice(0, 8);
  const watchSectorFill = watch.length < 3
    ? passed.filter(c => c.scope === 'sector').slice(0, 3 - watch.length)
    : [];
  watch = watch.concat(watchSectorFill);
  const dCount = candidates.filter(c => c.grade === 'D').length;
  const watchPoolNote = watch.length < 3
    ? `今日通过漏斗的候选仅 ${watch.length} 个（<3）：${candidates.length === 0
      ? '本次无可用候选数据（相关数据源缺失或取数失败）'
      : `${dCount} 个候选命中个股级硬否决被剔除`}；按「不臆造」原则如实列出，不补足到 3 个。`
    : (watchSectorFill.length ? `个股级合格样本不足 3 个，已用 ${watchSectorFill.length} 个板块级候选补足，并在名称中标注「板块」。` : '');

  const keyMissing = [
    { field: '个股多日成交额 / 量价序列', why: 'C3 资金持续性、L5、R-I1 无法判定' },
    { field: '板块中军 / 趋势股行情', why: 'L2 板块层次、R-S5 无法完整判定' },
    { field: '公告 / 监管 / 题材首现时间窗', why: 'O1-O3/O5 催化分类、R-S4、R-I5 无法判定' },
  ];

  return {
    schemaVersion: 'engine-20261108d',
    date: ctx.date,
    histDates: ctx.histDates,
    marketRiskLevel: ctx.marketRiskLevel,
    trends: {
      limitUp: trendOf(ctx.historySeries, 'limitUp'),
      limitDown: trendOf(ctx.historySeries, 'limitDown'),
      prevRedRate: trendOf(ctx.historySeries, 'prevRedRate'),
      promotionRate: trendOf(ctx.historySeries, 'promotionRate'),
      ztAmountYi: trendOf(ctx.historySeries, 'ztAmountYi'),
    },
    risks: risksFirst,
    candidates,
    opportunityTable: passed.map(c => ({
      name: c.name, code: c.code, scope: c.scope,
      category: c.category, drivers: c.drivers || MISSING, grade: c.grade,
      catalyst: c.catalyst || MISSING,
      layer: c.layer == null ? MISSING : (c.layer ? '有层次' : '单票独舞'),
      capitalContinuity: MISSING,
      confirmCount: c.confirm.count,
      vetoes: c.veto.hits.length ? c.veto.hits.map(v => v.code).join('、') : '无',
      oneLine: c.gradeReason,
      sourceTag: c.sourceTag,
    })),
    watchPool: watch.map(c => ({
      name: c.scope === 'sector' ? `${c.name}（板块）` : c.name, code: c.code,
      categoryGrade: `${c.category} / ${c.grade}级`,
      drivers: c.drivers || MISSING,
      reason: c.catalyst || MISSING,
      sector: c.industry || MISSING,
      watchChange: c.grade === 'A' || c.grade === 'B'
        ? '次日核对板块是否出现更多跟随个股、买盘是否延续'
        : '次日仅核对是否出现跟随个股与成交额变化',
      invalidate: c.topicStage && c.topicStage !== MISSING
        ? `题材阶段 ${c.topicStage} 未延续、板块无跟随、成交额回落或出现高位断板后大幅走弱`
        : '板块无跟随、成交额回落或出现高位断板后大幅走弱',
      riskTags: c.veto.hits.length ? c.veto.hits.map(v => v.code).join('、') : (c.confirm.unknown ? `数据缺失${c.confirm.unknown}项` : '无'),
    })),
    watchPoolNote,
    keyMissingTop3: keyMissing,
    caliberNotes: [
      `大面股 = 昨日涨停股今日涨跌幅 ≤ ${TH.bigDropPct}%（工作台自定义代理口径）`,
      `流动性不足阈值 = 个股成交额 < ${TH.liquidityMinYi} 亿元`,
      `连续加速代理 = 连板高度 ≥ ${TH.highBoard} 板`,
      `持续性判定至少需 ${TH.trendMinPoints} 个有效对照点；不足则输出「${NO_COMPARISON}」`,
      '成交额样本仅覆盖涨停池 + 强势股池，不代表两市成交额排名',
      '中军/趋势股、个股多日量价、公告催化时间窗、题材新旧：工作台暂无可靠本机源，相关项标「缺失」',
      '新闻标题只作催化线索（附来源时间），不构成公告核验，不单独决定分类',
      '否决项分级：V1/V2/V6 为个股级硬否决 → D 剔除；V3/V4/V5 为市场级/位置级软否决 → 降级 C「仅观察」，命中后永不评 A/B（对规格「降级或剔除」的显式取舍，避免一次负反馈让汇总表与观察池全空）',
      '观察池个股级合格样本不足 3 个时，用板块级候选补足并标注；仍不足则如实列出实际数量与原因，绝不硬凑',
      '20261108d 新增 C7（量价结构健康）与 V7（高位顶背离+放量滞涨+板块不跟）依赖个股多日量价序列，工作台暂无该源 → 恒「缺失」，不以封板时间或单日成交额冒充',
      '20261108d 新增 C8（消息在催化/发酵期）与 V8（消息兑现+龙头独舞）由 lib/topicEngines.js 基于前 3-5 日同口径行业涨停家数序列确定性给出，是本轮新增的真实可证项',
      '驱动标签 D1 技术 / D2 消息 / D3 资金 / D4 基本面；D4 因复盘链路未接入财报与估值数据恒不标注，不以新闻标题冒充基本面证据',
      '四象限中和：共振不处理、背离降级 C、先觉降一级、双弱剔除 D；「无法判断」不额外升降级（实时新闻流不能证明某题材当日无消息，不把证据缺失误判成双弱而整批剔除）',
      '中军表现以涨停池内流通市值居前个股作代理，不是真实板块中军；代理样本缺失时题材 S 级不成立',
    ],
  };
}

module.exports = {
  analyze, quad, riskItem, trendOf, num, pct, fixed, yi, tri,
  classifyOpportunity, funnelOf, confirmOf, vetoOf, gradeOf,
  buildCandidates, assessRisks, marketRiskLevelOf, normInput,
  topicOf, driversOf,
  TH, MISSING, NO_COMPARISON, HARD_VETO, SOFT_VETO, DRIVER_DEFS,
  OPPORTUNITY_CATEGORIES, CONFIRM_DEFS, VETO_DEFS, RISK_DEFS,
};

~~~

---

## `lib\reviewLlm.js`  ·  122 行

~~~js
/**
 * lib/reviewLlm.js — 每日复盘「LLM 生成层」（20261110b）
 * ==================================================================================
 * 用户 2026-11-10 16:03 裁决：引入大模型生成复盘报告。
 *   「将抓取到的 JSON 数据作为 Context，喂给大模型。系统必须加载一份复盘提示词
 *     （System Prompt），让大模型生成排版灵动、说人话、有深度归因的 Markdown 报告。」
 *
 * 链路：reviewContext.build() → 本文件 generate() → Markdown 字符串 → reviewService 落盘。
 * 本文件不产生任何数值、不组装任何报告段落、不做任何文本替换。
 *
 * 【取消硬性质检】LLM 未配置 / 超时 / 报错 / 返回空，一律降级为「原始数据快照」，
 * 由调用方照常落盘发布；绝不因为数据重复、字段为 null 或质检不通过而拒绝生成复盘。
 * 这是与旧 lib/reviewOutput.js qualityOf() 硬门禁的根本区别。
 *
 * 复用项目统一 LLM 通道 lib/ai/llm.js（callLLM）与本机配置 data/ai_config.json，
 * 不新增依赖、不新增密钥、不需要用户手动配置。
 */
'use strict';

const { loadConfig, loadPromptFile } = require('./ai/config');
const { callLLM, pickModelFor } = require('./ai/llm');
const reviewContext = require('./reviewContext');

const PROMPT_FILE = 'daily-review-system.md';
const TIMEOUT_MS = 300000;   // 长报告 + 大 Context，5 分钟（实测 11KB 上下文偶发逼近 240s，留余量）

function isConfigured() {
  try {
    const c = loadConfig();
    return !!(c && c.apiKey);
  } catch (e) { return false; }
}

/** 去掉模型常见的 ```markdown ... ``` 包裹与前后空白，不做任何内容改写。 */
function cleanMarkdown(s) {
  let t = String(s == null ? '' : s).trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  return t;
}

function degraded(context, reason, extra) {
  return {
    ok: false, degraded: true,
    markdown: reviewContext.toDataSnapshotMarkdown(context, reason),
    model: (extra && extra.model) || null,
    promptFile: PROMPT_FILE,
    error: String(reason || '未知原因').slice(0, 300),
    elapsedMs: (extra && extra.elapsedMs) || 0,
    contentChars: 0,
  };
}

/**
 * 生成复盘 Markdown。
 * @param {object} context reviewContext.build() 产出的干净 JSON
 * @param {object} opts    { stage, date }
 * @returns {Promise<{ok:boolean, degraded:boolean, markdown:string, model:string|null,
 *                    promptFile:string, error:string|null, elapsedMs:number, contentChars:number}>}
 */
async function generate(context, opts) {
  const o = opts || {};
  const started = Date.now();
  let cfg;
  try { cfg = loadConfig(); } catch (e) { return degraded(context, 'AI 配置读取失败：' + e.message); }
  if (!cfg || !cfg.apiKey) return degraded(context, '未配置 AI 模型密钥（本机 AI 设置）');

  let systemPrompt;
  try { systemPrompt = loadPromptFile(PROMPT_FILE); } catch (e) { systemPrompt = ''; }
  if (!systemPrompt || systemPrompt.indexOf('每日复盘') === -1) {
    return degraded(context, '复盘提示词 ' + PROMPT_FILE + ' 未加载成功');
  }

  const pick = pickModelFor(cfg, 'web');
  const model = pick.model || cfg.modelLocal || '';
  if (!model) return degraded(context, '未配置可用模型（本机 AI 设置）', { model: null });

  const date = (context && context.meta && context.meta.reviewDate) || o.date || '';
  const contextChars = JSON.stringify(context).length;
  console.log(`[每日复盘] LLM 生成开始：${date} · Context ${contextChars} 字符 · 模型 ${model}`);
  const userText = [
    '以下是工作台代码采集并计算好的当日原始数据，JSON 是唯一事实来源。',
    '复盘日：' + date + '；版本阶段：' + (o.stage || (context && context.meta && context.meta.stage) || 'formal') + '。',
    '请严格按你的系统提示词，生成这一天的盘后复盘 Markdown 报告。',
    '',
    '```json',
    // 紧凑序列化：漂亮打印会多出约 30% 字符，实测曾把 Context 撑到 88KB 导致模型 240s 超时。
    JSON.stringify(context),
    '```',
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  try {
    // 纯本地数据推理：关闭联网搜索，避免无关事实混入与额外计费。
    const raw = await callLLM(cfg.provider, cfg.apiKey, model, messages,
      { webSearch: false, timeoutMs: TIMEOUT_MS });
    const markdown = cleanMarkdown(raw);
    if (!markdown) {
      return degraded(context, '模型返回空内容', { model, elapsedMs: Date.now() - started });
    }
    return {
      ok: true, degraded: false, markdown,
      model, promptFile: PROMPT_FILE, error: null,
      elapsedMs: Date.now() - started, contentChars: markdown.length,
    };
  } catch (e) {
    const status = e && e.response && e.response.status;
    const why = 'LLM 调用失败' + (status ? '（HTTP ' + status + '）' : '') + '：' + String((e && e.message) || e);
    return degraded(context, why, { model, elapsedMs: Date.now() - started });
  }
}

module.exports = {
  generate, isConfigured, cleanMarkdown,
  PROMPT_FILE, TIMEOUT_MS,
};

~~~
