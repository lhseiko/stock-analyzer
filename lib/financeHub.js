/**
 * 财务 · 统一数据网关（三条底层铁律铺开：财务模块）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：财报数据只从 fetchFinancialData（东财 F10 报表
 *     lrbAjaxNew / zcfzbAjaxNew / xjllbAjaxNew）取，本模块为唯一出口。
 *   - 五要素身份：每个指标携带 { 名称, 数值, 报告期(数据时间), 来源, 获取时间 }。
 * 规则二 数据最新性：
 *   - 财务数据有效期 90 天；以「最新报告期」为数据时间做体检。
 *   - 过期或取数失败时输出「数据已过期，最后更新时间是 XXXX-XX-XX」，
 *     绝不用推算值冒充实际披露值。
 * 规则三 变化与边际分析：
 *   - 变化率 = 同比增速（YoY）；
 *   - 边际 = 本期同比增速 − 上期同比增速 → 业绩「加速增长 / 增速放缓」；
 *   - 方向性变化（由增转降 / 由降转增）+ 连续同向边际的趋势强化信号。
 * 通用原语复用 ./ruleCore。
 * ============================================================================
 */
const core = require('./ruleCore');

const {
  makeDatum, beginSnapshot, checkFreshness, staleLabel,
  analyzeSeries, changeRate,
} = core;

const SOURCE = '东方财富F10财报(lrb/zcfz/xjllbAjaxNew)';

// 关注的财务指标：key = 报表字段名，label = 展示名
const METRICS = [
  { key: 'TOTAL_OPERATE_INCOME', label: '营业收入' },
  { key: 'PARENT_NETPROFIT', label: '归母净利润' },
];

/**
 * 从利润表序列中取出某指标的「年度序列」（按 REPORT_DATE 年份去重，取该年最后一条）
 */
function yearlySeries(income, key) {
  const byYear = {};
  (income || []).forEach(r => {
    const d = String(r.REPORT_DATE || '').slice(0, 10);
    const y = d.slice(0, 4);
    const v = Number(r[key]);
    if (!y || !isFinite(v)) return;
    // 升序遍历时后来者覆盖 → 得到该年最后一个报告期
    byYear[y] = { date: d, value: v };
  });
  return Object.keys(byYear).sort().map(y => byYear[y]);
}

/**
 * 主入口
 * @param {Object} finData  fetchFinancialData 的返回 { income, balance, cashflow }
 */
function getFinanceHub(finData) {
  const fetchTime = new Date().toISOString();

  if (!finData || !Array.isArray(finData.income) || !finData.income.length) {
    return {
      ok: false,
      error: '未获取到财务数据',
      note: '⚠️ 未能获取财务数据，本次不输出财务结论（规则：无有效数据不得分析）。',
      fetchedAt: fetchTime,
    };
  }

  const income = finData.income.slice().sort(
    (a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || ''))
  );

  // 最新报告期 = 数据时间（规则二：财务以报告期为数据时间）
  const latestReport = income[income.length - 1];
  const reportDate = String(latestReport.REPORT_DATE || '').slice(0, 10);

  // 规则一②：五要素（最新报告期关键指标）
  const latest = {};
  METRICS.forEach(m => {
    const v = Number(latestReport[m.key]);
    if (isFinite(v)) latest[m.key] = makeDatum(m.label, v, reportDate, SOURCE, fetchTime);
  });

  // 规则二②：财务 90 天有效期体检
  const freshness = checkFreshness(reportDate, 'financial', Date.now());
  const staleNote = freshness.expired ? staleLabel(reportDate) : '';

  // 规则三：各指标的年度同比序列 → 变化率 / 边际 / 方向
  const analysis = {};
  METRICS.forEach(m => {
    const series = yearlySeries(income, m.key)
      .filter(p => p.value > 0)
      .map(p => ({ date: p.date, value: p.value, source: SOURCE, fetchTime }));
    analysis[m.key] = analyzeSeries(series, m.label);
  });

  // 规则三补充：营收/净利润「增速的边际」——本期同比 vs 上期同比
  const growthMarginal = {};
  METRICS.forEach(m => {
    const series = yearlySeries(income, m.key).filter(p => p.value > 0);
    if (series.length < 3) {
      growthMarginal[m.key] = { available: false, reason: '不足三期，无法计算增速的边际' };
      return;
    }
    const n = series.length;
    const curYoY = changeRate(series[n - 1].value, series[n - 2].value);
    const prevYoY = changeRate(series[n - 2].value, series[n - 3].value);
    const marginal = (curYoY != null && prevYoY != null)
      ? Math.round((curYoY - prevYoY) * 100) / 100 : null;
    let trend = '数据不足';
    if (marginal != null) {
      if (curYoY > 0) trend = marginal > 0.5 ? '加速增长' : (marginal < -0.5 ? '增速放缓' : '增速平稳');
      else if (curYoY < 0) trend = marginal < -0.5 ? '降幅扩大' : (marginal > 0.5 ? '降幅收窄' : '降幅平稳');
      else trend = '基本持平';
    }
    growthMarginal[m.key] = {
      available: true,
      currentYoY: curYoY,
      prevYoY: prevYoY,
      marginal,
      trend,
      text: `${m.label}同比 ${curYoY != null ? curYoY.toFixed(2) : '--'}%（上期 ${prevYoY != null ? prevYoY.toFixed(2) : '--'}%），边际 ${marginal != null ? marginal.toFixed(2) : '--'} 个百分点，呈${trend}态势`,
    };
  });

  return {
    ok: true,
    latest,
    reportDate,
    freshness,
    staleNote,
    analysis,
    growthMarginal,
    source: SOURCE,
    fetchedAt: fetchTime,
  };
}

/**
 * 生成「规则合规」的财务描述片段
 */
function formatFinanceLine(hub, key) {
  if (!hub || !hub.latest) return null;
  const d = hub.latest[key];
  if (!d) return null;
  const stale = (hub.freshness && hub.freshness.expired && hub.staleNote) ? `；⚠️ ${hub.staleNote}` : '';
  const base = `${d.name} ${d.value}（报告期 ${d.dataTime}，来源：${d.source}${stale}）`;
  const g = hub.growthMarginal && hub.growthMarginal[key];
  if (!g || !g.available) return base;
  return `${base}；${g.text}`;
}

module.exports = { getFinanceHub, formatFinanceLine, beginSnapshot };
