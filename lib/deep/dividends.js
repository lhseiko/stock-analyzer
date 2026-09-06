/**
 * lib/deep/dividends.js —— deepAnalysis 领域子模块：分红抓取/校准/阶段判定 + SQLite 持久化
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * classifyDividendStage/dividendLabel（单一展示口径）被本模块与 deep/pipeline 共用；
 * aggregateAnnualDPS 供 deep/yield 复用。
 */
const axios = require('axios');
const db = require('../db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）
const { UA } = require('./shared');

// Fetch dividend data (uses datacenter API which works reliably)
async function fetchDividends(code) {
  const stockCode = code.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=60&pageNumber=1&reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    if (resp.data && resp.data.result && resp.data.result.data) {
      const rows = resp.data.result.data.map(d => ({
        year: d.REPORT_DATE ? d.REPORT_DATE.slice(0, 4) : '',
        reportDate: d.REPORT_DATE || '',
        plan: d.IMPL_PLAN_PROFILE || '',
        // PRETAX_BONUS_RMB is per 10 shares (e.g. 17.5 means 1.75 per share)
        dividendPerShare: (parseFloat(d.PRETAX_BONUS_RMB) || 0) / 10,
        // Total dividend amount = perShare * totalShares
        totalShares: d.TOTAL_SHARES || 0,
        dividend: (parseFloat(d.PRETAX_BONUS_RMB) || 0) / 10 * (d.TOTAL_SHARES || 0),
        recordDate: d.EQUITY_RECORD_DATE || '',
        exDate: d.EX_DIVIDEND_DATE || '',
        progress: d.ASSIGN_PROGRESS || '',
      })).filter(d => d.year);
      // 东方财富分红表未收录中国平安 2018 年 30 周年特别股息，按公司公告补充
      return calibrateDividends(code, rows);
    }
  } catch (e) {
    console.error('Dividend data failed:', e.message);
  }
  return [];
}

// 对已知数据源缺失的分红记录做校准补充（仅针对公开公告中明确存在的特别股息）
function calibrateDividends(code, rows) {
  const normalized = code.toUpperCase().replace(/^(SH|SZ)/, '');
  // 中国平安 601318：2018 年 6 月 7 日派发 30 周年特别股息每股 0.20 元（含税）
  if (normalized === '601318') {
    const has2018Special = rows.some(d => d.year === '2018' && d.exDate && d.exDate.startsWith('2018-06-07') && Math.abs(d.dividendPerShare - 0.2) < 0.001);
    if (!has2018Special) {
      rows.push({
        year: '2018',
        plan: '10派2元(含税) 30周年特别股息',
        dividendPerShare: 0.2,
        totalShares: 0,
        dividend: 0,
        recordDate: '2018-06-06',
        exDate: '2018-06-07',
        progress: '已实施',
        _calibrated: true,
      });
    }
  }
  return rows;
}

// 分红阶段判定（规则一：单一展示口径）—— 由 REPORT_DATE 月份决定中报/年报，plan 含"特别"为特别股息。
// 同时被 dividendPayouts（前端展示）与 DB 持久化（loadDividendSeries）复用，保证同一指标只此一处逻辑。
function classifyDividendStage(reportDate, plan) {
  const reportMonth = (reportDate || '').slice(5, 7);
  let stage = '年度';
  if (reportMonth === '06') stage = '中期';
  else if (/特别/.test(plan || '')) stage = '特别';
  return stage;
}
function dividendLabel(year, stage) {
  return stage === '年度' ? `${year}年报` : stage === '中期' ? `${year}年中报` : `${year}年${stage}`;
}

// 规范化股票代码：去掉 SH/SZ/BJ 前缀，统一以数字代码作为 DB 主键（避免 sh601318 / 601318 双份）。
function normalizeSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
}

