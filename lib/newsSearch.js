/**
 * News Search Module
 * Fetches financial news from Eastmoney content search API
 */
const axios = require('axios');
const { analyzeSentiment } = require('./analysis');
// Part B：关联度/弱关联持续性经验库（mRNA→医疗器械 等弱关联识别与衰减）
const { relevanceScore, WEAK_THRESHOLD } = require('./relevanceLearning');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 内存缓存（避免每次打开首页都打外部接口）
let hotNewsCache = { ts: 0, data: null };

/**
 * 今日财经热点分类（时政 / 政策 / 国际 / 公司 / 市场）
 */
function classifyCategory(title = '', summary = '') {
  const t = (title + ' ' + (summary || '')).toLowerCase();
  if (/(央行|货币|利率|降准|降息|财政|国务院|发改委|证监会|资管|监管|政策|法案|国常会|政治局|两会|税收|补贴|社保|公积金|mlf|lpr)/.test(t)) return '政策';
  if (/(美联储|美股|特朗普|拜登|白宫|欧洲|日本|韩国|地缘|俄乌|中东|国际|加息|非农|fomc|英伟达|苹果|特斯拉|谷歌|微软|欧央行|日央)/.test(t)) return '国际';
  if (/(营收|净利|业绩|回购|减持|增持|并购|重组|上市|退市|分红|募资|中标|签约|订单|研报|发债|定增)/.test(t)) return '公司';
  return '市场';
}

/**
 * 东方财富 7×24 快讯（时政财经热点）
 */
async function fetchKuaixunNews(pageSize = 40) {
  const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist?client=pc&type=1&m=api&_=${Date.now()}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://kuaixun.eastmoney.com/' },
      timeout: 9000,
    });
    const data = resp.data;
    const list = (data && data.data && data.data.list) || data.list || [];
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (const it of list) {
      let dateStr = '';
      let ts = it.datetime;
      if (typeof ts === 'number') {
        if (ts < 1e12) ts = ts * 1000;
        const d = new Date(ts);
        if (!isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 16).replace('T', ' ');
      } else if (typeof ts === 'string' && ts) {
        dateStr = ts.replace('T', ' ').slice(0, 16);
      }
      const title = (it.title || '').replace(/<\/?em>/g, '').trim();
      const summary = (it.content || it.summary || '').replace(/<\/?em>/g, '').trim();
      if (!title) continue;
      out.push({
        title,
        summary: summary.slice(0, 120),
        source: it.source || it.mediaName || '东方财富快讯',
        url: it.url || '',
        date: dateStr,
      });
    }
    return out;
  } catch (e) {
    console.error('Kuaixun hot news failed:', e.message);
    return [];
  }
}

/**
 * 获取今日财经热点（带缓存 + 兜底）
 */
