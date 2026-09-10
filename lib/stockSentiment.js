/**
 * 单只 A 股个股全网红情分析模块 · 计算层（20260910）
 * --------------------------------------------------------------
 * 职责边界（严格遵守用户规格）：
 *   本模块「不抓取网络数据」，只消费前置采集层/其他业务模块传入的结构化输入：
 *     · stockDiscussion  同花顺讨论 API 采集的原始帖（sentiment.py 已采集）
 *     · discussionHeat   同花顺热榜/雪球关注榜/东财股吧 聚合热度（sentiment.py 已采集）
 *     · newsSentiment    个股新闻情感（sentiment.py；本机 curl_cffi 受限时 ok=false）
 *     · quote/capital/turnoverChange  行情、主力资金、换手率（工作台其他模块传入，仅用于交叉校验）
 *   本模块只做：实体过滤 → 垃圾过滤 → 情感标注 → 散户/KOL 识别 → 时间衰减加权 →
 *   五指标(A/B/C/D/E) → 归一化 → 加权综合分 → 四路外部数据交叉校验 → 标签/告警 → 简报/结论。
 *   全部为确定性代码（1+1=2），不调用 LLM。
 *
 * 诚实降级（本机环境限制）：
 *   · A(全网资讯曝光) / D(专业舆情情感) 依赖新闻/研报源，本机 curl_cffi 被系统策略拦截 → 缺失，权重自动重分配；
 *   · C(散户) / KOL 判定缺账号注册时长/粉丝数据 → 用句式词典 / 认证大V(is_v) 近似，已在 degrade 标注；
 *   · 行业样本池 Min-Max 归一化暂不可用 → 采用「绝对基准曲线」并在 normalizationBasis 标注。
 */
'use strict';

const { classifySentiment, isRookiePost, isSpam } = require('./hotTopicsWeekly/nlp');

// ---------- 可调参数（规格要求：权重/阈值/告警全部支持人工修改） ----------
const CFG = {
  // 基础综合分权重（规格原值）；A/D 缺失时自动在可用指标间重分配
  weights: { A: 0.35, B: 0.35, D: 0.15, E: 0.15 },
  // 热度等级阈值：≥75 高热 / 60~74.9 偏热 / 40~59.9 平稳 / <40 冷清
  heat: { hot: 75, warm: 60, calm: 40 },
  // 告警：归一化散户指标 ≥90 且 最终综合分 ≥70
  alert: { rookieNorm: 90, finalScore: 70 },
  sampleMin: 8,                 // 有效帖 < 该值 → 标注「样本偏少，分数参考性下降」
  // 绝对基准归一化曲线（行业样本池不可用时的替代；点位经讨论量级校准，可人工调整）
  scaleB: [[0, 0], [15, 30], [45, 55], [120, 75], [300, 100]], // B=社区讨论量
  scaleC: [[0, 0], [3, 45], [10, 75], [20, 100]],               // C=散户帖数
  // 四路交叉校验阈值
  cross: {
    mainNetBigPct: 1.5,    // |5日主力净额/流通市值| ≥ 1.5% 视为「大幅」
    mainNetSmallPct: 1.5,  // 同口径的「小幅」上界
    bigRisePct: 5,         // 日涨跌幅 ≥5% 视为「大幅上涨」
    divergenceGap: 15,     // 多空占比差 <15 且两方均 >20% → 分歧
    divergenceMin: 20,
  },
};

// 简报用正/负面关键词（确定性词典，与 nlp.js 情绪词典解耦，仅用于展示）
const POS_KW = ['涨停', '大涨', '利好', '增持', '买入', '加仓', '净买入', '回暖', '增长', '盈利', '上调',
  '突破', '拉升', '走强', '回购', '中标', '超预期', '预增', '净流入', '机构看好', '看好', '扩产',
  '签单', '扭亏', '新高', '订单增长', '产能释放', '景气', '供不应求', '涨价'];
const NEG_KW = ['跌停', '大跌', '利空', '减持', '卖出', '净卖出', '暴跌', '下跌', '亏损', '下滑', '下调',
  '回落', '走弱', '破位', '退市', '暴雷', '立案', '预减', '计提', '警示', '诉讼', '罚款', '商誉减值',
  '减值', '风险警示', '被套', '割肉', '套牢', '毛利率下滑', '机构减持', '出货', '见顶'];

// ---------- 工具 ----------
function clamp(v, a, b) { v = Number(v); if (!isFinite(v)) v = 0; return Math.max(a, Math.min(b, v)); }
function round(v, n) {
  if (v == null || !isFinite(v)) return null;
  const m = Math.pow(10, n == null ? 2 : n);
  return Math.round(v * m) / m;
}
/** 分段线性映射（用于绝对基准归一化） */
function piecewise(v, pts) {
  if (v == null || !isFinite(v)) return null;
  v = Number(v);
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1];
      const x1 = pts[i][0], y1 = pts[i][1];
      const t = (v - x0) / ((x1 - x0) || 1);
      return y0 + t * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}
