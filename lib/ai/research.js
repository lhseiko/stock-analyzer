/**
 * lib/ai/research.js —— aiAugment 领域子模块：研报总结 + 公告总结（拆分重构 202609）
 * ----------------------------------------------------------------
 * 本地事实类（webSearch=false）：事实由 lib/factStore.js 预下载入 SQLite，AI 只做纯推理总结；
 * 本地事实缺失时自动降级为联网检索（web-fallback），结果标注 mode 字段。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore');
const { CACHE_DIR, SEMI_STATIC_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractSources } = require('./llm');

// ---------- 研报 · AI 联网总结 ----------
const RESEARCH_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股、港股与美股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司近一年（12个月）主流券商/研究机构发布的研报，并总结核心结论。

要求：
1) 综合多家机构的一致预期与分歧；
2) 概括近期评级分布（买入/增持/中性/减持等）以及平均或最高目标价（如有可靠来源）；
3) 提炼 3-5 条核心投资逻辑与主要风险提示；
4) 每条尽量标注信息来源（机构名）与日期；
5) 若某类信息无可靠公开来源，请明确写"暂无可靠公开研报信息"，不要编造数字。
用简体中文分点结构化输出，总长控制在 700 字以内。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的东财研报列表做纯推理汇总
const RESEARCH_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。你没有联网能力，也不需要联网。下方「本地研报列表」由系统从东方财富研报接口预先下载（近一年券商研报的机构、评级、目标价、预测EPS/PE与标题），是本轮分析唯一允许引用的事实来源。

要求：
1) 综合多家机构的一致预期与分歧（结合预测EPS/PE区间）；
2) 概括评级分布（买入/增持/中性/减持等）以及目标价区间（最高/最低/平均，仅当列表提供时）；
3) 从研报标题中提炼 3-5 条核心投资逻辑与主要风险提示；
4) 每条标注机构名与发布日期；
5) 严禁使用你训练记忆中的任何机构观点、目标价或评级；列表未覆盖的信息一律写"本地研报列表未提供"，不要编造数字。
用简体中文分点结构化输出，总长控制在 700 字以内。`;

async function analyzeResearchReports({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_research.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：东财研报列表免费预下载，无需联网检索（抓取失败则兜底走联网）
  const facts = await factStore.getResearchFacts(symbol).catch(() => ({ ok: false }));
  const localCtx = facts.ok ? factStore.buildResearchContext(facts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，研报列表最新一篇日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = RESEARCH_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI研报', symbol);
    messages = [
      { role: 'system', content: RESEARCH_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地研报列表完成总结分析（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI研报] ${symbol} 本地研报列表不可用（${(facts && facts.message) || '未知'}），降级为联网模型检索`);
    messages = [
      { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司近一年券商研报，输出总结。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol, stockName: name || symbol, summary: content, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !facts.isFresh || !!facts.staleServed, fetchedAt: facts.fetchedAt,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

// ---------- 公告 · AI 联网总结 ----------
const ANNOUNCEMENT_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司近一年（12个月）的重要公告与事项，并总结结论。

重点覆盖以下类别，逐类说明（无该类信息则写"无"）：
1) 股东增持：增持价格上限、已增持数量/金额、剩余未完成金额；
2) 股东减持：已完成数量/金额、剩余未减持数量/金额、截止日期；
3) 股份回购：完成度（%）、回购均价、回购金额；
4) 高管/董事变动（增聘、离任、被查等）；
5) 证监会立案或行政处罚、监管函、问询函；
6) 重大诉讼或仲裁（含对公司影响）。

要求：用简体中文分点结构化输出；每条尽量标注日期与来源（巨潮/交易所/东方财富等）；不要编造无来源的数字；若确无公开信息写"暂无相关公开公告"。总长一般不超过 1000 字；若内容丰富可能超出，先精简提炼（保留关键数字、日期与来源，不得改变原意），严禁生硬截断。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的公告列表（巨潮优先/东财兜底）做纯推理总结
const ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。你没有联网能力，也不需要联网。下方「本地公告列表」由系统从巨潮资讯网/东方财富预先下载（近一年公告标题、日期、系统自动分类、正文关键数字提取），是本轮分析唯一允许引用的事实来源。

重点覆盖以下类别，逐类说明（无该类信息则写"无"）：
1) 股东增持：增持价格上限、已增持数量/金额、剩余未完成金额；
2) 股东减持：已完成数量/金额、剩余未减持数量/金额、截止日期；
3) 股份回购：完成度（%）、回购均价、回购金额；
4) 高管/董事变动（增聘、离任等，按公告标题归纳）；
5) 立案/处罚/监管（如有）；
6) 重大诉讼或仲裁（如有）。

要求：
- 只做归纳、计数与时间线整理，数字一律取自列表括号内的系统提取值；提取值为空的不要自行补充数字；
- 严禁使用你训练记忆中的任何公告内容；列表未覆盖的信息写"本地公告列表未提供"；
- 用简体中文分点结构化输出，总长一般不超过 1000 字；若内容丰富可能超出，先精简提炼（不得改变原意）。`;

async function analyzeAnnouncements({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_announcements.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：公告列表免费预下载（巨潮优先/东财兜底），无需联网检索
  const facts = await factStore.getAnnouncementFacts(symbol, name).catch(() => ({ ok: false }));
  const localCtx = facts.ok ? factStore.buildAnnouncementContext(facts) : { ok: false };
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，公告列表最新一条日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公告', symbol);
    messages = [
      { role: 'system', content: ANNOUNCEMENT_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地公告列表完成总结分析（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI公告] ${symbol} 本地公告列表不可用（${(facts && facts.message) || '未知'}），降级为联网模型检索`);
    messages = [
      { role: 'system', content: ANNOUNCEMENT_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司近一年重要公告与事项，输出总结。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol, stockName: name || symbol, summary: content, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factMaxDate, factCount, stale: !facts.isFresh || !!facts.staleServed, fetchedAt: facts.fetchedAt,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

module.exports = { analyzeResearchReports, analyzeAnnouncements };
