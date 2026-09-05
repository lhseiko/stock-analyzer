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
 * 统计局），本模块聚焦东方财富可直接结构化获取的 5 个核心指标 + 财政收入（RPT_ECONOMY_INCOME）；
 * 财政支出在东方财富数据中心无稳定报表名、akshare 亦无对应函数，故改为「财政部《财政收支情况》
 * 公告解析」路径获取（经 cn-financial-scraper 检索公告 → 抓正文 → 正则解析一般公共预算支出
 * 累计额与累计同比），与财政收入对称展示。外挂解析源不可达时优雅降级为占位卡片。
 */
const axios = require('axios');
const { getFiscalData } = require('./cnscraperAdapter');

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

// 每个指标的拉取配置
const FETCHERS = [
  { key: 'CPI', fn: buildCPI, report: 'RPT_ECONOMY_CPI', cols: 'REPORT_DATE,TIME,NATIONAL_SAME,NATIONAL_SEQUENTIAL,NATIONAL_ACCUMULATE' },
  { key: 'PPI', fn: buildPPI, report: 'RPT_ECONOMY_PPI', cols: 'REPORT_DATE,TIME,BASE_SAME,BASE_ACCUMULATE' },
  { key: 'GDP', fn: buildGDP, report: 'RPT_ECONOMY_GDP', cols: 'REPORT_DATE,TIME,DOMESTICL_PRODUCT_BASE,SUM_SAME,FIRST_SAME,SECOND_SAME,THIRD_SAME' },
  { key: 'PMI', fn: buildPMI, report: 'RPT_ECONOMY_PMI', cols: 'REPORT_DATE,TIME,MAKE_INDEX,NMAKE_INDEX' },
  { key: 'M2', fn: buildM2, report: 'RPT_ECONOMY_CURRENCY_SUPPLY', cols: 'REPORT_DATE,TIME,BASIC_CURRENCY,BASIC_CURRENCY_SAME,CURRENCY_SAME,FREE_CASH_SAME' },
  { key: 'FISCAL_REV', fn: buildFiscalRevenue, report: 'RPT_ECONOMY_INCOME', cols: 'REPORT_DATE,TIME,BASE,BASE_SAME,BASE_SEQUENTIAL,BASE_ACCUMULATE,ACCUMULATE_SAME' },
];

// 每日缓存（跨日自动失效）
let dataCache = { date: '', data: null };

// 指标排序：财政支出紧随财政收入之后，保持对称
const INDICATOR_ORDER = ['CPI', 'PPI', 'GDP', 'PMI', 'M2', 'FISCAL_REV', 'FISCAL_EXP'];

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

  // 财政支出（财政部《财政收支情况》公告解析）：best-effort、短超时，绝不影响主指标
  let fiscalExp = null;
  try {
    const fd = await Promise.race([
      getFiscalData(),
      new Promise(res => setTimeout(() => res(null), 12000)),
    ]);
    fiscalExp = buildFiscalExpenditure(fd);
  } catch (e) {
    fiscalExp = buildFiscalExpenditure(null);
  }
  if (fiscalExp) indicators.push(fiscalExp);

  indicators.sort((a, b) => (INDICATOR_ORDER.indexOf(a.key) - INDICATOR_ORDER.indexOf(b.key)));

  const okCount = indicators.length;
  const data = {
    source: okCount ? '东方财富数据中心（结构化宏观指标）· 财政支出取自财政部公告解析' : '东方财富数据中心（暂不可达）',
    date: today,
    updated: new Date().toISOString(),
    indicators,
    available: okCount,
    total: FETCHERS.length + 1,
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
