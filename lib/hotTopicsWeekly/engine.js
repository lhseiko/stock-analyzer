/**
 * 板块舆情热度周榜 · 周聚合计算引擎（20260909m）
 * --------------------------------------------------------------
 * 流程：本周已有每日采集文件 → 帖子/快讯按 id 去重 → 五项原始指标（A 舆情曝光 / B 社区讨论 /
 * C 韭菜讨论 / D 舆情情感 / E 社区情感）→ Min-Max 归一化(A/B/C) → 加权基础分 →
 * 三路交叉验证修正(5 组合，外部输入=行业5日涨幅/主力5日净占比/归一化A、B) →
 * 热度等级 + 情绪标签 + 告警 → 降序榜单。
 *
 * 铁律：全部确定性代码计算，无 LLM；股吧通道缺失时自动降级（权重重分配并在 meta 标注）。
 * 口径：A=本周归属快讯条数（快讯无曝光量字段，以条数为代理指标）；B=股吧帖子累计增量+
 *       采样帖浏览/评论之和；C=采样帖中韭菜句式帖数；D/E=看多占比(%)。
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

  // 4) 社区帖子聚合（跨日按 post_id 去重；置顶帖不计入 B/C/E 采样）
  let gubaOkDays = 0;
  for (const d of dailies) {
    const guba = d.data.guba || {};
    const dayOk = guba.status === 'ok';
    if (dayOk && guba.boards && Object.keys(guba.boards).length) gubaOkDays++;
    for (const [code, bd] of Object.entries(guba.boards || {})) {
      const a = agg.get(code);
      if (!a) continue;
      if (bd.count != null) a.countByDate.set(d.date, bd.count);
      for (const p of (bd.posts || [])) {
        if (!p.id || a.posts.has(p.id)) continue;
        a.posts.set(p.id, p);
        if (p.pinned) continue;
        if (!isSpam(p.title)) {
          a.clicks += p.clicks || 0;
          a.comments += p.comments || 0;
          if (isRookiePost(p.title)) a.rookie++;
          const sent = classifySentiment(p.title);
          a.gubaTotal++;
          if (sent === 'bullish') a.gubaBull++;
          else if (sent === 'bearish') a.gubaBear++;
        }
      }
    }
  }

  // 5) 原始指标
  for (const [code, a] of agg) {
    // B 的帖子增量：相邻有效日 count 差值之和；单日 → 采样帖数近似
    const dates = [...a.countByDate.keys()].sort();
    let delta = null;
    if (dates.length >= 2) {
      delta = 0;
      for (let i = 1; i < dates.length; i++) delta += Math.max(0, a.countByDate.get(dates[i]) - a.countByDate.get(dates[i - 1]));
    } else if (dates.length === 1) {
      delta = a.posts.size; // 首日种子：采样帖数近似（口径见 README）
    }
    a.B_raw = (delta != null || a.clicks || a.comments) ? (delta || 0) + a.clicks + a.comments : 0;
    a.A_raw = a.newsCount;
    a.C_raw = a.rookie;
    a.D_raw = a.newsTotal ? (a.newsBull / a.newsTotal) * 100 : null;
    a.E_raw = a.gubaTotal ? (a.gubaBull / a.gubaTotal) * 100 : null;
  }

  // 6) 榜单池：任一指标有值的板块
  const universe = [...agg.entries()].filter(([, a]) => (a.A_raw || 0) > 0 || (a.B_raw || 0) > 0 || (a.C_raw || 0) > 0);

  // 7) 归一化（A/B/C 计数型 Min-Max；D/E 本身 0~100 百分比，保留绝对口径）
  const A_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.A_raw])));
  const B_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.B_raw])));
  const C_n = minMaxNormalize(new Map(universe.map(([c, a]) => [c, a.C_raw])));

  // 8) 通道可用性 → 权重（降级重分配）
  const gubaAvailable = gubaOkDays > 0;
  const w = gubaAvailable ? cfg.weights : cfg.degradeWeights;

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
      gubaAvailable,
      gubaOkDays,
      marketRows: marketRows.length,
      weightsUsed: w,
      degradeMode: !gubaAvailable,
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { computeWeekly, isoWeekKey, weekDatesUntilToday, fmtDate };
