/**
 * 个股近期热点（后端模块，20260827c 重构）
 * --------------------------------------------------------------
 * 模块只做一件事：AI 联网分析该股当前最值得关注的热点。
 * 两种模式（按当日涨跌幅自动切换）：
 *   1) 涨跌幅绝对值 ≥ 3%  → 「当日异动归因」：AI 分析今日涨跌的最直接原因
 *   2) 涨跌幅绝对值 <  3%  → 「网络热议话题」：AI 联网分析该股近期网络上讨论最多的话题/关键词
 * 所有结果按交易日缓存，避免盘中/每次打开反复调用 AI。
 *
 * 数据源：lib/cnscraperAdapter（全网舆情 + 交易所公告）+ lib/sentiment（同花顺股吧讨论帖 +
 *         东财/同花顺/雪球讨论热度 + 个股新闻情感，与「舆情与讨论热度（个股）」因子同一数据源）
 *         + lib/aiAugment.callLLM（联网搜索）。
 * 20260913f 增强（用户反馈「热点说无热议话题、舆情却抓到焦点帖」两卡口径不一致）：
 *   ① 新增抓取渠道：同花顺股吧讨论帖、东财/同花顺/雪球讨论热度、个股新闻情感——直接复用
 *      lib/sentiment（即「舆情与讨论热度（个股）」因子的同一数据源），从源头消除两卡不一致；
 *   ② 增加「确定性讨论摘要」discussionDigest：不依赖 LLM，只要有讨论帖/热度就必展示，
 *      杜绝「明明有焦点帖却显示无热议话题」；
 *   ③ LLM 综述若在已有讨论证据的情况下仍答「未抓取到」，强制以确定性摘要覆盖；
 *   ④ 缓存加 CACHE_VER 版本门控，旧空结果不再被复用。
 * 所有外部调用均 best-effort 失败降级，绝不抛异常拖垮个股页。
 * AI 调用需要用户在「⚙️ AI 设置」中配置 API Key；无 Key 时仅展示提示。
 */
const fs = require('fs');
const path = require('path');
const cns = require('./cnscraperAdapter');
const marketSentiment = require('./sentiment');
const ai = require('./aiAugment');
const { getQuote } = require('./stockData');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const PRICE_CHANGE_THRESHOLD = 3; // 涨跌幅绝对值阈值 %
// 缓存版本门控：结果结构/口径变化时 +1，旧缓存自动作废重算（避免升级后仍看到旧空结果）
const CACHE_VER = '20260913f';

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT = path.join(DATA_DIR, 'hot-topics');

function ensureDirs() {
  try { if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true }); } catch (e) { /* 忽略 */ }
}

function symDir(symbol) {
  return path.join(ROOT, String(symbol || '').trim());
}

function readJSON(symbol, file, fallback) {
  try {
    const fp = path.join(symDir(symbol), file);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(symbol, file, obj) {
  ensureDirs();
  const d = symDir(symbol);
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  fs.writeFileSync(path.join(d, file), JSON.stringify(obj, null, 2), 'utf8');
}

function aiExtractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

// 给外部（行情/LLM）调用加超时兜底，避免请求路径被挂死（项目红线：请求内不可阻塞）
function pTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'call') + ' 超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function normalizeKeyword(kw) {
  return String(kw || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 40);
}