/** 时间衰减权重：越近越高（当天 1.0、1天前 0.7、2天前 0.5、3天+ 0.3），与 sentiment.py 同口径 */
function decayWeight(ageDays) {
  if (ageDays == null) return 0.5;
  if (ageDays < 1) return 1.0;
  if (ageDays < 2) return 0.7;
  if (ageDays < 3) return 0.5;
  return 0.3;
}
function countKeywords(texts, list) {
  const m = new Map();
  for (const t of texts) {
    const s = String(t || '');
    for (const w of list) if (s.indexOf(w) >= 0) m.set(w, (m.get(w) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 情绪标签判定（第二组，6 选 1）。优先级：恐慌 > KOL > 拥挤 > 分歧 > 背离 > 平淡。
 */
function pickSentimentTag(c) {
  const { posPct, negPct, kolCount, finalScore, mainNetPct, profPosPct } = c;
  // 6) 机构散户情绪背离（需 D 指标：专业媒体正面但散户看空，或反之）
  if (profPosPct != null) {
    if (profPosPct >= 55 && negPct >= 45) return '机构散户情绪背离';
    if (profPosPct <= 45 && posPct >= 55) return '机构散户情绪背离';
  }
  // 2) 市场恐慌情绪升温：看空占比高 / 空头压倒多头
  if (negPct >= 45 || (negPct - posPct) >= 25) return '市场恐慌情绪升温';
  // 1) KOL 集体看好：认证大V+看多占比高
  if (kolCount >= 2 && posPct >= 55 && (posPct - negPct) >= 15) return 'KOL集体看好';
  // 3) 舆情拥挤，获利兑现风险上升：高热但资金不支撑
  if (finalScore >= 70 && mainNetPct != null && mainNetPct <= 0) return '舆情拥挤，获利兑现风险上升';
  // 4) 多空剧烈分歧
  if (Math.abs(posPct - negPct) < CFG.cross.divergenceGap && posPct > CFG.cross.divergenceMin && negPct > CFG.cross.divergenceMin) {
    return '多空剧烈分歧';
  }
  // 5) 情绪平淡无方向
  return '情绪平淡无方向';
}

/**
 * 主入口。
 * @param {object} input { symbol, name, quote, capital, turnoverChange, newsSentiment, discussionHeat, stockDiscussion }
 * @returns {object} 标准化分析结果（含 signal -1..1 供卡片判 利好/中性/利空）
 */
function buildStockSentiment(input) {
  const { symbol, name, quote, capital, turnoverChange, newsSentiment, discussionHeat, stockDiscussion } = input || {};
  if (!symbol) return { ok: false, reason: 'missing symbol', degrade: ['缺少股票代码'] };

  const degrade = [];
  const postsRaw = (stockDiscussion && Array.isArray(stockDiscussion.posts)) ? stockDiscussion.posts : [];

  // ---- 1) 实体过滤 + 垃圾过滤 + 情感/散户/KOL 标注 + 时间衰减 ----
  const nowSec = Date.now() / 1000;
  const seen = new Set();
  const posts = [];
  for (const p of postsRaw) {
    const content = String((p && (p.content || p.title)) || '').trim();
    if (!content) continue;
    const id = p && p.id != null ? String(p.id) : null;
    if (id && seen.has(id)) continue;
    if (isSpam(content)) continue;              // 广告/灌水/纯表情/过短
    if (id) seen.add(id);
    const label = classifySentiment(content);   // bullish / bearish / neutral
    const ctime = Number(p.ctime) || 0;
    const ageDays = ctime > 0 ? Math.max(0, (nowSec - ctime) / 86400) : null;
    posts.push({
      id, content, label,
      rookie: isRookiePost(content),
      isV: !!(p && p.isV),
      ctime, ageDays, w: decayWeight(ageDays),
      reply: Number(p.reply) || 0, like: Number(p.like) || 0,
      share: Number(p.share) || 0, forward: Number(p.forward) || 0,
    });
  }

  const hasHeat = !!(discussionHeat && discussionHeat.ok);
  if (!posts.length && !hasHeat) {
    return { ok: false, reason: 'no data', degrade: ['同花顺讨论为空且无其他热度源'] };
  }
  if (!posts.length) {
    degrade.push('同花顺讨论帖为空，无法计算 D/E 情感指标');
  }

  // ---- 2) 聚合 ----
  const n = posts.length;
  for (const x of posts) x.eng = x.reply + x.like + x.share + x.forward;
  const cP = posts.filter(x => x.label === 'bullish').length;
  const cN = posts.filter(x => x.label === 'bearish').length;
  const cU = n - cP - cN;
  const wSum = posts.reduce((s, x) => s + x.w, 0) || 1;
  const wP = posts.filter(x => x.label === 'bullish').reduce((s, x) => s + x.w, 0);
  const wN = posts.filter(x => x.label === 'bearish').reduce((s, x) => s + x.w, 0);
  const wU = Math.max(0, wSum - wP - wN);
  const posPct = round(wP / wSum * 100, 1);
  const negPct = round(wN / wSum * 100, 1);
  const neuPct = round(wU / wSum * 100, 1);
  const netSent = round((wP - wN) / wSum, 3);            // -1..1 加权净情绪
  const rookieCount = posts.filter(x => x.rookie).length;
  const kolCount = posts.filter(x => x.isV).length;      // KOL 近似 = 认证大V
  const commentsTotal = posts.reduce((s, x) => s + x.reply, 0);
  const likesShares = posts.reduce((s, x) => s + x.like + x.share + x.forward, 0);
  let spanDays = null;
  if (n) {
    const ts = posts.map(x => x.ctime).filter(t => t > 0);
    if (ts.length >= 2) spanDays = Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 86400));
  }

  // ---- 3) 五大基础原始指标 ----
  const newsOk = !!(newsSentiment && newsSentiment.ok);
  const A_raw = newsOk ? (Number(newsSentiment.count) || 0) : null;   // 曝光以新闻条数代理（平台无浏览量字段）
  const B_raw = n + commentsTotal + likesShares;                       // 有效帖数 + 累计评论 + 点赞分享(曝光代理)
  const C_raw = rookieCount;
  const D_raw = newsOk && newsSentiment.count > 0
    ? round((Number(newsSentiment.positive) || 0) / newsSentiment.count * 100, 1) : null;
  const E_raw = posPct;                                                // 社区看多占比%

  // ---- 4) 归一化（行业样本池不可用 → 绝对基准；E/D 本身即 0~100 百分比） ----
  const A_norm = null;
  const B_norm = piecewise(B_raw, CFG.scaleB);
  const C_norm = piecewise(C_raw, CFG.scaleC);
  const D_norm = D_raw;
  const E_norm = E_raw;
  degrade.push('行业样本池 Min-Max 归一化不可用，采用绝对基准曲线');
  if (!newsOk) degrade.push('新闻/研报源不可用（A 全网曝光、D 专业舆情情感 缺失）');
  if (!hasHeat) degrade.push('多平台热度源不可用');
  const emOk = !!(discussionHeat && discussionHeat.eastmoney && discussionHeat.eastmoney.ok);
  if (hasHeat && !emOk) degrade.push('东财股吧源不可用（同花顺/雪球正常）');
  degrade.push('KOL 判定缺粉丝数据，以「认证大V」近似；散户判定为句式词典近似');

  // ---- 5) 加权基础综合分（在可用指标间重分配权重） ----
  const avail = [];
  if (A_norm != null) avail.push(['A', A_norm, CFG.weights.A]);
  if (B_norm != null) avail.push(['B', B_norm, CFG.weights.B]);
  if (D_norm != null) avail.push(['D', D_norm, CFG.weights.D]);
  if (E_norm != null) avail.push(['E', E_norm, CFG.weights.E]);
  const wTot = avail.reduce((s, x) => s + x[2], 0) || 1;
  const baseScore = avail.length ? Math.round(avail.reduce((s, x) => s + x[1] * x[2], 0) / wTot) : 0;

  // ---- 6) 四路外部数据交叉校验 ----
  const floatMC = (capital && capital.floatMarketCapYi) || 0;
  const s5 = capital && capital.moneyFlow && capital.moneyFlow.summary
    && capital.moneyFlow.summary.summary && capital.moneyFlow.summary.summary['5d'];
  const mainNet5d = s5 && typeof s5.mainNet === 'number' ? s5.mainNet : null;   // 亿元
  const mainNetPct = (mainNet5d != null && floatMC > 0) ? round(mainNet5d / floatMC * 100, 2) : null;
  let changePct = null;
  if (quote && quote.price != null && quote.prevClose > 0) {
    changePct = round((quote.price - quote.prevClose) / quote.prevClose * 100, 2);
  }
  const turnSig = turnoverChange && turnoverChange.ok ? turnoverChange.signal : null;
  const turnHigh = turnSig != null && turnSig > 0.1;

  const crossTags = [];
  let score = baseScore;

  // 规则1：热度高 + 主力大幅净流出 → 下调，【舆情热度虚高，资金背离】
  if (baseScore >= 70 && mainNetPct != null && mainNetPct <= -CFG.cross.mainNetBigPct) {
    score -= 12; crossTags.push('舆情热度虚高，资金背离');
  } else if (baseScore >= 60 && mainNetPct != null && mainNetPct >= CFG.cross.mainNetBigPct) {
    // 规则3：热度高 + 主力持续净流入 → 维持/小幅上调
    score += 5; crossTags.push('资金共振，热度有资金支撑');
  }
  // 规则2：热度低 + 大幅上涨 + 换手率走高 → 小幅下调，【资金驱动，市场舆论尚未共识】
  if (baseScore < 40 && changePct != null && changePct >= CFG.cross.bigRisePct && turnHigh) {
    score -= 6; crossTags.push('资金驱动，市场舆论尚未共识');
  }
  // 规则5：热度中等 + 资金小幅流出 + 多空接近 → 下调，【多空剧烈分歧】
  if (baseScore >= 40 && baseScore < 70 && mainNetPct != null && mainNetPct < 0
    && Math.abs(mainNetPct) < CFG.cross.mainNetSmallPct
    && Math.abs(posPct - negPct) < CFG.cross.divergenceGap
    && posPct > CFG.cross.divergenceMin && negPct > CFG.cross.divergenceMin) {
    score -= 8; crossTags.push('多空剧烈分歧，资金小幅流出');
  }
  const finalScore = Math.round(clamp(score, 0, 100));

  // ---- 7) 标签体系 ----
  const heatLevel = finalScore >= CFG.heat.hot ? '舆情高热'
    : finalScore >= CFG.heat.warm ? '舆情偏热'
    : finalScore >= CFG.heat.calm ? '舆情平稳' : '舆情冷清';
  const sentimentTag = pickSentimentTag({ posPct, negPct, kolCount, finalScore, mainNetPct, profPosPct: D_norm });

  // 规则4/告警：归一化散户指标 ≥90 且 最终综合分 ≥70
  const alertOn = C_norm != null && C_norm >= CFG.alert.rookieNorm && finalScore >= CFG.alert.finalScore;

  // ---- 8) 方向信号（供卡片判 利好/中性/利空）：冷清时情绪影响减弱 ----
  const heatFactor = finalScore >= CFG.heat.calm ? 1 : (finalScore / CFG.heat.calm);
  const signal = clamp(netSent * heatFactor, -1, 1);

  // ---- 9) 简报 ----
  const posKeywords = countKeywords(posts.map(x => x.content), POS_KW).slice(0, 5).map(x => x[0]);
  const negKeywords = countKeywords(posts.map(x => x.content), NEG_KW).slice(0, 5).map(x => x[0]);
  const top = posts.slice().sort((a, b) => b.eng - a.eng)[0];
  const coreEvent = top ? top.content.replace(/\s+/g, ' ').slice(0, 48) : '';
  const sampleWarning = n < CFG.sampleMin;

  // ---- 10) 简短结论 ----
  const dirWord = signal > 0.12 ? '偏多' : (signal < -0.12 ? '偏空' : '中性');
  const conclusion = `${heatLevel}（综合分 ${finalScore}），${sentimentTag}${alertOn ? '，散户情绪过热' : ''}，舆论${dirWord}`
    + `；看多 ${posPct}%/看空 ${negPct}%`
    + (sampleWarning ? '，样本偏少，分数参考性下降' : '');

  return {
    ok: true,
    symbol: String(symbol),
    name: name || '',
    period: 'recent',
    windowDays: spanDays,
    sample: n,
    sampleWarning,
    raw: {
      posts: n, comments: commentsTotal, likesShares,
      views: null,                       // 同花顺讨论 API 无浏览量字段
      rookieCount, kolCount,
    },
    sentiment: {
      positive: cP, neutral: cU, negative: cN,
      posPct, negPct, neuPct, netSent,
      weightedAvgScore: round(0.5 + netSent / 2, 3),   // 0~1，与 sentiment.py 同口径展示
    },
    indicators: { A: A_raw, B: B_raw, C: C_raw, D: D_raw, E: E_raw },
    norm: { A: A_norm, B: round(B_norm, 1), C: round(C_norm, 1), D: D_norm, E: round(E_norm, 1) },
    baseScore,
    finalScore,
    heatLevel,
    sentimentTag,
    alert: { on: alertOn, text: alertOn ? '⚠️散户过热告警' : '' },
    crossTags,
    brief: { posKeywords, negKeywords, coreEvent },
    conclusion,
    degrade,
    normalizationBasis: 'absolute',
    signal: round(signal, 3),
  };
}

module.exports = { buildStockSentiment, CFG };
