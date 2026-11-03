/**
 * lib/consistencyAudit.js — 工作台跨板块数据一致性巡检（20261103e）
 *
 * 用户指令：每日定期检查工作台所有数据——多个板块使用的同一数据，即使数据源不同，
 * 也要核对是否展示一样的数值；⚠️ 必须区分「累计数据」与「固定期数据」
 * （例：前三季度累计 vs 第三季度单季——两者本来就不该相等，绝不能误报不一致）。
 *
 * 巡检对象（同一语义数据在多板块的展示值）：
 *   - PE/PB/PS：顶栏指标条 / 左卡·关键财务指标 / 右卡·指标分析 / 行情
 *   - ROE：TTM 口径（顶栏/右卡/信号卡）vs 左卡（可能为报告期累计 ROEJQ）
 *   - 毛利率/净利率：TTM 口径 vs 报告期累计口径（XSMLL/XSJLL）
 *   - 营收增长/利润增长/扣非增长：单季优先同比（DJD_*）vs 累计同比（*_TZ）
 *   - 营运利润/NBV：原始取数 vs 右卡展示文本（单季与累计分别建目，不互比）
 *   - 行业均值 / 历史百分位：comparison 权威值 vs 右卡维度文本内嵌数值
 *
 * 状态口径：
 *   ok       —— 同口径数值一致
 *   caliber  —— 数值不同但属已知口径差异（单季 vs 累计 / TTM vs 报告期），如实注记，非错误
 *   mismatch —— 同口径数值不一致（真实数据链问题，需修复）
 *   missing  —— 可比数据不足，如实跳过
 *
 * 复用方式：与 analysisWarm 预热同机制——本地 HTTP 自调用 /api/analysis/:symbol
 * 取完整载荷后做纯函数核对，绝不重复实现载荷构建逻辑（单一数据源）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const AUDIT_DIR = path.join(__dirname, '..', 'data', 'consistency-audit');

// ===== 通用工具 =====
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= eps; }
// 从「xx.xx%」提取数值
function pctFrom(text) { if (typeof text !== 'string') return null; const m = /(-?[\d.]+)%/.exec(text); return m ? parseFloat(m[1]) : null; }
// 从「xx.xx亿」提取数值
function yiFrom(text) { if (typeof text !== 'string') return null; const m = /(-?[\d.]+)亿/.exec(text); return m ? parseFloat(m[1]) : null; }
// 从「xx.xx」纯数值文本提取（PE/PB/PS 倍数无 % 后缀）
function numFrom(text) { if (typeof text !== 'string') return null; const m = /^(-?[\d.]+)$/.exec(text.trim()); return m ? parseFloat(m[1]) : null; }
// 从文本提取「行业均值 X」/「历史百分位 X%」式内嵌数值
function extract(text, re) { if (typeof text !== 'string') return null; const m = re.exec(text); return m ? parseFloat(m[1]) : null; }

function localDateStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// 同报告期（去年同期）配对：zyzbHistory 降序，latest vs 去年同月日
function samePeriodPair(zy, fields) {
  const fl = Array.isArray(fields) ? fields : [fields];
  const pick = (row) => { if (!row) return null; for (const k of fl) { const n = toNum(row[k]); if (n != null) return n; } return null; };
  if (!Array.isArray(zy) || !zy.length) return { cur: null, prev: null };
  const latest = zy[0];
  const ld = String(latest.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return { cur: pick(latest), prev: null };
  const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
  const prev = zy.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt);
  return { cur: pick(latest), prev: prev != null ? pick(prev) : null };
}

function newCheck(id, metric) {
  return { id, metric, status: 'missing', panels: [], note: '' };
}
// 兜底 0 哨兵（与 metricAnalysis ZERO_AS_MISSING 同口径）：比率/估值/增速类字段的 0
// 在生产端无法区分「真 0」与「取不到」（左卡显示 --）→ 巡检一律视为缺失，不参与互比。
function nz0(v) { return v === 0 ? null : v; }
function pushPanel(check, panel, value, caliber) {
  check.panels.push({ panel, value, caliber: caliber || null });
}

// 对一组同口径面板值做一致性判定：≥2 个值参与，全部一致→ok，否则 mismatch
function judgeSameCaliber(check, eps, unitLabel) {
  const vals = check.panels.filter(p => p.value != null);
  if (vals.length < 2) {
    check.status = 'missing';
    check.note = '可比数据不足（<2 个板块有值），如实跳过';
    return check;
  }
  const allEq = vals.every(p => near(p.value, vals[0].value, eps));
  if (allEq) {
    check.status = 'ok';
    check.note = `${vals.length} 个板块同口径（${unitLabel}）数值一致`;
  } else {
    check.status = 'mismatch';
    check.note = `同口径（${unitLabel}）数值不一致：` + vals.map(p => `${p.panel}=${p.value}`).join('，');
  }
  return check;
}

// 对「单季优先 vs 累计」双口径混合面板做判定：
// 每个面板值归类为 单季/累计/未知口径；同口径互比；归类失败才判 mismatch
function judgeDualCaliber(check, sqVal, cumVal, eps) {
  const vals = check.panels.filter(p => p.value != null);
  if (vals.length < 2 || (sqVal == null && cumVal == null)) {
    check.status = 'missing';
    check.note = '可比数据不足，如实跳过';
    return check;
  }
  let sqN = 0, cumN = 0, unknown = 0;
  for (const p of vals) {
    if (near(p.value, sqVal, eps)) { p.caliber = '单季优先同比'; sqN++; }
    else if (cumVal != null && near(p.value, cumVal, eps)) { p.caliber = '报告期累计同比'; cumN++; }
    else unknown++;
  }
  const mis = vals.filter(p => p.caliber === null);
  if (mis.length) {
    check.status = 'mismatch';
    check.note = `无法归类到任何已知口径（单季 ${sqVal == null ? '不可得' : sqVal + '%'} / 累计 ${cumVal == null ? '不可得' : cumVal + '%'}）：` + mis.map(p => `${p.panel}=${p.value}`).join('，');
  } else if (sqN >= 2 || cumN >= 2) {
    // 每种口径至少 2 个面板可互比且一致（同口径面板全部归类成功即视为一致）
    check.status = 'ok';
    check.note = `单季口径 ${sqN} 个 / 累计口径 ${cumN} 个，各自口径内一致（单季 ${sqVal}% vs 累计 ${cumVal}% 为正常口径差异）`;
  } else {
    check.status = 'ok';
    check.note = `各面板分属不同口径且均有归类：单季 ${sqVal == null ? '—' : sqVal + '%'} / 累计 ${cumVal == null ? '—' : cumVal + '%'}（单口径面板仅 1 个，无互比对象）`;
  }
  return check;
}

// ===== 单只股票巡检（纯函数，输入 /api/analysis 载荷）=====
function auditPayload(data) {
  const f = (data.quote && data.quote.fundamentals) || {};
  const quote = data.quote || {};
  const m = (data.fundamental && !data.fundamental.error && data.fundamental.metrics) || {};
  const ma = data.metricAnalysis || {};
  const maByKey = {};
  (Array.isArray(ma.metrics) ? ma.metrics : []).forEach(x => { maByKey[x.key] = x; });
  const sigByKey = {};
  ((data.signals && data.signals.signals) || []).forEach(x => { sigByKey[x.key] = x; });
  const zy = Array.isArray(f.zyzbHistory) ? f.zyzbHistory : [];
  const comp = data.comparison || {};
  const ind = comp.industryAvg || {};
  const pct = comp.percentiles || {};

  const checks = [];
  const P_LEFT = '左卡·关键财务指标';
  const P_TOP = '顶栏指标条（fundamental.metrics）';
  const P_RIGHT = '右卡·指标分析';
  const P_SIG = '信号卡（evaluateSignals）';
  const P_QUOTE = '行情 quote';

  // —— 1. PE / PB / PS：估值三件套（比率，eps=0.011 兼容两位小数显示）——
  {
    const c = newCheck('pe', '市盈率 PE(TTM)');
    pushPanel(c, P_LEFT, nz0(m.pe)); pushPanel(c, P_TOP, nz0(m.pe)); pushPanel(c, P_QUOTE, nz0(toNum(quote.pe)));
    pushPanel(c, P_RIGHT, numFrom(maByKey.pe && maByKey.pe.valueText));
    checks.push(judgeSameCaliber(c, 0.011, 'TTM 滚动'));
  }
  {
    const c = newCheck('pb', '市净率 PB');
    pushPanel(c, P_LEFT, nz0(m.pb)); pushPanel(c, P_QUOTE, nz0(toNum(quote.pb)));
    pushPanel(c, P_RIGHT, numFrom(maByKey.pb && maByKey.pb.valueText));
    checks.push(judgeSameCaliber(c, 0.011, '最新报告期 MRQ'));
  }
  {
    const c = newCheck('ps', '市销率 PS');
    pushPanel(c, P_LEFT, nz0(m.ps)); pushPanel(c, '顶栏指标条（fundamentals）', nz0(f.ps));
    pushPanel(c, P_RIGHT, numFrom(maByKey.ps && maByKey.ps.valueText));
    checks.push(judgeSameCaliber(c, 0.011, 'TTM/单期（按 psSource）'));
  }

  // —— 2. ROE：TTM 为主口径；左卡若为报告期累计（ROEJQ）则归 caliber ——
  {
    const c = newCheck('roe', 'ROE（净资产收益率）');
    const ttm = (f.roeTtm != null) ? f.roeTtm : null;
    const roejq = samePeriodPair(zy, 'ROEJQ').cur;
    pushPanel(c, '顶栏/右卡口径（roeTtm）', ttm, ttm != null ? 'TTM 滚动' : null);
    // 左卡 m.roe：先按 TTM 归类，不中再按报告期累计归类
    if (nz0(m.roe) != null) pushPanel(c, P_LEFT, nz0(m.roe), near(nz0(m.roe), ttm, 0.05) ? 'TTM 滚动' : (near(nz0(m.roe), roejq, 0.05) ? '报告期累计(ROEJQ)' : null));
    pushPanel(c, P_RIGHT, pctFrom(maByKey.roe && maByKey.roe.valueText), 'TTM 滚动');
    const sigRoe = sigByKey.roe ? pctFrom(sigByKey.roe.value) : null;
    pushPanel(c, P_SIG, sigRoe, 'TTM 滚动');
    const ttmPanels = c.panels.filter(p => p.value != null && p.caliber === 'TTM 滚动');
    const other = c.panels.filter(p => p.value != null && p.caliber && p.caliber !== 'TTM 滚动');
    const unclassified = c.panels.filter(p => p.value != null && p.caliber === null);
    if (unclassified.length) {
      c.status = 'mismatch';
      c.note = '存在无法归类到 TTM/报告期累计任一口径的展示值：' + unclassified.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length >= 2 && !ttmPanels.every(p => near(p.value, ttmPanels[0].value, 0.05))) {
      c.status = 'mismatch';
      c.note = 'TTM 口径各板块数值不一致：' + ttmPanels.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length + other.length < 2) {
      c.status = 'missing'; c.note = '可比数据不足，如实跳过';
    } else {
      c.status = 'ok';
      c.note = `TTM 口径 ${ttmPanels.length} 个板块一致` + (other.length ? `；另有 ${other.map(p => `${p.panel}=${p.value}(${p.caliber})`).join('，')}（与 TTM 属正常口径差异）` : '');
    }
  }

  // —— 3. 毛利率 / 净利率：TTM 为主口径，报告期累计（XSMLL/XSJLL）归 caliber ——
  [['grossMargin', '毛利率', 'XSMLL'], ['netMargin', '净利率', 'XSJLL']].forEach(([key, label, zyField]) => {
    const c = newCheck(key, label);
    const ttm = (f[key + 'Ttm'] != null) ? f[key + 'Ttm'] : null;
    const cum = samePeriodPair(zy, zyField).cur;
    pushPanel(c, '顶栏/右卡口径（' + key + 'Ttm）', ttm, ttm != null ? 'TTM 滚动' : null);
    if (nz0(m[key]) != null) pushPanel(c, P_LEFT, nz0(m[key]), near(nz0(m[key]), ttm, 0.05) ? 'TTM 滚动' : (near(nz0(m[key]), cum, 0.05) ? '报告期累计(' + zyField + ')' : null));
    pushPanel(c, P_RIGHT, pctFrom(maByKey[key] && maByKey[key].valueText), 'TTM 滚动');
    const ttmPanels = c.panels.filter(p => p.value != null && p.caliber === 'TTM 滚动');
    const other = c.panels.filter(p => p.value != null && p.caliber && p.caliber !== 'TTM 滚动');
    const unclassified = c.panels.filter(p => p.value != null && p.caliber === null);
    if (unclassified.length) {
      c.status = 'mismatch';
      c.note = '存在无法归类到 TTM/报告期累计任一口径的展示值：' + unclassified.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length >= 2 && !ttmPanels.every(p => near(p.value, ttmPanels[0].value, 0.05))) {
      c.status = 'mismatch';
      c.note = 'TTM 口径各板块数值不一致：' + ttmPanels.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length + other.length < 2) {
      c.status = 'missing'; c.note = '可比数据不足，如实跳过';
    } else {
      c.status = 'ok';
      c.note = `TTM 口径 ${ttmPanels.length} 个板块一致` + (other.length ? `；另有 ${other.map(p => `${p.panel}=${p.value}(${p.caliber})`).join('，')}（与 TTM 属正常口径差异，右卡已有口径说明）` : '');
    }
    checks.push(c);
  });

  // —— 4. 成长三指标：单季优先同比（DJD_*）vs 累计同比（*_TZ），混合口径归类判定 ——
  const growthDefs = [
    { id: 'growth', label: '营收增长', sigKey: 'growth', djd: ['DJD_TOI_YOY', 'TOTALOPERATEREVETZ'], cumTz: 'TOTALOPERATEREVETZ', mKeys: ['revenueGrowth'], fKey: 'revenueYoy', leftKeys: ['revenueGrowth'] },
    { id: 'profitGrowth', label: '利润增长', sigKey: 'profitGrowth', djd: ['DJD_DPNP_YOY', 'PARENTNETPROFITTZ'], cumTz: 'PARENTNETPROFITTZ', mKeys: ['profitGrowth'], fKey: 'profitYoy', leftKeys: ['profitGrowth'] },
    { id: 'dedProfitGrowth', label: '扣非净利润增长', sigKey: 'dedProfitGrowth', djd: ['DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ'], cumTz: 'KCFJCXSYJLRTZ', mKeys: ['deductedProfitGrowth'], fKey: null, leftKeys: ['deductedProfitGrowth'] },
  ];
  for (const g of growthDefs) {
    const c = newCheck(g.id, g.label);
    const sq = samePeriodPair(zy, g.djd).cur;            // 单季优先同比（权威口径）
    const cum = samePeriodPair(zy, g.cumTz).cur;         // 报告期累计同比
    const leftVal = g.leftKeys.map(k => nz0(m[k])).find(v => v != null) || (g.fKey ? nz0(f[g.fKey]) : null) || null;
    if (leftVal != null) pushPanel(c, P_LEFT, leftVal);
    pushPanel(c, P_RIGHT, pctFrom(maByKey[g.id] && maByKey[g.id].valueText));
    pushPanel(c, P_SIG, sigByKey[g.sigKey] ? pctFrom(sigByKey[g.sigKey].value) : null);
    checks.push(judgeDualCaliber(c, sq, cum, 0.05));
  }

  // —— 5. 营运利润：单季 / 累计分列核对（单季=本期累计−上期累计，绝不能与累计互比）——
  if (data.opProfit && data.opProfit.cur && typeof data.opProfit.cur.opProfitYi === 'number') {
    const op = data.opProfit;
    {
      const c = newCheck('opProfitSq', '营运利润·单季');
      pushPanel(c, '取数（sqCur=本期累计−上期累计）', op.sqCur ? op.sqCur.opProfitYi : null, '单季');
      pushPanel(c, P_RIGHT, yiFrom(maByKey.opProfit && maByKey.opProfit.valueText), '单季（右卡 useSq 时）');
      checks.push(judgeSameCaliber(c, 0.011, '单季'));
      if (c.status === 'missing' && op.sqCur) { c.status = 'ok'; c.note = '单季取数存在；右卡展示值取不到（可能回退累计口径），见 opProfitCum 项'; }
      if (c.status === 'missing' && !op.sqCur) { c.status = 'missing'; c.note = '单季值不可得（缺上期累计），右卡已如实回退累计口径'; }
    }
    {
      const c = newCheck('opProfitCum', '营运利润·累计');
      pushPanel(c, '取数（cur）', op.cur.opProfitYi, '报告期累计');
      const sqYi = op.sqCur ? op.sqCur.opProfitYi : null;
      c.status = 'ok';
      c.note = `累计 ${op.cur.opProfitYi}亿（${op.cur.date}）与单季 ${sqYi == null ? '不可得' : sqYi + '亿'} 属不同口径，分列展示正确（不互比）`;
      checks.push(c);
    }
  }

  // —— 6. NBV（保险股专属）：累计口径，取数 vs 右卡展示 ——
  if (data.insuranceNBV && typeof data.insuranceNBV.valueYi === 'number') {
    const c = newCheck('nbv', 'NBV(新业务价值)');
    pushPanel(c, '取数（INSURANCE_REAL_DATA 备查库）', data.insuranceNBV.valueYi, '累计');
    pushPanel(c, P_RIGHT, yiFrom(maByKey.nbv && maByKey.nbv.valueText), '累计');
    checks.push(judgeSameCaliber(c, 0.011, '累计'));
  }

  // —— 7. 行业均值 / 历史百分位：comparison 权威值 vs 右卡维度文本内嵌数值 ——
  {
    const c = newCheck('indRoe', '行业均值 ROE（右卡维度文本 vs comparison 权威值）');
    pushPanel(c, 'comparison.industryAvg', (ind.roe != null) ? ind.roe : null);
    const dimText = (maByKey.roe && maByKey.roe.dims && maByKey.roe.dims.industry) ? maByKey.roe.dims.industry.text : null;
    pushPanel(c, P_RIGHT + '（维度文本）', extract(dimText, /行业均值 (-?[\d.]+)/));
    checks.push(judgeSameCaliber(c, 0.011, '行业均值'));
  }
  {
    const c = newCheck('pctRoe', '历史百分位 ROE（右卡维度文本 vs comparison 权威值）');
    pushPanel(c, 'comparison.percentiles', (pct.roe != null) ? pct.roe : null);
    const dimText = (maByKey.roe && maByKey.roe.dims && maByKey.roe.dims.pct) ? maByKey.roe.dims.pct.text : null;
    pushPanel(c, P_RIGHT + '（维度文本）', extract(dimText, /历史\s?(\d+)%/));
    checks.push(judgeSameCaliber(c, 0.5, '历史百分位'));
  }

  const summary = { total: checks.length, ok: 0, caliber: 0, mismatch: 0, missing: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;

  return {
    symbol: data.symbol,
    name: data.name || (data.quote && data.quote.name) || '',
    checkedAt: new Date().toISOString(),
    health: summary.mismatch > 0 ? 'warn' : 'ok',
    summary,
    checks,
  };
}

// ===== 持久化 =====
function ensureDir() { fs.mkdirSync(AUDIT_DIR, { recursive: true }); }
function saveAuditReport(report) {
  ensureDir();
  const file = path.join(AUDIT_DIR, `${report.date}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}
function loadAuditReport(date) {
  const file = path.join(AUDIT_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function listAuditReports(limit = 30) {
  ensureDir();
  return fs.readdirSync(AUDIT_DIR).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))
    .sort().reverse().slice(0, limit).map(x => x.replace('.json', ''));
}

// ===== 远端自调用取载荷（与 analysisWarm 预热同机制）=====
function fetchJson(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('JSON 解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== 每日巡检：对标的清单逐只自调用载荷并核对，落盘合并报告 =====
async function runDailyAudit({ port = 3005, symbols = [], gapMs = 800 } = {}) {
  const results = [];
  for (const s of symbols) {
    const sym = (typeof s === 'string') ? s : s.symbol;
    const nm = (typeof s === 'string') ? '' : (s.name || '');
    try {
      const payload = await fetchJson(`http://127.0.0.1:${port}/api/analysis/${encodeURIComponent(sym)}`);
      results.push(auditPayload(payload));
    } catch (e) {
      results.push({ symbol: sym, name: nm, error: e.message, health: 'error', summary: { total: 0, ok: 0, caliber: 0, mismatch: 0, missing: 0 }, checks: [] });
    }
    await sleep(gapMs);
  }
  const totals = results.reduce((acc, r) => {
    acc.ok += (r.summary && r.summary.ok) || 0;
    acc.caliber += (r.summary && r.summary.caliber) || 0;
    acc.mismatch += (r.summary && r.summary.mismatch) || 0;
    acc.missing += (r.summary && r.summary.missing) || 0;
    return acc;
  }, { ok: 0, caliber: 0, mismatch: 0, missing: 0 });
  const report = {
    date: localDateStr(),
    ranAt: new Date().toISOString(),
    symbolCount: results.length,
    health: totals.mismatch > 0 ? 'warn' : 'ok',
    totals,
    results,
  };
  saveAuditReport(report);
  return report;
}

module.exports = { auditPayload, runDailyAudit, saveAuditReport, loadAuditReport, listAuditReports, AUDIT_DIR };