// 从已抓取证据（全网舆情/交易所公告/财报解读）提取原始条目作为 LLM 失败/超时时的降级展示
function buildFallbackTopics(evidence) {
  const out = [];
  const seen = new Set();
  for (const e of (evidence || [])) {
    const items = e.items || e.articles || [];
    if (!Array.isArray(items) || !items.length) continue;
    for (const it of items) {
      const kw = String(it.title || it.headline || it.keyword || (it.content || '').slice(0, 30) || '').trim();
      if (!kw) continue;
      const dedup = kw.slice(0, 24);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({
        keyword: kw.slice(0, 40),
        desc: String(it.summary || it.desc || it.content || it.abstract || '').trim().slice(0, 120),
        heat: ['高', '中', '低'].includes(it.heat) ? it.heat : '中',
        sentiment: ['利好', '利空', '中性', '未知'].includes(it.sentiment || it.orientation) ? (it.sentiment || it.orientation) : '未知',
        sources: [e.source],
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- 讨论帖/热度渠道（20260913f）----
// 复用「舆情与讨论热度（个股）」因子的同一数据源（lib/sentiment → scripts/sentiment.py），
// 保证个股近期热点与舆情卡片看到的是同一批帖子和同一套热度口径，从源头杜绝两卡结论打架。
async function collectDiscussion(symbol, name) {
  const out = { ok: false, posts: [], heat: null, news: null };
  try {
    const s = await pTimeout(marketSentiment.getMarketSentiment(symbol, name), 65000, 'sentiment');
    if (!s) return out;
    const rawPosts = (s.stockDiscussion && Array.isArray(s.stockDiscussion.posts)) ? s.stockDiscussion.posts : [];
    if (rawPosts.length) {
      out.posts = rawPosts.map(p => {
        const ctime = Number(p.ctime) || 0;
        const eng = (Number(p.reply) || 0) + (Number(p.like) || 0) + (Number(p.share) || 0) + (Number(p.forward) || 0);
        return {
          content: String((p && (p.content || p.title)) || '').replace(/\s+/g, ' ').trim(),
          date: ctime > 0 ? localDateFromTs(ctime) : '',
          eng,
          isV: !!(p && p.isV),
        };
      }).filter(p => p.content);
    }
    if (s.discussionHeat && s.discussionHeat.ok) out.heat = s.discussionHeat;
    if (s.newsSentiment && s.newsSentiment.ok) out.news = s.newsSentiment;
    out.ok = !!(out.posts.length || out.heat);
  } catch (e) {
    // 本机 Python/网络受限时静默降级，不影响 LLM 联网检索主路径
  }
  return out;
}

// 讨论帖 → 证据条目（title 用帖子正文，供 LLM 归纳 & 降级展示）
function postsToEvidenceItems(posts) {
  return posts.slice()
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 12)
    .map(p => ({ title: p.content.slice(0, 140), date: p.date, sentiment: '未知', heat: p.eng >= 5 ? '高' : p.eng >= 1 ? '中' : '低' }));
}

// 确定性讨论摘要（不依赖 LLM）：只要有讨论帖或多平台热度就必定展示，
// 避免「明明抓到 14 帖焦点帖、卡片却写无热议话题」。
function buildDiscussionDigest(disc) {
  if (!disc || !disc.ok) return '';
  const parts = [];
  const heat = disc.heat;
  if (heat) {
    const em = heat.eastmoney || {};
    const th = heat.tonghuashun || {};
    const xq = heat.xueqiu || {};
    const seg = [];
    if (em.symbolScore != null) seg.push(`东财股吧热度 ${em.symbolScore}${em.symbolRise != null ? (em.symbolRise > 0 ? '↑' : '↓') : ''}`);
    if (th.inHotList) seg.push(`同花顺热榜第 ${th.rank} 名`);
    else if (th.ok) seg.push('同花顺未入热榜');
    if (xq.inTop) seg.push(`雪球关注榜第 ${xq.rank} 名（${xq.follow} 人关注）`);
    else if (xq.ok) seg.push('雪球未入关注榜');
    if (seg.length) parts.push(`多平台讨论热度：${seg.join(' / ')}`);
  }
  if (disc.posts.length) {
    parts.push(`近端股吧讨论帖 ${disc.posts.length} 条`);
    const top = disc.posts.slice().sort((a, b) => b.eng - a.eng)[0];
    if (top) parts.push(`最热帖${top.date ? '（' + top.date + '）' : ''}：${top.content.slice(0, 60)}`);
  }
  return parts.join('；');
}

// LLM 综述「否认有内容」的典型措辞；在已抓到讨论证据时用于纠正
const NO_CONTENT_RE = /未抓取到|未获取到|无法抓取|无热议|没有热议|缺乏热点|缺乏实质性话题|热度处于低位|未发现相关讨论|无相关讨论/;

// 统一错误分类：区分「鉴权失败 / 请求参数 / 超时 / 网络错误 / 其他」，
// 供重试兜底与用户提示使用（避免把所有失败笼统说成"检查网络或 Key"）。
function classifyAIError(e) {
  const msg = String((e && e.message) || '');
  const status = (e && e.response && e.response.status) || 0;
  if (status === 401 || status === 403 || /invalid_api_key|unauthorized|authentication|api[ _-]?key/i.test(msg)) {
    return { kind: 'auth', label: 'AI API Key 无效或已过期', hint: '请在「AI 设置」中确认 Key 正确且未过期' };
  }
  if (status === 400 || status === 404) {
    return { kind: 'badRequest', label: 'AI 请求参数或模型不可用', hint: '请在「AI 设置」中确认所选模型支持联网搜索' };
  }
  if (/超时|timeout/i.test(msg) || status === 408 || status === 504) {
    return { kind: 'timeout', label: 'AI 分析超时', hint: '请稍后点「重新分析」重试；如频繁超时请检查网络或更换更快模型' };
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|network/i.test(msg)) {
    return { kind: 'network', label: '网络连接失败', hint: '请检查本机网络后重试' };
  }
  return { kind: 'other', label: 'AI 分析失败', hint: '请稍后重试' };
}

// 带指数退避重试的 LLM 调用（默认 60s 超时，与底层 axios 超时对齐）：
// 仅对「网络错误」这类快速失败做重试；超时已给足 60s，鉴权/400 重试无意义，均不重试。
// webSearch=true（默认）=联网类（异动归因/热议话题，需检索最新公告舆情）
async function callLLMWithRetry(cfg, messages, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const attempts = opts.attempts || 2;
  const webSearch = opts.webSearch !== false; // 默认联网
  // 20260904a：透传妙想参数（mxQuery 替换 / mxInject 增强）给 ai.callLLM
  const mxOpts = {};
  if (opts.mxQuery) mxOpts.mxQuery = opts.mxQuery;
  if (opts.mxInject) mxOpts.mxInject = true;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pTimeout(ai.callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch, ...mxOpts }), timeoutMs, 'LLM');
    } catch (e) {
      lastErr = e;
      const cls = classifyAIError(e);
      if (cls.kind !== 'network' || i === attempts - 1) break;
      await sleep(1000 * Math.pow(2, i)); // 1s、2s…
    }
  }
  throw lastErr;
}

