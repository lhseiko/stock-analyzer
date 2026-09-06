/**
 * lib/ai/products.js —— aiAugment 领域子模块：产品与客户分析（拆分重构 202609）
 * ----------------------------------------------------------------
 * 本地事实来自 factStore 主营构成（东财 F10 MainOperate）；图片下载走 ai/images
 * （downloadImage/searchCommonsImage），products 内联自己的下载编排、不经 attachImage，与拆分前一致。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore');
const { CACHE_DIR, IMG_DIR, CACHE_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson } = require('./llm');
const { downloadImage, searchCommonsImage } = require('./images');

const PRODUCTS_WEB_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，擅长提炼上市公司的"产品力"。用户会给你一家公司的名称、代码、行业与已知的主营产品（可能为空）。请利用联网搜索，补全该公司的主要产品与主要客户分析。

要求：
1) 只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"products":[{"name":"产品名","desc":"一句话描述该产品及市场地位","revenueShare":35.5,"importance":"核心","imageUrl":"https://...","imageQuery":"用于搜图的关键词(品牌+产品,去括号)"},{"name":"...","imageUrl":"","imageQuery":"茅台王子酒"}],"customers":[{"name":"客户名","desc":"客户关系/合作性质","revenueShare":20.0}],"summary":"产品型公司分析摘要（2-4句）"}
2) products：列出 3-6 个主要产品；revenueShare 为该产品占该公司营业收入的大致百分比（无可靠数据填 0，不要编造）；importance 为 核心/重要/次要；imageUrl【重要】为该产品的代表性图片直链，必须是可直接打开的图片地址（以 .jpg/.jpeg/.png/.webp 结尾），优先取自官方网站、Wikimedia Commons 或权威媒体；请尽量联网查找并返回真实图片链接，仅在确实无法找到时填 ""。imageQuery：用于联网搜索该产品图片的简洁关键词（品牌+产品，去掉括号与修饰语，如「飞天茅台」「茅台王子酒」），即使 imageUrl 为空也应尽量给出，便于后端兜底搜图。
3) customers：列出 2-5 个主要客户/客户类型；revenueShare 为该客户占营收的大致百分比（无则填 0）。
4) 若确无某类信息，对应数组返回空数组 []。不要编造数字。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的主营构成（含营收占比/毛利率）做纯推理
const PRODUCTS_LOCAL_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，擅长提炼上市公司的"产品力"。你没有联网能力，也不需要联网。下方「本地主营构成」由系统从东方财富 F10（MainOperate）预先下载，是本轮分析唯一允许引用的事实来源，包含最新年报期按产品/地区/行业维度的营收占比与毛利率。

要求：
1) 只输出一段严格的 JSON（不要任何额外说明或 Markdown 代码块标记），格式如下：
{"products":[{"name":"产品名","desc":"一句话描述该产品及市场地位","revenueShare":35.5,"importance":"核心","imageUrl":"","imageQuery":"用于搜图的关键词(品牌+产品,去括号,如 飞天茅台)"},{"name":"...","imageUrl":"","imageQuery":"茅台王子酒"}],"customers":[{"name":"客户名","desc":"客户关系/合作性质","revenueShare":20.0}],"summary":"产品型公司分析摘要（2-4句）"}
2) products：基于「本地主营构成」列出 3-6 个主要产品；revenueShare 必须取自主营构成中的营收占比（无对应项填 0，不要编造）；importance 据营收占比判定（核心/重要/次要）；imageUrl 必须填 ""（你无法联网取图）；imageQuery 尽量给出便于后端在 Wikimedia Commons 搜图的简洁关键词（品牌+产品，去掉括号与修饰语）。
3) customers：A股年报通常不逐家披露主要客户明细，若本地资料无客户依据，返回空数组 []；不要编造客户名称与占比。
4) 若确无某类信息，对应数组返回空数组 []。不要编造数字。`;

// 由 factStore 主营构成事实组装产品/客户分析上下文（供不联网模型推理）
function buildProductsContext(segment) {
  const dims = (segment && segment.dims) || {};
  const types = Object.keys(dims);
  if (!types.length) return { ok: false, reason: 'EMPTY' };
  const lines = [];
  for (const type of types) {
    const arr = dims[type] || [];
    if (!arr.length) continue;
    const l = arr.map(it => `- ${it.name}（营收占比 ${it.ratio != null ? it.ratio : '未知'}%${it.incomeYi ? `，营收 ${it.incomeYi} 亿元` : ''}${it.grossMargin != null ? `，毛利率 ${it.grossMargin}%` : ''}${it.costRatio != null ? `，成本占比 ${it.costRatio}%` : ''}）`).join('\n');
    lines.push(`■ 按${type}（${segment.year}年报期${segment.asOf ? '，' + segment.asOf : ''}）：\n${l}`);
  }
  if (!lines.length) return { ok: false, reason: 'EMPTY' };
  const text = [
    `【本地主营构成】来源：东方财富 F10（MainOperate）。以下为该公司最新年报期（${segment.year}${segment.asOf ? '，报告日 ' + segment.asOf : ''}）的分维度营收构成，请据此补全主要产品与营收占比，禁止编造本地数据未提供的数字：`,
    ...lines,
  ].join('\n');
  const count = types.reduce((s, t) => s + (dims[t] || []).length, 0);
  return { ok: true, text, maxDate: segment.asOf || '', year: segment.year, count };
}

async function analyzeProducts({ symbol, stockName, industry, force, companyName, f10Products, companyType }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_products.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：主营构成免费预下载（东财 F10 MainOperate），无需联网检索（抓取失败则兜底走联网）
  const segmentFacts = await factStore.getSegmentFacts(symbol).catch(() => ({ ok: false }));
  const localCtx = segmentFacts.ok ? buildProductsContext(segmentFacts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，主营构成年报期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  const f10 = Array.isArray(f10Products) && f10Products.length ? ('已知主营产品(来自财报)：' + f10Products.join('、') + '。') : '财报未提供主营产品明细。';
  const isProduct = companyType === 'growth' || /科技|医药|生物|医疗|电子|半导体|消费|食品|化工|材料|制造|新能源|汽车/.test(ind || '');

  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  const factsIsFresh = segmentFacts.ok ? segmentFacts.isFresh : true;
  const factsStale = segmentFacts.ok ? !!segmentFacts.staleServed : false;
  const factsFetchedAt = segmentFacts.ok ? segmentFacts.fetchedAt : null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = PRODUCTS_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI产品客户', symbol);
    const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${f10}${isProduct ? ' 该公司为产品型公司，产品分析尤为关键。' : ''}\n\n${localCtx.text}\n\n请严格基于以上本地主营构成输出主要产品与主要客户的结构化分析（不要联网、不要编造数字）。`;
    messages = [
      { role: 'system', content: PRODUCTS_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI产品客户] ${symbol} 本地主营构成不可用（${(segmentFacts && segmentFacts.message) || '未知'}），降级为联网模型检索`);
    const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${f10}${isProduct ? ' 该公司为产品型公司，产品分析尤为关键，请务必联网获取各主要产品的图片与营收占比。' : ''}请联网搜索后输出主要产品与主要客户的结构化分析。`;
    messages = [
      { role: 'system', content: PRODUCTS_WEB_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];
  }

  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.products)) {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析产品/客户。', raw: content.slice(0, 500) };
    }

    // 下载产品图片到本地缓存：本地模式 imageUrl 为空，直接用 Commons 按 imageQuery 搜图（免费，不走 LLM 计费）；
    // 联网降级模式优先用 AI 给的直链，失败再 Commons 兜底。
    const products = [];
    for (let i = 0; i < parsed.products.length; i++) {
      const p = parsed.products[i] || {};
      const pname = String(p.name || '').trim();
      const item = {
        name: pname,
        desc: String(p.desc || '').trim(),
        revenueShare: Number(p.revenueShare) || 0,
        importance: String(p.importance || '重要').trim(),
        imageUrl: String(p.imageUrl || '').trim(),
        imageQuery: String(p.imageQuery || '').trim(),
        imageLocal: '',
      };
      let cand = item.imageUrl;
      if (cand && /^https?:\/\//.test(cand)) {
        const lower = cand.toLowerCase();
        const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
        const fname = `${symbol}_p${i}.${ext}`;
        const fpath = path.join(IMG_DIR, fname);
        const ok = await downloadImage(cand, fpath);
        if (ok) item.imageLocal = `/api/ai/img/${fname}`;
      }
      if (!item.imageLocal && (item.imageQuery || pname)) {
        try { cand = await searchCommonsImage(item.imageQuery || pname); } catch {}
        if (cand && /^https?:\/\//.test(cand)) {
          const lower = cand.toLowerCase();
          const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
          const fname = `${symbol}_p${i}.${ext}`;
          const fpath = path.join(IMG_DIR, fname);
          const ok = await downloadImage(cand, fpath);
          if (ok) item.imageLocal = `/api/ai/img/${fname}`;
        }
      }
      if (item.name) products.push(item);
    }

    const customers = (parsed.customers || []).filter(c => c && c.name).map(c => ({
      name: String(c.name).trim(),
      desc: String(c.desc || '').trim(),
      revenueShare: Number(c.revenueShare) || 0,
    }));

    const result = {
      symbol,
      stockName: name || symbol,
      products,
      customers,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !factsIsFresh || factsStale, fetchedAt: factsFetchedAt,
    };
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

module.exports = { analyzeProducts };
