/**
 * 首页「今日最热股票投资话题」聚合模块
 * --------------------------------------------------------------
 * 通过 AI 联网，从同花顺、雪球、东方财富三大平台获取当天最热的股票投资热点话题，
 * 并做简要分析。
 *
 * 数据获取策略（best-effort，任一源失败不影响整体）：
 *   1) 尽量直接 HTTP 抓取三大平台的「人气/热度/快讯」榜单，作为真实话题来源 + 来源标注；
 *   2) 把抓取到的标题作为证据喂给 LLM（qwen/glm 带联网搜索），由 AI 去重聚合、
 *      提炼当天最热的几条投资话题，并给出简短分析（关联个股、多空倾向、驱动逻辑）；
 *   3) 若三大平台全部抓取失败（如沙箱无外网），仍调用 LLM 联网搜索补全，保证有内容；
 *   4) 无 AI Key 时，退化为只展示已抓取到的原始话题（按平台分组），并提示配置 Key。
 *
 * 所有外部调用均 best-effort 超时兜底，绝不抛异常拖垮首页。
 */
const axios = require('axios');
const ai = require('./aiAugment');
const { PROVIDERS } = ai;
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { decorateRules } = require('./ruleCore');
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 内存缓存：按自然日键，盘中 TTL 60 分钟（20260903f 降费：20→60 分钟，热点为半静态内容）
// 非交易时段（收盘后/开盘前/周末）直接复用已有缓存，不再刷新，避免盘后无效 LLM 调用
let _cache = { ts: 0, date: '', data: null };
const TTL = 60 * 60 * 1000;

// 是否处于 A 股交易时段（工作日 09:15-15:05；法定节假日未感知，属 best-effort）
function _isMarketHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hm = now.getHours() * 100 + now.getMinutes();
  return hm >= 915 && hm <= 1505;
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

// 给外部 HTTP 调用加超时兜底（项目红线：请求内不可阻塞事件循环）
function pTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'http') + ' 超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// 同花顺人气榜（best-effort，多候选端点兜底）
async function _getJSON(url, headers) {
  const resp = await axios.get(url, { headers: { 'User-Agent': UA, ...headers }, timeout: 9000 });
  let raw = resp.data;
  if (typeof raw === 'string') {
    const m = raw.match(/\(([\s\S]*)\)\s*;?\s*$/);
    if (m) raw = JSON.parse(m[1]);
  }
  return raw;
}

async function fetch10jqkaHot() {
  // 多个候选端点依次尝试（接口路径随版本可能变化），任一命中即用
  const candidates = [
    { url: 'https://dq.10jqka.com.cn/front/hot_list/data/', ref: 'https://t.10jqka.com.cn/' },
    { url: 'https://dq.10jqka.com.cn/v2/hot/rank?type=1&last_time=0', ref: 'https://t.10jqka.com.cn/' },
    { url: 'https://t.10jqka.com.cn/api/feed/hotrank?type=1', ref: 'https://t.10jqka.com.cn/' },
  ];
  for (const c of candidates) {
    try {
      const raw = await _getJSON(c.url, { Referer: c.ref });
      const d = raw && (raw.d || raw.data || raw);
      const list = d && (d.rank_list || d.list || d.items || d.hot_list || d.all_stock || (raw.items));
      if (Array.isArray(list) && list.length) {
        const items = list.slice(0, 20).map(it => ({
          title: it.name || it.stock_name || it.title || (it.stock && it.stock.name) || '',
          code: it.code || it.stock_code || (it.stock && it.stock.code) || '',
          url: '',
        })).filter(i => i.title);
        if (items.length) return { source: '同花顺', ok: true, items: items.slice(0, 15), note: `人气榜 ${items.length} 条` };
      }
    } catch (e) { /* 尝试下一个候选 */ }
  }
  return { source: '同花顺', ok: false, items: [], note: '抓取失败：候选端点均不可用' };
}

