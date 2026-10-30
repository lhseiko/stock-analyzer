/**
 * lib/metricAnalysis.js — 「指标分析」确定性引擎（20260919a）
 *
 * 替代原「分析师评级」模块。对个股页左侧「关键财务指标」做确定性五维对比：
 *   ① 同比（去年同期同报告期）② 环比（较上一披露期，累计口径标注）
 *   ③ 行业均值对比 ④ 历史百分位对比 ⑤ 边际变化（趋势/加速·减速）
 * 并给出「判定依据」（与左侧 利好/中性/利空 信号同源，由 evaluateSignals 提供）。
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

// 同比：取最新披露期 vs 去年同期同一报告期（REPORT_DATE 年份-1 精确匹配，避免跨期误比）
function samePeriodPair(zy, field) {
  if (!Array.isArray(zy) || !zy.length) return { cur: null, prev: null };
  const latest = zy[0];
  const ld = String(latest.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return { cur: toNum(latest[field]), prev: null };
  const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
  const prev = zy.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt);
  return { cur: toNum(latest[field]), prev: prev != null ? toNum(prev[field]) : null };
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
  {
    const cur = norm(val('roeTtm', 'roe', 'roe'), 'roe');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const roePrevTtm = (typeof f.roeTtmPrev === 'number' && !isSentinel(f.roeTtmPrev, 'roe')) ? f.roeTtmPrev : null;
    const yoy = (cur != null && roePrevTtm != null)
      ? (() => { const d = cur - roePrevTtm; return ok(`本报告期 ${cur.toFixed(2)}%（去年同期 ${roePrevTtm.toFixed(2)}%，边际 ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp；TTM 同口径）`, deltaSignal(d, true)); })()
      : yoyDim(norm(samePeriodPair(zyzb, 'ROEJQ').cur, 'roe'), norm(samePeriodPair(zyzb, 'ROEJQ').prev, 'roe'), true, '%');
    const qoq = qoqDim(norm(consecutivePair(zyzb, 'ROEJQ').cur, 'roe'), norm(consecutivePair(zyzb, 'ROEJQ').prev, 'roe'), true, '%');
    metrics.push({
      key: 'roe', label: 'ROE', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: industryDim(cur, ind.roe, true, '%'), pct: pctDim(pct.roe, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.roe || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  }
  // 毛利率
  {
    const cur = norm(val('grossMarginTtm', 'grossMargin', 'grossMargin'), 'grossMargin');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const yoy = yoyDim(norm(samePeriodPair(zyzb, 'XSMLL').cur, 'grossMargin'), norm(samePeriodPair(zyzb, 'XSMLL').prev, 'grossMargin'), true, '%');
    const qoq = qoqDim(norm(consecutivePair(zyzb, 'XSMLL').cur, 'grossMargin'), norm(consecutivePair(zyzb, 'XSMLL').prev, 'grossMargin'), true, '%');
    metrics.push({
      key: 'grossMargin', label: '毛利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业毛利率均值）'), pct: pctDim(pct.grossMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.grossMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
      note: '口径说明：本卡「本报告期」为报告期累计口径（利润表销售毛利率）；左卡数值为 TTM 滚动口径（近12个月）。财报更新后两卡数值不同属口径差异（TTM 含去年同期 Q4），非数据错误。',
    });
  }
  // 净利率
  {
    const cur = norm(val('netMarginTtm', 'netMargin', 'netMargin'), 'netMargin');
    const curText = cur != null ? cur.toFixed(2) + '%' : '--';
    const yoy = yoyDim(norm(samePeriodPair(zyzb, 'XSJLL').cur, 'netMargin'), norm(samePeriodPair(zyzb, 'XSJLL').prev, 'netMargin'), true, '%');
    const qoq = qoqDim(norm(consecutivePair(zyzb, 'XSJLL').cur, 'netMargin'), norm(consecutivePair(zyzb, 'XSJLL').prev, 'netMargin'), true, '%');
    metrics.push({
      key: 'netMargin', label: '净利率', valueText: curText, unit: '%',
      dims: { yoy, qoq, industry: na('不可得（无行业净利率均值）'), pct: pctDim(pct.netMargin, true), marginal: marginalLevelDim(yoy, qoq) },
      judgment: sigMap.netMargin || { signal: 'neutral', reason: '数据不足，无法判定' },
      note: '口径说明：本卡「本报告期」为报告期累计口径（利润表销售净利率）；左卡数值为 TTM 滚动口径（近12个月）。财报更新后两卡数值不同属口径差异（TTM 含去年同期 Q4），非数据错误。',
    });
  }

  // —— 成长指标（值本身为同比 %）——
  const buildGrowth = (key, label, cur, pctKey, field) => {
    const c = norm(cur, key);
    const curText = c != null ? c.toFixed(2) + '%' : '--';
    const pair = samePeriodPair(zyzb, field);
    const prev = norm(pair.prev, key);
    let yoy, marginal;
    if (c == null) { yoy = na('不可得'); marginal = na('不可得'); }
    else if (prev == null) {
      yoy = ok(`本报告期 ${c.toFixed(2)}%（缺去年同期对比）`, c > 0 ? 'bull' : c < 0 ? 'bear' : 'neutral');
      marginal = ok(c > 0 ? '正增长' : '负增长', c > 0 ? 'bull' : 'bear');
    } else {
      const dpp = c - prev;
      const sig = dpp > 0.5 ? 'bull' : dpp < -0.5 ? 'bear' : 'neutral';
      yoy = ok(`本报告期 ${c.toFixed(2)}%（去年同期 ${prev.toFixed(2)}%，边际 ${dpp >= 0 ? '+' : ''}${dpp.toFixed(2)}pp）`, sig);
      marginal = ok(`增速同比${dpp > 0 ? '加速' : '放缓'} ${Math.abs(dpp).toFixed(2)}pp`, sig);
    }
    metrics.push({
      key, label, valueText: curText, unit: '%',
      dims: { yoy, qoq: na('—（增长率本身为同比口径，环比不适用）'), industry: na('不可得（无行业增速均值）'), pct: pctKey ? pctDim(pct[pctKey], true) : na('不可得（无增速历史百分位）'), marginal },
      judgment: sigMap[key] || { signal: 'neutral', reason: '数据不足，无法判定' },
    });
  };
  buildGrowth('growth', '营收增长', val('revenueYoy', 'revenueGrowth', 'growth'), 'revenueGrowth', 'TOTALOPERATEREVETZ');
  buildGrowth('profitGrowth', '利润增长', val('profitYoy', 'profitGrowth', 'profitGrowth'), 'profitGrowth', 'PARENTNETPROFITTZ');
  // ★ 20260923l 修复：旧版 `if (f.deductedProfitGrowth != null)` 读 quote.fundamentals（该键从不写入）
  //   → 该项对所有股票恒不渲染。现改为 val() 双源（真实值在 fundamental.metrics）+ 无条件构建。
  buildGrowth('dedProfitGrowth', '扣非净利润增长', val('deductedProfitGrowth', 'deductedProfitGrowth', 'dedProfitGrowth'), null, 'KCFJCXSYJLRTZ');

  // ─── 营运利润（20261029a 新增，全个股；数据源 F10 利润表 lrbAjaxNew OPERATE_PROFIT）───
  // 绝对额指标（亿），同比=同报告期累计口径；判定为确定性代码按同比符号给出（非 LLM）。
  // opProfit 为 null（利润表取不到/缺科目）→ 整行不渲染（左右两卡一致），绝不编造。
  if (opProfit && opProfit.cur && typeof opProfit.cur.opProfitYi === 'number') {
    const curYi = opProfit.cur.opProfitYi;
    const prevYi = (opProfit.prev && typeof opProfit.prev.opProfitYi === 'number') ? opProfit.prev.opProfitYi : null;
    const yoyPct = (typeof opProfit.yoyPct === 'number') ? opProfit.yoyPct : null;
    const sig = (yoyPct == null) ? null : (yoyPct > 0.5 ? 'bull' : yoyPct < -0.5 ? 'bear' : 'neutral');
    const dir = (yoyPct != null && yoyPct >= 0) ? '+' : '';
    // 20261029i 格式统一（图二三段式）：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）；同比%移入边际维度
    const dYi = (prevYi != null) ? curYi - prevYi : null;
    const yoy = (yoyPct != null && prevYi != null)
      ? ok(`本报告期 ${curYi.toFixed(2)}亿（去年同期 ${prevYi.toFixed(2)}亿，边际 ${dYi >= 0 ? '+' : ''}${dYi.toFixed(2)}亿）`, sig)
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
          ? `营业利润同比 ${dir}${yoyPct.toFixed(2)}%（${opProfit.cur.date} 报告期累计口径）`
          : `营业利润 ${curYi.toFixed(2)}亿（${opProfit.cur.date}，缺同比基数，无法判定方向）`,
      },
      note: '口径说明：本行取自利润表「营业利润」科目（通用会计口径，全个股统一）。它与「扣非净利润」的区别：① 位置不同——营业利润位于利润表中段（营业收入−营业成本−税金及附加−期间费用+投资收益等），尚未扣除所得税与少数股东损益；扣非净利润位于末端（归母净利润再剔除非经常性损益）。② 含义不同——营业利润看的是经营盘面的整体盈利（含投资收益/公允价值变动/减值等波动项，银行/保险/券商的利息与投资收入都计入其中）；扣非净利润看的是落到归母股东手里的经常性盈利。③ 用法——营业利润适合看盈利规模与结构，扣非增速适合看主业趋势。注：中国平安等公司财报另披露一个非通用口径的「营运利润」（剔除短期投资波动等），本工具不采用该口径。',
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

  return {
    metrics: ordered,
    order: METRIC_ORDER.slice(),
    isFinancial,
    note: '指标分析为确定性代码计算，覆盖同比/环比(较上一披露期·累计口径)/行业均值/历史百分位/边际变化五维；「判定依据」与左侧利好·中性·利空信号同源。缺数据维度如实标注「不可得」。指标顺序与左侧「关键财务指标」逐项对齐（单一权威顺序 METRIC_ORDER）。',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMetricAnalysis, METRIC_ORDER, ZERO_AS_MISSING };
