/**
 * lib/ai/company.js —— aiAugment 领域子模块：公司介绍 + 供应链与成本 + 股东户数（拆分重构 202609）
 * ----------------------------------------------------------------
 * 本地事实类（webSearch=false，20260903f 降费）：事实由 lib/factStore.js 预下载，AI 纯推理总结；
 * 图片走 ai/images.attachImage（优先 AI 直链，Commons 兜底）。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore');
const { CACHE_DIR, CACHE_TTL_MS, SEMI_STATIC_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson } = require('./llm');
const { attachImage } = require('./images');

const COMPANY_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师。用户给你公司名称、代码、行业。请利用联网搜索，输出公司的综合介绍。
要求：只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"officeLocation":"公司总部/主要办公地点(城市+区或具体地址,如可查到)","productsServices":[{"name":"产品/服务名","desc":"一句话介绍与市场地位","imageUrl":"代表性图片直链(以.jpg/.jpeg/.png/.webp结尾,优先官方/Wikimedia,找不到填\"\")","imageQuery":"搜图关键词(品牌+产品,去括号)"}],"missionCulture":"经营宗旨/企业文化的核心表述(2-4句)","brands":["旗下知名自有品牌1","品牌2"],"patentCount":"专利数量(如发明专利+实用新型,给数字或区间,无可靠数据填\"\")","employeeCount":"员工人数(最新年报数,无则填\"\")","execAvgSalary":"高管平均薪酬(最新年报,如'约320万元'或区间,无则填\"\")","actualController":"实际控制人/实控人姓名,或'国有控股'/'股权分散'/'无实际控制人'等","actualControllerIntro":"对实控人的简要介绍(背景/持股主体/影响力;若不确定或没有填\"\")","majorEvents":[{"year":"YYYY","title":"事件标题","desc":"事件简述","impact":"对公司/行业的重大影响(如'利好:产能翻倍'/'利空:被处罚'/'中性:换帅')"}],"summary":"综合介绍摘要(2-4句)"}
要求：
1) majorEvents 检索该公司与所属行业近10年(财经网站/公司公告)的重大事件(并购重组、监管处罚、产能扩张、技术突破、行业政策、重大订单等),挑 3-8 条对公司或行业影响最大的；impact 必须明确利好/利空/中性。
2) brands 仅列旗下知名自有品牌；productsServices 列 3-6 个核心产品/服务,尽量给图片直链与搜图关键词。
3) 不要编造数字与图片链接；无可靠数据的字段填 "" 或空数组 []。
4) 金融/服务类公司（银行、保险、证券等）的 productsServices 应列其金融产品/服务（如零售金融、对公信贷、理财、承销保荐、资管、承保），而非实体商品；patentCount 等不适用字段填 ""。`;

// 本地模式 prompt：无联网，基于 F10 公司概况 + 主营构成生成综合介绍（未提供字段留空）
const COMPANY_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主要产品、主营构成明细含营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

请基于本地事实输出该公司综合介绍的严格 JSON（不要任何额外说明或 Markdown 代码块标记），格式：
{"officeLocation":"办公地点(本地事实提供省份则填,否则填\"\")","missionCulture":"经营宗旨/企业文化(本地事实未提供填\"\")","brands":["知名自有品牌(仅当本地事实明确提及)"],"productsServices":[{"name":"核心产品/服务名(来自主营构成)","desc":"一句话说明,必须引用真实营收占比/毛利率数字","imageUrl":"","imageQuery":"该产品搜图关键词"}],"majorEvents":[],"patentCount":"","employeeCount":"员工人数(本地事实提供才填,否则\"\")","execAvgSalary":"","actualController":"控股股东(本地事实提供才填)","actualControllerIntro":"","summary":"2-3句公司概况摘要"}

要求：
1) productsServices 从「主营构成明细」中选 3-6 个核心业务，desc 必须引用真实的占比/毛利率数字；
2) 凡本地事实未提供的字段一律填 "" 或 []，严禁用训练记忆编造（尤其 patentCount、majorEvents、execAvgSalary、brands）；
3) 金融/服务类公司 productsServices 列其金融产品/服务；
4) 只输出 JSON。`;

async function analyzeCompany({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_company.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：F10 概况 + 主营构成免费预下载（20260903f 降费）
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，概况+主营构成锚点未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factAnchor === localCtx.anchor) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factAnchor = null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factAnchor = localCtx.anchor;
    const ctxLen = COMPANY_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 300;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公司', symbol);
    messages = [
      { role: 'system', content: COMPANY_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地事实输出公司综合介绍 JSON（不要联网、不要编造）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    messages = [
      { role: 'system', content: COMPANY_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索后按 JSON 输出该公司的综合介绍（办公地点、产品服务与图片、经营宗旨/企业文化、知名品牌、专利数、员工人数、高管平均薪酬、实际控制人及介绍、近10年公司与行业重大事件）。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析公司介绍。', raw: content.slice(0, 500) };
    }
    const productsServices = [];
    const ps = Array.isArray(parsed.productsServices) ? parsed.productsServices : [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] || {};
      const imageLocal = await attachImage(symbol, 'c' + i, p.imageUrl, p.imageQuery || p.name);
      productsServices.push({
        name: String(p.name || '').trim(),
        desc: String(p.desc || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(p.imageQuery || '').trim(),
      });
    }
    const brands = Array.isArray(parsed.brands) ? parsed.brands.map(b => String(b).trim()).filter(Boolean) : [];
    const majorEvents = Array.isArray(parsed.majorEvents) ? parsed.majorEvents.map(e => ({
      year: String((e && e.year) || '').trim(),
      title: String((e && e.title) || '').trim(),
      desc: String((e && e.desc) || '').trim(),
      impact: String((e && e.impact) || '').trim(),
    })) : [];
    const result = {
      symbol,
      stockName: name || symbol,
      officeLocation: String(parsed.officeLocation || '').trim(),
      missionCulture: String(parsed.missionCulture || '').trim(),
      brands,
      patentCount: String(parsed.patentCount || '').trim(),
      employeeCount: String(parsed.employeeCount || '').trim(),
      execAvgSalary: String(parsed.execAvgSalary || '').trim(),
      actualController: String(parsed.actualController || '').trim(),
      actualControllerIntro: String(parsed.actualControllerIntro || '').trim(),
      productsServices,
      majorEvents,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
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

const SUPPLY_SYSTEM_PROMPT = `你是一名严谨的产业链与成本分析专家。用户给你公司名称、代码、行业。请联网搜索,输出供应链与成本分析。
要求：只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"chainPosition":"上游/中游/下游(三选一,可加括号说明,如'下游(白酒消费终端)'/ '中游(电池制造)')","materials":[{"name":"主要原材料/服务名","desc":"该材料/服务在公司生产/经营中的作用","priceTrend":"近1-3年价格变动趋势(如'上涨约20%'/'震荡下行'/'高位回落',无可靠数据填\"\")","impactOnCost":"该价格变动对公司营业成本的影响(如'成本上升侵蚀毛利'/'成本下降利好毛利',尽量量化)","imageUrl":"该原材料代表性图片直链(以.jpg/.jpeg/.png/.webp结尾,找不到填\"\")","imageQuery":"搜图关键词"}],"suppliers":[{"name":"主要供应商/供应方名","desc":"供应关系/依赖度/是否集中","imageUrl":"供应商相关图片直链(如企业Logo,找不到填\"\")","imageQuery":"搜图关键词"}],"costControl":["公司控制成本的典型方法1","方法2"],"summary":"供应链与成本分析摘要(2-4句)"}
要求：
1) chainPosition 明确公司处于产业链上/中/下游并给出理由。
2) materials 列出 3-6 个对成本影响最大的原材料/服务(如制造业的钢/铜/锂/芯片,消费业的包装/原料,服务业的外包/人力/租金),并说明价格变动与对营业成本的影响。
3) suppliers 列出 2-5 个主要供应商或供应方类型,说明依赖度。
4) costControl 给出 2-5 条真实可行的成本控制手段(如套期保值、长协锁价、规模集采、工艺改进、国产替代、数字化降本)。
5) 不要编造数字与图片链接;无可靠数据的字段填 "" 或空数组 []。
6) 金融/服务类公司（银行、保险、证券、信托等）请勿生硬套用制造业"原材料"框架：materials 改为其关键成本项（如资金成本/付息压力/人力成本/风控合规成本/赔付成本），suppliers 改为业务合作渠道或机构（如央行/同业/再保险/代销渠道/托管行），chainPosition 按"资金端—金融中介—客户端"链条定位（如"中游(金融中介)"）。此类公司高负债属经营常态，不要将其描述为风险。`;

// 本地模式 prompt：无联网，基于 F10 概况 + 主营构成（成本占比/毛利率）做产业链定位与成本结构分析
const SUPPLY_LOCAL_SYSTEM_PROMPT = `你是一名产业链与成本分析专家。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主营构成明细含各业务营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

请基于本地事实输出供应链与成本分析的严格 JSON（不要任何额外说明或 Markdown 代码块标记），格式：
{"chainPosition":"上游/中游/下游(三选一,可加括号说明)","materials":[{"name":"主要成本项/业务名(从主营构成或经营范围推导)","desc":"该项在公司经营中的作用","priceTrend":"本地事实未提供价格数据,固定填\"\")","impactOnCost":"基于成本占比/毛利率数字的定性影响(如'占营业成本大头,其毛利率波动直接决定公司整体盈利')","imageUrl":"","imageQuery":"搜图关键词"}],"suppliers":[],"costControl":["从经营范围/主营业务文本可推导的成本控制方法"],"summary":"供应链与成本分析摘要(2-4句)"}

要求：
1) chainPosition 依据行业与业务性质判断上/中/下游并给出理由；
2) materials 从「主营构成明细」中成本占比最高/毛利率最低的业务推导，impactOnCost 必须引用真实占比数字；priceTrend 一律填 ""，严禁编造价格涨跌数字；
3) suppliers 本地事实不含供应商名单，一律输出 []；
4) costControl 仅从主营业务/经营范围文本可推导时给出，否则空数组；
5) 金融/服务类公司按资金成本/人力成本框架分析，chainPosition 按"资金端—金融中介—客户端"定位；
6) 只输出 JSON。`;

async function analyzeSupplyChain({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_supply.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：F10 概况 + 主营构成（成本结构）免费预下载（20260903f 降费）
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.mode === 'local' && localCtx.ok && cached.factAnchor === localCtx.anchor) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  const isFinancial = /银行|保险|证券|信托|期货|基金|资管|财富|金控|租赁|财务|再保险|寿险|财险|人寿|太保|人保|平安/.test(ind || '') || /金融/.test(ind || '');
  const finNote = isFinancial ? ' 注意：该公司属金融服务类，请严格按金融服务框架分析（资金成本、业务合作渠道、而非制造业原材料供应商）。' : '';
  let messages, modelPick, mode, factAnchor = null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factAnchor = localCtx.anchor;
    const ctxLen = SUPPLY_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 300;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI供应链', symbol);
    messages = [
      { role: 'system', content: SUPPLY_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地事实输出供应链与成本分析 JSON（不要联网、不要编造数字）。${finNote}` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    messages = [
      { role: 'system', content: SUPPLY_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索后按 JSON 输出该公司的供应链与成本分析（产业链上中下游位置、主要原材料/服务及价格变动对成本的影响、主要供应商、成本控制方法）。${finNote}` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析供应链分析。', raw: content.slice(0, 500) };
    }
    const materials = [];
    const ms = Array.isArray(parsed.materials) ? parsed.materials : [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i] || {};
      const imageLocal = await attachImage(symbol, 's' + i, m.imageUrl, m.imageQuery || m.name);
      materials.push({
        name: String(m.name || '').trim(),
        desc: String(m.desc || '').trim(),
        priceTrend: String(m.priceTrend || '').trim(),
        impactOnCost: String(m.impactOnCost || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(m.imageQuery || '').trim(),
      });
    }
    const suppliers = [];
    const sp = Array.isArray(parsed.suppliers) ? parsed.suppliers : [];
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i] || {};
      const imageLocal = await attachImage(symbol, 'sup' + i, s.imageUrl, s.imageQuery || s.name);
      suppliers.push({
        name: String(s.name || '').trim(),
        desc: String(s.desc || '').trim(),
        imageUrl: '',
        imageLocal,
        imageQuery: String(s.imageQuery || '').trim(),
      });
    }
    const costControl = Array.isArray(parsed.costControl) ? parsed.costControl.map(c => String(c).trim()).filter(Boolean) : [];
    const result = {
      symbol,
      stockName: name || symbol,
      chainPosition: String(parsed.chainPosition || '').trim(),
      materials,
      suppliers,
      costControl,
      summary: String(parsed.summary || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
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

const HOLDERS_SYSTEM_PROMPT = `你是金融数据助手。请联网搜索指定 A 股公司最新的"股东户数"（普通股股东总数）及近几年变化趋势，并注明数据来源报告期。
严格只输出 JSON，不要任何额外说明或 Markdown 代码块标记，格式：
{"holderCount":123456,"asOf":"2025-03-31","trend":"近一年股东户数从约 50 万升至 58 万，散户参与度提升","source":"东方财富/公司季报"}
- holderCount 为整数（未知填 0）；asOf 为该数据对应报告期(YYYY-MM-DD)；trend 为 1-2 句变化描述；source 为来源说明。
不要编造数字；无可靠公开数据时 holderCount 填 0、trend 填"暂无可靠公开数据"。`;

// 本地模式 prompt：无联网能力，只能基于本地 F10 股东户数走势数据解读
const HOLDERS_LOCAL_SYSTEM_PROMPT = `你是严谨的金融数据分析师。你没有联网能力，只能基于下方「本地数据库（东方财富 F10）」提供的股东户数走势数据完成解读分析。

要求：
1) 严格只输出 JSON，不要任何额外说明或 Markdown 代码块，格式：
{"holderCount":123456,"asOf":"2025-03-31","trend":"...","source":"本地F10数据库"}
2) holderCount = 本地数据中最新一期的股东户数（整数，未知填 0）；asOf = 该数据对应报告期(YYYY-MM-DD)；
3) trend = 用 1-2 句话描述股东户数变化趋势（趋于集中还是分散、加速度/减速、是否拐点），必须基于所给序列计算，不得编造；
4) source 固定填写「本地F10数据库（东方财富）」；
5) 严禁编造本地数据之外的任何数字或信息。`;

// 本地模式：注入本地 F10 股东户数走势（不联网，使用 modelLocal）
async function buildLocalHoldersContext(symbol) {
  try {
    const sd = require('./shareholderData');
    const data = await sd.getShareholdersData(symbol);
    const trend = (data && Array.isArray(data.holderCountTrend)) ? data.holderCountTrend : [];
    if (!trend.length) return { ok: false, text: '', asOf: '', seriesCount: 0 };
    const recent = trend.slice(-8);
    const lines = recent.map(r => {
      const chg = r.changeRatio != null ? ` 环比 ${r.changeRatio > 0 ? '+' : ''}${r.changeRatio}%` : '';
      const focus = r.focus ? ` 集中度：${r.focus}` : '';
      return `报告期 ${r.date}：股东户数 ${r.holderNum.toLocaleString('zh-CN')} 户${chg}${focus}`;
    });
    return {
      ok: true,
      text: lines.join('\n'),
      asOf: recent[recent.length - 1].date,
      seriesCount: trend.length,
    };
  } catch (e) {
    console.error('[buildLocalHoldersContext] failed:', e.message);
    return { ok: false, text: '', asOf: '', seriesCount: 0 };
  }
}

async function analyzeShareholdersAI({ symbol, stockName, force, mode }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const localCtx = await buildLocalHoldersContext(symbol);
  const wantLocal = mode === 'local' && localCtx.ok;
  const cacheFile = path.join(CACHE_DIR, `${symbol}_holders.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - (cached.cachedAt || 0) < CACHE_TTL_MS) {
        // 模式匹配：请求模式与缓存模式不一致即作废重算（双向对称，避免 web 请求复用 local 缓存导致 source/modelKind 标注错乱）
        if (wantLocal !== (cached.mode === 'local')) { /* fall through to regenerate */ }
        else return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let modelPick, systemPrompt, userMsg, modeLabel;
  if (wantLocal) {
    modelPick = pickModelFor(cfg, 'local');
    systemPrompt = HOLDERS_LOCAL_SYSTEM_PROMPT;
    userMsg = `以下是本地数据库（东方财富 F10）中的股东户数走势数据：\n\n${localCtx.text}\n\n请严格基于以上本地数据完成解读分析（不要联网、不要编造数字），输出 JSON：{holderCount, asOf, trend, source}。`;
    modeLabel = 'local';
  } else {
    modelPick = pickModelFor(cfg, 'web');
    systemPrompt = HOLDERS_SYSTEM_PROMPT;
    userMsg = `请联网搜索 A 股公司「${stockName || symbol}」（代码 ${symbol}）最新的股东户数（普通股股东总数）及近几年变化趋势，并注明数据来源报告期。`;
    modeLabel = 'web-fallback';
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ], { webSearch: modelPick.webSearch });
    const parsed = extractJson(content);
    const result = {
      symbol,
      stockName: stockName || '',
      holderCount: parsed && Number(parsed.holderCount) ? Number(parsed.holderCount) : 0,
      asOf: parsed ? String(parsed.asOf || '') : '',
      trend: parsed ? String(parsed.trend || '') : '',
      source: parsed ? String(parsed.source || '') : '',
      date: new Date().toISOString().slice(0, 10),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      modelKind: modelPick.isLocal ? 'local' : 'web',
      mode: modeLabel,
      localDataUsed: wantLocal,
      localAsOf: wantLocal ? localCtx.asOf : '',
      localSeriesCount: wantLocal ? localCtx.seriesCount : 0,
      cachedAt: Date.now(),
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
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

module.exports = { analyzeCompany, analyzeSupplyChain, analyzeShareholdersAI };
