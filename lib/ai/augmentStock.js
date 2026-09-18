/**
 * AI 个股资料补全 + 投资亮点/雷点（202609 拆分重构：自 lib/aiAugment.js 迁入）
 * - augmentStock：本地事实（factStore 研报/公告/概况/主营构成）优先，缺失降级 web-fallback
 * - analyzeAspects：联网亮点/雷点分析（20260904a 最新报告期注入 + 后置校验）
 * 导出：augmentStock / analyzeAspects / buildAugmentContext（后者供门面备用，不进门面导出表）
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore'); // 20260903f 降费：本地事实库（研报/公告/概况/主营预下载）
// 202609 拆分重构：常量/配置迁至 ai/config（本模块只读使用，不触碰 runtime 可变状态）
const config = require('./config');
const { CACHE_DIR, CACHE_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = config;
// 202609 拆分重构：LLM 调用/模型选择/上下文预算/JSON 解析/来源提取迁至 ai/llm
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson, extractSources } = require('./llm');
// 202609 拆分重构：报告期标签/引用年份检测等 _extract* 后处理工具迁至 ai/earnings（导出供本模块复用）
const { _reportDateToLabel, _detectCitedYear } = require('./earnings');
const axios = require('axios');

// 20260916：从东方财富 F10 主要财务指标接口拉取「权威财务快照」，注入亮点/雷点 prompt，
// 杜绝 AI 自行编造财务数字（如 新洋丰 资产负债率凭空写出 48.60%，实际 39.76%）。
// 该接口与个股「基本面」卡片同源（lib/stockData.js fetchEastmoneyFundamentals），保证两处口径一致。
const ASPECTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function _emCodeFromSymbol(symbol) {
  const s = String(symbol);
  if (/^(sh|sz|bj)/i.test(s)) return s.toUpperCase();
  if (s.startsWith('6')) return 'SH' + s;
  if (s.startsWith('8') || s.startsWith('4')) return 'BJ' + s;
  return 'SZ' + s;
}

// 在已披露的同期报告中找到「去年同期」那一行（报告期年份 -1，月份日期相同）
function _findYoYRow(rows, reportDate) {
  if (!reportDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(reportDate));
  if (!m) return null;
  const target = `${parseInt(m[1], 10) - 1}-${m[2]}-${m[3]}`;
  for (const r of rows) {
    const d = r.REPORT_DATE || r.REPORTDATE || r.BBDATE || '';
    if (String(d).startsWith(target)) return r;
  }
  return null;
}

async function fetchAuthoritativeFinancials(symbol) {
  try {
    const emCode = _emCodeFromSymbol(symbol);
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${emCode}`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': ASPECTS_UA, Referer: 'https://emweb.securities.eastmoney.com/', Accept: 'application/json' },
      timeout: 15000
    });
    const rows = resp.data && resp.data.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r0 = rows[0]; // 最新一期
    const reportDate = r0.REPORT_DATE || r0.REPORTDATE || r0.BBDATE || '';
    const reportName = r0.REPORT_DATE_NAME || (reportDate ? _reportDateToLabel(reportDate.slice(0, 10)) : '');
    const yoy = _findYoYRow(rows, reportDate);
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const debt = num(r0.ZCFZL); // 资产负债率 %
    const debtYoY = (debt != null && yoy && num(yoy.ZCFZL) != null) ? +(debt - num(yoy.ZCFZL)).toFixed(2) : null;
    const np = num(r0.PARENTNETPROFIT); // 元
    return {
      ok: true,
      reportName,
      reportDate: reportDate.slice(0, 10),
      debtRatio: debt,                              // 资产负债率 %
      grossMargin: num(r0.XSMLL),                  // 销售毛利率 %
      netMargin: num(r0.XSJLL),                    // 销售净利率 %
      revenueYoY: num(r0.TOTALOPERATEREVETZ),      // 营业总收入同比 %
      netProfitYi: np != null ? +(np / 1e8).toFixed(2) : null, // 归母净利润 亿元
      profitYoY: num(r0.PARENTNETPROFITTZ),        // 归母净利润同比 %
      currentRatio: num(r0.LD),                    // 流动比率
      debtRatioYoY: debtYoY,                       // 资产负债率同比变化（百分点）
    };
  } catch (e) {
    console.error('[aspects] 权威财务快照获取失败：', e.message);
    return null;
  }
}

// 将快照格式化为注入 prompt 的文本；只列出非空的权威指标
function buildFinancialSnapshotText(snap) {
  if (!snap || !snap.ok) return '';
  const lines = [];
  lines.push(`【权威财务快照 · 东方财富 F10 主要财务指标（最新报告期：${snap.reportName || snap.reportDate}）】`);
  lines.push('以下数值为系统从权威数据源直接计算得到的真实值，你在亮点/雷点中必须【直接引用】这些数字，禁止自行估算、推算、四舍五入改写或编造任何一位：');
  if (snap.debtRatio != null) {
    let s = `- 资产负债率(ZCFZL)：${snap.debtRatio.toFixed(2)}%`;
    if (snap.debtRatioYoY != null) s += `（同比 ${snap.debtRatioYoY >= 0 ? '+' : ''}${snap.debtRatioYoY} 个百分点）`;
    lines.push(s);
  }
  const add = (label, v, unit) => { if (v != null) lines.push(`- ${label}：${v.toFixed(2)}${unit}`); };
  add('销售毛利率', snap.grossMargin, '%');
  add('销售净利率', snap.netMargin, '%');
  add('营业总收入同比', snap.revenueYoY, '%');
  if (snap.netProfitYi != null) lines.push(`- 归母净利润：${snap.netProfitYi.toFixed(2)} 亿元`);
  add('归母净利润同比', snap.profitYoY, '%');
  add('流动比率', snap.currentRatio, '');
  return lines.join('\n');
}

// 后置数字校验：AI 输出的资产负债率绝对数值若与权威快照偏差 > 1 个百分点，直接修正为权威值。
// 仅修正「资产负债率/负债率 X%」这类绝对数值，不动「上升 X 个百分点」等变化量表述。
function correctDebtRatioInText(text, authoritative) {
  if (typeof text !== 'string' || authoritative == null) return text;
  const re = /((?:资产负债率|负债率)[^0-9%、]{0,10})(\d+(?:\.\d+)?)\s*%/g;
  return text.replace(re, (full, prefix, numStr) => {
    const n = parseFloat(numStr);
    if (!isFinite(n)) return full;
    if (Math.abs(n - authoritative) > 1.0) {
      const fixedVal = (Math.round(authoritative * 100) / 100).toFixed(2);
      return `${prefix}${fixedVal}%`;
    }
    return full;
  });
}

const AUGMENT_WEB_SYSTEM_PROMPT = `你是一名专业的投资分析助手，熟悉中国A股、港股与美股市场。用户会给你一家公司的名称与代码，请你利用联网搜索能力，补全该公司公开资料中本地数据库未覆盖的部分。请重点输出：
1) 最近3个月的重要新闻与公告摘要；
2) 近期重大事件（并购重组、高管/股东变动、监管处罚、重大订单或产能变化等）；
3) 主营业务、主要产品或主要客户的最新变化；
4) 主流券商或研究机构近期的观点与评级（如有）。
要求：用简体中文、分点结构化输出；每条尽量标注信息来源与日期；若某类信息无可靠公开来源，请明确写"暂无可靠公开信息"，不要编造。总长控制在900字以内。`;

// 本地模式 prompt：无联网，基于 factStore 预下载的研报/公告/概况/主营构成做纯推理
const AUGMENT_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析助手，熟悉中国A股、港股与美股市场。你没有联网能力，也不需要联网。下方「本地公开资料」由系统预先从东方财富 F10 / 巨潮资讯网免费下载，是本轮分析唯一允许引用的事实来源，包含四类：
1) 公司概况（名称、行业、省份、企业性质、控股股东、员工人数、主营业务范围、主要产品）；
2) 主营构成（按产品/地区/行业维度的营收占比与毛利率，最新年报期）；
3) 近一年券商研报列表（机构、评级、目标价、预测EPS/PE、发布日期）；
4) 近一年重要公告列表（增持/减持/回购/高管变动/监管处罚/诉讼等自动分类与关键数字）。

请基于以上本地资料补全该公司公开资料，重点输出：
1) 主营业务、主要产品与主要客户概览（取自主营构成与公司概况，附营收占比/毛利率如有）；
2) 近期重大事件（取自公告列表：增持/减持/回购/高管变动/监管处罚/诉讼等，标注日期）；
3) 主流券商或研究机构近期观点与评级（取自研报列表，标注机构/评级/目标价/日期）；
4) 若某类信息本地资料未覆盖，请明确写"本地资料未提供"，不要编造，也不要使用你训练记忆中的任何内容。
要求：用简体中文、分点结构化输出；每条尽量标注信息来源与日期；总长控制在900字以内。`;

// 由 factStore 四类事实组装「个股资料补全」上下文（供不联网模型推理）
async function buildAugmentContext(symbol, stockName) {
  const [research, announcements, profile, segment] = await Promise.all([
    factStore.getResearchFacts(symbol).catch(() => ({ ok: false })),
    factStore.getAnnouncementFacts(symbol, stockName).catch(() => ({ ok: false })),
    factStore.getProfileFacts(symbol).catch(() => ({ ok: false })),
    factStore.getSegmentFacts(symbol).catch(() => ({ ok: false })),
  ]);
  const parts = [];
  const meta = { maxDate: '', count: 0, isFresh: true, staleServed: false, fetchedAt: '' };
  const touch = (f, extraMax) => {
    if (!f || !f.ok) return;
    if (!f.isFresh) meta.isFresh = false;
    if (f.staleServed) meta.staleServed = true;
    if (f.fetchedAt && f.fetchedAt > meta.fetchedAt) meta.fetchedAt = f.fetchedAt;
    if (extraMax && extraMax > meta.maxDate) meta.maxDate = extraMax;
  };
  if (research.ok) {
    const c = factStore.buildResearchContext(research);
    if (c.ok) { parts.push(c.text); meta.count += c.count; }
    touch(research, c.ok ? c.maxDate : '');
  }
  if (announcements.ok) {
    const c = factStore.buildAnnouncementContext(announcements);
    if (c.ok) { parts.push(c.text); meta.count += c.count; }
    touch(announcements, c.ok ? c.maxDate : '');
  }
  if (profile.ok || segment.ok) {
    const c = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
    if (c.ok) parts.push(c.text);
    touch(profile, '');
    touch(segment, '');
  }
  if (!parts.length) return { ok: false, reason: 'NO_DATA' };
  return { ok: true, text: parts.join('\n\n'), maxDate: meta.maxDate, count: meta.count, isFresh: meta.isFresh, staleServed: meta.staleServed, fetchedAt: meta.fetchedAt };
}

async function augmentStock({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在侧边栏「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}.json`);
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // 本地事实：研报/公告/概况/主营构成免费预下载，无需联网检索（抓取失败则兜底走联网）
  const localCtx = await buildAugmentContext(symbol, name).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 事实锚点保鲜：本地模式下，本地事实最新日期未变 → 直接复用（不受时间 TTL 限制）
      if (cached.mode === 'local' && localCtx.ok && cached.factMaxDate === localCtx.maxDate) {
        return { success: true, ...cached, cached: true };
      }
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  let messages, modelPick, mode, factMaxDate = null, factCount = 0;
  const factsIsFresh = localCtx.ok ? localCtx.isFresh : true;
  const factsStale = localCtx.ok ? !!localCtx.staleServed : false;
  const factsFetchedAt = localCtx.ok ? localCtx.fetchedAt : null;
  if (localCtx.ok) {
    modelPick = pickLocalSummaryModel(cfg);
    mode = 'local';
    factMaxDate = localCtx.maxDate;
    factCount = localCtx.count;
    const ctxLen = AUGMENT_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 200;
    modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI资料补全', symbol);
    messages = [
      { role: 'system', content: AUGMENT_LOCAL_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。\n\n${localCtx.text}\n\n请严格基于以上本地公开资料补全该公司资料（不要联网、不要编造数字）。` },
    ];
  } else {
    modelPick = pickModelFor(cfg, 'web');
    mode = 'web-fallback';
    console.warn(`[AI资料补全] ${symbol} 本地事实不可用，降级为联网模型检索`);
    messages = [
      { role: 'system', content: AUGMENT_WEB_SYSTEM_PROMPT },
      { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网补全上述资料。` },
    ];
  }
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const result = {
      symbol,
      stockName: name || symbol,
      content,
      sources: extractSources(content),
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

const ASPECTS_SYSTEM_PROMPT = `你是一名严谨的专业投资分析师，熟悉中国A股、港股与美股市场。用户会给你一家公司的名称、代码与部分已知公开资料。请你利用联网搜索能力，对该公司做出客观的"投资亮点"与"投资雷点"分析。

要求：
1) 只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"highlights":["亮点1","亮点2","亮点3"],"risks":["雷点1","雷点2","雷点3"]}
2) highlights 列出 3-6 条主要投资亮点（如行业地位、业绩增长、高分红、技术壁垒、政策利好、估值修复等）；
3) risks 列出 3-6 条主要投资风险（如估值偏高、业绩下滑、行业周期下行、政策监管、负债高、治理或商誉风险等）；
4) 每条要具体、可验证，尽量结合最新公开信息（最近一期年报/半年报/季报、最新公告、权威新闻）；不要编造无来源的数字；
5) **时效性约束（20260904a 加强）**：
   a) 涉及财务数据的亮点/雷点，**只能引用最新一期已披露财报**（最新 REPORT_DATE 对应的年报/半年报/一季报/三季报）。旧期财报（哪怕只早一个季度）只能作为**对比基准**出现（如"较上期+5%"、"同比+10%"），不得作为亮点/雷点本身的论据主体。
   b) 每条涉及财务数字的亮点/雷点，**必须同时给出三组数据**：「最新一期实际值 + 较上期环比变化 + 较去年同期同比变化」。缺一不可。
   c) 不涉及财报数据的条目（如行业地位、政策面、技术壁垒、利率敏感、治理等）不受上述强制约束，但同样禁止使用 1 年前的旧数据作为论证依据，尤其禁止出现"从 2023 年/更早的 X 提升到 2024 年/今年的 Y"这类用旧基期做对比的表述。如果某项改善/恶化主要发生在 1 年前，不应列为当前亮点/雷点。
6) 若确实缺乏某类信息，对应数组返回空数组 []。
7) **权威财务数值约束（20260916 强制）**：用户消息中提供的「权威财务快照」是从东方财富 F10 直接计算得到的真实值。涉及资产负债率、毛利率、净利率、营收同比、归母净利润及同比、流动比率等任何财务数字时，你必须直接引用快照中的数值，不得自行估算、推算、四舍五入改写或编造任何一位数字。快照未提供的指标，才可基于联网搜索到的公开数据撰写，但同样必须标注真实来源、不得编造；凡涉及财务变化（如"较上期/同比"）的幅度，也必须与快照或公开权威数据一致。
8) **估值方法约束**：对金融/保险类公司（如中国平安），估值更适合用"内含价值(EV)"或"股息贴现模型(DDM)"来判断；不应将 DCF（现金流折现）得出的"低估/便宜"结论作为个股亮点——DCF 只能作为参考性说明，不得列入 highlights。如确需提及估值，应优先采用适合该行业的估值口径（如保险用 EV/PEV、银行用 PB、高股息用股息率/DDM），避免用 DCF 作为亮点的论证依据。`;

async function analyzeAspects({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_aspects.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  let name = stockName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }

  // 20260904a：注入「最新报告期」上下文给模型 + 后置校验用。
  // 来自本地财务数据库的 hub.reportDate（如 2026-06-30）；拿不到时降级为最近一年。
  const { getFinanceHub } = require('../financeHub');
  const { fetchFinancialData } = require('../deepAnalysis');
  let latestReportLabel = null; // 用于注入 prompt + 后置校验（如「2026年中报」「2026年三季报」）
  try {
    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);
    const finData = await fetchFinancialData(emCode);
    const hub = getFinanceHub(finData);
    if (hub && hub.ok && hub.reportDate) {
      latestReportLabel = hub.reportDateLabel || _reportDateToLabel(hub.reportDate);
    }
  } catch {}

  // 20260916：拉取权威财务快照（与个股「基本面」卡片同源），注入 prompt 并用于后置数字校验
  let finSnap = null;
  try { finSnap = await fetchAuthoritativeFinancials(symbol); } catch {}
  const finSnapText = finSnap && finSnap.ok ? buildFinancialSnapshotText(finSnap) : '';

  const userMsg = `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。`
    + (latestReportLabel ? `\n【最新报告期（必须作为亮点/雷点的财务数据基期）】：${latestReportLabel}（报告日 ${latestReportLabel.slice(0, 4)} 年）` : '')
    + (finSnapText ? `\n${finSnapText}` : '')
    + `\n请联网搜索该公司最新公开信息（年报、公告、权威新闻等）后，输出其投资亮点与投资雷点。`;
  const messages = [
    { role: 'system', content: ASPECTS_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];

  try {
    // 20260904a：妙想东财资讯事实源优先（公告/新闻覆盖度足够），失败自动回退通用搜索
    const aspectsMxQuery = `${name || symbol}（${symbol}）最新财报 公告 业绩 投资亮点 投资风险 新闻`;
    // 亮点/雷点属联网+长输出任务，且 qwen3.5-35b-a3b 推理偏慢（实测单股 90~133s），
    // 放宽至 240s（与最重的 companyDeep 一致）留足余量，避免「个别股卡在 60s 超时」（用户反馈的「长时间无法获取」）。
    // 20260917l：单次 240s 仍不够 —— callLLM 内部最多**串行重试 4 次**（妙想纯推理 → 外部搜索通道纯推理
    //   → 外部失败纯推理 → 内置联网），每次各自 240s，单股最坏 ≈16 分钟无响应（中国平安 601318 实测踩中：
    //   服务端日志 `[search:mcp] 调用失败…大模型请求超时（240000ms 无响应）`，用户侧即「长时间无法获取」）。
    //   现补一个**整链路总预算** 300s：单次仍可跑到 240s，但累计超 300s 立刻快速失败（秒级返回），
    //   不再无限串行等待。仅本调用方传该参数，其他分析器不受影响。
    const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch: true, mxQuery: aspectsMxQuery, timeoutMs: 240000, overallBudgetMs: 300000 });
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.highlights) || !Array.isArray(parsed.risks)) {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析亮点/雷点。', raw: content.slice(0, 500) };
    }
    // 去重：AI 可能返回内容重复的亮点/雷点，按归一化内容去重，避免写入磁盘缓存后出现重复
    const dedupeAspect = (arr) => {
      const seen = new Set();
      const out = [];
      for (const s of (arr || [])) {
        const t = String(s).trim();
        if (!t) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
      return out;
    };
    const result = {
      symbol,
      stockName: name || symbol,
      highlights: dedupeAspect(parsed.highlights).slice(0, 6),
      risks: dedupeAspect(parsed.risks).slice(0, 6),
      date: new Date().toISOString(),
      model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
    };

    // 20260904a 后置校验：亮点/雷点若引用了非最新期财报数据，标记 outdated=true；
    // 备注「实际引用年份 = X，最新报告期 = Y」便于前端/审计追溯。不直接删除（避免 AI 输出偶尔合同时损失信息）。
    if (latestReportLabel) {
      const latestYear = parseInt(String(latestReportLabel).slice(0, 4), 10);
      if (latestYear && isFinite(latestYear)) {
        const stamp = (arr) => arr.map(s => {
          const y = _detectCitedYear(s);
          // y 可能是 null（不涉财报）或 === latestYear（合规）；< latestYear → outdated
          if (y && y < latestYear) {
            return { text: s, outdated: true, citedYear: y, latestYear, latestReportLabel };
          }
          return { text: s };
        });
        result.highlights = stamp(result.highlights);
        result.risks = stamp(result.risks);
        result.latestReportLabel = latestReportLabel;
      }
    }

    // 20260916 后置数字校验：AI 输出的资产负债率绝对数值若与权威快照偏差 > 1 个百分点，
    // 直接修正为权威值（杜绝 48.60% 这类凭空编造），并标记 financeCorrected 供审计追溯。
    if (finSnap && finSnap.ok && finSnap.debtRatio != null) {
      const correctOne = (item) => {
        const text = typeof item === 'string' ? item : (item && item.text);
        if (typeof text !== 'string') return item;
        const fixed = correctDebtRatioInText(text, finSnap.debtRatio);
        if (fixed !== text) {
          result.financeCorrected = true;
          return typeof item === 'string' ? fixed : Object.assign({}, item, { text: fixed, financeCorrected: true });
        }
        return item;
      };
      result.highlights = result.highlights.map(correctOne);
      result.risks = result.risks.map(correctOne);
    }
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
    // 20260917l：超时/失败时，若本地已有上一次成功的结果（即使已过 TTL），直接返回它并标记 stale，
    // 避免用户侧「亮点/雷点长时间无法获取」后只看到空白卡片。
    // 口径说明：只累积口径不变 —— 前端拿到的是旧内容，写入时按「同股同类型内容去重」自然跳过，不会产生重复。
    try {
      if (fs.existsSync(cacheFile)) {
        const prev = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (prev && (Array.isArray(prev.highlights) || Array.isArray(prev.risks))) {
          console.warn(`[aspects] ${symbol} 本次生成失败（${message}），改为返回上一次成功结果（${prev.date}）并标记 stale`);
          return { success: true, ...prev, cached: true, stale: true, staleReason: message };
        }
      }
    } catch {}
    return { success: false, error: 'API_ERROR', status, message };
  }
}

module.exports = { augmentStock, analyzeAspects, buildAugmentContext };