async function getHotNews(force = false) {
  const TTL = 10 * 60 * 1000;
  const now = Date.now();
  if (!force && hotNewsCache.data && now - hotNewsCache.ts < TTL) {
    return hotNewsCache.data;
  }
  let items = await fetchKuaixunNews();
  if (!items.length) {
    // 兜底：用内容搜索取泛财经要闻
    try {
      const fallback = await fetchEastmoneyContentNews('财经 股市 政策', 30);
      items = fallback.map(n => ({ ...n, date: (n.date || '').slice(0, 16) }));
    } catch (e) { items = []; }
  }
  if (!items.length) {
    const empty = { source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items: [], error: '暂未获取到最新快讯（可能网络受限或接口变更）' };
    hotNewsCache = { ts: now, data: empty };
    return empty;
  }
  // 去重 + 分类 + 情绪 + 排序
  const seen = new Set();
  items = items.filter(n => {
    if (!n.title || seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  }).map(n => ({
    ...n,
    category: classifyCategory(n.title, n.summary),
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
  }));
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  items = items.slice(0, 24);
  const result = { source: '东方财富 7×24 快讯', updated: new Date().toISOString(), items };
  hotNewsCache = { ts: now, data: result };
  return result;
}


/**
 * Search financial news from Eastmoney content search API
 * Works for both Chinese and international stocks (search by name/keyword)
 */
async function fetchEastmoneyContentNews(keyword, pageSize = 15) {
  const param = JSON.stringify({
    uid: "",
    keyword: keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize: pageSize,
        preTag: "",
        postTag: ""
      }
    }
  });

  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery&param=${encodeURIComponent(param)}`;

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://so.eastmoney.com/' },
      timeout: 8000
    });

    // Parse JSONP response
    const text = resp.data;
    const jsonStr = text.replace(/^jQuery\(/, '').replace(/\);?\s*$/, '');
    const data = JSON.parse(jsonStr);

    const articles = data?.result?.cmsArticleWebOld || [];

    return articles.map(a => ({
      title: (a.title || '').replace(/<\/?em>/g, ''),
      summary: (a.content || '').replace(/<\/?em>/g, '').slice(0, 200),
      source: a.mediaName || a.source || '东方财富',
      url: a.url || '',
      date: a.date || '',
    }));
  } catch (e) {
    console.error('Eastmoney content news failed:', e.message);
    return [];
  }
}

/**
 * Fetch stock-specific announcements from Eastmoney
 */
async function fetchEastmoneyAnnouncements(stockCode, exchange) {
  // secid format: 1.600519 (SH) or 0.000001 (SZ)
  const secid = exchange === 'SH' ? `1.${stockCode}` : `0.${stockCode}`;
  const url = `https://np-anotice.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web&stock_list=${stockCode}`;

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' },
      timeout: 8000
    });

    const items = resp.data?.data?.list || [];

    return items.map(item => ({
      title: item.title || '',
      summary: '',
      source: '东方财富公告',
      url: `https://np-cnotice.eastmoney.com/api/content/ann?art_code=${item.art_code}`,
      date: item.notice_date ? item.notice_date.slice(0, 10) : '',
    }));
  } catch (e) {
    console.error('Eastmoney announcements failed:', e.message);
    return [];
  }
}

/**
 * Main news fetch function
 * Uses Eastmoney content search for all markets
 */
async function getNews(input, stockName) {
  const { detectMarket } = require('./stockData');
  const info = detectMarket(input);

  let newsList = [];
  const searchKeyword = stockName || input;

  // Use Eastmoney content search for all markets
  const [contentResult, announceResult] = await Promise.allSettled([
    fetchEastmoneyContentNews(searchKeyword),
    info.market === 'CN' ? fetchEastmoneyAnnouncements(input, info.exchange) : Promise.resolve([])
  ]);

  if (contentResult.status === 'fulfilled') newsList.push(...contentResult.value);
  if (announceResult.status === 'fulfilled') newsList.push(...announceResult.value);

  // Deduplicate by title
  const seen = new Set();
  newsList = newsList.filter(n => {
    if (!n.title || seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });

  // Add sentiment analysis
  newsList = newsList.map(n => ({
    ...n,
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || ''))
  }));

  // Sort by date (newest first)
  newsList.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return newsList.slice(0, 20);
}

