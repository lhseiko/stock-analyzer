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