// 雪球热门话题/热门股票（best-effort，需先取 cookie）
async function fetchXueqiuHot() {
  const base = 'https://xueqiu.com';
  const jar = {};
  try {
    // 1) 先访问首页拿 xq_a_token cookie
    const r0 = await axios.get(base + '/', {
      headers: { 'User-Agent': UA },
      timeout: 9000,
      maxRedirects: 5,
    });
    const setCookie = r0.headers && (r0.headers['set-cookie'] || []);
    setCookie.forEach(c => {
      const kv = String(c).split(';')[0];
      const idx = kv.indexOf('=');
      if (idx > 0) jar[kv.slice(0, idx)] = kv.slice(idx + 1);
    });
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    // 2) 多个候选端点依次尝试
    const candidates = [
      { url: 'https://xueqiu.com/statuses/topic/list.json?size=20&_=' + Date.now(), pick: d => d.list || d.topics },
      { url: 'https://xueqiu.com/service/v5/stock/hot_list?type=10&size=15&_=' + Date.now(), pick: d => d.data && (d.data.items || d.data.list) },
    ];
    for (const c of candidates) {
      try {
        const resp = await axios.get(c.url, {
          headers: { 'User-Agent': UA, Referer: base + '/', Cookie: cookie || '' },
          timeout: 9000,
        });
        const items = c.pick(resp.data) || [];
        if (Array.isArray(items) && items.length) {
          const out = items.slice(0, 15).map(it => ({
            title: it.title || it.name || it.view_title || (it.target && it.target.title) || '',
            code: (it.target && (it.target.symbol || it.target.code)) || it.symbol || (it.stock && it.stock.symbol) || '',
            url: it.target && it.target.url ? base + it.target.url : (it.id ? base + '/t/' + it.id : ''),
          })).filter(i => i.title);
          if (out.length) return { source: '雪球', ok: true, items: out, note: `热门话题 ${out.length} 条` };
        }
      } catch (e) { /* 尝试下一个候选 */ }
    }
    return { source: '雪球', ok: false, items: [], note: '话题列表为空或需登录' };
  } catch (e) {
    return { source: '雪球', ok: false, items: [], note: '抓取失败：' + (e.message || '').slice(0, 80) };
  }
}

// 东方财富 7×24 快讯 / 公告（best-effort，快讯 404 时降级为最新公告）
async function fetchEastmoneyHot() {
  const kxUrl = 'https://newsapi.eastmoney.com/kuaixun/v1/getlist?client=pc&type=1&m=api&_=' + Date.now();
  try {
    const resp = await axios.get(kxUrl, {
      headers: { 'User-Agent': UA, Referer: 'https://kuaixun.eastmoney.com/' },
      timeout: 9000,
    });
    const data = resp.data;
    const list = (data && data.data && data.data.list) || data.list || [];
    if (!Array.isArray(list) || !list.length) return { source: '东方财富', ok: false, items: [], note: '快讯为空' };
    const out = list.slice(0, 25).map(it => ({
      title: (it.title || '').replace(/<\/?em>/g, '').trim(),
      code: (it.relatedStock && (it.relatedStock.code || it.relatedStock.symbol)) || '',
      url: it.url || '',
    })).filter(i => i.title).slice(0, 15);
    return { source: '东方财富', ok: true, items: out, note: `7×24 快讯 ${out.length} 条` };
  } catch (e) {
    // 快讯接口失效（沙箱常见 404）→ 降级为东财全市场最新公告
    try {
      const annUrl = 'https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=30&page_index=1&ann_type=A';
      const resp = await axios.get(annUrl, {
        headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' },
        timeout: 10000,
      });
      const list = resp.data?.data?.list || resp.data?.announcements || [];
      if (!Array.isArray(list) || !list.length) return { source: '东方财富', ok: false, items: [], note: '快讯 404，公告也为空' };
      const out = list.slice(0, 20).map(a => ({
        title: (a.title || '').trim(),
        code: ((a.codes && a.codes[0] && a.codes[0].stock_code) || '').trim(),
        url: '',
      })).filter(i => i.title).slice(0, 15);
      return { source: '东方财富', ok: true, items: out, note: `最新公告 ${out.length} 条（快讯接口 404 降级）` };
    } catch (e2) {
      return { source: '东方财富', ok: false, items: [], note: '抓取失败：' + (e.message || '').slice(0, 80) };
    }
  }
}

