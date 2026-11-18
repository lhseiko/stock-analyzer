/**
 * lib/goodwill.js — 商誉指标确定性计算（20261117a · 任务卡 #018）
 * ============================================================================
 * 用户裁决（2026-11-17）：
 *   ① 取最新一期资产负债表（东财 F10 zcfzbAjaxNew），不是只取年报；
 *   ② 分母用归母净资产 TOTAL_PARENT_EQUITY，与 PB / 深度分析同源；
 *   ③ 信号阈值：商誉/归母净资产 <5% 利好、5%~10%（含边界）中性、>10% 利空；
 *   ④ 没有商誉 = 数值 0、占比 0%，按 <5% 档处理，得 5 分；
 *   ⑤ 财务健康 25 分改为五项各 5 分，本模块只出判定与分值，不碰评分引擎。
 *
 * 设计铁律：纯函数、零网络、零 LLM、零估算。数据缺失如实返回 available=false，
 * 下游沿用现有「-- / 不参与评分 / 风险提示」规则。
 */
'use strict';

const YI = 1e8;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return (isFinite(n)) ? n : null;
}

function localDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (!x || isNaN(x.getTime())) return '';
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

/** 阈值判定：边界 5% 与 10% 都归中性档；0% 归利好档（无商誉） */
function classifyRatio(ratio) {
  const r = num(ratio);
  if (r == null || r < 0) {
    return { tier: 'unavailable', signal: null, score: null, label: '不可得', reason: '商誉占归母净资产比例不可得（归母净资产非正或数据缺失），不参与评分' };
  }
  if (r === 0) {
    return { tier: 'none', signal: 'bull', score: 5, label: '无商誉', reason: '最新一期资产负债表无商誉科目或商誉为 0，按 0% 计入 <5% 档：无商誉减值风险，得 5 分' };
  }
  if (r < 5) {
    return { tier: 'low', signal: 'bull', score: 5, label: '利好', reason: `商誉占归母净资产 ${r.toFixed(2)}% < 5%，商誉减值对财务健康的威胁相对可控，得 5 分` };
  }
  if (r <= 10) {
    return { tier: 'middle', signal: 'neutral', score: 3, label: '中性', reason: `商誉占归母净资产 ${r.toFixed(2)}% 处于 5%~10%（含边界）中性区间，需持续关注并购标的业绩，得 3 分` };
  }
  return { tier: 'high', signal: 'bear', score: 0, label: '利空', reason: `商誉占归母净资产 ${r.toFixed(2)}% > 10%，并购减值会直接冲减利润与净资产，财务健康得 0 分` };
}

function round2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

/** 不可用结果（统一出口，便于下游判空） */
function unavailable(reason) {
  return {
    available: false,
    reason: reason || '最新一期资产负债表取数失败，商誉不可得',
    goodwillYi: null, netAssetsYi: null, totalAssetsYi: null,
    ratio: null, ratioRaw: null, assetRatio: null, priorRatio: null, prevPeriodRatio: null,
    date: null, reportName: '', signal: null, score: null, tier: 'unavailable',
    source: '东方财富 F10 资产负债表（zcfzbAjaxNew）',
  };
}

/**
 * 从资产负债表行组中取最新一期商誉快照。
 * @param {Array} rows 东财 zcfzbAjaxNew 返回行（可含年报+季报，顺序不限）
 * @param {object} opts { today: 'YYYY-MM-DD'|Date }
 */
function fromBalanceRows(rows, opts) {
  const o = opts || {};
  const todayStr = localDate(o.today || new Date());
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && r.REPORT_DATE)
    .map(r => ({ row: r, date: String(r.REPORT_DATE).slice(0, 10) }))
    .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && (!todayStr || x.date <= todayStr))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return unavailable('资产负债表无有效报告期（或全部晚于今天）');

  const picked = list.find(x => {
    const na = num(x.row.TOTAL_PARENT_EQUITY);
    return na != null && na > 0;
  });
  if (!picked) return unavailable('最新一期资产负债表归母净资产不可得或非正，商誉占比无法计算');

  const row = picked.row;
  const netAssetsRaw = num(row.TOTAL_PARENT_EQUITY);
  const totalAssetsRaw = num(row.TOTAL_ASSETS);
  const goodwillRaw = num(row.GOODWILL);
  const noGoodwill = goodwillRaw == null || goodwillRaw === 0;

  const goodwillYi = noGoodwill ? 0 : goodwillRaw / YI;
  const netAssetsYi = netAssetsRaw / YI;
  const totalAssetsYi = (totalAssetsRaw != null && totalAssetsRaw > 0) ? totalAssetsRaw / YI : null;
  const ratioRaw = goodwillYi / netAssetsYi * 100;
  const cls = classifyRatio(ratioRaw);

  // 去年同期同报告期占比：仅用于左卡「去年同期」提示，不参与评分
  const target = (parseInt(picked.date.slice(0, 4), 10) - 1) + picked.date.slice(4);
  const prev = list.find(x => x.date === target && num(x.row.TOTAL_PARENT_EQUITY) > 0);
  let priorRatio = null;
  if (prev) {
    const pg = num(prev.row.GOODWILL);
    priorRatio = ((pg == null ? 0 : pg) / num(prev.row.TOTAL_PARENT_EQUITY)) * 100;
  }
  // 上一披露期（最近一个更早报告期）占比：供右卡「环比」维度，仍不参与评分
  const prevPeriod = list.find(x => x.date < picked.date && num(x.row.TOTAL_PARENT_EQUITY) > 0);
  let prevPeriodRatio = null;
  if (prevPeriod) {
    const pg2 = num(prevPeriod.row.GOODWILL);
    prevPeriodRatio = ((pg2 == null ? 0 : pg2) / num(prevPeriod.row.TOTAL_PARENT_EQUITY)) * 100;
  }

  return {
    available: true,
    noGoodwill,
    goodwillYi: round2(goodwillYi),
    netAssetsYi: round2(netAssetsYi),
    totalAssetsYi: round2(totalAssetsYi),
    ratio: round2(ratioRaw),
    ratioRaw,
    assetRatio: totalAssetsYi != null ? round2(goodwillYi / totalAssetsYi * 100) : null,
    priorRatio: round2(priorRatio),
    prevPeriodRatio: round2(prevPeriodRatio),
    date: picked.date,
    reportName: row.REPORT_DATE_NAME || '',
    signal: cls.signal,
    score: cls.score,
    tier: cls.tier,
    reason: cls.reason,
    source: '东方财富 F10 资产负债表（zcfzbAjaxNew）',
  };
}

module.exports = { classifyRatio, fromBalanceRows, unavailable, round2, YI };
