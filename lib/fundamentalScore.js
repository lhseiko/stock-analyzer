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
function yoyPair(hist, field) {
  if (!Array.isArray(hist) || !hist.length) return { cur: null, prev: null, name: '', reason: '本地财报库无多期数据' };
  const rows = hist
    .map(d => ({ d: new Date(String(d.REPORT_DATE || '').slice(0, 10)), v: num(d[field]), name: d.REPORT_DATE_NAME || '' }))
    .filter(r => r.d && !isNaN(r.d.getTime()) && r.v != null)
    .sort((a, b) => b.d - a.d);
  if (!rows.length) return { cur: null, prev: null, name: '', reason: `财报库无「${field}」字段` };
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
    let sumW = 0, cnt = 0;
    for (const k of ['pe', 'pb', 'ps']) {
      const v = raw[k];
      if (v == null) { mark('估值', k.toUpperCase(), '接口/财报无该指标取值'); valMetrics.push([`${k.toUpperCase()}（估值）`, '0（无法取值）']); continue; }
      if (v <= 0) { valMetrics.push([`${k.toUpperCase()}（估值）`, '0（无法取值）']); continue; }
      const hist = vh.length >= 30 ? percentileRank(seriesMap[k], v) : null;
      const ind = industryPercentile(v, benchMap[k]);
      if (hist == null) mark('估值', `${k.toUpperCase()} 历史百分位`, vh.length >= 30 ? '历史序列缺失该指标' : '估值历史序列不足 30 期');
      if (ind == null) mark('估值', `${k.toUpperCase()} 行业均值分位`, '行业均值缺失（联网异常或该行业无数据）');
      if (hist == null && ind == null) { valMetrics.push([`${k.toUpperCase()}（估值）`, '0（无法取值）']); continue; }
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
      ['市盈率 PE', raw.pe ? raw.pe.toFixed(1) + ' 倍' : '无法取值'],
      ['市净率 PB', raw.pb ? raw.pb.toFixed(1) + ' 倍' : '无法取值'],
      ['市销率 PS', raw.ps ? raw.ps.toFixed(1) : '无法取值'],
    ],
    rule: valRule || '—',
    summary: `估值维度固定 ${DIM} 分；PE/PB/PS 任一项为负即判重度利空得 0 分，三项为正时按「行业均值分位×0.6 + 历史百分位×0.4」加权，分位越低得分越高，PEG<1 额外 +5（封顶 ${DIM}）。本次得 ${valActual}/${DIM} 分。`,
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
  // 三项指标均优先从本地财报库（zyzbHistory）取数：
  //   合并口径营业收入同比 TOTALOPERATEREVETZ / 归母净利润同比 PARENTNETPROFITTZ / 扣非净利润同比 KCFJCXSYJLRTZ
  const revYoY = yoyPair(zy, 'TOTALOPERATEREVETZ');   // 合并口径营业收入同比
  const npYoY = yoyPair(zy, 'PARENTNETPROFITTZ');     // 归母净利润同比
  const dedYoY = yoyPair(zy, 'KCFJCXSYJLRTZ');        // 扣非净利润同比
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
    summary: `成长性维度固定 ${DIM} 分；三项同比（合并营业收入/归母净利润/扣非净利润）任意一项为负即 0 分，全为正时结合连续两年增速趋势与行业平均增速计分；无法取值项不参与评分。本次得 ${growthActual}/${DIM} 分。`,
  };
  total += growthActual;

  // ================= ④ 财务健康（25 分） =================
  const debt = num(f.debtToEquity);              // A股为资产负债率%
  const isPct = !!f.debtMetricPct;
  const cr = num(f.currentRatio);
  const ocfps = num(f.operatingCashFlowPerShare);
  const divY = num(f.dividendYield);
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

  if (f.targetMeanPrice) {
    result.analystTarget = {
      mean: f.targetMeanPrice,
      high: f.targetHighPrice || 0,
      low: f.targetLowPrice || 0,
      median: f.targetMedianPrice || 0,
      recommendation: f.recommendationKey || '',
      recommendationScore: f.recommendationMean || 0,
      analystCount: f.numberOfAnalystOpinions || 0,
    };
  }
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