// ===== 涨停板池（本机稳定的真实热数据源）=====
// 说明：东财 push2（人气榜 stock_hot_rank_em）在本机被封/限流，而 stock_zt_pool_em
// 走 datacenter 通道实测可用。涨停股即当日最热标的，其「所属行业」可直接聚合为行业级话题。
async function findPythonForScript() {
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000, windowsHide: true });
      return c;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function fetchZtPoolHot() {
  const SOURCE = '东方财富涨停板池';
  try {
    const py = await findPythonForScript();
    if (!py) return { source: SOURCE, ok: false, items: [], note: '未找到 Python 解释器' };
    const script = path.join(__dirname, '..', 'scripts', 'hot_stocks_ak.py');
    const { stdout, stderr } = await execFileAsync(py, [script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (stderr) console.error('[HomeHotTopics] zt pool stderr:', stderr.slice(0, 300));
    const parsed = JSON.parse(stdout);
    if (!parsed || !parsed.ok) {
      return { source: SOURCE, ok: false, items: [], note: (parsed && parsed.error) || '脚本返回失败' };
    }
    return {
      source: SOURCE,
      ok: true,
      zt: parsed,   // { date,total,industries,items }
      items: (parsed.items || []).map(it => ({
        title: `${it.name} 涨停`, code: it.code, url: '',
        changePct: it.changePct, streak: it.streak, industry: it.industry,
      })),
      note: `涨停 ${parsed.total} 只，覆盖 ${(parsed.industries || []).length} 个行业`,
    };
  } catch (e) {
    return { source: SOURCE, ok: false, items: [], note: '抓取失败：' + String(e.message || e).slice(0, 80) };
  }
}

// 解析 LLM 返回的 JSON
function aiExtractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

// 由涨停池行业聚合成「真实投资话题」（纯本地计算，不依赖 LLM）
// 输入：fetchZtPoolHot 的返回；输出：[{topic, relatedStocks, sources, sentiment, analysis}]
function buildZtTopics(zt) {
  if (!zt || !zt.ok || !zt.zt) return [];
  const industries = zt.zt.industries || [];
  if (!industries.length) return [];
  const total = zt.zt.total || 0;
  return industries.slice(0, 8).map(ind => {
    const names = (ind.stocks || []).slice(0, 3).map(s => s.name).filter(Boolean);
    const streakTop = (ind.stocks || []).reduce((m, s) => Math.max(m, s.streak || 1), 1);
    const streakNote = streakTop >= 2 ? `，最高${streakTop}连板` : '';
    return {
      topic: `${ind.name}涨停潮（${ind.count}家）`,
      relatedStocks: (ind.stocks || []).slice(0, 3).map(s => s.name).filter(Boolean),
      sources: [zt.source || '东方财富涨停板池'],
      sentiment: '利好',
      analysis: `当日该行业 ${ind.count} 只个股涨停${streakNote}${names.length ? '，领涨：' + names.join('、') : ''}；全市场共 ${total} 只涨停（来源：东方财富涨停板池 ${zt.zt.date}）。`,
    };
  });
}

/**
 * 获取首页最热股票话题（带按自然日缓存 + ?refresh=1 强制刷新）
 * 返回 { ok, updated, date, sources:[{source,ok,count,note}], topics:[{topic, relatedStocks, sources, sentiment, analysis}], summary, hasKey, error? }
 */
async function getHomeHotTopics(force) {
  const today = _today();
  const now = Date.now();
  if (!force && _cache.data) {
    // 非交易时段（收盘后/开盘前/周末）：直接复用已有缓存，不产生任何抓取与 LLM 调用
    if (!_isMarketHours()) {
      return _cache.data;
    }
    if (_cache.date === today && now - _cache.ts < TTL) {
      return _cache.data;
    }
  }

  // 1) 并行抓取四大平台（best-effort；涨停板池为本机稳定的真实热数据源）
  const [thsh, xq, em, zt] = await Promise.all([
    pTimeout(fetch10jqkaHot(), 12000, '同花顺').catch(() => ({ source: '同花顺', ok: false, items: [], note: '超时' })),
    pTimeout(fetchXueqiuHot(), 12000, '雪球').catch(() => ({ source: '雪球', ok: false, items: [], note: '超时' })),
    pTimeout(fetchEastmoneyHot(), 12000, '东方财富').catch(() => ({ source: '东方财富', ok: false, items: [], note: '超时' })),
    pTimeout(fetchZtPoolHot(), 60000, '涨停板池').catch(() => ({ source: '东方财富涨停板池', ok: false, items: [], note: '超时' })),
  ]);
  const sources = [thsh, xq, em, zt];
  const totalFetched = sources.reduce((s, x) => s + (x.items ? x.items.length : 0), 0);

  // 1.5) 由涨停池行业聚合本地生成真实话题（不依赖 LLM，保证卡片必定有真数据）
  const localTopics = buildZtTopics(zt);

  const cfg = ai.loadConfig();
  // 三规则铺开：热点数据时效体检（涨停池按当日交易日计，日频档 + 交易日感知）
  const hotRules = decorateRules({
    dataTime: (zt && zt.ok && zt.zt && zt.zt.date) ? zt.zt.date : today,
    source: (zt && zt.ok) ? (zt.source || '东方财富涨停板池') : '暂无可用热点数据源',
    kind: 'daily',
    series: [], // 热点为当日快照而非时间序列，不做跨期边际
    name: '当日涨停家数',
  });
  const baseResult = {
    ok: true,
    updated: new Date().toISOString(),
    date: today,
    sources: sources.map(s => ({ source: s.source, ok: s.ok, count: s.items ? s.items.length : 0, note: s.note })),
    hasKey: !!cfg.apiKey,
    rules: hotRules,
    ztSummary: zt && zt.ok && zt.zt
      ? { date: zt.zt.date, total: zt.zt.total, industries: (zt.zt.industries || []).slice(0, 8) }
      : null,
  };

  // 2) 无 Key：优先展示涨停池生成的真实行业话题，其次才退回各平台原始条目
  if (!cfg.apiKey) {
    let topics = localTopics;
    let note = '涨停板池真实数据，按行业聚合（未经 AI 润色）。';
    if (!topics.length) {
      topics = [];
      for (const s of sources) {
        for (const it of (s.items || [])) {
          topics.push({ topic: it.title, relatedStocks: it.code ? [it.code] : [], sources: [s.source], sentiment: '未知', analysis: '' });
        }
      }
      note = '未配置 AI API Key，已展示各平台抓取到的原始条目。配置 Key 后可获得 AI 聚合分析。';
    }
    const result = {
      ...baseResult,
      topics: topics.slice(0, 20),
      summary: localTopics.length
        ? `今日全市场涨停 ${(zt && zt.zt && zt.zt.total) || 0} 只，热点集中于 ${localTopics.slice(0, 3).map(t => t.topic.replace(/（\d+家）/, '')).join('、')}。${note}`
        : `${note}请在「⚙️ AI 设置」中配置 Key 后刷新以获得简要分析。`,
      noKey: true,
    };
    _cache = { ts: now, date: today, data: result };
    return result;
  }

  // 3) 组装证据喂给 LLM
  const evidenceParts = [];
  for (const s of sources) {
    if (s.ok && s.items && s.items.length) {
      const lines = s.items.map(it => `- ${it.title}${it.code ? '（' + it.code + '）' : ''}`).join('\n');
      evidenceParts.push(`【${s.source}】当日最热话题/股票：\n${lines}`);
    }
  }
  const evidenceText = evidenceParts.join('\n\n');
  const fetchedNote = totalFetched > 0
    ? '以下是已抓取到的三大平台当日热点原始列表，请优先以此为依据进行聚合分析：\n\n' + evidenceText
    : '未能直接抓取到三大平台榜单（可能接口变动或网络受限）。请你联网搜索同花顺、雪球、东方财富今日（' + today + '）最热的股票投资话题，作为分析依据。';

  const prompt = `你是 A 股盘面热点分析师。请基于以下来自同花顺、雪球、东方财富三大平台的当日热点（或你联网搜索到的当日热点），
提炼出当天最值得关注的股票投资热点话题，并做简要分析。

要求：
1) 只输出严格 JSON，不要 Markdown 代码块，格式：
{"topics":[{"topic":"热点话题（8-20字，如『AI算力板块集体爆发』）","relatedStocks":["关联个股或代码，最多3个，无则空数组"],"sources":["同花顺","雪球","东方财富"（实际来源，可多个）],"sentiment":"利好|利空|中性|未知","analysis":"1-2 句简要分析：驱动逻辑/资金/事件（不超过 60 字）"}],"summary":"对今日整体热点的综述（2-3 句，含主线与多空氛围）"}
2) 取 6-9 个最热话题，覆盖不同主线（题材/行业/事件/政策/资金）；按热度排序。
3) 每个话题的 sources 必须如实标注其来源平台（来自上方原始列表的标对应平台；自行联网搜索的标『联网搜索』）。
4) 仅输出确有依据的话题，不编造；简体中文。`;

  function _buildFallbackTopics() {
    const fallbackTopics = [];
    for (const s of sources) {
      if (!s.ok || !s.items) continue;
      for (const it of s.items) {
        fallbackTopics.push({
          topic: it.title,
          relatedStocks: it.code ? [it.code] : [],
          sources: [s.source],
          sentiment: '未知',
          analysis: '',
        });
      }
    }
    return fallbackTopics;
  }

  try {
    const text = await pTimeout(ai.callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, [
      { role: 'system', content: '你是专业 A 股热点分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt + '\n\n' + fetchedNote },
    ], { webSearch: true }), 30000, 'homeHotTopics LLM');
    const parsed = aiExtractJson(text);
    let topics = [];
    if (parsed && Array.isArray(parsed.topics)) {
      topics = parsed.topics.map(t => ({
        topic: String(t.topic || '').trim(),
        relatedStocks: Array.isArray(t.relatedStocks) ? t.relatedStocks.map(String).filter(Boolean).slice(0, 3) : [],
        sources: Array.isArray(t.sources) ? t.sources.map(String).filter(Boolean) : [],
        sentiment: ['利好', '利空', '中性', '未知'].includes(t.sentiment) ? t.sentiment : '未知',
        analysis: String(t.analysis || '').trim(),
      })).filter(t => t.topic).slice(0, 9);
    }
    // LLM 成功但返回空话题时，也降级到原始榜单，避免卡片显示空
    if (!topics.length) {
      const fallbackTopics = _buildFallbackTopics();
      const result = {
        ...baseResult,
        topics: fallbackTopics.slice(0, 20),
        summary: fallbackTopics.length
          ? 'AI 聚合返回为空，已展示同花顺/雪球/东方财富抓取到的原始热点榜单。'
          : '当前未能抓取到有效热点榜单，且 AI 聚合返回为空，请稍后刷新或检查网络。',
        llmEmpty: true,
      };
      _cache = { ts: now, date: today, data: result };
      return result;
    }
    const summary = String((parsed && parsed.summary) || '').trim() || '（AI 未返回综述）';
    const result = { ...baseResult, topics, summary, sources: baseResult.sources, hasKey: true };
    _cache = { ts: now, date: today, data: result };
    return result;
  } catch (e) {
    const status = e.response && e.response.status ? e.response.status : 'N/A';
    const dataPreview = e.response && e.response.data
      ? JSON.stringify(e.response.data).slice(0, 400)
      : 'no response data';
    console.error('[HomeHotTopics] LLM failed:', {
      message: e.message,
      provider: cfg.provider,
      model: cfg.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      status,
      responsePreview: dataPreview,
    });
    // 降级：优先展示涨停池生成的真实行业话题，其次才退回各平台原始条目
    let topics = localTopics;
    let tail = '热点为涨停板池真实数据（按行业聚合），非公告拼凑。';
    if (!topics.length) {
      topics = _buildFallbackTopics();
      tail = '已展示各平台抓取到的原始条目。';
    }
    const reason = status === 'N/A'
      ? 'AI 分析服务未响应或超时'
      : `AI 分析服务返回 ${status}`;
    const result = {
      ...baseResult,
      topics: topics.slice(0, 20),
      summary: topics.length
        ? `${reason}；${tail}`
        : `${reason}，且未获取到有效热点数据，请检查网络或 AI API Key。`,
      llmError: String(e.message || '').slice(0, 200),
      llmStatus: status,
    };
    _cache = { ts: now, date: today, data: result };
    return result;
  }
}

module.exports = { getHomeHotTopics, fetch10jqkaHot, fetchXueqiuHot, fetchEastmoneyHot, fetchZtPoolHot };