// 把分红原始记录落地到本地 SQLite（规则一·五要素 + 规则三·时序）。
// rows 来自 fetchDividends（已是「单一权威来源」），这里只做存储，不二次取数。
function persistDividends(symbol, emCode, rows) {
  try {
    const norm = normalizeSymbol(emCode || symbol);
    if (!norm || !rows || !rows.length) return;
    const SRC = 'eastmoney:RPT_SHAREBONUS_DET';
    for (const r of rows) {
      const asOf = r.reportDate || r.exDate || '';
      const stage = classifyDividendStage(r.reportDate, r.plan);
      const extra = {
        year: r.year,
        stage,
        label: dividendLabel(r.year, stage),
        plan: r.plan || '',
        progress: r.progress || '',
        isPending: !/实施|派发|派息/.test(r.progress || ''),
        exDate: r.exDate || '',
        recordDate: r.recordDate || '',
        source: SRC,
      };
      db.upsertSeries({ symbol: norm, metric: 'dividend_per_share', asOf, value: r.dividendPerShare || 0, source: SRC, extra });
      db.upsertSeries({ symbol: norm, metric: 'dividend_total_yi', asOf, value: r.dividend || 0, source: SRC, extra });
    }
    console.log(`[DB] persisted ${rows.length} dividend records for ${norm}`);
  } catch (e) {
    console.error('[DB] persistDividends failed:', e.message);
  }
}

// 从 SQLite 读回分红时序，并直接附上 变化率 + 边际变化（规则三），前端/接口无需再算。
function loadDividendSeries(symbol) {
  const norm = normalizeSymbol(symbol);
  const perShare = db.getSeriesWithMarginal(norm, 'dividend_per_share');
  const total = db.getSeries(norm, 'dividend_total_yi');
  const totalMap = new Map(total.map((t) => [t.as_of, t.value]));
  return perShare.map((r) => {
    const e = r.extra || {};
    return {
      asOf: r.as_of,
      year: e.year,
      label: e.label,
      stage: e.stage,
      perShare: r.value,
      amountYi: totalMap.has(r.as_of) ? totalMap.get(r.as_of) : null,
      plan: e.plan,
      progress: e.progress,
      isPending: e.isPending,
      exDate: e.exDate,
      changePct: r.changePct,
      marginal: r.marginal,
      direction: r.direction,
      source: r.source,
      fetchedAt: r.fetched_at,
    };
  });
}

// 把估值核心标量（PE/PB/PS 最新值）落地到 data_points（规则一·五要素 + 规则二·TTL）。
// 单一数据源：valuationHub 的 latest（每条已带 value/dataTime/source/fetchTime），兜底用 analyzeValuation 的 currentPeTtm。
// 每个指标只用一个 key（pe_ttm / pb_mrq / ps_ttm），避免同指标双源。
function persistValuationScalars(symbol, emCode, valuation) {
  try {
    const norm = normalizeSymbol(emCode || symbol);
    if (!norm || !valuation) return;
    const ttl = 'financial';
    const rules = valuation.rules;
    const hub = rules && rules.latest;
    if (hub && hub.pe && typeof hub.pe.value === 'number' && hub.pe.value > 0) {
      db.upsertDataPoint({
        symbol: norm, key: 'pe_ttm', value: hub.pe.value,
        asOf: hub.pe.dataTime || null, source: hub.pe.source || (rules.source) || '东方财富TTM',
        ttlType: ttl, extra: { fetchTime: hub.pe.fetchTime },
      });
    } else if (valuation.currentPeTtm > 0) {
      db.upsertDataPoint({
        symbol: norm, key: 'pe_ttm', value: valuation.currentPeTtm,
        asOf: null, source: valuation.peSource || '东方财富TTM', ttlType: ttl,
      });
    }
    if (hub) {
      const map = { pb: 'pb_mrq', ps: 'ps_ttm' };
      for (const k of Object.keys(map)) {
        const d = hub[k];
        if (d && typeof d.value === 'number' && d.value > 0) {
          db.upsertDataPoint({
            symbol: norm, key: map[k], value: d.value,
            asOf: d.dataTime || null, source: d.source || (rules.source) || '东方财富TTM',
            ttlType: ttl, extra: { fetchTime: d.fetchTime },
          });
        }
      }
    }
    console.log(`[DB] persisted valuation scalars for ${norm}`);
  } catch (e) {
    console.error('[DB] persistValuationScalars failed:', e.message);
  }
}

// 聚合每年每股分红（中国平安等中期+末期多次分红，按 REPORT_DATE 年份汇总）
function aggregateAnnualDPS(dividends) {
  const map = {};
  for (const d of (dividends || [])) {
    if (!d.year) continue;
    const dps = parseFloat(d.dividendPerShare) || 0;
    map[d.year] = (map[d.year] || 0) + dps;
  }
  return map; // { '2025': 1.5, ... }
}

module.exports = { fetchDividends, calibrateDividends, classifyDividendStage, dividendLabel, normalizeSymbol, persistDividends, loadDividendSeries, persistValuationScalars, aggregateAnnualDPS };