// ---- 模式一：当日异动归因（涨跌幅绝对值 ≥3%）----

/**
 * 当个股涨跌幅绝对值 ≥3% 时，联网搜索并调用 LLM 分析当日涨跌的最直接原因。
 * @param {string} symbol
 * @param {string} name
 * @param {object|null} quoteArg 已取出的行情（避免重复拉取）；为空则内部拉取
 * @param {boolean} force 为 true 时忽略缓存、强制重新分析
 * 返回 {mode:'priceChange', triggered, changePct, analysis, sources, date} 或 null（未触发）
 */
async function analyzePriceChange(symbol, name, quoteArg, force) {
  let quote = quoteArg;
  if (!quote) {
    try { quote = await getQuote(symbol); } catch (e) {
      console.error('[HotTopics] getQuote failed:', e.message);
      return null;
    }
  }
  if (!quote || quote.changePct == null) return null;
  const changePct = quote.changePct;
  if (Math.abs(changePct) < PRICE_CHANGE_THRESHOLD) return null;

  // 数据一致性红线：分析对象名称以权威行情源为准，入参 name 仅作降级，
  // 确保证据检索（舆情/公告）与 LLM prompt 都指向正确的公司。
  const resolvedName = (quote.name && String(quote.name).trim()) || String(name || '').trim() || String(symbol);

  const today = quote.date || localDate();
  const cache = readJSON(symbol, 'price-change.json', null);
  // 按交易日缓存：同方向且仍满足阈值时复用，避免盘中频繁调用 AI
  // 额外校验分析对象名称：若缓存的公司名与当前行情源名称不一致（说明当时分析错了公司），
  // 视为无效缓存，作废重算——避免错误归因被长期复用误导用户。
  // 缓存必须同时具备 symbolName 且与当前行情源名称一致才可信；
  // 旧版本写入的缓存无 symbolName 字段（无法证明分析对象正确），一律作废重算。
  const cacheName = cache && cache.symbolName ? String(cache.symbolName).trim() : '';
  const cacheNameOk = !!(cacheName && quote.name && cacheName === String(quote.name).trim());
  if (!force && cache && cache.date === today && cache.analysis && cacheNameOk && cache.cacheVer === CACHE_VER && Math.sign(cache.changePct) === Math.sign(changePct)) {
    return { ...cache, mode: 'priceChange', cached: true };
  }

  // 收集公开信息证据（20260913f：并行抓取 + 新增股吧讨论帖/热度/个股新闻三路渠道）
  const evidence = [];
  const [ann, sent, rep, disc] = await Promise.all([
    cns.searchAnnouncementsByCode(symbol, 20).catch(() => ({ ok: false })),
    cns.getGlobalSentiment(resolvedName, { days: 3, maxArticles: 15, budget: 10 }).catch(() => ({ ok: false })),
    cns.interpretReport(symbol).catch(() => ({ ok: false })),
    collectDiscussion(symbol, resolvedName),
  ]);
  if (ann && ann.ok && ann.items && ann.items.length) {
    evidence.push({ source: '交易所公告', items: ann.items.slice(0, 10) });
  }
  if (sent && sent.ok && sent.articles && sent.articles.length) {
    evidence.push({ source: '全网舆情', items: sent.articles.slice(0, 10) });
  }
  if (rep && rep.ok) evidence.push({ source: '财报解读', ...rep });
  const postItems = disc && disc.posts.length ? postsToEvidenceItems(disc.posts) : [];
  if (postItems.length) evidence.push({ source: '同花顺股吧讨论帖', items: postItems });
  const discussionDigest = buildDiscussionDigest(disc);
  if (discussionDigest) evidence.push({ source: '多平台讨论热度（东财/同花顺/雪球）', items: [{ title: discussionDigest, heat: '高' }] });

  const cfg = ai.loadConfig();
  const baseResult = {
    ok: true,
    mode: 'priceChange',
    triggered: true,
    changePct,
    price: quote.price,
    prevClose: quote.prevClose,
    date: today,
    threshold: PRICE_CHANGE_THRESHOLD,
    symbol,
    symbolName: quote.name || '', // 记录本次分析对象，供缓存复用时校验一致性
    cacheVer: CACHE_VER,          // 20260913f：口径版本门控
    discussion: (typeof discussionDigest === 'string' && discussionDigest) ? { digest: discussionDigest } : null,
  };

  if (!cfg.apiKey) {
    const result = {
      ...baseResult,
      analysis: '未配置 AI API Key，无法自动联网归因。请在「AI 设置」中配置 Key 后刷新。',
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
      noKey: true,
    };
    writeJSON(symbol, 'price-change.json', result);
    return result;
  }

  const evidenceText = evidence
    .map((e, idx) => `[证据${idx + 1}] ${e.source}: ${JSON.stringify(e.items || e).slice(0, 1800)}`)
    .join('\n---\n');

  const direction = changePct > 0 ? '上涨' : '下跌';
  const prompt = `你是 A 股短线分析师，熟悉公告、舆情与盘面。股票「${resolvedName}」（代码 ${symbol}）今日${direction} ${Math.abs(changePct).toFixed(2)}%（现价 ${quote.price} 元，昨收 ${quote.prevClose} 元）。请结合联网搜索到的最新公开信息，分析今日股价异动的最直接原因。
要求：
1) 用简体中文，直接给出 1-3 条最可能的核心原因；
2) 每条原因说明是「公告驱动」「舆情/新闻驱动」「板块/大盘带动」「资金博弈」还是「其他」；
3) 标注信息来源与可信度（已核实公告 / 媒体报道 / 市场推测）；
4) 若公开信息不足以解释，明确写「公开信息未能完全解释今日异动」；
5) 总长度控制在 300 字以内，只输出分析结论，不要 JSON。`;

  try {
    // 20260904a：异动归因用妙想东财资讯补公告/舆情事实源（evidence 已含 cnscraper 公告+全网舆情），
    // 妙想可用时省通用搜索；失败自动回退通用搜索。
    const priceMxQuery = `${resolvedName}（${symbol}）今日股价异动原因 最新公告 新闻 板块`;
    const text = await callLLMWithRetry(cfg, [
      { role: 'system', content: '你是专业 A 股分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt + (evidenceText ? '\n\n可参考以下公开信息片段：\n' + evidenceText : '') },
    ], { webSearch: true, mxQuery: priceMxQuery });
    const result = {
      ...baseResult,
      analysis: text || 'AI 返回为空',
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
    };
    writeJSON(symbol, 'price-change.json', result);
    return result;
  } catch (e) {
    console.error('[HotTopics] analyzePriceChange LLM failed:', e.message);
    const cls = classifyAIError(e);
    // 降级顺序：① 历史成功结果 → ② 本次抓取的公开信息 → ③ 明确提示
    if (cache && cache.analysis && !cache.noKey) {
      return { ...cache, mode: 'priceChange', cached: false, stale: true };
    }
    let analysis = `${cls.label}。`;
    const evParts = [];
    for (const ev of evidence) {
      const items = ev.items || ev.articles || [];
      if (Array.isArray(items) && items.length) {
        evParts.push('【' + ev.source + '】' + items.slice(0, 5).map(it => it.title || it.content || '').filter(Boolean).join('；'));
      }
    }
    analysis += evParts.length
      ? ' 可参考公开信息：' + evParts.join(' ')
      : ` 未抓取到有效公开信息。${cls.hint}。`;
    const result = {
      ...baseResult,
      analysis,
      sources: evidence.filter(e => e.items || e.content).map(e => e.source),
      error: e.message,
    };
    return result;
  }
}

// ---- 模式二：网络热议话题（涨跌幅绝对值 <3%）----

/**
 * 当个股涨跌幅绝对值 <3% 时，联网搜索并调用 LLM 分析该股近期网络上讨论最多的话题/关键词。
 * @param {string} symbol
 * @param {string} name
 * @param {object|null} quote 已取出的行情（取当日日期/涨跌幅）
 * @param {boolean} force 为 true 时忽略缓存、强制重新分析
 */
async function analyzeTrendingTopics(symbol, name, quote, force) {
  const today = (quote && quote.date) || localDate();
  const cache = readJSON(symbol, 'trending.json', null);
  // 同 priceChange：校验分析对象名称，缓存的公司名与当前行情源不一致则作废重算
  // 同 priceChange：缓存必须带 symbolName 且与行情源一致才可信，缺失一律作废重算
  const cacheName = cache && cache.symbolName ? String(cache.symbolName).trim() : '';
  const cacheNameOk = !!(cacheName && quote && quote.name && cacheName === String(quote.name).trim());
  const cacheVerOk = !!(cache && cache.cacheVer === CACHE_VER); // 20260913f：旧口径缓存作废重算
  if (!force && cache && cache.date === today && Array.isArray(cache.topics) && cache.topics.length && cacheNameOk && cacheVerOk) {
    return { ...cache, mode: 'trending', cached: true };
  }

  // 数据一致性红线：分析对象名称以权威行情源为准，入参 name 仅作降级
  const resolvedName = (quote && quote.name && String(quote.name).trim()) || String(name || '').trim() || String(symbol);

  // best-effort 抓取舆情/公告/股吧讨论作为 grounding（失败不影响，LLM 自带联网搜索兜底）
  // 20260913f：五路渠道并行抓取——① 全网舆情(cnscraper 60+源) ② 交易所公告
  // ③ 同花顺股吧讨论帖 ④ 东财/同花顺/雪球讨论热度 ⑤ 个股新闻情感。
  // ③④⑤ 与「舆情与讨论热度（个股）」因子同源（lib/sentiment），确保两卡口径一致。
  const evidence = [];
  const [sent, ann, disc] = await Promise.all([
    cns.getGlobalSentiment(resolvedName, { days: 7, maxArticles: 18, budget: 14 }).catch(() => ({ ok: false })),
    cns.searchAnnouncementsByCode(symbol, 20).catch(() => ({ ok: false })),
    collectDiscussion(symbol, resolvedName),
  ]);
  if (sent && sent.ok && sent.articles && sent.articles.length) {
    evidence.push({ source: '全网舆情', items: sent.articles.slice(0, 12) });
  }
  if (ann && ann.ok && ann.items && ann.items.length) {
    evidence.push({ source: '交易所公告', items: ann.items.slice(0, 10) });
  }
  // ③ 同花顺股吧讨论帖（真实股民发帖，含焦点帖）
  const postItems = disc && disc.posts.length ? postsToEvidenceItems(disc.posts) : [];
  if (postItems.length) {
    evidence.push({ source: '同花顺股吧讨论帖', items: postItems });
  }
  // ④ 多平台讨论热度（东财股吧 / 同花顺热榜 / 雪球关注榜）
  const discussionDigest = buildDiscussionDigest(disc);
  if (discussionDigest) {
    evidence.push({ source: '多平台讨论热度（东财/同花顺/雪球）', items: [{ title: discussionDigest, heat: '高' }] });
  }
  // ⑤ 个股新闻情感样例（标题本身即是话题线索）
  if (disc && disc.news && Array.isArray(disc.news.samples) && disc.news.samples.length) {
    evidence.push({
      source: '个股新闻',
      items: disc.news.samples.slice(0, 8).map(s => ({
        title: s.title,
        date: s.date,
        sentiment: (Number(s.score) > 0.2) ? '利好' : (Number(s.score) < -0.2 ? '利空' : '中性'),
      })),
    });
  }

  const baseResult = {
    ok: true,
    mode: 'trending',
    triggered: false,
    changePct: quote && quote.changePct != null ? quote.changePct : 0,
    date: today,
    symbol,
    symbolName: (quote && quote.name) || '', // 记录本次分析对象，供缓存复用时校验一致性
    cacheVer: CACHE_VER,                     // 20260913f：口径版本门控
    // 讨论帖/热度（与「舆情与讨论热度（个股）」因子同源），供前端展示与口径对齐
    discussion: (disc && disc.ok) ? {
      digest: discussionDigest,
      postCount: disc.posts.length,
      topPost: disc.posts.length ? disc.posts.slice().sort((a, b) => b.eng - a.eng)[0].content.slice(0, 100) : '',
      topPostDate: disc.posts.length ? disc.posts.slice().sort((a, b) => b.eng - a.eng)[0].date : '',
      heat: disc.heat ? {
        eastmoney: disc.heat.eastmoney || null,
        tonghuashun: disc.heat.tonghuashun || null,
        xueqiu: disc.heat.xueqiu || null,
      } : null,
    } : null,
  };

  const cfg = ai.loadConfig();
  if (!cfg.apiKey) {
    const result = {
      ...baseResult,
      topics: [],
      content: '未配置 AI API Key，无法联网分析网络热议话题。请在「AI 设置」中配置 Key 后刷新。',
      sources: [],
      noKey: true,
    };
    writeJSON(symbol, 'trending.json', result);
    return result;
  }

  const evidenceText = evidence
    .map((e, idx) => `[证据${idx + 1}] ${e.source}: ${JSON.stringify(e.items || e).slice(0, 1500)}`)
    .join('\n---\n');

  const prompt = `你是 A 股舆情分析师，需联网搜索最新信息。请联网搜索股票「${resolvedName}」（代码 ${symbol}）近期（最近 1-2 周）在网络上被讨论最多、热度最高的话题与关键词（覆盖财经社区/股吧/雪球/同花顺/新闻媒体等）。
要求：
1) 只输出严格 JSON，不要 Markdown 代码块，格式：
{"topics":[{"keyword":"话题或关键词（2-12字）","desc":"1-2 句说明市场主要观点或争议点","heat":"高|中|低","sentiment":"利好|利空|中性|未知"}],"summary":"对整体舆论热度的综述（2-3 句，含多空与热度判断）"}
2) 取 5-8 个最热话题，覆盖不同维度（业绩/政策/行业/事件/资金等）；
3) 仅输出确有公开讨论支撑的话题，不要编造无依据内容；
4) 简体中文。
5) 下方「可参考的公开信息片段」中若已包含「同花顺股吧讨论帖」或「多平台讨论热度」，
   必须优先据其归纳出真实话题（含股民正在讨论的具体事件），**严禁**回答"未抓取到帖子/无热议话题"——
   只有在你既未联网检索到、证据中也没有任何讨论内容时，才可说明"当前公开渠道暂未发现明显热议话题"。`;

  try {
    const text = await callLLMWithRetry(cfg, [
      { role: 'system', content: '你是专业 A 股舆情分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt + (evidenceText ? '\n\n可参考以下公开信息片段：\n' + evidenceText : '') },
    ], { webSearch: true });
    const parsed = aiExtractJson(text);
    let topics = [];
    if (parsed && Array.isArray(parsed.topics)) {
      topics = parsed.topics.map(t => ({
        keyword: normalizeKeyword(t.keyword),
        desc: String(t.desc || '').trim(),
        heat: ['高', '中', '低'].includes(t.heat) ? t.heat : '中',
        sentiment: ['利好', '利空', '中性', '未知'].includes(t.sentiment) ? t.sentiment : '未知',
      })).filter(t => t.keyword).slice(0, 8);
    }
    let content = String((parsed && parsed.summary) || '').trim() || '（AI 未返回综述）';
    // 20260913f：LLM 在已抓到讨论帖的情况下仍称「未抓取到」时（典型：只看到页面框架就断言），
    // 用确定性讨论摘要覆盖综述，保证与「舆情与讨论热度（个股）」卡片结论一致。
    // 正常情况讨论摘要由前端单独渲染（analysis.discussion.digest），不在此重复拼接。
    if (discussionDigest && NO_CONTENT_RE.test(content)) {
      content = `【讨论热度】${discussionDigest}。已抓取到股吧讨论帖与多平台热度，详见下方话题列表。`;
    }
    // LLM 成功但返回空话题时，降级到原始舆情/公告/股吧讨论帖，避免卡片显示空
    if (!topics.length) {
      const fallbackTopics = buildFallbackTopics(evidence);
      const result = {
        ...baseResult,
        topics: fallbackTopics,
        content: fallbackTopics.length
          ? 'AI 聚合返回为空，已展示抓取到的股吧讨论帖/舆情/公告原始条目。'
          : '当前未能抓取到有效网络舆情、公告或股吧讨论，且 AI 聚合返回为空，请稍后刷新或检查网络。',
        sources: evidence.filter(e => e.items || e.articles).map(e => e.source),
        llmEmpty: true,
      };
      writeJSON(symbol, 'trending.json', result);
      return result;
    }
    const result = {
      ...baseResult,
      topics,
      content,
      sources: evidence.filter(e => e.items).map(e => e.source),
    };
    writeJSON(symbol, 'trending.json', result);
    return result;
  } catch (e) {
    console.error('[HotTopics] analyzeTrendingTopics LLM failed:', e.message);
    const cls = classifyAIError(e);
    // 降级顺序：① 历史成功结果（昨日/更早，且为同口径版本）→ ② 本次抓取的讨论帖/舆情/公告 → ③ 明确提示
    if (cache && cacheVerOk && Array.isArray(cache.topics) && cache.topics.length) {
      const prefix = String(cache.content || '').trim();
      const result = {
        ...baseResult,
        topics: cache.topics,
        content: prefix + (prefix ? ' ' : '') + `【${cls.label}，暂展示历史分析结果，可点「重新分析」重试】`,
        sources: cache.sources || [],
        stale: true,
        error: e.message,
      };
      return result;
    }
    const fallbackTopics = buildFallbackTopics(evidence);
    const result = {
      ...baseResult,
      topics: fallbackTopics,
      content: fallbackTopics.length
        ? `${cls.label}，已展示抓取到的股吧讨论帖/舆情/公告原始条目。`
        : `${cls.label}：未抓取到有效网络舆情、公告或股吧讨论。${cls.hint}。`,
      sources: evidence.filter(e => e.items || e.articles).map(e => e.source),
      error: e.message,
    };
    return result;
  }
}

// ---- 统一状态入口（前端只读）----
// force=true 时忽略缓存、强制重新分析（来自前端「重新分析」按钮 ?refresh=1）

async function getState(symbol, nameArg, force) {
  const cfg = ai.loadConfig();
  let quote = null;
  try { quote = await pTimeout(getQuote(symbol), 8000, 'getQuote'); } catch (e) { console.error('[HotTopics] getQuote timeout/err:', e.message); }
  const changePct = quote && quote.changePct != null ? quote.changePct : 0;

  // 数据一致性红线：股票名称以权威行情源（腾讯）为准，前端传入的 name 仅作降级。
  // 前端曾在切换股票时残留上一只股票的名称（600460 却传「长江证券」），
  // 导致 LLM 全部证据检索、公告解读、板块分析都基于错误公司，整张卡片不可信。
  const quoteName = quote && quote.name ? String(quote.name).trim() : '';
  const argName = String(nameArg || '').trim();
  let name = quoteName || argName || String(symbol || '');
  if (argName && quoteName && argName !== quoteName) {
    console.warn(`[HotTopics] 名称不一致：入参「${argName}」，行情源「${quoteName}」（${symbol}），以行情源为准`);
  }

  let analysis = null;
  if (Math.abs(changePct) >= PRICE_CHANGE_THRESHOLD) {
    analysis = await analyzePriceChange(symbol, name, quote, force);
    if (analysis) analysis.mode = 'priceChange';
  } else {
    analysis = await analyzeTrendingTopics(symbol, name, quote, force);
    if (analysis) analysis.mode = 'trending';
  }

  return {
    ok: true,
    symbol,
    hasKey: !!cfg.apiKey,
    changePct,
    mode: analysis ? analysis.mode : null,
    analysis,
  };
}

module.exports = {
  analyzePriceChange,
  analyzeTrendingTopics,
  getState,
};