// ---- 时间衰减（时效性） ----
// 新闻情绪影响随时间递减：当天 1.0、1 天前 0.7、2 天前 0.5、3 天及以上 0.3。
// 用于个股新闻与板块新闻的情绪聚合，避免旧消息长期主导当前情绪。
function _parseNewsDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const d = new Date(s.replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

function _newsTimeDecayWeight(pubDate, base = new Date()) {
  if (!pubDate) return 0.5;
  const days = Math.max(0, (base - pubDate) / 86400000);
  if (days < 1) return 1.0;
  if (days < 2) return 0.7;
  if (days < 3) return 0.5;
  return 0.3;
}

// ---- 板块/赛道关键词映射（板块联动传导）----
// 个股行业名 → 广义赛道关键词。用于把「板块级/赛道级」消息事件（如 mRNA 疫苗催化生物制药）
// 传导到个股情绪，解决"个股新闻源抓不到板块级催化"的问题。关键词按行业常识扩展，越靠前越相关。
const SECTOR_KEYWORDS = {
  '医疗器械': ['医药生物', '创新药', '疫苗', '生物医药', 'mRNA', '医疗', '医疗器械'],
  '体外诊断': ['医药生物', '创新药', '生物医药', '医疗', '体外诊断'],
  '生物制品': ['医药生物', '创新药', '疫苗', 'mRNA', '生物医药', '生物制品'],
  '化学制药': ['医药生物', '创新药', '生物医药', '化学制药'],
  '中药': ['医药生物', '创新药', '生物医药', '中药'],
  '医疗服务': ['医药生物', '医疗', '创新药', '生物医药'],
  '证券': ['证券', '非银金融', '券商', '资本市场'],
  '券商信托': ['证券', '非银金融', '券商'],
  '保险': ['保险', '非银金融'],
  '银行': ['银行', '金融', '非银金融'],
  '半导体': ['半导体', '芯片', '集成电路', '国产替代', '光刻'],
  '消费电子': ['消费电子', '半导体', '芯片', '电子'],
  '白酒': ['白酒', '食品饮料', '消费', '酿酒'],
  '食品饮料': ['食品饮料', '消费', '白酒'],
  '新能源': ['新能源', '光伏', '风电', '储能', '锂电', '电池'],
  '光伏': ['光伏', '新能源', '储能', '电力设备'],
  '锂电池': ['锂电', '电池', '新能源', '新能源车'],
  '新能源汽车': ['新能源车', '汽车', '锂电', '智能驾驶'],
  '人工智能': ['人工智能', 'AI', '算力', '大模型', '光模块'],
  '算力': ['算力', 'AI', '人工智能', '光模块', '数据中心'],
  '通信': ['通信', '5G', '算力', '光模块', '卫星互联网'],
  '计算机': ['计算机', '软件', '信创', '人工智能', '数据要素'],
  '军工': ['军工', '国防军工', '航天', '卫星', '航空'],
  '有色': ['有色金属', '黄金', '铜', '锂', '稀土'],
  '煤炭': ['煤炭', '能源', '动力煤'],
  '石油石化': ['石油', '石化', '油气', '能源'],
  '钢铁': ['钢铁', '建材', '基建'],
  '房地产': ['房地产', '地产', '基建'],
  '建筑装饰': ['建筑', '基建', '地产'],
  '交通运输': ['交运', '物流', '航运', '航空'],
  '农业': ['农业', '种业', '养殖', '粮食'],
  '环保': ['环保', '碳中和', '生态'],
};

// 归一化行业名后取广义赛道关键词；无命中则回退行业名自身
function _broadSectorKeywords(industryName) {
  const norm = (industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  if (!norm) return [industryName].filter(Boolean);
  for (const [k, v] of Object.entries(SECTOR_KEYWORDS)) {
    const kn = k.replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
    if (norm.includes(kn) || kn.includes(norm)) {
      return v;
    }
  }
  return [industryName].filter(Boolean);
}

/**
 * 板块/赛道级消息情绪（板块联动传导）
 * 按「个股行业名 + 广义赛道关键词」抓板块级新闻（东财内容搜索，本机可用），
 * 聚合情绪并传导到个股。解决"个股新闻源抓不到板块级催化"的问题。
 * 额外做「重大事件精匹配」：命中事件级关键词（mRNA/三期/主要终点/里程碑等）时标记并提升敏感性。
 * 返回 { symbol, industryName, count, positive, negative, neutral, avgScore, signal, samples, keywords, note, events, eventBoosted }
 * 20260821a：增加 symbol/industryName 回显与 keywords 一致性校验，防止跨股/跨行业污染后难以排查。
 */
// 事件级关键词：用于从板块新闻里精确识别"重大催化事件"（而非泛泛的板块涨跌）
const EVENT_KEYWORDS = [
  'mRNA', '三期', 'III期', 'III 期', '主要终点', '里程碑', '历史性', '首创', '首个',
  '获批', '超预期', '重大进展', '突破', '达成', '成功', '关键进展', '突破性',
  '达到主要终点', '无进展生存', '完全缓解', '上市', '商业化', '中美双报', '紧急使用授权',
];

/**
 * 板块/赛道级消息情绪（板块联动传导）
 * 按「个股行业名 + 广义赛道关键词」抓板块级新闻，聚合情绪并传导到个股。
 * Part B 增强（20260823i）：逐条按「主题与个股行业的关联度」加权——弱关联主题（如 mRNA→医疗器械）
 *   只给弱权重，不再按强关联打分；×1.3 重大事件加码仅在该事件所属主题关联度≥0.6（高关联）时施加。
 *   relevanceFor 可选：若传入主题，则对整个聚合信号再乘一次关联度（用于显式指定主题口径），默认 null 走逐条自动关联度。
 * 返回 { ..., signal, relevance, relevanceByKeyword, weakThemes, events, eventBoosted }
 */
async function getSectorNewsSentiment(industryName, name = '', symbol = '', relevanceFor = null) {
  const baseKeywords = _broadSectorKeywords(industryName);
  // 校验：keywords 必须与 industryName 有语义关联，否则极可能是跨行业污染
  const core = String(industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  const keywordsMatch = core && baseKeywords.some(k => k.includes(core) || core.includes(k));
  if (baseKeywords.length && core && !keywordsMatch) {
    console.warn(`[SectorNews] keywords 与 industryName 不匹配: symbol=${symbol} industryName=${industryName} keywords=${baseKeywords.join(',')}`);
  }
  if (!baseKeywords.length) {
    return { symbol, industryName, count: 0, positive: 0, negative: 0, neutral: 0, avgScore: null, signal: 0, samples: [], keywords: [], relevanceByKeyword: {}, relevance: null, weakThemes: [], note: '无行业名，跳过板块消息联动', events: [], eventBoosted: false, ok: false };
  }
  // 按「主题与个股行业的关联度」降序排列关键词：高关联主题优先认领新闻，弱关联主题退后，
  // 避免 mRNA/疫苗 这类弱主题抢先"认领"本该属于医疗器械/医药板块的通用新闻。
  const kwRel = baseKeywords.map(k => ({ k, rel: relevanceScore(industryName, k) }));
  kwRel.sort((a, b) => b.rel - a.rel);
  const keywords = kwRel.map(x => x.k).slice(0, 5);
  const relByKw = {};
  kwRel.forEach(x => { relByKw[x.k] = x.rel; });

  const seen = new Set();
  const news = [];
  for (const kw of keywords) {
    let items = [];
    try {
      items = await fetchEastmoneyContentNews(kw, 8);
    } catch (e) { items = []; }
    for (const n of items) {
      if (n.title && !seen.has(n.title)) { seen.add(n.title); news.push({ ...n, _kw: kw }); }
    }
    if (news.length >= 24) break; // 已足够
  }
  if (!news.length) {
    return { symbol, industryName, count: 0, positive: 0, negative: 0, neutral: 0, avgScore: null, signal: 0, samples: [], keywords, relevanceByKeyword: relByKw, relevance: null, weakThemes: keywords.filter(k => relByKw[k] < WEAK_THRESHOLD), note: `板块「${industryName}」未检索到相关消息`, events: [], eventBoosted: false, ok: false };
  }
  const base = new Date();
  const scored = news.map(n => ({
    ...n,
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
    weight: _newsTimeDecayWeight(_parseNewsDate(n.date), base),
    // 每条新闻归属其被抓取的关键词主题，关联度随主题而定（弱主题→弱权重）
    rel: relByKw[n._kw] != null ? relByKw[n._kw] : relevanceScore(industryName, n._kw || industryName),
  }));
  let pos = 0, neg = 0, neu = 0;
  for (const n of scored) {
    const l = n.sentiment.label;
    if (l === '积极' || l === '偏多') pos++;
    else if (l === '消极' || l === '偏空') neg++;
    else neu++;
  }
  // 重大事件精匹配：标题/摘要命中事件级关键词；但只有「高关联主题(≥0.6)」的事件才允许×1.3 加码
  const events = [];
  for (const n of scored) {
    const text = n.title + ' ' + (n.summary || '');
    const hit = EVENT_KEYWORDS.filter(k => text.includes(k));
    if (hit.length) events.push({ title: n.title.slice(0, 60), keywords: hit, sentiment: n.sentiment.label, relevance: n.rel, kw: n._kw });
  }
  const eventBoosted = events.some(e => (e.relevance != null ? e.relevance : 0) >= WEAK_THRESHOLD);

  // 原始平均分（参考） + 加权平均分（信号）：旧消息按时间衰减，且每条按主题关联度加权
  const avgScore = Math.round(scored.reduce((s, n) => s + (n.sentiment.score || 0), 0) / scored.length);
  const totalWeight = scored.reduce((s, n) => s + n.weight * n.rel, 0) || 1;
  const weightedAvgScore = Math.round(scored.reduce((s, n) => s + (n.sentiment.score || 0) * n.weight * n.rel, 0) / totalWeight);
  let signal = Math.max(-1, Math.min(1, weightedAvgScore / 50));
  // 命中「高关联」重大事件时提升敏感性：信号向多/空方向放大（×1.3 后截断）
  if (eventBoosted && signal !== 0) {
    signal = Math.max(-1, Math.min(1, signal * 1.3));
  }
  // 显式指定主题口径：对整个聚合信号再乘一次关联度（可选，默认 null 走逐条自动关联度）
  if (relevanceFor) {
    const rf = relevanceScore(industryName, relevanceFor);
    if (rf < WEAK_THRESHOLD) eventBoosted = false; // 显式弱主题不享受加码
    signal = Math.max(-1, Math.min(1, signal * rf));
  }
  const avgRel = Math.round(scored.reduce((s, n) => s + n.rel, 0) / scored.length * 1000) / 1000;
  const weakThemes = keywords.filter(k => relByKw[k] < WEAK_THRESHOLD);
  const note = `板块/赛道关键词：${keywords.slice(0, 3).join('、')}（按发布时间+主题关联度加权，均关联度 ${avgRel}）${eventBoosted ? '；命中高关联重大事件' : ''}`;
  if (symbol && industryName && !keywordsMatch) {
    console.warn(`[SectorNews] 返回数据疑似跨行业污染，已降级: symbol=${symbol} industryName=${industryName} keywords=${keywords.join(',')}`);
  }
  return {
    symbol,
    industryName,
    count: scored.length,
    positive: pos,
    negative: neg,
    neutral: neu,
    avgScore,
    weightedAvgScore,
    signal: Math.round(signal * 1000) / 1000,
    samples: scored.slice(0, 5).map(n => ({ title: n.title.slice(0, 40), score: n.sentiment.score, weight: n.weight, relevance: n.rel, kw: n._kw })),
    keywords,
    relevanceByKeyword: relByKw,
    relevance: avgRel,
    weakThemes,
    note: note + (keywordsMatch ? '' : ' · 关键词与行业名不一致（已标记）'),
    events: events.slice(0, 5),
    eventBoosted,
    ok: true,
  };
}

module.exports = { getNews, fetchEastmoneyContentNews, fetchEastmoneyAnnouncements, getHotNews, fetchKuaixunNews, classifyCategory, getSectorNewsSentiment, SECTOR_KEYWORDS, EVENT_KEYWORDS };
