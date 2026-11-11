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
// [20261110f] Context 结构新增 history.stockMarks（大盘观察池个股的个股复盘信号汇总，反向联动），
// 属结构变更 → 升 review-llm-20261110c，强制生成一次新版报告。
// [20261111] Context 结构再新增 history.dailyReviews（过去 1-3 日大盘复盘预判摘要，供历史自省第 8 节）
// → 升 review-llm-20261111a，强制既有报告重新生成以带出第 8 节（同 B0-3 先例）。
// [20261111b] 引擎候选对象新增 sectorPosition / gradeLabel / trialGrade（板块地位评级覆盖：退潮期保底 B（试错）/C（观察），禁空白）
// → 升 review-llm-20261111b，强制重算候选评级语义字段。
const SCHEMA_VERSION = 'review-llm-20261111b';
const CONTEXT_VERSION = 'review-context-20261111b';
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
    // 20261110g P0-3：代理口径轻量打标（零 require；前端按 PROXY_REGISTRY 展开角标）
    proxyKeys: ok ? ['lhb-keyword'] : undefined,
  };
}

const CANDIDATE_KEYS = ['name', 'code', 'grade', 'gradeLabel', 'sectorPosition', 'trialGrade', 'category', 'quadrant', 'drivers',
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
/**
 * [20261110f B0-3] 大盘观察池个股的「个股每日复盘」信号汇总（反向联动）。
 * 只带计数与枚举（rating/giveupTriggered），不带个股复盘正文，避免 Context 膨胀与信息重复。
 */
function compactStockMarks(sm) {
  if (!sm || !sm.total) return { poolDate: null, total: 0, reviewed: 0, giveupTriggered: 0, rows: [] };
  return {
    poolDate: sm.poolDate || null,
    total: sm.total == null ? null : sm.total,
    reviewed: sm.reviewed == null ? null : sm.reviewed,
    giveupTriggered: sm.giveupTriggered == null ? null : sm.giveupTriggered,
    rows: briefList(sm.rows, ['name', 'code', 'rating', 'giveupTriggered', 'hasReview'], 12),
  };
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
    // 末位兜底：若前述裁剪仍超预算，再压历史自省摘要（仅砍明细与限长，不改写数值）
    () => { o.history.dailyReviews = (o.history.dailyReviews || []).slice(0, 2).map(r => ({
      ...r, emotion: (r.emotion || '').slice(0, 200),
      topicRatings: (r.topicRatings || []).slice(0, 4),
      verifySignals: (r.verifySignals || []).slice(0, 4),
    })); },
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
      // [20261110f B0-3] 反向联动：上一份大盘复盘观察池个股的个股复盘信号汇总
      stockMarks: compactStockMarks(a.stockMarks),
      // [20261111] 历史预判核查：过去 1-3 个交易日大盘复盘预判摘要（代码注入，LLM 只做归因与叙事）
      dailyReviews: Array.isArray(a.dailyReviews) ? a.dailyReviews.slice(0, 3).map(r => ({
        date: r.date || null,
        emotion: r.emotion ? String(r.emotion).slice(0, 300) : null,
        topicRatings: Array.isArray(r.topicRatings) ? r.topicRatings.slice(0, 6) : [],
        verifySignals: Array.isArray(r.verifySignals) ? r.verifySignals.slice(0, 6) : [],
      })) : [],
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
